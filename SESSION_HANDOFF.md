# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync` (ahead of main by ~10 commits)
- **Tests:** 1022 total, all passing
- **Dependencies:** Pure Python 3.x standard library — zero external deps
- **Config dir:** `~/.config/phpoc/`
- **Data dir:** `~/.local/share/phpoc/`

## Two-Machine Setup

### Machine 1: Laptop (wacevedo@x13)
- Code at `~/code/Testing/phpoc/` (rsynced from this machine)
- Has SSH key set up for GitHub
- Has ledger initialized with a passphrase
- Has active staging entries (the two "Working on phpoc" tasks)

### Machine 2: This Machine (pi@debagent04)
- Code at `~/phpoc/` (the repo source of truth)
- Has SSH key set up for GitHub (verified: `ssh -T git@github.com` works)
- Has config file at `~/.config/phpoc/config.json` with `remote.git_remote_url` set
- Has git clone at `~/.config/phpoc/remote/` — pulled the remote blob successfully
- **No ledger initialized** — never ran `phpoc init`, so no passphrase set
- No staging file (`~/.local/share/phpoc/staging.json` doesn't exist)

### Remote Repo
- `git@github.com:wacevedo76/phpoc-staging.git`
- Contains obfuscated staging blob at `staging/blobs/current.json`
- Blob was pushed from laptop using laptop's passphrase-derived master key

## What Works
| Feature | Status |
|---------|--------|
| `GitStagingTransport.pull()` | ✅ — clones, pulls, reads blob |
| `GitStagingTransport.push()` | ✅ — writes, commits, pushes (with retry on non-ff) |
| Blob obfuscation push | ✅ — pads + encrypts with HMAC sub-key |
| Blob deobfuscation pull | ✅ — auto-resolves key from `crypto.master_key` |
| `GIT_TERMINAL_PROMPT=0` | ✅ — no git credential prompts |
| Config comment stripping | ✅ — `//` lines in config JSON handled |
| `_ensure_remote_url()` | ✅ — syncs clone origin URL with config |
| Auto-push after write | ✅ — all `add` commands push to remote |
| Pull+merge on view | ✅ — `view_active` pulls + merges remote entries |
| Duplicate title ID fix | ✅ — enumerates active entries directly, not by title key |
| Auth-only retry | ✅ — only retries push on non-ff rejection, not auth errors |

## What Doesn't Work (Cross-Device)
1. **Blob deobfuscation on this machine** — needs the same passphrase as laptop. This machine has no ledger/init/passphrase. `phpoc view` authenticates first, then tries to pull+merge, but deobfuscation fails because the crypto has no key.

2. **No staging file on this machine** — `~/.local/share/phpoc/staging.json` doesn't exist. Even if pull succeeded, there's nothing to merge into.

## Next Steps (for user)
The user is going to:
1. Rsync `~/phpoc/` → laptop `~/code/Testing/phpoc/`
2. Run `pi` (the AI assistant) on the laptop machine
3. Debug the cross-device sync from there (laptop has working auth + staging)

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

## P3 Commits (chronological)
| Commit | What |
|--------|------|
| `bd60bf2` | Wire remote config → transport → service in main.py; 13 config wiring tests |
| `2c859ec` | Strip `//` comments from config JSON |
| `a972294` | Auto-push after every write command; auto-pull on view |
| `394b950` | `GIT_TERMINAL_PROMPT=0` — no git password prompts |
| `6d021f5` | Sync remote URL with config; graceful empty-repo handling |
| `83044ee` | Pull+merge on view even with device mismatch (read-only safe) |
| `a327bdb` | Fix duplicate task IDs; fix push auth error handling |
| `3b1db1c` | `pull()` falls back to `crypto.master_key` for deobfuscation |
