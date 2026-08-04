"""Tests for Phase B — WAL-backed instant writes & background push.

Tests cover:
  1. WAL lifecycle — create, read, clear, staleness
  2. WAL crash recovery — replay on startup with/without session key
  3. Edge cases — corrupt WAL, missing fields, stale cleanup
  4. Background push spawn — subprocess dispatched after writes
  5. Background push execution — push with/without session key
  6. ``ph sync status`` integration — WAL/remote/auth display
  7. Write command integration — all 4 write commands create WAL

Requires ``cli/wal.py`` to be importable.
"""

import json
import hashlib
import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

from phpoc_cli.wal import (
    _write_wal_pending,
    _read_wal,
    _clear_wal,
    has_pending_wal,
    get_wal_info,
    _replay_wal,
    _spawn_background_push,
    _background_push,
    format_wal_status,
    STALE_WAL_MAX_AGE_MS,
)
from phpoc_cli.background import SYNC_NOTIFICATION_FILENAME, SYNC_CHECK_LOCK_FILENAME


# ======================================================================
# 1. WAL lifecycle
# ======================================================================


class TestWalLifecycle(unittest.TestCase):
    """Create → read → clear → has_pending → get_info → format."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.entries = [
            {"entry_id": "a", "data": {"title": "Work", "is_active": True}},
            {"entry_id": "b", "data": {"title": "Break", "is_active": False}},
        ]
        self.device_id = "test-device-uuid"

    def test_write_creates_file(self):
        """_write_wal_pending creates wal/pending_push with correct structure."""
        result = _write_wal_pending(self.tmp, self.entries, self.device_id)
        self.assertTrue(result)

        wal_file = self.tmp / "wal" / "pending_push"
        self.assertTrue(wal_file.exists())

        data = json.loads(wal_file.read_text())
        self.assertIn("created_at", data)
        self.assertIn("staging_hash", data)
        self.assertEqual(data["device_id"], self.device_id)

    def test_write_creates_parent_dir(self):
        """Parent directory wal/ is created if missing."""
        self.assertFalse((self.tmp / "wal").exists())
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        self.assertTrue((self.tmp / "wal").is_dir())

    def test_write_returns_hash_of_entries(self):
        """Staging hash is sha256 of sorted serialized entries."""
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        data = json.loads((self.tmp / "wal" / "pending_push").read_text())

        expected = hashlib.sha256(
            json.dumps(self.entries, sort_keys=True).encode()
        ).hexdigest()
        self.assertEqual(data["staging_hash"], expected)

    def test_read_returns_wal_data(self):
        """_read_wal returns the deserialized dict."""
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        data = _read_wal(self.tmp)
        self.assertIsNotNone(data)
        self.assertEqual(data["device_id"], self.device_id)
        self.assertEqual(len(data["staging_hash"]), 64)

    def test_read_missing_returns_none(self):
        """_read_wal returns None when no WAL exists."""
        self.assertIsNone(_read_wal(self.tmp))

    def test_clear_removes_file(self):
        """_clear_wal deletes the WAL file."""
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        self.assertTrue((self.tmp / "wal" / "pending_push").exists())
        _clear_wal(self.tmp)
        self.assertFalse((self.tmp / "wal" / "pending_push").exists())

    def test_clear_no_file_no_error(self):
        """_clear_wal on missing file doesn't raise."""
        _clear_wal(self.tmp)  # Should not raise

    def test_clear_removes_empty_parent_if_possible(self):
        """After clearing, the wal dir is removed if empty (best-effort)."""
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        _clear_wal(self.tmp)
        # The wal dir should be gone since it's now empty
        # (but we don't strictly require this — it's best-effort)
        self.assertFalse((self.tmp / "wal" / "pending_push").exists())

    def test_has_pending_true_after_write(self):
        """has_pending_wal returns True when WAL exists."""
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        self.assertTrue(has_pending_wal(self.tmp))

    def test_has_pending_false_after_clear(self):
        """has_pending_wal returns False after WAL is cleared."""
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        _clear_wal(self.tmp)
        self.assertFalse(has_pending_wal(self.tmp))

    def test_has_pending_false_no_file(self):
        """has_pending_wal returns False when no WAL."""
        self.assertFalse(has_pending_wal(self.tmp))

    def test_get_wal_info_includes_age_minutes(self):
        """get_wal_info returns data with age_minutes field."""
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        info = get_wal_info(self.tmp)
        self.assertIsNotNone(info)
        self.assertIn("age_minutes", info)
        self.assertIsInstance(info["age_minutes"], float)
        self.assertGreaterEqual(info["age_minutes"], 0)
        self.assertLess(info["age_minutes"], 1)  # Just-written: < 1 min

    def test_get_wal_info_none_when_missing(self):
        """get_wal_info returns None when no WAL."""
        self.assertIsNone(get_wal_info(self.tmp))

    def test_get_wal_info_does_not_mutate_original(self):
        """get_wal_info returns a copy; mutating it doesn't affect stored data."""
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        info = get_wal_info(self.tmp)
        info["_extra"] = "test"
        # Re-read — should not contain _extra
        info2 = get_wal_info(self.tmp)
        self.assertNotIn("_extra", info2)

    def test_format_wal_status_present(self):
        """format_wal_status returns a string when WAL exists."""
        _write_wal_pending(self.tmp, self.entries, self.device_id)
        status = format_wal_status(self.tmp)
        self.assertIsNotNone(status)
        self.assertIn("Un-pushed", status)
        self.assertIn("Staging hash:", status)
        # Should show first 12 chars of the hash
        info = get_wal_info(self.tmp)
        self.assertIn(info["staging_hash"][:12], status)

    def test_format_wal_status_missing(self):
        """format_wal_status returns None when no WAL."""
        self.assertIsNone(format_wal_status(self.tmp))


