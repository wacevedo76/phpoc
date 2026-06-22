# ph view — Staging Sync Gate (CLI)

> Map: code locations for the CLI staging-sync gate (`check_and_sync`).
> Every `ph` command that touches staging runs through this gate.
> Local-only (no remote) skips all gate logic → READY immediately.

## Module Map

| File | Concern |
|---|---|
| `domain/staging/service.py` | `StagingService`: CRUD + `check_and_sync` + `push_to_remote` + `_reconcile_and_claim` + `_push_on_fast_path` + `SyncCheckResult` |
| `domain/staging/remote_sync.py` | `RemoteStagingSync`: blob obfuscation, `pull/push/pull_cookie/push_cookie`, `BLOB_KEY_MISMATCH` |
| `domain/staging/merge_engine.py` | `MergeEngine.merge()`: `entry_id` dedup, remote wins, sort by `start_epoch` |
| `domain/staging/local_cache.py` | `LocalStagingCache`: CRUD with `plain:` prefix convention, file-based JSON store |
| `domain/cookie/device_cookie.py` | `DeviceCookie`: TTL check, specifier compare, create/destroy, parse remote |
| `core/sync/transport.py` | Transport abstraction: `HttpStagingTransport`, `GitStagingTransport`, `AbstractStagingTransport` |
| `security/crypto.py` | `CryptoManager`, `NoAuthCryptoManager` |
| `security/auth.py` | Passphrase + recovery authenticators |
| `cli/interface.py` | CLI command dispatch; calls `StagingService` methods |
| `cli/daemon_sync.py` | Background daemon sync (Phase C) |
| `tests/test_staging_sync_optimization.py` | Test suite (all passing); uses `TransportSpy` |

## Data Paths

| Path | Content |
|---|---|
| `{data_dir}/staging.json` | Local staging entries (plain JSON) |
| `{data_dir}/device_cookie.meta` | Local cookie: `{device_specifier, creation_time}` |
| `staging/blobs/current.json` (remote) | Obfuscated staging blob |
| `staging/blobs/device_cookie.bin` (remote) | Remote cookie bytes |

## `check_and_sync()` — Decision Tree

```
1. !transport? → READY

2. [TTL] DeviceCookie.is_valid_locally(data_dir, ttl_minutes):
   ├─ valid → pull remote cookie → specifier match?
   │   ├─ match → _push_on_fast_path(local_cookie):
   │   │   ├─ push_to_remote(mk)         // full-replace blob
   │   │   └─ touch cookie if ≥10% TTL elapsed (local only, no remote push)
   │   │   → READY
   │   └─ mismatch → fall to auth
   └─ expired/no cookie → fall to auth

3. [AUTH] CryptoManager? No → REAUTH_NEEDED

4. [POST-AUTH] pull remote cookie → _ensure_cookie():
   ├─ same device_id → _push_on_fast_path(local_cookie) → READY  [Case A]
   └─ diff device_id → _reconcile_and_claim(mk):                 [Case B]
       ├─ pullBlob(mk) → BLOB_KEY_MISMATCH? → OFFLINE
       ├─ MergeEngine.merge(local, remote)
       ├─ write merged to local → push_to_remote(mk)
       ├─ DeviceCookie.create(fresh) + push_cookie() → READY
```

**Push is full-replace** — entire local staging array overwrites remote blob. No diffs or append-only.

## `push_to_remote(mk)` — Full-Replace Push

```
read_entries() → device_id → RemoteStagingSync.push(entries, device_id, mk):
  ├─ Serialize entries + device_id + timestamp
  ├─ Obfuscate with tiered padding (class-based size thresholds)
  └─ transport.push('staging/blobs/current.json', bytes)

Then _push_cookie(device_id):
  ├─ DeviceCookie.destroy_locally(data_dir)
  ├─ DeviceCookie.create(device_id, data_dir)
  └─ transport.push('staging/blobs/device_cookie.bin', cookie_bytes)
```

## Cookie Rules

| Path | TTL | Touch condition | Remote push? | Specifier? |
|---|---|---|---|---|
| Fast path | valid | ≥10% TTL elapsed | No (remote has matching specifier) | Unchanged |
| Case A (TTL expired, same device) | expired | Unconditionally | No | Unchanged |
| Case B (different device) | — | Fresh cookie created | Yes | New |

## Key Invariants

1. **No auth unless cookie fails**: `check_and_sync()` never consults `CryptoManager` unless TTL expired or specifier mismatch.
2. **Push order**: blob first, cookie second. Cookie unchanged on blob failure → retry on next sync.
3. **BLOB_KEY_MISMATCH**: never overwrite remote with unreadable data. Returns OFFLINE; local staging preserved.
4. **Command-agnostic**: all commands (view, start, end, pause, unpause, modify, remove, tags) run the same gate. Reads are not treated more leniently.
5. **Local-only**: no transport → `READY` immediately; no gate logic runs.

## Diagnostic Checkpoints

| # | Check | How |
|---|---|---|
| 1 | Transport configured? | `service._transport` not None |
| 2 | Local cookie valid? | `DeviceCookie.is_valid_locally(data_dir, ttl)` |
| 3 | Remote cookie? | `transport.pull('staging/blobs/device_cookie.bin')` |
| 4 | Specifiers match? | Compare local vs remote `device_specifier` |
| 5 | check_and_sync result? | `READY` / `OFFLINE` / `REAUTH_NEEDED` |
| 6 | Crypto available? | `isinstance(service._crypto, CryptoManager)` (not `NoAuthCryptoManager`) |
| 7 | Blob key works? | `RemoteStagingSync.pull(mk)` does not return `BLOB_KEY_MISMATCH` |

## Test Reference

All workflow behaviors validated in `tests/test_staging_sync_optimization.py` (13 scenarios: fast path, 10% window, Case A, Case B, merge correctness, no remote, TTL config). Tests are the spec — do not modify them.
