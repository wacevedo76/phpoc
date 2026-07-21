import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;

/// SHA-256 hash utility.
///
/// Wraps package:crypto. Must match web's crypto.sha256() output byte-for-byte.
/// This is a temporary pure-Dart implementation — Phase 2 replaces it with
/// the Rust FFI bridge via flutter_rust_bridge.

/// Compute SHA-256 hex digest of a UTF-8 string.
String sha256(String input) {
  final bytes = utf8.encode(input);
  final digest = crypto.sha256.convert(bytes);
  return digest.toString();
}

/// Compute SHA-256 hex digest of raw bytes.
String sha256Bytes(Uint8List input) {
  final digest = crypto.sha256.convert(input);
  return digest.toString();
}
