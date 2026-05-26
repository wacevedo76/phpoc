# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `0553f0e` (fix: switch HttpStagingTransport from urllib.request to http.client)
- **Tests:** 1267 all passing (68 HTTP transport + 1199 existing)
- **Remote staging:** Using HTTP transport via Cloudflare Worker ✅
- **Remote ledger sync:** ✅ **Implemented** — `domain/ledger/remote_sync.py`
- **Device Cookie:** ✅ **Implemented** — fast-path cross-device identity check
- **Phase 1 (HTTP transport):** ✅ **Complete** — Worker deployed, ~5000ms → near-instant latency
- **Latency strategy:** ✅ `_Operational-ph_Staging-latency-issue-strategy.md` — all phases implemented (A ✅, B ✅, C ✅, Phase 1 ✅)
- **Phase A (reads):** `cli/background.py` (430 lines) — instant reads via background subprocess, notification IPC, debounce lock, cookie auto-renewal. 31 tests.
- **Phase B (writes):** `cli/wal.py` (350 lines) — WAL-backed instant writes, crash-safe deferred push, replay at startup, background push subprocess. 54 tests.
- **Phase C (daemon):** ✅ Implemented. `cli/daemon.py` (~330 lines), `cli/daemon_sync.py` (~160 lines), `cli/daemon_cli.py` (~25 lines). `main.py` — `ph daemon start/stop/status`. 65 tests.
- **Onboarding:** ✅ `cli/onboarding.py` (474 lines) — `ph onboarding` imports existing ledger to new device via git transport.
- **Phase 1 (HTTP transport):** ✅ **Complete** — `HttpStagingTransport` using `http.client`, Cloudflare Worker + R2, ETag caching, `ph transport` commands, env var API key fallback
- **Bug fix:** `check_and_sync()` removed from write methods — stale remote was resurrecting ended tasks (MergeEngine remote-wins).
- **Bug fix:** Python 3.14 `urllib.request` header case-mangling (X-Api-Key → X-api-key) — switched to `http.client`
- **Trace logging:** Disabled (`debug.trace_enabled: false` in config)
- **Passphrase:** Updated on both devices — no longer using `m0r3m0n3y`

## Two Machines

| | x13 (laptop) | debagent04 (pi) |
|---|---|---|
| Device ID | `dc1da321-2c80-4815-a808-11295b8c59f9` | `bbb3badc-6365-49ea-b43c-53869ca0195f` |
| Passphrase | 🟢 **Updated** (via `ph recover`) | 🟢 **Updated** (via `ph recover`) |
| Transport | `http` → `https://phpoc-staging.wacevedo.workers.dev` | TBD |
| Remote URL (git fallback) | `git@github.com:wacevedo76/phpoc-staging.git` | same |
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
| `core/sync/http_transport.py` | `HttpStagingTransport` — HTTP GET/PUT/LIST with ETag caching, `http.client` backend |
| `core/sync/transport.py` | `create_transport_from_config()` factory, `AbstractStagingTransport` base class |
| `domain/ledger/remote_sync.py` | `RemoteLedgerSync`: push/pull ledger blocks to/from remote |
| `domain/staging/remote_sync.py` | Blob obfuscation (AES-CTR + tiered padding), device check, pull/push, pull_cookie/push_cookie |
| `domain/staging/service.py` | Single-pull `check_and_sync()`, freshness optimization, Device Cookie fast path |
| `domain/cookie/device_cookie.py` | Deterministic HMAC cookie for cross-device identity |
| `domain/staging/local_cache.py` | Stable `entry_id` UUIDs on every entry |
| `domain/staging/merge_engine.py` | Dedup by `entry_id` (fallback `(title, epoch)` for legacy entries) |
| `cli/interface.py` | `view_active()` with remote pull+merge, `_push_if_remote()` after every write |
| `cli/trace.py` | `@trace` decorator — logs entry/exit/timing to `staging_log/` |
| `cli/wal.py` | WAL lifecycle, crash recovery, `_spawn_background_push()`, `format_wal_status()` |
| `cli/daemon.py` | PhDaemon lifecycle, DebounceQueue, FileWatcher, event loop, `_publish_status()` |
| `cli/daemon_sync.py` | SyncWorker retry/conflict/session, SyncResult |
| `cli/daemon_cli.py` | `ph daemon start/stop/status` handlers |
| `cli/onboarding.py` | `ph onboarding` — import existing ledger to new device via git transport |
| `cli/transport_cmd.py` | `ph transport show/set` — manage git/http transport config |
| `worker/src/index.ts` | TypeScript Cloudflare Worker: GET/PUT/LIST + ETag + API key auth |
| `worker/wrangler.toml` | Cloudflare Workers config with R2 bucket binding |
| `worker/package.json` | Worker project dependencies (wrangler, vitest, typescript) |
| `worker/tsconfig.json` | TypeScript config for Worker |
| `scripts/remove_trace_logging.sh` | Reverts all trace code (imports, decorators, module, logs) |
| `scripts/change_passphrase.py` | Re-encrypts recovery seed with a new passphrase |
| `REMOTE_STAGING_ISSUE_TRACKING.md` | Full issue tracking + areas for improvement |
| `tests/test_http_transport.py` | 68 tests: transport contract, ETag caching, errors, integration, Worker contract |

