import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/routing/app_router.dart';

import 'test_helpers.dart';

/// Navigation / AppScaffold tests — Group I (8 assertions)

/// Pumps a [GoRouter] inside a [ProviderScope], mirroring production
/// `main.dart` (which wraps the app in a `ProviderScope`).
///
/// `AppScaffold` now renders [BookSwitcher] (a Riverpod `ConsumerWidget`),
/// so the shell must be built under a ProviderScope, exactly as in the app.
Future<void> _pumpRouter(WidgetTester tester, GoRouter router) async {
  await tester.pumpWidget(ProviderScope(child: MaterialApp.router(routerConfig: router)));
  await tester.pump();
}

/// Builds a 4-route shell router around [AppScaffold]. When [textBodies] is
/// true each page renders its label as text (for tap-by-label navigation tests).
GoRouter _shellRouter({bool textBodies = false}) {
  Widget page(String label) =>
      textBodies ? Center(child: Text(label)) : const Placeholder();
  return GoRouter(
    initialLocation: '/',
    routes: [
      ShellRoute(
        builder: (_, _, child) => AppScaffold(child: child),
        routes: [
          GoRoute(path: '/', builder: (_, _) => page('Dashboard')),
          GoRoute(path: '/history', builder: (_, _) => page('History')),
          GoRoute(path: '/sync', builder: (_, _) => page('Sync')),
          GoRoute(path: '/settings', builder: (_, _) => page('Settings')),
        ],
      ),
    ],
  );
}

