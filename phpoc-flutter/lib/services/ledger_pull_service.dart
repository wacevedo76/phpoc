import 'dart:convert';
import 'dart:typed_data';

import '../core/crypto/crypto_service.dart';
import '../core/models/pull_result.dart';
import '../data/storage/database.dart';
import '../data/sync/staging_storage.dart';
import '../data/sync/transport.dart';
import 'ledger_backup_service.dart';

/// Pulls the full ledger chain from a remote Worker/R2 blob store.
///
/// Pulls `ledger/hash_index.json` (plaintext) to discover block count,
/// then pulls each `ledger/blocks/NNNNNN.json`, deobfuscates with the
/// master key, assembles into a PHPSPEC JSON array, and imports via
/// [LedgerBackupService.importFromJson].
///
/// Seeds staging entries from imported blocks so [HistoryScreen] can
/// display them without a separate sync step.
class LedgerPullService {
  final AppDatabase db;
  final CryptoService crypto;
  final HttpTransport? transport;
  final LedgerBackupService backupService;
  final StagingStorage stagingStorage;

  /// Regex to parse block index from filenames returned by listFiles.
  /// The Worker `?prefix=` API returns bare filenames like `000042.json`.
  static final _pathRe = RegExp(r'^(\d+)\.json$');

  /// Build the remote path for a block file by its index.
  static String _blockPath(int index) =>
      'ledger/blocks/${index.toString().padLeft(6, '0')}.json';

  /// Guard against concurrent [pullAll] calls.
  Future<PullResult>? _inFlightPull;

  LedgerPullService({
    required this.db,
    required this.crypto,
    required this.transport,
    required this.backupService,
    required this.stagingStorage,
  });

  /// Pull all blocks + import + seed staging from the remote Worker.
  ///
  /// Returns a [PullResult] indicating success or failure with details.
  /// Requires [CryptoService.hasMasterKey] to be true — throws [StateError]
  /// if no master key is cached.
  ///
  /// If [transport] is null, returns an empty result (no-op for local-only
  /// mode).
  ///
  /// On partial failure, [PullResult.success] is false and
  /// [PullResult.failedBlocks] lists the block indices that failed.
  ///
  /// Concurrent calls are serialized — the second caller waits for the
  /// first pull to complete and receives the same result.
  Future<PullResult> pullAll() async {
    // A3: MK guard
    if (!crypto.hasMasterKey) {
      throw StateError(
        'No master key cached. Call setMasterKey() first.',
      );
    }

    final mkHex = crypto.getMasterKey()!;

    // A4: null transport → no-op for local-only mode
    if (transport == null) {
      return PullResult.ok(blocksPulled: 0, entriesStaged: 0);
    }

    // F5: concurrency guard — serialize concurrent calls
    if (_inFlightPull != null) {
      return _inFlightPull!;
    }

    _inFlightPull = _doPullAll(mkHex);
    try {
      return await _inFlightPull!;
    } finally {
      _inFlightPull = null;
    }
  }

  // ── Core pull logic ──────────────────────────────────────────

