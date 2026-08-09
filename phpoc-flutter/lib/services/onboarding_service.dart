import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/block.dart';
import '../../core/models/pull_result.dart';
import '../../core/utils/decrypt_helpers.dart';
import '../../core/utils/id_utils.dart';
import '../../core/utils/format_utils.dart';
import '../../core/utils/json_utils.dart';
import '../../data/storage/database.dart';
import '../../data/storage/preferences.dart';
import '../../data/storage/secure_preferences.dart';
import '../../data/sync/sync_service.dart';
import '../../data/sync/transport.dart';
import 'ledger_backup_service.dart';
import 'ledger_pull_service.dart';

/// Onboarding service — genesis creation, import, and Worker connection.
///
/// Stateless: each method performs its work and returns. State is persisted
/// via AppPreferences, SecurePreferences, and AppDatabase.
class OnboardingService with DecryptHelpers {
  @override
  final CryptoService crypto;
  final AppDatabase db;
  final AppPreferences preferences;
  final SecurePreferences securePreferences;
  final SyncService syncService;
  /// Ledger pull service for restore-from-cloud. Set by provider injection.
  ///
  /// Typed as dynamic because test mocks substitute non-LedgerPullService
  /// objects (e.g., _FakeLedgerPullService). All callers use null-checks and
  /// runtime type checks before accessing LedgerPullService members.
  // ignore: use_dynamic_as_type
  dynamic ledgerPullService;

  OnboardingService({
    required this.crypto,
    required this.db,
    required this.preferences,
    required this.securePreferences,
    required this.syncService,
    this.ledgerPullService,
  });

  /// Create a new ledger with a fresh genesis block.
  ///
  /// Generates a random 32-byte seed, derives the master key, builds a
  /// genesis block per PHPSPEC §4.1, and persists everything. Returns
  /// the seed as base64 for one-time user backup.
  ///
  /// If [wipeExisting] is true, clears all existing data before creating.
  /// Throws [LedgerExistsException] if a ledger already exists and
  /// [wipeExisting] is false.
  /// Throws validation error if [passphrase] is fewer than 8 characters.
  Future<String> createNewLedger(String passphrase, {bool wipeExisting = false}) async {
    await _ensureNoLedger(wipeExisting);

    // 2. Validate passphrase length (≥8)
    if (passphrase.length < CryptoService.minPassphraseLength) {
      throw FormatException(
          'Passphrase must be at least ${CryptoService.minPassphraseLength} characters');
    }

    // 3. Generate random 32-byte seed
    final seedB64 = crypto.generateSeed();

    await _postImportSetup(passphrase, seedB64);

    // Return seed base64
    return seedB64;
  }

  /// Import a ledger from a recovery seed.
  ///
  /// Parses the seed, derives the master key, builds a genesis block,
  /// and persists everything. This is the "restore from seed backup" flow.
  ///
  /// If [wipeExisting] is true, clears all existing data before importing.
  /// Throws [LedgerExistsException] if data already exists and
  /// [wipeExisting] is false.
  /// Throws format/validation error if [seedB64] is not valid base64.
  Future<void> importFromSeed(String seedB64, String passphrase, {bool wipeExisting = false}) async {
    await _ensureNoLedger(wipeExisting);
    _validateSeedAndPassphrase(seedB64, passphrase);

    await _postImportSetup(passphrase, seedB64);
  }

