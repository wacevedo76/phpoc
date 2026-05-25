"""Tests for Phase A background sync — cookie renewal & notification lifecycle.

Tests cover:
  1. ``_try_renew_aging_cookie`` — threshold logic, session key caching, push
  2. Notification lifecycle — write, read, display, staleness
  3. Debounce lock — fresh vs stale, cleanup
  4. ``_run_cookie_check`` — full flow with/without renewal
  5. Integration through ``CLIInterface.view_active()`` — threshold passed correctly
"""

import json
import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

from cli.background import (
    _write_notification,
    _read_notification,
    _clear_notification,
    _show_sync_notifications,
    _should_spawn_background_check,
    _write_lock_file,
    _clear_lock_file,
    _try_renew_aging_cookie,
    _run_cookie_check,
    _run_cookie_check_with_cleanup,
    _SESSION_FILE,
    SYNC_NOTIFICATION_FILENAME,
    SYNC_CHECK_LOCK_FILENAME,
)


class TestCookieRenewalThreshold(unittest.TestCase):
    """Verify _try_renew_aging_cookie respects the renewal_threshold parameter."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.meta_path = self.tmp / "device_cookie.meta"
        self.cookie_path = self.tmp / "device_cookie.bin"
        self.remote_sync = MagicMock()
        self.remote_sync._device_id_provider.get_device_identity.return_value.device_id = "test-device"

        # Write a dummy cookie file (required by DeviceCookie.create / is_valid_locally)
        self.cookie_path.write_bytes(b"\x00" * 32)

        # Mock the session file with a valid 32-byte key
        self.session_file = self.tmp / "phpoc_session"
        self.session_file.write_bytes(b"\x01" * 32)

    # ------------------------------------------------------------------
    # Threshold boundary tests
    # ------------------------------------------------------------------

    def _set_cookie_age(self, age_minutes: int):
        """Set the cookie meta file to simulate a cookie created *age_minutes* ago."""
        created_ms = int(time.time() * 1000) - age_minutes * 60 * 1000
        self.meta_path.write_text(json.dumps({"created_at": created_ms}))

    @patch("cli.background._SESSION_FILE")
    def test_threshold_09_renews_at_90pct(self, mock_session):
        """threshold=0.9, TTL=30min → renew at 27+ min (90%), skip at 26 min."""
        mock_session.__truediv__ = lambda self, other: self.session_file
        mock_session.exists.return_value = True
        mock_session.read_bytes.return_value = b"\x01" * 32

        with patch("cli.background._SESSION_FILE", self.session_file):
            # 26 min: 86.7% used → below 0.9 → no renewal
            self._set_cookie_age(26)
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=0.9)
            self.assertFalse(result, "26 min is 86.7% < 90% → should not renew")

            # 28 min: 93.3% used → above 0.9 → renewal attempted
            self._set_cookie_age(28)
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=0.9)
            self.assertTrue(result, "28 min is 93.3% >= 90% → should renew")

    @patch("cli.background._SESSION_FILE")
    def test_threshold_10_renews_only_at_boundary(self, mock_session):
        """threshold=1.0 → renew only at the exact TTL boundary (>=100%).

        At 30 min exactly, fraction_used=1.0 which passes >=1.0, and the cookie
        is still valid (is_valid_locally uses > not >=). So renewal happens at
        the last millisecond before expiry. This means threshold=1.0 is essentially
        "renew at the last possible moment" rather than "never."
        """
        with patch("cli.background._SESSION_FILE", self.session_file):
            # 29.5 min (98.3%) → still below 1.0 → no renewal
            self._set_cookie_age(29.5)
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=1.0)
            self.assertFalse(result, "29.5 min is 98.3% < 100% → should not renew")

            # Exactly 30 min → 100% → renewal at boundary
            self._set_cookie_age(30)
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=1.0)
            self.assertTrue(result, "30 min is exactly 100% → renew at boundary")

    @patch("cli.background._SESSION_FILE")
    def test_threshold_05_renews_at_50pct(self, mock_session):
        """threshold=0.5 → renew at 15+ minutes."""
        with patch("cli.background._SESSION_FILE", self.session_file):
            # 14 min: 46.7% used → below 0.5 → no renewal
            self._set_cookie_age(14)
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=0.5)
            self.assertFalse(result, "14 min is 46.7% < 50% → should not renew")

            # 16 min: 53.3% used → above 0.5 → renewal
            self._set_cookie_age(16)
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=0.5)
            self.assertTrue(result, "16 min is 53.3% >= 50% → should renew")

    @patch("cli.background._SESSION_FILE")
    def test_threshold_00_renews_always(self, mock_session):
        """threshold=0.0 → renew on every check (fraction_used 0.0 >= 0.0 is always true)."""
        with patch("cli.background._SESSION_FILE", self.session_file):
            # Brand new cookie (0 min old) → 0% used, but 0.0 >= 0.0 → renews
            self._set_cookie_age(0)
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=0.0)
            self.assertTrue(result, "threshold=0.0 → should renew even brand-new cookie")

    # ------------------------------------------------------------------
    # Edge cases
    # ------------------------------------------------------------------

    def test_no_meta_file_returns_false(self):
        """Missing meta file → no renewal."""
        self.meta_path.unlink(missing_ok=True)
        result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=0.9)
        self.assertFalse(result)

    @patch("cli.background._SESSION_FILE")
    def test_no_session_file_no_renewal(self, mock_session):
        """No session key cached → no renewal (graceful skip)."""
        self._set_cookie_age(28)
        with patch("cli.background._SESSION_FILE", self.tmp / "nonexistent"):
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=0.9)
            self.assertFalse(result, "No session file → skip renewal")

    @patch("cli.background._SESSION_FILE")
    def test_bad_session_key_length_no_renewal(self, mock_session):
        """Session file with wrong key length (not 32 bytes) → no renewal."""
        self._set_cookie_age(28)
        bad_session = self.tmp / "bad_session"
        bad_session.write_text("not a 32-byte key")
        with patch("cli.background._SESSION_FILE", bad_session):
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=0.9)
            self.assertFalse(result, "Bad key length → skip renewal")

    @patch("cli.background._SESSION_FILE")
    def test_push_cookie_called_on_renewal(self, mock_session):
        """Successful renewal calls remote_sync.push_cookie with 32 bytes."""
        self._set_cookie_age(28)
        with patch("cli.background._SESSION_FILE", self.session_file):
            result = _try_renew_aging_cookie(self.tmp, self.remote_sync, 30, renewal_threshold=0.9)
            self.assertTrue(result)
            # Verify push was called with 32 bytes
            self.assertTrue(self.remote_sync.push_cookie.called)
            args, _ = self.remote_sync.push_cookie.call_args
            self.assertEqual(len(args[0]), 32, "Cookie bytes must be 32 bytes")


class TestNotificationLifecycle(unittest.TestCase):
    """Write → read → display → clear cycle."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.nf_path = self.tmp / SYNC_NOTIFICATION_FILENAME
        self.valid_data = {
            "type": "remote_changes",
            "message": "Changes detected",
            "timestamp": int(time.time() * 1000),
        }

    def test_write_and_read(self):
        _write_notification(self.nf_path, self.valid_data)
        self.assertTrue(self.nf_path.exists())
        data = _read_notification(self.nf_path)
        self.assertIsNotNone(data)
        self.assertEqual(data["message"], "Changes detected")

    def test_display_clears_file(self):
        _write_notification(self.nf_path, self.valid_data)
        shown = _show_sync_notifications(self.tmp)
        self.assertTrue(shown)
        self.assertFalse(self.nf_path.exists())

    def test_no_notification_returns_false(self):
        shown = _show_sync_notifications(self.tmp)
        self.assertFalse(shown)

    def test_stale_notification_cleaned(self):
        stale = self.valid_data.copy()
        stale["timestamp"] = int(time.time() * 1000) - 25 * 3600 * 1000  # 25h old
        _write_notification(self.nf_path, stale)
        data = _read_notification(self.nf_path)
        self.assertIsNone(data)
        self.assertFalse(self.nf_path.exists(), "Stale notification file should be removed")

    def test_unknown_type_rejected(self):
        _write_notification(self.nf_path, {
            "type": "unknown_type", "message": "bad", "timestamp": 1,
        })
        self.assertFalse(self.nf_path.exists())

    def test_missing_fields_rejected(self):
        _write_notification(self.nf_path, {
            "type": "remote_changes", "message": "no timestamp",
        })
        self.assertFalse(self.nf_path.exists())

    def test_auth_needed_type_accepted(self):
        _write_notification(self.nf_path, {
            "type": "auth_needed",
            "message": "Please auth",
            "timestamp": int(time.time() * 1000),
        })
        self.assertTrue(self.nf_path.exists())
        data = _read_notification(self.nf_path)
        self.assertEqual(data["type"], "auth_needed")


