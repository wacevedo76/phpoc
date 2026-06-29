/**
 * useCookieMonitor — Cookie TTL monitor for re-auth overlay.
 *
 * Provides:
 *   - checkCookieTtl(storage, ttlMinutes) — standalone cookie TTL check
 *   - createCookieMonitor(storage, crypto, options) — poll-based TTL monitor
 *
 * The monitor fires crypto.clearMasterKey() + onExpired() when the local
 * device cookie exceeds its TTL, triggering the re-auth overlay in the UI.
 *
 * Follows the createAutoSync pattern: pure function, push-based callbacks,
 * no React dependency.
 */

const DEFAULT_TTL_MINUTES = 30;
const DEFAULT_POLL_MS = 60_000; // 1 minute

/**
 * Check if the local device cookie is valid and within TTL.
 *
 * Reads the 'cookie' key from storage and validates:
 *   - Cookie exists
 *   - device_specifier field is present and non-empty
 *   - creation_time field is present and non-null
 *   - Elapsed time since creation_time does not exceed TTL
 *
 * On corrupt cookies (missing required fields) or expired cookies,
 * the cookie is removed from storage.
 *
 * Graceful fallback: returns true when storage is null/undefined
 * (services not yet ready) or when storage reads fail.
 *
 * @param {object|null|undefined} storage - Storage backend with get(key)
 *   and delete(key) methods
 * @param {number} [ttlMinutes=30] - Cookie TTL in minutes
 * @returns {Promise<boolean>} true if cookie is valid, false otherwise
 */
export async function checkCookieTtl(storage, ttlMinutes = DEFAULT_TTL_MINUTES) {
  // Graceful fallback: no storage → assume valid (services not ready)
  if (!storage) return true;

  try {
    const cookie = await storage.get('cookie');
    if (!cookie) return false;

    const specifier = cookie.device_specifier;
    const createdAt = cookie.creation_time;

    // Corrupt cookie — missing required fields → clean up
    if (!specifier || !createdAt) {
      try {
        await storage.delete('cookie');
      } catch {
        // Cleanup is best-effort
      }
      return false;
    }

    const elapsedMs = Date.now() - createdAt;
    const ttlMs = ttlMinutes * 60 * 1000;

    if (elapsedMs > ttlMs) {
      // Cookie expired — clean up
      try {
        await storage.delete('cookie');
      } catch {
        // Cleanup is best-effort
      }
      return false;
    }

    return true;
  } catch {
    // Storage read error → can't determine → assume valid (don't block user)
    return true;
  }
}

/**
 * Create a cookie TTL monitor.
 *
 * Pure function — no React dependency. Use in context providers or
 * as a building block for React hooks.
 *
 * On start(), fires an immediate TTL check. If expired at boot,
 * calls crypto.clearMasterKey() then onExpired() synchronously.
 *
 * After start, polls every pollIntervalMs. On expiry detection:
 *   1. Calls crypto.clearMasterKey() (if crypto is provided and MK is cached)
 *   2. Calls onExpired() (if provided)
 *   3. Stops polling (single-fire — onExpired called only once)
 *
 * Before expiry, when the cookie is still valid but within the warning
 * threshold, calls onWarning() (if provided). onWarning fires only once
 * per session — subsequent polls skip it (idempotent).
 *
 * onExpired is always called after clearMasterKey, and is called
 * even if clearMasterKey throws (D6 guarantee).
 *
 * Safe to call dispose() multiple times (idempotent).
 * start() after dispose() re-activates monitoring with a fresh poll cycle.
 *
 * @param {object|null} storage - Storage backend with get(key) method.
 *   When null, no expiry checks are performed (never fires onExpired).
 * @param {object|null} crypto - Crypto service with:
 *   - clearMasterKey() — clears cached master key
 *   - hasMasterKey() — returns boolean
 *   When null, expiry still fires onExpired but skips clearMasterKey.
 * @param {object} [options]
 * @param {number} [options.cookieTtlMinutes=30] - Cookie TTL in minutes
 * @param {number} [options.pollIntervalMs=60000] - Poll interval in milliseconds
 * @param {number} [options.warningThresholdMinutes=5] - Minutes before TTL to fire onWarning
 * @param {() => void} [options.onWarning] - Callback when cookie is within warning threshold (single-fire)
 * @param {() => void} [options.onExpired] - Callback when cookie expires
 * @returns {{
 *   start: () => Promise<void>,
 *   dispose: () => void,
 *   isExpired: () => boolean,
 * }}
 */
