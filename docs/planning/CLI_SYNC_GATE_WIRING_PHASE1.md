# CLI Sync-Gate Wiring — Test Exploration (Phase 1)

> **Plan:** `CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` §CCS-3 (steps 4–7) + `CLI_SQLITE_STAGING_PHASE1.md`
> **Purpose:** Blueprint the remaining CCS-3 work — wiring the row-level `SqliteStagingStore`, `mergeRows` activity_id LWW, and `StagingHashIndex` into the Python `StagingService` sync gate.
> **Status:** ✅ Phase 3 complete (GREEN) — 60/60 tests pass
> **Next Phase:** ~Phase 4 (REFACTOR) — no refactor changes delivered (implementation-only)

## Background / Scope Clarification

The store-level foundation for CCS-3 is **already complete and GREEN**:

- `SqliteStagingStore` (`storage/implementations/sqlite_staging.py`) — schema + CRUD + position/row ops (Groups A–G)
- `buildDiff()` (`core/sync/diff_engine.py`) — exact Python port of `row_sync.js:buildDiff()` (Groups I)
- `migrate_staging()` — one-shot `staging.json` → SQLite (Group H)
- Store + `buildDiff` integration (Group J)

Covered by `tests/test_sqlite_staging.py` (104 tests, all GREEN). ✅

**What remains** is the *sync-gate wiring* into `StagingService`, matching what CCS-2 (Web) delivered. Today the CLI `StagingService`:

- wraps `FileStagingStore` via `LocalStagingCache` (not `SqliteStagingStore`), and
- reconciles the remote blob with `MergeEngine.merge()` which is **entry_id-based** (not activity_id LWW), so rows sharing an `activity_id` across clients duplicate instead of consolidating.

The reference for the target behavior is the Web CCS-2 implementation:
- `phpoc-web/src/sync/remote_sync.js:dtoToCanonicalRow()`
- `phpoc-web/src/sync/entry_dto.js:canonicalRowToDTO()`
- `phpoc-web/src/sync/row_sync.js:mergeRows()`
- `phpoc-web/src/sync/sync.js:_mergeRemoteIntoLocal()`

## Architecture Overview

Four concrete deliverables, all pure logic except the service/store wiring:

```
LocalStagingCache DTOs  ──dtoToCanonicalRow()──►  canonical rows
      {{title,start_epoch,...}}                     {activity_id, activity_status, activity, updated_at, committed}
                                                           │
remote blob entries ──raw_entry_to_dto()──► DTOs ──dtoToCanonicalRow()──►  canonical rows
                                                           │
                                              mergeRows(localRows, remoteRows)  ── activity_id LWW
                                                           │
Store rows ──SqliteStagingStore──►  StagingHashIndex.build(store)  ──► hash_index.json
                                                           │
                    merged rows ──canonicalRowToDTO()──►  DTOs ──committed-exclusion──► LocalCache
```

### Modules & Changes

| File | Change |
|------|--------|
| `domain/staging/row_merge.py` (new) | `dtoToCanonicalRow()`, `canonicalRowToDTO()`, `_derive_status_from_dto()` ports |
| `domain/staging/merge_engine.py` | Add `merge_rows()` (activity_id LWW port of `mergeRows`); keep `merge()` for backward compat |
| `core/staging_hash_index.py` | Add `build_from_store(store)` — read rows via `store.get_all_rows()` |
| `domain/staging/service.py` | `_merge_remote_into_local()`: store → merge by activity_id → committed-exclusion; wire hash index push; store selection to `SqliteStagingStore` (via `LocalStagingCache` swap) |

---

## Test Groups

### Group A: Canonical row conversion — dtoToCanonicalRow / canonicalRowToDTO — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `dtoToCanonicalRow(dto, device_id, now)` returns row with `activity_id = dto.activity_id` (falls back to `entry_id`) | ID mapping | Activity_id is the merge key — must default to entry_id on ported rows |
| A2 | `activity_status` derived: `is_active==False → "ended"`, `is_paused → "paused"`, else `"active"` | Status derivation | Same `_deriveStatusFromDTO` semantics as Web; drives LWW status compare |
| A3 | `activity` column is the DTO flattened to a canonical JSON string with `title/start_epoch/end_epoch/duration/tags/comment/media/entry_id/is_active/is_paused/pauses/metadata/device_uuid/end_device_uuid/block_index` | Data preservation | The `activity` JSON IS how canonical rows store full fidelity — no field loss |
| A4 | `updated_at` uses `dto.updated_at` when present, else `now` | Timestamp default | LWW relies on updated_at; DTOs from local cache lack it |
| A5 | `committed` preserved from DTO (default False) | Committed flag | Committed-exclusion depends on this flag surviving the round-trip |
| A6 | `canonicalRowToDTO(row)` parses `activity` JSON back to flat DTO fields (title, start_epoch, ...) | Reverse conversion | Merge output rows must return to DTO shape for `LocalStagingCache` |
| A7 | `canonicalRowToDTO` sets `is_active = (activity_status != 'ended')`, `is_paused = (activity_status == 'paused')` | Status round-trip | Inverse of A2 — status flag ↔ string must be bijective |
| A8 | `canonicalRowToDTO` sets `date` from `start_epoch` (YYYY-MM-DD) | DTO contract | Web DTOs carry a `date`; Python `read_entries()` DTOs require it |
| A9 | `canonicalRowToDTO` with malformed/non-JSON `activity` string returns a safe DTO (empty fields, not crash) | Resilience | Corrupt activity JSON must degrade gracefully |
| A10 | `dtoToCanonicalRow`(None) or missing id returns row with empty activity_id (not crash) | Defensive | Callers must be safe against malformed DTOs |