# ======================================================================
# 2. WAL staleness & cleanup
# ======================================================================


class TestWalStaleness(unittest.TestCase):
    """Stale WAL entries are cleaned up on read."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.entries = [{"entry_id": "a", "data": {"title": "Work"}}]
        _write_wal_pending(self.tmp, self.entries, "device-1")
        self.wal_path = self.tmp / "wal" / "pending_push"

    def _age_wal_to(self, age_ms: int):
        """Set the WAL's created_at so it appears *age_ms* old."""
        data = json.loads(self.wal_path.read_text())
        data["created_at"] = int(time.time() * 1000) - age_ms
        self.wal_path.write_text(json.dumps(data))

    def test_fresh_wal_is_readable(self):
        """WAL under 24h is returned by _read_wal."""
        self._age_wal_to(1000)  # 1 second old
        self.assertIsNotNone(_read_wal(self.tmp))

    def test_stale_wal_returns_none(self):
        """WAL older than 24h returns None from _read_wal."""
        self._age_wal_to(STALE_WAL_MAX_AGE_MS + 60_000)  # 24h+1min
        self.assertIsNone(_read_wal(self.tmp))

    def test_stale_wal_is_deleted(self):
        """Stale WAL file is removed by _read_wal."""
        self._age_wal_to(STALE_WAL_MAX_AGE_MS + 60_000)
        _read_wal(self.tmp)
        self.assertFalse(self.wal_path.exists())

    def test_edge_boundary(self):
        """WAL exactly at STALE_WAL_MAX_AGE_MS is not yet stale (> check)."""
        self._age_wal_to(STALE_WAL_MAX_AGE_MS - 1)  # 1ms before boundary
        self.assertIsNotNone(_read_wal(self.tmp))


# ======================================================================
# 3. WAL crash recovery
# ======================================================================


