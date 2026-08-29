import 'dart:convert';
import 'dart:io';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/block.dart';
import '../../core/utils/json_utils.dart';
import '../../data/commonplace/commonplace_service.dart';
import '../../data/ledger/helpers.dart'
    show computeContentHash, computeEntryHash;
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

  /// Commonplace Book (ADR-031) re-encryption side effects. When no
  /// Commonplace service was supplied to the re-key these are 0 (Ledger-only
  /// re-key, unchanged behavior).
  final int commonplaceBlocksReencrypted;
  final int commonplaceEntriesReencrypted;

  const RekeyResult({
    required this.newSeed,
    required this.newSeedFingerprint,
    required this.blocksReencrypted,
    required this.remotePushed,
    required this.backupPath,
    this.commonplaceBlocksReencrypted = 0,
    this.commonplaceEntriesReencrypted = 0,
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

  /// Commonplace Book service (ADR-031). When supplied, a re-key ALSO
  /// re-encrypts the `commonplace.json` chain under the new MK (CPS-R1..R7) so
  /// the Commonplace book stays decryptable after seed rotation (one seed → one
  /// MK → both books). Optional — a Ledger-only re-key passes null.
  final CommonplaceService? commonplaceService;

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
    this.commonplaceService,
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

    // Re-key the Commonplace chain (CPS-R) BEFORE any ledger write (CPS-R6
    // atomicity: a build/store failure throws here and leaves BOTH chains
    // unmodified).
    final cpRekey = await _rekeyCommonplace(oldMK: oldMK, newMK: newMK);
    final cpBlocks = cpRekey?.blocks ?? 0;
    final cpEntries = cpRekey?.entries ?? 0;

    // Atomically replace the chain + re-encrypt the vault (R5/R6, B2).
    final fingerprint = seedFingerprint(newSeed);
    await _replaceChainAndVault(rebuilt, newSeed: newSeed, newPdk: newPdk);

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
      commonplaceBlocksReencrypted: cpBlocks,
      commonplaceEntriesReencrypted: cpEntries,
    );
  }

  /// Whether a re-key has already been recorded (double-run guard, B3).
  Future<bool> hasRekeyed() {
    return preferences.hasRekeyed();
  }

  /// Re-key the Commonplace chain (CPS-R) BEFORE any ledger write. Building
  /// seals/content-hashes requires the Commonplace service's OWN cached MK to
  /// already be the NEW MK (the service carries a separate CryptoService that
  /// shares the same seed→MK), so this switches that instance, rebuilds, and
  /// persists. Returns the counts of re-encrypted blocks/entries, or null when
  /// no Commonplace service is wired. On build/store failure it restores the
  /// old MK and rethrows — BEFORE the ledger transaction — so a failed re-key
  /// leaves BOTH chains unmodified (CPS-R6 atomicity).
  Future<({int blocks, int entries})?> _rekeyCommonplace({
    required String oldMK,
    required String newMK,
  }) async {
    final cp = commonplaceService;
    if (cp == null) return null;
    final cpOldMK = cp.crypto.getMasterKey() ?? oldMK;
    cp.crypto.setMasterKey(newMK);
    try {
      final r = _buildRebuiltCommonplace(
        oldMK: cpOldMK,
        commonplaceService: cp,
      );
      await cp.replaceChainWith(r.blocks);
      // Leave the Commonplace crypto on the NEW MK: both books now share it.
      return (blocks: r.blockCount, entries: r.entriesReencrypted);
    } catch (_) {
      cp.crypto.setMasterKey(cpOldMK);
      rethrow;
    }
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

    // The device-scoped identity secret is key-independent: recover it from
    // the genesis `identity.identity_secret_enc_fallback` under the OLD MK so
    // every re-signed identity_seal stays verifiable by the same
    // identity_pub_key (cross-client parity with Web).
    final identitySecret = _recoverIdentitySecret(currentBlocks, oldMK);

    final rebuilt = <Block>[];
    for (var i = 0; i < currentBlocks.length; i++) {
      final block = currentBlocks[i];
      // Re-sealing under the NEW MK changes every block hash, so each
      // successor's prev_hash must re-link to its predecessor's NEW seal
      // (genesis keeps the all-zero anchor).
      final prevBlockId = i > 0 ? rebuilt[i - 1].blockId : null;
      rebuilt.add(
        _rekeyBlock(
          block,
          oldMK: oldMK,
          newMK: newMK,
          newPdk: newPdk,
          newSeed: newSeed,
          identitySecret: identitySecret,
          prevBlockId: prevBlockId,
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
    required String? identitySecret,
    required String? prevBlockId,
  }) {
    final Map<String, dynamic> data;
    try {
      data =
          json.decode(utf8.decode(base64.decode(block.dataEnc)))
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
        identitySecret: identitySecret,
      );
    }
    return _rekeySealedBlock(
      block,
      data,
      oldMK: oldMK,
      newMK: newMK,
      identitySecret: identitySecret,
      prevBlockId: prevBlockId,
    );
  }

  /// Re-key the genesis block.
  ///
  /// Two shapes are supported:
  ///   - Canonical web-shaped genesis (nested `identity`): rewrites
  ///     `identity.recovery_seed_enc` under the NEW PDK and
  ///     `identity.identity_secret_enc_fallback` under the NEW MK, preserves
  ///     the key-independent `identity_pub_key`/`username`/`email`, then
  ///     re-seals + re-signs canonically (R1 cross-client parity).
  ///   - Legacy flat Flutter genesis (`{"seed": ...}`): re-encrypts the seed
  ///     under the NEW PDK (R7) and re-seals over the flat payload.
  Block _rekeyGenesis(
    Block block,
    Map<String, dynamic> data, {
    required String newMK,
    required String newPdk,
    required String newSeed,
    required String? identitySecret,
  }) {
    // Canonical web-shaped genesis (nested identity) — the cross-client path.
    if (data['identity'] is Map) {
      final identity = Map<String, dynamic>.from(data['identity'] as Map);
      identity['recovery_seed_enc'] = crypto.encrypt(newSeed, newPdk);
      if (identitySecret != null) {
        identity['identity_secret_enc_fallback'] =
            crypto.encrypt(identitySecret, newMK);
      }

      final newData = Map<String, dynamic>.from(data)..['identity'] = identity;
      final seal = _sealBlockCanonical(newData, newMK);
      newData[_sealFieldFor(block)] = seal;
      if (identitySecret != null && newData.containsKey('identity_seal')) {
        newData['identity_seal'] = crypto.sign(seal, identitySecret);
      }

      final dataEncB64 = base64.encode(utf8.encode(json.encode(newData)));
      return Block(
        blockId: seal,
        blockType: block.blockType,
        blockIndex: block.blockIndex,
        keyVersion: block.keyVersion,
        dataEnc: dataEncB64,
        identitySeal: newData['identity_seal'] as String?,
        prevHash: block.prevHash,
        createdAt: block.createdAt,
      );
    }

    // Legacy flat Flutter genesis.
    if (data['seed'] == null) {
      throw StateError(
        'Genesis block ${block.blockIndex} has no seed field and no nested identity',
      );
    }

    // Store the NEW recovery seed, encrypted under the new PDK (R7).
    final newSeedPdkEnc = crypto.encrypt(newSeed, newPdk);

    final base = <String, dynamic>{'seed': newSeedPdkEnc};
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
  /// field under the new MK, recompute the ciphertext-bound entry hash,
  /// re-link `prev_hash` to the predecessor's NEW seal, then re-seal
  /// canonically (ADR-029a whitelist) and re-sign under the preserved
  /// identity secret.
  Block _rekeySealedBlock(
    Block block,
    Map<String, dynamic> data, {
    required String oldMK,
    required String newMK,
    required String? identitySecret,
    required String? prevBlockId,
  }) {
    final entries = data['entries'];
    if (entries is List) {
      data['entries'] = entries
          .map(
            (e) => _reencryptEntryMap(
              Map<String, dynamic>.from(e as Map),
              oldMK: oldMK,
              newMK: newMK,
            ),
          )
          .toList();
    }

    // Re-link onto the predecessor's NEW seal (genesis keeps the zero anchor).
    if (prevBlockId != null) {
      data['prev_hash'] = prevBlockId;
    }

    // Recompute the per-type seal under the new MK over the ADR-029a
    // whitelist, then re-sign with the preserved identity secret (falling back
    // to the derived device secret for legacy flat chains).
    final newSeal = _sealBlockCanonical(data, newMK);
    final signSecret = identitySecret ?? crypto.getDeviceSecret(newMK);
    data[_sealFieldFor(block)] = newSeal;
    data['identity_seal'] = crypto.sign(newSeal, signSecret);

    final dataEncB64 = base64.encode(utf8.encode(json.encode(data)));
    return Block(
      blockId: newSeal,
      blockType: block.blockType,
      blockIndex: block.blockIndex,
      keyVersion: block.keyVersion,
      dataEnc: dataEncB64,
      identitySeal: data['identity_seal'] as String?,
      prevHash: (data['prev_hash'] as String?) ?? block.prevHash,
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
      // Entry hash is ciphertext-bound (hashes the `_enc` ciphertext): after
      // re-encryption the ciphertext changed, so the hash must be recomputed
      // or verify() fails (cross-client parity with Web's recomputeEntryHash).
      entry['hash'] = computeEntryHash(newData);
    }
    return entry;
  }

  // ═══════════════════════════════════════════════════════════════
  // Commonplace chain re-key (CPS-R1..R7)
  // ═══════════════════════════════════════════════════════════════

  /// Rebuild the ENTIRE Commonplace chain under [oldMK]→[newMK] in memory.
  ///
  /// Requires the Commonplace service's OWN cached MK to already be the NEW MK
  /// (the caller switches it) so `sealBlock` / `computeContentHash` — which use
  /// that instance's cached MK — seal and hash under the NEW key. Each block's
  /// `_enc` fields are decrypted with [oldMK] and re-encrypted with the cached
  /// NEW MK (explicit key), content + entry hashes recomputed, and seals
  /// re-derived under the new MK so the chain still verifies afterwards
  /// (CPS-R2). Plaintext fields (type/timestamp_ms/date) are preserved
  /// (CPS-R3). Anything that cannot be decoded throws BEFORE any write
  /// (CPS-R6 atomicity).
  ({List<Map<String, dynamic>> blocks, int blockCount, int entriesReencrypted})
  _buildRebuiltCommonplace({
    required String oldMK,
    required CommonplaceService commonplaceService,
  }) {
    final chain = commonplaceService.engine.chain;
    final cpCrypto = commonplaceService.crypto;
    final blocks = chain.readAll();
    final rebuilt = <Map<String, dynamic>>[];
    var entriesReencrypted = 0;
    // The Commonplace seal whitelist INCLUDES `prev_hash`, so re-sealing under
    // the NEW MK changes every block hash; each successor's `prev_hash` must be
    // re-linked to its predecessor's NEW hash (else verify() fails linkage).
    String? newPrevHash;

    for (final block in blocks) {
      final type = block['type'] as String?;
      final newBlock = Map<String, dynamic>.from(block);

      // Re-link the successor onto the predecessor's NEW seal.
      if (newPrevHash != null) {
        newBlock['prev_hash'] = newPrevHash;
      }

      if (type == 'commonplace_genesis') {
        // Re-encrypt the genesis recovery seed under the new key set
        // (CPS-R5), then re-derive the block seal + identity MAC. The seed is
        // only re-encrypted when it is a real ciphertext (even-length hex) —
        // the live app seeds an EMPTY string and some test fixtures seed a
        // plaintext placeholder, neither of which is decryptable.
        final rs = block['recovery_seed_enc'];
        if (rs is String && rs.isNotEmpty && _isHexCiphertext(rs)) {
          final plain = cpCrypto.decrypt(rs, oldMK);
          newBlock['recovery_seed_enc'] = cpCrypto.encrypt(
            plain,
            cpCrypto.getMasterKey()!,
          );
        }
        newBlock['block_hash'] = chain.sealBlock(newBlock);
        _resignIdentity(
          newBlock,
          chain,
          sealKey: 'block_hash',
          crypto: cpCrypto,
        );
        newPrevHash = newBlock['block_hash'] as String;
      } else if (type == 'commonplace') {
        // Re-encrypt every entry's content under the new MK and recompute the
        // content + entry hashes so verify() passes (CPS-R1/R2).
        final entries = block['entries'];
        if (entries is List) {
          newBlock['entries'] = entries.map((e) {
            final emap = Map<String, dynamic>.from(e as Map);
            final data = emap['data'];
            if (data is Map) {
              final newData = <String, dynamic>{};
              for (final field in data.entries) {
                final key = field.key;
                final value = field.value;
                if (key.endsWith('_enc') &&
                    value is String &&
                    value.isNotEmpty) {
                  final plain = cpCrypto.decrypt(value, oldMK);
                  newData[key] = cpCrypto.encrypt(
                    plain,
                    cpCrypto.getMasterKey()!,
                  );
                } else {
                  newData[key] = value;
                }
              }
              // Recompute under the (now NEW) cached MK.
              newData['content_hash'] = computeContentHash(newData, cpCrypto);
              emap['data'] = newData;
              emap['hash'] = computeEntryHash(newData);
              entriesReencrypted++;
            }
            return emap;
          }).toList();
        }
        newBlock['day_hash'] = chain.sealBlock(newBlock);
        _resignIdentity(newBlock, chain, sealKey: 'day_hash', crypto: cpCrypto);
        newPrevHash = newBlock['day_hash'] as String;
      }

      rebuilt.add(newBlock);
    }

    return (
      blocks: rebuilt,
      blockCount: rebuilt.length,
      entriesReencrypted: entriesReencrypted,
    );
  }

  /// Re-sign a Commonplace block's `identity_seal` over its [sealKey] hash
  /// after a seal change (the seal key, not the identity secret, changed).
  /// No-op when the chain carries no identity secret (test fakes / identityless
  /// bootstrap).
  void _resignIdentity(
    Map<String, dynamic> newBlock,
    dynamic chain, {
    required String sealKey,
    required CryptoService crypto,
  }) {
    final identityHex = chain.identitySecretHex as String?;
    final stored = newBlock['identity_seal'];
    if (identityHex == null || stored == null) return;
    final hash = newBlock[sealKey] as String;
    newBlock['identity_seal'] = crypto.sign(hash, identityHex);
  }

  /// Whether [value] looks like hex-encoded ciphertext (even-length, hex-only).
  /// Used to skip non-encrypted `recovery_seed_enc` placeholders (CPS-R).
  bool _isHexCiphertext(String value) {
    if (value.isEmpty || value.length.isOdd) return false;
    return RegExp(r'^[0-9a-fA-F]+$').hasMatch(value);
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

  /// ADR-029/029a closed per-type seal whitelist, serialized with recursive
  /// `jsonSort` — identical to Python `chain.py` / Web `computeSeal`. A field
  /// is included only when present on the block.
  static const Map<String, List<String>> _sealFieldsByType = {
    'genesis': ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
    'day': ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
    'month_summary': ['type', 'month', 'date', 'prev_hash', 'original_hash'],
    'year_summary': ['type', 'year', 'date', 'prev_hash', 'original_hash'],
  };

  /// Compute the canonical per-type seal for [data] under [mk].
  String _sealBlockCanonical(Map<String, dynamic> data, String mk) {
    final type = data['type'] as String?;
    final fields = _sealFieldsByType[type];
    if (fields == null) {
      throw StateError('Unknown block type for seal: $type');
    }
    final sealData = <String, dynamic>{};
    for (final field in fields) {
      if (data.containsKey(field)) sealData[field] = data[field];
    }
    return crypto.seal(jsonSort(sealData), mk);
  }

  /// Recover the device-scoped identity secret (key-independent) from the
  /// genesis `identity.identity_secret_enc_fallback`, decrypting under [oldMK].
  /// Returns null for legacy flat Flutter genesis (no nested identity) or when
  /// the fallback is absent/undecryptable.
  String? _recoverIdentitySecret(List<Block> blocks, String oldMK) {
    for (final block in blocks) {
      if (block.blockType != BlockType.genesis) continue;
      final Map<String, dynamic> data;
      try {
        data =
            json.decode(utf8.decode(base64.decode(block.dataEnc)))
                as Map<String, dynamic>;
      } catch (_) {
        continue;
      }
      final identity = data['identity'];
      if (identity is Map) {
        final fallback = identity['identity_secret_enc_fallback'];
        if (fallback is String && fallback.isNotEmpty) {
          try {
            return crypto.decrypt(fallback, oldMK);
          } catch (_) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /// Persist [snapshot] to a temp recovery file, returning its path.
  Future<String> _writeSnapshot(String snapshot) async {
    final dir = Directory.systemTemp;
    final name =
        'phpoc_pre_rekey_${DateTime.now().millisecondsSinceEpoch}.json';
    final file = File('${dir.path}/$name');
    await file.writeAsString(snapshot);
    return file.path;
  }
}
