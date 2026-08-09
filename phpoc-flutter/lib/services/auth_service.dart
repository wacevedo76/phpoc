import 'dart:convert';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:local_auth/local_auth.dart';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/block.dart';
import '../../data/storage/database.dart';
import '../../data/storage/preferences.dart';
import '../../data/storage/secure_preferences.dart';

/// Authentication service — passphrase-based key derivation and session management.
///
/// Owns the master key lifecycle: derivation, caching, and clearing.
/// Consumers (SyncService, screens) read MK through this service, not
/// from CryptoService directly.
///
/// ## MK derivation (MVP)
///
/// MK = HMAC-SHA256(seed, "phpoc:master-key") — deterministic, matches web WASM.
/// The passphrase is validated against the genesis block's encrypted seed.
///
/// ## changePassphrase flow
///
/// new_PDK → re-encrypt genesis seed → new seal with re-derived MK.
class AuthService {
  final CryptoService crypto;
  final AppDatabase db;
  final AppPreferences preferences;
  final SecurePreferences securePreferences;
  final LocalAuthentication _localAuth = LocalAuthentication();

  bool _isUnlocked = false;
  bool get isUnlocked => _isUnlocked;

  AuthService({
    required this.crypto,
    required this.db,
    required this.preferences,
    required this.securePreferences,
  });

  /// Derive master key from passphrase + seed and cache it.
  ///
  /// MK = HMAC-SHA256(seed, "phpoc:master-key") — deterministic, cross-client.
  /// The passphrase is validated against the seed vault (primary) or genesis
  /// block (fallback) if stored seed data exists.
  ///
  /// Throws [AuthException] if passphrase < 8 chars or seed is invalid.
  /// Throws [FormatException] if [seedBase64] is not valid base64 or wrong length.
  Future<void> unlock(String passphrase, String seedBase64) async {
    // 1. Validate passphrase length
    if (passphrase.length < CryptoService.minPassphraseLength) {
      throw AuthException(
          'Passphrase must be at least ${CryptoService.minPassphraseLength} characters');
    }

    // 2. Validate seed format (base64, 32 bytes)
    CryptoService.validateSeedBase64(seedBase64);

    // 3. Derive MK = HMAC-SHA256(seed, "phpoc:master-key")
    final mk = crypto.deriveMasterKey(seedBase64);

    // 4. Verify passphrase against stored seed (vault first, genesis fallback)
    final encryptedSeed = await _readEncryptedSeed();
    if (encryptedSeed != null) {
      final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
      _decryptSeed(pdk, encryptedSeed); // throws AuthException on failure
    }

    // 5. Cache MK in crypto service
    crypto.setMasterKey(mk);
    _isUnlocked = true;
  }

  /// Clear the master key from memory (lock / logout).
  ///
  /// Zeroes the in-memory MK bytes before clearing the reference.
  void lock() {
    crypto.clearMasterKey();
    _isUnlocked = false;
  }

  /// Return the cached master key as a hex string, or null if locked.
  String? getMasterKey() {
    return crypto.getMasterKey();
  }

  /// Export the recovery seed after verifying the passphrase.
  ///
  /// Reads the encrypted seed from the vault (primary) or genesis block
  /// (fallback), derives PDK from [passphrase], decrypts the seed, and
  /// returns it as a base64 string.
  ///
  /// Throws [AuthException] if no seed is found or passphrase is wrong.
  Future<String> exportSeed(String passphrase) async {
    // 1. Validate passphrase length
    if (passphrase.length < CryptoService.minPassphraseLength) {
      throw AuthException(
          'Passphrase must be at least ${CryptoService.minPassphraseLength} characters');
    }

    // 2. Find encrypted seed (vault first, genesis fallback)
    final encryptedSeed = await _readEncryptedSeed();
    if (encryptedSeed == null) {
      throw AuthException('No recovery seed found — cannot export seed');
    }

    // 3. Derive PDK and decrypt seed
    final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
    return _decryptSeed(pdk, encryptedSeed);
  }

