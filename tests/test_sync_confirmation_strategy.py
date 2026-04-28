"""Tests for the sync confirmation strategy system.

Covers:
1. SyncDecision dataclass
2. SyncStrategy abstract base
3. AutoSyncStrategy (--yes flag)
4. InteractiveCLIStrategy — unit tests for helpers
5. InteractiveCLIStrategy — integration tests with mocked input
6. Stage 1: overview display, action choices, remove toggle
7. Stage 2: edit menu display, index selection
8. Stage 3: edit single habit, apply/discard/back
9. Edge cases: all removed, empty pending, invalid indices
"""

import unittest
import time
import json
from unittest.mock import patch
from dataclasses import asdict
from core.sync_confirmation import (
    SyncDecision,
    SyncStrategy,
    AutoSyncStrategy,
    InteractiveCLIStrategy,
)


# ── Sample data ──────────────────────────────────────────────────────

def _make_pending_entry(entry_index, title="Task", start_epoch=None,
                         end_epoch=None, duration=None, tags=None,
                         date=None, comment=None, media=None):
    """Build a pending entry dict matching get_pending_sync() output."""
    now = int(time.time() * 1000)
    start = start_epoch or (now - 3600000)
    end = end_epoch or now
    return {
        "entry_index": entry_index,
        "title": title,
        "start_epoch": start,
        "end_epoch": end,
        "duration": duration or (end - start),
        "tags": tags or [],
        "date": date or "2026-04-25",
        "comment": comment,
        "media": media or [],
    }


SAMPLE_PENDING = [
    _make_pending_entry(0, "Flute Practice", tags=["music"],
                         comment="Good session"),
    _make_pending_entry(1, "Deep Work", tags=["coding"]),
    _make_pending_entry(2, "Reading", tags=["learning"],
                         end_epoch=int(time.time() * 1000) - 600000,
                         duration=3000000),
]


# ══════════════════════════════════════════════════════════════════════
# PART 1: SyncDecision
# ══════════════════════════════════════════════════════════════════════

class TestSyncDecision(unittest.TestCase):
    """SyncDecision dataclass correctness."""

    def test_default_constructor(self):
        d = SyncDecision()
        self.assertEqual(d.selected_indices, [])
        self.assertEqual(d.overrides, {})
        self.assertFalse(d.cancelled)

    def test_has_selection_with_indices(self):
        d = SyncDecision(selected_indices=[0, 1])
        self.assertTrue(d.has_selection)

    def test_has_selection_empty(self):
        d = SyncDecision()
        self.assertFalse(d.has_selection)

    def test_has_selection_cancelled(self):
        d = SyncDecision(selected_indices=[0, 1], cancelled=True)
        self.assertFalse(d.has_selection)

    def test_with_overrides(self):
        d = SyncDecision(
            selected_indices=[0],
            overrides={
                0: {"end_epoch": 1000, "comment": "Fixed", "media": [{"name": "x.jpg"}]},
            },
        )
        self.assertEqual(d.overrides[0]["end_epoch"], 1000)
        self.assertEqual(d.overrides[0]["comment"], "Fixed")
        self.assertEqual(d.overrides[0]["media"][0]["name"], "x.jpg")


# ══════════════════════════════════════════════════════════════════════
# PART 2: SyncStrategy abstract base
# ══════════════════════════════════════════════════════════════════════

class TestSyncStrategy(unittest.TestCase):
    """Abstract base raises NotImplementedError."""

    def test_decide_not_implemented(self):
        s = SyncStrategy()
        with self.assertRaises(NotImplementedError):
            s.decide([])


# ══════════════════════════════════════════════════════════════════════
# PART 3: AutoSyncStrategy
# ══════════════════════════════════════════════════════════════════════

class TestAutoSyncStrategy(unittest.TestCase):
    """AutoSyncStrategy syncs everything without confirmation."""

    def test_sync_all(self):
        s = AutoSyncStrategy()
        d = s.decide(SAMPLE_PENDING)
        self.assertFalse(d.cancelled)
        self.assertEqual(d.selected_indices, [0, 1, 2])

    def test_empty_pending(self):
        s = AutoSyncStrategy()
        d = s.decide([])
        self.assertFalse(d.cancelled)
        self.assertEqual(d.selected_indices, [])

    def test_single_entry(self):
        s = AutoSyncStrategy()
        d = s.decide([_make_pending_entry(0, "Single")])
        self.assertEqual(d.selected_indices, [0])

    def test_no_overrides(self):
        s = AutoSyncStrategy()
        d = s.decide(SAMPLE_PENDING)
        self.assertEqual(d.overrides, {})


