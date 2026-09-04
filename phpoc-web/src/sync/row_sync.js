/**
 * Row-level sync: buildDiff pure function + mergeRows canonical row merge.
 *
 * buildDiff compares local row data against a remote manifest and ledger
 * hash index to produce a sync plan ({pull, push, deleteLocal, fastPath}).
 *
 * mergeRows merges two arrays of canonical-format staging rows
 * ({activity_id, activity_status, activity, updated_at, committed})
 * using activity_id as the merge key with LWW resolution.
 *
 * RowSyncWorker has been removed per B-05b — per-row CRUD endpoints
 * are replaced by the single-blob + hash index model (PHPSPEC §8).
 *
 * Resolution rules follow ADR-025 (LWW with ledger-aware cleanup).
 */

/**
 * @typedef {Object} DiffResult
 * @property {string[]} pull        — activity_ids to pull from remote
 * @property {string[]} push        — activity_ids to push to remote
 * @property {string[]} deleteLocal — activity_ids to delete from local
 * @property {boolean} fastPath      — true when no network calls needed
 */

/**
 * @typedef {Object} ManifestRow
 * @property {string} activity_id
 * @property {string} activity_status
 * @property {number} updated_at
 */

/**
 * @typedef {Object} Manifest
 * @property {ManifestRow[]} rows
 * @property {number} version
 */

/**
 * @typedef {Object} LocalRow
 * @property {string} activity_id
 * @property {string} activity_status
 * @property {string} activity
 * @property {number} updated_at
 */

// ══════════════════════════════════════════════════════════════════════
// buildDiff — 8-scenario LWW resolution
// ══════════════════════════════════════════════════════════════════════

/**
 * Compare local staging rows against a remote manifest and ledger hash
 * index to determine what to pull, push, and delete.
 *
 * Resolution scenarios (ADR-025):
 *
 *   Row in both local and remote:
 *     S1: Remote newer → pull
 *     S2: Local newer → push
 *     S3: Same timestamp, different status → tie-break (remote wins)
 *
 *   Row in remote only:
 *     S4: Remote-only → pull
 *
 *   Row in local only:
 *     S5: In ledger hash index (committed) → deleteLocal
 *     S6: Not in hash index (new) → push
 *
 *   Special:
 *     S7: All local committed, remote empty → fastPath + deleteLocal
 *
 * fastPath is true when no push, pull, or deleteLocal actions are needed,
 * meaning the caller can skip network calls entirely.
 *
 * @param {LocalRow[]|null} localRows - Current local staging rows (array of row objects
 *   with activity_id, activity_status, activity, updated_at). Null treated as [].
 * @param {{rows: ManifestRow[]|null, version: number}} remoteManifest - Remote
 *   manifest returned from Worker. rows and version fields.
 * @param {Map<string, {committed_at: number}>|null} ledgerHashIndex - Map of
 *   activity_id → {committed_at} for entries already committed to the ledger.
 *   Null treated as empty Map.
 * @returns {DiffResult}
 */
