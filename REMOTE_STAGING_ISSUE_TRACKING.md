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

**Status:** 🔄 Needs rework — route view through check_and_sync
**Detail:** `view_active()` in `cli/interface.py` calls `_remote.pull()` + `_local.write_entries(merged)`
directly, bypassing `check_and_sync()`. This means:
- No auth gate triggered (read-only → fine)
- No freshness check (always pulls)
- No push back after merge (no need — read-only)
- Merge result stays in local staging until next write command pushes

**Decision:** `ph view` MUST go through `check_and_sync()` like writes do, so the
auth criteria (device mismatch + cookie expiry) are enforced on reads too.
This ensures the staging area always reflects the remote source of truth.

**Required change:** Replace the direct `_remote.pull()` + merge in `view_active()`
with a call to `self._service.check_and_sync()`. After sync, read from local staging.
This makes the auth flow identical between reads and writes.

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
3. **`.gitignore`** updated — `staging_log/` added (trace logs contain master key)
4. **Force-pushed** to origin — clean history live
5. **Passphrase retired** — a new one must be generated

### Residual risk
- Old commit hashes still accessible via direct GitHub URL
- Contact GitHub Support to purge objects from their storage (optional)

## Instrumentation: Trace Logging

**Status:** 🛠️ Active (debugging phase) — ⚠️ **staging_log/ in .gitignore: do NOT commit**

A trace-logging wrapper was added across the call chain to gain visibility into the
cross-device sync flow. All trace output goes to files in `staging_log/`, enabled via
the `PHPOC_TRACE=1` environment variable.

### Files created
- **`cli/trace.py`** — Lightweight `@trace` decorator that logs method entry/exit with
timestamps, key arguments, return values, and elapsed time (ms). Writes to timestamped
files in `staging_log/` (one per invocation). Toggled via `PHPOC_TRACE=1` env var.
- **`staging_log/`** — Output directory for trace log files (⚠️ in `.gitignore` — contains master key bytes).
- **`scripts/remove_trace_logging.sh`** — Cleanup script that removes all trace code
(imports, decorators, module, log directory) in one shot.

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
    >>> StagingService.push_to_remote(master_key=...)
      >>> RemoteStagingSync.push(...)            # ← push obfuscated blob to git
      <<< RemoteStagingSync.push  (6673.4 ms)
    <<< StagingService.push_to_remote (6673.7 ms)
  <<< CLIInterface._push_if_remote (6673.7 ms)
<<< CLIInterface.add_start (9077.3 ms)
```

### Usage

```bash
# Enable tracing for a single command
PHPOC_TRACE=1 ph add start "my task"

# Tail the latest log in another terminal
tail -f staging_log/$(ls -1t staging_log/ | head -1)

# ⚠️ NEVER commit staging_log/ files — they contain master key bytes
# staging_log/ is in .gitignore

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

### AFI #4: Same-device auth bypass — no re-auth prompt on self-pushes

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
