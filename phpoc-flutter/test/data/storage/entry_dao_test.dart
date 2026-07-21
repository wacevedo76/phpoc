import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/entry.dart';
import 'package:phpoc_flutter/data/storage/database.dart';

/// EntryDao tests — Groups B (18 assertions) + C (8 assertions).
///
/// Covers:
///   B1–B18: CRUD operations
///   C1–C8: Edge cases (nulls, empty collections, large values, Unicode, duplicates)

void main() {
  group('B: EntryDao CRUD', () {
    late AppDatabase db;

    setUp(() async {
      db = await AppDatabase.inMemory();
    });

    tearDown(() async {
      await db.close();
    });

    // ── Create ──────────────────────────────────────────────

    // B1
    test('B1: insertEntry persists an entry and returns it', () async {
      final entry = Entry(
        entryId: 'b1-entry',
        title: 'Test task',
        startEpoch: 1000,
        tags: ['coding'],
      );
      final result = await db.entryDao.insertEntry(entry);
      expect(result.entryId, entry.entryId);
      expect(result.title, entry.title);
    });

    // B2
    test('B2: inserted entry preserves all field values', () async {
      final entry = Entry(
        entryId: 'b2-full',
        title: 'Full field test',
        startEpoch: 2000,
        endEpoch: 3000,
        isActive: false,
        committed: true,
        tags: ['work', 'meeting'],
        pauses: [PauseRecord(startEpoch: 2200, endEpoch: 2300)],
        metadataEnc: 'meta-base64',
        deviceUuid: 'device-abc',
        contentHash: 'hash-abc123',
      );
      final result = await db.entryDao.insertEntry(entry);
      expect(result.entryId, 'b2-full');
      expect(result.title, 'Full field test');
      expect(result.startEpoch, 2000);
      expect(result.endEpoch, 3000);
      expect(result.isActive, false);
      expect(result.committed, true);
      expect(result.tags, ['work', 'meeting']);
      expect(result.pauses.length, 1);
      expect(result.pauses[0].startEpoch, 2200);
      expect(result.pauses[0].endEpoch, 2300);
      expect(result.metadataEnc, 'meta-base64');
      expect(result.deviceUuid, 'device-abc');
      expect(result.contentHash, 'hash-abc123');
    });

    // B3
    test('B3: insertEntry auto-generates created_at and updated_at', () async {
      final entry = Entry(entryId: 'b3-ts', title: 'TS test', startEpoch: 1000);
      final result = await db.entryDao.insertEntry(entry);
      // We can't check created_at/updated_at directly on Entry model
      // (they're DB-level columns). Instead verify via raw query.
      final row = await db.customSelect(
        'SELECT created_at, updated_at FROM entries WHERE entry_id = ?',
        variables: [entry.entryId],
      ).getSingle();
      expect(row.read<int>('created_at'), isPositive);
      expect(row.read<int>('updated_at'), isPositive);
    });

    // ── Read ────────────────────────────────────────────────

    // B4
    test('B4: getEntry(id) returns the correct entry by primary key', () async {
      await db.entryDao.insertEntry(
        Entry(entryId: 'b4-lookup', title: 'Lookup me', startEpoch: 1000),
      );
      final found = await db.entryDao.getEntry('b4-lookup');
      expect(found, isNotNull);
      expect(found!.title, 'Lookup me');
    });

    // B5
    test('B5: getEntry(id) returns null for non-existent entry', () async {
      final found = await db.entryDao.getEntry('non-existent');
      expect(found, isNull);
    });

    // B6
    test('B6: getAllEntries returns all entries ordered by start_epoch DESC', () async {
      await db.entryDao.insertEntry(Entry(entryId: 'b6-a', title: 'A', startEpoch: 1000));
      await db.entryDao.insertEntry(Entry(entryId: 'b6-b', title: 'B', startEpoch: 3000));
      await db.entryDao.insertEntry(Entry(entryId: 'b6-c', title: 'C', startEpoch: 2000));

      final results = await db.entryDao.getAllEntries();
      expect(results.length, 3);
      // Should be ordered by start_epoch DESC
      expect(results[0].startEpoch, 3000);
      expect(results[1].startEpoch, 2000);
      expect(results[2].startEpoch, 1000);
    });

    // B7
    test('B7: getActiveEntries returns only entries where is_active = true', () async {
      await db.entryDao.insertEntry(
        Entry(entryId: 'b7-active', title: 'Active', startEpoch: 1000, isActive: true),
      );
      await db.entryDao.insertEntry(
        Entry(entryId: 'b7-done', title: 'Done', startEpoch: 2000, isActive: false),
      );

      final active = await db.entryDao.getActiveEntries();
      expect(active.length, 1);
      expect(active[0].entryId, 'b7-active');
    });

    // B8
    test('B8: getActiveEntries returns empty list when no active entries', () async {
      await db.entryDao.insertEntry(
        Entry(entryId: 'b8-done', title: 'Done', startEpoch: 1000, isActive: false),
      );
      final active = await db.entryDao.getActiveEntries();
      expect(active, isEmpty);
    });

    // B9
    test('B9: getEntriesByDateRange returns entries within the range', () async {
      // start_epoch is milliseconds — 1_000_000 = ~16.7 min
      await db.entryDao.insertEntry(
        Entry(entryId: 'b9-in', title: 'In range', startEpoch: 1_000_000),
      );
      final results = await db.entryDao.getEntriesByDateRange(
        from: 900_000,
        to: 1_100_000,
      );
      expect(results.length, 1);
      expect(results[0].entryId, 'b9-in');
    });

    // B10
    test('B10: getEntriesByDateRange excludes entries outside the range', () async {
      await db.entryDao.insertEntry(
        Entry(entryId: 'b10-before', title: 'Before', startEpoch: 500_000),
      );
      await db.entryDao.insertEntry(
        Entry(entryId: 'b10-in', title: 'In range', startEpoch: 1_000_000),
      );
      await db.entryDao.insertEntry(
        Entry(entryId: 'b10-after', title: 'After', startEpoch: 2_000_000),
      );

      final results = await db.entryDao.getEntriesByDateRange(
        from: 900_000,
        to: 1_100_000,
      );
      expect(results.length, 1);
      expect(results[0].entryId, 'b10-in');
    });

    // B11
    test('B11: getEntriesByTag returns entries containing that tag', () async {
      await db.entryDao.insertEntry(
        Entry(entryId: 'b11-a', title: 'Coding task', startEpoch: 1000, tags: ['coding']),
      );
      await db.entryDao.insertEntry(
        Entry(entryId: 'b11-b', title: 'Meeting', startEpoch: 2000, tags: ['meeting']),
      );
      await db.entryDao.insertEntry(
        Entry(entryId: 'b11-c', title: 'Both', startEpoch: 3000, tags: ['coding', 'meeting']),
      );

      final codingEntries = await db.entryDao.getEntriesByTag('coding');
      expect(codingEntries.length, 2);
      expect(codingEntries.map((e) => e.entryId), containsAll(['b11-a', 'b11-c']));
    });

    // B12
    test('B12: getUncommittedEntries returns only entries where committed = false', () async {
      await db.entryDao.insertEntry(
        Entry(entryId: 'b12-pending', title: 'Pending', startEpoch: 1000, committed: false),
      );
      await db.entryDao.insertEntry(
        Entry(entryId: 'b12-done', title: 'Done', startEpoch: 2000, committed: true),
      );

      final pending = await db.entryDao.getUncommittedEntries();
      expect(pending.length, 1);
      expect(pending[0].entryId, 'b12-pending');
    });

    // ── Update ──────────────────────────────────────────────

    // B13
    test('B13: updateEntry modifies specified fields and bumps updated_at', () async {
      await db.entryDao.insertEntry(
        Entry(entryId: 'b13-edit', title: 'Original', startEpoch: 1000),
      );

      // Get original updated_at
      final before = await db.customSelect(
        'SELECT updated_at FROM entries WHERE entry_id = ?',
        variables: ['b13-edit'],
      ).getSingle();
      final beforeTs = before.read<int>('updated_at');

      // Wait a tiny bit so timestamps differ
      await Future.delayed(const Duration(milliseconds: 10));

      final updated = await db.entryDao.updateEntry('b13-edit', {
        'title': 'Updated',
        'end_epoch': 2000,
        'is_active': false,
      });
      expect(updated, isTrue);

      final after = await db.entryDao.getEntry('b13-edit');
      expect(after!.title, 'Updated');
      expect(after.endEpoch, 2000);
      expect(after.isActive, false);

      // Verify updated_at was bumped
      final afterRow = await db.customSelect(
        'SELECT updated_at FROM entries WHERE entry_id = ?',
        variables: ['b13-edit'],
      ).getSingle();
      expect(afterRow.read<int>('updated_at'), greaterThan(beforeTs));
    });

    // B14
    test('B14: updateEntry preserves unspecified fields', () async {
      await db.entryDao.insertEntry(Entry(
        entryId: 'b14-preserve',
        title: 'Original',
        startEpoch: 1000,
        tags: ['important'],
        deviceUuid: 'uuid-1',
      ));

      await db.entryDao.updateEntry('b14-preserve', {'title': 'New title'});

      final entry = await db.entryDao.getEntry('b14-preserve');
      expect(entry!.title, 'New title');
      expect(entry.tags, ['important']);
      expect(entry.deviceUuid, 'uuid-1');
    });

    // B15
    test('B15: updateEntry returns true when entry exists, false when not', () async {
      await db.entryDao.insertEntry(
        Entry(entryId: 'b15-exists', title: 'Exists', startEpoch: 1000),
      );
      final ok = await db.entryDao.updateEntry('b15-exists', {'title': 'Changed'});
      expect(ok, isTrue);

      final nok = await db.entryDao.updateEntry('b15-ghost', {'title': 'Ghost'});
      expect(nok, isFalse);
    });

    // ── Delete ──────────────────────────────────────────────

    // B16
    test('B16: deleteEntry removes the entry and returns count', () async {
      await db.entryDao.insertEntry(
        Entry(entryId: 'b16-del', title: 'Delete me', startEpoch: 1000),
      );
      final count = await db.entryDao.deleteEntry('b16-del');
      expect(count, 1);

      final found = await db.entryDao.getEntry('b16-del');
      expect(found, isNull);
    });

    // B17
    test('B17: deleteEntry returns 0 for non-existent entry', () async {
      final count = await db.entryDao.deleteEntry('ghost');
      expect(count, 0);
    });

    // B18
    test('B18: getEntryCount returns the total number of entries', () async {
      expect(await db.entryDao.getEntryCount(), 0);

      await db.entryDao.insertEntry(Entry(entryId: 'b18-a', title: 'A', startEpoch: 1000));
      await db.entryDao.insertEntry(Entry(entryId: 'b18-b', title: 'B', startEpoch: 2000));

      expect(await db.entryDao.getEntryCount(), 2);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Group C: EntryDao Edge Cases
  // ────────────────────────────────────────────────────────────

  group('C: EntryDao Edge Cases', () {
    late AppDatabase db;

    setUp(() async {
      db = await AppDatabase.inMemory();
    });

    tearDown(() async {
      await db.close();
    });

    // C1
    test('C1: insert entry with endEpoch = null stores NULL', () async {
      final entry = Entry(entryId: 'c1-null-end', title: 'Active', startEpoch: 1000);
      await db.entryDao.insertEntry(entry);

      final row = await db.customSelect(
        'SELECT end_epoch FROM entries WHERE entry_id = ?',
        variables: ['c1-null-end'],
      ).getSingle();
      expect(row.read<int?>('end_epoch'), isNull);
    });

    // C2
    test('C2: insert entry with empty tags list stores [] as JSON', () async {
      final entry = Entry(entryId: 'c2-empty-tags', title: 'No tags', startEpoch: 1000);
      await db.entryDao.insertEntry(entry);

      final row = await db.customSelect(
        'SELECT tags FROM entries WHERE entry_id = ?',
        variables: ['c2-empty-tags'],
      ).getSingle();
      expect(row.read<String>('tags'), '[]');
    });

    // C3
    test('C3: insert entry with empty pauses list stores [] as JSON', () async {
      final entry = Entry(entryId: 'c3-empty-pauses', title: 'No pauses', startEpoch: 1000);
      await db.entryDao.insertEntry(entry);

      final row = await db.customSelect(
        'SELECT pauses FROM entries WHERE entry_id = ?',
        variables: ['c3-empty-pauses'],
      ).getSingle();
      expect(row.read<String>('pauses'), '[]');
    });

    // C4
    test('C4: insert entry with many tags (50+) stores and retrieves correctly', () async {
      final manyTags = List.generate(55, (i) => 'tag-${i.toString().padLeft(2, '0')}');
      final entry = Entry(
        entryId: 'c4-many-tags',
        title: 'Many tags',
        startEpoch: 1000,
        tags: manyTags,
      );
      await db.entryDao.insertEntry(entry);

      final result = await db.entryDao.getEntry('c4-many-tags');
      expect(result!.tags.length, 55);
      expect(result.tags[0], 'tag-00');
      expect(result.tags[54], 'tag-54');
    });

    // C5
    test('C5: insert entry with complex pauses stores and retrieves correctly', () async {
      final pauses = [
        PauseRecord(startEpoch: 1100, endEpoch: 1200),
        PauseRecord(startEpoch: 1300, endEpoch: 1400),
        PauseRecord(startEpoch: 1500, endEpoch: 1550),
      ];
      final entry = Entry(
        entryId: 'c5-complex-pauses',
        title: 'Complex pauses',
        startEpoch: 1000,
        endEpoch: 2000,
        pauses: pauses,
      );
      await db.entryDao.insertEntry(entry);

      final result = await db.entryDao.getEntry('c5-complex-pauses');
      expect(result!.pauses.length, 3);
      expect(result.pauses[0].startEpoch, 1100);
      expect(result.pauses[0].endEpoch, 1200);
      expect(result.pauses[2].startEpoch, 1500);
      expect(result.pauses[2].endEpoch, 1550);
    });

    // C6
    test('C6: insert duplicate entry_id throws a constraint violation', () async {
      final entry = Entry(entryId: 'c6-dup', title: 'First', startEpoch: 1000);
      await db.entryDao.insertEntry(entry);

      final dup = Entry(entryId: 'c6-dup', title: 'Second', startEpoch: 2000);
      await expectLater(
        () => db.entryDao.insertEntry(dup),
        throwsA(isA<Exception>()),
      );
    });

    // C7
    test('C7: insert entry with very long title (10K+ chars) stores and retrieves', () async {
      final longTitle = 'A' * 12_000;
      final entry = Entry(entryId: 'c7-long', title: longTitle, startEpoch: 1000);
      await db.entryDao.insertEntry(entry);

      final result = await db.entryDao.getEntry('c7-long');
      expect(result!.title.length, 12_000);
      expect(result.title, longTitle);
    });

    // C8
    test('C8: insert entry with special characters stores and retrieves correctly', () async {
      const specialTitle = 'Test 🎉 — Unicode ñ á é î ø ü 汉字 "quotes" \'single\' <brackets>';
      final entry = Entry(entryId: 'c8-special', title: specialTitle, startEpoch: 1000);
      await db.entryDao.insertEntry(entry);

      final result = await db.entryDao.getEntry('c8-special');
      expect(result!.title, specialTitle);
    });
  });
}
