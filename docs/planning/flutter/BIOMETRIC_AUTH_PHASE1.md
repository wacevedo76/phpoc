# Flutter: Biometric Authentication — Test Exploration (Phase 1)

> **Plan:** This document
> **Reference:** `FLUTTER_ARCHITECTURE.md` §11 (Platform Considerations: Biometric Auth)
> **Axioms:** D4 ("Biometrics Are a Cache"), F4 ("Favor Explicit Over Implicit")
> **Purpose:** Blueprint for fingerprint/face unlock: enrollment, unlock, fallback, settings toggle.
> **Status:** ✅ 4-Phase TDD Complete (2026-08-04) — 38 assertions → 85 GREEN → 2 Phase 4 improvements

## Architecture Overview

### Design Principle (Axiom D4)

The passphrase is the truth. Biometrics unlock a locally-stored encrypted master key ciphertext — same model as the web's IndexedDB-cached seed. If biometrics fail (new fingerprint enrolled, face not recognized, cold reboot), fall back to passphrase.

```
Enroll (after passphrase unlock):
  current MK → encrypt with biometric-bound AES key → 
    store ciphertext in flutter_secure_storage → 
    store AES key in Android Keystore (biometric-protected)

Unlock with biometric:
  local_auth.authenticate() → Android Keystore releases AES key → 
    decrypt MK ciphertext → set MK in CryptoService → app ready

Fallback (biometric failure):
  show passphrase field → same flow as today
```

### What's Done vs What's Needed

| Layer | Component | Status |
|-------|-----------|--------|
| Storage | `flutter_secure_storage` (in pubspec) | ✅ Done |
| Storage | `SecurePreferences` wrapper | ✅ Done |
| Auth | `AuthService.unlock()`, `lock()`, `reauthenticate()` | ✅ Done |
| Auth | `AuthService.enrollBiometric()` | ✅ Done (Phase 3) |
| Auth | `AuthService.unlockWithBiometric()` | ✅ Done (Phase 3) |
| Auth | `AuthService.isBiometricsAvailable()` | ✅ Done (Phase 3) |
| Auth | `AuthService.isBiometricEnabled()` | ✅ Done (Phase 3) |
| Auth | `AuthService.disableBiometric()` | ✅ Done (Phase 3) |
| UI | `UnlockScreen` — biometric icon/button | ✅ Done (Phase 3, D1–D8) |
| UI | `UnlockScreen` — biometric → passphrase fallback | ✅ Done (Phase 3) |
| UI | `SettingsScreen` — "Unlock with fingerprint" toggle | ✅ Done (Phase 3, E1–E6) |
| Deps | `local_auth` package | ✅ Done (Phase 3) |
| Platform | Android `USE_BIOMETRIC` permission | ✅ Done (Phase 3) |
| Tests | AuthService biometric tests | ✅ Done (20 tests, Groups BioA/BioC) |
| Tests | UnlockScreen biometric tests | ✅ Done (8 tests, Group D) |
| Tests | SettingsScreen biometric toggle tests | ✅ Done (6 tests, Group E) |

### Cold Reboot Constraint

After a phone cold reboot, Android requires the device credential (PIN/password/pattern) before biometrics can unlock app data. `local_auth.authenticate()` surfaces this error. The unlock screen must detect this and fall back to the passphrase field without showing a cryptic error.

---

## New Dependency

```yaml
# pubspec.yaml
dependencies:
  local_auth: ^2.3.0    # wraps BiometricPrompt (Android) + LAContext (iOS)
```

`flutter_secure_storage` is already present — it stores the encrypted MK ciphertext.

---

## AuthService Extensions

Five new methods. The `AuthService` gains no new constructor dependencies — it already has `CryptoService` and `AppDatabase`.

### 1. `isBiometricsAvailable()`

```dart
/// Check if biometric hardware is present and fingerprints/face are enrolled.
///
/// Returns false on emulators, devices without sensors, or devices with
/// sensors but no enrolled biometrics.
Future<bool> isBiometricsAvailable();
```

Uses `local_auth`'s `isDeviceSupported()` + `getAvailableBiometrics()`.

### 2. `isBiometricEnabled()`

```dart
/// Whether the user has opted into biometric unlock.
///
/// Stored in SharedPreferences (non-sensitive boolean flag).
bool isBiometricEnabled();
```

