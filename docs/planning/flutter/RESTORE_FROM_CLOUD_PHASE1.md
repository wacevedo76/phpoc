# Restore from Cloud — Test Exploration (Phase 1)

> **Purpose:** Blueprint of all needed test assertions for restoring a ledger from Cloudflare Worker/R2 during onboarding.
> **Status:** ✅ Phase 1 complete → ✅ Phase 2 (RED) complete → ✅ Phase 3 (GREEN) complete → ✅ Phase 4 (REFACTOR) complete
> **Next Phase:** Done

## Architecture Overview

```
OnboardingScreen (UI)
├── _OnboardingStep.main           — "Create New" | "Import Seed" | "Connect Worker" | "Restore from Cloud" [NEW]
├── _OnboardingStep.importSeed      — enter seed + passphrase
├── _OnboardingStep.workerConnect   — enter Worker URL + API key
└── _OnboardingStep.restoreCloud [NEW] — seed + passphrase + Worker URL + API key → full restore

OnboardingService
├── createNewLedger(passphrase)     — fresh genesis
├── importFromSeed(seed, passphrase) — rebuild genesis locally
├── connectWorker(url, apiKey)      — configure HttpTransport
└── restoreFromCloud(...) [NEW]     — importFromSeed + connectWorker + initial sync pull

SyncService
├── _reconcileAndClaim()            — pull remote blob, merge, push cookie
├── pushToRemote()                  — push local staging blob
└── checkAndSync()                  — existing sync gate (reauth, genesis, cookie)

GenesisGate (currently MVP passthrough — always returns null)
DeviceCookie — create, validate locally, compare, parse remote
HttpTransport — GET/PUT/DELETE to Worker with ETag + Bearer auth
```

### Key constraints

1. **MK caching:** `importFromSeed()` derives MK internally but never caches it. Sync pull requires `crypto.hasMasterKey == true`. The restore flow must call `crypto.setMasterKey(mk)` before triggering sync.
2. **Atomicity:** If Worker is unreachable, restore should still succeed (local genesis + empty staging). The Worker connection is best-effort for the initial pull.
3. **Existing data guard:** `importFromSeed()` checks `hasExistingData()` and throws `LedgerExistsException`. Restore-from-cloud must do the same.
4. **GenesisGate:** Currently MVP passthrough. Must be updated to verify remote genesis (if remote stores genesis) matches local before allowing full sync.

## Test Groups

### Group A: OnboardingService — restoreFromCloud — ~10 tests
New method that combines importFromSeed + connectWorker + initial sync pull.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `restoreFromCloud(seed, passphrase, url, apiKey)` writes genesis block to DB | Genesis is rebuilt from seed | Foundation — same behavior as importFromSeed |
| A2 | After `restoreFromCloud`, `hasExistingData()` returns true | Data flag is set | Consistency with importFromSeed contract |
| A3 | After `restoreFromCloud`, device UUID is persisted in preferences | Device identity created | Required for device cookie and sync |
| A4 | `restoreFromCloud` caches MK via `crypto.setMasterKey(mk)` before sync pull | MK available for deobfuscation | SyncService requires cached MK |
| A5 | After `restoreFromCloud` with reachable Worker, staging entries are pulled and merged | Cloud restore actually restores data | Core feature — user sees active tasks |
| A6 | `restoreFromCloud` with unreachable Worker still succeeds (local genesis only) | Graceful degradation | Don't block onboarding on network |
| A7 | `restoreFromCloud` with existing data throws `LedgerExistsException` | Existing data guard | Same contract as importFromSeed |
| A8 | `restoreFromCloud` with invalid seed throws before making network calls | Fail fast on bad input | Don't leak invalid attempts to Worker |
| A9 | `restoreFromCloud` with invalid Worker URL still succeeds (local genesis only) | Graceful degradation | Bad URL shouldn't block restore |
| A10 | Worked/empty blob (first device ever) → staging is empty after restore | First-device case | Normal case when no prior sync |

