import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'staging_store.dart';

/// Result of comparing two staging hash indexes.
class StagingHashDiff {
  final bool identical;
  final List<String> added;
  final List<String> removed;
  final List<String> changed;

  const StagingHashDiff({
    required this.identical,
    required this.added,
    required this.removed,
    required this.changed,
  });
}

/// Tier-1 fast-path staging comparison via hash index.
///
/// Port of web `src/sync/staging_hash_index.js`.
///
/// Builds a compact `[{activity_id, activity_status}, ...]` index
/// from the staging store, computes a SHA-256 hash for integrity,
/// and compares local and remote indexes to produce a diff.
class StagingHashIndex {
  /// Build a hash index array from all rows in [store].
  static Future<List<Map<String, dynamic>>> build(StagingStore store) async {
    final rows = await store.getAllRows();
    return rows.map((row) {
      return {
        'activity_id': row['activity_id'] as String,
        'activity_status': row['activity_status'] as String,
      };
    }).toList();
  }

  /// Compute a deterministic SHA-256 hex digest of [index].
  static String computeHash(List<Map<String, dynamic>> index) {
    // Sort by activity_id for determinism
    final sorted = List<Map<String, dynamic>>.from(index);
    sorted.sort((a, b) {
      return (a['activity_id'] as String).compareTo(b['activity_id'] as String);
    });
    final jsonStr = json.encode(sorted);
    final bytes = utf8.encode(jsonStr);
    final digest = sha256.convert(bytes);
    return digest.toString();
  }

  /// Compare [local] and [remote] hash indexes.
  ///
  /// Returns a [StagingHashDiff] with the sets of added, removed, and
  /// changed activity_ids. When both indexes have identical entries
  /// (same activity_id + activity_status pairs), `identical` is true.
  ///
  /// When [remote] is empty, all local entries are treated as "added"
  /// (bootstrap case — first push).
  static StagingHashDiff compare(
    List<Map<String, dynamic>> local,
    List<Map<String, dynamic>> remote,
  ) {
    // Bootstrap: no remote → all local entries are "added"
    if (remote.isEmpty) {
      final added = local
          .map((e) => e['activity_id'] as String)
          .toList()
        ..sort();
      return StagingHashDiff(
        identical: false,
        added: added,
        removed: [],
        changed: [],
      );
    }

    // Build lookup maps: activity_id → activity_status
    final localMap = <String, String>{};
    for (final entry in local) {
      localMap[entry['activity_id'] as String] =
          entry['activity_status'] as String;
    }
    final remoteMap = <String, String>{};
    for (final entry in remote) {
      remoteMap[entry['activity_id'] as String] =
          entry['activity_status'] as String;
    }

    final added = <String>[];
    final removed = <String>[];
    final changed = <String>[];

    // Find added + changed (in remote, not local or different status)
    for (final id in remoteMap.keys) {
      if (!localMap.containsKey(id)) {
        added.add(id);
      } else if (localMap[id] != remoteMap[id]) {
        changed.add(id);
      }
    }

    // Find removed (in local, not remote)
    for (final id in localMap.keys) {
      if (!remoteMap.containsKey(id)) {
        removed.add(id);
      }
    }

    // Sort for deterministic output
    added.sort();
    removed.sort();
    changed.sort();

    final identical = added.isEmpty && removed.isEmpty && changed.isEmpty;

    return StagingHashDiff(
      identical: identical,
      added: added,
      removed: removed,
      changed: changed,
    );
  }
}
