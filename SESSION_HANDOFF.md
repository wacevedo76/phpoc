# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `pending` (device UUID provenance on every entry; cookie created on slow path; restored missing capture() calls)
- **Tests:** 1267 all passing (134 pre-existing failures)
- **Device UUID provenance:** ✅ Every entry carries encrypted `device_uuid_enc` (creator device) and `end_device_uuid_enc` (ender device)
- **Cookie on slow path:** ✅ `check_and_sync()` creates device cookie after successful auth+merge — subsequent calls fast-path
- **Bug fix (missing capture):** ✅ `add_start` and `add_oneoff` were not calling `capture()` (regression from `6240f92`); restored
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
- **Critical refactor:** Cookie specifier IS the truth — mismatch always forces auth, no longer checks blob's `device_id` field
- **Sync does NOT push cookie:** `ph sync remote_staging` uses `push_blob_only()` — blob only, remote cookie is never overwritten by sync
- **Auth gate:** `_is_auth_fresh()` helper — uses TTL cache OR live CryptoManager presence
- **Navigation:** `ph dev cookie` — inspect remote + local cookies for debugging
- **Ledger data:** 56 blocks + index pushed from x13 to R2 via HTTP transport
- **Trace logging:** Disabled (`debug.trace_enabled: false` in config)

## Device Cookie — Final Design (2026-05-27)

**Design (random specifier):**
- Remote cookie (R2):  `{"device_uuid": "<UUID>", "device_specifier": "<random 32-char hex>"}`
- Local cookie (disk): `{"device_specifier": "<same random>", "creation_time": "<epoch_ms>"}`

**Cookie is the truth.** A specifier mismatch definitively means a different device
wrote since our last push. This alone forces the auth gate — no fallback to blob's
`device_id` field.

**Two push paths:**
| Method | Used by | Pushes cookie? |
|--------|---------|----------------|
| `push_to_remote()` | Write ops (add, end, etc.) | ✅ Yes — generates new specifier |
| `push_blob_only()` | `ph sync remote_staging` | ❌ No — blob only, cookie stays |

**Flow:**
1. `check_and_sync()` → local cookie TTL valid?
   - Yes → pull remote cookie, compare `device_specifier`
     - Match → **READY** (fast path, same device session)
     - Mismatch → fall through ↓
   - No cookie/expired → fall through ↓
2. Slow path: pull blob from R2
3. `_is_auth_fresh()`? (TTL cache OR CryptoManager present?)
   - No → `REAUTH_NEEDED`
   - Yes → merge remote into local → READY

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
| Passphrase | 🟢 **Updated** | 🟢 **Updated** |
| Transport | `http` → `https://phpoc-staging.wacevedo.workers.dev` | `http` (same URL) |
| API key | 🟢 **Set** (`e433b6f...`) | 🟢 **Set** |
| Cookie status | 🔴 **None** — no write succeeded yet (but `ph view` now creates one on auth) | 🟢 **Working** (specifier `a68de5ed...`) |
| Remote clone dir | `~/.local/share/phpoc/remote/` | `~/.local/share/phpoc/remote/` |

## Key Files
| File | Purpose |
|------|---------|
| `core/sync/http_transport.py` | `HttpStagingTransport` — HTTP GET/PUT/LIST with ETag caching, `http.client` backend |
| `core/sync/transport.py` | `create_transport_from_config()` factory, `AbstractStagingTransport` base class |
| `domain/ledger/remote_sync.py` | `RemoteLedgerSync`: push/pull ledger blocks to/from remote |
| `domain/staging/remote_sync.py` | Blob obfuscation (AES-CTR + tiered padding), device check, pull/push, pull_cookie/push_cookie |
| `domain/staging/service.py` | Single-pull `check_and_sync()` with cookie creation on slow path, `_ensure_cookie()`, `_get_device_id()`, device UUID in `capture()` and `end()` |
| `domain/cookie/device_cookie.py` | Random-specifier cookie for cross-device identity (redesigned) |
| `domain/staging/local_cache.py` | Stable `entry_id` UUIDs, `device_uuid_enc` / `end_device_uuid_enc` fields on every entry |
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
d25d9b4  fix: specifier mismatch always forces auth; sync never pushes cookie
88e7e52  fix: sync commands must not push device cookie to remote
ee2339e  feat: add ph dev cookie command to inspect remote device cookie
a5793fe  redesign: device cookie uses random specifier instead of HMAC
6240f92  feat: inline sync before commands, background push fix, config fix
pending  fix: restore missing capture() in add_start/add_oneoff
pending  feat: device UUID provenance (device_uuid_enc, end_device_uuid_enc) on every entry
pending  feat: _ensure_cookie() creates device cookie on slow-path auth+merge
```

## Testing Checklist

### 1. On x13 — API key already set
```bash
cd ~/phpoc
git pull origin P3-Remote_Sync
ph config get http.api_key  # should return e433b6f...
```

### 2. On x13 — verify cookie and sync
```bash
ph dev cookie          # should show remote cookie (from debagent04), no local cookie

# NEW: ph view now creates cookie on auth+merge slow path
ph view                # prompts for passphrase → syncs → cookie created!
ph dev cookie          # now shows local cookie, specifiers match

# Or alternatively via a write:
ph add start "Test"    # creates local cookie via capture(), pushes to R2
ph dev cookie          # now shows local cookie, specifiers match
```

### 3. Cross-device: x13 → debagent04
```bash
# On x13:
ph add start "Cross-device test"

# On debagent04:
ph view                # should show "Cross-device test" as active
ph dev cookie          # specifiers DON'T match (debagent04's local ≠ x13's remote)
```

### 4. Cross-device: debagent04 → x13
```bash
# On debagent04:
ph add end "Cross-device test"

# On x13:
ph view                # should show task as ended
```

### 5. Verify auth gate
```bash
# On debagent04, while x13 has the remote cookie:
ph logout
ph view                # should prompt for passphrase (cookie mismatch + auth expired)
```

## Known Issues
- **x13 cookie status:** Still none — `ph view` will create one on first auth+merge
- **x13 API key:** Now set (`e433b6f...`) — no longer blocking
