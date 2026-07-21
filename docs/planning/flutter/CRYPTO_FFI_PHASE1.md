# Crypto FFI Bridge — Test Exploration (Phase 1)

> **Plan:** `docs/planning/flutter/INITIAL_PLAN.md` §Phase 2
> **Purpose:** Blueprint of all needed test assertions before writing any Dart crypto bridge code.
> **Status:** ✅ Phase 1 complete | ✅ Phase 2 complete (RED) | ✅ Phase 3 complete (GREEN — 74/74) | ✅ Phase 4 complete (REFACTOR)
> **Next Phase:** N/A — Crypto FFI Bridge 4-phase TDD complete.

## Architecture Overview

The Crypto FFI Bridge wraps the Rust `phpoc-crypto-core` library (9 modules, ~35 public functions) behind a single Dart `CryptoService` class. The service:

1. **Loads** the Rust `.so` via `flutter_rust_bridge` (or falls back to a pure-Dart shim during development)
2. **Exposes** every crypto primitive needed by the Flutter app's Storage, Sync, and Services layers
3. **Caches** the Master Key in memory (never on disk) for convenience methods
4. **Normalizes** errors — Rust `Result::Err` and `Option::None` become Dart exceptions
5. **Uses hex-encoded strings** at the Dart/Rust boundary (matching the JS WASM pattern)

### Boundary Format Decision

Keys and binary data cross the FFI boundary as **hex-encoded strings**. This matches the established JS/WASM pattern and avoids platform-specific `Uint8List`/`Vec<u8>` serialization complexity in `flutter_rust_bridge`. The Rust side performs hex encode/decode inside the FFI functions, not in the Dart wrapper.

### Modules Under Test

| Rust Module | Functions Bridged | Dart Method Names |
|---|---|---|
| `key_derivation` | `derive_pdk`, `derive_master_key`, `derive_blob_key`, `derive_seal_key`, `derive_pdk_with_salt` | `derivePdk`, `deriveMasterKey`, `deriveBlobKey`, `deriveSealKey` |
| `aes_ctr` | `encrypt`, `decrypt` | `encrypt`, `decrypt` |
| `blob` | `obfuscate_blob`, `deobfuscate_blob`, `select_tier` | `obfuscateBlob`, `deobfuscateBlob` |
| `digest` | `sha256_hex`, `compute_entry_hash`, `compute_content_hash` | `sha256`, `computeEntryHash`, `computeContentHash` |
| `hmac_utils` | `seal`, `verify_seal`, `sign`, `verify_signature`, `hmac_hex` | `seal`, `verifySeal`, `sign`, `verifySignature`, `hmacHex` |
| `device` | `get_device_id`, `device_proof`, `verify_device_proof`, `derive_device_id`, `get_device_secret` | `getDeviceId`, `deviceProof`, `verifyDeviceProof`, `deriveDeviceId`, `getDeviceSecret` |
| `random` | `generate_seed`, `generate_uuid_v4`, `generate_device_specifier` | `generateSeed`, `generateUuid`, `generateDeviceSpecifier` |

### Risk Mitigation

If `flutter_rust_bridge` + Android NDK toolchain issues block FFI, tests run against a **pure-Dart crypto shim** implementing the identical interface. The shim is temporary and clearly marked. Tests are interface-based — they pass regardless of which backend implements them.

---

## Test Groups

### Group A: Service Lifecycle & Key Cache — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `CryptoService.initialize()` → `isInitialized == true` | Verifies the Rust `.so` loads and the service is ready | Gate: all other operations must fail before this |
| A2 | Calling `initialize()` twice is idempotent | Singleton lifecycle — no double-load or crash | Matches JS `CryptoService.create()` behavior |
| A3 | `setMasterKey(hex)` → `hasMasterKey == true` | In-memory key cache works | Foundation for all cached-key convenience methods |
| A4 | `getMasterKey()` returns the exact hex string passed to `setMasterKey` | Cache integrity | Stale/wrong key in cache would silently corrupt all crypto |
| A5 | `clearMasterKey()` → `hasMasterKey == false` | Key eviction works | Required for logout/lock flow (Axiom B3: MK never on disk) |
| A6 | Cached-key method (e.g., `encryptWithCachedKey`) throws when no MK cached | Fail-fast guard | Prevents confusing null-pointer errors; matches JS `#requireMasterKey()` |
| A7 | Any crypto method throws `CryptoServiceNotInitialized` when called before `initialize()` | Ready-guard | Prevents WASM/FFI null-deref crashes |
| A8 | `clearMasterKey()` zeroes the in-memory bytes (not just drops reference) | Secure key clearing | Axiom A10: sensitive material must be zeroed, not left to GC |

