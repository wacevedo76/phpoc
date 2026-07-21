import 'dart:convert';

/// Deterministic JSON serialization matching Python's json.dumps(sort_keys=True).
///
/// Mirrors web's `ledger/utils.js` — jsonSort and jsonSortIndent2.
/// Byte-for-byte compatibility is critical for content hash verification
/// across platforms.
///
/// Key behaviors matched to web:
///   - Keys sorted alphabetically at every nesting level
///   - Array elements preserved in original order (not sorted)
///   - ":" and "," separator spacing matches Python exactly
///   - Null values preserved (serialized as JSON null)
///   - null → "null", booleans → "true"/"false"

/// Deterministic compact JSON with sorted keys.
/// Matches Python's json.dumps(obj, sort_keys=True).
String jsonSort(dynamic data) {
  return _jsonDumps(data);
}

/// Deterministic pretty-printed JSON with sorted keys and 2-space indent.
/// Matches Python's json.dumps(obj, sort_keys=True, indent=2).
String jsonSortIndent2(dynamic data) {
  return _jsonDumpsIndent(data, 0);
}

// ── Leaf values ───────────────────────────────────────────────

/// Format a non-collection value as its JSON literal.
String _primitive(dynamic obj) {
  if (obj == null) return 'null';
  if (obj is bool) return obj ? 'true' : 'false';
  if (obj is num) return obj.toString();
  if (obj is String) return json.encode(obj);
  return json.encode(obj);
}

// ── Compact (no indent) ───────────────────────────────────────

String _jsonDumps(dynamic obj) {
  if (obj is List) {
    final items = obj.map((v) => _jsonDumps(v));
    return '[${items.join(', ')}]';
  }
  if (obj is Map) {
    final keys = obj.keys.toList()..sort();
    final pairs = <String>[];
    for (final k in keys) {
      final v = obj[k];
      if (v != null || obj.containsKey(k)) {
        pairs.add('${json.encode(k)}: ${_jsonDumps(v)}');
      }
    }
    return '{${pairs.join(', ')}}';
  }
  return _primitive(obj);
}

// ── Indented (2-space) ────────────────────────────────────────

String _jsonDumpsIndent(dynamic obj, int depth) {
  final indent = '  ' * (depth + 1);
  final outerIndent = depth > 0 ? '  ' * depth : '';
  if (obj is List) {
    if (obj.isEmpty) return '[]';
    final items = obj.map((v) => '$indent${_jsonDumpsIndent(v, depth + 1)}');
    return '[\n${items.join(',\n')}\n$outerIndent]';
  }
  if (obj is Map) {
    final keys = obj.keys.toList()..sort();
    final pairs = <String>[];
    for (final k in keys) {
      final v = obj[k];
      if (v != null || obj.containsKey(k)) {
        pairs.add('$indent${json.encode(k)}: ${_jsonDumpsIndent(v, depth + 1)}');
      }
    }
    if (pairs.isEmpty) return '{}';
    return '{\n${pairs.join(',\n')}\n$outerIndent}';
  }
  return _primitive(obj);
}
