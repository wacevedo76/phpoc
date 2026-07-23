# Cross-Platform FFI Wiring — Test Exploration (Phase 1)

> **Purpose:** Blueprint of all needed test assertions before wiring the Rust crypto core to Flutter via `flutter_rust_bridge`.
> **Status:** ✅ Phase 1 (test exploration) → ✅ Phase 2 (RED) → ✅ Phase 3 (GREEN) → ✅ Phase 4 (REFACTOR)
> **All four phases complete.**

## Architecture Overview

```
phpoc-crypto-core/ (Rust, ring crate)
├── lib.rs           — public API: aes_ctr, key_derivation, hmac_utils, digest, random, blob, device
├── wasm.rs          — WASM bindings (wasm-bindgen) — 23 exported functions
├── frb.rs  [NEW]    — flutter_rust_bridge API — mirrors wasm.rs, auto-generates Dart FFI
│
phpoc-flutter/
├── lib/core/crypto/
│   ├── crypto_service.dart     — thin wrapper over generated frb bindings (same API as today)
│   └── crypto_service_native.dart [NEW] — implementation backed by frb_generated.dart
├── rust/            [NEW] — symlink or path to phpoc-crypto-core
├── rust_builder/    [NEW] — cargo build config for Android/iOS
│
test/core/crypto/
├── crypto_service_test.dart    — 74 existing tests (must stay GREEN with new backend)
├── frb_api_test.dart    [NEW] — direct FFI tests: all 23 exported functions
├── frb_parity_test.dart [NEW] — cross-platform parity: Rust == Dart shim == JS WASM
└── frb_build_test.dart  [NEW] — build integration: cargo builds, bindings generate, app links
```

### Current state vs target

| Layer | Current | Target |
|-------|---------|--------|
| Crypto implementation | Pure-Dart shim (`pointycastle` + `crypto`) | Rust FFI (`phpoc-crypto-core` via `flutter_rust_bridge`) |
| Public API | `CryptoService` — 29 public methods | Identical API, different backend |
| Tests | 74 assertions, all GREEN (against shim) | Same 74 assertions, GREEN (against FFI) |
| Cross-platform parity | None (Dart shim produces different ciphertext than Rust/WASM) | Byte-identical output across Rust → Dart, WASM → JS, Python |

### Key constraints

1. **API stability:** `CryptoService` public API must NOT change — all 7 Flutter modules consume it
2. **Byte compatibility:** FFI output must be byte-identical to the Rust crate's existing unit tests (used by WASM for web)
3. **Platform targets:** Android (ARM/x86 `.so`), iOS (`.a`), plus host for testing (Linux x86_64 `.so`)
4. **Error handling:** Rust `CryptoError` must map cleanly to Dart `CryptoException` across the FFI boundary

## Test Groups

### Group A: flutter_rust_bridge Scaffold — ~12 tests
Build system integration: Rust compilation, binding generation, Dart linkage.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `flutter_rust_bridge_codegen generate` produces `frb_generated.dart` and `frb_generated.io.dart` with zero errors | Codegen creates valid Dart bindings | Catch codegen breakage immediately — critical path |
| A2 | `cargo build` succeeds for host target (Linux x86_64) with `flutter_rust_bridge` feature | Rust compiles into native library | Host target needed for `flutter test` to run |
| A3 | `flutter test` links against the native library and initializes without error | FFI library loads at test startup | Tests must run against real FFI, not mocks |
| A4 | Generated Dart API has exactly the 23 exported functions matching the Rust `frb.rs` surface | Every Rust function is callable from Dart | Missing bindings = missing crypto ops |
| A5 | `cargo build --target aarch64-linux-android` succeeds | Android ARM64 compilation | Primary mobile target |
| A6 | `cargo build --target x86_64-linux-android` succeeds | Android x86_64 compilation (emulator) | Required for emulator testing |
| A7 | Android `.so` loads on API 35 emulator without UnsatisfiedLinkError | Native library links on device | Real mobile integration check |
| A8 | Generated Dart bindings compile with `flutter analyze` — zero errors/warnings | Generated code is clean | Regressions in generated code surface immediately |
| A9 | `flutter_rust_bridge` version pinned in `Cargo.toml` and `pubspec.yaml` matches | Version consistency across Rust/Dart | Mismatched versions break codegen silently |
| A10 | Rust crate compiles with `panic = "abort"` for release target (smaller binary) | Release optimization | Abort-on-panic is standard for FFI libraries |
| A11 | Dart `NativeLibrary` loads the `.so`/`.dylib` at app startup (not lazily) | Early binding ensures crypto is available when needed | Lazy load risks first-use latency in auth flow |
| A12 | `flutter build apk --debug` succeeds with Rust FFI linked | Full build pipeline works | Integration test that nothing is broken end-to-end |

