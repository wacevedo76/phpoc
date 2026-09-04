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
 * Storage key: 'entries' → array of {hash, data, committed, block_index, updated_at}
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
 *   updated_at     — number (ms) last-modified timestamp; wrapper-level
 *                    metadata, NOT part of the hashed `data`
 *
 * Each entry (DTO, returned by readEntries) carries flat fields:
 *   entry_id, title, start_epoch, end_epoch, duration,
 *   is_active, is_paused, pauses, tags, comment, media,
 *   device_uuid, end_device_uuid, metadata, hash, entry_index,
 *   committed, block_index, updated_at
 */

import { jsonSortIndent2 } from '../ledger/utils.js';
import { parsePlainInt, parsePlainJSON } from './entry_dto.js';
import { generateActivityId } from './activity_id.js';
import { buildStagingHashIndex } from './staging_hash_index.js';
import { LOCAL_STAGING_HASH_INDEX } from './keys.js';

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
 * @property {number} [updated_at] - Last-modified timestamp (ms); backfilled to
 *   start_epoch by _rawToDto when the raw wrapper lacks it.
 */

const ENTRIES_KEY = 'entries';

export class LocalCache {
  /**
   * @param {import('./storage.js').StorageBackend} storage - Storage backend.
   * @param {import('../crypto/index.js').CryptoService} crypto - WASM CryptoService
   *   (for UUID generation and SHA-256 hashing).
   * @param {object} [options]
   * @param {() => string} [options.generateId] - Injectible activity_id generator (test seam).
   * @param {() => number} [options.now] - Injectible clock (test seam); defaults to Date.now.
   */
  constructor(storage, crypto, options = {}) {
    /** @private */
    this._storage = storage;
    /** @private */
    this._crypto = crypto;
    /** @private */
    this._generateId = options.generateId || generateActivityId;
    /** @private */
    this._now = options.now || Date.now;
  }

  // ------------------------------------------------------------------
  // Internal: encrypt/decrypt helpers (plain: → hex via crypto)
  // ------------------------------------------------------------------

  /**
   * Encrypt a value for storage. Delegates to crypto (AES-CTR hex) when
   * MK is available, falls back to plain: prefix when not.
   *
   * The guard checks both that the hasMasterKey *method* exists (mock
   * crypto may lack it) AND that it reports a cached key.  The first
   * check is a no-op for the real CryptoService (method always present)
   * but keeps mocks working without requiring them to implement it.
   *
   * @param {*} value
   * @returns {string}
   * @private
   */
  _encrypt(value) {
    if (!this._crypto.hasMasterKey || !this._crypto.hasMasterKey()) {
      return 'plain:' + String(value);
    }
    return this._crypto.encryptWithCachedKey(String(value));
  }

  /**
   * Decrypt a field value from storage. Handles both plain: (legacy) and
   * hex ciphertext (post I-03).
   * @param {string|null|undefined} value
   * @returns {string|null}
   * @private
   */
  _decrypt(value) {
    if (value == null) return null;
    if (typeof value !== 'string') return String(value);
    if (value.startsWith('plain:')) return value.slice(6);
    try {
      return this._crypto.decryptWithCachedKey(value);
    } catch {
      return null;
    }
  }

  /**
   * Decrypt and parse as integer.
   * @param {string|null|undefined} value
   * @returns {number|null}
   * @private
   */
  _decryptInt(value) {
    const decrypted = this._decrypt(value);
    if (decrypted == null) return null;
    const n = parseInt(decrypted, 10);
    return isNaN(n) ? null : n;
  }

  // ------------------------------------------------------------------
  // Field-name encryption (I-02)
  // ------------------------------------------------------------------

  /**
   * Field-name → hex-token cache.  Tied to the current master key —
   * the LocalCache instance (and therefore this cache) is recreated
   * on login/logout, so stale tokens after key rotation are not a
   * concern in normal operation.
   * @type {Map<string, string>}
   */
  _fieldTokenCache = new Map();

  /**
   * Encryptable field names that get tokenized in storage.
   * @private
   */
  _ENCRYPTABLE_FIELDS = [
    'startTime_enc', 'endTime_enc', 'pauses_enc',
    'metadata_enc', 'device_uuid_enc', 'end_device_uuid_enc',
  ];

