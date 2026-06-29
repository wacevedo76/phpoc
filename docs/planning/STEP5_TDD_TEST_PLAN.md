# Step 5: Export/Import Seal & Hash Mismatch — TDD Test Plan

> **Created:** 2026-06-28
> **Status:** ✅ GREEN — TDD complete (2026-06-28). 185/185 tests pass.
> **Parent task:** `SESSION_HANDOFF.md` Step 5

## Bug Summary

Two related bugs prevent export→import roundtrip:

1. **Entry hash mismatch**: `exportLedger()`/`exportLedgerFull()` preserve entry hashes as-is. But real entries from `LocalCache.append()` have hashes computed over a SUBSET of fields — missing `committed`, `block_index`, `entry_index`, `end_device_uuid` added later. On import, `importLedger()` re-validates over ALL fields (except `hash`) → mismatch.

2. **Seal mismatch**: `exportLedgerFull()` computes seal over `jsonSort({ ledger, staging })` — but `staging` from `readEntries()` includes `entry_index` (36 bytes for 2 entries). The import recomputes the seal identically (both use `jsonSort`), so seal passes when the data is self-consistent. But the entry hash failure (Bug 1) blocks import first.

**Observed evidence** (from `testdata/e2e_export.phpledger`):
- `jsonSort` of parsed JSON: 2104 bytes
- `jsonSort` with `entry_index` added: 2140 bytes (36 byte diff)
- The E2E file was created via eval (no `entry_index`), but the UI flow adds `entry_index`

## Fix Strategy

In `exportLedger()` and `exportLedgerFull()`: **recompute each staging entry's hash to cover ALL fields except `hash`** before computing the seal and writing the file.

```js
// Before: pass-through hashes as-is
payload.seal = crypto.seal(jsonSort(entries), masterKey);

// After: recompute hashes, then seal
const recomputed = entries.map(entry => {
  const { hash: _, ...hashData } = entry;
  return { ...entry, hash: crypto.sha256(jsonSort(hashData)) };
});
payload.seal = crypto.seal(jsonSort(recomputed), masterKey);
```

## Test Plan

All tests MUST FAIL (RED) before implementation. Run each test file individually:

```bash
cd phpoc-web
node test/<test_file>.mjs
```

---

### Group A — `ledger_export_test.mjs` (v1 staging-only export)

**File:** `phpoc-web/test/ledger_export_test.mjs`
**Existing:** ~14 tests (all must still pass as regression)
**New tests to add after the Error Handling section (before `// ── Summary`):**

#### A1 — Entry hash recomputation with extra fields
**Purpose:** Verify that entries with fields not covered by their original hash get hashes recomputed during export.

**Test data:** Two entries — one with `committed: false, block_index: null` added (like real entries from the app), one without extra fields. Both have pre-set hashes that cover only the core fields.

**Assertions (3):**
1. Entry 0 hash ≠ original pre-set hash (was recomputed to include `committed`, `block_index`)
2. Entry 1 hash = original pre-set hash (no extra fields, unchanged)
3. The seal is computed over the RECOMPUTED entries (verify by computing `jsonSort(recomputedEntries)` and comparing seal)

#### A2 — Deterministic recomputation
**Purpose:** Same entries → same recomputed hashes → same seal.

**Test data:** Export same entries twice.

**Assertions (2):**
1. Same entries exported twice → identical seals
2. Same entries exported twice → identical entry hashes (both recomputed identically)

---

### Group B — `ledger_export_full_test.mjs` (v2 full ledger export)

**File:** `phpoc-web/test/ledger_export_full_test.mjs`
**Existing:** ~15 tests (all must still pass as regression)
**New tests to add before `// ════════════════════════════════════════════════════` Summary section:**

#### B1 — Staging entry hash recomputation in v2
**Purpose:** Verify staging entries get hash recomputation; ledger blocks do NOT.

**Test data:** SAMPLE_STAGING entries modified to include `committed: false, block_index: null, entry_index: 0` (mimicking `readEntries()` output). SAMPLE_BLOCKS unchanged.

**Assertions (3):**
1. Staging entry 0 hash ≠ original `stg1hash...` (was recomputed)
2. Ledger block `day_hash` fields unchanged (blocks are NOT recomputed — only staging)
3. The v2 seal matches `crypto.seal(jsonSort({ ledger: blocks, staging: recomputedStaging }), mk)`

#### B2 — Seal covers recomputed staging
**Purpose:** The v2 seal must reflect the recomputed staging entries, not the originals.

**Test data:** Same as B1.

**Assertions (2):**
1. Seal computed with original staging hashes ≠ actual seal (proves recomputation happened)
2. Seal computed with recomputed staging hashes = actual seal (proves correct recomputation)

#### B3 — Empty staging unaffected
**Purpose:** Empty staging array should not cause errors during hash recomputation.

**Test data:** Blocks with empty staging `[]`.

**Assertions (1):**
1. Export succeeds with empty staging, seal is valid

---

### Group C — `ledger_roundtrip_test.mjs` (roundtrip)

