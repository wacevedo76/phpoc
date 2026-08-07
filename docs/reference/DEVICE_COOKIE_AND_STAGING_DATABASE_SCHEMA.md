# Device Cookie & Staging Database Schema

Reference for the two cross-cutting staging subsystems: the Device Cookie (cross-device session detection) and the Staging Database Schema (mutable entry storage). All three clients (CLI, Web, Flutter) implement these with the same protocol contracts.

---

## 1. Device Cookie

### Purpose

The device cookie is a **cross-device session detection mechanism** that enables a "fast path" for staging sync. Instead of pulling and decrypting the full staging blob (~64KB+) plus re-authenticating, the system compares a ~100-byte random specifier to determine if the same device session is still active.

- **Fast path**: same-device writes skip auth gate and full blob pull
- **Cross-device detection**: specifier mismatch forces explicit auth (user must consent to cross-device merge)
- **TTL-based expiry** (default 30 min): after expiry, re-authentication is required regardless of cached crypto keys

### Security Model

- `device_specifier` is a CSPRNG 16-byte (32-char) hex string — unguessable
- No master key needed for comparison — the specifier **is** the identity proof
- Remote cookie is **unencrypted JSON** (unguessable but not secret)
- `device_uuid` on remote is informational (debugging), NOT used for auth

### Data Format

| Location | Key / Path | Content |
|---|---|---|
| **Local** | `device_cookie.meta` / `'cookie'` | `{"device_specifier": "<32-char hex>", "creation_time": <epoch_ms>}` |
| **Remote** | `staging/blobs/device_cookie.bin` | `{"device_uuid": "<UUID>", "device_specifier": "<32-char hex>"}` |

The remote cookie is **never cached locally** — it is pulled fresh from the transport on every `check_and_sync()`.

### Sync Flow

```
check_and_sync():
  1. Remote configured? No → READY (local-only)
  2. Local cookie valid (TTL not expired)?
     ├─ Yes → pull remote cookie (~100 bytes)
     │        ├─ Specifier match → READY (fast path: push local blob, extend TTL)
     │        └─ Specifier mismatch → REAUTH_NEEDED
     └─ No / Expired → REAUTH_NEEDED
  3. Auth gate:
     ├─ Valid CryptoManager → reconcile_and_claim (pull, merge, push, new cookie)
     └─ No valid CryptoManager → REAUTH_NEEDED
```

### Cookie Lifecycle

- **Create**: on auth gate success (reconcile + claim), generates fresh specifier → writes local cookie + pushes remote cookie
- **Touch**: on every local write (capture/end/pause/modify/remove), resets `creation_time` to extend TTL — local only, no remote push
- **Destroy**: on TTL expiry or specifier mismatch — local cookie removed, must re-auth
- **Create local-only**: when no remote transport configured, writes local cookie for TTL tracking only

### Implementation by Client

#### CLI (Python) — `domain/cookie/device_cookie.py`

| Aspect | Detail |
|---|---|
| File | `domain/cookie/device_cookie.py` |
| Specifier gen | `os.urandom(16).hex()` |
| Local storage | `~/.local/share/phpoc/device_cookie.meta` (JSON file) |
| Remote cache | `~/.local/share/phpoc/device_cookie.bin` (written by `create()`, read by `get_remote_bytes()` for push) |
| Orchestrator | `domain/staging/service.py` → `StagingService.check_and_sync()` |
| Remote transport | `domain/staging/remote_sync.py` → `RemoteStagingSync.pull_cookie()` / `push_cookie()` |
| Path constant | `REMOTE_COOKIE_PATH = "staging/blobs/device_cookie.bin"` |
| Key methods | `create()`, `create_local()`, `is_valid_locally()`, `parse_remote()`, `matches()`, `destroy_locally()`, `get_remote_bytes()` |
| `_touch_local_cookie()` | Resets `creation_time` to now (ensures monotonic increase); skips if no local cookie exists |

#### Web (JS/React) — `phpoc-web/src/sync/cookie.js`

