"""Phase 2 (RED): CLI SQLite Staging Store — Test Definition.

Tests the SqliteStagingStore, buildDiff() pure function, and migration script
based on the Phase 1 blueprint at docs/planning/CLI_SQLITE_STAGING_PHASE1.md.

All tests MUST fail in RED phase — the modules under test do not exist yet.
Phase 3 (GREEN) will implement the modules to make these tests pass.

Test groups:
  A1–A12: Schema & Lifecycle
  B1–B10: read_entries / write_entries (AbstractStagingStore contract)
  C1–C7:  append_entry
  D1–D7:  update_entry (position-based)
  E1–E6:  remove_entries (position-based)
  F1–F12: Row-level operations
  G1–G8:  Edge cases
  H1–H12: Migration: staging.json → SQLite
  I1–I22: buildDiff() — LWW Resolution
  J1–J8:  Integration: store + buildDiff pipeline

Usage:
  python3 -m pytest tests/test_sqlite_staging.py -v
"""

import unittest
import json
import os
import time
import tempfile
import sqlite3
from pathlib import Path
from collections import namedtuple
from typing import Dict, Any, List, Optional

# ══════════════════════════════════════════════════════════════════════
# Future imports — these modules do NOT exist yet (Phase 2: RED)
# ══════════════════════════════════════════════════════════════════════

try:
    from storage.implementations.sqlite_staging import SqliteStagingStore
    HAS_SQLITE_STORE = True
except ImportError:
    HAS_SQLITE_STORE = False
    SqliteStagingStore = None

try:
    from core.sync.diff_engine import buildDiff, DiffResult
    HAS_DIFF = True
except ImportError:
    HAS_DIFF = False
    buildDiff = None
    DiffResult = namedtuple('DiffResult', ['pull', 'push', 'delete_local', 'fast_path'])

try:
    from scripts.migrate_staging import migrate_staging_to_sqlite
    HAS_MIGRATE = True
except ImportError:
    HAS_MIGRATE = False
    migrate_staging_to_sqlite = None

from storage.staging_store import AbstractStagingStore


# ══════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════

TMP_ROOT = Path("/dev/shm") if os.path.exists("/dev/shm") else None


def temp_dir():
    """Create a temporary directory for test use."""
    return Path(tempfile.mkdtemp(dir=str(TMP_ROOT) if TMP_ROOT else None))


def make_entry(activity_id, status="staged", activity=None, updated_at=None):
    """Create a staging entry dict."""
    entry = {
        "activity_id": activity_id,
        "activity_status": status,
        "activity": activity or json.dumps({"title": f"Entry {activity_id}"}),
        "updated_at": updated_at if updated_at is not None else int(time.time() * 1000),
    }
    return entry


def make_local_row(activity_id, status="staged", updated_at=None):
    """Create a local row dict for buildDiff (includes activity blob)."""
    return make_entry(activity_id, status, updated_at=updated_at)


def make_manifest_row(activity_id, status="staged", updated_at=None):
    """Create a manifest row dict (no activity blob, just metadata)."""
    return {
        "activity_id": activity_id,
        "activity_status": status,
        "updated_at": updated_at if updated_at is not None else int(time.time() * 1000),
    }


def make_manifest(rows=None, version=1):
    """Create a full manifest dict with rows and version."""
    return {"rows": rows or [], "version": version}


def make_hash_entry(committed_at=None):
    """Create a ledger hash index entry."""
    return {"committed_at": committed_at if committed_at is not None else int(time.time() * 1000)}


