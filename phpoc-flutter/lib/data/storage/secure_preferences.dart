import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Secure key-value storage backed by platform-specific encrypted storage.
///
/// Production: uses [FlutterSecureStorage] which provides
/// EncryptedSharedPreferences (Android) and Keychain (iOS).
///
/// Test: uses an in-memory map shared across instances to simulate
/// persistence across "app restarts" (new test instances).
class SecurePreferences {
  // ── In-memory backing for tests ──────────────────────────

  static final Map<String, String> _testStore = {};

  final bool _isTest;
  final FlutterSecureStorage? _secureStorage;

  SecurePreferences._({required this._isTest, this._secureStorage});

  static const _keyApiKey = 'worker_api_key';

  // ── API Key ──────────────────────────────────────────────

  Future<String?> getApiKey() async {
    if (_isTest) {
      return _testStore[_keyApiKey];
    }
    return _secureStorage!.read(key: _keyApiKey);
  }

  Future<void> setApiKey(String key) async {
    if (_isTest) {
      _testStore[_keyApiKey] = key;
      return;
    }
    await _secureStorage!.write(key: _keyApiKey, value: key);
  }

  Future<void> deleteApiKey() async {
    if (_isTest) {
      _testStore.remove(_keyApiKey);
      return;
    }
    await _secureStorage!.delete(key: _keyApiKey);
  }

  // ── Factories ────────────────────────────────────────────

  /// Test instance backed by an in-memory map.
  ///
  /// The map is shared across all test instances in the same process,
  /// simulating persistent secure storage (e.g., Keychain).
  factory SecurePreferences.testInstance() {
    return SecurePreferences._(isTest: true);
  }

  /// Production instance backed by the platform's secure storage.
  factory SecurePreferences() {
    return SecurePreferences._(
      isTest: false,
      secureStorage: FlutterSecureStorage(),
    );
  }
}
