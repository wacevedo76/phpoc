# Store Adapters — Test Exploration (Phase 1)

> **Plan:** Root-cause fix for prev_hash mismatch
> **Purpose:** Blueprint of all needed test assertions for `LedgerBlockStore` block-type mapping.
> **Status:** ✅ Complete (4 phases)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

`LedgerBlockStore` (`store_adapters.dart`) marshals between chain-format block maps
(`type: "year_summary"`, `year_hash: …`) and `Block` database rows
(`blockType: BlockType.year`, `blockId: …`).

**The bug:** `_deriveBlockType()` uses `BlockType.values.asNameMap()` which produces
camelCase keys (`"year"`, `"month"`) but the JSON uses snake_case (`"year_summary"`,
`"month_summary"`). Summary blocks fall through to `BlockType.day`, and
`_deriveBlockId()` then looks for `day_hash` instead of `year_hash`/`month_hash`,
returning an empty string.

**Fix area:** `_deriveBlockType()` — replace `asNameMap()` with explicit snake_case → enum mapping.

## Test Groups

### Group V: Block Type Derivation — ~4 tests

Test `_deriveBlockType` indirectly through `appendBlocks` → `readBlocks` roundtrip.
Verify each block type is stored and read back with the correct `BlockType`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| V1 | Genesis block (type="genesis") → DB row blockType=genesis | Verify genesis is correctly classified | Regression guard — currently works |
| V2 | Day block (type="day") → DB row blockType=day | Verify day blocks correctly classified | Regression guard — currently works |
| V3 | Year-summary block (type="year_summary") → DB row blockType=year | Verify year_summary maps to BlockType.year | **THE BUG** — currently maps to `day` |
| V4 | Month-summary block (type="month_summary") → DB row blockType=month | Verify month_summary maps to BlockType.month | **THE BUG** — currently maps to `day` |

### Group W: Block ID Derivation — ~4 tests

Verify `_deriveBlockId` extracts the correct hash field for each block type.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| W1 | Genesis → block_id = block_hash value | block_hash used as DB blockId | Roundtrip: genesis.day_hash preserved |
| W2 | Day → block_id = day_hash value | day_hash used as DB blockId | Currently works for day blocks |
| W3 | Year-summary → block_id = year_hash value | year_hash used as DB blockId | **THE BUG** — looks for `day_hash` instead |
| W4 | Month-summary → block_id = month_hash value | month_hash used as DB blockId | **THE BUG** — looks for `day_hash` instead |

### Group X: Reconstructed Map Integrity — ~4 tests

Verify `_blockToMap` overlays the correct hash key for each block type after
the roundtrip through the database.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| X1 | Genesis roundtrip: map has block_hash = block_id, identity_seal preserved | Full genesis roundtrip integrity | Check overlay doesn't clobber fields |
| X2 | Day roundtrip: map has day_hash = block_id | Day roundtrip integrity | Check overlay sets correct hash key |
| X3 | Year-summary roundtrip: map has year_hash = block_id, type="year_summary" | Year-summary roundtrip integrity | **THE BUG** — type overwritten to "day" |
| X4 | Month-summary roundtrip: map has month_hash = block_id, type="month_summary" | Month-summary roundtrip integrity | **THE BUG** — type overwritten to "day" |

### Group Y: Missing/Unknown Type Fallback — ~2 tests

Verify graceful degradation for unrecognized or missing type fields.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| Y1 | Missing type field → defaults to BlockType.day | Graceful fallback for corrupt data | Don't crash on malformed blocks |
| Y2 | Unknown type string → defaults to BlockType.day | Graceful fallback for future types | Forward-compatible with new block types |

## Summary

| Group | Tests | Status |
|-------|-------|--------|
| V — Type Derivation | 4 | 2 pass now (V1, V2); 2 fail (V3, V4) |
| W — Block ID Derivation | 4 | 2 pass now (W1, W2); 2 fail (W3, W4) |
| X — Map Reconstruction | 4 | 2 pass now (X1, X2); 2 fail (X3, X4) |
| Y — Fallback | 2 | Both likely pass already |
| **Total** | **14** | **10 pass, 4 fail (V3, V4, W3/W4, X3/X4)** |
