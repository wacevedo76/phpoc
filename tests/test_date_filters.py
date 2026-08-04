import unittest
import time
import io
import sys
from phpoc_cli.interface import CLIInterface


class TestDateFilterFormatParsing(unittest.TestCase):
    """Test individual format parsing via _resolve_date_filters."""

    def test_no_filters(self):
        """No filters should return (None, None)."""
        from_str, to_str = CLIInterface._resolve_date_filters()
        self.assertIsNone(from_str)
        self.assertIsNone(to_str)

    def test_days_filter(self):
        """days=N should set from_str to N days ago."""
        from_str, to_str = CLIInterface._resolve_date_filters(days=0)
        today = time.strftime("%Y-%m-%d", time.localtime())
        self.assertEqual(from_str, today)
        self.assertIsNone(to_str)

    def test_date_exact(self):
        """--date YYYY-MM-DD should return exact bounds."""
        from_str, to_str = CLIInterface._resolve_date_filters(date="2026-04-28")
        self.assertEqual(from_str, "2026-04-28")
        self.assertEqual(to_str, "2026-04-28")

    def test_date_overrides_days(self):
        """--date should override days (not combine)."""
        from_str, to_str = CLIInterface._resolve_date_filters(days=7, date="2026-04-28")
        self.assertEqual(from_str, "2026-04-28")
        self.assertEqual(to_str, "2026-04-28")

    def test_week_iso_format(self):
        """--week 2026-W17 should resolve to ISO week boundaries."""
        from_str, to_str = CLIInterface._resolve_date_filters(week="2026-W17")
        self.assertEqual(from_str, "2026-04-20")  # Monday
        self.assertEqual(to_str, "2026-04-26")    # Sunday

    def test_week_date_resolution(self):
        """--week 2026-04-22 should resolve to its containing ISO week."""
        from_str, to_str = CLIInterface._resolve_date_filters(week="2026-04-22")
        self.assertEqual(from_str, "2026-04-20")  # Monday
        self.assertEqual(to_str, "2026-04-26")    # Sunday

    def test_month_with_year(self):
        """--month 2026-04 should resolve to April 2026."""
        from_str, to_str = CLIInterface._resolve_date_filters(month="2026-04")
        self.assertEqual(from_str, "2026-04-01")
        self.assertEqual(to_str, "2026-04-30")

    def test_month_without_year(self):
        """--month 04 should resolve to April of current year."""
        from_str, to_str = CLIInterface._resolve_date_filters(month="04")
        this_year = time.strftime("%Y", time.localtime())
        self.assertEqual(from_str, f"{this_year}-04-01")
        self.assertEqual(to_str, f"{this_year}-04-30")

    def test_month_borrows_from_year_hint(self):
        """--month 04 --year 2025 should resolve to April 2025."""
        from_str, to_str = CLIInterface._resolve_date_filters(month="04", year="2025")
        self.assertEqual(from_str, "2025-04-01")
        self.assertEqual(to_str, "2025-04-30")

    def test_year_filter(self):
        """--year 2026 should resolve to full year bounds."""
        from_str, to_str = CLIInterface._resolve_date_filters(year="2026")
        self.assertEqual(from_str, "2026-01-01")
        self.assertEqual(to_str, "2026-12-31")

    def test_from_yyyy_mm_dd(self):
        """--from YYYY-MM-DD should set lower bound only."""
        from_str, to_str = CLIInterface._resolve_date_filters(from_date="2026-04-15")
        self.assertEqual(from_str, "2026-04-15")
        self.assertIsNone(to_str)

    def test_from_yyyy_mm(self):
        """--from YYYY-MM should set lower bound to first of month."""
        from_str, to_str = CLIInterface._resolve_date_filters(from_date="2026-04")
        self.assertEqual(from_str, "2026-04-01")
        self.assertIsNone(to_str)

    def test_from_yyyy(self):
        """--from YYYY should set lower bound to first of year."""
        from_str, to_str = CLIInterface._resolve_date_filters(from_date="2026")
        self.assertEqual(from_str, "2026-01-01")
        self.assertIsNone(to_str)

    def test_from_mm_yy(self):
        """--from MM/YY should set lower bound."""
        from_str, to_str = CLIInterface._resolve_date_filters(from_date="04/26")
        self.assertEqual(from_str, "2026-04-01")
        self.assertIsNone(to_str)

    def test_from_mm_only_borrows_year(self):
        """--from MM should borrow year from --year; --year sets upper bound."""
        from_str, to_str = CLIInterface._resolve_date_filters(from_date="04", year="2026")
        self.assertEqual(from_str, "2026-04-01")
        self.assertEqual(to_str, "2026-12-31")

    def test_from_mm_only_uses_current_year(self):
        """--from MM without --year should use current year."""
        from_str, to_str = CLIInterface._resolve_date_filters(from_date="04")
        this_year = time.strftime("%Y", time.localtime())
        self.assertEqual(from_str, f"{this_year}-04-01")
        self.assertIsNone(to_str)

    def test_to_yyyy_mm_dd(self):
        """--to YYYY-MM-DD should set upper bound only."""
        from_str, to_str = CLIInterface._resolve_date_filters(to_date="2026-04-15")
        self.assertIsNone(from_str)
        self.assertEqual(to_str, "2026-04-15")

    def test_to_yyyy_mm(self):
        """--to YYYY-MM should set upper bound to last day of month."""
        from_str, to_str = CLIInterface._resolve_date_filters(to_date="2026-04")
        self.assertIsNone(from_str)
        self.assertEqual(to_str, "2026-04-30")

    def test_to_yyyy(self):
        """--to YYYY should set upper bound to last day of year."""
        from_str, to_str = CLIInterface._resolve_date_filters(to_date="2026")
        self.assertIsNone(from_str)
        self.assertEqual(to_str, "2026-12-31")

    def test_to_mm_yy(self):
        """--to MM/YY should set upper bound."""
        from_str, to_str = CLIInterface._resolve_date_filters(to_date="06/26")
        self.assertIsNone(from_str)
        self.assertEqual(to_str, "2026-06-30")

    def test_to_mm_only_borrows_year(self):
        """--to MM should borrow year from --year; --year sets lower bound."""
        from_str, to_str = CLIInterface._resolve_date_filters(to_date="06", year="2026")
        self.assertEqual(from_str, "2026-01-01")
        self.assertEqual(to_str, "2026-06-30")


