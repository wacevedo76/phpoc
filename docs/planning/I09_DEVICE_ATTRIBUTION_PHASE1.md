# I-09: Hardware-Bound Device Attribution — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §Phase 4 — I-09
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1-4 complete
> **Next Phase:** N/A (complete)

## Problem Summary

Device IDs must uniquely identify a physical device, not be a deterministic function of the master key (MK) alone. With MK-derived IDs, every device with the same passphrase appears as the same device, breaking multi-device sync and attribution.

**Current state (pre-I-09):**
- Python `device_identity.py`: `device_id = UUID4` (random, decoupled from MK). Proof = HMAC(MK, "phpoc:device:" + UUID4). ✅ UUID4 is device-local, ✅ not MK-derived, ❌ device_id has no cryptographic binding to MK.
- JS `device_uuid.js`: `device_id = crypto.randomUUID()` (random). ✅ UUID4 is device-local, ✅ not MK-derived, ❌ same gap as Python. `sync.js._getDeviceId()` has a legacy fallback to WASM `getDeviceId(MK)` — a code smell.
- Rust `device.rs`: `get_device_id(MK)` = HMAC(MK, "device:id") — purely MK-derived. ❌ Legacy, should not be invoked on the happy path.

**Target (I-09):**
`device_id = HMAC-SHA256(MK, "phpoc:device:" + device_local_secret)` where `device_local_secret` is a UUID4 generated on first run and persisted in config/IndexedDB. This binds the device ID to both the MK and a per-device random secret.

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  device_local_secret (UUID4)                         │
│  - Generated on first auth                          │
│  - Persisted in config (PY) / IndexedDB (JS)        │
│  - Never leaves the device                          │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  device_id = HMAC(MK, "phpoc:device:" + secret)     │
│  - 64-char hex                                       │
│  - Unique: different device + same MK → different ID │
│  - Bound: same device + different MK → different ID  │
│  - Client suffix: -cli (PY) / -web (JS)              │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  device_proof = HMAC(MK, "phpoc:device:" + id)      │
│  - Unchanged formula                                 │
│  - Now doubly-bound: MK is in both id and proof      │
└─────────────────────────────────────────────────────┘
```

**Files to touch:**
- `security/device_identity.py` — new `derive_device_id()`, updated `get_device_identity()`
- `security/auth.py` — `_ensure_device_local_secret()` generation + persistence
- `domain/cookie/device_cookie.py` — transparent (uses device_id from provider)
- `phpoc-web/src/sync/device_uuid.js` — `deriveDeviceId()`, `getOrCreateDeviceSecret()`
- `phpoc-web/src/sync/sync.js` — `_getDeviceId()` removes WASM fallback
- `phpoc-web/src/crypto/index.js` — `deriveDeviceId()` WASM wrapper
- `phpoc-crypto-core/src/device.rs` — `derive_device_id(mk, secret)`
- `phpoc-crypto-core/src/wasm.rs` — WASM binding

## Test Groups

### Group A: Python — device_local_secret generation & persistence (~5 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `_ensure_device_local_secret()` generates a valid UUID4 on first call | Verifies the secret is a standards-compliant UUID4 | UUID4 guarantees uniqueness across devices |
| A2 | Generated secret is persisted in config under `device_local_secret` key | Confirms the secret survives process restarts | Without persistence, every restart would generate a new secret → different device_id |
| A3 | Subsequent calls read from config — same secret returned | Idempotency and stability of device identity | The whole point is a stable per-device identity |
| A4 | Secret survives `PassphraseAuthenticator` recreation | Real-world scenario: new process reads config, gets same secret | Auth objects are recreated on every CLI invocation |
| A5 | Config write failure is logged but does not crash | Graceful degradation when ~/.config is read-only | Must not block auth because of a non-critical persistence failure |

### Group B: Python — device ID derivation (`device_identity.py`) (~10 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `derive_device_id(mk, secret)` returns 64-char hex string | Correct output format | HMAC-SHA256 always produces 64 hex chars |
| B2 | Deterministic: same (mk, secret) → same device_id every time | Predictable identity for the same device+key combo | Without determinism, device_id would change on every call |
| B3 | Different MK + same secret → different device_id | Device ID is bound to the master key | Key rotation must change device identity |
| B4 | Different secret + same MK → different device_id | Device ID is bound to the per-device secret | Different devices with same passphrase must get different IDs |
| B5 | `get_device_identity()` derives device_id from MK + device_local_secret (not pure UUID4) | Core behavioral change: device_id is now HMAC, not UUID4 | This is the whole point of I-09 |
| B6 | Resulting `device_id` includes client-type suffix (`-cli`) | Bug 3a fix preserved: CLI and web have distinct identities | Without suffix, CLI and web on the same machine could clash |
| B7 | Identity is cached across calls within same session | Performance: avoid recomputing HMAC | `_cached_identity` already exists — must still work |
| B8 | `verify_device_proof()` works with new HMAC-derived device_id | Cross-device proof verification still functions | Proof formula is unchanged but device_id format changed |
| B9 | `check_remote_identity()` works with new HMAC-derived device_id | Remote blob attribution still works | Uses same verification path |
| B10 | device_id changes when MK rotates (key_version bump) | Device identity is re-bound after rotation | I-01 compatibility: rotation must produce new device IDs |

### Group C: Python — migration from bare UUID4 to device_local_secret (~4 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Existing bare UUID4 in config migrated to `device_local_secret` | No data loss for existing installs | Users upgrading must not lose their device identity |
| C2 | device_id recomputed from MK + migrated secret on first post-migration auth | The new derivation applies immediately | Migration should be transparent, not require user action |
| C3 | Existing `device_label` and other config keys preserved | No collateral config damage | Migration must be surgical — only touch device identity fields |
| C4 | Fresh install (empty config) generates new `device_local_secret` | First-run path works | Must not require migration code to run on new installs |

### Group D: Python — device cookie integration (~3 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `DeviceCookie.create()` receives the new HMAC-derived device_id | Cookie uses correct device identity | Cookie pushes device_uuid to remote — must be the new format |
| D2 | Remote cookie format (`device_uuid` + `device_specifier`) unchanged | Backward compatibility with existing remote cookies | Remote format is a contract — must not break |
| D3 | Cookie specifier remains random (not derived from MK or device_id) | Specifier is the fast-path auth check, must stay random | Regressing specifier to deterministic would weaken fast-path auth |

### Group E: JS — device_local_secret (`device_uuid.js`) (~7 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `getOrCreateDeviceSecret(storage)` generates UUID4 on first call | JS-side secret generation matches Python behavior | Cross-client parity |
| E2 | Secret persisted in storage under `device_local_secret` key | Survives page refresh | IndexedDB persistence is the JS equivalent of config |
| E3 | Secret survives logout (separate from session data) | Secret must outlive auth sessions | Should not be cleared when user logs out |
| E4 | `deriveDeviceId(mk, secret)` returns 64-char hex via WASM | JS can compute the new device_id | Uses WASM for crypto correctness |
| E5 | Deterministic: same (mk, secret) → same device_id | Parity with Python B2 | Cross-platform determinism is critical |
| E6 | Different MK → different device_id | Parity with Python B3 | Key rotation changes identity |
| E7 | Different secret → different device_id | Parity with Python B4 | Different devices get different IDs |

### Group F: JS — migration from existing UUID formats (~4 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Bare UUID4 in storage → becomes `device_local_secret`, device_id recomputed from MK | Upgrade path for existing web installs | Users with existing data must not break |
| F2 | WASM-derived hex UUID in storage → fresh `device_local_secret` generated, device_id recomputed | Clean migration from the old MK-derived format | Old hex UUIDs are not valid secrets |
| F3 | Already-suffixed UUID (`*-web`) → core UUID extracted as secret, device_id recomputed | Handles Bug 3a suffix migration + I-09 in one step | Users with suffixed UUIDs need the same upgrade |
| F4 | Client suffix (`-web`) appended to new device_id | Bug 3a fix preserved | CLI/web distinction must survive the migration |

### Group G: JS — `sync.js` integration (~6 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `_getDeviceId()` returns HMAC-derived device_id from MK + device_local_secret | Core behavioral change in JS | SyncService uses device_id for blob headers |
| G2 | `_getDeviceId()` does NOT fall back to WASM `getDeviceId(MK)` when device_local_secret is missing | Removes the legacy MK-only derivation path | The WASM fallback is the exact bug I-09 fixes |
| G3 | `_getDeviceId()` returns null when MK is unavailable (not yet authenticated) | Graceful pre-auth state | No crash when called before user unlocks |
| G4 | device_id changes after simulated key rotation | I-01 compatibility in JS | Rotation must produce new device IDs on the web side too |
| G5 | `pushBlobOnly()` receives correct device_id | Blob headers carry correct identity | Remote must know which device pushed |
| G6 | `pushToRemote()` receives correct device_id | Same as G5 for the full push path | Both push paths must use the new derivation |

### Group H: Rust/WASM — `derive_device_id()` (~5 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `derive_device_id(mk, secret)` returns 64-char hex (HMAC-SHA256) | Correct Rust implementation | Core crypto must be right |
| H2 | Deterministic: same inputs → same output | Same as B2/E5 for Rust | All platforms must agree |
| H3 | Cross-platform: Rust output matches Python `derive_device_id()` byte-for-byte | Interop between CLI (Python) and web (WASM) | The device_id computed by CLI must match what web computes |
| H4 | Legacy `get_device_id(MK)` still compiles and works (backward compat) | Existing callers not broken | Deprecation, not deletion — other code may still reference it |
| H5 | WASM binding `derive_device_id(mk_hex, secret)` returns same result as native Rust | WASM bridge works correctly | The web crypto service must produce correct results |

### Group I: Edge cases (~5 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Empty/None MK raises `ValueError` | Input validation | Must not silently produce garbage |
| I2 | Empty/None secret raises `ValueError` | Input validation | HMAC with empty key material is undefined |
| I3 | Config read failure → generate new secret (best-effort) | Resilience when ~/.config is corrupted | Better to get a new identity than to crash |
| I4 | Corrupted secret (not valid UUID4) → regenerate | Self-healing | Invalid secret is as bad as no secret |
| I5 | Short MK (< 32 bytes) raises `ValueError` | Input validation | AES-256 requires exactly 32-byte keys |

---

## Summary

| Group | Area | Assertions |
|-------|------|-----------|
| A | PY: device_local_secret generation | 5 |
| B | PY: device_id derivation | 10 |
| C | PY: migration | 4 |
| D | PY: cookie integration | 3 |
| E | JS: device_local_secret | 7 |
| F | JS: migration | 4 |
| G | JS: sync.js integration | 6 |
| H | Rust/WASM: derive_device_id | 5 |
| I | Edge cases | 5 |
| **Total** | | **49** |

**Coverage areas:**
- ✅ Device-local secret generation (PY + JS)
- ✅ Device ID derivation from MK + secret (PY + JS + Rust)
- ✅ Migration from existing UUID formats (PY + JS)
- ✅ Cookie integration (PY)
- ✅ SyncService integration (JS)
- ✅ WASM cross-platform parity
- ✅ Key rotation compatibility (PY + JS)
- ✅ Edge cases: missing/corrupted/empty inputs
