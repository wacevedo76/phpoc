# Canonical Ledger Format — Phase 1: Test Plan

> **Purpose:** Describe every test to be written/modified for the canonical
> ledger format rework. This document guides Phase 2 (test creation, RED phase)
> and Phase 3 (implementation, GREEN phase). Not to be edited after Phase 2
> begins — refer to SESSION_HANDOFF.md for status tracking.
>
> **Related:** I-07 (format_version in seal), I-17 (day_hash naming)
> **Decision:** Option B — full chain rewrite, no backward compat shims.

---

## Scope

Three changes landing in a single migration:

| # | Change | What |
|---|--------|------|
| 1 | **I-07 fix** | `format_version` excluded from block seal computation and removed from block data |
| 2 | **I-17 fix** | Genesis block hash field renamed `day_hash` → `block_hash` |
| 3 | **Migration command** | `ph migrate` rewrites the chain with new seals |

`format_version` remains in the export **envelope** (`ledger_export.js` v1/v2
wrapper) — that's a separate concern from the ledger block format. Export tests
are unaffected.

---

## Files Touched (Source)

### Python

| File | Changes |
|------|---------|
| `core/factory.py` | `buildGenesisBlock`: remove `format_version` field; rename `day_hash` → `block_hash` |
| `domain/ledger/chain.py` | Sealing: exclude `format_version` from seal data. Verification: handle `block_hash` on genesis. |
| `domain/ledger/merge.py` | `_verify_block_data`: use `block_hash` for genesis, exclude `format_version` |
| `security/auth.py` | `_verify_cached_key`: use `block_hash` for genesis |
| `cli/onboarding_file.py` | `_validate_raw_chain`: use `block_hash` for genesis, exclude `format_version` |
| `domain/ledger/remote_sync.py` | Pull verification: same as chain.py |
| `main.py` | New `ph migrate` subcommand |
| `cli/migrate.py` (new) | Migration logic: read chain, strip `format_version`, recompute all seals, fix prev_hash links, rename genesis hash field, save |

### JavaScript

| File | Changes |
|------|---------|
| `phpoc-web/src/ledger/chain.js` | `buildGenesisBlock`: remove `format_version`, rename `day_hash` → `block_hash`. `_verifyBlockData` + `verify`: use `block_hash` for genesis, exclude `format_version`. |
| `phpoc-web/src/ledger/merge.js` | `_verify_block_data`: same changes |
| `phpoc-web/src/sync/genesis_gate.js` | Genesis verification: `block_hash` for genesis |
| `phpoc-web/src/services/ledger_import.js` | `_importRawChain` / `_validateRawChain`: `block_hash` for genesis, exclude `format_version` from seal check |

### Shared

| File | Purpose |
|------|---------|
| `testdata/canonical_test_vectors.json` (new) | Shared test fixtures used by both Python and JS test suites |

---

## Test Inventory

### Group A — Genesis Block Creation (NEW: A1–A4)

Tests that genesis blocks are built correctly under the new rules.

#### Python: `tests/test_migration.py` (new file)

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **A1** | `test_genesis_no_format_version` | Genesis block dict does not contain key `format_version` | Field removed entirely — it's metadata, not block data |
| **A2** | `test_genesis_uses_block_hash` | Genesis block has `block_hash` (64 hex chars), does NOT have `day_hash` | I-17: uniform hash field naming across all block types |
| **A3** | `test_genesis_seal_excludes_format_version` | Recomputing the seal with `format_version` excluded from check data produces the stored `block_hash` | Seal integrity is correct — `format_version` is not part of the computation |
| **A4** | `test_genesis_block_hash_chain` | Day block 1's `prev_hash` matches genesis `block_hash` | prev_hash chain links correctly using new field name |

#### JavaScript: `phpoc-web/test/ledger_chain_test.mjs` (modify existing)

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **A1-js** | Genesis block has no `format_version` after `buildGenesisBlock()` | `genesis.format_version === undefined` | Same as A1, JS side |
| **A2-js** | Genesis uses `block_hash` not `day_hash` | `typeof genesis.block_hash === 'string' && genesis.block_hash.length === 64 && genesis.day_hash === undefined` | Same as A2, JS side |

