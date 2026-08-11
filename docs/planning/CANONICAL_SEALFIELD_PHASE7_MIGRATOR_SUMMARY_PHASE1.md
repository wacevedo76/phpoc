# Canonical Seal-Field — Ph-7 Migrator Summary Synthesis (Test Exploration / Phase 1)

> **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` → Phase 7, sub-task 0
> **Purpose:** Blueprint of all needed assertions for the `migrate_format.py` enhancement that
> synthesizes canonical ADR-029a summary identity (`month`/`year`) on input blocks that lack it,
> so re-migrating a real 132-block ledger yields fully-canonical summaries (sealing their D5
> partition-identity trust anchor) rather than summaries with an unsealed identity.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Background / Gap

Phase 6 (Ph-6) established the ADR-029a per-type seal contract (PHPSPEC §5.2, lines ~905–908):

| Block type | Seals | Carries |
|---|---|---|
| `genesis` / `day` | `{type, day_index, date, prev_hash, entries, original_hash}` | `day_index`, `entries` |
| `month_summary` | `{type, month, date, prev_hash, original_hash}` | **no** `day_index`/`entries` |
| `year_summary` | `{type, year, date, prev_hash, original_hash}` | **no** `day_index`/`entries` |

The current `migrate_format.py` re-seals every block through `compute_seal`/`select_seal_fields`,
but when the **input** already contains summary blocks, it passes them through `_preserve_and_strip`
**without synthesizing** the canonical `month`/`year` identity and **without stripping** the stray
`day_index`/`entries`.

Measured on the real replaced ledger (`~/.local/share/phpoc/ledger.json`, 132 blocks), after a
`--force` re-migration the summary blocks still carry `day_index` + empty `entries` and **no
`month`/`year`**; `select_seal_fields` on them yields `{type, date, prev_hash, original_hash}` —
the partition identity is absent from the seal. Python *and* Flutter recompute the same (skipping
the absent field) so verification still passes, but this is **not** canonical ADR-029a: the `month`
/`year` trust anchor is unauthenticated.

## Fix (Phase 3 target)

Add a summary-canonicalization step in `migrate_format.py` Phase 1 that, for each `month_summary`
/ `year_summary` input block:

1. **`month_summary`:** if a `month` field is absent, derive `month = date[:7]` (the `YYYY-MM`
   partition). If already present, preserve it.
2. **`year_summary`:** if a `year` field is absent, derive `year = int(date[:4])`. If present,
   preserve it.
3. Always **drop** stray `day_index` and `entries` from summary blocks (per PHPSPEC — summaries
   carry neither).
4. Leave `date`, `prev_hash`, `original_hash`, `type` intact.
5. The derived `month`/`year` then enter the Phase-2 re-seal through `select_seal_fields`, so the
   summary's canonical seal includes the partition identity.

## Test Groups

### Group A: month_summary identity synthesis — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | A migrated `month_summary` input that **lacks** `month` gains `month == date[:7]` (e.g. `date:"2026-05-02"` → `month:"2026-05"`). | Canonical month derived from block date. | The missing partition-identity field must be synthesized so summary identity is authenticatable. |
| A2 | A migrated `month_summary` that **already has** `month` is not overwritten (`month` preserved as-is, even if it disagrees with `date[:7]`). | Preserve explicit partition identity. | A canonical input must not be rewritten to a different identity — migration is re-stamp, not re-semantics. |
| A3 | A migrated `month_summary` has its stray `day_index` and `entries` **removed**. | PHPSPEC: summaries carry no `day_index`/`entries`. | Leftover non-canonical fields would violate the closed-summary shape and PHPSPEC §4.3/label. |
| A4 | The synthetic `month_summary` `month_hash` == `compute_seal` over `{type, month, date, prev_hash, original_hash}` (i.e. the derived month is sealed). | Summary seal covers the partition identity. | Without A4, deriving `month` but not sealing it recreates the unsealed-identity gap. |

### Group B: year_summary identity synthesis — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | A migrated `year_summary` input that **lacks** `year` gains `year == int(date[:4])` (e.g. `date:"2026-06-19"` → `year:2026`, an integer). | Canonical year derived from block date. | Symmetric with A1; `year` is an integer per PHPSPEC §4.2. |
| B2 | A migrated `year_summary` that **already has** `year` is preserved (not overwritten by `int(date[:4])`). | Preserve explicit partition identity. | Symmetric with A2. |
| B3 | A migrated `year_summary` has its stray `day_index` and `entries` **removed**. | PHPSPEC: summaries carry no `day_index`/`entries`. | Symmetric with A3. |
| B4 | The synthetic `year_summary` `year_hash` == `compute_seal` over `{type, year, date, prev_hash, original_hash}`. | Summary seal covers the partition identity. | Symmetric with A4. |

### Group C: chain integrity after synthesis — ~3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | A chain with only non-canonical summaries (no `month`/`year`, with `day_index`/`entries`) verifies `True` after migration via `chain.verify()`. | End-to-end: synthesized canonical chain is fully valid. | Reproduces the real 132-block case at test scale; covers the prev_hash chain across the synthesized blocks. |
| C2 | The synthesized summary `prev_hash` still points to the previous block's new hash (linkage survives identity synthesis). | Chain linkage invariant. | Synthesis must not break the prev_hash chain. |
| C3 | Tampering a synthesized summary's `month`/`year` makes `chain.verify()` return `False`. | The partition identity is now sealed — tamper is detected. | Proves A4/B4 identity sealing is real, not just cosmetic. |

### Group D: edge cases / robustness — ~3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | A `month_summary` with a `date` shorter than `YYYY-MM` still migrates without raising (graceful — derives what it can or keeps base fields) and verifies. | No crash on non-ISO/short summary dates. | Real migrated data may carry unusual dates; migration must be atomic and non-raising. |
| D2 | An already-canonical summary (has `month`/`year`, no `day_index`/`entries`) remains byte-identical except the re-seal — no fields added or dropped. | Idempotence for already-canonical input. | The existing C1–C4 tests cover canonical summaries; D2 locks the no-op-for-canonical guarantee. |
| D3 | Summary synthesis runs before re-seal, so `original_hash` (provenance) is preserved on the synthesized block. | Provenance preserved alongside synthesis. | D5/D9: migration preserves the prior seal under `original_hash` even when synthesizing identity. |

## Summary Report

- **Total assertions:** 14 (A:4, B:4, C:3, D:3)
- **Key coverage areas:**
  - `month_summary` identity synthesis (+preserve-already-present, drop `day_index`/`entries`, sealed identity)
  - `year_summary` identity synthesis (same three facets, integer `year`)
  - End-to-end verification + linkage + tamper-detection of the synthesized identity
  - Robustness: short dates, already-canonical input (no-op), provenance preservation
- **Files to modify (Phase 3):** `phpoc_cli/migrate_format.py` — add `_canonicalize_summary` (or inline) called in the Phase-1 loop for `month_summary`/`year_summary` blocks.
- **Files to add (Phase 2):** extend `tests/test_migrate_format.py` with a new `TestMigrateFormatSummarySynthesis` class (14 tests mapping to A1–D3).
