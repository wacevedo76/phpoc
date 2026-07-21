import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/utils/hash_utils.dart';

void main() {
  // ── Group I: Hash Utils ─────────────────────────────────────

  group('sha256', () {
    // I1 — SHA-256 of "hello" produces correct digest
    test('I1: SHA-256 of "hello" matches known vector', () {
      // SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
      const expected =
          '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
      expect(sha256('hello'), expected);
    });

    // I2 — SHA-256 of empty string
    test('I2: SHA-256 of empty string matches known vector', () {
      const expected =
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      expect(sha256(''), expected);
    });

    // I3 — SHA-256 of binary data
    test('I3: sha256Bytes matches known vector', () {
      final bytes = Uint8List.fromList([0x00, 0x01, 0x02, 0x03]);
      // sha256("\x00\x01\x02\x03")
      const expected =
          '054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8';
      expect(sha256Bytes(bytes), expected);
    });

    // I4 — Cross-client: matches web output
    test('I4: sha256 output matches web crypto.sha256', () {
      // Same input should produce same hash as web's crypto.sha256()
      // SHA-256("cross-client-test") = verified 2026-07-17.
      const expectedWeb =
          '1689ce21460b8b7991b8039a9dcaefb00a302d2b410323928bf9bfcc6324a164';
      expect(sha256('cross-client-test'), expectedWeb);
    });

    // I5 — SHA-256 of large input
    test('I5: SHA-256 of 100KB input', () {
      final large = 'x' * 100000; // 100KB of 'x'
      final result = sha256(large);
      expect(result, hasLength(64));
      expect(result, matches(r'^[0-9a-f]{64}$'));
    });

    // I6 — Deterministic: same input → same output
    test('I6: repeated calls produce same output', () {
      const input = 'deterministic-test';
      final h1 = sha256(input);
      final h2 = sha256(input);
      final h3 = sha256(input);
      expect(h1, h2);
      expect(h2, h3);
    });

    // I7 — Different inputs → different outputs
    test('I7: different inputs produce different outputs', () {
      final h1 = sha256('alpha');
      final h2 = sha256('beta');
      expect(h1, isNot(h2));
    });
  });
}
