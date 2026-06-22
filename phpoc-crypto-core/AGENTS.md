# PH Ledger Crypto Core (Rust)

## Purpose
Portable cryptographic library for the PH Ledger, implemented in Rust. Provides AES-128-CTR encryption, HMAC-SHA256, PBKDF2 key derivation, SHA-256 digest, blob obfuscation, and device identity. Compiles to WASM (web), static library (iOS), and shared library (Android/Linux).

## Ownership
- `src/lib.rs` — Library root, WASM bindings, public API
- `src/aes_ctr.rs` — AES-128-CTR implementation
- `src/blob.rs` — Blob encryption/obfuscation for remote staging
- `src/device.rs` — Device identity and key generation
- `src/digest.rs` — SHA-256 hashing utilities
- `src/hmac_utils.rs` — HMAC-SHA256 utilities
- `src/key_derivation.rs` — PBKDF2 key derivation
- `src/random.rs` — Cryptographically secure random generation
- `src/wasm.rs` — WASM-specific bindings and interop
- `tests/integration_test.rs` — Integration tests
- `tests/crypto_test_vectors.json` — Test vectors
- `scripts/` — Build scripts for Android, iOS, WASM

## Local Contracts
- Dependencies: `ring` (crypto primitives), `aes` + `ctr` (AES-CTR mode), `hex`, `base64`, `serde`/`serde_json`
- Feature flags: `wasm` enables WASM bindings via `wasm-bindgen`
- Release profile optimized for size: `opt-level = "z"`, LTO, single codegen unit
- Must produce byte-identical output to Python reference implementation
- Crate types: `lib`, `cdylib`, `staticlib`

## Work Guidance
- All public API exposed through `lib.rs` / WASM bindings
- Test vectors in `crypto_test_vectors.json` must match Python output
- Build WASM with `scripts/build_wasm.sh`
- Keep `ring` version pinned; it's the core crypto primitive provider

## Verification
- `tests/integration_test.rs` — Rust-side integration tests
- `tests/crypto_test_vectors.json` — Cross-implementation test vectors (Python → Rust)
- `phpoc-web/test/crypto_service_smoke.mjs` — WASM smoke tests from JS side
- `phpoc-web/test/wasm_integration.mjs` — End-to-end WASM integration tests

## Child DOX Index
None — flat source structure under `src/`.
