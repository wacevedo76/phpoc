# Cross-Client Canonical Serialization — Test Exploration (Phase 1)

> **Plan:** Option A1 — Unified canonical JSON serialization for all three contexts
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 4 (REFACTOR — complete)
> **Next:** Ready for next task
> **Related:** BACKLOG.md §Phase 5, E2E_CROSS_CLIENT_FIX_PLAN.md Bug 3b, ADR (to be written)

## Architecture Overview

Three serialization contexts currently diverge:

| Context | Module | Current Formula | Target Formula |
|---------|--------|-----------------|----------------|
| R2 per-block | `domain/ledger/remote_sync.py:_obfuscate_block()` | `json.dumps(block)` | `json.dumps(block, sort_keys=True)` |
| CLI entry hash | `domain/ledger/chain.py:build_day_block()` | `json.dumps(data, sort_keys=True, indent=2)` | Already canonical ✓ |
| Web entry hash | `phpoc-web/src/ledger/utils.js:computeEntryHash()` | `JSON.stringify(data, null, 2)` | Must sort keys like Python |
| Verification flex | `domain/ledger/chain.py:_verify_entry_hash_flex()` | 2 formats (sort+i2, sort+cmp) | 3 formats (+nosort+i2 for legacy) |
| Migration | `cli/migrate.py:migrate_chain()` | Preserves entry hashes as-is | Recomputes entry hashes to canonical |

### Entry Hash Format Matrix

| Format | Python Formula | JS Equivalent | Source |
|--------|---------------|---------------|--------|
| `sort+indent2` | `sha256(json.dumps(data, sort_keys=True, indent=2))` | `sha256(jsonSortIndent2(data))` | Current CLI, target canonical |
| `sort+compact` | `sha256(json.dumps(data, sort_keys=True))` | `sha256(jsonSort(data))` | Legacy pre-v0.4 CLI |
| `nosort+indent2` | `sha256(json.dumps(data, indent=2))` | `sha256(JSON.stringify(data, null, 2))` | Old CLI + current Web |
| (current web) | N/A | `sha256(JSON.stringify(data, null, 2))` | `nosort+indent2` — PHPOC Web |

### Data Flow

```
CLI capture → staging (plain:) → commit → build_day_block()
    └─ entry["hash"] = sha256(json.dumps(data, sort_keys=True, indent=2))
    └─ block[hash_key] = seal(json.dumps(seal_data, sort_keys=True))  // seals already sorted
    └─ push to R2: _obfuscate_block(block)
            └─ plaintext = json.dumps(block, sort_keys=True)  // ← change here

Web capture → LocalCache → commit → buildDayBlock()
    └─ computeEntryHash(data): sha256(JSON.stringify(data, null, 2))  // ← change here
    └─ buildGenesisBlock / buildDayBlock: seal(jsonSort(content))  // already sorted

R2 pull: deobfuscate → json.loads() → verify
    └─ _verify_entry_hash_flex(): try sort+i2, try sort+cmp, try nosort+i2  // ← extend here
```

## Test Groups

### Group A: R2 Block Serialization (Python) — ~10 tests
**File:** `tests/test_serialization_unification.py` (new) or extend `tests/test_remote_sync.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `_obfuscate_block()` produces `sort_keys=True` JSON bytes | Verify serialization format | Confirms the canonical format is used for new pushes |
| A2 | Roundtrip: serialize → deobfuscate → parse → identical block dict | Data integrity preserved through sorted serialization | Sort must not change block semantics |
| A3 | Two identical blocks serialize to identical bytes with sorted keys | Deterministic output | Without sort, insertion-order differences produce different bytes |
| A4 | Blocks with different insertion orders produce identical sorted output | Deterministic across construction paths | Same data regardless of dict creation order |
| A5 | Genesis block roundtrip through sorted serialization | Genesis survives format change | Genesis has special fields (identity, format_version) |
| A6 | Day block with 10+ entries roundtrips correctly | Scale test | Large blocks behave correctly |
| A7 | Month summary block roundtrips correctly | All block types covered | Summary blocks have different hash fields |
| A8 | Year summary block roundtrips correctly | All block types covered | Same as A7 |
| A9 | Old-format R2 block (unsorted) still deobfuscates and parses | Backward compatibility | Existing R2 blocks must remain readable |
| A10 | Deobfuscated old-format block verifies against its seal | Backward compat + seal integrity | Seal verification uses sorted keys internally, independent of source format |

### Group B: JS computeEntryHash — ~8 tests
**File:** `phpoc-web/test/utils_test.mjs` (extend existing) or new `phpoc-web/test/serialization_unification_test.mjs`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `computeEntryHash(data)` produces same output as Python `sha256(json.dumps(data, sort_keys=True, indent=2))` | Cross-platform parity | The core invariant of unification |
| B2 | Entry hash is stable regardless of JS object key insertion order | Deterministic in JS | Object key order varies by JS engine and code path |
| B3 | Entry with all standard fields (title, duration, startTime_enc, etc.) matches Python | Realistic entry | Tests with the full field set used in production |
| B4 | Entry with `null` endTime_enc (active task) matches Python | Edge case: null values | Nulls must serialize identically |
| B5 | Entry with `plain:` prefixed staging fields matches Python | Staging format | Staging uses plain:text convention |
| B6 | Entry with tags array matches Python sorted output | Array fields | Tags must sort deterministically |
| B7 | Entry with metadata object matches Python sorted output | Nested objects | Deep sorting works correctly |
| B8 | Legacy entry hash format (nosort+indent2) is distinguishable from canonical | Legacy detection | Verifies the two formats produce different hashes for the same data |

### Group C: _verify_entry_hash_flex — ~8 tests
**File:** `tests/test_serialization_unification.py` (new) or extend `tests/test_phase3_ledger_engine.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Flex accepts `sort+indent2` hash (current CLI format) | Existing behavior preserved | No regression on the primary format |
| C2 | Flex accepts `sort+compact` hash (legacy pre-v0.4 CLI) | Existing behavior preserved | No regression on legacy format |
| C3 | Flex accepts `nosort+indent2` hash (old CLI + current web) | New format support | Fixes the gap found in the user's personal ledger |
| C4 | Flex rejects tampered hash (byte flip in any format) | Security: tamper detection | Hash verification must fail on corruption |
| C5 | Flex rejects completely wrong random hash | Security: random match | Low probability of accidental match |
| C6 | Flex handles entry with `content_hash` field present | Content hash interaction | Content hash field is excluded from verification |
| C7 | Flex handles entry with `plain:` prefixed string fields | Staging field format | Plaintext staging entries use plain: prefix |
| C8 | All 11 entries from user's personal ledger pass flex | Real-world ledger | Validates the fix against the actual ledger that exposed the gap |

