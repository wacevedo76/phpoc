# Flutter ADR-026 Key Rotation + Commonplace Extension — Test Exploration (Phase 1)

> **Plan:** this file — the **shared key-rotation extension** slice (Commonplace roadmap Slice 6)
> **ADR:** ADR-026 (versioned MKs), **ADR-026a (`key_version` out-of-band, hard-only rotation — resolves D-ROT-1)**, ADR-031 (Commonplace shared MK), ADR-032 (C-2 seed replacement — orthogonal)
> **Reference (Python):** `security/crypto.py::derive_mk` + `phpoc_cli/rotate_keys.py` (`RotateKeysCommand.hard_rotate`; `soft_rotate` superseded by ADR-026a), `docs/planning/I01_KEY_ROTATION_PHASE1.md`, `docs/planning/I01A_ROTATEKEYS_EXECUTION_PHASE1.md`
> **Reference (Web):** `phpoc-web/src/crypto/index.js::deriveMk` + `CryptoManager` `keyVersion` (`phpoc-web/test/i01_key_rotation_web_test.mjs`)
> **Purpose:** Blueprint of all test assertions needed to (1) implement **ADR-026 versioned-MK rotation in Flutter** (the missing prerequisite) and (2) extend it to **re-encrypt the Commonplace chain in lockstep** — the Flutter half of Commonplace Slice 6.
> **Status:** 🔜 Phase 1 (test exploration — **re-scoped to hard-only per ADR-026a, 2026-09-07**)
> **Next Phase:** Phase 2 (RED: test definition)

## Scope & Decision

`COMMONPLACE_BOOK_WEB_ROADMAP.md` Slice 6 declares its dependency as the **"Flutter ADR-026 Commonplace extension"**, marked "⏸️ Pending". Investigation shows the Flutter prerequisite is *larger* than the extension alone: Flutter has **no ADR-026 rotation at all** — only the C-2 raw-seed replacement (`RekeyService.rekey()`, ADR-032, which already re-encrypts `commonplace.json` under the *same* raw-seed MK with **no `key_version` bump**).

Therefore this slice is scoped in two coupled halves:

1. **Flutter ADR-026 key rotation** — add versioned-MK derivation + **hard-only** rotation orchestration (mirroring Python `RotateKeysCommand.hard_rotate`). This is the genuinely-missing piece.
2. **Commonplace lockstep** — extend that rotation to re-encrypt `commonplace.json` in the same operation (generalizing the existing `RekeyService._buildRebuiltCommonplace` from raw-seed re-key to versioned rotation).

> **Re-scoped to hard-only (2026-09-07, ADR-026a).** The original 59-assertion blueprint assumed soft + hard
> rotation, per-block `key_version`, and per-version MK selection in `verify()`. ADR-026a supersedes that:
> `key_version` is **out-of-band derivation metadata** (not a ledger field), rotation is **hard-only**, and
> `verify()` takes a **single** MK. This file now reflects that: **Group B (soft rotation) is removed**, its
> still-relevant steps (mutable-state re-encryption, auth gate, integrity check, offline, cookie rotation)
> folded into Group C; all `key_version`-write and per-version-verify assertions are dropped.

> **Note:** `ROADMAP.md` currently marks this slice "Flutter done ✅ via Settings slice 2026-08-24". That conflates the C-2 re-key (done) with ADR-026 rotation (not done). This blueprint corrects that; `ROADMAP.md`/`BACKLOG.md` should be reconciled.

## Architecture Overview

```
Seed (32 raw bytes) ── derive_mk(seed, version) ──> MK_vN (versioned)
   version=0 → raw seed (backward compat)              │
   version>=1 → HMAC-SHA256(seed, "phpoc:mk:v{N}")     ▼
                                        sub-keys: seal_key / blob_key / index_key /
                                                  field_key / cookie_key  (all HMAC(MK_vN, salt))
```

Rotation moves the ledger from MK_vN to MK_v(N+1) **without changing the seed or the passphrase**:

- **Hard rotate** (the only rotation mode — soft rotation was dropped by ADR-026a): re-encrypt every entry under MK_v(N+1), re-seal, re-MAC, re-link `prev_hash`, backup first. `key_version` is **never** written to blocks — it is out-of-band metadata.
- **Commonplace lockstep** (this slice): the same rotation also re-encrypts `commonplace.json` (its genesis + day blocks) so both books stay decryptable under one seed.

One capability Flutter **currently lacks** and must gain (asserted in this blueprint):

