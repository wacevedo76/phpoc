# C-2 CLI↔Client Cross-Client Verification — Phase 1 (test-exploration blueprint)

> **Roadmap:** `C2_SEED_REKEY_WEB_CLI_ROADMAP.md` §Phase D (CLI leg)
> **Predecessor:** `C2_CROSS_CLIENT_VERIFY_PHASE1.md` (Web↔Flutter leg ✅ COMPLETE 2026-08-28)
> **CLI re-key:** `C2_CLI_SEED_REKEY_PHASE1.md` (✅ 4-phase TDD COMPLETE 2026-08-29, 34/34)
> **Status:** ✅ **Phase 4 (REFACTOR + docs) COMPLETE 2026-08-29.** Groups A–D hermetic matrix GREEN all four directions; **option (a) raw-seed re-key implemented**; R1–R6 resolved (R6 canonical = raw-bytes `identity_pub_key`). Phase 4: harness DRY'd (`_hash_key_for_block` re-use in `_rebuild_rekeyed_blocks`; `_content_hash_map` helper), PHPSPEC §2.10 harness citation updated, Group E docs (E1–E8) applied. **Live R2 E2E ✅ GREEN (2026-08-29):** canonical test ledger restored to R2 (genesis `e718daf3…`, 31 blocks); forward leg fixed (`renew_seed()` `transport=None` → isolated push, no canonical overwrite); `test_c2_cli_client_live_r2.py` 2/2 + `test_c2_live_r2.py` 1/1.

## Purpose

Prove the C-2 seed-replacement property **between the CLI and the clients**. The Web↔Flutter leg
(`C2_CROSS_CLIENT_VERIFY_PHASE1.md` + `tests/test_c2_live_r2.py`) proved that a chain re-keyed on one
client pulls + verifies under the new Master Key (MK) on the other, and that an **old-seed** device
fails to decrypt. That leg **explicitly gated the CLI leg on Phase A** (`ph rekey-seed`), which is now
complete (`RotateKeysCommand.renew_seed`, 34/34 `test_rekey_seed.py`).

This task answers the one open question: **is the CLI's canonical wire output — both as re-keyer and as
verifier — byte-compatible with the Web and Flutter clients?** Concretely, four directions:

1. **CLI re-keys** the real test ledger → **Web** pulls + verifies under the new MK.
2. **CLI re-keys** the real test ledger → **Flutter** pulls + verifies under the new MK.
3. **Web/Flutter re-keys** → **CLI** pulls + verifies under the new MK.
4. In every direction, an **old-seed** device must fail to decrypt (leak-nullification).

Like the Web↔Flutter leg, this is **verification + docs, not new re-key mechanics** — except that Phase 1
exploration has surfaced a **material cross-client divergence in MK derivation** (see §Risks) that will
require a small implementation decision in Phase 3.

## Architecture Overview

The shared contract is the **canonical PHPSPEC wire format** (`docs/spec/PHPSPEC.md` §4), not any client's
local storage. The CLI's local representation is `ledger.json` (an array of canonical block dicts) —
already *wire-shaped* — whereas Web (`IndexedDB` `ledger:blocks` + `chain.js`) and Flutter (SQLite
`blocks.data_enc`) each have a canonicalization step. The CLI re-key (`_rebuild_rekeyed_blocks`) writes
blocks **in place** to the canonical array, then pushes via the real transport contract
(`RemoteLedgerSync.push_blocks(force=True)` / `push_hash_index` / `push_index` on `AbstractStagingTransport`).

| Layer | CLI (`phpoc_cli`) | Web (`phpoc-web`) | Flutter (`phpoc-flutter`) |
|---|---|---|---|
| Local storage | `ledger.json` (canonical block array) | `ledger:blocks` (canonical block dicts) | SQLite `blocks.data_enc` |
| Re-key engine | `RotateKeysCommand.renew_seed()` | `RekeyService.rekey()` | `RekeyService.rekey()` |
| MK derivation | `derive_mk(seed, version)` (versioned) | `deriveMk(seed, version)` (versioned) | `deriveMasterKey(seed)` (**raw seed only**) |
| Re-key MK policy | **keeps `key_version`** → raw `new_seed` (option a, Phase 3) | **keeps `key_version`** → raw `new_seed` | **keeps `key_version`** → raw `new_seed` |
| Pull/verify | `RemoteLedgerSync` + `LedgerChain.verify()` | `importFromCloud` + `verifyLedgerChain` | import + `chain.verify()` |