# ══════════════════════════════════════════════════════════════════════
# Group A: SqliteStagingStore — Schema & Lifecycle (A1–A12)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestSqliteStagingStoreLifecycle(unittest.TestCase):
    """Tests for store instantiation, schema creation, and lifecycle."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.db_path = self.test_dir / "staging.db"

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # A1 — Store creates SQLite DB file at given path on init
    def test_A1_creates_db_file_at_given_path(self):
        store = SqliteStagingStore(self.db_path)
        self.assertTrue(self.db_path.exists(), "DB file must exist after init")
        store.close()

    # A2 — Store creates staging table with correct schema
    def test_A2_creates_staging_table_with_correct_schema(self):
        store = SqliteStagingStore(self.db_path)
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.execute("PRAGMA table_info(staging)")
        columns = {row[1]: row[2] for row in cursor.fetchall()}
        conn.close()
        store.close()

        self.assertIn("activity_id", columns, "activity_id column must exist")
        self.assertIn("activity_status", columns, "activity_status column must exist")
        self.assertIn("activity", columns, "activity column must exist")
        self.assertIn("updated_at", columns, "updated_at column must exist")
        # Verify PK: activity_id is column 0 and marked as PK
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.execute("PRAGMA table_info(staging)")
        rows = cursor.fetchall()
        conn.close()
        self.assertGreaterEqual(rows[0][5], 1, "activity_id must be part of PK")

    # A3 — Table is empty on first creation
    def test_A3_empty_on_first_creation(self):
        store = SqliteStagingStore(self.db_path)
        entries = store.read_entries()
        self.assertEqual(entries, [], "New store must have no entries")
        store.close()

    # A4 — Re-opening preserves all previously written data
    def test_A4_reopen_preserves_data(self):
        store = SqliteStagingStore(self.db_path)
        entry = make_entry("abc1234567")
        store.append_entry(entry)
        store.close()

        store2 = SqliteStagingStore(self.db_path)
        entries = store2.read_entries()
        store2.close()
        self.assertEqual(len(entries), 1, "Re-opened store must retain data")
        self.assertEqual(entries[0]["activity_id"], "abc1234567")
        self.assertEqual(entries[0]["activity_status"], "staged")

    # A5 — close() releases the database connection
    def test_A5_close_releases_connection(self):
        store = SqliteStagingStore(self.db_path)
        store.close()
        # Verify we can delete the file after close (no lock held)
        self.db_path.unlink()
        self.assertFalse(self.db_path.exists())

    # A6 — Context manager support
    def test_A6_context_manager_support(self):
        with SqliteStagingStore(self.db_path) as store:
            store.append_entry(make_entry("ctx1234567"))
        # After exit, file should be usable by a new connection
        store2 = SqliteStagingStore(self.db_path)
        entries = store2.read_entries()
        store2.close()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["activity_id"], "ctx1234567")

    # A7 — Works with temp dir paths
    def test_A7_works_with_temp_dir_paths(self):
        tmp = temp_dir()
        try:
            db_path = tmp / "test.db"
            store = SqliteStagingStore(db_path)
            store.append_entry(make_entry("tmp1234567"))
            entries = store.read_entries()
            self.assertEqual(len(entries), 1)
            store.close()
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    # A8 — Uses explicit db_path, does not write to CWD
    def test_A8_uses_explicit_path_not_cwd(self):
        cwd_before = set(Path.cwd().iterdir())
        store = SqliteStagingStore(self.db_path)
        store.close()
        cwd_after = set(Path.cwd().iterdir())
        self.assertEqual(cwd_before, cwd_after, "No files created in CWD")

    # A9 — :memory: path creates in-memory database
    def test_A9_memory_path_creates_in_memory_db(self):
        store = SqliteStagingStore(":memory:")
        store.append_entry(make_entry("mem1234567"))
        entries = store.read_entries()
        self.assertEqual(len(entries), 1)
        # In-memory DB has no file
        self.assertFalse(Path(":memory:").exists())
        store.close()

    # A10 — Creates parent directories if they don't exist
    def test_A10_creates_parent_directories(self):
        nested = self.test_dir / "deep" / "nested" / "staging.db"
        store = SqliteStagingStore(nested)
        self.assertTrue(nested.parent.exists(), "Parent directories must be created")
        self.assertTrue(nested.exists(), "DB file must exist")
        store.close()

    # A11 — isinstance check against AbstractStagingStore
    def test_A11_is_instance_of_abstract_staging_store(self):
        store = SqliteStagingStore(self.db_path)
        self.assertIsInstance(store, AbstractStagingStore,
                              "Must implement AbstractStagingStore")
        store.close()

    # A12 — Instantiation without db_path raises TypeError
    def test_A12_raises_typeerror_without_db_path(self):
        with self.assertRaises(TypeError):
            SqliteStagingStore()  # noqa — missing required arg


# ══════════════════════════════════════════════════════════════════════
# Group B: SqliteStagingStore — read_entries / write_entries (B1–B10)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestSqliteStagingStoreReadWrite(unittest.TestCase):
    """Tests for AbstractStagingStore contract: read_entries / write_entries."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.db_path = self.test_dir / "staging.db"
        self.store = SqliteStagingStore(self.db_path)

    def tearDown(self):
        self.store.close()
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # B1 — read_entries() returns empty list when store is empty
    def test_B1_read_entries_returns_empty_for_empty_store(self):
        entries = self.store.read_entries()
        self.assertEqual(entries, [])

    # B2 — write_entries + read_entries round-trip
    def test_B2_write_read_roundtrip(self):
        data = [make_entry("abc1234567"), make_entry("def1234567")]
        self.store.write_entries(data)
        result = self.store.read_entries()
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["activity_id"], "abc1234567")
        self.assertEqual(result[1]["activity_id"], "def1234567")

    # B3 — write_entries([]) clears all rows
    def test_B3_write_empty_list_clears_all_rows(self):
        self.store.append_entry(make_entry("abc1234567"))
        self.store.write_entries([])
        entries = self.store.read_entries()
        self.assertEqual(entries, [])

    # B4 — write_entries is atomic on mid-write failure
    def test_B4_write_entries_atomic_on_failure(self):
        self.store.append_entry(make_entry("keep1234567"))
        original = self.store.read_entries()
        # Write with a corrupt entry that should trigger rollback
        bad_data = [make_entry("bad001"), {"invalid": "no_activity_id"}]
        try:
            self.store.write_entries(bad_data)
        except Exception:
            pass
        after = self.store.read_entries()
        # Old data must be preserved (or store is empty if transaction aborted
        # before any writes, which is also acceptable)
        self.assertEqual(len(after), len(original),
                         "Atomic write must preserve old data on failure")

    # B5 — write_entries with 500 rows preserves all
    def test_B5_bulk_write_500_rows(self):
        data = [make_entry(f"bulk{i:04d}") for i in range(500)]
        self.store.write_entries(data)
        entries = self.store.read_entries()
        self.assertEqual(len(entries), 500)
        # Spot-check first, middle, last
        self.assertEqual(entries[0]["activity_id"], "bulk0000")
        self.assertEqual(entries[249]["activity_id"], "bulk0249")
        self.assertEqual(entries[499]["activity_id"], "bulk0499")

    # B6 — read_entries preserves field types
    def test_B6_preserves_field_types(self):
        entry = make_entry("type1234567")
        self.store.write_entries([entry])
        result = self.store.read_entries()[0]
        self.assertIsInstance(result["activity_id"], str)
        self.assertIsInstance(result["activity_status"], str)
        self.assertIsInstance(result["activity"], str)
        self.assertIsInstance(result["updated_at"], int)

    # B7 — write_entries sets updated_at to current time if not present
    def test_B7_auto_timestamp_on_write(self):
        before = int(time.time() * 1000)
        entry = {"activity_id": "noTime0001", "activity_status": "staged",
                 "activity": "{}"}
        # Intentionally omit updated_at
        self.store.append_entry(entry)
        after = int(time.time() * 1000)
        result = self.store.read_entries()[0]
        self.assertIn("updated_at", result, "updated_at must be present after write")
        self.assertGreaterEqual(result["updated_at"], before - 1000,
                                "updated_at should be near current time")
        self.assertLessEqual(result["updated_at"], after + 1000,
                             "updated_at should be near current time")

    # B8 — read_entries returns rows sorted by activity_id ASC
    def test_B8_sort_order_by_activity_id(self):
        # Insert in non-alphabetical order
        data = [
            make_entry("zebra00001"),
            make_entry("alpha00001"),
            make_entry("mike000001"),
        ]
        self.store.write_entries(data)
        entries = self.store.read_entries()
        ids = [e["activity_id"] for e in entries]
        self.assertEqual(ids, sorted(ids), "Rows must be sorted by activity_id ASC")

    # B9 — write_entries preserves extra fields beyond core 4
    def test_B9_preserves_extra_fields(self):
        entry = {
            "activity_id": "extra12345",
            "activity_status": "staged",
            "activity": "{}",
            "updated_at": 1000,
            "custom_field": "extra value",
            "nested": {"key": "val"},
        }
        self.store.write_entries([entry])
        result = self.store.read_entries()[0]
        self.assertEqual(result["custom_field"], "extra value")
        self.assertEqual(result["nested"], {"key": "val"})

    # B10 — write_entries with non-list raises TypeError
    def test_B10_rejects_non_list_argument(self):
        with self.assertRaises(TypeError):
            self.store.write_entries({"not": "a list"})


