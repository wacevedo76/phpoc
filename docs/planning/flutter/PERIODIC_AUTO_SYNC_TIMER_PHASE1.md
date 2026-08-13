# Periodic Staging Auto-Sync Timer — Test Exploration (Phase 1)

> **Plan:** Add a **periodic background sync timer** so a device sitting idle (no user
> tap, no mutation) still checks Remote-vs-Local staging and reconciles drift. Live-verified gap
> (2026-08-13): the phone's running activity reached the emulator DB via the Worker after the emulator
> app was **remounted**, but while the app sat idle on the Dashboard there was **no automatic poll** —
> the Dashboard kept showing "No activities yet" until a fresh mount. Root cause: phpoc-flutter only
> syncs on (1) manual Sync/Commit, (2) a local mutation (debounced 500ms), or (3) unlock/reauth. There
> is no **time-based** trigger.
> **References:** `phpoc-flutter/lib/data/sync/sync_service.dart` (`checkAndSync`, `_doPush`,
> `_runAutoSync`, `_debounceTimer`, `dispose`); `phpoc-flutter/lib/routing/app_router.dart`
> (`AppPhase`, `AppLifecycleNotifier`); `phpoc-flutter/lib/features/auth/unlock_screen.dart`
> `_triggerSyncAfterReauth()` (the fire-and-forget one-shot precedent);
> `docs/planning/flutter/REAUTH_TRIGGERS_STAGE_SYNC_PHASE1.md` and
> `docs/planning/flutter/MANUAL_SYNC_PULL_F1_PHASE1.md` (prior 4-phase trigger work).
> **Purpose:** Blueprint of all needed test assertions for (A) a periodic sync timer on
> `SyncService` and (B) a coordinator that starts/stops it as the app enters/leaves the `ready` phase.
> **Status:** ✅ 4-Phase TDD COMPLETE (REFACTOR done) + LIVE WIRED — 2026-08-19
> **Next Phase:** None (complete)
>
> **Phase 4 (REFACTOR) output:** all 11 tests GREEN. In `sync_service.dart` fixed the stale
> `TIME_BASED_TRIGGER_PHASE1.md` section-doc reference → `PERIODIC_AUTO_SYNC_TIMER_PHASE1.md`. In
> `periodic_sync_orchestrator.dart` made the `start`/`stop` callbacks `final` (fixed wiring, no
> accidental reassignment). No behavior change; analyzer clean; no regressions.
>
> **Live wiring (2026-08-19, user request):** new `PeriodicSyncCoordinator`
> (`lib/features/sync/periodic_sync_coordinator.dart`) bridges the orchestrator to a real SyncService,
> observing the always-in-sync `appPhaseNotifier` `ValueNotifier`: start once on entering `ready`,
> stop on leaving, detach+stop on `dispose`. Exposed as `periodicSyncCoordinatorProvider`
> (`providers.dart`) and kept alive by `PhpocApp` (`app.dart`). Added Groups C (6) + C-IT (1) tests in
> `test/features/periodic_sync_coordinator_wiring_test.dart` — **18/18 GREEN** (P+W+C+C-IT). No new
> regressions (baseline 8 pre-existing failures unchanged).
>
> **Phase 2 output:** `phpoc-flutter/test/data/sync/periodic_sync_timer_test.dart` (Group P, 8
> tests) + `phpoc-flutter/test/features/periodic_sync_coordinator_test.dart` (Group W, 3 tests).
> All RED (compilation fails on the not-yet-existing `startPeriodicSync` / `stopPeriodicSync` /
> `PeriodicSyncOrchestrator` API).
>
> **Phase 3 (GREEN) output:** all 11 GREEN. `SyncService.startPeriodicSync(interval)` /
> `stopPeriodicSync()` + `_periodicTimer` + `_onPeriodicTick()` (guard: `_isSyncing`, `_disposed`) in
> `sync_service.dart`; new `PeriodicSyncOrchestrator` in `lib/features/sync/periodic_sync_orchestrator.dart`
> (pure, optional start/stop callbacks, `notifyPhase(AppPhase)`).

---

## Architecture Overview

Two layers are involved:

