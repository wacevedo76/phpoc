import 'dart:convert';

import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/utils/hash_utils.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';

/// Ledger helper functions — block hash resolution, entry/content hashing.
///
/// Must match Python `domain/ledger/helpers.py` and JS `ledger/utils.js`
/// byte-for-byte for cross-platform compatibility.

/// Return the hash for a block based on its type.
///
/// Resolution order:
///   genesis → block_hash, fallback day_hash (legacy pre-I-17)
///   day → day_hash
///   month_summary → month_hash
///   year_summary → year_hash
///   unknown → ""
String getBlockHash(Map<String, dynamic> block) {
  final type = block['type'] as String?;

  if (type == 'genesis') {
    if (block.containsKey('block_hash')) {
      return block['block_hash'] as String;
    }
    // Legacy fallback: pre-I-17 genesis blocks use day_hash
    if (block.containsKey('day_hash')) {
      return block['day_hash'] as String;
    }
    return '';
  }

  switch (type) {
    case 'day':
      return block['day_hash'] as String? ?? '';
    case 'month_summary':
      return block['month_hash'] as String? ?? '';
    case 'year_summary':
      return block['year_hash'] as String? ?? '';
    default:
      return '';
  }
}

/// Compute a deterministic SHA-256 entry hash from sort_keys+indent=2 JSON.
///
/// Matches Python `helpers.py` `compute_entry_hash`:
///   sha256(json.dumps(data, sort_keys=True, indent=2))
String computeEntryHash(Map<String, dynamic> data) {
  final canon = jsonSortIndent2(data);
  return sha256(canon);
}

/// Verify an entry hash against canonical (indent2) AND legacy formats.
///
/// Tries all four serialization formats in order, matching the
/// Python/JS _verify_entry_hash_flex / 3-way fallback pattern:
///  1. sort+indent2 (canonical: jsonSortIndent2)
///  2. sort+compact with spaces (Python-compatible: jsonSort)
///  3. sort+compact no spaces (JS-compatible: jsonEncodeSortedNoSpaces)
///  4. nosort+indent2 (legacy web: JsonEncoder.withIndent, unsorted keys)
bool verifyEntryHashTwoWay(Map<String, dynamic> data, String expectedHash) {
  // Canonical: sort_keys + indent=2
  if (computeEntryHash(data) == expectedHash) return true;

  // Legacy fallback 1: sorted keys, compact with spaces (Python default)
  final compactJson = jsonSort(data);
  if (sha256(compactJson) == expectedHash) return true;

  // Legacy fallback 2: sorted keys, no-separator-spaces (JS compact)
  final noSpaceJson = jsonEncodeSortedNoSpaces(data);
  if (sha256(noSpaceJson) == expectedHash) return true;

  // Legacy fallback 3: unsorted keys, 2-space indent
  // (pre-entry-hash-consolidation web: JSON.stringify(obj, null, 2))
  final unsortedIndentJson = const JsonEncoder.withIndent('  ').convert(data);
  if (sha256(unsortedIndentJson) == expectedHash) return true;

  return false;
}

/// Encode map as JSON with sorted keys and no separator spaces.
/// Used by both entry hash verification and block seal verification.
String jsonEncodeSortedNoSpaces(Map<String, dynamic> data) {
  final sortedKeys = data.keys.toList()..sort();
  final pairs = <String>[];
  for (final key in sortedKeys) {
    final value = encodeValueNoSpaces(data[key]);
    pairs.add('${jsonEncode(key)}:$value');
  }
  return '{${pairs.join(',')}}';
}

/// Encode a value without separator spaces.
String encodeValueNoSpaces(dynamic value) {
  if (value == null) return 'null';
  if (value is bool) return value ? 'true' : 'false';
  if (value is num) return value.toString();
  if (value is String) return jsonEncode(value);
  if (value is List) {
    final items = value.map((v) => encodeValueNoSpaces(v));
    return '[${items.join(',')}]';
  }
  if (value is Map) {
    final keys = value.keys.toList()..sort();
    final pairs = <String>[];
    for (final k in keys) {
      pairs.add('${jsonEncode(k)}:${encodeValueNoSpaces(value[k])}');
    }
    return '{${pairs.join(',')}}';
  }
  return value.toString();
}

/// Compute the extensible content hash for an entry.
///
/// Skips `content_hash` itself (avoid circular dependency).
/// Algorithm:
/// 1. For each field with _enc suffix: strip suffix, decrypt value, parse JSON if possible
/// 2. Sort lists for deterministic ordering
/// 3. Skip content_hash field
/// 4. SHA-256 of canonical JSON (compact, sort_keys=True)
String computeContentHash(Map<String, dynamic> data, CryptoService crypto) {
  final canonical = _buildCanonicalMap(data, (ciphertext) {
    return crypto.decryptWithCachedKey(ciphertext);
  });

  // Remove content_hash to avoid circular dependency
  canonical.remove('content_hash');

  final jsonStr = jsonSort(canonical);
  return sha256(jsonStr);
}