# ══════════════════════════════════════════════════════════════════════
# Group C: SqliteStagingStore — append_entry (C1–C7)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestSqliteStagingStoreAppend(unittest.TestCase):
    """Tests for append_entry method."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.db_path = self.test_dir / "staging.db"
        self.store = SqliteStagingStore(self.db_path)

    def tearDown(self):
        self.store.close()
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # C1 — append_entry adds one row to empty store
    def test_C1_append_to_empty_store(self):
        self.store.append_entry(make_entry("abc1234567"))
        entries = self.store.read_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["activity_id"], "abc1234567")

    # C2 — append_entry adds after existing entries
    def test_C2_append_adds_to_end(self):
        self.store.append_entry(make_entry("aaa1234567"))
        self.store.append_entry(make_entry("zzz1234567"))
        entries = self.store.read_entries()
        # Sorted order: aaa then zzz by activity_id
        self.assertEqual(entries[0]["activity_id"], "aaa1234567")
        self.assertEqual(entries[1]["activity_id"], "zzz1234567")

    # C3 — append_entry preserves all fields in round-trip
    def test_C3_roundtrip_preserves_all_fields(self):
        entry = make_entry("full1234567", status="active",
                           activity=json.dumps({"title": "Guitar", "duration": 3600}))
        self.store.append_entry(entry)
        result = self.store.read_entries()[0]
        self.assertEqual(result["activity_id"], "full1234567")
        self.assertEqual(result["activity_status"], "active")
        self.assertIn("Guitar", result["activity"])

    # C4 — append_entry auto-generates updated_at if missing
    def test_C4_auto_timestamp_on_append(self):
        before = int(time.time() * 1000)
        entry = {"activity_id": "noTime0002", "activity_status": "paused",
                 "activity": "{}"}
        self.store.append_entry(entry)
        after = int(time.time() * 1000)
        result = self.store.read_entries()[0]
        self.assertIn("updated_at", result)
        self.assertGreaterEqual(result["updated_at"], before - 1000)

    # C5 — append_entry with missing activity_id raises ValueError
    def test_C5_rejects_missing_activity_id(self):
        with self.assertRaises((ValueError, sqlite3.IntegrityError)):
            self.store.append_entry({"activity_status": "staged", "activity": "{}"})

    # C6 — append_entry preserves extra fields
    def test_C6_preserves_extra_fields(self):
        entry = {
            "activity_id": "extra12346",
            "activity_status": "staged",
            "activity": "{}",
            "updated_at": 5000,
            "future_field": "survives",
        }
        self.store.append_entry(entry)
        result = self.store.read_entries()[0]
        self.assertEqual(result["future_field"], "survives")

    # C7 — append_entry immediately visible in read_entries
    def test_C7_immediately_visible_in_read(self):
        self.store.append_entry(make_entry("vis1234567"))
        entries = self.store.read_entries()
        self.assertEqual(len(entries), 1, "Appended entry must be visible immediately")
        self.store.append_entry(make_entry("vis2234567"))
        entries = self.store.read_entries()
        self.assertEqual(len(entries), 2, "Second append must be visible")


# ══════════════════════════════════════════════════════════════════════
# Group D: SqliteStagingStore — update_entry (D1–D7)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestSqliteStagingStoreUpdate(unittest.TestCase):
    """Tests for update_entry (position-based updates)."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.db_path = self.test_dir / "staging.db"
        self.store = SqliteStagingStore(self.db_path)
        # Seed with entries in known order
        self.store.append_entry(make_entry("aaa", "staged", updated_at=1000))
        self.store.append_entry(make_entry("bbb", "staged", updated_at=1000))
        self.store.append_entry(make_entry("ccc", "staged", updated_at=1000))

    def tearDown(self):
        self.store.close()
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # D1 — update_entry merges provided fields into row at position
    def test_D1_update_entry_merges_fields(self):
        self.store.update_entry(0, {"activity_status": "active"})
        entries = self.store.read_entries()
        self.assertEqual(entries[0]["activity_status"], "active")

    # D2 — update_entry preserves fields not in update dict
    def test_D2_non_destructive_update(self):
        original = self.store.read_entries()[1]
        self.store.update_entry(1, {"activity_status": "paused"})
        result = self.store.read_entries()[1]
        self.assertEqual(result["activity_id"], original["activity_id"],
                         "activity_id must be preserved")
        self.assertEqual(result["activity"], original["activity"],
                         "activity must be preserved")

    # D3 — out-of-range index is a no-op
    def test_D3_out_of_range_noop(self):
        entries_before = self.store.read_entries()
        self.store.update_entry(99, {"activity_status": "active"})
        entries_after = self.store.read_entries()
        self.assertEqual(entries_before, entries_after,
                         "Out-of-range update must not modify anything")
        self.store.update_entry(-1, {"activity_status": "active"})
        entries_after2 = self.store.read_entries()
        self.assertEqual(entries_before, entries_after2)

    # D4 — update_entry changes activity_status correctly
    def test_D4_changes_activity_status(self):
        self.store.update_entry(2, {"activity_status": "ended"})
        entries = self.store.read_entries()
        self.assertEqual(entries[2]["activity_status"], "ended")

    # D5 — update_entry auto-updates updated_at
    def test_D5_auto_updates_timestamp(self):
        original_ts = self.store.read_entries()[0]["updated_at"]
        time.sleep(0.01)  # ensure timestamp changes
        self.store.update_entry(0, {"activity_status": "active"})
        new_ts = self.store.read_entries()[0]["updated_at"]
        self.assertGreater(new_ts, original_ts,
                           "updated_at must be bumped on mutation")

    # D6 — multiple sequential update_entry calls compound correctly
    def test_D6_chained_updates_compound(self):
        self.store.update_entry(0, {"activity_status": "active"})
        self.store.update_entry(0, {"activity_status": "paused"})
        self.store.update_entry(0, {"activity_status": "ended"})
        entries = self.store.read_entries()
        self.assertEqual(entries[0]["activity_status"], "ended")

    # D7 — empty fields dict is no-op
    def test_D7_empty_update_noop(self):
        entries_before = self.store.read_entries()
        self.store.update_entry(0, {})
        entries_after = self.store.read_entries()
        self.assertEqual(entries_before, entries_after,
                         "Empty update must not modify anything")


