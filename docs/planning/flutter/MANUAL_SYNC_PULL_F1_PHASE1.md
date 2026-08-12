# Sync Staging Manual Sync Pull Fix — Test Exploration (Phase 1)

> **Plan:** Root cause of "Sync Staging does not sync staging" on the phpoc-flutter Sync screen
> (reported live: phone has running activities, emulator manual "Sync Staging" never pulls them).
> **ADR / refs:** `phpoc-flutter/lib/data/sync/sync_service.dart` `checkAndSync()` F1 read-only fast path;
> `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12; existing coverage in
> `phpoc-flutter/test/data/sync/sync_service_test.dart` (M6/`skipReadOnlyFastPath`) and
> `sync_service_row_level_test.dart` (A/B/C reconcile groups).
> **Purpose:** Blueprint of all needed test assertions for making the manual **"Sync Staging"** trigger on the
> Flutter Sync screen perform a real bidirectional reconcile (pull remote staging rows) even when the local
> device has **no pending uncommitted writes**.
> **Status:** ✅ Phase 4 (REFACTOR) — 4-Phase TDD COMPLETE (2026-08-11). `sync_screen.dart` `_syncNow()` → `checkAndSync(skipReadOnlyFastPath: true)`. S1(3/3)+S2(3/3, incl. previously-RED **S2.2**)+S3(3/3) GREEN; regression sweep (row_level, merge_engine, ledger_auto_pull) GREEN; E15 flaky & L2/L3/L4/L6+R5 pre-existing unchanged (verified on baseline). Phase 4 tightened the `_syncNow()` comment (clarity/conciseness); no behavior change.
> **Next Phase:** None.

---

## Architecture Overview

Two layers are involved:

1. **UI trigger — `phpoc-flutter/lib/features/sync/sync_screen.dart`**
   The "Sync Staging" `FilledButton` (line ~393) calls `_syncNow()` → `sync.checkAndSync()` **without** the
   `skipReadOnlyFastPath` flag.

2. **Sync service — `phpoc-flutter/lib/data/sync/sync_service.dart`**
   `checkAndSync({bool skipReadOnlyFastPath = false})` contains the **F1 read-only fast path**:

   ```dart
   final pending = await hasPendingWrites();
   if (!pending && !skipReadOnlyFastPath) {
     return SyncCheckResult.ready;   // short-circuits; NEVER pulls remote rows
   }
   ```

   - `hasPendingWrites()` = local staging has ≥1 **uncommitted** row.
   - When the emulator has nothing pending, `skipReadOnlyFastPath=false` (the Sync button default) makes
     `checkAndSync` return `ready` **immediately, before the remote cookie pull / row-level reconcile**. The
     phone's remote rows in the Worker blob are never fetched.
   - The **mutation-driven auto-push** (`_runAutoSync()` → `checkAndSync(skipReadOnlyFastPath: true)`) already
     forces the reconcile past F1, so remote changes ARE picked up **only after a local mutation**. A pure
     pull (manual Sync with empty local staging) is broken.

**Fix seam:** make the manual "Sync Staging" entry point call
`checkAndSync(skipReadOnlyFastPath: true)` so it falls through to the cookie/fast-path comparison and, when the
remote hash differs, to `_reconcileAndClaimRowLevel()` (pull remote `staging/blob` → merge → write → push).

**Already proven GREEN (serve as guards, not RED):**
- Service already supports `skipReadOnlyFastPath: true` (M6 test, L1499) — bypasses F1, reaches reconcile.
- Reconcile path pulls/merges remote rows (`sync_service_row_level_test.dart` B-group).
- The RED gap is (a) the Sync screen does not pass the flag, and (b) no service-level test proves
  `checkAndSync(skipReadOnlyFastPath: true)` pulls remote rows into an **empty** local staging store.

## Test Groups

### Group S1: Manual "Sync Staging" pulls remote rows — service level (empty local staging) — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S1.1 | `checkAndSync(skipReadOnlyFastPath: true)` with **empty local staging** and a remote `staging/blob` containing a row for activity_id `PHONE1` populates the local staging store with that row (visibly via `getAllRows()`). | Prove the forced path actually pulls when local has nothing pending. | This is the exact emulator scenario: no local writes, but the phone's remote row must arrive. |
| S1.2 | The same pull is **NO-OP without the flag**: `checkAndSync()` (flag defaults false) with empty local staging + remote row present returns `ready` and does **NOT** pull `staging/blob` (local store stays empty). | Pin the F1 short-circuit as the bug. | Locks in the current regression so the refactor keeps behavior identical when F1 legitimately applies (e.g. same-device steady state). |
| S1.3 | When remote `staging/blob` is **absent** and local staging is empty, `checkAndSync(skipReadOnlyFastPath: true)` returns `ready` without error and does not fabricate rows (fail-safe, same-device bootstrap). | No over-pull on a bare remote. | Guard against the forced path pulling nothing and still succeeding cleanly. |

### Group S2: UI wiring — the Sync Staging button forces the pull — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S2.1 | Tapping **"Sync Staging"** on `SyncScreen` results in `syncService.checkAndSync` being invoked (widget spy records the call). | Prove the button is wired to the sync entry point. | Baseline wiring test (existing G6 is a stub). |
| S2.2 | The wired `CheckAndSync` call passes `skipReadOnlyFastPath: true` (spy overload records the flag). | Prove the widget forwards the forced-reconcile flag. | The RED root cause: currently the button passes false, so no pull. |
| S2.3 | After the sync-complete pump, the screen reflects a settled `inSync` state and the push button remains functional (regression guard for the `_buildPushToCloudButton` rebuild). | End-state of the tapped flow. | The existing `_dependents.isEmpty` regression test must keep passing. |

### Group S3: Ripple / regression guards — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S3.1 | An **auto-push after a mutation** (`_doSync`/debounce) still forces F1 bypass (already `skipReadOnlyFastPath: true`) and settles `inSync` — unchanged. | Mutation auto-sync unaffected. | AS4/AS5 tests must remain green; the flag change must not touch that path. |
| S3.2 | A **remote cookie mismatch** detected via the forced path still yields `reauthNeeded` and destroys the local cookie. | Forced reconcile must not weaken cookie/reauth security. | M6/M5 behavior; forcing F1 bypass exposes the cookie-comparison branch on every manual sync, which is correct. |
| S3.3 | **Offline / throw** during the forced manual sync does not crash the widget and surfaces an error state (no unhandled exception). | Fail-safe on network error. | A manual sync must degrade gracefully, not escape an unhandled error. |

## Summary Report (Phase 1)

- **Total assertions:** 9
- **By group:**
  - Group S1 = 3 (service-level: forced pull populates empty local; F1 short-circuit pinned; bare-remote fail-safe)
  - Group S2 = 3 (Sync Staging button wires checkAndSync with `skipReadOnlyFastPath: true`; settled inSync; push-button rebuild guard)
  - Group S3 = 3 (mutation auto-push unchanged; cookie/reauth still enforced; offline fail-safe)
- **Files to be created / modified (Phase 2):**
  - `phpoc-flutter/test/data/sync/manual_sync_pull_test.dart` (new — S1 service-level tests)
  - `phpoc-flutter/test/features/sync_screen_test.dart` (extend — S2/S3 widget tests)
- **Source file to modify (Phase 3):**
  - `phpoc-flutter/lib/features/sync/sync_screen.dart` — `_syncNow()` calls `checkAndSync(skipReadOnlyFastPath: true)`.
- **Key coverage areas:** (1) manual sync pulls remote rows with empty local staging; (2) F1 short-circuit pinned; (3) button forwards the forced flag; (4) mutation auto-sync, reauth, offline all preserved.

## Documentation Impact (Phase 1 plan only — no code yet)

| Doc | Action |
|-----|--------|
| `docs/planning/AGENTS.md` | Add this blueprint (or list under an existing Flutter sync section) — planning index. |
| `docs/planning/BACKLOG.md` | Add a 🟡 entry tracking the F1 manual-sync-pull fix. |
| `SESSION_HANDOFF.md` | Add this task to Immediate Next Steps (Phase 1 done → Phase 2 RED next). |
| `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` | No change (behavioral parity confirmed; no protocol change). |
| `docs/planning/ROADMAP.md` | No status change yet (only on milestone). |
