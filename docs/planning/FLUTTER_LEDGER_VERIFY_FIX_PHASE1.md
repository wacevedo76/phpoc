# Flutter Ledger Verify & Commit Fix — Test Exploration (Phase 1)

> **Plan:** Separate 4-phase TDD workstream for 6 pre-existing Flutter ledger failures,
> tracked from `SESSION_HANDOFF.md` (out of the Ph-6 canonical-seal scope, which stays paused).
> **Purpose:** Blueprint every test assertion needed to fix the 6 pre-existing failures in
> `phpoc-flutter/test/data/ledger/` before writing code. After this workstream completes,
> resume Ph-6 Phase 4 (REFACTOR).
> **Status:** 🟢 Phase 3 (GREEN) DONE — all 12 tests GREEN; the 6 pre-existing failures (S1–S6: K2/K3/K4, F15, AE2/AE4) fixed. `test/data/ledger/` 279/279 GREEN.
> **Next Phase:** Phase 4 (REFACTOR)

## Scope — the 6 pre-existing failures

| # | Test | Assertion | Failing on | Location |
|---|------|-----------|-----------|----------|
| S1 | K2 | `chain.verify()` true for genesis+day | `chain.dart verify()` content-hash invariant | `chain_test.dart:1445` |
| S2 | K3 | CLI-created (Python indent2) blocks verify | same `verify()` path | `chain_test.dart:1468` |
| S3 | K4 | Web-created (JS no-space) blocks verify | same `verify()` path | `chain_test.dart:1522` |
| S4 | F15 | empty title/tags encrypted under `has_encrypted_fields` | `engine.dart:61` title validation | `engine_test.dart:348` |
| S5 | AE2 | commit does not insert duplicate summaries on legacy chain | `commit()` summary policy on date-less prev day | `engine_test.dart` (~1039) |
| S6 | AE4 | multiple commits on legacy chain → `chain.verify()` passes | `commit()` + `verify()` on date-less reconstruction | `engine_test.dart` (~1128) |

All six fail **identically before and after** the ADR-029a per-type seal port (verified via
`git stash`), i.e. they are **pre-existing**, unrelated to the canonical-seal work.

## Root causes

### Finding 1 — `verify()` content-hash invariant vs minimal fixtures (S1–S3)
`chain.dart verify()` (line 214) makes `content_hash` **required** on every day-entry when the
genesis `format_version >= 0.4.0` (`requireContentHash && !hasContentHash → return false`). K2/K3/K4
build day blocks through hand-rolled payloads (`{hash, data:{title, duration}}`) with **no
`content_hash`/encrypted fields**, so `verify()` rejects them. The seal layer itself is fine — the
fixtures are not producing 0.4.0-valid entries.

### Finding 2 — `engine.dart` rejects empty title before encryption (S4)
`engine.dart commit()` (line 61) throws `"Entry title must be a non-empty string"` for `title: ''`.
This blocks the encrypted-empty-field contract: F15 expects empty `title`/`tags` to be **encrypted**
(`title_enc`/`tags_enc`) when `has_encrypted_fields=true`, not rejected. The validation is too strict
for the encrypt-empty case (only F15 asserts the positive path).

### Finding 3 — summary policy + `commit()` integration on date-less legacy day blocks (S5/S6)
The policy unit (`YearMonthSummaryPolicy.getSummaryBlocks`) already handles a missing/`1970-01-01`
`date` gracefully — the `AD1–AD3` tests in `summary_policy_test.dart` **pass**. But AE2/AE4 fail at
the **integration** level: `commit()` passes a date-less previous day block into the policy in a way
that still yields a **duplicate/malformed summary block** (AE2 `verify()` false at line 1039) and a
**chain that fails `engine.verify()`** (AE4 line 1128). The AD-unit coverage does not extend to the
full `commit()` path with a date-less prev block already in the store.

## Coverage assessment (from Ph-1 exploration)

| Area | Existing coverage | Gap |
|------|-------------------|-----|
| `verify()` content-hash (S1–S3) | K1–K6 (but minimal fixtures), F6 (`commit` produces content_hash) | No **positive** verify test with valid content_hash/encryption; K-fixtures malformed |
| commit validation / empty-title encryption (S4) | F1–F4, F6/F9/F10/F12, F15 | Adequate — F15 is the lone positive; clean code bug |
| summary policy on date-less (S5/S6) | AD1–AD3 (**pass**, policy unit), AE1–AE4 (integration) | Unit covered; integration `commit()` path broken |

## Test Groups

