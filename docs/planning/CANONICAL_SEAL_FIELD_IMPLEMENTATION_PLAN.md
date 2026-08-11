# Canonical Seal-Field — Implementation Plan (Path C / ADR-029)

> **Plan:** Implement the canonical 6-field block-seal whitelist across all four
> implementations per **ADR-029** (✅ Adopted) and `docs/design/CANONICAL_SEAL-FIELD_Design.md`.
> **Purpose:** Converge Python / Web / Flutter / migration-tool on ONE block-seal contract so
> migrated 0.4.0 ledgers verify on every client (fixes the on-phone 0/129 verification failure).
> **Status:** In progress (Ph-5 PHPSPEC done; Ph-6 vectors & Ph-7 phone next)
> **Canonical whitelist:** `SEAL_FIELDS = { type, day_index, date, prev_hash, entries, original_hash }`

---

## 0. Scope & Ground Rules

- **Each of the 7 phases runs through the 4-Phase TDD workflow** (Phase 1 blueprint →
  Phase 2 RED → Phase 3 GREEN → Phase 4 REFACTOR) per `.pi/skills/tdd-four-phase`.
- **Contract anchor first:** Python `chain.py` + canonical test vectors lock the contract;
  Web and Flutter then match it; migration tool re-stamps to it last.
- **Ordering rationale:** Python is the reference verifier, so establishing it first (Phase 1)
  plus shared canonical vectors (Phase 6) gives Web/Flutter a concrete target to match.
- No verification may be weakened. Whitelist fields are a *closed set*: `format_version`,
  `key_version`, `identity`, `identity_seal`, `signature`, and any future metadata must stay
  out of the seal (see ADR-029).
- DOX pass required at every phase: update owning AGENTS.md docs, MAP.md, ROADMAP.md,
  SESSION_HANDOFF.md.
- **Git:** stage freely; never commit/push without explicit user approval (AGENTS.md).

### Delivery order & dependencies

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6 ──► Phase 7
(Python)   (Web)      (Flutter)   (Migrator)  (PHPSPEC)  (vectors)    (e2e phone)
                                   ▲              ▲           ▲            ▲
                                   │              │           └── needs 1-4  ┘
                                   └── needs 1    └───────────┘
