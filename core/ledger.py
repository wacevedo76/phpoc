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

    def _compute_duration(self, start_epoch, end_epoch, pauses):
        """
        Compute active duration as wall time minus all completed pause intervals.
        `pauses` is a list of {"pause_start": ..., "pause_stop": ...} dicts.
        Intervals with pause_stop=None (ongoing pause) are skipped.
        """
        total_pause_ms = 0
        for p in pauses:
            if p.get("pause_stop") is not None:
                total_pause_ms += p["pause_stop"] - p["pause_start"]
        return (end_epoch - start_epoch) - total_pause_ms

    def _decrypt_pauses(self, data):
        """Decrypt pauses_enc from entry data. Returns list of pause dicts.
        Handles plain: prefix (lazy auth) and missing field (old entries)."""
        pauses_enc = data.get("pauses_enc")
        if pauses_enc is None:
            return []
        if pauses_enc.startswith("plain:"):
            return json.loads(pauses_enc[6:])
        return json.loads(self.crypto.decrypt(pauses_enc))

    def _encrypt_pauses(self, pauses):
        """Encrypt a pauses list and return the hex string."""
        return self.crypto.encrypt(json.dumps(pauses))

    def _reconcile_plain_pauses(self, data):
        """If pauses_enc is plain:, decrypt in place and re-encrypt with real crypto.
        Returns the (possibly updated) pauses list."""
        pauses_enc = data.get("pauses_enc")
        if pauses_enc is not None and pauses_enc.startswith("plain:"):
            pauses = json.loads(pauses_enc[6:])
            data["pauses_enc"] = self._encrypt_pauses(pauses)
            return pauses
        if pauses_enc is not None:
            return json.loads(self.crypto.decrypt(pauses_enc))
        return []

    def capture_habit(self, title, start_epoch, stop_epoch=None, metadata=None, is_active=False, tags=None, comment=None, media=None):
        staging = self.store.read_staging()

        # Normalize tags: lowercase, strip, dedup, remove empties
        normalized_tags = []
        if tags is not None:
            seen = set()
            for t in tags:
                clean = t.strip().lower()
                if clean and clean not in seen:
                    seen.add(clean)
                    normalized_tags.append(clean)
            normalized_tags.sort()
        
        # Collision Check
        for entry in staging:
            if entry.get("start_epoch") == start_epoch:
                raise ValueError("Collision detected: A task has already started at this millisecond.")

        entry = {
            "title": title,
            "duration": (stop_epoch - start_epoch) if stop_epoch else 0,
            "is_active": is_active,
            "is_paused": False,
            "startTime_enc": self.crypto.encrypt(str(start_epoch)),
            "endTime_enc": self.crypto.encrypt(str(stop_epoch)) if stop_epoch else None,
            "pauses_enc": self.crypto.encrypt("[]"),
            "metadata_enc": self.crypto.encrypt(json.dumps(metadata or {})),
            "tags": normalized_tags,
            "media": media if media is not None else []
        }
        if comment is not None:
            entry["comment"] = comment
        
        entry_hash = hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()
        staging.append({"hash": entry_hash, "data": entry, "start_epoch": start_epoch})
        self.store.write_staging(staging)
        return entry_hash[:10]

    def end_habit(self, title, end_epoch, comment=None):
        staging = self.store.read_staging()
        found = False
        for entry in staging:
            if entry["data"]["title"] == title and entry["data"].get("is_active"):
                data = entry["data"]

                # Resolve start epoch (handle plain: prefix)
                start_val = data["startTime_enc"]
                if start_val.startswith("plain:"):
                    start_epoch = int(start_val[6:])
                else:
                    start_epoch = int(self.crypto.decrypt(start_val))

                # Auto-unpause if currently paused
                pauses = self._reconcile_plain_pauses(data)
                if data.get("is_paused"):
                    # Close the last interval's pause_stop
                    if pauses and pauses[-1].get("pause_stop") is None:
                        pauses[-1]["pause_stop"] = end_epoch
                        data["pauses_enc"] = self._encrypt_pauses(pauses)
                    data["is_paused"] = False

                data["endTime_enc"] = self.crypto.encrypt(str(end_epoch))
                data["duration"] = self._compute_duration(start_epoch, end_epoch, pauses)
                data["is_active"] = False

                if comment is not None:
                    data["comment"] = comment

                # Re-calculate hash since data changed
                entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                found = True
                break
        
        if not found:
            raise ValueError(f"No active task found for: {title}")
            
        self.store.write_staging(staging)

    def end_habit_at(self, title, end_epoch, comment=None):
        """End a habit at a specific past timestamp. Computes correct duration.
        Raises ValueError if task not found, not active, or already ended."""
        staging = self.store.read_staging()
        found = False
        for entry in staging:
            if entry["data"]["title"] == title and entry["data"].get("is_active"):
                data = entry["data"]

                # Resolve start epoch
                start_val = data["startTime_enc"]
                if start_val.startswith("plain:"):
                    start_epoch = int(start_val[6:])
                else:
                    start_epoch = int(self.crypto.decrypt(start_val))

                # Auto-unpause if currently paused
                pauses = self._reconcile_plain_pauses(data)
                if data.get("is_paused"):
                    if pauses and pauses[-1].get("pause_stop") is None:
                        pauses[-1]["pause_stop"] = end_epoch
                        data["pauses_enc"] = self._encrypt_pauses(pauses)
                    data["is_paused"] = False

                data["endTime_enc"] = self.crypto.encrypt(str(end_epoch))
                data["duration"] = self._compute_duration(start_epoch, end_epoch, pauses)
                data["is_active"] = False

                if comment is not None:
                    data["comment"] = comment

                # Re-calculate hash
                entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                found = True
                break

        if not found:
            raise ValueError(f"No active task found for: {title}")

        self.store.write_staging(staging)

    def pause_habit(self, title, pause_epoch, comment=None):
        """Pause a running task. Raises ValueError if not found, not active, or already paused."""
        staging = self.store.read_staging()
        found = False
        for entry in staging:
            if entry["data"]["title"] == title and entry["data"].get("is_active"):
                data = entry["data"]
                if data.get("is_paused"):
                    raise ValueError(f"Task '{title}' is already paused.")

                pauses = self._reconcile_plain_pauses(data)
                next_index = len(pauses) + 1
                pause_record = {
                    "pause_index": next_index,
                    "pause_start": pause_epoch,
                    "pause_stop": None
                }
                if comment is not None:
                    pause_record["comment"] = comment
                pauses.append(pause_record)
                data["pauses_enc"] = self._encrypt_pauses(pauses)
                data["is_paused"] = True
                # Re-calculate hash since data changed
                entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                found = True
                break

        if not found:
            raise ValueError(f"No active task found for: {title}")

        self.store.write_staging(staging)

    def unpause_habit(self, title, unpause_epoch, comment=None):
        """Unpause a paused task. Raises ValueError if not found, not active, or not paused."""
        staging = self.store.read_staging()
        found = False
        for entry in staging:
            if entry["data"]["title"] == title and entry["data"].get("is_active"):
                data = entry["data"]
                if not data.get("is_paused"):
                    raise ValueError(f"Task '{title}' is not paused.")

                pauses = self._reconcile_plain_pauses(data)
                if pauses and pauses[-1].get("pause_stop") is None:
                    pauses[-1]["pause_stop"] = unpause_epoch
                    if comment is not None:
                        pauses[-1]["comment"] = comment

                data["pauses_enc"] = self._encrypt_pauses(pauses)
                data["is_paused"] = False

                # Recompute active duration so far
                start_val = data["startTime_enc"]
                if start_val.startswith("plain:"):
                    start_epoch = int(start_val[6:])
                else:
                    start_epoch = int(self.crypto.decrypt(start_val))
                data["duration"] = self._compute_duration(start_epoch, unpause_epoch, pauses)

                # Re-calculate hash since data changed
                entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                found = True
                break

        if not found:
            raise ValueError(f"No active task found for: {title}")

        self.store.write_staging(staging)

    def get_pending_sync(self):
        """Return a human-readable preview of entries ready to sync.
        Only includes completed (non-active, non-paused) entries.
        Returns list of dicts with title, start_epoch, end_epoch, duration, tags, date, entry_index, comment, media."""
        staging = self.store.read_staging()
        pending = []
        for idx, entry in enumerate(staging):
            data = entry["data"]
            if data.get("is_active", False):
                continue
            if data.get("is_paused", False):
                continue

            # Decrypt timestamps
            start_val = data["startTime_enc"]
            if start_val.startswith("plain:"):
                start_epoch = int(start_val[6:])
            else:
                start_epoch = int(self.crypto.decrypt(start_val))

            end_val = data["endTime_enc"]
            if end_val.startswith("plain:"):
                end_epoch = int(end_val[6:])
            else:
                end_epoch = int(self.crypto.decrypt(end_val)) if end_val else None

            date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))

            preview = {
                "entry_index": idx,
                "title": data["title"],
                "start_epoch": start_epoch,
                "end_epoch": end_epoch,
                "duration": data.get("duration", 0),
                "tags": data.get("tags", []),
                "date": date_str,
                "comment": data.get("comment"),
                "media": data.get("media", []),
            }
            pending.append(preview)

        return pending

    def _get_identity_secret(self) -> Optional[bytes]:
        id_data = self.store.read_identity()
        if not id_data: return None
        enc_secret = id_data.get("identity_secret_enc")
        if not enc_secret: return None
        try:
            return bytes.fromhex(self.crypto.decrypt(enc_secret))
        except Exception:
            return None

    def sync_day_with_selection(self, selected_indices, end_time_overrides=None, comment_overrides=None, media_overrides=None):
        """Sync only the entries at selected_indices (from get_pending_sync()).
        Accepts optional per-entry overrides:
          end_time_overrides: {entry_index: {"end_epoch": int}}
          comment_overrides:  {entry_index: {"comment": str}}
          media_overrides:    {entry_index: {"media": list}}
        Unselected entries remain in staging."""
        staging = self.store.read_staging()
        all_completed = [e for e in staging if not e["data"].get("is_active", False)]

        selected = [all_completed[i] for i in selected_indices if i < len(all_completed)] if selected_indices else []
        if not selected:
            return None

        # Apply overrides before syncing
        for idx, entry in enumerate(selected):
            data = entry["data"]
            orig_idx = selected_indices[idx] if idx < len(selected_indices) else None

            if end_time_overrides and orig_idx is not None and orig_idx in end_time_overrides:
                override = end_time_overrides[orig_idx]
                new_end = override["end_epoch"]
                data["endTime_enc"] = self.crypto.encrypt(str(new_end))

                # Recompute duration
                start_val = data["startTime_enc"]
                if start_val.startswith("plain:"):
                    start_epoch = int(start_val[6:])
                else:
                    start_epoch = int(self.crypto.decrypt(start_val))
                pauses = self._reconcile_plain_pauses(data)
                data["duration"] = self._compute_duration(start_epoch, new_end, pauses)

            if comment_overrides and orig_idx is not None and orig_idx in comment_overrides:
                data["comment"] = comment_overrides[orig_idx]["comment"]

            if media_overrides and orig_idx is not None and orig_idx in media_overrides:
                data["media"] = media_overrides[orig_idx]["media"]

            entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

        # Group by date and encrypt
        days_to_sync = {}
        for entry in selected:
            data = entry["data"]
            # Resolve startTime
            if data["startTime_enc"].startswith("plain:"):
                start_epoch = int(data["startTime_enc"][6:])
                data["startTime_enc"] = self.crypto.encrypt(str(start_epoch))
            else:
                start_epoch = int(self.crypto.decrypt(data["startTime_enc"]))

            # Resolve endTime
            if data["endTime_enc"] and data["endTime_enc"].startswith("plain:"):
                end_epoch = int(data["endTime_enc"][6:])
                data["endTime_enc"] = self.crypto.encrypt(str(end_epoch))

            # Resolve Metadata
            if data["metadata_enc"].startswith("plain:"):
                meta_json = data["metadata_enc"][6:]
                data["metadata_enc"] = self.crypto.encrypt(meta_json)

            # Resolve pauses_enc
            if "pauses_enc" in data and data["pauses_enc"].startswith("plain:"):
                pauses_json = data["pauses_enc"][6:]
                data["pauses_enc"] = self.crypto.encrypt(pauses_json)

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

            prev_date = time.strptime(prev_record.get("date", "1970-01-01"), "%Y-%m-%d")
            curr_date = time.strptime(date_str, "%Y-%m-%d")

            if curr_date.tm_year > prev_date.tm_year and prev_record.get("type") != "year_summary":
                year_summary = {
                    "type": "year_summary", "year": prev_date.tm_year,
                    "prev_hash": prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                    "date": date_str
                }
                year_summary["year_hash"] = self.crypto.seal(json.dumps(year_summary, sort_keys=True))
                if identity_secret:
                    year_summary["signature"] = self.crypto.sign(year_summary["year_hash"], identity_secret)
                ledger.append(year_summary)
                prev_record = ledger[-1]

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

            if date_str not in index:
                index[date_str] = {}
            for entry in days_to_sync[date_str]:
                title = entry["data"]["title"]
                duration = entry["data"]["duration"]
                index[date_str][title] = index[date_str].get(title, 0) + duration

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

        # Remove only the synced entries from staging, keep active + unsynced completed
        synced_indices_set = set()
        for all_idx, entry in enumerate(all_completed):
            if entry in selected:
                synced_indices_set.add(id(entry))

        new_staging = []
        for entry in staging:
            keep = True
            if not entry["data"].get("is_active", False):
                if id(entry) in synced_indices_set:
                    keep = False
            if keep:
                new_staging.append(entry)
        self.store.write_staging(new_staging)
        return ledger[-1].get("day_hash")[:10]

    def sync_with_strategy(self, strategy):
        """Sync using a SyncStrategy for confirmation.

        The strategy receives pending entries via get_pending_sync() and returns
        a SyncDecision. This method executes that decision.

        Args:
            strategy: A SyncStrategy instance.

        Returns:
            The day_hash prefix if entries were synced, or None.
        """
        from core.sync_confirmation import SyncDecision
        pending = self.get_pending_sync()
        decision = strategy.decide(pending)

        if decision.cancelled or not decision.has_selection:
            return None

        return self.sync_day_with_selection(
            decision.selected_indices,
            end_time_overrides=decision.end_time_overrides,
            comment_overrides=decision.comment_overrides,
            media_overrides=decision.media_overrides,
        )

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

            # 4. Resolve pauses_enc
            if "pauses_enc" in data and data["pauses_enc"].startswith("plain:"):
                pauses_json = data["pauses_enc"][6:]
                data["pauses_enc"] = self.crypto.encrypt(pauses_json)

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