  /**
   * Compute a deterministic, per-user token for a field name.
   *
   * Uses HMAC-SHA256(fieldKey, fieldName), where fieldKey is derived from
   * the master key via domain-separated HMAC. Same user → same tokens;
   * different users → different tokens (field names are not reversible
   * without the master key).
   *
   * Falls back to plaintext field names when no master key is available
   * (no-auth fallback).
   *
   * @param {string} fieldName
   * @returns {string}
   * @private
   */
  _fieldToken(fieldName) {
    // No master key → use plaintext field names (no-auth fallback)
    if (!this._crypto.hasMasterKey || !this._crypto.hasMasterKey()) {
      return fieldName;
    }
    if (this._fieldTokenCache.has(fieldName)) {
      return this._fieldTokenCache.get(fieldName);
    }
    // Use deriveFieldKey + hmacHex when available (I-02a MK-dependent tokens).
    // Fall back to SHA-256 for test mocks that predate these methods.
    let token;
    if (typeof this._crypto.deriveFieldKey === 'function' && typeof this._crypto.hmacHex === 'function') {
      const fieldKey = this._crypto.deriveFieldKey(this._crypto.getMasterKey());
      token = this._crypto.hmacHex(fieldKey, fieldName).slice(0, 16);
    } else {
      token = this._crypto.sha256('phpoc-staging-keys-v1' + fieldName).slice(0, 16);
    }
    this._fieldTokenCache.set(fieldName, token);
    return token;
  }

  /**
   * Build reverse map from tokens → field names.
   * @returns {Map<string, string>}
   * @private
   */
  _buildFieldTokenMap() {
    const map = new Map();
    for (const name of this._ENCRYPTABLE_FIELDS) {
      const token = this._fieldToken(name);
      map.set(token, name);
    }
    return map;
  }

  /**
   * Check if raw data uses legacy plaintext _enc key names.
   * @param {object} data
   * @returns {boolean}
   * @private
   */
  static _isLegacyData(data) {
    if (!data || typeof data !== 'object') return false;
    return Object.keys(data).some(k => k.endsWith('_enc'));
  }

  /**
   * Decode encrypted field-name tokens → standard _enc key names.
   * Legacy _enc keys pass through as-is.
   * @param {object} data
   * @returns {object}
   * @private
   */
  _decodeDataKeys(data) {
    if (!data || typeof data !== 'object') return {};
    // Legacy format: pass through
    if (LocalCache._isLegacyData(data)) return { ...data };

    const tokenMap = this._buildFieldTokenMap();
    const decoded = {};
    for (const [key, value] of Object.entries(data)) {
      if (tokenMap.has(key)) {
        decoded[tokenMap.get(key)] = value;
      } else {
        decoded[key] = value;
      }
    }
    return decoded;
  }

  /**
   * Encode standard _enc key names → encrypted tokens.
   * Non-encryptable fields pass through as-is.
   * @param {object} data
   * @returns {object}
   * @private
   */
  _encodeDataKeys(data) {
    if (!data || typeof data !== 'object') return {};
    // No master key → keep plaintext keys
    if (!this._crypto.hasMasterKey || !this._crypto.hasMasterKey()) {
      return { ...data };
    }
    const encoded = {};
    for (const [key, value] of Object.entries(data)) {
      if (this._ENCRYPTABLE_FIELDS.includes(key)) {
        const token = this._fieldToken(key);
        encoded[token] = value;
      } else {
        encoded[key] = value;
      }
    }
    return encoded;
  }