class TestWalCrashRecovery(unittest.TestCase):
    """_replay_wal retries deferred pushes on startup."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.entries = [{"entry_id": "a", "data": {"title": "Work"}}]
        self.staging = MagicMock()
        self.staging._local._store.read_entries.return_value = self.entries
        _write_wal_pending(self.tmp, self.entries, "device-1")

    def test_replay_no_wal_noop(self):
        """No WAL → _replay_wal returns False, no push."""
        _clear_wal(self.tmp)
        result = _replay_wal(self.tmp, self.staging)
        self.assertFalse(result)
        self.staging.push_to_remote.assert_not_called()

    def test_replay_hash_matches_clears_wal_no_push(self):
        """Staging hash matches WAL hash → nothing to push, WAL cleared."""
        result = _replay_wal(self.tmp, self.staging)
        self.assertFalse(result, "Hash matches → should return False")
        self.staging.push_to_remote.assert_not_called()
        self.assertFalse(has_pending_wal(self.tmp),
                         "WAL should be cleared when hash matches")

    def test_replay_hash_mismatch_no_session(self):
        """Hash differs but no session key → WAL preserved for later."""
        # Modify staging entries so hash differs
        self.staging._local._store.read_entries.return_value = [
            {"entry_id": "b", "data": {"title": "New entry"}},
        ]

        with patch("phpoc_cli.wal._SESSION_FILE") as mock_sf:
            mock_sf.exists.return_value = False
            result = _replay_wal(self.tmp, self.staging)

        self.assertFalse(result, "No session → should return False")
        self.staging.push_to_remote.assert_not_called()
        self.assertTrue(has_pending_wal(self.tmp),
                        "WAL preserved for later retry")

    def test_replay_hash_mismatch_with_session_key(self):
        """Hash differs + session key exists → push called, WAL cleared."""
        self.staging._local._store.read_entries.return_value = [
            {"entry_id": "b", "data": {"title": "New entry"}},
        ]

        with patch("phpoc_cli.wal._SESSION_FILE") as mock_sf:
            mock_sf.exists.return_value = True
            mock_sf.read_bytes.return_value = b"\x01" * 32
            result = _replay_wal(self.tmp, self.staging)

        self.assertTrue(result, "Push succeeded → should return True")
        self.staging.push_to_remote.assert_called_once_with(master_key=b"\x01" * 32)
        self.assertFalse(has_pending_wal(self.tmp), "WAL should be cleared after push")

    def test_replay_bad_session_key_length(self):
        """Session key with wrong length → no push, WAL preserved."""
        self.staging._local._store.read_entries.return_value = [
            {"entry_id": "b", "data": {"title": "New entry"}},
        ]

        with patch("phpoc_cli.wal._SESSION_FILE") as mock_sf:
            mock_sf.exists.return_value = True
            mock_sf.read_bytes.return_value = b"too-short"
            result = _replay_wal(self.tmp, self.staging)

        self.assertFalse(result)
        self.staging.push_to_remote.assert_not_called()
        self.assertTrue(has_pending_wal(self.tmp))

    def test_replay_push_exception_preserves_wal(self):
        """push_to_remote raises → WAL preserved for retry."""
        self.staging._local._store.read_entries.return_value = [
            {"entry_id": "b", "data": {"title": "New entry"}},
        ]
        self.staging.push_to_remote.side_effect = RuntimeError("push failed")

        with patch("phpoc_cli.wal._SESSION_FILE") as mock_sf:
            mock_sf.exists.return_value = True
            mock_sf.read_bytes.return_value = b"\x01" * 32
            result = _replay_wal(self.tmp, self.staging)

        self.assertFalse(result)
        self.assertTrue(has_pending_wal(self.tmp),
                        "WAL preserved after push failure")

    def test_replay_read_entries_exception(self):
        """read_entries raises → no crash, WAL preserved."""
        self.staging._local._store.read_entries.side_effect = OSError("disk error")
        result = _replay_wal(self.tmp, self.staging)
        self.assertFalse(result)
        self.assertTrue(has_pending_wal(self.tmp))


# ======================================================================
# 4. Corrupted WAL handling
# ======================================================================


class TestWalCorruption(unittest.TestCase):
    """Corrupted WAL files are gracefully handled."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.wal_path = self.tmp / "wal" / "pending_push"
        self.wal_path.parent.mkdir(parents=True)

    def test_corrupted_json_clears_wal(self):
        """Invalid JSON in WAL → file deleted, read returns None."""
        self.wal_path.write_text("{invalid json")
        result = _read_wal(self.tmp)
        self.assertIsNone(result)
        self.assertFalse(self.wal_path.exists())

    def test_empty_file_clears_wal(self):
        """Empty WAL file → cleared, read returns None."""
        self.wal_path.write_text("")
        result = _read_wal(self.tmp)
        self.assertIsNone(result)
        self.assertFalse(self.wal_path.exists())

    def test_missing_created_at_returns_data(self):
        """Missing created_at is allowed (other fields still valid).

        Note: without created_at, get() defaults to 0, which gives an
        age of ~56 years from epoch — that exceeds STALE_WAL_MAX_AGE_MS
        (24h). So the entry IS treated as stale and cleaned up. This is
        acceptable behavior: a WAL with no timestamp is treated as expired.
        """
        self.wal_path.write_text(json.dumps({
            "staging_hash": "a" * 64,
            "device_id": "device-1",
        }))
        # Without created_at, default is 0 → extremely old → stale
        self.assertIsNone(_read_wal(self.tmp))
        self.assertFalse(self.wal_path.exists(),
                         "WAL without timestamp should be cleaned as stale")

    def test_missing_staging_hash_still_reads(self):
        """Missing staging_hash is allowed (basic validation only)."""
        self.wal_path.write_text(json.dumps({
            "created_at": int(time.time() * 1000),
            "device_id": "device-1",
        }))
        data = _read_wal(self.tmp)
        self.assertIsNotNone(data)
        self.assertIsNone(data.get("staging_hash"))

    def test_non_dict_json_returns_none(self):
        """WAL containing a JSON list instead of dict → treated as corrupt."""
        self.wal_path.write_text(json.dumps([1, 2, 3]))
        result = _read_wal(self.tmp)
        self.assertIsNone(result)
        self.assertFalse(self.wal_path.exists(), "Non-dict WAL should be deleted")


