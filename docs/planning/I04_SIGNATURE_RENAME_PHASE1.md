# I-04: Rename HMAC "signature" → "seal"/"tag" — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §Step 2 — I-04
> **Flaw doc:** `docs/design/flaws/ISSUES_TO_ADDRESS.md` — Step 2 (naming fixes)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration) → 🔜 Phase 2 (RED: test definition) complete
> **Next Phase:** Phase 3 (GREEN: implementation)

## Architecture Overview

I-04 eliminates misleading "signature" terminology throughout the codebase. The word
"signature" implies asymmetric public-key properties (Ed25519), but PHPOC uses
symmetric HMAC-SHA256. Renaming to "seal" (integrity) and "MAC/tag" (identity) removes
this confusion before real Ed25519 is added.

### Implementation Status (pre-I-04 from I-01 key rotation)

| Area | Status | Detail |
|------|--------|--------|
| Method rename: `sign()` → `mac()` | ✅ Done | `crypto.py`: `mac()` + `verify_mac()` exist |
| Method rename: `verify_signature()` → `verify_mac()` | ✅ Done | Abstract base + both implementations |
| Block field name: `identity_seal` | ✅ Done | `build_day_block()` produces `identity_seal` (Python + JS) |
| Dual field acceptance | ✅ Done | `identity_seal \|\| signature` in `chain.py`, `chain.js`, `merge.py` |
| Old method cleanup | ✅ Done | No `sign()` / `verify_signature()` on any class |
| Phase 2 tests (Groups A–E) | ✅ GREEN | 22/22 `test_naming_i04.py` |

### Remaining Work

| File / Area | Change | Impact |
|-------------|--------|--------|
| `security/crypto.py` | Rename `signature` parameter → `seal_hex` in `verify_seal()` (abstract base, JS bridge, seal impl, NoAuth) — 4 locations | ~20 test files calling `verify_seal(..., signature)` |
| `domain/ledger/chain.py` | Rename `signature` parameter in `verify_seal()` | 1 location |
| `docs/spec/PHPSPEC.md` | Rename `signature` field → `identity_seal` in tables, JSON examples, §5.3 (~10 occurrences) | Spec-only; no code impact |
| All test files | Update parameter name `signature` → `seal_hex` | ~12 test files with fake `verify_seal(self, data_str, signature)` |

## Test Groups

### Group F: CryptoManager verify_seal parameter rename — ~5 tests

Validates that `verify_seal` and `verifySeal` accept `seal_hex` parameter name.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `AbstractCryptoManager.verify_seal` uses `seal_hex` parameter | Interface contract uses correct terminology | Reveals the ABC still declares `signature` parameter — must rename before any subclass |
| F2 | `CryptoManager.verify_seal` uses `seal_hex` parameter | Production implementation uses correct terminology | 3 test files override this method with `signature` param — they break if not updated |
| F3 | `NoAuthCryptoManager.verify_seal` uses `seal_hex` parameter | Fallback implementation uses correct terminology | Consistency across all implementations |
| F4 | `verifySeal` (camelCase bridge) uses `seal_hex` parameter | JS bridge uses correct terminology | Called by `domain/ledger/merge.py` — must match |
| F5 | `verify_seal(seal_hex=...)` called with keyword arg works | Keyword invocation works after rename | Keyword callers in test files must use new name |

### Group G: LedgerChain verify_seal parameter rename — ~3 tests

Validates that `LedgerChain.verify_seal` accepts `seal_hex`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `LedgerChain.verify_seal` accepts `seal_hex` parameter | Chain layer uses correct terminology | Currently declares `signature: str` — the only caller-facing rename in domain/ |
| G2 | `LedgerChain.verify_seal(seal_hex=...)` delegates to crypto correctly | Pass-through works with new parameter name | Verifies `self.crypto.verify_seal(json.dumps(data), seal_hex)` |
| G3 | Old parameter name `signature` is absent from `verify_seal` | No stale parameter name remains | Completeness check — prevents partial rename |

### Group H: Spec field name accuracy — ~12 tests

