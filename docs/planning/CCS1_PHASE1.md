# CCS-1: Flutter — Close Remaining Gaps (Test Exploration)

> **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md`
> **Protocol:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (18 gates, abstract state machine)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 4 (REFACTOR: code review complete)
> **Next Phase:** Complete — ready for next task (CCS-2).

## Architecture Overview

`SyncService.checkAndSync()` drives the abstract protocol state machine from §12. Four gaps were
found during gate-by-gate verification:

| # | Gate | Root Cause | Fix in |
|----|------|-----------|--------|
| R7 | Hash Index Push | `_pushStagingRowsToRemote()` pushes blob only; never pushes hash index. `_fastPathRowLevel()` pulls hash index but never pushes it after merge. | `sync_service.dart` |
| R4 | Committed Filter | `_reconcileAndClaimRowLevel()` keeps committed rows for History/Dashboard display. CLI and Web filter committed entries before push. | `sync_service.dart` |
| A2 | TTL → REAUTH | `checkAndSync()` falls to `_reconcileAndClaim()` when cookie is null, regardless of whether the cookie expired or never existed. When MK is cached, expired cookies auto-reconcile instead of returning `REAUTH_NEEDED`. | `sync_service.dart` + `DeviceCookie.isValidLocally()` |
| F1 | Read-Only Path | `checkAndSync()` always pulls remote cookie when local is valid, even with zero pending writes. No `hasPendingWrites()` check. | `sync_service.dart` |

**Code under test:** `phpoc-flutter/lib/data/sync/sync_service.dart` (line 471–785)
**Test file:** `phpoc-flutter/test/data/sync/ccs1_gap_closure_test.dart` (new)

---

## Test Groups

### Group A: R7 — Hash Index Push (~8 assertions)

**Problem:** `_pushStagingRowsToRemote()` pushes the obfuscated blob only. `_fastPathRowLevel()` pulls and compares hash index but never pushes after merge. The remote hash index is perpetually stale — other clients never hit the Tier-1 fast path for Flutter changes.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | After `_pushStagingRowsToRemote()`, hash index is pushed to `staging/hash_index.json` | Verifies hash index push follows blob push | Gate R7 in §12.4: "Build hash index, push." Without this, remote index is stale. |
| A2 | Hash index pushed contains correct activity_ids matching current staging rows | Verifies index content correctness | Same staging rows → same hash index. Invariant I3: cross-client hash index must match. |
| A3 | Hash index is pushed even with zero staging rows (empty index `[]`) | Edge case: empty staging | Remote must know staging is empty so other clients can fast-path READY. |
| A4 | `_fastPathRowLevel()` (identical hashes) pushes hash index after blob push | Covers the identical-hash fast-path code path | F4+identical → push local → READY. Hash index must be refreshed. |
| A5 | `_fastPathRowLevel()` (different hashes → reconcile) pushes hash index after merge | Covers the fall-through-to-reconcile code path | R7 must execute after R6 in merge path too. |
| A6 | Debounced auto-push (`_schedulePush` → `_doPush`) includes hash index push | Covers the mutation-triggered auto-push path | Every mutation path must keep hash index current. |
| A7 | Hash index is NOT pushed when transport is null (local-only mode) | Guard: no-op without transport | Avoids null-pointer on transport. |
| A8 | `pushToRemote()` (legacy LocalCache path) uses StagingStore hash index, not LocalCache | Verifies legacy push path reads from correct source | Current code reads `_local.readHashIndex()` — stale. |

### Group B: R4 — Committed Filter (~8 assertions)

**Problem:** `_reconcileAndClaimRowLevel()` keeps committed entries for History/Dashboard. CLI and Web both filter committed entries before push to `staging/blob`. The code comment on line 578 says committed entries stay, but the protocol (§12.4 R4, §12.5 resolution rules) mandates filtering.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `_reconcileAndClaimRowLevel()` filters remote committed rows before merge | Remote committed rows excluded from merge input | If another device committed an entry, it should not be re-added to local staging. |
| B2 | `_reconcileAndClaimRowLevel()` filters local committed rows from the blob that gets pushed to remote | Local committed rows excluded from pushed blob | Invariant I6: "Committed entries filtered before push." Prevents stale data in `staging/blob`. |
| B3 | `_pushStagingRowsToRemote()` excludes committed rows from `entries` array | Verifies push path filters committed | Gate R6 should push only non-committed rows. |
| B4 | `_rowIsCommitted()` returns true when row-level `committed` flag is `true` | Dedicated helper correctness | Row-level committed flag is the primary signal (set by `commitAndSync`). |
| B5 | `_rowIsCommitted()` returns true when activity JSON blob has `committed: true` | Dedicated helper correctness (blob-level) | Activity blob committed=true is seeded by ledger pull service; both sources must be checked. |
| B6 | Committed rows remain available for local queries (History/Dashboard display) | Committed rows preserved in StagingStore | `getCompleted()` and `getEntries()` still return committed rows for display. Only the remote blob excludes them. |
| B7 | When all staging rows are committed, blob push contains empty `entries` array | Edge case: everything committed | Empty entries array is valid — other clients see zero staging entries. |
| B8 | Merge with mixed committed+uncommitted on both sides produces correct filtered result | Integration edge case | Merge interacts with committed filter — committed rows from either side should not survive merge output. |

### Group C: A2 — TTL Expiry → REAUTH_NEEDED (~7 assertions)

**Problem:** `checkAndSync()` calls `_cookie.isValidLocally()` which returns `null` for both "cookie never existed" and "cookie expired." When null, the code falls to `_reconcileAndClaim()` unconditionally. If MK is cached (which it is post-onboarding), an expired cookie triggers auto-reconcile instead of `REAUTH_NEEDED`. This diverges from CLI/Web behavior per §12.4 gate A2.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `checkAndSync()` returns `SyncCheckResult.reauthNeeded` when cookie exists but TTL is expired | Expired cookie → reauth, not auto-reconcile | Gate A2: "TTL expired → REAUTH_NEEDED." User must consent before sync. |
| C2 | `checkAndSync()` proceeds to reconcile when cookie never existed (no cookie data in storage) | Fresh device → auto-reconcile | Distinguishes "expired" (reauth) from "never existed" (reconcile). First-time device should sync without extra auth. |
| C3 | `checkAndSync()` with valid cookie proceeds to fast path normally (regression guard) | Valid cookie unchanged | The A2 fix must not break the happy path. |
| C4 | TTL expiry returns `REAUTH_NEEDED` even when MK is cached in CryptoService | MK cached ≠ user consent | The current bug: MK is always cached post-onboarding, so TTL expiry is invisible. |
| C5 | `DeviceCookie.isValidLocally()` returns a distinguished result for "expired" vs "missing" | API contract change | Requires signature change: return cookie data on valid, throw/return enum for expired, null for missing. |
| C6 | TTL parameter is honored: cookie at boundary (exactly TTL ago) is still valid; 1ms past TTL is expired | Boundary condition | Protocol TTL is 30 minutes default; off-by-one would cause spurious reauth or missed expiry. |
| C7 | Cookie destruction: after `REAUTH_NEEDED` is returned, local cookie is cleared so future checks land on C2 (missing → reconcile) | Cleanup after reauth signal | Avoids repeated REAUTH_NEEDED loops after user dismisses without re-authenticating. |

### Group D: F1 — Read-Only Fast Path (~7 assertions)

**Problem:** `checkAndSync()` always pulls remote cookie (32 bytes) when local cookie is valid (line ~471), even with zero pending writes. §12.4 gate F1 says: valid cookie + no pending writes → `READY` with zero network calls. The scorecard says Flutter is ✅ but the code does not implement this.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `checkAndSync()` returns `SyncCheckResult.ready` without making any network calls when cookie is valid and there are zero pending writes | Read-only optimization | Invariant I7: "No network on read-only." Saves 32-byte pull per `checkAndSync()` call. |
| D2 | `checkAndSync()` proceeds to pull remote cookie when cookie is valid AND there ARE pending writes | Happy path: writes exist → sync | F1 gate: pending writes → continue to F2. Only skip when truly read-only. |
| D3 | `hasPendingWrites()` returns `false` when all staging rows are committed | Core helper: all committed | If all rows have committed=true, there's nothing to push. |
| D4 | `hasPendingWrites()` returns `false` when staging store is empty (zero rows) | Core helper: empty staging | No staging entries at all → nothing to push. |
| D5 | `hasPendingWrites()` returns `true` when at least one uncommitted row exists | Core helper: uncommitted row present | Any uncommitted row means there are writes to push. |
| D6 | F1 fast path records zero push paths and zero pull paths in transport spy | Network call audit | Explicit verification that transport is never touched. |
| D7 | F1 fast path works when `stagingStore` is null (old LocalCache path) | Legacy path coverage | The `LocalCache` fallback must also support read-only fast path. |

---

## Summary

| Group | Gate | Assertions | Key Risk Area |
|-------|------|------------|---------------|
| A | R7 | 8 | Hash index goes stale → other clients lose Tier-1 fast path |
| B | R4 | 8 | Committed entries leak to remote → extra network + stale data |
| C | A2 | 7 | Auto-reconcile on expired cookie → UX divergence from CLI/Web |
| D | F1 | 7 | Unnecessary network call per `checkAndSync()` |
| **Total** | | **30** | |

### Cross-Cutting Concerns

- **R7 + R4 interaction:** Hash index must reflect filtered (non-committed) rows. If R4 filter is applied at push time, the hash index must match the filtered blob.
- **R7 + F1 interaction:** When F1 fast paths to READY (no pending writes), hash index should NOT be pushed (no writes → nothing changed).
- **A2 + F1 interaction:** When cookie is expired and F1 would skip due to no writes, A2 should still trigger REAUTH_NEEDED (authenticity check takes priority over read-only optimization).
- **Test infrastructure:** All tests use `_ConfigTransport` (from `sync_service_row_level_test.dart`) to spy on push/pull calls. The `_RowTestHarness` pattern provides `SyncService` + `StagingStore` + spy transport.

### Files Touched (Expected)

| Phase | File | Change |
|-------|------|--------|
| Phase 2 | `phpoc-flutter/test/data/sync/ccs1_gap_closure_test.dart` | New: 30 RED tests |
| Phase 3 | `phpoc-flutter/lib/data/sync/sync_service.dart` | Fix R7, R4, A2, F1 |
| Phase 3 | `phpoc-flutter/lib/data/sync/device_cookie.dart` | Fix `isValidLocally()` return type for A2 |
| Phase 4 | Same files | Refactor improvements |
