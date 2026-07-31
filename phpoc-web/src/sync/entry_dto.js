/**
 * Entry DTO conversion — raw encrypted/plain-prefixed entries → clean DTOs.
 *
 * Extracted from SyncService to isolate data transformation logic.
 * Two formats handled:
 *   - Committed (ledger blocks): hex ciphertext fields, decrypted via crypto
 *   - Staging (remote blob): "plain:" prefix convention from CLI
 *
 * @module entry_dto
 */

// Encryptable field names that may be tokenized (I-02)
const _ENCRYPTABLE_FIELDS = [
  'startTime_enc', 'endTime_enc', 'pauses_enc',
  'metadata_enc', 'device_uuid_enc', 'end_device_uuid_enc',
];

/**
 * Parse a field value that may be plain:-prefixed or hex ciphertext.
 * Returns the plaintext string, or null if unparseable.
 * @param {string} raw - e.g. "plain:hello" or hex ciphertext
 * @param {object} [crypto] - Optional crypto service for hex decryption
 * @returns {string|null}
 */
function _parsePlainOrEncrypted(raw, crypto) {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.startsWith('plain:')) return raw.slice(6);
  if (crypto) {
    try {
      const decrypted = crypto.decryptWithCachedKey(raw);
      if (decrypted != null) return decrypted;
    } catch { /* fall through */ }
  }
  return raw;
}

/**
 * Decode encrypted field-name tokens → standard _enc key names.
 * Legacy _enc keys pass through as-is.
 * @param {object} data
 * @param {object} [crypto]
 * @returns {object}
 */