### Verification mechanism

Two variants, mirroring `tests/test_c2_live_r2.py`:

1. **Hermetic fixture (deterministic, primary for RED/GREEN):** a copy of the canonical test ledger
   (`testdata/ledger.json`, 31 blocks / 146 entries, genesis `e718daf3…`) placed in a temp `data_dir`
   alongside `identity.json`; the CLI `renew_seed()` runs against a spy transport (`_RekeyTransportSpy`,
   precedent `test_rekey_seed.py` P1–P6) to emit the re-keyed wire; Web (`c2_cli_rekey_verify.mjs`) and
   Flutter (`c2_cli_verify_test.dart` Group L) each import + verify + old-seed-probe it. No network.
2. **Live R2 E2E (authoritative acceptance):** CLI re-keys the **real** test ledger against the live R2
   Worker (creds in `TEST_CREDENTIALS.md`), pushes an isolated prefix under the NEW MK; Web/Flutter pull +
   verify; old-seed probe fails. The reverse direction (client re-keys → CLI verifies) is driven from
   Python.

## Known format divergences to resolve (risks)

Phase 1 exploration found **five** seams. The assertion matrix turns each into a check; the first two are
blockers that drive a Phase 3 implementation decision.

- **R1 — `key_version` bump vs option (a).** The CLI re-key deliberately bumps `key_version`
  (`new_version = current_version + 1`, MK = `derive_mk(new_seed, new_version)` — "option (a-CLI)"), while
  Web and Flutter keep `key_version` **unchanged** and use the **raw** new seed as MK ("option (a)"). A
  CLI-rekeyed chain therefore carries `key_version=2` and an HMAC-derived MK that **Flutter cannot derive**
  (its `deriveMasterKey` has no versioned path) and that **Web must be explicitly told to derive** (its
  verify harness takes the MK as raw hex, not auto-derived from `key_version`). This is the central
  divergence the CLI leg exists to expose.
- **R2 — Raw-seed (`key_version=0`) test ledger vs CLI's versioned-first gate.** The live test ledger has
  **no `key_version` field**; its MK is the raw seed (`generate_test_ledger.py` uses `CryptoManager(mk)`
  with `mk = base64.b64decode(seed)`). But `RotateKeysCommand._get_current_key_version` returns
  `genesis.get("key_version", 1)` → **1**, so `_verify_seed` derives `derive_mk(seed, 1)` = HMAC and fails
  to decrypt `identity_secret_enc_fallback` (encrypted under the raw seed). `renew_seed()` gates on
  `_verify_seed` and therefore **returns `None` on the raw-seed ledger** — the CLI re-key cannot even start.
- **R3 — Web verify harness MK convention.** `phpoc-web/test/c2_live_rekey.mjs` `opVerify` treats the
  passed MK as raw seed bytes and does **not** derive from `key_version`. Verifying a CLI-rekeyed chain
  (`key_version=2`) requires the harness to call `deriveMk(new_seed, 2)` first — a new seam.
- **R4 — "key_version=1" means different MKs across clients.** Python: `key_version>=1` ⇒
  `HMAC(seed, "phpoc:mk:v{N}")`. Flutter: `chain.dart` genesis default `key_version=1` **but**
  `deriveMasterKey` returns the raw seed. So a Flutter chain stamped `key_version=1` (raw-seed MK) pulled
  by Python would be decrypted with `derive_mk(seed, 1)` = HMAC → mismatch. Only `key_version=0` is
  currently unambiguous cross-client.
- **R5 — CLI multi-version lookup starts at v=1.** `_make_multi_version_mk_lookup` derives
  `range(1, current_version+1)` — a `key_version=0` block is never covered, so `LedgerChain.verify()` on a
  raw-seed chain fails under the lookup even when the correct raw seed is supplied.
