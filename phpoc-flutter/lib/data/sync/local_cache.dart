import '../../core/models/entry.dart';

/// Local staging cache — CRUD for pending entries.
///
/// Port of web src/sync/local_cache.js.
///
/// TODO: Full implementation — currently stub.
class LocalCache {
  final List<Entry> _entries = [];

  List<Entry> get entries => List.unmodifiable(_entries);

  Future<void> append(Entry entry) async {
    _entries.add(entry);
  }

  Future<void> update(String entryId, Entry updated) async {
    final idx = _entries.indexWhere((e) => e.entryId == entryId);
    if (idx >= 0) _entries[idx] = updated;
  }

  Future<void> remove(String entryId) async {
    _entries.removeWhere((e) => e.entryId == entryId);
  }

  Entry? findById(String entryId) {
    try {
      return _entries.firstWhere((e) => e.entryId == entryId);
    } catch (_) {
      return null;
    }
  }
}