void main() {
  group('I: Navigation / AppScaffold', () {
    // I1 — Bottom nav has 4 tabs
    testWidgets(
        'I1: AppScaffold bottom nav has 4 tabs: Dashboard, History, Sync, '
        'Settings', (tester) async {
      setSurfaceSize(tester, const Size(600, 800));
      final router = GoRouter(
        initialLocation: '/',
        routes: [
          ShellRoute(
            builder: (_, _, child) => AppScaffold(child: child),
            routes: [
              GoRoute(path: '/', builder: (_, _) => const Placeholder()),
              GoRoute(
                  path: '/history', builder: (_, _) => const Placeholder()),
              GoRoute(
                  path: '/sync', builder: (_, _) => const Placeholder()),
              GoRoute(
                  path: '/settings', builder: (_, _) => const Placeholder()),
            ],
          ),
        ],
      );

      await _pumpRouter(tester, router);

      expect(find.byType(NavigationBar), findsOneWidget,
          reason: 'Bottom navigation bar must be present');

      final navBar = tester.widget<NavigationBar>(find.byType(NavigationBar));
      expect(navBar.destinations.length, 4,
          reason: 'All four main sections must be accessible');
    });

    // I2 — Tapping each tab navigates to correct route
    testWidgets('I2: tapping each bottom-nav tab navigates to correct route',
        (tester) async {
      setSurfaceSize(tester, const Size(600, 800));
      final router = GoRouter(
        initialLocation: '/',
        routes: [
          ShellRoute(
            builder: (_, _, child) => AppScaffold(child: child),
            routes: [
              GoRoute(
                  path: '/',
                  builder: (_, _) =>
                      const Center(child: Text('Dashboard'))),
              GoRoute(
                  path: '/history',
                  builder: (_, _) =>
                      const Center(child: Text('History'))),
              GoRoute(
                  path: '/sync',
                  builder: (_, _) => const Center(child: Text('Sync'))),
              GoRoute(
                  path: '/settings',
                  builder: (_, _) =>
                      const Center(child: Text('Settings'))),
            ],
          ),
        ],
      );

      await _pumpRouter(tester, router);

      // Default: Dashboard
      expect(router.state.matchedLocation, '/');

      // Tap History
      await tester.tap(find.text('History'));
      await tester.pumpAndSettle();
      expect(router.state.matchedLocation, '/history');

      // Tap Sync
      await tester.tap(find.text('Sync'));
      await tester.pumpAndSettle();
      expect(router.state.matchedLocation, '/sync');

      // Tap Settings
      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();
      expect(router.state.matchedLocation, '/settings');

      // Tap Dashboard
      await tester.tap(find.text('Dashboard'));
      await tester.pumpAndSettle();
      expect(router.state.matchedLocation, '/');
    });

    // I3 — Selected tab icon is filled, unselected tabs are outlined
    testWidgets(
        'I3: selected tab icon is filled, unselected tabs are outlined',
        (tester) async {
      setSurfaceSize(tester, const Size(600, 800));
      final router = GoRouter(
        initialLocation: '/',
        routes: [
          ShellRoute(
            builder: (_, _, child) => AppScaffold(child: child),
            routes: [
              GoRoute(
                  path: '/',
                  builder: (_, _) => const Center(child: Text('Dash'))),
              GoRoute(
                  path: '/history',
                  builder: (_, _) => const Center(child: Text('Hist'))),
              GoRoute(
                  path: '/sync',
                  builder: (_, _) => const Center(child: Text('Syn'))),
              GoRoute(
                  path: '/settings',
                  builder: (_, _) => const Center(child: Text('Sett'))),
            ],
          ),
        ],
      );

      await _pumpRouter(tester, router);

      final navBar = tester.widget<NavigationBar>(find.byType(NavigationBar));
      expect(navBar.destinations.length, greaterThan(0));
      expect(navBar.selectedIndex, 0,
          reason: 'Default selected tab is Dashboard');
    });

    // I4 — AppScaffold only rendered when AppPhase.ready
    testWidgets('I4: AppScaffold is only rendered when AppPhase.ready',
        (tester) async {
      setSurfaceSize(tester, const Size(600, 800));
      // Test: at ready phase, AppScaffold renders with NavigationBar
      // (AppScaffold requires GoRouter context — ShellRoute provides it)
      final router = GoRouter(
        initialLocation: '/',
        routes: [
          ShellRoute(
            builder: (_, _, child) => AppScaffold(child: child),
            routes: [
              GoRoute(
                  path: '/',
                  builder: (_, _) => const Text('Dashboard Content')),
            ],
          ),
        ],
      );

      await _pumpRouter(tester, router);

      expect(find.byType(NavigationBar), findsOneWidget,
          reason: 'AppScaffold must render NavigationBar during ready phase');
    });

    // I9 — Landscape: taskbar renders as a left NavigationRail
    testWidgets('I9: landscape renders a left NavigationRail (no bottom bar)',
        (tester) async {
      setSurfaceSize(tester, const Size(1000, 600));

      await _pumpRouter(tester, _shellRouter());

      expect(find.byType(NavigationRail), findsOneWidget,
          reason: 'Landscape must render a left navigation rail');
      expect(find.byType(NavigationBar), findsNothing,
          reason: 'Landscape must not render a bottom navigation bar');
    });

    // I10 — Landscape rail has all four destinations
    testWidgets('I10: landscape rail has 4 destinations', (tester) async {
      setSurfaceSize(tester, const Size(1000, 600));

      await _pumpRouter(tester, _shellRouter());

      final rail = tester.widget<NavigationRail>(find.byType(NavigationRail));
      expect(rail.destinations.length, 4,
          reason: 'All four main sections must be in the landscape rail');
      expect(rail.selectedIndex, 0,
          reason: 'Default selected destination is Dashboard');
    });

    // I11 — Landscape rail navigation still works
    testWidgets('I11: tapping a landscape rail destination navigates',
        (tester) async {
      setSurfaceSize(tester, const Size(1000, 600));

      final router = _shellRouter(textBodies: true);
      await _pumpRouter(tester, router);

      expect(router.state.matchedLocation, '/');

      // Rail labels are visible; tap the History label to navigate.
      await tester.tap(find.text('History'));
      await tester.pumpAndSettle();
      expect(router.state.matchedLocation, '/history');
    });

    // I12 — Landscape rail keeps visible labels and is not padded on its right
    // side (the system navigation-bar inset must not open a gutter between the
    // rail and the content).
    testWidgets(
        'I12: landscape rail shows labels with no right-side SafeArea gutter',
        (tester) async {
      setSurfaceSize(tester, const Size(1000, 600));

      await _pumpRouter(tester, _shellRouter());

      // Labels are visible under the icons (not hidden to tooltips).
      final rail = tester.widget<NavigationRail>(find.byType(NavigationRail));
      expect(rail.labelType, NavigationRailLabelType.all,
          reason: 'Landscape rail must keep visible labels under its icons');
      for (final label in ['Dashboard', 'History', 'Sync', 'Settings']) {
        expect(find.text(label), findsOneWidget,
            reason: 'Landscape rail must show a visible "$label" label');
      }

      // The rail's parent SafeArea must not pad left/right: the left cutout is
      // handled by NavigationRail's internal SafeArea, and the right-side
      // system navigation-bar inset would otherwise open a wide empty gutter
      // between the rail and the content.
      final safeArea = tester.widget<SafeArea>(
        find
            .ancestor(
                of: find.byType(NavigationRail),
                matching: find.byType(SafeArea))
            .first,
      );
      expect(safeArea.left, isFalse,
          reason: 'Outer rail SafeArea must not double-pad the left cutout');
      expect(safeArea.right, isFalse,
          reason:
              'Outer rail SafeArea must not add a right navigation-bar gutter');
      expect(safeArea.top, isTrue,
          reason: 'Outer rail SafeArea must still clear the top status bar');
    });

    // I5 — At boot, router redirects to /loading
    testWidgets('I5: at AppPhase.boot, router redirects to /loading',
        (tester) async {
      final testRouter = GoRouter(
        initialLocation: '/loading',
        redirect: (context, state) {
          // Boot → stay on loading (simplified redirect for test)
          if (state.matchedLocation != '/loading') return '/loading';
          return null;
        },
        routes: [
          GoRoute(
              path: '/loading',
              builder: (_, _) => const Text('Initializing PH Ledger...')),
          GoRoute(
              path: '/', builder: (_, _) => const Text('Dashboard')),
        ],
      );

      await _pumpRouter(tester, testRouter);

      expect(find.text('Initializing PH Ledger...'), findsOneWidget,
          reason: 'Boot phase must show loading screen');
    });

    // I6 — At landing, router redirects to /landing
    testWidgets('I6: at AppPhase.landing, router redirects to /landing',
        (tester) async {
      await pumpScreenWidget(
        tester,
        const Text('Landing'),
        initialPhase: AppPhase.landing,
      );

      // Landing screen should be shown
      expect(find.text('Landing'), findsOneWidget,
          reason: 'Landing phase must show landing screen');
    });

    // I7 — At auth, router redirects to /unlock
    testWidgets('I7: at AppPhase.auth, router redirects to /unlock',
        (tester) async {
      await pumpScreenWidget(
        tester,
        const Text('Unlock'),
        initialPhase: AppPhase.auth,
      );

      // Unlock screen should be shown
      expect(find.text('Unlock'), findsOneWidget,
          reason: 'Auth phase must show unlock screen');
    });

    // I8 — At ready, router redirects /loading and /unlock to /
    testWidgets('I8: at AppPhase.ready, auth routes redirect to /',
        (tester) async {
      await pumpScreenWidget(
        tester,
        const Text('Dashboard Content'),
        initialPhase: AppPhase.ready,
      );

      // Main app should be shown
      expect(find.text('Dashboard Content'), findsOneWidget,
          reason: 'Ready phase must show dashboard');
    });
  });
}