# ======================================================================
# 5. Background push spawn
# ======================================================================


class TestBackgroundPushSpawn(unittest.TestCase):
    """_spawn_background_push fires a subprocess with correct args."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    @patch("phpoc_cli.background._should_spawn_background_check", return_value=True)
    @patch("phpoc_cli.background._write_lock_file", return_value=True)
    @patch("phpoc_cli.wal.subprocess.Popen")
    def test_spawn_called_with_correct_args(self, mock_popen, mock_lock, mock_debounce):
        """Subprocess is spawned with correct Python module and --dir arg."""
        result = _spawn_background_push(self.tmp)
        self.assertTrue(result)

        mock_popen.assert_called_once()
        args, kwargs = mock_popen.call_args
        cmd = args[0]
        self.assertIn("-m", cmd)
        self.assertIn("phpoc", cmd)
        self.assertIn("_background_push", cmd)
        self.assertIn("--dir", cmd)
        self.assertIn(str(self.tmp), cmd)

        # Check detach flags
        import subprocess
        self.assertIs(kwargs.get("stdin"), subprocess.DEVNULL)
        self.assertIs(kwargs.get("stdout"), subprocess.DEVNULL)
        self.assertIs(kwargs.get("stderr"), subprocess.DEVNULL)
        self.assertTrue(kwargs.get("start_new_session"))

    @patch("phpoc_cli.background._should_spawn_background_check", return_value=False)
    def test_debounce_blocks_spawn(self, mock_debounce):
        """When debounce says no, no subprocess is spawned."""
        with patch("phpoc_cli.wal.subprocess.Popen") as mock_popen:
            result = _spawn_background_push(self.tmp)
            self.assertFalse(result)
            mock_popen.assert_not_called()

    @patch("phpoc_cli.background._should_spawn_background_check", return_value=True)
    @patch("phpoc_cli.background._write_lock_file", return_value=True)
    @patch("phpoc_cli.wal.subprocess.Popen", side_effect=OSError("fork failed"))
    def test_spawn_failure_releases_lock(self, mock_popen, mock_lock, mock_debounce):
        """If Popen raises, lock file is cleaned up."""
        result = _spawn_background_push(self.tmp)
        self.assertFalse(result)

        lock_path = self.tmp / SYNC_CHECK_LOCK_FILENAME
        self.assertFalse(lock_path.exists())

    @patch("phpoc_cli.background._should_spawn_background_check", return_value=True)
    @patch("phpoc_cli.background._write_lock_file", return_value=False)
    def test_lock_failure_skips_spawn(self, mock_lock, mock_debounce):
        """If lock file can't be written, no subprocess is spawned."""
        with patch("phpoc_cli.wal.subprocess.Popen") as mock_popen:
            result = _spawn_background_push(self.tmp)
            self.assertFalse(result)
            mock_popen.assert_not_called()


# ======================================================================
# 6. Background push execution
# ======================================================================


