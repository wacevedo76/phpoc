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
    expected = hashlib.sha256(
        json.dumps(entry["data"], sort_keys=True).encode()
    ).hexdigest()
    return entry["hash"] == expected


class TestEndHabitAt(unittest.TestCase):
    """end_habit_at() allows ending a habit at a specific past timestamp."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_end_at_specific_time(self):
        now = int(time.time() * 1000)
        start = now - 3600000
        self.ledger.capture_habit("Task", start, is_active=True)
        end_time = start + 60000
        self.ledger.end_habit_at("Task", end_time)
        staging = self.store.read_staging()
        self.assertFalse(staging[0]["data"]["is_active"])
        self.assertEqual(staging[0]["data"]["duration"], 60000)

    def test_end_at_corrects_overrun(self):
        now = int(time.time() * 1000)
        start = now - 3600000
        self.ledger.capture_habit("Overrun", start, is_active=True)
        correct_end = start + 600000
        self.ledger.end_habit_at("Overrun", correct_end)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["duration"], 600000)

    def test_end_at_with_pauses(self):
        now = int(time.time() * 1000)
        start = now - 7200000
        self.ledger.capture_habit("Paused", start, is_active=True)
        self.ledger.pause_habit("Paused", start + 600000)
        self.ledger.unpause_habit("Paused", start + 900000)
        correct_end = start + 1800000
        self.ledger.end_habit_at("Paused", correct_end)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["duration"], 1500000)

    def test_end_at_auto_unpauses(self):
        now = int(time.time() * 1000)
        start = now - 3600000
        self.ledger.capture_habit("Paused", start, is_active=True)
        self.ledger.pause_habit("Paused", start + 60000)
        end_time = start + 120000
        self.ledger.end_habit_at("Paused", end_time)
        staging = self.store.read_staging()
        self.assertFalse(staging[0]["data"]["is_active"])
        self.assertFalse(staging[0]["data"]["is_paused"])
        self.assertEqual(staging[0]["data"]["duration"], 60000)

    def test_end_at_correct_epoch_stored(self):
        now = int(time.time() * 1000)
        start = now - 3600000
        self.ledger.capture_habit("Task", start, is_active=True)
        past_time = start + 1800000
        self.ledger.end_habit_at("Task", past_time)
        staging = self.store.read_staging()
        stored_end = int(self.crypto.decrypt(staging[0]["data"]["endTime_enc"]))
        self.assertEqual(stored_end, past_time)

    def test_end_at_nonexistent_task_raises(self):
        now = int(time.time() * 1000)
        with self.assertRaises(ValueError):
            self.ledger.end_habit_at("Ghost", now)

    def test_end_at_completed_task_raises(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Done", now, now + 60000)
        with self.assertRaises(ValueError):
            self.ledger.end_habit_at("Done", now + 120000)

    def test_end_at_hash_updates(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, is_active=True)
        past_time = now + 60000
        self.ledger.end_habit_at("Task", past_time)
        staging = self.store.read_staging()
        self.assertTrue(_entry_hash_matches(staging[0]))

    def test_end_at_with_tags_preserved(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, is_active=True, tags=["work", "fix"])
        past_time = now + 60000
        self.ledger.end_habit_at("Task", past_time)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["tags"], ["fix", "work"])

    def test_end_at_with_comment(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, is_active=True)
        self.ledger.end_habit_at("Task", now + 60000, comment="Fixed overrun")
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["comment"], "Fixed overrun")


class TestGetPendingSync(unittest.TestCase):
    """get_pending_sync() returns a human-readable preview of entries ready to sync."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_pending_returns_completed_entries(self):
        now = int(time.time() * 1000)
        start = now - 3600000
        self.ledger.capture_habit("Coding", start, now)
        pending = self.ledger.get_pending_sync()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["title"], "Coding")

    def test_pending_excludes_active_tasks(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Running", now, is_active=True)
        self.ledger.capture_habit("Completed", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        titles = [p["title"] for p in pending]
        self.assertNotIn("Running", titles)
        self.assertIn("Completed", titles)

    def test_pending_excludes_paused_tasks(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Paused", now, is_active=True)
        self.ledger.pause_habit("Paused", now + 60000)
        pending = self.ledger.get_pending_sync()
        self.assertEqual(pending, [])

    def test_pending_returns_decrypted_timestamps(self):
        now = int(time.time() * 1000)
        start = now - 7200000
        end = now - 3600000
        self.ledger.capture_habit("Task", start, end)
        pending = self.ledger.get_pending_sync()
        self.assertEqual(pending[0]["start_epoch"], start)
        self.assertEqual(pending[0]["end_epoch"], end)

    def test_pending_returns_duration(self):
        now = int(time.time() * 1000)
        start = now - 3600000
        self.ledger.capture_habit("Task", start, now)
        pending = self.ledger.get_pending_sync()
        self.assertEqual(pending[0]["duration"], 3600000)

    def test_pending_returns_tags(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now, tags=["music", "work"])
        pending = self.ledger.get_pending_sync()
        self.assertEqual(pending[0]["tags"], ["music", "work"])

    def test_pending_tags_default_empty(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        self.assertEqual(pending[0]["tags"], [])

    def test_pending_returns_date(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        expected_date = time.strftime("%Y-%m-%d", time.gmtime((now - 3600000) // 1000))
        self.assertEqual(pending[0]["date"], expected_date)

    def test_pending_multiple_entries(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("First", now - 7200000, now - 3600000)
        self.ledger.capture_habit("Second", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        self.assertEqual(len(pending), 2)
        self.assertEqual(pending[0]["title"], "First")
        self.assertEqual(pending[1]["title"], "Second")

    def test_pending_empty_when_nothing_to_sync(self):
        pending = self.ledger.get_pending_sync()
        self.assertEqual(pending, [])

    def test_pending_returns_entry_index(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        self.assertIn("entry_index", pending[0])
        self.assertIsInstance(pending[0]["entry_index"], int)

    def test_pending_with_comment(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now, comment="Forgot to end")
        pending = self.ledger.get_pending_sync()
        self.assertEqual(pending[0].get("comment"), "Forgot to end")

    def test_pending_comment_default_none(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        self.assertIsNone(pending[0].get("comment"))

    def test_pending_with_media(self):
        now = int(time.time() * 1000)
        media = [{"name": "photo.jpg", "mediaType": "image/jpeg", "hash": "abc123"}]
        self.ledger.capture_habit("Task", now - 3600000, now, media=media)
        pending = self.ledger.get_pending_sync()
        self.assertEqual(pending[0]["media"], media)

    def test_pending_media_default_empty(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        self.assertEqual(pending[0]["media"], [])


class TestSyncConfirmed(unittest.TestCase):
    """sync_day_with_selection() only syncs the entries the user confirms."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_sync_all_confirmed(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("A", now - 7200000, now - 3600000)
        self.ledger.capture_habit("B", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        self.ledger.sync_day_with_selection([p["entry_index"] for p in pending])
        ledger_data = self.ledger.get_ledger_data()
        synced_titles = set()
        for day in ledger_data:
            if day.get("type") != "day": continue
            for entry in day.get("entries", []):
                synced_titles.add(entry["data"]["title"])
        self.assertEqual(synced_titles, {"A", "B"})

    def test_sync_partial_selection(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Keep", now - 7200000, now - 3600000)
        self.ledger.capture_habit("Skip", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        keep_idx = [p["entry_index"] for p in pending if p["title"] == "Keep"]
        self.ledger.sync_day_with_selection(keep_idx)
        ledger_data = self.ledger.get_ledger_data()
        synced_titles = set()
        for day in ledger_data:
            if day.get("type") != "day": continue
            for entry in day.get("entries", []):
                synced_titles.add(entry["data"]["title"])
        self.assertIn("Keep", synced_titles)
        self.assertNotIn("Skip", synced_titles)
        staging = self.store.read_staging()
        staging_titles = [e["data"]["title"] for e in staging]
        self.assertIn("Skip", staging_titles)

    def test_sync_none_selected(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        self.ledger.sync_day_with_selection([])
        ledger_data = self.ledger.get_ledger_data()
        day_count = sum(1 for d in ledger_data if d.get("type") == "day")
        self.assertEqual(day_count, 0)
        staging = self.store.read_staging()
        self.assertEqual(len(staging), 1)

    def test_sync_partial_with_active_entries(self):
        """Active entries in staging don't break index mapping for sync selection."""
        now = int(time.time() * 1000)
        # Create an active entry (no end_epoch) — should NOT be in get_pending_sync
        self.ledger.capture_habit("ActiveA", now - 7200000, is_active=True)
        self.ledger.capture_habit("Keep", now - 6000000, now - 3600000)
        # Another active entry
        self.ledger.capture_habit("ActiveB", now - 3000000, is_active=True)
        self.ledger.capture_habit("AlsoKeep", now - 1800000, now)
        pending = self.ledger.get_pending_sync()
        # Should only return the two completed entries
        self.assertEqual(len(pending), 2)
        self.assertEqual({p["title"] for p in pending}, {"Keep", "AlsoKeep"})
        # Sync all — even though active entries intersperse staging
        self.ledger.sync_day_with_selection([p["entry_index"] for p in pending])
        ledger_data = self.ledger.get_ledger_data()
        synced_titles = set()
        for day in ledger_data:
            if day.get("type") != "day": continue
            for entry in day.get("entries", []):
                synced_titles.add(entry["data"]["title"])
        self.assertEqual(synced_titles, {"Keep", "AlsoKeep"})
        # Active entries remain in staging
        staging = self.store.read_staging()
        staging_titles = [e["data"]["title"] for e in staging]
        self.assertEqual(set(staging_titles), {"ActiveA", "ActiveB"})

    def test_sync_partial_remove_with_active_entries(self):
        """Removing an entry with active entries in staging doesn't break index mapping."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Active", now - 10800000, is_active=True)
        self.ledger.capture_habit("Keep", now - 7200000, now - 3600000)
        self.ledger.capture_habit("Remove", now - 3500000, now)
        pending = self.ledger.get_pending_sync()
        self.assertEqual(len(pending), 2)
        # Only sync "Keep", exclude "Remove"
        keep_idx = [p["entry_index"] for p in pending if p["title"] == "Keep"]
        self.ledger.sync_day_with_selection(keep_idx)
        ledger_data = self.ledger.get_ledger_data()
        synced_titles = set()
        for day in ledger_data:
            if day.get("type") != "day": continue
            for entry in day.get("entries", []):
                synced_titles.add(entry["data"]["title"])
        self.assertEqual(synced_titles, {"Keep"})
        # Remove stayed in staging for optional re-edit
        staging = self.store.read_staging()
        staging_titles = [e["data"]["title"] for e in staging]
        self.assertIn("Remove", staging_titles)
        self.assertIn("Active", staging_titles)

    def test_sync_with_end_time_override(self):
        now = int(time.time() * 1000)
        start = now - 3600000
        self.ledger.capture_habit("Overrun", start, is_active=True)
        self.ledger.end_habit_at("Overrun", start + 600000)
        pending = self.ledger.get_pending_sync()
        overrides = {pending[0]["entry_index"]: {"end_epoch": start + 300000}}
        self.ledger.sync_day_with_selection(
            [pending[0]["entry_index"]],
            overrides=overrides
        )
        ledger_data = self.ledger.get_ledger_data()
        day_rec = next(d for d in ledger_data if d.get("type") == "day")
        synced = day_rec["entries"][0]["data"]
        self.assertEqual(synced["duration"], 300000)
        stored_end = int(self.crypto.decrypt(synced["endTime_enc"]))
        self.assertEqual(stored_end, start + 300000)

    def test_sync_overrides_preserve_hash(self):
        now = int(time.time() * 1000)
        start = now - 3600000
        self.ledger.capture_habit("Overrun", start, is_active=True)
        self.ledger.end_habit_at("Overrun", start + 600000)
        pending = self.ledger.get_pending_sync()
        overrides = {pending[0]["entry_index"]: {"end_epoch": start + 300000}}
        self.ledger.sync_day_with_selection(
            [pending[0]["entry_index"]],
            overrides=overrides
        )
        self.assertTrue(self.ledger.verify())

    def test_sync_with_comment_override(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        overrides = {pending[0]["entry_index"]: {"comment": "Fixed the overrun"}}
        self.ledger.sync_day_with_selection(
            [pending[0]["entry_index"]],
            overrides=overrides
        )
        ledger_data = self.ledger.get_ledger_data()
        day_rec = next(d for d in ledger_data if d.get("type") == "day")
        synced = day_rec["entries"][0]["data"]
        self.assertEqual(synced["comment"], "Fixed the overrun")

    def test_sync_comment_in_hash(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        overrides = {pending[0]["entry_index"]: {"comment": "Note"}}
        self.ledger.sync_day_with_selection(
            [pending[0]["entry_index"]],
            overrides=overrides
        )
        self.assertTrue(self.ledger.verify())

    def test_sync_with_media_override(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        media = [{"name": "proof.png", "mediaType": "image/png", "hash": "abc123"}]
        overrides = {pending[0]["entry_index"]: {"media": media}}
        self.ledger.sync_day_with_selection(
            [pending[0]["entry_index"]],
            overrides=overrides
        )
        ledger_data = self.ledger.get_ledger_data()
        day_rec = next(d for d in ledger_data if d.get("type") == "day")
        synced = day_rec["entries"][0]["data"]
        self.assertEqual(synced["media"], media)

    def test_sync_media_in_hash(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now - 3600000, now)
        pending = self.ledger.get_pending_sync()
        media = [{"name": "doc.pdf", "mediaType": "application/pdf", "hash": "xyz"}]
        overrides = {pending[0]["entry_index"]: {"media": media}}
        self.ledger.sync_day_with_selection(
            [pending[0]["entry_index"]],
            overrides=overrides
        )
        self.assertTrue(self.ledger.verify())

    def test_sync_day_still_works(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Old Task", now - 3600000, now)
        self.ledger.sync_day()
        ledger_data = self.ledger.get_ledger_data()
        day_count = sum(1 for d in ledger_data if d.get("type") == "day")
        self.assertEqual(day_count, 1)
        self.assertTrue(self.ledger.verify())

    def test_sync_confirmed_updates_index(self):
        now = int(time.time() * 1000)
        start = now - 3600000
        self.ledger.capture_habit("Task", start, now, tags=["work"])
        pending = self.ledger.get_pending_sync()
        self.ledger.sync_day_with_selection([p["entry_index"] for p in pending])
        index = self.store.read_index()
        date_str = time.strftime("%Y-%m-%d", time.gmtime(start // 1000))
        self.assertIn(date_str, index)
        self.assertIn("Task", index[date_str])


class TestComments(unittest.TestCase):
    """Comments are optional plaintext on entry data."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_capture_with_comment(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, now + 3600000, comment="Deep focus session")
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["comment"], "Deep focus session")

    def test_capture_without_comment(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, now + 3600000)
        staging = self.store.read_staging()
        self.assertNotIn("comment", staging[0]["data"])

    def test_comment_survives_sync(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, now + 3600000, comment="Good session")
        self.ledger.sync_day()
        ledger_data = self.ledger.get_ledger_data()
        day_rec = next(d for d in ledger_data if d.get("type") == "day")
        self.assertEqual(day_rec["entries"][0]["data"]["comment"], "Good session")

    def test_comment_included_in_hash(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, now + 3600000, comment="Note")
        staging = self.store.read_staging()
        self.assertTrue(_entry_hash_matches(staging[0]))

    def test_comment_survives_end_habit_at(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, is_active=True, comment="Started well")
        self.ledger.end_habit_at("Task", now + 60000, comment="Ended early")
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["comment"], "Ended early")

    def test_comment_on_end_habit(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, is_active=True)
        self.ledger.end_habit("Task", now + 60000, comment="All done")
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["comment"], "All done")

    def test_comment_on_pause(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, is_active=True)
        self.ledger.pause_habit("Task", now + 60000, comment="Phone call")
        staging = self.store.read_staging()
        pauses = json.loads(self.crypto.decrypt(staging[0]["data"]["pauses_enc"]))
        self.assertEqual(pauses[-1].get("comment"), "Phone call")

    def test_comment_on_unpause(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, is_active=True)
        self.ledger.pause_habit("Task", now + 60000)
        self.ledger.unpause_habit("Task", now + 120000, comment="Back to work")
        staging = self.store.read_staging()
        pauses = json.loads(self.crypto.decrypt(staging[0]["data"]["pauses_enc"]))
        self.assertEqual(pauses[-1].get("comment"), "Back to work")

    def test_vintage_entry_missing_comment(self):
        now = int(time.time() * 1000)
        data = {
            "title": "Vintage", "duration": 3600000,
            "is_active": False, "is_paused": False,
            "startTime_enc": self.crypto.encrypt(str(now - 3600000)),
            "endTime_enc": self.crypto.encrypt(str(now)),
            "pauses_enc": self.crypto.encrypt("[]"),
            "metadata_enc": self.crypto.encrypt("{}"),
            "tags": [],
        }
        entry = {
            "hash": hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
            "data": data, "start_epoch": now - 3600000,
        }
        self.store.write_staging([entry])
        staging = self.store.read_staging()
        self.assertIsNone(staging[0]["data"].get("comment"))

    def test_vintage_entry_verify_passes(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Old", now, now + 3600000)
        self.ledger.sync_day()
        self.assertTrue(self.ledger.verify())


class TestMediaLinks(unittest.TestCase):
    """Media links are stored as a list of {name, mediaType, hash} objects."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_capture_with_media(self):
        now = int(time.time() * 1000)
        media = [
            {"name": "photo.jpg", "mediaType": "image/jpeg", "hash": "abc123def"},
            {"name": "note.txt", "mediaType": "text/plain", "hash": "456ghi789"},
        ]
        self.ledger.capture_habit("Task", now, now + 3600000, media=media)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["media"], media)

    def test_capture_without_media(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, now + 3600000)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["media"], [])

    def test_capture_with_single_media(self):
        now = int(time.time() * 1000)
        media = [{"name": "screenshot.png", "mediaType": "image/png", "hash": "xyz789"}]
        self.ledger.capture_habit("Task", now, now + 3600000, media=media)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["media"], media)

    def test_media_survives_sync(self):
        now = int(time.time() * 1000)
        media = [{"name": "doc.pdf", "mediaType": "application/pdf", "hash": "abc123"}]
        self.ledger.capture_habit("Task", now, now + 3600000, media=media)
        self.ledger.sync_day()
        ledger_data = self.ledger.get_ledger_data()
        day_rec = next(d for d in ledger_data if d.get("type") == "day")
        self.assertEqual(day_rec["entries"][0]["data"]["media"], media)

    def test_media_included_in_hash(self):
        now = int(time.time() * 1000)
        media = [{"name": "img.jpg", "mediaType": "image/jpeg", "hash": "hash123"}]
        self.ledger.capture_habit("Task", now, now + 3600000, media=media)
        staging = self.store.read_staging()
        self.assertTrue(_entry_hash_matches(staging[0]))

    def test_media_survives_lifecycle(self):
        now = int(time.time() * 1000)
        media = [{"name": "record.wav", "mediaType": "audio/wav", "hash": "abc"}]
        self.ledger.capture_habit("Task", now, is_active=True, media=media)
        self.ledger.pause_habit("Task", now + 60000)
        self.ledger.unpause_habit("Task", now + 120000)
        self.ledger.end_habit("Task", now + 180000)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["media"], media)

    def test_media_default_empty_list(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Task", now, now + 3600000)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["media"], [])

    def test_vintage_entry_missing_media(self):
        now = int(time.time() * 1000)
        data = {
            "title": "Vintage", "duration": 3600000,
            "is_active": False, "is_paused": False,
            "startTime_enc": self.crypto.encrypt(str(now - 3600000)),
            "endTime_enc": self.crypto.encrypt(str(now)),
            "pauses_enc": self.crypto.encrypt("[]"),
            "metadata_enc": self.crypto.encrypt("{}"),
            "tags": [],
        }
        entry = {
            "hash": hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
            "data": data, "start_epoch": now - 3600000,
        }
        self.store.write_staging([entry])
        staging = self.store.read_staging()
        media = staging[0]["data"].get("media", [])
        self.assertEqual(media, [])

    def test_media_hash_includes_all_fields(self):
        now = int(time.time() * 1000)
        media1 = [{"name": "a.jpg", "mediaType": "image/jpeg", "hash": "h1"}]
        media2 = [{"name": "b.jpg", "mediaType": "image/jpeg", "hash": "h1"}]
        h1 = self.ledger.capture_habit("Task", now, now + 1000, media=media1)
        h2 = self.ledger.capture_habit("Task", now + 1, now + 1001, media=media2)
        self.assertNotEqual(h1, h2)

    def test_multiple_media_links(self):
        now = int(time.time() * 1000)
        media = [
            {"name": "a.png", "mediaType": "image/png", "hash": "h1"},
            {"name": "b.png", "mediaType": "image/png", "hash": "h2"},
            {"name": "c.png", "mediaType": "image/png", "hash": "h3"},
        ]
        self.ledger.capture_habit("Task", now, now + 3600000, media=media)
        staging = self.store.read_staging()
        self.assertEqual(len(staging[0]["data"]["media"]), 3)


class TestRevertEntries(unittest.TestCase):
    """revert_entries() truncates blocks from the end of the ledger."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def _sync_entries(self, *titles_with_times):
        """Helper: sync a set of (title, start_offset_ms, end_offset_ms) entries."""
        now = int(time.time() * 1000)
        for title, start_off, end_off in titles_with_times:
            self.ledger.capture_habit(title, now + start_off, now + end_off)
        pending = self.ledger.get_pending_sync()
        if pending:
            self.ledger.sync_day_with_selection([p["entry_index"] for p in pending])

    def _synced_titles(self):
        """Return set of titles currently in the ledger."""
        titles = set()
        for block in self.ledger.get_ledger_data():
            if block.get("type", "day") == "day":
                for entry in block.get("entries", []):
                    titles.add(entry["data"]["title"])
        return titles

    def test_revert_last_block(self):
        self._sync_entries(
            ("Keep", -7200000, -3600000),
            ("Remove", -3600000, 0),
        )
        self.assertTrue(self.ledger.verify())

        count = self.ledger.revert_entries(1)
        self.assertEqual(count, 2)  # both entries in the last day block
        self.assertEqual(self._synced_titles(), set())
        self.assertTrue(self.ledger.verify())

        # Entries were restored to staging
        staging = self.store.read_staging()
        self.assertEqual({e["data"]["title"] for e in staging}, {"Keep", "Remove"})

    def test_revert_two_blocks_keeps_earlier(self):
        # Sync day 1
        self._sync_entries(("Keep", -90000000, -86400000))
        # Sync day 2
        self._sync_entries(("Remove", -40000000, -36000000))

        count = self.ledger.revert_entries(1)
        self.assertEqual(count, 1)
        self.assertEqual(self._synced_titles(), {"Keep"})
        self.assertTrue(self.ledger.verify())

        staging = self.store.read_staging()
        self.assertIn("Remove", {e["data"]["title"] for e in staging})

    def test_revert_all_returns_empty_ledger(self):
        self._sync_entries(("A", -7200000, -3600000))
        self._sync_entries(("B", -3600000, 0))

        count = self.ledger.revert_entries(2)
        self.assertEqual(count, 2)
        self.assertEqual(self._synced_titles(), set())
        self.assertTrue(self.ledger.verify())

    def test_revert_too_many_returns_minus_one(self):
        self._sync_entries(("A", -3600000, 0))
        count = self.ledger.revert_entries(99)
        self.assertEqual(count, -1)
        self.assertEqual(self._synced_titles(), {"A"})

    def test_revert_zero_does_nothing(self):
        self._sync_entries(("A", -3600000, 0))
        count = self.ledger.revert_entries(0)
        self.assertEqual(count, 0)
        self.assertEqual(self._synced_titles(), {"A"})


if __name__ == "__main__":
    unittest.main()
