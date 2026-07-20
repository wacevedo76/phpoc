/// Genesis compatibility gate — checks if local and remote ledgers share
/// the same genesis block before allowing sync.
///
/// Uses a Tier 1 SHA-256 fast path (1-2 pulls) and falls back to full
/// chain pull if hash indexes don't match.
///
/// Port of web src/sync/genesis_gate.js.
///
/// TODO: Full implementation — currently stub.
class GenesisGate {
  /// Check genesis compatibility. Returns true if compatible.
  Future<bool> check() async {
    // TODO: Pull hash_index.sha256 → compare → fallback to full chain
    return true;
  }
}
