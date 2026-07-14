# F3: Skip Blob Push When Staging Unchanged — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CLI_COMMAND_TIMING_FIXES.md` §F3
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration)
> **Next Phase:** 🔜 Phase 2 (RED: test definition) — COMPLETE
> **Test file:** `tests/test_staging_sync_optimization.py` (class `TestF3SkipBlobPush`, 21 tests)

## Architecture Overview

### Current State
`_push_on_fast_path()` always calls `push_blob_only()` — even when local staging hasn't
changed since the last push. Every `check_and_sync()` fast-path hit pushes the full
staging blob (~64 KB) to R2 (~1.2s on Cloudflare Worker, 2 HTTP requests).

The flow in `_push_on_fast_path()`:
1. Pull remote blob, merge with local entries via `MergeEngine.merge()`
2. Filter out committed entries
3. Write merged entries to local store
4. **Always** call `self.push_blob_only(master_key=mk)` ← waste on no-change
5. Touch local cookie (unconditional)

`push_blob_only()` does: `self._local._store.read_entries()` → `self._remote.push(raw, ...)`.
`push_to_remote()` does the same plus a cookie push.

### Target State
Before calling `push_blob_only()` in `_push_on_fast_path()`, compute a content hash of
the current local staging entries (after merge + write). If the hash matches the
last-pushed hash stored at `<data_dir>/.last_push_hash`, skip the push. The cookie
touch still happens (session TTL extension is independent of blob push).

The hash is updated by all push paths (`push_blob_only`, `push_to_remote`, and
the push inside `_push_on_fast_path`) so any caller keeps it consistent.

Hash file format: a single JSON string `"<sha256_hex>"`.

### Modules Involved
| Module | Role | Changes |
|---|---|---|
| `domain/staging/service.py` | `StagingService` — hosts `_push_on_fast_path`, `push_blob_only`, `push_to_remote` | Add hash computation + skip logic; update hash after every push |
| `tests/test_staging_sync_optimization.py` | Existing 85-test file covering fast path behavior | Add ~21 F3 tests, Groups A–F |

### Key Design Decisions
1. **Hash file path:** `self._data_dir / ".last_push_hash"` — uses existing data directory
2. **Hash algorithm:** SHA-256 of canonical JSON of all staging entries (via existing `json.dumps(sort_keys=True)` pattern used elsewhere)
3. **Hash is computed after merge + write** in `_push_on_fast_path` — reflects the actual entries that would be pushed
4. **Fail-open:** Any error during hash computation or file I/O → push happens anyway (never skip unsafely)
5. **All push paths update the hash:** `push_blob_only`, `push_to_remote`, and the push inside `_push_on_fast_path` all write `.last_push_hash` after a successful push
6. **Empty staging:** Empty entry list hashes to a valid SHA-256 of `"[]"`

---

## Test Groups

### Group A: Hash-based Skip — Happy Path — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `_push_on_fast_path` skips `push_blob_only` when staging unchanged from last push | Core optimization: no wasted blob push on back-to-back `ph view` | The entire F3 fix — if this doesn't work, nothing else matters |
| A2 | `_push_on_fast_path` calls `push_blob_only` when staging changed (new capture since last push) | Changed staging must still push | Must not skip when data would be lost |
| A3 | `_push_on_fast_path` calls `push_blob_only` when staging changed (entry modified since last push) | Entry modifications trigger a push | Modification changes the hash, must push |
| A4 | `_push_on_fast_path` skips `push_blob_only` when merge pulls remote entries but local unchanged | Remote pull + merge that results in same local state → no push needed | Normal cross-platform scenario: web updated remote, CLI pulls and merges — if net result matches last push, skip |
| A5 | `_push_on_fast_path` calls `push_blob_only` when merge changes local entries (remote had different data) | Merge that actually changes local state → must push | Must push when real data changes occurred |

### Group B: Hash File Lifecycle — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Hash file missing (first ever push, or file deleted) → push happens normally | Cold start: no hash to compare against | First-ever call must not skip |
| B2 | Hash file contains invalid/unparseable content → push happens normally | Corrupted hash file must not block pushes | Disk corruption or partial writes are real — must degrade gracefully |
| B3 | After successful push via `_push_on_fast_path`, hash file is updated to new hash | Hash file reflects the most recent push | Without this, the next call would have a stale hash and never skip |

