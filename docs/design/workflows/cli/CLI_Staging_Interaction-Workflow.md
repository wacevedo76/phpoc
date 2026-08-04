# CLI Staging Interaction & Multi-Machine Sharing

> Map: how the CLI (`ph` commands) interacts with the local and remote staging
> area, and how multiple CLI machines share one staging area via the Worker/R2
> intermediary. Agent troubleshooting reference — not user-facing docs.

## Architecture Overview

```
Machine A (CLI)                              Machine B (CLI)
     │                                              │
     │  StagingService                              │  StagingService
     │  ├─ LocalCache → staging.json                │  ├─ LocalCache → staging.json
     │  ├─ MergeEngine                              │  ├─ MergeEngine
     │  ├─ DeviceCookie → device_cookie.meta        │  ├─ DeviceCookie → device_cookie.meta
     │  └─ RemoteStagingSync                        │  └─ RemoteStagingSync
     │         │                                    │         │
     │    HttpStagingTransport                      │    HttpStagingTransport
     │         │                                    │         │
     └─────────┼────────────────────────────────────┼─────────┘
               │                                    │
          Cloudflare Worker (worker/src/index.ts)
               │
          R2 Bucket
     ┌──────────────────────────┐
     │ staging/blobs/           │
     │   current.json           │ ← obfuscated staging (pad + AES-CTR + HMAC)
     │   device_cookie.bin      │ ← plain JSON cookie (~200 bytes)
     │ ledger:blocks            │ ← plain JSON chain
     │ ledger/index.json        │ ← plain JSON
     │ ledger/blocks/           │ ← individual block files (pushLedgerBlocks)
     └──────────────────────────┘

Note: CLI on Machine A and CLI on Machine B are independent processes.
They share staging ONLY through the R2 intermediary. There is no direct
peer-to-peer communication.
```

## Module Map

| File | Concern | Key exports |
|---|---|---|
| `main.py` | CLI entry: arg parsing, component wiring, auth tiers, command dispatch | `main()`, `StagingService(...)` creation |
| `phpoc_cli/interface.py` | `CLIInterface`: command implementations, `_sync_before_command()` gate | `CLIInterface` |
| `domain/staging/service.py` | `StagingService`: CRUD + `check_and_sync()` + `push_to_remote()` + `_reconcile_and_claim()` | `StagingService`, `SyncCheckResult` |
| `domain/staging/local_cache.py` | `LocalStagingCache`: CRUD with `plain:` prefix convention, entry_id generation | `LocalStagingCache` |
| `domain/staging/remote_sync.py` | `RemoteStagingSync`: blob obfuscation, pull/push, cookie I/O | `RemoteStagingSync`, `BLOB_KEY_MISMATCH` |
| `domain/staging/merge_engine.py` | `MergeEngine.merge()`: entry_id dedup, remote wins, sort by start_epoch | `MergeEngine` |
| `domain/cookie/device_cookie.py` | `DeviceCookie`: TTL check, specifier compare, create/destroy, parse remote | `DeviceCookie` |
| `core/sync/transport.py` | `AbstractStagingTransport`, `HttpStagingTransport`, `create_transport_from_config()` | Transport classes |
| `storage/implementations/file_staging.py` | `FileStagingStore`: read/write staging.json on disk | `FileStagingStore` |
| `phpoc_cli/onboarding.py` | `run_onboarding()`: second-machine import (pull ledger + staging + index from remote) | `run_onboarding()` |
| `phpoc_cli/wal.py` | Write-ahead log: `_write_wal_pending()`, `_spawn_background_push()`, `_replay_wal()` | WAL helpers |
| `phpoc_cli/daemon.py` | `PhDaemon`: persistent background sync (Phase C) | `PhDaemon` |
| `security/device_identity.py` | `RandomUUIDDeviceIdentityProvider`: per-machine UUID derivation | Device identity |

## Data Paths (per machine)

