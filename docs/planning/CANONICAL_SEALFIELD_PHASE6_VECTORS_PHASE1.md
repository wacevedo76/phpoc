# Canonical Seal-Field — Phase 6 Cross-Client Seal Vectors — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` — Phase 6 (of 7)
> **Purpose:** Blueprint all assertions needed to establish a SINGLE shared, cross-client
> canonical seal-vector fixture that proves Python / Web / Flutter compute byte-identical
> seals over the ADR-029a per-type whitelist, and to port the per-type `month`/`year`
> seal fields into Flutter so Flutter summaries converge.
> **Status:** ✅ Phase 1 (test exploration) · Phase 2 RED complete (2026-08) · Phase 3 GREEN complete (2026-08) · **Phase 4 (REFACTOR) complete — all 4 phases DONE**
> **Next Phase:** Phase 7 (phone e2e)
> **ADR:** ADR-029 (`{type, day_index, date, prev_hash, entries, original_hash}`) amended by
> ADR-029a → per-type field sets (summaries seal their `month`/`year`).

---

## Phase 1 Exploration Findings (from SESSION_HANDOFF Ph-6 probe)

Three concrete divergences confirm the need for a superseding, closed-whitelist vector set:

### Finding 1 — `testdata/canonical_test_vectors.json` is stale (pre-ADR-029a, open-set)
A live probe recomputing the closed-set seal over each current vector's `block_data`:

| Vector | Stored `expected_seal` | Closed-set recompute | Result | Excluded-by-whitelist fields baked into the STORED seal |
|--------|------------------------|----------------------|--------|--------------------------------------------------------|
| V-genesis | `2f6cf8…` | `a8eb11…` | **DIFF** | `identity` |
| V-day     | `bb9870…` | `bb9870…` | SAME*  | *(none — day fields already whitelisted)* |
| V-month   | `88b0d2…` | `9ea2a1…` | **DIFF** | `month_index`, `total_entries`, `total_duration_ms` |
| V-year    | `75427c…` | `a79bd0…` | **DIFF** | `year_index`, `total_entries`, `total_duration_ms` |
| V-empty-day | `f68a10…` | `f68a10…` | SAME* | *(none — day fields already whitelisted)* |

- **V-month** and **V-year** use the fixture-only `month_index` / `year_index` keys — the exact
  non-real fields PHPSPEC/ADR-029a removed (summaries must use `month` = `"YYYY-MM"` and
  `year` = int). The stored seals therefore cover fields that real summary blocks never carry.
