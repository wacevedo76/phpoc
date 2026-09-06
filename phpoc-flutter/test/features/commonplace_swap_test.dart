import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/features/commonplace/commonplace_screen.dart';
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/features/shared/book_switcher.dart';
import 'test_helpers.dart';

/// Phase 2 (RED) — Commonplace content swap in AppScaffold (Group R).
///
/// Implements Group R (6 tests) from
/// docs/planning/flutter/COMMONPLACE_BOOK_UI_PHASE1.md.
///
/// Expected: these tests FAIL (RED) because the Commonplace screen surface
/// (`lib/features/commonplace/commonplace_screen.dart`) and the AppScaffold
/// content-swap by `bookProvider` are not implemented yet (Phase 3).

/// Pumps [AppScaffold] inside a real GoRouter ShellRoute with the given
/// [book] selected, and returns the test [AppPreferences].
Future<AppPreferences> _pumpScaffold(
  WidgetTester tester, {
  required Widget page,
  required Book book,
}) async {
  final prefs = AppPreferences.testInstance();
  await prefs.setBookMode(book.key);
  final router = GoRouter(
    initialLocation: '/',
    routes: [
      ShellRoute(
        builder: (_, _, child) => AppScaffold(child: child),
        routes: [
          GoRoute(path: '/', builder: (_, _) => page),
          GoRoute(path: '/history', builder: (_, _) => const SizedBox()),
          GoRoute(path: '/sync', builder: (_, _) => const SizedBox()),
          GoRoute(path: '/settings', builder: (_, _) => const SizedBox()),
        ],
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        data_providers.appPreferencesProvider.overrideWith((ref) => prefs),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pump();
  return prefs;
}

void main() {
  group('R: Content swap in AppScaffold by book', () {
    testWidgets(
        'CPUI-R1: with Book.ledger active, AppScaffold renders the route child',
        (tester) async {
      await _pumpScaffold(
        tester,
        page: const Center(child: Text('ledger-page-child')),
        book: Book.ledger,
      );
      expect(find.text('ledger-page-child'), findsOneWidget);
    });

    testWidgets(
        'CPUI-R2: with Book.commonplace active, AppScaffold renders the '
        'Commonplace screen instead of the ledger page', (tester) async {
      await _pumpScaffold(
        tester,
        page: const Center(child: Text('ledger-page-child')),
        book: Book.commonplace,
      );
      // The ledger route child is NOT shown; the Commonplace surface is.
      expect(find.text('ledger-page-child'), findsNothing);
      expect(find.byType(CommonplaceScreen), findsOneWidget);
    });

    testWidgets(
        'CPUI-R3: the Book Switcher bar renders above the page in both books',
        (tester) async {
      await _pumpScaffold(
        tester,
        page: const SizedBox(),
        book: Book.ledger,
      );
      expect(find.byType(BookSwitcher), findsOneWidget);

      await _pumpScaffold(
        tester,
        page: const SizedBox(),
        book: Book.commonplace,
      );
      expect(find.byType(BookSwitcher), findsOneWidget);
    });

    testWidgets(
        'CPUI-R4: the bottom nav still shows 4 tabs in the Commonplace book',
        (tester) async {
      setSurfaceSize(tester, const Size(600, 800));
      await _pumpScaffold(
        tester,
        page: const SizedBox(),
        book: Book.commonplace,
      );
      final navBar = tester.widget<NavigationBar>(find.byType(NavigationBar));
      expect(navBar.destinations.length, 4);
    });

    testWidgets(
        'CPUI-R5: switching book from commonplace to ledger restores the page',
        (tester) async {
      final prefs = await _pumpScaffold(
        tester,
        page: const Center(child: Text('ledger-page-child')),
        book: Book.commonplace,
      );
      expect(find.byType(CommonplaceScreen), findsOneWidget);

      // Switch back to ledger via the persisted book mode.
      await prefs.setBookMode(Book.ledger.key);
      await tester.pump();

      expect(find.byType(CommonplaceScreen), findsNothing);
      expect(find.text('ledger-page-child'), findsOneWidget);
    });

    testWidgets(
        'CPUI-R6: the active tab is preserved when switching books',
        (tester) async {
      setSurfaceSize(tester, const Size(600, 800));
      // Start on the History tab (index 1) in the ledger book.
      final prefs = AppPreferences.testInstance();
      await prefs.setBookMode(Book.ledger.key);
      final router = GoRouter(
        initialLocation: '/history',
        routes: [
          ShellRoute(
            builder: (_, _, child) => AppScaffold(child: child),
            routes: [
              GoRoute(path: '/', builder: (_, _) => const SizedBox()),
              GoRoute(
                  path: '/history',
                  builder: (_, _) => const Center(child: Text('history-page'))),
              GoRoute(path: '/sync', builder: (_, _) => const SizedBox()),
              GoRoute(path: '/settings', builder: (_, _) => const SizedBox()),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            data_providers.appPreferencesProvider.overrideWith((ref) => prefs),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pump();

      // Assert we are on the History tab (selected index 1) before switching.
      final navBarBefore =
          tester.widget<NavigationBar>(find.byType(NavigationBar));
      expect(navBarBefore.selectedIndex, 1);

      // Switch book to commonplace; the same route/tab is retained.
      await prefs.setBookMode(Book.commonplace.key);
      await tester.pump();

      final navBarAfter =
          tester.widget<NavigationBar>(find.byType(NavigationBar));
      expect(navBarAfter.selectedIndex, 1);
    });
  });
}
