import 'package:flutter/material.dart';

import '../../core/models/import_result.dart';

/// Modal bottom sheet shown during and after the import operation.
///
/// Three states via named constructors:
///   - [ImportProgressSheet.running] — in-progress with phase text
///   - [ImportProgressSheet.success] — completed with summary
///   - [ImportProgressSheet.error] — failed with recovery options
class ImportProgressSheet extends StatelessWidget {
  final String? phase;
  final ImportResult? result;
  final String? message;
  final void Function()? onBackToDashboard;
  final void Function()? onTryAgain;
  final void Function()? onCancel;
  final bool _isRunning;
  final bool _isSuccess;
  final bool _isError;

  /// In-progress import — shows phase text and indeterminate progress bar.
  const ImportProgressSheet.running({
    super.key,
    String phase = 'Decrypting source entries\u2026',
  })  : phase = phase,
        result = null,
        message = null,
        onBackToDashboard = null,
        onTryAgain = null,
        onCancel = null,
        _isRunning = true,
        _isSuccess = false,
        _isError = false;

  /// Import completed successfully.
  const ImportProgressSheet.success({
    super.key,
    required ImportResult result,
    required void Function() onBackToDashboard,
  })  : phase = null,
        result = result,
        message = null,
        onBackToDashboard = onBackToDashboard,
        onTryAgain = null,
        onCancel = null,
        _isRunning = false,
        _isSuccess = true,
        _isError = false;

  /// Import failed with error.
  const ImportProgressSheet.error({
    super.key,
    required String message,
    required void Function() onTryAgain,
    required void Function() onCancel,
  })  : phase = null,
        result = null,
        message = message,
        onBackToDashboard = null,
        onTryAgain = onTryAgain,
        onCancel = onCancel,
        _isRunning = false,
        _isSuccess = false,
        _isError = true;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Drag handle
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: Colors.grey.shade300,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 16),

            if (_isRunning) ...[
              _buildRunning(context),
            ] else if (_isSuccess) ...[
              _buildSuccess(context),
            ] else if (_isError) ...[
              _buildError(context),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildRunning(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const TickerMode(
          enabled: false,
          child: LinearProgressIndicator(),
        ),
        const SizedBox(height: 20),
        Text(
          phase!,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
      ],
    );
  }

  Widget _buildSuccess(BuildContext context) {
    final r = result!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          '\u2705 ${r.migratedCount} entries imported in ${r.newBlockCount} day blocks',
          style: Theme.of(context).textTheme.titleMedium?.copyWith(
                color: Colors.green.shade700,
              ),
        ),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: onBackToDashboard,
          child: const Text('Back to Dashboard'),
        ),
      ],
    );
  }

  Widget _buildError(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(Icons.error_outline, color: Colors.red.shade700),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                message!,
                style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      color: Colors.red.shade700,
                    ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: onCancel,
                child: const Text('Cancel'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: FilledButton(
                onPressed: onTryAgain,
                child: const Text('Try Again'),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
