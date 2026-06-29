# Cross-Device Staging Sharing — phpoc-cli ↔ phpoc-web

> Map: code locations for the staging area sharing between CLI and Web.
> The staging area flows through a Cloudflare Worker → R2 bucket intermediary.
> Both implementations share identical protocols — the Worker is a dumb byte store.

## Architecture

```
phpoc-cli (Python)           phpoc-web (React/JS)
      │                              │
      │  HttpStagingTransport        │  HttpTransport (fetch)
      │  POST/GET/PUT/DELETE          │  POST/GET/PUT/DELETE
      │                              │
      └──────────┬───────────────────┘
                 │
        Cloudflare Worker
        (worker/src/index.ts)
                 │
            R2 Bucket
    ┌────────────────────────────┐
    │ staging/blobs/current.json │ ← obfuscated (pad + AES-CTR + HMAC)
    │ staging/blobs/device_     │
    │   cookie.bin               │ ← plain JSON (~200 bytes)
    │ ledger:blocks              │ ← plain JSON (raw chain)
    │ ledger/index.json          │ ← plain JSON
    └────────────────────────────┘
```

## Shared Protocol (Identical Across CLI and Web)

| Component | CLI (Python) | Web (JS) |
|---|---|---|
| Sync gate | `domain/staging/service.py` → `StagingService` | `phpoc-web/src/sync/sync.js` → `SyncService` |
| Merge engine | `domain/staging/merge_engine.py` → `MergeEngine` | `phpoc-web/src/sync/merge_engine.js` → `mergeEntries()` |
| Device cookie | `domain/cookie/device_cookie.py` → `DeviceCookie` | `phpoc-web/src/sync/cookie.js` → `DeviceCookie` |
| Remote sync | `domain/staging/remote_sync.py` → `RemoteStagingSync` | `phpoc-web/src/sync/remote_sync.js` → `RemoteSync` |
| Transport | `core/sync/transport.py` → `HttpStagingTransport` | `phpoc-web/src/sync/transport.js` → `HttpTransport` |
| Ledger merge | `domain/ledger/merge.py` → `LedgerMerge` | `phpoc-web/src/ledger/merge.js` → `LedgerMerge` |
| Genesis gate | `core/sync/orchestrator.py` → `_is_same_genesis()` | `phpoc-web/src/sync/genesis_gate.js` → `GenesisGate` |

## Remote Paths (R2)

| Path | Format | Obfuscated? | Writer |
|---|---|---|---|
| `staging/blobs/current.json` | `{device_id, device_proof, entries: [...], updated_at}` | Yes (pad + AES-CTR + HMAC) | CLI or Web push |
| `staging/blobs/device_cookie.bin` | `{device_uuid, device_specifier}` | No (plain JSON) | CLI or Web push |
| `ledger:blocks` | `[{type, date, entries, seal, ...}]` | No (plain JSON) | GenesisGate / pushLedgerBlocks |
| `ledger/index.json` | `{date: {title: ms}}` | No (plain JSON) | LedgerEngine |

## Shared Data Format — Staging Entry

Both CLI and Web use the `plain:` prefix convention for encrypted fields in the staging blob. When deobfuscated, the blob contains:

```json
{
  "device_id": "uuid",
  "entries": [
    {
      "hash": "sha256-hex",
      "data": {
        "entry_id": "stable-uuid",
        "title": "Working on phpoc",
        "startTime_enc": "plain:1714000000000",
        "endTime_enc": "plain:1714003600000",
        "duration": 3600000,
        "is_active": false,
        "is_paused": false,
        "pauses_enc": "plain:[]",
        "tags": ["dev"],
        "comment": null,
        "media": [],
        "metadata_enc": "plain:{}",
        "device_uuid": "uuid",
        "end_device_uuid": "uuid"
      }
    }
  ],
  "updated_at": 1714000000000
}
```

**Key:** `entry_id` is the stable UUID that survives across devices —
it's the merge key. `device_uuid` carries provenance (which device created
the entry). `end_device_uuid` records which device ended it.

## Decision Tree — `checkAndSync()` / `check_and_sync()`

