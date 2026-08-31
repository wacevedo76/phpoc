/// Native crypto service backed by the frb_generated.dart Dart implementation
/// of the Rust `phpoc-crypto-core` API surface.
///
/// Mirrors the [CryptoService] public API exactly — 29 public methods.
/// Delegates to `frb_generated.dart` which implements all 23 Rust FFI functions
/// in pure Dart with byte-compatible output.
///
/// In production, when the Rust native library is compiled for the target
/// platform, `frb_generated.dart` will be replaced by auto-generated
/// `flutter_rust_bridge` bindings. The public API contract remains identical.
library crypto_service_native;

import 'dart:convert' show json;
import 'dart:typed_data';

import 'frb_generated.dart' as frb;

import 'package:phpoc_flutter/core/utils/json_utils.dart';

class CryptoServiceNative {
  // ── State ─────────────────────────────────────────────────────

  bool _initialized = false;
  Uint8List? _masterKey; // raw 32-byte MK, zeroed then nulled on clear

  // ── Lifecycle ─────────────────────────────────────────────────

  bool get isInitialized => _initialized;
  bool get hasMasterKey => _masterKey != null;

  Future<void> initialize() async {
    _initialized = true;
  }

  void setMasterKey(String hexKey) {
    _requireInit();
    _masterKey = _hexToBytes(hexKey);
  }

  String? getMasterKey() {
    if (_masterKey == null) return null;
    return _bytesToHex(_masterKey!);
  }

  void clearMasterKey() {
    _masterKey?.fillRange(0, _masterKey!.length, 0);
    _masterKey = null;
  }

  // ── Convenience: cached-key encrypt ───────────────────────────

  String encryptWithCachedKey(String plaintext) {
    _requireKey();
    return encrypt(plaintext, _bytesToHex(_masterKey!));
  }

  String decryptWithCachedKey(String ciphertext) {
    _requireKey();
    return decrypt(ciphertext, _bytesToHex(_masterKey!));
  }

  // ── Key Derivation ────────────────────────────────────────────

  String derivePdk(String passphrase, int iterations) {
    _requireInit();
    return frb.derivePdk(passphrase, iterations);
  }

  String derivePdkWithSalt(String passphrase, String saltHex, int iterations) {
    _requireInit();
    return frb.derivePdkWithSalt(passphrase, saltHex, iterations);
  }

  String deriveMasterKey(String seed) {
    _requireInit();
    return frb.deriveMasterKey(seed);
  }

  String deriveBlobKey(String mkHex) {
    _requireInit();
    return frb.deriveBlobKey(mkHex);
  }

  String deriveSealKey(String mkHex) {
    _requireInit();
    return frb.deriveSealKey(mkHex);
  }

  String deriveFieldKey(String mkHex) {
    _requireInit();
    return frb.deriveFieldKey(mkHex);
  }

  // ── AES-128-CTR Encrypt/Decrypt ───────────────────────────────

  String encrypt(String plaintext, String keyHex) {
    _requireInit();
    return frb.encrypt(plaintext, keyHex);
  }

  String decrypt(String ciphertextHex, String keyHex) {
    _requireInit();
    return frb.decrypt(ciphertextHex, keyHex);
  }

  // ── Blob Obfuscation ──────────────────────────────────────────

  String obfuscateBlob(String data, String mkHex) {
    _requireInit();
    return frb.obfuscateBlob(data, mkHex);
  }

  String deobfuscateBlob(String base64Blob, String mkHex) {
    _requireInit();
    return frb.deobfuscateBlob(base64Blob, mkHex);
  }

  // ── SHA-256 ───────────────────────────────────────────────────

  String sha256(String data) {
    _requireInit();
    return frb.sha256(data);
  }

  /// Derive the identity public key from a hex-encoded identity secret.
  ///
  /// Per PHPSPEC §2.7.1 the secret is 32 raw bytes; the hex string is decoded
  /// to bytes before SHA-256 (NOT hashed as a UTF-8 string). Delegates to
  /// `frb.identityPubKey`.
  String identityPubKey(String identitySecretHex) {
    _requireInit();
    return frb.identityPubKey(identitySecretHex);
  }

  // ── HMAC / Sealing / Signing ──────────────────────────────────

  String seal(String data, String mkHex) {
    _requireInit();
    return frb.seal(data, mkHex);
  }

  bool verifySeal(String data, String sealHex, String mkHex) {
    _requireInit();
    return frb.verifySeal(data, sealHex, mkHex);
  }

  String sign(String data, String secretHex) {
    _requireInit();
    return frb.sign(data, secretHex);
  }

