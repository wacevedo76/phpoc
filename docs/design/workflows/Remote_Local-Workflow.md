# Remote/Local Sync Workflow — Compressed Reference

> AI-consumable reference. Token-minimal. Complete enough to troubleshoot.
> All tests pass (28 suites, 0 regressions). Failure is at runtime.

## Component Map

| Module | File | Concern |
|---|---|---|
| Transport | `phpoc-web/src/sync/transport.js` | `HttpTransport`: fetch() to Worker/R2. ETag cache, API key header, AbortSignal.timeout. `pull/push/listFiles/delete` |
| RemoteSync | `phpoc-web/src/sync/remote_sync.js` | Blob obfuscation (WASM), cookie I/O. `pullBlob/pushBlob/pullCookie/pushCookie` |
| SyncService | `phpoc-web/src/sync/sync.js` | Central gate: local CRUD + `checkAndSync` + `pushToRemote` + `_reconcileAndClaim` |
| GenesisGate | `phpoc-web/src/sync/genesis_gate.js` | Fetches remote `ledger:blocks`, validates chain, compares genesis hash, delegates to LedgerMerge |
| LedgerMerge | `phpoc-web/src/ledger/merge.js` | 7-step merge of divergent chains sharing same genesis |
| LedgerEngine | `phpoc-web/src/ledger/engine.js` | Commit entries → day blocks with encryption + sealing; `init()` for genesis |
| mergeEngine | `phpoc-web/src/sync/merge_engine.js` | Pure function: entry_id dedup merge (staging entries), remote wins |
| AutoSync | `phpoc-web/src/hooks/useAutoSync.js` | `createAutoSync()`: wraps 6 mutations with debounced `pushToRemote`. `useAutoSync()`: React hook. |
| DeviceCookie | `phpoc-web/src/sync/cookie.js` | `isValidLocally`, `parseRemote`, `matches`, `create`, `destroyLocally` |
| LocalCache | `phpoc-web/src/sync/local_cache.js` | Staging CRUD on IndexedDB key `entries` |
| DevModeContext | `phpoc-web/src/context/DevModeContext.jsx` | `effectiveServices` Proxy: mut→autoSync, rest→Reflect.get. `bootstrapServices()`, `commitEntries()`, `handleReauth()` |
| Settings UI | `phpoc-web/src/components/screens/SyncSettings.jsx` | "Sync Now" → `checkAndSync()`. "Commit Selected/All" → `commitEntries()` |

## Storage Keys

| Key | Content | Writer |
|---|---|---|
| `phpoc_seed` | Base64 recovery seed | onboarding/login/connect |
| `phpoc_username` | string | onboarding/login/connect |
| `phpoc_email` | string | onboarding/login/connect |
| `phpoc_identity_secret` | hex | `LedgerEngine.init()` |
| `ledger:blocks` | array of block dicts | `LedgerChain.append()` via `LedgerEngine.commit()` |
| `ledger:index` | `{date: {title: ms}}` | `IndexManager._flush()` |
| `entries` | array of staging DTOs | `LocalCache.writeEntries/append/update` |
| `cookie` | `{device_specifier, creation_time}` | `DeviceCookie.create()` |
| `phpoc_device_uuid` | hex UUID | `getOrCreateDeviceUuid()` |
| `ledger:staging` | reverted entries | `LedgerEngine.revert()` |
| `localStorage:phpoc_worker_url` | URL string | onboarding/connect |
| `localStorage:phpoc_api_key` | string | onboarding/connect |
| `localStorage:phpoc_deployment` | `'saas'` or `'lan'` | onboarding/connect |

## Remote Paths

| Path | Content | Obfuscated? |
|---|---|---|
| `staging/blobs/current.json` | Staging blob JSON (device_id + entries) | Yes (WASM) |
| `staging/blobs/device_cookie.bin` | `{device_uuid, device_specifier}` | No |
| `ledger:blocks` | Full ledger chain JSON array | No |
| `ledger/blocks/NNNNNN.json` | Individual obfuscated blocks (CLI format) | Yes |
| `backups/*.json` | Export backup files | No |

