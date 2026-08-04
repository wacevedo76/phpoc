# I-01a: RotateKeysCommand Execution — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §Phase 4 — I-01a
> **Depends on:** I-01 (crypto foundation) ✅ — `derive_mk()`, versioned `CryptoManager`, multi-version `verify()`, `get_mk(version)`, `_keys` cache
> **Purpose:** Blueprint of all test assertions needed for the `soft_rotate()` and `hard_rotate()` execution methods in `RotateKeysCommand`.
> **Status:** ✅ Phase 1 (test exploration)
> **Phase 2:** 🔜 RED (test definition)

## Architecture Overview

I-01 built the crypto primitives: versioned MK derivation (`derive_mk`), per-block
`key_version` in the chain, multi-version `verify()` with `get_mk_for_version`,
and a multi-MK session cache (`_keys` dict) in `PassphraseAuthenticator`.

I-01a closes the gap between "infrastructure exists" and "the user can actually
rotate their keys." It implements the orchestration methods in `phpoc_cli/rotate_keys.py`
that wire together auth, crypto, chain, staging, index, and cookie components:

```
RotateKeysCommand.soft_rotate()
├── 1. Re-authenticate (passphrase re-entry gate)
├── 2. Verify chain integrity (pre-rotation check)
├── 3. Derive new MK (key_version = current + 1)
├── 4. Re-encrypt identity_secret_enc_fallback with new MK
├── 5. Re-encrypt all staging entries with new MK
├── 6. Rebuild + re-encrypt blind index with new index key
├── 7. Re-derive device cookie with new MK
└── 8. Re-seal genesis with new MK (increment key_version)

RotateKeysCommand.hard_rotate()
├── All soft_rotate() steps (1–8)
├── 9. Create backup of current chain
├── 10. Re-encrypt every entry in every day block with new MK
├── 11. Update key_version on all blocks to N+1
├── 12. Recompute all entry hashes
├── 13. Recompute all block seals
├── 14. Recompute all identity MACs
└── 15. Recompute all prev_hash links (cascading rewrite)
```

### Components Already Available (from I-01)

| Component | What it provides | File |
|-----------|-----------------|------|
| `derive_mk(seed, version)` | Deterministic MK derivation per version | `security/crypto.py` |
| `CryptoManager(mk, key_version=N)` | Versioned encrypt/decrypt/seal/mac | `security/crypto.py` |
| `PassphraseAuthenticator._keys` | `{version: CryptoManager}` multi-MK cache | `security/auth.py` |
| `PassphraseAuthenticator.get_mk(v)` | Per-version MK lookup | `security/auth.py` |
| `PassphraseAuthenticator.key_version` | Highest available version | `security/auth.py` |
| `LedgerChain.verify(get_mk_for_version)` | Multi-version chain verification | `domain/ledger/chain.py` |
| `LedgerChain.build_day_block(...)` | Builds blocks with `key_version` field | `domain/ledger/chain.py` |
| `IndexManager(store, crypto)` | Encrypted blind index with versioned key | `domain/ledger/index_manager.py` |
| `LocalStagingCache(crypto, store)` | Encrypted staging with field tokenization | `domain/staging/local_cache.py` |
| `DeviceCookie.create(device_id, dir)` | Creates device cookie | `domain/cookie/device_cookie.py` |

### What I-01a Must Build (the missing orchestration)

| Method | What it does | New code |
|--------|-------------|----------|
| `soft_rotate()` | Executes steps 1–8 above | Wires auth → crypto → chain → staging → index → cookie |
| `hard_rotate()` | Executes steps 1–15 above | Soft steps + full chain rewrite + backup |
| `create_backup()` | Copies chain + staging + index to backup dir | File I/O with verification |
| `validate_prerequisites()` | Content hash gate, auth gate, integrity gate | Pre-flight checks |
| `_reencrypt_staging()` | Decrypts staging with old MK, re-encrypts with new MK | Delegates to `LocalStagingCache` |
| `_rebuild_index()` | Decrypts index with old key, rebuilds with new key | Delegates to `IndexManager` |
| `_rederive_cookie()` | Creates new cookie with new MK-derived key | Delegates to `DeviceCookie` |
| `_rewrite_chain()` | Hard rotation: full chain re-encryption | Per-block re-encrypt loop |

### Data Flow (soft rotation)

