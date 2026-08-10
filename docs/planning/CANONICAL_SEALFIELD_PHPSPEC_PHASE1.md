# PHPSPEC Seal-Whitelist Documentation — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` Phase 5
> **Purpose:** Blueprint of every spec statement needed so `docs/spec/PHPSPEC.md`
> documents the ADR-029/029a closed, type-aware 6-field block-seal whitelist and
> drops the stale open-set / `format_version`-included claims.
> **Status:** 🔜 Phase 1 (test exploration — spec-conformance assertions)
> **Next Phase:** Phase 2 (RED: confirm current spec contradicts ADR-029)

## Architecture Overview

`PHPSPEC.md` is the authoritative ledger format contract (docs/spec/AGENTS.md). Implementations
(CLI Python `domain/ledger/chain.py`, Web `phpoc-web/src/ledger/seal_fields.js`, Flutter
`phpoc-flutter/lib/data/ledger/chain.dart`, migration `phpoc_cli/migrate_format.py`) must conform
to it. Since the 4-phase code convergence (Phases 1–4) locked the whitelist in code, Phase 5 is
the **spec/doc pass**: the spec must state the same contract so conformance is enforceable.

The authoritative contract (ADR-029a, `domain/ledger/chain.py` `SEAL_FIELDS`):

- **Four block types**, each with a frozen per-type seal-input field set:
  - `genesis`: `{type, day_index, date, prev_hash, entries, original_hash}`
  - `day`: `{type, day_index, date, prev_hash, entries, original_hash}`
  - `month_summary`: `{type, month, prev_hash, date, original_hash}`
  - `year_summary`: `{type, year, prev_hash, date, original_hash}`
- Seal = HMAC-SHA256 over `json.dumps(seal_data, sort_keys=True)` (byte-equal canonical JSON
  in Dart), using the sealing sub-key from §2.6.
- **Closed set:** excluded fields are NEVER sealed — `format_version`, `key_version`, `identity`,
  `identity_seal`, `signature`, the block's own hash key (`day_hash`/`year_hash`/`month_hash`),
  and any future/client-specific field.
- `original_hash` is **optional-if-absent**: sealed only when present (migrated 0.4.0 blocks);
  absent on new / pre-0.4.0 blocks.
- Unknown block type (no map entry) → verification-invalid / `ValueError`.

## Current-State Defects Being Fixed (stale vs. ADR-029)

| Loc | Current PHPSPEC text | Defect |
|-----|----------------------|--------|
| §5.2 `compute_seal` | `check_data = {k: v for k, v in block.items() if k not in (hash_key, "identity_seal")}` | Open-set — seals `format_version`/`key_version`/stray fields; contradicts ADR-029 closed whitelist. |
| §1.4 "Seal" def | "excluding the seal field itself" | Omits the closed-set / whitelist rule. |
| §9.… "format_version included in block seal" | "This field is **included in the block seal** (see §5.2)" | FALSE under ADR-029 — `format_version` is excluded. |
| Version migration note | "Because `format_version` is included in the block seal, adding it changes `day_hash`, which cascades" | FALSE — must be reworded; `format_version` is NOT sealed. |
| Version migration script | `compute_seal(block, master_key)` open-set | Must reference whitelist selection. |

## Test Groups (spec-conformance assertions)

### Group A: Closed per-type field set — 8 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | §5.2 defines the exact 6-field per-type whitelist (genesis/day table). | Spec states canonical genesis/day seal-input set. | Genesis/day are the two real content-bearing block shapes; the whitelist must be explicit, not open. |
| A2 | §5.2 defines the exact per-type whitelist for month_summary (`type, month, prev_hash, date, original_hash`). | Summary partition identity (`month`) is sealed. | ADR-029a: sealing `month` is the D5 split/archive trust anchor. |
| A3 | §5.2 defines the exact per-type whitelist for year_summary (`type, year, prev_hash, date, original_hash`). | Summary partition identity (`year`) is sealed. | Same rationale as A2 for year boundaries. |
| A4 | §5.2 states `select_seal_fields` selects only fields present in `block` (render-time optionality). | Selection is `{k for k in block if k in field_set}`. | Prevents sealing absent keys; keeps `original_hash` optional. |
| A5 | §5.2 states serialization is `json.dumps(seal_data, sort_keys=True)`. | Canonical seal bytes are cross-client identical. | Convergence depends on identical canonical serialization (byte-equal in Dart). |
| A6 | §5.2 documents `hash_key` selection by type (`day_hash`/`month_hash`/`year_hash`). | Seal uses each block's own hash field name. | The hash key resolves per type (see §4.6). |
| A7 | §5.2 documents the four type values (`"genesis"`, `"day"`/absent, `"month_summary"`, `"year_summary"`). | Map keys match real block types. | Unknown type → verify-invalid; map must be exhaustive for valid types. |
| A8 | §5.2 states unknown block type (no map entry) is rejection. | Unknown types are verification-invalid. | Prevents silent open-set fallback for novel types. |

