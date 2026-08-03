import 'package:flutter/material.dart';

import '../../core/models/import_result.dart';

/// Modal bottom sheet that displays a dry-run import preview.
///
/// Shows entry count, date range, and any date conflicts before the user
/// confirms or cancels the import.
class ImportPreviewSheet extends StatelessWidget {
  final ImportPreview preview;
  final void Function() onCancel;
  final void Function(bool force) onImport;

  const ImportPreviewSheet({
    super.key,
    required this.preview,
    required this.onCancel,
    required this.onImport,
  });

  bool get _hasConflicts => preview.hasConflicts;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
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

              // Title
              Text(
                'Import Preview',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 16),

              // Entry count
              Text(
                '${preview.entryCount} entries found',
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const SizedBox(height: 8),

              // Date range
              if (preview.dateRange.first.isNotEmpty)
                Text(
                  'Date range: ${preview.dateRange.first} \u2192 ${preview.dateRange.last}',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: Colors.grey.shade600,
                      ),
                ),

              // Conflicts section
              if (_hasConflicts) ...[
                const SizedBox(height: 16),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Padding(
                      padding: EdgeInsets.only(top: 2),
                      child: Icon(Icons.warning_amber,
                          color: Colors.orange, size: 20),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Date conflicts: ${preview.conflicts.length} date(s) '
                        'already have entries in your ledger',
                        style: Theme.of(context)
                            .textTheme
                            .bodyMedium
                            ?.copyWith(color: Colors.orange.shade800),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                ...preview.conflicts.map(
                  (date) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      children: [
                        const SizedBox(width: 28),
                        const Icon(Icons.warning, color: Colors.orange, size: 16),
                        const SizedBox(width: 6),
                        Text(date, style: const TextStyle(fontSize: 13)),
                      ],
                    ),
                  ),
                ),
              ],

              const SizedBox(height: 24),

              // Buttons
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
                      onPressed: () => onImport(_hasConflicts),
                      child: Text(_hasConflicts ? 'Import Anyway' : 'Import'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
