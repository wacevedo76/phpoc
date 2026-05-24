# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `937b491` (plus uncommitted files — see below)
- **Tests:** all passing (2 pre-existing failures unrelated to changes)
- **Remote staging:** Fresh blob pushed at `4f9b2d2` (x13 device)
- **Remote ledger sync:** ✅ **Implemented** — `domain/ledger/remote_sync.py` (new), `core/sync/git_transport.py` (+list_files), `main.py` (+remote_ledger subcommand)
- **Device Cookie:** ✅ **Implemented** — fast-path cross-device identity check via deterministic 32-byte HMAC cookie. Skips staging blob pull+decrypt when cookie matches remotely.
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
| `domain/ledger/remote_sync.py` | `RemoteLedgerSync`: push/pull ledger blocks to/from remote git repo |
| `domain/staging/remote_sync.py` | Blob obfuscation (AES-CTR + tiered padding), device check, pull/push, **pull_cookie/push_cookie** |
| `domain/staging/service.py` | Single-pull `check_and_sync()`, freshness optimization, **Device Cookie fast path** |
| `domain/cookie/device_cookie.py` | **NEW** — Deterministic HMAC cookie for cross-device identity. `create()`, `is_valid_locally()`, `matches()`, `destroy_locally()` |
| `domain/staging/local_cache.py` | Stable `entry_id` UUIDs on every entry |
| `domain/staging/merge_engine.py` | Dedup by `entry_id` (fallback `(title, epoch)` for legacy entries) |
| `cli/interface.py` | `view_active()` with remote pull+merge, `_push_if_remote()` after every write |
| `cli/trace.py` | `@trace` decorator — logs entry/exit/timing to `staging_log/` |
| `scripts/remove_trace_logging.sh` | Reverts all trace code (imports, decorators, module, logs) |
| `scripts/change_passphrase.py` | Re-encrypts recovery seed with a new passphrase (data preserved) |
| `REMOTE_STAGING_ISSUE_TRACKING.md` | Full issue tracking + areas for improvement |
| `staging_log/` | Trace output directory (⚠️ in `.gitignore` — contains master key bytes) |

## Device Cookie — Fast-Path Cross-Device Check (AFI #1)

**Status:** ✅ **Implemented** (2026-05-24)

### What it solves
The Device Cookie eliminates the **circular dependency** where you needed to decrypt the
full staging blob (~64KB+) just to find out *who* encrypted it. The blob's `device_id`
field is inside the encrypted payload — you need the master key to read it, but you
need to know if the device matches to decide whether auth is needed.

### Design
- **Cookie** = `HMAC-SHA256(cookie_key, device_id + ":" + epoch_ms)` → **32 bytes**
- **Deterministic**: same inputs → same byte-for-byte output every time
- **Encrypted form**: Only the 32 HMAC bytes are pushed to remote — no device_id,
  no epoch, no profiling attack vector
- **TTL**: Plaintext `{"created_at": epoch_ms}` stored locally only. Never pushed.
  TTL defaults to 30 minutes, configurable via `cookie.ttl_minutes`.

### Flow

```
Before every operation (check_and_sync):
  1. Local cookie valid? (TTL not expired)
     No → skip to slow path
     Yes → pull REMOTE cookie (32 bytes, fast, no decrypt)
         └── Remote cookie matches?
             YES → READY (same device, same session → staging is in sync)
             No  → fall through to slow path

  2. Slow path: pull + decrypt full staging blob, device check, merge

After every write (push_to_remote):
  → Create fresh cookie locally
  → Push_cookie() to remote (before pushing blob)
  → Push blob
```

### Files
| File | Change |
|------|--------|
| `domain/cookie/device_cookie.py` | **NEW** — `DeviceCookie` class with create, is_valid_locally, matches, destroy_locally |
| `domain/staging/remote_sync.py` | Added `pull_cookie()` + `push_cookie()` methods |
| `domain/staging/service.py` | Fast-path in `check_and_sync()`, cookie creation in `push_to_remote()` |
| `security/config_manager.py` | Added `cookie.ttl_minutes: 30` + `cookie.enabled: true` defaults |
| `main.py` | Both StagingService instantiations pass `cookie_ttl_minutes` + `data_dir` |

### Security properties
- Remote only stores 32 bytes of HMAC output — no device_id, no epoch
- Without master key, cookie cannot be forged or traced to a device
- TTL is enforced locally — no network round-trip needed to check expiry
- Cookie comparison is timing-safe (`hmac.compare_digest`)

## Known Issues & Areas for Improvement (see REMOTE_STAGING_ISSUE_TRACKING.md)

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

## Next Phase: Remote Staging Reconciliation

**Status:** 🔮 Next up — define and implement reconciliation strategy.

The Device Cookie fast path handles the "same device, same session" case. When the
cookie doesn't match (different device or expired session), the system must decide
how to reconcile local and remote staging. The user has declared that **remote is
the source of truth** — but the exact algorithm needs definition.

### Open questions for reconciliation design

1. **Replace local entirely?** — Remote blob replaces local entirely. All local-only
   entries are lost. Simple but destructive.

2. **Remote base + overlay local non-pushed entries?** — Remote entries take
   precedence. Local-only entries (created offline or between pushes) are preserved
   on top. Non-destructive, but can produce duplicate entries.

3. **Full merge with remote winning conflicts?** — `MergeEngine` merge with
   remote entries winning on `entry_id` collision. Most sophisticated, but
   requires careful conflict resolution.

4. **Auth on cookie mismatch vs. always?** — Current flow: cookie mismatch →
   slow path → device check → auth gate. Should the reconciliation step be
   gated on auth, or should auth be required any time remote != local?

See `REMOTE_STAGING_ISSUE_TRACKING.md` → Device Cookie Implementation → Open
questions for the current state.

### Files changed (this session)
```
 M domain/cookie/device_cookie.py          (removed unused REMOTE_PATH constant)
 M ARCHITECTURAL_DECISIONS.md              (added ADR-022: Device Cookie)
 M REMOTE_STAGING_ISSUE_TRACKING.md        (added Device Cookie section, resolved AFI #1)
 M SESSION_HANDOFF.md                      (updated next steps to reconciliation)
```

## Recent Commits
```
937b491  docs: update passphrase status, add remote ledger sync design
137b544  fix: _last_auth_time = 0.0 causes false REAUTH_NEEDED after ph login
ea87561  fix: rename 'sync remote' to 'sync remote_staging' for clarity
566f1cb  docs: update ADR-014 and CHANGELOG for recover session cache fix
389e268  fix: cache master key after ph recover
...
```
All pushed to origin.

## Next Steps
1. **On debagent04 (after push):** `git fetch origin && git reset --hard origin/P3-Remote_Sync`
2. ~~Set new passphrase on both devices~~ ✅ **Done**
3. ~~Implement remote ledger sync~~ ✅ **Done (code)**
4. ~~Implement Device Cookie (AFI #1 fast path)~~ ✅ **Done**
5. **Define Remote Staging Reconciliation strategy** ← **NEXT**
6. Write `tests/test_remote_ledger_sync.py` (~24 tests)
7. Cross-device testing: `ph sync remote_ledger` on x13 → pull on debagent04
8. Fix redundant `ls-remote` calls (AFI #2)
9. When done: remove trace logging, commit cleanup, push
