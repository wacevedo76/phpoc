# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `137b544` (current — pushed to origin)
- **Tests:** all passing
- **Remote staging:** Fresh blob pushed at `4f9b2d2` (x13 device)
- **Trace logging:** Disabled (`debug.trace_enabled: false` in config)
- **Passphrase:** Updated on both devices — no longer using `m0r3m0n3y`

## Two Machines

| | x13 (laptop) | debagent04 (pi) |
|---|---|---|
| Device ID | `dc1da321-2c80-4815-a808-11295b8c59f9` | `bbb3badc-6365-49ea-b43c-53869ca0195f` |
| Passphrase | 🟢 **Updated** (via `ph recover`) | 🟢 **Updated** (via `ph recover`) |
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
- **Resolved:** Both devices re-authenticated via `ph recover` with original recovery seed (2026-05-22)

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
- Both devices now use a new passphrase (set via `ph recover` with original seed)

## Next Phase: Remote Ledger Sync

**Status:** Design finalized (2026-05-22), not yet implemented.

See `REMOTE_STAGING_ISSUE_TRACKING.md` → Next Phase: Remote Ledger Sync for full design.

**Implementation order:**
1. Create `domain/ledger/remote_sync.py` — `RemoteLedgerSync` class (push, pull, verify, recover)
2. Wire subcommand `ph sync remote_ledger` in `main.py`
3. Write `tests/test_remote_ledger_sync.py` (~24 tests against local bare repos)
4. Cross-device testing (x13 → debagent04 round-trip)

## Recent Commits
```
137b544  fix: _last_auth_time = 0.0 causes false REAUTH_NEEDED after ph login
ea87561  fix: rename 'sync remote' to 'sync remote_staging' for clarity
566f1cb  docs: update ADR-014 and CHANGELOG for recover session cache fix
389e268  fix: cache master key after ph recover
d7ddf2e  Update REMOTE_STAGING_ISSUE_TRACKING.md with session 2 incident + add trace logs
3b8a3aa  adds logs
14f50f6  fix: handle undecryptable timestamps in list/view (key mismatch from ledger)
e6b173f  adds staging_log
cbc3a92  fix: cross-device sync, trace redaction, login/logout, ls-remote arg order
912739e  Doc: add AFI #4 — same-device auth bypass observed + blob decryption verification
```
All pushed to origin.

## Next Steps
1. **On debagent04:** `git fetch origin && git reset --hard origin/P3-Remote_Sync`
2. ~~Set new passphrase on both devices~~ ✅ **Done**
3. Implement **remote ledger sync** (see Next Phase section above)
4. Fix redundant `ls-remote` calls (AFI #2)
5. Test device hand-off scenarios (AFI #3)
6. When done: remove trace logging, commit cleanup, push
