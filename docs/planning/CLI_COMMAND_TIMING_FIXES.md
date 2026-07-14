# CLI Command Timing Fixes

> **Status:** ✅ F1 complete (4-phase TDD), ✅ F2 complete (4-phase TDD), 🔜 F3–F4 remaining
> **Investigation date:** 2026-07-14
> **Measured baseline:** `ph view` takes 5–10s on warm cache, ~26s on cold start (8 ledger blocks, Cloudflare Worker backend)

## Investigation Summary

`ph view` makes **16 HTTP round-trips** to the Cloudflare Worker (~300–800ms each) due to four compounding factors:

| # | Root Cause | HTTP Requests | Est. Cost | Difficulty |
|---|---|---|---|---|
| F1 | Double `check_and_sync` call (main.py + _sync_before_command) | 6 | ~3.6s | Low |
| F2 | `_sync_remote_ledger_and_dedup` pulls ALL remote blocks every invocation | 1 list + N blocks + 1 index | ~5.5s (N=8) | Medium |
| F3 | `_push_on_fast_path` pushes blob even when staging unchanged | 2 | ~1.2s | Low |
| F4 | HTTP transport: no connection reuse, 60s default timeout, sequential requests | — | overhead on all | Medium |

See full investigation in the session preceding this plan for network trace data and call-flow diagrams.

---

## Fix F1: Eliminate duplicate `check_and_sync` call

### Problem
`main.py` calls `staging_service.check_and_sync()` before `cli.view_active()`, and then `view_active()` → `_sync_before_command()` calls it again. Both do identical work: cookie pull + blob pull + blob push on fast path (3 HTTP requests each).

### Fix
Remove the `check_and_sync` call from the `view` command handler in `main.py`. The re-auth logic in `_sync_before_command` already handles `REAUTH_NEEDED` — but currently it prints a message and returns `False` (aborting). Instead, consolidate the re-auth + rebuild flow from `main.py` into `_sync_before_command` so that read commands that get `REAUTH_NEEDED` auto-handle it (matching the write-command pattern already in `main.py`).

**Scope:** `main.py` (remove call), `cli/interface.py` (consolidate re-auth in `_sync_before_command`)

### 4-Phase TDD Plan
- **Phase 1:** Blueprint tests for `_sync_before_command` re-auth flow — cover: cookie mismatch triggers login, login rebuilds staging service, second call no-ops
- **Phase 2:** RED tests in `tests/test_cli_interface.py` — mock staging service, verify `check_and_sync` called exactly once per `view_active` / `list_habits`
- **Phase 3:** GREEN — remove duplicate call from `main.py`; add re-auth auto-handling to `_sync_before_command`
- **Phase 4:** REFACTOR — ensure `main.py` view/list/tags handlers share a single sync path

---

## Fix F2: Cache remote ledger blocks across invocations

### Problem
`_sync_remote_ledger_and_dedup()` pulls every remote ledger block on every `ph view`. The 30-second in-memory cache (`_remote_ledger_cache`) is per-`CLIInterface` instance — it never survives across `ph` invocations. With 8 blocks, this is 10 HTTP requests (~5.5s). The ledger is append-only — blocks already pulled don't need re-pulling.

### Fix
Replace the in-memory cache with a persistent local cache (JSON file at `<data_dir>/remote_ledger_cache.json`). Store: `{block_index: {date, entries[{title, startTime_enc, ...}]}}` with a TTL (e.g., 60 seconds). On startup, load the cache. Only pull blocks with indices higher than the max cached index. Invalidate on explicit `ph sync`.

**Scope:** `cli/interface.py` (`_sync_remote_ledger_and_dedup` method)

### 4-Phase TDD Plan
- **Phase 1:** Blueprint tests for persistent cache — cover: cache hit skips pull, cache miss pulls all, stale cache (TTL expired) re-pulls, `ph sync` invalidates cache, partial cache (some blocks cached) pulls only missing
- **Phase 2:** RED tests in `tests/test_cli_interface.py` — mock RemoteLedgerSync, verify pull counts based on cache state
- **Phase 3:** GREEN — implement `_RemoteLedgerCache` class with file-based persistence; integrate into `_sync_remote_ledger_and_dedup`
- **Phase 4:** REFACTOR — extract cache logic into a separate module if reusable; add cache-size limit

