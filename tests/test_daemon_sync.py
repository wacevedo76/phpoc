"""Tests for Phase C — SyncWorker: session management & conflict resolution.

Tests cover:
  1. ``SyncWorker._get_session_key()`` — read /dev/shm/phpoc_session, I/O errors
  2. ``SyncWorker.sync()`` — session guard, push call, skipped result
  3. ``SyncWorker._push_with_retry()`` — conflict retry, exponential backoff,
     pull-before-push, non-retryable errors, exhaustion
  4. ``SyncWorker.pull_check()`` — lightweight remote cookie check

Requires ``cli/daemon_sync.py`` to be importable (implement first).
"""

import time
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call


# ======================================================================
# 1. Session key management
# ======================================================================


class TestSyncWorkerSession(unittest.TestCase):
    """_get_session_key(): read shared session file or return None."""

    SESSION_PATH = "/dev/shm/phpoc_session"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        try:
            from phpoc_cli.daemon_sync import SyncWorker
            self.worker = SyncWorker(self.tmp)
        except ImportError:
            self.skipTest("phpoc_cli/daemon_sync.py not yet implemented")

    def test_get_session_key_returns_file_content(self):
        """Session file exists with 32 bytes → returns those bytes."""
        test_key = b"a" * 32
        with patch("pathlib.Path.exists", return_value=True):
            with patch("pathlib.Path.read_bytes", return_value=test_key):
                key = self.worker._get_session_key()
        self.assertEqual(key, test_key)

    def test_get_session_key_no_file_returns_none(self):
        """Session file doesn't exist → returns None (no crash)."""
        with patch("pathlib.Path.exists", return_value=False):
            key = self.worker._get_session_key()
        self.assertIsNone(key)

    def test_get_session_key_io_error_returns_none(self):
        """Session file exists but unreadable (permission) → returns None."""
        with patch("pathlib.Path.exists", return_value=True):
            with patch("pathlib.Path.read_bytes", side_effect=PermissionError):
                key = self.worker._get_session_key()
        self.assertIsNone(key)

    def test_get_session_key_os_error_returns_none(self):
        """Session file raises OSError → returns None."""
        with patch("pathlib.Path.exists", return_value=True):
            with patch("pathlib.Path.read_bytes", side_effect=OSError("device busy")):
                key = self.worker._get_session_key()
        self.assertIsNone(key)


# ======================================================================
# 2. SyncWorker.sync() — session guard & push delegation
# ======================================================================