| Aspect | Detail |
|---|---|
| File | `phpoc-web/src/sync/cookie.js` |
| Specifier gen | `crypto.generateDeviceSpecifier()` (WASM-based CSPRNG via `phpoc-crypto-core`) |
| Local storage | IndexedDB via `StorageBackend`, key `'cookie'` (`LOCAL_COOKIE` constant in `keys.js`) |
| Orchestrator | `phpoc-web/src/sync/sync.js` → `SyncService.checkAndSync()` |
| Remote transport | `phpoc-web/src/sync/remote_sync.js` → `RemoteSync.pullCookie()` / `pushCookie()` |
| Path constant | `REMOTE_DEVICE_COOKIE = 'staging/blobs/device_cookie.bin'` (from `keys.js`) |
| Key methods | `DeviceCookie.create()`, `isValidLocally()`, `parseRemote()`, `matches()`, `destroyLocally()` (all static) |
| TTL default | `DEFAULT_TTL_MS = 30 * 60 * 1000` |
| Cookie reuse | `pushToRemote()` reuses existing `device_specifier` on same-device writes (prevents spurious mismatches with CLI) |

#### Flutter (Dart) — `phpoc-flutter/lib/data/sync/device_cookie.dart`

| Aspect | Detail |
|---|---|
| Files | `lib/core/models/device_cookie.dart` (data model), `lib/data/sync/device_cookie.dart` (logic) |
| Specifier gen | `Random.secure()` + manual `_bytesToHex()` (16 bytes → 32-char hex) |
| Local storage | SQLite `_staging_kv` table, key `'cookie'` (via `StagingStorage`) |
| Orchestrator | `lib/data/sync/sync_service.dart` → `SyncService.checkAndSync()` |
| Remote transport | `HttpTransport.pull(StagingPaths.remoteDeviceCookie)` |
| Path constant | `StagingPaths.remoteDeviceCookie` (resolves to `staging/blobs/device_cookie.bin`) |
| Key methods | `create()`, `isValidLocally()`, `matches()`, `parseRemote()`, `destroyLocally()` |
| Cookie model | `DeviceCookie` class with `deviceUuid`, `deviceSpecifier`, `creationTime` (seconds epoch) |

---

## 2. Staging Database Schema

### Purpose

Staging is the **mutable holding area** for activity entries before they are committed to the immutable ledger. It holds:

- **Active** tasks (currently tracking)
- **Paused** tasks (user paused, will resume)
- **Ended** tasks (completed, awaiting ledger commit)

The staging store is the local source of truth for pending activities and is synced to the remote worker (R2) for cross-device access.

### Two Schema Eras

#### Legacy — Monolithic JSON Blob

Single `entries` JSON array persisted as one blob (key `'entries'` in IndexedDB, `staging.json` file on CLI).

```json
[
  {
    "hash": "<sha256-hex>",
    "data": {
      "title": "...",
      "startTime_enc": "plain:1234567890",
      "endTime_enc": "plain:1234568000",
      "pauses_enc": "plain:[]",
      "metadata_enc": "plain:{}",
      "device_uuid_enc": "plain:uuid",
      "entry_id": "uuid",
      "tags": [],
      "is_active": false,
      "is_paused": false
    },
    "committed": false,
    "block_index": null
  }
]
```

All three clients still support this path for backward compatibility via:
- CLI: `FileStagingStore` → `storage/implementations/file_staging.py`
- Web: `LocalCache` (wraps StorageBackend, key `'entries'`)
- Flutter: `StagingStorage` KV adapter + `LocalCache` fallback

#### Row-Level — Row-per-Activity (current)

Each activity is an independent row, enabling fine-grained sync and LWW merging.

**Canonical schema:**

```sql
CREATE TABLE staging (
    activity_id    TEXT PRIMARY KEY,              -- 10-char CSPRNG alphanumeric ID
    activity_status TEXT NOT NULL,                -- 'active' | 'paused' | 'ended' | 'staged'
    activity       TEXT NOT NULL,                 -- JSON blob of encrypted entry data
    updated_at     INTEGER NOT NULL DEFAULT 0,     -- epoch ms (LWW tiebreaker)
    _extra         TEXT NOT NULL DEFAULT '{}'      -- JSON for forward-compat fields
);
```

**Core fields** (`CORE_FIELDS`): `{activity_id, activity_status, activity, updated_at}`  
**Extra fields** (stored in `_extra` / `extra_json`): `title`, `start_epoch`, `end_epoch`, `duration`, `tags`, `pauses`, `comment`, `media`, `device_uuid`, `end_device_uuid`, `committed`, `block_index`, `one_off`, `has_encrypted_fields`

