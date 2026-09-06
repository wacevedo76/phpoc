# Flutter ADR-026 Key Rotation + Commonplace Extension — Test Exploration (Phase 1)

> **Plan:** this file — the **shared key-rotation extension** slice (Commonplace roadmap Slice 6)
> **ADR:** ADR-026 (versioned MKs), ADR-031 (Commonplace shared MK), ADR-032 (C-2 seed replacement — orthogonal)
> **Reference (Python):** `security/crypto.py::derive_mk` + `phpoc_cli/rotate_keys.py` (`RotateKeysCommand.soft_rotate`/`hard_rotate`), `docs/planning/I01_KEY_ROTATION_PHASE1.md`, `docs/planning/I01A_ROTATEKEYS_EXECUTION_PHASE1.md`
> **Reference (Web):** `phpoc-web/src/crypto/index.js::deriveMk` + `CryptoManager` `keyVersion` (`phpoc-web/test/i01_key_rotation_web_test.mjs`)
> **Purpose:** Blueprint of all test assertions needed to (1) implement **ADR-026 versioned-MK rotation in Flutter** (the missing prerequisite) and (2) extend it to **re-encrypt the Commonplace chain in lockstep** — the Flutter half of Commonplace Slice 6.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Scope & Decision

`COMMONPLACE_BOOK_WEB_ROADMAP.md` Slice 6 declares its dependency as the **"Flutter ADR-026 Commonplace extension"**, marked "⏸️ Pending". Investigation shows the Flutter prerequisite is *larger* than the extension alone: Flutter has **no ADR-026 rotation at all** — only the C-2 raw-seed replacement (`RekeyService.rekey()`, ADR-032, which already re-encrypts `commonplace.json` under the *same* raw-seed MK with **no `key_version` bump**).

Therefore this slice is scoped in two coupled halves:

1. **Flutter ADR-026 key rotation** — add versioned-MK derivation + `soft_rotate`/`hard_rotate` orchestration (mirroring Python `RotateKeysCommand`). This is the genuinely-missing piece.
2. **Commonplace lockstep** — extend that rotation to re-encrypt `commonplace.json` in the same operation (generalizing the existing `RekeyService._buildRebuiltCommonplace` from raw-seed re-key to versioned rotation).

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

- **Soft rotate** (default): bump genesis `key_version`, re-encrypt MK-encrypted mutable state (`identity_secret_enc_fallback`, staging, blind index), rotate the device cookie, re-seal + re-MAC genesis. **Day/summary blocks are untouched** (stay under their original `key_version`).
- **Hard rotate** (`--full`): all soft steps **plus** a full chain rewrite — re-encrypt every entry under MK_v(N+1), bump every block's `key_version`, re-seal, re-MAC, re-link `prev_hash`, backup first.
- **Commonplace lockstep** (this slice): the same rotation also re-encrypts `commonplace.json` (its genesis + day blocks) so both books stay decryptable under one seed.

Two capabilities Flutter **currently lacks** and must gain (asserted in this blueprint):

1. `CryptoService.deriveMk(seed, version)` — versioned MK derivation (today `deriveMasterKey(seed)` returns the raw seed with **no version**).
2. Per-version MK selection in `LedgerChain.verify()` / `CommonplaceChain.verify()` — today `verify()` reads `key_version` only as an invariant (`blockKv > genesisKv → false`); it never derives a per-block MK. Multi-version chains cannot verify without this.

## Divergences & Design Notes (resolved before Phase 2)

