import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/features/shared/loading_indicator.dart';
import 'test_helpers.dart';

/// Loading Screen tests — Group A (4 assertions)
///
///   A1: Widget smoke test — renders without error
///   A2: Displays "Initializing PH Ledger..." text
///   A3: Shows a CircularProgressIndicator
///   A4: No AppBar with back button (boot is non-interruptible)

void main() {
  group('A: LoadingScreen', () {
    // A1 — Widget smoke test
    testWidgets('A1: LoadingScreen renders without error', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: defaultScreenOverrides(),
          child: const MaterialApp(home: LoadingScreen()),
        ),
      );
      await tester.pump();

      expect(find.byType(LoadingScreen), findsOneWidget,
          reason: 'LoadingScreen must render without throwing');
    });

    // A2 — Displays initializing message
    testWidgets('A2: LoadingScreen displays "Initializing PH Ledger..." text',
        (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: defaultScreenOverrides(),
          child: const MaterialApp(home: LoadingScreen()),
        ),
      );
      await tester.pump();

      expect(find.text('Initializing PH Ledger...'), findsOneWidget,
          reason: 'Users need to know the app is loading, not frozen');
    });

    // A3 — Shows CircularProgressIndicator
    testWidgets('A3: LoadingScreen shows a CircularProgressIndicator',
        (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: defaultScreenOverrides(),
          child: const MaterialApp(home: LoadingScreen()),
        ),
      );
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget,
          reason: 'Indeterminate spinner signals boot is in progress');
    });

    // A4 — No back navigation (no AppBar with back button)
    testWidgets('A4: LoadingScreen has no back navigation (no AppBar)',
        (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: defaultScreenOverrides(),
          child: const MaterialApp(home: LoadingScreen()),
        ),
      );
      await tester.pump();

      // No AppBar at all — users cannot navigate away during boot
      expect(find.byType(AppBar), findsNothing,
          reason: 'Boot is non-interruptible — no back navigation');
    });
  });
}
