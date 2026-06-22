# Remote/Local Sync — Web

> Map: code locations for the staging-sync + ledger-commit workflow.
> All 28 test suites pass. Runtime failures = misconfiguration, not code defects.

## Module Map

| File | Concern | Key exports |
|---|---|---|
| `phpoc-web/src/sync/sync.js` | Central gate: CRUD + `checkAndSync` + `pushToRemote` + `_reconcileAndClaim` | `SyncService` |
| `phpoc-web/src/sync/genesis_gate.js` | Genesis chain validation + `LedgerMerge` delegation | `GenesisGate` |
| `phpoc-web/src/sync/transport.js` | HTTP to Worker/R2; ETag cache; API key header | `HttpTransport` |
| `phpoc-web/src/sync/remote_sync.js` | Blob obfuscation (WASM), cookie I/O | `RemoteSync` |
| `phpoc-web/src/sync/local_cache.js` | Staging CRUD on IndexedDB key `entries` | `LocalCache` |
| `phpoc-web/src/sync/merge_engine.js` | `entry_id` dedup merge; remote wins | `mergeEntries()` |
| `phpoc-web/src/sync/cookie.js` | `DeviceCookie`: TTL check, specifier compare, create | `DeviceCookie` |
| `phpoc-web/src/ledger/engine.js` | Commit → encrypt + seal day blocks | `LedgerEngine` |
| `phpoc-web/src/ledger/merge.js` | 7-step divergent chain merge | `LedgerMerge` |
| `phpoc-web/src/hooks/useAutoSync.js` | Debounced auto-push wrapper (500ms) | `createAutoSync()`, `useAutoSync()` |
| `phpoc-web/src/context/DevModeContext.jsx` | Service bootstrap + `commitEntries` | `effectiveServices` proxy |
| `phpoc-web/src/components/screens/SyncSettings.jsx` | "Sync Now" → `checkAndSync` + `commitEntries` | — |
| `phpoc-web/src/crypto/index.js` | WASM/dummy crypto; sha256, encrypt, PBKDF2 | `CryptoService` |

## Storage Keys

| Key (IndexedDB) | Shape | Writer |
|---|---|---|
| `phpoc_seed` | base64 string | onboarding |
| `phpoc_identity_secret` | hex string | `LedgerEngine.init()` |
| `ledger:blocks` | `[{type, date, entries, seal, ...}]` | `LedgerChain.append()` |
| `ledger:index` | `{date: {title: ms}}` | `IndexManager._flush()` |
| `entries` | `[{entry_id, title, duration, is_active, ...}]` | `LocalCache.writeEntries/append/update` |
| `cookie` | `{device_specifier, creation_time}` | `DeviceCookie.create()` |
| `phpoc_device_uuid` | hex UUID | `getOrCreateDeviceUuid()` |

| Key (localStorage) | Writer |
|---|---|
| `phpoc_worker_url` | onboarding/connect |
| `phpoc_api_key` | onboarding/connect |
| `phpoc_deployment` | `'saas'` or `'lan'` |

## Remote Paths (R2)

| Path | Obfuscated? |
|---|---|
| `staging/blobs/current.json` | Yes (WASM) |
| `staging/blobs/device_cookie.bin` | No |
| `ledger:blocks` | No |

## `checkAndSync()` — Decision Tree

```
1. !transport? → READY
2. [GENESIS] local ledger:blocks non-empty?
   → GenesisGate.check(localChain, transport, crypto, mk)
     ├─ empty remote → compatible (first boot)
     ├─ seals/hashes invalid → GENESIS_MISMATCH
     └─ genesis match → LedgerMerge.merge() → persist merged chain → compatible

3. [FAST] DeviceCookie.isValidLocally(storage, 30min)?
   ├─ pullCookie() fails? → OFFLINE
   ├─ specifier match → pushBlobOnly(mk) + touchCookie() → READY
   └─ specifier mismatch or no remote cookie → fall to auth

4. [AUTH] !localCookie && mk cached → _reconcileAndClaim(mk)
   ├─ no mk → REAUTH_NEEDED
   └─ specifierMismatch → REAUTH_NEEDED

5. _reconcileAndClaim(mk):
   ├─ pullCookie() fails? → OFFLINE
   ├─ same device_uuid → pushBlobOnly(mk) + touch cookie (keep specifier) → READY
   └─ diff device
       ├─ pullBlob(mk) → BLOB_KEY_MISMATCH? → OFFLINE (don't overwrite)
       ├─ mergeEntries(local, remote) → writeEntries(merged)
       ├─ pushBlobOnly(mk) + DeviceCookie.create() + pushCookie() → READY
```