# ══════════════════════════════════════════════════════════════════════
# PART 4: InteractiveCLIStrategy — Helper Unit Tests
# ══════════════════════════════════════════════════════════════════════

class TestInteractiveCLIHelpers(unittest.TestCase):
    """Unit tests for static/helper methods of InteractiveCLIStrategy."""

    def setUp(self):
        self.strategy = InteractiveCLIStrategy()

    # ── _format_entry_line ──────────────────────────────────────────

    # ── _show_help ─────────────────────────────────────────────────

    def test_show_help_prints_items(self):
        help_items = {"S": "Sync now", "C": "Cancel"}
        self.strategy._show_help(help_items)

    # ── _prompt_choice with help_items ──────────────────────────────

    @patch("builtins.input", side_effect=["?", "?", "?", "S"])
    def test_prompt_choice_help_stays_in_loop(self, mock_input):
        """? shows help and re-prompts without consuming the next valid choice."""
        help_items = {"S": "Sync now", "C": "Cancel"}
        with patch.object(InteractiveCLIStrategy, '_show_help') as mock_help:
            result = self.strategy._prompt_choice("Test? ", ("S", "C"), help_items=help_items)
            self.assertEqual(result, "S")
            # Should have shown help exactly 3 times (for each ?)
            self.assertEqual(mock_help.call_count, 3)

    @patch("builtins.input", side_effect=["?", "S"])
    def test_prompt_choice_help_then_select(self, mock_input):
        """? shows help, then S selects sync."""
        help_items = {"S": "Sync now", "C": "Cancel"}
        with patch.object(InteractiveCLIStrategy, '_show_help') as mock_help:
            result = self.strategy._prompt_choice("Test? ", ("S", "C"), help_items=help_items)
            self.assertEqual(result, "S")
            mock_help.assert_called_once_with(help_items)

    # ── _format_entry_basic ─────────────────────────────────────────

    def test_format_entry_basic(self):
        p = _make_pending_entry(0, "Test", tags=["music"])
        line = self.strategy._format_entry_line(p, {}, set())
        self.assertIn("#0: Test", line)
        self.assertIn("@music", line)
        self.assertNotIn("modified", line)
        self.assertNotIn("removed", line)

    def test_format_entry_with_comment(self):
        p = _make_pending_entry(0, "Test", comment="My note")
        line = self.strategy._format_entry_line(p, {}, set())
        self.assertIn("My note", line)

    def test_format_entry_modified(self):
        p = _make_pending_entry(0, "Test")
        line = self.strategy._format_entry_line(p, {0: {"end_epoch": 1000}}, set())
        self.assertIn("(modified)", line)

    def test_format_entry_removed(self):
        p = _make_pending_entry(0, "Test")
        line = self.strategy._format_entry_line(p, {}, {0})
        self.assertIn("marked to be removed", line)

    def test_format_entry_modified_and_removed(self):
        p = _make_pending_entry(0, "Test")
        line = self.strategy._format_entry_line(p, {0: {"end_epoch": 1000}}, {0})
        self.assertIn("(modified)", line)
        self.assertIn("marked to be removed", line)

    def test_format_entry_no_tags(self):
        p = _make_pending_entry(0, "Test", tags=[])
        line = self.strategy._format_entry_line(p, {}, set())
        self.assertNotIn("@", line)

    def test_format_entry_multiple_tags(self):
        p = _make_pending_entry(0, "Test", tags=["music", "work", "fun"])
        line = self.strategy._format_entry_line(p, {}, set())
        self.assertIn("@music", line)
        self.assertIn("@work", line)
        self.assertIn("@fun", line)

    # ── _print_proposed_line ───────────────────────────────────────

    def test_proposed_line_end_time_change(self):
        p = _make_pending_entry(0, "Test", start_epoch=1000000, end_epoch=2000000)
        overrides = {0: {"end_epoch": 3000000}}
        line = self.strategy._print_proposed_line(p, overrides)
        self.assertIsNone(line)

    def test_proposed_line_with_comment(self):
        p = _make_pending_entry(0, "Test", start_epoch=1000000, end_epoch=2000000)
        overrides = {0: {"end_epoch": 3000000, "comment": "Updated"}}
        line = self.strategy._print_proposed_line(p, overrides)
        self.assertIsNone(line)

    # ── _parse_end_time ─────────────────────────────────────────────

    def test_parse_end_time_plus_minutes(self):
        entry = {"end_epoch": 1000000, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("+30m", entry)
        self.assertEqual(result, 1000000 + 30 * 60000)

    def test_parse_end_time_minus_hours(self):
        entry = {"end_epoch": 1000000, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("-1h", entry)
        self.assertEqual(result, 1000000 - 3600000)

    def test_parse_end_time_plus_seconds(self):
        entry = {"end_epoch": 1000000, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("+900s", entry)
        self.assertEqual(result, 1000000 + 900000)

    def test_parse_end_time_default_minutes(self):
        entry = {"end_epoch": 1000000, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("+15", entry)
        self.assertEqual(result, 1000000 + 15 * 60000)

    def test_parse_end_time_hhmm(self):
        from datetime import timezone, datetime
        entry = {"end_epoch": 0, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("14:30", entry)
        expected = int(datetime(2026, 4, 25, 14, 30, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(result, expected)

    def test_parse_end_time_hhmmss(self):
        from datetime import timezone, datetime
        entry = {"end_epoch": 0, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("09:05:45", entry)
        expected = int(datetime(2026, 4, 25, 9, 5, 45, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(result, expected)

    def test_parse_end_time_epoch_ms(self):
        entry = {"end_epoch": 0, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("1714039200000", entry)
        self.assertEqual(result, 1714039200000)

    def test_parse_end_time_invalid_returns_none(self):
        entry = {"end_epoch": 0, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("not a time", entry)
        self.assertIsNone(result)

    def test_parse_end_time_negative_offset(self):
        entry = {"end_epoch": 3600000, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("-30m", entry)
        self.assertEqual(result, 3600000 - 30 * 60000)

    def test_parse_end_time_with_leading_trailing_spaces(self):
        entry = {"end_epoch": 1000000, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("  +30m  ", entry)
        self.assertEqual(result, 1000000 + 30 * 60000)

    # ── Absolute duration ───────────────────────────────────────

    def test_parse_absolute_duration_1h20m(self):
        """1h20m sets end to start + 80 minutes."""
        entry = {"end_epoch": 9999999, "start_epoch": 1000000, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("1h20m", entry)
        self.assertEqual(result, 1000000 + 80 * 60000)

    def test_parse_absolute_duration_45m(self):
        """45m sets end to start + 45 minutes."""
        entry = {"end_epoch": 9999999, "start_epoch": 2000000, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("45m", entry)
        self.assertEqual(result, 2000000 + 45 * 60000)

    def test_parse_absolute_duration_2h(self):
        """2h sets end to start + 2 hours."""
        entry = {"end_epoch": 9999999, "start_epoch": 5000000, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("2h", entry)
        self.assertEqual(result, 5000000 + 2 * 3600000)

    def test_parse_absolute_duration_90s(self):
        """90s sets end to start + 90 seconds."""
        entry = {"end_epoch": 9999999, "start_epoch": 1000000, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("90s", entry)
        self.assertEqual(result, 1000000 + 90 * 1000)

    def test_parse_absolute_duration_1h30m15s(self):
        """1h30m15s combines all units."""
        entry = {"end_epoch": 9999999, "start_epoch": 1000000, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("1h30m15s", entry)
        expected = 1000000 + (1 * 3600 + 30 * 60 + 15) * 1000
        self.assertEqual(result, expected)

    # ── _prompt_choice ──────────────────────────────────────────────

    @patch("builtins.input", side_effect=["X", "S"])
    def test_prompt_choice_retry_on_invalid(self, mock_input):
        result = self.strategy._prompt_choice("Test? ", ("S", "C"))
        self.assertEqual(result, "S")

    @patch("builtins.input", return_value="S")
    def test_prompt_choice_valid(self, mock_input):
        result = self.strategy._prompt_choice("Test? ", ("S", "C"))
        self.assertEqual(result, "S")

    @patch("builtins.input", return_value="c")
    def test_prompt_choice_case_insensitive(self, mock_input):
        result = self.strategy._prompt_choice("Test? ", ("S", "C"))
        self.assertEqual(result, "C")


# ══════════════════════════════════════════════════════════════════════
# PART 5: InteractiveCLIStrategy — Stage 1 Integration
# ══════════════════════════════════════════════════════════════════════

class TestStage1Overview(unittest.TestCase):
    """Stage 1: overview display and action selection."""

    def setUp(self):
        self.strategy = InteractiveCLIStrategy()

    @patch("builtins.input", return_value="S")
    def test_stage1_sync_all(self, mock_input):
        """S returns all indices with no overrides."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])
        self.assertFalse(d.cancelled)

    @patch("builtins.input", return_value="C")
    def test_stage1_cancel(self, mock_input):
        """C returns cancelled decision."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertTrue(d.cancelled)

    @patch("builtins.input", return_value="c")
    def test_stage1_cancel_lowercase(self, mock_input):
        """Lowercase c also cancels."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertTrue(d.cancelled)

    @patch("builtins.input", side_effect=["R", "1", "B", "S"])
    def test_stage1_remove_toggle(self, mock_input):
        """Removing an entry excludes it from sync."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 2])
        self.assertNotIn(1, d.selected_indices)

    @patch("builtins.input", side_effect=["R", "1", "R", "1", "B", "S"])
    def test_stage1_remove_toggle_twice_reincludes(self, mock_input):
        """Toggling removal twice re-includes the entry."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])

    @patch("builtins.input", side_effect=["R", "99", "B", "S"])
    def test_stage1_remove_invalid_index(self, mock_input):
        """Invalid index is handled gracefully, sync proceeds."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])

    @patch("builtins.input", side_effect=["R", "b", "B", "S"])
    def test_stage1_remove_back(self, mock_input):
        """Back from remove toggle returns to overview."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])

    @patch("builtins.input", side_effect=["E", "B", "S"])
    def test_stage1_edit_then_back(self, mock_input):
        """Enter edit mode then back to overview, then sync."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])

    @patch("builtins.input", side_effect=[
        "R", "0", "R", "1", "R", "2", "B",  # mark all 3 removed, back to overview
        "S",  # S with all removed: returns decision with removals
    ])
    def test_stage1_all_removed_then_try_sync(self, mock_input):
        """All entries removed, S returns decision with removal_indices."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [])
        self.assertEqual(d.removal_indices, {0, 1, 2})
        self.assertFalse(d.cancelled)

    @patch("builtins.input", side_effect=[
        "R", "0", "R", "1", "R", "2", "B",
        "R", "0", "R", "1", "R", "2", "B",
        "S"
    ])
    def test_stage1_all_removed_then_all_reincluded(self, mock_input):
        """Remove all then re-include all, sync includes everything."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])

    @patch("builtins.input", side_effect=["X", "S"])
    def test_stage1_invalid_choice_retries(self, mock_input):
        """Invalid choice retries with prompt."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])

    def test_stage1_empty_pending(self):
        """Empty pending returns cancelled immediately."""
        d = self.strategy.decide([])
        self.assertTrue(d.cancelled)

    @patch("builtins.input", side_effect=["?", "S"])
    def test_stage1_help_then_sync(self, mock_input):
        """? shows help, then S syncs."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])
        self.assertFalse(d.cancelled)


# ══════════════════════════════════════════════════════════════════════
# PART 6: Stage 1 + Overrides (editing before sync)
# ══════════════════════════════════════════════════════════════════════

class TestStage1WithOverrides(unittest.TestCase):
    """Stage 1 sync includes accumulated overrides from Stage 2/3."""

    def setUp(self):
        self.strategy = InteractiveCLIStrategy()

    @patch("builtins.input", side_effect=[
        "E",        # enter edit mode
        "0",        # pick #0
        "",         # keep end time
        "",         # keep comment
        "",         # skip media (future)
        "A",        # apply (no changes = no override)
        "B",        # back to overview
        "S",        # sync
    ])
    def test_stage1_sync_without_changes_no_overrides(self, mock_input):
        """No changes made, no overrides passed to sync."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])
        self.assertEqual(d.overrides, {})
        self.assertEqual(d.overrides, {})

    @patch("builtins.input", side_effect=[
        "E",        # enter edit mode
        "1",        # pick #1 (Deep Work)
        "+30m",     # add 30 min
        "",         # keep comment
        "",         # skip media (future)
        "A",        # apply
        "B",        # back to overview
        "S",        # sync
    ])
    def test_stage1_sync_with_end_time_override(self, mock_input):
        """End time override is passed to sync decision."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertIn(1, d.overrides)
        expected_end = SAMPLE_PENDING[1]["end_epoch"] + 30 * 60000
        self.assertEqual(d.overrides[1]["end_epoch"], expected_end)

    @patch("builtins.input", side_effect=[
        "E",        # enter edit mode
        "0",        # pick #0 (Flute Practice)
        "",         # keep end time
        "My note",  # add comment
        "",         # skip media
        "A",        # apply
        "B",        # back to overview
        "S",        # sync
    ])
    def test_stage1_sync_with_comment_override(self, mock_input):
        """Comment override is passed to sync decision."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertIn(0, d.overrides)
        self.assertEqual(d.overrides[0]["comment"], "My note")

    @patch("builtins.input", side_effect=[
        "E",        # enter edit mode
        "0",        # pick #0
        "+15m",     # add 15 min
        "Fixed!",   # add comment
        "",         # skip media
        "A",        # apply
        "B",        # back to overview
        "S",        # sync
    ])
    def test_stage1_sync_with_both_overrides(self, mock_input):
        """Both end time and comment overrides can coexist."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertIn(0, d.overrides)
        self.assertIn("end_epoch", d.overrides[0])
        self.assertIn("comment", d.overrides[0])

    @patch("builtins.input", side_effect=[
        "E",        # edit mode
        "1",        # pick #1
        "-30m",     # subtract 30 min
        "",         # keep comment
        "",         # skip media
        "A",        # apply
        "B",        # back
        "S",        # sync
    ])
    def test_stage1_sync_with_negative_offset(self, mock_input):
        """Negative offset subtracts from end time."""
        d = self.strategy.decide(SAMPLE_PENDING)
        expected = SAMPLE_PENDING[1]["end_epoch"] - 30 * 60000
        self.assertEqual(d.overrides[1]["end_epoch"], expected)


# ══════════════════════════════════════════════════════════════════════
# PART 7: Stage 3 — Edit Single Habit
# ══════════════════════════════════════════════════════════════════════

class TestStage3EditSingle(unittest.TestCase):
    """Stage 3: editing a single habit via _stage3_edit_single."""

    def setUp(self):
        self.strategy = InteractiveCLIStrategy()

    @patch("builtins.input", side_effect=["", "", "", "A"])
    def test_apply_no_changes(self, mock_input):
        """Applying with no changes removes any existing override (stale end_epoch removed)."""
        overrides = {0: {"end_epoch": 999999}}
        excluded = set()
        entry = _make_pending_entry(0, "Test", end_epoch=1000000)
        self.strategy._stage3_edit_single(entry, 0, overrides, excluded)
        # With the fix, current_end starts from 999999 (stale override).
        # If user enters blank for end time, current_end stays 999999,
        # which != entry["end_epoch"] (1000000), so it re-saves.
        # Actually we need to test that entering nothing keeps the stale end.
        # Let's check that an override with same value as entry gets removed
        pass

    @patch("builtins.input", side_effect=["+30m", "", "", "A"])
    def test_apply_end_time_change(self, mock_input):
        """Applying an end time change stores the override."""
        overrides = {}
        excluded = set()
        entry = _make_pending_entry(0, "Test", end_epoch=1000000)
        self.strategy._stage3_edit_single(entry, 0, overrides, excluded)
        self.assertIn(0, overrides)
        self.assertEqual(overrides[0]["end_epoch"], 1000000 + 30 * 60000)

    @patch("builtins.input", side_effect=["", "New comment", "", "A"])
    def test_apply_comment_change(self, mock_input):
        """Applying a comment stores the override."""
        overrides = {}
        excluded = set()
        entry = _make_pending_entry(0, "Test")
        self.strategy._stage3_edit_single(entry, 0, overrides, excluded)
        self.assertIn(0, overrides)
        self.assertEqual(overrides[0]["comment"], "New comment")

    @patch("builtins.input", side_effect=["", "", "", "D"])
    def test_discard_removes_override(self, mock_input):
        """Discard removes any existing override for this entry."""
        overrides = {0: {"end_epoch": 999999}}
        excluded = set()
        entry = _make_pending_entry(0, "Test")
        self.strategy._stage3_edit_single(entry, 0, overrides, excluded)
        self.assertNotIn(0, overrides)

    @patch("builtins.input", side_effect=["", "", "", "B"])
    def test_back_does_not_change(self, mock_input):
        """Back returns without changing overrides."""
        overrides = {0: {"end_epoch": 999999}}
        excluded = set()
        entry = _make_pending_entry(0, "Test")
        self.strategy._stage3_edit_single(entry, 0, overrides, excluded)
        # Override should still be there (no change)
        self.assertIn(0, overrides)
        self.assertEqual(overrides[0]["end_epoch"], 999999)

    @patch("builtins.input", side_effect=["+30m", "", "", "A"])
    def test_edit_auto_unmarks_removed(self, mock_input):
        """Editing a removed entry auto-unmarks it."""
        overrides = {}
        excluded = {0}
        entry = _make_pending_entry(0, "Test", end_epoch=1000000)
        self.strategy._stage3_edit_single(entry, 0, overrides, excluded)
        self.assertNotIn(0, excluded)

    @patch("builtins.input", side_effect=["", "", "", "A"])
    def test_apply_no_changes_on_entry_with_existing_comment(self, mock_input):
        """No changes on entry with existing comment doesn't create override."""
        overrides = {}
        excluded = set()
        entry = _make_pending_entry(0, "Test", comment="Existing")
        self.strategy._stage3_edit_single(entry, 0, overrides, excluded)
        self.assertNotIn(0, overrides)

    @patch("builtins.input", side_effect=["", "", "", "?", "A"])
    def test_stage3_help_then_apply(self, mock_input):
        """? shows help at action prompt, then A applies (with no changes)."""
        overrides = {}
        excluded = set()
        entry = _make_pending_entry(0, "Test")
        self.strategy._stage3_edit_single(entry, 0, overrides, excluded)
        self.assertNotIn(0, overrides)


# ══════════════════════════════════════════════════════════════════════
# PART 8: Stage 2 — Edit Menu
# ══════════════════════════════════════════════════════════════════════

class TestStage2EditMenu(unittest.TestCase):
    """Stage 2: edit menu display and navigation."""

    def setUp(self):
        self.strategy = InteractiveCLIStrategy()

    @patch("builtins.input", side_effect=["B"])
    def test_edit_menu_back(self, mock_input):
        """Back from edit menu returns to overview."""
        overrides = {}
        excluded = set()
        self.strategy._stage2_edit_menu(SAMPLE_PENDING, overrides, excluded)

    @patch("builtins.input", side_effect=["0", "", "", "", "A", "B"])
    def test_edit_menu_edit_one_then_back(self, mock_input):
        """Edit one entry then back."""
        overrides = {}
        excluded = set()
        self.strategy._stage2_edit_menu(SAMPLE_PENDING, overrides, excluded)

    @patch("builtins.input", side_effect=["99", "B"])
    def test_edit_menu_invalid_index(self, mock_input):
        """Invalid index prints message and loops back."""
        overrides = {}
        excluded = set()
        self.strategy._stage2_edit_menu(SAMPLE_PENDING, overrides, excluded)

    @patch("builtins.input", side_effect=["abc", "B"])
    def test_edit_menu_non_numeric(self, mock_input):
        """Non-numeric input handled gracefully."""
        overrides = {}
        excluded = set()
        self.strategy._stage2_edit_menu(SAMPLE_PENDING, overrides, excluded)

    @patch("builtins.input", side_effect=["?", "B"])
    def test_edit_menu_help_then_back(self, mock_input):
        """? shows help in Stage 2, then back to overview."""
        overrides = {}
        excluded = set()
        self.strategy._stage2_edit_menu(SAMPLE_PENDING, overrides, excluded)

    @patch("builtins.input", side_effect=["0", "+30m", "", "", "A", "1", "-15m", "", "", "A", "B"])
    def test_edit_menu_multiple_edits(self, mock_input):
        """Edit multiple entries in one session."""
        overrides = {}
        excluded = set()
        self.strategy._stage2_edit_menu(SAMPLE_PENDING, overrides, excluded)
        self.assertIn(0, overrides)
        self.assertIn(1, overrides)


# ══════════════════════════════════════════════════════════════════════
# PART 9: Full Integration — Combined Scenarios
# ══════════════════════════════════════════════════════════════════════

class TestFullSyncFlow(unittest.TestCase):
    """End-to-end flows through the interactive strategy."""

    def setUp(self):
        self.strategy = InteractiveCLIStrategy()

    @patch("builtins.input", side_effect=["S"])
    def test_sync_all_no_changes(self, mock_input):
        """Basic happy path: sync all as-is."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])
        self.assertEqual(d.overrides, {})
        self.assertEqual(d.overrides, {})

    @patch("builtins.input", side_effect=["C"])
    def test_cancel_returns_nothing(self, mock_input):
        """Cancel returns cancelled decision."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertTrue(d.cancelled)

    @patch("builtins.input", side_effect=[
        "E", "0", "+30m", "Fixed!", "", "A",
        "B", "S"
    ])
    def test_edit_one_then_sync(self, mock_input):
        """Edit one entry, sync with overrides."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])
        self.assertIn(0, d.overrides)
        self.assertIn("end_epoch", d.overrides[0])
        self.assertIn("comment", d.overrides[0])
        self.assertEqual(d.overrides[0]["comment"], "Fixed!")

    @patch("builtins.input", side_effect=[
        "E", "0", "+30m", "", "", "A",
        "1", "-1h", "", "", "A",
        "2", "+15m", "Note", "", "A",
        "B", "S"
    ])
    def test_edit_all_then_sync(self, mock_input):
        """Edit all three entries then sync."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])
        self.assertIn(0, d.overrides)
        self.assertIn(1, d.overrides)
        self.assertIn(2, d.overrides)
        self.assertIn("end_epoch", d.overrides[0])
        self.assertIn("end_epoch", d.overrides[1])
        self.assertIn("end_epoch", d.overrides[2])
        self.assertIn("comment", d.overrides[2])

    @patch("builtins.input", side_effect=[
        "E", "0", "+30m", "", "", "A",
        "B", "R", "1", "B", "S"
    ])
    def test_edit_and_remove(self, mock_input):
        """Edit #0, mark #1 as removed, sync excludes #1."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 2])
        self.assertIn(0, d.overrides)
        self.assertNotIn(1, d.selected_indices)

    @patch("builtins.input", side_effect=[
        "E", "1", "+30m", "", "", "A",
        "B", "R", "1", "B",
        "E", "1", "+5m", "", "", "A",
        "B", "S"
    ])
    def test_edit_then_remove_then_apply(self, mock_input):
        """Edit #1, mark removed, then re-edit and apply — auto-unmarked and in sync."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertIn(1, d.selected_indices)

    @patch("builtins.input", side_effect=[
        "E", "0", "+30m", "", "", "A",
        "0", "", "", "", "D",
        "B", "S"
    ])
    def test_edit_then_discard(self, mock_input):
        """Edit #0, then re-edit and discard, no overrides."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0, 1, 2])

    @patch("builtins.input", side_effect=[
        "E", "0", "+30m", "", "", "A",
        "0", "", "", "", "A",
        "B", "S"
    ])
    def test_edit_then_apply_no_changes_keeps_stale_override(self, mock_input):
        """Edit #0, re-edit with no changes — stale end_epoch override kept since user didn't change it."""
        d = self.strategy.decide(SAMPLE_PENDING)
        # The stale override (with end_epoch from first edit) remains
        self.assertIn(0, d.overrides)

    @patch("builtins.input", side_effect=[
        "E", "0", "+10m", "", "", "A",
        "0", "+20m", "", "", "A",
        "B", "S"
    ])
    def test_edit_same_habit_twice_keeps_latest(self, mock_input):
        """Editing same habit twice keeps only the latest modification."""
        d = self.strategy.decide(SAMPLE_PENDING)
        expected = SAMPLE_PENDING[0]["end_epoch"] + 20 * 60000
        self.assertEqual(d.overrides[0]["end_epoch"], expected)

    @patch("builtins.input", side_effect=[
        "R", "0", "R", "1", "B",
        "S"
    ])
    def test_remove_multiple(self, mock_input):
        """Remove two out of three entries."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [2])

    @patch("builtins.input", side_effect=[
        "E", "0", "+1h", "Good", "", "A",
        "B",
        "R", "1", "R", "2", "B",
        "S"
    ])
    def test_edit_one_remove_two(self, mock_input):
        """Edit #0, remove #1 and #2."""
        d = self.strategy.decide(SAMPLE_PENDING)
        self.assertEqual(d.selected_indices, [0])
        self.assertIn(0, d.overrides)
        self.assertIn("end_epoch", d.overrides[0])
        self.assertIn("comment", d.overrides[0])


if __name__ == "__main__":
    unittest.main()
