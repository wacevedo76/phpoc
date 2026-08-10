# Flutter Block-Seal Field Whitelist — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` Phase 3 (Flutter `chain.dart`)
> **Purpose:** Blueprint of all assertions needed to converge the Flutter sealer/verifier onto
> the canonical ADR-029 6-field block-seal whitelist — specifically the Phase-4 regression that
> left `_sealFields` as the 5-field set `{type, day_index, date, prev_hash, entries}`, missing
> the canonical `original_hash`. Mirrors the already-complete Python reference (plan Ph-1) and
> Web (`seal_fields.js`, plan Ph-2).
> **Status:** ✅ Phase 1–4 complete (9 tests GREEN in `chain_seal_whitelist_test.dart`)
> **Next Phase:** Phase 3 (GREEN) — done; P4 REFACTOR — docstring corrections only.

## Architecture Overview

`phpoc-flutter/lib/data/ledger/chain.dart` ships the single sealing/verifying path:

1. **Sealer** — `_sealBlock(Map block)` copies the fields listed in the static
   `_sealFields` const that are *present* in the block, then `computeSeal` HMACs
   `jsonSort(sealData)` with the master key. Called by `buildGenesisBlock` (→ `block_hash`)
   and `buildDayBlock` (→ `day_hash`).
2. **Verifier** — `_verifyBlockSeal(Map block)` extracts the same `_sealFields` subset and
   checks the stored hash key (`block_hash` genesis / `day_hash` day / `month_hash`
   month_summary / `year_hash` year_summary) via `verifySeal`'s 3-way JSON fallback
   (`jsonSort` canonical / `jsonSortIndent2` Python / no-space JS).

### Current state (the regression)
```
static const _sealFields = ['type', 'day_index', 'date', 'prev_hash', 'entries'];
```
This flat 5-field set. It is missing `original_hash`, so any block carrying migration
provenance (`original_hash`) has that field EXCLUDED from its seal. Conversely, blocks that
Python/Web sealed *over* `original_hash` will NOT verify on Flutter — the root cause of the
on-phone `verify()` 0/129 failure for migrated 0.4.0 ledgers.

### Target contract (mirror of Python `domain/ledger/chain.py` SEAL_FIELDS / Web `seal_fields.js`)
```
_sealFields = ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'];
```
- **Closed set:** the seal is HMAC over exactly the 6 fields *present*, sorted with `jsonSort`
  (= Python `json.dumps(..., sort_keys=True)`).
- **Never sealed:** `format_version`, `key_version`, `identity`, `identity_seal`, `signature`,
  all hash keys (`hash`/`day_hash`/`block_hash`/`month_hash`/`year_hash`), and any stray field.
- **`original_hash`** (migration provenance): sealed when present; its absence must not break
  verification (pre-0.4.0 / new blocks) — same "optional-if-absent" rule as Python/Web.
- **Content-hash (ADR-005) stays untouched** — an independent layer in `verify()`.

## Test Groups

### Group A: `_sealFields` 6-field closed set (behavioral) — 2 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | A genesis sealed over exactly the 6 fields (incl `original_hash`) verifies via `verifyBlock(0)` | Prove the whitelist folds `original_hash` into the seal | The Phase-4 regression shipped a 5-field set; a block sealed over 6 fields only verifies if `original_hash` is in the whitelist (B1/B3-sealer intent, behavioral) |
| A2 | A day block sealed over the 6 fields (incl `original_hash`) verifies via `verifyBlock(1)` | Prove day seals fold `original_hash` | The 0/129 on-phone failure is predominantly day blocks (B2-sealer intent) |

> The sealer (`_sealBlock`) and verifier (`_verifyBlockSeal`) share the same `_sealFields` table, so a
> block that verifies when sealed over the 6 fields proves the *sealer* included `original_hash` AND the
> *verifier* accepts it. Group C sharpens tamper-detection and optionality.

### Group C: Verifier accepts/seals `original_hash` — 4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | A genesis sealed over the 6 fields (incl. `original_hash`) verifies via `verifyBlock(0)` | Verifier must accept canonical 6-field seals | The core 0/129 → 129/129 fix on the phone |
| C2 | A block whose stored seal was computed WITHOUT `original_hash` still verifies when `original_hash` is absent | `original_hash` is optional-if-absent | New/pre-0.4.0 blocks carry no `original_hash` and must keep verifying (matches Python/Web) |
| C3 | Tampering `original_hash` on a 6-field-sealed block invalidates the seal (verifyBlock false) | Provenance tamper must be detected | Closed-set seal authenticates `original_hash`; a changed value invalidates the seal (B3 intent) |
| C4 | `format_version`/`key_version` tampering does NOT invalidate an otherwise-valid 6-field seal | Closed-set: non-whitelisted fields are not authenticated (A3 intent) | Guarantees metadata fields stay outside the seal (matches Python/Web) |

### Group D: Cross-client parity — 3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | A Python-indent2-sealed genesis (over 6 fields incl `original_hash`) verifies on Flutter | Cross-client seal parity | Migrated CLI-created ledgers carry `original_hash` + Python indent2 seals — must verify on the phone |
| D2 | A JS no-space-sealed genesis (over 6 fields incl `original_hash`) verifies on Flutter | Cross-client seal parity | Web-created migrated blocks carry `original_hash` + JS no-space seals — must verify on the phone |
| D3 | `original_hash` absence (genesis) + presence (linked genesis, same verifier) both verify | Backward + forward compatibility | Guarantees no regression for existing ledgers while enabling migrated-ledger verification |

## Summary

- **Total assertions:** 9 tests in `chain_seal_whitelist_test.dart` (Group A: 2, Group C: 4, Group D: 3).
- **Key coverage areas:** whitelist membership incl `original_hash` (A), verifier acceptance + optionality +
  tamper detection + closed-set exclusion (C), cross-client parity across 3 serializer fallbacks (D).
- **Sealer path (B) is proven behaviorally:** `_sealBlock`/`_verifyBlockSeal` share one `_sealFields` table, so
  A/C (seal-over-6-fields verifies; tamper detected) jointly prove the sealer folds `original_hash`.
- **Out of scope (kept as-is):** type-aware per-type SEAL_FIELDS for summaries (`month`/`year` identity),
  content-hash (ADR-005), and the pre-existing `content_hash`-requirement failures in the K-group chain tests.
