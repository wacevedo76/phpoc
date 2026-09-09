import { useRef, useEffect, useCallback } from 'react';

/**
 * useFocusPull — Web foreground/focus pull hook (cross-client staging convergence C2).
 *
 * Event-driven `checkAndSync()` pull whenever the tab becomes visible AND focused:
 *   - `visibilitychange` → visible
 *   - `focus` → window has focus
 *   - `pageshow` → page restored from bfcache / tab re-shown
 *   - `start()` (screen mount) → one immediate pull
 *
 * Pure factory (no React) + thin `useFocusPull` React wrapper, mirroring `useAutoSync.js`.
 *
 * The factory reuses the existing SyncService.checkAndSync() gate UNCHANGED — it is
 * event-driven (ADR-034 DS4), NOT a periodic timer, and never auto-claims ownership (I1):
 * `onResult` only surfaces the SyncResult string (`READY`/`OFFLINE`/`REAUTH_NEEDED`/
 * `GENESIS_MISMATCH`); it does not call any reconcile/claim method.
 *
 * Single-flight with coalescing: while a pull is in-flight, further triggers set a
 * `_pending` flag so exactly ONE follow-up runs after the current pull completes.
 * A rejecting `checkAndSync` is swallowed via `console.warn` (never an unhandled
 * rejection), `isSyncing()` resets, and `onResult` is NOT called.
 *
 * @param {object} sync - SyncService instance with an async checkAndSync()
 * @param {object} [options]
 * @param {string[]} [options.events=['visibilitychange','focus','pageshow']] - event names
 * @param {object|null} [options.target] - event target; default `window` (browser) / `null` (Node)
 * @param {() => boolean} [options.isVisible] - visibility predicate (default: document.visibilityState)
 * @param {() => boolean} [options.hasFocus] - focus predicate (default: document.hasFocus())
 * @param {(result: string) => void} [options.onResult] - SyncResult callback (default: no-op)
 * @returns {{ start: Function, dispose: Function, isSyncing: () => boolean }}
 */
export function createFocusPull(sync, options = {}) {
  const {
    events = ['visibilitychange', 'focus', 'pageshow'],
    target = (typeof window !== 'undefined' ? window : null),
    isVisible = () => (typeof document !== 'undefined' ? document.visibilityState === 'visible' : true),
    hasFocus = () => (typeof document !== 'undefined' ? document.hasFocus() : true),
    onResult = () => {},
  } = options;

  let _disposed = false;
  let _syncing = false;
  let _pending = false;

  function shouldPull() {
    return isVisible() && hasFocus();
  }

  async function _run() {
    // Guard: null/undefined sync or a sync lacking checkAndSync is a no-op.
    if (!sync || typeof sync.checkAndSync !== 'function') return;

    _syncing = true;
    try {
      const result = await sync.checkAndSync();
      onResult(result);
    } catch (err) {
      console.warn('focus pull failed:', err && err.message ? err.message : err);
    } finally {
      _syncing = false;
      if (_pending) {
        _pending = false;
        _run();
      }
    }
  }

  // ONE shared handler for ALL events (same reference for add + remove).
  function _trigger() {
    if (_disposed) return;
    if (!shouldPull()) return;
    if (_syncing) {
      _pending = true;
      return;
    }
    _run();
  }

  // Register/unregister the shared handler for every configured event.
  function _bindEvents(add) {
    if (!target) return;
    for (const event of events) {
      if (add) target.addEventListener(event, _trigger);
      else target.removeEventListener(event, _trigger);
    }
  }

  function start() {
    _disposed = false;
    _bindEvents(true);
    // Immediate mount pull, gated by shouldPull().
    _trigger();
  }

  function dispose() {
    _disposed = true;
    _bindEvents(false);
  }

  return {
    start,
    dispose,
    isSyncing: () => _syncing,
  };
}

/**
 * Thin React hook wrapper around createFocusPull.
 *
 * Creates (or re-creates, on `sync` identity change) the pull instance in render
 * phase, then wires start()/dispose() in a mount/unmount effect.
 *
 * @param {object} sync - SyncService instance
 * @param {object} [options] - forwarded to createFocusPull
 * @returns {{ isSyncing: () => boolean }}
 */
export function useFocusPull(sync, options) {
  const instanceRef = useRef(null);
  const prevSyncRef = useRef(sync);

  if (!instanceRef.current || prevSyncRef.current !== sync) {
    if (instanceRef.current) instanceRef.current.dispose();
    instanceRef.current = createFocusPull(sync, options);
    prevSyncRef.current = sync;
  }

  useEffect(() => {
    const instance = instanceRef.current;
    instance.start();
    return () => instance.dispose();
  }, []);

  return {
    isSyncing: useCallback(() => instanceRef.current.isSyncing(), []),
  };
}
