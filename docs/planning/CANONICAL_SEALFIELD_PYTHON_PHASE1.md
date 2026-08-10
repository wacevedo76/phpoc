# Canonical Seal-Field — Python `chain.py` — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` — Phase 1 (of 7)
> **Purpose:** Blueprint all test assertions needed to converge Python's block-seal
> sealer/verifier onto the canonical **type-aware** whitelist (ADR-029 / ADR-029a).
> **Status:** 🔜 Phase 1 (test exploration) — updated for ADR-029a
> **Next Phase:** Phase 2 (RED: test definition) → `tests/test_chain_seal_whitelist.py`
> **ADR:** ADR-029 (`{type, day_index, date, prev_hash, entries, original_hash}`) amended by
> ADR-029a → per-type field sets (summaries seal their `month`/`year`).

---

## Architecture Overview

Three seal-construction/verification sites in `domain/ledger/chain.py` must converge to the
canonical **type-aware** closed whitelist (ADR-029a):

1. **`create_day` sealer (~line 266)** — builds a new day block's `day_hash`. Currently:
   `seal_data = {k: v for k, v in day_content.items() if k not in ("key_version",)}`
   (open-set minus `key_version`). New blocks carry no `original_hash`, so today this is
   effectively the 5-field set; under the whitelist it selects the 6 named fields shown.
2. **`_verify_block_seal` (~line 450)** — verifies any block's `{type}_hash`. Currently:
   `{k: v for k, v in block.items() if k not in (hash_key, "identity_seal", "signature",
   "format_version", "key_version")}` (open-set minus exclusions). With the migrated ledger
   this includes `original_hash` → 6-field, so it already accepts migrated blocks (129/129).
3. **`_get_block_hash` genesis-rotation recompute (~line 550)** — re-seals a genesis during
   soft-rotation lookups using the same open-set logic.

**Contract change (ADR-029a):** seal input is selected per block type. Fields outside the
per-type set are skipped; a stray/non-whitelisted field (e.g. an unexpected `foo`, or a
client-injected metadata field) is excluded from the seal, so a divergent client that seals
over it is rejected.

| Block type | Seal-input fields (closed) |
|-----------|-----------------------------|
| `genesis`  | `type, day_index, date, prev_hash, entries, original_hash` |
| `day`      | `type, day_index, date, prev_hash, entries, original_hash` |
| `month_summary` | `type, month, prev_hash, date, original_hash` |
| `year_summary`  | `type, year, prev_hash, date, original_hash` |

```
rendered  = { k: v for k, v in block.items() if k in SEAL_FIELDS[block["type"]] }
json.dumps(rendered, sort_keys=True)
```

> **`original_hash` is *optional-presence*, sealed-*when-present*.** It exists only on
> migrated blocks; new/pre-0.4.0 blocks lack it. It is in every per-type set so that **when
> present** every client seals over it. Absent whitelist fields are skipped.
>
> **Summary identity fields (`month`/`year`) are sealed** (ADR-029a) because summaries are the
> chain split/archive trust anchor (D5); leaving them outside the seal let a partition boundary
> be re-labeled without violating verification.

Python "reference" position: content-hash logic (ADR-005, all-keys) is **untouched**.

### Test surface
- New file: `tests/test_chain_seal_whitelist.py` (unittest; `_MockCrypto`/`_MockLedgerStore`
  patterns mirror `test_content_hash_required.py` / `test_migrate_format.py`).
- **Fixture correction:** hand-built summary shapes in tests/fixtures that carry fixture-only
  variants (`month_index`, `day_count`, `total_duration` — not real ledger fields) must be
  corrected to the real `{type, month|year, prev_hash, date}` shape.
- Must keep existing suites GREEN: `test_content_hash_required.py`, `test_migrate_format.py`,
  `test_phase3_ledger_engine.py`, `test_i01_key_rotation_chain.py`, etc.

---

