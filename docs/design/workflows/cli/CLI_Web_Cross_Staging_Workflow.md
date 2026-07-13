# CLI ↔ Web Cross-Staging Workflow

> Operational step-by-step: start a task in CLI, sync to R2, onboard
> web from same R2, see the active task, stop it in web, verify CLI
> sees it stopped. Underlying architecture: [Cross_Device_Staging-Workflow.md](../Cross_Device_Staging-Workflow.md).

## Test Worker Credentials

> **For cross-device staging integration tests, use the dedicated test Worker.**
> This Worker is separate from production and safe for automated testing.

| Field | Value |
|---|---|
| **Worker URL** | `https://phpoc-staging-testing.wacevedo.workers.dev` |
| **API Token** | See `TEST_CREDENTIALS.md` (gitignored) |
| **Header** | `X-Api-Key` |

> **⚠️ Never use real ledger data with the test Worker.** Always use test-specific passphrases and seeds.
> See `TEST_CREDENTIALS.md` for current test ledger credentials.

These credentials are used by:
- `tests/test_cross_platform_integration.py` — Python live integration tests
- `worker/test/index.test.ts` — Worker endpoint unit tests (vitest)
- Manual smoke tests of the cross-staging workflow

**⚠️ Never use real ledger data with the test Worker.** Always use test-specific passphrases and seeds.

## Preconditions

| # | Check | How to verify |
|---|---|---|
| P1 | CLI has `ph` installed and configured | `ph view` returns (empty or list) |
| P2 | CLI remote transport configured | `ph transport status` shows Worker URL |
| P3 | CLI can reach R2 Worker | `ph sync` completes without OFFLINE |
| P4 | Web app (`phpoc-web`) running | Dev server on `localhost:5173` or production |
| P5 | Worker URL and API key available | Same values configured in CLI `~/.config/phpoc/config.json` |
| P6 | Recovery seed known | Shown during `ph init`, stored securely |

---

## Workflow: Full Cycle (CLI → Web → CLI)

### Step 1 — CLI: Confirm data is synced to R2

```bash
# Push all local data to remote
ph sync
```

**Verify:**

```bash
# Check that ledger blocks were pushed
curl -s -H "X-Api-Key: $API_KEY" \
  "$WORKER_URL/ledger/blocks/000000.json" | wc -c
# Output must be > 0

# Check that staging blob was pushed
curl -s -H "X-Api-Key: $API_KEY" \
  "$WORKER_URL/staging/blobs/current.json" | wc -c
# Output must be > 0

# Check that hash index was pushed
curl -s -H "X-Api-Key: $API_KEY" \
  "$WORKER_URL/ledger/hash_index.sha256" | wc -c
# Output should be 64 (hex SHA-256)
```

**Diagnostic checkpoints:**

- CLI `check_and_sync()` returns `READY`
- `RemoteLedgerSync.push_hash_index()` completed
- `RemoteLedgerSync.push_all_blocks()` completed
- `RemoteStagingSync.push_blob()` completed
- `RemoteStagingSync.push_cookie()` completed

---

### Step 2 — CLI: Start a task

```bash
ph add start "Working on phpoc"
```

**Verify:**

```bash
ph view
# Must show: ▶ Working on phpoc  (running)
```

The task appears in staging immediately. It is NOT yet committed to
the ledger — it lives in `~/.local/share/phpoc/staging.json` as an
active entry with `is_active: true` and `startTime_enc`.

**Diagnostic checkpoints:**

- `StagingService.add_start()` called → entry created with UUID `entry_id`
- `is_active: true`, `startTime_enc` set, `endTime_enc: null`
- Entry hash computed and stored

---

### Step 3 — CLI: Sync staging to R2

```bash
ph sync
```

This pushes the active task as part of the staging blob to
`staging/blobs/current.json` on the R2 Worker.

**Verify:**

```bash
# Pull staging blob and check for the task
curl -s -H "X-Api-Key: $API_KEY" \
  "$WORKER_URL/staging/blobs/current.json" | wc -c
# Should be larger than before (now includes the active task)
```

**Diagnostic checkpoints:**

- `RemoteStagingSync.push_blob_only()` sends obfuscated blob
- Blob size increased → task serialized inside `entries[]`
- Cookie pushed after blob → specifier unchanged

---

### Step 4 — Web: Onboard from R2