### Group B: SyncService — initial restore pull — ~10 tests
Sync pull triggered during onboarding, not just during regular sync cycles.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `_reconcileAndClaim()` pulls `staging/blob.bin` via transport | Remote blob retrieval | Core sync operation during restore |
| B2 | Pulled blob is deobfuscated using MK and parsed as JSON | Crypto pathway works | Must survive full encrypt→obfuscate→push→pull→deobfuscate→decrypt |
| B3 | Merged entries appear in local storage after reconcile | Data actually lands | User-visible outcome |
| B4 | Device cookie is created and pushed after successful blob pull | Cookie claim | Proves device ownership for next sync |
| B5 | Remote has no blob → local staging is empty (genesis-only) | Empty remote case | First device or cleaned remote |
| B6 | Remote has committed entries → committed entries filtered out during merge | Committed-flag respect | Only active entries should be in staging |
| B7 | Pull with wrong MK (different seed) throws `CryptoException` (not crash) | Wrong-key safety | Crypto error must cross boundary cleanly |
| B8 | Corrupted blob on remote → `CryptoException`, local staging unaffected | Corruption resilience | Don't destroy local state on bad remote data |
| B9 | Transport returns 404 on blob pull → local staging stays empty | Missing blob = empty remote | Normal when Worker has never been pushed to |
| B10 | Transport throws on blob pull (network error) → exception propagated, local staging unchanged | Network fault isolation | Local state must not be corrupted |

### Group C: Onboarding Screen — restore from cloud UI — ~10 tests
New `_OnboardingStep.restoreCloud` step in the UI flow.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Main screen shows "Restore from Cloud" option alongside Create New and Import Seed | New entry point | User discovers the feature |
| C2 | Tapping "Restore from Cloud" navigates to form with seed, passphrase, Worker URL, and API key fields | Form exists | Collects all needed inputs |
| C3 | Valid form submission triggers `restoreFromCloud`, shows loading state | Loading feedback | User knows work is happening |
| C4 | Successful restore navigates to auth/dashboard (appLifecycle goToAuth) | Success navigation | User proceeds into app |
| C5 | Invalid seed format shows validation error inline (not dialog) | Input validation | Immediate feedback before submission |
| C6 | Passphrase < 8 chars shows validation error | Passphrase policy | Enforced at UI level |
| C7 | Empty Worker URL shows validation error | Required field check | Worker URL is optional for local-only but required for cloud restore |
| C8 | Network error during restore shows appropriate message, option to retry or skip | Error recovery | User can choose to retry or continue local-only |
| C9 | Back button from restore step returns to main screen, clears form state | Navigation consistency | Same behavior as other steps |
| C10 | Loading state disables all form fields and submit button | Prevent double-submit | Standard UX safety |

### Group D: AuthService — MK caching during onboarding — ~6 tests
MK must be cached before sync pull, and auth service must handle the transition from onboarding to unlocked state.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `restoreFromCloud` calls `crypto.setMasterKey(mk)` after deriving MK from seed | MK cached for sync | SyncService requires `hasMasterKey` |
| D2 | After successful restore, `crypto.hasMasterKey` is true | MK available | Auth service can verify unlock state |
| D3 | Onboarding → Auth transition: MK survives the provider change | MK handed off | App doesn't re-request passphrase after onboarding |
| D4 | `crypto.clearMasterKey()` is NOT called after successful restore (MK must persist) | MK retained | User is authenticated after restore |
| D5 | `crypto.clearMasterKey()` IS called on restore failure (cleanup) | Secure cleanup | Don't leak MK on failed restore |
| D6 | AuthService.unlock after restore (same passphrase) → MK matches restored MK | MK consistency | Same passphrase produces same MK in both flows |

### Group E: Device identity & cookie — ~6 tests
Device cookie lifecycle during restore from cloud.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | After restore, device cookie is created with new UUID | Fresh device identity | New installation = new device |
| E2 | Device cookie is pushed to Worker as part of reconcile | Cookie sync | Remote knows this device claimed the blob |
| E3 | Remote has existing cookie from another device → new cookie overwrites | Cookie claim | Last writer wins (same MK proves authorization) |
| E4 | Cookie TTL is set on creation (30 min default) | TTL enforcement | Prevents stale cookies |
| E5 | Cookie survives app restart (persisted to SharedPreferences) | Cookie persistence | Device remembered across sessions |
| E6 | Cookie is NOT created if restore fails before sync pull | Atomicity | Only claim on successful restore |

