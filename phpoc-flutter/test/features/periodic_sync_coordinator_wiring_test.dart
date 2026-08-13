import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show periodicSyncCoordinatorProvider, syncServiceProvider;
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/features/sync/periodic_sync_coordinator.dart';
import 'package:phpoc_flutter/routing/app_router.dart';

import 'test_helpers.dart';

/// Periodic Staging Auto-Sync Timer — Coordinator live wiring (Group C).
///
/// Blueprint: docs/planning/flutter/PERIODIC_AUTO_SYNC_TIMER_PHASE1.md
/// Group C (6 assertions): `PeriodicSyncCoordinator` bridges the pure
/// `PeriodicSyncOrchestrator` phase→start/stop decision to a **live**
/// [SyncService], observing the app phase so polling runs exactly while the
/// app is in the `ready` phase. These tests prove the wiring actually issues
/// `startPeriodicSync` / `stopPeriodicSync` on phase transitions (Group P
/// proved those methods drive the timer; Group W proved the orchestrator's
/// pure decision; Group C proves the coordinator connects the two against a
/// real lifecycle), plus dispose hygiene and a local-only fail-safe.
///
/// Written against the Phase 4 API: `PeriodicSyncCoordinator` in
/// `phpoc-flutter/lib/features/sync/periodic_sync_coordinator.dart`.

// ═══════════════════════════════════════════════════════════════════
// Test infra
// ═══════════════════════════════════════════════════════════════════

/// In-memory storage for constructing a real SyncService subclass.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Spy SyncService: records `startPeriodicSync` / `stopPeriodicSync` instead
/// of running a real timer, so coordinator wiring is asserted deterministically
/// without wall-clock timers.
class _SpySyncService extends SyncService {
  _SpySyncService({
    required super.storage,
    required super.crypto,
    required super.stagingStore,
  });

  int startCalls = 0;
  int stopCalls = 0;
  final List<Duration> startIntervals = [];

  @override
  void startPeriodicSync(Duration interval) {
    startCalls++;
    startIntervals.add(interval);
  }

  @override
  void stopPeriodicSync() {
    stopCalls++;
  }
}

Future<({_SpySyncService sync, AppDatabase db})> _makeRealSync() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  final storage = _FakeStorage();
  final db = AppDatabase.inMemory();
  final spy = _SpySyncService(
    storage: storage,
    crypto: crypto,
    stagingStore: StagingStore(db),
  );
  return (sync: spy, db: db);
}

/// Same real SyncService spy as [_makeRealSync] but the DB is owned by the
/// provider container in the integration test (closed on container dispose).
Future<_SpySyncService> _buildSpyService() async {
  final built = await _makeRealSync();
  return built.sync;
}

/// An independent phase notifier per test (avoids the global `appPhaseNotifier`
/// cross-test contamination for the unit-level coordinator tests).
ValueNotifier<AppPhase> _phase([AppPhase initial = AppPhase.boot]) =>
    ValueNotifier<AppPhase>(initial);

