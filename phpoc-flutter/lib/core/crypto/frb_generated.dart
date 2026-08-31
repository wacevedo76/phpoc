/// FFI bindings for phpoc-crypto-core — Dart implementation.
///
/// This file implements the 23-function API surface matching
/// `phpoc-crypto-core/src/frb.rs` exactly. All crypto operations
/// are implemented in pure Dart using `pointycastle` and `crypto`
/// packages, producing byte-identical output to the Rust ring-based
/// implementation.
///
/// When flutter_rust_bridge native compilation is integrated for the
/// target platform, this file will be replaced by auto-generated
/// `flutter_rust_bridge` bindings that call the compiled Rust .so via
/// `dart:ffi`. The API surface and behavior must remain identical.
library frb_generated;

import 'dart:convert' show base64, utf8;
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pointycastle/export.dart';

// ═══════════════════════════════════════════════════════════════════
// Exception class
// ═══════════════════════════════════════════════════════════════════

/// Crypto error that crosses the Dart/Rust boundary.
class FrbCryptoException implements Exception {
  final String message;
  const FrbCryptoException(this.message);
  @override
  String toString() => message;
}

// ═══════════════════════════════════════════════════════════════════
// Constants matching phpoc-crypto-core/src/lib.rs
// ═══════════════════════════════════════════════════════════════════

/// PDK salt: `b"session-salt"` (12 bytes).
const _pdkSalt = 'session-salt';

/// Seal key salt: `b"integrity-key-salt"`.
const _sealKeySalt = 'integrity-key-salt';

/// Blob sub-key prefix: `b"blob-obfuscation"`.
const _blobSubkeyPrefix = 'blob-obfuscation';

/// Integrity domain separator: `b"-integrity"`.
const _integrityDomainSep = '-integrity';

/// Device proof prefix: `b"phpoc:device:"`.
const _deviceProofPrefix = 'phpoc:device:';

/// Field key salt: `b"phpoc-staging-keys-v1"`.
const _fieldKeySalt = 'phpoc-staging-keys-v1';

/// Device ID salt: `b"device:id"`.
const _deviceIdSalt = 'device:id';

/// Obfuscation tiers (bytes).
const _tier64k = 64 * 1024;
const _tier128k = 128 * 1024;
const _tier256k = 256 * 1024;
const _tier512k = 512 * 1024;

// ═══════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════

Uint8List _hexToBytes(String hex) {
  if (hex.length % 2 != 0) throw FrbCryptoException('invalid hex: odd length');
  final result = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < hex.length; i += 2) {
    final byte = int.tryParse(hex.substring(i, i + 2), radix: 16);
    if (byte == null) {
      throw FrbCryptoException('invalid hex: non-hex character');
    }
    result[i ~/ 2] = byte;
  }
  return result;
}

String _bytesToHex(Uint8List bytes) {
  return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
}

/// Decode hex to 32-byte key.
Uint8List _decodeHex32(String hex) {
  final bytes = _hexToBytes(hex);
  if (bytes.length != 32) {
    throw FrbCryptoException('key must be 32 bytes');
  }
  return bytes;
}

/// Decode hex to 16-byte key.
Uint8List _decodeHex16(String hex) {
  final bytes = _hexToBytes(hex);
  if (bytes.length != 16) {
    throw FrbCryptoException('key must be 16 bytes');
  }
  return bytes;
}

Uint8List _randomBytes(int length) {
  final rng = Random.secure();
  return Uint8List.fromList(
    List<int>.generate(length, (_) => rng.nextInt(256)),
  );
}

/// HMAC-SHA256(key, data) → full 32-byte output.
Uint8List _hmacSha256(Uint8List key, Uint8List data) {
  final hmac = crypto.Hmac(crypto.sha256, key);
  final digest = hmac.convert(data);
  return Uint8List.fromList(digest.bytes);
}

/// HMAC-SHA256(key, str) → hex string.
String _hmacHex(Uint8List key, String data) {
  final hmac = crypto.Hmac(crypto.sha256, key);
  final digest = hmac.convert(Uint8List.fromList(utf8.encode(data)));
  return digest.toString();
}

/// HMAC-SHA256(key, str) → truncated hex string.
String _hmacHexTruncated(Uint8List key, String data, int charLen) {
  final full = _hmacHex(key, data);
  return full.substring(0, charLen);
}

/// SHA-256 of a string → 64-char hex.
String _sha256(String data) {
  final bytes = Uint8List.fromList(utf8.encode(data));
  final digest = crypto.sha256.convert(bytes);
  return digest.toString();
}

