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

    const dateStr = new Date(startEpoch).toISOString().slice(0, 10);

    return {
      entry_id: data.entry_id || rawEntry.hash || '',
      entry_index: -1, // committed entries have no staging index
      title: data.title || '',
      start_epoch: startEpoch,
      end_epoch: endEpoch,
      duration: data.duration || 0,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags: data.tags || [],
      comment: data.comment || null,
      media: [],
      metadata,
      date: dateStr,
      source: 'ledger',
      hash: rawEntry.hash || '',
      device_uuid: data.device_uuid || '',
      end_device_uuid: data.end_device_uuid || '',
      committed: true,
      block_index: null,
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

    return {
      entry_id: data.entry_id || '',
      title: data.title || '',
      start_epoch: startEpoch,
      end_epoch: endEpoch,
      duration: data.duration || 0,
      is_active: data.is_active || false,
      is_paused: data.is_paused || false,
      pauses,
      tags: data.tags || [],
      comment: data.comment || null,
      media: data.media || [],
      metadata,
      date: dateStr,
      source: 'remote',
      hash: rawEntry.hash || '',
      device_uuid: deviceUuid,
      end_device_uuid: endDeviceUuid,
      committed: rawEntry.committed ?? false,
      block_index: rawEntry.block_index ?? null,
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