export function buildDiff(localRows, remoteManifest, ledgerHashIndex) {
  // Defensive normalization
  const local = Array.isArray(localRows) ? localRows : [];
  const remoteRows = (remoteManifest && Array.isArray(remoteManifest.rows)) ? remoteManifest.rows : [];
  const hashIdx = ledgerHashIndex instanceof Map ? ledgerHashIndex : new Map();

  // Build lookup maps
  /** @type {Map<string, LocalRow>} */
  const localMap = new Map();
  for (const row of local) {
    if (row && row.activity_id) {
      localMap.set(row.activity_id, row);
    }
  }

  /** @type {Map<string, ManifestRow>} */
  const remoteMap = new Map();
  for (const row of remoteRows) {
    if (row && row.activity_id) {
      // Last-wins dedup for duplicate activity_ids in remote manifest
      remoteMap.set(row.activity_id, row);
    }
  }

  const pull = [];
  const push = [];
  const deleteLocal = [];

  // Process remote rows: compare against local
  for (const [activityId, remoteRow] of remoteMap) {
    const localRow = localMap.get(activityId);
    if (!localRow) {
      // S4: Remote-only → pull
      pull.push(activityId);
      continue;
    }

    // Both sides have the row — compare timestamps
    const remoteTime = Number(remoteRow.updated_at) || 0;
    const localTime = Number(localRow.updated_at) || 0;

    if (remoteTime > localTime) {
      // S1: Remote newer → pull
      pull.push(activityId);
    } else if (localTime > remoteTime) {
      // S2: Local newer → push
      push.push(activityId);
    } else {
      // S3: Same timestamp — local wins on tie (PHPSPEC §8.5, matches Flutter)
      const remoteStatus = remoteRow.activity_status || '';
      const localStatus = localRow.activity_status || '';
      if (remoteStatus !== localStatus) {
        // Different status → push local version
        push.push(activityId);
      }
      // If status also matches, row is identical → no-op
    }
  }

  // Process local rows not in remote
  for (const [activityId, localRow] of localMap) {
    if (remoteMap.has(activityId)) continue; // already handled above

    if (hashIdx.has(activityId)) {
      // S5 + S8: In ledger hash index → committed on some device → deleteLocal
      deleteLocal.push(activityId);
    } else {
      // S6: New local entry, not committed → push
      push.push(activityId);
    }
  }

  // fastPath: no network calls needed. deleteLocal is a purely local
  // operation (removing rows that are already committed on some device),
  // so it does not disable fastPath.
  const fastPath = pull.length === 0 && push.length === 0;

  // Return strings (activity_ids) for all three lists — matches test expectations
  return { pull, push, deleteLocal, fastPath };
}


// ══════════════════════════════════════════════════════════════════════
// mergeRows — canonical row merge by activity_id (PHPSPEC §8.5)
// ══════════════════════════════════════════════════════════════════════

/**
 * Whether a canonical staging row reflects an ended activity (ADR-033).
 *
 * Checks row-level `activity_status` first (canonical), then falls back to
 * the `is_active` flag inside the `activity` JSON blob for rows that predate
 * row-level status or carry an empty/missing status. Unknown status without
 * `is_active:false` is treated as not-ended (fail-safe — never force a row
 * to end on bad data).
 *
 * @param {object} row - Canonical staging row.
 * @returns {boolean}
 */
function isEnded(row) {
  if (!row) return false;
  const status = row.activity_status;
  if (status === 'ended') return true;
  if (typeof status === 'string' && status !== '') return false; // active/paused

  // Fallback: activity blob `is_active === false` ⇒ ended
  try {
    const activityStr = row.activity;
    if (activityStr) {
      const activity = typeof activityStr === 'string' ? JSON.parse(activityStr) : activityStr;
      if (activity && activity.is_active === false) return true;
    }
  } catch { /* ignore corrupt blob */ }

  return false;
}

/**
 * Effective `activity_status` for a canonical row, resolving the empty-status
 * fallback so a row ended via `is_active:false` normalizes to `'ended'`.
 *
 * @param {object} row - Canonical staging row.
 * @returns {string}
 */
function effectiveStatus(row) {
  if (isEnded(row)) return 'ended';
  return (row && row.activity_status) || 'active';
}

/**
 * ADR-033 terminal-state winner, if any.
 *
 * When exactly one side is `ended` and the other is not, the `ended` side
 * wins regardless of `updated_at`. Returns 'remote' | 'local' | null
 * (null when both sides share the same terminal state, or neither ended).
 *
 * @param {object} local - Canonical local row.
 * @param {object} remote - Canonical remote row.
 * @returns {'remote'|'local'|null}
 */
function terminalEndWins(local, remote) {
  const localEnded = isEnded(local);
  const remoteEnded = isEnded(remote);
  if (remoteEnded && !localEnded) return 'remote';
  if (localEnded && !remoteEnded) return 'local';
  return null;
}

/**
 * Whether the remote row wins the merge for a shared activity_id.
 *
 * ADR-033 terminal-state rule + LWW:
 *   - exactly one side ended → the ended side wins (regardless of updated_at)
 *   - otherwise → LWW: remote wins iff remote.updated_at > local.updated_at
 *
 * Shared by mergeRows (here) and SyncService._mergeRemoteIntoLocal so the
 * merge outcome and the DTO-rebuild decision cannot drift.
 *
 * @param {object} local - Canonical local row.
 * @param {object} remote - Canonical remote row.
 * @returns {boolean}
 */