  /**
   * Compute deterministic entry hash from plaintext DTO fields.
   * Independent of encryption nonces so same data always produces same hash.
   * @param {object} dto
   * @returns {Promise<string>} 64-char hex hash
   * @private
   */
  async _computeEntryHash(dto) {
    const fields = {
      title: dto.title || '',
      start_epoch: dto.start_epoch ?? 0,
      end_epoch: dto.end_epoch ?? null,
      duration: dto.duration || 0,
      is_active: dto.is_active ?? true,
      is_paused: dto.is_paused ?? false,
      pauses: dto.pauses || [],
      tags: dto.tags || [],
      media: dto.media || [],
      entry_id: dto.entry_id || '',
      metadata: dto.metadata || {},
      device_uuid: dto.device_uuid || '',
      end_device_uuid: dto.end_device_uuid || '',
    };
    if (dto.comment != null) fields.comment = dto.comment;
    return this._crypto.sha256(jsonSortIndent2(fields));
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
  // Field encryption helpers (encrypt_title, encrypt_tags, etc.)
  // ------------------------------------------------------------------

  /**
   * Encrypt value using cached MK, falling back to plain: prefix.
   * @param {string} value
   * @returns {string}
   * @private
   */
  _encryptValue(value) {
    if (!this._crypto.hasMasterKey || !this._crypto.hasMasterKey()) {
      return 'plain:' + String(value);
    }
    return this._crypto.encryptWithCachedKey(String(value));
  }

  /**
   * Decrypt field value, handling plain:, hex, and null.
   * @param {string|null|undefined} value
   * @returns {string|null}
   * @private
   */
  _decryptValue(value) {
    return this._decrypt(value);
  }

  /**
   * Apply per-field encryption to the raw data object after hash computation.
   * Moves plaintext fields to _enc variants when encryption flags are set.
   * Does NOT encrypt structural fields (is_active, is_paused).
   *
   * @param {object} data - Raw data object (mutated in place)
   * @param {object} flags
   * @param {string} flags.title
   * @param {string[]} flags.tags
   * @param {string|null} flags.comment
   * @param {number} flags.duration
   * @param {boolean} flags.encrypt_title
   * @param {boolean} flags.encrypt_tags
   * @param {boolean} flags.encrypt_comment
   * @param {boolean} flags.encrypt_duration
   * @private
   */
  _applyEntryEncryption(data, flags) {
    if (flags.encrypt_title) {
      data.title_enc = this._encryptValue(flags.title || '');
      delete data.title;
    }
    if (flags.encrypt_tags) {
      data.tags_enc = this._encryptValue(JSON.stringify(flags.tags || []));
      delete data.tags;
    }
    if (flags.encrypt_comment) {
      if (flags.comment != null) {
        data.comment_enc = this._encryptValue(flags.comment);
        delete data.comment;
      }
      // null comment with encryption flag: skip (don't encrypt null)
    }
    if (flags.encrypt_duration) {
      data.duration_enc = this._encryptValue(String(flags.duration));
      delete data.duration;
    }
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
   * @param {boolean} [params.encrypt_title=false] - Encrypt title field
   * @param {boolean} [params.encrypt_tags=false] - Encrypt tags field
   * @param {boolean} [params.encrypt_comment=false] - Encrypt comment field
   * @param {boolean} [params.encrypt_duration=false] - Encrypt duration field
   * @param {boolean} [params.encrypt_all=false] - Encrypt all 4 fields
   * @returns {Promise<string>} The entry hash prefix (10 chars).
   * @throws {Error} If a collision is detected (same start_epoch).
   */
  async append({ title, startEpoch, endEpoch, isActive = true, tags, comment, media, deviceUuid,
                encrypt_title = false, encrypt_tags = false, encrypt_comment = false,
                encrypt_duration = false, encrypt_all = false }) {
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
    const activityId = this._generateId();

    // Build data object in spec format (§3.1.1)
    const data = {
      activity_id: activityId,
      entry_id: entryId,
      title,
      duration: endEpoch ? (endEpoch - startEpoch) : 0,
      is_active: isActive,
      is_paused: false,
      startTime_enc: this._encrypt(startEpoch),
      endTime_enc: endEpoch != null ? this._encrypt(endEpoch) : undefined,
      pauses_enc: this._encrypt('[]'),
      tags: normalizedTags,
      media: media || [],
      device_uuid_enc: this._encrypt(deviceUuid || ''),
      end_device_uuid_enc: this._encrypt(''),
      metadata_enc: this._encrypt('{}'),
    };
    if (comment != null) data.comment = comment;

    // Determine effective encryption flags (encrypt_all overrides)
    const effEncTitle = encrypt_all || encrypt_title;
    const effEncTags = encrypt_all || encrypt_tags;
    const effEncComment = encrypt_all || encrypt_comment;
    const effEncDuration = encrypt_all || encrypt_duration;

    const hash = await this._computeEntryHash({
      title,
      start_epoch: startEpoch,
      end_epoch: endEpoch ?? null,
      duration: endEpoch ? (endEpoch - startEpoch) : 0,
      is_active: isActive,
      is_paused: false,
      pauses: [],
      tags: normalizedTags,
      media: media || [],
      entry_id: entryId,
      metadata: {},
      device_uuid: deviceUuid || '',
      end_device_uuid: '',
      comment: comment ?? undefined,
    });

    // Apply field encryption after hash computation (hash uses plaintext)
    this._applyEntryEncryption(data, {
      title, tags: normalizedTags, comment: comment ?? null,
      duration: endEpoch ? (endEpoch - startEpoch) : 0,
      encrypt_title: effEncTitle, encrypt_tags: effEncTags,
      encrypt_comment: effEncComment, encrypt_duration: effEncDuration,
    });

    // Remove undefined fields before storing
    const cleanData = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) cleanData[k] = v;
    }

    // Encrypt field key names (I-02)
    const encodedData = this._encodeDataKeys(cleanData);

    const rawEntry = {
      hash,
      data: encodedData,
      committed: false,
      block_index: null,
      updated_at: this._now(),
    };

    entries.push(rawEntry);
    await this._storage.set(ENTRIES_KEY, entries);

    await this._safeRefreshHashIndex();

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

    const rawData = raw.data || {};
    // Decode encrypted field-name tokens → standard _enc keys
    const data = this._decodeDataKeys(rawData);

    // Apply field updates, mapping DTO field names to _enc field names
    this._applyFieldsToData(data, fields);

    // Re-read from storage right before writing to detect races
    const fresh = (await this._storage.get(ENTRIES_KEY)) || [];
    if (index >= fresh.length) {
      return; // Entry was deleted concurrently
    }
    const freshRaw = fresh[index];
    if (!freshRaw.data) return;

    // Decode fresh data keys
    const freshData = this._decodeDataKeys(freshRaw.data);

    // Check: did another operation commit or replace this entry?
    if (freshData.entry_id !== data.entry_id) {
      return; // A different entry is now at this index
    }
    if (freshRaw.committed) {
      return; // Already committed by another operation
    }

    // Apply the same field updates to the fresh entry
    this._applyFieldsToData(freshData, fields);

    // Encode field key names before writing
    freshRaw.data = this._encodeDataKeys(freshData);

    // Recompute hash from plaintext DTO fields
    freshRaw.hash = await this._computeEntryHash(this._rawToDto(freshRaw, index));
    freshRaw.updated_at = this._now();
    fresh[index] = freshRaw;
    await this._storage.set(ENTRIES_KEY, fresh);

    await this._safeRefreshHashIndex();
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

    await this._safeRefreshHashIndex();
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

    await this._safeRefreshHashIndex();
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

    await this._safeRefreshHashIndex();
  }

