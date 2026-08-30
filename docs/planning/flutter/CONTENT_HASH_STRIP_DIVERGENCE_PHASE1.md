# Flutter `computeContentHash` Strip Divergence — Test Exploration (Phase 1)

> **Plan:** Follow-on to C-2 cross-client verify (`C2_CROSS_CLIENT_VERIFY_PHASE1.md`). Tracked in SESSION_HANDOFF Known Issues.
> **Purpose:** Blueprint of every test assertion needed before fixing the Flutter `computeContentHash` divergence so Flutter-COMPUTED `content_hash` is byte-identical to Python/Web (PHPSPEC §5.5/§6.1 KEEP `_enc` suffix).
> **Status:** ✅ Phase 4 (REFACTOR) COMPLETE — 15/15 tests pass; full suite `+2132`/0 (2 skip)
> **Next Phase:** — (done; remaining C-2 follow-on is CLI Phase A)

---

## 1. Problem

Python (`domain/ledger/chain.py` `_verify_content_hash` canonical branch, `phpoc_cli/migrate_format.py` `_compute_content_hash`) and Web (`phpoc-web/src/ledger/engine.js` `_computeContentHash`) now **KEEP the `_enc` suffix** on decrypted field keys and **keep the decrypted plaintext as a string** (no `json.decode`). PHPSPEC §6.1's `compute_content_hash` pseudo-code does the same (`content[key] = decrypt_fn(value)` — key is `key`, not `key[:-4]`).

Flutter has **three** `computeContentHash` implementations, all of which still diverge:

| Implementation | Used in production? | Strips `_enc` suffix | `json.decode`s plaintext | JSON spacing |
|---|---|---|---|---|
| `helpers.dart` `computeContentHash(Map, CryptoService)` (free fn) | ✅ yes (`engine.dart`, `commonplace_chain.dart`, `rekey_service.dart`) | ❌ **strips** (`keepEncSuffix=false`) | ✅ correct (keeps string) | ✅ `jsonSort` (`": "`, `", "`) |
| `crypto_service.dart` `CryptoService.computeContentHash` (method) | ❌ tests only | ❌ **strips** | ❌ **decodes** (`json.decode`) | ❌ `_canonicalJson` = `json.encode` (no spaces) |
| `crypto_service_native.dart` `CryptoServiceNative.computeContentHash` (method) | ❌ tests only | ❌ **strips** | ✅ correct (keeps string) | ❌ `_toJson` = `json.encode` (no spaces) |

`verifyContentHash` (in `helpers.dart`) already accepts the kept-`_enc` form (2nd attempt, `keepEncSuffix: true`) so a Web/Python-generated chain **verifies** on Flutter today — but Flutter-COMPUTED hashes diverge, so a chain Flutter seals would fail verification on Python/Web and vice-versa.

### Canonical reference (byte-for-byte target)

```python
content = {}
for key, value in entry_data.items():
    if key == "content_hash":
        continue
    if key.endswith("_enc") and value is not None and value != "":
        content[key] = decrypt_fn(value)   # KEEP suffix; plaintext as STRING
    elif isinstance(value, list):
        content[key] = sorted(value)
    else:
        content[key] = value
sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
```

Serialization is Python `json.dumps(sort_keys=True)` → compact **with** `": "` and `", "` separators — exactly what Flutter `json_utils.dart` `jsonSort` emits (NOT Dart `json.encode`, which omits those spaces).

## 2. Architecture Overview

