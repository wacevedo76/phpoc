/**
 * LocalCache — staging entry CRUD with local persistence.
 *
 * Port of domain/staging/local_cache.py to JS.
 *
 * Manages local staging entries as plain JS objects (DTOs) stored via
 * the StorageBackend. Unlike the Python version which uses a `plain:`
 * prefix convention for field-level encryption, this stores decrypted
 * DTOs directly — encryption happens only at the remote boundary
 * (RemoteSync via CryptoService).
 *
 * Storage key: 'entries' → StagingEntry[]
 *
 * Each entry carries:
 *   entry_id       — stable UUID (from CryptoService)
 *   title          — string
 *   start_epoch    — ms timestamp
 *   end_epoch      — ms timestamp or null
 *   duration       — ms (0 if active)
 *   is_active      — boolean
 *   is_paused      — boolean
 *   pauses         — array of {pause_start, pause_stop, comment?}
 *   tags           — string[]
 *   comment        — string or null
 *   media          — array
 *   device_uuid    — string (device that created)
 *   end_device_uuid — string (device that ended)
 *   metadata       — object
 *   hash           — SHA-256 hex of sorted JSON data
 *   entry_index    — position in array (computed on read)
 */

/**
 * @typedef {Object} StagingEntry
 * @property {string} entry_id
 * @property {string} title
 * @property {number} start_epoch
 * @property {number|null} end_epoch
 * @property {number} duration
 * @property {boolean} is_active
 * @property {boolean} is_paused
 * @property {Array} pauses
 * @property {string[]} tags
 * @property {string|null} comment
 * @property {Array} media
 * @property {string} device_uuid
 * @property {string} end_device_uuid
 * @property {object} metadata
 * @property {string} hash
 * @property {number} entry_index
 */

const ENTRIES_KEY = 'entries';

export class LocalCache {
  /**
   * @param {import('./storage.js').StorageBackend} storage - Storage backend.
   * @param {import('../crypto/index.js').CryptoService} crypto - WASM CryptoService
   *   (for UUID generation and SHA-256 hashing).
   */
  constructor(storage, crypto) {
    /** @private */
    this._storage = storage;
    /** @private */
    this._crypto = crypto;
  }

  // ------------------------------------------------------------------
  // Read / Write (full list)
  // ------------------------------------------------------------------

  /**
   * Read all staging entries as decrypted DTOs.
   *
   * Each entry gets an `entry_index` property matching its position
   * in the array.
   *
   * @returns {Promise<StagingEntry[]>}
   */
  async readEntries() {
    const entries = (await this._storage.get(ENTRIES_KEY)) || [];
    // Attach entry_index based on position
    return entries.map((entry, idx) => ({ ...entry, entry_index: idx }));
  }

  /**
   * Write a list of DTOs to storage.
   *
   * @param {StagingEntry[]} entries
   * @returns {Promise<void>}
   */
  async writeEntries(entries) {
    // Strip entry_index before storing (it's ephemeral)
    const clean = entries.map(({ entry_index, ...rest }) => rest);
    await this._storage.set(ENTRIES_KEY, clean);
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  /**
   * Append a new staging entry.
   *
   * @param {object} params
   * @param {string} params.title
   * @param {number} params.startEpoch - ms timestamp.
   * @param {number} [params.endEpoch]
   * @param {boolean} [params.isActive=true]
   * @param {string[]} [params.tags]
   * @param {string} [params.comment]
   * @param {Array} [params.media]
   * @param {string} [params.deviceUuid]
   * @returns {Promise<string>} The entry hash prefix (10 chars).
   * @throws {Error} If a collision is detected (same start_epoch).
   */
  async append({ title, startEpoch, endEpoch, isActive = true, tags, comment, media, deviceUuid }) {
    const entries = await this.readEntries();

    // Collision check
    for (const entry of entries) {
      if (entry.start_epoch === startEpoch) {
        throw new Error(
          `Collision detected: A task has already started at this millisecond.`
        );
      }
    }

    const normalizedTags = _normalizeTags(tags);
    const entryId = this._crypto.generateUuid();

    // Build the data object for hashing (sorted keys for deterministic hash)
    const data = {
      entry_id: entryId,
      title,
      duration: endEpoch ? (endEpoch - startEpoch) : 0,
      is_active: isActive,
      is_paused: false,
      start_epoch: startEpoch,
      end_epoch: endEpoch ?? null,
      pauses: [],
      tags: normalizedTags,
      media: media || [],
      device_uuid: deviceUuid || '',
      metadata: {},
    };
    if (comment != null) data.comment = comment;

    const hash = await this._hash(
      JSON.stringify(data, Object.keys(data).sort())
    );

    const entry = { ...data, hash };
    entries.push(entry);
    await this.writeEntries(entries);
    return hash.slice(0, 10);
  }

  /**
   * Update specific fields on an entry at the given index.
   *
   * @param {number} index - Entry index in the staging array.
   * @param {object} fields - Dict of field names to new values.
   * @throws {Error} If index is out of range.
   */
  async update(index, fields) {
    const entries = await this.readEntries();
    if (index < 0 || index >= entries.length) {
      throw new Error(`No staged entry at index ${index}.`);
    }

    const entry = entries[index];

    // Apply field updates
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'tags') {
        entry.tags = _normalizeTags(value);
      } else if (key === 'pauses') {
        entry.pauses = value;
      } else {
        entry[key] = value;
      }
    }