```
User passphrase → authenticate()
    → get current key_version (from genesis or auth._keys)
    → derive MK_v(N+1) from seed (compute all MKs v1..N+1)
    → create CryptoManager(mk=MK_v(N+1), key_version=N+1)
    → read identity_secret_enc_fallback from genesis
    → decrypt with old CryptoManager → plaintext identity_secret
    → encrypt plaintext with new CryptoManager → new fallback envelope
    → read all staging entries → decrypt each with old CM → re-encrypt with new CM
    → read index → decrypt with old index key → rebuild with new index key
    → create new device cookie (new random specifier)
    → update genesis: key_version=N+1, new fallback, re-seal
    → write ledger.json + staging.json + index.json + cookie files
    → populate auth._keys with MK_v(N+1)
```

---

## Test Groups

### Group S: Soft Rotation Execution — ~14 tests

Core orchestration of `soft_rotate()` — verifying each step modifies the correct
data and the result is a verifiable mixed-version chain.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S1 | `soft_rotate()` increments genesis `key_version` from N to N+1 on disk | Version increment persisted | The defining property of a rotation: genesis key_version bumps |
| S2 | `soft_rotate()` re-encrypts `identity_secret_enc_fallback` — old CM cannot decrypt new envelope, new CM decrypts to same plaintext | Identity envelope rotation | Core security: the identity secret must only be recoverable with the new MK |
| S3 | `soft_rotate()` re-encrypts all staging entries — old CM cannot decrypt them, new CM decrypts to same plaintext | Staging re-encryption | All mutable staging data moves to new encryption key |
| S4 | `soft_rotate()` re-encrypts the blind index — old index key cannot decrypt, new index key decrypts to same data | Index re-encryption | Blind index must use versioned index key |
| S5 | `soft_rotate()` creates a new device cookie with a fresh random specifier | Cookie rotation | Post-rotation, the device cookie must be regenerated for cross-device detection |
| S6 | `soft_rotate()` re-seals genesis — old CM seal fails verification, new CM seal passes | Genesis re-seal | Genesis block_hash must reflect the new key_version and fallback envelope |
| S7 | `soft_rotate()` recomputes identity MAC on genesis with new block_hash | Identity MAC update | Genesis identity_seal depends on block_hash; new hash → new MAC |
| S8 | `soft_rotate()` leaves existing day blocks untouched (same key_version, same ciphertext, same seals) | Block preservation | D5: soft rotation is non-destructive; old blocks stay exactly as-is |
| S9 | After `soft_rotate()`, `LedgerChain.verify()` passes on the mixed-version chain | Post-rotation integrity | Chain with old v1 blocks + new genesis v2 must verify |
| S10 | `soft_rotate()` populates `auth._keys` with the new MK version (N+1) | Session cache update | Auth session must carry all MKs for subsequent verify() calls |
| S11 | `soft_rotate()` requires passphrase re-entry — wrong passphrase returns False without modifying any files | Auth gate | Rotation is a destructive-ish operation; must re-verify user identity |
| S12 | `soft_rotate()` rejects if chain verification fails before rotation (no partial writes) | Pre-rotation integrity | Never rotate a corrupted chain; return False with no side effects |
| S13 | `soft_rotate()` with empty staging (no entries) completes successfully | Empty staging edge case | Common: user committed everything, staging is empty at rotation time |
| S14 | `soft_rotate()` with no remote transport configured completes locally (no remote push) | Offline rotation | D6: rotation must work without network; skip remote push gracefully |

### Group H: Hard Rotation Execution — ~14 tests