  /// Restore a ledger from a recovery seed and pull data from the cloud.
  ///
  /// Combines importFromSeed + connectWorker + sync pull into one
  /// atomic onboarding flow. Derives the master key from the seed, builds
  /// a genesis block, creates device identity, connects to the Worker, and
  /// pulls any existing data.
  ///
  /// Returns a [PullResult] indicating success/failure with detailed
  /// error messages. Validation errors (invalid seed, short passphrase,
  /// injection characters in URL) still throw synchronously to fail fast
  /// before any DB write.
  ///
  /// If [wipeExisting] is true, clears all existing data before restoring.
  /// Throws [LedgerExistsException] if data already exists and
  /// [wipeExisting] is false.
  /// Throws validation error if [seedB64] is invalid, [passphrase] is too
  /// short, or [workerUrl] contains injection characters.
  Future<PullResult> restoreFromCloud(
    String seedB64,
    String passphrase,
    String workerUrl,
    String apiKey, {
    bool wipeExisting = false,
  }) async {
    await _ensureNoLedger(wipeExisting);
    _validateSeedAndPassphrase(seedB64, passphrase);

    // 4. Validate Worker URL for injection characters — must throw BEFORE
    //    any DB write (H7: security gate).
    if (workerUrl.isNotEmpty && RegExp("[<>\"']").hasMatch(workerUrl)) {
      throw FormatException('Invalid Worker URL: $workerUrl');
    }

    // 5. Derive MK and cache it (D1: MK cached before any sync pull)
    final mk = crypto.deriveMasterKey(seedB64);
    crypto.setMasterKey(mk);

    // 6. Pull from cloud FIRST — only persist genesis + device identity
    //    AFTER a successful pull so failed restores don't leave the app
    //    half-initialized (genesis exists but chain is empty).
    final result = await _pullFromCloud(workerUrl, apiKey, passphrase, seedB64);

    if (result.success) {
      await _postImportSetup(passphrase, seedB64, keepExistingGenesis: true);
    } else {
      // Clean up: clear MK cache so next attempt starts fresh
      crypto.clearMasterKey();
    }

    return result;
  }

  /// Connect to a Cloudflare Worker for remote sync.
  ///
  /// Stores the URL in [AppPreferences], the API key in [SecurePreferences],
  /// wires the [HttpTransport] into [SyncService], and validates connectivity.
  ///
  /// Throws validation error if [url] is malformed.
  /// Throws [ConnectionException] if the Worker is unreachable.
  Future<void> connectWorker(String url, String apiKey) async {
    // 1. Validate URL format
    final uri = Uri.tryParse(url);
    if (uri == null || !uri.hasScheme || !uri.hasAuthority) {
      throw FormatException('Invalid URL: $url');
    }

    // 2. Delete previous API key before storing new one (I8: clean transition)
    await securePreferences.deleteApiKey();

    // 3. Store URL in preferences
    await preferences.setWorkerUrl(url);

    // 4. Store API key in secure preferences
    await securePreferences.setApiKey(apiKey);

    // 5. Create HttpTransport and wire into SyncService + LedgerPullService
    final transport = HttpTransport(baseUrl: url, apiKey: apiKey);
    syncService.transport = transport;
    final pull = ledgerPullService;
    if (pull != null && pull is LedgerPullService) {
      ledgerPullService = LedgerPullService(
        db: pull.db,
        crypto: pull.crypto,
        transport: transport,
        backupService: pull.backupService,
        stagingStorage: pull.stagingStorage,
        stagingStore: pull.stagingStore,
      );
    }

    // 6. Verify connectivity (best-effort health check)
    // In MVP, connectivity check is non-blocking — configuration is
    // persisted regardless. Connectivity errors are surfaced via
    // SyncService when actual push/pull operations fail.
    try {
      await transport.healthCheck();
    } catch (_) {
      // Best-effort: connectivity will be verified on first sync operation.
      // We don't throw here — the config is already persisted.
    }
  }

