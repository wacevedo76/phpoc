# `_pushBlobOnly()` Zombie Cleanup — RED (Phase 2)

> **Plan:** `docs/planning/ZOMBIE_BLOB_CLEANUP_PHASE1.md`
> **Purpose:** Write runnable failing tests for the Z1–Z10 group (zombie removal end-state).
> **Status:** ✅ Phase 2 (RED) complete
> **Next Phase:** Phase 3 (GREEN) — ✅ DONE (`docs/planning/ZOMBIE_BLOB_CLEANUP_PHASE3.md`). Z1–Z10 all GREEN.

## Approach: source-probe + behavioral end-state

Per the Phase 1 blueprint ordering, the Z-group assertions target the
*row-level-only end-state*. They are genuinely RED today because the live
legacy `LocalCache` fallback is still present in `sync_service.dart` (nullable
`stagingStore`, `_pushBlobOnly`, `remoteStagingBlob` paths, `commitEntries`,
`_local.*` read branches).

Because most Z assertions express "the legacy code is gone," they could not be
written purely as behavioral tests (those need the code already deleted). So the
test file uses a **two-pronged strategy**:

- **Z1–Z9 — source-probe.** `dart:io` reads `lib/data/sync/sync_service.dart`
  (and, for Z8/Z9, the legacy test files via `Directory.current`) and asserts
  the legacy symbols are absent. This makes the "code is deleted" assertions
  runnable and RED now.
- **Z10 — behavioral end-state guard.** Constructs a row-level `SyncService`
  (real `StagingStore`) with a transport spy and asserts the legacy monolithic
  blob path (`staging/blobs/current.json`) is never touched — while the
  legitimate device-cookie path is retained.

## Result

| ID | Assertion | Status (Phase 2) |
|----|-----------|------------------|
| Z1 | `stagingStore` required (no `StagingStore?`) | 🔴 RED |
| Z2 | `_pushBlobOnly()` absent from source | 🔴 RED |
| Z3 | `checkAndSync()` fast path → row-level only (no `_pushBlobOnly`) | 🔴 RED |
| Z4 | `_reconcileAndClaim()` row-level only (no `mergeMaps`) | 🔴 RED |
| Z5 | `pushToRemote()` row-level + hash index (no blob push / `readHashIndex`) | 🔴 RED |
| Z6 | `_pullRemoteBlob()` reads `remoteRowLevelBlob` only (no `remoteStagingBlob`) | 🔴 RED |
| Z7 | All mutations / by-entry-id variants use `stagingStore` only | 🔴 RED |
| Z8 | Legacy test files construct `SyncService` with real `StagingStore` | 🔴 RED |
| Z9 | Legacy blob assertions (M1/M2/Q1/Q2) removed | 🔴 RED |
| Z10 | Behavioral: no row-level op touches `staging/blobs/current.json` | 🟢 GREEN (guard) |

**Net: 9 RED, 1 GREEN guard.** Confirmed via `flutter test test/data/sync/zombie_removal_test.dart` → `+1 -9`.

## Notes for Phase 3 (GREEN)

- Z1–Z9 flip GREEN when `sync_service.dart` drops the nullable `stagingStore`,
  deletes `_pushBlobOnly`/`_buildBlobBytes`/`commitEntries`/legacy `_local.*`
  branches, and the legacy test files are migrated to a real `StagingStore`.
- Z8 is the **large prerequisite**: ~132 `SyncService(` constructions across
  ~12 legacy/feature test files must pass `stagingStore:` before Z8 (and Z9,
  which removes legacy blob assertions) can go green. Do the migration *first*
  (keeping the suite GREEN), then delete the legacy branches — per the blueprint
  ordering.
- Z10 is a regression guard and should stay GREEN throughout Phase 3.

## Files

| File | Role |
|------|------|
| `phpoc-flutter/test/data/sync/zombie_removal_test.dart` | Z1–Z10 RED tests (new) |

## Run

```bash
cd phpoc-flutter
flutter test test/data/sync/zombie_removal_test.dart
#   Expected: +1 -9  (Z1–Z9 RED, Z10 GREEN guard)
```