### Group A: Commit validation — empty-title encryption — ~3 tests
Contract: `commit()` must encrypt empty `title`/`tags`/`comment` when `has_encrypted_fields=true`,
not reject them, while still rejecting truly invalid (non-string/whitespace-only) titles elsewhere.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `commit()` encrypts empty `title` (→ `title_enc` present) when `has_encrypted_fields=true` | Fix the S4 rejection | The exact F15 contract broken at engine.dart:61 |
| A2 | `commit()` encrypts empty `tags` (→ `tags_enc` present) when `has_encrypted_fields=true` | Same contract for tags | Tags/comment share the empty-encryptable field set |
| A3 | `commit()` still rejects non-string / whitespace-only `title` (validation preserved) | Guard the strict path | Must not over-loosen validation into accepting malformed titles |

### Group B: `commit()` integration on date-less legacy chain — ~3 tests
Contract: committing around a date-less (reconstructed) prev day block must not insert duplicate
summaries and must leave the chain `verify()`-able.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `commit()` does not insert a **duplicate** `month_summary` when one already exists (count grows by exactly 1 for the new day block) | Fix S5 count/verify | AE2's block-count + no-duplicate assertion |
| B2 | After committing around a date-less prev day block, `engine.verify()` / `chain.verify()` returns true | Fix S5 verify | AE2 line 1039 |
| B3 | Multiple commits across a month boundary on a reconstructed (date-less) chain leave `verify()` true with no crash | Fix S6 | AE4 line 1128 |

### Group C: Full-chain `verify()` with valid 0.4.0 content — ~3 tests
Contract: a day block built with **valid `content_hash` + encrypted fields** verifies through
`chain.verify()` with a 0.4.0 genesis — proving the content-hash invariant is satisfiable, not a
dead-end.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | A day block with valid `content_hash` (+) and 0.4.0 genesis verifies through `chain.verify()` | Positive content-hash verify proof | Closes the K2 gap — proves the invariant is satisfiable |
| C2 | A CLI-style block (indent2 seal, valid `content_hash`) verifies through `chain.verify()` | Cross-client verify parity | Closes the K3 gap |
| C3 | A Web-style block (no-space seal, valid `content_hash`) verifies through `chain.verify()` | Cross-client verify parity | Closes the K4 gap |

**Note on fixtures:** C1–C3 are deliberately written against **valid 0.4.0 entries** (the fix target),
either reusing `commit()`'s encryption path or constructing `content_hash` per the algorithm. If the
GREEN fix is a fixture correction, these become the correct fixtures; if the code (`buildDayBlock`/
`commit`) needs to emit `content_hash` when missing, they pin that behavior.

### Group D: Regression guards (existing behavior preserved) — ~3 tests
Ensure the fixes do not regress the already-GREEN surface.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Existing AD1/AD2/AD3 (null/`1970-01-01`/missing date handling) still GREEN | Policy-unit safety | Guards the summary-policy fix in group B |
| D2 | Non-empty-title encryption (F6/F9/F10/F12) still GREEN | Commit-path safety | Guards the validation change in group A |
| D3 | Tamper detection (K5/K6: tampered seal / broken prev_hash → `verify()` false) still GREEN | Verify-path safety | Guards the verify-path change/cleanup in group C |

---

## Fix map (implementation targets for Phase 3, after RED)

- **A1–A3 (S4):** `phpoc-flutter/lib/data/ledger/engine.dart` `commit()` validation — allow
  empty `title`/`tags` through when `has_encrypted_fields=true` (still encrypt), keep rejecting
  non-string/whitespace-only.
- **B1–B3 (S5/S6):** `phpoc-flutter/lib/data/ledger/engine.dart` + `summary_policy.dart` —
  make `commit()` resilient to a date-less prev day block so the policy does not fabricate a
  `1970-01-01` period, no duplicate summaries, and the chain stays `verify()`-able.
- **C1–C3 (S1–S3):** `phpoc-flutter/lib/data/ledger/chain.dart` (`buildDayBlock`/`commit`) ensure
  valid `content_hash` on 0.4.0 entries; correct the K-fixtures to produce 0.4.0-valid entries.
  (Fix decision deferred to RED implementation.)
- **D1–D3:** test-only guards; no source change expected.

---

## Summary Report

- **Total assertions:** 12
- **By group:** A = 3 (empty-title encryption), B = 3 (date-less commit integration), C = 3
  (positive content-hash verify), D = 3 (regression guards)
- **Key coverage areas:** the 6 pre-existing failures (S1–S6) each mapped to a concrete fix,
  with regression guards (D) protecting the already-GREEN AD/F/K surface.
- **Files (Phase 3 targets):** `engine.dart`, `summary_policy.dart`, possibly `chain.dart`, plus
  test files.

## Files

- **New:** `docs/planning/FLUTTER_LEDGER_VERIFY_FIX_PHASE1.md` (this blueprint)
- **Phase 2 (RED):** `phpoc-flutter/test/data/ledger/ledger_verify_fix_test.dart` — 12 tests (A–D), 6 RED / 6 GREEN, `flutter analyze` clean ✅
- **Phase 3 (GREEN):** `engine.dart`, `summary_policy.dart`, (+`chain.dart` if needed)
- **Phase 4 (REFACTOR):** review these files.