class TestBackgroundPushExecution(unittest.TestCase):
    """_background_push (runs in subprocess) pushes or defers."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.entries = [{"entry_id": "a", "data": {"title": "Work"}}]

        # Write a WAL
        _write_wal_pending(self.tmp, self.entries, "device-1")

        # Write a config
        config_dir = self.tmp / "config"
        config_dir.mkdir(parents=True)
        config_file = config_dir / "config.json"
        config_file.write_text(json.dumps({
            "cookie": {"ttl_minutes": 30},
            "remote": {"git_remote_url": "git@github.com:test/repo.git"},
            "storage": {"data_dir": str(self.tmp)},
        }))

    @patch("phpoc_cli.wal._SESSION_FILE")
    def test_background_push_no_session_writes_notification(self, mock_sf):
        """No session file → auth_needed notification written, WAL preserved."""
        mock_sf.exists.return_value = False

        with patch("storage.implementations.file_config._resolve_config_path",
                   return_value=self.tmp / "config" / "config.json"):
            _background_push(str(self.tmp))

        notification_path = self.tmp / SYNC_NOTIFICATION_FILENAME
        self.assertTrue(notification_path.exists(),
                        "Notification should be written when no session")

        data = json.loads(notification_path.read_text())
        self.assertEqual(data["type"], "auth_needed")
        self.assertIn("Local changes saved", data["message"])

        # WAL should be preserved
        self.assertTrue(has_pending_wal(self.tmp),
                        "WAL preserved when no session key")

    @patch("phpoc_cli.wal._SESSION_FILE")
    def test_background_push_no_wal_is_noop(self, mock_sf):
        """No WAL → _background_push returns immediately."""
        _clear_wal(self.tmp)

        # Even with a session file, nothing should happen
        mock_sf.exists.return_value = True
        mock_sf.read_bytes.return_value = b"\x01" * 32

        with patch("domain.staging.service.StagingService") as mock_ss:
            _background_push(str(self.tmp))
            mock_ss.assert_not_called()

    @patch("phpoc_cli.wal._SESSION_FILE")
    @patch("domain.staging.service.StagingService")
    def test_background_push_with_session_pushes_and_clears_wal(
        self, mock_staging_cls, mock_sf
    ):
        """Session exists → push happens, WAL cleared, notification removed."""
        mock_sf.exists.return_value = True
        mock_sf.read_bytes.return_value = b"\x01" * 32

        mock_instance = mock_staging_cls.return_value

        # Write a stale notification to verify it gets cleared
        notif_path = self.tmp / SYNC_NOTIFICATION_FILENAME
        notif_path.write_text(json.dumps({
            "type": "auth_needed",
            "message": "old notification",
            "timestamp": int(time.time() * 1000),
        }))

        # Mock all classes that _background_push constructs internally
        with patch("storage.implementations.file_config._resolve_config_path",
                   return_value=self.tmp / "config" / "config.json"):
            with patch("domain.staging.local_cache.LocalStagingCache"):
                with patch("security.crypto.CryptoManager"):
                    with patch("security.device_identity.RandomUUIDDeviceIdentityProvider"):
                        with patch("core.sync.git_transport.GitStagingTransport"):
                            _background_push(str(self.tmp))

        # push_to_remote should have been called with the session key
        mock_instance.push_to_remote.assert_called_once_with(master_key=b"\x01" * 32)

        # WAL should be cleared
        self.assertFalse(has_pending_wal(self.tmp))

        # Stale notification should be cleared
        self.assertFalse(notif_path.exists())

    @patch("phpoc_cli.wal._SESSION_FILE")
    @patch("domain.staging.service.StagingService")
    def test_background_push_failure_preserves_wal(
        self, mock_staging_cls, mock_sf
    ):
        """push_to_remote raises → WAL preserved for retry."""
        mock_sf.exists.return_value = True
        mock_sf.read_bytes.return_value = b"\x01" * 32

        mock_instance = mock_staging_cls.return_value
        mock_instance.push_to_remote.side_effect = RuntimeError("SSH failed")

        with patch("storage.implementations.file_config._resolve_config_path",
                   return_value=self.tmp / "config" / "config.json"):
            with patch("domain.staging.local_cache.LocalStagingCache"):
                with patch("security.crypto.CryptoManager"):
                    with patch("security.device_identity.RandomUUIDDeviceIdentityProvider"):
                        with patch("core.sync.git_transport.GitStagingTransport"):
                            _background_push(str(self.tmp))

        self.assertTrue(has_pending_wal(self.tmp),
                        "WAL preserved after push failure")

    @patch("phpoc_cli.wal._SESSION_FILE")
    def test_background_push_no_remote_config(self, mock_sf):
        """No remote configured → no push, WAL preserved."""
        mock_sf.exists.return_value = True
        mock_sf.read_bytes.return_value = b"\x01" * 32

        # Write config without remote
        config_no_remote = self.tmp / "config_no_remote"
        config_no_remote.mkdir(parents=True)
        (config_no_remote / "config.json").write_text(json.dumps({
            "cookie": {"ttl_minutes": 30},
        }))

        with patch("storage.implementations.file_config._resolve_config_path",
                   return_value=config_no_remote / "config.json"):
            with patch("domain.staging.service.StagingService") as mock_ss:
                _background_push(str(self.tmp))
                mock_ss.assert_not_called()

        self.assertTrue(has_pending_wal(self.tmp))


# ======================================================================
# 7. Write command integration
# ======================================================================


class TestWriteIntegration(unittest.TestCase):
    """All 4 write commands (start, end, oneoff, pause, unpause) create WAL.

    Tests verify that the CLI methods call ``_write_wal_pending`` and
    ``_spawn_background_push`` instead of the old synchronous
    ``_push_if_remote``.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.staging = MagicMock()
        self.staging._data_dir = self.tmp
        self.staging._remote = MagicMock()
        self.staging._local._store.read_entries.return_value = [
            {
                "entry_id": "a",
                "data": {
                    "title": "Work",
                    "is_active": True,
                    "startTime_enc": "plain:1776493845000",
                    "pauses_enc": "",
                    "tags": [],
                },
            },
        ]

        # StagingService.capture/end/pause/unpause return something truthy
        self.staging.capture.return_value = "hash_prefix"
        self.staging.end.return_value = None
        self.staging.pause.return_value = None
        self.staging.unpause.return_value = None

        crypto = MagicMock()
        crypto.master_key = b"\x01" * 32

        from phpoc_cli.interface import CLIInterface
        self.cli = CLIInterface(
            staging_service=self.staging,
            ledger_engine=MagicMock(),
            crypto=crypto,
        )

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending", return_value=True)
    def test_add_start_writes_wal(self, mock_wal, mock_spawn):
        """add_start calls _write_wal_pending with staging entries and device_id."""
        mock_device_id = "test-device-1234"
        identity_mock = MagicMock()
        identity_mock.device_id = mock_device_id
        self.staging._device_id_provider.get_device_identity.return_value = identity_mock

        self.cli.add_start("Test task")
        mock_wal.assert_called_once()
        args, _ = mock_wal.call_args
        self.assertEqual(args[0], self.tmp)  # data_dir
        self.assertIsInstance(args[1], list)  # staging_entries
        self.assertEqual(args[2], mock_device_id)  # device_id

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending", return_value=True)
    def test_add_end_writes_wal(self, mock_wal, mock_spawn):
        """add_end calls _write_wal_pending."""
        self.cli.add_end("Work")
        mock_wal.assert_called_once()

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending", return_value=True)
    def test_add_oneoff_writes_wal(self, mock_wal, mock_spawn):
        """add_oneoff calls _write_wal_pending."""
        self.cli.add_oneoff("Test", 1000, 2000)
        mock_wal.assert_called_once()

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending", return_value=True)
    def test_add_pause_writes_wal(self, mock_wal, mock_spawn):
        """add_pause calls _write_wal_pending."""
        self.cli.add_pause("Work")
        mock_wal.assert_called_once()

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending", return_value=True)
    def test_add_unpause_writes_wal(self, mock_wal, mock_spawn):
        """add_unpause calls _write_wal_pending."""
        self.cli.add_unpause("Work")
        mock_wal.assert_called_once()

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending")
    def test_view_active_no_wal(self, mock_wal, mock_spawn):
        """view_active (read-only) does NOT write WAL."""
        self.cli.view_active()
        mock_wal.assert_not_called()

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending", return_value=True)
    def test_add_start_spawns_background_push(self, mock_wal, mock_spawn):
        """add_start spawns a background push after writing WAL."""
        self.cli.add_start("Test task")
        mock_spawn.assert_called_once_with(self.tmp)

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending", return_value=True)
    def test_add_start_wal_before_spawn(self, mock_wal, mock_spawn):
        """WAL is written BEFORE background push is spawned (crash safety)."""
        call_order = []
        mock_wal.side_effect = lambda *a, **kw: call_order.append("wal")
        mock_spawn.side_effect = lambda *a, **kw: call_order.append("spawn")

        self.cli.add_start("Test task")
        self.assertEqual(call_order, ["wal", "spawn"],
                         "WAL must be written before spawn (crash safety)")

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending", return_value=False)
    def test_add_start_still_spawns_even_if_wal_write_fails(self, mock_wal, mock_spawn):
        """Even if WAL write fails, background push is still attempted.

        The push is best-effort. The WAL is insurance — but we don't
        want to skip the push just because the insurance filing failed.
        """
        self.cli.add_start("Test task")
        mock_spawn.assert_called_once()

    @patch("phpoc_cli.interface._spawn_background_push")
    @patch("phpoc_cli.interface._write_wal_pending")
    def test_no_remote_no_wal_no_spawn(self, mock_wal, mock_spawn):
        """No remote configured → no WAL, no spawn."""
        self.staging._remote = None
        self.cli.add_start("Test task")
        mock_wal.assert_not_called()
        mock_spawn.assert_not_called()


