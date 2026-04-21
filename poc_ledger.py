import json
import hashlib
import os
import time
import argparse
import getpass
from pathlib import Path
from crypto_utils import CryptoManager

# Configuration
CONFIG_DIR = Path.home() / ".config" / "personal_history_poc"
STAGING_FILE = CONFIG_DIR / "staging.json"
LEDGER_FILE = CONFIG_DIR / "ledger.json"

CONFIG_DIR.mkdir(parents=True, exist_ok=True)

class POCLedger:
    def __init__(self, crypto, staging_file=STAGING_FILE, ledger_file=LEDGER_FILE):
        self.crypto = crypto
        self.staging_file = staging_file
        self.ledger_file = ledger_file
        self._init_files()

    def _init_files(self):
        # Ensure parent directory exists
        self.staging_file.parent.mkdir(parents=True, exist_ok=True)
        
        if not self.staging_file.exists():
            self.staging_file.write_text(json.dumps([]))
        if not self.ledger_file.exists():
            # Initial genesis block
            date_str = time.strftime("%Y-%m-%d")
            genesis_content = {
                "day_index": 0,
                "date": date_str,
                "prev_hash": "0" * 64,
                "entries": []
            }
            genesis_json = json.dumps(genesis_content, sort_keys=True)
            genesis_hash = self.crypto.seal(genesis_json)
            genesis_content["day_hash"] = genesis_hash
            self.ledger_file.write_text(json.dumps([genesis_content]))

    def _check_overlap(self, start_epoch, stop_epoch):
        staging = json.loads(self.staging_file.read_text())
        for entry in staging:
            data = entry["data"]
            try:
                s = int(self.crypto.decrypt(data["start_time_enc"]))
                e = int(self.crypto.decrypt(data["stop_time_enc"]))
                
                if start_epoch < e and stop_epoch > s:
                    return data["title"]
            except Exception as ex:
                print(f"Warning: Could not decrypt staged entry: {ex}")
        return None

    def capture_habit(self, title, start_epoch, stop_epoch, metadata=None):
        overlap_title = self._check_overlap(start_epoch, stop_epoch)
        if overlap_title:
            print(f"Error: Time overlap detected with staged habit: '{overlap_title}'")
            return

        print(f"Capturing: {title}...")
        enc_start = self.crypto.encrypt(str(start_epoch))
        enc_stop = self.crypto.encrypt(str(stop_epoch))
        enc_meta = self.crypto.encrypt(json.dumps(metadata or {}))
        
        entry = {
            "title": title,
            "start_time_enc": enc_start,
            "stop_time_enc": enc_stop,
            "metadata_enc": enc_meta,
            "duration": stop_epoch - start_epoch
        }
        
        entry_json = json.dumps(entry, sort_keys=True)
        entry_hash = hashlib.sha256(entry_json.encode()).hexdigest()
        
        packaged_entry = {
            "hash": entry_hash,
            "data": entry
        }
        
        staging = json.loads(self.staging_file.read_text())
        staging.append(packaged_entry)
        self.staging_file.write_text(json.dumps(staging, indent=2))
        print(f"✓ Staged with hash: {entry_hash[:10]}...")

    def sync_day(self):
        staging = json.loads(self.staging_file.read_text())
        if not staging:
            print("Nothing to sync.")
            return

        ledger = json.loads(self.ledger_file.read_text())
        prev_day = ledger[-1]
        
        new_day_index = prev_day["day_index"] + 1
        date_str = time.strftime("%Y-%m-%d")
        
        day_content = {
            "day_index": new_day_index,
            "date": date_str,
            "prev_hash": prev_day["day_hash"],
            "entries": staging
        }
        
        day_json = json.dumps(day_content, sort_keys=True)
        # Use keyed HMAC for the day hash
        day_hash = self.crypto.seal(day_json)
        day_content["day_hash"] = day_hash
        
        ledger.append(day_content)
        self.ledger_file.write_text(json.dumps(ledger, indent=2))
        self.staging_file.write_text(json.dumps([]))
        print(f"✓ Day {new_day_index} committed. HMAC Seal: {day_hash[:10]}...")

    def verify_ledger(self):
        ledger = json.loads(self.ledger_file.read_text())
        print("Verifying Ledger Integrity (Keyed HMAC)...")
        
        for i in range(1, len(ledger)):
            current = ledger[i]
            prev = ledger[i-1]
            
            # Check Chain of Trust
            if current["prev_hash"] != prev["day_hash"]:
                print(f"✗ GAP DETECTED at Day {current['day_index']}!")
                return False
            
            # Verify HMAC Seal
            check_data = {k: v for k, v in current.items() if k != "day_hash"}
            check_json = json.dumps(check_data, sort_keys=True)
            if not self.crypto.verify_seal(check_json, current["day_hash"]):
                print(f"✗ SEAL BREACH DETECTED at Day {current['day_index']}!")
                return False
                
            # Verify individual entries
            for entry in current["entries"]:
                entry_data_json = json.dumps(entry["data"], sort_keys=True)
                if hashlib.sha256(entry_data_json.encode()).hexdigest() != entry["hash"]:
                    print(f"✗ ENTRY TAMPERING in Day {current['day_index']}!")
                    return False

        print("✅ Ledger is 100% Authentic and Sealed.")
        return True

    def show_reputation(self, days_limit=None, from_date=None, to_date=None):
        ledger = json.loads(self.ledger_file.read_text())
        rep = {}
        
        from_epoch = 0
        to_epoch = float('inf')

        if days_limit:
            from_epoch = time.time() - (days_limit * 86400)
            print(f"Filtering for the last {days_limit} days...")
        
        if from_date:
            from_epoch = time.mktime(time.strptime(from_date, "%Y-%m-%d"))
        if to_date:
            # End of the to_date (23:59:59)
            to_epoch = time.mktime(time.strptime(to_date, "%Y-%m-%d")) + 86399

        for day in ledger:
            day_date_str = day.get("date")
            if day_date_str:
                day_time = time.strptime(day_date_str, "%Y-%m-%d")
                day_epoch = time.mktime(day_time)
                if day_epoch < from_epoch or day_epoch > to_epoch:
                    continue

            for entry in day.get("entries", []):
                title = entry["data"]["title"]
                duration = entry["data"]["duration"]
                rep[title] = rep.get(title, 0) + duration
        
        label = "Custom Range" if (from_date or to_date) else (f"Last {days_limit} Days" if days_limit else "All Time")
        print(f"\n--- Reputation Summary ({label}) ---")
        if not rep:
            print("No habits found in the requested range.")
            return
            
        for title, total_sec in sorted(rep.items(), key=lambda x: x[1], reverse=True):
            print(f"{title}: {total_sec // 60}m {total_sec % 60}s")

    def list_habits(self, days_limit=None, from_date=None, to_date=None):
        ledger = json.loads(self.ledger_file.read_text())
        print("\n--- Detailed Habit List ---")
        
        from_epoch = 0
        to_epoch = float('inf')

        if days_limit:
            from_epoch = time.time() - (days_limit * 86400)
        
        if from_date:
            from_epoch = time.mktime(time.strptime(from_date, "%Y-%m-%d"))
        if to_date:
            to_epoch = time.mktime(time.strptime(to_date, "%Y-%m-%d")) + 86399

        for day in ledger:
            day_date_str = day.get("date")
            if day_date_str:
                day_time = time.strptime(day_date_str, "%Y-%m-%d")
                day_epoch = time.mktime(day_time)
                if day_epoch < from_epoch or day_epoch > to_epoch:
                    continue
            
            if not day.get("entries"): continue
            
            print(f"\nDate: {day_date_str}")
            for entry in day["entries"]:
                data = entry["data"]
                try:
                    start = time.strftime("%H:%M", time.localtime(int(self.crypto.decrypt(data["start_time_enc"]))))
                    stop = time.strftime("%H:%M", time.localtime(int(self.crypto.decrypt(data["stop_time_enc"]))))
                    meta = json.loads(self.crypto.decrypt(data.get("metadata_enc", self.crypto.encrypt("{}"))))
                    
                    print(f"  [{start} - {stop}] {data['title']} ({data['duration'] // 60}m)")
                    if meta:
                        print(f"    Metadata: {meta}")
                except Exception as e:
                    print(f"  [Error Decrypting Entry {entry['hash'][:8]}]: {e}")

