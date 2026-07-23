# Push to R2 — Test Exploration (Phase 1)

> **Plan:** Stage 2 of Flutter sync E2E (SESSION_HANDOFF.md)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1+2+3+4 complete
> **Next Phase:** N/A (complete)

## Architecture Overview

```
LedgerPushService (NEW)
├── AppDatabase.blockDao        — read blocks from SQLite
├── CryptoService               — obfuscate blocks + index with MK
│   ├── obfuscateBlob(data, mk) — tier-padded AES-CTR + HMAC → base64
│   └── deobfuscateBlob(data, mk) — reverse
├── HttpTransport               — PUT to Worker paths
│   ├── push(path, bytes)       — generic byte upload
│   ├── pull(path)              — generic byte download
│   └── listFiles(prefix)       — enumerate remote files
└── Worker/R2 (generic blob store)
    ├── ledger/blocks/NNNNNN.json — obfuscated block JSON
    ├── ledger/hash_index.json    — plaintext JSON array of block hashes
    └── ledger/index.json         — obfuscated empty dict
```

### What Already Exists

| Component | Status | Notes |
|-----------|--------|-------|
| `LedgerBackupService` | ✅ | Local export/import only |
| `SyncService` | ✅ | Staging-only push/pull (blob.bin + cookie) |
| `BlockDao.getAllBlocks()` | ✅ | Reads all blocks sorted by block_index |
| `CryptoService.obfuscateBlob()` | ✅ | Tier-based obfuscation → base64 output |
| `CryptoService.deobfuscateBlob()` | ✅ | Reverse of obfuscateBlob |
| `HttpTransport.push()` | ✅ | PUT to any Worker path |
| `HttpTransport.pull()` | ✅ | GET from any Worker path |
| `HttpTransport.listFiles()` | ✅ | List files under a prefix |
| Python `push_test_ledger.py` | ✅ | Reference: pushes blocks from testdata/ledger.json to Worker |

### What's New

A `LedgerPushService` that:
1. Reads all blocks from the DB via `BlockDao.getAllBlocks()`
2. Serializes each block to PHPSPEC-format JSON
3. Obfuscates each block with MK via `CryptoService.obfuscateBlob()`
4. Pushes to `ledger/blocks/NNNNNN.json` via `HttpTransport.push()`
5. Builds `hash_index.json` from block hashes (plaintext JSON array)
6. Pushes `ledger/index.json` (obfuscated empty dict / index state)
7. Reports progress: block count pushed, failures, completion status

### Key Constraints

1. **Obfuscation format:** Uses Flutter-native `CryptoService.obfuscateBlob()` (tier-padded AES-CTR + HMAC → base64). This is self-consistent for Flutter push+restore. The Python push script uses a different obfuscation scheme; cross-client compatibility is future work.
2. **MK required:** Push requires a cached master key (`crypto.hasMasterKey == true`). Blocks cannot be obfuscated without it.
3. **Transport required:** `HttpTransport` must be configured (URL + API key). Push is no-op without transport.
4. **Idempotency:** Push overwrites existing blocks on R2. Repeated pushes of the same ledger produce identical remote state.
5. **Hash index is plaintext:** `ledger/hash_index.json` is stored as plaintext JSON array (no obfuscation) — matches Python script convention. This is a design choice: hash index is needed for fast genesis checks without MK.
6. **Index is obfuscated:** `ledger/index.json` contains blind-index summary data (tag→duration) and must be obfuscated.
7. **Block filenames:** Zero-padded 6-digit block index (`000000.json` through `000030.json` for the 31-block test ledger).

## Test Groups

### Group A: LedgerPushService — Construction — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Constructor accepts `db`, `crypto`, `transport` (all required) | API surface contract | Three dependencies needed for push |
| A2 | Constructor rejects null `db` with `ArgumentError` | Input validation | Required dependency |
| A3 | Constructor rejects null `crypto` with `ArgumentError` | Input validation | Required for obfuscation |
| A4 | Constructor rejects null `transport` with `ArgumentError` | Input validation | Required for HTTP |
| A5 | Service exposes `pushAll()` as its single public method | API surface contract | Single entry point for full push |

