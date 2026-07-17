"""Group D: Timeout Propagation — StagingService — Phase 2 RED tests.

Tests that timeout_ms is propagated from StagingService methods through
RemoteStagingSync to the transport layer.

Assertions covered (from docs/planning/P5_CLI_UNLOCK_LATENCY_PHASE1.md):
  D1 — check_and_sync(timeout_ms=500) propagates timeout to pull_cookie()
  D2 — push_to_remote(timeout_ms=500) propagates timeout to push()
  D3 — _reconcile_and_claim(timeout_ms=500) propagates timeout to pull()
  D4 — check_remote_ping(timeout_ms=500) uses transport timeout
  D5 — Timeout raised as RuntimeError with clear message
"""

import json
import unittest
from unittest.mock import MagicMock, patch, PropertyMock

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from security.device_identity import DeviceIdentity
from domain.staging.remote_sync import RemoteStagingSync, REMOTE_COOKIE_PATH


# =============================================================================
# Helpers
# =============================================================================

TEST_MASTER_KEY = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 4
DEVICE_A_UUID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"


class TimeoutTrackingTransport:
    """Transport spy that records timeout_ms for all calls."""

    def __init__(self):
        self.pull_calls: list = []
        self.push_calls: list = []
        self.list_files_calls: list = []
        self._blobs: dict = {}
        self._next_error: Exception | None = None

    def pull(self, path, timeout_ms=None):
        if self._next_error is not None:
            err = self._next_error
            self._next_error = None
            raise err
        self.pull_calls.append((path, timeout_ms))
        return self._blobs.get(path)

    def push(self, path, data, timeout_ms=None):
        if self._next_error is not None:
            err = self._next_error
            self._next_error = None
            raise err
        self.push_calls.append((path, data, timeout_ms))
        self._blobs[path] = data

    def list_files(self, prefix, timeout_ms=None):
        self.list_files_calls.append((prefix, timeout_ms))
        return []


