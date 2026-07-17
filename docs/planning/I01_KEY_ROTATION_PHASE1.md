# I-01: Key Rotation — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §Phase 4 — I-01
> **ADR:** ADR-026 (Versioned Master Keys, dual soft/hard rotation modes)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration)
> **Next Phase:** ✅ Phase 2 (RED: test definition)

## Architecture Overview

I-01 closes the single largest architectural gap in the protocol: a single
Master Key (MK) protects everything forever with no rotation mechanism. ADR-026
defines a three-part design:

1. **Versioned MK derivation:** `derive_mk(seed, version)` via HMAC-SHA256,
   replacing the current `seed == MK` equivalence. `key_version=0` is the
   implicit pre-ADR value (raw seed). The first rotation moves to `key_version=1`
   with an HMAC-derived MK.

2. **Per-block key_version:** Genesis carries the active key version. Day blocks
   carry the version used to encrypt their entries. Summary blocks also carry it.
   Default behavior: missing `key_version` → use genesis value.

3. **Dual rotation modes:**
   - **Soft rotation** (default): increment genesis key_version, re-encrypt
     mutable state (identity_secret_enc_fallback, staging entries, blind index,
     device cookie), re-seal genesis. Existing blocks are NOT touched.
   - **Hard rotation** (opt-in, `--full`): full chain rewrite — re-encrypt every
     entry, update all key_version fields, recompute all seals, identity MACs,
     and prev_hash links. Backup required.

### Key Design Properties

- **Seed is the root** — all MK versions derive deterministically from it.
  Recovery from seed alone still recovers everything (D8).
- **HMAC over SHA-256** — PRF property prevents computing MK_v(N-1) from
  MK_vN (non-invertible without the seed).
- **Sub-keys change per version** — seal key, index key, field token key,
  cookie key all use the versioned MK, so old MKs can't derive new sub-keys.
- **Identity secret is version-independent** — a random 32-byte value encrypted
  with the current MK. Rotation re-encrypts this envelope, but the secret
  itself never changes. Old block identity MACs remain valid.
- **Content hashes survive re-encryption** — content_hash is computed over
  plaintext. Hard rotation only changes ciphertext; hashes are unchanged.

### Files in Scope

| File | Role | Change |
|------|------|--------|
| `security/crypto.py` | `derive_mk(seed, version)`; `CryptoManager` with versioned MK; versioned sub-key derivation | Core crypto: new `derive_mk()`, `CryptoManager.__init__` accepts optional `key_version`, all `_derive_sub_key` calls use versioned MK |
| `security/auth.py` | Multi-MK derivation on auth; session cache stores all MK versions v1..N | `authenticate()` derives all MKs; new `get_mk(version)` method; `_cache_key` stores all versions |
| `security/recovery.py` | `seed_to_key()` → wraps `derive_mk(seed, 1)` for v1 | One-line change: delegate to `derive_mk` |
| `domain/ledger/chain.py` | `key_version` on block build; per-block MK selection in `verify()`; `_hash_key_for_block` excludes `key_version` from seal | `build_day_block` accepts `key_version`; `verify()` uses `key_version` per block; `verify_block()` same |
| `domain/ledger/engine.py` | `key_version` passthrough; `rebuild_index()` with versioned index key | `commit()` passes genesis `key_version` to `build_day_block`; `rebuild_index()` uses current MK's index key |
| `domain/ledger/index_manager.py` | Versioned index encryption key | `IndexManager.__init__` accepts optional `key_version`; `_flush`/`_load` use versioned key |
| `domain/staging/service.py` | Re-encrypt staging with new MK on rotation | New `_reencrypt_staging(mk)` method; called during rotation |
| `domain/cookie/device_cookie.py` | Re-derive cookie with new MK on rotation | New `recreate(device_id, key_version, data_dir)` static method |
| `cli/rotate_keys.py` **(new)** | `ph rotate-keys` command: soft + hard modes | New file: `RotateKeysCommand` with `--full` flag |
| `phpoc-web/src/crypto/index.js` | JS `deriveMk()`, `CryptoManager` with versioned MK | Web equivalents of Python crypto changes |
| `phpoc-web/src/ledger/chain.js` | `keyVersion` in block build/verify | Web equivalents of chain changes |
| `phpoc-web/src/sync/` | Multi-MK session cache, staging re-encrypt | Web equivalents of auth + staging changes |
| `docs/spec/PHPSPEC.md` §2, §4, §5 | Document `key_version`, versioned derivation, dual rotation modes | Spec updates for the new field and workflow |
| `scripts/migrate_key_version.py` **(new)** | Add `key_version: 1` to existing genesis, derive MK_v1, re-seal | One-time migration for existing ledgers |

