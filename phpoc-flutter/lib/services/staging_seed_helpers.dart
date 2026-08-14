import 'dart:convert';

import '../core/utils/id_utils.dart';

/// Shared dedup + identity logic for the two ledger→staging re-seed paths
/// (`LedgerPullService._seedStagingFromBlocks` and
/// `OnboardingService._seedStagingFromImportedBlocks`).
///
/// Both previously deduped only by a block entry's `entry_id`/`hash`, but
/// `LedgerEngine._prepareEntries` strips those before sealing while
/// **retaining `data['activity_id']`**. That let a committed block entry
/// keyed only by `activity_id` be re-seeded with a fresh
/// `generateActivityId()` → a second duplicate row.
///
/// This class centralizes the fix: (P1) dedup by `activity_id` too, and
/// (P2) reuse `data['activity_id']` instead of minting a new id.
class StagingSeedDeduper {
  /// Collect every identifier already present in the existing staging rows so
  /// a re-seed can skip them. The row-level `activity_id` column is the only
  /// stable key for committed block entries whose `entry_id`/`hash` were
  /// stripped at seal time.
  StagingSeedDeduper(Iterable<Map<String, dynamic>> rows) {
    for (final row in rows) {
      _addNonEmpty(row['activity_id'] as String?);
      try {
        final blob =
            jsonDecode(row['activity'] as String? ?? '{}') as Map<String, dynamic>;
        _addNonEmpty(blob['hash'] as String?);
        _addNonEmpty(blob['entry_id'] as String?);
      } catch (_) {
        // Best-effort: a malformed blob must not block the seed.
      }
    }
  }

  final Set<String> _seen = {};

  void _addNonEmpty(String? v) {
    if (v != null && v.isNotEmpty) _seen.add(v);
  }

  /// Register a block entry's identifiers and return `true` if it is already
  /// present in staging (so the caller's seed loop must skip it). Honors
  /// EITHER `hash`, `entry_id`, or `data['activity_id']` when more than one
  /// is present, so mixed-identifier seeds never duplicate.
  bool skipDuplicate({
    required String entryHash,
    required String? entryId,
    required String? activityId,
  }) {
    if (entryHash.isNotEmpty && _seen.contains(entryHash)) return true;
    if (entryId != null && entryId.isNotEmpty && _seen.contains(entryId)) {
      return true;
    }
    if (activityId != null &&
        activityId.isNotEmpty &&
        _seen.contains(activityId)) {
      return true;
    }
    _addNonEmpty(entryHash);
    _addNonEmpty(entryId);
    _addNonEmpty(activityId);
    return false;
  }
}

/// Resolve the `activity_id` for a seeded staging row (P2).
///
/// Reuses the block's original `data['activity_id']` when present so a
/// committed activity never gets a second row under a different id, falling
/// back to a valid 10-char `entry_id`, then to `generateActivityId()` for
/// legacy/foreign blocks that carry neither identifier.
String resolveSeedActivityId({String? blockActivityId, String? entryId}) {
  if (blockActivityId != null && blockActivityId.isNotEmpty) {
    return blockActivityId;
  }
  if (entryId != null && entryId.length == 10) return entryId;
  return generateActivityId();
}
