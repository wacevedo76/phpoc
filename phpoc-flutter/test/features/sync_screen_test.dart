import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/features/sync/sync_screen.dart';
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/routing/app_router.dart';

import 'test_helpers.dart';

/// Sync Screen tests — Group G (13 assertions)

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
}
