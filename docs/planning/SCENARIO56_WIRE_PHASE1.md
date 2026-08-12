# Scenario-5/6 Ledger-Aware Staging Cleanup — Wire into Handoff Reconcile (Phase 1)

> **Plan:** `docs/planning/LEDGER_AUTO_PULL_ON_REAUTH_PLAN.md` (ADR-030, Group L3) +
> `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (Scenario 5/6 LWW table)
> **ADR:** `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-030 (decision #3)
> **Purpose:** Blueprint of all needed test assertions for wiring `MergeEngine.dropLedgerCommitted`
> (the ADR-030 Scenario-5/6 filter) into the ownership-handoff reconcile so a fresh device drops
> stale scaffolding rows that are already sealed in the local ledger instead of re-pushing them.
> **Status:** ✅ ALL PHASES COMPLETE — 21/21 tests pass (Phase 1 + Phase 2 RED + **Phase 3 GREEN** + **Phase 4 REFACTOR done**).
> **Tracked:** `docs/planning/BACKLOG.md` (✅ complete); `SESSION_HANDOFF.md` Immediate Next Steps.

## Context: the gap

ADR-030 Phase 3 added `MergeEngine.dropLedgerCommitted(local, ledgerActivityIds)` and the L3.1/L3.2
unit tests, but **never invoked it** from `SyncService`. A device that re-authenticates on a handoff
runs:

```
checkAndSync() fresh-claim branch
  → _reconcileLedgerOnHandoff()   // pull ledger first (block-count gated); seeds committed rows
  → _reconcileAndClaimRowLevel()  // pull remote staging, mergeEntries LWW, write, push
```

Today `_reconcileAndClaimRowLevel()` does **not** consult the local ledger. So a local scratchpad row
whose `activity_id` was already sealed into the ledger on another device survives the merge and gets
**re-pushed to remote as scratchpad** (Scenario 5 violation). The fix realises ADR-030 decision #3:
"pull+verify the ledger first, then reconcile staging using the local ledger **hash index** to delete
committed-in-ledger rows."

### Architectural finding (validated in Phase 1, 2026-08-11)

The reference's word "ledger hash index" is shorthand for "the set of `activity_id`s sealed in the
ledger." A scratch probe through the real `commitAndSync()` path confirmed:

- A committed day-block entry's `data` **retains `activity_id`** (`{title, duration, activity_id,
  startTime_enc, endTime_enc, metadata_enc, pauses_enc, content_hash}`).
- `entry_id`, `is_active`, `device_uuid`, `hash`, `start_epoch`/`end_epoch`, `metadata`, `pauses`
  are **stripped** before sealing (`_prepareEntries`, `buildDayBlock`).
- `LedgerEngine.getAllBlocks()` → iterate day-type blocks → collect non-empty `entry['data']['activity_id']`
  yields the exact committed `activity_id` set.

Therefore `ledgerActivityIds` is derivable from `getAllBlocks()` without changing the PHPSPEC block
format. **No block-format change is required.**

### Semantic decision required (resolved in Phase 1)

`dropLedgerCommitted` currently drops **any** row whose id is in the ledger, regardless of the row's
`committed` flag. That would wrongly delete the **committed display rows** (`committed: true`) that
`_reconcileLedgerOnHandoff()` seeds from pulled blocks for History/Dashboard, emptying History after
a handoff. The reference LWW table distinguishes:

| Conflict | Rule |
|----------|------|
| Entry only in local, **IS** in ledger index | Delete from local (Scenario 5) |
| Committed flag set | Remove from merged set (Scenario 8) |

**Decision:** the wired cleanup targets **uncommitted local-only rows whose `activity_id` is sealed**
(**Scenario 5**), leaving committed-flagged rows untouched for display. Concretely, apply
`dropLedgerCommitted` to the **uncommitted** subset of the merged rows before the remote push
(caller filters `!_rowIsCommitted(r)` first). Rows that are committed-flagged are excluded from the
drop and remain seeded/displayed; R4 still filters them from the push. This keeps `dropLedgerCommitted`
a pure id-set filter and moves the committed-flag guard into the caller — matching the L3 unit tests
(which already use `committed: false` rows in both L3.1 and L3.2).

## Architecture Overview

```
checkAndSync() fresh-claim branch
  → _reconcileLedgerOnHandoff()          [EXISTING] pull ledger; seeds committed rows
  → _reconcileAndClaimRowLevel()         [MODIFY]
        pull remote blob → localRows
        mergeEntries(local, remote) → merged            (LWW, committed-preserving)
        │
        ▼ NEW: ledger-aware Scenario-5/6 cleanup
        ledgerIds = _ledgerActivityIds()                (from LedgerEngine.getAllBlocks())
        merged     = drop to uncommitted rows whose id ∈ ledgerIds
        │
        write merged → push (R4 filters committed) → push cookie