class TestDebounceLock(unittest.TestCase):
    """Lock file prevents spawning too many background processes."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.lock_path = self.tmp / SYNC_CHECK_LOCK_FILENAME

    def test_no_lock_allows_spawn(self):
        self.assertTrue(_should_spawn_background_check(self.tmp, cooldown=30))

    def test_fresh_lock_blocks_spawn(self):
        _write_lock_file(self.lock_path)
        self.assertFalse(_should_spawn_background_check(self.tmp, cooldown=30))

    def test_stale_lock_allows_spawn(self):
        _write_lock_file(self.lock_path)
        # Set lock mtime to 60s ago (older than 30s cooldown)
        old_time = time.time() - 60
        import os
        os.utime(str(self.lock_path), (old_time, old_time))
        self.assertTrue(_should_spawn_background_check(self.tmp, cooldown=30))

    def test_clear_lock_removes_file(self):
        _write_lock_file(self.lock_path)
        _clear_lock_file(self.lock_path)
        self.assertFalse(self.lock_path.exists())

    def test_double_clear_no_error(self):
        # Clearing a non-existent file should not raise
        _clear_lock_file(self.lock_path)


class TestCookieCheckFlow(unittest.TestCase):
    """End-to-end _run_cookie_check behavior with renewal."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.nf = self.tmp / SYNC_NOTIFICATION_FILENAME
        self.meta = self.tmp / "device_cookie.bin"
        self.remote_sync = MagicMock()

        # Write a local cookie (dummy)
        self.tmp.joinpath("device_cookie.bin").write_bytes(b"\x00" * 32)

        # Remote cookie matches local
        self.remote_sync.pull_cookie.return_value = b"\x00" * 32

    def _set_meta_age(self, minutes_ago: int):
        """Set cookie age in the meta file."""
        created = int(time.time() * 1000) - minutes_ago * 60 * 1000
        self.tmp.joinpath("device_cookie.meta").write_text(
            json.dumps({"created_at": created})
        )

    @patch("cli.background._SESSION_FILE")
    def test_cookie_check_calls_renewal(self, mock_session):
        """When cookie is aging and session key exists, renewal is attempted."""
        self._set_meta_age(28)
        session_file = self.tmp / "session"
        session_file.write_bytes(b"\x01" * 32)

        with patch("cli.background._SESSION_FILE", session_file):
            _run_cookie_check(
                data_dir=self.tmp,
                remote_sync=self.remote_sync,
                notification_path=self.nf,
                cookie_ttl_minutes=30,
                renewal_threshold=0.9,
            )

        # push_cookie should have been called (renewal succeeded)
        self.assertTrue(
            self.remote_sync.push_cookie.called,
            "Aging cookie + session → should push renewed cookie",
        )

    @patch("cli.background._SESSION_FILE")
    def test_no_session_skips_renewal(self, mock_session):
        """Aging cookie but no session → no renewal, no notification (cookies match)."""
        self._set_meta_age(28)  # 93% used → would renew if session existed

        with patch("cli.background._SESSION_FILE", self.tmp / "nonexistent"):
            _run_cookie_check(
                data_dir=self.tmp,
                remote_sync=self.remote_sync,
                notification_path=self.nf,
                cookie_ttl_minutes=30,
                renewal_threshold=0.9,
            )

        self.assertFalse(
            self.remote_sync.push_cookie.called,
            "No session file → no push attempted",
        )
        self.assertFalse(
            self.nf.exists(),
            "Cookies match → no notification even without renewal",
        )

    @patch("cli.background._SESSION_FILE")
    def test_fresh_cookie_no_renewal(self, mock_session):
        """Fresh cookie (5 min old) → threshold not hit → no renewal."""
        self._set_meta_age(5)
        session_file = self.tmp / "session"
        session_file.write_bytes(b"\x01" * 32)

        with patch("cli.background._SESSION_FILE", session_file):
            _run_cookie_check(
                data_dir=self.tmp,
                remote_sync=self.remote_sync,
                notification_path=self.nf,
                cookie_ttl_minutes=30,
                renewal_threshold=0.9,
            )

        self.assertFalse(
            self.remote_sync.push_cookie.called,
            "Fresh cookie → no renewal needed",
        )

    def test_expired_cookie_writes_notification(self):
        """No valid local cookie → auth_needed notification written."""
        # No meta file → cookie doesn't exist
        _run_cookie_check(
            data_dir=self.tmp,
            remote_sync=self.remote_sync,
            notification_path=self.nf,
            cookie_ttl_minutes=30,
        )

        self.assertTrue(self.nf.exists())
        data = json.loads(self.nf.read_text())
        self.assertEqual(data["type"], "auth_needed")

    def test_cookie_mismatch_writes_notification(self):
        """Remote cookie differs → remote_changes notification."""
        self._set_meta_age(5)
        # Remote cookie different from local (local is \x00, remote is \x01)
        self.remote_sync.pull_cookie.return_value = b"\x01" * 32

        _run_cookie_check(
            data_dir=self.tmp,
            remote_sync=self.remote_sync,
            notification_path=self.nf,
            cookie_ttl_minutes=30,
        )

        self.assertTrue(self.nf.exists())
        data = json.loads(self.nf.read_text())
        self.assertEqual(data["type"], "remote_changes")

    def test_network_error_silent(self):
        """pull_cookie raises → fail silently, no notification."""
        self._set_meta_age(5)
        self.remote_sync.pull_cookie.side_effect = Exception("network error")

        _run_cookie_check(
            data_dir=self.tmp,
            remote_sync=self.remote_sync,
            notification_path=self.nf,
            cookie_ttl_minutes=30,
        )

        self.assertFalse(
            self.nf.exists(),
            "Network error → no notification (user gets error on explicit sync)",
        )


