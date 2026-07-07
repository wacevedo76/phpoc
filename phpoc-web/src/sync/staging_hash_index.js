/**
 * Staging Hash Index — data structure and diff detection for staging sync.
 *
 * Provides:
 *   buildStagingHashIndex(entries) → {id, status}[] — builds index from staging DTOs
 *   compareStagingHashIndexes(local, remote) → diff result — detects changes
 *   computeHashForIndex(indexJson) → string — SHA-256 of index for Tier 1 fast path
 *
 * The staging hash index is an ordered list of {id, status} pairs, one per
 * staging entry. Status is derived from is_active / is_paused flags:
 *   - is_active && !is_paused → "active"
 *   - is_active && is_paused  → "paused"
 *   - !is_active               → "ended"
 *
 * This mirrors the ledger hash index architecture:
 *   Tier 1: sha256 match → identical (0.1s)
 *   Tier 2: pull index → compare element-by-element → pull only diffs
 *
 * Unlike the ledger hash index (plaintext seals), the staging hash index
 * is ENCRYPTED on the wire because {id, status} pairs leak per-entry state
 * at finer granularity than the blob obfuscation model allows.
 *
 * Architecture: STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md
 */

/**
 * Type mapping for entry states to status labels.
 * Ordered for lookup efficiency: all three paths covered.
 */
const STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ENDED: 'ended',
};

/**
 * Derive a status label from entry flags.
 *
 * @param {boolean} isActive
 * @param {boolean} isPaused
 * @returns {string} 'active' | 'paused' | 'ended'
 * @private
 */
function _deriveStatus(isActive, isPaused) {
  if (!isActive) return STATUS.ENDED;
  if (isPaused) return STATUS.PAUSED;
  return STATUS.ACTIVE;
}

/**
 * Build a staging hash index array from staging entry DTOs.
 *
 * Maps each entry to {id, status}. Entries without an activity_id
 * (legacy entries) are OMITTED from the index — they have no stable
 * identifier and can't participate in incremental diff detection.
 *
 * Preserves entry order — index position N corresponds to entry[N].
 *
 * @param {Array<{activity_id?: string, is_active?: boolean, is_paused?: boolean}>|null} [entries]
 *   Array of staging entry DTOs. Null/undefined treated as empty.
 * @returns {{id: string, status: string}[]} Ordered array of {id, status} pairs.
 */
export function buildStagingHashIndex(entries) {
  if (!entries || !Array.isArray(entries)) return [];

  return entries
    .filter(e => e && e.activity_id)
    .map(e => ({
      id: e.activity_id,
      status: _deriveStatus(!!e.is_active, !!e.is_paused),
    }));
}

/**
 * Compare local and remote staging hash indexes to detect differences.
 *
 * Matches entries by activity_id (position-independent). Three diff types:
 *   - newRemote: entries on remote but not local (new content to pull)
 *   - removedLocal: entries on local but not remote (should be removed locally)
 *   - statusChanged: entries on both sides with different status values
 *
 * All three types are identified simultaneously — multiple diffs can appear
 * in the same call (e.g., one new + one status change).
 *
 * @param {{id: string|null, status: string}[]|null} local - Local hash index.
 * @param {{id: string|null, status: string}[]|null} remote - Remote hash index.
 * @returns {{
 *   identical: boolean,
 *   newRemote: {id: string, status: string}[],
 *   removedLocal: string[],
 *   statusChanged: {id: string, oldStatus: string, newStatus: string}[]
 * }}
 */
export function compareStagingHashIndexes(local, remote) {
  // Defensive: treat null/undefined as empty
  const l = local || [];
  const r = remote || [];

  // Both empty → identical
  if (l.length === 0 && r.length === 0) {
    return { identical: true, newRemote: [], removedLocal: [], statusChanged: [] };
  }

  // Build lookup maps by id (skip null/undefined ids)
  const localMap = new Map();
  for (const entry of l) {
    if (entry && entry.id != null) {
      localMap.set(entry.id, entry.status);
    }
  }

  const remoteMap = new Map();
  for (const entry of r) {
    if (entry && entry.id != null) {
      remoteMap.set(entry.id, entry.status);
    }
  }

  const newRemote = [];
  const removedLocal = [];
  const statusChanged = [];

  // Find entries on remote but not local (new) + status changes
  for (const entry of r) {
    if (!entry || entry.id == null) continue;
    const id = entry.id;
    if (!localMap.has(id)) {
      newRemote.push({ id, status: entry.status });
    } else if (localMap.get(id) !== entry.status) {
      statusChanged.push({
        id,
        oldStatus: localMap.get(id),
        newStatus: entry.status,
      });
    }
  }

  // Find entries on local but not remote (removed)
  for (const entry of l) {
    if (!entry || entry.id == null) continue;
    const id = entry.id;
    if (!remoteMap.has(id)) {
      removedLocal.push(id);
    }
  }

  const identical = newRemote.length === 0 && removedLocal.length === 0 && statusChanged.length === 0;

  return { identical, newRemote, removedLocal, statusChanged };
}

/**
 * Compute SHA-256 hash of a staging hash index JSON string.
 *
 * Used for Tier 1 fast-path comparison — push this alongside the
 * encrypted hash_index.json so subsequent syncs can compare sha256
 * instrad of pulling the full index.
 *
 * @param {string|object} index - JSON string or object to hash.
 * @param {(data: string) => string} sha256Fn - SHA-256 function (hex output).
 * @returns {string} 64-char hex SHA-256 digest.
 */
export function computeHashForIndex(index, sha256Fn) {
  const json = typeof index === 'string' ? index : JSON.stringify(index);
  return sha256Fn(json);
}
