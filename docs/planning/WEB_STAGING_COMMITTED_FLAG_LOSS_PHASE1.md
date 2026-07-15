# Web Staging Committed-Flag Loss — Test Exploration (Phase 1)

> **Plan:** Investigation report from 2026-07-15
> **Linked issue:** `docs/planning/BACKLOG.md` §B-01
> **Purpose:** Blueprint of all needed test assertions before fixing committed-flag loss in web sync.
> **Status:** ✅ Phase 4 (REFACTOR complete)
> **Next Phase:** Done — Full 4-phase TDD complete.

## Problem Summary

Committed ledger entries reappear as uncommitted staging entries in phpoc-web after sync or re-onboarding from R2. Three interrelated bugs in `phpoc-web/src/sync/` cause the `committed` and `block_index` fields to be stripped during push, pull, and merge:

| # | File | Lines | Issue |
|---|------|-------|-------|
| 1 | `entry_dto.js` | ~90–135 | `rawEntryToDTO()` reads only `raw.data`, ignores top-level `raw.committed`/`raw.block_index` |
| 2 | `remote_sync.js` | ~100–130 | `pushBlob()` manually reconstructs entries, omits `committed`/`block_index` |
| 3 | `sync.js` | ~769–776 | `_reconcileDifferentDevice()` merges remote into local without filtering committed entries |

The CLI equivalents all handle this correctly:
- `service.py:744` → `"committed": raw_entry.get("committed", False)`
- `remote_sync.py:163` → passes raw entries directly (no reconstruction)
- `service.py:505–507` → `merged = [e for e in merged if not e.get("committed")]`

## Architecture Overview

```
rawEntryToDTO()                    pushBlob()
  raw blob entry ──→ DTO            DTO ──→ raw blob entry
  (has committed)    (loses it)     (has committed)  (loses it)

_reconcileDifferentDevice()
  remote blob ──→ rawEntryToDTO() ──→ mergeEntries() ──→ writeEntries()
  (from R2)         (loses committed)  (no filter)        (committed=false)
```

Two data paths affected:
- **Web → R2:** `pushBlob()` strips committed from entries pushed to remote
- **R2 → Web:** `rawEntryToDTO()` ignores committed even if present (e.g., from CLI)

The merge path lacks the CLI's post-merge committed filter as a safety net.

## Test Groups

### Group A: `rawEntryToDTO` committed/block_index preservation — ~8 tests

**Test file:** `phpoc-web/test/entry_dto_committed_test.mjs` (NEW)
**Module under test:** `entry_dto.js` → `rawEntryToDTO()`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Raw entry with `committed: true` at top level → DTO has `committed: true` | Verify committed flag survives the raw→DTO conversion | This is the primary data path where committed state is lost today |
| A2 | Raw entry with `committed: false` at top level → DTO has `committed: false` | False flag also preserved (not coerced to truthy) | Ensures `raw.committed \|\| false`-style coercion doesn't silently flip false→undefined |
| A3 | Raw entry without `committed` field (legacy blob) → DTO has `committed: false` (default) | Backward compat: old blobs without the field default to uncommitted | Legacy entries from before committed was added must not break |
| A4 | Raw entry with `block_index: N` at top level → DTO has `block_index: N` | Verify block index survives raw→DTO | Necessary for display logic that shows which block an entry was committed in |
| A5 | Raw entry without `block_index` field → DTO has `block_index: null` (default) | Backward compat for uncommitted entries | Uncommitted entries naturally have no block index |
| A6 | Both `committed: true` and `block_index: 5` → DTO preserves both simultaneously | Compound preservation | Ensures the fix doesn't regress when both fields are present (normal committed case) |
| A7 | All existing DTO fields still populated correctly alongside committed/block_index | No regression on existing fields | entry_id, title, start_epoch, end_epoch, duration, is_active, is_paused, pauses, tags, comment, media, metadata, date, source, hash, device_uuid, end_device_uuid must all still work |
| A8 | Raw entry with committed but missing entry_id → committed still preserved | Field order independence | committed lives at raw top-level, not inside data — should work even if data fields are sparse |

### Group B: `rawCommittedEntryToDTO` committed flag — ~3 tests

**Test file:** `phpoc-web/test/entry_dto_committed_test.mjs` (same file as Group A)
**Module under test:** `entry_dto.js` → `rawCommittedEntryToDTO()`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Committed entry DTO has `committed: true` | Entries from ledger blocks are inherently committed | `getCompleted()` in sync.js uses committedEntryToDTO; the committed flag should be set |
| B2 | Committed entry DTO has `source: 'ledger'` (existing behavior, preserved) | Source discriminator unchanged | Regression guard — the source field distinguishes ledger from staging entries |
| B3 | Committed entry DTO has `is_active: false` (existing behavior, preserved) | Ledger entries are always completed | Regression guard — committed entries can never be active |

### Group C: `RemoteSync.pushBlob` serializes committed/block_index — ~5 tests