1. `CryptoService.deriveMk(seed, version)` — versioned MK derivation (today `deriveMasterKey(seed)` returns the raw seed with **no version**).

> **Note (ADR-026a):** the originally-planned second capability — per-version MK selection in
> `LedgerChain.verify()` / `CommonplaceChain.verify()` — is **dropped**. `verify()` takes a single
> MK; blocks carry no `key_version`, so the existing `blockKv > genesisKv` invariant is removed.

## Divergences & Design Notes (resolved before Phase 2)

- **D-ROT-1 — `key_version` base. ✅ RESOLVED by ADR-026a (2026-09-07).** `key_version` is **out-of-band derivation metadata, not a ledger field**: v=0 = raw seed, v≥1 = HMAC-derived (`derive_mk`). Rotation is **hard-only**; soft rotation is dropped. A legacy Flutter `key_version=1`-but-raw-seed chain is treated as v=0 (raw seed). Blocks never store `key_version`, so there is no per-block relabel. See `docs/design/ARCHITECTURAL_DECISIONS.md` ADR-026a.
- **D-ROT-2 — `recovery_seed_enc` is PDK-encrypted, not MK-encrypted.** Rotation (same seed, same passphrase) leaves `recovery_seed_enc` **unchanged**; only `identity_secret_enc_fallback` (MK-encrypted) is re-encrypted. The C-2 re-key re-encrypts `recovery_seed_enc` only because it also mints a new seed/passphrase. This distinction is asserted in C6/D2.
- **D-ROT-3 — `key_version` is not a ledger field (ADR-026a).** Since `key_version` is never written to blocks, there is no seal-whitelist interaction and no "seal-neutral bump" to reason about. The block hash changes **only** because the seal sub-key (`HMAC(MK_vN, "integrity-key-salt")`) changes. Asserted in E5.
- **D-ROT-4 — `format_version`.** Flutter currently writes `key_version` at format `0.4.0`. Under ADR-026a Flutter **stops writing `key_version`** entirely (no per-block field), with **no** format bump required (D9) — leave `format_version` unchanged unless a later cross-client decision requires it.
- **D-ROT-5 — API placement.** New `KeyRotationService` (`lib/services/key_rotation_service.dart`) mirrors Python `RotateKeysCommand.hard_rotate`; the C-2 `RekeyService` stays as-is. Phase 4 will DRY the shared per-`_enc` re-encrypt + seal helpers between the two.

## Test Groups

### Group A: versioned-MK derivation (`deriveMk`) — 9 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `CryptoService.deriveMk(seed, 0)` returns the raw 32-byte seed (hex) | Backward-compat root | v=0 is the pre-ADR raw-seed convention Python/Web already implement |
| A2 | `deriveMk(seed, 1)` == `HMAC-SHA256(seed, "phpoc:mk:v1")` hex | Canonical v1 derivation | Byte-identical to Python `derive_mk` and Web `deriveMk` |
| A3 | `deriveMk(seed, 2)` == `HMAC-SHA256(seed, "phpoc:mk:v2")`, distinct from v1 and v0 | Version separation | Each version must yield a different MK |
| A4 | `deriveMk` is deterministic (same seed+version → same output) | Pure function | Rotation + recovery must re-derive identical keys |
| A5 | distinct seeds → distinct MKs (no accidental collision) | Key uniqueness | A seed uniquely determines its versioned MKs |
| A6 | `deriveMk` throws on a non-32-byte seed | Input validation | Mirrors Python `ValueError` |
| A7 | `deriveMk` throws on a non-int version | Input validation | Mirrors Python `TypeError` |
| A8 | `deriveMk(seed, 1)` is not derivable from `deriveMk(seed, 2)` without the seed (domain separation) | Non-invertibility | HMAC is a PRF — an attacker with MK_v2 cannot compute MK_v1/v3 |
| A9 | versioned MK feeds sub-key derivation — `deriveSealKey(MK_v1) != deriveSealKey(MK_v2)` | Sub-key rotation | Seal/blob/index/field/cookie keys must change with the MK version or rotation is meaningless |

### Group B — soft rotation (activity ledger) — REMOVED (ADR-026a)

Soft rotation (bump genesis `key_version`, leave day/summary blocks under their old version, per-version
`verify()`) is **dropped** — ADR-026a makes rotation hard-only and removes per-block `key_version`. Its
still-relevant steps are folded into **Group C**: mutable-state re-encryption (identity fallback, staging,
blind index, cookie, genesis re-seal) is now an explicit part of the single hard-rotation operation, alongside
the full entry re-encryption.