| Path | Content | Purpose |
|---|---|---|
| `{data_dir}/staging.json` | JSON array of raw entries with `plain:` prefixes | Local staging cache (decrypted, plaintext) |
| `{data_dir}/ledger.json` | JSON array of ledger blocks | Committed chain (encrypted entries) |
| `{data_dir}/index.json` | `{date: {title: total_ms}}` | Blind index (plaintext) |
| `{data_dir}/identity.json` | `{identity_secret_enc, device_uuid}` | Identity secret + device UUID |
| `{data_dir}/device_cookie.meta` | `{device_specifier, creation_time}` | Local device cookie |
| `{data_dir}/wal/pending_push` | `{staging_hash, timestamp, device_id}` | WAL for deferred push |
| `/dev/shm/phpoc_session` | Base64 master key | Cached session (chmod 600) |

## Local Staging Entry Format (`staging.json`)

Each entry in the local JSON array:

```json
{
  "hash": "sha256-hex-of-data-fields",
  "data": {
    "entry_id": "550e8400-e29b-41d4-a716-446655440000",
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
    "device_uuid": "abc123-...",
    "end_device_uuid": "abc123-..."
  }
}
```

- `plain:` prefix means the value is in plaintext (no real encryption). Only
  `LocalStagingCache` knows about this convention — all callers receive
  decrypted DTOs via `read_entries()`.
- `entry_id` is a stable UUID generated at capture time — survives across
  machines and is the merge key.
- `device_uuid` records which machine created the entry. `end_device_uuid`
  records which machine ended it.
- `hash` covers all `data` fields except `hash` itself.

## Command Flow — Every `ph` Command

```
ph <command>
  │
  ├─ main() resolves config, data dir, transport from config
  ├─ Creates StagingService(crypto, staging_store, transport, device_id_provider, ...)
  ├─ Creates CLIInterface(staging_service, ledger_engine, crypto)
  │
  ├─ [Phase B] _replay_wal() — replay any pending push from crash
  │
  └─ Command dispatch:

      READ COMMANDS (list, view, tags):
        ├─ crypto = cached MK ? CryptoManager : NoAuthCryptoManager
        ├─ staging_service.check_and_sync(timeout_ms=500)
        │     ├─ READY → CLIInterface.view_active() / list_habits()
        │     ├─ OFFLINE → continue with local data
        │     └─ REAUTH_NEEDED → print message, exit (no prompt for reads)
        └─ Display with decrypted fields (encrypted entries skipped gracefully)

      WRITE COMMANDS (add start/end/pause/unpause):
        ├─ crypto = cached MK ? CryptoManager : NoAuthCryptoManager
        ├─ staging_service.check_and_sync(timeout_ms=500)
        │     ├─ READY → proceed to write
        │     ├─ OFFLINE → proceed with local data
        │     └─ REAUTH_NEEDED → auth.login() prompt:
        │           ├─ Success → rebuild StagingService with fresh crypto
        │           │            → _reconcile_and_claim(mk) → proceed to write
        │           └─ Failure → exit(1)
        ├─ Write to local staging (capture/end/pause/unpause)
        ├─ _write_wal_pending() → record staging hash for crash safety
        ├─ _spawn_background_push() → fire-and-forget subprocess:
        │     └─ push_to_remote(mk) + push_cookie(device_id)
        └─ Return instantly (~2ms local write)

      SYNC COMMAND (ph sync):
        ├─ Requires auth (prompts if needed)
        ├─ SyncOrchestrator.run():
        │     ├─ check_and_sync() — merge remote staging entries
        │     ├─ Show pending entries → confirmation prompt
        │     ├─ LedgerEngine.commit() → encrypt + seal day blocks
        │     ├─ _sync_ledger_blocks() — push blocks to remote
        │     │     └─ Same-genesis divergence → LedgerMerge.merge()
        │     └─ push_to_remote(mk) — push staging blob + cookie
        └─ Done

      LOGIN COMMAND (ph login):
        ├─ auth.login() → derive MK from passphrase
        ├─ DeviceCookie.destroy_locally() — clear old cookie
        ├─ _reconcile_and_claim(mk):
        │     ├─ pullCookie() → check device_uuid
        │     ├─ Same device: pushBlobOnly(mk) + touch cookie
        │     └─ Different device: pullBlob(mk) → merge → push → new cookie
        └─ Session cached at /dev/shm/phpoc_session
```

## Transport Configuration

The CLI transport is configured via `config.json`:

