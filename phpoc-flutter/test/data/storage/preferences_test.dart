import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';

/// Preferences tests — Group G (10 assertions).
///
/// Covers:
///   G1–G10: SharedPreferences CRUD, clear, hasExistingData probe

void main() {
  group('G: Preferences (SharedPreferences)', () {
    late AppPreferences prefs;

    setUp(() async {
      // Use mock/fake SharedPreferences for tests
      prefs = AppPreferences.testInstance();
      await prefs.clearAll(); // Start clean
    });

    tearDown(() async {
      await prefs.clearAll();
    });

    // G1
    test('G1: getWorkerUrl returns null when not set', () async {
      final url = await prefs.getWorkerUrl();
      expect(url, isNull);
    });

    // G2
    test('G2: setWorkerUrl(url) → getWorkerUrl returns the same URL', () async {
      const url = 'https://worker.example.com';
      await prefs.setWorkerUrl(url);
      final result = await prefs.getWorkerUrl();
      expect(result, url);
    });

    // G3
    test('G3: setWorkerUrl(null) clears the stored URL', () async {
      await prefs.setWorkerUrl('https://worker.example.com');
      await prefs.setWorkerUrl(null);
      final result = await prefs.getWorkerUrl();
      expect(result, isNull);
    });

    // G4
    test('G4: getDeviceUuid returns null when not set', () async {
      final uuid = await prefs.getDeviceUuid();
      expect(uuid, isNull);
    });

    // G5
    test('G5: setDeviceUuid(uuid) → getDeviceUuid returns the same UUID', () async {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      await prefs.setDeviceUuid(uuid);
      final result = await prefs.getDeviceUuid();
      expect(result, uuid);
    });

    // G6
    test('G6: getDeviceCookie returns null when not set', () async {
      final cookie = await prefs.getDeviceCookie();
      expect(cookie, isNull);
    });

    // G7
    test('G7: setDeviceCookie(json) → getDeviceCookie returns the same JSON', () async {
      const cookieJson = '{"device_specifier":"abc","creation_time":1234567890}';
      await prefs.setDeviceCookie(cookieJson);
      final result = await prefs.getDeviceCookie();
      expect(result, cookieJson);
    });

    // G8
    test('G8: clearAll removes all stored preferences', () async {
      await prefs.setWorkerUrl('https://worker.example.com');
      await prefs.setDeviceUuid('some-uuid');
      await prefs.setDeviceCookie('{"test":true}');

      await prefs.clearAll();

      expect(await prefs.getWorkerUrl(), isNull);
      expect(await prefs.getDeviceUuid(), isNull);
      expect(await prefs.getDeviceCookie(), isNull);
    });

    // G9
    test('G9: hasExistingData returns true after genesis block is stored', () async {
      // Fresh start — no data
      final before = await prefs.hasExistingData();
      expect(before, isFalse);

      // After a genesis block exists (we simulate this via
      // the database check that hasExistingData performs)
      // For the test, we set the flag directly since the DB check
      // is tested in the integration tests (Group K)
      await prefs.setHasExistingData(true);

      final after = await prefs.hasExistingData();
      expect(after, isTrue);
    });

    // G10
    test('G10: hasExistingData returns false on fresh install', () async {
      final result = await prefs.hasExistingData();
      expect(result, isFalse);
    });
  });
}