Validates that PHPSPEC.md uses `identity_seal` consistently, never the legacy `signature` field name in block schemas.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | §4 Common Fields table: `identity_seal` not `signature` | Core block schema uses correct field name | First place a reader learns block structure |
| H2 | §4.1 Genesis JSON example: `identity_seal` field | Genesis example is correct | Schema example is copy-paste reference for implementers |
| H3 | §4.1 Genesis field table: `identity_seal` not `signature` | Genesis field docs are accurate | Field table defines the authoritative field name |
| H4 | §4.2 Year Summary JSON example: `identity_seal` field | Year summary example is correct | Summary block must match — protect against new Ed25519 confusion |
| H5 | §4.2 Year Summary field table: `identity_seal` not `signature` | Year summary field docs are accurate | Year and month tables often get missed in renames |
| H6 | §4.3 Month Summary JSON example: `identity_seal` field | Month summary example is correct | Same rationale as H4/H5 |
| H7 | §4.3 Month Summary field table: `identity_seal` not `signature` | Month summary field docs are accurate | Month table is symmetric with year table |
| H8 | §4.4 Day Block JSON example: `identity_seal` field | Day block example is correct | Primary data block — most commonly read schema |
| H9 | §4.4 Day Block field table: `identity_seal` not `signature` | Day block field docs are accurate | Matches what `build_day_block()` already produces |
| H10 | §5.2 Seal computation: excludes `identity_seal` + `{type}_hash`, never mentions `signature` | Seal exclusion docs are correct | The seal computation excludes the seal field itself — must reference correct name |
| H11 | §5.3 Identity seal explanation: uses "identity seal" / "MAC" terminology | Explanatory prose is correct | Reader-facing docs must not mislead about symmetric vs asymmetric |
| H12 | No `signature` field name remains in any block schema section | Completeness check | Git grep `signature` in §4, §5 of PHPSPEC.md — must return zero hits |

### Group I: Parameter consistency in test files — ~4 meta-tests

Validates that test files updated their fake `verify_seal` implementations after the rename.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | No test file defines `verify_seal(self, data_str, signature)` | All test fakes updated | Tests that mock verify_seal must use `seal_hex` parameter name |
| I2 | No test file defines `verifySeal(self, data_str, signature)` | All JS-bridge test fakes updated | CamelCase bridge must also be renamed |
| I3 | Test files calling `verify_seal(..., signature=...)` use `seal_hex=` keyword | All keyword callers updated | Keyword arg name must match parameter name |
| I4 | `test_naming_i04.py` Groups A–E still pass after parameter rename | No regression in method-rename tests | Existing 22 GREEN tests must stay GREEN |

### Group J: Dual-acceptance regression (backward compat) — ~4 tests

Validates that legacy `signature` JSON field still works after parameter renames.
These tests likely already pass (dual acceptance is already implemented).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | Day block with `signature` field validates via `identity_seal \|\| signature` | Legacy format still works | Users may have ledger files with old field names |
| J2 | Genesis with `signature` field validates | All block types covered | Genesis is most important — can't re-init |
| J3 | Block with both `signature` and `identity_seal` prefers `identity_seal` | Conflict resolution is deterministic | Prevents nondeterministic validation |
| J4 | Chain verification traverses mixed old/new field names | Full chain walk works | Real ledgers may have old genesis + new day blocks |

## Summary

| Group | Area | Assertions | Status |
|-------|------|-----------|--------|
| A–E | Method rename (sign→mac) | 22 | ✅ GREEN (from I-01) |
| F | CryptoManager parameter rename | 5 | 🔜 Needs tests |
| G | LedgerChain parameter rename | 3 | 🔜 Needs tests |
| H | Spec field name accuracy | 12 | 🔜 Needs tests |
| I | Test file consistency | 4 | 🔜 Needs tests |
| J | Dual-acceptance regression | 4 | ✅ Likely GREEN (existing) |
| **Total** | | **50** | **22 GREEN, 28 needed** |

## Files in Scope

| File | Role | Phase |
|------|------|-------|
| `security/crypto.py` | Rename `signature` → `seal_hex` in `verify_seal` (×3) + `verifySeal` (×1) | Phase 3 |
| `domain/ledger/chain.py` | Rename `signature` → `seal_hex` in `verify_seal` | Phase 3 |
| `docs/spec/PHPSPEC.md` | Rename `signature` → `identity_seal` in all block schemas (~10 occurrences) | Phase 3 |
| `tests/test_naming_i04.py` | Add Groups F–I tests | Phase 2 |
| `tests/*.py` (~12 files) | Update fake `verify_seal` parameter name | Phase 3 |
| `cli/*.py` (~5 files) | Update `"signature"` exclusion key → `"identity_seal"` (dual already there) | Phase 3 |
| `core/factory.py` | Update `"signature"` → `"identity_seal"` in genesis bootstrapping | Phase 3 |
