"""Group E: Read-Only Command Fast Path — Phase 2 RED tests.

Tests that read-only commands (ph view, ph list, ph tags) skip remote
network calls when the device cookie TTL is valid and no writes are pending.

Assertions covered (from docs/planning/P5_CLI_UNLOCK_LATENCY_PHASE1.md):
  E1 — ph view with valid cookie TTL completes without remote network call
  E2 — ph list with valid cookie TTL completes without remote network call
  E3 — ph tags with valid cookie TTL completes without remote network call
  E4 — Read-only command with unreachable remote returns results from local cache
  E5 — Read-only command with expired cookie TTL still gates on auth
  E6 — ph view with valid TTL completes in < 1s (wall-clock)
"""

import json
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from security.device_identity import DeviceIdentity
from domain.cookie.device_cookie import DeviceCookie, META_FILE


# =============================================================================
# Helpers
# =============================================================================

TEST_MASTER_KEY = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 4
DEVICE_A_UUID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"

# Constants matching the staging service
DEFAULT_COOKIE_TTL = 30  # minutes


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


def _make_staging_store(entries=None):
    """Create a mock staging store returning entries in raw format.

    Entries are wrapped in the expected ``data`` dict with ``plain:``
    prefixed field values (the storage format expected by LocalStagingCache).
    """
    store = MagicMock()
    raw_entries = []
    for e in (entries or []):
        raw_entries.append({
            "data": {
                "title": e.get("title", ""),
                "startTime_enc": "plain:" + str(e.get("start_epoch", 0)),
                "endTime_enc": "plain:" + str(e["end_epoch"]) if e.get("end_epoch") is not None else None,
                "is_active": e.get("is_active", False),
                "is_paused": e.get("is_paused", False),
                "pauses_enc": "plain:" + json.dumps(e.get("pauses", [])),
                "tags": e.get("tags", []),
                "comment": e.get("comment"),
                "device_uuid_enc": "plain:" + e.get("device_uuid", ""),
                "end_device_uuid_enc": "plain:" + e.get("end_device_uuid", ""),
                "duration": e.get("duration", 0),
            },
            "hash": "",
            "start_epoch": e.get("start_epoch", 0),
        })
    store.read_entries.return_value = raw_entries
    return store


def _write_valid_local_cookie(data_dir, specifier="test-spec-001", age_seconds=60):
    """Write a valid (non-expired) local cookie at data_dir."""
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    now_ms = int(time.time() * 1000)
    creation_time = now_ms - age_seconds * 1000
    local_cookie = {
        "device_specifier": specifier,
        "creation_time": creation_time,
    }
    (data_dir / META_FILE).write_text(json.dumps(local_cookie))


def _write_expired_local_cookie(data_dir, specifier="test-spec-001"):
    """Write an expired local cookie (age > TTL)."""
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    now_ms = int(time.time() * 1000)
    expired_age_ms = (DEFAULT_COOKIE_TTL + 5) * 60 * 1000
    creation_time = now_ms - expired_age_ms
    local_cookie = {
        "device_specifier": specifier,
        "creation_time": creation_time,
    }
    (data_dir / META_FILE).write_text(json.dumps(local_cookie))


def _make_remote_cookie_bytes(specifier="test-spec-001", device_uuid=DEVICE_A_UUID):
    """Create remote cookie bytes matching the local cookie."""
    remote_cookie = {"device_uuid": device_uuid, "device_specifier": specifier}
    return json.dumps(remote_cookie).encode("utf-8")


# =============================================================================
# NetworkCallTracker: transport spy for fast-path assertions
# =============================================================================

class NetworkCallTracker:
    """Transport that tracks whether any network calls were made."""

    def __init__(self):
        self.pull_count = 0
        self.push_count = 0
        self.list_files_count = 0
        self._blobs: dict = {}
        self._raise_on_next: Exception | None = None

    def pull(self, path, timeout_ms=None):
        self.pull_count += 1
        if self._raise_on_next:
            err = self._raise_on_next
            self._raise_on_next = None
            raise err
        return self._blobs.get(path)

    def push(self, path, data, timeout_ms=None):
        self.push_count += 1
        if self._raise_on_next:
            err = self._raise_on_next
            self._raise_on_next = None
            raise err
        self._blobs[path] = data

    def list_files(self, prefix, timeout_ms=None):
        self.list_files_count += 1
        return []

    @property
    def any_network_calls(self):
        return self.pull_count > 0 or self.push_count > 0 or self.list_files_count > 0


# =============================================================================
# Test cases
# =============================================================================