---

### Group B — Block Seal Computation (NEW: B1–B5)

Tests that seals are deterministic and defined without `format_version`.

#### Shared: `testdata/canonical_test_vectors.json` (new file)

Provides identical test inputs for both Python and JS suites. Each test vector
is a block dict (without hash field) + the expected seal hex.

| Vector | Block type | Description |
|--------|-----------|-------------|
| V-genesis | genesis | Minimal genesis block |
| V-day | day | Day block with 1 entry |
| V-month | month_summary | Month summary block |
| V-year | year_summary | Year summary block |
| V-empty-day | day | Day block with no entries |

#### Python: `tests/test_migration.py`

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **B1** | `test_seal_vector_genesis` | `crypto.seal(jsonSort(genesis_data)) == expected_seal` from shared vectors | Deterministic seal for genesis |
| **B2** | `test_seal_vector_day` | Same for day block | Deterministic seal for day |
| **B3** | `test_seal_vector_month` | Same for month_summary | Deterministic seal for month_summary |
| **B4** | `test_seal_vector_year` | Same for year_summary | Deterministic seal for year_summary |
| **B5** | `test_format_version_not_in_seal_data` | Adding `format_version: "anything"` to a block does NOT change its seal | format_version is excluded from seal computation — proves it's truly metadata |

#### JavaScript: `phpoc-web/test/ledger_chain_test.mjs`

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **B1-js** | `test_seal_vector_genesis` | JS `seal(jsonSort(genesis_data))` matches shared vector expected_seal | Cross-client parity for genesis seal |
| **B2-js** | `test_seal_vector_day` | Same for day block | Cross-client parity for day seal |
| **B3-js** | `test_seal_vector_month` | Same for month_summary | Cross-client parity for month_summary seal |
| **B4-js** | `test_seal_vector_year` | Same for year_summary | Cross-client parity for year_summary seal |
| **B5-js** | `test_format_version_not_in_seal_data` | Same assertion as B5 | format_version excluded on JS side too |

---

### Group C — Chain Verification (NEW: C1–C5)

Tests that chain verification works correctly with the new format.

#### Python: `tests/test_migration.py`

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **C1** | `test_verify_new_chain` | `engine.verify()` returns `True` for a chain built entirely with new rules | Full chain verification passes with `block_hash` on genesis, no `format_version` |
| **C2** | `test_verify_prev_hash_chain` | Each block's `prev_hash` equals previous block's `block_hash`/`month_hash`/`year_hash` | Chain linkage verified correctly with new genesis hash field |
| **C3** | `test_verify_seal_integrity` | All block seals verify correctly against their check data (excluding hash key + signature) | Per-block seal verification unchanged except field name on genesis |
| **C4** | `test_migrated_chain_verifies` | Chain migrated via `ph migrate` passes `verify()` | Migration produces a valid chain |
| **C5** | `test_verify_day_block_entries` | Entry hashes inside day blocks still verify correctly after migration | Entry data untouched by migration — no regressions |

#### JavaScript: `phpoc-web/test/ledger_chain_test.mjs`

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **C1-js** | `test_verify_new_chain` | `chain.verify()` returns `true` for chain built with new rules | Same as C1, JS side |
| **C2-js** | `test_verify_block_data_genesis` | `_verifyBlockData(genesis, 0)` returns `true` with `block_hash` | Genesis block verification uses correct hash field |
| **C3-js** | `test_verify_block_data_day` | `_verifyBlockData(dayBlock, 1)` returns `true` | Day block verification unchanged |
| **C4-js** | `test_migrated_chain_verifies` | Same as C4, JS side | If web does local migration |

---

### Group D — Migration Command (NEW: D1–D8)

Tests for the `ph migrate` command.

