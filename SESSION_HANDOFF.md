# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync` (14 commits ahead of main)
- **Tests:** 1025 total, all passing
- **Remote clone:** `~/.config/phpoc/remote/` — clone of `git@github.com:wacevedo76/phpoc-staging.git`

## Changes from main

### New file: `core/sync/git_transport.py` (323 lines)
`GitStagingTransport` — shells out to system `git` CLI for push/pull of staging blob. Lifecycle: clone once, then pull/add/commit/push. Handles non-fast-forward rejection (pull --rebase + retry), stuck rebase abort, detached HEAD recovery (`git checkout -B main`). Always pulls before commit to minimize conflicts. `GIT_TERMINAL_PROMPT=0` to fail fast on auth errors.

### Modified: `domain/staging/remote_sync.py`
Blob obfuscation: serialized JSON padded to nearest tier (64K/128K/256K/512K), encrypted with `HMAC(MK, "blob-obfuscation")` sub-key. `pull()` and `push()` now accept `master_key` parameter. `pull()` falls back to `self._crypto.master_key` when no explicit key given. Backward-compatible: tries plaintext JSON first, falls through to deobfuscation only on failure.

### Modified: `main.py`
Remote transport wiring: reads `remote.git_remote_url` from config, creates `GitStagingTransport` + `RandomUUIDDeviceIdentityProvider`, passes to `StagingService`.

### Modified: `cli/interface.py`
`_push_if_remote()` called after every `add_oneoff/start/end/pause/unpause`. `view_active()` pulls+merges remote blob before displaying. Skips push with warning if no 32-byte `master_key` available (prevents pushing plaintext JSON).

### Modified: `storage/implementations/file_config.py`
Strips `//` comment lines from config JSON before parsing (for template-generated configs).

### Modified: `domain/staging/service.py`
`push_to_remote()` passes `master_key` through to `RemoteStagingSync.push()`. `check_and_sync()` docstring updated.

### New tests: `tests/test_git_transport.py` (37 tests)
Transport lifecycle, obfuscation round-trip, error handling (push rejection, auth errors, timeout).

### New tests: `tests/test_remote_config_wiring.py` (13 tests)
Config-driven transport creation, device identity integration.

## Two-Machine Setup

| | Laptop x13 | debagent04 |
|---|---|---|
| Code | `~/code/Testing/phpoc/` (rsynced) | `~/phpoc/` (source of truth) |
| SSH to GitHub | ✅ | ✅ |
| Passphrase | `"m0r3m0n3y"` | `"m0r3m0n3y"` |
| Ledger | ✅ initialized | Copied from laptop |
| Master key | Same (same seed) | Same |
| `view` works | ✅ | ✅ |
| Device ID | `e0cd83b8-...` | `bbb3badc-...` |
| Remote clone | `~/.config/personal_history_poc/remote/` (legacy) | `~/.config/phpoc/remote/` |

### Key constraint: `add` not in `require_auth`
`"add"` is NOT in `require_auth` (main.py:304). When no cached session exists, `add` commands get `NoAuthCryptoManager` with no `master_key`. `_push_if_remote()` prints a warning and skips the push. To push, authenticate first via `phpoc view`.

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

## Triage Log
- **2026-05-20**: Added `--show-comments`/`-c` flag to `ph view`, `ph list active`, and `ph list [all|synced|staged]` — displays inline comments on entries when the flag is passed. Touched `cli/interface.py`, `main.py`. Annotated `cli/interface.py` as HOT.
- **2026-05-19**: Confirmed `phpoc config set remote.git_remote_url ""` disables remote sync (main.py: `if remote_url:` is falsy → transport=None). Added 3 wiring tests. Touched `tests/test_remote_config_wiring.py`. No new HOT annotations.
