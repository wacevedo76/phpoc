import 'dart:convert';
import 'dart:typed_data';

import '../core/crypto/crypto_service.dart';
import '../core/models/pull_result.dart';
import '../data/commonplace/commonplace_chain.dart';
import '../data/sync/staging_paths.dart';
import '../data/sync/transport.dart';
import 'chain_transport_helpers.dart';

/// Pulls the full Commonplace sealed chain from a remote Worker/R2 blob store
/// under the `commonplace/...` prefix, importing it **append-only** onto the
/// local [chain] (ADR-031 remote-sync slice).
///
/// Pulls `commonplace/hash_index.json` (plaintext) to discover block count,
/// then pulls each `commonplace/blocks/NNNNNN.json`, deobfuscates with the
/// master key, validates the assembled chain (genesis-first, seals, prev_hash
/// linkage), and merges it via `CommonplaceChain.reconcileRemoteChain` — skip
/// identical, append a bridging tail, report a conflict without writing.
///
/// Simpler than `LedgerPullService` by design: there is no staging seed and no
/// background-isolate offload seam, because a Commonplace chain is a small,
/// personal sealed book (not the activity ledger's long staging-backed chain).
class CommonplacePullService {
  final CryptoService crypto;
  final HttpTransport? transport;
  final CommonplaceChain chain;

  /// Guard against concurrent [pullAll] calls.
  Future<PullResult>? _inFlightPull;

  /// Guard against concurrent [pullIfRemoteHasMore] calls.
  Future<PullResult>? _inFlightFreshness;

  CommonplacePullService({
    required this.crypto,
    required this.transport,
    required this.chain,
  });

  /// Build the remote block path for a 0-based chain index.
  static String _blockPath(int index) =>
      '${StagingPaths.commonplaceBlocksPrefix}'
      '${index.toString().padLeft(6, '0')}.json';

  /// Pull all remote blocks and import them append-only onto [chain].
  ///
  /// Requires [CryptoService.hasMasterKey] — throws [StateError] if no master
  /// key is cached. If [transport] is null, returns an empty ok result (no-op
  /// for local-only mode). Concurrent calls are serialized.
  Future<PullResult> pullAll() async {
    if (!crypto.hasMasterKey) {
      throw StateError('No master key cached. Call setMasterKey() first.');
    }
    final mkHex = crypto.getMasterKey()!;

    if (transport == null) {
      return PullResult.ok(blocksPulled: 0);
    }

    if (_inFlightPull != null) return _inFlightPull!;

    _inFlightPull = _doPullAll(mkHex);
    try {
      return await _inFlightPull!;
    } finally {
      _inFlightPull = null;
    }
  }

  Future<PullResult> _doPullAll(String mkHex) async {
    final t = transport!;
    final errors = <String>[];
    final failedBlocks = <int>[];

    // Step 1: pull the plaintext hash index to discover block count.
    List<dynamic> hashIndex;
    try {
      final raw = await t.pull(StagingPaths.commonplaceHashIndex);
      if (raw == null) {
        // No remote chain — nothing to pull.
        return PullResult.ok(blocksPulled: 0);
      }
      hashIndex = jsonDecode(utf8.decode(raw)) as List<dynamic>;
    } catch (e) {
      errors.add('Failed to pull commonplace/hash_index.json: $e');
      return PullResult.failure(errors: errors);
    }

    if (hashIndex.isEmpty) {
      return PullResult.ok(blocksPulled: 0);
    }

    // Step 2: fetch + deobfuscate + parse each block in ascending index order.
    final remoteBlocks = <Map<String, dynamic>>[];
    for (var i = 0; i < hashIndex.length; i++) {
      final block = await _fetchDecodeBlock(t, mkHex, i, failedBlocks, errors);
      if (block != null) remoteBlocks.add(block);
    }

    // Step 3: validate the assembled remote chain before importing.
    if (remoteBlocks.isNotEmpty) {
      if (remoteBlocks.first['type'] != 'commonplace_genesis') {
        errors.add('Remote chain does not start with a genesis block.');
        return PullResult.failure(errors: errors);
      }
      if (!chain.verifyBlocks(remoteBlocks)) {
        errors.add('Remote chain failed integrity validation.');
        return PullResult.failure(errors: errors);
      }
    }

    // Step 4: append-only import (skip identical, append bridging tail,
    // report conflict without writing).
    if (remoteBlocks.isNotEmpty) {
      final reconcile = chain.reconcileRemoteChain(remoteBlocks);
      if (reconcile.hasConflicts) {
        errors.add(
          'Remote chain conflicts with local chain at '
          '${reconcile.conflictedIndices}.',
        );
        return PullResult.failure(errors: errors);
      }
    }

    if (failedBlocks.isEmpty && errors.isEmpty) {
      return PullResult.ok(blocksPulled: remoteBlocks.length);
    }
    return PullResult.failure(
      blocksPulled: remoteBlocks.length,
      failedBlocks: failedBlocks,
      errors: errors,
    );
  }

