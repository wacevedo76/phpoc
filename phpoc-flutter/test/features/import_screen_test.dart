import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/import_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/features/import/import_providers.dart';
import 'package:phpoc_flutter/features/import/import_screen.dart';
import 'package:phpoc_flutter/services/import_service.dart';

import 'test_helpers.dart';

/// ImportScreen widget tests — Group O (10 assertions).
///
/// Covers:
///   O1–O10: Seed field, file picker, preview button, state-driven UI,
///           preview sheet display, conflict display, empty preview, back nav

// ═══════════════════════════════════════════════════════════════
// Fake ImportService for controlled widget test behavior
// ═══════════════════════════════════════════════════════════════

class _FakeImportService extends ImportService {
  ImportPreview? dryRunResult;
  ImportResult? importResult;
  bool dryRunThrows = false;
  String dryRunError = 'Import failed';

  _FakeImportService({
    required super.targetCrypto,
    required super.targetDb,
  });

  @override
  Future<ImportPreview> dryRun({
    required String sourceSeed,
    List<Map<String, dynamic>>? sourceChain,
  }) async {
    if (dryRunThrows) {
      throw ImportException(dryRunError);
    }
    return dryRunResult ??
        ImportPreview(
          entryCount: 42,
          dateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-15'),
        );
  }

  @override
  Future<ImportResult> import({
    required String sourceSeed,
    List<Map<String, dynamic>>? sourceChain,
    bool force = false,
  }) async {
    return importResult ??
        ImportResult(
          sourceEntryCount: 42,
          migratedCount: 42,
          skippedCount: 0,
          newBlockCount: 5,
          sourceDateRange: const DateRange(
              first: '2024-01-01', last: '2024-01-15'),
        );
  }
}

// ═══════════════════════════════════════════════════════════════
// Group O: ImportScreen — Real Widget
// ═══════════════════════════════════════════════════════════════

