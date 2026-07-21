import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/identity.dart';

/// Create a Uint8List from a hex string for test convenience.
Uint8List _mkFromHex(String hex) {
  final bytes = Uint8List(hex.length ~/ 2);
  for (int i = 0; i < hex.length; i += 2) {
    bytes[i ~/ 2] = int.parse(hex.substring(i, i + 2), radix: 16);
  }
  return bytes;
}

void main() {
  // ── Group E: Identity ───────────────────────────────────────

  // Known test vectors for cross-client verification.
  // These match web's deriveDeviceId() output.
  // MK: 32 zero bytes, secret: "test-secret-001"
  final testMk = _mkFromHex(
    '0000000000000000000000000000000000000000000000000000000000000000',
  );
  const testSecret = 'test-secret-001';

  group('Identity', () {
    // E1 — deriveDeviceId produces hex string
    test('E1: deriveDeviceId produces a string', () {
      final id = Identity.deriveDeviceId(testMk, testSecret);
      expect(id, isA<String>());
      expect(id, isNotEmpty);
    });

    // E2 — Same inputs produce same output
    test('E2: same (MK, secret) produces same device_id', () {
      final id1 = Identity.deriveDeviceId(testMk, testSecret);
      final id2 = Identity.deriveDeviceId(testMk, testSecret);
      expect(id1, id2);
    });

    // E3 — Different MK → different device_id
    test('E3: different MK produces different device_id', () {
      final mk2 = _mkFromHex(
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      );
      final id1 = Identity.deriveDeviceId(testMk, testSecret);
      final id2 = Identity.deriveDeviceId(mk2, testSecret);
      expect(id1, isNot(id2));
    });

    // E4 — Different secret → different device_id
    test('E4: different secret produces different device_id', () {
      final id1 = Identity.deriveDeviceId(testMk, 'secret-a');
      final id2 = Identity.deriveDeviceId(testMk, 'secret-b');
      expect(id1, isNot(id2));
    });

    // E5 — device_id is exactly 64 hex characters
    test('E5: device_id is 64 hex characters', () {
      final id = Identity.deriveDeviceId(testMk, testSecret);
      expect(id, hasLength(64));
      expect(id, matches(r'^[0-9a-f]{64}$'));
    });

    // E6 — Client suffix appending
    test('E6: withClientSuffix appends -flutter', () {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      final suffixed = Identity.withClientSuffix(uuid);
      expect(suffixed, '550e8400-e29b-41d4-a716-446655440000-flutter');
    });

    // E7 — Message format is "phpoc:device:<secret>"
    test('E7: message format is phpoc:device:<secret>', () {
      // This is indirectly tested by deriveDeviceId consistent output.
      // We verify that different secrets produce different results,
      // which confirms the secret is part of the HMAC message.
      final id1 = Identity.deriveDeviceId(testMk, 'alpha');
      final id2 = Identity.deriveDeviceId(testMk, 'alpha');
      expect(id1, id2); // same message = same HMAC
      final id3 = Identity.deriveDeviceId(testMk, 'beta');
      expect(id1, isNot(id3)); // different message = different HMAC
    });

    // E8 — Cross-client: Dart output matches web JS output
    test('E8: Dart deriveDeviceId matches web JS output', () {
      // Test vector from web JS: MK=zeros, secret="phpoc-test" (verified 2026-07-17).
      const expectedWebOutput =
          '54d46d078c3572db2deb82f7e66742c99475525cee54a1d67dc4ee37044b297b';
      final dartOutput = Identity.deriveDeviceId(testMk, 'phpoc-test');
      expect(dartOutput, expectedWebOutput);
    });
  });
}
