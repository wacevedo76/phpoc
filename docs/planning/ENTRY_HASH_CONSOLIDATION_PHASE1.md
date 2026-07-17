# Entry Hash Verification Consolidation — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §Phase 5 — Entry hash indent=2 consolidation
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 4 (REFACTOR) — COMPLETE
> **TDD:** 17/17 assertions GREEN across all 4 phases

## Architecture Overview

The codebase has four entry hash verification functions spread across two modules:

| Function | Module | Formats checked | Entry shape | Used by |
|---|---|---|---|---|
| `_verify_entry_hash_flex` | `domain/ledger/chain.py` | 3-way (sort+indent2, sort+compact, nosort+indent2) | Raw data dict + stored hash | `LedgerChain.verify()` |
| `_verify_ledger_entry_hash` | `cli/onboarding_file.py` | 2-way (sort+compact, sort+indent2) — **missing nosort+indent2** | Entry with `data` + `hash` keys | `_validate_raw_chain()` |
| `_verify_entry_hash` | `cli/onboarding_file.py` | 1-way (sort+compact, field subset) — **missing indent2** | Staging entry dict with `hash` key | `_import_v1()`, `_import_v2()` |
| `_verify_entry_hash_updated` | `cli/onboarding_file.py` | 1-way (sort+compact, all−hash−entry_index) — **missing indent2** | Staging entry dict with `hash` key | `_import_v1()`, `_import_v2()` |

**Problem:** `onboarding_file.py` functions use inline hash logic that duplicates `_verify_entry_hash_flex` and misses the nosort+indent2 legacy format. After cross-client canonicalization (`compute_entry_hash` uses sort+indent2), staging entry hashes produced by the web app and migrated chains use indent=2, but the onboarding verification functions only recognize sort+compact (no indent).

**Goal:** Replace inline checks with `_verify_entry_hash_flex` (for ledger entries) and add sort+indent2 support (for staging entries), so all three serialization formats are accepted during import.

## Test Groups

### Group A: `_verify_ledger_entry_hash` → 3-way — 8 tests

Consolidate `_verify_ledger_entry_hash` onto `_verify_entry_hash_flex` from `domain.ledger.chain`. The function wraps the flex call, handling the entry→data unwrapping and guard clauses.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Accepts sort+indent2 format (canonical) | Existing behavior preserved | Regressions caught immediately |
| A2 | Accepts sort+compact format (legacy CLI) | Existing behavior preserved | Pre-v0.4 ledgers still importable |
| A3 | Accepts nosort+indent2 format (old CLI + web) | **NEW** — the 3rd legacy format | Web-app-produced entries must verify |
| A4 | Rejects entry with flipped hash byte | Tamper detection | Security: one-byte corruption caught |
| A5 | Rejects completely random 64-char hash | False-positive prevention | Garbage hash never passes |
| A6 | Returns False for entry missing `data` key | Edge case guard | Malformed entries caught cleanly |
| A7 | Returns False for entry missing `hash` key | Edge case guard | Malformed entries caught cleanly |
| A8 | Entry with `content_hash` field still verifies | Field-edge | content_hash is part of data — must roundtrip |

### Group B: `_verify_entry_hash` → 2-way — 3 tests

Update `_verify_entry_hash` to accept both sort+compact (legacy) and sort+indent2 (canonical). This function hashes a subset of core staging DTO fields only.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Accepts sort+compact staging entry (legacy) | Existing behavior preserved | Pre-migration staging imports still work |
| B2 | Accepts sort+indent2 staging entry (canonical) | **NEW** — post-migration support | Entries recomputed by `compute_entry_hash` pass |
| B3 | Rejects tampered staging entry hash | Tamper detection on staging | Best-effort integrity still catches corruption |

### Group C: `_verify_entry_hash_updated` → 2-way — 3 tests

Update `_verify_entry_hash_updated` to accept both sort+compact and sort+indent2. This function hashes all fields minus `hash` and `entry_index`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Accepts sort+compact updated entry (legacy) | Existing behavior preserved | Entries from old `updateByEntryId()` pass |
| C2 | Accepts sort+indent2 updated entry (canonical) | **NEW** — post-migration support | Post-migration entries pass |
| C3 | Rejects tampered updated entry hash | Tamper detection on updated entries | Best-effort integrity still catches corruption |

### Group D: End-to-end import — 3 tests

Import flows exercise the verification functions end-to-end. These confirm that after consolidation, real import scenarios produce no spurious hash-mismatch warnings or errors.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | v1 import with sort+indent2 staging entries — no hash warnings | Post-migration staging import | Migrated staging files import cleanly |
| D2 | v2 import with mixed-format staging entries — no hash warnings | Mixed legacy+canonical import | Real-world imports with heterogeneous entries |
| D3 | Chain import with nosort+indent2 ledger entries — no hash errors | Full 3-way support in chain validation | `_validate_raw_chain` accepts all 3 formats |

## Summary

| Group | Focus | Tests | New assertions |
|-------|-------|-------|----------------|
| A | `_verify_ledger_entry_hash` → 3-way flex | 8 | A3 (nosort+indent2) |
| B | `_verify_entry_hash` → 2-way | 3 | B2 (sort+indent2) |
| C | `_verify_entry_hash_updated` → 2-way | 3 | C2 (sort+indent2) |
| D | End-to-end import | 3 | D1, D2, D3 (all new) |
| **Total** | | **17** | **6 new, 11 regression** |

**Key coverage areas:**
- All 3 serialization formats accepted in chain import (currently 2-way)
- All 2 canonical formats accepted in staging import (currently 1-way)
- Tamper detection preserved across all paths
- No regression on existing import behavior
