import json
import time
from core.ledger import LedgerDomain

class CLIInterface:
    def __init__(self, ledger: LedgerDomain):
        self.ledger = ledger

    def add_oneoff(self, title, start, stop, metadata=None):
        self.ledger.capture_habit(title, start, stop, metadata=metadata, is_active=False)
        print(f"✓ One-off habit captured: {title}")

    def add_start(self, title):
        self.ledger.capture_habit(title, int(time.time()*1000), is_active=True)
        print(f"✓ Started tracking: {title}")

    def add_end(self, title):
        self.ledger.end_habit(title, int(time.time()*1000))
        print(f"✓ Stopped tracking: {title}")

    def add_pause(self, title):
        self.ledger.pause_habit(title, int(time.time()*1000))
        print(f"✓ Paused: {title}")

    def add_unpause(self, title):
        self.ledger.unpause_habit(title, int(time.time()*1000))
        print(f"✓ Resumed: {title}")

    def view_active(self):
        staging = self.ledger.store.read_staging()
        active = [e for e in staging if e["data"].get("is_active")]
        
        print("\n--- Running Tasks ---")
        if not active:
            print("No active tasks.")
            return
            
        for entry in active:
            data = entry["data"]
            # Decrypt startTime for viewing
            start_epoch = int(self.ledger.crypto.decrypt(data["startTime_enc"]))
            started = time.strftime("%H:%M:%S", time.localtime(start_epoch/1000))
            
            # Show pause indicator and active duration so far
            # Compute active duration up to now, excluding pauses
            pauses_enc = data.get("pauses_enc")
            pauses = []
            if pauses_enc:
                if pauses_enc.startswith("plain:"):
                    pauses = json.loads(pauses_enc[6:])
                else:
                    pauses = json.loads(self.ledger.crypto.decrypt(pauses_enc))

            if data.get("is_paused"):
                # Task is paused — show duration up to the pause start
                if pauses and pauses[-1].get("pause_stop") is None:
                    paused_since = pauses[-1]["pause_start"]
                    duration_ms = self.ledger._compute_duration(start_epoch, paused_since, pauses)
                    pause_time = time.strftime("%H:%M:%S", time.localtime(paused_since/1000))
                    print(f"[{started}] {data['title']} (⏸ paused at {pause_time}, active: {duration_ms // 60000}m)")
                else:
                    print(f"[{started}] {data['title']} (⏸ paused)")
            else:
                # Task is actively running — show live duration (excluding past pauses)
                now = int(time.time() * 1000)
                duration_ms = self.ledger._compute_duration(start_epoch, now, pauses)
                print(f"[{started}] {data['title']} (active: {duration_ms // 60000}m)")

    def show_rep(self, days_limit=None, from_date=None, to_date=None):
        # Use Blind Index for speed and privacy
        index = self.ledger.store.read_index()
        rep = {}
        
        from_str = from_date
        to_str = to_date
        if days_limit:
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

        synced_data = []
        if source in ['synced', 'all']:
            synced_data = self.ledger.get_ledger_data() or [] # Ensure it's a list if None

        staged_data = []
        if source in ['staged', 'all']:
            staged_data = self.ledger.store.read_staging()
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
                start_epoch = int(self.ledger.crypto.decrypt(entry["data"]["startTime_enc"]))
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
    
    def _print_entry(self, entry_data):
        """Helper method to print an entry (synced or staged)."""
        data = entry_data["data"]
        start_epoch = int(self.ledger.crypto.decrypt(data["startTime_enc"]))
        stop_epoch = int(self.ledger.crypto.decrypt(data["endTime_enc"])) if data["endTime_enc"] else None

        start_str = time.strftime("%H:%M", time.localtime(start_epoch/1000))
        stop_str = time.strftime("%H:%M", time.localtime(stop_epoch/1000)) if stop_epoch else "??"

        meta_enc = data.get("metadata_enc")
        meta = json.loads(self.ledger.crypto.decrypt(meta_enc)) if meta_enc else {}

        # Add source indicator
        source_indicator = " (Staged)" if entry_data["source"] == "staged" else ""
        print(f"  [{start_str} - {stop_str}] {data['title']}{source_indicator} ({data['duration'] // 60000}m)")
        if meta: print(f"    Metadata: {meta}")