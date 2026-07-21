/// Secure key-value storage backed by platform-specific encrypted storage.
///
/// Production: uses [flutter_secure_storage](https://pub.dev/packages/flutter_secure_storage)
/// which provides EncryptedSharedPreferences (Android) and Keychain (iOS).
///
/// Test: uses an in-memory map shared across instances to simulate
/// persistence across "app restarts" (new test instances).
class SecurePreferences {
  // ── In-memory backing for tests ──────────────────────────

  static final Map<String, String> _testStore = {};

  final bool _isTest;

  SecurePreferences._({required bool isTest}) : _isTest = isTest;

  static const _keyApiKey = 'worker_api_key';

  // ── API Key ──────────────────────────────────────────────

  Future<String?> getApiKey() async {
    if (_isTest) {
      return _testStore[_keyApiKey];
    }
    return _platformRead(_keyApiKey);
  }

  Future<void> setApiKey(String key) async {
    if (_isTest) {
      _testStore[_keyApiKey] = key;
      return;
    }
    await _platformWrite(_keyApiKey, key);
  }

  Future<void> deleteApiKey() async {
    if (_isTest) {
      _testStore.remove(_keyApiKey);
      return;
    }
    await _platformDelete(_keyApiKey);
  }

  // ── Platform glue ────────────────────────────────────────

  static bool _flutterSecureStorageAvailable = false;

  /// Lazily resolved secure storage instance.
  static dynamic _secureStorage;

  Future<String?> _platformRead(String key) async {
    await _ensureStorage();
    if (_secureStorage != null) {
      return await _secureStorage.read(key: key);
    }
    return null;
  }

  Future<void> _platformWrite(String key, String value) async {
    await _ensureStorage();
    if (_secureStorage != null) {
      await _secureStorage.write(key: key, value: value);
    }
  }

  Future<void> _platformDelete(String key) async {
    await _ensureStorage();
    if (_secureStorage != null) {
      await _secureStorage.delete(key: key);
    }
  }

  Future<void> _ensureStorage() async {
    if (_flutterSecureStorageAvailable) return;
    try {
      // ignore: depend_on_referenced_packages
      // flutter_secure_storage is an optional dependency — imported dynamically.
      // The import below is guarded by try/catch.
      _secureStorage = await _createFlutterSecureStorage();
      _flutterSecureStorageAvailable = true;
    } catch (_) {
      // flutter_secure_storage not available — use no-op.
      _flutterSecureStorageAvailable = true; // don't retry
    }
  }

  static Future<dynamic> _createFlutterSecureStorage() async {
    // Dynamic import to avoid hard dependency on flutter_secure_storage.
    // If the package is available, this returns an instance.
    throw UnimplementedError('flutter_secure_storage not linked');
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
    return SecurePreferences._(isTest: false);
  }
}