### Group B: Block Serialization — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Block serialized as valid JSON with PHPSPEC field names | JSON structure | Consistent with LedgerBackupService export format |
| B2 | Genesis block includes `type: "genesis"`, `day_index: 0`, `prev_hash: "0"×64` | Genesis contract | Genesis is always block 0 with zero-hash prev |
| B3 | Day block includes `type: "day"`, `day_index` matches position | Day block contract | Correct type and index |
| B4 | Serialized block with 5 entries → JSON array has 5 entries | Entry count preserved | All entries in the block survive serialization |
| B5 | Block with `data_enc` containing invalid UTF-8 → entries exported as empty `[]` | Graceful degradation | Matches LedgerBackupService behavior |

### Group C: Obfuscation — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `obfuscateBlob(blockJson, mk)` returns non-empty base64 string | Obfuscation produces output | Block is encrypted before push |
| C2 | `deobfuscateBlob(obfuscated, mk)` round-trips correctly | Crypto integrity | Push→pull→deobfuscate must produce original JSON |
| C3 | Obfuscation with wrong MK → deobfuscate throws `CryptoException` | Wrong-key safety | Tampering or key mismatch is detected |
| C4 | Obfuscation of empty entries block still produces valid output | Edge case coverage | Empty blocks (e.g., year summaries) must still obfuscate |

### Group D: Push Operations — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `pushAll()` pushes 31 blocks to `ledger/blocks/000000.json` through `000030.json` | Full block push | Core feature — all blocks reach R2 |
| D2 | `pushAll()` pushes `ledger/hash_index.json` as plaintext JSON array | Hash index push | Enables fast genesis checks without MK |
| D3 | `pushAll()` pushes `ledger/index.json` as obfuscated JSON | Index push | Blind-index data for remote queries |
| D4 | Block pushed to R2 matches block read from DB (round-trip verify) | Data integrity | What gets pushed is what's in the DB |
| D5 | `pushAll()` returns `PushResult` with `blocksPushed: 31`, `success: true` | Result reporting | Caller knows what happened |
| D6 | `pushAll()` without MK throws `StateError` (cannot obfuscate) | Fail fast | MK required, check before any network calls |

### Group E: Hash Index — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Hash index is a JSON array of hex strings, length = block count | Format contract | Plaintext array for Worker-side inspection |
| E2 | Hash index entry [0] is the genesis block hash | Genesis position | First hash is always genesis |
| E3 | Hash index entry [N] matches block N's `block_hash` field | Index integrity | Each hash corresponds to the correct block |
| E4 | Hash index pushed as `application/octet-stream` with no obfuscation | Wire format | Worker stores as raw bytes, client reads as JSON |

### Group F: Push Result — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `PushResult.success` is `true` when all blocks + index pushed | Success case | Standard happy-path result |
| F2 | `PushResult.success` is `false` when any push fails | Partial failure | Don't silently claim success |
| F3 | `PushResult.failedBlocks` lists block indices that failed | Failure detail | Caller can retry specific blocks |
| F4 | `PushResult.errors` contains error messages for each failure | Error detail | Caller can display or log errors |

### Group G: Error Handling — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | Transport returns 403 (bad API key) → `pushAll()` includes auth error in result | Auth failure isolation | Bad credentials detected and reported |
| G2 | Worker unreachable → `pushAll()` returns failure result, not exception | Network resilience | Don't crash the app on network issues |
| G3 | Empty database (no blocks) → `pushAll()` succeeds, pushes 0 blocks | Empty ledger case | Fresh install with no commitments |
| G4 | Single block in DB → `pushAll()` pushes just that block + index | Minimal ledger | Single genesis block case |
| G5 | Transport timeout → partial push result with timeout errors | Timeout resilience | Long operations don't hang forever |
| G6 | `pushAll()` with concurrent call (double-tap) → second call no-ops or returns existing result | Idempotency | UI debounce + service guard |