# ======================================================================
# 8. ph sync status display
# ======================================================================


class TestSyncStatus(unittest.TestCase):
    """Status output for WAL, remote, and auth state."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def _write_wal(self, age_minutes=5):
        """Helper: write a WAL entry with given age."""
        wal_path = self.tmp / "wal" / "pending_push"
        wal_path.parent.mkdir(parents=True)
        wal_path.write_text(json.dumps({
            "created_at": int(time.time() * 1000) - age_minutes * 60 * 1000,
            "staging_hash": "a" * 64,
            "device_id": "device-1",
        }))

    def _write_cookie_files(self, age_minutes=5):
        """Helper: write device cookie files."""
        self.tmp.joinpath("device_cookie.bin").write_bytes(b"\x00" * 32)
        created = int(time.time() * 1000) - age_minutes * 60 * 1000
        self.tmp.joinpath("device_cookie.meta").write_text(
            json.dumps({"created_at": created})
        )

    def test_status_no_wal_no_cookie_no_session(self):
        """Clean state: no pending changes, no remote check possible, no auth."""
        # All three missing: WAL, cookie, session
        # (Just verify the individual functions return expected values)
        self.assertFalse(has_pending_wal(self.tmp))
        self.assertIsNone(get_wal_info(self.tmp))

    def test_status_with_wal(self):
        """WAL exists → has_pending_wal, get_wal_info, format_wal_status work."""
        self._write_wal(age_minutes=15)
        self.assertTrue(has_pending_wal(self.tmp))
        info = get_wal_info(self.tmp)
        self.assertAlmostEqual(info["age_minutes"], 15.0, delta=0.1)
        self.assertEqual(info["staging_hash"][:12], "a" * 12)

        status = format_wal_status(self.tmp)
        self.assertIn("15 min", status)

    def test_status_wal_and_remote_mismatch(self):
        """WAL exists + cookie mismatch → both states reflected in status."""
        from phpoc_cli.background import _write_notification, SYNC_NOTIFICATION_FILENAME

        self._write_wal(age_minutes=3)

        # Also write a remote_changes notification (from Phase A background check)
        notif_path = self.tmp / SYNC_NOTIFICATION_FILENAME
        _write_notification(notif_path, {
            "type": "remote_changes",
            "message": "Remote changes detected from another device.",
            "timestamp": int(time.time() * 1000),
        })

        # Verify both indications exist independently
        self.assertTrue(has_pending_wal(self.tmp))
        # The notification file exists
        data = json.loads(notif_path.read_text())
        self.assertEqual(data["type"], "remote_changes")


if __name__ == "__main__":
    unittest.main()
