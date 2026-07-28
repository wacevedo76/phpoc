# LedgerPushService — Seal Field Fix (Phase 1)

> **Plan:** Fix `_blockToPhpSpecJson` seal field bug — same root cause as `LedgerBackupService` fix (commit `becbf08`, unstaged)
> **Purpose:** Blueprint of all needed test assertions before writing test code
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

`LedgerPushService._blockToPhpSpecJson()` duplicates the PHPSPEC serialization logic from `LedgerBackupService._blockToPhpSpec()`. The backup service was fixed (29/29 tests, Groups A–E), but the push service was **not** — it still has the same two bugs:

1. **Seal field = identitySeal instead of blockId** (line 210): `sealField: block.identitySeal` should be `sealField: block.blockId`
2. **block_hash = identitySeal ?? blockId** (line 211): should be `block.blockId`
3. **Missing seal field names** (line 46-49): `_sealFieldNames` lacks `year_summary` → `year_hash` and `month_summary` → `month_hash`

The existing 40 push tests mask the bug because `_insertBlock()` helper defaults `identitySeal ?? blockId`, so the two values are always equal in test data.

## Test Groups

### Group I: Seal Field Serialization (blockId ≠ identitySeal) — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Genesis with blockId ≠ identitySeal: seal field (day_hash) = blockId | Verifies genesis seal field uses the block hash, not identity proof | Genesis is the most common case where identitySeal differs from blockId. Core bug. |
| I2 | Day block with blockId ≠ identitySeal: seal field (day_hash) = blockId | Verifies day block seal field uses block hash | Day blocks are the most frequent block type. |
| I3 | Year summary with blockId ≠ identitySeal: seal field (year_hash) = blockId | Verifies year_summary uses correct seal field name and value | The missing `_sealFieldNames` entry for year_summary means this would fail on field name AND value. |
| I4 | Month summary with blockId ≠ identitySeal: seal field (month_hash) = blockId | Verifies month_summary uses correct seal field name and value | Same as I3 — missing `_sealFieldNames` entry. |
| I5 | block_hash field = blockId regardless of identitySeal | Verifies the explicit block_hash convenience field | The block_hash field should always be the block's hash, not identitySeal. |
| I6 | identity_seal preserved as separate field when non-null | Verifies identity_seal is not lost during serialization | The fix must add identity_seal as a separate field (matching LedgerBackupService behavior). |
| I7 | identity_seal omitted when null | Verifies null identity_seal doesn't produce a null field in JSON | Contract: null fields should not be emitted. |
| I8 | All four block types round-trip push→deobfuscate→verify seal fields | Verifies end-to-end correctness for all block types | Integration test ensuring the full serialization → obfuscation → push → pull → deobfuscation chain preserves seal field values. |

### Group J: Hash Index Correctness — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | Hash index uses blockId when blockId ≠ identitySeal | Verifies the hash_index.json array contains block hashes, not identity seals | hash_index uses `block.blockId` (line 128), which is correct. This test verifies the contract stays correct after the fix. |
| J2 | Hash index contains blockId for all block types (genesis, day, year, month) | Verifies all block types contribute correct hash to index | The hash_index is used by the Worker and Python scripts for block discovery. |
| J3 | Hash index matches block_hash field in deobfuscated block JSON | Cross-verification that hash_index entries match the block_hash inside each pushed block | Consistency check: remote consumers should see the same hash in both places. |

### Group K: Entry Decoding (defense-in-depth) — ~2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | Block with data_enc as map `{"entries": [...]}` decodes entries correctly | Verifies the map-format decoding path | The push service recently changed from `as List` to map-first decoding. This path must stay correct. |
| K2 | Block with data_enc as legacy list `[...]` decodes entries correctly | Verifies backward-compatible list decoding | Legacy data formats must still be handled. |

## Summary

| Group | Tests | Coverage |
|-------|-------|----------|
| I | 8 | Seal field serialization (blockId vs identitySeal) |
| J | 3 | Hash index correctness |
| K | 2 | Entry decoding defense-in-depth |
| **Total** | **13** | |

**Key coverage gaps filled:**
- `blockId ≠ identitySeal` scenarios (entirely absent from current 40 tests)
- Missing `_sealFieldNames` entries for year_summary/month_summary
- identity_seal as separate field preservation
- Cross-verification of hash_index vs block_hash
