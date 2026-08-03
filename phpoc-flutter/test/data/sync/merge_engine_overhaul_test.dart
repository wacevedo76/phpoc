import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/sync/merge_engine.dart';

/// Merge engine overhaul tests — Group J (6 assertions).
///
/// Covers activity_id-based merge with LWW on updated_at:
///   J1: mergeEntries uses activity_id as merge key
///   J2: remote newer wins for same activity_id (LWW on updated_at)
///   J3: local newer wins for same activity_id (LWW on updated_at)
///   J4: remote-only activity_id → added to local
///   J5: local-only + committed → kept in result (History display)
///   J6: local-only + not committed → kept in local
///   J7: _isCommitted fallback — committed inside activity JSON blob only
///   J8: committed irreversible — local committed + remote newer → committed
///   J9: committed irreversible — remote committed + local newer → committed

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
    test('J5: local-only + committed → kept in result (History display)', () {
      final local = [
        _entry(activityId: 'committed1', title: 'Done', committed: true),
      ];
      final remote = <Map<String, dynamic>>[];

      final result = MergeEngine.mergeEntries(local, remote);

      // Committed entries stay in staging for History/Dashboard display;
      // the Sync tab filters them out via the committed flag.
      expect(result.length, 1);
      expect(result[0]['activity_id'], 'committed1');
      expect(result[0]['committed'], true,
          reason: 'Committed flag must be preserved for display filtering');
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

    // J7
    test('J7: _isCommitted detects flag inside activity JSON blob '
        '(row-level fallback)', () {
      // Simulate an entry seeded by the old _seedStagingFromBlocks:
      // committed=true is ONLY in the activity JSON blob, NOT at row level.
      final local = [
        {
          'activity_id': 'blobOnly',
          'activity_status': 'ended',
          'activity': '{"title":"Done","committed":true}',
          'updated_at': 1000,
          // Note: NO 'committed' at row level
        },
      ];
      final remote = <Map<String, dynamic>>[];

      final result = MergeEngine.mergeEntries(local, remote);

      // Entry must be kept (committed stays for History display)
      expect(result.length, 1);
      expect(result[0]['activity_id'], 'blobOnly');
      // Committed must be detected from the activity blob
      expect(result[0]['committed'], true,
          reason: 'Committed flag in activity JSON blob must be recognised');
    });

    // J8
    test('J8: committed flag irreversible — local committed + remote '
        'newer updated_at → winner stays committed', () {
      // Local entry was committed, remote has newer updated_at but no
      // committed flag. The merged entry must preserve committed=true.
      final local = [
        _entry(
          activityId: 'keepCommitted',
          title: 'Local Committed',
          updatedAt: 1000,
          committed: true,
        ),
      ];
      final remote = [
        _entry(
          activityId: 'keepCommitted',
          title: 'Remote Newer',
          updatedAt: 5000,
          committed: false,
        ),
      ];

      final result = MergeEngine.mergeEntries(local, remote);

      expect(result.length, 1);
      // Remote newer wins on updated_at (LWW)
      expect(result[0]['title'], 'Remote Newer');
      expect(result[0]['updated_at'], 5000);
      // But committed must be true — irreversible, cannot be downgraded
      expect(result[0]['committed'], true,
          reason: 'Once committed, cannot be downgraded by stale remote');
    });

    // J9
    test('J9: committed flag irreversible — remote committed + local '
        'newer updated_at → winner stays committed', () {
      // Remote entry was committed, local has newer updated_at.
      // Local wins LWW but gets promoted to committed.
      final local = [
        _entry(
          activityId: 'remoteCommitted',
          title: 'Local Newer',
          updatedAt: 9000,
          committed: false,
        ),
      ];
      final remote = [
        {
          'activity_id': 'remoteCommitted',
          'activity_status': 'ended',
          'activity': '{"title":"Remote Committed","committed":true}',
          'updated_at': 1000,
          // Committed only in activity blob (simulates cross-device propagation)
        },
      ];

      final result = MergeEngine.mergeEntries(local, remote);

      expect(result.length, 1);
      expect(result[0]['title'], 'Local Newer');
      expect(result[0]['updated_at'], 9000);
      // Committed must be true — remote's committed flag is irreversible
      expect(result[0]['committed'], true,
          reason: 'Remote committed entry must propagate committed flag '
              'even when local data wins');
    });
  });
}