```
Device B (e.g., phpoc-web) boots and runs SyncService.checkAndSync():

1. Remote configured?
   ├─ No → READY (local-only)
   └─ Yes → continue

2. [GENESIS GATE] Local ledger blocks exist?
   ├─ No → skip (nothing to protect)
   └─ Yes → GenesisGate.check(localChain, transport, crypto, mk)
       ├─ Empty remote → compatible (first boot)
       ├─ Seals/hashes invalid → GENESIS_MISMATCH
       ├─ Genesis mismatch → GENESIS_MISMATCH (different ledger)
       └─ Genesis match + same chain → compatible
           Genesis match + divergent chain → LedgerMerge.merge()
           → persist merged chain → pushFullLedgerChain → compatible

3. [FAST PATH] DeviceCookie.isValidLocally(storage, 30min)?
   ├─ Expired/missing → fall to auth gate (Step 5)
   └─ Valid → pullCookie() from remote
       ├─ pull fails → OFFLINE
       ├─ No remote cookie → fall to auth gate (Step 5)
       ├─ Specifier MATCH → _pushOnFastPath(local_cookie):
       │     pushBlobOnly(mk)        // push local blob (full replace)
       │     _touchLocalCookie()     // extend TTL
       │     → READY ✅
       └─ Specifier MISMATCH → REAUTH_NEEDED (must auth)

4. [AUTH GATE] Specifier mismatch?
   └─ Yes → REAUTH_NEEDED (unconditional — must consent to cross-device merge)

5. [AUTH GATE] No valid local cookie?
   ├─ Master key cached? → _reconcileAndClaim(mk)
   └─ No master key → REAUTH_NEEDED

6. _reconcileAndClaim(mk):
   ├─ pullCookie() fails → OFFLINE
   ├─ remote_device_uuid === local_device_uuid?
   │   └─ Yes → Case A: pushBlobOnly(mk) + touch local cookie
   │             → READY ✅
   └─ No → Case B: different device or first time
       ├─ pullBlob(mk)
       │   └─ BLOB_KEY_MISMATCH? → OFFLINE (don't overwrite)
       ├─ mergeEntries(local, remote)
       ├─ writeEntries(merged) to local cache
       ├─ pushBlobOnly(mk) to remote
       ├─ DeviceCookie.create() + pushCookie()
       └─ → READY ✅
```

## Case B in Detail — Cross-Device Merge

This is the critical path when switching from Device A to Device B.

```
Device A (CLI) captured entries → pushed blob + cookie to R2
Device B (Web) starts up:

1. checkAndSync() → cookie mismatch → REAUTH_NEEDED
2. User enters passphrase → MK derived
3. _reconcileAndClaim(MK):
   a. pullCookie() → remote has device_uuid='AAA'
   b. local device_uuid='BBB' → different device!
   c. pullBlob(MK) → deobfuscate staging blob from R2
      → {entries: [entryA1, entryA2, ...]}
   d. readEntries() from local IndexedDB → [entryB1]
   e. mergeEntries([entryB1], [entryA1, entryA2]):
      - entryA1: entry_id='e1' → added (new from remote)
      - entryA2: entry_id='e2' → added (new from remote)
      - entryB1: entry_id='e3' → kept (local-only)
      → result: [e1, e2, e3] sorted by start_epoch
   f. writeEntries(merged) to local IndexedDB
   g. pushBlobOnly(MK) → push merged blob to R2
   h. DeviceCookie.create('BBB') → new specifier, push to R2
   → READY ✅
```

## Merge Engine — Dedup Logic

Both implementations use identical algorithm:

```
merge(local_entries, remote_entries):
  1. Build Map<dedup_key, entry>
  2. Process local first → set(key, entry)
  3. Process remote → set(key, entry)   // overwrites local (remote wins)
  4. Sort by start_epoch ascending

dedup_key(entry):
  Primary: entry_id (stable UUID)
  Fallback: (title, start_epoch)  // for pre-entry_id entries
```

**Remote wins on ties** because it represents the more recent state from
the device that wrote last.

## Push Order — Why It Matters

```
Blob push FIRST → Cookie push SECOND
```

