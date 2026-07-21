import 'dart:convert';
import 'dart:typed_data';

/// Base64 encode/decode utilities matching web's base64.js.
///
/// Standard and URL-safe variants.

/// Encode bytes to standard base64 string.
String base64Encode(Uint8List bytes) {
  return base64.encode(bytes);
}

/// Decode standard base64 string to bytes.
Uint8List base64Decode(String str) {
  return base64.decode(str);
}

/// Encode bytes to URL-safe base64 (replaces +→-, /→_, strips =).
String base64UrlEncode(Uint8List bytes) {
  return base64Encode(bytes)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
}

/// Decode URL-safe base64 string to bytes.
Uint8List base64UrlDecode(String str) {
  // Restore padding
  final padded = str.replaceAll('-', '+').replaceAll('_', '/');
  final remainder = padded.length % 4;
  final withPadding = remainder == 0
      ? padded
      : padded + '=' * (4 - remainder);
  return base64Decode(withPadding);
}