---

## Fix F3: Skip blob push when staging is unchanged

### Problem
`_push_on_fast_path` always pulls the full remote staging blob (~64KB), merges it locally, and pushes it back — even when local staging hasn't changed since the last push. On back-to-back `ph view` calls, this is pure waste (~1.2s).

### Fix
Before pushing the blob in `_push_on_fast_path`, compute a hash of the current local staging entries. If the hash matches the last-pushed hash (stored in a small local file, e.g., `<data_dir>/.last_push_hash`), skip the blob push. Still do the cookie touch to extend TTL.

**Scope:** `domain/staging/service.py` (`_push_on_fast_path` method)

### 4-Phase TDD Plan
- **Phase 1:** Blueprint tests — cover: unchanged staging → push skipped, changed staging → push happens, hash file missing → push happens, hash file corrupted → push happens (safety)
- **Phase 2:** RED tests in `tests/test_staging_service.py` — mock remote, verify push called/not-called based on hash match
- **Phase 3:** GREEN — add `_last_push_hash` persistence to `_push_on_fast_path`
- **Phase 4:** REFACTOR — extract hash computation to a helper; ensure it's used consistently across all push paths

---

## Fix F4: HTTP connection reuse and timeout tuning

### Problem
`HttpStagingTransport` creates a new TLS connection for every `pull()`, `push()`, and `list_files()` call (16 connections per `ph view`). The default timeout is 60 seconds (irrelevant for the Worker which responds in <1s, but makes hung connections block for 60s). All requests are sequential — no parallelism.

### Fix
**(a) Connection pooling:** Replace `http.client.HTTPSConnection` per-request with a persistent connection pooled via `urllib3.PoolManager` (one connection per process, reused across requests).

**(b) Default timeout:** Reduce `_DEFAULT_TIMEOUT_S` from 60s to 10s (still generous for a Worker responding in <1s).

**(c) Parallel requests:** Where multiple independent GETs are needed (e.g., pulling all ledger blocks in `_sync_remote_ledger_and_dedup`), use `concurrent.futures.ThreadPoolExecutor` with a small pool (e.g., 4 threads) to issue requests in parallel.

**Scope:** `core/sync/http_transport.py`

### 4-Phase TDD Plan
- **Phase 1:** Blueprint tests — cover: connection reuse (second request on same transport reuses connection), timeout applies correctly, parallel pulls return in order, error in one parallel request doesn't block others
- **Phase 2:** RED tests in `tests/test_http_transport.py` — use `http.server.HTTPServer` as a local mock; measure connection count, parallelism
- **Phase 3:** GREEN — add `urllib3` pooling, reduce default timeout, add parallel pull helper
- **Phase 4:** REFACTOR — ensure backward compat with `AbstractStagingTransport`; add connection-pool lifecycle management; verify no leaks

---

## Execution Order

| Order | Fix | Rationale |
|---|---|---|
| 1 | **F1** (duplicate check_and_sync) | Fastest win, simplest change, cuts 3 HTTP requests |
| 2 | **F2** (ledger block cache) | Biggest win (eliminates up to 10 requests), medium complexity |
| 3 | **F3** (skip unchanged push) | Small win, very simple, no new dependencies |
| 4 | **F4** (HTTP pooling) | Medium win on remaining requests, carries dependency risk (urllib3) |

Each fix is independently testable and can be verified with the instrumented HTTP transport used in the investigation.

## Expected Outcome

| Metric | Before | After (all fixes) |
|---|---|---|
| Cold start `ph view` | ~26s | ~3–4s |
| Warm `ph view` (back-to-back) | ~5–10s | ~1–2s |
| HTTP requests per `ph view` (warm) | 16 | 2–4 |
| Remote blob push on no-change | Every call | Skipped |

## Next Steps

Begin with Fix F1 Phase 1: blueprint tests for `_sync_before_command` re-auth consolidation.
