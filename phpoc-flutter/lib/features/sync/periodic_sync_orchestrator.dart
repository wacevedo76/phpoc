import 'package:flutter/foundation.dart';
import '../../routing/app_router.dart';

/// Pure phase→sync decision for the periodic staging auto-sync timer.
///
/// Watches the app phase and calls [start] exactly once on entering
/// [AppPhase.ready] and [stop] on leaving `ready` (e.g. back to `auth` on
/// reauth). Kept free of Riverpod/widget plumbing so the phase-gating can be
/// unit-tested with injected callbacks.
///
/// **Fail-safe:** both callbacks are optional — a null/no-op wiring (e.g. a
/// local-only install with no transport) is swallowed and the orchestrator
/// never throws on any phase transition (W3).
class PeriodicSyncOrchestrator {
  static const AppPhase _activePhase = AppPhase.ready;

  /// Invoked once when the app enters the `ready` phase. Fixed wiring — set
  /// via the constructor and never reassigned.
  final VoidCallback? start;

  /// Invoked when the app leaves the `ready` phase. Fixed wiring.
  final VoidCallback? stop;

  bool _alreadyStartedAtReady = false;

  PeriodicSyncOrchestrator({this.start, this.stop});

  /// React to an app-phase transition. Entering `ready` starts polling exactly
  /// once (idempotent — repeated `ready` frames do not restart); leaving
  /// `ready` stops it.
  void notifyPhase(AppPhase phase) {
    if (phase == _activePhase) {
      if (!_alreadyStartedAtReady) {
        _alreadyStartedAtReady = true;
        start?.call();
      }
    } else {
      if (_alreadyStartedAtReady) {
        _alreadyStartedAtReady = false;
        stop?.call();
      }
    }
  }
}