## Sync Gate Decision Tree (`checkAndSync()`)

```
checkAndSync()
│
├─ !transport? → READY
│
├─ [GENESIS] mk cached && local ledger:blocks.length > 0?
│   └─ GenesisGate.check(localChain, transport, crypto, mk)
│       ├─ fetch remote ledger:blocks
│       ├─ validate remote chain seals/prev_hash/entry hashes
│       ├─ compare genesis hashes
│       ├─ mismatch → return GENESIS_MISMATCH  [cached in _genesisCompatible]
│       └─ match → LedgerMerge.merge() → cache _genesisCompatible=true
│
├─ [FAST] DeviceCookie.isValidLocally(storage, 30min)?
│   ├─ pullCookie() fails? → OFFLINE
│   ├─ remote cookie matches? → pushBlobOnly(mk) + touchCookie() → READY
│   ├─ remote cookie mismatch? → set specifierMismatch=true, fall to auth
│   └─ no remote cookie? → fall to auth
│
├─ [AUTH] specifierMismatch? → REAUTH_NEEDED
├─ [AUTH] !localCookie && mk cached? → _reconcileAndClaim(mk)  [first-time after login]
├─ [AUTH] !localCookie && !mk? → REAUTH_NEEDED
├─ [AUTH] no remote cookie + mk cached? → _reconcileAndClaim(mk)
│
└─ _reconcileAndClaim(mk)
    ├─ pullCookie() fails? → OFFLINE
    ├─ remoteDeviceUuid === localDeviceUuid?
    │   └─ CASE A: pushBlobOnly(mk) + touch local cookie (keep specifier) → READY
    └─ ELSE: CASE B
        ├─ pullBlob(mk) → BLOB_KEY_MISMATCH? → OFFLINE (abort, don't overwrite)
        ├─ mergeEntries(local, remote)
        ├─ writeEntries(merged) to local
        ├─ pushBlobOnly(mk)
        ├─ DeviceCookie.create() + pushCookie()
        └─ READY
```

## Auto-Sync Flow

```
User mutation (capture/end/pause/unpause/modify/remove)
│
└─ Proxy.get(method) → autoSync._wrapMutation(method)
    │
    ├─ await rawSync[method](...args)     // local write succeeds always
    └─ _schedulePush()
        ├─ getMasterKey() === null? → skip (local-only)
        ├─ _setSyncing(true) → onSyncingChange callback → React state
        ├─ clearTimeout(prevTimer)         // coalesce
        └─ setTimeout(500ms, async () => {
              await rawSync.pushToRemote(mk)
              _setSyncing(false)
           })
```

**Push errors are caught + logged, never propagated to caller.**

## Commit Flow

```
commitEntries(entryIds) [DevModeContext]
│
├─ new LedgerEngine(crypto, storage, masterKey)
└─ engine.commit(toCommit)
    ├─ _groupByDate → encrypt fields, compute content_hash + entry hash
    ├─ for each date sorted:
    │   ├─ summaryPolicy.getSummaryBlocks(prevBlock, dateStr) → append summaries
    │   ├─ chain.buildDayBlock(entries, prevHash, dateStr) → seal + sign
    │   ├─ chain.append(block) → storage.set('ledger:blocks', [...existing, block])
    │   └─ index.update(dateStr, title, duration)
    ├─ index._flush() → storage.set('ledger:index', index)
    └─ sync.markCommitted(entryIds, blockIndex) → local entries marked committed
```

**After commit: ledger blocks are LOCAL-ONLY.** No push to remote `ledger:blocks`.

## Push Flow (`pushToRemote`)

