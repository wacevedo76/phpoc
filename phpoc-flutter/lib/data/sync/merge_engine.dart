import '../../core/models/entry.dart';

/// Cross-device entry merge — dedup by entry_id.
///
/// Port of web src/sync/merge_engine.js.
///
/// Uses entry_id as the primary dedup key (stable UUID per entry).
/// Falls back to (title, start_epoch) for backward compatibility with
/// entries created before the entry_id convention existed.
///
/// When the same entry_id exists in both local and remote, remote wins —
/// it represents the more recent state.
///
/// Pure function: no I/O, no side effects, no external dependencies.
class MergeEngine {
  /// Merge local and remote staging entries. Returns the merged list
  /// deduplicated by entry_id (or title+start_epoch fallback), remote
  /// winning on ties, sorted by start_epoch ascending.
  ///
  /// The [committed] flag is preserved: if either local or remote has
  /// committed=true, the merged entry keeps committed=true. Once an
  /// entry is committed, it cannot be downgraded by a stale remote.
  static List<Entry> merge(List<Entry> local, List<Entry> remote) {
    final seen = <String, Entry>{};
    final committedFlags = <String, bool>{};

    for (final entry in local) {
      final key = _dedupKey(entry);
      seen[key] = entry;
      committedFlags[key] = entry.committed;
    }

    for (final entry in remote) {
      final key = _dedupKey(entry);
      final wasCommitted = committedFlags[key] ?? false;
      final mergedCommitted = wasCommitted || entry.committed;

      seen[key] = entry.copyWith(committed: mergedCommitted);
      committedFlags[key] = mergedCommitted;
    }

    final result = seen.values.toList();
    result.sort((a, b) => a.startEpoch.compareTo(b.startEpoch));
    return result;
  }

  /// Merge two lists of entry maps (DTOs from [LocalCache]).
  /// Same dedup and committed-preservation rules as [merge], but
  /// operating on raw maps instead of [Entry] objects. Sorted by
  /// start_epoch ascending.
  static List<Map<String, dynamic>> mergeMaps(
    List<Map<String, dynamic>> local,
    List<Map<String, dynamic>> remote,
  ) {
    final seen = <String, Map<String, dynamic>>{};

    for (final entry in local) {
      seen[_mapDedupKey(entry)] = entry;
    }

    for (final entry in remote) {
      final key = _mapDedupKey(entry);
      final wasCommitted = seen[key]?['committed'] == true;
      seen[key] = Map<String, dynamic>.from(entry);
      if (wasCommitted) {
        seen[key]!['committed'] = true;
      }
    }

    final result = seen.values.toList();
    result.sort((a, b) {
      final sa = a['start_epoch'] as int? ?? 0;
      final sb = b['start_epoch'] as int? ?? 0;
      return sa.compareTo(sb);
    });
    return result;
  }

  /// Dedup key for an [Entry] object.
  /// Primary: entry_id (stable UUID). Fallback: (title, start_epoch).
  static String _dedupKey(Entry entry) {
    if (entry.entryId.isNotEmpty) {
      return 'id:${entry.entryId}';
    }
    return 'fallback:${entry.title}:${entry.startEpoch}';
  }

  /// Dedup key for a raw entry map.
  /// Primary: entry_id. Fallback: (title, start_epoch).
  static String _mapDedupKey(Map<String, dynamic> entry) {
    final id = entry['entry_id'] as String?;
    if (id != null && id.isNotEmpty) return 'id:$id';
    return 'fallback:${entry['title'] ?? ''}:${entry['start_epoch'] ?? 0}';
  }
}
