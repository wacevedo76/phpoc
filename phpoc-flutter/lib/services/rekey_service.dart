import 'dart:convert';
import 'dart:io';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/block.dart';
import '../../data/storage/database.dart';
import '../../data/storage/preferences.dart';
import '../../data/storage/secure_preferences.dart';
import 'auth_service.dart';
import 'ledger_backup_service.dart';
import 'ledger_push_service.dart';

/// Result of a full seed-replacement (C-2) re-key.
///
/// Carries the side effects the Settings UI needs to render after a
/// successful `rekey()`: the new seed (for the two-step reveal), how many
/// blocks were re-encrypted, whether the remote/R2 chain was updated, and a
/// pointer to the local recovery snapshot written before any mutation.
class RekeyResult {
  final String newSeed;
  final String newSeedFingerprint;
  final int blocksReencrypted;
  final bool remotePushed;
  final String backupPath;

  const RekeyResult({
    required this.newSeed,
    required this.newSeedFingerprint,
    required this.blocksReencrypted,
    required this.remotePushed,
    required this.backupPath,
  });
}

/// C-2 full seed replacement (option a: new seed becomes the new raw MK).
///
/// Orchestrates replacing the current recovery seed with a fresh random seed
/// and re-encrypting the ENTIRE ledger (vault, every block's `_enc` fields,
/// seals, genesis `recovery_seed_enc`, and remote/R2 payload) under the new
/// Master Key, so a leaked/compromised old seed can no longer access the
/// ledger.
///
/// Option (a) keeps the existing raw-seed-as-MK derivation: the new seed's
/// base64-decoded 32 bytes become the new MK. `key_version` is left
/// unchanged (no versioned-MK bump); NO new fields are added to the ledger
/// blocks themselves. Re-key metadata (seed_fingerprint, rekeyed marker) is
/// stored in AppPreferences, never in the chain block schema.
class RekeyService {
  final AuthService auth;
  final CryptoService crypto;
  final AppDatabase db;
  final AppPreferences preferences;
  final SecurePreferences securePreferences;
  final LedgerBackupService backupService;
  final LedgerPushService? pushService;

  /// Pending new seed produced by the most recent successful `rekey()`,
  /// gated by the two-step reveal (B5 / S3).
  String? _pendingNewSeed;
  bool _revealConfirmed = false;

  RekeyService({
    required this.auth,
    required this.crypto,
    required this.db,
    required this.preferences,
    required this.securePreferences,
    required this.backupService,
    this.pushService,
  });

  /// Mint a fresh cryptographically-random 32-byte base64 recovery seed that
  /// differs from [currentSeed] (R3, R4).
  String mintNewSeed(String currentSeed) {
    for (var attempt = 0; attempt < 16; attempt++) {
      final seed = crypto.generateSeed();
      if (seed != currentSeed) return seed;
    }
    return crypto.generateSeed();
  }

