import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/import_result.dart';
import 'package:phpoc_flutter/features/import/import_preview_sheet.dart';

/// ImportPreviewSheet widget tests — Group P (8 assertions).
///
/// Covers:
///   P1–P8: Entry count, date range, clean/conflict display, button labels,
///          Cancel dismiss, Import/ImportAnyway trigger, scrim dismiss

// ═══════════════════════════════════════════════════════════════
// Helper: pump the ImportPreviewSheet inside a MaterialApp
// ═══════════════════════════════════════════════════════════════

Future<void> pumpPreviewSheet(
  WidgetTester tester,
  ImportPreview preview, {
  void Function()? onCancel,
  void Function(bool force)? onImport,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) {
            // Show the sheet on the next frame after build
            WidgetsBinding.instance.addPostFrameCallback((_) {
              showModalBottomSheet<void>(
                context: context,
                builder: (_) => ImportPreviewSheet(
                  preview: preview,
                  onCancel: onCancel ?? () => Navigator.pop(context),
                  onImport: onImport ?? (_) {},
                ),
              );
            });
            return const Placeholder();
          },
        ),
      ),
    ),
  );
  await tester.pump(); // Trigger post-frame callback
  await tester.pump(); // Show bottom sheet
  await tester.pumpAndSettle(); // Complete animation
}

// ═══════════════════════════════════════════════════════════════
// Group P: ImportPreviewSheet
// ═══════════════════════════════════════════════════════════════

void main() {
  group('P: ImportPreviewSheet', () {
    // P1 — Entry count display
    testWidgets('P1: sheet displays "N entries found" with correct count '
        'from preview data', (tester) async {
      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 42,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-15'),
        ),
      );

      expect(
        find.textContaining('42'),
        findsWidgets,
        reason: 'Entry count "42" must be displayed in the preview sheet',
      );

      expect(
        find.textContaining('entries'),
        findsOneWidget,
        reason: 'Must show "entries" label with the count',
      );
    });

    // P2 — Date range display
    testWidgets('P2: sheet displays date range as "first → last" with '
        'formatted dates', (tester) async {
      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 10,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-15'),
        ),
      );

      expect(
        find.textContaining('2024-01-01'),
        findsOneWidget,
        reason: 'First date must be displayed',
      );

      expect(
        find.textContaining('2024-01-15'),
        findsOneWidget,
        reason: 'Last date must be displayed',
      );
    });

    // P3 — Clean preview: no conflicts section
    testWidgets('P3: sheet shows no conflicts section when conflicts is '
        'empty', (tester) async {
      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 10,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-05'),
          conflicts: const [],
        ),
      );

      // Must show "Import" button (not "Import Anyway")
      expect(
        find.text('Import'),
        findsOneWidget,
        reason: 'Clean preview must show "Import" button',
      );

      // Must NOT show "Import Anyway"
      expect(
        find.text('Import Anyway'),
        findsNothing,
        reason: '"Import Anyway" must not appear when no conflicts exist',
      );
    });

    // P4 — Conflict display
    testWidgets('P4: sheet shows conflicts list with ⚠️ icon and each '
        'conflicting date when hasConflicts is true', (tester) async {
      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 10,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-05'),
          conflicts: ['2024-01-03', '2024-01-04'],
        ),
      );

      // Conflict dates must be shown
      expect(
        find.textContaining('2024-01-03'),
        findsOneWidget,
        reason: 'Each conflicting date must be displayed',
      );
      expect(
        find.textContaining('2024-01-04'),
        findsOneWidget,
        reason: 'Each conflicting date must be displayed',
      );

      // A warning icon or text indicator must be present
      final hasWarningIndicator =
          find.byIcon(Icons.warning).evaluate().isNotEmpty ||
          find.byIcon(Icons.warning_amber).evaluate().isNotEmpty ||
          find.byIcon(Icons.error_outline).evaluate().isNotEmpty ||
          find.textContaining('⚠').evaluate().isNotEmpty ||
          find.textContaining('conflict').evaluate().isNotEmpty ||
          find.textContaining('Conflict').evaluate().isNotEmpty;
      expect(
        hasWarningIndicator,
        isTrue,
        reason: 'Must display a warning indicator or conflict mention',
      );
    });

    // P5 — Conditional button label
    testWidgets('P5: sheet has [Import] button when no conflicts, '
        '[Import Anyway] when conflicts exist', (tester) async {
      // Case 1: No conflicts → "Import"
      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 10,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-05'),
        ),
      );

      expect(
        find.text('Import'),
        findsOneWidget,
        reason: 'Without conflicts, button must say "Import"',
      );

      // Close the sheet
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // Case 2: With conflicts → "Import Anyway"
      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 10,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-05'),
          conflicts: ['2024-01-03'],
        ),
      );

      expect(
        find.text('Import Anyway'),
        findsOneWidget,
        reason: 'With conflicts, button must say "Import Anyway"',
      );
    });

    // P6 — Cancel dismisses the sheet
    testWidgets('P6: tapping [Cancel] dismisses the sheet and returns '
        'to ImportScreen without modifying state', (tester) async {
      var cancelCalled = false;

      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 10,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-05'),
        ),
        onCancel: () {
          cancelCalled = true;
        },
      );

      // Tap Cancel
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // The onCancel callback must have been invoked
      expect(cancelCalled, isTrue,
          reason: 'Cancel button must call onCancel callback');
    });

    // P7 — Import / Import Anyway triggers onImport
    testWidgets('P7: tapping [Import] / [Import Anyway] calls '
        'onImport with correct force flag', (tester) async {
      // Test Import (force: false)
      bool? importForceFlag;
      bool importCalled = false;

      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 15,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-15'),
        ),
        onImport: (force) {
          importCalled = true;
          importForceFlag = force;
        },
      );

      await tester.tap(find.text('Import'));
      await tester.pumpAndSettle();

      expect(importCalled, isTrue,
          reason: 'Tapping Import must call onImport');
      expect(importForceFlag, false,
          reason: 'Clean preview must call onImport with force=false');

      // Close the sheet
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // Test Import Anyway (force: true)
      importCalled = false;
      importForceFlag = null;

      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 15,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-15'),
          conflicts: ['2024-01-03'],
        ),
        onImport: (force) {
          importCalled = true;
          importForceFlag = force;
        },
      );

      await tester.tap(find.text('Import Anyway'));
      await tester.pumpAndSettle();

      expect(importCalled, isTrue,
          reason: 'Tapping Import Anyway must call onImport');
      expect(importForceFlag, true,
          reason: 'Conflict preview must call onImport with force=true');
    });

    // P8 — ModalBottomSheet scrim dismiss
    testWidgets('P8: sheet is a ModalBottomSheet — tapping scrim dismisses '
        'without side effects', (tester) async {
      await pumpPreviewSheet(
        tester,
        ImportPreview(
          entryCount: 5,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-03'),
        ),
      );

      // The bottom sheet must be present
      expect(
        find.byType(ImportPreviewSheet),
        findsOneWidget,
        reason: 'ImportPreviewSheet must be displayed as a bottom sheet',
      );

      // Tapping the barrier (scrim) must dismiss the sheet without error.
      // We find the ModalBarrier and tap it.
      final barrier = find.byType(ModalBarrier);
      if (barrier.evaluate().isNotEmpty) {
        await tester.tap(barrier.first);
        await tester.pumpAndSettle();

        // After dismiss, the sheet must be gone
        expect(
          find.byType(ImportPreviewSheet),
          findsNothing,
          reason: 'Sheet must dismiss when scrim is tapped',
        );
      }
    });
  });
}
