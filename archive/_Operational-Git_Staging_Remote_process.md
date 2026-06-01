# Git Staging Sync — Complete Data Flow & Architecture

## High-Level Architecture

```
User (CLI)
   │
   ▼
CLIInterface (cli/interface.py)
   │  adds tags/comment, calls staging methods, then _push_if_remote()
   ▼
StagingService (domain/staging/service.py)
   │  facade: orchestrates local + remote
   ├──▶ LocalStagingCache (domain/staging/local_cache.py)
   │      │  reads/writes staging.json, handles plain: prefix convention
   │      └──▶ FileStagingStore (storage layer)
   │
   ├──▶ RemoteStagingSync (domain/staging/remote_sync.py)
   │      │  blob obfuscation (pad + encrypt), device identity
   │      └──▶ GitStagingTransport (core/sync/git_transport.py)
   │             │  git CLI: clone, pull, add, commit, push
   │             └──▶ Remote git repo (GitHub)
   │
   └──▶ MergeEngine (domain/staging/merge_engine.py)
             dedup by (title, start_epoch), remote wins on tie
```

---

## Key Files & Their Roles

| File | Purpose |
|------|---------|
| `core/sync/transport.py` | `AbstractStagingTransport` — 2-method interface: `pull(path) -> bytes`, `push(path, data)` |
| `core/sync/git_transport.py` | `GitStagingTransport` — git CLI implementation of transport |
| `domain/staging/remote_sync.py` | `RemoteStagingSync` — blob obfuscation, device check, pull/push orchestration |
| `domain/staging/service.py` | `StagingService` — facade, calls `check_and_sync()` before each op, `push_to_remote()` |
| `domain/staging/local_cache.py` | `LocalStagingCache` — staging.json CRUD, `plain:` prefix convention, encrypt/decrypt |
| `domain/staging/merge_engine.py` | `MergeEngine` — dedup by (title, start_epoch), remote wins on ties |
| `cli/interface.py` | `CLIInterface` — CLI commands, `_push_if_remote()` after mutations, `view_active()` pulls+merges |
| `main.py` | Wiring: reads config, creates `GitStagingTransport` + `RandomUUIDDeviceIdentityProvider` |

---

## Data Files

| File | Purpose | Format |
|------|---------|--------|
| `~/.local/share/phpoc/staging.json` | Local staging entries | JSON with `plain:` prefix on encrypted fields |
| `~/.local/share/phpoc/remote/` | Git clone of remote repo | Working copy, blob at `staging/blobs/current.json` |
| Remote repo (GitHub) | Staging blob pushed/pulled | Obfuscated bytes (or plain JSON if no key) |

---

## Detailed Data Flow for Each Operation

### 1. `ph add start "My Task"`

```
main.py:
  - parses args → sees "add start"
  - auth check: "add" IS in require_auth → prompts for passphrase
  - creates CryptoManager with master_key from passphrase
  - creates StagingService(crypto, staging_store, transport, device_id_provider)
  - calls cli.add_start("My Task")

CLIInterface.add_start(title):
  1. calls staging_service.capture(title, now_ms, is_active=True, tags=tags, comment=comment)
  2. then calls _push_if_remote()

StagingService.capture():
  1. calls check_and_sync(timeout_ms=500) ← event-driven remote check BEFORE local op
  2. then calls local.append(...) — writes to staging.json
```

### 2. `check_and_sync()` — The Event-Driven Remote Pre-Check

This runs *before every* staging operation (`capture`, `end`, `pause`, `unpause`, `modify`, `remove`).

