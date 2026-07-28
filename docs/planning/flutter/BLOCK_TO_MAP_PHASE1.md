# Store Adapters — Block Reconstruction (Phase 1)

> **Plan:** Fix `_blockToMap` type restoration for genesis + legacy summary blocks
> **Purpose:** Blueprint of all needed test assertions for fixing block type corruption on DB read-back.
> **Status:** ✅ Phase 2 (RED) — tests written, confirmed failing
> **Next Phase:** Phase 3 (GREEN: implementation)

## Architecture Overview

`store_adapters.dart` marshals between chain-format block maps and SQLite `Block` rows. The `_blockToMap` method reconstructs chain maps from DB rows by:

1. Decoding `data_enc` (base64 JSON) as the base
2. Overlaying DB-authoritative fields (`block_id`, `prev_hash`, `key_version`, `identity_seal`)
3. Defaulting missing `type` to `'day'`
4. Adding type-specific hash key from `b.blockId`

**One active bug remains in step 3:**

- **Bug A**: Genesis `data_enc` from `onboarding_service.dart` contains only `{"seed":"..."}` — no `type` field. When `_blockToMap` defaults type to `'day'` (step 3), the subsequent switch (step 4) correctly adds `block_hash` (because `b.blockType == BlockType.genesis`) — but `getBlockHash()` checks `type` first and hits the `case 'day'` branch, returning `day_hash ?? ''` (empty) instead of `block_hash`. **Confirmed RED: Z1, Z2, AA1, AA2 fail.**
- **Bug B** (legacy summary blocks): Already fixed by the prior `_blockToMap` change that no longer overwrites type from data_enc. The type survives the roundtrip and `getBlockHash()` resolves correctly. Z3–Z6 pass GREEN as regression coverage.

## Test Groups

### Group Z: `_blockToMap` Type Restoration — ~6 tests

Tests for `_blockToMap` reconstructing the correct `type` from a `Block` row, especially when `data_enc` is missing the type field or has it in snake_case.

> **Note:** Tests inject buggy `Block` rows directly into the fake DAO (bypassing `appendBlocks()`) to simulate the exact on-disk state from the bugs. The `_blockToMap` method is `static` and package-private, exercised via `LedgerBlockStore.readBlocks()`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| Z1 | Genesis with `data_enc` lacking `type` → `readBlocks()[0]['type']` = `'genesis'` | Genesis blocks from `onboarding_service.dart` (plain `{"seed":"..."}`) must read back as type `'genesis'` | Real-world genesis blocks created by the onboarding flow lack `type` in data_enc. When `getBlockHash()` fails on read-back, `chain.append()` skips prev_hash verification silently. |
| Z2 | Genesis with `data_enc` lacking `type` → `getBlockHash(readBlocks()[0])` returns `block_hash`, not empty | The block hash used for prev_hash linkage must resolve correctly for genesis blocks stored by the real onboarding flow | `getBlockHash()` resolves by type; if type is wrong, it looks up the wrong hash key. |
| Z3 | Year_summary stored with old bug (blockType=day, blockId="") → `readBlocks()[0]['type']` = `'year_summary'` | Legacy summary blocks with wrong SQL type/blockId must still read back with correct type from data_enc | **Regression guard** — Bug B already fixed; data_enc type survives the roundtrip. |
| Z4 | Year_summary stored with old bug → `getBlockHash(readBlocks()[0])` returns `year_hash` from data_enc | Legacy year_summary must provide correct hash for chain verification | **Regression guard** — `getBlockHash()` correctly resolves via type from data_enc. |
| Z5 | Month_summary stored with old bug (blockType=day, blockId="") → `readBlocks()[0]['type']` = `'month_summary'` | Same as Z3 for month_summary | **Regression guard** — symmetric with Z3. |
| Z6 | Month_summary stored with old bug → `getBlockHash(readBlocks()[0])` returns `month_hash` from data_enc | Same as Z4 for month_summary | **Regression guard** — symmetric with Z4. |

### Group AA: Full Chain Roundtrip with Legacy Blocks — ~3 tests

Tests for end-to-end chain operations with a mix of correctly-stored and legacy blocks.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| AA1 | Chain of genesis(no-type) → year_summary(legacy) → day: `getBlockHash()` returns non-empty for every block | Full chain with legacy blocks must resolve hashes for all block types | Equivalent to chain.verify() succeeding for prev_hash linkage (seal verification requires real crypto, tested separately in chain_test.dart). |
| AA2 | Chain of genesis(no-type) → year_summary(legacy) → day: `getBlockHash()` at each position matches expected value | Each block in a mixed chain must resolve its hash correctly | Individual hash resolution is the building block for chain verification. |
| AA3 | Appending to chain with legacy blocks: new day block's `prev_hash` equals `getBlockHash()` of previous block | New blocks appended after the fix must link correctly to legacy predecessors | Forward creation must work even when the chain contains buggy-format blocks. |

## Phase 2 Results (2026-07-28)

| Group | Tests | RED | GREEN |
|-------|------:|----:|------:|
| Z: Type Restoration | 6 | 2 (Z1, Z2) | 4 (Z3–Z6 regression) |
| AA: Full Chain Roundtrip | 3 | 2 (AA1, AA2) | 1 (AA3) |
| **Total** | **9** | **4** | **5** |

All 4 RED failures trace to Bug A: genesis data_enc without `type` → defaults to `'day'` → `getBlockHash()` returns empty. Z3–Z6 pass because Bug B was already fixed by the prior `_blockToMap` change that no longer overwrites type from data_enc.

## Summary

| Group | Tests | Key Coverage |
|-------|------:|--------------|
| Z: Type Restoration | 6 | Genesis type inference (RED), legacy summary regression (GREEN) |
| AA: Full Chain Roundtrip | 3 | Hash resolution (RED for genesis), prev_hash linkage (GREEN) |
| **Total** | **9** | |

## Implementation Notes

The fix for `_blockToMap` should:
1. **Move type resolution before the default**: If `b.blockType == BlockType.genesis`, set `type: 'genesis'` regardless of data_enc contents
2. **Only default missing type for non-genesis**: When data_enc lacks `type`, default to `'genesis'` for genesis rows, `'day'` for everything else
3. **Ensure hash key overlay happens AFTER type resolution**: The switch that adds `block_hash`/`day_hash`/`year_hash`/`month_hash` must run with the correct type already set

For `onboarding_service.dart`:
- Include `'type': 'genesis'` in the genesis data_enc JSON (defense-in-depth)