```json
{
  "http": {
    "base_url": "https://phpoc-staging.username.workers.dev"
  },
  "remote": {
    "api_key": "your-api-key"
  }
}
```

Set via:
- `ph transport set http cloudflare` → interactive prompt for URL + API key
- `ph config set http.base_url "..."` + `ph config set remote.api_key "..."` → direct
- Onboarding: `ph onboarding http cloudflare` → guided setup

Configuration is stored per-machine in `~/.config/phpoc/config.json`. Each
machine can point at the same Worker URL + API key to share staging.

## Multi-Machine Scenario — Step by Step

### Machine A: First Machine (writes staging)

```
1. ph add start "Working on phpoc" --tag dev
   ├─ check_and_sync() → no remote cookie yet → fall to auth
   ├─ _reconcile_and_claim(mk):
   │     ├─ pullCookie() → null (no remote cookie)
   │     ├─ Same as different device (first time) → Case B
   │     ├─ pullBlob(mk) → null (no remote blob)
   │     ├─ writeEntries(local) → staging.json has 1 entry
   │     └─ pushBlobOnly(mk) + DeviceCookie.create('AAA') + pushCookie()
   └─ _spawn_background_push() → push_to_remote(mk) → blob to R2 ✅

   Remote state:
     staging/blobs/current.json → obfuscated {entries: [entry1]}
     staging/blobs/device_cookie.bin → {device_uuid: "AAA", device_specifier: "abc123..."}
```

### Machine B: Second Machine (new, never touched staging)

```
2. ph onboarding http cloudflare
   ├─ Prompt for Worker URL + API key
   ├─ Pull ledger blocks from R2 → write ledger.json
   ├─ Extract identity from genesis → write identity.json
   ├─ Pull staging blob from R2 → write staging.json
   │     → Machine B now has entry1 in local staging!
   ├─ Pull blind index from R2 → write index.json
   ├─ Set new passphrase → re-encrypt → re-seal → re-sign
   └─ Done — Machine B is ready

3. ph add start "Pushups" --tag health
   ├─ check_and_sync():
   │     ├─ Local cookie valid? → yes (just created by onboarding)
   │     ├─ pullCookie() → remote has device_uuid='AAA', specifier='abc123'
   │     ├─ Local specifier='def456' → MISMATCH → REAUTH_NEEDED
   │     └─ Return REAUTH_NEEDED
   ├─ auth.login() prompts → user enters passphrase → MK derived
   ├─ _reconcile_and_claim(mk):
   │     ├─ pullCookie() → remote device_uuid='AAA'
   │     ├─ Local device_uuid='BBB' → DIFFERENT DEVICE! → Case B
   │     ├─ pullBlob(mk) → deobfuscate → {entries: [entry1]}
   │     ├─ readEntries() from local staging.json → [entry1]
   │     ├─ MergeEngine.merge([entry1], [entry1]):
   │     │     → Dedup by entry_id → single entry1 (no duplicates)
   │     │     → Result: [entry1]
   │     ├─ writeEntries([entry1]) → staging.json unchanged
   │     ├─ pushBlobOnly(mk) → push to R2
   │     └─ DeviceCookie.create('BBB') + pushCookie() → remote now has specifier='def456'
   ├─ Write "Pushups" to local staging → staging.json now has [entry1, entry2]
   └─ _spawn_background_push() → push_to_remote(mk) → blob to R2 ✅

   Remote state:
     staging/blobs/current.json → obfuscated {entries: [entry1, entry2]}
     staging/blobs/device_cookie.bin → {device_uuid: "BBB", device_specifier: "def456..."}
```

### Machine A: Comes Back Later