- **`helpers.dart`** — free functions `computeContentHash` / `verifyContentHash` + private `_buildCanonicalMap(data, decryptFn, {keepEncSuffix})`. The production compute path. Fix is one line (`keepEncSuffix: true`) + doc update.
- **`crypto_service.dart`** — pure-Dart shim `CryptoService`. Method `computeContentHash` currently strips + decodes + no-space JSON. Must switch to `jsonSort` from `json_utils.dart` for the content hash specifically (leave `computeEntryHash`'s `_canonicalJson` untouched — out of scope).
- **`crypto_service_native.dart`** — FFI `CryptoServiceNative` (Rust-bound replacement). Method `computeContentHash` strips + no-space JSON. Same fix, via `jsonSort`.
- **Consumers already correct:** `verifyContentHash` accepts kept + stripped + indent2; `chain.dart`/`merge.dart`/`commonplace_chain.dart` call `verifyContentHash` only (no change).

## 3. Test Groups

> Vectors below were computed with Python `LedgerChain._verify_content_hash` (canonical branch, identity decrypt) and cross-checked — they are authoritative cross-client constants. In Dart tests, each `_enc` field's ciphertext is produced by `crypto.encrypt(plaintext, mkHex)` (fixed MK `000102…1d1e1f`), so `decryptWithCachedKey` round-trips to the exact plaintext and the canonical map is deterministic.

### Group A — `helpers.dart` `computeContentHash` (production) — 6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `computeContentHash` KEEPS `_enc` suffix — entry `{duration, metadata_enc:"{}", startTime_enc:"1777028295844", title}` hashes to `6bcdf736…` | Computed hash is canonical (KEEP) form | This is the core divergence; proves the production path emits the kept-suffix map Python/Web expect |
| A2 | JSON-typed `_enc` plaintext (`pauses_enc:"[]"`) stays a string — full entry hashes to `3df78f0a…` | No `json.decode` of decrypted plaintext | `"[]"` must serialize as the string `"[]"`, not an empty list; a decode would change bytes |
| A3 | Plaintext-only entry `{title, duration}` hashes to `fe8dfdbf…` | Non-`_enc` fields included as-is; `content_hash` excluded | Locks the baseline serialization (`jsonSort` spacing) and exclusion of `content_hash` |
| A4 | List field `tags:["b","a","c"]` sorted → hash `77492680…` | Lists sorted deterministically | Cross-client list ordering must match Python `sorted()` |
| A5 | Empty-string `_enc` value (`empty_enc:""`) kept as-is → hash `7fa34bb1…` | Empty `_enc` is not decrypted, suffix retained | Matches Python `value != ""` guard; guards against over-eager decryption |
| A6 | `verifyContentHash(data, computeContentHash(data))` is true | Compute→verify self-consistent after the flip | Confirms the kept-form output verifies through the existing verify path |

### Group B — `CryptoService.computeContentHash` (method) — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Method KEEPS `_enc` suffix → V1 hash `6bcdf736…` | Fix strip divergence in the shim method | Same core fix as A1 for the method API |
| B2 | Method does NOT `json.decode` — `title_enc:"{\"a\":1}"` → hash `e8735024…` | Remove the `json.decode` divergence | `"{\"a\":1}"` must stay a string; decoding to a map changes bytes |
| B3 | Method serializes with `jsonSort` spacing → V4 hash `fe8dfdbf…` | Fix the no-space `json.encode` divergence | Dart `json.encode` omits `": "`/`", "` → wrong hash; must match Python `sort_keys=True` |
| B4 | Method still throws `CryptoException` when no master key cached | Preserve the existing guard | Regression guard — `computeContentHash` requires decrypt key |

### Group C — `CryptoServiceNative.computeContentHash` (FFI method) — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Native method KEEPS `_enc` suffix → V1 hash `6bcdf736…` | Fix strip divergence in the FFI method | Parity with the shim; this is the eventual replacement impl |
| C2 | Native method serializes with `jsonSort` spacing → V4 hash `fe8dfdbf…` | Fix no-space `json.encode` divergence | Same serialization contract as B3 |
| C3 | Native method does NOT `json.decode` — V5 hash `e8735024…` | Confirm plaintext stays string | Guards against regressing to the shim's decode bug |

### Group D — Cross-client byte-parity — 2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | All three Flutter implementations produce the identical hash for the canonical fixture (V2 entry) | Intra-Flutter consistency | One entry → one hash regardless of which compute API is used |
| D2 | V2 fixture hash equals the Python/Web canonical `3df78f0a…` (baked from `chain._verify_content_hash`) | Cross-client byte-parity | Proves Flutter-computed hashes now match what Python/Web compute/verify |

### Group E — No-regression / legacy compatibility — 2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | A legacy STRIP-form hash still verifies via `verifyContentHash` (fallback) | Backward compatibility | Ledgers sealed by pre-fix Flutter carry strip-form `content_hash`; must still verify |
| E2 | Full `flutter test` suite stays green (`~2115`/0) after the compute flip | No regressions in consumers | `engine`/`commonplace_chain`/`rekey_service` compute→verify round-trips must remain consistent |

## 4. Summary

- **Total assertions: 17** (A: 6, B: 4, C: 3, D: 2, E: 2)
- **Fix surface:** `helpers.dart` (1 line + doc), `crypto_service.dart` (method body), `crypto_service_native.dart` (method body) — all converge on `jsonSort` + keep-suffix + no-decode.
- **Out of scope:** `CryptoService.computeEntryHash`'s `_canonicalJson` (entry hash uses `indent=2`, a separate concern); numeric-vs-string list sorting nuance (entry list fields are strings in practice); CLI Phase A; Commonplace web port.

## 5. Canonical vectors (authoritative)

| Label | Entry (plaintext fields; `_enc` = decrypted plaintext) | SHA-256 |
|-------|--------------------------------------------------------|---------|
| V1 | `{duration:598172, metadata_enc:"{}", startTime_enc:"1777028295844", title:"Music Practice - Flute"}` | `6bcdf73697a738fd7412bc6c4cfe8daf5fc4b7167b8dac8a013fe9602b1d26dd` |
| V2 | `{comment:"deep work", duration:3600000, endTime_enc:"1714003600000", pauses_enc:"[]", startTime_enc:"1714000000000", tags:["focus","work"], title:"Coding"}` | `3df78f0abccaf7b9fdf0b504a1d205d91561420782791869642f4792e23169f9` |
| V3 | `{duration:1800000, media:[], tags:["a","b","c"], title:"Reading"}` | `77492680df22b4a852d2b7dacfc350275a02b08c3f32171087fd9412012f1708` |
| V4 | `{duration:1000, title:"Test"}` | `fe8dfdbf3f76aa2fa466cdcaa628343b87f9081c67c73db8dd35759a2c62d0f1` |
| V5 | `{duration:5, title_enc:"{\"a\":1}"}` | `e87350241d5e578af9fc632cd23492ee09245e39f96ecfacb0ef6aab2f6e7943` |
| V6 | `{duration:1, empty_enc:"", title:"X"}` | `7fa34bb1e3ef6a5d23c6d2a05b6d97358d1be0ddff8dc557f9f8c8d0a6eadfb8` |