### Group H: Integration — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Import test ledger → pushAll → listFiles on Worker → 31 block files present | E2E push verification | Core Stage 2 scenario |
| H2 | Import test ledger → pushAll → pull block back → deobfuscate → matches original | Round-trip integrity | Block survives push+retrieve cycle |
| H3 | Import test ledger → pushAll → pull hash_index → matches local hash_index | Hash index E2E | Index survives push+retrieve |
| H4 | pushAll → pushAll again (idempotent) → remote state unchanged (same file count) | Idempotent push | Repeated push is safe |
| H5 | Full test suite (918 tests) passes with zero regressions after all changes | No regressions | All existing modules unaffected |

### Group I: E2E against Real Worker — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Push test ledger (31 blocks) to real Worker → verify 31 block files exist via `?prefix=` | Real R2 verification | Production-validation of push |
| I2 | Push to real Worker → pull hash_index → genesis hash matches `f8f461b6...` | Genesis verification | Known test ledger genesis is correct on remote |
| I3 | Push to real Worker → pull block 0 → deobfuscate → block type is `"genesis"` | Genesis block integrity | Genesis is readable after push |
| I4 | Push to real Worker → pull block 15 → deobfuscate → entries array is non-empty | Mid-chain block integrity | Mid-chain blocks are pushed correctly |
| I5 | Push to real Worker → listFiles shows both `ledger/blocks/` and `ledger/hash_index.json` | All artifacts present | All expected files in R2 |
| I6 | Push to real Worker using creds from TEST_CREDENTIALS.md → all 31 blocks pushed successfully | Auth works | Real API key + Worker URL from test env |

## Summary

| Group | Focus | Tests | Key dependency |
|-------|-------|-------|---------------|
| **A** | Construction & API | 5 | `AppDatabase`, `CryptoService`, `HttpTransport` |
| **B** | Block Serialization | 5 | `BlockDao`, PHPSPEC format |
| **C** | Obfuscation | 4 | `CryptoService.obfuscateBlob` / `deobfuscateBlob` |
| **D** | Push Operations | 6 | `HttpTransport.push`, `BlockDao` |
| **E** | Hash Index | 4 | Block hashes, `HttpTransport` |
| **F** | Push Result | 4 | `PushResult` model |
| **G** | Error Handling | 6 | `HttpTransport` error modes |
| **H** | Integration | 5 | All modules (in-memory + mock transport) |
| **I** | E2E (Real Worker) | 6 | Deployed Worker, TEST_CREDENTIALS |
| **Total** | | **45** | |

## Test Infrastructure Notes

- **In-memory DB:** All unit/integration tests use `AppDatabase.inMemory()` (no filesystem)
- **Mock transport:** Groups A–H use a mock `HttpTransport` that records pushes in memory for verification
- **Real transport:** Group I uses the real Worker URL + API key from `TEST_CREDENTIALS.md`
- **Test ledger:** `testdata/ledger.json` (31 blocks, 146 entries) — loaded via `LedgerBackupService.importFromJson()`
- **MK derivation:** Test seed `RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0=` → derive MK → `crypto.setMasterKey(mk)`

## Source Files (planned)

| File | Type | Purpose |
|------|------|---------|
| `lib/services/ledger_push_service.dart` | NEW | LedgerPushService implementation |
| `lib/core/models/push_result.dart` | NEW | PushResult model |
| `test/services/ledger_push_service_test.dart` | NEW | Groups A–H tests (~39 tests) |
| `test/services/ledger_push_e2e_test.dart` | NEW | Group I tests (6 tests, real Worker) |
