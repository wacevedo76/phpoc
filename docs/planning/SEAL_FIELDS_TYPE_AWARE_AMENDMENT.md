# Canonical Block-Seal — Type-Aware Field Set (Amendment to ADR-029)

> **Status:** ✅ Adopted — ADR-029a appended to `docs/design/ARCHITECTURAL_DECISIONS.md`
> **Supersedes / amends:** ADR-029 (closed 6-field whitelist, `CANONICAL_SEAL-FIELD_Design.md`)
> **Drivers:** D5 chain-splitting-at-summary-boundaries; 55 regressions expose that the flat
> 6-field whitelist cannot verify real summary blocks; Flutter already diverges on summaries.
> **Decision shape:** closed **type-aware** whitelist — one frozen per-type field set, no open-set rules.

---

## 1. Why ADR-029's flat 6-field whitelist is incomplete

ADR-029 adopted a single closed whitelist for **all** block types:

```
SEAL_FIELDS = { type, day_index, date, prev_hash, entries, original_hash }
```

This is correct for **day** and **genesis** blocks, but **cannot** be the seal-input rule for
summary blocks for a structural reason: a `month_summary` / `year_summary` carries **`month` /
`year`** and **no** `day_index` / `entries`. The flat whitelist therefore:

- drops the summary's identity field (`month` / `year`) from the seal, and
- selects only `{ type, date, prev_hash, original_hash }` for summaries.

### 1.1 Resolved: summary blocks already diverge across clients

ADR-029's §3.3 claimed the **only** differing field across all 129 blocks is `original_hash`.
That is false for summary blocks. Ground truth from the four implementations:

| Client | Summary seal inputs (current) | Seals `month`/`year`? |
|--------|-------------------------------|------------------------|
| Python `chain.py:450` (open-set) | `type, month/year, prev_hash, date` (+ `original_hash`) | ✅ yes |
| Web `chain.js:528` (open-set) | `type, month/year, prev_hash, date` (+ everything else) | ✅ yes |
| Flutter `chain.dart` `_sealFields` (5-field) | `type, date, prev_hash` (drops `month`/`year`) | ❌ no |
| Migration tool `_seal_block` (open-set) | `type, month/year, prev_hash, date` (+ `original_hash`) | ✅ yes |

So a `month_summary` verified by Python/Web **already fails** Flutter's verifier, and vice versa.
The 129/129 claim held only on **day/genesis** blocks. Option B fixes this divergence *and*
closes the tamper gap.

### 1.2 Why the security depth matters for modular chains

Per PHPSPEC §4.2 the summary is the **"clean cut point for splitting or archiving"** — the trust
anchor for partitioning a long ledger into independently-verified sub-chains. If `month`/`year`
are **not** sealed:

1. An attacker can re-label a summary's `month`/`year` without breaking its seal (verification
   still passes).
2. When a ledger is loaded/Split/archived at that summary, the boundary lands at the wrong month.
3. The "re-derive from sealed day blocks" mitigation is unusable in a **modular** design, because
   the whole point is that you do **not** have all adjacent day blocks loaded to cross-check.

**D5 — Append-Only Immutability** makes splitting *at summary boundaries* the explicit archiving /
portable-export mechanism, so the summary is a first-class trust anchor. Therefore the summary's
identity content must be **inside** the seal. → **Option B.**

---

## 2. Canonical per-type field sets (the amendment)

Define a closed, explicit seal-input set **per block type**. Fields outside the listed set are
**never** sealed (`format_version`, `key_version`, `identity`, `identity_seal`, `signature`, and
any future/client-specific field). Sets select only fields **present** on the block (absent
whitelist fields are skipped — same as ADR-029).

| Block type | Seal-input fields (closed) | Rationale |
|-----------|-----------------------------|-----------|
| `genesis`  | `type, day_index, date, prev_hash, entries, original_hash` | unchanged from ADR-029 |
| `day`      | `type, day_index, date, prev_hash, entries, original_hash` | unchanged from ADR-029 |
| `month_summary` | `type, month, prev_hash, date, original_hash` | `month` is the partition identity → sealed |
| `year_summary`  | `type, year, prev_hash, date, original_hash` | `year` is the partition identity → sealed |

Notes:

- **`original_hash`** is optional-presence on every type (sealed when present; absent on
  new/pre-0.4.0 blocks). All four types include it when present.
- **`date`** stays a seal input for summaries (it is present and is part of the summary's
  structural identity).
- **`prev_hash`** stays a seal input for all types (chain linkage — D4).
- No summary type has `day_index` or `entries`; they are simply absent → skipped.

### 2.1 Explicitly excluded (never sealed) — unchanged from ADR-029

`format_version`, `key_version`, `identity`, `identity_seal`, `signature`, `block_hash`,
`day_hash`, `month_hash`, `year_hash`, and **any field not named in the table above**.

**Real production surface:** a production summary block carries exactly
`{ type, month|year, prev_hash, date }` (+ its hash/identity-seal). No other summary field is
emitted by any production sealer (`domain/ledger/summary_policy.py`, `phpoc_cli/migrate_format.py`)
or the web/Flutter clients. The only summary fields that exist in real ledgers are `month` / `year`
— both are sealed by the per-type table above.

