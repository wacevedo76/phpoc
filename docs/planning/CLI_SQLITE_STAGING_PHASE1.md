# CLI SQLite Staging Store — Test Exploration (Phase 1)

> **Plan:** `ROW_LEVEL_STAGING_SYNC_PLAN.md` §Phase B
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration)
> **Next Phase:** ✅ Phase 2 (RED: `tests/test_sqlite_staging.py` — 104 tests defined)

## Architecture Overview

Three new modules replace the single-blob `staging.json` with a row-per-activity SQLite database:

```
SqliteStagingStore  ← sqlite3 (stdlib), implements AbstractStagingStore + row-level ops
       ↑
buildDiff()         ← Pure function: local rows vs remote manifest → action lists (Python port of JS)
       ↑
migrate_staging()   ← One-shot: staging.json → staging.db, renames original
```

### Design Decisions

1. **D3-compliant:** `sqlite3` is Python stdlib — zero external dependencies.
2. **Dual interface:** `SqliteStagingStore` implements `AbstractStagingStore` (position-based ops for backward compatibility with `LocalStagingCache`/`StagingService`) *and* provides row-level operations (`put_row`, `get_row`, `delete_row`, `get_all_rows`, `get_rows_by_status`, `count`) for the new sync model.
3. **Three-column schema** (per `ROW_LEVEL_STAGING_SYNC_PLAN.md`):
   ```sql
   CREATE TABLE staging (
     activity_id TEXT PRIMARY KEY,
     activity_status TEXT NOT NULL,
     activity TEXT NOT NULL,
     updated_at INTEGER NOT NULL DEFAULT 0
   );
   ```
4. **Position-based ops map to sorted row order:**
   - `read_entries()` → `SELECT ... FROM staging ORDER BY activity_id`
   - `update_entry(index)` → `UPDATE ... WHERE rowid = (SELECT rowid FROM staging ORDER BY activity_id LIMIT 1 OFFSET ?)`
   - `remove_entries(indices)` → DELETE by rowid in descending order
   - `append_entry(entry)` → INSERT
5. **`buildDiff()` is a pure-function port** of `phpoc-web/src/sync/row_sync.js:buildDiff()` — identical 8-scenario resolution logic, same input/output contract.
6. **Migration is one-shot + idempotent:** detects `staging.json`, creates `staging.db`, renames original → `.migrated`.

---

## Test Groups

### Group A: SqliteStagingStore — Schema & Lifecycle — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Store creates SQLite DB file at given path on init | Filesystem integration | Must produce a real file, not just an in-memory object |
| A2 | Store creates `staging` table with schema: `activity_id TEXT PK, activity_status TEXT NOT NULL, activity TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0` | Schema contract | Correct column names and types are the foundation for all row ops |
| A3 | Table is empty on first creation (`read_entries()` returns `[]`) | Clean slate | No phantom data in new store |
| A4 | Re-opening existing database preserves all previously written data | Persistence | Durability guarantee — data survives connection close/reopen (D5, D6) |
| A5 | `close()` releases the database connection | Resource management | Prevents file lock issues in tests and multi-process access |
| A6 | Context manager support: `with SqliteStagingStore(path) as store:` | Pythonic API | Standard `__enter__`/`__exit__` pattern for scoped usage |
| A7 | Store works with temp dir paths (`/dev/shm/...`) for testing | Test infrastructure | All tests must use RAM-backed dirs for speed, matching existing patterns |
| A8 | Store uses explicit `db_path` argument — does not write to CWD | Path contract | Prevents accidental file creation in working directory |
| A9 | `:memory:` path creates in-memory database | Memory mode | Useful for unit tests that don't want to hit disk at all |
| A10 | Creates parent directories if they don't exist | Auto-create contract | Matches `FileStagingStore._ensure_path()` behavior |
| A11 | `isinstance(store, AbstractStagingStore)` is `True` | Interface contract | Ensures store can be passed to `LocalStagingCache` and `StagingService` |
| A12 | Instantiation without `db_path` raises `TypeError` | Required argument | Path is mandatory — no default, no implicit behavior |

