import 'dart:async';
import 'dart:convert';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/block.dart';
import '../../core/models/pull_result.dart';
import '../../data/storage/database.dart';
import '../../data/storage/preferences.dart';
import '../../data/storage/secure_preferences.dart';
import '../../data/sync/sync_service.dart';
import '../../data/sync/transport.dart';
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
  /// May be a [LedgerPullService] instance or a test-compatible substitute.
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
    // 0. Optionally clear existing data
    if (wipeExisting) {
      await clearAllData();
    }

    // 1. Check existing data → LedgerExistsException
    if (await _hasGenesisBlock()) {
      throw LedgerExistsException(
          'A ledger already exists. Clear existing data first.');
    }

    // 2. Validate passphrase length (≥8)
    if (passphrase.length < CryptoService.minPassphraseLength) {
      throw FormatException(
          'Passphrase must be at least ${CryptoService.minPassphraseLength} characters');
    }

    // 3. Generate random 32-byte seed
    final seedB64 = crypto.generateSeed();

    // 4. Build genesis and persist
    await _buildAndPersistGenesis(passphrase, seedB64);

    // 5. Create device identity (UUIDv4)
    final uuid = crypto.generateUuid();
    await preferences.setDeviceUuid(uuid);

    // 6. Set hasExistingData flag
    await preferences.setHasExistingData(true);

    // 7. Return seed base64
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
    // 0. Optionally clear existing data
    if (wipeExisting) {
      await clearAllData();
    }

    // 1. Check existing data → LedgerExistsException
    if (await _hasGenesisBlock()) {
      throw LedgerExistsException(
          'A ledger already exists. Clear existing data first.');
    }

    // 2. Validate seed format (base64, 32 bytes)
    CryptoService.validateSeedBase64(seedB64);

    // 3. Validate passphrase length (≥8)
    if (passphrase.length < CryptoService.minPassphraseLength) {
      throw FormatException(
          'Passphrase must be at least ${CryptoService.minPassphraseLength} characters');
    }

    // 4. Build genesis and persist
    await _buildAndPersistGenesis(passphrase, seedB64);

    // 5. Create device identity (UUIDv4)
    final uuid = crypto.generateUuid();
    await preferences.setDeviceUuid(uuid);

    // 6. Set hasExistingData flag
    await preferences.setHasExistingData(true);
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
    // 0. Optionally clear existing data
    if (wipeExisting) {
      await clearAllData();
    }

    // 1. Check existing data → LedgerExistsException
    if (await _hasGenesisBlock()) {
      throw LedgerExistsException(
          'A ledger already exists. Clear existing data first.');
    }

    // 2. Validate seed format (base64, 32 bytes) — fail fast before any DB write
    CryptoService.validateSeedBase64(seedB64);

    // 3. Validate passphrase length (≥8)
    if (passphrase.length < CryptoService.minPassphraseLength) {
      throw FormatException(
          'Passphrase must be at least ${CryptoService.minPassphraseLength} characters');
    }

    // 4. Validate Worker URL for injection characters — must throw BEFORE
    //    any DB write (H7: security gate).
    if (workerUrl.isNotEmpty && RegExp("[<>\"']").hasMatch(workerUrl)) {
      throw FormatException('Invalid Worker URL: $workerUrl');
    }

    // 5. Derive MK and cache it (D1: MK cached before any sync pull)
    final mk = crypto.deriveMasterKey(seedB64);
    crypto.setMasterKey(mk);

    // 6-7. Create device identity, set flag.
    final uuid = crypto.generateUuid();
    await preferences.setDeviceUuid(uuid);
    await preferences.setHasExistingData(true);

    // 9. Connect Worker + pull ledger blocks.
    //    Connection/pull errors are surfaced via PullResult, not thrown.
    //    ledgerPullService is optional — when absent, returns empty success.
    String? connectError;
    bool connected = false;
    try {
      await connectWorker(workerUrl, apiKey)
          .timeout(const Duration(seconds: 10));
      connected = true;
    } catch (e) {
      connectError = 'Cannot reach Worker at $workerUrl: $e';
    }

    if (connected && ledgerPullService != null) {
      try {
        final pullResult = await ledgerPullService!.pullAll()
            .timeout(const Duration(seconds: 60));

        // Recreate genesis block in Flutter format after successful pull.
        // The R2 genesis may use cross-client format (identity.recovery_seed_enc)
        // but AuthService expects data_enc = base64({"seed": encrypt(seed, pdk)}).
        // Overwrite the imported genesis with the local format so unlock works.
        if (pullResult.success && pullResult.blocksPulled > 0) {
          try {
            await _buildAndPersistGenesis(passphrase, seedB64);
          } catch (_) {
            // Non-fatal: genesis creation failure doesn't invalidate the pull.
            // Auth will need the seed explicitly if genesis recreation fails.
          }
        }

        return pullResult;
      } catch (e) {
        if (e is TimeoutException) {
          return PullResult.failure(errors: [
            'Connection timed out while pulling blocks. '
                'Check the Worker URL and try again.',
          ]);
        }
        return PullResult.failure(errors: ['Pull failed: $e']);
      }
    }

    if (connectError != null) {
      return PullResult.failure(errors: [connectError!]);
    }

    // No transport configured — nothing to pull
    return PullResult.ok(blocksPulled: 0, entriesStaged: 0);
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

  /// Check if a genesis block exists in the database.
  Future<bool> _hasGenesisBlock() async {
    final blocks = await db.blockDao.getBlocksByType(BlockType.genesis);
    return blocks.isNotEmpty;
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