### Group B: Key Derivation — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `derivePdk("test", 600000)` → 64-char hex, deterministic across calls | PBKDF2-SHA256 passphrase derivation | Foundation of auth flow; non-deterministic PDK = broken unlock |
| B2 | Same passphrase, different iterations → different PDK | Iteration count affects output | Prevents silent auth failures when switching between standard (600K) and legacy (100K) |
| B3 | Different passphrases → different PDKs | Semantic uniqueness | Collision would mean two passphrases unlock the same seed |
| B4 | `deriveMasterKey(validSeed)` → 64-char hex | Base64 seed → 32-byte MK | Core auth path: seed decode must be byte-perfect |
| B5 | `deriveMasterKey("not-base64!!!")` throws | Invalid input validation | Garbage seed must not produce garbage key |
| B6 | `deriveMasterKey(seedWithWrongLength)` throws | Length validation | 32-byte invariant from PHPSPEC §2.3 |
| B7 | `deriveBlobKey(mkHex)` → 32-char hex (16 bytes) | Blob sub-key derivation | Matches `HMAC-SHA256(MK, "blob-obfuscation")[:16]` |
| B8 | `deriveSealKey(mkHex)` → 64-char hex (32 bytes) | Seal sub-key derivation | Matches PHPSPEC §5.2; must match JS output byte-for-byte |
| B9 | `deriveFieldKey(mkHex)` → 32-char hex | Field token key for blind index | I-02a requirement; cross-client parity needed |
| B10 | All key derivations produce identical output to JS `CryptoService` for same inputs | Cross-client interoperability (F6) | Mobile and web must derive the same keys from the same passphrase+seed |

### Group C: AES-128-CTR Encrypt/Decrypt — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `decrypt(encrypt(plaintext, mk), mk) == plaintext` | Core roundtrip invariance | If this fails, all field encryption is broken |
| C2 | `encrypt("hello", mk)` produces non-empty hex string | Output format | Hex-encoded wire format required per PHPSPEC §3.4 |
| C3 | Same plaintext + same MK → different ciphertext each call | Semantic security | Random salt/nonce per encryption prevents pattern analysis |
| C4 | `decrypt(ciphertext, wrongMk)` throws | Wrong-key detection | Auth tag must reject decryption with wrong key |
| C5 | `decrypt(tamperedCiphertext, mk)` throws | Tamper detection | Encrypt-then-MAC integrity; single bit flip must fail |
| C6 | Unicode plaintext (`"日本語 Español 🔐"`) roundtrips correctly | UTF-8 support | Entry titles can contain any Unicode |
| C7 | Empty string `""` roundtrips correctly | Edge case | Empty fields (blank comment, etc.) must work |
| C8 | Dart `encrypt` output can be `decrypt`ed by JS `CryptoService`, and vice versa | Cross-client field encryption (F6) | Mobile-captured entries must be decryptable by web/CLI |

