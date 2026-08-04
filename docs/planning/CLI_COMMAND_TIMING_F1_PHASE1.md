# F1 — Remove duplicate check_and_sync — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CLI_COMMAND_TIMING_FIXES.md` §Fix F1
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Complete (Phases 1–4 done)
> **Phase 4:** Extracted `_rebuild_after_reauth()` helper; simplified auto-handle block

## Architecture Overview

**Problem:** `ph view` calls `check_and_sync` twice — once in `main.py` (to handle
REAUTH_NEEDED) and once inside `CLIInterface._sync_before_command()`. This wastes
~3.6s (6 HTTP round-trips: cookie pull + blob pull + blob push × 2). The same
pattern affects `ph list active` and `ph list all|synced|staged`.

**Fix:** Move the re-auth + rebuild flow from `main.py` into
`_sync_before_command(require_auth=False)`. Currently it just prints a message
and returns `False` for read commands. After the fix, it auto-handles
`REAUTH_NEEDED`: calls `auth.login()`, rebuilds `StagingService`, runs
`_reconcile_and_claim()`, and returns `True` so the command continues. Then the
duplicate `check_and_sync` + re-auth blocks in `main.py` are removed.

**Modules:**

```
main.py                              phpoc_cli/interface.py
┌─────────────────────────┐          ┌──────────────────────────────────┐
│ view command handler     │          │ CLIInterface                     │
│                          │          │                                  │
│  check_and_sync()  ←──REMOVE      │  _sync_before_command()          │
│  re-auth + rebuild  ←──REMOVE      │    check_and_sync()  ←─ KEEP    │
│                                  │    on REAUTH_NEEDED:              │
│  cli.view_active() ──────────────→│      login + rebuild + claim     │
│                  │                │                                  │
│                  └────────────────→│  view_active()                   │
│                  └────────────────→│  list_habits()                   │
└─────────────────────────┘          └──────────────────────────────────┘
```

**Scope:** `main.py` (remove duplicate calls), `phpoc_cli/interface.py` (consolidate
re-auth in `_sync_before_command` for `require_auth=False`).

## Test Groups

### Group A: `_sync_before_command` — Normal Paths ~3 tests

Verify `_sync_before_command` works correctly when no re-auth is needed.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Returns True with no remote transport configured | Local-only mode works without sync | Guards the no-remote short-circuit path |
| A2 | Returns True when check_and_sync returns READY | Cookie match → fast path, no re-auth | Tests the most common (warm cache) path |
| A3 | Returns True when check_and_sync returns OFFLINE | Remote unreachable → continue with local | Ensures commands don't block on network issues |

### Group B: `_sync_before_command` — REAUTH Auto-Handle (require_auth=False) ~6 tests

The core change: when `check_and_sync` returns `REAUTH_NEEDED` and
`require_auth=False` (read commands), `_sync_before_command` auto-handles
re-auth instead of aborting.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | REAUTH_NEEDED → calls auth.login(), returns True | Auto-handles re-auth for read commands | Main behavior change — replaces the main.py re-auth block |
| B2 | REAUTH_NEEDED with failed login → returns False | Aborts when user cancels auth | Preserves the existing abort path from main.py |
| B3 | After re-auth, StagingService is rebuilt with fresh crypto | Re-auth invalidates old staging service | Matches main.py pattern: `StagingService(crypto=fresh_crypto, …)` |
| B4 | After re-auth, _reconcile_and_claim() is called | Claims remote staging for this device | Cookie pull/push cycle after re-auth |
| B5 | After re-auth, _sync_remote_ledger_and_dedup() is called | Syncs ledger blocks after staging sync | READY path calls this; re-auth path should too |
| B6 | After re-auth when _reconcile_and_claim returns OFFLINE → returns True | Continues with local data if remote post-re-auth | Resilient: network failure after re-auth doesn't block command |
| B7 | REAUTH_NEEDED prints a message about re-authentication | User gets feedback during auto-handle | UX: user knows why they're being prompted |