---

## Test Groups

### Group A: Versioned MK Derivation (crypto layer) — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `derive_mk(seed, 1)` returns deterministic 32-byte output for same inputs | Core derivation correctness | All rotation depends on deterministic, repeatable MK derivation |
| A2 | `derive_mk(seed, 1)` ≠ `derive_mk(seed, 2)` for same seed | Version separation | Different versions must produce different keys; otherwise rotation is meaningless |
| A3 | `derive_mk(seed_a, 1)` ≠ `derive_mk(seed_b, 1)` for different seeds | Seed separation | Different ledgers must have different MKs |
| A4 | `derive_mk(seed, 0)` returns the raw seed bytes (pre-ADR backward compat) | Backward compat: key_version=0 | Existing ledgers where seed == MK must continue to work (D9) |
| A5 | `derive_mk(seed, N)` for N > 0 uses HMAC-SHA256 with domain-separated message `"phpoc:mk:v{N}"` | Domain separation | Verifies the exact derivation algorithm from ADR-026 |
| A6 | `derive_mk(seed, 1)` cannot be computed from `derive_mk(seed, 2)` alone (HMAC non-invertibility) | Forward security property | Documented property: knowing MK_v2 does not reveal MK_v1 |
| A7 | `derive_mk(seed, 999)` produces valid 32 bytes (no version ceiling) | No hard version limit | Personal ledgers may see many rotations; no arbitrary cap |
| A8 | `derive_mk(seed, version)` with version as string `"1"` raises TypeError or produces consistent result | Input validation | Python int/str confusion is a common bug source |
| A9 | `derive_mk(seed, 1)` with 31-byte seed raises ValueError | Seed length validation | CryptoManager requires 32-byte key; seed must match |
| A10 | `CryptoManager(mk, key_version=2)` stores both mk and version | CryptoManager integration | Manager must carry version info for sub-key derivation |

### Group B: Sub-Key Derivation per Version (crypto layer) — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `_derive_sub_key(salt)` with versioned MK produces different output than with v0 MK | Sub-keys change with version | Core security property: old MK must not derive new sub-keys |
| B2 | `seal()` output differs between MK_v1 and MK_v2 on same data | Seal key changes with version | Block seals must be version-specific so old MKs can't forge new seals |
| B3 | `encrypt()` of same plaintext with MK_v1 vs MK_v2 produces different ciphertext | Encryption key changes with version | Entry encryption is version-specific |
| B4 | `derive_index_key(mk_v1)` ≠ `derive_index_key(mk_v2)` | Index key changes with version | Index encryption must rotate with MK |
| B5 | `derive_field_key(mk_v1)` ≠ `derive_field_key(mk_v2)` | Field token key changes with version | Field-name tokens must rotate with MK |
| B6 | `derive_index_key(mk)` uses domain separator `b"phpoc-blind-index-v1"` (salt unchanged) | Fixed salt, versioned MK | Domain separation salt is fixed; only MK changes per version |
| B7 | `derive_field_key(mk)` uses domain separator `b"phpoc-staging-keys-v1"` (salt unchanged) | Fixed salt, versioned MK | Same pattern: salt fixed, MK versioned |
| B8 | Seal key derivation uses salt `b"integrity-key-salt"` (unchanged) | Fixed seal salt | Seal key salt is a protocol constant; only MK varies |
| B9 | Cookie key derivation uses salt `b"phpoc:cookie-key"` with versioned MK | Cookie key changes with version | Device cookie must rotate with MK per ADR-026 §3 |
| B10 | `decrypt()` with MK_v1 correctly decrypts data encrypted with MK_v1 | Cross-version roundtrip | Same-version encrypt/decrypt must work |

