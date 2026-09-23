import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/device_cookie.dart';

void main() {
  // ── Group D: DeviceCookie ───────────────────────────────────

  const testCookie = DeviceCookie(
    deviceUuid: '550e8400-e29b-41d4-a716-446655440000-flutter',
    deviceSpecifier: 'abc123def4567890',
    creationTime: 1700000000,
  );

  group('DeviceCookie', () {
    // D1 — Construct with all fields
    test('D1: construct with all fields', () {
      expect(testCookie.deviceUuid, '550e8400-e29b-41d4-a716-446655440000-flutter');
      expect(testCookie.deviceSpecifier, 'abc123def4567890');
      expect(testCookie.creationTime, 1700000000);
    });

    // D2 — JSON roundtrip
    test('D2: toJson → fromJson roundtrip is equal', () {
      final restored = DeviceCookie.fromJson(testCookie.toJson());
      expect(restored, testCookie);
    });

    // D3 — JSON deserialization with missing field throws
    test('D3: fromJson throws on missing device_uuid', () {
      expect(
        () => DeviceCookie.fromJson({
          'device_specifier': 'abc',
          'creation_time': 100,
        }),
        throwsA(anything),
      );
    });

    // D4 — isValid within TTL
    test('D4: isValid returns true within TTL', () {
      // Cookie created now-ish → should be valid for 30 min TTL
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final cookie = DeviceCookie(
        deviceUuid: 'test',
        deviceSpecifier: 'spec',
        creationTime: now,
      );
      expect(cookie.isValid(1800), true); // 30 min TTL
    });

    // D5 — isValid returns false when expired
    test('D5: isValid returns false when TTL expired', () {
      // Cookie created 1 hour ago → expired for 30 min TTL
      final oneHourAgo = DateTime.now().millisecondsSinceEpoch ~/ 1000 - 3600;
      final cookie = DeviceCookie(
        deviceUuid: 'test',
        deviceSpecifier: 'spec',
        creationTime: oneHourAgo,
      );
      expect(cookie.isValid(1800), false);
    });

    // D6 — isValid at exact TTL boundary
    test('D6: isValid at exact TTL boundary', () {
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      // Exactly 30 min ago
      final exactBoundary = now - 1800;
      final cookie = DeviceCookie(
        deviceUuid: 'test',
        deviceSpecifier: 'spec',
        creationTime: exactBoundary,
      );
      // At boundary: elapsed == TTL → should NOT be valid (strict <)
      expect(cookie.isValid(1800), false);
    });

    // D7 — isValid with large TTL (24 hours)
    test('D7: isValid with 24-hour TTL', () {
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final oneHourAgo = now - 3600;
      final cookie = DeviceCookie(
        deviceUuid: 'test',
        deviceSpecifier: 'spec',
        creationTime: oneHourAgo,
      );
      expect(cookie.isValid(86400), true);
    });

    // D8 — isValid with 0 TTL returns false
    test('D8: isValid with 0 TTL returns false', () {
      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final cookie = DeviceCookie(
        deviceUuid: 'test',
        deviceSpecifier: 'spec',
        creationTime: now,
      );
      expect(cookie.isValid(0), false);
    });

    // D9 — Two cookies with same specifier are equal
    test('D9: identical cookies are equal', () {
      const a = DeviceCookie(
        deviceUuid: 'u1', deviceSpecifier: 's1', creationTime: 100,
      );
      const b = DeviceCookie(
        deviceUuid: 'u1', deviceSpecifier: 's1', creationTime: 100,
      );
      expect(a, b);
    });

    // D10 — Different specifiers are not equal
    test('D10: different specifiers are not equal', () {
      const a = DeviceCookie(
        deviceUuid: 'u1', deviceSpecifier: 's1', creationTime: 100,
      );
      const b = DeviceCookie(
        deviceUuid: 'u1', deviceSpecifier: 's2', creationTime: 100,
      );
      expect(a, isNot(b));
    });

    // ── ADR-034 P1 — stagingHash/seq/lastSeenHash/lastSeenSeq ───────────

    // E16 — toJson/fromJson round-trip the new schema fields
    test('E16: toJson/fromJson round-trips stagingHash/seq/lastSeenHash/lastSeenSeq', () {
      final cookie = DeviceCookie(
        deviceUuid: 'u',
        deviceSpecifier: 's',
        creationTime: 100,
        stagingHash: 'abc',
        seq: 5,
        lastSeenHash: 'def',
        lastSeenSeq: 6,
      );

      final json = cookie.toJson();
      expect(json['staging_hash'], 'abc');
      expect(json['seq'], 5);
      expect(json['last_seen_hash'], 'def');
      expect(json['last_seen_seq'], 6);

      final restored = DeviceCookie.fromJson(json);
      expect(restored.stagingHash, 'abc');
      expect(restored.seq, 5);
      expect(restored.lastSeenHash, 'def');
      expect(restored.lastSeenSeq, 6);
      expect(restored, cookie);
    });

    // E17 — fromJson tolerates absent new fields (defaults null/0)
    test('E17: fromJson tolerates absent new fields (defaults null/0)', () {
      final cookie = DeviceCookie.fromJson({
        'device_uuid': 'u',
        'device_specifier': 's',
        'creation_time': 100,
      });
      expect(cookie.stagingHash, isNull);
      expect(cookie.seq, 0);
      expect(cookie.lastSeenHash, isNull);
      expect(cookie.lastSeenSeq, 0);
    });
  });
}
