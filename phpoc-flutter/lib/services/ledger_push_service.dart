import 'dart:convert';
import 'dart:typed_data';

import '../core/crypto/crypto_service.dart';
import '../core/models/block.dart';
import '../core/models/push_result.dart';
import '../core/utils/format_utils.dart';
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

  // ── PHPSPEC field name constants ─────────────────────────────

  static const _kType = 'type';
  static const _kDayIndex = 'day_index';
  static const _kDate = 'date';
  static const _kPrevHash = 'prev_hash';
  static const _kEntries = 'entries';
  static const _kBlockHash = 'block_hash';

  static const _typeGenesis = 'genesis';
  static const _typeDay = 'day';
  static const _typeYearSummary = 'year_summary';
  static const _typeMonthSummary = 'month_summary';

  // Only genesis and day use 'day_hash'; others follow the
  // '${typeStr}_hash' fallback in _blockToPhpSpecJson.
  static const _sealFieldNames = {
    _typeGenesis: 'day_hash',
    _typeDay: 'day_hash',
  };

  static const _blockTypeToPhpSpec = {
    BlockType.genesis: _typeGenesis,
    BlockType.day: _typeDay,
    BlockType.year: _typeYearSummary,
    BlockType.month: _typeMonthSummary,
  };

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
        // Use identitySeal (the computed seal hash) when available;
        // fall back to blockId for blocks that haven't been sealed yet.
        blockHashes.add(block.identitySeal ?? block.blockId);
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
      return PushResult.ok(pushedCount);
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
  /// Matches the format produced by [LedgerBackupService.exportToJson]
  /// (same field names, same date/entries extraction).
  String _blockToPhpSpecJson(Block block) {
    final typeStr =
        _blockTypeToPhpSpec[block.blockType] ?? block.blockType.name;
    final sealField = _sealFieldNames[typeStr] ?? '${typeStr}_hash';

    // Decode data_enc to extract entries array
    List<dynamic> entries;
    try {
      final decoded = utf8.decode(base64.decode(block.dataEnc));
      entries = jsonDecode(decoded) as List<dynamic>;
    } catch (_) {
      // data_enc is opaque or malformed — emit empty entries
      entries = [];
    }

    // Parse createdAt epoch → ISO date string
    final dateStr = FormatUtils.epochToIsoDate(block.createdAt);

    final result = <String, dynamic>{
      _kType: typeStr,
      _kDayIndex: block.blockIndex,
      _kDate: dateStr,
      _kPrevHash: block.prevHash,
      _kEntries: entries,
      sealField: block.identitySeal,
      _kBlockHash: block.identitySeal ?? block.blockId,
    };

    return jsonEncode(result);
  }

}
