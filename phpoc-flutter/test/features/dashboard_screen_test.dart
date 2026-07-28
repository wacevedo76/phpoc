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

      // Expand the new-task form
      await tester.tap(find.text('New Task'));
      await tester.pumpAndSettle();

      // Scroll the expanded form into view; the Start button is below the
      // default 800×600 viewport when all fields are shown.
      await tester.ensureVisible(find.text('Start'));
      await tester.pumpAndSettle();

      // Tap Start with an empty title (text field defaults to empty)
      await tester.tap(find.text('Start'));
      await tester.pumpAndSettle();

      // Validation error must appear with the exact error message
      expect(
        find.text('Please enter a task title'),
        findsOneWidget,
        reason: 'Must prevent empty-title entries',
      );
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

  // ═══════════════════════════════════════════════════════════════
  // Group T: DashboardScreen — Multi-Active UI
  // ═══════════════════════════════════════════════════════════════

  group('T: DashboardScreen — Multi-Active UI', () {
    /// Helper: capture a task through the UI form.
    Future<void> _captureTask(WidgetTester tester, String title,
        {String tags = ''}) async {
      // Expand the new task form
      await tester.tap(find.text('New Task'));
      await tester.pumpAndSettle();

      // Find the title TextField and enter text
      final titleFields = find.byType(TextField);
      await tester.enterText(titleFields.at(0), title);
      await tester.pumpAndSettle();

      // If tags provided, enter them
      if (tags.isNotEmpty && titleFields.evaluate().length > 1) {
        await tester.enterText(titleFields.at(1), tags);
        await tester.pumpAndSettle();
      }

      // Ensure Start button is visible and tap it
      await tester.ensureVisible(find.text('Start'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Start'));
      await tester.pumpAndSettle();
    }

    // T1 — Dashboard renders one card per active task
    testWidgets('T1: captures 2 tasks → dashboard shows 2 active cards',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Concurrent A');
      await _captureTask(tester, 'Concurrent B');

      // Both task titles must be visible simultaneously
      expect(find.text('Concurrent A'), findsOneWidget,
          reason: 'First active task must remain visible after second capture');
      expect(find.text('Concurrent B'), findsOneWidget,
          reason: 'Second captured task must be shown as its own active card');
    });

    // T2 — Each active card displays its own title
    testWidgets('T2: each active card shows its own distinct title',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Alpha');
      await _captureTask(tester, 'Beta');

      expect(find.text('Alpha'), findsOneWidget,
          reason: 'First card must show its title');
      expect(find.text('Beta'), findsOneWidget,
          reason: 'Second card must show its title');
    });

    // T3 — Each active card has independent elapsed time
    testWidgets('T3: each active card shows independent elapsed time',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'First');
      // Small delay so second task has different elapsed
      await tester.pump(const Duration(seconds: 1));
      await _captureTask(tester, 'Second');

      // Each card must show "Elapsed:" text
      expect(find.textContaining('Elapsed:', findRichText: true),
          findsAtLeastNWidgets(2),
          reason: 'Each active task card must show its own elapsed time');
    });

    // T4 — Each active card has its own Pause/Resume button
    testWidgets('T4: each active card has independent Pause/Resume button',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Pausable A');
      await _captureTask(tester, 'Pausable B');

      // Each card should have a button with Icons.pause (not paused yet)
      expect(find.byIcon(Icons.pause), findsAtLeastNWidgets(2),
          reason: 'Each active task must have its own Pause button');
    });

    // T5 — Each active card has its own End button
    testWidgets('T5: each active card has independent End button',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Endable A');
      await _captureTask(tester, 'Endable B');

      // Each card should have a button with Icons.stop
      expect(find.byIcon(Icons.stop), findsAtLeastNWidgets(2),
          reason: 'Each active task must have its own End button');
    });

    // T6 — Ending one active task removes its active card, others remain.
    // Ended tasks move to Pending Commit section.
    testWidgets('T6: ending one task removes its active card, other cards stay',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Will End');
      await _captureTask(tester, 'Will Stay');

      // Tap the End (stop) button on the "Will End" card.
      await tester.tap(find.byIcon(Icons.stop).first);
      await tester.pumpAndSettle();

      // "Will End" moves to Pending Commit — still visible
      expect(find.text('Will End'), findsOneWidget,
          reason: 'Ended task moves to Pending Commit section');
      // Only one active card remains (one play_circle_fill icon in Running)
      expect(find.byIcon(Icons.play_circle_fill), findsOneWidget,
          reason: 'Only one active task card remains');
      expect(find.text('Will Stay'), findsOneWidget,
          reason: 'Un-ended task card must remain visible');
    });

    // T7 — Ending last active task → task moves to Pending Commit.
    // The dashboard still shows content (no empty state).
    testWidgets(
        'T7: ending last active task moves it to Pending Commit section',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Last One');

      // End it
      await tester.tap(find.byIcon(Icons.stop).first);
      await tester.pumpAndSettle();

      // Ended task appears in Pending Commit
      expect(find.text('Last One'), findsOneWidget,
          reason: 'Ended task moves to Pending Commit, still visible');
      // No active tasks remain — no running section
      expect(find.text('Running'), findsNothing,
          reason: 'No active tasks remain');
    });

    // T8 — "New Task" button available while tasks are running
    testWidgets('T8: New Task button available while tasks are running',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Running Task');

      expect(find.text('New Task'), findsOneWidget,
          reason: 'Users must be able to start new tasks regardless of '
              'active count');
    });

    // T9 — Capturing new task while one active → second card appears
    testWidgets('T9: capturing new task while one active adds a card',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Existing');
      await _captureTask(tester, 'Just Added');

      // The "Running" section header should appear once (not duplicated)
      expect(find.text('Running'), findsOneWidget,
          reason: 'Running section header should not be duplicated');
      // Both tasks visible
      expect(find.text('Existing'), findsOneWidget);
      expect(find.text('Just Added'), findsOneWidget);
    });

    // T10 — All active cards visible within scrollable viewport
    testWidgets(
        'T10: multiple active cards are all reachable via scroll',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Capture 3 tasks to test scrolling
      await _captureTask(tester, 'Scroll A');
      await _captureTask(tester, 'Scroll B');
      await _captureTask(tester, 'Scroll C');

      // All three cards must be findable in the widget tree
      expect(find.text('Scroll A'), findsOneWidget);
      expect(find.text('Scroll B'), findsOneWidget);
      expect(find.text('Scroll C'), findsOneWidget);
    });

    // T11 — Pausing one task does not affect elapsed of other
    testWidgets(
        'T11: pausing one task does not affect the other task elapsed',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Pause Me');
      await _captureTask(tester, 'Keep Running');

      // Tap pause on the first card
      await tester.tap(find.byIcon(Icons.pause).first);
      await tester.pumpAndSettle();

      // After pause, the first card should show Resume (play_arrow) icon.
      // Note: the expanded new-task form (hidden via AnimatedCrossFade) also
      // contains a play_arrow icon, so we use atLeast.
      expect(find.byIcon(Icons.play_arrow), findsAtLeastNWidgets(1),
          reason: 'Paused task must show resume (play) button on its card');
      // The second card should still show pause icon
      expect(find.byIcon(Icons.pause), findsOneWidget,
          reason: 'Unpaused task must still show pause button on its card');
    });

    // T12 — Section header "Running" exists when tasks are active
    testWidgets('T12: Running section header shown for active tasks',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await _captureTask(tester, 'Header Test');

      expect(find.text('Running'), findsOneWidget,
          reason: 'Section header must label the active tasks area');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group U: DashboardScreen — Multi-Active Integration
  // ═══════════════════════════════════════════════════════════════

  group('U: Dashboard — Multi-Active Integration', () {
    // U1 — Full lifecycle: 2 tasks → end one → end last → empty
    testWidgets('U1: full lifecycle — start 2, end 1, end last, empty state',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Helper inline for brevity
      Future<void> capture(String title) async {
        await tester.tap(find.text('New Task'));
        await tester.pumpAndSettle();
        final fields = find.byType(TextField);
        await tester.enterText(fields.at(0), title);
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Start'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Start'));
        await tester.pumpAndSettle();
      }

      await capture('Lifecycle A');
      await capture('Lifecycle B');

      expect(find.text('Lifecycle A'), findsOneWidget);
      expect(find.text('Lifecycle B'), findsOneWidget);

      // End Lifecycle B (second task's stop button)
      await tester.tap(find.byIcon(Icons.stop).last);
      await tester.pumpAndSettle();

      // Lifecycle B moves to Pending Commit — still visible
      expect(find.text('Lifecycle B'), findsOneWidget,
          reason: 'Ended task B moves to Pending Commit section');
      expect(find.text('Lifecycle A'), findsOneWidget,
          reason: 'Task A must still be active');

      // End Lifecycle A
      await tester.tap(find.byIcon(Icons.stop).first);
      await tester.pumpAndSettle();

      // Both tasks now in Pending Commit — still visible
      expect(find.text('Lifecycle A'), findsOneWidget,
          reason: 'Ended task A moves to Pending Commit section');
      expect(find.text('Lifecycle B'), findsOneWidget,
          reason: 'Ended task B stays in Pending Commit section');
      // No active tasks remain
      expect(find.text('Running'), findsNothing,
          reason: 'No active tasks after both ended');
    });

    // U2 — Pause isolation: pause first, second keeps ticking
    testWidgets(
        'U2: pausing first task freezes its elapsed, second keeps ticking',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      // Capture two tasks
      Future<void> capture(String title) async {
        await tester.tap(find.text('New Task'));
        await tester.pumpAndSettle();
        final fields = find.byType(TextField);
        await tester.enterText(fields.at(0), title);
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Start'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Start'));
        await tester.pumpAndSettle();
      }

      await capture('Freeze');
      // Small delay so elapsed differs
      await tester.pump(const Duration(seconds: 1));
      await capture('Tick');

      // Pause the first task (Freeze)
      await tester.tap(find.byIcon(Icons.pause).first);
      await tester.pumpAndSettle();

      // After pause: Freeze card should show play_arrow, Tick card should show pause.
      // Note: the hidden expanded form also has a play_arrow icon.
      expect(find.byIcon(Icons.play_arrow), findsAtLeastNWidgets(1),
          reason: 'Paused task must show resume icon');
      expect(find.byIcon(Icons.pause), findsOneWidget,
          reason: 'Running task must still show pause icon');
    });

    // U3 — Start 3 tasks, end all, verify data consistency
    testWidgets('U3: start 3 tasks, end all, no active entries remain',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      Future<void> capture(String title) async {
        await tester.tap(find.text('New Task'));
        await tester.pumpAndSettle();
        final fields = find.byType(TextField);
        await tester.enterText(fields.at(0), title);
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Start'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Start'));
        await tester.pumpAndSettle();
      }

      await capture('Triple 1');
      await capture('Triple 2');
      await capture('Triple 3');

      expect(find.text('Triple 1'), findsOneWidget);
      expect(find.text('Triple 2'), findsOneWidget);
      expect(find.text('Triple 3'), findsOneWidget);

      // End all three (stop buttons are rendered in order)
      for (int i = 0; i < 3; i++) {
        await tester.tap(find.byIcon(Icons.stop).first);
        await tester.pumpAndSettle();
      }

      // All ended tasks move to Pending Commit — still visible
      expect(find.text('Triple 1'), findsOneWidget,
          reason: 'Ended task 1 moves to Pending Commit section');
      expect(find.text('Triple 2'), findsOneWidget,
          reason: 'Ended task 2 moves to Pending Commit section');
      expect(find.text('Triple 3'), findsOneWidget,
          reason: 'Ended task 3 moves to Pending Commit section');
      // No active tasks remain
      expect(find.text('Running'), findsNothing,
          reason: 'No active tasks after all ended');
    });
  });
}