- **V-day**/**V-empty-day** only "match" today by coincidence (their plaintext day rows carry no
  excluded fields). They are not meaningful cross-client targets, and the Web consumer
  (B-js) never asserts their `expected_seal` — only 64-hex + determinism.
- Python `test_migration.py` TestGroupB B1–B4 asserts exactness against these **stale
  open-set** values, so it currently locks the WRONG contract (V-genesis, V-month, V-year).

### Finding 2 — Flutter `chain.dart._sealFields` does not seal `month`/`year` (summary divergence)
`phpoc-flutter/lib/data/ledger/chain.dart` has ONE day-oriented list
`{type, day_index, date, prev_hash, entries, original_hash}` used by `_sealBlock` and
`_verifyBlockSeal` for **ALL** block types. It therefore does NOT seal `month` (month_summary)
or `year` (year_summary). Python (`chain.py SEAL_FIELDS`) and Web (`seal_fields.js`) both seal
`month`/`year` for summaries. Consequence: a summary sealed by Python/Web (over
`{type, month|year, date, prev_hash, original_hash}`) FAILS on Flutter, because Flutter
recomputes over a day-style row that has no `month`/`year` and carries `day_index`/`entries`
that are absent → the recomputed seal input differs → `verifyBlock` false. This is the exact
cross-client divergence the whole program exists to eliminate, and the current Flutter
whitelist test (`chain_seal_whitelist_test.dart`) has ZERO summary coverage.

### Finding 3 — Web Group-B-js is weak
`phpoc-web/test/ledger_chain_test.mjs` B1-js–B4-js only check that `clfComputeSeal(...)`
returns a 64-hex string and is deterministic (`t.assertEq(s, clfComputeSeal(...))`). It never
compares against `expected_seal`. Moreover `clfComputeSeal` strips ONLY `format_version`
(`const { format_version, ...withoutFv }`), i.e. it is still open-set-minus-one — it does NOT
use `selectSealFields`. So Web currently proves nothing about the canonical shared seal.

### Cross-client key derivation is identical (vectors are universal)
Python (`CryptoService.seal` / `_MockCrypto.seal`), Web (`crypto.seal`), and Flutter
(`CryptoService.seal`) all compute `seal_key = HMAC-SHA256(MK, "integrity-key-salt")` then
`HMAC-SHA256(seal_key, data)`. Therefore a single `expected_seal` computed over
`select_seal_fields(block)` with the fixed `deadbeef…` master key is valid on all three
clients. Canonical summary shapes (from `summary_policy.py`):
- `month_summary` → `{ type:'month_summary', month:'YYYY-MM', prev_hash, date }`
- `year_summary` → `{ type:'year_summary', year:<int>, prev_hash, date }`

---

## Architecture Overview

The deliverable is a new fixture `testdata/canonical_seal_vectors.json` (superseding the stale
`canonical_test_vectors.json`) plus exact-assert wiring and a Flutter convergence fix:

```
                     testdata/canonical_seal_vectors.json
   (fixed deadbeef MK; per-type rows; expected_seal = HMAC over select_seal_fields)
                                  │
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
      Python (B1–B4)        Web (B1-js–B4-js)      Flutter (new summary
   exact expected_seal    exact expected_seal       vector tests + port
   via select_seal_fields  via selectSealFields      month/year into _sealFields)
```

1. **Script/driver** (`scripts/` or inline) computes each `expected_seal` from the canonical
   field row via `compute_seal`-equivalent, so the vector values are self-consistent, not
   hand-typed.
2. **Python** `tests/test_migration.py` B1–B4 switch from `json.dumps(v["block_data"])`
   (open-set) to `select_seal_fields(v["block_data"])` and assert the EXACT `expected_seal`
   from the NEW vector set.
3. **Web** `ledger_chain_test.mjs` B1-js–B4-js switch `clfComputeSeal` to `selectSealFields`
   and assert the EXACT `expected_seal`; remove the stale file dependency.
4. **Flutter** `chain.dart`: make `_sealFields` a per-type map (day/genesis vs month-year
   summaries), port `month`/`year` into `_sealBlock`/`_verifyBlockSeal`, and add summary
   vector tests asserting `expected_seal` parity with Python/Web.
5. **Prove convergence:** an assertion (Python property/env) that the same final byte string is
   produced across all three clients for the SAME vectors.

### Test surface
- **New fixture:** `testdata/canonical_seal_vectors.json`.
- **Modified:** `tests/test_migration.py` (B1–B4), `phpoc-web/test/ledger_chain_test.mjs`
  (B1-js–B4-js + `clfComputeSeal`), `phpoc-flutter/lib/data/ledger/chain.dart`
  (`_sealFields` per-type), `phpoc-flutter/test/data/ledger/chain_seal_whitelist_test.dart`
  (+ summary vector group). Old `testdata/canonical_test_vectors.json` is superseded (kept for
  reference or removed; no live consumer may depend on its open-set values after this phase).
- **Fixture corrections:** any test fixture that still uses `month_index`/`year_index` summary
  shape must be corrected to the real `month`/`year` shape (V-month/V-year vectors + any
  summary construction).

---

## Test Groups

### Group A: Vector fixture correctness & shape — ~7 tests
Verify `testdata/canonical_seal_vectors.json` holds real, self-consistent canonical rows.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | The fixture loads and contains all four block-type vectors plus with/without-`original_hash` variants | Fixture is complete | Every client type and provenance state must have a vector (ADR-029a rows) |
| A2 | Each vector's `expected_seal` equals `HMAC(HMAC(MK,'integrity-key-salt'), jsonSort(select_seal_fields(row)))` | Vectors are self-consistent, generation-driven | Prevents hand-typed (and thus possibly-wrong) seal values; seals must match the derived formula |
| A3 | Every `month_summary` row carries `month` (`"YYYY-MM"` string), NOT `month_index` | Correct summary identity field | ADR-029a/PHPSPEC — the fixture must not reintroduce the removed fixture-only field |
| A4 | Every `year_summary` row carries `year` (int), NOT `year_index` | Correct summary identity field | Same closed-set contract as A3 |
| A5 | Excluded fields present in the wide `block` (e.g. `identity`, `format_version`, `key_version`, `identity_seal`, `signature`, `month_index`, `year_index`, `total_entries`, `total_duration_ms`) do NOT appear in `expected_seal`'s input row | Vectors prove closed-set exclusion | Bakes the ADR-029 closed-set rule into the shared fixture |
| A6 | Duplicate-serialization stability: `expected_seal` is stable across `jsonSort`, indent-2, and no-space serializers (all three produce the same seal when fed the same selected fields) | Cross-client serialization parity | Flutter uses a 3-way fallback; vectors must be valid under each Python/Web/Dart serializer |
| A7 | `testdata/canonical_seal_vectors.json` is the ONLY live vector fixture; no consumer references the stale `canonical_test_vectors.json` open-set values | Supersede the stale old-set | Prevents a future reader from resurrecting the pre-ADR-029a contract |

### Group B: Exact cross-client seal parity — ~8 tests
Assert every client reproduces the EXACT `expected_seal` over `select_seal_fields` for the SAME vectors (this is the convergence proof).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Python recomputes the exact `expected_seal` for the genesis vector via `select_seal_fields` | Python is the reference verifier | Locks Python to the closed-set seal (was open-set, Finding 1) |
| B2 | Python recomputes the exact `expected_seal` for the day vector | Day-block parity | Day is the most common block type |
| B3 | Python recomputes the exact `expected_seal` for the month_summary vector | Month-summary parity | `month` must be sealed and match exactly (Finding 2) |
| B4 | Python recomputes the exact `expected_seal` for the year_summary vector | Year-summary parity | `year` must be sealed and match exactly (Finding 2) |
| B5 | Python recomputes the exact `expected_seal` for the `original_hash`-absent variants | Provenance-empty parity | Vectors must cover both optional-if-absent states, and the closed-set recompute must match |
| B6 | Web reproduces the exact `expected_seal` via `selectSealFields` for genesis/day/month/year vectors | Web parity (currently determinism-only, Finding 3) | Proves Web uses the SAME canonical whitelist + seal as Python |
| B7 | A chain of all four types built in Python verifies end-to-end (`chain.verify()` True) where each block's seal is the exact vector `expected_seal` | Integrated convergence | End-to-end chain integrity (D4) over whitelist-sealed mixed blocks |
| B8 | Cross-client byte-identity: the seal-input JSON string (selected fields) is byte-identical between Python, Web, and Flutter for each row | Byte-for-byte convergence | Identical serialized input ⇒ identical seal ⇒ interchangeable ledgers |

### Group C: Flutter summary convergence — ~6 tests
Port the per-type `month`/`year` seal set into Flutter and assert parity (currently RED — Finding 2).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Flutter `_sealFields` selects `{type, month, date, prev_hash, original_hash}` for `month_summary` | Port per-type month set | Without it, Flutter seals an empty day-style row instead of `month` (Finding 2) |
| C2 | Flutter `_sealFields` selects `{type, year, date, prev_hash, original_hash}` for `year_summary` | Port per-type year set | Same as C1 for year |
| C3 | A `month_summary` sealed by Python/Web over `{type, month, date, prev_hash, original_hash}` (exact vector seal) verifies on Flutter `verifyBlock` | Flutter accepts canonical month seal | The 0→N divergence fix — a Python/Web summary must verify on the phone |
| C4 | A `year_summary` sealed by Python/Web over `{type, year, date, prev_hash, original_hash}` (exact vector seal) verifies on Flutter | Flutter accepts canonical year seal | Same as C3 for year |
| C5 | Flutter recomputes the exact `expected_seal` for the month_summary vector via its sealer | Flutter summary seal byte-parity | Proves Flutter produces the SAME seal as Python/Web (Bit-for-bit) |
| C6 | day/genesis blocks STILL verify after the per-type refactor (no regression to the day row) | Non-summary regression guard | Per-type split must not break the already-GREEN day/genesis 6-field behavior |

### Group D: Divergence detection (RED proof) — ~4 tests
Guarantee the vector fixture actively catches a client that seals the WRONG row (the bug class).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | The OLD open-set seal for a vector (computed over full `block_data` incl. excluded fields) does NOT equal the closed-set `expected_seal` | Closed-set differ from open-set | Confirms the fixture is a real closed-set target, not a cosmetic relabel |
| D2 | The Flutter day-style summary seal (pre-fix: sealing `{type, day_index, date, prev_hash, entries}` with no `month`/`year`) does NOT equal the canonical month/y-year vector seal | Regression detection for Flutter's bug | The fixture must FAIL the flawed Flutter sealer, proving it catches the divergence (C-fix validator) |
| D3 | Adding any excluded field to the wide block does NOT change the closed-set `expected_seal` (seal invariant) | Stray metadata is seal-independent | The closed-set rule holds regardless of present-but-excluded fields |
| D4 | Tampering a sealed whitelist field (e.g. `month`, `year`, `prev_hash`) in the wide block yields a different recomputed seal than `expected_seal` | Tamper detection | Modifying any sealed identity/chain field must invalidate the shared seal (D4 integrity) |

### Group E: Supersede & regression guard — ~4 tests
Keep the existing surface GREEN and prove the stale vectors are gone.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Python full suite stays GREEN after B1–B4 rewire + fixture swap | No Python regression | Existing 2586 pass/1 skip/0 fail baseline preserved |
| E2 | Web full suite stays GREEN after B-js rewire + `selectSealFields` | No Web regression | Pre-existing known red unchanged; new exact-asserts GREEN |
| E3 | Flutter non-summary seal tests (Group A/B/C/D existing) stay GREEN after the per-type refactor | No Flutter regression | Summaries converge while day/genesis behavior is untouched |
| E4 | No test or consumer references the old open-set `expected_seal` values from `canonical_test_vectors.json` anywhere | Stale contract fully superseded | Prevents two vector truths from coexisting |

---

## Summary Report

- **Total assertions:** 29
- **By group:** A = 7 (vector fixture shape/closed-set), B = 8 (exact cross-client parity),
  C = 6 (Flutter summary convergence), D = 4 (divergence detection / RED proof), E = 4
  (supersede & regression guard)
- **Key coverage areas:**
  - A superseding closed-whitelist vector fixture with REAL canonical summary shapes
    (`month`/`year`, not `month_index`/`year_index`) and both `original_hash` states (Group A)
  - Exact `expected_seal` parity across all three clients over `select_seal_fields`
    (Group B — Python B1–B5, Web B6, integrated verify B7, byte-identity B8)
  - Flutter per-type `month`/`year` seal-port + summary vector parity (Group C)
  - RED proof that divergent (open-set / Flutter-day-style) seals fail the fixture (Group D)
  - Full-suite regression + stale-vector removal guards (Group E)
- **Phase 1 findings lock the scope:** stale open-set vectors (F1), Flutter summary
  divergence (F2), weak Web determinism-only checks (F3), and identical key derivation
  enabling a universal vector (overview).
- **Vectors to include:** genesis (no orig), genesis (orig), day (no orig), day (orig),
  month_summary (no orig), month_summary (orig), year_summary (no orig), year_summary (orig).

---

## Files

- **New:** `testdata/canonical_seal_vectors.json` (closed-whitelist vector fixture, crafted by a
  generator, not hand-typed seals)
- **New (driver):** `scripts/gen_canonical_seal_vectors.py` — writes the fixture from canonical
  rows via the self-identical HMAC formula (A2 generation-self-consistent)
- **New:** `tests/test_canonical_seal_vectors.py` (14 tests: Groups A, B5/B7/B8, D1/D3/D4, E1)
- **Modified:** `tests/test_migration.py` (B1–B4 → `select_seal_fields` + new vector names)
- **Modified:** `phpoc-web/test/ledger_chain_test.mjs` (B1-js–B5-js → exact `expected_seal`
  over `selectSealFields` via native HMAC — Node v24 WASM glue broken)
- **Modified:** `phpoc-flutter/lib/data/ledger/chain.dart` (`_sealFields` → per-type map,
  port `month`/`year`) — **Phase 3**
- **Modified:** `phpoc-flutter/test/data/ledger/chain_seal_whitelist_test.dart` (+ Group E/F:
  C1–C6 summary convergence + D2 divergence guard)

---

## Phase 3 (GREEN) — Delivered (2026-08)

Per-type summary seal port in `phpoc-flutter/lib/data/ledger/chain.dart`:

- Replaced the single day-style `_sealFields` list with `_sealFieldsByType` (a per-type map):
  - `genesis` / `day` → `{type, day_index, date, prev_hash, entries, original_hash}`
  - `month_summary` → `{type, month, date, prev_hash, original_hash}`
  - `year_summary` → `{type, year, date, prev_hash, original_hash}`
- `_sealBlock` and `_verifyBlockSeal` now select fields by `type`, so a summary's identity
  (`month`/`year`) is sealed and verified — matching Python `chain.py` `SEAL_FIELDS` /
  `select_seal_fields`. Unknown block type rejects (matches Python `raise ValueError`).
- Groups C1–C4 GREEN. C5/C6/D2 guards GREEN. `flutter test test/data/ledger/` : 261 pass /
  6 pre-existing fail (K2–K4, engine F15/AE2/AE4) — **zero new regressions** vs the 257/10 baseline.

## Phase 2 (RED) — Delivered (2026-08-10)

- **Fixture:** `testdata/canonical_seal_vectors.json` regenerated as TWO self-consistent,
  chain-linked vector sequences (original_hash ABSENT chain: V-genesis→V-year→V-month→V-day;
  PRESENT chain: …-orig). Each downstream `prev_hash` points at the upstream `expected_seal`, so
  each vector's seal is exact AND the four types form a verifiable chain (B7).
- **Gen driver:** `scripts/gen_canonical_seal_vectors.py` computes every `expected_seal` from
  `select_seal_fields` (closed-set) so A2 is generation-self-consistent, never hand-typed.
- **Python guards (GREEN):** 14 tests in `tests/test_canonical_seal_vectors.py` + B1–B5 in
  `test_migration.py` rewired to `select_seal_fields`. Full suite 2600 pass / 1 skip / 0 fail.
- **Web guards (GREEN):** B1-js–B5-js reproduce EXACT closed-set `expected_seal` over
  `selectSealFields` using Node `createHmac` (the phasing WASM `CryptoService` glue is broken on
  Node v24 — `__wbindgen_free` not wired, see `crypto_service_smoke.mjs`). `ledger_chain_test.mjs`
  109 pass; `chain_seal_whitelist_test.mjs` 28 pass.
- **Flutter RED (the real Phase 3 fix):** Group E C1–C4 fail because `chain.dart _sealFields` is
  still the single day-style list and does NOT seal `month`/`year` for summaries. C5 (byte-parity
  `computeSeal` == exact vector seal), C6 (day/genesis regression), and D2 (day-style month-less
  seal ≠ canonical) are GREEN guards. Result 12 pass / 4 RED.
- **E4 supersede:** no live consumer locks the stale open-set `expected_seal`;
  `canonical_test_vectors.json` is referenced only by supersession guards/docstrings.
- **Superseded:** `testdata/canonical_test_vectors.json` (no live consumer may rely on its
  open-set values; removed or marked reference-only after E4 guard passes)
- **Docs:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` (Phase 6 status),
  `docs/reference/MAP.md` (file inventory), `docs/planning/A...` ROADMAP/BACKLOG, SESSION_HANDOFF.md