### Group B: SqliteStagingStore — read_entries / write_entries — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `read_entries()` returns empty list when store is empty | Empty state | Callers check `len(entries) == 0` for empty staging |
| B2 | `write_entries(data)` + `read_entries()` returns identical data | Round-trip integrity | The `AbstractStagingStore` contract requires faithful persistence |
| B3 | `write_entries([])` clears all rows (empty list = empty store) | Clear semantics | `StagingService` uses empty list writes to clear staging |
| B4 | `write_entries()` is atomic — on mid-write failure, old data preserved | Atomicity | SQLite transaction rollback on exception; partial writes must not persist |
| B5 | `write_entries()` with 500 rows preserves all (no truncation) | Bulk operation | Realistic stress — staging may have dozens of entries, 500 proves it scales |
| B6 | `read_entries()` preserves field types: `activity_id: str`, `activity_status: str`, `activity: str`, `updated_at: int` | Type fidelity | JSON serialization can lose types; SQLite preserves via `sqlite3.Row` or dict adapter |
| B7 | `write_entries()` sets `updated_at` to current time if not present | Auto-timestamp | LWW sync requires timestamps; missing ones default to "now" |
| B8 | `read_entries()` returns rows sorted by `activity_id` ASC | Deterministic order | Position-based ops depend on stable ordering; `ORDER BY activity_id` |
| B9 | `write_entries()` preserves extra dict fields beyond the 4 core columns | Forward-compat | Schema evolution (D9) — future fields must not be stripped |
| B10 | `write_entries()` with non-list argument raises `TypeError` | Input validation | Must reject invalid input type explicitly, not silently fail |

### Group C: SqliteStagingStore — append_entry — ~7 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `append_entry(entry)` adds one row to empty store | Core append | `StagingService.capture()` → `LocalStagingCache.append()` → `store.append_entry()` |
| C2 | `append_entry()` adds after existing entries (end of ordered list) | Position semantics | New entries appear last in `read_entries()`, matching index-based expectations |
| C3 | `append_entry()` preserves all fields in round-trip | Field completeness | No silent field loss on append → read |
| C4 | `append_entry()` auto-generates `updated_at` if entry lacks it | Smart default | Same as B7 — LWW sync needs timestamps |
| C5 | `append_entry()` with missing `activity_id` raises `ValueError` | Required field validation | PK constraint — must fail explicitly, not crash with SQLite error |
| C6 | `append_entry()` preserves extra fields beyond the 4 core columns | Forward-compat | Same rationale as B9 |
| C7 | `append_entry()` is immediately visible in `read_entries()` | Consistency | No caching/staleness — read reflects the just-written append |

### Group D: SqliteStagingStore — update_entry (position-based) — ~7 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `update_entry(index, fields)` merges provided fields into row at position | Core update | `StagingService.modify()` → `LocalStagingCache.update()` → `store.update_entry()` |
| D2 | `update_entry()` preserves fields not in the update dict | Non-destructive update | Only specified fields change; others remain as-is |
| D3 | `update_entry()` at out-of-range index is a no-op (no error) | Graceful bounds | Matches `FileStagingStore` behavior — silent skip |
| D4 | `update_entry()` changes `activity_status` correctly | Status mutation | Core operation in pause/unpause/end flows |
| D5 | `update_entry()` auto-updates `updated_at` to current time on any field change | LWW timestamp | Every mutation bumps the timestamp for sync comparison |
| D6 | Multiple sequential `update_entry()` calls compound correctly | Chained updates | Status: staged → active → paused → ended |
| D7 | `update_entry(index, {})` with empty fields dict is a no-op | Empty update | Should not crash, should not modify anything |

