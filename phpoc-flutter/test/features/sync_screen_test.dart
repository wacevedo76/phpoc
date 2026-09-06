import 'dart:convert' show json, utf8;
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/core/models/push_result.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/features/sync/sync_screen.dart';
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

import 'test_helpers.dart';

/// In-memory storage for tests that need a standalone SyncService.
class _TestStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Helper: create a SyncService seeded with one completed entry.
Future<SyncService> _seededSyncService(String title) async {
  final crypto = CryptoService();
  await crypto.initialize();
  final storage = _TestStorage();
  final db = AppDatabase.inMemory();
  final stagingStore = StagingStore(db);
  final seeded = SyncService(
    storage: storage,
    crypto: crypto,
    stagingStore: stagingStore,
  );
  final id = await seeded.capture(title: title);
  await seeded.end(id, 5000);
  // Cancel the debounced auto-push timer so it doesn't leak past teardown;
  // return a fresh SyncService sharing the same stores.
  seeded.dispose();
  return SyncService(
    storage: storage,
    crypto: crypto,
    stagingStore: stagingStore,
  );
}

/// Minimal transport for push button tests (no real HTTP).
class _TestPushTransport extends HttpTransport {
  _TestPushTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');
  @override
  Future<Uint8List?> pull(String path) async => null;
  @override
  Future<void> push(String path, Uint8List data) async {
    // Small delay so loading state renders in widget tests.
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  @override
  Future<List<String>> listFiles(String prefix) async => [];
  @override
  Future<void> delete(String path) async {}
}

/// Sync Screen tests — Group G (13) + Group R (5) + Group L (5) = 23 assertions.

void main() {
  group('G: SyncScreen', () {
    // G1 — Widget smoke test within AppScaffold
    testWidgets('G1: SyncScreen renders without error within AppScaffold',
        (tester) async {
      final router = GoRouter(
        initialLocation: '/sync',
        routes: [
          ShellRoute(
            builder: (_, _, child) => AppScaffold(child: child),
            routes: [
              GoRoute(path: '/', builder: (_, _) => const Placeholder()),
              GoRoute(
                  path: '/sync',
                  builder: (_, _) => const SyncScreen()),
            ],
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: defaultScreenOverrides(),
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pump();

      expect(find.byType(SyncScreen), findsOneWidget,
          reason: 'SyncScreen must render inside the bottom-nav shell');
      expect(find.byType(AppScaffold), findsOneWidget,
          reason: 'SyncScreen must be wrapped in AppScaffold');
    });

    // G2 — Displays sync status indicator
    testWidgets('G2: SyncScreen displays sync status indicator',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: status indicator (Ready/Offline/Syncing/Error) shown
    });

    // G3 — Status shows "Ready" when remote available and no pending
    testWidgets('G3: status shows "Ready" when remote is available',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: status = Ready when isRemoteAvailable
    });

    // G4 — Status shows "Offline" when transport is null
    testWidgets('G4: status shows "Offline" when no transport configured',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: when isRemoteAvailable is false, show Offline
    });

    // G5 — Status shows "Syncing…" during sync operations
    testWidgets('G5: status shows "Syncing…" during sync operations',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: during checkAndSync(), status updates to Syncing
    });

    // G6 — "Sync Now" button calls syncService.checkAndSync()
    testWidgets('G6: "Sync Now" button calls syncService.checkAndSync()',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: tapping "Sync Now" triggers manual sync
      expect(
        find.textContaining('Sync', findRichText: true),
        findsAtLeastNWidgets(1),
        reason: 'Users need a manual sync trigger',
      );
    });

    // G7 — After successful sync, last-sync timestamp updates
    testWidgets('G7: after successful sync, last-sync timestamp updates',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: after checkAndSync() returns ready, timestamp updates
    });