```
4. ph view
   ├─ check_and_sync():
   │     ├─ Local cookie valid? → creation_time within 30min? → depends
   │     │
   │     ├─ TTL valid (within 30 min):
   │     │     ├─ pullCookie() → remote has specifier='def456'
   │     │     ├─ Local specifier='abc123' → MISMATCH → REAUTH_NEEDED
   │     │     └─ Print "Remote staging is held by a different device."
   │     │        → User must ph login to reconcile
   │     │
   │     └─ TTL expired (> 30 min):
   │           └─ No valid local cookie → REAUTH_NEEDED
   │              → Print "Remote staging is held by a different device."

5. ph login
   ├─ User enters passphrase → MK derived
   ├─ DeviceCookie.destroy_locally() → remove old specifier
   ├─ _reconcile_and_claim(mk):
   │     ├─ pullCookie() → remote device_uuid='BBB'
   │     ├─ Local device_uuid='AAA' → DIFFERENT DEVICE! → Case B
   │     ├─ pullBlob(mk) → deobfuscate → {entries: [entry1, entry2]}
   │     ├─ readEntries() from local staging.json → [entry1] (no entry2!)
   │     ├─ MergeEngine.merge([entry1], [entry1, entry2]):
   │     │     → entry1: same entry_id → remote wins → entry1 (updated)
   │     │     → entry2: new from remote → added
   │     │     → Result: [entry1, entry2] sorted by start_epoch
   │     ├─ writeEntries([entry1, entry2]) → staging.json updated!
   │     ├─ pushBlobOnly(mk) → push merged blob to R2
   │     └─ DeviceCookie.create('AAA') + pushCookie() → new specifier
   └─ ✅ Machine A now has both entries

6. ph view
   ├─ check_and_sync():
   │     ├─ Local cookie valid → TTL fresh (just created)
   │     ├─ pullCookie() → specifier match → FAST PATH
   │     └─ _pushOnFastPath():
   │           ├─ pushBlobOnly(mk) → push local blob (full replace)
   │           └─ _touchLocalCookie() → extend TTL
   └─ Show entries: "Working on phpoc" (active) + "Pushups" (active)
```

## Decision Tree — `check_and_sync()` on CLI

```
check_and_sync(timeout_ms=500):

1. _remote is None?
   ├─ Yes → DeviceCookie.is_valid_locally(data_dir, ttl)?
   │         ├─ Valid → READY
   │         └─ Expired/missing → REAUTH_NEEDED (even local-only!)
   └─ No → continue

2. [FAST PATH] DeviceCookie.is_valid_locally(data_dir, ttl_minutes)?
   ├─ Valid → pull_cookie() from remote
   │     ├─ pull fails → OFFLINE
   │     ├─ No remote cookie → fall to auth (Step 3)
   │     ├─ Specifier MATCH → _push_on_fast_path(local_cookie):
   │     │     push_blob_only(mk)        // full replace blob (if MK cached)
   │     │     _touch_local_cookie()     // extend TTL
   │     │     → READY ✅
   │     └─ Specifier MISMATCH → REAUTH_NEEDED
   └─ Expired/missing → fall to auth (Step 3)

3. [AUTH GATE]
   ├─ Specifier mismatch → REAUTH_NEEDED (unconditional)
   ├─ No local cookie → REAUTH_NEEDED
   |     (even if CryptoManager is cached — cookie is the truth)
   └─ No remote cookie, have MK → _reconcile_and_claim(mk):
         ├─ pull cookie fails → OFFLINE
         ├─ Same device_uuid → Case A: push_blob_only + touch cookie
         └─ Different device_uuid → Case B:
               ├─ pullBlob(mk) → BLOB_KEY_MISMATCH? → OFFLINE
               ├─ MergeEngine.merge(local, remote)
               ├─ write_entries(merged)
               ├─ push_blob_only(mk)
               ├─ DeviceCookie.create() + push_cookie()
               └─ → READY ✅
```

## Auth Tiers — Which Commands Prompt for Passphrase

| Command type | Crypto | REAUTH_NEEDED behavior |
|---|---|---|
| **Read** (`list`, `view`, `tags`) | Cached MK → CryptoManager. Else → NoAuthCryptoManager | Print message + exit. No prompt. |
| **Write** (`add start/end/pause/unpause`) | Cached MK → CryptoManager. Else → NoAuthCryptoManager | Prompt for passphrase → re-auth → rebuild. |
| **Admin** (`sync`, `verify`, `rep`, `modify`, `review`, `revert`) | Must have CryptoManager — prompts if no cached MK | N/A — always requires auth. |

## Cookie Lifecycle

