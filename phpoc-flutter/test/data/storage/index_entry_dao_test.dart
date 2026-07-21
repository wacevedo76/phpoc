import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/index_entry.dart';

/// IndexEntryDao tests — Group F (8 assertions).
///
/// Covers:
///   F1–F8: CRUD, date/tag queries, block linkage, clear/delete

void main() {
  group('F: IndexEntryDao CRUD', () {
    late AppDatabase db;

    setUp(() async {
      db = await AppDatabase.inMemory();
    });

    tearDown(() async {
      await db.close();
    });

    // F1
    test('F1: insertIndexEntry persists an index entry', () async {
      final entry = IndexEntry(
        blockId: 'b1',
        date: '2026-07-17',
        tag: 'coding',
        entryId: 'e1',
      );
      final result = await db.indexEntryDao.insertIndexEntry(entry);
      expect(result.blockId, 'b1');
      expect(result.date, '2026-07-17');
      expect(result.tag, 'coding');
      expect(result.entryId, 'e1');
      expect(result.id, isPositive); // auto-generated
    });

    // F2
    test('F2: inserted index entry preserves all field values', () async {
      final entry = IndexEntry(
        blockId: 'block-full',
        date: '2026-01-15',
        tag: 'meeting',
        entryId: 'entry-full',
      );
      final result = await db.indexEntryDao.insertIndexEntry(entry);
      expect(result.blockId, 'block-full');
      expect(result.date, '2026-01-15');
      expect(result.tag, 'meeting');
      expect(result.entryId, 'entry-full');
    });

    // F3
    test('F3: getIndexEntriesByDate returns entries for that date', () async {
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b1', date: '2026-07-17', tag: 'coding', entryId: 'e1'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b1', date: '2026-07-17', tag: 'writing', entryId: 'e2'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b2', date: '2026-07-18', tag: 'coding', entryId: 'e3'),
      );

      final results = await db.indexEntryDao.getIndexEntriesByDate('2026-07-17');
      expect(results.length, 2);
      expect(results.map((e) => e.entryId), containsAll(['e1', 'e2']));
    });

    // F4
    test('F4: getIndexEntriesByDate returns empty for no-match', () async {
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b1', date: '2026-07-17', tag: 'coding', entryId: 'e1'),
      );

      final results = await db.indexEntryDao.getIndexEntriesByDate('2025-01-01');
      expect(results, isEmpty);
    });

    // F5
    test('F5: getIndexEntriesByTag returns entries with that tag', () async {
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b1', date: '2026-07-17', tag: 'coding', entryId: 'e1'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b1', date: '2026-07-17', tag: 'writing', entryId: 'e2'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b2', date: '2026-07-18', tag: 'coding', entryId: 'e3'),
      );

      final codingEntries = await db.indexEntryDao.getIndexEntriesByTag('coding');
      expect(codingEntries.length, 2);
      expect(codingEntries.map((e) => e.entryId), containsAll(['e1', 'e3']));
    });

    // F6
    test('F6: getIndexEntriesByBlockId returns entries for that block', () async {
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'block-a', date: '2026-07-17', tag: 'coding', entryId: 'e1'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'block-a', date: '2026-07-17', tag: 'writing', entryId: 'e2'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'block-b', date: '2026-07-18', tag: 'coding', entryId: 'e3'),
      );

      final blockAEntries = await db.indexEntryDao.getIndexEntriesByBlockId('block-a');
      expect(blockAEntries.length, 2);
    });

    // F7
    test('F7: deleteIndexEntriesByBlockId removes all entries for that block', () async {
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'block-del', date: '2026-07-17', tag: 'coding', entryId: 'e1'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'block-del', date: '2026-07-17', tag: 'writing', entryId: 'e2'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'block-keep', date: '2026-07-18', tag: 'coding', entryId: 'e3'),
      );

      await db.indexEntryDao.deleteIndexEntriesByBlockId('block-del');

      final remaining = await db.indexEntryDao.getIndexEntriesByBlockId('block-del');
      expect(remaining, isEmpty);

      final kept = await db.indexEntryDao.getIndexEntriesByBlockId('block-keep');
      expect(kept.length, 1);
    });

    // F8
    test('F8: clearAllIndexEntries removes all rows', () async {
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b1', date: '2026-07-17', tag: 'coding', entryId: 'e1'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b2', date: '2026-07-18', tag: 'writing', entryId: 'e2'),
      );

      await db.indexEntryDao.clearAllIndexEntries();

      final allDates = await db.indexEntryDao.getIndexEntriesByDate('2026-07-17');
      expect(allDates, isEmpty);

      final allTags = await db.indexEntryDao.getIndexEntriesByTag('writing');
      expect(allTags, isEmpty);
    });
  });
}