class TestDateFilterChaining(unittest.TestCase):
    """Test chaining multiple filters together via intersection."""

    def test_year_and_month(self):
        """--year 2026 --month 04 should narrow to April 2026."""
        from_str, to_str = CLIInterface._resolve_date_filters(
            year="2026", month="2026-04"
        )
        self.assertEqual(from_str, "2026-04-01")
        self.assertEqual(to_str, "2026-04-30")

    def test_year_month_and_week(self):
        """--year 2026 --month 04 --week 2026-W17 should narrow to week 17."""
        from_str, to_str = CLIInterface._resolve_date_filters(
            year="2026", month="2026-04", week="2026-W17"
        )
        self.assertEqual(from_str, "2026-04-20")
        self.assertEqual(to_str, "2026-04-26")

    def test_all_filters_narrow_to_date(self):
        """--year + --month + --week + --date should narrow to exact day."""
        from_str, to_str = CLIInterface._resolve_date_filters(
            year="2026", month="2026-04", week="2026-W17", date="2026-04-22"
        )
        self.assertEqual(from_str, "2026-04-22")
        self.assertEqual(to_str, "2026-04-22")

    def test_year_with_from_month_only(self):
        """--year 2026 --from 04 should narrow lower bound to April, keep year upper bound."""
        from_str, to_str = CLIInterface._resolve_date_filters(
            year="2026", from_date="04"
        )
        self.assertEqual(from_str, "2026-04-01")
        self.assertEqual(to_str, "2026-12-31")

    def test_year_with_from_and_to_ranges(self):
        """--year 2026 --from 04 --to 06 should narrow to Apr-Jun."""
        from_str, to_str = CLIInterface._resolve_date_filters(
            year="2026", from_date="04", to_date="06"
        )
        self.assertEqual(from_str, "2026-04-01")
        self.assertEqual(to_str, "2026-06-30")

    def test_days_with_from(self):
        """days and --from should both apply (days is lower bound, from is lower bound)."""
        from_str, to_str = CLIInterface._resolve_date_filters(
            days=30, from_date="2026-04-01"
        )
        # from_date is more specific, should win as the lower bound
        self.assertEqual(from_str, "2026-04-01")
        self.assertIsNone(to_str)