| Scenario | Behavior |
|---|---|
| Blob push fails | Cookie unchanged → next `checkAndSync` finds matching cookies → retries blob on fast path |
| Cookie push fails after blob success | Cookie mismatch → `_reconcileAndClaim` pulls updated blob → creates fresh cookie → self-healing |
| Old order (cookie first, bug) | Failed cookie push destroyed local cookie but left stale blob → reconcile pulled OLD blob → lost committed entries |

**Invariant:** Blob push always precedes cookie push. Both implementations
follow this order.

## Device Cookie — The Fast Path

- **Remote cookie** (`device_cookie.bin`): `{device_uuid, device_specifier}` — plain JSON
- **Local cookie** (`IndexedDB` key `cookie` or `device_cookie.meta`): `{device_specifier, creation_time}` — local only
- **TTL:** 30 minutes (configurable). Expired cookies force re-auth.
- **Specifier:** 32-char random hex (16 bytes) — generated by Rust WASM `generateDeviceSpecifier()`
- **Comparison:** `local.specifier === remote.specifier` → same device session → skip full blob pull (~64KB+)

## Obfuscation — Staging Blob

```
Serialized JSON → pad to tier ceiling (random fill) → encrypt with blob sub-key → HMAC tag

Tiers: 64K | 128K | 256K | 512K
Blob sub-key: HMAC-SHA256(MK, "blob-obfuscation")[:16]
Format: salt(16) + nonce(8) + plaintext_len(4) + padded_data + tag(32)
```

Both CLI and Web use the same obfuscation so either side can deobfuscate
the blob pushed by the other. The Web delegates to Rust WASM
(`CryptoService.obfuscateBlob()` / `deobfuscateBlob()`). The CLI implements
it in pure Python (`_obfuscate()` / `_deobfuscate()`).

## Genesis Gate — Ledger Chain Compatibility

Before any staging sync, both sides verify the remote ledger shares
the same genesis block. If the genesis block matches but chains have
diverged (different commits on each device), `LedgerMerge.merge()` produces
a reconciled chain.

```
GenesisGate.check(localChain, transport, crypto, mk):
  1. Pull remote chain from ledger:blocks
  2. Empty remote → compatible (first boot)
  3. Compare genesis blocks (first block) → mismatch → GENESIS_MISMATCH
  4. Compare full chains → same → compatible
  5. Chains diverge → LedgerMerge.merge(local, remote) → merged chain
  6. Persist merged chain locally + push to remote
```

## Key Invariants

1. **Cookie is the truth**: `checkAndSync` never consults the crypto key
   for auth decisions — the device cookie is the sole authority. This means
   both CLI and Web must agree on cookie format and TTL.

2. **Specifier mismatch = re-auth**: When the remote cookie's specifier
   differs from local, the user must explicitly authenticate. No silent
   cross-device merging without user consent.

3. **Push order**: blob first, cookie second. Never cookie before blob.

4. **BLOB_KEY_MISMATCH**: never overwrite remote with unreadable data.
   Both sides return OFFLINE and preserve local state.

5. **entry_id is the merge key**: stable UUID generated at capture time.
   Entries from different devices with the same `entry_id` are the same
   entry — remote wins. Fallback to `(title, start_epoch)` for backward
   compatibility with pre-entry_id entries.

6. **Full-replace push**: staging blob is always a full replacement, not
   an append. The merge engine handles deduplication on pull.

7. **Genesis gate runs first**: blob sync is blocked until genesis
   compatibility is verified. Prevents cross-ledger data corruption.

8. **Cookie TTL applies to local-only too**: even without a remote
   transport, the device cookie TTL gates staging access. After expiry,
   the user must re-authenticate.

## Diagnostic Checkpoints

