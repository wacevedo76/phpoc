/// Result of a sync check operation.
enum SyncCheckResult {
  ready,          // Remote synced, proceed
  offline,        // Remote unreachable
  reauthNeeded,   // Device mismatch or expired cookie
  genesisMismatch,// Different genesis — cannot sync
}
