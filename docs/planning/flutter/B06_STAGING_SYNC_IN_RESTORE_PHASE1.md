# B-06: Wire Staging Sync into restoreFromCloud — Test Exploration (Phase 1)

> **Plan:** SESSION_HANDOFF.md §Immediate Next Steps — B-06
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ 4-Phase TDD Complete (2026-07-31)
> **Next Phase:** Phase 4 (REFACTOR — code review)

## Architecture Overview

### The Gap

`restoreFromCloud()` currently:
1. Builds genesis locally ✓
2. Creates device identity ✓
3. Connects Worker ✓
4. Pulls ledger blocks via `ledgerPullService.pullAll()` ✓
5. **Pulls staging entries via `syncService.initialPull()` ✗ — NEVER CALLED**

The result: ledger blocks come down from R2, but staging entries (`staging/blob`) from other devices never appear. Running/ended activities are invisible after a cloud restore.

### The Fix (1 line)

```dart
// In restoreFromCloud(), after ledger pull succeeds:
await syncService.initialPull();
```

`initialPull()` → `_reconcileAndClaim()` → pulls remote staging blob → deobfuscates → merges into local staging. The existing `MergeEngine` + `StagingStore` infrastructure already handles everything — just needs to be called.

### What Already Exists

| Component | Status | Notes |
|-----------|--------|-------|
| `syncService.initialPull()` | ✅ Implemented | `_reconcileAndClaim()` wired, tested in B-04 |
| `MergeEngine.mergeEntries()` | ✅ Implemented | Dedup + conflict resolution, 54 GREEN tests |
| `StagingStore` | ✅ Implemented | Row-level staging, hash index |
| `ledgerPullService.pullAll()` | ✅ Implemented | Pulls ledger blocks from R2 |
| `_buildAndPersistGenesis()` | ✅ Implemented | Called at step 6, before network ops |

### Key Constraints

1. **Call ordering:** `initialPull()` must happen AFTER `ledgerPullService.pullAll()` succeeds — both need Worker connection already established
2. **Empty remote:** If remote has no staging blob (first device), `initialPull()` returns empty — no-op, not an error
3. **Network failure:** If `initialPull()` fails, genesis + identity are already persisted — restore must still succeed (degraded)
4. **MK required:** `initialPull()` needs MK cached (already done at step 5 before genesis)
5. **Transport required:** `initialPull()` → `_reconcileAndClaim()` checks `transport != null` — no transport = no-op
6. **Hash-index fast path:** Second restore with same data should skip redundant pull via hash index comparison

## Test Groups

### Group A-ext: restoreFromCloud staging sync — ~5 tests (in `restore_from_cloud_test.dart`)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A5 | restoreFromCloud with mock transport returning staging blob → entries appear in syncService.getEntries() | **Existing test to un-RED.** Core contract: staging entries are pulled during restore | This was the original Phase 1 assertion that was never properly implemented — mock transport needed |
| A11 | restoreFromCloud calls syncService.initialPull() exactly once after ledger pull succeeds | Method call verification | Ensures staging sync is wired and called exactly once, not skipped or doubled |
| A12 | restoreFromCloud with network failure during initialPull → still returns success, genesis + identity preserved | Degraded restore resilience | Network failure after genesis is built must not crash or lose identity |
| A13 | restoreFromCloud with deobfuscation failure from remote (corrupted staging/blob) → entries skipped, identity preserved | Corruption resilience | Crypto failure on staging must be isolated — don't lose local state |
| A14 | restoreFromCloud with empty remote → initialPull returns empty, staging stays empty, restore succeeds | First-device cloud setup | No staging blob on remote is normal for first device — not an error |
| A15 | restoreFromCloud then second restore (wipeExisting) → staging entries from both remote blobs land correctly | Idempotent restore | Ensures staging sync works on repeated restores, not just first time |

### Group G-ext: Integration — cross-device staging + hash index — ~4 tests (in `restore_integration_test.dart`)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | Device A captures + pushes → Device B restores → Device B sees Device A's entries | **Existing test to un-RED.** Cross-device flow | The primary use case: entries from other devices must appear after cloud restore |
| G4 | Post-restore capture → entry visible locally AND pushable to Worker | **Existing test to un-RED.** Post-restore sync | After restore, user must be able to capture and push new entries |
| G5 | Device A pushes staging → Device B restores → Device B's staged entries include Device A's title, tags, start_epoch | Fidelity check | Specific fields survive cross-device staging roundtrip |
| G6 | Restore → staging populated → second restore with same data → hash index fast path used (no redundant merge) | Hash-index efficiency | Second restore should detect same data via hash index and skip merge |

### Existing RED Tests to Fix (G3, G8) — 2 tests

| ID | Issue | Fix |
|----|-------|-----|
| G3 | Asserts `blocks, isEmpty` after restore with Worker down | Code creates genesis before pull → blocks is NOT empty. Fix assertion to expect genesis present. |
| G8 | Asserts `blocks, isEmpty` after 401 from Worker | Same as G3 — genesis created before network ops. Fix assertion. |

## Summary

| Group | Focus | Tests | Key dependency |
|-------|-------|-------|---------------|
| **A-ext** | restoreFromCloud staging sync | 6 (A5 + A11–A15) | Mock transport with staging blob |
| **G-ext** | Integration cross-device + hash index | 4 (G1, G4–G6) | Shared mock transport between two SyncService instances |
| **Fix** | G3, G8 assertion correction | 2 | None — just fix assertions |
| **Total** | | **12** | |

## Files

| File | Type | Purpose |
|------|------|---------|
| `lib/services/onboarding_service.dart` | MODIFY | Add `await syncService.initialPull();` call |
| `test/services/restore_from_cloud_test.dart` | MODIFY | Groups A-ext tests (A5, A11–A15) + G3/G8 fixes |
| `test/data/sync/restore_integration_test.dart` | MODIFY | Groups G-ext tests (G1, G4–G6) |
