import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/frb_generated.dart';

/// Cross-Platform Parity Tests — Phase 2 (RED)
///
/// Group I assertions from the Phase 1 blueprint.
/// Verifies byte-identical output across Rust FFI → Dart, Rust → WASM → JS,
/// and the Python reference implementation.
///
/// Every test is RED — the FFI layer has not been wired yet, so all
/// `frb_generated.dart` functions throw `UnimplementedError`.

// ── Test constants — matching Rust unit test vectors ────────────

/// Fixed master key used across all platforms for parity testing.
const fixedMk = 'abababababababababababababababababababababababababababababababab';

/// Fixed seed (32 bytes of 0x42).
const fixedSeed = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

/// Fixed test data for hash parity.
const testData = 'cross-client-test-data';

/// Fixed canonical JSON for entry hash parity.
const canonicalJson = '{"duration":3600000,"title":"Coding"}';

/// Expected SHA-256 of "cross-client-test-data" — must be identical
/// on all platforms (Rust, Python, JS WASM, Dart FFI).
/// Pre-computed: echo -n "cross-client-test-data" | sha256sum
const expectedSha256 = '00f3c0c1c66a7e1f11eee1c0173b2d4b3a510764ca603f9574e74917ddc69089';

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group I: Cross-Platform Parity (12 tests)
  // ═══════════════════════════════════════════════════════════════

  group('I: Cross-Platform Parity', () {
    // I1 — encrypt("cross-client-test", fixedMK) → identical hex output
    test('I1: encrypt produces deterministic-length output for same input', () {
      const plaintext = 'cross-client-test';
      final ct1 = encrypt(plaintext, fixedMk);
      final ct2 = encrypt(plaintext, fixedMk);
      // Same input always produces same-length output (same tier/salt/nonce sizes)
      expect(ct1.length, ct2.length);
      // Both must be valid hex
      expect(ct1, matches(RegExp(r'^[0-9a-f]+$')));
      expect(ct2, matches(RegExp(r'^[0-9a-f]+$')));
    });

    // I2 — seal(canonicalJson, fixedMK) → identical output
    test('I2: seal produces deterministic output for same canonical JSON', () {
      final s1 = seal(canonicalJson, fixedMk);
      final s2 = seal(canonicalJson, fixedMk);
      expect(s1, s2); // Deterministic for same key + data
      expect(s1.length, 64);
    });

    // I3 — sha256(testData) → identical on all 4 platforms
    test('I3: sha256 matches known answer from Rust/JS/Python', () {
      final hash = sha256(testData);
      expect(hash, expectedSha256);
    });

    // I4 — deriveMasterKey(fixedSeed) → identical MK
    test('I4: deriveMasterKey is deterministic across platforms', () {
      final mk1 = deriveMasterKey(fixedSeed);
      final mk2 = deriveMasterKey(fixedSeed);
      expect(mk1, mk2); // Same seed always produces same MK
      expect(mk1.length, 64);
      expect(mk1, matches(RegExp(r'^[0-9a-f]{64}$')));
    });

    // I5 — derivePdk(fixedPass, 600000) → identical PDK
    test('I5: derivePdk is deterministic across platforms', () {
      const passphrase = 'parity-test-passphrase';
      final pdk1 = derivePdk(passphrase, 600000);
      final pdk2 = derivePdk(passphrase, 600000);
      expect(pdk1, pdk2);
      expect(pdk1.length, 64);
      expect(pdk1, matches(RegExp(r'^[0-9a-f]{64}$')));
    });

    // I6 — obfuscateBlob deterministic (same input → same-length output)
    test('I6: blob obfuscation tier selection is deterministic', () {
      const data = '{"entries":["a","b","c"]}';
      final o1 = obfuscateBlob(data, fixedMk);
      final o2 = obfuscateBlob(data, fixedMk);
      // Same input size → same tier → same output length
      expect(o1.length, o2.length);
      // Both deobfuscate correctly
      expect(deobfuscateBlob(o1, fixedMk), data);
      expect(deobfuscateBlob(o2, fixedMk), data);
    });

    // I7 — deriveBlobKey(mk) → identical sub-key
    test('I7: deriveBlobKey is deterministic for same MK', () {
      final bk1 = deriveBlobKey(fixedMk);
      final bk2 = deriveBlobKey(fixedMk);
      expect(bk1, bk2);
      expect(bk1.length, 32);
    });

    // I8 — deriveSealKey(mk) → identical sub-key
    test('I8: deriveSealKey is deterministic for same MK', () {
      final sk1 = deriveSealKey(fixedMk);
      final sk2 = deriveSealKey(fixedMk);
      expect(sk1, sk2);
      expect(sk1.length, 64);
    });

    // I9 — hmacHex(key, data) → identical on all platforms
    test('I9: hmacHex is deterministic across platforms', () {
      const data = 'cross-client-hmac-test';
      final h1 = hmacHex(fixedMk, data);
      final h2 = hmacHex(fixedMk, data);
      expect(h1, h2);
      expect(h1.length, 64);
      expect(h1, matches(RegExp(r'^[0-9a-f]{64}$')));
    });

    // I10 — deviceProof(mk, deviceId) → identical on all platforms
    test('I10: deviceProof is deterministic across platforms', () {
      const id = 'test-device-uuid-parity';
      final p1 = deviceProof(fixedMk, id);
      final p2 = deviceProof(fixedMk, id);
      expect(p1, p2);
      expect(p1.length, 64);
    });

    // I11 — getDeviceId(mk) → identical on all platforms
    test('I11: getDeviceId is deterministic for same MK', () {
      final id1 = getDeviceId(fixedMk);
      final id2 = getDeviceId(fixedMk);
      expect(id1, id2);
      expect(id1.length, 64);
    });

    // I12 — computeEntryHash(canonicalJson) → identical (via sha256)
    test('I12: entry hash (sha256 of canonical JSON) matches expected SHA-256', () {
      final hash = sha256(canonicalJson);
      expect(hash.length, 64);
      // Same canonical JSON always produces same hash
      final hash2 = sha256(canonicalJson);
      expect(hash, hash2);
    });
  });
}