/// Verify the content hash using an extensible multi-algorithm approach.
///
/// Mirrors Python `_verify_content_hash`, which accepts BOTH the v0.4.0+
/// format (strips the `_enc` suffix from decrypted fields) AND the older
/// extensible format (KEEPS the `_enc` suffix on decrypted fields — the
/// format the Web client emits via `_computeContentHash`). Flutter's
/// `computeContentHash` emits the stripped form; accepting the kept form here
/// is what makes a Web-rekeyed chain verify on Flutter (cross-client).
///
/// [decryptFn] decrypts a ciphertext string and returns plaintext.
bool verifyContentHash(
  Map<String, dynamic> data,
  String expectedHash, {
  required String Function(String) decryptFn,
}) {
  // 1. v0.4.0+ canonical: strip `_enc` suffix, compact jsonSort.
  final extensibleCanonical = _buildCanonicalMap(data, decryptFn);
  extensibleCanonical.remove('content_hash');
  if (sha256(jsonSort(extensibleCanonical)) == expectedHash) return true;

  // 2. Legacy extensible (Web/Python `content_legacy_ext`): KEEP the `_enc`
  //    suffix on decrypted fields, compact jsonSort.
  final keptSuffix = _buildCanonicalMap(data, decryptFn, keepEncSuffix: true);
  keptSuffix.remove('content_hash');
  if (sha256(jsonSort(keptSuffix)) == expectedHash) return true;

  // 3. Legacy indent=2 fallback (stripped form).
  final legacyCanonical = _buildCanonicalMap(data, decryptFn);
  legacyCanonical.remove('content_hash');
  if (sha256(jsonSortIndent2(legacyCanonical)) == expectedHash) return true;

  return false;
}

/// Build canonical map for the extensible algorithm (v0.4.0+).
///
/// When [keepEncSuffix] is true the `_enc` suffix is RETAINED on decrypted
/// fields (the Web/Python legacy-extensible format); otherwise it is stripped
/// (the v0.4.0+ Flutter format).
Map<String, dynamic> _buildCanonicalMap(
  Map<String, dynamic> data,
  String Function(String) decryptFn, {
  bool keepEncSuffix = false,
}) {
  final canonical = <String, dynamic>{};

  for (final entry in data.entries) {
    var key = entry.key;
    var value = entry.value;

    if (key.endsWith('_enc')) {
      if (!keepEncSuffix) {
        key = key.substring(0, key.length - 4);
      }
      if (value is String && value.isNotEmpty) {
        try {
          final decrypted = decryptFn(value);
          // Canonical cross-client behavior: keep the decrypted plaintext as
          // a STRING (JSON-encoding it verbatim), matching Python
          // `_verify_content_hash` / migrator `_compute_content_hash` and Web
          // `_verifyContentHash`. Do NOT jsonDecode (that would turn `"{}"` into
          // an empty map and change the canonical JSON bytes → a divergent
          // content_hash, failing cross-client verification on a migrated
          // ledger). Sort lists afterward so list fields hash deterministically.
          value = decrypted;
        } catch (_) {
          // Decryption failed — keep raw value
        }
      }
    }

    if (value is List) {
      value = _sortListValues(value);
    }

    canonical[key] = value;
  }

  return canonical;
}

/// Sort a list's values for deterministic hashing.
List<dynamic> _sortListValues(List<dynamic> list) {
  final sorted = List<dynamic>.from(list);
  try {
    sorted.sort((a, b) => a.toString().compareTo(b.toString()));
  } catch (_) {
    // If sorting fails, return unsorted
  }
  return sorted;
}

/// Compare two dotted version strings (e.g., "0.4.0" vs "0.3.0").
/// Returns <0 if a < b, 0 if equal, >0 if a > b.
int compareVersions(String a, String b) {
  final aParts = a.split('.').map(int.parse).toList();
  final bParts = b.split('.').map(int.parse).toList();
  for (var i = 0; i < aParts.length && i < bParts.length; i++) {
    final cmp = aParts[i].compareTo(bParts[i]);
    if (cmp != 0) return cmp;
  }
  return aParts.length.compareTo(bParts.length);
}

/// Convert epoch milliseconds to YYYY-MM-DD UTC date string.
String epochToDate(int epochMs) {
  final dt = DateTime.fromMillisecondsSinceEpoch(epochMs, isUtc: true);
  return '${dt.year}-${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}';
}

/// Convert a UTF-8 secret string to its lowercase hex representation.
/// Returns null if [secret] is null.
String? secretToHex(String? secret) {
  if (secret == null) return null;
  return secret.codeUnits
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();
}
