# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `76209c0` (Phase B/C + stale-remote fix + onboarding)
- **Tests:** 1199 all passing (0 failures)
- **Remote staging:** Fresh blob pushed at `4f9b2d2` (x13 device)
- **Remote ledger sync:** ✅ **Implemented** — `domain/ledger/remote_sync.py`
- **Device Cookie:** ✅ **Implemented** — fast-path cross-device identity check
- **ADR-023:** 🔮 Design direction — replace git/SSH with Cloudflare Worker + R2 for mobile-friendly HTTP transport
- **Next focus:** 🚀 **Phase 1 — Cloudflare Worker deploy + HttpStagingTransport**
- **Latency strategy:** ✅ `_Operational-ph_Staging-latency-issue-strategy.md` — 3-phase plan (A ✅, B ✅, C ✅ daemon implemented)
- **Phase A (reads):** `cli/background.py` (430 lines) — instant reads via background subprocess, notification IPC, debounce lock, cookie auto-renewal. 31 tests.
- **Phase B (writes):** `cli/wal.py` (350 lines) — WAL-backed instant writes, crash-safe deferred push, replay at startup, background push subprocess. 54 tests.
- **Phase C (daemon):** ✅ Implemented. `cli/daemon.py` (~330 lines), `cli/daemon_sync.py` (~160 lines), `cli/daemon_cli.py` (~25 lines). `main.py` — `ph daemon start/stop/status`. 65 tests.
- **Onboarding:** ✅ `cli/onboarding.py` (474 lines) — `ph onboarding` imports existing ledger to new device via git transport.
- **Bug fix:** `check_and_sync()` removed from write methods — stale remote was resurrecting ended tasks (MergeEngine remote-wins).
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
| `cli/wal.py` | 🆕 WAL lifecycle, crash recovery, `_spawn_background_push()`, `format_wal_status()` |
| `tests/test_background_sync.py` | 31 tests — Phase A background cookie check + notifications |
| `tests/test_wal.py` | 54 tests — Phase B WAL lifecycle + deferred push |
| `cli/daemon.py` | 🆕 ~330 lines — PhDaemon lifecycle, DebounceQueue, FileWatcher, event loop, `_publish_status()` |
| `cli/daemon_sync.py` | 🆕 ~160 lines — SyncWorker retry/conflict/session, SyncResult |
| `cli/daemon_cli.py` | 🆕 ~25 lines — `ph daemon start/stop/status` handlers |
| `cli/onboarding.py` | 🆕 474 lines — `ph onboarding` full flow: git remote → seed → pull ledger/staging/index → extract identity → new passphrase → verify |
| `tests/test_daemon.py` | 🆕 41 tests — Phase C daemon lifecycle, DebounceQueue, event loop, file watcher, status publishing |
| `tests/test_daemon_sync.py` | 🆕 24 tests — Phase C SyncWorker session/retry/conflict, pull_check |
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

## Next Phase: Mobile-First Infrastructure

**Status:** 🚀 **New direction** — replace git/SSH transport with serverless HTTP (Cloudflare Worker + R2) to enable mobile clients and eliminate ~5s latency.

### Why the change

The Device Cookie benchmark proved that **99.9% of latency is SSH handshake**, not
data transfer or crypto. Even the 32-byte fast path takes ~5s because of
`git pull --rebase` over SSH. This is unfixable within the git transport — git is
designed for source control, not real-time CLI checks.

More importantly, **mobile devices don't have git or SSH** — a fundamental
architectural barrier. The new transport solves both problems at once.

### Target architecture

```
┌──────────────┐     HTTPS (GET/PUT)    ┌──────────────┐     S3 API      ┌────────┐
│ Python CLI   │ ──────────────────────►│ Cloudflare   │ ──────────────►│  R2    │
│ (and mobile) │ ◄─── HTTP (304/200) ───│ Worker       │ ◄──────────────│ Bucket │
└──────────────┘                        └──────────────┘               └────────┘
```

- **Worker:** ~40 lines of TypeScript — stateless pass-through (GET/PUT/LIST)
- **R2 bucket:** Single bucket for both staging AND ledger data
- **HttpStagingTransport:** ~100 lines of Python — implements `AbstractStagingTransport`
- **ETag-based freshness:** `304 Not Modified` = zero bytes transferred = instant

