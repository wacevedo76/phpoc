# CCS-1b: Flutter Obfuscation Compatibility — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` §5 CCS-1 gap #3
> **Purpose:** Blueprint of all test assertions needed for cross-client obfuscation compatibility before writing any test code.
> **Status:** ✅ 4-Phase TDD Complete
> **Next Phase:** Done — proceed to CCS-2
> **Invariants:** I2 (same plaintext + MK → identical ciphertext), I5 (never trust remote)

## Problem

Flutter `CryptoService.obfuscateBlob()` uses random salt/nonce every invocation → same plaintext + MK produces different ciphertext. This blocks cross-client test vectors per invariant I2, which blocks CCS-2 and CCS-3 per plan dependency graph §6.

**Root cause:** No `obfuscateBlobDeterministic()` method. Rust (`blob.rs`) and Python (`remote_sync.py`) both have it. Flutter has all the internal primitives (`_deriveBlobKeyBytes`, `_deriveBlobEncryptionKeys`, `_blobEncryptAndTag`) — it just needs the public API wrapper with explicit salt/nonce + zero-fill padding.

**Test vectors exist:** `phpoc-crypto-core/tests/crypto_test_vectors.json` §`blob_obfuscation_deterministic` (2 entries) + `blob_key_derivation` (1 entry).

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                    CryptoService (Flutter / Dart)                     │
│                                                                      │
│  ✅ obfuscateBlob(data, mkHex)           — random salt/nonce/padding  │
│  ✅ deobfuscateBlob(obfuscated, mkHex)   — decrypt + verify HMAC     │
│  ❌ obfuscateBlobDeterministic(            — MISSING                  │
│       data, mkHex, salt, nonce)                                      │
│                                                                      │
│  Internal helpers (already correct):                                 │
│  ✅ _deriveBlobKeyBytes(mk)              — HMAC-SHA256(MK,            │
│                                              "blob-obfuscation")[:16] │
│  ✅ _deriveBlobEncryptionKeys(blobKey, salt) — enc_key + int_key     │
│  ✅ _blobEncryptAndTag(payload, ek, ik, nonce) — AES-CTR + HMAC     │
│  ✅ _selectTier(size)                    — 64K/128K/256K/512K        │
└──────────────────────────────────────────────────────────────────────┘