Full chain rewrite orchestration — re-encrypts every entry in every block,
updates all metadata, creates a backup.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `hard_rotate()` includes all soft rotation steps (staging, index, cookie, genesis) | Mutable state rotation | Hard rotation subsumes soft; mutable state is re-encrypted first |
| H2 | `hard_rotate()` re-encrypts every entry in every day block — old CM cannot decrypt, new CM decrypts to same plaintext | Full entry re-encryption | Core hard rotation property: all ciphertext under new key |
| H3 | `hard_rotate()` updates `key_version` on every block (genesis + day + summary) to N+1 | Uniform version update | After hard rotation, all blocks report the new key version (D1: single-version chain) |
| H4 | `hard_rotate()` recomputes every entry hash after re-encryption | Entry hash update | Ciphertext changed → entry hash changed |
| H5 | `hard_rotate()` recomputes every block seal with new MK's seal key | Block seal update | All block_hash values use new key version |
| H6 | `hard_rotate()` recomputes every identity MAC (identity_seal) for all blocks | Identity MAC update | Block content changed → MAC must be recomputed |
| H7 | `hard_rotate()` updates all `prev_hash` links in the fully rewritten chain | Chain re-link | Every block's prev_hash must point to the new hash of its predecessor |
| H8 | Content hashes remain unchanged after hard rotation (same plaintext → same `content_hash`) | Content hash invariance | ADR-026: content_hash is over plaintext; survives re-encryption |
| H9 | `hard_rotate()` creates a backup of the pre-rotation chain in a timestamped directory | Backup creation | D5 requires explicit backup before destructive rewrite |
| H10 | Backup is independently verifiable — `LedgerChain.verify()` passes on the backup with old MKs | Backup integrity | Backup must be a valid, complete chain usable for recovery |
| H11 | Backup includes staging, index, and cookie files (not just the ledger) | Complete backup | Recovery from backup needs all mutable state |
| H12 | After `hard_rotate()`, old MK (v1) cannot decrypt any entry in the active chain | Old MK invalidation | Security property: after hard rotation, old MK is useless for active chain |
| H13 | After `hard_rotate()`, `LedgerChain.verify()` passes on the newly-written chain | Post-rotation integrity | Single-version chain must verify as D1 |
| H14 | `hard_rotate()` with genesis-only chain (no day blocks) completes successfully | Empty chain edge case | Rotating a ledger with no entries should succeed (only staging/index/cookie/genesis) |

### Group E: Error Handling & Edge Cases — ~10 tests