```
pushToRemote(masterKeyHex)
│
├─ entries = await _local.readEntries()
├─ deviceId = await _getDeviceId()
├─ _remote.pushBlob(entries, deviceId, mk)
│   ├─ JSON.stringify({device_id, entries, updated_at})
│   ├─ crypto.obfuscateBlob(plaintext, mk) → base64
│   └─ transport.push('staging/blobs/current.json', bytes)
│
└─ _pushCookie(deviceId)
    ├─ DeviceCookie.destroyLocally(storage)
    ├─ DeviceCookie.create(deviceId, storage, crypto) → writes to storage 'cookie'
    └─ transport.push('staging/blobs/device_cookie.bin', cookieBytes)
```

## Pull Flow (blob)

```
remoteSync.pullBlob(masterKeyHex?)
│
├─ transport.pull('staging/blobs/current.json') → rawBytes
├─ rawBytes === null? → return null (404, no blob)
├─ try plain JSON.parse → return (backward compat)
├─ effectiveKey = masterKeyHex || crypto.getMasterKey()
├─ effectiveKey === null? → BLOB_KEY_MISMATCH
├─ b64 = bytesToBase64(rawBytes)
├─ plaintext = crypto.deobfuscateBlob(b64, effectiveKey)
│   └─ throws? → BLOB_KEY_MISMATCH
└─ return JSON.parse(plaintext)
```

## Crypto Service Lifecycle

```
Phase                  MK Status        Staging Sync       Ledger Sync
─────────────────────────────────────────────────────────────────────────
boot                   null             none               none
landing                null             none               none
onboarding             null             none               none
auth (login)           null→derived     none               none
ready (bootstrap)      cached           checkAndSync runs  genesis gate runs
ready (normal use)     cached           auto-sync active   manual commit only
after logout           cleared          none               none
re-auth overlay        null→re-derived  manual "Sync Now"  none auto
```

## Key Invariants & Guardrails

1. **Blob push order**: blob first, cookie second. If blob push fails, cookie unchanged → next sync retries. If cookie push fails after blob success, cookie mismatch triggers reconcile → pulls correct (updated) blob.
2. **BLOB_KEY_MISMATCH**: Never overwrite remote when dek fails. Returns OFFLINE.
3. **Genesis gate cached**: `_genesisCompatible` (null=unchecked, true/false). `resetGenesisGate()` clears on transport URL change.
4. **Genesis in-flight dedup**: `_genesisCheckPromise` — concurrent `checkAndSync()` calls share one network round-trip.
5. **Auth gate bypass with cached MK**: When `!localCookie && masterKeyCached`, proceeds to `_reconcileAndClaim()` instead of `REAUTH_NEEDED`. This is the fix from commit `89ec329`.
6. **Cookie specifier**: HMAC-derived, stable per device session. Never regenerated on fast path. Only created fresh in `_reconcileAndClaim` Case B.
7. **Proxy preserves prototype**: `effectiveServices.sync` uses `new Proxy(rawSync, handler)` with `Reflect.get(target, prop, receiver)` — spread `{...rawSync}` would lose class prototype methods (`getCompleted`, `markCommitted`, `getMasterKey`, etc.).
8. **`_getDeviceId()`**: prefers per-device UUID from storage (`getOrCreateDeviceUuid`), falls back to WASM HMAC from master key. WASM fallback means MK-dependent ID.
9. **WASM fallback**: `CryptoService` dynamic import; on failure logs `console.error` + sets `cryptoStatus='fallback'` + uses `DummyCryptoService`. Dummy provides fake encryption — real obfuscation won't work.

## Diagnostic Checkpoints

When sync fails at runtime (all tests passing):

