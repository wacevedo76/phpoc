# Re-auth Overlay for TTL Expiry — TDD Test Plan

> **Status:** 🔴 RED — tests written (35 unit + 27 integration), all RED (createCookieMonitor not implemented).
> **Feature:** Proactive cookie TTL monitoring → clear cached master key → show re-auth overlay.

## Problem Statement

The device cookie has a 30-minute TTL. When the TTL expires naturally:

- `checkAndSync()` only runs when the user presses "Sync Now" or auto-sync fires a push — not proactively.
- The master key stays cached indefinitely (only cleared on explicit logout).
- With cached MK, `checkAndSync()` passes through `_reconcileAndClaim()` and auto-refreshes the cookie without re-auth.

**Result:** TTL expiry is invisible. The "auto-lock" security property of the cookie TTL is not enforced.

## Goal

When the device cookie TTL expires (30 min inactivity):

1. Proactively detect expiry (polling or visibility-based)
2. Clear the cached master key from `CryptoService`
3. Show the re-auth overlay (already wired in `App.jsx` + `DevModeContext`)
4. After successful passphrase entry, re-derive MK and dismiss overlay

The re-auth overlay, `triggerReauth()`, `handleReauth()`, and `dismissReauth()` already exist and work — only the *proactive trigger* is missing.

## Implementation Approach

Create a `createCookieMonitor()` pure function (following the `createAutoSync` pattern) that:

- Accepts `storage`, `crypto`, `cookieTtlMinutes`, `onExpired` callback, and `pollIntervalMs`
- On `start()`: immediately checks cookie TTL, then polls on interval
- When TTL expires: calls `crypto.clearMasterKey()` then `onExpired()` (once only)
- `dispose()`: stops polling, clears pending timers
- Idempotent `start()`/`dispose()` — calling twice is safe

Wired into `DevModeContext.jsx` during the `ready` phase boot, connecting `onExpired` to `triggerReauth`.

---

## Test File 1: `phpoc-web/test/reauth_ttl_test.mjs` (NEW)

Tests the `checkCookieTtl()` helper and `createCookieMonitor()` function. Uses `MemoryBackend`, `MockSyncService`, `MockCrypto` (same patterns as `sync_service_test.mjs`). ~30 tests across 5 categories.

### Category A: `checkCookieTtl()` Unit Tests (7 tests)

Currently untested — `DevModeContext.checkCookieTtl` exists but has zero coverage.

| # | Test | Description |
|---|------|-------------|
| A1 | `checkCookieTtl` returns `true` when cookie is valid | Fresh creation_time within TTL → valid |
| A2 | `checkCookieTtl` returns `false` when cookie is expired | creation_time older than TTL → expired |
| A3 | `checkCookieTtl` returns `false` when no cookie exists in storage | Missing cookie → not valid |
| A4 | `checkCookieTtl` returns `false` when cookie has empty/missing device_specifier | Corrupt cookie → invalid (cleaned up by DeviceCookie internally) |
| A5 | `checkCookieTtl` returns `false` when cookie has null/missing creation_time | Missing creation_time → invalid |
| A6 | `checkCookieTtl` returns `true` when sync service is null (no remote configured) | Graceful fallback — no remote means no cookie monitoring needed |
| A7 | `checkCookieTtl` returns `true` when storage is null | Graceful fallback — services not yet ready |

### Category B: `createCookieMonitor` — Polling Behavior (8 tests)

| # | Test | Description |
|---|------|-------------|
| B1 | `start()` fires immediate TTL check (synchronous initial probe) | Startup check on first call |
| B2 | `start()` calls `onExpired` when cookie is expired at startup | Immediate expiry at boot |
| B3 | `start()` does NOT call `onExpired` when cookie is valid | No false positives on boot |
| B4 | Polling fires after `pollIntervalMs` elapses | Periodic check works |
| B5 | `onExpired` called only once per expiry (no duplicate calls for same session) | Single trigger |
| B6 | After `onExpired` fires, polling stops (no more checks until restart) | Auto-stop after expiry |
| B7 | `dispose()` stops polling — timer cleared, no further checks | Cleanup |
| B8 | `dispose()` is safe to call twice (second call is no-op) | Idempotent cleanup |