```

Phases 1–4 are the code convergence. Phase 5 (spec) and Phase 6 (shared vectors) can largely
proceed in parallel with 1–4 once Python's contract is set. Phase 7 (re-migration + phone e2e)
depends on 1–6 being complete and GREEN.

---

## Phase 1 — Python verifier/sealer → 6-field whitelist (`domain/ledger/chain.py`)

**Goal:** Python's `_verify_block_seal` / sealer recognize exactly the 6 canonical fields.

- **[x] TDD P1** — blueprint seal assertions in `docs/planning/CANONICAL_SEALFIELD_PYTHON_PHASE1.md`
  (seals over 6 fields; excludes format_version/key_version/identity/signature/identity_seal/
  future fields; mixed blocks: genesis/day/month/year; original_hash present vs absent). (26 assertions, groups A–E)
- **[x] TDD P2 — RED** — new/updated tests in `tests/test_chain_seal_whitelist.py`. (type-aware per-type map; 30 tests GREEN after P3)
- **[x] TDD P3 — GREEN** — `chain.py` `SEAL_FIELDS` is now the per-type map (ADR-029a); `select_seal_fields` keys off `block['type']` (rejects unknown types); new `compute_seal` central helper; converged all ~13 seal sites across 8 files to the shared table. Fixture corrections applied (test summaries to real `{type, month|year, prev_hash, date}` shape; test-fixture `month_index`/`day_count`/`total_duration` removed). Full Python suite GREEN (2475).
- **[x] TDD P4 — REFACTOR** — extract `SEAL_FIELDS` constant; dedupe; keep prior content-hash
  all-keys logic untouched (ADR-005 unchanged). Routed remaining inline `crypto.seal(
  json.dumps(select_seal_fields(...), sort_keys=True))` sites through the shared `compute_seal`
  helper: `auth.py`, `onboarding.py` (genesis + loop), `onboarding_file.py` (genesis + loop),
  `rotate_keys.py` (uses `crypto_v2` — passes it as first arg), `migrate_format.py: _seal_block`.
  **Exception (unchanged):** `migrate.py` `_seal(..., integrity_key)` uses a per-chain integrity
  key (`_compute_integrity_key(mk)`), not a CryptoManager; not `compute_seal(crypto, ...)` — kept
  as the documented alternative policy. Content-hash all-keys logic (ADR-005) untouched.
  Full Python suite GREEN (2475 passed, 1 skipped).
- **Status:** ✅ Python seal-whitelist (Phases 1–4) complete; verified canonical rehash in place.

### Deliverable
Python verifies the existing migrated ledger (129/129) AND re-seals newly-created blocks using
the 6-field whitelist; full Python suite GREEN.

---

## Phase 2 — Web verifier/sealer → whitelist + fix exclusion bug (`phpoc-web/src/ledger/chain.js`)

**Goal:** Web matches Python exactly; fixes its latent lack of `format_version`/`key_version`
exclusion (which becomes irrelevant under the whitelist since those are already excluded).

- **[x] TDD P1** — blueprint in `docs/planning/CANONICAL_SEALFIELD_WEB_PHASE1.md` (27 assertions, groups A–E).
- **[x] TDD P2 — RED** — `phpoc-web/test/chain_seal_whitelist_test.mjs` (run `node --test`).
- **[x] TDD P3 — GREEN** — new `src/ledger/seal_fields.js` (`SEAL_FIELDS`/`selectSealFields`/`computeSeal`, mirror of Python `chain.py`); routed `buildDayBlock`/`buildGenesisBlock` (chain.js) and `makeMonthSummary`/`makeYearSummary` (summary_policy.js) sealers and the `chain.js`/`merge.js` `_verifyBlockData` verifiers through the shared whitelist; conformed the Web genesis sealer/verifier to exclude `identity` (canonical, matching Python). **28/28 chain_seal_whitelist_test.mjs GREEN.** Updated `ledger_chain_test.mjs`/`ledger_merge_test.mjs` fixtures to whitelist-sealed genesis (identity outside the seal).
- **[x] TDD P4 — REFACTOR** — deduped the leftover open-set `checkData` builders in `sync.js` (`_genesisGatePhase` genesis + per-block diagnostics) and `genesis_gate.js` (genesis tamper-recompute) through the shared `selectSealFields` whitelist — the "F1/F5-style" copied seal-input builders of the verifier. **Confirmed no `format_version`/`key_version` sealing** anywhere: every Web sealer/verifier now routes through the shared whitelist. **Kept legacy-tolerant (reverted):** `export_auth.js` `_verifyGenesisSeal` and `ledger_import.js` per-block verify — they must verify legacy open-set-sealed ledgers (tests confirm) and are the documented backward-compat exception alongside `remote_import.js`/`DevModeContext.jsx` cross-client multi-format checks.
- **Status:** ✅ Web seal-whitelist (Phases 1–4) complete

---

## Phase 3 — Flutter verifier/sealer → `_sealFields` adds `original_hash` (`phpoc-flutter/lib/data/ledger/chain.dart`)

**Goal:** Fix the Phase-4 regression: `_sealFields` becomes
`{type, day_index, date, prev_hash, entries, original_hash}` (6 fields).

- **[x] TDD P1** — blueprint in `docs/planning/CANONICAL_SEALFIELD_FLUTTER_PHASE1.md` (9 tests: A:2, C:4, D:3; sealer path proven behaviorally via shared `_sealFields`).
- **[x] TDD P2 — RED** — `phpoc-flutter/test/data/ledger/chain_seal_whitelist_test.dart`: 9 tests, **7 RED**
  (the 6-field-requiring subset) + 2 guard tests (optionality / closed-set). Confirmed the regression.
- **[x] TDD P3 — GREEN** — `chain.dart` `_sealFields` → `{type, day_index, date, prev_hash, entries,
  original_hash}` (6 fields); `_sealBlock`/`_verifyBlockSeal` iterate the shared table. **9/9 GREEN.**
- **[x] TDD P4 — REFACTOR** — 3-way JSON fallback (`verifySeal`) kept intact; docstrings corrected
  (stopped misstating PHPSPEC 5-field; now document closed ADR-029 6-field set). No `format_version`/
  `key_version`/`identity_seal`/hash-key sealing. Confirmed `original_hash` now in seal.
- **Status:** ✅ Flutter `_sealFields` 6-field whitelist (Phases 1–4 TDD) complete. No new regressions:
  `test/data` failure set unchanged (pre-existing `chain_test` K2/K3/K4, `engine_test` F15/AE2/AE4,
  `sync_service_test`, flaky `restore_integration`).

### Key acceptance
Migrated ledger (`after-4-migration.json`) verifies on Flutter — the exact 0/129 → 129/129 fix.

---

## Phase 4 — Migration tool → `_seal_block` whitelist (`phpoc_cli/migrate_format.py` + standalone `migrate-format.py`)

**Goal:** Migration re-seals to the 6-field whitelist (not the current open-set-minus-exclusions).

- **[x] TDD P1** — blueprint in `docs/planning/CANONICAL_SEALFIELD_MIGRATOR_PHASE1.md` (26 assertions across A–F; Group F = unknown-block-type safety added after probing).
- **[x] TDD P2 — RED** — extend `tests/test_migrate_format.py` with seal-whitelist assertions: new `TestMigrateFormatSealWhitelist` (24 lock assertions + 2 RED). **RED (2): F1/F2** — unknown block type currently corrupts the input ledger (write-before-raise, no restore). GREEN (24): seal-content/closed-set/enforcement locks (all already whitelist-correct via `compute_seal`). 41/43 total in file.
- **[x] TDD P3 — GREEN** — `_seal_block` already routes through `compute_seal` (6-field set, verified by A1/B1/C1/E1). Fixed the unknown-block-type corrupting write in `execute()`: new pre-validation loop rejects any block whose `_block_hash_key` is None (i.e. not one of the 4 canonical types) with `ValueError` **before** the backup and any write — a failed migration is a byte-identical no-op on the input ledger. `TestMigrateFormatSealWhitelist` **26/26 GREEN** (F1/F2 now GREEN); file 43/43; full Python suite 2586 pass / 1 skip / 0 fail.
- **[x] TDD P4 — REFACTOR** — `_seal_block` drops its unused `hash_key` param (it never reached `compute_seal`); the sealer was already deduped (→ `compute_seal` → `select_seal_fields`). Extracted `_preserve_and_strip` to unify the three per-branch "save `original_hash` + strip stale hash keys + `identity_seal`" loops in `execute()`; `_block_hash_key` reduced to a `dict.get` table. Kept it the strict unknown-type gate rather than reusing `chain._hash_key_for_block` (which defaults to `day_hash` and would break E3/E4/F1/F2). 43/43 GREEN; full suite 2586 pass / 1 skip / 0 fail.
- **Status:** 🟢 (Ph-4 Migrator P1–P4 COMPLETE)
- **Probe finding:** sealer already routes through `compute_seal` (routed during Ph-1 Python P4), so migrated seals already match the whitelist; `chain.verify()` True on migrated multi-type ledger; tampered seal fails verify; excluded-field change leaves `compute_seal` unchanged + verify() still True.

---

## Phase 5 — PHPSPEC → document the seal whitelist (`docs/spec/PHPSPEC.md`)

**Goal:** Spec states the canonical `SEAL_FIELDS` set and the closed-set rule.

- [x] TDD P1 — blueprint in `docs/planning/CANONICAL_SEALFIELD_PHPSPEC_PHASE1.md` (27 spec-conformance assertions, groups A–F).
- [x] TDD P2 — RED: confirmed current spec contradicts ADR-029 — §5.2 `compute_seal` was open-set (seals `format_version`/`key_version`/stray); §9.3 (L1449/L1481) falsely claimed `format_version` is **included in the block seal**.
- [x] TDD P3 — GREEN: rewrote §5.2 into **Block Seal Field Set** (per-type tables), **Selection & Canonical Serialization** (`json.dumps sort_keys`), **Closed-Set Rule** (excluded fields incl. `format_version`/`key_version`/`identity`/`identity_seal`/`signature`/hash key), `original_hash` optional-if-absent, and **Unknown Block Types** rejection; fixed §1.4 Seal def + §9.3 two stale `format_version`-in-seal claims; routed `scripts/migrate_format_version.py` `compute_seal` through the shared `select_seal_fields` whitelist (was open-set).
- [x] TDD P4 — REFACTOR: fixed the latent `_section_text` f-string regex bug in `tests/test_naming_i04.py` (`^#{{{1,{level}}}}\s` → `^#{{1,{level}}}\s`; ×2 copies) that silently made section-scoped spec tests scan to end-of-doc; updated H12 to allow the ADR-029 closed-set exclusion table (`signature` as an explicitly-not-sealed field). Dropped the now-dead `hash_key` local in `scripts/migrate_format_version.py` `compute_seal`. **Full Python suite: 2586 passed, 1 skipped, 0 failed** (+6 naming tests now GREEN that the broken regex had masked but the ADR-029 `signature` exclusion row had begun to trip).
- **Status:** 🟢 (Ph-5 PHPSPEC P1–P4 COMPLETE)

