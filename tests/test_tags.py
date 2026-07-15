import unittest
import json
import time
import os
import shutil
import tempfile
import hashlib
from pathlib import Path
from core.ledger import LedgerDomain
from security.crypto import CryptoManager, NoAuthCryptoManager
from security.recovery import RecoveryManager
from storage.file_store import LedgerStore
from core.factory import LedgerFactory
from cli.interface import CLIInterface


def _setup_ledger(test_dir):
    """Shared setup: create a fresh ledger with a test identity."""
    staging_file = test_dir / "staging.json"
    ledger_file = test_dir / "ledger.json"
    identity_file = test_dir / "identity.json"
    index_file = test_dir / "index.json"

    pdk = hashlib.pbkdf2_hmac('sha256', b"test-pass", b"session-salt", 100, 32)
    identity_secret = os.urandom(32)

    seed = LedgerFactory.initialize(
        ledger_file, pdk, "testuser", "test@example.com",
        identity_secret=identity_secret
    )
    mk = RecoveryManager.seed_to_key(seed)
    crypto = CryptoManager(mk)
    store = LedgerStore(staging_file, ledger_file, index_file)
    ledger = LedgerDomain(crypto, store)
    return ledger, crypto, store, staging_file, ledger_file, index_file


def _entry_hash_matches(entry):
    """Check that entry['hash'] matches entry['data']."""
    expected = hashlib.sha256(
        json.dumps(entry["data"], sort_keys=True).encode()
    ).hexdigest()
    return entry["hash"] == expected


# =========================================================================
# PART 1: TAGS
# =========================================================================

# -----------------------------------------------------------------------
# Core tag storage -- capture_habit with tags
# -----------------------------------------------------------------------

class TestTagsCapture(unittest.TestCase):
    """Tags are stored correctly on capture_habit."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_capture_with_tags(self):
        """capture_habit stores tags as a plaintext list."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Coding", now, now + 3600000, tags=["work", "coding"])
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["coding", "work"])

    def test_capture_without_tags(self):
        """capture_habit stores an empty list when no tags given."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("No tags", now, now + 1000)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], [])

    def test_capture_with_empty_tags(self):
        """Passing tags=[] stores an empty list."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Empty", now, now + 1000, tags=[])
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], [])

    def test_tags_default_to_empty_list(self):
        """When tags kwarg is not passed, default is empty list."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Default", now, now + 1000)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], [])

    def test_capture_preserves_tags_across_multiple_entries(self):
        """Each entry has its own tags list."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Work", now, now + 1000, tags=["work"])
        self.ledger.capture_habit("Play", now + 1000, now + 2000, tags=["fun", "play"])
        staging = self.store.read_staging()
        tags_by_title = {e["data"]["title"]: e["data"]["tags"] for e in staging}
        self.assertEqual(tags_by_title["Work"], ["work"])
        self.assertEqual(tags_by_title["Play"], ["fun", "play"])


# -----------------------------------------------------------------------
# Tag normalization
# -----------------------------------------------------------------------

