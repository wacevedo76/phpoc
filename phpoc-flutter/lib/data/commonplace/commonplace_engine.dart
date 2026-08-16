import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show epochToDate;

/// Unified public API for the Commonplace engine — commit, verify, read.
///
/// Coordinates a [CommonplaceChain] over a block store (in-memory fake or
/// [CommonplaceStorage]). Mirrors the ledger engine (Axiom B5): staging →
/// commit (D11) seals commonplace entries into day-grouped sealed blocks;
/// reading decrypts them back.
class CommonplaceEngine {
  final CryptoService crypto;
  final CommonplaceChain chain;
  final dynamic store;
  final String? identitySecret;

  CommonplaceEngine({
    required this.crypto,
    required dynamic store,
    this.identitySecret,
  })  : store = store,
        chain = CommonplaceChain(
          crypto: crypto,
          store: store,
          identitySecret: identitySecret,
        );

  // ═══════════════════════════════════════════════════════════════
  // Genesis
  // ═══════════════════════════════════════════════════════════════

  /// Build and append the Commonplace genesis (delegates to the chain).
  Map<String, dynamic> buildGenesis({
    required String username,
    required String email,
    required String recoverySeedEnc,
    required String identityPubKey,
    required String identitySecretEncFallback,
  }) {
    return chain.buildGenesis(
      username: username,
      email: email,
      recoverySeedEnc: recoverySeedEnc,
      identityPubKey: identityPubKey,
      identitySecretEncFallback: identitySecretEncFallback,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Commit
  // ═══════════════════════════════════════════════════════════════

  /// Seal staged Commonplace entries into sealed day blocks.
  ///
  /// Entries are grouped by UTC date (one day block per date), each field
  /// encrypted at rest, and the chain's tip advanced after every append.
  /// Returns the first 10 chars of the last block hash, or null if no entries.
  String? commit(List<Map<String, dynamic>> entries) {
    if (entries.isEmpty) return null;

    // Group by date (UTC from timestamp_ms) BEFORE preparing.
    final byDate = <String, List<Map<String, dynamic>>>{};
    for (final entry in entries) {
      final ts = entry['timestamp_ms'] as int;
      final date = epochToDate(ts);
      byDate.putIfAbsent(date, () => []).add(entry);
    }

    final dates = byDate.keys.toList()..sort();

    final lastBlock = chain.getLastBlock();
    var prevHash =
        lastBlock != null ? chain.getBlockHashFor(lastBlock) : '0' * 64;

    var lastHash = '';
    for (final date in dates) {
      // The chain's buildDayBlock owns Commonplace entry sealing (encryption +
      // content hash); the engine passes the raw staged entries so nothing
      // unsealed/plain leaks into a block (D11).
      final rawEntries = byDate[date]!;
      final dayBlock = chain.buildDayBlock(
        entries: rawEntries,
        prevHash: prevHash,
        dateStr: date,
      );
      chain.append(dayBlock);

      prevHash = chain.getBlockHashFor(dayBlock);
      lastHash = prevHash;
    }

    if (lastHash.isEmpty) return null;
    return lastHash.length >= 10 ? lastHash.substring(0, 10) : lastHash;
  }

  // ═══════════════════════════════════════════════════════════════
  // Verify
  // ═══════════════════════════════════════════════════════════════

  /// Verify the entire Commonplace chain (delegates to CommonplaceChain).
  bool verify() {
    return chain.verify();
  }

  // ═══════════════════════════════════════════════════════════════
  // Read
  // ═══════════════════════════════════════════════════════════════

  /// Return all committed Commonplace entries in chain order, decrypted.
  List<Map<String, dynamic>> readEntries() {
    final result = <Map<String, dynamic>>[];
    for (final block in chain.getDayBlocks()) {
      final entries = block['entries'] as List<dynamic>? ?? [];
      for (final entry in entries) {
        if (entry is! Map) continue;
        final data = entry['data'] as Map<String, dynamic>?;
        if (data == null) continue;
        result.add(chain.decryptEntryData(data));
      }
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // Accessors
  // ═══════════════════════════════════════════════════════════════

  /// Total number of blocks (delegates to the chain).
  int getBlockCount() {
    return chain.getBlockCount();
  }

  /// All Commonplace blocks in chain order (genesis first).
  List<Map<String, dynamic>> readAll() {
    return chain.readAll();
  }

  /// Only Commonplace day blocks (excludes genesis).
  List<Map<String, dynamic>> getDayBlocks() {
    return chain.getDayBlocks();
  }

  /// The last block, or null.
  Map<String, dynamic>? getLastBlock() {
    return chain.getLastBlock();
  }
}
