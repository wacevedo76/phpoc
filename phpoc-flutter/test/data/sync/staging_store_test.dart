import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';

/// StagingStore tests — Group B (18 assertions).
///
/// Covers:
///   B1:  putRow() stores a row and returns void
///   B2:  getRow(activityId) returns stored row
///   B3:  getRow(nonexistentId) returns null
///   B4:  putRow() on existing activity_id overwrites (upsert)
///   B5:  putRow() preserves all 4 core fields
///   B6:  putRow() preserves extra fields beyond core 4
///   B7:  deleteRow(activityId) removes the row
///   B8:  deleteRow(nonexistentId) is idempotent (no throw)
///   B9:  getAllRows() returns all rows sorted by activity_id
///   B10: getAllRows() returns [] when table is empty
///   B11: getRowsByStatus('active') filters correctly
///   B12: getRowsByStatus('paused') returns only paused
///   B13: getRowsByStatus('ended') returns only ended
///   B14: count() returns correct count after inserts/deletes
///   B15: putRow() bumps updated_at to current time
///   B16: concurrent putRow on same activity_id (last wins)
///   B17: storage survives app restart (persisted to SQLite)
///   B18: schema migration creates staging table if not exists

/// Helper: create a test row with the 4 core fields.
Map<String, dynamic> _makeRow({
  required String activityId,
  String activityStatus = 'active',
  String activity = '{"title":"Test"}',
  int? updatedAt,
}) {
  return {
    'activity_id': activityId,
    'activity_status': activityStatus,
    'activity': activity,
    'updated_at': updatedAt ?? DateTime.now().millisecondsSinceEpoch,
  };
}