    // Recompute hash
    const { hash, entry_index, ...dataForHash } = entry;
    entry.hash = await this._hash(
      JSON.stringify(dataForHash, Object.keys(dataForHash).sort())
    );

    entries[index] = entry;
    await this.writeEntries(entries);
  }

  /**
   * Remove entry at the given index.
   *
   * @param {number} index
   * @throws {Error} If index is out of range.
   */
  async delete(index) {
    const entries = await this.readEntries();
    if (index < 0 || index >= entries.length) {
      throw new Error(`No staged entry at index ${index}.`);
    }
    entries.splice(index, 1);
    await this.writeEntries(entries);
  }

  /**
   * Remove entries at the specified indices.
   *
   * @param {number[]} indices - List of indices to remove.
   */
  async removeMultiple(indices) {
    if (!indices || indices.length === 0) return;
    const entries = await this.readEntries();
    // Sort descending so splice doesn't shift indices
    const sorted = [...indices].sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx >= 0 && idx < entries.length) {
        entries.splice(idx, 1);
      }
    }
    await this.writeEntries(entries);
  }

  // ------------------------------------------------------------------
  // Pause management
  // ------------------------------------------------------------------

  /**
   * Add a new open pause record to the entry at the given index.
   *
   * @param {number} index
   * @param {number} pauseEpoch - ms timestamp when pause started.
   * @param {string} [comment]
   * @throws {Error} If index is out of range.
   */
  async addPause(index, pauseEpoch, comment) {
    const entries = await this.readEntries();
    if (index < 0 || index >= entries.length) {
      throw new Error(`No staged entry at index ${index}.`);
    }

    const entry = entries[index];
    const pauseRecord = {
      pause_index: entry.pauses.length + 1,
      pause_start: pauseEpoch,
      pause_stop: null,
    };
    if (comment != null) pauseRecord.comment = comment;

    entry.pauses.push(pauseRecord);
    entry.is_paused = true;

    // Recompute hash
    const { hash, entry_index, ...dataForHash } = entry;
    entry.hash = await this._hash(
      JSON.stringify(dataForHash, Object.keys(dataForHash).sort())
    );
    entries[index] = entry;
    await this.writeEntries(entries);
  }

  /**
   * Close the last open pause record on the entry at the given index.
   *
   * @param {number} index
   * @param {number} stopEpoch - ms timestamp when pause ended.
   * @param {string} [comment]
   * @throws {Error} If index is out of range.
   */
  async closePause(index, stopEpoch, comment) {
    const entries = await this.readEntries();
    if (index < 0 || index >= entries.length) {
      throw new Error(`No staged entry at index ${index}.`);
    }

    const entry = entries[index];
    const pauses = entry.pauses;

    if (pauses.length > 0 && pauses[pauses.length - 1].pause_stop === null) {
      pauses[pauses.length - 1].pause_stop = stopEpoch;
      if (comment != null) {
        pauses[pauses.length - 1].comment = comment;
      }
    }

    entry.is_paused = false;

    // Recompute hash
    const { hash, entry_index, ...dataForHash } = entry;
    entry.hash = await this._hash(
      JSON.stringify(dataForHash, Object.keys(dataForHash).sort())
    );
    entries[index] = entry;
    await this.writeEntries(entries);
  }

  // ------------------------------------------------------------------
  // Duration computation
  // ------------------------------------------------------------------

  /**
   * Compute active duration as wall time minus all completed pause intervals.
   *
   * @param {number} startEpoch
   * @param {number|null} endEpoch
   * @param {Array} pauses - Array of {pause_start, pause_stop}.
   * @returns {number} Duration in ms (0 if endEpoch is null).
   */
  static computeDuration(startEpoch, endEpoch, pauses) {
    if (endEpoch == null) return 0;
    let totalPauseMs = 0;
    for (const p of (pauses || [])) {
      if (p.pause_stop != null) {
        totalPauseMs += p.pause_stop - p.pause_start;
      }
    }
    return Math.max(0, (endEpoch - startEpoch) - totalPauseMs);
  }

  // ------------------------------------------------------------------
  // Internal: SHA-256 via CryptoService
  // ------------------------------------------------------------------

  /**
   * Compute SHA-256 hash via the WASM CryptoService.
   * @param {string} data
   * @returns {Promise<string>} 64-char hex.
   * @private
   */
  async _hash(data) {
    return this._crypto.sha256(data);
  }
}

// ------------------------------------------------------------------
// Helpers (exported for testing)
// ------------------------------------------------------------------

/**
 * Normalize tags: lowercase, strip, dedup, remove empties, sort.
 *
 * @param {string[]|null|undefined} tags
 * @returns {string[]}
 */
export function _normalizeTags(tags) {
  if (!tags || !Array.isArray(tags) || tags.length === 0) return [];
  const seen = new Set();
  const result = [];
  for (const t of tags) {
    const clean = String(t).trim().toLowerCase();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  result.sort();
  return result;
}
