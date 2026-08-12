import 'dart:convert';

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

  /// Dedup key: primary `entry_id`, fallback `(title, start_epoch)`.
  static String _makeKey(String? entryId, String? title, int? startEpoch) {
    if (entryId != null && entryId.isNotEmpty) return 'id:$entryId';
    return 'fallback:${title ?? ''}:${startEpoch ?? 0}';
  }

  static String _dedupKey(Entry entry) =>
      _makeKey(entry.entryId, entry.title, entry.startEpoch);

  static String _mapDedupKey(Map<String, dynamic> entry) => _makeKey(
        entry['entry_id'] as String?,
        entry['title'] as String?,
        entry['start_epoch'] as int?,
      );

  // ═══════════════════════════════════════════════════════════════
  // Activity-ID-based LWW merge (row-level staging overhaul)
  // ═══════════════════════════════════════════════════════════════

  /// Merge local and remote staging rows by activity_id with LWW on updated_at.
  ///
  /// Rules:
  ///   - Same activity_id in both → newer `updated_at` wins (local on tie)
  ///   - Committed flag is irreversible: if either side is committed,
  ///     the merged entry stays committed
  ///   - Remote-only → added to result
  ///   - Local-only → kept in result (committed or not; Sync tab filter
  ///     handles exclusion, History/Dashboard needs them for display)
  static List<Map<String, dynamic>> mergeEntries(
    List<Map<String, dynamic>> local,
    List<Map<String, dynamic>> remote,
  ) {
    final result = <String, Map<String, dynamic>>{};

    // Index local by activity_id
    final localById = <String, Map<String, dynamic>>{};
    for (final entry in local) {
      final id = entry['activity_id'] as String?;
      if (id != null) localById[id] = entry;
    }

    // Process remote entries first
    for (final entry in remote) {
      final id = entry['activity_id'] as String?;
      if (id == null) continue;

      final localEntry = localById[id];
      if (localEntry != null) {
        // Both have it — LWW on updated_at.
        // Committed flag is irreversible: if either side is committed,
        // the merged entry must stay committed (ledger-aware cleanup).
        final localCommitted = _isCommitted(localEntry);
        final remoteCommitted = _isCommitted(entry);
        final localTs = localEntry['updated_at'] as int? ?? 0;
        final remoteTs = entry['updated_at'] as int? ?? 0;
        if (remoteTs > localTs) {
          final winner = Map<String, dynamic>.from(entry);
          if (localCommitted || remoteCommitted) {
            winner['committed'] = true;
          }
          result[id] = winner;
        } else {
          final winner = Map<String, dynamic>.from(localEntry);
          if (localCommitted || remoteCommitted) {
            winner['committed'] = true;
          }
          result[id] = winner;
        }
      } else {
        // Remote-only row → include in result
        result[id] = Map<String, dynamic>.from(entry);
      }
    }

    // Process local-only entries — keep all, committed or not.
    // The Sync tab filters by committed flag; History/Dashboard
    // reads committed entries for display.
    for (final id in localById.keys) {
      if (result.containsKey(id)) continue; // already handled
      final entry = Map<String, dynamic>.from(localById[id]!);
      // Ensure row-level committed flag exists when activity blob has it
      if (_isCommitted(entry) && entry['committed'] != true) {
        entry['committed'] = true;
      }
      result[id] = entry;
    }

    return result.values.toList();
  }

  /// Drop local-only staging rows that are already committed in the local
  /// ledger (ADR-030 Scenario-5/6 cleanup).
  ///
  /// A row is removed from the result only when its [activity_id] is present
  /// in [ledgerActivityIds] (i.e. the activity was sealed into a ledger block).
  /// Rows not recorded in the ledger are kept so they can be pushed as
  /// scratchpad. This is the "ledger-aware" counterpart to [mergeEntries].
  ///
  /// NOTE: this is currently exercised only at the unit level (L3 tests). It
  /// is NOT yet wired into [SyncService]'s handoff reconcile — the caller must
  /// supply [ledgerActivityIds] built from the local ledger (e.g.
  /// `LedgerEngine.getAllBlocks()`).
  static List<Map<String, dynamic>> dropLedgerCommitted(
    List<Map<String, dynamic>> local,
    Set<String> ledgerActivityIds,
  ) {
    if (ledgerActivityIds.isEmpty) {
      return List<Map<String, dynamic>>.from(local);
    }
    return local
        .where((r) => !ledgerActivityIds.contains(r['activity_id']))
        .toList();
  }

  /// Check whether a staging row is committed.
  ///
  /// Checks the row-level `committed` field first, then falls back to
  /// the `committed` flag inside the `activity` JSON blob. This ensures
  /// entries seeded from ledger blocks by [LedgerPullService] are
  /// recognised as committed even when only the activity blob carries
  /// the flag.
  static bool _isCommitted(Map<String, dynamic> row) {
    // Row-level flag (canonical) — set by putRow for ledger-seeded entries
    if (row['committed'] == true) return true;

    // Fallback: activity JSON blob (entries seeded before row-level fix)
    try {
      final activityStr = row['activity'] as String?;
      if (activityStr != null) {
        final activity = jsonDecode(activityStr);
        if (activity is Map && activity['committed'] == true) return true;
      }
    } catch (_) {}

    return false;
  }
}