### Group B: Key Derivation FFI — ~10 tests
`derive_pdk`, `derive_master_key`, `derive_blob_key`, `derive_seal_key`, `derive_field_key`, `derive_pdk_with_salt`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `derivePdk("test", 600000)` via FFI returns 64-char hex | PDK derivation works across boundary | Foundation for all auth flows |
| B2 | `derivePdk` output matches Dart shim's existing test constant `mkHex` semantics | Drop-in replacement compatibility | Existing 74 tests must pass without modification |
| B3 | `derivePdk("test", 600000) == derivePdk("test", 600000)` — deterministic across calls | Same input → same output | Determinism is required for key derivation |
| B4 | `deriveMasterKey(validSeed)` returns 64-char hex matching Rust's `derive_master_key` output | Seed → MK identical across Rust/Dart | Cross-platform parity |
| B5 | `deriveMasterKey` with non-base64 seed throws `CryptoException` (not segfault) | Error crosses FFI boundary cleanly | Panic across FFI = undefined behavior |
| B6 | `deriveMasterKey` with wrong-length decoded seed throws | Validation in Rust propagates to Dart | Seed length must be validated |
| B7 | `deriveBlobKey(mk)` returns 32-char hex matching Rust `derive_blob_key` | Blob sub-key derivation parity | Required for obfuscate/deobfuscate |
| B8 | `deriveSealKey(mk)` returns 64-char hex matching Rust `derive_seal_key` | Seal sub-key derivation parity | Required for block seal/verify |
| B9 | `deriveFieldKey(mk)` returns 32-char hex matching Rust `derive_field_key` | Field token key parity | Required for I-02a field-name tokens |
| B10 | `derivePdkWithSalt("test", salt16Hex, 600000)` returns deterministic 64-char hex matching Rust | Per-user salt derivation works | Required for I-05 per-user PBKDF2 salt |

### Group C: AES-128-CTR Encrypt/Decrypt FFI — ~10 tests
`encrypt`, `decrypt`, encrypt/decrypt roundtrip across FFI.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `encrypt("Hello", mk)` via FFI returns valid hex string (≥112 chars) | Encryption works across boundary | Core crypto operation |
| C2 | `decrypt(encrypt(plaintext, mk), mk) == plaintext` via FFI | Roundtrip preserves data | Fundamental correctness |
| C3 | FFI `encrypt` output is byte-identical to Rust `aes_ctr::encrypt` with same inputs (deterministic test with fixed salt/nonce) | Cross-platform output parity | Proves Rust→Dart path is identical to Rust→WASM path |
| C4 | FFI `decrypt` with wrong key throws `CryptoException("auth tag mismatch")` | Error message crosses boundary | Attackers must not distinguish error types |
| C5 | FFI `decrypt` with tampered ciphertext throws | Auth tag verification works | Cryptographic integrity check |
| C6 | `encrypt("")` (empty string) roundtrips correctly via FFI | Edge case: zero-length plaintext | Common in staging entries without a field set |
| C7 | Unicode plaintext (日本語, emoji) roundtrips via FFI | UTF-8 handling across FFI boundary | Rust strings are UTF-8 — must survive roundtrip |
| C8 | `encrypt` produces different ciphertext each call (semantic security) | Random salt/nonce each invocation | Prevents pattern analysis |
| C9 | Dart `CryptoService.encrypt` via FFI == existing test's expected behavior for C1–C8 | Drop-in replacement | All 74 existing tests pass without change |
| C10 | `encrypt` with invalid hex key throws `CryptoException`, not Rust panic | Graceful error handling | Invalid inputs must not crash the app |