- **R6 — `identity_pub_key` derivation convention (RESOLVED Phase 3: raw-bytes is canonical).** The
  canonical source is the Rust crypto core `phpoc-crypto-core/src/digest.rs::identity_pub_key(&[u8; 32])`,
  which hashes the **raw 32-byte** identity secret (`sha256_hex(identity_secret)`), and PHPSPEC §2.7.1 / §286-287
  (Python `hashlib.sha256(identity_secret).hexdigest()` over raw `os.urandom(32)`). **Python is correct**
  (`core/factory.py` hashes raw bytes); the Phase 2 hypothesis ("hex-string is wire-canonical") was **wrong**.
  Web + Flutter diverge because their FRB/WASM surfaces only expose `sha256(String)` (UTF-8), so they hash the
  hex string (`271a413b…` = `sha256(hex-utf8)` of their fixture secret) instead of the raw bytes. The D5
  assertion (both Python + Flutter) now checks the canonical raw-bytes value (`47262dce…` on the real ledger);
  aligning the Web/Flutter derivation code is a **follow-up for the Web↔Flutter leg** (requires exposing a
  raw-bytes `identity_pub_key` through FRB/WASM).

### Decision (resolved — 2026-08-29)

**Option (a) — align the CLI to raw-seed re-key.** Chosen by the user. Change `renew_seed` to keep
`key_version` **unchanged** and use the raw `new_seed` as MK — the documented Flutter reference option (a),
already implemented by Web + Flutter. This resolves R1–R5:

- **R1/R4/R5:** default `_get_current_key_version` to `0` for pre-ADR (absent/`key_version=0`) ledgers;
  `_verify_seed` / `_make_multi_version_mk_lookup` cover v=0 (raw seed). A seed replacement does not bump
  `key_version` (ADR-026 rotation still does — same-seed version bump is a *different* operation).
- **R2:** with the v=0 gate fixed, `renew_seed` can start on the raw-seed test ledger.
- **R3:** the Web verify harness still derives `deriveMk(new_seed, 0)` = raw seed — no version step needed.

**Implementation delta (Phase 3):** update `test_rekey_seed.py` M1 (currently asserts the bump) and the
`key_version=1` fixtures to the raw-seed convention; re-point `renew_seed` so `new_mk = base64.b64decode(new_seed)`
(raw seed), `key_version` carried through unchanged.

Rejected: **Option (b) — extend Flutter with versioned MK** (larger blast radius through the portable Rust
crypto core and its WASM/FFI bindings; versioning is unnecessary when the seed itself is replaced).

The blueprint asserts the **cross-client invariant** (Group D): *all three clients must derive the same MK
for the same `(seed, key_version)`, and a re-keyed chain must verify on all three.* Phase 2 RED tests are
written against that invariant.

## Phase 2 (RED) results — 2026-08-29

Tests written (all RED-by-design, no implementation code touched):

- `tests/test_c2_cli_client_verify.py` — Python hermetic driver (34 tests: 22 RED / 12 guard-green).
- `phpoc-web/test/c2_cli_rekey_verify.mjs` — Web WASM verify helper (`verify` / `deriveMk` / `deriveMasterKey`).
- `phpoc-flutter/test/services/c2_cli_verify_test.dart` — Flutter Group L + Group D (11 tests: 9 RED / 2 `skip`).
- `tests/test_c2_cli_client_live_r2.py` — live R2 E2E (2 tests; `skip` offline, RED under R2 when online).

### RED profile (observed)

