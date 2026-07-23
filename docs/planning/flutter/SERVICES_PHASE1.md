# Flutter Services Layer — Test Exploration (Phase 1)

> **Plan:** `docs/planning/flutter/INITIAL_PLAN.md` §Phase 5
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1+2+3+4 complete (65 assertions → 64 tests, all GREEN)
> **Next Phase:** Ready for Phase 6 (Screens)

## Architecture Overview

The Services layer is the application layer — it orchestrates auth lifecycle and
onboarding workflow without owning domain logic. It sits between the Data layer
(Storage + Sync) and the Presentation layer (Screens).

```
┌─────────────────────────────────────────────────────────┐
│ Presentation (Screens) — consume via Riverpod providers │
├─────────────────────────────────────────────────────────┤
│ Services (Phase 5)                                      │
│  ┌──────────────────┐  ┌───────────────────────┐        │
│  │ AuthService      │  │ OnboardingService      │        │
│  │ · unlock()       │  │ · createNewLedger()    │        │
│  │ · lock()         │  │ · importFromSeed()     │        │
│  │ · isUnlocked      │  │ · connectToWorker()    │        │
│  │ · getMasterKey() │  │ · hasExistingData()    │        │
│  │ · changePw()     │  └───────────────────────┘        │
│  └──────────────────┘                                    │
│  ┌──────────────────────────────────────────────┐        │
│  │ Boot Probe — determines AppPhase on startup   │        │
│  │ Riverpod Providers — wiring all deps          │        │
│  └──────────────────────────────────────────────┘        │
├─────────────────────────────────────────────────────────┤
│ Data Layer                                              │
│  CryptoService  ·  SyncService  ·  AppDatabase          │
│  AppPreferences  ·  SecurePreferences                   │
└─────────────────────────────────────────────────────────┘
```

### Dependencies (already built)

| Dependency | File | Purpose |
|---|---|---|
| `CryptoService` | `lib/core/crypto/crypto_service.dart` | PBKDF2, AES-CTR, HMAC, key derivation |
| `SyncService` | `lib/data/sync/sync_service.dart` | Staging CRUD + sync gate |
| `AppDatabase` | `lib/data/storage/database.dart` | SQLite via Drift (entries, blocks, index) |
| `AppPreferences` | `lib/data/storage/preferences.dart` | Worker URL, device UUID, device cookie, hasExistingData |
| `SecurePreferences` | `lib/data/storage/secure_preferences.dart` | Worker API key (encrypted storage) |
| `AppLifecycleNotifier` | `lib/routing/app_router.dart` | Phase state machine (boot/landing/onboarding/auth/ready) |

### Key Design Decisions

- **AuthService owns the MK lifecycle** — it holds the master key in memory and
  exposes `getMasterKey()`. SyncService and other consumers read MK from AuthService,
  not from CryptoService directly. This centralizes the lock/unlock state.
- **OnboardingService is stateless** — each method performs its work and returns.
  No internal state between calls. State is persisted via AppPreferences and AppDatabase.
- **Boot probe replaces manual phase transitions** — instead of screens calling
  `goToLanding()` / `goToAuth()`, the `AppLifecycleNotifier._probe()` checks existing
  data and sets the initial phase. Screens only transition at explicit boundaries
  (onboarding complete → auth, auth success → ready, lock → auth).
- **changePassphrase re-encrypts genesis** — same as CLI's `ph recover` flow:
  derive new MK from new passphrase + same seed, re-encrypt the recovery seed in
  the genesis block, re-seal genesis. The ledger chain is not re-encrypted (only
  the key changes; the chain uses the seed-derived MK which is unchanged).
- **Riverpod wiring stays in `providers.dart`** — the existing `data/storage/providers.dart`
  grows to include service providers. All providers live in one file for discoverability,
  matching the web's `DevModeContext.jsx` initialization block but split into focused
  providers.

### Staging-Only MVP Constraint

Per INITIAL_PLAN.md, the mobile MVP is a capture device — staging entries only.
This means:
- `createNewLedger()` creates a genesis block, but no ledger commit.
- `importFromSeed()` stores the genesis, but doesn't verify the full chain.
- `changePassphrase()` re-encrypts the genesis seed, but not ledger blocks (there are none).
- Auth flow is: passphrase + seed → derive MK → store MK in memory → ready.

---

## Test Groups

### Group A: AuthService — Unlock/Lock (~10 tests)