class TestTagsNormalization(unittest.TestCase):
    """Tags are lowercased, stripped, and deduplicated automatically."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_tags_lowered(self):
        """Tags are converted to lowercase."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Test", now, now + 1000, tags=["MUSIC", "Coding", "FuN"])
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["coding", "fun", "music"])

    def test_tags_deduplicated(self):
        """Duplicate tags (identical after lowering) are removed."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Test", now, now + 1000,
                                  tags=["music", "Music", "MUSIC", "coding", "Coding"])
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["coding", "music"])

    def test_tags_stripped(self):
        """Whitespace around tags is stripped."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Test", now, now + 1000,
                                  tags=["  music ", "coding  ", "  deep work  "])
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["coding", "deep work", "music"])

    def test_tags_empty_strings_removed(self):
        """Empty or whitespace-only tag strings are dropped."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Test", now, now + 1000,
                                  tags=["", "  ", "valid"])
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["valid"])


# -----------------------------------------------------------------------
# Tags with active tasks & pause/unpause/end lifecycle
# -----------------------------------------------------------------------

class TestTagsActiveTasks(unittest.TestCase):
    """Tags are preserved through start -> pause -> unpause -> end lifecycle."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_tags_survive_pause_unpause(self):
        """Tags persist through pause/unpause cycles."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Deep Work", now, is_active=True, tags=["focus"])
        self.ledger.pause_habit("Deep Work", now + 60000)
        self.ledger.unpause_habit("Deep Work", now + 90000)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["focus"])

    def test_tags_survive_end(self):
        """Tags persist when a task is ended."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Deep Work", now, is_active=True, tags=["focus"])
        self.ledger.end_habit("Deep Work", now + 60000)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["focus"])

    def test_tags_survive_multiple_pause_cycles(self):
        """Tags survive three pause/unpause cycles followed by end."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Gym", now, is_active=True,
                                  tags=["health", "fitness"])
        for i in range(3):
            self.ledger.pause_habit("Gym", now + (i * 20000) + 10000)
            self.ledger.unpause_habit("Gym", now + (i * 20000) + 20000)
        self.ledger.end_habit("Gym", now + 70000)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["fitness", "health"])


# -----------------------------------------------------------------------
# Tags survive sync into the ledger
# -----------------------------------------------------------------------

class TestTagsSync(unittest.TestCase):
    """Tags are preserved through sync and verify."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_tags_survive_sync(self):
        """Tags are present after sync."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Coding", now, now + 3600000, tags=["work", "coding"])
        self.ledger.sync_day()

        ledger_data = self.store.read_ledger()
        day_rec = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        data = day_rec["entries"][0]["data"]
        self.assertEqual(data["tags"], ["coding", "work"])

    def test_tags_survive_sync_with_pauses(self):
        """Tags coexist with pauses through sync."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Deep Work", now, is_active=True, tags=["focus", "solo"])
        self.ledger.pause_habit("Deep Work", now + 60000)
        self.ledger.unpause_habit("Deep Work", now + 90000)
        self.ledger.end_habit("Deep Work", now + 150000)
        self.ledger.sync_day()

        ledger_data = self.store.read_ledger()
        day_rec = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        data = day_rec["entries"][0]["data"]
        self.assertEqual(data["tags"], ["focus", "solo"])
        self.assertIn("pauses_enc", data)

    def test_synced_entry_hash_includes_tags(self):
        """The entry hash in the synced ledger includes the tags field."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Tagged", now, now + 1000, tags=["a", "b"])
        self.ledger.sync_day()

        ledger_data = self.store.read_ledger()
        day_rec = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        entry = day_rec["entries"][0]
        self.assertTrue(_entry_hash_matches(entry),
                        "Hash should include tags field")

    def test_tags_survive_sync_with_multiple_tagged_entries(self):
        """Multiple entries with different tags all survive sync."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Work", now, now + 1000, tags=["work"])
        self.ledger.capture_habit("Gym", now + 1000, now + 2000, tags=["health"])
        self.ledger.sync_day()

        ledger_data = self.store.read_ledger()
        day_rec = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        titles = {e["data"]["title"]: e["data"]["tags"] for e in day_rec["entries"]}
        self.assertEqual(titles["Work"], ["work"])
        self.assertEqual(titles["Gym"], ["health"])


# -----------------------------------------------------------------------
# Backward compatibility -- old entries without tags
# -----------------------------------------------------------------------