  bool verifySignature(String data, String signatureHex, String secretHex) {
    _requireInit();
    return frb.verifySignature(data, signatureHex, secretHex);
  }

  String hmacHex(String keyHex, String data) {
    _requireInit();
    return frb.hmacHex(keyHex, data);
  }

  // ── Device Identity ───────────────────────────────────────────

  String getDeviceId(String mkHex) {
    _requireInit();
    return frb.getDeviceId(mkHex);
  }

  String deviceProof(String mkHex, String deviceId) {
    _requireInit();
    return frb.deviceProof(mkHex, deviceId);
  }

  bool verifyDeviceProof(String deviceId, String proofHex, String mkHex) {
    _requireInit();
    return frb.verifyDeviceProof(deviceId, proofHex, mkHex);
  }

  String deriveDeviceId(String mkHex, String deviceSecret) {
    _requireInit();
    return frb.deriveDeviceId(mkHex, deviceSecret);
  }

  String getDeviceSecret(String mkHex) {
    _requireInit();
    return frb.getDeviceSecret(mkHex);
  }

  // ── Random Generation ─────────────────────────────────────────

  String generateSeed() {
    _requireInit();
    return frb.generateSeed();
  }

  String generateUuid() {
    _requireInit();
    return frb.generateUuidV4();
  }

  String generateDeviceSpecifier() {
    _requireInit();
    return frb.generateDeviceSpecifier();
  }

  // ── Content Hash ──────────────────────────────────────────────

  String computeEntryHash(Map<String, dynamic> data) {
    _requireInit();
    // Sort keys, serialize as JSON, SHA-256
    final sorted = _sortMap(data);
    final jsonStr = _toJson(sorted);
    return frb.sha256(jsonStr);
  }

  String computeContentHash(Map<String, dynamic> data) {
    _requireInit();
    if (!hasMasterKey) {
      throw frb.FrbCryptoException(
        'computeContentHash requires a cached master key for field decryption',
      );
    }
    final canonical = <String, dynamic>{};
    for (final entry in data.entries) {
      final key = entry.key;
      var value = entry.value;
      // KEEP the `_enc` suffix — do NOT strip (PHPSPEC §5.5/§6.1).
      if (key.endsWith('_enc')) {
        if (value is String && value.isNotEmpty) {
          try {
            // Decrypt; plaintext stays a STRING (no json.decode).
            value = decrypt(value, _bytesToHex(_masterKey!));
          } catch (_) {}
        }
      }
      canonical[key] = value;
    }
    final jsonStr = jsonSort(canonical);
    return frb.sha256(jsonStr);
  }

  // ── Authentication Flow ───────────────────────────────────────

  String authenticate(String passphrase, String seed, int iterations) {
    _requireInit();
    return frb.authenticate(passphrase, seed, iterations);
  }

  // ── Internal helpers ──────────────────────────────────────────

  void _requireInit() {
    if (!_initialized) {
      throw frb.FrbCryptoException(
        'CryptoService not initialized. Call initialize() first.',
      );
    }
  }

  void _requireKey() {
    _requireInit();
    if (!hasMasterKey) {
      throw frb.FrbCryptoException(
        'No master key cached. Call setMasterKey() first.',
      );
    }
  }

  /// Convert hex string to byte list.
  static Uint8List _hexToBytes(String hex) {
    if (hex.length % 2 != 0) {
      throw frb.FrbCryptoException('invalid hex: odd length');
    }
    final result = Uint8List(hex.length ~/ 2);
    for (var i = 0; i < hex.length; i += 2) {
      final byte = int.tryParse(hex.substring(i, i + 2), radix: 16);
      if (byte == null) {
        throw frb.FrbCryptoException('invalid hex: non-hex character');
      }
      result[i ~/ 2] = byte;
    }
    return result;
  }

  /// Convert byte list to lowercase hex string.
  static String _bytesToHex(Uint8List bytes) {
    return bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  /// Sort map keys recursively, with List support.
  static Map<String, dynamic> _sortMap(Map<String, dynamic> map) {
    final sorted = <String, dynamic>{};
    final keys = map.keys.toList()..sort();
    for (final key in keys) {
      final value = map[key];
      if (value is Map<String, dynamic>) {
        sorted[key] = _sortMap(value);
      } else if (value is List) {
        sorted[key] = value.map((v) {
          return v is Map<String, dynamic> ? _sortMap(v) : v;
        }).toList();
      } else {
        sorted[key] = value;
      }
    }
    return sorted;
  }

  /// Serialize to canonical JSON string using dart:convert.
  /// Keys are pre-sorted by [_sortMap] for deterministic output.
  static String _toJson(Map<String, dynamic> map) {
    return json.encode(map);
  }
}