| # | Check | CLI expression | Web expression |
|---|---|---|---|
| 1 | Transport configured? | `service._remote is not None` | `sync.isRemoteAvailable` |
| 2 | Local cookie valid? | `DeviceCookie.is_valid_locally(data_dir, ttl)` | `DeviceCookie.isValidLocally(storage, ttl)` |
| 3 | Remote cookie fetched? | `remote.pull_cookie()` | `remote.pullCookie()` |
| 4 | Specifiers match? | `DeviceCookie.matches(local, remote)` | `DeviceCookie.matches(local, remote)` |
| 5 | checkAndSync result? | `READY` / `OFFLINE` / `REAUTH_NEEDED` | `SyncResult.READY` / `OFFLINE` / `REAUTH_NEEDED` / `GENESIS_MISMATCH` |
| 6 | Master key available? | `isinstance(crypto, CryptoManager)` | `crypto.getMasterKey()` |
| 7 | Blob key works? | `remote.pull(mk) is not BLOB_KEY_MISMATCH` | `remote.pullBlob(mk) !== BLOB_KEY_MISMATCH` |
| 8 | Genesis compatible? | `orchestrator._is_same_genesis(...)` | `sync._genesisCompatible` |
| 9 | Merge occurred? | `remote_device_uuid != local_device_uuid` in `_reconcile_and_claim` | Same (Case B path) |
| 10 | Cookie pushed? | `remote.push_cookie(...)` called | `remote.pushCookie(...)` called |

## Known Gaps

1. **Ledger blocks not on remote by default**: `pushLedgerBlocks()` is
   implemented but only called explicitly — not part of the auto-sync flow.
   The CLI's `_sync_ledger_blocks()` pushes blocks during `ph sync`, but
   the Web app requires a manual trigger or the genesis gate merge path.

2. **Remote staging blob is single-key**: two devices writing concurrently
   will race — last writer wins. No transactional conflict resolution.

3. **Raw chain staging extraction**: CLI `ledger.json` import puts all
   entries inside `ledger:blocks`. There's no way to extract committed
   entries back into staging for editing or re-commit.

4. **Cross-device genesis mismatch**: when two devices have different
   genesis blocks, there's no merge path. The user must choose one ledger
   to keep via the "Clear Remote & Overwrite" flow on Web or manual
   intervention on CLI.

5. **No cross-device ledger commit sync**: committed entries in `ledger:blocks`
   are local-only by default. GenesisGate merge is the only path that
   reconciles divergent chains. No background auto-merge of new blocks.

## Module Map

| Concern | CLI (Python) | Web (JS) | Worker |
|---|---|---|---|
| Sync gate + CRUD | `domain/staging/service.py` | `phpoc-web/src/sync/sync.js` | — |
| Merge engine | `domain/staging/merge_engine.py` | `phpoc-web/src/sync/merge_engine.js` | — |
| Remote blob sync | `domain/staging/remote_sync.py` | `phpoc-web/src/sync/remote_sync.js` | — |
| Device cookie | `domain/cookie/device_cookie.py` | `phpoc-web/src/sync/cookie.js` | — |
| Device UUID | `security/device_identity.py` | `phpoc-web/src/sync/device_uuid.js` | — |
| Local staging cache | `domain/staging/local_cache.py` | `phpoc-web/src/sync/local_cache.js` | — |
| HTTP transport | `core/sync/transport.py` | `phpoc-web/src/sync/transport.js` | — |
| Genesis gate | `core/sync/orchestrator.py` | `phpoc-web/src/sync/genesis_gate.js` | — |
| Ledger merge | `domain/ledger/merge.py` | `phpoc-web/src/ledger/merge.js` | — |
| Blob obfuscation | `domain/staging/remote_sync.py` (Python) | `phpoc-web/src/crypto/index.js` (WASM) | — |
| Worker (pass-through) | — | — | `worker/src/index.ts` |

## Test Reference

| Suite | Tests | Scope |
|---|---|---|
| `tests/test_staging_sync_optimization.py` | 13 scenarios | CLI: fast path, 10% window, Case A/B, merge, TTL |
| `phpoc-web/test/sync_service_test.mjs` | 129 tests | Web: full SyncService, genesis gate, merge, cookie |
| `tests/test_ledger_merge.py` | 47 tests | Python LedgerMerge.merge() |
| `phpoc-web/test/ledger_merge_test.mjs` | 37 tests | Web LedgerMerge.merge() |
| `tests/test_phase6c_orchestrator_cli.py` | 11 merge tests | CLI orchestrator merge wiring |
| `phpoc-web/test/genesis_gate_test.mjs` | GenesisGate | Web genesis compatibility |
