# C-2 CLI Seed Re-Key (`ph rekey-seed`) — Phase 1 Blueprint

> **Plan:** `docs/planning/C2_SEED_REKEY_WEB_CLI_ROADMAP.md` — Phase A (CLI)
> **Reference:** Flutter `docs/planning/flutter/SEED_REKEY_C2_PHASE1.md` (✅ 4-phase TDD COMPLETE — 28/28 `rekey_service_test.dart`, 6/6 Settings Group S), Web `docs/planning/C2_SEED_REKEY_WEB_PHASE1.md` (✅ COMPLETE), CLI rotation precedent `phpoc_cli/rotate_keys.py` (`soft_rotate`/`hard_rotate`, `derive_mk(seed, version)`) + `tests/test_i01_rotatekeys_*.py` (82 tests).
> **Purpose:** Blueprint of the C-2 **seed replacement** capability for the Python CLI — mint a fresh random seed → full re-key of the personal ledger (vault, chain, staging, blind index, device cookie) under the new Master Key → push to R2 → rotate cookie specifier, so a leaked/compromised seed is truly nullified (the only operation that genuinely mitigates the pre-existing git-history seed leak).
> **Status:** ✅ 4-phase TDD COMPLETE (2026-08-29) — 34/34 `test_rekey_seed.py` GREEN; full Python suite 2649 pass/1 skip/0 fail.
> **Phase 4 (REFACTOR) DONE (2026-08-29):** DRY'd the per-`_enc` re-key loop shared between `hard_rotate` and `renew_seed` into `_enc_fields` / `_decrypt_crypto_for_version` / `_prevalidate_entries_decryptable` / `_reencrypt_entry_data`; split `renew_seed` into `_prepare_rekey` / `_rebuild_rekeyed_blocks` / `_persist_rekeyed_state` (+ `_push_rekeyed_state`), mirroring Flutter/Web Phase 4. **Transport adapter gap RESOLVED (2026-08-29):** `_push_transport_updates` / `_push_rekeyed_state` now route through the real `AbstractStagingTransport.push(path,data)`/`pull(path)` contract — cookie via `transport.push(REMOTE_COOKIE_PATH, …)`, staging via `RemoteStagingSync.push(entries, device_id, master_key=mk_v2)`, ledger via `RemoteLedgerSync.push_blocks(force=True)`/`push_hash_index`/`push_index` — replacing the flat `push_cookie`/`push_blob` no-ops; push failures are logged as warnings, not silently swallowed. `tests/test_rekey_seed.py` P1–P6 (spy + assertions) and `tests/test_i01_rotatekeys_integration.py` I6 updated to the real contract; full Python suite 2649 pass/1 skip/0 fail.

---

## 1. Motivation & Gap

Flutter and Web already ship C-2 seed replacement (`RekeyService`). The CLI's `ph rotate-keys`/`--full`
(**wired into `main.py` 2026-08-22**) only **bumps `key_version` under the SAME seed** (ADR-026 rotation) —
it does **NOT** replace the seed. A user who only has the CLI cannot nullify a leaked seed.

**C-2 on the CLI** = `hard_rotate` mechanics **+ seed replacement**:

| Capability | Seed changes? | MK changes? | Data re-encrypted? |
|---|---|---|---|
| `ph rotate-keys` (soft) | ❌ | ✅ `key_version++` | Mutable state only |
| `ph rotate-keys --full` (hard) | ❌ | ✅ `key_version++` | Full chain |
| **`ph rekey-seed` (C-2)** | ✅ **new random seed** | ✅ **new root MK** | **Full vault + chain + remote** |

## 2. Scope Decision & Guardrails

- **Preserve D8 (Recoverability):** the *new* seed becomes the single recovery root; the old seed is retired.
- **Preserve D2/D4/D5/D11:** old blocks must still decrypt + verify **under the new MK**; the chain is
  re-encrypted in place (ciphertext + seals), never logically re-written; append-only order preserved.
- **Explicit backup before write** + **two-secret confirmation** (current passphrase re-entered to re-derive the
  PDK, + explicit acknowledgment) + **one-shot new-seed reveal**.
- **Push to remote/R2 + rotate device cookie** so other devices re-pull under the new MK.

### Design option (resolved)

