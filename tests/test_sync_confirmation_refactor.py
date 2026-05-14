"""Tests for the proposed refactored sync confirmation strategy system.

This file defines the interface contracts for the refactored design:

1. SyncRenderer base — rendering interface for themes
2. ConsoleRenderer — concrete console implementation
3. SyncPrompter base — input interface
4. ConsolePrompter — concrete console implementation
5. InteractiveCLIStrategy — refactored to accept renderer + prompter via DI
6. Theme composability — swapping renderers doesn't change behavior

All tests are in RED phase (not implemented yet) — they define the API.
"""

import unittest
import time
from unittest.mock import patch, MagicMock
from typing import Optional, List, Dict, Any, Set


# ══════════════════════════════════════════════════════════════════════
# Sample data helper
# ══════════════════════════════════════════════════════════════════════

def _make_pending_entry(entry_index, title="Task", start_epoch=None,
                         end_epoch=None, duration=None, tags=None,
                         date=None, comment=None, media=None):
    now = int(time.time() * 1000)
    start = start_epoch if start_epoch is not None else (now - 3600000)
    end = end_epoch if end_epoch is not None else now
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


# ══════════════════════════════════════════════════════════════════════
# Stub implementations — these define the API contracts for refactor
# ══════════════════════════════════════════════════════════════════════

class SyncRenderer:
    def heading(self, text):
        raise NotImplementedError
    def entry_line(self, p, overrides, excluded, is_proposed=False):
        raise NotImplementedError
    def proposed_line(self, p, overrides):
        raise NotImplementedError
    def duration_str(self, ms):
        raise NotImplementedError
    def help_table(self, help_items):
        raise NotImplementedError
    def message(self, text):
        raise NotImplementedError
    def error(self, text):
        raise NotImplementedError