  /// Re-derive the master key from the stored seed and [passphrase].
  ///
  /// Used for re-authentication when the MK has been cleared (e.g., app
  /// restart, lock) but the user is already in an authenticated session.
  /// Unlike [unlock], this does not require the seed — it decrypts the
  /// seed from the vault (primary) or genesis block (fallback) using the
  /// passphrase.
  ///
  /// Throws [AuthException] if no seed is found or passphrase is wrong.
  Future<void> reauthenticate(String passphrase) async {
    // 1. Validate passphrase length
    if (passphrase.length < CryptoService.minPassphraseLength) {
      throw AuthException(
          'Passphrase must be at least ${CryptoService.minPassphraseLength} characters');
    }

    // 2. Find encrypted seed (vault first, genesis fallback)
    final encryptedSeed = await _readEncryptedSeed();
    if (encryptedSeed == null) {
      throw AuthException('No recovery seed found — cannot re-authenticate');
    }

    // 3. Derive PDK and decrypt seed
    final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
    final seedB64 = _decryptSeed(pdk, encryptedSeed);

    // 4. Derive MK from seed and cache it
    final mk = crypto.deriveMasterKey(seedB64);
    crypto.setMasterKey(mk);
    _isUnlocked = true;
  }

  /// Change the passphrase, re-encrypting the seed with the new PDK.
  ///
  /// Must be called while unlocked. The seed is read from the vault
  /// (primary) or genesis block (fallback), re-encrypted with the new
  /// passphrase-derived PDK, and stored in the vault. For pre-fix chains
  /// where the seed only exists in genesis, the genesis block is also
  /// updated for backward compatibility.
  ///
  /// Throws [AuthException] if not unlocked, if no seed is found,
  /// if [oldPassphrase] is incorrect, or if [newPassphrase] fails validation.
  Future<void> changePassphrase(
      String oldPassphrase, String newPassphrase) async {
    // 1. Verify unlocked
    if (!_isUnlocked) {
      throw AuthException('Must be unlocked to change passphrase');
    }

    // 2. Validate new passphrase (≥8 chars)
    if (newPassphrase.length < CryptoService.minPassphraseLength) {
      throw AuthException(
          'Passphrase must be at least ${CryptoService.minPassphraseLength} characters');
    }

    // 3. Validate old passphrase + decrypt seed
    final vaultSeed = await db.getSeedVault();
    final encryptedSeed = await _readEncryptedSeed();
    if (encryptedSeed == null) {
      throw AuthException('No recovery seed found — cannot change passphrase');
    }

    final oldPdk = crypto.derivePdk(oldPassphrase, CryptoService.pdkIterations);
    final currentSeedB64 = _decryptSeed(oldPdk, encryptedSeed);

    // 4. Derive new PDK and re-encrypt seed
    final newPdk = crypto.derivePdk(newPassphrase, CryptoService.pdkIterations);
    final newEncryptedSeed = crypto.encrypt(currentSeedB64, newPdk);

    // 5. Store in vault (always — primary seed storage path)
    await db.setSeedVault(newEncryptedSeed);

    // 6. Backward compat: also update genesis data_enc if the seed
    //    was originally stored in genesis (pre-fix chain with no vault).
    if (vaultSeed == null) {
      await _updateGenesisSeedEncIfNeeded(newEncryptedSeed);
    }

    // MK stays the same (seed-derived).
    // isUnlocked stays true.
  }

  // ═══════════════════════════════════════════════════════════════
  // Biometric Authentication
  // ═══════════════════════════════════════════════════════════════

  /// Check if biometric hardware is present and fingerprints/face are enrolled.
  ///
  /// Returns false on emulators, devices without sensors, or devices with
  /// sensors but no enrolled biometrics.
  Future<bool> isBiometricsAvailable() async {
    try {
      final isDeviceSupported = await _localAuth.isDeviceSupported();
      if (!isDeviceSupported) return false;

      final availableBiometrics = await _localAuth.getAvailableBiometrics();
      return availableBiometrics.isNotEmpty;
    } catch (_) {
      return false;
    }
  }

