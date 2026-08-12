# `_pushBlobOnly()` Zombie Cleanup — GREEN (Phase 3)

> **Plan:** `docs/planning/ZOMBIE_BLOB_CLEANUP_PHASE1.md` (Option A — full legacy-LocalCache retirement)
> **Purpose:** Delete the legacy monolithic-blob (`LocalCache`) branches, make `stagingStore` required, migrate all test files to a real `StagingStore`, and flip Z1–Z9 GREEN.
> **Status:** ✅ Phase 3 (GREEN) complete; Phase 4 (REFACTOR) ✅ COMPLETE
> **Next Phase:** none — task complete.

## Outcome

**All 10 Z assertions GREEN** (Z1–Z10) in `phpoc-flutter/test/data/sync/zombie_removal_test.dart`:

| ID | Assertion | Status (Phase 3) |
|----|-----------|------------------|
| Z1 | `stagingStore` required (non-nullable) | 🟢 GREEN |
| Z2 | `_pushBlobOnly()` absent | 🟢 GREEN |
| Z3 | `checkAndSync()` fast path → row-level only | 🟢 GREEN |
| Z4 | `_reconcileAndClaim()` row-level only | 🟢 GREEN |
| Z5 | `pushToRemote()` row-level + hash index | 🟢 GREEN |
| Z6 | `_pullRemoteBlob()` reads `remoteRowLevelBlob` only | 🟢 GREEN |
| Z7 | All mutations use `stagingStore` only | 🟢 GREEN |
| Z8 | All test files construct with real `StagingStore` | 🟢 GREEN |
| Z9 | Legacy blob assertions removed | 🟢 GREEN |
| Z10 | Behavioral: no row-level op touches legacy blob | 🟢 GREEN (guard) |

## Source Changes — `lib/data/sync/sync_service.dart`

- Made `stagingStore` a **required, non-null `final` field** (removed the `StagingStore?` nullable field + `_local` LocalCache field).
- Removed the constructor's `_local = LocalCache(...)` initializer.
- **Deleted** the legacy branches:
  - `_pushBlobOnly()`, `_buildBlobBytes()` (monolithic `remoteStagingBlob` push).
  - Legacy `readEntries()`/`getActive()`/`getEntries()`/`getCompleted()` `_local.*` fallbacks.
  - `_reconcileAndClaim()` legacy `LocalCache + mergeMaps()` path.
  - `_findActiveEntryIndex`/`_findActiveEntryIndexById` (title/index legacy lookup).
  - `endByEntryId`/`pauseByEntryId`/`unpauseByEntryId` legacy bodies (now thin delegates).
  - Legacy `commitEntries()` delete-after-commit + stale-cleanup body → now delegates to `commitAndSync()`.
- Simplified `checkAndSync()` fast path to always call `_fastPathRowLevel()`.
- `_pullRemoteBlob()` now always reads `StagingPaths.remoteRowLevelBlob`.
- **Preserved backward-compat `_resolveRowByTitle()`** so the public `end()`/`pause()`/`unpause()`/`modify()` still resolve a legacy title argument to a row (keeps the legacy API contract; `S8` still passes).
- Kept `LocalCache.computeDuration` (pure static util) and `MergeEngine.mergeEntries` (row-level).

## Test Migration (~132 constructions across 12 files)

All `SyncService(`/`_SpySyncService(` constructions in the Z8-affected files now pass a real `StagingStore`:
- `sync_service_test.dart` (migrated + blob assertions → `remoteRowLevelBlob`; N-group commit assertions → row-level retention).
- `sync_integration_test.dart`, `restore_integration_test.dart`, `restore_pull_test.dart`.
- `legacy_compat_test.dart` (already row-level).
- `history_screen_test.dart`, `sync_screen_test.dart`, `sync_screen_overhaul_test.dart`, `encrypted_entry_display_test.dart`, `onboarding_screen_test.dart`.
- `test_helpers.dart`, `debug_sync.dart`.
- Also: `onboarding_service_test.dart`, `restore_from_cloud_test.dart`, `providers_test.dart`, `ledger_pull_service_test.dart` (beyond the Z8 list, needed for `stagingStore` required to compile).

**Also fixed in passing (pre-existing compile breaks masked by the AuthService/LedgerPullService `securePreferences`/`stagingStore` required changes):** `providers_test.dart` (now all-pass), `restore_from_cloud_test.dart` (now compiles/runs), `debug_sync.dart`.

## Result

| Suite | Pre-session | Post-Phase 3 |
|-------|-------------|--------------|
| zombie_removal_test | Z1–Z9 RED, Z10 GREEN | **Z1–Z10 all GREEN** |
| sync_service_test | 99 pass / 6 fail | **101 pass / 4 fail** (K3/K7/M5/M10 pre-existing) |
| sync data dir | +400 -19 | **+402 -17** |
| data/ledger | 279 GREEN | **279 GREEN** |
| onboarding_service_test | 61/61 | **All pass** (incl. L2/L5 → row-level StagingStore) |
| ledger_pull_service_test | 27 pass / 7 fail | **29 pass / 5 fail** |
| providers_test | non-compiling | **All pass** |
| restore_from_cloud_test | non-compiling | **20 pass / 5 fail** |

## Phase 4 (REFACTOR) — COMPLETE

Behavior-preserving cleanup of the cleaned `sync_service.dart`. Verified no regression via a stash control experiment (pre-P4 state produced the identical pre-existing/flaky failure set).

| # | Category | Improvement | Files |
|---|----------|-------------|-------|
| 1 | Clarity | Removed duplicated `Debounced auto-push` section header (block appeared twice consecutively) | `sync_service.dart` |
| 2 | Clarity | Fixed over-indentation in `end()`/`pause()`/`unpause()` bodies | `sync_service.dart` |
| 3 | Modularity | Moved the orphaned `LocalCache.computeDuration` static → `FormatUtils.computeDurationMsec` (removed `sync_service.dart`'s only dependency on the retired `LocalCache` class); B12 tests relocated & re-pointed | `local_cache.dart`, `format_utils.dart`, `local_cache_test.dart` |
| 4 | Modularity/Conciseness | Collapsed the thin `_reconcileAndClaim()` wrapper into `_reconcileAndClaimRowLevel()` (moved the null-transport guard inside); 2 call sites updated | `sync_service.dart` |

**Result:** analyzer clean on changed files; suites GREEN — `zombie_removal` 10/10, `local_cache` 36/36, `sync_service_row_level` 60/60, `sync_integration` + `restore_pull` GREEN. `sync_service_test` only the documented pre-existing K3/K7/M5/M10 + inherent timing-flaky E15/L4 (identical pre-refactor per control run). No regressions.

## Notes for Phase 4 (REFACTOR) — [DONE, see above]

- Review the cleaned `sync_service.dart` for further modularity (e.g. extract reconcile/push orchestration).
- Confirm `LocalCache` is only used for `computeDuration` (pure util) — consider moving it out of the legacy class.
- `_SpySyncService` / `_CookieSpyTransport` `hashIndexBytes` field additions are minor; verify no dead code.
