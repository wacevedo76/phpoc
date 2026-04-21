import json
import hashlib
import time
from security.crypto import CryptoManager
from storage.file_store import LedgerStore

class LedgerDomain:
    def __init__(self, crypto: CryptoManager, store: LedgerStore):
        self.crypto = crypto
        self.store = store
        self._init_ledger()

    def _init_ledger(self):
        ledger = self.store.read_ledger()
        if ledger is None:
            date_str = time.strftime("%Y-%m-%d")
            genesis = {
                "day_index": 0,
                "date": date_str,
                "prev_hash": "0" * 64,
                "entries": []
            }
            genesis_json = json.dumps(genesis, sort_keys=True)
            genesis["day_hash"] = self.crypto.seal(genesis_json)
            self.store.write_ledger([genesis])

    def capture_habit(self, title, start_epoch, stop_epoch=None, metadata=None, is_active=False):
        staging = self.store.read_staging()
        
        # Collision Check: Ensure no two tasks start at the same millisecond
        for entry in staging:
            if entry["data"].get("startTime") == start_epoch:
                raise ValueError("Collision detected: A task has already started at this millisecond.")

        entry = {
            "title": title,
            "startTime": start_epoch,
            "endTime": stop_epoch,
            "is_active": is_active,
            "duration": (stop_epoch - start_epoch) if stop_epoch else 0,
            "metadata_enc": self.crypto.encrypt(json.dumps(metadata or {}))
        }
        
        entry_hash = hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()
        staging.append({"hash": entry_hash, "data": entry})
        self.store.write_staging(staging)
        return entry_hash[:10]

    def end_habit(self, title, end_epoch):
        staging = self.store.read_staging()
        found = False
        for entry in staging:
            if entry["data"]["title"] == title and entry["data"].get("is_active"):
                entry["data"]["endTime"] = end_epoch
                entry["data"]["duration"] = end_epoch - entry["data"]["startTime"]
                entry["data"]["is_active"] = False
                found = True
                break
        
        if not found:
            raise ValueError(f"No active task found for: {title}")
            
        self.store.write_staging(staging)

    def sync_day(self):
        staging = self.store.read_staging()
        # Only sync completed tasks (is_active == False)
        to_sync = [e for e in staging if not e["data"].get("is_active", False)]
        if not to_sync: return None

        ledger = self.store.read_ledger()
        prev_day = ledger[-1]
        
        day_content = {
            "day_index": prev_day["day_index"] + 1,
            "date": time.strftime("%Y-%m-%d"),
            "prev_hash": prev_day["day_hash"],
            "entries": to_sync
        }
        
        day_json = json.dumps(day_content, sort_keys=True)
        day_content["day_hash"] = self.crypto.seal(day_json)
        
        ledger.append(day_content)
        self.store.write_ledger(ledger)
        
        # Keep only active tasks in staging
        self.store.write_staging([e for e in staging if e["data"].get("is_active", False)])
        return day_content["day_hash"][:10]

    def verify(self):
        ledger = self.store.read_ledger()
        for i in range(1, len(ledger)):
            current = ledger[i]
            prev = ledger[i-1]
            if current["prev_hash"] != prev["day_hash"]: return False
            
            check_data = {k: v for k, v in current.items() if k != "day_hash"}
            if not self.crypto.verify_seal(json.dumps(check_data, sort_keys=True), current["day_hash"]):
                return False
                
            for entry in current["entries"]:
                if hashlib.sha256(json.dumps(entry["data"], sort_keys=True).encode()).hexdigest() != entry["hash"]:
                    return False
        return True

    def get_ledger_data(self):
        return self.store.read_ledger()