### Group C: Block Structure with key_version (chain layer) — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Genesis block carries `key_version` field as integer | Genesis format | Genesis is the root; key_version starts here |
| C2 | `build_day_block()` includes `key_version` from caller parameter | Day block format | New blocks carry their key version for verification routing |
| C3 | Day block missing `key_version` → `verify()` defaults to genesis `key_version` | Backward compat | Existing blocks without the field must still verify (D9) |
| C4 | `_hash_key_for_block()` excludes `key_version` from seal check data | Seal correctness | Like `format_version`, `key_version` is metadata not covered by the seal |
| C5 | `key_version` serialized as integer in JSON block output | Wire format | Consistent JSON type for cross-client compatibility |
| C6 | Summary blocks (year_summary, month_summary) also carry `key_version` | Summary block format | All blocks must carry key version for mixed-version verification |
| C7 | `build_day_block()` with `key_version=None` omits the field (backward compat) | Optional field | Pre-ADR callers that don't pass key_version produce compatible output |
| C8 | `LedgerEngine.commit()` passes genesis `key_version` to `build_day_block()` | Engine integration | Commit pipeline propagates key_version from genesis to new blocks |
| C9 | Genesis `key_version` is always the highest (most recent) version | Key version invariant | Per ADR-026 §2: genesis key_version is always the current active version |
| C10 | `format_version` must be bumped to `"0.5.0"` when `key_version` field is present | Format versioning | Per ADR-026 Consequences; format_version signals key_version support |

### Group D: Multi-Version Chain Verification (chain layer) — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `verify()` passes on chain where all blocks have same key_version | Single-version chain | Default case: pre-rotation or post-hard-rotation chain |
| D2 | `verify()` passes on chain where blocks have different key_versions (mixed) | Multi-version chain | Core property: chain with both v1 and v2 blocks must verify |
| D3 | `verify()` detects seal mismatch when wrong MK is used for a block's seal | Cross-version seal detection | Block sealed with MK_v1 must fail verification if tested with MK_v2 seal key |
| D4 | `verify()` selects correct MK per block based on `key_version` field | Per-block MK selection | verify() must look up the right MK for each block's seal check |
| D5 | `verify()` correctly verifies entry-level encryption with block's key_version | Entry decryption per block | Content hash verification requires decrypting entries with the correct MK |
| D6 | `verify()` returns False when a v2 block is present but MK_v2 is not in session cache | Missing version detection | If session only has MK_v1, a v2 block should fail verification gracefully |
| D7 | `verify_block(N)` on mixed-version chain correctly verifies individual blocks | Single-block verification | verify_block must use per-block key_version |
| D8 | Identity MACs remain valid across key versions (identity secret is version-independent) | Cross-version identity | ADR-026 §2: identity secret doesn't change; old identity_seal values stay valid |
| D9 | Content hash verification survives key rotation (same content_hash after re-encryption) | Content hash invariance | Per ADR-026 §Consequences: content_hash is over plaintext, unaffected by re-encryption |
| D10 | `verify()` on pre-ADR chain (no key_version fields) still passes | Backward compat: pre-ADR chain | D9: existing ledgers without key_version must verify |
| D11 | `verify()` on chain with mixed pre-ADR blocks (no key_version) + post-ADR blocks (with key_version) passes | Mixed-format chain | Transitional state during adoption; both formats coexist |
| D12 | `verify()` with genesis key_version=2 but day block key_version=3 (block newer than genesis) returns False | Key version invariant check | Genesis must always have the highest version; newer block with higher version is invalid |

