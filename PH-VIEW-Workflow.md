# `ph view` — Auth Gate Workflow

## Purpose

Trace the full execution path of `ph view` from CLI invocation to displaying
active tasks on screen, with emphasis on the auth gate (`check_and_sync()`).

---

## Step 1 — CLI Parsing (`main.py`)

```
ph view
  -> argparse matches "view" command
  -> "view" is in require_auth list
  -> auth.authenticate()
      |-- session cache exists  -> read master_key from /dev/shm/phpoc_session
      |-- no session cache      -> prompt for passphrase -> PBKDF2 -> decrypt recovery seed -> cache key
      '-- no key                -> print "Passphrase required" -> exit(1)
  -> CryptoManager(master_key) created
  -> StagingService(crypto, staging_store, transport, device_id_provider,
                   cookie_ttl_minutes=30, data_dir=CONFIG_DIR) created
  -> CLIInterface(staging_service, ledger_engine, crypto) created
  -> cli.view_active() called
```

---

## Step 2 — `CLIInterface.view_active()`

```
view_active()
  |-- 1. _sync_before_command(require_auth=False)
  |       -> see Step 3
  |       '-- returns False -> return (no data shown, message already printed)
  |       '-- returns True  -> continue
  |
  |-- 2. _show_sync_notifications()     # Phase A background check results
  |
  |-- 3. _local._store.read_entries()   # Read local staging, decrypted
  |     '-- filter is_active == True
  |
  |-- 4. _spawn_background_sync_check() # Non-blocking, fires AND forgets
  |       Notifies user on NEXT command if remote has changes
  |
  '-- 5. Print active tasks with:
        . ID, start time, title
        . Active duration (wall time - paused intervals)
        . Pause indicator if is_paused
        . Tags (if --show-tags), comments (if --show-comments)
```

---

## Step 3 — `_sync_before_command(require_auth=False)`

```
_sync_before_command(require_auth=False)
  |-- self._staging._remote is None -> return True  # No remote configured
  |
  '-- result = self._staging.check_and_sync(timeout_ms=500)
        |
        |-- result == READY    -> return True
        |-- result == OFFLINE  -> return True   (proceed with local data)
        '-- result == REAUTH_NEEDED
              |-- require_auth=False  -> print "Remote staging is held by..."
              |                         print "Please re-authenticate..."
              |                         return False
              '-- require_auth=True   -> return False  (caller prints auth msg)
```

---

## Step 4 — `StagingService.check_and_sync()` (the auth gate)

```
check_and_sync(timeout_ms=500) -> SyncCheckResult

+------------------------------------------------------------------+
| A) REMOTE EXISTENCE CHECK                                         |
|                                                                   |
|    self._remote is None?                                          |
|    '-- Yes -> return READY                                        |
+------------------------------------------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
| B) LOCAL COOKIE CHECK                                             |
|                                                                   |
|    DeviceCookie.is_valid_locally(data_dir, ttl_minutes)            |
|    Reads: ~/.local/share/phpoc/device_cookie.meta                 |
|    JSON: {"device_specifier": <str>, "creation_time": <epoch_ms>} |
|                                                                   |
|    |-- File missing        -> return None  -> fall through        |
|    |-- TTL expired         -> destroy file, return None -> fall   |
|    '-- Valid cookie dict   -> continue to remote check            |
+------------------------------------------------------------------+
                                 | (local_cookie is not None)
                                 v
+------------------------------------------------------------------+
| C) REMOTE COOKIE CHECK (fast path, one tiny HTTP GET ~50ms)       |
|                                                                   |
|    self._remote.pull_cookie()                                      |
|    -> GET staging/blobs/device_cookie.bin from Cloudflare Worker   |
|    -> R2 returns JSON bytes:                                       |
|       {"device_uuid": <str>, "device_specifier": <str>}           |
|                                                                   |
|    |-- Exception (network error) -> return OFFLINE                 |
|    |                                                                 |
|    |-- Response is None (no remote cookie) -> fall through         |
|    |   specifier_mismatch = False                                   |
|    |                                                                 |
|    '-- Parse remote cookie -> compare device_specifier              |
|        |-- MATCH -> return READY  (same device session, done)     |
|        '-- MISMATCH -> specifier_mismatch = True -> fall through  |
+------------------------------------------------------------------+
                                 | (no fast path match)
                                 v
+------------------------------------------------------------------+
| D) AUTH GATE — specifier mismatch?                                 |
|                                                                   |
|    specifier_mismatch == True?                                     |
|    '-- YES -> return REAUTH_NEEDED  (unconditional)               |
|         User must explicitly authenticate to consent to           |
|         cross-device merging. A cached CryptoManager is NOT       |
|         sufficient — caller must prompt for passphrase.           |
|                                                                   |
|    (Only non-mismatch cases continue: no local cookie,            |
|     TTL expired, or no remote cookie.)                            |
+------------------------------------------------------------------+
                                 | (specifier_mismatch == False)
                                 v
+------------------------------------------------------------------+
| E) AUTH GATE — CRYPTO VALIDATION                                  |
|                                                                   |
|    mk = self._crypto.master_key                                    |
|    isinstance(mk, bytes) AND len(mk) == 32?                       |
|    '-- No -> return REAUTH_NEEDED                                  |
+------------------------------------------------------------------+
                                 | (master_key valid)
                                 v
+------------------------------------------------------------------+
| F) PULL REMOTE COOKIE (for device_uuid)                           |
|                                                                   |
|    self._remote.pull_cookie()                                      |
|    |-- Exception -> return OFFLINE                                 |
|    |-- None -> remote_device_uuid = ""                             |
|    '-- Parsed -> remote_device_uuid = cookie["device_uuid"]        |
|                                                                   |
|    local_device_uuid = self._get_device_id() or ""                 |
+------------------------------------------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
| G) DEVICE IDENTITY COMPARISON                                     |
|                                                                   |
|    remote_device_uuid == local_device_uuid?                        |
|                                                                   |
|    +-- YES (same device, cookie just expired)                    |
|    |   -> self.push_blob_only(master_key=mk)                       |
|    |   -> Push local staging blob to R2 (no cookie push)           |
|    |   -> NO blob pull needed (local = authoritative)              |
|    |                                                                 |
|    '-- NO / "" (different device or first time)                  |
|        -> self._remote.pull(master_key=mk)                         |
|        |  -> HTTP GET staging/blobs/current.json from Worker      |
|        |  -> Decrypt with blob sub-key derived from master_key    |
|        |  |-- Exception -> return OFFLINE                          |
|        |  '-- Got blob with "entries" ->                           |
|        |      MergeEngine.merge(local_entries, remote_entries)    |
|        |      |-- Exception -> push local as-is (pass)            |
|        |      '-- OK -> write_entries(merged)                     |
|        |                                                          |
|        -> self.push_blob_only(master_key=mk)                       |
|        -> Push (merged) blob to remote                             |
+------------------------------------------------------------------+
                                 |
                                 v
+------------------------------------------------------------------+
| H) CREATE NEW DEVICE COOKIE                                       |
|                                                                   |
|    1. DeviceCookie.create(device_id, data_dir)                    |
|       -> Generate new random 16-byte (32 hex) specifier            |
|       -> Write local cookie:                                       |
|         device_cookie.meta: {"device_specifier": <new>,            |
|                               "creation_time": now_ms}             |
|       -> Write cache file:                                         |
|         device_cookie.bin: {"device_specifier": <new>,             |
|                              "device_uuid": device_id}              |
|       -> Returns remote cookie dict                                |
|                                                                   |
|    2. self._remote.push_cookie(json_bytes)                        |
|       -> PUT staging/blobs/device_cookie.bin to R2                |
|       -> Overwrites old cookie atomically (no destroy-then-       |
|         create race)                                              |
|                                                                   |
|    |-- Exception -> pass (non-critical, next call retries)        |
|    '-- OK -> cookie pushed                                        |
|                                                                   |
|    return READY                                                    |
+------------------------------------------------------------------+
```

