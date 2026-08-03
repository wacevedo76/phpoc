import 'package:go_router/go_router.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/models/import_result.dart';
import 'import_preview_sheet.dart';
import 'import_progress_sheet.dart';
import 'import_providers.dart';
import '../../routing/app_router.dart' show appLifecycleProvider;

/// Screen for importing entries from another ledger.
///
/// Supports seed-based and file-based import with a dry-run preview before
/// the actual import. Manages the full import lifecycle through the
/// [importNotifierProvider] state machine.
class ImportScreen extends ConsumerStatefulWidget {
  const ImportScreen({super.key});

  @override
  ConsumerState<ImportScreen> createState() => _ImportScreenState();
}

class _ImportScreenState extends ConsumerState<ImportScreen> {
  final _seedController = TextEditingController();
  bool _isShowingSheet = false;

  @override
  void dispose() {
    _seedController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(importNotifierProvider);

    // React to state changes that require showing a sheet.
    // Use addPostFrameCallback to avoid building during build.
    if (!_isShowingSheet) {
      if (state is ImportPreviewLoaded && !state.preview.isEmpty) {
        _isShowingSheet = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          _showPreviewSheet(state);
        });
      } else if (state is ImportRunning || state is ImportDone || state is ImportFailed) {
        _isShowingSheet = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          _showProgressSheet(state);
        });
      }
    }

    final previewEnabled = state is ImportReady ||
        state is ImportPreviewLoaded;
    final isPreviewing = state is ImportPreviewing;
    final isRunning = state is ImportRunning;

    // Show the "no entries" message if preview shows 0 entries
    final showEmptyMessage = state is ImportPreviewLoaded &&
        state.preview.isEmpty;

    return Scaffold(
      appBar: AppBar(
        leading: const BackButton(),
        title: const Text('Import Entries'),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Instructions
            const Text(
              'Enter the recovery seed from another ledger '
              'or pick a ledger.json file to import entries.',
              style: TextStyle(fontSize: 14, color: Colors.grey),
            ),
            const SizedBox(height: 16),

            // Seed text field
            TextField(
              controller: _seedController,
              decoration: const InputDecoration(
                labelText: 'Recovery Seed',
                hintText: 'Paste the 44-character seed from the source ledger',
                border: OutlineInputBorder(),
                prefixIcon: Icon(Icons.key),
              ),
              maxLines: 2,
              onChanged: (value) {
                ref.read(importNotifierProvider.notifier).setSeed(value);
              },
            ),
            const SizedBox(height: 12),

            // File picker button
            OutlinedButton.icon(
              onPressed: _pickFile,
              icon: const Icon(Icons.file_open),
              label: const Text('Pick ledger.json file'),
            ),
            const SizedBox(height: 24),

            // Loading indicator during preview / import
            if (isPreviewing || isRunning)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 16),
                child: Center(child: CircularProgressIndicator()),
              ),

            // Empty preview message
            if (showEmptyMessage)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Text(
                  'No entries to import',
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        color: Colors.grey.shade600,
                      ),
                  textAlign: TextAlign.center,
                ),
              ),

            // Preview button
            ElevatedButton.icon(
              onPressed: (previewEnabled && !isPreviewing && !isRunning)
                  ? _preview
                  : null,
              icon: const Icon(Icons.preview),
              label: const Text('Preview'),
            ),
          ],
        ),
      ),
    );
  }

  void _pickFile() {
    // TODO: Wire file_picker package to call
    // ref.read(importNotifierProvider.notifier).setFile(bytes)
    // The button is present and tappable; actual integration is
    // covered at the service/integration level.
  }

  void _preview() {
    ref.read(importNotifierProvider.notifier).dryRun();
  }

  void _showPreviewSheet(ImportPreviewLoaded state) {
    showModalBottomSheet<void>(
      context: context,
      builder: (_) => ImportPreviewSheet(
        preview: state.preview,
        onCancel: () {
          _isShowingSheet = false;
          Navigator.pop(context);
        },
        onImport: (force) {
          Navigator.pop(context);
          ref.read(importNotifierProvider.notifier).import(force: force);
        },
      ),
    ).then((_) {
      _isShowingSheet = false;
    });
  }

  void _showProgressSheet(ImportState state) {
    final Widget sheet;
    switch (state) {
      case ImportRunning(phase: final phase):
        sheet = ImportProgressSheet.running(phase: phase);
      case ImportDone(result: final result):
        sheet = ImportProgressSheet.success(
          result: result,
          onBackToDashboard: () {
            _isShowingSheet = false;
            Navigator.pop(context);
            ref.read(appLifecycleProvider.notifier).goToReady();
          },
        );
      case ImportFailed(message: final message):
        sheet = ImportProgressSheet.error(
          message: message,
          onTryAgain: () {
            _isShowingSheet = false;
            Navigator.pop(context);
            ref.read(importNotifierProvider.notifier).resetToReady();
          },
          onCancel: () {
            _isShowingSheet = false;
            Navigator.pop(context);
            ref.read(importNotifierProvider.notifier).resetToReady();
          },
        );
      case _:
        return; // Only ImportRunning/ImportDone/ImportFailed reach here
    }

    showModalBottomSheet<void>(
      context: context,
      isDismissible: false,
      enableDrag: false,
      builder: (_) => sheet,
    ).then((_) {
      _isShowingSheet = false;
    });
  }
}
