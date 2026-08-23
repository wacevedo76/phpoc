import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pointycastle/export.dart';

import '../core/crypto/crypto_service.dart' show CryptoException;
import '../data/ledger/helpers.dart' show getBlockHash, verifyEntryHashTwoWay;

/// Pure, isolate-sendable stage helpers for the ledger pull path
/// (`lib/services/ledger_pull_service.dart`).
///
/// Both functions are extracted as **top-level** (closure-free) functions so
/// they can be safely handed to a background isolate via the `OffloadRunner`
/// seam (see [isolateOffloadRunner]) — the core ANR fix for the restore-pull
/// path. They MUST NOT capture any instance state.
///
/// Fix blueprint: `docs/planning/flutter/RESTORE_PULL_ISOLATE_FIX_PHASE1.md`.
///
/// Phase 3 (GREEN): `decodePullBlockBytes` is a self-contained re-implementation
/// of `CryptoService.deobfuscateBlob` (no service instance dependency, so it is
/// safe to send to an isolate); `validatePulledChain` is the top-level move of
/// the former `LedgerPullService._validateImportedChain` body. Both are
/// behavior-preserving (D4/D5/D9): same wire format, same exceptions, same
/// validation order.

/// Boundary through which CPU-bound pull stages are executed on a
/// background isolate in production.
///
/// Takes a [compute] closure (the pure stage function already lowered to a
/// sendable signature) and runs it, returning its result. Tests inject an
/// inline runner (runs on the current isolate) for hermetic, deterministic
/// coverage without spawning real isolates.
typedef OffloadRunner = Future<T> Function<T>(FutureOr<T> Function() compute);

/// Production [OffloadRunner]: offloads the closure to a fresh background
/// isolate via [Isolate.run].
///
/// The closure must be isolate-sendable (no captured closures over service
/// instances); the pure stage functions in this file satisfy that.
Future<T> isolateOffloadRunner<T>(FutureOr<T> Function() compute) async {
  return Isolate.run(compute);
}

/// Deobfuscate a single raw block blob into its PHPSPEC JSON string.
///
/// Self-contained re-implementation of `CryptoService.deobfuscateBlob`
/// (PHPSPEC §3.6 / §8.5, matching Rust `blob::deobfuscate_blob` and Python
/// `RemoteStagingSync._deobfuscate` byte-for-byte):
///
///   salt(16) ‖ nonce(8) ‖ ciphertext ‖ tag(32)
///
/// 1. Derive blob sub-key: HMAC-SHA256(MK, "blob-obfuscation")[:16]
/// 2. Derive enc/integrity keys from blob key + salt.
/// 3. Verify HMAC-SHA256 integrity tag over nonce + ciphertext.
/// 4. AES-128-CTR decrypt; read original_len (4 BE) + plaintext.
///
/// Returns the decrypted JSON **string** (the caller parses it), and throws
/// [CryptoException] on tamper/wrong-key/short-blob — identical to the
/// service method so error handling is unchanged (D9).
String decodePullBlockBytes(Uint8List obfuscated, String mkHex) {
  _validateHex(mkHex, 64);

  // Minimum: salt(16) + nonce(8) + tag(32) = 56 bytes
  if (obfuscated.length < 56) {
    throw CryptoException('Blob payload too short (min 56 bytes)');
  }

  final mk = _hexToBytes(mkHex);
  final salt = Uint8List.sublistView(obfuscated, 0, 16);
  final nonce = Uint8List.sublistView(obfuscated, 16, 24);
  final ciphertext =
      Uint8List.sublistView(obfuscated, 24, obfuscated.length - 32);
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
    throw CryptoException('Blob integrity check failed: tampered or wrong key');
  }

  // 3. AES-128-CTR decrypt
  final decrypted =
      _aesCtrProcess(ciphertext, encKey, nonce, encrypt: false);

  // 4. Read original length (first 4 bytes, big-endian u32)
  if (decrypted.length < 4) {
    throw CryptoException('Blob corrupted: decrypted payload too short');
  }
  final originalLen = _readUint32BE(decrypted, 0);
  if (4 + originalLen > decrypted.length) {
    throw CryptoException('Blob corrupted: invalid length prefix $originalLen');
  }

  return utf8.decode(decrypted.sublist(4, 4 + originalLen));
}

