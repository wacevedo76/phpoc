# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `fc5f7bb` (pushed to origin)
- **Tests:** all passing

## Two Machines

| | x13 (laptop) | debagent04 (pi) |
|---|---|---|
| Device ID | `dc1da321-2c80-4815-a808-11295b8c59f9` | `bbb3badc-6365-49ea-b43c-53869ca0195f` |
| Passphrase | 🔴 **RETIRED** — see Security Incident below | 🔴 **RETIRED** — see Security Incident below |
| Remote URL | `git@github.com:wacevedo76/phpoc-staging.git` | same |
| Remote clone | `~/.local/share/phpoc/remote/` | `~/.local/share/phpoc/remote/` |

## Trace Logging (Active Debugging)
- **`cli/trace.py`** — `@trace` decorator logs method entry/exit with timing → `staging_log/` (one file per invocation)
- **Enabled:** `export PHPOC_TRACE=1` in `~/.zshrc`
- **22 methods traced** across 5 files + `GitStagingTransport._git()` for full chain visibility
- **Cleanup:** `./scripts/remove_trace_logging.sh` reverts everything
- **⚠️ SECURITY:** `staging_log/` now in `.gitignore` — trace logs contain master key bytes, must never be committed

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
| `scripts/change_passphrase.py` | Re-encrypts recovery seed with a new passphrase (data preserved) |
| `REMOTE_STAGING_ISSUE_TRACKING.md` | Full issue tracking + areas for improvement |
| `staging_log/` | Trace output directory (⚠️ in `.gitignore` — contains master key bytes) |

## Known Issues & Areas for Improvement (see REMOTE_STAGING_ISSUE_TRACKING.md)

### Auth Criteria (AFI #1 — x13)
Re-auth must fire only when: **device_id differs** AND **cookie (> 30 min) expired**. Currently `view_active()` bypasses `check_and_sync()` entirely — no auth on reads. Need to decide if reads should also enforce auth.

### Latency (AFI #2 — x13)
Critical finding: `_has_remote_refs()` (calls `ls-remote`) runs **twice per command** — once in pull, once in push. Each takes ~2.5s to GitHub. Total command time ~9s. **~5s of that is redundant ls-remote calls.** Fix: cache `_has_remote_refs()` result per invocation or drop it for established repos.

### Device Hand-off Sync (AFI #3 — debagent04 primary)
4 test scenarios: A→B hand-off, concurrent edits (race), stale cookie re-auth, local-only changes lost on push from other device. Mitigation: enforce push on every write (done), add dirty-flag check before pull.

## 🔴 Security Incident

### Passphrase exposure (`m0r3m0n3y`)
- Commits `1c1e1f2` and `4533af8` on `P3-Remote_Sync` contained the passphrase in markdown docs
- Push to origin made it publicly visible on GitHub
- GitHub web edit `1823db7` only obscured `REMOTE_STAGING_ISSUE_TRACKING.md` (not `SESSION_HANDOFF.md`)

### Master key exposure (trace logs)
- `staging_log/` was tracked in git; trace logs captured `master_key` bytes in cleartext
- Exposed in commits `c764bea` (was 93236d5) and `98ba49c` (was 2c2f0d7)
- Master key = decoded recovery seed → recovery seed trivially derivable

### Remediation (2026-05-22)
1. **Interactive rebase** from `22ae407` — rewrote `P3-Remote_Sync` history
   - `1c1e1f2` → passphrase replaced with `PASSPHRASE_REDACTED`
   - `4533af8` → inherited clean version
2. **Trace logs stripped** from both commits that added them (during rebase)
3. **`.gitignore`** updated — `staging_log/` added to prevent future commits
4. **Force-pushed** with `--force-with-lease` — clean history now on origin
5. **Passphrase retired** — `m0r3m0n3y` will never be used again

### Status
- The old commit hashes (`1c1e1f2`, `4533af8`, `1823db7`) are still accessible via direct GitHub URL
- Contact GitHub Support to purge objects from their storage (optional)

## Recent Commits
```
fc5f7bb  Add staging_log/ to .gitignore to prevent trace logs from being committed
c08ed7c  Compact SESSION_HANDOFF.md with latest trace-logging setup and AFI tracking
152ac90  Refine REMOTE_STAGING_ISSUE_TRACKING.md per review discussion
56ded09  Add Areas for Improvement section to REMOTE_STAGING_ISSUE_TRACKING.md
613b32e  Add git transport latency tracing via @trace on _git()
5bd8eed  Add trace-logging instrumentation for cross-device sync debugging
7bac5c4  Clarify ph view auth behavior: read-only skips auth gate, writes only
2cee8c2  Add REMOTE_STAGING_ISSUE_TRACKING.md for cross-device collaboration
```
All pushed to origin.

## Next Steps
1. **On debagent04:** `git fetch origin && git reset --hard origin/P3-Remote_Sync` (after checking for unpushed work)
2. **Run `python scripts/change_passphrase.py`** to generate a new passphrase (same recovery seed, all data preserved)
3. Fix redundant `ls-remote` calls (AFI #2)
4. Test device hand-off scenarios (AFI #3)
5. When done: `./scripts/remove_trace_logging.sh`, commit cleanup, push
