import 'dart:convert';
import 'dart:typed_data';

import '../core/crypto/crypto_service.dart';
import '../core/models/block.dart';
import '../core/models/push_result.dart';
import '../core/utils/phpsec_format.dart';
import '../data/ledger/helpers.dart' as ledger_helpers;
import '../data/storage/database.dart';
import '../data/sync/transport.dart';

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
    final blockHashes = <String>[];

    // Push each block individually
    for (final block in blocks) {
      final blockJson = _blockToPhpSpecJson(block);
      final obfuscated = crypto.obfuscateBlob(blockJson, mkHex);
      final path =
          'ledger/blocks/${block.blockIndex.toString().padLeft(6, '0')}.json';

      try {
        await transport.push(path, obfuscated);
        pushedCount++;
        // Use blockId (block_hash) for hash_index — matches
        // Python scripts/push_test_ledger.py:
        //   h = block.get("block_hash") or block.get("day_hash")
        blockHashes.add(block.blockId);
      } catch (e) {
        failedBlocks.add(block.blockIndex);
        errors.add(e.toString());
      }
    }

    // Push hash_index.json as plaintext JSON array
    try {
      final hashIndexJson = jsonEncode(blockHashes);
      await transport.push('ledger/hash_index.json', _textBytes(hashIndexJson));
    } catch (e) {
      errors.add('Failed to push hash_index.json: $e');
    }

    // Push index.json as obfuscated empty dict
    try {
      final indexJson = jsonEncode(<String, dynamic>{});
      final obfuscatedIndex = crypto.obfuscateBlob(indexJson, mkHex);
      await transport.push('ledger/index.json', obfuscatedIndex);
    } catch (e) {
      errors.add('Failed to push index.json: $e');
    }

    if (failedBlocks.isEmpty && errors.isEmpty) {
      return PushResult.ok(pushedCount,
          hashPrefix: blockHashes.isNotEmpty ? blockHashes.first : null);
    }
    return PushResult.failure(
      blocksPushed: pushedCount,
      failedBlocks: failedBlocks,
      errors: errors,
    );
  }

  // ── Helpers ──────────────────────────────────────────────────

  /// Encode a string as UTF-8 bytes for transport.
  static Uint8List _textBytes(String s) =>
      Uint8List.fromList(utf8.encode(s));

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

}