Reads a boolean flag from `AppPreferences`. Simple, no crypto.

### 3. `enrollBiometric()`

```dart
/// Encrypt the current MK with a biometric-bound key and store the ciphertext.
///
/// Must be called while unlocked (MK in memory). The ciphertext is stored
/// in flutter_secure_storage. The AES key is stored in Android Keystore with
/// user authentication required — it can only be used after a biometric prompt.
///
/// Throws [AuthException] if not unlocked.
Future<void> enrollBiometric();
```

**Implementation approach:** Generate a random 256-bit AES key. Encrypt the current MK hex string with AES-256-GCM. Store the ciphertext + nonce + tag in `flutter_secure_storage`. For the Keystore binding, use `local_auth`'s crypto-backed authentication mode or, if that proves complex, a simpler initial approach: store the AES key itself in `flutter_secure_storage` (which on Android is backed by `EncryptedSharedPreferences`, already Keystore-protected) and use `local_auth` as a presence check only. If `local_auth.authenticate()` succeeds, read the key from secure storage, decrypt MK. This is less strict than true crypto-object binding but satisfies D4 and is compatible with `flutter_secure_storage`.

### 4. `unlockWithBiometric()`

```dart
/// Trigger biometric prompt and derive MK from stored ciphertext on success.
///
/// Returns true on success (MK now cached in CryptoService). Returns false
/// if biometrics fail, are unavailable, or the user cancels.
///
/// Does not throw — failures are expected (wrong finger, cancel, cold reboot).
/// Callers should fall back to passphrase entry on false.
Future<bool> unlockWithBiometric();
```

**Flow:**
1. Check `isBiometricsAvailable()` + `isBiometricEnabled()` → return false if either is false
2. Call `local_auth.authenticate()` with reason string
3. On success: read encrypted MK ciphertext from `flutter_secure_storage`, read AES key, decrypt, set MK in `CryptoService`, set `_isUnlocked = true`
4. On failure/cancel/cold-reboot: return false

### 5. `disableBiometric()`

```dart
/// Remove stored MK ciphertext and clear the biometric opt-in flag.
///
/// Safe to call in any state.
Future<void> disableBiometric();
```

Deletes the key from `flutter_secure_storage` and clears the `isBiometricEnabled` pref.

---

## Assertion Inventory

### Group A: AuthService — Biometric Availability & Enrollment (8 assertions)

| ID | Assertion | Category |
|----|-----------|----------|
| A1 | `isBiometricsAvailable()` returns false when no hardware present | Env detection |
| A2 | `isBiometricsAvailable()` returns false when no fingerprints enrolled | Env detection |
| A3 | `isBiometricsAvailable()` returns true when hardware + fingerprint enrolled | Env detection |
| A4 | `isBiometricEnabled()` returns false by default (opt-in) | Default state |
| A5 | `enrollBiometric()` throws `AuthException` when not unlocked | Safety gate |
| A6 | `enrollBiometric()` stores MK ciphertext in secure storage when unlocked | Happy path |
| A7 | `enrollBiometric()` sets `isBiometricEnabled` flag to true | Side effect |
| A8 | `disableBiometric()` clears flag + removes ciphertext | Cleanup |

### Group B: AuthService — Biometric Unlock (8 assertions)

| ID | Assertion | Category |
|----|-----------|----------|
| B1 | `unlockWithBiometric()` returns false when biometric not enabled | Gate check |
| B2 | `unlockWithBiometric()` returns false when biometric not available | Gate check |
| B3 | `unlockWithBiometric()` returns false when user cancels prompt | User cancel |
| B4 | `unlockWithBiometric()` returns false on biometric failure (wrong finger) | Auth failure |
| B5 | `unlockWithBiometric()` returns false on cold reboot (credential required) | Cold reboot |
| B6 | `unlockWithBiometric()` returns true and sets MK on success | Happy path |
| B7 | After `unlockWithBiometric()` success, `isUnlocked` is true | State check |
| B8 | After `lock()`, biometric unlock works again (MK re-derivable from stored ciphertext) | Lock/unlock cycle |

### Group C: AuthService — Biometric Lifecycle (4 assertions)