export function remoteWins(local, remote) {
  const terminalWinner = terminalEndWins(local, remote);
  if (terminalWinner) return terminalWinner === 'remote';
  const localTs = (local && local.updated_at) ?? 0;
  const remoteTs = (remote && remote.updated_at) ?? 0;
  return remoteTs > localTs;
}

/**
 * Normalize a canonical row into the merged output shape.
 *
 * `updatedAt` and `committed` are passed explicitly because a remote win
 * carries the remote timestamp, and `committed` is the irreversible OR of
 * both sides.
 *
 * @param {object} row - Canonical staging row.
 * @param {number} updatedAt - Effective updated_at for the merged row.
 * @param {boolean} committed - Effective committed flag for the merged row.
 * @returns {{activity_id: string, activity_status: string, activity: string, updated_at: number, committed: boolean}}
 */
function buildMergedRow(row, updatedAt, committed) {
  return {
    activity_id: row.activity_id || row.entry_id || '',
    activity_status: effectiveStatus(row),
    activity: row.activity || '{}',
    updated_at: updatedAt,
    committed,
  };
}

/**
 * Merge two arrays of canonical staging rows by activity_id.
 *
 * Resolution rules (PHPSPEC §8.5):
 *   1. activity_id is the primary merge key; entry_id is the legacy fallback.
 *   2. Terminal-state rule (ADR-033): if exactly one side is `ended` and the
 *      other is `active`/`paused`/unset, the `ended` side wins regardless of
 *      `updated_at`. An activity cannot un-end.
 *   3. Otherwise: newer updated_at wins (LWW).
 *   4. On equal updated_at: local row wins (matches Flutter).
 *   5. Local-only rows with committed:true are excluded.
 *   6. Remote-only rows are included unconditionally.
 *   7. committed:true is irreversible (never downgraded to false).
 *
 * Pure function — no side effects, does not mutate inputs.
 *
 * @param {Array<{activity_id: string, activity_status: string, activity: string, updated_at: number, committed?: boolean}>} local
 * @param {Array<{activity_id: string, activity_status: string, activity: string, updated_at: number, committed?: boolean}>} remote
 * @returns {Array<{activity_id: string, activity_status: string, activity: string, updated_at: number, committed: boolean}>}
 */
export function mergeRows(local, remote) {
  const loc = Array.isArray(local) ? local : [];
  const rem = Array.isArray(remote) ? remote : [];

  const merged = new Map();

  // Process local rows first
  for (const row of loc) {
    if (!row) continue;
    const key = row.activity_id || row.entry_id;
    if (!key) continue;
    merged.set(key, buildMergedRow(row, row.updated_at ?? 0, row.committed || false));
  }

  // Build a set of remote keys for O(1) lookup during committed-exclusion
  const remoteKeys = new Set();
  for (const row of rem) {
    if (row) {
      const key = row.activity_id || row.entry_id;
      if (key) remoteKeys.add(key);
    }
  }

  // Process remote rows — merge by activity_id (or entry_id fallback)
  for (const row of rem) {
    if (!row) continue;
    const key = row.activity_id || row.entry_id;
    if (!key) continue;
    const existing = merged.get(key);
    const remoteTime = row.updated_at ?? 0;
    const remoteCommitted = row.committed || false;

    if (!existing) {
      // Remote-only row → include unconditionally
      merged.set(key, buildMergedRow(row, remoteTime, remoteCommitted));
    } else if (remoteWins(existing, row)) {
      // Remote wins (LWW newer, or terminal-state: remote ended vs local
      // non-ended). committed is irreversible.
      merged.set(key, buildMergedRow(row, remoteTime, existing.committed || remoteCommitted));
    } else if (remoteCommitted) {
      // Local wins — but committed flag is irreversible
      existing.committed = true;
    }
  }

  // Filter out local-only rows with committed:true (rule 4).
  // Local-only means the row's key is NOT in the remote set.
  const result = [];
  for (const row of merged.values()) {
    if (row.committed && !remoteKeys.has(row.activity_id || '')) {
      continue;
    }
    result.push(row);
  }

  // Deterministic output: sort by activity_id (matches Python merge_rows,
  // PHPSPEC §8.5). Required so cross-client merge produces byte-identical
  // results regardless of input order (CCS-4 C6).
  result.sort((a, b) =>
    a.activity_id < b.activity_id ? -1 : a.activity_id > b.activity_id ? 1 : 0
  );

  return result;
}
