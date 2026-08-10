# CCS-4: Cross-Client E2E Testing — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md`, `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
> **Purpose:** Blueprint of all needed cross-client interoperability assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration) complete
> **Next Phase:** Phase 2 (RED) → ✅ | Phase 3 (GREEN) → ✅ `CCS4_PHASE3.md` | Phase 4 (REFACTOR)

## Architecture Overview

CCS-2 (Web) and CCS-3 (CLI) independently wired row-level staging sync into `SyncService.checkAndSync()` / `StagingService.check_and_sync()` based on the same canonical row model (PHPSPEC §8). CCS-4 is the validation gate: prove the three clients (Flutter/Dart, Web/JS, CLI/Python) interoperate against a **live Worker** with byte-identical formats.

### Canonical row contract (all clients must agree)
```
{ activity_id, activity_status, activity: <JSON string>, updated_at, committed }
```
- `activity_status`: "active" | "paused" | "ended" (derived from DTO flags)
- `activity` is a **JSON-serialized string** of the flat fields (title, start_epoch, …)
- `activity_id` falls back to `entry_id`
- Merge key: `activity_id`; collision → LWW, **local wins on tie**
- Merge output sorted deterministically by `activity_id`
- Hash index: sorted by `activity_id`, SHA-256 over canonical rows → byte-compared

### Implementations under test
| Client | Engine | Row model | Hash index | Merge |
|--------|--------|-----------|------------|-------|
| CLI (Python) | `domain/staging/service.py` | `row_merge.py` | `core/staging_hash_index.py` | `merge_engine.merge_rows()` |
| Web (JS) | `phpoc-web/src/sync/sync.js` | `remote_sync.js` `dtoToCanonicalRow` | `staging_hash_index.js` | `mergeRows` (`sync.js`/row layer) |
| Flutter (Dart) | `phpoc_flutter/.../sync_service.dart` | staging hash index Dart | `staging_hash_index.dart` | (via sync service) |

### Existing E2E infra
- `tests/test_cross_platform_integration.py` — CLI ↔ Worker live round-trips (blob, cookie, blocks)
- `phpoc-web/test/row_integration_test.mjs`, `row_sync_test.mjs`, `ccs2_row_level_reconcile_test.mjs` — Web row-merge unit tests
- `BROWSER_E2E_TEST_PLAN.md` — manual browser E2E against Vivaldi

## Strategy

Two complementary layers of "E2E":

1. **Cross-client deterministic equivalence (pure, CI-safe):** Python ↔ JS byte-for-byte parity of canonical row serialization, hash index, and merge output. These are process-local tests that need no live Worker and are the strongest guarantee of cross-client agreement, because each client produces the exact same SHA-256 and merge decision from the same input.

2. **Live Worker round-trips (network).** Reuse the existing CLI↔Worker test harness to establish a canonical blob on the Worker; then exercise a **JS RemoteSync against the live Worker** to prove the Web reads the CLI-written canonical blob and merges identically (Web↔CLI pair). Flutter↔CLI byte-level equivalence is delegated to the pure Dart hash-index tests (hash index is the same deterministic algorithm across all three).

## Test Groups

### Group A: Canonical Row Serialization Parity (Python ↔ JS) — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `row_merge.dtoToCanonicalRow(dto)` output equals JS `dtoToCanonicalRow(dto)` for an active DTO | Cross-client row format parity | Same input DTO must produce identical canonical row JSON on both engines |
| A2 | Same for a paused DTO | status derivation parity | `_derive_status_from_dto` / `_deriveStatusFromDTO` must agree on `paused` |
| A3 | Same for an ended DTO (`is_active:false`) | status derivation parity | Must agree on `ended`, not `active` |
| A4 | Same for a DTO lacking `activity_id` (fallback to `entry_id`) | ID fallback parity | Merge key resolution must be identical across clients |
| A5 | Canonical `activity` JSON string is byte-identical (sort key, `null` vs absent) | Byte-level hash equivalence | Any byte diff propagates to SHA-256 and breaks hash-index parity |
| A6 | `canonicalRowToDTO` round-trips the serialized `activity` string without loss | Bidirectional fidelity | Ensures pull → DTO → push preserves data across clients |

