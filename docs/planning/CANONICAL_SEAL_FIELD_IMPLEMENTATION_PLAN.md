# Canonical Seal-Field — Implementation Plan (Path C / ADR-029)

> **Plan:** Implement the canonical 6-field block-seal whitelist across all four
> implementations per **ADR-029** (✅ Adopted) and `docs/design/CANONICAL_SEAL-FIELD_Design.md`.
> **Purpose:** Converge Python / Web / Flutter / migration-tool on ONE block-seal contract so
> migrated 0.4.0 ledgers verify on every client (fixes the on-phone 0/129 verification failure).
> **Status:** 🔜 In progress
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

- **[ ] TDD P1** — blueprint in `docs/planning/CANONICAL_SEALFIELD_WEB_PHASE1.md`.
- **[ ] TDD P2 — RED** — `phpoc-web/test/chain_seal_whitelist_test.mjs` (run `node --test`).
- **[ ] TDD P3 — GREEN** — update `chain.js` verifier/sealer to the 6-field whitelist.
- **[ ] TDD P4 — REFACTOR** — dedupe checkData builder; confirm no `format_version` sealing.
- **Status:** 🔜

---

## Phase 3 — Flutter verifier/sealer → `_sealFields` adds `original_hash` (`phpoc-flutter/lib/data/ledger/chain.dart`)

**Goal:** Fix the Phase-4 regression: `_sealFields` becomes
`{type, day_index, date, prev_hash, entries, original_hash}` (6 fields).

- **[ ] TDD P1** — blueprint in `docs/planning/CANONICAL_SEALFIELD_FLUTTER_PHASE1.md`.
- **[ ] TDD P2 — RED** — `phpoc-flutter/test/chain_seal_whitelist_test.dart` (widget/unit).
- **[ ] TDD P3 — GREEN** — update `_sealFields` + `_sealBlock`/`_verifyBlockSeal` to the 6-field set.
- **[ ] TDD P4 — REFACTOR** — keep 3-way JSON fallback; docstring correction (stop misstating
  PHPSPEC as 5-field). Confirm `original_hash` now in seal.
- **Status:** 🔜

### Key acceptance
Migrated ledger (`after-4-migration.json`) verifies on Flutter — the exact 0/129 → 129/129 fix.

---

## Phase 4 — Migration tool → `_seal_block` whitelist (`phpoc_cli/migrate_format.py` + standalone `migrate-format.py`)

**Goal:** Migration re-seals to the 6-field whitelist (not the current open-set-minus-exclusions).

- **[ ] TDD P1** — blueprint in `docs/planning/CANONICAL_SEALFIELD_MIGRATOR_PHASE1.md`.
- **[ ] TDD P2 — RED** — extend `tests/test_migrate_format.py` with seal-whitelist assertions.
- **[ ] TDD P3 — GREEN** — update `_seal_block` (and standalone mirror) to the 6-field set.
- **[ ] TDD P4 — REFACTOR** — dedupe sealer shared with chain.py if applicable.
- **Status:** 🔜

---

## Phase 5 — PHPSPEC → document the seal whitelist (`docs/spec/PHPSPEC.md`)

**Goal:** Spec states the canonical `SEAL_FIELDS` set and the closed-set rule.

- **[ ]** Add "Block Seal Field Set" section: the 6 fields, HMAC-SHA256 over
  `json.dumps(seal_data, sort_keys=True)`, closed-set (excluded fields list), `original_hash`
  optional-if-absent for pre-0.4.0 / legacy blocks.
- **Status:** 🔜

---

## Phase 6 — Cross-client canonical seal test vectors

**Goal:** Shared fixture proving all clients compute identical seals.

- **[ ]** Generate a canonical set of blocks (genesis/day/month/year; some with `original_hash`,
  some without) and their expected 6-field seals into `testdata/`.
- **[ ]** Python / Web / Flutter tests each verify against the SAME vectors (proving convergence).
- **Status:** 🔜

---

## Phase 7 — Re-migrate ledger + rebuild/reinstall phone + confirm on-device verify

**Goal:** End-to-end proof on the phone.

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
| 2 — Web `chain.js` | — | ⬜ | ⬜ | ⬜ | ⬜ | 🔜 |
| 3 — Flutter `chain.dart` | — | ⬜ | ⬜ | ⬜ | ⬜ | 🔜 |
| 4 — Migration tool | — | ⬜ | ⬜ | ⬜ | ⬜ | 🔜 |
| 5 — PHPSPEC | — | — | — | — | — | 🔜 |
| 6 — Canonical vectors | — | — | — | — | — | 🔜 |
| 7 — Re-migrate + phone | — | — | — | — | — | 🔜 |
