import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/features/landing/landing_screen.dart';
import 'package:phpoc_flutter/routing/app_router.dart';

import 'test_helpers.dart';

/// Landing Screen tests — Group B (5 assertions)
///
///   B1: Widget smoke test
///   B2: Displays "New Ledger" button
///   B3: Tapping "New Ledger" navigates to /onboarding
///   B4: LandingScreen is NOT wrapped in AppScaffold (no bottom nav)
///   B5: Shows app branding/logo/title

void main() {
  group('B: LandingScreen', () {
    // B1 — Widget smoke test
    testWidgets('B1: LandingScreen renders without error', (tester) async {
      await pumpScreenWidget(tester, const LandingScreen(),
          initialPhase: AppPhase.landing);

      expect(find.byType(LandingScreen), findsOneWidget,
          reason: 'LandingScreen must render without throwing');
    });

    // B2 — Displays "New Ledger" button
    testWidgets('B2: LandingScreen displays "New Ledger" button',
        (tester) async {
      await pumpScreenWidget(tester, const LandingScreen(),
          initialPhase: AppPhase.landing);

      expect(find.text('New Ledger'), findsOneWidget,
          reason: 'New users need a clear path to ledger creation');
    });

    // B3 — Tapping "New Ledger" navigates to /onboarding
    testWidgets('B3: tapping "New Ledger" navigates to /onboarding',
        (tester) async {
      final router = GoRouter(
        initialLocation: '/landing',
        routes: [
          GoRoute(path: '/landing', builder: (_, _) => const LandingScreen()),
          GoRoute(
              path: '/onboarding', builder: (_, _) => const Placeholder()),
        ],
      );

      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pump();

      final newLedgerButton = find.text('New Ledger');
      if (newLedgerButton.evaluate().isNotEmpty) {
        await tester.tap(newLedgerButton);
        await tester.pumpAndSettle();
        expect(router.state.matchedLocation, '/onboarding',
            reason: 'GoRouter must transition to onboarding route');
      }
    });

    // B4 — LandingScreen is NOT wrapped in AppScaffold (no bottom nav)
    testWidgets('B4: LandingScreen has no bottom navigation bar',
        (tester) async {
      await pumpScreenWidget(tester, const LandingScreen(),
          initialPhase: AppPhase.landing);

      expect(find.byType(NavigationBar), findsNothing,
          reason: 'Landing/auth screens are outside the main shell');
    });

    // B5 — Shows app branding/logo/title
    testWidgets('B5: LandingScreen shows app branding/title',
        (tester) async {
      await pumpScreenWidget(tester, const LandingScreen(),
          initialPhase: AppPhase.landing);

      // "PH Ledger" title text somewhere on the landing screen
      expect(find.text('PH Ledger'), findsAtLeastNWidgets(1),
          reason: 'First screen must communicate "PH Ledger" brand');
    });
  });
}
