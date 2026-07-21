import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'database.dart';

/// Singleton [AppDatabase] instance, using in-memory SQLite.
///
/// Disposed on provider disposal (not typical in app lifecycle — the DB
/// lives for the process duration, but this enables clean test teardown).
final databaseProvider = Provider<AppDatabase>((ref) {
  final db = AppDatabase.inMemory();
  ref.onDispose(() => db.close());
  return db;
});

/// Convenience provider for [EntryDao].
final entryDaoProvider = Provider<EntryDao>((ref) {
  return ref.watch(databaseProvider).entryDao;
});

/// Convenience provider for [BlockDao].
final blockDaoProvider = Provider<BlockDao>((ref) {
  return ref.watch(databaseProvider).blockDao;
});
