import 'dart:convert';
import 'dart:typed_data';

import '../core/crypto/crypto_service.dart';
import '../core/models/pull_result.dart';
import '../data/storage/database.dart';
import '../data/sync/staging_storage.dart';
import '../data/sync/staging_store.dart';
import '../data/sync/transport.dart';
import '../data/ledger/helpers.dart' show getBlockHash, verifyEntryHashTwoWay;
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
  final StagingStore stagingStore;

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
    required this.stagingStore,
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

    // Step 3: Validate the assembled chain before importing.
    // Matches web's WorkerImportSource._validateRawChain: genesis type,
    // block seals, prev_hash linkage, and per-entry hash verification
    // with the 4-way fallback (sort+indent2, sort+compact, nosort+indent2).
    if (blocks.isNotEmpty) {
      _validateImportedChain(blocks);
    }

    // Step 4: Import assembled PHPSPEC array into database
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

  /// Seed staging store with entries from imported blocks.
  ///
  /// Extracts entries from each block's `entries` array and writes them
  /// as row-level staging entries so Dashboard/History screens can display
  /// committed ledger entries.
  ///
  /// The activity blob is the same `{hash, data: {...}}` raw format that
  /// the old LocalCache-based path used, since _stagingRowToDto expects
  /// field names from the PHPSPEC entry data dict.
  ///
  /// Entries already present in staging (matched by entry_id) are not
  /// duplicated. Best-effort — staging write failures are logged but
  /// never block the pull result.
  Future<void> _seedStagingFromBlocks(
      List<Map<String, dynamic>> blocks) async {
    // Collect existing entry hashes AND entry_ids to avoid duplicates.
    final existingRows = await stagingStore.getAllRows();
    final existingHashes = <String>{};
    for (final row in existingRows) {
      try {
        final activityData =
            jsonDecode(row['activity'] as String? ?? '{}') as Map<String, dynamic>;
        final h = activityData['hash'] as String?;
        if (h != null && h.isNotEmpty) existingHashes.add(h);
        final eid = activityData['entry_id'] as String?;
        if (eid != null && eid.isNotEmpty) existingHashes.add(eid);
      } catch (_) {}
    }

    for (final block in blocks) {
      final blockEntries = block['entries'] as List<dynamic>?;
      if (blockEntries == null) continue;
      for (final raw in blockEntries) {
        if (raw is! Map<String, dynamic>) continue;

        // Extract entry data: PHPSPEC format wraps in {hash, data: {...}}
        final entryData = raw['data'] as Map<String, dynamic>? ?? raw;
        final entryHash = raw['hash'] as String? ?? '';
        final eid = entryData['entry_id'] as String?;

        // Dedup: skip if this entry (by hash or entry_id) is already in staging
        if (entryHash.isNotEmpty && existingHashes.contains(entryHash)) continue;
        if (eid != null && eid.isNotEmpty && existingHashes.contains(eid)) continue;
        if (entryHash.isNotEmpty) existingHashes.add(entryHash);
        if (eid != null && eid.isNotEmpty) existingHashes.add(eid);

        // Skip active / paused entries — only completed entries go to staging
        final isActive = entryData['is_active'] as bool? ?? false;
        if (isActive) continue;
        if (entryData['is_paused'] == true) continue;

        // Generate an activity_id (10-char alphanumeric) if entry_id is missing
        final activityId = (eid != null && eid.length == 10)
            ? eid
            : _generateActivityId();

        // Build the activity JSON blob with plaintext field names that
        // match what _stagingRowToDto expects. Block entries use encrypted
        // hex fields (startTime_enc, endTime_enc, pauses_enc, metadata_enc)
        // which must be decrypted with the MK first.
        final mkHex = crypto.getMasterKey()!;
        final startEpoch = _decryptEpoch(entryData['startTime_enc'] as String?, mkHex);
        final endEpoch = _decryptEpoch(entryData['endTime_enc'] as String?, mkHex);
        final pauses = _decryptPauses(entryData['pauses_enc'] as String?, mkHex);
        final deviceUuid = entryData['device_uuid'] as String? ?? '';

        final activity = jsonEncode({
          'entry_id': eid ?? '',
          'hash': raw['hash'] ?? '',
          'title': entryData['title'] ?? '',
          'start_epoch': startEpoch,
          'end_epoch': endEpoch,
          'duration': entryData['duration'] as int? ?? 0,
          'is_active': false,
          'is_paused': false,
          'pauses': pauses,
          'tags': entryData['tags'] ?? <dynamic>[],
          'comment': entryData['comment'] ?? '',
          'media': entryData['media'] ?? <dynamic>[],
          'device_uuid': deviceUuid,
          'committed': true,  // Already committed to ledger — skip staging area
        });

        try {
          await stagingStore.putRow({
            'activity_id': activityId,
            'activity_status': 'ended',
            'activity': activity,
            'updated_at': DateTime.now().millisecondsSinceEpoch,
            'committed': true, // Row-level flag for MergeEngine.mergeEntries
          });
        } catch (_) {
          // Best-effort: staging seed failure does not block pull result
        }
      }
    }
  }

  /// Generate a 10-character alphanumeric activity_id.
  String _generateActivityId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    final buf = StringBuffer();
    for (var i = 0; i < 10; i++) {
      buf.write(chars[(DateTime.now().microsecondsSinceEpoch + i * 7919) % chars.length]);
    }
    return buf.toString();
  }

  /// Decrypt a field value trying both encryption schemes.
  ///
  /// Flutter engine encrypts with [CryptoService.encrypt] (raw-mk scheme),
  /// while Python CLI blocks use HMAC-derived sub-keys. Both produce distinct
  /// auth tags, so we try each until one authenticates.
  String? _decryptFieldValue(String encHex, String mkHex) {
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

  /// Decrypt an encrypted epoch string to an int. Returns 0 on null or failure.
  int _decryptEpoch(String? encHex, String mkHex) {
    if (encHex == null || encHex.isEmpty) return 0;
    final plain = _decryptFieldValue(encHex, mkHex);
    return (plain != null) ? (int.tryParse(plain) ?? 0) : 0;
  }

  /// Decrypt an encrypted pauses JSON array string.
  List<dynamic> _decryptPauses(String? encHex, String mkHex) {
    if (encHex == null || encHex.isEmpty) return <dynamic>[];
    final plain = _decryptFieldValue(encHex, mkHex);
    if (plain == null) return <dynamic>[];
    try {
      final decoded = jsonDecode(plain);
      return (decoded is List) ? decoded : <dynamic>[];
    } catch (_) {
      return <dynamic>[];
    }
  }

  /// Validate the assembled chain before import.
  ///
  /// Matches web's WorkerImportSource._validateRawChain and Python's
  /// _verify_entry_hash_flex. Validates:
  ///   - Genesis block type
  ///   - Per-entry hash with 4-way fallback (via verifyEntryHashTwoWay)
  ///   - Prev_hash chain linkage
  ///
  /// Throws on first validation failure; the caller catches and returns
  /// a PullResult.failure with the error message.
  void _validateImportedChain(List<Map<String, dynamic>> blocks) {
    // ── Genesis check ──────────────────────────────────────
    final genesis = blocks.first;
    if (genesis['type'] != 'genesis') {
      throw FormatException('Remote chain must start with a genesis block (type: "genesis")');
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
          throw FormatException('Malformed entry at block $i, entry $j — missing hash or data');
        }

        // 4-way fallback: sort+indent2 → sort+compact → compact-nospace → nosort+indent2
        if (!verifyEntryHashTwoWay(data, hash)) {
          throw FormatException(
            'Entry hash mismatch at block $i, entry $j '
            '("${data['title'] ?? 'untitled'}")',
          );
        }
      }
    }

    // ── Prev_hash chain linkage ─────────────────────────────
    for (var i = 1; i < blocks.length; i++) {
      final prevHash = getBlockHash(blocks[i - 1]);
      final actualPrev = blocks[i]['prev_hash'] as String? ?? '';
      if (prevHash.isNotEmpty && actualPrev != prevHash) {
        throw FormatException(
          'Chain linkage broken at block $i: '
          'prev_hash=${actualPrev.length > 8 ? actualPrev.substring(0, 8) : actualPrev}… '
          'expected=${prevHash.length > 8 ? prevHash.substring(0, 8) : prevHash}…',
        );
      }
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