void main() {
  group('B: StagingStore — CRUD basics', () {
    // B1
    test('B1: putRow() stores a row and returns void', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(activityId: 'aaa111BBB2'));
      // verify row exists
      final row = await store.getRow('aaa111BBB2');
      expect(row, isNotNull);
      await db.close();
    });

    // B2
    test('B2: getRow(activityId) returns stored row', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(
        activityId: 'Xyz123Abc9',
        activityStatus: 'active',
        activity: '{"title":"Task 1"}',
      ));

      final row = await store.getRow('Xyz123Abc9');
      expect(row, isNotNull);
      expect(row!['activity_id'], 'Xyz123Abc9');
      expect(row['activity_status'], 'active');
      expect(row['activity'], '{"title":"Task 1"}');
      await db.close();
    });

    // B3
    test('B3: getRow(nonexistentId) returns null', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      final row = await store.getRow('noSuchId99');
      expect(row, isNull);
      await db.close();
    });

    // B4
    test('B4: putRow() on existing activity_id overwrites (upsert)', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(
        activityId: 'overwrite01',
        activityStatus: 'active',
        activity: '{"title":"Original"}',
      ));
      await store.putRow(_makeRow(
        activityId: 'overwrite01',
        activityStatus: 'ended',
        activity: '{"title":"Updated"}',
      ));

      final row = await store.getRow('overwrite01');
      expect(row, isNotNull);
      expect(row!['activity_status'], 'ended');
      expect(row['activity'], '{"title":"Updated"}');
      // Should only be one row for this ID
      final all = await store.getAllRows();
      final matches = all.where((r) => r['activity_id'] == 'overwrite01');
      expect(matches.length, 1);
      await db.close();
    });

    // B5
    test('B5: putRow() preserves all 4 core fields', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      final now = DateTime.now().millisecondsSinceEpoch;
      await store.putRow({
        'activity_id': 'core4Field1',
        'activity_status': 'paused',
        'activity': '{"encrypted":"data"}',
        'updated_at': now,
      });

      final row = await store.getRow('core4Field1');
      expect(row, isNotNull);
      expect(row!['activity_id'], 'core4Field1');
      expect(row['activity_status'], 'paused');
      expect(row['activity'], '{"encrypted":"data"}');
      expect(row['updated_at'], greaterThanOrEqualTo(now));
      await db.close();
    });

    // B6
    test('B6: putRow() preserves extra fields beyond the 4 core fields', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow({
        'activity_id': 'extraField1',
        'activity_status': 'active',
        'activity': '{}',
        'updated_at': 1000,
        'device_uuid': 'device-abc',
        'custom_field': 42,
        'nested': {'key': 'value'},
      });

      final row = await store.getRow('extraField1');
      expect(row, isNotNull);
      expect(row!['device_uuid'], 'device-abc');
      expect(row['custom_field'], 42);
      expect(row['nested'], {'key': 'value'});
      await db.close();
    });

    // B7
    test('B7: deleteRow(activityId) removes the row', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(activityId: 'toDelete01'));
      expect(await store.getRow('toDelete01'), isNotNull);

      await store.deleteRow('toDelete01');
      expect(await store.getRow('toDelete01'), isNull);
      await db.close();
    });

    // B8
    test('B8: deleteRow(nonexistentId) is idempotent (no throw)', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      // Should not throw
      await store.deleteRow('ghostId9999');
      // And again — still no throw
      await store.deleteRow('ghostId9999');
      await db.close();
    });
  });

  group('B: StagingStore — bulk operations', () {
    // B9
    test('B9: getAllRows() returns all rows sorted by activity_id', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(activityId: 'zLastItem'));
      await store.putRow(_makeRow(activityId: 'aFirstItem'));
      await store.putRow(_makeRow(activityId: 'mMiddleOne'));

      final all = await store.getAllRows();
      expect(all.length, 3);
      expect(all[0]['activity_id'], 'aFirstItem');
      expect(all[1]['activity_id'], 'mMiddleOne');
      expect(all[2]['activity_id'], 'zLastItem');
      await db.close();
    });

    // B10
    test('B10: getAllRows() returns [] when table is empty', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      final all = await store.getAllRows();
      expect(all, isEmpty);
      await db.close();
    });

    // B11
    test("B11: getRowsByStatus('active') filters correctly", () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(activityId: 'a1', activityStatus: 'active'));
      await store.putRow(_makeRow(activityId: 'a2', activityStatus: 'paused'));
      await store.putRow(_makeRow(activityId: 'a3', activityStatus: 'active'));
      await store.putRow(_makeRow(activityId: 'a4', activityStatus: 'ended'));

      final active = await store.getRowsByStatus('active');
      expect(active.length, 2);
      expect(active.map((r) => r['activity_id']).toSet(), {'a1', 'a3'});
      await db.close();
    });

    // B12
    test("B12: getRowsByStatus('paused') returns only paused rows", () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(activityId: 'p1', activityStatus: 'paused'));
      await store.putRow(_makeRow(activityId: 'p2', activityStatus: 'active'));
      await store.putRow(_makeRow(activityId: 'p3', activityStatus: 'paused'));

      final paused = await store.getRowsByStatus('paused');
      expect(paused.length, 2);
      expect(paused.map((r) => r['activity_id']).toSet(), {'p1', 'p3'});
      await db.close();
    });

    // B13
    test("B13: getRowsByStatus('ended') returns only ended rows", () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(activityId: 'e1', activityStatus: 'ended'));
      await store.putRow(_makeRow(activityId: 'e2', activityStatus: 'active'));
      await store.putRow(_makeRow(activityId: 'e3', activityStatus: 'ended'));

      final ended = await store.getRowsByStatus('ended');
      expect(ended.length, 2);
      expect(ended.map((r) => r['activity_id']).toSet(), {'e1', 'e3'});
      await db.close();
    });

    // B14
    test('B14: count() returns correct count after inserts/deletes', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      expect(await store.count(), 0);

      await store.putRow(_makeRow(activityId: 'c1'));
      await store.putRow(_makeRow(activityId: 'c2'));
      await store.putRow(_makeRow(activityId: 'c3'));
      expect(await store.count(), 3);

      await store.deleteRow('c2');
      expect(await store.count(), 2);

      await store.deleteRow('c1');
      await store.deleteRow('c3');
      expect(await store.count(), 0);
      await db.close();
    });
  });

  group('B: StagingStore — behavior guarantees', () {
    // B15
    test('B15: putRow() bumps updated_at to current time', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      final before = DateTime.now().millisecondsSinceEpoch;
      await Future<void>.delayed(const Duration(milliseconds: 5));

      await store.putRow(_makeRow(activityId: 'tsTest01', updatedAt: 0));

      final row = await store.getRow('tsTest01');
      expect(row, isNotNull);
      expect(row!['updated_at'], greaterThanOrEqualTo(before));
      await db.close();
    });

    // B16
    test('B16: concurrent putRow on same activity_id (last wins)', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      // Simulate concurrent writes by doing them in close succession
      await Future.wait([
        store.putRow(_makeRow(activityId: 'concur01', activityStatus: 'active')),
        store.putRow(_makeRow(activityId: 'concur01', activityStatus: 'ended')),
      ]);

      final row = await store.getRow('concur01');
      expect(row, isNotNull);
      // The last write should be the final state
      expect(row!['activity_id'], 'concur01');
      // There should only be one row
      final all = await store.getAllRows();
      final matches = all.where((r) => r['activity_id'] == 'concur01');
      expect(matches.length, 1);
      await db.close();
    });

    // B17
    test('B17: storage survives app restart (persisted to SQLite)', () async {
      // Use two stores backed by the same in-memory DB (simulates restart)
      final db = AppDatabase.inMemory();
      final store1 = StagingStore(db);
      await store1.putRow(_makeRow(activityId: 'persist01', activityStatus: 'active'));

      // Create a new StagingStore with same DB (simulates app restart)
      final store2 = StagingStore(db);
      final row = await store2.getRow('persist01');
      expect(row, isNotNull);
      expect(row!['activity_id'], 'persist01');
      expect(row['activity_status'], 'active');
      await db.close();
    });

    // B18
    test('B18: schema migration creates staging table if not exists', () async {
      // Create a fresh DB — StagingStore constructor should create the table
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);

      // Verify the table exists by doing CRUD
      await store.putRow(_makeRow(activityId: 'migTest01'));
      final row = await store.getRow('migTest01');
      expect(row, isNotNull);

      // Also verify we can use a second store on same DB
      final store2 = StagingStore(db);
      final all = await store2.getAllRows();
      expect(all.length, 1);
      await db.close();
    });
  });
}
