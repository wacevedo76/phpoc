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

    @staticmethod
    def _compute_content_hash(title: str, start_epoch: int, end_epoch_str: str,
                              metadata_json: str, pauses_json: str,
                              tags: list, comment: str, media: list,
                              duration: int) -> str:
        """Compute a content hash from resolved plaintext values.

        This hash represents the entry's plaintext content and survives
        re-encryption since it's based on actual values, not ciphertext.

        Args:
            title: Activity title.
            start_epoch: Start time in epoch ms (as int).
            end_epoch_str: End time as string (epoch ms), or "".
            metadata_json: JSON string of metadata.
            pauses_json: JSON string of pauses list.
            tags: Sorted list of tag strings.
            comment: Comment string.
            media: List of media references.
            duration: Duration in ms.
        """
        content = {
            "title": title,
            "startTime": str(start_epoch),
            "endTime": end_epoch_str if end_epoch_str else "",
            "metadata": metadata_json if metadata_json else "{}",
            "pauses": pauses_json if pauses_json else "[]",
            "tags": sorted(tags),
            "comment": comment if comment else "",
            "media": sorted(media),
            "duration": duration,
        }
        return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()

    def _get_identity_secret(self) -> Optional[bytes]:
        # Try identity.json first
        id_data = self.store.read_identity()
        if id_data:
            enc_secret = id_data.get("identity_secret_enc")
            if enc_secret:
                try:
                    return bytes.fromhex(self.crypto.decrypt(enc_secret))
                except Exception:
                    pass

        # Fallback: check genesis block for embedded identity secret
        try:
            ledger = self.store.read_ledger()
            if ledger and len(ledger) > 0:
                genesis = ledger[0]
                enc_fallback = genesis.get("identity", {}).get("identity_secret_enc_fallback")
                if enc_fallback:
                    return bytes.fromhex(self.crypto.decrypt(enc_fallback))
        except Exception:
            pass

        return None

    def sync_day_with_selection(self, selected_indices, overrides=None):
        """Sync only the entries at selected_indices (from get_pending_sync()).
        Accepts optional per-entry overrides dict:
          overrides: {entry_index: {"end_epoch": int, "comment": str, "media": list}}
        Only fields that are present in the override dict are applied.
        Unselected entries remain in staging."""
        staging = self.store.read_staging()
        selected_set = set(selected_indices) if selected_indices else set()
        selected = [staging[i] for i in selected_set
                     if i < len(staging) and not staging[i]["data"].get("is_active", False)]
        if not selected:
            return None
        overrides = overrides or {}

        # Apply overrides before syncing
        for idx, entry in enumerate(selected):
            data = entry["data"]
            orig_idx = selected_indices[idx] if idx < len(selected_indices) else None

            if orig_idx is not None and orig_idx in overrides:
                ov = overrides[orig_idx]

                if "end_epoch" in ov:
                    new_end = ov["end_epoch"]
                    data["endTime_enc"] = self.crypto.encrypt(str(new_end))

                    # Recompute duration
                    start_val = data["startTime_enc"]
                    if start_val.startswith("plain:"):
                        start_epoch = int(start_val[6:])
                    else:
                        start_epoch = int(self.crypto.decrypt(start_val))
                    pauses = self._reconcile_plain_pauses(data)
                    data["duration"] = self._compute_duration(start_epoch, new_end, pauses)

                if "comment" in ov:
                    data["comment"] = ov["comment"]

                if "media" in ov:
                    data["media"] = ov["media"]

            entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

        # Group by date and encrypt
        days_to_sync = {}
        for entry in selected:
            data = entry["data"]

            # Resolve all plaintext values before encryption
            if data["startTime_enc"].startswith("plain:"):
                start_epoch = int(data["startTime_enc"][6:])
            else:
                start_epoch = int(self.crypto.decrypt(data["startTime_enc"]))

            end_epoch = None
            if data["endTime_enc"]:
                if data["endTime_enc"].startswith("plain:"):
                    end_epoch = int(data["endTime_enc"][6:])
                else:
                    end_epoch = int(self.crypto.decrypt(data["endTime_enc"]))

            if data["metadata_enc"].startswith("plain:"):
                meta_json_str = data["metadata_enc"][6:]
            else:
                meta_json_str = self.crypto.decrypt(data["metadata_enc"])

            if "pauses_enc" in data and data["pauses_enc"]:
                if data["pauses_enc"].startswith("plain:"):
                    pauses_json_str = data["pauses_enc"][6:]
                else:
                    pauses_json_str = self.crypto.decrypt(data["pauses_enc"])
            else:
                pauses_json_str = "[]"

            # Now encrypt fields for ledger storage
            data["startTime_enc"] = self.crypto.encrypt(str(start_epoch))
            data["endTime_enc"] = self.crypto.encrypt(str(end_epoch)) if end_epoch is not None else data.get("endTime_enc")
            data["metadata_enc"] = self.crypto.encrypt(meta_json_str)
            if "pauses_enc" in data:
                data["pauses_enc"] = self.crypto.encrypt(pauses_json_str)

            # Compute content hash from resolved plaintext values (before final entry hash)
            data["content_hash"] = self._compute_content_hash(
                title=data["title"],
                start_epoch=start_epoch,
                end_epoch_str=str(end_epoch) if end_epoch is not None else "",
                metadata_json=meta_json_str,
                pauses_json=pauses_json_str,
                tags=data.get("tags", []),
                comment=data.get("comment", ""),
                media=data.get("media", []),
                duration=data.get("duration", 0),
            )

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
        selected_ids = {id(entry) for entry in selected}

        new_staging = []
        for entry in staging:
            keep = True
            if not entry["data"].get("is_active", False):
                if id(entry) in selected_ids:
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
            overrides=decision.overrides if decision.overrides else None,
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

            # Resolve all plaintext values before encryption
            if data["startTime_enc"].startswith("plain:"):
                start_epoch = int(data["startTime_enc"][6:])
            else:
                start_epoch = int(self.crypto.decrypt(data["startTime_enc"]))

            end_epoch = None
            if data["endTime_enc"]:
                if data["endTime_enc"].startswith("plain:"):
                    end_epoch = int(data["endTime_enc"][6:])
                else:
                    end_epoch = int(self.crypto.decrypt(data["endTime_enc"]))

            if data["metadata_enc"].startswith("plain:"):
                meta_json_str = data["metadata_enc"][6:]
            else:
                meta_json_str = self.crypto.decrypt(data["metadata_enc"])

            if "pauses_enc" in data and data["pauses_enc"]:
                if data["pauses_enc"].startswith("plain:"):
                    pauses_json_str = data["pauses_enc"][6:]
                else:
                    pauses_json_str = self.crypto.decrypt(data["pauses_enc"])
            else:
                pauses_json_str = "[]"

            # Now encrypt fields for ledger storage
            data["startTime_enc"] = self.crypto.encrypt(str(start_epoch))
            data["endTime_enc"] = self.crypto.encrypt(str(end_epoch)) if end_epoch is not None else data.get("endTime_enc")
            data["metadata_enc"] = self.crypto.encrypt(meta_json_str)
            if "pauses_enc" in data:
                data["pauses_enc"] = self.crypto.encrypt(pauses_json_str)

            # Compute content hash from resolved plaintext values (before final entry hash)
            data["content_hash"] = self._compute_content_hash(
                title=data["title"],
                start_epoch=start_epoch,
                end_epoch_str=str(end_epoch) if end_epoch is not None else "",
                metadata_json=meta_json_str,
                pauses_json=pauses_json_str,
                tags=data.get("tags", []),
                comment=data.get("comment", ""),
                media=data.get("media", []),
                duration=data.get("duration", 0),
            )

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
                    data = entry["data"]
                    # Standard entry hash check
                    if hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest() != entry["hash"]:
                        return False
                    # Optional content hash check — verifies plaintext survives re-encryption
                    if "content_hash" in data:
                        try:
                            # Decrypt fields to reconstruct plaintext for hash comparison
                            # Build a copy of data with encrypted fields decrypted
                            plain = dict(data)
                            for enc_field in ["startTime_enc", "endTime_enc", "metadata_enc", "pauses_enc"]:
                                if enc_field in plain and plain[enc_field]:
                                    plain[enc_field] = self.crypto.decrypt(plain[enc_field])
                            if hashlib.sha256(json.dumps({
                                "title": plain.get("title", ""),
                                "startTime": plain.get("startTime_enc", ""),
                                "endTime": plain.get("endTime_enc", ""),
                                "metadata": plain.get("metadata_enc", ""),
                                "pauses": plain.get("pauses_enc", ""),
                                "tags": sorted(plain.get("tags", [])),
                                "comment": plain.get("comment", ""),
                                "media": sorted(plain.get("media", [])),
                                "duration": plain.get("duration", 0),
                            }, sort_keys=True).encode()).hexdigest() != data["content_hash"]:
                                return False
                        except Exception:
                            return False
        return True

    def revert_entries(self, count: int):
        """Revert the last N day blocks from the ledger, restoring entries to staging.

        Truncates from the end of the chain only — the remaining chain is
        untouched and fully verifiable. This is NOT a general-purpose delete:
        it only removes the most recently synced blocks.

        Args:
            count: Number of day blocks to remove from the end.

        Returns:
            The number of entries restored to staging, or -1 if count is
            larger than the number of available day blocks.
        """
        ledger = self.store.read_ledger()
        index = self.store.read_index()

        if not ledger:
            return 0

        # Count day blocks
        day_blocks = [i for i, b in enumerate(ledger) if b.get("type", "day") == "day"]
        if count > len(day_blocks):
            return -1
        if count <= 0:
            return 0

        revert_threshold = day_blocks[-count]  # index of first day block to revert
        entries_restored = 0

        # Collect entries from day blocks being reverted, and update index
        staging = self.store.read_staging()
        for i in range(revert_threshold, len(ledger)):
            block = ledger[i]
            if block.get("type", "day") == "day":
                date_str = block["date"]
                for entry in block.get("entries", []):
                    data = dict(entry["data"])  # shallow copy
                    # Reconstruct staging entry from synced data
                    staging_entry = {
                        "hash": entry["hash"],
                        "data": data,
                        "start_epoch": int(
                            self.crypto.decrypt(data.get("startTime_enc", "0"))
                        ),
                    }
                    staging.append(staging_entry)
                    entries_restored += 1

                    # Remove from index
                    title = data["title"]
                    duration = data.get("duration", 0)
                    if date_str in index and title in index[date_str]:
                        index[date_str][title] -= duration
                        if index[date_str][title] <= 0:
                            del index[date_str][title]
                    if date_str in index and not index[date_str]:
                        del index[date_str]

        # Truncate ledger — everything before revert_threshold stays intact
        new_ledger = ledger[:revert_threshold]

        self.store.write_ledger(new_ledger)
        self.store.write_index(index)
        self.store.write_staging(staging)
        return entries_restored

    def get_ledger_data(self):
        return self.store.read_ledger()
