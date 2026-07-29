import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';

/// Legacy API backward compatibility tests — Group K (5 assertions).
///
/// Verifies the old SyncService API surface still works after the
/// staging schema overhaul, so existing callers don't break:
///
///   K1: readEntries() still returns flat DTO list
///   K2: getActive() returns rows where status="active"
///   K3: getCompleted() returns rows where status="ended" and not in ledger
///   K4: index-based modify(index, fields) adapter maps index → activity_id
///   K5: commitEntries() (old name) delegates to commitAndSync() with no selections

/// In-memory storage matching SyncService's expected contract.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);

  // LedgerEngine support
  List<Map<String, dynamic>> readBlocks() =>
      (_data['blocks'] as List?)?.cast<Map<String, dynamic>>() ?? [];
  void appendBlocks(List blocks) {
    _data.putIfAbsent('blocks', () => []);
    (_data['blocks'] as List).addAll(blocks);
  }
  List truncate(int keepCount) {
    final blocks = (_data['blocks'] as List?) ?? [];
    final removed = List.from(blocks.sublist(keepCount));
    _data['blocks'] = List.from(blocks.sublist(0, keepCount));
    return removed;
  }
  int getBlockCount() => (_data['blocks'] as List?)?.length ?? 0;
  Map<String, dynamic>? getLastBlock() {
    final blocks = _data['blocks'] as List?;
    if (blocks == null || blocks.isEmpty) return null;
    return blocks.last as Map<String, dynamic>;
  }
  // Legacy entries support (pre-migration)
  List? readEntries() => _data['entries'] as List?;
  void writeEntries(List entries) => _data['entries'] = entries;
}

/// Create a CryptoService with cached MK.
Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  return crypto;
}

void main() {
  group('K: Legacy API compatibility', () {
    // K1
    test('K1: readEntries() still returns flat DTO list via StagingStore', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();
      final sync = SyncService(
        storage: storage,
        crypto: crypto,
        stagingStore: store,
      );

      // Seed staging via new API
      await store.putRow({
        'activity_id': 'k1entry001',
        'activity_status': 'active',
        'activity': '{"title":"K1 Task","start_epoch":1000}',
        'updated_at': 1000,
      });

      // readEntries() should still work and return DTOs
      final entries = await sync.readEntries();
      expect(entries, isA<List>());
      expect(entries.length, 1);
      // Should have flat DTO fields
      expect(entries[0], contains('activity_id'));
      await db.close();
    });

    // K2
    test('K2: getActive() returns rows where status="active"', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();
      final sync = SyncService(
        storage: storage,
        crypto: crypto,
        stagingStore: store,
      );

      await store.putRow({
        'activity_id': 'active01',
        'activity_status': 'active',
        'activity': '{"title":"Active Task"}',
        'updated_at': 1000,
      });
      await store.putRow({
        'activity_id': 'ended01',
        'activity_status': 'ended',
        'activity': '{"title":"Ended Task"}',
        'updated_at': 2000,
      });

      final active = await sync.getActive();
      expect(active.length, 1);
      expect(active[0]['activity_id'], 'active01');
      await db.close();
    });

    // K3
    test('K3: getCompleted() returns rows where status="ended" and not in ledger', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();
      final sync = SyncService(
        storage: storage,
        crypto: crypto,
        stagingStore: store,
      );

      await store.putRow({
        'activity_id': 'ended01',
        'activity_status': 'ended',
        'activity': '{"title":"Ended Task","start_epoch":3000}',
        'updated_at': 3000,
      });
      await store.putRow({
        'activity_id': 'active01',
        'activity_status': 'active',
        'activity': '{"title":"Active Task"}',
        'updated_at': 1000,
      });

      final completed = await sync.getCompleted();
      expect(completed.length, 1);
      expect(completed[0]['activity_id'], 'ended01');
      // Should have a 'date' field
      expect(completed[0], contains('date'));
      await db.close();
    });

    // K4
    test('K4: index-based modify(index, fields) adapter maps index → activity_id', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();
      final sync = SyncService(
        storage: storage,
        crypto: crypto,
        stagingStore: store,
      );

      // Seed two rows (deterministic order by activity_id)
      await store.putRow({
        'activity_id': 'aaFirst001',
        'activity_status': 'active',
        'activity': '{"title":"First"}',
        'updated_at': 1000,
      });
      await store.putRow({
        'activity_id': 'bbSecnd01',
        'activity_status': 'active',
        'activity': '{"title":"Second"}',
        'updated_at': 2000,
      });

      // Modify index 0 → should affect 'aaFirst001'
      await sync.modify(0, {'title': 'Modified First'});

      final row = await store.getRow('aaFirst001');
      expect(row, isNotNull);
      // The activity field should reflect the modification
      expect(row!['activity'], contains('Modified First'));
      await db.close();
    });

    // K5
    test('K5: commitEntries() delegates to commitAndSync() with no selections', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();
      final sync = SyncService(
        storage: storage,
        crypto: crypto,
        stagingStore: store,
      );

      // commitEntries() on an empty staging should return null (no-op)
      final result = await sync.commitEntries();
      expect(result, isNull,
          reason: 'commitEntries() without seeding should be a no-op');

      // Verify commitEntries still exists and returns String? like before
      expect(sync.commitEntries, isA<Function>());
      await db.close();
    });
  });
}