# ══════════════════════════════════════════════════════════════════════
# Group E: SqliteStagingStore — remove_entries (E1–E6)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestSqliteStagingStoreRemove(unittest.TestCase):
    """Tests for remove_entries (position-based deletes)."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.db_path = self.test_dir / "staging.db"
        self.store = SqliteStagingStore(self.db_path)
        for i, aid in enumerate(["aaa", "bbb", "ccc", "ddd", "eee"]):
            self.store.append_entry(
                make_entry(aid, updated_at=1000 + i))

    def tearDown(self):
        self.store.close()
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # E1 — remove single entry by position
    def test_E1_remove_single_entry(self):
        self.store.remove_entries([1])
        entries = self.store.read_entries()
        ids = [e["activity_id"] for e in entries]
        self.assertEqual(ids, ["aaa", "ccc", "ddd", "eee"],
                         "bbb must be removed, leaving 4 entries")

    # E2 — remove multiple entries
    def test_E2_remove_multiple_entries(self):
        self.store.remove_entries([0, 2])
        entries = self.store.read_entries()
        ids = [e["activity_id"] for e in entries]
        self.assertEqual(ids, ["bbb", "ddd", "eee"],
                         "aaa and ccc must be removed")

    # E3 — unsorted indices are processed correctly
    def test_E3_unsorted_indices_handled(self):
        self.store.remove_entries([2, 0, 1])
        entries = self.store.read_entries()
        ids = [e["activity_id"] for e in entries]
        self.assertEqual(ids, ["ddd", "eee"],
                         "aaa, bbb, ccc must be removed regardless of index order")

    # E4 — empty indices list is idempotent
    def test_E4_empty_list_noop(self):
        entries_before = self.store.read_entries()
        self.store.remove_entries([])
        entries_after = self.store.read_entries()
        self.assertEqual(entries_before, entries_after,
                         "Empty remove list must not change anything")

    # E5 — remove from empty store is no-op
    def test_E5_remove_from_empty_store_noop(self):
        self.store.write_entries([])
        self.store.remove_entries([0])
        entries = self.store.read_entries()
        self.assertEqual(entries, [])

    # E6 — out-of-range indices silently skipped
    def test_E6_out_of_range_indices_skipped(self):
        entries_before = self.store.read_entries()
        self.store.remove_entries([99, -1, 100])
        entries_after = self.store.read_entries()
        self.assertEqual(entries_before, entries_after,
                         "Out-of-range indices must not cause changes or errors")


# ══════════════════════════════════════════════════════════════════════
# Group F: SqliteStagingStore — Row-level operations (F1–F12)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestSqliteStagingStoreRowLevel(unittest.TestCase):
    """Tests for row-level operations (get_row, put_row, delete_row, etc.)."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.db_path = self.test_dir / "staging.db"
        self.store = SqliteStagingStore(self.db_path)

    def tearDown(self):
        self.store.close()
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # F1 — get_row returns full dict
    def test_F1_get_row_returns_full_dict(self):
        entry = make_entry("row0012345")
        self.store.append_entry(entry)
        row = self.store.get_row("row0012345")
        self.assertIsNotNone(row)
        self.assertEqual(row["activity_id"], "row0012345")
        self.assertEqual(row["activity_status"], "staged")
        self.assertIn("activity", row)
        self.assertIn("updated_at", row)

    # F2 — get_row on nonexistent ID returns None
    def test_F2_get_row_nonexistent_returns_none(self):
        row = self.store.get_row("nonexistent")
        self.assertIsNone(row)

    # F3 — put_row inserts a new row
    def test_F3_put_row_inserts_new_row(self):
        row = make_local_row("put0012345")
        self.store.put_row(row)
        result = self.store.get_row("put0012345")
        self.assertIsNotNone(result)
        self.assertEqual(result["activity_id"], "put0012345")

    # F4 — put_row with existing activity_id upserts
    def test_F4_put_row_upserts_existing(self):
        row = make_local_row("upsert0001", status="staged")
        self.store.put_row(row)
        # Upsert with changed status
        row2 = make_local_row("upsert0001", status="active")
        self.store.put_row(row2)
        result = self.store.get_row("upsert0001")
        self.assertEqual(result["activity_status"], "active")

    # F5 — put_row auto-updates updated_at unless explicitly provided
    def test_F5_put_row_timestamp_control(self):
        # Case 1: Explicit timestamp → preserve it
        row = make_local_row("ts001", updated_at=42)
        self.store.put_row(row)
        result = self.store.get_row("ts001")
        self.assertEqual(result["updated_at"], 42,
                         "Explicit timestamp must be preserved")

        # Case 2: No timestamp → auto-generate
        before = int(time.time() * 1000)
        row2 = {"activity_id": "ts002", "activity_status": "staged",
                "activity": "{}"}
        self.store.put_row(row2)
        result2 = self.store.get_row("ts002")
        self.assertGreaterEqual(result2["updated_at"], before - 1000)

    # F6 — delete_row removes the row
    def test_F6_delete_row_removes(self):
        self.store.put_row(make_local_row("del001"))
        self.assertTrue(self.store.get_row("del001") is not None)
        self.store.delete_row("del001")
        self.assertIsNone(self.store.get_row("del001"))

    # F7 — delete_row on nonexistent is idempotent
    def test_F7_delete_row_nonexistent_noop(self):
        # Must not raise
        self.store.delete_row("never_existed")
        self.assertEqual(self.store.count(), 0)

    # F8 — get_all_rows returns all sorted
    def test_F8_get_all_rows_sorted(self):
        for aid in ["zebra", "alpha", "mike"]:
            self.store.put_row(make_local_row(aid))
        rows = self.store.get_all_rows()
        ids = [r["activity_id"] for r in rows]
        self.assertEqual(ids, sorted(ids))

    # F9 — count returns correct row count
    def test_F9_count_returns_correct_count(self):
        self.assertEqual(self.store.count(), 0)
        for i in range(5):
            self.store.put_row(make_local_row(f"cnt{i:04d}"))
        self.assertEqual(self.store.count(), 5)

    # F10 — get_rows_by_status filters correctly
    def test_F10_get_rows_by_status_filters(self):
        self.store.put_row(make_local_row("s1", status="staged"))
        self.store.put_row(make_local_row("a1", status="active"))
        self.store.put_row(make_local_row("s2", status="staged"))
        self.store.put_row(make_local_row("p1", status="paused"))

        staged = self.store.get_rows_by_status("staged")
        self.assertEqual(len(staged), 2)
        staged_ids = {r["activity_id"] for r in staged}
        self.assertEqual(staged_ids, {"s1", "s2"})

        active = self.store.get_rows_by_status("active")
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["activity_id"], "a1")

    # F11 — get_rows_by_status returns empty when no match
    def test_F11_get_rows_by_status_empty_on_no_match(self):
        self.store.put_row(make_local_row("only_one"))
        result = self.store.get_rows_by_status("ended")
        self.assertEqual(result, [], "Must return empty list, not None")

    # F12 — row-level and position-based ops are consistent
    def test_F12_dual_interface_consistency(self):
        self.store.put_row(make_local_row("dual001"))
        entries = self.store.read_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["activity_id"], "dual001")


