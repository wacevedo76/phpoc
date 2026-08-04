# Canonical Ledger Format — Phase 4 Refactor Recommendations

> **Purpose:** Actionable refactoring recommendations from the Phase 4 code review
> of the I-07 / I-17 canonical ledger format changes. Each recommendation includes
> priority, effort estimate, and affected files.
>
> **Review date:** 2026-07-03
> **Reviewer:** Automated code review (pi agent)
> **Scope:** 13 Python files + 5 JS files changed in Phase 3

---

## Summary

| # | Recommendation | Priority | Effort | Status |
|---|---------------|----------|--------|--------|
| 1 | Add post-migration self-verification to `migrate_chain()` | 🔴 High | S (~15 lines) | ✅ |
| 2 | Extract shared `_get_block_hash()` to `domain/ledger/helpers.py` | 🟡 Medium | M (~8 files) | ✅ |
| 3 | Extract `_hash_key_for_block()` helper in `chain.py` | 🟢 Low | S (~8 lines) | ✅ |
| 4 | Rename `_get_hash_key` → `_hash_key_for_block_type` in `migrate.py` | 🟢 Low | S (~3 lines) | ✅ |
| 5 | Document `_verifyBlockData` duplication between JS `chain.js` and `merge.js` | 🟢 Low | S (comment only) | ✅ |

---

## 1. 🔴 HIGH — Add post-migration self-verification to `migrate_chain()`

**File:** `phpoc_cli/migrate.py`

**Problem:** `migrate_chain()` recomputes all seals, fixes prev_hash links, then writes
the result without verifying the output chain. A bug in seal computation (e.g., wrong
integrity key derivation) would silently produce an invalid chain; the user would only
discover the problem when trying to verify later.

**Fix:** After step 6 (recompute seals for blocks 1+), add a `_verify_migrated_chain()`
that checks:
- (a) No `format_version` key exists in any block
- (b) Genesis block has `block_hash` (not `day_hash`)
- (c) Every block's seal verifies against its check data (excluding hash key + signature)
- (d) `prev_hash` chain linkage is correct across all blocks

**Estimated lines:** ~15 (actual: ~55 with full error messages and tests)

**Status:** ✅ Implemented (2026-07-03). `_verify_migrated_chain()` added to `phpoc_cli/migrate.py`,
called at step 7 before writing output. 5 new tests in Group G of `tests/test_migration.py`.

---

## 2. 🟡 MEDIUM — Extract shared `_get_block_hash()` to `domain/ledger/helpers.py`

**Files affected:** `remote_sync.py`, `merge.py`, `chain.py`, `migrate.py`, `onboarding_file.py`,
`summary_policy.py`, `orchestrator.py`

**Problem:** The same function — `_get_block_hash(block)` returning `block.get("block_hash")
or block.get("day_hash") or block.get("month_hash") or block.get("year_hash")` — is defined
or inlined in **8 different locations** across the Python codebase:

| File | Location | Form |
|------|----------|------|
| `domain/ledger/remote_sync.py:353` | Static method `_get_block_hash()` | Method |
| `domain/ledger/merge.py:282` | Static method `_get_block_hash()` | Method |
| `domain/ledger/chain.py:~220` | Inline expression in `append_blocks()` and `verify()` | Inline |
| `domain/ledger/summary_policy.py:94` | Inline expression | Inline |
| `phpoc_cli/migrate.py:55` | Module-level function | Function |
| `phpoc_cli/onboarding_file.py` | Inline via `BLOCK_HASH_FIELD` dict approach | Dict lookup |
| `core/sync/orchestrator.py:505` | Inline expression | Inline |
| `compat/v0_3_0.py` | Inline expression (in `sync_day_with_selection`, `sync_day`) | Inline |

**Fix:** Create `domain/ledger/helpers.py` with:

```python
def get_block_hash(block: dict) -> str:
    """Return the canonical hash value for a block irrespective of type."""
    return (
        block.get("block_hash")
        or block.get("day_hash")
        or block.get("month_hash")
        or block.get("year_hash")
        or ""
    )
```

Then import and use in all 8 files. The JS side already has this in `utils.js:getBlockHash()`.

**Estimated effort:** Medium — touch ~8 files, each change is a 1-line import + search/replace.

**Status:** ✅ Implemented (2026-07-03). Created `domain/ledger/helpers.py` with `get_block_hash(block)`.
Updated 9 source files:
- `phpoc_cli/migrate.py` — replaced module-level `_get_block_hash()`
- `domain/ledger/remote_sync.py` — replaced static method `_get_block_hash()`
- `domain/ledger/merge.py` — replaced static method `_get_block_hash()`
- `domain/ledger/summary_policy.py` — replaced `_get_prev_hash()`
- `domain/ledger/chain.py` — replaced 4 inline patterns in `append_blocks()`, `verify()`, `verify_block()`
- `core/sync/orchestrator.py` — replaced `RemoteLedgerSync._get_block_hash()` + 2 inlines in `_is_same_genesis()`
- `phpoc_cli/onboarding_file.py` — replaced 3 inline patterns
- `phpoc_cli/onboarding.py` — replaced 1 inline pattern
- `domain/ledger/engine.py` — replaced 2 inline patterns
12 new unit tests in `tests/test_ledger_helpers.py` (Groups A+B).
**Deferred:** `compat/v0_3_0.py` (COLD compat layer — 6 sites left as-is).