**Test file:** `phpoc-web/test/remote_push_committed_test.mjs` (NEW)
**Module under test:** `remote_sync.js` → `RemoteSync.pushBlob()`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `pushBlob()` includes `committed: true` in the raw entry when DTO has committed=true | Committed flag survives DTO→raw serialization | This is Bug 2 — committed is currently stripped on push |
| C2 | `pushBlob()` includes `committed: false` in the raw entry when DTO has committed=false | False flag serialized (not omitted) | Ensures entries without committed still push a clean false |
| C3 | `pushBlob()` includes `block_index` in the raw entry when DTO has block_index=N | Block index survives DTO→raw | Necessary for CLI clients that pull the web's blob |
| C4 | `pushBlob()` handles DTO without committed or block_index (legacy) | Backward compat for entries created before these fields existed | Must not crash or add spurious fields for legacy entries |
| C5 | Round-trip: DTO with committed=true + block_index → pushBlob raw → rawEntryToDTO → committed + block_index preserved | Full push→pull cycle preserves committed state | Integration of Bug 1 + Bug 2 fixes; ensures R2 blob can be read back correctly |

### Group D: `_reconcileDifferentDevice` filters committed entries after merge — ~6 tests

**Test file:** `phpoc-web/test/sync_service_test.mjs` (MODIFY — add Group-Z equivalent)
**Module under test:** `sync.js` → `SyncService._reconcileDifferentDevice()`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Remote blob has entry with committed=true → entry NOT written to local staging after merge | Committed entries filtered out post-merge | This is the CLI's `merged = [e for e in merged if not e.get("committed")]` behavior (Bug 3) |
| D2 | Remote blob has entry with committed=false → entry IS written to local staging after merge | Uncommitted entries survive merge | Normal sync path must still work — only committed entries are filtered |
| D3 | Remote blob has mixed committed/uncommitted for different entries → only uncommitted survive | Selective filtering | Realistic scenario: some remote entries committed, some not |
| D4 | Remote blob has committed=true for an entry that also exists locally → local entry preserved for non-committed, remote committed filtered | Dedup + filter interaction | mergeEntries dedup (remote wins) happens first, filter should run after |
| D5 | Post-merge write contains zero entries with committed=true | Invariant: staging never stores committed entries | Safety net — even if DTOs sneak through with committed, post-merge filter catches them |
| D6 | block_index preserved for committed entries that survive filtering (if any survive) | Data integrity for committed entries in staging | If a committed entry somehow survives (e.g., block_index needed for display), it should keep its fields |

### Group E: Integration — full round-trip — ~5 tests

**Test file:** `phpoc-web/test/committed_flag_integration_test.mjs` (NEW)
**Modules under test:** `sync.js` + `local_cache.js` + `entry_dto.js` + `remote_sync.js`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Commit entry → markCommitted → pushBlobOnly → pullBlob → rawEntryToDTO → committed is true | Full web-side round-trip preserves committed | End-to-end test that both push and pull preserve the flag |
| E2 | Commit entry → markCommitted → readEntries → entry has committed=true | Local flag is set after commit | Verify markCommitted works locally (existing behavior, regression guard) |
| E3 | Sync with remote containing committed entry → staging does not show committed entry | Remote committed entries don't pollute local staging | The user-visible symptom — committed entries should not appear in Sync tab |
| E4 | Simulate CLI push (raw entries with committed=true in blob) → web pull and reconcile → committed entries filtered | Cross-client compatibility | The CLI properly preserves committed; web must handle CLI-originated blobs |
| E5 | Empty staging after committing all entries → readEntries returns no uncommitted entries | All-committed scenario | Edge case: when every staging entry has been committed, the list should be empty |

## Coverage Summary

| Group | Tests | Module(s) | New/Modify |
|-------|-------|-----------|------------|
| A | 8 | `entry_dto.js` → `rawEntryToDTO()` | NEW: `entry_dto_committed_test.mjs` |
| B | 3 | `entry_dto.js` → `rawCommittedEntryToDTO()` | NEW (same file as A) |
| C | 5 | `remote_sync.js` → `pushBlob()` | NEW: `remote_push_committed_test.mjs` |
| D | 6 | `sync.js` → `_reconcileDifferentDevice()` | MODIFY: `sync_service_test.mjs` |
| E | 5 | Full round-trip integration | NEW: `committed_flag_integration_test.mjs` |
| **Total** | **27** | 3 buggy files + 1 integration | 3 new files + 1 modified |

## Files to Create (Phase 2)

| File | Groups | ~Tests |
|------|--------|--------|
| `phpoc-web/test/entry_dto_committed_test.mjs` | A, B | 11 |
| `phpoc-web/test/remote_push_committed_test.mjs` | C | 5 |
| `phpoc-web/test/committed_flag_integration_test.mjs` | E | 5 |
| `phpoc-web/test/sync_service_test.mjs` | D (add) | 6 |

## Files to Fix (Phase 3)

| File | Bug | Lines |
|------|-----|-------|
| `phpoc-web/src/sync/entry_dto.js` | #1 — `rawEntryToDTO` missing committed/block_index | ~90–135 |
| `phpoc-web/src/sync/remote_sync.js` | #2 — `pushBlob` missing committed/block_index serialization | ~100–130 |
| `phpoc-web/src/sync/sync.js` | #3 — `_reconcileDifferentDevice` no post-merge filter | ~769–776 |

## Phase Dependency Order

Phases 2–4 execute in order. Within Phase 3, fix Bug 1 first (enum tests pass), then Bug 2 (DTO→raw round-trip), then Bug 3 (merge filter). Integration tests (Group E) should go GREEN last.
