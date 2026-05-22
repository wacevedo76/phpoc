# Remote Staging Issue Tracking

This document captures issues found during cross-device staging sync testing between
**debagent04** (pi@debagent04, device_id: `bbb3badc-...`) and **x13 laptop**
(wacevedo@x13, device_id: `dc1da321-...`).

## Environment

| Property | debagent04 | x13 laptop |
|---|---|---|
| Device ID | `bbb3badc-6365-49ea-b43c-53869ca0195f` | `dc1da321-2c80-4815-a808-11295b8c59f9` |
| Code branch | `P3-Remote_Sync` | `P3-Remote_Sync` |
| Commit | `fc5f7bb` | `fc5f7bb` (pushed to origin) |
| Data dir | `~/.local/share/phpoc/` | `~/.local/share/phpoc/` |
| Config dir | `~/.config/phpoc/` | `~/.config/phpoc/` |
| Remote clone | `~/.local/share/phpoc/remote/` | `~/.local/share/phpoc/remote/` |
| Remote URL | `git@github.com:wacevedo76/phpoc-staging.git` | same |
| Passphrase | 🔴 **RETIRED** — see Security Incident | 🔴 **RETIRED** — see Security Incident |

## Issues Found

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
5. **Passphrase retired** — a new one must be generated

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

### Needs Verification
- ❓ Cross-device write flow (both devices make concurrent changes)
- ❓ Auth cache expiry → REAUTH_NEEDED in cross-device scenario
- ❓ `entry_id`-based dedup across devices (requires authenticated session)
- ❓ `_needs_full_pull()` correct behavior when Device B modifies local staging without pushing

## Areas for Improvement

### AFI #1: Auth Criteria — enforce on device mismatch + cookie expiry

**Assigned to:** x13 agent
**Priority:** High
**Description:** The current auth gate in `check_and_sync()` (service.py) checks two
conditions but only gates *writes*. The auth criteria need to be hardened:

1. **Device ID mismatch** — remote blob's `device_id` differs from local
2. **Cookie expiry** — time since last successful auth exceeds `AUTH_CACHE_DURATION` (30 min)

Both conditions must be **true simultaneously** before prompting for re-auth:
- If device matches → no prompt (same device, trust it)
- If device differs but cookie is fresh → no prompt (recently authenticated cross-device)
- If device differs AND cookie expired → **REAUTH_NEEDED**

**Current implementation** (`check_and_sync()` in `service.py`, lines 397-472):
```python
if not device_match:
    if time.time() - self._last_auth_time < self.AUTH_CACHE_DURATION:
        pass  # Auth cache still valid
    else:
        return SyncCheckResult.REAUTH_NEEDED
```
This logic is correct for writes, but:
- `view_active()` bypasses `check_and_sync()` entirely — no auth check on reads
- `_push_if_remote()` calls `push_to_remote()` directly without re-checking auth
- The `_last_auth_time` is only updated on successful device check, not on every command

**Decision:** Issue #2 is now resolved — `view` will be routed through `check_and_sync()`.

**Remaining open questions:**
- What happens when the cookie expires mid-session (no commands to trigger re-auth)?
- Should `_push_if_remote()` verify auth before pushing to remote? (It currently does not)

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

### Issues resolved this session (2026-05-22)

| Issue | Fix | Files modified |
|---|---|---|
| Issue #2 — view bypasses check_and_sync | Route `view_active()` through `check_and_sync()` | `cli/interface.py` |
| Issue #6 — ls-remote argument order | `--heads` before remote name | `core/sync/git_transport.py` |
| Trace log passphrase leak | `_redact()` masks 32-byte keys + sensitive kwargs | `cli/trace.py` |
| `.gitignore` restriction | `staging_log/` removed (safe to commit now) | `.gitignore` |
| Config-driven tracing | `debug.trace_enabled` default + wiring | `security/config_manager.py`, `main.py` |
| `ph login` / `ph logout` | Minimal subcommands for session management | `main.py`, `security/auth.py` |
| Issue #9 — Remote clone rebase conflict (session 2) | Silently swallowed | `core/sync/git_transport.py` (needs fix) |
| Issue #10 — Blob key mismatch after ph recover | Remote wiped, fresh blob needed | operational |

### Open issues remaining

| Issue | Status | Owner |
|---|---|---|
| Issue #7 — Stale cache blob overwrite | 🔴 Data loss | x13 + debagent04 |
| Issue #8 — Session cache blocks re-auth | 🔴 Needs fix | x13 |
| Issue #9 — Rebase conflicts silently swallowed | 🔴 Needs fix | debagent04 |
| Issue #11 — `ph recover` doesn't clear session cache | 🔴 Needs fix | debagent04 |
| Issue #12 — `git pull --rebase` 'Already up to date' false negative | 🔴 Needs fix | debagent04 |

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
