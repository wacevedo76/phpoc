import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/engine.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart';
import 'package:phpoc_flutter/data/ledger/index_manager.dart';

/// LedgerEngine — Phase 2 (RED) test suite.
///
/// All 44 assertions from docs/planning/flutter/LEDGER_PHASE1.md Groups F–I:
///   Group F: Commit (18)
///   Group G: Per-field Encryptable (6)
///   Group H: Verify & Revert (12)
///   Group I: Query & Index (8)
///
/// Expected: all tests FAIL (RED) because engine.dart does not exist yet.

// ── In-memory store fakes ───────────────────────────────────────

class _FakeLedgerStore {
  final List<Map<String, dynamic>> _blocks = [];

  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    return _blocks.sublist(start, e);
  }

  void appendBlocks(List<Map<String, dynamic>> blocks) {
    _blocks.addAll(blocks);
  }

  List<Map<String, dynamic>> truncate(int keepCount) {
    if (keepCount >= _blocks.length) return [];
    final removed = _blocks.sublist(keepCount);
    _blocks.removeRange(keepCount, _blocks.length);
    return removed;
  }

  int getBlockCount() => _blocks.length;

  Map<String, dynamic>? getLastBlock() =>
      _blocks.isEmpty ? null : _blocks.last;
}

class _FakeIndexStore {
  Map<String, dynamic>? _data;

  Map<String, dynamic>? readIndex() => _data;
  void writeIndex(Map<String, dynamic>? data) => _data = data;
}

class _FakeStagingStore {
  final List<Map<String, dynamic>> _entries = [];

  List<Map<String, dynamic>> readEntries() => List.from(_entries);
  void writeEntries(List<Map<String, dynamic>> entries) {
    _entries.clear();
    _entries.addAll(entries);
  }
}

// ── Test constants ──────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identitySecret = 'identity-secret-32-bytes-xxxxxx';

/// Helper to create a fresh LedgerEngine with in-memory stores.
LedgerEngine _makeEngine({String? identitySecretHex, String? formatVersion}) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);

  final store = _FakeLedgerStore();
  final indexStore = _FakeIndexStore();
  final stagingStore = _FakeStagingStore();

  return LedgerEngine(
    crypto: crypto,
    store: store,
    indexStore: indexStore,
    stagingStore: stagingStore,
    identitySecret: identitySecretHex,
    formatVersion: formatVersion,
  );
}

/// Helper to initialize the engine with a genesis block + identity.
void _initEngine(LedgerEngine engine) {
  engine.chain.buildGenesisBlock(
    username: 'testuser',
    email: 'test@test.com',
    recoverySeedEnc: 'seed-enc',
    identityPubKey: 'pub-key',
    identitySecretEncFallback: 'fallback',
  );
}

