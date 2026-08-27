# C-2 Seed Re-Key — Web (`phpoc-web`) & CLI (`phpoc-cli`) Implementation Roadmap

> **Plan:** C-2 full seed replacement — cross-client port of the Flutter `RekeyService` to **phpoc-web** and **phpoc-cli**.
> **Depends on:** ADR-026 (versioned MK), ADR-001 (sovereign key), Flutter reference `docs/planning/flutter/SEED_REKEY_C2_PHASE1.md` (✅ 4-phase TDD COMPLETE — 28/28 `rekey_service_test.dart`, 6/6 Settings Group S, suite 2010/2010, analyze 0), CLI rotation precedent `docs/planning/I01A_ROTATEKEYS_EXECUTION_PHASE1.md` + `phpoc_cli/rotate_keys.py` (`soft_rotate`/`hard_rotate`, `derive_mk(seed, version)`).
> **Purpose:** Blueprint + roadmap for bringing the C-2 **seed replacement** capability (fresh random seed → full re-key of the personal ledger under the new Master Key so a leaked/compromised seed is nullified) to the **web** and **CLI** clients, mirroring the already-completed Flutter implementation.
> **Status:** 🟡 **Web COMPLETE (4-phase TDD, 2026-08-24) — CLI + cross-client still open.** Cross-client port. See `docs/planning/BACKLOG.md`. Web: Phase 1 blueprint `docs/planning/C2_SEED_REKEY_WEB_PHASE1.md` (34 assertions R/B/M/P/S) → Phase 2 RED (28 Node + 6 Vitest) → Phase 3 GREEN (`src/services/rekey_service.js` 28/28 + Settings Security & Recovery UI 6/6 + `DevModeContext.rekey`) → **Phase 4 REFACTOR ✅** (extracted `rekey()` into named phase helpers). Phase A (CLI) + Phase D (cross-client) still open.

---

## 1. Why This Is High Priority

C-2 is the *only* operation that genuinely mitigates the **pre-existing credential leak** (personal seed + passphrase hardcoded in git history — commits `a5b124e`/`08235f8`, on `cb22154`; working tree neutralized 2026-08-21). Flutter has the full `RekeyService.rekey()` reference (mints a fresh seed, re-encrypts vault + chain + remote + device cookie so the **old** seed becomes worthless).

**Gap:** the re-key capability exists **only in Flutter**. Users on the **web** or via the **CLI** have no way to rotate to a fresh seed. The CLI has `ph rotate-keys`/`--full` (wired into `main.py` 2026-08-22), but that **bumps `key_version` under the SAME seed** (ADR-026 rotation) — it does **NOT** replace the seed. True seed-replacement in web + CLI is missing.

**Impact of not doing it:** any leaked seed remains valid on web/CLI; a compromised seed can't be nullified except through the mobile app. High availability + security parity gap.

---

## 2. Current State by Client

| Client | Key-rotation (`key_version` bump, same seed) | **Seed replacement (C-2, new seed)** |
|---|---|---|
| Python CLI | ✅ `RotateKeysCommand.soft_rotate`/`hard_rotate` + `derive_mk(seed, version)` | ❌ **Missing** — `rotate_keys.py` can take an `old_seed`/`seed`, but no command mints a *new* seed (out-of-scope for rotation) |
| Web | ⚠️ `deriveMk(seed, version)` + `CryptoManager` + `generateSeed()` primitives exist | ✅ **Done** — `RekeyService` (`src/services/rekey_service.js`) + Settings Security & Recovery UI + `DevModeContext.rekey` (Phase B/C GREEN 2026-08-24) |
| Flutter | ✅ + **C-2 seed re-key** done (reference) | ✅ `RekeyService.rekey()` — 28/28, reference |

**Key primitives already present (what we build on):**
- **CLI:** `derive_mk(seed, version)` (security/crypto.py), `hard_rotate` (`phpoc_cli/rotate_keys.py`), `PassphraseAuthenticator._keys` multi-MK session cache, WAL, chain re-seal via `chain.py` (`SEAL_FIELDS`/`select_seal_fields`, ADR-029/029a).
- **Web:** `deriveMk(seed, version)` (`src/crypto/index.js:597`), `generateSeed()` (`index.js:498`), `CryptoManager` key_version, chain seal whitelist (`src/ledger/seal_fields.js` → `chain.js`), IndexedDB storage, `SyncService` push/pull, `DevModeContext` bootstrap/state.

---

## 3. Phased Roadmap (4-Phase TDD per client, reference-mirrored)

> The Flutter plan's test groups (R, B, M, P, S) are the contract. Port them per client, mapping Flutter `RekeyService` → web/CLI equivalents. Each client runs the 4-phase TDD loop (Phase 1 blueprint → Phase 2 RED → Phase 3 GREEN → Phase 4 REFACTOR).