- **D-ROT-1 — `key_version` base (open decision).** Python/Web treat `key_version=0` = raw seed, `v>=1` = HMAC-derived (`derive_mk`). Flutter hardcodes `key_version=1` with raw-seed-as-MK everywhere (`block.dart:21`, `chain.dart:94/127`, `commonplace_chain.dart:91/129`). `C2_CLI_CLIENT_VERIFY_PHASE1.md` already logged this as divergence R4. **Proposed resolution:** adopt the canonical `v=0`-raw / `v>=1`-HMAC convention for *new* Flutter chains and treat a legacy Flutter `key_version=1`-but-raw-seed chain as raw-seed (v=0) on first rotation (i.e. first rotation writes `key_version=1` with HMAC-derived MK_v1). Needs explicit sign-off (likely a short ADR-026 amendment note).
- **D-ROT-2 — `recovery_seed_enc` is PDK-encrypted, not MK-encrypted.** Rotation (same seed, same passphrase) leaves `recovery_seed_enc` **unchanged**; only `identity_secret_enc_fallback` (MK-encrypted) is re-encrypted. The C-2 re-key re-encrypts `recovery_seed_enc` only because it also mints a new seed/passphrase. This distinction is asserted in B3/D3.
- **D-ROT-3 — `key_version` is NOT in the ADR-029a seal whitelist.** Bumping `key_version` is seal-neutral; the block hash changes **only** because the seal sub-key (`HMAC(MK_vN, "integrity-key-salt")`) changes. Asserted in E10.
- **D-ROT-4 — `format_version`.** Python ADR-026 assumes `key_version` support requires `format_version ≥ 0.5.0`; Flutter already writes `key_version` at `0.4.0`. Do **not** force a format bump in Flutter (D9) — leave `format_version` unchanged unless a later cross-client decision requires it.
- **D-ROT-5 — API placement.** New `KeyRotationService` (`lib/services/key_rotation_service.dart`) mirrors Python `RotateKeysCommand`; the C-2 `RekeyService` stays as-is. Phase 4 will DRY the shared per-`_enc` re-encrypt + seal helpers between the two.

## Test Groups

### Group A: versioned-MK derivation (`deriveMk`) — ~9 tests

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

