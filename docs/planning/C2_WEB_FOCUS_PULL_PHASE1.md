# C2 — Web Foreground/Focus Pull — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CROSS_CLIENT_STAGING_CONVERGENCE_PLAN.md` → C2 (Web foreground/focus pull)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 4 (REFACTOR) DONE — 4-phase TDD COMPLETE
> **Next Phase:** None (complete)

## Architecture Overview

**Problem (live E2E, 2026-09-05/06):** `phpoc-web` is **push-only** — `useAutoSync` is a 500 ms
debounced `pushToRemote`. There is no read/merge trigger, so an idle Web session never observes
rows another client (Flutter/CLI) pushed to the remote staging blob until the user manually
presses "Sync Now". Flutter has a 5 s `checkAndSync` tick; Web has nothing.

**Fix (C2, client-local — no contract change):** add an **event-driven** `checkAndSync()`-based
pull on `visibilitychange` / `focus` / `pageshow` (and screen mount), so an idle Web session
converges to remote when the user returns to the tab. Per **ADR-034 DS4**, this is
**event-triggered, not a periodic timer** — the continuous-poll variant (Flutter's
`PERIODIC_AUTO_SYNC_TIMER_PHASE1.md`) is superseded; the `staging_hash` gate (ADR-034, C4)
is what will later make each pull cheap. C2 reuses the **existing** `SyncService.checkAndSync()`
gate unchanged — it does not add a new protocol, does not bypass the cookie/specifier auth
decision (I1), and does not auto-claim ownership (consent stays gated in `_reconcileAndClaim`).

### Modules & relationships

```
window/document events ──► createFocusPull(sync, options) ──► sync.checkAndSync()
  visibilitychange            (pure factory, no React)            │
  focus                                                           ▼
  pageshow                                        SyncResult: READY / OFFLINE /
                                                               REAUTH_NEEDED / GENESIS_MISMATCH
                                                               │
                                                    onResult(result) callback ──► DevModeContext
                                                        (READY/OFFLINE: no-op)      (REAUTH_NEEDED →
                                                        (REAUTH_NEEDED: surface)    triggerReauth('focus_pull')
                                                                                    GENESIS_MISMATCH →
                                                                                    setGenesisMismatch(true))

useFocusPull(sync, options) — thin React wrapper (useRef + useEffect + useCallback),
  mirrors useAutoSync/useCookieMonitor. Wired in DevModeContext via a useEffect that
  starts the monitor when phase === 'ready' && services.sync exists, disposes otherwise.
```