  /// Import a ledger from a local JSON file.
  ///
  /// Reads the file at [filePath], detects the format (v1/v2/raw chain),
  /// derives the master key from [seedB64], verifies cryptographic seals,
  /// and persists ledger blocks, staging entries, identity, and a
  /// Flutter-format genesis block.
  ///
  /// If [wipeExisting] is true, clears all existing data before importing.
  /// Throws [LedgerExistsException] if a ledger already exists and
  /// [wipeExisting] is false.
  /// Throws [FormatException] if the file is malformed JSON.
  /// Throws validation error if seal verification fails (wrong seed or
  /// tampered file).
  Future<void> importFromFile(
    String filePath,
    String seedB64,
    String passphrase, {
    bool wipeExisting = false,
  }) async {
    await _ensureNoLedger(wipeExisting);
    _validateSeedAndPassphrase(seedB64, passphrase);

    // 4. Derive MK for seal verification
    final mk = crypto.deriveMasterKey(seedB64);

    // 5. Read file
    final file = File(filePath);
    final content = await file.readAsString();

    // 6. Parse JSON
    dynamic parsed;
    try {
      parsed = jsonDecode(content);
    } catch (e) {
      throw FormatException('Invalid JSON file: $e');
    }

    // 7. Detect format and process
    if (parsed is List) {
      await _importRawChain(parsed, passphrase, seedB64);
    } else if (parsed is Map<String, dynamic>) {
      final version = parsed['format_version'];
      if (version == '2') {
        await _importV2(parsed, mk, passphrase, seedB64);
      } else if (version == '1') {
        await _importV1(parsed, mk, passphrase, seedB64);
      } else {
        throw FormatException('Unknown format version: $version');
      }
    } else {
      throw FormatException('Unrecognized file format');
    }
  }

  /// Check whether a ledger already exists on this device.
  ///
  /// Uses a three-tier check:
  /// 1. Preferences flag (hasExistingData)
  /// 2. Genesis block in database
  /// 3. Auto-heal: if genesis exists but flag is absent, set the flag.
  Future<bool> hasExistingData() async {
    // 1. Check preferences flag
    if (await preferences.hasExistingData()) {
      return true;
    }

    // 2. Check for genesis block in database
    final hasGenesis = await _hasGenesisBlock();

    // 3. Auto-heal: if genesis exists but flag is absent, set the flag
    if (hasGenesis) {
      await preferences.setHasExistingData(true);
      return true;
    }

    return false;
  }