### Group D: Blob Obfuscation FFI — ~8 tests
`obfuscate_blob`, `deobfuscate_blob`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `obfuscateBlob(smallData, mk)` returns base64 string ≥87K chars (64K tier) | Tiered padding works | Blob size obfuscation |
| D2 | `deobfuscateBlob(obfuscateBlob(data, mk), mk) == data` via FFI | Roundtrip preserves data | Core staging transport |
| D3 | FFI obfuscate → deobfuscate matches Rust blob test vectors byte-for-byte | Cross-platform output parity | Blob format must be identical for CLI ↔ mobile interop |
| D4 | `deobfuscateBlob` with wrong key throws `CryptoException` | Auth verification works | Wrong key must not silently return garbage |
| D5 | `deobfuscateBlob` with tampered base64 throws | Integrity check works | Tamper detection for transport |
| D6 | Blob > 512KB throws `CryptoException("BlobTooLarge")` | Size limit enforced | Server-side R2 has 512KB body limit |
| D7 | `obfuscateBlob` enters 128K tier when encrypted output exceeds 64K | Tier boundary handling | Tier transitions are correctness-critical |
| D8 | `obfuscateBlob` output for same input is deterministic when called with same salt/nonce (deterministic variant) | Deterministic mode for testing | Enables cross-platform test vector validation |

### Group E: SHA-256 & HMAC FFI — ~8 tests
`sha256`, `seal`, `verify_seal`, `sign`, `verify_signature`, `hmac_hex`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `sha256("hello")` via FFI == `"2cf24dba..."` (known answer) | SHA-256 correctness | Foundation for all hash operations |
| E2 | `seal(data, mk)` + `verifySeal(data, seal, mk) == true` via FFI | Seal/verify roundtrip | Block integrity for chain verification |
| E3 | `verifySeal(data, seal, wrongMk) == false` via FFI | Wrong key rejected | Tamper detection |
| E4 | `sign(data, secret)` + `verifySignature(data, sig, secret) == true` via FFI | Sign/verify roundtrip | Identity signature for genesis |
| E5 | `hmacHex(key, data)` returns 64-char hex matching Rust `hmac_utils::hmac_hex` | Generic HMAC parity | Used for device proofs and field tokens |
| E6 | FFI `sha256` output matches Rust `digest::sha256_string` byte-for-byte | Cross-platform hash parity | Content hashing must be identical |
| E7 | `seal` output is exactly 64 hex chars | Output length invariant | Seal format is part of chain spec |
| E8 | Tampered data causes `verifySeal` to return `false` (not throw) | Verification returns bool, not exception | Verification is a predicate, not an assertion |

### Group F: Device Identity FFI — ~8 tests
`get_device_id`, `device_proof`, `verify_device_proof`, `derive_device_id`, `get_device_secret`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `getDeviceId(mk)` via FFI returns deterministic 64-char hex | Device ID derivation | Cookie-based sync uses device IDs |
| F2 | `deviceProof(mk, deviceId)` + `verifyDeviceProof(id, proof, mk) == true` via FFI | Proof roundtrip | Device identity for remote staging |
| F3 | Different MK → different `getDeviceId` output | Key diversity | Each user gets unique device IDs |
| F4 | `deriveDeviceId(mk, deviceSecret)` returns 64-char hex matching Rust `derive_device_id` | I-09 device attribution parity | Hardware-bound device IDs |
| F5 | `getDeviceSecret(mk)` returns 64-char hex matching Rust `get_device_secret` | Device secret consistency | Required for device-local secret storage |
| F6 | `verifyDeviceProof` with all-zero proof returns `false` | Zero proof rejected | Prevents trivial forgery |
| F7 | `verifyDeviceProof` with wrong device ID returns `false` | ID mismatch rejected | Device impersonation prevention |
| F8 | FFI device identity output matches Dart shim's existing test expectations for G1–G10 | Drop-in replacement compatibility | All 10 Group G tests stay GREEN |

### Group G: Random Generation FFI — ~5 tests
`generate_seed`, `generate_uuid_v4`, `generate_device_specifier`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `generateSeed()` via FFI returns 44-char base64 string | Seed format correct | Onboarding seed generation |
| G2 | Consecutive `generateSeed()` calls return different values | Randomness | Seeds must be unique |
| G3 | `generateUuid()` via FFI returns valid UUID v4 (version nibble = 4, variant = 8/9/a/b) | UUID v4 format | Device identification |
| G4 | `generateDeviceSpecifier()` returns 32-char hex | Specifier format | Cookie specifier for device identity |
| G5 | FFI random output matches Dart shim's test expectations for H1–H5 | Drop-in replacement compatibility | All 5 Group H tests stay GREEN |