#### Python: `tests/test_migration.py`

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **D1** | `test_migrate_strips_format_version` | After migration, no block contains `format_version` key | Field removed from all blocks |
| **D2** | `test_migrate_renames_genesis_hash` | Genesis block has `block_hash`, no `day_hash` | I-17 rename applied |
| **D3** | `test_migrate_recomputes_all_seals` | Every block's seal is different from pre-migration seal | format_version was in old seal → excluding it changes every seal |
| **D4** | `test_migrate_fixes_prev_hash_chain` | After migration, block N's `prev_hash` == block N-1's hash field | Chain linkage is correct post-migration |
| **D5** | `test_migrate_preserves_entry_data` | Entry hashes and data unchanged after migration | Migration touches blocks, not entries |
| **D6** | `test_migrate_preserves_identity` | Genesis identity fields unchanged (`identity_pub_key`, `recovery_seed_enc`, etc.) | Identity data is not part of seal change — must survive |
| **D7** | `test_migrate_creates_backup` | Original `ledger.json` copied to `ledger.json.bak` before migration | Safety net — user can revert |
| **D8** | `test_migrate_noop_on_already_migrated` | Running migrate on an already-migrated chain is idempotent (no-op or clean exit) | Safety — double migration doesn't corrupt |

---

### Group E — Auth Verification After Migration (NEW: E1–E2)

Tests that `ph login` still works after migration.

#### Python: `tests/test_migration.py`

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **E1** | `test_verify_cached_key_post_migration` | `_verify_cached_key(key)` returns `True` after migration | Auth uses genesis seal to verify cached key — must use `block_hash` now |
| **E2** | `test_authenticate_post_migration` | `authenticate()` succeeds with correct passphrase after migration | Full auth flow works with new genesis hash field |

---

### Group F — Import After Migration (MODIFY: F1–F3)

Tests that importing a migrated chain works.

#### Python: `tests/test_onboarding_e2e.py` (modify existing)

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **F1** | `test_import_migrated_chain` | `ph onboarding file` imports a migrated chain successfully | Import validation uses `block_hash` for genesis |
| **F2** | `test_import_rejects_old_chain` | Importing a pre-migration chain (format_version in block) raises a clear error | Old chain seals are invalid under new verification — user should migrate first |

#### JavaScript: `phpoc-web/test/ledger_import_chain_test.mjs` (modify existing)

| ID | Test | Assertion | Rationale |
|----|------|-----------|-----------|
| **F2-js** | `test_import_migrated_chain` | `_importRawChain(migratedBlocks)` returns validated result with `genesisHash = genesis.block_hash` | JS import works with migrated chains |
| **F3-js** | `test_import_old_chain_rejects` | Importing pre-migration raw chain (format_version in blocks) fails seal verification | Old seals invalid under new rules — clear error |

---

### Group G — Existing Test Modifications

Tests that currently use `format_version` in block fixtures or assert its presence
in genesis blocks. These must be updated to use the new format.

#### Python: `tests/test_ledger_merge.py` (3 refs)

| ID | Current | Change |
|----|---------|--------|
| G1 | Genesis fixture has `format_version: "0.3.0"` (lines 234, 1154, 1392) | Remove `format_version`, add `block_hash` |
| G2 | Merge tests assert genesis seal | Recompute expected seals without format_version |

#### Python: `tests/test_phase6b_ledger_equivalence.py` (1 ref)

| ID | Current | Change |
|----|---------|--------|
| G3 | Genesis fixture: `{"type": "genesis", "created_at": ..., "format_version": "0.4.0"}` | Remove `format_version` |

#### JavaScript: `phpoc-web/test/genesis_gate_test.mjs` (4 refs)

| ID | Current | Change |
|----|---------|--------|
| G4 | `format_version = '0.3.0'` passed to genesis builders | Remove parameter, update seal expectations |
| G5 | C2 test: "format_version mismatch → genesis_mismatch" | Remove or repurpose — no longer tests anything meaningful since format_version isn't in seal |

#### JavaScript: `phpoc-web/test/ledger_merge_test.mjs` (3 refs)

| ID | Current | Change |
|----|---------|--------|
| G6 | Genesis fixtures have `format_version: '0.3.0'` | Remove, add `block_hash` |

#### JavaScript: `phpoc-web/test/sync_service_test.mjs` (3 refs)

| ID | Current | Change |
|----|---------|--------|
| G7 | Block fixtures with `format_version` | Remove from all fixtures |

