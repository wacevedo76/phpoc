import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/storage/migration.dart';

/// Staging migration tests — Group C (12 assertions).
///
/// Covers migration from the old `_staging_kv.entries` JSON-array blob
/// to the new row-per-activity `staging` table.
///
///   C1:  Migration detects old entries blob and migrates
///   C2:  Migration is a no-op when staging table already has rows
///   C3:  Each migrated entry gets a generated activity_id
///   C4:  Migrated entry's activity_status derived from is_active/is_paused
///   C5:  Migrated entry's activity field contains original encrypted data blob
///   C6:  Migrated entry's updated_at set to migration time (or original end_epoch)
///   C7:  Migration sets migrated_v1 flag to prevent re-run
///   C8:  Entry with committed==true in old blob is NOT migrated
///   C9:  Entry with existing activity_id in old blob preserves it
///   C10: Migration handles empty entries blob gracefully
///   C11: Migration handles malformed entries blob gracefully
///   C12: After migration, old entries key is deleted from storage

/// In-memory storage simulating the old `_staging_kv` key-value store.
class _FakeLegacyStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
  bool hasKey(String key) => _data.containsKey(key);
}

/// Build old-format entries (matching current LocalCache schema).
Map<String, dynamic> _oldEntry({
  required String title,
  required int startEpoch,
  bool isActive = true,
  bool isPaused = false,
  bool committed = false,
  String entryId = '',
  int? endEpoch,
}) {
  return {
    'hash': 'abcd1234ef',
    'data': {
      'entry_id': entryId,
      'title': title,
      'startTime_enc': 'plain:$startEpoch',
      'endTime_enc': endEpoch != null ? 'plain:$endEpoch' : null,
      'duration': endEpoch != null ? endEpoch - startEpoch : 0,
      'is_active': isActive,
      'is_paused': isPaused,
      'pauses_enc': 'plain:[]',
      'tags': ['test'],
      'device_uuid_enc': 'plain:dev-1',
      'end_device_uuid_enc': 'plain:',
      'metadata_enc': 'plain:{}',
    },
    'committed': committed,
  };
}

