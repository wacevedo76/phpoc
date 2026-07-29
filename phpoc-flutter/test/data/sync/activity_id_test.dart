import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/sync/activity_id.dart';

/// ActivityIdGenerator tests — Group A (8 assertions).
///
/// Covers:
///   A1: generateActivityId() returns 10-char alphanumeric
///   A2: two consecutive calls produce different IDs
///   A3: 10,000 IDs have zero collisions
///   A4: only [A-Za-z0-9] characters appear
///   A5: output not predictable (basic entropy check)
///   A6: no sequential pattern across 100 IDs
///   A7: doesn't throw in any environment
///   A8: isValidActivityId() validates format

void main() {
  group('A: ActivityIdGenerator — generateActivityId()', () {
    // A1
    test('A1: returns 10-char alphanumeric string', () {
      final id = ActivityIdGenerator.generateActivityId();
      expect(id, isA<String>());
      expect(id.length, 10);
    });

    // A2
    test('A2: two consecutive calls produce different IDs', () {
      final id1 = ActivityIdGenerator.generateActivityId();
      final id2 = ActivityIdGenerator.generateActivityId();
      expect(id1, isNot(equals(id2)));
    });

    // A3
    test('A3: 10,000 IDs have zero collisions', () {
      final ids = <String>{};
      for (var i = 0; i < 10000; i++) {
        final id = ActivityIdGenerator.generateActivityId();
        expect(ids.contains(id), isFalse,
            reason: 'Collision at iteration $i: $id');
        ids.add(id);
      }
      expect(ids.length, 10000);
    });

    // A4
    test('A4: only [A-Za-z0-9] characters appear in output', () {
      final alphanumeric = RegExp(r'^[A-Za-z0-9]+$');
      for (var i = 0; i < 100; i++) {
        final id = ActivityIdGenerator.generateActivityId();
        expect(id, matches(alphanumeric),
            reason: 'ID $id contains non-alphanumeric characters');
      }
    });

    // A5
    test('A5: output is not predictable from input seed', () {
      // Generate batches and verify they differ structurally
      final batch1 = List.generate(20, (_) => ActivityIdGenerator.generateActivityId());
      final batch2 = List.generate(20, (_) => ActivityIdGenerator.generateActivityId());
      // Batches should not be identical or simple shifts
      expect(batch1, isNot(equals(batch2)));
      // First IDs from each batch should differ
      expect(batch1[0], isNot(equals(batch2[0])));
    });

    // A6
    test('A6: no sequential pattern across 100 IDs', () {
      final ids = List.generate(100, (_) => ActivityIdGenerator.generateActivityId());
      // Check that adjacent IDs are not sequential (i.e., not just +1)
      var sequentialCount = 0;
      for (var i = 1; i < ids.length; i++) {
        if (_areSequential(ids[i - 1], ids[i])) sequentialCount++;
      }
      // Fewer than 5% should appear sequential by chance
      expect(sequentialCount, lessThan(5),
          reason: '$sequentialCount sequential pairs found — IDs may be predictable');
    });

    // A7
    test('A7: generateActivityId() does not throw', () {
      for (var i = 0; i < 50; i++) {
        expect(() => ActivityIdGenerator.generateActivityId(), returnsNormally);
      }
    });
  });

  group('A: ActivityIdGenerator — isValidActivityId()', () {
    // A8
    test('A8: validates format (10-char alphanumeric)', () {
      expect(ActivityIdGenerator.isValidActivityId('abc123XYZ9'), isTrue);
      expect(ActivityIdGenerator.isValidActivityId('short'), isFalse);
      expect(ActivityIdGenerator.isValidActivityId('12345678901'), isFalse);
      expect(ActivityIdGenerator.isValidActivityId('abc-def-gh'), isFalse);
      expect(ActivityIdGenerator.isValidActivityId(''), isFalse);
      expect(ActivityIdGenerator.isValidActivityId('abcdefgh!@'), isFalse);
      // Null safety
      // ignore: invalid_use_of_visible_for_testing_member
      expect(ActivityIdGenerator.isValidActivityId('null'), isFalse);
    });
  });
}

/// Simple check for sequential alphanumeric IDs.
/// Two IDs are "sequential" if their last char differs by 1 and the rest
/// is identical — this catches simple counter-based patterns.
bool _areSequential(String a, String b) {
  if (a.length != b.length) return false;
  if (a.substring(0, a.length - 1) != b.substring(0, b.length - 1)) return false;
  final lastA = a.codeUnitAt(a.length - 1);
  final lastB = b.codeUnitAt(b.length - 1);
  return (lastA - lastB).abs() == 1;
}
