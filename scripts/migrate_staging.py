"""One-shot migration: staging.json → staging.db (SQLite).

Reads the monolithic staging.json blob, extracts individual entries,
maps them to the row-based SQLite schema, and writes them to a new
staging.db file. The original staging.json is renamed to
staging.json.migrated as a backup.

Per ROW_LEVEL_STAGING_SYNC_PLAN.md §"Migration" (CLI section):
  1. Detect staging.json exists
  2. Read entries via FileStagingStore pattern
  3. For each entry, generate activity_id if missing, derive status
  4. Create SQLite DB with migrated rows
  5. Rename staging.json → staging.json.migrated

Usage:
  from scripts.migrate_staging import migrate_staging_to_sqlite
  result = migrate_staging_to_sqlite("/path/to/staging.json", "/path/to/staging.db")
"""

import json
import os
import secrets
import sqlite3
import string
import time
from pathlib import Path
from typing import Any, Dict

from storage.implementations.sqlite_staging import SqliteStagingStore


_ID_ALPHABET = string.ascii_letters + string.digits
_ID_LENGTH = 10


def _generate_activity_id() -> str:
    """Generate a cryptographically random 10-char alphanumeric activity_id."""
    return ''.join(secrets.choice(_ID_ALPHABET) for _ in range(_ID_LENGTH))


def _derive_status(entry: Dict[str, Any]) -> str:
    """Derive activity_status from legacy is_active / is_paused flags."""
    is_active = entry.get("is_active", False)
    is_paused = entry.get("is_paused", False)

    if is_paused:
        return "paused"
    elif is_active and not is_paused:
        return "active"
    else:
        return "ended"


def migrate_staging_to_sqlite(staging_json_path: str, db_path: str) -> Dict[str, Any]:
    """Migrate entries from a legacy staging.json into a SQLite staging database.

    Idempotent: if staging.db already exists and contains rows, the migration
    is skipped to prevent duplicates. The original staging.json is renamed to
    staging.json.migrated upon successful migration.

    Args:
        staging_json_path: Path to the existing staging.json file.
        db_path: Path where the new staging.db should be created.

    Returns:
        Dict with keys:
            migrated (int): Number of entries successfully migrated.
            skipped (int): Number of entries skipped (corrupt or missing data).
            message (str): Human-readable summary.
    """
    staging_json_path = Path(staging_json_path)
    db_path = Path(db_path)

    # ── Idempotency check ──
    if db_path.exists():
        try:
            conn = sqlite3.connect(str(db_path))
            count = conn.execute("SELECT COUNT(*) FROM staging").fetchone()[0]
            conn.close()
            if count > 0:
                return {
                    "migrated": 0,
                    "skipped": 0,
                    "message": "Already migrated — staging.db exists with rows",
                }
        except (sqlite3.DatabaseError, sqlite3.Error):
            # Corrupt or empty — fall through and re-create
            pass

    # ── Source check ──
    if not staging_json_path.exists():
        return {
            "migrated": 0,
            "skipped": 0,
            "message": "No staging.json found at path",
        }

    # ── Read staging.json entries ──
    try:
        raw = json.loads(staging_json_path.read_text())
        entries = raw.get("entries", [])
    except (json.JSONDecodeError, OSError) as e:
        return {
            "migrated": 0,
            "skipped": 0,
            "message": f"Failed to read staging.json: {e}",
        }

    # ── Determine updated_at from file modification time ──
    try:
        file_mtime = int(staging_json_path.stat().st_mtime * 1000)
    except OSError:
        file_mtime = int(time.time() * 1000)

    # ── Migrate each entry ──
    store = SqliteStagingStore(str(db_path))
    migrated = 0
    skipped = 0

    for entry in entries:
        try:
            # Skip entries missing the data payload
            if "data" not in entry:
                skipped += 1
                continue

            data = entry["data"]

            # Determine activity_id
            activity_id = data.get("entry_id") or entry.get("entry_id")
            if not activity_id:
                activity_id = _generate_activity_id()

            # Derive activity_status
            status = _derive_status(entry)

            # Serialize data dict to JSON string for the activity column
            activity_blob = json.dumps(data) if not isinstance(data, str) else data

            row = {
                "activity_id": activity_id,
                "activity_status": status,
                "activity": activity_blob,
                "updated_at": file_mtime,
            }
            store.put_row(row)
            migrated += 1

        except (ValueError, KeyError, TypeError,
                sqlite3.DatabaseError, OSError):
            skipped += 1

    store.close()

    # ── Rename original to backup ──
    backup_path = staging_json_path.with_suffix(".json.migrated")
    staging_json_path.rename(backup_path)

    return {
        "migrated": migrated,
        "skipped": skipped,
        "message": f"Migrated {migrated} entries, skipped {skipped}",
    }