1. Open http://localhost:5173 (or production URL)
2. Click **📥 Import a ledger**
3. Click **☁️ From Cloud**
4. Enter Worker URL and API key
5. Click **List Backups**
6. App detects remote ledger chain → shows "Remote ledger found (N blocks)"
7. Enter **Passphrase** and **Recovery Seed**
8. Click **Import Backup**

**Expected:** Onboarding completes, dashboard shows with the imported
ledger. The active task "Working on phpoc" should appear under
"Active Tasks" in the web dashboard.

**If onboarding fails with genesis mismatch:**
The web app has an existing ledger with a different genesis. Click
**✨ Begin a new ledger** first to reset, then retry the cloud import.

**Diagnostic checkpoints:**

- `WorkerImportSource.checkForRemoteChain()` returns block count > 0
- `WorkerImportSource.fetchChain()` deobfuscates all blocks
- `WorkerImportSource._validateRawChain()` passes seal + hash validation
- `storage.set('ledger:blocks', chain)` writes to IndexedDB
- `bootstrapServices()` → `checkAndSync()` → genesis gate passes (same genesis)
- `_reconcileAndClaim()` enters Case B (cross-device merge)
- `mergeEntries(local_entries, remote_entries)` merges CLI's active task
- Active task visible in web UI → `entries.filter(e => e.data.is_active)`

---

### Step 5 — Web: Confirm active task is visible

Reload the dashboard if needed. The active task started in CLI
should now appear in the web client under "Active Tasks":

```
▶ Working on phpoc     [running since <timestamp>]
```

**What happened under the hood:**

1. Web's `checkAndSync()` detected cookie/specifier mismatch
2. User authenticated with passphrase + seed → master key derived
3. `_reconcileAndClaim()` pulled remote staging blob from R2
4. Deobfuscated blob → found CLI's active entry
5. `mergeEntries()` merged remote entries with local (empty) entries
6. Active task displayed in UI

**Diagnostic checkpoints:**

- `SyncService.checkAndSync()` → Case B path (cross-device)
- `RemoteSync.pullBlob(mk)` → deobfuscated successfully
- Entry with title "Working on phpoc" has `is_active: true`
- UI renders active entry from `useEntries()` hook or local cache

---

### Step 6 — Web: Stop the active task

Click the **Stop** button on "Working on phpoc" in the web UI.
Confirm the stop action.

**Expected:** Task moves from "Active Tasks" to "Recent Tasks" or
"Stopped" state.

**Diagnostic checkpoints:**

- `StagingService.add_end()` or equivalent web handler sets `endTime_enc`
- `is_active: false` on the entry
- Entry written to IndexedDB via `writeEntries()`

---

### Step 7 — Web: Sync staging to R2

Click **Sync Now** in the web UI (Settings → Sync, or dashboard
sync button).

This pushes the updated staging blob (with stopped task) back to R2.

**Diagnostic checkpoints:**

- `RemoteSync.pushBlobOnly(mk)` pushes updated blob
- `RemoteSync.pushCookie()` updates remote cookie
- Blob on R2 now has entry with `is_active: false` and `endTime_enc` set
- `end_device_uuid` recorded → provenance of which device stopped it

---

### Step 8 — CLI: Pull changes from R2

```bash
ph sync
```

**Expected:** CLI pulls the updated staging blob. The task that was
started in CLI and stopped in web now shows as stopped.

```bash
ph view
# Must show: (empty — no active tasks)
# OR the task is no longer listed under active

ph list all 7
# Must show: (stopped) Working on phpoc  <duration>
```

**What happened under the hood:**

1. CLI's `check_and_sync()` detects cookie/specifier mismatch
   (web updated it in Step 7)
2. `_reconcileAndClaim()` pulls remote staging blob
3. Remote blob has entry with `is_active: false`, `endTime_enc` set,
   `end_device_uuid` set to web's device UUID
4. `mergeEntries()` merges → web's stopped version wins (remote-wins rule)
5. Local staging updated → task no longer active
6. `ph view` returns empty (no active tasks)

**Diagnostic checkpoints:**

- `DeviceCookie.matches()` returns False → Case B path
- `RemoteStagingSync.pull_blob(mk)` deobfuscates successfully
- `mergeEntries()` → remote entry overwrites local (remote-wins)
- Entry `is_active` transitions from `true` to `false`
- `end_device_uuid` shows web's device UUID
- `ph view` shows zero active tasks

---

## Verification Summary