### Group B: Hash Index Parity (Python ↔ JS) — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `StagingHashIndex.build(rows)` index equals JS hash-index build for same row set | Index construction parity | Both must sort by `activity_id` before hashing |
| B2 | `StagingHashIndex.computeHash(index)` SHA-256 equals JS computed hash | Byte-identical hash index (backlog assertion #1) | Same set of rows must yield identical SHA-256 across clients |
| B3 | Index is order-invariant (input row order doesn't change hash) | Deterministic hashing | Merge output ordering must not alter the index |
| B4 | Empty index → identical empty-array hash on both engines | Edge-case parity | Fast-path empty-blob compare must match |

### Group C: Merge Parity (Python ↔ JS) — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `MergeEngine.merge_rows(local, remote)` output equals JS `mergeRows(local, remote)` for disjoint activity_ids | Merge parity — no conflicts | Both clients must converge to same merged set |
| C2 | Same for overlapping activity_ids with higher `updated_at` remote | LWW parity | Winner selection must match (remote newer → remote wins) |
| C3 | Same for overlapping ids where local is newer | local-wins-on-tie parity | Ties resolve to local on both clients |
| C4 | Same for exact tie (`updated_at` equal) | tie-break parity | Local-wins-on-tie contract (backlog assertion #3) |
| C5 | Same with committed-exclusion filtering applied | Committed cleanup parity (backlog assertion #5) | Both must drop committed rows not present remotely |
| C6 | Merge output sorted deterministically by `activity_id` in both engines | Byte-identical merge result | Sorting must match so hash of merged output matches |

### Group D: Cookie Specifier Parity (Python ↔ JS ↔ Flutter) — ~3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | CLI cookie specifier derivation (`HMAC(mk, "phpoc:device:"+device_id)`) matches JS derivation | Cookie specifier parity (backlog assertion #4) | Same MK + device_id → same specifier on all clients |
| D2 | Client suffix applied (CLI `-cli`, Web `-web`) produces distinct specifiers | Cross-client identity isolation | Guarantees pull+merge path (never same-device overwrite) |
| D3 | Device proof verifies across clients (independent computation) | Auth interoperability | Each side computes + verifies independently, no coordination needed |

### Group E: Live Worker Round-Trip(s) — Web ↔ CLI — ~5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | CLI pushes canonical blob to live Worker; JS `RemoteSync.pullBlob` decrypts and returns same canonical rows | Web↔CLI blob interop | Web must read CLI-written blob byte-faithfully |
| E2 | JS re-obfuscates with same MK → byte-identical ciphertext to CLI's obfuscation | Blob byte-identity (backlog assertion #2) | Same plaintext + MK → same ciphertext per obfuscation algorithm |
| E3 | JS `mergeRows` over CLI-pulled + local rows matches what CLI `merge_rows` would produce | Merge parity on real data | Real cross-client merge convergence |
| E4 | Push merged blob via JS, pull via CLI → byte-identical round-trip | Bidirectional Worker round-trip | Full CLI→Web→CLI consistency |
| E5 | Committed cleanup: CLI commits, Web re-pull sees committed rows excluded | Committed-cleanup cross-client (backlog assertion #5) | Cleanup propagates both ways |

## Summary Report

| Group | Name | Tests |
|-------|------|-------|
| A | Canonical Row Serialization Parity | 6 |
| B | Hash Index Parity | 4 |
| C | Merge Parity | 6 |
| D | Cookie Specifier Parity | 3 |
| E | Live Worker Round-Trip (Web↔CLI) | 5 |
| **Total** | | **24** |

### Test environment mapping

| Group | Location | Requires network? | Primary language |
|-------|----------|-------------------|------------------|
| A | `tests/test_ccs4_cross_client.py` | No | Python (with JS via node subprocess) |
| B | `tests/test_ccs4_cross_client.py` | No | Python |
| C | `tests/test_ccs4_cross_client.py` | No | Python |
| D | `tests/test_ccs4_cross_client.py` | No | Python |
| E | `tests/test_ccs4_live_worker.py` | **Yes** (live Worker) | Python + JS |

### Coverage by backlog assertion
| Backlog assertion | Group(s) |
|-------------------|----------|
| 1. Hash index byte-identical | B1–B4 |
| 2. Obfuscated blob byte-identical | E2 |
| 3. Merge identical regardless of client | C1–C6, E3 |
| 4. Cookie specifier matches | D1–D3 |
| 5. Committed cleanup both sides | C5, E5 |

### Design notes / decisions
- **Flutter ↔ CLI/Web** byte parity is proven through equivalent pure Dart hash-index tests already in the Flutter suite; Groups A–C give the Python↔JS bridge. A full Flutter↔CLI live Worker round-trip (Dart HTTP against testing Worker in CI) is out of scope for this pass and delegated to the manual browser/emulator E2E in `BROWSER_E2E_TEST_PLAN.md` + Flutter integration tests.
- Group E requires the live Worker + `TEST_CREDENTIALS.md`; it will be marked/run with the same `--timeout 180s` convention as existing live tests so it can be skipped in off-line runs.
- Web engine run via `node --test` by spawning a JS helper (`phpoc-web/test/ccs4_cross_client.mjs`) that the Python suite shells out to; alternatively a Python port of the parity can avoid subprocess flakiness. Decision deferred to Phase 2 (whichever yields deterministic cross-runtime output).

## Files (planned)
- `docs/planning/CCS4_PHASE1.md` (this blueprint)
- `docs/planning/CCS4_PHASE2.md` *(future)*
- `tests/test_ccs4_cross_client.py` — Groups A–D (pure/process-local parity)
- `tests/test_ccs4_live_worker.py` — Group E (live Worker round-trips)
- `phpoc-web/test/ccs4_cross_client.mjs` — JS-facing parity helpers/assertions (Phase 2)
- `docs/planning/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` (update) — record CCS-4 result matrix
- `docs/planning/BACKLOG.md` — mark CCS-4 in-progress → complete
- `SESSION_HANDOFF.md` — phase tracking
