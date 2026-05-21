# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync` (15 commits ahead of main)
- **Tests:** 1049 total, all passing
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
- **Single-pull `check_and_sync()`** — one pull instead of three. Combines device check, freshness check, and merge into a single transport pull.
- **`_needs_full_pull()`** — freshness optimization: same device + remote `updated_at <= last_push_at` → skip merge entirely.
- **`_last_push_at` tracking** — timestamp updated after every successful `push_to_remote()`, used by freshness check.
- `push_to_remote()` passes `master_key` through to `RemoteStagingSync.push()`.

### Modified: `domain/staging/local_cache.py`
- **Stable entry IDs** — every entry gets a UUID (`entry_id`) on creation, preserved across write/read cycles.
- `entry_id` included in DTOs from `read_entries()` and persisted in `write_entries()`.

### Modified: `domain/staging/merge_engine.py`
- **Entry-ID dedup** — primary dedup key changed from `(title, start_epoch)` to `entry_id` (stable UUID).
- **Backward compat fallback** — entries without `entry_id` fall back to `(title, start_epoch)` dedup.
- Added `_dedup_key()` static method.

### New tests: `tests/test_git_transport.py` (37 tests)
Transport lifecycle, obfuscation round-trip, error handling (push rejection, auth errors, timeout).

### New tests: `tests/test_remote_config_wiring.py` (13 tests)
Config-driven transport creation, device identity integration.

### New tests: `tests/test_staging_sync_optimization.py` (24 tests)
Stable entry IDs, cross-device lifecycle, freshness-based pull optimization, merge engine with entry_id, push timeout/retry behavior, auth cache interaction, offline recovery.

## Two-Machine Setup

| | Laptop x13 | debagent04 |
|---|---|---|
| Code | `~/code/Testing/phpoc/` (rsynced) | `~/phpoc/` (source of truth) |
| SSH to GitHub | ✅ | ✅ |
| Passphrase | `"PASSPHRASE_REDACTED"` | `"PASSPHRASE_REDACTED"` |
| Ledger | ✅ initialized | Copied from laptop |
| Master key | Same (same seed) | Same |
| `view` works | ✅ | ✅ |
| Device ID | `e0cd83b8-...` | `bbb3badc-...` |
| Remote clone | `~/.config/personal_history_poc/remote/` (legacy) | `~/.config/phpoc/remote/` |

## Next Steps
1. ✅ `"add"` added to `require_auth` — `add` commands now require session (ensures master_key for obfuscation)
2. ✅ `ph list active` added — shows only running tasks
3. ✅ `ph list all` now shows all entries (including active)
4. ✅ **Stable entry IDs** — every entry has a UUID for cross-device referencing
5. ✅ **Single-pull `check_and_sync()`** — one pull instead of three; freshness-based skip
6. 🔜 Test cross-device: `ph sync remote` + `ph list all` on both machines

## Key Files
| File | Purpose |
|------|---------|
| `core/sync/git_transport.py` | `GitStagingTransport` — git CLI push/pull with clone, retry, auth handling |
| `domain/staging/remote_sync.py` | `RemoteStagingSync` — blob obfuscation, device check, pull/push coordination |
| `domain/staging/service.py` | `StagingService` — single-pull `check_and_sync()`, freshness optimization, `_last_push_at` tracking |
| `domain/staging/local_cache.py` | `LocalStagingCache` — stable `entry_id` UUIDs on all entries |
| `domain/staging/merge_engine.py` | `MergeEngine` — dedup by `entry_id` (fallback `(title, epoch)` for backward compat) |
| `cli/interface.py` | `CLIInterface` — `view_active` with remote pull+merge, `_push_if_remote` |
| `main.py` | Wiring: reads config, creates transport, device provider, passes to service |
| `tests/test_git_transport.py` | 37 tests for transport + obfuscation |
| `tests/test_remote_config_wiring.py` | 13 tests for config wiring |
| `tests/test_staging_sync_optimization.py` | 24 tests for stable IDs, freshness, cross-device, offline, push timeout |

## Triage Log
- **2026-05-21**: Sync optimization: stable entry IDs, single-pull check_and_sync, freshness-based pull skip, _last_push_at tracking. Merge engine dedup by entry_id. 24 new tests. Touched `local_cache.py`, `merge_engine.py`, `service.py`, `test_staging_sync_optimization.py`.
- **2026-05-20**: Added `--show-comments`/`-c` flag to `ph view`, `ph list active`, and `ph list [all|synced|staged]` — displays inline comments on entries when the flag is passed. Touched `cli/interface.py`, `main.py`. Annotated `cli/interface.py` as HOT.
- **2026-05-19**: Confirmed `phpoc config set remote.git_remote_url ""` disables remote sync (main.py: `if remote_url:` is falsy → transport=None). Added 3 wiring tests. Touched `tests/test_remote_config_wiring.py`. No new HOT annotations.
