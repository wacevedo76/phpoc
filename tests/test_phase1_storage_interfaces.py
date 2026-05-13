"""Phase 1 tests: Split Storage Interfaces + Config File Format.

Tests the 5 abstract storage interfaces and their file-backed implementations,
plus the ConfigManager with defaults merging and dot-notation access.

These tests verify the new infrastructure WITHOUT modifying any existing code.
"""

import unittest
import json
import os
import tempfile
from pathlib import Path
from typing import List, Dict, Any, Optional

from storage.staging_store import AbstractStagingStore
from storage.ledger_store import AbstractLedgerStore
from storage.index_store import AbstractIndexStore
from storage.identity_store import AbstractIdentityStore
from storage.config_store import AbstractConfigStore

from storage.implementations.file_staging import FileStagingStore
from storage.implementations.file_ledger import FileLedgerStore
from storage.implementations.file_index import FileIndexStore
from storage.implementations.file_identity import FileIdentityStore
from storage.implementations.file_config import FileConfigStore
from security.config_manager import ConfigManager


# =============================================================================
# FileStagingStore Tests
# =============================================================================

class TestFileStagingStore(unittest.TestCase):
    """Tests for FileStagingStore — CRUD on staging entries."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(dir="/dev/shm" if os.path.exists("/dev/shm") else None))
        self.path = self.test_dir / "staging.json"
        self.store = FileStagingStore(self.path)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_read_entries_returns_empty_list_when_file_does_not_exist(self):
        """Should return [] when staging.json does not exist."""
        os.remove(self.path)
        entries = self.store.read_entries()
        self.assertEqual(entries, [])

    def test_read_entries_returns_empty_list_for_new_store(self):
        """New FileStagingStore initializes with empty list."""
        entries = self.store.read_entries()
        self.assertEqual(entries, [])

    def test_write_entries_roundtrip(self):
        """write_entries followed by read_entries returns identical data."""
        data = [{"title": "Guitar", "start_epoch": 1000}]
        self.store.write_entries(data)
        self.assertEqual(self.store.read_entries(), data)

    def test_append_entry_adds_to_end(self):
        """append_entry adds one entry after existing entries."""
        self.store.write_entries([{"title": "First"}])
        self.store.append_entry({"title": "Second"})
        entries = self.store.read_entries()
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[-1]["title"], "Second")

    def test_append_entry_on_empty(self):
        """append_entry works when staging is empty."""
        self.store.append_entry({"title": "Only"})
        self.assertEqual(len(self.store.read_entries()), 1)

    def test_remove_entries_single(self):
        """remove_entries removes a single entry by index."""
        self.store.write_entries([
            {"title": "A"},
            {"title": "B"},
            {"title": "C"},
        ])
        self.store.remove_entries([1])
        self.assertEqual([e["title"] for e in self.store.read_entries()], ["A", "C"])

    def test_remove_entries_multiple_descending(self):
        """remove_entries handles multiple indices in correct order."""
        self.store.write_entries([
            {"title": "A"},
            {"title": "B"},
            {"title": "C"},
            {"title": "D"},
        ])
        self.store.remove_entries([0, 2])  # Remove A and C
        self.assertEqual([e["title"] for e in self.store.read_entries()], ["B", "D"])

    def test_remove_entries_out_of_range(self):
        """remove_entries silently skips out-of-range indices."""
        self.store.write_entries([{"title": "A"}])
        self.store.remove_entries([5, -1])
        self.assertEqual(len(self.store.read_entries()), 1)

    def test_update_entry_modifies_fields(self):
        """update_entry merges provided fields into the target entry."""
        self.store.write_entries([
            {"title": "Guitar", "duration": 3600, "comment": "scales"},
        ])
        self.store.update_entry(0, {"comment": "arpeggios", "tags": ["music"]})
        entry = self.store.read_entries()[0]
        self.assertEqual(entry["title"], "Guitar")         # unchanged
        self.assertEqual(entry["duration"], 3600)           # unchanged
        self.assertEqual(entry["comment"], "arpeggios")     # updated
        self.assertEqual(entry["tags"], ["music"])          # added

    def test_update_entry_out_of_range(self):
        """update_entry silently does nothing for out-of-range index."""
        self.store.write_entries([{"title": "A"}])
        self.store.update_entry(5, {"title": "B"})
        self.assertEqual(self.store.read_entries()[0]["title"], "A")

    def test_is_abstract_staging_store(self):
        """FileStagingStore is an instance of AbstractStagingStore."""
        self.assertIsInstance(self.store, AbstractStagingStore)

    def test_persists_to_disk(self):
        """Data survives store re-creation (disk persistence)."""
        self.store.write_entries([{"title": "Persisted"}])
        store2 = FileStagingStore(self.path)
        self.assertEqual(store2.read_entries(), [{"title": "Persisted"}])


# =============================================================================
# FileLedgerStore Tests
# =============================================================================

class TestFileLedgerStore(unittest.TestCase):
    """Tests for FileLedgerStore — append-only block storage with ranges."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(dir="/dev/shm" if os.path.exists("/dev/shm") else None))
        self.path = self.test_dir / "ledger.json"
        self.store = FileLedgerStore(self.path)
        self.blocks = [
            {"type": "genesis", "day_hash": "aaa", "date": "2026-01-01"},
            {"type": "day", "day_hash": "bbb", "date": "2026-01-02"},
            {"type": "day", "day_hash": "ccc", "date": "2026-01-03"},
            {"type": "day", "day_hash": "ddd", "date": "2026-01-04"},
        ]

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_read_blocks_returns_empty_when_no_file(self):
        """read_blocks returns empty list when ledger.json does not exist."""
        self.assertEqual(self.store.read_blocks(), [])

    def test_get_block_count_zero_when_empty(self):
        """get_block_count returns 0 when chain is empty."""
        self.assertEqual(self.store.get_block_count(), 0)

    def test_get_last_block_none_when_empty(self):
        """get_last_block returns None when chain is empty."""
        self.assertIsNone(self.store.get_last_block())

    def test_append_blocks_and_read_all(self):
        """append_blocks then read_blocks returns all blocks."""
        self.store.append_blocks(self.blocks)
        self.assertEqual(self.store.read_blocks(), self.blocks)

    def test_get_block_count_after_append(self):
        """get_block_count returns correct count after append."""
        self.store.append_blocks(self.blocks)
        self.assertEqual(self.store.get_block_count(), 4)

    def test_get_last_block(self):
        """get_last_block returns the most recent block."""
        self.store.append_blocks(self.blocks)
        last = self.store.get_last_block()
        self.assertEqual(last["day_hash"], "ddd")

    def test_read_blocks_with_start(self):
        """read_blocks(start=1) skips the first block."""
        self.store.append_blocks(self.blocks)
        result = self.store.read_blocks(start=1)
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]["day_hash"], "bbb")

    def test_read_blocks_with_start_end(self):
        """read_blocks(start=1, end=3) returns the middle slice."""
        self.store.append_blocks(self.blocks)
        result = self.store.read_blocks(start=1, end=3)
        self.assertEqual(len(result), 2)
        self.assertEqual([b["day_hash"] for b in result], ["bbb", "ccc"])

    def test_read_blocks_with_negative_start(self):
        """read_blocks(start=-2) returns the last 2 blocks."""
        self.store.append_blocks(self.blocks)
        result = self.store.read_blocks(start=-2)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["day_hash"], "ccc")

    def test_read_blocks_with_negative_end(self):
        """read_blocks(end=-1) excludes the last block."""
        self.store.append_blocks(self.blocks)
        result = self.store.read_blocks(end=-1)
        self.assertEqual(len(result), 3)

    def test_truncate_removes_from_end(self):
        """truncate removes the most recent blocks first."""
        self.store.append_blocks(self.blocks)
        removed = self.store.truncate(keep_count=2)
        self.assertEqual(len(removed), 2)
        self.assertEqual(removed[0]["day_hash"], "ccc")  # first removed
        self.assertEqual(removed[1]["day_hash"], "ddd")  # second removed
        self.assertEqual(self.store.get_block_count(), 2)

    def test_truncate_returns_empty_when_keep_count_equals_length(self):
        """truncate with keep_count >= length returns empty list."""
        self.store.append_blocks(self.blocks)
        removed = self.store.truncate(keep_count=4)
        self.assertEqual(removed, [])
        self.assertEqual(self.store.get_block_count(), 4)

    def test_truncate_returns_empty_when_keep_count_exceeds_length(self):
        """truncate with keep_count > length returns empty list."""
        self.store.append_blocks(self.blocks)
        removed = self.store.truncate(keep_count=99)
        self.assertEqual(removed, [])

    def test_is_abstract_ledger_store(self):
        """FileLedgerStore is an instance of AbstractLedgerStore."""
        self.assertIsInstance(self.store, AbstractLedgerStore)

    def test_persists_to_disk(self):
        """Data survives store re-creation (disk persistence)."""
        self.store.append_blocks(self.blocks)
        store2 = FileLedgerStore(self.path)
        self.assertEqual(store2.get_block_count(), 4)