### Group H: CryptoService Wrapper — ~10 tests
The `CryptoService` Dart class wrapping the FFI bindings — lifecycle, caching, error handling.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `CryptoService.initialize()` loads native library and sets `isInitialized = true` | FFI init works | All crypto ops require initialization |
| H2 | `initialize()` called twice is idempotent (no double-load crash) | Safe re-initialization | Widget rebuilds may trigger re-init |
| H3 | `setMasterKey(hex)` → `getMasterKey()` returns exact same hex | Key cache works | Convenience methods need cached MK |
| H4 | `clearMasterKey()` → `hasMasterKey == false` and memory zeroed | Secure key eviction | MK must not linger in memory |
| H5 | `encryptWithCachedKey` works when MK is cached, throws when not | Convenience method contract | Consistent with existing API |
| H6 | `decryptWithCachedKey` works when MK is cached, throws when not | Convenience method contract | Consistent with existing API |
| H7 | Any crypto method called before `initialize()` throws `CryptoException` | Initialization guard | Prevents segfaults from uninitialized FFI |
| H8 | `CryptoService` public API surface matches existing 29-method contract exactly | API stability | All 7 modules must compile without changes |
| H9 | Rust panic (simulated via invalid internal state) produces `CryptoException` in Dart, not app crash | Panic safety | Rust panics across FFI = undefined behavior |
| H10 | All 74 existing `crypto_service_test.dart` tests pass with FFI backend | Full backward compatibility | Zero regression requirement |

### Group I: Cross-Platform Parity — ~12 tests
Byte-identical output across Rust → Dart FFI, Rust → WASM → JS, and Python reference implementation.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `encrypt("cross-client-test", fixedMK)` → identical hex output from Dart FFI and Rust CLI | Encryption parity | Staging entries encrypted on mobile must decrypt on CLI |
| I2 | `seal(canonicalJson, fixedMK)` → identical output from Dart FFI and Rust CLI | Seal parity | Chain blocks sealed on mobile must verify on CLI |
| I3 | `sha256(testData)` → identical output on all 4 platforms (Dart FFI, Rust, Python, JS WASM) | Hash parity | Content hashes must be universal |
| I4 | `deriveMasterKey(fixedSeed)` → identical MK on all platforms | Key derivation parity | Same seed must produce same MK everywhere |
| I5 | `derivePdk(fixedPass, 600000)` → identical PDK on all platforms | PDK parity | Authentication must work cross-platform |
| I6 | `obfuscateBlob_deterministic(fixedData, fixedMK, fixedSalt, fixedNonce)` → identical output | Blob parity (deterministic) | Staging blob format must be universal |
| I7 | `deriveBlobKey(mk)` → identical sub-key on all platforms | Sub-key parity | Obfuscation key must match |
| I8 | `deriveSealKey(mk)` → identical sub-key on all platforms | Sub-key parity | Seal key must match |
| I9 | `hmacHex(key, data)` → identical on all platforms | HMAC parity | Generic HMAC for field tokens and device proofs |
| I10 | `deviceProof(mk, deviceId)` → identical on all platforms | Device proof parity | Remote device verification cross-platform |
| I11 | `getDeviceId(mk)` → identical on all platforms | Device ID parity | Same MK identifies same device regardless of platform |
| I12 | `computeEntryHash(canonicalJson)` → identical on all platforms | Entry hash parity | Entry identity for merge engine |

### Group J: Integration — ~8 tests
End-to-end: initialized FFI → full auth flow → encrypt/blobs/seals → cross-platform verification.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | Full auth flow: `derivePdk` → `deriveMasterKey` → `setMasterKey` → `encrypt` → `decrypt` | End-to-end crypto pipeline | Real-world usage pattern |
| J2 | `encrypt` → base64-encode → `obfuscateBlob` → `deobfuscateBlob` → `decrypt` = original | Nested crypto operations | Staging blob push/pull flow |
| J3 | `deriveSealKey` → `seal` → `verifySeal` with same MK produces `true` | Block sealing flow | Chain verification pipeline |
| J4 | `CryptoService` integration with `OnboardingService` works (create seed, derive MK, store) | Service-layer integration | Onboarding depends on crypto |
| J5 | `CryptoService` integration with `AuthService` works (set MK, encrypt/decrypt staging) | Auth integration | Session management depends on crypto |
| J6 | `CryptoService` integration with `SyncService` works (device proof, blob obfuscate/deobfuscate) | Sync integration | Remote sync depends on crypto |
| J7 | `CryptoService` integration with `LedgerEngine` works (seal blocks, verify chain) | Ledger integration | Chain integrity depends on crypto |
| J8 | Full test suite (747 tests) passes with FFI backend — zero regressions | No regressions anywhere | All 7 modules depend on CryptoService |