class TimeoutTrackingRemoteStagingSync(RemoteStagingSync):
    """RemoteStagingSync subclass that records timeout propagation."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.pull_cookie_timeouts: list = []
        self.pull_timeouts: list = []
        self.push_timeouts: list = []
        self.push_cookie_timeouts: list = []

    def pull_cookie(self, timeout_ms=None):
        self.pull_cookie_timeouts.append(timeout_ms)
        return super().pull_cookie(timeout_ms=timeout_ms)

    def pull(self, master_key=None, timeout_ms=None):
        self.pull_timeouts.append(timeout_ms)
        return super().pull(master_key=master_key, timeout_ms=timeout_ms)

    def push(self, entries, device_id, master_key=None, timeout_ms=None):
        self.push_timeouts.append(timeout_ms)
        return super().push(entries, device_id, master_key=master_key, timeout_ms=timeout_ms)

    def push_cookie(self, cookie_bytes, timeout_ms=None):
        self.push_cookie_timeouts.append(timeout_ms)
        return super().push_cookie(cookie_bytes, timeout_ms=timeout_ms)


def _make_crypto(master_key=TEST_MASTER_KEY):
    crypto = MagicMock()
    crypto.master_key = master_key
    return crypto


def _make_device_provider(device_id=DEVICE_A_UUID):
    provider = MagicMock()
    provider.get_device_identity.return_value = DeviceIdentity(
        device_id=device_id, device_proof="proof-" + device_id, device_label="test",
    )
    return provider


def _make_staging_store():
    """Create a mock staging store with read/write_entries support."""
    store = MagicMock()
    store.read_entries.return_value = []
    return store


# =============================================================================
# Test cases
# =============================================================================

class TestStagingServiceTimeoutPropagation(unittest.TestCase):
    """Group D: StagingService timeout propagation."""

    def setUp(self):
        from domain.staging.service import StagingService

        self.transport = TimeoutTrackingTransport()
        self.crypto = _make_crypto()
        self.device_provider = _make_device_provider()
        self.staging_store = _make_staging_store()
        self.tmp_dir = "/tmp/phpoc_test_timeout_D"  # non-existent = no pre-existing cookies
        # Clean up any leftover state from previous runs
        import shutil
        if os.path.exists(self.tmp_dir):
            shutil.rmtree(self.tmp_dir)

        self.service = StagingService(
            crypto=self.crypto,
            staging_store=self.staging_store,
            transport=self.transport,
            device_id_provider=self.device_provider,
            data_dir=self.tmp_dir,
        )

    # D1 ----------------------------------------------------------------

    def test_D1_check_and_sync_propagates_timeout_to_pull_cookie(self):
        """D1: check_and_sync(timeout_ms=500) propagates to pull_cookie().

        This is the main entry point — the 500ms from caller must reach
        the remote cookie pull.
        """
        # No cookies exist → auth gate path. Set up so crypto has master_key.
        # Patch RemoteStagingSync.pull_cookie to record the timeout
        original_pull_cookie = self.service._remote.pull_cookie

        received_timeouts = []
        def tracking_pull_cookie(timeout_ms=None):
            received_timeouts.append(timeout_ms)
            return None  # No remote cookie → auth gate
        self.service._remote.pull_cookie = tracking_pull_cookie

        self.service.check_and_sync(timeout_ms=500)
        self.assertGreaterEqual(len(received_timeouts), 1)
        self.assertEqual(received_timeouts[0], 500)

    # D2 ----------------------------------------------------------------

    def test_D2_push_to_remote_propagates_timeout_to_remote_push(self):
        """D2: push_to_remote(timeout_ms=500) propagates to RemoteStagingSync.push().

        Push during commit must not hang — the timeout must reach the transport.
        """
        # push_to_remote calls self._remote.push(...). Track the timeout.
        original_push = self.service._remote.push
        received_timeouts = []
        def tracking_push(entries, device_id, master_key=None, timeout_ms=None):
            received_timeouts.append(timeout_ms)
            return None
        self.service._remote.push = tracking_push

        self.service.push_to_remote(master_key=TEST_MASTER_KEY, timeout_ms=500)
        self.assertGreaterEqual(len(received_timeouts), 1)
        self.assertEqual(received_timeouts[0], 500)

    # D3 ----------------------------------------------------------------

    def test_D3_reconcile_and_claim_propagates_timeout_to_pull(self):
        """D3: _reconcile_and_claim(timeout_ms=500) propagates to pull().

        The reconcile step during auth must use the timeout for the remote
        blob pull.
        """
        # Set up: no remote cookie, valid crypto, no remote blob
        # _reconcile_and_claim pulls remote blob via self._remote.pull()
        original_pull = self.service._remote.pull
        received_timeouts = []
        def tracking_pull(master_key=None, timeout_ms=None):
            received_timeouts.append(timeout_ms)
            return None  # No remote blob
        self.service._remote.pull = tracking_pull

        # Also stub pull_cookie for _reconcile_and_claim
        self.service._remote.pull_cookie = lambda timeout_ms=None: None

        # Don't try to push — stub it out
        self.service.push_blob_only = lambda master_key=None, timeout_ms=None: None
        self.service._push_cookie = lambda device_id: None

        from domain.staging.service import SyncCheckResult
        result = self.service._reconcile_and_claim(
            master_key=TEST_MASTER_KEY, timeout_ms=500
        )
        self.assertGreaterEqual(len(received_timeouts), 1)
        self.assertEqual(received_timeouts[0], 500)

    # D4 ----------------------------------------------------------------

    def test_D4_check_remote_ping_uses_transport_timeout(self):
        """D4: check_remote_ping(timeout_ms=500) uses transport timeout.

        Quick reachability check must actually be quick. When timeout_ms is
        passed, the transport call within check_remote_ping must use it.
        """
        # check_remote_ping calls self._remote.pull_cookie() currently
        # without passing timeout. The Phase 3 fix will plumb timeout.
        original_pull_cookie = self.service._remote.pull_cookie
        received_timeouts = []
        def tracking_pull_cookie(timeout_ms=None):
            received_timeouts.append(timeout_ms)
            return b"{}"
        self.service._remote.pull_cookie = tracking_pull_cookie

        self.service.check_remote_ping(timeout_ms=500)
        self.assertGreaterEqual(len(received_timeouts), 1)
        self.assertEqual(received_timeouts[0], 500)

    # D5 ----------------------------------------------------------------

    def test_D5_timeout_raised_as_RuntimeError_with_clear_message(self):
        """D5: Timeout raised as RuntimeError with clear message (not generic hang).

        When a timeout occurs, the user must see "timeout" not a mysterious error.
        """
        import socket
        error_msg = "Timeout pulling staging/blobs/device_cookie.bin: timed out"

        # Make pull_cookie raise a timeout error
        self.service._remote.pull_cookie = lambda timeout_ms=None: (_ for _ in ()).throw(
            RuntimeError(error_msg)
        )

        with self.assertRaises(RuntimeError) as ctx:
            self.service.check_and_sync(timeout_ms=500)
        self.assertIn("Timeout", str(ctx.exception))
        self.assertIn("timed out", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
