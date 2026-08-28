# C-2 Seed Re-Key — Web (`phpoc-web`) Phase 1 Blueprint

> **Plan:** Port the C-2 full-seed-replacement re-key (Flutter `RekeyService.rekey()` reference) to **phpoc-web** — engine/orchestration (roadmap Phase B) + Settings Security & Recovery UI (roadmap Phase C).
> **Reference:** `docs/planning/flutter/SEED_REKEY_C2_PHASE1.md` (✅ 4-phase TDD COMPLETE — 28/28 `rekey_service_test.dart` R/B/M/P, 6/6 Settings Group S), `docs/planning/C2_SEED_REKEY_WEB_CLI_ROADMAP.md`, ADR-026 (versioned MK), ADR-029/029a (closed seal whitelist), ADR-001 (sovereign key), D1–D8/D11.
> **Status:** ✅ **4-phase TDD COMPLETE (2026-08-24).** Phase 2 RED (28 Node + 6 Vitest) → Phase 3 GREEN (`src/services/rekey_service.js` 28/28 + Settings Security & Recovery UI 6/6 + `DevModeContext.rekey`) → Phase 4 REFACTOR (extracted named phase helpers in `rekey_service.js`). CLI Phase A + cross-client Phase D remain (`C2_SEED_REKEY_WEB_CLI_ROADMAP.md`).

---

## 1. Purpose

Give the web client the **only operation that nullifies a leaked/compromised recovery seed**: mint a fresh 32-byte CSPRNG seed → derive a new Master Key → re-encrypt + re-seal the entire local ledger chain (and push it to R2) under the new MK → rewrite genesis recovery-seed + identity-secret fallback → re-encrypt staging rows + device cookie → rotate device-cookie specifier. After re-key, the old seed derives a dead MK and can no longer decrypt anything.

This mirrors the completed Flutter implementation (option (a) — new seed = new raw MK, `key_version` unchanged) and the CLI `hard_rotate` per-`_enc` loop, but is a **true seed replacement**, not an ADR-026 same-seed version bump.

---

## 2. Preconditions (from Flutter plan §6)

- Re-key presumes a **currently-valid 0.4.0+ chain** (valid block seals + entry `content_hash`, canonical ADR-029a seal whitelist). Do not run C-2 on a legacy INVALID chain until migrated.
- The session must hold a usable **master key** (unlocked) or be able to derive one from the current seed + passphrase (two-secret gate).
- Web crypto primitives `generateSeed()` and `deriveMk(seed, version)` exist but are **not currently exercised by any re-key path** — Phase B1 must add a small green baseline before relying on them.

---

## 3. Web Architecture Map (what we build on)

Exact facts gathered from `phpoc-web/src` (2026-08-24):

