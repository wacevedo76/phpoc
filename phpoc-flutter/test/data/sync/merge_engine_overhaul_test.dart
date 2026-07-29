import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/sync/merge_engine.dart';

/// Merge engine overhaul tests — Group J (6 assertions).
///
/// Covers activity_id-based merge with LWW on updated_at:
///   J1: mergeEntries uses activity_id as merge key
///   J2: remote newer wins for same activity_id (LWW on updated_at)
///   J3: local newer wins for same activity_id (LWW on updated_at)
///   J4: remote-only activity_id → added to local
///   J5: local-only + committed → removed from local
///   J6: local-only + not committed → kept in local

/// Helpers to build entry maps with activity_id and updated_at.
Map<String, dynamic> _entry({
  required String activityId,
  required String title,
  String status = 'active',
  int updatedAt = 1000,
  bool committed = false,
}) {
  return {
    'activity_id': activityId,
    'activity_status': status,
    'activity': '{"title":"$title"}',
    'updated_at': updatedAt,
    'title': title,
    'committed': committed,
  };
}

void main() {
  group('J: MergeEngine — activity_id LWW merge', () {
    // J1
    test('J1: mergeEntries uses activity_id as merge key', () {
      final local = [
        _entry(activityId: 'abc111XYZ9', title: 'Local Task'),
      ];
      final remote = [
        _entry(activityId: 'abc111XYZ9', title: 'Remote Task', updatedAt: 2000),
      ];

      final result = MergeEngine.mergeEntries(local, remote);

      expect(result.length, 1);
      expect(result[0]['activity_id'], 'abc111XYZ9');
      // Remote should win (newer updated_at)
      expect(result[0]['title'], 'Remote Task');
    });

    // J2
    test('J2: remote newer wins for same activity_id (LWW on updated_at)', () {
      final local = [
        _entry(activityId: 'idA', title: 'Local', updatedAt: 1000),
      ];
      final remote = [
        _entry(activityId: 'idA', title: 'Remote', updatedAt: 2000),
      ];

      final result = MergeEngine.mergeEntries(local, remote);

      expect(result.length, 1);
      expect(result[0]['title'], 'Remote');
      expect(result[0]['updated_at'], 2000);
    });

    // J3
    test('J3: local newer wins for same activity_id (LWW on updated_at)', () {
      final local = [
        _entry(activityId: 'idB', title: 'Local Newer', updatedAt: 5000),
      ];
      final remote = [
        _entry(activityId: 'idB', title: 'Remote Older', updatedAt: 3000),
      ];

      final result = MergeEngine.mergeEntries(local, remote);

      expect(result.length, 1);
      expect(result[0]['title'], 'Local Newer');
      expect(result[0]['updated_at'], 5000);
    });

    // J4
    test('J4: remote-only activity_id → added to local', () {
      final local = <Map<String, dynamic>>[];
      final remote = [
        _entry(activityId: 'remoteOnly', title: 'From Remote', updatedAt: 1000),
      ];

      final result = MergeEngine.mergeEntries(local, remote);

      expect(result.length, 1);
      expect(result[0]['activity_id'], 'remoteOnly');
    });

    // J5
    test('J5: local-only + committed → removed from local (cleanup)', () {
      final local = [
        _entry(activityId: 'committed1', title: 'Done', committed: true),
      ];
      final remote = <Map<String, dynamic>>[];

      final result = MergeEngine.mergeEntries(local, remote);

      // Committed entries with no remote counterpart should be removed
      expect(result.where((e) => e['activity_id'] == 'committed1'), isEmpty,
          reason: 'Locally committed entries not present remotely should be cleaned up');
    });

    // J6
    test('J6: local-only + not committed → kept in local', () {
      final local = [
        _entry(activityId: 'pending1', title: 'Still Active', committed: false),
      ];
      final remote = <Map<String, dynamic>>[];

      final result = MergeEngine.mergeEntries(local, remote);

      expect(result.length, 1);
      expect(result[0]['activity_id'], 'pending1');
      expect(result[0]['committed'], false);
    });

    test('J: mergeEntries handles ties on updated_at (local wins)', () {
      final local = [
        _entry(activityId: 'tie1', title: 'Local Tie', updatedAt: 1000),
      ];
      final remote = [
        _entry(activityId: 'tie1', title: 'Remote Tie', updatedAt: 1000),
      ];

      final result = MergeEngine.mergeEntries(local, remote);

      expect(result.length, 1);
      // On tie, local wins (deterministic tie-break per B-04)
      expect(result[0]['title'], 'Local Tie');
    });
  });
}
