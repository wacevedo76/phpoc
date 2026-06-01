# ph view — Workflow Model

> ✅ **Tests created.** All 13 test scenarios below are implemented in `tests/test_staging_sync_optimization.py` with fixtures in `tests/conftest.py`. The `TransportSpy` records all remote calls; `cookie_dir` and helper factories set up precise cookie states.
>
> **Use this file as a checklist during implementation.** The assistant's context may be compacted multiple times as progress is made. This file is the stable reference point — it will not be compacted. Update the status markers below as each test passes. This prevents re-implementing already-working features and guards against regression.
>
> **Status markers to use:**
> - `[ ]` — Test created but failing (gap to implement)
> - `[x]` — Test passing, behavior implemented
>
> **All gaps have been closed.** The 11 gaps (marked `[ ]` below) have been resolved by changes to `domain/staging/service.py`:
>   - Fast path: blob push + 10% window cookie touch via `_push_on_fast_path()`
>   - Case A: unconditional cookie touch (keep specifier, no remote push)
>   - Case B: raw-to-DTO conversion via `_raw_entry_to_dto()` before MergeEngine
>
> **Rule: Do not modify the tests — they are the spec.** Only update the checklist markers in this file.

ph view is still not working correctly. I've thought of a model that we should think about when we use every command that works with both staging and the ledger. This model applies only to remote staging over git/http transport. When no remote is configured, all commands operate on local staging only (no sync gate needed).

## Key invariant

**Remote always reflects local.** Every time a command interacts with staging (read or write), the result is pushed to remote so the remote blob is an up-to-date copy.

**Push is a full replace.** The entire local staging array serializes and overwrites the remote blob entirely. There is no append-only or diff-based push. This eliminates the risk of partial sync or ordering errors.

**No read/write distinction.** All commands (view, list, add start, add end, pause, unpause, modify, remove, tags) follow the exact same workflow rules — no exceptions. Reads are not treated more leniently than writes.

---

## Workflow

### Step 1: TTL check (local-only, no remote needed)

Check whether this device's last interaction was within the configured TTL (default 30 minutes, configurable in `~/.phpoc/config.json` key `cookie.ttl_minutes`). This is a local file read of `device_cookie.meta` — no remote connection needed.

- **TTL is within range** (not expired) → proceed to Step 2 to check device_specifier.
- **TTL is expired** (or no local cookie exists) → skip ahead to Step 3 (authentication).

### Step 2: Device specifier check (needs remote connection)

Pull the remote cookie (`staging/blobs/device_cookie.bin`) and compare its `device_specifier` with the local cookie's `device_specifier`.

- **Specifiers match** → same device session. Fast path:
  1. Fulfill the user's command (display view, start tracking, stop tracking, etc.).
  2. **Push local staging to remote** — full replace, entire local staging array overwrites the remote blob.
  3. **Cookie touch** (specifier stays the same): Update the local cookie's `creation_time` to now so the TTL clock resets. The random `device_specifier` is **not regenerated** — it stays the same because it's still the same device. The remote cookie is **not pushed** (it already has the matching specifier). Only touch the cookie if at least 10% of the TTL has elapsed since the last cookie creation (default: 3 minutes for a 30-minute TTL). If less than 10% has elapsed, skip the touch entirely.
  4. ✅ Done — no authentication needed.

- **Specifiers don't match** (or no remote cookie exists) → fall through to Step 3 (authentication).

### Step 3: Authentication (slow path)

1. Force user to enter passphrase.
2. If passphrase is invalid — end interaction.
3. If passphrase is valid — proceed to Step 4.

### Step 4: Post-auth device specifier check (needs remote connection)

Now that the user is authenticated, pull the remote cookie and compare its `device_specifier` with the local cookie's `device_specifier`.

#### Case A — Same specifier (same device, just TTL had expired)

Local and remote staging are assumed identical up to this point because the same device wrote both. No fresh cookie needed — the specifier stays the same.

1. Fulfill the user's command (display view, start tracking, stop tracking, etc.).
2. **Push local staging to remote** — full replace, entire local staging array overwrites the remote blob.
3. **Cookie touch** (specifier stays the same): Update the local cookie's `creation_time` to now so the TTL clock resets. The random `device_specifier` is **not regenerated** — it stays the same. The remote cookie is **not pushed** (it already has the matching specifier). Unlike the fast path, there is **no 10% window check here** — the user just authenticated, so we always reset the TTL unconditionally.

