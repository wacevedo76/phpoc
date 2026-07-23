# Wipe + Cloud Onboard — Test Exploration (Phase 1)

> **Plan:** Stage 3 of Flutter sync E2E (SESSION_HANDOFF.md)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 complete | ✅ Phase 2 complete | ✅ Phase 3 complete | ✅ Phase 4 (REFACTOR) complete
> **Next Phase:** Done

## Architecture Overview

```
Stage 3 Flow:
┌─────────────────────────────────────────────────────────────┐
│ 1. LedgerPushService.pushAll()                              │
│    └── Read blocks from DB → serialize PHPSPEC → obfuscate  │
│        → PUT to ledger/blocks/NNNNNN.json                   │
│        → PUT ledger/hash_index.json (plaintext)             │
│        → PUT ledger/index.json (obfuscated)                 │
├─────────────────────────────────────────────────────────────┤
│ 2. Wipe                                                     │
│    └── DELETE FROM blocks, entries, index_entries           │
│    └── Clear preferences, MK                                │
├─────────────────────────────────────────────────────────────┤
│ 3. OnboardingService.restoreFromCloud(seed, pass, url, key) │
│    └── Derive MK → build genesis → create device identity   │
│    └── Connect worker → initialPull (staging blob)          │
├─────────────────────────────────────────────────────────────┤
│ 4. LedgerPullService.pullAll()  [NEW]                       │
│    └── GET ledger/hash_index.json → block count             │
│    └── GET ledger/blocks/*.json → deobfuscate each          │
│    └── Assemble PHPSPEC JSON array                          │
│    └── Import via LedgerBackupService.importFromJson()      │
├─────────────────────────────────────────────────────────────┤
│ 5. Seed staging from imported blocks                        │
│    └── Read entries from blocks → write to SyncService      │
│    └── HistoryScreen reads via syncService.getEntries()     │
├─────────────────────────────────────────────────────────────┤
│ 6. Verify                                                   │
│    └── 31 blocks in DB, 146 entries in staging              │
│    └── Titles, tags, dates match test ledger                │
│    └── Genesis identity_seal matches known value             │
└─────────────────────────────────────────────────────────────┘

LedgerPullService (NEW)
├── HttpTransport.pull(path)          — GET from Worker paths
├── HttpTransport.listFiles(prefix)   — enumerate remote files
├── CryptoService.deobfuscateBlob()   — reverse AES-CTR+HMAC obfuscation
├── CryptoService.hasMasterKey        — MK required guard
└── LedgerBackupService.importFromJson() — import assembled PHPSPEC array
```

### What Already Exists

| Component | Status | Notes |
|-----------|--------|-------|
| `LedgerPushService.pushAll()` | ✅ | Pushes 31 blocks + hash_index + index to R2 |
| `LedgerBackupService.importFromJson()` | ✅ | Imports PHPSPEC JSON array into DB |
| `OnboardingService.restoreFromCloud()` | ✅ | Rebuilds genesis, connects worker, pulls staging blob |
| `OnboardingService.clearAllData()` | ✅ | Wipes DB + preferences |
| `CryptoService.deobfuscateBlob()` | ✅ | Reverse of obfuscateBlob |
| `HttpTransport.pull()` | ✅ | GET from any Worker path |
| `HttpTransport.listFiles()` | ✅ | List files under a prefix |
| `HistoryScreen` + `syncService.getEntries()` | ✅ | Displays entries from staging |

### What's New

A `LedgerPullService` that:
1. Pulls `ledger/hash_index.json` (plaintext JSON array) to get block count
2. Pulls each `ledger/blocks/NNNNNN.json` file via `HttpTransport.pull()`
3. Deobfuscates each block with MK via `CryptoService.deobfuscateBlob()`
4. Parses each block as PHPSPEC JSON
5. Assembles blocks into a PHPSPEC JSON array (sorted by block index)
6. Imports via `LedgerBackupService.importFromJson()`
7. Seeds staging entries so HistoryScreen can display them
8. Reports result: blocks pulled, entries staged, failures

### Key Constraints