| Concern | Location | Fact |
|---|---|---|
| Master key (login) | `DevModeContext.login()` | `mk = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS)` — WASM `authenticate` derives MK **directly from the raw seed** (32 bytes). Web is at `key_version = 0` (raw-seed-as-MK). |
| Versioned MK | `src/crypto/index.js:597` `deriveMk(seed, version)` | `version=0` → raw seed; `version>=1` → HMAC-SHA256(seed, `phpoc:mk:v{N}`). |
| Seed mint | `src/crypto/index.js:498` `generateSeed()` | 32-byte CSPRNG → base64 44-char seed. |
| Seed storage | `DevModeContext` `STORED_SEED_KEY='phpoc_seed'` | Raw base64 seed persisted in IndexedDB/localStorage (web does **not** rely on genesis alone for the seed). |
| Passphrase tokens | `phpoc_passphrase_hash`, `phpoc_pdk_token` | `sha256(PDK + ':' + seed)`; PDK-encrypted verify token. Both are seed-dependent and must be rewritten after re-key. |
| Genesis | `chain.js` `buildGenesisBlock()` | `identity.recovery_seed_enc = encrypt(seed, pdk)`; `identity.identity_pub_key = sha256(identitySecret)`; `identity.identity_secret_enc_fallback = encrypt(identitySecret, masterKey)`; `block_hash = computeSeal(...)`; `identity_seal = mac(block_hash, identitySecret)`. |
| Identity secret | `buildGenesisBlock()` | `identitySecret = deriveMasterKey(generateSeed())` (32-byte hex). **Key-independent** — constant across re-key; only its *encrypted fallback* changes. |
| Entry encryption | `engine.js` `_encryptEntry()` | `_enc`-suffixed ciphertext fields under `masterKey`: `startTime_enc`, `endTime_enc`, `metadata_enc`, `pauses_enc`, `device_uuid_enc`, `end_device_uuid_enc`, `title_enc`, `tags_enc`, `comment_enc`, `duration_enc`. |
| `content_hash` | `engine.js` `_computeContentHash()` / `chain.js` `_verifyContentHash()` | SHA-256 over **decrypted plaintext** (`_enc` fields decrypted, lists sorted, `content_hash` excluded). **Key-independent → invariant under re-key.** |
| Entry `hash` | `engine.js` `_encryptEntry()` → `computeEntryHash(data)` (`utils.js:94`) | SHA-256 over the **encrypted** `data` dict (`jsonSortIndent2`), i.e. includes `_enc` ciphertext + `content_hash`. **Key-dependent → MUST be recomputed after re-key.** |
| Block seal | `seal_fields.js` `computeSeal()` | HMAC-SHA256 over `jsonSort(selectSealFields(block))` with the ADR-029a **closed** per-type whitelist: genesis/day `['type','day_index','date','prev_hash','entries','original_hash']`; month/year summaries `['type','month|year','date','prev_hash','original_hash']`. `identity`, `identity_seal`, `signature`, hash keys, `format_version`, `key_version`, stray fields are **never** seal inputs. |
| Identity seal | `chain.js` | `identity_seal = mac(block_hash, identitySecret)`; verified with `verifyMac`. |
| Chain storage | `chain.js` `_getBlocks`/`_saveBlocks` | Single array of block dicts under `LOCAL_LEDGER_BLOCKS = 'ledger:blocks'` (IndexedDB). |
| Remote push | `sync.js` `pushLedgerBlocks({forceAll:true})` | Pushes blocks (`ledger/blocks/NNNNNN.json`) + `ledger/index.json` + `ledger/hash_index.json` + `ledger/hash_index.sha256`; includes a **genesis-collision guard** against remote. |
| Device cookie | `sync/cookie.js` `DeviceCookie` | Local `{device_specifier, creation_time}` under `LOCAL_COOKIE='cookie'`; remote `staging/blobs/device_cookie.bin`. Rotation → next `checkAndSync()` returns `reauthNeeded` (ADR-030 ownership handoff). |
| Reauth | `sync/reauth.js` `performReauth()` | Clears MK on failure; re-authenticates via passphrase. |

### Web-specific deltas vs Flutter/Python

1. **Dual seed storage.** Web persists the raw seed under `phpoc_seed` *and* in genesis `recovery_seed_enc`. Re-key must rewrite **both**, plus the two passphrase tokens (`phpoc_passphrase_hash`, `phpoc_pdk_token`).
2. **Entry `hash` is ciphertext-bound.** Unlike Flutter/Python (where the entry hash is plaintext-bound and invariant), web `computeEntryHash` hashes the *encrypted* data dict, so every entry `hash` must be recomputed after re-encrypting its `_enc` fields. `content_hash` (plaintext) is invariant — this is the web analog of Flutter R9, split into two assertions.
3. **Genesis `identity` is outside the seal.** `recovery_seed_enc` + `identity_secret_enc_fallback` are not seal inputs, so the genesis seal input is identical before/after re-key — only the HMAC *key* changes. Day-block seal inputs *do* change (re-encrypted entries + recomputed entry hashes).
4. **No Commonplace on web.** Flutter M5 (Commonplace lockstep) is N/A — tracked as a follow-on in BACKLOG.
5. **No per-block `key_version`/`format_version`.** Both are metadata-only (I-07). Option (a) leaves `CryptoManager.keyVersion = 0`; no new chain-schema fields are introduced.

