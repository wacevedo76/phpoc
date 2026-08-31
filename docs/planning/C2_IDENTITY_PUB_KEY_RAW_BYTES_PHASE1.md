# C-2 `identity_pub_key` Raw-Bytes Parity — Test Exploration (Phase 1)

> **Task:** C-2 `identity_pub_key` raw-bytes parity (Web + Flutter follow-up)
> **Roadmap:** `C2_SEED_REKEY_WEB_CLI_ROADMAP.md` (R6 follow-up) · `WEB_FLUTTER_PARITY_SPEC.md` §P2
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ **Phase 4 (REFACTOR) COMPLETE (2026-08-31)** — all 29 assertions GREEN across Rust/Web/Flutter/Python; raw-bytes `identity_pub_key` implemented end-to-end, WASM rebuilt, call sites switched, cross-client fixtures regenerated (`271a413b…` → `9a2db2e2…`).
> **Next Phase:** — (done)

## Architecture Overview

Canonical derivation (PHPSPEC §2.7.1, Rust `digest.rs::identity_pub_key`, Python `core/factory.py`):

```
identity_pub_key = SHA-256(raw 32-byte identity_secret).hexdigest()   # 64-char hex
```

**The bug:** Web and Flutter only expose `sha256(String)` (UTF-8) through their FFI, so they hash the
*hex string* of the secret instead of its raw bytes. Web `chain.js:289` (`this.crypto.sha256(identitySecret)`)
and the Flutter crypto surface (`crypto_service.dart`/`crypto_service_native.dart` → `sha256`) both
diverge. The identity secret is held as a 64-char hex string everywhere, so the fix is to add a
**raw-bytes** `identity_pub_key(identity_secret_hex)` binding that hex-decodes → SHA-256 → hex, then
switch the genesis call sites and regenerate the cross-client fixtures.

**Layering (how each client actually runs):**

