/**
 * mergeEngine — entry_id-based deduplication merge of staging entries.
 *
 * Port of domain/staging/merge_engine.py to JS.
 *
 * Uses entry_id as the primary dedup key (stable UUID per entry).
 * Falls back to (title, start_epoch) for backward compatibility with
 * entries created before the entry_id convention existed.
 *
 * When the same entry_id exists in both local and remote, remote wins —
 * it represents the more recent state.
 *
 * Pure function: no I/O, no side effects, no external dependencies.
 */

/**
 * @typedef {Object} StagingEntry
 * @property {string} [entry_id] - Stable UUID per entry.
 * @property {string} title - Entry title.
 * @property {number} start_epoch - Start timestamp in ms.
 * @property {number} [end_epoch] - End timestamp in ms.
 * @property {number} [duration] - Duration in ms.
 * @property {boolean} [is_active] - Whether entry is active.
 * @property {boolean} [is_paused] - Whether entry is paused.
 * @property {Array} [pauses] - Pause intervals.
 * @property {string[]} [tags] - Tags.
 * @property {string} [comment] - Comment.
 * @property {Array} [media] - Media attachments.
 * @property {string} [source] - 'local' or 'remote'.
 * @property {number} [entry_index] - Index in the staging array.
 */

/**
 * Return the dedup key for an entry.
 *
 * Primary: entry_id (stable UUID).
 * Fallback: (title, start_epoch) for backward compatibility.
 *
 * @param {StagingEntry} entry
 * @returns {string} A comparable key string.
 */
function dedupKey(entry) {
  const entryId = entry?.entry_id;
  if (entryId) {
    return `id:${entryId}`;
  }
  return `fallback:${entry?.title || ''}:${entry?.start_epoch ?? 0}`;
}

/**
 * Merge remote entries into local cache.
 *
 * @param {StagingEntry[]} localEntries - Entries from the local staging cache.
 * @param {StagingEntry[]} remoteEntries - Entries pulled from remote.
 * @returns {StagingEntry[]} Merged list deduplicated by entry_id
 *   (or title+start_epoch for backward compat), remote winning on ties,
 *   sorted by start_epoch ascending.
 */
export function mergeEntries(localEntries, remoteEntries) {
  /** @type {Map<string, StagingEntry>} */
  const seen = new Map();

  // Process local entries first
  for (const entry of localEntries) {
    const key = dedupKey(entry);
    seen.set(key, { ...entry, source: 'local' });
  }

  // Process remote entries — merge into map preserving committed flag.
  // committed=true is irreversible: once a local entry has been committed
  // (markCommitted ran after engine.commit), it must not be downgraded by
  // a stale remote blob that hasn't been updated yet (e.g. pushBlobOnly
  // failed silently).
  for (const entry of remoteEntries) {
    const key = dedupKey(entry);
    const local = seen.get(key);
    seen.set(key, {
      ...entry,
      source: 'remote',
      committed: (local?.committed || entry.committed) || false,
      block_index: entry.block_index ?? local?.block_index ?? null,
    });
  }

  // Sort by start_epoch ascending
  return [...seen.values()].sort(
    (a, b) => (a.start_epoch ?? 0) - (b.start_epoch ?? 0)
  );
}