```
New machine (no cookie):
  ph login or first write → _reconcile_and_claim() → DeviceCookie.create() → specifier

Same machine, fresh session (cookie valid):
  check_and_sync() → fast path → _push_on_fast_path() → _touch_local_cookie()
  → creation_time updated, specifier unchanged → TTL extended

Same machine, stale session (cookie expired > 30 min):
  check_and_sync() → no valid local cookie → REAUTH_NEEDED
  → ph login → _reconcile_and_claim() → DeviceCookie.create() → NEW specifier

Different machine (cookie mismatch):
  check_and_sync() → specifier mismatch → REAUTH_NEEDED
  → ph login → _reconcile_and_claim() → Case B merge → DeviceCookie.create() → NEW specifier
```

## Background Push — WAL + Deferred Sync

```
ph add start "Task"
  │
  ├─ StagingService.capture() → LocalCache.append() → staging.json written
  ├─ _write_wal_pending(data_dir, entries, device_id)
  │     → writes {staging_hash, timestamp, device_id} to wal/pending_push
  └─ _spawn_background_push(data_dir)
        → forks detached subprocess (fire-and-forget)
        → subprocess:
            ├─ Read WAL → verify staging hash matches
            ├─ Check /dev/shm/phpoc_session for MK
            ├─ If MK: StagingService.push_to_remote(mk) → clear WAL
            └─ No MK: write notification file → exit (WAL stays for retry)

Next CLI startup:
  main() → _replay_wal(CONFIG_DIR, staging_service)
    ├─ Check wal/pending_push exists?
    ├─ Not stale (> 24h) → silently clean up
    ├─ Staging hash matches? → push_to_remote(mk) → clear WAL
    └─ Staging hash changed → WAL is obsolete → clean up
```

This ensures `ph add` returns instantly (~2ms local write) while the remote
push happens asynchronously. Crash-safe: the WAL survives process death.

## Daemon Mode (Phase C)

```
ph daemon start
  └─ PhDaemon.start():
       ├─ Fork daemon process (detached from terminal)
       ├─ FileWatcher polls staging.json for mtime changes
       ├─ On change detected → DebounceQueue.trigger()
       └─ After 500ms quiet period → push_to_remote(mk)
```

## Onboarding — Second Machine Import Flow

```
ph onboarding http cloudflare

1. Prompt for Worker URL + API key
2. Create HttpStagingTransport(url, api_key)
3. Save config to ~/.config/phpoc/config.json

4. Prompt for recovery seed → derive master key
5. Pull ledger:blocks from R2 → write ledger.json
6. Extract identity_secret from genesis → write identity.json
7. Pull staging blob from R2 → deobfuscate → write staging.json
8. Pull index from R2 → write index.json
9. Set new passphrase → re-encrypt genesis → re-seal → re-sign chain
10. Push re-chained blocks to remote
11. Cache MK → verify integrity → show summary
```

## Merge Engine — Cross-Machine Dedup

```
MergeEngine.merge(local_entries, remote_entries):

  1. Build dict keyed by dedup_key
  2. Process local entries first → seen[key] = entry (source="local")
  3. Process remote entries → seen[key] = entry (source="remote")
     (overwrites local — remote wins on ties)
  4. Sort by start_epoch ascending → return

dedup_key(entry):
  Primary: entry_id (stable UUID generated at capture)
  Fallback: (title, start_epoch)  // pre-entry_id compatibility
```

**Why remote wins:** The remote blob represents the last machine that wrote.
If Machine B updated an entry that Machine A also has locally, Machine B's
version is more recent.

## Key Invariants

1. **Cookie is the truth**: `check_and_sync()` never consults the crypto key
   for auth decisions. The device cookie is the sole authority. TTL expiry
   forces re-auth even if a valid MK is cached.

2. **Specifier mismatch = re-auth**: when the remote cookie's specifier
   differs from local, the user must explicitly authenticate via `ph login`.
   No silent cross-machine merging without consent.

3. **Push order**: blob first, cookie second. Never cookie before blob.
   If blob push fails, cookie unchanged → next `check_and_sync()` finds
   matching cookies → retries blob on fast path.

4. **BLOB_KEY_MISMATCH**: never overwrite remote with unreadable data.
   Returns OFFLINE and preserves local state.

5. **Full-replace push**: staging blob is always a full replacement, not
   an append. The merge engine handles deduplication on pull.