# =============================================================================
# FileIndexStore Tests
# =============================================================================

class TestFileIndexStore(unittest.TestCase):
    """Tests for FileIndexStore — simple key-value cache."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(dir="/dev/shm" if os.path.exists("/dev/shm") else None))
        self.path = self.test_dir / "index.json"
        self.store = FileIndexStore(self.path)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_read_index_returns_empty_dict_when_no_file(self):
        """read_index returns {} when file does not exist."""
        self.assertEqual(self.store.read_index(), {})

    def test_write_index_roundtrip(self):
        """write_index followed by read_index returns identical data."""
        data = {"2026-01-15": {"guitar": 3600000}}
        self.store.write_index(data)
        self.assertEqual(self.store.read_index(), data)

    def test_write_overwrites(self):
        """write_index overwrites previous data atomically."""
        self.store.write_index({"date1": {"a": 100}})
        self.store.write_index({"date2": {"b": 200}})
        self.assertEqual(self.store.read_index(), {"date2": {"b": 200}})

    def test_is_abstract_index_store(self):
        """FileIndexStore is an instance of AbstractIndexStore."""
        self.assertIsInstance(self.store, AbstractIndexStore)

    def test_persists_to_disk(self):
        """Data survives store re-creation."""
        self.store.write_index({"test": {"x": 1}})
        store2 = FileIndexStore(self.path)
        self.assertEqual(store2.read_index(), {"test": {"x": 1}})


# =============================================================================
# FileIdentityStore Tests
# =============================================================================

class TestFileIdentityStore(unittest.TestCase):
    """Tests for FileIdentityStore — identity cache."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(dir="/dev/shm" if os.path.exists("/dev/shm") else None))
        self.path = self.test_dir / "identity.json"
        self.store = FileIdentityStore(self.path)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_read_identity_returns_none_when_no_file(self):
        """read_identity returns None when file does not exist."""
        self.assertIsNone(self.store.read_identity())

    def test_write_identity_roundtrip(self):
        """write_identity followed by read_identity returns identical data."""
        data = {"username": "testuser", "email": "test@example.com"}
        self.store.write_identity(data)
        self.assertEqual(self.store.read_identity(), data)

    def test_is_abstract_identity_store(self):
        """FileIdentityStore is an instance of AbstractIdentityStore."""
        self.assertIsInstance(self.store, AbstractIdentityStore)

    def test_persists_to_disk(self):
        """Data survives store re-creation."""
        data = {"username": "persist_test"}
        self.store.write_identity(data)
        store2 = FileIdentityStore(self.path)
        self.assertEqual(store2.read_identity(), data)

    def test_overwrite(self):
        """write_identity overwrites previous data."""
        self.store.write_identity({"version": 1})
        self.store.write_identity({"version": 2})
        self.assertEqual(self.store.read_identity(), {"version": 2})


