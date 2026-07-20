import '../../core/models/entry.dart';

/// Cross-device entry merge — dedup by entry_id.
///
/// Port of web src/sync/merge_engine.js.
/// Remote entries win on conflict (remote is the "source of truth" for
/// entries that exist on both sides).
///
/// TODO: Full implementation — currently stub.
class MergeEngine {
  /// Merge local and remote staging entries. Returns the merged list.
  List<Entry> merge(List<Entry> local, List<Entry> remote) {
    final merged = <String, Entry>{};

    // Local entries first
    for (final e in local) {
      merged[e.entryId] = e;
    }

    // Remote entries override on conflict
    for (final e in remote) {
      merged[e.entryId] = e;
    }

    return merged.values.toList();
  }
}
