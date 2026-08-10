# Migrator Block-Seal Field Whitelist — REFACTOR (Phase 4)

> **Plan:** `docs/planning/CANONICAL_SEALFIELD_MIGRATOR_PHASE1.md`
> **Purpose:** Improve code quality of `phpoc_cli/migrate_format.py` without
> changing behavior. All 43 tests (incl. 26 seal-whitelist) stay GREEN.
> **Status:** ✅ Phase 4 (REFACTOR) complete
> **Task:** Ph-4 Migrator of `CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` — 4-phase TDD complete.

## Review criteria applied

Reviewed `_seal_block`, `_block_hash_key`, `_preserve_and_strip` (new), and
`execute()`'s three block-type branches against Modularity / Clarity / Security
/ Conciseness.

## Improvements

| # | Category | Change | File |
|---|----------|--------|------|
| 1 | **Conciseness / Modularity** | Extracted `_preserve_and_strip(block, hk)` helper to unify the **three** near-identical "save `original_hash` + pop all stale hash keys + pop `identity_seal`" loops that previously lived inline in the genesis / day / summary branches of `execute()`. | `phpoc_cli/migrate_format.py` |
| 2 | **Clarity** | Removed the never-sealed `hash_key` parameter from `_seal_block`. It was read only to gate the unknown-type `ValueError` and was **not** passed to `compute_seal` — a latent misnomer suggesting it affected sealing. `_seal_block(block, crypto)` now derives the gate from `_block_hash_key` itself, and Phase 2 calls it via the shared `compute_seal` route. | `phpoc_cli/migrate_format.py` |
| 3 | **Clarity / dedup with chain.py** | `_block_hash_key` switched from an if-chain to a single `dict.get(type)` table; docstring explains it is the intentional strict unknown-type gate and **deliberately does NOT** reuse `chain.py`'s `_hash_key_for_block` (which defaults to `day_hash` for unknown / I-17 legacy genesis). Reusing it would break the unknown-type rejection (E3/E4/F1/F2). The *sealer* itself was already deduped: `_seal_block` → `compute_seal` → `select_seal_fields` (the plan's "dedupe sealer shared with chain.py if applicable"). | `phpoc_cli/migrate_format.py` |
| 4 | **Conciseness** | Dropped the now-unused `old_day_hash` local in the day branch; provenance value is read directly by `_preserve_and_strip`. | `phpoc_cli/migrate_format.py` |

## Before / after (representative)

**Before (day branch):**
```python
old_day_hash = block.get("day_hash", "")
...
if old_day_hash:
    block["original_hash"] = old_day_hash
for hk in ("day_hash", "block_hash", "month_hash", "year_hash"):
    block.pop(hk, None)
block.pop("identity_seal", None)
```
**After (all three branches):**
```python
self._preserve_and_strip(block, self._block_hash_key(block))
```

## Behavior preserved

- `original_hash` is saved **before** any hash key is popped (still true — the
  helper reads `block.get(hk)` while the key is present).
- Every migrated block still produces exactly one canonical hash key and is
  re-sealed via `_seal_block` → `compute_seal`.
- Unknown block type still raises `ValueError` in both `_seal_block` and the
  pre-validation loop; a failed migration remains a byte-identical no-op.
- **No new regressions.** `chain.verify()` on a migrated multi-type ledger still
  passes; tampered seal / excluded-field mutation semantics unchanged.

## Verification

```bash
# Migrate-format whole file — 43 passed (incl. 26 seal-whitelist)
PYTHONPATH=. .venv/bin/python -m pytest tests/test_migrate_format.py      # 43 passed

# Full Python suite — no regression (matches Ph-3 baseline)
PYTHONPATH=. .venv/bin/python -m pytest tests/                            # 2586 passed, 1 skipped, 0 failed
```

## Files changed (Phase 4 REFACTOR)

- `phpoc_cli/migrate_format.py` — `_seal_block` signature + `_block_hash_key`
  table + new `_preserve_and_strip` helper; three `execute()` branches simplified.
- `docs/planning/CANONICAL_SEALFIELD_MIGRATOR_PHASE4.md` — this document.

## Closeout

### ✅ 4-Phase TDD Complete: Ph-4 Migrator (Canonical Seal-Field)
- **Phase 1:** 26 assertions blueprinted → `docs/planning/CANONICAL_SEALFIELD_MIGRATOR_PHASE1.md`
- **Phase 2:** 2 RED (F1/F2 unknown-type corrupting write) + 24 locks → `tests/test_migrate_format.py` `TestMigrateFormatSealWhitelist`
- **Phase 3:** `execute()` pre-validation → unknown-type rejected before write; 26/26 GREEN
- **Phase 4:** 4 improvements → `docs/planning/CANONICAL_SEALFIELD_MIGRATOR_PHASE4.md`
- Full Ph-4 Migrator task complete; Ready for Ph-5 (PHPSPEC) / Ph-6 (vectors) / Ph-7 (phone e2e).
