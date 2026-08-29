# C-2 Cross-Client Verification — Phase D (Phase 1 test-exploration blueprint)

> **Roadmap:** `C2_SEED_REKEY_WEB_CLI_ROADMAP.md` §Phase D
> **Spec:** `docs/planning/WEB_FLUTTER_PARITY_SPEC.md` §P2
> **Status:** ✅ **Phase 4 (REFACTOR) COMPLETE 2026-08-28.** Hermetic matrix GREEN both directions — Web re-key→Flutter verify (A7–A11), Flutter re-key→Web verify (B7–B11), crypto invariants (C) — 18/18 pass, 2/2 live-only skip on each harness; full Flutter suite 2115/0; web harness 18/0/2. Fixed 4 cross-client divergences + 1 PDK-derivation divergence. Phase 4: DRY'd the harness (`runRekey`/`collectContentHashes` web; `_collectEnc`/`_chain` Flutter), Group D spec pass (`PHPSPEC.md` §2.3 + §2.10), Group E docs (ROADMAP / WEB_ROADMAP / MAP / BACKLOG / C2 roadmap / SESSION_HANDOFF). **Live R2 E2E ✅ GREEN (2026-08-28):** `tests/test_c2_live_r2.py` + `phpoc-web/test/c2_live_rekey.mjs` — pull the real test ledger (31 blocks/146 entries) under OLD MK, re-key through the REAL WASM `RekeyService` (ALT_SEED + `NewCorrectHorseBatteryStaple99!`), push an isolated R2 prefix under NEW MK, pull+verify under NEW MK, assert old-seed device fails (HMAC tag mismatch). Unblocked by fixing the Python `content_hash` divergence to PHPSPEC §5.5/§6.1 (KEEP `_enc` suffix, string values — `engine.py` reorder + `migrate_format.py` + `chain.py` KEEP-primary + `generate_test_ledger.py` ADR-029a `compute_seal`), regenerating + re-pushing the test ledger (genesis `e718daf3…`, identity `47262dce…`), 146/146 content_hash cross-check vs Web. Remaining: Flutter `computeContentHash` strip divergence (helpers.dart + crypto_service.dart) + CLI Phase A.

## Purpose

Prove the C-2 seed-replacement property **across clients**: a chain re-keyed on any client must pull +
verify under the new Master Key (MK) on the other two, and a device holding the **old** seed must fail
to decrypt — the leak-nullification guarantee. This is verification + docs, not new re-key mechanics.

The re-key *engines* already exist and are independently GREEN (Web `RekeyService` 28/28 node + 6/6
Settings; Flutter `RekeyService` 28/28 + 6/6 Settings). What has **never** been proven is that the
**canonical wire output** of one client's re-key is consumable + verifiable by the other client. That
is the single question this task answers.

## Architecture Overview

The shared cross-client contract is the **canonical PHPSPEC wire format** (`docs/spec/PHPSPEC.md` §4),
NOT any client's local storage format. Each client has (at least) three representations, and the
verification must exercise the **wire** layer:

| Layer | Web (`phpoc-web`) | Flutter (`phpoc-flutter`) |
|---|---|---|
| Local storage | `ledger:blocks` array of canonical block dicts (`chain.js`) | SQLite `blocks.data_enc` = base64(JSON(block-map)) |
| Canonical (in-memory / seal) | `chain.js` `buildGenesisBlock()` → `identity.{recovery_seed_enc, identity_pub_key, identity_secret_enc_fallback}` | `chain.dart` `buildGenesisBlock()` → top-level `recovery_seed_enc`/`identity_pub_key`/`identity_secret_enc_fallback` |
| **Wire (PHPSPEC §4)** | `sync.js` `pushLedgerBlocks({forceAll})` → nested `identity.{…}` | `PhpSpecFormat.blockToMap` + `LedgerBackupService._blockToPhpSpec` / `LedgerPushService` → nested `identity.{…}` (reconstructed via `_extractIdentityFromEntries`) |

**The re-key writes each client's *local* representation; the canonicalization to the wire format is a
separate layer.** Cross-client verification is therefore about two things: (1) the re-key correctly
mutates the fields that the *other* client reads after a pull, and (2) the wire serialization of the
re-keyed blocks round-trips byte-correctly.

### Verification mechanism

Two variants, mirroring the CCS-4 harness (`tests/test_ccs4_cross_client.py` drives `node
ccs4_cross_client.mjs` over stdin/stdout):

