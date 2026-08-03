import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/import_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/features/import/import_providers.dart';
import 'package:phpoc_flutter/services/import_service.dart';

/// ImportNotifier state machine tests — Group N (8 assertions).
///
/// Covers:
///   N1–N8: ImportNotifier state transitions, guard clauses, error paths
///
/// The ImportNotifier is an AsyncNotifier that manages a sealed ImportState:
///   ImportInitial → ImportReady → ImportPreviewing → ImportPreviewLoaded
///   ImportRunning → ImportDone / ImportFailed

// ═══════════════════════════════════════════════════════════════
// Fake ImportService for controlled test behavior
// ═══════════════════════════════════════════════════════════════

class _FakeImportService extends ImportService {
  ImportPreview? dryRunResult;
  ImportResult? importResult;
  bool dryRunThrows = false;
  String dryRunError = 'Import failed';
  bool importThrows = false;
  String importError = 'Import failed';
  bool throwSelfImport = false;
  bool throwConflict = false;

  _FakeImportService({
    required super.targetCrypto,
    required super.targetDb,
  });

  @override
  Future<ImportPreview> dryRun({
    required String sourceSeed,
    List<Map<String, dynamic>>? sourceChain,
  }) async {
    if (throwSelfImport) {
      throw ImportException(
        'Cannot import from the same ledger — the seed matches the current ledger',
      );
    }
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
    if (throwConflict && !force) {
      throw ImportException(
        'Date overlap detected with existing entries: 2024-01-03. '
        'Use force:true to override.',
      );
    }
    if (importThrows) {
      throw ImportException(importError);
    }
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

/// Thin helper: build a ProviderContainer with a fake ImportService wired
/// through importServiceProvider.
ProviderContainer _containerWithFakeImport(
  _FakeImportService fakeService,
) {
  final container = ProviderContainer(
    overrides: [
      importServiceProvider.overrideWith((ref) {
        return AsyncValue.data(fakeService);
      }),
    ],
  );
  return container;
}

// ═══════════════════════════════════════════════════════════════
// Group N: ImportNotifier — Provider State Machine
// ═══════════════════════════════════════════════════════════════

void main() {
  group('N: ImportNotifier', () {
    // N1 — Initial state
    test('N1: initial state is ImportInitial with no seed, no file, '
        'preview disabled', () {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      final container = _containerWithFakeImport(fakeService);

      final notifier = container.read(importNotifierProvider.notifier);
      final state = notifier.state;

      expect(state, isA<ImportInitial>(),
          reason: 'Initial state must be ImportInitial');

      final initial = state as ImportInitial;
      expect(initial.seed, isNull,
          reason: 'Seed must be null initially');
      expect(initial.fileBytes, isNull,
          reason: 'File bytes must be null initially');
      expect(initial.previewEnabled, false,
          reason: 'Preview must be disabled when no seed/file provided');

      container.dispose();
    });

    // N2 — Setting seed → ImportReady
    test('N2: setting seed transitions to ImportReady with '
        'previewEnabled: true', () {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      final container = _containerWithFakeImport(fakeService);

      final notifier = container.read(importNotifierProvider.notifier);
      const seed = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

      notifier.setSeed(seed);

      final state = notifier.state;
      expect(state, isA<ImportReady>(),
          reason: 'Setting seed must transition to ImportReady');

      final ready = state as ImportReady;
      expect(ready.seed, seed,
          reason: 'Seed must be stored in ImportReady state');
      expect(ready.previewEnabled, true,
          reason: 'Preview must be enabled once seed is set');

      container.dispose();
    });

    // N3 — Setting file bytes → ImportReady
    test('N3: setting file bytes transitions to ImportReady with '
        'previewEnabled: true', () {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      final container = _containerWithFakeImport(fakeService);

      final notifier = container.read(importNotifierProvider.notifier);
      final fileBytes = Uint8List.fromList('{"test":true}'.codeUnits);

      notifier.setFile(fileBytes);

      final state = notifier.state;
      expect(state, isA<ImportReady>(),
          reason: 'Setting file bytes must transition to ImportReady');

      final ready = state as ImportReady;
      expect(ready.fileBytes, fileBytes,
          reason: 'File bytes must be stored in ImportReady state');
      expect(ready.previewEnabled, true,
          reason: 'Preview must be enabled once file is set');

      container.dispose();
    });

    // N4 — dryRun happy path
    test('N4: calling dryRun() transitions through ImportPreviewing → '
        'ImportPreview with preview data', () async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      fakeService.dryRunResult = ImportPreview(
        entryCount: 15,
        dateRange: const DateRange(
            first: '2024-01-01', last: '2024-01-15'),
      );
      final container = _containerWithFakeImport(fakeService);

      final notifier = container.read(importNotifierProvider.notifier);
      const seed = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';
      notifier.setSeed(seed);

      // Start dryRun — state should be Previewing while in-flight
      final future = notifier.dryRun();
      // After kicking off the async call, state should be ImportPreviewing
      // (transition happens synchronously before the await)
      expect(notifier.state, isA<ImportPreviewing>(),
          reason: 'After calling dryRun, state must transition to '
              'ImportPreviewing');

      await future;

      // After dryRun completes — state should be ImportPreviewLoaded
      final state = notifier.state;
      expect(state, isA<ImportPreviewLoaded>(),
          reason: 'After dryRun completes, state must be ImportPreviewLoaded');

      final preview = state as ImportPreviewLoaded;
      expect(preview.preview.entryCount, 15,
          reason: 'Preview must contain the entry count from dryRun');
      expect(preview.preview.dateRange.first, '2024-01-01',
          reason: 'Preview must contain the correct date range');
      expect(preview.preview.dateRange.last, '2024-01-15',
          reason: 'Preview must contain the correct date range');

      container.dispose();
    });

    // N5 — dryRun guard: no seed/file
    test('N5: calling dryRun() with no seed/file throws StateError with '
        'clear message', () async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      final container = _containerWithFakeImport(fakeService);

      final notifier = container.read(importNotifierProvider.notifier);

      expect(
        () => notifier.dryRun(),
        throwsA(isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('seed'),
        )),
        reason: 'dryRun without seed or file must throw StateError '
            'mentioning seed/file',
      );

      container.dispose();
    });

    // N6 — dryRun self-import guard
    test('N6: calling dryRun() when source seed matches target seed throws '
        'ImportException (self-import)', () async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      fakeService.throwSelfImport = true;
      final container = _containerWithFakeImport(fakeService);

      final notifier = container.read(importNotifierProvider.notifier);
      const seed = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';
      notifier.setSeed(seed);

      // dryRun should catch the ImportException and transition to ImportFailed
      await notifier.dryRun();

      final state = notifier.state;
      expect(state, isA<ImportFailed>(),
          reason: 'Self-import must transition to ImportFailed state');

      final error = state as ImportFailed;
      expect(
        error.message,
        contains('same ledger'),
        reason: 'Error message must indicate self-import rejection',
      );

      container.dispose();
    });

