import '../data/sync/sync_service.dart';

/// Coordinates the full sync lifecycle:
/// checkAndSync → commit → verify → push → ledger sync.
///
/// This is the application-layer orchestrator — it does not own
/// domain logic (that's SyncService, LedgerEngine). It coordinates
/// the workflow across multiple services.
///
/// TODO: Full implementation — currently stub.
class SyncOrchestrator {
  final SyncService syncService;

  SyncOrchestrator({required this.syncService});

  /// Run a full sync cycle.
  Future<void> syncAll() async {
    // TODO:
    // 1. checkAndSync() — auth gate + reconcile
    // 2. commit completed entries to ledger
    // 3. verify chain integrity
    // 4. push ledger blocks to remote
  }
}
