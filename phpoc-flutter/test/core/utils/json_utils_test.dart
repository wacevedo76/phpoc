import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';

void main() {
  // ── Group H: JSON Canonical Sort ────────────────────────────

  group('jsonSort', () {
    // H1 — Simple object: keys sorted alphabetically
    test('H1: keys sorted alphabetically', () {
      const data = {'z': 1, 'a': 2, 'm': 3};
      final result = jsonSort(data);
      // 'a' should appear before 'm', which should appear before 'z'
      final aPos = result.indexOf('"a"');
      final mPos = result.indexOf('"m"');
      final zPos = result.indexOf('"z"');
      expect(aPos, lessThan(mPos));
      expect(mPos, lessThan(zPos));
    });

    // H2 — Nested object: keys sorted at all levels
    test('H2: nested keys sorted at all levels', () {
      const data = {
        'z': {'c': 1, 'a': 2},
        'a': 1,
      };
      final result = jsonSort(data);
      // Top-level: "a" before "z"
      expect(result.indexOf('"a"'), lessThan(result.indexOf('"z"')));
      // Nested: "a" before "c"
      final nestedA = result.indexOf('"a"', result.indexOf('"z"'));
      final nestedC = result.indexOf('"c"', result.indexOf('"z"'));
      expect(nestedA, lessThan(nestedC));
    });

    // H3 — Array: elements in order, not sorted
    test('H3: arrays preserve element order', () {
      const data = {'items': ['z', 'a', 'm']};
      final result = jsonSort(data);
      // Elements must appear in original order
      final zPos = result.indexOf('"z"');
      final aPos = result.indexOf('"a"');
      final mPos = result.indexOf('"m"');
      expect(zPos, lessThan(aPos));
      expect(aPos, lessThan(mPos));
    });

    // H4 — Undefined values are skipped
    test('H4: keys with null values are preserved', () {
      const data = {'a': 1, 'b': null};
      final result = jsonSort(data);
      expect(result, contains('"b"'));
      expect(result, contains('null'));
    });

    // H5 — Cross-client: Dart jsonSort matches web output
    test('H5: jsonSort matches web output byte-for-byte', () {
      const data = {
        'entry_id': 'test-1',
        'title': 'Hello',
        'start_epoch': 1700000000000,
      };
      // Expected output from web's jsonSort (verified 2026-07-17).
      const expectedWeb =
          '{"entry_id": "test-1", "start_epoch": 1700000000000, "title": "Hello"}';
      final dartOutput = jsonSort(data);
      expect(dartOutput, expectedWeb);
    });

    // H9 — null → "null"
    test('H9: null serialized as null', () {
      expect(jsonSort(null), 'null');
    });

    // H10 — booleans
    test('H10: boolean serialized correctly', () {
      expect(jsonSort(true), 'true');
      expect(jsonSort(false), 'false');
    });

    // H11 — empty object → "{}"
    test('H11: empty object', () {
      expect(jsonSort({}), '{}');
    });

    // H12 — empty array → "[]"
    test('H12: empty array', () {
      expect(jsonSort([]), '[]');
    });
  });

  group('jsonSortIndent2', () {
    // H6 — 2-space indented output
    test('H6: produces 2-space indented output', () {
      const data = {'a': 1, 'b': 2};
      final result = jsonSortIndent2(data);
      expect(result, contains('  ')); // has indentation
      expect(result, contains('\n')); // has newlines
    });

    // H7 — Nested object: correct indentation at depth
    test('H7: nested objects indented correctly', () {
      const data = {
        'outer': {'inner': 'value'},
      };
      final result = jsonSortIndent2(data);
      // inner should be indented more than outer
      final lines = result.split('\n');
      final innerLine = lines.firstWhere((l) => l.contains('"inner"'));
      final outerLine = lines.firstWhere((l) => l.contains('"outer"'));
      expect(innerLine.indexOf('"inner"'),
          greaterThan(outerLine.indexOf('"outer"')));
    });

    // H8 — Cross-client: Dart jsonSortIndent2 matches web output
    test('H8: jsonSortIndent2 matches web output byte-for-byte', () {
      const data = {
        'entry_id': 'test-2',
        'title': 'World',
      };
      // Expected output from web's jsonSortIndent2 (verified 2026-07-17).
      const expectedWeb =
          '{\n  "entry_id": "test-2",\n  "title": "World"\n}';
      final dartOutput = jsonSortIndent2(data);
      expect(dartOutput, expectedWeb);
    });
  });
}