Core auth lifecycle. MK derivation must match web output byte-for-byte.
Lock must securely clear the key.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `unlock(correctPassphrase, validSeed)` → `isUnlocked == true` | Happy path: correct credentials unlock the app | Primary user flow — if this fails, nothing works |
| A2 | `unlock(correctPassphrase, validSeed)` → `getMasterKey()` returns 32-byte MK | MK is derived and accessible after unlock | Consumers (SyncService, crypto ops) depend on this |
| A3 | `unlock(wrongPassphrase, validSeed)` → throws `AuthException` | Wrong passphrase is rejected | Prevents brute-force; must fail closed |
| A4 | `unlock(wrongPassphrase, validSeed)` → `isUnlocked` stays `false` | State doesn't change on failure | Must not leave app in ambiguous state |
| A5 | `unlock(correctPassphrase, invalidSeed)` → throws format/validation error | Corrupt seed is rejected early | Fail fast on bad input, before PBKDF2 |
| A6 | `lock()` after unlock → `isUnlocked == false` | Lock clears auth state | Required for security; user-initiated lock |
| A7 | `lock()` after unlock → `getMasterKey()` returns `null` | MK is no longer accessible after lock | Consumers must see null, not stale MK |
| A8 | `lock()` zeros MK bytes before nulling reference | MK is not recoverable from memory dump | Defense-in-depth: prevents forensic recovery |
| A9 | `isUnlocked` on fresh instance (no unlock call) → `false` | Default state is locked | Must not assume previous session |
| A10 | MK derived via `deriveMasterKey(passphrase, seed, 600000)` matches known test vector | Cross-client compatibility: same inputs → same MK as web WASM | Critical for sync — different MK = different encryption = data loss |

### Group B: AuthService — changePassphrase (~6 tests)

Passphrase changes must re-encrypt the genesis seed with the new passphrase-derived
PDK, then update the genesis block. The seed doesn't change — only the encryption
envelope around it.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `changePassphrase(oldCorrect, newValid)` → succeeds, `isUnlocked == true` | Happy path: passphrase rotation works | Core security feature — users must be able to change passphrases |
| B2 | `changePassphrase(oldWrong, newValid)` → throws `AuthException` | Old passphrase must be verified before change | Prevents unauthorized passphrase changes |
| B3 | After `changePassphrase`, `unlock(newPassphrase, sameSeed)` succeeds | New passphrase works | The rotation must actually take effect |
| B4 | After `changePassphrase`, `unlock(oldPassphrase, sameSeed)` fails | Old passphrase is invalidated | Rotation must revoke old credentials |
| B5 | `changePassphrase` when `isUnlocked == false` → throws `AuthException` | Must be unlocked to change | Re-authentication required before sensitive operation |
| B6 | `changePassphrase` re-encrypts genesis seed and re-seals genesis block | Genesis block updated in database | Without this, the seed can't be unlocked with new passphrase after app restart |

### Group C: OnboardingService — createNewLedger (~9 tests)

Fresh ledger creation. Must generate a random seed, derive MK, build a genesis block
per PHPSPEC §4.1, and persist everything. The seed is returned once for the user to
back up.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `createNewLedger(passphrase)` → returns seed (44-char base64, 32 bytes decoded) | Seed is generated and returned for backup | User must save seed; format must match CLI/web |
| C2 | `createNewLedger` writes genesis block to database (block_type=genesis, block_index=0) | Genesis is persisted to SQLite | Required for boot probe to detect existing data |
| C3 | Genesis block contains encrypted seed (not plaintext) | Seed is encrypted with PDK before storage | D2: zero-knowledge — seed never stored in plaintext |
| C4 | Genesis block has valid `identity_seal` (HMAC-SHA256) | Genesis is sealed | Chain integrity requires seal from day zero |
| C5 | After `createNewLedger`, `preferences.hasExistingData() == true` | Boot probe can detect existing ledger | Required for Phase 6 boot flow |
| C6 | `createNewLedger` creates device identity (UUIDv4) and stores in preferences | Device has a unique identifier | Required for device cookie and sync gating |
| C7 | `createNewLedger` twice on same database → throws `LedgerExistsException` | Prevents accidental overwrite | Safety guard; user must explicitly clear first |
| C8 | Generated seed is 32 cryptographically random bytes (two calls produce different seeds) | Seeds are unique and unpredictable | Predictable seeds would break security |
| C9 | `createNewLedger` with short passphrase (< 8 chars) → throws validation error | Minimum passphrase length enforced | Basic password policy; matches CLI behavior |

### Group D: OnboardingService — importFromSeed (~7 tests)