### Group B: mergeRows — activity_id LWW — ~14 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Same `activity_id` both sides, remote `updated_at` newer → remote row wins | LWW remote-wins | Core consolidation: same activity on two devices must not duplicate |
| B2 | Same `activity_id` both sides, local `updated_at` newer → local row wins | LWW local-wins | Symmetric with B1 |
| B3 | Same `updated_at`, both sides → local row wins (tie-break) | Tie-break | Matches Web `mergeRows` ("on equal updated_at: local row wins") |
| B4 | Local-only row with `committed:true` AND absent in remote → excluded from result | Committed-exclusion | A committed entry cleaned up on another device must not resurface locally |
| B5 | Local-only row with `committed:false` → included | New-entry preservation | Uncommitted new activity survives merge |
| B6 | Remote-only row → included unconditionally | Pull merge | New activity arriving from another device is added |
| B7 | Remote-wins row with local committed:true → committed flag stays true (irreversible) | Commitment irreversibility | A committed row must never be downgraded to uncommitted by stale remote |
| B8 | Missing `activity_status` / `activity` columns defaulted (`active` / `'{}'`) | Defensive defaults | Canonical schema requires these; remote rows may omit them |
| B9 | Missing `updated_at` defaults to 0 | Default | LWW must handle missing timestamps deterministically |
| B10 | Returns a new list — does not mutate either input | Immutability | Pure-function contract; callers reuse local/remote arrays |
| B11 | Deduplicates by `activity_id`, `entry_id` as fallback key | Key fallback | Rows before activity_id convention carry only entry_id |
| B12 | Stable input order produces deterministic output (sorted by activity_id) | Determinism | Merge result persists to store; order must be reproducible |
| B13 | 50 mixed rows (both/only-local/only-remote/committed) classify correctly | Stress | Validates the algorithm at realistic scale like Web CCS-2 test |
| B14 | `merged_rows` output only contains `{activity_id, activity_status, activity, updated_at, committed}` for every row | Schema conformance | Store `upsert_row` requires exactly these 4+ committed fields |

### Group C: service._merge_remote_into_local() — reconcile by activity_id — ~11 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Convert local `LocalStagingCache.read_entries()` DTOs → canonical rows | Input conversion | Entry point: local DTOs become the local row set |
| C2 | Convert remote blob entries → DTOs (via `_raw_entry_to_dto`) then → canonical rows | Remote conversion | Same pipeline as Web `_rowsFromRemoteBlob` |
| C3 | Call `merge_rows(local_rows, remote_rows)`; result is the merged canonical set | Merge invocation | Wires the LWW merge into the reconcile path |
| C4 | Detect `remoteWonIds` — activity_ids where remote.updated_at strictly newer | Remote-wins detection | Only strictly-remote-won rows are rebuilt from canonical; others keep full local DTO fidelity |
| C5 | Rebuild DTOs: un-won rows reuse the full-fidelity local DTO (not just canonical) | Fidelity preservation | Preserves encrypted fields / extra DTO fields lost in canonical flattening |
| C6 | Remote-won rows rebuilt via `canonicalRowToDTO` | Rebuild path | Matches Web `mergedDTOs.push(canonicalRowToDTO(mrow))` |
| C7 | `committed` DTOs filtered out before writing (`merged = [e for e in dto if not e['committed']]`) | Committed-exclusion | Mirrors existing `service.py` committed-exclusion contract |
| C8 | Dedup DTOs by `activity_id` (first wins) during rebuild | Dedup | Multiple local DTOs sharing an activity_id collapse to one |
| C9 | Merge failure (bad remote row) degrades to "push local as-is" — no crash, no data loss | Resilience | Existing reconcile swallows merge exceptions; preserved |
| C10 | Idempotent: re-running the merge on an already-converged set produces no new dedup | Idempotency | Second reconcile after sync must not mutate state spuriously |
| C11 | Result written via `_local.write_entries(merged)` | Persistence | The reconciled DTOs become the new local staging state |

