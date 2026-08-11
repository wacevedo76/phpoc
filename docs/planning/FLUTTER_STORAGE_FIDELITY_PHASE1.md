# Flutter Storage Fidelity for Canonical Summaries — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` §Phase 7 (phone e2e verify)
> **Purpose:** Blueprint of all test assertions needed to make `LedgerChain.verify()`
> pass after a PHPSPEC import of a chain carrying ADR-029a canonical summaries
> (`month`/`year`), fixing the on-device "Integrity Check Failed".
> **Status:** ✅ Phase 4 (REFACTOR) DONE — 4-phase TDD complete.
> Phase 3 (GREEN): `_phpSpecToBlock` serializes the full
> canonical block map into `data_enc` (+ carry sealed `date`/`month`/`year` through
> `PhpSpecFormat.blockToMap`; `_blockToMap` preserves sealed `day_index`).
> `ledger_backup_service_fidelity_test.dart` 11/11 GREEN; analyzer clean;
> no new regressions (pre-existing A2/A7/F2 also fixed).
> **Phase 4 (REFACTOR) DONE:** extracted `_serializeCanonicalMap` helper in
> `ledger_backup_service.dart`; added `PhpSpecFormat.kMonth`/`kYear`/`kKeyVersion`
> constants. Fidelity (11/11) + ledger (280/280) stay GREEN; only pre-existing
> B1/B4/E6 remain.

## Architecture Overview

The Flutter app persists ledger blocks in a SQLite `blocks` table and reconciles
them with the canonical PHPSPEC format during cloud pull/restore:

- **Chain format** (in-memory / on R2): block **maps** with `type`, `day_index`,
  `date`, `month`/`year` (summaries only), `prev_hash`, `entries`, and a per-type
  seal-hash field (`block_hash`/`day_hash`/`month_hash`/`year_hash`).
- **DB format** ([Block] row): `block_id` (the seal hash), `block_type`,
  `block_index`, `data_enc`, `identity_seal`, `prev_hash`, `created_at`.
- **`LedgerBackupService.importFromJson`** (cloud pull path): parses PHPSPEC JSON
  into [Block] rows via `_phpSpecToBlock`. **BUG:** it serializes only the
  `entries` array into `data_enc`, discarding `type`, `date`, `month`/`year`,
  `day_index`, and the hash fields. These are irrecoverable for reconstruction.
- **`LedgerBlockStore._blockToMap`** (read path): decodes `data_enc`, overlays
  DB columns, and returns a chain map for `LedgerChain.verify()`. Because the
  full canonical fields were dropped at import, reconstruction yields wrong
  `date` (`1970-01-01`), no `month`/`year`, and the block → chain map cannot
  reproduce the original seal → **every summary (and date-bearing) block fails
  `verify()`**.

**Fix direction:** `_phpSpecToBlock` must persist the **full canonical block map**
into `data_enc` (the same format `extractEntries`/`extractHash`/`_blockToMap`
already expect), so reconstruction is faithful. The DB columns remain the
authoritative overlay. Legacy entries-only `data_enc` (Bug C) stays as a read
fallback.

## Phase 2 — RED Test Definition (DONE)

Authored `phpoc-flutter/test/services/ledger_backup_service_fidelity_test.dart`
(11 tests) covering Groups A–D below. RED result against the current buggy
`_phpSpecToBlock`: 10 expected failures, 1 GREEN guard.

| Group | Tests | Status | Contract covered |
|-------|-------|--------|------------------|
| A | A1–A3 | RED | imported `data_enc` is a full canonical block map (type/date/month/year/hash) |
| B | B1–B2 | RED | `LedgerBlockStore` reconstruction preserves summary identity for `verify()` |
| C | C1–C5 | RED | full-chain `LedgerChain.verify()` passes after PHPSPEC import |
| D | D1–D2 | D1 GREEN / D2 RED | linkage guard + summary identity-not-fabricated |

Cross-cutting fixture helpers build valid 0.4.0-sealed chain maps via
`CryptoService` (reference `LedgerBlockStore` write path), serialize them to
PHPSPEC, import through `LedgerBackupService`, then restore through
`LedgerBlockStore(db.blockDao)` for `verify()`.

## Test Files / Modules Touched

- `lib/services/ledger_backup_service.dart` — `_phpSpecToBlock`, `_phpSpecToBlock` data_enc serialization.
- `lib/data/ledger/store_adapters.dart` — `_blockToMap`, `_decodeDataEnc` (verify Bug-C fallback preserved).
- `lib/core/utils/phpsec_format.dart` — `blockToMap` (export) must carry `month`/`year`/`date` so export→import is lossless.
- Tests: `test/services/ledger_backup_service_test.dart`, `test/data/ledger/store_adapters_test.dart`.