  Future<PullResult> _doPullAll(String mkHex) async {
    final t = transport!;
    final errors = <String>[];
    final failedBlocks = <int>[];

    // Step 1: Pull hash_index.json (plaintext — no MK needed)
    List<dynamic> hashIndex;
    try {
      final raw = await t.pull('ledger/hash_index.json');
      if (raw == null) {
        // B5: empty remote — no hash_index file exists
        return PullResult.ok(blocksPulled: 0, entriesStaged: 0);
      }
      hashIndex = jsonDecode(utf8.decode(raw)) as List<dynamic>;
    } catch (e) {
      // F1 / F4: network or auth failure during initial pull
      errors.add('Failed to pull hash_index.json: $e');
      return PullResult.failure(errors: errors);
    }

    // B5: hash_index exists but is empty
    if (hashIndex.isEmpty) {
      return PullResult.ok(blocksPulled: 0, entriesStaged: 0);
    }

    // Step 2: Discover actual block files on remote via listFiles.
    // Blocks pulled outside hash_index range are still imported, but only
    // indices within [0, hashIndex.length) that are missing are reported.
    List<String> blockFiles;
    try {
      blockFiles = await t.listFiles('ledger/blocks/');
    } catch (e) {
      errors.add('Failed to list block files: $e');
      return PullResult.failure(errors: errors);
    }

    // Parse block indices from discovered filenames
    final discoveredIndices = <int>{};
    for (final path in blockFiles) {
      final match = _pathRe.firstMatch(path);
      if (match != null) {
        discoveredIndices.add(int.parse(match.group(1)!));
      }
    }

    // Pull every discovered block (sorted by index).
    // Missing-index reporting is deferred until after pull: if fewer blocks
    // were pulled than hash_index indicates, we report which indices in
    // [0, hashIndex.length) are missing. If we found at least hashIndex.length
    // blocks (possibly at different indices), no indices are reported missing.
    final sortedIndices = discoveredIndices.toList()..sort();
    final blocks = <Map<String, dynamic>>[];
    var totalEntries = 0;

    for (final i in sortedIndices) {
      final blockJson = await _pullBlock(t, mkHex, i, failedBlocks, errors);
      if (blockJson == null) continue;
      final entries = blockJson['entries'] as List<dynamic>?;
      totalEntries += entries?.length ?? 0;
      blocks.add(blockJson);
    }

    // B4: if fewer blocks were pulled than hash_index expects, report
    // which indices in [0, hashIndex.length) are missing. If we found
    // at least hashIndex.length blocks (possibly at non-contiguous indices),
    // no indices are reported missing.
    if (blocks.length < hashIndex.length) {
      _addMissingIndices(discoveredIndices, hashIndex.length, failedBlocks);
    }

    // Step 3: Import assembled PHPSPEC array into database
    if (blocks.isNotEmpty) {
      try {
        final jsonArray = const JsonEncoder().convert(blocks);
        await backupService.importFromJson(jsonArray);
        // Seed staging entries from imported blocks so Dashboard/History
        // can display committed entries without a separate sync step.
        await _seedStagingFromBlocks(blocks);
      } catch (e) {
        errors.add('Failed to import blocks: $e');
        return PullResult.failure(
          blocksPulled: blocks.length,
          entriesStaged: totalEntries,
          failedBlocks: failedBlocks,
          errors: errors,
        );
      }
    }

    if (failedBlocks.isEmpty && errors.isEmpty) {
      return PullResult.ok(
        blocksPulled: blocks.length,
        entriesStaged: totalEntries,
      );
    }

    return PullResult.failure(
      blocksPulled: blocks.length,
      entriesStaged: totalEntries,
      failedBlocks: failedBlocks,
      errors: errors,
    );
  }

  // ── Per-block pull + deobfuscate + parse ────────────────────

  /// Pull, deobfuscate, and parse a single block from the remote.
  ///
  /// Returns the parsed block JSON on success, or `null` on failure
  /// (appending to [failedBlocks] and [errors]).
  Future<Map<String, dynamic>?> _pullBlock(
    HttpTransport t,
    String mkHex,
    int index,
    List<int> failedBlocks,
    List<String> errors,
  ) async {
    final path = _blockPath(index);

    // Pull raw bytes
    final Uint8List raw;
    try {
      final pulled = await t.pull(path);
      if (pulled == null) {
        // Shouldn't happen if listFiles returned it, but be safe
        failedBlocks.add(index);
        return null;
      }
      raw = pulled;
    } catch (e) {
      // F1: network-level failure for this block
      errors.add('Failed to pull block $index: $e');
      failedBlocks.add(index);
      return null;
    }

    // Deobfuscate
    String decoded;
    try {
      decoded = crypto.deobfuscateBlob(raw, mkHex);
    } catch (e) {
      // F2: wrong MK or tampered blob
      errors.add('Failed to deobfuscate block $index: $e');
      failedBlocks.add(index);
      return null;
    }

    // Parse JSON
    try {
      return jsonDecode(decoded) as Map<String, dynamic>;
    } catch (e) {
      // F3: corrupted / non-JSON decrypted data
      errors.add('Failed to parse block $index: $e');
      failedBlocks.add(index);
      return null;
    }
  }