class ConsoleRenderer(SyncRenderer):
    def heading(self, text):
        return f"--- {text} ---"

    def entry_line(self, p, overrides, excluded, is_proposed=False):
        tags_str = f" [@{', @'.join(p['tags'])}]" if p["tags"] else ""
        override = overrides.get(p["entry_index"], {})
        end_epoch = override.get("end_epoch", p["end_epoch"])
        start_str = time.strftime("%H:%M", time.localtime(p["start_epoch"] // 1000))
        end_str = time.strftime("%H:%M", time.localtime(end_epoch // 1000))
        dur = end_epoch - p["start_epoch"]
        comment = override.get("comment", p.get("comment"))
        comment_str = f' "{comment}"' if comment else ""
        line = (f"  #{p['entry_index']}: {p['title']}{tags_str} | {p['date']} | "
                f"{start_str}-{end_str} | {self.duration_str(dur)}{comment_str}")
        if p["entry_index"] in overrides:
            line += " (modified)"
        if p["entry_index"] in excluded:
            line += "  ~~marked to be removed~~"
        return line

    def proposed_line(self, p, overrides):
        override = overrides[p["entry_index"]]
        start_str = time.strftime("%H:%M", time.localtime(p["start_epoch"] // 1000))
        end_epoch = override.get("end_epoch", p["end_epoch"])
        end_str = time.strftime("%H:%M", time.localtime(end_epoch // 1000))
        dur = end_epoch - p["start_epoch"]
        comment = override.get("comment", p.get("comment"))
        comment_str = f'  comment: "{comment}"' if comment else ""
        return (f"       proposed: {start_str}-{end_str}, "
                f"duration {self.duration_str(dur)}{comment_str}")

    def duration_str(self, ms):
        total_seconds = ms // 1000
        h = total_seconds // 3600
        m = (total_seconds % 3600) // 60
        s = total_seconds % 60
        return f"{h:02d}h{m:02d}m{s:02d}s"

    def help_table(self, help_items):
        lines = ["\nAvailable commands:"]
        for key, desc in sorted(help_items.items()):
            lines.append(f"  {key} -- {desc}")
        lines.append("")
        return "\n".join(lines)

    def message(self, text):
        return text

    def error(self, text):
        return f"ERROR: {text}"


class SyncPrompter:
    def choice(self, prompt, valid_options, help_items=None):
        raise NotImplementedError
    def text(self, prompt):
        raise NotImplementedError
    def integer(self, prompt, valid_range=None, allow_back=False):
        raise NotImplementedError


class ConsolePrompter(SyncPrompter):
    def __init__(self):
        self.renderer = None

    def choice(self, prompt, valid_options, help_items=None):
        effective = set(valid_options)
        if help_items is not None:
            effective.add("?")
        while True:
            inp = input(prompt).strip().upper()
            if inp in effective:
                if inp == "?" and help_items is not None and self.renderer is not None:
                    print(self.renderer.help_table(help_items))
                    continue
                return inp
            print(f"Invalid choice. Options: {', '.join(sorted(effective))}")

    def text(self, prompt):
        return input(prompt).strip()

    def integer(self, prompt, valid_range=None, allow_back=False):
        while True:
            inp = input(prompt).strip()
            if allow_back and inp.lower() in ("b", "back", ""):
                return "B"
            try:
                val = int(inp)
                if valid_range is not None:
                    if valid_range[0] <= val <= valid_range[1]:
                        return val
                    else:
                        print(f"Value must be between {valid_range[0]} and {valid_range[1]}.")
                else:
                    return val
            except ValueError:
                print("Invalid input. Enter a number.")


class RefactoredInteractiveCLIStrategy:
    def __init__(self, renderer=None, prompter=None):
        self.renderer = renderer or ConsoleRenderer()
        self.prompter = prompter or ConsolePrompter()
        self.prompter.renderer = self.renderer

    def decide(self, pending):
        if not pending:
            return SyncDecision(cancelled=True)

        overrides = {}
        excluded = set()

        while True:
            choice = self._stage1_overview(pending, overrides, excluded)
            if choice == "S":
                selected = [p["entry_index"] for p in pending
                            if p["entry_index"] not in excluded]
                if not selected:
                    print(self.renderer.message("All entries have been marked for removal. Nothing to sync."))
                    continue
                return RefactoredInteractiveCLIStrategy._build_sync_decision(selected, overrides)
            elif choice == "C":
                print(self.renderer.message("Sync cancelled."))
                return SyncDecision(cancelled=True)
            elif choice == "E":
                self._stage2_edit_menu(pending, overrides, excluded)
            elif choice == "R":
                self._stage1_remove_toggle(pending, excluded)

    def _stage1_overview(self, pending, overrides, excluded):
        print(self.renderer.heading("Pending Sync"))
        for p in pending:
            print(self.renderer.entry_line(p, overrides, excluded))
        print()
        help_items = {
            "S": "Sync now (confirm all pending entries)",
            "E": "Edit modifications (end time, comment)",
            "R": "Toggle removal for a habit",
            "C": "Cancel (discard all changes)",
        }
        return self.prompter.choice(
            "[S]ync now, [E]dit, [R]emove, [C]ancel, [?] help? ",
            ("S", "E", "R", "C"), help_items=help_items
        )

    def _stage1_remove_toggle(self, pending, excluded):
        target = self.prompter.integer(
            "Which habit to toggle removal? (index, or [B]ack): ",
            allow_back=True
        )
        if target == "B":
            return
        indices = [p["entry_index"] for p in pending]
        if target not in indices:
            print(self.renderer.error(f"Invalid index {target}. Valid indices: {indices}"))
            return
        if target in excluded:
            excluded.discard(target)
            print(self.renderer.message(f"  #{target} is no longer marked for removal."))
        else:
            excluded.add(target)
            print(self.renderer.message(f"  #{target} marked to be removed."))

    def _stage2_edit_menu(self, pending, overrides, excluded):
        help_items = {
            "<index>": "Edit the habit with this index number",
            "B": "Back to overview (return to sync summary)",
        }
        while True:
            print(self.renderer.heading("Edit Mode"))
            for p in pending:
                print(self.renderer.entry_line(p, overrides, excluded))
                if p["entry_index"] in overrides:
                    print(self.renderer.proposed_line(p, overrides))
            print()
            target = self.prompter.integer(
                "Choose habit by index, [B]ack, [?] help: ",
                allow_back=True
            )
            if target == "B":
                return
            indices = [p["entry_index"] for p in pending]
            if target not in indices:
                print(self.renderer.error(f"Invalid index {target}. Valid indices: {indices}"))
                continue
            entry = next(p for p in pending if p["entry_index"] == target)
            self._stage3_edit_single(entry, target, overrides, excluded)

    def _stage3_edit_single(self, entry, target_idx, overrides, excluded):
        current_override = overrides.get(target_idx, {})
        current_end = current_override.get("end_epoch", entry["end_epoch"])
        current_comment = current_override.get("comment", entry.get("comment"))

        while True:
            print(f"\nEditing #{target_idx}: {entry['title']}")
            orig_start = time.strftime("%H:%M", time.localtime(entry["start_epoch"] // 1000))
            orig_end = time.strftime("%H:%M", time.localtime(entry["end_epoch"] // 1000))
            prop_start = time.strftime("%H:%M", time.localtime(entry["start_epoch"] // 1000))
            prop_end = time.strftime("%H:%M", time.localtime(current_end // 1000))
            prop_dur = current_end - entry["start_epoch"]

            print(self.renderer.message(
                f"  Original: {orig_start}-{orig_end}, duration {self.renderer.duration_str(entry['duration'])}"
                + (f'  comment: "{entry["comment"]}"' if entry.get('comment') else '')
            ))
            print(self.renderer.message(
                f"  Proposed: {prop_start}-{prop_end}, duration {self.renderer.duration_str(prop_dur)}"
                + (f'  comment: "{current_comment}"' if current_comment else '')
            ))
            print()

            # End time
            end_input = self.prompter.text(
                f"  End time (blank=keep {prop_end}, HH:MM, +N[m|h|s], N[h][m][s] duration, or epoch ms): "
            )
            if end_input:
                new_end = self._parse_end_time(end_input, entry)
                if new_end is not None:
                    current_end = new_end
                    prop_end = time.strftime("%H:%M", time.localtime(current_end // 1000))
                    prop_dur = current_end - entry["start_epoch"]
                    print(self.renderer.message(
                        f"    New end: {prop_end}, duration: {self.renderer.duration_str(prop_dur)}"
                    ))
                else:
                    print(self.renderer.error(f"    Invalid format, keeping {prop_end}."))

            # Comment
            if current_comment:
                comment_input = self.prompter.text(f'  Comment ("{current_comment}", or edit/clear): ')
            else:
                comment_input = self.prompter.text("  Comment (optional): ")
            if comment_input:
                current_comment = comment_input
            elif comment_input == "" and not current_override.get("comment"):
                pass

            # Media (stub)
            media_input = self.prompter.text("  Media (not yet supported, press Enter to skip): ")
            if media_input:
                print(self.renderer.message("  Media editing is not yet supported."))

            # Actions
            help_items = {
                "A": "Apply changes (save this edit)",
                "D": "Discard changes for this habit",
                "B": "Back to edit menu without changes",
            }
            action = self.prompter.choice(
                "  [A]pply, [D]iscard, [B]ack, [?] help? ",
                ("A", "D", "B"), help_items=help_items
            )

            if action == "A":
                override = {}
                if current_end != entry["end_epoch"]:
                    override["end_epoch"] = current_end
                if current_comment != entry.get("comment"):
                    if current_comment:
                        override["comment"] = current_comment
                    else:
                        override["comment"] = ""
                if override:
                    overrides[target_idx] = override
                    if target_idx in excluded:
                        excluded.discard(target_idx)
                    print(self.renderer.message(f"  Applied changes to #{target_idx}: {entry['title']}"))
                else:
                    overrides.pop(target_idx, None)
                    print(self.renderer.message("  No changes to apply."))
                return
            elif action == "D":
                overrides.pop(target_idx, None)
                print(self.renderer.message(f"  Discarded changes for #{target_idx}: {entry['title']}"))
                return
            elif action == "B":
                return

    @staticmethod
    def _parse_end_time(end_input, entry):
        end_input = end_input.strip()
        new_end = None
        if end_input.startswith("+") or end_input.startswith("-"):
            try:
                offset_str = end_input.lstrip("+-").strip()
                if offset_str.endswith("m"):
                    offset_ms = int(offset_str[:-1]) * 60000
                elif offset_str.endswith("h"):
                    offset_ms = int(offset_str[:-1]) * 3600000
                elif offset_str.endswith("s"):
                    offset_ms = int(offset_str[:-1]) * 1000
                else:
                    offset_ms = int(offset_str) * 60000
                if end_input.startswith("-"):
                    offset_ms = -offset_ms
                new_end = entry["end_epoch"] + offset_ms
            except ValueError:
                pass
        elif "h" in end_input or "m" in end_input or "s" in end_input:
            try:
                import re
                has_digits_before_unit = bool(re.search(r"\d+(?:h|m|s)", end_input))
                if has_digits_before_unit:
                    h = m = s = 0
                    h_match = re.search(r"(\d+)h", end_input)
                    m_match = re.search(r"(\d+)m", end_input)
                    s_match = re.search(r"(\d+)s", end_input)
                    if h_match:
                        h = int(h_match.group(1))
                    if m_match:
                        m = int(m_match.group(1))
                    if s_match:
                        s = int(s_match.group(1))
                    duration_ms = (h * 3600 + m * 60 + s) * 1000
                    new_end = entry["start_epoch"] + duration_ms
            except ValueError:
                pass
        else:
            try:
                parts = end_input.split(":")
                from datetime import timezone, datetime
                date_parts = entry["date"].split("-")
                if len(parts) == 2:
                    h, m = int(parts[0]), int(parts[1])
                    s = 0
                elif len(parts) == 3:
                    h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
                else:
                    raise ValueError
                dt = datetime(int(date_parts[0]), int(date_parts[1]), int(date_parts[2]),
                              h, m, s, tzinfo=timezone.utc)
                new_end = int(dt.timestamp() * 1000)
            except (ValueError, IndexError):
                try:
                    new_end = int(end_input)
                except ValueError:
                    pass
        return new_end

    @staticmethod
    def _build_sync_decision(selected, overrides):
        """Build a SyncDecision from selected indices and overrides dict."""
        result_overrides = {}
        for idx, ov in sorted(overrides.items()):
            filtered = {}
            if "end_epoch" in ov:
                filtered["end_epoch"] = ov["end_epoch"]
            if "comment" in ov:
                filtered["comment"] = ov["comment"]
            if "media" in ov:
                filtered["media"] = ov["media"]
            if filtered:
                result_overrides[idx] = filtered
        return SyncDecision(
            selected_indices=selected,
            overrides=result_overrides if result_overrides else {},
        )


# Need SyncDecision from existing module
from core.sync.decision import SyncDecision
from cli.strategies import AutoSyncStrategy


# ══════════════════════════════════════════════════════════════════════
# PART 1: SyncRenderer Interface Tests
# ══════════════════════════════════════════════════════════════════════

class TestSyncRendererInterface(unittest.TestCase):
    def test_heading_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncRenderer().heading("Test")

    def test_entry_line_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncRenderer().entry_line({}, {}, set(), is_proposed=False)

    def test_proposed_line_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncRenderer().proposed_line({}, {})

    def test_duration_str_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncRenderer().duration_str(3600000)

    def test_help_table_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncRenderer().help_table({"S": "Sync"})

    def test_message_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncRenderer().message("Hello")

    def test_error_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncRenderer().error("Oops")


class TestConsoleRenderer(unittest.TestCase):
    def setUp(self):
        self.renderer = ConsoleRenderer()

    def test_heading_returns_formatted_text(self):
        result = self.renderer.heading("Pending Sync")
        self.assertIn("Pending Sync", result)
        self.assertIn("---", result)

    def test_entry_line_basic(self):
        p = _make_pending_entry(0, "Test", tags=["music"])
        line = self.renderer.entry_line(p, {}, set())
        self.assertIn("#0: Test", line)
        self.assertIn("@music", line)

    def test_entry_line_shows_start_end_range(self):
        p = _make_pending_entry(0, "Test", start_epoch=1000000, end_epoch=2000000)
        line = self.renderer.entry_line(p, {}, set())
        self.assertIn("-", line)

    def test_entry_line_shows_hhmmss_duration(self):
        p = _make_pending_entry(0, "Test", start_epoch=0, end_epoch=3600000)
        line = self.renderer.entry_line(p, {}, set())
        self.assertIn("01h00m00s", line)

    def test_entry_line_with_comment(self):
        p = _make_pending_entry(0, "Test", comment="My note")
        line = self.renderer.entry_line(p, {}, set())
        self.assertIn("My note", line)

    def test_entry_line_proposed_values_when_overridden(self):
        p = _make_pending_entry(0, "Test", start_epoch=0, end_epoch=3600000)
        line = self.renderer.entry_line(p, {0: {"end_epoch": 7200000}}, set())
        self.assertIn("02h00m00s", line)
        self.assertNotIn("01h00m00s", line)

    def test_entry_line_modified_flag(self):
        p = _make_pending_entry(0, "Test")
        line = self.renderer.entry_line(p, {0: {"end_epoch": 9999999}}, set())
        self.assertIn("(modified)", line)

    def test_entry_line_removed_flag(self):
        p = _make_pending_entry(0, "Test")
        line = self.renderer.entry_line(p, {}, {0})
        self.assertIn("removed", line.lower())

    def test_entry_line_no_tags(self):
        p = _make_pending_entry(0, "Test", tags=[])
        line = self.renderer.entry_line(p, {}, set())
        self.assertNotIn("@", line)

    def test_entry_line_multiple_tags(self):
        p = _make_pending_entry(0, "Test", tags=["a", "b", "c"])
        line = self.renderer.entry_line(p, {}, set())
        self.assertIn("@a", line)
        self.assertIn("@b", line)
        self.assertIn("@c", line)

    def test_proposed_line_shows_changes(self):
        p = _make_pending_entry(0, "Test", start_epoch=0, end_epoch=3600000)
        line = self.renderer.proposed_line(p, {0: {"end_epoch": 7200000}})
        self.assertIn("02h00m00s", line)
        self.assertIn("proposed", line.lower())

    def test_proposed_line_with_comment(self):
        p = _make_pending_entry(0, "Test")
        line = self.renderer.proposed_line(p, {0: {"comment": "Updated"}})
        self.assertIn("Updated", line)

    def test_duration_str_returns_hhmmss(self):
        self.assertEqual(self.renderer.duration_str(0), "00h00m00s")
        self.assertEqual(self.renderer.duration_str(3600000), "01h00m00s")
        self.assertEqual(self.renderer.duration_str(3661000), "01h01m01s")
        self.assertEqual(self.renderer.duration_str(4800000), "01h20m00s")
        self.assertEqual(self.renderer.duration_str(5415000), "01h30m15s")

    def test_help_table_returns_formatted_string(self):
        items = {"S": "Sync now", "C": "Cancel"}
        result = self.renderer.help_table(items)
        self.assertIn("S", result)
        self.assertIn("Sync now", result)

    def test_message_returns_string(self):
        result = self.renderer.message("Done")
        self.assertIn("Done", result)

    def test_error_returns_string(self):
        result = self.renderer.error("Failed")
        self.assertIn("Failed", result)


# ══════════════════════════════════════════════════════════════════════
# PART 2: SyncPrompter Interface Tests
# ══════════════════════════════════════════════════════════════════════

class TestSyncPrompterInterface(unittest.TestCase):
    def test_choice_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncPrompter().choice("Go?", ("S", "C"))

    def test_text_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncPrompter().text("Enter name")

    def test_integer_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            SyncPrompter().integer("Enter index", valid_range=(0, 10))


class TestConsolePrompter(unittest.TestCase):
    def setUp(self):
        self.prompter = ConsolePrompter()
        self.renderer = MagicMock(spec=SyncRenderer)
        self.prompter.renderer = self.renderer

    @patch("builtins.input", return_value="S")
    def test_choice_returns_valid_option(self, mock_input):
        result = self.prompter.choice("Go? ", ("S", "C"))
        self.assertEqual(result, "S")

    @patch("builtins.input", side_effect=["X", "S"])
    def test_choice_retries_on_invalid(self, mock_input):
        result = self.prompter.choice("Go? ", ("S", "C"))
        self.assertEqual(result, "S")

    @patch("builtins.input", return_value="c")
    def test_choice_case_insensitive(self, mock_input):
        result = self.prompter.choice("Go? ", ("S", "C"))
        self.assertEqual(result, "C")

    @patch("builtins.input", side_effect=["?", "S"])
    def test_choice_help_shows_help_then_selects(self, mock_input):
        help_items = {"S": "Sync", "C": "Cancel"}
        result = self.prompter.choice("Go? ", ("S", "C"), help_items=help_items)
        self.assertEqual(result, "S")
        self.renderer.help_table.assert_called_once_with(help_items)

    @patch("builtins.input", side_effect=["S"])
    def test_choice_no_help_does_not_call_renderer(self, mock_input):
        result = self.prompter.choice("Go? ", ("S", "C"))
        self.assertEqual(result, "S")
        self.renderer.help_table.assert_not_called()

    @patch("builtins.input", return_value="hello")
    def test_text_returns_input(self, mock_input):
        result = self.prompter.text("Say something")
        self.assertEqual(result, "hello")

    @patch("builtins.input", return_value="")
    def test_text_returns_empty_string(self, mock_input):
        result = self.prompter.text("Say something")
        self.assertEqual(result, "")

    @patch("builtins.input", return_value="42")
    def test_integer_returns_int(self, mock_input):
        result = self.prompter.integer("Enter number")
        self.assertEqual(result, 42)

    @patch("builtins.input", side_effect=["abc", "5"])
    def test_integer_retries_on_non_numeric(self, mock_input):
        result = self.prompter.integer("Enter number")
        self.assertEqual(result, 5)

    @patch("builtins.input", side_effect=["-1", "3"])
    def test_integer_retries_out_of_range(self, mock_input):
        result = self.prompter.integer("Enter number", valid_range=(0, 10))
        self.assertEqual(result, 3)

    @patch("builtins.input", side_effect=["", "b", "B"])
    def test_integer_accepts_back(self, mock_input):
        result = self.prompter.integer("Enter number", allow_back=True)
        self.assertEqual(result, "B")


# ══════════════════════════════════════════════════════════════════════
# PART 3: Refactored InteractiveCLIStrategy Tests
# ══════════════════════════════════════════════════════════════════════

class TestRefactoredStrategyConstructor(unittest.TestCase):
    def test_default_constructs_with_console_impls(self):
        s = RefactoredInteractiveCLIStrategy()
        self.assertIsInstance(s.renderer, ConsoleRenderer)
        self.assertIsInstance(s.prompter, ConsolePrompter)

    def test_accepts_custom_renderer(self):
        renderer = MagicMock(spec=SyncRenderer)
        s = RefactoredInteractiveCLIStrategy(renderer=renderer)
        self.assertIs(s.renderer, renderer)

    def test_accepts_custom_prompter(self):
        prompter = MagicMock(spec=SyncPrompter)
        s = RefactoredInteractiveCLIStrategy(prompter=prompter)
        self.assertIs(s.prompter, prompter)

    def test_accepts_both_custom(self):
        renderer = MagicMock(spec=SyncRenderer)
        prompter = MagicMock(spec=SyncPrompter)
        s = RefactoredInteractiveCLIStrategy(renderer=renderer, prompter=prompter)
        self.assertIs(s.renderer, renderer)
        self.assertIs(s.prompter, prompter)

    def test_prompter_gets_renderer_reference(self):
        s = RefactoredInteractiveCLIStrategy()
        self.assertIs(s.prompter.renderer, s.renderer)


class TestRefactoredStrategyStage1Flow(unittest.TestCase):
    def setUp(self):
        self.renderer = MagicMock(spec=SyncRenderer)
        self.prompter = MagicMock(spec=SyncPrompter)
        self.renderer.message.side_effect = lambda x: x
        self.renderer.entry_line.return_value = "entry"
        self.renderer.heading.return_value = "heading"
        self.strategy = RefactoredInteractiveCLIStrategy(
            renderer=self.renderer, prompter=self.prompter
        )

    def test_stage1_sync_all_returns_all_indices(self):
        self.prompter.choice.return_value = "S"
        pending = [_make_pending_entry(0), _make_pending_entry(1)]
        d = self.strategy.decide(pending)
        self.assertEqual(d.selected_indices, [0, 1])
        self.assertFalse(d.cancelled)

    def test_stage1_cancel_returns_cancelled(self):
        self.prompter.choice.return_value = "C"
        d = self.strategy.decide([_make_pending_entry(0)])
        self.assertTrue(d.cancelled)

    def test_stage1_renders_heading_and_entries(self):
        self.prompter.choice.return_value = "S"
        pending = [_make_pending_entry(0), _make_pending_entry(1)]
        self.strategy.decide(pending)
        self.renderer.heading.assert_called_once()
        self.assertEqual(self.renderer.entry_line.call_count, 2)

    def test_stage1_prompts_with_correct_options(self):
        self.prompter.choice.return_value = "S"
        self.strategy.decide([_make_pending_entry(0)])
        call_args = self.prompter.choice.call_args
        opts = call_args[0][1]
        self.assertIn("S", opts)
        self.assertIn("E", opts)
        self.assertIn("R", opts)
        self.assertIn("C", opts)

    def test_stage1_remove_toggle_excludes_entry(self):
        self.prompter.choice.side_effect = ["R", "S"]
        self.prompter.integer.return_value = 0
        pending = [_make_pending_entry(0), _make_pending_entry(1)]
        d = self.strategy.decide(pending)
        self.assertEqual(d.selected_indices, [1])

    def test_stage1_remove_toggle_twice_reincludes(self):
        self.prompter.choice.side_effect = ["R", "R", "S"]
        self.prompter.integer.return_value = 0
        pending = [_make_pending_entry(0), _make_pending_entry(1)]
        d = self.strategy.decide(pending)
        self.assertEqual(d.selected_indices, [0, 1])

    def test_stage1_all_removed_loops(self):
        self.prompter.choice.side_effect = ["R", "S", "R", "S"]
        self.prompter.integer.side_effect = [0, 0]
        pending = [_make_pending_entry(0)]
        d = self.strategy.decide(pending)
        self.assertEqual(d.selected_indices, [0])

    def test_stage1_uses_renderer_message_for_status(self):
        self.prompter.choice.side_effect = ["C"]
        self.prompter.integer.return_value = 0
        pending = [_make_pending_entry(0)]
        self.strategy.decide(pending)
        self.renderer.message.assert_called()


class TestRefactoredStrategyStage2Flow(unittest.TestCase):
    def setUp(self):
        self.renderer = MagicMock(spec=SyncRenderer)
        self.prompter = MagicMock(spec=SyncPrompter)
        self.renderer.message.side_effect = lambda x: x
        self.renderer.entry_line.return_value = "entry"
        self.renderer.heading.return_value = "heading"
        self.strategy = RefactoredInteractiveCLIStrategy(
            renderer=self.renderer, prompter=self.prompter
        )

    def test_e_enters_edit_mode(self):
        self.prompter.choice.side_effect = ["E", "S"]
        self.prompter.integer.side_effect = ["B"]
        pending = [_make_pending_entry(0)]
        d = self.strategy.decide(pending)
        self.assertEqual(d.selected_indices, [0])

    def test_edit_menu_selects_entry_by_index(self):
        self.prompter.choice.side_effect = ["E", "A", "B", "S"]
        self.prompter.integer.side_effect = [0, "B"]
        self.prompter.text.side_effect = ["", "", ""]
        pending = [_make_pending_entry(0)]
        self.strategy.decide(pending)

    def test_edit_menu_renders_heading_and_entries(self):
        self.prompter.choice.side_effect = ["E", "S"]
        self.prompter.integer.side_effect = ["B"]
        pending = [_make_pending_entry(0), _make_pending_entry(1)]
        self.strategy.decide(pending)
        self.assertGreaterEqual(self.renderer.heading.call_count, 2)


class TestRefactoredStrategyStage3Flow(unittest.TestCase):
    def setUp(self):
        self.renderer = MagicMock(spec=SyncRenderer)
        self.prompter = MagicMock(spec=SyncPrompter)
        self.renderer.message.side_effect = lambda x: x
        self.renderer.entry_line.return_value = "entry"
        self.renderer.heading.return_value = "heading"
        self.renderer.duration_str.return_value = "01h00m00s"
        self.strategy = RefactoredInteractiveCLIStrategy(
            renderer=self.renderer, prompter=self.prompter
        )

    def test_stage3_edit_end_time(self):
        self.prompter.choice.side_effect = ["E", "A", "B", "S"]
        self.prompter.integer.side_effect = [0, "B"]
        self.prompter.text.side_effect = ["+30m", "", ""]
        pending = [_make_pending_entry(0, end_epoch=3600000)]
        d = self.strategy.decide(pending)
        self.assertIn(0, d.overrides)

    def test_stage3_edit_comment(self):
        self.prompter.choice.side_effect = ["E", "A", "B", "S"]
        self.prompter.integer.side_effect = [0, "B"]
        self.prompter.text.side_effect = ["", "New note", ""]
        pending = [_make_pending_entry(0)]
        d = self.strategy.decide(pending)
        self.assertIn(0, d.overrides)
        self.assertEqual(d.overrides[0]["comment"], "New note")

    def test_stage3_auto_unmarks_removed(self):
        self.prompter.choice.side_effect = ["R", "E", "A", "B", "S"]
        self.prompter.integer.side_effect = [0, 0, "B"]
        self.prompter.text.side_effect = ["+5m", "", ""]
        pending = [_make_pending_entry(0, end_epoch=3600000)]
        d = self.strategy.decide(pending)
        self.assertIn(0, d.selected_indices)


class TestRefactoredStrategyOverrides(unittest.TestCase):
    def setUp(self):
        self.renderer = MagicMock(spec=SyncRenderer)
        self.prompter = MagicMock(spec=SyncPrompter)
        self.renderer.message.side_effect = lambda x: x
        self.renderer.entry_line.return_value = "entry"
        self.renderer.heading.return_value = "heading"
        self.renderer.duration_str.return_value = "01h00m00s"
        self.strategy = RefactoredInteractiveCLIStrategy(
            renderer=self.renderer, prompter=self.prompter
        )

    def test_end_time_override_passed_to_decision(self):
        self.prompter.choice.side_effect = ["E", "A", "B", "S"]
        self.prompter.integer.side_effect = [0, "B"]
        self.prompter.text.side_effect = ["+30m", "", ""]
        pending = [_make_pending_entry(0, end_epoch=1000000)]
        d = self.strategy.decide(pending)
        expected = 1000000 + 30 * 60000
        self.assertEqual(d.overrides[0]["end_epoch"], expected)

    def test_comment_override_passed_to_decision(self):
        self.prompter.choice.side_effect = ["E", "A", "B", "S"]
        self.prompter.integer.side_effect = [0, "B"]
        self.prompter.text.side_effect = ["", "Fixed!", ""]
        pending = [_make_pending_entry(0)]
        d = self.strategy.decide(pending)
        self.assertEqual(d.overrides[0]["comment"], "Fixed!")

    def test_cancel_discards_all_overrides(self):
        self.prompter.choice.side_effect = ["E", "A", "B", "C"]
        self.prompter.integer.side_effect = [0, "B"]
        self.prompter.text.side_effect = ["+30m", "", ""]
        pending = [_make_pending_entry(0, end_epoch=1000000)]
        d = self.strategy.decide(pending)
        self.assertTrue(d.cancelled)


class TestRefactoredStrategyWithExternalTheme(unittest.TestCase):
    def test_custom_renderer_receives_all_calls(self):
        renderer = MagicMock(spec=SyncRenderer)
        renderer.message.side_effect = lambda x: x
        renderer.entry_line.return_value = "x"
        renderer.heading.return_value = "x"
        prompter = MagicMock(spec=SyncPrompter)
        prompter.choice.return_value = "S"
        s = RefactoredInteractiveCLIStrategy(renderer=renderer, prompter=prompter)
        s.decide([_make_pending_entry(0)])
        renderer.heading.assert_called()
        renderer.entry_line.assert_called()

    def test_theme_can_override_entry_format(self):
        renderer = MagicMock(spec=SyncRenderer)
        renderer.entry_line.return_value = "CUSTOM: entry line"
        renderer.heading.return_value = "CUSTOM: heading"
        renderer.message.side_effect = lambda x: x
        prompter = MagicMock(spec=SyncPrompter)
        prompter.choice.return_value = "S"
        s = RefactoredInteractiveCLIStrategy(renderer=renderer, prompter=prompter)
        d = s.decide([_make_pending_entry(0)])
        self.assertEqual(d.selected_indices, [0])


class TestRefactoredParseEndTime(unittest.TestCase):
    def setUp(self):
        self.strategy = RefactoredInteractiveCLIStrategy()

    def test_parse_plus_minutes(self):
        entry = {"end_epoch": 1000000, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("+30m", entry)
        self.assertEqual(result, 1000000 + 30 * 60000)

    def test_parse_minus_hours(self):
        entry = {"end_epoch": 1000000, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("-1h", entry)
        self.assertEqual(result, 1000000 - 3600000)

    def test_parse_absolute_duration(self):
        entry = {"end_epoch": 9999999, "start_epoch": 1000000, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("1h20m", entry)
        self.assertEqual(result, 1000000 + 80 * 60000)

    def test_parse_hhmm(self):
        from datetime import timezone, datetime
        entry = {"end_epoch": 0, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("14:30", entry)
        expected = int(datetime(2026, 4, 25, 14, 30, tzinfo=timezone.utc).timestamp() * 1000)
        self.assertEqual(result, expected)

    def test_parse_epoch_ms(self):
        entry = {"end_epoch": 0, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("1714039200000", entry)
        self.assertEqual(result, 1714039200000)

    def test_parse_invalid_returns_none(self):
        entry = {"end_epoch": 0, "start_epoch": 0, "date": "2026-04-25"}
        result = self.strategy._parse_end_time("garbage", entry)
        self.assertIsNone(result)


class TestThemeComposability(unittest.TestCase):
    def test_console_renderer_produces_string_output(self):
        renderer = ConsoleRenderer()
        p = _make_pending_entry(0, "Test")
        self.assertIsInstance(renderer.heading("Test"), str)
        self.assertIsInstance(renderer.entry_line(p, {}, set()), str)
        self.assertIsInstance(renderer.duration_str(3600000), str)
        self.assertIsInstance(renderer.message("test"), str)

    def test_colored_renderer_can_subclass_console(self):
        class ColoredRenderer(ConsoleRenderer):
            def heading(self, text):
                return f"\033[1;36m--- {text} ---\033[0m"
            def entry_line(self, p, overrides, excluded):
                line = super().entry_line(p, overrides, excluded)
                return f"\033[0;37m{line}\033[0m"

        renderer = ColoredRenderer()
        p = _make_pending_entry(0, "Test")
        h = renderer.heading("Pending")
        self.assertIn("\033[", h)
        self.assertIn("Pending", h)
        line = renderer.entry_line(p, {}, set())
        self.assertIn("\033[", line)

    def test_renderer_swap_does_not_break_strategy(self):
        console_renderer = ConsoleRenderer()
        prompter = MagicMock(spec=SyncPrompter)
        prompter.choice.return_value = "S"
        s1 = RefactoredInteractiveCLIStrategy(renderer=console_renderer, prompter=prompter)
        d1 = s1.decide([_make_pending_entry(0)])
        self.assertEqual(d1.selected_indices, [0])

        class ColoredRenderer2(ConsoleRenderer):
            def heading(self, text):
                return f"*** {text} ***"
        prompter2 = MagicMock(spec=SyncPrompter)
        prompter2.choice.return_value = "S"
        s2 = RefactoredInteractiveCLIStrategy(renderer=ColoredRenderer2(), prompter=prompter2)
        d2 = s2.decide([_make_pending_entry(0)])
        self.assertEqual(d2.selected_indices, [0])
        self.assertEqual(d1, d2)


# ══════════════════════════════════════════════════════════════════════
# PART 4: AutoSyncStrategy (unchanged, just verify)
# ══════════════════════════════════════════════════════════════════════

class TestAutoSyncStrategy(unittest.TestCase):
    def test_sync_all(self):
        s = AutoSyncStrategy()
        d = s.decide([_make_pending_entry(0), _make_pending_entry(1)])
        self.assertEqual(d.selected_indices, [0, 1])

    def test_empty_pending(self):
        s = AutoSyncStrategy()
        d = s.decide([])
        self.assertFalse(d.has_selection)


if __name__ == "__main__":
    unittest.main()