```
check_and_sync(timeout_ms=500):

  Step 1: Is remote configured?
    if self._remote is None → return READY (no remote to worry about)

  Step 2: Is remote reachable?
    self._remote.check_remote_available(timeout_ms)
      → calls transport.pull(path) with a 500ms wall-clock timeout check
      → if elapsed > 500ms → return OFFLINE
      → if exception → return OFFLINE

  Step 3: Device match check
    self._remote.check_device()
      → pull() the remote blob, parse the JSON (deobfuscating if needed)
      → compare blob["device_id"] with local device_id
      → if mismatch AND auth cache expired (30 min) → return REAUTH_NEEDED

  Step 4: Pull + Merge (if remote is available)
    remote_blob = self._remote.pull()
      → transport.pull("staging/blobs/current.json")

    if remote_blob has entries:
      1. Convert remote raw entries → DTOs via _raw_to_dtos()
         (raw entries have {hash, data, start_epoch} — DTOs have title, start_epoch, end_epoch, pauses...)
      2. local_entries = self._local.read_entries()
      3. merged = MergeEngine.merge(local_entries, remote_dtos)
         → key = (title, start_epoch) dedup
         → remote wins on tie (same key in both)
         → sorted by start_epoch ascending
      4. self._local.write_entries(merged) — overwrite local staging.json

    return READY
```

### 3. `_push_if_remote()` — Push After Every Mutating Command

```
CLIInterface._push_if_remote():
  1. Is remote configured? (self._staging._remote is not None)
  2. Do we have a 32-byte master_key?
     → If not: print warning "authenticate first" and SKIP
     → Would leak plaintext JSON to remote repo!
  3. Call staging_service.push_to_remote(master_key=mk)

StagingService.push_to_remote(master_key):
  1. Read raw entries from staging store (local staging.json)
  2. Get device identity (device_id + proof)
  3. Call self._remote.push(raw_entries, device_id, master_key)

RemoteStagingSync.push(entries, device_id, master_key):
  1. Build blob dict:
     { "device_id": device_id,
       "device_proof": "",
       "entries": [...],
       "updated_at": now_ms }
  2. Serialize to JSON bytes
  3. If master_key is available (32 bytes):
     → Select tier (64K/128K/256K/512K) based on blob size
     → Pad to tier ceiling with random bytes
     → Prepend original length (4 bytes big-endian)
     → Derive blob key: HMAC-SHA256(MK, "blob-obfuscation")[:16]
     → Derive enc_key: HMAC-SHA256(blob_key, salt)[:16]
     → AES-CTR encrypt (salt[16] + nonce[8] + ciphertext)
     → Append HMAC integrity tag[32] using integrity_key
  4. Call transport.push("staging/blobs/current.json", obfuscated_bytes)

GitStagingTransport.push(path, data):
  1. Ensure clone exists (git clone if first time)
  2. Ensure remote URL matches config
  3. Recover from stuck rebase (git rebase --abort)
  4. Check if remote has refs (ls-remote)
  5. If yes: git pull --rebase --autostash
  6. Write blob bytes to file
  7. git add, git commit -m "Update staging blob [...]"
  8. git push
  9. If rejected (non-fast-forward):
     - git pull --rebase --autostash
     - re-write blob, add, commit (or --allow-empty)
     - git push (retry once)
     - If still fails: raise RuntimeError
```

### 4. `view_active()` — Pull + Merge Before Display

```
CLIInterface.view_active():
  1. If remote is configured:
     - Get master_key from crypto
     - remote_blob = self._staging._remote.pull(master_key=mk)
       → transport.pull("staging/blobs/current.json")
       → deobfuscate if needed (backward-compat: try plaintext JSON first)
     - If blob has entries:
       local + remote → merged via MergeEngine
       local staging.json ← merged result
  2. Read all entries from staging.json
  3. Filter active entries (is_active=True)
  4. Display with IDs, timestamps, pause state, duration
```

---

## Blob Obfuscation Flow

### Encryption (on push)

```
plaintext JSON
  → select tier: 64K / 128K / 256K / 512K (whichever fits plaintext)
  → pad plaintext to (tier - 4) bytes with random bytes
  → prepend original length (4 bytes, big-endian)
  → salt = 16 random bytes
  → nonce = 8 random bytes
  → blob_key = HMAC-SHA256(MK, "blob-obfuscation")[:16]
  → enc_key = HMAC-SHA256(blob_key, salt)[:16]
  → ciphertext = AES-CTR(padded_data, nonce, enc_key)
  → integrity_key = HMAC-SHA256(blob_key, salt + b"-integrity")[:16]
  → tag = HMAC-SHA256(integrity_key, nonce + ciphertext)
  → output = salt[16] + nonce[8] + ciphertext[N] + tag[32]
```

