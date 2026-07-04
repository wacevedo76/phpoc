# Stage 1.2 — Code Review

> **Status:** ✅ GREEN — 67 tests pass, no regressions.
> **Reviewed:** 2026-07-04

---

## Files Changed

| File | Type | Lines |
|------|------|-------|
| `src/sync/reauth.js` | New | 91 |
| `src/components/overlays/ReauthOverlay.jsx` | New | 119 |
| `src/context/DevModeContext.jsx` | Modified | +35 |
| `src/App.jsx` | Modified | +28 |
| `src/components/screens/SyncSettings.jsx` | Modified | +19 |
| `test/reauth_logic_test.mjs` | New | 208 |
| `test/cookie_monitor_reauth_test.mjs` | New | 188 |
| `test/reauth_overlay.test.mjs` | New | 184 |

---

## Modularity ✅

| Aspect | Assessment |
|--------|------------|
| **Separation of concerns** | `performReauth` is pure JS in `src/sync/reauth.js` — no React dependency, importable from any context. `ReauthOverlay.jsx` follows AuthScreen's props-based pattern. |
| **State location** | Reauth state (`reauthState`, `triggerReauth`, `dismissReauth`) lives in `DevModeContext` — appropriate for app-wide overlay management. |
| **Cookie monitor restart** | Version counter (`cookieMonitorVersion`) forces useEffect recreation without phase transitions — clean separation from reauth lifecycle. |
| **Circular deps** | None. `ReauthOverlay.jsx` imports only React. `reauth.js` has zero imports. `DevModeContext.jsx` doesn't import the overlay (it's rendered in App.jsx). |

## Clarity ✅

| Aspect | Assessment |
|--------|------------|
| **Documentation** | JSDoc on `performReauth`, `ReauthOverlay`, all context additions. Flow documented inline. |
| **Error messages** | User-facing: "Passphrase cannot be empty", "No recovery seed found", "Authentication failed", "Sync failed". All actionable. |
| **Variable naming** | `reauthState`, `triggerReauth`, `dismissReauth`, `restartCookieMonitor` — self-documenting. |
| **Pattern consistency** | `ReauthOverlay` mirrors `AuthScreen`'s pattern (onAuthenticated callback, loading/error states, useCallback for handlers). Devs familiar with AuthScreen will recognize ReauthOverlay immediately. |

### Minor note
The ReauthOverlay subtitle always says "Session expired — please re-authenticate" regardless of trigger source (TTL expiry vs sync REAUTH). This is acceptable — the user just needs to re-enter their passphrase either way. Adding a `reason` prop for contextual subtitles would be noise without value.

## Security ✅

| Check | Status |
|-------|--------|
| MK cleared before re-deriving | ✅ `clearMasterKey()` called before `setMasterKey()` in `performReauth` |
| MK cleared on failed reconcile | ✅ Catch block clears MK so user can retry from clean state |
| Empty passphrase rejected | ✅ Front-end validation in both `performReauth` (throws) and `ReauthOverlay` (disables button) |
| Seed never leaked | ✅ Read from storage via `storage.get('phpoc_seed')`, never passed as prop, never logged |
| Passphrase input masked | ✅ `type="password"` with proper label/aria |
| Stale MK protection | ✅ `performReauth` clears any existing MK before setting the new one |
| TTL expiry → reauth vs logout | ✅ MK is cleared (security requirement) but services stay alive for inline re-auth (UX win). If user cancels, falls back to full `logout()`. |
| No new network surface | ✅ `performReauth` calls only existing SyncService method (`_reconcileAndClaim`) |

## Efficiency ✅

| Check | Status |
|--------|--------|
| Single-pass operation | ✅ One seed read, one MK derivation, one reconcile call per re-auth |
| No unnecessary re-renders | ✅ `useCallback` on handlers, stable dependency arrays |
| Services not recreated | ✅ Storage backend stays alive; only MK and cookie are refreshed |
| Cookie monitor lifecycle | ✅ Disposed on TTL expiry, recreated via version increment after re-auth — no polling contention |
| No new lazy imports | ✅ `performReauth` is statically imported in App.jsx |

## Regressions Verified

| Test suite | Result |
|------------|--------|
| `reauth_logic_test.mjs` | 20/20 ✅ |
| `cookie_monitor_reauth_test.mjs` | 33/33 ✅ |
| `reauth_overlay.test.mjs` (vitest) | 14/14 ✅ |
| `sync_service_test.mjs` | 247/248 (W3b pre-existing) |
| Total new tests | **67 assertions** |

No changes to sync algorithm, merge engine, or data format — zero risk of data corruption.
