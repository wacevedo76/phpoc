# Smart Sync Button — Test Exploration (Phase 1)

> **Plan:** ADR-030 / D11 sync semantics + user request to unify the "Sync" action
> **Decision:** option **(b) — reconcile-then-push** (pull remote, merge missing sealed
> blocks, then push the local unsealed tail).
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Problem Statement

The **Sync** button currently calls `SyncService.commitAndSync()`, which seals ended
uncommitted entries into local ledger blocks and (only in push mode) auto-pushes the
**new** blocks. It never performs a **full** ledger push. This is why the phone's already
committed but never-pushed blocks (e.g. Aug 18–19, chain indices 134–135) remain stranded
locally: once committed, no future commit fires, and the periodic `checkAndSync` only
pushes staging rows, never ledger blocks.

The user wants the **Sync** button to become a smart, unified action:

1. **Check remote configured** — Worker URL + API token set (i.e. a transport is wired).
2. **Check worker + R2 online** — `transport.healthCheck()` succeeds.
3. If **both** hold → perform the full **ledger merge / reconciliation** workflow — the
   "Push Ledger to Cloud" (`LedgerPushService.pushAll()`) behavior, but **reconcile-first**
   so a stale chain never clobbers the remote.
4. If **either** check fails → **simply commit to the local ledger** (local-only, no push).

## Architecture Overview

- `SyncService` (`lib/data/sync/sync_service.dart`) owns `transport`, `ledgerPush`,
  `stagingStore`, `ledgerEngine`. It exposes `isRemoteAvailable` (transport != null) and
  `commitAndSync({selectedIds})`.
- `LedgerPushService` (`lib/services/ledger_push_service.dart`) — `pushAll()` reads all
  blocks from the DB and pushes each to `ledger/blocks/NNNNNN.json` + writes
  `hash_index.json`. `PushResult` conveys success/failure.
- `LedgerPullService` / `checkAndSync` pull the remote chain and reconcile staging.
- `HttpTransport.healthCheck()` throws on connection failure or non-2xx (404 treated as
  online).
- New surface: a `smartSync({selectedIds})` method on `SyncService` ORCHESTRATING the
  checks + reconcile-then-push, plus a `forceLocal` flag on `commitAndSync` so the offline
  fallback is a true local-only commit (does not auto-push and does not MOVE-delete
  committed rows).
- The SyncScreen `_unifiedSync` handler is rewired to call `smartSync`.

## Design Decisions

> **Decision (user-confirmed):** implement option **(b) — reconcile-then-push.** The
> Sync button is NOT a blind full overwrite. A stale local chain must first **pull** the
> remote chain and **merge** any missing sealed blocks, then **push** only the local
> unsealed tail. This prevents a behind-device from clobbering a canonical remote chain,
> and also covers the phone-ahead case (e.g. stranded Aug 18–19 blocks).

- **Outcome enum `SmartSyncOutcome`**: `remoteSynced` (configured+online, reconciled and
  pushed), `committedLocal` (fallback: local-only commit), `nothingToCommit` (no ended
  uncommitted entries and not configured), `pushFailed` (online but push errored),
  `remoteDry` (remote has blocks; nothing to merge/push).
- **Reconcile-then-push (online path) order:**
  1. **Pull/refetch** the remote chain (block index + `hash_index.json`).
  2. **Merge** — append any remote sealed blocks the local ledger is missing
     (reconcile the canonical 0..tip section). Duplicate/known indices are skipped;
     the local unsealed tail is preserved and never dropped.
  3. **Commit** ended uncommitted entries locally via `commitAndSync(forceLocal: true)`.
  4. **Push** the reconciled ledger to R2 (the "Push Ledger to Cloud" `pushAll()`
     workflow) so both merged-remote and local-tip blocks reach the remote.
- **Fallback path** (unconfigured OR offline): `commitAndSync(forceLocal: true)` only —
  no pull, no push, no row deletion beyond standard committed marking.
- **Safety boundary:** the blunt full-overwrite "Push Ledger to Cloud" button stays
  available with its existing confirmation dialog for deliberate force-overwrites. The
  Sync button uses reconcile-first, never a blind overwrite.
- `forceLocal` defaults to `false` so existing `commitAndSync` callers/tests are unchanged.

## Test Groups

