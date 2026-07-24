import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/utils/format_utils.dart';

/// FormatUtils date helper tests — Group K (4 assertions).
///
/// Covers:
///   K1–K4: epochToDateStr() — ms-to-date-string conversion

void main() {
  group('K: FormatUtils — Date helpers', () {
    // K1
    test('K1: epochToDateStr(0) returns "1970-01-01"', () {
      final result = FormatUtils.epochToDateStr(0);
      expect(result, '1970-01-01',
          reason: 'Zero epoch must produce a sentinel date, not throw or return '
              'empty string');
    });

    // K2
    test('K2: epochToDateStr(1780272000000) returns "2026-06-01"', () {
      // 1780272000000 ms = 2026-06-01 00:00:00 UTC
      final result = FormatUtils.epochToDateStr(1780272000000);
      expect(result, '2026-06-01',
          reason: 'Must correctly convert ms epoch to YYYY-MM-DD format');
    });

    // K3
    test('K3: epochToDateStr(null) returns "unknown"', () {
      // Null-safety: passing null (or 0) must not crash
      final result = FormatUtils.epochToDateStr(null);
      expect(result, 'unknown',
          reason: 'Null epoch must return a safe fallback, not throw');
    });

    // K4
    test('K4: multiple epochs on same date produce same string', () {
      // All ms values within 2026-06-01 UTC should map to "2026-06-01"
      final a = FormatUtils.epochToDateStr(1780272000000); // midnight UTC
      final b = FormatUtils.epochToDateStr(1780358399999); // 23:59:59.999 UTC

      expect(a, b,
          reason: 'All epochs on the same calendar date must produce identical '
              'date strings so group-by works correctly');
      expect(a, '2026-06-01');
    });
  });
}
