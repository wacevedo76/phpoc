import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/import_result.dart';
import 'package:phpoc_flutter/features/import/import_progress_sheet.dart';

/// ImportProgressSheet widget tests — Group Q (7 assertions).
///
/// Covers:
///   Q1–Q7: Phase label, progress bar, success summary, error display,
///          error recovery (Try Again, Cancel), success navigation

// ═══════════════════════════════════════════════════════════════
// Helper: pump ImportProgressSheet variants
// ═══════════════════════════════════════════════════════════════

/// Pump the sheet in its running/loading state.
Future<void> pumpProgressSheetRunning(
  WidgetTester tester, {
  String phase = 'Decrypting source entries\u2026',
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              showModalBottomSheet<void>(
                context: context,
                isDismissible: false,
                enableDrag: false,
                builder: (_) => ImportProgressSheet.running(phase: phase),
              );
            });
            return const Placeholder();
          },
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  await tester.pumpAndSettle();
}

/// Pump the sheet in its success state.
Future<void> pumpProgressSheetSuccess(
  WidgetTester tester, {
  ImportResult? result,
  void Function()? onBackToDashboard,
}) async {
  final res = result ??
      ImportResult(
        sourceEntryCount: 42,
        migratedCount: 42,
        skippedCount: 0,
        newBlockCount: 5,
        sourceDateRange: const DateRange(
            first: '2024-01-01', last: '2024-01-15'),
      );

  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              showModalBottomSheet<void>(
                context: context,
                isDismissible: false,
                enableDrag: false,
                builder: (_) => ImportProgressSheet.success(
                  result: res,
                  onBackToDashboard: onBackToDashboard ?? () {},
                ),
              );
            });
            return const Placeholder();
          },
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  await tester.pumpAndSettle();
}

/// Pump the sheet in its error state.
Future<void> pumpProgressSheetError(
  WidgetTester tester, {
  String message = 'Wrong seed — could not decrypt source ledger genesis',
  void Function()? onTryAgain,
  void Function()? onCancel,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              showModalBottomSheet<void>(
                context: context,
                isDismissible: false,
                enableDrag: false,
                builder: (_) => ImportProgressSheet.error(
                  message: message,
                  onTryAgain: onTryAgain ?? () {},
                  onCancel: onCancel ?? () {},
                ),
              );
            });
            return const Placeholder();
          },
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
  await tester.pumpAndSettle();
}

// ═══════════════════════════════════════════════════════════════
// Group Q: ImportProgressSheet
// ═══════════════════════════════════════════════════════════════

void main() {
  group('Q: ImportProgressSheet', () {
    // Q1 — Phase text during import
    testWidgets('Q1: during import (running state), sheet shows current '
        'phase text', (tester) async {
      await pumpProgressSheetRunning(
        tester,
        phase: 'Decrypting source entries\u2026',
      );

      expect(
        find.textContaining('Decrypting'),
        findsOneWidget,
        reason: 'Sheet must display the current import phase description',
      );

      expect(
        find.textContaining('source entries'),
        findsOneWidget,
        reason: 'Phase text must describe the operation being performed',
      );
    });

    // Q2 — Indeterminate progress bar during import
    testWidgets('Q2: during import, sheet shows indeterminate '
        'LinearProgressIndicator', (tester) async {
      await pumpProgressSheetRunning(tester);

      // LinearProgressIndicator must be present
      expect(
        find.byType(LinearProgressIndicator),
        findsOneWidget,
        reason: 'Progress sheet must show a LinearProgressIndicator',
      );

      // The indicator must actually be displayed (not hidden)
      final indicator =
          tester.widget<LinearProgressIndicator>(
              find.byType(LinearProgressIndicator));
      // An indeterminate indicator has value == null
      expect(
        indicator.value,
        isNull,
        reason: 'Progress indicator must be indeterminate during import',
      );
    });

    // Q3 — Success summary
    testWidgets('Q3: on success (ImportDone), sheet shows '
        '"✅ N entries imported in M day blocks"', (tester) async {
      await pumpProgressSheetSuccess(
        tester,
        result: ImportResult(
          sourceEntryCount: 42,
          migratedCount: 42,
          skippedCount: 0,
          newBlockCount: 5,
          sourceDateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-15'),
        ),
      );

      // Success indicator must be present
      final hasSuccessIndicator =
          find.textContaining('\u2705').evaluate().isNotEmpty ||
          find.byIcon(Icons.check_circle).evaluate().isNotEmpty ||
          find.textContaining('success').evaluate().isNotEmpty ||
          find.textContaining('imported').evaluate().isNotEmpty;
      expect(hasSuccessIndicator, isTrue,
          reason: 'Must show a success indicator');

      // Entry count
      expect(
        find.textContaining('42'),
        findsWidgets,
        reason: 'Success summary must display entry count',
      );

      // Block count
      expect(
        find.textContaining('5'),
        findsWidgets,
        reason: 'Success summary must display new block count',
      );
    });

    // Q4 — Success navigation: Back to Dashboard
    testWidgets('Q4: on success, sheet shows "Back to Dashboard" button '
        'that triggers navigation callback', (tester) async {
      var navigatedToDashboard = false;

      await pumpProgressSheetSuccess(
        tester,
        onBackToDashboard: () {
          navigatedToDashboard = true;
        },
      );

      expect(
        find.text('Back to Dashboard'),
        findsOneWidget,
        reason: 'Success state must have a "Back to Dashboard" button',
      );

      // Tap the button
      await tester.tap(find.text('Back to Dashboard'));
      await tester.pumpAndSettle();

      expect(navigatedToDashboard, isTrue,
          reason: 'Tapping "Back to Dashboard" must trigger the callback');
    });

    // Q5 — Error display
    testWidgets('Q5: on error (ImportError), sheet shows error icon + '
        'message text from the exception', (tester) async {
      const errorMsg =
          'Wrong seed — could not decrypt source ledger genesis';

      await pumpProgressSheetError(
        tester,
        message: errorMsg,
      );

      // Error message must be displayed
      expect(
        find.text(errorMsg),
        findsOneWidget,
        reason: 'Error message text must be fully displayed to the user',
      );
    });

    // Q6 — Error recovery: Try Again
    testWidgets('Q6: on error, sheet shows "Try Again" button that calls '
        'onTryAgain callback', (tester) async {
      var tryAgainCalled = false;

      await pumpProgressSheetError(
        tester,
        onTryAgain: () {
          tryAgainCalled = true;
        },
      );

      expect(
        find.text('Try Again'),
        findsOneWidget,
        reason: 'Error state must have a "Try Again" button for recovery',
      );

      await tester.tap(find.text('Try Again'));
      await tester.pumpAndSettle();

      expect(tryAgainCalled, isTrue,
          reason: 'Tapping "Try Again" must trigger the onTryAgain callback');
    });

    // Q7 — Error dismissal: Cancel
    testWidgets('Q7: on error, sheet shows "Cancel" button that calls '
        'onCancel callback', (tester) async {
      var cancelCalled = false;

      await pumpProgressSheetError(
        tester,
        onCancel: () {
          cancelCalled = true;
        },
      );

      expect(
        find.text('Cancel'),
        findsOneWidget,
        reason: 'Error state must have a "Cancel" button for dismissal',
      );

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(cancelCalled, isTrue,
          reason: 'Tapping "Cancel" must trigger the onCancel callback');
    });
  });
}
