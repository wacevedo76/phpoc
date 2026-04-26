"""Sync confirmation strategies for phpoc.

Each strategy implements the SyncStrategy interface, which takes pending entries
and returns a SyncDecision describing what to sync and how to override entries.
This allows different frontends (CLI, TUI, web, headless) to provide their own
confirmation UX without touching the domain layer.
"""

import json
import time
from typing import List, Dict, Any, Set
from dataclasses import dataclass, field


@dataclass
class SyncDecision:
    """The result of a sync confirmation strategy.

    Attributes:
        selected_indices: List of entry_index values (from get_pending_sync()) to sync.
        overrides: Optional dict mapping entry_index -> {
            "end_epoch": int,      // optional override
            "comment": str,        // optional override
            "media": list,         // optional override
        }
        cancelled: If True, the user cancelled the entire sync operation.
    """
    selected_indices: List[int] = field(default_factory=list)
    overrides: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    cancelled: bool = False

    @property
    def has_selection(self) -> bool:
        return bool(self.selected_indices) and not self.cancelled


class SyncStrategy:
    """Abstract base for sync confirmation strategies.

    A strategy receives the pending entries and returns a SyncDecision.
    """

    def decide(self, pending: List[Dict[str, Any]]) -> SyncDecision:
        """Examine pending entries and return what to sync.

        Args:
            pending: List of preview dicts from LedgerDomain.get_pending_sync().
                     Each has: entry_index, title, start_epoch, end_epoch,
                     duration, tags, date, comment, media.

        Returns:
            A SyncDecision describing which entries to sync and any overrides.
        """
        raise NotImplementedError


class AutoSyncStrategy(SyncStrategy):
    """Sync everything without any confirmation. For --yes / headless use."""

    def decide(self, pending: List[Dict[str, Any]]) -> SyncDecision:
        if not pending:
            return SyncDecision(cancelled=False)
        return SyncDecision(
            selected_indices=[p["entry_index"] for p in pending]
        )


