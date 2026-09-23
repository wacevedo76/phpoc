/**
 * DeviceCookie — random-specifier cookie for cross-device identity check.
 *
 * Port of domain/cookie/device_cookie.py to JS.
 *
 * Design (from the auth gate spec):
 *   - Remote cookie:  {"device_uuid": "<UUID>", "device_specifier": "<random>",
 *                      "staging_hash": "<64-hex>|null", "seq": <int>}
 *   - Local cookie:   {"device_specifier": "<same random>", "creation_time": "<epoch_ms>",
 *                      "last_seen_hash": "<64-hex>|null", "last_seen_seq": <int>}
 *
 * On first push after onboarding/re-auth, a new random specifier is generated.
 * Subsequent same-device writes reuse the existing specifier (only creation_time
 * is updated). Cross-device takeovers create a fresh specifier.
 *
 * On every staging read (check_and_sync):
 *   1. Check local cookie exists and TTL hasn't expired
 *   2. Pull remote cookie — compare device_specifier values
 *   3. Match → same device session → READY (fast path)
 *   4. No match → different device wrote → auth gate
 *   5. No remote cookie → first time → auth gate
 *
 * Security:
 *   - device_specifier is a random 16-byte hex string — cannot be guessed
 *   - No master key needed for comparison (the specifier IS the identity proof)
 *   - Remote stores no plaintext cookie key — just the random specifier + UUID
 *
 * Storage keys used:
 *   - COOKIE_KEY ('cookie') : local cookie ({device_specifier, creation_time,
 *     last_seen_hash, last_seen_seq})
 *
 * The remote cookie is NOT cached locally — it's pulled fresh from the
 * transport on every check_and_sync. The local cookie is the source of truth
 * for "which session are we?"
 */

// Default TTL: 30 minutes (same as CLI default)
const COOKIE_KEY = 'cookie';

export class DeviceCookie {
  /**
   * Create a new device cookie.
   *
   * Writes local cookie (specifier + creation_time + last_seen_hash +
   * last_seen_seq) and returns the remote cookie dict to be pushed to R2.
   *
   * @param {string} deviceId - This device's UUID string.
   * @param {import('./storage.js').StorageBackend} storage - Storage backend.
   * @param {import('../crypto/index.js').CryptoService} crypto - CryptoService
   *        for generating the random specifier.
   * @param {{stagingHash?: string|null, seq?: number}} [options] - Optional
   *        remote schema fields (defaults stagingHash null, seq 0).
   * @returns {Promise<object|null>} Remote cookie dict
   *   {device_uuid, device_specifier, staging_hash, seq} to be pushed to
   *   remote, or null on failure.
   */
  static async create(deviceId, storage, crypto, options = {}) {
    try {
      const specifier = crypto.generateDeviceSpecifier();
      const epochMs = Date.now();
      const stagingHash = options.stagingHash ?? null;
      const seq = options.seq ?? 0;

      // Remote cookie — pushed to R2
      const remoteCookie = {
        device_uuid: deviceId,
        device_specifier: specifier,
        staging_hash: stagingHash,
        seq,
      };

      // Local cookie — stored in local storage backend
      const localCookie = {
        device_specifier: specifier,
        creation_time: epochMs,
        last_seen_hash: stagingHash,
        last_seen_seq: seq,
      };

      await storage.set(COOKIE_KEY, localCookie);
      return remoteCookie;
    } catch (err) {
      console.error('DeviceCookie.create failed:', err);
      return null;
    }
  }

  /**
   * Check if a local device cookie exists and its TTL has not expired.
   *
   * @param {import('./storage.js').StorageBackend} storage - Storage backend.
   * @param {number} [ttlMinutes=30] - How long the cookie is valid.
   * @returns {Promise<object|null>} The full local cookie dict (including
   *   last_seen_hash/last_seen_seq) if valid, null if missing or expired.
   */
  static async isValidLocally(storage, ttlMinutes = 30) {
    try {
      const localCookie = await storage.get(COOKIE_KEY);
      if (!localCookie) return null;

      const specifier = localCookie.device_specifier;
      const createdAt = localCookie.creation_time;

      if (!specifier || !createdAt) {
        await storage.remove(COOKIE_KEY);
        return null;
      }

      const elapsedMs = Date.now() - createdAt;
      const ttlMs = (ttlMinutes ?? 30) * 60 * 1000;

      if (elapsedMs > ttlMs) {
        // Cookie expired — clean up
        await storage.remove(COOKIE_KEY);
        return null;
      }

      return localCookie;
    } catch (err) {
      console.warn('DeviceCookie.isValidLocally failed:', err);
      await storage.remove(COOKIE_KEY);
      return null;
    }
  }

  /**
   * Parse raw bytes from remote into a cookie dict.
   *
   * @param {Uint8Array|null} rawBytes - Raw bytes from transport pull
   *        of device_cookie.bin, or null if 404.
   * @returns {object|null} The cookie dict verbatim (all fields, including
   *   staging_hash/seq when present), or null if parsing fails.
   */
  static parseRemote(rawBytes) {
    if (!rawBytes) return null;
    try {
      const text = new TextDecoder().decode(rawBytes);
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Compare device_specifier between local and remote cookies.
   *
   * @param {object} localCookie - Dict from local cookie (isValidLocally return).
   * @param {object} remoteCookie - Dict from remote cookie (parseRemote return).
   * @returns {boolean} True if the device_specifier values match.
   */
  static matches(localCookie, remoteCookie) {
    const localSpec = localCookie?.device_specifier || '';
    const remoteSpec = remoteCookie?.device_specifier || '';
    return localSpec !== '' && remoteSpec !== '' && localSpec === remoteSpec;
  }

  /**
   * Increment base for the next cookie seq (ADR-034 P1).
   *
   * @param {number|null|undefined} lastSeenSeq - The seq observed at the last
   *        pull/claim, or null/undefined if the cookie has no seq yet.
   * @returns {number} 1 when absent, otherwise lastSeenSeq + 1.
   */
  static nextSeq(lastSeenSeq) {
    if (lastSeenSeq === null || lastSeenSeq === undefined) return 1;
    return lastSeenSeq + 1;
  }

  /**
   * Remove the local device cookie.
   *
   * @param {import('./storage.js').StorageBackend} storage - Storage backend.
   * @returns {Promise<void>}
   */
  static async destroyLocally(storage) {
    try {
      await storage.remove(COOKIE_KEY);
    } catch (err) {
      console.warn('DeviceCookie.destroyLocally failed:', err);
    }
  }
}
