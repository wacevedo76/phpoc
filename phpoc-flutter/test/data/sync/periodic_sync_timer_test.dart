import 'dart:async';

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_paths.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';

/// Periodic Staging Auto-Sync Timer — Phase 2 (RED), Group P.
///
/// Blueprint: docs/planning/flutter/PERIODIC_AUTO_SYNC_TIMER_PHASE1.md
/// Group P (8 assertions): SyncService gains a time-based drift detector —
/// `startPeriodicSync(interval)` / `stopPeriodicSync()`. Today the app only
/// syncs on a manual tap, a debounced mutation, or unlock/reauth; nothing
/// polls on a timer. These tests pin the timer API, the forced
/// `skipReadOnlyFastPath: true` on every tick, the D15/D14 no-op guards, the
/// single-reconcile (`_isSyncing`) guard, clean stop/dispose, and idempotent
/// start.
///
/// Written against the FUTURE Phase 3 API: `SyncService.startPeriodicSync`,
/// `SyncService.stopPeriodicSync`, and the `isSyncing` single-reconcile guard
/// the periodic tick reads before issuing a reconcile. Every assertion here
/// must fail to compile or fail to pass until Phase 3 adds the timer.

// ═══════════════════════════════════════════════════════════════════
// Test Infrastructure (mirrors manual_sync_pull_test.dart / sync_service_row_level_test.dart)
// ═══════════════════════════════════════════════════════════════════

/// In-memory storage for SyncService's `storage` parameter.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Configurable transport spy: returns specific bytes per path, records all
/// pull paths so we can assert what was requested.
class _ConfigTransport extends HttpTransport {
  final Map<String, Uint8List?> _pullResponses = {};
  final Map<String, int> _pullStatusCodes = {};
  final List<String> pullPaths = [];
  bool _throwOnAll = false;

  _ConfigTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  void setPullResponse(String path, Uint8List? data, {int statusCode = 200}) {
    _pullResponses[path] = data;
    _pullStatusCodes[path] = statusCode;
  }

  void setThrowOnAll(bool value) => _throwOnAll = value;

  @override
  Future<Uint8List?> pull(String path) async {
    pullPaths.add(path);
    if (_throwOnAll) throw Exception('Simulated network failure');
    if (_pullResponses.containsKey(path)) {
      final code = _pullStatusCodes[path] ?? 200;
      if (code == 404) return null;
      return _pullResponses[path];
    }
    return null; // default: no data
  }

  @override
  Future<void> push(String path, Uint8List data) async {}

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async {}
}

/// Transport that blocks the remote staging/blob pull until released, letting
/// a mutation-driven `_doPush` stay in flight so the periodic tick sees
/// `_isSyncing == true` (P5).
class _BlockableTransport extends _ConfigTransport {
  bool _blockBlobPull = false;
  Completer<void>? _blobCompleter;

  void blockBlobPull() => _blockBlobPull = true;

  bool get isBlocked => _blobCompleter != null;

  /// Release a blocked blob pull so the in-flight reconcile can finish.
  void releaseBlobPull() {
    final c = _blobCompleter;
    _blobCompleter = null;
    c?.complete();
  }

  @override
  Future<Uint8List?> pull(String path) async {
    pullPaths.add(path);
    if (path == StagingPaths.remoteRowLevelBlob && _blockBlobPull) {
      final c = Completer<void>();
      _blobCompleter = c;
      await c.future;
      _blockBlobPull = false;
      return null; // no remote data once released
    }
    return super.pull(path);
  }
}

/// Spy SyncService: counts every `checkAndSync` call, records the
/// `skipReadOnlyFastPath` flag and the returned result, then delegates to the
/// real implementation so the D15/D14 guards still behave naturally.
class _SpySyncService extends SyncService {
  _SpySyncService({
    required super.storage,
    required super.crypto,
    required super.stagingStore,
    super.transport,
  });

