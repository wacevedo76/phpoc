/**
 * useAutoSync — React hook for multi-device auto-sync via debounced pushToRemote.
 *
 * Wraps all 6 SyncService mutation methods (capture/end/pause/unpause/modify/remove)
 * with debounced pushToRemote. After any mutation, a debounced push fires once
 * the batch settles (no mutations within debounceMs). Tracks isSyncing state.
 *
 * Push errors are logged (console.warn) but not propagated — mutations always succeed.
 *
 * Returns:
 *   capture, end, pause, unpause, modify, remove  — wrapped mutation methods
 *   readEntries, checkAndSync                      — passthrough (no push trigger)
 *   isSyncing                                      — boolean (React state, push-based updates)
 *   dispose                                        — cleanup (cancel debounce)
 */

import { useRef, useEffect, useCallback, useState } from 'react';

/**
 * Pure function that creates auto-sync wrapped methods.
 * The React hook useAutoSync is a thin wrapper around this.
 *
 * @param {object} sync - SyncService instance with mutation methods + pushToRemote + getMasterKey
 * @param {object} [options]
 * @param {number} [options.debounceMs=500] - Debounce window in milliseconds
 * @param {(syncing: boolean) => void} [options.onSyncingChange] - Push-based callback when isSyncing changes.
 *        Called only on transitions (true→false, false→true), not on every mutation.
 * @returns {object} Wrapped methods + state accessors + dispose
 */
export function createAutoSync(sync, { debounceMs = 500, onSyncingChange } = {}) {
  let _syncing = false;
  let _debounceTimer = null;
  let _disposed = false;

  /**
   * Set syncing state and notify listener on transitions.
   * @param {boolean} val
   */
  function _setSyncing(val) {
    if (_syncing !== val) {
      _syncing = val;
      if (onSyncingChange) onSyncingChange(val);
    }
  }

  /**
   * Schedule a debounced push. Called after every mutation.
   * Resets any existing debounce timer (coalesces rapid mutations into one push).
   * Skips push entirely if no master key is cached.
   */
  function _schedulePush() {
    const mk = sync.getMasterKey();
    if (!mk) return;

    _setSyncing(true);

    if (_debounceTimer !== null) {
      clearTimeout(_debounceTimer);
    }

    _debounceTimer = setTimeout(async () => {
      _debounceTimer = null;
      try {
        await sync.pushToRemote(mk);
      } catch (err) {
        console.warn('autoSync push failed:', err.message);
      } finally {
        // Always reset syncing — even if disposed during the push
        _setSyncing(false);
      }
    }, debounceMs);
  }

  /**
   * Wrap a mutation method to trigger auto-sync after completion.
   * The mutation itself succeeds/fails independently of the push.
   * @param {string} name — method name on sync (e.g. 'capture', 'end')
   */
  function _wrapMutation(name) {
    return async function (...args) {
      const result = await sync[name](...args);
      _schedulePush();
      return result;
    };
  }

  return {
    capture: _wrapMutation('capture'),
    end: _wrapMutation('end'),
    pause: _wrapMutation('pause'),
    unpause: _wrapMutation('unpause'),
    modify: _wrapMutation('modify'),
    remove: _wrapMutation('remove'),
    readEntries: (...args) => sync.readEntries(...args),
    checkAndSync: (...args) => sync.checkAndSync(...args),
    isSyncing: () => _syncing,
    dispose: () => {
      _disposed = true;
      if (_debounceTimer !== null) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
        _setSyncing(false);
      }
    },
  };
}

/**
 * React hook wrapper around createAutoSync.
 *
 * Uses push-based onSyncingChange to drive React state (no polling).
 * Callbacks are stable across renders (ref-based, not dependent on sync identity).
 * Instance is re-created when sync or debounceMs changes.
 *
 * @param {object} sync - SyncService instance
 * @param {object} [options]
 * @param {number} [options.debounceMs=500] - Debounce window in milliseconds
 * @returns {object} Wrapped methods + isSyncing (React state) + dispose
 */
export function useAutoSync(sync, options) {
  const [isSyncing, setIsSyncing] = useState(false);
  const instanceRef = useRef(null);

  // Track previous sync/debounceMs to detect changes
  const prevSyncRef = useRef(sync);
  const prevDebounceRef = useRef(options?.debounceMs);

  // Create or re-create instance on sync / debounceMs change.
  // Done in render phase (not effect) so instance is always available
  // to callbacks. onSyncingChange only fires asynchronously (in setTimeout
  // callbacks), so calling setIsSyncing here is safe.
  if (
    !instanceRef.current
    || prevSyncRef.current !== sync
    || prevDebounceRef.current !== options?.debounceMs
  ) {
    if (instanceRef.current) {
      instanceRef.current.dispose();
    }
    instanceRef.current = createAutoSync(sync, {
      debounceMs: options?.debounceMs ?? 500,
      onSyncingChange: setIsSyncing,
    });
    prevSyncRef.current = sync;
    prevDebounceRef.current = options?.debounceMs;
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      instanceRef.current?.dispose();
    };
  }, []);

  return {
    capture: useCallback((...args) => instanceRef.current.capture(...args), []),
    end: useCallback((...args) => instanceRef.current.end(...args), []),
    pause: useCallback((...args) => instanceRef.current.pause(...args), []),
    unpause: useCallback((...args) => instanceRef.current.unpause(...args), []),
    modify: useCallback((...args) => instanceRef.current.modify(...args), []),
    remove: useCallback((...args) => instanceRef.current.remove(...args), []),
    readEntries: useCallback((...args) => instanceRef.current.readEntries(...args), []),
    checkAndSync: useCallback((...args) => instanceRef.current.checkAndSync(...args), []),
    isSyncing,
    dispose: useCallback(() => instanceRef.current.dispose(), []),
  };
}