1. **Hermetic fixture (primary, deterministic):** a shared canonical 0.4.0+ fixture chain
   (genesis + N day blocks, `_enc` fields, valid seals/content-hashes/entry-hashes) written once as
   JSON. Re-key it with **web** (`RekeyService` under node + real WASM `CryptoService` + `MemoryBackend`,
   precedent: `rekey_service_web_test.mjs`) and separately with **Flutter** (`RekeyService` in a Dart
   test, precedent: `rekey_service_test.dart`), then feed each re-keyed output to the *other* client's
   `verify()` + a decrypt-under-old-seed probe. No network.
2. **Live R2 E2E (authoritative acceptance):** actually re-key on one client against the live R2 Worker
   (creds in `TEST_CREDENTIALS.md`), pull + verify on the other. The final proof of leak-nullification.

### Known format divergences to resolve during verification (risks)

These are the exact seams where cross-client drift could hide; the assertion matrix (§Assertion Matrix)
turns each into a check:

- **R1 — Genesis `identity` nesting.** Web seals/verifies genesis with `identity.{…}` nested; Flutter's
  in-memory `chain.dart` genesis uses **top-level** `recovery_seed_enc`/`identity_pub_key`/
  `identity_secret_enc_fallback`; the Flutter **wire** layer re-nests them under `identity`. The re-key
  must leave the wire `identity.recovery_seed_enc` decryptable under the **new** PDK on the other client.
- **R2 — Flutter re-key writes a non-canonical storage genesis.** `rekey_service.dart _rekeyGenesis`
  stores `{"seed": newSeedPdkEnc, "block_hash":…, "identity_seal":…}` in `data_enc` (a *flat* `seed`
  field, not `identity.recovery_seed_enc`). Whether the export/push path then emits
  `identity.recovery_seed_enc` = the **new** seed (vs the old/stale one) is unproven — the crux of the
  Flutter→Web direction.
- **R3 — Entry `hash` binding differs.** Web `computeEntryHash` hashes the **ciphertext** dict (must be
  recomputed after re-encrypt); Flutter `computeEntryHash` is plaintext-bound. The *final* re-keyed
  chain must `verify()` on both regardless — this is subsumed by A8/B8, but the divergence is why entry
  hashes must be recomputed, not carried.
- **R4 — `key_version` is NOT bumped.** Option (a): new seed = new raw MK, `key_version` stays 0 (web) /
  1 (Flutter `chain.dart` genesis default). A verifier must accept the *unchanged* `key_version`, not
  require a bump.

## Assertion Matrix

**46 assertions across 5 groups.** IDs are stable for Phases 2–4 (RED → GREEN → REFACTOR).

### Group A — Web re-keyer → Flutter verifier (12)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Web `RekeyService.rekey()` completes without error against a canonical 0.4.0+ fixture chain | Precondition — re-key runs on a valid chain | Re-key presumes valid seals/hashes (per Flutter plan §6) |
| A2 | Web re-key mints a fresh seed: 44-char base64, decodes to 32 bytes, ≠ old seed | Fresh root | A stale/reused seed would not nullify the leak |
| A3 | Web re-key rewrites genesis `identity.recovery_seed_enc` under the new PDK + `identity_secret_enc_fallback` under the new MK; `identity_pub_key` invariant | Genesis seed envelope under new key set | Flutter recovers the seed from `identity.recovery_seed_enc` on unlock |
| A4 | Web re-key re-encrypts every block entry `_enc` field under the new MK; `content_hash` byte-invariant | Data re-keyed, plaintext preserved | `content_hash` is plaintext-bound (ADR-005) |
| A5 | Web re-key recomputes ciphertext-bound entry `hash` + re-seals + re-signs; web `LedgerChain.verify()` VALID under new MK | Self-verify before cross-client | Catches web-only regressions before the round-trip |
| A6 | Web re-key emits the re-keyed chain in canonical wire format (blocks + `index.json` + `hash_index.json` + genesis) to the fixture (hermetic) or R2 (live) | Shared artifact | The wire format is the cross-client contract |
| A7 | Flutter pulls the re-keyed chain with no error | Round-trip import | Pull/import is the verifier's ingest path |
| A8 | Flutter `chain.verify()` VALID under the new MK (seals + entry hash + `content_hash` + `key_version` + `prev_hash` linkage) | Cross-client integrity | The core "re-keyed chain verifies elsewhere" claim |
| A9 | Flutter genesis parity: `identity.recovery_seed_enc`/`identity_pub_key`/`identity_secret_enc_fallback` + seal + `identity_seal` match the web re-keyed genesis | Genesis wire parity | R1 risk — nesting + seed envelope must agree |
| A10 | Flutter `hash_index.json`/`index.json`/genesis parity intact after pull | Index integrity | Fast-path sync relies on the hash index |
| A11 | Flutter device holding the **old** seed/MK cannot decrypt the re-keyed `_enc` ciphertext (genesis + ≥1 day block) | Leak-nullification | The security property that motivated C-2 |
| A12 | Flutter stale device-cookie specifier → `reauthNeeded` on next sync | Ownership handoff | P-group parity: old-MK session forced to re-auth |