Rust (blob.rs):  ✅ obfuscate_blob_deterministic(plaintext, mk, salt, nonce)
Python (remote_sync.py): ✅ _obfuscate_deterministic(plaintext, mk, salt, nonce)
Flutter (crypto_service.dart): ❌ MISSING
```

## Test Groups

### Group A: Blob Key Derivation Parity — ~3 assertions

Verify that Flutter's internal key derivation helpers produce byte-identical output to Rust/Python.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `_deriveBlobKeyBytes(mk)` produces canonical 16-byte key: HMAC-SHA256(MK, "blob-obfuscation")[:16] | Key derivation matches Rust/Python | If this is wrong, every downstream ciphertext diverges. Single test vector in `crypto_test_vectors.json` §`blob_key_derivation` gives expected output for `0xAB*32` MK. |
| A2 | `_deriveBlobEncryptionKeys(blobKey, salt)` produces correct (enc_key, integrity_key) pair | Sub-key derivation matches Rust/Python | Non-obvious logic: integrity salt appends "-integrity" string to salt bytes, then HMAC-SHA256. Must match exactly. No test vector exists yet — test verifies indirectly via deterministic ciphertext in Group D. |
| A3 | `_selectTier(size)` matches Rust `select_tier()` for all boundary values | Tier selection identical across clients | Must agree: 0→64K, 65536→64K, 65537→128K, 524288→512K, 524289→error. Test vectors in `blob_tier_selection` (6 entries). |

### Group B: Deterministic Obfuscation API — ~4 assertions

The new `obfuscateBlobDeterministic()` method and its contract.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `obfuscateBlobDeterministic(data, mkHex, salt, nonce)` exists as public method with signature `Uint8List obfuscateBlobDeterministic(String data, String mkHex, Uint8List salt, Uint8List nonce)` | API contract matches Rust/Python | Dart convention: hex strings for keys, raw bytes for salt/nonce. Returns raw `Uint8List` (matching `obfuscateBlob` return type). |
| B2 | Deterministic output can be deobfuscated by `deobfuscateBlob()` (round-trip) | Backward compatibility with existing decrypt path | `deobfuscateBlob()` must handle deterministic output exactly as it handles random output — same wire format, same key derivation. |
| B3 | Same (data, mkHex, salt, nonce) → byte-identical output every call | Determinism guarantee | The whole point. Must not use any randomness. |
| B4 | Different salt → different output (same data + mkHex) | Salt sensitivity | Confirms salt is actually used in key derivation, not ignored. |

### Group C: Cross-Client Read Compatibility — ~3 assertions

Flutter can decrypt obfuscated blobs produced by Rust/Python deterministic mode.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `deobfuscateBlob()` decrypts deterministic test vector from `crypto_test_vectors.json` → returns expected plaintext | Cross-client read compatibility | Proves Flutter can read what Rust/Python writes. Uses 2 existing vectors (small payload + empty blob). |
| C2 | `deobfuscateBlob()` decrypts deterministic output from Rust `obfuscate_blob_deterministic()` (canonical vector) | Read compat verified against Rust reference | Rust is the canonical implementation. If Flutter matches Rust, it matches Python (which already matches Rust). |
| C3 | `deobfuscateBlob()` decrypts deterministic output from Python `_obfuscate_deterministic()` | Read compat verified against Python (round-trip) | Python test already passes D1–D4. Flutter should also round-trip Python output. |

### Group D: Cross-Client Write Compatibility — ~3 assertions

Flutter `obfuscateBlobDeterministic()` produces byte-identical output to Rust/Python.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `obfuscateBlobDeterministic(data, mkHex, salt, nonce)` → byte-identical to Rust `obfuscate_blob_deterministic(plaintext, mk, salt, nonce)` for all test vectors | Cross-client write compatibility — I2 | Core invariant: same plaintext + MK + salt + nonce → identical ciphertext. Compare against `expected_hex` in `crypto_test_vectors.json` §`blob_obfuscation_deterministic`. |
| D2 | `obfuscateBlobDeterministic(empty_string, mkHex, salt, nonce)` → byte-identical to Rust | Zero-length edge case | Empty blob is valid (staging with all entries committed). Already in test vectors. |
| D3 | Deterministic output has correct wire format: salt(16) ‖ nonce(8) ‖ ciphertext ‖ tag(32) | Canonical format per §12.6 | Parse and verify byte offsets: salt at [0:16], nonce at [16:24], tag at [-32:]. |

### Group E: Integrity & Error Handling — ~3 assertions

Security properties that must hold for deterministic mode as they do for random mode.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `deobfuscateBlob()` throws on HMAC tag mismatch (wrong key) | I5: never trust remote | Wrong MK → different integrity key → tag mismatch → exception. Covers both random and deterministic output. |
| E2 | `deobfuscateBlob()` throws on tampered ciphertext (bit flip) | Tamper detection | Single-bit flip in ciphertext → HMAC verification fails → exception. |
| E3 | `obfuscateBlobDeterministic()` validates salt is exactly 16 bytes and nonce is exactly 8 bytes | Input validation | Prevents silent bugs from wrong-size arguments. Rust/Python both validate size. |

## Summary

| Group | Assertions | New vs Existing |
|-------|-----------|-----------------|
| A — Key Derivation Parity | 3 | A2 is new; A1, A3 verify existing helpers |
| B — Deterministic API | 4 | All new — the missing `obfuscateBlobDeterministic()` |
| C — Cross-Client Read | 3 | C1 is new; C2, C3 verify existing `deobfuscateBlob()` |
| D — Cross-Client Write | 3 | All new — byte-identical output verification |
| E — Integrity | 3 | E1, E2 already exist in Group D tests; E3 is new |
| **Total** | **16** | **~11 new, ~5 verify existing** |

Key coverage areas:
- **I2 (same plaintext + MK → identical ciphertext):** Groups C + D
- **I5 (never trust remote):** Group E
- **Canonical wire format:** Groups A + D3
- **Cross-client test vectors:** Groups C1, D1, D2

## Implementation Scope

**New code in `crypto_service.dart`:**
- Public method `obfuscateBlobDeterministic(String data, String mkHex, Uint8List salt, Uint8List nonce)` → `Uint8List`
- Input validation: salt must be 16 bytes, nonce must be 8 bytes
- Uses existing `_deriveBlobKeyBytes()`, `_deriveBlobEncryptionKeys()`, `_blobEncryptAndTag()`, `_selectTier()`, `_writeUint32BE()`
- Padding: zero-fill (matching Rust `obfuscate_blob_deterministic` and Python `_obfuscate_deterministic`)
- Max 512 KB input (same limit as `obfuscateBlob()`)

**No changes needed to:** `deobfuscateBlob()`, internal helpers, wire format — they already match.

**Test file:** `phpoc-flutter/test/core/crypto/crypto_service_test.dart` — new group (e.g., "D2: Deterministic Obfuscation" or extend existing Group D).

**Test vectors:** Loaded from `phpoc-crypto-core/tests/crypto_test_vectors.json` (same file Python tests use).