/// Constant-time comparison of two byte lists.
bool _constantTimeEquals(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}

/// Select the smallest obfuscation tier ≥ size.
int _selectTier(int size) {
  if (size <= _tier64k) return _tier64k;
  if (size <= _tier128k) return _tier128k;
  if (size <= _tier256k) return _tier256k;
  if (size <= _tier512k) return _tier512k;
  throw FrbCryptoException('blob size $size exceeds max tier 512K');
}

/// AES-128-CTR encrypt or decrypt.
Uint8List _aesCtrProcess(Uint8List data, Uint8List key, Uint8List nonce) {
  // Build 16-byte IV: nonce(8) || counter(8) = 0
  final iv = Uint8List(16);
  iv.setAll(0, nonce);
  // iv[8..16] already zero = counter starts at 0

  final params = ParametersWithIV<KeyParameter>(
    KeyParameter(key),
    iv,
  );
  final cipher = CTRStreamCipher(AESEngine())..init(true, params);

  final output = Uint8List(data.length);
  for (var i = 0; i < data.length; i++) {
    output[i] = cipher.returnByte(data[i]);
  }
  return output;
}

// ═══════════════════════════════════════════════════════════════════
// Key Derivation (Group B) — 6 functions
// ═══════════════════════════════════════════════════════════════════

/// PBKDF2-HMAC-SHA256(passphrase, "session-salt", iterations, 32).
String derivePdk(String passphrase, int iterations) {
  final derivator = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64));
  derivator.init(
    Pbkdf2Parameters(
      Uint8List.fromList(_pdkSalt.codeUnits),
      iterations,
      32,
    ),
  );
  final passphraseBytes = Uint8List.fromList(utf8.encode(passphrase));
  return _bytesToHex(derivator.process(passphraseBytes));
}

/// PBKDF2-HMAC-SHA256 with custom 16-byte salt.
String derivePdkWithSalt(String passphrase, String saltHex, int iterations) {
  final salt = _decodeHex16(saltHex);
  final derivator = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64));
  derivator.init(
    Pbkdf2Parameters(salt, iterations, 32),
  );
  final passphraseBytes = Uint8List.fromList(utf8.encode(passphrase));
  return _bytesToHex(derivator.process(passphraseBytes));
}

/// derive_master_key: base64-decode seed → 32 bytes → hex (64 chars).
String deriveMasterKey(String seed) {
  Uint8List decoded;
  try {
    decoded = base64.decode(seed);
  } catch (e) {
    throw FrbCryptoException('invalid base64: $e');
  }
  if (decoded.length != 32) {
    throw FrbCryptoException('key must be 32 bytes');
  }
  return _bytesToHex(decoded);
}

/// HMAC-SHA256(MK, "blob-obfuscation")[:16] → 32 hex chars.
String deriveBlobKey(String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);
  return _hmacHexTruncated(mk, _blobSubkeyPrefix, 32);
}

/// HMAC-SHA256(MK, "integrity-key-salt") → 64 hex chars.
String deriveSealKey(String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);
  return _hmacHex(mk, _sealKeySalt);
}

/// HMAC-SHA256(MK, "phpoc-staging-keys-v1")[:16] → 32 hex chars.
String deriveFieldKey(String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);
  return _hmacHexTruncated(mk, _fieldKeySalt, 32);
}

// ═══════════════════════════════════════════════════════════════════
// AES-128-CTR Encrypt/Decrypt (Group C) — 2 functions
// ═══════════════════════════════════════════════════════════════════

/// AES-128-CTR encrypt with encrypt-then-MAC.
///
/// Wire format: salt(16) || nonce(8) || ciphertext || tag(32) → hex.
String encrypt(String plaintext, String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);
  final salt = _randomBytes(16);
  final nonce = _randomBytes(8);

  // Derive per-operation keys: enc_key = HMAC(MK, salt)[:16]
  final encKey = _hmacSha256(mk, salt).sublist(0, 16);

  // Integrity key = HMAC(MK, salt || "-integrity")[:32]
  final intSaltInput = Uint8List(salt.length + _integrityDomainSep.length);
  intSaltInput.setAll(0, salt);
  intSaltInput.setAll(salt.length, _integrityDomainSep.codeUnits);
  final integrityKey = _hmacSha256(mk, intSaltInput);

  // AES-CTR encrypt
  final plaintextBytes = Uint8List.fromList(utf8.encode(plaintext));
  final ciphertext = _aesCtrProcess(plaintextBytes, encKey, nonce);

  // Auth tag: HMAC-SHA256(integrity_key, nonce || ciphertext)
  final authData = Uint8List(nonce.length + ciphertext.length);
  authData.setAll(0, nonce);
  authData.setAll(nonce.length, ciphertext);
  final tag = _hmacSha256(integrityKey, authData);

  // Assemble: salt(16) || nonce(8) || ciphertext || tag(32)
  final output = Uint8List(16 + 8 + ciphertext.length + 32);
  output.setAll(0, salt);
  output.setAll(16, nonce);
  output.setAll(24, ciphertext);
  output.setAll(24 + ciphertext.length, tag);

  return _bytesToHex(output);
}