### 🔜 Phase A — CLI first (reference validation on the trusted tool)

**Rationale:** the CLI `hard_rotate` loop (Python `RotateKeysCommand`) is already the reference implementation of the re-key *mechanics*. Making the CLI the seed-mint home validates the re-key loop end-to-end before the web port, and gives an immediate operational escape-hatch for the leaked seed (addresses the 🔴 leak without waiting on the UI).

- **[A1] Extend `RotateKeysCommand` with a seed-replacement mode** — add `--renew-seed` (mint 32-byte CSPRNG seed via existing seed-gen) that, on top of `hard_rotate`, *replaces* the seed: mint new seed → `derive_mk(new_seed, new_version)` → full chain re-encrypt + re-seal (ADR-029a) → rewrite `recovery_seed_enc`/seed vault → re-encrypt staging + blind index + device cookie → push to remote/R2 → rotate cookie specifier. Reuse `hard_rotate`'s per-`_enc` loop (the `if key.endswith("_enc")` decrypt-old/re-encrypt-new, already mirrored as Flutter `_reencryptEntryMap`).
- **[A2] Wire into `main.py`** — new `ph rekey-seed` subcommand (or `ph rotate-keys --renew-seed`), `require_auth`-gated, two-secret confirmation + backup-before-write.
- **[A3] CLI tests** — port Flutter Group R/B/M/P assertions to Python (`tests/test_rotate_keys.py` / new `tests/test_rekey_seed.py`). Reference: Flutter `rekey_service_test.dart` 28/28.
- **Exit:** CLI seed-rekey GREEN; `ph rekey-seed` reachable + tested; remote/R2 verified under new MK.

### ✅ Phase B — Web engine + orchestration (GREEN 2026-08-24)

- **[B1] Web `RekeyService`** (`src/services/rekey_service.js`) ✅ — mirror Flutter `rekey()`: gate (unlocked or valid current seed+passphrase), backup (chain + vault snapshot), mint new seed (`generateSeed()`), re-key every block `_enc` under new MK via `deriveMk(new_seed, new_version)` + re-seal via `chain.js`/`seal_fields.js` (ADR-029a whitelist), rewrite genesis `recovery_seed_enc` + PDK, re-encrypt staging rows + device cookie, persist (IndexedDB), migration marker (`key_version`, `seed_fingerprint`).
- **[B2] Web remote push / device coordinates** ✅ — `RekeyService.rekey()` pushes the rewritten chain via `sync.pushLedgerBlocks({ forceAll: true })` and rotates the device-cookie specifier (P1/P3 GREEN). `hash_index.json`/`index.json`/genesis parity is inherited from the existing push path.
- **[B3] Web wiring** ✅ — `DevModeContext` exposes `rekey(...)`; integrate with passphrase/auth state; re-verify the re-keyed chain is loaded by History/ledger.
- **[B4] Web tests** ✅ — Group R/B/M/P ported to `test/rekey_service_web_test.mjs` (node): 28/28 GREEN. Reference: Flutter 28/28.
- **Exit:** web re-key engine + remote push GREEN.

### ✅ Phase C — Web Settings UI (Security & Recovery) (GREEN 2026-08-24)

- **[C1] Settings "Section Security & Recovery"** ✅ — added "Re-key to new Recovery Seed" alongside any existing passphrase entry, mirroring Flutter Settings Group S (6/6): two-secret confirmation (current passphrase/seed + explicit acknowledge), reveal-gate (new seed shown once after write, requires user-saved confirmation), cancel/back aborts with no mutation, network-failure leaves local consistent, success dialog shown once.
- **[C2] Web component tests** ✅ — Vitest + RTL port of Flutter Group S (`test/rekey_settings_web.test.mjs`): 6/6 GREEN. Reference: Flutter Settings Group S 6/6.
- **Exit:** web UI + UX GREEN; user can re-key to a fresh seed entirely in the browser.
- **Phase 4 (REFACTOR) ✅ (2026-08-24):** extracted `rekey()` in `rekey_service.js` into named phase helpers — `_recoverIdentitySecret`, `_rebuildBlocks` (in-memory re-encrypt + re-seal + entry-hash recompute + prev_hash cascade), `_persistNewKeySet`, `_recordRekeyMarker`, `_pushRewrittenChain` — mirroring Flutter Phase 4. 28/28 node + 6/6 Vitest GREEN retained. **Web 4-phase TDD COMPLETE.**

### 🔜 Phase D — Cross-client verification + docs