    // N7 — import happy path
    test('N7: calling import() transitions through ImportRunning → '
        'ImportDone with result', () async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      fakeService.dryRunResult = ImportPreview(
        entryCount: 42,
        dateRange: const DateRange(
            first: '2024-01-01', last: '2024-01-15'),
      );
      fakeService.importResult = ImportResult(
        sourceEntryCount: 42,
        migratedCount: 42,
        skippedCount: 0,
        newBlockCount: 5,
        sourceDateRange: const DateRange(
            first: '2024-01-01', last: '2024-01-15'),
      );
      final container = _containerWithFakeImport(fakeService);

      final notifier = container.read(importNotifierProvider.notifier);
      const seed = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';
      notifier.setSeed(seed);

      // Run dryRun first to get to ImportPreviewLoaded state
      await notifier.dryRun();
      expect(notifier.state, isA<ImportPreviewLoaded>(),
          reason: 'Must be in ImportPreviewLoaded state before calling import');

      // Trigger import
      final future = notifier.import(force: false);
      // State should transition synchronously to ImportRunning
      expect(notifier.state, isA<ImportRunning>(),
          reason: 'After calling import, state must transition to '
              'ImportRunning');

      await future;

      final state = notifier.state;
      expect(state, isA<ImportDone>(),
          reason: 'After import completes, state must be ImportDone');

      final done = state as ImportDone;
      expect(done.result.migratedCount, 42,
          reason: 'ImportDone must contain the migrated entry count');
      expect(done.result.newBlockCount, 5,
          reason: 'ImportDone must contain the new block count');

      container.dispose();
    });

    // N8 — import with conflicts, force: false
    test('N8: calling import() with conflicts and force:false transitions '
        'to ImportError with overlap message', () async {
      final fakeService = _FakeImportService(
        targetCrypto: CryptoService(),
        targetDb: AppDatabase.inMemory(),
      );
      fakeService.dryRunResult = ImportPreview(
        entryCount: 10,
        dateRange: const DateRange(
            first: '2024-01-01', last: '2024-01-05'),
        conflicts: ['2024-01-03'],
      );
      fakeService.throwConflict = true;
      final container = _containerWithFakeImport(fakeService);

      final notifier = container.read(importNotifierProvider.notifier);
      const seed = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';
      notifier.setSeed(seed);

      // Run dryRun first
      await notifier.dryRun();
      expect(notifier.state, isA<ImportPreviewLoaded>(),
          reason: 'Must be in ImportPreviewLoaded before import');

      // Import with force: false — should hit conflict rejection
      await notifier.import(force: false);

      final state = notifier.state;
      expect(state, isA<ImportFailed>(),
          reason: 'Import with conflicts and force:false must '
              'transition to ImportFailed');

      final error = state as ImportFailed;
      expect(
        error.message,
        contains('overlap'),
        reason: 'Error message must mention date overlap/conflict',
      );

      container.dispose();
    });
  });
}