def parse_time(time_str):
    """Helper to parse HH:MM into today's epoch."""
    now = time.localtime()
    t = time.strptime(f"{now.tm_year}-{now.tm_mon}-{now.tm_mday} {time_str}", "%Y-%m-%d %H:%M")
    return int(time.mktime(t))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Personal History POC Ledger")
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Add command
    add_parser = subparsers.add_parser("add", help="Add a new habit")
    add_parser.add_argument("title", nargs="?", help="Title of the habit")

    # Sync command
    subparsers.add_parser("sync", help="Sync staged habits to the ledger")

    # Verify command
    subparsers.add_parser("verify", help="Verify ledger integrity")

    # Rep command
    rep_parser = subparsers.add_parser("rep", help="Show reputation summary")
    rep_parser.add_argument("days", type=int, nargs="?", help="Limit to last N days")
    rep_parser.add_argument("--from", dest="from_date", help="Start date (YYYY-MM-DD)")
    rep_parser.add_argument("--to", dest="to_date", help="End date (YYYY-MM-DD)")

    # List command
    list_parser = subparsers.add_parser("list", help="List detailed habits (requires decryption)")
    list_parser.add_argument("days", type=int, nargs="?", help="Limit to last N days")
    list_parser.add_argument("--from", dest="from_date", help="Start date (YYYY-MM-DD)")
    list_parser.add_argument("--to", dest="to_date", help="End date (YYYY-MM-DD)")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        exit(1)

    # Security: Use a real prompt for the passphrase
    # Default to POC key if empty for convenience, but encourage better
    passphrase = getpass.getpass("Enter PH Passphrase (default: poc-secret-key): ")
    if not passphrase:
        passphrase = "poc-secret-key"

    crypto = CryptoManager(passphrase)
    poc = POCLedger(crypto)
    
    if args.command == "add":
        title = args.title or input("Habit Title: ")
        use_custom = input("Enter custom times? (y/N): ").lower() == 'y'
        
        if use_custom:
            start_str = input("Start Time (HH:MM): ")
            stop_str = input("Stop Time (HH:MM): ")
            try:
                start = parse_time(start_str)
                stop = parse_time(stop_str)
                if stop <= start:
                    print("Error: Stop time must be after start time.")
                    exit(1)
            except ValueError:
                print("Error: Invalid time format. Use HH:MM.")
                exit(1)
        else:
            stop = int(time.time())
            start = stop - 120 # Default 2m
            
        poc.capture_habit(title, start, stop)
    elif args.command == "sync":
        poc.sync_day()
    elif args.command == "verify":
        poc.verify_ledger()
    elif args.command == "rep":
        poc.show_reputation(args.days, from_date=args.from_date, to_date=args.to_date)
    elif args.command == "list":
        poc.list_habits(args.days, from_date=args.from_date, to_date=args.to_date)
