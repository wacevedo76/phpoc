# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `ee2339e` (feat: add ph dev cookie command to inspect remote device cookie)
- **Tests:** 1267 all passing
- **Remote staging:** Using HTTP transport via Cloudflare Worker ✅
- **Remote ledger:** ✅ **Migrated to R2** — 56 blocks + index pushed via HTTP
- **Device Cookie:** ✅ **Redesigned** — random-specifier based (fast-path cross-device identity check)
- **Phase 1 (HTTP transport):** ✅ **Complete** — Worker deployed, ~100ms latency
- **Phase A (reads):** `cli/background.py` (430 lines) — instant reads via background subprocess
- **Phase B (writes):** `cli/wal.py` (350 lines) — WAL-backed instant writes
- **Phase C (daemon):** ✅ Implemented. `cli/daemon.py`, `cli/daemon_sync.py`, `cli/daemon_cli.py`
- **Onboarding:** ✅ `cli/onboarding.py` (474 lines) — `ph onboarding`
- **Bug fix (stale-remote resurrection):** `check_and_sync()` removed from all write methods
- **Bug fix (cookie redesign):** Old HMAC-based cookies replaced by random-specifier design
- **Navigation:** `ph dev cookie` — inspect remote + local cookies for debugging
- **Ledger data:** 56 blocks + index pushed from x13 to R2 via HTTP transport
- **Trace logging:** Disabled (`debug.trace_enabled: false` in config)

## Device Cookie — Redesigned (2026-05-27)

**Old design (HMAC-based):**
- Cookie = HMAC(master_key, device_id + epoch_ms) → 32 raw bytes
- Comparison was byte-for-byte — if both devices shared the same master key (recovery seed), the HMAC byte comparison could match even when different devices had written
- 32 raw bytes on R2 — opaque, hard to debug

**New design (random specifier):**
- Remote cookie (R2):  `{"device_uuid": "<UUID>", "device_specifier": "<random 32-char hex>"}`
- Local cookie (disk): `{"device_specifier": "<same random>", "creation_time": "<epoch_ms>"}`

**Flow:**
1. `check_and_sync()` checks local cookie exists + TTL valid
2. Pulls remote cookie from R2 (tiny JSON, ~100 bytes)
3. Compares `device_specifier` values — if they match → same device session → READY
4. If they don't match → different device has written → slow path (pull + decrypt + merge)
5. `push_to_remote()` generates a new random specifier, stores locally, pushes to R2

**Key property:** The `device_specifier` is a random token, freshly generated on each cookie creation. When x13 pushes, it writes x13's specifier. The next debagent04 command compares its local specifier against R2's → **definitive mismatch** → forces blob pull + merge.

**`ph dev cookie` command** (added in `ee2339e`):
```
$ ph dev cookie
Remote Device Cookie:
  device_uuid:       bbb3badc-6365-49ea-b43c-53869ca0195f
  device_specifier:  9add2bfbce2ce343459ffe4b612a0982

Local Device Cookie:
  device_specifier:  9add2bfbce2ce343459ffe4b612a0982
  creation_time:     1779818198254
  specifiers match:  True
```

## Two Machines

| | x13 (laptop) | debagent04 (pi) |
|---|---|---|
| Device ID | `dc1da321-2c80-4815-a808-11295b8c59f9` | `bbb3badc-6365-49ea-b43c-53869ca0195f` |
| Passphrase | 🟢 **Updated** (via `ph recover`) | 🟢 **Updated** (via `ph recover`) |
| Transport | `http` → `https://phpoc-staging.wacevedo.workers.dev` | `http` (same URL) |
| API key | 🔴 **Not set** — `ph config set http.api_key "<key>"` needed | 🟢 **Set** |
| Remote clone dir | `~/.local/share/phpoc/remote/` | `~/.local/share/phpoc/remote/` |
| Cookie status | Unknown — needs `ph dev cookie` | 🟢 Working |

## Key Files
| File | Purpose |
|------|---------|
| `core/sync/http_transport.py` | `HttpStagingTransport` — HTTP GET/PUT/LIST with ETag caching, `http.client` backend |
| `core/sync/transport.py` | `create_transport_from_config()` factory, `AbstractStagingTransport` base class |
| `domain/ledger/remote_sync.py` | `RemoteLedgerSync`: push/pull ledger blocks to/from remote |
| `domain/staging/remote_sync.py` | Blob obfuscation (AES-CTR + tiered padding), device check, pull/push, pull_cookie/push_cookie |
| `domain/staging/service.py` | Single-pull `check_and_sync()`, Device Cookie fast path, `push_to_remote()` |
| `domain/cookie/device_cookie.py` | Random-specifier cookie for cross-device identity (redesigned) |
| `domain/staging/local_cache.py` | Stable `entry_id` UUIDs on every entry |
| `domain/staging/merge_engine.py` | Dedup by `entry_id` (fallback `(title, epoch)` for legacy entries) |
| `cli/interface.py` | `view_active()` with remote pull+merge, `_sync_before_command()` |
| `cli/background.py` | Phase A instant reads + cookie renewal |
| `cli/wal.py` | WAL lifecycle, crash recovery, background push |
| `cli/daemon.py` | PhDaemon lifecycle, DebounceQueue, FileWatcher |
| `cli/onboarding.py` | `ph onboarding` — import existing ledger to new device |
| `cli/transport_cmd.py` | `ph transport show/set` |
| `main.py` | `ph dev cookie` command for diagnostics |
| `worker/src/index.ts` | TypeScript Cloudflare Worker: GET/PUT/LIST + ETag + API key auth |
| `REMOTE_STAGING_ISSUE_TRACKING.md` | Full issue tracking + areas for improvement |

## Recent Commits (this session)
```
ee2339e  feat: add ph dev cookie command to inspect remote device cookie
a5793fe  redesign: device cookie uses random specifier instead of HMAC
d1f0f29  fix: cookie fast path falls through after stale threshold
6240f92  feat: inline sync before commands, background push fix, config fix
60e1b79  fix: api_key was null in debagent04 config - set via ph config set
...
```

## Known Issue: x13 has `api_key: null`
On x13, `ph config set http.api_key "<key>"` is needed before HTTPS pushes will succeed.
Without it, `ph sync remote_staging` and background pushes silently fail (403 Forbidden).

## Next Steps
1. **On x13:** `git pull origin P3-Remote_Sync` → `ph config set http.api_key "<key>"`
2. **On x13:** `ph dev cookie` to verify cookie exists locally
3. **Cross-device test:** `ph add start "Test"` on x13 → `ph view` on debagent04 shows it
4. **Cross-device test:** `ph add end "Test"` on debagent04 → `ph view` on x13 shows it ended