#### Case B — Different specifier (different device wrote)

The user has already verified their identity via passphrase. Now reconcile the likely divergence:

1. Pull the remote staging blob.
2. Compare remote entries with local entries. Merge any differences using the `MergeEngine` (entry_id-based dedup, remote wins on ties, sorted by start_epoch).
3. Write merged entries to local staging.
4. Destroy the old remote cookie.
5. Create a new device cookie (fresh specifier, write local + push remote).
6. Fulfill the user's command.
7. **Push local staging to remote** — full replace, entire local staging array overwrites the remote blob.

---

## Decision tree

```
┌───────────────────────────┐
│      Command invoked      │
└───────────┬───────────────┘
            │
┌───────────▼───────────────┐
│  Step 1: TTL valid?       │  ← local-only, no remote
│  (check device_cookie.meta)│
└───────┬───────────┬───────┘
        │           │
     YES│           │NO (or no cookie)
        │           │
┌───────▼───────┐   │
│ Step 2:       │   │
│ Specifier     │   │
│ match?        │   │  ← needs remote
│ (pull remote  │   │
│  cookie)      │   │
└───┬───────┬───┘   │
    │       │       │
 YES│   NO  │       │
    │       │       │
┌───▼┐  ┌──▼───────▼──────────┐
│Fast│  │ Step 3: Auth        │
│path│  │ (passphrase prompt) │
└───┘  └───┬─────────────────┘
           │
      ┌────▼──────────────┐
      │ Passphrase valid? │
      └───┬──────────┬────┘
         YES│        │NO
           │        └──→ END
      ┌────▼──────────────┐
      │ Step 4: Specifier │  ← needs remote
      │ match?            │
      │ (pull remote      │
      │  cookie)          │
      └───┬──────────┬────┘
         YES│        │NO
           │        │
      ┌────▼────┐ ┌───▼──────────────┐
      │Case A   │ │ Case B           │
      │Same     │ │ Different device │
      │device   │ │ Pull + merge     │
      │Push blob│ │ New cookie       │
      │Touch TTL│ │ Push blob        │
      │(no new  │ │                  │
      │ cookie) │ │                  │
      └─────────┘ └──────────────────┘
```

---

## Test instructions

All tests go in the existing file `tests/test_staging_sync_optimization.py` (already dedicated to cookie fast-path and reconciliation). If new test fixtures are needed, add them to `tests/conftest.py`.

### Test setup

Each test that needs remote interaction should use a `RemoteStagingSync` fixture backed by a `GitStagingTransport` or `HttpStagingTransport` test double/spy. The spy records:
- Whether `pull_cookie()` was called
- Whether `pull()` (blob) was called
- Whether `push()` (blob) was called
- Whether `push_cookie()` was called
- The exact payload of each push (to verify full-replace semantics)

A local `DeviceCookie` fixture writes to a temp directory.

---

### Test 1: Fast path — TTL valid + specifiers match

- `[x]` `test_fast_path_read` — returns READY
- `[x]` `test_fast_path_no_auth_prompt` — no authentication
- `[x]` `test_fast_path_no_blob_pull` — no remote blob fetch
- `[x]` `test_fast_path_blob_push` — `push()` called exactly once with full local staging
- `[x]` `test_fast_path_cookie_specifier_unchanged` — local `device_specifier` stays same
- `[x]` `test_fast_path_no_cookie_push` — remote `push_cookie()` **not** called

---

### Test 2: Fast path — 10% window skip

- `[x]` `test_skip_touch_when_under_10pct` — `creation_time` unchanged, no cookie push
- `[x]` `test_push_still_happens_when_touch_skipped` — blob `push()` still called even when touch is skipped

---

### Test 3: Fast path — 10% window hit

- `[x]` `test_touch_happens_when_over_10pct` — `creation_time` updated to ~now
- `[x]` `test_specifier_unchanged_after_touch` — `device_specifier` unchanged
- `[x]` `test_no_cookie_push_after_touch` — remote `push_cookie()` not called

---

### Test 4: TTL expired → auth → Case A (same device)

