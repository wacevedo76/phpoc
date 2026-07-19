"""CLIView — concrete ViewInterface implementation for terminal/CLI.

See ARCHITECTURAL_MIGRATION_STRATEGY.md Item 5 for design rationale.

This file owns:
  - All print() and input() calls for user interaction
  - All interactive editing workflows (modify, remove, review, tags)
  - All display formatting (entry lines, summaries, tag lists)
  - Interactive pause editor
  - Active task display with decryption fallback

It does NOT own:
  - Domain logic (staging CRUD, ledger chain) — delegates to ledger
  - Sync strategy decision-making — that's in strategies.py
  - Time parsing — delegates to cli_parsers.py
"""

import json
import time
import calendar
import re
import hashlib
from datetime import datetime
from typing import Optional

from domain.interfaces.view import ViewInterface
from cli.cli_parsers import parse_time_input


class CLIView(ViewInterface):
    """Concrete view implementation for terminal/CLI.
    Requires a ledger reference for decrypting encrypted fields.
    """

    def __init__(self, ledger):
        self.ledger = ledger

    # ==================================================================
    # Display: Entry formatting
    # ==================================================================

    def render_entry_line(self, entry: dict, overrides: dict = None,
                          excluded: set = None) -> str:
        """Format one entry as a single display line for sync preview."""
        overrides = overrides or {}
        excluded = excluded or set()

        # Handle encrypted fields — show [encrypted] placeholder
        has_encrypted = entry.get("has_encrypted_fields", False)
        title = entry.get("title", "")
        if has_encrypted and not title:
            title = "[encrypted]"
        tags = entry.get("tags")
        if has_encrypted and not tags:
            tags_str = " [encrypted]"
        else:
            tags_str = f" [@{', @'.join(tags)}]" if tags else ""

        override = overrides.get(entry["entry_index"], {})
        end_epoch = override.get("end_epoch", entry["end_epoch"])
        start_str = time.strftime("%H:%M", time.localtime(entry["start_epoch"] // 1000)) if entry["start_epoch"] else "??"
        end_str = time.strftime("%H:%M", time.localtime(end_epoch // 1000)) if end_epoch else "??"
        dur = end_epoch - entry["start_epoch"] if end_epoch else entry.get("duration", 0)
        comment = override.get("comment", entry.get("comment"))
        comment_str = f' "{comment}"' if comment else ""

        line = (f"  #{entry['entry_index']}: {title}{tags_str} | {entry['date']} | "
                f"{start_str}-{end_str} | {self._format_duration(dur)}{comment_str}")

        if entry["entry_index"] in overrides:
            line += " (modified)"
        if entry["entry_index"] in excluded:
            line += "  ~~marked to be removed~~"

        return line

    def render_overview(self, pending: list, overrides: dict, excluded: set):
        """Display overview of pending sync entries."""
        print("\n--- Pending Sync ---")
        for p in pending:
            print(self.render_entry_line(p, overrides, excluded))
        print()

    def render_edit_menu(self, pending: list, overrides: dict, excluded: set):
        """Display edit menu with original + proposed changes."""
        print("\n--- Edit Mode ---")
        for p in pending:
            print(self.render_entry_line(p, overrides, excluded))
            if p["entry_index"] in overrides:
                print(self._format_proposed_line(p, overrides))

    def render_review(self, entries: list):
        """Display review of entries as they'd appear after sync."""
        if not entries:
            print("No completed staged entries to review.")
            return

        by_date = {}
        for p in entries:
            by_date.setdefault(p["date"], []).append(p)

        print("\n=== Staging Preview (as would appear after sync) ===")
        total_duration = 0
        total_entries = len(entries)

        for date_str in sorted(by_date):
            day_entries = by_date[date_str]
            day_duration = sum(e["duration"] for e in day_entries)
            total_duration += day_duration

            print(f"\n\u2500\u2500 {date_str} \u2500\u2500 ({len(day_entries)} entries, {day_duration // 60000}m total)")

            for e in day_entries:
                start_str = time.strftime("%H:%M", time.localtime(e["start_epoch"] / 1000))
                end_str = time.strftime("%H:%M", time.localtime(e["end_epoch"] / 1000)) if e["end_epoch"] else "??"
                dur_str = f"{e['duration'] // 60000}m" if e['duration'] >= 0 else f"({e['duration'] // 60000}m)"
                tag_str = f" [{', '.join(e['tags'])}]" if e["tags"] else ""
                comment_str = f" \u2014 {e['comment']}" if e.get("comment") else ""

                pause_str = ""
                if e.get("pauses"):
                    total_pause_ms = sum(
                        (p.get("pause_stop", 0) or 0) - p["pause_start"]
                        for p in e["pauses"] if p.get("pause_stop")
                    )
                    if total_pause_ms > 0:
                        pause_str = f" (paused {total_pause_ms // 60000}m)"

                print(f"  [{start_str}-{end_str}] {e['title']}{tag_str} ({dur_str}){pause_str}{comment_str}")

        print(f"\n\u2500\u2500 Summary: {total_entries} entries, {total_duration // 60000}m total over {len(by_date)} day(s) \u2500\u2500")

    # ==================================================================
    # Active tasks display
    # ==================================================================

    @staticmethod
    def _decrypt_staging_field(encrypted_value: str, decrypt_fn) -> Optional[str]:
        """Decrypt a staging field value, handling plain: prefix and ciphertext.

        Returns the decrypted string, or None if the value is None.
        """
        if encrypted_value is None:
            return None
        if encrypted_value.startswith("plain:"):
            return encrypted_value[6:]
        return decrypt_fn(encrypted_value)

    def render_active_list(self, entries: list, show_tags: bool = False):
        """Display active tasks, decrypting as needed."""
        print("\n--- Running Tasks ---")
        if not entries:
            print("No active tasks.")
            return

        for entry in entries:
            data = entry["data"]
            task_id = entries.index(entry) + 1

            start_val = data["startTime_enc"]
            start_epoch = int(self._decrypt_staging_field(start_val, self.ledger.crypto.decrypt))
            started = time.strftime("%H:%M:%S", time.localtime(start_epoch / 1000))

            pauses_enc = data.get("pauses_enc")
            pauses = []
            if pauses_enc:
                pauses_raw = self._decrypt_staging_field(pauses_enc, self.ledger.crypto.decrypt)
                pauses = json.loads(pauses_raw) if pauses_raw else []

            tag_str = ""
            if show_tags:
                tags = data.get("tags", [])
                if tags:
                    tag_str = f" [@{', @'.join(tags)}]"

            if data.get("is_paused"):
                if pauses and pauses[-1].get("pause_stop") is None:
                    paused_since = pauses[-1]["pause_start"]
                    duration_ms = self.ledger._compute_duration(start_epoch, paused_since, pauses)
                    pause_time = time.strftime("%H:%M:%S", time.localtime(paused_since / 1000))
                    print(f"#{task_id} [{started}] {data['title']} (\u23f8 paused at {pause_time}, active: {duration_ms // 60000}m){tag_str}")
                else:
                    print(f"#{task_id} [{started}] {data['title']} (\u23f8 paused){tag_str}")
            else:
                now = int(time.time() * 1000)
                duration_ms = self.ledger._compute_duration(start_epoch, now, pauses)
                print(f"#{task_id} [{started}] {data['title']} (active: {duration_ms // 60000}m){tag_str}")

    # ==================================================================
    # Reputation summary
    # ==================================================================

    def render_summary(self, summary: dict):
        """Display reputation summary from blind index data."""
        print("\n--- Reputation Summary ---")
        for title, total_ms in sorted(summary.items(), key=lambda x: x[1], reverse=True):
            print(f"{title}: {total_ms // 60000}m")

    # ==================================================================
    # Activity listing
    # ==================================================================

    def render_activities(self, activities: list, source: str = "all"):
        """Display a detailed list of activities."""
        print(f"\n--- Detailed Habit List ({source.capitalize()}) ---")
        for item in activities:
            self._print_entry(item)

    def _print_entry(self, entry_data: dict):
        """Print a single entry (synced or staged), decrypting as needed."""
        data = entry_data["data"]

        start_epoch = int(self._decrypt_staging_field(data["startTime_enc"], self.ledger.crypto.decrypt))

        end_val = data.get("endTime_enc")
        if end_val:
            stop_epoch = int(self._decrypt_staging_field(end_val, self.ledger.crypto.decrypt))
        else:
            stop_epoch = None

        start_str = time.strftime("%H:%M", time.localtime(start_epoch / 1000))
        stop_str = time.strftime("%H:%M", time.localtime(stop_epoch / 1000)) if stop_epoch else "??"

        meta_enc = data.get("metadata_enc")
        if meta_enc:
            meta_raw = self._decrypt_staging_field(meta_enc, self.ledger.crypto.decrypt)
            meta = json.loads(meta_raw) if meta_raw else {}
        else:
            meta = {}

        source_indicator = " (Staged)" if entry_data["source"] == "staged" else ""
        print(f"  [{start_str} - {stop_str}] {data['title']}{source_indicator} ({data['duration'] // 60000}m)")
        if meta:
            print(f"    Metadata: {meta}")

    # ==================================================================
    # Tags display
    # ==================================================================

    def render_tags(self, tags: list):
        """Display all unique tags."""
        if tags:
            print("\n--- Tags ---")
            for t in tags:
                print(f"  @{t}")
        else:
            print("No tags found.")

    # ==================================================================
    # Error / Success / Warning
    # ==================================================================

    def render_error(self, message: str):
        print(message)

    def render_success(self, message: str):
        print(message)

    def render_warning(self, message: str):
        print(message)

    def render_help(self, help_items: dict):
        """Print a formatted help listing from {key: description} dict."""
        print("\nAvailable commands:")
        for key, desc in help_items.items():
            print(f"  {key} \u2014 {desc}")
        print()

    # ==================================================================
    # Input
    # ==================================================================

    def prompt_choice(self, prompt: str, options: list,
                      help_items: dict = None) -> str:
        """Single-character input with validation.
        If help_items is provided, '?' is auto-added as a valid option.
        """
        effective_options = set(options)
        if help_items is not None:
            effective_options.add("?")
        while True:
            choice = input(prompt).strip().upper()
            if choice in effective_options:
                if choice == "?" and help_items is not None:
                    self.render_help(help_items)
                    continue
                return choice
            print(f"Invalid choice. Options: {', '.join(sorted(effective_options))}")

    def prompt_text(self, prompt: str, default: str = "") -> str:
        result = input(prompt).strip()
        return result if result else default

    def prompt_time(self, prompt: str, date_str: str,
                    start_epoch: int, end_epoch: int = None) -> Optional[int]:
        raw = input(prompt).strip()
        if not raw:
            return None
        result, _ = parse_time_input(raw, date_str, start_epoch, end_epoch) or (None, "")
        return result

    def prompt_yes_no(self, prompt: str, default: bool = False) -> bool:
        raw = input(prompt).strip().lower()
        if raw in ("y", "yes"):
            return True
        if raw in ("n", "no"):
            return False
        return default

    def prompt_int(self, prompt: str, min_val: int = None,
                   max_val: int = None) -> Optional[int]:
        try:
            raw = input(prompt).strip()
            if not raw:
                return None
            val = int(raw)
            if min_val is not None and val < min_val:
                print(f"Value must be >= {min_val}.")
                return None
            if max_val is not None and val > max_val:
                print(f"Value must be <= {max_val}.")
                return None
            return val
        except ValueError:
            return None

    def prompt_tag_action(self, current_tags: list) -> tuple:
        """Interactive tag editor using prompt-based menu."""
        tags = list(current_tags)
        print(f"\n--- Tags (current: {', '.join(tags) if tags else 'none'}) ---")
        modified = False
        while True:
            action = self.prompt_choice(
                "  [A]dd tag, [R]emove tag, [D]one: ",
                ("A", "R", "D"),
            )
            if action == "A":
                t = self.prompt_text("  Tag to add: ").lower()
                if t:
                    if t not in tags:
                        tags.append(t)
                        tags.sort()
                        self.render_success(f"  Added @{t}")
                        modified = True
                    else:
                        self.render_warning(f"  @{t} already present.")
            elif action == "R":
                if not tags:
                    self.render_warning("  No tags to remove.")
                else:
                    self.render_warning(f"  Tags: {', '.join(f'@{t}' for t in tags)}")
                    t = self.prompt_text("  Tag to remove: ").lower()
                    if t in tags:
                        tags.remove(t)
                        self.render_success(f"  Removed @{t}")
                        modified = True
                    else:
                        self.render_warning(f"  @{t} not found.")
            elif action == "D":
                break
        return tags, modified

    # ==================================================================
    # Interactive workflows (previously in main.py handlers)
    # ==================================================================

    def interactive_modify(self, staging_index: int = None):
        """Modify a staged entry's end time, pauses, comment, tags, and media.
        Previously: main.py _handle_modify()
        """
        staging = self.ledger.store.read_staging()
        completed = [(i, e) for i, e in enumerate(staging)
                      if not e["data"].get("is_active", False)
                      and not e["data"].get("is_paused", False)]

        if not completed:
            self.render_error("No completed staged entries to modify.")
            return

        print("\n=== Staged Entries ===")
        for idx, entry in completed:
            data = entry["data"]
            start_epoch = int(self._decrypt_staging_field(data["startTime_enc"], self.ledger.crypto.decrypt))
            end_val = data["endTime_enc"]
            if end_val:
                end_epoch = int(self._decrypt_staging_field(end_val, self.ledger.crypto.decrypt))
            else:
                end_epoch = None

            start_str = time.strftime("%H:%M", time.localtime(start_epoch / 1000))
            end_str = time.strftime("%H:%M", time.localtime(end_epoch / 1000)) if end_epoch else "??"
            print(f"  #{idx}: [{start_str}-{end_str}] {data['title']} ({data.get('duration', 0) // 60000}m)")

        if staging_index is None:
            staging_index = self.prompt_int("\nEnter entry index to modify: ")
            if staging_index is None:
                self.render_error("Invalid index.")
                return

        if staging_index < 0 or staging_index >= len(staging):
            self.render_error(f"No staged entry at index {staging_index}.")
            return
        entry = staging[staging_index]
        data = entry["data"]
        if data.get("is_active", False):
            self.render_error(f"Cannot modify active task '{data['title']}'. End it first.")
            return

        print(f"\nModifying: {data['title']}")

        # Decrypt current values
        start_epoch = int(self._decrypt_staging_field(data["startTime_enc"], self.ledger.crypto.decrypt))
        end_val = data["endTime_enc"]
        if end_val:
            current_end = int(self._decrypt_staging_field(end_val, self.ledger.crypto.decrypt))
        else:
            current_end = None

        pauses_enc = data.get("pauses_enc")
        if pauses_enc:
            pauses_raw = self._decrypt_staging_field(pauses_enc, self.ledger.crypto.decrypt)
            current_pauses = json.loads(pauses_raw) if pauses_raw else []
        else:
            current_pauses = []

        date_str = time.strftime("%Y-%m-%d", time.localtime(start_epoch / 1000))
        start_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(start_epoch / 1000))
        print(f"  Date:  {date_str}")
        print(f"  Start: {start_str}")
        if current_end:
            end_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(current_end / 1000))
            print(f"  End:   {end_str}")
        print(f"  Duration: {data.get('duration', 0) // 60000}m")
        if current_pauses:
            print(f"  Pauses:")
            for p in current_pauses:
                ps = time.strftime("%H:%M:%S", time.localtime(p["pause_start"] / 1000))
                if p.get("pause_stop"):
                    pst = time.strftime("%H:%M:%S", time.localtime(p["pause_stop"] / 1000))
                    pdur = (p["pause_stop"] - p["pause_start"]) // 60000
                    print(f"    #{p['pause_index']}: {ps} -> {pst} ({pdur}m)")
                else:
                    print(f"    #{p['pause_index']}: {ps} -> ongoing")

        changes_made = {"end_epoch": None, "pauses": None}

        # EDIT END TIME
        end_input = self.prompt_text(
            "\nNew end time (blank=keep, HH:MM, +N[m|h|s], N[h][m][s], or epoch ms): "
        )
        if end_input:
            new_end, _ = parse_time_input(end_input, date_str, start_epoch, current_end) or (None, None)
            if new_end is not None:
                current_end = new_end
                changes_made["end_epoch"] = new_end
                end_str = time.strftime("%H:%M:%S", time.localtime(current_end / 1000))
                self.render_success(f"  End set to {end_str}")
            else:
                self.render_warning("  Invalid format, keeping original.")

        # EDIT COMMENT
        current_comment = data.get("comment")
        if current_comment:
            comment_input = self.prompt_text(f'  Comment ("{current_comment}", edit, or blank to clear): ')
        else:
            comment_input = self.prompt_text("  Comment (optional, or blank to keep): ")

        if comment_input:
            data["comment"] = comment_input
            self.render_success(f"  Comment set to: {comment_input}")
        elif current_comment and comment_input == "":
            data["comment"] = None
            self.render_success("  Comment cleared.")

        # EDIT TAGS
        tags, tags_modified = self.prompt_tag_action(list(data.get("tags", [])))
        if tags_modified:
            data["tags"] = tags

        # MEDIA STUB
        current_media = list(data.get("media", []))
        if current_media:
            print(f"\n  Current media: {json.dumps(current_media)}")
        add_media = self.prompt_text("  Add media? (filename,hash or blank to skip): ")
        if add_media:
            parts = add_media.split(",")
            if len(parts) == 2:
                fname, fhash = parts[0].strip(), parts[1].strip()
                current_media.append({"filename": fname, "hash": fhash})
                data["media"] = current_media
                self.render_success(f"  Added media: {fname}")
            else:
                self.render_warning("  Expected format: filename,hash")

        # EDIT PAUSES
        self._edit_pauses(current_pauses, date_str, start_epoch, current_end, changes_made)
        pause_modified = changes_made.get("pauses") is not None

        # Recompute hash if any data changed
        if any([changes_made["end_epoch"], pause_modified,
                comment_input or (current_comment and comment_input == ""),
                tags_modified, add_media]):
            entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

        if changes_made["end_epoch"] or pause_modified:
            try:
                result = self.ledger.modify_staged_entry(
                    staging_index,
                    end_epoch=changes_made["end_epoch"],
                    pauses=changes_made.get("pauses"),
                )
                self.render_success(f"\nDone: {result['title']} (duration: {result['duration'] // 60000}m)")
            except ValueError as e:
                self.render_error(f"Error: {e}")
        else:
            if any([comment_input or (current_comment and comment_input == ""),
                    tags_modified, add_media]):
                self.ledger.store.write_staging(staging)
                self.render_success(f"\nDone: {data.get('title', '?')}")

    def interactive_remove(self, staging_index: int = None, auto_yes: bool = False):
        """Remove a staged entry interactively.
        Previously: main.py _handle_remove()
        """
        staging = self.ledger.store.read_staging()
        if not staging:
            self.render_error("No entries in staging.")
            return

        print("\n=== Staged Entries ===")
        for idx, entry in enumerate(staging):
            self._print_staging_line(entry, idx)

        if staging_index is None:
            staging_index = self.prompt_int("\nEnter entry index to remove: ")
            if staging_index is None:
                self.render_error("Invalid index.")
                return

        if staging_index < 0 or staging_index >= len(staging):
            self.render_error(f"No staged entry at index {staging_index}.")
            return

        title = staging[staging_index]["data"]["title"]
        if not auto_yes:
            confirm = self.prompt_yes_no(f"Remove '{title}' from staging? (y/N): ", default=False)
            if not confirm:
                self.render_success("Cancelled.")
                return

        try:
            removed = self.ledger.remove_staged_entry(staging_index)
            self.render_success(f"\u2713 Removed: {removed}")
        except ValueError as e:
            self.render_error(f"Error: {e}")

    def interactive_review(self):
        """Preview staged entries as they'd appear after sync.
        Previously: main.py _handle_review()
        """
        preview = self.ledger.get_staged_entries_preview()
        self.render_review(preview)

    # ==================================================================
    # Date filter resolution (moved from CLIInterface)
    # ==================================================================

    @staticmethod
    def resolve_date_filters(days=None, date=None, week=None, month=None, year=None,
                             from_date=None, to_date=None):
        """Resolve date filter args into (from_str, to_str) in YYYY-MM-DD format."""
        from_str = None
        to_str = None
        import sys

        def _narrow(lo, hi):
            nonlocal from_str, to_str
            if lo is not None:
                if from_str is None or lo > from_str:
                    from_str = lo
            if hi is not None:
                if to_str is None or hi < to_str:
                    to_str = hi

        def _month_range(y, m):
            last = calendar.monthrange(y, m)[1]
            return (f"{y:04d}-{m:02d}-01", f"{y:04d}-{m:02d}-{last:02d}")

        def _parse_date_input(val, hint_year=None):
            val = str(val).strip()
            m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', val)
            if m:
                return (val, val)
            m = re.match(r'^(\d{4})-(\d{2})$', val)
            if m:
                return _month_range(int(m.group(1)), int(m.group(2)))
            m = re.match(r'^(\d{4})$', val)
            if m:
                return (f"{val}-01-01", f"{val}-12-31")
            m = re.match(r'^(\d{2})/(\d{2})$', val)
            if m:
                return _month_range(2000 + int(m.group(2)), int(m.group(1)))
            m = re.match(r'^(\d{2})$', val)
            if m:
                return _month_range(hint_year or datetime.now().year, int(m.group(1)))
            raise ValueError(f"Unrecognized date format: {val}")

        def _iso_week_range(week_str):
            week_str = str(week_str).strip()
            m = re.match(r'^(\d{4})-W(\d{2})$', week_str)
            if m:
                mon = datetime.fromisocalendar(int(m.group(1)), int(m.group(2)), 1)
                sun = datetime.fromisocalendar(int(m.group(1)), int(m.group(2)), 7)
                return (mon.strftime("%Y-%m-%d"), sun.strftime("%Y-%m-%d"))
            m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', week_str)
            if m:
                d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                iso_year, iso_week, _ = d.isocalendar()
                mon = datetime.fromisocalendar(iso_year, iso_week, 1)
                sun = datetime.fromisocalendar(iso_year, iso_week, 7)
                return (mon.strftime("%Y-%m-%d"), sun.strftime("%Y-%m-%d"))
            raise ValueError(f"Unrecognized week format: {week_str}")

        hint_year = None
        if year:
            hint_year = int(year)

        if date:
            lo, hi = _parse_date_input(date)
            _narrow(lo, hi)
        elif days is not None:
            limit_epoch = time.time() - (days * 86400)
            lo = time.strftime("%Y-%m-%d", time.localtime(limit_epoch))
            _narrow(lo, None)

        if week:
            lo, hi = _iso_week_range(week)
            _narrow(lo, hi)
        if month:
            lo, hi = _parse_date_input(month, hint_year=hint_year)
            _narrow(lo, hi)
        if year:
            _narrow(f"{year}-01-01", f"{year}-12-31")

        if from_date is not None:
            lo, _ = _parse_date_input(from_date, hint_year=hint_year)
            if lo is not None:
                if from_str is None or lo > from_str:
                    from_str = lo
        if to_date is not None:
            _, hi = _parse_date_input(to_date, hint_year=hint_year)
            if hi is not None:
                if to_str is None or hi < to_str:
                    to_str = hi

        if from_str is not None and to_str is not None and from_str > to_str:
            print(f"WARN: Date range conflict \u2014 from ({from_str}) is after to ({to_str})",
                  file=sys.stderr)
            return (None, None)

        return (from_str, to_str)

    # ==================================================================
    # Helpers (private)
    # ==================================================================

    def _print_staging_line(self, entry, idx):
        """Print one line for a staged entry (handle plain: prefix).
        Used by interactive_remove when user may not be authenticated.
        """
        data = entry["data"]
        start_val = data["startTime_enc"]
        if not start_val.startswith("plain:"):
            print(f"  #{idx}: {data['title']} (encrypted \u2014 use auth to view)")
            return
        start_epoch = int(self._decrypt_staging_field(start_val, self.ledger.crypto.decrypt))

        end_val = data.get("endTime_enc")
        if end_val and end_val.startswith("plain:"):
            end_epoch = int(self._decrypt_staging_field(end_val, self.ledger.crypto.decrypt))
        else:
            end_epoch = None

        start_str = time.strftime("%H:%M", time.localtime(start_epoch / 1000))
        end_str = time.strftime("%H:%M", time.localtime(end_epoch / 1000)) if end_epoch else "??"
        active_str = " [active]" if data.get("is_active") else ""
        paused_str = " [paused]" if data.get("is_paused") else ""

        print(f"  #{idx}: [{start_str}-{end_str}] {data['title']} ({data.get('duration', 0) // 60000}m){active_str}{paused_str}")

    def _format_proposed_line(self, p, overrides):
        """Build a formatted proposed-changes line for a modified entry."""
        override = overrides[p["entry_index"]]
        start_str = time.strftime("%H:%M", time.localtime(p["start_epoch"] // 1000))
        end_epoch = override.get("end_epoch", p["end_epoch"])
        end_str = time.strftime("%H:%M", time.localtime(end_epoch // 1000))
        dur = end_epoch - p["start_epoch"] if end_epoch else p.get("duration", 0)
        comment = override.get("comment", p.get("comment"))
        comment_str = f'  comment: "{comment}"' if comment else ""
        return f"       proposed: {start_str}-{end_str}, duration {self._format_duration(dur)}{comment_str}"

    @staticmethod
    def _format_duration(ms):
        """Format milliseconds to HH:MM:SS string."""
        total_seconds = ms // 1000
        h = total_seconds // 3600
        m = (total_seconds % 3600) // 60
        s = total_seconds % 60
        return f"{h:02d}h{m:02d}m{s:02d}s"

    def _edit_pauses(self, current_pauses, date_str, start_epoch, current_end,
                     changes_made):
        """Interactive pause editor."""
        print("\n--- Pause Editor ---")
        print("  Options:")
        print("    [A]dd pause      [E]dit pause")
        print("    [R]emove pause   [C]lear all pauses")
        print("    [K]eep current")

        new_pauses = [dict(p) for p in current_pauses]

        while True:
            pause_action = self.prompt_choice(
                "  Choice (A/E/R/C/K): ",
                ("A", "E", "R", "C", "K"),
            )
            if pause_action == "A":
                try:
                    p_start_input = self.prompt_text(
                        "  Pause start (HH:MM, +N[m|h|s], N[h][m][s]): "
                    )
                    if not p_start_input:
                        self.render_warning("  Cancelled.")
                        continue
                    pause_start, _ = parse_time_input(
                        p_start_input, date_str, start_epoch, current_end
                    ) or (None, None)
                    if pause_start is None:
                        self.render_warning("  Invalid format.")
                        continue

                    p_stop_input = self.prompt_text(
                        "  Pause stop (HH:MM, +N[m|h|s], N[h][m][s], or blank for ongoing): "
                    )
                    pause_stop = None
                    if p_stop_input:
                        pause_stop, _ = parse_time_input(
                            p_stop_input, date_str, start_epoch, current_end
                        ) or (None, None)
                        if pause_stop is None:
                            self.render_warning("  Invalid format.")
                            continue
                        if current_end is not None and pause_stop > current_end:
                            pause_stop = current_end
                            self.render_success(
                                f"  Pause stop clamped to activity end "
                                f"({time.strftime('%H:%M:%S', time.localtime(current_end / 1000))})"
                            )

                    next_idx = max([p.get("pause_index", 0) for p in new_pauses], default=0) + 1
                    new_pauses.append({
                        "pause_index": next_idx,
                        "pause_start": pause_start,
                        "pause_stop": pause_stop,
                    })
                    self.render_success(f"  Added pause #{next_idx}.")
                    changes_made["pauses"] = new_pauses
                except (ValueError, IndexError, TypeError):
                    self.render_warning("  Invalid time format, no pause added.")

            elif pause_action == "E":
                if not new_pauses:
                    self.render_warning("  No pauses to edit.")
                    continue
                try:
                    e_idx = self.prompt_int(f"  Pause index to edit (1-{len(new_pauses)}): ")
                    if e_idx is None:
                        continue
                    found = [p for p in new_pauses if p["pause_index"] == e_idx]
                    if not found:
                        self.render_warning(f"  No pause with index {e_idx}.")
                        continue
                    p = found[0]
                    ps_str = time.strftime("%H:%M:%S", time.localtime(p["pause_start"] / 1000))
                    print(f"  Editing pause #{e_idx}: currently start={ps_str}")

                    new_start_input = self.prompt_text("  New start (blank to keep, HH:MM, +N[m|h|s]): ")
                    if new_start_input:
                        new_start, _ = parse_time_input(new_start_input, date_str, start_epoch, current_end) or (None, None)
                        if new_start is not None:
                            p["pause_start"] = new_start
                            print(f"  Start set to {time.strftime('%H:%M:%S', time.localtime(new_start/1000))}")
                            changes_made["pauses"] = new_pauses
                        else:
                            print("  Invalid format, keeping original.")

                    pst_str = time.strftime("%H:%M:%S", time.localtime(p["pause_stop"]/1000)) if p.get("pause_stop") else "ongoing"
                    print(f"  Currently stop={pst_str}")
                    new_stop_input = self.prompt_text(
                        "  New stop (blank to keep, HH:MM, +N[m|h|s], -N[m|h|s], or 'none' for ongoing): "
                    )
                    if new_stop_input:
                        if new_stop_input.lower() == "none":
                            p["pause_stop"] = None
                            print("  Stop cleared (ongoing).")
                            changes_made["pauses"] = new_pauses
                        else:
                            new_stop, _ = parse_time_input(new_stop_input, date_str, start_epoch, current_end) or (None, None)
                            if new_stop is not None:
                                if current_end is not None and new_stop > current_end:
                                    new_stop = current_end
                                    print(f"  Pause stop clamped to activity end ({time.strftime('%H:%M:%S', time.localtime(current_end/1000))})")
                                p["pause_stop"] = new_stop
                                print(f"  Stop set to {time.strftime('%H:%M:%S', time.localtime(new_stop/1000))}")
                                changes_made["pauses"] = new_pauses
                            else:
                                print("  Invalid format, keeping original.")
                except ValueError:
                    print("  Invalid index.")

            elif pause_action == "R":
                if not new_pauses:
                    self.render_warning("  No pauses to remove.")
                    continue
                try:
                    r_idx = self.prompt_int(f"  Pause index to remove (1-{len(new_pauses)}): ")
                    if r_idx is None:
                        continue
                    removed = [p for p in new_pauses if p["pause_index"] == r_idx]
                    if removed:
                        new_pauses = [p for p in new_pauses if p["pause_index"] != r_idx]
                        for i, p in enumerate(new_pauses):
                            p["pause_index"] = i + 1
                        print(f"  Removed pause #{r_idx}.")
                        changes_made["pauses"] = new_pauses
                    else:
                        print(f"  No pause with index {r_idx}.")
                except ValueError:
                    print("  Invalid index.")

            elif pause_action == "C":
                new_pauses = []
                changes_made["pauses"] = new_pauses
                print("  All pauses cleared.")

            elif pause_action == "K":
                break