---

## Phase 6 — Cross-client canonical seal test vectors

**Goal:** Shared fixture proving all clients compute identical seals.

- [x] Supersede the **pre-ADR-029a open-set** `testdata/canonical_test_vectors.json` (its `expected_seal`
      values are HMAC over the FULL block_data, incl. excluded fields) with a **closed-whitelist**
      vector set `testdata/canonical_seal_vectors.json`: genesis/day/month_summary/year_summary,
      some with `original_hash`, some without, each with an exact `expected_seal` over the ADR-029a
      per-type whitelist (`select_seal_fields`).
- [x] Python (`tests/test_migration.py` B1–B5 + `tests/test_canonical_seal_vectors.py`) and Web
      (`ledger_chain_test.mjs` B1-js–B5-js) assert the EXACT shared seal via `select_seal_fields`.
- [x] Fix the **Flutter summary divergence**: `chain.dart _sealFields` is now a per-type
      `_sealFieldsByType` map — genesis/day seal {type, day_index, date, prev_hash, entries,
      original_hash}; `month_summary`/`year_summary` seal their identity field {type, month|year,
      date, prev_hash, original_hash}. `_sealBlock`/`_verifyBlockSeal` select per-type fields
      (P3 GREEN). Flutter summary-vector tests C1–C4 GREEN.
