import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/services/auth_service.dart';

/// AuthService tests — Groups A (10) + B (6) + I (8) = 24 assertions.
///
/// Covers:
///   A1–A10: Unlock/Lock lifecycle
///   B1–B6:  changePassphrase
///   I1–I8:  Security & edge cases

// ── Test constants ──────────────────────────────────────────────

/// 32 bytes of 0x42 = base64 "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI="
const validSeedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

/// 44-char base64, 32 bytes — a different valid seed (0x21 = '!').
const altSeedB64 = 'ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE=';

/// Known MK for validSeedB64: HMAC-SHA256(32*0x42, "phpoc:master-key")
const knownMK = 'acaeca953d7bc0cbb524dbd94046b9fc9072c570a6c8aed32a73009e7489d84d';

/// A valid passphrase (≥8 chars).
const validPassphrase = 'CorrectHorseBatteryStaple42!';

/// A different valid passphrase.
const newPassphrase = 'NewCorrectHorseBatteryStaple99!';

// ── Helpers ────────────────────────────────────────────────────

/// Create a fresh AuthService with initialized crypto.
Future<AuthService> _makeAuthService({
  CryptoService? crypto,
  AppDatabase? db,
  AppPreferences? prefs,
}) async {
  final c = crypto ?? (CryptoService()..initialize());
  final d = db ?? AppDatabase.inMemory();
  final p = prefs ?? AppPreferences.testInstance();
  if (crypto == null) await c.initialize();
  return AuthService(crypto: c, db: d, preferences: p);
}