class TestDateFilterConflicts(unittest.TestCase):
    """Test conflict detection and warnings."""

    def test_date_outside_year(self):
        """--year 2025 --date 2026-04-28 should warn and return empty."""
        captured = io.StringIO()
        sys.stderr = captured
        try:
            from_str, to_str = CLIInterface._resolve_date_filters(
                year="2025", date="2026-04-28"
            )
            self.assertIn("WARN:", captured.getvalue())
            self.assertIsNone(from_str)
            self.assertIsNone(to_str)
        finally:
            sys.stderr = sys.__stderr__

    def test_from_after_to(self):
        """--from later than --to should warn."""
        captured = io.StringIO()
        sys.stderr = captured
        try:
            from_str, to_str = CLIInterface._resolve_date_filters(
                from_date="2026-06", to_date="2026-04"
            )
            self.assertIn("WARN:", captured.getvalue())
        finally:
            sys.stderr = sys.__stderr__

    def test_week_outside_year(self):
        """--year 2025 --week 2026-W17 should warn."""
        captured = io.StringIO()
        sys.stderr = captured
        try:
            from_str, to_str = CLIInterface._resolve_date_filters(
                year="2025", week="2026-W17"
            )
            self.assertIn("WARN:", captured.getvalue())
            self.assertIsNone(from_str)
            self.assertIsNone(to_str)
        finally:
            sys.stderr = sys.__stderr__


class TestDateFilterEdgeCases(unittest.TestCase):
    """Test edge cases for date parsing."""

    def test_february_non_leap(self):
        """February 2025 (non-leap) should end on 28th."""
        from_str, to_str = CLIInterface._resolve_date_filters(month="2025-02")
        self.assertEqual(to_str, "2025-02-28")

    def test_february_leap(self):
        """February 2024 (leap) should end on 29th."""
        from_str, to_str = CLIInterface._resolve_date_filters(month="2024-02")
        self.assertEqual(to_str, "2024-02-29")

    def test_december_31_days(self):
        """December should end on 31st."""
        from_str, to_str = CLIInterface._resolve_date_filters(month="2026-12")
        self.assertEqual(to_str, "2026-12-31")

    def test_week_year_boundary(self):
        """ISO week 1 of 2027 starts on Monday Jan 4, 2027."""
        from_str, to_str = CLIInterface._resolve_date_filters(week="2027-W01")
        self.assertEqual(from_str, "2027-01-04")
        self.assertEqual(to_str, "2027-01-10")

    def test_week_53_of_2026(self):
        """ISO week 53 of 2026 exists (2026 starts on Thursday, has 53 weeks)."""
        from_str, to_str = CLIInterface._resolve_date_filters(week="2026-W53")
        self.assertEqual(from_str, "2026-12-28")
        self.assertEqual(to_str, "2027-01-03")


class TestDateFilterExistingBackwardCompat(unittest.TestCase):
    """Test that existing usage patterns still work."""

    def test_days_only_still_works(self):
        """Existing 'list synced 7' pattern should still work."""
        from_str, to_str = CLIInterface._resolve_date_filters(days=7)
        self.assertIsNotNone(from_str)
        self.assertIsNone(to_str)

    def test_from_to_old_format_still_works(self):
        """Existing --from/--to YYYY-MM-DD should still work."""
        from_str, to_str = CLIInterface._resolve_date_filters(
            from_date="2026-01-01", to_date="2026-12-31"
        )
        self.assertEqual(from_str, "2026-01-01")
        self.assertEqual(to_str, "2026-12-31")

    def test_days_zero_shows_today(self):
        """days=0 should filter to today."""
        from_str, to_str = CLIInterface._resolve_date_filters(days=0)
        today = time.strftime("%Y-%m-%d", time.localtime())
        self.assertEqual(from_str, today)