6. **Local staging is plaintext**: `staging.json` uses `plain:` prefix
   convention. Only `LocalStagingCache` knows about this — all callers
   receive decrypted DTOs. Remote blob is always obfuscated.

7. **Read commands don't prompt**: `list`, `view`, `tags` use
   `NoAuthCryptoManager` if no cached MK. Encrypted entries are
   gracefully skipped with `[encrypted]` markers.

8. **WAL is crash-safe**: every write triggers `_write_wal_pending()`.
   On startup, `_replay_wal()` retries pending pushes. Stale WALs
   (> 24h) are silently cleaned up.

9. **Device identity is per-machine**: `RandomUUIDDeviceIdentityProvider`
   derives a persistent UUID from the master key. Same MK → same UUID
   across sessions. Used for cookie device_uuid comparisons.

10. **Cookie TTL applies to local-only too**: even without a remote
    transport, the device cookie TTL gates staging access. After expiry,
    `ph list` prompts for re-auth.

## Diagnostic Checkpoints

| # | Check | Expression |
|---|---|---|
| 1 | Transport configured? | `staging_service._remote is not None` |
| 2 | Local cookie valid? | `DeviceCookie.is_valid_locally(data_dir, ttl_minutes)` |
| 3 | Remote cookie exists? | `staging_service._remote.pull_cookie()` → not None |
| 4 | Specifiers match? | `DeviceCookie.matches(local, remote)` → True |
| 5 | check_and_sync result? | `SyncCheckResult.READY` / `OFFLINE` / `REAUTH_NEEDED` |
| 6 | MK cached? | `/dev/shm/phpoc_session` exists and is recent |
| 7 | Crypto valid? | `isinstance(crypto, CryptoManager)` (not NoAuthCryptoManager) |
| 8 | Blob key works? | `remote.pull(mk) is not BLOB_KEY_MISMATCH` |
| 9 | Merge occurred? | In `_reconcile_and_claim`: `remote_device_uuid != local_device_uuid` |
| 10 | WAL pending? | `wal/pending_push` exists → check staleness |
| 11 | Daemon running? | `ph daemon status` → PID file exists + process alive |
| 12 | Staging file exists? | `{data_dir}/staging.json` exists and is valid JSON |

## Known Gaps

1. **No push notification**: Machine A has no way to know that Machine B
   wrote to staging. Must run `ph login` or `ph view` (which triggers
   `check_and_sync`) to discover remote changes.

2. **Cookie TTL determines discovery latency**: if Machine A's cookie is
   still fresh (within 30 min) when Machine B writes, Machine A won't
   discover Machine B's entries until the cookie expires or `ph login`
   is manually run. The fast path skips the full blob pull.

3. **WAL is per-write, not batched**: rapid writes (`ph add start A`,
   `ph add start B`, `ph add start C`) each trigger a separate WAL +
   background push. No coalescing of concurrent writes.

4. **No merge for ledger commits**: `ph sync` commits entries to the
   ledger locally. The committed blocks are pushed via
   `_sync_ledger_blocks()`, but if two machines committed different
   entries, the diverging chains require `LedgerMerge.merge()` —
   which only runs during `ph sync` on the CLI.

5. **Staging → ledger is manual**: staging entries are never
   auto-committed. The user must run `ph sync` to move completed
   entries from staging into the ledger chain.

6. **Daemon is optional**: background sync via `ph daemon start` is
   Phase C and not enabled by default. Without it, remote changes
   are only discovered on explicit command invocation.

## Test Reference

| Suite | Tests | Scope |
|---|---|---|
| `tests/test_staging_sync_optimization.py` | 85 tests | Fast path, Case A/B, merge, TTL, cookie lifecycle |
| `tests/test_phase4_staging_interaction_flow.py` | 69 tests | Full sync lifecycle, push, WAL replay |
| `tests/test_phase5_main_wiring.py` | 72 tests | CLI command dispatch + argparse routing |
| `tests/test_phase6c_orchestrator_cli.py` | 11 merge tests | CLI orchestrator merge wiring |
| `tests/test_wal.py` | WAL tests | Write-ahead log lifecycle |
| `tests/test_onboarding_e2e.py` | 76 tests | Onboarding flows (remote + file) |
| `tests/test_http_transport.py` | 68 tests | HTTP + ETag transport |
