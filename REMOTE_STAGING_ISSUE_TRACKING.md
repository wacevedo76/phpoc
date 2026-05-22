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