### Group K: Error Handling & Edge Cases — ~8 tests
Rust error types mapped to Dart exceptions, platform-specific edge cases.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | All 7 `CryptoError` variants map to distinct `CryptoException` messages in Dart | Error fidelity | Callers may match on error type |
| K2 | `AuthTagMismatch` → Dart message contains "auth tag" (not "unwrap" or Rust backtrace) | User-friendly errors | Error messages displayed in UI |
| K3 | `InvalidBase64` → Dart message contains "base64" | User-friendly errors | Seed input validation feedback |
| K4 | `BlobTooLarge` → Dart message includes actual size and max | Actionable errors | User needs to know why upload failed |
| K5 | Passing non-hex string where hex expected → `CryptoException` (not Rust panic) | Input validation at boundary | Defense in depth |
| K6 | Very large input (10MB plaintext to encrypt) handled gracefully (not OOM crash) | Resource bounds | Mobile devices have limited memory |
| K7 | Concurrent calls to `encrypt` from multiple isolates don't corrupt FFI state | Thread safety | Flutter uses isolates for background work |
| K8 | `CryptoService` after `clearMasterKey` → memory inspection shows no MK bytes | Secure cleanup | Defense against memory dumps |

## Summary

| Group | Focus | Tests | Key dependency |
|-------|-------|-------|---------------|
| **A** | flutter_rust_bridge Scaffold | 12 | `flutter_rust_bridge` v2, cargo-ndk |
| **B** | Key Derivation FFI | 10 | `frb.rs` exports `derive_pdk`, `derive_master_key`, etc. |
| **C** | AES-128-CTR FFI | 10 | `frb.rs` exports `encrypt`, `decrypt` |
| **D** | Blob Obfuscation FFI | 8 | `frb.rs` exports `obfuscate_blob`, `deobfuscate_blob` |
| **E** | SHA-256 & HMAC FFI | 8 | `frb.rs` exports `sha256`, `seal`, `sign`, `hmac_hex` |
| **F** | Device Identity FFI | 8 | `frb.rs` exports `get_device_id`, `device_proof`, etc. |
| **G** | Random Generation FFI | 5 | `frb.rs` exports `generate_seed`, `generate_uuid_v4` |
| **H** | CryptoService Wrapper | 10 | Existing 29-method `CryptoService` contract |
| **I** | Cross-Platform Parity | 12 | Rust unit tests + JS WASM + Python test vectors |
| **J** | Integration | 8 | All 7 Flutter modules |
| **K** | Error Handling | 8 | Rust `CryptoError` → Dart `CryptoException` mapping |
| **Total** | | **99** | |

### Key architectural decision

The `flutter_rust_bridge` approach is:
1. **New Rust API file** `phpoc-crypto-core/src/frb.rs` — mirrors `wasm.rs` but uses `flutter_rust_bridge` annotations instead of `wasm-bindgen`
2. **Codegen** produces `frb_generated.dart` with native function bindings
3. **`CryptoService`** becomes a thin wrapper (lifecycle, key cache, error normalization) delegating to generated bindings — **identical public API** to today's shim
4. **Existing 74 tests** require zero changes — they test the `CryptoService` contract, not the implementation
5. **New tests** (Groups A–K minus the H-band) test the FFI layer directly

### Risks to address in Phase 3

- `ring` crate's WASM-only features must work on Android ARM/iOS — `ring` uses assembly, may need target-specific Cargo config
- `flutter_rust_bridge` v2 codegen stability — pin exact version
- iOS requires universal binary (.a) — CI/CD complexity
- Android NDK toolchain setup — `cargo-ndk` must be available in CI
