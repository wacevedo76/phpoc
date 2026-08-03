/// Exception thrown by [ImportService] operations.
class ImportException implements Exception {
  final String message;
  const ImportException(this.message);

  @override
  String toString() => 'ImportException: $message';
}

/// A date range with first and last ISO date strings.
class DateRange {
  final String first;
  final String last;

  const DateRange({required this.first, required this.last});

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DateRange && first == other.first && last == other.last;

  @override
  int get hashCode => Object.hash(first, last);

  @override
  String toString() => 'DateRange($first → $last)';
}

/// Preview result from a dry-run import — shows what would be imported.
class ImportPreview {
  final int entryCount;
  final DateRange dateRange;
  final List<String> conflicts;

  const ImportPreview({
    required this.entryCount,
    required this.dateRange,
    this.conflicts = const [],
  });

  /// True when there are conflicting dates between source and target.
  bool get hasConflicts => conflicts.isNotEmpty;

  /// True when there are no entries to import.
  bool get isEmpty => entryCount == 0;
}

/// Result of a completed import operation.
class ImportResult {
  final int sourceEntryCount;
  final int migratedCount;
  final int skippedCount;
  final int newBlockCount;
  final DateRange sourceDateRange;
  final List<String> conflicts;

  const ImportResult({
    required this.sourceEntryCount,
    required this.migratedCount,
    this.skippedCount = 0,
    this.newBlockCount = 0,
    required this.sourceDateRange,
    this.conflicts = const [],
  });

  /// True when at least one entry was successfully migrated.
  bool get isSuccess => migratedCount > 0;

  /// True when there were date conflicts during import.
  bool get hasConflicts => conflicts.isNotEmpty;
}