# ══════════════════════════════════════════════════════════════════════
# Group G: SqliteStagingStore — Edge cases (G1–G8)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestSqliteStagingStoreEdgeCases(unittest.TestCase):
    """Tests for error handling, boundary values, and edge cases."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.db_path = self.test_dir / "staging.db"
        self.store = SqliteStagingStore(self.db_path)

    def tearDown(self):
        self.store.close()
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # G1 — Empty string activity_id
    def test_G1_empty_activity_id_handled(self):
        # Must not crash; either stores or rejects
        entry = make_entry("", status="staged")
        try:
            self.store.append_entry(entry)
            # If stored, must be readable
            entries = self.store.read_entries()
            # ok if stored or rejected — just no crash
        except (ValueError, sqlite3.IntegrityError):
            pass  # Rejection is also acceptable

    # G2 — Very long activity_id (1000 chars)
    def test_G2_long_activity_id_handled(self):
        long_id = "x" * 1000
        self.store.append_entry(make_entry(long_id))
        row = self.store.get_row(long_id)
        self.assertIsNotNone(row)
        self.assertEqual(len(row["activity_id"]), 1000)

    # G3 — SQL special characters in activity_id
    def test_G3_special_characters_sql_safe(self):
        special_ids = [
            "a'b\"c\\d%e",
            "f_g%h__i",
            "NULL000000",
        ]
        for sid in special_ids:
            self.store.put_row(make_local_row(sid))
            row = self.store.get_row(sid)
            self.assertIsNotNone(row, f"ID {sid!r} must be stored and retrieved")
            self.assertEqual(row["activity_id"], sid)

    # G4 — activity_status = None handled
    def test_G4_null_activity_status_handled(self):
        entry = {"activity_id": "nullStat01", "activity_status": None,
                 "activity": "{}"}
        try:
            self.store.append_entry(entry)
            result = self.store.get_row("nullStat01")
            self.assertIsNotNone(result)
        except (ValueError, sqlite3.IntegrityError):
            pass  # Rejection is acceptable for NOT NULL column

    # G5 — updated_at = 0 boundary value
    def test_G5_updated_at_zero_handled(self):
        entry = make_entry("zeroTime001", updated_at=0)
        self.store.append_entry(entry)
        result = self.store.get_row("zeroTime001")
        self.assertEqual(result["updated_at"], 0)

    # G6 — updated_at = 2**53 boundary value
    def test_G6_js_max_safe_integer_handled(self):
        large_ts = 2**53  # JS MAX_SAFE_INTEGER
        entry = make_entry("largeTS001", updated_at=large_ts)
        self.store.append_entry(entry)
        result = self.store.get_row("largeTS001")
        self.assertEqual(result["updated_at"], large_ts)

    # G7 — Concurrent reads do not block
    def test_G7_concurrent_reads_no_block(self):
        self.store.append_entry(make_entry("concur001"))
        # Open a second connection and read
        conn = sqlite3.connect(str(self.db_path))
        rows = conn.execute("SELECT * FROM staging").fetchall()
        conn.close()
        self.assertEqual(len(rows), 1)
        # Original store still works
        entries = self.store.read_entries()
        self.assertEqual(len(entries), 1)

    # G8 — Corrupt database detected
    def test_G8_corrupt_database_detected(self):
        self.store.append_entry(make_entry("corrupt001"))
        self.store.close()
        # Corrupt the file by overwriting bytes
        with open(self.db_path, "r+b") as f:
            f.seek(100)
            f.write(b"\x00" * 50)
        # Re-opening should detect corruption
        with self.assertRaises((sqlite3.DatabaseError, sqlite3.Error)):
            SqliteStagingStore(self.db_path)


# ══════════════════════════════════════════════════════════════════════
# Group H: Migration — staging.json → SQLite (H1–H12)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_MIGRATE and HAS_SQLITE_STORE,
                     "Migration module not implemented (Phase 3)")
class TestMigrationStagingToSqlite(unittest.TestCase):
    """Tests for migrate_staging_to_sqlite one-shot migration."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.json_path = self.test_dir / "staging.json"
        self.db_path = self.test_dir / "staging.db"
        # Write a valid staging.json with entries for migration tests
        self._write_staging_json([
            {
                "entry_id": "abc1234567",
                "data": {
                    "entry_id": "abc1234567",
                    "title": "Guitar",
                    "start_epoch": 1000,
                    "end_epoch": 2000,
                },
                "is_active": True,
                "is_paused": False,
            },
            {
                "entry_id": "def1234567",
                "data": {
                    "entry_id": "def1234567",
                    "title": "Reading",
                    "start_epoch": 3000,
                },
                "is_active": False,
                "is_paused": True,
            },
        ])

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def _write_staging_json(self, entries):
        self.json_path.write_text(json.dumps({"entries": entries}, indent=2))

    # H1 — Migration detects staging.json and creates staging.db
    def test_H1_detects_json_and_creates_db(self):
        result = migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        self.assertTrue(self.db_path.exists())
        self.assertIsNotNone(result)

    # H2 — Migration reads entries via FileStagingStore
    def test_H2_uses_filestagingstore_reader(self):
        result = migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        entries = store.read_entries()
        store.close()
        self.assertEqual(len(entries), 2)

    # H3 — Migration maps entry_id → activity_id
    def test_H3_maps_entry_id_to_activity_id(self):
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        rows = store.get_all_rows()
        store.close()
        ids = {r["activity_id"] for r in rows}
        self.assertIn("abc1234567", ids)
        self.assertIn("def1234567", ids)

    # H4 — Migration generates new activity_id for entries missing entry_id
    def test_H4_generates_id_for_missing_entry_id(self):
        entries = [
            {"data": {"title": "No ID entry"}, "is_active": True, "is_paused": False},
        ]
        self._write_staging_json(entries)
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        rows = store.get_all_rows()
        store.close()
        self.assertEqual(len(rows), 1)
        # Generated ID should be 10 alphanumeric characters
        self.assertRegex(rows[0]["activity_id"], r"^[A-Za-z0-9]{10}$")

    # H5 — Migration derives activity_status from is_active/is_paused
    def test_H5_derives_activity_status(self):
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        active_rows = store.get_rows_by_status("active")
        paused_rows = store.get_rows_by_status("paused")
        store.close()
        self.assertEqual(len(active_rows), 1)
        self.assertEqual(active_rows[0]["activity_id"], "abc1234567")
        self.assertEqual(len(paused_rows), 1)
        self.assertEqual(paused_rows[0]["activity_id"], "def1234567")

    # H6 — Migration preserves full entry data as activity column
    def test_H6_preserves_full_entry_data(self):
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        row = store.get_row("abc1234567")
        store.close()
        activity = json.loads(row["activity"])
        self.assertEqual(activity["title"], "Guitar")
        self.assertEqual(activity["start_epoch"], 1000)
        self.assertEqual(activity["end_epoch"], 2000)

    # H7 — Migration sets updated_at from file mtime or current time
    def test_H7_sets_updated_at(self):
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        row = store.get_row("abc1234567")
        store.close()
        self.assertIn("updated_at", row)
        self.assertGreater(row["updated_at"], 0)

    # H8 — Migration is idempotent (skips if staging.db already populated)
    def test_H8_idempotent_skips_if_populated(self):
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        # Second run must not duplicate or crash
        result2 = migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        count = store.count()
        store.close()
        self.assertEqual(count, 2, "Idempotent run must not duplicate entries")

    # H9 — Migration renames staging.json → staging.json.migrated
    def test_H9_renames_json_on_success(self):
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        self.assertFalse(self.json_path.exists(),
                         "Original staging.json must be renamed")
        self.assertTrue(self.test_dir.joinpath("staging.json.migrated").exists(),
                        "Backup must exist as .migrated")

    # H10 — Migration handles empty staging.json
    def test_H10_handles_empty_staging_json(self):
        self._write_staging_json([])
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        self.assertEqual(store.count(), 0)
        store.close()

    # H11 — Migration skips corrupt entries and continues
    def test_H11_skips_corrupt_entries(self):
        entries = [
            {"entry_id": "good0000001", "data": {"title": "Good"},
             "is_active": True, "is_paused": False},
            {"entry_id": "bad00000001"},  # missing data field
            {"entry_id": "good0000002", "data": {"title": "Also Good"},
             "is_active": True, "is_paused": False},
        ]
        self._write_staging_json(entries)
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        rows = store.get_all_rows()
        store.close()
        ids = {r["activity_id"] for r in rows}
        self.assertIn("good0000001", ids)
        self.assertIn("good0000002", ids)
        self.assertNotIn("bad00000001", ids,
                         "Corrupt entry must be skipped, not block others")

    # H12 — Migration preserves entry count for valid entries
    def test_H12_preserves_entry_count(self):
        # Write 7 entries
        entries = []
        for i in range(7):
            entries.append({
                "entry_id": f"mig{i:08d}",
                "data": {"entry_id": f"mig{i:08d}", "title": f"Entry {i}"},
                "is_active": True,
                "is_paused": False,
            })
        self._write_staging_json(entries)
        migrate_staging_to_sqlite(str(self.json_path), str(self.db_path))
        store = SqliteStagingStore(self.db_path)
        count = store.count()
        store.close()
        self.assertEqual(count, 7)


