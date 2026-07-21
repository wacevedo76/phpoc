/// Genesis compatibility gate — checks if local and remote ledgers share
/// the same genesis block before allowing sync.
///
/// MVP: Passthrough — the mobile app has no local ledger blocks, so the
/// genesis check always returns null (skip genesis check). Full genesis
/// validation (block pulls, hash comparison, chain merge) comes in Phase 7.
///
/// Port of web src/sync/genesis_gate.js (MVP subset).
class GenesisGate {
  /// Check genesis compatibility.
  ///
  /// MVP: always returns null (passthrough — no local ledger blocks exist).
  Future<dynamic> check() async {
    return null;
  }

  /// Reset the gate to its initial state (clears compatibility cache).
  void reset() {
    // MVP: reset is a no-op — gate always returns null (passthrough)
  }
}
