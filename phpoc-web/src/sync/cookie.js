/**
 * DeviceCookie — random-specifier cookie for cross-device identity check.
 *
 * Port of domain/cookie/device_cookie.py to JS.
 *
 * Design (from the auth gate spec):
 *   - Remote cookie:  {"device_uuid": "<UUID>", "device_specifier": "<random>"}
 *   - Local cookie:   {"device_specifier": "<same random>", "creation_time": "<epoch_ms>"}
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
 *   - COOKIE_KEY ('cookie') : local cookie ({device_specifier, creation_time})
 *
 * The remote cookie is NOT cached locally — it's pulled fresh from the
 * transport on every check_and_sync. The local cookie is the source of truth
 * for "which session are we?"
 */

// Default TTL: 30 minutes (same as CLI default)
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const COOKIE_KEY = 'cookie';

export class DeviceCookie {
  /**
   * Create a new device cookie.
   *
   * Writes local cookie (specifier + creation_time) and returns the
   * remote cookie dict to be pushed to R2.
   *
   * @param {string} deviceId - This device's UUID string.
   * @param {import('./storage.js').StorageBackend} storage - Storage backend.
   * @param {import('../crypto/index.js').CryptoService} crypto - CryptoService
   *        for generating the random specifier.
   * @returns {Promise<object|null>} Remote cookie dict
   *   {device_uuid, device_specifier} to be pushed to remote, or null on failure.
   */
  static async create(deviceId, storage, crypto) {
    try {
      const specifier = crypto.generateDeviceSpecifier();
      const epochMs = Date.now();

      // Remote cookie — pushed to R2
      const remoteCookie = {
        device_uuid: deviceId,
        device_specifier: specifier,
      };

      // Local cookie — stored in local storage backend
      const localCookie = {
        device_specifier: specifier,
        creation_time: epochMs,
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
   * @returns {Promise<object|null>} The local cookie dict
   *   {device_specifier, creation_time} if valid, null if missing or expired.
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
      const effectiveTtlMinutes = ttlMinutes ?? (DEFAULT_TTL_MS / 60000);
      const ttlMs = effectiveTtlMinutes * 60 * 1000;

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
   * @returns {object|null} Dict {device_uuid, device_specifier}
   *   or null if parsing fails.
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
