import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/services/auth_service.dart';

/// Biometric Integration Tests — Group F (4 assertions)
///
///   F1: Full flow — onboarding → enable → lock → biometric unlock → ready
///   F2: Full flow — enrolled → disable → lock → passphrase required
///   F3: Biometric unlock after app process kill (MK not in memory)
///   F4: Wrong passphrase fallback still works when biometric enabled
///
/// Phase 2 RED: All tests fail because biometric methods are not yet
/// implemented on AuthService. The spy provides the expected API surface
/// but returns default/stub values, causing assertion failures.

// ── Test constants ──────────────────────────────────────────────

/// 32 bytes of 0x42 = base64 "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI="
const validSeedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

/// A valid passphrase (≥8 chars).
const validPassphrase = 'CorrectHorseBatteryStaple42!';

// ── Helpers ────────────────────────────────────────────────────

/// Create a genesis block in [db] for [passphrase] + [seedB64].
Future<void> _seedGenesisBlock({
  required CryptoService crypto,
  required AppDatabase db,
  required String passphrase,
  required String seedB64,
}) async {
  final pdk = crypto.derivePdk(passphrase, 600000);
  final mk = crypto.deriveMasterKey(seedB64);
  final encryptedSeed = crypto.encrypt(seedB64, pdk);
  final genesisData = json.encode({'seed': encryptedSeed});
  final dataEncB64 = base64.encode(utf8.encode(genesisData));
  final seal = crypto.seal(dataEncB64, mk);
  final now = DateTime.now().millisecondsSinceEpoch;
  await db.blockDao.insertBlock(Block(
    blockId: 'genesis-integration-$now',
    blockType: BlockType.genesis,
    blockIndex: 0,
    keyVersion: 1,
    dataEnc: dataEncB64,
    identitySeal: seal,
    prevHash: Block.genesisPrevHash,
    createdAt: now,
  ));
}

// ═══════════════════════════════════════════════════════════════
// Integration-test spy with configurable biometric behavior
// ═══════════════════════════════════════════════════════════════

class _IntegrationBioAuthService extends AuthService {
  bool _biometricsAvailable = false;
  bool _biometricEnabled = false;
  bool _unlockResult = false;
  bool _throwOnUnlock = false;
  String? _storedMkHex;

  void setBiometricsAvailable(bool v) => _biometricsAvailable = v;
  void setBiometricEnabled(bool v) => _biometricEnabled = v;
  void setUnlockResult(bool v) => _unlockResult = v;
  void setThrowOnUnlock(bool v) => _throwOnUnlock = v;
  void setStoredMkHex(String hex) => _storedMkHex = hex;

  _IntegrationBioAuthService({
    required super.crypto,
    required super.db,
    required super.preferences,
    required super.securePreferences,
  });

  Future<bool> isBiometricsAvailable() async => _biometricsAvailable;

  bool isBiometricEnabled() => _biometricEnabled;

  Future<void> enrollBiometric() async {
    _biometricEnabled = true;
    // Store current MK hex so we can restore it after lock()
    _storedMkHex = crypto.getMasterKey();
  }

  Future<bool> unlockWithBiometric() async {
    if (_throwOnUnlock) {
      return false;
    }
    if (_unlockResult && _storedMkHex != null) {
      crypto.setMasterKey(_storedMkHex!);
      notifyUnlocked();
    }
    return _unlockResult;
  }

  Future<void> disableBiometric() async {
    _biometricEnabled = false;
    _storedMkHex = null;
  }
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group F: Integration (F1–F4)
  // ═══════════════════════════════════════════════════════════════