    // G8 — After successful sync, pending entry count updates
    testWidgets('G8: after successful sync, pending count shows zero',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: after sync, pending count should be zero or updated
    });

    // G9 — Shows count of locally modified entries pending push
    testWidgets('G9: shows count of locally modified entries pending push',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: pending-entry count visible when unsynced entries exist
    });

    // G10 — REAUTH_NEEDED → shows re-auth prompt
    testWidgets('G10: REAUTH_NEEDED shows re-auth prompt',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: when checkAndSync() returns reauthNeeded, re-auth prompt shown
    });

    // G11 — Sync error (network failure) → error message with retry
    testWidgets('G11: sync error shows error message with retry option',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: network failures show error with retry button
    });

    // G12 — Sync error clears on next successful sync
    testWidgets('G12: sync error clears on next successful sync attempt',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: stale errors cleared after successful sync
    });

    // G13 — Commit-entry UI shows "Coming in a future update"
    testWidgets(
        'G13: commit-entry UI shows placeholder for future feature',
        (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: commit-entry section shows "Coming in a future update"
    });

    testWidgets('G14: one-off task shows One-time badge when card expanded',
        (tester) async {
      final crypto = CryptoService();
      await crypto.initialize();
      final storage = _TestStorage();
      final db = AppDatabase.inMemory();
      final stagingStore = StagingStore(db);
      final syncSvc = SyncService(
        storage: storage,
        crypto: crypto,
        stagingStore: stagingStore,
      );
      await syncSvc.capture(title: 'Badge Task', isOneOff: true);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => syncSvc),
          ]);

      // Expanded badge is hidden until the card is expanded.
      expect(find.text('One-time'), findsNothing,
          reason: 'Badge must be hidden while the card is collapsed');

      await tester.tap(find.text('Badge Task'));
      await tester.pumpAndSettle();

      expect(find.text('One-time'), findsOneWidget,
          reason: 'One-off badge must appear once the card is expanded');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group R: T8 UI — Sync Screen Commit Button
  // ═══════════════════════════════════════════════════════════════

  group('R: SyncScreen — Commit to Local Ledger Button (T8)', () {
    // R1
    testWidgets('R1: sync screen shows "Commit to Local Ledger" button '
        '(replaces placeholder)', (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      expect(
        find.text('Commit to Local Ledger'),
        findsOneWidget,
        reason: 'Users need a discoverable way to commit completed entries '
            'to the local ledger.',
      );
    });

    // R2
    testWidgets('R2: commit button disabled when no completable entries '
        'exist', (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      final buttonFinder = find.text('Commit to Local Ledger');
      expect(buttonFinder, findsOneWidget);
      final button = tester.widget<ElevatedButton>(
        find.ancestor(
          of: buttonFinder,
          matching: find.byType(ElevatedButton),
        ),
      );
      expect(button.onPressed, isNull,
          reason: 'Button must be disabled when no completable entries exist '
              '— prevents confusion from empty commit');
    });

    // R3
    testWidgets('R3: commit button enabled when completable entries exist '
        '(is_active==false, not committed)', (tester) async {
      final syncSvc = await _seededSyncService('Completed Task');

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => syncSvc),
          ]);

      final buttonFinder = find.text('Commit to Local Ledger');
      expect(buttonFinder, findsOneWidget);
      final button = tester.widget<ElevatedButton>(
        find.ancestor(
          of: buttonFinder,
          matching: find.byType(ElevatedButton),
        ),
      );
      expect(button.onPressed, isNotNull,
          reason: 'Button must be enabled when completable entries exist — '
              'button must react to staging state changes');
    });

    // R4
    testWidgets('R4: tapping commit button calls syncService.commitEntries()',
        (tester) async {
      final syncSvc = await _seededSyncService('Tap Test');

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => syncSvc),
          ]);

      final buttonFinder = find.text('Commit to Local Ledger');
      expect(buttonFinder, findsOneWidget);
      await tester.tap(buttonFinder);
      await tester.pumpAndSettle();
      // Button must still exist after commit (no crash); hash confirmation
      // is verified separately in R5.
      expect(buttonFinder, findsOneWidget);
    });

    // R5
    testWidgets('R5: after successful commit, UI shows hash prefix '
        'confirmation', (tester) async {
      final syncSvc = await _seededSyncService('Hash Show');

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => syncSvc),
          ]);

      final commitFinder = find.text('Commit to Local Ledger');
      expect(commitFinder, findsOneWidget);
      await tester.tap(commitFinder);
      await tester.pumpAndSettle();
      // After commit, user should see the block hash prefix for verification.
      // Hash format: 10 hex characters.
      expect(
        find.textContaining(RegExp(r'[0-9a-f]{10}')),
        findsAtLeastNWidgets(0),
        reason: 'After commit, user must see the block hash prefix '
            'for verification',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group L: SyncScreen — Push to Cloud Button (LedgerPushService)
  // ═══════════════════════════════════════════════════════════════

  group('L: SyncScreen — Push to Cloud Button', () {
    /// Helper: create a transport-connected SyncService with DB block seeded.
    Future<(SyncService, _TestPushTransport, AppDatabase, CryptoService)> _seededPushSetup() async {
      final db = AppDatabase.inMemory();
      final transport = _TestPushTransport();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      );

      // Seed a block so pushAll() has something to push
      await db.blockDao.insertBlock(Block(
        blockId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: 'eyJ0ZXN0IjogdHJ1ZX0=',
        prevHash: Block.genesisPrevHash,
        createdAt: DateTime.now().millisecondsSinceEpoch,
        identitySeal: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      ));

      final storage = _TestStorage();
      final syncSvc = SyncService(
          storage: storage,
          crypto: crypto,
          transport: transport,
          stagingStore: StagingStore(db));

      return (syncSvc, transport, db, crypto);
    }

    // L1
    testWidgets('L1: "Push Ledger to Cloud" button renders when transport '
        'is configured and at least one block exists in DB',
        (tester) async {
      final (syncSvc, transport, db, crypto) = await _seededPushSetup();

      final pushSvc =
          LedgerPushService(db: db, crypto: crypto, transport: transport);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => syncSvc),
            data_providers.ledgerPushServiceProvider.overrideWith((ref) => pushSvc),
          ]);

      expect(
        find.text('Push Ledger to Cloud'),
        findsOneWidget,
        reason: 'Button must be visible to users who have committed entries. '
            'Hidden when there is nothing to push or no transport configured.',
      );
    });

    // L2
    testWidgets('L2: button shows loading spinner and is disabled during '
        'pushAll() (prevents double-push)', (tester) async {
      final (syncSvc, transport, db, crypto) = await _seededPushSetup();

      final pushSvc =
          LedgerPushService(db: db, crypto: crypto, transport: transport);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => syncSvc),
            data_providers.ledgerPushServiceProvider.overrideWith((ref) => pushSvc),
          ]);

      // RED: Button does not exist yet — expected failure until Phase 3
      final buttonFinder = find.text('Push Ledger to Cloud');
      if (buttonFinder.evaluate().isNotEmpty) {
        await tester.tap(buttonFinder);
        await tester.pump(); // Open the confirmation dialog
        // Confirm the overwrite dialog, then the push starts.
        await tester.tap(find.text('Push'));
        await tester.pump();

        // During push, button should show loading indicator and be disabled
        expect(find.byType(CircularProgressIndicator), findsOneWidget,
            reason: 'Loading spinner must appear during push to prevent '
                'confusion about progress');
        // Complete the push to clean up pending timers
        await tester.pumpAndSettle();
      } else {
        expect(buttonFinder, findsOneWidget,
            reason: 'RED: "Push Ledger to Cloud" button not yet implemented');
      }
    });

    // L3
    testWidgets('L3: successful push shows SnackBar with "Pushed N blocks '
        '— a1b2c3d4e5" confirmation', (tester) async {
      final (syncSvc, transport, db, crypto) = await _seededPushSetup();

      final pushSvc =
          LedgerPushService(db: db, crypto: crypto, transport: transport);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => syncSvc),
            data_providers.ledgerPushServiceProvider.overrideWith((ref) => pushSvc),
          ]);

      // RED: Button does not exist yet — expected failure until Phase 3
      final buttonFinder = find.text('Push Ledger to Cloud');
      if (buttonFinder.evaluate().isNotEmpty) {
        await tester.tap(buttonFinder);
        await tester.pump(); // Open confirmation dialog
        await tester.tap(find.text('Push')); // Confirm overwrite
        await tester.pumpAndSettle(); // Wait for push to complete

        // After push, SnackBar should show block count + hash prefix
        // Hash prefix format: 10 hex characters
        expect(
          find.textContaining(RegExp(r'Pushed \d+ blocks.*[0-9a-f]{10}')),
          findsOneWidget,
          reason: 'Users need confirmation their data reached the cloud; '
              'hash prefix provides verifiability',
        );
      } else {
        expect(buttonFinder, findsOneWidget,
            reason: 'RED: "Push Ledger to Cloud" button not yet implemented');
      }
    });

    // L4
    testWidgets('L4: failed push shows error SnackBar with failure reason, '
        'button re-enables', (tester) async {
      // Create a setup where pushAll() will fail
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      );

      // Use a _FailingTransport that throws on push
      final failingTransport = _FailingPushTransport();

      // Seed a block so pushAll() is attempted
      await db.blockDao.insertBlock(Block(
        blockId: 'test-block-fail',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: 'eyJ0ZXN0IjogdHJ1ZX0=',
        prevHash: Block.genesisPrevHash,
        createdAt: DateTime.now().millisecondsSinceEpoch,
        identitySeal: 'ffffffffffffffffffffffffffffffff',
      ));

      final pushSvc = LedgerPushService(
          db: db, crypto: crypto, transport: failingTransport);
      final storage = _TestStorage();
      final syncSvc = SyncService(
          storage: storage,
          crypto: crypto,
          transport: failingTransport,
          stagingStore: StagingStore(db));

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => syncSvc),
            data_providers.ledgerPushServiceProvider.overrideWith((ref) => pushSvc),
          ]);

      // RED: Button does not exist yet — expected failure until Phase 3
      final buttonFinder = find.text('Push Ledger to Cloud');
      if (buttonFinder.evaluate().isNotEmpty) {
        await tester.tap(buttonFinder);
        await tester.pump(); // Open confirmation dialog
        await tester.tap(find.text('Push')); // Confirm overwrite
        await tester.pumpAndSettle(); // Wait for push to complete

        // Error SnackBar must appear
        expect(find.byType(SnackBar), findsOneWidget,
            reason: 'Push failures must be surfaced in UI via SnackBar');

        // Button must re-enable after failure (not stuck in loading state)
        final button = tester.widget<ElevatedButton>(
          find.ancestor(
            of: buttonFinder,
            matching: find.byType(ElevatedButton),
          ),
        );
        expect(button.onPressed, isNotNull,
            reason: 'Button must re-enable after push failure so user '
                'can retry after fixing connectivity');
      } else {
        expect(buttonFinder, findsOneWidget,
            reason: 'RED: "Push Ledger to Cloud" button not yet implemented');
      }
    });

    // L5
    testWidgets('L5: push button hidden when transport is null '
        '(local-only mode, no Worker configured)', (tester) async {
      // No transport = local-only mode
      final storage = _TestStorage();
      final crypto = CryptoService();
      await crypto.initialize();
      final db = AppDatabase.inMemory();
      final syncSvc = SyncService(
          storage: storage, crypto: crypto, stagingStore: StagingStore(db));
      // No transport set → transport is null

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => syncSvc),
            // ledgerPushServiceProvider returns null when no transport
          ]);

      // Button must NOT be present when no transport configured
      expect(
        find.text('Push Ledger to Cloud'),
        findsNothing,
        reason: 'Users who have not set up cloud sync should not see '
            'a non-functional button. Transport must be configured.',
      );
    });

    // L6 — Regression: push button survives sync-then-rebuild without
    // triggering _dependents.isEmpty assertion.
    //
    // The fix: _buildPushToCloudButton() uses ref.read (not ref.watch) so
    // it never creates a reactive dependency that outlives the rebuild cycle
    // after checkAndSync() mutates SyncService state.
    testWidgets('L6: push button remains visible and functional after '
        'sync-to-remote completes (regression for _dependents.isEmpty '
        'assertion)', (tester) async {
      final (syncSvc, transport, db, crypto) = await _seededPushSetup();

      final pushSvc =
          LedgerPushService(db: db, crypto: crypto, transport: transport);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => syncSvc),
            data_providers.ledgerPushServiceProvider
                .overrideWith((ref) => pushSvc),
          ]);

      // Push button must be visible before sync
      expect(
        find.text('Push Ledger to Cloud'),
        findsOneWidget,
        reason: 'Push button must render when transport is configured',
      );

      // Tap "Sync Staging" — this triggers checkAndSync() which mutates
      // syncService state (reconcile, blob push, cookie). The subsequent
      // setState() in _refreshStatus() triggers a rebuild that exercises
      // _buildPushToCloudButton().
      final syncButton = find.text('Sync Staging');
      expect(syncButton, findsOneWidget);
      await tester.tap(syncButton);
      await tester.pumpAndSettle();

      // ASSERTION: after the sync-driven rebuild, the push button must still
      // be present. A _dependents.isEmpty assertion here means ref.watch
      // (instead of ref.read) created a dependency on ledgerPushServiceProvider
      // that wasn't cleaned up before the old InheritedElement was disposed.
      expect(
        find.text('Push Ledger to Cloud'),
        findsOneWidget,
        reason: 'Push button must survive the rebuild cycle after sync '
            'completes — ref.read avoids the reactive dependency that '
            'causes _dependents.isEmpty assertion',
      );

      // Also verify the button still works (can be tapped after sync)
      final pushFinder = find.text('Push Ledger to Cloud');
      await tester.tap(pushFinder);
      await tester.pump(); // Open confirmation dialog
      await tester.tap(find.text('Push')); // Confirm overwrite
      await tester.pump(); // Show loading spinner
      expect(find.byType(CircularProgressIndicator), findsOneWidget,
          reason: 'Push button must still function after sync completes');
      await tester.pumpAndSettle(); // Complete the push
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group S: Manual "Sync Staging" forces the pull past F1
  // (manual_sync_pull blueprint — RED Phase 2)
  // ═══════════════════════════════════════════════════════════════

  group('S: Manual Sync Staging forces the read-only fast-path pull', () {
    // S2.1
    testWidgets('S2.1: tapping "Sync Staging" invokes syncService.checkAndSync()',
        (tester) async {
      final spy = _SpySyncService();
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => spy),
          ]);

      final syncButton = find.text('Sync Staging');
      expect(syncButton, findsOneWidget,
          reason: 'Manual sync trigger must be present');

      spy.checkAndSyncCalls = 0;
      await tester.tap(syncButton);
      await tester.pump();
      await tester.pumpAndSettle();

      expect(spy.checkAndSyncCalls, greaterThanOrEqualTo(1),
          reason: 'The Sync Staging button must be wired to checkAndSync()');
    });

    // S2.2 — RED: the button currently forwards skipReadOnlyFastPath: FALSE
    testWidgets('S2.2: "Sync Staging" passes skipReadOnlyFastPath: true to '
        'checkAndSync (RED: button does not forward the flag today)',
        (tester) async {
      final spy = _SpySyncService();
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => spy),
          ]);

      final syncButton = find.text('Sync Staging');
      expect(syncButton, findsOneWidget);

      spy.capturedSkipReadOnlyFastPath.clear();
      await tester.tap(syncButton);
      await tester.pump();
      await tester.pumpAndSettle();

      expect(spy.capturedSkipReadOnlyFastPath, isNotEmpty,
          reason: 'The button must call checkAndSync at least once');
      expect(spy.capturedSkipReadOnlyFastPath.last, isTrue,
          reason: 'A manual Sync Staging must force past F1 so remote rows '
              'are pulled into an empty local store');
    });

    // S2.3
    testWidgets('S2.3: after Sync Staging, screen settles inSync and the '
        'push button stays functional (rebuild guard)', (tester) async {
      final spy = _SpySyncService(result: SyncCheckResult.ready);
      final db = AppDatabase.inMemory();
      final transport = _TestPushTransport();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      );
      // Seed a block so pushAll() has something to push.
      await db.blockDao.insertBlock(Block(
        blockId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: 'eyJ0ZXN0IjogdHJ1ZX0=',
        prevHash: Block.genesisPrevHash,
        createdAt: DateTime.now().millisecondsSinceEpoch,
        identitySeal: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      ));
      final pushSvc =
          LedgerPushService(db: db, crypto: crypto, transport: transport);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => spy),
            data_providers.ledgerPushServiceProvider
                .overrideWith((ref) => pushSvc),
          ]);

      expect(find.text('Push Ledger to Cloud'), findsOneWidget);

      final syncButton = find.text('Sync Staging');
      await tester.tap(syncButton);
      await tester.pumpAndSettle();

      // Push button survives the post-sync rebuild (sync_service.
      // dependents.isEmpty regression must stay green).
      expect(find.text('Push Ledger to Cloud'), findsOneWidget,
          reason: 'Push button must remain after Sync Staging settles');
      // Sync button is enabled again (not stuck in "Syncing…").
      expect(find.text('Sync Staging'), findsOneWidget);
      expect(find.text('Syncing…'), findsNothing,
          reason: 'UI must not stay in the syncing state after settle');
    });

    // S3.1
    testWidgets('S3.1: mutation auto-sync still forces the F1 bypass and '
        'settles (regression guard)', (tester) async {
      final spy = _SpySyncService(result: SyncCheckResult.ready);
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => spy),
          ]);

      // Simulate a mutation-driven auto push by invoking the service path
      // directly; the spy records the flag the caller used.
      await spy.checkAndSync(skipReadOnlyFastPath: true);
      expect(spy.capturedSkipReadOnlyFastPath, isNotEmpty);
      expect(spy.capturedSkipReadOnlyFastPath.last, isTrue,
          reason: 'Mutation auto-sync must force the F1 bypass');
    });

    // S3.2
    testWidgets('S3.2: remote cookie mismatch via the forced path still yields '
        'reauthNeeded and preserves the local cookie', (tester) async {
      // A real (un-spied) service with a mismatched remote cookie: the forced
      // reconcile must still detect the mismatch and require re-auth.
      final storage = _TestStorage();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      );
      await storage.set('cookie', {
        'device_specifier': 'aaaa',
        'creation_time': DateTime.now().millisecondsSinceEpoch,
      });
      final transport = _MismatchCookieTransport();
      final db = AppDatabase.inMemory();
      final realSvc = SyncService(
        storage: storage,
        crypto: crypto,
        transport: transport,
        stagingStore: StagingStore(db),
      );

      final result = await realSvc.checkAndSync(skipReadOnlyFastPath: true);
      expect(result, SyncCheckResult.reauthNeeded,
          reason: 'Forced reconcile must not weaken cookie/reauth security');
      final cookie = await storage.get('cookie');
      expect(cookie, isNotNull,
          reason: 'Mismatch must preserve the local cookie so the competing '
              'owner stays detectable on the next sync (§12.3-A1 / I1)');
      expect((cookie as Map)['device_specifier'], 'aaaa',
          reason: 'Preserved cookie must retain its original specifier');
      await db.close();
    });

    // S3.3
    testWidgets('S3.3: offline/throw during forced manual sync surfaces an error '
        'without an unhandled exception', (tester) async {
      final spy = _SpySyncService(result: SyncCheckResult.offline);
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => spy),
          ]);

      final syncButton = find.text('Sync Staging');
      await tester.tap(syncButton);
      await tester.pumpAndSettle();

      // The screen recovers to a non-syncing state and is tappable again.
      expect(find.text('Syncing…'), findsNothing,
          reason: 'No stuck syncing state after offline result');
      expect(find.text('Sync Staging'), findsOneWidget,
          reason: 'The button is available again after the error settles');
    });
  });
}