### Design decisions (locked)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Event-driven, not periodic** (ADR-034 DS4). Events: `visibilitychange`, `focus`, `pageshow` + mount. | Removes polling request cost; "remote is source of truth" realized lazily at interaction time. |
| D2 | Trigger **reuses** `SyncService.checkAndSync()` verbatim; no new pull path, no `skipReadOnlyFastPath` flag. | C2 is client-local; the existing gate already implements pull+merge+push + REAUTH_NEEDED-on-mismatch + OFFLINE-fail-open. |
| D3 | **`shouldPull()` gate = `isVisible() && hasFocus()`** (both injectable). Hidden/unfocused tab never pulls. | Don't hit the network in a background tab; only converge when the user actually returns. |
| D4 | **Re-entrancy guard + coalescing pending re-run.** At most one in-flight `checkAndSync`; events during flight set a `_pending` flag → exactly one re-run after completion. | Prevents unbounded overlap (e.g. rapid focus/visibility toggles) and still converges if remote changed mid-sync. |
| D5 | **Result surfaced via `onResult(result)` callback** (default no-op). READY/OFFLINE are swallowed; REAUTH_NEEDED and GENESIS_MISMATCH are passed up for the context to surface. | Hook stays generic/pure; the React wiring (DevModeContext) decides overlay/banner behavior. Never auto-claims. |
| D6 | **Fire-and-forget, non-blocking.** The event handler returns immediately; `checkAndSync` runs in the background (render-local-first, ADR-034 §8 "Web: async"). | Zero perceived latency on tab return; failures never throw into the event loop. |
| D7 | **Errors swallowed** (`console.warn`), `isSyncing` always resets, `onResult` not called on throw. | Mirrors `useAutoSync` push-failure resilience; a broken sync must not wedge the focus hook. |
| D8 | **Injectable event target + predicates** (`events`, `isVisible`, `hasFocus`). | Deterministic node tests without a DOM (mirrors `createCookieMonitor`'s injected storage/crypto). |

**Invariants preserved:** I1 (cookie/`device_specifier` remains the sole auth decision — the hook
never authorizes/claims); the §12 state machine is untouched; CLI impact is **none** (command-driven).

## Test Groups

### Group A: Event triggers — 6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `visibilitychange`→visible fires `checkAndSync` once | Foreground return triggers the pull | The primary convergence trigger; an idle session must converge on tab return |
| A2 | `focus` fires `checkAndSync` | Window focus triggers the pull | Same-tab refocus (no visibility toggle) must also converge |
| A3 | `pageshow` fires `checkAndSync` | bfcache/back-nav restore triggers the pull | Back/forward navigation restores a stale page; must re-check remote |
| A4 | `visibilitychange`→hidden does **not** fire | Backgrounding never pulls | No network in a hidden tab (D3) |
| A5 | `focus` with `hasFocus()===false` does **not** fire | Unfocused window never pulls | Guard is per-event, not per-registration |
| A6 | `start()` (screen mount) fires one immediate pull | Mount convergence | Web read trigger per ADR-034 §8 is "screen mount"; fresh mount must reconcile |

### Group B: Guards (no-op conditions) — 3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `sync === null/undefined` → `start()` no-op, no crash, no call | Boot-safety | Hook may be constructed before services exist (pre-`ready` phase) |
| B2 | `sync` without a `checkAndSync` method → no crash, no call | Interface-safety | Defensive against a malformed/partial sync object |
| B3 | `isVisible()===false` at `start()` → mount pull suppressed | Hidden-tab mount | Mount pull is gated by the same `shouldPull()` predicate as events |

### Group C: Re-entrancy & coalescing — 4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | event while in-flight → no second concurrent `checkAndSync` | Single-flight guard | Prevents overlap from rapid focus/visibility toggles |
| C2 | event during flight → exactly one pending re-run after completion | Coalesced convergence | If remote changed mid-sync, one follow-up pull catches it (D4) |
| C3 | `isSyncing()` true during flight, false after settle | State observability | Feeds UI indicator; must not stick on error/throw |
| C4 | multiple events during flight → coalesce to a single re-run (not N) | No queue explosion | A burst of toggles must not schedule one pull per event |

### Group D: Result & error handling — 6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `onResult('READY')` delivered | Success passthrough | Context no-ops on READY |
| D2 | `onResult('OFFLINE')` delivered | Offline passthrough | D6 fail-open: offline never throws, just signals |
| D3 | `onResult('REAUTH_NEEDED')` delivered, **no auto-claim** | Consent surfaced, not bypassed | Cross-device mismatch must surface the re-auth overlay (I1); the hook must NOT call `_reconcileAndClaim` itself |
| D4 | `onResult('GENESIS_MISMATCH')` delivered | Mismatch surfaced | Context flips the genesis banner |
| D5 | `checkAndSync` throws → swallowed (`console.warn`), `isSyncing` resets, `onResult` **not** called | Crash-resilience | A broken sync must not wedge the hook or produce a false result |
| D6 | `onResult` omitted (undefined) → no crash | Optional callback | Default no-op; factory usable without a result consumer |

### Group E: Cleanup / lifecycle — 4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `dispose()` removes **all** registered listeners (same handler refs passed to `removeEventListener`) | No leaked listeners | Unmount must not leave stale handlers firing into a disposed hook |
| E2 | event after `dispose()` → no call | Dead-after-dispose | Mirror of `useAutoSync` H1 (suppress after unmount) |
| E3 | `dispose()` during in-flight → no further triggers, in-flight completes without crash, `isSyncing` resets | Mid-flight teardown | Unmount during a slow sync must be safe |
| E4 | `start()` after `dispose()` re-registers (idempotent restart) | Re-activation | Mirror of `createCookieMonitor` restart semantics (re-auth re-mount) |

### Group F: Non-blocking (fire-and-forget) — 2 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `syncNow()` / event handler returns before `checkAndSync` resolves | Non-blocking trigger | Render-local-first: no perceived latency on tab return (D6) |
| F2 | a **rejecting** `checkAndSync` produces no unhandled rejection | Async-safety | The `try/catch` must be in the async path, not a `.then` that leaks a rejection |

## Summary

- **Total assertions:** 25 (A 6 · B 3 · C 4 · D 6 · E 4 · F 2)
- **Source file (Phase 3):** `phpoc-web/src/hooks/useFocusPull.js` — `createFocusPull` (pure) + `useFocusPull` (React).
- **Test file (Phase 2):** `phpoc-web/test/focus_pull_hook_test.mjs` (node unit, `test_helpers.mjs` harness, fake event target + injected predicates — mirrors `auto_sync_hook_test.mjs` / `cookie_monitor_reauth_test.mjs`).
- **Wiring (Phase 3, manual E2E):** `DevModeContext.jsx` `useEffect` — start on `phase==='ready'`; `onResult` maps `REAUTH_NEEDED`→`triggerReauth('focus_pull')`, `GENESIS_MISMATCH`→`setGenesisMismatch(true)`.
- **Coverage areas:** event wiring (A), boot/interface guards (B), single-flight + coalescing (C), result/error contract (D), lifecycle (E), non-blocking (F).
- **Not tested here (manual Vivaldi E2E, Phase 3+):** Flutter push → Web focus-converges-without-Sync-Now end-to-end; re-auth-overlay surfacing UX.