---

## 3. 🟢 LOW — Extract `_hash_key_for_block()` helper in `chain.py`

**File:** `domain/ledger/chain.py`

**Problem:** The hash key determination logic (which field name holds the block's seal:
`block_hash`, `day_hash`, `month_hash`, or `year_hash`) is implemented as a 6-line ternary
chain in both `verify()` (line 284–293) and `verify_block()` (line 338–347). This is duplicated
and hard to read.

**Fix:** Extract to a private helper:

```python
@staticmethod
def _hash_key_for_block(block: dict) -> str:
    """Return the hash field name for a block based on its type."""
    btype = block.get("type", "day")
    if btype == "genesis" and "block_hash" in block:
        return "block_hash"
    if btype == "genesis" and "day_hash" in block:
        return "day_hash"  # I-17 backward compat
    return {
        "day": "day_hash",
        "month_summary": "month_hash",
        "year_summary": "year_hash",
    }.get(btype, "day_hash")
```

This is the same logic currently in `verify()` and `verify_block()`, consolidated.
Note: this pattern is also duplicated across `merge.py`, `onboarding_file.py`, and `migrate.py`
— a broader extraction could follow recommendation #2.

**Estimated lines:** ~8 added, ~12 removed

**Status:** ✅ Implemented (2026-07-03). Added `LedgerChain._hash_key_for_block(block)` static
method. Replaced both duplicated ternary chains in `verify()` and `verify_block()`. 8 new tests
in `tests/test_phase3_ledger_engine.py` (Group H).

---

## 4. 🟢 LOW — Rename `_get_hash_key` → `_hash_key_for_block_type` in `migrate.py`

**File:** `phpoc_cli/migrate.py`

**Problem:** `_get_hash_key(block)` returns the *field name* (e.g., `"block_hash"`) while
`_get_block_hash(block)` returns the *hash value* (e.g., `"abc123..."`). The similar names
are confusing — `_get_hash_key` sounds like it could return either.

**Fix:** Rename to `_hash_key_for_block_type()` to clearly indicate the return value is a
field name string, not a hash value.

**Estimated lines:** ~3

**Status:** ✅ Implemented (2026-07-03). Renamed function definition + 3 call sites in
`phpoc_cli/migrate.py`. 5 new tests in `tests/test_migration.py` (Group H).

---

## 5. 🟢 LOW — Document `_verifyBlockData` duplication between JS `chain.js` and `merge.js`

**Files:** `phpoc-web/src/ledger/chain.js`, `phpoc-web/src/ledger/merge.js`

**Problem:** `LedgerChain._verifyBlockData()` (chain.js:308–356) and `LedgerMerge._verifyBlockData()`
(merge.js:194–239) are near-identical implementations of the same block verification logic.
They live in separate modules because `merge.js` is intentionally standalone (no `LedgerChain`
dependency), but the duplication means a bug fix in one might be missed in the other.

**Fix:** At minimum, add a cross-reference comment in both files:

```js
// NOTE: This logic is intentionally duplicated from chain.js:_verifyBlockData()
// because LedgerMerge is a standalone module. Keep both in sync.
```

Better: extract `_verifyBlockData` to `utils.js` as `verifyBlockData(block, crypto, masterKey,
identitySecret)` and import in both modules.

**Estimated lines:** ~3 (comment) or ~10 (extraction)

**Status:** ✅ Implemented (2026-07-03). Added cross-reference comments in both
`chain.js` and `merge.js` noting the intentional duplication and the need to keep both
in sync. Added 3 behavioral tests in `test/ledger_chain_test.mjs` (R5 group) verifying
both implementations produce identical results for genesis, valid day, and tampered blocks.

---

## Additional Notes

### Already Well-Handled

- **Backward compat for `day_hash`** is consistently implemented with `"block_hash" if "block_hash" in block else "day_hash"` fallback everywhere.
- **I-07 `format_version` exclusion** is uniformly applied in all seal check data construction with `k not in (hash_key, "signature", "format_version")`.
- **JS `verifySeal()` two-pass fallback** (Python-compatible `jsonSort` then compact JSON) in `chain.js:76-88` makes cross-platform verification robust.
- **Deep copy via `json.loads(json.dumps(chain))`** in `migrate.py` prevents input mutation.

### Noted But Deferred

- **`_seal()` in `migrate.py` bypasses `CryptoManager`** — uses raw `hmac.new()` directly.
  Intentional: the module is standalone to avoid importing the full security stack. Acceptable
  for a one-shot migration tool, but means future crypto upgrades won't apply to migration.
- **Full chain read into memory during `verify()`** — `read_all()` loads entire chain.
  Fine for current usage (chains rarely exceed 200 blocks). Would benefit from streaming
  `read_blocks(start, end)` for larger chains, but not needed now.
- **`_verify_entry_hash_flex` tries both serialization formats** — generous but intentional
  for cross-platform compatibility per Bug 3b (E2E cross-client fix).