**About `month_index`, `year_index`, `days`, `months`, `day_count`, `total_duration`:** these names
appear **only in test fixtures** (`tests/test_serialization_unification.py`, `tests/test_migrate_format.py`)
and as unrelated local-variable / date-arithmetic names in production code (e.g. `days_to_sync`, the
blind index's `total_duration_ms`). They are **not** block fields on any real ledger, and therefore
are not a real security surface today. `total_duration` exists as an aggregate in the blind index
(a derived cache, rebuildable from the sealed chain) — never inside a sealed block.

> **Effect of the closed per-type rule (guard for the future):** if a future real feature introduces
> a summary aggregate field (e.g. a sealed `day_count`/`total_duration`), it will **not** be in the
> per-type set, so it will be treated as non-authenticated metadata. Tamper-coverage for such an
> aggregate must be a deliberate, documented decision — add it to the explicit per-type set in a
> future amendment, never silently. This is the closed-set guard, not an indication that the field
> exists today.

---

## 3. Contract (normative summary)

```
SEAL_FIELDS: {
    "genesis":       { type, day_index, date, prev_hash, entries, original_hash },
    "day":           { type, day_index, date, prev_hash, entries, original_hash },
    "month_summary": { type, month,        date, prev_hash,          original_hash },
    "year_summary":  { type, year,         date, prev_hash,          original_hash },
}
Rendered input  = { k: v for k,v in block.items() if k in SEAL_FIELDS[block.type] }
Serialized      = json.dumps(rendered_input, sort_keys=True)  # or byte-eq jsonSort (Dart)
```

A `block.type` with no entry in the table is verification-invalid (unknown type → reject).

---

## 4. ADR-029 amendment (text to append)

> **ADR-029a — Canonical block-seal field set is type-aware (amend ADR-029)**
>
> **Status:** 🔜 proposed
> **Date:** (draft)
>
> **Change:** Replace the single flat `SEAL_FIELDS = { type, day_index, date, prev_hash, entries,
> original_hash }` with a closed **per-block-type** field set. `genesis` and `day` keep the six
> ADR-029 fields. `month_summary` and `year_summary` seal `{ type, month|year, prev_hash, date,
> original_hash }` — adding the summary's `month`/`year` identity to the seal and dropping the
> inapplicable `day_index`/`entries`.
>
> **Context:** ADR-029's flat whitelist structurally cannot verify real summary blocks (they carry
> `month`/`year`, not `day_index`/`entries`), and summary blocks are the **partition/archive trust
> anchor** of a modular chain (PHPSPEC §4.2). Leaving `month`/`year` outside the seal both (a)
> breaks cross-client parity that already exists for summaries and (b) permits re-labeling a
> partition boundary without detection when the chain is loaded/modularized.
>
> **Decision:** Adopt the table in §2 as the canonical seal-input contract. Preserve ADR-029's
> closed-set and `original_hash` properties; only the per-type membership is now explicit and
> type-dependent.
>
> **Consequences:**
> - *Positive:* summary partition identity is tamper-covered; closes a real, pre-existing
>   cross-client summary divergence; supports modular/split-chain integrity (D5).
> - *Negative/effort:* whitelist is no longer a single constant → cross-client per-type tables must
>   be identical and tested (Phase 6 vectors per type); existing migrated ledgers' summary seals
>   were computed over `month`/`year` under the open-set already, but will be re-stamped onto the
>   exact per-type set during the Phase 7 re-migration (backup first, D5/D9).
>
> **Backward compatibility (D9):** day/genesis unchanged. Pre-0.4.0 and non-`original_hash` blocks
> still verify (absent optional fields skipped). Summary blocks carry `month`/`year`/`date`/
> `prev_hash` in all current formats, so the per-type set selects them consistently after
> re-migration.

---

## 5. Cross-client impact checklist (to update on approval)

| Implementation | Change |
|----------------|--------|
| Python `domain/ledger/chain.py` | `SEAL_FIELDS` → per-type table; `_select_seal_fields` keys off `block['type']`; route 3 sites + summary sealers |
| Python `domain/ledger/summary_policy.py` | `_make_year_summary` / `_make_month_summary` seal over the per-type set |
| Python `phpoc_cli/migrate_format.py` + standalone | `_seal_block` → per-type set |
| Web `phpoc-web/src/ledger/chain.js` | `_verifyBlockData` checkData → per-type set |
| Flutter `phpoc-flutter/lib/data/ledger/chain.dart` | `_sealFields` → per-type; add `month`/`year` for summaries |
| PHPSPEC `docs/spec/PHPSPEC.md` | document the per-type seal field set + closed rule |
| Canonical vectors (Phase 6) | one expected seal per type |
| Migration (Phase 7) | re-stamp all block seals onto per-type set; backup first. Verify against the **real** summary shape (`{type, month|year, prev_hash, date}`); do not let fixture-only variants (e.g. `month_index`, `day_count`) be treated as schema content |
| Test fixtures | correct hand-built summary shapes that carry `month_index`/`day_count`/`total_duration` (e.g. `test_migrate_format.py`) to the real `{type, month, prev_hash, date}` shape, so tests reflect production |

---

## 6. References

- ADR-029 (this amendment supersedes its flat whitelist for summaries)
- `docs/design/CANONICAL_SEAL-FIELD_Design.md`
- `docs/spec/PHPSPEC.md` §4.1–§4.3 (block schemas), §4.2 (partition point)
- `tests/test_chain_seal_whitelist.py` — current tests anchored on the flat 6-field constant
  (A7 must be updated to the per-type table)
- `docs/planning/CANONICAL_SEALFIELD_PYTHON_PHASE1.md` — Phase 1 blueprint (Group A7/C3/C4 to update)