# =============================================================================
# FileConfigStore Tests
# =============================================================================

class TestFileConfigStore(unittest.TestCase):
    """Tests for FileConfigStore — config file read/write."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(dir="/dev/shm" if os.path.exists("/dev/shm") else None))
        self.path = self.test_dir / "config.json"
        self.store = FileConfigStore(self.path)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_read_config_returns_none_when_no_file(self):
        """read_config returns None when config.json does not exist."""
        if self.path.exists():
            os.remove(self.path)
        self.assertIsNone(self.store.read_config())

    def test_write_config_roundtrip(self):
        """write_config followed by read_config returns identical data."""
        data = {"remote": {"staging_path": "/tmp/test"}}
        self.store.write_config(data)
        self.assertEqual(self.store.read_config(), data)

    def test_is_abstract_config_store(self):
        """FileConfigStore is an instance of AbstractConfigStore."""
        self.assertIsInstance(self.store, AbstractConfigStore)

    def test_persists_to_disk(self):
        """Data survives store re-creation."""
        self.store.write_config({"test": True})
        store2 = FileConfigStore(self.path)
        self.assertEqual(store2.read_config(), {"test": True})


# =============================================================================
# ConfigManager Tests
# =============================================================================

class TestConfigManager(unittest.TestCase):
    """Tests for ConfigManager — defaults merging, dot-notation, edge cases."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(dir="/dev/shm" if os.path.exists("/dev/shm") else None))
        self.config_path = self.test_dir / "config.json"
        self.store = FileConfigStore(self.config_path)
        self.manager = ConfigManager(self.store)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_read_returns_defaults_when_no_file(self):
        """read() returns full DEFAULTS when config.json does not exist."""
        config = self.manager.read()
        self.assertEqual(config, ConfigManager.DEFAULTS)

    def test_read_returns_merged_config(self):
        """read() merges user config with defaults — user values win."""
        self.store.write_config({"auth": {"cache_timeout_minutes": 60}})
        config = self.manager.read()
        self.assertEqual(config["auth"]["cache_timeout_minutes"], 60)  # user override
        self.assertEqual(config["remote"]["transport"], "git")         # default preserved
        self.assertEqual(config["timeouts"]["remote_check_ms"], 500)   # default preserved

    def test_get_with_dot_notation(self):
        """get() accesses nested config via dot-separated path."""
        self.store.write_config({"auth": {"cache_timeout_minutes": 45}})
        self.assertEqual(self.manager.get("auth.cache_timeout_minutes"), 45)
        self.assertEqual(self.manager.get("remote.transport"), "git")       # default
        self.assertEqual(self.manager.get("timeouts.remote_check_ms"), 500) # default

    def test_get_with_default_fallback(self):
        """get() returns default when path does not exist."""
        self.assertEqual(self.manager.get("nonexistent.key", "fallback"), "fallback")

    def test_get_with_none_value_returns_default(self):
        """get() returns default when value is explicitly None."""
        self.store.write_config({"remote": {"git_remote_url": None}})
        val = self.manager.get("remote.git_remote_url", "no-remote")
        self.assertEqual(val, "no-remote")

    def test_write_persists_and_updates_cache(self):
        """write() persists to store and updates in-memory cache."""
        self.manager.write({"auth": {"cache_timeout_minutes": 120}})
        # Verify in-memory cache reflects the write
        self.assertEqual(self.manager.get("auth.cache_timeout_minutes"), 120)
        # Verify disk persistence
        self.assertEqual(self.store.read_config()["auth"]["cache_timeout_minutes"], 120)

    def test_write_partial_config(self):
        """write() with a partial config correctly merges with in-memory state."""
        self.manager.write({"remote": {"git_remote_url": "https://example.com/repo.git"}})
        config = self.manager.read()
        self.assertEqual(config["remote"]["git_remote_url"], "https://example.com/repo.git")
        # Other fields should still have defaults
        self.assertEqual(config["remote"]["transport"], "git")
        self.assertEqual(config["auth"]["cache_timeout_minutes"], 30)

    def test_deep_merge_preserves_unrelated_keys(self):
        """_deep_merge preserves keys from overrides that are not in defaults."""
        merged = ConfigManager._deep_merge(
            {"a": 1, "b": {"c": 2}},
            {"b": {"d": 3}, "extra": "survives"},
        )
        self.assertEqual(merged["a"], 1)
        self.assertEqual(merged["b"]["c"], 2)
        self.assertEqual(merged["b"]["d"], 3)
        self.assertEqual(merged["extra"], "survives")

    def test_deep_merge_override_atomic_value_with_dict(self):
        """_deep_merge replaces a value entirely when types don't match."""
        merged = ConfigManager._deep_merge(
            {"key": "string_value"},
            {"key": {"nested": "dict_value"}},
        )
        self.assertEqual(merged["key"]["nested"], "dict_value")

    def test_deep_merge_override_dict_with_atomic_value(self):
        """_deep_merge replaces a dict value entirely when types don't match."""
        merged = ConfigManager._deep_merge(
            {"key": {"nested": "old"}},
            {"key": "new_atomic_value"},
        )
        self.assertEqual(merged["key"], "new_atomic_value")

    def test_cache_is_used_on_subsequent_reads(self):
        """read() returns cached config without re-reading from store."""
        self.manager.read()  # populate cache
        # Modify disk directly (simulate corruption)
        self.store.write_config({"INVALID": "should not be seen"})
        # Cache should still hold the merged defaults
        config = self.manager.read()
        self.assertIn("remote", config)
        self.assertNotEqual(config.get("INVALID"), "should not be seen")

    def test_get_returns_default_when_path_has_non_dict_intermediate(self):
        """get() returns default when an intermediate key is not a dict."""
        # Set a non-dict value for "remote" (normally a dict)
        self.store.write_config({"remote": "not_a_dict"})
        val = self.manager.get("remote.staging_path", "fallback")
        self.assertEqual(val, "fallback")