### Group B — Flutter re-keyer → Web verifier (12)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Flutter `RekeyService.rekey()` completes without error against the canonical fixture | Precondition | Mirrors A1 |
| B2 | Flutter re-key mints a fresh seed (32 bytes, ≠ old) | Fresh root | Mirrors A2 |
| B3 | Flutter re-key emits `identity.recovery_seed_enc` = **new** seed envelope + `identity_secret_enc_fallback` = new-MK encryption, on the **wire** format (not just the flat `data_enc.seed`) | Genesis wire correctness | R2 risk — the unproven seam of the Flutter→Web direction |
| B4 | Flutter re-key re-encrypts every `_enc` field under new MK; `content_hash` byte-invariant | Data re-keyed | Mirrors A4 |
| B5 | Flutter re-key re-seals + re-signs; Flutter `chain.verify()` VALID under new MK | Self-verify | Mirrors A5 |
| B6 | Flutter re-key emits the re-keyed chain in canonical wire format to the fixture / R2 | Shared artifact | Mirrors A6 |
| B7 | Web pulls the re-keyed chain with no error | Round-trip import | Mirrors A7 |
| B8 | Web `LedgerChain.verify()` VALID under the new MK | Cross-client integrity | Mirrors A8 |
| B9 | Web genesis parity (nested `identity.{…}` matches Flutter's wire output) | Genesis wire parity | Mirrors A9 |
| B10 | Web `hash_index.json`/`index.json`/genesis parity intact | Index integrity | Mirrors A10 |
| B11 | Web device holding the **old** seed/MK cannot decrypt the re-keyed ciphertext | Leak-nullification | Mirrors A11 |
| B12 | Web stale device-cookie → `reauthNeeded` on next sync | Ownership handoff | Mirrors A12 |

### Group C — Cross-client cryptographic invariants (8)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `deriveMasterKey(newSeed)` yields the **same** MK bytes on Web and Flutter (raw 32 seed bytes) | MK derivation parity | Both clients must agree on "the new MK" |
| C2 | new MK ≠ old MK; new seed ≠ old seed | Freshness | Nullification depends on distinct roots |
| C3 | `content_hash` byte-identical before/after re-key on **both** clients | Plaintext invariance | ADR-005 invariant, cross-client |
| C4 | `key_version` unchanged by a seed-mint re-key on **both** clients | Option (a) parity | R4 risk — no versioned-MK bump |
| C5 | identity secret + `identity_pub_key` invariant across re-key (device-scoped, key-independent) | Identity stability | Identity is not part of the seed root |
| C6 | `prev_hash` cascade intact (full linkage verifies on both clients) | Chain linkage | Re-sealing changes hashes → cascade must hold |
| C7 | Entry plaintext recovered under new MK == plaintext under old MK (no data loss) on both clients | Lossless re-encrypt | Data fidelity, not just validity |
| C8 | Seal-key derivation parity: web `computeSeal` and Flutter seal produce the same seal for the same block + MK | Canonical seal parity | ADR-029/029a cross-client convergence |

### Group D — Spec/format pass (D2) (6)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `PHPSPEC.md` documents seed-mint re-key (new seed) distinctly from ADR-026 rotation (same seed, `key_version++`) | Spec clarity | Two operations share the "re-key" name |
| D2 | ADR-029/029a closed-set rule + per-type whitelist already exclude `key_version`/`identity`/`identity_seal`/`signature`/own-hash → a seed-mint re-key needs **no schema change** | Confirm no spec change | Verifies the re-key is seal-transparent |
| D3 | `PHPSPEC.md` states a seed-mint re-key does **not** bump `key_version` (option a) | Semantics documented | Prevents future "bump it anyway" drift |
| D4 | ADR-026 vs C-2 distinction documented (rotation = same seed; re-key = new seed) | ADR clarity | `key_version` bump ≠ seed replacement |
| D5 | `canonical_seal_vectors.json` remains valid (no new block type introduced) | Vector stability | Seed-mint introduces no block type |
| D6 | Cross-client MK derivation (raw-seed-as-MK at `key_version` 0/1) documented as the shared derivation contract | Derivation contract | C1's documentation counterpart |

### Group E — Docs (D3) (8)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `ROADMAP.md` marks C-2 cross-client verification complete | Roadmap status | Documentation impact contract |
| E2 | `WEB_ROADMAP.md` adds a build entry for cross-client verification | Build log | Web/mobile build log parity |
| E3 | `MAP.md` adds the new harness/test files | File inventory | File-level HOT/COLD tracking |
| E4 | `CHANGELOG.md` gets a versioned entry (on release) | Release log | Release-cut contract |
| E5 | `SESSION_HANDOFF.md` marks P2 complete and removes it from the queue | Handoff state | Session continuity |
| E6 | `BACKLOG.md` reflects P2 status (remove or mark done) | Backlog hygiene | Issue queue truth |
| E7 | `C2_SEED_REKEY_WEB_CLI_ROADMAP.md` marks Phase D complete | Roadmap closure | The parent roadmap |
| E8 | `C2_CROSS_CLIENT_VERIFY_PHASE1.md` status flips to ✅ complete | Blueprint closure | 4-phase TDD closeout |

## Scope

### D1 — Cross-client re-key verification (Groups A + B + C)

- **Web as re-keyer (doable now):** re-key on Web, then Flutter pulls + verifies under the new MK; a
  Flutter device seeded with the **old** seed fails to decrypt. (Group A)
- **Flutter as re-keyer:** re-key on Flutter, then Web pulls + verifies under the new MK; old-seed Web
  fails. (Group B)
- **CLI as re-keyer:** blocked on CLI Phase A (`ph rekey-seed`). Once Phase A lands, run the same
  matrix with CLI as re-keyer (Groups A/B generalize to a 3×3 matrix; not in this task's scope).

### D2 — Spec/format pass (Group D)

### D3 — Docs (Group E)

## Test environments

- **Hermetic (primary):** node (`RekeyService` + real WASM `CryptoService` + `MemoryBackend`) for Web;
  `flutter test` (`RekeyService` + in-memory DB) for Flutter; a shared canonical fixture JSON. No network.
- **Live R2 E2E (acceptance):** Web (Vivaldi on `localhost:5173`) ↔ Flutter (`emulator-5554` /
  `pixel_6_avg`) against the live R2 Worker (creds in `TEST_CREDENTIALS.md`), mirroring CCS-4.

## Phase plan (4-phase TDD)

1. **Phase 1 (this doc):** assertion blueprint — 46 assertions, groups A–E. ✅
2. **Phase 2 (RED):** build the cross-client verify harness — shared fixture generator + web re-key/verify
   probe + Flutter re-key/verify probe + old-seed-fail probe. Assertions encode the *unproven* matrix and
   report NOT-VERIFIED/RED until Phase 3 runs the flows. ✅ (2026-08-28)
3. **Phase 3 (GREEN):** run the hermetic matrix (Web→Flutter, Flutter→Web, old-seed-fail) and the live R2
   E2E; make every assertion pass. ✅ **hermetic matrix GREEN (2026-08-28)** — live R2 E2E still deferred.
4. **Phase 4 (REFACTOR):** DRY the harness, then D2 spec pass (Group D) + D3 docs (Group E). ✅ (2026-08-28)

## Dependencies & assumptions

- Re-key presumes a valid canonical 0.4.0+ chain (see `flutter/LEDGER_VALIDITY_WORKFLOW_PHASE1.md`).
- D1 (Web/Flutter pairs) unblocks now; D1 (CLI) unblocks on CLI Phase A.
- Web `deriveMk`/`generateSeed` + Flutter `deriveMasterKey` are already exercised by their re-key test
  suites (green baseline exists).

## Acceptance criteria

1. At least Web↔Flutter **both directions** verified: pull + verify under new MK, old-seed decrypt fails
   (Groups A + B + C GREEN, hermetic + live).
2. Spec/format pass (Group D) complete.
3. All docs (Group E) updated; `C2_SEED_REKEY_WEB_CLI_ROADMAP.md` marked cross-client-complete.