## Test Groups

### Group A: Whitelist selection — ~8 tests
Verify the shared `SEAL_FIELDS` per-type map excludes non-whitelisted fields and includes the
correct canonical fields for each block type.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | A block sealed with a stray field `foo` verifies when `foo` is excluded from BOTH sealer and verifier | Closed-set: stray fields don't break the seal | The core closed-set property (ADR-029) — future/client fields must not silently enter the hash |
| A2 | A block whose stored hash was computed INCLUDING a stray field `foo` FAILS verification (cross-client divergence caught) | Detect divergent-client seals | The exact bug class (Flutter 5-field vs Python) — verifier must reject a seal that covered a non-whitelisted field |
| A3 | Excluding `original_hash` from the seal fails on a migrated-style block that includes `original_hash` in its stored seal | `original_hash` is a sealed field when present | Prevents regressing to the Phase-4 Flutter 5-field bug in Python |
| A4 | Block without `original_hash` (legacy / newly-created) still verifies (field absent → skipped) | Backward compat for pre-migration & new blocks | D9 — absent optional whitelist fields must not break verification |
| A5 | `format_version` and `key_version` are NOT in any per-type set (excluded from seal) | Rotation/format-fields are rotation-safe | ADR-029 — these must never be sealed |
| A6 | `identity_seal`, `signature`, and the hash key itself are not seal inputs | Metadata excluded | Matches PHPSPEC "exclude the seal field itself" |
| A7 | `SEAL_FIELDS` is the canonical per-type map: `genesis`/`day` = `{type, day_index, date, prev_hash, entries, original_hash}`; `month_summary` = `{type, month, prev_hash, date, original_hash}`; `year_summary` = `{type, year, prev_hash, date, original_hash}` | Canonical type-aware contract is explicit | Deterministic per-type contract (Phase 6 vectors depend on it) |
| A8 | Selecting whitelist fields preserves order-independent serialization (`sort_keys=True`), byte-identical across the selected fields | Canonical JSON shape | Guarantees Web/Dart produce the same seal input (Phase 6 convergence) |

### Group B: Sealer (`create_day` → `build_day_block`) — ~5 tests
Verify newly-created day blocks are sealed over the day per-type set.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `create_day` seals using only the day whitelist fields (a subsequently-added stray field does not change the produced `day_hash`) | Sealer is closed-set | Seal must not depend on non-whitelisted fields |
| B2 | `create_day` output `day_hash` matches a by-hand recompute over the day per-type set | Deterministic, testable seal | Locks the exact serialization for cross-client parity |
| B3 | `create_day` chain (genesis + day) verifies end-to-end via `verify()` | Sealed-new-block integrates with the chain | Chain integrity (D4) holds for whitelist-sealed new blocks |
| B4 | Two `create_day` blocks with identical day fields but different stray metadata produce the SAME `day_hash` | Closed-set invariance | Proves stray fields are excluded from sealing |
| B5 | `day_index` incrementing across day blocks still links correctly (`prev_hash` chain) | Prev_hash linkage unaffected | The whitelist changes only seal inputs, not linkage |

### Group C: Verifier (`_verify_block_seal`) — ~7 tests
Verify the verifier accepts canonical per-type seals and rejects divergent ones across all
block types.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Genesis block sealed over `{type, day_index, date, prev_hash, entries, original_hash}` verifies | Per-type set applies to genesis | Genesis uses `block_hash` (or legacy `day_hash`) — selection is type-driven |
| C2 | Day block sealed over its per-type set verifies | Per-type set applies to day | The most common block type |
| C3 | Month-summary block sealed over **its own set** `{type, month, prev_hash, date, original_hash}` verifies (real summary shape, no `day_index`/`entries`) | Month-summary uses the summary per-type set | ADR-029a — `month` (a partition identity) is sealed, unlike day/genesis |
| C4 | Year-summary block sealed over **its own set** `{type, year, prev_hash, date, original_hash}` verifies (real summary shape) | Year-summary uses the summary per-type set | ADR-029a — `year` is sealed as the partition identity |
| C5 | Block with non-whitelisted stray field in its seal FAILS verification | Verifier is closed-set | Detects client that sealed over a stray field (divergence) |
| C6 | Whichever `{type}_hash` key the block uses (`block_hash`/`day_hash`/`month_hash`/`year_hash`) is excluded from its own seal | Hash key excluded per type | Prevents the seal from covering itself |
| C7 | Tampered whitelist field (e.g. altered `entries`, `date`, `month`, or `year`) FAILS verification | Tamper detection intact | D4 — modifying any sealed field (incl. summary identity) breaks the seal |