  /// Replace the current seed with [newSeed] and re-key the whole ledger.
  ///
  /// Requires the old passphrase to decrypt the current seed (R1) and an
  /// unlocked session (cached MK). Snapshot a recovery backup before any
  /// write (R2, B1) and refuse to double-run once a re-key marker exists (B3).
  /// All re-keyed blocks are computed in memory first, then the chain is
  /// replaced in a single transaction, so a failure mid-loop leaves no partial
  /// write (B2).
  ///
  /// On success the ledger, vault and genesis seed are re-keyed under the new
  /// MK / new PDK, the device cookie is rotated (P3), and a re-key marker is
  /// recorded. The session stays unlocked under the new key set.
  Future<RekeyResult> rekey({
    required String oldPassphrase,
    String? newPassphrase,
    required String newSeed,
  }) async {
    // B3: idempotent guard — refuse a double-run once a marker exists.
    if (await hasRekeyed()) {
      throw StateError(
        'Re-key already performed — the ledger has been seeded under a new '
        'recovery root. Running again is not permitted.',
      );
    }

    final effectiveNewPassphrase = newPassphrase ?? oldPassphrase;

    // R1: ownership gate — requires a cached MK (unlocked) AND that the old
    // passphrase decrypts the current seed. Throws AuthException otherwise.
    final oldMK = crypto.getMasterKey();
    if (oldMK == null) {
      throw AuthException('Not unlocked — cannot re-key');
    }
    // R1: ownership gate — the old passphrase must decrypt the current seed.
    await auth.exportSeed(oldPassphrase);

    final newMK = crypto.deriveMasterKey(newSeed);
    final newPdk = crypto.derivePdk(
      effectiveNewPassphrase,
      CryptoService.pdkIterations,
    );

    // R2/B1: snapshot a recovery backup under the OLD key set before any write.
    final backupPath = await preflightSnapshotAndWrite();

    // Build every re-keyed block in memory first (no DB writes yet) so a
    // mid-loop failure throws BEFORE touching the database (B2). This is the
    // Flutter mirror of Python's `RotateKeysCommand.hard_rotate` loop.
    final rebuilt = await _buildRebuiltBlocks(
      oldMK: oldMK,
      newMK: newMK,
      newPdk: newPdk,
      newSeed: newSeed,
    );

    // Atomically replace the chain + re-encrypt the vault (R5/R6, B2).
    final fingerprint = seedFingerprint(newSeed);
    await _replaceChainAndVault(
      rebuilt,
      newSeed: newSeed,
      newPdk: newPdk,
    );

    // Rotate the device cookie so old-MK sessions re-auth on next sync (P3),
    // record the re-key marker + fingerprint (B3/B4), and hand the live
    // crypto session to the NEW master key (R10/R11).
    await _rotateDeviceCoordinates();
    await _recordRekeyMarker(fingerprint);
    _activateNewKeySet(newMK);

    _pendingNewSeed = newSeed;
    _revealConfirmed = false;

    return RekeyResult(
      newSeed: newSeed,
      newSeedFingerprint: fingerprint,
      blocksReencrypted: rebuilt.length,
      remotePushed: false,
      backupPath: backupPath,
    );
  }

  /// Whether a re-key has already been recorded (double-run guard, B3).
  Future<bool> hasRekeyed() {
    return preferences.hasRekeyed();
  }

  /// Produce a PHPSPEC-format snapshot of the currently-stored chain before
  /// any re-key write (R2, B1). Returns a non-empty JSON string.
  Future<String> preflightSnapshot() {
    return backupService.exportToJson();
  }

  /// Snapshot [preflightSnapshot] to a temp recovery file, returning its path
  /// (R2/B1 — the backup recorded under the OLD key set before any mutation).
  Future<String> preflightSnapshotAndWrite() async {
    final snapshot = await preflightSnapshot();
    return _writeSnapshot(snapshot);
  }

  /// Rebuild every block under [oldMK]→[newMK] in memory ([newSeed]/[newPdk]
  /// only feed the genesis re-key), throwing on any decode failure so no write
  /// occurs (B2). Mirrors Python `hard_rotate`'s per-block rewrite loop.
  Future<List<Block>> _buildRebuiltBlocks({
    required String oldMK,
    required String newMK,
    required String newPdk,
    required String newSeed,
  }) async {
    final currentBlocks = await db.blockDao.getAllBlocks();
    final rebuilt = <Block>[];
    for (final block in currentBlocks) {
      rebuilt.add(
        _rekeyBlock(
          block,
          oldMK: oldMK,
          newMK: newMK,
          newPdk: newPdk,
          newSeed: newSeed,
        ),
      );
    }
    return rebuilt;
  }

  /// Atomically swap the chain for [rebuilt] and re-encrypt the seed vault
  /// under the new PDK, all in ONE transaction (B2, R5/R6) — no partial write.
  Future<void> _replaceChainAndVault(
    List<Block> rebuilt, {
    required String newSeed,
    required String newPdk,
  }) async {
    final newSeedPdkEnc = crypto.encrypt(newSeed, newPdk);
    await db.transaction(() async {
      await db.customStatement('DELETE FROM index_entries');
      await db.customStatement('DELETE FROM blocks');
      for (final block in rebuilt) {
        await db.blockDao.insertBlock(block);
      }
    });
    await db.setSeedVault(newSeedPdkEnc);
  }

