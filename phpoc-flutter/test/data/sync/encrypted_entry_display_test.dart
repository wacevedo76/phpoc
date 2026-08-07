import 'dart:convert' show json, jsonEncode, utf8;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';

/// Encrypted Entry Display tests — Groups A + B (14 assertions).
///
/// Blueprint: docs/planning/ENCRYPTED_ENTRY_DISPLAY_PHASE1.md
///
/// Covers:
///   A1–A8:  _stagingRowToDto encrypted-field DTO conversion
///   B1–B6:  _seedStagingFromBlocks encrypted-field preservation

// ═══════════════════════════════════════════════════════════════
// Test constants
// ═══════════════════════════════════════════════════════════════

/// 32 bytes = 64 hex chars
const testMkHex =
    'abababababababababababababababababababababababababababababababab';

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/// Create a CryptoService with cached MK.
Future<CryptoService> _makeCrypto({bool cacheMk = true}) async {
  final crypto = CryptoService();
  await crypto.initialize();
  if (cacheMk) {
    crypto.setMasterKey(testMkHex);
  }
  return crypto;
}

/// Create a SyncService with an in-memory StagingStore.
Future<SyncService> _makeSync({
  CryptoService? crypto,
}) async {
  final c = crypto ?? await _makeCrypto();
  final db = AppDatabase.inMemory();
  final store = StagingStore(db);
  return SyncService(storage: null, crypto: c, stagingStore: store);
}

/// Insert a staging row with an activity blob.
Future<void> _putStagingRow(
  StagingStore store, {
  required String activityId,
  required Map<String, dynamic> activityData,
  String activityStatus = 'ended',
}) async {
  await store.putRow({
    'activity_id': activityId,
    'activity_status': activityStatus,
    'activity': json.encode(activityData),
    'updated_at': DateTime.now().millisecondsSinceEpoch,
    'committed': true,
  });
}

/// Build a minimal genesis block JSON map.
Map<String, dynamic> _genesisBlockJson({
  String identitySeal = 'genesis-seal',
  String prevHash =
      '0000000000000000000000000000000000000000000000000000000000000000',
  String blockHash = 'genesis-block-hash',
  String date = '2026-06-01',
  List<Map<String, dynamic>>? entries,
}) =>
    {
      'type': 'genesis',
      'day_index': 0,
      'date': date,
      'prev_hash': prevHash,
      'entries': entries ?? [],
      'signature': identitySeal,
      'identity_seal': identitySeal,
      'block_hash': blockHash,
    };

/// Build a minimal day block JSON map.
Map<String, dynamic> _dayBlockJson({
  required int dayIndex,
  String prevHash = 'aaaa',
  String identitySeal = 'day-seal',
  String blockHash = 'day-block-hash',
  String date = '2026-06-02',
  List<Map<String, dynamic>>? entries,
}) =>
    {
      'type': 'day',
      'day_index': dayIndex,
      'date': date,
      'prev_hash': prevHash,
      'entries': entries ?? [],
      'signature': identitySeal,
      'identity_seal': identitySeal,
      'block_hash': blockHash,
    };

// ═══════════════════════════════════════════════════════════════
// Fake Transport for Group B tests
// ═══════════════════════════════════════════════════════════════

/// In-memory transport that serves obfuscated blocks.
class _FakeBlockTransport extends HttpTransport {
  final Map<String, Uint8List> _store = {};

  _FakeBlockTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  void addBlock(int index, Uint8List obfuscated) {
    _store['ledger/blocks/${index.toString().padLeft(6, '0')}.json'] =
        obfuscated;
  }

  @override
  Future<Uint8List?> pull(String path) async {
    if (path == 'ledger/hash_index.json') {
      final hashes = <String>[];
      final indices = _store.keys
          .where((k) => k.startsWith('ledger/blocks/'))
          .map((k) {
        final match = RegExp(r'(\d+)\.json$').firstMatch(k);
        return match != null ? int.parse(match.group(1)!) : -1;
      }).where((i) => i >= 0).toList()
        ..sort();
      for (final i in indices) {
        hashes.add('hash-$i');
      }
      return Uint8List.fromList(utf8.encode(jsonEncode(hashes)));
    }
    return _store[path];
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
    final files = <String>[];
    for (final k in _store.keys) {
      if (k.startsWith(prefix)) {
        files.add(k.substring(prefix.length));
      }
    }
    return files;
  }