class TestTagsBackwardCompat(unittest.TestCase):
    """Entries created before the tags feature don't break anything."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)
        id_path = self.test_dir / "identity.json"
        enc_secret = json.loads(id_path.read_text())["identity_secret_enc"]
        self.identity_secret = bytes.fromhex(self.crypto.decrypt(enc_secret))

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def _inject_old_entry(self, extra_fields=None):
        """Create a staging entry without 'tags' (pre-tags format)."""
        now = int(time.time() * 1000)
        data = {
            "title": "Old Task",
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
            "startTime_enc": self.crypto.encrypt(str(now - 3600000)),
            "endTime_enc": self.crypto.encrypt(str(now)),
            "pauses_enc": self.crypto.encrypt("[]"),
            "metadata_enc": self.crypto.encrypt("{}"),
        }
        if extra_fields:
            data.update(extra_fields)
        entry = {
            "hash": hashlib.sha256(json.dumps(data, sort_keys=True, indent=2).encode()).hexdigest(),
            "data": data,
            "start_epoch": now - 3600000,
        }
        self.store.write_staging([entry])

    def test_old_entry_tags_field_missing(self):
        """An old entry has no 'tags' key."""
        self._inject_old_entry()
        staging = self.store.read_staging()
        self.assertNotIn("tags", staging[0]["data"])

    def test_old_entry_tags_get_default(self):
        """Reading tags from an old entry safely returns empty list."""
        self._inject_old_entry()
        staging = self.store.read_staging()
        tags = staging[0]["data"].get("tags", [])
        self.assertEqual(tags, [])

    def test_old_entry_end_habit_works(self):
        """End habit on an old entry (without tags) works."""
        self._inject_old_entry({"is_active": True, "duration": 0})
        now = int(time.time() * 1000)
        self.ledger.end_habit("Old Task", now)
        staging = self.store.read_staging()
        self.assertFalse(staging[0]["data"]["is_active"])

    def test_old_entry_pause_habit_works(self):
        """Pause habit on an old active entry works."""
        self._inject_old_entry({"is_active": True, "duration": 0})
        now = int(time.time() * 1000)
        self.ledger.pause_habit("Old Task", now)
        staging = self.store.read_staging()
        self.assertTrue(staging[0]["data"]["is_paused"])

    def test_old_entry_sync_works(self):
        """Syncing an old entry (without tags) works."""
        self._inject_old_entry()
        self.ledger.sync_day()
        self.assertTrue(self.ledger.verify())

    def test_verify_passes(self):
        """Synced blocks without tags verify correctly."""
        now = int(time.time() * 1000)
        date_str = time.strftime("%Y-%m-%d", time.gmtime(now // 1000))
        data = {
            "title": "Old Synced",
            "duration": 7200000,
            "is_active": False,
            "is_paused": False,
            "startTime_enc": self.crypto.encrypt(str(now - 7200000)),
            "endTime_enc": self.crypto.encrypt(str(now)),
            "pauses_enc": self.crypto.encrypt("[]"),
            "metadata_enc": self.crypto.encrypt("{}"),
        }
        entry = {
            "hash": hashlib.sha256(json.dumps(data, sort_keys=True, indent=2).encode()).hexdigest(),
            "data": data,
        }
        genesis = json.loads(self.lf.read_text())[0]
        genesis_hash = genesis.get("block_hash") or genesis.get("day_hash")
        day_block = {
            "type": "day",
            "day_index": 1,
            "date": date_str,
            "prev_hash": genesis_hash,
            "entries": [entry],
        }
        day_json = json.dumps(day_block, sort_keys=True)
        day_block["day_hash"] = self.crypto.seal(day_json)
        day_block["identity_seal"] = self.crypto.mac(
            day_block["day_hash"], self.identity_secret
        )
        self.lf.write_text(json.dumps([genesis, day_block], indent=2))
        self.assertTrue(self.ledger.verify())


# -----------------------------------------------------------------------
# Entry hash integrity with tags
# -----------------------------------------------------------------------

class TestTagsHashIntegrity(unittest.TestCase):
    """The 'tags' field is included in entry hash computation."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_hash_includes_tags(self):
        """Entry hash is computed from all data including tags."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Test", now, now + 1000, tags=["a", "b"])
        staging = self.store.read_staging()
        self.assertTrue(_entry_hash_matches(staging[0]))

    def test_hash_differs_when_tags_differ(self):
        """Changing tags changes the entry hash."""
        now = int(time.time() * 1000)
        h1 = self.ledger.capture_habit("Same", now, now + 1000, tags=["a"])
        h2 = self.ledger.capture_habit("Same", now + 1, now + 1001, tags=["b"])
        self.assertNotEqual(h1, h2)

    def test_hash_stable_with_same_tags(self):
        """Same data (including tags) produces the same hash prefix."""
        now = int(time.time() * 1000)
        h = self.ledger.capture_habit("Stable", now, now + 1000, tags=["x", "y"])
        staging = self.store.read_staging()
        data_clone = staging[0]["data"].copy()
        expected_hash = hashlib.sha256(
            json.dumps(data_clone, sort_keys=True).encode()
        ).hexdigest()[:10]
        self.assertEqual(h, expected_hash)


# -----------------------------------------------------------------------
# Tag listing (main.py tags logic)
# -----------------------------------------------------------------------

class TestTagsListing(unittest.TestCase):
    """Collecting all unique tags from staging and synced entries."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def _get_all_tags(self):
        """Simulates main.py tags logic."""
        all_tags = set()
        staging = self.store.read_staging()
        for entry in staging:
            all_tags.update(entry["data"].get("tags", []))
        ledger_data = self.store.read_ledger()
        for day in ledger_data:
            if day.get("type") != "day":
                continue
            for entry in day.get("entries", []):
                all_tags.update(entry["data"].get("tags", []))
        return sorted(all_tags)

    def test_list_tags_from_staging(self):
        """Staging entries contribute tags."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task 1", now, now + 1000, tags=["alpha", "beta"])
        self.ledger.capture_habit("Task 2", now + 1000, now + 2000, tags=["beta", "gamma"])
        self.assertEqual(self._get_all_tags(), ["alpha", "beta", "gamma"])

    def test_list_tags_from_synced(self):
        """Synced entries contribute tags."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, now + 1000, tags=["synced-tag"])
        self.ledger.sync_day()
        self.assertEqual(self._get_all_tags(), ["synced-tag"])

    def test_list_tags_combined_sources(self):
        """Tags from both staging and synced are merged."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Old", now, now + 1000, tags=["old-tag"])
        self.ledger.sync_day()
        self.ledger.capture_habit("New", now + 1000, now + 2000, tags=["new-tag"])
        self.assertEqual(self._get_all_tags(), ["new-tag", "old-tag"])

    def test_list_tags_empty(self):
        """No entries means no tags."""
        self.assertEqual(self._get_all_tags(), [])

    def test_list_tags_deduplicated(self):
        """Same tag across multiple entries appears once."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("A", now, now + 1000, tags=["common"])
        self.ledger.capture_habit("B", now + 1000, now + 2000, tags=["common"])
        self.assertEqual(self._get_all_tags(), ["common"])

    def test_list_tags_from_active_tasks(self):
        """Active (not yet ended) tasks also contribute tags."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Active", now, is_active=True, tags=["running"])
        self.assertEqual(self._get_all_tags(), ["running"])

    def test_list_tags_excludes_empty_tags(self):
        """Entries with empty tags list don't add garbage."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("None", now, now + 1000)
        self.assertEqual(self._get_all_tags(), [])


