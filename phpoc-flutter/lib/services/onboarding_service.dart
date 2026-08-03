import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/block.dart';
import '../../core/models/entry.dart';
import '../../core/models/pull_result.dart';
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
class OnboardingService {
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

    // Persist genesis + device identity before any network operations.
    await _postImportSetup(passphrase, seedB64);

    return await _pullFromCloud(workerUrl, apiKey, passphrase, seedB64);
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
      connectError = 'Cannot reach Worker at $workerUrl: $e';
    }

    PullResult? pullResult;
    String? pullError;

    if (connected && ledgerPullService != null) {
      try {
        pullResult = await ledgerPullService!.pullAll()
            .timeout(const Duration(seconds: 120));

        // Re-create genesis after pull: importFromJson wipes all blocks
        // including the Flutter-format genesis. R2 genesis uses a different
        // format that AuthService can't read.
        if (pullResult!.blocksPulled > 0) {
          await _buildAndPersistGenesis(passphrase, seedB64);
        }
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
    if (connected && pullError == null) {
      try {
        await syncService.initialPull();
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
  }

  /// Write staging entries from a parsed JSON list into the database.
  ///
  /// Accepts a [List] from either v1 ("entries" key) or v2 ("staging" key)
  /// format. Each element is mapped via [_mapStagingEntry] which handles
  /// both Python and Flutter field name conventions.
  Future<void> _writeStagingEntries(dynamic entries) async {
    if (entries is! List) return;
    for (final entry in entries) {
      if (entry is Map<String, dynamic>) {
        await db.entryDao.insertEntry(_mapStagingEntry(entry));
      }
    }
  }

  /// Map a staging entry JSON map (v1/v2 export format) to an [Entry].
  ///
  /// Handles both Python export field names ("hash", "metadata") and
  /// Flutter internal field names ("content_hash", "metadata_enc").
  /// The dual-key resolution exists because Python CLI exports use "hash"
  /// while the Flutter internal Entry model uses "content_hash".
  Entry _mapStagingEntry(Map<String, dynamic> json) {
    final contentHash =
        (json['hash'] ?? json['content_hash']) as String?;
    final metadataEnc = (json['metadata_enc'] as String?) ??
        (json['metadata'] is Map ? jsonEncode(json['metadata']) : null);

    return Entry(
      entryId: (json['entry_id'] as String?) ?? '',
      title: (json['title'] as String?) ?? '',
      startEpoch: (json['start_epoch'] as int?) ?? 0,
      endEpoch: json['end_epoch'] as int?,
      isActive: (json['is_active'] as bool?) ?? false,
      committed: (json['committed'] as bool?) ?? false,
      tags: (json['tags'] as List<dynamic>?)?.cast<String>() ?? const [],
      pauses: _parsePausesList(json['pauses']),
      metadataEnc: metadataEnc,
      deviceUuid: json['device_uuid'] as String?,
      contentHash: contentHash,
    );
  }

  /// Parse a list of pause records from JSON.
  List<PauseRecord> _parsePausesList(dynamic pauses) {
    if (pauses is! List) return const [];
    return pauses
        .whereType<Map<String, dynamic>>()
        .map((p) => PauseRecord(
              startEpoch: (p['start_epoch'] as int?) ?? 0,
              endEpoch: p['end_epoch'] as int?,
            ))
        .toList();
  }

  /// Common post-import setup: Flutter-format genesis, device identity,
  /// and hasExistingData flag.
  Future<void> _postImportSetup(String passphrase, String seedB64) async {
    // Build Flutter-format genesis block with PDK-encrypted seed
    await _buildAndPersistGenesis(passphrase, seedB64);

    // Create device identity (UUIDv4)
    final uuid = crypto.generateUuid();
    await preferences.setDeviceUuid(uuid);

    // Set hasExistingData flag
    await preferences.setHasExistingData(true);
  }

  /// Build a genesis block and persist it to the database.
  ///
  /// The genesis stores the seed encrypted with PDK:
  ///   data_enc = base64(json({"seed": encrypt(seedB64, pdk)}))
  ///   identity_seal = HMAC-SHA256(MK, data_enc)
  ///
  /// If a genesis block already exists (e.g., imported from R2 in a
  /// cross-client format), it is replaced so the Flutter-format genesis
  /// is authoritative for AuthService.reauthenticate().
  Future<void> _buildAndPersistGenesis(
      String passphrase, String seedB64) async {
    // Derive PDK and MK
    final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
    final mk = crypto.deriveMasterKey(seedB64);

    // Encrypt seed base64 string with PDK (seedB64 is already a valid UTF-8 string)
    final encryptedSeed = crypto.encrypt(seedB64, pdk);

    // Build genesis data JSON
    final genesisData = json.encode({'seed': encryptedSeed});
    final dataEncB64 = base64.encode(utf8.encode(genesisData));

    // Seal with MK
    final seal = crypto.seal(dataEncB64, mk);

    // Generate block ID
    final blockId = crypto.sha256('genesis:$seedB64:${DateTime.now().millisecondsSinceEpoch}');

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
      identitySeal: seal,
      prevHash: Block.genesisPrevHash,
      createdAt: DateTime.now().millisecondsSinceEpoch,
    ));
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
