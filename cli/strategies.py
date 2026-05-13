"""CLI sync confirmation strategies.

Extracted from core/sync_confirmation.py to move CLI-specific
interactive patterns out of the core domain layer.

SyncDecision and SyncStrategy are now defined in core/sync/decision.py.
This file imports them from there and adds the CLI-specific strategies
(AutoSyncStrategy, InteractiveCLIStrategy).

InteractiveCLIStrategy uses ViewInterface for all I/O.
AutoSyncStrategy needs no view and stays lightweight.
"""

from typing import List, Dict, Any, Set
from domain.interfaces.view import ViewInterface
from core.sync.decision import SyncDecision, SyncStrategy


class AutoSyncStrategy(SyncStrategy):
    """Sync everything without any confirmation. For --yes / headless use."""

    def decide(self, pending: List[Dict[str, Any]],
               view: ViewInterface = None) -> SyncDecision:
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

    def decide(self, pending: List[Dict[str, Any]],
               view: ViewInterface = None) -> SyncDecision:
        if not pending:
            view.render_error("Nothing to sync.")
            return SyncDecision(cancelled=True)

        edit_overrides: Dict[int, Dict[str, Any]] = {}
        excluded: Set[int] = set()

        while True:
            view.render_overview(pending, edit_overrides, excluded)
            help_items = {
                "S": "Sync now (confirm all pending entries)",
                "E": "Edit modifications (end time, comment)",
                "R": "Toggle removal for a habit",
                "C": "Cancel (discard all changes)",
            }
            choice = view.prompt_choice(
                "[S]ync now, [E]dit, [R]emove, [C]ancel, [?] help? ",
                ("S", "E", "R", "C"),
                help_items=help_items,
            )

            if choice == "S":
                selected = [p["entry_index"] for p in pending
                            if p["entry_index"] not in excluded]
                if not selected and not excluded:
                    view.render_error("No entries selected or marked for removal. Nothing to do.")
                    continue
                return SyncDecision(
                    selected_indices=selected,
                    removal_indices=excluded.copy(),
                    overrides=dict(edit_overrides) if edit_overrides else {},
                )

            elif choice == "C":
                view.render_error("Sync cancelled.")
                return SyncDecision(cancelled=True)

            elif choice == "E":
                self._edit_menu(pending, edit_overrides, excluded, view)

            elif choice == "R":
                self._remove_toggle(pending, excluded, view)

    # ------------------------------------------------------------------
    # Edit Menu (Stage 2)
    # ------------------------------------------------------------------

    def _edit_menu(self, pending, overrides, excluded, view):
        help_items = {
            "<index>": "Edit the habit with this index number",
            "B": "Back to overview",
        }
        while True:
            view.render_edit_menu(pending, overrides, excluded)
            print()

            idx_input = view.prompt_text("Choose habit by index, [B]ack, [?] help: ")
            if not idx_input or idx_input.lower() in ("b", "back"):
                return
            if idx_input == "?":
                view.render_help(help_items)
                continue

            try:
                target = int(idx_input)
            except ValueError:
                view.render_error("Invalid input. Enter a habit index number.")
                continue

            indices = [p["entry_index"] for p in pending]
            if target not in indices:
                view.render_error(f"Invalid index {target}. Valid indices: {indices}")
                continue

            entry = next(p for p in pending if p["entry_index"] == target)
            self._edit_single(entry, target, overrides, excluded, view)

    # ------------------------------------------------------------------
    # Edit Single (Stage 3)
    # ------------------------------------------------------------------

    def _edit_single(self, entry, target_idx, overrides, excluded, view):
        import time as _time_module
        import re as _re_module
        from cli.cli_parsers import parse_time_input as _parse_time

        current_override = overrides.get(target_idx, {})
        current_end = current_override.get("end_epoch", entry["end_epoch"])
        current_comment = current_override.get("comment", entry.get("comment"))

        while True:
            print(f"\nEditing #{target_idx}: {entry['title']}")
            orig_start_str = _time_module.strftime("%H:%M", _time_module.localtime(entry["start_epoch"] // 1000))
            orig_end_str = _time_module.strftime("%H:%M", _time_module.localtime(entry["end_epoch"] // 1000))
            prop_end_str = _time_module.strftime("%H:%M", _time_module.localtime(current_end // 1000))
            prop_dur = current_end - entry["start_epoch"]

            print(f"  Original: {orig_start_str}-{orig_end_str}, duration {self._fmt(entry['duration'])}"
                  f"{'  comment: \"' + entry['comment'] + '\"' if entry.get('comment') else ''}")
            print(f"  Proposed: {orig_start_str}-{prop_end_str}, duration {self._fmt(prop_dur)}"
                  f"{'  comment: \"' + current_comment + '\"' if current_comment else ''}")
            print()

            # End time
            end_input = view.prompt_text(
                f"  End time (blank=keep {prop_end_str}, HH:MM, +N[m|h|s], N[h][m][s], or epoch ms): "
            )
            if end_input:
                new_end = self._parse_end(end_input, entry)
                if new_end is not None:
                    current_end = new_end
                    view.render_success(f"    New end: {_time_module.strftime('%H:%M', _time_module.localtime(current_end // 1000))}")

            # Comment
            if current_comment:
                comment_input = view.prompt_text(f'  Comment ("{current_comment}", or edit/clear): ')
            else:
                comment_input = view.prompt_text("  Comment (optional): ")

            if comment_input:
                current_comment = comment_input

            # Actions
            action = view.prompt_choice(
                "  [A]pply, [D]iscard, [B]ack, [?] help? ",
                ("A", "D", "B"),
                help_items={
                    "A": "Apply changes (save this edit)",
                    "D": "Discard changes for this habit",
                    "B": "Back to edit menu without changes",
                },
            )

            if action == "A":
                override = {}
                if current_end != entry["end_epoch"]:
                    override["end_epoch"] = current_end
                if current_comment != entry.get("comment"):
                    override["comment"] = current_comment or ""

                if override:
                    overrides[target_idx] = override
                    excluded.discard(target_idx)
                    view.render_success(f"  Applied changes to #{target_idx}: {entry['title']}")
                else:
                    overrides.pop(target_idx, None)
                    view.render_warning("  No changes to apply.")
                return

            elif action == "D":
                overrides.pop(target_idx, None)
                view.render_warning(f"  Discarded changes for #{target_idx}: {entry['title']}")
                return

            elif action == "B":
                return

    # ------------------------------------------------------------------
    # Remove toggle (Stage 1 helper)
    # ------------------------------------------------------------------

    def _remove_toggle(self, pending, excluded, view):
        idx_input = view.prompt_text("Which habit to toggle removal? (index, or [B]ack): ")
        if not idx_input or idx_input.lower() in ("b", "back"):
            return
        try:
            target = int(idx_input)
            indices = [p["entry_index"] for p in pending]
            if target not in indices:
                view.render_error(f"Invalid index {target}. Valid indices: {indices}")
                return
            if target in excluded:
                excluded.discard(target)
                view.render_warning(f"  #{target} is no longer marked for removal.")
            else:
                excluded.add(target)
                view.render_warning(f"  #{target} marked to be removed.")
        except ValueError:
            view.render_error("Invalid input. Enter a habit index number.")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _fmt(ms):
        total_seconds = ms // 1000
        h = total_seconds // 3600
        m = (total_seconds % 3600) // 60
        s = total_seconds % 60
        return f"{h:02d}h{m:02d}m{s:02d}s"

    @staticmethod
    def _parse_end(end_input, entry):
        """Parse end time input into epoch ms. Returns None on failure."""
        import re as _re
        from cli.cli_parsers import parse_time_input as _pt

        end_input = end_input.strip()
        # Try offset from current end
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
                return entry["end_epoch"] + offset_ms
            except ValueError:
                return None
        # Try duration from start
        if _re.search(r"\d+(?:h|m|s)", end_input):
            try:
                h = m = s = 0
                h_m = _re.search(r"(\d+)h", end_input)
                m_m = _re.search(r"(\d+)m", end_input)
                s_m = _re.search(r"(\d+)s", end_input)
                if h_m:
                    h = int(h_m.group(1))
                if m_m:
                    m = int(m_m.group(1))
                if s_m:
                    s = int(s_m.group(1))
                duration_ms = (h * 3600 + m * 60 + s) * 1000
                return entry["start_epoch"] + duration_ms
            except ValueError:
                return None
        # Clock time or epoch
        try:
            parts = end_input.split(":")
            date_parts = entry["date"].split("-")
            from datetime import datetime as _dt
            if len(parts) == 2:
                h, m = int(parts[0]), int(parts[1])
                s = 0
            elif len(parts) == 3:
                h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
            else:
                raise ValueError
            dt = _dt(int(date_parts[0]), int(date_parts[1]), int(date_parts[2]), h, m, s)
            return int(dt.timestamp() * 1000)
        except (ValueError, IndexError):
            pass
        # Raw epoch
        try:
            return int(end_input)
        except ValueError:
            return None
