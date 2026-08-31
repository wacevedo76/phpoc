import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service_native.dart';

/// identity_pub_key raw-bytes parity — Phase 2 (RED).
///
/// Blueprint: docs/planning/C2_IDENTITY_PUB_KEY_RAW_BYTES_PHASE1.md
///
/// Canonical (PHPSPEC §2.7.1): identity_pub_key = SHA-256(raw 32-byte
/// identity_secret). Flutter derives it today by hashing the hex *string*
/// (`sha256(String)`), producing a divergent value. This harness asserts the
/// `identityPubKey` raw-bytes surface on both the pure-Dart shim
/// ([CryptoService]) and the native wrapper ([CryptoServiceNative]).
///
///   - Group C (C1–C4): Flutter crypto surface + cross-client parity.
///   - Group D (D5): per-user PDK salt parity (Flutter side).
///
/// Run: flutter test test/core/crypto/identity_pub_key_test.dart

// Fixed-answer vectors (byte-identical to the Web + Rust harnesses).
const canonical = '9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885';
const divergent = '271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a';
const pdkSalt = '2deeb62725ca597a'; // sha256(canonical_pubkey_hex)[:16]

String rep(String s, int n) => List.filled(n, s).join();

void main() {
  final secret = rep('ab', 32); // 64-char hex, 32 raw bytes 0xAB

  void expectValidationErrors(String Function(String) fn) {
    expect(() => fn(rep('zz', 32)), throwsA(isA<Exception>()),
        reason: 'non-hex must throw');
    expect(() => fn('abc'), throwsA(isA<Exception>()),
        reason: 'odd-length must throw');
    expect(() => fn(rep('ab', 31)), throwsA(isA<Exception>()),
        reason: '31-byte must throw');
    expect(() => fn(rep('ab', 33)), throwsA(isA<Exception>()),
        reason: '33-byte must throw');
  }

  group('C: identity_pub_key raw-bytes parity (Flutter)', () {
    test('C1: CryptoService (pure-Dart shim) identityPubKey == canonical raw-bytes SHA-256', () async {
      final service = CryptoService();
      await service.initialize();
      expect(service.identityPubKey(secret), canonical);
      expect(service.sha256(secret), divergent,
          reason: 'sha256(String) must still hash the hex string (bug boundary)');
      expect(service.identityPubKey(secret), isNot(service.sha256(secret)));
    });

    test('C2: CryptoServiceNative (frb_generated.dart) identityPubKey == canonical raw-bytes SHA-256', () async {
      final service = CryptoServiceNative();
      await service.initialize();
      expect(service.identityPubKey(secret), canonical);
      expect(service.sha256(secret), divergent);
      expect(service.identityPubKey(secret), isNot(service.sha256(secret)));
    });

    test('C3: identityPubKey rejects malformed hex / wrong length on both backends', () async {
      final shim = CryptoService();
      await shim.initialize();
      final native = CryptoServiceNative();
      await native.initialize();
      expectValidationErrors(shim.identityPubKey);
      expectValidationErrors(native.identityPubKey);
    });

    test('C4: Flutter identityPubKey == Web == Python hashlib.sha256(raw) shared vector', () async {
      final service = CryptoService();
      await service.initialize();
      expect(service.identityPubKey(secret), canonical,
          reason: 'must equal Python hashlib.sha256(32×0xAB) and Web identityPubKey (three-way parity)');
    });
  });

  group('D: cross-client raw-bytes parity extensions (Flutter side)', () {
    test('D5: per-user PDK salt (sha256(pubkey)[:16]) is deterministic and cross-client stable', () async {
      final service = CryptoService();
      await service.initialize();
      final pub = service.identityPubKey(secret);
      final salt = service.sha256(pub).substring(0, 16);
      expect(salt, pdkSalt,
          reason: 'salt must equal sha256(canonical_pubkey_hex)[:16] — identical on web + Flutter');
    });
  });
}
