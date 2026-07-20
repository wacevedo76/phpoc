/// Onboarding service — genesis creation, import, and Worker connection.
///
/// TODO: Full implementation — currently stub.
class OnboardingService {
  /// Create a new ledger with a fresh genesis block.
  Future<Map<String, String>> createNewLedger({
    required String passphrase,
    String? username,
    String? email,
  }) async {
    // TODO:
    // 1. Generate random 256-bit seed
    // 2. Derive master key via PBKDF2(passphrase, seed)
    // 3. Build genesis block per PHPSPEC §4.1
    // 4. Store seed (encrypted with MK) in SQLite
    // 5. Return seed for one-time display
    throw UnimplementedError();
  }

  /// Connect to an existing Worker and pull remote ledger.
  Future<void> connectToWorker({
    required String baseUrl,
    required String apiKey,
    required String passphrase,
  }) async {
    // TODO:
    // 1. Pull ledger:blocks from Worker
    // 2. Verify genesis integrity
    // 3. Derive MK from passphrase + genesis seed
    // 4. Store locally
    throw UnimplementedError();
  }

  /// Import a ledger from a local file (backup).
  Future<void> importFromFile(String filePath, String passphrase) async {
    // TODO: Read file → validate format → verify seals → store
    throw UnimplementedError();
  }
}