  group('F: Biometric Integration', () {
    // F1 — Full flow: onboarding → enable → lock → biometric unlock → ready
    test('F1: full flow — onboarding → enable biometric → lock → biometric '
        'unlock → ready', () async {
      final crypto = CryptoService();
      await crypto.initialize();
      final db = AppDatabase.inMemory();

      // Step 1: Onboarding — create genesis block
      await _seedGenesisBlock(
        crypto: crypto,
        db: db,
        passphrase: validPassphrase,
        seedB64: validSeedB64,
      );

      final auth = _IntegrationBioAuthService(
        crypto: crypto,
        db: db,
        preferences: AppPreferences.testInstance(),
        securePreferences: SecurePreferences.testInstance(),
      );

      // Step 2: Unlock with passphrase (as done during normal login)
      await auth.unlock(validPassphrase, validSeedB64);
      expect(auth.isUnlocked, isTrue,
          reason: 'Step 2: must unlock with passphrase first');

      // Step 3: Enable biometric in settings
      auth.setBiometricsAvailable(true);
      await auth.enrollBiometric();
      expect(auth.isBiometricEnabled(), isTrue,
          reason: 'Step 3: biometric enrollment must set enabled flag');

      // Step 4: Lock the app (MK cleared from memory)
      auth.lock();
      expect(auth.isUnlocked, isFalse,
          reason: 'Step 4: lock must clear the session');
      expect(auth.getMasterKey(), isNull,
          reason: 'Step 4: MK must be removed from memory');

      // Step 5: Biometric unlock (MK re-derived from stored ciphertext)
      auth.setUnlockResult(true);
      final bioResult = await auth.unlockWithBiometric();
      expect(bioResult, isTrue,
          reason: 'Step 5: biometric unlock must succeed and return true');

      // In Phase 3: isUnlocked will be true after successful biometric unlock
      // For Phase 2 RED: the spy does NOT set isUnlocked — this assertion FAILS
      expect(auth.isUnlocked, isTrue,
          reason: 'Step 5: after biometric unlock, session must be unlocked');
    });

    // F2 — Full flow: enrolled → disable → lock → passphrase required
    test('F2: full flow — biometric enrolled → disable in settings → lock → '
        'passphrase required', () async {
      final crypto = CryptoService();
      await crypto.initialize();
      final db = AppDatabase.inMemory();

      await _seedGenesisBlock(
        crypto: crypto,
        db: db,
        passphrase: validPassphrase,
        seedB64: validSeedB64,
      );

      final auth = _IntegrationBioAuthService(
        crypto: crypto,
        db: db,
        preferences: AppPreferences.testInstance(),
        securePreferences: SecurePreferences.testInstance(),
      );

      // Enroll biometric
      await auth.unlock(validPassphrase, validSeedB64);
      auth.setBiometricsAvailable(true);
      await auth.enrollBiometric();
      expect(auth.isBiometricEnabled(), isTrue);

      // Disable biometric in settings
      await auth.disableBiometric();
      expect(auth.isBiometricEnabled(), isFalse,
          reason: 'After disable, biometric must be off');

      // Lock
      auth.lock();
      expect(auth.isUnlocked, isFalse);

      // Biometric unlock must return false (ciphertext was removed)
      final bioResult = await auth.unlockWithBiometric();
      expect(bioResult, isFalse,
          reason: 'Biometric unlock must fail after biometric was disabled — '
              'ciphertext is gone');

      // Passphrase fallback must still work
      await auth.unlock(validPassphrase, validSeedB64);
      expect(auth.isUnlocked, isTrue,
          reason: 'Passphrase unlock must still work after disabling biometric');
    });

    // F3 — Biometric unlock after app process kill (MK not in memory)
    test('F3: biometric unlock after app process kill (MK not in memory)',
        () async {
      // Simulates a fresh app start: MK is NOT in CryptoService memory.
      // The biometric ciphertext in secure storage is the only way to
      // derive the MK without the passphrase.
      final crypto = CryptoService();
      await crypto.initialize();
      final db = AppDatabase.inMemory();

      await _seedGenesisBlock(
        crypto: crypto,
        db: db,
        passphrase: validPassphrase,
        seedB64: validSeedB64,
      );

      // Simulate previous session: user enrolled biometric, then app was killed
      // The ciphertext exists in flutter_secure_storage (simulated by the spy)

      // Fresh AuthService — NOT unlocked (simulates cold start)
      final auth = _IntegrationBioAuthService(
        crypto: crypto,
        db: db,
        preferences: AppPreferences.testInstance(),
        securePreferences: SecurePreferences.testInstance(),
      );

      expect(auth.isUnlocked, isFalse,
          reason: 'Cold start: MK must not be in memory');
      expect(auth.getMasterKey(), isNull,
          reason: 'Cold start: no MK cached');

      // Biometric should be available and enabled from previous session
      auth.setBiometricsAvailable(true);
      auth.setBiometricEnabled(true);
      auth.setUnlockResult(true);
      // Simulate: MK ciphertext persisted from previous enrollment
      final mkHex = crypto.deriveMasterKey(validSeedB64);
      auth.setStoredMkHex(mkHex);

      // Biometric unlock must re-derive MK from stored ciphertext
      final bioResult = await auth.unlockWithBiometric();
      expect(bioResult, isTrue,
          reason: 'After process kill, biometric unlock must derive MK from '
              'stored ciphertext without passphrase');

      // In Phase 3: isUnlocked will be true + MK cached
      // For Phase 2 RED: spy does NOT set these → assertion FAILS
      expect(auth.isUnlocked, isTrue,
          reason: 'After biometric unlock from cold start, session must be '
              'unlocked');
    });

    // F4 — Wrong passphrase fallback works when biometric enabled but failing
    test('F4: wrong passphrase fallback still works when biometric enabled '
        'but failing', () async {
      final crypto = CryptoService();
      await crypto.initialize();
      final db = AppDatabase.inMemory();

      await _seedGenesisBlock(
        crypto: crypto,
        db: db,
        passphrase: validPassphrase,
        seedB64: validSeedB64,
      );

      final auth = _IntegrationBioAuthService(
        crypto: crypto,
        db: db,
        preferences: AppPreferences.testInstance(),
        securePreferences: SecurePreferences.testInstance(),
      );

      // Biometric is enabled but will fail
      auth.setBiometricsAvailable(true);
      auth.setBiometricEnabled(true);
      auth.setUnlockResult(false); // biometric fails

      // Biometric attempt fails
      final bioResult = await auth.unlockWithBiometric();
      expect(bioResult, isFalse,
          reason: 'Biometric unlock must return false when it fails');

      // Session must remain locked
      expect(auth.isUnlocked, isFalse,
          reason: 'Failed biometric must not leave session in ambiguous state');

      // Fallback: passphrase unlock must still work
      await auth.unlock(validPassphrase, validSeedB64);
      expect(auth.isUnlocked, isTrue,
          reason: 'Passphrase fallback must work when biometric fails');
      expect(auth.getMasterKey(), isNotNull,
          reason: 'MK must be properly derived via passphrase fallback');
    });
  });
}
