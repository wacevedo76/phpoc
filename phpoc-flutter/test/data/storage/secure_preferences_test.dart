import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';

/// Secure Preferences tests — Group H (6 assertions).
///
/// Covers:
///   H1–H6: flutter_secure_storage API key CRUD, persistence, isolation

void main() {
  group('H: Secure Preferences (flutter_secure_storage)', () {
    late SecurePreferences securePrefs;
    late AppPreferences sharedPrefs;

    setUp(() async {
      // Use test instances — SecurePreferences wraps flutter_secure_storage
      securePrefs = SecurePreferences.testInstance();
      sharedPrefs = AppPreferences.testInstance();
      await securePrefs.deleteApiKey();
      await sharedPrefs.clearAll();
    });

    tearDown(() async {
      await securePrefs.deleteApiKey();
    });

    // H1
    test('H1: getApiKey returns null when not set', () async {
      final key = await securePrefs.getApiKey();
      expect(key, isNull);
    });

    // H2
    test('H2: setApiKey(key) → getApiKey returns the same key', () async {
      const apiKey = 'sk-abc123-def456-ghi789';
      await securePrefs.setApiKey(apiKey);
      final result = await securePrefs.getApiKey();
      expect(result, apiKey);
    });

    // H3
    test('H3: deleteApiKey clears the stored key', () async {
      await securePrefs.setApiKey('sk-to-delete');
      await securePrefs.deleteApiKey();
      final result = await securePrefs.getApiKey();
      expect(result, isNull);
    });

    // H4
    test('H4: API key survives app restart (test by creating new instance)', () async {
      await securePrefs.setApiKey('sk-persist-test');

      // Create a fresh instance (simulates app restart)
      final newInstance = SecurePreferences.testInstance();
      final result = await newInstance.getApiKey();
      expect(result, 'sk-persist-test');

      await newInstance.deleteApiKey();
    });

    // H5
    test('H5: API key is NOT stored in SharedPreferences (separate storage)', () async {
      await securePrefs.setApiKey('sk-isolated');

      // SharedPreferences should NOT have the API key
      final sharedValue = await sharedPrefs.getApiKeyFromSharedPrefs();
      expect(sharedValue, isNull,
        reason: 'API key must only be in secure storage, not SharedPreferences');
    });

    // H6
    test('H6: getApiKey returns correct value after multiple writes (no caching bugs)', () async {
      for (var i = 0; i < 5; i++) {
        await securePrefs.setApiKey('sk-round-$i');
        final result = await securePrefs.getApiKey();
        expect(result, 'sk-round-$i');
      }

      // Final value should be the last one written
      final finalResult = await securePrefs.getApiKey();
      expect(finalResult, 'sk-round-4');
    });
  });
}