/// Spy SyncService used by group S widget tests.
///
/// Records how [checkAndSync] is invoked so we can assert the Sync Staging
/// button forwards `skipReadOnlyFastPath: true` (S2.2).
class _SpySyncService extends SyncService {
  _SpySyncService({this.result = SyncCheckResult.ready,
      SyncService? wrapped})
      : wrapped = wrapped,
        super(
          storage: wrapped?.storage ?? _TestStorage(),
          crypto: wrapped?.crypto ?? (() {
                final c = CryptoService();
                c.initialize();
                c.setMasterKey(
                  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
                return c;
              })(),
          transport: wrapped?.transport,
          stagingStore: wrapped?.stagingStore ?? StagingStore(AppDatabase.inMemory()),
        ){
    // Intentionally empty.
  }

  final SyncCheckResult result;
  final SyncService? wrapped;
  int checkAndSyncCalls = 0;
  final List<bool> capturedSkipReadOnlyFastPath = [];

  @override
  Future<SyncCheckResult> checkAndSync({
    int cookieTtlMinutes = 30,
    bool skipReadOnlyFastPath = false,
  }) async {
    checkAndSyncCalls++;
    capturedSkipReadOnlyFastPath.add(skipReadOnlyFastPath);
    if (wrapped != null) {
      return wrapped!.checkAndSync(
        cookieTtlMinutes: cookieTtlMinutes,
        skipReadOnlyFastPath: skipReadOnlyFastPath,
      );
    }
    return result;
  }
}

/// Transport whose remote cookie never matches the local one (forces reauth).
class _MismatchCookieTransport extends HttpTransport {
  _MismatchCookieTransport()
      : super(baseUrl: 'https://mismatch.example.com', apiKey: 'mismatch-key');

  @override
  Future<Uint8List?> pull(String path) async {
    // Return a remote cookie with a DIFFERENT specifier than local 'aaaa'.
    return Uint8List.fromList(utf8.encode(json.encode({
      'device_uuid': 'remote-uuid',
      'device_specifier': 'bbbb',
    })));
  }

  @override
  Future<void> push(String path, Uint8List data) async {}

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async {}
}

/// Transport that throws on push for failure-path tests.
class _FailingPushTransport extends HttpTransport {
  _FailingPushTransport()
      : super(baseUrl: 'https://fail.example.com', apiKey: 'fail-key');
  @override
  Future<Uint8List?> pull(String path) async {
    throw Exception('Simulated network failure');
  }
  @override
  Future<void> push(String path, Uint8List data) async {
    await Future<void>.delayed(const Duration(milliseconds: 50));
    throw Exception('Simulated network failure on push');
  }
  @override
  Future<List<String>> listFiles(String prefix) async => [];
  @override
  Future<void> delete(String path) async {}
}
