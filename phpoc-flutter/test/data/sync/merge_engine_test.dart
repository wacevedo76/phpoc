import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/entry.dart';
import 'package:phpoc_flutter/data/sync/merge_engine.dart';

/// MergeEngine tests — Group C (8 assertions).
///
/// Covers:
///   C1: Identical entries dedup → remote wins
///   C2: entry_id match → remote wins
///   C3: title+start_epoch match (no entry_id) → dedup
///   C4: Local-only entry preserved
///   C5: Remote-only entry added
///   C6: Disjoint local + remote → union
///   C7: Result sorted by start_epoch ascending
///   C8: committed=true preserved across merge

Entry _makeEntry({
  required String entryId,
  required String title,
  required int startEpoch,
  int? endEpoch,
  bool committed = false,
  String deviceUuid = 'dev-a',
}) {
  return Entry(
    entryId: entryId,
    title: title,
    startEpoch: startEpoch,
    endEpoch: endEpoch,
    isActive: endEpoch == null,
    committed: committed,
    deviceUuid: deviceUuid,
  );
}

void main() {
  group('C: MergeEngine', () {
    // C1
    test('C1: identical entries in both → one copy, remote source', () {
      final local = [
        _makeEntry(entryId: 'e1', title: 'Task', startEpoch: 1000),
      ];
      final remote = [
        _makeEntry(entryId: 'e1', title: 'Task', startEpoch: 1000),
      ];

      final result = MergeEngine.merge(local, remote);

      expect(result.length, 1);
      expect(result[0].entryId, 'e1');
      // The merge engine should mark remote source (contract: remote wins)
    });

    // C2
    test('C2: entry_id match → remote wins', () {
      final local = [
        _makeEntry(entryId: 'e1', title: 'Local Title', startEpoch: 1000),
      ];
      final remote = [
        _makeEntry(entryId: 'e1', title: 'Remote Title', startEpoch: 2000),
      ];

      final result = MergeEngine.merge(local, remote);

      expect(result.length, 1);
      expect(result[0].title, 'Remote Title');
      expect(result[0].startEpoch, 2000);
    });

    // C3
    test('C3: title+start_epoch match without entry_id → dedup', () {
      // Entries created before entry_id convention (empty entry_id fallback)
      final local = [
        Entry(entryId: '', title: 'Task', startEpoch: 1000),
      ];
      final remote = [
        Entry(entryId: '', title: 'Task', startEpoch: 1000),
      ];

      final result = MergeEngine.merge(local, remote);

      expect(result.length, 1);
    });

    // C4
    test('C4: local-only entry preserved in merged result', () {
      final local = [
        _makeEntry(entryId: 'local-1', title: 'Local Only', startEpoch: 1000),
      ];
      final remote = <Entry>[];

      final result = MergeEngine.merge(local, remote);

      expect(result.length, 1);
      expect(result[0].entryId, 'local-1');
    });

    // C5
    test('C5: remote-only entry added to merged result', () {
      final local = <Entry>[];
      final remote = [
        _makeEntry(entryId: 'remote-1', title: 'Remote Only', startEpoch: 2000),
      ];

      final result = MergeEngine.merge(local, remote);

      expect(result.length, 1);
      expect(result[0].entryId, 'remote-1');
    });

    // C6
    test('C6: disjoint local + remote → merged has all entries', () {
      final local = [
        _makeEntry(entryId: 'a', title: 'Alpha', startEpoch: 1000),
        _makeEntry(entryId: 'c', title: 'Charlie', startEpoch: 3000),
      ];
      final remote = [
        _makeEntry(entryId: 'b', title: 'Beta', startEpoch: 2000),
        _makeEntry(entryId: 'd', title: 'Delta', startEpoch: 4000),
      ];

      final result = MergeEngine.merge(local, remote);

      expect(result.length, 4);
      expect(result.map((e) => e.entryId).toSet(),
          {'a', 'b', 'c', 'd'});
    });

    // C7
    test('C7: merged result sorted by start_epoch ascending', () {
      final local = [
        _makeEntry(entryId: 'd', title: 'D', startEpoch: 4000),
        _makeEntry(entryId: 'b', title: 'B', startEpoch: 2000),
      ];
      final remote = [
        _makeEntry(entryId: 'a', title: 'A', startEpoch: 1000),
        _makeEntry(entryId: 'c', title: 'C', startEpoch: 3000),
      ];

      final result = MergeEngine.merge(local, remote);

      expect(result.length, 4);
      for (var i = 1; i < result.length; i++) {
        expect(result[i].startEpoch, greaterThanOrEqualTo(result[i - 1].startEpoch));
      }
      expect(result.map((e) => e.entryId).toList(), ['a', 'b', 'c', 'd']);
    });

    // C8
    test('C8: committed=true preserved across merge (irreversible)', () {
      final local = [
        _makeEntry(
          entryId: 'e1', title: 'Committed', startEpoch: 1000,
          committed: true,
        ),
      ];
      final remote = [
        _makeEntry(
          entryId: 'e1', title: 'Committed', startEpoch: 1000,
          committed: false, // stale remote doesn't know it was committed yet
        ),
      ];

      final result = MergeEngine.merge(local, remote);

      expect(result.length, 1);
      expect(result[0].committed, true,
          reason: 'committed=true must be preserved — cannot be downgraded by stale remote');
    });
  });
}
