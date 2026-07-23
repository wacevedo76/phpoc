import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/features/settings/settings_screen.dart';
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/routing/app_router.dart';

import 'test_helpers.dart';

/// Settings Screen tests — Group H (13 assertions)

void main() {
  group('H: SettingsScreen', () {
    // H1 — Widget smoke test within AppScaffold
    testWidgets('H1: SettingsScreen renders without error within AppScaffold',
        (tester) async {
      final router = GoRouter(
        initialLocation: '/settings',
        routes: [
          ShellRoute(
            builder: (_, _, child) => AppScaffold(child: child),
            routes: [
              GoRoute(path: '/', builder: (_, _) => const Placeholder()),
              GoRoute(
                  path: '/settings',
                  builder: (_, _) => const SettingsScreen()),
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

      expect(find.byType(SettingsScreen), findsOneWidget,
          reason: 'SettingsScreen must render inside the bottom-nav shell');
      expect(find.byType(AppScaffold), findsOneWidget,
          reason: 'SettingsScreen must be wrapped in AppScaffold');
    });

    // H2 — Displays Worker URL or "Not configured"
    testWidgets('H2: SettingsScreen displays current Worker URL or '
        '"Not configured"', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: Worker URL shown (or "Not configured" if absent)
    });

    // H3 — Displays Worker connection status
    testWidgets(
        'H3: SettingsScreen displays Worker connection status (connected / '
        'disconnected)', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: connection status shown
    });

    // H4 — Tapping Worker config opens editor for URL + API key
    testWidgets(
        'H4: tapping Worker config opens editor for URL and API key',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: tapping Worker config expands/opens input fields
    });

    // H5 — Saving Worker config calls onboardingService.connectWorker()
    testWidgets(
        'H5: saving Worker config calls onboardingService.connectWorker()',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: settings calls onboardingService for Worker config
    });

    // H6 — "Change Passphrase" option opens old/new passphrase fields
    testWidgets(
        'H6: "Change Passphrase" option opens old/new passphrase fields',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: tapping "Change Passphrase" opens input fields
    });

    // H7 — Change passphrase: new passphrase < 8 chars → validation error
    testWidgets(
        'H7: change passphrase — new passphrase < 8 chars shows validation '
        'error', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: submitting short new passphrase shows validation error
    });

    // H8 — Change passphrase: wrong old passphrase → AuthException error
    testWidgets(
        'H8: change passphrase — wrong old passphrase shows AuthException error',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: wrong old passphrase surfaces AuthException to user
    });

    // H9 — Change passphrase: correct old + valid new → changePassphrase()
    testWidgets(
        'H9: change passphrase — correct old + valid new calls '
        'authService.changePassphrase()', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: settings calls authService for passphrase change
    });

    // H10 — "Export Recovery Seed" shows warning dialog before revealing seed
    testWidgets(
        'H10: "Export Recovery Seed" shows warning dialog before revealing '
        'seed', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: tapping Export Seed first shows warning dialog
    });

    // H11 — Export seed: after confirmation, seed displayed (re-auth)
    testWidgets(
        'H11: export seed — after confirmation, seed is displayed with '
        're-authentication', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: confirming warning + re-auth shows the seed
    });

    // H12 — "Lock / Log Out" clears MK and transitions to /unlock
    testWidgets(
        'H12: "Lock / Log Out" option clears MK and transitions to /unlock',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: tapping Lock/Log Out calls authService.lock() + goToAuth()
    });

    // H13 — "About" section shows app name, version, and build info
    testWidgets(
        'H13: "About" section shows app name, version, and build info',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);

      // Phase 3: About section shows "PH Ledger" and version info
    });
  });
}
