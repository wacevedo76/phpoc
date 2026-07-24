import 'package:flutter/material.dart';

/// Month calendar grid with green dots on dates that have entries.
///
/// Displays a single month with day-of-week headers, navigation buttons
/// for previous/next month and year, green dot indicators for dates
/// present in [datesWithEntries], and visual distinction for [selectedDate].
class CalendarMonthGrid extends StatelessWidget {
  final int month; // 1-based (Jan=1)
  final int year;
  final Set<String> datesWithEntries; // "YYYY-MM-DD"
  final String? selectedDate;
  final ValueChanged<String> onDateSelected;
  final VoidCallback onPreviousMonth;
  final VoidCallback onNextMonth;
  final ValueChanged<int> onYearChanged; // delta: +1 or -1

  const CalendarMonthGrid({
    super.key,
    required this.month,
    required this.year,
    this.datesWithEntries = const {},
    this.selectedDate,
    required this.onDateSelected,
    required this.onPreviousMonth,
    required this.onNextMonth,
    required this.onYearChanged,
  });

  static const _monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  static const _dayHeaders = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        // ── Month / Year header with navigation ─────────────────
        _buildHeader(theme),
        const SizedBox(height: 4),
        // ── Day-of-week headers ─────────────────────────────────
        _buildDayHeaders(theme),
        // ── Day grid ────────────────────────────────────────────
        _buildDayGrid(theme),
      ],
    );
  }

  Widget _buildHeader(ThemeData theme) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        // Previous month
        IconButton(
          icon: const Icon(Icons.chevron_left, size: 20),
          onPressed: onPreviousMonth,
          tooltip: 'Previous month',
          visualDensity: VisualDensity.compact,
        ),
        // Month + Year + previous/next year
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Previous year
            IconButton(
              icon: const Icon(Icons.keyboard_double_arrow_left,
                  size: 18),
              onPressed: () => onYearChanged(-1),
              tooltip: 'Previous year',
              visualDensity: VisualDensity.compact,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
            ),
            Text(
              '${_monthNames[month - 1]} $year',
              style: theme.textTheme.titleSmall?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
            // Next year
            IconButton(
              icon: const Icon(Icons.keyboard_double_arrow_right,
                  size: 18),
              onPressed: () => onYearChanged(1),
              tooltip: 'Next year',
              visualDensity: VisualDensity.compact,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
            ),
          ],
        ),
        // Next month
        IconButton(
          icon: const Icon(Icons.chevron_right, size: 20),
          onPressed: onNextMonth,
          tooltip: 'Next month',
          visualDensity: VisualDensity.compact,
        ),
      ],
    );
  }

  Widget _buildDayHeaders(ThemeData theme) {
    return Row(
      children: _dayHeaders.map((d) {
        return Expanded(
          child: Center(
            child: Text(
              d,
              style: theme.textTheme.bodySmall?.copyWith(
                fontWeight: FontWeight.w600,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        );
      }).toList(),
    );
  }

  Widget _buildDayGrid(ThemeData theme) {
    final daysInMonth = _daysInMonth(year, month);
    // 0=Sun, 1=Mon, ..., 6=Sat
    final firstWeekday = DateTime.utc(year, month, 1).weekday % 7;

    final cells = <Widget>[];

    // Leading empty cells before day 1
    for (int i = 0; i < firstWeekday; i++) {
      cells.add(const Expanded(child: SizedBox.shrink()));
    }

    // Day cells 1..N
    for (int day = 1; day <= daysInMonth; day++) {
      final dateStr = '$year-'
          '${month.toString().padLeft(2, '0')}-'
          '${day.toString().padLeft(2, '0')}';
      final hasEntry = datesWithEntries.contains(dateStr);
      final isSelected = dateStr == selectedDate;

      cells.add(Expanded(
        child: _DayCell(
          day: day,
          hasEntry: hasEntry,
          isSelected: isSelected,
          onTap: () => onDateSelected(dateStr),
          theme: theme,
        ),
      ));
    }

    // Build rows of 7
    final rows = <Widget>[];
    for (int i = 0; i < cells.length; i += 7) {
      final end = (i + 7).clamp(0, cells.length);
      rows.add(Row(children: cells.sublist(i, end)));
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: rows,
    );
  }

  static int _daysInMonth(int year, int month) {
    return DateTime.utc(year, month + 1, 0).day;
  }
}

/// A single day cell in the calendar grid.
class _DayCell extends StatelessWidget {
  final int day;
  final bool hasEntry;
  final bool isSelected;
  final VoidCallback onTap;
  final ThemeData theme;

  const _DayCell({
    required this.day,
    required this.hasEntry,
    required this.isSelected,
    required this.onTap,
    required this.theme,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        decoration: isSelected
            ? BoxDecoration(
                color: theme.colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(6),
              )
            : null,
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '$day',
              style: theme.textTheme.bodySmall?.copyWith(
                fontWeight:
                    isSelected ? FontWeight.bold : FontWeight.normal,
                color: isSelected
                    ? theme.colorScheme.onPrimaryContainer
                    : null,
              ),
            ),
            if (hasEntry)
              Container(
                width: 6,
                height: 6,
                margin: const EdgeInsets.only(top: 2),
                decoration: const BoxDecoration(
                  color: Colors.green,
                  shape: BoxShape.circle,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
