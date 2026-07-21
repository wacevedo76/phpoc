import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/providers.dart';

/// Database Provider tests — Group J (5 assertions).
///
/// Covers:
///   J1–J5: Riverpod provider wiring, singleton, DAO providers, disposal

void main() {
  group('J: Database Provider (Riverpod)', () {
    // J1
    test('J1: databaseProvider returns an AppDatabase instance', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final db = container.read(databaseProvider);
      expect(db, isA<AppDatabase>());
      await db.close();
    });

    // J2
    test('J2: databaseProvider is a singleton (same instance on repeated reads)', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final db1 = container.read(databaseProvider);
      final db2 = container.read(databaseProvider);

      expect(identical(db1, db2), isTrue,
        reason: 'databaseProvider must return the same instance');
      await db1.close();
    });

    // J3
    test('J3: entryDaoProvider returns EntryDao from the database', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final entryDao = container.read(entryDaoProvider);
      expect(entryDao, isNotNull);

      // Should be able to perform operations
      final count = await entryDao.getEntryCount();
      expect(count, 0);

      final db = container.read(databaseProvider);
      await db.close();
    });

    // J4
    test('J4: blockDaoProvider returns BlockDao from the database', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      final blockDao = container.read(blockDaoProvider);
      expect(blockDao, isNotNull);

      // Should be able to perform operations
      final count = await blockDao.getBlockCount();
      expect(count, 0);

      final db = container.read(databaseProvider);
      await db.close();
    });

    // J5
    test('J5: database can be closed via provider disposal', () async {
      final container = ProviderContainer();
      final db = container.read(databaseProvider);
      expect(db.isOpen, isTrue);

      // Disposing the container should close the database
      container.dispose();

      // After dispose, the database should be closed
      // (we check via the autoDispose mechanism)
      expect(db.isOpen, isFalse);
    });
  });
}
