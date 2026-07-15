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


# =============================================================================
# Core pause/unpause logic — LedgerDomain methods
# =============================================================================

class TestPauseHabit(unittest.TestCase):
    """Tests for LedgerDomain.pause_habit() and unpause_habit()."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    # -- Happy paths ----------------------------------------------------------

    def test_pause_and_unpause_updates_state(self):
        """Start → pause → unpause: is_paused toggles, pauses_enc grows."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Work", now, is_active=True)

        # Pause
        pause_ts = now + 60000
        self.ledger.pause_habit("Work", pause_ts)

        staging = self.store.read_staging()
        entry = staging[0]["data"]
        self.assertTrue(entry["is_active"])
        self.assertTrue(entry["is_paused"])

        pauses = json.loads(self.crypto.decrypt(entry["pauses_enc"]))
        self.assertEqual(len(pauses), 1)
        self.assertEqual(pauses[0]["pause_index"], 1)
        self.assertEqual(pauses[0]["pause_start"], pause_ts)
        self.assertIsNone(pauses[0]["pause_stop"])

        # Unpause
        unpause_ts = pause_ts + 30000
        self.ledger.unpause_habit("Work", unpause_ts)

        staging = self.store.read_staging()
        entry = staging[0]["data"]
        self.assertTrue(entry["is_active"])
        self.assertFalse(entry["is_paused"])

        pauses = json.loads(self.crypto.decrypt(entry["pauses_enc"]))
        self.assertEqual(len(pauses), 1)
        self.assertEqual(pauses[0]["pause_stop"], unpause_ts)

    def test_multiple_pause_cycles(self):
        """Three pause/unpause cycles produce three intervals with correct indices."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Coding", now, is_active=True)

        intervals = [
            (now + 10000, now + 20000),    # pause 1
            (now + 30000, now + 40000),    # pause 2
            (now + 50000, now + 60000),    # pause 3
        ]

        for pause_start, pause_end in intervals:
            self.ledger.pause_habit("Coding", pause_start)
            self.ledger.unpause_habit("Coding", pause_end)

        staging = self.store.read_staging()
        pauses = json.loads(self.crypto.decrypt(staging[0]["data"]["pauses_enc"]))

        self.assertEqual(len(pauses), 3)
        for i, (ps, pe) in enumerate(intervals):
            self.assertEqual(pauses[i]["pause_index"], i + 1)
            self.assertEqual(pauses[i]["pause_start"], ps)
            self.assertEqual(pauses[i]["pause_stop"], pe)

    def test_pause_then_end_auto_unpauses(self):
        """Ending a paused task should auto-unpause and produce correct duration."""
        now = int(time.time() * 1000)
        start_ts = now
        pause_start = now + 60000
        end_ts = now + 120000

        self.ledger.capture_habit("Reading", start_ts, is_active=True)
        self.ledger.pause_habit("Reading", pause_start)
        self.ledger.end_habit("Reading", end_ts)

        staging = self.store.read_staging()
        entry = staging[0]["data"]

        self.assertFalse(entry["is_active"])
        self.assertFalse(entry["is_paused"])

        pauses = json.loads(self.crypto.decrypt(entry["pauses_enc"]))
        self.assertEqual(len(pauses), 1)
        self.assertEqual(pauses[0]["pause_stop"], end_ts)

        # Total wall time: 120s. Pause time: 60s (pause_start to end).
        # Active duration: 60s = 60000ms
        self.assertEqual(entry["duration"], 60000)

    def test_duration_excludes_pause_time(self):
        """Duration equals wall time minus all pause intervals."""
        now = int(time.time() * 1000)
        start_ts = now
        self.ledger.capture_habit("Gym", start_ts, is_active=True)

        # Work out for 30min, pause 10min, work out 20min more
        self.ledger.pause_habit("Gym", start_ts + 1800000)     # pause at 30min
        self.ledger.unpause_habit("Gym", start_ts + 2400000)    # unpause at 40min
        self.ledger.end_habit("Gym", start_ts + 3600000)        # end at 60min

        staging = self.store.read_staging()
        duration = staging[0]["data"]["duration"]

        # Active: 30min (0→30) + 20min (40→60) = 50min = 3000000ms
        self.assertEqual(duration, 3000000)

    # -- Error paths ----------------------------------------------------------

    def test_pause_already_paused_raises(self):
        """Pausing a task that is already paused raises ValueError."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Reading", now, is_active=True)
        self.ledger.pause_habit("Reading", now + 10000)
        with self.assertRaises(ValueError):
            self.ledger.pause_habit("Reading", now + 20000)

    def test_unpause_not_paused_raises(self):
        """Unpausing a task that is running (not paused) raises ValueError."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Reading", now, is_active=True)
        with self.assertRaises(ValueError):
            self.ledger.unpause_habit("Reading", now + 10000)

    def test_unpause_completed_task_raises(self):
        """Unpausing a task that is already ended raises ValueError."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Quick", now, now + 10000)
        with self.assertRaises(ValueError):
            self.ledger.unpause_habit("Quick", now + 20000)

    def test_pause_nonexistent_task_raises(self):
        """Pausing a task that has never been started raises ValueError."""
        now = int(time.time() * 1000)
        with self.assertRaises(ValueError):
            self.ledger.pause_habit("NeverStarted", now)

    def test_pause_completed_task_raises(self):
        """Pausing a task that is already ended raises ValueError."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Done", now, now + 10000)
        with self.assertRaises(ValueError):
            self.ledger.pause_habit("Done", now + 20000)


# =============================================================================
# Duration calculation integrity
# =============================================================================

class TestPauseDuration(unittest.TestCase):
    """Duration is computed correctly in all scenarios."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_no_pauses_duration_unchanged(self):
        """Without any pauses, duration equals end - start (same as before)."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Work", now, now + 3600000)
        staging = self.store.read_staging()
        self.assertEqual(staging[0]["data"]["duration"], 3600000)

    def test_duration_after_sync_matches_staged(self):
        """After sync, the ledger entry duration matches the staging duration."""
        now = int(time.time() * 1000)
        start_ts = now
        self.ledger.capture_habit("Coding", start_ts, is_active=True)
        self.ledger.pause_habit("Coding", start_ts + 60000)
        self.ledger.unpause_habit("Coding", start_ts + 90000)
        self.ledger.end_habit("Coding", start_ts + 150000)

        staged_duration = self.store.read_staging()[0]["data"]["duration"]

        self.ledger.sync_day()
        ledger_data = self.store.read_ledger()
        day_rec = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        synced_duration = day_rec["entries"][0]["data"]["duration"]

        self.assertEqual(synced_duration, staged_duration)
        self.assertTrue(self.ledger.verify())

    def test_blind_index_reflects_active_time(self):
        """The blind index stores active-only duration, not wall time."""
        now = int(time.time() * 1000)
        start_ts = now
        self.ledger.capture_habit("Gym", start_ts, is_active=True)
        self.ledger.pause_habit("Gym", start_ts + 1800000)     # pause at 30min
        self.ledger.unpause_habit("Gym", start_ts + 2400000)    # unpause at 40min
        self.ledger.end_habit("Gym", start_ts + 3600000)        # end at 60min
        self.ledger.sync_day()

        index_data = json.loads(self.ixf.read_text())
        date_str = time.strftime("%Y-%m-%d", time.gmtime(start_ts // 1000))
        self.assertEqual(index_data[date_str]["Gym"], 3000000)  # 50min active

    def test_zero_duration_pause(self):
        """A pause with zero duration (start == stop) should not affect duration."""
        now = int(time.time() * 1000)
        start_ts = now
        self.ledger.capture_habit("Instant", start_ts, is_active=True)
        self.ledger.pause_habit("Instant", start_ts + 1000)
        self.ledger.unpause_habit("Instant", start_ts + 1000)   # 0ms pause
        self.ledger.end_habit("Instant", start_ts + 5000)

        pauses = json.loads(self.crypto.decrypt(
            self.store.read_staging()[0]["data"]["pauses_enc"]
        ))
        self.assertEqual(pauses[0]["pause_stop"] - pauses[0]["pause_start"], 0)
        duration = self.store.read_staging()[0]["data"]["duration"]
        self.assertEqual(duration, 5000)


# =============================================================================
# Pause with lazy auth (NoAuthCryptoManager)
# =============================================================================

class TestPauseLazyAuth(unittest.TestCase):
    """Pause/unpause works when staging was created without a passphrase."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_pause_with_plaintext_pauses_enc(self):
        """A pause on a lazy (plain:) entry creates plaintext pauses_enc."""
        lazy_ledger = LedgerDomain(NoAuthCryptoManager(), self.store)
        now = int(time.time() * 1000)
        lazy_ledger.capture_habit("Lazy", now, is_active=True)

        lazy_ledger.pause_habit("Lazy", now + 10000)
        staging = self.store.read_staging()
        self.assertTrue(staging[0]["data"]["pauses_enc"].startswith("plain:"))

    def test_sync_converts_plain_pauses_to_encrypted(self):
        """Sync re-encrypts plaintext pauses_enc like other fields."""
        lazy_ledger = LedgerDomain(NoAuthCryptoManager(), self.store)
        now = int(time.time() * 1000)
        lazy_ledger.capture_habit("Lazy", now, is_active=True)
        lazy_ledger.pause_habit("Lazy", now + 10000)
        lazy_ledger.unpause_habit("Lazy", now + 20000)
        lazy_ledger.end_habit("Lazy", now + 30000)

        self.ledger.sync_day()
        ledger_data = self.store.read_ledger()
        day_rec = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        entry = next(e for e in day_rec["entries"] if e["data"]["title"] == "Lazy")

        # pauses_enc is now encrypted (not plain:)
        self.assertFalse(entry["data"]["pauses_enc"].startswith("plain:"))
        # It decrypts correctly
        pauses = json.loads(self.crypto.decrypt(entry["data"]["pauses_enc"]))
        self.assertEqual(len(pauses), 1)

    def test_unpause_on_plain_entry_reencrypts(self):
        """Unpause re-encrypts pauses_enc even if it started as plain."""
        lazy_ledger = LedgerDomain(NoAuthCryptoManager(), self.store)
        now = int(time.time() * 1000)
        lazy_ledger.capture_habit("Lazy", now, is_active=True)
        lazy_ledger.pause_habit("Lazy", now + 10000)
        # Unpause with real crypto manager
        self.ledger.unpause_habit("Lazy", now + 20000)

        staging = self.store.read_staging()
        pauses_enc = staging[0]["data"]["pauses_enc"]
        # pauses_enc is now encrypted because unpause_habit() uses self.crypto
        self.assertFalse(pauses_enc.startswith("plain:"))