1. **Is transport configured?** → `sync.isRemoteAvailable` (truthy if `_remote` not null)
2. **Is master key cached?** → `sync.getMasterKey()` or `crypto.hasMasterKey()`
3. **What does `checkAndSync()` return?** → `READY/OFFLINE/REAUTH_NEEDED/GENESIS_MISMATCH`
4. **Is there a local ledger?** → `storage.get('ledger:blocks')` (genesis gate only runs if blocks.length > 0)
5. **Is there a local cookie?** → `storage.get('cookie')` (fast path vs auth gate)
6. **Can we reach the Worker?** → `transport.pull('staging/blobs/device_cookie.bin')` (null=no cookie, error=offline, 403=auth failure)
7. **Crypto status** → `cryptoStatus` === `'wasm'` or `'fallback'`? Dummy crypto can't deobfuscate real blobs.
8. **Storage status** → `storageStatus` === `'persistent'`/`'session'`/`'memory'`? Session/memory storage may lose data on refresh.
9. **Genesis compatibility cached?** → `sync._genesisCompatible` (null = not checked, true/false). Reset with `sync.resetGenesisGate()`.
10. **Auto-sync debug** → `services.sync.isAutoSyncing` (truthy during debounce window or in-flight push)

## Known Gaps (Not Yet Implemented)

- **Ledger blocks never pushed to remote.** Committed chain stays local. No `pushLedgerBlocks()`.
- **Remote staging blob is single-key** (`staging/blobs/current.json`). No per-device partitioning. Two devices writing concurrently will race.

## Integration Points

```
OnboardingScreen
  ├─ handleWorkerFetch() → fetch remote ledger:blocks or listFiles('ledger/blocks/')
  ├─ handleWorkerUnlock() → decrypt recovery_seed_enc, derive MK, verify genesis seal
  └─ → DevModeContext.connectToWorker()
        ├─ writes seed, identity, ledger:blocks to IndexedDB
        ├─ saves remote config to localStorage
        └─ bootstrapServices({crypto, masterKey, storage})
            └─ sync.checkAndSync()  ← first sync after connect

App.jsx
  └─ reauthActive? → <AuthScreen> overlay
      └─ handleReauth(passphrase)
          ├─ crypto.authenticate(passphrase, storedSeed, iterations)
          ├─ crypto.setMasterKey(mk)  // no re-bootstrap
          └─ dismiss overlay

SyncSettings.jsx
  ├─ "Sync Now" → sync.checkAndSync() → commitEntries(all stopped)
  │   ├─ Step 1: sync staging blob with remote (pull/merge/push)
  │   ├─ Step 2: commit all completed entries to ledger
  │   ├─ result === REAUTH_NEEDED → triggerReauth()
  │   └─ result displayed as status
  ├─ displayStatus: syncing>REAUTH>remoteStatus>(NOT_SYNCED if entries exist && remote non-ready)
  └─ "Commit Selected/All" → commitEntries(ids) → LedgerEngine.commit()
```

## Transport Layer Detail

```
HttpTransport({ baseUrl, apiKey, cacheTtlMs })
│
├─ pull(path, {timeoutMs}) → Uint8Array|null
│   ├─ GET {baseUrl}/{path}
│   ├─ Headers: If-None-Match (cached ETag), X-Api-Key
│   ├─ 304 → return cached body
│   ├─ 200 → cache ETag+body, return body
│   ├─ 404 → return null
│   └─ other → throw
│
├─ push(path, data, {timeoutMs}) → void
│   ├─ PUT {baseUrl}/{path}, Content-Type: application/octet-stream
│   ├─ 2xx → clear ETag cache for path
│   └─ other → throw
│
├─ listFiles(prefix, {timeoutMs}) → string[]
│   ├─ GET {baseUrl}/?prefix={prefix}
│   ├─ 404 → return []
│   └─ 200 → JSON.parse → assert array
│
└─ delete(path, {timeoutMs}) → void
    ├─ DELETE {baseUrl}/{path}
    └─ 2xx/404 → clear cache
```

## Deployment Detection

```
createTransportFromDeployment()
  ├─ reads localStorage: phpoc_deployment, phpoc_worker_url, phpoc_api_key
  ├─ deployment === 'saas' && url? → new HttpTransport({baseUrl: url, apiKey})
  └─ else → null (local-only)
```