### Group E: SqliteStagingStore — remove_entries (position-based) — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `remove_entries([1])` removes single entry by position index | Core delete | `StagingService.remove_synced()` → `store.remove_entries()` |
| E2 | `remove_entries([0, 2])` removes multiple entries correctly | Multi-delete | Indices must be processed in descending order to avoid shift |
| E3 | `remove_entries([2, 0, 1])` with unsorted indices works (re-sorted internally) | Index order safety | `AbstractStagingStore` contract: "must process indices in descending order" |
| E4 | `remove_entries([])` is idempotent no-op | Empty list safety | No crash, no data loss when called with no indices |
| E5 | `remove_entries()` from empty store is no-op | Empty store safety | First-sync state — must not raise |
| E6 | `remove_entries()` with out-of-range indices silently skipped | Range safety | Matches `FileStagingStore` behavior — indices beyond list length ignored |

### Group F: SqliteStagingStore — Row-level operations — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `get_row(activity_id)` returns `{activity_id, activity_status, activity, updated_at}` dict | Core row read | Primary lookup for sync pull phase |
| F2 | `get_row(nonexistent_id)` returns `None` | Missing key semantics | Callers check for `None` to detect new-row-vs-existing |
| F3 | `put_row(row)` inserts a new row | Core row write | Row-level insert for sync push/pull |
| F4 | `put_row(row)` with existing `activity_id` upserts (overwrites) | Upsert semantics | Pull may re-insert rows that already exist locally |
| F5 | `put_row()` auto-updates `updated_at` unless explicitly provided | Timestamp control | Pulled rows carry remote timestamp; local writes get current time |
| F6 | `delete_row(activity_id)` removes the row | Row-level delete | Sync delete phase removes committed rows |
| F7 | `delete_row()` on nonexistent `activity_id` is idempotent (no-op) | Idempotent delete | Remote may send delete for already-removed row |
| F8 | `get_all_rows()` returns all rows sorted by `activity_id` | Bulk read for diff | `buildDiff()` needs full local set to compare against manifest |
| F9 | `count()` returns correct row count | Fast count | Quick size check without loading all rows |
| F10 | `get_rows_by_status(status)` filters by `activity_status` | Status-indexed query | Pull phase may filter specific statuses |
| F11 | `get_rows_by_status()` returns empty list when no rows match | Empty filter result | Must handle no-match cleanly, not None or error |
| F12 | Row-level ops and position-based ops are consistent: `put_row()`, then `read_entries()` sees it | Dual-interface consistency | Both interfaces work on same underlying table — no data divergence |

