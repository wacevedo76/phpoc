# B-04: Flutter — Wire Row-Level Sync — Test Exploration (Phase 1)

> **Plan:** `ROW_LEVEL_STAGING_SYNC_PLAN.md` §Phase A (web reference)
> **Reference:** `WEB_ROW_LEVEL_TESTS_PHASE1.md` (web test blueprint, 120 assertions)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

### What Exists (B-03)

```
StagingStore      ✅  SQLite row-per-activity CRUD
StagingHashIndex  ✅  Tier-1 compare() + computeHash()
MergeEngine       ✅  mergeEntries() — activity_id LWW
_pushStagingRows  ✅  Auto-push obfuscated blob to 'staging/blob'
Transport         ✅  HttpTransport with pull/push/delete
```

### What's Disconnected (B-04 Gap)

The sync gate still uses the old blob path:

```
checkAndSync()
  ├─ Cookie check         → _pushBlobOnly()                 ❌ old path
  └─ _reconcileAndClaim()
       ├─ _pullRemoteBlob  → staging/blobs/current.json     ❌ old path
       ├─ MergeEngine.mergeMaps()                           ❌ entry_id-based
       └─ _pushBlobOnly()  → staging/blobs/current.json     ❌ old path
```

Auto-push writes to `staging/blob` but sync gate reads from `staging/blobs/current.json` → cross-device sync is dead.

### Target Architecture

```
checkAndSync()
  ├─ Cookie check
  │   ├─ StagingHashIndex.compare() → identical? → READY    ★ Tier-1 fast path
  │   └─ _pushStagingRowsToRemote()                         ✅ already works
  └─ _reconcileAndClaim()
       ├─ _pullRemoteBlob  → staging/blob                   ★ new path
       ├─ MergeEngine.mergeEntries()                        ✅ already exists
       └─ _pushStagingRowsToRemote()                        ✅ already works
```

### What Needs Changing

| Component | Current | Target |
|-----------|---------|--------|
| `_pullRemoteBlob()` | `staging/blobs/current.json` | `staging/blob` |
| `_reconcileAndClaim()` merge | `mergeMaps()` (entry_id) | `mergeEntries()` (activity_id) |
| `_reconcileAndClaim()` store | `LocalCache` | `StagingStore` |
| `_pushBlobOnly()` | Old blob path | Retired; `_pushStagingRowsToRemote` covers it |
| `checkAndSync()` fast path | Cookie-only | `StagingHashIndex.compare()` |
| `StagingPaths` | Missing `staging/blob` | Add constant |
| Bootstrap | Not handled | Empty remote → push local |

## Test Groups

### Group A: Pull Phase — ~8 tests

Switch `_pullRemoteBlob` from `staging/blobs/current.json` → `staging/blob`, deobfuscate.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `_pullRemoteBlob()` GETs `staging/blob` instead of `staging/blobs/current.json` | Path migration | Core fix — sync gate must read from the same path auto-push writes to |
| A2 | Pulled blob is deobfuscated via `CryptoService.deobfuscateBlob()` | Obfuscation unwrap | Blob stored obfuscated; must be readable. Same crypto as `_pushStagingRowsToRemote` |
| A3 | Returns `[]` when remote returns 404 (no blob on server) | Empty remote handling | First sync / clean Worker — must not crash, must not treat as error |
| A4 | Returns `[]` when deobfuscation fails (wrong master key) | Key mismatch guard | Wrong MK must not corrupt local state — return empty as if no remote |
| A5 | Returns parsed entries list when blob is valid | Normal pull | Core success path — entries from remote must be usable by merge step |
| A6 | Network error during pull → returns `[]` (not throws) | Offline resilience | Must not crash `checkAndSync` or block UI on network failure |
| A7 | Pulled entries have expected row-level fields (activity_id, activity_status, activity, updated_at) | Row schema fidelity | Merge depends on these fields; missing fields break LWW comparison |
| A8 | Transport uses `staging/blob` path constant (not hardcoded string) | No magic strings | Must use `StagingPaths.remoteRowLevelBlob` for consistency across client |

### Group B: Merge Phase — ~10 tests

