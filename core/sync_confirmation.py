"""Deprecated — old InteractiveCLIStrategy with original helper methods.

This file preserves the OLD InteractiveCLIStrategy implementation with its
original helper method names (_format_entry_line, _format_duration,
_prompt_choice, _show_help, _parse_end_time, etc.) for backward
compatibility with existing tests.

New code should use the ViewInterface-based InteractiveCLIStrategy from
cli/strategies.py directly.
"""

import json
import time
from typing import List, Dict, Any, Set

from core.sync.decision import SyncDecision, SyncStrategy  # noqa: F401


class AutoSyncStrategy(SyncStrategy):
    """Sync everything without any confirmation. For --yes / headless use."""

    def decide(self, pending: List[Dict[str, Any]]) -> SyncDecision:
        if not pending:
            return SyncDecision(cancelled=False)
        return SyncDecision(
            selected_indices=[p["entry_index"] for p in pending]
        )


class InteractiveCLIStrategy(SyncStrategy):
    """Three-stage interactive sync confirmation (OLD monolithic version)."""

    def decide(self, pending: List[Dict[str, Any]]) -> SyncDecision:
        if not pending:
            print("Nothing to sync.")
            return SyncDecision(cancelled=True)

        edit_overrides: Dict[int, Dict[str, Any]] = {}
        excluded: Set[int] = set()

        while True:
            choice = self._stage1_overview(pending, edit_overrides, excluded)

            if choice == "S":
                selected = [p["entry_index"] for p in pending
                            if p["entry_index"] not in excluded]
                if not selected and not excluded:
                    print("No entries selected or marked for removal. Nothing to do.")
                    continue
                overrides = edit_overrides if edit_overrides else {}
                return SyncDecision(
                    selected_indices=selected,
                    removal_indices=excluded.copy(),
                    overrides=overrides,
                )

            elif choice == "C":
                print("Sync cancelled.")
                return SyncDecision(cancelled=True)

            elif choice == "E":
                self._stage2_edit_menu(pending, edit_overrides, excluded)

            elif choice == "R":
                self._stage1_remove_toggle(pending, excluded)

    def _stage1_overview(self, pending, overrides, excluded):
        print("\n--- Pending Sync ---")
        for p in pending:
            self._print_entry_line(p, overrides, excluded)
        print()
        help_items = {
            "S": "Sync now (confirm all pending entries)",
            "E": "Edit modifications (end time, comment)",
            "R": "Toggle removal for a habit",
            "C": "Cancel (discard all changes)",
        }
        prompt = "[S]ync now, [E]dit, [R]emove, [C]ancel, [?] help? "
        return self._prompt_choice(prompt, ("S", "E", "R", "C"), help_items=help_items)

    def _stage1_remove_toggle(self, pending, excluded):
        idx_input = input("Which habit to toggle removal? (index, or [B]ack): ").strip().lower()
        if idx_input in ("b", "back", ""):
            return
        try:
            target = int(idx_input)
            indices = [p["entry_index"] for p in pending]
            if target not in indices:
                print(f"Invalid index {target}. Valid indices: {indices}")
                return
            if target in excluded:
                excluded.discard(target)
                print(f"  #{target} is no longer marked for removal.")
            else:
                excluded.add(target)
                print(f"  #{target} marked to be removed.")
        except ValueError:
            print("Invalid input. Enter a habit index number.")

    def _stage2_edit_menu(self, pending, overrides, excluded):
        help_items = {
            "<index>": "Edit the habit with this index number",
            "B": "Back to overview (return to sync summary)",
        }
        while True:
            print("\n--- Edit Mode ---")
            for p in pending:
                self._print_entry_line(p, overrides, excluded)
                if p["entry_index"] in overrides:
                    self._print_proposed_line(p, overrides)
            print()

            idx_input = input("Choose habit by index, [B]ack, [?] help: ").strip().lower()
            if idx_input == "?":
                self._show_help(help_items)
                continue
            if idx_input in ("b", "back", ""):
                return

            try:
                target = int(idx_input)
                indices = [p["entry_index"] for p in pending]
                if target not in indices:
                    print(f"Invalid index {target}. Valid indices: {indices}")
                    continue
                entry = next(p for p in pending if p["entry_index"] == target)
                self._stage3_edit_single(entry, target, overrides, excluded)
            except ValueError:
                print("Invalid input. Enter a habit index number.")

    def _stage3_edit_single(self, entry, target_idx, overrides, excluded):
        current_override = overrides.get(target_idx, {})
        current_end = current_override.get("end_epoch", entry["end_epoch"])
        current_comment = current_override.get("comment", entry.get("comment"))

        while True:
            print(f"\nEditing #{target_idx}: {entry['title']}")
            orig_start_str = time.strftime("%H:%M", time.localtime(entry["start_epoch"] // 1000))
            orig_end_str = time.strftime("%H:%M", time.localtime(entry["end_epoch"] // 1000))
            prop_end_str = time.strftime("%H:%M", time.localtime(current_end // 1000))
            prop_dur = current_end - entry["start_epoch"]

            print(f"  Original: {orig_start_str}-{orig_end_str}, duration {self._format_duration(entry['duration'])}"
                  f"{'  comment: \"' + entry['comment'] + '\"' if entry.get('comment') else ''}")
            print(f"  Proposed: {orig_start_str}-{prop_end_str}, duration {self._format_duration(prop_dur)}"
                  f"{'  comment: \"' + current_comment + '\"' if current_comment else ''}")
            print()

            end_input = input(f"  End time (blank=keep {prop_end_str}, HH:MM, +N[m|h|s], N[h][m][s] duration, or epoch ms): ").strip()
            if end_input:
                new_end = self._parse_end_time(end_input, entry)
                if new_end is not None:
                    current_end = new_end
                    prop_end_str = time.strftime("%H:%M", time.localtime(current_end // 1000))
                    prop_dur = current_end - entry["start_epoch"]
                    print(f"    New end: {prop_end_str}, duration: {self._format_duration(prop_dur)}")
                else:
                    print(f"    Invalid format, keeping {prop_end_str}.")

            if current_comment:
                comment_input = input(f'  Comment ("{current_comment}", or edit/clear): ').strip()
            else:
                comment_input = input("  Comment (optional): ").strip()
            if comment_input:
                current_comment = comment_input
            elif comment_input == "" and not current_override.get("comment"):
                pass

            media_input = input("  Media (not yet supported, press Enter to skip): ").strip()
            if media_input:
                print("  Media editing is not yet supported.")

            help_items = {
                "A": "Apply changes (save this edit)",
                "D": "Discard changes for this habit",
                "B": "Back to edit menu without changes",
            }
            action = self._prompt_choice(
                "  [A]pply, [D]iscard, [B]ack, [?] help? ",
                ("A", "D", "B"),
                help_items=help_items
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
                    print(f"  \u2713 Applied changes to #{target_idx}: {entry['title']}")
                else:
                    overrides.pop(target_idx, None)
                    print(f"  No changes to apply.")

                return

            elif action == "D":
                overrides.pop(target_idx, None)
                print(f"  Discarded changes for #{target_idx}: {entry['title']}")
                return

            elif action == "B":
                return

    @staticmethod
    def _format_entry_line(p, overrides, excluded):
        tags_str = f" [@{', @'.join(p['tags'])}]" if p["tags"] else ""
        override = overrides.get(p["entry_index"], {})
        end_epoch = override.get("end_epoch", p["end_epoch"])
        start_str = time.strftime("%H:%M", time.localtime(p["start_epoch"] // 1000)) if p["start_epoch"] else "??"
        end_str = time.strftime("%H:%M", time.localtime(end_epoch // 1000)) if end_epoch else "??"
        dur = end_epoch - p["start_epoch"]
        comment = override.get("comment", p.get("comment"))
        comment_str = f' "{comment}"' if comment else ""
        line = f"  #{p['entry_index']}: {p['title']}{tags_str} | {p['date']} | {start_str}-{end_str} | {InteractiveCLIStrategy._format_duration(dur)}{comment_str}"
        if p["entry_index"] in overrides:
            line += " (modified)"
        if p["entry_index"] in excluded:
            line += "  ~~marked to be removed~~"
        return line

    def _print_entry_line(self, p, overrides, excluded):
        print(self._format_entry_line(p, overrides, excluded))

    @staticmethod
    def _print_proposed_line(p, overrides):
        override = overrides[p["entry_index"]]
        start_epoch = p["start_epoch"]
        start_str = time.strftime("%H:%M", time.localtime(start_epoch // 1000))
        end_epoch = override.get("end_epoch", p["end_epoch"])
        end_str = time.strftime("%H:%M", time.localtime(end_epoch // 1000))
        dur = end_epoch - start_epoch
        comment = override.get("comment", p.get("comment"))
        comment_str = f'  comment: "{comment}"' if comment else ""
        print(f"       proposed: {start_str}-{end_str}, duration {InteractiveCLIStrategy._format_duration(dur)}{comment_str}")

    @staticmethod
    def _format_duration(ms):
        total_seconds = ms // 1000
        h = total_seconds // 3600
        m = (total_seconds % 3600) // 60
        s = total_seconds % 60
        return f"{h:02d}h{m:02d}m{s:02d}s"

    @staticmethod
    def _show_help(help_items):
        print("\nAvailable commands:")
        for key, desc in help_items.items():
            print(f"  {key} — {desc}")
        print()

    @staticmethod
    def _prompt_choice(prompt, valid_options, help_items=None):
        effective_options = set(valid_options)
        if help_items is not None:
            effective_options.add("?")
        while True:
            choice = input(prompt).strip().upper()
            if choice in effective_options:
                if choice == "?" and help_items is not None:
                    InteractiveCLIStrategy._show_help(help_items)
                    continue
                return choice
            print(f"Invalid choice. Options: {', '.join(sorted(effective_options))}")

    @staticmethod
    def _parse_offset(end_input, current_end):
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
            return current_end + offset_ms
        except ValueError:
            return None

    @staticmethod
    def _parse_duration(end_input, start_epoch):
        import re
        has_digits_before_unit = bool(re.search(r"\d+(?:h|m|s)", end_input))
        if not has_digits_before_unit:
            return None
        try:
            h = m = s = 0
            h_match = re.search(r"(\d+)h", end_input)
            m_match = re.search(r"(\d+)m", end_input)
            s_match = re.search(r"(\d+)s", end_input)
            if h_match: h = int(h_match.group(1))
            if m_match: m = int(m_match.group(1))
            if s_match: s = int(s_match.group(1))
            duration_ms = (h * 3600 + m * 60 + s) * 1000
            return start_epoch + duration_ms
        except ValueError:
            return None

    @staticmethod
    def _parse_clock_time(end_input, date):
        from datetime import timezone, datetime
        try:
            parts = end_input.split(":")
            date_parts = date.split("-")
            if len(parts) == 2:
                h, m = int(parts[0]), int(parts[1])
                s = 0
            elif len(parts) == 3:
                h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
            else:
                raise ValueError
            dt = datetime(int(date_parts[0]), int(date_parts[1]), int(date_parts[2]),
                          h, m, s, tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except (ValueError, IndexError):
            try:
                return int(end_input)
            except ValueError:
                return None

    @staticmethod
    def _parse_end_time(end_input, entry):
        end_input = end_input.strip()
        if end_input.startswith("+") or end_input.startswith("-"):
            return InteractiveCLIStrategy._parse_offset(end_input, entry["end_epoch"])
        import re
        if re.search(r"\d+(?:h|m|s)", end_input):
            return InteractiveCLIStrategy._parse_duration(end_input, entry["start_epoch"])
        return InteractiveCLIStrategy._parse_clock_time(end_input, entry["date"])
