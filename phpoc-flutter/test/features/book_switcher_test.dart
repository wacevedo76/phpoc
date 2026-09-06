import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/features/shared/book_switcher.dart';
import 'test_helpers.dart';

// ═══════════════════════════════════════════════════════════════
// Commonplace Book Switcher — Phase 1 blueprint assertions (13 tests)
// ═══════════════════════════════════════════════════════════════

/// Pumps the [BookSwitcher] with an [AppPreferences.testInstance] override.
Future<AppPreferences> _pumpBookSwitcher(WidgetTester tester) async {
  final prefs = AppPreferences.testInstance();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        data_providers.appPreferencesProvider.overrideWith((ref) => prefs),
      ],
      child: const MaterialApp(home: Scaffold(body: BookSwitcher())),
    ),
  );
  return prefs;
}

/// Pumps [AppScaffold] inside a real GoRouter ShellRoute (AppScaffold needs
/// GoRouterState for its active-tab lookup).
/// Returns the [AppPreferences] test instance for persistence assertions.
Future<AppPreferences> _pumpScaffoldInRouter(
    WidgetTester tester, Widget page) async {
  final prefs = AppPreferences.testInstance();
  final router = GoRouter(
    initialLocation: '/',
    routes: [
      ShellRoute(
        builder: (_, _, child) => AppScaffold(child: child),
        routes: [
          GoRoute(path: '/', builder: (_, _) => page),
          GoRoute(
              path: '/history', builder: (_, _) => const SizedBox()),
          GoRoute(path: '/sync', builder: (_, _) => const SizedBox()),
          GoRoute(
              path: '/settings', builder: (_, _) => const SizedBox()),
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
  // Group A: Book enum + labels
  group('A: Book enum + labels', () {
    test('BS-A1: Book.ledger and Book.commonplace have correct labels', () {
      expect(Book.ledger.label, 'PH Ledger');
      expect(Book.commonplace.label, 'PH Commonplace Book');
    });

    test('BS-A2: Book has exactly two values', () {
      expect(Book.values.length, 2);
    });
  });

  // Group B: provider + persistence
  group('B: provider + persistence', () {
    test('BS-B1: defaults to Book.ledger when nothing persisted', () {
      final prefs = AppPreferences.testInstance();
      final container = ProviderContainer(
        overrides: [
          data_providers.appPreferencesProvider.overrideWith((ref) => prefs),
        ],
      );
      addTearDown(container.dispose);
      expect(container.read(bookProvider), Book.ledger);
    });

    test('BS-B2: selecting Book.commonplace updates provider state', () {
      final prefs = AppPreferences.testInstance();
      final container = ProviderContainer(
        overrides: [
          data_providers.appPreferencesProvider.overrideWith((ref) => prefs),
        ],
      );
      addTearDown(container.dispose);
      container.read(bookProvider.notifier).select(Book.commonplace);
      expect(container.read(bookProvider), Book.commonplace);
    });

    test('BS-B3: selection is persisted via AppPreferences', () async {
      final prefs = AppPreferences.testInstance();
      final container = ProviderContainer(
        overrides: [
          data_providers.appPreferencesProvider.overrideWith((ref) => prefs),
        ],
      );
      addTearDown(container.dispose);
      container.read(bookProvider.notifier).select(Book.commonplace);
      expect(await prefs.getBookMode(), 'commonplace');
    });

    test('BS-B4: AppPreferences default (no key) reads Book.ledger', () async {
      final prefs = AppPreferences.testInstance();
      expect(await prefs.getBookMode(), 'ledger');
    });
  });

  // Group C: BookSwitcher widget
  group('C: BookSwitcher widget', () {
    testWidgets('BS-C1: renders the active book label (Ledger default)',
        (tester) async {
      await _pumpBookSwitcher(tester);
      expect(find.text('PH Ledger'), findsOneWidget);
    });

    testWidgets('BS-C2: tapping opens a menu listing both books',
        (tester) async {
      await _pumpBookSwitcher(tester);
      await tester.tap(find.byType(BookSwitcher));
      await tester.pumpAndSettle();
      expect(find.text('PH Commonplace Book'), findsOneWidget);
    });

    testWidgets('BS-C3: selecting Commonplace updates state + label',
        (tester) async {
      final prefs = await _pumpBookSwitcher(tester);
      await tester.tap(find.byType(BookSwitcher));
      await tester.pumpAndSettle();
      await tester.tap(find.text('PH Commonplace Book').last);
      await tester.pumpAndSettle();
      // The title bar now shows the Commonplace label.
      expect(find.text('PH Commonplace Book'), findsOneWidget);
      // Selection persisted as the 'commonplace' string key.
      expect(await prefs.getBookMode(), 'commonplace');
    });

    testWidgets('BS-C4: a single switcher instance renders one title bar',
        (tester) async {
      await _pumpBookSwitcher(tester);
      expect(find.byType(BookSwitcher), findsOneWidget);
    });
  });

  // Group D: AppScaffold integration
  group('D: AppScaffold integration', () {
    testWidgets('BS-D1: AppScaffold renders a BookSwitcher above the page',
        (tester) async {
      await _pumpScaffoldInRouter(
          tester, const Center(child: Text('page-child')));
      expect(find.byType(BookSwitcher), findsOneWidget);
      expect(find.text('page-child'), findsOneWidget);
    });

    testWidgets('BS-D2: bottom nav still has 4 tabs when switcher present',
        (tester) async {
      setSurfaceSize(tester, const Size(600, 800));
      await _pumpScaffoldInRouter(tester, const SizedBox());
      final navBar =
          tester.widget<NavigationBar>(find.byType(NavigationBar));
      expect(navBar.destinations.length, 4);
    });
  });
}