---

## Step 5 — Display

```
view_active() reached after _sync_before_command() returned True
  |-- _show_sync_notifications()          # any Phase A notifications
  |-- Read local staging entries (decrypted)
  |-- Filter: entries where is_active == True
  |-- _spawn_background_sync_check()      # non-blocking, next command
  '-- Print "--- Running Tasks ---"
        |-- "No active tasks." if empty
        '-- For each active entry:
              #1 [09:15] Working on PHPOC  (active: 45m)  [@dev, @php]
              #2 [10:00] Meeting             (paused at 10:30, active: 30m)
```

---

## Return Values Summary

| check_and_sync() returns | _sync_before_command action | view_active() behaviour |
|---|---|---|
| READY    | return True     | Shows data |
| OFFLINE  | return True     | Shows data (local only, remote unreachable) |
| REAUTH_NEEDED | print message; return False | Returns early, no data shown |

## Key Invariant

**A specifier mismatch (step C -> MISMATCH) ALWAYS returns REAUTH_NEEDED,**
**regardless of whether a CryptoManager is cached.** This forces the user
to explicitly authenticate via `ph login` (which clears the local cookie)
before `ph view` can proceed. Without this invariant, a warm session cache
silently bypasses the cross-device auth gate — the bug that was just fixed.

---

## Data Flow Diagram (files)

```
~/.local/share/phpoc/
|-- device_cookie.meta        JSON  <- Read/write by DeviceCookie
|   {"device_specifier": "ab12...", "creation_time": 1779818198254}
|
|-- device_cookie.bin         JSON  <- Written by create(), pushed to remote
|   {"device_specifier": "ab12...", "device_uuid": "bbb3badc-..."}
|
'-- staging.json              Encrypted JSON <- Read by FileStagingStore
    [{"data": {"title_enc": "...", ...}}, ...]

R2 (Cloudflare Worker):
  staging/blobs/
    |-- device_cookie.bin     JSON  <- GET/PUT via pull_cookie/push_cookie
    '-- current.json          Obfuscated bytes <- GET/PUT via pull/push
```

---

## Key Files Referenced

| File | Role |
|------|------|
| main.py | CLI parsing, initial auth, wiring |
| cli/interface.py | _sync_before_command(), view_active() |
| domain/staging/service.py | check_and_sync() — the auth gate |
| domain/cookie/device_cookie.py | Cookie read/write/compare |
| domain/staging/remote_sync.py | Blob obfuscation, transport pull/push |
| core/sync/http_transport.py | HTTP transport -> Cloudflare Worker |
| domain/staging/merge_engine.py | Entry dedup by entry_id |
| domain/staging/local_cache.py | Local staging CRUD |
