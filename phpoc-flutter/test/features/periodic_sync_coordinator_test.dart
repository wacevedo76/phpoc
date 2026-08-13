import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/features/sync/periodic_sync_orchestrator.dart';
import 'package:phpoc_flutter/routing/app_router.dart';

/// Periodic Staging Auto-Sync Timer — Phase 2 (RED), Group W.
///
/// Blueprint: docs/planning/flutter/PERIODIC_AUTO_SYNC_TIMER_PHASE1.md
/// Group W (3 assertions): a pure `PeriodicSyncOrchestrator` (extracted so the
/// phase→sync decision is unit-testable independent of Riverpod/widget plumbing).
/// It watches the app phase and calls `start` exactly once on entering
/// `AppPhase.ready`, `stop` on leaving `ready`, and never errors on a
/// fail-safe (null no-op callbacks) wiring.
///
/// Written against the FUTURE Phase 3 API
/// (`phpoc-flutter/lib/features/sync/periodic_sync_orchestrator.dart`):
/// a class with optional `start` / `stop` callbacks and a
/// `notifyPhase(AppPhase)` method. This file must fail to resolve/run until
/// Phase 3 adds the orchestrator.
void main() {
  group('W: PeriodicSyncOrchestrator phase wiring', () {
    // W1
    test(
        'W1: entering the ready phase invokes start exactly once; a '
        'subsequent ready frame does not double-start', () {
      var startCount = 0;
      var stopCount = 0;
      final o = PeriodicSyncOrchestrator(
        start: () => startCount++,
        stop: () => stopCount++,
      );

      o.notifyPhase(AppPhase.auth);
      expect(startCount, 0, reason: 'No start before ready');

      o.notifyPhase(AppPhase.ready);
      expect(startCount, 1, reason: 'Entering ready starts polling');

      o.notifyPhase(AppPhase.ready);
      expect(startCount, 1,
          reason: 'A subsequent ready frame must not double-start (maps to P8)');
      expect(stopCount, 0, reason: 'Still in ready — no stop yet');
    });

    // W2
    test(
        'W2: leaving the ready phase (e.g. back to auth/reauth) invokes stop',
        () {
      var startCount = 0;
      var stopCount = 0;
      final o = PeriodicSyncOrchestrator(
        start: () => startCount++,
        stop: () => stopCount++,
      );

      o.notifyPhase(AppPhase.ready);
      expect(startCount, 1);

      o.notifyPhase(AppPhase.auth);
      expect(stopCount, 1,
          reason: 'Leaving ready must halt polling (no network while re-authing)');

      // Re-entering ready after leaving restarts cleanly.
      o.notifyPhase(AppPhase.ready);
      expect(startCount, 2);
      expect(stopCount, 1);
    });

    // W3
    test(
        'W3: a null/no-op sync wiring (start/stop swallow absence) does not '
        'error through the coordinator', () {
      // Orchestrator with NO callbacks — fail-safe: absence is swallowed.
      final o = PeriodicSyncOrchestrator();

      // None of these phase transitions may throw, even with no callbacks.
      expect(
        () {
          o.notifyPhase(AppPhase.boot);
          o.notifyPhase(AppPhase.landing);
          o.notifyPhase(AppPhase.onboarding);
          o.notifyPhase(AppPhase.auth);
          o.notifyPhase(AppPhase.ready);
          o.notifyPhase(AppPhase.auth);
          o.notifyPhase(AppPhase.ready);
        },
        returnsNormally,
        reason: 'The coordinator is mounted globally; it must never crash on '
            'a no-transport / absent-sync install',
      );
    });
  });
}
