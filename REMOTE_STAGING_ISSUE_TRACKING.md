# Remote Staging Issue Tracking

This document captures issues found during cross-device staging sync testing between
**debagent04** (pi@debagent04, device_id: `bbb3badc-...`) and **x13 laptop**
(wacevedo@x13, device_id: `dc1da321-...`).

## Environment

| Property | debagent04 | x13 laptop |
|---|---|---|
| Device ID | `bbb3badc-6365-49ea-b43c-53869ca0195f` | `dc1da321-2c80-4815-a808-11295b8c59f9` |
| Code branch | `P3-Remote_Sync` | `P3-Remote_Sync` |
| Commit | `76209c0` | `76209c0` (pushed to origin) |
| Data dir | `~/.local/share/phpoc/` | `~/.local/share/phpoc/` |
| Config dir | `~/.config/phpoc/` | `~/.config/phpoc/` |
| Remote clone | `~/.local/share/phpoc/remote/` | `~/.local/share/phpoc/remote/` |
| Remote URL | `git@github.com:wacevedo76/phpoc-staging.git` | same |
| Passphrase | 🟢 **Updated** (via `ph recover`) | 🟢 **Updated** (via `ph recover`) |

## Issues Found

### Issue #15: Stale-remote resurrection — check_and_sync in write methods re-introduces ended tasks

**Status:** ✅ Fixed (2026-05-25, commit `8b5a529`)
**Fix:** Removed `self.check_and_sync(timeout_ms=500)` from all 6 write methods in `StagingService`
(`capture`, `end`, `pause`, `unpause`, `modify`, `remove`).

