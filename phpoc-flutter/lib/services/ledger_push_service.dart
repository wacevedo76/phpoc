import 'dart:convert';

import '../core/crypto/crypto_service.dart';
import '../core/models/block.dart';
import '../core/models/push_result.dart';
import '../core/utils/phpsec_format.dart';
import '../data/ledger/helpers.dart' as ledger_helpers;
import '../data/storage/database.dart';
import '../data/sync/transport.dart';
import 'chain_transport_helpers.dart';

/// Pushes the full ledger chain to a remote Worker/R2 blob store.
///
/// Reads all blocks from the database, serializes each to PHPSPEC JSON,
/// obfuscates with the master key, and uploads to `ledger/blocks/NNNNNN.json`.
/// Also pushes `ledger/hash_index.json` (plaintext JSON array of block hashes)
/// and `ledger/index.json` (obfuscated blind-index data).
///
/// Push is idempotent — repeated pushes overwrite existing remote files.
class LedgerPushService {
  final AppDatabase db;
  final CryptoService crypto;
  final HttpTransport transport;

  /// Guard against concurrent [pushAll] calls.
  Future<PushResult>? _pendingPush;

  // ── PHPSPEC format ───────────────────────────────────────────
  // Uses shared PhpSpecFormat constants (seal field names, type
  // mappings, entry extraction) to stay consistent with
  // LedgerBackupService. See lib/core/utils/phpsec_format.dart.

  LedgerPushService({
    required this.db,
    required this.crypto,
    required this.transport,
  });

  /// Push all blocks + hash_index + index to the remote Worker.
  ///
  /// Returns a [PushResult] indicating success or failure with details.
  /// Requires [CryptoService.hasMasterKey] to be true — throws [StateError]
  /// if no master key is cached.
  ///
  /// On partial failure, [PushResult.success] is false and
  /// [PushResult.failedBlocks] lists the block indices that failed to push.
  ///
  /// Concurrent calls are serialized — the second caller waits for the
  /// first push to complete and receives the same result.
  Future<PushResult> pushAll() async {
    // Concurrent call guard: if a push is already in progress, wait for it
    if (_pendingPush != null) {
      return _pendingPush!;
    }

    // MK guard
    if (!crypto.hasMasterKey) {
      throw StateError(
        'No master key cached. Call setMasterKey() first.',
      );
    }

    final mkHex = crypto.getMasterKey()!;

    _pendingPush = _doPushAll(mkHex);
    try {
      return await _pendingPush!;
    } finally {
      _pendingPush = null;
    }
  }

  // ── Core push logic ──────────────────────────────────────────

  /// Push an explicit list of PHPSPEC blocks (chain maps) to Remote.
  ///
  /// ADR-030 commit auto-push: [SyncService.commitAndSync] feeds the freshly
  /// committed blocks read from the ledger engine so they reach Remote
  /// immediately (D11 move semantics). Unlike [pushAll] (which reloads from
  /// the database), this uses the caller-provided chain so it works even when
  /// the engine's block store and the DB aren't the same object.
  ///
  /// Pushes each block to `ledger/blocks/NNNNNN.json` (obfuscated) and a
  /// plaintext `ledger/hash_index.json` of block hashes in chain order.
  /// Returns a [PushResult] with the count pushed and any failures.
  Future<PushResult> pushBlocks(List<Map<String, dynamic>> blocks) async {
    if (!crypto.hasMasterKey) {
      throw StateError(
        'No master key cached. Call setMasterKey() first.',
      );
    }
    final mkHex = crypto.getMasterKey()!;

    // Serialize each block and delegate the common transport loop to
    // [_pushChainPayloads] (same as the DB-backed [pushAll] path). The
    // 0-indexed list position is the block index in chain order.
    final payloads = <ChainBlockPayload>[];
    for (var i = 0; i < blocks.length; i++) {
      payloads.add(ChainBlockPayload(
        index: i,
        // Type-appropriate hash (day_hash / block_hash / ...) in chain
        // order, matching Python's block_hash selection for hash_index.
        hash: ledger_helpers.getBlockHash(blocks[i]),
        serialized: ledger_helpers.jsonEncodeSortedNoSpaces(blocks[i]),
      ));
    }
    final (blocksPushed, failedBlocks, errors, hashPrefix) =
        await _pushChainPayloads(mkHex, payloads);
    if (failedBlocks.isEmpty && errors.isEmpty) {
      return PushResult.ok(blocksPushed, hashPrefix: hashPrefix);
    }
    return PushResult.failure(
      blocksPushed: blocksPushed,
      failedBlocks: failedBlocks,
      errors: errors,
    );
  }


