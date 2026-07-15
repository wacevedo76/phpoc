# I-11: Blob Obfuscation Portability Warning + Test Vectors — Phase 1

> **Plan:** BACKLOG.md I-11
> **Purpose:** Blueprint of all needed assertions before writing test vector / spec changes.
> **Status:** ✅ Phase 2 (RED: test definition)
> **Next Phase:** Phase 3 (GREEN: implementation + spec warning)

## Architecture Overview

Blob obfuscation (§8.5) pads serialized staging JSON to a fixed-size tier (64K, 128K, 256K, 512K) with random bytes, then encrypts with a derived sub-key (`HMAC(MK, "blob-obfuscation")[:16]`). This is the **highest-risk primitive for cross-platform interop** because three implementations (Python stdlib, Rust `ring`, JS WASM) must produce byte-identical output for the same inputs.

Current gaps:
- **No portability warning** in PHPSPEC.md §8.5 — implementers may assume the scheme is straightforward
- **No deterministic test vectors** for edge cases — existing test vectors say "non-deterministic" and only test happy-path roundtrips
- **No edge case coverage** — empty blob, tier ceiling, and class transition are untested in test vectors

## Test Groups

### Group A: Spec Warning — PHPSPEC.md §8.5 (4 assertions)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | §8.5 "Blob Obfuscation" subsection contains a portability hazard callout | Ensures implementers see the warning at the most relevant location | CROSS_PLATFORM §3 says blob obfuscation is highest-risk; the spec must reflect that |
| A2 | Warning uses ⚠️ indicator for visual prominence | Scannability — implementers scanning the spec can find critical hazards quickly | Pattern established in Known Limitations section; consistent UX |
| A3 | Warning identifies blob obfuscation as "highest-risk primitive for cross-platform interop" | Communicates severity explicitly | Generic "watch out" doesn't convey the real risk |
| A4 | Warning mandates validation against the crypto test vector suite | Gives implementers a concrete action | "Be careful" without a verification path is not actionable |

### Group B: Tier Selection Edge Cases — Test Vectors (6 assertions)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Empty blob (0 bytes) → tier 64K | Ensure empty staging blobs obfuscate correctly | Edge case: zero-length plaintext could cause underflow in padding arithmetic |
| B2 | Exactly 64KB (65536 bytes) → tier 64K | Ensure tier ceiling is inclusive | Off-by-one error here would cause unnecessary 128K padding for legitimate 64K blobs |
| B3 | 64KB + 1 byte → tier 128K (class transition) | Verify class transition triggers correctly | Threshold crossing is the most likely interop bug — different implementations may use `<` vs `<=` |
| B4 | 127999 bytes → tier 128K | Verify second-byte-below ceiling still stays in 128K tier | Edge case near but not at the boundary |
| B5 | Exactly 512KB → tier 512K | Verify max tier handles exact-fit correctly | The upper boundary of the entire scheme — must not overflow |
| B6 | 512KB + 1 byte → error (exceeds max tier) | Verify overflow is handled gracefully | Both implementations must agree on the error condition |

### Group C: Roundtrip Edge Cases — Test Vectors (5 assertions)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Empty blob roundtrip: obfuscate → deobfuscate → original empty string | Validates empty-blob full flow across implementations | Padding logic for 0-byte input must not corrupt the length prefix |
| C2 | Exactly-at-64K-ceiling roundtrip | Validates no-padding-needed case through full encrypt/decrypt | When plaintext fills the tier exactly, padding_needed=0 — a path some implementations might skip incorrectly |
| C3 | Class transition (64K→128K) roundtrip | Validates full flow through tier upgrade | Confirms the length prefix survives AES-CTR encryption at the larger size |
| C4 | Non-ASCII Unicode plaintext roundtrip | Validates UTF-8 handling through AES-CTR | AES-CTR operates on bytes, but serialization (JSON) must handle Unicode correctly |
| C5 | Plaintext near 512K limit (524280 bytes) roundtrip | Validates near-max-size full flow | Stress test for the largest tier; padding_needed=8 bytes (minimal padding) |

### Group D: Deterministic Cross-Platform Test Vectors (4 assertions)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Fixed salt + nonce + master_key + plaintext → deterministic expected ciphertext | Single source of truth for byte-level correctness | Without deterministic vectors, two implementations can both "roundtrip" but produce incompatible wire formats |
| D2 | D1 verification passes on Python implementation | Confirms Python produces correct output | CLI reference implementation is the authority |
| D3 | D1 verification passes on Rust/WASM implementation | Confirms WASM produces byte-identical output | Web client must interoperate with CLI-produced blobs |
| D4 | Deobfuscation of D1 output returns original plaintext | Confirms the deterministic output is also decryptable | Guards against "encrypts correctly but can't decrypt" bugs |

### Group E: Blob Key Derivation — Test Vectors (2 assertions)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `derive_blob_key(mk)` produces deterministic output for fixed master_key | Ensures key derivation is cross-platform consistent | If the sub-key derivation differs, AES will produce different ciphertext even with same salt/nonce |
| E2 | `derive_blob_key(mk)` output is 16 bytes | API contract check | Encryption key must be exactly 16 bytes for AES-128-CTR |

---

## Summary

| Group | Name | Count |
|-------|------|-------|
| A | Spec Warning (PHPSPEC.md §8.5) | 4 |
| B | Tier Selection Edge Cases | 6 |
| C | Roundtrip Edge Cases | 5 |
| D | Deterministic Cross-Platform Vectors | 4 |
| E | Blob Key Derivation | 2 |
| **Total** | | **21** |

### Files Expected to Change

| Phase | File | Type |
|-------|------|------|
| 2 (RED) | `tests/data/crypto_test_vectors.json` | New — deterministic blob test vectors |
| 2 (RED) | `phpoc-crypto-core/tests/crypto_test_vectors.json` | Modify — expand blob_obfuscation array |
| 2 (RED) | `tests/test_blob_obfuscation_vectors.py` | New — Python test that validates against vectors |
| 2 (RED) | `phpoc-crypto-core/src/blob.rs` | Modify — add deterministic obfuscation test helper |
| 3 (GREEN) | `docs/spec/PHPSPEC.md` §8.5 | Modify — add portability warning |
| 3 (GREEN) | `domain/staging/remote_sync.py` | Modify — add deterministic obfuscation entry point |
| 3 (GREEN) | PHP/Core + Web tests | Modify — implement vector validation |

### Key Coverage Areas
- **Spec documentation:** One paragraph warning, placed at the start of the Blob Obfuscation subsection
- **Tier logic:** 0 bytes, ceiling-exact, one-byte-over, near-max — all deterministic
- **Roundtrips:** Empty, ceiling, transition, Unicode, near-max — non-deterministic (roundtrip only)
- **Deterministic verification:** Fixed-salt fixed-nonce vectors that both Python and Rust can reproduce byte-for-byte