Wire `MergeEngine.mergeEntries()` into `_reconcileAndClaim()`, replacing `mergeMaps()`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `_reconcileAndClaim` calls `MergeEngine.mergeEntries()` instead of `mergeMaps()` | Merge switch | Activity_id LWW is the correct merge for row-level staging |
| B2 | Remote row with newer `updated_at` wins over local row with same `activity_id` | LWW: remote newer | Scenario S1/S3 — remote clock-ahead device wins |
| B3 | Local row with newer `updated_at` wins over remote row with same `activity_id` | LWW: local newer | Scenario S2/S3 — local clock-ahead device wins |
| B4 | Row exists on remote only (not in local) → added to local staging | Remote-only pull | Scenario S4 — new entry from other device |
| B5 | Row exists on local only, not committed → kept in staging | Local-only uncommitted | Scenario S6 — genuinely new activity, never pushed |
| B6 | Row exists on local only, `committed: true` → removed from local staging | Committed cleanup | Scenario S5 — entry committed on another device, clean up |
| B7 | Same `updated_at` on both sides, local wins (tie-break) | Deterministic tie-break | Must have a single deterministic rule — local wins matches existing `mergeEntries`|
| B8 | Merged result written to `StagingStore` via `putRow` (not `LocalCache.writeEntries`) | Store migration | Sync gate must read/write StagingStore for row-level consistency |
| B9 | Merge handles empty remote (0 rows) — all local rows preserved | Empty remote case | First-sync or all-committed remote must not delete local |
| B10 | Merge handles empty local (0 rows) — all remote rows added | Empty local case | New device pulling all staging for the first time |

### Group C: Push Phase — ~5 tests

`_pushStagingRowsToRemote` already works. Verify it's correctly called from sync gate.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `_reconcileAndClaim` calls `_pushStagingRowsToRemote` after merge (not `_pushBlobOnly`) | Push switch | Push must go to `staging/blob`, not old path |
| C2 | `_pushStagingRowsToRemote` pushes to `staging/blob` path | Path verification | Regression guard — ensure auto-push path is correct |
| C3 | `_pushBlobOnly` is no longer called from sync gate paths | Old path retirement | Prevents split-brain: must not write both old and new paths |
| C4 | Push includes `device_id` and `device_proof` in blob | Device identity | Remote needs device identity for cookie-less auth flow |
| C5 | Blob is obfuscated via `CryptoService.obfuscateBlob()` before push | Obfuscation guard | Must not leak plaintext staging to remote |

### Group D: Fast Path — StagingHashIndex — ~7 tests

Wire `StagingHashIndex.compare()` into `checkAndSync` for Tier-1 cookie optimization.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `checkAndSync` pulls remote hash index via `staging/hash_index.json` | Remote hash index fetch | Tier-1 needs remote index to compare against local |
| D2 | `StagingHashIndex.compare(local, remote)` returns `identical: true` when both match | Fast-path gate | No changes → skip full pull/merge, return READY immediately |
| D3 | `identical: false` → `checkAndSync` falls through to `_reconcileAndClaim` | Full sync trigger | Hash mismatch means entries changed — must run full sync |
| D4 | Remote hash index is null/404 → treated as empty (all local entries are `added`) | Bootstrap bootstrap | First push case — empty remote means push all local |
| D5 | Network error during hash index fetch → fall through to full sync (not READY) | Offline resilience | Can't verify fast-path without remote hash → assume changes exist |
| D6 | `StagingHashIndex.build(store)` returns sorted, deterministic array | Build determinism | Hash comparison requires identical sorting across devices |
| D7 | `StagingHashIndex.computeHash()` produces stable SHA-256 for same input | Hash stability | Same input across devices must produce same hash for cross-device comparison |

### Group E: Store Migration — ~6 tests

Replace `LocalCache` reads/writes with `StagingStore` in sync gate.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `_reconcileAndClaim` reads local rows from `StagingStore.getAllRows()` (not `LocalCache.readEntries()`) | Read migration | Sync gate must operate on row-level data for activity_id LWW |
| E2 | Merged rows written via `StagingStore.putRow()` (not `LocalCache.writeEntries()`) | Write migration | Merged results must persist to row store for consistency |
| E3 | Rows deleted via `StagingStore.deleteRow()` when committed remotely | Delete migration | Scenario S5 requires row deletion from staging store |
| E4 | `StagingStore` operations do not throw during sync gate (all errors caught) | Error resilience | Store errors must not crash `checkAndSync` |
| E5 | `_pushStagingRowsToRemote` reads from `StagingStore.getAllRows()` for blob building | Push consistency | Must push the same rows that were just merged into the store |
| E6 | `LocalCache` is no longer read or written during sync gate paths | Old store retirement | Prevents dual-write inconsistency with row-level store |

### Group F: Bootstrap — ~4 tests

