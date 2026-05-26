"""LocalStagingCache — the ONLY class that knows about the plain: prefix convention.

LocalStagingCache handles encrypt/decrypt of staging entry fields and provides
CRUD methods that higher layers use without ever seeing ``plain:``.

This is a critical boundary in the architecture:
- ``plain:`` prefix is an internal detail, visible ONLY here
- All callers (StagingService, SyncOrchestrator, views) receive decrypted DTOs
- When ``plain:`` is eventually replaced with real no-op encryption, only this
  file changes
"""

import json
import hashlib
import time
import uuid
from typing import Optional, List, Dict, Any, Tuple

from security.crypto import AbstractCryptoManager
from storage.staging_store import AbstractStagingStore


class LocalStagingCache:
    """Manages local staging entries with the plain: prefix convention.

    This is the ONLY class that knows about ``plain:``. No other component
    should see ``startswith("plain:")`` checks.

    Attributes:
        _crypto: CryptoManager for encrypting/decrypting entry fields.
        _store: AbstractStagingStore for persistence (staging.json).
    """

    def __init__(self, crypto: AbstractCryptoManager, staging_store: AbstractStagingStore):
        self._crypto = crypto
        self._store = staging_store

    # ------------------------------------------------------------------
    # Internal: plain: encoding/decoding
    # ------------------------------------------------------------------

    def _to_plain(self, field_value: str) -> str:
        """Internal: store as ``plain:`` prefix (no real encryption)."""
        return f"plain:{field_value}"

    def _from_plain(self, field_value: Optional[str]) -> Optional[str]:
        """Internal: strip ``plain:`` prefix (no real decryption).

        Returns None if input is None, otherwise strips the ``plain:`` prefix.
        If the value uses real encryption (``ENC:...``), delegates to crypto.
        """
        if field_value is None:
            return None
        if field_value.startswith("plain:"):
            return field_value[6:]
        try:
            return self._crypto.decrypt(field_value)
        except Exception:
            return None

    def _from_plain_int(self, field_value: Optional[str]) -> Optional[int]:
        """Decrypt a field and convert to int. Returns None on failure."""
        decrypted = self._from_plain(field_value)
        if decrypted is None:
            return None
        try:
            return int(decrypted)
        except (ValueError, TypeError):
            return None

    def _encrypt_field(self, value: Any) -> str:
        """Encrypt a field value for storage (uses plain: prefix internally)."""
        return self._to_plain(str(value))

    # ------------------------------------------------------------------
    # Reading / Writing (full list)
    # ------------------------------------------------------------------

    def read_entries(self) -> List[Dict[str, Any]]:
        """Read all staged entries, decrypt fields, return DTOs.

        Returns decrypted entries suitable for external consumption —
        no ``plain:`` prefix visible, timestamps are integers, pauses are parsed.

        Returns:
            List of dicts with decrypted fields (start_epoch, end_epoch, pauses, etc.)
            plus metadata (entry_index, hash, source).
        """
        raw = self._store.read_entries()
        result = []
        for idx, entry in enumerate(raw):
            try:
                data = entry.get("data", {})

                # Decrypt fields
                start_epoch = self._from_plain_int(data.get("startTime_enc"))
                if start_epoch is None:
                    # Corrupt entry — skip
                    continue

                end_epoch = self._from_plain_int(data.get("endTime_enc"))

                pauses_raw = self._from_plain(data.get("pauses_enc"))
                pauses = json.loads(pauses_raw) if pauses_raw else []

                metadata_raw = self._from_plain(data.get("metadata_enc"))
                metadata = json.loads(metadata_raw) if metadata_raw else {}

                date_str = time.strftime(
                    "%Y-%m-%d", time.gmtime(start_epoch // 1000)
                )

                device_uuid = self._from_plain(data.get("device_uuid_enc"))
                end_device_uuid = self._from_plain(data.get("end_device_uuid_enc"))

                dto = {
                    "entry_index": idx,
                    "title": data.get("title", ""),
                    "start_epoch": start_epoch,
                    "end_epoch": end_epoch,
                    "duration": data.get("duration", 0),
                    "is_active": data.get("is_active", False),
                    "is_paused": data.get("is_paused", False),
                    "pauses": pauses,
                    "tags": data.get("tags", []),
                    "comment": data.get("comment"),
                    "media": data.get("media", []),
                    "entry_id": data.get("entry_id", ""),
                    "metadata": metadata,
                    "date": date_str,
                    "source": "local",
                    "hash": entry.get("hash", ""),
                    "device_uuid": device_uuid or "",
                    "end_device_uuid": end_device_uuid or "",
                }
                result.append(dto)
            except Exception:
                # Skip corrupt entries
                continue
        return result

    def write_entries(self, entries: List[Dict[str, Any]]):
        """Write a list of DTOs back to storage (encrypting fields to ``plain:``).

        Args:
            entries: List of DTOs (as returned by ``read_entries``).
        """
        raw = []
        for entry in entries:
            data = {
                "title": entry["title"],
                "duration": entry.get("duration", 0),
                "is_active": entry.get("is_active", False),
                "is_paused": entry.get("is_paused", False),
                "startTime_enc": self._encrypt_field(entry.get("start_epoch", 0)),
                "endTime_enc": self._encrypt_field(entry["end_epoch"])
                if entry.get("end_epoch") is not None else None,
                "pauses_enc": self._encrypt_field(json.dumps(entry.get("pauses", []))),
                "metadata_enc": self._encrypt_field(json.dumps(entry.get("metadata", {}))),
                "tags": entry.get("tags", []),
                "media": entry.get("media", []),
                "entry_id": entry.get("entry_id", str(uuid.uuid4())),
                "device_uuid_enc": self._encrypt_field(entry.get("device_uuid", "")),
                "end_device_uuid_enc": self._encrypt_field(entry.get("end_device_uuid", "")),
            }
            if entry.get("comment") is not None:
                data["comment"] = entry["comment"]

            entry_hash = hashlib.sha256(
                json.dumps(data, sort_keys=True).encode()
            ).hexdigest()

            raw.append({
                "hash": entry.get("hash", entry_hash),
                "data": data,
                "start_epoch": entry.get("start_epoch", 0),
            })

        self._store.write_entries(raw)

    # ------------------------------------------------------------------
    # CRUD operations
    # ------------------------------------------------------------------

    def append(self, title: str, start_epoch: int, *,
               end_epoch: Optional[int] = None,
               metadata: Optional[Dict[str, Any]] = None,
               is_active: bool = False,
               tags: Optional[List[str]] = None,
               comment: Optional[str] = None,
               media: Optional[List[Dict[str, Any]]] = None,
               device_uuid: Optional[str] = None) -> str:
        """Append a new staging entry. Returns the entry hash prefix (10 chars).

        Raises:
            ValueError: If a collision is detected (same start_epoch).
        """
        raw = self._store.read_entries()

        # Collision check
        for entry in raw:
            if entry.get("start_epoch") == start_epoch:
                raise ValueError(
                    "Collision detected: A task has already started "
                    "at this millisecond."
                )

        # Normalize tags
        normalized_tags = self._normalize_tags(tags)

        data = {
            "title": title,
            "duration": (end_epoch - start_epoch) if end_epoch else 0,
            "is_active": is_active,
            "is_paused": False,
            "startTime_enc": self._encrypt_field(start_epoch),
            "endTime_enc": self._encrypt_field(end_epoch) if end_epoch else None,
            "pauses_enc": self._encrypt_field(json.dumps([])),
            "metadata_enc": self._encrypt_field(json.dumps(metadata or {})),
            "tags": normalized_tags,
            "media": media if media is not None else [],
            "entry_id": str(uuid.uuid4()),
            "device_uuid_enc": self._encrypt_field(device_uuid or ""),
        }
        if comment is not None:
            data["comment"] = comment

        entry_hash = hashlib.sha256(
            json.dumps(data, sort_keys=True).encode()
        ).hexdigest()

        raw.append({
            "hash": entry_hash,
            "data": data,
            "start_epoch": start_epoch,
        })
        self._store.write_entries(raw)
        return entry_hash[:10]

    def update(self, index: int, fields: Dict[str, Any]):
        """Update specific fields on an entry at *index*.

        Fields that end with ``_epoch`` are encrypted before storage.
        The entry hash is recomputed after modifications.

        Args:
            index: Entry index in the staging array.
            fields: Dict of field names to new values.

        Raises:
            IndexError: If *index* is out of range.
        """
        raw = self._store.read_entries()
        if index < 0 or index >= len(raw):
            raise IndexError(f"No staged entry at index {index}.")

        data = raw[index]["data"]

        # Map epoch fields to encrypted storage fields
        field_mapping = {
            "start_epoch": "startTime_enc",
            "end_epoch": "endTime_enc",
            "end_device_uuid": "end_device_uuid_enc",
        }

        for field_key, field_value in fields.items():
            if field_key in field_mapping:
                storage_key = field_mapping[field_key]
                if field_value is not None:
                    data[storage_key] = self._encrypt_field(field_value)
                else:
                    data[storage_key] = None
            elif field_key == "pauses":
                data["pauses_enc"] = self._encrypt_field(json.dumps(field_value))
            elif field_key == "metadata":
                data["metadata_enc"] = self._encrypt_field(json.dumps(field_value))
            elif field_key == "tags":
                data["tags"] = self._normalize_tags(field_value)
            else:
                # Direct update for simple fields (adds new keys if needed)
                data[field_key] = field_value

        # Recompute hash
        raw[index]["hash"] = hashlib.sha256(
            json.dumps(data, sort_keys=True).encode()
        ).hexdigest()

        self._store.write_entries(raw)

    def delete(self, index: int):
        """Remove entry at *index*.

        Raises:
            IndexError: If *index* is out of range.
        """
        raw = self._store.read_entries()
        if index < 0 or index >= len(raw):
            raise IndexError(f"No staged entry at index {index}.")
        raw.pop(index)
        self._store.write_entries(raw)

    def remove_multiple(self, indices: List[int]):
        """Remove entries at the specified indices (staging-level).

        Args:
            indices: List of staging-level indices to remove.
        """
        self._store.remove_entries(indices)

    # ------------------------------------------------------------------
    # Pause management
    # ------------------------------------------------------------------

    def add_pause(self, index: int, pause_epoch: int, comment: Optional[str] = None):
        """Add a new pause record to the entry at *index*.

        The pause is opened (``pause_stop`` is None).

        Raises:
            IndexError: If *index* is out of range.
        """
        raw = self._store.read_entries()
        if index < 0 or index >= len(raw):
            raise IndexError(f"No staged entry at index {index}.")

        data = raw[index]["data"]
        pauses_enc = data.get("pauses_enc", self._encrypt_field(json.dumps([])))
        pauses = json.loads(self._from_plain(pauses_enc) or "[]")

        next_index = len(pauses) + 1
        pause_record = {
            "pause_index": next_index,
            "pause_start": pause_epoch,
            "pause_stop": None,
        }
        if comment is not None:
            pause_record["comment"] = comment
        pauses.append(pause_record)

        data["pauses_enc"] = self._encrypt_field(json.dumps(pauses))
        data["is_paused"] = True

        # Recompute hash
        raw[index]["hash"] = hashlib.sha256(
            json.dumps(data, sort_keys=True).encode()
        ).hexdigest()
        self._store.write_entries(raw)

    def close_pause(self, index: int, stop_epoch: int, comment: Optional[str] = None):
        """Close the last open pause record on the entry at *index*.

        Raises:
            IndexError: If *index* is out of range.
        """
        raw = self._store.read_entries()
        if index < 0 or index >= len(raw):
            raise IndexError(f"No staged entry at index {index}.")

        data = raw[index]["data"]
        pauses_enc = data.get("pauses_enc", self._encrypt_field(json.dumps([])))
        pauses = json.loads(self._from_plain(pauses_enc) or "[]")

        if pauses and pauses[-1].get("pause_stop") is None:
            pauses[-1]["pause_stop"] = stop_epoch
            if comment is not None:
                pauses[-1]["comment"] = comment

        data["pauses_enc"] = self._encrypt_field(json.dumps(pauses))
        data["is_paused"] = False

        # Recompute hash
        raw[index]["hash"] = hashlib.sha256(
            json.dumps(data, sort_keys=True).encode()
        ).hexdigest()
        self._store.write_entries(raw)

    # ------------------------------------------------------------------
    # Duration computation
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_duration(
        start_epoch: int,
        end_epoch: Optional[int],
        pauses: List[Dict[str, Any]],
    ) -> int:
        """Compute active duration as wall time minus all completed pause intervals.

        ``pauses`` is a list of ``{"pause_start": ..., "pause_stop": ...}`` dicts.
        Intervals with ``pause_stop=None`` (ongoing pause) are skipped.

        Returns:
            Duration in milliseconds (0 if end_epoch is None).
        """
        if end_epoch is None:
            return 0
        total_pause_ms = 0
        for p in pauses:
            if p.get("pause_stop") is not None:
                total_pause_ms += p["pause_stop"] - p["pause_start"]
        return max(0, (end_epoch - start_epoch) - total_pause_ms)

    # ------------------------------------------------------------------
    # Tag normalization
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_tags(tags: Optional[List[str]]) -> List[str]:
        """Normalize tags: lowercase, strip, dedup, remove empties, sort."""
        if not tags:
            return []
        seen = set()
        result = []
        for t in tags:
            clean = t.strip().lower()
            if clean and clean not in seen:
                seen.add(clean)
                result.append(clean)
        result.sort()
        return result
