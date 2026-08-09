import 'dart:convert';

import '../crypto/crypto_service.dart';

/// Shared decryption helpers used by both [LedgerPullService] and
/// [OnboardingService] to decrypt PHPSPEC block entry fields.
///
/// Both services need to try two encryption schemes: the Flutter engine's
/// symmetric [CryptoService.encrypt] (raw-mk scheme) and the Python CLI's
/// HMAC-derived sub-key scheme ([CryptoService.decryptFieldValue]). The
/// auth tags differ, so we try each until one authenticates.
mixin DecryptHelpers {
  CryptoService get crypto;

  /// Decrypt a field value trying both encryption schemes.
  ///
  /// Returns `null` if [encHex] is empty or both schemes fail.
  String? decryptFieldValue(String encHex, String mkHex) {
    if (encHex.isEmpty) return null;
    // Flutter/symmetric scheme (dominant for locally-committed blocks)
    try {
      return crypto.decrypt(encHex, mkHex);
    } catch (_) {}
    // Python/CryptoManager scheme (imported CLI / testdata blocks)
    try {
      return crypto.decryptFieldValue(encHex, mkHex);
    } catch (_) {
      return null;
    }
  }

  /// Decrypt an encrypted epoch string to an int. Returns 0 on null or
  /// failure.
  int decryptEpoch(String? encHex, String mkHex) {
    if (encHex == null || encHex.isEmpty) return 0;
    final plain = decryptFieldValue(encHex, mkHex);
    return (plain != null) ? (int.tryParse(plain) ?? 0) : 0;
  }

  /// Decrypt an encrypted pauses JSON array string.
  List<dynamic> decryptPauses(String? encHex, String mkHex) {
    if (encHex == null || encHex.isEmpty) return <dynamic>[];
    final plain = decryptFieldValue(encHex, mkHex);
    if (plain == null) return <dynamic>[];
    try {
      final decoded = jsonDecode(plain);
      return (decoded is List) ? decoded : <dynamic>[];
    } catch (_) {
      return <dynamic>[];
    }
  }
}