**Root cause:** Every write method called `check_and_sync()` at the top, which pulled the
stale remote blob (background push hadn't completed yet) and merged it with `MergeEngine`
where **remote always wins on same entry_id** (`merge_engine.py` line 49: `seen[key] =
entry_copy` for remote entries). This resurrected tasks the user had just ended, creating
an infinite cycle:

```
ph end 1 → ends Working on Phpoc → check_and_sync merges stale remote blob
         → remote still has Working on Phpoc active → remote wins → resurrected!
ph view  → shows both tasks active (ended task came back)
ph end 1 → ends other task → check_and_sync resurrects again...
```

**Fix rationale:** Phase B WAL + background push handles crash safety. Phase C daemon
handles periodic sync. `check_and_sync()` is still called from `ph sync remote_staging`
and the daemon event loop.

**Test updates:** `TestEveryCommandSync` now asserts `check_and_sync` is NOT called from
write methods. Auth expiry tests use `NoAuthCryptoManager` to bypass the isinstance check.
336 tests passing.

### Issue #13: _last_auth_time = 0.0 causes false REAUTH_NEEDED after ph login

**Status:** ✅ Fixed (2026-05-22)
**Fix:** `check_and_sync()` in `service.py` now checks `isinstance(self._crypto, NoAuthCryptoManager)`
when auth cache is expired. A real `CryptoManager` means the process invocation already
authenticated (via `ph login` or the lazy auth gate in `main.py`), so it sets
`_last_auth_time = time.time()` and proceeds with the merge instead of returning
`REAUTH_NEEDED`.

**Root cause:** `_last_auth_time` is initialized to `0.0` in `StagingService.__init__()`
and only updated inside `check_and_sync()` on successful device check. After `ph login`
populates the session cache and `main.py` creates a `CryptoManager` with the key, the
staging service has no way to know auth just happened. First cross-device `check_and_sync()`
computes `time.time() - 0.0` which is always `> AUTH_CACHE_DURATION`, so it incorrectly
returns `REAUTH_NEEDED`.

**Files modified:** `domain/staging/service.py`

**Trace before fix:**
```
check_and_sync()  → REAUTH_NEEDED  (session cache valid, but _last_auth_time = 0.0)
```

**Trace after fix:**
```
check_and_sync()  → READY  (CryptoManager detected, _last_auth_time set, merge proceeds)
```

### Issue #1: Detached HEAD after push rejection → divergent histories

**Status:** ✅ Fixed (commit `c7f3363`)
**Fix:** `_push_or_detached_refspec()` helper falls back to `git push origin HEAD:refs/heads/main`
when HEAD is detached. `_ensure_on_branch()` now tries 3 strategies.

**Trace:**
```
Failed to re-attach HEAD to main
→ git push → non-fast-forward rejected
→ pull --rebase → detached HEAD
→ _ensure_on_branch fails
→ commit on detached HEAD
→ git push → "not currently on a branch"
```

**Symptoms:** Remote clone stuck, divergent `main` and `origin/main` histories.

### Issue #2: ph view bypasses check_and_sync (read-only path skips device check)

**Status:** ✅ Fixed (2026-05-22)
**Fix:** `view_active()` in `cli/interface.py` now calls `self._staging.check_and_sync()`
instead of direct `_remote.pull()` + merge. This routes `ph view` through the canonical
sync entry point (device check, auth gate, pull+merge). Surfaces `SyncCheckResult.REAUTH_NEEDED`
errors instead of silently swallowing them.

**Files modified:** `cli/interface.py`

### Issue #3: _needs_full_pull freshness optimization

**Status:** ❓ Needs investigation
**Assigned to:** x13 agent
**Current behavior** (verified in code at `service.py:367-395`):
- `_needs_full_pull()` returns `True` when `remote_id != local_id` — different device
  always triggers a full pull. Correct.
- `_needs_full_pull()` returns `True` when `remote_updated_at > _last_push_at` —
  remote is newer. Correct.
- `_needs_full_pull()` returns `False` only for same-device, local-is-freshest case.
  Correct.

**Cross-device write flow is NOT incorrectly skipped** because the device-ID check
happens before the freshness check. The only concern is whether `_needs_full_pull()`
is called at all (Issue #2's view bypass) — which is being fixed.

**Consideration: content-aware sync (active-activity check)**
Instead of the coarse "pull everything or skip" binary, could diff entries by
`entry_id` and only merge the delta:

```python
def _diff_entries(local, remote):
    local_ids = {e["entry_id"] for e in local if e.get("entry_id")}
    remote_ids = {e.get("entry_id") for e in remote if e.get("entry_id")}
    new_ids = remote_ids - local_ids
    modified_ids = {
        eid for eid in local_ids & remote_ids
        if lookup_hash(local, eid) != lookup_hash(remote, eid)
    }
    return bool(new_ids or modified_ids)
```

However, diminishing returns apply: the git `pull` already fetched the blob by
this point. The savings would be in the merge step (~10ms), not the network step
(~2.5s). The much bigger savings target is the redundant `ls-remote` calls (see
AFI #2).

### Issue #4: plain: prefix entries (NoAuth path) lack entry_id

**Status:** ℹ️ No action needed — code handles correctly
**Resolution analysis:** After reading the code, both `append()` and `write_entries()`
in `local_cache.py` always generate `entry_id = str(uuid.uuid4())` when none exists.

- `append()` (line 216): always sets `"entry_id": str(uuid.uuid4())` on new entries
- `write_entries()` (line 149): sets `entry.get("entry_id", str(uuid.uuid4()))` —
  fills in UUID for any legacy entry that lacks one

So even entries created via `NoAuthCryptoManager` get a UUID the moment they pass
through `write_entries()` (happens on every merge or update). The original observation
of `entry_id: ""` was from before the stable-entry-ID feature landed.

**Cross-device `end` by title also works correctly:** The `end()` method searches
local entries by `title + is_active`. If both Device A and Device B started "Work",
each has a local entry with their own `start_epoch`. `end "Work"` on Device B ends
B's local entry only. After merge/push, Device A sees two separate "Work" entries
(one running, one ended) — correctly handled by the `(title, start_epoch)` fallback
dedup in `MergeEngine._dedup_key()`.

### Issue #5: Session cache is 32 raw bytes in /dev/shm

**Status:** ℹ️ Works but fragile
**Detail:** `/dev/shm/phpoc_session` stores the master key as 32 raw bytes (not hex-encoded).
The session read code handles this correctly. No issue, just documented for awareness.

## 🔴 Security Incident: Passphrase & Master Key Exposure

**Date:** 2026-05-22
**Severity:** Critical

### What happened

The passphrase `m0r3m0n3y` was accidentally committed to `P3-Remote_Sync` in two pushed
commits (`1c1e1f2`, `4533af8`) via `REMOTE_STAGING_ISSUE_TRACKING.md` and
`SESSION_HANDOFF.md`. Additionally, `staging_log/` trace files captured the 32-byte
master encryption key (which is the decoded recovery seed) in cleartext and were
tracked in git.

### Why it matters
- Master key = `base64_decode(recovery_seed)` — they are the same entropy
- Anyone with the master key bytes can trivially derive the recovery seed
- Passphrase alone is insufficient (needs encrypted seed from local ledger file)

### Remediation
1. **Interactive rebase** from `22ae407` — rewrote all 7 commits on `P3-Remote_Sync`
   - Passphrase replaced with `PASSPHRASE_REDACTED` in commits `1c1e1f2` / `4533af8`
2. **Trace logs stripped** from commits `c764bea` (was 93236d5) and `613b32e` (was 2c2f0d7)
3. **`.gitignore`** updated — `staging_log/` added (initial remediation)
4. **Force-pushed** to origin — clean history live
5. **Passphrase retired** — new passphrase set via `ph recover` on both devices (2026-05-22)

### Post-remediation (2026-05-22)
6. **Master key redaction** added to `cli/trace.py` — `_redact()` masks 32-byte keys
   and sensitive kwargs (`master_key`, `passphrase`, `secret`, `seed`, `password`)
7. **`.gitignore` restored** — `staging_log/` entry removed since trace logs no longer
   contain master key bytes

### Residual risk
- Old commit hashes still accessible via direct GitHub URL
- Contact GitHub Support to purge objects from their storage (optional)
- Trace logs may still contain `passphrase` strings if inadvertently included in
  method arguments — all known sensitive kwargs are now redacted

## Instrumentation: Trace Logging

**Status:** ✅ Secure — master key redacted, `staging_log/` removed from `.gitignore`

A trace-logging wrapper was added across the call chain to gain visibility into the
cross-device sync flow. All trace output goes to files in `staging_log/`, enabled via
the `PHPOC_TRACE=1` environment variable or `debug.trace_enabled` config key.

### Security fix: sensitive-parameter redaction (2026-05-22)

The `@trace` decorator now redacts sensitive values from log output via `_redact()`:
- Any kwarg named `master_key`, `passphrase`, `password`, `secret`, or `seed` → `<REDACTED>`
- Any positional arg that is a 32-byte value (`bytes` of length 32) → `<32-byte-key REDACTED>`
- Return values that are 32-byte keys are also redacted

Because of this redaction, `staging_log/` was **removed from `.gitignore`** — trace
files are now safe to commit. The old `.gitignore` entry was:
```
staging_log/
```

### Files created / modified
- **`cli/trace.py`** — Lightweight `@trace` decorator with `_redact()` redaction.
  Added `enable_tracing()` / `disable_tracing()` for programmatic control.
  Toggled via `PHPOC_TRACE=1` env var or `debug.trace_enabled` config key.
- **`security/config_manager.py`** — Added `debug.trace_enabled` default (`False`).
- **`main.py`** — Wires `debug.trace_enabled` config: calls `enable_tracing()` at startup.
- **`staging_log/`** — Output directory for trace log files (now safe to commit).
- **`scripts/remove_trace_logging.sh`** — Cleanup script that removes all trace code
(imports, decorators, module, log directory) in one shot.
- **`.gitignore`** — `staging_log/` entry removed (no longer needed).

### Files modified (22 `@trace` decorators added across 5 files)

| File | Methods decorated | Role in add flow |
|---|---|---|
| `cli/interface.py` | `add_start`, `add_end`, `add_oneoff`, `add_pause`, `add_unpause`, `_push_if_remote`, `view_active`, `list_habits` | CLI entry points |
| `domain/staging/service.py` | `capture`, `end`, `pause`, `unpause`, `check_and_sync`, `_needs_full_pull`, `push_to_remote` | Staging service (sync gate + CRUD) |
| `domain/staging/remote_sync.py` | `pull`, `push`, `check_device` | Blob transport (git) |
| `main.py` | `_handle_modify`, `_handle_remove` | Modify/remove command dispatch |
| `compat/v0_3_0.py` | `modify_staged_entry`, `remove_staged_entry` | Legacy LedgerDomain methods |

### What the trace reveals

Example trace for `ph add start "foo"`:
```
>>> CLIInterface.add_start('foo')
  >>> StagingService.capture('foo', epoch_ms, is_active=True)
    >>> StagingService.check_and_sync(timeout_ms=500)
      >>> RemoteStagingSync.pull()              # ← pull encrypted blob from git
      <<< RemoteStagingSync.pull  (2374.8 ms)
      >>> StagingService._needs_full_pull(...)   # ← freshness decision
      <<< StagingService._needs_full_pull  (0.0 ms) → True
      # merge happens...
    <<< StagingService.check_and_sync (2375.8 ms) → READY
    # local append...
  <<< StagingService.capture (2403.3 ms) → 'hash_prefix'
  >>> CLIInterface._push_if_remote()
    >>> StagingService.push_to_remote(master_key=<REDACTED>)   # ← redacted!
      >>> RemoteStagingSync.push(...)            # ← push obfuscated blob to git
      <<< RemoteStagingSync.push  (6673.4 ms)
    <<< StagingService.push_to_remote (6673.7 ms)
  <<< CLIInterface._push_if_remote (6673.7 ms)
<<< CLIInterface.add_start (9077.3 ms)
```

Note: `master_key=<REDACTED>` replaces the former `master_key=b'\x00\xfb...'` —
the raw 32-byte key is no longer logged.

### Usage

```bash
# Enable tracing for a single command
PHPOC_TRACE=1 ph add start "my task"

# Enable tracing persistently via config (add to ~/.config/phpoc/config.json):
#   "debug": { "trace_enabled": true }

# Tail the latest log in another terminal
tail -f staging_log/$(ls -1t staging_log/ | head -1)

# Trace logs are now SAFE to commit (master key redacted)
# Remove all trace code when done
./scripts/remove_trace_logging.sh
```

### Relevant to issues
- **Issue #2** — `view_active` trace confirms it calls `RemoteStagingSync.pull()` directly
  without going through `check_and_sync()` (no auth check, no freshness optimization).
- **Issue #3** — `_needs_full_pull` trace shows its decision (True/False) with timing,
  making it easy to verify the freshness optimization doesn't incorrectly skip cross-device pulls.
- **Issue #4** — Trace on staging CRUD methods shows whether `NoAuthCryptoManager` or
  authenticated `CryptoManager` is being used.

## Session 2 Incident: Key Mismatch Cascade & Remote Wipe (2026-05-22 14:15–15:33)

**Date:** 2026-05-22 (session 2, ~14:15–15:33)
**Severity:** High — remote blob had to be wiped

### Timeline

| Time | Event |
|---|---|
| **14:13-14:14** | `ph view` x2 — remote at `4634cf0`, pull returns `None` (old key from pre-recover session) |
| **14:15:18** | `ph add start "Testing Remote Staging"` — capture + push `9973cfe` with **stale** (pre-recover) key |
| **14:23-14:27** | `ph view` — local clone at `9973cfe`, disk blob decrypts with stale key, merge runs |
| **14:36:29** | `vim ~/.config/phpoc/config.json` — config edited |
| **14:37:00** | `staging.json` overwritten (8 entries, "Testing Remote Staging" lost) |
| **14:37:16** | `ph logout` |
| **14:39:59** | `ph recover` — generates **new random seed**, re-encrypts with new passphrase |
| **14:40:18** | `ph login` — prompts for new passphrase, derives new master key, caches in session |
| **14:40-14:41** | `ph view` x2 — rebase conflict `a2a4c40` vs `9973cfe` → silently swallowed → stale `None` |
| **15:27:28** | `ph view` — local clone still at `9973cfe`, disk blob decrypts with stale key |
| **15:27:39** | `ph add end '1'` — ends "Testing Remote Staging", pushes `b44f11b` encrypted with **stale** key |
| **15:27:51** | Push `9973cfe..b44f11b` to origin |
| **15:31:42** | `ph view` — `git pull --rebase` says "Already up to date" (false — remote ahead) |
| **15:33:45** | `ph view` — rebase conflict again, `pull()` returns `None` |
| **~15:35** | `git reset --hard origin/main` fixes rebase conflict |
| **~15:36** | All blobs undecryptable — session key doesn't match any blob's encryption key |
| **~15:40** | `git rm staging/blobs/current.json` + push `713d1e5` — remote blob wiped |

### Root Causes

1. **Issue #8** — `ph recover` doesn't clear session cache; stale key continued in use after recovery
2. **Issue #9** — `transport.pull()` silently swallows rebase conflicts, returns stale disk data
3. **Issue #12** — `git pull --rebase` reports "Already up to date" when `origin/main` is ahead
4. **Key mismatch by design** — `ph recover` generates a new random seed, making all previous blobs unrecoverable

### Recovery performed

1. Fixed rebase conflict: `git reset --hard origin/main`
2. Wiped remote blob: `git rm staging/blobs/current.json` → commit `713d1e5` → `git push origin main`
3. Local `staging.json` intact (8 entries incl. active "Working on Phpoc" 11:57:37)

### Data lost
- "Testing Remote Staging" entry (started 14:15, ended 15:27) — existed only in undecryptable remote blobs
- All prior remote blob history (`9973cfe`, `b44f11b`) — encrypted with lost key

### Remediation needed
- **`ph recover` must call `auth.clear_session()`** after updating genesis (Issue #11)
- **`ph recover` must re-encrypt with the SAME seed** instead of generating a new one, or warn the user
- **`transport.pull()` must surface rebase conflicts** instead of swallowing them (Issue #9)
- **False "Already up to date"** must be detected and handled (Issue #12)

## Test Results

### Confirmed Working
- ✅ Device A starts entry → pushes → Device B sees it (via `ph view`)
- ✅ Device B ends entry → pushes → Device A sees it ended (via `ph view`)
- ✅ Obfuscated blob round-trip (AES-CTR encrypted over git)
- ✅ Device ID tracking in blob header
- ✅ `git push` via explicit refspec on detached HEAD
- ✅ Fresh clone + pull from empty remote
- ✅ Cross-device `ph view` after `ph login` — debagent04 (`bbb3badc-...`)
  successfully pulled x13's blob (`dc1da321-...`), merged, and displayed
  both devices' entries (2026-05-22 20:51 CEST)
- ✅ `NoAuthCryptoManager` isinstance check correctly gates auth — real
  `CryptoManager` with valid key skips REAUTH_NEEDED; NoAuth falls through

### Needs Verification
- ❓ Cross-device write flow (both devices make concurrent changes)
- ❓ Auth cache expiry → REAUTH_NEEDED after 30 min of inactivity in cross-device scenario
- ❓ `entry_id`-based dedup across devices (requires authenticated session)
- ❓ `_needs_full_pull()` correct behavior when Device B modifies local staging without pushing

## Areas for Improvement

### AFI #1: Auth Criteria — Device Cookie Fast Path

**Status:** ✅ **Resolved** (2026-05-24) — Device Cookie implemented

**Assigned to:** x13 agent → ✅ Done
**Priority:** High

**The problem:** `check_and_sync()` needed to read the `device_id` from the remote
staging blob to decide if auth was needed. But the blob is encrypted — you need the
master key to decrypt it. **Circular dependency** that caused data loss (Session 2
incident).

**The solution:** Device Cookie — see "Device Cookie Implementation" section above.

**How it resolves the AFI:**
1. **Device ID mismatch** → Cookie comparison catches this (different mk/device_id →
   different cookie bytes) → triggers auth + full merge
2. **Cookie expiry** → TTL checked locally (no network needed) → expired cookie
   forces re-auth
3. **Same device, same session** → Cookie matches → `READY` instantly — no blob pull,
   no decrypt, no merge
4. **View reads** → `view_active()` routes through `check_and_sync()` (Issue #2 fix)
   which uses the cookie fast path

**Remaining:** The `_push_if_remote()` path still doesn't re-check auth before pushing.
This is acceptable because the cookie prevents the circular-dependency data loss —
if the key has changed (e.g. after `ph recover`), the old cookie won't match the
new session's cookie, so the slow path fires and auth is checked.

### Issue #6: ls-remote argument order breaks on git 2.53.0

**Status:** ✅ Fixed (2026-05-22)
**Fix:** `"ls-remote", "origin", "--heads"` → `"ls-remote", "--heads", "origin"`

**Root cause:** `_has_remote_refs()` in `core/sync/git_transport.py:245` passed
`--heads` after the remote name. Git 2.53.0+ requires filter flags like `--heads`
**before** positional args. The call returned empty output, making `_has_remote_refs()`
always return `False`, which prevented `pull()` and `push()` from ever actually
contacting the remote.

**Why it worked on debagent04:** Git version differs — older git accepted `--heads`
after the remote name. x13 had git 2.53.0 which is stricter.

**Impact:** This was the actual root cause of x13 never syncing with the remote.
All previous apparent failures (auth, key mismatch, etc.) were secondary — the
transport never even tried to pull or push because `_has_remote_refs()` returned `False`.

**Trace before fix:**
```
GitStagingTransport._git('ls-remote', 'origin', '--heads')  →  '' (empty!)
```

**Trace after fix:**
```
GitStagingTransport._git('ls-remote', '--heads', 'origin')  →
  '4634cf0... refs/heads/main'
```

**Files modified:** `core/sync/git_transport.py:245`

### Issue #7: Stale session cache causes blob overwrite on auth failure

**Status:** 🔴 Open — data loss incident
**Date:** 2026-05-22
**Impact:** Remote blob was overwritten, losing debagent04's active task entries

**Root cause:** `ph recover` does NOT clear the session cache (`/dev/shm/phpoc_session`)
after updating the genesis block. Subsequent `auth.authenticate()` checks the session
cache first and returns the stale key without prompting for a passphrase:

```python
def authenticate(self) -> bool:
    if self.SESSION_FILE.exists():
        self._key = self.SESSION_FILE.read_bytes()
        return True  # ← returns STALE key without prompting!
```

**Cascade:**
1. User runs `ph recover` with correct seed → genesis updated with new PDK
2. Session cache NOT cleared — still holds pre-recover key
3. User runs `ph add start "Testing Remote Staging"` → authenticates from cache → stale key
4. `pull()` with stale key → tag mismatch → returns `None`
5. `check_and_sync()` sees `None` → assumes "no remote blob" → proceeds
6. `push_to_remote()` writes NEW blob with only x13's local entries → **overwrites debagent04's blob**
7. debAgent04's active task (#1 Working on Phpoc, started 11:57:37) is lost from remote

**Trace of the overwrite:**
```
RemoteStagingSync.pull() → None  (tag mismatch, stale key)
```

**Current state:** Remote blob has `device_id: dc1da321-...` (x13) with 14 entries.
DebAgent04's 11:57:37 active task was never pushed and only exists in debagent04's
local staging.

**Remediation needed:**
- debAgent04 must re-push its local staging to the remote
- To prevent recurrence: `ph recover` should clear the session cache

### Issue #8: Session cache prevents re-auth after ph recover

**Status:** 🔴 Open
**Detail:** `PassphraseAuthenticator.authenticate()` checks `/dev/shm/phpoc_session`
first. If the file exists and is readable, it returns the cached key immediately
without prompting for a passphrase. This means:
- After `ph recover` changes the passphrase, the stale session cache bypasses
  the new passphrase requirement
- User never gets prompted, never realizes the cache is stale
- The old (potentially wrong) key continues to be used

**Fix needed:** `ph recover` handler should call `auth.clear_session()` after
completing, or `_cache_key(mk)` should be called with the newly derived key.
Currently neither happens.

### AFI #2: Latency — investigate all operations exceeding 2 seconds

**Assigned to:** x13 agent (+ debagent04 for comparison)
**Priority:** Medium
**Observation from trace logs:** Several git operations regularly exceed 2 seconds:

| Operation | Typical latency | Threshold | Investigation needed? |
|---|---|---|---|
| `ls-remote origin --heads` | **2,300–2,700 ms** | > 2s | ✅ Yes — called on every pull AND push |
| `git pull --rebase --autostash` | (not yet measured) | > 2s | ❓ Needs trace data |
| `git push` | **3,200–6,700 ms** | > 2s | ✅ Yes — blocks the entire command |
| `git add` + `commit` | **~10 ms** | > 2s | ❌ Local only, fine |
| Blob encrypt/decrypt | (not yet measured) | > 2s | ❓ Needs trace data |
| Full `ph add start` | **~9,000 ms** | > 2s | ✅ Yes — total user-facing latency |

**Key findings:**
- Each `ph add`/`ph view` command makes **2 git network round-trips** (1x `ls-remote`
  during pull, 1x `ls-remote` + 1x `push` during push) — all to GitHub over SSH.
- The `ls-remote` call before push is redundant: the push phase just checked `ls-remote`
  during pull. The second call happens because `push_to_remote()` → `push()` →
  `_has_remote_refs()` independently.
- `_has_remote_refs()` is called twice per command (once in `pull()`, once in `push()`).
  Each call runs `ls-remote` which takes ~2.5s. This is **5s of unnecessary overhead**.

**Optimization opportunities:**
- Cache the result of `_has_remote_refs()` within a single command invocation
- Merge `ls-remote` calls: the push phase could reuse the pull phase's result
- Consider dropping `ls-remote` entirely for well-known repos (assume refs exist)
- Total potential savings: **~5 seconds per command**

**On debagent04:** Need to compare network latency (different ISP, different geographic
location) — the SSH handshake + GitHub API response time may differ.

### AFI #3: Staging Sync on Device Hand-off

**Assigned to:** debagent04 agent (primary), x13 agent (validation)
**Priority:** High
**Description:** Ensure correct staging sync behavior when switching between devices.
The following scenarios need to be verified:

1. **Device A → Device B hand-off:**
   - Device A does `add start "X"` → pushes blob with device_id A
   - Device B does `ph view` → pulls blob, sees device_id A ≠ B
   - Device B authenticates (cookie fresh) → merge occurs
   - Device B does `add end "X"` → pushes blob with device_id B
   - **Verification:** Device A pulls and sees X as ended

2. **Concurrent edits (race condition):**
   - Both devices pull the same blob at same timestamp
   - Both add different entries locally
   - Both push — whoever pushes second gets rejected (non-fast-forward)
   - **Expected:** Second push does `pull --rebase`, merges, retries push
   - **Risk:** Merge may duplicate entries or lose data

3. **Stale cookie / re-auth mid-hand-off:**
   - Device A uses → Device B uses after > 30 min of inactivity
   - `check_and_sync()` returns `REAUTH_NEEDED`
   - **Expected:** User is prompted for passphrase before merge proceeds
   - **Risk:** If user declines re-auth, local staging is stale — next write may
     clobber remote data

4. **Device B makes local changes without pushing, then switches back to A:**
   - Device B adds entries locally → does NOT push
   - Device A does `ph view` → pulls remote blob (missing B's changes)
   - Device A adds more entries → pushes
   - Device B comes back → pulls, merges, pushes
   - **Risk:** Device B's local-only changes are lost if B's staging is overwritten
     by A's push before B can commit

**Fleshed-out mitigation analysis:**

**Dirty-flag check (volatile — resets on crash):**
Add a `_dirty: bool` to `StagingService` that is set `True` on every local staging
write (`append`, `update`, `delete`) and cleared after successful `push_to_remote()`.
Before any pull+merge, check:

```python
if self._dirty and self._remote is not None:
    print("Warning: local staging has un-pushed changes. "
          "Run a write command (add start/end) to push "
          "before another device overwrites.")
```

**Problem:** `_dirty` is in-memory only. If the process crashes between a local
write and the push, the flag resets to `False` and the warning never fires.

**Persisted invariant (survives crashes):**
Store `last_modified_at` and `last_pushed_at` in the local staging JSON metadata.
On startup or before pull, compare: if `last_modified_at > last_pushed_at`, warn
about un-pushed changes. This survives process crashes because it's on disk.

**Crash-between-merge-and-push gap:**
`check_and_sync()` pulls → merges → writes local. If the process crashes before
`_push_if_remote()` runs, the local staging has merged remote data that was never
pushed back. On next startup:
- `view` (read-only) → no push → remote is behind
- `add start` → `check_and_sync()` → `_needs_full_pull()` sees device matches +
  `updated_at <= _last_push_at` (since we just merged the latest) → skips pull →
  writes locally → pushes. Works, but the push includes both the merged data and
  the new entry.

**Simplest fix for the gap:** Have `view_active()` also call `_push_if_remote()`
after the merge if the staging was modified. Track whether the merge actually
changed anything (compare entry count/hashes before vs after).

**Scenario 2 risk: concurrent-edit conflict during git rebase:**
When both devices edit the same entry concurrently:
1. Both pull blob at hash H1
2. Device A modifies entry X → commits → pushes → remote at H2
3. Device B modifies entry X → tries to push → non-fast-forward rejected
4. Transport does `pull --rebase` → git tries line-based merge on JSON
5. If both modified the same lines of the JSON → **merge conflict**
6. Transport has no conflict resolution → fails

**Mitigation:** Either:
- Add a custom git merge driver (`git config merge.staging.driver`) that
  understands the staging JSON schema and does a logical merge
- Or detect the conflict in Python after `pull --rebase` fails, re-pull the
  latest blob, diff logically, re-apply changes, re-push
- Or reduce the window: single-file blobs are inherently conflict-prone;
  splitting into per-entry files in the git repo would allow git to merge
  independent changes cleanly

**Status of original mitigations:**
- ✅ Enforce push on every write — done (`_push_if_remote()`)
- 🔲 Volatile dirty-flag — cheap to add, useful for warning, but crash-reset limits value
- 🔲 Persisted `last_modified_at` / `last_pushed_at` — recommended, survives crashes
- 🔲 Post-merge push from `view_active()` — closes the crash gap
- 🔲 Concurrent-edit conflict strategy — per-entry blob files or custom merge driver

### Issues resolved

| Date | Issue | Fix |
|------|-------|-----|
| 2026-05-22 | Issue #2 — view bypasses check_and_sync | Route `view_active()` through `check_and_sync()` |
| 2026-05-22 | Issue #6 — ls-remote argument order | `--heads` before remote name |
| 2026-05-22 | Trace log passphrase leak | `_redact()` masks 32-byte keys + sensitive kwargs |
| 2026-05-22 | `.gitignore` restriction | `staging_log/` removed (safe to commit now) |
| 2026-05-22 | Config-driven tracing | `debug.trace_enabled` default + wiring |
| 2026-05-22 | `ph login` / `ph logout` | Minimal subcommands for session management |
| 2026-05-22 | Issue #10 — Blob key mismatch after ph recover | Remote wiped, fresh blob needed |
| 2026-05-22 | Issue #13 — `_last_auth_time = 0.0` false REAUTH_NEEDED | isinstance check on `NoAuthCryptoManager` |
| 2026-05-24 | **AFI #1 — Device Cookie fast path** | `domain/cookie/device_cookie.py` new, cookie wiring |
| 2026-05-25 | **AFI #2 partial — Phase A instant reads** | Background subprocess avoids ls-remote on reads; display in ~50ms. |
| 2026-05-25 | **AFI #2 partial — Phase B instant writes** | WAL-backed deferred push; writes return in ~2ms, remote push deferred to background. |
| 2026-05-25 | **Phase C** | Daemon mode (ph daemon start/stop/status), 65 tests. |
| 2026-05-25 | **Stale-remote resurrection bug** | Removed `check_and_sync()` from all 6 write methods. Remote-always-wins MergeEngine was resurrecting ended tasks from stale remote blob. Writes are now local-only; remote sync via WAL/daemon. 3 test files updated. |
| 2026-05-25 | **Onboarding command** | `ph onboarding` — `cli/onboarding.py` (474 lines). Pulls ledger/staging/index from git remote, extracts identity from genesis, runs recover flow. Transport-agnostic via `AbstractStagingTransport`. |

### Open issues remaining

| Issue | Status | Owner |
|---|---|---|
| Issue #7 — Stale cache blob overwrite (session 2) | 🔴 Data loss (resolved by wipe) | x13 + debagent04 |
| Issue #8 — Session cache blocks re-auth after ph recover | ✅ Fixed (commit `389e268`) | debagent04 |
| Issue #9 — Rebase conflicts silently swallowed | 🔴 Needs fix | debagent04 |
| Issue #11 — `ph recover` doesn't clear session cache | ✅ Fixed (commit `389e268`) | debagent04 |
| Issue #12 — `git pull --rebase` 'Already up to date' false negative | 🔴 Needs fix | debagent04 |
| Issue #13 — `_last_auth_time = 0.0` false REAUTH_NEEDED after ph login | ✅ Fixed | debagent04 |
| Issue #14 — `ph recover` rewrites all blocks; full ledger push takes ~7 min | 🔴 Needs design (async batch push) | x13 |
| **AFI #2** — Redundant `ls-remote` calls | 🟡 Partially resolved (Phase A: reads bypass `ls-remote` entirely via background subprocess. Phase B: writes return instantly via WAL, push deferred to background. Phase C: daemon eliminates subprocess-per-command overhead with persistent event loop + debounce.) | x13 |
| **AFI #3** — Device hand-off sync scenarios | 🔴 Needs testing | debagent04 |

### Issue #9: Silently swallowed rebase conflict in transport.pull()

**Status:** 🔴 Open — needs fix
**Date:** 2026-05-22 (session 2)
**Discovered:** Via trace log analysis on debagent04

**Root cause:** `GitStagingTransport.pull()` in `core/sync/git_transport.py:60-89` wraps `git pull --rebase --autostash` in a try/except that **silently swallows** the exception:

```python
try:
    self._git("pull", "--rebase", "--autostash")
except RuntimeError:
    pass  # ← Pull may fail on empty remote or disconnected — proceed without it
```

When the rebase hits a conflict (divergent histories), the exception is swallowed, the working tree is left in a conflicted state, and `pull()` reads the **stale conflicted file from disk** — returning corrupted or wrong data. The caller (`remote_sync.py`) has no way to distinguish "no remote blob" from "rebase conflict."

**Impact:**
- At 14:40-14:41, multiple `ph view` commands returned stale data from the conflicted working tree
- The conflict persisted across commands because `_recover_git_abort_stuck_rebase()` only recovers if a rebase-merge directory exists — but after a failed rebase, the directory may or may not exist
- By 15:33, the rebase was stuck again, requiring manual `git reset --hard origin/main`

**Fix needed:** `pull()` should differentiate between "no remote" and "rebase conflict":
1. Before pull, save the HEAD commit hash
2. If pull raises, check if `rebase-merge` dir exists → abort rebase, raise explicit error
3. If pull raises but no rebase state → it's a connectivity issue, return None

**Trace:**
```
14:40:27 [TRACE] <<< GitStagingTransport._git  (2004.9 ms)  ✗ RuntimeError: Git command failed (exit 1): git pull --rebase --autostash
  error: could not apply a2a4c40... Update staging blob [staging/blobs/current.json]
14:40:27 [TRACE] <<< RemoteStagingSync.pull  (3742.2 ms)  → None
```

The error is swallowed, `pull()` returns `None`, `check_and_sync()` interprets it as "no remote blob," and proceeds without merging.

**Related:** Issue #6 was the root cause of the divergent commit `a2a4c40` (ls-remote argument order prevented sync, so the local clone's commit was never pushed), which then caused every subsequent rebase to conflict.

### Issue #10: Blob encryption key mismatch after ph recover

**Status:** ✅ Resolved — remote blob wiped
**Date:** 2026-05-22 (session 2)
**Impact:** Remote blob at `9973cfe` and `b44f11b` encrypted with different master key than current session

**Root cause:** `ph recover` at 14:39:59 generated a **new random recovery seed** and re-encrypted it with the new passphrase in the genesis block. All previous remote blobs were encrypted with the **old master key** (derived from the old seed). After recovery:
- New passphrase → new PDK → new seed → new master key
- Old blobs are permanently undecryptable with the new key

**Cascade:**
1. `ph recover` changes the recovery seed (not just the passphrase wrapping it)
2. The genesis block's `recovery_seed_enc` now points to a new seed
3. `ph login` at 14:40 re-authenticates successfully with new passphrase → new master key
4. But the `b44f11b` blob (pushed at 15:27 from the post-recover session) was ALSO encrypted with a key that doesn't match — meaning the 14:40 `ph login` somehow produced a different key than what was used for the 15:27 push
5. All subsequent `ph view` commands hit "Blob integrity check failed (tag mismatch)"

**Trace:**
```
Blob integrity check failed (tag mismatch)  →  pull returns None
```

**Resolution:** Remote blob file deleted from git repo via:
```bash
git rm staging/blobs/current.json
git commit -m "Remove staging blob (wipe remote data)"
git push origin main
```
Commit `713d1e5` on `origin/main`. Next write command will push a fresh blob encrypted with the current session key.

### Issue #11: ph recover doesn't clear session cache

**Status:** 🔴 Open — needs fix
**Date:** 2026-05-22 (session 1, re-identified in session 2)

**Root cause:** `ph recover` in `main.py:254-277` doesn't call `auth.clear_session()` after updating the genesis block with the new passphrase-wrapped seed. The old session cache persists, and if `authenticate()` finds `SESSION_FILE.exists()`, it returns the stale key immediately without prompting for the new passphrase.

**Impact (session 1):** After `ph recover`, the stale session cache caused the old key to be used for pushes, while subsequent `ph view` from a new terminal would prompt for the new passphrase and derive a different key — creating blobs encrypted with two different keys that can't cross-decrypt.

**Impact (session 2):** At 14:40, `ph login` (which calls `clear_session()` before `authenticate()`) was used instead, but the 14:15-14:27 window had already used the stale key, creating undecryptable blobs.

**Fix needed:** Add `auth.clear_session()` at the end of `ph recover`'s handler (or immediately after generating the new PDK and encrypted seed):
```python
if args.command == "recover":
    # ... existing recovery code ...
    ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed
    # ... re-chain blocks ...
    
    auth.clear_session()  # ← Force re-auth with new passphrase next time
```

**Also:** `ph recover` should log out the old session explicitly to prevent the user from continuing with a now-stale session.

### Issue #12: git pull --rebase reports 'Already up to date' when remote is ahead

**Status:** 🔴 Open — needs investigation
**Date:** 2026-05-22 (session 2)

**Observation:** At 15:31:42, trace shows:
```
ls-remote sees b44f11b7af62d9db73543c84d6c39034947373c6  (remote is ahead)
git pull --rebase --autostash  →  'Already up to date.'
```

The local clone was at `9973cfe`, and `origin/main` was at `b44f11b` (1 commit ahead). `git pull --rebase` should have fast-forwarded to `b44f11b`, but instead said "Already up to date."

**Hypothesis:** The local clone's HEAD was on a **divergent branch** rather than the true `main`. The `symbolic-ref -q HEAD` check passed (returned `refs/heads/main`), but `refs/heads/main` pointed to `9973cfe` while `refs/remotes/origin/main` pointed to `b44f11b`. The fetch inside `pull --rebase` updated `origin/main` but git's "up to date" check compared local `main` (9973cfe) against `merge HEAD` = `origin/main` (b44f11b) — finding they diverged, but the autostash+rebase flow may have concluded there was nothing to rebase because the local commit was an ancestor.

**Impact:** The blob file on disk remained at the `9973cfe` version (encrypted with old key), and `pull()` returned that stale encrypted blob without the caller realizing the remote had been updated.

**Fix needed:** After `git pull --rebase`, verify that the current HEAD matches `origin/main`. Log a warning if they diverge.

### Issue #14: `ph recover` rewrites all ledger blocks; full push takes ~7 minutes

**Status:** 🔴 Needs design
**Date:** 2026-05-23
**Assigned to:** x13
**Observed by:** x13 (first full remote ledger push)

**The problem:** A normal `ph sync remote_ledger` pushing the full ledger to GitHub took
**~7 minutes** for a relatively short ledger (genesis + ~55 day blocks). More critically,
after `ph recover` rewrites all block hashes, `push_blocks()` silently skips every block
because it checks by **index** (`if i in existing: continue`), not by hash — so the
remote stays on the OLD chain while the local moves to a NEW chain. Result: **silent
divergent fork**.

#### Root cause: one git commit+push per block

`RemoteLedgerSync.push_blocks()` iterates over each block and calls `self._transport.push()`
individually. Each `GitStagingTransport.push()` does **3 network round-trips to GitHub**:

| Operation | Latency | Count per block |
|---|---|---|
| `git ls-remote --heads origin` | ~2.5s | 1 (via `_has_remote_refs()`) |
| `git pull --rebase --autostash` | ~2s | 1 |
| `git push origin` | ~3–6s | 1 |
| **Total per block** | **~7–10s** | |

With ~55 blocks: 55 × ~8s ≈ **440s ≈ 7 minutes**. Almost all of that is SSH
handshake + protocol overhead for tiny files.

#### The `ph recover` divergence problem

`ph recover` rewrites **every block in-place** (new `recovery_seed_enc` in genesis →
cascading new `prev_hash` → new seals → new signatures on all blocks). But
`push_blocks()` only checks index:

```python
for i, block in enumerate(local_blocks):
    if i in existing:   # ← True for all indices after first push
        continue          # ← Skips silently — remote stays on OLD chain!
```

After recovery, `ph sync remote_ledger` reports **"Already in sync (no changes)"**
even though every single block hash differs from remote. Any new block appended
post-recover has `prev_hash` pointing to the new chain and cannot link to the
old remote chain.

#### Proposed fix: batch push

Instead of one commit+push per block, batch all blocks into a single commit and push:

```python
def push_blocks(self, local_blocks: List[Dict[str, Any]], force: bool = False) -> int:
    existing = self._list_remote_block_indices()
    
    # Detect ph-recover-style divergence: existing blocks with different content
    if force:
        # Force mode: overwrite ALL blocks in a single commit
        for i, block in enumerate(local_blocks):
            obfuscated = self._obfuscate_block(block)
            self._transport.write_file(path, obfuscated)  # write only, no commit/push
        self._transport.commit("Update ledger blocks [recovery]")
        self._transport.push()  # single push
        return len(local_blocks)
    
    # Normal append-only: check for hash divergence
    diverged = self._check_hash_divergence(local_blocks, existing)
    if diverged:
        raise RuntimeError(
            f"Block {diverged} hash differs from remote — run with --force after ph recover"
        )
    
    # Batch: write all new blocks, then single commit+push
    pending = []
    for i, block in enumerate(local_blocks):
        if i in existing:
            continue
        obfuscated = self._obfuscate_block(block)
        self._transport.write_file(path, obfuscated)
        pending.append(i)
    
    if pending:
        self._transport.commit(f"Add ledger blocks {pending[0]:06d}..{pending[-1]:06d}")
        self._transport.push()
    
    return len(pending)
```

This reduces from `N` commits+pushes to **1 commit + 1 push** (plus 1 `ls-remote`
and 1 `pull` shared across all blocks). Estimated savings:

| Approach | Network round-trips | Estimated time (55 blocks) |
|---|---|---|
| Current (per-block) | 55 × 3 = 165 | ~7 min |
| Batched (single) | 3 (1 ls-remote, 1 pull, 1 push) | ~8–10s |
| Batched + force | 3 (same) + overwrite | ~10–12s |

#### Required transport API changes

The `AbstractStagingTransport` interface needs new methods (or modified semantics):
- `write_file(path, data)` — write bytes to a file in the clone without committing
- `commit(message)` — stage all pending changes and commit
- `push()` — push the single commit to remote

Current `push(path, data)` conflates write + commit + push into one operation,
which makes batching impossible.

#### Related

- AFI #2 (redundant `ls-remote`) — fixing that alone cuts ~2.5s per block but
  leaves the N-push architecture problem
- `ph recover` cleanup (Issues #8, #11) — fixing session cache is a prerequisite
  but doesn't solve the chain divergence

## AFI #4: Same-device auth bypass — no re-auth prompt on self-pushes

**Status:** ℹ️ By design, but noteworthy for hand-off testing
**Discovered:** 2026-05-22, verified via live blob decryption

**Observation:** When the **same device** (debagent04, `bbb3badc-...`) that last pushed the
remote blob runs another command, `check_and_sync()` sees `device_match = True` and
**skips the auth check entirely**. No passphrase prompt is shown, regardless of whether
`_last_auth_time` is stale or fresh.

**Code path** (`service.py:447-453`):
```python
if not device_match:
    if time.time() - self._last_auth_time < self.AUTH_CACHE_DURATION:
        pass  # Auth cache still valid
    else:
        return SyncCheckResult.REAUTH_NEEDED

# Update auth timestamp on successful device check
self._last_auth_time = time.time()
```

When `device_match` is `True`, the `if not device_match:` block is never entered,
so the auth expiry check is never evaluated, and `_last_auth_time` is unconditionally
updated.

**Scenario that triggered this:**
1. debagent04 did `add start "Working on Phpoc"` at ~11:57 CEST
2. Remote blob had `device_id: bbb3badc-...` (from device's own prior push)
3. Local device_id matched → `device_match = True` → no auth prompt
4. Entry was written and pushed without any authentication gate

**Verified via live blob decryption:**
- Grabbed `current.json` from remote git clone (65592 bytes obfuscated)
- Decrypted using the session master key in `/dev/shm/phpoc_session`
- Confirmed remote blob content is an **exact mirror** of local `staging.json`,
  containing all 8 entries including the active "Working on Phpoc" (`entry_id:
  8661e6f1-...`)
- Remote blob header: `device_id: bbb3badc-6365-49ea-b43c-53869ca0195f`,
  `updated_at: 1779443859046`

**Implication for cross-device hand-off (upcoming test):**
When the x13 laptop pulls from GitHub and runs `ph view`, it will see
`remote_device_id = bbb3badc-...` ≠ `local_device_id = dc1da321-...`. If the auth
cache is stale (or never set), `check_and_sync()` will return `REAUTH_NEEDED`.

**Test expected:**
- x13 laptop: `ph view` → should prompt for passphrase (device mismatch + no fresh cookie)
- After auth → should pull, decrypt, merge, and display the active entry from debagent04

**Open question:** Does `ph view` currently route through `check_and_sync()`? See Issue #2 which states
`view_active()` bypasses it entirely.

---

## Device Cookie Implementation (2026-05-24)

**Status:** ✅ Implemented

### Problem
`check_and_sync()` needed to read the `device_id` from the remote staging blob to
decide whether auth was needed. But the blob is encrypted — you need the master key
(requiring auth) to decrypt it. **Circular dependency.**

When decryption failed (e.g. stale key after `ph recover`), `pull()` returned `None`,
which `check_and_sync()` interpreted as "no remote blob" → proceeded without merging →
overwrote the remote (see Session 2 Incident — this was the root cause of the data loss).

### Solution: Device Cookie

A deterministic 32-byte HMAC cookie that serves as a fast-path identity check:

```
cookie = HMAC-SHA256(cookie_key, device_id + ":" + epoch_ms)
```

**Properties:**
- **Deterministic:** Same (master_key, device_id, epoch_ms) → identical 32 bytes every time
- **Tiny:** 32 bytes vs ~64KB+ staging blob — ~2000× smaller
- **No profiling on remote:** Remote only stores HMAC output bytes. No device_id, no epoch in plaintext.
- **TTL enforced locally:** Plaintext `created_at` epoch in `device_cookie.meta` (local only, NEVER pushed)
- **No decryption needed:** Byte-for-byte comparison only (`hmac.compare_digest`)

### Flow

```
check_and_sync():
  1. Local cookie valid? (TTL check against plaintext epoch)
     ├── No cookie / expired → destroy locally, fall through to slow path ↓
     └── Valid → pull remote cookie (32 bytes, no decrypt needed)
         ├── Cookies match? → READY (same device, same session → staging is in sync)
         └── No match / no remote cookie → fall through to slow path ↓

  2. Slow path: pull + decrypt staging blob, device check, auth, merge

push_to_remote():
  1. Destroy stale local cookie
  2. DeviceCookie.create(mk, device_id, data_dir) → deterministic 32 bytes
  3. push_cookie(cookie_bytes) → remote (FIRST, before blob)
  4. push(entries, device_id, master_key) → staging blob
```

### Local file layout

```
~/.local/share/phpoc/
  ├── device_cookie.bin        ← Encrypted (HMAC) 32 bytes → pushed to remote
  └── device_cookie.meta       ← Plaintext: {"created_at": epoch_ms} → LOCAL ONLY

Remote (GitHub):
  staging/blobs/
    ├── device_cookie.bin      ← Same 32 HMAC bytes (matching local)
    └── current.json           ← Obfuscated staging blob (existing)
```

### Key design decisions

1. **HMAC vs AES-SIV for deterministic encryption:** HMAC is simpler, works with any key
   size, and we never need to decrypt the cookie — only compare. The 32-byte output is
   indistinguishable from random bytes to an attacker.

2. **Cookie pushed BEFORE blob:** Ordering matters for mock transport tests that store
   the last pushed data in a single slot. Cookie first means the staging blob is the
   last write, preserving test compatibility.

3. **TTL kill switch:** The plaintext epoch is only stored locally. If `device_cookie.meta`
   is deleted or corrupted, the cookie is treated as expired and re-creation is forced.
   There is no way for a stale session to persist beyond the TTL.

### Files changed

| File | Change |
|------|--------|
| `domain/cookie/device_cookie.py` | **NEW** — `DeviceCookie` class: create, is_valid_locally, matches, destroy_locally |
| `domain/cookie/__init__.py` | Package init |
| `domain/staging/remote_sync.py` | Added `pull_cookie()` + `push_cookie()` methods + `REMOTE_COOKIE_PATH` constant |
| `domain/staging/service.py` | Fast-path in `check_and_sync()`, cookie creation in `push_to_remote()` |
| `security/config_manager.py` | Added `cookie.ttl_minutes: 30` + `cookie.enabled: true` defaults |
| `main.py` | Both `StagingService` instantiations pass `cookie_ttl_minutes` + `data_dir` |
| `tests/test_remote_config_wiring.py` | Updated `assert_called_once()` → `assertEqual(..., 2)`, added unique `data_dir` to tests |

### Test results
- 1049 tests run, **2 pre-existing failures** (auth cache expiry tests using MagicMock crypto)
- **Zero regressions** introduced by cookie implementation

### Security properties

| Property | How it's achieved |
|---|---|
| No profiling on remote | Remote only has 32 bytes of HMAC output — no device_id, no epoch |
| No replay attacks | TTL checked locally via plaintext epoch; expired cookies force re-auth |
| Deterministic comparison | HMAC: same inputs → same 32 bytes every time |
| Cookie can't be forged | Need master key to generate matching HMAC |
| No circular dependency | Cookie check needs no decryption, just byte comparison |
| Minimal network cost | Cookie is 32 bytes vs staging blob ~64KB+ |

---

## Next Phase: Remote Ledger Sync

**Goal:** Sync the immutable ledger to the same git remote as staging, enabling
cross-device `ph list all` without manual file transfer.

**Status:** ✅ **Implemented** (2026-05-22) — code written, pending test file and cross-device review.

### Design

**Same repo** as staging (`github.com:wacevedo76/phpoc-staging.git`):

```
staging/blobs/current.json   (existing — mutable, merge-needed)
ledger/
  blocks/
    000000.json                 (genesis — pushed once)
    000001.json                 (obfuscated single day block, sequence-numbered)
    000002.json
    ...
  index.json                    (lightweight summary — duration + tags + entry count)
```

### Implementation (completed)

| File | Change |
|------|--------|
| `domain/ledger/remote_sync.py` | New — `RemoteLedgerSync` class: push_blocks, pull_blocks, push_index, pull_index, get_remote_block_count, _verify_chain |
| `core/sync/transport.py` | `AbstractStagingTransport` gains `list_files(prefix)` (default `[]`) |
| `core/sync/git_transport.py` | `list_files()` via `git ls-tree`; `_has_local_commits()` helper |
| `main.py` | `ph sync remote_ledger` subcommand with forced auth, sync summary, confirmation, exec |

### Key design decisions

1. **Sequence-numbered block files** (`000000.json`..`0000NN.json`) — handles multi-sync-per-day naturally
2. **No index file for sync tracking** — `list_files()` via `git ls-tree` avoids write conflicts
3. **Index file for activity analysis** — lightweight summaries, pushed as separate obfuscated file
4. **Chain verification on pull** — `_verify_chain()` checks `prev_hash` linkage across blocks;
   full `day_hash` seal verification happens locally after append
5. **Forced auth before sync** — clears session cache, prompts for passphrase, refreshes crypto
6. **Review + confirm** — shows local vs remote block count, lists blocks to be pushed, requires `y/N`

### Pending

- `tests/test_remote_ledger_sync.py` (~24 tests against local bare repos)
- Cross-device testing (x13 → debagent04 round-trip)

---

## Mobile-First Infrastructure: Replace git/SSH with Serverless HTTP Transport (2026-05-24)

**Status:** 🔮 Design direction — Phase 1 starts next sprint

### Problem

1. **~5s latency per command** — SSH handshake dominates. Device Cookie benchmark
   showed 5121ms average for a 32-byte check; 99.9% of that is `git pull --rebase`.
2. **No mobile client possible** — Mobile devices don't have git or SSH. Any
   mobile app would need a separate HTTP backend anyway.
3. **The CLI is a bottleneck itself** — user wants to use phpoc more than the CLI
   allows. The CLI served as the most convenient build tool, but mobile is the
   target platform.

### Solution: Cloudflare Worker + R2 bucket

A stateless serverless function (~40 lines TypeScript) that acts as an HTTP
pass-through between clients and an R2 bucket. Both the Python CLI and a future
mobile app use the same API.

```
┌──────────────┐     HTTPS (GET/PUT)    ┌──────────────┐     S3 API      ┌────────┐
│ Python CLI   │ ──────────────────────►│ Cloudflare   │ ──────────────►│  R2    │
│ (or mobile)  │ ◄─── HTTP (304/200) ───│ Worker       │ ◄──────────────│ Bucket │
└──────────────┘                        └──────────────┘               └────────┘
```

### What changes

| Layer | Change |
|-------|--------|
| `core/sync/http_transport.py` | **NEW** — `HttpStagingTransport` (~100 lines, stdlib only) |
| `core/sync/git_transport.py` | Replaced — kept for reference, not used |
| `main.py` | Swap `GitStagingTransport` → `HttpStagingTransport` (1 line) |
| `domain/` | **Unchanged** — all domain logic is transport-agnostic |
| tests | Add `test_http_transport.py` (~20 tests) |
| Cloudflare | New R2 bucket + Worker deployment |

### Why now

The git-based transport was a pragmatic choice for the prototyping phase — easy
to set up, zero infra cost, piggybacked on existing GitHub access. But it's now
the primary bottleneck for both latency and platform reach. The `AbstractStagingTransport`
interface was designed specifically to make this swap possible without touching
domain logic.

### Cost

| Provider | Free tier | Monthly cost at personal scale |
|----------|-----------|-------------------------------|
| Cloudflare R2 | 10GB storage, 1M req/day | **$0.00** |
| AWS S3 | 5GB, 20K GET, 2K PUT | **~$0.01** |

### ADR

See `ARCHITECTURAL_DECISIONS.md` → ADR-023 for full design rationale.

## Phase 1 Progress (2026-05-24)

### Phase C — Daemon mode: ✅ Implemented

| File | Lines | Purpose |
|------|-------|---------|
| `cli/daemon.py` | ~330 | PhDaemon lifecycle (start/stop/status), DebounceQueue, FileWatcher, event loop, status publishing |
| `cli/daemon_sync.py` | ~160 | SyncWorker with retry/conflict/session, SyncResult |
| `cli/daemon_cli.py` | ~25 | `ph daemon start/stop/status` argument handlers |
| `tests/test_daemon.py` | ~800 | 41 tests — daemon lifecycle, DebounceQueue, event loop, file watcher, status publishing |
| `tests/test_daemon_sync.py` | ~400 | 24 tests — SyncWorker session/retry/conflict, pull_check, SyncResult |

**65 tests all pass.** `main.py` updated with `ph daemon start/stop/status` subcommand.

| Task | Status |
|------|--------|
| Create R2 bucket `phpoc-data` | ✅ Done |
| Create R2 API token (`phpoc-r2-bucket`) | ✅ Done — saved locally |
| Deploy Worker (GET/PUT/LIST + API key auth) | ⬜ |
| Write `HttpStagingTransport` in Python | ⬜ |
| Migrate existing data from git to R2 | ⬜ |
| Wire into `main.py` | ⬜ |
| Verify ~100ms latency | ⬜ |

### Open questions

1. **Worker auth mechanism** — Pre-shared API key (simple) vs. HMAC request
   signing (reuses existing crypto, more secure).
2. **Existing data migration** — Script to pull staging blob + device cookie +
   ledger blocks from git and push to R2 via Worker.
3. **Mobile framework choice** — React Native vs Flutter vs native. Crypto
   library availability will be a deciding factor.
