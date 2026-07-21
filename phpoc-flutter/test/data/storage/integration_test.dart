import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/entry.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/index_entry.dart';

/// Integration / Cross-DAO tests — Group K (5 assertions).
///
/// Covers:
///   K1–K5: Multi-table writes, referential integrity, many-to-many, cross-table consistency,
///           transactional integrity

void main() {
  group('K: Integration / Cross-DAO', () {
    late AppDatabase db;

    setUp(() async {
      db = await AppDatabase.inMemory();
    });

    tearDown(() async {
      await db.close();
    });

    // K1
    test('K1: insert entry → insert block → insert index entry referencing both', () async {
      // Full commit flow: create entry, seal into block, build index
      final entry = await db.entryDao.insertEntry(Entry(
        entryId: 'k1-entry',
        title: 'Integration test',
        startEpoch: 1_000_000,
        tags: ['coding'],
      ));

      final block = await db.blockDao.insertBlock(Block(
        blockId: 'k1-block',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: 'encrypted-block-data',
        prevHash: 'aa',
        createdAt: 2_000_000,
      ));

      final indexEntry = await db.indexEntryDao.insertIndexEntry(IndexEntry(
        blockId: block.blockId,
        date: '2026-07-17',
        tag: 'coding',
        entryId: entry.entryId,
      ));

      // Verify all three exist
      expect(await db.entryDao.getEntry('k1-entry'), isNotNull);
      expect(await db.blockDao.getBlock('k1-block'), isNotNull);

      final idxEntries = await db.indexEntryDao.getIndexEntriesByBlockId('k1-block');
      expect(idxEntries.length, 1);
      expect(idxEntries[0].entryId, 'k1-entry');
    });

    // K2
    test('K2: delete block → index entries for that block are orphaned', () async {
      // Insert block + index entries
      await db.blockDao.insertBlock(Block(
        blockId: 'k2-block',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: 'data',
        prevHash: 'aa',
        createdAt: 1_000,
      ));
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'k2-block', date: '2026-07-17', tag: 'coding', entryId: 'e1'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'k2-block', date: '2026-07-17', tag: 'writing', entryId: 'e2'),
      );

      // Delete the block (no cascading — PH Ledger doesn't use FK cascades)
      await db.customStatement('DELETE FROM blocks WHERE block_id = ?', ['k2-block']);

      // Index entries for that block are now orphaned
      // (This test documents the behavior — no cascade delete)
      final orphaned = await db.indexEntryDao.getIndexEntriesByBlockId('k2-block');
      // They still exist because no FK cascade is configured
      expect(orphaned.length, 2);
    });

    // K3
    test('K3: multiple entries can reference the same tag in index_entries', () async {
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b1', date: '2026-07-17', tag: 'coding', entryId: 'e1'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b1', date: '2026-07-17', tag: 'coding', entryId: 'e2'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b2', date: '2026-07-18', tag: 'coding', entryId: 'e3'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b2', date: '2026-07-18', tag: 'coding', entryId: 'e4'),
      );
      await db.indexEntryDao.insertIndexEntry(
        IndexEntry(blockId: 'b3', date: '2026-07-19', tag: 'coding', entryId: 'e5'),
      );

      final codingEntries = await db.indexEntryDao.getIndexEntriesByTag('coding');
      expect(codingEntries.length, 5);
      expect(codingEntries.map((e) => e.entryId),
        containsAll(['e1', 'e2', 'e3', 'e4', 'e5']));
    });

    // K4
    test('K4: entry with committed=true and block_index survives separate block insert', () async {
      // Insert entry first (staging), then commit it (mark committed=true)
      await db.entryDao.insertEntry(Entry(
        entryId: 'k4-entry',
        title: 'Will be committed',
        startEpoch: 1_000,
      ));

      // Mark as committed (simulating commit flow)
      await db.entryDao.updateEntry('k4-entry', {'committed': true});

      // Now insert the block separately
      await db.blockDao.insertBlock(Block(
        blockId: 'k4-block',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: 'data',
        prevHash: 'aa',
        createdAt: 2_000,
      ));

      // Entry should still be committed
      final entry = await db.entryDao.getEntry('k4-entry');
      expect(entry!.committed, isTrue);

      // Block should exist independently
      final block = await db.blockDao.getBlock('k4-block');
      expect(block, isNotNull);
    });

    // K5
    test('K5: all three DAOs can operate in a single transaction (atomic commit)', () async {
      // Use a transaction to atomically insert entry + block + index entry
      await db.transaction(() async {
        await db.entryDao.insertEntry(Entry(
          entryId: 'k5-entry',
          title: 'Atomic test',
          startEpoch: 1_000,
          tags: ['test'],
        ));

        await db.blockDao.insertBlock(Block(
          blockId: 'k5-block',
          blockType: BlockType.day,
          blockIndex: 1,
          dataEnc: 'data',
          prevHash: 'aa',
          createdAt: 2_000,
        ));

        await db.indexEntryDao.insertIndexEntry(IndexEntry(
          blockId: 'k5-block',
          date: '2026-07-17',
          tag: 'test',
          entryId: 'k5-entry',
        ));
      });

      // All three should exist
      expect(await db.entryDao.getEntry('k5-entry'), isNotNull);
      expect(await db.blockDao.getBlock('k5-block'), isNotNull);

      final idx = await db.indexEntryDao.getIndexEntriesByBlockId('k5-block');
      expect(idx.length, 1);
    });
  });
}
