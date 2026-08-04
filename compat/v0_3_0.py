"""
v0.3.0 backward compatibility module — original CRUD LedgerDomain.

Extracted from core/ledger.py to isolate legacy code. New code should use
StagingService + LedgerEngine directly instead of LedgerDomain.

Contents:
  - _LegacyChainAdapter — maps AbstractLedgerStore to LedgerEngine store interface
  - _compute_content_hash — static content hash computation (shared by sync methods)
  - LedgedDomain — original CRUD methods + delegated ledger ops (verify/revert/sync)
"""

import json
import hashlib
import time

from security.crypto import AbstractCryptoManager
from storage.interface import AbstractLedgerStore
from phpoc_cli.trace import trace


class _LegacyChainAdapter:
    """Adapts a legacy AbstractLedgerStore to what LedgerEngine expects.

    Maps read_staging() -> read_entries(), read_ledger() -> read_blocks(),
    write_staging() -> write_entries(), write_ledger() -> append_blocks()/truncate().
    """

    def __init__(self, store):
        self._store = store

    def read_entries(self):
        return self._store.read_staging()

    def write_entries(self, data):
        self._store.write_staging(data)

    def append_entry(self, entry):
        entries = self._store.read_staging()
        entries.append(entry)
        self._store.write_staging(entries)

    def remove_entries(self, indices):
        entries = self._store.read_staging()
        for i in sorted(indices, reverse=True):
            if 0 <= i < len(entries):
                entries.pop(i)
        self._store.write_staging(entries)

    def update_entry(self, index, fields):
        entries = self._store.read_staging()
        if 0 <= index < len(entries):
            entries[index].update(fields)
            self._store.write_staging(entries)

    def read_blocks(self, start=0, end=None):
        ledger = self._store.read_ledger() or []
        if start < 0:
            start = max(0, len(ledger) + start)
        return ledger[start:end]

    def append_blocks(self, blocks):
        ledger = self._store.read_ledger() or []
        ledger.extend(blocks)
        self._store.write_ledger(ledger)

    def truncate(self, keep_count):
        ledger = self._store.read_ledger() or []
        removed = ledger[keep_count:]
        self._store.write_ledger(ledger[:keep_count])
        return removed

    def get_block_count(self):
        return len(self._store.read_ledger() or [])

    def get_last_block(self):
        ledger = self._store.read_ledger() or []
        return ledger[-1] if ledger else None

    def read_index(self):
        return self._store.read_index()

    def write_index(self, data):
        self._store.write_index(data)


def _compute_content_hash(data, decrypt_fn):
    """Compute an extensible content hash from an entry's data dict."""
    content = {}
    for key, value in data.items():
        if key == "content_hash":
            continue
        if key.endswith("_enc") and value is not None and value != "":
            content[key] = decrypt_fn(value)
        elif isinstance(value, list):
            content[key] = sorted(value)
        else:
            content[key] = value
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