  /// Whether the user has opted into biometric unlock.
  ///
  /// Stored in SharedPreferences (non-sensitive boolean flag).
  bool isBiometricEnabled() {
    return preferences.isBiometricEnabled();
  }

  /// Encrypt the current MK and store the ciphertext for biometric unlock.
  ///
  /// Must be called while unlocked (MK in memory). The MK hex is stored in
  /// flutter_secure_storage. On Android, flutter_secure_storage is backed by
  /// EncryptedSharedPreferences (Keystore-protected).
  ///
  /// Throws [AuthException] if not unlocked.
  Future<void> enrollBiometric() async {
    if (!_isUnlocked) {
      throw AuthException('Must be unlocked to enroll biometric');
    }

    final mk = crypto.getMasterKey();
    if (mk == null) {
      throw AuthException('No master key available for enrollment');
    }

    // Store MK hex in secure storage (already encrypted at rest)
    await securePreferences.setBiometricMk(mk);

    // Persist the opt-in flag
    await preferences.setBiometricEnabled(true);
  }

  /// Trigger biometric prompt and derive MK from stored ciphertext on success.
  ///
  /// Returns true on success (MK now cached in CryptoService). Returns false
  /// if biometrics fail, are unavailable, or the user cancels.
  ///
  /// Does not throw — failures are expected (wrong finger, cancel, cold reboot).
  /// Callers should fall back to passphrase entry on false.
  Future<bool> unlockWithBiometric() async {
    // Gate checks
    if (!isBiometricEnabled()) return false;
    final available = await isBiometricsAvailable();
    if (!available) return false;

    try {
      final authenticated = await _localAuth.authenticate(
        localizedReason: 'Authenticate to unlock PH Ledger',
        options: const AuthenticationOptions(
          stickyAuth: true,
          biometricOnly: true,
        ),
      );

      if (!authenticated) return false;

      // Read stored MK from secure storage
      final mk = await securePreferences.getBiometricMk();
      if (mk == null) return false;

      // Cache MK in crypto service and mark as unlocked
      crypto.setMasterKey(mk);
      _isUnlocked = true;
      return true;
    } catch (_) {
      // Cold reboot, PlatformException, etc. — return false for fallback
      return false;
    }
  }

  /// Remove stored MK ciphertext and clear the biometric opt-in flag.
  ///
  /// Safe to call in any state.
  Future<void> disableBiometric() async {
    await securePreferences.deleteBiometricMk();
    await preferences.setBiometricEnabled(false);
  }

  /// Wipe all local ledger data, staging, credentials, and MK from memory.
  ///
  /// Cloud data (R2) is unaffected. After wipe, the service is locked and
  /// all stores are empty. Safe to call in any state (locked or unlocked).
  /// Idempotent — safe to call multiple times.
  Future<void> wipeLedger() async {
    // Delete all rows from each ledger table (idempotent)
    await db.customStatement('DELETE FROM entries');
    await db.customStatement('DELETE FROM blocks');
    await db.customStatement('DELETE FROM index_entries');

    // Tables that may not exist yet (created lazily by other services)
    await _tryDeleteAllFrom('staging');
    await _tryDeleteAllFrom('_staging_kv');
    await _tryDeleteAllFrom('_phpoc_meta');

    // Clear all SharedPreferences
    await preferences.clearAll();

    // Delete secure storage items (safe if keys don't exist)
    await securePreferences.deleteApiKey();
    await securePreferences.deleteBiometricMk();

    // Clear MK from memory
    crypto.clearMasterKey();
    _isUnlocked = false;
  }

  /// Allow test subclasses to mark the session as unlocked without going
  /// through the full unlock flow (needed because [_isUnlocked] is private).
  @visibleForTesting
  void notifyUnlocked() {
    _isUnlocked = true;
  }