class TestReadOnlyCommandFastPath(unittest.TestCase):
    """Group E: Read-only commands skip network when cookie is fresh."""

    def setUp(self):
        from domain.staging.service import StagingService

        self.transport = NetworkCallTracker()
        self.crypto = _make_crypto()
        self.device_provider = _make_device_provider()
        self.staging_store = _make_staging_store([])

    # E1-E3: Read-only commands with valid cookie TTL -------------------

    def test_E1_check_and_sync_with_valid_cookie_skips_network_when_no_writes(self):
        """E1-E3: check_and_sync with valid cookie + no pending writes skips network.

        When the local cookie is valid and there are no pending writes in
        staging, read-only commands (ph view, ph list, ph tags) should not
        make any network calls.
        """
        import tempfile
        from domain.staging.service import StagingService, SyncCheckResult

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "phpoc_data"
            _write_valid_local_cookie(data_dir, age_seconds=60)

            # Pre-populate remote cookie with same specifier (match)
            specifier = json.loads((data_dir / META_FILE).read_text())["device_specifier"]
            remote_cookie = _make_remote_cookie_bytes(specifier=specifier)
            self.transport._blobs["staging/blobs/device_cookie.bin"] = remote_cookie

            service = StagingService(
                crypto=self.crypto,
                staging_store=self.staging_store,
                transport=self.transport,
                device_id_provider=self.device_provider,
                data_dir=str(data_dir),
            )

            # When no writes are pending, check_and_sync on a read-only
            # command should return READY without making any network calls
            # (skips even the cookie pull since local cookie is valid).
            network_calls_before = self.transport.pull_count
            result = service.check_and_sync(timeout_ms=500)
            network_calls_after = self.transport.pull_count

            self.assertEqual(result, SyncCheckResult.READY)
            self.assertEqual(
                network_calls_after, network_calls_before,
                "Read-only command with fresh cookie must not make network calls"
            )

    def test_E1_check_and_sync_with_valid_cookie_and_writes_pending_still_syncs(self):
        """When writes ARE pending, even read-only commands should sync.

        This is a safety assertion: if there are un-pushed staging entries,
        the fast-path optimization should NOT skip the network — pending
        writes must be pushed.
        """
        import tempfile
        from domain.staging.service import StagingService, SyncCheckResult

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "phpoc_data"
            _write_valid_local_cookie(data_dir, age_seconds=60)

            specifier = json.loads((data_dir / META_FILE).read_text())["device_specifier"]
            remote_cookie = _make_remote_cookie_bytes(specifier=specifier)
            self.transport._blobs["staging/blobs/device_cookie.bin"] = remote_cookie

            # Staging has pending entries (writes exist)
            staging_with_writes = _make_staging_store([
                {"title": "pending task", "is_active": False, "start_epoch": 1000}
            ])

            service = StagingService(
                crypto=self.crypto,
                staging_store=staging_with_writes,
                transport=self.transport,
                device_id_provider=self.device_provider,
                data_dir=str(data_dir),
            )

            network_calls_before = self.transport.pull_count
            result = service.check_and_sync(timeout_ms=500)
            network_calls_after = self.transport.pull_count

            self.assertEqual(result, SyncCheckResult.READY)
            # With writes pending, network calls ARE expected (must sync)
            self.assertGreater(
                network_calls_after, network_calls_before,
                "When writes are pending, network calls are expected even for read-only commands"
            )

    # E4: Offline resilience -------------------------------------------

    def test_E4_read_only_command_returns_local_data_when_remote_unreachable(self):
        """E4: Read-only command with unreachable remote returns results from local cache.

        When the remote is unreachable but the local cookie is valid and
        there are no pending writes, the read-only command should return
        local cached data.
        """
        import tempfile
        from domain.staging.service import StagingService, SyncCheckResult

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "phpoc_data"
            _write_valid_local_cookie(data_dir, age_seconds=60)

            # Make transport raise on any network call (simulate offline)
            self.transport._raise_on_next = RuntimeError("Connection refused")

            # Staging has cached entries
            cached_staging = _make_staging_store([
                {"title": "cached task", "is_active": True, "start_epoch": 1000}
            ])

            service = StagingService(
                crypto=self.crypto,
                staging_store=cached_staging,
                transport=self.transport,
                device_id_provider=self.device_provider,
                data_dir=str(data_dir),
            )

            # When there are no pending writes, offline should not block
            # the read — the user can still view local data.
            result = service.check_and_sync(timeout_ms=500)
            # Should be READY (local data available) or fall through gracefully
            self.assertIn(result, [SyncCheckResult.READY, SyncCheckResult.OFFLINE])

            # Local entries should still be readable
            entries = service.read_entries()
            self.assertGreaterEqual(len(entries), 1)

    # E5: Expired cookie gates on auth --------------------------------

    def test_E5_expired_cookie_forces_REAUTH_NEEDED_for_read_only_commands(self):
        """E5: Read-only command with expired cookie TTL still gates on auth.

        Security: an expired session must still require re-auth even for
        read-only commands. The cookie TTL is the gate — not the crypto key.
        """
        import tempfile
        from domain.staging.service import StagingService, SyncCheckResult

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "phpoc_data"
            _write_expired_local_cookie(data_dir)

            service = StagingService(
                crypto=self.crypto,
                staging_store=self.staging_store,
                transport=self.transport,
                device_id_provider=self.device_provider,
                data_dir=str(data_dir),
            )

            result = service.check_and_sync(timeout_ms=500)
            self.assertEqual(
                result, SyncCheckResult.REAUTH_NEEDED,
                "Expired cookie must force REAUTH_NEEDED even for read-only commands"
            )

    # E6: Performance baseline -----------------------------------------

    def test_E6_check_and_sync_with_valid_cookie_completes_under_1_second(self):
        """E6: ph view with valid TTL completes in < 1s (wall-clock).

        The whole point — no perceptible delay for read-only commands.
        This test validates that the fast path is indeed fast.
        """
        import tempfile
        from domain.staging.service import StagingService, SyncCheckResult

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / "phpoc_data"
            _write_valid_local_cookie(data_dir, age_seconds=60)

            specifier = json.loads((data_dir / META_FILE).read_text())["device_specifier"]
            remote_cookie = _make_remote_cookie_bytes(specifier=specifier)
            self.transport._blobs["staging/blobs/device_cookie.bin"] = remote_cookie

            service = StagingService(
                crypto=self.crypto,
                staging_store=self.staging_store,
                transport=self.transport,
                device_id_provider=self.device_provider,
                data_dir=str(data_dir),
            )

            start = time.monotonic()
            result = service.check_and_sync(timeout_ms=500)
            elapsed = time.monotonic() - start

            self.assertEqual(result, SyncCheckResult.READY)
            self.assertLess(
                elapsed, 1.0,
                f"check_and_sync with valid cookie must complete in < 1s, "
                f"took {elapsed:.2f}s"
            )


if __name__ == "__main__":
    unittest.main()
