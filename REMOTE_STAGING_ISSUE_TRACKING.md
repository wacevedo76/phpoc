# Remote Staging Issue Tracking

This document captures issues found during cross-device staging sync testing between
**debagent04** (pi@debagent04, device_id: `bbb3badc-...`) and **x13 laptop**
(wacevedo@x13, device_id: `dc1da321-...`).

## Environment

| Property | debagant04 | x13 laptop |
|---|---|---|
| Device ID | `bbb3badc-6365-49ea-b43c-53869ca0195f` | `dc1da321-2c80-4815-a808-11295b8c59f9` |
| Code branch | `P3-Remote_Sync` | `P3-Remote_Sync` |
| Commit | `22ae407` | (pull from origin) |
| Data dir | `~/.local/share/phpoc/` | `~/.local/share/phpoc/` |
| Config dir | `~/.config/phpoc/` | `~/.config/phpoc/` |
| Remote clone | `~/.local/share/phpoc/remote/` | `~/.local/share/phpoc/remote/` |
| Remote URL | `git@github.com:wacevedo76/phpoc-staging.git` | same |
| Passphrase | `PASSPHRASE_REDACTED` | `PASSPHRASE_REDACTED` |

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

**Status:** ✅ By design (confirmed working)
**Detail:** `view_active()` in `cli/interface.py` calls `_remote.pull()` + `_local.write_entries(merged)`
directly, bypassing `check_and_sync()`. This means:
- No auth gate triggered (read-only → fine)
- No freshness check (always pulls)
- No push back after merge (no need — read-only)
- Merge result stays in local staging until next write command pushes

**Cross-device flow still works:** Write commands (`add end`, `add start`, etc.) go through
`check_and_sync()` → device check → pull+merge → push.

**Auth prompt only triggers on writes, not reads.** Running `ph view` will never prompt
even if the auth cache is expired and the remote device differs. To test the auth flow,
use a write command like `ph add start "test"` — this goes through `check_and_sync()`
which compares device IDs and checks the 30-minute auth cache before allowing the merge.

The `view_active()` method intentionally skips all auth for minimal latency on read-only
operations. The auth gate is only relevant when a write might clobber another device's data.

### Issue #3: _needs_full_pull freshness optimization can skip cross-device pull

**Status:** ❓ Needs investigation
**Scenario:** Device A pushes blob → Device B pulls it (different device, auth OK) → merges →
Device B runs another read (all same-device, no push) → `ph view` uses direct pull (bypasses
freshness check) → works fine. But if Device B runs a **write command** like `add start`,
`check_and_sync()` calls `_needs_full_pull()` which may skip if `updated_at <= _last_push_at`.

**Observation from testing:** The direct pull in `view_active()` worked for reads. Writes go
through `check_and_sync()` and freshness optimization is same-device only. Need to verify
cross-device write flow doesn't get incorrectly skipped.

### Issue #4: plain: prefix entries (NoAuth path) lack entry_id

**Status:** ❓ Needs investigation
**Observation:** All entries in the cross-device test have `plain:` prefixed timestamps and
`entry_id: ""`. The stable entry ID optimization only generates UUIDs when `append()` is
called with an authenticated `CryptoManager`. `NoAuthCryptoManager` entries bypass UUID
generation.

**Impact:** Merge dedup falls back to `(title, start_epoch)` for these entries. Same-title
entries from different devices are not merged (different start_epoch) — they both survive.
This is correct behavior but means cross-device `end`/`pause` by title may hit the wrong
entry if two same-named tasks run concurrently.

### Issue #5: Session cache is 32 raw bytes in /dev/shm

**Status:** ℹ️ Works but fragile
**Detail:** `/dev/shm/phpoc_session` stores the master key as 32 raw bytes (not hex-encoded).
The session read code handles this correctly. No issue, just documented for awareness.

## Instrumentation: Trace Logging Added

**Status:** 🛠️ Active (debugging phase)

A trace-logging wrapper was added across the call chain to gain visibility into the
cross-device sync flow. All trace output goes to files in `staging_log/`, enabled via
the `PHPOC_TRACE=1` environment variable.

### Files created
- **`cli/trace.py`** — Lightweight `@trace` decorator that logs method entry/exit with
timestamps, key arguments, return values, and elapsed time (ms). Writes to timestamped
files in `staging_log/` (one per invocation). Toggled via `PHPOC_TRACE=1` env var.
- **`staging_log/`** — Output directory for trace log files.
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

**Open questions:**
- Should read-only `ph view` also enforce auth when device differs + cookie expired?
  (Currently it never prompts — see Issue #2)
- What happens when the cookie expires mid-session (no write commands to trigger re-auth)?
- Should `_push_if_remote()` verify auth before pushing to remote?

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

**Mitigation ideas:**
- Enforce push on every write (already done in `_push_if_remote()`)
- Add a dirty-flag check before pull: warn if local has un-pushed changes
- Investigate whether `_needs_full_pull()` correctly triggers a merge when
  device_id differs (currently returns True for different device — correct)