/// AES-128-CTR decrypt with auth tag verification.
String decrypt(String ciphertextHex, String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);
  Uint8List data;
  try {
    data = _hexToBytes(ciphertextHex);
  } catch (e) {
    throw FrbCryptoException('invalid hex data: ${e.toString().replaceAll('FrbCryptoException: ', '')}');
  }

  if (data.length < 56) {
    throw FrbCryptoException('decryption failed: data too short');
  }

  final salt = Uint8List.sublistView(data, 0, 16);
  final nonce = Uint8List.sublistView(data, 16, 24);
  final storedTag = Uint8List.sublistView(data, data.length - 32);
  final ciphertext = Uint8List.sublistView(data, 24, data.length - 32);

  // Derive keys
  final encKey = _hmacSha256(mk, salt).sublist(0, 16);

  final intSaltInput = Uint8List(salt.length + _integrityDomainSep.length);
  intSaltInput.setAll(0, salt);
  intSaltInput.setAll(salt.length, _integrityDomainSep.codeUnits);
  final integrityKey = _hmacSha256(mk, intSaltInput);

  // Verify auth tag
  final authData = Uint8List(nonce.length + ciphertext.length);
  authData.setAll(0, nonce);
  authData.setAll(nonce.length, ciphertext);
  final expectedTag = _hmacSha256(integrityKey, authData);

  if (!_constantTimeEquals(storedTag, expectedTag)) {
    throw FrbCryptoException('auth tag mismatch: ciphertext tampered');
  }

  // Decrypt
  final plaintext = _aesCtrProcess(ciphertext, encKey, nonce);
  return utf8.decode(plaintext);
}

// ═══════════════════════════════════════════════════════════════════
// HMAC / Sealing / Signing (Group E) — 6 functions
// ═══════════════════════════════════════════════════════════════════

/// HMAC-SHA256(seal_key, data): seal_key = HMAC(MK, "integrity-key-salt").
String seal(String data, String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);
  final sealKey = _hmacSha256(mk, Uint8List.fromList(_sealKeySalt.codeUnits));
  return _hmacHex(sealKey, data);
}

/// Verify an HMAC-SHA256 seal.
bool verifySeal(String data, String sealHex, String masterKeyHex) {
  try {
    final expected = seal(data, masterKeyHex);
    if (expected.length != sealHex.length) return false;
    // Constant-time
    var diff = 0;
    for (var i = 0; i < expected.length; i++) {
      diff |= expected.codeUnitAt(i) ^ sealHex.codeUnitAt(i);
    }
    return diff == 0;
  } catch (_) {
    return false;
  }
}

/// HMAC-SHA256(identity_secret, data) → sign.
String sign(String data, String identitySecretHex) {
  final secret = _decodeHex32(identitySecretHex);
  return _hmacHex(secret, data);
}

/// Verify an HMAC-SHA256 signature.
bool verifySignature(String data, String signatureHex, String identitySecretHex) {
  try {
    final expected = sign(data, identitySecretHex);
    if (expected.length != signatureHex.length) return false;
    var diff = 0;
    for (var i = 0; i < expected.length; i++) {
      diff |= expected.codeUnitAt(i) ^ signatureHex.codeUnitAt(i);
    }
    return diff == 0;
  } catch (_) {
    return false;
  }
}

/// Generic HMAC-SHA256 with arbitrary hex key.
String hmacHex(String keyHex, String data) {
  final key = _hexToBytes(keyHex);
  return _hmacHex(key, data);
}

// ═══════════════════════════════════════════════════════════════════
// SHA-256 (Group E) — 1 function
// ═══════════════════════════════════════════════════════════════════