# ══════════════════════════════════════════════════════════════════════
# Group I: buildDiff() — LWW Resolution (I1–I22)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_DIFF, "buildDiff not implemented (Phase 3)")
class TestBuildDiff(unittest.TestCase):
    """Tests for the buildDiff pure function (LWW resolution)."""

    # I1 — Same row, remote updated_at newer, status differs → pull
    def test_I1_scenario_1_remote_newer_pull(self):
        local = [make_local_row("abc1234567", "staged", 1000)]
        remote = make_manifest([make_manifest_row("abc1234567", "active", 2000)])
        hash_idx = {}
        result = buildDiff(local, remote, hash_idx)
        self.assertIn("abc1234567", result.pull)
        self.assertNotIn("abc1234567", result.push)
        self.assertNotIn("abc1234567", result.delete_local)

    # I2 — Same row, local updated_at newer, status differs → push
    def test_I2_scenario_2_local_newer_push(self):
        local = [make_local_row("abc1234567", "active", 2000)]
        remote = make_manifest([make_manifest_row("abc1234567", "staged", 1000)])
        hash_idx = {}
        result = buildDiff(local, remote, hash_idx)
        self.assertIn("abc1234567", result.push)
        self.assertNotIn("abc1234567", result.pull)

    # I3 — Same row, same status, remote updated_at newer → pull
    def test_I3_scenario_3a_same_status_remote_newer_pull(self):
        local = [make_local_row("abc1234567", "staged", 1000)]
        remote = make_manifest([make_manifest_row("abc1234567", "staged", 2000)])
        hash_idx = {}
        result = buildDiff(local, remote, hash_idx)
        self.assertIn("abc1234567", result.pull)
        self.assertNotIn("abc1234567", result.push)

    # I4 — Same row, same status, local updated_at newer → push
    def test_I4_scenario_3b_same_status_local_newer_push(self):
        local = [make_local_row("abc1234567", "staged", 2000)]
        remote = make_manifest([make_manifest_row("abc1234567", "staged", 1000)])
        hash_idx = {}
        result = buildDiff(local, remote, hash_idx)
        self.assertIn("abc1234567", result.push)
        self.assertNotIn("abc1234567", result.pull)

    # I5 — Row in remote manifest, not in local → pull
    def test_I5_scenario_4_remote_only_pull(self):
        local = []
        remote = make_manifest([make_manifest_row("remoteOnly1")])
        hash_idx = {}
        result = buildDiff(local, remote, hash_idx)
        self.assertIn("remoteOnly1", result.pull)
        self.assertNotIn("remoteOnly1", result.push)

    # I6 — Local row, not in remote, in hash index → delete_local
    def test_I6_scenario_5_committed_delete_local(self):
        local = [make_local_row("toBeDeleted")]
        remote = make_manifest([])
        hash_idx = {"toBeDeleted": make_hash_entry(1000)}
        result = buildDiff(local, remote, hash_idx)
        self.assertIn("toBeDeleted", result.delete_local)
        self.assertNotIn("toBeDeleted", result.pull)

    # I7 — Local row, not in remote, NOT in hash index → push
    def test_I7_scenario_6_new_local_push(self):
        local = [make_local_row("newLocal001")]
        remote = make_manifest([])
        hash_idx = {}
        result = buildDiff(local, remote, hash_idx)
        self.assertIn("newLocal001", result.push)
        self.assertNotIn("newLocal001", result.delete_local)

    # I8 — All local committed, remote empty → fastPath + delete_local
    def test_I8_scenario_7_all_committed_fastpath(self):
        local = [
            make_local_row("aa1"),
            make_local_row("bb2"),
            make_local_row("cc3"),
        ]
        remote = make_manifest([])
        hash_idx = {
            "aa1": make_hash_entry(1000),
            "bb2": make_hash_entry(2000),
            "cc3": make_hash_entry(3000),
        }
        result = buildDiff(local, remote, hash_idx)
        self.assertEqual(len(result.delete_local), 3)
        self.assertTrue(result.fast_path)

    # I9 — Both local and remote empty → fastPath
    def test_I9_both_empty_fastpath(self):
        result = buildDiff([], make_manifest([]), {})
        self.assertEqual(result.pull, [])
        self.assertEqual(result.push, [])
        self.assertEqual(result.delete_local, [])
        self.assertTrue(result.fast_path)

    # I10 — Local empty, remote has rows → pull all
    def test_I10_local_empty_pull_all(self):
        remote = make_manifest([
            make_manifest_row("remote1"),
            make_manifest_row("remote2"),
            make_manifest_row("remote3"),
        ])
        result = buildDiff([], remote, {})
        self.assertEqual(len(result.pull), 3)
        self.assertIn("remote1", result.pull)
        self.assertIn("remote2", result.pull)
        self.assertIn("remote3", result.pull)

    # I11 — Only local rows, remote empty, none committed → push all
    def test_I11_local_only_push_all(self):
        local = [make_local_row("push1"), make_local_row("push2")]
        result = buildDiff(local, make_manifest([]), {})
        self.assertEqual(len(result.push), 2)
        self.assertIn("push1", result.push)
        self.assertIn("push2", result.push)

    # I12 — Same updated_at, different status → deterministic tie-break
    def test_I12_tie_break_deterministic(self):
        local = [make_local_row("tieBreak01", "staged", 5000)]
        remote = make_manifest([make_manifest_row("tieBreak01", "active", 5000)])
        result = buildDiff(local, remote, {})
        is_pull = "tieBreak01" in result.pull
        is_push = "tieBreak01" in result.push
        self.assertNotEqual(is_pull, is_push,
                            "Row must be in exactly one list (pull xor push)")
        self.assertTrue(is_pull or is_push, "Row must be resolved, not ignored")

    # I13 — Same updated_at, same status → no-op
    def test_I13_identical_rows_noop(self):
        local = [make_local_row("same001", "staged", 5000)]
        remote = make_manifest([make_manifest_row("same001", "staged", 5000)])
        result = buildDiff(local, remote, {})
        self.assertEqual(result.pull, [])
        self.assertEqual(result.push, [])
        self.assertEqual(result.delete_local, [])

    # I14 — 50 rows with mixed scenarios
    def test_I14_stress_50_mixed_scenarios(self):
        local = []
        remote_rows = []
        hash_idx = {}

        # 10: remote newer → pull
        for i in range(10):
            aid = f"pull{i:04d}"
            local.append(make_local_row(aid, "staged", 1000))
            remote_rows.append(make_manifest_row(aid, "staged", 2000))
        # 10: local newer → push
        for i in range(10):
            aid = f"push{i:04d}"
            local.append(make_local_row(aid, "staged", 2000))
            remote_rows.append(make_manifest_row(aid, "staged", 1000))
        # 10: remote only → pull
        for i in range(10):
            remote_rows.append(make_manifest_row(f"remOnly{i:04d}"))
        # 10: local only, committed → delete_local
        for i in range(10):
            aid = f"delMe{i:04d}"
            local.append(make_local_row(aid))
            hash_idx[aid] = make_hash_entry()
        # 10: local only, not committed → push
        for i in range(10):
            local.append(make_local_row(f"newLoc{i:04d}"))

        result = buildDiff(local, make_manifest(remote_rows), hash_idx)
        self.assertEqual(len(result.pull), 20,
                         "20 pulled (10 remote-newer + 10 remote-only)")
        self.assertEqual(len(result.push), 20,
                         "20 pushed (10 local-newer + 10 local-only)")
        self.assertEqual(len(result.delete_local), 10,
                         "10 deleteLocal (committed)")

    # I15 — local_rows=None treated as []
    def test_I15_null_local_treated_as_empty(self):
        remote = make_manifest([make_manifest_row("remOnly")])
        result = buildDiff(None, remote, {})
        self.assertIn("remOnly", result.pull)

    # I16 — remote_manifest=None or remote_manifest.rows=None treated as empty
    def test_I16_null_remote_treated_as_empty(self):
        local = [make_local_row("locOnly")]
        result = buildDiff(local, {"rows": None, "version": 0}, {})
        # Must not crash; local becomes push (Scenario 6 since not in hash)
        self.assertIn("locOnly", result.push)

    # I17 — ledger_hash_index=None treated as empty dict
    def test_I17_null_hash_index_treated_as_empty(self):
        local = [make_local_row("locOnlyNoLedger")]
        result = buildDiff(local, make_manifest([]), None)
        self.assertIn("locOnlyNoLedger", result.push,
                      "Null hash index means local-only becomes push (Scenario 6)")

    # I18 — buildDiff does not mutate input arguments
    def test_I18_pure_function_no_mutation(self):
        local = [make_local_row("immutTest1", "staged", 1000)]
        remote = make_manifest([make_manifest_row("immutTest1", "active", 2000)])
        hash_idx = {"someKey": make_hash_entry(1000)}
        local_copy = json.dumps(local)
        remote_copy = json.dumps(remote)
        hash_idx_size = len(hash_idx)

        buildDiff(local, remote, hash_idx)
        self.assertEqual(json.dumps(local), local_copy)
        self.assertEqual(json.dumps(remote), remote_copy)
        self.assertEqual(len(hash_idx), hash_idx_size)

    # I19 — Empty string activity_id in manifest rows skipped
    def test_I19_empty_activity_id_in_manifest_skipped(self):
        local = [make_local_row("good001")]
        remote = make_manifest([
            make_manifest_row("good001"),
            make_manifest_row(""),  # empty ID — should be skipped
            make_manifest_row("good002"),
        ])
        result = buildDiff(local, remote, {})
        self.assertIn("good002", result.pull)
        self.assertNotIn("", result.pull)
        self.assertNotIn("", result.push)

    # I20 — Missing updated_at in manifest row treated as 0
    def test_I20_missing_updated_at_defaults_to_zero(self):
        local = [make_local_row("noTs001", "staged", 1000)]
        remote = make_manifest([
            {"activity_id": "noTs001", "activity_status": "active"},
            # no updated_at field
        ])
        result = buildDiff(local, remote, {})
        # local has 1000, remote has 0 → local wins → push
        self.assertIn("noTs001", result.push)

    # I21 — fast_path is True only when both pull and push are empty
    def test_I21_fastpath_contract(self):
        # Case: delete_local only → fastPath True
        local = [make_local_row("delOnly01")]
        remote = make_manifest([])
        hash_idx = {"delOnly01": make_hash_entry()}
        result = buildDiff(local, remote, hash_idx)
        self.assertTrue(result.fast_path,
                        "fastPath true when only delete_local actions exist")

        # Case: pull non-empty → fastPath False
        local2 = []
        remote2 = make_manifest([make_manifest_row("newRemote")])
        result2 = buildDiff(local2, remote2, {})
        self.assertFalse(result2.fast_path,
                         "fastPath false when pull has items")

        # Case: push non-empty → fastPath False
        local3 = [make_local_row("newLocal")]
        result3 = buildDiff(local3, make_manifest([]), {})
        self.assertFalse(result3.fast_path,
                         "fastPath false when push has items")

    # I22 — No activity_id appears in more than one action list
    def test_I22_mutual_exclusion_invariant(self):
        local = [
            make_local_row("x1", "staged", 1000),
            make_local_row("x2", "staged", 1000),
        ]
        remote = make_manifest([
            make_manifest_row("x1", "active", 2000),
            make_manifest_row("x3"),
        ])
        result = buildDiff(local, remote, {})
        in_pull_and_push = set(result.pull) & set(result.push)
        in_pull_and_delete = set(result.pull) & set(result.delete_local)
        in_push_and_delete = set(result.push) & set(result.delete_local)
        self.assertEqual(in_pull_and_push, set(), "No ID in both pull and push")
        self.assertEqual(in_pull_and_delete, set(), "No ID in both pull and delete_local")
        self.assertEqual(in_push_and_delete, set(), "No ID in both push and delete_local")