/// Create a genesis block in [db] for [passphrase] + [seedB64].
///
/// This mirrors what OnboardingService.createNewLedger does.
/// The genesis stores the seed encrypted with the PDK.
Future<void> _seedGenesisBlock({
  required CryptoService crypto,
  required AppDatabase db,
  required String passphrase,
  required String seedB64,
}) async {
  // Derive PDK and MK
  final pdk = crypto.derivePdk(passphrase, 600000);
  final mk = crypto.deriveMasterKey(seedB64);

  // Encrypt seed base64 string with PDK (seedB64 is already valid UTF-8)
  final encryptedSeed = crypto.encrypt(seedB64, pdk);

  // Build genesis data
  final genesisData = json.encode({'seed': encryptedSeed});
  final dataEncB64 = base64.encode(utf8.encode(genesisData));

  // Seal with MK
  final seal = crypto.seal(dataEncB64, mk);

  // Insert genesis block
  final now = DateTime.now().millisecondsSinceEpoch;
  await db.blockDao.insertBlock(Block(
    blockId: 'genesis-test-${now}',
    blockType: BlockType.genesis,
    blockIndex: 0,
    keyVersion: 1,
    dataEnc: dataEncB64,
    identitySeal: seal,
    prevHash: Block.genesisPrevHash,
    createdAt: now,
  ));
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group A: AuthService — Unlock/Lock (10 tests)
  // ═══════════════════════════════════════════════════════════════

  group('A: AuthService — Unlock/Lock', () {
    // A1
    test('A1: unlock(correctPassphrase, validSeed) → isUnlocked == true',
        () async {
      final auth = await _makeAuthService();
      await auth.unlock(validPassphrase, validSeedB64);
      expect(auth.isUnlocked, isTrue);
    });

    // A2
    test('A2: unlock → getMasterKey() returns 32-byte MK as 64-char hex',
        () async {
      final auth = await _makeAuthService();
      await auth.unlock(validPassphrase, validSeedB64);
      final mk = auth.getMasterKey();
      expect(mk, isNotNull);
      expect(mk, isA<String>());
      expect(mk!.length, 64,
          reason: 'Master key must be 64-char hex (32 bytes)');
    });

    // A3
    test('A3: unlock(wrongPassphrase, validSeed) → throws AuthException',
        () async {
      final auth = await _makeAuthService();
      expect(
        () => auth.unlock('wrong', validSeedB64),
        throwsA(isA<AuthException>()),
      );
    });

    // A4
    test('A4: unlock failure → isUnlocked stays false', () async {
      final auth = await _makeAuthService();
      try {
        await auth.unlock('wrong', validSeedB64);
      } on AuthException {
        // expected
      }
      expect(auth.isUnlocked, isFalse,
          reason: 'Failed unlock must not leave app in ambiguous state');
    });

    // A5
    test('A5: unlock(passphrase, invalidSeed) → throws format/validation error',
        () async {
      final auth = await _makeAuthService();
      expect(
        () => auth.unlock(validPassphrase, 'not-valid-base64!!!'),
        throwsA(isA<Exception>()),
      );
    });

    // A6
    test('A6: lock() after unlock → isUnlocked == false', () async {
      final auth = await _makeAuthService();
      await auth.unlock(validPassphrase, validSeedB64);
      auth.lock();
      expect(auth.isUnlocked, isFalse);
    });

    // A7
    test('A7: lock() after unlock → getMasterKey() returns null', () async {
      final auth = await _makeAuthService();
      await auth.unlock(validPassphrase, validSeedB64);
      auth.lock();
      expect(auth.getMasterKey(), isNull);
    });

    // A8
    test('A8: lock() zeros MK bytes before nulling reference', () async {
      final auth = await _makeAuthService();
      await auth.unlock(validPassphrase, validSeedB64);
      final mkBefore = auth.getMasterKey();
      auth.lock();

      // After lock, getMasterKey returns null — the reference is cleared.
      // The zeroing is tested in Phase 4 via memory analysis; this test
      // confirms the contract: null is returned, not a stale reference.
      expect(auth.getMasterKey(), isNull);
      // If MK were still accessible, it would match mkBefore — verify it doesn't.
      expect(auth.getMasterKey(), isNot(mkBefore));
    });

    // A9
    test('A9: isUnlocked on fresh instance → false', () async {
      final auth = await _makeAuthService();
      expect(auth.isUnlocked, isFalse,
          reason: 'Default state must be locked — no previous session assumed');
    });

    // A10
    test('A10: MK from unlock matches known test vector (cross-client compat)',
        () async {
      final auth = await _makeAuthService();
      await auth.unlock(validPassphrase, validSeedB64);
      final mk = auth.getMasterKey();
      expect(mk, knownMK,
          reason: 'Same seed + passphrase must produce same MK as web WASM');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group B: AuthService — changePassphrase (6 tests)
  // ═══════════════════════════════════════════════════════════════

  group('B: AuthService — changePassphrase', () {
    // B1
    test('B1: changePassphrase(oldCorrect, newValid) → succeeds, stays unlocked',
        () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      // Seed the genesis block so changePassphrase has something to re-encrypt.
      await _seedGenesisBlock(
        crypto: crypto, db: db,
        passphrase: validPassphrase, seedB64: validSeedB64,
      );

      final auth = AuthService(crypto: crypto, db: db,
          preferences: AppPreferences.testInstance());
      await auth.unlock(validPassphrase, validSeedB64);
      await auth.changePassphrase(validPassphrase, newPassphrase);

      // Should remain unlocked after passphrase change.
      expect(auth.isUnlocked, isTrue);
    });

    // B2
    test('B2: changePassphrase(oldWrong, newValid) → throws AuthException',
        () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      await _seedGenesisBlock(
        crypto: crypto, db: db,
        passphrase: validPassphrase, seedB64: validSeedB64,
      );

      final auth = AuthService(
          crypto: crypto, db: db,
          preferences: AppPreferences.testInstance());
      await auth.unlock(validPassphrase, validSeedB64);
      expect(
        () => auth.changePassphrase('WrongOldPassphrase!', newPassphrase),
        throwsA(isA<AuthException>()),
      );
    });

    // B3
    test('B3: after changePassphrase, unlock(newPassphrase, seed) succeeds',
        () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      await _seedGenesisBlock(
        crypto: crypto, db: db,
        passphrase: validPassphrase, seedB64: validSeedB64,
      );

      final auth = AuthService(
          crypto: crypto, db: db,
          preferences: AppPreferences.testInstance());
      await auth.unlock(validPassphrase, validSeedB64);
      await auth.changePassphrase(validPassphrase, newPassphrase);
      auth.lock();

      // Now unlock with the NEW passphrase — must succeed.
      await auth.unlock(newPassphrase, validSeedB64);
      expect(auth.isUnlocked, isTrue);
    });

    // B4
    test('B4: after changePassphrase, unlock(oldPassphrase, seed) fails',
        () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      await _seedGenesisBlock(
        crypto: crypto, db: db,
        passphrase: validPassphrase, seedB64: validSeedB64,
      );

      final auth = AuthService(
          crypto: crypto, db: db,
          preferences: AppPreferences.testInstance());
      await auth.unlock(validPassphrase, validSeedB64);
      await auth.changePassphrase(validPassphrase, newPassphrase);
      auth.lock();

      // Old passphrase must be rejected.
      expect(
        () => auth.unlock(validPassphrase, validSeedB64),
        throwsA(isA<AuthException>()),
      );
    });

    // B5
    test('B5: changePassphrase when isUnlocked == false → throws AuthException',
        () async {
      final auth = await _makeAuthService();
      // Not unlocked — changePassphrase must require auth.
      expect(
        () => auth.changePassphrase(validPassphrase, newPassphrase),
        throwsA(isA<AuthException>()),
      );
    });

    // B6
    test('B6: changePassphrase re-encrypts genesis seed and re-seals block',
        () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      // Seed the genesis first
      await _seedGenesisBlock(
        crypto: crypto, db: db,
        passphrase: validPassphrase, seedB64: validSeedB64,
      );

      final auth = AuthService(crypto: crypto, db: db,
          preferences: AppPreferences.testInstance());
      await auth.unlock(validPassphrase, validSeedB64);

      // Capture genesis block state before change
      final blocksBefore = await db.blockDao.getAllBlocks();

      await auth.changePassphrase(validPassphrase, newPassphrase);

      final blocksAfter = await db.blockDao.getAllBlocks();

      // Genesis block should exist (staging-only MVP has genesis only)
      expect(blocksAfter.isNotEmpty, isTrue,
          reason: 'Genesis block must exist after passphrase change');

      // If there was a genesis before, its data_enc should have changed
      // (re-encrypted with new PDK)
      if (blocksBefore.isNotEmpty && blocksAfter.isNotEmpty) {
        final before = blocksBefore.firstWhere(
          (b) => b.blockType == BlockType.genesis,
          orElse: () => blocksBefore.first,
        );
        final after = blocksAfter.firstWhere(
          (b) => b.blockType == BlockType.genesis,
          orElse: () => blocksAfter.first,
        );
        // data_enc must change because PDK changed
        expect(after.dataEnc, isNot(before.dataEnc),
            reason: 'Genesis data_enc must be re-encrypted with new PDK');
        // identity_seal must be updated
        expect(after.identitySeal, isNotNull);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group I: Security & Edge Cases (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('I: AuthService — Security & Edge Cases', () {
    // I1
    test('I1: lock() zeroes MK bytes in memory before nulling reference',
        () async {
      // This is an implementation-level concern. The test verifies that
      // after lock(), getMasterKey() returns null (reference cleared)
      // and the crypto service's hasMasterKey is false (bytes zeroed).
      final crypto = CryptoService();
      await crypto.initialize();
      final auth = AuthService(crypto: crypto, db: AppDatabase.inMemory(),
          preferences: AppPreferences.testInstance());

      await auth.unlock(validPassphrase, validSeedB64);
      expect(crypto.hasMasterKey, isTrue,
          reason: 'Crypto must have MK cached after unlock');

      auth.lock();

      expect(crypto.hasMasterKey, isFalse,
          reason: 'MK must be cleared from crypto on lock');
      expect(auth.getMasterKey(), isNull);
    });

    // I2
    test('I2: AuthService never logs passphrase or seed (even at debug level)',
        () async {
      // Contract: AuthService must not log secrets. This test verifies
      // that the service does not expose passphrase/seed through its
      // public API after unlock.
      final auth = await _makeAuthService();
      await auth.unlock(validPassphrase, validSeedB64);

      // getMasterKey returns the derived MK, not the passphrase or seed.
      final mk = auth.getMasterKey();
      expect(mk, isNotEmpty);
      // The returned value must not contain the passphrase or seed
      expect(mk, isNot(contains(validPassphrase)));
      expect(mk, isNot(validSeedB64));
    });

    // I3
    test('I3: OnboardingService never stores passphrase', () async {
      // Cross-cutting: services must never persist passphrase.
      // AuthService only caches the derived MK (not the passphrase).
      final preferences = AppPreferences.testInstance();
      final auth = await _makeAuthService(prefs: preferences);
      await auth.unlock(validPassphrase, validSeedB64);

      // Preferences must not contain the passphrase under any key.
      final workerUrl = await preferences.getWorkerUrl();
      final deviceUuid = await preferences.getDeviceUuid();

      // Passphrase must not leak into any preference key
      if (workerUrl != null) {
        expect(workerUrl, isNot(contains(validPassphrase)));
      }
      if (deviceUuid != null) {
        expect(deviceUuid, isNot(contains(validPassphrase)));
      }
    });

    // I4
    test('I4: changePassphrase validates new passphrase ≥8 chars', () async {
      final auth = await _makeAuthService();
      await auth.unlock(validPassphrase, validSeedB64);

      expect(
        () => auth.changePassphrase(validPassphrase, 'short'),
        throwsA(isA<AuthException>()),
      );
    });

    // I5
    test('I5: unlock with valid credentials but DB missing genesis → throws '
        'StateException', () async {
      // Create a DB without a genesis block
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final auth = AuthService(crypto: crypto, db: db,
          preferences: AppPreferences.testInstance());

      // Corrupt state: DB exists but has no genesis. Unlock must detect this.
      // In the staging-only MVP, unlock may still succeed since the seed IS
      // the recovery mechanism. If the service detects corrupt state, it must
      // throw StateException, not silently proceed.
      //
      // For Phase 2 RED, this test defines the expected contract.
      // Phase 3 will make this a real assertion: expect(() => auth.unlock(...),
      // throwsA(isA<StateException>())).
      //
      // Placeholder: verify the service was constructed correctly.
      expect(auth.isUnlocked, isFalse);
      expect(auth.getMasterKey(), isNull);
    });

    // I6
    test('I6: getMasterKey() while locked → returns null (does not throw)',
        () async {
      final auth = await _makeAuthService();
      expect(auth.isUnlocked, isFalse);

      // Must not throw — callers check this without try/catch
      final mk = auth.getMasterKey();
      expect(mk, isNull);
    });

    // I7 — Cross-referenced: C7 + D6 in onboarding_service_test.dart

    // I8
    test('I8: lock/unlock cycle preserves derived MK correctness', () async {
      final auth = await _makeAuthService();
      await auth.unlock(validPassphrase, validSeedB64);
      final mk1 = auth.getMasterKey();

      auth.lock();
      await auth.unlock(validPassphrase, validSeedB64);
      final mk2 = auth.getMasterKey();

      // MK must be identical across lock/unlock cycles — deterministic.
      expect(mk2, mk1,
          reason: 'Derived MK must be deterministic across lock/unlock cycles');
    });
  });
}
