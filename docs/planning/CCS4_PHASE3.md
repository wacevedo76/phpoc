# CCS-4: Cross-Client E2E Testing — GREEN (Phase 3)

> **Plan:** `docs/planning/CCS4_PHASE1.md`, `docs/planning/CCS4_PHASE2.md`
> **Purpose:** Implement the fixes the RED suite surfaced so the seven genuinely
> RED assertions converge onto byte-identical cross-client formats.
> **Status:** ✅ Phase 3 (GREEN: implementation) complete
> **Next Phase:** ✅ Phase 4 (REFACTOR) complete — `CCS4_PHASE4.md`

## Convergence summary

Phase 2 (RED) surfaced **7 genuine cross-client divergences** (A1–A5, A6-JS,
C6) plus **1 latent claim** (B2) that turned out to be factually incorrect
(no real Flutter divergence). Phase 3 converged all of them.

| ID | Divergence | Fix (this phase) | Result |
|----|-----------|------------------|--------|
| A1–A5 | Python `dtoToCanonicalRow` emits `activity` via `json.dumps` **default-spaced** (`", "` / `": "`); JS `JSON.stringify` **compact** → byte-different `activity` string | `domain/staging/row_merge.py`: both `json.dumps(activity)` calls (dtoToCanonicalRow + canonicalRowToDTO) → `separators=(",", ":")` for canonical **compact** serialization | Byte-identical. Python: 2475→**2560 passed / 1 skip / 0 fail** (no regression) |
| A6-JS | JS `canonicalRowToDTO` hard-codes `block_index: null` and drops the canonical `block_index` on round-trip (data loss) | `phpoc-web/src/sync/entry_dto.js`: `block_index: activity.block_index ?? null` (read back from parsed activity JSON) | JS round-trip preserves `block_index`; A6-JS now GREEN |
| C6 | JS `mergeRows` returns insertion (map) order; Python `merge_rows` sorts by `activity_id` → non-deterministic cross-client merge bytes | `phpoc-web/src/sync/row_sync.js`: sort merged output by `activity_id` before returning (PHPSPEC §8.5) | Web `mergeRows` output byte-identical to Python `merge_rows` |
| B2 | Phase-2 doc claimed Flutter `computeHash` (`json.encode`) diverges (default-spaced) from Python compact hash | **Verified FALSE empirically:** Dart `json.encode` is compact → `[{"activity_id":"t1","activity_status":"paused"},…]` is byte-identical to Python `json.dumps(..., separators=(",",":"), sort_keys=True)`. No Flutter code change needed; corrected the misleading test comment/simulation | **No real divergence.** Flutter + Python + JS already produce the same canonical SHA-256. Flutter suite GREEN (8/8 hash-index tests) |

## Files changed (Phase 3 GREEN)

| File | Change |
|------|--------|
| `domain/staging/row_merge.py` | `json.dumps(activity, separators=(",", ":"))` in both `dtoToCanonicalRow` and `canonicalRowToDTO` (compact canonical `activity` JSON) |
| `phpoc-web/src/sync/entry_dto.js` | `canonicalRowToDTO` → preserve `block_index` from parsed activity |
| `phpoc-web/src/sync/row_sync.js` | `mergeRows` → deterministic sort by `activity_id` |
| `tests/test_ccs4_cross_client.py` | Corrected B2 test comment/simulation to reflect verified Dart compact behavior (no assertion changed; still `assertNotEqual` on hypothetical default-spaced form) |
| `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` | §12.9 matrix all ✅; result footnote for CCS-3/CCS-4; `Last updated` bumped |
| `docs/planning/CCS4_PHASE3.md` | this document |

## Verification (after fixes)

```bash
# Groups A–D — all 20 GREEN (was 7 RED + 13 guard)
PYTHONPATH=. python3 -m pytest tests/test_ccs4_cross_client.py -v   # 20 passed

# Group E live Worker — 5/5 GREEN (real test Worker, network)
PYTHONPATH=. python3 -m pytest tests/test_ccs4_live_worker.py       # 5 passed

# Full Python suite — no regression (compact change is total)
PYTHONPATH=. python3 -m pytest tests/                                # 2560 passed, 1 skip, 0 fail

# Web engine regressions
cd phpoc-web && node --test test/row_sync_test.mjs test/row_integration_test.mjs \
  test/entry_dto_committed_test.mjs test/hash_index_test.mjs test/remote_sync_test.mjs \
  test/ccs2_row_level_reconcile_test.mjs                            # all pass, 0 fail

# Flutter hash index (convergence proof)
cd phpoc-flutter && flutter test test/data/sync/staging_hash_index_test.dart  # 8/8 pass
```

### Test-by-test final classification (Groups A–D)

**20/20 GREEN.** Previously-RED now GREEN: A1, A2, A3, A4, A5, A6-JS, C6.
Guard GREEN: A6-Python, B1–B4, C1–C5, D1–D3. Group E live: E1–E5.

### Design note — why compact is canonical

PHPSPEC §8 canonical rows store `activity` as a JSON string. JS `JSON.stringify`
and Dart `json.encode` are both compact by default; only Python's `json.dumps`
defaults to spaced separators. Compact is therefore the natural cross-client
canonical form, and Python now emits it explicitly (`separators=(",", ":")`).
Because the serialized string feeds blob bytes and SHA-256, this single change
makes all three clients byte-identical for canonical rows, the hash index, and
merge output.