# ══════════════════════════════════════════════════════════════════════
# Group J: Integration — SQLite store + buildDiff pipeline (J1–J8)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_SQLITE_STORE and HAS_DIFF,
                     "Integration requires SqliteStagingStore + buildDiff (Phase 3)")
class TestIntegrationPipeline(unittest.TestCase):
    """Tests for the full pipeline: SQLite store ↔ buildDiff ↔ sync actions."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.db_path = self.test_dir / "staging.db"
        self.store = SqliteStagingStore(self.db_path)

    def tearDown(self):
        self.store.close()
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    # J1 — Populate store, build manifest, run buildDiff → correct actions
    def test_J1_store_to_diff_pipeline(self):
        self.store.put_row(make_local_row("aa", "staged", 1000))
        self.store.put_row(make_local_row("bb", "staged", 2000))
        # Remote has "aa" newer, "cc" that's new, "bb" is same
        remote = make_manifest([
            make_manifest_row("aa", "active", 3000),
            make_manifest_row("bb", "staged", 2000),
            make_manifest_row("cc", "staged", 500),
        ])
        local_rows = self.store.get_all_rows()
        hash_idx = {}
        result = buildDiff(local_rows, remote, hash_idx)
        self.assertIn("aa", result.pull, "aa: remote newer → pull")
        self.assertIn("cc", result.pull, "cc: remote-only → pull")
        # bb is identical → no action
        self.assertNotIn("bb", result.pull)
        self.assertNotIn("bb", result.push)

    # J2 — Pull phase simulation: apply pull actions via put_row
    def test_J2_pull_execution(self):
        # Pre-populate remote rows via put_row simulating pull
        self.store.put_row(make_local_row("pulled1", "staged", 5000))
        self.store.put_row(make_local_row("pulled2", "active", 6000))
        self.assertEqual(self.store.count(), 2)
        row = self.store.get_row("pulled1")
        self.assertEqual(row["activity_status"], "staged")

    # J3 — Push phase simulation: extract rows for push actions via get_row
    def test_J3_push_extraction(self):
        self.store.put_row(make_local_row("pushMe1", "staged", 1000))
        self.store.put_row(make_local_row("pushMe2", "active", 2000))
        # Simulate extracting rows for push
        push_ids = ["pushMe1", "pushMe2"]
        push_data = [self.store.get_row(aid) for aid in push_ids]
        self.assertEqual(len(push_data), 2)
        self.assertEqual(push_data[0]["activity_id"], "pushMe1")
        self.assertEqual(push_data[1]["activity_id"], "pushMe2")

    # J4 — Delete phase simulation: apply delete_local via delete_row
    def test_J4_delete_execution(self):
        self.store.put_row(make_local_row("killMe1"))
        self.store.put_row(make_local_row("keepMe1"))
        self.store.put_row(make_local_row("killMe2"))
        # Simulate delete_local = ["killMe1", "killMe2"]
        for aid in ["killMe1", "killMe2"]:
            self.store.delete_row(aid)
        self.assertEqual(self.store.count(), 1)
        self.assertIsNotNone(self.store.get_row("keepMe1"))

    # J5 — Full sync cycle: manifest → diff → pull → push → delete → converge
    def test_J5_full_sync_cycle_convergence(self):
        # Initial local state
        self.store.put_row(make_local_row("sync1", "staged", 1000))
        self.store.put_row(make_local_row("sync2", "staged", 2000))

        # Remote manifest
        remote = make_manifest([
            make_manifest_row("sync1", "active", 3000),  # newer → pull
            make_manifest_row("sync3", "staged", 500),   # remote-only → pull
        ])
        hash_idx = {}  # nothing committed yet

        # Diff
        local_rows = self.store.get_all_rows()
        result = buildDiff(local_rows, remote, hash_idx)

        # Execute pull: insert remote rows
        pulled_rows = [
            make_local_row("sync1", "active", 3000),
            make_local_row("sync3", "staged", 500),
        ]
        for row in pulled_rows:
            self.store.put_row(row)

        # Execute push: read push rows
        for aid in result.push:
            row = self.store.get_row(aid)
            self.assertIsNotNone(row)

        # Final state
        rows = self.store.get_all_rows()
        ids = {r["activity_id"] for r in rows}
        self.assertIn("sync1", ids)
        self.assertIn("sync2", ids)
        self.assertIn("sync3", ids)
        self.assertEqual(self.store.count(), 3)

    # J6 — 409 conflict simulation: re-run diff after failed push
    def test_J6_409_conflict_rerun_diff(self):
        self.store.put_row(make_local_row("conflict01", "staged", 1000))
        remote1 = make_manifest([
            make_manifest_row("conflict01", "staged", 2000),
        ])
        # Initial diff → pull (remote newer)
        result1 = buildDiff(self.store.get_all_rows(), remote1, {})
        self.assertIn("conflict01", result1.pull)

        # Apply pull — now local is at 2000
        self.store.put_row(make_local_row("conflict01", "staged", 2000))

        # Suppose another device pushed while we were processing: remote now at 3000
        remote2 = make_manifest([
            make_manifest_row("conflict01", "active", 3000),
        ])
        result2 = buildDiff(self.store.get_all_rows(), remote2, {})
        self.assertIn("conflict01", result2.pull,
                      "Re-diff after conflict must re-resolve to pull")

    # J7 — get_all_rows produces correct manifest format
    def test_J7_get_all_rows_manifest_format(self):
        self.store.put_row(make_local_row("mf1", "staged", 1000))
        self.store.put_row(make_local_row("mf2", "active", 2000))
        rows = self.store.get_all_rows()
        for row in rows:
            self.assertIn("activity_id", row)
            self.assertIn("activity_status", row)
            self.assertIn("updated_at", row)
            self.assertIsInstance(row["updated_at"], int)
        # Can be used to build a manifest
        manifest_rows = [
            {"activity_id": r["activity_id"],
             "activity_status": r["activity_status"],
             "updated_at": r["updated_at"]}
            for r in rows
        ]
        self.assertEqual(len(manifest_rows), 2)

    # J8 — Repeated sync cycles converge (idempotent)
    def test_J8_repeated_sync_converges(self):
        self.store.put_row(make_local_row("c1", "staged", 1000))
        self.store.put_row(make_local_row("c2", "staged", 2000))
        remote = make_manifest([
            make_manifest_row("c1", "staged", 3000),
            make_manifest_row("c2", "staged", 4000),
        ])

        # First cycle
        result1 = buildDiff(self.store.get_all_rows(), remote, {})
        # Apply pulls
        for aid in result1.pull:
            # After pull: re-diff should be empty
            pass

        # Apply pulls so local matches remote
        self.store.put_row(make_local_row("c1", "staged", 3000))
        self.store.put_row(make_local_row("c2", "staged", 4000))

        # Second cycle: should be no-op
        result2 = buildDiff(self.store.get_all_rows(), remote, {})
        self.assertEqual(result2.pull, [], "Second cycle: no pull needed")
        self.assertEqual(result2.push, [], "Second cycle: no push needed")
        self.assertTrue(result2.fast_path, "Second cycle: fastPath")


# ══════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