# -----------------------------------------------------------------------
# Tags on oneoff
# -----------------------------------------------------------------------

class TestTagsOneoff(unittest.TestCase):
    """Tags work with oneoff captured habits."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_oneoff_with_tags(self):
        """Oneoff capture stores tags correctly."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Coding", now, now + 3600000, is_active=False,
                                  tags=["work", "development"])
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["development", "work"])

    def test_oneoff_without_tags(self):
        """Oneoff capture without tags stores empty list."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Coding", now, now + 3600000, is_active=False)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], [])


# =========================================================================
# PART 2: HABIT IDs
# =========================================================================

# -----------------------------------------------------------------------
# Resolve identifier: title string vs integer ID
# -----------------------------------------------------------------------

class TestHabitIdResolution(unittest.TestCase):
    """
    CLIInterface methods (add_end, add_pause, add_unpause) accept both
    a title string and an integer ID (1-based position in active staging list).
    """

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)
        from domain.staging.service import StagingService
        from storage.implementations.file_staging import FileStagingStore
        from domain.ledger.engine import LedgerEngine
        staging_store = FileStagingStore(Path(self.sf))
        self.staging_service = StagingService(crypto=self.crypto, staging_store=staging_store)
        self.ledger_engine = LedgerEngine(
            crypto=self.crypto, store=self.store, index_store=self.store,
            staging_store=staging_store)
        self.cli = CLIInterface(self.staging_service, self.ledger_engine, self.crypto)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_resolve_title_by_string(self):
        """A non-numeric string resolves to the title directly."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Deep Work", now, is_active=True)
        resolved = self.cli._resolve_title("Deep Work")
        self.assertEqual(resolved, "Deep Work")

    def test_resolve_title_by_id_single(self):
        """ID 1 resolves to the first active task."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("First", now, is_active=True)
        resolved = self.cli._resolve_title("1")
        self.assertEqual(resolved, "First")

    def test_resolve_title_by_id_among_multiple(self):
        """IDs correctly map to positions."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("First", now, is_active=True)
        self.ledger.capture_habit("Second", now + 1000, is_active=True)
        self.ledger.capture_habit("Third", now + 2000, is_active=True)
        self.assertEqual(self.cli._resolve_title("1"), "First")
        self.assertEqual(self.cli._resolve_title("2"), "Second")
        self.assertEqual(self.cli._resolve_title("3"), "Third")

    def test_resolve_title_by_id_out_of_range(self):
        """An ID larger than the number of active tasks raises ValueError."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Only", now, is_active=True)
        with self.assertRaises(ValueError):
            self.cli._resolve_title("2")
        with self.assertRaises(ValueError):
            self.cli._resolve_title("0")

    def test_resolve_title_by_id_with_no_active_tasks(self):
        """Any ID when no active tasks raises ValueError."""
        with self.assertRaises(ValueError):
            self.cli._resolve_title("1")

    def test_resolve_title_ignores_inactive_tasks(self):
        """IDs only count active tasks, not completed ones."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Done", now, now + 1000)
        self.ledger.capture_habit("Active", now + 1000, is_active=True)
        self.assertEqual(self.cli._resolve_title("1"), "Active")

    def test_resolve_title_mixed_active_and_paused(self):
        """IDs include both running and paused active tasks."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Running", now, is_active=True)
        self.ledger.capture_habit("Paused", now + 1000, is_active=True)
        self.ledger.pause_habit("Paused", now + 2000)
        self.assertEqual(self.cli._resolve_title("1"), "Running")
        self.assertEqual(self.cli._resolve_title("2"), "Paused")

    def test_resolve_title_by_string_takes_precedence(self):
        """Title match wins over ID when both match."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("1", now, is_active=True)
        resolved = self.cli._resolve_title("1")
        self.assertEqual(resolved, "1")

    def test_ids_renumber_after_end(self):
        """After ending a task, IDs renumber."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("First", now, is_active=True)
        self.ledger.capture_habit("Second", now + 1000, is_active=True)
        self.ledger.capture_habit("Third", now + 2000, is_active=True)
        self.ledger.end_habit("Second", now + 3000)
        resolved = self.cli._resolve_title("2")
        self.assertEqual(resolved, "Third")

    def test_ids_renumber_after_pause(self):
        """Pause does not change ID numbering."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Running", now, is_active=True)
        self.ledger.capture_habit("WillPause", now + 1000, is_active=True)
        self.ledger.pause_habit("WillPause", now + 2000)
        resolved = self.cli._resolve_title("2")
        self.assertEqual(resolved, "WillPause")

    def test_negative_id_raises(self):
        """Negative IDs are invalid."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, is_active=True)
        with self.assertRaises(ValueError):
            self.cli._resolve_title("-1")

    def test_non_integer_string_resolves_as_title(self):
        """Non-numeric string resolves as title."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("abc", now, is_active=True)
        resolved = self.cli._resolve_title("abc")
        self.assertEqual(resolved, "abc")