Import an existing ledger from a recovery seed. Must parse the seed, derive MK,
build genesis, and mark data as existing. This is the "restore from seed backup" flow.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `importFromSeed(validSeedB64, passphrase)` → genesis block written to database | Seed import creates valid genesis | Core recovery flow — user restores from seed |
| D2 | Genesis block from import has `block_type == 'genesis'`, `block_index == 0` | Imported genesis matches spec | Must be indistinguishable from freshly created genesis |
| D3 | `importFromSeed(invalidBase64)` → throws format/validation error | Corrupt seed rejected before any I/O | Fail fast, don't leave partial state |
| D4 | `importFromSeed(validSeedB64)` → `preferences.hasExistingData() == true` | Boot probe detects imported data | Required for boot flow to route to unlock |
| D5 | `importFromSeed` creates device identity (UUIDv4) | New device gets its own identity | Each device has unique identity, even with same seed |
| D6 | `importFromSeed` when data already exists → throws `LedgerExistsException` | Prevents overwriting existing ledger | Safety guard; clear first if intentional |
| D7 | `importFromSeed` stores the seed encrypted in genesis (same format as createNewLedger) | Seed is encrypted at rest | D2 compliance; format must match createNewLedger |

### Group E: OnboardingService — connectWorker (~6 tests)

Connect to a Cloudflare Worker for remote sync. Must store URL and API key,
validate connectivity, and wire the transport into SyncService.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `connectWorker(url, apiKey)` → URL stored in `AppPreferences` | Worker URL is persisted | Required for SyncService to reach remote on next boot |
| E2 | `connectWorker` → API key stored in `SecurePreferences` (not AppPreferences) | API key is stored in encrypted storage | H5: secrets in encrypted storage, not plain prefs |
| E3 | `connectWorker(invalidUrl)` → throws validation error | Malformed URLs rejected | Catch typos before attempting network call |
| E4 | `connectWorker(validUrl, validKey)` → `SyncService.isRemoteAvailable == true` | Transport is wired after connect | SyncService must be ready to sync immediately |
| E5 | `connectWorker` with unreachable URL → throws `ConnectionException` (not silently fail) | Network errors are surfaced | User must know if Worker is unreachable |
| E6 | `connectWorker` overwrites previous Worker config (not appends) | Single remote transport | MVP: one Worker at a time |

### Group F: OnboardingService — hasExistingData (~4 tests)

Boot probe: determine whether a ledger already exists on this device. Uses a
three-tier check: preferences flag → genesis block in DB → identity file.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `hasExistingData()` returns `false` on fresh database | Clean install detected | Boot probe routes to landing/onboarding |
| F2 | `hasExistingData()` returns `true` after `createNewLedger()` | New ledger detected | Boot probe routes to unlock |
| F3 | `hasExistingData()` returns `true` after `importFromSeed()` | Imported ledger detected | Boot probe routes to unlock |
| F4 | `hasExistingData()` returns `false` if genesis block exists but preferences flag is absent → auto-heals by setting flag | Inconsistent state is repaired | Robustness: if prefs were cleared but DB intact, recover |

### Group G: Boot Probe / AppLifecycleNotifier (~7 tests)

The boot probe runs once at app startup and determines the initial `AppPhase`.
It replaces the current manual phase transitions (`goToLanding()`, etc.) for
the startup path.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | Boot probe with no existing data → phase = `landing` | Fresh install → landing/onboarding | User must onboard before using app |
| G2 | Boot probe with existing data + genesis → phase = `auth` | Existing ledger → unlock screen | User must authenticate |
| G3 | Boot probe with existing data + genesis + cached MK (biometric) → phase = `ready` | Biometric cache → skip unlock | Convenience: don't re-prompt if biometric available |
| G4 | Boot probe transition: `boot` → (probe) → correct target phase | Phase transitions in correct order | Loading screen must show briefly during probe |
| G5 | Boot probe runs exactly once — calling `_probe()` again after initial probe is no-op | Idempotent probe | Multiple router rebuilds must not re-trigger probe |
| G6 | Boot probe from landing → user completes onboarding → phase → `auth` | Post-onboarding transition | Onboarding complete → prompt for unlock |
| G7 | Boot probe from auth → user successfully unlocks → phase → `ready` | Post-unlock transition | Auth complete → main app |

### Group H: Riverpod Providers — Wiring (~8 tests)

