/**
 * Migration: blob-to-rows migration for staging data.
 *
 * Converts the old single-blob `entries` format (array of {hash, data, committed})
 * to the new row-level staging store (`staging:row:{activity_id}` keys).
 *
 * Provides:
 *   migrateBlobToRows(storage) → Promise<number> — runs migration, returns row count
 *
 * Design:
 *   - Idempotent: checks `staging:migration:row_level` marker, skips if present
 *   - O(1) marker check before all operations (fast exit when already done)
 *   - Best-effort: corrupted entries are skipped, good entries are migrated
 *   - Removes old `entries` key after successful completion
 *   - Generates activity_id for entries that lack one via simple random ID
 *   - Sets updated_at from current timestamp since old format has no concept of it
 */

import { RowStagingStore } from './row_staging_store.js';
import { generateActivityId } from './activity_id.js';

const MIGRATION_MARKER_KEY = 'staging:migration:row_level';
const ENTRIES_KEY = 'entries';

/**
 * Run the blob-to-rows migration for staging data.
 *
 * @param {import('./storage.js').StorageBackend} storage — Storage backend.
 * @param {object} [options]
 * @param {() => string} [options.generateId] — Injectible activity_id generator (test seam).
 * @returns {Promise<number>} Number of rows migrated (0 if already done or empty).
 */
export async function migrateBlobToRows(storage, options = {}) {
  // Fast exit: marker already present
  const marker = await storage.get(MIGRATION_MARKER_KEY);
  if (marker !== undefined && marker !== null) {
    return 0;
  }

  const generateId = options.generateId || generateActivityId;

  // Read old blob entries
  const entries = (await storage.get(ENTRIES_KEY)) || [];
  if (!Array.isArray(entries) || entries.length === 0) {
    // Write marker even for empty migration so we don't re-check
    await storage.set(MIGRATION_MARKER_KEY, true);
    return 0;
  }

  const rowStore = new RowStagingStore(storage);
  const now = Date.now();
  let migrated = 0;

  for (const entry of entries) {
    try {
      if (!entry || !entry.data) continue;

      const data = entry.data || {};

      // Use existing activity_id (entry-level or data-level) or generate one
      const activityId = entry.activity_id || data.activity_id || generateId();

      // Determine status from flags in old format
      let activityStatus = 'staged';
      if (entry.committed) {
        activityStatus = 'ended';
      } else if (data.is_active && data.is_paused) {
        activityStatus = 'paused';
      } else if (data.is_active) {
        activityStatus = 'active';
      }

      // Build activity blob preserving all old data
      const activityBlob = {
        entry_id: data.entry_id || '',
        title: data.title || '',
        startTime_enc: data.startTime_enc || '',
        endTime_enc: data.endTime_enc || undefined,
        duration: data.duration || 0,
        is_active: data.is_active,
        is_paused: data.is_paused,
        pauses_enc: data.pauses_enc || 'plain:[]',
        tags: data.tags || [],
        media: data.media || [],
        device_uuid_enc: data.device_uuid_enc || '',
        end_device_uuid_enc: data.end_device_uuid_enc || '',
        metadata_enc: data.metadata_enc || 'plain:{}',
        comment: data.comment || null,
        committed: entry.committed || false,
        block_index: entry.block_index ?? null,
        hash: entry.hash || '',
      };

      // Remove undefined keys
      for (const k of Object.keys(activityBlob)) {
        if (activityBlob[k] === undefined) delete activityBlob[k];
      }

      const row = {
        activity_id: activityId,
        activity_status: activityStatus,
        activity: JSON.stringify(activityBlob),
        updated_at: now,
      };

      await rowStore.putRow(row);
      migrated++;
    } catch {
      // Best-effort: skip corrupted entries
      continue;
    }
  }

  // Remove old entries key after successful migration
  await storage.delete(ENTRIES_KEY);

  // Write marker so subsequent calls are no-ops
  await storage.set(MIGRATION_MARKER_KEY, true);

  return migrated;
}
