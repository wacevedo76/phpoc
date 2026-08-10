/**
 * RemoteSync — device identity check, transport pull/push, blob handling.
 *
 * Port of domain/staging/remote_sync.py to JS.
 *
 * Handles the remote side of staging: pulling and pushing staging blobs
 * and device cookies over a transport, with blob obfuscation via the
 * Rust WASM CryptoService.
 *
 * Remote blob format (JSON, stored as obfuscated bytes) — PHPSPEC §8:
 *   {
 *     "device_id": "uuid-string",
 *     "device_proof": "hmac-hex",
 *     "entries": [
 *       {
 *         "activity_id": "a1b2c3d4e5",
 *         "activity_status": "active",
 *         "activity": "{... encrypted entry JSON ...}",
 *         "updated_at": 1714000000000,
 *         "committed": false
 *       }
 *     ]
 *   }
 *
 * Blob obfuscation is delegated entirely to CryptoService.obfuscateBlob() /
 * deobfuscateBlob() — the Rust crate handles pad → tier → encrypt → tag.
 *
 * Transport contract:
 *   pull(path)       → Promise<Uint8Array | null>   (null on 404)
 *   push(path, data) → Promise<void>
 */

import { base64ToBytes, bytesToBase64 } from './base64.js';
import { REMOTE_STAGING_BLOB, REMOTE_DEVICE_COOKIE } from './keys.js';

/**
 * Derive activity_status from a legacy staging DTO's flags.
 * @param {object} e
 * @returns {string} 'active' | 'paused' | 'ended'
 * @private
 */
function _deriveStatusFromDTO(e) {
  if (e.is_active === false) return 'ended';
  if (e.is_paused) return 'paused';
  return 'active';
}

/**
 * Convert a legacy DTO to a canonical staging row.
 * DTOs have flat fields (title, start_epoch, etc.); canonical rows store
 * activity data as a JSON string under the `activity` key (PHPSPEC §8).
 * @param {object} e - Legacy DTO
 * @param {string} deviceId - Fallback device UUID
 * @param {number} now - Fallback timestamp (Date.now())
 * @returns {object} Canonical row
 */
export function dtoToCanonicalRow(e, deviceId, now) {
  return {
    activity_id: e.activity_id || e.entry_id || '',
    activity_status: _deriveStatusFromDTO(e),
    activity: JSON.stringify({
      title: e.title || '',
      start_epoch: e.start_epoch ?? 0,
      end_epoch: e.end_epoch ?? null,
      duration: e.duration || 0,
      tags: e.tags || [],
      comment: e.comment || null,
      media: e.media || [],
      entry_id: e.entry_id || '',
      is_active: e.is_active ?? false,
      is_paused: e.is_paused ?? false,
      pauses: e.pauses || [],
      metadata: e.metadata || {},
      device_uuid: e.device_uuid || deviceId,
      end_device_uuid: e.end_device_uuid || '',
      block_index: e.block_index ?? null,
    }),
    updated_at: e.updated_at ?? now,
    committed: e.committed || false,
  };
}

/**
 * Sentinel returned by pullBlob() when a remote blob exists but cannot be
 * decrypted (wrong master key). Distinct from null (no blob on remote).
 * @type {symbol}
 */
export const BLOB_KEY_MISMATCH = Symbol('BLOB_KEY_MISMATCH');

export class RemoteSync {
  /**
   * @param {import('./transport.js').HttpTransport} transport - HTTP transport.
   * @param {import('../crypto/index.js').CryptoService} crypto - WASM CryptoService.
   */
  constructor(transport, crypto) {
    /** @private */
    this._transport = transport;
    /** @private */
    this._crypto = crypto;
  }

  // ------------------------------------------------------------------
  // Blob pull / push
  // ------------------------------------------------------------------