# -----------------------------------------------------------------------
# View exposes IDs alongside active tasks
# -----------------------------------------------------------------------

class TestHabitIdView(unittest.TestCase):

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)
        from domain.staging.service import StagingService
        from storage.implementations.file_staging import FileStagingStore
        from domain.ledger.engine import LedgerEngine
        staging_store = FileStagingStore(Path(self.sf))
        self.staging_service = StagingService(crypto=self.crypto, staging_store=staging_store)
        self.ledger_engine = LedgerEngine(
            crypto=self.crypto, store=self.store, index_store=self.store,
            staging_store=staging_store)
        self.cli = CLIInterface(self.staging_service, self.ledger_engine, self.crypto)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_view_shows_ids(self):
        """_get_active_with_ids() returns IDs and titles."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task A", now, is_active=True)
        self.ledger.capture_habit("Task B", now + 1000, is_active=True)
        active_list = self.cli._get_active_with_ids()
        self.assertEqual(len(active_list), 2)
        self.assertEqual(active_list[0]["id"], 1)
        self.assertEqual(active_list[0]["title"], "Task A")
        self.assertEqual(active_list[1]["id"], 2)
        self.assertEqual(active_list[1]["title"], "Task B")

    def test_view_shows_id_for_single_task(self):
        """Single active task gets ID 1."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Solo", now, is_active=True)
        active_list = self.cli._get_active_with_ids()
        self.assertEqual(len(active_list), 1)
        self.assertEqual(active_list[0]["id"], 1)

    def test_view_ids_reset_after_end(self):
        """IDs reset when a task in the middle is ended."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("A", now, is_active=True)
        self.ledger.capture_habit("B", now + 1000, is_active=True)
        self.ledger.capture_habit("C", now + 2000, is_active=True)
        self.ledger.end_habit("B", now + 3000)
        active_list = self.cli._get_active_with_ids()
        self.assertEqual(len(active_list), 2)
        self.assertEqual(active_list[0]["id"], 1)
        self.assertEqual(active_list[0]["title"], "A")
        self.assertEqual(active_list[1]["id"], 2)
        self.assertEqual(active_list[1]["title"], "C")

    def test_view_ids_include_paused_tasks(self):
        """Paused tasks still have IDs."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Running", now, is_active=True)
        self.ledger.capture_habit("Paused", now + 1000, is_active=True)
        self.ledger.pause_habit("Paused", now + 2000)
        active_list = self.cli._get_active_with_ids()
        self.assertEqual(len(active_list), 2)
        self.assertEqual(active_list[1]["title"], "Paused")

    def test_view_no_active_tasks(self):
        """No active tasks returns an empty list."""
        self.assertEqual(self.cli._get_active_with_ids(), [])