### Group D: Blob Obfuscation — ~9 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `deobfuscateBlob(obfuscateBlob(data, mk), mk) == data` | Core roundtrip | Staging blob push/pull must be lossless |
| D2 | Obfuscated blob length ≥ 64K for small inputs | Tier padding | Padding to tier ceiling hides true blob size (PHPSPEC §8.5) |
| D3 | `deobfuscateBlob(blob, wrongMk)` returns null/throws | Wrong-key detection | Auth tag verification before decryption |
| D4 | Tampered blob (bit flip in ciphertext) → deobfuscation fails | Tamper detection | Encrypt-then-MAC for blob integrity |
| D5 | 100-byte input → 64K tier (65,536 byte output minimum) | Tier selection: small | All four tiers must select correctly |
| D6 | 65,000-byte input → 64K tier; 66,000-byte → 128K tier | Tier boundary behavior | Off-by-one at tier boundaries would misalign deobfuscation |
| D7 | 600,000-byte input → `BlobTooLarge` error | Overflow guard | Server-side size limits; early rejection prevents wasted uploads |
| D8 | `deobfuscateBlob("too-short", mk)` → error/null | Input validation | Prevents buffer underrun on truncated blobs |
| D9 | Dart `obfuscateBlob` output can be `deobfuscateBlob`'d by JS, and vice versa | Cross-client blob sync (F6) | Mobile staging must be readable by web sync |

### Group E: SHA-256 — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `sha256("hello") == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"` | Known-answer test | Catches endianness/encoding issues in FFI boundary |
| E2 | `sha256("test") == sha256("test")` (deterministic) | Idempotence | Hash must be consistent; any randomness = broken chain verification |
| E3 | `sha256("")` produces valid 64-char hex (not error) | Empty input | Empty strings appear in content hash for blank fields |
| E4 | `sha256(data)` matches JS `CryptoService.sha256(data)` byte-for-byte | Cross-client parity | Content hash and index hashes must match across clients |

### Group F: HMAC / Sealing / Signing — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `verifySeal(data, seal(data, mk), mk) == true` | Seal roundtrip | Block integrity verification (PHPSPEC §5.2) |
| F2 | `verifySeal("tampered", seal("original", mk), mk) == false` | Tamper detection | One-bit change in block data must invalidate seal |
| F3 | `verifySeal(data, seal(data, mk1), mk2) == false` | Wrong-key detection | Different MK must produce different seal verification |
| F4 | `verifySignature(data, sign(data, secret), secret) == true` | Signature roundtrip | Identity-based signing |
| F5 | `verifySignature("fake", sign("real", secret), secret) == false` | Signature tamper detection | Data-sig binding |
| F6 | `hmacHex(keyHex, "data")` returns deterministic 64-char hex | Generic HMAC | Used by device proof, field tokens, sub-key derivation |
| F7 | All HMAC outputs match JS `CryptoService` for same inputs | Cross-client parity | Seals and signatures must verify across clients |
| F8 | `seal(data, mk).length == 64` | Output format | HMAC-SHA256 = 32 bytes = 64 hex chars |

### Group G: Device Identity — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `getDeviceId(mk)` → deterministic 64-char hex | Device ID derivation | Same MK → same device ID (PHPSPEC §2.8) |
| G2 | `getDeviceId(mk1) != getDeviceId(mk2)` for different MKs | Identity separation | Different users must have different device IDs |
| G3 | `deviceProof(mk, deviceId)` → deterministic 64-char hex | Proof generation | Cookie auth: device proves MK knowledge without revealing it |
| G4 | `verifyDeviceProof(deviceId, deviceProof(mk, deviceId), mk) == true` | Proof verification | Valid proof must verify |
| G5 | `verifyDeviceProof(deviceId, "00...00", mk) == false` | Fake proof rejection | All-zero proof must not pass validation |
| G6 | `verifyDeviceProof("wrong-id", validProof, mk) == false` | Device ID binding | Proof must be for the claimed device ID |
| G7 | `deriveDeviceId(mk, perDeviceSecret)` → 64-char hex, deterministic | Per-device ID derivation | I-09: device-local secret binds ID to physical device |
| G8 | Same MK, different `perDeviceSecret` → different `deriveDeviceId` | Secret binding | Two devices with same MK must have different IDs |
| G9 | `getDeviceSecret(mk)` returns 32 bytes (64 hex) | Device secret derivation | Used for cross-device entry attribution |
| G10 | `getDeviceId(mk)` matches JS `getDeviceId(mk)` for same MK | Cross-platform identity | Device cookie auth must work across clients |

