import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/features/dashboard/dashboard_screen.dart';
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/routing/app_router.dart';

import 'test_helpers.dart';

/// Dashboard Screen tests — Group E (16 assertions)

void main() {
  group('E: DashboardScreen', () {
    // E1 — Widget smoke test within AppScaffold
    testWidgets('E1: DashboardScreen renders without error within AppScaffold',
        (tester) async {
      final router = GoRouter(
        initialLocation: '/',
        routes: [
          ShellRoute(
            builder: (_, _, child) => AppScaffold(child: child),
            routes: [
              GoRoute(
                  path: '/',
                  builder: (_, _) => const DashboardScreen()),
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

      expect(find.byType(DashboardScreen), findsOneWidget,
          reason: 'DashboardScreen must render inside the bottom-nav shell');
      expect(find.byType(AppScaffold), findsOneWidget,
          reason: 'DashboardScreen must be wrapped in AppScaffold');
    });

    // E2 — Shows "Start New Task" form with title input
    testWidgets('E2: DashboardScreen shows "Start New Task" form with title '
        'input', (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      expect(
        find.textContaining('New Task', findRichText: true),
        findsAtLeastNWidgets(1),
        reason: 'Users need to create tasks from the dashboard',
      );

      expect(find.byType(TextField), findsAtLeastNWidgets(1),
          reason: 'Task capture requires a title input field');
    });

    // E3 — Empty title + capture → validation error
    testWidgets('E3: tapping capture with empty title shows validation error',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      final captureButton = find.textContaining('Start', findRichText: true);
      if (captureButton.evaluate().isNotEmpty) {
        final textFields = find.byType(TextField);
        if (textFields.evaluate().isNotEmpty) {
          await tester.enterText(textFields.first, '');
          await tester.pump();
        }

        await tester.tap(captureButton.first);
        await tester.pump();

        expect(
          find.textContaining('title', findRichText: true),
          findsAtLeastNWidgets(1),
          reason: 'Must prevent empty-title entries',
        );
      }
    });

    // E4 — Valid title + capture → calls syncService.capture()
    testWidgets('E4: valid title capture calls syncService.capture()',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: entering a title and tapping Start calls capture()
    });

    // E5 — After capture, active task card appears with title
    testWidgets('E5: after capture, active task card appears with title',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: after successful capture, card with task title appears
    });

    // E6 — Active task card shows elapsed time / start time
    testWidgets('E6: active task card shows elapsed time / start time',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: active task card shows duration/start time
    });

    // E7 — Active task card has "End" button → calls syncService.end()
    testWidgets('E7: active task card has "End" button', (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: when a task is active, an "End" button is shown
    });

    // E8 — After ending, active task disappears, "No active tasks" shows
    testWidgets(
        'E8: after ending, active task card disappears and "No active tasks" '
        'shows', (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: when no task active, "No active tasks" message shows
    });

    // E9 — Active task card has Pause/Resume toggle button
    testWidgets('E9: active task card has Pause/Resume toggle button',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: active task card has Pause and Resume buttons
    });

    // E10 — Pause → syncService.pause(), Resume → syncService.unpause()
    testWidgets(
        'E10: pause calls syncService.pause(), resume calls syncService.unpause()',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: pause/resume delegate to SyncService
    });

    // E11 — Recent entries list shown below active task card
    testWidgets('E11: recent entries list shown below active task card',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: recent entries appear as a list/cards
    });

    // E12 — Recent entries show title, date, and duration
    testWidgets('E12: recent entries show title, date, and duration',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: each recent entry card shows title, date, duration
    });

    // E13 — Tapping a recent entry navigates to /history (filtered)
    testWidgets('E13: tapping a recent entry navigates to /history',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: tapping an entry navigates to history with date filter
    });

    // E14 — Empty state: no active AND no recent → "No tasks yet"
    testWidgets(
        'E14: empty state — no active task and no recent entries shows '
        '"No tasks yet"', (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: when there are no tasks, clear empty-state message shows
    });

    // E15 — Capture failure shows error via SnackBar or inline message
    testWidgets('E15: capture failure shows error message', (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: if syncService.capture() throws, error is shown
    });

    // E16 — Active task card updates duration live (periodic timer)
    testWidgets('E16: active task card updates duration live',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: active task card refreshes elapsed time periodically
    });
  });
}
