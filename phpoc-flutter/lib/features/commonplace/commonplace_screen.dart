import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show commonplaceServiceProvider;
import 'add_entry_bottom_sheet.dart';
import 'topic_index.dart';

/// The Commonplace Book dashboard surface (ADR-031).
///
/// Shown inside [BookSwitcher]'s shell when [Book.commonplace] is active.
/// Lists committed passages (title + expanding passage), renders a
/// decrypt-and-scan [TopicIndex] for tag filtering, a verification badge,
/// and an "Add entry" affordance that opens [AddEntryBottomSheet].
///
/// Add is **add-not-in-place** (D5): only an add affordance exists — there is
/// no in-place edit of a committed passage.
class CommonplaceScreen extends ConsumerStatefulWidget {
  const CommonplaceScreen({super.key});

  @override
  ConsumerState<CommonplaceScreen> createState() => _CommonplaceScreenState();
}

class _CommonplaceScreenState extends ConsumerState<CommonplaceScreen> {
  List<Map<String, dynamic>> _entries = [];
  String? _selectedTag;
  bool _loading = true;
  bool _expanded = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final service = ref.read(commonplaceServiceProvider);
      final entries = await service.readEntries();
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  bool get _verified {
    try {
      return ref.read(commonplaceServiceProvider).verify();
    } catch (_) {
      return false;
    }
  }

  Map<String, int> get _tagIndex {
    try {
      return ref.read(commonplaceServiceProvider).buildTagIndex();
    } catch (_) {
      return {};
    }
  }

  List<Map<String, dynamic>> get _filteredEntries {
    if (_selectedTag == null) return _entries;
    return _entries.where((e) {
      final tags = (e['tags'] as List<dynamic>? ?? const [])
          .map((t) => t.toString())
          .toList();
      if (_selectedTag == 'untagged') return tags.isEmpty;
      return tags.contains(_selectedTag);
    }).toList();
  }

  /// Ensure the Commonplace chain's genesis exists before the first add.
  ///
  /// This slice's genesis is bootstrapped **identityless**: the ledger's
  /// shared master key (ADR-031 — one seed → one MK → both books) is what
  /// roots and seals the chain, while the username/email/pubkey fields on the
  /// genesis are placeholders. They carry no device identity in the Commonplace
  /// book today, so empty strings are intentional (not a data-loss hole) — the
  /// chain's integrity and encryption are unaffected. If a later slice wires
  /// real Commonplace identity, replace these placeholders here and in
  /// [CommonplaceService.ensureGenesis] callers.
  Future<void> _ensureBookBootstrap() async {
    final service = ref.read(commonplaceServiceProvider);
    await service.ensureGenesis(
      username: 'user',
      email: '',
      recoverySeedEnc: '',
      identityPubKey: '',
      identitySecretEncFallback: '',
    );
  }

  Future<void> _openAddSheet() async {
    await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => AddEntryBottomSheet(
        onSubmit: ({required title, required entry, required tags, adHoc}) async {
          await _ensureBookBootstrap();
          final service = ref.read(commonplaceServiceProvider);
          await service.addEntry(
            title: title,
            entry: entry,
            tags: tags,
            adHoc: adHoc,
          );
          await _refresh();
          return true;
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final filtered = _filteredEntries;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Commonplace'),
        actions: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Center(
              child: Text('${_entries.length} entries',
                  style: TextStyle(color: scheme.onSurfaceVariant)),
            ),
          ),
          IconButton(
            tooltip: 'Add entry',
            icon: const Icon(Icons.add),
            onPressed: _openAddSheet,
          ),
        ],
      ),
      body: Column(
        children: [
          const SizedBox(height: 8),
          TopicIndex(
            tagIndex: _tagIndex,
            selectedTag: _selectedTag,
            onSelect: (tag) => setState(() => _selectedTag = tag),
          ),
          _verified
              ? Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Chip(
                    label: const Text('verified'),
                    backgroundColor: Colors.green.shade50,
                    side: BorderSide(color: Colors.green.shade200),
                  ),
                )
              : const SizedBox.shrink(),
          const Divider(height: 8),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : filtered.isEmpty
                    ? _emptyState()
                    : ListView.builder(
                        itemCount: filtered.length,
                        itemBuilder: (context, index) =>
                            _entryCard(context, filtered[index]),
                      ),
          ),
        ],
      ),
    );
  }

  Widget _emptyState() {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.menu_book_outlined, size: 56, color: scheme.outline),
          const SizedBox(height: 12),
          Text(
            _selectedTag == null
                ? 'Your Commonplace is empty'
                : 'No entries match this topic',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          if (_selectedTag == null) ...[
            const SizedBox(height: 4),
            Text('Tap + to add your first passage.',
                style: TextStyle(color: scheme.onSurfaceVariant)),
          ],
        ],
      ),
    );
  }

  Widget _entryCard(BuildContext context, Map<String, dynamic> entry) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            InkWell(
              onTap: () => setState(() => _expanded = !_expanded),
              child: Text(
                entry['title'] ?? '',
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
            ),
            const SizedBox(height: 6),
            // Passage preview (collapsed) / full passage (expanded).
            Text(
              (entry['entry'] ?? '') as String,
              maxLines: _expanded ? null : 2,
              overflow: _expanded ? TextOverflow.visible : TextOverflow.ellipsis,
              style: TextStyle(color: scheme.onSurfaceVariant),
            ),
            if (_entryHasTags(entry)) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  for (final t in _entryTags(entry))
                    Chip(
                      label: Text('#$t'),
                      visualDensity: VisualDensity.compact,
                      materialTapTargetSize:
                          MaterialTapTargetSize.shrinkWrap,
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  List<String> _entryTags(Map<String, dynamic> entry) =>
      (entry['tags'] as List<dynamic>? ?? const [])
          .map((t) => t.toString())
          .toList();

  bool _entryHasTags(Map<String, dynamic> entry) =>
      _entryTags(entry).isNotEmpty;
}