| ID | Assertion | Category |
|----|-----------|----------|
| C1 | `disableBiometric()` → `unlockWithBiometric()` returns false | Cleanup effect |
| C2 | Re-enrolling after disable stores new ciphertext (not stale) | Re-enroll |
| C3 | `changePassphrase()` does not invalidate biometric (MK is seed-derived, unchanged) | Invariant |
| C4 | `exportSeed()` succeeds via biometric unlock (not just passphrase) | Cross-method |

### Group D: UnlockScreen — Biometric UI (8 assertions)

| ID | Assertion | Category |
|----|-----------|----------|
| D1 | Fingerprint icon visible when biometrics available and enabled | UI visibility |
| D2 | Fingerprint icon NOT visible when biometrics unavailable | UI absence |
| D3 | Fingerprint icon NOT visible when biometrics available but not enabled | UI absence |
| D4 | Tapping fingerprint icon calls `unlockWithBiometric()` | Tap action |
| D5 | On biometric success, screen transitions to ready (no passphrase prompt) | Happy path |
| D6 | On biometric cancel, passphrase field remains (no error, no transition) | Cancel |
| D7 | On biometric failure, meaningful message shown + passphrase field available | Failure UX |
| D8 | On cold reboot error, passphrase field shown without scary error message | Cold reboot UX |

### Group E: SettingsScreen — Biometric Toggle (6 assertions)

| ID | Assertion | Category |
|----|-----------|----------|
| E1 | "Unlock with fingerprint" toggle visible when biometrics available | UI visibility |
| E2 | Toggle NOT visible when biometric hardware absent | UI absence |
| E3 | Toggle starts OFF when biometric not yet enrolled | Default state |
| E4 | Tapping toggle ON prompts for passphrase verification | Enrollment gate |
| E5 | Correct passphrase → enrolls biometric → toggle stays ON | Happy path |
| E6 | Wrong passphrase → error shown → toggle returns to OFF | Auth failure |

### Group F: Integration (4 assertions)

| ID | Assertion | Category |
|----|-----------|----------|
| F1 | Full flow: onboarding → enable in settings → lock → biometric unlock → ready | E2E |
| F2 | Full flow: biometric enrolled → disable in settings → lock → passphrase required | Disable E2E |
| F3 | Biometric unlock after app process kill (MK not in memory) | Cold start |
| F4 | Wrong passphrase fallback still works when biometric enabled but failing | Fallback |

**Total: 38 assertions** (A:8, B:8, C:4, D:8, E:6, F:4)

---

## Files to Touch

| File | Action | Purpose |
|------|--------|---------|
| `pubspec.yaml` | Add `local_auth: ^2.3.0` | Biometric prompt API |
| `lib/services/auth_service.dart` | Add 5 biometric methods | Core biometric logic |
| `lib/features/auth/unlock_screen.dart` | Add fingerprint icon + fallback UI | Biometric unlock path |
| `lib/features/settings/settings_screen.dart` | Add "Unlock with fingerprint" toggle | Enrollment UI |
| `lib/data/storage/preferences.dart` | Add `biometricEnabled` getter/setter | Opt-in flag |
| `android/app/src/main/AndroidManifest.xml` | Add `USE_BIOMETRIC` permission | Platform permission |
| `test/services/auth_service_test.dart` | Add Groups A, B, C (20 assertions) | Auth tests |
| `test/features/unlock_screen_test.dart` | Add Group D (8 assertions), flesh out C12 | Unlock UI tests |
| `test/features/settings_screen_test.dart` | Add Group E (6 assertions) | Settings UI tests |
| `test/features/` (new) | Integration test for Group F (4 assertions) | E2E tests |

---

## Risk: iOS compatibility

`local_auth` and `flutter_secure_storage` both support iOS. No iOS project exists yet — only Android. The code should be written defensively: platform checks, no iOS-only imports. The `SecurePreferences` class already has the fallback pattern for Linux — the same pattern applies if iOS-specific behavior needs guards. For MVP, Android-only is fine per the current project state.

---

## Out of Scope (Phase 2+)

- Biometric enrollment during onboarding (Axiom F4: onboarding is already busy)
- Timeout-based auto-lock with biometric re-prompt
- iOS Face ID specific strings in `Info.plist`
- Biometric-bound per-field encryption (separate feature)