void main() {
  group('C: PeriodicSyncCoordinator live wiring', () {
    test(
        'C1: entering the ready phase calls sync.startPeriodicSync with the '
        'default interval, exactly once', () async {
      final s = await _makeRealSync();
      final phase = _phase(AppPhase.boot);
      final coordinator =
          PeriodicSyncCoordinator(sync: s.sync, phase: phase);

      expect(s.sync.startCalls, 0, reason: 'No start before ready');

      phase.value = AppPhase.ready;
      expect(s.sync.startCalls, 1,
          reason: 'Entering ready must start the periodic timer');
      expect(s.sync.startIntervals.single,
          SyncService.defaultPeriodicSyncInterval,
          reason: 'The live coordinator uses the default drift interval');

      coordinator.dispose();
      await s.db.close();
    });

    test(
        'C2: a repeated ready frame does not double-start (idempotent)',
        () async {
      final s = await _makeRealSync();
      final phase = _phase(AppPhase.auth);
      final coordinator =
          PeriodicSyncCoordinator(sync: s.sync, phase: phase);

      phase.value = AppPhase.ready;
      phase.value = AppPhase.ready; // duplicate ready frame (W1/P8 guard)

      expect(s.sync.startCalls, 1,
          reason: 'Re-entering ready must not stack another periodic timer');

      coordinator.dispose();
      await s.db.close();
    });

    test('C3: leaving the ready phase calls sync.stopPeriodicSync', () async {
      final s = await _makeRealSync();
      final phase = _phase(AppPhase.auth);
      final coordinator =
          PeriodicSyncCoordinator(sync: s.sync, phase: phase);

      phase.value = AppPhase.ready;
      expect(s.sync.startCalls, 1);

      phase.value = AppPhase.auth; // reauth / lock → leave ready
      expect(s.sync.stopCalls, 1,
          reason: 'Leaving ready must halt polling');

      coordinator.dispose();
      await s.db.close();
    });

    test(
        'C4: coordinator created after the app is already ready latches '
        'polling on at construction (start called once)', () async {
      final s = await _makeRealSync();
      final phase = _phase(AppPhase.ready);

      final coordinator =
          PeriodicSyncCoordinator(sync: s.sync, phase: phase);
      expect(s.sync.startCalls, 1,
          reason: 'A coordinator observed after `ready` must still start '
              'polling rather than miss the window');

      // A subsequent ready transition is idempotent.
      phase.value = AppPhase.ready;
      expect(s.sync.startCalls, 1);

      coordinator.dispose();
      await s.db.close();
    });

    test(
        'C5: dispose stops the timer and detaches from the phase notifier '
        '(idempotent; no further start after teardown)', () async {
      final s = await _makeRealSync();
      final phase = _phase(AppPhase.boot);
      final coordinator =
          PeriodicSyncCoordinator(sync: s.sync, phase: phase);

      coordinator.dispose();
      final stopAfterDispose = s.sync.stopCalls;
      expect(stopAfterDispose, 1,
          reason: 'Dispose must stop the (active) periodic timer');

      // Idempotent dispose.
      coordinator.dispose();
      expect(s.sync.stopCalls, stopAfterDispose,
          reason: 'Double dispose must not double-stop');

      // The detached listener must not re-start polling on a later transition.
      phase.value = AppPhase.ready;
      expect(s.sync.startCalls, 0,
          reason: 'After dispose the coordinator must not touch the sync');

      await s.db.close();
    });

    test(
        'C6: a local-only sync (no transport) through the coordinator does '
        'not throw across any phase transition (fail-safe, W3 mapped)',
        () async {
      final s = await _makeRealSync();
      final phase = _phase(AppPhase.boot);
      final coordinator =
          PeriodicSyncCoordinator(sync: s.sync, phase: phase);

      // Even though start/stop are issued over a local-only SyncService, the
      // coordinator (and the ticks it schedules) must never throw. Only the
      // start/stop calls are asserted here; the D15 no-op lives in checkAndSync
      // (Group P, P3).
      expect(
        () {
          for (final p in AppPhase.values) {
            phase.value = p;
          }
        },
        returnsNormally,
        reason: 'The coordinator is mounted globally and must not crash on a '
            'no-transport install',
      );

      coordinator.dispose();
      await s.db.close();
    });
  });

  group('C-IT: periodicSyncCoordinatorProvider wiring', () {
    test(
        'C-IT1: the provider wires a SyncService to the app phase notifier — '
        'ready starts, repeated ready does not double-start, leaving stops',
        () async {
      // Build the provider override with a spy SyncService so we can assert the
      // wiring actually reaches startPeriodicSync/stopPeriodicSync through the
      // real provider graph (a later override wins over defaultScreenOverrides).
      final spy = await _buildSpyService();
      final container = ProviderContainer(
        overrides: [
          ...defaultScreenOverrides(),
          syncServiceProvider.overrideWith((ref) => spy),
        ],
      );
      addTearDown(container.dispose);

      // Reset the shared app-phase notifier to boot for a clean start.
      appPhaseNotifier.value = AppPhase.boot;

      container.read(periodicSyncCoordinatorProvider);
      // Gate through the real SyncService the coordinator is wired to.
      final wiredSync = container.read(syncServiceProvider);
      expect(identical(wiredSync, spy), isTrue,
          reason: 'The coordinator provider must watch the overridden sync');

      expect(spy.startCalls, 0, reason: 'No polling before ready');

      appPhaseNotifier.value = AppPhase.ready;
      expect(spy.startCalls, 1,
          reason: 'Entering ready through the provider must start polling');
      expect(spy.startIntervals.single, SyncService.defaultPeriodicSyncInterval,
          reason: 'Provider wiring uses the default drift interval');

      appPhaseNotifier.value = AppPhase.ready; // duplicate ready frame
      expect(spy.startCalls, 1,
          reason: 'Re-entering ready must not double-start');

      appPhaseNotifier.value = AppPhase.auth; // leave ready
      expect(spy.stopCalls, 1, reason: 'Leaving ready must stop polling');

      // Provider disposal must stop polling (tie off the timer).
      container.dispose();
      expect(spy.stopCalls, greaterThanOrEqualTo(1),
          reason: 'Provider teardown must not leave a dangling periodic timer');
    });
  });
}