### Phase 1: Worker + Python CLI (this sprint)

| Task | Effort | Status |
|------|--------|--------|
| Create R2 bucket (`phpoc-data`) | ~10 min | ✅ Done (2026-05-24) |
| Create R2 API token | ~5 min | ✅ Done — `phpoc-r2-bucket` token saved locally |
| Deploy Worker (GET/PUT/LIST + API key auth) | ~1 hr | ⬜ |
| Write `HttpStagingTransport` in Python | ~2 hrs | ⬜ |
| Migrate existing data from git to R2 | ~1 hr | ⬜ |
| Wire into `main.py`, verify ~100ms latency | ~1 hr | ⬜ |

### Phase 2: Mobile MVP (next)

| Task | Effort |
|------|--------|
| Re-implement crypto (PBKDF2, AES-CTR, HMAC) in mobile framework | ~1-3 days |
| Basic staging read/write via Worker HTTP API | ~1 day |
| Device Cookie identity | ~1 day |
| Minimal UI (start/stop/view) | ~1 week |

### Phase 3: Staging reconciliation + Ledger sync (deferred)

Staging reconciliation strategy definition is deferred until after the mobile MVP
is working — the user expects to identify more issues with a real mobile client
than by designing in the abstract.

### Key design decisions (ADR-023)

| Decision | Detail |
|----------|--------|
| **Transport** | `HttpStagingTransport` replaces `GitStagingTransport` |
| **Storage** | Cloudflare R2 bucket (`phpoc-data`) — one bucket for both staging + ledger |
| **Server** | Cloudflare Worker — stateless pass-through, ~40 lines |
| **Auth** | Pre-shared API key (in Worker) |
| **Freshness** | ETag / `If-None-Match` / `304 Not Modified` |
| **Cost** | $0.00/mo at personal scale (R2 free tier) |
| **Mobile** | Same HTTP API — no new backend needed |

See `ARCHITECTURAL_DECISIONS.md` → ADR-023 for full details.

### Files changed (this session)
```
 M ARCHITECTURAL_DECISIONS.md              (added ADR-023: Serverless HTTP Transport)
 M REMOTE_STAGING_ISSUE_TRACKING.md        (added Mobile-First section, Phase 1 progress)
 M SESSION_HANDOFF.md                      (updated to mobile-first direction, Phase 1 checklist)
```

## Recent Commits (this session)
```
8b5a529  fix: remove check_and_sync from write methods — stale-remote resurrection cycle
76209c0  feat: ph onboarding — import existing ledger to new device via git transport
```
All pushed to origin.

## Next Steps

### Completed this session
1. [x] **Stale-remote fix:** removed `check_and_sync()` from all 6 write methods in `StagingService`. Write methods are now local-only. Remote sync handled by WAL+background push (Phase B) and daemon (Phase C). Fixes the cycle: `ph end 1` → stale remote resurrects ended task → `ph end 1` cycles forever.
2. [x] **Onboarding:** `cli/onboarding.py` (474 lines) — `ph onboarding` command imports existing ledger to a new device: git remote → seed → pull ledger/staging/index → extract identity from genesis → set passphrase → re-seal/re-sign → verify.

### Phase 1: Worker + R2 (tomorrow)
1. [x] Create Cloudflare R2 bucket (`phpoc-data`)
2. [x] Create R2 API token (`phpoc-r2-bucket`, saved locally)
3. [ ] Deploy Worker (GET/PUT/LIST + API key auth) — ~40 lines TypeScript
4. [ ] Write `core/sync/http_transport.py` — ~100 lines implementing `AbstractStagingTransport`
5. [ ] Push existing staging data from git to R2 via Worker
6. [ ] Update `main.py` to use `HttpStagingTransport`
7. [ ] Verify CLI latency drops from ~5000ms to ~100ms

### Phase 2: Mobile MVP (next)
1. [ ] Re-implement crypto primitives for mobile (PBKDF2, AES-CTR, HMAC-SHA256)
2. [ ] Build basic staging CRUD via Worker HTTP API
3. [ ] Device Cookie for fast-path identity
4. [ ] Minimal mobile UI (start/stop/view activities)

### On debagent04 (after push)
```
git fetch origin && git reset --hard origin/P3-Remote_Sync
```
