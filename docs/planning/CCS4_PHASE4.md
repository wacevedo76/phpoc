# CCS-4: Cross-Client E2E Testing — REFACTOR (Phase 4)

> **Plan:** `docs/planning/CCS4_PHASE1.md`, `docs/planning/CCS4_PHASE2.md`, `docs/planning/CCS4_PHASE3.md`
> **Purpose:** Improve code quality of the Phase 3 convergence changes without changing behavior.
> **Status:** ✅ Phase 4 (REFACTOR) complete — CCS-4 is done.

## Review scope

Phase 3 changed three source files to converge the seven genuine cross-client
divergences (A1–A5, A6-JS, C6). Phase 4 reviewed exactly those files against the
four criteria: modularity, clarity, security, conciseness.

| File | Phase 3 change |
|------|----------------|
| `domain/staging/row_merge.py` | Canonical compact `activity` JSON via `separators=(",", ":")` in `dtoToCanonicalRow` + `canonicalRowToDTO` |
| `phpoc-web/src/sync/entry_dto.js` | `canonicalRowToDTO` preserves `block_index` (`activity.block_index ?? null`) |
| `phpoc-web/src/sync/row_sync.js` | `mergeRows` deterministically sorts output by `activity_id` |

## Improvements

| # | Category | Change | Before → After |
|---|----------|--------|----------------|
| 1 | Clarity + Conciseness | **Extracted `_canonical_json()` helper** in `row_merge.py`. The magic tuple `separators=(",", ":")` was repeated at two call sites with no explanation. Now a module-level helper with a docstring capturing *why* compact is canonical (JS/Dart compact by default, feeds blob bytes + SHA-256, CCS-4 A1–A5). | `json.dumps(activity, separators=(",", ":"))` ×2 → `_canonical_json(activity)` ×2, single documented source of truth |

### Reviewed, no change needed

- **`entry_dto.js` `canonicalRowToDTO`**: the single-line `block_index: activity.block_index ?? null` now matches `rawEntryToDTO`'s `rawEntry.block_index ?? null`. Extracting further would add indirection for one line; DTO shapes for the two consumers are intentionally different (documented).
- **`row_sync.js` `mergeRows` sort**: the comparator is already minimal and matches Python `sorted` tie-consistent ordering. No higher-order helper justified for a single use.
- **Security**: no new input/error paths introduced; all functions remain pure, defensive (Null/empty safe), and deterministic. Compact serialization does not weaken validation or bounds checks.
- **Byte-parity constraint**: no key-sorting was added to `_canonical_json` because `JSON.stringify`/`json.encode` do **not** sort keys — sorting would break cross-client byte parity. Preserving insertion order is intentional.

## Files changed (Phase 4)

- `domain/staging/row_merge.py` — added `_canonical_json` helper + docstring; both call sites routed through it

## Verification

```bash
# CCS-4 Groups A–D (canonical parity still byte-identical after refactor)
PYTHONPATH=. .venv/bin/python -m pytest tests/test_ccs4_cross_client.py -q   # 20 passed

# Full Python suite — no regression
PYTHONPATH=. .venv/bin/python -m pytest tests/ -q                             # 2560 passed, 1 skip, 0 fail

# Web engine regressions
cd phpoc-web && node --test test/row_sync_test.mjs test/row_integration_test.mjs \
  test/entry_dto_committed_test.mjs test/hash_index_test.mjs \
  test/ccs2_row_level_reconcile_test.mjs                                      # 0 fail
```

All GREEN. Behavior unchanged — the canonical compact byte stream is byte-identical
before and after the helper extraction (pure refactor).

## Result

CCS-4 (Cross-Client E2E Testing) — **complete**: 24 assertions (Groups A–E), 20 pure
parity tests + 5 live Worker round-trips, all GREEN across Python, JS, and Flutter.