## Phase 1: HTTP Transport — Complete ✅

### Architecture
```
┌──────────────┐     HTTPS (GET/PUT)    ┌──────────────┐     S3 API      ┌────────┐
│ Python CLI   │ ──────────────────────►│ Cloudflare   │ ──────────────►│  R2    │
│ (and mobile) │ ◄─── HTTP (304/200) ───│ Worker       │ ◄──────────────│ Bucket │
└──────────────┘                        └──────────────┘               └────────┘
```

- **Worker:** `worker/src/index.ts` (149 lines TypeScript) — generic HTTP-to-R2 proxy
- **R2 bucket:** Single `phpoc-staging` bucket for both staging AND ledger data
- **HttpStagingTransport:** `core/sync/http_transport.py` (217 lines) — implements `AbstractStagingTransport`
- **ETag-based freshness:** `304 Not Modified` = zero bytes transferred = instant
- **Backend-agnostic:** Swap R2 ↔ S3 ↔ Backblaze B2 by changing only the Worker, not Python code
- **Encryption:** 100% client-side — Worker/R2 only see opaque encrypted bytes

### Completed tasks
1. [x] Created Cloudflare R2 bucket (`phpoc-staging`)
2. [x] Deployed Worker to `https://phpoc-staging.wacevedo.workers.dev`
3. [x] Wrote `HttpStagingTransport` — pull/push/list_files with ETag caching
4. [x] Wrote Worker source (GET/PUT/LIST + API key auth + ETag)
5. [x] `ph transport show/set` commands for managing transport config
6. [x] API key from env var `$PHPOC_CLOUDFLARE_API_KEY` with fallback resolution
7. [x] `create_transport_from_config()` factory
8. [x] Wired HTTP transport into `main.py` and `cli/onboarding.py`
9. [x] Fixed Python 3.14 `urllib.request` bug (header case-mangling → `http.client`)
10. [x] Pushed existing staging data from git → R2 via Worker: `ph sync remote_staging`
11. [x] Verified latency: `time ph view` → near-instant (was ~5000ms with git/SSH)

### Key design decisions (ADR-023)
| Decision | Detail |
|----------|--------|
| **Transport** | `HttpStagingTransport` replaces `GitStagingTransport` |
| **Storage** | Cloudflare R2 bucket — one bucket for both staging + ledger |
| **Server** | Cloudflare Worker — stateless pass-through, 149 lines TypeScript |
| **Auth** | Pre-shared API key (Worker secret `PHPOC_API_KEY`) |
| **Python HTTP lib** | `http.client` (not `urllib.request` — header case bug in Python 3.14) |
| **Freshness** | ETag / `If-None-Match` / `304 Not Modified` |
| **Cost** | $0.00/mo at personal scale (R2 free tier) |
| **Mobile** | Same HTTP API — no new backend needed |

## Device Cookie — Fast-Path Cross-Device Check

**Status:** ✅ **Implemented** (2026-05-24)

### Design
- **Cookie** = `HMAC-SHA256(cookie_key, device_id + ":" + epoch_ms)` → **32 bytes**
- **Deterministic**: same inputs → same byte-for-byte output every time
- **TTL**: 30 minutes, configurable via `cookie.ttl_minutes`
- **Security**: Remote only stores 32 bytes of HMAC output — no device_id, no epoch

## Known Issues & Areas for Improvement
See `REMOTE_STAGING_ISSUE_TRACKING.md` for full tracking.

## 🔴 Security Incident

### Passphrase exposure (`m0r3m0n3y`)
- Commits `1c1e1f2` and `4533af8` on `P3-Remote_Sync` contained the passphrase in markdown
- **Resolved:** Interactive rebase from `22ae407`, force-pushed clean history. Passphrase retired.

### Master key exposure (trace logs)
- `staging_log/` was tracked in git; trace logs captured `master_key` bytes in cleartext
- **Resolved:** `.gitignore` updated, commits stripped via rebase

## Recent Commits (this session)
```
0553f0e  fix: switch HttpStagingTransport from urllib.request to http.client
7da3279  feat: API key from env var $PHPOC_CLOUDFLARE_API_KEY
0510d6e  feat: ph transport command — manage git/http transport config
c3d9ea4  fix: ConfigManager not iterable + UnboundLocalError
a88516b  Phase 1: Worker source, transport factory, config wiring
```

## Next Steps

### Short-term
1. [ ] Configure HTTP transport on debagent04: `ph transport set http` → Worker URL → API key from env var
2. [ ] `ph onboarding` on mobile device (Phase 2)

### Phase 2: Mobile MVP (future)
1. [ ] Re-implement crypto primitives for mobile (PBKDF2, AES-CTR, HMAC-SHA256)
2. [ ] Build basic staging CRUD via Worker HTTP API
3. [ ] Device Cookie for fast-path identity
4. [ ] Minimal mobile UI (start/stop/view activities)

### On debagent04 (after git pull)
```
git fetch origin && git reset --hard origin/P3-Remote_Sync
```
