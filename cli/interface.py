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
            started = time.strftime("%H:%M:%S", time.localtime(data["startTime"]/1000))
            print(f"[{started}] {data['title']}")

    def show_rep(self, days_limit=None, from_date=None, to_date=None):
        ledger_data = self.ledger.get_ledger_data()
        rep = {}
        
        from_epoch = 0
        to_epoch = float('inf')
        if days_limit: from_epoch = time.time()*1000 - (days_limit * 86400000)
        if from_date: from_epoch = time.mktime(time.strptime(from_date, "%Y-%m-%d")) * 1000
        if to_date: to_epoch = (time.mktime(time.strptime(to_date, "%Y-%m-%d")) + 86399) * 1000

        for day in ledger_data:
            day_time = time.strptime(day["date"], "%Y-%m-%d")
            day_epoch = time.mktime(day_time) * 1000
            if day_epoch < from_epoch or day_epoch > to_epoch: continue

            for entry in day.get("entries", []):
                title = entry["data"]["title"]
                duration = entry["data"]["duration"]
                rep[title] = rep.get(title, 0) + duration
        
        print(f"\n--- Reputation Summary ---")
        for title, total_sec in sorted(rep.items(), key=lambda x: x[1], reverse=True):
            print(f"{title}: {total_sec // 60000}m")

    def list_habits(self, days_limit=None, from_date=None, to_date=None):
        ledger_data = self.ledger.get_ledger_data()
        print("\n--- Detailed Habit List ---")
        for day in ledger_data:
            if not day.get("entries"): continue
            print(f"\nDate: {day['date']}")
            for entry in day["entries"]:
                data = entry["data"]
                start = time.strftime("%H:%M", time.localtime(data["startTime"]/1000))
                stop = time.strftime("%H:%M", time.localtime(data["endTime"]/1000))
                meta = json.loads(self.ledger.crypto.decrypt(data.get("metadata_enc", self.ledger.crypto.encrypt("{}"))))
                print(f"  [{start} - {stop}] {data['title']} ({data['duration'] // 60000}m)")
                if meta: print(f"    Metadata: {meta}")
