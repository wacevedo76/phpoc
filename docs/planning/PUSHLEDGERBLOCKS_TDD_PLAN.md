# pushLedgerBlocks() — TDD Test Plan

> **Status:** 🟢 GREEN phase — 76 assertions, 0 failures. `pushLedgerBlocks()` implemented on `SyncService`.
> **Created:** 2026-06-22
> **Module:** `phpoc-web/src/sync/sync.js` — method on `SyncService`
> **Test file:** `phpoc-web/test/ledger_sync_test.mjs`
> **Reference:** Python `RemoteLedgerSync.push_blocks()` in `domain/ledger/remote_sync.py`

## Problem

`SyncService.pushToRemote()` pushes only staging blobs (`staging/blobs/current.json`) + device cookie. Committed ledger blocks remain local-only, never pushed to R2. This is the missing piece for full multi-device ledger sync.

## Remote Layout

```
ledger/blocks/000000.json   ← genesis, obfuscated (individual file per block)
ledger/blocks/000001.json   ← day block
ledger/blocks/000002.json
...
ledger/index.json           ← lightweight index summary (also obfuscated)
```

Worker is a generic HTTP-to-R2 proxy — GET/PUT/DELETE/LIST by key. No phpoc awareness.

## Function Contract

```js
/**
 * Push local ledger blocks to remote that don't exist there yet.
 *
 * Lists remote indices via transport.listFiles('ledger/blocks/'),
 * then pushes only blocks whose index is not already on remote.
 * Blocks are JSON-serialized then obfuscated via crypto.obfuscateBlob().
 * Index is pushed after blocks.
 *
 * Skipped when: no transport, no master key, or no local blocks.
 * Errors are logged but never thrown — push is best-effort.
 *
 * @returns {Promise<number>} Number of blocks pushed (0 = nothing to do or error).
 */
async pushLedgerBlocks()
```

---

## Test Categories

### Category A — Basic Push (happy path) — 5 tests

| # | Test | What it verifies |
|---|------|-----------------|
| A1 | Empty remote, 3 local blocks → push all 3 | `listFiles` returns `[]`, all blocks pushed with correct filenames `000000.json`, `000001.json`, `000002.json` |
| A2 | Remote has blocks 0-2, local has blocks 0-4 → push blocks 3-4 only | Skips existing indices, pushes only new ones; return value = 2 |
| A3 | Single genesis block push | One block → filename `000000.json`, obfuscated; return value = 1 |
| A4 | Push returns count of blocks pushed | Return value = 3 for full push, 2 for partial |
| A5 | Push order is sequential by index | Blocks pushed in ascending index order (000000 → 000001 → 000002) |

### Category B — No-Op / Skip Cases — 4 tests

| # | Test | What it verifies |
|---|------|-----------------|
| B1 | No master key → skip, return 0 | `crypto.getMasterKey()` returns null → no transport calls made |
| B2 | No transport → skip, return 0 | `isRemoteAvailable` is false → no work done |
| B3 | Empty blocks array → skip, return 0 | `storage.get('ledger:blocks')` returns `[]` → no remote calls |
| B4 | All blocks already on remote → skip, return 0 | `listFiles` reveals indices {0,1,2} = local indices → no pushes |

### Category C — Obfuscation Correctness — 4 tests

| # | Test | What it verifies |
|---|------|-----------------|
| C1 | Pushed bytes are NOT plaintext JSON | Transport receives obfuscated bytes, not raw JSON string |
| C2 | Pushed block can be de-obfuscated and parsed | `crypto.deobfuscateBlob()` round-trip restores original block dict |
| C3 | Genesis block pushes with correct day_hash preserved | After push + deobfuscate, `day_hash` matches original |
| C4 | Obfuscation uses the provided master key | Same block with different key → different obfuscated output (fingerprint check) |

### Category D — Transport Error Resilience — 4 tests

| # | Test | What it verifies |
|---|------|-----------------|
| D1 | `listFiles` throws → return 0, no crash | Network error during listing is caught, logged, returns 0 |
| D2 | `push` throws for mid-batch block → remaining blocks still attempted, correct count returned | Pushes blocks 0,1, block 2 fails, blocks 3,4 succeed → returns 4 |
| D3 | All pushes fail → return 0, no crash | Complete transport failure handled gracefully |
| D4 | `push` succeeds for blocks but `pushIndex` fails → blocks count still returned correctly | Index push failure doesn't undo block pushes or alter return value |

### Category E — Index Push — 4 tests

| # | Test | What it verifies |
|---|------|-----------------|
| E1 | Index pushed after blocks succeed | `ledger/index.json` present on remote after push |
| E2 | Index is obfuscated | Index bytes on transport are obfuscated, not plaintext JSON |
| E3 | No index data → index push skipped | `storage.get('ledger:index')` is null/undefined → no `ledger/index.json` written |
| E4 | Index push failure doesn't affect block count | Blocks pushed = 3 even when `push('ledger/index.json')` throws |

### Category F — SyncService Integration — 6 tests

| # | Test | What it verifies |
|---|------|-----------------|
| F1 | `pushLedgerBlocks` is a method on SyncService | Function exists and accepts no arguments (reads from internal state) |
| F2 | Reads blocks from `storage.get('ledger:blocks')` | Doesn't need blocks passed as parameter — pulls from storage |
| F3 | Reads index from `storage.get('ledger:index')` | Pulls index for push from storage |
| F4 | No-op when `isRemoteAvailable` is false | Mock transport null → returns 0, no errors |
| F5 | Uses `this._crypto.getMasterKey()` for obfuscation | Doesn't need explicit master key parameter |
| F6 | `pushLedgerBlocks` does NOT touch staging paths | `staging/blobs/current.json` and `device_cookie.bin` untouched |

### Category G — Edge Cases — 4 tests

| # | Test | What it verifies |
|---|------|-----------------|
| G1 | Large block with many entries (50+ entries) | Serialization + obfuscation handles large payloads correctly |
| G2 | Block fields with special Unicode characters | JSON serialization preserves emoji (`🎯`), CJK (`日本語`), diacritics (`café`) |
| G3 | `ledger:blocks` key missing from storage | `storage.get('ledger:blocks')` returns undefined → treated as empty, return 0 |
| G4 | Corrupt block data (missing day_hash field) | Doesn't crash — fields are opaque at transport layer, push still succeeds |

---

## Total: 31 tests

## Test Infrastructure (already exists, no new mocks needed)

- **MockTransport** — in-memory `Map`-based transport from `sync_service_test.mjs` (supports `pull`, `push`, `listFiles`, `queueResponse`)
- **MockCrypto** — from `sync_service_test.mjs` (supports `obfuscateBlob`, `deobfuscateBlob`, `getMasterKey`, `setMasterKey`)
- **TestHelpers** — from `test_helpers.mjs` (`assert`, `assertEq`, `assertNeq`, `assertDeepEq`, `assertThrows`, `summary`)
- **MemoryBackend** — from `src/sync/storage.js` (in-memory key-value)

## Implementation Location

Per storage decision in SESSION_HANDOFF.md: **Option B** — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON). No adapter layer.

- New method `pushLedgerBlocks()` on `SyncService` in `phpoc-web/src/sync/sync.js`
- Reads `ledger:blocks` and `ledger:index` from `this._storage`
- Uses `this._transport` for remote ops and `this._crypto` for obfuscation
- Called after `commitEntries` in the commit flow (DevModeContext or auto-sync wrapper)