Handle empty remote (first device, clean Worker).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `checkAndSync` with empty remote → pushes all local staging rows as initial blob | First-device bootstrap | New Worker has no data — local staging becomes authoritative |
| F2 | Bootstrap push uses `staging/blob` path | Path consistency | First push and subsequent pushes use same path |
| F3 | `checkAndSync` returns READY after successful bootstrap push | Gate return value | Caller must know sync succeeded so UI can proceed |
| F4 | Cookie is pushed after successful bootstrap (device identity established) | Cookie creation | Remote must know which device pushed for future fast-path cookie checks |

### Group G: Gate Preservation — ~6 tests

Existing auth, genesis, and cookie gates must still work.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `checkAndSync` returns `genesisMismatch` when genesis gate fails | Genesis gate preserved | Existing security check must survive refactor |
| G2 | `checkAndSync` returns `reauthNeeded` when no master key | Auth gate preserved | Must not attempt sync without credentials |
| G3 | `checkAndSync` returns `offline` when transport is unavailable | Offline gate preserved | Network failure must not block UI or crash |
| G4 | Cookie fast path still works — matching cookies → READY without merge | Cookie short-circuit | Existing Tier-0 optimization must survive |
| G5 | Cookie mismatch triggers full `_reconcileAndClaim` (row-level merge, not old blob) | Cookie-triggered sync | Cookie mismatch means another device may have written — must use new merge path |
| G6 | `checkAndSync` with no transport (local-only mode) returns READY immediately | Local-only mode | D15 guard: `transport == null` means no remote capabilities |

### Group H: Integration — ~8 tests

Full sync cycle with mock transport simulating cross-device flow.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Device A creates row → syncs → Device B syncs → B sees A's row | Cross-device pull | Core value prop: entries appear on other devices |
| H2 | Device A updates row (higher `updated_at`) → syncs → Device B syncs → B gets updated version | Cross-device update | LWW resolution must propagate newer state |
| H3 | Device A commits entry → syncs → Device B syncs → B's local row is deleted | Committed cleanup | Scenario S5 end-to-end: committed entries removed from staging |
| H4 | Both devices create different rows → both sync → both have all rows | Concurrent creation | No conflict on distinct activity_ids — merge is additive |
| H5 | Full sync cycle with 10 local + 10 remote rows → verify all rows present and correct | Scale test | Realistic staging size — must handle without data loss |
| H6 | Sync completes under 2 seconds for 20 rows (mock transport) | Performance baseline | Must not block UI during sync; sub-second for typical sizes |
| H7 | `checkAndSync` updates `_lastPushAt` after successful sync | Push timestamp | Debounce timer and UI status depend on accurate last-push tracking |
| H8 | Multiple rapid `checkAndSync` calls → only one active sync at a time | Re-entrancy guard | Sync gate must be idempotent / non-reentrant to avoid race conditions |

### Group I: StagingPaths — ~2 tests

Add `staging/blob` constant and verify related paths.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `StagingPaths.remoteRowLevelBlob` equals `'staging/blob'` | New constant | Single source of truth for the row-level blob path |
| I2 | Existing `remoteStagingHashIndex` (`staging/hash_index.json`) unchanged | Path stability | Tier-1 hash index path must not change — Worker already serves it |

## Summary

| Group | Area | Tests |
|-------|------|-------|
| A | Pull phase (`staging/blob` path) | 8 |
| B | Merge phase (`mergeEntries` wiring) | 10 |
| C | Push phase (verify existing) | 5 |
| D | Fast path (`StagingHashIndex`) | 7 |
| E | Store migration (`LocalCache` → `StagingStore`) | 6 |
| F | Bootstrap (empty remote) | 4 |
| G | Gate preservation (auth/genesis/cookie) | 6 |
| H | Integration (full sync cycle) | 8 |
| I | StagingPaths constants | 2 |
| **Total** | | **56** |

## Notes

- Tests go in `phpoc-flutter/test/data/sync/sync_service_test.dart` (existing, extend) and possible new files for `StagingHashIndex` testing
- Most assertions target `SyncService` behavior — mock transport to control remote state
- `MergeEngine.mergeEntries()` is already tested in existing test suite — B-phase tests verify it's wired correctly, not re-test merge logic
- `StagingHashIndex.compare()` has existing tests — D-phase tests verify it's wired into `checkAndSync`
- `StagingStore` has existing tests — E-phase tests verify the sync gate reads/writes through it
- The Worker's generic blob handlers already serve `staging/blob` transparently — no Worker changes needed for B-04
- Web counterpart: `WEB_ROW_LEVEL_TESTS_PHASE1.md` (120 assertions) — web has additional migration + RowSyncWorker groups not needed in Flutter
