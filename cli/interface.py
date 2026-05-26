import json
import time
import calendar
import re
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from security.crypto import AbstractCryptoManager
from domain.staging.service import StagingService
from domain.staging.remote_sync import SyncCheckResult
from domain.ledger.engine import LedgerEngine
from cli.trace import trace
from cli.background import _show_sync_notifications, _spawn_background_sync_check
from cli.wal import _write_wal_pending, _spawn_background_push


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

    def _sync_before_command(self, require_auth: bool = False) -> bool:
        """Sync staging with remote before executing a command.

        Checks device cookie for fast-path (same device, same session).
        If cookie mismatch or expired, pulls remote blob, merges, and
        if required, prompts for authentication.

        Args:
            require_auth: If True, REAUTH_NEEDED will prompt the user.

        Returns:
            True if sync was successful or not needed, False if re-auth
            failed (only when require_auth=True).
        """
        if self._staging._remote is None:
            return True  # No remote configured — nothing to sync

        result = self._staging.check_and_sync(timeout_ms=500)

        if result == SyncCheckResult.READY:
            return True

        if result == SyncCheckResult.OFFLINE:
            # Remote unreachable — continue with local data
            return True

        if result == SyncCheckResult.REAUTH_NEEDED:
            if require_auth:
                print("\nRemote staging has changed since your last session.")
                print("Please re-authenticate to sync.")
                # The caller (main.py) handles authentication flow.
                # Signal back that re-auth is needed.
                return False
            # Non-auth commands (view, list) can still show local data
            return True

        return True

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

    @trace
    def _push_if_remote(self):
        """Push staging to remote if configured (no-op otherwise).

        Requires a valid 32-byte master_key for blob obfuscation.
        If no key is available (unauthenticated session), skips the
        push and prints a warning — pushing plaintext staging data
        to a remote repo would leak private information.
        """
        if self._staging._remote is not None:
            # Derive master_key from crypto if available (authenticated session)
            mk = getattr(self._crypto, "master_key", None)
            if not isinstance(mk, bytes) or len(mk) != 32:
                print("Warning: cannot push to remote — authenticate first (e.g. 'phpoc view')")
                return
            self._staging.push_to_remote(master_key=mk)

    def _defer_push(self):
        """Phase B: write WAL + spawn background push instead of blocking.

        Called after every write command (add_start, add_end, etc.) to
        return control to the user instantly (~2ms) while the remote
        push happens in a detached subprocess.
        """
        if self._staging._remote is None:
            return

        # Read current staging entries for the WAL hash
        try:
            entries = self._staging._local._store.read_entries()
        except Exception:
            entries = []

        # Get device_id
        mk = getattr(self._crypto, "master_key", None)
        if isinstance(mk, bytes) and len(mk) == 32:
            try:
                identity = self._staging._device_id_provider.get_device_identity(mk)
                device_id = identity.device_id
            except Exception:
                device_id = "unknown"
        else:
            device_id = "unknown"

        # Write WAL (crash-safe bookmark) then spawn background push
        _write_wal_pending(self._staging._data_dir, entries, device_id)
        _spawn_background_push(self._staging._data_dir)

    @trace
    def add_oneoff(self, title, start, stop, metadata=None, tags=None, comment=None):
        if not self._sync_before_command(require_auth=True):
            print("Authentication required. Run 'ph login' or 'ph sync remote_staging' first.")
            return
        self._staging.capture(title, start, stop_epoch=stop, metadata=metadata, is_active=False, tags=tags, comment=comment)
        self._defer_push()
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        comment_str = f" — \"{comment}\"" if comment else ""
        print(f"\u2713 One-off habit captured: {title}{tag_str}{comment_str}")

    @trace
    def add_start(self, title, tags=None, comment=None):
        if not self._sync_before_command(require_auth=True):
            print("Authentication required. Run 'ph login' or 'ph sync remote_staging' first.")
            return
        self._staging.capture(title, int(time.time()*1000), is_active=True, tags=tags, comment=comment)
        self._defer_push()
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        comment_str = f" — \"{comment}\"" if comment else ""
        print(f"\u2713 Started tracking: {title}{tag_str}{comment_str}")

    @trace
    def add_end(self, title, comment=None):
        if not self._sync_before_command(require_auth=True):
            print("Authentication required. Run 'ph login' or 'ph sync remote_staging' first.")
            return
        resolved = self._resolve_title(title)
        self._staging.end(resolved, int(time.time()*1000), comment=comment)
        self._defer_push()
        comment_str = f" — \"{comment}\"" if comment else ""
        print(f"\u2713 Stopped tracking: {resolved}{comment_str}")

    @trace
    def add_pause(self, title):
        resolved = self._resolve_title(title)
        self._staging.pause(resolved, int(time.time()*1000))
        self._defer_push()
        print(f"\u2713 Paused: {resolved}")

    @trace
    def add_unpause(self, title):
        resolved = self._resolve_title(title)
        self._staging.unpause(resolved, int(time.time()*1000))
        self._defer_push()
        print(f"\u2713 Resumed: {resolved}")

    @trace
    def view_active(self, show_tags=False, show_comments=False):
        # Sync with remote before showing data (fast cookie check, no auth needed)
        self._sync_before_command(require_auth=False)

        # Phase A: Show any pending sync notifications from background checks
        _show_sync_notifications(self._staging._data_dir)

        # Phase A: Read and display local data INSTANTLY (no remote blocking)
        staging = self._staging._local._store.read_entries()
        active = [e for e in staging if e["data"].get("is_active")]

        # Phase A: Spawn background remote check (non-blocking, fire-and-forget)
        # Must fire before any early return so reads are always async.
        if self._staging._remote is not None:
            _spawn_background_sync_check(self._staging)

        print("\n--- Running Tasks ---")
        if not active:
            print("No active tasks.")
            return

        # Build active entries with IDs directly (avoid title-keyed map — dup titles)
        active_entries = []
        for i, entry in enumerate(active, 1):
            data = entry["data"]
            start_val = data["startTime_enc"]
            if start_val.startswith("plain:"):
                start_epoch = int(start_val[6:])
            else:
                start_epoch = int(self._crypto.decrypt(start_val))
            active_entries.append({"id": i, "entry": entry, "start_epoch": start_epoch})

        for ae in active_entries:
            data = ae["entry"]["data"]
            task_id = ae["id"]
            start_epoch = ae["start_epoch"]
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

            comment_str = ""
            if show_comments:
                comment = data.get("comment")
                if comment:
                    comment_str = f" — \"{comment}\""

            if data.get("is_paused"):
                # Task is paused — show duration up to the pause start
                if pauses and pauses[-1].get("pause_stop") is None:
                    paused_since = pauses[-1]["pause_start"]
                    duration_ms = self._compute_duration(start_epoch, paused_since, pauses)
                    pause_time = time.strftime("%H:%M:%S", time.localtime(paused_since/1000))
                    print(f"#{task_id} [{started}] {data['title']} (\u23f8 paused at {pause_time}, active: {duration_ms // 60000}m){tag_str}{comment_str}")
                else:
                    print(f"#{task_id} [{started}] {data['title']} (\u23f8 paused){tag_str}{comment_str}")
            else:
                # Task is actively running — show live duration (excluding past pauses)
                now = int(time.time() * 1000)
                duration_ms = self._compute_duration(start_epoch, now, pauses)
                print(f"#{task_id} [{started}] {data['title']} (active: {duration_ms // 60000}m){tag_str}{comment_str}")



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

    @trace
    def list_habits(self, source: str, days_limit=None, from_date=None, to_date=None, show_comments=False, show_tags=False):
        self._sync_before_command(require_auth=False)
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
            start_val = entry["data"]["startTime_enc"]
            if start_val.startswith("plain:"):
                start_epoch = int(start_val[6:])
            else:
                try:
                    start_epoch = int(self._crypto.decrypt(start_val))
                except Exception:
                    continue  # Skip entries with undecryptable timestamps
            date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
            if date_str not in staged_by_date:
                staged_by_date[date_str] = []
            staged_by_date[date_str].append({"source": "staged", "data": entry["data"], "date": date_str})

        # --- P11 Fix B: Collect spanning entries from previous day ---
        # For each date in range, peek at the previous day's synced block and
        # surface entries that span into the target date. Only include if the
        # entry's original date is OUTSIDE the filter range (dedup guard).
        peek_entries = {}  # {target_date_str: [entry_dict, ...]}
        all_dates = set(list(synced_by_date.keys()) + list(staged_by_date.keys()))

        def _date_in_range(d):
            if from_date and d < from_date:
                return False
            if to_date and d > to_date:
                return False
            return True

        if source in ['synced', 'all'] and (from_date is not None or to_date is not None):
            # Build a reverse lookup: for each date in range, find its previous day
            for date_str in sorted(all_dates):
                if not _date_in_range(date_str):
                    continue
                # Compute previous day
                dt = datetime.strptime(date_str, "%Y-%m-%d")
                prev_date = (dt - timedelta(days=1)).strftime("%Y-%m-%d")
                if prev_date not in synced_by_date:
                    continue
                # Check each entry in the previous day's block
                for entry_data in synced_by_date[prev_date]:
                    entry = entry_data["data"]
                    start_val = entry.get("startTime_enc")
                    end_val = entry.get("endTime_enc")
                    if not end_val:
                        continue
                    # Decrypt or plain: prefix
                    try:
                        if start_val and start_val.startswith("plain:"):
                            start_epoch = int(start_val[6:])
                        else:
                            start_epoch = int(self._crypto.decrypt(start_val))
                        if end_val.startswith("plain:"):
                            stop_epoch = int(end_val[6:])
                        else:
                            stop_epoch = int(self._crypto.decrypt(end_val))
                    except Exception:
                        continue
                    # Guard: must have valid end > start
                    if stop_epoch <= start_epoch:
                        continue
                    # Check if it spans into the target date
                    start_date = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
                    end_date = time.strftime("%Y-%m-%d", time.gmtime(stop_epoch // 1000))
                    if end_date != start_date and end_date == date_str:
                        # Dedup: only include if original date is OUTSIDE the filter range
                        if not _date_in_range(start_date):
                            if date_str not in peek_entries:
                                peek_entries[date_str] = []
                            peek_entries[date_str].append(entry_data)

        # Combine dates from both sources, including any dates that only have peeked entries
        all_dates = set(list(synced_by_date.keys()) + list(staged_by_date.keys()) + list(peek_entries.keys()))

        for date_str in sorted(all_dates):
            if not _date_in_range(date_str):
                continue

            # Skip if source filtering doesn't include this date's data
            if source == 'synced' and date_str not in synced_by_date and date_str not in peek_entries:
                continue
            if source == 'staged' and date_str not in staged_by_date:
                continue

            # Print date header
            print(f"\nDate: {date_str}")

            # Process synced entries for this date (including peeked entries)
            if source in ['synced', 'all']:
                # Own entries first
                if date_str in synced_by_date:
                    for entry_data in synced_by_date[date_str]:
                        self._print_entry(entry_data, show_comments=show_comments, show_tags=show_tags)
                # Then peeked spanning entries from previous day
                if date_str in peek_entries:
                    for entry_data in peek_entries[date_str]:
                        self._print_entry(entry_data, show_comments=show_comments, show_tags=show_tags)

            # Process staged entries for this date
            if source in ['staged', 'all'] and date_str in staged_by_date:
                for entry_data in staged_by_date[date_str]:
                    self._print_entry(entry_data, show_comments=show_comments, show_tags=show_tags)

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

    def _print_entry(self, entry_data, show_comments=False, show_tags=False):
        """Helper method to print an entry (synced or staged)."""
        data = entry_data["data"]

        start_val = data.get("startTime_enc")
        if not start_val:
            return
        if start_val.startswith("plain:"):
            start_epoch = int(start_val[6:])
        else:
            try:
                start_epoch = int(self._crypto.decrypt(start_val))
            except Exception:
                return  # Skip entries with undecryptable timestamps

        if data["endTime_enc"]:
            end_val = data["endTime_enc"]
            if end_val.startswith("plain:"):
                stop_epoch = int(end_val[6:])
            else:
                try:
                    stop_epoch = int(self._crypto.decrypt(end_val))
                except Exception:
                    stop_epoch = None
        else:
            stop_epoch = None

        meta_enc = data.get("metadata_enc")
        if meta_enc:
            if meta_enc.startswith("plain:"):
                meta = json.loads(meta_enc[6:])
            else:
                try:
                    meta = json.loads(self._crypto.decrypt(meta_enc))
                except Exception:
                    meta = {}
        else:
            meta = {}

        start_str = time.strftime("%H:%M", time.localtime(start_epoch/1000))
        stop_str = time.strftime("%H:%M", time.localtime(stop_epoch/1000)) if stop_epoch else "??"

        # --- P11 Fix A: Spanning marker ---
        # Detect entries that cross midnight: if the UTC end date differs from
        # the UTC start date (and the entry has a valid end time after start),
        # append a visual indicator.
        marker = ""
        if stop_epoch is not None and stop_epoch > start_epoch:
            start_date = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
            end_date = time.strftime("%Y-%m-%d", time.gmtime(stop_epoch // 1000))
            if end_date != start_date:
                marker = " \u23ed"  # ⏭ skip-to-next-track symbol

        # Add source indicator
        source_indicator = " (Staged)" if entry_data["source"] == "staged" else ""
        comment_str = ""
        if show_comments:
            comment = data.get("comment")
            if comment:
                comment_str = f" — \"{comment}\""

        tag_str = ""
        if show_tags:
            tags = data.get("tags", [])
            if tags:
                tag_str = f" [@{', @'.join(tags)}]"

        print(f"  [{start_str} - {stop_str}] {data['title']}{marker}{source_indicator} ({data['duration'] // 60000}m){comment_str}{tag_str}")
        if meta: print(f"    Metadata: {meta}")