| Leg | RED cause | Assertions |
|-----|-----------|-----------|
| CLI re-keyer (Python) | **R2** — `renew_seed()` returns `None` on the raw-seed ledger (`_verify_seed` derives HMAC `derive_mk(seed,1)` and can't decrypt the raw-seed fallback) | A2–A6, B2–B6, D3/D4/D6/D7 (14) |
| Web verifier (Python) | **"artifact absent"** — the CLI re-keyer never emits `testdata/c2_cli_rekeyed_wire.json` (blocked on R2) | A7–A12 (6) |
| CLI verifier (Python) | **R4/R5** — `RotateKeysCommand(seed)._verify_seed(genesis)` rejects the raw-seed client chain (`key_version` defaults to 1 → HMAC) | C2, C3 (2) |
| Flutter verifier (Dart) | **"artifact absent"** — same R2 root cause | B7–B11, D2/D3/D5/D6/D8 (9) |
| Live R2 E2E | `skip` offline; RED under R2 (forward leg) when online | (2) |

**Guard-green (12):** A1, B1, C1, C4, C5, C6, C7, C8, D1, D2, D5, D8 — preconditions + invariant
assertions that already hold on the shared fixture (e.g. D1 versioned-MK parity, D8 canonical-seal
parity) and are retained as regression guards through Phase 3.

**Deferred (2 skip):** B10 (Flutter index/hash_index parity) + B12 (Flutter cookie reauth) — live R2 only,
deferred to `tests/test_c2_cli_client_live_r2.py`.

### New finding — R6 (`identity_pub_key` convention) — RESOLVED (raw-bytes canonical)

See §Known format divergences. Canonical = **SHA-256 of the raw 32-byte identity secret** (Rust
`digest.rs`, PHPSPEC §2.7.1, Python `core/factory.py`). Python is correct; Web/Flutter diverge (hash the
hex string's UTF-8). Flutter D5 now asserts the raw-bytes value against the CLI-generated wire; the
Web/Flutter derivation-code alignment is a follow-up for the Web↔Flutter leg.

## Phase 3 (GREEN) results — 2026-08-29

Implementation (option (a) raw-seed re-key) landed:

- `phpoc_cli/rotate_keys.py`: `_get_current_key_version` default `0`; `_make_multi_version_mk_lookup`
  covers `range(0, …)`; `_prepare_rekey` derives `mk_v2 = derive_mk(new_seed, 0)` (raw seed) and no longer
  bumps `key_version` (genesis/day/summary branches carry it through unchanged); `_rebuild_rekeyed_blocks`
  preserves the source hash key (`day_hash` vs legacy `block_hash`).
- `tests/test_rekey_seed.py`: fixtures → `key_version=0`; hardcoded `derive_mk(…, 2)`/`key_version=2` → `0`;
  M1 rewritten to `test_m1_key_version_unchanged_on_every_block` (raw-seed convention). **34/34 GREEN.**
- `domain/ledger/chain.py`: `_hash_key_for_block` now returns `block_hash` whenever present (mirrors
  `get_block_hash` priority) — the canonical test ledger's day blocks use the legacy universal `block_hash`
  key, which previously raised `KeyError: 'day_hash'` during re-key `verify()`.
- `tests/test_i01_rotatekeys_execution.py` `test_e2`: corrected to the ADR-026 raw-seed convention (no
  `key_version` ⇒ `key_version=0` = raw seed; first rotation bumps to `1`), replacing the stale
  "defaults to v1" premise that contradicted ADR-026. **38/38 GREEN.**
- `tests/test_c2_cli_client_verify.py`: `_require_wire` guard no longer eager-concatenates `reason` (was
  `None` on success → `TypeError`). **34/34 GREEN** (A1–A6, B1–B6, C1–C8, D1–D8).
- `phpoc-flutter/test/services/c2_cli_verify_test.dart` D5: asserts the raw-bytes
  `crypto.sha256.convert(_hexDecode(idHex))` value (was hex-string). **9 passed / 2 skipped.**
- Emitted `testdata/c2_cli_rekeyed_wire.json` (31 blocks / 146 entries, `key_version=None` preserved,
  `identity_pub_key=47262dce…`) — consumed + verified by Web + Flutter harnesses.

Hermetic matrix is **GREEN in all four directions**. The live R2 E2E (`tests/test_c2_cli_client_live_r2.py`,
`tests/test_c2_live_r2.py`) is **GREEN (2026-08-29)** after restoring the canonical test ledger to R2 and
fixing the forward leg to use `transport=None` (so `renew_seed()` no longer overwrites the canonical
`ledger/blocks/` prefix under NEW_MK).

## Assertion Matrix

**48 assertions across 5 groups.** IDs are stable for Phases 2–4 (RED → GREEN → REFACTOR).

### Group A — CLI re-keyer → Web verifier (12)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | CLI pulls the real test ledger (31 blocks / 146 entries) from live R2 under OLD MK via `RemoteLedgerSync` | Precondition | Exercises the CLI's actual remote ingest path |
| A2 | CLI `renew_seed()` completes and mints a fresh 32-byte seed ≠ old | Fresh root | **RED under R2** — raw-seed ledger gate currently fails |
| A3 | CLI re-key rewrites genesis `identity.recovery_seed_enc` under new PDK + `identity_secret_enc_fallback` under new MK; `identity_pub_key` invariant | Genesis seed envelope | Web recovers the seed from `identity.recovery_seed_enc` |
| A4 | CLI re-key re-encrypts every block entry `_enc` under new MK; `content_hash` byte-invariant | Data re-keyed | `content_hash` is plaintext-bound (ADR-005) |
| A5 | CLI re-key re-seals + re-signs; Python `LedgerChain.verify()` VALID under new MK | Self-verify | Catches CLI-only regressions before the round-trip |
| A6 | CLI re-key emits the re-keyed chain in canonical wire format (blocks + `index.json` + `hash_index.json`) to artifact + isolated R2 prefix | Shared artifact | The wire format is the cross-client contract |
| A7 | Web pulls the CLI-rekeyed chain with no error | Round-trip import | Verifier ingest path |
| A8 | Web `verifyLedgerChain` VALID under the new MK (seals + entry hash + `content_hash` + `key_version` + `prev_hash` linkage) | Cross-client integrity | The core claim; **RED under R1/R3** if MK not derived |
| A9 | Web genesis parity: nested `identity.{recovery_seed_enc, identity_pub_key, identity_secret_enc_fallback}` + seal match the CLI wire output | Genesis wire parity | CLI writes canonical blocks; Web must agree |
| A10 | Web `hash_index.json`/`index.json`/genesis parity intact after pull | Index integrity | Fast-path sync relies on the hash index |
| A11 | Web device holding the **old** seed/MK cannot decrypt the re-keyed `_enc` ciphertext | Leak-nullification | The security property motivating C-2 |
| A12 | Web stale device-cookie specifier → `reauthNeeded` on next sync | Ownership handoff | Old-MK session forced to re-auth |

### Group B — CLI re-keyer → Flutter verifier (12)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | CLI pulls the real test ledger from live R2 under OLD MK | Precondition | Mirrors A1 |
| B2 | CLI `renew_seed()` completes and mints a fresh 32-byte seed ≠ old | Fresh root | Mirrors A2 (RED under R2) |
| B3 | CLI re-key rewrites genesis `identity.recovery_seed_enc` + `identity_secret_enc_fallback`; `identity_pub_key` invariant | Genesis seed envelope | Flutter recovers the seed on unlock |
| B4 | CLI re-key re-encrypts every `_enc` under new MK; `content_hash` byte-invariant | Data re-keyed | Mirrors A4 |
| B5 | CLI re-key re-seals + re-signs; Python `LedgerChain.verify()` VALID under new MK | Self-verify | Mirrors A5 |
| B6 | CLI re-key emits canonical wire (blocks + `index.json` + `hash_index.json`) to artifact + isolated R2 prefix | Shared artifact | Mirrors A6 |
| B7 | Flutter pulls the CLI-rekeyed chain with no error | Round-trip import | Mirrors A7 |
| B8 | Flutter `chain.verify()` VALID under the new MK | Cross-client integrity | **The sharpest R1/R4 probe** — Flutter has no versioned MK |
| B9 | Flutter genesis parity (`identity.{…}` reconstructed from entries matches CLI wire) | Genesis wire parity | Flutter re-nests `identity` on import |
| B10 | Flutter `hash_index.json`/`index.json`/genesis parity intact | Index integrity | Mirrors A10 |
| B11 | Flutter device holding the **old** seed/MK cannot decrypt the re-keyed ciphertext | Leak-nullification | Mirrors A11 |
| B12 | Flutter stale device-cookie → `reauthNeeded` on next sync | Ownership handoff | Mirrors A12 |

### Group C — client re-keyer → CLI verifier (8)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Web `RekeyService.rekey()` completes against the real test ledger; CLI pulls the re-keyed chain under the new MK via `RemoteLedgerSync` | Reverse direction ingest | CLI as verifier of a web-rekeyed wire |
| C2 | CLI `LedgerChain.verify()` VALID under the web-rekeyed chain's new MK | Reverse cross-client integrity | Web re-key keeps `key_version` (option a) — CLI must accept |
| C3 | Flutter `RekeyService.rekey()` completes; CLI verifies the Flutter wire output under the new MK | Flutter→CLI integrity | **RED under R4** — Flutter `key_version=1` = raw seed, Python derives HMAC |
| C4 | CLI with the **old** seed fails to pull (HMAC tag mismatch on the obfuscated blob) | Reverse leak-nullification | Old seed cannot even fetch |
| C5 | CLI with the **old** seed fails to verify (seal mismatch) even if bytes were force-fed | Defense in depth | Nullification holds at the verify layer too |
| C6 | CLI `hash_index.json`/`index.json`/genesis parity intact after pulling a client-rekeyed chain | Index integrity | Mirrors A10/B10 |
| C7 | CLI re-pull round-trip: new MK decrypts, old MK fails, on the same re-keyed chain | Round-trip determinism | Single source of truth for both directions |
| C8 | CLI genesis parity: `identity.recovery_seed_enc` decrypts under PDK; `identity_pub_key` invariant | Genesis wire parity | Mirrors A9/B9 |

### Group D — CLI↔client cryptographic invariants (8)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `derive_mk(seed, v)` (Python) == `deriveMk(seed, v)` (Web) for v ∈ {0,1,2} | Versioned-MK parity | Both are versioned; must agree byte-for-byte |
| D2 | Python↔Flutter↔Web MK parity (option (a)): `derive_mk(seed, 0)` (Python) == `deriveMk(seed, 0)` (Web) == `deriveMasterKey(seed)` (Flutter) == raw `seed` bytes | MK derivation parity | **Encodes R1/R4 resolution** — raw seed is the MK, no versioned derivation
| D3 | `key_version` after a seed-mint re-key is **unchanged** on all three clients (option (a): no cross-client version bump) | Re-key MK policy parity | **Encodes R1** — seed replacement ≠ ADR-026 rotation |
| D4 | `content_hash` byte-identical before/after re-key on **all three** clients | Plaintext invariance | ADR-005 invariant, now including CLI |
| D5 | `identity_pub_key` == `sha256(identity_secret)` invariant across re-key on all three | Identity stability | Identity is key-independent |
| D6 | `prev_hash` cascade intact (full linkage verifies on all three) | Chain linkage | Re-sealing changes hashes → cascade must hold |
| D7 | Ciphertext-bound entry `hash` recomputed (not carried) after re-key on all three | Entry-hash parity | Web/CLI recompute; Flutter was plaintext-bound (fixed in prior leg) |
| D8 | Seal-key derivation parity: `compute_seal` (Python) == web `computeSeal` == Flutter seal for the same block + MK | Canonical seal parity | ADR-029/029a convergence incl. CLI |

### Group E — Docs (8)

| ID | Assertion | Purpose |
|----|-----------|---------|
| E1 | `docs/planning/ROADMAP.md` C-2 status: CLI↔client leg ✅ | Roadmap truth |
| E2 | `docs/planning/WEB_ROADMAP.md` build entry for the CLI↔client verify leg | Web build history |
| E3 | `docs/reference/MAP.md` inventory: new `test_c2_cli_client_live_r2.py`, `c2_cli_rekey_verify.mjs`, `c2_cli_verify_test.dart` Group L, `c2_cli_rekeyed_live_wire.json` | File inventory |
| E4 | `docs/reference/CHANGELOG.md` entry (on next release) | Release notes |
| E5 | `SESSION_HANDOFF.md` known issues + Immediate Next Steps updated | Handoff |
| E6 | `docs/planning/BACKLOG.md` C-2 status: CLI↔client E2E ✅ (remove the "gated on Phase A" caveat) | Backlog truth |
| E7 | `docs/planning/C2_SEED_REKEY_WEB_CLI_ROADMAP.md` §Phase D closure note | Roadmap closure |
| E8 | This blueprint status flip (🟡 → ✅) + record the R1/R2 resolution option chosen | Blueprint closure |

## Scope

1. **D1 — cross-client re-key verification** (Groups A–D): CLI re-keyer → Web/Flutter verifier; Web/Flutter
   re-keyer → CLI verifier; old-seed decrypt-fails in every direction; CLI↔client crypto invariants.
2. **D2 — resolve the MK-derivation divergence (R1–R5):** ✅ **decision made — option (a) raw-seed re-key.** Phase 3 implements it (re-point `renew_seed` to raw-seed MK + `key_version` unchanged; fix `_get_current_key_version` default-0 / `_verify_seed` / `_make_multi_version_mk_lookup` v=0 coverage; update `test_rekey_seed.py` M1 + fixtures).
3. **D3 — spec/format pass:** confirm `docs/spec/PHPSPEC.md` §2.10 (seed re-key) and §4 (wire format)
   state the chosen `key_version`/MK policy unambiguously (update if option (a) changes the CLI).
4. **D4 — docs** (Group E).

## Test environments

- **Hermetic (primary for RED/GREEN):** `tests/test_c2_cli_client_verify.py` drives `node
  phpoc-web/test/c2_cli_rekey_verify.mjs` over stdin/stdout (precedent `ccs4_cross_client.mjs` /
  `c2_live_rekey.mjs`) + a Dart test `phpoc-flutter/test/services/c2_cli_verify_test.dart` **Group L**
  (already referenced in MAP as "future Flutter verifier leg Group L"), consuming
  `testdata/c2_cli_rekeyed_wire.json`.
- **Live R2 E2E:** `tests/test_c2_cli_client_live_r2.py` (skips offline without a Worker API key) re-keys
  the real test ledger via the CLI, pushes an isolated prefix, and drives Web + Flutter verify; the reverse
  direction re-uses the web `c2_live_rekey.mjs` re-key and has Python verify.
- **Creds:** `TEST_CREDENTIALS.md` (Worker URL, API key, test-ledger details) — never inline.

## Phase plan

- **Phase 1 (this doc):** test exploration / blueprint — divergences + assertion matrix.
- **Phase 2 (RED):** write Groups A–D as failing tests (hermetic first, live R2 marked `skip`), documenting
  the R1–R5 failures.
- **Phase 3 (GREEN):** resolve the MK-derivation divergence (decision point), make A–D pass incl. the live
  R2 E2E.
- **Phase 4 (REFACTOR + docs):** DRY the harnesses, spec/format pass, Group E docs. ✅ **DONE (2026-08-29):** `_rebuild_rekeyed_blocks` now re-seals via the canonical `LedgerChain._hash_key_for_block` (removes the inline day/summary hash-key selection); `test_c2_cli_client_verify.py` gained a `_content_hash_map` helper (DRY's A4 + D4); PHPSPEC §2.10 harness citation lists both legs; Group E docs (ROADMAP/WEB_ROADMAP/MAP/BACKLOG/C2 roadmap/SESSION_HANDOFF/this doc) updated; CHANGELOG deferred to release.

## Dependencies & assumptions

- CLI re-key (`ph rekey-seed`) is GREEN (34/34) and pushes via the real transport contract.
- The real test ledger remains the shared fixture (genesis `e718daf3…`, identity `47262dce…`, 31 blocks /
  146 entries, raw-seed MK). Do **not** touch `~/.local/share/phpoc/` — use `testdata/` + `/tmp/` only.
- Web verify harness (`c2_live_rekey.mjs`) is extended (not replaced) to accept a versioned-MK derive step.
- Flutter `computeContentHash` strip divergence from the prior leg (helpers.dart + crypto_service.dart)
  remains open and is orthogonal; it must not mask B8/D4 results.

## Acceptance criteria

1. Every direction of the matrix is GREEN (hermetic + live R2): CLI↔Web, CLI↔Flutter, old-seed-fail.
2. R1–R5 resolved; the chosen option recorded here and reflected in PHPSPEC §2.10/§4.
3. Group E docs updated; no test ledger or personal ledger touched outside `testdata/` + `/tmp/`.
