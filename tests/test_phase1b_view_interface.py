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

    def test_large_raw_epoch(self):
        epoch = 2000000000000
        result, display = parse_time_input(str(epoch), "2026-01-15", 1000, 2000)
        self.assertEqual(result, epoch)


if __name__ == "__main__":
    unittest.main()