/// SHA-256 hash of a string → 64-char hex.
String sha256(String data) {
  return _sha256(data);
}

/// identity_pub_key: hex-decode → 32 bytes → SHA-256 → hex.
///
/// Per PHPSPEC §2.7.1 the secret is 32 raw bytes; the hex string is decoded
/// to bytes before SHA-256 (NOT hashed as a UTF-8 string).
String identityPubKey(String identitySecretHex) {
  final bytes = _decodeHex32(identitySecretHex);
  final digest = crypto.sha256.convert(bytes);
  return digest.toString();
}

// ═══════════════════════════════════════════════════════════════════
// Blob Obfuscation (Group D) — 2 functions
// ═══════════════════════════════════════════════════════════════════

/// Obfuscate a staging blob for remote transport.
///
/// Wire format: salt(16) || nonce(8) || encrypted_payload || tag(32).
/// Payload: original_len(4 BE) || plaintext || random_padding.
String obfuscateBlob(String plaintext, String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);
  final plaintextBytes = Uint8List.fromList(utf8.encode(plaintext));

  if (plaintextBytes.length > _tier512k) {
    throw FrbCryptoException(
      'blob size ${plaintextBytes.length} exceeds max tier 512K',
    );
  }

  final tier = _selectTier(plaintextBytes.length);
  final paddedSize = tier - 4;
  final paddingNeeded = paddedSize - plaintextBytes.length;
  final padding = paddingNeeded > 0 ? _randomBytes(paddingNeeded) : Uint8List(0);

  // Blob sub-key
  final blobKey = _hmacSha256(mk, Uint8List.fromList(_blobSubkeyPrefix.codeUnits)).sublist(0, 16);

  final salt = _randomBytes(16);
  final nonce = _randomBytes(8);

  // Derive per-operation keys from blob key
  final encKey = _hmacSha256(blobKey, salt).sublist(0, 16);

  final intSaltInput = Uint8List(salt.length + _integrityDomainSep.length);
  intSaltInput.setAll(0, salt);
  intSaltInput.setAll(salt.length, _integrityDomainSep.codeUnits);
  final integrityKey = _hmacSha256(blobKey, intSaltInput).sublist(0, 16);

  // Build payload: original_len(4 BE) || plaintext || padding
  final lenBytes = Uint8List(4);
  lenBytes[0] = (plaintextBytes.length >> 24) & 0xFF;
  lenBytes[1] = (plaintextBytes.length >> 16) & 0xFF;
  lenBytes[2] = (plaintextBytes.length >> 8) & 0xFF;
  lenBytes[3] = plaintextBytes.length & 0xFF;

  final payload = Uint8List(4 + plaintextBytes.length + padding.length);
  payload.setAll(0, lenBytes);
  payload.setAll(4, plaintextBytes);
  payload.setAll(4 + plaintextBytes.length, padding);

  // AES-CTR encrypt payload
  final ciphertext = _aesCtrProcess(payload, encKey, nonce);

  // Auth tag
  final authData = Uint8List(nonce.length + ciphertext.length);
  authData.setAll(0, nonce);
  authData.setAll(nonce.length, ciphertext);
  final tag = _hmacSha256(integrityKey, authData);

  // Assemble: salt(16) || nonce(8) || ciphertext || tag(32)
  final output = Uint8List(16 + 8 + ciphertext.length + tag.length);
  output.setAll(0, salt);
  output.setAll(16, nonce);
  output.setAll(24, ciphertext);
  output.setAll(24 + ciphertext.length, tag);

  return base64.encode(output);
}