- **[D1] Cross-client re-key verification** — after a CLI `ph rekey-seed`, the re-keyed chain must pull + verify under the new MK on **web** and **Flutter** (P4/lifecycle parity); a device holding the OLD seed must no longer decrypt (leak nullification proof).
- **[D2] Spec/format pass** — confirm PHPSPEC `key_version` + ADR-029/029a seal whitelist cover a seed-mint re-key (mirror `CANONICAL_SEALFIELD_*` style); document the seed-replacement (vs rotation) semantic.
- **[D3] Docs** — update ROADMAP (mark C-2 cross-client), WEB_ROADMAP (build entries), MAP.md (new files), CHANGELOG on release; update `SESSION_HANDOFF.md`.

---

## 4. Test/Assertion Contract (port of Flutter groups)

| Group | Focus | Flutter ref | Web port | CLI port |
|---|---|---|---|---|
| **R** (11) | Re-key orchestration: gate, backup-before-write, mint (32B, fresh), vault under new PDK, old MK no longer decrypts, genesis re-write, block `_enc` under new MK, content_hash unchanged, re-seal/verify under new MK, end-to-end verify | 28/28 | `rekey_service_web_test.mjs` | `test_rekey_seed.py` |
| **B** (5) | Backup recoverable; abort-on-partial-write; no double-run; `seed_fingerprint` marker; two-step seed reveal | | | |
| **M** (6) | `key_version` bump on genesis/blocks; identity MAC recompute; `prev_hash` cascade rewrite; atomic file swap / no orphaned remote; append-only preserved; (Commonplace lockstep N/A on CLI) | | | |
| **P** (6) | Push chain/hash_index/index to R2; push rebuilt genesis; device-cookie rotation → reauthNeeded; second-device re-pull+verify under new MK; idempotent-guard; staging/ownership cleared | | | |
| **S** (6) | **Web-only UI** (Security & Recovery section, two-secret confirm, reveal-gate, cancel-aborts-no-mutation, network-failure-local-consistent, one-time success dialog) | 6/6 | `rekey_settings_web.test.mjs` | n/a (CLI) |

---

## 5. Dependencies & Assumptions

- **Flutter is the reference** — port its 28/28 + 6/6 assertions, not new design (DRY, behavior-parity). The Flutter `_reencryptEntryMap` ↔ Python `hard_rotate` per-`_enc` loop is the canonical re-key core.
- **CLI ordering:** Phase A before Web is *recommended but not blocking* — Web can proceed in parallel on the engine using Flutter as reference; CLI-first is preferred to have the operational escape-hatch for the live leak ASAP.
- **Valid 0.4.0+ chain precondition** (from Flutter plan §6): re-key presumes a currently-valid, canonical 0.4.0+ chain (snapshot-decrypt + re-seal requires valid seals/content hashes). Do not run C-2 on a legacy INVALID chain until it's migrated (see `LEDGER_VALIDITY_WORKFLOW_PHASE1.md`).
- **Web crypt ensure:** web `deriveMk(seed, version)` + `generateSeed()` must be exercised by tests before relying on them for re-key (they exist but are not currently exercised by a re-key path — Phase B1 should add a small green baseline).
- **Commonplace chain:** Flutter re-keys the Commonplace chain in lockstep (shared seed→MK). Web does not yet have a Commonplace port; note as a follow-on (not blocking C-2 web).
- **Remote/R2 idempotence:** full-chain overwrite under new MK is idempotent; existing push helpers handle block replace. Validate remote genesis before claiming success (mirror Flutter P1/P2).

---

## 6. Acceptance Criteria (Definition of Done)

1. **CLI:** `ph rekey-seed` (or `ph rotate-keys --renew-seed`) mints a fresh seed, re-keys the full chain + vault + staging + cookie under the new MK, pushes to R2, rotates device cookie; Python test group (R/B/M/P) GREEN; 0 regressions.
2. **Web:** a user can re-key to a new seed from Settings — engine (`RekeyService`) + UI (Security & Recovery) both GREEN; re-keyed chain loads and verifies in the web app; old seed invalidates.
3. **Cross-client:** a re-keyed chain (from any of CLI/Web) pulls + verifies under the new MK on the other two clients; a device holding the old seed cannot decrypt (leak nullification verified end-to-end).
4. Docs updated (ROADMAP, WEB_ROADMAP, MAP, CHANGELOG-on-release, SESSION_HANDOFF).

---

## 7. Out of Scope (tracked separately)

- **Commonplace web port** and cross-client Commonplace re-key (BACKLOG).
- **Blind index** re-key in web (web uses `index.json` from chain; confirm parity with CLI — in scope only insofar as the re-key must rewrite it).
- **History rewrite / repo clean of the leaked seed** — C-2 nullifies the *live* seed; purging committed git history is a separate user-initiated act (history rewrite).