class TestCookieCheckWithCleanup(unittest.TestCase):
    """Lock-file cleanup is guaranteed even on exceptions."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.lock = self.tmp / SYNC_CHECK_LOCK_FILENAME
        self.nf = self.tmp / SYNC_NOTIFICATION_FILENAME
        self.remote_sync = MagicMock()

    def test_cleanup_on_success(self):
        """Normal completion clears the lock file."""
        _write_lock_file(self.lock)
        self.assertTrue(self.lock.exists())

        _run_cookie_check_with_cleanup(
            data_dir=self.tmp,
            remote_sync=self.remote_sync,
            notification_path=self.nf,
            lock_path=self.lock,
            cookie_ttl_minutes=30,
        )

        self.assertFalse(
            self.lock.exists(),
            "Lock file should be cleared after successful check",
        )

    def test_cleanup_on_exception(self):
        """Exception in _run_cookie_check still clears the lock."""
        # Make pull_cookie raise inside _run_cookie_check
        self.remote_sync.pull_cookie.side_effect = RuntimeError("surprise")
        # Write local cookie and meta so we get past the is_valid_locally check
        self.tmp.joinpath("device_cookie.bin").write_bytes(b"\x00" * 32)
        created = int(time.time() * 1000) - 5 * 60 * 1000
        self.tmp.joinpath("device_cookie.meta").write_text(
            json.dumps({"created_at": created})
        )

        _write_lock_file(self.lock)

        _run_cookie_check_with_cleanup(
            data_dir=self.tmp,
            remote_sync=self.remote_sync,
            notification_path=self.nf,
            lock_path=self.lock,
            cookie_ttl_minutes=30,
        )

        self.assertFalse(
            self.lock.exists(),
            "Lock file should be cleared even after exception",
        )


class TestViewIntegration(unittest.TestCase):
    """Verify renewal_threshold flows through to CLIInterface.view_active()."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.staging = MagicMock()
        self.staging._data_dir = self.tmp
        self.staging._remote = MagicMock()
        self.staging._local._store.read_entries.return_value = []

    def _make_cli(self):
        from cli.interface import CLIInterface
        return CLIInterface(
            staging_service=self.staging,
            ledger_engine=MagicMock(),
            crypto=MagicMock(),
        )

    @patch("cli.interface._spawn_background_sync_check")
    def test_view_active_spawns_background(self, mock_spawn):
        """view_active with remote configured → spawns background check."""
        cli = self._make_cli()
        # Note: don't patch builtins.print here — it interferes with module
        # imports during view_active (the import chain hangs). Real print
        # to stdout is harmless in tests.
        cli.view_active()
        mock_spawn.assert_called_once()
        # Verify it was called with our staging service (identity check)
        self.assertIs(mock_spawn.call_args[0][0], self.staging)

    @patch("cli.interface._spawn_background_sync_check")
    def test_view_active_no_remote_no_spawn(self, mock_spawn):
        """view_active without remote → no background spawn."""
        self.staging._remote = None
        cli = self._make_cli()
        cli.view_active()
        mock_spawn.assert_not_called()

    def test_background_spawn_reads_config(self):
        """Verify the background handler reads renewal_threshold from config.

        This tests the wiring: handle_background_sync_check reads config
        and passes it through to _run_cookie_check_with_cleanup.
        """
        # Write a config file with custom renewal threshold
        config_dir = self.tmp / "config"
        config_dir.mkdir(parents=True)
        config_file = config_dir / "config.json"
        config_file.write_text(json.dumps({
            "cookie": {
                "ttl_minutes": 60,
                "renewal_threshold": 0.5,
            },
            "remote": {
                "git_remote_url": "git@github.com:test/repo.git",
            },
        }))

        # Override config path for the background handler
        with patch("storage.implementations.file_config._resolve_config_path",
                   return_value=config_file):
            with patch("cli.background._run_cookie_check_with_cleanup") as mock_check:
                with patch("core.sync.git_transport.GitStagingTransport"):
                    from cli.background import handle_background_sync_check
                    handle_background_sync_check(str(self.tmp))

        # Verify parameters passed correctly
        mock_check.assert_called_once()
        _, kwargs = mock_check.call_args
        self.assertEqual(kwargs["cookie_ttl_minutes"], 60)
        self.assertEqual(kwargs["renewal_threshold"], 0.5)


if __name__ == "__main__":
    unittest.main()