/// Validate an assembled chain in-place before import (D4 guard).
///
/// Mirrors the former `LedgerPullService._validateImportedChain` exactly:
/// genesis type, per-entry hash (4-way fallback), and prev_hash linkage.
/// Throws on the first validation failure [FormatException]; returns `void`
/// on success.
///
/// Uses only top-level helpers ([getBlockHash], [verifyEntryHashTwoWay]) so it
/// is safe to run on a background isolate, keeping the D4 integrity guarantee
/// while being off the UI thread.
void validatePulledChain(List<Map<String, dynamic>> blocks) {
  // ── Genesis check ──────────────────────────────────────
  if (blocks.isEmpty) {
    throw const FormatException('Remote chain is empty');
  }
  final genesis = blocks.first;
  if (genesis['type'] != 'genesis') {
    throw FormatException(
        'Remote chain must start with a genesis block (type: "genesis")');
  }

  // ── Per-entry hash verification ────────────────────────
  for (var i = 0; i < blocks.length; i++) {
    final block = blocks[i];
    final type = block['type'] as String? ?? 'day';
    if (type == 'genesis' || type == 'year_summary' || type == 'month_summary') {
      continue;
    }
    final entries = block['entries'] as List<dynamic>? ?? [];
    for (var j = 0; j < entries.length; j++) {
      final entry = entries[j];
      if (entry is! Map<String, dynamic>) {
        throw FormatException('Malformed entry at block $i, entry $j');
      }
      final data = entry['data'] as Map<String, dynamic>?;
      final hash = entry['hash'] as String?;
      if (data == null || hash == null) {
        throw FormatException(
            'Malformed entry at block $i, entry $j — missing hash or data');
      }

      // 4-way fallback: sort+indent2 → sort+compact → compact-nospace → nosort+indent2
      if (!verifyEntryHashTwoWay(data, hash)) {
        throw FormatException(
            'Entry hash mismatch at block $i, entry $j. '
            'Hash: $hash does not match any serialization format for data: $data');
      }
    }
  }

  // ── Prev_hash chain linkage ─────────────────────────────
  for (var i = 1; i < blocks.length; i++) {
    final prevHash = getBlockHash(blocks[i - 1]);
    final actualPrev = blocks[i]['prev_hash'] as String? ?? '';
    if (prevHash.isNotEmpty && actualPrev != prevHash) {
      throw FormatException(
          'Prev_hash linkage break at block $i: '
          'expected $prevHash, got $actualPrev');
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Self-contained crypto primitives (mirror CryptoService internals)
// ═══════════════════════════════════════════════════════════════

/// Validate that [hexStr] is valid hex and optionally has exact [length].
void _validateHex(String hexStr, [int? length]) {
  if (hexStr.length % 2 != 0) {
    throw CryptoException('Hex string must have even length, got ${hexStr.length}');
  }
  for (var i = 0; i < hexStr.length; i++) {
    final c = hexStr.codeUnitAt(i);
    if (!((c >= 48 && c <= 57) ||
        (c >= 65 && c <= 70) ||
        (c >= 97 && c <= 102))) {
      throw CryptoException('Invalid hex character "${hexStr[i]}" at position $i');
    }
  }
  if (length != null && hexStr.length != length) {
    throw CryptoException('Hex string must be $length chars, got ${hexStr.length}');
  }
}

/// Convert a hex string to bytes.
Uint8List _hexToBytes(String hex) {
  if (hex.length % 2 != 0) {
    throw CryptoException('Hex string must have even length');
  }
  final result = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < hex.length; i += 2) {
    result[i ~/ 2] = int.parse(hex.substring(i, i + 2), radix: 16);
  }
  return result;
}

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

/// AES-128-CTR encrypt or decrypt (CTR mode, 8-byte nonce padded to 16).
Uint8List _aesCtrProcess(
  List<int> data,
  Uint8List key,
  Uint8List nonce, {
  required bool encrypt,
}) {
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
    ]),
  );

  final cipher = CTRStreamCipher(AESEngine())..init(encrypt, ctrParams);

  final output = Uint8List(data.length);
  for (var i = 0; i < data.length; i++) {
    output[i] = cipher.returnByte(data[i]);
  }
  return output;
}

/// HMAC-SHA256 over data → full 32-byte [Uint8List].
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

/// Read a 32-bit unsigned integer in big-endian byte order.
int _readUint32BE(Uint8List buffer, int offset) {
  return (buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3];
}
