# P5: CLI Unlock Latency — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §Phase 6 — P5: CLI unlock latency
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 complete
> **Next Phase:** 🔜 Phase 2 (RED: test definition) — IN PROGRESS

## Architecture Overview

Three root causes contribute to CLI unlock latency. The primary fix (A) is changing the HTTP transport default timeout from 60s → 5s and plumbing that timeout through the service and remote sync layers so callers can override it. Secondary fixes (B, C) add reachability pre-checks and network bypass for read-only commands.

### Current State

```
main.py (CLI dispatch)
    └─ StagingService.check_and_sync(timeout_ms=500)
        └─ RemoteStagingSync.pull_cookie()              // no timeout param → transport uses 60s
            └─ transport.pull(path)                     // _DEFAULT_TIMEOUT_S = 60s
        └─ RemoteStagingSync.pull()                     // no timeout param → 60s
            └─ transport.pull(path)
        └─ RemoteStagingSync.push()                     // no timeout param → 60s
            └─ transport.push(path, data)
    └─ RemoteLedgerSync.push_blocks()                   // no timeout param → 60s
        └─ transport.list_files(prefix)
        └─ transport.push(path, data)
```

### Target State

```
main.py (CLI dispatch)
    └─ StagingService.check_and_sync(timeout_ms=500)
        └─ RemoteStagingSync.pull_cookie(timeout_ms=500)   // forwarded to transport
            └─ transport.pull(path, timeout_ms=500)        // _DEFAULT_TIMEOUT_S = 5s
        └─ ...
```

### Root Cause → Fix Mapping

| # | Root Cause | Fix | Files |
|---|-----------|-----|-------|
| A | Transport defaults to 60s; timeout not plumbed through layers | Change `_DEFAULT_TIMEOUT_S` 60→5; add `timeout_ms` params to `RemoteStagingSync`, `RemoteLedgerSync`, `StagingService` methods; propagate from `check_and_sync` | `http_transport.py`, `remote_sync.py` (staging), `remote_sync.py` (ledger), `service.py` |
| B | No pre-check before expensive cookie/blob pulls | Integrate existing `check_remote_ping()` into `check_and_sync` flow | `service.py` |
| C | Read-only commands (`ph view`, `ph list`, `ph tags`) pay full sync cost | Fast-fail or skip network when cookie TTL valid + no writes pending | `main.py`, `service.py` |

## Test Groups

