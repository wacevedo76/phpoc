# Migrator Block-Seal Field Whitelist — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` Phase 4 (Migration tool)
> **Purpose:** Blueprint of all assertions needed to prove the migration tool (`ph migrate-format`)
> re-stamps every block seal onto the canonical ADR-029/029a **6-field whitelist**, matching the
> already-complete Python (`plan Ph-1`), Web (`Ph-2`), and Flutter (`Ph-3`) implementations — so a
> migrated 0.4.0 ledger verifies on every client (fixes the on-phone 0/129 failure).
> **Status:** 🔜 Phase 2 (RED) in progress
> **Next Phase:** Phase 3 (GREEN: implementation)

## Architecture Overview

The migration tool lives in `phpoc_cli/migrate_format.py` (`MigrateFormatCommand`). The
standalone `migrate-format.py` at the project root is only an auth/arg wrapper — it delegates to
`MigrateFormatCommand`, so **all sealing logic lives in `_seal_block`/`_seal_block_hash_key` in
`migrate_format.py`** and is exercised through `execute()`.

### Sealer / verifier surface

1. **Sealer:** `MigrateFormatCommand._seal_block(block, crypto, hash_key=None)` — the ONLY place a
   new block seal is produced when re-stamping a ledger. Phase 2 reruns today through
   `compute_seal(crypto, block)` (routed there during Ph-1 Python P4) → `select_seal_fields(block)`
   → the per-type ADR-029a whitelist. `_block_hash_key` maps `type → {block_hash, day_hash,
   month_hash, year_hash}` and is the validation gate for unknown block types.
2. **Verifier:** `LedgerChain.verify()` (Python) — the acceptance gate a migrated ledger must pass
   (129/129 inline, and `chain.verify()` on the written output).
3. **Standalone mirror:** none — `migrate-format.py` calls `MigrateFormatCommand.execute()`.

### The coverage gap this phase closes

`tests/test_migrate_format.py` (17 tests) covers format_version bump, `original_hash`/
`original_entry_hash` provenance, `prev_hash` linkage, content-hash recomputation, path modes and
edge cases — but it **never asserts that the emitted seals are computed over the canonical
whitelist**. It does not recompute the expected seal from `select_seal_fields()` and compare, nor
assert that excluded fields (`format_version`, `key_version`, `identity`, `identity_seal`,
`signature`) are NOT sealed, nor assert `original_hash` is sealed when present. Those assertions
lock the migration to the closed ADR-029 set and guard against silent regression to the old
open-set-minus-exclusions sealer.

### Target contract (mirror of Python `domain/ledger/chain.py` SEAL_FIELDS)
```
SEAL_FIELDS = {
    "genesis":       {type, day_index, date, prev_hash, entries, original_hash},
    "day":           {type, day_index, date, prev_hash, entries, original_hash},
    "month_summary": {type, month, date, prev_hash, original_hash},
    "year_summary":  {type, year, date, prev_hash, original_hash},
}
```
- **Closed set:** seal = HMAC-SHA256 over exactly the per-type fields *present*,
  `json.dumps(select_seal_fields(block), sort_keys=True)`, via `compute_seal`.
- **Never sealed:** `format_version`, `key_version`, `identity`, `identity_seal`, `signature`,
  all hash keys (`block_hash`/`day_hash`/`month_hash`/`year_hash`/`hash`), stray/client fields.
- **`original_hash`** is sealed **when present** (every migrated/re-stamped block carries it).
- **Unknown block type** → `compute_seal` raises `ValueError` (verification-invalid).

---

## Test Groups

