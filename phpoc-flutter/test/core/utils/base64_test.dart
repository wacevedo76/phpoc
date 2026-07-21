import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/utils/base64.dart';

void main() {
  // ── Group G: Base64 ──────────────────────────────────────────

  group('Base64', () {
    // G1 — Encode/decode roundtrip
    test('G1: encode → decode roundtrip', () {
      final original = Uint8List.fromList(
        'Hello, World!'.codeUnits,
      );
      final encoded = base64Encode(original);
      final decoded = base64Decode(encoded);
      expect(decoded, original);
    });

    // G2 — Standard encode: "Hello World" → known output
    test('G2: standard encode matches known output', () {
      final bytes = Uint8List.fromList('Hello World'.codeUnits);
      expect(base64Encode(bytes), 'SGVsbG8gV29ybGQ=');
    });

    // G3 — Standard decode: known input → "Hello World"
    test('G3: standard decode matches known output', () {
      final decoded = base64Decode('SGVsbG8gV29ybGQ=');
      expect(String.fromCharCodes(decoded), 'Hello World');
    });

    // G4 — URL-safe encode replaces +→-, /→_, strips =
    test('G4: URL-safe encode replaces special chars', () {
      // Bytes that produce + and / in standard base64
      final bytes = Uint8List.fromList([0xFF, 0xFF, 0xFF]);
      final urlEncoded = base64UrlEncode(bytes);
      expect(urlEncoded, isNot(contains('+')));
      expect(urlEncoded, isNot(contains('/')));
      expect(urlEncoded, isNot(contains('=')));
    });

    // G5 — URL-safe decode handles -, _, and missing padding
    test('G5: URL-safe decode roundtrip', () {
      final original = Uint8List.fromList([0xFF, 0xFF, 0xFF]);
      final encoded = base64UrlEncode(original);
      final decoded = base64UrlDecode(encoded);
      expect(decoded, original);
    });

    // G6 — Empty Uint8List: encode → ""
    test('G6: empty bytes encode to empty string', () {
      final encoded = base64Encode(Uint8List(0));
      expect(encoded, '');
    });

    // G7 — Empty string: decode → empty Uint8List
    test('G7: empty string decodes to empty bytes', () {
      final decoded = base64Decode('');
      expect(decoded, isEmpty);
    });

    // G8 — Decode throws on invalid base64 character
    test('G8: decode throws on invalid base64', () {
      expect(
        () => base64Decode('!!!invalid!!!'),
        throwsA(anything),
      );
    });

    // G9 — Encode single byte (0xFF) → "/w=="
    test('G9: single byte encode padding', () {
      final encoded = base64Encode(Uint8List.fromList([0xFF]));
      expect(encoded, '/w==');
    });

    // G10 — Encode two bytes (0xFF, 0xFF) → "//8="
    test('G10: two-byte encode padding', () {
      final encoded = base64Encode(Uint8List.fromList([0xFF, 0xFF]));
      expect(encoded, '//8=');
    });
  });
}