### Group C: `_sync_before_command` — require_auth=True (Write Commands, Unchanged) ~3 tests

Write commands (`ph add`, `ph sync`, etc.) must NOT auto-handle re-auth —
the main.py handler for each command does that itself.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | REAUTH_NEEDED with require_auth=True → returns False, no auto-handle | Write commands keep their own re-auth flow | Prevents duplicate re-auth in write commands |
| C2 | REAUTH_NEEDED with require_auth=True → prints "held by a different device" message | User gets actionable message | UX: write commands should explain why they're blocked |
| C3 | READY with require_auth=True → returns True, calls _sync_remote_ledger_and_dedup | Normal path for write commands | Verifies write-command sync is unchanged |

### Group D: check_and_sync Called Exactly Once per Read Method ~3 tests

The proof that the duplicate is eliminated: `view_active()` and `list_habits()`
call `check_and_sync` exactly once (via `_sync_before_command`).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | view_active() calls check_and_sync exactly once | Duplicate eliminated from view path | The primary bug fix — `ph view` was the worst offender |
| D2 | list_habits() calls check_and_sync exactly once | Duplicate eliminated from list path | `ph list all|synced|staged` also duplicated |
| D3 | view_active() still works after removal of main.py duplicate | No regression in behavior | Integration: output is correct, entries are displayed |

### Group E: Write Command Paths Unchanged (Regression) ~4 tests

Write commands (`add`, `sync`, `modify`, `remove`) in `main.py` still call
`check_and_sync` once directly — these are NOT duplicated and should not change.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | add_oneoff() calls _sync_before_command(require_auth=True) | Write path uses require_auth=True | Write commands must not auto-handle re-auth |
| E2 | add_start() calls _sync_before_command(require_auth=True) | Same as E1 for start | Consistency across write paths |
| E3 | add_end() calls _sync_before_command(require_auth=True) | Same as E1 for end | Consistency across write paths |
| E4 | add_pause() / add_unpause() call _sync_before_command(require_auth=True) | Same for pause/unpause | Full coverage of write methods |

### Group F: main.py Read Command Handler Cleanup ~3 tests

These are design-constraint assertions — verified at the integration level
rather than unit tests.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `ph view` handler no longer calls check_and_sync directly before cli.view_active() | Duplicate removed from main.py | The root cause fix |
| F2 | `ph list active` handler no longer calls check_and_sync directly before cli.view_active() | Duplicate removed from list active path | Same pattern as view |
| F3 | `ph list all|synced|staged` handler no longer calls check_and_sync directly before cli.list_habits() | Duplicate removed from list path | Same pattern as view |

## Summary

| Group | Tests | Focus |
|-------|-------|-------|
| A — Normal paths | 3 | READY, OFFLINE, no-transport |
| B — REAUTH auto-handle | 7 | Core fix: login + rebuild + claim |
| C — require_auth=True | 3 | Write commands unchanged |
| D — check_and_sync count | 3 | Duplicate elimination proof |
| E — Write paths unchanged | 4 | Regression guard |
| F — main.py cleanup | 3 | Design constraint verification |
| **Total** | **23** | |

**Key coverage areas:**
- `_sync_before_command` auto-handles REAUTH_NEEDED for reads (7 tests)
- `check_and_sync` called exactly once per read method (3 tests)
- Write commands unchanged and not broken (4 tests)
- Write `require_auth=True` still blocks for caller handling (3 tests)
- Normal fast-path and offline resilience (3 tests)
- `main.py` integration checks (3 tests)

**Test file:** `tests/test_cli_interface.py` (created — Phase 2, 24 tests across 6 groups)

**Existing test infrastructure to reuse:**
- `MagicMock` pattern from `test_phase6c_orchestrator_cli.py`
- `TransportSpy` from `conftest.py` for remote simulation
- `TEST_MASTER_KEY` constant pattern from existing tests