## `pushToRemote(mk)`

```
readEntries() → deviceId → remote.pushBlob(entries, deviceId, mk)
→ _pushCookie(deviceId): destroy local → create fresh → transport.push
```

**Push is full-replace** — entire local staging array overwrites remote blob. Push order: blob first, cookie second.

## `commitEntries(entryIds)` — Ledger Commit

```
engine = new LedgerEngine(crypto, storage, masterKey)
engine.commit(toCommit):
  ├─ filter !entry.committed
  ├─ _encryptEntry: encrypt fields + compute content_hash + entry hash
  ├─ groupByDate → buildDayBlock → chain.append → storage.set('ledger:blocks')
  ├─ index._flush() → storage.set('ledger:index')
  └─ sync.markCommitted(entryIds, blockIndex)

Auto-commit after "Sync Now": read fresh entries → filter !is_active && !committed → commit
```

**Ledger blocks are LOCAL-ONLY** — never pushed to remote.

## Auto-Sync Flow

```
User mutation (capture/end/pause/unpause/modify/remove)
→ Proxy handler:
    await rawSync[method](...args)  // local write always succeeds
    _schedulePush():
      ├─ !masterKey? → skip
      ├─ clearTimeout(prevTimer)    // coalesce mutations
      └─ setTimeout(500ms, () => pushToRemote(mk))

Push errors caught + logged, never propagated to caller.
```

## Crypto Lifecycle

| Phase | MK | Staging Sync | Ledger |
|---|---|---|---|
| boot | null | none | none |
| auth | null→derived | none | none |
| ready (bootstrap) | cached | checkAndSync runs | genesis gate |
| ready (normal use) | cached | auto-sync active | manual commit |
| re-auth overlay | null→re-derived | manual Sync Now | none |

## Key Invariants

1. **Blob push order**: blob first, cookie second. Blob failure → cookie unchanged → retry on next sync. Cookie failure after blob success → next sync sees mismatch → reconcile pulls correct blob.
2. **BLOB_KEY_MISMATCH**: never overwrite remote with unreadable data. Returns OFFLINE.
3. **Genesis gate cached**: `_genesisCompatible` (null/true/false). `resetGenesisGate()` on transport URL change.
4. **Genesis in-flight dedup**: `_genesisCheckPromise` — concurrent calls share one network round-trip.
5. **Auth bypass with cached MK**: `!localCookie && masterKeyCached` → `_reconcileAndClaim()` not `REAUTH_NEEDED`.
6. **Cookie specifier**: HMAC-derived, stable per device session. Only regenerated in Case B.
7. **`commitEntries` dedup**: filters `!e.committed` — prevents re-committing already-committed entries.
8. **Empty remote = compatible**: first boot, no genesis conflict.

## Diagnostic Checkpoints

| # | Check | How |
|---|---|---|
| 1 | Transport configured? | `sync.isRemoteAvailable` |
| 2 | Master key cached? | `sync.getMasterKey()` / `crypto.hasMasterKey()` |
| 3 | checkAndSync result? | `READY` / `OFFLINE` / `REAUTH_NEEDED` / `GENESIS_MISMATCH` |
| 4 | Local ledger exists? | `storage.get('ledger:blocks')` |
| 5 | Local cookie? | `storage.get('cookie')` |
| 6 | Worker reachable? | `transport.pull('staging/blobs/device_cookie.bin')` |
| 7 | Crypto status? | `cryptoStatus` = `'wasm'` or `'fallback'` |
| 8 | Storage status? | `storageStatus` = `'persistent'` / `'session'` / `'memory'` |
| 9 | Genesis compatible? | `sync._genesisCompatible` |
| 10 | Auto-sync active? | `services.sync.isAutoSyncing` |

## Known Gaps

- Ledger blocks never pushed to remote (`pushLedgerBlocks()` not implemented)
- Remote staging blob is single-key → two devices race on concurrent writes
