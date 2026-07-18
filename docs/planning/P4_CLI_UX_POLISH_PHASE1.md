# P4 CLI UX Polish — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §Phase 6 — Audit `ph view` / `ph list` / `ph tags` for specifier-mismatch blocking
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 complete | 🔴 Phase 2 complete | 🟢 Phase 3 (implementation)
> **Next Phase:** Phase 3 (GREEN: implementation)

## Architecture Overview

Three read-only CLI commands currently have inconsistent behavior when a remote
device cookie specifier doesn't match the local device:

| Command | Code path | Re-auth handling | Uses `_sync_before_command`? |
|---------|-----------|-----------------|------------------------------|
| `ph view` | `main.py` → `cli.view_active()` → `_sync_before_command(require_auth=False)` | Auto-handle: prompts for passphrase, rebuilds everything | ✅ Yes |
| `ph list` | `main.py` → `cli.list_habits()` → `_sync_before_command(require_auth=False)` | Auto-handle: same as `ph view` | ✅ Yes |
| `ph tags` | `main.py` → own `check_and_sync` block → `_list_tags(ledger, cli)` | Separate re-auth block, exits on failure | ❌ No — bypasses `cli` |

### Current Behavior (specifier mismatch on read commands)

```
ph view / ph list:
  check_and_sync() → REAUTH_NEEDED
  → "Remote session expired — please re-authenticate."
  → auth.login() prompts for passphrase  ← BLOCKS USER
  → rebuild StagingService, LedgerEngine, CLIInterface
  → _reconcile_and_claim(mk)
  → _sync_remote_ledger_and_dedup()
  → proceed

ph tags:
  check_and_sync() → REAUTH_NEEDED
  → auth.login() prompts for passphrase  ← BLOCKS USER
  → rebuild StagingService, LedgerEngine, CLIInterface, LedgerDomain
  → _reconcile_and_claim(mk)
  → _list_tags(ledger, cli)  ← cli is unused here!
```

### Key Problems

1. **Read commands block the user** — `ph view` should show local tasks instantly
   regardless of remote state. A specifier mismatch means another device claimed
   staging — the local device should still display its cached data.

2. **`ph tags` bypasses the CLI layer** — `_list_tags()` reads `ledger.store` and
   `ledger.get_ledger_data()` directly. It never calls `_sync_before_command()`,
   never benefits from the remote ledger cache, and `cli` is passed but unused.

3. **Duplicated re-auth code** — `main.py` has three separate blocks that do the
   same rebuild dance: the `ph tags` handler (~30 lines), the `ph add` handler
   (~30 lines), and `CLIInterface._rebuild_after_reauth()` (~40 lines).

4. **No non-blocking notification** — when staging can't be synced, the user
   gets a modal passphrase prompt instead of a background notification.

### Desired Behavior

Read-only commands (`require_auth=False`) should:
- Show local data instantly (no passphrase prompt)
- Show a non-blocking notification: "Remote staging held by another device — run `ph login` to sync"
- Still use cached remote ledger data when available
- Not attempt to claim remote staging

## Test Groups

### Group A: `ph tags` code-path unification — ~5 tests
**File:** `tests/test_cli_interface.py` (extend) + `tests/test_tags.py` (extend)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `ph tags` handler calls `cli._sync_before_command()` before listing tags | Unify sync pattern | All three read commands use the same code path — no more divergent behavior |
| A2 | `_list_tags` accepts a `CLIInterface` instance and uses its staging/ledger accessors | Eliminate bypass | Tags listing goes through the same data pipeline as view/list — benefits from remote cache |
| A3 | `ph tags` handler does NOT contain its own duplicate `check_and_sync` / rebuild block | Remove duplication | The ~30-line re-auth block in `main.py` tags handler is removed |
| A4 | Tags from remote-committed entries (in `_remote_ledger_cache`) appear in `ph tags` | Cache benefit | If another device committed an entry with tag `@new-tag`, `ph tags` shows it |
| A5 | `ph tags` after `_sync_before_command` includes tags from the synced+deduped staging | Correctness | Tags from entries that were removed from staging (already committed) still appear from ledger |

