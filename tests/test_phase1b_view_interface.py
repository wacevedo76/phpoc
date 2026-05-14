"""Phase 1b tests: View Interface + CLI View + Strategies.

Tests the new ViewInterface abstract base, the CLIView concrete
implementation including all formatting methods, time parsing,
and the interactive sync strategies.

These tests verify the new view layer WITHOUT modifying any existing code.
"""

import unittest
import time
from datetime import datetime
from unittest.mock import patch, MagicMock

from domain.interfaces.view import ViewInterface
from cli.cli_parsers import parse_time_input
from cli.cli_view import CLIView
from cli.strategies import SyncDecision, SyncStrategy, AutoSyncStrategy, InteractiveCLIStrategy


# =============================================================================
# ViewInterface Tests
# =============================================================================

class TestViewInterface(unittest.TestCase):
    """Ensure ViewInterface has all expected methods with no-op defaults."""

    def setUp(self):
        self.view = ViewInterface()

    def test_render_entry_line_returns_empty_string(self):
        self.assertEqual(self.view.render_entry_line({}), "")

    def test_render_entry_list_joins_lines(self):
        result = self.view.render_entry_list([{"title": "A"}, {"title": "B"}])
        self.assertEqual(result, "\n".join(["", ""]))

    def test_render_overview_does_not_raise(self):
        self.view.render_overview([], {}, set())  # should not raise

    def test_render_edit_menu_does_not_raise(self):
        self.view.render_edit_menu([], {}, set())

    def test_prompt_choice_returns_empty_string(self):
        self.assertEqual(self.view.prompt_choice("?", ["A"]), "")

    def test_prompt_text_returns_default(self):
        self.assertEqual(self.view.prompt_text("?", "default"), "default")

    def test_prompt_time_returns_none(self):
        self.assertIsNone(self.view.prompt_time("?", "2026-01-01", 1000, 2000))

    def test_prompt_yes_no_returns_default(self):
        self.assertFalse(self.view.prompt_yes_no("?", default=False))
        self.assertTrue(self.view.prompt_yes_no("?", default=True))

    def test_prompt_int_returns_none(self):
        self.assertIsNone(self.view.prompt_int("?"))

    def test_prompt_tag_action_returns_original(self):
        tags, modified = self.view.prompt_tag_action(["a", "b"])
        self.assertEqual(tags, ["a", "b"])
        self.assertFalse(modified)

    def test_render_error_does_not_raise(self):
        self.view.render_error("test error")

    def test_render_success_does_not_raise(self):
        self.view.render_success("test success")

    def test_render_warning_does_not_raise(self):
        self.view.render_warning("test warning")

    def test_render_help_does_not_raise(self):
        self.view.render_help({"A": "Action A"})


# =============================================================================
# CLIView Tests
# =============================================================================

class TestCLIViewEntryFormatting(unittest.TestCase):
    """Test render_entry_line formatting logic."""

    def setUp(self):
        mock_ledger = MagicMock()
        self.view = CLIView(mock_ledger)

    def test_render_entry_line_format(self):
        entry = {
            "entry_index": 2,
            "title": "Guitar Practice",
            "tags": ["music", "learning"],
            "date": "2026-01-15",
            "start_epoch": 1736899200000,  # 2026-01-15 00:00 UTC
            "end_epoch": 1736906400000,    # 2026-01-15 02:00 UTC
            "duration": 7200000,
            "comment": "scales and arpeggios",
        }
        line = self.view.render_entry_line(entry)
        self.assertIn("#2", line)
        self.assertIn("Guitar Practice", line)
        self.assertIn("@music", line)
        self.assertIn("@learning", line)
        self.assertIn("2026-01-15", line)
        # Should show duration
        self.assertIn("02h", line)

    def test_render_entry_line_with_overrides(self):
        entry = {
            "entry_index": 1,
            "title": "Test",
            "tags": [],
            "date": "2026-01-15",
            "start_epoch": 1736899200000,
            "end_epoch": 1736906400000,
            "duration": 7200000,
        }
        overrides = {1: {"end_epoch": 1736910000000, "comment": "new"}}
        line = self.view.render_entry_line(entry, overrides)
        self.assertIn("(modified)", line)

    def test_render_entry_line_with_excluded(self):
        entry = {
            "entry_index": 3,
            "title": "Test",
            "tags": [],
            "date": "2026-01-15",
            "start_epoch": 1736899200000,
            "end_epoch": 1736906400000,
            "duration": 7200000,
        }
        line = self.view.render_entry_line(entry, excluded={3})
        self.assertIn("removed", line)

    def test_render_overview_contains_pending_header(self):
        with patch('builtins.print') as mock_print:
            self.view.render_overview([], {}, set())
            printed = mock_print.call_args_list
            first_call = printed[0][0][0]
            self.assertIn("Pending Sync", str(first_call))


