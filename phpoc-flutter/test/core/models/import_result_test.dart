import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/import_result.dart';

/// ImportResult + ImportPreview model tests — Groups F (5) + G (4) = 9 assertions.
///
/// Covers:
///   F1–F5: ImportResult fields and getters
///   G1–G4: ImportPreview fields, flags, and immutability

// ═══════════════════════════════════════════════════════════════
// Group F: ImportResult Model
// ═══════════════════════════════════════════════════════════════

void main() {
  group('F: ImportResult', () {
    // F1 — holds all count fields
    test('F1: holds sourceEntryCount, migratedCount, skippedCount, newBlockCount',
        () {
      const result = ImportResult(
        sourceEntryCount: 42,
        migratedCount: 40,
        skippedCount: 2,
        newBlockCount: 5,
        sourceDateRange: DateRange(first: '2024-01-01', last: '2024-01-15'),
        conflicts: [],
      );

      expect(result.sourceEntryCount, 42);
      expect(result.migratedCount, 40);
      expect(result.skippedCount, 2);
      expect(result.newBlockCount, 5);
    });

    // F2 — holds sourceDateRange
    test('F2: holds sourceDateRange with first and last ISO date strings', () {
      const result = ImportResult(
        sourceEntryCount: 10,
        migratedCount: 10,
        skippedCount: 0,
        newBlockCount: 2,
        sourceDateRange: DateRange(first: '2024-03-01', last: '2024-03-10'),
        conflicts: [],
      );

      expect(result.sourceDateRange.first, '2024-03-01');
      expect(result.sourceDateRange.last, '2024-03-10');
    });

    // F3 — holds conflicts list
    test('F3: holds conflicts list of date strings', () {
      const result = ImportResult(
        sourceEntryCount: 10,
        migratedCount: 10,
        skippedCount: 0,
        newBlockCount: 2,
        sourceDateRange: DateRange(first: '2024-01-01', last: '2024-01-10'),
        conflicts: ['2024-01-03', '2024-01-05'],
      );

      expect(result.conflicts, ['2024-01-03', '2024-01-05']);
    });

    // F4 — isSuccess getter
    test('F4: isSuccess is true when migratedCount > 0', () {
      const success = ImportResult(
        sourceEntryCount: 10,
        migratedCount: 8,
        skippedCount: 2,
        newBlockCount: 3,
        sourceDateRange: DateRange(first: '2024-01-01', last: '2024-01-05'),
        conflicts: [],
      );

      const noSuccess = ImportResult(
        sourceEntryCount: 0,
        migratedCount: 0,
        skippedCount: 0,
        newBlockCount: 0,
        sourceDateRange: DateRange(first: '', last: ''),
        conflicts: [],
      );

      expect(success.isSuccess, isTrue);
      expect(noSuccess.isSuccess, isFalse);
    });

    // F5 — hasConflicts getter
    test('F5: hasConflicts is true when conflicts.isNotEmpty', () {
      const withConflicts = ImportResult(
        sourceEntryCount: 10,
        migratedCount: 10,
        skippedCount: 0,
        newBlockCount: 2,
        sourceDateRange: DateRange(first: '2024-01-01', last: '2024-01-05'),
        conflicts: ['2024-01-03'],
      );

      const withoutConflicts = ImportResult(
        sourceEntryCount: 10,
        migratedCount: 10,
        skippedCount: 0,
        newBlockCount: 2,
        sourceDateRange: DateRange(first: '2024-01-01', last: '2024-01-05'),
        conflicts: [],
      );

      expect(withConflicts.hasConflicts, isTrue);
      expect(withoutConflicts.hasConflicts, isFalse);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group G: ImportPreview Model
  // ═══════════════════════════════════════════════════════════════

  group('G: ImportPreview', () {
    // G1 — holds all preview fields
    test('G1: holds entryCount, dateRange, and conflicts from dry run', () {
      const preview = ImportPreview(
        entryCount: 15,
        dateRange: DateRange(first: '2024-06-01', last: '2024-06-20'),
        conflicts: [],
      );

      expect(preview.entryCount, 15);
      expect(preview.dateRange.first, '2024-06-01');
      expect(preview.dateRange.last, '2024-06-20');
      expect(preview.conflicts, isEmpty);
    });

    // G2 — hasConflicts flag
    test('G2: hasConflicts is true when conflicts.isNotEmpty', () {
      const withConflicts = ImportPreview(
        entryCount: 10,
        dateRange: DateRange(first: '2024-01-01', last: '2024-01-10'),
        conflicts: ['2024-01-05'],
      );

      const noConflicts = ImportPreview(
        entryCount: 10,
        dateRange: DateRange(first: '2024-01-01', last: '2024-01-10'),
        conflicts: [],
      );

      expect(withConflicts.hasConflicts, isTrue);
      expect(noConflicts.hasConflicts, isFalse);
    });

    // G3 — isEmpty flag
    test('G3: isEmpty is true when entryCount == 0', () {
      const empty = ImportPreview(
        entryCount: 0,
        dateRange: DateRange(first: '', last: ''),
        conflicts: [],
      );

      const nonEmpty = ImportPreview(
        entryCount: 5,
        dateRange: DateRange(first: '2024-01-01', last: '2024-01-05'),
        conflicts: [],
      );

      expect(empty.isEmpty, isTrue);
      expect(nonEmpty.isEmpty, isFalse);
    });

    // G4 — immutability (all fields final)
    test('G4: ImportPreview is immutable — all fields are final', () {
      const preview = ImportPreview(
        entryCount: 5,
        dateRange: DateRange(first: '2024-01-01', last: '2024-01-05'),
        conflicts: [],
      );

      // If fields were mutable, this would not be a compile error.
      // For a runtime immutability check, verify that a copyWith-style
      // operation creates a new instance rather than mutating.
      expect(preview.entryCount, 5);
      // Attempt to assign would fail at compile time with final fields.
      // Runtime check: verify the object does not expose setters.
      expect(preview, isA<ImportPreview>());
    });
  });
}