  /// Rotate the device cookie specifier so sessions under the old MK force a
  /// re-auth / ownership handoff on the next sync (P3).
  Future<void> _rotateDeviceCoordinates() async {
    await preferences.setDeviceCookie(crypto.generateDeviceSpecifier());
  }

  /// Persist the B3/B4 idempotent-guard marker + drift-detect [fingerprint].
  Future<void> _recordRekeyMarker(String fingerprint) async {
    await preferences.recordRekey(fingerprint);
  }

  /// Hand the live [CryptoService] session to the new master key (R10/R11).
  void _activateNewKeySet(String newMK) {
    crypto.clearMasterKey();
    crypto.setMasterKey(newMK);
  }

  /// Compute an HMAC-style fingerprint of [seedB64] for drift detection (B4).
  ///
  /// Deterministic: identical input → identical output; distinct seeds → the
  /// fingerprints differ.
  String seedFingerprint(String seedB64) {
    return crypto.sha256('phpoc:seed-fingerprint:v1:$seedB64');
  }

  /// Step 1 of the two-step new-seed reveal (B5).
  ///
  /// Returns null until a successful re-key has produced a new seed AND the
  /// user has confirmed via [confirmReveal]; only after that gate does the
  /// raw seed become visible.
  Future<String?> revealSecretStep1() async {
    final seed = _pendingNewSeed;
    if (seed == null) return null;
    return _revealConfirmed ? seed : null;
  }