class TestCLIViewTags(unittest.TestCase):
    """Test tag display and tag action prompt."""

    def setUp(self):
        self.view = CLIView(MagicMock())

    def test_render_tags_with_list(self):
        with patch('builtins.print') as mock_print:
            self.view.render_tags(["music", "code"])
            calls = "".join(str(c[0]) for c in mock_print.call_args_list)
            self.assertIn("@music", calls)
            self.assertIn("@code", calls)

    def test_render_tags_empty(self):
        with patch('builtins.print') as mock_print:
            self.view.render_tags([])
            calls = "".join(str(c[0]) for c in mock_print.call_args_list)
            self.assertIn("No tags found", calls)


class TestCLIViewDurationFormatting(unittest.TestCase):
    """Test _format_duration static method."""

    def test_format_duration_zero(self):
        self.assertEqual(CLIView._format_duration(0), "00h00m00s")

    def test_format_duration_seconds(self):
        self.assertEqual(CLIView._format_duration(45000), "00h00m45s")

    def test_format_duration_minutes(self):
        self.assertEqual(CLIView._format_duration(3660000), "01h01m00s")

    def test_format_duration_hours(self):
        self.assertEqual(CLIView._format_duration(7200000), "02h00m00s")

    def test_format_duration_complex(self):
        self.assertEqual(CLIView._format_duration(9375000), "02h36m15s")


class TestCLIViewPromptSelection(unittest.TestCase):
    """Test prompt_choice selection logic."""

    def setUp(self):
        self.view = CLIView(MagicMock())

    def test_prompt_choice_returns_valid_option(self):
        with patch('builtins.input', return_value='S'):
            result = self.view.prompt_choice("?", ("S", "E"))
            self.assertEqual(result, "S")

    def test_prompt_choice_rejects_invalid(self):
        with patch('builtins.input', side_effect=['X', 'S']):
            result = self.view.prompt_choice("?", ("S", "E"))
            self.assertEqual(result, "S")

    def test_prompt_choice_help_shows_and_returns(self):
        with patch('builtins.input', side_effect=['?', 'C']):
            with patch('builtins.print') as mock_print:
                result = self.view.prompt_choice("?", ("C",), help_items={"C": "Cancel"})
                self.assertEqual(result, "C")
                # Help should have been printed
                help_calls = [str(c[0]) for c in mock_print.call_args_list
                              if "Available commands" in str(c[0])]
                self.assertTrue(help_calls, "Help should have been displayed")


class TestCLIViewPromptYesNo(unittest.TestCase):
    """Test yes/no prompting."""

    def setUp(self):
        self.view = CLIView(MagicMock())

    def test_yes_returns_true(self):
        with patch('builtins.input', return_value='y'):
            self.assertTrue(self.view.prompt_yes_no("?"))

    def test_no_returns_false(self):
        with patch('builtins.input', return_value='n'):
            self.assertFalse(self.view.prompt_yes_no("?"))

    def test_empty_returns_default(self):
        with patch('builtins.input', return_value=''):
            self.assertTrue(self.view.prompt_yes_no("?", default=True))
            self.assertFalse(self.view.prompt_yes_no("?", default=False))


# =============================================================================
# CLI Parsers Tests
# =============================================================================

class TestParseTimeInput(unittest.TestCase):
    """Test the time input parsing function extracted from main.py."""

    def test_clock_time(self):
        result, display = parse_time_input("14:30", "2026-01-15", 1000, 2000)
        self.assertIsNotNone(result)
        self.assertIn("14:30", display)

    def test_offset_from_start_plus_minutes(self):
        result, display = parse_time_input("+30m", "2026-01-15", 1000, 2000)
        self.assertEqual(result, 1000 + 30 * 60000)
        self.assertIsNotNone(display)

    def test_offset_from_start_plus_hours(self):
        result, display = parse_time_input("+2h", "2026-01-15", 1000, 2000)
        self.assertEqual(result, 1000 + 2 * 3600000)

    def test_offset_from_end_minus_minutes(self):
        result, display = parse_time_input("-15m", "2026-01-15", 1000, 2000000)
        self.assertEqual(result, 2000000 - 15 * 60000)

    def test_offset_from_end_clamped_at_start(self):
        result, display = parse_time_input("-999999m", "2026-01-15", 500000, 600000)
        self.assertEqual(result, 500000)  # clamped at start_epoch

    def test_duration_hours_minutes(self):
        result, display = parse_time_input("1h30m", "2026-01-15", 1000, 2000)
        self.assertEqual(result, 1000 + 5400000)

    def test_duration_seconds(self):
        result, display = parse_time_input("45s", "2026-01-15", 1000, 2000)
        self.assertEqual(result, 1000 + 45000)

    def test_raw_epoch(self):
        result, display = parse_time_input("1000000000", "2026-01-15", 1000, 2000)
        self.assertEqual(result, 1000000000)

    def test_invalid_format_returns_none(self):
        result, msg = parse_time_input("xyz", "2026-01-15", 1000, 2000)
        self.assertIsNone(result)
        self.assertTrue(len(msg) > 0)

    def test_negative_offset_no_end_returns_error(self):
        result, msg = parse_time_input("-5m", "2026-01-15", 1000, None)
        self.assertIsNone(result)
        self.assertIn("No end time", msg)


