import 'dart:convert';

import '../storage/database.dart';
import '../storage/row.dart';

/// Row-per-activity SQLite staging store.
///
/// Replaces the monolithic `entries` JSON-array blob with a proper
/// relational table matching phpoc-web's `RowStagingStore`.
///
/// Schema:
///   activity_id     TEXT PRIMARY KEY  — 10-char CSPRNG ID
///   activity_status TEXT NOT NULL     — "active" / "paused" / "ended"
///   activity        TEXT NOT NULL     — JSON-encoded encrypted entry data
///   updated_at      INTEGER NOT NULL  — epoch ms, LWW tiebreaker
///   extra_json      TEXT NOT NULL     — JSON blob for forward-compat fields
class StagingStore {
  final AppDatabase _db;
  bool _tableEnsured = false;

  StagingStore(this._db);

  void _ensureTable() {
    if (_tableEnsured) return;
    _tableEnsured = true;
    _db.customStatement('''
      CREATE TABLE IF NOT EXISTS staging (
        activity_id     TEXT PRIMARY KEY,
        activity_status TEXT NOT NULL,
        activity        TEXT NOT NULL,
        updated_at      INTEGER NOT NULL,
        extra_json      TEXT NOT NULL DEFAULT '{}'
      )
    ''');
    // Index for status-filtered queries
    try {
      _db.customStatement(
        'CREATE INDEX IF NOT EXISTS idx_staging_status ON staging(activity_status)',
      );
    } catch (_) {}
    try {
      _db.customStatement(
        'CREATE INDEX IF NOT EXISTS idx_staging_updated ON staging(updated_at)',
      );
    } catch (_) {}
  }

  // ── Row helpers ────────────────────────────────────────────

  /// Reconstruct a full row map from core columns + extra_json.
  Map<String, dynamic> _rowToMap(dynamic row) {
    final map = <String, dynamic>{
      'activity_id': _readColumn(row, 'activity_id', ''),
      'activity_status': _readColumn(row, 'activity_status', 'active'),
      'activity': _readColumn(row, 'activity', '{}'),
      'updated_at': _readColumn(row, 'updated_at', 0),
    };
    final extraJson = _readColumn<String?>(row, 'extra_json', null);
    final extra = safeJsonDecode(extraJson) ?? {};
    map.addAll(Map<String, dynamic>.from(extra));
    return map;
  }

  /// Read a column from a Row or Map, with a default fallback.
  /// When [defaultValue] is null, the return type is nullable.
  static T _readColumn<T>(dynamic row, String column, T defaultValue) {
    if (row is Row) {
      try {
        return row.read<T>(column);
      } catch (_) {
        return defaultValue;
      }
    }
    if (row is Map) {
      final val = row[column];
      if (val is T) return val;
      return defaultValue;
    }
    return defaultValue;
  }

  /// Extract core fields + pack extras into extra_json.
  Map<String, dynamic> _mapToRow(Map<String, dynamic> input) {
    final extra = <String, dynamic>{};
    for (final entry in input.entries) {
      if (entry.key == 'activity_id' ||
          entry.key == 'activity_status' ||
          entry.key == 'activity' ||
          entry.key == 'updated_at') {
        continue;
      }
      extra[entry.key] = entry.value;
    }
    return {
      'activity_id': input['activity_id'],
      'activity_status': input['activity_status'],
      'activity': input['activity'],
      'updated_at': input['updated_at'],
      'extra_json': json.encode(extra),
    };
  }

  // ── CRUD ───────────────────────────────────────────────────

  /// Store a row. Upserts on activity_id conflict.
  ///
  /// When [preserveUpdatedAt] is true, the row's existing [updated_at]
  /// value is kept unchanged (used during merge operations where the
  /// original timestamp is the LWW tiebreaker).
  Future<void> putRow(Map<String, dynamic> row,
      {bool preserveUpdatedAt = false}) async {
    _ensureTable();
    final now = DateTime.now().millisecondsSinceEpoch;

    // Bump updated_at unless preserveUpdatedAt is set (merge operations)
    final mutable = Map<String, dynamic>.from(row);
    if (!preserveUpdatedAt) {
      mutable['updated_at'] = now;
    }
    if (!mutable.containsKey('activity_status')) {
      mutable['activity_status'] = 'active';
    }
    if (!mutable.containsKey('activity')) {
      mutable['activity'] = '{}';
    }

    final packed = _mapToRow(mutable);
    _db.customStatement(
      'INSERT OR REPLACE INTO staging '
      '(activity_id, activity_status, activity, updated_at, extra_json) '
      'VALUES (?, ?, ?, ?, ?)',
      [
        packed['activity_id'],
        packed['activity_status'],
        packed['activity'],
        packed['updated_at'],
        packed['extra_json'],
      ],
    );
  }

  /// Retrieve a row by activity_id. Returns null if not found.
  Future<Map<String, dynamic>?> getRow(String activityId) async {
    _ensureTable();
    final rows = _db.customSelect(
      'SELECT * FROM staging WHERE activity_id = ?',
      variables: <Object?>[activityId],
    ).get();
    if (rows.isEmpty) return null;
    return _rowToMap(rows.first);
  }

  /// Delete a row by activity_id. Idempotent — never throws.
  Future<void> deleteRow(String activityId) async {
    _ensureTable();
    _db.customStatement(
      'DELETE FROM staging WHERE activity_id = ?',
      [activityId],
    );
  }

  /// Return all rows sorted by activity_id ascending.
  Future<List<Map<String, dynamic>>> getAllRows() async {
    _ensureTable();
    final rows = _db.customSelect(
      'SELECT * FROM staging ORDER BY activity_id ASC',
    ).get();
    return rows.map(_rowToMap).toList();
  }

  /// Return rows filtered by activity_status.
  Future<List<Map<String, dynamic>>> getRowsByStatus(String status) async {
    _ensureTable();
    final rows = _db.customSelect(
      'SELECT * FROM staging WHERE activity_status = ? ORDER BY activity_id ASC',
      variables: <Object?>[status],
    ).get();
    return rows.map(_rowToMap).toList();
  }

  /// Return the number of rows in the staging table.
  Future<int> count() async {
    _ensureTable();
    final rows = _db.customSelect('SELECT COUNT(*) AS cnt FROM staging').get();
    if (rows.isEmpty) return 0;
    // The row is a Row object; access by column name or index
    try {
      return rows.first.read<int>('cnt');
    } catch (_) {
      // Fallback: try index 0
      final map = Map<String, dynamic>.from(rows.first as Map);
      return map['cnt'] as int? ?? map.values.first as int? ?? 0;
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  /// Decode a JSON string to a Map, returning null on any failure.
  static Map<String, dynamic>? safeJsonDecode(String? str) {
    if (str == null || str.isEmpty) return null;
    try {
      final d = json.decode(str);
      if (d is Map<String, dynamic>) return d;
      return null;
    } catch (_) {
      return null;
    }
  }
}
