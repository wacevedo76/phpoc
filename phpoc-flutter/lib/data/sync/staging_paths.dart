/// Canonical R2 staging paths shared across all clients (CLI, Web, Flutter).
///
/// These match the paths used by the Python CLI (`domain/staging/remote_sync.py`)
/// and web client (`phpoc-web/src/sync/keys.js`).
class StagingPaths {
  StagingPaths._(); // prevent instantiation

  static const String remoteStagingBlob = 'staging/blobs/current.json';

  static const String remoteDeviceCookie = 'staging/blobs/device_cookie.bin';

  static const String remoteStagingHashIndex = 'staging/hash_index.json';

  // Already correct — regression guard
  static const String remoteLedgerBlocksPrefix = 'ledger/blocks/';

  // Already correct — regression guard
  static const String remoteHashIndex = 'ledger/hash_index.json';
}