---

## 4. Key Design Decisions

- **D1 — Option (a) parity:** new seed → new MK = `deriveMk(newSeed, 0)` (= `deriveMasterKey(newSeed)` = raw seed). `key_version` stays 0; no new block fields. The roadmap's `deriveMk(new_seed, new_version)` resolves to version 0 for a freshly-minted seed (a new seed is already a fresh root; version is only meaningful for same-seed rotation).
- **D2 — Identity secret constant.** `identitySecret` and `identity_pub_key` are key-independent and preserved. Re-key only re-encrypts `identity_secret_enc_fallback` (old MK → new MK) and re-derives `identity_seal = mac(newHash, identitySecret)`.
- **D3 — Entry hash recompute.** After re-encrypting each entry's `_enc` fields under the new MK, recompute `entry.hash = computeEntryHash(data)`; `content_hash` is carried through unchanged.
- **D4 — Atomic local swap.** Build the full re-keyed blocks array in memory, then write once to `ledger:blocks` (single `storage.set`) so a mid-re-key failure leaves the old chain intact.
- **D5 — Backup-before-write.** Snapshot `ledger:blocks` + `phpoc_seed` + genesis to a `backup:` storage key before mutating; recovery restores the old MK's chain.
- **D6 — Remote idempotent overwrite.** Reuse `SyncService.pushLedgerBlocks({forceAll:true})` (full replace); verify remote genesis before claiming success (Flutter P1/P2 parity); rotate the device cookie specifier → `reauthNeeded`.
- **D7 — Two-secret gate.** Re-key requires the current seed + passphrase (or an already-unlocked MK) plus explicit user acknowledgement.

---

## 5. Target Files

**New:**
- `phpoc-web/src/services/rekey_service.js` — `RekeyService` with `rekey({ crypto, storage, sync, seed, passphrase })` → `{ newSeed, newMasterKey, backupKey }`. Mirrors Flutter `rekey()` phase helpers (gate → backup → mint → re-encrypt → re-seal → persist → push → cookie-rotate).
- `phpoc-web/test/rekey_service_web_test.mjs` — node-unit, Groups R/B/M/P (port of Flutter `rekey_service_test.dart`).
- `phpoc-web/test/rekey_settings_web.test.mjs` — Vitest + RTL, Group S (Security & Recovery UI).

**Change:**
- `phpoc-web/src/context/DevModeContext.jsx` — expose `rekeyToNewSeed(passphrase)`; wire auth state + reauth on cookie rotation; rewrite `phpoc_seed` + passphrase tokens; re-verify chain loads.
- `phpoc-web/src/components/screens/Settings.jsx` — new "Security & Recovery" section + Re-key flow (Phase C).
- `phpoc-web/src/sync/sync.js` — optional `pushReKeyedLedger()` wrapper over `pushLedgerBlocks` + cookie rotation (if not reusable as-is).

**Reuse (no change expected):**
- `src/ledger/seal_fields.js` (`computeSeal`/`selectSealFields`), `src/ledger/chain.js` (seal/verify already key-parameterized), `src/crypto/index.js` (`generateSeed`, `deriveMk`, `CryptoManager`), `src/sync/cookie.js`, `src/sync/reauth.js`.

---

## 6. Assertion Groups (Phase 1 contract)

Port of Flutter groups R/B/M/P (engine) + S (web UI). IDs are web-scoped (`R1`–`R11`, `B1`–`B5`, `M1`–`M6`, `P1`–`P6`, `S1`–`S6`). Flutter origin in parentheses.

### Group R — Re-key orchestration (11)