1. **MK required:** Pull requires `crypto.hasMasterKey == true`. Blocks are obfuscated and cannot be deobfuscated without it. `restoreFromCloud` already caches MK before any sync operations.
2. **Genesis must exist locally:** `LedgerBackupService.importFromJson()` replaces all existing blocks. But restoreFromCloud already creates a genesis block. The pull service must handle this — either clear before import (since remote has the full chain) or skip genesis import.
3. **Obfuscation format:** Uses Flutter-native `CryptoService.deobfuscateBlob()`. Same format as `LedgerPushService` push. Self-consistent for Flutter push→pull.
4. **Hash index is plaintext:** `ledger/hash_index.json` is plaintext JSON — pullable without MK. Used to verify block count before deobfuscation.
5. **Block filenames:** Zero-padded 6-digit block index (`000000.json` through `000030.json` for 31-block test ledger).
6. **Staging seeding:** After importing blocks, entries must be written to sync staging storage so HistoryScreen can display them. This mirrors `seedTestLedger()` in `history_screen_test.dart`.
7. **Partial pull resilience:** If some blocks fail to pull (network errors), remaining blocks should still be imported. The result reports failed block indices.
8. **Test ledger:** `testdata/ledger.json` — 31 blocks (1 genesis + 30 day), 146 entries, 22 unique titles, 22 unique tags, date range 2026-06-01 to 2026-06-30.

## Test Groups

### Group A: LedgerPullService — Construction & API — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Constructor requires `db`, `crypto`, `transport`, `backupService` | API surface contract | Four dependencies needed for pull+import |
| A2 | Service exposes `pullAll()` as single public method | API surface contract | One entry point for full pull |
| A3 | `pullAll()` throws `StateError` if `crypto.hasMasterKey` is false | MK guard | Cannot deobfuscate without MK — fail fast |
| A4 | `pullAll()` with null transport returns empty result (no-op) | Graceful degradation | Local-only mode — sync not configured |

### Group B: Block Pulling from R2 — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Pull `ledger/hash_index.json` returns JSON array with N entries | Hash index retrieval | Plaintext index for block count verification |
| B2 | Pull single block (e.g., `000000.json`) → deobfuscate → valid PHPSPEC JSON | Single block pull | Core deobfuscation pathway works |
| B3 | Pull all 31 blocks → assemble into sorted PHPSPEC array | Full chain assembly | Blocks must be ordered by index regardless of pull order |
| B4 | Pull with transport returning null on some blocks → partial result, failed indices reported | Partial failure resilience | Network issues on some blocks don't block the rest |
| B5 | Pull from empty remote (no blocks) → returns empty list, no import attempted | Empty remote case | Fresh Worker with no ledger pushed |
| B6 | Block roundtrip: push → pull → deobfuscated JSON matches original | Crypto integrity | Obfuscate→deobfuscate preserves exact block content |

### Group C: Import after Pull — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Pull all blocks → import into DB → 31 blocks in database | Full import | Core feature — blocks land in DB |
| C2 | Genesis block after import → correct `identity_seal`, `block_index: 0`, `prev_hash` | Genesis integrity | Genesis block fields preserved through roundtrip |
| C3 | Pull + import → staging seeded with entries → `syncService.getEntries()` returns entries | Staging visibility | HistoryScreen reads from staging, not blocks directly |
| C4 | Pulled blocks match original `testdata/ledger.json` structure (same entry count per block) | Structural fidelity | No entries lost or reordered during push→pull |
| C5 | Import replaces any existing blocks (clear + reimport) | Import semantics | Consistent with `LedgerBackupService` contract — in case genesis already exists from restore |

### Group D: Full Roundtrip (Push → Wipe → Restore → Pull → Verify) — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Push 31 blocks → wipe → restore from cloud → pull blocks → 146 entries in staging | Full roundtrip | Primary Stage 3 scenario |
| D2 | After roundtrip, genesis block `identity_seal` matches known value | Genesis verification | Genesis hash `9dbf0a39...` preserved through roundtrip |
| D3 | After roundtrip, entry titles include known titles ("Coffee & Morning Planning", "Code Review", etc.) | Title fidelity | Specific known titles survive the roundtrip |
| D4 | After roundtrip, entry tags include known tags ("coding", "work", "morning", "food") | Tag fidelity | Tags survive serialization+obfuscation |
| D5 | After roundtrip, `syncService.getEntries()` returns exactly 146 entries | Entry count | No entries lost or duplicated |
| D6 | After roundtrip, entries span June 1–30, 2026 date range | Date range | Block date mapping preserved |
| D7 | After wipe (before restore), DB has zero blocks and staging is empty | Wipe verification | `clearAllData()` actually clears everything |
| D8 | After restore from cloud (before pull), genesis exists but staging is empty (no staging blob on remote) | Intermediate state | Restore rebuilds genesis locally; staging blob is empty for fresh push |
| D9 | Roundtrip preserves PHPSPEC field names (`type`, `day_index`, `date`, `prev_hash`, `entries`, `day_hash`) | Format fidelity | PHPSPEC fields survive full push→pull cycle |
| D10 | Full roundtrip with mock transport succeeds — `LedgerPullResult.success` is true | Result reporting | Caller gets accurate success/failure |