export function createCookieMonitor(storage, crypto, {
  cookieTtlMinutes = DEFAULT_TTL_MINUTES,
  pollIntervalMs = DEFAULT_POLL_MS,
  warningThresholdMinutes = 5,
  onWarning,
  onExpired,
} = {}) {
  let _timer = null;
  let _expired = false;
  let _warned = false;
  let _disposed = false;

  /**
   * Perform a single TTL check. If cookie is expired:
   *   1. Set _expired = true (prevents duplicate calls)
   *   2. Clear master key (if crypto has one)
   *   3. Fire onExpired callback
   *   4. Stop polling
   */
  async function _check() {
    if (_disposed || _expired) return;

    // Null storage → never trigger expiry (skip silently)
    if (!storage) return;

    let valid;
    try {
      valid = await checkCookieTtl(storage, cookieTtlMinutes);
    } catch {
      // Storage read error → skip this check cycle (graceful)
      return;
    }

    // Re-check disposed/expired in case they changed during await
    if (_disposed || _expired) return;

    if (!valid) {
      _expired = true;

      // Clear MK if crypto has one
      if (crypto && typeof crypto.hasMasterKey === 'function' && crypto.hasMasterKey()) {
        try {
          crypto.clearMasterKey();
        } catch {
          // clearMasterKey threw — still fire onExpired (D6 guarantee)
        }
      }

      // Fire callback (single-fire — _expired is already true)
      if (typeof onExpired === 'function') {
        try {
          onExpired();
        } catch {
          // Callback crashed — internal state already set, no recovery needed
        }
      }

      // Stop polling after expiry
      if (_timer !== null) {
        clearInterval(_timer);
        _timer = null;
      }
    } else if (!_warned && typeof onWarning === 'function') {
      // Cookie valid but nearing expiry — check remaining time
      try {
        const cookie = await storage.get('cookie');
        if (cookie && cookie.creation_time) {
          const elapsedMs = Date.now() - cookie.creation_time;
          const ttlMs = cookieTtlMinutes * 60 * 1000;
          const remainingMs = ttlMs - elapsedMs;
          const warningMs = warningThresholdMinutes * 60 * 1000;
          if (remainingMs > 0 && remainingMs <= warningMs) {
            _warned = true;
            onWarning();
          }
        }
      } catch {
        // Storage read error — skip warning this cycle
      }
    }
  }

  return {
    /**
     * Start monitoring. Fires an immediate TTL check, then polls
     * on the configured interval. Safe to call after dispose()
     * to re-activate monitoring.
     * @returns {Promise<void>}
     */
    async start() {
      _disposed = false;
      _expired = false;
      _warned = false;

      // Clear any stale timer from a previous cycle
      if (_timer !== null) {
        clearInterval(_timer);
        _timer = null;
      }

      // Immediate check on start
      await _check();

      // Start polling if not already expired/disposed (check may have
      // set _expired or a concurrent dispose may have set _disposed)
      if (!_expired && !_disposed) {
        _timer = setInterval(() => {
          _check();
        }, pollIntervalMs);
      }
    },

    /**
     * Stop monitoring. Clears the poll timer. Safe to call multiple
     * times (idempotent).
     */
    dispose() {
      _disposed = true;
      if (_timer !== null) {
        clearInterval(_timer);
        _timer = null;
      }
    },

    /**
     * Check whether the cookie has been detected as expired.
     * @returns {boolean}
     */
    isExpired() {
      return _expired;
    },
  };
}