class LedgerDomain:
    """Backward-compatible wrapper — CRUD methods original, ledger ops delegate.

    CRUD methods (capture_habit, end_habit, etc.) use the original implementation
    that calls crypto.encrypt() directly. Old tests that inspect raw staging data
    with crypto.decrypt() continue to work.
    """

    def __init__(self, crypto: AbstractCryptoManager, store: AbstractLedgerStore):
        self.crypto = crypto
        self.store = store
        self._adapter = _LegacyChainAdapter(store)
        from domain.ledger.engine import LedgerEngine
        self._engine = LedgerEngine(
            crypto=crypto,
            store=self._adapter,
            index_store=self._adapter,
            staging_store=self._adapter,
        )

    def _compute_duration(self, start_epoch, end_epoch, pauses):
        total_pause_ms = 0
        for p in pauses:
            if p.get("pause_stop") is not None:
                total_pause_ms += p["pause_stop"] - p["pause_start"]
        return max(0, (end_epoch - start_epoch) - total_pause_ms)

    def _decrypt_pauses(self, data):
        pauses_enc = data.get("pauses_enc")
        if pauses_enc is None:
            return []
        if pauses_enc.startswith("plain:"):
            return json.loads(pauses_enc[6:])
        return json.loads(self.crypto.decrypt(pauses_enc))

    def _encrypt_pauses(self, pauses):
        return self.crypto.encrypt(json.dumps(pauses))

    def _reconcile_plain_pauses(self, data):
        pauses_enc = data.get("pauses_enc")
        if pauses_enc is not None and pauses_enc.startswith("plain:"):
            pauses = json.loads(pauses_enc[6:])
            data["pauses_enc"] = self._encrypt_pauses(pauses)
            return pauses
        if pauses_enc is not None:
            return json.loads(self.crypto.decrypt(pauses_enc))
        return []

    def capture_habit(self, title, start_epoch, stop_epoch=None, metadata=None,
                      is_active=False, tags=None, comment=None, media=None):
        staging = self.store.read_staging()
        normalized_tags = []
        if tags is not None:
            seen = set()
            for t in tags:
                clean = t.strip().lower()
                if clean and clean not in seen:
                    seen.add(clean)
                    normalized_tags.append(clean)
            normalized_tags.sort()
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
                start_val = data["startTime_enc"]
                if start_val.startswith("plain:"):
                    start_epoch = int(start_val[6:])
                else:
                    start_epoch = int(self.crypto.decrypt(start_val))
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
                entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                found = True
                break
        if not found:
            raise ValueError(f"No active task found for: {title}")
        self.store.write_staging(staging)

    def end_habit_at(self, title, end_epoch, comment=None):
        staging = self.store.read_staging()
        found = False
        for entry in staging:
            if entry["data"]["title"] == title and entry["data"].get("is_active"):
                data = entry["data"]
                start_val = data["startTime_enc"]
                if start_val.startswith("plain:"):
                    start_epoch = int(start_val[6:])
                else:
                    start_epoch = int(self.crypto.decrypt(start_val))
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
                entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                found = True
                break
        if not found:
            raise ValueError(f"No active task found for: {title}")
        self.store.write_staging(staging)

    def pause_habit(self, title, pause_epoch, comment=None):
        staging = self.store.read_staging()
        found = False
        for entry in staging:
            if entry["data"]["title"] == title and entry["data"].get("is_active"):
                data = entry["data"]
                if data.get("is_paused"):
                    raise ValueError(f"Task '{title}' is already paused.")
                pauses = self._reconcile_plain_pauses(data)
                next_index = len(pauses) + 1
                pause_record = {"pause_index": next_index, "pause_start": pause_epoch, "pause_stop": None}
                if comment is not None:
                    pause_record["comment"] = comment
                pauses.append(pause_record)
                data["pauses_enc"] = self._encrypt_pauses(pauses)
                data["is_paused"] = True
                entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                found = True
                break
        if not found:
            raise ValueError(f"No active task found for: {title}")
        self.store.write_staging(staging)

    def unpause_habit(self, title, unpause_epoch, comment=None):
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
                start_val = data["startTime_enc"]
                if start_val.startswith("plain:"):
                    start_epoch = int(start_val[6:])
                else:
                    start_epoch = int(self.crypto.decrypt(start_val))
                data["duration"] = self._compute_duration(start_epoch, unpause_epoch, pauses)
                entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                found = True
                break
        if not found:
            raise ValueError(f"No active task found for: {title}")
        self.store.write_staging(staging)

    def get_pending_sync(self):
        staging = self.store.read_staging()
        pending = []
        for idx, entry in enumerate(staging):
            data = entry["data"]
            if data.get("is_active", False):
                continue
            if data.get("is_paused", False):
                continue
            start_val = data["startTime_enc"]
            if start_val.startswith("plain:"):
                start_epoch = int(start_val[6:])
            else:
                start_epoch = int(self.crypto.decrypt(start_val))
            end_val = data["endTime_enc"]
            if end_val:
                if end_val.startswith("plain:"):
                    end_epoch = int(end_val[6:])
                else:
                    end_epoch = int(self.crypto.decrypt(end_val))
            else:
                end_epoch = None
            date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
            pending.append({
                "entry_index": idx,
                "title": data["title"],
                "start_epoch": start_epoch,
                "end_epoch": end_epoch,
                "duration": data.get("duration", 0),
                "tags": data.get("tags", []),
                "date": date_str,
                "comment": data.get("comment"),
                "media": data.get("media", []),
            })
        return pending

    @trace
    def modify_staged_entry(self, entry_index, end_epoch=None, pauses=None):
        staging = self.store.read_staging()
        if entry_index < 0 or entry_index >= len(staging):
            raise ValueError(f"No staged entry at index {entry_index}.")
        entry = staging[entry_index]
        data = entry["data"]
        if data.get("is_active", False):
            raise ValueError(f"Cannot modify active task '{data['title']}'. End it first.")
        start_val = data["startTime_enc"]
        if start_val.startswith("plain:"):
            start_epoch = int(start_val[6:])
        else:
            start_epoch = int(self.crypto.decrypt(start_val))
        if end_epoch is not None:
            data["endTime_enc"] = self.crypto.encrypt(str(end_epoch))
        current_pauses = self._reconcile_plain_pauses(data)
        if pauses is not None:
            data["pauses_enc"] = self.crypto.encrypt(json.dumps(pauses))
            resolved_pauses = pauses
        else:
            resolved_pauses = current_pauses
        resolved_end = end_epoch if end_epoch is not None else self._decrypt_staging_timestamp(data, "endTime_enc")
        if resolved_end is not None:
            data["duration"] = self._compute_duration(start_epoch, resolved_end, resolved_pauses)
        entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
        self.store.write_staging(staging)
        return {"title": data["title"], "duration": data.get("duration", 0)}

    @trace
    def remove_staged_entry(self, entry_index):
        staging = self.store.read_staging()
        if entry_index < 0 or entry_index >= len(staging):
            raise ValueError(f"No staged entry at index {entry_index}.")
        entry = staging.pop(entry_index)
        self.store.write_staging(staging)
        return entry["data"]["title"]

    def get_staged_entries_preview(self):
        staging = self.store.read_staging()
        preview = []
        for idx, entry in enumerate(staging):
            data = entry["data"]
            if data.get("is_active", False):
                continue
            if data.get("is_paused", False):
                continue
            start_val = data["startTime_enc"]
            if start_val.startswith("plain:"):
                start_epoch = int(start_val[6:])
            else:
                start_epoch = int(self.crypto.decrypt(start_val))
            end_val = data["endTime_enc"]
            if end_val:
                if end_val.startswith("plain:"):
                    end_epoch = int(end_val[6:])
                else:
                    end_epoch = int(self.crypto.decrypt(end_val))
            else:
                end_epoch = None
            pauses_enc = data.get("pauses_enc")
            if pauses_enc:
                if pauses_enc.startswith("plain:"):
                    pauses = json.loads(pauses_enc[6:])
                else:
                    pauses = json.loads(self.crypto.decrypt(pauses_enc))
            else:
                pauses = []
            date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
            preview.append({
                "entry_index": idx, "date": date_str,
                "title": data["title"], "start_epoch": start_epoch,
                "end_epoch": end_epoch, "duration": data.get("duration", 0),
                "tags": data.get("tags", []), "comment": data.get("comment"),
                "pauses": pauses, "is_paused": data.get("is_paused", False),
                "is_active": data.get("is_active", False),
            })
        return preview

    def _decrypt_staging_timestamp(self, data, field):
        val = data.get(field)
        if val is None:
            return None
        if val.startswith("plain:"):
            return int(val[6:])
        return int(self.crypto.decrypt(val))

    def _get_identity_secret(self):
        id_data = self.store.read_identity()
        if id_data:
            enc_secret = id_data.get("identity_secret_enc")
            if enc_secret:
                try:
                    return bytes.fromhex(self.crypto.decrypt(enc_secret))
                except Exception:
                    pass
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

    def _normalize_staging_entry(self, data):
        for field in ["startTime_enc", "endTime_enc", "metadata_enc", "pauses_enc"]:
            val = data.get(field)
            if val and not val.startswith("plain:"):
                try:
                    plaintext = self.crypto.decrypt(val)
                    data[field] = f"plain:{plaintext}"
                except Exception:
                    return False
            elif field == "pauses_enc" and val is None:
                data[field] = "plain:[]"
        return True

    def sync_day_with_selection(self, selected_indices, overrides=None,
                                 removal_indices=None):
        """ORIGINAL implementation — delegates to self.crypto for encryption."""
        staging = self.store.read_staging()

        selected_set = set(selected_indices) if selected_indices else set()
        selected = [staging[i] for i in selected_set
                     if i < len(staging) and not staging[i]["data"].get("is_active", False)]
        if not selected:
            return None
        overrides = overrides or {}

        skipped = []
        normalized = []
        for entry in selected:
            if self._normalize_staging_entry(entry["data"]):
                normalized.append(entry)
            else:
                skipped.append(entry["data"].get("title", "?"))
        selected = normalized
        if skipped:
            print(f"WARN: Skipped {len(skipped)} entries with undecryptable data (stale crypto context):")
            for title in skipped:
                print(f"  - {title}")
        if not selected:
            return None

        for idx, entry in enumerate(selected):
            data = entry["data"]
            orig_idx = selected_indices[idx] if idx < len(selected_indices) else None
            if orig_idx is not None and orig_idx in overrides:
                ov = overrides[orig_idx]
                if "end_epoch" in ov:
                    new_end = ov["end_epoch"]
                    data["endTime_enc"] = self.crypto.encrypt(str(new_end))
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

        days_to_sync = {}
        for entry in selected:
            data = entry["data"]
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

            data["startTime_enc"] = self.crypto.encrypt(str(start_epoch))
            data["endTime_enc"] = self.crypto.encrypt(str(end_epoch)) if end_epoch is not None else data.get("endTime_enc")
            data["metadata_enc"] = self.crypto.encrypt(meta_json_str)
            if "pauses_enc" in data:
                data["pauses_enc"] = self.crypto.encrypt(pauses_json_str)
            data["content_hash"] = _compute_content_hash(data, self.crypto.decrypt)
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
                    "prev_hash": prev_record.get("block_hash") or prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                    "date": date_str
                }
                year_summary["year_hash"] = self.crypto.seal(json.dumps(year_summary, sort_keys=True))
                if identity_secret:
                    year_summary["identity_seal"] = self.crypto.mac(year_summary["year_hash"], identity_secret)
                ledger.append(year_summary)
                prev_record = ledger[-1]

            if curr_date.tm_mon > prev_date.tm_mon and prev_record.get("type") != "month_summary":
                month_summary = {
                    "type": "month_summary",
                    "month": f"{prev_date.tm_year}-{prev_date.tm_mon:02d}",
                    "prev_hash": prev_record.get("block_hash") or prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                    "date": date_str
                }
                month_summary["month_hash"] = self.crypto.seal(json.dumps(month_summary, sort_keys=True))
                if identity_secret:
                    month_summary["identity_seal"] = self.crypto.mac(month_summary["month_hash"], identity_secret)
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
                "prev_hash": prev_record.get("block_hash") or prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                "entries": [{"hash": e["hash"], "data": e["data"]} for e in days_to_sync[date_str]]
            }
            day_json = json.dumps(day_content, sort_keys=True)
            day_content["day_hash"] = self.crypto.seal(day_json)
            if identity_secret:
                day_content["identity_seal"] = self.crypto.mac(day_content["day_hash"], identity_secret)
            ledger.append(day_content)

        self.store.write_ledger(ledger)
        self.store.write_index(index)

        selected_ids = {id(entry) for entry in selected}
        removal_set = set(removal_indices) if removal_indices else set()
        new_staging = []
        for i, entry in enumerate(staging):
            keep = True
            if not entry["data"].get("is_active", False):
                if id(entry) in selected_ids or i in removal_set:
                    keep = False
            if keep:
                new_staging.append(entry)
        self.store.write_staging(new_staging)
        return (ledger[-1].get("block_hash") or ledger[-1].get("day_hash"))[:10]

    def sync_with_strategy(self, strategy, till_date=None):
        from core.sync.decision import SyncDecision
        pending = self.get_pending_sync()
        if till_date:
            pending = [p for p in pending if p["date"] <= till_date]
        pending.sort(key=lambda p: p["entry_index"])
        if not pending:
            print("Nothing to sync.")
            return None
        decision = strategy.decide(pending)

        if decision.cancelled:
            return None

        if not decision.has_selection:
            if decision.has_removals:
                staging = self.store.read_staging()
                removal_set = set(decision.removal_indices)
                new_staging = [e for i, e in enumerate(staging)
                               if e["data"].get("is_active", False) or i not in removal_set]
                self.store.write_staging(new_staging)
                removed_count = len(removal_set)
                print(f"Removed {removed_count} {'entry' if removed_count == 1 else 'entries'} from staging.")
            return None

        result = self.sync_day_with_selection(
            decision.selected_indices,
            overrides=decision.overrides if decision.overrides else None,
            removal_indices=decision.removal_indices if decision.has_removals else None,
        )
        return result

    def sync_day(self):
        """Sync all completed entries from staging to the ledger."""
        staging = self.store.read_staging()
        to_sync = [e for e in staging if not e["data"].get("is_active", False)]
        if not to_sync:
            return None

        days_to_sync = {}
        for entry in to_sync:
            data = dict(entry["data"])
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

            data["startTime_enc"] = self.crypto.encrypt(str(start_epoch))
            data["endTime_enc"] = self.crypto.encrypt(str(end_epoch)) if end_epoch is not None else data.get("endTime_enc")
            data["metadata_enc"] = self.crypto.encrypt(meta_json_str)
            if "pauses_enc" in data:
                data["pauses_enc"] = self.crypto.encrypt(pauses_json_str)
            data["content_hash"] = _compute_content_hash(data, self.crypto.decrypt)
            entry_hash = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

            date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
            if date_str not in days_to_sync:
                days_to_sync[date_str] = []
            days_to_sync[date_str].append({"hash": entry_hash, "data": data})

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
                    "prev_hash": prev_record.get("block_hash") or prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                    "date": date_str
                }
                year_summary["year_hash"] = self.crypto.seal(json.dumps(year_summary, sort_keys=True))
                if identity_secret:
                    year_summary["identity_seal"] = self.crypto.mac(year_summary["year_hash"], identity_secret)
                ledger.append(year_summary)
                prev_record = ledger[-1]

            if curr_date.tm_mon > prev_date.tm_mon and prev_record.get("type") != "month_summary":
                month_summary = {
                    "type": "month_summary",
                    "month": f"{prev_date.tm_year}-{prev_date.tm_mon:02d}",
                    "prev_hash": prev_record.get("block_hash") or prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                    "date": date_str
                }
                month_summary["month_hash"] = self.crypto.seal(json.dumps(month_summary, sort_keys=True))
                if identity_secret:
                    month_summary["identity_seal"] = self.crypto.mac(month_summary["month_hash"], identity_secret)
                ledger.append(month_summary)
                prev_record = ledger[-1]

            if date_str not in index:
                index[date_str] = {}
            for e in days_to_sync[date_str]:
                title = e["data"]["title"]
                duration = e["data"]["duration"]
                index[date_str][title] = index[date_str].get(title, 0) + duration

            day_content = {
                "type": "day",
                "day_index": prev_record.get("day_index", 0) + 1 if prev_record.get("type") == "day" else 1,
                "date": date_str,
                "prev_hash": prev_record.get("block_hash") or prev_record.get("day_hash") or prev_record.get("month_hash") or prev_record.get("year_hash"),
                "entries": [{"hash": e["hash"], "data": e["data"]} for e in days_to_sync[date_str]]
            }
            day_json = json.dumps(day_content, sort_keys=True)
            day_content["day_hash"] = self.crypto.seal(day_json)
            if identity_secret:
                day_content["identity_seal"] = self.crypto.mac(day_content["day_hash"], identity_secret)
            ledger.append(day_content)

        self.store.write_ledger(ledger)
        self.store.write_index(index)
        self.store.write_staging([e for e in staging if e["data"].get("is_active", False)])
        return (ledger[-1].get("block_hash") or ledger[-1].get("day_hash"))[:10]

    def _sync_engine_index(self):
        """Reload engine index from store (handles legacy code writing directly to store)."""
        self._adapter.write_index(self.store.read_index())
        self._engine.index.reload()

    def verify(self):
        self._sync_engine_index()
        return self._engine.verify()

    def revert_entries(self, count):
        self._sync_engine_index()
        return self._engine.revert(count)

    def get_ledger_data(self):
        return self.store.read_ledger()