### Group E: E2E against Real Worker — ~8 tests

> These tests require `PHPOC_WORKER_URL` and `PHPOC_API_KEY` environment variables.
> Skip gracefully when credentials are absent.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Push 31 blocks to real Worker → pull all back → 31 blocks in DB | Real R2 roundtrip | Production-validate push→pull cycle |
| E2 | Real Worker roundtrip: push → wipe → restoreFromCloud → pullAll → 146 entries | Full E2E | Complete Stage 3 scenario against real Worker |
| E3 | After real Worker roundtrip, entry titles include "Working on Project Alpha" and "Evening Exercise" | Known title check | Specific entries survive real R2 trip |
| E4 | After real Worker roundtrip, tags include "coding", "work", "exercise", "health" | Known tag check | Tag fidelity against real R2 |
| E5 | Pull from real Worker → genesis block 0 → `identity_seal` matches `9dbf0a39...` | Genesis hash on R2 | Genesis is correct on real remote |
| E6 | Pull `hash_index.json` from real Worker → genesis hash at [0] matches `f8f461b6...` | Hash index integrity | Plaintext index is correct on R2 |
| E7 | Pull block 0 from real Worker → deobfuscate → `type: "genesis"`, `day_index: 0` | Genesis block format | First block is correct genesis on R2 |
| E8 | Pull block 30 from real Worker → deobfuscate → 8 entries, `type: "day"`, `day_index: 30` | Last block format | Final block is correct day block with all entries |

### Group F: Error Handling — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Pull with unreachable Worker → exception caught, result reports failure, genesis preserved locally | Network resilience | Don't destroy local state on connection failure |
| F2 | Pull with wrong MK (after restore with different seed) → `CryptoException`, no blocks imported | Wrong-key safety | Crypto error must cross boundary cleanly |
| F3 | Corrupted block on remote (invalid JSON after deobfuscation) → that block skipped, others imported | Corruption resilience | One bad block shouldn't block the chain |
| F4 | Pull with 401 from Worker → `HttpTransportException`, result reports auth failure | Auth failure isolation | Bad API key detected and reported |
| F5 | Concurrent `pullAll()` calls → second call waits for first or returns same result | Race condition | Double-tap guard on UI |

## Summary

| Group | Focus | Tests | Key dependency |
|-------|-------|-------|---------------|
| **A** | Construction & API | 4 | `AppDatabase`, `CryptoService`, `HttpTransport`, `LedgerBackupService` |
| **B** | Block Pulling | 6 | `HttpTransport.pull`, `CryptoService.deobfuscateBlob` |
| **C** | Import after Pull | 5 | `LedgerBackupService.importFromJson` |
| **D** | Full Roundtrip | 10 | All modules (in-memory + mock transport) |
| **E** | E2E (Real Worker) | 8 | Deployed Worker, TEST_CREDENTIALS |
| **F** | Error Handling | 5 | All error paths |
| **Total** | | **38** | |

## Test Infrastructure Notes

- **In-memory DB:** All unit/integration tests use `AppDatabase.inMemory()`
- **Mock transport:** Groups A–D, F use a mock `HttpTransport` that serves pre-obfuscated blocks
- **Real transport:** Group E uses the real Worker URL + API key from environment variables
- **Test ledger:** `testdata/ledger.json` (31 blocks, 146 entries, 22 titles, 22 tags)
- **MK derivation:** Test seed `RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0=` → SHA-256 → MK hex
- **Known genesis hash (identity_seal):** `9dbf0a3940fe5ce80c9a194043a3da30ad7082ad8edff38160fecda704231b18`
- **Known genesis hash (hash_index[0]):** `f8f461b612f770b90b05e45188fa0848e134cfa92af3218037d4c049d9d3035a`

## Source Files (planned)

| File | Type | Purpose |
|------|------|---------|
| `lib/services/ledger_pull_service.dart` | NEW | LedgerPullService implementation |
| `lib/core/models/pull_result.dart` | NEW | LedgerPullResult model |
| `test/services/ledger_pull_service_test.dart` | NEW | Groups A–C, F tests (~20 tests) |
| `test/services/wipe_cloud_onboard_test.dart` | NEW | Groups D tests (~10 tests) |
| `test/services/wipe_cloud_onboard_e2e_test.dart` | NEW | Group E tests (8 tests, real Worker) |
