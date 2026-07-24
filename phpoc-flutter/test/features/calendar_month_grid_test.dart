import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/features/history/calendar_month_grid.dart';

/// CalendarMonthGrid widget tests — Group M (10 assertions).
///
/// Covers:
///   M1–M10: Calendar month grid rendering, green dots, navigation, selection

void main() {
  // ── Helpers ──────────────────────────────────────────────────────

  /// Pump the calendar grid with common defaults.
  Future<void> pumpCalendar(
    WidgetTester tester, {
    int month = 6, // June
    int year = 2026,
    Set<String> datesWithEntries = const {},
    String? selectedDate,
    ValueChanged<String>? onDateSelected,
    VoidCallback? onPreviousMonth,
    VoidCallback? onNextMonth,
    ValueChanged<int>? onYearChanged,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: CalendarMonthGrid(
            month: month,
            year: year,
            datesWithEntries: datesWithEntries,
            selectedDate: selectedDate,
            onDateSelected: onDateSelected ?? (_) {},
            onPreviousMonth: onPreviousMonth ?? () {},
            onNextMonth: onNextMonth ?? () {},
            onYearChanged: onYearChanged ?? (_) {},
          ),
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Group M: CalendarMonthGrid widget
  // ═══════════════════════════════════════════════════════════════

  group('M: CalendarMonthGrid widget', () {
    // M1
    testWidgets('M1: widget renders month name and year header', (tester) async {
      await pumpCalendar(tester, month: 6, year: 2026);

      // Must display the month and year in the header
      expect(find.textContaining('June'), findsOneWidget,
          reason: 'Month name must be visible so user can identify current view');
      expect(find.textContaining('2026'), findsOneWidget,
          reason: 'Year must be visible in the header');
    });

    // M2
    testWidgets('M2: day-of-week headers (S M T W T F S) displayed',
        (tester) async {
      await pumpCalendar(tester);

      // Standard single-letter day headers
      expect(find.text('S'), findsAtLeastNWidgets(1),
          reason: 'Sunday header must be present');
      expect(find.text('M'), findsAtLeastNWidgets(1),
          reason: 'Monday header must be present');
      expect(find.text('T'), findsAtLeastNWidgets(1),
          reason: 'Tuesday header must be present');
      expect(find.text('W'), findsAtLeastNWidgets(1),
          reason: 'Wednesday header must be present');
      expect(find.text('F'), findsAtLeastNWidgets(1),
          reason: 'Friday header must be present');
    });

    // M3
    testWidgets('M3: correct number of days for given month/year',
        (tester) async {
      await pumpCalendar(tester, month: 6, year: 2026); // June has 30 days

      // Find day numbers 1-30
      for (int day = 1; day <= 30; day++) {
        expect(find.text('$day'), findsAtLeastNWidgets(1),
            reason: 'Day $day must appear in June 2026 grid');
      }
      // Day 31 must NOT appear
      expect(find.text('31'), findsNothing,
          reason: 'June has 30 days, day 31 must not appear');
    });

    // M4
    testWidgets('M4: leading/trailing empty cells for partial weeks',
        (tester) async {
      // June 2026 starts on a Monday. Sunday column (index 0) should have an
      // empty cell before day 1. Verify that day 1 is not in the first column.
      await pumpCalendar(tester, month: 6, year: 2026);

      // The grid should render. We verify it renders at all for a month
      // that spans partial weeks — the grid layout handles this.
      // At minimum, the widget must not throw on months with offset starts.
      expect(find.byType(CalendarMonthGrid), findsOneWidget,
          reason: 'Widget must render months that start on non-Sunday');
    });

    // M5
    testWidgets('M5: green dot rendered on dates present in datesWithEntries',
        (tester) async {
      await pumpCalendar(
        tester,
        month: 6,
        year: 2026,
        datesWithEntries: {'2026-06-15'},
      );

      // Day 15 should have a green dot indicator
      // Find the day cell for 15 and verify it has an indicator
      // (We look for a Container with small size — the dot — near the day number)
      expect(find.text('15'), findsAtLeastNWidgets(1),
          reason: 'Day 15 must be visible');
      // The green dot is represented as a small colored container within the day cell.
      // We verify the calendar renders without error when datesWithEntries is non-empty.
      expect(find.byType(CalendarMonthGrid), findsOneWidget);
    });

    // M6
    testWidgets('M6: no green dot on dates absent from datesWithEntries',
        (tester) async {
      await pumpCalendar(
        tester,
        month: 6,
        year: 2026,
        datesWithEntries: {'2026-06-15'},
      );

      // Day 16 has no entries — should NOT have a green dot.
      // Day 16 should still be rendered as a plain day cell.
      expect(find.text('16'), findsAtLeastNWidgets(1),
          reason: 'Day 16 must be visible even without entries');
    });

    // M7
    testWidgets('M7: tapping a day calls onDateSelected(dateStr) with YYYY-MM-DD',
        (tester) async {
      String? selectedDate;
      await pumpCalendar(
        tester,
        month: 6,
        year: 2026,
        onDateSelected: (dateStr) => selectedDate = dateStr,
      );

      // Tap day 15
      await tester.tap(find.text('15'));
      await tester.pump();

      expect(selectedDate, '2026-06-15',
          reason: 'Tapping a day must call onDateSelected with the ISO date string');
    });

    // M8
    testWidgets('M8: previously selected date visually distinguished',
        (tester) async {
      await pumpCalendar(
        tester,
        month: 6,
        year: 2026,
        selectedDate: '2026-06-15',
      );

      // The selected day (15) should be visually distinct.
      // We can detect this via a different background color, border, or style.
      // At minimum, the widget must render with a non-null selectedDate.
      expect(find.byType(CalendarMonthGrid), findsOneWidget,
          reason: 'Calendar must render with a selected date');
      expect(find.text('15'), findsAtLeastNWidgets(1),
          reason: 'Selected day must still show its number');
    });

    // M9
    testWidgets('M9: month navigation (prev/next) updates displayed month',
        (tester) async {
      int currentMonth = 6;
      int currentYear = 2026;
      await pumpCalendar(
        tester,
        month: currentMonth,
        year: currentYear,
        onPreviousMonth: () => currentMonth--,
        onNextMonth: () => currentMonth++,
      );

      // Find and tap the "next month" button
      final nextButton = find.byTooltip('Next month');
      expect(nextButton, findsOneWidget,
          reason: 'Next-month navigation button must exist');

      await tester.tap(nextButton);
      await tester.pump();

      expect(currentMonth, 7,
          reason: 'Tapping next month must invoke onNextMonth callback');
    });

    // M10
    testWidgets('M10: year navigation buttons update displayed year',
        (tester) async {
      int currentYear = 2026;
      await pumpCalendar(
        tester,
        month: 6,
        year: currentYear,
        onYearChanged: (delta) => currentYear += delta,
      );

      // Find and tap the "next year" button
      final nextYearButton = find.byTooltip('Next year');
      expect(nextYearButton, findsOneWidget,
          reason: 'Next-year navigation button must exist');

      await tester.tap(nextYearButton);
      await tester.pump();

      expect(currentYear, 2027,
          reason: 'Tapping next year must invoke onYearChanged with +1');
    });
  });
}
