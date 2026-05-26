# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `pending` (specifier mismatch always forces auth; ph view refuses without auth; _sync_before_command hardened for cross-device)
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
- **Auth gate — FIXED:** `_is_auth_fresh()` previously let specifier mismatch slip through if CryptoManager was cached. Now `check_and_sync()` tracks `specifier_mismatch` as a separate flag and **always** returns `REAUTH_NEEDED` on mismatch, regardless of `_is_auth_fresh()`. 
- **ph view — hardened:** No longer shows stale local data on specifier mismatch. Prints "Remote staging is held by a different device. Please re-authenticate to access remote staging." and returns.
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

**Flow (updated 2026-05-26):**
1. `check_and_sync()` → local cookie TTL valid?
   - Yes → pull remote cookie, compare `device_specifier`
     - Match → **READY** (fast path, same device session)
     - Mismatch → set `specifier_mismatch = True`, fall through ↓
   - No cookie/expired → fall through ↓
2. Slow path: pull blob from R2
3. `specifier_mismatch`?
   - **Yes → `REAUTH_NEEDED` unconditionally** (bypasses `_is_auth_fresh()` entirely)
   - No → `_is_auth_fresh()`? (TTL cache OR CryptoManager present?)
     - No → `REAUTH_NEEDED`
     - Yes → merge remote into local → READY

**Key change:** `specifier_mismatch` is now tracked as an explicit boolean flag.
It forces `REAUTH_NEEDED` regardless of whether a `CryptoManager` is already
cached with the correct key. Only one device can access staging at a time —
the user must explicitly authenticate to prove they are the intended device.

**ph view / ph list behavior:** `_sync_before_command()` now returns `False`
on `REAUTH_NEEDED` even for read-only commands. The user sees:
```
Remote staging is held by a different device.
Please re-authenticate to access remote staging.
```
No local data is shown until the user authenticates.

**After successful auth:** The next `check_and_sync()` call has no local cookie
(fresh `StagingService`), so it falls through to the slow path with
`specifier_mismatch = False`, `_is_auth_fresh()` returns `True` (valid
`CryptoManager`), merge proceeds, new cookie created and pushed.

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
| Cookie status | 🟢 **Created** (specifier `3b1880b8...` on remote, `a68de5ed...` local) | 🟢 **Working** (specifier `e8dbfbbd...` local) |
| Last successful staging write | x13 `ph view` → created cookie on R2 | debagent04 `ph add` → pushed previous cookie |
| Remote clone dir | `~/.local/share/phpoc/remote/` | `~/.local/share/phpoc/remote/` |

## Current Bug Fixed: Specifier Mismatch Did Not Force Auth

**Observed:** `ph view` on debagent04 with specifier `e8dbfbbd...` (local) vs
`3b1880b8...` (remote) did **not** prompt for authentication. It silently merged
remote data without asking the user.

**Root cause:** `_is_auth_fresh()` returned `True` because a `CryptoManager` with
a valid key was present (from the process-level auth gate in `main.py`). The
specifier mismatch was detected but ignored when auth was "fresh" by this
definition.

**Fix (both files):**
- `domain/staging/service.py`: `check_and_sync()` now tracks
  `specifier_mismatch` as an explicit boolean. When set (remote cookie exists
  but specifiers don't match), **always** returns `REAUTH_NEEDED` without
  consulting `_is_auth_fresh()`.
- `cli/interface.py`: `_sync_before_command()` now returns `False` on
  `REAUTH_NEEDED` for **all** commands. `view_active()` and `list_habits()`
  check the return and abort early. No stale local data is shown.

**Files changed:**
- `domain/staging/service.py` — lines 393-408 (specifier_mismatch flag + unconditional REAUTH_NEEDED)
- `cli/interface.py` — lines 27-75 (_sync_before_command returns False), lines 234-236 (view_active early return), lines 334-336 (list_habits early return)

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
pending  fix: specifier mismatch now unconditionally forces auth (bypasses _is_auth_fresh)
pending  fix: ph view / ph list refuse to show local data when different device holds staging
```

## Testing Checklist

### 1. On both devices — pull latest
```bash
cd ~/phpoc
git pull origin P3-Remote_Sync
```

### 2. On debagent04 — verify auth gate blocks access when x13 holds staging
```bash
ph dev cookie          # shows local vs remote specifiers

# If remote is held by x13:
ph view                # should PRINT: "Remote staging is held by a different device."
                       #          "Please re-authenticate to access remote staging."
                       # Shows NO task data until user authenticates

# To regain access:
ph login               # enter passphrase
ph view                # now shows merged data, creates new device cookie
```

### 3. Cross-device hand-off flow
```bash
# On debagent04: start a task
ph add start "Cross-device test"

# On x13: should be blocked from viewing until auth
ph view                # "Remote staging is held by a different device."

# On x13: authenticate to merge
ph login               # enter passphrase
ph view                # shows "Cross-device test" as active

# On x13: end the task
ph add end "Cross-device test"

# On debagent04: now blocked until auth
ph view                # "Remote staging is held by a different device."
ph login
ph view                # shows task as ended
```

### 4. Verify auth gate is NOT bypassed by cached CryptoManager
```bash
# On debagent04, with x13 currently holding staging:
ph view                # BLOCKED — shows message, no data

# Even though main.py already authenticated (CryptoManager exists),
# the specifier mismatch forces REAUTH_NEEDED unconditionally.
```

### 5. Verify ph dev cookie diagnostic
```bash
ph dev cookie          # Shows:
                       #   Remote Device Cookie:
                       #     device_uuid:       ...
                       #     device_specifier:  ...
                       #   Local Device Cookie:
                       #     device_specifier:  ...
                       #     creation_time:     ...
                       #     specifiers match:  True/False
```

## Known Issues
- **x13 API key:** Now set (`e433b6f...`) — working
- **ph sync remote_staging:** Currently calls `check_and_sync()` but ignores the result (line 523 of `main.py`). Should be routed through the same auth-gate flow as other commands.
- **ETag caching:** `HttpStagingTransport` caches ETags per path within a single process. This is fine for single commands (fresh transport each time) but could be stale for long-running daemon mode. Not a current issue but worth noting.