### Group H: Random Generation — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `generateSeed()` returns 44-char base64 string | Recovery seed format | 32 bytes → 44 base64 chars per PHPSPEC §2.2 |
| H2 | Consecutive `generateSeed()` calls return different values | Non-determinism | Cryptographic randomness; collision probability must be negligible |
| H3 | `generateUuid()` returns valid UUID v4 (36 chars, version nibble = 4) | UUID format | RFC 4122 compliance; used for entry IDs |
| H4 | `generateDeviceSpecifier()` returns 32-char hex string | Device specifier format | 16 bytes → 32 hex chars; used for device cookies |
| H5 | Consecutive `generateDeviceSpecifier()` calls return different values | Non-determinism | Cookie uniqueness per device |

### Group I: Content Hash — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `computeEntryHash({"title":"Test","duration":1000})` → 64-char hex, deterministic | Entry hash computation | PHPSPEC §5.4; JSON canonical sort must be byte-perfect |
| I2 | Different entry data → different entry hash | Collision resistance | Two different entries must not produce same hash |
| I3 | `computeContentHash` strips `_enc` suffix, decrypts fields, sorts arrays | Extensible content hash (v0.4.0+) | PHPSPEC §6.1; must match web output for chain verification |
| I4 | `computeContentHash` output matches JS for same entry data | Cross-client chain integrity | Mobile and web must compute identical content hashes |

### Group J: Authentication Flow — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | Full flow: passphrase → `derivePdk` → decrypt seed → `deriveMasterKey` → 64-char MK | End-to-end auth | Integration test covering the complete unlock path |
| J2 | Wrong passphrase + correct seed → error (not garbage MK) | Auth failure detection | Silent auth failure = data corruption |
| J3 | Legacy 100K iteration PDK + seed → correct MK | Backward compatibility | Pre-R3 genesis blocks (pre-commit e25a26c) must still unlock |

### Group K: Error Handling — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | Passing invalid hex to any method that expects hex → throws `CryptoError` | Input validation | Garbage hex must not silently produce garbage output |
| K2 | Passing invalid base64 to `deriveMasterKey` → throws | Input validation | Non-base64 seed must be rejected early |
| K3 | `decrypt(hexTooShort, mk)` → throws | Minimum length check | Less than 24 bytes (salt+nonce) cannot be valid ciphertext |
| K4 | `obfuscateBlob(data > 512KB, mk)` → throws | Blob size limit | Clear error vs silent truncation |
| K5 | Null/empty string to keyed operations → throws cleanly (not segfault) | Null safety | Dart null safety + FFI boundary must handle null gracefully |

---

## Summary

| Group | Name | Count | Key Coverage |
|-------|------|-------|-------------|
| A | Service Lifecycle & Key Cache | 8 | Init, singleton, MK cache, guards, zeroing |
| B | Key Derivation | 10 | PBKDF2, seed→MK, sub-keys, cross-client parity |
| C | AES-128-CTR Encrypt/Decrypt | 8 | Roundtrip, security, Unicode, cross-client |
| D | Blob Obfuscation | 9 | Roundtrip, tier padding, overflow, cross-client |
| E | SHA-256 | 4 | Known-answer, empty input, parity |
| F | HMAC / Sealing / Signing | 8 | Roundtrip, tamper detection, parity |
| G | Device Identity | 10 | Device ID, proof, per-device secret, cross-platform |
| H | Random Generation | 5 | Seed, UUID v4, device specifier, non-determinism |
| I | Content Hash | 4 | Entry hash, extensible hash, chain parity |
| J | Authentication Flow | 3 | Full unlock, wrong passphrase, legacy compat |
| K | Error Handling | 5 | Invalid inputs, length checks, null safety |
| **Total** | | **74 assertions** | |

### Key Cross-Client Coverage
- **B10, C8, D9, E4, F7, G10, I4** — Every crypto primitive that must interoperate across Dart/JS/Python has a cross-client parity assertion with byte-for-byte comparison.
