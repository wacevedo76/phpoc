# C-2: Full Seed Replacement (Re-key Under a New Root) — Phase 1 Blueprint

> **Plan:** Feature decision C-2 (user-directed) — see `ARCHITECTURAL_DECISIONS.md` gap noted under ADR-026 / ADR-001
> **Depends on:** ADR-026 (versioned MK), ADR-001 (sovereign key), passphrase change already in Flutter (`AuthService.changePassphrase`, tests B1–B6, H6–H9)
> **Purpose:** Blueprint of the C-2 capability — **replace the recovery seed entirely** with a fresh random seed and full re-key of the personal ledger (vault, local chain, remote/R2, device cookies) so a leaked/compromised seed is truly nullified.
> **Status:** 🔜 Phase 1 (blueprint; awaiting user approval to proceed to Phase 2 RED)
> **Next Phase:** Phase 2 (RED: test definition)

---

## 1. Motivation & What C-2 Actually Fixes

The user's requirement ("change both the Recovery Seed and the passphrase") is a **seed replacement**, which is categorically different from the capabilities that exist today:

| Capability | Exists? | Seed changes? | MK changes? | Data re-encrypted? |
|---|---|---|---|---|
| Change passphrase (`changePassphrase` / `scripts/change_passphrase.py`) | ✅ Yes | ❌ No | ❌ No | ❌ No (only the seed's PDK envelope) |
| Key rotation soft (`ph rotate-keys`) | ⚠️ Engine green, **not wired into CLI** | ❌ No | ✅ `key_version++` re-derives | Mutable state only |
| Key rotation hard (`ph rotate-keys --full`) | ⚠️ Engine green, **not wired into CLI** | ❌ No | ✅ `key_version++` re-derives | Full chain re-encryption |
| **C-2: Replace the seed with a new one** | ❌ **Missing** | ✅ **Yes, new random seed** | ✅ **Yes, new root MK** | **Full vault + chain + remote re-key** |

**Key insight from investigation:** ADR-026's rotation deliberately keeps the seed as the permanent root (it bumps `key_version` and re-derives the *same* seed). That is correct for passphrase/key hygiene under the D8 recoverability directive and lets the seed always recover everything. But it **cannot remediate a leaked/compromised seed** — the attacker who has the seed still holds the root. C-2 closes that gap: it mints a brand-new seed, making the old one worthless.

C-2 is the operation that genuinely mitigates the **pre-existing credential leak** (seed + passphrase hardcoded in `onboarding_screen.dart:205-206` and `diag_verify.dart:19`, commits `a5b124e`/`08235f8`, on `cb22154`).

## 2. Scope Decision & Guardrails

C-2 is a **full re-key under a new root**. It must therefore:
- **Preserve D8 (Recoverability):** the *new* seed becomes the single recovery root going forward; the old seed is retired.
- **Preserve D2 (Zero-Knowledge) & D4 (Chain of Trust):** old blocks must still decrypt and verify, **under the new MK**, after re-encryption; seals/identity/MACs must verify on the new key set.
- **Preserve D5/D11 (append-only):** the historical chain is *re-encrypted in place* (a migration rewrite of ciphertext + seals), not truncated or re-written logically. This is the same class of operation as the existing hard-rotation `--full` (`RotateKeysCommand.hard_rotate`), extended to **roll the seed**, not just `key_version`.
- **Require an explicit backup** before any write, and a **both-secret gate** (current seed/passphrase to unlock + confirmation) before the new seed is minted.
- **Push the re-keyed chain to remote/R2 and rotate the device cookie + ownership**, so all devices/remote re-pull under the new MK.

> **Design note — current Flutter MK derivation:** `AuthService`/`CryptoService.deriveMasterKey(seed)` returns the **raw base64-decoded 32 seed bytes as the MK** (matching Python's original seed==MK). ADR-026's versioned `derive_mk(seed, version)` is implemented in Python but **not yet in Flutter**. C-2 can choose either (a) keep the current raw-seed-MK scheme and simply use the *new seed* as the new raw MK, or (b) adopt versioned derivation and set `key_version` for the new key. **Recommended: (b)** — mint the new seed and derive the new MK via the versioned scheme (`key_version := current+1` under the *new* seed), keeping each client's derivation in lockstep with Python. This must be confirmed at Phase 2 before tests are written.

## 3. Architecture Overview

C-2 threads through the same layering as the existing hard rotation + passphrase change:

```
NewSeedRekeyService.rekey({oldPassphrase, newPassphrase?, generatedSeed})
├── 1. Gate: require unlocked OR current seed+passphrase (ownership proof)
├── 2. Backup: snapshot current ledger chain + vault + remote blob (R2) to a recovery export
├── 3. Snapshot clear: decrypt old plaintext (entries, metadata) under OLD MK once
├── 4. Mint new seed: 32 bytes CSPRNG → base64; derive NEW MK (versioned, D8-safe)
├── 5. Re-key every block: re-encrypt all `_enc` fields under NEW MK
│     ├── re-seal each block (block_hash / day_hash / month_hash / year_hash types via ADR-029/029a whitelist)
│     ├── recompute entry content_hashes (plaintext-unchanged; ciphertext-only)
│     └── recompute identity MACs (genesis) + prev_hash links (cascading rewrite via hard-rotate path)
├── 6. Re-encrypt mutable state: seed vault (new PDK), indexing/blind index, staging, device cookie specifier
├── 7. Rewrite recovery_seed_enc in genesis identity under NEW MK + NEW seed envelope
├── 8. Persist local: write re-keyed chain + vault; seal a migration marker (`key_version`, `seed_fingerprint`)
├── 9. Push to remote/R2: replace `ledger/blocks/*.json`, `ledger/hash_index.json`, `ledger/index.json`,
│      `recovery_seed_enc`-bearing genesis, and any remote seed metadata → all under NEW MK
├── 10. Rotate device cookie + ownership specifier → force remote reauth on next sync (no stale MK sessions)
└── 11. Post: keep the user unlocked under new passphrase/seed; surface new seed for safe backup (2-step reveal)
```

### Components in scope

| File / role | Change |
|---|---|
| `lib/services/rekey_service.dart` **(new)** | Orchestrates C-2: `rekey()`, `mintNewSeed()`, backup gate, snapshot-clear, re-key loop, remote push, cookie rotation |
| `lib/services/auth_service.dart` | Extend `changePassphrase` path OR add a sibling `rekeyToNewSeed(...)`; write new seed vault envelope under new PDK |
| `lib/core/crypto/crypto_service.dart` | (if adopting versioned MK) `deriveMasterKey(seed, {version})` + versioned sub-key derivation; new-seed minting |
| `lib/data/ledger/chain.dart` | Re-key/re-seal loop at chain level (mirror Python `hard_rotate`); `key_version` per block |
| `lib/data/ledger/sealable_chain.dart` / `commonplace_engine.dart` | Re-key the **Commonplace chain** too (shares the same seed→MK) — D7/D8 parity |
| `lib/data/storage/database.dart` | `setSeedVault` (new envelope); per-block MK rewrite; migration marker |
| `lib/services/ledger_push_service.dart` | Push re-keyed chain to R2; `app_push` of the new genesis + hash_index |
| `lib/services/onboarding_service.dart` / device-cookie | Rotate ownership specifier; ensure remote reauth path fires on next sync (ADR-030) |
| `lib/features/settings/settings_screen.dart` | **Security & Recovery** section: "Change Passphrase" (existing) + "Re-key to a new Recovery Seed" (new); two-secret confirmation + new-seed reveal |
| Worker (`worker/`) | No structural change required (blob replace), but must accept a full-chain overwrite under the new MK |
| CLI (`phpoc_cli/rotate_keys.py`) | **Wire `ph rotate-keys` into `main.py`** (currently unreachable) so CLI parity exists for the trusted-tool escape hatch; add a `--renew-seed` mode for C-2 CLI parity (optional, out of Flutter scope) |

## 4. Test Groups

### Group R: `RekeyService` orchestration — ~11 tests
| ID | Assertion |
|----|-----------|
| R1 | `rekey()` requires either unlocked state or valid current seed+passphrase, else throws `AuthException` |
| R2 | `rekey()` signs a backup (chain + vault + remote snapshot) **before** any write |
| R3 | `mintNewSeed()` returns a base64 string decoding to exactly **32 bytes** |
| R4 | `mintNewSeed()` returns a **different** seed than the current one (cryptographically fresh) |
| R5 | After re-key, the vault `getSeedVault()` decrypts under the **new PDK** (new passphrase) |
| R6 | After re-key, the **old seed/MK no longer decrypts** the vault envelope |
| R7 | Genesis `identity.recovery_seed_enc` rewrites and unseals under the **new** MK |
| R8 | Every block's `_enc` field decrypts under the **new** MK after re-key |
| R9 | Every block's content_hash is **unchanged** before/after re-key (plaintext preserved) |
| R10 | Every block re-seals and verifies under the **new** MK (ADR-029/029a whitelist) |
| R11 | Full chain re-entries: `verify()` passes end-to-end under the new key set |

### Group B: backup & safety — ~5 tests
| ID | Assertion |
|----|-----------|
| B1 | Backup snapshot captures the pre-rekey chain under the **old** MK and is restorable |
| B2 | Re-key is **aborted with no partial write** if any block fails to re-encrypt/re-seal |
| B3 | Re-key refuses to proceed if the migration marker already reflects a re-key (no double-run) |
| B4 | Re-key records `seed_fingerprint` (HMAC of new seed) for drift detection |
| B5 | Re-key surfaces the new seed only via a **two-step reveal** after written confirmation |

### Group M: migration / key exchange — ~6 tests
| ID | Assertion |
|----|-----------|
| M1 | Re-key updates `key_version` (new version) on genesis and every block (if versioned scheme) |
| M2 | Re-key recomputes identity MACs on genesis under the new MK |
| M3 | Re-key rewrites all `prev_hash` links in a cascading rewrite, consistent with the new seals |
| M4 | Old sealed block hashes are replaced atomically; no orphaned remote files |
| M5 | Re-key leaves the **Commonplace chain** in lockstep (re-keyed + verifying under new MK) |
| M6 | Re-key preserves append-only order / date-grouping (no logical re-ordering) |

### Group P: push & device coordinates — ~6 tests
| ID | Assertion |
|----|-----------|
| P1 | Re-key pushes the rewritten chain to R2 (`blocks/*.json` + `hash_index.json` + `index.json`) |
| P2 | Re-key pushes the reconstructed **genesis with new `recovery_seed_enc`** |
| P3 | Re-key rotates the device cookie specifier → next sync returns `reauthNeeded` (ownership handoff) |
| P4 | After re-key, a **second/other device** re-pulls and verifies under the new MK |
| P5 | Repeat re-key is idempotent-guarded (ablated by B3) |
| P6 | Remote staging/ownership metadata is cleared/rotated so no stale-MK session lingers |

### Group S: settings UI — ~6 tests
| ID | Assertion |
|----|-----------|
| S1 | Settings **Security & Recovery** shows both "Change Passphrase" and "Re-key to new Recovery Seed" |
| S2 | Tapping re-key opens a **two-secret confirmation** (current passphrase/seed + explicit acknowledge) |
| S3 | Re-key requires a **newly generated seed saved by user** before it proceeds (reveal-gate) |
| S4 | Cancel / back at any stage aborts with **no chain mutation** |
| S5 | Network failure during R2 push surfaces a clear error and leaves the **local** chain consistent |
| S6 | On success, the new-seed reveal dialog appears once and is never auto-re-shown |

## 5. Cross-Cutting Requirements

- **Remote/blob:** full-chain overwrite under new MK is idempotent; existing `LedgerPushService` handles block replace. Must validate remote genesis before claiming success.
- **Device coordination (ADR-030):** after cookie rotation, other devices trigger ownership-handoff → ledger-auto-pull → verify under new MK (requires the handoff reconcile path; see `LEDGER_AUTO_PULL_ON_REAUTH_PLAN.md`). A device holding the **old** seed can no longer decrypt — expected and required for leak nullification.
- **Commonplace parity (D8):** the Commonplace chain shares seed→MK; must re-key in the same transaction (non-atomic across the two files is acceptable if ordered: main first, then commonplace, with a recoverable marker).
- **Security docs:** must be consistent with `docs/spec/PHPSPEC.md` `key_version` and ADR-029/029a seal whitelist; PHPSPEC may need a note that re-key mints a new seed (spec change → `CANONICAL_SEALFIELD_PHPSPEC` style pass).

## 6. Dependencies & Assumptions

- **Verbose on CLI (`ph rotate-keys` currently unreachable):** C-2 Flutter can proceed independent of wiring the CLI, but the CLI hard-rotate loop is the reference implementation; recommend wiring `main.py` `rotate-keys` (soft + `--full`) as a Phase-1 precedent to validate the re-key loop before porting to Flutter.
- **Pre-existing 43-fail red suite:** C-2 work sits in Settings/service layers; to avoid compounding, the red-suite remediation (Group 1, then Groups 2–7) should be green **before** Phase 2 of C-2, so baseline diffs are clean.
- **⚠️ C-2 does NOT fix the "Integrity check failed" (emulator Verify Ledger INVALID) — it depends on it being fixed first.**
  The integrity failure is a **format/algorithm-drift** defect (legacy chain never re-sealed to 0.4.0: **0/126 blocks persist a block seal key**, **0/267 content_hashes verify** because they were computed with the pre-0.4.0 algorithm). That is a *data-format* problem, distinct from the leaked-seed problem C-2 solves.
  C-2's re-key loop **presumes** a currently-valid 0.4.0+ chain: it snapshot-decrypts every entry and re-seals every block, so on the legacy INVALID emulator chain it would hit the same missing-seal/`content_hash`-mismatch preconditions and abort. **Ordering:** (1) resolve the **migrate-vs-regenerate** decision and get the chain to a valid, canonical 0.4.0 state via `LEDGER_VALIDITY_WORKFLOW_PHASE1.md`; only then (2) run C-2 to re-key under a new seed. After C-2, R9–R11 re-verify the re-keyed chain under the new MK, but that is a post-condition, not the fix for the pre-existing INVALID state.

## 7. Phase Plan (TDD)

1. **Phase 4 (this doc):** blueprint + design decision on versioned-MK adoption (recommended yes).
2. **Phase 2 (RED):** tests R1–R11, B1–B5, M1–M6, P1–P6, S1–S6 in `phpoc-flutter/test/services/rekey_service_test.dart` + `settings_screen_test.dart`.
3. **Phase 3 (GREEN):** `RekeyService` + `crypto_service` versioned MK + chain re-key loop + Settings UI.
4. **Phase 4 (REFACTOR):** DRY the chain re-key against Python `hard_rotate`; clarify names; analyzer 0.
5. **(optional, out of Flutter scope)** wire `ph rotate-keys` into the CLI and add `--renew-seed` parity.

## 8. Acceptance

- `flutter analyze` **0 errors**; full Flutter suite **0 failures** after the pre-existing red suite is green.
- New tests: **R (11) + B (5) + M (6) + P (6) + S (6) = 34** all GREEN.
- On a scratch copy of the personal ledger (in `/tmp`, `--output`, never the live `~/.local/share/phpoc/`): the old seed's MK **cannot** decrypt after re-key; the new seed's MK verifies and decrypts the entire vault + chain + remote export.
- DOX pass: update `docs/planning/AGENTS.md` child index, `ROADMAP.md` status, `BACKLOG.md` (unblock), and `SESSION_HANDOFF.md` on completion.
