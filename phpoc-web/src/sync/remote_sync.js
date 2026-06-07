/**
 * RemoteSync — device identity check, transport pull/push, blob handling.
 *
 * Port of domain/staging/remote_sync.py to JS.
 *
 * Handles the remote side of staging: pulling and pushing staging blobs
 * and device cookies over a transport, with blob obfuscation via the
 * Rust WASM CryptoService.
 *
 * Remote blob format (JSON, stored as obfuscated bytes):
 *   {
 *     "device_id": "uuid-string",
 *     "device_proof": "hmac-hex",
 *     "entries": [...],
 *     "updated_at": 1714000000000
 *   }
 *
 * Blob obfuscation is delegated entirely to CryptoService.obfuscateBlob() /
 * deobfuscateBlob() — the Rust crate handles pad → tier → encrypt → tag.
 *
 * Transport contract:
 *   pull(path)       → Promise<Uint8Array | null>   (null on 404)
 *   push(path, data) → Promise<void>
 */

// Remote paths — must match the CLI constants from
// domain/staging/remote_sync.py and domain/ledger/remote_sync.py
const BLOB_PATH = 'staging/blobs/current.json';
const COOKIE_PATH = 'staging/blobs/device_cookie.bin';

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
    const rawBytes = await this._transport.pull(BLOB_PATH);
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
      const b64 = this._bytesToBase64(rawBytes);
      const plaintext = this._crypto.deobfuscateBlob(b64, effectiveKey);
      return JSON.parse(plaintext);
    } catch {
      // Deobfuscation failed — wrong key or corrupt data
      return BLOB_KEY_MISMATCH;
    }
  }

  /**
   * Encrypt entries into blob format, obfuscate, and push via transport.
   *
   * Obfuscation happens when a master key is available. Falls back to
   * plaintext JSON when no key is available (unauthenticated session).
   *
   * @param {Array} entries - List of staging entry dicts.
   * @param {string} deviceId - This device's UUID.
   * @param {string} [masterKeyHex] - 64-char hex master key for obfuscation.
   *   Falls back to crypto.getMasterKey() if not provided.
   * @returns {Promise<void>}
   */
  async pushBlob(entries, deviceId, masterKeyHex) {
    const blob = {
      device_id: deviceId,
      device_proof: '',
      entries,
      updated_at: Date.now(),
    };

    let blobBytes = new TextEncoder().encode(JSON.stringify(blob, null, 2));

    const effectiveKey = masterKeyHex || this._crypto.getMasterKey();
    if (effectiveKey) {
      // Obfuscate via CryptoService (pad + encrypt with blob sub-key)
      const plaintext = new TextDecoder().decode(blobBytes);
      const b64 = this._crypto.obfuscateBlob(plaintext, effectiveKey);
      blobBytes = this._base64ToBytes(b64);
    }

    await this._transport.push(BLOB_PATH, blobBytes);
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
    return this._transport.pull(COOKIE_PATH);
  }

  /**
   * Push the device cookie to remote.
   *
   * @param {Uint8Array} cookieBytes - JSON bytes of
   *   {device_uuid, device_specifier}.
   * @returns {Promise<void>}
   */
  async pushCookie(cookieBytes) {
    await this._transport.push(COOKIE_PATH, cookieBytes);
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
      const result = await this._transport.pull(BLOB_PATH);
      // Transport responded — treat as available even if blob is empty
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Internal: Base64 ↔ Uint8Array conversion
  // ------------------------------------------------------------------

  /**
   * Convert a Uint8Array to a base64 string.
   * Uses browser btoa for web, Buffer for Node.js.
   *
   * @param {Uint8Array} bytes
   * @returns {string}
   * @private
   */
  _bytesToBase64(bytes) {
    if (typeof btoa !== 'undefined') {
      // Browser path
      const binary = String.fromCharCode(...bytes);
      return btoa(binary);
    }
    // Node.js path
    return Buffer.from(bytes).toString('base64');
  }

  /**
   * Convert a base64 string to a Uint8Array.
   *
   * @param {string} b64
   * @returns {Uint8Array}
   * @private
   */
  _base64ToBytes(b64) {
    if (typeof atob !== 'undefined') {
      // Browser path
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }
    // Node.js path
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
}