## Test Groups

### Group A: Import Preserves Canonical Fields into `data_enc` — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | After `importFromJson` of a `month_summary` block with `month`/`year`, decoding `data_enc` as a JSON object contains `month`/`year` equal to source | Prove summary identity survives import | The whole bug is that month/year are dropped; without survival nothing downstream can recover them |
| A2 | `data_enc` decodes to a JSON **object** (not a list) containing `type`, `date`, `entries`, `prev_hash` | Prove the full canonical map is persisted, not entries-only | Faithful reconstruction requires all sealed fields present in `data_enc` |
| A3 | A `day` block round-trip keeps `date` (exact ISO string) in `data_enc` | Prove the date-bearing seal field survives | The day seal includes `date`; the old path reconstructed `1970-01-01` |
| A4 | Genesis `data_enc` is a full object with `type`/`date`/`entries`/`identity` (not `[]`) | Prove genesis is not reduced to an empty list | On-device genesis `data_enc` was `[]`, losing date → seal failure |
| A5 | `year_summary` block keeps `year` (int) in `data_enc` | Cover year summaries too | Parallel to A1 for year type |
| A6 | `_phpSpecToBlock` still sets `blockType`/`blockId`/`prevHash`/`createdAt` columns correctly despite full-map `data_enc` | DB-authoritative columns keep their role | The read overlay depends on these columns matching the sealed fields |

### Group B: Faithful Reconstruction via `readBlocks()` — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | After import, `LedgerBlockStore.readBlocks()` returns `month_summary` maps with `month`/`year` | Reconstructed maps expose summary identity to `verify()` | `verify()` seals over `month`/`year`; missing them fails |
| B2 | `readBlocks()` day maps preserve the original ISO `date` string | Reconstructed date matches the sealed date | `verify()` seals over `date`; `1970-01-01` sentinel fails |
| B3 | `readBlocks()` summary maps have `prev_hash`, per-type hash field, and `entries` intact | Reconstruction is complete for the seal payload | Every seal field must be present with the original value |
| B4 | A legacy **entries-only** `data_enc` (Bug C, JSON list) still reconstructs via `_reconstructFromEntries` | Backward compatibility is preserved | Existing on-device ledgers with entries-only `data_enc` must keep working |

### Group C: Full-Chain `verify()` After Import — ~5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Import a full chain (genesis + N days + a month_summary + year_summary) and `LedgerChain.verify()` returns **true** | The end-to-end requirement of this task | The migrated 132-block ledger must verify on-device after pull+import |
| C2 | The same chain's `verify()` returns **false** if a summary `month` is tampered after import | `verify()` still detects tampering | Proves the fix didn't disable integrity checking |
| C3 | Import + verify of a chain **without** summaries (days only) still returns true | No regression on summary-less chains | Older chains must keep verifying |
| C4 | Genesis-only chain import + verify returns true | Edge case | A single-genesis ledger is bootstrap-valid |
| C5 | The reconstructed chain matches the source PHPSPEC block maps field-for-field (round-trip diff) | Export-side losslessness | Guards the whole persist→read loop; overlaps export parity |

### Group D: No Regression on Existing Round-Trip — ~3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `_blockToMap` leaves non-seal, non-overlay fields in `data_enc` untouched | Reconstruction is additive, not destructive | Avoids dropping arbitrary extension fields |
| D2 | `LedgerBlockStore.appendBlocks` (full-map write path) still reconstructs identically | Primary write path unchanged | The fix must not break the normal commit path |
| D3 | Existing pre-fix round-trip assertion (C1 in `ledger_backup_service_test.dart`) remains GREEN | Guard against breaking current behavior | Preserve the currently-passing export→import→export parity |

## Summary Report

- **Total assertions:** 18 (A:6, B:4, C:5, D:3)
- **Key coverage areas:**
  1. Import persistence of canonical summary fields (`month`/`year`) and `date`.
  2. Faithful `readBlocks()` reconstruction feeding `verify()`.
  3. End-to-end `LedgerChain.verify()` true on a PHPSPEC-imported chain with summaries.
  4. Backward compatibility of legacy entries-only `data_enc`.
- **Dependencies:** Requires the Phase 3 implementation to serialize the full
  block map in `_phpSpecToBlock` and preserve the Bug-C read fallback.
- **Known pre-existing failures (out of scope, must not regress/worsen):**
  `ledger_backup_service_test.dart` A2, A7, B1, B4, E6, F2 are stale tests that
  conflict with current intentional design (genesis-date semantics, empty-import
  guard, array-index `block_index`, DB-authoritative blockId). They will remain
  as pre-existing failures documented in SESSION_HANDOFF.
