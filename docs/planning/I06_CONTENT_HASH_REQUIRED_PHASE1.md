# I-06: Make `content_hash` Required at v0.4.0+ — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md I-06
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

`content_hash` is a SHA-256 hash of an entry's plaintext fields, computed during
`commit()` and stored in `entry.data.content_hash`. It survives re-encryption
(key rotation) because it hashes decrypted values.

**Current behavior:** Verification skips content_hash if absent. The spec says:
"If `content_hash` is absent, skip this check (legacy entries)."

**Target behavior:** At `format_version >= "0.4.0"`, verification MUST fail if
`content_hash` is absent from any entry in a day block.

`format_version` is stored in the genesis block (block 0). It is excluded from
seal computation (I-07). Absence implies v0.2.0 (pre-spec).

### Modules affected

| Module | File | Change |
|--------|------|--------|
| Python chain verify | `domain/ledger/chain.py` | Gate content_hash check on format_version from genesis |
| Web chain verify | `phpoc-web/src/ledger/chain.js` | Add content_hash check with format_version gating |
| Web merge verify | `phpoc-web/src/ledger/merge.js` | Same addition (kept in sync with chain.js per code comments) |
| Spec | `docs/spec/PHPSPEC.md` §6 | Remove "skip if absent" language; require at ≥ 0.4.0 |

### Key design decisions

1. **format_version lives in genesis (block 0).** Verification must read block 0
   to determine whether content_hash is required. If there is no genesis block
   (empty ledger), verification passes trivially — no entries to check.

2. **Semver comparison.** `"0.4.0"` is a dot-separated triple. Comparison must
   handle absent format_version (implicit `"0.2.0"`) and parse segments as ints.
   Use the existing convention in `compat/v0_3_0.py` if one exists.

3. **Both Python and JS must agree.** The verification contract must be identical.
   Tests will include cross-implementation consistency assertions.

4. **content_hash is still computed for all new entries.** `commit()` in both
   implementations already computes content_hash unconditionally. The only gap
   is verification — old entries that were committed before content_hash existed.

---

## Test Groups

### Group A: Python `chain.py` — content_hash required at ≥ 0.4.0 — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Entry without `content_hash` at `format_version="0.4.0"` → verification fails | Core behavior: content_hash is required at 0.4.0+ | This is the primary behavior change — closing the "optional" gap |
| A2 | Entry with valid `content_hash` at `format_version="0.4.0"` → verification passes | content_hash still works correctly when present | Regression guard — existing valid entries must still pass |
| A3 | Entry with wrong `content_hash` at `format_version="0.4.0"` → verification fails | Tampered content_hash is always rejected | Integrity is the whole point of content_hash |
| A4 | Entry without `content_hash` at `format_version="0.3.0"` → verification passes (backward compat) | Pre-0.4.0 ledgers retain backward compatibility | Migration safety — existing ledgers must not break |
| A5 | Entry with valid `content_hash` at `format_version="0.3.0"` → verification passes | content_hash still verified when present | content_hash was optional but already computed — it should verify |
| A6 | Entry without `content_hash` at absent format_version (implicit 0.2.0) → passes | No format_version = pre-spec, content_hash optional | Backward compat for oldest ledgers |
| A7 | Genesis block with `format_version` present but no day entries → verify passes | Empty ledger chain is always valid | Edge case — format_version exists but no entries to check |
| A8 | `format_version="0.4.0"` correctly gates (comparison edge: "0.10.0" > "0.9.0") | Numeric semver comparison, not string | "0.10.0" > "0.9.0" requires segment-wise int comparison |

### Group B: Web `chain.js` — content_hash verification — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Entry without `content_hash` at `format_version="0.4.0"` → `_verifyBlockData` returns false | JS mirrors Python behavior | Cross-platform consistency |
| B2 | Entry with valid `content_hash` at `format_version="0.4.0"` → `_verifyBlockData` returns true | JS content_hash check works | Regression guard |
| B3 | Entry with wrong `content_hash` at `format_version="0.4.0"` → `_verifyBlockData` returns false | Tampered content_hash rejected | Integrity |
| B4 | Entry without `content_hash` at `format_version="0.3.0"` → `_verifyBlockData` returns true | Backward compat in JS | Migration safety |
| B5 | Entry without `content_hash` at absent `format_version` → `_verifyBlockData` returns true | pre-spec backward compat | Oldest ledger format |
| B6 | Full `verify()` on chain with 0.4.0 genesis and entry without content_hash → returns false | Integration-level check through the public API | Tests the full path from genesis extraction through verify |