- **R1** (Flutter R1) **Gate.** `rekey()` throws when no usable MK and no valid current seed+passphrase; succeeds when unlocked or when a correct seed+passphrase derives the current MK.
- **R2** (R2) **Backup-before-write.** A `backup:` snapshot of `ledger:blocks` + `phpoc_seed` + genesis exists before any mutation, and decrypts under the **old** MK.
- **R3** (R3) **Mint.** New seed is `generateSeed()` output: base64 44-char, decodes to 32 bytes.
- **R4** (R4) **Freshness.** New seed ≠ old seed, and ≠ any persisted prior seed fingerprint.
- **R5** (R5, web-split) **Seed + token rewrite.** `phpoc_seed` = new seed; genesis `identity.recovery_seed_enc = encrypt(newSeed, pdk)`; `phpoc_passphrase_hash` = `sha256(pdk + ':' + newSeed)`; `phpoc_pdk_token` re-derived.
- **R6** (R6) **Old MK dead.** After re-key, stored `_enc` ciphertext decrypts under the new MK but **not** under the old MK/seed.
- **R7** (R7) **Genesis identity fallback.** `identity.identity_secret_enc_fallback` re-encrypts `identitySecret` under the new MK; genesis re-seals + verifies under the new MK; `identity_pub_key` unchanged.
- **R8** (R8) **Block `_enc` re-key.** Every entry's `_enc` field (`startTime_enc`, `endTime_enc`, `metadata_enc`, `pauses_enc`, `device_uuid_enc`, `end_device_uuid_enc`, `title_enc`, `tags_enc`, `comment_enc`, `duration_enc`) decrypts under the new MK.
- **R9** (R9, web-split) **`content_hash` invariant.** Each entry's `content_hash` is byte-identical before/after re-key (plaintext-bound).
- **R10** (web-only) **Entry `hash` recomputed.** Each `entry.hash` equals `computeEntryHash(re-encrypted data)` and verifies via `verifyEntryHash` under the new MK (ciphertext-bound, so it *must* change).
- **R11** (R10/R11) **Re-seal + end-to-end verify.** Full `LedgerChain.verify()` passes with the new MK + same `identitySecret`; reading entries with the old seed/MK fails.

### Group B — Backup / recovery / guards (5)

- **B1** (B1) **Backup recoverable.** Restoring the `backup:` snapshot yields a chain that verifies under the old MK.
- **B2** (B2) **Abort-on-partial-write.** A simulated mid-re-key throw leaves `ledger:blocks`, `phpoc_seed`, and genesis byte-identical to the pre-re-key state (atomic swap).
- **B3** (B3) **No double-run.** Re-keying an already-re-keyed ledger (fingerprint matches current seed) is rejected or a safe no-op; a second full re-key is not silently destructive.
- **B4** (B4) **`seed_fingerprint` marker.** After re-key, a fingerprint (e.g. `sha256(newSeed)`) is persisted so subsequent re-keys know the current seed.
- **B5** (B5) **Two-step seed reveal.** New seed is produced exactly once, surfaced via the reveal flow, and never logged or stored in plaintext beyond `phpoc_seed` + the one-time reveal.

### Group M — Chain integrity / cascade (6)

- **M1** (M1) **`key_version` unchanged.** `CryptoManager.keyVersion` stays 0; no new `key_version`/`format_version` field appears on any block (option (a) parity).
- **M2** (M2) **Identity MAC recompute.** Every block's `identity_seal` = `mac(new block_hash, identitySecret)`; `identitySecret`/`identity_pub_key` unchanged; `verifyMac` passes.
- **M3** (M3) **`prev_hash` cascade.** Re-sealing recomputes each day block's `day_hash` and cascades it into the next block's `prev_hash`; full linkage verifies.
- **M4** (M4) **Atomic swap / no orphaned remote.** Single `ledger:blocks` write locally; remote push replaces all `ledger/blocks/*` + index files; no old-MK block remains remotely.
- **M5** (M5) **Append-only preserved.** Block count, `day_index` values, entry counts, and ordering are unchanged; only ciphertext + seals + entry hashes change.
- **M6** (M5 Commonplace) **N/A on web.** Commonplace lockstep is out of scope (no web Commonplace port) — asserted as a documented follow-on, not blocking.

### Group P — Remote push / cross-device (6)

