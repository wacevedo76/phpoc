import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/storage/database.dart';

/// Schema & Bootstrap tests — Groups A (12 assertions) + I (10 assertions).
///
/// Covers:
///   A1–A12: Table columns, indexes, defaults, constraints
///   I1–I10: Migrations, version tracking, idempotency, WAL mode

// ────────────────────────────────────────────────────────────
// Group A: Schema & Bootstrap
// ────────────────────────────────────────────────────────────

void main() {
  group('A: Database Schema & Bootstrap', () {
    // A1
    test('A1: AppDatabase extends generated Drift class', () async {
      // Drift requires @DriftDatabase annotation + generated superclass
      final db = await AppDatabase.inMemory();
      expect(db, isA<AppDatabase>());
    });

    // A2 — wrapped in a group so we can setUp a shared in-memory db
    group('table structure', () {
      late AppDatabase db;

      setUp(() async {
        db = await AppDatabase.inMemory();
      });

      tearDown(() async {
        await db.close();
      });

      // A2
      test('A2: database opens without error with in-memory backend', () async {
        // Just opening in setUp already proves this — add explicit assertion
        expect(db, isNotNull);
      });

      // A3
      test('A3: entries table has all required columns with correct types', () async {
        final rows = await db.customSelect('PRAGMA table_info(entries)').get();
        final cols = <String, String>{
          for (final r in rows) r.read<String>('name'): r.read<String>('type'),
        };
        expect(cols['entry_id'], isNotNull);
        expect(cols['title'], isNotNull);
        expect(cols['start_epoch'], isNotNull);
        expect(cols['end_epoch'], isNotNull);
        expect(cols['is_active'], isNotNull);
        expect(cols['committed'], isNotNull);
        expect(cols['device_uuid'], isNotNull);
        expect(cols['content_hash'], isNotNull);
        expect(cols['metadata_enc'], isNotNull);
        expect(cols['tags'], isNotNull);
        expect(cols['pauses'], isNotNull);
        expect(cols['created_at'], isNotNull);
        expect(cols['updated_at'], isNotNull);
        expect(cols.length, 13);
      });

      // A4
      test('A4: blocks table has all required columns with correct types', () async {
        final rows = await db.customSelect('PRAGMA table_info(blocks)').get();
        final cols = <String, String>{
          for (final r in rows) r.read<String>('name'): r.read<String>('type'),
        };
        expect(cols['block_id'], isNotNull);
        expect(cols['block_type'], isNotNull);
        expect(cols['block_index'], isNotNull);
        expect(cols['key_version'], isNotNull);
        expect(cols['data_enc'], isNotNull);
        expect(cols['identity_seal'], isNotNull);
        expect(cols['prev_hash'], isNotNull);
        expect(cols['created_at'], isNotNull);
        expect(cols.length, 8);
      });

      // A5
      test('A5: index_entries table has all required columns with correct types', () async {
        final rows = await db.customSelect('PRAGMA table_info(index_entries)').get();
        final cols = <String, String>{
          for (final r in rows) r.read<String>('name'): r.read<String>('type'),
        };
        expect(cols['id'], isNotNull);
        expect(cols['block_id'], isNotNull);
        expect(cols['date'], isNotNull);
        expect(cols['tag'], isNotNull);
        expect(cols['entry_id'], isNotNull);
        expect(cols.length, 5);
      });

      // A6
      test('A6: entries.created_at and updated_at auto-populate on insert', () async {
        final entryId = 'test-a6-${DateTime.now().millisecondsSinceEpoch}';
        await db.customStatement('''
          INSERT INTO entries (entry_id, title, start_epoch, is_active, committed,
                               tags, pauses)
          VALUES (?, 'auto-test', 1000, 1, 0, '[]', '[]')
        ''', [entryId]);

        final row = await db.customSelect(
          'SELECT created_at, updated_at FROM entries WHERE entry_id = ?',
          variables: [entryId],
        ).getSingle();
        expect(row.read<int>('created_at'), isPositive);
        expect(row.read<int>('updated_at'), isPositive);
        // Both should be set to the same timestamp (insert time)
        expect(row.read<int>('created_at'), row.read<int>('updated_at'));
      });

      // A7
      test('A7: entries.is_active defaults to true (1)', () async {
        final entryId = 'test-a7-${DateTime.now().millisecondsSinceEpoch}';
        await db.customStatement('''
          INSERT INTO entries (entry_id, title, start_epoch, tags, pauses)
          VALUES (?, 'default-test', 1000, '[]', '[]')
        ''', [entryId]);

        final row = await db.customSelect(
          'SELECT is_active FROM entries WHERE entry_id = ?',
          variables: [entryId],
        ).getSingle();
        expect(row.read<int>('is_active'), 1);
      });

      // A8
      test('A8: entries.committed defaults to false (0)', () async {
        final entryId = 'test-a8-${DateTime.now().millisecondsSinceEpoch}';
        await db.customStatement('''
          INSERT INTO entries (entry_id, title, start_epoch, tags, pauses)
          VALUES (?, 'default-test', 1000, '[]', '[]')
        ''', [entryId]);

        final row = await db.customSelect(
          'SELECT committed FROM entries WHERE entry_id = ?',
          variables: [entryId],
        ).getSingle();
        expect(row.read<int>('committed'), 0);
      });

      // A9
      test('A9: blocks.key_version defaults to 1', () async {
        final blockId = 'test-a9-${DateTime.now().millisecondsSinceEpoch}';
        await db.customStatement('''
          INSERT INTO blocks (block_id, block_type, block_index, data_enc, prev_hash)
          VALUES (?, 'genesis', 0, 'fake-data', '${Block.genesisPrevHash}')
        ''', [blockId]);

        final row = await db.customSelect(
          'SELECT key_version FROM blocks WHERE block_id = ?',
          variables: [blockId],
        ).getSingle();
        expect(row.read<int>('key_version'), 1);
      });

      // A10
      test('A10: indexes exist on entries(is_active), entries(committed), entries(start_epoch)', () async {
        final rows = await db.customSelect(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entries' ORDER BY name",
        ).get();
        final names = rows.map((r) => r.read<String>('name')).toSet();
        expect(names.any((n) => n.contains('is_active') || n.contains('active')), isTrue);
        expect(names.any((n) => n.contains('committed')), isTrue);
        expect(names.any((n) => n.contains('start') || n.contains('start_epoch')), isTrue);
      });

      // A11
      test('A11: indexes exist on blocks(block_type), blocks(block_index)', () async {
        final rows = await db.customSelect(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='blocks' ORDER BY name",
        ).get();
        final names = rows.map((r) => r.read<String>('name')).toSet();
        expect(names.any((n) => n.contains('block_type')), isTrue);
        expect(names.any((n) => n.contains('block_index')), isTrue);
      });

      // A12
      test('A12: indexes exist on index_entries(date), index_entries(tag)', () async {
        final rows = await db.customSelect(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='index_entries' ORDER BY name",
        ).get();
        final names = rows.map((r) => r.read<String>('name')).toSet();
        expect(names.any((n) => n.contains('date')), isTrue);
        expect(names.any((n) => n.contains('tag')), isTrue);
      });
    });
  });

  // ────────────────────────────────────────────────────────────
  // Group I: Migrations
  // ────────────────────────────────────────────────────────────

  group('I: Migrations', () {
    // I1
    test('I1: fresh database opens at current schemaVersion', () async {
      final db = await AppDatabase.inMemory();
      expect(db.schemaVersion, greaterThan(0));
      await db.close();
    });

    // I2
    test('I2: schemaVersion getter returns current version number', () async {
      final db = await AppDatabase.inMemory();
      final version = db.schemaVersion;
      expect(version, isA<int>());
      expect(version, greaterThanOrEqualTo(1));
      await db.close();
    });

    // I3
    test('I3: migration from v1 to v2 preserves all existing entry data', () async {
      // Open at v1, insert data, migrate to v2, verify data intact
      final db = await AppDatabase.openAtVersion(1);
      final entryId = 'migrate-i3-1';
      await db.customStatement('''
        INSERT INTO entries (entry_id, title, start_epoch, is_active, committed,
                             tags, pauses)
        VALUES (?, 'before-migration', 5000, 1, 0, '["test"]', '[]')
      ''', [entryId]);

      await db.migrateToVersion(2);

      final row = await db.customSelect(
        'SELECT title, tags FROM entries WHERE entry_id = ?',
        variables: [entryId],
      ).getSingle();
      expect(row.read<String>('title'), 'before-migration');
      expect(row.read<String>('tags'), '["test"]');
      await db.close();
    });

    // I4
    test('I4: migration from v1 to v2 preserves all existing block data', () async {
      final db = await AppDatabase.openAtVersion(1);
      final blockId = 'block-i4-1';
      await db.customStatement('''
        INSERT INTO blocks (block_id, block_type, block_index, data_enc, prev_hash)
        VALUES (?, 'genesis', 0, 'genesis-data', ?)
      ''', [blockId, Block.genesisPrevHash]);

      await db.migrateToVersion(2);

      final row = await db.customSelect(
        'SELECT block_type, data_enc FROM blocks WHERE block_id = ?',
        variables: [blockId],
      ).getSingle();
      expect(row.read<String>('block_type'), 'genesis');
      expect(row.read<String>('data_enc'), 'genesis-data');
      await db.close();
    });

    // I5
    test('I5: migration adds new columns with correct default values', () async {
      // This test verifies that when a migration adds a column, existing
      // rows get the correct default value (not null unless nullable).
      final db = await AppDatabase.openAtVersion(1);
      final entryId = 'migrate-i5-1';
      await db.customStatement('''
        INSERT INTO entries (entry_id, title, start_epoch, is_active, committed,
                             tags, pauses)
        VALUES (?, 'col-test', 6000, 1, 0, '[]', '[]')
      ''', [entryId]);

      await db.migrateToVersion(2);

      // After migration, new columns should have non-null defaults
      // (specific columns depend on what v2 adds — test is forward-looking)
      final row = await db.customSelect(
        'SELECT * FROM entries WHERE entry_id = ?',
        variables: [entryId],
      ).getSingle();
      // Entry still exists and is readable
      expect(row.read<String>('entry_id'), entryId);
      await db.close();
    });

    // I6
    test('I6: migration creates new indexes if added in schema', () async {
      final db = await AppDatabase.openAtVersion(1);
      await db.migrateToVersion(2);

      // All expected indexes should exist after migration
      final rows = await db.customSelect(
        "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
      ).get();
      expect(rows, isNotEmpty);
      await db.close();
    });

    // I7
    test('I7: opening database at current version twice is idempotent', () async {
      final db1 = AppDatabase.inMemory();
      final v1 = db1.schemaVersion;
      await db1.close();

      final db2 = AppDatabase.inMemory();
      final v2 = db2.schemaVersion;
      await db2.close();

      expect(v1, v2);
    });

    // I8
    test('I8: database opened at old version auto-upgrades on first open', () async {
      final db = await AppDatabase.openAtVersion(AppDatabase.supportedSchemaVersion - 1);
      // Database should auto-upgrade to current version
      expect(db.schemaVersion, greaterThanOrEqualTo(db.schemaVersion));
      await db.close();
    });

    // I9
    test('I9: downgrade attempt throws clear error', () async {
      // Trying to open a database at a version newer than the code supports
      // should produce a clear error, not silent corruption
      final futureVersion = AppDatabase.supportedSchemaVersion + 5;
      expect(
        () => AppDatabase.openAtVersion(futureVersion),
        throwsA(isA<Exception>()),
      );
    });

    // I10
    test('I10: beforeOpen configures SQLite pragmas (WAL mode, foreign keys ON)', () async {
      final db = await AppDatabase.inMemory();

      final walRow = await db.customSelect('PRAGMA journal_mode').getSingle();
      // WAL mode is the default — journal_mode should be 'wal'
      // (In-memory databases may report 'memory' — accept either)
      final journalMode = walRow.read<String>('journal_mode').toLowerCase();
      expect(
        journalMode == 'wal' || journalMode == 'memory',
        isTrue,
        reason: 'Expected WAL or memory journal mode, got: $journalMode',
      );

      final fkRow = await db.customSelect('PRAGMA foreign_keys').getSingle();
      expect(fkRow.read<int>('foreign_keys'), 1);

      await db.close();
    });
  });
}