# =============================================================================
# Abstract Interface Contract Tests
# =============================================================================

class TestAbstractStagingStoreContract(unittest.TestCase):
    """Verify that AbstractStagingStore cannot be instantiated directly."""

    def test_abstract_class_cannot_be_instantiated(self):
        with self.assertRaises(TypeError):
            AbstractStagingStore()


class TestAbstractLedgerStoreContract(unittest.TestCase):
    """Verify that AbstractLedgerStore cannot be instantiated directly."""

    def test_abstract_class_cannot_be_instantiated(self):
        with self.assertRaises(TypeError):
            AbstractLedgerStore()


class TestAbstractIndexStoreContract(unittest.TestCase):
    """Verify that AbstractIndexStore cannot be instantiated directly."""

    def test_abstract_class_cannot_be_instantiated(self):
        with self.assertRaises(TypeError):
            AbstractIndexStore()


class TestAbstractIdentityStoreContract(unittest.TestCase):
    """Verify that AbstractIdentityStore cannot be instantiated directly."""

    def test_abstract_class_cannot_be_instantiated(self):
        with self.assertRaises(TypeError):
            AbstractIdentityStore()


class TestAbstractConfigStoreContract(unittest.TestCase):
    """Verify that AbstractConfigStore cannot be instantiated directly."""

    def test_abstract_class_cannot_be_instantiated(self):
        with self.assertRaises(TypeError):
            AbstractConfigStore()


