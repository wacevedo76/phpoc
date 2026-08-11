# Staging Auto-Sync (AS1–AS4) — Test Exploration (Phase 1)

> **Plan:** `docs/planning/STAGING_AUTO_SYNC_PLAN.md`
> **Purpose:** Blueprint of all needed test assertions before writing any test code for upgrading debounced auto-push from push-only to **bidirectional** sync.
> **Status:** 🔜 Phase 1 (test exploration) complete — **Phase 2 (RED) ✅ done** (AS1–AS6 added to `sync_service_row_level_test.dart`) — **Phase 3 (GREEN) ✅ done** (AS1–AS6 all GREEN; `_doPush()` rewired through `checkAndSync()`)
> **Next Phase:** Phase 4 (REFACTOR)

## Background

The `SyncService` already auto-pushes after every staging mutation. Each mutation
(`capture`, `end`, `pause`, `unpause`, `modify`, `remove`) calls `_schedulePush()`,
which debounces (500ms) and then fires `_doPush()`. Today `_doPush()` is **push-only**:

```
_doPush() → _attemptPush() → _pushStagingRowsToRemote()   [push local ↑ only]
```

The manual "Sync Staging" button calls `checkAndSync()`, which is the full
**bidirectional** reconcile (pull remote ↓ + LWW merge + push merged ↑). The gap:
remote-only staging entries never appear locally unless the user remembers to tap the
button.

## Goal

Upgrade `_doPush()` to call `checkAndSync()` so every debounced auto-push is
bidirectional. `checkAndSync()` already handles fast path (cookie + hash-index),
full reconcile (no cookie), offline no-op, and `reauthNeeded`. The auto-sync wrapper
must additionally:
- **Silently tolerate `reauthNeeded`** (no throw, no UI prompt) — cookie conflicts
  degrade gracefully during background auto-sync.
- **Preserve the sync-status stream contract** (`pendingPush` → `inSync`|`error`).
  `checkAndSync()` returns an enum, not the current bool; status must be derived
  from the returned `SyncCheckResult` rather than discarded.

## Architecture Overview

```
Mutation (capture/end/pause/unpause/modify/remove)
  └─ _schedulePush()                       (debounce 500ms)
      └─ _doPush()  [TARGET OF CHANGE]
          └─ CHECKAND  → checkAndSync()    (pull + merge + push)
             ├─ Fast path (cookie match)  → _fastPathRowLevel() (hash-index Tier 1/2)
             ├─ Full reconcile (no cookie)→ _reconcileAndClaimRowLevel() (LWW merge)
             ├─ OFFLINE (net/genesis fail)→ no-op, status = error
             └─ REAUTH_NEEDED (cookie bad)→ silent skip (cookie destroyed)
```

Supporting pieces already in place (no change expected):
- `checkAndSync()` — `sync_service.dart:466`
- `_reconcileAndClaimRowLevel()` — `sync_service.dart:635` (pull blob, `mergeEntries` LWW)
- `_fastPathRowLevel()` — `sync_service.dart:677` (hash-index compare; identical → push only)
- `_pushStagingRowsToRemote()` — pushes local→remote row blob
- `SyncingStatus` enum — `inSync` | `pendingPush` | `error`
- `SyncCheckResult` enum — `ready` | `offline` | `reauthNeeded` | `genesisMismatch`

## Test Location Decision

The plan doc says "add AS1–AS4 to `sync_service_overhaul_test.dart`." **Phase 1
revises this**: that file's `_TestTransport.pull()` always returns `null`, so it
cannot simulate a remote blob for AS1 (bidirectional pull+merge). The correct home is
**`sync_service_row_level_test.dart`**, whose `_ConfigTransport` supports per-path pull
responses (remote blob, remote cookie, remote hash index) and tracks push/pull paths
— exactly what AS1/AS4 need. AS2/AS3 are transport-agnostic but live alongside for
cohesion.

## Test Groups

### Group AS: Auto-Sync (Bidirectional `_doPush`) — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| AS1 | After `capture()` auto-push fires (debounce elapsed), a **remote-only** staging entry pulled from the remote blob is **merged locally** into the StagingStore. | Prove auto-push is bidirectional: remote changes must reach local without a manual "Sync Staging" tap. | The core behavior change. Without it, auto-sync is just the old push-only path. |
| AS2 | When `checkAndSync()` returns `reauthNeeded` (mismatched/expired cookie or missing MK), the auto-push **does not throw and does not surface an error status** — it degrades silently. | Graceful degradation during background sync. | A cookie conflict mid-onboarding must not crash or disrupt; the manual button still handles re-auth UX. |
| AS3 | With **no transport** configured, auto-push **no-ops safely** (does not throw, schedules no work). | Local-only safety. | D15 contract: offline/local-only mode must never throw or attempt network in the auto-push path. |
| AS4 | With a **valid matching cookie**, auto-push uses the **fast path** (pull remote hash index, push only when changed) rather than a full blob reconcile. | Efficiency of the common case. | Existing Tier-1 hash-index fast path must be exercised in the auto-sync context; a full pull+merge on every mutation would be wasteful. |

### Group AS+: Status-Stream Contract — 2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| AS5 | After a successful auto-sync, the sync-status stream emits `pendingPush` then `InSync`. | Status must still reflect a clean sync after the wrapper stops discarding the result. | `_doPush` currently sets `inSync` only on bool `true`; the wrapper must translate `SyncCheckResult.ready` into `SyncingStatus.inSync`, else the UI is stuck on `pendingPush`. |
| AS6 | When `checkAndSync()` returns `offline` (network failure), the auto-sync path emits an `error` status (does not silently swallow). | Real failures must surface visually. | Distinguishes genuine transport failure (→ error) from `reauthNeeded` (→ silent), so the status stream stays meaningful. |

> AS5/AS6 extend the original plan (AS1–AS4) to cover the status-stream mapping
> that the upgrade necessarily introduces, since `_doPush` trades its `bool` for a
> `SyncCheckResult`.

## Coverage Map

| Existing test | Guards (unchanged) |
|---|---|
| D2/D4/D6/D8/D10/D12 (overhaul_test) | mutation → `_schedulePush()` triggers → something pushes |
| A1–A6 (row_level_test) | `_pullRemoteBlob`, deobfuscation, 404, key-mismatch, network error |
| D1–D5 (row_level_test) | fast-path hash-index compare, fall-through to reconcile |
| G2/G5/G6 (row_level_test) | reauthNeeded / no-transport already exercised directly on `checkAndSync()` |

**New coverage added by AS1–AS6:** the auto-push debounce path must now exercise those
same sync branches — the mapping from `_doPush` → `checkAndSync` is the gap.

## Summary Report

- **Total assertions:** 6
- **By group:** Group AS = 4 (bidirectional behavior), Group AS+ = 2 (status contract)
- **Files to be created:** `test/data/sync/sync_service_row_level_test.dart` (extend with Group AS + AS+; no new file — append a new group)
- **Source files to modify (Phase 3):** `lib/data/sync/sync_service.dart` (`_doPush` + `_attemptPush` route through `checkAndSync`, derive `SyncingStatus` from `SyncCheckResult`)

## Key Coverage Areas
1. Auto-push must pull remote data down (bidirectional), not just push local up — AS1
2. Auto-sync must be silent/no-op on `reauthNeeded` (degrade gracefully) — AS2
3. Auto-sync local-only (`transport == null`) is safe — AS3
4. Valid-cookie fast path is preserved in the auto-sync context — AS4
5. Status stream reflects successful auto-sync (no stuck `pendingPush`) — AS5
6. Real network failures surface as `error` (distinct from silent reauth) — AS6