# =============================================================================
# SyncDecision Tests
# =============================================================================

class TestSyncDecision(unittest.TestCase):
    """Test the SyncDecision dataclass used by strategies."""

    def test_default_constructor(self):
        d = SyncDecision()
        self.assertEqual(d.selected_indices, [])
        self.assertEqual(d.overrides, {})
        self.assertEqual(d.removal_indices, set())
        self.assertFalse(d.cancelled)

    def test_has_selection_true_with_indices(self):
        d = SyncDecision(selected_indices=[1, 2])
        self.assertTrue(d.has_selection)

    def test_has_selection_false_when_empty(self):
        d = SyncDecision(selected_indices=[])
        self.assertFalse(d.has_selection)

    def test_has_selection_false_when_cancelled(self):
        d = SyncDecision(selected_indices=[1], cancelled=True)
        self.assertFalse(d.has_selection)

    def test_has_removals_true_with_removals(self):
        d = SyncDecision(removal_indices={1})
        self.assertTrue(d.has_removals)

    def test_has_removals_false_empty(self):
        d = SyncDecision(removal_indices=set())
        self.assertFalse(d.has_removals)


# =============================================================================
# SyncStrategy Tests
# =============================================================================

class TestSyncStrategy(unittest.TestCase):
    """Test the abstract base class."""

    def test_decide_is_abstract(self):
        """SyncStrategy cannot be instantiated directly (abstract base)."""
        with self.assertRaises(TypeError):
            SyncStrategy()


class TestAutoSyncStrategy(unittest.TestCase):
    """Test the auto (headless/--yes) strategy."""

    def setUp(self):
        self.strategy = AutoSyncStrategy()

    def test_decide_returns_all_indices(self):
        pending = [
            {"entry_index": 1, "title": "A"},
            {"entry_index": 2, "title": "B"},
        ]
        decision = self.strategy.decide(pending)
        self.assertEqual(decision.selected_indices, [1, 2])

    def test_decide_empty_returns_empty_decision(self):
        decision = self.strategy.decide([])
        self.assertEqual(decision.selected_indices, [])


class TestInteractiveCLIStrategy(unittest.TestCase):
    """Test the interactive sync strategy with a mock view."""

    def setUp(self):
        self.strategy = InteractiveCLIStrategy()
        self.mock_view = MagicMock(spec=CLIView)

        self.pending = [
            {"entry_index": 1, "title": "Guitar", "tags": ["music"],
             "date": "2026-01-15", "start_epoch": 1736899200000,
             "end_epoch": 1736906400000, "duration": 7200000,
             "comment": ""},
            {"entry_index": 2, "title": "Reading", "tags": ["books"],
             "date": "2026-01-15", "start_epoch": 1736906400000,
             "end_epoch": 1736910000000, "duration": 3600000,
             "comment": ""},
        ]

    def test_auto_sync_all(self):
        """[S]ync now selects all indices."""
        self.mock_view.prompt_choice.return_value = "S"
        decision = self.strategy.decide(self.pending, self.mock_view)
        self.assertEqual(set(decision.selected_indices), {1, 2})

    def test_cancel_returns_cancelled(self):
        """[C]ancel returns cancelled decision."""
        self.mock_view.prompt_choice.return_value = "C"
        decision = self.strategy.decide(self.pending, self.mock_view)
        self.assertTrue(decision.cancelled)

    def test_strategy_rejects_invalid_then_accepts_s(self):
        """First invalid input, then 'S'."""
        self.mock_view.prompt_choice.side_effect = ["X", "S"]
        decision = self.strategy.decide(self.pending, self.mock_view)
        self.assertEqual(set(decision.selected_indices), {1, 2})

    def test_strategy_empty_pending(self):
        """Empty pending returns cancelled."""
        decision = self.strategy.decide([], self.mock_view)
        self.assertTrue(decision.cancelled)


# =============================================================================
# Integration: parse_time_input format round-trips
# =============================================================================

