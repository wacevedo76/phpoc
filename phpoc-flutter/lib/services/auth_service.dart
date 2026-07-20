/// Authentication service — passphrase-based key derivation and session management.
///
/// TODO: Full implementation — currently stub.
class AuthService {
  bool _isUnlocked = false;
  bool get isUnlocked => _isUnlocked;

  /// Derive master key from passphrase + seed via PBKDF2.
  Future<void> unlock(String passphrase, String seedBase64) async {
    // TODO: PBKDF2 via Rust crypto core — 600,000 iterations
    // final seed = base64Decode(seedBase64);
    // final mk = await cryptoService.deriveMasterKey(passphrase, seed);
    _isUnlocked = true;
  }

  /// Clear the master key from memory (lock / logout).
  void lock() {
    // TODO: Zero out master key in memory
    _isUnlocked = false;
  }
}