**File:** `phpoc-web/test/ledger_roundtrip_test.mjs`
**Existing:** 46 tests in 13 groups (all must still pass as regression)
**New tests to add after Section 13 (before `// ═══════════════════════════════════════════`):**

#### C1 — Roundtrip with `readEntries()`-shaped entries (v1)
**Purpose:** The critical bug reproducer: export entries shaped like real `readEntries()` output (with `committed`, `block_index`, `entry_index`, `end_device_uuid`), then import them. This MUST fail without the fix, pass after.

**Test data:** Two entries built with `makeStagingEntry()` + overrides to add all the extra fields the app adds (`committed: false, block_index: null, entry_index: 0, end_device_uuid: 'dev-...'`). Use test helpers from existing file.

**Assertions (3):**
1. Export succeeds (returns Blob)
2. Import succeeds (no seal/hash error)
3. Imported entries match source entries exactly (including all extra fields)

#### C2 — Roundtrip with `readEntries()`-shaped entries (v2)
**Purpose:** Same as C1 but for v2 (full ledger export). Blocks + staging with extra fields.

**Test data:** SAMPLE_BLOCKS + staging entries with `committed`, `block_index`, `entry_index` added.

**Assertions (4):**
1. Export succeeds
2. Import succeeds
3. Staging entries match (including extra fields)
4. Ledger blocks match

#### C3 — Active entry with missing fields
**Purpose:** Active entries from `LocalCache.append()` have different shape than stopped entries (no `end_device_uuid`, `end_epoch: null`). Roundtrip should preserve these differences.

**Test data:** One active entry (no `end_device_uuid`, `end_epoch: null`) + one stopped entry (has `end_device_uuid`, `end_epoch`), both with `committed`, `block_index` added.

**Assertions (3):**
1. Active entry imported: `end_epoch` is null, no `end_device_uuid` key
2. Stopped entry imported: `end_epoch` is a number, `end_device_uuid` present
3. Import counts match

#### C4 — Single active entry from app flow (v2)
**Purpose:** Mimic the exact E2E export scenario that failed: 1 genesis block + 1 active staging entry + 1 stopped staging entry, with extra app fields.

**Test data:** One genesis block (SAMPLE_BLOCKS[0]) + 2 staging entries matching the shape from `testdata/e2e_export.phpledger` but with `committed`, `block_index`, `entry_index` fields as they would come from `readEntries()`.

**Assertions (4):**
1. Export v2 succeeds
2. Import succeeds (no errors)
3. Genesis hash extracted correctly
4. Both entries roundtripped with all fields intact

---

## What import tests do NOT need changes

- `ledger_import_test.mjs` — Uses `makeExportFile()` helper that computes hashes/seals inline (doesn't call `exportLedger()`). Not affected.
- `ledger_import_v2_test.mjs` — Uses `makeV2Blob()` helper same way. Not affected.
- `ledger_import_chain_test.mjs` — Tests raw chain import only. Not affected.

These serve as regression guards for the import path.

---

## Implementation Order (TDD)

1. **RED:** Write and run Group A tests → all new tests FAIL, existing ~14 PASS
2. **RED:** Write and run Group B tests → all new tests FAIL, existing ~15 PASS
3. **RED:** Write and run Group C tests → all new tests FAIL (or some error), existing 46 PASS
4. **GREEN:** Implement hash recomputation in `phpoc-web/src/services/ledger_export.js`
5. **GREEN:** Run all test files → all new tests PASS, all existing tests still PASS
6. Run `node test/ledger_roundtrip_test.mjs` for final verification

## Key Files

| File | Purpose |
|------|---------|
| `phpoc-web/src/services/ledger_export.js` | Contains `exportLedger()` and `exportLedgerFull()` — the fix target |
| `phpoc-web/src/services/ledger_import.js` | Import logic — should need NO changes |
| `phpoc-web/src/ledger/utils.js` | `jsonSort()` utility — used by both export and import |
| `phpoc-web/src/sync/local_cache.js` | `readEntries()` adds `entry_index` — source of extra fields |
| `phpoc-web/test/ledger_export_test.mjs` | Group A new tests here |
| `phpoc-web/test/ledger_export_full_test.mjs` | Group B new tests here |
| `phpoc-web/test/ledger_roundtrip_test.mjs` | Group C new tests here |
| `phpoc-web/test/mock_crypto.mjs` | MockCrypto with `seal()`, `verifySeal()`, `sha256()` |
| `phpoc-web/test/test_helpers.mjs` | `TestHelpers` class with `assert`, `assertEq`, `assertDeepEq`, `assertAsyncThrows` |

## Quick Start (next context)

```bash
cd /home/wacevedo/code/Testing/phpoc/phpoc-web
# 1. Run existing tests to confirm baseline
node test/ledger_export_test.mjs && echo "---" && \
node test/ledger_export_full_test.mjs && echo "---" && \
node test/ledger_roundtrip_test.mjs
# All should PASS (~75 tests total)

# 2. Write Group A, B, C tests (see above)
# 3. Run → new tests FAIL (RED)
# 4. Implement fix in src/services/ledger_export.js
# 5. Run → all tests PASS (GREEN)
```