#### JavaScript: `phpoc-web/test/hash_index_test.mjs` (1 ref)

| ID | Current | Change |
|----|---------|--------|
| G8 | Genesis fixture: `format_version: '0.3.0'` | Remove |

#### JavaScript: `phpoc-web/test/commit_push_integration_test.mjs` (3 refs)

| ID | Current | Change |
|----|---------|--------|
| G9 | `format_version: 1` in test data | Remove |

#### JavaScript: `phpoc-web/test/ledger_sync_test.mjs` (3 refs)

| ID | Current | Change |
|----|---------|--------|
| G10 | `format_version: 1` in fixtures + assert `format_version preserved` | Remove field, remove assertion |

#### JavaScript: `phpoc-web/test/worker_connect_onboarding_test.mjs` (4 refs)

| ID | Current | Change |
|----|---------|--------|
| G11 | Genesis `format_version: '0.3.0'`, assertion `format_version === '0.3.0'`, C4 "missing format_version" test | Remove field, remove assertion, remove/repurpose C4 test |

#### JavaScript: Additional files

| File | Refs | Change |
|------|------|--------|
| `worker_connect_blocks_format.test.mjs` | 1 | Remove `format_version` from fixture |
| `onboarding_cloud_conflict.test.mjs` | 1 | Remove `format_version` from fixture |
| `settings_genesis_test.mjs` | 1 | Remove `format_version` from parameter |
| `settings_genesis_component.test.mjs` | 1 | Remove `format_version` from parameter |

---

## Test Summary

| Group | New Tests | Modified Tests | Total Net |
|-------|-----------|---------------|-----------|
| A — Genesis creation | 6 (4 PY + 2 JS) | 0 | +6 |
| B — Seal computation | 10 (5 PY + 5 JS) | 0 | +10 |
| C — Chain verification | 9 (5 PY + 4 JS) | 0 | +9 |
| D — Migration command | 8 (8 PY) | 0 | +8 |
| E — Auth verification | 2 (2 PY) | 0 | +2 |
| F — Import | 4 (2 PY + 2 JS) | 0 | +4 |
| G — Existing fixture updates | 0 | ~14 files, ~25 fixture edits | 0 (count unchanged) |
| **Total** | **40 new tests** | **~25 fixture updates** | **+40** |

### Files Created
- `tests/test_migration.py` (~22 tests)
- `testdata/canonical_test_vectors.json`

### Files Modified (source)
- 8 Python files (5 modified + 1 created + shared vectors)
- 4 JavaScript files
- 1 shared file

### Files Modified (tests)
- Python: 4 files (test_migration new, test_ledger_merge, test_phase6b, test_onboarding_e2e)
- JavaScript: ~14 files with format_version fixture updates

---

## Phase Boundaries

| Phase | What | Output |
|-------|------|--------|
| **Phase 1** (this doc) | Test descriptions with assertions + rationale | `docs/planning/CANONICAL_LEDGER_FORMAT_TESTS.md` |
| **Phase 2** | Write all tests (RED) | ✅ DONE (2026-07-03). 40 tests written, 16 RED failures, 9 skipped (migrate module). |
| **Phase 3** | Write source code (GREEN) | All tests pass |
| **Phase 4** | Code review + refactor | Modularity, readability, security, efficiency review |

## Canonical Format Specification

After this rework, a canonical ledger block has:

```json
{
  "type": "genesis",
  "block_hash": "<64 hex chars>",
  "day_index": 0,
  "date": "2026-07-03",
  "identity": { ... },
  "prev_hash": "0000...0000",
  "entries": [],
  "signature": "<64 hex chars>"
}
```

- `block_hash` is the uniform seal field for all block types (genesis, day, month_summary, year_summary)
- `format_version` is absent from block data entirely
- `signature` is excluded from seal computation (already aligned, Bug 4)
- `prev_hash` links to previous block's `block_hash` (for genesis, it links to previous block's hash regardless of block type)
- Entry format unchanged: `{hash, data: {field_enc: "...", ...}}` per PHPSPEC §3.1.1