All services and their dependencies must be wired correctly in the Riverpod
provider tree. No circular dependencies. Singletons are single-instance.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `cryptoServiceProvider` returns a singleton `CryptoService` | One crypto instance per app | CryptoService caches MK; multiple instances = stale cache |
| H2 | `authServiceProvider` injects `CryptoService`, `AppDatabase`, `AppPreferences` | AuthService receives all deps | AuthService needs crypto for PBKDF2, DB for genesis, prefs for state |
| H3 | `syncServiceProvider` injects `CryptoService`, `AppDatabase`, `AppPreferences`, `SecurePreferences` | SyncService receives all deps | SyncService needs crypto, DB, transport config, API key |
| H4 | `appLifecycleProvider` injects `OnboardingService` and `AuthService` for boot probe | Lifecycle can probe + transition | Boot probe needs both services to detect state |
| H5 | Provider graph resolves without circular dependency errors | No cycles in dependency graph | Riverpod throws at runtime for cycles; must be caught at build time |
| H6 | `syncServiceProvider` reads `AppPreferences.workerUrl` and `SecurePreferences.apiKey` to configure transport | Transport is auto-configured from persisted config | After onboarding, sync should work without manual re-config |
| H7 | All service providers are auto-disposed (no memory leak on hot restart) | Clean teardown | Flutter hot restart must re-initialize all services |
| H8 | `authServiceProvider` broadcasts lock/unlock state changes to listeners | Reactive auth state | Screens (unlock, sync indicator) need to react to auth changes |

### Group I: Security & Edge Cases (~8 tests)

Defense-in-depth, error handling, and edge case coverage. Complements the
happy-path groups above.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `lock()` zeroes MK bytes in memory before nulling reference | MK not recoverable after lock | Defense-in-depth: prevent memory-scan attacks |
| I2 | AuthService never logs passphrase or seed (even at debug level) | No secrets in logs | D2: zero-knowledge; log capture = compromise |
| I3 | OnboardingService never stores passphrase (only seed encrypted with PDK) | Passphrase is transient | D2: passphrase is the one secret that must never be at rest |
| I4 | `changePassphrase` validates new passphrase minimum length (≥8) | Password policy enforced | Prevents accidentally setting weak passphrase |
| I5 | `unlock` with valid passphrase but database missing genesis → throws `StateException` | Corrupt state detected | Must not proceed with half-initialized ledger |
| I6 | `getMasterKey()` called while locked → returns `null` (does not throw) | Graceful degradation | Callers (sync indicator) check `getMasterKey()` without try/catch |
| I7 | After `importFromSeed`, `createNewLedger` throws `LedgerExistsException` (not silently overwrites) | No accidental data loss | Explicit clear required before re-onboarding |
| I8 | `connectWorker` deletes previous API key before storing new one (no orphaned keys) | Clean state transitions | Old API key must not persist after Worker change |

---

## Summary

| Group | Area | Count |
|-------|------|-------|
| A | AuthService — Unlock/Lock | 10 |
| B | AuthService — changePassphrase | 6 |
| C | OnboardingService — createNewLedger | 9 |
| D | OnboardingService — importFromSeed | 7 |
| E | OnboardingService — connectWorker | 6 |
| F | OnboardingService — hasExistingData | 4 |
| G | Boot Probe / AppLifecycleNotifier | 7 |
| H | Riverpod Providers — Wiring | 8 |
| I | Security & Edge Cases | 8 |
| **Total** | | **65 assertions** |

### Key Coverage Areas

- **Auth lifecycle:** unlock, lock, getMasterKey, changePassphrase — full MK lifecycle
- **Onboarding flows:** create new, import from seed, connect Worker — all entry paths
- **Cross-client compatibility:** MK derivation matches web WASM output (A10)
- **Boot probe:** correct phase determination from persisted state (G1–G7)
- **Dependency injection:** provider graph is cycle-free, singletons are singletons (H1–H8)
- **Security:** MK zeroing, no secrets in logs, passphrase policy (I1–I8)
- **Edge cases:** corrupt state detection, double-create prevention, clean re-configuration

### Files to Create/Modify (Phase 2–3)

| File | Action | Purpose |
|------|--------|---------|
| `test/services/auth_service_test.dart` | Create | Groups A, B, I (auth tests) |
| `test/services/onboarding_service_test.dart` | Create | Groups C, D, E, F (onboarding tests) |
| `test/services/providers_test.dart` | Create | Groups G, H (provider wiring + boot probe) |
| `lib/services/auth_service.dart` | Rewrite | Full implementation |
| `lib/services/onboarding_service.dart` | Rewrite | Full implementation |
| `lib/data/storage/providers.dart` | Extend | Add authServiceProvider, syncServiceProvider |
| `lib/routing/app_router.dart` | Modify | Add boot probe to AppLifecycleNotifier |