> **⚠️ SUPERSEDED (2026-08-29):** cross-client verify Phase 1 (`C2_CLI_CLIENT_VERIFY_PHASE1.md`) found that
> option (a-CLI) is **not** cross-client compatible — Flutter has no versioned-MK derivation, so a
> CLI-rekeyed chain (`key_version=2`, HMAC-derived MK) cannot verify on Flutter. **The user chose option (a):**
> align the CLI to raw-seed re-key (new seed = new raw MK, `key_version` unchanged). This section is retained
> for history; the Phase 3 implementation will re-point `renew_seed` accordingly (see
> `C2_CLI_CLIENT_VERIFY_PHASE1.md` §Decision).

**Option (a-CLI) — new seed + version bump, versioned derivation (superseded).** The CLI derives MKs versioned
(`derive_mk(seed, version)`, ADR-026) everywhere, so C-2 keeps that scheme:

- `new_version = current_version + 1`
- `new_mk = derive_mk(new_seed_bytes, new_version)`  (decryption uses the old seed/MKs)

This is the exact shape of the existing `hard_rotate` (`mk_v2 = derive_mk(self.seed, new_version)`), with the
seed swapped from `self.seed` → freshly-minted `new_seed`. It matches the roadmap's "mint new seed →
`derive_mk(new_seed, new_version)`".

> **Flutter divergence note (was "documented, not a defect" — now a confirmed defect):** Flutter chose
> "new seed = raw MK, `key_version` unchanged" because its `deriveMasterKey(seed)` is raw-seed-as-MK. This
> divergence was **not** harmless: it means a CLI-rekeyed chain (version-bumped, HMAC-derived MK) cannot verify
> on Flutter. Resolved by adopting option (a) — see `C2_CLI_CLIENT_VERIFY_PHASE1.md`.

## 3. Architecture Overview

```
RotateKeysCommand.renew_seed()   (new method; reuses hard_rotate's per-`_enc` loop)
├── 1. Gate: self.seed (old raw seed) verifies genesis identity fallback → else fail
├── 2. Backup: create_backup() BEFORE any write (chain + staging + index + cookie + identity.json)
├── 3. Verify: LedgerChain.verify() under multi-version old-MK lookup (precondition)
├── 4. Mint: mint_new_seed() → 32-byte CSPRNG → base64 string
├── 5. Derive: new_version = current+1 ; new_mk = derive_mk(new_seed, new_version)
├── 6. Re-key every block `_enc` under new MK (reuse hard_rotate loop: decrypt-old / encrypt-new)
│     ├── re-seal each block (ADR-029a whitelist via compute_seal/select_seal_fields)
│     ├── recompute entry hashes (ciphertext-bound) — content_hash invariant (plaintext unchanged)
│     └── recompute identity MACs + prev_hash cascade
├── 7. Re-encrypt mutable state under new MK: identity_secret_enc_fallback, staging, blind index,
│     device cookie, AND identity.json's identity_secret_enc (gap in existing _rotate_mutable_state)
├── 8. Rewrite seed vault: recovery_seed_enc ← RecoveryManager.encrypt_seed(new_seed_b64, PDK)
│     (requires the passphrase-derived PDK — see §4 CLI deltas)
├── 9. Persist: write re-keyed chain atomically; record rekey marker + seed_fingerprint (HMAC of new seed)
├── 10. Push to remote/R2 via the real transport contract: cookie (`transport.push(REMOTE_COOKIE_PATH, …)`),
│     staging (`RemoteStagingSync.push` under new MK), chain (`RemoteLedgerSync.push_blocks(force=True)`/
│     `push_hash_index`/`push_index`) — all under the new MK
└── 11. Rotate device cookie specifier → force reauth on next sync
```

### Components in scope

| File / role | Change |
|---|---|
| `phpoc_cli/rotate_keys.py` | Add `mint_new_seed()`, `renew_seed()`, `seed_fingerprint()`; add `pdk` param; factor the per-`_enc` re-key loop so `hard_rotate` and `renew_seed` share it (DRY) |
| `main.py` | Add `ph rekey-seed` subcommand (`require_auth`-gated): re-prompt passphrase → derive PDK → `RotateKeysCommand(..., pdk=..., renew_seed=True)` → print new seed once |
| `tests/test_rekey_seed.py` **(new)** | Port Flutter Groups R/B/M/P + CLI Group C |
| `security/recovery.py` | Reuse `generate_recovery_seed()` / `encrypt_seed()` / `seed_to_key()` (no change expected) |
| Worker / `domain/ledger/chain.py` | No structural change (blob replace; re-seal helpers already exist) |

## 4. CLI Deltas (vs Flutter/Web — what makes this port different)

