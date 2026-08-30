import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service_native.dart';

/// CryptoService Native Wrapper Tests — Phase 2 (RED)
///
/// Group H (CryptoService Wrapper, 10 tests) and
/// Group J (Integration, 8 tests) from the Phase 1 blueprint.
///
/// Tests the thin `CryptoServiceNative` wrapper around the FFI bindings.
/// In Phase 2 (RED), all methods throw `UnimplementedError` because the
/// FFI layer has not been wired. Phase 3 (GREEN) replaces the stubs with
/// real `flutter_rust_bridge` generated bindings.

// ── Test constants ──────────────────────────────────────────────

const mkHex = 'abababababababababababababababababababababababababababababababab';
const validSeed = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group H: CryptoService Wrapper (10 tests)
  // ═══════════════════════════════════════════════════════════════

  group('H: CryptoService Native Wrapper', () {
    late CryptoServiceNative service;

    setUp(() {
      service = CryptoServiceNative();
    });

    // H1 — initialize() sets isInitialized = true
    test('H1: initialize() sets isInitialized to true', () async {
      await service.initialize();
      expect(service.isInitialized, isTrue);
    });

    // H2 — initialize() is idempotent
    test('H2: initialize() called twice is idempotent (no double-load crash)',
        () async {
      await service.initialize();
      await service.initialize();
      expect(service.isInitialized, isTrue);
    });

    // H3 — setMasterKey → getMasterKey returns exact same hex
    test('H3: setMasterKey(hex) → getMasterKey() returns exact same hex',
        () async {
      await service.initialize();
      service.setMasterKey(mkHex);
      expect(service.hasMasterKey, isTrue);
      expect(service.getMasterKey(), mkHex);
    });

    // H4 — clearMasterKey → hasMasterKey == false, memory zeroed
    test('H4: clearMasterKey() evicts cached key (hasMasterKey == false)',
        () async {
      await service.initialize();
      service.setMasterKey(mkHex);
      service.clearMasterKey();
      expect(service.hasMasterKey, isFalse);
      expect(service.getMasterKey(), isNull);
    });

    // H5 — encryptWithCachedKey works when MK is cached
    test('H5: encryptWithCachedKey works when MK is cached', () async {
      await service.initialize();
      service.setMasterKey(mkHex);
      final ct = service.encryptWithCachedKey('hello');
      expect(ct, isA<String>());
      expect(ct.length, greaterThanOrEqualTo(112));
      // Decrypt with cached key
      final pt = service.decryptWithCachedKey(ct);
      expect(pt, 'hello');
    });

    // H6 — decryptWithCachedKey works when MK is cached
    test('H6: decryptWithCachedKey works when MK is cached', () async {
      await service.initialize();
      service.setMasterKey(mkHex);
      final ct = service.encryptWithCachedKey('test-decrypt');
      final pt = service.decryptWithCachedKey(ct);
      expect(pt, 'test-decrypt');
    });

    // H7 — crypto method before initialize() throws
    test('H7: any crypto method before initialize() throws', () {
      expect(
        () => service.encrypt('hello', mkHex),
        throwsA(isA<Exception>()),
      );
      expect(
        () => service.sha256('hello'),
        throwsA(isA<Exception>()),
      );
    });

    // H8 — public API surface matches existing 29-method contract
    test('H8: CryptoServiceNative public API has all expected methods', () {
      // Verify all 29 public methods exist (compile-time check passes if
      // they're declared in the class — runtime exercises them).
      expect(service, isA<CryptoServiceNative>());

      // Lifecycle (5)
      expect(() => service.initialize(), returnsNormally);
      expect(() => service.setMasterKey(mkHex), returnsNormally);
      expect(() => service.getMasterKey(), returnsNormally);
      expect(() => service.clearMasterKey(), returnsNormally);

      // Convenience (2) — need master key cached
      service.setMasterKey(mkHex);
      final ct = service.encryptWithCachedKey('test');
      expect(ct, isA<String>());
      expect(service.decryptWithCachedKey(ct), 'test');

      // Key Derivation (6)
      expect(() => service.derivePdk('test', 600000), returnsNormally);
      expect(() => service.derivePdkWithSalt('test', '0' * 32, 600000),
          returnsNormally);
      expect(() => service.deriveMasterKey(validSeed), returnsNormally);
      expect(() => service.deriveBlobKey(mkHex), returnsNormally);
      expect(() => service.deriveSealKey(mkHex), returnsNormally);
      expect(() => service.deriveFieldKey(mkHex), returnsNormally);

      // Encrypt/Decrypt (2)
      expect(() => service.encrypt('test', mkHex), returnsNormally);
      expect(() => service.decrypt(service.encrypt('test', mkHex), mkHex), returnsNormally);

      // Blob (2)
      expect(() => service.obfuscateBlob('test', mkHex), returnsNormally);
      expect(() => service.deobfuscateBlob(service.obfuscateBlob('test', mkHex), mkHex), returnsNormally);

      // Hash (1)
      expect(() => service.sha256('test'), returnsNormally);

      // HMAC / Seal / Sign (6)
      expect(() => service.seal('data', mkHex), returnsNormally);
      expect(() => service.verifySeal('data', '0' * 64, mkHex), returnsNormally);
      expect(() => service.sign('data', mkHex), returnsNormally);
      expect(
          () => service.verifySignature('data', '0' * 64, mkHex), returnsNormally);
      expect(() => service.hmacHex(mkHex, 'data'), returnsNormally);

      // Device Identity (5)
      expect(() => service.getDeviceId(mkHex), returnsNormally);
      expect(() => service.deviceProof(mkHex, 'device-id'), returnsNormally);
      expect(
          () => service.verifyDeviceProof('id', '0' * 64, mkHex), returnsNormally);
      expect(
          () => service.deriveDeviceId(mkHex, 'secret'), returnsNormally);
      expect(() => service.getDeviceSecret(mkHex), returnsNormally);

      // Random (3)
      expect(() => service.generateSeed(), returnsNormally);
      expect(() => service.generateUuid(), returnsNormally);
      expect(() => service.generateDeviceSpecifier(), returnsNormally);

      // Content Hash (2)
      expect(
          () => service.computeEntryHash({'title': 'test'}), returnsNormally);
      expect(
          () => service.computeContentHash({'title': 'test'}), returnsNormally);

      // Auth (1)
      expect(() => service.authenticate('pass', validSeed, 600000),
          returnsNormally);
    });

    // H9 — Rust panic produces CryptoException, not app crash
    test('H9: invalid internal state produces exception, not crash', () {
      // All FFI-boundary failures should throw Dart exceptions, not crash
      expect(
        () => service.sha256('test'),
        throwsA(isA<Exception>()),
      );
    });

    // H10 — All 74 existing crypto_service_test.dart tests pass with FFI backend
    test('H10: existing CryptoService contract is preserved', () async {
      // The CryptoServiceNative must expose the same contract as CryptoService.
      // This test verifies the wrapper compiles with the expected API surface.
      // Full regression testing (74 existing tests) runs against the actual
      // FFI-backed implementation in Phase 3.
      await service.initialize();
      service.setMasterKey(mkHex);
      expect(service.hasMasterKey, isTrue);
      service.clearMasterKey();
      expect(service.hasMasterKey, isFalse);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group J: Integration (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('J: Integration', () {
    late CryptoServiceNative service;

    setUp(() async {
      service = CryptoServiceNative();
      await service.initialize();
    });

    // J1 — Full auth flow: derivePdk → deriveMasterKey → setMasterKey → encrypt → decrypt
    test('J1: full auth flow produces valid encrypt/decrypt cycle', () {
      // Auth flow
      final mk = service.authenticate('test-passphrase', validSeed, 600000);
      expect(mk.length, 64);

      service.setMasterKey(mk);
      expect(service.hasMasterKey, isTrue);

      // Encrypt + decrypt with derived key
      const plaintext = 'End-to-end test plaintext';
      final ct = service.encryptWithCachedKey(plaintext);
      expect(service.decryptWithCachedKey(ct), plaintext);
    });

    // J2 — encrypt → obfuscateBlob → deobfuscateBlob → decrypt = original
    test('J2: full staging blob flow: encrypt → obfuscate → deobfuscate → decrypt',
        () {
      service.setMasterKey(mkHex);

      const plaintext = '{"entries":[{"title":"Test","duration":3600000}]}';
      final encrypted = service.encryptWithCachedKey(plaintext);
      final obfuscated = service.obfuscateBlob(encrypted, mkHex);
      final deobfuscated = service.deobfuscateBlob(obfuscated, mkHex);

      expect(deobfuscated, encrypted);
    });

    // J3 — deriveSealKey → seal → verifySeal roundtrip
    test('J3: block sealing flow: deriveSealKey → seal → verifySeal', () {
      service.setMasterKey(mkHex);

      final sealKey = service.deriveSealKey(mkHex);
      expect(sealKey.length, 64);

      const blockData = '{"type":"day","entries":[],"prev_hash":"0"*64}';
      final seal_ = service.seal(blockData, mkHex);
      expect(seal_.length, 64);

      // Verify with same key
      expect(service.verifySeal(blockData, seal_, mkHex), isTrue);

      // Verify with deriveSealKey proves consistency
      final doubleSeal = service.seal(blockData, mkHex);
      expect(service.verifySeal(blockData, doubleSeal, mkHex), isTrue);
    });

    // J4 — Integration with OnboardingService (seed → MK lifecycle)
    test('J4: onboarding flow — generate seed → derive MK → set MK', () {
      // Simulate OnboardingService.createNewLedger():
      final seed = service.generateSeed();
      expect(seed.length, 44);

      final mk = service.deriveMasterKey(seed);
      expect(mk.length, 64);

      service.setMasterKey(mk);
      expect(service.hasMasterKey, isTrue);

      // Verify key works for crypto
      final ct = service.encryptWithCachedKey('genesis entry');
      expect(service.decryptWithCachedKey(ct), 'genesis entry');
    });

    // J5 — Integration with AuthService (MK cached → encrypt/decrypt staging)
    test('J5: auth flow — set MK → encrypt/decrypt staging entries', () {
      // Simulate AuthService.unlock(passphrase) → derive PDK → set MK
      service.setMasterKey(mkHex);

      // Now staging operations work with cached key
      final stagingEntry = '{"title":"Active task","startEpoch":1700000000000}';
      final encrypted = service.encryptWithCachedKey(stagingEntry);
      expect(encrypted.length, greaterThanOrEqualTo(112));

      final decrypted = service.decryptWithCachedKey(encrypted);
      expect(decrypted, stagingEntry);
    });

    // J6 — Integration with SyncService (device proof + blob obfuscate/deobfuscate)
    test('J6: sync flow — device proof → blob obfuscate → push → pull → deobfuscate',
        () {
      service.setMasterKey(mkHex);

      // Device proof for cookie
      const deviceId = '550e8400-e29b-41d4-a716-446655440000';
      final proof = service.deviceProof(mkHex, deviceId);
      expect(proof.length, 64);
      expect(service.verifyDeviceProof(deviceId, proof, mkHex), isTrue);

      // Blob obfuscation for staging push
      const stagingData = '{"entries":[{"title":"Test"}],"device_uuid":"abc"}';
      final obfuscated = service.obfuscateBlob(stagingData, mkHex);
      expect(obfuscated.length, greaterThan(87000)); // 64K tier

      // Deobfuscate after pull
      final deobfuscated = service.deobfuscateBlob(obfuscated, mkHex);
      expect(deobfuscated, stagingData);
    });

    // J7 — Integration with LedgerEngine (seal blocks, verify chain)
    test('J7: ledger flow — seal block → verify seal → chain verification', () {
      service.setMasterKey(mkHex);

      // Block sealing (LedgerEngine.buildDayBlock)
      final dayBlock = '{"type":"day","date":"2026-01-15","entries":[]}';
      final seal1 = service.seal(dayBlock, mkHex);
      expect(service.verifySeal(dayBlock, seal1, mkHex), isTrue);

      // Chain verification (LedgerEngine.verify)
      // Tampering detected
      const tamperedBlock = '{"type":"day","date":"2026-01-16","entries":[]}';
      expect(service.verifySeal(tamperedBlock, seal1, mkHex), isFalse);

      // Wrong key detected
      const otherMk = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
      expect(service.verifySeal(dayBlock, seal1, otherMk), isFalse);
    });

    // J8 — Full test suite (747 tests) passes with FFI backend
    test('J8: all crypto operations work end-to-end in a real-world sequence', () {
      // Real-world sequence: user opens app → authenticates → views data → syncs
      service.setMasterKey(mkHex);

      // 1. Auth → derive sub-keys
      final blobKey = service.deriveBlobKey(mkHex);
      final sealKey = service.deriveSealKey(mkHex);
      expect(blobKey.length, 32);
      expect(sealKey.length, 64);

      // 2. View history → hash verification
      final entryHash = service.computeEntryHash({
        'title': 'Coding',
        'duration': 3600000,
      });
      expect(entryHash.length, 64);

      // 3. Seal a day block
      const block = '{"type":"day","prev_hash":"0"*64,"entries":["hash1"]}';
      final seal_ = service.seal(block, mkHex);
      expect(service.verifySeal(block, seal_, mkHex), isTrue);

      // 4. Sync → device proof
      final deviceId = service.getDeviceId(mkHex);
      expect(deviceId.length, 64);

      // 5. Random generation
      final uuid = service.generateUuid();
      expect(uuid[14], '4'); // UUID v4

      // 6. HMAC
      final hmac = service.hmacHex(mkHex, 'test-hmac');
      expect(hmac.length, 64);

      // 7. SHA-256
      final hash = service.sha256('end-to-end');
      expect(hash.length, 64);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C: computeContentHash strip divergence (FFI method) — KEEP `_enc`
  // Blueprint: docs/planning/flutter/CONTENT_HASH_STRIP_DIVERGENCE_PHASE1.md
  // ═══════════════════════════════════════════════════════════════
  group('C: computeContentHash strip divergence (native)', () {
    late CryptoServiceNative service;

    setUp(() async {
      service = CryptoServiceNative();
      await service.initialize();
    });

    // C1 — KEEP `_enc` suffix (V1 vector)
    test('C-CH1: KEEPS _enc suffix (V1 vector)', () {
      service.setMasterKey(mkHex);
      final data = {
        'duration': 598172,
        'metadata_enc': service.encryptWithCachedKey('{}'),
        'startTime_enc': service.encryptWithCachedKey('1777028295844'),
        'title': 'Music Practice - Flute',
      };
      expect(service.computeContentHash(data),
          '6bcdf73697a738fd7412bc6c4cfe8daf5fc4b7167b8dac8a013fe9602b1d26dd');
    });

    // C2 — serializes with jsonSort spacing (V4 vector, no _enc fields)
    test('C-CH2: serializes with jsonSort spacing (V4 vector)', () {
      service.setMasterKey(mkHex);
      final data = {'title': 'Test', 'duration': 1000};
      expect(service.computeContentHash(data),
          'fe8dfdbf3f76aa2fa466cdcaa628343b87f9081c67c73db8dd35759a2c62d0f1');
    });

    // C3 — does NOT json.decode plaintext (V5 vector)
    test('C-CH3: does NOT json.decode plaintext (V5 vector)', () {
      service.setMasterKey(mkHex);
      final data = {
        'duration': 5,
        'title_enc': service.encryptWithCachedKey('{"a":1}'),
      };
      expect(service.computeContentHash(data),
          'e87350241d5e578af9fc632cd23492ee09245e39f96ecfacb0ef6aab2f6e7943');
    });
  });
}
