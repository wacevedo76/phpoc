import 'dart:convert';

import '../storage/database.dart';
import '../sync/activity_id.dart';
import '../sync/staging_store.dart';

/// Migrates old `entries` JSON-array blob → new row-per-activity `staging` table.
///
/// One-shot migration that:
///   1. Reads the legacy `entries` key from the old K/V store
///   2. Converts each entry to a `staging` row
///   3. Writes all rows to the new StagingStore
///   4. Sets a `migrated_v1` flag to prevent re-run
///   5. Deletes the old `entries` key
class StagingMigration {
  final AppDatabase db;
  final dynamic legacyStorage; // {get, set, remove, hasKey}
  final StagingStore stagingStore;

  StagingMigration({
    required this.db,
    required this.legacyStorage,
    required this.stagingStore,
  });

  /// Check whether migration is needed.
  ///
  /// Returns true when the legacy `entries` key exists AND the staged
  /// table is empty (or nearly empty).
  Future<bool> needsMigration() async {
    // If staging table already has rows, no migration needed (C2)
    final count = await stagingStore.count();
    if (count > 0) return false;

    // Check for legacy entries
    try {
      final entries = await legacyStorage.get('entries');
      if (entries is List && entries.isNotEmpty) return true;
    } catch (_) {
      return false;
    }

    // Check for migration marker
    try {
      final migrated = await legacyStorage.get('migrated_v1');
      if (migrated == true) return false;
    } catch (_) {}

    return false;
  }

  /// Run the migration. Idempotent — safe to call multiple times.
  Future<void> migrate() async {
    // Double-check needs migration (C2)
    if (!await needsMigration()) return;

    // Read legacy entries
    List legacyEntries;
    try {
      final raw = await legacyStorage.get('entries');
      if (raw is! List) return; // C11: malformed blob
      legacyEntries = raw;
    } catch (_) {
      return; // C11
    }

    // C10: empty blob
    if (legacyEntries.isEmpty) {
      await _cleanupLegacy();
      return;
    }

    final now = DateTime.now().millisecondsSinceEpoch;

    for (final raw in legacyEntries) {
      if (raw is! Map) continue;

      // C8: skip committed entries
      if (raw['committed'] == true) continue;

      final data = raw['data'] as Map<String, dynamic>? ?? {};

      // C9: preserve existing activity_id (from web-originated entries)
      final existingId = data['entry_id'] as String?;
      final activityId = (existingId != null && existingId.isNotEmpty)
          ? existingId
          : ActivityIdGenerator.generateActivityId();

      // C4: derive status from is_active/is_paused
      final isActive = data['is_active'] as bool? ?? true;
      final isPaused = data['is_paused'] as bool? ?? false;
      String activityStatus;
      if (!isActive) {
        activityStatus = 'ended';
      } else if (isPaused) {
        activityStatus = 'paused';
      } else {
        activityStatus = 'active';
      }

      // C5: preserve original encrypted data blob as JSON
      final activity = json.encode(data);

      // C6: extract fields from data into row-level extras for commit() compat.
      // Old KV entries use startTime_enc (encrypted), not start_epoch (plaintext).
      // Only extract fields that are already plaintext.
      final startEpoch = data['start_epoch'];
      final entryEndEpoch = data['end_epoch'];

      // C7: use migration time for updated_at
      await stagingStore.putRow({
        'activity_id': activityId,
        'activity_status': activityStatus,
        'activity': activity,
        'updated_at': now,
        if (startEpoch is int && startEpoch > 0) 'start_epoch': startEpoch,
        'title': data['title'] ?? '',
        'duration': data['duration'] ?? 0,
        if (entryEndEpoch is int) 'end_epoch': entryEndEpoch,
        'tags': data['tags'] ?? [],
        'pauses': data['pauses'] ?? [],
        if (data['comment'] != null) 'comment': data['comment'],
      });
    }

    // C8: set migration marker
    try {
      await legacyStorage.set('migrated_v1', true);
    } catch (_) {}

    // C12: delete old entries key
    await _cleanupLegacy();
  }

  Future<void> _cleanupLegacy() async {
    try {
      await legacyStorage.remove('entries');
    } catch (_) {}
  }
}