# =============================================================================
# Pre-existing ledger compatibility
# =============================================================================

class TestPauseBackwardCompat(unittest.TestCase):
    """
    Entries created before the pause feature (no pauses_enc, no is_paused)
    must not break existing code paths.
    """

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)
        # Need identity_secret to sign injected blocks
        id_path = self.test_dir / "identity.json"
        enc_secret = json.loads(id_path.read_text())["identity_secret_enc"]
        self.identity_secret = bytes.fromhex(self.crypto.decrypt(enc_secret))

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def _inject_old_entry(self, data_overrides=None):
        """
        Simulate a staging entry created before the pause feature existed.
        The entry has no pauses_enc and no is_paused fields.
        """
        now = int(time.time() * 1000)
        old_entry = {
            "hash": "old-style-hash",
            "data": {
                "title": "Old Work",
                "duration": 3600000,
                "is_active": False,
                "startTime_enc": self.crypto.encrypt(str(now - 3600000)),
                "endTime_enc": self.crypto.encrypt(str(now)),
                "metadata_enc": self.crypto.encrypt("{}"),
            },
            "start_epoch": now - 3600000,
        }
        if data_overrides:
            old_entry["data"].update(data_overrides)
        # Fix hash to match actual data
        old_entry["hash"] = hashlib.sha256(
            json.dumps(old_entry["data"], sort_keys=True).encode()
        ).hexdigest()
        self.store.write_staging([old_entry])

    def _inject_old_synced_day(self):
        """
        Simulate a synced day block with entries that have no pauses_enc.
        Uses the actual genesis hash as prev_hash so verify passes.
        """
        now = int(time.time() * 1000)
        date_str = time.strftime("%Y-%m-%d", time.gmtime(now // 1000))
        old_entry = {
            "hash": "old-synced-hash",
            "data": {
                "title": "Old Synced",
                "duration": 7200000,
                "is_active": False,
                "startTime_enc": self.crypto.encrypt(str(now - 7200000)),
                "endTime_enc": self.crypto.encrypt(str(now)),
                "metadata_enc": self.crypto.encrypt("{}"),
            },
        }
        # Fix hash
        old_entry["hash"] = hashlib.sha256(
            json.dumps(old_entry["data"], sort_keys=True).encode()
        ).hexdigest()

        genesis = json.loads(self.lf.read_text())[0]
        genesis_hash = genesis.get("block_hash") or genesis.get("day_hash")

        day_block = {
            "type": "day",
            "day_index": 1,
            "date": date_str,
            "prev_hash": genesis_hash,
            "entries": [old_entry],
        }
        day_json = json.dumps(day_block, sort_keys=True)
        day_block["day_hash"] = self.crypto.seal(day_json)
        day_block["identity_seal"] = self.crypto.mac(
            day_block["day_hash"], self.identity_secret
        )

        self.lf.write_text(json.dumps([genesis, day_block], indent=2))

    def test_old_entry_end_habit_does_not_crash(self):
        """end_habit on an entry without pauses_enc should work (as before)."""
        self._inject_old_entry({"is_active": True, "duration": 0})
        # Should not crash — pauses_enc is absent, treated as empty pauses
        self.ledger.end_habit("Old Work", int(time.time() * 1000))
        # Duration should be recalculated normally (no pause subtraction)
        staging = self.store.read_staging()
        self.assertFalse(staging[0]["data"]["is_active"])

    def test_old_entry_pause_adds_field_gracefully(self):
        """
        Pausing an old entry that has no is_paused/pauses_enc should create
        the fields rather than crashing on KeyError.
        """
        self._inject_old_entry({"is_active": True, "duration": 0})
        now = int(time.time() * 1000)
        self.ledger.pause_habit("Old Work", now)
        staging = self.store.read_staging()
        self.assertTrue(staging[0]["data"].get("is_paused"))
        self.assertIsNotNone(staging[0]["data"].get("pauses_enc"))

    def test_old_entry_unpause_does_not_crash(self):
        """Unpausing an old-style paused entry should work."""
        self._inject_old_entry({
            "is_active": True,
            "is_paused": True,       # manually set by pause_habit already
            "pauses_enc": self.crypto.encrypt(
                json.dumps([{"pause_index": 1, "pause_start": 1000, "pause_stop": None}])
            ),
        })
        now = int(time.time() * 1000)
        self.ledger.unpause_habit("Old Work", now)
        staging = self.store.read_staging()
        pauses = json.loads(self.crypto.decrypt(staging[0]["data"]["pauses_enc"]))
        self.assertEqual(pauses[0]["pause_stop"], now)

    def test_old_synced_entry_verify_passes(self):
        """
        Synced blocks without pauses_ec should still verify successfully.
        """
        self._inject_old_synced_day()
        self.assertTrue(self.ledger.verify(), "Verify should pass on old-format data")

    def test_old_synced_entry_list_does_not_crash(self):
        """
        Listing synced entries that lack pauses_ec should not raise.
        """
        self._inject_old_synced_day()
        data = self.ledger.get_ledger_data()
        for day in data:
            if day.get("type") == "day":
                for e in day["entries"]:
                    # This is what _print_entry does — must not crash
                    pauses_enc = e["data"].get("pauses_enc")
                    is_paused = e["data"].get("is_paused", False)
                    self.assertIsNone(pauses_enc)
                    self.assertFalse(is_paused)


# =============================================================================
# View display logic
# =============================================================================

class TestPauseView(unittest.TestCase):
    """
    Tests for pause-aware display logic in view_active().
    Since view_active() prints to stdout, we test the underlying data access.
    """

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_view_shows_paused_state(self):
        """A paused task should be readable from staging with is_paused flag."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Distracted", now, is_active=True)
        self.ledger.pause_habit("Distracted", now + 5000)

        staging = self.store.read_staging()
        active = [e for e in staging if e["data"].get("is_active")]
        self.assertEqual(len(active), 1)

        data = active[0]["data"]
        self.assertTrue(data["is_paused"])

    def test_view_shows_running_not_paused(self):
        """A running (non-paused) task has is_paused=false."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Focused", now, is_active=True)

        staging = self.store.read_staging()
        data = staging[0]["data"]
        self.assertTrue(data["is_active"])
        self.assertFalse(data["is_paused"])

    def test_view_shows_paused_and_running_separately(self):
        """Mixed paused and running tasks both show in active view."""
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Running", now, is_active=True)
        self.ledger.capture_habit("Paused", now + 1000, is_active=True)
        self.ledger.pause_habit("Paused", now + 5000)

        staging = self.store.read_staging()
        active = [e for e in staging if e["data"].get("is_active")]
        self.assertEqual(len(active), 2)

        running = [e for e in active if not e["data"].get("is_paused")]
        paused = [e for e in active if e["data"].get("is_paused")]
        self.assertEqual(len(running), 1)
        self.assertEqual(running[0]["data"]["title"], "Running")
        self.assertEqual(len(paused), 1)
        self.assertEqual(paused[0]["data"]["title"], "Paused")


# =============================================================================
# Entry hash integrity: every mutation recalculates the hash
# =============================================================================

class TestPauseHashIntegrity(unittest.TestCase):
    """
    Every pause/unpause/toggle modifies entry data, so the entry hash
    must be recalculated. Verify that the stored hash matches the data
    after each operation.
    """

    def _entry_hash_matches(self, entry):
        expected = hashlib.sha256(
            json.dumps(entry["data"], sort_keys=True).encode()
        ).hexdigest()
        return entry["hash"] == expected

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_hash_valid_after_pause(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Work", now, is_active=True)
        self.ledger.pause_habit("Work", now + 10000)
        staging = self.store.read_staging()
        self.assertTrue(self._entry_hash_matches(staging[0]),
                        "Hash mismatch after pause")

    def test_hash_valid_after_unpause(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Work", now, is_active=True)
        self.ledger.pause_habit("Work", now + 10000)
        self.ledger.unpause_habit("Work", now + 20000)
        staging = self.store.read_staging()
        self.assertTrue(self._entry_hash_matches(staging[0]),
                        "Hash mismatch after unpause")

    def test_hash_valid_after_end_with_auto_unpause(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Work", now, is_active=True)
        self.ledger.pause_habit("Work", now + 10000)
        self.ledger.end_habit("Work", now + 30000)
        staging = self.store.read_staging()
        self.assertTrue(self._entry_hash_matches(staging[0]),
                        "Hash mismatch after end-with-pause")

    def test_hash_valid_after_multiple_pauses(self):
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Work", now, is_active=True)
        for i in range(3):
            self.ledger.pause_habit("Work", now + (i * 20000) + 10000)
            self.ledger.unpause_habit("Work", now + (i * 20000) + 20000)
        staging = self.store.read_staging()
        self.assertTrue(self._entry_hash_matches(staging[0]),
                        "Hash mismatch after multiple pause cycles")


# =============================================================================
# Full integration: pause through to synced ledger verification
# =============================================================================

class TestPauseSyncAndVerify(unittest.TestCase):
    """End-to-end: pause → unpause → sync → verify → check chain."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger, self.crypto, self.store, self.sf, self.lf, self.ixf = \
            _setup_ledger(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_pause_sync_verify_full_chain(self):
        """Full chain: start → pause → unpause → end → sync → verify."""
        now = int(time.time() * 1000)
        start_ts = now
        self.ledger.capture_habit("Deep Work", start_ts, is_active=True)
        self.ledger.pause_habit("Deep Work", start_ts + 60000)
        self.ledger.unpause_habit("Deep Work", start_ts + 90000)
        self.ledger.end_habit("Deep Work", start_ts + 150000)
        self.ledger.sync_day()

        self.assertTrue(self.ledger.verify())

        # Check synced entry
        ledger_data = self.store.read_ledger()
        day_rec = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        entry = day_rec["entries"][0]
        self.assertEqual(entry["data"]["duration"], 120000)  # 120s active

        # pauses_enc decrypts
        pauses = json.loads(self.crypto.decrypt(entry["data"]["pauses_enc"]))
        self.assertEqual(len(pauses), 1)

    def test_multiple_pause_sync_verify(self):
        """Multiple pause cycles survive sync and verify."""
        now = int(time.time() * 1000)
        start_ts = now
        self.ledger.capture_habit("Deep Work", start_ts, is_active=True)

        expected_pauses = []
        pause_epoch = start_ts + 60000
        for i in range(3):
            ps = pause_epoch + (i * 30000)
            pe = ps + 10000
            self.ledger.pause_habit("Deep Work", ps)
            self.ledger.unpause_habit("Deep Work", pe)
            expected_pauses.append({"pause_index": i + 1, "pause_start": ps, "pause_stop": pe})

        self.ledger.end_habit("Deep Work", pe + 50000)
        self.ledger.sync_day()

        self.assertTrue(self.ledger.verify())

        ledger_data = self.store.read_ledger()
        day_rec = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        entry = day_rec["entries"][0]
        pauses = json.loads(self.crypto.decrypt(entry["data"]["pauses_enc"]))
        self.assertEqual(len(pauses), 3)
        for i, exp in enumerate(expected_pauses):
            self.assertEqual(pauses[i]["pause_index"], exp["pause_index"])
            self.assertEqual(pauses[i]["pause_start"], exp["pause_start"])
            self.assertEqual(pauses[i]["pause_stop"], exp["pause_stop"])

    def test_sync_only_completed_not_paused(self):
        """
        Paused (not ended) tasks should NOT be synced — they stay in staging.
        This is the existing 'is_active' filter behavior.
        """
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Active", now, is_active=True)
        self.ledger.pause_habit("Active", now + 10000)
        # Note: no unpause, no end — task is is_active=True, is_paused=True

        before = len(self.store.read_staging())
        self.ledger.sync_day()
        after = self.store.read_staging()

        # Task was not synced — it's still in staging
        self.assertEqual(len(after), 1)
        self.assertTrue(after[0]["data"]["is_active"])
        self.assertTrue(after[0]["data"]["is_paused"])


if __name__ == "__main__":
    unittest.main()
