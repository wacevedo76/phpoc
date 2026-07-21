import 'dart:convert' show json, utf8;
import 'dart:math';
import 'dart:typed_data';

/// Device cookie creation and validation.
///
/// Port of web src/sync/cookie.js.
///
/// The device cookie is an auth-gate mechanism for staging sync:
/// - Remote cookie: {"device_uuid": "UUID", "device_specifier": "random"}
/// - Local cookie:  {"device_specifier": "same random", "creation_time": epoch_ms}
class DeviceCookie {
  static const _cookieKey = 'cookie';

  /// Generate a cryptographically random 16-byte specifier as hex string.
  static String _generateSpecifier() {
    final random = Random.secure();
    final bytes = Uint8List(16);
    for (var i = 0; i < 16; i++) {
      bytes[i] = random.nextInt(256);
    }
    return _bytesToHex(bytes);
  }

  // ── Cookie lifecycle ──────────────────────────────────────────

  /// Create a new device cookie.
  ///
  /// Generates a random device_specifier, persists the local cookie
  /// to [storage], and returns the remote cookie dict for push.
  Future<Map<String, dynamic>?> create(String deviceId, dynamic storage) async {
    try {
      final specifier = DeviceCookie._generateSpecifier();
      final epochMs = DateTime.now().millisecondsSinceEpoch;

      final localCookie = {
        'device_specifier': specifier,
        'creation_time': epochMs,
      };

      await storage.set(_cookieKey, localCookie);

      return {
        'device_uuid': deviceId,
        'device_specifier': specifier,
      };
    } catch (_) {
      return null;
    }
  }

  // ── Local cookie validation ───────────────────────────────────

  /// Check if a local device cookie exists and its TTL has not expired.
  ///
  /// Returns the local cookie dict {device_specifier, creation_time}
  /// if valid, null if missing or expired.
  Future<Map<String, dynamic>?> isValidLocally(
    dynamic storage, {
    int ttlMinutes = 30,
  }) async {
    try {
      final localCookie = await storage.get(_cookieKey);
      if (localCookie == null) return null;

      final specifier = localCookie['device_specifier'] as String?;
      final createdAt = localCookie['creation_time'] as int?;

      if (specifier == null || specifier.isEmpty || createdAt == null) {
        try {
          await storage.remove(_cookieKey);
        } catch (_) {}
        return null;
      }

      final now = DateTime.now().millisecondsSinceEpoch;
      final elapsedMs = now - createdAt;
      final ttlMs = ttlMinutes * 60 * 1000;

      if (elapsedMs > ttlMs) {
        try {
          await storage.remove(_cookieKey);
        } catch (_) {}
        return null;
      }

      return {'device_specifier': specifier, 'creation_time': createdAt};
    } catch (_) {
      return null;
    }
  }

  // ── Cookie comparison ─────────────────────────────────────────

  /// Compare device_specifier between local and remote cookies.
  bool matches(Map<String, dynamic>? localCookie, Map<String, dynamic>? remoteCookie) {
    final localSpec = (localCookie?['device_specifier'] as String?) ?? '';
    final remoteSpec = (remoteCookie?['device_specifier'] as String?) ?? '';
    return localSpec.isNotEmpty && remoteSpec.isNotEmpty && localSpec == remoteSpec;
  }

  // ── Remote cookie parsing ─────────────────────────────────────

  /// Parse raw bytes from remote into a cookie dict.
  Map<String, dynamic>? parseRemote(Uint8List? rawBytes) {
    if (rawBytes == null || rawBytes.isEmpty) return null;
    try {
      final text = utf8.decode(rawBytes);
      final decoded = json.decode(text);
      if (decoded is Map<String, dynamic>) return decoded;
      return null;
    } catch (_) {
      return null;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────

  /// Remove the local device cookie from storage.
  Future<void> destroyLocally(dynamic storage) async {
    try {
      await storage.remove(_cookieKey);
    } catch (_) {}
  }

  // ── Helpers ───────────────────────────────────────────────────

  static String _bytesToHex(Uint8List bytes) {
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }
}