### Group B: Closed-set / excluded fields — 7 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | §5.2 lists `format_version` as NEVER sealed. | The version field is outside the whitelist. | Currently falsely documented as "included in the block seal"; version must not affect seals. |
| B2 | §5.2 lists `key_version` as NEVER sealed. | Key-version field is outside the whitelist. | Same closed-set rule; future fields must not silently invalidate seals (D4). |
| B3 | §5.2 lists `identity` as NEVER sealed. | Identity object is outside the whitelist. | `identity` (seed/encrypted seed) must not enter the seal. |
| B4 | §5.2 lists `identity_seal` as NEVER sealed. | The identity-seal field is excluded. | Matches current §5.3 (identity seal is over the seal, not in it). |
| B5 | §5.2 lists `signature` as NEVER sealed. | Signature field is excluded. | Signature is over the seal hash, not within it. |
| B6 | §5.2 lists the block's own hash key(s) as NEVER sealed. | `day_hash`/`month_hash`/`year_hash` are excluded. | The seal field itself is always excluded (its own HMAC output). |
| B7 | §5.2 states any future / client-specific field is NEVER sealed (closed-set rule). | Future fields don't silently change seals. | ADR-029 Option 3 rationale: predictability of sealed bytes. |

### Group C: `original_hash` optionality — 3 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | §5.2 states `original_hash` is sealed ONLY when present. | Optional-if-absence rule. | Pre-0.4.0 / new blocks have no `original_hash`; their seal omits it. |
| C2 | §5.2 states absence of `original_hash` on a block does not change the field set shape (rendering omits it). | Absence is a no-op for selection. | `select_seal_fields` keeps only present keys. |
| C3 | §5.2 ties `original_hash` present ↔ migrated 0.4.0 block. | Documents when original_hash appears. | Migrated re-hashed blocks carry original_hash; new blocks do not. |

### Group D: HMAC & sub-key correctness — 3 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | §5.2 keeps HMAC-SHA256, sealing sub-key `b"integrity-key-salt"`. | Sealing algorithm unchanged (§2.6). | Only the seal-input scope changes, not the HMAC scheme/key. |
| D2 | §5.2 validation rule stays `compute_seal(block, mk) == block[hash_key]`. | Verification contract preserved. | Verifiers confirm by recompute over the whitelist. |
| D3 | §5.2 example `compute_seal` uses `select_seal_fields` (not open-set `check_data`). | Spec code mirrors ADR-029. | Prevents implementations copying the stale open-set fragment. |

### Group E: Cross-reference & versioning — 4 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | §9 / versioning text: `format_version` is NOT included in the block seal. | Remove the false "included in seal" claim. | This claim contradicts ADR-029 and §5.2 B1. |
| E2 | Version migration note no longer claims adding `format_version` "cascades through the entire chain" *via the seal*. | Correct the migration rationale. | Adding `format_version` to genesis does NOT change `day_hash` (it's unsealed) — only content/pre_hash changes cascade. |
| E3 | Migration script example references whitelist seal selection. | Docs' sample migration reflects the whitelist. | The real `migrate_format.py` uses `compute_seal` over `select_seal_fields`. |
| E4 | §1.4 "Seal" definition mentions the closed whitelist. | Terminology table is consistent. | Glossary should not contradict §5.2. |

### Group F: Cross-client conformance note — 2 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | §5.2 notes the whitelist must be byte-identical across Python/Web/Flutter/migrator. | Cross-client convergence requirement. | Phase 6 canonical vectors verify identical seals; spec mandates the shared table. |
| F2 | §5.2 notes summary rows (month/year) differ from day/genesis (no day_index/entries). | Documents why summaries have separate sets. | Readability; prevents a reader collapsing all four types to one set. |

## Summary Report
- **Total assertions:** 27 (A:8, B:7, C:3, D:3, E:4, F:2)
- **Groups:** A (closed per-type field set), B (closed-set/excluded fields), C (`original_hash`
  optionality), D (HMAC/sub-key correctness), E (cross-reference & versioning cleanup),
  F (cross-client conformance note).
- **Key coverage areas:** per-type whitelist tables, excluded-field list, `original_hash`
  optional-if-absent, HMAC-SHA256 + `sort_keys=True` serialization, removal of the stale
  `format_version`-in-the-seal claim, migration-note correction, glossary consistency,
  cross-client mandate.
- **Deferred:** none — all assertions addressed in the §5.2 rework plus §1.4/§9 touch-ups.