### Group A: Day-block seal-input whitelist — ~7 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Migrated day `day_hash` equals HMAC over `select_seal_fields(block)` sorted-JSON | Seal is the canonical whitelist | Recomputed seal must match — proves the migration re-stamped to the 6-field set, not open-set |
| A2 | For a day block carrying `format_version`, `key_version`, `signature`, the seal is UNCHANGED by mutating those | Closed set | If any excluded field entered the seal, tampering it would break the seal → false positive |
| A3 | For a day block, the seal input contains exactly the 6 whitelist fields | Exact set | Re-derive `select_seal_fields(block)` keys == `{type, day_index, date, prev_hash, entries, original_hash}` |
| A4 | `original_hash` is present in the migrated day block and is sealed | Provenance authenticated | Migration preserves the pre-migration seal in `original_hash` (existing P1) AND covers it in the new seal |
| A5 | A day block WITHOUT `original_hash` (legacy/new) still seals validly | Optionality | `original_hash` sealed when present; absence must not break the whitelist seal |
| A6 | `original_entry_hash` does NOT enter the block seal | Entry vs block layer | Entry provenance is content-hash (ADR-005) territory; the *block* seal only covers 6 block fields |
| A7 | Every migrated day block in a multi-day chain re-seals under the whitelist (spot-check each index) | Whole-chain coverage | A single block passing is not enough; the re-stamp must be uniform across all blocks |