/// Create a test entry map for commit.
Map<String, dynamic> _makeEntry({
  required String title,
  int startEpoch = 1700000000000,
  int duration = 3600000,
  int? endEpoch,
  bool hasEncryptedFields = false,
  String? comment,
  List<String>? tags,
}) {
  return {
    'title': title,
    'start_epoch': startEpoch,
    'duration': duration,
    'end_epoch': endEpoch,
    'has_encrypted_fields': hasEncryptedFields,
    'comment': comment ?? '',
    'tags': tags ?? <String>[],
    'metadata': <String, dynamic>{},
    'pauses': <Map<String, dynamic>>[],
  };
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group F: Engine — Commit (18 tests)
  // ═══════════════════════════════════════════════════════════════

  group('F: LedgerEngine — Commit', () {
    // F1 — commit([]) returns null (no entries)
    test('F1: commit([]) returns null (no entries)', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      final result = engine.commit([]);
      expect(result, isNull);
    });

    // F2 — commit rejects entry with non-string title
    test('F2: commit rejects entry with non-string title', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      expect(
        () => engine.commit([
          {'title': 123, 'start_epoch': 1700000000000, 'duration': 1000}
        ]),
        throwsA(isA<Exception>()),
      );
    });

    // F3 — commit rejects entry with non-positive start_epoch
    test('F3: commit rejects entry with non-positive start_epoch', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      expect(
        () => engine.commit([
          {'title': 'Bad', 'start_epoch': 0, 'duration': 1000}
        ]),
        throwsA(isA<Exception>()),
      );
    });

    // F4 — commit groups entries by date (UTC)
    test('F4: commit groups entries by date (UTC)', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      // Two entries on different dates (epoch ms → different UTC days)
      // 2025-01-01 = 1735689600000 ms
      // 2025-01-02 = 1735776000000 ms
      final result = engine.commit([
        _makeEntry(
            title: 'Day1 Task', startEpoch: 1735689600000, duration: 1000),
        _makeEntry(
            title: 'Day2 Task', startEpoch: 1735776000000, duration: 2000),
      ]);
      expect(result, isNotNull);
      // Should produce 2 day blocks
      expect(engine.getDayBlocks().length, 2);
    });

    // F5 — commit encrypts startTime_enc, endTime_enc, metadata_enc, pauses_enc
    test(
        'F5: commit encrypts startTime_enc, endTime_enc, metadata_enc, pauses_enc',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Encrypted', duration: 5000),
      ]);

      final blocks = engine.chain.readAll();
      final dayBlock = blocks.last;
      final entryData = dayBlock['entries'][0]['data'];

      expect(entryData.containsKey('startTime_enc'), isTrue);
      expect(entryData.containsKey('endTime_enc'), isTrue);
      expect(entryData.containsKey('metadata_enc'), isTrue);
      expect(entryData.containsKey('pauses_enc'), isTrue);
    });

    // F6 — commit computes content_hash for each entry
    test('F6: commit computes content_hash for each entry', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Hashed', duration: 1000),
      ]);

      final blocks = engine.chain.readAll();
      final dayBlock = blocks.last;
      final entryData = dayBlock['entries'][0]['data'];
      expect(entryData.containsKey('content_hash'), isTrue);
      expect(entryData['content_hash'], isNotEmpty);
    });

    // F7 — commit computes entry hash (sha256 of sort+indent2 JSON)
    test(
        'F7: commit computes entry hash (sha256 of sort+indent2 JSON)', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Entry Hash Test', duration: 2000),
      ]);

      final blocks = engine.chain.readAll();
      final dayBlock = blocks.last;
      final entryWrapper = dayBlock['entries'][0];
      expect(entryWrapper.containsKey('hash'), isTrue);
      expect(entryWrapper['hash'].length, 64);
    });

    // F8 — commit strips staging-only fields (is_active, entry_id, device_uuid, hash)
    test(
        'F8: commit strips staging-only fields (is_active, entry_id, device_uuid, hash)',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        {
          'title': 'Clean',
          'start_epoch': 1700000000000,
          'duration': 1000,
          'is_active': true,
          'entry_id': 'some-uuid',
          'device_uuid': 'device-xyz',
          'hash': 'old-hash',
          'metadata': <String, dynamic>{},
          'pauses': <Map<String, dynamic>>[],
        },
      ]);

      final blocks = engine.chain.readAll();
      final dayBlock = blocks.last;
      final entryData = dayBlock['entries'][0]['data'];
      expect(entryData.containsKey('is_active'), isFalse);
      expect(entryData.containsKey('entry_id'), isFalse);
      expect(entryData.containsKey('device_uuid'), isFalse);
    });

    // F9 — commit appends day block to chain
    test('F9: commit appends day block to chain', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      final countBefore = engine.getBlockCount();
      engine.commit([
        _makeEntry(title: 'New Block', duration: 1000),
      ]);
      expect(engine.getBlockCount(), greaterThan(countBefore));
    });

    // F10 — commit updates blind index with title→duration
    test('F10: commit updates blind index with title→duration', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Indexed Task', duration: 5000),
      ]);

      // Query the index for the right date
      final results = engine.queryIndex('2023-11-14', '2023-11-14');
      expect(results.containsKey('Indexed Task'), isTrue);
    });

    // F11 — commit returns hashPrefix (first 10 chars of last block hash)
    test(
        'F11: commit returns hashPrefix (first 10 chars of last block hash)',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      final prefix = engine.commit([
        _makeEntry(title: 'Prefix Test', duration: 1000),
      ]);
      expect(prefix, isNotNull);
      expect(prefix!.length, 10);
    });

    // F12 — commit handles entries spanning multiple dates
    test('F12: commit handles entries spanning multiple dates', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Jan 1', startEpoch: 1735689600000, duration: 1000),
        _makeEntry(
            title: 'Jan 2', startEpoch: 1735776000000, duration: 2000),
        _makeEntry(
            title: 'Jan 3', startEpoch: 1735862400000, duration: 3000),
      ]);
      expect(engine.getDayBlocks().length, 3);
    });

    // F13 — commit encrypts per-field fields when has_encrypted_fields=true
    test(
        'F13: commit per-field encryptable fields when has_encrypted_fields=true',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Secret Task',
            duration: 1000,
            hasEncryptedFields: true,
            comment: 'secret comment',
            tags: ['work', 'urgent']),
      ]);

      final blocks = engine.chain.readAll();
      final entryData = blocks.last['entries'][0]['data'];
      expect(entryData.containsKey('title_enc'), isTrue);
      expect(entryData.containsKey('tags_enc'), isTrue);
      expect(entryData.containsKey('comment_enc'), isTrue);
    });

    // F14 — commit removes plaintext per-field values when encrypted
    test(
        'F14: commit removes plaintext per-field values when encrypted variants exist',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Secret', duration: 1000, hasEncryptedFields: true),
      ]);

      final blocks = engine.chain.readAll();
      final entryData = blocks.last['entries'][0]['data'];
      // Plaintext title should be removed
      expect(entryData.containsKey('title'), isFalse);
      expect(entryData.containsKey('title_enc'), isTrue);
    });

    // F15 — commit encrypts empty title/tags when has_encrypted_fields=true
    test(
        'F15: commit encrypts empty title/tags when has_encrypted_fields=true',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        {
          'title': '',
          'start_epoch': 1700000000000,
          'duration': 1000,
          'has_encrypted_fields': true,
          'tags': <String>[],
          'comment': '',
          'metadata': <String, dynamic>{},
          'pauses': <Map<String, dynamic>>[],
        },
      ]);

      final blocks = engine.chain.readAll();
      final entryData = blocks.last['entries'][0]['data'];
      // Even empty title should be encrypted
      expect(entryData.containsKey('title_enc'), isTrue);
      expect(entryData.containsKey('tags_enc'), isTrue);
    });

    // F16 — commit only encrypts comment/duration when non-empty/non-zero
    test(
        'F16: commit only encrypts comment/duration when non-empty/non-zero',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Sparse', duration: 0, hasEncryptedFields: true),
      ]);

      final blocks = engine.chain.readAll();
      final entryData = blocks.last['entries'][0]['data'];
      // No comment → should NOT have comment_enc
      expect(entryData.containsKey('comment_enc'), isFalse);
      // Zero duration → should NOT have duration_enc
      expect(entryData.containsKey('duration_enc'), isFalse);
    });

    // F17 — commit handles entries without end_epoch
    test(
        'F17: commit handles entries without end_epoch (estimates from start+duration)',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      // Entry without explicit end_epoch
      engine.commit([
        {
          'title': 'No End',
          'start_epoch': 1700000000000,
          'duration': 3600000,
          'metadata': <String, dynamic>{},
          'pauses': <Map<String, dynamic>>[],
        },
      ]);

      final blocks = engine.chain.readAll();
      final entryData = blocks.last['entries'][0]['data'];
      // Should still have endTime_enc (estimated)
      expect(entryData.containsKey('endTime_enc'), isTrue);
    });

    // F18 — first-ever day block uses 64-zero prev_hash when no genesis
    test(
        'F18: first-ever day block uses 64-zero prev_hash when no genesis exists',
        () {
      final engine =
          _makeEngine(identitySecretHex: identitySecret);
      // No genesis — commit should still work
      engine.commit([
        _makeEntry(title: 'First Ever', duration: 1000),
      ]);

      final blocks = engine.chain.readAll();
      expect(blocks.first['prev_hash'], '0' * 64);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group G: Per-field Encryptable Fields (6 tests)
  // ═══════════════════════════════════════════════════════════════

  group('G: LedgerEngine — Per-field Encryptable', () {
    // G1 — _prepareEntries encrypts title→title_enc
    test(
        'G1: _prepareEntries encrypts title→title_enc when has_encrypted_fields=true',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Encrypt Me', duration: 1000, hasEncryptedFields: true),
      ]);

      final blocks = engine.chain.readAll();
      final data = blocks.last['entries'][0]['data'];
      expect(data['title_enc'], isNotNull);
      // Original plaintext title should be gone
      expect(data.containsKey('title'), isFalse);
    });

    // G2 — _prepareEntries encrypts tags→tags_enc as sorted JSON array
    test(
        'G2: _prepareEntries encrypts tags→tags_enc as sorted JSON array',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Tagged',
            duration: 1000,
            hasEncryptedFields: true,
            tags: ['work', 'urgent']),
      ]);

      final blocks = engine.chain.readAll();
      final data = blocks.last['entries'][0]['data'];
      expect(data['tags_enc'], isNotNull);
      expect(data.containsKey('tags'), isFalse);
    });

    // G3 — _prepareEntries encrypts comment→comment_enc only when non-empty
    test(
        'G3: _prepareEntries encrypts comment→comment_enc only when non-empty',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      // Entry with a comment
      engine.commit([
        _makeEntry(
            title: 'With Comment',
            duration: 1000,
            hasEncryptedFields: true,
            comment: 'A secret note'),
      ]);

      final blocks = engine.chain.readAll();
      final data = blocks.last['entries'][0]['data'];
      expect(data.containsKey('comment_enc'), isTrue);
      expect(data.containsKey('comment'), isFalse);
    });

    // G4 — _prepareEntries encrypts duration→duration_enc only when non-zero
    test(
        'G4: _prepareEntries encrypts duration→duration_enc only when non-zero',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      // Entry with non-zero duration + encrypted fields
      engine.commit([
        _makeEntry(
            title: 'Timed', duration: 5000, hasEncryptedFields: true),
      ]);

      final blocks = engine.chain.readAll();
      final data = blocks.last['entries'][0]['data'];
      expect(data.containsKey('duration_enc'), isTrue);
    });

    // G5 — _prepareEntries removes plaintext title/tags/comment/duration
    test(
        'G5: _prepareEntries removes plaintext title/tags/comment/duration when encrypted',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Removed',
            duration: 1000,
            hasEncryptedFields: true,
            comment: 'gone',
            tags: ['x']),
      ]);

      final blocks = engine.chain.readAll();
      final data = blocks.last['entries'][0]['data'];
      expect(data.containsKey('title'), isFalse);
      expect(data.containsKey('tags'), isFalse);
      expect(data.containsKey('comment'), isFalse);
      expect(data.containsKey('duration'), isFalse);
    });

    // G6 — _indexableTitle returns null for encrypted titles
    test(
        'G6: _indexableTitle returns null for entries with title_enc but no plaintext title',
        () {
      // This is validated via integration: commit with has_encrypted_fields,
      // then check that the index does NOT contain the encrypted title
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Hidden Title',
            duration: 5000,
            hasEncryptedFields: true),
      ]);

      // Query the index — should not find the encrypted title
      final results = engine.queryIndex('2023-11-14', '2023-11-15');
      // The index should be empty or not contain 'Hidden Title' since title_enc is encrypted
      expect(results.containsKey('Hidden Title'), isFalse);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group H: Verify & Revert (12 tests)
  // ═══════════════════════════════════════════════════════════════

  group('H: LedgerEngine — Verify & Revert', () {
    // H1 — verify() delegates to chain.verify()
    test('H1: verify() delegates to chain.verify()', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Valid Task', duration: 1000),
      ]);
      expect(engine.verify(), isTrue);
    });

    // H2 — verify() returns true for valid chain
    test('H2: verify() returns true for valid chain', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'A', duration: 100),
        _makeEntry(title: 'B', duration: 200),
      ]);
      expect(engine.verify(), isTrue);
    });

    // H3 — revert(0) returns 0 entries (no-op)
    test('H3: revert(0) returns 0 entries (no-op)', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Keep', duration: 1000),
      ]);
      final restored = engine.revert(0);
      expect(restored, 0);
      expect(engine.getDayBlocks().length, 1);
    });

    // H4 — revert restores entries to staging in plain: format
    test(
        'H4: revert(count) restores entries to staging in plain: format', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Revert Me', duration: 5000),
      ]);
      final restored = engine.revert(1);
      expect(restored, 1);
    });

    // H5 — revert decrypts startTime_enc, endTime_enc, metadata_enc, pauses_enc
    test(
        'H5: revert decrypts startTime_enc, endTime_enc, metadata_enc, pauses_enc',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Decrypt Test', duration: 3000),
      ]);
      engine.revert(1);

      // Check that staging entries have plain: prefix
      final staging = engine.stagingStore.readEntries();
      expect(staging, isNotEmpty);
      final data = staging.first['data'];
      expect(data['startTime_enc'], startsWith('plain:'));
    });

    // H6 — revert returns correct count of restored entries
    test('H6: revert returns correct count of restored entries', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      // Commit two entries on the same day (one day block with 2 entries)
      engine.commit([
        _makeEntry(title: 'Entry 1', duration: 1000),
        _makeEntry(title: 'Entry 2', duration: 2000),
      ]);
      final restored = engine.revert(1);
      expect(restored, 2); // both entries in the day block restored
    });

    // H7 — revert returns -1 when count exceeds available day blocks
    test(
        'H7: revert returns -1 when count exceeds available day blocks', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Only Block', duration: 1000),
      ]);
      final restored = engine.revert(5); // more than available
      expect(restored, -1);
    });

    // H8 — revert removes reverted blocks from chain
    test('H8: revert removes reverted blocks from chain', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Remove Me', duration: 1000),
      ]);
      expect(engine.getDayBlocks().length, 1);
      engine.revert(1);
      expect(engine.getDayBlocks().length, 0);
    });

    // H9 — revert updates blind index (subtracts reverted durations)
    test(
        'H9: revert updates blind index (subtracts reverted durations)', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Indexed', duration: 5000),
      ]);

      // Index should have the entry
      final beforeQuery = engine.queryIndex('2023-11-14', '2023-11-14');
      expect(beforeQuery['Indexed'], 5000);

      engine.revert(1);

      // After revert, index should have duration subtracted (0 → entry removed)
      final afterQuery = engine.queryIndex('2023-11-14', '2023-11-14');
      expect(afterQuery.containsKey('Indexed'), isFalse);
    });

    // H10 — revert decrypts per-field _enc variants back to plaintext
    test(
        'H10: revert decrypts per-field _enc variants back to plaintext', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Secret Revert',
            duration: 1000,
            hasEncryptedFields: true,
            comment: 'revert me'),
      ]);
      engine.revert(1);

      final staging = engine.stagingStore.readEntries();
      final data = staging.first['data'];
      // Per-field encrypted values should be restored as plaintext
      expect(data.containsKey('title'), isTrue);
      expect(data['title'], 'Secret Revert');
    });

    // H11 — revert handles entries with pauses_enc (defaults to plain:[])
    test(
        'H11: revert handles entries with pauses_enc (defaults to plain:[])',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'No Pauses', duration: 1000),
      ]);
      engine.revert(1);

      final staging = engine.stagingStore.readEntries();
      final data = staging.first['data'];
      // Should have pauses_enc with default value
      expect(data.containsKey('pauses_enc'), isTrue);
    });

    // H12 — revert removes summary blocks between reverted day blocks
    test(
        'H12: revert removes summary blocks between reverted day blocks', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);

      // Commit entries across a month boundary to trigger summary blocks
      // Jan 2025 → Feb 2025
      engine.commit([
        _makeEntry(
            title: 'Jan Task',
            startEpoch: 1735689600000, // 2025-01-01
            duration: 1000),
      ]);
      engine.commit([
        _makeEntry(
            title: 'Feb Task',
            startEpoch: 1738368000000, // 2025-02-01
            duration: 2000),
      ]);

      // Should have at least 2 day blocks + potentially summary blocks
      final blocksBefore = engine.getBlockCount();
      engine.revert(1); // revert the last day block (Feb)
      // Summary blocks should also be removed
      final blocksAfter = engine.getBlockCount();
      expect(blocksAfter, lessThan(blocksBefore));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group I: Query & Index (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('I: LedgerEngine — Query & Index', () {
    // I1 — getBlockCount() returns total blocks in chain
    test('I1: getBlockCount() returns total blocks in chain', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      final before = engine.getBlockCount();
      engine.commit([
        _makeEntry(title: 'Count Test', duration: 1000),
      ]);
      expect(engine.getBlockCount(), greaterThan(before));
    });

    // I2 — getDayBlocks() returns only day-type blocks
    test(
        'I2: getDayBlocks() returns only day-type blocks', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Day Only', duration: 1000),
      ]);
      final dayBlocks = engine.getDayBlocks();
      for (final block in dayBlocks) {
        expect(block['type'], 'day');
      }
    });

    // I3 — getLastBlock() returns most recent block
    test('I3: getLastBlock() returns most recent block', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Last Test', duration: 1000),
      ]);
      final last = engine.getLastBlock();
      expect(last, isNotNull);
      expect(last!['type'], 'day');
    });

    // I4 — queryIndex(fromDate, toDate) aggregates durations by title
    test(
        'I4: queryIndex(fromDate, toDate) aggregates durations by title', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Work', duration: 3600000),
        _makeEntry(title: 'Work', duration: 1800000),
        _makeEntry(title: 'Break', duration: 900000),
      ]);

      final results = engine.queryIndex('2023-11-14', '2023-11-14');
      expect(results['Work'], 5400000); // 3600000 + 1800000
      expect(results['Break'], 900000);
    });

    // I5 — queryIndex returns empty for inverted dates (from > to)
    test(
        'I5: queryIndex returns empty for inverted dates (from > to)', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Task', duration: 1000),
      ]);
      final results = engine.queryIndex('2025-01-01', '2024-01-01');
      expect(results, isEmpty);
    });

    // I6 — rebuildIndex() rebuilds entire index from chain
    test('I6: rebuildIndex() rebuilds entire index from chain', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Rebuild Test', duration: 5000),
      ]);

      // Simulate index corruption
      engine.index.clear();
      expect(engine.queryIndex('2024-11-01', '2024-12-01'), isEmpty);

      engine.rebuildIndex();
      final results = engine.queryIndex('2023-11-14', '2023-11-14');
      expect(results['Rebuild Test'], 5000);
    });

    // I7 — rebuildIndex() clears existing index before rebuild
    test('I7: rebuildIndex() clears existing index before rebuild', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(title: 'Old Data', duration: 1000),
      ]);

      // Add some stale data to the index
      engine.index.update('2020-01-01', 'Ghost', 9999);

      engine.rebuildIndex();

      // Stale data should be gone
      final results = engine.queryIndex('2020-01-01', '2020-01-01');
      expect(results.containsKey('Ghost'), isFalse);
    });

    // I8 — rebuildIndex() skips entries with encrypted titles
    test(
        'I8: rebuildIndex() skips entries with encrypted titles (no plaintext)',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _initEngine(engine);
      engine.commit([
        _makeEntry(
            title: 'Visible', duration: 1000, hasEncryptedFields: false),
        _makeEntry(
            title: 'Hidden',
            duration: 2000,
            hasEncryptedFields: true),
      ]);

      engine.rebuildIndex();
      final results = engine.queryIndex('2023-11-14', '2023-11-14');
      // Visible entry should be indexed
      expect(results['Visible'], 1000);
      // Hidden (encrypted) entry should NOT be indexed
      expect(results.containsKey('Hidden'), isFalse);
    });
  });
}
