"""Pytest fixtures for staging sync optimization tests.

Provides:
  - ``cookie_dir``: Temporary directory for cookie files.
  - ``device_specifier``: A fixed random specifier for test reproducibility.
  - ``TransportSpy``: Records all pull/push interactions for verification.
  - ``make_local_cookie``: Fixture factory to create local cookies at exact ages.
  - ``make_remote_cookie``: Fixture factory to create remote cookie bytes.
  - ``staging_service_factory``: Build a StagingService with controlled deps.

Usage in tests::

    def test_something(cookie_dir, transport_spy, local_cookie_factory):
        local_cookie_factory(age_minutes=2, specifier="abc")
        ...

The spy records:
  - ``spy.pull_cookie_calls``: Count of pull_cookie invocations.
  - ``spy.pull_blob_calls``: Count of pull() invocations.
  - ``spy.push_blob_calls``: List of (path, payload) for push().
  - ``spy.push_cookie_calls``: List of (path, payload) for push_cookie().
"""

import json
import time
import uuid
import shutil
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple
from unittest.mock import MagicMock

import pytest

from domain.cookie.device_cookie import DeviceCookie, META_FILE, COOKIE_FILE
from domain.staging.remote_sync import RemoteStagingSync, REMOTE_COOKIE_PATH


# ---------------------------------------------------------------------------
# Shared constants
# ---------------------------------------------------------------------------

TEST_MASTER_KEY = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 4  # 32 bytes
DEVICE_A_UUID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"
DEVICE_B_UUID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"


# ---------------------------------------------------------------------------
# Transport spy
# ---------------------------------------------------------------------------

class TransportSpy:
    """Records all transport interactions for test assertions.

    Simulates remote storage: pull returns previously pushed data.
    Never makes real network calls.
    """

    def __init__(self):
        self.reset()

    def reset(self):
        """Clear all recorded calls and stored blobs."""
        self._blobs: Dict[str, bytes] = {}
        self.pull_cookie_calls: int = 0
        self.pull_blob_calls: int = 0
        self.push_blob_calls: List[Tuple[str, bytes]] = []
        self.push_cookie_calls: List[Tuple[str, bytes]] = []

    # RemoteStagingSync expects a transport with pull(path) and push(path, data)

    def pull(self, path: str) -> Optional[bytes]:
        """Record and return stored blob at path, or None."""
        if path == REMOTE_COOKIE_PATH:
            self.pull_cookie_calls += 1
        else:
            self.pull_blob_calls += 1
        return self._blobs.get(path)

    def push(self, path: str, data: bytes) -> None:
        """Record push and store blob in memory."""
        if path == REMOTE_COOKIE_PATH:
            self.push_cookie_calls.append((path, data))
        else:
            self.push_blob_calls.append((path, data))
        self._blobs[path] = data

    # Convenience helpers for test setup

    def set_remote_blob(self, path: str, data: bytes) -> None:
        """Pre-populate a remote blob without recording a push."""
        self._blobs[path] = data

    def set_cookie(self, data: bytes) -> None:
        """Pre-populate the remote cookie."""
        self.set_remote_blob(REMOTE_COOKIE_PATH, data)

    def get_remote_blob(self, path: str) -> Optional[bytes]:
        """Read a remote blob without counting as a pull."""
        return self._blobs.get(path)

    def get_cookie(self) -> Optional[bytes]:
        """Read the remote cookie without counting as a pull."""
        return self.get_remote_blob(REMOTE_COOKIE_PATH)

    @property
    def last_push_blob_payload(self) -> Optional[bytes]:
        """Return the body of the most recent blob push."""
        if not self.push_blob_calls:
            return None
        return self.push_blob_calls[-1][1]

    @property
    def last_push_cookie_payload(self) -> Optional[bytes]:
        """Return the body of the most recent cookie push."""
        if not self.push_cookie_calls:
            return None
        return self.push_cookie_calls[-1][1]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def cookie_dir(tmp_path: Path) -> Path:
    """Temporary directory for device cookie files."""
    return tmp_path / "phpoc_data"


@pytest.fixture
def transport_spy() -> TransportSpy:
    """A fresh TransportSpy with no pre-existing blobs."""
    return TransportSpy()


@pytest.fixture
def remote_staging_sync(transport_spy: TransportSpy) -> RemoteStagingSync:
    """A RemoteStagingSync wired to the transport spy."""
    crypto = MagicMock()
    crypto.master_key = TEST_MASTER_KEY
    provider = MagicMock()
    identity = MagicMock()
    identity.device_id = DEVICE_A_UUID
    provider.get_device_identity.return_value = identity

    return RemoteStagingSync(
        crypto=crypto,
        transport=transport_spy,
        device_id_provider=provider,
        master_key=TEST_MASTER_KEY,
    )


# ---------------------------------------------------------------------------
# Cookie factory helpers (usable directly in tests)
# ---------------------------------------------------------------------------

def make_local_cookie(
    data_dir: Path,
    specifier: str = "test-specifier-001",
    creation_time_epoch_ms: Optional[int] = None,
) -> None:
    """Write a local device cookie at *data_dir* with given properties.

    Args:
        data_dir: Directory to write the cookie into.
        specifier: The device_specifier value.
        creation_time_epoch_ms: Epoch ms for creation_time. Defaults to now.
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    if creation_time_epoch_ms is None:
        creation_time_epoch_ms = int(time.time() * 1000)

    local_cookie = {
        "device_specifier": specifier,
        "creation_time": creation_time_epoch_ms,
    }
    (data_dir / META_FILE).write_text(json.dumps(local_cookie))


def make_remote_cookie_bytes(
    specifier: str = "test-specifier-001",
    device_uuid: str = DEVICE_A_UUID,
) -> bytes:
    """Serialize a remote cookie dict to JSON bytes.

    Args:
        specifier: The device_specifier value.
        device_uuid: The device UUID for the remote cookie.

    Returns:
        JSON bytes suitable for transport spy ``set_cookie()``.
    """
    remote_cookie = {
        "device_uuid": device_uuid,
        "device_specifier": specifier,
    }
    return json.dumps(remote_cookie).encode("utf-8")


def make_staging_blob_bytes(
    device_id: str = DEVICE_A_UUID,
    entries: Optional[List[Dict]] = None,
    updated_at: Optional[int] = None,
) -> bytes:
    """Serialize a staging blob dict to JSON bytes (plaintext, not obfuscated).

    For tests that don't test obfuscation, this is simpler than going
    through the full RemoteStagingSync._obfuscate path.

    Args:
        device_id: The device ID for the blob header.
        entries: List of staging entry dicts.
        updated_at: Epoch ms timestamp. Defaults to now.

    Returns:
        JSON bytes payload.
    """
    if updated_at is None:
        updated_at = int(time.time() * 1000)
    blob = {
        "device_id": device_id,
        "device_proof": "",
        "entries": entries or [],
        "updated_at": updated_at,
    }
    return json.dumps(blob).encode("utf-8")