  /// Clear all ledger data from the database and preferences.
  ///
  /// Deletes all blocks, entries, and index entries from the database,
  /// and resets the device identity and existing-data flag. The database
  /// schema is preserved (tables remain, only rows are deleted).
  ///
  /// This is idempotent — safe to call even if no data exists.
  Future<void> clearAllData() async {
    await db.transaction(() async {
      await db.customStatement('DELETE FROM index_entries');
      await db.customStatement('DELETE FROM entries');
      await db.customStatement('DELETE FROM blocks');
    });
    await preferences.setHasExistingData(false);
    await preferences.setDeviceUuid('');
    crypto.clearMasterKey();
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  /// Wipe existing data if requested, then verify no ledger exists.
  ///
  /// Throws [LedgerExistsException] if a genesis block already exists
  /// and [wipeExisting] is false.
  Future<void> _ensureNoLedger(bool wipeExisting) async {
    if (wipeExisting) {
      await clearAllData();
    }
    if (await _hasGenesisBlock()) {
      throw LedgerExistsException(
          'A ledger already exists. Clear existing data first.');
    }
  }

  /// Validate seed format and passphrase length.
  ///
  /// Throws [FormatException] if [seedB64] is invalid base64 or [passphrase]
  /// is shorter than [CryptoService.minPassphraseLength].
  void _validateSeedAndPassphrase(String seedB64, String passphrase) {
    CryptoService.validateSeedBase64(seedB64);
    if (passphrase.length < CryptoService.minPassphraseLength) {
      throw FormatException(
          'Passphrase must be at least ${CryptoService.minPassphraseLength} characters');
    }
  }

  /// Pull data from the cloud: connect Worker, pull ledger blocks, pull staging.
  ///
  /// Connection and pull errors are surfaced via [PullResult.failure].
  /// When [ledgerPullService] is absent, returns [PullResult.ok] with zeros.
  Future<PullResult> _pullFromCloud(
    String workerUrl, String apiKey, String passphrase, String seedB64,
  ) async {
    String? connectError;
    bool connected = false;
    try {
      await connectWorker(workerUrl, apiKey)
          .timeout(const Duration(seconds: 20));
      connected = true;
    } catch (e) {
      if (e is HttpTransportException && e.statusCode == 403) {
        connectError = 'Invalid API key — the Worker at $workerUrl '
            'rejected the connection. Check the API key and try again.';
      } else {
        connectError = 'Cannot reach Worker at $workerUrl: $e';
      }
    }

    PullResult? pullResult;
    String? pullError;

    if (connected && ledgerPullService != null) {
      try {
        pullResult = await ledgerPullService!.pullAll()
            .timeout(const Duration(seconds: 120));
      } catch (e) {
        if (e is TimeoutException) {
          pullError = 'Connection timed out while pulling blocks. '
              'Check the Worker URL and try again.';
        } else {
          pullError = 'Pull failed: $e';
        }
      }
    }

    // Pull staging entries from remote (best-effort).
    // Only needed when no blocks were pulled — block pull already
    // seeds staging via _seedStagingFromBlocks. Running both would
    // create duplicate entries because the phone's staging/blob uses
    // different activity_id values than the block-seeded entries.
    if (connected && pullError == null && pullResult == null) {
      try {
        await syncService.initialPull()
            .timeout(const Duration(seconds: 60));
      } catch (_) {
        // Degraded mode: staging pull failure does not block restore.
      }
    }

    if (pullError != null) {
      return PullResult.failure(errors: [pullError]);
    }
    if (connectError != null) {
      return PullResult.failure(errors: [connectError]);
    }
    if (pullResult != null) return pullResult;

    return PullResult.ok(blocksPulled: 0, entriesStaged: 0);
  }

  /// Check if a genesis block exists in the database.
  Future<bool> _hasGenesisBlock() async {
    final blocks = await db.blockDao.getBlocksByType(BlockType.genesis);
    return blocks.isNotEmpty;
  }

  // ── File import helpers ────────────────────────────────────

  /// Import a v2 export (format_version: "2").
  ///
  /// Contains both ledger blocks and staging entries with a top-level
  /// cryptographic seal over {ledger, staging}.
  Future<void> _importV2(Map<String, dynamic> parsed, String mk,
      String passphrase, String seedB64) async {
    final ledger = parsed['ledger'];
    final staging = parsed['staging'];
    final seal = parsed['seal'] as String?;

    if (ledger == null) {
      throw const FormatException('v2 export missing "ledger" field');
    }
    if (staging == null) {
      throw const FormatException('v2 export missing "staging" field');
    }
    if (seal == null) {
      throw const FormatException('v2 export missing "seal" field');
    }

    // Verify cryptographic seal
    final payload = jsonEncode({'ledger': ledger, 'staging': staging});
    if (!crypto.verifySeal(payload, seal, mk)) {
      throw const FormatException(
          'Seal verification failed: wrong recovery seed or tampered file');
    }

    // Import ledger blocks via LedgerBackupService
    final backupService = LedgerBackupService(db: db);
    await backupService.importFromJson(jsonEncode(ledger));

    // Write staging entries
    await _writeStagingEntries(staging);

    // Post-import: Flutter-format genesis, device identity, flag
    await _postImportSetup(passphrase, seedB64);

    // Seed staging from imported blocks (in addition to the explicit
    // staging entries above) so committed ledger entries are visible.
    await _seedStagingFromImportedBlocks();
  }

  /// Import a v1 export (format_version: "1").
  ///
  /// Contains only staging entries with a top-level seal over {entries}.
  /// No ledger blocks are imported.
  Future<void> _importV1(Map<String, dynamic> parsed, String mk,
      String passphrase, String seedB64) async {
    final entries = parsed['entries'];
    final seal = parsed['seal'] as String?;

    if (entries == null) {
      throw const FormatException('v1 export missing "entries" field');
    }
    if (seal == null) {
      throw const FormatException('v1 export missing "seal" field');
    }

    // Verify cryptographic seal
    final payload = jsonEncode({'entries': entries});
    if (!crypto.verifySeal(payload, seal, mk)) {
      throw const FormatException(
          'Seal verification failed: wrong recovery seed or tampered file');
    }

    // Write staging entries (no ledger blocks for v1)
    await _writeStagingEntries(entries);

    // Post-import: Flutter-format genesis, device identity, flag
    await _postImportSetup(passphrase, seedB64);
  }

  /// Import a raw chain (JSON array of blocks, e.g. ledger.json).
  ///
  /// No envelope seal — raw blocks are imported directly.
  Future<void> _importRawChain(
      List<dynamic> blocks, String passphrase, String seedB64) async {
    final backupService = LedgerBackupService(db: db);
    await backupService.importFromJson(jsonEncode(blocks));

    // Post-import: Flutter-format genesis, device identity, flag
    await _postImportSetup(passphrase, seedB64);

    // Seed staging table from imported blocks so Dashboard/History
    // can display committed ledger entries without a separate sync step.
    await _seedStagingFromImportedBlocks();
  }

  /// Write staging entries from a parsed JSON list into the staging table.
  ///
  /// Accepts a [List] from either v1 ("entries" key) or v2 ("staging" key)
  /// format. Each element is converted to a row in the [StagingStore] so
  /// Dashboard and History screens can display imported entries.
  ///
  /// Handles both Python export field names ("hash", "metadata") and
  /// Flutter internal field names ("content_hash", "metadata_enc").
  Future<void> _writeStagingEntries(dynamic entries) async {
    if (entries is! List) return;
    final store = syncService.stagingStore;
    if (store == null) return;

    for (final entry in entries) {
      if (entry is! Map<String, dynamic>) continue;

      final activityId = (entry['entry_id'] as String?)?.isNotEmpty == true
          ? entry['entry_id'] as String
          : generateActivityId();
      final isActive = entry['is_active'] as bool? ?? false;
      final pauses = (entry['pauses'] as List<dynamic>?) ?? <dynamic>[];

      final activityData = {
        'entry_id': entry['entry_id'] ?? '',
        'hash': entry['hash'] ?? entry['content_hash'] ?? '',
        'title': entry['title'] ?? '',
        'start_epoch': entry['start_epoch'] ?? 0,
        'end_epoch': entry['end_epoch'],
        'duration': entry['duration'] ?? 0,
        'is_active': isActive,
        'is_paused': entry['is_paused'] ?? false,
        'pauses': pauses,
        'tags': entry['tags'] ?? <dynamic>[],
        'comment': entry['comment'] ?? '',
        'media': entry['media'] ?? <dynamic>[],
        'device_uuid': entry['device_uuid'] ?? '',
        'committed': entry['committed'] ?? false,
      };

      try {
        await store.putRow({
          'activity_id': activityId,
          'activity_status': isActive ? 'active' : 'ended',
          'activity': jsonEncode(activityData),
          'updated_at': DateTime.now().millisecondsSinceEpoch,
          'committed': entry['committed'] ?? false,
        });
      } catch (_) {
        // Best-effort: staging write failure does not block import
      }
    }
  }

  /// Seed the staging table with entries extracted from imported ledger
  /// blocks (raw chain and v2 imports).
  ///
  /// Reads non-genesis, non-summary blocks from the database, decodes their
  /// base64-encoded entry arrays, decrypts encrypted fields with the master
  /// key, and writes each completed entry as a row to the [StagingStore].
  /// This mirrors [LedgerPullService._seedStagingFromBlocks] for cloud pulls.
  ///
  /// Entries already present in staging (matched by entry_id) are skipped.
  Future<void> _seedStagingFromImportedBlocks() async {
    final mkHex = crypto.getMasterKey();
    if (mkHex == null) return;

    final store = syncService.stagingStore;
    if (store == null) return;

    // Collect existing entry hashes AND entry_ids to avoid duplicates.
    // Raw chain entries use content_hash (no entry_id), while v1/v2
    // staging exports have entry_id. We track both to deduplicate either.
    final existingRows = await store.getAllRows();
    final existingHashes = <String>{};
    for (final row in existingRows) {
      try {
        final data = jsonDecode(row['activity'] as String? ?? '{}')
            as Map<String, dynamic>;
        final h = data['hash'] as String?;
        if (h != null && h.isNotEmpty) existingHashes.add(h);
        final eid = data['entry_id'] as String?;
        if (eid != null && eid.isNotEmpty) existingHashes.add(eid);
      } catch (_) {}
    }

    // Read all blocks from the database.
    final blocks = await db.blockDao.getAllBlocks();

    for (final block in blocks) {
      // Skip genesis and summary blocks — only day blocks have entries.
      if (block.blockType == BlockType.genesis ||
          block.blockType == BlockType.month ||
          block.blockType == BlockType.year) {
        continue;
      }

      // Decode data_enc: base64 → UTF-8 JSON array of PHPSPEC entry objects.
      List<dynamic> entriesList;
      try {
        final jsonStr = utf8.decode(base64.decode(block.dataEnc));
        entriesList = jsonDecode(jsonStr) as List<dynamic>;
      } catch (_) {
        continue; // Corrupted or genesis-format data_enc — skip
      }

      for (final raw in entriesList) {
        if (raw is! Map<String, dynamic>) continue;

        // PHPSPEC entry format: {hash, data: {title, startTime_enc, ...}}
        final entryData = raw['data'] as Map<String, dynamic>? ?? raw;
        final entryHash = raw['hash'] as String? ?? '';
        final eid = entryData['entry_id'] as String?;

        // Dedup: skip if this entry (by hash or entry_id) is already in staging.
        if (entryHash.isNotEmpty && existingHashes.contains(entryHash)) {
          continue;
        }
        if (eid != null && eid.isNotEmpty && existingHashes.contains(eid)) {
          continue;
        }
        if (entryHash.isNotEmpty) existingHashes.add(entryHash);
        if (eid != null && eid.isNotEmpty) existingHashes.add(eid);

        // Only seed completed entries.
        final isActive = entryData['is_active'] as bool? ?? false;
        if (isActive) continue;
        if (entryData['is_paused'] == true) continue;

        final activityId = (eid != null && eid.length == 10)
            ? eid
            : generateActivityId();

        // Decrypt time fields (encrypted in block storage).
        final startEpoch =
            decryptEpoch(entryData['startTime_enc'] as String?, mkHex);
        final endEpoch =
            decryptEpoch(entryData['endTime_enc'] as String?, mkHex);
        final pauses =
            decryptPauses(entryData['pauses_enc'] as String?, mkHex);

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
          'device_uuid': entryData['device_uuid'] ?? '',
          'committed': true,
        });

        try {
          await store.putRow({
            'activity_id': activityId,
            'activity_status': 'ended',
            'activity': activity,
            'updated_at': DateTime.now().millisecondsSinceEpoch,
            'committed': true,
          });
        } catch (_) {
          // Best-effort: staging seed failure does not block import
        }
      }
    }
  }





  /// One-time repair: seed staging from ledger blocks and backfill
  /// comment/media fields into existing staging entries.
  ///
  /// Safe to call at any time — dedup prevents duplicate entries and
  /// only missing fields are updated.
  ///
  /// Returns the number of entries seeded or updated (0 if nothing to repair).
  Future<int> repairMissingStagingEntries() async {
    // Only run if the master key is available (post-auth).
    if (!crypto.hasMasterKey) return 0;

    final store = syncService.stagingStore;
    if (store == null) return 0;

    final stagingCount = await store.count();
    final blockCount = (await db.blockDao.getAllBlocks())
        .where((b) => b.blockType == BlockType.day)
        .length;

    debugPrint(
        '[OnboardingService] Repair: seeding staging from $blockCount blocks '
        '(staging has $stagingCount entries)');

    // 1. Seed any entries not yet in staging.
    await _seedStagingFromImportedBlocks();

    // 2. Backfill comment / media from block entries into existing
    //    staging entries that were created before these fields were stored.
    await _backfillCommentAndMedia();

    return blockCount;
  }

  /// Update existing staging entries with comment/media from block data.
  ///
  /// Matches staging entries to block entries by hash. For entries where
  /// the staging blob is missing comment/media but the block entry has it,
  /// writes the updated blob back to the staging table.
  Future<void> _backfillCommentAndMedia() async {
    final mkHex = crypto.getMasterKey();
    if (mkHex == null) return;

    final store = syncService.stagingStore;
    if (store == null) return;

    // Build a map of hash → block entry data for quick lookup.
    final blockEntriesByHash = <String, Map<String, dynamic>>{};
    final blocks = await db.blockDao.getAllBlocks();
    for (final block in blocks) {
      if (block.blockType == BlockType.genesis ||
          block.blockType == BlockType.month ||
          block.blockType == BlockType.year) {
        continue;
      }
      List<dynamic> entriesList;
      try {
        final jsonStr = utf8.decode(base64.decode(block.dataEnc));
        entriesList = jsonDecode(jsonStr) as List<dynamic>;
      } catch (_) {
        continue;
      }
      for (final raw in entriesList) {
        if (raw is! Map<String, dynamic>) continue;
        final h = raw['hash'] as String?;
        if (h != null && h.isNotEmpty) {
          blockEntriesByHash[h] = raw['data'] as Map<String, dynamic>? ?? raw;
        }
      }
    }

    // Scan staging entries and update those missing comment/media.
    final rows = await store.getAllRows();
    int updated = 0;
    for (final row in rows) {
      try {
        final activityData =
            jsonDecode(row['activity'] as String? ?? '{}') as Map<String, dynamic>;
        final hash = activityData['hash'] as String? ?? '';

        // Skip entries that already have a comment.
        if (activityData['comment'] != null &&
            activityData['comment'] is String &&
            (activityData['comment'] as String).isNotEmpty) {
          continue;
        }

        final blockData = blockEntriesByHash[hash];
        if (blockData == null) continue;

        final comment = blockData['comment'];
        final media = blockData['media'];

        bool changed = false;
        if (comment != null && comment is String && comment.isNotEmpty) {
          activityData['comment'] = comment;
          changed = true;
        }
        if (media != null && media is List && media.isNotEmpty) {
          activityData['media'] = media;
          changed = true;
        }

        if (changed) {
          await store.putRow({
            'activity_id': row['activity_id'],
            'activity_status': row['activity_status'],
            'activity': jsonEncode(activityData),
            'updated_at': DateTime.now().millisecondsSinceEpoch,
            'committed': activityData['committed'] ?? false,
          });
          updated++;
        }
      } catch (_) {
        // Best-effort per entry
      }
    }

    debugPrint(
        '[OnboardingService] Backfill: updated $updated staging entries '
        'with comment/media from block data');
  }

  /// Common post-import setup: seed vault, Flutter-format genesis (optional),
  /// device identity, and hasExistingData flag.
  ///
  /// When [keepExistingGenesis] is true (cloud restore), the R2 genesis
  /// block is preserved and only the seed is stored in the vault. When
  /// false (local creation, seed/file import), a new Flutter-format genesis
  /// block is built and persisted alongside vault storage.
  Future<void> _postImportSetup(String passphrase, String seedB64,
      {bool keepExistingGenesis = false}) async {
    // Store seed in vault (always — primary seed storage)
    await _storeSeedInVault(passphrase, seedB64);

    if (keepExistingGenesis) {
      // Cloud restore: R2 genesis exists and must be preserved.
      // Only cache MK and set device identity — no genesis replacement.
      final mk = crypto.deriveMasterKey(seedB64);
      crypto.setMasterKey(mk);
    } else {
      // Local creation / import: build Flutter-format genesis block.
      await _buildAndPersistGenesis(passphrase, seedB64);
    }

    // Create device identity (UUIDv4)
    final uuid = crypto.generateUuid();
    await preferences.setDeviceUuid(uuid);

    // Set hasExistingData flag
    await preferences.setHasExistingData(true);
  }

  /// Store the PDK-encrypted recovery seed in the _phpoc_meta vault.
  ///
  /// Encrypts [seedB64] with a PDK derived from [passphrase] and stores
  /// the ciphertext via [AppDatabase.setSeedVault]. This separates seed
  /// storage from the genesis block so the chain remains immutable.
  Future<void> _storeSeedInVault(String passphrase, String seedB64) async {
    final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
    final encryptedSeed = crypto.encrypt(seedB64, pdk);
    await db.setSeedVault(encryptedSeed);
  }

  /// Build a genesis block and persist it to the database.
  ///
  /// The genesis stores the seed encrypted with PDK:
  ///   data_enc = base64(json({"seed": encrypt(seedB64, pdk)}))
  ///   identity_seal = HMAC-SHA256(MK, data_enc)
  ///
  /// The block seal is computed with [jsonSort] (sorted keys) for
  /// cross-client verifiability. Previously [json.encode] was used which
  /// produces non-deterministic key ordering (RC1 fix).
  Future<void> _buildAndPersistGenesis(
      String passphrase, String seedB64) async {
    // Derive PDK and MK
    final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
    final mk = crypto.deriveMasterKey(seedB64);

    // Cache MK so downstream operations (staging seeding, entry decryption)
    // have access to the key without requiring a separate re-auth step.
    crypto.setMasterKey(mk);

    // Encrypt seed base64 string with PDK (seedB64 is already a valid UTF-8 string)
    final encryptedSeed = crypto.encrypt(seedB64, pdk);

    // Build genesis data JSON
    final genesisData = json.encode({'seed': encryptedSeed});
    final dataEncB64 = base64.encode(utf8.encode(genesisData));

    // Identity seal (HMAC of data_enc — bound to the encrypted seed data)
    final identitySeal = crypto.seal(dataEncB64, mk);

    // Block hash: use jsonSort (sorted keys) for cross-client verifiability.
    // json.encode() produces unsorted output (RC1) — jsonSort is canonical.
    final now = DateTime.now();
    final nowSeconds = now.millisecondsSinceEpoch ~/ 1000;
    final genesisPayloadObj = {
      'type': 'genesis',
      'day_index': 0,
      'date': FormatUtils.epochToIsoDate(nowSeconds),
      'prev_hash': Block.genesisPrevHash,
      'entries': <dynamic>[],
    };
    final genesisPayload = jsonSort(genesisPayloadObj);
    final blockId = crypto.seal(genesisPayload, mk);

    // Replace any existing genesis block(s) from R2 import with Flutter format.
    // R2 blocks may use cross-client genesis structures that AuthService can't read.
    await db.customStatement(
        'DELETE FROM blocks WHERE block_type = ?', ['genesis']);
    await db.blockDao.insertBlock(Block(
      blockId: blockId,
      blockType: BlockType.genesis,
      blockIndex: 0,
      keyVersion: 1,
      dataEnc: dataEncB64,
      identitySeal: identitySeal,
      prevHash: Block.genesisPrevHash,
      createdAt: nowSeconds,
    ));

    // Update block 1's prev_hash to point to the new genesis block.
    // Without this, replacing genesis creates a chain linkage break
    // because block 1 still points to the old genesis hash.
    await db.customStatement(
      'UPDATE blocks SET prev_hash = ? WHERE block_type = ? AND block_index = ?',
      [blockId, BlockType.day.name, 1]);
  }
}

/// Thrown when attempting to create or import a ledger that already exists.
class LedgerExistsException implements Exception {
  final String message;
  const LedgerExistsException(this.message);
  @override
  String toString() => 'LedgerExistsException: $message';
}

/// Thrown when a Worker connection attempt fails.
class ConnectionException implements Exception {
  final String message;
  const ConnectionException(this.message);
  @override
  String toString() => 'ConnectionException: $message';
}

/// Thrown when the app is in an invalid state for the requested operation.
class StateException implements Exception {
  final String message;
  const StateException(this.message);
  @override
  String toString() => 'StateException: $message';
}