class InteractiveCLIStrategy(SyncStrategy):
    """Three-stage interactive sync confirmation for the terminal.

    Stage 1 (Overview): Show all pending entries. Options:
      [S]ync now  - sync everything (with overrides), excluding marked-removed
      [E]dit      - enter Stage 2
      [R]emove    - toggle removal mark on an entry
      [C]ancel    - discard everything

    Stage 2 (Edit Menu): Show original + proposed changes side by side.
      User picks an entry by index to edit, or goes back to Stage 1.

    Stage 3 (Edit Single): Modify end time, comment, media (stub).
      [A]pply changes, [D]iscard, [B]ack.

    All state (overrides, excluded set) is held in memory and discarded on Cancel.
    Nothing touches staging or ledger until Sync is confirmed.
    """

    def decide(self, pending: List[Dict[str, Any]]) -> SyncDecision:
        if not pending:
            print("Nothing to sync.")
            return SyncDecision(cancelled=True)

        # In-memory state for this session
        edit_overrides: Dict[int, Dict[str, Any]] = {}  # entry_index -> {end_epoch, comment, media}
        excluded: Set[int] = set()                      # entry_index values marked for removal

        while True:
            # Stage 1: Overview
            choice = self._stage1_overview(pending, edit_overrides, excluded)

            if choice == "S":
                # Build final selected_indices from non-excluded entries
                selected = [p["entry_index"] for p in pending
                            if p["entry_index"] not in excluded]
                if not selected:
                    print("All entries have been marked for removal. Nothing to sync.")
                    continue
                return InteractiveCLIStrategy._build_sync_decision(selected, edit_overrides)

            elif choice == "C":
                print("Sync cancelled.")
                return SyncDecision(cancelled=True)

            elif choice == "E":
                self._stage2_edit_menu(pending, edit_overrides, excluded)
                # Loop back to Stage 1

            elif choice == "R":
                self._stage1_remove_toggle(pending, excluded)
                # Loop back to Stage 1

    # ── Stage 1 ──────────────────────────────────────────────────────

    def _stage1_overview(self, pending, overrides, excluded):
        """Display overview and return the user's action choice."""
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
        """Toggle removal status for an entry by index."""
        idx_input = input("Which habit to toggle removal? (index, or [B]ack): ").strip().lower()
        if idx_input in ("b", "back", ""):
            return
        try:
            target = int(idx_input)
            # Validate index exists in pending
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

    # ── Stage 2: Edit Menu ───────────────────────────────────────────

    def _stage2_edit_menu(self, pending, overrides, excluded):
        """Show original + proposed changes, let user pick an entry to edit."""
        help_items = {
            "<index>": "Edit the habit with this index number",
            "B": "Back to overview (return to sync summary)",
        }
        while True:
            print("\n--- Edit Mode ---")
            for p in pending:
                self._print_entry_line(p, overrides, excluded)
                if p["entry_index"] in overrides:
                    # Show proposed diff line
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
                # Find the pending entry for this index
                entry = next(p for p in pending if p["entry_index"] == target)
                # Stage 3: Edit this habit
                self._stage3_edit_single(entry, target, overrides, excluded)
                # After Stage 3 returns, loop back to Stage 2 menu
            except ValueError:
                print("Invalid input. Enter a habit index number.")

    # ── Stage 3: Edit Single Habit ───────────────────────────────────

    def _stage3_edit_single(self, entry, target_idx, overrides, excluded):
        """Edit a single habit: end time, comment, media (stub)."""
        # Determine current proposed values (or original as defaults)
        current_override = overrides.get(target_idx, {})
        current_end = current_override.get("end_epoch", entry["end_epoch"])
        current_comment = current_override.get("comment", entry.get("comment"))

        while True:
            print(f"\nEditing #{target_idx}: {entry['title']}")
            # Show original vs proposed
            orig_start_str = time.strftime("%H:%M", time.localtime(entry["start_epoch"] // 1000))
            orig_end_str = time.strftime("%H:%M", time.localtime(entry["end_epoch"] // 1000))
            prop_start_str = time.strftime("%H:%M", time.localtime(entry["start_epoch"] // 1000))
            prop_end_str = time.strftime("%H:%M", time.localtime(current_end // 1000))
            prop_dur = current_end - entry["start_epoch"]

            print(f"  Original: {orig_start_str}-{orig_end_str}, duration {self._format_duration(entry['duration'])}"
                  f"{'  comment: \"' + entry['comment'] + '\"' if entry.get('comment') else ''}")
            print(f"  Proposed: {prop_start_str}-{prop_end_str}, duration {self._format_duration(prop_dur)}"
                  f"{'  comment: \"' + current_comment + '\"' if current_comment else ''}")
            print()

            # End time
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

            # Comment
            if current_comment:
                comment_input = input(f'  Comment ("{current_comment}", or edit/clear): ').strip()
            else:
                comment_input = input("  Comment (optional): ").strip()
            if comment_input:
                current_comment = comment_input
            elif comment_input == "" and not current_override.get("comment"):
                pass  # no existing comment, no override

            # Media (future feature - stub)
            media_input = input("  Media (not yet supported, press Enter to skip): ").strip()
            if media_input:
                print("  Media editing is not yet supported.")

            # Actions
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
                # Build override dict — compare against ORIGINAL entry, not stale proposed
                override = {}
                if current_end != entry["end_epoch"]:
                    override["end_epoch"] = current_end
                if current_comment != entry.get("comment"):
                    if current_comment:
                        override["comment"] = current_comment
                    else:
                        override["comment"] = ""  # explicitly clear

                if override:
                    overrides[target_idx] = override
                    # Editing auto-unmarks from removal
                    if target_idx in excluded:
                        excluded.discard(target_idx)
                    print(f"  \u2713 Applied changes to #{target_idx}: {entry['title']}")
                else:
                    # No changes — remove any existing override
                    overrides.pop(target_idx, None)
                    print(f"  No changes to apply.")

                return  # back to Stage 2

            elif action == "D":
                overrides.pop(target_idx, None)
                print(f"  Discarded changes for #{target_idx}: {entry['title']}")
                return  # back to Stage 2

            elif action == "B":
                return  # back to Stage 2 without changes

    # ── Helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _build_sync_decision(selected, overrides):
        """Build a SyncDecision from selected indices and overrides dict.

        Single-pass helper that extracts end_epoch, comment, and media
        overrides from the internal overrides dict into the SyncDecision
        format. Returns None for override fields that have no entries.
        """
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

    @staticmethod
    def _format_entry_line(p, overrides, excluded):
        """Build a formatted line for an entry.

        Shows proposed values when overrides exist.
        """
        tags_str = f" [@{', @'.join(p['tags'])}]" if p["tags"] else ""
        override = overrides.get(p["entry_index"], {})

        end_epoch = override.get("end_epoch", p["end_epoch"])
        start_str = time.strftime("%H:%M", time.localtime(p["start_epoch"] // 1000)) if p["start_epoch"] else "??"
        end_str = time.strftime("%H:%M", time.localtime(end_epoch // 1000)) if end_epoch else "??"
        dur = end_epoch - p["start_epoch"]
        comment = override.get("comment", p.get("comment"))
        comment_str = f' "{comment}"' if comment else ""

        line = f"  #{p['entry_index']}: {p['title']}{tags_str} | {p['date']} | {start_str}-{end_str} | {InteractiveCLIStrategy._format_duration(dur)}{comment_str}"

        # Modified indicator
        if p["entry_index"] in overrides:
            line += " (modified)"

        # Removed indicator
        if p["entry_index"] in excluded:
            line += "  ~~marked to be removed~~"

        return line

    def _print_entry_line(self, p, overrides, excluded):
        """Print a formatted entry line."""
        print(self._format_entry_line(p, overrides, excluded))

    @staticmethod
    def _format_proposed_line(p, overrides):
        """Build a formatted proposed-changes line for a modified entry."""
        override = overrides[p["entry_index"]]
        start_epoch = p["start_epoch"]
        start_str = time.strftime("%H:%M", time.localtime(start_epoch // 1000))
        end_epoch = override.get("end_epoch", p["end_epoch"])
        end_str = time.strftime("%H:%M", time.localtime(end_epoch // 1000))
        dur = end_epoch - start_epoch
        comment = override.get("comment", p.get("comment"))
        comment_str = f'  comment: "{comment}"' if comment else ""
        return f"       proposed: {start_str}-{end_str}, duration {InteractiveCLIStrategy._format_duration(dur)}{comment_str}"

    @staticmethod
    def _print_proposed_line(p, overrides):
        """Print the proposed changes line for a modified entry."""
        print(InteractiveCLIStrategy._format_proposed_line(p, overrides))

    @staticmethod
    def _format_duration(ms):
        """Format milliseconds to HH:MM:SS string."""
        total_seconds = ms // 1000
        h = total_seconds // 3600
        m = (total_seconds % 3600) // 60
        s = total_seconds % 60
        return f"{h:02d}h{m:02d}m{s:02d}s"

    @staticmethod
    def _show_help(help_items):
        """Print a formatted help listing from a dict of {key: description}."""
        print("\nAvailable commands:")
        for key, desc in help_items.items():
            print(f"  {key} — {desc}")
        print()

    @staticmethod
    def _prompt_choice(prompt, valid_options, help_items=None):
        """Prompt for a single-character choice, retry on invalid input.

        If help_items is provided, '?' is automatically added as a valid
        option and will display the help listing before re-prompting.
        """
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

    # ── End time parsing ─────────────────────────────────────────────

    @staticmethod
    def _parse_offset(end_input, current_end):
        """Parse +N[m|h|s] or -N[m|h|s] offset from current end time.

        Returns new epoch ms, or None on failure.
        """
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
        """Parse N[h][m][s] absolute duration from start.

        Returns epoch ms (start + duration), or None on failure.
        """
        import re
        has_digits_before_unit = bool(re.search(r"\d+(?:h|m|s)", end_input))
        if not has_digits_before_unit:
            return None
        try:
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
            return start_epoch + duration_ms
        except ValueError:
            return None

    @staticmethod
    def _parse_clock_time(end_input, date):
        """Parse HH:MM / HH:MM:SS clock time or raw epoch ms.

        Returns epoch ms, or None on failure.
        """
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
        """Parse end time input into epoch ms. Returns None on failure.

        Dispatches to _parse_offset, _parse_duration, or _parse_clock_time
        depending on the format detected.

        Supported formats:
          +N[m|h|s] or -N...  — offset from current end time
          N[h][m][s]           — absolute duration from start time
          HH:MM or HH:MM:SS    — clock time on entry's date (UTC)
          <epoch ms>           — raw epoch ms
        """
        end_input = end_input.strip()
        if end_input.startswith("+") or end_input.startswith("-"):
            return InteractiveCLIStrategy._parse_offset(end_input, entry["end_epoch"])
        import re
        if re.search(r"\d+(?:h|m|s)", end_input):
            return InteractiveCLIStrategy._parse_duration(end_input, entry["start_epoch"])
        return InteractiveCLIStrategy._parse_clock_time(end_input, entry["date"])