### Group C: hard rotation orchestration (activity ledger) — 24 tests

Phases: **gates → mutable-state re-encryption → full chain re-encryption → backup → edges**.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `rotate()` re-verifies ownership — wrong passphrase → no mutation | Auth gate | Rotation re-verifies ownership before any write (D2) |
| C2 | pre-rotation integrity check — corrupt chain → abort with no partial write | Pre-flight safety | Never rotate a corrupted chain (D10) |
| C3 | rotation with no cached MK (locked session) throws / returns false | Auth gate | Cannot rotate without a real master key |
| C4 | empty staging + no transport → completes locally (offline) | Offline rotation | D6 — rotation must not require network |
| C5 | re-encrypts `identity_secret_enc_fallback` under MK_v(N+1) — old MK can't decrypt, new MK decrypts to the same plaintext | Identity envelope rotation | Identity secret is MK-encrypted and must move to the new key |
| C6 | leaves `recovery_seed_enc` **unchanged** | PDK-vs-MK distinction | Seed envelope is passphrase-encrypted, not MK-encrypted (D-ROT-2) |
| C7 | re-encrypts staging entries under the new MK (old can't, new can) | Staging re-encryption | All mutable MK-encrypted state moves to MK_v(N+1) |
| C8 | re-encrypts the blind index under the new index key | Index re-encryption | Index is a derived cache encrypted with a versioned sub-key |
| C9 | rotates the device cookie (fresh specifier) | Cookie rotation | Post-rotation device identity must be regenerated |
| C10 | re-seals genesis under MK_v(N+1) — old seal fails verify, new passes | Genesis re-seal | block_hash must reflect the new seal sub-key |
| C11 | recomputes genesis `identity_seal` over the new block_hash | Identity MAC update | The MAC binds the block hash, which changed |
| C12 | updates the in-memory MK to MK_v(N+1) after rotation | Session update | Subsequent encrypt/seal uses the new key |
| C13 | re-encrypts every day-block entry `_enc` field under MK_v(N+1) | Full entry re-encryption | All ciphertext moves to the new key |
| C14 | recomputes every ciphertext-bound entry `hash` | Entry hash update | Ciphertext changed → entry hash changed |
| C15 | recomputes every block seal under the new seal key | Block seal update | All block hashes move to MK_v(N+1) |
| C16 | recomputes every `identity_seal` | Identity MAC update | Block content changed → MAC recomputed |
| C17 | re-links every `prev_hash` to the predecessor's **new** seal | Chain re-link | Seal change cascades; linkage must follow |
| C18 | `content_hash` is **unchanged** after hard rotation | Content-hash invariance | content_hash is over plaintext (ADR-005), survives re-encryption |
| C19 | old MK_v(N) cannot decrypt any active-chain entry after hard rotation | Old-MK invalidation | Security property of full rotation |
| C20 | `LedgerChain.verify()` passes on the rewritten chain (single MK) | Post-rotation integrity | Single-MK chain verifies (ADR-026a) |
| C21 | creates a timestamped backup of the pre-rotation chain before writing | Backup | D5 — destructive rewrite requires a backup |
| C22 | backup independently verifies with the **old** MK | Backup integrity | Backup must be a complete recoverable chain |
| C23 | backup includes staging + index + cookie (not just the ledger) | Complete backup | Recovery needs all mutable state |
| C24 | genesis-only chain (no day blocks) completes hard rotation | Empty-chain edge | Rotating an empty ledger succeeds (only mutable state) |

### Group D: Commonplace lockstep rotation — 9 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | hard rotation re-encrypts Commonplace genesis `identity_secret_enc_fallback` (if present) under MK_v(N+1) | Identity envelope parity | Mirrors C5 for the second chain |
| D2 | leaves Commonplace `recovery_seed_enc` **unchanged** (PDK-encrypted) | PDK-vs-MK distinction | Mirrors C6 (D-ROT-2) |
| D3 | hard rotation re-encrypts every Commonplace entry `_enc` field under MK_v(N+1) | Full entry re-encryption | Mirrors C13 for `commonplace` blocks |
| D4 | hard rotation recomputes Commonplace `content_hash` (invariant) + entry `hash` + seals | Hash/seal recompute | Mirrors C14/C15/C18 |
| D5 | hard rotation re-links Commonplace `prev_hash` to the new predecessor seal | Chain re-link | Mirrors C17 |
| D6 | after rotation, `CommonplaceChain.verify()` passes (single MK) | Post-rotation integrity | Single-MK verify (ADR-026a) |
| D7 | a Commonplace build/store failure aborts **before** any ledger write (both chains unmodified) | Atomicity | Mirrors CPS-R6 — no partial cross-chain rotation |
| D8 | rotation result surfaces Commonplace block/entry re-encrypt counts | User feedback | Mirrors `RekeyResult.commonplaceBlocksReencrypted` |
| D9 | one rotation re-encrypts **both** books with **no** separate Commonplace passphrase | Shared rotation | ADR-031 §7 — one seed, one rotation, both books |

### Group E: cross-client parity, recovery, edges — 6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `deriveMk` output is byte-identical to Python `derive_mk` and Web `deriveMk` on a canonical vector seed | 3-way parity | Cross-client chains must share MK derivation |
| E2 | after hard rotation, recovery from seed re-derives the new MK and verifies | Recovery after hard | D8 — seed recovers the rotated chain |
| E3 | a legacy Flutter chain (`key_version=1`, raw seed) verifies as v=0 and rotates correctly | Backward compat | D9 + D-ROT-1 resolution |
| E4 | hard rotation with an undecryptable entry → abort, chain untouched | Corruption safety | No half-rewritten chain on disk |
| E5 | after rotation, **no** block (genesis/day/summary) carries a `key_version` field | Out-of-band contract | `key_version` is not a ledger field (ADR-026a); no seal-whitelist interaction |
| E6 | post-rotation, the Web/Python clients can still verify a Flutter-rotated chain (hermetic fixture, no live R2) | Cross-client convergence | The rotation must produce a canonical format |

## Summary

| Group | Area | Tests | Key coverage |
|-------|------|-------|--------------|
| A | versioned-MK derivation (`deriveMk`) | 9 | v0/v1/v2 derivation, determinism, validation, domain separation, sub-key rotation |
| B | ~~soft rotation (ledger)~~ | — | **REMOVED (ADR-026a)** — still-relevant steps folded into Group C |
| C | hard rotation (ledger) | 24 | gates (passphrase/integrity/MK/offline), mutable-state re-encrypt, full entry re-encrypt, backup, edges |
| D | Commonplace lockstep | 9 | lockstep re-encrypt, single-MK verify, atomicity, shared rotation (no second passphrase) |
| E | parity + recovery + edges | 6 | 3-way `deriveMk` parity, hard-recovery, legacy v1→v0, corruption safety, out-of-band contract, cross-client verify |
| **Total** | | **48** | |

### Design Directives Checklist

- **D2 (Zero-Knowledge):** old data decryptable after rotation — seed re-derives the MKs (E2)
- **D4 (Chain of Trust):** seals + MACs verify across the rotation (C20, D6)
- **D5 (Append-Only):** hard rotation backs up first (C21–C23)
- **D6 (Local-First):** rotation works offline (C4)
- **D8 (Recoverability):** seed recovers everything after hard rotation (E2)
- **D9 (Backward Compat):** legacy Flutter `key_version=1`-raw chains read as v=0 (E3); `format_version` untouched (D-ROT-4)
- **D10 (Testing Integrity):** chain integrity asserted before and after rotation (C2/C20/D6/E4)

### Files in Scope

| File | Change | Tests |
|------|--------|-------|
| `phpoc-flutter/lib/core/crypto/crypto_service.dart` (+ native variant) | Add `deriveMk(seed, version)` (pure-Dart HMAC; no FFI needed) | A1–A9, E1 |
| `phpoc-flutter/lib/services/key_rotation_service.dart` | **New:** `hardRotate()` / `rotate()` + `RotationResult` | C |
| `phpoc-flutter/lib/data/ledger/chain.dart` | Remove `key_version` writes + the `blockKv > genesisKv` invariant (single-MK verify, ADR-026a) | C20, E5 |
| `phpoc-flutter/lib/data/commonplace/commonplace_chain.dart` | Remove the `key_version` invariant (single-MK verify) | D6, E5 |
| `phpoc-flutter/lib/services/key_rotation_service.dart` (Commonplace) | `_rotateCommonplace` lockstep (generalize `RekeyService._buildRebuiltCommonplace`) | D |
| `phpoc-flutter/test/services/key_rotation_service_test.dart` | **New:** A/C/D/E test groups | 48 |