1. **`recovery_seed_enc` is PDK-encrypted in production, not MK-encrypted.** `core/factory.py` writes
   `RecoveryManager.encrypt_seed(seed, pdk)`; `PassphraseAuthenticator.authenticate()` decrypts it with the PDK.
   (The existing `_rotate_mutable_state` re-encrypts it with the MK — a latent divergence that only matters here.)
   **C-2 must rewrite it under the PDK** (`encrypt_seed(new_seed_b64, pdk)`), so the command needs the PDK.
   `PassphraseAuthenticator` does **not** retain the PDK/passphrase — only the raw seed — so `main.py` must
   **re-prompt the passphrase** (this is the "two-secret confirmation") and derive `pdk = PBKDF2(passphrase,
   per-user-salt)` before calling `renew_seed()`.
2. **`identity.json`'s `identity_secret_enc` is MK-encrypted and NOT re-encrypted by `_rotate_mutable_state`.**
   It works today only via `_get_identity_secret()`'s genesis fallback. `renew_seed()` must re-encrypt it under the
   new MK so the file stays coherent (and the fallback path is not silently depended on).
3. **Re-key marker + `seed_fingerprint` have no AppPreferences equivalent on the CLI.** Use a marker file
   `rekey_seed.json` in `data_dir` holding `{seed_fingerprint, key_version, rekeyed_at}`. The no-double-run guard
   (B3) and idempotency guard (P5) read it.
4. **Reveal gate is stdout, not a dialog.** The new seed is printed to stdout exactly once after an explicit
   acknowledgment prompt (mirrors Flutter S6/B5).
5. **No Commonplace chain on the CLI** (not yet ported). M5 becomes a defensive no-op: the re-key neither creates
   nor corrupts any `commonplace.json` if one happens to exist in `data_dir`.
6. **Identity secret unchanged.** C-2 re-keys ciphertext, not identity — `identity_secret` (and thus
   `identity_pub_key` = `sha256(secret)`) is preserved, so the per-user PDK salt is stable and the same passphrase
   keeps unlocking after re-key.

## 5. Test Groups

### Group R — Re-key orchestration (~11 tests)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| R1 | `renew_seed()` with a wrong/absent old seed returns `None`/`False` and mutates nothing | Gate | Ownership proof before any destructive rewrite |
| R2 | `renew_seed()` creates a timestamped backup **before** any write | Safety | Recovery export is the only rollback for a bad re-key |
| R3 | `mint_new_seed()` returns a base64 string decoding to exactly **32 bytes** | Correctness | CSPRNG seed must be full-strength 256-bit |
| R4 | `mint_new_seed()` returns a **different** seed than the current one | Freshness | Seed replacement is only meaningful if the seed actually changes |
| R5 | After re-key, `recovery_seed_enc` decrypts (under the PDK) to the **new** seed | Seed vault rewrite | Nullifies the old seed; the passphrase now recovers the new one |
| R6 | After re-key, the **old** seed/MK no longer decrypts entries or the identity fallback | Nullification | A leaked old seed must become worthless |
| R7 | Genesis `identity.recovery_seed_enc` is rewritten and the genesis re-seals under the new MK | Seed vault + seal | Genesis seal must cover the new vault bytes |
| R8 | Every block's `_enc` field decrypts under the **new** MK | Re-encryption | Full-chain ciphertext migration |
| R9 | Every entry's `content_hash` is **unchanged** before/after re-key | Integrity | Plaintext invariant (ciphertext-only rewrite) |
| R10 | Every block re-seals and verifies under the **new** MK (ADR-029a whitelist) | Seal migration | Seal transparency — no schema change |
| R11 | Full chain `LedgerChain.verify()` passes end-to-end under the new key set | End-to-end | The re-keyed chain is a valid canonical chain |

### Group B — Backup & safety (~5 tests)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Backup captures the pre-rekey chain under the **old** MK and verifies independently | Restorability | The backup must decrypt with the old MK it was taken under |
| B2 | Re-key aborts with **no partial write** if any block fails to re-encrypt/re-seal | Atomicity | A half-rewritten chain is worse than no rewrite |
| B3 | Re-key refuses if the rekey marker already reflects a re-key (no double-run) | Idempotency | Prevents re-minting over a fresh seed |
| B4 | Re-key records `seed_fingerprint` (HMAC-SHA256 of the new seed) in `rekey_seed.json` | Drift detection | A 64-hex digest that differs across seeds |
| B5 | The new seed is surfaced only via a **one-shot reveal** after explicit acknowledgment | Reveal gate | The seed is shown exactly once, never re-printed |

