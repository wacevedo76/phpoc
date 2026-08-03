import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/crypto/crypto_service.dart';
import '../../core/models/import_result.dart';
import '../../data/storage/database.dart';
import '../../data/storage/providers.dart' as data_providers;
import '../../services/import_service.dart';

/// Provider for the [ImportService] instance.
///
/// Returns an [AsyncValue] wrapping the service. The service is created
/// synchronously from the current crypto and database providers.
final importServiceProvider = Provider<AsyncValue<ImportService>>((ref) {
  final crypto = ref.watch(data_providers.cryptoServiceProvider);
  final db = ref.watch(data_providers.databaseProvider);

  final service = ImportService(
    targetCrypto: crypto,
    targetDb: db,
  );

  return AsyncValue.data(service);
});

// ═══════════════════════════════════════════════════════════════
// Import state machine — sealed state classes
// ═══════════════════════════════════════════════════════════════

/// The import state — modeled as a sealed class hierarchy.
///
/// Transitions:
///   ImportInitial → ImportReady (setSeed/setFile)
///   ImportReady  → ImportPreviewing → ImportPreviewLoaded / ImportFailed
///   ImportPreviewLoaded → ImportRunning → ImportDone / ImportFailed
sealed class ImportState {
  const ImportState();
}

/// Initial/default state — no seed or file provided yet.
class ImportInitial extends ImportState {
  const ImportInitial();

  String? get seed => null;
  Uint8List? get fileBytes => null;
  bool get previewEnabled => false;
}

/// Ready state — seed and/or file have been provided, preview is enabled.
class ImportReady extends ImportState {
  final String? seed;
  final Uint8List? fileBytes;

  const ImportReady({this.seed, this.fileBytes});

  bool get previewEnabled => true;
}

/// Dry-run is in progress.
class ImportPreviewing extends ImportState {
  final String? seed;
  final Uint8List? fileBytes;

  const ImportPreviewing({this.seed, this.fileBytes});
}

/// Dry-run completed — preview data is available.
class ImportPreviewLoaded extends ImportState {
  final ImportPreview preview;
  final String? seed;
  final Uint8List? fileBytes;

  const ImportPreviewLoaded({
    required this.preview,
    this.seed,
    this.fileBytes,
  });
}

/// Import is in progress.
class ImportRunning extends ImportState {
  final String? seed;
  final Uint8List? fileBytes;
  final String phase;

  const ImportRunning({
    this.seed,
    this.fileBytes,
    this.phase = 'Decrypting source entries\u2026',
  });
}

/// Import completed successfully.
class ImportDone extends ImportState {
  final ImportResult result;

  const ImportDone({required this.result});
}

/// Import failed with an error message.
class ImportFailed extends ImportState {
  final String message;

  const ImportFailed({required this.message});
}

// ═══════════════════════════════════════════════════════════════
// ImportNotifier — manages the import state machine
// ═══════════════════════════════════════════════════════════════

final importNotifierProvider =
    NotifierProvider<ImportNotifier, ImportState>(ImportNotifier.new);

class ImportNotifier extends Notifier<ImportState> {
  @override
  ImportState build() => const ImportInitial();

  /// Set the source recovery seed and transition to [ImportReady].
  void setSeed(String seed) {
    state = ImportReady(
      seed: seed,
      fileBytes: (state is ImportReady) ? (state as ImportReady).fileBytes : null,
    );
  }

  /// Set the ledger file bytes and transition to [ImportReady].
  void setFile(Uint8List fileBytes) {
    state = ImportReady(
      seed: (state is ImportReady) ? (state as ImportReady).seed : null,
      fileBytes: fileBytes,
    );
  }

  /// Extract [seed] and [fileBytes] from the current state.
  ///
  /// Returns `(null, null)` if the state doesn't carry seed/file information.
  (String?, Uint8List?) _extractSeedAndFile(ImportState s) => switch (s) {
        ImportReady(seed: final s, fileBytes: final f) => (s, f),
        ImportPreviewLoaded(seed: final s, fileBytes: final f) => (s, f),
        ImportPreviewing(seed: final s, fileBytes: final f) => (s, f),
        ImportRunning(seed: final s, fileBytes: final f) => (s, f),
        _ => (null, null),
      };

  /// Run a dry-run import preview.
  ///
  /// Transitions through [ImportPreviewing] → [ImportPreviewLoaded] or
  /// [ImportFailed]. Throws [StateError] if no seed or file is set.
  Future<void> dryRun() async {
    final (seed, fileBytes) = _extractSeedAndFile(state);

    if (seed == null && fileBytes == null) {
      throw StateError(
        'No seed or file provided — call setSeed() or setFile() before dryRun()',
      );
    }

    state = ImportPreviewing(seed: seed, fileBytes: fileBytes);

    // Yield to the event loop so the UI can render the previewing state
    // (loading indicator) before the possibly-synchronous service call.
    await Future<void>.delayed(Duration.zero);

    final svc = await _requireService();

    try {
      final preview = await svc.dryRun(sourceSeed: seed ?? '');
      state = ImportPreviewLoaded(
        preview: preview,
        seed: seed,
        fileBytes: fileBytes,
      );
    } on ImportException catch (e) {
      state = ImportFailed(message: e.message);
    }
  }

  /// Execute the import.
  ///
  /// Transitions through [ImportRunning] → [ImportDone] or [ImportFailed].
  Future<void> import({bool force = false}) async {
    final (seed, fileBytes) = _extractSeedAndFile(state);

    if (seed == null && fileBytes == null) {
      throw StateError(
        'No seed or file provided — run dryRun() first',
      );
    }

    state = ImportRunning(seed: seed, fileBytes: fileBytes);

    final svc = await _requireService();

    try {
      final result = await svc.import(sourceSeed: seed ?? '', force: force);
      state = ImportDone(result: result);
    } on ImportException catch (e) {
      state = ImportFailed(message: e.message);
    }
  }

  /// Reset to [ImportReady] (used for "Try Again").
  ///
  /// Seed and file bytes are preserved in the UI (text field and file picker
  /// state), so resetting with null is correct — the user will re-trigger
  /// [setSeed] or [setFile] by interacting with the input controls.
  void resetToReady() {
    state = const ImportReady();
  }

  /// Get the [ImportService] from the provider, throwing if not loaded.
  Future<ImportService> _requireService() async {
    final asyncSvc = ref.read(importServiceProvider);
    return asyncSvc.value ??
        (throw StateError('ImportService not available'));
  }
}
