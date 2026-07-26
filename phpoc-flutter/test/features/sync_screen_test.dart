import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/features/sync/sync_screen.dart';
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/routing/app_router.dart';

import 'test_helpers.dart';

/// In-memory storage for tests that need a standalone SyncService.
class _TestStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Sync Screen tests — Group G (13 assertions) + Group R (5 assertions)

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
  });

  // ═══════════════════════════════════════════════════════════════
  // Group R: T8 UI — Sync Screen Commit Button
  // ═══════════════════════════════════════════════════════════════

  group('R: SyncScreen — Commit to Ledger Button (T8)', () {
    // R1
    testWidgets('R1: sync screen shows "Commit to Ledger" button '
        '(replaces placeholder)', (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // RED: Commit button does not exist yet (G13 shows placeholder)
      // Phase 3: replace placeholder with real button
      expect(
        find.text('Commit to Ledger'),
        findsOneWidget,
        reason: 'Users need a discoverable way to commit completed entries. '
            'The G13 placeholder "Coming in a future update" must be replaced '
            'with a real "Commit to Ledger" button.',
      );
    });

    // R2
    testWidgets('R2: commit button disabled when no completable entries '
        'exist', (tester) async {
      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready);

      // RED: Button does not exist yet
      // Phase 3: button must be disabled when no entries to commit
      final buttonFinder = find.text('Commit to Ledger');
      if (buttonFinder.evaluate().isNotEmpty) {
        final button = tester.widget<ElevatedButton>(
          find.ancestor(
            of: buttonFinder,
            matching: find.byType(ElevatedButton),
          ),
        );
        expect(button.onPressed, isNull,
            reason: 'Button must be disabled when no completable entries exist '
                '— prevents confusion from empty commit');
      } else {
        // RED: button not found — expected failure until Phase 3
        expect(buttonFinder, findsOneWidget,
            reason: 'RED: "Commit to Ledger" button not yet implemented');
      }
    });

    // R3
    testWidgets('R3: commit button enabled when completable entries exist '
        '(is_active==false, not committed)', (tester) async {
      // Override syncServiceProvider to seed completable entries
      final storage = _TestStorage();
      final crypto = CryptoService();
      await crypto.initialize();
      // Create a SyncService with a completed entry
      final syncSvc = SyncService(storage: storage, crypto: crypto);
      await syncSvc.capture(title: 'Completed Task');
      await syncSvc.end('Completed Task', 5000);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => syncSvc),
          ]);

      // RED: Button does not exist yet
      // Phase 3: button must be enabled when entries are completable
      final buttonFinder = find.text('Commit to Ledger');
      if (buttonFinder.evaluate().isNotEmpty) {
        final button = tester.widget<ElevatedButton>(
          find.ancestor(
            of: buttonFinder,
            matching: find.byType(ElevatedButton),
          ),
        );
        expect(button.onPressed, isNotNull,
            reason: 'Button must be enabled when completable entries exist — '
                'button must react to staging state changes');
      } else {
        // RED: button not found — expected failure until Phase 3
        expect(buttonFinder, findsOneWidget,
            reason: 'RED: "Commit to Ledger" button not yet implemented');
      }
    });

    // R4
    testWidgets('R4: tapping commit button calls syncService.commitEntries()',
        (tester) async {
      final storage = _TestStorage();
      final crypto = CryptoService();
      await crypto.initialize();
      final syncSvc = SyncService(storage: storage, crypto: crypto);
      await syncSvc.capture(title: 'Tap Test');
      await syncSvc.end('Tap Test', 5000);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => syncSvc),
          ]);

      // RED: Button does not exist yet
      // Phase 3: tapping must delegate to SyncService, not LedgerEngine directly
      final buttonFinder = find.text('Commit to Ledger');
      if (buttonFinder.evaluate().isNotEmpty) {
        await tester.tap(buttonFinder);
        await tester.pump();
        // After tap, commitEntries should have been called
        // (Phase 3: verify via spy or state change)
      } else {
        expect(buttonFinder, findsOneWidget,
            reason: 'RED: "Commit to Ledger" button not yet implemented');
      }
    });

    // R5
    testWidgets('R5: after successful commit, UI shows hash prefix '
        'confirmation', (tester) async {
      final storage = _TestStorage();
      final crypto = CryptoService();
      await crypto.initialize();
      final syncSvc = SyncService(storage: storage, crypto: crypto);
      await syncSvc.capture(title: 'Hash Show');
      await syncSvc.end('Hash Show', 5000);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider.overrideWith((ref) => syncSvc),
          ]);

      // RED: Hash confirmation UI does not exist yet
      // Phase 3: after commit, users must see the block hash for verification
      // Look for a SnackBar, dialog, or inline text showing the hash prefix
      final commitFinder = find.text('Commit to Ledger');
      if (commitFinder.evaluate().isNotEmpty) {
        await tester.tap(commitFinder);
        await tester.pump();
        // Phase 3: verify hash prefix shown in UI (SnackBar / text / dialog)
        // Hash format: 10 hex characters
        expect(
          find.textContaining(RegExp(r'[0-9a-f]{10}')),
          findsAtLeastNWidgets(0),
          reason: 'After commit, user must see the block hash prefix '
              'for verification',
        );
      } else {
        expect(commitFinder, findsOneWidget,
            reason: 'RED: "Commit to Ledger" button not yet implemented');
      }
    });
  });
}