  /// Pull the remote Commonplace chain only when it has grown past the local
  /// chain (freshness detector — mirrors the ledger's ADR-030 rule).
  ///
  /// Compares the plaintext remote block count (`commonplace/hash_index.json`
  /// length) against [localBlockCount]:
  ///   - remote absent/empty or not greater → 0 fresh blocks;
  ///   - remote greater → the number of new blocks available (returned as
  ///     [PullResult.blocksPulled]).
  ///
  /// Requires [CryptoService.hasMasterKey] — throws [StateError] if no master
  /// key is cached. Concurrent calls are serialized.
  Future<PullResult> pullIfRemoteHasMore({
    required int localBlockCount,
  }) async {
    if (!crypto.hasMasterKey) {
      throw StateError('No master key cached. Call setMasterKey() first.');
    }
    final t = transport;
    if (t == null) {
      return PullResult.ok(blocksPulled: 0);
    }

    if (_inFlightFreshness != null) return _inFlightFreshness!;

    _inFlightFreshness = _doPullIfRemoteHasMore(t, localBlockCount);
    try {
      return await _inFlightFreshness!;
    } finally {
      _inFlightFreshness = null;
    }
  }

  /// Core freshness check: fetch the plaintext `commonplace/hash_index.json`
  /// and compare its length against [localBlockCount] (delegates to the shared
  /// [pullRemoteHasMore] helper — fail-safe on network/auth failure or a
  /// missing/empty index).
  Future<PullResult> _doPullIfRemoteHasMore(
    HttpTransport t,
    int localBlockCount,
  ) {
    return pullRemoteHasMore(
      transport: t,
      hashIndexPath: StagingPaths.commonplaceHashIndex,
      localBlockCount: localBlockCount,
    );
  }

  /// Fetch, deobfuscate, and parse a single block from the remote.
  ///
  /// Returns the parsed block map on success, or null on failure (appending to
  /// [failedBlocks] and [errors]).
  Future<Map<String, dynamic>?> _fetchDecodeBlock(
    HttpTransport t,
    String mkHex,
    int index,
    List<int> failedBlocks,
    List<String> errors,
  ) async {
    final path = _blockPath(index);

    // Pull raw bytes.
    final Uint8List raw;
    try {
      final pulled = await t.pull(path);
      if (pulled == null) {
        failedBlocks.add(index);
        return null;
      }
      raw = pulled;
    } catch (e) {
      errors.add('Failed to pull block $index: $e');
      failedBlocks.add(index);
      return null;
    }

    // Deobfuscate (wrong MK or tampered blob throws).
    final String decoded;
    try {
      decoded = crypto.deobfuscateBlob(raw, mkHex);
    } catch (e) {
      errors.add('Failed to deobfuscate block $index: $e');
      failedBlocks.add(index);
      return null;
    }

    // Parse JSON.
    try {
      return jsonDecode(decoded) as Map<String, dynamic>;
    } catch (e) {
      errors.add('Failed to parse block $index: $e');
      failedBlocks.add(index);
      return null;
    }
  }
}