| Step | Action | Expected result | Verify with |
|---|---|---|---|
| 1 | `ph sync` | Ledger + staging pushed to R2 | `curl` ledger/blocks/ and staging/blobs/ |
| 2 | `ph add start "Working on phpoc"` | Active task in CLI | `ph view` shows ▶ |
| 3 | `ph sync` | Active task pushed to R2 | Staging blob size increased |
| 4 | Web cloud import | Onboarding succeeds | Dashboard loads, no genesis mismatch |
| 5 | Web dashboard | Active task visible | "Working on phpoc" shows as running |
| 6 | Web stop task | Task stops | Moves from active to stopped |
| 7 | Web Sync Now | Stopped task pushed to R2 | Sync succeeds, no errors |
| 8 | CLI `ph sync` + `ph view` | Task shows as stopped in CLI | `ph view` empty, `ph list all` shows stopped |

## Affected Modules

| Step | CLI Module | Web Module | R2 Path |
|---|---|---|---|
| 1 | `domain/ledger/remote_sync.py`, `domain/staging/remote_sync.py` | — | `ledger/blocks/*`, `staging/blobs/current.json`, `ledger/hash_index.*` |
| 2 | `domain/staging/service.py` → `add_start()` | — | — |
| 3 | `domain/staging/remote_sync.py` → `push_blob()` | — | `staging/blobs/current.json` |
| 4 | — | `sync/remote_import.js`, `context/DevModeContext.jsx` | `ledger/blocks/*`, `staging/blobs/current.json` |
| 5 | — | `sync/sync.js` → `checkAndSync()`, `sync/merge_engine.js` | `staging/blobs/current.json` |
| 6 | — | `sync/sync.js` → `_endEntry()` or equivalent | — |
| 7 | — | `sync/remote_sync.js` → `pushBlobOnly()` | `staging/blobs/current.json`, `staging/blobs/device_cookie.bin` |
| 8 | `domain/staging/service.py` → `check_and_sync()` | — | `staging/blobs/current.json`, `staging/blobs/device_cookie.bin` |

## Key Invariants for This Workflow

1. **Genesis must match** — CLI and web must share the same genesis block.
   If web has a different genesis, it must be cleared before onboarding.

2. **Cookie push order** — Staging blob pushed before cookie. Never reversed.

3. **Remote wins on merge** — When CLI and web both modify staging, the
   last writer wins. The web's stopped version overwrites CLI's active
   version if web pushes after stopping.

4. **Seed is required** — Cloud onboarding requires the recovery seed.
   Passphrase-only auth (PDK → decrypt seed from genesis) only works
   with backup file imports, not chain imports.

5. **Active tasks in staging only** — Tasks started with `ph add start` live
   in staging until committed (`ph sync`). The web client reads staging
   entries, not committed ledger entries.

## Known Gaps

1. **Concurrent writes race** — If CLI and web both modify staging
   without syncing between, last writer wins. No conflict detection.

2. **Active task commit timing** — An active task visible in web was
   synced as staging, not as a committed ledger block. If the user
   does `ph sync` in CLI after step 3, the task may get committed
   into a day block. The web would then need to pull the updated
   ledger chain too.

3. **No auto-sync on web** — After onboarding, the web app does not
   automatically pull the staging blob. The user must click "Sync Now"
   or wait for auto-sync to trigger. Ensure Sync Now is clicked.

4. **Seed requirement for chain import** — The cloud import from
   `ledger/blocks/` requires the recovery seed (passphrase+seed auth).
   Passphrase-only auth (PDK-based) is only available for backup
   file imports. See `WorkerImportSource.fetchAndValidate()`.

## Test Coverage

| Test Suite | Scope | Status |
|---|---|---|
| `tests/test_staging_sync_optimization.py` (85 tests) | CLI: fast path, cookie TTL, Case A/B, cross-device round-trip | ✅ |
| `phpoc-web/test/cross_client_web_test.mjs` (78 tests) | Web: auth gate, merge, round-trip, pause/unpause lifecycle | ✅ |
| `phpoc-web/test/sync_service_test.mjs` (246 tests) | Web: full SyncService, genesis gate, merge, cookie | ✅ |
| `tests/test_cross_platform_integration.py` | CLI ↔ Worker ↔ CLI live integration (blob, cookie, ledger, full cycle) | 🔜 |
| `worker/test/index.test.ts` | Worker HTTP endpoints (auth, CORS, GET/PUT/DELETE, list, errors) | 🔜 |
| `tests/test_cross_platform_crypto.py` | Python ↔ WASM obfuscation compatibility | 🔜 |
