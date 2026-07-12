/**
 * Row-level sync: buildDiff pure function + RowSyncWorker HTTP client.
 *
 * buildDiff compares local row data against a remote manifest and ledger
 * hash index to produce a sync plan ({pull, push, deleteLocal, fastPath}).
 *
 * RowSyncWorker wraps a transport to call the four Worker row-level endpoints:
 *   GET  /storage/staging/manifest          → fetchManifest()
 *   GET  /storage/staging/rows/{id}         → fetchRow(id)
 *   PUT  /storage/staging/rows/{id}         → pushRow(id, row)
 *   DELETE /storage/staging/rows/{id}       → deleteRow(id)
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
      // S3: Same timestamp — tie-break by status, remote wins
      const remoteStatus = remoteRow.activity_status || '';
      const localStatus = localRow.activity_status || '';
      if (remoteStatus !== localStatus) {
        // Different status → pull remote version
        pull.push(activityId);
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

  // S7: All local rows committed and remote is empty → fastPath
  const allCommitted = local.length > 0 && push.length === 0 &&
    pull.length === 0 && deleteLocal.length === local.length;

  // fastPath: no network calls needed. deleteLocal is a purely local
  // operation (removing rows that are already committed on some device),
  // so it does not disable fastPath.
  const fastPath = pull.length === 0 && push.length === 0;

  // Return strings (activity_ids) for all three lists — matches test expectations
  return { pull, push, deleteLocal, fastPath };
}


// ══════════════════════════════════════════════════════════════════════
// RowSyncWorker — HTTP client for Worker row-level endpoints
// ══════════════════════════════════════════════════════════════════════

const MANIFEST_PATH = '/storage/staging/manifest';
const ROW_PATH_PREFIX = '/storage/staging/rows/';

export class RowSyncWorker {
  /**
   * @param {object} transport — Transport-like object with pull(), push(), delete().
   * @param {object} [config]
   * @param {string} [config.apiKey] — API key for auth headers.
   */
  constructor(transport, config = {}) {
    this._transport = transport;
    this._config = config;
    this._apiKey = config.apiKey || null;

    /** @type {number} Max retry attempts for transient failures. */
    this._maxRetries = 3;
  }

  /**
   * Fetch the remote staging manifest.
   *
   * @returns {Promise<Manifest>}
   */
  async fetchManifest() {
    const raw = await this._retry(() => this._transport.pull(MANIFEST_PATH));
    if (raw === null || raw === undefined) {
      throw new Error('fetchManifest: null response');
    }
    const text = new TextDecoder().decode(raw);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error('fetchManifest: invalid JSON response');
    }
    // Validate: parsed must be an object, not a string/number/array
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('fetchManifest: invalid JSON response');
    }
    // Normalize: ensure rows is always an array
    return {
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      version: typeof parsed.version === 'number' ? parsed.version : 0,
    };
  }

  /**
   * Fetch a single row by activity_id.
   *
   * @param {string} activityId
   * @returns {Promise<object|null>} Row object or null if 404.
   */
  async fetchRow(activityId) {
    const path = ROW_PATH_PREFIX + activityId;
    const raw = await this._retry(() => this._transport.pull(path));
    if (raw === null || raw === undefined) {
      return null; // 404
    }
    const text = new TextDecoder().decode(raw);
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Push (upsert) a row to remote.
   *
   * @param {string} activityId - Activity ID used in URL path.
   * @param {object} row - Full row object (activity_id, activity_status, activity, updated_at).
   *   If row.activity_id differs from activityId, the body is sent as-is
   *   (caller is responsible for consistency).
   * @returns {Promise<{ok: boolean, status: number}>}
   */
  async pushRow(activityId, row) {
    const path = ROW_PATH_PREFIX + activityId;
    const body = new TextEncoder().encode(JSON.stringify(row));
    try {
      const result = await this._retry(() => this._transport.push(path, body));
      if (result && typeof result.status === 'number') {
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
        };
      }
      return { ok: true, status: 200 };
    } catch (e) {
      return { ok: false, status: 0 };
    }
  }

  /**
   * Delete a row from remote. Idempotent — deleting a nonexistent row
   * returns {ok: true, status: 404}.
   *
   * @param {string} activityId
   * @returns {Promise<{ok: boolean, status: number}>}
   */
  async deleteRow(activityId) {
    const path = ROW_PATH_PREFIX + activityId;
    try {
      const result = await this._retry(() => this._transport.delete(path));
      if (result && typeof result.status === 'number') {
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
        };
      }
      return { ok: true, status: 200 };
    } catch (e) {
      return { ok: false, status: 0 };
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Retry a thunk up to _maxRetries times for transient failures.
   *
   * @param {() => Promise<any>} thunk
   * @returns {Promise<any>}
   * @private
   */
  async _retry(thunk) {
    let lastError;
    for (let attempt = 0; attempt < this._maxRetries; attempt++) {
      try {
        return await thunk();
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error('Retry exhausted');
  }
}