  @override
  Future<void> push(String path, Uint8List data) async {}

  @override
  Future<void> delete(String path) async {}
}

// ═══════════════════════════════════════════════════════════════
// Group A + B tests
// ═══════════════════════════════════════════════════════════════

void main() {
  // ═══════════════════════════════════════════════════════════
  // Group A: DTO Conversion (_stagingRowToDto) — 8 tests
  // ═══════════════════════════════════════════════════════════

  group('A: _stagingRowToDto encrypted-field DTO conversion', () {
    // ── A1 ───────────────────────────────────────────────────
    test('A1: sets is_sensitive_encrypted=true when activity has title_enc',
        () async {
      final svc = await _makeSync();

      await _putStagingRow(
        svc.stagingStore!,
        activityId: 'abc1234567',
        activityData: {
          'title_enc': 'deadbeef000102030405060708090a0b0c0d0e0f',
          'title': '',
          'start_epoch': 1000,
          'committed': true,
        },
      );

      final entries = await svc.readEntries();
      expect(entries, isNotEmpty);
      expect(entries.first['is_sensitive_encrypted'], isTrue,
          reason: 'title_enc in activity blob should trigger encrypted flag');
    });

    // ── A2 ───────────────────────────────────────────────────
    test('A2: sets is_sensitive_encrypted=true when activity has tags_enc',
        () async {
      final svc = await _makeSync();

      await _putStagingRow(
        svc.stagingStore!,
        activityId: 'abc1234568',
        activityData: {
          'tags_enc': 'cafebabe101112131415161718191a1b1c1d1e1f',
          'title': 'Has encrypted tags',
          'start_epoch': 1000,
          'committed': true,
        },
      );

      final entries = await svc.readEntries();
      expect(entries, isNotEmpty);
      expect(entries.first['is_sensitive_encrypted'], isTrue,
          reason: 'tags_enc alone should trigger encrypted flag');
    });

    // ── A3 ───────────────────────────────────────────────────
    test('A3: sets is_sensitive_encrypted=true when activity has comment_enc',
        () async {
      final svc = await _makeSync();

      await _putStagingRow(
        svc.stagingStore!,
        activityId: 'abc1234569',
        activityData: {
          'comment_enc': 'baadf00d202122232425262728292a2b2c2d2e2f',
          'title': 'Has encrypted comment',
          'start_epoch': 1000,
          'committed': true,
        },
      );

      final entries = await svc.readEntries();
      expect(entries, isNotEmpty);
      expect(entries.first['is_sensitive_encrypted'], isTrue,
          reason: 'comment_enc alone should trigger encrypted flag');
    });

    // ── A4 ───────────────────────────────────────────────────
    test('A4: sets is_sensitive_encrypted=false when all fields are plaintext',
        () async {
      final svc = await _makeSync();

      await _putStagingRow(
        svc.stagingStore!,
        activityId: 'abc1234570',
        activityData: {
          'title': 'Plaintext task',
          'tags': ['work'],
          'comment': 'A plain comment',
          'start_epoch': 1000,
          'committed': true,
        },
      );

      final entries = await svc.readEntries();
      expect(entries, isNotEmpty);
      expect(entries.first['is_sensitive_encrypted'], isFalse,
          reason: 'No encrypted fields should not trigger flag');
    });

    // ── A5 ───────────────────────────────────────────────────
    test('A5: preserves title_enc hex value in DTO when present', () async {
      final svc = await _makeSync();
      const encTitle = 'deadbeef000102030405060708090a0b0c0d0e0f';

      await _putStagingRow(
        svc.stagingStore!,
        activityId: 'abc1234571',
        activityData: {
          'title_enc': encTitle,
          'start_epoch': 1000,
          'committed': true,
        },
      );

      final entries = await svc.readEntries();
      expect(entries, isNotEmpty);
      expect(entries.first['title_enc'], equals(encTitle),
          reason: 'DTO must preserve encrypted title hex for on-demand decrypt');
    });

    // ── A6 ───────────────────────────────────────────────────
    test('A6: preserves tags_enc hex value in DTO when present', () async {
      final svc = await _makeSync();
      const encTags = 'cafebabe101112131415161718191a1b1c1d1e1f';

      await _putStagingRow(
        svc.stagingStore!,
        activityId: 'abc1234572',
        activityData: {
          'tags_enc': encTags,
          'title': 'Encrypted tags',
          'start_epoch': 1000,
          'committed': true,
        },
      );

      final entries = await svc.readEntries();
      expect(entries, isNotEmpty);
      expect(entries.first['tags_enc'], equals(encTags),
          reason: 'DTO must preserve encrypted tags hex for on-demand decrypt');
    });

    // ── A7 ───────────────────────────────────────────────────
    test('A7: preserves comment_enc hex value in DTO when present', () async {
      final svc = await _makeSync();
      const encComment = 'baadf00d202122232425262728292a2b2c2d2e2f';

      await _putStagingRow(
        svc.stagingStore!,
        activityId: 'abc1234573',
        activityData: {
          'comment_enc': encComment,
          'title': 'Encrypted comment',
          'start_epoch': 1000,
          'committed': true,
        },
      );

      final entries = await svc.readEntries();
      expect(entries, isNotEmpty);
      expect(entries.first['comment_enc'], equals(encComment),
          reason: 'DTO must preserve encrypted comment hex for on-demand decrypt');
    });

    // ── A8 ───────────────────────────────────────────────────
    test('A8: sets title to [Encrypted] when is_sensitive_encrypted=true and '
        'no plaintext title', () async {
      final svc = await _makeSync();

      await _putStagingRow(
        svc.stagingStore!,
        activityId: 'abc1234574',
        activityData: {
          'title_enc': 'deadbeef000102030405060708090a0b0c0d0e0f',
          'start_epoch': 1000,
          'committed': true,
        },
      );

      final entries = await svc.readEntries();
      expect(entries, isNotEmpty);
      expect(entries.first['title'], equals('[Encrypted]'),
          reason: 'Encrypted entries without plaintext title must show [Encrypted]');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group B: Staging Seed (_seedStagingFromBlocks) — 6 tests
  // ═══════════════════════════════════════════════════════════

  group('B: _seedStagingFromBlocks encrypted-field preservation', () {
    late CryptoService crypto;
    late AppDatabase db;

    setUp(() async {
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      db = AppDatabase.inMemory();
    });

    tearDown(() async {
      await db.close();
    });

    /// Create a LedgerPullService wired with _FakeBlockTransport.
    Future<LedgerPullService> _makeService(
      _FakeBlockTransport transport,
    ) async {
      return LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: LedgerBackupService(db: db),
        stagingStorage: StagingStorage(db),
        stagingStore: StagingStore(db),
      );
    }

    /// Store an obfuscated block in the fake transport.
    void _storeBlock(
      _FakeBlockTransport transport,
      int index,
      Map<String, dynamic> blockJson,
    ) {
      final jsonStr = jsonEncode(blockJson);
      final obfuscated = crypto.obfuscateBlob(jsonStr, testMkHex);
      transport.addBlock(index, obfuscated);
    }

    /// Make an entry map with encrypted fields for use in a block.
    /// titleEnc, tagsEnc, commentEnc are hex ciphertexts.
    Map<String, dynamic> _entryWithEncrypted({
      String? entryId,
      String? titleEnc,
      String? tagsEnc,
      String? commentEnc,
      String startTimeEnc =
          'deadbeef11111111111111111111111111111111111111111111111111111111',
      String endTimeEnc =
          'deadbeef22222222222222222222222222222222222222222222222222222222',
    }) {
      final data = <String, dynamic>{
        'entry_id': entryId ?? 'xyz9876543',
        'startTime_enc': startTimeEnc,
        'endTime_enc': endTimeEnc,
        'is_active': false,
      };
      if (titleEnc != null) data['title_enc'] = titleEnc;
      if (tagsEnc != null) data['tags_enc'] = tagsEnc;
      if (commentEnc != null) data['comment_enc'] = commentEnc;
      return {'hash': 'entry-hash-${entryId ?? 'x'}', 'data': data};
    }

    // ── B1 ───────────────────────────────────────────────────
    test('B1: stores title_enc in activity blob when block entry has title_enc',
        () async {
      final transport = _FakeBlockTransport();
      final svc = await _makeService(transport);

      // Encrypt a known plaintext with MK to get a real ciphertext
      // that the current code can (and will) decrypt — the test
      // expects the ciphertext to be PRESERVED (Phase 3 behavior)
      final encTitle = crypto.encrypt('My Secret Title', testMkHex);

      _storeBlock(
        transport,
        0,
        _genesisBlockJson(
          blockHash: 'gen-hash',
          identitySeal: 'gen-seal',
          entries: [
            _entryWithEncrypted(
              entryId: 'enc0012345',
              titleEnc: encTitle,
            ),
          ],
        ),
      );

      await svc.pullAll();

      // After pullAll, the staging store should have the entry
      final stagingStore = svc.stagingStore;
      final allRows = await stagingStore.getAllRows();
      expect(allRows, isNotEmpty,
          reason: 'Staging must have entries after pull');

      // Find the row matching our entry_id
      final row = allRows.cast<Map<String, dynamic>>().firstWhere(
        (r) {
          final act = json.decode(r['activity'] as String? ?? '{}')
              as Map<String, dynamic>;
          return act['entry_id'] == 'enc0012345';
        },
        orElse: () => <String, dynamic>{},
      );

      expect(row, isNotEmpty,
          reason: 'Staging must contain the pulled entry');
      final activityData =
          json.decode(row['activity'] as String? ?? '{}') as Map<String, dynamic>;
      expect(activityData['title_enc'], equals(encTitle),
          reason: 'Staging activity blob must preserve title_enc ciphertext');
    });

    // ── B2 ───────────────────────────────────────────────────
    test('B2: stores tags_enc in activity blob when block entry has tags_enc',
        () async {
      final transport = _FakeBlockTransport();
      final svc = await _makeService(transport);

      final encTags = crypto.encrypt('["work","personal"]', testMkHex);

      _storeBlock(
        transport,
        0,
        _genesisBlockJson(
          blockHash: 'gen-hash2',
          identitySeal: 'gen-seal2',
          entries: [
            _entryWithEncrypted(
              entryId: 'enc0023456',
              tagsEnc: encTags,
            ),
          ],
        ),
      );

      await svc.pullAll();

      final allRows = await svc.stagingStore.getAllRows();
      final row = allRows.cast<Map<String, dynamic>>().firstWhere(
        (r) {
          final act = json.decode(r['activity'] as String? ?? '{}')
              as Map<String, dynamic>;
          return act['entry_id'] == 'enc0023456';
        },
        orElse: () => <String, dynamic>{},
      );

      expect(row, isNotEmpty);
      final activityData =
          json.decode(row['activity'] as String? ?? '{}') as Map<String, dynamic>;
      expect(activityData['tags_enc'], equals(encTags),
          reason: 'Staging activity blob must preserve tags_enc ciphertext');
    });

    // ── B3 ───────────────────────────────────────────────────
    test('B3: stores comment_enc in activity blob when block entry has '
        'comment_enc', () async {
      final transport = _FakeBlockTransport();
      final svc = await _makeService(transport);

      final encComment =
          crypto.encrypt('My secret comment notes', testMkHex);

      _storeBlock(
        transport,
        0,
        _genesisBlockJson(
          blockHash: 'gen-hash3',
          identitySeal: 'gen-seal3',
          entries: [
            _entryWithEncrypted(
              entryId: 'enc0034567',
              commentEnc: encComment,
            ),
          ],
        ),
      );

      await svc.pullAll();

      final allRows = await svc.stagingStore.getAllRows();
      final row = allRows.cast<Map<String, dynamic>>().firstWhere(
        (r) {
          final act = json.decode(r['activity'] as String? ?? '{}')
              as Map<String, dynamic>;
          return act['entry_id'] == 'enc0034567';
        },
        orElse: () => <String, dynamic>{},
      );

      expect(row, isNotEmpty);
      final activityData =
          json.decode(row['activity'] as String? ?? '{}') as Map<String, dynamic>;
      expect(activityData['comment_enc'], equals(encComment),
          reason: 'Staging activity blob must preserve comment_enc ciphertext');
    });

    // ── B4 ───────────────────────────────────────────────────
    test('B4: still decrypts startTime_enc and endTime_enc for staging',
        () async {
      final transport = _FakeBlockTransport();
      final svc = await _makeService(transport);

      // Create real encrypted epochs
      final encStart = crypto.encrypt('1717200000', testMkHex); // epoch as string
      final encEnd = crypto.encrypt('1717203600', testMkHex);

      _storeBlock(
        transport,
        0,
        _genesisBlockJson(
          blockHash: 'gen-hash4',
          identitySeal: 'gen-seal4',
          entries: [
            _entryWithEncrypted(
              entryId: 'enc0045678',
              startTimeEnc: encStart,
              endTimeEnc: encEnd,
            ),
          ],
        ),
      );

      await svc.pullAll();

      final allRows = await svc.stagingStore.getAllRows();
      final row = allRows.cast<Map<String, dynamic>>().firstWhere(
        (r) {
          final act = json.decode(r['activity'] as String? ?? '{}')
              as Map<String, dynamic>;
          return act['entry_id'] == 'enc0045678';
        },
        orElse: () => <String, dynamic>{},
      );

      expect(row, isNotEmpty);
      final activityData =
          json.decode(row['activity'] as String? ?? '{}') as Map<String, dynamic>;
      // Times should be plaintext epochs (decrypted), not hex ciphertext
      expect(activityData['start_epoch'], isNotNull,
          reason: 'start_epoch must be present (decrypted from startTime_enc)');
      expect(activityData['end_epoch'], isNotNull,
          reason: 'end_epoch must be present (decrypted from endTime_enc)');
      // No raw _enc fields for times in activity blob
      expect(activityData.containsKey('startTime_enc'), isFalse,
          reason: 'startTime_enc should NOT be stored raw in activity blob');
      expect(activityData.containsKey('endTime_enc'), isFalse,
          reason: 'endTime_enc should NOT be stored raw in activity blob');
    });

    // ── B5 ───────────────────────────────────────────────────
    test('B5: stores decrypted start_epoch/end_epoch as int in activity blob',
        () async {
      final transport = _FakeBlockTransport();
      final svc = await _makeService(transport);

      // Use epoch-as-string encrypted values that decrypt to integers
      final encStart = crypto.encrypt('1717200000', testMkHex);
      final encEnd = crypto.encrypt('1717203600', testMkHex);

      _storeBlock(
        transport,
        0,
        _genesisBlockJson(
          blockHash: 'gen-hash5',
          identitySeal: 'gen-seal5',
          entries: [
            _entryWithEncrypted(
              entryId: 'enc0056789',
              startTimeEnc: encStart,
              endTimeEnc: encEnd,
            ),
          ],
        ),
      );

      await svc.pullAll();

      final allRows = await svc.stagingStore.getAllRows();
      final row = allRows.cast<Map<String, dynamic>>().firstWhere(
        (r) {
          final act = json.decode(r['activity'] as String? ?? '{}')
              as Map<String, dynamic>;
          return act['entry_id'] == 'enc0056789';
        },
        orElse: () => <String, dynamic>{},
      );

      expect(row, isNotEmpty);
      final activityData =
          json.decode(row['activity'] as String? ?? '{}') as Map<String, dynamic>;
      expect(activityData['start_epoch'], isA<int>(),
          reason: 'start_epoch must be a plaintext int epoch');
      expect(activityData['end_epoch'], isA<int>(),
          reason: 'end_epoch must be a plaintext int epoch');
    });

    // ── B6 ───────────────────────────────────────────────────
    test('B6: sets committed=true in staging row', () async {
      final transport = _FakeBlockTransport();
      final svc = await _makeService(transport);

      _storeBlock(
        transport,
        0,
        _genesisBlockJson(
          blockHash: 'gen-hash6',
          identitySeal: 'gen-seal6',
          entries: [
            _entryWithEncrypted(entryId: 'enc0067890'),
          ],
        ),
      );

      await svc.pullAll();

      final allRows = await svc.stagingStore.getAllRows();
      final row = allRows.cast<Map<String, dynamic>>().firstWhere(
        (r) {
          final act = json.decode(r['activity'] as String? ?? '{}')
              as Map<String, dynamic>;
          return act['entry_id'] == 'enc0067890';
        },
        orElse: () => <String, dynamic>{},
      );

      expect(row, isNotEmpty);
      expect(row['committed'], isTrue,
          reason: 'Staging rows from blocks must be marked committed=true');
    });
  });
}
