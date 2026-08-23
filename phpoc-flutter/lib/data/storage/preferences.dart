import 'package:shared_preferences/shared_preferences.dart';

/// Thin wrapper around SharedPreferences for app-level config values.
///
/// Production: backed by platform SharedPreferences.
/// Test: backed by an in-memory Map (synchronous).
class AppPreferences {
  final Map<String, dynamic>? _store;
  final SharedPreferences? _prefs;

  AppPreferences._test(this._store) : _prefs = null;
  AppPreferences._prod(this._prefs) : _store = null;

  bool get _isTest => _store != null;

  // ── Keys ─────────────────────────────────────────────────

  static const _keyWorkerUrl = 'worker_url';
  static const _keyDeviceUuid = 'device_uuid';
  static const _keyDeviceCookie = 'device_cookie';
  static const _keyHasExistingData = 'has_existing_data';
  static const _keyThemeMode = 'theme_mode';
  static const _keyBiometricEnabled = 'biometric_enabled';
  static const _keyBookMode = 'book_mode';
  static const _keyHasRekeyed = 'has_rekeyed';
  static const _keySeedFingerprint = 'seed_fingerprint';
  static const _keyNewSeedRevealed = 'new_seed_revealed';

  // ── Worker URL ───────────────────────────────────────────

  Future<String?> getWorkerUrl() async {
    if (_isTest) return _store![_keyWorkerUrl] as String?;
    return _prefs!.getString(_keyWorkerUrl);
  }

  Future<void> setWorkerUrl(String? url) async {
    if (_isTest) {
      if (url == null) {
        _store!.remove(_keyWorkerUrl);
      } else {
        _store![_keyWorkerUrl] = url;
      }
      return;
    }
    if (url == null) {
      await _prefs!.remove(_keyWorkerUrl);
    } else {
      await _prefs!.setString(_keyWorkerUrl, url);
    }
  }

  // ── Device UUID ──────────────────────────────────────────

  Future<String?> getDeviceUuid() async {
    if (_isTest) return _store![_keyDeviceUuid] as String?;
    return _prefs!.getString(_keyDeviceUuid);
  }

  Future<void> setDeviceUuid(String uuid) async {
    if (_isTest) {
      _store![_keyDeviceUuid] = uuid;
      return;
    }
    await _prefs!.setString(_keyDeviceUuid, uuid);
  }

  // ── Device Cookie ────────────────────────────────────────

  Future<String?> getDeviceCookie() async {
    if (_isTest) return _store![_keyDeviceCookie] as String?;
    return _prefs!.getString(_keyDeviceCookie);
  }

  Future<void> setDeviceCookie(String json) async {
    if (_isTest) {
      _store![_keyDeviceCookie] = json;
      return;
    }
    await _prefs!.setString(_keyDeviceCookie, json);
  }

  // ── Existing Data ────────────────────────────────────────

  Future<bool> hasExistingData() async {
    if (_isTest) return _store![_keyHasExistingData] as bool? ?? false;
    return _prefs!.getBool(_keyHasExistingData) ?? false;
  }

  Future<void> setHasExistingData(bool value) async {
    if (_isTest) {
      _store![_keyHasExistingData] = value;
      return;
    }
    await _prefs!.setBool(_keyHasExistingData, value);
  }

  // ── Theme Mode ──────────────────────────────────────────

  /// Returns 'light', 'dark', or 'system' (default).
  Future<String> getThemeMode() async {
    if (_isTest) return _store![_keyThemeMode] as String? ?? 'system';
    return _prefs!.getString(_keyThemeMode) ?? 'system';
  }

  Future<void> setThemeMode(String mode) async {
    if (_isTest) {
      _store![_keyThemeMode] = mode;
      return;
    }
    await _prefs!.setString(_keyThemeMode, mode);
  }

  // ── Biometric Enabled ───────────────────────────────────

  /// Whether the user has opted into biometric unlock.
  /// Returns false by default (opt-in).
  bool isBiometricEnabled() {
    if (_isTest) return _store![_keyBiometricEnabled] as bool? ?? false;
    return _prefs!.getBool(_keyBiometricEnabled) ?? false;
  }