### Group D: ph migrate entry hash recomputation — ~10 tests
**File:** `tests/test_migration.py` (extend existing Group D)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Migration recomputes entry hashes to `sort+indent2` format | Core migration behavior | Entry hashes change from legacy to canonical |
| D2 | Migration preserves all entry data fields unchanged | Data integrity | Only hashes change, not content |
| D3 | Block seals are recomputed after entry hash changes | Seal consistency | Changing entry hashes requires resealing blocks |
| D4 | Chain `prev_hash` linkage remains valid after migration | Chain integrity | All prev_hash links point to correct block seals |
| D5 | Migrated chain passes full `verify()` | End-to-end verification | The migrated chain is fully valid |
| D6 | Migration is idempotent — running twice produces same result | Safety: idempotent | Re-running migration on already-canonical chain is a no-op |
| D7 | Migration handles entries already in canonical format (no-op for them) | Mixed-format chain | Some entries may already be canonical |
| D8 | Migration handles chain with nosort+indent2 entries | User's format | The specific format found in the user's ledger |
| D9 | Content hashes remain valid after migration | Content hash integrity | Entry hash changes should not break content hashes |
| D10 | Backup file created before migration | Safety: rollback | ledger.json.bak always created |

### Group E: Cross-Platform Entry Hash Parity — ~5 tests
**File:** `tests/test_cross_platform_integration.py` (extend) or new test

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Python `build_day_block()` and JS `buildDayBlock()` produce same entry hash for same data | Cross-client consistency | CLI and web produce identical hashes |
| E2 | Same entry data → same hash in both environments (roundtrip reference test) | Format portability | An entry created on CLI should verify on web and vice versa |
| E3 | Entry with encrypted fields (`*_enc` with hex ciphertext) hashes the same across platforms | Encrypted data parity | Ciphertext is opaque bytes, must not be altered by serialization |
| E4 | Entry with multiple encrypted fields hashes the same across platforms | Multi-field encryption | All encrypted fields covered |
| E5 | Hash of entry with `device_id_enc` and `device_proof` is cross-platform consistent | Full schema coverage | All standard fields including device attribution |

### Group F: Deferred / No-Op — ~2 tests  
**File:** Existing test migrations/updates

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Existing test D5 "migrate preserves entry data" updated to reflect new behavior | Test accuracy | Old test asserted hashes unchanged; now they change |
| F2 | Full Python test suite (1974 tests) passes with zero regressions | Regression safety | Must not break unrelated functionality |

## Summary

| Group | Area | Tests | File |
|-------|------|-------|------|
| A | R2 block serialization | 10 | `tests/test_serialization_unification.py` |
| B | JS computeEntryHash | 8 | `phpoc-web/test/serialization_unification_test.mjs` |
| C | _verify_entry_hash_flex | 8 | `tests/test_serialization_unification.py` |
| D | ph migrate entry hash recomputation | 10 | `tests/test_migration.py` |
| E | Cross-platform parity | 5 | `tests/test_cross_platform_integration.py` |
| F | Regression / test updates | 2 | Various existing files |

**Total: 43 assertions across 6 groups, 4 test files (2 new, 2 extended)**

### Key Coverage Areas
- Serialization determinism (A3-A4, B2)
- Cross-platform parity (B1, E1-E5)
- Backward compatibility (A9-A10, C1-C3)
- Existing ledger fix (C8, D8)
- Migration safety (D6-D7, D10)
- Real-world validation (C8 — user's actual ledger)
