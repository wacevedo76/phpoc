/**
 * RowStagingStore — row-per-activity staging store backed by StorageBackend.
 *
 * Each staging entry is stored as an individual key-value row under
 * `staging:row:{activity_id}`. This replaces the single-bulk-blob model
 * with fine-grained, diff-able entries that enable row-level sync.
 *
 * Schema:
 *   {
 *     activity_id: string,      // 10–20 char alphanumeric (PK)
 *     activity_status: string,  // 'staged' | 'active' | 'paused' | 'ended' | any
 *     activity: string,         // JSON blob of entry data (encrypted on wire)
 *     updated_at: number        // ms timestamp, last-write-wins tiebreaker
 *   }
 *
 * Forward-compat: extra fields beyond the four core fields are preserved
 * on read-back (no stripping).
 *
 * Storage key format:  staging:row:{activity_id}
 * Prefix for list/scan: staging:row:
 */

const ROW_PREFIX = 'staging:row:';

export class RowStagingStore {
  /**
   * @param {import('./storage.js').StorageBackend} storage - Storage backend
   *   (MemoryBackend for tests, IndexedDBBackend for production).
   */
  constructor(storage) {
    /** @private */
    this._storage = storage;
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  /**
   * Store (insert or upsert) a staging row.
   *
   * @param {{activity_id: string, activity_status: string, activity: string, updated_at: number}} row
   * @returns {Promise<void>}
   */
  async putRow(row) {
    const key = ROW_PREFIX + row.activity_id;
    await this._storage.set(key, { ...row });
  }

  /**
   * Retrieve a single staging row by activity_id.
   *
   * @param {string} activityId
   * @returns {Promise<object|null>} The stored row, or null if not found.
   */
  async getRow(activityId) {
    const key = ROW_PREFIX + activityId;
    const result = await this._storage.get(key);
    return result !== undefined ? result : null;
  }

  /**
   * Delete a staging row by activity_id. Idempotent (no-op if not found).
   *
   * @param {string} activityId
   * @returns {Promise<void>}
   */
  async deleteRow(activityId) {
    const key = ROW_PREFIX + activityId;
    await this._storage.delete(key);
  }

  /**
   * Return all stored staging rows as an array.
   *
   * Order is deterministic: sorted by key (which means activity_id order).
   *
   * @returns {Promise<object[]>}
   */
  async getAllRows() {
    const keys = await this._storage.list(ROW_PREFIX);
    const rows = [];
    for (const key of keys) {
      const row = await this._storage.get(key);
      if (row !== undefined) {
        rows.push(row);
      }
    }
    return rows;
  }

  /**
   * Return rows matching a given activity_status.
   *
   * @param {string} status
   * @returns {Promise<object[]>}
   */
  async getRowsByStatus(status) {
    const all = await this.getAllRows();
    return all.filter(r => r.activity_status === status);
  }

  /**
   * Count of stored rows (O(n) — not an optimized fast path).
   *
   * @returns {Promise<number>}
   */
  async count() {
    const keys = await this._storage.list(ROW_PREFIX);
    return keys.length;
  }

  // ── Transport interface (pull/push/delete path-based) ────────────

  /**
   * Transport pull: serves manifest or row by path.
   * Paths: /storage/staging/manifest or /storage/staging/rows/{id}
   *
   * @param {string} path
   * @returns {Promise<Uint8Array|null>}
   */
  async pull(path) {
    if (path.includes('/manifest')) {
      const rows = await this.getAllRows();
      const manifest = {
        rows: rows.map(r => ({
          activity_id: r.activity_id,
          activity_status: r.activity_status,
          updated_at: r.updated_at,
        })),
        version: rows.length, // coarse version: row count
      };
      return new TextEncoder().encode(JSON.stringify(manifest));
    }
    if (path.includes('/storage/staging/rows/') || path.includes(ROW_PREFIX)) {
      const parts = path.split('/');
      const activityId = parts[parts.length - 1];
      const row = await this.getRow(activityId);
      if (row === null) return null;
      return new TextEncoder().encode(JSON.stringify(row));
    }
    return null;
  }

  /**
   * Transport push: store a row by path.
   * Path: /storage/staging/rows/{id}
   *
   * @param {string} path
   * @param {Uint8Array} body
   * @returns {Promise<{status: number}>}
   */
  async push(path, body) {
    const parts = path.split('/');
    const activityId = parts[parts.length - 1];
    let row;
    try {
      row = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return { status: 400 };
    }
    if (!row || !row.activity_id) {
      return { status: 400 };
    }
    await this.putRow(row);
    return { status: 200 };
  }

  /**
   * Transport delete: remove a row by path. Idempotent.
   * Path: /storage/staging/rows/{id}
   *
   * @param {string} path
   * @returns {Promise<{status: number}>}
   */
  async delete(path) {
    const parts = path.split('/');
    const activityId = parts[parts.length - 1];
    await this.deleteRow(activityId);
    return { status: 200 };
  }
}