  Future<void> setBiometricEnabled(bool value) async {
    if (_isTest) {
      _store![_keyBiometricEnabled] = value;
      return;
    }
    await _prefs!.setBool(_keyBiometricEnabled, value);
  }

  // ── Book Mode (PH Ledger / Commonplace Book) ─────────────

  /// Returns the active book mode ('ledger' default, or 'commonplace').
  Future<String> getBookMode() async {
    if (_isTest) return _store![_keyBookMode] as String? ?? 'ledger';
    return _prefs!.getString(_keyBookMode) ?? 'ledger';
  }

  Future<void> setBookMode(String mode) async {
    if (_isTest) {
      _store![_keyBookMode] = mode;
      return;
    }
    await _prefs!.setString(_keyBookMode, mode);
  }

  // ── Seed re-key markers (C-2) ────────────────────────────

  /// Whether a full seed re-key has already been recorded (double-run guard,
  /// B3). Stored in preferences — never in the ledger block schema.
  Future<bool> hasRekeyed() async {
    if (_isTest) return _store![_keyHasRekeyed] as bool? ?? false;
    return _prefs!.getBool(_keyHasRekeyed) ?? false;
  }

  Future<void> setHasRekeyed(bool value) async {
    if (_isTest) {
      _store![_keyHasRekeyed] = value;
      return;
    }
    await _prefs!.setBool(_keyHasRekeyed, value);
  }

  /// The HMAC seed fingerprint recorded at re-key time, for drift detection
  /// (B4).
  Future<String?> getSeedFingerprint() async {
    if (_isTest) return _store![_keySeedFingerprint] as String?;
    return _prefs!.getString(_keySeedFingerprint);
  }

  Future<void> setSeedFingerprint(String fp) async {
    if (_isTest) {
      _store![_keySeedFingerprint] = fp;
      return;
    }
    await _prefs!.setString(_keySeedFingerprint, fp);
  }

  /// Whether the new seed reveal dialog has already been shown (S6 — shown
  /// once, never auto-re-shown).
  Future<bool> hasNewSeedBeenRevealed() async {
    if (_isTest) return _store![_keyNewSeedRevealed] as bool? ?? false;
    return _prefs!.getBool(_keyNewSeedRevealed) ?? false;
  }

  Future<void> setNewSeedRevealed(bool value) async {
    if (_isTest) {
      _store![_keyNewSeedRevealed] = value;
      return;
    }
    await _prefs!.setBool(_keyNewSeedRevealed, value);
  }

  // ── Clear ────────────────────────────────────────────────

  Future<void> clearAll() async {
    if (_isTest) {
      _store!.clear();
      return;
    }
    await _prefs!.clear();
  }

  /// Record the completed re-key: marker + seed fingerprint. Also marks the
  /// reveal dialog as pending (not yet shown).
  Future<void> recordRekey(String fingerprint) async {
    await setHasRekeyed(true);
    await setSeedFingerprint(fingerprint);
    await setNewSeedRevealed(false);
  }

  // ── API key isolation check (H5) ─────────────────────────

  Future<String?> getApiKeyFromSharedPrefs() async {
    if (_isTest) return _store!['api_key'] as String?;
    return _prefs!.getString('api_key');
  }

  // ── Pre-resolved instance (set in main.dart before runApp) ─

  /// Set by [setInstance] before [runApp].
  /// Read by [providers.dart] to decide production vs test.
  static AppPreferences? preResolvedInstance;

  /// Set the production [AppPreferences] instance before [runApp].
  /// Call from main() after [AppPreferences.open].
  static void setInstance(AppPreferences instance) {
    preResolvedInstance = instance;
  }

  // ── Factories ────────────────────────────────────────────

  /// Synchronous test instance backed by an in-memory map.
  factory AppPreferences.testInstance() {
    return AppPreferences._test({});
  }

  /// Production instance backed by platform SharedPreferences.
  static Future<AppPreferences> open() async {
    final prefs = await SharedPreferences.getInstance();
    return AppPreferences._prod(prefs);
  }
}