### Group E: Session Key Cache and Auth (auth layer) — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `authenticate()` derives all MKs from v1 through genesis `key_version` | Multi-MK derivation on auth | Session must have all MKs for mixed-version chain verification |
| E2 | `get_key()` returns the current (highest) MK version for new operations | Current MK access | Encrypt/commit operations use the latest MK |
| E3 | `get_mk(version)` returns specific MK version for verification of old blocks | Per-version MK access | verify() needs arbitrary version lookup |
| E4 | `get_mk(999)` on ledger with key_version=3 raises KeyError or returns None | Missing version handling | Requesting a non-existent version should not silently return wrong key |
| E5 | Session cache stores all MK versions (not just current) after auth | Cache completeness | All versions must survive the session for verify() to work |
| E6 | `clear_session()` removes all cached MK versions (not just current) | Session cleanup | Logout must clear every derived key |
| E7 | `_verify_cached_key()` works when cache contains multiple versions | Cache verification | Genesis seal check must use the current (genesis) MK version |
| E8 | Auth with ledger at key_version=3 derives exactly 3 MKs (v1, v2, v3) | Correct version count | No extra derivations beyond genesis key_version |

### Group F: Soft Rotation (new CLI + orchestration) — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Soft rotation increments genesis `key_version` from N to N+1 | Key version increment | Core soft rotation step: bump the version |
| F2 | Soft rotation re-encrypts `identity_secret_enc_fallback` with new MK | Identity secret re-encryption | Per ADR-026 §5: identity envelope re-encrypted on every rotation |
| F3 | Soft rotation re-encrypts staging entries with new MK | Staging re-encryption | Per ADR-026 Open Questions: staging is mutable and small — eagerly re-encrypt |
| F4 | Soft rotation rebuilds and re-encrypts blind index with new MK | Index rebuild | Index key changes with version; must rebuild with new key |
| F5 | Soft rotation re-derives device cookie with new MK | Cookie rotation | Cookie key changes with version; must re-derive |
| F6 | Soft rotation re-seals genesis with new MK's sealing sub-key | Genesis re-seal | Genesis seal must use new MK's seal key |
| F7 | Soft rotation recomputes identity MAC on genesis with new MK | Genesis identity MAC | Identity secret unchanged, but genesis seal changed → new MAC needed |
| F8 | Existing day blocks are NOT modified during soft rotation (key_version unchanged) | Block preservation | Per ADR-026 §5: soft rotation leaves old blocks alone (D5) |
| F9 | After soft rotation, new blocks use new `key_version` (N+1) | New block versioning | Commit after rotation must use the new version |
| F10 | After soft rotation, `verify()` passes on mixed-version chain | Post-rotation integrity | Chain with old v1 blocks + new v2 blocks must verify completely |
| F11 | Soft rotation requires passphrase re-entry for safety | Auth gate | Per ADR-026 Open Questions: rotation must force re-auth like sync |
| F12 | Soft rotation rejected if chain verification fails before rotation | Pre-rotation integrity check | Never rotate a corrupted chain |

### Group G: Hard Rotation (new CLI + orchestration) — ~14 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | Hard rotation re-encrypts every entry in every day block with new MK | Full re-encryption | Core hard rotation property: all ciphertext under new key |
| G2 | Hard rotation updates `key_version` on every block to N+1 | Uniform version update | All blocks must report the new key version |
| G3 | Hard rotation recomputes every entry hash after re-encryption | Entry hash update | Ciphertext changed → entry hash changed |
| G4 | Hard rotation recomputes every block seal with new MK's seal key | Block seal update | All seals use new key version |
| G5 | Hard rotation recomputes every identity MAC (identity_seal) | Identity MAC update | Block content changed → MAC must be recomputed |
| G6 | Hard rotation updates all `prev_hash` links (cascading rewrite) | Chain re-link | Every block hash changed → all prev_hash references must update |
| G7 | Hard rotation also re-encrypts staging + index + cookie (same as soft rotation steps 1-7) | Mutable state rotation | Hard rotation includes all soft rotation steps |
| G8 | Content hashes remain unchanged after hard rotation | Content hash invariance | ADR-026 Consequences: content_hash is over plaintext, survives re-encryption |
| G9 | Hard rotation creates a backup of the old chain before overwriting | Backup requirement | D5 requires explicit migration with backup, not in-place destruction |
| G10 | Hard rotation backup is a complete, verifiable copy of the pre-rotation chain | Backup integrity | Backup must be independently verifiable for recovery |
| G11 | After hard rotation, old MK can no longer decrypt any entry in the active chain | Old MK invalidation | Core security property: after hard rotation, old key is useless |
| G12 | After hard rotation, `verify()` passes on the fully rewritten chain | Post-rotation integrity | Complete chain must verify as a single-key-version chain |
| G13 | Hard rotation requires `--full` flag (not default); `ph rotate-keys --full` | Opt-in protection | Hard rotation is destructive; require explicit flag |
| G14 | Hard rotation with empty ledger (genesis only, no day blocks) completes successfully | Edge case: empty chain | Rotating a ledger with no entries should work (staging/index/cookie only) |