### Group B: soft rotation orchestration (activity ledger) — ~14 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `softRotate()` bumps genesis `key_version` N → N+1 on disk | Version increment persisted | The defining property of rotation (D4) |
| B2 | re-encrypts `identity_secret_enc_fallback` under MK_v(N+1) — old MK can't decrypt, new MK decrypts to the same plaintext | Identity envelope rotation | Identity secret is MK-encrypted and must move to the new key |
| B3 | leaves `recovery_seed_enc` **unchanged** | PDK-vs-MK distinction | The seed envelope is passphrase-encrypted, not MK-encrypted (D-ROT-2) |
| B4 | re-encrypts staging entries under the new MK (old can't, new can) | Staging re-encryption | All mutable MK-encrypted state moves to MK_v(N+1) |
| B5 | re-encrypts the blind index under the new index key | Index re-encryption | Index is a derived cache encrypted with a versioned sub-key |
| B6 | rotates the device cookie (fresh specifier) | Cookie rotation | Post-rotation device identity must be regenerated |
| B7 | re-seals genesis under MK_v(N+1) — old seal fails verify, new passes | Genesis re-seal | block_hash must reflect the new seal sub-key |
| B8 | recomputes genesis `identity_seal` over the new block_hash | Identity MAC update | The MAC binds the block hash, which changed |
| B9 | leaves day/summary blocks untouched (same `key_version`, ciphertext, seals) | Block preservation | D5 — soft rotation is non-destructive |
| B10 | `LedgerChain.verify()` passes on the mixed-version chain (old vN blocks + new v(N+1) genesis) | Post-rotation integrity | Requires per-version MK selection (new capability) |
| B11 | session MK cache is populated with MK_v(N+1) after rotation | Session update | Subsequent encrypt/seal uses the new key |
| B12 | passphrase re-entry gate — wrong passphrase → no mutation | Auth gate | Rotation re-verifies ownership before any write |
| B13 | pre-rotation integrity check — corrupt chain → abort with no partial write | Pre-flight safety | Never rotate a corrupted chain (D10) |
| B14 | empty staging + no transport → completes locally (offline) | Offline rotation | D6 — rotation must not require network |

### Group C: hard rotation orchestration (activity ledger) — ~14 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `hardRotate()` includes all soft steps (genesis/staging/index/cookie) | Soft subsumption | Hard rotation = soft + full rewrite |
| C2 | re-encrypts every day-block entry `_enc` field under MK_v(N+1) | Full entry re-encryption | All ciphertext moves to the new key |
| C3 | updates `key_version` on **every** block (genesis + day + summaries) to N+1 | Uniform version | After hard rotation the chain is single-version (D1) |
| C4 | recomputes every ciphertext-bound entry `hash` | Entry hash update | Ciphertext changed → entry hash changed |
| C5 | recomputes every block seal under the new seal key | Block seal update | All block hashes move to MK_v(N+1) |
| C6 | recomputes every `identity_seal` | Identity MAC update | Block content changed → MAC recomputed |
| C7 | re-links every `prev_hash` to the predecessor's **new** seal | Chain re-link | Seal change cascades; linkage must follow |
| C8 | `content_hash` is **unchanged** after hard rotation | Content-hash invariance | content_hash is over plaintext (ADR-005), survives re-encryption |
| C9 | creates a timestamped backup of the pre-rotation chain before writing | Backup | D5 — destructive rewrite requires a backup |
| C10 | backup independently verifies with the **old** MKs | Backup integrity | Backup must be a complete recoverable chain |
| C11 | backup includes staging + index + cookie (not just the ledger) | Complete backup | Recovery needs all mutable state |
| C12 | old MK_v(N) cannot decrypt any active-chain entry after hard rotation | Old-MK invalidation | Security property of full rotation |
| C13 | `LedgerChain.verify()` passes on the rewritten chain | Post-rotation integrity | Single-version chain verifies |
| C14 | genesis-only chain (no day blocks) completes hard rotation | Empty-chain edge | Rotating an empty ledger succeeds (only mutable state) |

### Group D: Commonplace lockstep rotation — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | soft rotation also bumps the Commonplace genesis `key_version` N → N+1 | Version parity | Both chains share one rotation event |
| D2 | soft rotation re-encrypts Commonplace genesis `identity_secret_enc_fallback` (if present) under MK_v(N+1) | Identity envelope parity | Mirrors B2 for the second chain |
| D3 | leaves Commonplace `recovery_seed_enc` **unchanged** (PDK-encrypted) | PDK-vs-MK distinction | Mirrors B3 (D-ROT-2) |
| D4 | soft rotation leaves Commonplace day blocks untouched | Block preservation | D5 — soft is non-destructive on both books |
| D5 | hard rotation re-encrypts every Commonplace entry `_enc` field under MK_v(N+1) | Full entry re-encryption | Mirrors C2 for `commonplace` blocks |
| D6 | hard rotation updates `key_version` on every Commonplace block to N+1 | Uniform version | Mirrors C3 |
| D7 | hard rotation recomputes Commonplace `content_hash` (invariant) + entry `hash` + seals | Hash/seal recompute | Mirrors C4/C5/C8 |
| D8 | hard rotation re-links Commonplace `prev_hash` to the new predecessor seal | Chain re-link | Mirrors C7 |
| D9 | after rotation, `CommonplaceChain.verify()` passes (per-version MK selection) | Post-rotation integrity | Requires the same new verify capability as B10 |
| D10 | a Commonplace build/store failure aborts **before** any ledger write (both chains unmodified) | Atomicity | Mirrors CPS-R6 — no partial cross-chain rotation |
| D11 | rotation result surfaces Commonplace block/entry re-encrypt counts | User feedback | Mirrors `RekeyResult.commonplaceBlocksReencrypted` |
| D12 | one rotation re-encrypts **both** books with **no** separate Commonplace passphrase | Shared rotation | ADR-031 §7 — one seed, one rotation, both books |

### Group E: cross-client parity, recovery, edges — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `deriveMk` output is byte-identical to Python `derive_mk` and Web `deriveMk` on a canonical vector seed | 3-way parity | Cross-client chains must share MK derivation |
| E2 | after soft rotation, recovery from seed re-derives all MKs (v1..N+1) and verifies | Recovery after soft | D8 — seed recovers mixed-version chains |
| E3 | after hard rotation, recovery from seed re-derives all MKs and verifies | Recovery after hard | D8 |
| E4 | a legacy Flutter chain (`key_version=1`, raw seed) rotates correctly on its **first** rotation | Backward compat | D9 + D-ROT-1 resolution |
| E5 | two consecutive soft rotations (v→v+1→v+2) yield a verifiable 3-version chain | Multi-rotation | Realistic yearly-rotation accumulation |
| E6 | double soft rotation with the same target version no-ops / returns false | Idempotency | Prevents accidental double-rotation |
| E7 | hard rotation with an undecryptable entry → abort, chain untouched | Corruption safety | No half-rewritten chain on disk |
| E8 | rotation with no cached MK (locked session) throws / returns false | Auth gate | Cannot rotate without a real master key |
| E9 | `key_version` is **not** part of the ADR-029a seal whitelist (bump is seal-neutral) | Seal-whitelist contract | The seal changes only via MK→seal-key (D-ROT-3) |
| E10 | post-rotation, the Web/Python clients can still verify a Flutter-rotated chain (hermetic fixture, no live R2) | Cross-client convergence | The rotation must produce a canonical format |

## Summary

| Group | Area | Tests | Key coverage |
|-------|------|-------|--------------|
| A | versioned-MK derivation (`deriveMk`) | 9 | v0/v1/v2 derivation, determinism, validation, domain separation, sub-key rotation |
| B | soft rotation (ledger) | 14 | genesis bump, identity fallback, staging/index/cookie, re-seal/MAC, block preservation, mixed-version verify, auth/offline/empty edges |
| C | hard rotation (ledger) | 14 | full re-encrypt, uniform version, hash/seal/MAC/prev_hash recompute, content_hash invariance, backup, old-MK invalidation, empty chain |
| D | Commonplace lockstep | 12 | both-chain version bump, lockstep re-encrypt, atomicity, shared rotation (no second passphrase) |
| E | parity + recovery + edges | 10 | 3-way `deriveMk` parity, recovery, backward compat, idempotency, seal-whitelist contract, cross-client verify |
| **Total** | | **59** | |

### Design Directives Checklist

- **D2 (Zero-Knowledge):** old data decryptable after rotation — seed re-derives all MKs (E2/E3)
- **D4 (Chain of Trust):** seals + MACs verify across versions (B10, C13, D9, E9)
- **D5 (Append-Only):** soft preserves blocks (B9/D4); hard backs up first (C9–C11)
- **D6 (Local-First):** rotation works offline (B14)
- **D8 (Recoverability):** seed recovers everything after soft/hard rotation (E2/E3)
- **D9 (Backward Compat):** legacy Flutter chains rotate (E4); `format_version` untouched (D-ROT-4)
- **D10 (Testing Integrity):** chain integrity asserted after every rotation (B10/B13/C13/D9/E7)

### Files in Scope

| File | Change | Tests |
|------|--------|-------|
| `phpoc-flutter/lib/core/crypto/crypto_service.dart` (+ native variant) | Add `deriveMk(seed, version)` (pure-Dart HMAC; no FFI needed) | A1–A9, E1 |
| `phpoc-flutter/lib/services/key_rotation_service.dart` | **New:** `softRotate()` / `hardRotate()` / `rotate()` + `RotationResult` | B, C |
| `phpoc-flutter/lib/data/ledger/chain.dart` | Per-version MK selection in `verify()` (+ `buildDayBlock` `keyVersion` passthrough) | B10, C13, E9 |
| `phpoc-flutter/lib/data/commonplace/commonplace_chain.dart` | Per-version MK selection in `verify()` | D9 |
| `phpoc-flutter/lib/services/key_rotation_service.dart` (Commonplace) | `_rotateCommonplace` lockstep (generalize `RekeyService._buildRebuiltCommonplace`) | D |
| `phpoc-flutter/test/services/key_rotation_service_test.dart` | **New:** A–E test groups | 59 |