# =============================================================================
# Cross-Store Consistency Tests
# =============================================================================

class TestMultiStoreConsistency(unittest.TestCase):
    """Verify that the 4+1 file stores don't interfere with each other.

    Each store manages its own file. Reading/writing one should not
    affect the others, even when all are backed by the same base path.
    """

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(dir="/dev/shm" if os.path.exists("/dev/shm") else None))
        self.staging_store = FileStagingStore(self.test_dir / "staging.json")
        self.ledger_store = FileLedgerStore(self.test_dir / "ledger.json")
        self.index_store = FileIndexStore(self.test_dir / "index.json")
        self.identity_store = FileIdentityStore(self.test_dir / "identity.json")
        self.config_store = FileConfigStore(self.test_dir / "config.json")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_staging_does_not_affect_ledger(self):
        """Modifying staging leaves ledger untouched."""
        self.staging_store.write_entries([{"title": "staging-entry"}])
        self.assertEqual(self.ledger_store.read_blocks(), [])

    def test_ledger_does_not_affect_index(self):
        """Modifying ledger leaves index untouched."""
        self.ledger_store.append_blocks([{"type": "genesis", "date": "2026-01-01"}])
        self.assertEqual(self.index_store.read_index(), {})

    def test_index_does_not_affect_identity(self):
        """Modifying index leaves identity untouched."""
        self.index_store.write_index({"date": {"a": 1}})
        self.assertIsNone(self.identity_store.read_identity())

    def test_config_is_independent(self):
        """Config store is independent of all data stores."""
        self.config_store.write_config({"test": True})
        # Verify config doesn't leak into staging
        self.assertEqual(self.staging_store.read_entries(), [])
        # Verify staging doesn't affect config
        self.staging_store.write_entries([{"title": "x"}])
        self.assertEqual(self.config_store.read_config(), {"test": True})

    def test_all_files_created_independently(self):
        """Each store creates only its own file on first write."""
        self.staging_store.write_entries([{"t": "1"}])
        self.ledger_store.append_blocks([{"type": "genesis"}])
        self.index_store.write_index({"d": {"t": 1}})
        self.identity_store.write_identity({"user": "test"})
        self.config_store.write_config({"k": "v"})

        files = sorted(p.name for p in self.test_dir.iterdir())
        self.assertIn("staging.json", files)
        self.assertIn("ledger.json", files)
        self.assertIn("index.json", files)
        self.assertIn("identity.json", files)
        self.assertIn("config.json", files)