### Group H: Recovery Flow — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `ph recover` with seed derives all MK versions from v1 through genesis key_version | Multi-version recovery | D8: seed must recover everything, including data under all key versions |
| H2 | After recovery, all blocks across all key versions are decryptable | Full data recovery | User must be able to read every entry after recovery |
| H3 | `ph recover` does not change entry data — only re-seals genesis with new passphrase | Non-destructive recovery | Recovery changes passphrase, not data (ADR-026 §6) |
| H4 | Recovery with seed after soft rotation (mixed-version chain) produces correct MKs | Mixed-version recovery | Most common scenario: user recovers after one or more soft rotations |
| H5 | Recovery with seed after hard rotation (single-version chain) works correctly | Post-hard-rotation recovery | Hard rotation is a full rewrite; recovery must still work |
| H6 | Recovery seed is stored encrypted with PDK (unchanged by key rotation) | Seed storage invariant | Seed storage doesn't change with key version; PDK protects it |
| H7 | `verify()` passes after recovery on mixed-version chain | Post-recovery integrity | Chain must verify with newly-derived MKs |
| H8 | Passphrase change after rotation: new PDK encrypts same seed; all MK versions re-derived and match | Passphrase change + rotation | Two independent operations (passphrase change + key rotation) must not conflict |

### Group I: Edge Cases and Error Handling — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Rotation rejected if `content_hash` is missing from any entry at format_version >= 0.4.0 | Content hash gate | Hard rotation requires content_hash to verify re-encrypted entries; I-06 must be satisfied |
| I2 | Rotation with `NoAuthCryptoManager` (no MK) raises appropriate error | No-auth rejection | Cannot rotate without the current MK to decrypt old data |
| I3 | Rotation with wrong passphrase (seal verification fails) rejected | Wrong passphrase gate | Passphrase re-entry is required; wrong passphrase must prevent rotation |
| I4 | Two consecutive soft rotations (N→N+1→N+2) produce correct chain | Multiple rotations | Realistic usage: user rotates annually; chain may have many versions |
| I5 | Soft rotation with empty staging (no entries to re-encrypt) completes without error | Empty staging edge case | Common scenario: all entries committed, staging is empty at rotation time |
| I6 | Soft rotation with no remote transport configured completes locally | Offline rotation | D6: rotation must work without network access |
| I7 | Soft rotation with remote configured pushes re-encrypted staging blob and new cookie | Online rotation | Remote staging and cookie must be updated for cross-device consistency |
| I8 | Hard rotation on chain with >1 year of entries completes within reasonable time | Performance baseline | Hard rotation is O(entries); must handle realistic data sizes |
| I9 | Concurrent rotation detection: if another device rotated while local was offline, detection via cookie mismatch | Cross-device rotation conflict | Real-world multi-device scenario; cookie specifier mismatch should detect |
| I10 | Format version auto-bump: genesis gets `format_version: "0.5.0"` when `key_version` field is first added | Format version transition | Per ADR-026 Consequences: format_version bump required |

