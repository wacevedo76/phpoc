import 'dart:convert';
import 'dart:typed_data';

import '../core/crypto/crypto_service.dart';
import '../core/models/pull_result.dart';
import '../core/utils/decrypt_helpers.dart';
import '../data/storage/database.dart';
import '../data/sync/staging_storage.dart';
import '../data/sync/staging_store.dart';
import '../data/sync/transport.dart';
import 'ledger_backup_service.dart';
import 'pull_stage_functions.dart';
import 'staging_seed_helpers.dart';
import 'chain_transport_helpers.dart';

/// Pulls the full ledger chain from a remote Worker/R2 blob store.
///
/// Pulls `ledger/hash_index.json` (plaintext) to discover block count,
/// then pulls each `ledger/blocks/NNNNNN.json`, deobfuscates with the
/// master key, assembles into a PHPSPEC JSON array, and imports via
/// [LedgerBackupService.importFromJson].
///
/// Seeds staging entries from imported blocks so [HistoryScreen] can
/// display them without a separate sync step.
class LedgerPullService with DecryptHelpers {
  final AppDatabase db;
  @override
  final CryptoService crypto;
  final HttpTransport? transport;
  final LedgerBackupService backupService;
  final StagingStorage stagingStorage;
  final StagingStore stagingStore;

  /// Execution seam for CPU-bound pull stages (deobfuscation + chain
  /// validation). Defaults to a background-isolate runner in production;
  /// tests inject an inline runner for hermetic coverage.
  ///
  /// Fix blueprint: `docs/planning/flutter/RESTORE_PULL_ISOLATE_FIX_PHASE1.md`.
  final OffloadRunner offload;

  /// Regex to parse block index from filenames returned by listFiles.
  /// The Worker `?prefix=` API returns bare filenames like `000042.json`.
  static final _pathRe = RegExp(r'^(\d+)\.json$');

  /// Build the remote path for a block file by its index.
  static String _blockPath(int index) =>
      'ledger/blocks/${index.toString().padLeft(6, '0')}.json';

  /// Guard against concurrent [pullAll] calls.
  Future<PullResult>? _inFlightPull;

  /// Guard against concurrent [pullIfRemoteHasMore] calls.
  Future<PullResult>? _inFlightFreshness;