### Group C: Web `merge.js` — content_hash verification — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Entry without `content_hash` at `format_version="0.4.0"` → merge `_verifyBlockData` returns false | Merge module mirrors chain.js | Duplicate implementation must stay in sync (per code comments) |
| C2 | Entry with valid `content_hash` at `format_version="0.4.0"` → merge `_verifyBlockData` returns true | Merge content_hash check works | Regression guard |
| C3 | Entry with wrong `content_hash` at `format_version="0.4.0"` → merge `_verifyBlockData` returns false | Tampered content_hash rejected | Integrity |
| C4 | Entry without `content_hash` at `format_version="0.3.0"` → merge `_verifyBlockData` returns true | Backward compat in merge | Migration safety |
| C5 | Entry without `content_hash` at absent `format_version` → merge `_verifyBlockData` returns true | pre-spec backward compat | Oldest ledger format |
| C6 | `_verifyChain("remote", chain, ...)` with 0.4.0 genesis and entry without content_hash → throws | Integration-level: merge rejects invalid remote chain | Prevents merging chains with missing content_hash |

### Group D: Cross-implementation consistency — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Same chain (0.4.0, entry without content_hash) rejected by both Python and JS | Both implementations agree on rejection | Prevents drift between platforms |
| D2 | Same chain (0.4.0, entry with valid content_hash) accepted by both Python and JS | Both implementations agree on acceptance | Prevents false negatives |
| D3 | `chain.js._verifyBlockData` and `merge.js._verifyBlockData` produce identical results for same input | Duplicate implementations stay in sync | Existing R5 test group already covers this — extend with content_hash cases |

### Group E: Spec & documentation — ~2 assertions

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | PHPSPEC.md §6 "Validation rule" section requires content_hash at format_version ≥ 0.4.0 | Spec reflects new requirement | Single source of truth for all implementations |
| E2 | PHPSPEC.md §5.5 field table updates `content_hash` row from `⚠️` to `✅` for 0.4.0+ | Field requirement documentation is accurate | Implementers use the field table as reference |

### Group F: Edge cases — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Ledger with `format_version="0.4.0"` that has genesis only (no day blocks) → verify passes | No entries = no content_hash to check | content_hash is per-entry, not per-block. Empty chain is valid. |
| F2 | Ledger with `format_version="0.4.0"` where some entries have content_hash and some don't → verify fails on the first missing one | Mixed content can't slip through | An attacker could add entries without content_hash alongside legitimate ones |
| F3 | Multiple day blocks, first has content_hash, second doesn't (at 0.4.0) → verify fails at second block | Full chain scan catches all blocks | content_hash must be present in every entry, not just the first block |
| F4 | `format_version="0.4.0"` comparison edge: "0.40.0" (4-segment) vs "0.4.0" (3-segment) — numeric segment comparison handles both | Robust version parsing | Future-proof against unusual version strings (though spec only defines 3-segment) |

---

## Summary

| Group | Tests | Area |
|-------|-------|------|
| A | 8 | Python chain.py — format_version gating |
| B | 6 | Web chain.js — content_hash verification |
| C | 6 | Web merge.js — content_hash verification |
| D | 3 | Cross-implementation consistency |
| E | 2 | Spec & documentation |
| F | 4 | Edge cases |
| **Total** | **29** | |

### Key coverage areas:
- **Core behavior:** content_hash required at ≥ 0.4.0 (A1-A3, B1-B3, C1-C3)
- **Backward compat:** content_hash optional at < 0.4.0 and absent format_version (A4-A6, B4-B5, C4-C5)
- **Cross-platform parity:** Python/JS agreement, chain/merge duplication sync (D1-D3)
- **Edge cases:** Empty ledger, partial missing content_hash, version comparison (F1-F4)
- **Spec update:** Documentation must match behavior (E1-E2)
