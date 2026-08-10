"""Canonical row ↔ DTO conversion primitives (PHPSPEC §8).

These are the pure-Python counterparts of the Web ``dtoToCanonicalRow`` /
``canonicalRowToDTO`` / ``_deriveStatusFromDTO`` helpers. They bridge the
DTO world (flat fields: title, start_epoch, is_active, …) used by
``LocalStagingCache`` and the canonical-row world
(``{activity_id, activity_status, activity, updated_at, committed}``)
used by the row-level sync-gate (CCS-3).

Pure functions — no I/O, no side effects, no dependencies beyond builtins.
"""

import json
import time
from typing import Dict, Any, Optional


def _derive_status_from_dto(dto: Dict[str, Any]) -> str:
    """Derive ``activity_status`` from a legacy staging DTO's flags.

    Rule (matches Web ``_deriveStatusFromDTO``):
      is_active === false  → 'ended'
      is_paused === true   → 'paused'
      otherwise            → 'active'
    """
    if dto is None:
        return "active"
    if dto.get("is_active") is False:
        return "ended"
    if dto.get("is_paused"):
        return "paused"
    return "active"


def dtoToCanonicalRow(
    dto: Optional[Dict[str, Any]],
    device_id: Optional[str] = None,
    now: Optional[int] = None,
) -> Dict[str, Any]:
    """Convert a legacy staging DTO to a canonical staging row.

    Canonical rows store activity data as a JSON string under the ``activity``
    key (PHPSPEC §8). ``activity_id`` falls back to ``entry_id``.

    Args:
        dto: Flat DTO dict (title, start_epoch, end_epoch, duration, is_active…).
            ``None``/``{}`` is safe (produces empty ``activity_id``, no crash).
        device_id: Fallback device UUID when the DTO has no ``device_uuid``.
        now: Fallback timestamp (epoch ms) for ``updated_at`` when the DTO
            has none. Defaults to ``time.time()``.

    Returns:
        Canonical row dict.
    """
    if dto is None:
        dto = {}
    if now is None:
        now = int(time.time() * 1000)
    device_id = device_id or ""

    activity = {
        "title": dto.get("title") or "",
        "start_epoch": dto.get("start_epoch") if dto.get("start_epoch") is not None else 0,
        "end_epoch": dto.get("end_epoch") if dto.get("end_epoch") is not None else None,
        "duration": dto.get("duration") or 0,
        "tags": dto.get("tags") or [],
        "comment": dto.get("comment"),
        "media": dto.get("media") or [],
        "entry_id": dto.get("entry_id") or "",
        "is_active": dto.get("is_active") if dto.get("is_active") is not None else False,
        "is_paused": dto.get("is_paused") if dto.get("is_paused") is not None else False,
        "pauses": dto.get("pauses") or [],
        "metadata": dto.get("metadata") if isinstance(dto.get("metadata"), dict) else {},
        "device_uuid": dto.get("device_uuid") or device_id,
        "end_device_uuid": dto.get("end_device_uuid") or "",
        "block_index": dto.get("block_index"),
    }

    return {
        "activity_id": dto.get("activity_id") or dto.get("entry_id") or "",
        "activity_status": _derive_status_from_dto(dto),
        "activity": json.dumps(activity),
        "updated_at": dto.get("updated_at") if dto.get("updated_at") is not None else now,
        "committed": dto.get("committed") or False,
    }


def canonicalRowToDTO(row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Convert a canonical staging row back to a flat DTO.

    Parses the ``activity`` JSON string; on malformed content a safe DTO is
    returned (``title == ""``, ``start_epoch == 0``) rather than raising.

    Args:
        row: Canonical row dict.

    Returns:
        Flat DTO dict.
    """
    if row is None:
        row = {}
    row = dict(row)

    activity_raw = row.get("activity")
    activity: Any = {}
    if isinstance(activity_raw, str):
        try:
            activity = json.loads(activity_raw)
        except (json.JSONDecodeError, TypeError):
            activity = {}
    elif isinstance(activity_raw, dict):
        activity = activity_raw
    if not isinstance(activity, dict):
        activity = {}

    activity_id = row.get("activity_id") or row.get("entry_id") or ""
    status = row.get("activity_status") or "active"

    start_epoch = activity.get("start_epoch")
    if start_epoch is None:
        start_epoch = 0
    try:
        start_epoch = int(start_epoch)
    except (TypeError, ValueError):
        start_epoch = 0

    try:
        date_str = time.strftime(
            "%Y-%m-%d", time.gmtime(start_epoch // 1000)
        )
    except (OSError, OverflowError, ValueError):
        date_str = "1970-01-01"

    entry_id = activity.get("entry_id") or activity_id

    return {
        "activity_id": activity_id,
        "entry_id": entry_id,
        "title": activity.get("title") or "",
        "start_epoch": start_epoch,
        "end_epoch": activity.get("end_epoch"),
        "duration": activity.get("duration") or 0,
        "is_active": status != "ended",
        "is_paused": status == "paused",
        "pauses": activity.get("pauses") or [],
        "tags": activity.get("tags") or [],
        "comment": activity.get("comment"),
        "media": activity.get("media") or [],
        "metadata": activity.get("metadata") if isinstance(activity.get("metadata"), dict) else {},
        "device_uuid": activity.get("device_uuid") or "",
        "end_device_uuid": activity.get("end_device_uuid") or "",
        "block_index": activity.get("block_index"),
        "activity": json.dumps(activity),
        "committed": row.get("committed") or False,
        "updated_at": row.get("updated_at") if row.get("updated_at") is not None else 0,
        "date": date_str,
        "source": "remote",
        "hash": "",
    }