  /**
   * Apply a fields dict ({dtoKey: value}) to an already-decoded data
   * object in-place.  Handles DTO→_enc key mapping, tag normalization,
   * and encryption of sensitive values.
   *
   * @param {object} data - Decoded data dict (standard _enc keys).
   * @param {object} fields - Fields to apply ({dtoKey: value}).
   * @private
   */
  _applyFieldsToData(data, fields) {
    for (const [key, value] of Object.entries(fields)) {
      const encKey = _dtoKeyToEncKey(key);
      if (encKey) {
        if (encKey === 'pauses_enc') {
          data.pauses_enc = this._encrypt(JSON.stringify(value || []));
        } else if (encKey === 'metadata_enc') {
          data.metadata_enc = this._encrypt(JSON.stringify(value || {}));
        } else if (encKey === 'startTime_enc' || encKey === 'endTime_enc' ||
                   encKey === 'device_uuid_enc' || encKey === 'end_device_uuid_enc') {
          data[encKey] = this._encrypt(value ?? '');
        } else {
          data[encKey] = value;
        }
      } else if (key === 'tags') {
        data.tags = _normalizeTags(value);
      } else if (key === 'is_active' || key === 'is_paused' ||
                 key === 'duration' || key === 'title' || key === 'comment' ||
                 key === 'media') {
        data[key] = value;
      } else if (key === 'encrypt_title') {
        if (value && data.title != null) {
          data.title_enc = this._encryptValue(data.title);
          delete data.title;
        } else if (!value && data.title_enc) {
          const decTitle = this._decryptValue(data.title_enc);
          data.title = (decTitle != null) ? decTitle : '';
          delete data.title_enc;
        }
      } else if (key === 'encrypt_tags') {
        if (value && data.tags != null) {
          data.tags_enc = this._encryptValue(JSON.stringify(data.tags));
          delete data.tags;
        } else if (!value && data.tags_enc) {
          const decTags = this._decryptValue(data.tags_enc);
          try { data.tags = decTags ? JSON.parse(decTags) : []; } catch { data.tags = []; }
          delete data.tags_enc;
        }
      } else if (key === 'encrypt_comment') {
        if (value && data.comment != null) {
          data.comment_enc = this._encryptValue(data.comment);
          delete data.comment;
        } else if (!value && data.comment_enc) {
          data.comment = this._decryptValue(data.comment_enc) || null;
          delete data.comment_enc;
        }
      } else if (key === 'encrypt_duration') {
        if (value && data.duration != null) {
          data.duration_enc = this._encryptValue(String(data.duration));
          delete data.duration;
        } else if (!value && data.duration_enc) {
          const decDur = this._decryptValue(data.duration_enc);
          data.duration = (decDur != null) ? parseInt(decDur, 10) : 0;
          delete data.duration_enc;
        }
      }
    }
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
    const rawData = raw.data || {};
    // Decode encrypted field-name tokens
    const data = this._decodeDataKeys(rawData);

    // Parse existing pauses
    let pauses = [];
    const pausesRaw = data.pauses_enc;
    if (pausesRaw) {
      const decrypted = this._decrypt(pausesRaw);
      if (decrypted) {
        try { pauses = JSON.parse(decrypted); } catch { pauses = []; }
      }
    }

    const pauseRecord = {
      pause_index: pauses.length + 1,
      pause_start: pauseEpoch,
      pause_stop: null,
    };
    if (comment != null) pauseRecord.comment = comment;

    pauses.push(pauseRecord);
    data.pauses_enc = this._encrypt(JSON.stringify(pauses));
    data.is_paused = true;

    // Re-encode field key names
    raw.data = this._encodeDataKeys(data);

    // Recompute hash from plaintext DTO fields
    raw.hash = await this._computeEntryHash(this._rawToDto(raw, index));
    raw.updated_at = this._now();
    rawEntries[index] = raw;
    await this._storage.set(ENTRIES_KEY, rawEntries);

    await this._safeRefreshHashIndex();
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
    const rawData = raw.data || {};
    // Decode encrypted field-name tokens
    const data = this._decodeDataKeys(rawData);

    // Parse existing pauses
    let pauses = [];
    const pausesRaw = data.pauses_enc;
    if (pausesRaw) {
      const decrypted = this._decrypt(pausesRaw);
      if (decrypted) {
        try { pauses = JSON.parse(decrypted); } catch { pauses = []; }
      }
    }

    if (pauses.length > 0 && pauses[pauses.length - 1].pause_stop === null) {
      pauses[pauses.length - 1].pause_stop = stopEpoch;
      if (comment != null) {
        pauses[pauses.length - 1].comment = comment;
      }
    }

    data.pauses_enc = this._encrypt(JSON.stringify(pauses));
    data.is_paused = false;

    // Re-encode field key names
    raw.data = this._encodeDataKeys(data);

    // Recompute hash from plaintext DTO fields
    raw.hash = await this._computeEntryHash(this._rawToDto(raw, index));
    raw.updated_at = this._now();
    rawEntries[index] = raw;
    await this._storage.set(ENTRIES_KEY, rawEntries);

    await this._safeRefreshHashIndex();
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
  // Staging hash index
  // ------------------------------------------------------------------

  /**
   * Refresh the hash index, silently ignoring failures.
   *
   * Index is always rebuildable from entries — this is a best-effort cache.
   *
   * @private
   */
  async _safeRefreshHashIndex() {
    try {
      await this._refreshHashIndex();
    } catch {
      // Non-critical — index always rebuildable
    }
  }

  /**
   * Rebuild the staging hash index from current entries and persist.
   *
   * @private
   */
  async _refreshHashIndex() {
    const entries = await this.readEntries();
    const hashIndex = buildStagingHashIndex(entries);
    await this._storage.set(LOCAL_STAGING_HASH_INDEX, hashIndex);
  }

  /**
   * Read the staging hash index from local storage.
   *
   * Returns the cached index if available. Does NOT rebuild from entries.
   * Use after a successful remote pull to compare against the remote index.
   *
   * @returns {Promise<{id: string, status: string}[]>}
   */
  async readHashIndex() {
    return (await this._storage.get(LOCAL_STAGING_HASH_INDEX)) || [];
  }

  /**
   * Write a staging hash index to local storage.
   *
   * Used after pulling and decrypting the remote hash index to cache it.
   *
   * @param {{id: string, status: string}[]} index
   * @returns {Promise<void>}
   */
  async writeHashIndex(index) {
    await this._storage.set(LOCAL_STAGING_HASH_INDEX, index || []);
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
    const rawData = raw.data || {};
    // Decode encrypted field-name tokens → standard _enc keys
    const data = this._decodeDataKeys(rawData);

    const startEpochStr = data.startTime_enc || '';
    const startEpoch = this._decryptInt(startEpochStr);

    const endEpochStr = data.endTime_enc;
    const endEpoch = endEpochStr ? this._decryptInt(endEpochStr) : null;

    const pausesRaw = data.pauses_enc;
    let pauses = [];
    if (pausesRaw) {
      const decrypted = this._decrypt(pausesRaw);
      if (decrypted) {
        try { pauses = JSON.parse(decrypted); } catch { /* ignore */ }
      }
    }

    const metadataRaw = data.metadata_enc;
    let metadata = {};
    if (metadataRaw) {
      const decrypted = this._decrypt(metadataRaw);
      if (decrypted) {
        try { metadata = JSON.parse(decrypted); } catch { /* ignore */ }
      }
    }

    const deviceUuidRaw = data.device_uuid_enc || '';
    const device_uuid = this._decrypt(deviceUuidRaw) || '';

    const endDeviceUuidRaw = data.end_device_uuid_enc || '';
    const end_device_uuid = this._decrypt(endDeviceUuidRaw) || '';

    // Decrypt new encryptable fields (title_enc, tags_enc, comment_enc, duration_enc)
    let title = data.title || '';
    let tags = data.tags || [];
    let comment = data.comment || null;
    let duration = data.duration || 0;
    let hasEncryptedFields = false;
    const hasMK = this._crypto.hasMasterKey && this._crypto.hasMasterKey();

    if (data.title_enc) {
      hasEncryptedFields = true;
      if (hasMK) {
        const decTitle = this._decryptValue(data.title_enc);
        title = (decTitle != null) ? decTitle : '';
      } else {
        title = '';  // No MK → can't decrypt, show empty
      }
    }

    if (data.tags_enc) {
      hasEncryptedFields = true;
      if (hasMK) {
        const decTags = this._decryptValue(data.tags_enc);
        if (decTags != null) {
          try { tags = JSON.parse(decTags); } catch { tags = []; }
        } else {
          tags = [];
        }
      } else {
        tags = [];
      }
    }

    if (data.comment_enc) {
      hasEncryptedFields = true;
      if (hasMK) {
        const decComment = this._decryptValue(data.comment_enc);
        comment = (decComment != null) ? decComment : null;
      } else {
        comment = null;
      }
    }

    if (data.duration_enc) {
      hasEncryptedFields = true;
      if (hasMK) {
        const decDuration = this._decryptValue(data.duration_enc);
        duration = (decDuration != null) ? parseInt(decDuration, 10) : 0;
        if (isNaN(duration)) duration = 0;
      } else {
        duration = 0;
      }
    }

    return {
      activity_id: data.activity_id || '',
      entry_id: data.entry_id || '',
      title,
      start_epoch: startEpoch || 0,
      end_epoch: endEpoch,
      duration,
      is_active: data.is_active || false,
      is_paused: data.is_paused || false,
      pauses,
      tags,
      comment,
      media: data.media || [],
      device_uuid,
      end_device_uuid,
      metadata,
      hash: raw.hash || '',
      entry_index: idx,
      committed: raw.committed || false,
      block_index: raw.block_index ?? null,
      has_encrypted_fields: hasEncryptedFields,
      updated_at: raw.updated_at ?? (startEpoch || 0),
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
    const activityId = dto.activity_id;
    const data = {
      activity_id: activityId || undefined,
      entry_id: dto.entry_id || '',
      title: dto.title || '',
      startTime_enc: this._encrypt(dto.start_epoch ?? 0),
      endTime_enc: dto.end_epoch != null ? this._encrypt(dto.end_epoch) : undefined,
      duration: dto.duration || 0,
      is_active: dto.is_active ?? true,
      is_paused: dto.is_paused ?? false,
      pauses_enc: this._encrypt(JSON.stringify(dto.pauses || [])),
      tags: dto.tags || [],
      media: dto.media || [],
      device_uuid_enc: this._encrypt(dto.device_uuid || ''),
      end_device_uuid_enc: this._encrypt(dto.end_device_uuid || ''),
      metadata_enc: this._encrypt(JSON.stringify(dto.metadata || {})),
    };
    if (dto.comment != null) data.comment = dto.comment;

    // Remove undefined fields
    const cleanData = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) cleanData[k] = v;
    }

    // Encrypt field key names (I-02)
    const encodedData = this._encodeDataKeys(cleanData);

    return {
      hash: dto.hash || '',
      data: encodedData,
      committed: dto.committed || false,
      block_index: dto.block_index ?? null,
      updated_at: dto.updated_at,
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
