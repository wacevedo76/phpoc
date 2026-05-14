import json
import time
import calendar
import re
from datetime import datetime
from typing import Optional, List, Dict, Any
from security.crypto import AbstractCryptoManager
from domain.staging.service import StagingService
from domain.ledger.engine import LedgerEngine


class CLIInterface:
    def __init__(
        self,
        staging_service: StagingService,
        ledger_engine: LedgerEngine,
        crypto: AbstractCryptoManager,
    ):
        self._staging = staging_service
        self._ledger_engine = ledger_engine
        self._crypto = crypto

    def _resolve_title(self, identifier):
        """Resolve a string identifier to a title.
        If identifier looks like a positive integer (e.g. '1', '2'),
        treat it as a 1-based index into the active tasks list.
        Otherwise, return the identifier as-is (title string).
        If an exact title match exists among active tasks, title takes precedence."""
        staging = self._staging._local._store.read_entries()
        active = [e for e in staging if e["data"].get("is_active")]
        active_titles = [e["data"]["title"] for e in active]

        # Title match takes precedence
        if identifier in active_titles:
            return identifier

        # Try numeric ID
        try:
            idx = int(identifier)
            if idx < 1:
                raise ValueError(f"Invalid ID: {identifier}. IDs start at 1.")
            if not active_titles:
                raise ValueError(f"No active tasks to reference by ID.")
            if idx > len(active_titles):
                raise ValueError(f"ID {idx} out of range. Only {len(active_titles)} active task(s).")
            return active_titles[idx - 1]
        except ValueError as e:
            # If int() itself failed, it's not a number — treat as title
            if str(identifier).lstrip('-').isdigit() and int(identifier) < 1:
                raise ValueError(f"Invalid ID: {identifier}. IDs start at 1.")
            # If we raised one of the ID-related errors, re-raise
            if "Invalid ID" in str(e) or "No active tasks" in str(e) or "out of range" in str(e):
                raise
            # Not a number — treat as title (already checked above; fallback)
            return identifier

    def _get_active_with_ids(self):
        """Return list of {id, title} dicts for active tasks."""
        staging = self._staging._local._store.read_entries()
        active = [e for e in staging if e["data"].get("is_active")]
        return [{"id": i + 1, "title": e["data"]["title"]} for i, e in enumerate(active)]

    @staticmethod
    def _compute_duration(start_epoch, end_epoch, pauses):
        """Compute active duration as wall time minus all completed pause intervals."""
        total_pause_ms = 0
        for p in pauses:
            if p.get("pause_stop") is not None:
                total_pause_ms += p["pause_stop"] - p["pause_start"]
        return max(0, (end_epoch - start_epoch) - total_pause_ms)

    @staticmethod
    def _normalize_tag_args(tag_args):
        """Normalize a list of raw tag strings from CLI.
        Returns a sorted, deduplicated, lowercased list with whitespace stripped.
        Returns None if no valid tags remain."""
        if not tag_args:
            return None
        seen = set()
        result = []
        for t in tag_args:
            clean = t.strip().lower()
            if clean and clean not in seen:
                seen.add(clean)
                result.append(clean)
        result.sort()
        return result if result else None

    def add_oneoff(self, title, start, stop, metadata=None, tags=None):
        self._staging.capture(title, start, stop_epoch=stop, metadata=metadata, is_active=False, tags=tags)
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        print(f"\u2713 One-off habit captured: {title}{tag_str}")

    def add_start(self, title, tags=None):
        self._staging.capture(title, int(time.time()*1000), is_active=True, tags=tags)
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        print(f"\u2713 Started tracking: {title}{tag_str}")

    def add_end(self, title):
        resolved = self._resolve_title(title)
        self._staging.end(resolved, int(time.time()*1000))
        print(f"\u2713 Stopped tracking: {resolved}")

    def add_pause(self, title):
        resolved = self._resolve_title(title)
        self._staging.pause(resolved, int(time.time()*1000))
        print(f"\u2713 Paused: {resolved}")

    def add_unpause(self, title):
        resolved = self._resolve_title(title)
        self._staging.unpause(resolved, int(time.time()*1000))
        print(f"\u2713 Resumed: {resolved}")

    def view_active(self, show_tags=False):
        staging = self._staging._local._store.read_entries()
        active = [e for e in staging if e["data"].get("is_active")]

        print("\n--- Running Tasks ---")
        if not active:
            print("No active tasks.")
            return

        # Get active list with IDs for display
        active_with_ids = self._get_active_with_ids()
        id_map = {a["title"]: a["id"] for a in active_with_ids}

        for entry in active:
            data = entry["data"]
            task_id = id_map.get(data["title"], "?")
            # Decrypt startTime for viewing
            start_val = data["startTime_enc"]
            if start_val.startswith("plain:"):
                start_epoch = int(start_val[6:])
            else:
                start_epoch = int(self._crypto.decrypt(start_val))
            started = time.strftime("%H:%M:%S", time.localtime(start_epoch/1000))

            # Show pause indicator and active duration so far
            # Compute active duration up to now, excluding pauses
            pauses_enc = data.get("pauses_enc")
            pauses = []
            if pauses_enc:
                if pauses_enc.startswith("plain:"):
                    pauses = json.loads(pauses_enc[6:])
                else:
                    pauses = json.loads(self._crypto.decrypt(pauses_enc))

            # Tags display
            tag_str = ""
            if show_tags:
                tags = data.get("tags", [])
                if tags:
                    tag_str = f" [@{', @'.join(tags)}]"

            if data.get("is_paused"):
                # Task is paused — show duration up to the pause start
                if pauses and pauses[-1].get("pause_stop") is None:
                    paused_since = pauses[-1]["pause_start"]
                    duration_ms = self._compute_duration(start_epoch, paused_since, pauses)
                    pause_time = time.strftime("%H:%M:%S", time.localtime(paused_since/1000))
                    print(f"#{task_id} [{started}] {data['title']} (\u23f8 paused at {pause_time}, active: {duration_ms // 60000}m){tag_str}")
                else:
                    print(f"#{task_id} [{started}] {data['title']} (\u23f8 paused){tag_str}")
            else:
                # Task is actively running — show live duration (excluding past pauses)
                now = int(time.time() * 1000)
                duration_ms = self._compute_duration(start_epoch, now, pauses)
                print(f"#{task_id} [{started}] {data['title']} (active: {duration_ms // 60000}m){tag_str}")

    def show_rep(self, days_limit=None, from_date=None, to_date=None):
        # Use Blind Index for speed and privacy
        index = self._ledger_engine._index.get_all()
        rep = {}

        from_str = from_date
        to_str = to_date
        if days_limit is not None and from_str is None:
            limit_epoch = time.time() - (days_limit * 86400)
            from_str = time.strftime("%Y-%m-%d", time.localtime(limit_epoch))

        for date_str, activities in index.items():
            if from_str and date_str < from_str: continue
            if to_str and date_str > to_str: continue

            for title, duration in activities.items():
                rep[title] = rep.get(title, 0) + duration

        print(f"\n--- Reputation Summary ---")
        for title, total_ms in sorted(rep.items(), key=lambda x: x[1], reverse=True):
            print(f"{title}: {total_ms // 60000}m")

    def list_habits(self, source: str, days_limit=None, from_date=None, to_date=None):
        print(f"\n--- Detailed Habit List ({source.capitalize()}) ---")

        # Convert days_limit to from_date if from_date is not already set
        if days_limit is not None and from_date is None:
            limit_epoch = time.time() - (days_limit * 86400)
            from_date = time.strftime("%Y-%m-%d", time.localtime(limit_epoch))

        synced_data = []
        if source in ['synced', 'all']:
            synced_data = self._ledger_engine.get_day_blocks() or [] # Ensure it's a list if None

        staged_data = []
        if source in ['staged', 'all']:
            staged_data = self._staging._local._store.read_entries()
            # Mark staged items for clarity or specific handling if needed
            for item in staged_data:
                item['data']['_is_staged'] = True

        # Process synced data
        synced_by_date = {}
        for day in synced_data:
            if day.get("type", "day") != "day": continue
            date_str = day["date"]

            # Apply date filters
            if (from_date and date_str < from_date) or (to_date and date_str > to_date):
                continue

            if date_str not in synced_by_date:
                synced_by_date[date_str] = []

            for entry in day.get("entries", []):
                synced_by_date[date_str].append({"source": "synced", "data": entry["data"], "date": date_str})

        # Process staged data
        # Group staged data by date to match ledger format for consistent display
        staged_by_date = {}
        for entry in staged_data:
            if not entry["data"].get("is_active", False): # Only consider completed staged tasks for listing
                start_val = entry["data"]["startTime_enc"]
                if start_val.startswith("plain:"):
                    start_epoch = int(start_val[6:])
                else:
                    start_epoch = int(self._crypto.decrypt(start_val))
                date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
                if date_str not in staged_by_date:
                    staged_by_date[date_str] = []
                staged_by_date[date_str].append({"source": "staged", "data": entry["data"], "date": date_str})

        # Combine dates from both sources
        all_dates = set(list(synced_by_date.keys()) + list(staged_by_date.keys()))

        for date_str in sorted(all_dates):
            if (from_date and date_str < from_date) or (to_date and date_str > to_date):
                continue

            # Skip if source filtering doesn't include this date's data
            if source == 'synced' and date_str not in synced_by_date:
                continue
            if source == 'staged' and date_str not in staged_by_date:
                continue

            # Print date header
            print(f"\nDate: {date_str}")

            # Process synced entries for this date
            if source in ['synced', 'all'] and date_str in synced_by_date:
                for entry_data in synced_by_date[date_str]:
                    self._print_entry(entry_data)

            # Process staged entries for this date
            if source in ['staged', 'all'] and date_str in staged_by_date:
                for entry_data in staged_by_date[date_str]:
                    self._print_entry(entry_data)

    @staticmethod
    def _resolve_date_filters(days=None, date=None, week=None, month=None, year=None,
                               from_date=None, to_date=None):
        """
        Resolve all date filter arguments into (from_str, to_str) in YYYY-MM-DD format.

        - Each range filter (date, week, month, year) narrows to its bounds.
        - from_date and to_date act as partial bounds (lower / upper).
        - days is only used if date is None (date overrides days).
        - MM-only values borrow year from --year or current year.
        - Conflicts print WARN: to stderr and return (None, None).

        Returns (from_str, to_str) where None means unbounded.
        """
        from_str = None
        to_str = None

        def _narrow(lo, hi):
            """Intersect a [lo, hi] range into the current bounds."""
            nonlocal from_str, to_str
            if lo is not None:
                if from_str is None or lo > from_str:
                    from_str = lo
            if hi is not None:
                if to_str is None or hi < to_str:
                    to_str = hi

        def _month_range(year_val, month_val):
            """Return (first_day, last_day) for a given year/month."""
            last = calendar.monthrange(year_val, month_val)[1]
            return (f"{year_val:04d}-{month_val:02d}-01",
                    f"{year_val:04d}-{month_val:02d}-{last:02d}")

        def _parse_date_input(val, hint_year=None):
            """Parse a date value into (from_str, to_str) bounds.
            Supports: YYYY-MM-DD, YYYY-MM, YYYY, MM/YY, MM.
            """
            val = str(val).strip()

            # YYYY-MM-DD
            m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', val)
            if m:
                return (val, val)

            # YYYY-MM
            m = re.match(r'^(\d{4})-(\d{2})$', val)
            if m:
                y, mo = int(m.group(1)), int(m.group(2))
                return _month_range(y, mo)

            # YYYY
            m = re.match(r'^(\d{4})$', val)
            if m:
                return (f"{val}-01-01", f"{val}-12-31")

            # MM/YY
            m = re.match(r'^(\d{2})/(\d{2})$', val)
            if m:
                mo, ys = int(m.group(1)), int(m.group(2))
                y = 2000 + ys
                return _month_range(y, mo)

            # MM (month only, borrow year)
            m = re.match(r'^(\d{2})$', val)
            if m:
                mo = int(m.group(1))
                y = hint_year or datetime.now().year
                return _month_range(y, mo)

            raise ValueError(f"Unrecognized date format: {val}")

        def _iso_week_range(week_str):
            """Parse '2026-W17' or '2026-04-22' into (monday, sunday)."""
            week_str = str(week_str).strip()

            # Try ISO week format: YYYY-Www
            m = re.match(r'^(\d{4})-W(\d{2})$', week_str)
            if m:
                year, week = int(m.group(1)), int(m.group(2))
                # fromisocalendar available in Python 3.8+
                monday = datetime.fromisocalendar(year, week, 1)
                sunday = datetime.fromisocalendar(year, week, 7)
                return (monday.strftime("%Y-%m-%d"), sunday.strftime("%Y-%m-%d"))

            # Try date format: YYYY-MM-DD
            m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', week_str)
            if m:
                d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                # Find Monday of the ISO week containing this date
                iso_year, iso_week, _ = d.isocalendar()
                monday = datetime.fromisocalendar(iso_year, iso_week, 1)
                sunday = datetime.fromisocalendar(iso_year, iso_week, 7)
                return (monday.strftime("%Y-%m-%d"), sunday.strftime("%Y-%m-%d"))

            raise ValueError(f"Unrecognized week format: {week_str}")

        # --- Resolution order ---

        hint_year = None
        if year:
            hint_year = int(year)

        # 1. Range filters (date, week, month, year) — narrow to intersection
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

        # 2. Partial bounds (from_date, to_date) — override previous bounds
        #    These are explicit user overrides. days/week/month/year set
        #    auto-inferred bounds; --from/--to take priority.
        if from_date is not None:
            lo, _ = _parse_date_input(from_date, hint_year=hint_year)
            if lo is not None:
                from_str = lo

        if to_date is not None:
            _, hi = _parse_date_input(to_date, hint_year=hint_year)
            if hi is not None:
                to_str = hi

        # 3. Conflict detection
        if from_str is not None and to_str is not None and from_str > to_str:
            import sys
            print(f"WARN: Date range conflict — from ({from_str}) is after to ({to_str})",
                  file=sys.stderr)
            return (None, None)

        return (from_str, to_str)

    def _print_entry(self, entry_data):
        """Helper method to print an entry (synced or staged)."""
        data = entry_data["data"]

        start_val = data["startTime_enc"]
        if start_val.startswith("plain:"):
            start_epoch = int(start_val[6:])
        else:
            start_epoch = int(self._crypto.decrypt(start_val))

        if data["endTime_enc"]:
            end_val = data["endTime_enc"]
            if end_val.startswith("plain:"):
                stop_epoch = int(end_val[6:])
            else:
                stop_epoch = int(self._crypto.decrypt(end_val))
        else:
            stop_epoch = None

        start_str = time.strftime("%H:%M", time.localtime(start_epoch/1000))
        stop_str = time.strftime("%H:%M", time.localtime(stop_epoch/1000)) if stop_epoch else "??"

        meta_enc = data.get("metadata_enc")
        if meta_enc:
            if meta_enc.startswith("plain:"):
                meta = json.loads(meta_enc[6:])
            else:
                meta = json.loads(self._crypto.decrypt(meta_enc))
        else:
            meta = {}

        # Add source indicator
        source_indicator = " (Staged)" if entry_data["source"] == "staged" else ""
        print(f"  [{start_str} - {stop_str}] {data['title']}{source_indicator} ({data['duration'] // 60000}m)")
        if meta: print(f"    Metadata: {meta}")
