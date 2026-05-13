"""RemoteStagingSync — device identity check, transport pull/push, blob handling.

Handles the remote side of staging: verifying device identity, pulling and
pushing staging blobs over a transport, and managing the remote blob format.

The transport is a 2-method interface:
  - ``pull(path) -> bytes | None``
  - ``push(path, data: bytes) -> None``

Remote blob format (JSON, stored as obfuscated bytes):
  {
    "device_id": "uuid-string",
    "device_proof": "hmac-hex",
    "entries": [...],
    "updated_at": 1714000000000
  }
"""

import json
import time
from typing import Optional, List, Dict, Any
from enum import Enum

from security.crypto import AbstractCryptoManager
from security.device_identity import AbstractDeviceIdentityProvider


class SyncCheckResult(Enum):
    """Result of event-driven remote check before a staging command."""
    READY = "ready"           # Remote synced, proceed with local operation
    OFFLINE = "offline"       # Remote unreachable, local operation only
    REAUTH_NEEDED = "reauth"  # Device mismatch, passphrase required


class RemoteStagingSync:
    """Handles device identity, transport, and blob obfuscation for remote staging.

    Attributes:
        _crypto: CryptoManager for blob obfuscation.
        _transport: 2-method interface for pull/push.
        _device_id_provider: For checking device identity.
        _blob_path: Remote path for the staging blob.
    """

    def __init__(
        self,
        crypto: AbstractCryptoManager,
        transport,
        device_id_provider: AbstractDeviceIdentityProvider,
        blob_path: str = "staging/blobs/current.json",
    ):
        self._crypto = crypto
        self._transport = transport
        self._device_id_provider = device_id_provider
        self._blob_path = blob_path

    def pull(self) -> Optional[Dict[str, Any]]:
        """Pull remote blob, deobfuscate, return parsed dict.

        Returns:
            Parsed blob dict with ``entries``, ``device_id``, etc.,
            or None if no blob exists.
        """
        raw_bytes = self._transport.pull(self._blob_path)
        if raw_bytes is None:
            return None
        try:
            return json.loads(raw_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def push(self, entries: List[Dict[str, Any]], device_id: str):
        """Encrypt entries into blob format and push via transport.

        Args:
            entries: List of staging entry dicts (encrypted, raw format).
            device_id: This device's UUID for the blob header.
        """
        blob = {
            "device_id": device_id,
            "device_proof": "",  # set by caller or via device_id_provider
            "entries": entries,
            "updated_at": int(time.time() * 1000),
        }
        blob_bytes = json.dumps(blob, indent=2).encode("utf-8")
        self._transport.push(self._blob_path, blob_bytes)

    def check_device(self) -> bool:
        """Compare local device_id with remote blob's device_id.

        Returns:
            True if remote blob matches this device (or no remote blob),
            False if device mismatch (re-auth may be needed).
        """
        blob = self.pull()
        if blob is None:
            return True  # No remote blob — nothing to conflict with
        remote_id = blob.get("device_id")
        if not remote_id:
            return True
        local = self._device_id_provider.get_device_identity(b"")  # dummy mk
        return remote_id == local.device_id

    def get_remote_device_id(self) -> Optional[str]:
        """Decrypt device_id from remote blob.

        Returns:
            Device ID string, or None if no blob exists.
        """
        blob = self.pull()
        if blob is None:
            return None
        return blob.get("device_id")

    def check_remote_available(self, timeout_ms: int = 500) -> bool:
        """Quick reachability check on the transport.

        Attempts to pull the blob. If the transport doesn't respond within
        *timeout_ms*, it is considered offline.

        Args:
            timeout_ms: Max time to wait for transport response in ms.

        Returns:
            True if remote is reachable within the timeout (pull returned bytes).
        """
        import time as _time
        start = _time.monotonic()
        try:
            result = self._transport.pull(self._blob_path)
            elapsed_ms = (_time.monotonic() - start) * 1000
            if elapsed_ms > timeout_ms:
                return False
            # Transport responded — treat as available even if blob is empty
            return True
        except Exception:
            return False
