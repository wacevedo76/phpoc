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
    };
  } catch {
    return null;
  }
}

/**
 * Convert a raw staging entry (from remote blob) to a DTO.
 *
 * Remote blob entries are stored in raw format with encrypted fields.
 * Since the deobfuscated blob is plain JSON (decrypted), the fields
 * are already plain text (the `plain:` prefix convention from the CLI).
 *
 * @param {object} rawEntry - Raw entry dict with `data`, `hash`, etc.
 * @returns {object|null} Decrypted DTO, or null if corrupt.
 */
export function rawEntryToDTO(rawEntry) {
  try {
    const data = rawEntry.data || {};

    // Parse timestamps from plain: prefix format
    const startEpochStr = data.startTime_enc || '';
    const startEpoch = parsePlainInt(startEpochStr);
    if (startEpoch == null) return null;

    const endEpochStr = data.endTime_enc;
    const endEpoch = endEpochStr ? parsePlainInt(endEpochStr) : null;

    const pausesRaw = data.pauses_enc || 'plain:[]';
    const pauses = parsePlainJSON(pausesRaw) || [];

    const metadataRaw = data.metadata_enc || 'plain:{}';
    const metadata = parsePlainJSON(metadataRaw) || {};

    const dateStr = new Date(startEpoch).toISOString().slice(0, 10);

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
      device_uuid: data.device_uuid || '',
      end_device_uuid: data.end_device_uuid || '',
    };
  } catch {
    return null;
  }
}

/**
 * Parse a `plain:` prefixed string as an integer.
 * @param {string} str - e.g. "plain:1714000000000"
 * @returns {number|null}
 */
export function parsePlainInt(str) {
  if (!str || typeof str !== 'string') return null;
  if (str.startsWith('plain:')) {
    return parseInt(str.slice(6), 10);
  }
  // Could be an already-decrypted value (just a number string)
  return parseInt(str, 10);
}

/**
 * Parse a `plain:` prefixed string as JSON.
 * @param {string} str - e.g. 'plain:[{"pause_start":...}]'
 * @returns {any|null}
 */
export function parsePlainJSON(str) {
  if (!str || typeof str !== 'string') return null;
  if (str.startsWith('plain:')) {
    try {
      return JSON.parse(str.slice(6));
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
