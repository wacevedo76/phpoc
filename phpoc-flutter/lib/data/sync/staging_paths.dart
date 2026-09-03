/// Canonical R2 staging paths shared across all clients (CLI, Web, Flutter).
///
/// These match the paths used by the Python CLI (`domain/staging/remote_sync.py`)
/// and web client (`phpoc-web/src/sync/keys.js`).
class StagingPaths {
  StagingPaths._(); // prevent instantiation

  static const String remoteStagingBlob = 'staging/blobs/current.json';

  static const String remoteDeviceCookie = 'staging/blobs/device_cookie.bin';

  static const String remoteStagingHashIndex = 'staging/hash_index.json';

  static const String remoteRowLevelBlob = 'staging/blob';

  // Already correct — regression guard
  static const String remoteLedgerBlocksPrefix = 'ledger/blocks/';

  // Already correct — regression guard
  static const String remoteHashIndex = 'ledger/hash_index.json';

  // ── Commonplace sealed-chain R2 paths (ADR-031 remote-sync slice) ──
  // Genesis at `commonplace/blocks/000000.json`, day blocks follow in chain
  // order. The hash index is plaintext (matches the ledger's hash_index).
  static const String commonplaceBlocksPrefix = 'commonplace/blocks/';

  static const String commonplaceHashIndex = 'commonplace/hash_index.json';
}