# =============================================================================
# Edge Cases & Error Handling
# =============================================================================

class TestStoreEdgeCases(unittest.TestCase):
    """Test edge cases common to all file-backed stores."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp(dir="/dev/shm" if os.path.exists("/dev/shm") else None))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_staging_corrupt_json_raises_error(self):
        """Corrupt staging.json raises json.JSONDecodeError."""
        path = self.test_dir / "staging.json"
        path.write_text("{invalid json}")
        store = FileStagingStore(path)
        with self.assertRaises(json.JSONDecodeError):
            store.read_entries()

    def test_ledger_corrupt_json_raises_error(self):
        """Corrupt ledger.json raises json.JSONDecodeError."""
        path = self.test_dir / "ledger.json"
        path.write_text("{invalid}")
        store = FileLedgerStore(path)
        with self.assertRaises(json.JSONDecodeError):
            store.read_blocks()

    def test_staging_remove_from_empty(self):
        """remove_entries on an empty store does not error."""
        path = self.test_dir / "staging.json"
        store = FileStagingStore(path)
        store.remove_entries([0, 1, 2])  # should not raise
        self.assertEqual(store.read_entries(), [])

    def test_ledger_truncate_empty(self):
        """truncate on an empty store returns empty list."""
        store = FileLedgerStore(self.test_dir / "ledger.json")
        removed = store.truncate(5)
        self.assertEqual(removed, [])

    def test_config_store_handles_empty_file(self):
        """Empty config.json returns None (handled by ConfigManager)."""
        path = self.test_dir / "config.json"
        path.write_text("")
        store = FileConfigStore(path)
        self.assertIsNone(store.read_config())


if __name__ == "__main__":
    unittest.main()
