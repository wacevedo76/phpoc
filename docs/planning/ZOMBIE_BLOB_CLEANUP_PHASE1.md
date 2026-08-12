# `_pushBlobOnly()` Zombie Cleanup — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` (CCS-1 deliverable)
> **Purpose:** Blueprint of all assertions needed before removing the legacy monolithic-blob code path (`_pushBlobOnly()` + `StagingPaths.remoteStagingBlob`).
> **Status:** 🔜 Phase 1 (test exploration) — **DECISION: Option A chosen (full legacy-LocalCache retirement), set 2026-08.** See §Decision + §Blocking Constraint.
> **Next Phase:** Phase 2 (RED) — ✅ DONE (`docs/planning/ZOMBIE_BLOB_CLEANUP_PHASE2.md` + `phpoc-flutter/test/data/sync/zombie_removal_test.dart`). **Next: Phase 3 (GREEN)** — delete legacy branches, make `stagingStore` required, migrate legacy tests.

## Background

The `SyncService` supports **two** staging backends behind a nullable `stagingStore`:

- **Row-level (new, production):** `stagingStore != null` → SQLite `StagingStore`, `_pushStagingRowsToRemote()` → `StagingPaths.remoteRowLevelBlob` (`staging/blob`).
- **Legacy (old, blob):** `stagingStore == null` → `LocalCache` JSON-array blob, `_pushBlobOnly()` → `StagingPaths.remoteStagingBlob` (`staging/blobs/current.json`).

The plan/Backlog/SESSION_HANDOFF label `_pushBlobOnly()` + `remoteStagingBlob` an "old-path zombie" and ask to remove it *"after legacy path cleanup."*

## Blocking Constraint (discovered in Phase 1)

**`_pushBlobOnly()` is inseparable from the live legacy `LocalCache` fallback.** Its three call sites are all inside `stagingStore == null` branches:

| Call site | Method | Guard |
|-----------|--------|-------|
| `sync_service.dart:505` | `checkAndSync()` fast path | `else { await _pushBlobOnly(); }` when `stagingStore == null` |
| `sync_service.dart:618` | `_reconcileAndClaim()` | legacy reconcile branch |
| `sync_service.dart:793` + `:796` | `pushToRemote()` | `if (stagingStore != null) … else { _pushBlobOnly(); …readHashIndex() }` |

It is also reached via `_pullRemoteBlob()` (`:549`) which reads `remoteStagingBlob` when `stagingStore == null`.

**Production always provides `stagingStore`** (`lib/data/storage/providers.dart:81` passes `syncing: stagingStore: StagingStore(db)`), so the zombie is *unreachable in production* — as the plan states. **But it is actively exercised by the legacy test suite:**

| Test file | Dependency on legacy path |
|-----------|--------------------------|
| `sync_service_test.dart` | **8+ passing assertions** directly assert `_pushBlobOnly` → `remoteStagingBlob`: lines 917, 947 (push paths), M1 (`:1102`), M2 (`:1132`), M10 (`:1379`), Q1 (`:1736`), Q2 (`:1752`). Baseline **99 pass / 6 fail** (6 = pre-existing K3/K7/M5/M10/N3/N18). |
| `restore_integration_test.dart` | **No stagingStore** (uses legacy blob); seeds `staging/blobs/current.json` directly. |
| `restore_pull_test.dart` | No stagingStore. |
| `sync_integration_test.dart` | No stagingStore. |
| `legacy_compat_test.dart` | Charters the legacy path by name. |
| Feature/screen tests (`history_screen_test`, `onboarding_screen_test`, `sync_screen_test`, `encrypted_entry_display_test`, `test_helpers.dart`) | Construct `SyncService` without `stagingStore`. |
| `test/debug_sync.dart` | No stagingStore. |

**If `_pushBlobOnly()` / `remoteStagingBlob` are removed now, they break ~99 passing tests** in `sync_service_test.dart` alone, plus the entire legacy integration/feature suites. The SESSION_HANDOFF gate — *"Remove after legacy path cleanup"* — has **not** been met.

## Consequence

There is **no self-contained slice** that removes the zombie while keeping the legacy suite GREEN. The removal is the **final step** of a legacy-path retirement that must come first:

1. Make `stagingStore` **non-nullable / required** in `SyncService` (breaks ~132 test constructions across 20+ files; 9+ files never pass `stagingStore`).
2. Delete the legacy `LocalCache`-based branches in `sync_service.dart` (`_local.readEntries/writeEntries/append/update/delete/markCommitted/readHashIndex`, `_buildBlobBytes`, `endByEntryId`/`pauseByEntryId`/`unpauseByEntryId` `stagingStore==null` halves, legacy `commitEntries()`, `_pullRemoteBlob` legacy branch).
3. Migrate the legacy test files to construct `SyncService` with a real `StagingStore`, then remove the legacy assertions (M1/M2/Q1/Q2/blob-path checks).

This is a **multi-file, high-risk refactor** — not the "~1 hour, 🟡 Low" cleanup the plan anticipated.

## Decision (2026-08)

**Option A — Full legacy-LocalCache retirement via 4-phase TDD.** Chosen by the user as the direction for this work package. See the options comparison below for what was considered.