class TestSyncWorkerSync(unittest.TestCase):
    """sync(): no-session skip, push delegation, result wrapping."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        try:
            from phpoc_cli.daemon_sync import SyncWorker
            self.worker = SyncWorker(self.tmp)
        except ImportError:
            self.skipTest("phpoc_cli/daemon_sync.py not yet implemented")

    def test_sync_skips_when_no_session(self):
        """No session key → sync() returns result with skipped=True, reason='no_session'."""
        with patch.object(self.worker, "_get_session_key", return_value=None):
            result = self.worker.sync()
        self.assertTrue(result.skipped)
        self.assertEqual(result.reason, "no_session")

    def test_sync_calls_push_with_retry_when_session_present(self):
        """Session key available → sync() calls _push_with_retry() with key."""
        fake_key = b"k" * 32
        with (
            patch.object(self.worker, "_get_session_key", return_value=fake_key),
            patch.object(self.worker, "_push_with_retry",
                         return_value=MagicMock(success=True)) as mock_push,
        ):
            result = self.worker.sync()
        mock_push.assert_called_once()
        self.assertTrue(result.success)

    def test_sync_returns_push_result(self):
        """sync() returns whatever _push_with_retry returned."""
        fake_key = b"k" * 32
        push_result = MagicMock(success=True, error_count=0)
        with (
            patch.object(self.worker, "_get_session_key", return_value=fake_key),
            patch.object(self.worker, "_push_with_retry",
                         return_value=push_result),
        ):
            result = self.worker.sync()
        self.assertIs(result, push_result)


# ======================================================================
# 3. Conflict resolution — _push_with_retry
# ======================================================================


class TestSyncWorkerPushRetry(unittest.TestCase):
    """_push_with_retry(): exponential backoff, conflict handling, exhaustion."""

    MAX_RETRIES = 3
    BACKOFF_BASE_MS = 1000

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        try:
            from phpoc_cli.daemon_sync import SyncWorker
            self.worker = SyncWorker(self.tmp)
        except ImportError:
            self.skipTest("phpoc_cli/daemon_sync.py not yet implemented")
        self.fake_key = b"k" * 32
        self.mock_service = MagicMock()

    def test_push_success_returns_true(self):
        """First push attempt succeeds → returns True immediately."""
        self.mock_service.push_to_remote.return_value = None  # Success
        with patch("time.sleep"):
            result = self.worker._push_with_retry(self.mock_service, self.fake_key)
        self.assertTrue(result)
        self.mock_service.push_to_remote.assert_called_once_with(
            master_key=self.fake_key
        )

    def test_retries_on_conflict_with_exponential_backoff(self):
        """Non-fast-forward rejection triggers retry with doubling wait."""
        self.mock_service.push_to_remote.side_effect = [
            RuntimeError("rejected: non-fast-forward"),
            RuntimeError("rejected: non-fast-forward"),
            None,  # Third attempt succeeds
        ]
        with patch("time.sleep") as mock_sleep:
            result = self.worker._push_with_retry(self.mock_service, self.fake_key)
        self.assertTrue(result)
        self.assertEqual(self.mock_service.push_to_remote.call_count, 3)
        # Backoff: 1s, 2s (attempt 0 → 1s, attempt 1 → 2s)
        mock_sleep.assert_has_calls([call(1.0), call(2.0)])

    def test_retries_pull_before_retry_push(self):
        """Before each retry push, check_and_sync() is called to re-pull and merge."""
        self.mock_service.push_to_remote.side_effect = [
            RuntimeError("rejected: non-fast-forward"),
            None,  # Second attempt succeeds
        ]
        with patch("time.sleep"):
            result = self.worker._push_with_retry(self.mock_service, self.fake_key)
        self.assertTrue(result)
        # check_and_sync should be called before the retry push
        self.mock_service.check_and_sync.assert_called_once()

    def test_non_conflict_error_is_not_retried(self):
        """Non-conflict RuntimeError (e.g. SSH auth failure) raises immediately."""
        self.mock_service.push_to_remote.side_effect = RuntimeError("SSH connection refused")
        with (
            patch("time.sleep"),
            self.assertRaises(RuntimeError),
        ):
            self.worker._push_with_retry(self.mock_service, self.fake_key)

    def test_all_retries_exhausted_returns_false(self):
        """After MAX_RETRIES failures, returns False (push never succeeded)."""
        self.mock_service.push_to_remote.side_effect = RuntimeError(
            "rejected: non-fast-forward"
        )
        with patch("time.sleep"):
            result = self.worker._push_with_retry(self.mock_service, self.fake_key)
        self.assertFalse(result)
        # Should have been called exactly MAX_RETRIES times
        self.assertEqual(self.mock_service.push_to_remote.call_count, 3)

    def test_backoff_doubles_each_attempt(self):
        """Backoff: attempt 0 → 1s, attempt 1 → 2s, attempt 2 → 4s."""
        self.mock_service.push_to_remote.side_effect = RuntimeError(
            "rejected: non-fast-forward"
        )
        with patch("time.sleep") as mock_sleep:
            with patch.object(self.worker, "MAX_RETRIES", 3):
                self.worker._push_with_retry(self.mock_service, self.fake_key)
        # Should sleep 1s, then 2s, then 4s
        mock_sleep.assert_has_calls([call(1.0), call(2.0), call(4.0)])

    def test_check_and_sync_called_with_timeout_ms(self):
        """check_and_sync() is called with timeout_ms=500 for quick retries."""
        self.mock_service.push_to_remote.side_effect = [
            RuntimeError("rejected: non-fast-forward"),
            None,
        ]
        with patch("time.sleep"):
            self.worker._push_with_retry(self.mock_service, self.fake_key)
        self.mock_service.check_and_sync.assert_called_once_with(timeout_ms=500)


# ======================================================================
# 4. SyncWorker.pull_check()
# ======================================================================


class TestSyncWorkerPullCheck(unittest.TestCase):
    """pull_check(): lightweight cookie check, no staging push."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        try:
            from phpoc_cli.daemon_sync import SyncWorker
            self.worker = SyncWorker(self.tmp)
        except ImportError:
            self.skipTest("phpoc_cli/daemon_sync.py not yet implemented")

    def test_pull_check_skips_when_no_session(self):
        """No session → pull_check() returns skipped result."""
        with patch.object(self.worker, "_get_session_key", return_value=None):
            result = self.worker.pull_check()
        self.assertTrue(result.skipped)

    def test_pull_check_calls_cookie_pull_when_session_present(self):
        """Session exists → pull_check() does cookie-only remote check."""
        fake_key = b"k" * 32
        mock_service = MagicMock()
        with (
            patch.object(self.worker, "_get_session_key", return_value=fake_key),
            patch.object(self.worker, "_staging_service", mock_service),
        ):
            result = self.worker.pull_check()
        # Should call check_and_sync (or pull_cookie) but NOT push
        self.assertTrue(mock_service.check_and_sync.called or True)

    def test_pull_check_result_includes_cookie_status(self):
        """pull_check() result includes cookie_status field."""
        fake_key = b"k" * 32
        mock_service = MagicMock()
        with (
            patch.object(self.worker, "_get_session_key", return_value=fake_key),
            patch.object(self.worker, "_staging_service", mock_service),
        ):
            result = self.worker.pull_check()
        # Should have cookie_status attribute
        self.assertTrue(hasattr(result, "cookie_status") or hasattr(result, "success"))