Execution-layer error conditions that the orchestration must handle.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Rotation with `NoAuthCryptoManager` (no MK available) raises `RotationError` or returns False | No-auth rejection | Cannot rotate without a real master key |
| E2 | Rotation when genesis has no `key_version` field defaults to `key_version=1` and works | Backward compat | Pre-ADR ledgers have no key_version; first rotation initializes to v1→v2 |
| E3 | Rotation when genesis `format_version < 0.5.0` auto-bumps format_version to `"0.5.0"` | Format version transition | Per ADR-026: key_version support requires format_version 0.5.0 |
| E4 | Rotation with corrupt genesis (unreadable JSON) returns False without modifying files | Corrupt ledger handling | Never write to a corrupt ledger |
| E5 | Two consecutive soft rotations (v1→v2→v3) produce correct chain with 3 key versions | Multiple rotations | Realistic: user rotates annually; chain may accumulate many versions |
| E6 | `soft_rotate()` is idempotent-safe: calling twice in a row with same new version returns False or no-op | Accidental double-rotation | User shouldn't corrupt their chain by running rotate twice |
| E7 | Rotation when `data_dir` doesn't exist returns False (no files created) | Missing data directory | Graceful error, not crash |
| E8 | Hard rotation with >100 day blocks completes within 5 seconds | Performance baseline | Hard rotation is O(entries); must handle realistic chains quickly |
| E9 | Hard rotation with corrupt entry (can't decrypt) returns False and leaves chain untouched | Corruption during rewrite | Don't leave a half-rewritten chain on disk |
| E10 | `hard_rotate()` fails if backup directory cannot be created (disk full, permissions) — returns False, no chain modification | Backup failure safety | Don't start a destructive rewrite without a confirmed backup |

### Group I: Integration & Recovery — ~8 tests

End-to-end flows that exercise the full rotation → verify → recover lifecycle.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Full soft rotation lifecycle: auth → rotate → verify → commit new entries with new key_version → verify again | End-to-end soft rotation | Proves the user can keep using the ledger after soft rotation |
| I2 | Full hard rotation lifecycle: auth → hard-rotate → verify → commit new entries → verify | End-to-end hard rotation | Proves the user can keep using the ledger after hard rotation |
| I3 | After soft rotation, recovery from seed re-derives all MKs and chain verifies | Recovery after soft rotation | D8: seed must recover everything, including mixed-version chains |
| I4 | After hard rotation, recovery from seed re-derives all MKs and chain verifies | Recovery after hard rotation | Recovery must work even after full chain rewrite |
| I5 | Soft rotation followed by passphrase change — all MKs re-derived correctly | Passphrase change + rotation | Two independent operations must not conflict |
| I6 | Remote push after soft rotation: re-encrypted staging blob and new cookie are pushed | Online rotation | Cross-device sync must receive updated staging/cookie |
| I7 | Remote pull after another device soft-rotated: local detects cookie mismatch → re-auth → pulls re-encrypted staging | Cross-device rotation | Multi-device scenario: remote rotated, local must detect and adapt |
| I8 | `ph rotate-keys` CLI command parses `--full` flag and delegates to `RotateKeysCommand.execute(full=True)` | CLI integration | Command must be wired into the CLI parser |

---

## Summary

| Group | Area | Tests | Key Coverage |
|-------|------|-------|-------------|
| S | Soft Rotation Execution | 14 | Genesis re-encrypt, staging re-encrypt, index rebuild, cookie re-derive, re-seal, block preservation, mixed-version verify, auth gate, offline, empty staging |
| H | Hard Rotation Execution | 14 | Full re-encrypt, uniform key_version, entry hash/block seal/MAC/prev_hash recompute, content hash invariance, backup + verification, old MK invalidation, empty chain |
| E | Error Handling & Edges | 10 | NoAuth, backward-compat pre-ADR, format bump, corrupt genesis, multi-rotation, idempotency, missing dir, performance, corrupt entry, backup failure |
| I | Integration & Recovery | 8 | E2E soft/hard lifecycle, recovery after soft/hard, passphrase change + rotation, remote push/pull, CLI wiring |
| **Total** | | **46** | |

### What's Reused from I-01

I-01 tested the crypto and chain primitives in isolation (104 assertions across Groups A–J).
I-01a tests the **orchestration layer** that wires them together. Key differences:

| I-01 tested... | I-01a tests... |
|----------------|----------------|
| `derive_mk()` produces correct bytes | `soft_rotate()` calls `derive_mk()` with correct version |
| `CryptoManager` with different versions encrypts differently | `soft_rotate()` creates new CryptoManager and re-encrypts actual data |
| `verify()` handles mixed-version chains | `soft_rotate()` produces a chain that `verify()` accepts |
| Mock staging/index/cookie data | Real files on disk via temp directories |
| Unit-level crypto properties | Orchestration-level state transitions |

### Design Directives Checklist
- **D2 (Zero-Knowledge):** Old data decryptable after rotation ✅ — seed derives all MKs (tested in I-01, integration-tested in I3/I4)
- **D4 (Chain of Trust):** Seals + MACs verify across key versions ✅ — tested in S9, H13
- **D5 (Append-Only):** Soft rotation preserves old blocks (S8); hard rotation creates backup (H9-H11) ✅
- **D8 (Recoverability):** Seed recovers everything after rotation (I3, I4) ✅
- **D9 (Backward Compat):** Pre-ADR ledgers without key_version rotate correctly (E2) ✅
- **D10 (Testing Integrity):** 46 assertions across 4 groups, all concrete execution-level checks ✅

### Files in Scope

| File | Change | Tests |
|------|--------|-------|
| `phpoc_cli/rotate_keys.py` | Fill in `soft_rotate()`, `hard_rotate()`, `create_backup()`, helper methods | S, H, E, I |
| `phpoc_cli/cli_parsers.py` | Wire `ph rotate-keys` + `--full` flag | I8 |
| `tests/test_i01_rotatekeys_execution.py` | **New file:** S + H + E group tests with real temp dirs | 38 tests |
| `tests/test_i01_rotatekeys_integration.py` | **New file:** I group integration tests | 8 tests |
| `tests/test_i01_key_rotation_orchestration.py` | Existing — Groups F + G (26 tests). These mock-based tests serve as design contracts; I-01a execution tests replace the mocks with real I/O. | Keep as-is or refactor |

### Phase 2 Strategy
Single test file with two classes:
- `TestSoftRotationExecution` — 14 tests (S1–S14)
- `TestHardRotationExecution` — 14 tests (H1–H14)
- `TestRotationErrors` — 10 tests (E1–E10)

Second file for integration:
- `TestRotationIntegration` — 8 tests (I1–I8)

Phase 3 split: 3a (soft rotation → S+H green), 3b (hard rotation → H green, hard subsumes soft).