### Group C: Hash Update from `push_blob_only` and `push_to_remote` — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `push_blob_only` updates the last-push hash after successful push | Direct blob pushes keep hash consistent | `push_blob_only` is called from `_push_on_fast_path` AND from daemon/WAL paths — hash must stay current |
| C2 | `push_to_remote` updates the last-push hash after successful push | Cookie+blob pushes keep hash consistent | `push_to_remote` is the primary user-facing push path — must update hash |
| C3 | Hash from `push_blob_only` and `_push_on_fast_path` produce the same value for identical staging | Both push paths use the same hash computation | Consistency across all push paths prevents hash mismatches |

### Group D: `check_and_sync` Fast Path Full Integration — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Full `check_and_sync` fast path with unchanged staging: result is READY, push_blob_calls == 0, cookie touch still happens | End-to-end: the skip works through the full sync gate | Integration proof that the optimization works at the `check_and_sync()` level |
| D2 | Full `check_and_sync` fast path with changed staging: result is READY, push_blob_calls == 1, cookie touch still happens | Changed staging still pushes through full sync gate | Regression guard: the skip must not break normal push flow |
| D3 | Second `check_and_sync` fast path call after push via `push_to_remote`: push is skipped (hash matches) | Cross-caller consistency: `push_to_remote` updated hash, so next fast path correctly skips | Tests real-world pattern: user runs `ph add` (push_to_remote) then `ph view` (_push_on_fast_path) |

### Group E: Edge Cases — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Empty staging (no entries): first push happens, second `_push_on_fast_path` call skips | Empty staging hash is deterministic and stable | Edge case: staging may legitimately be empty after all entries committed |
| E2 | Hash is deterministic: same entries in different order produce same hash | Merge may reorder entries; hash must not spuriously change | Without sort_keys or equivalent, reordered entries would produce different hashes → false push |
| E3 | Hash covers entry content, not object identity: deep-equal entries produce same hash | Structural equality, not reference equality | Two different DTOs with identical fields must hash the same |
| E4 | Merge that adds then removes the same entry (net zero change) skips push | Identity operation after merge → no push | Edge case: remote push + revert cancels out, staging should match hash |

### Group F: Safety — Never Skip When It Would Lose Data — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Exception during hash computation → push happens normally (fail-open) | Hash is an optimization, not a gate | If hashing crashes for any reason, data must still go through |
| F2 | Exception during hash file write → push still completes, error is logged | Write failure must not abort the push | Disk full or permissions issue must not block staging sync |
| F3 | Hash file on read-only filesystem → push happens normally (no skip) | When hash can't be persisted, default to always-push | Prevents infinite skips if file was read from cache but can't be updated |

---

## Summary

| Group | Tests | Focus |
|-------|-------|-------|
| A — Happy path skip | 5 | Core optimization: skip on match, push on change |
| B — Hash file lifecycle | 3 | Missing, corrupt, and updated hash file |
| C — Cross-push-path consistency | 3 | `push_blob_only` / `push_to_remote` update hash |
| D — Full integration | 3 | `check_and_sync` fast path end-to-end |
| E — Edge cases | 4 | Empty staging, determinism, identity, net-zero merge |
| F — Safety (fail-open) | 3 | Exceptions and I/O failures never block push |
| **Total** | **21** | |

**Key coverage areas:**
- Hash-based skip prevents wasted blob push on unchanged staging (5 tests)
- Hash file persistence and resilience to corruption/missing files (3 tests)
- All push paths (`push_blob_only`, `push_to_remote`, `_push_on_fast_path`) keep hash consistent (3 tests)
- Full `check_and_sync` fast path integration proves end-to-end correctness (3 tests)
- Edge cases: empty staging, determinism, and identity operations (4 tests)
- Fail-open safety: no exception or I/O failure can silently drop data (3 tests)

**Test file:** `tests/test_staging_sync_optimization.py` (existing, 85 tests, Phase 2 will add new test class)

**Existing test infrastructure to reuse:**
- `TransportSpy` from `conftest.py` — tracks `push_blob_calls` count
- `svc_with_spy` fixture — provides `StagingService` wired to transport spy + cookie dir
- `make_local_cookie` / `make_remote_cookie_bytes` — cookie setup for fast path
- `DEVICE_A_UUID` constant — device identity in spy
- `TEST_MASTER_KEY` — 32-byte key for crypto operations

**Scope:** `domain/staging/service.py` — `_push_on_fast_path()` (~45 lines, one condition added before `push_blob_only` call), `push_blob_only()` (update hash after push), `push_to_remote()` (update hash after push), plus a small helper `_compute_staging_hash()` / `_save_last_push_hash()`.
