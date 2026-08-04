# F2: Persistent Cache for Remote Ledger Blocks — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CLI_COMMAND_TIMING_FIXES.md` §F2
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Complete (Phases 1–4)
> **Refactor (P4):** Extracted `_apply_cached_ledger_data()` + `_get_remote_ledger_cache_path()`, eliminated ~15 duplicated lines

## Architecture Overview

### Current State (in-memory cache)
`CLIInterface._sync_remote_ledger_and_dedup()` pulls ALL remote ledger blocks every invocation
unless a 30-second in-memory TTL (`_remote_ledger_cache_time`) has not expired. The cache
(`_remote_ledger_cache`) is a dict keyed by `(date_str, title)` → entry data — it dies with
the Python process, so back-to-back `ph view` calls each do a full pull.

The pull flow:
1. Get `RemoteLedgerSync(transport, mk)`
2. `_list_remote_block_indices()` → set of block indices on R2
3. For each index: `pull_block_by_index(idx)` → parse entries
4. Build `committed_titles: {(date, title): count}` for dedup
5. Build `remote_entries: {(date, title): data}` for display
6. Call `_remove_committed_from_staging(committed_titles)`
7. Pull + merge remote index

### Target State (persistent file cache)
Introduce `_RemoteLedgerCache` class backed by `<data_dir>/remote_ledger_cache.json`.
On each invocation:
1. Load cache from file
2. If fresh (TTL not expired), reconstruct `committed_titles` + `remote_entries` from cached blocks → use for dedup + display without any HTTP requests
3. If stale or missing, pull only blocks with indices > max cached index, merge into cache, save to file

Cache file structure:
```json
{
  "max_block_index": 5,
  "last_pull_time": 1718912345.0,
  "remote_index": { "2026-07-01": { "Coding": 7200000 } },
  "blocks": {
    "0": { "date": "2026-07-01", "entries": [{"title": "Coding", "startTime_enc": "plain:...", ...}] },
    "1": { "date": "2026-07-02", "entries": [...] }
  }
}
```

TTL: 60 seconds. Cache is invalidated on explicit `ph sync` or re-auth.

### Modules Involved
| Module | Role | Changes |
|---|---|---|
| `phpoc_cli/interface.py` | `CLIInterface` — hosts `_sync_remote_ledger_and_dedup()` + `list_habits()` | Add `_RemoteLedgerCache`, refactor `_sync_remote_ledger_and_dedup` to use it |
| `domain/ledger/remote_sync.py` | `RemoteLedgerSync` — already provides `_list_remote_block_indices()`, `pull_block_by_index()`, `pull_index()` | No changes (already testable) |
| `main.py` | Passes `data_dir` — accessible via `self._staging._data_dir` | No changes |
| `tests/test_cli_interface.py` | Existing test file — 24 F1 tests, Groups A–F | Add ~23 F2 tests, Groups A–F |

### Key Design Decisions
1. **Cache file path:** `self._staging._data_dir / remote_ledger_cache.json` — uses existing data directory
2. **Cache stores raw block data** (not derived `committed_titles`/`remote_entries`) so reconstruction is always possible
3. **Partial pull:** Only pull blocks with `index > max_block_index` in cache
4. **TTL:** 60 seconds — longer than the current 30s in-memory TTL because file persistence means it's safe to keep longer
5. **Graceful degradation:** Corrupt/missing/unwritable cache file → fall back to full pull (same as current behavior)
6. **Explicit invalidation:** `ph sync` → call `cache.invalidate()` → next pull gets everything fresh

---

## Test Groups

### Group A: Persistent Cache — File Read/Write — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `_RemoteLedgerCache.save()` creates `remote_ledger_cache.json` in data_dir with expected structure | Verify the cache writes a valid JSON file | Foundation — all cache-hit logic depends on file existing and being parseable |
| A2 | `_RemoteLedgerCache.load()` reads previously saved data and returns matching block entries | Round-trip integrity: save → load yields same data | Without this, cache hits would reconstruct wrong data |
| A3 | `_RemoteLedgerCache.load()` returns empty state when cache file does not exist (cold start) | Graceful first-run behavior | Cold start must fall through to full pull, not crash |
| A4 | `_RemoteLedgerCache.load()` returns empty state when cache file contains invalid JSON | Corrupted files must not crash the CLI | Disk corruption or partial writes are real — must degrade gracefully |
| A5 | Write error during `save()` is caught and logged, not propagated to caller | Cache is a performance optimization, not a correctness dependency | If the disk is full, the CLI must still work (just slower) |