### Group M — Migration / key exchange (~6 tests)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| M1 | Re-key updates `key_version` on genesis and every block to `current+1` | Version bump | Matches the CLI's versioned-MK scheme |
| M2 | Re-key recomputes identity MACs on genesis under the new MK | MAC migration | Identity seal must bind the new block hash |
| M3 | Re-key rewrites all `prev_hash` links in a cascading rewrite consistent with the new seals | Linkage | Chain must remain linked after every hash changes |
| M4 | Old sealed block hashes are replaced atomically; no orphaned/orphan files remain | Atomic swap | Single-writer file swap, no dangling references |
| M5 | Re-key neither creates nor corrupts any `commonplace.json` (defensive no-op) | CLI scope | Commonplace is not ported to the CLI; must not be touched |
| M6 | Re-key preserves append-only order and date-grouping (no logical re-ordering) | D5/D11 | Only ciphertext + seals change, never block order |

### Group P — Push & device coordinates (~6 tests)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| P1 | Re-key pushes the rewritten chain to R2 (blocks + `hash_index.json` + `index.json`) | Remote parity | Remote must match local under the new MK |
| P2 | Re-key pushes the reconstructed genesis with the new `recovery_seed_enc` | Genesis push | The new seed vault must reach remote |
| P3 | Re-key rotates the device-cookie specifier → next sync returns `reauthNeeded` | Ownership handoff | Force other devices off stale-MK sessions |
| P4 | After re-key, a second device re-pulls + verifies under the **new** MK | Cross-device | Other devices recover under the new seed |
| P5 | Repeat re-key is idempotent-guarded (ablated by B3) | Idempotency | Second run is a no-op, not a double re-mint |
| P6 | Remote staging/ownership metadata is cleared/rotated so no stale-MK session lingers | Cleanup | No device keeps a valid old-MK cookie |

### Group C — CLI command wiring (~6 tests)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `ph rekey-seed` subcommand exists and is `require_auth`-gated | Reachability | The escape-hatch is reachable from the CLI, not just the engine |
| C2 | `rekey-seed` re-prompts for the passphrase and derives the PDK (two-secret confirmation) | PDK source | Needed to rewrite the PDK-encrypted seed vault (§4.1) |
| C3 | A wrong re-entered passphrase aborts with **no mutation** | Gate | Confirmation failure leaves the ledger untouched |
| C4 | The new seed is printed to stdout **once** on success (reveal gate) | UX | Mirrors Flutter S6 — no auto re-show |
| C5 | `rotate-keys --renew-seed` triggers seed replacement (not just a version bump) | Flag semantics | The old seed must be genuinely retired |
| C6 | Re-running `rekey-seed` when the marker exists is refused | No double-run | CLI-level B3/P5 guard |

**Total: R(11) + B(5) + M(6) + P(6) + C(6) = 34 assertions.**

## 6. Test Conventions (Phase 2 prep)

- **File:** `tests/test_rekey_seed.py` (new). Reuse the fixture helpers from
  `tests/test_i01_rotatekeys_execution.py` (`_setup_test_ledger`, `_build_genesis`, `_build_day_block`,
  `_make_entry`, `_compute_content_hash`) — either import or re-declare locally.
- **PDK realism:** the test fixture must write `recovery_seed_enc = RecoveryManager.encrypt_seed(seed_b64, pdk)`
  (PDK-encrypted) and `identity_secret_enc` in `identity.json` (MK-encrypted), so R5/R6/R7 and C2 exercise the
  **production** vault shape, not the existing rotate-keys test's MK-encrypted `recovery_seed_enc` convention.
- **Run:** `PYTHONPATH=. python3 -m pytest tests/test_rekey_seed.py -x`.
- **Transport:** use a stub `transport` (like `TransportSpy` in `conftest.py`) for P1/P2/P3/P6; hermetic otherwise.

## 7. Acceptance (Definition of Done)

1. `ph rekey-seed` mints a fresh seed, re-keys the full chain + vault + staging + blind index + device cookie
   under the new MK, rewrites `recovery_seed_enc` under the PDK, pushes to R2, and rotates the cookie.
2. `tests/test_rekey_seed.py` — all 34 assertions GREEN; full Python suite 0 regressions.
3. The old seed no longer decrypts anything; the new seed verifies + decrypts the whole vault/chain (proven by R6/R11).
4. DOX pass: `docs/planning/AGENTS.md` child index, `BACKLOG.md` (Phase A status), `ROADMAP.md`, `MAP.md`,
   `SESSION_HANDOFF.md` updated.