- [x] Python / Web / Flutter each verify against the SAME vectors (proving convergence).
- **Status:** ✅ Phase-3 GREEN — Flutter summary divergence FIXED in `chain.dart` (per-type
  `_sealFieldsByType`; C1–C4 GREEN, C5/C6/D2 guards GREEN). **Phase 4 REFACTOR complete**: Ph-6
  vector fixture/tests DRYed (byte-identical), plus the separate Flutter Ledger Verify & Commit Fix
  workstream (S1–S6) 4-phase complete. Ledger suite 279/279 GREEN. Next: Phase 7 (phone e2e).

---

## Phase 7 — Re-migrate ledger + rebuild/reinstall phone + confirm on-device verify

**Goal:** End-to-end proof on the phone.

- **[x]** Migrator summary-synthesis sub-task **4-Phase TDD COMPLETE**: `_canonicalize_summary`
  synthesizes ADR-029a `month`/`year` on non-canonical summary input blocks (the real
  132-block replaced-ledger rep), drops stray `day_index`/`entries`, and re-seals the partition
  identity. Blueprint `CANONICAL_SEALFIELD_PHASE7_MIGRATOR_SUMMARY_PHASE1.md` (14 assertions
  A–D); `TestMigrateFormatSummarySynthesis` 14/14 GREEN; `test_migrate_format.py` 57/57; full
  Python suite 2614 pass/1 skip. Phase 4 refactor done (`_canonicalize_summary` → explicit
  mutator, no change to behavior).
- **[ ]** Re-run migration on the current 0.4.0 ledger (backup first; D5/D9) to restamp all 129
  block seals to the 6-field whitelist.
- **[ ]** Verify with Python `chain.verify()` (129/129).
- **[ ]** Rebuild Flutter debug APK; `adb install -r` (preserves data).
- **[ ]** Re-onboard migrated file on phone; confirm `verify()` passes (129/129).
- **Status:** 🔜

---

## Definition of Done

1. All four implementations seal/verify over the identical 6-field whitelist.
2. Cross-client canonical vectors (Phase 6) verify GREEN on Python + Web + Flutter.
3. PHPSPEC documents the whitelist (Phase 5).
4. Re-migrated ledger verifies on Python **and** the phone (Phase 7).
5. Full test suites GREEN (Python baseline preserved; no new regressions).
6. ADR-029 consequences fully implemented; docs (MAP.md, ROADMAP.md, AGENTS.md chain) updated.

---

## Progress Tracker

| Phase | Owner | TDD P1 | P2 RED | P3 GREEN | P4 REFACTOR | Status |
|-------|-------|--------|--------|----------|-------------|--------|
| 1 — Python `chain.py` | — | ✅ | ✅ | ✅ | ⬜ | 🟡 P3 GREEN done (P4 REFACTOR next) |
| 2 — Web `chain.js` | — | ✅ | ✅ | ✅ | ✅ | 🟢 P4 REFACTOR done (Phases 1–4 complete) |
| 3 — Flutter `chain.dart` | — | ✅ | ✅ | ✅ | ✅ | 🟢 Ph-3 Flutter P1–P4 complete |
| 4 — Migration tool | — | ✅ | ✅ | ✅ | ✅ | 🟢 Ph-4 Migrator P1–P4 COMPLETE (26 seal-whitelist + 17 existing = 43 GREEN; unknown-type pre-validation; P4 REFACTOR deduped sealer/hash-strip) |
| 5 — PHPSPEC | — | ✅ | ✅ | ✅ | ✅ | 🟢 Ph-5 P1–P4 COMPLETE (27 assertions; §5.2 whitelist + closed-set + original_hash; §9.3 stale claims fixed; migrate_format_version routed to whitelist; test_naming_i04 regex bug fixed) |
| 6 — Canonical vectors | — | — | — | — | — | 🔜 |
| 7 — Re-migrate + phone | — | — | — | — | — | 🔜 |
