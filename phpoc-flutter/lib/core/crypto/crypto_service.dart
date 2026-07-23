import 'dart:convert' show base64, json, utf8;
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pointycastle/export.dart';

/// Base exception for crypto errors.
class CryptoException implements Exception {
  final String message;
  const CryptoException(this.message);
  @override
  String toString() => 'CryptoException: $message';
}

/// Crypto service implementing the full PHPOC crypto contract.
///
/// Implements the 29-method [CryptoService] interface contract defined by
/// the Phase 1 blueprint (docs/planning/flutter/CRYPTO_FFI_PHASE1.md).
///
/// Uses `package:pointycastle` for AES-128-CTR and PBKDF2-SHA256,
/// and `package:crypto` for SHA-256 and HMAC-SHA256.
/// All keys and binary data cross method boundaries as **hex strings**
/// (matching the JS/WASM pattern).
///
/// The Rust FFI equivalent lives in `crypto_service_native.dart` + `frb_generated.dart`
/// and will replace this implementation once flutter_rust_bridge native compilation
/// is fully integrated. Both implementations pass the same test suite.
///
/// ## Key management
///
/// - Master Key is cached in memory as raw bytes (never on disk per Axiom B3).
/// - `clearMasterKey()` zeroes the cached key buffer before nulling the reference.
///
/// ## Wire format (AES-128-CTR + HMAC-SHA256)
///
/// Encrypted output (hex-encoded): salt(16B) || nonce(8B) || ciphertext || auth_tag(32B)
class CryptoService {
  // ── State ─────────────────────────────────────────────────────

  bool _initialized = false;
  Uint8List? _masterKey; // raw 32-byte MK, zeroed then nulled on clear

  // ── Lifecycle ─────────────────────────────────────────────────

  /// Whether [initialize] has completed successfully.
  bool get isInitialized => _initialized;

  /// Whether a master key is currently cached.
  bool get hasMasterKey => _masterKey != null;

  /// Initialize the service (load native library in production).
  ///
  /// Idempotent — calling multiple times is safe.
  Future<void> initialize() async {
    // In production: load Rust .so via flutter_rust_bridge.
    _initialized = true;
  }

  /// Cache a master key in memory for convenience methods.
  ///
  /// [hexKey] must be a 64-char hex string (32 bytes).
  void setMasterKey(String hexKey) {
    _requireInitialized();
    _validateHex(hexKey, 64);
    _masterKey = Uint8List.fromList(_hexToBytes(hexKey));
  }

  /// Return the cached master key as a hex string, or null if not set / cleared.
  String? getMasterKey() {
    if (_masterKey == null) return null;
    return _bytesToHex(_masterKey!);
  }

  /// Evict and zero the cached master key.
  void clearMasterKey() {
    _masterKey?.fillRange(0, _masterKey!.length, 0);
    _masterKey = null;
  }

  // ── Convenience: cached-key encrypt ───────────────────────────

  /// Encrypt using the cached master key. Throws if no key is cached.
  String encryptWithCachedKey(String plaintext) {
    if (!hasMasterKey) {
      throw CryptoException('No master key cached. Call setMasterKey() first.');
    }
    return encrypt(plaintext, _bytesToHex(_masterKey!));
  }

  /// Decrypt using the cached master key. Throws if no key is cached.
  /// Accepts hex-encrypted ciphertext or plain: prefixed values.
  String decryptWithCachedKey(String ciphertext) {
    if (!hasMasterKey) {
      throw CryptoException('No master key cached. Call setMasterKey() first.');
    }
    return decrypt(ciphertext, _bytesToHex(_masterKey!));
  }

  // ── Group B: Key Derivation ───────────────────────────────────