class TestTimeParsingEdgeCases(unittest.TestCase):
    """Test edge cases for the time parser."""

    def test_empty_string(self):
        result, msg = parse_time_input("", "2026-01-15", 1000, 2000)
        self.assertIsNone(result)
        self.assertIn("Unrecognized", msg)

    def test_whitespace_only(self):
        result, msg = parse_time_input("   ", "2026-01-15", 1000, 2000)
        self.assertIsNone(result)

    def test_plus_without_number(self):
        result, msg = parse_time_input("+", "2026-01-15", 1000, 2000)
        self.assertIsNone(result)

    def test_minus_without_number(self):
        result, msg = parse_time_input("-", "2026-01-15", 1000, 2000)
        self.assertIsNone(result)

    def test_duration_without_units(self):
        result, msg = parse_time_input("1h2", "2026-01-15", 1000, 2000)
        # '1h' matches the duration regex before '2' is considered
        self.assertIsNotNone(result)

    def test_clock_time_hh_mm_ss(self):
        result, display = parse_time_input("09:05:30", "2026-01-15", 1000, 2000)
        self.assertIsNotNone(result)
        self.assertIn("09:05:30", display)

    def test_clock_time_midnight(self):
        result, display = parse_time_input("00:00", "2026-01-15", 1000, 2000)
        self.assertIsNotNone(result)
        # start_epoch=1000 is tiny (far in the past), so 00:00 on 2026-01-15
        # is well after start_epoch — no auto-advance
        expected = int(datetime(2026, 1, 15, 0, 0, 0).timestamp() * 1000)
        self.assertEqual(result, expected)

    def test_large_raw_epoch(self):
        epoch = 2000000000000
        result, display = parse_time_input(str(epoch), "2026-01-15", 1000, 2000)
        self.assertEqual(result, epoch)

    # --- P11: Day-Boundary Span — Issue 1: Midnight auto-advance & hour wrapping ---
    # Rule: h>=24 wraps by h//24 days. 00:00 auto-advances when result<start_epoch.

    def test_00_00_auto_advances_when_result_before_start(self):
        """00:00 after a late-night start advances to the next day."""
        date_str = "2026-04-28"
        start_epoch = int(datetime(2026, 4, 28, 23, 0, 0).timestamp() * 1000)
        result, display = parse_time_input("00:00", date_str, start_epoch, None)
        self.assertIsNotNone(result)
        expected = int(datetime(2026, 4, 29, 0, 0, 0).timestamp() * 1000)
        self.assertEqual(result, expected)
        self.assertEqual(display, "00:00:00")

    def test_00_00_stays_same_day_when_result_equals_start(self):
        """00:00 stays same day if start is exactly at midnight."""
        date_str = "2026-04-28"
        start_epoch = int(datetime(2026, 4, 28, 0, 0, 0).timestamp() * 1000)
        result, display = parse_time_input("00:00", date_str, start_epoch, None)
        self.assertIsNotNone(result)
        expected = int(datetime(2026, 4, 28, 0, 0, 0).timestamp() * 1000)
        self.assertEqual(result, expected)

    def test_13_00_before_start_does_not_advance(self):
        """Normal clock times before start_epoch do NOT auto-advance."""
        date_str = "2026-04-28"
        start_epoch = int(datetime(2026, 4, 28, 14, 0, 0).timestamp() * 1000)
        result, display = parse_time_input("13:00", date_str, start_epoch, None)
        self.assertIsNotNone(result)
        expected = int(datetime(2026, 4, 28, 13, 0, 0).timestamp() * 1000)
        self.assertEqual(result, expected)

    def test_24_00_wraps_to_midnight_next_day(self):
        """24:00 wraps to 00:00 the next day."""
        date_str = "2026-04-28"
        start_epoch = int(datetime(2026, 4, 28, 23, 0, 0).timestamp() * 1000)
        result, display = parse_time_input("24:00", date_str, start_epoch, None)
        self.assertIsNotNone(result)
        expected = int(datetime(2026, 4, 29, 0, 0, 0).timestamp() * 1000)
        self.assertEqual(result, expected)

    def test_25_00_wraps_to_01_00_next_day(self):
        """25:00 wraps to 01:00 the next day."""
        date_str = "2026-04-28"
        start_epoch = int(datetime(2026, 4, 28, 23, 0, 0).timestamp() * 1000)
        result, display = parse_time_input("25:00", date_str, start_epoch, None)
        self.assertIsNotNone(result)
        expected = int(datetime(2026, 4, 29, 1, 0, 0).timestamp() * 1000)
        self.assertEqual(result, expected)

    def test_48_00_wraps_two_days_ahead(self):
        """48:00 wraps to 00:00 two days later."""
        date_str = "2026-04-28"
        start_epoch = int(datetime(2026, 4, 28, 23, 0, 0).timestamp() * 1000)
        result, display = parse_time_input("48:00", date_str, start_epoch, None)
        self.assertIsNotNone(result)
        expected = int(datetime(2026, 4, 30, 0, 0, 0).timestamp() * 1000)
        self.assertEqual(result, expected)


# --- P11: Day-Boundary Span — Issue 4: staged entries with no end time ---

