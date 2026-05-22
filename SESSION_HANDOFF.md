# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync` (17 commits ahead of main)
- **Commit:** `71a3fe6` (not pushed)
- **Tests:** all passing

## Two Machines

| | x13 (laptop) | debagent04 (pi) |
|---|---|---|
| Device ID | `dc1da321-2c80-4815-a808-11295b8c59f9` | `bbb3badc-6365-49ea-b43c-53869ca0195f` |
| Passphrase | `PASSPHRASE_REDACTED` | `PASSPHRASE_REDACTED` |
| Remote URL | `git@github.com:wacevedo76/phpoc-staging.git` | same |
| Remote clone | `~/.local/share/phpoc/remote/` | `~/.local/share/phpoc/remote/` |

## Trace Logging (Active Debugging)
- **`cli/trace.py`** — `@trace` decorator logs method entry/exit with timing → `staging_log/` (one file per invocation)
- **Enabled:** `export PHPOC_TRACE=1` in `~/.zshrc`
- **22 methods traced** across 5 files + `GitStagingTransport._git()` for full chain visibility
- **Cleanup:** `./scripts/remove_trace_logging.sh` reverts everything

## Key Files
| File | Purpose |
|------|---------|
| `core/sync/git_transport.py` | `GitStagingTransport` — git CLI push/pull with clone, retry, detached HEAD recovery |
| `domain/staging/remote_sync.py` | Blob obfuscation (AES-CTR + tiered padding), device check, pull/push |
| `domain/staging/service.py` | Single-pull `check_and_sync()`, freshness optimization via `_needs_full_pull()` + `_last_push_at` |
| `domain/staging/local_cache.py` | Stable `entry_id` UUIDs on every entry |
| `domain/staging/merge_engine.py` | Dedup by `entry_id` (fallback `(title, epoch)` for legacy entries) |
| `cli/interface.py` | `view_active()` with remote pull+merge, `_push_if_remote()` after every write |
| `cli/trace.py` | `@trace` decorator — logs entry/exit/timing to `staging_log/` |
| `scripts/remove_trace_logging.sh` | Reverts all trace code (imports, decorators, module, logs) |
| `REMOTE_STAGING_ISSUE_TRACKING.md` | Full issue tracking + areas for improvement |
| `staging_log/` | Trace output directory (tracked in git for cross-device access) |

## Known Issues & Areas for Improvement (see REMOTE_STAGING_ISSUE_TRACKING.md)

### Auth Criteria (AFI #1 — x13)
Re-auth must fire only when: **device_id differs** AND **cookie (> 30 min) expired**. Currently `view_active()` bypasses `check_and_sync()` entirely — no auth on reads. Need to decide if reads should also enforce auth.

### Latency (AFI #2 — x13)
Critical finding: `_has_remote_refs()` (calls `ls-remote`) runs **twice per command** — once in pull, once in push. Each takes ~2.5s to GitHub. Total command time ~9s. **~5s of that is redundant ls-remote calls.** Fix: cache `_has_remote_refs()` result per invocation or drop it for established repos.

### Device Hand-off Sync (AFI #3 — debagent04 primary)
4 test scenarios: A→B hand-off, concurrent edits (race), stale cookie re-auth, local-only changes lost on push from other device. Mitigation: enforce push on every write (done), add dirty-flag check before pull.

## Recent Commits
```
71a3fe6  Add Areas for Improvement to REMOTE_STAGING_ISSUE_TRACKING.md
2c2f0d7  Add git transport latency tracing via @trace on _git()
93236d5  Add trace-logging instrumentation for cross-device sync debugging
```
All ahead of origin — **not pushed**.

## Next Steps
1. Push to origin so debagent04 can pull the tracing setup
2. On debagent04: run `PHPOC_TRACE=1 ph add/end/view`, compare latency
3. Fix redundant `ls-remote` calls (AFI #2)
4. Test device hand-off scenarios (AFI #3)
5. When done: `./scripts/remove_trace_logging.sh`, commit cleanup, push
