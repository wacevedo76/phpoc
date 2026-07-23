import 'dart:convert';

import 'package:phpoc_flutter/core/crypto/crypto_service.dart';

/// Blind index manager — plaintext query interface, encrypted at rest.
///
/// Index structure: `{date: {title: total_ms}}`
///
/// When [crypto] is provided, the index is encrypted at rest as `{_enc: ciphertext}`.
/// When [crypto] is null, the index is stored as plaintext JSON.
class IndexManager {
  final dynamic store;
  final CryptoService? crypto;

  Map<String, Map<String, int>> _cache = {};

  IndexManager({required this.store, this.crypto}) {
    _load();
  }

  /// Update the index by adding/subtracting [duration] for [title] on [date].
  void update(String date, String title, int duration) {
    if (duration == 0) return;

    final dateMap = _cache[date] ?? <String, int>{};
    final current = dateMap[title] ?? 0;
    final newTotal = current + duration;

    if (newTotal <= 0) {
      dateMap.remove(title);
      if (dateMap.isEmpty) {
        _cache.remove(date);
      } else {
        _cache[date] = dateMap;
      }
    } else {
      dateMap[title] = newTotal;
      _cache[date] = dateMap;
    }

    _flush();
  }

  /// Aggregate durations by title across [from]..[to] date range (inclusive).
  Map<String, int> query(String from, String to) {
    final result = <String, int>{};

    // Handle inverted range
    if (from.compareTo(to) > 0) return result;

    for (final date in _cache.keys) {
      if (date.compareTo(from) >= 0 && date.compareTo(to) <= 0) {
        final dateMap = _cache[date]!;
        for (final title in dateMap.keys) {
          result[title] = (result[title] ?? 0) + dateMap[title]!;
        }
      }
    }

    return result;
  }

  /// Return a deep copy of the entire index.
  Map<String, dynamic> getAll() {
    final copy = <String, dynamic>{};
    for (final date in _cache.keys) {
      copy[date] = Map<String, int>.from(_cache[date]!);
    }
    return copy;
  }

  /// Clear all index data and persist.
  void clear() {
    _cache = {};
    _flush();
  }

  /// Reload from the store, discarding any in-memory changes.
  void reload() {
    _load();
  }

  // ── Internal ───────────────────────────────────────────────────

  void _load() {
    final stored = store.readIndex();

    if (stored == null) {
      _cache = {};
      return;
    }

    if (crypto != null && crypto!.hasMasterKey) {
      // Try encrypted format: {_enc: ciphertext}
      if (stored is Map && stored.containsKey('_enc')) {
        try {
          final plaintext = crypto!.decryptWithCachedKey(stored['_enc'] as String);
          final decoded = jsonDecode(plaintext) as Map<String, dynamic>;
          _cache = _parseIndex(decoded);
          return;
        } catch (_) {
          // Decryption failed — fall through to empty
          _cache = {};
          return;
        }
      }
    }

    // Legacy plaintext format or no crypto
    if (stored is Map) {
      _cache = _parseIndex(Map<String, dynamic>.from(stored));
    } else {
      _cache = {};
    }
  }

  Map<String, Map<String, int>> _parseIndex(Map<String, dynamic> raw) {
    final parsed = <String, Map<String, int>>{};
    for (final date in raw.keys) {
      final dateMap = raw[date];
      if (dateMap is Map) {
        final titleMap = <String, int>{};
        for (final title in dateMap.keys) {
          final val = dateMap[title];
          if (val is int) {
            titleMap[title] = val;
          } else if (val is num) {
            titleMap[title] = val.toInt();
          }
        }
        if (titleMap.isNotEmpty) {
          parsed[date] = titleMap;
        }
      }
    }
    return parsed;
  }

  void _flush() {
    if (crypto != null && crypto!.hasMasterKey) {
      final plaintext = jsonEncode(_cache);
      final ciphertext = crypto!.encryptWithCachedKey(plaintext);
      store.writeIndex({'_enc': ciphertext});
    } else {
      // Plaintext format
      if (_cache.isEmpty) {
        store.writeIndex(null);
      } else {
        store.writeIndex(_cache);
      }
    }
  }
}