class TestSpanningMarkerSafety(unittest.TestCase):
    """Tests for Fix A (display marker) safety with edge cases."""

    def _utc_epoch(self, year, month, day, hour, minute=0, second=0):
        """Return epoch ms for a UTC date/time, avoiding local timezone issues."""
        from datetime import timezone as dt_tz
        dt = datetime(year, month, day, hour, minute, second, tzinfo=dt_tz.utc)
        return int(dt.timestamp() * 1000)

    def _spanning(self, start_epoch, end_epoch):
        """Check if an entry spans multiple days (Fix A logic)."""
        start_date = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
        end_date = time.strftime("%Y-%m-%d", time.gmtime(end_epoch // 1000))
        return end_date != start_date

    def test_crossing_midnight_is_spanning(self):
        """23:30 UTC to 01:00 UTC next day is spanning."""
        start = self._utc_epoch(2026, 4, 28, 23, 30)
        end = self._utc_epoch(2026, 4, 29, 1, 0)
        self.assertTrue(self._spanning(start, end))

    def test_same_day_is_not_spanning(self):
        """10:00 UTC to 12:00 UTC same day is not spanning."""
        start = self._utc_epoch(2026, 4, 28, 10, 0)
        end = self._utc_epoch(2026, 4, 28, 12, 0)
        self.assertFalse(self._spanning(start, end))

    def test_no_end_time_is_not_spanning(self):
        """An entry with no end time cannot be spanning (guard check)."""
        is_spanning = False  # Fix A: if end is None, skip check entirely
        self.assertFalse(is_spanning)

    def test_exact_midnight_boundary_is_spanning(self):
        """23:00 UTC to 00:00 UTC next day triggers spanning."""
        start = self._utc_epoch(2026, 4, 28, 23, 0)
        end = self._utc_epoch(2026, 4, 29, 0, 0)
        self.assertTrue(self._spanning(start, end))

    # --- P11: Day-Boundary Span — Issue 5: end time before start time ---
    # Guard: spanning check should only apply when stop_epoch > start_epoch.
    # If end is before start, the entry is invalid, not spanning.

    def test_end_before_start_same_day_not_spanning(self):
        """End time before start time on the same day is not spanning."""
        start = self._utc_epoch(2026, 4, 28, 14, 0)
        end = self._utc_epoch(2026, 4, 28, 13, 0)  # 1 hour before start
        is_spanning = end > start and (time.strftime("%Y-%m-%d", time.gmtime(end // 1000))
                      != time.strftime("%Y-%m-%d", time.gmtime(start // 1000)))
        self.assertFalse(is_spanning)

    def test_end_before_start_crossing_day_not_spanning(self):
        """End time before start time across a day boundary is not spanning.

        This catches the edge case where end_date != start_date but the
        entry is invalid (end before start), not genuinely spanning.
        """
        start = self._utc_epoch(2026, 4, 29, 14, 0)   # April 29
        end = self._utc_epoch(2026, 4, 28, 1, 0)       # April 28 (earlier!)
        # The guard: only check spanning if stop_epoch > start_epoch
        if end > start:
            is_spanning = (time.strftime("%Y-%m-%d", time.gmtime(end // 1000))
                          != time.strftime("%Y-%m-%d", time.gmtime(start // 1000)))
        else:
            is_spanning = False
        self.assertFalse(is_spanning)

    def test_end_equals_start_not_spanning(self):
        """End time exactly equal to start time is not spanning (guard)."""
        start = self._utc_epoch(2026, 4, 28, 14, 0)
        end = start  # zero-duration entry
        is_spanning = end > start and (time.strftime("%Y-%m-%d", time.gmtime(end // 1000))
                      != time.strftime("%Y-%m-%d", time.gmtime(start // 1000)))
        self.assertFalse(is_spanning)

    # --- P11: Day-Boundary Span — Issue 6: Fix B filter dedup ---
    # Fix B peeks at the previous day's day block to surface spanning entries
    # in date-filtered views. The entry must not appear twice when its original
    # date is already in the filter range.

    def _should_include_from_peek(self, entry_date, filter_from, filter_to, span_start_date):
        """Fix B peek logic: include a spanning entry from a previous day's block
        only if its original date is OUTSIDE the filter range.

        Args:
            entry_date: The date the entry is stored under (its day block's date).
            filter_from: Lower bound of the date filter (or None).
            filter_to: Upper bound of the date filter (or None).
            span_start_date: The entry's original date (same as entry_date).

        Returns:
            True if the entry should be included from the peek.
        """
        # The entry naturally appears under entry_date. Only include via peek
        # if entry_date is NOT in the filter range.
        in_range = True
        if filter_from and entry_date < filter_from:
            in_range = False
        if filter_to and entry_date > filter_to:
            in_range = False
        # If entry_date is in range, it'll appear naturally — skip the peek.
        if in_range:
            return False
        # If entry_date is outside the range, include via peek.
        return True

    def test_spanning_entry_included_when_original_date_outside_range(self):
        """Fix B: spanning entry from April 28 appears when filtering for April 29 only."""
        entry_date = "2026-04-28"
        filter_from = "2026-04-29"
        filter_to = "2026-04-29"
        result = self._should_include_from_peek(entry_date, filter_from, filter_to, entry_date)
        self.assertTrue(result)

    def test_spanning_entry_not_duplicated_when_original_date_in_range(self):
        """Fix B: spanning entry NOT duplicated when filter covers both April 28 and 29."""
        entry_date = "2026-04-28"
        filter_from = "2026-04-28"
        filter_to = "2026-04-29"
        result = self._should_include_from_peek(entry_date, filter_from, filter_to, entry_date)
        self.assertFalse(result)

    def test_spanning_entry_not_duplicated_exact_date_match(self):
        """Fix B: spanning entry NOT duplicated when filter is exactly its original date."""
        entry_date = "2026-04-28"
        filter_from = "2026-04-28"
        filter_to = "2026-04-28"
        result = self._should_include_from_peek(entry_date, filter_from, filter_to, entry_date)
        self.assertFalse(result)

    def test_spanning_entry_included_when_no_filter(self):
        """Fix B: with no date filter, all entries appear under their natural date.
        No peek logic applies because every date is in range.
        """
        entry_date = "2026-04-28"
        result = self._should_include_from_peek(entry_date, None, None, entry_date)
        self.assertFalse(result)

    def test_spanning_entry_included_with_open_ended_to_filter(self):
        """Fix B: spanning entry from April 28 appears when filtering with only to=Apr 27."""
        entry_date = "2026-04-28"
        filter_from = None
        filter_to = "2026-04-27"
        result = self._should_include_from_peek(entry_date, filter_from, filter_to, entry_date)
        self.assertTrue(result)

    def test_spanning_entry_not_duplicated_with_open_ended_from_filter(self):
        """Fix B: spanning entry NOT duplicated when from=Apr 28 with no upper bound."""
        entry_date = "2026-04-28"
        filter_from = "2026-04-28"
        filter_to = None
        result = self._should_include_from_peek(entry_date, filter_from, filter_to, entry_date)
        self.assertFalse(result)

    def test_spanning_multiple_days_peek_previous_only(self):
        """Fix B: only peek at the IMMEDIATE previous day, not all prior days.

        An entry spanning April 28→29 should NOT surface when filtering for April 30.
        The peek is one day back, not N days back.
        """
        entry_date = "2026-04-28"
        filter_from = "2026-04-30"
        filter_to = "2026-04-30"
        # With one-day peek, April 30 peeks at April 29, not April 28.
        # So this entry is NOT found.
        previous_day = "2026-04-29"  # the day before the filter target
        entry_is_previous_day = (entry_date == previous_day)
        result = entry_is_previous_day and self._should_include_from_peek(
            entry_date, filter_from, filter_to, entry_date
        )
        self.assertFalse(result)

    # --- P11: Day-Boundary Span — Issue 7: multiple spanning entries from same day ---
    # Fix B must surface ALL spanning entries from the previous day, not just one.

    def _collect_spanning_from_previous_day(self, prev_day_entries, target_date_str):
        """Simulate Fix B: given entries from the previous day block, return only
        those that span into the target date.

        Args:
            prev_day_entries: List of dicts with 'start_epoch' and 'end_epoch' in UTC ms.
            target_date_str: The date being filtered for (e.g. "2026-04-29").

        Returns:
            List of entries that span into target_date_str.
        """
        result = []
        for entry in prev_day_entries:
            start_epoch = entry["start_epoch"]
            end_epoch = entry["end_epoch"]
            if end_epoch is None or end_epoch <= start_epoch:
                continue
            start_date = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
            end_date = time.strftime("%Y-%m-%d", time.gmtime(end_epoch // 1000))
            # Only include if it spans INTO the target date (not just any different date)
            if end_date != start_date and end_date == target_date_str:
                result.append(entry)
        return result

    def test_multiple_spanning_entries_all_surfaced(self):
        """Fix B: all spanning entries from previous day are surfaced."""
        prev_entries = [
            {"title": "Late Night Coding",
             "start_epoch": self._utc_epoch(2026, 4, 28, 23, 0),
             "end_epoch": self._utc_epoch(2026, 4, 29, 2, 0)},
            {"title": "Movie",
             "start_epoch": self._utc_epoch(2026, 4, 28, 23, 30),
             "end_epoch": self._utc_epoch(2026, 4, 29, 1, 30)},
        ]
        result = self._collect_spanning_from_previous_day(prev_entries, "2026-04-29")
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["title"], "Late Night Coding")
        self.assertEqual(result[1]["title"], "Movie")

    def test_mixed_spanning_and_non_spanning_filtered_correctly(self):
        """Fix B: only spanning entries from the previous day are surfaced,
        non-spanning entries are excluded."""
        prev_entries = [
            {"title": "Late Night Coding",
             "start_epoch": self._utc_epoch(2026, 4, 28, 23, 0),
             "end_epoch": self._utc_epoch(2026, 4, 29, 2, 0)},       # spans → included
            {"title": "Afternoon Work",
             "start_epoch": self._utc_epoch(2026, 4, 28, 14, 0),
             "end_epoch": self._utc_epoch(2026, 4, 28, 16, 0)},       # same day → excluded
            {"title": "Evening Reading",
             "start_epoch": self._utc_epoch(2026, 4, 28, 20, 0),
             "end_epoch": self._utc_epoch(2026, 4, 28, 22, 30)},      # same day → excluded
            {"title": "Night Owl",
             "start_epoch": self._utc_epoch(2026, 4, 28, 23, 45),
             "end_epoch": self._utc_epoch(2026, 4, 29, 0, 30)},       # spans → included
        ]
        result = self._collect_spanning_from_previous_day(prev_entries, "2026-04-29")
        self.assertEqual(len(result), 2)
        titles = [e["title"] for e in result]
        self.assertIn("Late Night Coding", titles)
        self.assertIn("Night Owl", titles)
        self.assertNotIn("Afternoon Work", titles)
        self.assertNotIn("Evening Reading", titles)

    def test_no_spanning_entries_returns_empty(self):
        """Fix B: previous day with no spanning entries returns empty list."""
        prev_entries = [
            {"title": "Morning Work",
             "start_epoch": self._utc_epoch(2026, 4, 28, 9, 0),
             "end_epoch": self._utc_epoch(2026, 4, 28, 12, 0)},
        ]
        result = self._collect_spanning_from_previous_day(prev_entries, "2026-04-29")
        self.assertEqual(len(result), 0)

    def test_empty_previous_day_returns_empty(self):
        """Fix B: previous day with no entries returns empty list."""
        result = self._collect_spanning_from_previous_day([], "2026-04-29")
        self.assertEqual(len(result), 0)

    def test_spanning_entry_must_end_in_target_date(self):
        """Fix B: an entry spanning Apr 28→30 should NOT surface when filtering
        for Apr 29. The end_date must match the target date."""
        prev_entries = [
            {"title": "Marathon Session",
             "start_epoch": self._utc_epoch(2026, 4, 28, 22, 0),
             "end_epoch": self._utc_epoch(2026, 4, 30, 2, 0)},  # spans to Apr 30
        ]
        # Filtering for Apr 29 — entry ends on Apr 30, not Apr 29
        result = self._collect_spanning_from_previous_day(prev_entries, "2026-04-29")
        self.assertEqual(len(result), 0)

    def test_spanning_entry_no_end_time_skipped(self):
        """Fix B: entry with no end time does not crash and is not surfaced."""
        prev_entries = [
            {"title": "Ongoing Task",
             "start_epoch": self._utc_epoch(2026, 4, 28, 23, 0),
             "end_epoch": None},
        ]
        result = self._collect_spanning_from_previous_day(prev_entries, "2026-04-29")
        self.assertEqual(len(result), 0)

    # --- P11: Day-Boundary Span — Issue 8: dedup in combined output ---
    # When both the natural day block and the peek surface the same entry,
    # the final rendered output must contain it exactly once.

    @staticmethod
    def _prev_date_str(date_str):
        """Return the previous date string (YYYY-MM-DD)."""
        from datetime import timedelta
        dt = datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=1)
        return dt.strftime("%Y-%m-%d")

    def _render_dates_with_peek(self, all_day_blocks, filter_from=None, filter_to=None):
        """Simulate the full Fix B rendering: determine the set of dates to show
        (union of day blocks in range + peek results), then for each date collect
        entries from its own day block plus spanning entries peeked from the
        previous day, deduplicated.

        Args:
            all_day_blocks: Dict of {date_str: [entry_dicts]}, each entry has
                'title' and 'start_epoch'.
            filter_from, filter_to: Date filter bounds or None.

        Returns:
            Dict of {date_str: [entry_dicts]} with dedup applied.
        """
        result = {}

        def date_in_range(d):
            if filter_from and d < filter_from:
                return False
            if filter_to and d > filter_to:
                return False
            return True

        # Determine all dates to render: day blocks in range, plus any date
        # that could receive peeked entries (the day after a spanning entry's date)
        render_dates = set()
        for date_str in all_day_blocks:
            if date_in_range(date_str):
                render_dates.add(date_str)
            # If this day block has entries spanning to the next day, the next
            # day might be a render target even if it has no day block of its own
            for entry in all_day_blocks[date_str]:
                end = entry.get("end_epoch")
                if end and end > entry["start_epoch"]:
                    end_date = time.strftime("%Y-%m-%d", time.gmtime(end // 1000))
                    if end_date != date_str and date_in_range(end_date):
                        render_dates.add(end_date)

        for date_str in sorted(render_dates):
            entries = []

            # Add entries from this date's own day block (if it exists)
            if date_str in all_day_blocks:
                entries.extend(all_day_blocks[date_str])

            # Fix B: peek at previous day for spanning entries
            prev_date = self._prev_date_str(date_str)
            if prev_date in all_day_blocks:
                span_candidates = self._collect_spanning_from_previous_day(
                    all_day_blocks[prev_date], date_str
                )
                for span_entry in span_candidates:
                    # Dedup: only add if this entry's original date is OUTSIDE the range
                    original_date = time.strftime(
                        "%Y-%m-%d",
                        time.gmtime(span_entry["start_epoch"] // 1000)
                    )
                    if not date_in_range(original_date):
                        entries.append(span_entry)

            if entries:
                result[date_str] = entries

        return result

    def test_full_range_spanning_entry_not_duplicated(self):
        """Fix A+B: spanning entry appears once when filter covers both days."""
        apr28_start = self._utc_epoch(2026, 4, 28, 23, 0)
        apr28_entry = {"title": "Late Night Coding",
                       "start_epoch": apr28_start,
                       "end_epoch": self._utc_epoch(2026, 4, 29, 2, 0)}
        apr29_entry = {"title": "Morning Work",
                       "start_epoch": self._utc_epoch(2026, 4, 29, 9, 0),
                       "end_epoch": self._utc_epoch(2026, 4, 29, 12, 0)}

        day_blocks = {
            "2026-04-28": [apr28_entry],
            "2026-04-29": [apr29_entry],
        }

        rendered = self._render_dates_with_peek(day_blocks, "2026-04-28", "2026-04-29")

        # The spanning entry should appear only once (under April 28, its natural date)
        self.assertEqual(len(rendered["2026-04-28"]), 1)
        self.assertEqual(len(rendered["2026-04-29"]), 1)
        self.assertEqual(rendered["2026-04-29"][0]["title"], "Morning Work")

    def test_spanning_entry_appears_only_in_target_date_when_original_outside_range(self):
        """Fix B: spanning entry appears only under Apr 29 when filter is just Apr 29.
        Its natural date (Apr 28) is outside the range, so no dedup needed.
        """
        apr28_entry = {"title": "Late Night Coding",
                       "start_epoch": self._utc_epoch(2026, 4, 28, 23, 0),
                       "end_epoch": self._utc_epoch(2026, 4, 29, 2, 0)}

        day_blocks = {
            "2026-04-28": [apr28_entry],
        }

        rendered = self._render_dates_with_peek(day_blocks, "2026-04-29", "2026-04-29")

        self.assertIn("2026-04-29", rendered)
        self.assertEqual(len(rendered["2026-04-29"]), 1)
        self.assertEqual(rendered["2026-04-29"][0]["title"], "Late Night Coding")

    def test_spanning_entry_not_duplicated_across_three_days(self):
        """Fix B: spanning entry appears once even when 3 days are in range."""
        apr28_entry = {"title": "Late Night Coding",
                       "start_epoch": self._utc_epoch(2026, 4, 28, 23, 0),
                       "end_epoch": self._utc_epoch(2026, 4, 29, 2, 0)}
        apr29_entry = {"title": "Regular Work",
                       "start_epoch": self._utc_epoch(2026, 4, 29, 10, 0),
                       "end_epoch": self._utc_epoch(2026, 4, 29, 18, 0)}
        apr30_entry = {"title": "More Work",
                       "start_epoch": self._utc_epoch(2026, 4, 30, 10, 0),
                       "end_epoch": self._utc_epoch(2026, 4, 30, 18, 0)}

        day_blocks = {
            "2026-04-28": [apr28_entry],
            "2026-04-29": [apr29_entry],
            "2026-04-30": [apr30_entry],
        }

        rendered = self._render_dates_with_peek(day_blocks, "2026-04-28", "2026-04-30")

        self.assertEqual(len(rendered["2026-04-28"]), 1)  # Late Night Coding
        self.assertEqual(len(rendered["2026-04-29"]), 1)  # Regular Work (only)
        self.assertEqual(len(rendered["2026-04-30"]), 1)  # More Work (only)

    def test_no_date_filter_no_dedup_needed(self):
        """Fix A+B: with no date filter, each entry appears under its natural date.
        The peek logic doesn't apply because every date is in range.
        """
        apr28_entry = {"title": "Late Night Coding",
                       "start_epoch": self._utc_epoch(2026, 4, 28, 23, 0),
                       "end_epoch": self._utc_epoch(2026, 4, 29, 2, 0)}
        apr29_entry = {"title": "Morning Work",
                       "start_epoch": self._utc_epoch(2026, 4, 29, 9, 0),
                       "end_epoch": self._utc_epoch(2026, 4, 29, 12, 0)}

        day_blocks = {
            "2026-04-28": [apr28_entry],
            "2026-04-29": [apr29_entry],
        }

        rendered = self._render_dates_with_peek(day_blocks, None, None)

        self.assertEqual(len(rendered["2026-04-28"]), 1)  # Late Night Coding
        self.assertEqual(len(rendered["2026-04-29"]), 1)  # Morning Work

    def test_single_date_filter_no_previous_day_no_peek(self):
        """Fix B: filtering for a date with no previous day block — no peek needed."""
        apr29_entry = {"title": "Morning Work",
                       "start_epoch": self._utc_epoch(2026, 4, 29, 9, 0),
                       "end_epoch": self._utc_epoch(2026, 4, 29, 12, 0)}

        day_blocks = {
            "2026-04-29": [apr29_entry],
        }

        rendered = self._render_dates_with_peek(day_blocks, "2026-04-29", "2026-04-29")

        self.assertEqual(len(rendered["2026-04-29"]), 1)
        self.assertEqual(rendered["2026-04-29"][0]["title"], "Morning Work")


if __name__ == "__main__":
    unittest.main()