- **P1** (P1) **Push chain + indexes.** Re-keyed chain pushes `ledger/blocks/*`, `ledger/index.json`, `ledger/hash_index.json`, `ledger/hash_index.sha256` under the new MK.
- **P2** (P2) **Push rebuilt genesis.** Remote genesis matches the re-keyed genesis; genesis-collision guard passes (or is explicitly overwritten by the re-key path).
- **P3** (P3) **Cookie rotation → reauthNeeded.** After push, the device-cookie specifier rotates; the next `checkAndSync()` returns `reauthNeeded` (ADR-030 ownership handoff).
- **P4** (P4) **Second-device re-pull + verify.** A second device pulling with the new seed verifies the re-keyed chain under the new MK; a device holding the old seed cannot.
- **P5** (P5) **Idempotent guard.** Re-pushing after a completed re-key is idempotent (same blocks, no corruption, no double cookie rotation).
- **P6** (P6) **Staging/ownership cleared.** Re-key re-encrypts/clears staging rows + blind index + device cookie so no old-MK ciphertext remains remotely.

### Group S — Web Settings UI (6, Phase C)

- **S1** (S1) **Security & Recovery section.** `Settings.jsx` shows "Re-key to a new Recovery Seed" alongside passphrase entry.
- **S2** (S2) **Two-secret confirm.** Requires current passphrase/seed + explicit acknowledge before invoking `rekeyToNewSeed`.
- **S3** (S3) **Reveal-gate.** New seed shown once after a successful write, requiring user-saved confirmation; not shown again.
- **S4** (S4) **Cancel/back aborts.** Aborting leaves no mutation (no seed/MK/chain change).
- **S5** (S5) **Network-failure local-consistent.** A remote-push failure leaves the local chain re-keyed and consistent (push retryable) or aborts cleanly — never a half-re-keyed remote.
- **S6** (S6) **One-time success dialog.** Success dialog is shown exactly once.

---

## 7. Test Plan

| File | Runner | Groups | Count |
|---|---|---|---|
| `phpoc-web/test/rekey_service_web_test.mjs` | node (existing `.test.mjs` harness; mock `storage`/`sync`/`transport`, real `CryptoService` WASM + `chain.js`) | R, B, M, P | 28 |
| `phpoc-web/test/rekey_settings_web.test.mjs` | Vitest + React Testing Library | S | 6 |

**Baseline green-first:** add a small pre-re-key green baseline exercising `generateSeed()` + `deriveMk(seed,0)` + a valid genesis/day chain (`i01_key_rotation_web_test.mjs` is the existing key-rotation precedent to mirror). Reference Flutter assertion count: 28 (R/B/M/P) + 6 (S).

---

## 8. Out of Scope (tracked separately)

- Commonplace web port + cross-client Commonplace re-key (BACKLOG).
- Blind-index re-key beyond rewriting `ledger/index.json`/`hash_index.json` (confirm parity with CLI; in scope only as the re-key must rewrite them).
- Git-history rewrite of the leaked seed — C-2 nullifies the *live* seed; history purging is a separate user-initiated act.
- CLI `ph rekey-seed` (roadmap Phase A) — parallel track, not part of this web blueprint.

---

## 9. Notes / Open Questions

- **`authenticate` vs `deriveMk`:** re-key should derive the new MK via `deriveMk(newSeed, 0)` (or `deriveMasterKey(newSeed)`), not `authenticate('', newSeed, …)`, to keep the derivation explicit and version-aware.
- **Genesis collision on push:** `pushLedgerBlocks` already has a genesis-collision guard — confirm whether re-key needs a dedicated "authoritative overwrite" flag (D6) or can reuse `forceAll`.
- **`identitySecret` recovery source:** during re-key the identity secret is recovered from `identity_secret_enc_fallback` (old MK) or held in `LedgerEngine`/`chain.identitySecret` — pick the in-memory source and assert it stays constant (D2).
- **WASM in node tests:** the existing `.test.mjs` harness already runs `CryptoService` WASM under node (precedent: `i01_key_rotation_web_test.mjs`).
