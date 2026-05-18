# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync` (on top of `04587ee` — laptop's `require_auth` + `ph list active` commits merged)
- **Tests:** 1025 total, all passing
- **Config dir:** `~/.config/phpoc/`
- **Data dir:** `~/.local/share/phpoc/`
- **Remote clone:** `~/.config/phpoc/remote/` — clone of `git@github.com:wacevedo76/phpoc-staging.git`

## Two-Machine Setup

### Machine 1: Laptop x13 (wacevedo@x13)
- **Hostname:** x13 (same OS as debagent04)
- Code at `~/code/Testing/phpoc/` (rsynced from debagent04)
- SSH key set up for GitHub
- Has ledger initialized with passphrase **"m0r3m0n3y"**
- Has active staging entries (two "Working on phpoc" tasks)
- Has remote clone at `~/.config/personal_history_poc/remote/` (legacy path, XDG data dir `~/.local/share/phpoc/` does not exist yet)
- Config at `~/.config/phpoc/config.json`
- **Device ID:** `e0cd83b8-0ce5-493d-af48-350121813f8d`

### Machine 2: debagent04 (pi@debagent04)
- Code at `~/phpoc/` (the repo source of truth)
- SSH key set up for GitHub
- Config at `~/.config/phpoc/config.json` with `remote.git_remote_url` set
- Ledger copied from laptop (same passphrase → same master key → blob deobfuscation works on properly encrypted blobs)
- `phpoc view` confirmed working — shows both "Working on phpoc" tasks after deobfuscation
- **Device ID:** `bbb3badc-6365-49ea-b43c-53869ca0195f`

### Remote Repo (`git@github.com:wacevedo76/phpoc-staging.git`)

**Current remote blob history (origin/main):**
| Commit | Time | Size | Status | Device |
|--------|------|------|--------|--------|
| `b75421b` | 14:54:44 | 1779 B | **❌ UNENCRYPTED plain JSON** | debagent04 (`bbb3badc`) |
| `0127dc6` | 14:54:29 | 31 B | **❌ Plain text** `{"test":"debagent04 push fix"}` | — |
| `2eeeab2` | 15:30:00 | 65592 B | ✅ Properly encrypted | debagent04 (`bbb3badc`) — 3 entries |
| `8e26d32` | 15:20 | 65592 B | ✅ Properly encrypted | laptop x13 (`e0cd83b8`) — push from laptop's session |
| `c3eef75` | 13:47:32 | 65592 B | ✅ Properly encrypted | laptop x13 |
| `a951f75` | 13:42:33 | 65592 B | ✅ Properly encrypted | laptop x13 |
| `a5986e3` | 13:37:51 | 65592 B | ✅ Properly encrypted | laptop x13 |
| `99e0974` | 13:34:59 | 65592 B | ✅ Properly encrypted | Phone (`9847c408`) |

**Note:** Commits `0127dc6` and `b75421b` were debug/test artifacts from earlier session. Remote blob is now properly encrypted (commit `2eeeab2`, device `bbb3badc`).

## P3 Implementation Status

**All P3 features implemented and tested:**

| Feature | Status |
|---------|--------|
| `GitStagingTransport.pull()` | ✅ — clones, pulls, reads blob |
| `GitStagingTransport.push()` | ✅ — writes, commits, pushes |
| Pre-push pull to minimize conflicts | ✅ — always pulls before writing+committing |
| Stuck rebase recovery | ✅ — `_recover_git_abort_stuck_rebase()` |
| Detached HEAD recovery | ✅ — `_ensure_on_branch()` |
| `--autostash` on pull | ✅ — handles local unstaged changes |
| Blob obfuscation push | ✅ — pads + encrypts with HMAC sub-key |
| Blob deobfuscation pull | ✅ — auto-resolves key from `crypto.master_key` |
| `GIT_TERMINAL_PROMPT=0` | ✅ — no git credential prompts |
| Config comment stripping | ✅ — `//` lines in config JSON handled |
| `_ensure_remote_url()` | ✅ — syncs clone origin URL with config |
| Auto-push after write | ✅ — all `add` commands push to remote |
| Pull+merge on view | ✅ — `view_active` pulls + merges remote entries |
| Auth-only retry | ✅ — only retries push on non-ff rejection, not auth errors |
| End-to-end cross-device | ✅ — debagent04 can read laptop's pushed blobs |

