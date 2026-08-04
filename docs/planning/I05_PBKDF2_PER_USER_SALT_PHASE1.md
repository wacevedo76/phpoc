# I-05: Per-User PBKDF2 Salt — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §I-05
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

Currently PBKDF2 uses a fixed salt `b"session-salt"` for all PDK derivations. This enables cross-user rainbow tables when passphrases are reused. The fix: derive a per-user salt from `identity_pub_key`:

```
salt = SHA-256(hex_pub_key_bytes)[:16]
PDK  = PBKDF2-HMAC-SHA256(passphrase, salt, 600000, 32)
```

**Key challenge:** During `ph init`, no `identity_pub_key` exists yet (it's generated inside `LedgerFactory.initialize()`). So init must continue using the old salt, and the **first authentication after init** will transparently upgrade the seed encryption to the new salt.

**Backward compat flow** during `PassphraseAuthenticator.authenticate()`:
1. Read `identity_pub_key` from genesis block
2. Derive per-user salt: `SHA-256(pub_key_bytes)[:16]`
3. Try PDK combos in priority order:
   - a. new salt + 600K → decrypt seed
   - b. new salt + 100K → decrypt seed
   - c. old salt `b"session-salt"` + 600K → decrypt seed
   - d. old salt `b"session-salt"` + 100K → decrypt seed
4. If (c) or (d) succeeded → transparent upgrade: re-derive PDK with new salt (600K), re-encrypt seed, write back genesis
5. If (a) or (b) succeeded → already using new salt, no upgrade needed

**Modules affected:**
- `security/auth.py` — `PassphraseAuthenticator.authenticate()` + new `derive_pdk_salt()` helper
- `core/factory.py` — init flow (uses old salt, relies on first-auth upgrade)
- `phpoc_cli/onboarding.py` / `phpoc_cli/onboarding_file.py` — passphrase setting paths
- `scripts/change_passphrase.py` — standalone passphrase changer
- `phpoc-crypto-core/` — `derive_pdk()` needs salt parameter
- `phpoc-web/` — `derivePdk()` needs salt parameter; call sites need pub_key → salt
- `docs/spec/PHPSPEC.md` §2.4 — document per-user salt derivation

---

## Test Groups

### Group A: Salt derivation function — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `derive_pdk_salt(identity_pub_key)` returns 16 bytes | Verifies correct output length | Salt must be exactly 16 bytes for PDK derivation |
| A2 | Same `identity_pub_key` → deterministic output | Ensures reproducible PDK | Must always produce the same salt for the same user |
| A3 | Different `identity_pub_key` → different salts | Verifies per-user uniqueness | The whole point of this fix |
| A4 | Output matches `hashlib.sha256(pub_key.encode()[:64]).digest()[:16]` | Exact algorithm conformance | Cross-platform interop depends on identical salt derivation |
| A5 | Empty/None `identity_pub_key` raises clear error | Defensive coding | Callers must provide a valid pub_key; silent fallback would hide bugs |

### Group B: Auth — multi-salt trial with 4-combo fallback — 10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Auth with new-salt 600K PDK succeeds when seed encrypted with same | Happy path: new format | Primary auth flow after this change |
| B2 | Auth with new-salt 100K PDK succeeds for legacy pre-R3 genesis | Legacy iteration count with new salt | Some ledgers have seeds encrypted with 100K PDK |
| B3 | Auth with old-salt 600K PDK succeeds (existing ledgers) | Backward compat: old salt | All existing ledgers use `b"session-salt"` + 600K |
| B4 | Auth with old-salt 100K PDK succeeds (legacy) | Backward compat: old salt + old iterations | Pre-R3 ledgers with `b"session-salt"` + 100K |
| B5 | Old-salt success → transparent upgrade: seed re-encrypted with new salt | Auto-migration on first auth | Ledgers must be upgraded without user action |
| B6 | After upgrade, subsequent auth succeeds with new-salt PDK only | Migration is one-time and permanent | Ensures upgrade is durable |
| B7 | Wrong passphrase fails across all salt/iteration combos | Auth still rejects bad passwords | Must not introduce false-positive auth |
| B8 | No ledger exists → uses old salt `b"session-salt"` (init case) | Init flow compatibility | No `identity_pub_key` to derive from |
| B9 | Cached session key verification works regardless of salt used | Session cache still valid | Cached MK bypasses PDK derivation entirely |
| B10 | Auth with old-salt 100K legacy → upgrades to new-salt 600K | Legacy-to-current transition | Upgrade should use current (600K) iterations |

### Group C: Init flow — seed encryption compatibility — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `Factory.initialize()` encrypts seed with old-salt PDK | Init uses old salt (no pub_key yet) | Chicken-and-egg: pub_key not generated until init completes |
| C2 | Init creates genesis with valid `identity_pub_key` field | Pub_key exists after init | Required for subsequent auth to derive per-user salt |
| C3 | First auth after init succeeds via old-salt path, then upgrades | End-to-end init → auth → upgrade | The full init-to-upgrade cycle |
| C4 | After first-auth upgrade, second auth uses new salt | Upgrade is persisted | Auth path works after upgrade |
| C5 | `Factory.initialize()` returns valid seed | Existing contract preserved | No behavioral regression |

### Group D: Passphrase change & recovery — 6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `_recover_ledger()` derives new PDK with per-user salt from genesis `identity_pub_key` | Onboarding re-encrypts with new salt | `phpoc_cli/onboarding.py` sets new passphrase during import |
| D2 | `_set_passphrase()` in `phpoc_cli/onboarding_file.py` uses per-user salt | File import passphrase set | Same fix needed in file onboarding path |
| D3 | `scripts/change_passphrase.py` uses per-user salt | Standalone passphrase changer | External script must also use new salt |
| D4 | Changing passphrase with old-salt ledger → seed encrypted with new salt | Upgrade during passphrase change | Any passphrase change is an opportunity to upgrade |
| D5 | Recovery flow (ph recover) uses per-user salt for new seed encryption | Recovery compatibility | Recovery reads passphrase and re-encrypts seed |
| D6 | Passphrase change with already-upgraded ledger → continues using new salt | No regression for already-upgraded | Must not revert to old salt |

### Group E: Spec documentation — 2 items

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | PHPSPEC §2.4 documents salt as `SHA-256(identity_pub_key)[:16]` not `b"session-salt"` | Spec matches implementation | Spec is the source of truth |
| E2 | PHPSPEC §2.4 removes "fixed salt is fine" rationalization note | No misleading guidance | Current spec explicitly says per-user salt is unnecessary — incorrect after this fix |

### Group F: Rust crypto core (phpoc-crypto-core) — 6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `derive_pdk(passphrase, salt, iterations)` accepts custom salt | New API signature | Core primitive must support per-user salt |
| F2 | Same passphrase + same salt → deterministic PDK | Determinism | Cross-platform interop depends on this |
| F3 | Same passphrase + different salt → different PDK | Salt isolation | The whole point — different users get different PDKs |
| F4 | `derive_pdk("test", b"session-salt", Standard)` matches old behavior | Backward compat for callers passing old salt | Old salt must still work for init flow |
| F5 | Legacy iterations (100K) still work with custom salt | Pre-R3 genesis support | 100K fallback must combine with any salt |
| F6 | WASM binding `derive_pdk(passphrase, salt_hex, iterations)` exposed | Web client can pass salt | JS side needs to call into WASM with salt |

### Group G: Web client — 6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `CryptoManager.derivePdk(passphrase, salt, iterations)` passes salt to WASM | JS API update | Web PDK derivation must accept salt |
| G2 | `authenticate()` in DevModeContext derives salt from `identity_pub_key` in genesis | Web auth flow | Primary web authentication path |
| G3 | `performReauth()` in `reauth.js` derives salt from pub_key | Web reauth flow | Re-auth after unlock uses same salt derivation |
| G4 | `export_auth.js` PBKDF2 derives PDK with per-user salt | Export auth path | Export passphrase verification uses PDK |
| G5 | `createLedger()` (init) uses old salt `"session-salt"` | Web init: no pub_key yet | Same chicken-and-egg as Python init |
| G6 | Web auth with old-salt seed → transparent upgrade to new salt | Web backward compat | Mirror of Python B5 |

### Group H: Integration / cross-platform — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Full: Python init → auth with new salt → verify chain integrity | End-to-end Python | Prove the full flow works |
| H2 | Existing old-salt Python ledger → auth → upgrade → re-auth → verify | Python upgrade cycle | Prove transparent upgrade doesn't break anything |
| H3 | Python and WASM produce identical PDK with same (passphrase, salt, iterations) | Cross-platform PDK match | Rust and Python PBKDF2 must agree |

---

## Summary

| Group | Name | Tests |
|-------|------|-------|
| A | Salt derivation function | 5 |
| B | Auth — multi-salt trial + upgrade | 10 |
| C | Init flow compatibility | 5 |
| D | Passphrase change & recovery | 6 |
| E | Spec documentation | 2 |
| F | Rust crypto core | 6 |
| G | Web client | 6 |
| H | Integration / cross-platform | 3 |
| **Total** | | **43 assertions** |

**Key coverage areas:**
- Salt derivation correctness and per-user uniqueness (A)
- 4-combo trial auth with backward compat and transparent upgrade (B)
- Init flow chicken-and-egg handling (C)
- All passphrase-change code paths use new salt (D)
- Spec updated to reflect new behavior (E)
- Rust/WASM core supports dynamic salt (F)
- Web client mirrors Python behavior (G)
- Cross-platform PDK agreement (H)