### Group J: Web (JavaScript) Equivalents — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | `deriveMk(seed, version)` in JS produces same output as Python `derive_mk(seed, version)` | Cross-platform key derivation | Both CLI and web must derive identical MKs from same seed + version |
| J2 | JS `CryptoManager` accepts optional `keyVersion` and uses it for all sub-key derivation | JS CryptoManager API | Web CryptoManager mirrors Python's versioned API |
| J3 | JS `LedgerChain.buildDayBlock()` includes `keyVersion` in block output | JS block building | Web block format must match Python |
| J4 | JS `LedgerChain.verify()` handles multi-version chains (per-block MK selection) | JS chain verification | Web verify must handle mixed-version chains from Python CLI |
| J5 | JS session cache stores all MK versions after auth | JS multi-MK cache | Web auth must derive all versions for verification |
| J6 | JS `LocalCache._fieldToken()` uses versioned field key (closes I-02a follow-up) | JS field token rotation | Field tokens must rotate with MK version; also fixes I-02a SHA-256 gap |
| J7 | JS `IndexManager._flush()` uses versioned index key | JS index encryption | Index encryption must use versioned MK |
| J8 | Web soft rotation: re-encrypts IndexedDB staging + index, pushes re-encrypted blob to Worker | Web rotation flow | Web must support soft rotation end-to-end |
| J9 | Web hard rotation: full chain rewrite in IndexedDB with backup | Web hard rotation | Web must support hard rotation (less common but required for parity) |
| J10 | Cross-client roundtrip: Python soft-rotates → web client pulls and verifies mixed-version chain | Cross-client interop | Core scenario: CLI rotates, web client syncs and continues working |

---

## Summary

| Group | Area | Tests | Key Coverage |
|-------|------|-------|-------------|
| A | Versioned MK Derivation | 10 | `derive_mk()`, determinism, version separation, backward compat v0, HMAC domain separation |
| B | Sub-Key Derivation per Version | 10 | Seal, encrypt, index_key, field_key, cookie_key all version-dependent; fixed salts |
| C | Block Structure with key_version | 10 | Genesis + day + summary blocks, seal exclusion, format_version bump, engine passthrough |
| D | Multi-Version Chain Verification | 12 | Mixed-version verify, per-block MK selection, cross-version seal detection, backward compat |
| E | Session Key Cache + Auth | 8 | Multi-MK derivation, `get_mk(version)`, cache lifecycle, logout cleanup |
| F | Soft Rotation | 12 | Version increment, staging/index/cookie re-encrypt, genesis re-seal, mixed-verify, auth gate |
| G | Hard Rotation | 14 | Full re-encrypt, seal/MAC/prev_hash rewrite, backup, content_hash invariant, empty-chain edge case |
| H | Recovery Flow | 8 | Multi-version recovery, mixed-version decrypt, passphrase change + rotation non-conflict |
| I | Edge Cases & Error Handling | 10 | Wrong passphrase, no-auth, multi-rotation, offline, cross-device, format_version bump |
| J | Web (JS) Equivalents | 10 | Cross-platform key derivation, block format, verify, rotation, cross-client roundtrip |
| **Total** | | **104** | |

### Critical Dependencies (must pass before I-01 rotation tests are meaningful)
- **I-04** ✅ (seal naming — `identity_seal` field name cleared)
- **I-06** ✅ (content_hash required at v0.4.0+ — hard rotation needs verifiable content_hash)

### Design Directives Checklist
- **D2 (Zero-Knowledge):** Old data decryptable after rotation ✅ — seed derives all MKs
- **D4 (Chain of Trust):** Block seals + identity MACs verify across key versions ✅ — identity secret version-independent
- **D5 (Append-Only):** Soft rotation doesn't touch old blocks ✅; hard rotation creates backup ✅
- **D8 (Recoverability):** Seed recovers everything, including data under all key versions ✅
- **D9 (Backward Compat):** Pre-ADR chains verify ✅; missing key_version → genesis default ✅; opt-in rotation ✅
- **D10 (Testing Integrity):** 104 assertions across 10 groups covering all layers ✅
