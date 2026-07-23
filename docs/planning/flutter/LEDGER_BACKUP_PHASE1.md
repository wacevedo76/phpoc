# Ledger Backup (Export/Import) — Test Exploration (Phase 1)

> **Plan:** SESSION_HANDOFF.md §Immediate Next Steps
> **Purpose:** Blueprint of all needed test assertions for full ledger file backup.
> **Status:** ✅ Phase 1+2+3+4 complete (19 tests GREEN)
> **Next Phase:** — (complete)

## Architecture Overview

A new `LedgerBackupService` handles export and import of the full ledger chain.

**Export flow:**
1. Read all blocks via `BlockDao.getAllBlocks()` (ordered by `block_index ASC`)
2. Serialize each block to a JSON map with PHPSPEC-compliant field names
3. Write JSON array to a `.json` file (or return the bytes for the caller to save)

**Import flow:**
1. Parse JSON from `.json` file (or bytes)
2. Validate each block: required fields present, valid `block_type`, valid data types
3. Validate chain integrity: `block_index` monotonic, `prev_hash` links
4. In a transaction: clear existing `blocks` + `index_entries` tables, insert all blocks

**PHPSPEC block JSON format** (from §4):
- Common fields: `type`, `date`, `prev_hash`, `signature` (optional)
- Type-specific: `day_index`, `entries`, `day_hash` (day) | `year`, `year_hash` (year_summary) | `month`, `month_hash` (month_summary) | `identity`, `format_version`, `day_hash` (genesis)
- Our DB schema stores: `block_id`, `block_type`, `block_index`, `key_version`, `data_enc`, `identity_seal`, `prev_hash`, `created_at`

The backup service serializes DB rows to the canonical PHPSPEC JSON format. For MVP, it stores the raw `data_enc` blob and uses `identity_seal` as the block hash.

## Test Groups

### Group A: Export — ~7 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Export empty database returns `[]` (empty JSON array) | Graceful no-op for empty ledgers | Edge case — app with no blocks yet |
| A2 | Export single genesis block produces valid JSON with all fields | Core export correctness | Most basic export; genesis is always first block |
| A3 | Export multiple blocks (genesis + 2 day blocks) preserves block count and field values | Multi-block export correctness | Verifies array serialization for >1 block |
| A4 | Export maintains block order by `block_index` | Chain order preservation | The JSON array order must match the chain order — `block_index` is the canonical ordering |
| A5 | Export includes all block types (genesis, year, month, day) | Type coverage | Every block type must serialize correctly |
| A6 | Export handles blocks with null `identity_seal` gracefully | Nullable field handling | Day blocks and some summary blocks omit the seal |
| A7 | Exported JSON uses PHPSPEC-compliant field names | Format compliance | Export must use `type`, `prev_hash`, `data_enc` etc. (not internal column names) |

### Group B: Import — ~9 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Import empty JSON array is a no-op (no error, zero blocks) | Graceful no-op import | Should not throw; just results in no blocks |
| B2 | Import valid single-block JSON inserts the block correctly | Core import correctness | Most basic import; verifies JSON→DB mapping |
| B3 | Import multi-block JSON (genesis + 2 days) inserts all blocks with correct order | Multi-block import | Verifies batch insert and index ordering |
| B4 | Import preserves all block fields (block_id, block_type, block_index, key_version, data_enc, identity_seal, prev_hash, created_at) | Field fidelity | Every field must round-trip correctly |
| B5 | Import replaces existing blocks (clears old data before inserting) | Overwrite semantics | Import should be a restore, not a merge — old data must be cleared |
| B6 | Import with missing block clears index_entries as well | Index cleanup | Index entries reference blocks by block_id; stale index entries after import would be orphaned |
| B7 | Import rejects invalid JSON (malformed) with clear error | Input validation | Prevents partial imports on garbage input |
| B8 | Import rejects JSON with missing required fields (`type` or `prev_hash`) | Schema validation | Malformed blocks must be rejected before any DB write |
| B9 | Import rejects invalid `block_type` values | Type validation | Unknown block types must fail fast |

### Group C: Integration — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Round-trip: export → import → export produces identical JSON | Data integrity end-to-end | The ultimate validation — no data loss in the loop |
| C2 | Import preserves block count after replacing existing data | Count integrity | After import, DB count must match JSON count, not old+new |
| C3 | Import within a transaction — failure rolls back (no partial state) | Atomicity | Simulate a mid-import error; verify DB is unchanged |

**Total: 19 assertions across 3 groups.**

## Files to Create/Modify

| File | Purpose |
|------|---------|
| `lib/services/ledger_backup_service.dart` | New service: export/import logic |
| `test/services/ledger_backup_service_test.dart` | Unit tests (Groups A, B, C) |
| `lib/data/storage/providers.dart` | Add provider for LedgerBackupService |
| `lib/features/settings/settings_screen.dart` | Add backup/restore UI buttons |

## Dependencies

- `file_picker` (already added for Features 1 & 2)
- `BlockDao.getAllBlocks()`, `BlockDao.insertBlock()`, `BlockDao.getBlockCount()` (already exist)
- `IndexEntryDao.clearAllIndexEntries()` (already exists)
- `AppDatabase.customStatement()` for `DELETE FROM blocks` (already exposed)