```

New helper on the engine/convenience accessor (Phase 3 decision):
- `LedgerEngine.ledgerActivityIds()` (or a `SyncService` private that iterates `getAllBlocks()`),
  returning `Set<String>` of sealed `activity_id`s. Implementation detail chosen in Phase 3; the tests
  assert the observable behavior.

## Test Groups

All new tests live in `test/data/sync/ledger_auto_pull_on_reauth_test.dart` (the ADR-030 harness —
`_Harness` wires a real `SyncService` + `LedgerEngine` + real `StagingStore` over a `_ConfigTransport`
that serves/records pull/push paths, and `_Harness.addRow` writes a row whose `activity_id` is the
row key). Extend that harness with a `LocalBlock` seeding helper so tests can pre-seal an
`activity_id` into the local ledger without a remote pull.

### Group L3W: Scenario-5/6 wiring in the handoff reconcile — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L3W.1 | Uncommitted local-only row whose `activity_id` is sealed in the local ledger is **deleted** from staging after `checkAndSync()` (fresh claim, ledger pulled) and is **not** present in the remote push blob. | The core wiring: Scenario-5 stale scaffold dropped. | Proves the filter is actually invoked in the reconcile, not just unit-tested. |
| L3W.2 | Uncommitted local-only row whose `activity_id` is **NOT** in the ledger survives the reconcile and is **pushed** to remote. | Scenario-6: new uncommitted scratchpad must not be dropped. | Guards against over-deletion; the ledger must never discard genuine new activity. |
| L3W.3 | A **committed-flagged** row (seeded by `_reconcileLedgerOnHandoff` / `committed: true`) with `activity_id` in the ledger is **preserved** in local staging for History/Dashboard (not deleted by the cleanup). | Never empty History after a handoff. | Validates the semantic decision to only drop *uncommitted* sealed rows. |
| L3W.4 | When the local ledger is **empty** (no blocks), the handoff reconcile behaves exactly as today (no rows dropped, push unchanged). | Fail-safe / backward compat with a fresh ledger. | The cleanup must be a strict no-op when there is nothing sealed, so no behavioral regressions on a new device. |

### Group L3X: `ledgerActivityIds` derivation — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L3X.1 | `getAllBlocks()` day-block entries expose `data['activity_id']`; the engine accessor returns exactly that set. | Correct derivation of the ledger id-set. | Guards the identity mapping that makes the whole wiring meaningful. |
| L3X.2 | Definition blocks (genesis / summary) that carry no entries contribute **nothing** to the id-set. | Only day entries seal activity. | Prevents phantom ids from summary/genesis blocks. |
| L3X.3 | Non-`day` block types and malformed/missing `activity_id` entries are skipped safely (no throw). | Defensive derivation. | `getAllBlocks` may surface foreign/legacy blocks; the accessor must be robust. |

### Group L3Y: unit regression / extension of `dropLedgerCommitted` — 2 tests

Preserve the existing L3.1/L3.2 contract and add the committed-guard boundary the wiring relies on.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L3Y.1 | `dropLedgerCommitted` with an empty `ledgerActivityIds` returns the input unchanged (existing L3 guard). | No-op when no ledger. | Already covered by L3 tests; explicit here to lock the caller's safety. |
| L3Y.2 | When a `committed: true` row and an uncommitted row share an `activity_id` in the ledger id-set, the caller's `!_rowIsCommitted` filter excludes the committed one so only the uncommitted row is candidates for drop. | The committed-flag guard. | Locks the exact filter boundary the wiring uses, so a regression in `_rowIsCommitted` cannot silently delete display rows. |

## Test Location Decision

Same file as the existing ADR-030 tests (`test/data/sync/ledger_auto_pull_on_reauth_test.dart`), because
the `_Harness` already wires the real `SyncService` + real `LedgerEngine` + real `StagingStore` +
`_ConfigTransport` (records push/pull, serves hash_index) — everything `L3W` needs. `L3X`/`L3Y` need
only the engine + `MergeEngine`, but live here for cohesion with the L1–L4 group. No new file.

**Progress hook needed:** extend `_ConfigTransport`/`_Harness` with a way to seed day blocks into the
local ledger (e.g. `_Harness.seedLedgerActivityIds(Set<String>)` calling a real `engine.commit` with
the given `activity_id`s, or a direct block append). Phase 2 defines this helper alongside the RED tests.

## Summary Report (Phase 1)

- **Total assertions:** 9
- **By group:** Group L3W = 4 (wiring in handoff reconcile); Group L3X = 3 (`ledgerActivityIds`
  derivation); Group L3Y = 2 (`dropLedgerCommitted`/committed-guard regression)
- **Files to be created:** none (extend `test/data/sync/ledger_auto_pull_on_reauth_test.dart`)
- **Source files to modify (Phase 3):**
  - `lib/data/sync/sync_service.dart` — `_reconcileAndClaimRowLevel()`: build `ledgerActivityIds` from
    the ledger, apply `dropLedgerCommitted` to the **uncommitted** merged subset before push.
  - `lib/data/ledger/engine.dart` — add a `ledgerActivityIds()` accessor (iterate `getAllBlocks()`,
    collect day-entry `data['activity_id']`).
  - `lib/data/sync/merge_engine.dart` — unchanged (filter stays pure); doc note may be refreshed.
- **Key coverage areas:**
  1. Scenario-5 stale scaffolding dropped on a handoff (L3W.1)
  2. Scenario-6 new activity preserved (L3W.2)
  3. Committed display rows preserved post-handoff (L3W.3)
  4. Empty-ledger fail-safe (L3W.4)
  5. Correct, robust `activity_id` derivation from blocks (L3X)
  6. Committed-flag guard boundary (L3Y)