  Future<PushResult> _doPushAll(String mkHex) async {
    // Read all blocks sorted by block_index
    final blocks = await db.blockDao.getAllBlocks();

    // Safety guard: refuse to push an empty ledger — pushing zero blocks
    // overwrites hash_index.json with [] and index.json with {},
    // effectively wiping the remote ledger on R2.
    if (blocks.isEmpty) {
      throw StateError(
        'Cannot push an empty ledger — the database has no blocks. '
        'Import a ledger first via LedgerBackupService.importFromJson() '
        'or LedgerPullService.pullAll().',
      );
    }

    int pushedCount = 0;
    final failedBlocks = <int>[];
    final errors = <String>[];

    // Serialize + push each block and the plaintext hash_index via the
    // shared transport loop. blockId (block_hash) feeds hash_index — matches
    // Python scripts/push_test_ledger.py: h = block.block_hash or day_hash.
    final payloads = <ChainBlockPayload>[];
    for (final block in blocks) {
      payloads.add(ChainBlockPayload(
        index: block.blockIndex,
        hash: block.blockId,
        serialized: _blockToPhpSpecJson(block),
      ));
    }
    final r = await _pushChainPayloads(mkHex, payloads);
    pushedCount = r.$1;
    failedBlocks.addAll(r.$2);
    errors.addAll(r.$3);
    final hashPrefix = r.$4;

    // Push index.json as obfuscated empty dict
    try {
      final indexJson = jsonEncode(<String, dynamic>{});
      final obfuscatedIndex = crypto.obfuscateBlob(indexJson, mkHex);
      await transport.push('ledger/index.json', obfuscatedIndex);
    } catch (e) {
      errors.add('Failed to push index.json: $e');
    }

    if (failedBlocks.isEmpty && errors.isEmpty) {
      return PushResult.ok(pushedCount, hashPrefix: hashPrefix);
    }
    return PushResult.failure(
      blocksPushed: pushedCount,
      failedBlocks: failedBlocks,
      errors: errors,
    );
  }

  // ── Helpers ──────────────────────────────────────────────────

  // ── PHPSPEC serialization ────────────────────────────────────

  /// Serialize a [Block] to PHPSPEC JSON string.
  ///
  /// Delegates to [PhpSpecFormat.blockToMap] for the common fields
  /// shared with [LedgerBackupService._blockToPhpSpec]. Uses sorted,
  /// space-free JSON encoding for compact transport.
  String _blockToPhpSpecJson(Block block) {
    final result = PhpSpecFormat.blockToMap(block);
    return ledger_helpers.jsonEncodeSortedNoSpaces(result);
  }

  // ── Shared chain transport loop ──────────────────────────────

  /// Push each [payloads] blob to `ledger/blocks/NNNNNN.json` and then a
  /// plaintext `ledger/hash_index.json` array of the pushed block hashes.
  ///
  /// Thin wrapper over the shared [pushChainPayloads] helper (also used by
  /// [CommonplacePushService]) pinned to the ledger R2 paths. Shared by
  /// [pushBlocks] (raw chain maps) and the DB-backed [pushAll] path so both
  /// serialize blocks consistently. Returns
  /// `(blocksPushed, failedIndices, errors, firstHashPrefix)`.
  Future<(int, List<int>, List<String>, String?)> _pushChainPayloads(
    String mkHex,
    List<ChainBlockPayload> payloads,
  ) {
    return pushChainPayloads(
      crypto: crypto,
      transport: transport,
      mkHex: mkHex,
      blocksPrefix: 'ledger/blocks/',
      hashIndexPath: 'ledger/hash_index.json',
      hashIndexErrorLabel: 'hash_index.json',
      payloads: payloads,
    );
  }

}
