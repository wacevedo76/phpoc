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
            print(f"[{started}] {data['title']}")

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

    def list_habits(self, days_limit=None, from_date=None, to_date=None):
        ledger_data = self.ledger.get_ledger_data()
        print("\n--- Detailed Habit List ---")
        
        from_str = from_date
        to_str = to_date
        if days_limit:
            limit_epoch = time.time() - (days_limit * 86400)
            from_str = time.strftime("%Y-%m-%d", time.localtime(limit_epoch))

        for day in ledger_data:
            if day.get("type", "day") != "day": continue
            date_str = day["date"]
            if from_str and date_str < from_str: continue
            if to_str and date_str > to_str: continue

            print(f"\nDate: {date_str}")
            for entry in day["entries"]:
                data = entry["data"]
                # Decrypt timestamps
                start_epoch = int(self.ledger.crypto.decrypt(data["startTime_enc"]))
                stop_epoch = int(self.ledger.crypto.decrypt(data["endTime_enc"])) if data["endTime_enc"] else None
                
                start_str = time.strftime("%H:%M", time.localtime(start_epoch/1000))
                stop_str = time.strftime("%H:%M", time.localtime(stop_epoch/1000)) if stop_epoch else "??"
                
                meta_enc = data.get("metadata_enc")
                meta = json.loads(self.ledger.crypto.decrypt(meta_enc)) if meta_enc else {}
                
                print(f"  [{start_str} - {stop_str}] {data['title']} ({data['duration'] // 60000}m)")
                if meta: print(f"    Metadata: {meta}")