**Status values:**

| Status | Meaning |
|---|---|
| `active` | Currently tracking (started, not paused, not ended) |
| `paused` | User paused tracking (will resume) |
| `ended` | Completed, ready for ledger commit |
| `staged` | Default for entries that don't fit other states |

**Row-level operations** (all three clients):

| Operation | CLI | Web | Flutter |
|---|---|---|---|
| Get single row | `get_row(activity_id)` | `getRow(activityId)` | `getRow(activityId)` |
| Insert/upsert | `put_row(row)` | `putRow(row)` | `putRow(row, {preserveUpdatedAt})` |
| Delete row | `delete_row(activity_id)` | `deleteRow(activityId)` | `deleteRow(activityId)` |
| Get all rows | `get_all_rows()` | `getAllRows()` | `getAllRows()` |
| Filter by status | `get_rows_by_status(status)` | `getRowsByStatus(status)` | `getRowsByStatus(status)` |
| Count | `count()` | `count()` | `count()` |

### LWW Merge (Last-Write-Wins)

The `updated_at` timestamp is the tiebreaker for cross-device merges:

- On write: `updated_at` is set to `now_ms` (unless `preserveUpdatedAt` is true for merge operations)
- On merge: entries with the same `activity_id` are compared by `updated_at` — the newer one wins
- The `MergeEngine.mergeEntries()` (Flutter/Dart) and `MergeEngine.merge()` (Python CLI) implement this

### Implementation by Client

#### CLI (Python) — `storage/implementations/sqlite_staging.py`

| Aspect | Detail |
|---|---|
| Abstract interface | `storage/staging_store.py` → `AbstractStagingStore` (abstract position-based ops: `read_entries`, `write_entries`, `append_entry`, `remove_entries`, `update_entry`) |
| Row-level impl | `storage/implementations/sqlite_staging.py` → `SqliteStagingStore` |
| Storage engine | SQLite at `~/.local/share/phpoc/staging.db` |
| Schema | `activity_id TEXT PK, activity_status TEXT, activity TEXT, updated_at INTEGER, _extra TEXT DEFAULT '{}'` |
| Row factory | `sqlite3.Row` (column-name access) |
| `_row_to_dict()` | Unpacks `_extra` JSON and merges into result dict (forward-compat) |
| `_normalize_core()` | Fills defaults: `activity_status` → `'staged'`, `activity` → `'{}'`, `updated_at` → now |
| Position-based compat | `read_entries()`, `write_entries()`, `append_entry()` implement `AbstractStagingStore` for legacy callers |
| Context manager | `__enter__` / `__exit__` for `with` statement usage |

#### Web (JS/React) — `phpoc-web/src/sync/row_staging_store.js`

| Aspect | Detail |
|---|---|
| Row-level impl | `phpoc-web/src/sync/row_staging_store.js` → `RowStagingStore` |
| Storage engine | IndexedDB via `StorageBackend` |
| Key format | `staging:row:{activity_id}` (prefix `staging:row:` for list/scan) |
| Forward-compat | Extra fields beyond the 4 core fields are preserved on read-back (no stripping) |
| Transport interface | `pull(path)` serves manifest (`/storage/staging/manifest`) or individual rows; `push(path, body)` stores rows; `delete(path)` removes rows |
| Row format | `{activity_id, activity_status, activity, updated_at}` — all fields persisted as-is |
| `getAllRows()` | Lists all `staging:row:` keys then fetches each → O(n) |
| Legacy path | `phpoc-web/src/sync/local_cache.js` for monolithic `entries` blob (key `'entries'`) |

#### Flutter (Dart) — `phpoc-flutter/lib/data/sync/staging_store.dart`