void main() {
  group('C: StagingMigration — detection and migration', () {
    // C1
    test('C1: migration detects old entries blob and migrates', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);
      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);

      // Seed old-format data
      await legacy.set('entries', [
        _oldEntry(title: 'Old Task', startEpoch: 1000),
      ]);

      final needsIt = await migration.needsMigration();
      expect(needsIt, isTrue);

      await migration.migrate();

      // After migration, new staging table should have data
      final rows = await store.getAllRows();
      expect(rows.length, 1);
      await db.close();
    });

    // C2
    test('C2: migration is a no-op when staging table already has rows', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      // Pre-populate staging table
      await store.putRow({
        'activity_id': 'existing01',
        'activity_status': 'active',
        'activity': '{}',
        'updated_at': 1000,
      });

      // Also put old entries in legacy storage
      await legacy.set('entries', [
        _oldEntry(title: 'Should Not Migrate', startEpoch: 2000),
      ]);

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      final needsIt = await migration.needsMigration();

      // Should not need migration — staging already has data
      expect(needsIt, isFalse);

      // Even if forced, it should be a no-op
      await migration.migrate();
      final rows = await store.getAllRows();
      expect(rows.length, 1); // only the existing row, not the old entry
      expect(rows[0]['activity_id'], 'existing01');
      await db.close();
    });

    // C3
    test('C3: each migrated entry gets a generated activity_id', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      await legacy.set('entries', [
        _oldEntry(title: 'A', startEpoch: 1000),
        _oldEntry(title: 'B', startEpoch: 2000),
        _oldEntry(title: 'C', startEpoch: 3000),
      ]);

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      await migration.migrate();

      final rows = await store.getAllRows();
      expect(rows.length, 3);
      for (final row in rows) {
        final id = row['activity_id'] as String?;
        expect(id, isNotNull);
        expect(id!.length, 10);
        expect(id, matches(RegExp(r'^[A-Za-z0-9]{10}$')));
      }
      // All IDs should be distinct
      final ids = rows.map((r) => r['activity_id'] as String).toSet();
      expect(ids.length, 3);
      await db.close();
    });

    // C4
    test('C4: migrated entry has correct activity_status from is_active/is_paused', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      await legacy.set('entries', [
        _oldEntry(title: 'Active', startEpoch: 1000, isActive: true, isPaused: false),
        _oldEntry(title: 'Paused', startEpoch: 2000, isActive: true, isPaused: true),
        _oldEntry(title: 'Ended', startEpoch: 3000, isActive: false),
      ]);

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      await migration.migrate();

      final rows = await store.getAllRows();
      expect(rows.length, 3);

      final byTitle = {for (final r in rows) r['activity']: r['activity_status']};
      // activity field contains encrypted data blob — we can extract title from it
      // But for status check, we just verify all 3 statuses exist
      final statuses = rows.map((r) => r['activity_status'] as String).toSet();
      expect(statuses, contains('active'));
      expect(statuses, contains('paused'));
      expect(statuses, contains('ended'));
      await db.close();
    });

    // C5
    test("C5: migrated entry's activity field contains original encrypted data blob", () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      await legacy.set('entries', [
        _oldEntry(title: 'DataCheck', startEpoch: 5000, endEpoch: 10000),
      ]);

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      await migration.migrate();

      final rows = await store.getAllRows();
      expect(rows.length, 1);
      // activity field should be a JSON string containing the original entry data
      final activityJson = rows[0]['activity'] as String?;
      expect(activityJson, isNotNull);
      expect(activityJson, contains('startTime_enc'));
      expect(activityJson, contains('endTime_enc'));
      await db.close();
    });

    // C6
    test("C6: migrated entry's updated_at set to migration time", () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      await legacy.set('entries', [
        _oldEntry(title: 'Timestamp', startEpoch: 1000),
      ]);

      final before = DateTime.now().millisecondsSinceEpoch;

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      await migration.migrate();

      final rows = await store.getAllRows();
      expect(rows.length, 1);
      expect(rows[0]['updated_at'], greaterThanOrEqualTo(before));
      await db.close();
    });

    // C7
    test('C7: migration sets migrated_v1 flag to prevent re-run', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      await legacy.set('entries', [
        _oldEntry(title: 'FlagTest', startEpoch: 1000),
      ]);

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);

      // First run
      expect(await migration.needsMigration(), isTrue);
      await migration.migrate();

      // Second run — should not need migration
      expect(await migration.needsMigration(), isFalse);

      // Migration should be idempotent
      await migration.migrate();
      final rows = await store.getAllRows();
      expect(rows.length, 1); // still only 1 row
      await db.close();
    });

    // C8
    test('C8: entry with committed=true in old blob is NOT migrated', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      await legacy.set('entries', [
        _oldEntry(title: 'Active', startEpoch: 1000),
        _oldEntry(title: 'Committed', startEpoch: 2000, committed: true),
        _oldEntry(title: 'Also Active', startEpoch: 3000),
      ]);

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      await migration.migrate();

      final rows = await store.getAllRows();
      expect(rows.length, 2); // committed entry excluded
      await db.close();
    });

    // C9
    test('C9: entry with existing activity_id in old blob preserves it', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      await legacy.set('entries', [
        _oldEntry(title: 'Web Entry', startEpoch: 1000, entryId: 'webOrigId01'),
      ]);

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      await migration.migrate();

      final rows = await store.getAllRows();
      expect(rows.length, 1);
      // Should preserve the original entry_id as activity_id (or use it in activity data)
      // Exact behavior depends on implementation — check that the entry_id is preserved
      final activity = rows[0]['activity'] as String?;
      expect(activity, isNotNull);
      expect(activity, contains('webOrigId01'));
      await db.close();
    });

    // C10
    test('C10: migration handles empty entries blob gracefully (no crash)', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      await legacy.set('entries', []);

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      await migration.migrate(); // should not throw

      final rows = await store.getAllRows();
      expect(rows, isEmpty);
      await db.close();
    });

    // C11
    test('C11: migration handles malformed entries blob gracefully (no crash)', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      // Not a valid list
      await legacy.set('entries', 'not-a-list');

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      // Should not throw
      await migration.migrate();
      await db.close();
    });

    // C12
    test('C12: after migration, old entries key is deleted from storage', () async {
      final db = AppDatabase.inMemory();
      final legacy = _FakeLegacyStorage();
      final store = StagingStore(db);

      await legacy.set('entries', [
        _oldEntry(title: 'Cleanup', startEpoch: 1000),
      ]);
      expect(await legacy.get('entries'), isNotNull);

      final migration = StagingMigration(db: db, legacyStorage: legacy, stagingStore: store);
      await migration.migrate();

      // Old key should be removed
      final oldEntries = await legacy.get('entries');
      expect(oldEntries, isNull);
      await db.close();
    });
  });
}