function decodeDataKeys(data, crypto) {
  if (!data || typeof data !== 'object') return {};

  // If any key ends with _enc, it's legacy format — pass through
  if (Object.keys(data).some(k => k.endsWith('_enc'))) {
    return { ...data };
  }

  // No crypto → can't decode tokens
  if (!crypto || !crypto.sha256) {
    return { ...data };
  }

  // Build reverse token map
  const tokenMap = new Map();
  for (const name of _ENCRYPTABLE_FIELDS) {
    const token = crypto.sha256('phpoc-staging-keys-v1' + name).slice(0, 16);
    tokenMap.set(token, name);
  }

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
 * Decrypt and convert a raw committed entry from a ledger block into a DTO.
 * Committed entries have encrypted hex fields that must be decrypted first.
 *
 * @param {object} rawEntry - Raw entry dict with `data`, `hash`
 * @param {object} crypto - CryptoService with decryptWithCachedKey()
 * @returns {object|null} Decrypted DTO, or null if decryption fails.
 */
export function rawCommittedEntryToDTO(rawEntry, crypto) {
  try {
    const data = rawEntry.data || {};

    // Decrypt timestamp fields from hex ciphertext
    const startEpochStr = data.startTime_enc
      ? crypto.decryptWithCachedKey(data.startTime_enc)
      : null;
    const startEpoch = startEpochStr ? parseInt(startEpochStr, 10) : null;
    if (!startEpoch) return null;

    const endEpochStr = data.endTime_enc
      ? crypto.decryptWithCachedKey(data.endTime_enc)
      : null;
    const endEpoch = endEpochStr ? parseInt(endEpochStr, 10) : null;

    // Decrypt metadata
    let metadata = {};
    if (data.metadata_enc) {
      try {
        const metaStr = crypto.decryptWithCachedKey(data.metadata_enc);
        metadata = JSON.parse(metaStr);
      } catch { /* ignore corrupt metadata */ }
    }

    // Dual-read encryptable fields: try _enc first, fall back to plaintext
    let title = '';
    if (data.title_enc) {
      try {
        title = crypto.decryptWithCachedKey(data.title_enc) ?? '';
      } catch { title = data.title || ''; }
    } else {
      title = data.title || '';
    }

    let tags = [];
    if (data.tags_enc) {
      try {
        const plain = crypto.decryptWithCachedKey(data.tags_enc);
        tags = plain ? JSON.parse(plain) : [];
      } catch { tags = data.tags || []; }
    } else {
      tags = data.tags || [];
    }

    let comment = null;
    if (data.comment_enc) {
      try {
        comment = crypto.decryptWithCachedKey(data.comment_enc) || null;
      } catch { comment = data.comment || null; }
    } else {
      comment = data.comment || null;
    }

    let duration = 0;
    if (data.duration_enc) {
      try {
        const plain = crypto.decryptWithCachedKey(data.duration_enc);
        if (plain != null) {
          const n = parseInt(plain, 10);
          duration = isNaN(n) ? 0 : n;
        }
      } catch { duration = data.duration || 0; }
    } else {
      duration = data.duration || 0;
    }

    const dateStr = new Date(startEpoch).toISOString().slice(0, 10);

    const hasEncryptedFields = !!(data.title_enc || data.tags_enc ||
      data.comment_enc || data.duration_enc);

    return {
      entry_id: data.entry_id || rawEntry.hash || '',
      entry_index: -1, // committed entries have no staging index
      title,
      start_epoch: startEpoch,
      end_epoch: endEpoch,
      duration,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags,
      comment,
      media: [],
      metadata,
      date: dateStr,
      source: 'ledger',
      hash: rawEntry.hash || '',
      device_uuid: data.device_uuid || '',
      end_device_uuid: data.end_device_uuid || '',
      committed: true,
      block_index: null,
      has_encrypted_fields: hasEncryptedFields,
    };
  } catch {
    return null;
  }
}

/**
 * Convert a raw staging entry (from remote blob) to a DTO.
 *
 * Remote blob entries are stored in raw format with encrypted fields.
 * Handles both legacy ``plain:`` prefixed entries and hex ciphertext
 * entries (post I-03) when crypto is provided.
 *
 * @param {object} rawEntry - Raw entry dict with `data`, `hash`, etc.
 * @param {object} [crypto] - Optional crypto service for decrypting hex fields.
 * @returns {object|null} Decrypted DTO, or null if corrupt.
 */
export function rawEntryToDTO(rawEntry, crypto) {
  try {
    const rawData = rawEntry.data || {};
    // Decode encrypted field-name tokens → standard _enc keys
    const data = decodeDataKeys(rawData, crypto);

    // Parse timestamps (plain: or hex ciphertext)
    const startEpochStr = data.startTime_enc || '';
    const startEpoch = parsePlainInt(startEpochStr, crypto);
    if (startEpoch == null) return null;

    const endEpochStr = data.endTime_enc;
    const endEpoch = endEpochStr ? parsePlainInt(endEpochStr, crypto) : null;

    const pausesRaw = data.pauses_enc || 'plain:[]';
    const pauses = parsePlainJSON(pausesRaw, crypto) || [];

    const metadataRaw = data.metadata_enc || 'plain:{}';
    const metadata = parsePlainJSON(metadataRaw, crypto) || {};

    const dateStr = new Date(startEpoch).toISOString().slice(0, 10);

    // Dual-read encryptable fields: try _enc first, fall back to plaintext
    let title = '';
    if (data.title_enc) {
      const plain = _parsePlainOrEncrypted(data.title_enc, crypto);
      title = plain ?? '';
    } else {
      title = data.title || '';
    }

    let tags = [];
    if (data.tags_enc) {
      const plain = _parsePlainOrEncrypted(data.tags_enc, crypto);
      try { tags = plain ? JSON.parse(plain) : []; } catch { tags = []; }
    } else {
      tags = data.tags || [];
    }

    let comment = null;
    if (data.comment_enc) {
      comment = _parsePlainOrEncrypted(data.comment_enc, crypto);
    } else {
      comment = data.comment || null;
    }

    let duration = 0;
    if (data.duration_enc) {
      const plain = _parsePlainOrEncrypted(data.duration_enc, crypto);
      if (plain != null) {
        const n = parseInt(plain, 10);
        duration = isNaN(n) ? 0 : n;
      }
    } else {
      duration = data.duration || 0;
    }

    // Parse device UUIDs — may be in device_uuid or device_uuid_enc field
    let deviceUuid = '';
    const deviceUuidRaw = data.device_uuid_enc || data.device_uuid || '';
    if (deviceUuidRaw.startsWith('plain:')) {
      deviceUuid = deviceUuidRaw.slice(6);
    } else if (crypto) {
      try {
        deviceUuid = crypto.decryptWithCachedKey(deviceUuidRaw) || '';
      } catch { deviceUuid = deviceUuidRaw; }
    } else {
      deviceUuid = deviceUuidRaw;
    }

    let endDeviceUuid = '';
    const endDeviceUuidRaw = data.end_device_uuid_enc || data.end_device_uuid || '';
    if (endDeviceUuidRaw.startsWith('plain:')) {
      endDeviceUuid = endDeviceUuidRaw.slice(6);
    } else if (crypto) {
      try {
        endDeviceUuid = crypto.decryptWithCachedKey(endDeviceUuidRaw) || '';
      } catch { endDeviceUuid = endDeviceUuidRaw; }
    } else {
      endDeviceUuid = endDeviceUuidRaw;
    }

    const hasEncryptedFields = !!(data.title_enc || data.tags_enc ||
      data.comment_enc || data.duration_enc);

    return {
      entry_id: data.entry_id || '',
      title,
      start_epoch: startEpoch,
      end_epoch: endEpoch,
      duration,
      is_active: data.is_active || false,
      is_paused: data.is_paused || false,
      pauses,
      tags,
      comment,
      media: data.media || [],
      metadata,
      date: dateStr,
      source: 'remote',
      hash: rawEntry.hash || '',
      device_uuid: deviceUuid,
      end_device_uuid: endDeviceUuid,
      committed: rawEntry.committed ?? false,
      block_index: rawEntry.block_index ?? null,
      has_encrypted_fields: hasEncryptedFields,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a `plain:` prefixed string as an integer.
 * Also handles hex ciphertext when crypto is provided.
 * @param {string} str - e.g. "plain:1714000000000" or hex ciphertext
 * @param {object} [crypto] - Optional crypto service for decrypting hex values
 * @returns {number|null}
 */
export function parsePlainInt(str, crypto) {
  if (!str || typeof str !== 'string') return null;
  if (str.startsWith('plain:')) {
    return parseInt(str.slice(6), 10);
  }
  // Try hex ciphertext with crypto
  if (crypto) {
    try {
      const decrypted = crypto.decryptWithCachedKey(str);
      if (decrypted != null) {
        const n = parseInt(decrypted, 10);
        if (!isNaN(n)) return n;
      }
    } catch { /* fall through */ }
  }
  // Could be an already-decrypted value (just a number string)
  const n = parseInt(str, 10);
  return isNaN(n) ? null : n;
}

/**
 * Convert a canonical staging row (PHPSPEC §8) to a local DTO.
 *
 * Canonical rows: {activity_id, activity_status, activity, updated_at, committed}
 * DTO format: {entry_id, title, start_epoch, end_epoch, is_active, ...}
 *
 * activity JSON is parsed to extract title, start_epoch, etc.
 *
 * @param {object} row - Canonical staging row.
 * @returns {object|null} DTO or null on parse failure.
 */
export function canonicalRowToDTO(row) {
  try {
    const activityStr = typeof row.activity === 'string' ? row.activity : '{}';
    let activity;
    try {
      activity = JSON.parse(activityStr);
    } catch {
      activity = {};
    }

    const startEpoch = activity.start_epoch ?? 0;
    const dateStr = new Date(startEpoch).toISOString().slice(0, 10);

    return {
      entry_id: activity.entry_id || row.activity_id || '',
      activity_id: row.activity_id || '',
      title: activity.title || '',
      start_epoch: startEpoch,
      end_epoch: activity.end_epoch ?? null,
      duration: activity.duration || 0,
      is_active: row.activity_status !== 'ended',
      is_paused: row.activity_status === 'paused',
      pauses: activity.pauses || [],
      tags: activity.tags || [],
      comment: activity.comment || null,
      media: activity.media || [],
      metadata: activity.metadata || {},
      date: dateStr,
      source: 'remote',
      hash: '',
      device_uuid: activity.device_uuid || '',
      end_device_uuid: activity.end_device_uuid || '',
      committed: row.committed || false,
      block_index: null,
      has_encrypted_fields: false,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a `plain:` prefixed string as JSON.
 * Also handles hex ciphertext when crypto is provided.
 * @param {string} str - e.g. 'plain:[{"pause_start":...}]' or hex ciphertext
 * @param {object} [crypto] - Optional crypto service for decrypting hex values
 * @returns {any|null}
 */
export function parsePlainJSON(str, crypto) {
  if (!str || typeof str !== 'string') return null;
  if (str.startsWith('plain:')) {
    try {
      return JSON.parse(str.slice(6));
    } catch {
      return null;
    }
  }
  // Try hex ciphertext with crypto
  if (crypto) {
    try {
      const decrypted = crypto.decryptWithCachedKey(str);
      if (decrypted != null) {
        return JSON.parse(decrypted);
      }
    } catch { /* fall through */ }
  }
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
