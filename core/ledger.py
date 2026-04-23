import json
import hashlib
import time
from typing import Optional, List, Dict, Any
from security.crypto import AbstractCryptoManager
from storage.interface import AbstractLedgerStore

class LedgerDomain:
    def __init__(self, crypto: AbstractCryptoManager, store: AbstractLedgerStore):
        self.crypto = crypto
        self.store = store

    def capture_habit(self, title, start_epoch, stop_epoch=None, metadata=None, is_active=False):
        staging = self.store.read_staging()
        
        # Collision Check
        for entry in staging:
            if entry.get("start_epoch") == start_epoch:
                raise ValueError("Collision detected: A task has already started at this millisecond.")

        entry = {
            "title": title,
            "duration": (stop_epoch - start_epoch) if stop_epoch else 0,
            "is_active": is_active,
            "startTime_enc": self.crypto.encrypt(str(start_epoch)),
            "endTime_enc": self.crypto.encrypt(str(stop_epoch)) if stop_epoch else None,
            "metadata_enc": self.crypto.encrypt(json.dumps(metadata or {}))
        }
        
        entry_hash = hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()
        staging.append({"hash": entry_hash, "data": entry, "start_epoch": start_epoch})
        self.store.write_staging(staging)
        return entry_hash[:10]

    def end_habit(self, title, end_epoch):
        staging = self.store.read_staging()
        found = False
        for entry in staging:
            if entry["data"]["title"] == title and entry["data"].get("is_active"):
                # Decrypt current start time (might be plain: if lazy-added)
                start_val = entry["data"]["startTime_enc"]
                if start_val.startswith("plain:"):
                    start_epoch = int(start_val[6:])
                else:
                    start_epoch = int(self.crypto.decrypt(start_val))
                
                entry["data"]["endTime_enc"] = self.crypto.encrypt(str(end_epoch))
                entry["data"]["duration"] = end_epoch - start_epoch
                entry["data"]["is_active"] = False
                # Re-calculate hash since data changed
                entry["hash"] = hashlib.sha256(json.dumps(entry["data"], sort_keys=True).encode()).hexdigest()
                found = True
                break
        
        if not found:
            raise ValueError(f"No active task found for: {title}")
            
        self.store.write_staging(staging)

    def _get_identity_secret(self) -> Optional[bytes]:
        id_data = self.store.read_identity()
        if not id_data: return None
        enc_secret = id_data.get("identity_secret_enc")
        if not enc_secret: return None
        try:
            return bytes.fromhex(self.crypto.decrypt(enc_secret))
        except Exception:
            return None

    def sync_day(self):
        staging = self.store.read_staging()
        # Only sync completed tasks (is_active == False)
        to_sync = [e for e in staging if not e["data"].get("is_active", False)]
        if not to_sync: return None

        # Group by date and ENSURE ENCRYPTION
        days_to_sync = {}
        for entry in to_sync:
            data = entry["data"]
            # 1. Resolve startTime
            if data["startTime_enc"].startswith("plain:"):
                start_epoch = int(data["startTime_enc"][6:])
                # Re-encrypt properly for ledger
                data["startTime_enc"] = self.crypto.encrypt(str(start_epoch))
            else:
                start_epoch = int(self.crypto.decrypt(data["startTime_enc"]))

            # 2. Resolve endTime
            if data["endTime_enc"] and data["endTime_enc"].startswith("plain:"):
                end_epoch = int(data["endTime_enc"][6:])
                data["endTime_enc"] = self.crypto.encrypt(str(end_epoch))
            
            # 3. Resolve Metadata
            if data["metadata_enc"].startswith("plain:"):
                meta_json = data["metadata_enc"][6:]
                data["metadata_enc"] = self.crypto.encrypt(meta_json)

            # Re-calculate entry hash after potential re-encryption
            entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

            date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
            if date_str not in days_to_sync:
                days_to_sync[date_str] = []
            days_to_sync[date_str].append(entry)

        ledger = self.store.read_ledger()
        index = self.store.read_index()
        identity_secret = self._get_identity_secret()
        
        for date_str in sorted(days_to_sync.keys()):
            prev_record = ledger[-1]
            
            # Check for month/year transitions
            prev_date = time.strptime(prev_record.get("date", "1970-01-01"), "%Y-%m-%d")
            curr_date = time.strptime(date_str, "%Y-%m-%d")
            
            # Year transition
            if curr_date.tm_year > prev_date.tm_year and prev_record.get("type") != "year_summary":
                year_summary = {
                    "type": "year_summary",
                    "year": prev_date.tm_year,
                    "prev_hash": prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                    "date": date_str
                }
                year_summary["year_hash"] = self.crypto.seal(json.dumps(year_summary, sort_keys=True))
                if identity_secret:
                    year_summary["signature"] = self.crypto.sign(year_summary["year_hash"], identity_secret)
                ledger.append(year_summary)
                prev_record = ledger[-1]

            # Month transition
            if curr_date.tm_mon > prev_date.tm_mon and prev_record.get("type") != "month_summary":
                month_summary = {
                    "type": "month_summary",
                    "month": f"{prev_date.tm_year}-{prev_date.tm_mon:02d}",
                    "prev_hash": prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                    "date": date_str
                }
                month_summary["month_hash"] = self.crypto.seal(json.dumps(month_summary, sort_keys=True))
                if identity_secret:
                    month_summary["signature"] = self.crypto.sign(month_summary["month_hash"], identity_secret)
                ledger.append(month_summary)
                prev_record = ledger[-1]

            # Update Index
            if date_str not in index: index[date_str] = {}
            for entry in days_to_sync[date_str]:
                title = entry["data"]["title"]
                duration = entry["data"]["duration"]
                index[date_str][title] = index[date_str].get(title, 0) + duration

            # Day Record
            day_content = {
                "type": "day",
                "day_index": prev_record.get("day_index", 0) + 1 if prev_record.get("type") == "day" else 1,
                "date": date_str,
                "prev_hash": prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                "entries": [{"hash": e["hash"], "data": e["data"]} for e in days_to_sync[date_str]]
            }
            
            day_json = json.dumps(day_content, sort_keys=True)
            day_content["day_hash"] = self.crypto.seal(day_json)
            if identity_secret:
                day_content["signature"] = self.crypto.sign(day_content["day_hash"], identity_secret)
            ledger.append(day_content)
        
        self.store.write_ledger(ledger)
        self.store.write_index(index)
        
        # Keep only active tasks in staging
        self.store.write_staging([e for e in staging if e["data"].get("is_active", False)])
        return ledger[-1].get("day_hash")[:10]

    def verify(self):
        ledger = self.store.read_ledger()
        identity_secret = self._get_identity_secret()

        for i in range(1, len(ledger)):
            current = ledger[i]
            prev = ledger[i-1]
            
            prev_hash = prev.get("day_hash") or prev.get("month_hash") or prev.get("year_hash")
            if current["prev_hash"] != prev_hash: return False
            
            hash_key = "day_hash" if current.get("type", "day") == "day" else \
                       "month_hash" if current.get("type") == "month_summary" else "year_hash"
            
            check_data = {k: v for k, v in current.items() if k not in [hash_key, "signature"]}
            # Verify Seal
            if not self.crypto.verify_seal(json.dumps(check_data, sort_keys=True), current[hash_key]):
                return False
            
            # Verify Signature (if present and identity is available)
            if identity_secret and current.get("signature"):
                if not self.crypto.verify_signature(current[hash_key], current["signature"], identity_secret):
                    return False
                
            if current.get("type", "day") == "day":
                for entry in current["entries"]:
                    if hashlib.sha256(json.dumps(entry["data"], sort_keys=True).encode()).hexdigest() != entry["hash"]:
                        return False
        return True

    def get_ledger_data(self):
        return self.store.read_ledger()
