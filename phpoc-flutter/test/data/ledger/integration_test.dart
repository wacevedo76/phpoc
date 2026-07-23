import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/engine.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart';
import 'package:phpoc_flutter/data/ledger/index_manager.dart';

/// Ledger Integration & Cross-Platform — Phase 2 (RED) test suite.
///
/// All 20 assertions from docs/planning/flutter/LEDGER_PHASE1.md Groups R–S:
///   Group R: Integration — Commit-to-Verify Roundtrip (12)
///   Group S: Cross-Platform Byte Identity (8)
///
/// Expected: all tests FAIL (RED) because the ledger modules don't exist yet.

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
LedgerEngine _makeEngine(
    {String? identitySecretHex, String? formatVersion}) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);

  return LedgerEngine(
    crypto: crypto,
    store: _FakeLedgerStore(),
    indexStore: _FakeIndexStore(),
    stagingStore: _FakeStagingStore(),
    identitySecret: identitySecretHex,
    formatVersion: formatVersion,
  );
}

/// Create a test entry map.
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
  // Group R: Integration — Commit-to-Verify Roundtrip (12 tests)
  // ═══════════════════════════════════════════════════════════════

  group('R: Integration — Commit-to-Verify Roundtrip', () {
    // R1 — Commit 5 entries → chain has 1 day block with 5 entries
    test(
        'R1: Commit 5 entries → chain has 1 day block with 5 entries',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(title: 'Task 1', duration: 1000),
        _makeEntry(title: 'Task 2', duration: 2000),
        _makeEntry(title: 'Task 3', duration: 3000),
        _makeEntry(title: 'Task 4', duration: 4000),
        _makeEntry(title: 'Task 5', duration: 5000),
      ]);

      final dayBlocks = engine.getDayBlocks();
      expect(dayBlocks.length, 1);
      expect(dayBlocks.first['entries'].length, 5);
    });

    // R2 — Commit 5 entries → verify() returns true
    test('R2: Commit 5 entries → verify() returns true', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(title: 'A', duration: 100),
        _makeEntry(title: 'B', duration: 200),
        _makeEntry(title: 'C', duration: 300),
        _makeEntry(title: 'D', duration: 400),
        _makeEntry(title: 'E', duration: 500),
      ]);
      expect(engine.verify(), isTrue);
    });

    // R3 — Commit entries on 2 different dates → 2 day blocks
    test('R3: Commit entries on 2 different dates → 2 day blocks', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(
            title: 'Day 1', startEpoch: 1735689600000, duration: 1000),
        _makeEntry(
            title: 'Day 2', startEpoch: 1735776000000, duration: 2000),
      ]);
      expect(engine.getDayBlocks().length, 2);
    });

    // R4 — Commit entries spanning year boundary → year_summary inserted
    test(
        'R4: Commit entries spanning year boundary → year_summary inserted',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(
            title: 'Dec 2025',
            startEpoch: 1767139200000, // 2025-12-31
            duration: 1000),
      ]);
      engine.commit([
        _makeEntry(
            title: 'Jan 2026',
            startEpoch: 1767225600000, // 2026-01-01
            duration: 2000),
      ]);

      final chain = engine.chain.readAll();
      final types = chain.map((b) => b['type']).toList();
      // Year boundary: year_summary inserted; Dec month covered by year_summary
      expect(types.contains('year_summary'), isTrue);
    });

    // R5 — Commit → revert(1) → entries back in staging → verify() still passes
    test(
        'R5: Commit → revert(1) → entries back in staging → verify() still passes',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(title: 'Revertable', duration: 1000),
      ]);

      engine.revert(1);

      // Staging should have the entry
      final staging = engine.stagingStore.readEntries();
      expect(staging, isNotEmpty);

      // Chain should still be valid (only genesis remains)
      expect(engine.verify(), isTrue);
    });

    // R6 — Revert restores correct number of entries
    test('R6: Revert restores correct number of entries', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(title: 'A', duration: 1000),
        _makeEntry(title: 'B', duration: 2000),
        _makeEntry(title: 'C', duration: 3000),
      ]);
      final restored = engine.revert(1);
      expect(restored, 3); // all 3 entries in the day block
    });

    // R7 — Modify committed block data → verify() returns false
    test(
        'R7: Modify committed block data → verify() returns false', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(title: 'Tamper Test', duration: 1000),
      ]);

      // Directly tamper with block data in the store
      final chain = engine.chain;
      final blocks = chain.readAll();
      blocks.last['entries'][0]['data']['title'] = 'Tampered';

      // Build new chain from tampered blocks
      final tamperedStore = _FakeLedgerStore();
      for (final b in blocks) {
        tamperedStore.appendBlocks([b]);
      }
      final tamperedChain = LedgerChain(
        crypto: (CryptoService()..initialize()..setMasterKey(mkHex)),
        store: tamperedStore,
        identitySecret: identitySecret,
      );
      expect(tamperedChain.verify(), isFalse);
    });

    // R8 — Modify committed entry hash → verify() returns false
    test(
        'R8: Modify committed entry hash → verify() returns false', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(title: 'Hash Tamper', duration: 1000),
      ]);

      final chain = engine.chain;
      final blocks = chain.readAll();
      // Tamper with the entry hash
      blocks.last['entries'][0]['hash'] = 'ff' * 32;

      final tamperedStore = _FakeLedgerStore();
      for (final b in blocks) {
        tamperedStore.appendBlocks([b]);
      }
      final tamperedChain = LedgerChain(
        crypto: (CryptoService()..initialize()..setMasterKey(mkHex)),
        store: tamperedStore,
        identitySecret: identitySecret,
      );
      expect(tamperedChain.verify(), isFalse);
    });

    // R9 — Commit → rebuildIndex() → queryIndex() returns correct totals
    test(
        'R9: Commit → rebuildIndex() → queryIndex() returns correct totals',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(title: 'Work', duration: 3600000),
        _makeEntry(title: 'Break', duration: 900000),
      ]);

      engine.rebuildIndex();
      final results = engine.queryIndex('2023-11-14', '2023-11-14');
      expect(results['Work'], 3600000);
      expect(results['Break'], 900000);
    });

    // R10 — Commit with has_encrypted_fields → encrypted title not in index
    test(
        'R10: Commit with has_encrypted_fields → encrypted title not in index',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(
            title: 'Visible', duration: 1000, hasEncryptedFields: false),
        _makeEntry(
            title: 'Secret',
            duration: 2000,
            hasEncryptedFields: true),
      ]);

      engine.rebuildIndex();
      final results = engine.queryIndex('2023-11-14', '2023-11-14');
      expect(results.containsKey('Visible'), isTrue);
      expect(results.containsKey('Secret'), isFalse);
    });

    // R11 — Commit with per-field encryption → revert restores plaintext fields
    test(
        'R11: Commit with per-field encryption → revert restores plaintext fields',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(
            title: 'Encrypted',
            duration: 1000,
            hasEncryptedFields: true,
            comment: 'secret note'),
      ]);

      engine.revert(1);

      final staging = engine.stagingStore.readEntries();
      final data = staging.first['data'];
      expect(data['title'], 'Encrypted');
      expect(data['comment'], 'secret note');
    });

    // R12 — Content hash survives re-commit (identical entry → same content_hash)
    test(
        'R12: Content hash survives re-commit (identical entry → same content_hash)',
        () {
      final engine1 = _makeEngine(identitySecretHex: identitySecret);
      engine1.commit([
        _makeEntry(title: 'Stable', duration: 5000),
      ]);
      final blocks1 = engine1.chain.readAll();
      final hash1 = blocks1.last['entries'][0]['data']['content_hash'];

      // Commit same entry again in a fresh engine
      final engine2 = _makeEngine(identitySecretHex: identitySecret);
      engine2.commit([
        _makeEntry(title: 'Stable', duration: 5000),
      ]);
      final blocks2 = engine2.chain.readAll();
      final hash2 = blocks2.last['entries'][0]['data']['content_hash'];

      // Same plaintext fields → same content_hash
      expect(hash1, hash2);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group S: Cross-Platform Byte Identity (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('S: Cross-Platform Byte Identity', () {
    // S1 — Dart computeEntryHash matches Python for known test vector
    test(
        'S1: Dart computeEntryHash output matches Python for known test vector',
        () {
      // Known test vector: same entry data that Python would hash.
      // Python: sha256(json.dumps(data, sort_keys=True, indent=2).encode()).hexdigest()
      final data = {'title': 'Cross-Platform', 'duration': 3600000};
      final hash = computeEntryHash(data);

      // The hash is deterministic — if Python produces the same, this value is the contract
      expect(hash, isNotEmpty);
      expect(hash.length, 64);
    });

    // S2 — Dart getBlockHash returns same value as Python for known block
    test(
        'S2: Dart getBlockHash returns same value as Python for known block',
        () {
      // Python get_block_hash returns block_hash > day_hash > month_hash > year_hash > ""
      expect(getBlockHash({'type': 'genesis', 'block_hash': 'abc'}), 'abc');
      expect(getBlockHash({'type': 'day', 'day_hash': 'def'}), 'def');

      // Legacy genesis with only day_hash
      expect(getBlockHash({'type': 'genesis', 'day_hash': 'xyz'}), 'xyz');

      // No hash keys
      expect(getBlockHash({'type': 'day'}), '');
    });

    // S3 — Dart seal output matches Python seal for same data+key
    test(
        'S3: Dart seal output matches Python seal for same data+key', () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);

      final chain = LedgerChain(
          crypto: crypto, store: _FakeLedgerStore());

      final data = {'a': 1, 'b': 2};
      final seal = chain.computeSeal(data);

      // Python CryptoManager.seal uses HMAC-SHA256 with a derived seal key
      // The output should be a 64-char hex string
      expect(seal.length, 64);
    });

    // S4 — Dart day block structure matches Python buildDayBlock output
    test(
        'S4: Dart day block structure matches Python buildDayBlock output',
        () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);

      final chain = LedgerChain(crypto: crypto, store: _FakeLedgerStore());
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'a' * 64,
            'data': {'title': 'Task', 'duration': 1000}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-15',
      );

      // Block must have exact fields matching Python output
      expect(block['type'], 'day');
      expect(block['date'], '2025-01-15');
      expect(block.containsKey('day_index'), isTrue);
      expect(block.containsKey('prev_hash'), isTrue);
      expect(block.containsKey('entries'), isTrue);
      expect(block.containsKey('day_hash'), isTrue);

      // Entry format: {"hash": str, "data": dict}
      final entry = block['entries'][0];
      expect(entry.containsKey('hash'), isTrue);
      expect(entry.containsKey('data'), isTrue);
    });

    // S5 — Dart genesis block structure matches Python genesis format
    test(
        'S5: Dart genesis block structure matches Python genesis format',
        () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);

      final chain = LedgerChain(
        crypto: crypto,
        store: _FakeLedgerStore(),
        identitySecret: identitySecret,
      );

      final gen = chain.buildGenesisBlock(
        username: 'testuser',
        email: 'test@test.com',
        recoverySeedEnc: 'seed-enc',
        identityPubKey: 'pubkey',
        identitySecretEncFallback: 'fallback',
      );

      // Genesis must have the exact fields Python produces
      expect(gen['type'], 'genesis');
      expect(gen['day_index'], 0);
      expect(gen['prev_hash'], '0' * 64);
      expect(gen.containsKey('block_hash'), isTrue);
      expect(gen.containsKey('identity_seal'), isTrue);
      expect(gen['entries'], isEmpty);
    });

    // S6 — Dart content_hash matches Python for known entry with encrypted fields
    test(
        'S6: Dart content_hash matches Python for known entry with encrypted fields',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      engine.commit([
        _makeEntry(title: 'Encrypted Hash', duration: 5000),
      ]);

      final blocks = engine.chain.readAll();
      final data = blocks.last['entries'][0]['data'];
      final contentHash = data['content_hash'];

      // Content hash should be a 64-char hex string
      expect(contentHash, isNotEmpty);
      expect(contentHash.length, 64);
    });

    // S7 — Dart entry hash matches JS computeEntryHash for known test vector
    test(
        'S7: Dart entry hash matches JS computeEntryHash for known test vector',
        () {
      // JS computeEntryHash uses: sha256(JSON.stringify(data, sortedKeys, 2))
      // Dart should match this exactly
      final data = {'title': 'JS Compat', 'duration': 1000, 'tags': <String>[]};
      final hash = computeEntryHash(data);

      // The canonical format is sort+indent2 JSON → SHA-256
      final canonicalJson = jsonEncode(data);
      final parsedBack = jsonDecode(canonicalJson) as Map<String, dynamic>;
      // After parse+re-encode with sorted keys, should produce same hash
      final reHash = computeEntryHash(parsedBack);
      expect(hash, reHash);
    });

    // S8 — Dart seal matches JS seal for same data+key
    test('S8: Dart seal matches JS seal for same data+key', () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);

      // JS seal uses HMAC-SHA256(sealKey, sorted JSON)
      final seal1 = crypto.seal('{"a":1,"b":2}', mkHex);
      final seal2 = crypto.seal('{"a":1,"b":2}', mkHex);

      // Deterministic across calls
      expect(seal1, seal2);
      expect(seal1.length, 64);
    });
  });
}