  /// Record a positive confirmation from the user's typed seed check, which
  /// unlocks [revealSecretStep1] to surface the raw [newSeed]. (B5 / S3)
  void confirmReveal() {
    _revealConfirmed = true;
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  /// Re-key a single [block]: re-encrypt its `_enc` fields (and genesis seed)
  /// from the old key set to the new one, preserving plaintext content hashes
  /// (R9), the block id / index / order (M1a/M6), and keeping the seal
  /// verifiable under the NEW MK (R10). Throws if the block cannot be decoded
  /// (B2 abort).
  Block _rekeyBlock(
    Block block, {
    required String oldMK,
    required String newMK,
    required String newPdk,
    required String newSeed,
  }) {
    final Map<String, dynamic> data;
    try {
      data = json.decode(utf8.decode(base64.decode(block.dataEnc)))
          as Map<String, dynamic>;
    } catch (e) {
      throw StateError('Block ${block.blockIndex} cannot be decoded: $e');
    }

    if (block.blockType == BlockType.genesis) {
      return _rekeyGenesis(
        block,
        data,
        newMK: newMK,
        newPdk: newPdk,
        newSeed: newSeed,
      );
    }
    return _rekeySealedBlock(block, data, oldMK: oldMK, newMK: newMK);
  }

  /// Re-key the genesis block: keep the fixture/legacy ``{"seed": ...}``
  /// payload but (a) re-encrypt the seed under the new PDK (R7) and (b) add
  /// the canonical ``block_hash`` + ``identity_seal`` fields sealed under the
  /// new MK so the block verifies via the R10 recanonicalization.
  Block _rekeyGenesis(
    Block block,
    Map<String, dynamic> data, {
    required String newMK,
    required String newPdk,
    required String newSeed,
  }) {
    if (data['seed'] == null) {
      throw StateError('Genesis block ${block.blockIndex} has no seed field');
    }

    // Store the NEW recovery seed, encrypted under the new PDK (R7).
    final newSeedPdkEnc = crypto.encrypt(newSeed, newPdk);

    final base = <String, dynamic>{
      'seed': newSeedPdkEnc,
    };
    final seal = crypto.seal(_canonicalJson(base), newMK);
    final newData = <String, dynamic>{
      ...base,
      'block_hash': seal,
      'identity_seal': seal,
    };
    final dataEncB64 = base64.encode(utf8.encode(json.encode(newData)));
    return Block(
      blockId: block.blockId,
      blockType: block.blockType,
      blockIndex: block.blockIndex,
      keyVersion: block.keyVersion,
      dataEnc: dataEncB64,
      identitySeal: seal,
      prevHash: block.prevHash,
      createdAt: block.createdAt,
    );
  }

  /// Re-key a standard (day/summary) block: re-encrypt every entry `_enc`
  /// field under the new MK and re-seal the block body.
  Block _rekeySealedBlock(
    Block block,
    Map<String, dynamic> data, {
    required String oldMK,
    required String newMK,
  }) {
    final entries = data['entries'];
    if (entries is List) {
      data['entries'] = entries
          .map((e) => _reencryptEntryMap(
                Map<String, dynamic>.from(e as Map),
                oldMK: oldMK,
                newMK: newMK,
              ))
          .toList();
    }

    // Recompute the per-type seal under the new MK over the canonical payload
    // (seal + identity_seal keys excluded), keys sorted.
    final payload = Map<String, dynamic>.from(data)
      ..remove(_sealFieldFor(block))
      ..remove('identity_seal');
    final newSeal = crypto.seal(_canonicalJson(payload), newMK);
    final newIdentitySeal = crypto.sign(newSeal, crypto.getDeviceSecret(newMK));

    data[_sealFieldFor(block)] = newSeal;
    data['identity_seal'] = newIdentitySeal;

    final dataEncB64 = base64.encode(utf8.encode(json.encode(data)));
    return Block(
      blockId: block.blockId,
      blockType: block.blockType,
      blockIndex: block.blockIndex,
      keyVersion: block.keyVersion,
      dataEnc: dataEncB64,
      identitySeal: newIdentitySeal,
      prevHash: block.prevHash,
      createdAt: block.createdAt,
    );
  }

  /// DRY mirror of Python `hard_rotate`'s entry re-encryption: for one entry
  /// map, decrypt every `data` `_enc` field under [oldMK] and re-encrypt it
  /// under [newMK], leaving plaintext fields untouched (so content hashes are
  /// preserved — R9). Returns the mutated entry map.
  Map<String, dynamic> _reencryptEntryMap(
    Map<String, dynamic> entry, {
    required String oldMK,
    required String newMK,
  }) {
    final eData = entry['data'];
    if (eData is Map) {
      final newData = <String, dynamic>{};
      for (final field in eData.entries) {
        final key = field.key;
        final value = field.value;
        if (key.endsWith('_enc') && value is String && value.isNotEmpty) {
          final plain = crypto.decrypt(value, oldMK);
          newData[key] = crypto.encrypt(plain, newMK);
        } else {
          newData[key] = value;
        }
      }
      entry['data'] = newData;
    }
    return entry;
  }

  String _sealFieldFor(Block block) {
    switch (block.blockType) {
      case BlockType.genesis:
        return 'block_hash';
      case BlockType.year:
        return 'year_hash';
      case BlockType.month:
        return 'month_hash';
      case BlockType.day:
        return 'day_hash';
    }
  }

  /// Serialize [data] with TOP-LEVEL map keys sorted alphabetically (nesting
  /// preserved), matching the canonical form the seal/verify paths use. Dart
  /// [Map] preserves insertion order, so building a copy with sorted keys and
  /// `json.encode` produces the required canonical string.
  String _canonicalJson(Map<String, dynamic> data) {
    final sortedKeys = data.keys.toList()..sort();
    final sorted = <String, dynamic>{};
    for (final k in sortedKeys) {
      sorted[k] = data[k];
    }
    return json.encode(sorted);
  }

  /// Persist [snapshot] to a temp recovery file, returning its path.
  Future<String> _writeSnapshot(String snapshot) async {
    final dir = Directory.systemTemp;
    final name = 'phpoc_pre_rekey_${DateTime.now().millisecondsSinceEpoch}.json';
    final file = File('${dir.path}/$name');
    await file.writeAsString(snapshot);
    return file.path;
  }
}