  LedgerPullService({
    required this.db,
    required this.crypto,
    required this.transport,
    required this.backupService,
    required this.stagingStorage,
    required this.stagingStore,
    this.offload = isolateOffloadRunner,
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

    // Local capture of the execution seam so closures created below do not
    // transitively capture `this` (unsendable) when handed to [Isolate.run].
    // Accessing `this.offload` directly inside a closure would bind the
    // receiver into the closure context and make it un-isolatable.
    final offloadRunner = offload;

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
      final msg = _pullErrorDetail(e, 'hash_index.json');
      errors.add(msg);
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
      final msg = _pullErrorDetail(e, 'block listing');
      errors.add(msg);
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

    // Pull every discovered block (sorted by index) with bounded concurrency,
    // preserving chain order. Deobfuscation (CPU-bound AES-CTR + HMAC) runs
    // through the `offload` seam on a background isolate so a large restore
    // never wedges the UI thread (the ANR fix).
    //
    // Bounded concurrency: sliding (consecutive) batches of up to
    // [pullConcurrencyLimit] fetches run via Future.wait; within a batch the
    // fetches are concurrent but results are collected in index order. This
    // keeps prev_hash linkage intact (C2) while never firing 100+ parallel
    // requests at once (C3).
    final fetch = await _fetchAllBlocks(discoveredIndices, t, mkHex,
        offloadRunner, failedBlocks, errors);
    final blocks = fetch.blocks;
    final totalEntries = fetch.totalEntries;

    // B4: if fewer blocks were pulled than hash_index expects, report
    // which indices in [0, hashIndex.length) are missing. If we found
    // at least hashIndex.length blocks (possibly at non-contiguous indices),
    // no indices are reported missing.
    if (blocks.length < hashIndex.length) {
      _addMissingIndices(discoveredIndices, hashIndex.length, failedBlocks);
    }

    // Step 3: Validate the assembled chain before importing (D4).
    // Matches web's WorkerImportSource._validateRawChain: genesis type,
    // block seals, prev_hash linkage, and per-entry hash verification
    // with the 4-way fallback (sort+indent2, sort+compact, nosort+indent2).
    // Off-loaded to the background isolate via the `offload` seam so the
    // CPU-bound SHA-256 chain validation never blocks the UI isolate.
    if (blocks.isNotEmpty) {
      await offloadRunner(() => validatePulledChain(blocks));
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

  /// Fetch every discovered block index with bounded concurrency, decoding
  /// and parsing each out-of-order fetch into [index]-ordered results.
  ///
  /// Returns a record of the ordered parsed blocks plus the total entry count
  /// summed across all successfully fetched blocks. Failures append to
  /// [failedBlocks]/[errors] (declared by the caller) and are skipped.
  ///
  /// Appending from concurrent branches to the shared [failedBlocks]/[errors]
  /// lists is safe: every branch is awaited within this single isolate's event
  /// loop, so the appends serialize — no lock needed.
  Future<({List<Map<String, dynamic>> blocks, int totalEntries})>
      _fetchAllBlocks(
    Set<int> discoveredIndices,
    HttpTransport t,
    String mkHex,
    OffloadRunner offloadRunner,
    List<int> failedBlocks,
    List<String> errors,
  ) async {
    final sortedIndices = discoveredIndices.toList()..sort();
    final blocks = <Map<String, dynamic>>[];
    var totalEntries = 0;

    for (var start = 0; start < sortedIndices.length; start += pullConcurrencyLimit) {
      final end =
          (start + pullConcurrencyLimit).clamp(0, sortedIndices.length);
      final batch = sortedIndices.sublist(start, end);
      final results = await Future.wait(
        batch.map((i) => _fetchDecodeParseBlock(
            t, mkHex, i, offloadRunner, failedBlocks, errors)),
      );
      for (final blockJson in results) {
        if (blockJson == null) continue;
        final entries = blockJson['entries'] as List<dynamic>?;
        totalEntries += entries?.length ?? 0;
        blocks.add(blockJson);
      }
    }
    return (blocks: blocks, totalEntries: totalEntries);
  }

  /// Pull the remote ledger only when it has grown past the local chain.
  ///
  /// ADR-030 freshness rule (D5 append-only): compares the plaintext remote
  /// block count (`ledger/hash_index.json` length) against [localBlockCount].
  ///   - equal (or remote absent/empty) → no change → returns 0 fresh blocks;
  ///   - remote greater → reports the number of new blocks available
  ///     (returned as [PullResult.blocksPulled] for callers to react to).
  ///
  /// This is the *freshness detector*: it never re-downloads an unchanged
  /// chain. When the remote has grown the caller (e.g. the ownership-handoff
  /// flow in [SyncService]) invokes [pullAll] to actually import + seed.
  ///
  /// Requires [CryptoService.hasMasterKey] to be true — throws [StateError]
  /// if no master key is cached. Concurrent calls are serialized.
  Future<PullResult> pullIfRemoteHasMore({
    required int localBlockCount,
  }) async {
    if (!crypto.hasMasterKey) {
      throw StateError(
        'No master key cached. Call setMasterKey() first.',
      );
    }
    final t = transport;
    if (t == null) {
      return PullResult.ok(blocksPulled: 0);
    }

    if (_inFlightFreshness != null) {
      return _inFlightFreshness!;
    }
    _inFlightFreshness = _doPullIfRemoteHasMore(t, localBlockCount);
    try {
      return await _inFlightFreshness!;
    } finally {
      _inFlightFreshness = null;
    }
  }

  /// Core freshness check: fetch the plaintext `ledger/hash_index.json` and
  /// compare its length against [localBlockCount] (delegates to the shared
  /// [pullRemoteHasMore] helper — fail-safe on network/auth failure or a
  /// missing/empty index, so a freshness hiccup never fails a handoff).
  Future<PullResult> _doPullIfRemoteHasMore(
    HttpTransport t,
    int localBlockCount,
  ) {
    return pullRemoteHasMore(
      transport: t,
      hashIndexPath: 'ledger/hash_index.json',
      localBlockCount: localBlockCount,
    );
  }

  /// Produce a human-readable error for pull failures, detecting HTTP 403
  /// (invalid API key) vs generic network errors.
  String _pullErrorDetail(Object error, String operation) {
    if (error is HttpTransportException && error.statusCode == 403) {
      return 'Invalid API key — the Worker rejected the request. '
          'Check the API key and try again.';
    }
    return 'Failed to pull $operation: $error';
  }

  /// Maximum number of block fetches that may be in flight at once.
  ///
  /// Bounds the concurrent `Future.wait` so a large restore never fires one
  /// HTTP request per block (up to 100+ for a long chain) simultaneously.
  static const int pullConcurrencyLimit = 5;

  // ── Per-block fetch + offloaded deobfuscate + parse ───────

  /// Fetch, offloaded-deobfuscate, and parse a single block from the remote.
  ///
  /// Returns the parsed block JSON on success, or `null` on failure
  /// (appending to [failedBlocks] and [errors]).
  ///
  /// The CPU-bound [decodePullBlockBytes] runs through the [offload] seam
  /// (background isolate) so per-block AES-CTR + HMAC deobfuscation never
  /// blocks the UI thread during a large restore.
  ///
  /// **Static** so a closure around a tear-off of it (used by the bounded
  /// concurrent fetch) captures no instance state — required for the closure
  /// handed to [Isolate.run] to be sendable. [offload] (the execution seam)
  /// is passed explicitly.
  static Future<Map<String, dynamic>?> _fetchDecodeParseBlock(
    HttpTransport t,
    String mkHex,
    int index,
    OffloadRunner offload,
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

    // Deobfuscate (off-loaded to a background isolate)
    String decoded;
    try {
      decoded = await offload(() => decodePullBlockBytes(raw, mkHex));
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
    // Dedup against existing staging rows by activity_id/entry_id/hash (P1).
    // `_prepareEntries` strips entry_id/hash before sealing but retains
    // data['activity_id'], so the row-level activity_id column is the only
    // stable key for a committed block entry.
    final existingRows = await stagingStore.getAllRows();
    final deduper = StagingSeedDeduper(existingRows);

    // MK is constant for the whole seed operation — fetch once instead of once
    // per entry (unchanged while we decrypt every block's encrypted fields).
    final mkHex = crypto.getMasterKey()!;

    for (final block in blocks) {
      final blockEntries = block['entries'] as List<dynamic>?;
      if (blockEntries == null) continue;
      for (final raw in blockEntries) {
        if (raw is! Map<String, dynamic>) continue;

        // Extract entry data: PHPSPEC format wraps in {hash, data: {...}}
        final entryData = raw['data'] as Map<String, dynamic>? ?? raw;
        final entryHash = raw['hash'] as String? ?? '';
        final eid = entryData['entry_id'] as String?;
        final entryActivityId = entryData['activity_id'] as String?;

        // Skip if this entry is already in staging (by hash, entry_id, or
        // activity_id). `_prepareEntries` strips entry_id/hash before sealing
        // but retains activity_id, so deduping by it prevents the re-seed copy
        // (P1) — the latent bug that created duplicate rows on the phone.
        if (deduper.skipDuplicate(
          entryHash: entryHash,
          entryId: eid,
          activityId: entryActivityId,
        )) {
          continue;
        }

        // Skip active / paused entries — only completed entries go to staging
        final isActive = entryData['is_active'] as bool? ?? false;
        if (isActive) continue;
        if (entryData['is_paused'] == true) continue;

        // Reuse the block's original activity_id when present (P2) instead of
        // minting a fresh generateActivityId() — otherwise the same committed
        // activity gets a second row under a different id. Falls back to the
        // entry_id (when 10-char) or a generated id for legacy/foreign blocks.
        final activityId = resolveSeedActivityId(
          blockActivityId: entryActivityId,
          entryId: eid,
        );

        // Build the activity JSON blob with plaintext field names that
        // match what _stagingRowToDto expects. Block entries use encrypted
        // hex fields (startTime_enc, endTime_enc, pauses_enc, metadata_enc)
        // which must be decrypted with the MK first.
        final startEpoch = decryptEpoch(entryData['startTime_enc'] as String?, mkHex);
        final endEpoch = decryptEpoch(entryData['endTime_enc'] as String?, mkHex);
        final pauses = decryptPauses(entryData['pauses_enc'] as String?, mkHex);
        final deviceUuid = entryData['device_uuid'] as String? ?? '';

        // Preserve encrypted sensitive-field ciphertexts as hex for on-demand
        // decryption (B1–B3). Plaintext fallbacks are used when no encrypted
        // field is present.
        final titleEnc = entryData['title_enc'] as String?;
        final tagsEnc = entryData['tags_enc'] as String?;
        final commentEnc = entryData['comment_enc'] as String?;

        final title = (titleEnc != null && titleEnc.isNotEmpty)
            ? ''  // Encrypted: leave plaintext empty (DTO shows [Encrypted])
            : (entryData['title'] as String? ?? '');
        final tags = (tagsEnc != null && tagsEnc.isNotEmpty)
            ? <dynamic>[]
            : (entryData['tags'] ?? <dynamic>[]);
        final comment = (commentEnc != null && commentEnc.isNotEmpty)
            ? ''
            : (entryData['comment'] as String? ?? '');
        final durationEnc = entryData['duration_enc'] as String?;
        final durStr = (durationEnc != null)
            ? decryptFieldValue(durationEnc, mkHex)
            : null;
        final duration = entryData['duration'] is int
            ? entryData['duration'] as int
            : int.tryParse(durStr ?? entryData['duration']?.toString() ?? '0') ?? 0;

        final activity = jsonEncode({
          'entry_id': eid ?? '',
          'hash': raw['hash'] ?? '',
          'title': title,
          'title_enc': titleEnc,
          'tags_enc': tagsEnc,
          'comment_enc': commentEnc,
          'start_epoch': startEpoch,
          'end_epoch': endEpoch,
          'duration': duration,
          'is_active': false,
          'is_paused': false,
          'pauses': pauses,
          'tags': tags,
          'comment': comment,
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