### Group B: Genesis seal-input whitelist — ~5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Migrated genesis `block_hash` == HMAC over `select_seal_fields(genesis)` sorted-JSON | Canonical genesis seal | `identity`, `format_version`, `key_version` must NOT affect the genesis seal — mirrors Ph-2 Web genesis fix |
| B2 | Genesis seal excludes `identity` | Closed set (#2) | The identity object must stay out of the seal (cross-client parity requirement) |
| B3 | Genesis seal excludes `format_version`/`key_version` | Closed set | These change on migration/rotation and must not invalidate the seal |
| B4 | Genesis `original_hash` equals the pre-migration `block_hash` and is sealed | Provenance | Matches existing P1 behaviour for genesis (already saved) and locks `original_hash` into the seal |
| B5 | Genesis `identity_seal` (if recomputed) does not affect `block_hash` | Two-layer auth | Identity seal is a MAC over the block hash, a separate layer — never part of block seal |

### Group C: Summary-block seal-input whitelist — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Migrated `month_summary` `month_hash` == HMAC over `select_seal_fields` = `{type, month, date, prev_hash, original_hash}` | Summary parity (D5) | Month is a partition-identity trust anchor — must be sealed; open-set fixture fields excluded |
| C2 | Migrated `year_summary` `year_hash` == HMAC over `{type, year, date, prev_hash, original_hash}` | Summary parity (D5) | Year anchor enters the seal; stray fixture fields (`month_index`/`day_count`) never do |
| C3 | Summary seal is UNCHANGED by adding a stray fixture field (e.g. `day_count`) | Closed set | Guards the old test-fixture regression where stary fields were in the summary seal |
| C4 | Summary `prev_hash` is sealed and point to the previous block's new hash | Chain linkage | Re-seal must use the *updated* prev_hash; a stale prev_hash breaks verify() |

### Group D: End-to-end acceptance + closed-set guard — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `chain.verify()` on a migrated multi-type ledger returns True (0 failures) | The 0/129 fix | The whole point: migrated ledger verifies under the canonical verifier |
| D2 | `chain.verify()` fails when a migrated block seal is tampered | Verification integrity | Proves the emitted seal is actually *enforced*, not vacuously accepted |
| D3 | Migrated block seal (`compute_seal`) is UNCHANGED when an excluded field (`format_version`/`key_version`/stray) is added or mutated | Closed-set guard (seal-level) | Confirms excluded fields are truly inert w.r.t. the block seal. **Tested at the `compute_seal` level, NOT `chain.verify()`** — verify() gates on format_version/key_version/content-hash separately and would reject added stray fields for unrelated reasons |
| D4 | A migrated block whose ONLY change is an excluded field still passes `chain.verify()` (True) | Closed-set / block-integrity | Complement of D3 at the chain level: mutating a *present* excluded field must not invalidate the chain (probed: changing genesis `format_version`/`key_version` still verifies, since neither is sealed nor a hard verification input) |

> **Design note (from probe):** migrated day blocks carry NO `format_version`/`key_version` (only genesis does). So D4 targets the genesis block (the only migrated block that retains excluded fields), while D3 is generic at the seal level. Whole-chain tamper of non-sealed block fields may fail for non-seal reasons — keep those out of D3/D4.

### Group E: `_seal_block` helper contract — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `_seal_block` routes through `compute_seal`/`select_seal_fields` (result == manual whitelist recompute) | Shared single entry point | Proves the migrator does NOT keep its own diverging sealer |
| E2 | `_seal_block(unknown_type)` raises `ValueError` | Unknown-type rejection | Matches `select_seal_fields` raising; verification-invalid |
| E3 | `_block_hash_key` maps `{genesis→block_hash, day→day_hash, month_summary→month_hash, year_summary→year_hash}` | Canonical hash-key mapping | This mapping drives prev_hash linkage and seal field logic |
| E4 | `_block_hash_key(unknown_type)` returns `None` | Unknown-type sentinel | Because `hash_key is None` triggers the ValueError in `_seal_block` |

---

## Coverage Summary

| Group | Area | Tests | RED expected |
|-------|------|-------|--------------|
| A | Day-block seal-input whitelist | 7 | 7 |
| B | Genesis seal-input whitelist | 5 | 5 |
| C | Month/year summary seal-input whitelist | 4 | 4 |
| D | End-to-end verify() acceptance | 4 | 4 |
| E | `_seal_block`/`_block_hash_key` helper contract | 4 | 4 |

### Group F: Unknown / unsealable block-type safety (found in P2 probing) — ~2 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `execute()` on a ledger with an unknown block type returns `False` (or raises cleanly) and does NOT change the input file | No corrupting partial write | Currently the write happens before the ValueError escapes & no restore runs — the file is left with format_version 0.4.0 and an unsealed block. Migration must reject before touching the ledger |
| F2 | The failing migration does not leave a partially-migrated ledger on disk (input bytes identical) | Atomicity / backup guarantees | D5/D9 safety: a failed migration must be a no-op on the input ledger, with any backup being the only artifact |

**Total assertions: 26** across groups A–F. (26 = A:7 + B:5 + C:4 + D:4 + E:4 + F:2)

- **Coverage leaders:** closed-set exclusion (A2, A5, B2, B3, C3, D3/D4), provenance coverage
  (A4, B4), whole-chain uniformity (A7, C4, D1), shared-sealer routing (E1).
- **Explicitly out of scope:** entry-level content_hash (ADR-005 — independent layer, already
  covered by P3/P1 tests), the standalone `migrate-format.py` (pure wrapper, no sealing logic), and
  Phase 5 PHPSPEC / Phase 6 cross-client vectors (separate phases).

> **Note on RED:** the migration sealer already routes through `compute_seal`, so most seal-content
> assertions (A1, B1, C1, E1) pass immediately and are GREEN as behavior already locked by existing
> code — they remain valuable as regression guards but aren't RED. The genuinely RED assertions:
> - **Group F (new, found during P2 probing):** an unknown/unsealable block type currently causes a
>   **corrupting write-then-raise** — Phase 2 silently skips sealing it (`if hk:` guard), writes the
>   partially-migrated ledger (format_version already bumped to 0.4.0) to disk, THEN `chain.verify()`
>   raises `ValueError` which escapes before restore. The input ledger is left modified/corrupted and
>   no restore runs. This is the real RED anchor we fix in Phase 3 (fail cleanly *before* writing).
> - **D2/E2/E4** (enforcement / unknown-type contract) lock behavior no existing test checks.
> Phase 3 closes this gap. This matches the plan's P4 REFACTOR goal ("dedupe sealer shared with
> chain.py if applicable") and the P3 already shows the sealer was routed to `compute_seal` during
> Ph-1 Python P4.