| Aspect | Detail |
|---|---|
| Row-level impl | `lib/data/sync/staging_store.dart` → `StagingStore` |
| Storage engine | SQLite via `AppDatabase` (shared app DB) |
| Schema | `activity_id TEXT PK, activity_status TEXT, activity TEXT, updated_at INTEGER, extra_json TEXT DEFAULT '{}'` |
| Indexes | `idx_staging_status ON staging(activity_status)`, `idx_staging_updated ON staging(updated_at)` |
| `putRow()` | `INSERT OR REPLACE` with `preserveUpdatedAt` flag for merge operations |
| `_rowToMap()` | Reconstructs full row from core columns + `extra_json` unpack |
| `_mapToRow()` | Extracts core fields, packs everything else into `extra_json` |
| StagingStorage | `lib/data/sync/staging_storage.dart` → KV adapter (`_staging_kv` table) for legacy `LocalCache` compatibility |
| Legacy path | Falls back to `StagingStorage` + `LocalCache` when `stagingStore` is null |

### Encryption at Rest

All three clients apply two layers of encryption to staging data:

#### 1. Structural Field Encryption

| Field | Storage Key | Encryption |
|---|---|---|
| Start time | `startTime_enc` | AES-CTR hex (MK present) or `plain:` prefix (no MK) |
| End time | `endTime_enc` | Same |
| Pauses | `pauses_enc` | Same (JSON array serialized first) |
| Metadata | `metadata_enc` | Same (JSON object serialized first) |
| Device UUID | `device_uuid_enc` | Same |
| End device UUID | `end_device_uuid_enc` | Same |

#### 2. Per-Field Encryption (user-toggled)

| Field | Storage Key | Encrypted When |
|---|---|---|
| Title | `title_enc` | `encrypt_title` flag or `encrypt_all` |
| Tags | `tags_enc` | `encrypt_tags` flag or `encrypt_all` |
| Comment | `comment_enc` | `encrypt_comment` flag or `encrypt_all` |
| Duration | `duration_enc` | `encrypt_duration` flag or `encrypt_all` |

When encrypted: plaintext field is removed, `_enc` variant is stored. Hash is computed from **plaintext** (canonical), independent of encryption nonces.

#### 3. Field-Name Encryption (I-02)

Structural field names are HMAC-tokenized in storage (not plaintext). Uses `HMAC-SHA256(derived_field_key, field_name)` → 16-char hex token. Same user always produces the same tokens.

#### 4. Remote Blob Obfuscation

The staging blob pushed to remote is:
1. Serialized as JSON
2. Padded to nearest tier size (64K, 128K, 256K, or 512K) with random bytes
3. Encrypted with AES-CTR using a derived sub-key: `HMAC-SHA256(MK, "blob-obfuscation")[:16]`
4. Format: `salt(16) + nonce(8) + plaintext_len(4) + padded_data + tag(32)`

### Remote Paths

| Resource | Path |
|---|---|
| Legacy staging blob | `staging/blob` |
| Row-level staging blob | `staging/blobs/row_level.json` |
| Staging hash index | `staging/hash_index.json` |
| Device cookie | `staging/blobs/device_cookie.bin` |

### Hash Index (Tier 1 Fast Path)

A compact manifest for O(1) staging change detection, avoiding full blob pulls:

```json
[{"activity_id": "abc123def0", "activity_status": "active"}, ...]
```

- **Tier 1**: Compare SHA-256 of local vs remote **encrypted** hash index → identical → skip push
- **Tier 2**: Hash indexes differ → pull full blob, reconcile row-by-row
- PHPOC hashes the **encrypted** blob so the worker can compare without decrypting

---

## Cross-Client Equivalence

All three clients share:
- **Same cookie format** — `{device_specifier, creation_time}` local / `{device_uuid, device_specifier}` remote
- **Same cookie TTL** — 30 minutes default
- **Same staging row schema** — `(activity_id PK, activity_status, activity, updated_at, extra)`
- **Same status values** — `active`, `paused`, `ended`, `staged`
- **Same LWW merge logic** — `updated_at` tiebreaker, `MergeEngine` implementation per language
- **Same remote paths** — `staging/blob`, `staging/blobs/device_cookie.bin`, `staging/blobs/row_level.json`
- **Same blob obfuscation** — pad-to-tier + AES-CTR with derived sub-key (verified by cross-platform test vectors)
- **Same encryption layers** — structural `_enc`, per-field `_enc`, field-name tokenization, blob obfuscation

Client-type suffix (`-cli`, `-web`) on device UUID guarantees distinct identities even on the same physical device (Bug 3a fix).
