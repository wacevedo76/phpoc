# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `pending`
- **Tests:** 1267 all passing (134 pre-existing failures)
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + 56 ledger blocks + index migrated)
- **Phases:** A (instant reads ✓), B (WAL writes ✓), C (daemon ✓), onboarding ✓

## Auth Gate Design — `check_and_sync()` (2026-05-28)

The **device cookie** is the source of truth. Two concepts only: local TTL and specifier comparison. No `CryptoManager`/`_is_auth_fresh()` consulted for auth decisions.

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Remote configured?                                         │
│    No  ──→ READY 🟢                                           │
│    Yes ──→ continue                                            │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. LOCAL COOKIE CHECK                                         │
│    Read local cookie from disk                                 │
│    ├─ No local cookie ──→ go to AUTH GATE                     │
│    ├─ Expired (TTL)    ──→ go to AUTH GATE                    │
│    └─ Valid ──→ continue to remote cookie check               │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. REMOTE COOKIE CHECK (fast path, ~50ms)                     │
│    Pull remote cookie from R2                                  │
│    ├─ Unreachable ──→ OFFLINE 🔶 (proceed with local)         │
│    └─ Got remote cookie ──→ compare device_specifier          │
│       ├── Match ──→ READY 🟢 (same device session)            │
│       └── Mismatch ──→ go to AUTH GATE                        │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. AUTH GATE                                                  │
│    Valid CryptoManager (master_key present)?                    │
│    ├─ No ──→ REAUTH_NEEDED 🔴 (caller prompts)                 │
│    └─ Yes ──→ pull remote cookie (to get device_uuid)         │
│       ├─ Unreachable ──→ OFFLINE 🔶                            │
│       └─ Got remote cookie ──→ compare device_uuid            │
│                                                               │
│       SAME device_uuid:                                        │
│         → Push local blob to remote (local authoritative)      │
│                                                               │
│       DIFFERENT device_uuid:                                   │
│         → Pull remote blob → reconcile (merge into local)      │
│         → Push merged blob to remote                           │
│                                                               │
│       Create new device_specifier, new TTL                     │
│       → Write local cookie                                     │
│       → PUT new remote cookie (overwrites, no destroy)         │
│       → READY 🟢                                               │
└──────────────────────────────────────────────────────────────┘
```

### Cookie format

| Location | Fields | Size |
|----------|--------|------|
| Remote (R2) | `{"device_uuid": "<UUID>", "device_specifier": "<random 32-char hex>"}` | ~200 bytes |
| Local (disk) | `{"device_specifier": "<same>", "creation_time": "<epoch_ms>"}` | ~150 bytes |

Two push paths:
| Method | Used by | Pushes cookie? |
|--------|---------|----------------|
| `push_to_remote()` | Write ops (add/end) | ✅ Yes — new specifier |
| `push_blob_only()` | `ph sync remote_staging` | ❌ No — blob only |

`ph login` now clears both session cache AND local device cookie → next `check_and_sync()` has no local cookie, falls through to auth gate, proceeds with valid CryptoManager.

### Auth Gate invariants

- Blob is **never** pulled before auth — cookie check is always the first remote call
- No `_is_auth_fresh()` or CryptoManager consulted for auth decisions — cookie is the truth
- After auth: same device_uuid = push local (no pull); different = pull+merge+push
- Remote cookie overwritten by PUT (no destroy-then-create race)
- Offline remote → OFFLINE, user proceeds with local data
- No remote configured → READY immediately

## Two Machines

| | x13 (laptop) | debagent04 (pi) |
|---|---|---|
| Device ID | `dc1da321-2c80-4815-a808-11295b8c59f9` | `bbb3badc-6365-49ea-b43c-53869ca0195f` |
| Passphrase | ✅ Updated | ✅ Updated |
| Transport | HTTP → Cloudflare Worker | HTTP (same URL) |
| API key | ✅ Set | ✅ Set |
| Cookie | Created (last write from x13) | Present (mismatch with remote) |

## Key Files

| File | Purpose |
|------|---------|
| `core/sync/http_transport.py` | HTTP GET/PUT/LIST + ETag caching |
| `core/sync/transport.py` | Transport factory from config |
| `domain/staging/service.py` | `check_and_sync()` — the sync gate |
| `domain/staging/remote_sync.py` | Blob obfuscation, pull/push, cookie pull/push |
| `domain/cookie/device_cookie.py` | Random-specifier cookie |
| `domain/staging/local_cache.py` | CRUD, plain: prefix convention |
| `domain/staging/merge_engine.py` | Dedup by entry_id |
| `cli/interface.py` | `view_active()`, `_sync_before_command()` |
| `cli/background.py` | Phase A instant reads |
| `cli/wal.py` | WAL lifecycle + background push |
| `cli/daemon.py` | PhDaemon lifecycle |
| `cli/onboarding.py` | `ph onboarding` |
| `worker/src/index.ts` | Cloudflare Worker (149 lines TypeScript) |

## Recent Commits (this session)
```
d25d9b4  fix: specifier mismatch always forces auth; sync never pushes cookie
88e7e52  fix: sync commands must not push device cookie to remote
ee2339e  feat: add ph dev cookie command to inspect remote device cookie
a5793fe  redesign: device cookie uses random specifier instead of HMAC
6240f92  feat: inline sync before commands, background push fix, config fix
pending  redesign: simplified auth gate — cookie-only fast path, device_uuid decides pull vs push after auth
pending  fix: ph login clears local device cookie to break auth loop
pending  feat: ph dev cookie shows creation time, TTL, and expiry status
```

## Known Issues
- `ph sync remote_staging` calls `check_and_sync()` but ignores result
- ETag caching stale in long-running daemon mode (not a current issue)
