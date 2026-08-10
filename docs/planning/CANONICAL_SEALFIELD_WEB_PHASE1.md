# Web Block-Seal Field Whitelist — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` Phase 2 (Web `chain.js`)
> **Purpose:** Blueprint of all assertions needed to converge the Web sealer/verifier onto
> the canonical ADR-029/029a 6-field block-seal whitelist, matching the already-complete
> Python reference (plan Phase 1).
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

The Web ships two code paths that seal/verify block seals:

1. **Sealers** (produce the block's HMAC-SHA256 seal):
   - `LedgerChain.buildDayBlock()` (`phpoc-web/src/ledger/chain.js`) → `day_hash` over `{type, day_index, date, prev_hash, entries}`
   - `LedgerChain.buildGenesisBlock()` (`chain.js`) → `block_hash`
   - `summary_policy.js` `makeYearSummary`/`makeMonthSummary` → `year_hash`/`month_hash`

2. **Verifiers** (reconstruct the seal input and compare):
   - `LedgerChain._verifyBlockData()` (`chain.js`)
   - `LedgerMerge._verifyBlockData()` (`merge.js`) — **documented as intentionally duplicated**

Today all of these use the **open-set-minus-exclusions** convention: the seal input is
*every present field* except `{hashKey, signature, identity_seal}`. The plan (Phase 2)
calls this the latent divergence: Web seals/verifies over `format_version`, `key_version`,
and stray/client-specific fields too — whereas Python's closed whitelist never touches them.

### Target contract (mirror of Python `domain/ledger/chain.py` SEAL_FIELDS)
```
SEAL_FIELDS = {
    "genesis":       {type, day_index, date, prev_hash, entries, original_hash},
    "day":           {type, day_index, date, prev_hash, entries, original_hash},
    "month_summary": {type, month, date, prev_hash, original_hash},
    "year_summary":  {type, year, date, prev_hash, original_hash},
}
```
- **Closed set:** the seal is HMAC over exactly the per-type fields *present*, sorted with
  `jsonSort` (= Python `json.dumps(..., sort_keys=True)`).
- **Never sealed:** `format_version`, `key_version`, `identity`, `identity_seal`,
  `signature`, all hash keys (`day_hash`/`block_hash`/`month_hash`/`year_hash`/`hash`),
  and any stray/future/client field.
- **`original_hash`** (migration provenance): sealed when present; its absence must not
  break verification (pre-0.4.0 / new blocks).
- **Unknown block type** → verification-invalid (reject), like `select_seal_fields` raising.
- **Content-hash (ADR-005) stays untouched** — `_verifyContentHash` is an independent layer.

New helpers to add on the Web (mirror Python):
- `selectSealFields(block)` → the whitelisted seal-input object (rejects unknown type)
- `computeSeal(block, crypto, masterKey)` → `crypto.seal(jsonSort(selectSealFields(block)), masterKey)`

## Test Groups

### Group A: Whitelist selection & constant — ~8 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `SEAL_FIELDS` constant exists and is the per-type map (4 keys) | Contract anchor | Web must expose the same single source of truth as Python/Flutter |
| A2 | `genesis`/`day` set == {type, day_index, date, prev_hash, entries, original_hash} | Day/genesis parity | Mirrors Python `SEAL_FIELDS["genesis"]`/`["day"]`; a migrated day/geneces block must verify identically |
| A3 | `month_summary` set == {type, month, date, prev_hash, original_hash} | Summary parity (D5) | Month is a partition-identity trust anchor — must be sealed |
| A4 | `year_summary` set == {type, year, date, prev_hash, original_hash} | Summary parity (D5) | Year is a partition-identity trust anchor — must be sealed |
| A5 | No excluded metadata/hash-key field appears in any set | Closed set | `format_version`, `key_version`, `identity`, `identity_seal`, `signature`, `*.hash` never sealed |
| A6 | Summaries carry no `day_index`/`entries` in their seal set | Real summary shape | Python's per-type rows differ for summaries; must match |
| A7 | `selectSealFields` keeps only present whitelist fields; scopes out the hash key | Selection correctness | The seal input must be exactly the whitelist, absent hash keys |
| A8 | `selectSealFields` rejects an unknown block type (throws) | Closed-set rejection | Unknown types are verification-invalid (matches `select_seal_fields`) |

### Group B: Sealer convergence — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `buildDayBlock` seal equals `computeSeal` over the day whitelist (+stray metadata no-op) | Sealer → shared helper | Same entry/prev/date must yield the same `day_hash` regardless of stray fields (A5 behavior at sealer) |
| B2 | `buildGenesisBlock` seal equals `computeSeal` over the genesis whitelist | Genesis sealer convergence | Genesis must seal the same 6 fields as Python |
| B3 | A day block re-sealed by `computeSeal` (with an injected otherwise-ignored `format_version`) still `verify()`s | format_version exclusion | The Python-written/sealed ledger must verify on Web after migration tooling attaches format_version |
| B4 | When a day block carries `original_hash` (migrated style), `verify()` succeeds — sealer/verifier include it | Migration provenance | Migrated 0.4.0 blocks (original_hash present) must verify on Web |
| B5 | A day block **without** `original_hash` still verifies | Absent-original_hash tolerance | New / pre-0.4.0 blocks must not break |
| B6 | Summary sealers (`makeMonthSummary`/`makeYearSummary`) seal {type, month\|year, date, prev_hash} — tampered `month`/`year` breaks seal | Summary sealer convergence | Partition-identity sealed at build time (D5) |

### Group C: Verifier convergence (`chain.js`) — ~7 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | A whitelist-sealed `{genesis}` chain verifies | Genesis verify | Baseline |
| C2 | A whitelist-sealed `{genesis, day}` chain verifies | Day verify | Baseline |
| C3 | A whitelist-sealed `{genesis, day, month_summary, year_summary}` chain verifies | All-types verify | Full partition chain converge |
| C4 | A block sealed **including** a stray `foo` field is **rejected** | Closed whitelist at verify | The open-set verifier (old code) accepted it; new verifier must reject divergent seal (A2-equivalent) |
| C5 | A block with a stray `foo` field present but **not sealed** still verifies | Closed whitelist tolerance | Stray non-whitelisted field must not break a whitelist-sealed block |
| C6 | Tampering a sealed whitelist field (`entries`, `month`, `year`, `date`) breaks the seal | Tamper detection | Any whitelisted field mutation must fail verify |
| C7 | `format_version`/`key_version` present on the block and **not** sealed → still verifies (seal computed by Python) | format_version exclusion fix | Proves the latent Web exclusion bug is fixed |

### Group D: Verifier convergence (`merge.js` duplicate) — ~3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `LedgerMerge._verifyBlockData` rejects the same stray-sealed block (parity with chain.js) | Duplicate-path parity | The documented duplicated verifier must not drift from chain.js |
| D2 | `LedgerMerge._verifyBlockData` accepts the whitelist-sealed chain over all 4 types | Duplicate-path parity | Both verifiers accept identical valid chains |
| D3 | `LedgerMerge` refactor so `merge.js` and `chain.js` share the `selectSealFields`/`computeSeal` source | DRY the duplicate | Prevents future divergence of the two copied verifiers |

### Group E: Regression guards — ~3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Content-hash verification (ADR-005) still works on a whitelist-sealed day block | Content-hash untouched | The seal change must not regress entry content_hash |
| E2 | Identity seal (`identity_seal`) verification still works (added after sealing) | Identity layer untouched | identity_seal is excluded from the seal but still authenticated separately |
| E3 | Existing well-formed chains built by the open-set sealer still verify (no stray fields) | Backward compat | Blocks whose seal inputs happen to equal the whitelist must continue to pass |

## Summary Report

| Group | Name | Tests |
|-------|------|-------|
| A | Whitelist selection & constant | 8 |
| B | Sealer convergence | 6 |
| C | Verifier convergence (`chain.js`) | 7 |
| D | Verifier convergence (`merge.js`) | 3 |
| E | Regression guards | 3 |
| **Total** | | **27** |

### Test environment
- Single file: `phpoc-web/test/chain_seal_whitelist_test.mjs` (run `node test/chain_seal_whitelist_test.mjs`)
- Uses `TestHelpers` (`test_helpers.mjs`) + `MockCrypto` (`mock_crypto.mjs`) + `MemoryBackend` (`src/sync/storage.js`)
- Future (Phase 3) source changes: `chain.js`, `merge.js`, `summary_policy.js`, optionally a new
  `seal_fields.js` module to host the shared `SEAL_FIELDS`/`selectSealFields`/`computeSeal`.

### Cross-client oracle
The 27 assertions mirror the already-GREEN Python suite `tests/test_chain_seal_whitelist.py`
(A1–A8, B1–B5, C1–C7, D1–D3, E1–E3). Byte-parity is guaranteed by `jsonSort` == Python
`json.dumps(..., sort_keys=True)` (already used across the Web ledger). Phase 6 of the plan
will lock these on shared canonical vectors.

## Files (planned for this Web phase)
- `docs/planning/CANONICAL_SEALFIELD_WEB_PHASE1.md` (this blueprint)
- `phpoc-web/test/chain_seal_whitelist_test.mjs` *(RED, Phase 2)*
- `phpoc-web/src/ledger/seal_fields.js` — shared `SEAL_FIELDS`/`selectSealFields`/`computeSeal` *(Phase 3)*
- `phpoc-web/src/ledger/chain.js`, `merge.js`, `summary_policy.js` — route sealer/verifier through it *(Phase 3)*
- `docs/design/CANONICAL_SEAL-FIELD_Design.md` — note Web convergence in the matrix *(Phase 4)*
- `docs/planning/AGENTS.md` / `docs/reference/MAP.md` / `SESSION_HANDOFF.md` — status updates
- `docs/planning/BACKLOG.md` — mark Web phase complete when done