### Group A: Transport Default Timeout — ~6 tests
**File:** `tests/test_http_transport_timeout.py` (new) or extend `tests/test_http_transport.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `_DEFAULT_TIMEOUT_S` equals 5.0 | Verify default changed from 60→5 | The core fix — prevents 60s hangs on unreachable remotes |
| A2 | `pull()` uses 5s socket timeout when `timeout_ms` is None | Default behavior uses new value | Confirms the default is actually applied at connection time |
| A3 | `push()` uses 5s socket timeout when `timeout_ms` is None | Same for push | All HTTP methods must use the new default |
| A4 | `list_files()` uses 5s socket timeout when `timeout_ms` is None | Same for list | Listing remote blocks is a common operation |
| A5 | `delete()` uses 5s socket timeout when `timeout_ms` is None | Same for delete | All HTTP methods covered |
| A6 | Explicit `timeout_ms=2000` overrides default to 2s | Caller override works | Must not regress — explicit timeout must be respected |

### Group B: Timeout Propagation — RemoteStagingSync — ~6 tests
**File:** `tests/test_remote_staging_sync.py` (extend)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `pull_cookie(timeout_ms=500)` passes timeout to `transport.pull()` | Timeout plumbed through staging layer | Cookie pull is the first network call on unlock |
| B2 | `pull(timeout_ms=500)` passes timeout to `transport.pull()` | Staging blob pull respects timeout | Blob pull is the largest payload — must time out fast |
| B3 | `push(timeout_ms=500)` passes timeout to `transport.push()` | Staging blob push respects timeout | Push must also be fast-failing |
| B4 | `push_cookie(timeout_ms=500)` passes timeout to `transport.push()` | Cookie push respects timeout | All remote_sync methods covered |
| B5 | Default timeout (None) uses transport default (now 5s) | Backward-compatible default | Callers that don't pass timeout get 5s not 60s |
| B6 | Timeout error from transport surfaces correctly (not swallowed) | Error propagation | Timeout must produce actionable error, not silent hang |

### Group C: Timeout Propagation — RemoteLedgerSync — ~5 tests
**File:** `tests/test_ledger_remote_sync.py` (extend)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `push_blocks(timeout_ms=500)` passes timeout to `transport.list_files()` | Ledger list respects timeout | Block listing is the first network call in ledger sync |
| C2 | `push_blocks(timeout_ms=500)` passes timeout to `transport.push()` | Ledger push respects timeout | Block pushes are large — must time out fast |
| C3 | `pull_blocks(timeout_ms=500)` passes timeout to `transport.pull()` | Ledger pull respects timeout | Pull must also fast-fail |
| C4 | `pull_index(timeout_ms=500)` passes timeout to `transport.pull()` | Index pull respects timeout | All remote ledger operations covered |
| C5 | `push_hash_index(timeout_ms=500)` passes timeout to `transport.push()` | Hash index push respects timeout | Hash index is part of fast sync detection |

### Group D: Timeout Propagation — StagingService — ~5 tests
**File:** `tests/test_staging_service.py` (extend)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `check_and_sync(timeout_ms=500)` propagates timeout to `pull_cookie()` | Top-level timeout reaches transport | This is the main entry point — the 500ms from caller must reach the wire |
| D2 | `push_to_remote(timeout_ms=500)` propagates timeout to `push()` | Push timeout propagation | Push during commit must not hang |
| D3 | `_reconcile_and_claim(timeout_ms=500)` propagates timeout to `pull()` | Auth gate timeout propagation | Reconcile during auth must be fast |
| D4 | `check_remote_ping(timeout_ms=500)` uses transport timeout | Ping uses correct timeout | Quick reachability check must actually be quick |
| D5 | Timeout raised as `RuntimeError` with clear message (not generic hang) | Error quality | User must see "timeout" not mysterious failure |

### Group E: Read-Only Command Fast Path — ~6 tests
**File:** `tests/test_main_wiring.py` (extend) or new `tests/test_cli_latency.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `ph view` with valid cookie TTL completes without remote network call | Read-only fast path | Viewing active tasks shouldn't hit the network |
| E2 | `ph list` with valid cookie TTL completes without remote network call | Same for list | Listing habits shouldn't block on network |
| E3 | `ph tags` with valid cookie TTL completes without remote network call | Same for tags | Tag queries are read-only |
| E4 | Read-only command with unreachable remote returns results from local cache | Offline resilience | Users should read local data even when offline |
| E5 | Read-only command with expired cookie TTL still gates on auth | Security: TTL enforcement | Expired session must still require re-auth |
| E6 | `ph view` with valid TTL completes in < 1s (wall-clock) | Performance baseline | The whole point — no perceptible delay |

### Group F: Regression Safety — ~4 tests
**File:** Various existing test files

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | All existing `test_http_transport.py` tests pass with new default | No transport regressions | Changing default must not break existing behavior |
| F2 | All existing `test_remote_sync.py` tests pass | No staging sync regressions | Adding timeout params must be backward-compatible |
| F3 | All existing `test_phase3_ledger_engine.py` tests pass | No ledger regressions | Ledger sync changes must not break chain verification |
| F4 | Full Python test suite (1974 tests) passes with zero regressions | Global regression safety | Final gate before merge |

## Summary

| Group | Area | Tests | File |
|-------|------|-------|------|
| A | Transport default timeout | 6 | `tests/test_http_transport_timeout.py` |
| B | RemoteStagingSync propagation | 6 | `tests/test_remote_staging_sync.py` |
| C | RemoteLedgerSync propagation | 5 | `tests/test_ledger_remote_sync.py` |
| D | StagingService propagation | 5 | `tests/test_staging_service.py` |
| E | Read-only fast path | 6 | `tests/test_cli_latency.py` |
| F | Regression safety | 4 | Various existing |

**Total: 32 assertions across 6 groups, 6 test files (3 new, 3 extended)**

### Key Coverage Areas
- Default timeout reduction (A1-A6) — the primary fix
- Timeout plumbing through all 3 layers (B, C, D) — ensures the fix reaches the wire
- Read-only fast path (E) — the user-facing benefit
- Backward compatibility (F) — no regressions
- Error propagation quality (B6, D5) — timeouts produce clear errors