| Layer | Web | Flutter |
|---|---|---|
| Rust core | `wasm.rs` (wasm-bindgen) | `frb.rs` (contract ref — **not** compiled; `lib.rs` doesn't declare `mod frb`) |
| Generated/bridge | `pkg/*` → copied to `src/crypto/wasm/*` | `frb_generated.dart` (hand-written pure-Dart shim, the **actual** runtime) |
| Wrapper | `src/crypto/index.js` `CryptoService` | `crypto_service.dart` (pure-Dart) + `crypto_service_native.dart` (→ `frb_generated.dart`) |
| Call site | `src/ledger/chain.js:289` | none in production (genesis builder takes `identityPubKey` as a param) |

**Important scope facts:**
- **New-genesis-only.** The value feeds the per-user PDK salt (`SHA-256(identity_pub_key_hex)[:16]`,
  PHPSPEC §2.4), but genesis itself uses the fixed `session-salt` — the per-user salt is adopted on the
  first post-init auth. Re-key **preserves** `identity_pub_key` (key-independent); it is never re-derived.
- **`frb_generated.dart` is hand-written**, not `flutter_rust_bridge_codegen`-generated. "Regen FRB
  bindings" = update `frb.rs` (contract) + `frb_generated.dart` (pure-Dart) + the two Dart wrappers.
  There is no codegen step to run for the Dart side in this repo today.
- **`frb_generated.rs`** is a 147-line stub gated behind `#[cfg(feature = "wasm")]`; it references no
  `frb.rs` functions and needs no change.

### Canonical test vector

Fixture identity secret is `IDENTITY_SECRET = 'ab'.repeat(32)` (64-char hex, 32 raw bytes `0xAB`).

| Derivation | Value |
|---|---|
| `sha256(raw 32×0xAB)` — **canonical** | `9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885` |
| `sha256(hex-string "abab…")` — divergent | `271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a` |

The committed fixtures (`testdata/c2_cross_client_fixture.json`, `c2_web_rekeyed_wire.json`,
`c2_flutter_rekeyed_wire.json`) currently encode the **divergent** `271a413b…` because their builders
call `sha256(identitySecret)`. They must be regenerated with the raw-bytes `9a2db2e2…`.

## Test Groups

### Group A — Rust crypto core (raw-bytes binding + known-answer vectors) — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `digest::identity_pub_key(&[0xAB; 32])` returns `9a2db2e2…` | Known-answer for the raw-bytes primitive | Locks the canonical vector at the source of truth |
| A2 | WASM `identity_pub_key('ab'*32)` returns `9a2db2e2…` | Raw-bytes binding decodes hex → 32 bytes → SHA-256 | The web-visible binding must hash raw bytes, not the string |
| A3 | WASM `identity_pub_key` rejects non-hex / odd-length input (JsValue error) | Input validation | Prevents silent mis-hash on malformed hex |
| A4 | WASM `identity_pub_key` rejects ≠32-byte hex (JsValue error) | Length guard | `identity_secret` is defined as exactly 32 bytes |
| A5 | FRB `identity_pub_key(String)` mirrors A2–A4 via `CryptoError` | Flutter-side Rust contract | `frb.rs` must expose the same raw-bytes semantics |
| A6 | `cargo build` + `cargo test` GREEN | Rust regressions | `frb.rs`/`wasm.rs`/`digest.rs` compile cleanly |

### Group B — Web (WASM surface + genesis call site) — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `CryptoService.identityPubKey('ab'*32)` == `9a2db2e2…` and ≠ `CryptoService.sha256('ab'*32)` (`271a413b…`) | Wrapper exposes raw-bytes, distinct from string-hash | Proves the two operations are not conflated |
| B2 | `chain.js buildGenesisBlock` sets `identity.identity_pub_key` == `identityPubKey(identitySecret)` | Genesis call site switched | The production genesis now emits canonical raw-bytes pubkey |
| B3 | `identityPubKey` throws a normalized `Error` on invalid hex | Error surfacing | `#call1` error normalization covers the new binding |
| B4 | Web fixture builders (`c2_fixture_gen.mjs` + `rekey_service_web_test.mjs` `buildGenesis`) use `identityPubKey` | Fixture source fixed | The cross-client fixture must be generated canonically |
| B5 | Regenerated `testdata/c2_cross_client_fixture.json` genesis `identity.identity_pub_key` == `9a2db2e2…` | Committed fixture updated | The shared fixture is the cross-client contract |
| B6 | Re-keyed wire artifact preserves the raw-bytes pubkey (invariant across re-key) | Identity stability | `identity_pub_key` is key-independent; re-key must not re-derive it |

### Group C — Flutter (crypto surface + parity) — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `CryptoService.identityPubKey('ab'*32)` == `9a2db2e2…` | Pure-Dart shim implements raw-bytes | Tests run against `CryptoService` (shim), so it must be correct |
| C2 | `CryptoServiceNative.identityPubKey` (via `frb_generated.dart`) == `9a2db2e2…` | Native wrapper + pure-Dart bridge | Production FFI path uses `frb_generated.dart` |
| C3 | `identityPubKey` throws `CryptoException` on invalid hex / wrong length (both backends) | Input validation | Matches WASM/FRB error contract |
| C4 | Web `identityPubKey` == Flutter `identityPubKey` == Python `hashlib.sha256(raw).hexdigest()` (shared vector) | Three-way parity | The actual cross-client invariant this task is about |
| C5 | Flutter C5 (`c2_cross_client_verify_test.dart`) asserts `identity_pub_key == c.identityPubKey(identitySecret)` | Parity test switched off `sha256(String)` | The old C5 locked in the divergent hex-string value |
| C6 | Flutter re-key preserves `identity_pub_key` (no re-derivation) | Regression guard | Re-key is key-independent; must not recompute the pubkey |

### Group D — D5 parity test extension + cross-client verify — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Web C5 extended: `identity.identity_pub_key == crypto.identityPubKey(IDENTITY_SECRET)` | Web derivation assertion | Web previously asserted only "invariant", never "derived correctly" |
| D2 | `crypto.identityPubKey(IDENTITY_SECRET)` == `9a2db2e2…` cross-checked against Flutter's | Web↔Flutter fixed-vector parity | Both clients agree on the same literal bytes |
| D3 | `c2_cli_verify_test.dart` D5 remains GREEN (already raw-bytes) | CLI↔client regression | Guards the already-correct CLI leg against drift |
| D4 | Full Web↔Flutter hermetic matrix GREEN both directions after fixture regen | Cross-client integrity | Seal/entry-hash/content_hash must stay valid under the regenerated fixtures |
| D5 | `derive_pdk_with_salt(passphrase, sha256(pubkey)[:16])` deterministic and identical across clients | PDK-salt derivation parity | The pubkey feeds the salt; both clients must derive the same per-user salt |

### Group E — Regression guards + docs — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Python suite GREEN (`python3 -m pytest tests/`) | Python regression | Python is already correct; no silent breakage |
| E2 | Web suite GREEN (`node --test` + `npx vitest run`) | Web regression | WASM rebuild must not break the 79-file web suite |
| E3 | Flutter suite GREEN (`flutter test`, ~2115) | Flutter regression | Shim + wrapper additions must not break Dart tests |
| E4 | Rust suite GREEN (`cargo test`) | Rust regression | `digest.rs` known-answer + integration vectors |
| E5 | PHPSPEC §2.7.1 notes the raw-bytes `identity_pub_key` helper on Web/Flutter | Spec clarity | The spec is already raw-bytes; add the cross-client helper note |
| E6 | SESSION_HANDOFF / BACKLOG / MAP / C2 roadmap updated | Doc impact contract | Durable docs reflect the fix |

## Summary

- **Total assertions:** ~29 across groups A–E.
- **Key coverage areas:** Rust raw-bytes binding (A), Web WASM + genesis (B), Flutter shim + parity (C),
  D5 parity + cross-client verify (D), regression + docs (E).
- **Fixed-vector anchor:** `sha256(0xAB×32) = 9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885`.
- **Regeneration required:** WASM `pkg/*` → `phpoc-web/src/crypto/wasm/*`; `frb_generated.dart` (hand-written);
  the three `testdata/c2_*.json` cross-client fixtures (from `271a413b…` → `9a2db2e2…`).
