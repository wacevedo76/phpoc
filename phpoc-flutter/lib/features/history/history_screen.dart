import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/core/utils/format_utils.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' show syncServiceProvider;
import 'calendar_month_grid.dart';

/// History — chronological entry list with date filter and calendar.
///
/// Displays all completed entries grouped by date with a calendar
/// month grid at the top. Supports single-date and date-range filtering,
/// inline detail expansion, and orange borders on uncommitted entries.
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
  String? _selectedCalendarDate;
  int? _expandedIndex;

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

  String _entryDateStr(Map<String, dynamic> entry) {
    final startEpoch = entry['start_epoch'] as int?;
    return FormatUtils.epochToDateStr(startEpoch);
  }

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

  void _onCalendarDateSelected(String dateStr) {
    setState(() {
      if (_selectedCalendarDate == dateStr) {
        _selectedCalendarDate = null;
      } else {
        _selectedCalendarDate = dateStr;
      }
      _applyFilters();
    });
  }

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

    final keys = groups.keys.toList()
      ..sort((a, b) => b.compareTo(a));

    return keys.map((dateStr) {
      final label = _dateGroupLabel(dateStr, todayStr, yesterdayStr);
      return _DateGroup(label, groups[dateStr]!);
    }).toList();
  }

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
        if (_filterFrom != null || _selectedCalendarDate != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: Row(
              children: [
                if (_filterFrom != null && _filterTo != null) ...[
                  Chip(
                    label: Text(
                      '${FormatUtils.dateShort(_filterFrom!)} \u2013 ${FormatUtils.dateShort(_filterTo!)}',
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

  String _formatCalendarChipLabel(String dateStr) {
    final parsed = FormatUtils.parseIsoDateStr(dateStr);
    if (parsed != null) {
      return '${FormatUtils.monthAbbr[parsed.month - 1]} ${parsed.day}, ${parsed.year}';
    }
    return dateStr;
  }

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

  // ── Entry tile (collapsible, orange border if uncommitted) ──

  Widget _buildEntryTile(int index, {Map<String, dynamic>? entry}) {
    final e = entry ?? _filtered[index];
    final title = e['title'] as String? ?? 'Untitled';
    final startEpoch = e['start_epoch'] as int? ?? 0;
    final duration = e['duration'] as int? ?? 0;
    final tags = (e['tags'] as List?)?.cast<String>() ?? [];
    final comment = e['comment'] as String?;
    final pauses = (e['pauses'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    final committed = e['committed'] == true;
    final isExpanded = _expandedIndex == index;
    final startDt = DateTime.fromMillisecondsSinceEpoch(startEpoch);

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: committed
            ? BorderSide.none
            : const BorderSide(color: Colors.orange, width: 2),
      ),
      child: InkWell(
        onTap: () {
          setState(() {
            _expandedIndex = isExpanded ? null : index;
          });
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
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
                  const SizedBox(width: 4),
                  Icon(
                    isExpanded ? Icons.expand_less : Icons.expand_more,
                    size: 20,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
              const SizedBox(height: 2),
              // Date
              Text(
                FormatUtils.dateTime(startDt),
                style: Theme.of(context).textTheme.bodySmall,
              ),
              // Expanded detail
              AnimatedCrossFade(
                firstChild: const SizedBox.shrink(),
                secondChild:
                    _buildEntryDetail(tags, comment, pauses),
                crossFadeState: isExpanded
                    ? CrossFadeState.showSecond
                    : CrossFadeState.showFirst,
                duration: const Duration(milliseconds: 200),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildEntryDetail(
    List<String> tags,
    String? comment,
    List<Map<String, dynamic>> pauses,
  ) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (tags.isNotEmpty) ...[
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: tags.map((t) {
                return Chip(
                  label: Text(t, style: const TextStyle(fontSize: 10)),
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  visualDensity: VisualDensity.compact,
                  padding: EdgeInsets.zero,
                );
              }).toList(),
            ),
            const SizedBox(height: 6),
          ],
          if (comment != null && comment.isNotEmpty) ...[
            Text(
              comment,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    fontStyle: FontStyle.italic,
                  ),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
            ),
            const SizedBox(height: 6),
          ],
          if (pauses.isNotEmpty) ...[
            const Divider(height: 16),
            Text(
              'Pauses',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
            ),
            const SizedBox(height: 2),
            ...pauses.map((p) {
              final pStart = p['pause_start'] as int? ?? 0;
              final pEnd = p['pause_stop'] as int?;
              final pStartDt = DateTime.fromMillisecondsSinceEpoch(pStart);
              final pEndDt =
                  pEnd != null ? DateTime.fromMillisecondsSinceEpoch(pEnd) : null;
              final pDuration = pEndDt != null
                  ? pEndDt.difference(pStartDt)
                  : DateTime.now().difference(pStartDt);
              return Padding(
                padding: const EdgeInsets.only(left: 8, bottom: 2),
                child: Text(
                  pEndDt != null
                      ? '${FormatUtils.time(pStartDt)} \u2013 ${FormatUtils.time(pEndDt)}  (${FormatUtils.duration(pDuration)})'
                      : '${FormatUtils.time(pStartDt)} \u2013 ongoing  (${FormatUtils.duration(pDuration)})',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              );
            }),
          ],
        ],
      ),
    );
  }
}

class _DateGroup {
  final String label;
  final List<Map<String, dynamic>> entries;
  const _DateGroup(this.label, this.entries);
}

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