# -----------------------------------------------------------------------
# Habit IDs work end-to-end via CLI methods
# -----------------------------------------------------------------------

class TestHabitIdCLI(unittest.TestCase):
    """The CLI methods accept and route IDs correctly."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)
        from domain.staging.service import StagingService
        from storage.implementations.file_staging import FileStagingStore
        from domain.ledger.engine import LedgerEngine
        staging_store = FileStagingStore(Path(self.sf))
        self.staging_service = StagingService(crypto=self.crypto, staging_store=staging_store)
        self.ledger_engine = LedgerEngine(
            crypto=self.crypto, store=self.store, index_store=self.store,
            staging_store=staging_store)
        self.cli = CLIInterface(self.staging_service, self.ledger_engine, self.crypto)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_add_end_by_id(self):
        """add_end accepts an ID string and ends the correct task."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Keep", now, is_active=True)
        self.ledger.capture_habit("EndMe", now + 1000, is_active=True)
        self.cli.add_end("1")
        staging = self.store.read_staging()
        remaining = [e for e in staging if e["data"].get("is_active")]
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["data"]["title"], "EndMe")

    def test_add_pause_by_id(self):
        """add_pause accepts an ID string and pauses the correct task."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("PauseMe", now, is_active=True)
        self.ledger.capture_habit("LeaveAlone", now + 1000, is_active=True)
        self.cli.add_pause("1")
        staging = self.store.read_staging()
        paused = [e for e in staging if e["data"].get("is_paused")]
        self.assertEqual(len(paused), 1)
        self.assertEqual(paused[0]["data"]["title"], "PauseMe")

    def test_add_unpause_by_id(self):
        """add_unpause accepts an ID string and unpauses the correct task."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Paused", now, is_active=True)
        self.ledger.capture_habit("Running", now + 1000, is_active=True)
        self.ledger.pause_habit("Paused", now + 2000)
        self.cli.add_unpause("1")
        staging = self.store.read_staging()
        still_paused = [e for e in staging if e["data"].get("is_paused")]
        self.assertEqual(len(still_paused), 0)

    def test_add_end_by_title_still_works(self):
        """add_end still works with full title strings."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Deep Work", now, is_active=True)
        self.cli.add_end("Deep Work")
        staging = self.store.read_staging()
        self.assertFalse(staging[0]["data"]["is_active"])

    def test_add_pause_by_title_still_works(self):
        """add_pause still works with full title strings."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Deep Work", now, is_active=True)
        self.cli.add_pause("Deep Work")
        staging = self.store.read_staging()
        self.assertTrue(staging[0]["data"]["is_paused"])

    def test_add_unpause_by_title_still_works(self):
        """add_unpause still works with full title strings."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Deep Work", now, is_active=True)
        self.ledger.pause_habit("Deep Work", now + 1000)
        self.cli.add_unpause("Deep Work")
        staging = self.store.read_staging()
        self.assertFalse(staging[0]["data"]["is_paused"])


if __name__ == "__main__":
    unittest.main()