import '../../core/crypto/crypto_service.dart';
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
///
/// RED-PHASE-2 SKELETON — contracts are defined by the Phase 2 tests; the
/// real orchestration is implemented in Phase 3 (GREEN). All public methods
/// currently throw [UnimplementedError].
class RekeyService {
  final AuthService auth;
  final CryptoService crypto;
  final AppDatabase db;
  final AppPreferences preferences;
  final SecurePreferences securePreferences;
  final LedgerBackupService backupService;
  final LedgerPushService? pushService;

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
    throw UnimplementedError('RekeyService.mintNewSeed not implemented yet');
  }

  /// Replace the current seed with [newSeed] and re-key the whole ledger.
  ///
  /// Requires either an unlocked session or a valid [oldPassphrase] that
  /// decrypts the current seed (R1). Must snapshot a recovery backup before
  /// any write (R2, B1), and refuse to double-run once a re-key marker exists
  /// (B3).
  Future<RekeyResult> rekey({
    required String oldPassphrase,
    String? newPassphrase,
    required String newSeed,
  }) {
    throw UnimplementedError('RekeyService.rekey not implemented yet');
  }

  /// Whether a re-key has already been recorded (double-run guard, B3).
  Future<bool> hasRekeyed() {
    throw UnimplementedError('RekeyService.hasRekeyed not implemented yet');
  }

  /// Produce a PHPSPEC-format snapshot of the currently-stored chain before
  /// any re-key write (R2, B1). Returns a non-empty JSON string under the
  /// OLD MK.
  Future<String> preflightSnapshot() {
    throw UnimplementedError('RekeyService.preflightSnapshot not implemented yet');
  }

  /// Compute an HMAC fingerprint of [seedB64] for drift detection (B4).
  String seedFingerprint(String seedB64) {
    throw UnimplementedError('RekeyService.seedFingerprint not implemented yet');
  }

  /// Step 1 of the two-step new-seed reveal (B5).
  ///
  /// Must return null until the user has written a typed confirmation;
  /// only after [confirmReveal] does the raw seed become visible.
  Future<String?> revealSecretStep1() {
    throw UnimplementedError('RekeyService.revealSecretStep1 not implemented yet');
  }
}
