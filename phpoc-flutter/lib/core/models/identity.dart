import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

/// Device identity — derives a device ID from MK + per-device secret.
///
/// Cross-client identity format (I-09): HMAC-SHA256(MK, "phpoc:device:<secret>").
/// Mirrors web's `deriveDeviceId()` and Python's `derive_device_id()`.
class Identity {
  /// Client-type suffix for cross-client identity.
  /// CLI uses '-cli', web uses '-web', mobile uses '-flutter'.
  static const String clientSuffix = 'flutter';

  /// Derive a device ID from the master key and per-device secret.
  ///
  /// Uses HMAC-SHA256 with message "phpoc:device:<secret>".
  /// Returns a 64-character hex string.
  static String deriveDeviceId(Uint8List mk, String deviceSecret) {
    final message = utf8.encode('phpoc:device:$deviceSecret');
    final hmac = Hmac(sha256, mk);
    final digest = hmac.convert(message);
    return digest.toString();
  }

  /// Append the client suffix to a UUID4 device identifier.
  /// e.g., "a1b2c3d4-..." + "-flutter" → "a1b2c3d4-...-flutter"
  static String withClientSuffix(String uuid) {
    return '$uuid-$clientSuffix';
  }
}