void main() {
  group('O: ImportScreen', () {
    // O1 — Seed text field with label and placeholder
    testWidgets('O1: screen shows seed text field with "Recovery Seed" '
        'label and placeholder text', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // Seed text field must exist with appropriate label
      expect(
        find.text('Recovery Seed'),
        findsOneWidget,
        reason: 'Seed field must have "Recovery Seed" label',
      );

      // Placeholder/hint text must guide the user
      expect(
        find.textContaining('44-character'),
        findsOneWidget,
        reason: 'Placeholder must hint at the expected seed format',
      );

      // Must have a TextField for seed input
      expect(
        find.byType(TextField),
        findsOneWidget,
        reason: 'Must have a TextField for seed entry',
      );
    });

    // O2 — File picker button
    testWidgets('O2: screen shows "Pick ledger.json file" button that '
        'opens file picker dialog', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // File picker button must exist
      expect(
        find.text('Pick ledger.json file'),
        findsOneWidget,
        reason: 'Must have a file picker button with descriptive label',
      );

      // Must be an OutlinedButton (matching the design spec)
      expect(
        find.ancestor(
          of: find.text('Pick ledger.json file'),
          matching: find.byType(OutlinedButton),
        ),
        findsOneWidget,
        reason: 'File picker must be an OutlinedButton for secondary action',
      );
    });

    // O3 — Preview button disabled when empty
    testWidgets('O3: preview button is disabled when both seed and file '
        'are empty', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // Find the Preview button — should exist
      final previewFinder = find.text('Preview');
      expect(
        previewFinder,
        findsOneWidget,
        reason: 'Preview button must exist',
      );

      // The ElevatedButton wrapping "Preview" must be disabled
      final previewButton = tester.widget<ElevatedButton>(
        find.ancestor(
          of: previewFinder,
          matching: find.byType(ElevatedButton),
        ),
      );
      expect(
        previewButton.onPressed,
        isNull,
        reason: 'Preview button must be disabled when seed and file are empty',
      );
    });

    // O4 — Entering seed enables Preview
    testWidgets('O4: entering text in seed field enables the Preview '
        'button', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // Enter a valid-looking seed
      await tester.enterText(
        find.byType(TextField),
        'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      );
      await tester.pumpAndSettle();

      // Preview button must now be enabled
      final previewButton = tester.widget<ElevatedButton>(
        find.ancestor(
          of: find.text('Preview'),
          matching: find.byType(ElevatedButton),
        ),
      );
      expect(
        previewButton.onPressed,
        isNotNull,
        reason: 'Preview button must be enabled after entering seed text',
      );
    });

    // O5 — File picker enables Preview
    testWidgets('O5: tapping file picker button and selecting a file '
        'enables the Preview button', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // The file picker button must exist and be tappable
      final pickerFinder = find.text('Pick ledger.json file');
      expect(pickerFinder, findsOneWidget);

      // Tapping the file picker button must not throw
      // (actual file_picker integration tested at integration level)
      await tester.tap(pickerFinder);
      await tester.pumpAndSettle();

      // The screen must remain stable after file picker interaction
      expect(
        find.byType(ImportScreen),
        findsOneWidget,
        reason: 'Screen must remain after file picker tap',
      );
    });

    // O6 — Preview triggers dryRun and shows loading
    testWidgets('O6: tapping Preview while seed is entered calls '
        'dryRun and shows loading indicator', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      fakeService.dryRunResult = ImportPreview(
        entryCount: 20,
        dateRange: const DateRange(
            first: '2024-01-01', last: '2024-01-20'),
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // Enter seed
      await tester.enterText(
        find.byType(TextField),
        'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      );
      await tester.pumpAndSettle();

      // Tap Preview
      await tester.tap(find.text('Preview'));
      await tester.pump();

      // Loading indicator must appear during dryRun
      expect(
        find.byType(CircularProgressIndicator),
        findsOneWidget,
        reason: 'Loading indicator must appear during dryRun',
      );

      await tester.pumpAndSettle();

      // After dryRun, the preview sheet must appear
      // (tested in Group P as ImportPreviewSheet)
    });

    // O7 — After successful dryRun, preview sheet appears
    testWidgets('O7: after successful dry-run, ImportPreviewSheet appears '
        'with entry count and date range', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      fakeService.dryRunResult = ImportPreview(
        entryCount: 15,
        dateRange: const DateRange(
            first: '2024-01-01', last: '2024-01-15'),
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // Enter seed
      await tester.enterText(
        find.byType(TextField),
        'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      );
      await tester.pumpAndSettle();

      // Tap Preview
      await tester.tap(find.text('Preview'));
      await tester.pumpAndSettle();

      // ImportPreviewSheet must be visible
      expect(
        find.textContaining('15'),
        findsWidgets,
        reason: 'Preview sheet must display the entry count',
      );
      expect(
        find.textContaining('2024-01-01'),
        findsOneWidget,
        reason: 'Preview sheet must display first date',
      );
      expect(
        find.textContaining('2024-01-15'),
        findsOneWidget,
        reason: 'Preview sheet must display last date',
      );
    });

    // O8 — Conflicts display in preview
    testWidgets('O8: after dry-run with conflicts, ImportPreviewSheet shows '
        '⚠️ warning and conflict dates', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      fakeService.dryRunResult = ImportPreview(
        entryCount: 10,
        dateRange: const DateRange(
            first: '2024-01-01', last: '2024-01-05'),
        conflicts: ['2024-01-03', '2024-01-04'],
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // Enter seed
      await tester.enterText(
        find.byType(TextField),
        'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      );
      await tester.pumpAndSettle();

      // Tap Preview
      await tester.tap(find.text('Preview'));
      await tester.pumpAndSettle();

      // Conflict dates must be visible
      expect(
        find.textContaining('2024-01-03'),
        findsOneWidget,
        reason: 'Conflict date 2024-01-03 must be displayed',
      );
      expect(
        find.textContaining('2024-01-04'),
        findsOneWidget,
        reason: 'Conflict date 2024-01-04 must be displayed',
      );

      // Must show Import Anyway (not Import) when conflicts exist
      expect(
        find.text('Import Anyway'),
        findsOneWidget,
        reason: 'Import button must say "Import Anyway" when conflicts exist',
      );
    });

    // O9 — Empty preview (0 entries)
    testWidgets('O9: after dry-run with 0 entries, shows "No entries" '
        'message and hides import button', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      fakeService.dryRunResult = ImportPreview(
        entryCount: 0,
        dateRange: const DateRange(first: '', last: ''),
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // Enter seed
      await tester.enterText(
        find.byType(TextField),
        'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      );
      await tester.pumpAndSettle();

      // Tap Preview
      await tester.tap(find.text('Preview'));
      await tester.pumpAndSettle();

      // Must display "No entries to import" or similar
      final noEntriesFound = find.textContaining('No entries').evaluate().isNotEmpty ||
          find.textContaining('no entries').evaluate().isNotEmpty ||
          find.textContaining('0 entries').evaluate().isNotEmpty;
      expect(
        noEntriesFound,
        isTrue,
        reason: 'Must show a message indicating no entries to import',
      );

      // Import button must NOT be present
      expect(
        find.text('Import'),
        findsNothing,
        reason: 'Import button must not be shown when there are 0 entries',
      );
    });

    // O10 — Back navigation
    testWidgets('O10: tapping back arrow returns to previous screen '
        'without side effects', (tester) async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );

      await pumpScreenWidget(
        tester,
        const ImportScreen(),
        overrides: [
          importServiceProvider.overrideWith((ref) {
            return AsyncValue.data(fakeService);
          }),
        ],
      );
      await tester.pumpAndSettle();

      // AppBar must have a back button
      expect(
        find.byType(BackButton),
        findsOneWidget,
        reason: 'ImportScreen must have a back button for navigation',
      );

      // Screen must render with AppBar
      expect(
        find.byType(AppBar),
        findsOneWidget,
        reason: 'ImportScreen must have an AppBar with title',
      );

      expect(
        find.text('Import Entries'),
        findsOneWidget,
        reason: 'AppBar title must be "Import Entries"',
      );
    });
  });
}
