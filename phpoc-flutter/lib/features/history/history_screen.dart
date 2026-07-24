import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/core/utils/format_utils.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' show syncServiceProvider;
import 'calendar_month_grid.dart';

/// History — chronological entry list with date filter and calendar.
///
/// Displays all completed entries grouped by date with a calendar
/// month grid at the top. Supports single-date and date-range filtering,
/// inline detail expansion, and green-dot calendar indicators.
class HistoryScreen extends ConsumerStatefulWidget {
  const HistoryScreen({super.key});

  @override
  ConsumerState<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends ConsumerState<HistoryScreen> {
  List<Map<String, dynamic>> _rangeFilteredEntries = [];
  List<Map<String, dynamic>> _filtered = [];
  bool _isLoading = true;
  DateTime? _filterFrom;
  DateTime? _filterTo;
  String? _selectedCalendarDate; // YYYY-MM-DD from calendar tap
  int? _expandedIndex;

  // Calendar navigation state
  int _calendarMonth;
  int _calendarYear;

  _HistoryScreenState()
      : _calendarMonth = DateTime.now().month,
        _calendarYear = DateTime.now().year;

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
          _rangeFilteredEntries = completed;
          _applyFilters();
          _isLoading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  /// Apply the calendar single-date filter on top of range filter.
  void _applyFilters() {
    if (_selectedCalendarDate != null) {
      _filtered = _rangeFilteredEntries.where((e) {
        final date = _entryDateStr(e);
        return date == _selectedCalendarDate;
      }).toList();
    } else {
      _filtered = List.from(_rangeFilteredEntries);
    }
  }

  /// Extract YYYY-MM-DD date string from an entry.
  String _entryDateStr(Map<String, dynamic> entry) {
    final startEpoch = entry['start_epoch'] as int?;
    return FormatUtils.epochToDateStr(startEpoch);
  }

  /// Compute dates with entries for the currently displayed month.
  Set<String> _datesWithEntries() {
    final prefix =
        '$_calendarYear-${_calendarMonth.toString().padLeft(2, '0')}-';
    final dates = <String>{};
    for (final entry in _rangeFilteredEntries) {
      final dateStr = _entryDateStr(entry);
      if (dateStr != 'unknown' && dateStr.startsWith(prefix)) {
        dates.add(dateStr);
      }
    }
    return dates;
  }

  /// Handle calendar day tap — toggle single-date filter.
  void _onCalendarDateSelected(String dateStr) {
    setState(() {
      if (_selectedCalendarDate == dateStr) {
        // Toggle off
        _selectedCalendarDate = null;
      } else {
        _selectedCalendarDate = dateStr;
      }
      _applyFilters();
    });
  }

  /// Clear the calendar single-date filter.
  void _clearCalendarFilter() {
    setState(() {
      _selectedCalendarDate = null;
      _applyFilters();
    });
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
        _selectedCalendarDate = null;
      });
      await _loadEntries();
    }
  }

  void _clearRangeFilter() {
    setState(() {
      _filterFrom = null;
      _filterTo = null;
    });
    _loadEntries();
  }

  void _onPreviousMonth() {
    setState(() {
      if (_calendarMonth == 1) {
        _calendarMonth = 12;
        _calendarYear--;
      } else {
        _calendarMonth--;
      }
    });
  }

  void _onNextMonth() {
    setState(() {
      if (_calendarMonth == 12) {
        _calendarMonth = 1;
        _calendarYear++;
      } else {
        _calendarMonth++;
      }
    });
  }

  void _onYearChanged(int delta) {
    setState(() => _calendarYear += delta);
  }

  /// Build date-grouped entries with headers.
  List<_DateGroup> _buildDateGroups() {
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final entry in _filtered) {
      final dateStr = _entryDateStr(entry);
      groups.putIfAbsent(dateStr, () => []).add(entry);
    }

    final now = DateTime.now();
    final todayStr = FormatUtils.epochToDateStr(now.millisecondsSinceEpoch);
    final yesterdayStr = FormatUtils.epochToDateStr(
        now.subtract(const Duration(days: 1)).millisecondsSinceEpoch);

    // Sort keys descending
    final keys = groups.keys.toList()
      ..sort((a, b) => b.compareTo(a));

    return keys.map((dateStr) {
      final label = _dateGroupLabel(dateStr, todayStr, yesterdayStr);
      return _DateGroup(label, groups[dateStr]!);
    }).toList();
  }

  /// Human-readable label for a date group header.
  String _dateGroupLabel(String dateStr, String todayStr, String yesterdayStr) {
    if (dateStr == todayStr) return 'Today';
    if (dateStr == yesterdayStr) return 'Yesterday';
    if (dateStr == 'unknown') return 'Unknown date';
    final parsed = FormatUtils.parseIsoDateStr(dateStr);
    if (parsed != null) {
      return '${FormatUtils.monthAbbr[parsed.month - 1]} ${parsed.day}';
    }
    return dateStr;
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
    final dateGrouped = _buildDateGroups();

    return Column(
      children: [
        // Calendar month grid (shown when entries exist)
        if (_rangeFilteredEntries.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: CalendarMonthGrid(
              month: _calendarMonth,
              year: _calendarYear,
              datesWithEntries: _datesWithEntries(),
              selectedDate: _selectedCalendarDate,
              onDateSelected: _onCalendarDateSelected,
              onPreviousMonth: _onPreviousMonth,
              onNextMonth: _onNextMonth,
              onYearChanged: _onYearChanged,
            ),
          ),
        // Active filters row
        if (_filterFrom != null || _selectedCalendarDate != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: Row(
              children: [
                if (_filterFrom != null && _filterTo != null) ...[
                  Chip(
                    label: Text(
                      '${FormatUtils.dateShort(_filterFrom!)} – ${FormatUtils.dateShort(_filterTo!)}',
                      style: const TextStyle(fontSize: 12),
                    ),
                    onDeleted: _clearRangeFilter,
                  ),
                  const SizedBox(width: 8),
                ],
                if (_selectedCalendarDate != null)
                  Chip(
                    label: Text(
                      _formatCalendarChipLabel(_selectedCalendarDate!),
                      style: const TextStyle(fontSize: 12),
                    ),
                    onDeleted: _clearCalendarFilter,
                  ),
                const Spacer(),
                Text(
                  '${_filtered.length} entries',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        // Entry list (grouped by date)
        Expanded(
          child: _filtered.isEmpty
              ? Center(
                  child: (_filterFrom != null ||
                          _selectedCalendarDate != null)
                      ? _buildFilteredEmpty()
                      : _buildEmpty(),
                )
              : _buildEntryList(dateGrouped),
        ),
      ],
    );
  }

  /// Format a date chip label like "Jun 15, 2026".
  String _formatCalendarChipLabel(String dateStr) {
    final parsed = FormatUtils.parseIsoDateStr(dateStr);
    if (parsed != null) {
      return '${FormatUtils.monthAbbr[parsed.month - 1]} ${parsed.day}, ${parsed.year}';
    }
    return dateStr;
  }

  /// Build a scrollable entry list from date-grouped entries.
  /// Flattens groups into a linear list for O(1) index lookup.
  Widget _buildEntryList(List<_DateGroup> groups) {
    final flatItems = <_FlatItem>[];
    for (final group in groups) {
      flatItems.add(_FlatItem.header(group.label));
      for (final entry in group.entries) {
        flatItems.add(_FlatItem.entry(entry));
      }
    }

    return ListView.builder(
      itemCount: flatItems.length,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      itemBuilder: (_, index) {
        final item = flatItems[index];
        if (item.isHeader) {
          return Padding(
            padding: const EdgeInsets.only(top: 8, bottom: 4),
            child: Text(
              item.label!,
              style: Theme.of(context).textTheme.titleSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: Theme.of(context).colorScheme.primary,
                  ),
            ),
          );
        }
        final globalIndex = _filtered.indexOf(item.entry!);
        return _buildEntryTile(globalIndex >= 0 ? globalIndex : index,
            entry: item.entry);
      },
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
        TextButton(onPressed: _clearRangeFilter, child: const Text('Clear filter')),
      ],
    );
  }

  Widget _buildEntryTile(int index, {Map<String, dynamic>? entry}) {
    final e = entry ?? _filtered[index];
    final title = e['title'] as String? ?? 'Untitled';
    final startEpoch = e['start_epoch'] as int? ?? 0;
    final duration = e['duration'] as int? ?? 0;
    final tags = e['tags'] as List?;
    final pauses = e['pauses'] as List?;
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
                _buildEntryDetail(e, pauses),
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

/// Groups entries by date for display with a label header.
class _DateGroup {
  final String label;
  final List<Map<String, dynamic>> entries;

  const _DateGroup(this.label, this.entries);
}

/// A flattened list item: either a date header or an entry.
class _FlatItem {
  final bool isHeader;
  final String? label;
  final Map<String, dynamic>? entry;

  const _FlatItem._({required this.isHeader, this.label, this.entry});

  factory _FlatItem.header(String label) =>
      _FlatItem._(isHeader: true, label: label);

  factory _FlatItem.entry(Map<String, dynamic> entry) =>
      _FlatItem._(isHeader: false, entry: entry);
}
