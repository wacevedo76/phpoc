import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/entry.dart';

void main() {
  // ── Group A: Entry ───────────────────────────────────────────

  group('Entry', () {
    const testEntry = Entry(
      entryId: 'test-uuid-001',
      title: 'Coding session',
      startEpoch: 1700000000000,
    );

    const fullEntry = Entry(
      entryId: 'test-uuid-002',
      title: 'Design review',
      startEpoch: 1700000000000,
      endEpoch: 1700003600000,
      isActive: false,
      committed: true,
      tags: ['work', 'design'],
      pauses: [
        PauseRecord(startEpoch: 1700001000000, endEpoch: 1700001200000),
      ],
      metadataEnc: 'eyJrZXkiOiAidmFsdWUifQ==',
      deviceUuid: 'device-abc',
      contentHash: 'abc123def456',
    );

    // A1 — Construct with required fields
    test('A1: construct with required fields', () {
      expect(testEntry.entryId, 'test-uuid-001');
      expect(testEntry.title, 'Coding session');
      expect(testEntry.startEpoch, 1700000000000);
    });

    // A2 — Construct with all optional fields
    test('A2: construct with all optional fields', () {
      expect(fullEntry.endEpoch, 1700003600000);
      expect(fullEntry.isActive, false);
      expect(fullEntry.committed, true);
      expect(fullEntry.tags, ['work', 'design']);
      expect(fullEntry.pauses, hasLength(1));
      expect(fullEntry.metadataEnc, 'eyJrZXkiOiAidmFsdWUifQ==');
      expect(fullEntry.deviceUuid, 'device-abc');
      expect(fullEntry.contentHash, 'abc123def456');
    });

    // A3 — durationMs for completed entry with no pauses
    test('A3: durationMs returns end-start for completed entry', () {
      const entry = Entry(
        entryId: 'dur-test',
        title: 'Test',
        startEpoch: 1700000000000,
        endEpoch: 1700003600000,
      );
      expect(entry.durationMs, 3600000); // 1 hour
    });

    // A4 — durationMs accounts for pauses
    test('A4: durationMs subtracts pause durations', () {
      // 1 hour total, 200s pause → 3400s = 3,400,000ms
      expect(fullEntry.durationMs, 3400000);
    });

    // A5 — durationMs returns 0 when endEpoch is null
    test('A5: durationMs is 0 for active entry', () {
      expect(testEntry.durationMs, 0);
    });

    // A6 — durationMs clamps negative to 0
    test('A6: durationMs clamps negative to 0', () {
      const entry = Entry(
        entryId: 'neg-dur',
        title: 'Bad data',
        startEpoch: 1700003600000,
        endEpoch: 1700000000000, // end before start
        pauses: [
          PauseRecord(startEpoch: 1700001000000, endEpoch: 1700005000000),
        ],
      );
      expect(entry.durationMs, 0);
    });

    // A7 — durationMs returns 0 when start == end
    test('A7: durationMs is 0 for zero-length entry', () {
      const entry = Entry(
        entryId: 'zero-dur',
        title: 'Instant',
        startEpoch: 1700000000000,
        endEpoch: 1700000000000,
      );
      expect(entry.durationMs, 0);
    });

    // A8 — copyWith creates independent copy with single field change
    test('A8: copyWith changes specified field', () {
      final copy = testEntry.copyWith(title: 'Updated title');
      expect(copy.title, 'Updated title');
      expect(copy.entryId, testEntry.entryId); // unchanged
    });

    // A9 — copyWith preserves all unspecified fields
    test('A9: copyWith preserves unspecified fields', () {
      final copy = fullEntry.copyWith(title: 'New title');
      expect(copy.entryId, fullEntry.entryId);
      expect(copy.startEpoch, fullEntry.startEpoch);
      expect(copy.endEpoch, fullEntry.endEpoch);
      expect(copy.tags, fullEntry.tags);
      expect(copy.pauses, fullEntry.pauses);
    });

    // A10 — original Entry unchanged after copyWith
    test('A10: original unchanged after copyWith', () {
      final originalTitle = fullEntry.title;
      fullEntry.copyWith(title: 'Something else');
      expect(fullEntry.title, originalTitle);
    });

    // A11 — Two Entries with identical fields are equal
    test('A11: identical entries are equal', () {
      const a = Entry(entryId: 'e1', title: 'X', startEpoch: 100);
      const b = Entry(entryId: 'e1', title: 'X', startEpoch: 100);
      expect(a, b);
    });

    // A12 — Different entryId → not equal
    test('A12: different entryId are not equal', () {
      const a = Entry(entryId: 'e1', title: 'X', startEpoch: 100);
      const b = Entry(entryId: 'e2', title: 'X', startEpoch: 100);
      expect(a, isNot(b));
    });

    // A13 — Different tags → not equal
    test('A13: different tags are not equal', () {
      const a = Entry(
        entryId: 'e1', title: 'X', startEpoch: 100,
        tags: ['a'],
      );
      const b = Entry(
        entryId: 'e1', title: 'X', startEpoch: 100,
        tags: ['b'],
      );
      expect(a, isNot(b));
    });

    // A14 — JSON roundtrip
    test('A14: toJson → fromJson roundtrip is equal', () {
      final json = fullEntry.toJson();
      final restored = Entry.fromJson(json);
      expect(restored, fullEntry);
    });

    // A15 — JSON roundtrip preserves null endEpoch
    test('A15: JSON roundtrip with null endEpoch', () {
      final json = testEntry.toJson();
      final restored = Entry.fromJson(json);
      expect(restored.endEpoch, isNull);
      expect(restored, testEntry);
    });

    // A16 — JSON roundtrip preserves multiple pauses
    test('A16: JSON roundtrip with multiple pauses', () {
      const entry = Entry(
        entryId: 'multi-pause',
        title: 'Paused task',
        startEpoch: 1700000000000,
        pauses: [
          PauseRecord(startEpoch: 100, endEpoch: 200),
          PauseRecord(startEpoch: 300, endEpoch: 400),
        ],
      );
      final restored = Entry.fromJson(entry.toJson());
      expect(restored.pauses, hasLength(2));
      expect(restored, entry);
    });

    // A17 — tags list is immutable
    test('A17: tags list is immutable', () {
      expect(
        () => fullEntry.tags.add('new-tag'),
        throwsA(anything),
      );
    });

    // A18 — pauses list is immutable
    test('A18: pauses list is immutable', () {
      expect(
        () => fullEntry.pauses.add(
          const PauseRecord(startEpoch: 100),
        ),
        throwsA(anything),
      );
    });

    // A19 — isActive defaults to true
    test('A19: isActive defaults to true', () {
      expect(testEntry.isActive, true);
    });

    // A20 — committed defaults to false
    test('A20: committed defaults to false', () {
      expect(testEntry.committed, false);
    });

    // A21 — tags defaults to empty list
    test('A21: tags defaults to empty list', () {
      expect(testEntry.tags, isEmpty);
    });
  });

  // ── Group B: PauseRecord ─────────────────────────────────────

  group('PauseRecord', () {
    // B1 — Construct with required fields
    test('B1: construct with startEpoch only', () {
      const pause = PauseRecord(startEpoch: 1700001000000);
      expect(pause.startEpoch, 1700001000000);
      expect(pause.endEpoch, isNull);
    });

    // B2 — Construct with endEpoch
    test('B2: construct with endEpoch', () {
      const pause = PauseRecord(
        startEpoch: 1700001000000,
        endEpoch: 1700001200000,
      );
      expect(pause.endEpoch, 1700001200000);
    });

    // B3 — durationMs when both set
    test('B3: durationMs for completed pause', () {
      const pause = PauseRecord(
        startEpoch: 1700001000000,
        endEpoch: 1700001200000,
      );
      expect(pause.durationMs, 200000);
    });

    // B4 — durationMs when endEpoch is null
    test('B4: durationMs is 0 for open pause', () {
      const pause = PauseRecord(startEpoch: 1700001000000);
      expect(pause.durationMs, 0);
    });

    // B5 — isOpen when endEpoch is null
    test('B5: isOpen is true when endEpoch is null', () {
      const pause = PauseRecord(startEpoch: 1700001000000);
      expect(pause.isOpen, true);
    });

    // B6 — isOpen when endEpoch is set
    test('B6: isOpen is false when endEpoch is set', () {
      const pause = PauseRecord(
        startEpoch: 1700001000000,
        endEpoch: 1700001200000,
      );
      expect(pause.isOpen, false);
    });

    // B7 — Two PauseRecords with same fields are equal
    test('B7: identical pauses are equal', () {
      const a = PauseRecord(startEpoch: 100, endEpoch: 200);
      const b = PauseRecord(startEpoch: 100, endEpoch: 200);
      expect(a, b);
    });

    // B8 — JSON roundtrip
    test('B8: toJson → fromJson roundtrip is equal', () {
      const pause = PauseRecord(startEpoch: 100, endEpoch: 200);
      final restored = PauseRecord.fromJson(pause.toJson());
      expect(restored, pause);
    });
  });
}