  @visibleForTesting
  void notifyLocked() {
    _isUnlocked = false;
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  /// DELETE all rows from [table], silently succeeding if the table
  /// does not exist (e.g., created lazily by StagingService).
  Future<void> _tryDeleteAllFrom(String table) async {
    try {
      await db.customStatement('DELETE FROM $table');
    } catch (_) {}
  }

  /// Find genesis block in database, or null.
  Future<Block?> _findGenesisBlock() async {
    final blocks = await db.blockDao.getBlocksByType(BlockType.genesis);
    return blocks.isNotEmpty ? blocks.first : null;
  }

  /// Read the PDK-encrypted recovery seed from the vault (primary) or
  /// genesis block (fallback for pre-fix chains created before vault existed).
  ///
  /// Returns null if no seed is found anywhere.
  Future<String?> _readEncryptedSeed() async {
    // Try vault first (post-fix chains)
    final fromVault = await db.getSeedVault();
    if (fromVault != null) return fromVault;

    // Fall back to genesis data_enc (pre-fix chains)
    final genesis = await _findGenesisBlock();
    if (genesis == null) return null;

    try {
      final decoded = utf8.decode(base64.decode(genesis.dataEnc));
      final genesisJson = json.decode(decoded) as Map<String, dynamic>;
      return genesisJson['seed'] as String?;
    } catch (_) {
      return null;
    }
  }

  /// Update the genesis block's data_enc with [encryptedSeed] if the
  /// genesis stores the seed in the legacy ``{"seed": ...}`` format.
  ///
  /// Used by [changePassphrase] for pre-fix chains where the seed only
  /// exists in genesis (no vault).
  Future<void> _updateGenesisSeedEncIfNeeded(String encryptedSeed) async {
    final genesis = await _findGenesisBlock();
    if (genesis == null || !_genesisHasSeedField(genesis)) return;

    final genesisData = json.encode({'seed': encryptedSeed});
    final dataEncB64 = base64.encode(utf8.encode(genesisData));
    final mk = crypto.getMasterKey()!;
    final newSeal = crypto.seal(dataEncB64, mk);

    await db.customStatement(
      'DELETE FROM blocks WHERE block_id = ?',
      [genesis.blockId],
    );
    await db.blockDao.insertBlock(Block(
      blockId: genesis.blockId,
      blockType: BlockType.genesis,
      blockIndex: 0,
      keyVersion: genesis.keyVersion,
      dataEnc: dataEncB64,
      identitySeal: newSeal,
      prevHash: Block.genesisPrevHash,
      createdAt: genesis.createdAt,
    ));
  }

  /// Check whether a genesis block stores the seed in the old JSON format
  /// `` {"seed": "<encrypted_hex>"} `` as opposed to the newer format.
  bool _genesisHasSeedField(Block genesis) {
    try {
      final decoded = utf8.decode(base64.decode(genesis.dataEnc));
      final genesisJson = json.decode(decoded) as Map<String, dynamic>;
      return genesisJson.containsKey('seed');
    } catch (_) {
      return false;
    }
  }

  /// Decrypt an encrypted seed string using PDK.
  ///
  /// Returns the decrypted seed as base64 string. Throws [AuthException] on
  /// failure (wrong passphrase, corrupt data, wrong seed length).
  String _decryptSeed(String pdkHex, String encryptedSeed) {
    try {
      final seedB64 = crypto.decrypt(encryptedSeed, pdkHex);

      // Validate the decrypted seed is 32 bytes
      final seedBytes = base64.decode(seedB64);
      if (seedBytes.length != CryptoService.seedByteLength) {
        throw AuthException('Decrypted seed has wrong length');
      }

      return seedB64;
    } on CryptoException {
      throw AuthException('Wrong passphrase — cannot decrypt recovery seed');
    } on FormatException {
      throw AuthException('Wrong passphrase — seed decryption failed');
    }
  }
}

/// Thrown when authentication fails (wrong passphrase, locked state).
class AuthException implements Exception {
  final String message;
  const AuthException(this.message);
  @override
  String toString() => 'AuthException: $message';
}