1. **Sync service — `phpoc-flutter/lib/data/sync/sync_service.dart`**
   Already owns the debounced mutation auto-push (`_debounceTimer`, 500ms → `_doPush()` →
   `_runAutoSyncWithRetry()` → `_runAutoSync()`). It exposes `checkAndSync({bool
   skipReadOnlyFastPath})` which is the *user-facing* reconcile entry — safe on a local-only device
   (first line `if (transport == null) return SyncCheckResult.ready;` D15), guards pre-auth
   (`!crypto.hasMasterKey → reauthNeeded` D14), and with `skipReadOnlyFastPath: true` forces past the
   F1 read-only fast path so it pulls the remote device cookie and does the **hash-index fast-path
   comparison** (cheap ETag/304); it only runs a full `_reconcileAndClaimRowLevel()` (pull →
   merge → push) when the remote hash differs. This is exactly the drift detector we want per tick.
   It also has `bool _isSyncing` (set by `_doPush`) and `dispose()` (cancels `_debounceTimer`, closes
   the status stream).

2. **App lifecycle — `phpoc-flutter/lib/routing/app_router.dart`**
   `AppLifecycleNotifier` (a Riverpod `StateNotifier<AppLifecycleState>`) transitions between
   `AppPhase { boot, landing, onboarding, auth, ready }`. `goToReady()` is the single entry into the
   "signed-in and unlocked" phase (called from unlock screen passphrase/biometric and import screen).
   `ready` is the correct condition under which a periodic sync should run; leaving `ready` (back to
   `auth` on reauth) must stop it.

**Fix seam (two parts):**

**(A) `SyncService.startPeriodicSync(Duration interval)` / `stopPeriodicSync()`** — a recurring
`Timer` held as `_periodicTimer`. Each tick runs a **guarded, fire-and-forget**
`unawaited(checkAndSync(skipReadOnlyFastPath: true))`:
- **Skip when `_isSyncing`** — never overlap a mutation-driven `_doPush()` (single-reconcile invariant).
- **Safety net:** because the tick only calls the user-facing `checkAndSync`, the existing D15
  (no transport) and D14 (no master key) guards already make local-only / pre-auth ticks no-ops.
- `stopPeriodicSync()` cancels the timer; `dispose()` also cancels it (no dangling tick after teardown).
- **Idempotent start:** calling `startPeriodicSync` again restarts the single timer (no double-schedule).

**(B) `PeriodicSyncCoordinator` (orchestrator + optional app-root widget)** — watches the app phase
and calls `startPeriodicSync` on the `ready` entry and `stopPeriodicSync` on leaving `ready`. The
decision logic is extracted into a tiny pure class (`PeriodicSyncOrchestrator`) so it is unit-testable
with injected start/stop callbacks, independent of widget/Riverpod plumbing.

**Default interval:** a const (e.g. 5 s), configurable per call so tests can use short intervals and
real usage a sensible default. Drift detection per tick is cheap (cookie ETag + hash-index comparison),
so the default does not hammer the remote.

## Test Groups

### Group P: SyncService periodic timer — 8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| P1 | `startPeriodicSync(interval)` schedules a recurring timer whose tick invokes `checkAndSync` (spy records calls) at least once after the interval elapses. | Prove the core: a time-based trigger reaches the reconcile entry. | This is the entire missing capability — nothing polls on a timer today. |
| P2 | Each periodic tick calls `checkAndSync` with `skipReadOnlyFastPath: true`. | Prove the tick forces past F1 so remote drift is detected even with no local pending writes. | Without the flag, F1 short-circuits to `ready` with no network, so the timer would be useless for drift. Mirrors MANUAL_SYNC_PULL_F1 / REAUTH semantics. |
| P3 | `startPeriodicSync` on a **local-only** sync (`transport == null`) does not throw and safe/tick is a no-op (returns ready). | D15 guard — no crash from the timer when no remote is configured. | A local-only ledger must never be disrupted by the periodic timer. |
| P4 | A periodic tick while **pre-auth** (`crypto.hasMasterKey == false`) is a no-op (returns `reauthNeeded`, no network). | D14 guard — never sync without a master key. | The timer must not attempt to push/pull encrypted state before the key is cached. |
| P5 | When `_isSyncing` is already true (a mutation `_doPush` is in flight), the periodic tick is skipped (no overlapping/parallel reconcile). | Single-reconcile invariant — never two concurrent syncs. | Prevents races/deadlocks between the debounced push and the timer. |
| P6 | `stopPeriodicSync()` cancels the timer so no further `checkAndSync` calls fire. | Prove the coordinator can halt polling (e.g. app leaves `ready`). | Without cancellation the timer could fire out of phase / after logout. |
| P7 | `dispose()` cancels the periodic timer (no graceful-tick after teardown). | Lifecycle hygiene — no post-dispose network/state access. | Mirrors existing `_debounceTimer?.cancel()` in `dispose`. |
| P8 | Calling `startPeriodicSync` twice (without stop) does not double-schedule — a single timer remains (stop/tick behavior consistent). | Idempotent start. | Prevents duplicate timers stacking if the coordinator re-enters `ready`. |