### Category C: `createCookieMonitor` — Edge Cases (7 tests)

| # | Test | Description |
|---|------|-------------|
| C1 | Monitor does nothing when `onExpired` callback is not provided | Missing callback handled |
| C2 | Monitor handles storage read errors gracefully (doesn't crash, keeps polling) | Error resilience |
| C3 | Monitor handles `onExpired` throwing without breaking internal state | Callback errors isolated |
| C4 | After `onExpired` fires, calling `check()` returns `false` | State consistency post-expiry |
| C5 | `start()` after `dispose()` restarts monitoring with fresh poll cycle | Re-activation |
| C6 | Very short poll interval works correctly (test with 10ms) | Boundary timing |
| C7 | Monitor with null storage → never triggers `onExpired` (skips checks) | Graceful when services missing |

### Category D: MK Clearing (6 tests)

| # | Test | Description |
|---|------|-------------|
| D1 | When TTL expires, `crypto.clearMasterKey()` is called before `onExpired` | MK cleared first |
| D2 | After MK cleared, `crypto.hasMasterKey()` returns `false` | State verified |
| D3 | After MK cleared, `crypto.getMasterKey()` returns `null` | State verified |
| D4 | When MK already cleared (prior logout), TTL expiry does not call `clearMasterKey()` again | Idempotent |
| D5 | When no crypto service provided, TTL expiry still calls `onExpired` without crashing | Graceful |
| D6 | `onExpired` is called even if `clearMasterKey()` throws — expiry always signals | Callback always delivered |

### Category E: Overlay Trigger Integration (7 tests)

| # | Test | Description |
|---|------|-------------|
| E1 | TTL expiry → `triggerReauth()` called → `reauthActive` becomes `true` | Overlay state set |
| E2 | `dismissReauth()` → `reauthActive` becomes `false` | Overlay dismissed |
| E3 | `triggerReauth()` when already active is safe (overlay stays open) | Idempotent trigger |
| E4 | `handleReauth(passphrase)` sets MK on crypto and dismisses overlay | Happy path |
| E5 | `handleReauth(wrongPassphrase)` throws → error state → overlay stays | Auth failure |
| E6 | `handleReauth` when no seed stored throws with message "No recovery seed found" | Missing seed |
| E7 | `handleReauth` when no storage/crypto throws with clear message | Services not ready |

---

## Test File 2: `phpoc-web/test/reauth_integration_test.mjs` (NEW)

Full integration tests combining `createCookieMonitor` + `SyncService` + re-auth flow. Uses `MemoryBackend`, `MockTransport`, `MockCrypto`, `SyncService` (same patterns as `sync_service_test.mjs`). ~17 tests across 4 categories.

### Category F: Full TTL Expiry → Re-auth → Recovery Flow (6 tests)

| # | Test | Description |
|---|------|-------------|
| F1 | TTL expires → MK cleared → overlay triggered → successful re-auth → MK restored → `checkAndSync()` returns `READY` | End-to-end happy path |
| F2 | TTL expires → MK cleared → overlay → wrong passphrase → error shown → overlay stays open | Auth failure loop |
| F3 | TTL expires → MK cleared → overlay → correct passphrase → MK restored → auto-sync resumes (mutations push) | Auto-sync after reauth |
| F4 | TTL expires → MK cleared → overlay dismissed (no reauth) → MK stays cleared → `checkAndSync()` returns `REAUTH_NEEDED` | Dismiss without auth |
| F5 | TTL valid → no MK cleared → no overlay → `checkAndSync()` returns `READY` (fast path) | Normal operation undisturbed |
| F6 | TTL expires → MK cleared → overlay → reauth → capture entry works → push happens | Post-reauth mutation works |

### Category G: Interaction with Existing Auth Gate (4 tests)

| # | Test | Description |
|---|------|-------------|
| G1 | Cookie TTL expired + MK cleared by monitor → `checkAndSync()` returns `REAUTH_NEEDED` | Consistent with auth gate |
| G2 | Cookie TTL expired + MK cleared → `_reconcileAndClaim()` not reached (no MK to pass) | Auth gate blocks |
| G3 | Cookie TTL expired but MK still cached (edge: monitor not running) → `checkAndSync()` proceeds via `_reconcileAndClaim()` | Auth bypass with MK (design invariant #5) |
| G4 | Specifier mismatch still returns `REAUTH_NEEDED` even with valid TTL | Specifier mismatch independent of TTL |

### Category H: Logout + Re-login Interaction (3 tests)

| # | Test | Description |
|---|------|-------------|
| H1 | Logout clears MK, dismisses overlay, disposes TTL monitor | Full cleanup |
| H2 | After logout + login, TTL monitor restarts with fresh cookie from new session | Fresh session |
| H3 | Logout during active reauth overlay → overlay dismissed → services cleaned → landing screen shown | Interrupt reauth |

### Category I: Edge Cases (4 tests)

| # | Test | Description |
|---|------|-------------|
| I1 | TTL expiry during in-flight auto-sync push → push completes, then MK cleared | Don't interrupt active operations |
| I2 | `handleReauth` called twice in rapid succession → first completes, second is no-op | Race condition safety |
| I3 | Cookie TTL at exact boundary (elapsedMs === ttlMs) → treated as expired | Boundary condition |
| I4 | Multiple rapid `start()`/`dispose()` cycles don't leak timers | Timer hygiene under stress |

---

## Existing Test Files to Update

| File | Changes | Tests |
|------|---------|-------|
| `sync_service_test.mjs` | Add 2 tests in Group H: `checkAndSync()` returns `REAUTH_NEEDED` when MK cleared by TTL monitor; `checkAndSync()` with fresh cookie after reauth MK restore returns `READY` | +2 |
| `auto_sync_hook_test.mjs` | Add 1 test: auto-sync wrapper handles `getMasterKey() === null` gracefully (mutations still work, push skipped, no crash) | +1 |

---

## Files That Will Be Created/Modified (Implementation — not tests)

| File | Nature | LOC (est.) |
|------|--------|-----------|
| `phpoc-web/src/hooks/useCookieMonitor.js` | **NEW** — `createCookieMonitor()` pure function + optional React hook `useCookieMonitor()` | ~80 |
| `phpoc-web/src/context/DevModeContext.jsx` | **MODIFIED** — Wire monitor into ready-phase boot; connect `onExpired` → `triggerReauth` + `clearMasterKey` | +25 |
| `phpoc-web/src/App.jsx` | No changes needed — overlay already renders when `reauthActive` is true | 0 |

---

## Summary

| Metric | Count |
|--------|-------|
| New test files | 2 |
| Total new tests | ~47 |
| Existing tests updated | +3 across 2 files |
| Categories | A–I (9 categories) |
| Test infrastructure | Node.js + TestHelpers + MemoryBackend + MockTransport + MockCrypto |
| RED phase target | All ~47 new tests fail, 3 additions fail |
| GREEN phase target | All ~50 tests pass, 0 regressions |

## Execution Order

1. **RED**: Write `reauth_ttl_test.mjs` (tests A1–E7) — all fail
2. **RED**: Write `reauth_integration_test.mjs` (tests F1–I4) — all fail
3. **RED**: Add 3 tests to existing files — all fail
4. **GREEN**: Implement `createCookieMonitor()` in `src/hooks/useCookieMonitor.js`
5. **GREEN**: Wire monitor into `DevModeContext.jsx` ready-phase boot
6. **GREEN**: All 50 tests pass, zero regressions
7. **Refactor**: Extract `checkCookieTtl` to shared location if needed
8. **Docs**: Update AGENTS.md hierarchy, MAP.md, WEB_ROADMAP.md, SESSION_HANDOFF.md

## Design Decisions

- **Pure function pattern (`createCookieMonitor`)** over React hook — same reason as `createAutoSync`: DevModeContext manages its own lifecycle via `useMemo`/`useRef`. No React rendering needed.
- **`clearMasterKey()` before `onExpired`** — so downstream sync operations immediately see `null` MK.
- **Single-fire expiry** — after `onExpired` fires, polling stops. User must re-auth to restart. This avoids the overlay flashing repeatedly.
- **`dispose()` on logout** — TTL monitor disposed during `logout()`, restarted on fresh `login()`.
- **No visibility API for v1** — polling alone is sufficient. Tab visibility optimization deferred.
