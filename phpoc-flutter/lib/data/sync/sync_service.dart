import '../../core/models/sync_result.dart';
import '../../core/models/entry.dart';

/// Unified sync gate + local I/O for staging entries.
///
/// Port of domain/staging/service.py and web src/sync/sync.js.
/// This is the single entry point for all staging operations:
/// local CRUD (capture/end/pause/unpause/modify/remove) and
/// remote sync (checkAndSync, pushToRemote).
///
/// TODO: Full implementation — currently stub.
class SyncService {
  /// Check remote sync status without pulling full blob.
  Future<SyncCheckResult> checkAndSync() async {
    // TODO: Fast-path cookie check → pull remote blob → reconcile → push
    return SyncCheckResult.ready;
  }

  /// Push local staging blob to remote transport.
  Future<void> pushToRemote() async {
    // TODO: Serialize entries → obfuscate via CryptoService → push via transport
  }

  /// Get the active (running) task, if any.
  Future<Entry?> getActiveTask() async {
    // TODO: Query local cache for isActive=true
    return null;
  }

  /// Get entries, optionally filtered by date range.
  Future<List<Entry>> getEntries({DateTime? from, DateTime? to}) async {
    // TODO: Query local cache + committed blocks
    return [];
  }

  /// Capture a new task (start tracking).
  Future<Entry> capture({
    required String title,
    List<String> tags = const [],
  }) async {
    // TODO: Create entry with start_epoch=now, isActive=true, commit to local cache
    throw UnimplementedError();
  }

  /// End a running task.
  Future<Entry> end(String entryId) async {
    // TODO: Set endEpoch=now, isActive=false
    throw UnimplementedError();
  }
}
