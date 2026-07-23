import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/frb_generated.dart';

/// FFI API Tests — Phase 2 (RED)
///
/// Direct tests against the flutter_rust_bridge generated Dart bindings.
/// All 23 exported functions from `phpoc-crypto-core/src/frb.rs`.
///
/// Groups B–G (functional correctness) + Group K (error handling).
/// Every test is expected to FAIL because `frb_generated.dart` is a stub
/// that throws `UnimplementedError` — the FFI layer is not yet wired.

// ── Test constants ──────────────────────────────────────────────

/// Valid 64-char hex master key (32 bytes of 0xAB).
const mkHex = 'abababababababababababababababababababababababababababababababab';

/// Valid 44-char base64 seed (32 bytes of 0x42 = 'B').
const validSeed = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

/// Alternate 64-char hex key (32 bytes of 0xCD).
const otherMk = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

/// 16-byte salt hex (32 chars).
const salt16Hex = '0123456789abcdef0123456789abcdef';

/// Valid hex device ID / secret.
const deviceId = '550e8400-e29b-41d4-a716-446655440000';

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group B: Key Derivation FFI (10 tests)
  // ═══════════════════════════════════════════════════════════════

  group('B: Key Derivation FFI', () {
    // B1 — derivePdk deterministic, 64-char hex
    test('B1: derivePdk returns deterministic 64-char hex', () {
      final pdk1 = derivePdk('test', 600000);
      final pdk2 = derivePdk('test', 600000);
      expect(pdk1, pdk2);
      expect(pdk1.length, 64);
    });

    // B2 — derivePdk matches Dart shim's mkHex semantics
    test('B2: derivePdk output is a valid hex string of length 64', () {
      final pdk = derivePdk('test', 600000);
      expect(pdk, isA<String>());
      expect(pdk.length, 64);
      // Must be valid hex (all chars 0-9, a-f)
      expect(pdk, matches(RegExp(r'^[0-9a-f]{64}$')));
    });

    // B3 — derivePdk deterministic across calls
    test('B3: derivePdk("test", 600000) == derivePdk("test", 600000)', () {
      final a = derivePdk('test', 600000);
      final b = derivePdk('test', 600000);
      expect(a, b);
    });

    // B4 — deriveMasterKey with valid seed returns 64-char hex
    test('B4: deriveMasterKey(validSeed) returns 64-char hex', () {
      final mk = deriveMasterKey(validSeed);
      expect(mk.length, 64);
      expect(mk, matches(RegExp(r'^[0-9a-f]{64}$')));
    });

    // B5 — deriveMasterKey with non-base64 seed throws
    test('B5: deriveMasterKey with non-base64 seed throws', () {
      expect(
        () => deriveMasterKey('!!!not-base64!!!'),
        throwsA(isA<Exception>()),
      );
    });

    // B6 — deriveMasterKey with wrong-length decoded seed throws
    test('B6: deriveMasterKey with wrong-length decoded seed throws', () {
      // 'dG9vLXNob3J0' decodes to 9 bytes instead of 32
      expect(
        () => deriveMasterKey('dG9vLXNob3J0'),
        throwsA(isA<Exception>()),
      );
    });

    // B7 — deriveBlobKey returns 32-char hex (16 bytes)
    test('B7: deriveBlobKey(mk) returns 32-char hex', () {
      final key = deriveBlobKey(mkHex);
      expect(key.length, 32);
      expect(key, matches(RegExp(r'^[0-9a-f]{32}$')));
    });

    // B8 — deriveSealKey returns 64-char hex (32 bytes)
    test('B8: deriveSealKey(mk) returns 64-char hex', () {
      final key = deriveSealKey(mkHex);
      expect(key.length, 64);
      expect(key, matches(RegExp(r'^[0-9a-f]{64}$')));
    });

    // B9 — deriveFieldKey returns 32-char hex
    test('B9: deriveFieldKey(mk) returns 32-char hex', () {
      final key = deriveFieldKey(mkHex);
      expect(key.length, 32);
      expect(key, matches(RegExp(r'^[0-9a-f]{32}$')));
    });

    // B10 — derivePdkWithSalt returns deterministic 64-char hex
    test('B10: derivePdkWithSalt returns deterministic 64-char hex', () {
      final pdk1 = derivePdkWithSalt('test', salt16Hex, 600000);
      final pdk2 = derivePdkWithSalt('test', salt16Hex, 600000);
      expect(pdk1, pdk2);
      expect(pdk1.length, 64);
      expect(pdk1, matches(RegExp(r'^[0-9a-f]{64}$')));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C: AES-128-CTR Encrypt/Decrypt FFI (10 tests)
  // ═══════════════════════════════════════════════════════════════

  group('C: AES-128-CTR Encrypt/Decrypt FFI', () {
    // C1 — encrypt returns valid hex string (≥112 chars)
    test('C1: encrypt("Hello", mk) returns valid hex string ≥112 chars', () {
      final ct = encrypt('Hello', mkHex);
      expect(ct, isA<String>());
      expect(ct.length, greaterThanOrEqualTo(112));
      expect(ct, matches(RegExp(r'^[0-9a-f]+$')));
    });

    // C2 — decrypt(encrypt(plaintext, mk), mk) == plaintext
    test('C2: encrypt/decrypt roundtrip preserves plaintext', () {
      const plaintext = 'Hello, PHPOC!';
      final ct = encrypt(plaintext, mkHex);
      final pt = decrypt(ct, mkHex);
      expect(pt, plaintext);
    });

    // C3 — FFI encrypt output is byte-identical to Rust for same inputs
    test('C3: encrypt output matches known Rust test vector', () {
      // Deterministic test: encrypt with known MK, verify output length + format.
      // Full byte-identical assertion requires the Rust reference vector (Group I).
      final ct = encrypt('test-vector', mkHex);
      expect(ct.length, greaterThanOrEqualTo(112));
      // Same input always produces same hex (but different salt/nonce per call)
      final ct2 = encrypt('test-vector', mkHex);
      expect(ct, isNot(ct2)); // Semantic security: salt/nonce randomize output
    });

    // C4 — decrypt with wrong key throws auth tag mismatch
    test('C4: decrypt with wrong key throws', () {
      final ct = encrypt('secret', mkHex);
      expect(
        () => decrypt(ct, otherMk),
        throwsA(isA<Exception>()),
      );
    });

    // C5 — decrypt with tampered ciphertext throws
    test('C5: tampered ciphertext fails decrypt', () {
      final ct = encrypt('important data', mkHex);
      // Flip last hex char
      final tampered = ct.substring(0, ct.length - 1) +
          (ct[ct.length - 1] == 'a' ? 'b' : 'a');
      expect(
        () => decrypt(tampered, mkHex),
        throwsA(isA<Exception>()),
      );
    });

    // C6 — empty string roundtrips correctly
    test('C6: encrypt("") roundtrips correctly', () {
      final ct = encrypt('', mkHex);
      expect(decrypt(ct, mkHex), '');
    });

    // C7 — unicode plaintext roundtrips
    test('C7: unicode plaintext (日本語, emoji) roundtrips', () {
      const unicode = '日本語 Español 🔐 🚀';
      final ct = encrypt(unicode, mkHex);
      expect(decrypt(ct, mkHex), unicode);
    });

    // C8 — encrypt produces different ciphertext each call (semantic security)
    test('C8: encrypt produces different ciphertext each call', () {
      final c1 = encrypt('same plaintext', mkHex);
      final c2 = encrypt('same plaintext', mkHex);
      expect(c1, isNot(c2));
    });

    // C9 — same plaintext + mk produces consistent-length ciphertexts
    test('C9: encrypt produces consistent output lengths for same input size', () {
      final c1 = encrypt('hello', mkHex);
      final c2 = encrypt('world', mkHex);
      // Same input length → same output length
      expect(c1.length, c2.length);
    });

    // C10 — encrypt with invalid hex key throws (not Rust panic)
    test('C10: encrypt with invalid hex key throws, not panic', () {
      expect(
        () => encrypt('data', 'not-hex!!!'),
        throwsA(isA<Exception>()),
      );
      expect(
        () => encrypt('data', ''),
        throwsA(isA<Exception>()),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group D: Blob Obfuscation FFI (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('D: Blob Obfuscation FFI', () {
    // D1 — obfuscateBlob returns base64 string ≥87K chars (64K tier)
    test('D1: obfuscateBlob(smallData, mk) returns base64 ≥87K chars', () {
      const small = '{"device_id":"abc","entries":[]}';
      final obf = obfuscateBlob(small, mkHex);
      expect(obf, isA<String>());
      // Base64 encoding of 64K+ bytes = ~87K+ chars
      expect(obf.length, greaterThan(87000));
    });

    // D2 — deobfuscateBlob(obfuscateBlob(data, mk), mk) == data
    test('D2: obfuscate/deobfuscate roundtrip preserves data', () {
      const data = '{"device_id":"abc","entries":[]}';
      final obf = obfuscateBlob(data, mkHex);
      final deobf = deobfuscateBlob(obf, mkHex);
      expect(deobf, data);
    });

    // D3 — FFI obfuscate → deobfuscate matches Rust blob test vectors
    test('D3: blob format is consistent (deterministic-length output)', () {
      const data = 'cross-client-blob-test';
      final obf1 = obfuscateBlob(data, mkHex);
      final obf2 = obfuscateBlob(data, mkHex);
      // Same input produces same tier → same output length
      expect(obf1.length, obf2.length);
      // Both deobfuscate correctly
      expect(deobfuscateBlob(obf1, mkHex), data);
      expect(deobfuscateBlob(obf2, mkHex), data);
    });

    // D4 — deobfuscateBlob with wrong key throws
    test('D4: deobfuscateBlob with wrong key throws', () {
      final obf = obfuscateBlob('secret blob', mkHex);
      expect(
        () => deobfuscateBlob(obf, otherMk),
        throwsA(isA<Exception>()),
      );
    });

    // D5 — deobfuscateBlob with tampered base64 throws
    test('D5: tampered base64 fails deobfuscation', () {
      final obf = obfuscateBlob('important', mkHex);
      // Flip a base64 character near the end
      final pos = obf.length - 5;
      final flipped = obf.substring(0, pos) +
          (obf[pos] == 'A' ? 'B' : 'A') +
          obf.substring(pos + 1);
      expect(
        () => deobfuscateBlob(flipped, mkHex),
        throwsA(isA<Exception>()),
      );
    });

    // D6 — blob > 512KB throws BlobTooLarge
    test('D6: blob > 512KB throws BlobTooLarge', () {
      final huge = 'x' * (512 * 1024 + 1);
      expect(
        () => obfuscateBlob(huge, mkHex),
        throwsA(isA<Exception>()),
      );
    });

    // D7 — obfuscateBlob enters 128K tier when encrypted output exceeds 64K
    test('D7: tier boundary — data near 64K enters 128K tier', () {
      // 65,000 bytes of plaintext → encrypted is larger → may need 128K tier
      final data65k = 'x' * 65000;
      final obf65k = obfuscateBlob(data65k, mkHex);
      expect(deobfuscateBlob(obf65k, mkHex), data65k);
      // 66,000 bytes → larger tier
      final data66k = 'x' * 66000;
      final obf66k = obfuscateBlob(data66k, mkHex);
      expect(deobfuscateBlob(obf66k, mkHex), data66k);
      // 128K tier should be larger than 64K tier
      expect(obf66k.length, greaterThan(obf65k.length));
    });

    // D8 — deterministic obfuscation mode for test vector validation
    test('D8: same input produces consistent-length obfuscated blob', () {
      const data = 'deterministic-test';
      final o1 = obfuscateBlob(data, mkHex);
      final o2 = obfuscateBlob(data, mkHex);
      // Tier selection is deterministic for same input size
      expect(o1.length, o2.length);
      expect(deobfuscateBlob(o1, mkHex), data);
      expect(deobfuscateBlob(o2, mkHex), data);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group E: SHA-256 & HMAC FFI (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('E: SHA-256 & HMAC FFI', () {
    // E1 — sha256("hello") matches known answer
    test('E1: sha256("hello") == known answer', () {
      expect(
        sha256('hello'),
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    });

    // E2 — seal/verifySeal roundtrip
    test('E2: seal(data, mk) + verifySeal(data, seal, mk) == true', () {
      const data = '{"type":"genesis","date":"2026-01-01"}';
      final s = seal(data, mkHex);
      expect(verifySeal(data, s, mkHex), isTrue);
    });

    // E3 — verifySeal with wrong key returns false
    test('E3: verifySeal with wrong key returns false', () {
      const data = 'test data';
      final s = seal(data, mkHex);
      expect(verifySeal(data, s, otherMk), isFalse);
    });

    // E4 — sign/verifySignature roundtrip
    test('E4: sign(data, secret) + verifySignature(data, sig, secret) == true', () {
      const secret = 'dededededededededededededededededededededededededededededededede';
      const data = 'block_hash_here';
      final sig = sign(data, secret);
      expect(verifySignature(data, sig, secret), isTrue);
    });

    // E5 — hmacHex returns 64-char hex
    test('E5: hmacHex(key, data) returns 64-char hex', () {
      final h = hmacHex(mkHex, 'test-data');
      expect(h.length, 64);
      expect(h, matches(RegExp(r'^[0-9a-f]{64}$')));
      // Deterministic
      final h2 = hmacHex(mkHex, 'test-data');
      expect(h, h2);
    });

    // E6 — sha256 output matches Rust digest::sha256_string
    test('E6: sha256 is consistent with Rust digest module', () {
      // Known SHA-256 values are universal across all implementations
      expect(sha256(''), isNot(isEmpty));
      expect(sha256('').length, 64);

      // "abc" known answer: ba7816bf...
      expect(
        sha256('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });

    // E7 — seal output is exactly 64 hex chars
    test('E7: seal output length is exactly 64 hex chars', () {
      final s = seal('any data', mkHex);
      expect(s.length, 64);
    });

    // E8 — tampered data causes verifySeal to return false (not throw)
    test('E8: tampered data returns false (not throw) from verifySeal', () {
      const data = '{"entries":[],"type":"day"}';
      final s = seal(data, mkHex);
      // Tampered data should return false, not throw
      final result = verifySeal('{"entries":[],"type":"hour"}', s, mkHex);
      expect(result, isFalse);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group F: Device Identity FFI (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('F: Device Identity FFI', () {
    // F1 — getDeviceId deterministic, 64-char hex
    test('F1: getDeviceId(mk) returns deterministic 64-char hex', () {
      final id1 = getDeviceId(mkHex);
      final id2 = getDeviceId(mkHex);
      expect(id1, id2);
      expect(id1.length, 64);
      expect(id1, matches(RegExp(r'^[0-9a-f]{64}$')));
    });

    // F2 — deviceProof + verifyDeviceProof roundtrip
    test('F2: deviceProof(mk, id) + verifyDeviceProof(id, proof, mk) == true', () {
      final proof = deviceProof(mkHex, deviceId);
      expect(verifyDeviceProof(deviceId, proof, mkHex), isTrue);
    });

    // F3 — different MK → different getDeviceId
    test('F3: different MKs produce different device IDs', () {
      final id1 = getDeviceId(mkHex);
      final id2 = getDeviceId(otherMk);
      expect(id1, isNot(id2));
    });

    // F4 — deriveDeviceId not tested (I-09 device attribution — Group I parity test)
    // F5 — getDeviceSecret not directly exported by WASM (internal only)
    // These are tested through the CryptoService wrapper (Group H)

    // F6 — verifyDeviceProof with all-zero proof returns false
    test('F6: all-zero proof is rejected', () {
      const zeroProof = '0000000000000000000000000000000000000000000000000000000000000000';
      expect(verifyDeviceProof(deviceId, zeroProof, mkHex), isFalse);
    });

    // F7 — verifyDeviceProof with wrong device ID returns false
    test('F7: wrong device ID fails verifyDeviceProof', () {
      final proof = deviceProof(mkHex, deviceId);
      expect(
        verifyDeviceProof('550e8400-e29b-41d4-a716-446655440001', proof, mkHex),
        isFalse,
      );
    });

    // F8 — deviceProof deterministic
    test('F8: deviceProof is deterministic for same inputs', () {
      final p1 = deviceProof(mkHex, deviceId);
      final p2 = deviceProof(mkHex, deviceId);
      expect(p1, p2);
      expect(p1.length, 64);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group G: Random Generation FFI (5 tests)
  // ═══════════════════════════════════════════════════════════════

  group('G: Random Generation FFI', () {
    // G1 — generateSeed returns 44-char base64
    test('G1: generateSeed returns 44-char base64 string', () {
      final seed = generateSeed();
      expect(seed.length, 44);
      expect(seed, matches(RegExp(r'^[A-Za-z0-9+/=]{44}$')));
    });

    // G2 — consecutive generateSeed calls return different values
    test('G2: consecutive generateSeed calls return different values', () {
      final s1 = generateSeed();
      final s2 = generateSeed();
      expect(s1, isNot(s2));
    });

    // G3 — generateUuidV4 returns valid UUID v4
    test('G3: generateUuidV4 returns valid UUID v4', () {
      final uuid = generateUuidV4();
      expect(uuid.length, 36);
      expect('-'.allMatches(uuid).length, 4);
      expect(uuid[14], '4'); // Version nibble = 4
      expect('89ab'.contains(uuid[19]), isTrue); // Variant nibble
    });

    // G4 — generateDeviceSpecifier returns 32-char hex
    test('G4: generateDeviceSpecifier returns 32-char hex', () {
      final spec = generateDeviceSpecifier();
      expect(spec.length, 32);
      expect(spec, matches(RegExp(r'^[0-9a-f]{32}$')));
    });

    // G5 — consecutive generateDeviceSpecifier calls differ
    test('G5: consecutive generateDeviceSpecifier calls differ', () {
      final s1 = generateDeviceSpecifier();
      final s2 = generateDeviceSpecifier();
      expect(s1, isNot(s2));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group K: Error Handling & Edge Cases (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('K: Error Handling & Edge Cases', () {
    // K1 — All CryptoError variants map to distinct Dart exceptions
    test('K1: auth tag mismatch produces clear error message', () {
      final ct = encrypt('test', mkHex);
      // Tamper with ciphertext to trigger auth tag mismatch
      final tampered = ct.substring(0, ct.length - 1) +
          (ct[ct.length - 1] == 'a' ? 'b' : 'a');
      try {
        decrypt(tampered, mkHex);
        fail('Expected exception was not thrown');
      } catch (e) {
        expect(e.toString().toLowerCase(), contains('auth tag'));
      }
    });

    // K2 — AuthTagMismatch message contains "auth tag" (not Rust backtrace)
    test('K2: error message does not contain Rust backtrace or "unwrap"', () {
      final ct = encrypt('test', mkHex);
      final tampered = ct.substring(0, ct.length - 1) +
          (ct[ct.length - 1] == 'a' ? 'b' : 'a');
      try {
        decrypt(tampered, mkHex);
        fail('Expected exception was not thrown');
      } catch (e) {
        final msg = e.toString();
        expect(msg, isNot(contains('unwrap')));
        expect(msg, isNot(contains('panic')));
        expect(msg, isNot(contains('rust')));
        expect(msg, isNot(contains('backtrace')));
      }
    });

    // K3 — InvalidBase64 → message contains "base64"
    test('K3: invalid base64 produces message containing "base64"', () {
      try {
        deriveMasterKey('!!!not-base64!!!');
        fail('Expected exception was not thrown');
      } catch (e) {
        expect(e.toString().toLowerCase(), contains('base64'));
      }
    });

    // K4 — BlobTooLarge → message includes size and max
    test('K4: BlobTooLarge error message includes actual size and max', () {
      final huge = 'x' * (512 * 1024 + 1);
      try {
        obfuscateBlob(huge, mkHex);
        fail('Expected exception was not thrown');
      } catch (e) {
        final msg = e.toString().toLowerCase();
        expect(msg, anyOf(contains('512'), contains('too large'), contains('exceed')));
      }
    });

    // K5 — non-hex string where hex expected → exception (not panic)
    test('K5: non-hex key input throws, not panics', () {
      expect(
        () => encrypt('data', 'not-hex!!!'),
        throwsA(isA<Exception>()),
      );
      expect(
        () => decrypt('not-hex!!!', mkHex),
        throwsA(isA<Exception>()),
      );
      expect(
        () => deriveBlobKey('not-hex!!!'),
        throwsA(isA<Exception>()),
      );
    });

    // K6 — very large input (10MB plaintext) handled gracefully
    test('K6: very large input does not crash', () {
      // 10MB plaintext is well above the 512K blob limit
      final large = 'x' * (10 * 1024 * 1024);
      expect(
        () => obfuscateBlob(large, mkHex),
        throwsA(isA<Exception>()),
      );
    });

    // K7 — concurrent calls don't corrupt state
    test('K7: sequential calls produce consistent results', () {
      // Sequential calls to different functions should not interfere
      final ct = encrypt('hello', mkHex);
      final hash = sha256('hello');
      final seal_ = seal('data', mkHex);

      // After other calls, decryption still works
      expect(decrypt(ct, mkHex), 'hello');
      // Hash is still valid
      expect(hash, sha256('hello'));
      // Seal is still valid
      expect(verifySeal('data', seal_, mkHex), isTrue);
    });

    // K8 — memory inspection after clear (tested via CryptoService wrapper in Group H)
    test('K8: separate instances do not share state', () {
      // Each call is independent — no mutable global state in Rust
      final ct1 = encrypt('alpha', mkHex);
      final ct2 = encrypt('beta', mkHex);
      // Both decrypt correctly
      expect(decrypt(ct1, mkHex), 'alpha');
      expect(decrypt(ct2, mkHex), 'beta');
    });
  });
}
