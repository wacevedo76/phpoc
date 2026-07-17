"""Group B: Timeout Propagation — RemoteStagingSync — Phase 2 RED tests.

Tests that timeout_ms is propagated from RemoteStagingSync methods through
to the underlying transport.

Assertions covered (from docs/planning/P5_CLI_UNLOCK_LATENCY_PHASE1.md):
  B1 — pull_cookie(timeout_ms=500) passes timeout to transport.pull()
  B2 — pull(timeout_ms=500) passes timeout to transport.pull()
  B3 — push(timeout_ms=500) passes timeout to transport.push()
  B4 — push_cookie(timeout_ms=500) passes timeout to transport.push()
  B5 — Default timeout (None) uses transport default
  B6 — Timeout error from transport surfaces correctly
"""

import json
import unittest
from unittest.mock import MagicMock, patch, PropertyMock

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from domain.staging.remote_sync import RemoteStagingSync, REMOTE_COOKIE_PATH


# =============================================================================
# Helpers
# =============================================================================

TEST_MASTER_KEY = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 4  # 32 bytes
TEST_DEVICE_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"


class TimeoutTrackingTransport:
    """Transport spy that records timeout_ms passed to each method.

    Also allows the test to inject exceptions for error-propagation tests.
    """

    def __init__(self):
        self.pull_calls: list = []       # list of (path, timeout_ms)
        self.push_calls: list = []       # list of (path, data, timeout_ms)
        self._blobs: dict = {}
        self._next_pull_error: Exception | None = None

    def pull(self, path, timeout_ms=None):
        if self._next_pull_error is not None:
            err = self._next_pull_error
            self._next_pull_error = None
            raise err
        self.pull_calls.append((path, timeout_ms))
        return self._blobs.get(path)

    def push(self, path, data, timeout_ms=None):
        self.push_calls.append((path, data, timeout_ms))
        self._blobs[path] = data


def _make_crypto(master_key=TEST_MASTER_KEY):
    crypto = MagicMock()
    crypto.master_key = master_key
    return crypto


def _make_device_provider(device_id=TEST_DEVICE_ID):
    from security.device_identity import DeviceIdentity
    provider = MagicMock()
    provider.get_device_identity.return_value = DeviceIdentity(
        device_id=device_id, device_proof="proof", device_label="test"
    )
    return provider


# =============================================================================
# Test cases
# =============================================================================

class TestRemoteStagingSyncTimeoutPropagation(unittest.TestCase):
    """Group B: RemoteStagingSync timeout propagation."""

    def setUp(self):
        self.transport = TimeoutTrackingTransport()
        self.crypto = _make_crypto()
        self.device_provider = _make_device_provider()
        self.sync = RemoteStagingSync(
            crypto=self.crypto,
            transport=self.transport,
            device_id_provider=self.device_provider,
            master_key=TEST_MASTER_KEY,
        )

    # B1 ----------------------------------------------------------------

    def test_B1_pull_cookie_passes_timeout_to_transport_pull(self):
        """B1: pull_cookie(timeout_ms=500) passes timeout to transport.pull()."""
        self.sync.pull_cookie(timeout_ms=500)
        self.assertEqual(len(self.transport.pull_calls), 1)
        path, timeout_ms = self.transport.pull_calls[0]
        self.assertEqual(path, REMOTE_COOKIE_PATH)
        self.assertEqual(timeout_ms, 500)

    def test_B1_pull_cookie_default_timeout_is_None(self):
        """B1b: pull_cookie() without timeout passes None (transport default)."""
        self.sync.pull_cookie()
        self.assertEqual(len(self.transport.pull_calls), 1)
        _path, timeout_ms = self.transport.pull_calls[0]
        self.assertIsNone(timeout_ms,
                          "pull_cookie() should pass timeout_ms=None to transport "
                          "so the transport uses its own default (5s)")

    # B2 ----------------------------------------------------------------

    def test_B2_pull_passes_timeout_to_transport_pull(self):
        """B2: pull(timeout_ms=500) passes timeout to transport.pull().

        RemoteStagingSync.pull() pulls the staging blob path. The timeout
        must reach the transport layer for the blob pull.
        """
        # Need a plaintext blob so deobfuscation is skipped
        blob = json.dumps({"device_id": TEST_DEVICE_ID, "entries": [], "updated_at": 0})
        self.transport._blobs[self.sync._blob_path] = blob.encode()

        self.sync.pull(timeout_ms=500)
        # Should have one pull call for the blob path
        blob_pulls = [c for c in self.transport.pull_calls if c[0] == self.sync._blob_path]
        self.assertGreaterEqual(len(blob_pulls), 1)
        self.assertEqual(blob_pulls[0][1], 500)

    # B3 ----------------------------------------------------------------

    def test_B3_push_passes_timeout_to_transport_push(self):
        """B3: push(timeout_ms=500) passes timeout to transport.push().

        RemoteStagingSync.push() obfuscates and pushes the blob. The timeout
        must reach the transport.
        """
        self.sync.push(entries=[], device_id=TEST_DEVICE_ID, timeout_ms=500)
        self.assertEqual(len(self.transport.push_calls), 1)
        _path, _data, timeout_ms = self.transport.push_calls[0]
        self.assertEqual(timeout_ms, 500)

    # B4 ----------------------------------------------------------------

    def test_B4_push_cookie_passes_timeout_to_transport_push(self):
        """B4: push_cookie(timeout_ms=500) passes timeout to transport.push()."""
        cookie_bytes = json.dumps({"device_uuid": TEST_DEVICE_ID, "device_specifier": "abc"}).encode()
        self.sync.push_cookie(cookie_bytes, timeout_ms=500)
        self.assertEqual(len(self.transport.push_calls), 1)
        path, _data, timeout_ms = self.transport.push_calls[0]
        self.assertEqual(path, REMOTE_COOKIE_PATH)
        self.assertEqual(timeout_ms, 500)

    # B5 ----------------------------------------------------------------

    def test_B5_pull_cookie_default_timeout_is_None(self):
        """B5: Default timeout (None) passes None to transport.

        When pull_cookie() is called without timeout_ms, the transport
        receives None and applies its own default (which after Phase 3
        will be 5s instead of 60s).
        """
        self.sync.pull_cookie()
        _path, timeout_ms = self.transport.pull_calls[0]
        self.assertIsNone(timeout_ms)

    # B6 ----------------------------------------------------------------

    def test_B6_timeout_error_from_transport_surfaces_correctly(self):
        """B6: Timeout error from transport surfaces as RuntimeError.

        The error must not be swallowed — the caller needs to handle it.
        """
        import socket
        self.transport._next_pull_error = RuntimeError("Timeout pulling cookie: timed out")
        with self.assertRaises(RuntimeError) as ctx:
            self.sync.pull_cookie(timeout_ms=500)
        self.assertIn("Timeout", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
