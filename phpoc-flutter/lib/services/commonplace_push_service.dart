import '../core/crypto/crypto_service.dart';
import '../core/models/push_result.dart';
import '../data/commonplace/commonplace_chain.dart';
import '../data/ledger/helpers.dart' show jsonEncodeSortedNoSpaces;
import '../data/sync/staging_paths.dart';
import '../data/sync/transport.dart';
import 'chain_transport_helpers.dart';

/// Pushes the full Commonplace sealed chain to a remote Worker/R2 blob store
/// under the `commonplace/...` prefix (ADR-031 remote-sync slice).
///
/// Serializes each block to sorted, space-free PHPSPEC JSON, obfuscates it
/// with the shared master key, and uploads to `commonplace/blocks/NNNNNN.json`
/// (genesis at `000000`). Also pushes `commonplace/hash_index.json` — a
/// plaintext JSON array of block hashes in chain order (mirrors the ledger's
/// `ledger/hash_index.json` 1:1).
///
/// Push is idempotent — repeated pushes overwrite the same remote files.
class CommonplacePushService {
  final CryptoService crypto;
  final HttpTransport transport;
  final CommonplaceChain chain;

  /// Guard against concurrent [pushAll] calls.
  Future<PushResult>? _pendingPush;

  CommonplacePushService({
    required this.crypto,
    required this.transport,
    required this.chain,
  });

  /// Push every block in the chain (genesis + day blocks) to the remote.
  ///
  /// Requires [CryptoService.hasMasterKey] — throws [StateError] if no master
  /// key is cached. Throws [StateError] for an empty chain (pushing zero
  /// blocks would wipe the remote hash_index). Concurrent calls are
  /// serialized — the second caller waits for the first and gets the same
  /// result.
  Future<PushResult> pushAll() async {
    // Concurrent-call guard.
    if (_pendingPush != null) return _pendingPush!;

    if (!crypto.hasMasterKey) {
      throw StateError('No master key cached. Call setMasterKey() first.');
    }
    final mkHex = crypto.getMasterKey()!;

    _pendingPush = _doPushAll(mkHex);
    try {
      return await _pendingPush!;
    } finally {
      _pendingPush = null;
    }
  }

  /// Push an explicit list of blocks (chain maps) to the remote at their
  /// 0-based chain positions. Mirrors `LedgerPushService.pushBlocks` for the
  /// Commonplace chain (auto-push after a commit).
  Future<PushResult> pushBlocks(List<Map<String, dynamic>> blocks) async {
    if (!crypto.hasMasterKey) {
      throw StateError('No master key cached. Call setMasterKey() first.');
    }
    final mkHex = crypto.getMasterKey()!;
    return _pushChainBlocks(mkHex, blocks);
  }

  Future<PushResult> _doPushAll(String mkHex) async {
    final blocks = chain.readAll();
    if (blocks.isEmpty) {
      throw StateError(
        'Cannot push an empty Commonplace chain — it has no blocks. '
        'Bootstrap a genesis first via CommonplaceService.ensureGenesis().',
      );
    }
    return _pushChainBlocks(mkHex, blocks);
  }

  /// Shared transport loop: serialize + obfuscate + push each block at its
  /// 0-based chain position, then push the plaintext hash index. Delegates to
  /// the shared [pushChainPayloads] helper (also used by [LedgerPushService]).
  Future<PushResult> _pushChainBlocks(
    String mkHex,
    List<Map<String, dynamic>> blocks,
  ) async {
    final payloads = <ChainBlockPayload>[];
    for (var i = 0; i < blocks.length; i++) {
      payloads.add(ChainBlockPayload(
        index: i,
        hash: chain.getBlockHashFor(blocks[i]),
        serialized: jsonEncodeSortedNoSpaces(blocks[i]),
      ));
    }

    final (pushedCount, failedBlocks, errors, hashPrefix) =
        await pushChainPayloads(
      crypto: crypto,
      transport: transport,
      mkHex: mkHex,
      blocksPrefix: StagingPaths.commonplaceBlocksPrefix,
      hashIndexPath: StagingPaths.commonplaceHashIndex,
      hashIndexErrorLabel: 'commonplace/hash_index.json',
      payloads: payloads,
    );

    if (failedBlocks.isEmpty && errors.isEmpty) {
      return PushResult.ok(pushedCount, hashPrefix: hashPrefix);
    }
    return PushResult.failure(
      blocksPushed: pushedCount,
      failedBlocks: failedBlocks,
      errors: errors,
    );
  }
}
