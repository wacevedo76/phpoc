/// Lightweight row wrapper for SQL query results.
///
/// Provides typed column access via [read<T>].
class Row {
  final Map<String, Object?> _data;
  Row(this._data);

  /// Returns the column value for [key] cast to [T].
  ///
  /// Throws [StateError] if the value is null and [T] is non-nullable.
  T read<T>(String key) {
    final val = _data[key];
    if (val == null) {
      if (_nullable<T>()) return null as T;
      throw StateError('Column "$key" is null but $T was requested');
    }
    if (T == int && val is int) return val as T;
    if (T == String && val is String) return val as T;
    if (T == double && val is double) return val as T;
    if (T == bool) {
      if (val is int) return (val == 1) as T;
      if (val is bool) return val as T;
    }
    return val as T;
  }

  /// True when [T] is a nullable type (e.g., `int?`, `String?`).
  static bool _nullable<T>() => null is T;
}

/// Result wrapper for [Row] lists, matching a simple .get() / .getSingle() API.
class SelectResult {
  final List<Row> _rows;
  SelectResult(this._rows);

  List<Row> get() => _rows;

  Row getSingle() {
    if (_rows.isEmpty) throw StateError('No rows returned');
    return _rows.first;
  }
}