/// Deobfuscate a staging blob after pulling from remote.
String deobfuscateBlob(String obfuscatedB64, String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);

  Uint8List data;
  try {
    data = base64.decode(obfuscatedB64);
  } catch (e) {
    throw FrbCryptoException('invalid base64: $e');
  }

  if (data.length < 56) {
    throw FrbCryptoException('blob deobfuscation failed: data too short');
  }

  // Blob sub-key
  final blobKey = _hmacSha256(mk, Uint8List.fromList(_blobSubkeyPrefix.codeUnits)).sublist(0, 16);

  final salt = Uint8List.sublistView(data, 0, 16);
  final nonce = Uint8List.sublistView(data, 16, 24);
  final storedTag = Uint8List.sublistView(data, data.length - 32);
  final ciphertext = Uint8List.sublistView(data, 24, data.length - 32);

  // Derive per-operation keys
  final encKey = _hmacSha256(blobKey, salt).sublist(0, 16);

  final intSaltInput = Uint8List(salt.length + _integrityDomainSep.length);
  intSaltInput.setAll(0, salt);
  intSaltInput.setAll(salt.length, _integrityDomainSep.codeUnits);
  final integrityKey = _hmacSha256(blobKey, intSaltInput).sublist(0, 16);

  // Verify auth tag
  final authData = Uint8List(nonce.length + ciphertext.length);
  authData.setAll(0, nonce);
  authData.setAll(nonce.length, ciphertext);
  final expectedTag = _hmacSha256(integrityKey, authData);

  if (!_constantTimeEquals(storedTag, expectedTag)) {
    throw FrbCryptoException('blob deobfuscation failed: wrong key or corrupted data');
  }

  // Decrypt payload
  final payload = _aesCtrProcess(ciphertext, encKey, nonce);

  // Read original length prefix (4 bytes BE)
  if (payload.length < 4) {
    throw FrbCryptoException('blob deobfuscation failed: payload too short');
  }
  final originalLen = (payload[0] << 24) |
      (payload[1] << 16) |
      (payload[2] << 8) |
      payload[3];

  if (4 + originalLen > payload.length) {
    throw FrbCryptoException('blob deobfuscation failed: corrupted length prefix');
  }

  final plaintext = payload.sublist(4, 4 + originalLen);
  return utf8.decode(plaintext);
}

// ═══════════════════════════════════════════════════════════════════
// Random Generation (Group G) — 3 functions
// ═══════════════════════════════════════════════════════════════════

/// Generate a 32-byte seed, base64-encoded (44 chars).
String generateSeed() {
  final bytes = _randomBytes(32);
  return base64.encode(bytes);
}

/// Generate a UUID v4 string.
String generateUuidV4() {
  final bytes = _randomBytes(16);
  bytes[6] = (bytes[6] & 0x0F) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3F) | 0x80; // variant

  final hex = _bytesToHex(bytes);
  return '${hex.substring(0, 8)}-'
      '${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-'
      '${hex.substring(16, 20)}-'
      '${hex.substring(20, 32)}';
}

/// Generate a 16-byte device specifier → 32-char hex.
String generateDeviceSpecifier() {
  return _bytesToHex(_randomBytes(16));
}

// ═══════════════════════════════════════════════════════════════════
// Device Identity (Group F) — 3 functions
// ═══════════════════════════════════════════════════════════════════

/// HMAC-SHA256(MK, "phpoc:device:" + device_id) → 64 hex chars.
String deviceProof(String masterKeyHex, String deviceId) {
  final mk = _decodeHex32(masterKeyHex);
  return _hmacHex(mk, '$_deviceProofPrefix$deviceId');
}

/// Verify a device proof.
bool verifyDeviceProof(String deviceId, String proofHex, String masterKeyHex) {
  try {
    final expected = deviceProof(masterKeyHex, deviceId);
    if (expected.length != proofHex.length) return false;
    var diff = 0;
    for (var i = 0; i < expected.length; i++) {
      diff |= expected.codeUnitAt(i) ^ proofHex.codeUnitAt(i);
    }
    return diff == 0;
  } catch (_) {
    return false;
  }
}

/// HMAC-SHA256(MK, "device:id") → 64 hex chars.
String getDeviceId(String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);
  return _hmacHex(mk, _deviceIdSalt);
}

/// HMAC-SHA256(MK, "phpoc:device:" + deviceSecret) → 64 hex chars.
/// Device-specific ID for I-09 device attribution.
String deriveDeviceId(String masterKeyHex, String deviceSecret) {
  final mk = _decodeHex32(masterKeyHex);
  return _hmacHex(mk, '$_deviceProofPrefix$deviceSecret');
}

/// HMAC-SHA256(MK, "device:secret") → 64 hex chars.
/// Device-local secret for identity derivation.
String getDeviceSecret(String masterKeyHex) {
  final mk = _decodeHex32(masterKeyHex);
  return _hmacHex(mk, 'device:secret');
}

// ═══════════════════════════════════════════════════════════════════
// Authentication Flow (convenience) — 1 function
// ═══════════════════════════════════════════════════════════════════

/// Full auth: derives master key from seed.
/// In production, the passphrase decrypts the seed first.
/// This matches the Rust `authenticate()` which delegates to `derive_master_key()`.
String authenticate(String passphrase, String seed, int iterations) {
  // Mirrors Rust: authenticate delegates to derive_master_key
  return deriveMasterKey(seed);
}
