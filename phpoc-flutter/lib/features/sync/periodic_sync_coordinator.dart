import 'package:flutter/foundation.dart';

// ignore_for_file: prefer_initializing_formals — `phase`→`_phase` and
// `sync`→`_sync` assignments intentionally use explicit names: the public
// constructor parameters read better than exposing private `_`-prefixed names
// at the call site.

import '../../data/sync/sync_service.dart';
import '../../routing/app_router.dart';
import 'periodic_sync_orchestrator.dart';

/// Live wiring between the app lifecycle and the periodic staging drift
/// detector.
///
/// Bridges the pure [PeriodicSyncOrchestrator] (phase→start/stop decision)
/// and the [SyncService] periodic timer API, observing the app phase (via the
/// always-in-sync [appPhaseNotifier] `ValueNotifier`) so polling runs exactly
/// while the app is in the `ready` phase:
/// - On entering `ready` it calls `sync.startPeriodicSync(interval)` once.
/// - On leaving `ready` it calls `sync.stopPeriodicSync()`.
/// - On [dispose] it detaches from the phase notifier and stops the timer so
///   no tick can fire after teardown.
///
/// **Fail-safe:** the orchestrator is wired with concrete start/stop callbacks
/// over a real [SyncService]; a local-only sync (no transport) is a benign
/// no-op — `startPeriodicSync` schedules ticks that `checkAndSync` guards
/// (D15 / D14) make harmless, mirroring the pure orchestrator's null-callback
/// swallowing (W3).
class PeriodicSyncCoordinator {
  final SyncService _sync;
  final PeriodicSyncOrchestrator _orchestrator;
  final ValueNotifier<AppPhase> _phase;

  /// Whether the phase listener is still attached / polling alive.
  bool _disposed = false;

  PeriodicSyncCoordinator({
    required SyncService sync,
    required ValueNotifier<AppPhase> phase,
    Duration interval = SyncService.defaultPeriodicSyncInterval,
    PeriodicSyncOrchestrator? orchestrator,
  })  : _sync = sync,
        _phase = phase,
        _orchestrator = orchestrator ??
            PeriodicSyncOrchestrator(
              start: () => sync.startPeriodicSync(interval),
              stop: () => sync.stopPeriodicSync(),
            ) {
    // Attach BEFORE driving the initial phase so the very first observation is
    // the current phase — a coordinator created after the app already reached
    // `ready` must still latch polling on rather than miss it.
    _phase.addListener(_onPhaseChanged);
    _orchestrator.notifyPhase(_phase.value);
  }

  void _onPhaseChanged() {
    if (_disposed) return;
    _orchestrator.notifyPhase(_phase.value);
  }

  /// Detach from the phase notifier and halt polling so no tick can fire after
  /// teardown. Idempotent — safe to call more than once.
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _phase.removeListener(_onPhaseChanged);
    _sync.stopPeriodicSync();
  }
}