### Group D: SqliteStagingStore wired into StagingService — ~9 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `StagingService` accepts and uses a `SqliteStagingStore` as its backing store | Store selection | Item 5 — service must read/write SQLite rows, not only `FileStagingStore` |
| D2 | `capture()` on a SQLite-backed service persists the row (visible via `read_entries()`) | Write path | New staging write lands in SQLite |
| D3 | `put_row`/`get_all_rows`/`delete_row` are consistent with `read_entries()` after service CRUD | Dual-interface consistency | Both store interfaces operate on the same table |
| D4 | Service `remove_synced(indices)` deletes the correct SQLite rows | Delete path | Multi-index removal maps through SQLite `remove_entries` |
| D5 | Service `update_entry` (modify) bumps `updated_at` in SQLite | LWW timestamp | Every local mutation updates the timestamp for sync |
| D6 | `read_entries()` on SQLite-backed service preserves field types (updated_at int, activity str) | Type fidelity | SQLite must not coerce timestamps/JSON to strings |
| D7 | Store survives close → reopen: data persists across connections | Durability | D5/D6 durability contract — SQLite file is the source of truth |
| D8 | Service still works when store is `FileStagingStore` (backward compat / graceful fallback) | Backward compat | Existing CLI tools/tests must not break while SQLite rolls out |
| D9 | Empty store → `read_entries()` returns `[]`, count `0` | Empty-state | Fresh store must present clean slate |

### Group E: StagingHashIndex.build_from_store — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `build_from_store(store)` reads all rows via `store.get_all_rows()` | Store read | Item 4 — build from SQLite instead of an in-memory list |
| E2 | Produces `[{activity_id, activity_status}]` sorted by activity_id | Index shape | Same contract as `StagingHashIndex.build` |
| E3 | Rows missing activity_id skipped | Defensive | Malformed rows must not corrupt the index |
| E4 | Empty store → empty index | Empty-state | New device builds an empty hash index |
| E5 | `computeHash(build_from_store(store))` matches `computeHash(build(store.get_all_rows()))` | Equivalence | The store-based path and manual path are byte-identical |
| E6 | `build_from_store` returns a fresh list (does not cache / alias store rows) | Determinism | No stale alias of live store data |

### Group F: Sync-gate integration — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Full reconcile on SQLite-backed service: local DTOs → canonical → merge → DTOs → write | End-to-end | Validates the entire CCS-3 pipeline through `StagingService` |
| F2 | After reconcile, rows sharing activity_id are consolidated (not duplicated under distinct entry_id) | CCS-3 core goal | The whole point: cross-client same-activity consolidation |
| F3 | Hash index pushed to remote after blob push (via transport `push_hash_index`) | R7 (web) parity | Remote fast-path relies on the pushed hash index |
| F4 | Pull path: `pull_hash_index()` then `pull()` reconcile differents-device | Fast-path parity | Mirror Web `_pullAndCacheStagingHashIndex` |
| F5 | `check_and_sync` read-only fast path skips network when no pending writes (SQLite-count based) | Optimization parity | Existing CLI optimization, now counting SQLite rows |
| F6 | `_reconcile_and_claim` on different device pulls, merges (activity_id), pushes merged, creates cookie | Cross-device reconcile | Replaces legacy `MergeEngine(entry_id)` in this path |
| F7 | `_push_on_fast_path` uses SQLite-backed local read for merge | Fast-path merge | Same-device fast path also merges at canonical level |
| F8 | Offline / BLOB_KEY_MISMATCH still returns OFFLINE (no data loss) | Safety | Wrong-MK abort preserved — never overwrite remote |
| F9 | Migration: `staging.json` present → `SqliteStagingStore` migrated + service reads migrated rows | Migration wiring | Backlog item 3 (migrate) hooked into service startup |
| F10 | Full suite isolation: existing `test_staging_service.py` (FileStagingStore) still GREEN | No regression | Backward-compat gate for the whole wiring effort |

---

## Summary

| Group | Name | Tests |
|-------|------|-------|
| A | Canonical row conversion | 10 |
| B | mergeRows — activity_id LWW | 14 |
| C | service._merge_remote_into_local() | 11 |
| D | SqliteStagingStore wired into StagingService | 9 |
| E | StagingHashIndex.build_from_store | 6 |
| F | Sync-gate integration | 10 |
| **Total** | | **60** |

### Key coverage areas:
- **Consolidation (CCS-3 core):** B + C ensure rows sharing an activity_id merge to one across clients/devices.
- **Fidelity:** A + C4/C5 ensure only strictly-remote-won rows are rebuilt from canonical, preserving full local DTO fidelity (encrypted fields).
- **LWW + committed-exclusion:** B1–B9 mirror the Web `mergeRows` exactly (remote-wins on newer ts, local-wins on tie, committed-irreversibility, committed-exclusion).
- **Backward compat:** D8 + F10 gate that `FileStagingStore`-based service and existing tests keep passing.
- **Hash-index parity:** E + F3/F4 deliver Web R7/F4 parity for the CLI.
- **Safety:** F8 preserves the wrong-MK abort so remote staging is never clobbered.

## Deferred (out of scope for this wiring pass)

- Actual cross-client E2E verification (Flutter↔CLI, Web↔CLI) → CCS-4.
- Retiring the legacy `MergeEngine.merge()` entry_id path → keep for backward compat.
- Fully switching the CLI CLI-interface default store to SQLite (currently only the wiring + migration are covered; full `ph` command default-store flip is the rollout step).