### Group F: Genesis gate for restore — ~5 tests
GenesisGate must be updated to support restore verification.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | GenesisGate.check() during restore: local genesis exists → returns null (MVP passthrough) | Current behavior preserved | MVP doesn't block restore |
| F2 | [FUTURE] GenesisGate stores genesis hash on R2 after first push | Genesis fingerprint on remote | Enables cross-device genesis verification |
| F3 | [FUTURE] Restore from cloud with mismatched genesis → blocked with clear error | Wrong ledger guard | Prevents merging entries from different ledgers |
| F4 | GenesisGate.reset() clears compatibility cache | State cleanup | Fresh check after reset |
| F5 | Multiple devices with same seed → genesis hash matches on all devices | Cross-device parity | Same seed = same genesis = same hash |

### Group G: Integration — end-to-end restore — ~8 tests
Full pipeline from screen → service → sync → local storage.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | Device A creates ledger, pushes staging blob → Device B restores from cloud with same seed → entries appear | Cross-device restore | Primary use case |
| G2 | Restore with empty remote (never pushed) → genesis exists, staging empty, app navigates to dashboard | First-device cloud setup | Clean new installation |
| G3 | Restore with Worker down → genesis built, staging empty, error logged but app proceeds | Offline resilience | Network failure shouldn't block onboarding |
| G4 | Restore then immediately push a new staging entry → Worker accepts it | Post-restore sync works | Ongoing sync after restore |
| G5 | Restore then regular sync cycle (checkAndSync) → uses existing cookie | Cookie reuse | Fast path after restore |
| G6 | Full test suite (840 tests) passes with zero regressions after all changes | No regressions | All 7 modules depend on unchanged contracts |
| G7 | Flutter analyze: zero new warnings/errors | Code quality | Refactoring didn't introduce lint |
| G8 | `restoreFromCloud` with valid inputs but 401 from Worker → transport exception, genesis still built | Auth failure isolation | Bad API key shouldn't destroy local state |

### Group H: Error handling & edge cases — ~8 tests
Comprehensive error coverage for the restore path.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Very large staging blob on remote (500KB) → pulled and merged without OOM | Memory pressure | Mobile devices have limited RAM |
| H2 | Concurrent restore calls (double-tap) → second call rejected or idempotent | Race condition | UI debounce plus service guard |
| H3 | `restoreFromCloud` with empty seed string → validation error before any DB write | Input validation order | Fail fast, no side effects |
| H4 | `restoreFromCloud` with empty passphrase → validation error | Input validation | Passphrase required |
| H5 | Transport timeout during blob pull → timeout exception, genesis still built | Timeout resilience | Network slowness shouldn't corrupt |
| H6 | `restoreFromCloud` then immediately `createNewLedger` → LedgerExistsException | Data guard holds | Can't double-create |
| H7 | Special characters in Worker URL → handled by Uri.tryParse validation | URL safety | Injection prevention |
| H8 | `restoreFromCloud` when preferences DB is corrupted → meaningful error, not crash | Corruption resilience | Graceful degradation |

## Summary

| Group | Focus | Tests | Key dependency |
|-------|-------|-------|---------------|
| **A** | OnboardingService — restoreFromCloud | 10 | `importFromSeed`, `connectWorker`, `SyncService` |
| **B** | SyncService — initial restore pull | 10 | `HttpTransport`, `CryptoService` |
| **C** | Onboarding Screen — UI | 10 | `OnboardingService`, `_OnboardingStep.restoreCloud` |
| **D** | AuthService — MK caching | 6 | `CryptoService.setMasterKey` / `clearMasterKey` |
| **E** | Device Identity & Cookie | 6 | `DeviceCookie`, `HttpTransport` |
| **F** | Genesis Gate | 5 | `GenesisGate` (MVP → future) |
| **G** | Integration | 8 | All modules |
| **H** | Error Handling | 8 | All modules |
| **Total** | | **63** | |