### Group B: Cache Hit — Skip Remote Pulls — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | When cache is fresh (TTL not expired) and contains all remote blocks, `pull_block_by_index` is called zero times | The core F2 win: eliminate all ledger-block HTTP requests on warm cache | This is the ~5.5s savings — if this doesn't work, F2 is worthless |
| B2 | On cache hit, `_remove_committed_from_staging()` is called with `committed_titles` correctly reconstructed from cached blocks | Dedup must still work even when blocks aren't freshly pulled | Cached data must produce the same dedup behavior as freshly pulled data |
| B3 | On cache hit, `list_habits` synced section includes entries from the cached `remote_entries` display data | Display functionality must work from cache | The cache must serve both dedup and display purposes |
| B4 | On cache hit, `_merge_remote_index()` merges the cached `remote_index` into the local index | Blind index must stay up-to-date without re-pulling | Remote index affects `ph rep` output — must not regress |

### Group C: Cache Miss / Partial — Pull Missing Blocks — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | No cache file (cold start) → pulls all remote block indices | Full pull on first run | First run after deploy must work exactly like current behavior |
| C2 | Cache has blocks 0–3 but remote has blocks 0–5 → only pulls blocks 4 and 5 | Partial pull: the incremental efficiency mechanism | This is the second-biggest win — warm-but-growing chains don't re-pull old blocks |
| C3 | Cache is empty (max_block_index = -1) but remote has blocks → pulls all indices | Empty-cache edge case equivalent to cold start | Distinct from file-not-found (A3) — cache exists but has no blocks |
| C4 | After pulling new blocks, `save()` updates cache file with new blocks and new `max_block_index` | Cache stays current for subsequent invocations | Without this, every invocation re-pulls previously pulled blocks |
| C5 | Cache has blocks for indices 0–5 but remote has only indices 0–3 (blocks deleted/cleared) → no error, just picks up at index 4+ | Remote state can regress — must not crash | Edge case: remote cleanup, new ledger created, or blocks manually deleted |

### Group D: TTL Expiry — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Cache exists but `last_pull_time` is older than TTL → triggers full re-pull of all indices | Freshness enforcement | Stale cache must not prevent seeing new remote data |
| D2 | Cache exists and `last_pull_time` is within TTL → no pull, cache hit path used | Healthy cache path | The 60s TTL is the boundary — must be precise |
| D3 | Cache exactly at TTL boundary (e.g., 59.9s) → still treated as fresh (non-strict comparison) | Off-by-one prevention | Timestamp comparisons must be `>=` not `>` to avoid flaky boundary failures |

### Group E: Cache Invalidation — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | After calling `cache.invalidate()`, next `_sync_remote_ledger_and_dedup()` pulls all blocks (ignores cached data) | Explicit invalidation for `ph sync` | Users must be able to force a full refresh |
| E2 | After `_rebuild_after_reauth()`, cache is invalidated (remote state may have changed under different device identity) | Re-auth changes the crypto context — cache may be from a different identity | Safety: never trust cached data after identity change |
| E3 | New `CLIInterface` instance (simulating separate `ph` invocation) loads cache from file and uses it | Cross-invocation persistence | The whole point of F2 — cache survives process exit |

### Group F: Integration — End-to-End — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Two consecutive `_sync_before_command()` calls on same instance: first pulls all, second uses cache hit (zero additional pulls) | The primary user-facing win: back-to-back `ph view` is instant | Verifies the full flow from init → pull → cache → hit |
| F2 | After cache-populating pull, `list_habits(source='all')` includes remote entries from cache in synced section | End-to-end display integration | The cache must feed into the actual user-facing output |
| F3 | Stale cache (expired TTL) → `_sync_remote_ledger_and_dedup()` repulls, updates cache, then dedup runs on fresh data | End-to-end stale→fresh transition | Verifies the full lifecycle: cache expires → pull → update → use |

---

## Summary

| Group | Count | Focus |
|---|---|---|
| A — File Read/Write | 5 | Cache persistence layer: create, load, missing, corrupt, write-error |
| B — Cache Hit | 4 | Skip pulls, reconstruct dedup + display data, merge index |
| C — Cache Miss / Partial | 5 | Cold start, partial pull, incremental update, remote regression safety |
| D — TTL Expiry | 3 | Freshness boundary, stale re-pull, boundary precision |
| E — Invalidation | 3 | Explicit invalidation, re-auth clearing, cross-instance persistence |
| F — Integration | 3 | End-to-end: consecutive calls, display integration, stale→fresh lifecycle |
| **Total** | **23** | |

### Key Coverage Areas
- **Persistence:** File I/O with graceful degradation (A1–A5, E3)
- **Performance:** Cache-hit eliminates HTTP (B1), partial pull minimizes HTTP (C2)
- **Correctness:** Dedup (B2), display (B3, F2), index merge (B4) all work from cached data
- **Safety:** TTL enforcement (D1–D3), re-auth invalidation (E2), remote regression (C5)
- **End-to-end:** Full user-facing flow works (F1–F3)

### Dependencies
- `domain/ledger/remote_sync.RemoteLedgerSync` — already provides `_list_remote_block_indices()`, `pull_block_by_index()`, `pull_index()`
- `phpoc_cli/interface.CLIInterface` — hosts the cache; needs `_staging._data_dir` for file path
- Mocking: `RemoteLedgerSync`, `StagingService`, `LedgerEngine` — same patterns as F1 tests