### Group W: Coordinator / wiring — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| W1 | On entering the **`ready` phase**, the orchestrator invokes `start` (start callback fired, timer begins) and does not start again for a subsequent `ready` frame (no double-start). | Prove the coordinator starts polling exactly once on signed-in/unlocked. | Entry into `ready` is the correct and unambiguous start signal. Idempotent guard maps to P8. |
| W2 | Leaving the **`ready`** phase (e.g. back to `auth`/reauth) invokes `stop` (polling halts). | Prove the coordinator stops polling when the app is no longer ready. | Prevents network polling while the app is re-authenticating. |
| W3 | A null / no-op sync service (`start`/`stop` swallow absence) or local-only transport does not error through the coordinator. | Fail-safe wiring — the coordinator must be a no-op on a local-only ledger. | The coordinator is mounted globally; it must never crash the app on a no-transport install. |

## Summary Report (Phase 1)

- **Total assertions:** 11
- **By group:**
  - Group P = 8 (time trigger reaches checkAndSync, forced flag, D15/D14 guards, no-overlap, stop,
    dispose cancel, idempotent start)
  - Group W = 3 (start on ready, stop on leaving ready, no-op/local-only fail-safe)
- **Files to be created (Phase 2):**
  - `phpoc-flutter/test/data/sync/periodic_sync_timer_test.dart` — Group P (extends the existing
    `_ConfigTransport` + `_FakeStorage` + in-memory `AppDatabase` harness pattern).
  - `phpoc-flutter/test/features/periodic_sync_coordinator_test.dart` — Group W (pure
    `PeriodicSyncOrchestrator` unit tests with injected callbacks; optional thin widget test).
- **Source files to modify / create (Phase 3):**
  - `phpoc-flutter/lib/data/sync/sync_service.dart` — add `_periodicTimer`, `startPeriodicSync`,
    `stopPeriodicSync`; a const default interval; tick guard using `_isSyncing`; cancel in `dispose`.
  - `phpoc-flutter/lib/features/sync/periodic_sync_orchestrator.dart` (new) — pure orchestration class.
  - `phpoc-flutter/lib/app.dart` — mount coordinator / wrap `MaterialApp.router` so phase→sync wiring
    is live (if a widget layer is used; otherwise wire via provider observer).
- **Key coverage areas:** (1) time-based drift detection; (2) forced F1 bypass per tick; (3) local-only
  & pre-auth no-op; (4) single-reconcile (no overlap with `_doPush`); (5) clean stop/dispose; (6)
  phase-gated start/stop.

## Documentation Impact (Phase 1 plan only — no code yet)

| Doc | Action |
|-----|--------|
| `docs/planning/AGENTS.md` | Add this blueprint under the Flutter planning list. |
| `docs/planning/BACKLOG.md` | Add a 🟡 entry tracking the periodic auto-sync timer. |
| `SESSION_HANDOFF.md` | Add to Immediate Next Steps (Phase 1 done → Phase 2 RED next). |
| `docs/design/ARCHITECTURAL_DECISIONS.md` | No new ADR (behavioral extension of the existing sync-trigger surface; consider noting in ROADMAP). |