### Option A — Scope (the committed direction)
1. Make `stagingStore` **required / non-null** in `SyncService` (forced at type level — fallback impossible).
2. Delete all `stagingStore == null` (legacy `LocalCache` blob) branches in `sync_service.dart`: `_pushBlobOnly`, `_buildBlobBytes`, the `remoteStagingBlob` paths in `_pullRemoteBlob`/`checkAndSync`/`_reconcileAndClaim`/`pushToRemote`, `_local.readHashIndex`, `endByEntryId`/`pauseByEntryId`/`unpauseByEntryId` legacy halves, legacy `commitEntries()`, and the Legacy-backcompat doc header.
3. Migrate legacy test files to construct `SyncService` with a real `StagingStore`: `sync_service_test.dart`, `restore_integration_test.dart`, `restore_pull_test.dart`, `sync_integration_test.dart`, `legacy_compat_test.dart`, feature/screen tests via `test_helpers.dart`, `debug_sync.dart` (~132 constructions across 20+ files, 9+ of which currently pass no `stagingStore`).
4. Remove the legacy blob assertions (M1/M2/Q1/Q2, `remoteStagingBlob` push/pull path assertions).

### Options considered

| Option | Scope | Risk | Verdict |
|--------|-------|------|---------|
| **A. Full legacy retirement via 4-phase TDD** | Make `stagingStore` required; delete all `LocalCache` blob branches + `_pushBlobOnly` + `remoteStagingBlob`; migrate legacy tests to row-level; remove blob assertions. | High (touches every mutation, ~20 files) | **CHOSEN.** Matches the eventual goal; a dedicated epic. |
| **B. Production-reachability hardening (no removal)** | Keep legacy branch for tests; ensure production never constructs it. Adds RED tests that `stagingStore` is always provided at the app layer. Removes *reachability*, not the code. | Low | Rejected — does not delete the zombie. |
| **C. Hold / descope** | Treat the zombie as COLD tech-debt; track legacy retirement as a separate backlog epic. | None | Rejected — user wants the code removed now. |

## Recommendation

Given **Option A** is chosen, the ordering in Phase 2 matters: **migrate the legacy tests to row-level first** (keeping the suite GREEN during migration), **then** add RED tests asserting the legacy branch/Z1–Z10 is gone, so the failing tests always fail for the intended reason (legacy code removed), not for an unrelated test-fixture break.

## Test Groups (concrete — implemented as RED tests in Phase 2)

> Assertions below are written against the *row-level-only* end-state. In **Phase 2** they were turned into runnable RED tests in
> `phpoc-flutter/test/data/sync/zombie_removal_test.dart` using a two-pronged strategy:
> **Z1–Z9** use **source-probe** assertions (read `sync_service.dart` + the legacy test files and assert the legacy symbols are gone) so the "code is deleted" checks are runnable and RED now; **Z10** is a **behavioral** end-state guard confirming a row-level `SyncService` never touches `remoteStagingBlob`.
> Phase 2 result: **Z1–Z9 RED, Z10 GREEN.** All of Z1–Z9 flip GREEN in Phase 3 when the legacy path is deleted.

### Group Z: Zombie Removal (post-legacy-retirement) — proposed
| ID | Assertion | Purpose |
|----|-----------|---------|
| Z1 | `SyncService` constructor requires a non-null `stagingStore` | Enforced type — fallback impossible |
| Z2 | `_pushBlobOnly()` no longer exists (no `remoteStagingBlob` pushes) | Blob path fully retired |
| Z3 | `checkAndSync()` fast path always calls `_fastPathRowLevel()` | No blob fallback branch |
| Z4 | `_reconcileAndClaim()` always uses row-level reconcile | No LocalCache reconcile |
| Z5 | `pushToRemote()` always pushes row-level + hash index | No blob push / legacy readHashIndex |
| Z6 | `_pullRemoteBlob()` always reads `remoteRowLevelBlob` | No legacy blob pull |
| Z7 | All mutations (`capture`/`end`/`pause`/`unpause`/`modify`/`remove`) use `stagingStore` only | Legacy LocalCache branches deleted |
| Z8 | Legacy test files re-factored to construct with real `StagingStore` | Suite migrates to row-level |
| Z9 | Legacy blob assertions (M1/M2/Q1/Q2, blob-path checks) removed | Dead assertions deleted |
| Z10 | Full sync suite has **zero net new failures** vs pre-retirement baseline | No regression from migration |

## Summary Report

- **Total assertions:** 10 (Z1–Z10), implemented as runnable RED tests in `phpoc-flutter/test/data/sync/zombie_removal_test.dart` (Phase 2). Status: **Z1–Z9 RED, Z10 GREEN guard.**
- **Blocked by (for the code deletion in Phase 3):** ~99 GREEN tests in `sync_service_test.dart` + legacy integration/feature suites directly asserting the zombie path — these must be migrated to row-level `StagingStore` first.
- **Files to create/modify (Option A):** `sync_service.dart` (required `stagingStore`, delete legacy branches), ~20 test files migrate to row-level.
- **Genuinely removable now:** nothing — the zombie is inseparable from the live legacy fallback.

## Key Coverage Areas
1. `_pushBlobOnly()` is exclusively a `stagingStore == null` (legacy) path — cannot be removed in isolation.
2. Production is already safe (always provides `stagingStore`) — the "zombie" is only reachable in tests.
3. Self-contained removal breaks ~99 passing legacy asserts + full legacy suites.
4. Correct order is **legacy retirement first**, then zombie removal.