### Group G: SqliteStagingStore — Edge cases — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | Handles empty string `activity_id` gracefully (rejects or stores) | Empty PK edge | Should not crash; behavior must be documented |
| G2 | Handles very long `activity_id` (1000 chars) gracefully | Long PK edge | SQLite TEXT PK has no length limit in practice; must not truncate |
| G3 | Handles special characters in `activity_id` (`'`, `"`, `\`, `%`, `_`) — SQL-safe | SQL injection prevention | Parametrized queries must handle these without escaping bugs |
| G4 | Handles `activity_status = None` — stores as-is or rejects with clear error | Null handling | Column is NOT NULL — must reject or coerce |
| G5 | Handles `updated_at = 0` (epoch start) correctly | Boundary value | 0 is valid timestamp; LWW comparison must handle it |
| G6 | Handles `updated_at = 2**53` (JS MAX_SAFE_INTEGER boundary) correctly | Large integer | Sync between Python and JS must preserve these values |
| G7 | Concurrent reads on same store do not block or error | Read concurrency | SQLite supports multiple readers (WAL mode) |
| G8 | Corrupt database file is detected (raises `sqlite3.DatabaseError`) | Error detection | Must signal corruption, not silently return wrong data |

### Group H: Migration — staging.json → SQLite — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `migrate_staging_to_sqlite(staging_json_path, db_path)` detects `staging.json` and creates `staging.db` | Filesystem trigger | Must only run when old format exists |
| H2 | Migration reads all entries from `staging.json` via `FileStagingStore` | Input correctness | Uses existing proven reader, not ad-hoc JSON parse |
| H3 | Migration maps `entry.data.entry_id` → `activity_id` column | ID mapping | `entry_id` is the existing stable identifier |
| H4 | Migration generates new `activity_id` (10-char alphanumeric) for entries missing `entry_id` | ID generation | Backward compat with pre-entry_id ledgers |
| H5 | Migration derives `activity_status` from `is_active`/`is_paused` fields | Status mapping | active → `"active"`, paused → `"paused"`, ended → `"ended"` |
| H6 | Migration preserves the full entry `data` dict as the `activity` column (JSON-serialized) | Data preservation | No field loss — everything in the old entry survives |
| H7 | Migration sets `updated_at` from `staging.json` file mtime or current time | Timestamp seeding | Reasonable starting timestamp for LWW sync |
| H8 | Migration is idempotent — skips if `staging.db` already exists with row count > 0 | Idempotency | Must not re-migrate and create duplicates |
| H9 | Migration renames `staging.json` → `staging.json.migrated` on success | Backup preservation | Per plan: keep original as backup, don't delete |
| H10 | Migration handles empty `staging.json` (creates empty `staging.db`) | Empty input | New install or cleared staging — must not crash |
| H11 | Migration skips corrupt entries (missing `data` field) and continues | Resilience | Best-effort migration — one bad entry must not block all others |
| H12 | Migration preserves entry count: N entries in `staging.json` → N rows in `staging.db` | Completeness | All-or-nothing? No — best-effort. But successful entries must all transfer. |

### Group I: buildDiff() — LWW Resolution — ~22 tests

Pure function: `buildDiff(local_rows, remote_manifest, ledger_hash_index) → DiffResult`.
Python port of `phpoc-web/src/sync/row_sync.js:buildDiff()`.

`DiffResult`: `namedtuple('DiffResult', ['pull', 'push', 'delete_local', 'fast_path'])` where each list contains `activity_id` strings.

| ID | Input Setup | Expected DiffResult | Scenario | Rationale |
|----|-------------|---------------------|----------|-----------|
| I1 | Same row both sides, remote `updated_at` newer, status differs | `pull: [id]` | Scenario 1 | LWW: remote wins when its timestamp is newer |
| I2 | Same row both sides, local `updated_at` newer, status differs | `push: [id]` | Scenario 2 | LWW: local wins when its timestamp is newer |
| I3 | Same row both sides, same status, remote `updated_at` newer | `pull: [id]` | Scenario 3a | updated_at is the single version signal — no content hash comparison |
| I4 | Same row both sides, same status, local `updated_at` newer | `push: [id]` | Scenario 3b | Symmetric: local timestamp wins |
| I5 | Row in remote manifest, not in local | `pull: [id]` | Scenario 4 | Remote has new data this device lacks |
| I6 | Row in local, not in remote manifest, `activity_id` found in ledger hash index | `delete_local: [id]` | Scenario 5 | Committed on another device, cleaned up there — clean up locally |
| I7 | Row in local, not in remote manifest, `activity_id` NOT in hash index | `push: [id]` | Scenario 6 | Genuinely new activity, never pushed |
| I8 | All local rows committed (in hash index), remote manifest empty | `delete_local: [...all_ids], fast_path: True` | Scenario 7 | All committed elsewhere — clear staging, no network needed |
| I9 | Both local and remote empty | `pull: [], push: [], delete_local: [], fast_path: True` | Edge: both empty | Nothing to do |
| I10 | Local empty, remote has rows | `pull: [all_remote_ids]` | Scenario 4 aggregate | New device pulling all staging rows |
| I11 | Only local rows, remote empty, none committed | `push: [all_local_ids]` | Scenario 6 aggregate | First device pushing all new entries |
| I12 | Same `updated_at` on both sides, different status | `pull: [id]` (remote wins tiebreaker) | Edge: clock collision | Per plan §S3 note: "tie-break by status, remote wins" — must be deterministic |
| I13 | Same `updated_at`, same status, both sides | Empty actions, `fast_path: True` | No-op | Identical rows — nothing to do |
| I14 | 50 rows with mixed scenarios — verify every classification | Correct pull/push/delete_local for each | Stress test | Validates algorithm at realistic scale |
| I15 | `local_rows=None` | Treated as `[]` | Defensive: null local | First call before local rows loaded |
| I16 | `remote_manifest=None` or `remote_manifest.rows=None` | Treated as empty | Defensive: null remote | Network error in manifest fetch |
| I17 | `ledger_hash_index=None` | Treated as empty dict | Defensive: null index | All local-only → push (no commit detection) |
| I18 | `buildDiff()` does not mutate its input arguments | Immutability | Pure function contract — callers' data must not be modified |
| I19 | Empty string `activity_id` in manifest rows → skipped | Defensive filtering | Invalid IDs must not cause diff corruption |
| I20 | Missing `updated_at` in manifest row → treated as `0` | Default value | Malformed remote data must not crash |
| I21 | `fast_path` is `True` only when both `pull` and `push` are empty | fastPath contract | `delete_local` actions don't disable fastPath (purely local cleanup) |
| I22 | No `activity_id` appears in more than one action list | Mutual exclusion invariant | A row is pulled, pushed, or deleted — never more than one |

### Group J: Integration — SQLite store + buildDiff — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | Populate store with rows, build manifest, run `buildDiff()` → correct actions | Store→diff pipeline | End-to-end: data flows from SQLite → diff correctly |
| J2 | Pull phase simulation: apply `pull` actions (fetch + `put_row`) | Pull execution | StagingService must execute the diff results |
| J3 | Push phase simulation: extract rows for `push` actions via `get_row()` | Push extraction | Collect rows to send to Worker |
| J4 | Delete phase simulation: apply `delete_local` actions via `delete_row()` | Delete execution | Clean up committed rows |
| J5 | Full sync cycle: manifest → diff → pull → push → delete → converge | End-to-end sync | One complete sync cycle produces correct final state |
| J6 | 409 conflict simulation: re-run diff after failed push, resolves to pull | Push guard retry | Per plan: PUT 409 → re-pull manifest → re-resolve |
| J7 | `get_all_rows()` produces correct manifest format (`[{activity_id, activity_status, updated_at}]`) | Manifest generation | The SQL query IS the hash index — verify correct shape |
| J8 | Repeated sync cycles converge (idempotent — second cycle has no actions) | Convergence | After sync, another sync produces empty diff |

---

## Summary

| Group | Name | Tests |
|-------|------|-------|
| A | Schema & Lifecycle | 12 |
| B | read_entries / write_entries | 10 |
| C | append_entry | 7 |
| D | update_entry (position-based) | 7 |
| E | remove_entries (position-based) | 6 |
| F | Row-level operations | 12 |
| G | Edge cases | 8 |
| H | Migration: staging.json → SQLite | 12 |
| I | buildDiff() — LWW Resolution | 22 |
| J | Integration | 8 |
| **Total** | | **104** |

### Key coverage areas:
- **AbstractStagingStore contract:** Groups B–E cover full interface (D5, D6)
- **Row-level sync operations:** Group F covers the new sync model (D6)
- **LWW resolution:** Group I ports the JS implementation identically (D1, D4)
- **Migration safety:** Group H ensures backward compat and data preservation (D9)
- **Edge cases + concurrency:** Group G covers SQL safety, type boundaries, race conditions
- **Integration:** Group J validates the full pipeline end-to-end (D10)