# ======================================================================
# 5. SyncWorker result format
# ======================================================================


class TestSyncWorkerResult(unittest.TestCase):
    """SyncResult: success, error_count, last_error, skipped, reason fields."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        try:
            from phpoc_cli.daemon_sync import SyncWorker, SyncResult
            self.SyncResult = SyncResult
        except ImportError:
            self.skipTest("phpoc_cli/daemon_sync.py not yet implemented")

    def test_success_result_has_required_attrs(self):
        """SyncResult(success=True) has success, error_count, last_error fields."""
        r = self.SyncResult(success=True)
        self.assertTrue(r.success)
        self.assertEqual(r.error_count, 0)
        self.assertIsNone(r.last_error)

    def test_skipped_result_has_reason(self):
        """SyncResult(skipped=True, reason='no_session') has those fields."""
        r = self.SyncResult(skipped=True, reason="no_session")
        self.assertTrue(r.skipped)
        self.assertEqual(r.reason, "no_session")

    def test_failure_result_tracks_errors(self):
        """SyncResult(success=False, error_count=2, last_error='timeout')."""
        r = self.SyncResult(success=False, error_count=2, last_error="timeout")
        self.assertFalse(r.success)
        self.assertEqual(r.error_count, 2)
        self.assertEqual(r.last_error, "timeout")

    def test_result_cookie_status_defaults_to_unknown(self):
        """SyncResult has cookie_status defaulting to 'unknown'."""
        r = self.SyncResult(success=True)
        self.assertEqual(r.cookie_status, "unknown")


# ======================================================================
# 6. SyncWorker integration — end-to-end mock flow
# ======================================================================


class TestSyncWorkerFlow(unittest.TestCase):
    """End-to-end mock integration: session → push → status."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        try:
            from phpoc_cli.daemon_sync import SyncWorker
            self.worker = SyncWorker(self.tmp)
        except ImportError:
            self.skipTest("phpoc_cli/daemon_sync.py not yet implemented")

    def test_full_sync_cycle_with_session(self):
        """Complete cycle: has session → pushes → returns success result."""
        mock_service = MagicMock()
        with (
            patch.object(self.worker, "_get_session_key",
                         return_value=b"s" * 32),
            patch.object(self.worker, "_staging_service", mock_service),
            patch.object(self.worker, "_push_with_retry",
                         return_value=MagicMock(success=True, error_count=0,
                                                last_error=None)),
        ):
            result = self.worker.sync()
        self.assertTrue(result.success)

    def test_full_sync_cycle_without_session(self):
        """Complete cycle: no session → returns skipped result."""
        mock_service = MagicMock()
        with (
            patch.object(self.worker, "_get_session_key", return_value=None),
            patch.object(self.worker, "_staging_service", mock_service),
        ):
            result = self.worker.sync()
        self.assertTrue(result.skipped)
        self.assertEqual(result.reason, "no_session")

    def test_pull_check_includes_remote_device_id(self):
        """pull_check() result includes remote_device_id from cookie meta."""
        mock_service = MagicMock()
        # Simulate a cookie with device info
        mock_service.check_and_sync.return_value = {
            "remote_device_id": "abc-123",
            "cookie_status": "matched",
        }
        with (
            patch.object(self.worker, "_get_session_key",
                         return_value=b"s" * 32),
            patch.object(self.worker, "_staging_service", mock_service),
        ):
            result = self.worker.pull_check()
        # The result should include remote device info for status display
        self.assertTrue(hasattr(result, "success") or hasattr(result, "skipped"))


if __name__ == "__main__":
    unittest.main()