  /// PBKDF2-SHA256 passphrase derivation.
  ///
  /// Produces a deterministic 64-char hex string (32 bytes) from a passphrase
  /// and iteration count. Uses a fixed salt for determinism.
  String derivePdk(String passphrase, int iterations) {
    _requireInitialized();
    // Fixed salt — keeps derivation deterministic for the dev shim.
    // Production Rust FFI will match the exact JS salt scheme.
    const salt = 'phpoc:pdk:fixed-salt:v1';
    final derivator = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64));
    derivator.init(
      Pbkdf2Parameters(
        utf8.encode(salt),
        iterations,
        32, // 32 bytes = 64 hex chars
      ),
    );
    final passphraseBytes = Uint8List.fromList(utf8.encode(passphrase));
    return _bytesToHex(derivator.process(passphraseBytes));
  }

  /// Derive the master key (32 bytes) from a base64-encoded 32-byte seed.
  ///
  /// Throws [FormatException] if [seed] is not valid base64.
  /// Throws [ArgumentError] if decoded seed is not exactly 32 bytes.
  String deriveMasterKey(String seed) {
    _requireInitialized();
    final seedBytes = _decodeBase64Seed(seed);
    // HMAC-SHA256(seed, "phpoc:master-key") → 32 bytes
    final hmac = crypto.Hmac(crypto.sha256, seedBytes);
    final digest = hmac.convert(utf8.encode('phpoc:master-key'));
    return digest.toString();
  }

  /// Derive blob obfuscation sub-key (16 bytes = 32 hex chars).
  ///
  /// HMAC-SHA256(MK, "blob-obfuscation")[:16]
  String deriveBlobKey(String mkHex) {
    _requireInitialized();
    return _hmacSha256Hex(mkHex, 'blob-obfuscation', truncate: 32);
  }

  /// Derive seal sub-key (32 bytes = 64 hex chars).
  ///
  /// HMAC-SHA256(MK, "phpoc:seal-key")
  String deriveSealKey(String mkHex) {
    _requireInitialized();
    return _hmacSha256Hex(mkHex, 'phpoc:seal-key');
  }

  /// Derive field token key for blind index (16 bytes = 32 hex chars).
  ///
  /// HMAC-SHA256(MK, "phpoc:field-key")[:16]
  String deriveFieldKey(String mkHex) {
    _requireInitialized();
    return _hmacSha256Hex(mkHex, 'phpoc:field-key', truncate: 32);
  }

  // ── Group C: AES-128-CTR Encrypt/Decrypt ──────────────────────

  /// AES-128-CTR encrypt with HMAC-SHA256 authentication.
  ///
  /// [keyHex] — 64-char hex master key (first 16 bytes used for AES-128).
  /// Returns hex-encoded: salt(16B) || nonce(8B) || ciphertext || auth_tag(32B).
  String encrypt(String plaintext, String keyHex) {
    _requireInitialized();
    _validateHex(keyHex, 64);
    if (keyHex.isEmpty) throw CryptoException('Key must not be empty');
    final key = Uint8List.fromList(_hexToBytes(keyHex));
    final aesKey = Uint8List.sublistView(key, 0, 16); // AES-128 = 16 bytes

    final salt = _randomBytes(16);
    final nonce = _randomBytes(8);

    final ciphertext = _aesCtrProcess(
      utf8.encode(plaintext),
      aesKey,
      nonce,
      encrypt: true,
    );

    // Auth tag: HMAC-SHA256(aesKey, salt || nonce || ciphertext)
    final authInput = Uint8List(salt.length + nonce.length + ciphertext.length)
      ..setAll(0, salt)
      ..setAll(salt.length, nonce)
      ..setAll(salt.length + nonce.length, ciphertext);
    final tag = _hmacSha256Full(aesKey, authInput);

    final result =
        Uint8List(salt.length + nonce.length + ciphertext.length + tag.length)
          ..setAll(0, salt)
          ..setAll(salt.length, nonce)
          ..setAll(salt.length + nonce.length, ciphertext)
          ..setAll(salt.length + nonce.length + ciphertext.length, tag);

    return _bytesToHex(result);
  }

  /// AES-128-CTR decrypt with HMAC-SHA256 authentication.
  ///
  /// [ciphertextHex] — hex-encoded: salt(16B) || nonce(8B) || ciphertext || auth_tag(32B).
  /// [keyHex] — 64-char hex master key (first 16 bytes used for AES-128).
  /// Throws [StateError] if authentication fails (wrong key or tampered data).
  String decrypt(String ciphertextHex, String keyHex) {
    _requireInitialized();
    _validateHex(
      ciphertextHex,
      null,
      112,
    ); // min: salt(16)+nonce(8)+tag(32)=56 bytes → 112 hex
    _validateHex(keyHex, 64);
    if (ciphertextHex.isEmpty)
      throw CryptoException('Ciphertext must not be empty');
    final key = Uint8List.fromList(_hexToBytes(keyHex));
    final aesKey = Uint8List.sublistView(key, 0, 16);
    final data = _hexToBytes(ciphertextHex);

    // Minimum: salt(16) + nonce(8) + 0 plaintext + tag(32) = 56 bytes
    if (data.length < 56) throw CryptoException('Ciphertext too short');

    final salt = Uint8List.sublistView(data, 0, 16);
    final nonce = Uint8List.sublistView(data, 16, 24);
    final tag = Uint8List.sublistView(data, data.length - 32);
    final ciphertext = Uint8List.sublistView(data, 24, data.length - 32);

    // Verify auth tag
    final authInput = Uint8List(salt.length + nonce.length + ciphertext.length)
      ..setAll(0, salt)
      ..setAll(salt.length, nonce)
      ..setAll(salt.length + nonce.length, ciphertext);
    final expectedTag = _hmacSha256Full(aesKey, authInput);

    if (!_constantTimeEquals(tag, expectedTag)) {
      throw CryptoException(
        'Authentication failed: wrong key or tampered ciphertext',
      );
    }

    final plaintextBytes = _aesCtrProcess(
      ciphertext,
      aesKey,
      nonce,
      encrypt: false,
    );
    return utf8.decode(plaintextBytes);
  }

  // ── Group D: Blob Obfuscation ─────────────────────────────────
  //
  // Canonical wire format (Rust blob.rs / Python remote_sync.py):
  //   salt(16) + nonce(8) + ciphertext(payload) + tag(32)
  //   where payload = original_len(4 BE) + plaintext + random_padding
  //
  // All three implementations (Rust WASM, Python, Flutter Dart) must
  // produce byte-identical output for the same inputs to enable
  // cross-client sync via shared R2 storage.
  //
  // These methods operate on raw bytes — transport layers handle
  // base64 encoding/decoding for JSON-safe contexts independently.

  /// Obfuscate blob data with tier-based padding.
  ///
  /// Implements PHPSPEC §3.6 / §8.5, matching Rust [blob::obfuscate_blob]
  /// and Python [RemoteStagingSync._obfuscate] byte-for-byte.
  ///
  /// Returns raw obfuscated bytes suitable for direct transport push.
  /// Maximum input size is 512 KB.
  Uint8List obfuscateBlob(String data, String mkHex) {
    _requireInitialized();
    _validateHex(mkHex, 64);
    if (data.length > 512 * 1024) {
      throw CryptoException('Blob data exceeds maximum size of 512 KB');
    }

    final plaintext = utf8.encode(data);
    final mk = Uint8List.fromList(_hexToBytes(mkHex));

    // 1. Derive blob sub-key: HMAC-SHA256(MK, "blob-obfuscation")[:16]
    final blobKey = _deriveBlobKeyBytes(mk);

    // 2. Select tier based on plaintext size
    final tier = _selectTier(plaintext.length);
    final paddedSize = tier - 4; // Reserve 4 bytes for original length

    // 3. Generate random salt, nonce, and padding
    final salt = _randomBytes(16);
    final nonce = _randomBytes(8);
    final paddingNeeded = paddedSize - plaintext.length;
    final padding = paddingNeeded > 0
        ? _randomBytes(paddingNeeded)
        : Uint8List(0);

    // 4. Build payload: original_len(4 BE) + plaintext + padding
    final payload = Uint8List(4 + plaintext.length + padding.length);
    _writeUint32BE(payload, 0, plaintext.length);
    payload.setAll(4, plaintext);
    payload.setAll(4 + plaintext.length, padding);

    // 5. Derive encryption and integrity keys from blob key + salt
    final (encKey, integrityKey) = _deriveBlobEncryptionKeys(blobKey, salt);

    // 6. AES-128-CTR encrypt + HMAC-SHA256 tag
    final ciphertextAndTag = _blobEncryptAndTag(
      payload,
      encKey,
      integrityKey,
      nonce,
    );

    // 7. Assemble: salt(16) + nonce(8) + ciphertext + tag(32)
    final result = Uint8List(16 + 8 + ciphertextAndTag.length);
    result.setAll(0, salt);
    result.setAll(16, nonce);
    result.setAll(24, ciphertextAndTag);

    return result;
  }

  /// Deobfuscate blob data.
  ///
  /// Implements PHPSPEC §3.6 / §8.5, matching Rust [blob::deobfuscate_blob]
  /// and Python [RemoteStagingSync._deobfuscate] byte-for-byte.
  ///
  /// [obfuscated] must be raw bytes in the canonical wire format
  /// (as produced by [obfuscateBlob]).
  String deobfuscateBlob(Uint8List obfuscated, String mkHex) {
    _requireInitialized();
    _validateHex(mkHex, 64);

    // Minimum: salt(16) + nonce(8) + tag(32) = 56 bytes
    if (obfuscated.length < 56) {
      throw CryptoException('Blob payload too short (min 56 bytes)');
    }

    final mk = Uint8List.fromList(_hexToBytes(mkHex));
    final salt = Uint8List.sublistView(obfuscated, 0, 16);
    final nonce = Uint8List.sublistView(obfuscated, 16, 24);
    final ciphertext = Uint8List.sublistView(
        obfuscated, 24, obfuscated.length - 32);
    final storedTag =
        Uint8List.sublistView(obfuscated, obfuscated.length - 32);

    // 1. Derive blob sub-key and encryption/integrity keys
    final blobKey = _deriveBlobKeyBytes(mk);
    final (encKey, integrityKey) = _deriveBlobEncryptionKeys(blobKey, salt);

    // 2. Verify HMAC-SHA256 auth tag over nonce + ciphertext
    final authData = Uint8List(8 + ciphertext.length);
    authData.setAll(0, nonce);
    authData.setAll(8, ciphertext);
    final expectedTag = _hmacSha256Full(integrityKey, authData);

    if (!_constantTimeEquals(storedTag, expectedTag)) {
      throw CryptoException(
        'Blob integrity check failed: tampered or wrong key',
      );
    }

    // 3. AES-128-CTR decrypt
    final decrypted = _aesCtrProcess(
      ciphertext,
      encKey,
      nonce,
      encrypt: false,
    );

    // 4. Read original length (first 4 bytes, big-endian u32)
    if (decrypted.length < 4) {
      throw CryptoException('Blob corrupted: decrypted payload too short');
    }
    final originalLen = _readUint32BE(decrypted, 0);
    if (4 + originalLen > decrypted.length) {
      throw CryptoException(
        'Blob corrupted: invalid length prefix $originalLen',
      );
    }

    return utf8.decode(decrypted.sublist(4, 4 + originalLen));
  }

  // ── Group E: SHA-256 ──────────────────────────────────────────

  /// Compute SHA-256 hex digest of a UTF-8 string.
  String sha256(String data) {
    _requireInitialized();
    final bytes = utf8.encode(data);
    final digest = crypto.sha256.convert(bytes);
    return digest.toString();
  }

  // ── Group F: HMAC / Sealing / Signing ─────────────────────────

  /// Create an HMAC-SHA256 seal over data using the master key.
  String seal(String data, String mkHex) {
    _requireInitialized();
    return _hmacSha256Hex(mkHex, data);
  }

  /// Verify an HMAC-SHA256 seal.
  bool verifySeal(String data, String sealHex, String mkHex) {
    _requireInitialized();
    _validateHex(mkHex, 64);
    final expected = seal(data, mkHex);
    return _constantTimeEqualsHex(expected, sealHex);
  }

  /// Sign data with a secret key (HMAC-SHA256).
  String sign(String data, String secretHex) {
    _requireInitialized();
    return _hmacSha256Hex(secretHex, data, keyLength: null);
  }

  /// Verify a signature.
  bool verifySignature(String data, String signatureHex, String secretHex) {
    _requireInitialized();
    _validateHex(secretHex);
    final expected = sign(data, secretHex);
    return _constantTimeEqualsHex(expected, signatureHex);
  }

  /// Compute HMAC-SHA256 of data using a hex key.
  String hmacHex(String keyHex, String data) {
    _requireInitialized();
    return _hmacSha256Hex(keyHex, data);
  }

  // ── Group G: Device Identity ──────────────────────────────────

  /// Derive a deterministic device ID from the master key.
  String getDeviceId(String mkHex) {
    _requireInitialized();
    return _hmacSha256Hex(mkHex, 'phpoc:device-id');
  }

  /// Generate a device proof for cookie-based auth.
  String deviceProof(String mkHex, String deviceId) {
    _requireInitialized();
    return _hmacSha256Hex(mkHex, 'phpoc:device-proof:$deviceId');
  }

  /// Verify a device proof.
  bool verifyDeviceProof(String deviceId, String proofHex, String mkHex) {
    _requireInitialized();
    _validateHex(mkHex, 64);
    final expected = deviceProof(mkHex, deviceId);
    return _constantTimeEqualsHex(expected, proofHex);
  }

  /// Derive a per-device device ID (I-09).
  String deriveDeviceId(String mkHex, String deviceSecret) {
    _requireInitialized();
    return _hmacSha256Hex(mkHex, 'phpoc:device:$deviceSecret');
  }

  /// Derive the device secret from the master key.
  String getDeviceSecret(String mkHex) {
    _requireInitialized();
    return _hmacSha256Hex(mkHex, 'phpoc:device-secret');
  }

  // ── Group H: Random Generation ────────────────────────────────

  /// Generate a cryptographically random 44-char base64 seed (32 bytes).
  String generateSeed() {
    _requireInitialized();
    final bytes = _randomBytes(32);
    return base64.encode(bytes);
  }

  /// Generate a random UUID v4 string.
  String generateUuid() {
    _requireInitialized();
    final bytes = _randomBytes(16);
    // Set version 4 (0100xxxx)
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    // Set variant 1 (10xxxxxx)
    bytes[8] = (bytes[8] & 0x3F) | 0x80;

    final hexStr = _bytesToHex(bytes);
    return '${hexStr.substring(0, 8)}-'
        '${hexStr.substring(8, 12)}-'
        '${hexStr.substring(12, 16)}-'
        '${hexStr.substring(16, 20)}-'
        '${hexStr.substring(20, 32)}';
  }

  /// Generate a random device specifier (16 bytes = 32 hex chars).
  String generateDeviceSpecifier() {
    _requireInitialized();
    return _bytesToHex(_randomBytes(16));
  }

  // ── Group I: Content Hash ─────────────────────────────────────

  /// Compute a deterministic entry hash from a map of field values.
  ///
  /// Uses canonical JSON serialization (sorted keys) then SHA-256.
  String computeEntryHash(Map<String, dynamic> data) {
    _requireInitialized();
    final json = _canonicalJson(data);
    return sha256(json);
  }

  /// Compute the extensible content hash (v0.4.0+).
  ///
  /// Strips `_enc` suffix from keys before hashing, decrypts encrypted
  /// field values using the cached MK. Matches the web `computeContentHash`.
  String computeContentHash(Map<String, dynamic> data) {
    _requireInitialized();
    if (!hasMasterKey) {
      throw CryptoException(
        'computeContentHash requires a cached master key for field decryption',
      );
    }

    final canonical = <String, dynamic>{};
    for (final entry in data.entries) {
      var key = entry.key;
      var value = entry.value;

      // Strip _enc suffix
      if (key.endsWith('_enc')) {
        key = key.substring(0, key.length - 4);
        // Decrypt the value
        if (value is String && value.isNotEmpty) {
          try {
            value = decrypt(value, _bytesToHex(_masterKey!));
            // Try to parse as JSON for proper sorting
            try {
              value = json.decode(value);
            } catch (_) {
              // Keep as string
            }
          } catch (_) {
            // If decryption fails, use the raw value
          }
        }
      }

      canonical[key] = value;
    }

    final jsonStr = _canonicalJson(canonical);
    return sha256(jsonStr);
  }

  // ── Group J: Authentication Flow ──────────────────────────────

  /// Full authentication flow: passphrase → PDK → seed → master key.
  ///
  /// 1. Derive PDK from passphrase + iterations
  /// 2. Use PDK to decrypt the seed (in production, seed is encrypted)
  /// 3. Derive master key from seed
  ///
  /// For the dev shim, the seed is passed in plaintext — production requires
  /// the PDK to decrypt the seed first. This method demonstrates the full
  /// flow API contract.
  String authenticate(String passphrase, String seed, int iterations) {
    _requireInitialized();
    // In production: PDK decrypts the encrypted seed.
    // For the dev shim: seed is plaintext, but PDK still affects the flow
    // (different passphrases → different PDKs, even with same seed).
    final pdk = derivePdk(passphrase, iterations);

    // Use PDK to derive the seed-based key
    final pdkBytes = Uint8List.fromList(_hexToBytes(pdk));
    final seedBytes = _decodeBase64Seed(seed);
    final hmac = crypto.Hmac(crypto.sha256, pdkBytes);
    final digest = hmac.convert(seedBytes);
    return digest.toString();
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  void _requireInitialized() {
    if (!_initialized) {
      throw CryptoException(
        'CryptoService not initialized. Call initialize() first.',
      );
    }
  }

  /// Validate that [hexStr] is valid hex and optionally has exact [length].
  void _validateHex(String hexStr, [int? length, int minLength = 0]) {
    if (hexStr.isEmpty) throw CryptoException('Hex string must not be empty');
    if (hexStr.length % 2 != 0) {
      throw CryptoException(
        'Hex string must have even length, got ${hexStr.length}',
      );
    }
    // Must contain only valid hex characters
    for (var i = 0; i < hexStr.length; i++) {
      final c = hexStr.codeUnitAt(i);
      if (!((c >= 48 && c <= 57) ||
          (c >= 65 && c <= 70) ||
          (c >= 97 && c <= 102))) {
        throw CryptoException(
          'Invalid hex character "${hexStr[i]}" at position $i',
        );
      }
    }
    if (length != null && hexStr.length != length) {
      throw CryptoException(
        'Hex string must be $length chars, got ${hexStr.length}',
      );
    }
    if (minLength > 0 && hexStr.length < minLength) {
      throw CryptoException(
        'Hex string must be at least $minLength chars, got ${hexStr.length}',
      );
    }
  }

  /// Decode a base64 seed and validate it's exactly 32 bytes.
  Uint8List _decodeBase64Seed(String seed) {
    Uint8List decoded;
    try {
      decoded = base64.decode(seed);
    } catch (e) {
      throw CryptoException('Invalid base64 seed: $e');
    }
    if (decoded.length != 32) {
      throw CryptoException(
        'Seed must decode to 32 bytes, got ${decoded.length}',
      );
    }
    return decoded;
  }

  /// Cryptographically secure random bytes.
  Uint8List _randomBytes(int length) {
    final random = Random.secure();
    return Uint8List.fromList(
      List<int>.generate(length, (_) => random.nextInt(256)),
    );
  }

  /// AES-128-CTR encrypt or decrypt.
  Uint8List _aesCtrProcess(
    List<int> data,
    Uint8List key,
    Uint8List nonce, {
    required bool encrypt,
  }) {
    // AES-128 uses a 16-byte key. Use CTR mode with 8-byte nonce extended to 16 bytes.
    final ctrParams = ParametersWithIV<KeyParameter>(
      KeyParameter(Uint8List.fromList(key)),
      Uint8List.fromList([
        ...nonce,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
      ]), // pad nonce to 16 bytes
    );

    final cipher = CTRStreamCipher(AESEngine())..init(encrypt, ctrParams);

    final output = Uint8List(data.length);
    for (var i = 0; i < data.length; i++) {
      output[i] = cipher.returnByte(data[i]);
    }
    return output;
  }

  /// HMAC-SHA256 hex → hex: validate [keyHex], HMAC [message] with SHA-256.
  ///
  /// [keyLength] — if provided, validates exact length; otherwise any even hex.
  /// [truncate] — if provided, returns only the first N hex chars.
  String _hmacSha256Hex(
    String keyHex,
    String message, {
    int? keyLength = 64,
    int? truncate,
  }) {
    _validateHex(keyHex, keyLength);
    final key = Uint8List.fromList(_hexToBytes(keyHex));
    final hmac = crypto.Hmac(crypto.sha256, key);
    final digest = hmac.convert(utf8.encode(message)).toString();
    return truncate != null ? digest.substring(0, truncate) : digest;
  }

  /// HMAC-SHA256 → full 32-byte output as [Uint8List].
  Uint8List _hmacSha256Full(Uint8List key, Uint8List data) {
    final hmac = crypto.Hmac(crypto.sha256, key);
    final digest = hmac.convert(data);
    return Uint8List.fromList(digest.bytes);
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

  /// Constant-time hex comparison.
  bool _constantTimeEqualsHex(String a, String b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
    }
    return diff == 0;
  }

  /// Select the blob size tier in bytes for a given plaintext length.
  /// Returns tier ceiling. Throws [CryptoException] if plaintext exceeds 512K.
  int _selectTier(int plaintextLength) {
    // Tiers: 64K, 128K, 256K, 512K
    const tiers = [65536, 131072, 262144, 524288];
    for (final tier in tiers) {
      if (plaintextLength <= tier) return tier;
    }
    throw CryptoException(
      'Blob size $plaintextLength bytes exceeds max tier 524288 bytes (512K)',
    );
  }

  // ── Canonical blob obfuscation helpers ─────────────────────
  //
  // These implement the Rust blob.rs / Python remote_sync.py wire format.
  // Must be kept byte-identical with phpoc-crypto-core/src/blob.rs.

  /// Derive blob obfuscation sub-key: HMAC-SHA256(MK, "blob-obfuscation")[:16].
  Uint8List _deriveBlobKeyBytes(Uint8List masterKey) {
    return Uint8List.sublistView(
      _hmacSha256Full(masterKey, utf8.encode('blob-obfuscation')),
      0,
      16,
    );
  }

  /// Derive encryption and integrity keys from blob key + salt.
  ///
  /// - enc_key = HMAC-SHA256(blob_key, salt)[:16]
  /// - integrity_key = HMAC-SHA256(blob_key, salt || "-integrity")[:16]
  (Uint8List, Uint8List) _deriveBlobEncryptionKeys(
    Uint8List blobKey,
    Uint8List salt,
  ) {
    final encKey = Uint8List.sublistView(
      _hmacSha256Full(blobKey, salt),
      0,
      16,
    );

    final intSalt = Uint8List(salt.length + 10);
    intSalt.setAll(0, salt);
    intSalt.setAll(salt.length, utf8.encode('-integrity'));
    final integrityKey = Uint8List.sublistView(
      _hmacSha256Full(blobKey, intSalt),
      0,
      16,
    );

    return (encKey, integrityKey);
  }

  /// AES-128-CTR encrypt payload and append HMAC-SHA256 auth tag.
  ///
  /// Returns ciphertext + tag(32). Auth tag is computed over
  /// nonce + ciphertext (matching Rust encrypt_and_tag / Python
  /// _encrypt_and_tag).
  Uint8List _blobEncryptAndTag(
    Uint8List payload,
    Uint8List encKey,
    Uint8List integrityKey,
    Uint8List nonce,
  ) {
    final ciphertext = _aesCtrProcess(
      payload,
      encKey,
      nonce,
      encrypt: true,
    );

    // Auth over nonce + ciphertext
    final authData = Uint8List(8 + ciphertext.length);
    authData.setAll(0, nonce);
    authData.setAll(8, ciphertext);
    final tag = _hmacSha256Full(integrityKey, authData);

    final result = Uint8List(ciphertext.length + tag.length);
    result.setAll(0, ciphertext);
    result.setAll(ciphertext.length, tag);
    return result;
  }

  /// Write a 32-bit unsigned integer in big-endian byte order.
  static void _writeUint32BE(Uint8List buffer, int offset, int value) {
    buffer[offset] = (value >> 24) & 0xFF;
    buffer[offset + 1] = (value >> 16) & 0xFF;
    buffer[offset + 2] = (value >> 8) & 0xFF;
    buffer[offset + 3] = value & 0xFF;
  }

  /// Read a 32-bit unsigned integer in big-endian byte order.
  static int _readUint32BE(Uint8List buffer, int offset) {
    return (buffer[offset] << 24) |
        (buffer[offset + 1] << 16) |
        (buffer[offset + 2] << 8) |
        buffer[offset + 3];
  }

  /// Convert hex string to byte list.
  static Uint8List _hexToBytes(String hex) {
    if (hex.length % 2 != 0)
      throw CryptoException('Hex string must have even length');
    final result = Uint8List(hex.length ~/ 2);
    for (var i = 0; i < hex.length; i += 2) {
      result[i ~/ 2] = int.parse(hex.substring(i, i + 2), radix: 16);
    }
    return result;
  }

  /// Convert byte list to lowercase hex string.
  static String _bytesToHex(Uint8List bytes) {
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  /// Produce a canonical JSON string with sorted keys.
  String _canonicalJson(Map<String, dynamic> data) {
    final sorted = _sortMap(data);
    return json.encode(sorted);
  }

  /// Recursively sort map keys for deterministic JSON output.
  dynamic _sortMap(dynamic value) {
    if (value is Map) {
      final sorted = <String, dynamic>{};
      final keys = value.keys.cast<String>().toList()..sort();
      for (final key in keys) {
        sorted[key] = _sortMap(value[key]);
      }
      return sorted;
    } else if (value is List) {
      return value.map(_sortMap).toList();
    }
    return value;
  }

  // ═══════════════════════════════════════════════════════════════
  // Shared constants + utilities (used by Services layer)
  // ═══════════════════════════════════════════════════════════════

  /// Expected seed byte length (32 bytes).
  static const int seedByteLength = 32;

  /// PBKDF2 iteration count for passphrase-derived key (PDK).
  static const int pdkIterations = 600000;

  /// Minimum allowed passphrase length.
  static const int minPassphraseLength = 8;

  /// Validate that [seedB64] is valid base64 decoding to [seedByteLength] bytes.
  ///
  /// Throws [FormatException] if the seed is invalid (not base64, wrong length).
  static void validateSeedBase64(String seedB64) {
    final decoded = base64.decode(seedB64);
    if (decoded.length != seedByteLength) {
      throw FormatException(
        'Seed must decode to $seedByteLength bytes, got ${decoded.length}',
      );
    }
  }
}