  int calls = 0;
  final List<bool> flags = [];
  final List<SyncCheckResult> results = [];

  @override
  Future<SyncCheckResult> checkAndSync({
    int cookieTtlMinutes = 30,
    bool skipReadOnlyFastPath = false,
  }) async {
    calls++;
    flags.add(skipReadOnlyFastPath);
    final r = await super.checkAndSync(
      cookieTtlMinutes: cookieTtlMinutes,
      skipReadOnlyFastPath: skipReadOnlyFastPath,
    );
    results.add(r);
    return r;
  }
}

Future<_Harness> _makeHarness({
  HttpTransport? transport,
  bool setMasterKey = true,
}) async {
  final crypto = CryptoService();
  await crypto.initialize();
  if (setMasterKey) {
    crypto.setMasterKey(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
  }
  final storage = _FakeStorage();
  final db = AppDatabase.inMemory();
  final stagingStore = StagingStore(db);
  final svc = _SpySyncService(
    storage: storage,
    crypto: crypto,
    stagingStore: stagingStore,
    transport: transport,
  );
  return _Harness(svc, stagingStore, storage, db, transport);
}

class _Harness {
  final _SpySyncService svc;
  final StagingStore stagingStore;
  final _FakeStorage storage;
  final AppDatabase db;
  final HttpTransport? transport;

  _Harness(this.svc, this.stagingStore, this.storage, this.db, this.transport);

  Future<void> close() async {
    // Stop the timer and give any already-fired fire-and-forget tick a chance
    // to settle so its async work completes before the in-memory DB closes
    // (avoids a periodic tick touching a closed database during teardown).
    svc.stopPeriodicSync();
    await Future<void>.delayed(const Duration(milliseconds: 60));
    svc.dispose();
    await db.close();
  }
}

/// Shared short interval + generous wait so the recurring timer deterministically
/// fires at least once even on a slow machine.
const _interval = Duration(milliseconds: 30);

Future<void> _awaitTicks([int count = 1]) {
  return Future<void>.delayed(_interval * count * 4);
}

void main() {
  group('P: SyncService periodic drift timer', () {
    // P1
    test(
        'P1: startPeriodicSync schedules a recurring timer whose tick invokes '
        'checkAndSync at least once after the interval elapses', () async {
      final h = await _makeHarness(transport: _ConfigTransport());

      expect(h.svc.calls, 0, reason: 'Precondition: no checkAndSync yet');

      h.svc.startPeriodicSync(_interval);
      await _awaitTicks();

      expect(h.svc.calls, greaterThanOrEqualTo(1),
          reason: 'The time-based trigger must reach the reconcile entry — '
              'this is the entire missing capability');

      await h.close();
    });

    // P2
    test(
        'P2: each periodic tick calls checkAndSync with skipReadOnlyFastPath: true',
        () async {
      final h = await _makeHarness(transport: _ConfigTransport());

      h.svc.startPeriodicSync(_interval);
      await _awaitTicks(2);

      expect(h.svc.calls, greaterThanOrEqualTo(2));
      expect(h.svc.flags, isNotEmpty);
      expect(
        h.svc.flags.every((f) => f == true),
        isTrue,
        reason: 'Without the forced flag, F1 short-circuits to ready with no '
            'network, so the timer would be useless for remote drift detection',
      );

      await h.close();
    });

    // P3
    test(
        'P3: startPeriodicSync on a local-only sync (transport == null) does '
        'not throw; the tick is a ready no-op (D15)', () async {
      final h = await _makeHarness(transport: null);

      h.svc.startPeriodicSync(_interval);
      await _awaitTicks();

      expect(h.svc.calls, greaterThanOrEqualTo(1),
          reason: 'The timer must still fire and reach checkAndSync');
      expect(
        h.svc.results.any((r) => r == SyncCheckResult.ready),
        isTrue,
        reason: 'D15 — a local-only ledger must never be disrupted by the '
            'periodic timer; checkAndSync returns ready as a safe no-op',
      );

      await h.close();
    });

    // P4
    test(
        'P4: a periodic tick while pre-auth (hasMasterKey == false) is a '
        'reauthNeeded no-op with no network (D14)', () async {
      final t = _ConfigTransport();
      final h = await _makeHarness(transport: t, setMasterKey: false);

      h.svc.startPeriodicSync(_interval);
      await _awaitTicks();

      expect(
        h.svc.results.any((r) => r == SyncCheckResult.reauthNeeded),
        isTrue,
        reason: 'D14 — never sync without a cached master key',
      );
      expect(t.pullPaths, isEmpty,
          reason: 'The timer must not attempt to push/pull encrypted state '
              'before the key is cached');

      await h.close();
    });

    // P5
    test(
        'P5: when _isSyncing is already true (a mutation _doPush is in '
        'flight), the periodic tick is skipped (single-reconcile)', () async {
      final t = _BlockableTransport();
      t.blockBlobPull();
      final h = await _makeHarness(transport: t);

      // Trigger a mutation; its debounced _doPush starts a reconcile that
      // blocks on the remote blob pull, leaving _isSyncing == true.
      await h.svc.capture(title: 'Running Task');
      await Future<void>.delayed(const Duration(milliseconds: 650));
      expect(h.svc.isSyncing, isTrue,
          reason: 'Precondition: a mutation-driven push is in flight');
      final baseline = h.svc.calls;
      expect(baseline, greaterThanOrEqualTo(1),
          reason: 'The in-flight push issued its own checkAndSync');

      // Periodic ticks fire while the push is in flight — each must be skipped.
      h.svc.startPeriodicSync(_interval);
      await _awaitTicks(3);

      expect(h.svc.calls, baseline,
          reason: 'No overlapping/parallel reconcile — the periodic tick must '
              'never run checkAndSync while a _doPush is active');

      // Release the in-flight push and confirm it settles.
      t.releaseBlobPull();
      await Future<void>.delayed(const Duration(milliseconds: 100));

      await h.close();
    });

    // P6
    test(
        'P6: stopPeriodicSync cancels the timer so no further checkAndSync '
        'calls fire', () async {
      final h = await _makeHarness(transport: _ConfigTransport());

      h.svc.startPeriodicSync(_interval);
      await _awaitTicks();
      expect(h.svc.calls, greaterThanOrEqualTo(1));

      h.svc.stopPeriodicSync();
      final baseline = h.svc.calls;
      await _awaitTicks(3);

      expect(h.svc.calls, baseline,
          reason: 'stopPeriodicSync must halt polling (e.g. app leaves ready)');

      await h.close();
    });

    // P7
    test(
        'P7: dispose cancels the periodic timer (no graceful tick after teardown)',
        () async {
      final h = await _makeHarness(transport: _ConfigTransport());

      h.svc.startPeriodicSync(_interval);
      await _awaitTicks();
      expect(h.svc.calls, greaterThanOrEqualTo(1));

      h.svc.dispose();
      final baseline = h.svc.calls;
      await _awaitTicks(3);

      expect(h.svc.calls, baseline,
          reason: 'No post-dispose network/state access from the timer');

      await h.db.close();
    });

    // P8
    test(
        'P8: calling startPeriodicSync twice (without stop) does not '
        'double-schedule — a single timer remains', () async {
      final h = await _makeHarness(transport: _ConfigTransport());

      h.svc.startPeriodicSync(_interval);
      h.svc.startPeriodicSync(_interval);

      // A single 30ms timer should yield ~8 ticks in 250ms; a double-schedule
      // would yield ~16. Assert far below the double-schedule expected count.
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(h.svc.calls, lessThan(11),
          reason: 'Idempotent start — re-entering ready must not stack timer(s)');

      await h.close();
    });
  });
}