## P3 Commits (chronological, 13 commits)
```
305a8d7 feat: implement GitStagingTransport + blob obfuscation (P3-Remote_Sync)
bd60bf2 feat: wire remote sync into main.py and add config wiring tests
2c859ec fix: strip // comment lines from config JSON before parsing
a972294 feat: auto-push to remote and auto-pull on view
394b950 fix: suppress git credential prompts and improve clone error handling
6d021f5 fix: sync remote URL from config and handle empty remote gracefully
83044ee fix: pull+merge on view even when device_id mismatches
a327bdb fix: duplicate task IDs and push auth error handling
3b1db1c fix: RemoteStagingSync.pull() falls back to crypto.master_key
e0eb8d7 fix: detached HEAD and stuck rebase after push retry
e2930a0 perf: pull before push in GitStagingTransport
723d0f5 docs: compact SESSION_HANDOFF for P3 cross-device handoff
cb17255 fix: _ensure_on_branch uses git checkout -B + warn on unencrypted push
```

## Key Fixes Made in This Session

1. **Detached HEAD after rebase**: `push()` retry path was leaving the clone in detached HEAD state, causing subsequent pushes to fail with "You are not currently on a branch." Fixed by `_ensure_on_branch()` which re-attaches HEAD via `git branch -f main && git checkout main`.

2. **Stuck rebase**: `git pull --rebase` could leave an interactive rebase in progress if it was interrupted. Fixed by `_recover_git_abort_stuck_rebase()` which aborts any stuck rebase before pull/push ops.

3. **Pull before push**: Added a pre-push pull (with `--rebase --autostash`) so the local clone is already up-to-date before writing+committing, avoiding non-fast-forward rejections in the common case.

4. **`pull()` fallback to `crypto.master_key`**: Previously `check_and_sync()` called `pull(master_key=None)` which couldn't deobfuscate blobs pushed with a real key. Now resolves key from `crypto.master_key` automatically.

5. **Duplicate task IDs in view**: `id_map` was keyed by title only, so two tasks with the same title showed the same #2. Fixed by enumerating active entries directly with sequential IDs.

6. **`_ensure_on_branch()` fix**: Changed from `git branch -f main HEAD` followed by `git checkout main` to `git checkout -B main`. The former fails with "cannot force update the branch 'main' used by worktree at ..." when HEAD is detached in the same repo. The `-B` flag atomically handles this.

7. **No unencrypted pushes**: `_push_if_remote()` now checks for a valid 32-byte master_key before pushing. If no key is available (unauthenticated session), it prints a warning and skips the push instead of writing plaintext JSON to GitHub.

## Next Steps
1. ✅ `"add"` added to `require_auth` — `add` commands now require session (ensures master_key for obfuscation)
2. ✅ `ph list active` added — shows only running tasks
3. ✅ `ph list all` now shows all entries (including active)
4. 🔜 Test cross-device: `ph sync remote` + `ph list all` on both machines

## Key Files
| File | Purpose |
|------|---------|
| `core/sync/git_transport.py` | `GitStagingTransport` — git CLI push/pull with clone, retry, auth handling |
| `domain/staging/remote_sync.py` | `RemoteStagingSync` — blob obfuscation, device check, pull/push coordination |
| `domain/staging/service.py` | `StagingService` — `check_and_sync()` and `push_to_remote()` |
| `cli/interface.py` | `CLIInterface` — `view_active` with remote pull+merge, `_push_if_remote` |
| `main.py` | Wiring: reads config, creates transport, device provider, passes to service |
| `tests/test_git_transport.py` | 37 tests for transport + obfuscation |
| `tests/test_remote_config_wiring.py` | 13 tests for config wiring |
