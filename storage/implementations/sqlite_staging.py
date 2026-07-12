"""SQLite-backed implementation of AbstractStagingStore with row-level operations.

Replaces the single-blob staging.json with a row-per-activity SQLite database.
Implements both AbstractStagingStore (position-based ops) and row-level operations
for the new LWW sync model.

Schema:
  CREATE TABLE staging (
    activity_id TEXT PRIMARY KEY,
    activity_status TEXT NOT NULL,
    activity TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    _extra TEXT NOT NULL DEFAULT '{}'
  )

The _extra column stores additional forward-compat fields as JSON.
"""

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from storage.staging_store import AbstractStagingStore


class SqliteStagingStore(AbstractStagingStore):
    """Staging store backed by a SQLite database.

    Implements AbstractStagingStore for backward compatibility and
    provides row-level operations (get_row, put_row, delete_row,
    get_all_rows, get_rows_by_status, count) for the new sync model.
    """

    CORE_FIELDS = {"activity_id", "activity_status", "activity", "updated_at"}

    def __init__(self, db_path):
        if not isinstance(db_path, (str, Path)):
            raise TypeError(
                f"SqliteStagingStore requires str or Path, got {type(db_path).__name__}"
            )
        self.db_path = str(db_path)
        self._conn: Optional[sqlite3.Connection] = None
        self._init_db()

    # ── Lifecycle ──────────────────────────────────────────────────

    def _init_db(self):
        """Create database file, parent dirs, and schema."""
        if self.db_path != ":memory:":
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS staging (
                activity_id TEXT PRIMARY KEY,
                activity_status TEXT NOT NULL,
                activity TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT 0,
                _extra TEXT NOT NULL DEFAULT '{}'
            )
        """)
        self._conn.commit()

    @property
    def _db(self) -> sqlite3.Connection:
        return self._conn

    def close(self):
        """Release the database connection."""
        if self._conn:
            self._conn.close()
            self._conn = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
        return False

    # ── AbstractStagingStore interface (position-based) ─────────────

    def read_entries(self) -> List[Dict[str, Any]]:
        """Read all staged entries sorted by activity_id."""
        rows = self._db.execute(
            "SELECT * FROM staging ORDER BY activity_id"
        ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def write_entries(self, data: List[Dict[str, Any]]):
        """Atomically replace all entries with the given list."""
        if not isinstance(data, list):
            raise TypeError(
                f"write_entries expects a list, got {type(data).__name__}"
            )
        try:
            self._db.execute("BEGIN")
            self._db.execute("DELETE FROM staging")
            for entry in data:
                self._insert_row_in_tx(entry)
            self._db.execute("COMMIT")
        except Exception:
            self._db.execute("ROLLBACK")
            raise

    def append_entry(self, entry: Dict[str, Any]):
        """Append a single entry to the staging table."""
        self._insert_row(entry)

    def update_entry(self, index: int, fields: Dict[str, Any]):
        """Merge fields into the entry at the given position index."""
        if not fields:
            return
        entries = self.read_entries()
        if 0 <= index < len(entries):
            activity_id = entries[index]["activity_id"]
            merged = {**entries[index], **fields,
                       "updated_at": self._now_ms()}
            self._update_row(activity_id, merged)

    def remove_entries(self, indices: List[int]):
        """Remove entries by position index (descending order)."""
        if not indices:
            return
        entries = self.read_entries()
        for idx in sorted(indices, reverse=True):
            if 0 <= idx < len(entries):
                activity_id = entries[idx]["activity_id"]
                self._db.execute(
                    "DELETE FROM staging WHERE activity_id = ?",
                    (activity_id,)
                )
        self._db.commit()

    # ── Row-level operations ───────────────────────────────────────

    def get_row(self, activity_id: str) -> Optional[Dict[str, Any]]:
        """Get a single row by activity_id, or None if not found."""
        row = self._db.execute(
            "SELECT * FROM staging WHERE activity_id = ?",
            (activity_id,)
        ).fetchone()
        return self._row_to_dict(row) if row else None

    def put_row(self, row: Dict[str, Any]):
        """Insert or upsert a row. Auto-sets updated_at if absent."""
        entry = dict(row)
        if "updated_at" not in entry:
            entry["updated_at"] = self._now_ms()
        self._upsert_row(entry["activity_id"], entry)

    def delete_row(self, activity_id: str):
        """Delete a row by activity_id. Idempotent."""
        self._db.execute(
            "DELETE FROM staging WHERE activity_id = ?",
            (activity_id,)
        )
        self._db.commit()

    def get_all_rows(self) -> List[Dict[str, Any]]:
        """Return all rows sorted by activity_id (same as read_entries)."""
        return self.read_entries()

    def count(self) -> int:
        """Return the number of rows in staging."""
        row = self._db.execute("SELECT COUNT(*) FROM staging").fetchone()
        return row[0]

    def get_rows_by_status(self, status: str) -> List[Dict[str, Any]]:
        """Return rows filtered by activity_status, sorted by activity_id."""
        rows = self._db.execute(
            "SELECT * FROM staging WHERE activity_status = ? ORDER BY activity_id",
            (status,)
        ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    # ── Internal helpers ───────────────────────────────────────────

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    @classmethod
    def _split_entry(cls, entry: Dict[str, Any]) -> tuple:
        """Split an entry dict into (core_fields, extra_fields)."""
        core = {}
        extra = {}
        for k, v in entry.items():
            if k in cls.CORE_FIELDS:
                core[k] = v
            else:
                extra[k] = v
        return core, extra

    def _normalize_core(self, core: Dict[str, Any]) -> Dict[str, Any]:
        """Fill in defaults for missing core fields. Returns a new dict."""
        normalized = dict(core)
        if "activity_id" not in normalized:
            raise ValueError("Missing required field: activity_id")
        normalized.setdefault("updated_at", self._now_ms())
        normalized.setdefault("activity_status", "staged")
        normalized.setdefault("activity", "{}")
        return normalized

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
        """Convert a sqlite3.Row to a dict, unpacking _extra JSON."""
        d = dict(row)
        extra_raw = d.pop("_extra", "{}")
        try:
            extra = json.loads(extra_raw)
        except (json.JSONDecodeError, TypeError):
            extra = {}
        d.update(extra)
        return d

    def _insert_row(self, entry: Dict[str, Any]):
        """Insert a single row (commits immediately)."""
        self._insert_row_in_tx(entry)
        self._db.commit()

    def _insert_row_in_tx(self, entry: Dict[str, Any]):
        """Insert a single row within an existing transaction."""
        core, extra = self._split_entry(entry)
        core = self._normalize_core(core)
        self._db.execute(
            "INSERT INTO staging (activity_id, activity_status, activity, updated_at, _extra) "
            "VALUES (?, ?, ?, ?, ?)",
            (core["activity_id"], core["activity_status"], core["activity"],
             core["updated_at"], json.dumps(extra))
        )

    def _update_row(self, activity_id: str, entry: Dict[str, Any]):
        """Update an existing row by activity_id."""
        core, extra = self._split_entry(entry)
        core = self._normalize_core(core)
        self._db.execute(
            "UPDATE staging SET activity_status = ?, activity = ?, "
            "updated_at = ?, _extra = ? WHERE activity_id = ?",
            (core["activity_status"], core["activity"],
             core["updated_at"], json.dumps(extra), activity_id)
        )
        self._db.commit()

    def _upsert_row(self, activity_id: str, entry: Dict[str, Any]):
        """Insert or replace a row by activity_id."""
        core, extra = self._split_entry(entry)
        core = self._normalize_core(core)
        self._db.execute(
            "INSERT OR REPLACE INTO staging "
            "(activity_id, activity_status, activity, updated_at, _extra) "
            "VALUES (?, ?, ?, ?, ?)",
            (core["activity_id"], core["activity_status"], core["activity"],
             core["updated_at"], json.dumps(extra))
        )
        self._db.commit()