### Group A: `SyncService.smartSync` orchestration — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `smartSync` with **no remote configured** commits ended entries locally and returns `committedLocal`, never pulls or calls `pushAll` | Verify fallback when unconfigured | The user-specified behavior: unconfigured → local commit only |
| A2 | `smartSync` with remote configured but `healthCheck()` throwing (offline) commits locally and returns `committedLocal`, never pulls or pushes | Verify fallback when offline | Offline must not attempt remote I/O, must degrade to local commit |
| A3 | `smartSync` with remote configured + online **pulls the remote chain first**, merges, and pushes, returning `remoteSynced` | Verify the full reconcile-then-push path | The core fix: Sync reconciles before pushing so a stale chain never clobbers the remote |
| A4 | `smartSync` with no ended uncommitted entries and **no remote configured** returns `nothingToCommit` (no fetch/push) | Verify pure no-op when nothing to do | Avoid surprising network calls when local is clean |
| A5 | `smartSync` with remote configured + online but local ledger identical to remote returns `remoteDry` (no redundant push) | Verify no-op when already reconciled | Avoids wasteful full pushes on an already-in-sync state |
| A6 | **Stale-local merge:** remote has a canonical block (or blocks) the local chain is missing → `smartSync` pulls it and appends it to the local chain before pushing | Verify a behind-device catches up instead of overwriting | Prevents pushing the missing canonical block would have lost |
| A7 | Stale-local merge preserves the local **unsealed tail** (stranded blocks like phone idx 134/135) — they are not dropped when remote blocks are appended | Verify tail preservation | The stranded-Aug-blocks fix must survive a reconcile |
| A8 | `smartSync` with remote online but the push failing returns `pushFailed` (reports the error) | Verify failures surface | User must know when the push did not reach R2 |
| A9 | Fallback path uses local-only commit semantics: committed rows remain in staging (marked committed), not MOVE-deleted | Verify `forceLocal` behavior | Distinguishes "commit local only" from push-mode MOVE delete |
| A10 | Online path pushes the newly committed block in the chain (pushAll sees the persisted block) | Verify commit-then-push ordering | Ensures the block is on R2 right after the Sync tap |

### Group B: Sync button UI rewiring — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Tapping **Sync** when remote configured + online triggers `smartSync` and reports reconcile+push success | Verify button now reconciles then pushes | End-user observable fix |
| B2 | Tapping **Sync** when remote **not configured** commits locally (no error, local result) | Verify graceful fallback in UI | Unconfigured devices still commit to local ledger |
| B3 | Tapping **Sync** when remote configured but offline commits locally (no error, local result) | Verify offline fallback in UI | Offline must degrade cleanly |
| B4 | Sync button disables + shows spinner during `smartSync` | Verify busy-state UX preserved | Prevents double-taps/duplicate pushes |

### Group C: `commitAndSync(forceLocal:)` — ~2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `commitAndSync(forceLocal: true)` with transport wired does **not** auto-push new blocks nor delete committed rows | Verify the forced-local switch | Backs the fallback path; must not regress normal push-mode behavior |
| C2 | `commitAndSync()` default (`forceLocal: false`) retains existing push-mode behavior (auto-push + MOVE delete) | Verify backward compat | Existing D11 behavior/tests must stay green |

### Group D: reconcile/merge (ledger catch-up) — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Merge appends only remote sealed blocks the local chain is **missing**; already-present indices are skipped (no duplicate blocks) | Verify merge idempotency | A second Sync must not duplicate canonical blocks |
| D2 | Merge preserves `prev_hash` linkage across the boundary (last local block → first appended remote block) | Verify chain integrity | A broken bridge would make the reconciled chain unverifiable downstream |
| D3 | Merge with a **future/branching** remote tip is reconciled deterministically (no silent fork overwrite); unsupported divergence is surfaced, not blindly pushed | Verify safety on divergence | A blind push over a divergent remote must not silently destroy the canonical tip |
| D4 | Merge ignores remote blocks for indices already sealed locally with a **different hash** (conflict detection) rather than overwriting | Verify conflict guard | Prevents an external chain from replacing canonical local sealed blocks |

## Summary

- **Total assertions:** 20
- **Group A (`smartSync` orchestration):** 10
- **Group B (Sync button UI):** 4
- **Group C (`forceLocal` on commit):** 2
- **Group D (reconcile/merge):** 4
- **Key coverage:** remote-configured/online/offline branches, fallback-to-local-commit,
  reconcile-then-push (stale-local catch-up + unsealed-tail preservation), full-chain
  reconciliation push, conflict guards on divergence, `forceLocal` semantics, backward
  compat, and the end-user Sync-button behavior in all three remote states.

## Files (planned)

- **Modified (source):**
  - `phpoc-flutter/lib/data/sync/sync_service.dart` — add `SmartSyncOutcome`,
    `smartSync()`, `_isRemoteOnline()`, reconcile/merge helpers, `forceLocal` on
    `commitAndSync`.
  - `phpoc-flutter/lib/features/sync/sync_screen.dart` — rewire `_unifiedSync` to
    `smartSync()`; surface `pushFailed`/`remoteDry` vs local-commit messaging.
- **Test files (planned):**
  - `phpoc-flutter/test/data/sync/smart_sync_test.dart` — Groups A + C + D.
  - `phpoc-flutter/test/features/sync_screen_smart_sync_test.dart` — Group B.