  /**
   * Pull remote blob, deobfuscate, return parsed dict.
   *
   * Tries plaintext JSON first (backward compat / unobfuscated).
   * Falls back to deobfuscation via CryptoService.
   *
   * @param {string} [masterKeyHex] - 64-char hex master key for blob
   *   decryption. Falls back to crypto.getMasterKey() if not provided.
   * @returns {Promise<object|null|symbol>} Parsed blob dict, null if no
   *   blob exists on remote, or BLOB_KEY_MISMATCH if blob exists but
   *   cannot be decrypted.
   */
  async pullBlob(masterKeyHex) {
    const rawBytes = await this._transport.pull(REMOTE_STAGING_BLOB);
    if (rawBytes === null) return null;

    // Try plaintext JSON first (backward compat)
    try {
      const text = new TextDecoder().decode(rawBytes);
      return JSON.parse(text);
    } catch {
      // Not plain JSON — try deobfuscation
    }

    // Resolve effective key
    const effectiveKey = masterKeyHex || this._crypto.getMasterKey();
    if (!effectiveKey) {
      // Raw bytes exist but no key to decrypt — can't proceed
      return BLOB_KEY_MISMATCH;
    }

    try {
      // deobfuscateBlob takes base64, returns JSON string
      const b64 = bytesToBase64(rawBytes);
      const plaintext = this._crypto.deobfuscateBlob(b64, effectiveKey);
      return JSON.parse(plaintext);
    } catch {
      // Deobfuscation failed — wrong key or corrupt data
      return BLOB_KEY_MISMATCH;
    }
  }

  /**
   * Push staging entries in canonical PHPSPEC §8 blob format.
   *
   * Rows are flat: {activity_id, activity_status, activity, updated_at, committed}.
   * No {hash, data: {..._enc}} wrapping. No updated_at in the envelope.
   *
   * Obfuscation happens when a master key is available. Falls back to
   * plaintext JSON when no key is available (unauthenticated session).
   *
   * @param {Array} entries - List of staging rows (DTOS or canonical-format rows).
   * @param {string} deviceId - This device's UUID.
   * @param {string} [masterKeyHex] - 64-char hex master key for obfuscation.
   *   Falls back to crypto.getMasterKey() if not provided.
   * @returns {Promise<void>}
   */
  async pushBlob(entries, deviceId, masterKeyHex) {
    const now = Date.now();

    // Convert entries to canonical rows. Entries may be DTOs (entry_id-based)
    // or already canonical-format rows (activity_id-based).
    const rows = entries.map((e) => {
      if (e.activity_id && typeof e.activity === 'string') {
        // Already canonical — pass through with defaults
        return {
          activity_id: e.activity_id,
          activity_status: e.activity_status || 'active',
          activity: e.activity,
          updated_at: e.updated_at ?? now,
          committed: e.committed || false,
        };
      }
      return dtoToCanonicalRow(e, deviceId, now);
    });

    const blob = {
      device_id: deviceId,
      device_proof: '',
      entries: rows,
    };

    let blobBytes = new TextEncoder().encode(JSON.stringify(blob));

    const effectiveKey = masterKeyHex || this._crypto.getMasterKey();
    if (effectiveKey) {
      // Obfuscate via CryptoService (pad + encrypt with blob sub-key)
      const plaintext = new TextDecoder().decode(blobBytes);
      const b64 = this._crypto.obfuscateBlob(plaintext, effectiveKey);
      blobBytes = base64ToBytes(b64);
    }

    await this._transport.push(REMOTE_STAGING_BLOB, blobBytes);
  }

  // ------------------------------------------------------------------
  // Cookie pull / push
  // ------------------------------------------------------------------

  /**
   * Pull only the device cookie file from remote.
   *
   * The cookie is a small JSON blob (~200 bytes). This is orders of
   * magnitude faster than pulling + decrypting the full staging blob.
   *
   * @returns {Promise<Uint8Array|null>} Raw cookie bytes, or null if
   *   no cookie exists on remote.
   */
  async pullCookie() {
    return this._transport.pull(REMOTE_DEVICE_COOKIE);
  }

  /**
   * Push the device cookie to remote.
   *
   * @param {Uint8Array} cookieBytes - JSON bytes of
   *   {device_uuid, device_specifier}.
   * @returns {Promise<void>}
   */
  async pushCookie(cookieBytes) {
    await this._transport.push(REMOTE_DEVICE_COOKIE, cookieBytes);
  }

  // ------------------------------------------------------------------
  // Reachability
  // ------------------------------------------------------------------

  /**
   * Quick reachability check on the transport.
   *
   * @returns {Promise<boolean>} True if remote is reachable.
   */
  async checkRemoteAvailable() {
    try {
      const result = await this._transport.pull(REMOTE_STAGING_BLOB);
      // Transport responded — treat as available even if blob is empty
      return true;
    } catch {
      return false;
    }
  }

  // (base64 utilities imported from ./base64.js)
}