  /// Seed staging storage with entries from imported blocks.
  ///
  /// Extracts entries from each block's `entries` array and writes them
  /// to the staging store in the `{hash, data: {...}}` raw format that
  /// [LocalCache._rawToDto] expects, so Dashboard/History screens can
  /// display committed ledger entries.
  ///
  /// Encryptable fields use `plain:` prefix (no MK-based encryption)
  /// since these entries are already cryptographically secured by the
  /// ledger chain. [LocalCache._decrypt] handles the `plain:` prefix.
  ///
  /// Entries already present in staging (matched by entry_id) are not
  /// duplicated. Best-effort — staging write failures are logged but
  /// never block the pull result.
  Future<void> _seedStagingFromBlocks(
      List<Map<String, dynamic>> blocks) async {
    final existingEntries = await stagingStorage.get('entries');
    final stagingList = (existingEntries is List)
        ? List<Map<String, dynamic>>.from(existingEntries)
        : <Map<String, dynamic>>[];

    // Collect existing entry_ids from staging (ids live in .data.entry_id)
    final existingIds = <String>{};
    for (final raw in stagingList) {
      if (raw is! Map<String, dynamic>) continue;
      final data = raw['data'] as Map<String, dynamic>?;
      if (data == null) continue;
      final eid = data['entry_id'] as String?;
      if (eid != null) existingIds.add(eid);
    }

    for (final block in blocks) {
      final blockEntries = block['entries'] as List<dynamic>?;
      if (blockEntries == null) continue;
      for (final raw in blockEntries) {
        if (raw is! Map<String, dynamic>) continue;

        // Extract entry data: PHPSPEC format wraps in {hash, data: {...}}
        final entryData = raw['data'] as Map<String, dynamic>? ?? raw;
        final eid = entryData['entry_id'] as String?;

        // Dedup: skip if already in staging
        if (eid != null && existingIds.contains(eid)) continue;
        if (eid != null) existingIds.add(eid);

        // Skip active / paused entries (they belong in active task slot,
        // not the completed-entries list)
        final isActive = entryData['is_active'] as bool? ?? false;
        if (isActive) continue;
        if (entryData['is_paused'] == true) continue;

        // Build the {hash, data: {...}} raw format that LocalCache expects.
        // Encrypted fields (startTime_enc, endTime_enc, pauses_enc, metadata_enc)
        // are passed through as-is from the block data — LocalCache._rawToDto
        // decrypts them with the MK. Fields not present in block entries use
        // plain: prefix for zero-cost passthrough.
        final data = <String, dynamic>{
          'entry_id': eid ?? '',
          'title': entryData['title'] ?? '',
          'startTime_enc': entryData['startTime_enc'] ?? 'plain:0',
          'duration': entryData['duration'] ?? 0,
          'is_active': false,
          'is_paused': false,
          'pauses_enc': entryData['pauses_enc'] ??
              'plain:${jsonEncode(<dynamic>[])}',
          'tags': entryData['tags'] ?? <dynamic>[],
          'device_uuid_enc': 'plain:${entryData['device_uuid'] ?? ''}',
          'end_device_uuid_enc': 'plain:${entryData['end_device_uuid'] ?? ''}',
          'metadata_enc': entryData['metadata_enc'] ?? 'plain:{}',
        };
        if (entryData['endTime_enc'] != null) {
          data['endTime_enc'] = entryData['endTime_enc'];
        }
        if (entryData['comment'] != null) {
          data['comment'] = entryData['comment'];
        }

        stagingList.add({
          'hash': raw['hash'] ?? '',
          'data': data,
          'committed': true,
        });
      }
    }

    try {
      await stagingStorage.set('entries', stagingList);
    } catch (_) {
      // Best-effort: staging seed failure does not block pull result
    }
  }

  /// Report indices in [0, expectedCount) that are not in [discovered].
  void _addMissingIndices(
    Set<int> discovered,
    int expectedCount,
    List<int> failedBlocks,
  ) {
    for (var i = 0; i < expectedCount; i++) {
      if (!discovered.contains(i)) {
        failedBlocks.add(i);
      }
    }
  }
}