### Group B: Read-only commands don't block on specifier mismatch — ~6 tests
**File:** `tests/test_cli_interface.py` (extend)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `_sync_before_command(require_auth=False)` returns True without prompting when REAUTH_NEEDED | Non-blocking read path | The core fix — read commands must not block the user |
| B2 | `ph view` with REAUTH_NEEDED shows local active tasks (no passphrase prompt) | User-facing view | Viewing active tasks must be instant regardless of remote state |
| B3 | `ph list all` with REAUTH_NEEDED shows local data (no passphrase prompt) | User-facing list | Listing habits must work offline / specifier-mismatch |
| B4 | `ph tags` with REAUTH_NEEDED shows local tags (no passphrase prompt) | User-facing tags | Tag queries are read-only, must never block |
| B5 | Read commands show a non-blocking notification about stale/mismatched session | User awareness | User sees "Remote session expired — showing local data. Run ph login to sync." without being blocked |
| B6 | NoAuth fallback works for all three read commands when no cached session AND REAUTH_NEEDED | Auth edge case | Even without a cached key, the user should see their `plain:` staging data |

### Group C: Error message consistency — ~4 tests
**File:** `tests/test_cli_interface.py` (extend)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `ph view`, `ph list`, and `ph tags` produce the same non-blocking notification text for REAUTH_NEEDED | Consistency | User shouldn't see three different messages for the same condition |
| C2 | No remote config → no sync attempt, no error message (all three commands) | Clean skip | Local-only users shouldn't see network errors |
| C3 | Offline remote → graceful "Remote unreachable — showing local data" message | Degradation | Network failures shouldn't look like auth failures |
| C4 | Expired cookie shows "session expired" vs specifier mismatch shows "different device" — distinct messages | Diagnostic clarity | User needs to know *why* their data might be stale |

### Group D: Regression tests — ~5 tests
**File:** `tests/test_cli_interface.py` (extend) + `tests/test_tags.py` (extend)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `ph view` with valid cookie still works correctly (active tasks shown) | No regression | Existing behavior preserved when everything is fine |
| D2 | `ph list all|synced|staged` with valid cookie still works | No regression | Date filtering, spanning entries, dedup still correct |
| D3 | `ph tags` with valid cookie returns correct deduplicated tags from staging + ledger | No regression | Tag listing correctness unchanged |
| D4 | `ph list active` shows active tasks (same as `ph view`) | No regression | Alias behavior preserved |
| D5 | Write commands (`ph add`, `ph sync`) still require auth on specifier mismatch | Write path unchanged | `require_auth=True` path must NOT change — writes still block |

### Group E: Edge cases — ~4 tests
**File:** `tests/test_cli_interface.py` (extend)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Consecutive read commands after REAUTH_NEEDED don't show duplicate notifications | UX polish | Running `ph view` twice shouldn't spam the user with the same message |
| E2 | `ph tags` with no staging and no ledger entries shows "No tags found." (no error) | Empty state | Clean output for new ledgers |
| E3 | Mixed encrypted/plain staging entries — tags from plain entries still listed in NoAuth mode | Partial visibility | Even without MK, `plain:` prefixed staging tags should appear |
| E4 | `_sync_before_command(require_auth=False)` still calls `_sync_remote_ledger_and_dedup` when READY | Cache path preserved | The fast path (same device, valid cookie) still works the same way |

## Summary

| Group | Area | Tests | File |
|-------|------|-------|------|
| A | `ph tags` code-path unification | 5 | `tests/test_cli_interface.py`, `tests/test_tags.py` |
| B | Non-blocking read commands | 6 | `tests/test_cli_interface.py` |
| C | Error message consistency | 4 | `tests/test_cli_interface.py` |
| D | Regression | 5 | `tests/test_cli_interface.py`, `tests/test_tags.py` |
| E | Edge cases | 4 | `tests/test_cli_interface.py` |

**Total: 24 assertions across 5 groups, 2 test files (extended)**

### Key Coverage Areas
- Specifier-mismatch non-blocking (B1–B4, E1) — the core task
- `ph tags` unification (A1–A5) — eliminates divergent code path
- Error message consistency (C1–C4) — UX polish
- Regression safety (D1–D5) — no breakage
- Edge cases (E1–E4) — empty state, partial visibility, notification dedup