- `[x]` `test_expired_ttl_triggers_auth` — returns REAUTH_NEEDED
- `[x]` `test_case_a_same_device_no_blob_pull` — no remote blob pull after auth
- `[x]` `test_case_a_blob_push_full_replace` — `push()` called with full local staging
- `[x]` `test_case_a_creation_time_unconditionally_updated` — `creation_time` updated unconditionally (no 10% window), `device_specifier` unchanged, no cookie push

---

### Test 5: Specifier mismatch → auth → Case B (different device)

- `[x]` `test_specifier_mismatch_triggers_reauth` — returns REAUTH_NEEDED
- `[x]` `test_case_b_after_auth_pulls_remote_blob` — remote blob pulled after auth
- `[x]` `test_case_b_merge_engine_used` — MergeEngine reconciles local vs remote entries
- `[x]` `test_case_b_new_cookie_created` — new device cookie with fresh specifier created
- `[x]` `test_case_b_cookie_pushed_to_remote` — new cookie pushed to remote
- `[x]` `test_case_b_blob_pushed_full_replace` — blob pushed after merge

---

### Test 6: No local cookie

- `[x]` `test_no_local_cookie_triggers_auth` — returns REAUTH_NEEDED
- `[x]` `test_no_local_cookie_reconcile` — pulls remote, merges, creates new cookie

---

### Test 7: No remote cookie

- `[x]` `test_no_remote_cookie_triggers_auth` — returns REAUTH_NEEDED
- `[x]` `test_no_remote_cookie_reconcile` — creates new cookie, pushes remote

---

### Test 8: Read commands follow same rules

- `[x]` `test_read_triggers_push` — blob push happens on read commands too
- `[x]` `test_read_without_auth_fast_path` — fast path works with NoAuthCryptoManager

---

### Test 9: Merge algorithm correctness

- `[x]` `test_merge_basic` — local A,B,C + remote B,C,D → A,B,C,D sorted by start_epoch
- `[x]` `test_merge_remote_wins_on_conflict` — same entry_id, same start_epoch, different description → remote wins
- `[x]` `test_merge_different_ids_both_survive` — different entry_ids both survive
- `[x]` `test_merge_empty_local` — merge with empty local works
- `[x]` `test_merge_empty_remote` — merge with empty remote works
- `[x]` `test_merge_sorted_by_start_epoch` — result sorted by start_epoch

---

### Test 10: Full replace — old remote entries removed

- `[x]` `test_old_remote_entries_replaced` — old remote entries not orphaned after full replace
- `[x]` `test_push_full_replace_semantics` — push overwrites entire remote blob

---

### Test 11: Fast path cookie touch boundary (TTL=30 min, window=180s)

- `[x]` `test_under_10pct` — 179s (<10%) → skip touch, creation_time unchanged
- `[x]` `test_at_10pct` — 180s (=10%) → touch, creation_time updated
- `[x]` `test_over_10pct` — 181s (>10%) → touch, creation_time updated

---

### Test 12: Cookie TTL configuration

- `[x]` `test_ttl_10min_under_10pct` — TTL=10min, age=59s (<10%) → skip touch
- `[x]` `test_ttl_10min_at_10pct` — TTL=10min, age=60s (=10%) → touch
- `[x]` `test_ttl_60min_under_10pct` — TTL=60min, age=359s (<10%) → skip touch
- `[x]` `test_ttl_60min_at_10pct` — TTL=60min, age=360s (=10%) → touch

---

### Test 13: No remote configured

- `[x]` `test_no_remote_returns_ready` — returns READY immediately
- `[x]` `test_no_remote_no_cookie_needed` — no cookie required in local-only mode
- `[x]` `test_no_remote_local_ops_work` — local staging operations work without remote
- `[x]` `test_no_remote_calls_never_made` — no remote calls at all

---

## Summary table

| Path | Entry condition | Remote pull? | Remote push? | Cookie action | Auth needed? |
|------|----------------|:---:|:---:|:---|:---:|
| Fast path | TTL valid + specifiers match | ❌ Skip | ✅ Full replace | Touch `creation_time` if ≥10% TTL elapsed (specifier unchanged, no remote push) | ❌ No |
| Auth A | TTL expired + specifiers match after auth | ❌ Skip | ✅ Full replace | Touch `creation_time` unconditionally (specifier unchanged, no remote push) | ✅ Yes |
| Auth B | Specifiers don't match (or no remote cookie) | ✅ Pull + merge | ✅ Full replace | Fresh cookie (destroy old, new specifier, write local + push remote) | ✅ Yes |