### Group D: Whitelist integration — ~3 tests
Verify the shared per-type map is actually used by all seal sites (no orphaned open-set code).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `SEAL_FIELDS` (the per-type map) is defined once near the top of `chain.py` | Single source of truth | Prevents future drift between sealer/verifier/recompute |
| D2 | All seal/verifier/recompute sites (`build_day_block`, `_verify_block_seal`, `_get_block_hash`) and the summary sealers select through `SEAL_FIELDS[block["type"]]` | All paths converge | No site may still use open-set-minus-exclusions |
| D3 | The public `compute_seal`/`verify_seal` helpers (raw dict) are NOT changed to whitelist | Helper boundary intact | Those helpers serialize exactly what they're given; whitelisting belongs in the block seal sites |

### Group E: Regression guard — ~3 tests
Ensure the change does not break existing behavior.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Pre-existing day-block fixtures (open-set, no stray fields) still verify | No behavioral regression on well-formed blocks | Backward compat with current fixtures and real migrated ledger |
| E2 | A migrated-style chain including `original_hash` on every block type verifies 129/129-equivalent (small representative fixture) | Migrated-ledger parity | The on-phone fix must preserve Python's current 129/129 acceptance |
| E3 | Entry `content_hash` verification path (ADR-005) is untouched by the seal change | Content-hash independence | Different layer (open all-keys) — the seal change must not disturb it |

---

## Summary Report

- **Total assertions:** 26
- **By group:** A = 8 (type-aware whitelist selection), B = 5 (sealer), C = 7 (verifier),
  D = 3 (per-type map integration), E = 3 (regression guard)
- **Key coverage areas:**
  - Closed per-type seal selection (A1–A8)
  - Sealer emits per-type-only seals (B1–B5)
  - Verifier accepts canonical + rejects divergent across all 4 block types, incl. summary
    `month`/`year` identity sealing (C1–C7)
  - Shared `SEAL_FIELDS` per-type-map integration (D1–D3)
  - Backward compat + migrated-ledger parity + content-hash independence (E1–E3)
- **ADR-029a scope:** this blueprint is **type-aware** — summaries seal
  `{type, month|year, prev_hash, date, original_hash}`, not the day-style 6 fields.
- **Deferred to Phase 6** (shared cross-client canonical vectors): proving byte-identical
  hashes against Web/Dart per block type — Python side assertions here are the anchor (A8, B2).
- **Deferred:** month/year summary block *sealers* in Python produce summary-shaped blocks
  (`summary_policy.py`); verifier coverage for the real summary shapes is in C3/C4.

## Files
- **New:** `tests/test_chain_seal_whitelist.py` (Phase 2 — `EXPECTED_SEAL_FIELDS` to become the per-type map)
- **Modified:** `domain/ledger/chain.py` (Phase 3 — `SEAL_FIELDS` per-type map, route seal sites through it)
- **Modified:** summary sealer `domain/ledger/summary_policy.py` + other seal sites (convergence per ADR-029a)
- **Fixture correction:** summary block shapes in tests/fixtures to the real `{type, month|year, prev_hash, date}` shape
- **Docs:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` (Phase 1 status)
