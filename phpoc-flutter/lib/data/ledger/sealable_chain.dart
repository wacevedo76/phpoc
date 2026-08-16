import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    as helpers show jsonEncodeSortedNoSpaces;
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    show secretToHex;

/// Shared sealed-block-chain machinery (ADR-029/029a) for both sealed chains.
///
/// `LedgerChain` and `CommonplaceChain` both build an append-only, HMAC-SHA256
/// sealed link chain (activity ledger + separate `commonplace.json`, ADR-031)
/// that shares the same Master Key. This mixin centralizes the single source
/// of truth for:
///
///   * seal computation/verification over a per-type field whitelist
///     (`computeSeal` / `verifySeal` / `sealBlock` / `verifyBlockSeal`)
///   * identity-MAC signing parity (`computeIdentityMac` / `verifyIdentityMac`)
///   * `prev_hash` linkage validation (`prevHashValid`)
///   * day-block counting for `day_index` derivation (`countDayBlocks`)
///
/// A concrete chain supplies its own per-type seal-field table
/// (`[sealFieldsByType]`), block-hash resolver (`[getBlockHashFor]`), stored
/// seal-key helper (`[hashKeyFor]`), day-block accessor (`[getDayBlocks]`), and
/// the crypto/identity state. Keeping the seal semantics here avoids the two
/// chains diverging on cross-client ADR-029a serialization (D9, D4).
mixin SealableChain {
  CryptoService get crypto;

  /// Hex-formatted identity secret, or null when signatures are disabled.
  String? get identitySecretHex;

  /// Canonical per-type block-seal field table (ADR-029/029a).
  ///
  /// Seals only these fields; metadata (format_version, key_version, username,
  /// identity_seal, hash keys, ...) is NEVER sealed.
  Map<String, List<String>> get sealFieldsByType;

  /// Which value key holds a block's own seal (`block_hash`, `day_hash`, ...).
  ///
  /// Returns null for an unknown/foreign type.
  String? hashKeyFor(String? type);

  /// Resolve the linkage hash value for [block] (what a successor's `prev_hash`
  /// must equal).
  String getBlockHashFor(Map<String, dynamic> block);

  /// Day-type blocks only (mirrors the chain's own type naming).
  List<Map<String, dynamic>> getDayBlocks();

  // ═══════════════════════════════════════════════════════════════
  // Seal & Identity
  // ═══════════════════════════════════════════════════════════════

  /// Compute a deterministic HMAC-SHA256 seal of [data].
  String computeSeal(Map<String, dynamic> data) {
    final json = jsonSort(data);
    return crypto.seal(json, crypto.getMasterKey()!);
  }

  /// Verify a seal against [data], trying compact, indent2, and no-space
  /// formats (3-way cross-client fallback).
  bool verifySeal(Map<String, dynamic> data, String seal) {
    if (seal.isEmpty) return false;
    final mk = crypto.getMasterKey()!;
    if (crypto.verifySeal(jsonSort(data), seal, mk)) return true;
    if (crypto.verifySeal(jsonSortIndent2(data), seal, mk)) return true;
    final noSpaceJson = helpers.jsonEncodeSortedNoSpaces(data);
    if (crypto.verifySeal(noSpaceJson, seal, mk)) return true;
    return false;
  }

  /// Compute an identity MAC. Returns null if identitySecretHex is null.
  String? computeIdentityMac(String data, String secret) {
    final secretHex = secretToHex(secret)!;
    return crypto.sign(data, secretHex);
  }

  /// Verify an identity MAC.
  bool verifyIdentityMac(String data, String mac, String secret) {
    final secretHex = secretToHex(secret)!;
    return crypto.verifySignature(data, mac, secretHex);
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers (callable by the concrete chain via `with`)
  // ═══════════════════════════════════════════════════════════════

  /// Verify prev_hash linkage between [prev] and [current] blocks.
  ///
  /// (Non-underscore so a `with SealableChain` class in another library can
  /// call it; considered an implementation helper, not public API.)
  bool prevHashValid(Map<String, dynamic>? prev, Map<String, dynamic> current) {
    if (prev == null) return true; // First block has no predecessor
    final expected = getBlockHashFor(prev);
    final actual = current['prev_hash'] as String? ?? '';
    if (expected.isEmpty) return true; // No hash to compare
    return actual == expected;
  }

  /// Count existing day blocks (for day_index computation).
  int countDayBlocks() {
    return getDayBlocks().length;
  }

  /// Compute a seal over the canonical per-type (ADR-029a) seal fields of [block].
  ///
  /// `original_hash` is sealed only when present. Unknown types throw (matches
  /// Python `select_seal_fields` raising `ValueError` on an unknown type).
  String sealBlock(Map<String, dynamic> block) {
    final type = block['type'] as String?;
    final fields = sealFieldsByType[type];
    if (fields == null) {
      throw StateError('Unknown block type for seal: $type');
    }
    return computeSeal(_sealDataFor(block, fields));
  }

  /// Verify a block's internal seal using the 3-way fallback in [verifySeal].
  ///
  /// Extracts only the canonical ADR-029 closed seal fields and verifies the
  /// stored hash against all three cross-client serialization formats.
  bool verifyBlockSeal(Map<String, dynamic> block) {
    final type = block['type'] as String?;
    final hashKey = hashKeyFor(type);
    if (hashKey == null) return false;

    final storedHash = block[hashKey] as String?;
    if (storedHash == null || storedHash.isEmpty) return false;

    final fields = sealFieldsByType[type];
    if (fields == null) return false;
    return verifySeal(_sealDataFor(block, fields), storedHash);
  }

  /// Extract just the ADR-029a seal fields present on [block] for [fields].
  static Map<String, dynamic> _sealDataFor(
      Map<String, dynamic> block, List<String> fields) {
    final sealData = <String, dynamic>{};
    for (final field in fields) {
      if (block.containsKey(field)) {
        sealData[field] = block[field];
      }
    }
    return sealData;
  }
}
