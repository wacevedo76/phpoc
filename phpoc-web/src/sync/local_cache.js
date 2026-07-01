/**
 * LocalCache — staging entry CRUD with local persistence.
 *
 * Port of domain/staging/local_cache.py to JS.
 *
 * Manages local staging entries via the StorageBackend. Storage format
 * canonicalized to PHPSPEC.md §3.1.1 (Bug 3b fix):
 *   - `_enc` suffix on encryptable field names
 *   - `plain:` prefix for staging (unencrypted) values per §8.2
 *   - `{hash, data: {...}}` wrapper around entry data
 *
 * readEntries() returns decrypted DTOs with flat field names
 * (start_epoch, end_epoch, pauses, etc.) for consumers. writeEntries()
 * accepts DTOs and converts them to the spec format for storage.
 *
 * Storage key: 'entries' → array of {hash, data, committed, block_index}
 *
 * Each entry (raw) carries:
 *   hash           — SHA-256 hex of sorted data
 *   data
 *     entry_id     — stable UUID
 *     title        — string
 *     startTime_enc — "plain:" + ms timestamp
 *     endTime_enc  — "plain:" + ms timestamp or undefined
 *     duration     — ms
 *     is_active    — boolean
 *     is_paused    — boolean
 *     pauses_enc   — "plain:" + JSON array
 *     tags         — string[]
 *     comment      — string or null
 *     media        — array
 *     device_uuid_enc — "plain:" + device UUID
 *     end_device_uuid_enc — "plain:" + device UUID
 *     metadata_enc — "plain:" + JSON object
 *   committed      — boolean
 *   block_index    — number or null
 *
 * Each entry (DTO, returned by readEntries) carries flat fields:
 *   entry_id, title, start_epoch, end_epoch, duration,
 *   is_active, is_paused, pauses, tags, comment, media,
 *   device_uuid, end_device_uuid, metadata, hash, entry_index,
 *   committed, block_index
 */

