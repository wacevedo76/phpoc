import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/index_manager.dart';

/// IndexManager — Phase 2 (RED) test suite.
///
/// All 20 assertions from docs/planning/flutter/LEDGER_PHASE1.md Groups J–K:
///   Group J: Core Operations (14)
///   Group K: Encryption at Rest (6)
///
/// Expected: all tests FAIL (RED) because index_manager.dart does not exist yet.

// ── In-memory store fake ────────────────────────────────────────

class _FakeIndexStore {
  Map<String, dynamic>? _data;

  Map<String, dynamic>? readIndex() => _data;
  void writeIndex(Map<String, dynamic>? data) => _data = data;
}

// ── Test constants ──────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group J: IndexManager — Core Operations (14 tests)
  // ═══════════════════════════════════════════════════════════════

  group('J: IndexManager — Core Operations', () {
    // J1 — update adds duration to index
    test('J1: update(date, title, +duration) adds duration to index', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-15', 'Work', 5000);
      expect(index.query('2025-01-15', '2025-01-15')['Work'], 5000);
    });

    // J2 — update with same title accumulates durations
    test('J2: update with same title accumulates durations', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-15', 'Work', 3000);
      index.update('2025-01-15', 'Work', 2000);
      expect(index.query('2025-01-15', '2025-01-15')['Work'], 5000);
    });

    // J3 — update(-duration) removes title when total reaches 0
    test(
        'J3: update(date, title, -duration) removes title when total reaches 0',
        () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-15', 'Work', 5000);
      index.update('2025-01-15', 'Work', -5000);
      expect(
          index.query('2025-01-15', '2025-01-15').containsKey('Work'), isFalse);
    });

    // J4 — update removes date entry when last title is removed
    test('J4: update removes date entry when last title is removed', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-15', 'Work', 5000);
      index.update('2025-01-15', 'Work', -5000);

      // The date itself should be gone
      final all = index.getAll();
      expect(all.containsKey('2025-01-15'), isFalse);
    });

    // J5 — update is no-op when subtracting from non-existent date
    test('J5: update is no-op when subtracting from non-existent date',
        () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      // Should not create a date entry on subtraction
      index.update('2099-12-31', 'Ghost', -1000);
      final all = index.getAll();
      expect(all.isEmpty, isTrue);
    });

    // J6 — query aggregates across date range
    test('J6: query(from, to) aggregates across date range', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-15', 'Work', 3600000);
      index.update('2025-01-16', 'Work', 1800000);
      index.update('2025-01-17', 'Break', 900000);

      final results = index.query('2025-01-15', '2025-01-17');
      expect(results['Work'], 5400000); // 3600k + 1800k
      expect(results['Break'], 900000);
    });

    // J7 — query returns empty for date range with no data
    test('J7: query returns empty for date range with no data', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      final results = index.query('2020-01-01', '2020-12-31');
      expect(results, isEmpty);
    });

    // J8 — query handles single-date range (from == to)
    test('J8: query handles single-date range (from == to)', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-06-15', 'Solo', 1000);
      index.update('2025-06-16', 'Other', 2000);

      final results = index.query('2025-06-15', '2025-06-15');
      expect(results, {'Solo': 1000});
    });

    // J9 — getAll() returns full index copy
    test('J9: getAll() returns full index copy', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-01', 'A', 1000);
      index.update('2025-01-02', 'B', 2000);

      final all = index.getAll();
      expect(all.length, 2);
      expect(all['2025-01-01'], {'A': 1000});
    });

    // J10 — clear() removes all index data
    test('J10: clear() removes all index data', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-01', 'A', 1000);
      index.clear();
      expect(index.getAll(), isEmpty);
    });

    // J11 — clear() persists empty state to store
    test('J11: clear() persists empty state to store', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-01', 'A', 1000);
      index.clear();

      // Store should reflect cleared state
      final stored = store.readIndex();
      expect(stored, isNull); // or empty map for plaintext mode
    });

    // J12 — reload() re-reads from store
    test('J12: reload() re-reads from store', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-01', 'A', 1000);

      // Directly modify the store behind the cache
      store.writeIndex({'2025-01-02': {'B': 2000}});
      index.reload();

      final all = index.getAll();
      expect(all.containsKey('2025-01-02'), isTrue);
      expect(all.containsKey('2025-01-01'), isFalse); // old cache gone
    });

    // J13 — reload() handles store returning null/empty
    test('J13: reload() handles store returning null/empty', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-01-01', 'A', 1000);
      store.writeIndex(null);
      index.reload();

      expect(index.getAll(), isEmpty);
    });

    // J14 — Index data survives reload (roundtrip)
    test('J14: Index data survives reload (roundtrip)', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store);

      index.update('2025-06-01', 'Roundtrip', 5000);

      // Create a new IndexManager reading from the same store
      final index2 = IndexManager(store: store);
      final results = index2.query('2025-06-01', '2025-06-01');
      expect(results['Roundtrip'], 5000);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group K: IndexManager — Encryption at Rest (6 tests)
  // ═══════════════════════════════════════════════════════════════

  group('K: IndexManager — Encryption at Rest', () {
    // K1 — _flush encrypts index as {_enc: ciphertext} when crypto available
    test(
        'K1: _flush encrypts index as {_enc: ciphertext} when crypto is available',
        () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);

      final store = _FakeIndexStore();
      final index = IndexManager(store: store, crypto: crypto);

      index.update('2025-01-15', 'Secret', 5000);

      // The store should contain encrypted data
      final stored = store.readIndex();
      expect(stored, isNotNull);
      expect(stored!.containsKey('_enc'), isTrue);
    });

    // K2 — _load decrypts {_enc: ...} wrapper format
    test('K2: _load decrypts {_enc: ...} wrapper format', () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);

      final store = _FakeIndexStore();
      final index1 = IndexManager(store: store, crypto: crypto);
      index1.update('2025-01-15', 'Encrypted', 3000);

      // Load it back with a new IndexManager (simulating app restart)
      final index2 = IndexManager(store: store, crypto: crypto);
      final results = index2.query('2025-01-15', '2025-01-15');
      expect(results['Encrypted'], 3000);
    });

    // K3 — _load handles legacy plaintext dict format
    test('K3: _load handles legacy plaintext dict format', () {
      final store = _FakeIndexStore();
      // Pre-populate with legacy plaintext format
      store.writeIndex({
        '2025-01-15': {'Legacy': 1000},
      });

      final index = IndexManager(store: store);
      final results = index.query('2025-01-15', '2025-01-15');
      expect(results['Legacy'], 1000);
    });

    // K4 — _load handles empty/falsy store value
    test('K4: _load handles empty/falsy store value', () {
      final store = _FakeIndexStore();
      store.writeIndex(null);

      final index = IndexManager(store: store);
      expect(index.getAll(), isEmpty);
    });

    // K5 — _flush writes plaintext when crypto is null
    test('K5: _flush writes plaintext when crypto is null', () {
      final store = _FakeIndexStore();
      final index = IndexManager(store: store); // no crypto

      index.update('2025-01-15', 'Plain', 5000);

      final stored = store.readIndex();
      expect(stored, isNotNull);
      expect(stored!.containsKey('_enc'), isFalse); // plaintext format
      expect(stored['2025-01-15'], {'Plain': 5000});
    });

    // K6 — _load returns empty cache when decryption fails
    test('K6: _load returns empty cache when decryption fails', () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);

      final store = _FakeIndexStore();
      // Write corrupted encrypted data
      store.writeIndex({'_enc': 'this-is-not-valid-ciphertext'});

      final index = IndexManager(store: store, crypto: crypto);
      // Should not crash — returns empty cache
      final all = index.getAll();
      expect(all, isEmpty);
    });
  });
}
