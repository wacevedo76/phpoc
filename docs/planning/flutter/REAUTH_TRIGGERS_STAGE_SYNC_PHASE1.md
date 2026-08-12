# Trigger Stage Sync After Re-authentication — Test Exploration (Phase 1)

> **Plan:** Root cause of "the stage syncing workflow does not trigger after re-authentication" on
> phpoc-flutter. Live-reported: after unlocking/re-authenticating, the device lands on the main shell
> showing stale local staging; remote ledger commits and the other device's staging rows only arrive
> once the user taps "Sync Staging" or makes a mutation.
> **References:** `phpoc-flutter/lib/features/auth/unlock_screen.dart` (`_unlock`, `_biometricUnlock`,
> `_promptReauth`); `phpoc-flutter/lib/data/sync/sync_service.dart` `checkAndSync()` (F1 fast path,
> ADR-030 ownership-handoff branch); CLI parity `phpoc_cli/interface.py` `_rebuild_after_reauth`;
> `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-030; `docs/planning/flutter/MANUAL_SYNC_PULL_F1_PHASE1.md`
> (the manual-pull fix that unlocked `skipReadOnlyFastPath: true` trigger semantics).
> **Purpose:** Blueprint of all needed test assertions for making a successful re-authentication
> (via the Unlock screen) automatically run a bidirectional staging sync — fire-and-forget, non-blocking —
> so a just-unlocked device sees the latest remote ledger AND the latest staging scratchpad.
> **Status:** ✅ Phase 4 (REFACTOR) — 4-PHASE TDD COMPLETE (2026-08-11). Phase 3 GREEN 6/6:
> `unlock_screen.dart` `_triggerSyncAfterReauth()` (fire-and-forget `unawaited(checkAndSync(skipReadOnlyFastPath: true))`)
> wired into `_unlock()` and `_biometricUnlock()` after auth success, before `goToReady()`. Analyzer clean; no
> regressions (dashboard T7/U1/U3 + sync_screen L2/L3/L4/L6+R5 pre-existing, baseline-identical). Phase 4 tightened
> the two redundant call-site comments (clarity/conciseness) — the helper doc retains the ADR-030 rationale.
> **Next Phase:** None.

---

## Architecture Overview

Two layers are involved:

1. **Auth entry — `phpoc-flutter/lib/features/auth/unlock_screen.dart`**
   - `_unlock()`: passphrase → `authService.reauthenticate(passphrase)` (caches the master key) →
     `lifecycle.goToReady()`.
   - `_biometricUnlock()`: (if enabled) → `authService.unlockWithBiometric()` → `lifecycle.goToReady()`.
   - Neither path calls the sync service. After re-auth the app is "ready", but remote staging/ledger
     state is not refreshed until the user taps "Sync Staging" or makes a mutation.

2. **Sync service — `phpoc-flutter/lib/data/sync/sync_service.dart`**
   `checkAndSync({bool skipReadOnlyFastPath = false})`:
   - Safe on a local-only device: **first line** is `if (transport == null) return SyncCheckResult.ready;`
     (D15 no-remote path) — so calling it after unlock on a no-transport app is a no-op.
   - With a transport: F1 read-only fast path short-circuits to `ready` when `!pending &&
     !skipReadOnlyFastPath`; `skipReadOnlyFastPath: true` forces the cookie comparison / reconcile.
   - When the master key is cached (post-reauth, A3 now passes) and no valid cookie exists
     (destroyed earlier on A1/A2, or fresh device), it runs the **ownership handoff** branch:
     `_reconcileLedgerOnHandoff()` (ADR-030: block-count-gated ledger pull) then
     `_reconcileAndClaimRowLevel()` (pull staging blob → merge → write → push).

**Fix seam:** after a successful unlock, kick an **unawaited / fire-and-forget**
`syncService.checkAndSync(skipReadOnlyFastPath: true)` so it falls through to the cookie/handoff
reconcile and pulls both the remote ledger and remote staging rows. Because it is unawaited, unlock
navigation is not delayed by the network round-trip (matches the CLI's background `timeout_ms=500`
style and the mutation `_doPush` pattern).

**Why `skipReadOnlyFastPath: true`:** re-auth destroys/expires the local cookie in the A1/A2
`reauthNeeded` case, so `checkAndSync` would reach the handoff branch anyway. But forcing the flag
guarantees the reconcile even when the local store still holds no pending uncommitted rows (e.g. a
same-device TTL reauth with MK only temporarily cleared) — exactly the manual-pull fix semantics
(MANUAL_SYNC_PULL_F1_PHASE1).

## Test Groups

### Group U1: Unlock (passphrase) triggers a fire-and-forget staging sync — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| U1.1 | After a successful passphrase unlock on `UnlockScreen`, `syncService.checkAndSync` is invoked at least once (spy records the call). | Prove unlock wires to the sync entry point. | The core gap: today `checkAndSyncCalls == 0`. Pins the fix. |
| U1.2 | The wired `checkAndSync` call passes `skipReadOnlyFastPath: true`. | Prove the post-reauth trigger forces past F1 (pulls remote rows into an empty local store). | Mirrors the manual "Sync Staging" fix semantics; a valid-cookie-only fast path must not skip the pull. |
| U1.3 | The sync trigger is **fire-and-forget**: the Unlock screen reaches "ready" and the passphrase completion is not gated on the (network) sync result. | Ensure re-auth is not delayed by the side-effect sync. | The user must not wait on a network round-trip to unlock. The trigger is spawned and not awaited for navigation. |

### Group U2: Biometric unlock also triggers the sync — ~1 test

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| U2.1 | After a successful biometric unlock, `checkAndSync` is likewise invoked (fire-and-forget). | Parity between passphrase and biometric unlock entry points. | `_biometricUnlock()` must behave like `_unlock()` or users path-go around the fix on devices with biometrics enabled. |

### Group U3: Fail-safe / non-regression guards — ~2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| U3.1 | A **wrong passphrase** (reauthenticate throws) does NOT trigger `goToReady()` and does NOT call `checkAndSync`. | No sync on failed auth; reauth security preserved. | Sync after auth must only happen on genuine success, never on a rejected passphrase. |
| U3.2 | A successful unlock with **no transport configured** (`checkAndSync` returns `ready` immediately) still navigates to ready and does not error — the fire-and-forget path is a no-op. | D15 local-only guard. | Unlock must never be blocked by the sync side-effect on a local-only ledger. |

## Summary Report (Phase 1)

- **Total assertions:** 6
- **By group:**
  - Group U1 = 3 (passphrase unlock → checkAndSync invoked, forwards the forced flag, fire-and-forget)
  - Group U2 = 1 (biometric unlock parity)
  - Group U3 = 2 (failed auth no-sync; no-transport no-op)
- **Files to be created / modified (Phase 2):**
  - `phpoc-flutter/test/features/unlock_screen_test.dart` (extend — U1/U2/U3 groups) OR a new
    `phpoc-flutter/test/features/reauth_sync_unlock_test.dart` if the existing file's harness cannot
    exercise a real reauth.
- **Source file to modify (Phase 3):**
  - `phpoc-flutter/lib/features/auth/unlock_screen.dart` — `_unlock()` and `_biometricUnlock()` fire
    `unawaited(sync.checkAndSync(skipReadOnlyFastPath: true))` after auth success, before `goToReady()`.
- **Key coverage areas:** (1) re-auth → sync wiring on both entry points; (2) forced F1 bypass; (3)
  fire-and-forget; (4) failed-auth no-sync; (5) no-transport no-op.

## Documentation Impact (Phase 1 plan only — no code yet)

| Doc | Action |
|-----|--------|
| `docs/planning/AGENTS.md` | Add this blueprint under the Flutter planning list. |
| `docs/planning/BACKLOG.md` | Add a 🟡 entry (or link) tracking the unlock-triggers-sync fix. |
| `SESSION_HANDOFF.md` | Add to Immediate Next Steps (Phase 1 done → Phase 2 RED next). |
| `docs/design/ARCHITECTURAL_DECISIONS.md` | No new ADR (behavioral extension of ADR-030 trigger surface; document in the ADR-030 entry if desired). |