import { jsonSort } from '../ledger/utils.js';
import { parsePlainInt, parsePlainJSON } from './entry_dto.js';

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
 * @property {boolean} committed
 * @property {number|null} block_index
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
   * Converts raw {hash, data: {..._enc}} format to flat DTOs.
   * Each entry gets an `entry_index` property matching its position.
   *
   * @returns {Promise<StagingEntry[]>}
   */
  async readEntries() {
    const entries = (await this._storage.get(ENTRIES_KEY)) || [];
    return entries.map((raw, idx) => this._rawToDto(raw, idx));
  }

  /**
   * Write a list of DTOs to storage in spec format ({hash, data: {...}}).
   *
   * @param {StagingEntry[]} dtos
   * @returns {Promise<void>}
   */
  async writeEntries(dtos) {
    const rawEntries = dtos.map((dto) => this._dtoToRaw(dto));
    await this._storage.set(ENTRIES_KEY, rawEntries);
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
    const entries = await this._storage.get(ENTRIES_KEY) || [];

    // Collision check — read all DTOs to find start_epoch
    const dtos = entries.map((raw, idx) => this._rawToDto(raw, idx));
    for (const entry of dtos) {
      if (entry.start_epoch === startEpoch) {
        throw new Error(
          `Collision detected: A task has already started at this millisecond.`
        );
      }
    }

    const normalizedTags = _normalizeTags(tags);
    const entryId = this._crypto.generateUuid();

    // Build data object in spec format (§3.1.1)
    const data = {
      entry_id: entryId,
      title,
      duration: endEpoch ? (endEpoch - startEpoch) : 0,
      is_active: isActive,
      is_paused: false,
      startTime_enc: `plain:${startEpoch}`,
      endTime_enc: endEpoch != null ? `plain:${endEpoch}` : undefined,
      pauses_enc: 'plain:[]',
      tags: normalizedTags,
      media: media || [],
      device_uuid_enc: `plain:${deviceUuid || ''}`,
      end_device_uuid_enc: 'plain:',
      metadata_enc: 'plain:{}',
    };
    if (comment != null) data.comment = comment;

    const hash = await this._hashData(data);

    // Remove undefined fields before storing
    const cleanData = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) cleanData[k] = v;
    }

    const rawEntry = {
      hash,
      data: cleanData,
      committed: false,
      block_index: null,
    };

    entries.push(rawEntry);
    await this._storage.set(ENTRIES_KEY, entries);
    return hash.slice(0, 10);
  }

  /**
   * Update specific fields on an entry at the given index.
   *
   * Accepts flat DTO field names (e.g., `end_epoch`, `is_active`).
   * Converts them to `_enc` format internally.
   *
   * @param {number} index - Entry index in the staging array.
   * @param {object} fields - Dict of DTO field names to new values.
   * @throws {Error} If index is out of range.
   */
  async update(index, fields) {
    // Read raw entries
    const rawEntries = (await this._storage.get(ENTRIES_KEY)) || [];
    if (index < 0 || index >= rawEntries.length) {
      throw new Error(`No staged entry at index ${index}.`);
    }

    const raw = rawEntries[index];

    // Guard: refuse to modify an already-committed entry
    if (raw.committed) {
      return;
    }

    const data = raw.data || {};

    // Apply field updates, mapping DTO field names to _enc field names
    for (const [key, value] of Object.entries(fields)) {
      const encKey = _dtoKeyToEncKey(key);
      if (encKey) {
        if (encKey === 'pauses_enc') {
          data.pauses_enc = `plain:${JSON.stringify(value || [])}`;
        } else if (encKey === 'metadata_enc') {
          data.metadata_enc = `plain:${JSON.stringify(value || {})}`;
        } else if (encKey === 'startTime_enc' || encKey === 'endTime_enc' ||
                   encKey === 'device_uuid_enc' || encKey === 'end_device_uuid_enc') {
          data[encKey] = `plain:${value ?? ''}`;
        } else {
          data[encKey] = value;
        }
      } else if (key === 'tags') {
        data.tags = _normalizeTags(value);
      } else if (key === 'is_active' || key === 'is_paused' ||
                 key === 'duration' || key === 'title' || key === 'comment' ||
                 key === 'media') {
        data[key] = value;
      }
    }

    // Re-read from storage right before writing to detect races
    const fresh = (await this._storage.get(ENTRIES_KEY)) || [];
    if (index >= fresh.length) {
      return; // Entry was deleted concurrently
    }
    const freshRaw = fresh[index];
    if (!freshRaw.data) return;

    // Check: did another operation commit or replace this entry?
    if (freshRaw.data.entry_id !== data.entry_id) {
      return; // A different entry is now at this index
    }
    if (freshRaw.committed) {
      return; // Already committed by another operation
    }

    // Apply the same field updates to the fresh entry
    for (const [key, value] of Object.entries(fields)) {
      const encKey = _dtoKeyToEncKey(key);
      const fd = freshRaw.data;
      if (encKey) {
        if (encKey === 'pauses_enc') {
          fd.pauses_enc = `plain:${JSON.stringify(value || [])}`;
        } else if (encKey === 'metadata_enc') {
          fd.metadata_enc = `plain:${JSON.stringify(value || {})}`;
        } else if (encKey === 'startTime_enc' || encKey === 'endTime_enc' ||
                   encKey === 'device_uuid_enc' || encKey === 'end_device_uuid_enc') {
          fd[encKey] = `plain:${value ?? ''}`;
        } else {
          fd[encKey] = value;
        }
      } else if (key === 'tags') {
        fd.tags = _normalizeTags(value);
      } else if (key === 'is_active' || key === 'is_paused' ||
                 key === 'duration' || key === 'title' || key === 'comment' ||
                 key === 'media') {
        fd[key] = value;
      }
    }

    // Recompute hash from final data
    freshRaw.hash = await this._hashData(freshRaw.data);
    fresh[index] = freshRaw;
    await this._storage.set(ENTRIES_KEY, fresh);
  }

  /**
   * Mark one or more entries as committed to the ledger.
   *
   * @param {string[]} entryIds - Entry UUIDs to mark.
   * @param {number} blockIndex - The block index these entries were committed in.
   */
  async markCommitted(entryIds, blockIndex) {
    if (!entryIds || entryIds.length === 0) return;
    const rawEntries = (await this._storage.get(ENTRIES_KEY)) || [];
    let changed = false;
    for (const raw of rawEntries) {
      if (raw.data && entryIds.includes(raw.data.entry_id)) {
        raw.committed = true;
        raw.block_index = blockIndex;
        changed = true;
      }
    }
    if (changed) {
      await this._storage.set(ENTRIES_KEY, rawEntries);
    }
  }

  /**
   * Remove entry at the given index.
   *
   * @param {number} index
   * @throws {Error} If index is out of range.
   */
  async delete(index) {
    const rawEntries = (await this._storage.get(ENTRIES_KEY)) || [];
    if (index < 0 || index >= rawEntries.length) {
      throw new Error(`No staged entry at index ${index}.`);
    }
    rawEntries.splice(index, 1);
    await this._storage.set(ENTRIES_KEY, rawEntries);
  }

  /**
   * Remove entries at the specified indices.
   *
   * @param {number[]} indices - List of indices to remove.
   */
  async removeMultiple(indices) {
    if (!indices || indices.length === 0) return;
    const rawEntries = (await this._storage.get(ENTRIES_KEY)) || [];
    // Sort descending so splice doesn't shift indices
    const sorted = [...indices].sort((a, b) => b - a);
    for (const idx of sorted) {
      if (idx >= 0 && idx < rawEntries.length) {
        rawEntries.splice(idx, 1);
      }
    }
    await this._storage.set(ENTRIES_KEY, rawEntries);
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
    const rawEntries = (await this._storage.get(ENTRIES_KEY)) || [];
    if (index < 0 || index >= rawEntries.length) {
      throw new Error(`No staged entry at index ${index}.`);
    }

    const raw = rawEntries[index];
    const data = raw.data || {};

    // Parse existing pauses
    let pauses = [];
    const pausesRaw = data.pauses_enc || 'plain:[]';
    if (pausesRaw.startsWith('plain:')) {
      try { pauses = JSON.parse(pausesRaw.slice(6)); } catch { pauses = []; }
    }

    const pauseRecord = {
      pause_index: pauses.length + 1,
      pause_start: pauseEpoch,
      pause_stop: null,
    };
    if (comment != null) pauseRecord.comment = comment;

    pauses.push(pauseRecord);
    data.pauses_enc = `plain:${JSON.stringify(pauses)}`;
    data.is_paused = true;

    // Recompute hash
    raw.hash = await this._hashData(data);
    rawEntries[index] = raw;
    await this._storage.set(ENTRIES_KEY, rawEntries);
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
    const rawEntries = (await this._storage.get(ENTRIES_KEY)) || [];
    if (index < 0 || index >= rawEntries.length) {
      throw new Error(`No staged entry at index ${index}.`);
    }

    const raw = rawEntries[index];
    const data = raw.data || {};

    // Parse existing pauses
    let pauses = [];
    const pausesRaw = data.pauses_enc || 'plain:[]';
    if (pausesRaw.startsWith('plain:')) {
      try { pauses = JSON.parse(pausesRaw.slice(6)); } catch { pauses = []; }
    }

    if (pauses.length > 0 && pauses[pauses.length - 1].pause_stop === null) {
      pauses[pauses.length - 1].pause_stop = stopEpoch;
      if (comment != null) {
        pauses[pauses.length - 1].comment = comment;
      }
    }

    data.pauses_enc = `plain:${JSON.stringify(pauses)}`;
    data.is_paused = false;

    // Recompute hash
    raw.hash = await this._hashData(data);
    rawEntries[index] = raw;
    await this._storage.set(ENTRIES_KEY, rawEntries);
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
  // Format conversion helpers
  // ------------------------------------------------------------------

  /**
   * Convert a raw entry ({hash, data: {..._enc}}) to a flat DTO.
   * @param {object} raw
   * @param {number} idx
   * @returns {StagingEntry}
   * @private
   */
  _rawToDto(raw, idx) {
    const data = raw.data || {};

    const startEpochStr = data.startTime_enc || '';
    const startEpoch = parsePlainInt(startEpochStr);

    const endEpochStr = data.endTime_enc;
    const endEpoch = endEpochStr ? parsePlainInt(endEpochStr) : null;

    const pausesRaw = data.pauses_enc || 'plain:[]';
    let pauses = [];
    if (pausesRaw.startsWith('plain:')) {
      try { pauses = JSON.parse(pausesRaw.slice(6)); } catch { /* ignore */ }
    }

    const metadataRaw = data.metadata_enc || 'plain:{}';
    let metadata = {};
    if (metadataRaw.startsWith('plain:')) {
      try { metadata = JSON.parse(metadataRaw.slice(6)); } catch { /* ignore */ }
    }

    const deviceUuidRaw = data.device_uuid_enc || '';
    const device_uuid = deviceUuidRaw.startsWith('plain:')
      ? deviceUuidRaw.slice(6)
      : deviceUuidRaw;

    const endDeviceUuidRaw = data.end_device_uuid_enc || '';
    const end_device_uuid = endDeviceUuidRaw.startsWith('plain:')
      ? endDeviceUuidRaw.slice(6)
      : endDeviceUuidRaw;

    return {
      entry_id: data.entry_id || '',
      title: data.title || '',
      start_epoch: startEpoch || 0,
      end_epoch: endEpoch,
      duration: data.duration || 0,
      is_active: data.is_active || false,
      is_paused: data.is_paused || false,
      pauses,
      tags: data.tags || [],
      comment: data.comment || null,
      media: data.media || [],
      device_uuid,
      end_device_uuid,
      metadata,
      hash: raw.hash || '',
      entry_index: idx,
      committed: raw.committed || false,
      block_index: raw.block_index ?? null,
    };
  }

  /**
   * Convert a flat DTO to raw {hash, data: {..._enc}} format.
   * Recomputation of hash is done with the current data state.
   * @param {StagingEntry} dto
   * @returns {object}
   * @private
   */
  _dtoToRaw(dto) {
    const data = {
      entry_id: dto.entry_id || '',
      title: dto.title || '',
      startTime_enc: `plain:${dto.start_epoch ?? 0}`,
      endTime_enc: dto.end_epoch != null ? `plain:${dto.end_epoch}` : undefined,
      duration: dto.duration || 0,
      is_active: dto.is_active ?? true,
      is_paused: dto.is_paused ?? false,
      pauses_enc: `plain:${JSON.stringify(dto.pauses || [])}`,
      tags: dto.tags || [],
      media: dto.media || [],
      device_uuid_enc: `plain:${dto.device_uuid || ''}`,
      end_device_uuid_enc: `plain:${dto.end_device_uuid || ''}`,
      metadata_enc: `plain:${JSON.stringify(dto.metadata || {})}`,
    };
    if (dto.comment != null) data.comment = dto.comment;

    // Remove undefined fields
    const cleanData = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) cleanData[k] = v;
    }

    return {
      hash: dto.hash || '',
      data: cleanData,
      committed: dto.committed || false,
      block_index: dto.block_index ?? null,
    };
  }

  // ------------------------------------------------------------------
  // Internal: SHA-256 via CryptoService
  // ------------------------------------------------------------------

  /**
   * Compute SHA-256 hash of a data object (sorted keys).
   * @param {object} data
   * @returns {Promise<string>} 64-char hex.
   * @private
   */
  async _hashData(data) {
    const sorted = {};
    for (const k of Object.keys(data).sort()) {
      if (data[k] !== undefined) sorted[k] = data[k];
    }
    return this._crypto.sha256(JSON.stringify(sorted));
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

/**
 * Map a DTO field name to its `_enc` storage key.
 * Returns null for non-encryptable fields (handled separately).
 *
 * @param {string} dtoKey
 * @returns {string|null}
 */
function _dtoKeyToEncKey(dtoKey) {
  const mapping = {
    'start_epoch': 'startTime_enc',
    'end_epoch': 'endTime_enc',
    'pauses': 'pauses_enc',
    'metadata': 'metadata_enc',
    'device_uuid': 'device_uuid_enc',
    'end_device_uuid': 'end_device_uuid_enc',
  };
  return mapping[dtoKey] || null;
}