### Decryption (on pull)

```
obfuscated bytes
  → extract salt[16] + nonce[8] + ciphertext + tag[32]
  → integrity_key = HMAC-SHA256(blob_key, salt + b"-integrity")[:16]
  → verify tag (constant-time compare)
  → enc_key = HMAC-SHA256(blob_key, salt)[:16]
  → plaintext = AES-CTR(ciphertext, nonce, enc_key)
  → read original_len from first 4 bytes (big-endian u32)
  → extract plaintext[4 : 4+original_len]
  → parse JSON

Backward compatibility: tries plaintext JSON parsing FIRST.
  If that fails, falls through to deobfuscation.
```

---

## Git Transport Lifecycle

```
First usage:
  1. _ensure_clone() → git clone <remote_url> <clone_path>
     - If remote is empty: git init + git remote add origin
     - If clone fails (auth/network): raises RuntimeError

Subsequent usage (pull):
  1. _ensure_clone() → already exists, skip
  2. _ensure_remote_url() → update origin URL if config changed
  3. _recover_git_abort_stuck_rebase() → clean up crashed rebases
  4. _has_remote_refs() → git ls-remote origin --heads
  5. If remote has refs: git pull --rebase --autostash
  6. Read blob file from clone_path

Subsequent usage (push):
  1-5 same as pull
  6. Write blob bytes to file
  7. git add, git commit -m "Update staging blob [...]"
  8. git push

Push conflict recovery (non-fast-forward):
  1. git pull --rebase --autostash
  2. Re-write blob file (rebase may have overwritten it)
  3. git add, git commit (--allow-empty if content unchanged)
  4. git push (retry once)
  5. If still fails: raise RuntimeError
```

---

## Merge Engine Rules

```
MergeEngine.merge(local_entries, remote_entries):
  for each entry in local_entries:
    key = (title, start_epoch)
    seen[key] = entry (marked source="local")

  for each entry in remote_entries:
    key = (title, start_epoch)
    seen[key] = entry (marked source="remote")  ← remote overwrites local on tie

  return sorted(seen.values(), by start_epoch ascending)
```

Key insight: Since real-world tasks don't start at the same millisecond on two different devices, entries are normally additive and non-conflicting. When they do collide (same `title` at the same `start_epoch`), remote wins — it represents the more recent state.

---

## Auth & Master Key Dependencies

```
require_auth = ["sync", "verify", "rep", "list", "view", "tags", "modify", "review", "add"]

If command in require_auth:
  → Must authenticate (passphrase prompt)
  → CryptoManager with real master_key (32 bytes)
  → _push_if_remote() can push with obfuscation

If command NOT in require_auth AND no cached session:
  → NoAuthCryptoManager (no master_key)
  → _push_if_remote() prints warning and SKIPS push
  → Entries written with plain: prefix (no encryption)
```

---

## Known Design Notes & Potential Issues

1. **Single blob file**: The entire staging state is one JSON blob pushed/pulled atomically. Any conflict triggers a full-staging merge.

2. **`_raw_to_dtos()` creates a temp in-memory `LocalStagingCache`**: Every `check_and_sync()` call creates a temporary store, writes raw entries into it via `write_entries()`, then immediately reads them back through `read_entries()` to decrypt fields. This is a roundabout decoding path.

3. **`check_remote_available()` does a real pull**: The reachability check isn't a ping — it calls `transport.pull()` which does `git pull --rebase --autostash` before reading the file. Even the "quick check" can do significant I/O.

4. **No push after `view_active()` merge**: `view_active()` pulls remote entries and merges them into local staging, but doesn't push back. The next mutating command's `_push_if_remote()` will push the merged state.

5. **Race condition**: Between `check_and_sync()` pull and `_push_if_remote()` push, another device could push. The push retry handles this with `pull --rebase` + retry.

6. **`ph sync remote` is the only explicit pull-then-push**: The normal event-driven flow (add/start/end) does `check_and_sync()` before the op and `_push_if_remote()` after, but these are separate calls without transaction semantics.
