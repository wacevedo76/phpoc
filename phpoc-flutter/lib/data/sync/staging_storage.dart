import 'dart:convert';

import '../../data/storage/database.dart';

/// SQLite-backed staging storage adapter for [LocalCache].
///
/// Provides the same `get(key)` / `set(key, value)` interface that
/// LocalCache expects, but persists to the app database instead of
/// an in-memory map.
///
/// Stores data in the `_staging_kv` table:
///   - `entries`    — List of raw entry maps (JSON blob)
///   - `cookie`     — Device cookie map (JSON blob)
///   - `staging_hash_index` — Hash index list (JSON blob)
class StagingStorage {
  final AppDatabase _db;

  StagingStorage(this._db) {
    _ensureTable();
  }

  // ── Key-Value table ────────────────────────────────────────

  void _ensureTable() {
    _db.customStatement('''
      CREATE TABLE IF NOT EXISTS _staging_kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    ''');
  }

  // ── Public API (matches _InMemoryStorage contract) ─────────

  Future<dynamic> get(String key) async {
    final rows = _db.customSelect(
      'SELECT value FROM _staging_kv WHERE key = ?',
      variables: <Object?>[key],
    ).get();
    if (rows.isEmpty) return null;
    try {
      return json.decode(rows.first.read<String>('value'));
    } catch (_) {
      return null;
    }
  }

  Future<void> set(String key, dynamic value) async {
    final jsonStr = json.encode(value);
    // UPSERT: insert or replace
    _db.customStatement(
      'INSERT OR REPLACE INTO _staging_kv (key, value) VALUES (?, ?)',
      [key, jsonStr],
    );
  }

  Future<void> remove(String key) async {
    _db.customStatement('DELETE FROM _staging_kv WHERE key = ?', [key]);
  }
}
