import 'dart:io' show Platform;

import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Secure key-value storage backed by platform-specific encrypted storage.
///
/// Production: uses [FlutterSecureStorage] which provides
/// EncryptedSharedPreferences (Android) and Keychain (iOS).
/// On Linux, requires a Secret Service daemon (e.g., gnome-keyring) to be
/// running. Falls back to an in-memory warning mode when the keyring is
/// unavailable.
///
/// Test: uses an in-memory map shared across instances to simulate
/// persistence across "app restarts" (new test instances).
class SecurePreferences {
  // ── In-memory backing for tests ──────────────────────────

  static final Map<String, String> _testStore = {};

  final bool _isTest;
  final FlutterSecureStorage? _secureStorage;

  /// True when the Linux keyring is unavailable and operations fall back to
  /// in-memory storage (data lost on restart).
  bool get isUsingFallback => _useFallback;
  bool _useFallback = false;
  final Map<String, String> _fallbackStore = {};

  SecurePreferences._({required this._isTest, this._secureStorage});

  static const _keyApiKey = 'worker_api_key';

  static const _linuxKeyringHint =
      'On Linux, gnome-keyring must be installed and running. '
      'Install it with: sudo apt install gnome-keyring  (Debian/Ubuntu) '
      'or: sudo pacman -S gnome-keyring  (Arch). '
      'Then start it with: gnome-keyring-daemon --start --components=secrets';

  // ── API Key ──────────────────────────────────────────────

  Future<String?> getApiKey() async {
    if (_isTest) {
      return _testStore[_keyApiKey];
    }
    if (_useFallback) {
      return _fallbackStore[_keyApiKey];
    }
    try {
      return await _secureStorage!.read(key: _keyApiKey);
    } on PlatformException catch (e) {
      if (_isLinuxKeyringError(e)) {
        _enableFallback(null);
        return null;
      }
      rethrow;
    }
  }

  Future<void> setApiKey(String key) async {
    if (_isTest) {
      _testStore[_keyApiKey] = key;
      return;
    }
    if (_useFallback) {
      _fallbackStore[_keyApiKey] = key;
      return;
    }
    try {
      await _secureStorage!.write(key: _keyApiKey, value: key);
    } on PlatformException catch (e) {
      if (_isLinuxKeyringError(e)) {
        _enableFallback(key);
        return;
      }
      rethrow;
    }
  }

  Future<void> deleteApiKey() async {
    if (_isTest) {
      _testStore.remove(_keyApiKey);
      return;
    }
    if (_useFallback) {
      _fallbackStore.remove(_keyApiKey);
      return;
    }
    try {
      await _secureStorage!.delete(key: _keyApiKey);
    } on PlatformException catch (e) {
      if (_isLinuxKeyringError(e)) {
        _enableFallback(null);
        _fallbackStore.remove(_keyApiKey);
        return;
      }
      rethrow;
    }
  }

  /// Check whether a [PlatformException] is a Linux keyring availability
  /// error (libsecret cannot reach the Secret Service daemon).
  bool _isLinuxKeyringError(PlatformException e) {
    if (!Platform.isLinux) return false;
    final msg = e.message ?? '';
    return msg.contains('keyring') ||
        msg.contains('unlick') ||
        msg.contains('unlock') ||
        msg.contains('Libsecret') ||
        msg.contains('Libsect') ||
        msg.contains('secret');
  }

  /// Enable the in-memory fallback and log a warning.
  void _enableFallback(String? firstValue) {
    _useFallback = true;
    if (firstValue != null) {
      _fallbackStore[_keyApiKey] = firstValue;
    }
    // ignore: avoid_print
    print('WARNING: Linux keyring unavailable — using in-memory fallback. '
        '${_linuxKeyringHint}');
  }

  /// Returns a hint for users when the keyring is not available.
  static String get linuxKeyringHint => _linuxKeyringHint;

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
