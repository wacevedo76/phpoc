import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/core/utils/format_utils.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' show syncServiceProvider;

/// History — chronological entry list with date filter.
///
/// Displays all completed entries with title, date, duration, and tags.
/// Supports date-range filtering and inline detail expansion.
class HistoryScreen extends ConsumerStatefulWidget {
  const HistoryScreen({super.key});

  @override
  ConsumerState<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends ConsumerState<HistoryScreen> {
  List<Map<String, dynamic>> _filtered = [];
  bool _isLoading = true;
  DateTime? _filterFrom;
  DateTime? _filterTo;
  int? _expandedIndex;

  @override
  void initState() {
    super.initState();
    _loadEntries();
  }

  Future<void> _loadEntries() async {
    setState(() => _isLoading = true);
    try {
      final sync = ref.read(syncServiceProvider);
      final entries = await sync.getEntries(from: _filterFrom, to: _filterTo);
      final completed =
          entries.where((e) => e['is_active'] != true).toList();
      if (mounted) {
        setState(() {
          _filtered = completed;
          _isLoading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _pickDateRange() async {
    final now = DateTime.now();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(2020),
      lastDate: now,
      initialDateRange: _filterFrom != null && _filterTo != null
          ? DateTimeRange(start: _filterFrom!, end: _filterTo!)
          : DateTimeRange(
              start: now.subtract(const Duration(days: 30)),
              end: now,
            ),
    );

    if (picked != null) {
      setState(() {
        _filterFrom = picked.start;
        _filterTo = picked.end;
      });
      await _loadEntries();
    }
  }

  void _clearFilter() {
    setState(() {
      _filterFrom = null;
      _filterTo = null;
    });
    _loadEntries();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('History'),
        actions: [
          IconButton(
            icon: const Icon(Icons.calendar_month),
            onPressed: _pickDateRange,
            tooltip: 'Filter by date',
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _buildBody(),
    );
  }

  Widget _buildBody() {
    return Column(
      children: [
        // Date filter chip
        if (_filterFrom != null && _filterTo != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                Chip(
                  label: Text(
                    '${FormatUtils.dateShort(_filterFrom!)} – ${FormatUtils.dateShort(_filterTo!)}',
                    style: const TextStyle(fontSize: 12),
                  ),
                  onDeleted: _clearFilter,
                ),
                const Spacer(),
                Text(
                  '${_filtered.length} entries',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        // Entry list
        Expanded(
          child: _filtered.isEmpty
              ? Center(
                  child: _filterFrom != null
                      ? _buildFilteredEmpty()
                      : _buildEmpty(),
                )
              : ListView.builder(
                  itemCount: _filtered.length,
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  itemBuilder: (_, index) => _buildEntryTile(index),
                ),
        ),
      ],
    );
  }

  Widget _buildEmpty() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.inbox_outlined, size: 64,
            color: Theme.of(context).colorScheme.onSurfaceVariant),
        const SizedBox(height: 8),
        Text('No entries yet',
            style: Theme.of(context).textTheme.bodyLarge),
        const SizedBox(height: 4),
        Text('Start a task from the Dashboard to see it here',
            style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }

  Widget _buildFilteredEmpty() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.filter_list_off, size: 64,
            color: Theme.of(context).colorScheme.onSurfaceVariant),
        const SizedBox(height: 8),
        Text('No entries for this period',
            style: Theme.of(context).textTheme.bodyLarge),
        const SizedBox(height: 4),
        TextButton(onPressed: _clearFilter, child: const Text('Clear filter')),
      ],
    );
  }

  Widget _buildEntryTile(int index) {
    final entry = _filtered[index];
    final title = entry['title'] as String? ?? 'Untitled';
    final startEpoch = entry['start_epoch'] as int? ?? 0;
    final duration = entry['duration'] as int? ?? 0;
    final tags = entry['tags'] as List?;
    final pauses = entry['pauses'] as List?;
    final isExpanded = _expandedIndex == index;

    final startDt = DateTime.fromMillisecondsSinceEpoch(startEpoch);

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        onTap: () {
          setState(() {
            _expandedIndex = isExpanded ? null : index;
          });
        },
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Title row
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    FormatUtils.duration(Duration(milliseconds: duration)),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              // Date + tags
              Row(
                children: [
                  Icon(Icons.calendar_today, size: 14,
                      color: Theme.of(context).colorScheme.onSurfaceVariant),
                  const SizedBox(width: 4),
                  Text(
                    FormatUtils.dateTime(startDt),
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  if (tags != null && tags.isNotEmpty) ...[
                    const SizedBox(width: 12),
                    ...tags.take(3).map((t) => Padding(
                          padding: const EdgeInsets.only(right: 4),
                          child: Chip(
                            label: Text(t.toString(), style: const TextStyle(fontSize: 10)),
                            materialTapTargetSize:
                                MaterialTapTargetSize.shrinkWrap,
                            visualDensity: VisualDensity.compact,
                            padding: EdgeInsets.zero,
                          ),
                        )),
                  ],
                ],
              ),
              // Expanded detail
              if (isExpanded)
                _buildEntryDetail(entry, pauses),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildEntryDetail(
      Map<String, dynamic> entry, List<dynamic>? pauses) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Divider(height: 20),
        if (pauses != null && pauses.isNotEmpty) ...[
          Text('Pauses',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  )),
          const SizedBox(height: 4),
          ...pauses.map((p) {
            final pauseStart = p['start_epoch'] as int? ?? 0;
            final pauseEnd = p['end_epoch'] as int?;
            final pStartDt =
                DateTime.fromMillisecondsSinceEpoch(pauseStart);
            final pEndDt = pauseEnd != null
                ? DateTime.fromMillisecondsSinceEpoch(pauseEnd)
                : null;
            return Padding(
              padding: const EdgeInsets.only(left: 8, bottom: 2),
              child: Text(
                pEndDt != null
                    ? '${FormatUtils.time(pStartDt)} – ${FormatUtils.time(pEndDt)}'
                    : '${FormatUtils.time(pStartDt)} – ongoing',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            );
          }),
        ],
        if (entry['metadata_enc'] != null) ...[
          const SizedBox(height: 8),
          Text('Metadata',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  )),
          const SizedBox(height: 4),
          Text(
            entry['metadata_enc'].toString(),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ],
    );
  }
}
