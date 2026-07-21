import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/sync/device_cookie.dart';

/// DeviceCookie tests — Group D (12 assertions).
///
/// Covers:
///   D1–D2: create() lifecycle
///   D3–D6: isValidLocally() with TTL, expiry, missing, cleanup
///   D7–D9: matches() same/different/null
///   D10–D11: parseRemote() valid/invalid
///   D12: destroyLocally()

/// In-memory storage for testing (matches the pattern used in storage tests).
class _FakeStorage {
  final Map<String, dynamic> _data = {};

  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

void main() {
  group('D: DeviceCookie — create()', () {
    // D1
    test('D1: create() generates random specifier and persists local cookie', () async {
      final cookie = DeviceCookie();
      final storage = _FakeStorage();
      final deviceId = 'test-device-uuid';

      final remoteCookie = await cookie.create(deviceId, storage);

      // Returns remote cookie dict for push
      expect(remoteCookie, isNotNull);
      expect(remoteCookie!['device_uuid'], deviceId);
      expect(remoteCookie['device_specifier'], isNotEmpty);

      // Local cookie persisted in storage
      final localCookie = await storage.get('cookie');
      expect(localCookie, isNotNull);
      expect(localCookie['device_specifier'], remoteCookie['device_specifier']);
      expect(localCookie['creation_time'], isA<int>());
    });

    // D2
    test('D2: create() returns remote cookie dict for push', () async {
      final cookie = DeviceCookie();
      final storage = _FakeStorage();

      final remoteCookie = await cookie.create('dev-x', storage);

      expect(remoteCookie, isNotNull);
      expect(remoteCookie!.containsKey('device_uuid'), true);
      expect(remoteCookie.containsKey('device_specifier'), true);
      // Remote cookie should NOT contain creation_time (local-only field)
      expect(remoteCookie.containsKey('creation_time'), false);
    });
  });

  group('D: DeviceCookie — isValidLocally()', () {
    // D3
    test('D3: isValidLocally() returns cookie when TTL fresh', () async {
      final cookie = DeviceCookie();
      final storage = _FakeStorage();

      await cookie.create('dev-1', storage);

      final valid = await cookie.isValidLocally(storage, ttlMinutes: 30);
      expect(valid, isNotNull);
      expect(valid!['device_specifier'], isNotEmpty);
    });

    // D4
    test('D4: isValidLocally() returns null when TTL expired', () async {
      final cookie = DeviceCookie();
      final storage = _FakeStorage();

      // Manually insert an expired cookie (creation_time far in past)
      await storage.set('cookie', {
        'device_specifier': 'abc123',
        'creation_time': 1000, // Unix epoch: Jan 1, 1970
      });

      final valid = await cookie.isValidLocally(storage, ttlMinutes: 30);
      expect(valid, isNull);
    });

    // D5
    test('D5: isValidLocally() returns null when no cookie exists', () async {
      final cookie = DeviceCookie();
      final storage = _FakeStorage();

      final valid = await cookie.isValidLocally(storage);
      expect(valid, isNull);
    });

    // D6
    test('D6: isValidLocally() cleans up expired cookie', () async {
      final cookie = DeviceCookie();
      final storage = _FakeStorage();

      await storage.set('cookie', {
        'device_specifier': 'abc123',
        'creation_time': 1000,
      });

      await cookie.isValidLocally(storage, ttlMinutes: 30);

      // Expired cookie should be removed from storage
      final stored = await storage.get('cookie');
      expect(stored, isNull,
          reason: 'Expired cookie must be cleaned up (garbage collection)');
    });
  });

  group('D: DeviceCookie — matches()', () {
    // D7
    test('D7: matches() returns true for identical specifiers', () {
      final cookie = DeviceCookie();
      final local = {'device_specifier': 'abc123'};
      final remote = {'device_specifier': 'abc123'};

      expect(cookie.matches(local, remote), true);
    });

    // D8
    test('D8: matches() returns false for different specifiers', () {
      final cookie = DeviceCookie();
      final local = {'device_specifier': 'abc123'};
      final remote = {'device_specifier': 'xyz789'};

      expect(cookie.matches(local, remote), false);
    });

    // D9
    test('D9: matches() returns false when either specifier empty', () {
      final cookie = DeviceCookie();

      // Empty local
      expect(cookie.matches({'device_specifier': ''}, {'device_specifier': 'abc'}), false);
      // Empty remote
      expect(cookie.matches({'device_specifier': 'abc'}, {'device_specifier': ''}), false);
      // Both empty
      expect(cookie.matches({'device_specifier': ''}, {'device_specifier': ''}), false);
      // Null/missing specifier
      expect(cookie.matches({}, {'device_specifier': 'abc'}), false);
      expect(cookie.matches({'device_specifier': 'abc'}, {}), false);
    });
  });

  group('D: DeviceCookie — parseRemote()', () {
    // D10
    test('D10: parseRemote() decodes JSON bytes to cookie dict', () {
      final cookie = DeviceCookie();
      final jsonBytes = Uint8List.fromList(
        '{"device_uuid":"dev-1","device_specifier":"abc123"}'.codeUnits,
      );

      final parsed = cookie.parseRemote(jsonBytes);

      expect(parsed, isNotNull);
      expect(parsed!['device_uuid'], 'dev-1');
      expect(parsed['device_specifier'], 'abc123');
    });

    // D11
    test('D11: parseRemote() returns null on invalid JSON', () {
      final cookie = DeviceCookie();

      // Invalid bytes
      expect(cookie.parseRemote(Uint8List.fromList([0xFF, 0xFE, 0xFD])), isNull);
      // Empty bytes
      expect(cookie.parseRemote(Uint8List(0)), isNull);
      // null input
      expect(cookie.parseRemote(null), isNull);
    });
  });

  group('D: DeviceCookie — destroyLocally()', () {
    // D12
    test('D12: destroyLocally() removes cookie from storage', () async {
      final cookie = DeviceCookie();
      final storage = _FakeStorage();

      await cookie.create('dev-1', storage);
      expect(await storage.get('cookie'), isNotNull);

      await cookie.destroyLocally(storage);

      expect(await storage.get('cookie'), isNull);
    });
  });
}
