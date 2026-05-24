"""DeviceCookie — deterministic encrypted cookie for cross-device identity check.

The Device Cookie solves the circular dependency problem where you need to
decrypt the staging blob just to find out *who* encrypted it.

Design:
  - Cookie = HMAC-SHA256(cookie_key, device_id + ":" + epoch_ms)
  - Deterministic: same inputs → same 32 bytes every time
  - Requires master key to generate or verify (HMAC is a keyed hash)
  - Remote only ever sees the encrypted (HMAC) bytes — no plaintext profiling
  - Local also stores the epoch in plaintext for TTL check (never pushed)

Flow:
  1. Every write operation creates/renews the cookie on local and pushes it to remote
  2. Every operation checks: local cookie valid? matches remote cookie?
  3. If both: same device, same session → skip staging reconciliation
  4. If not: proceed to auth + full staging blob pull+merge

Security properties:
  - Remote only stores 32 bytes of HMAC output — no device_id, no epoch
  - Without master key, cookie cannot be forged or traced to a device
  - TTL is enforced locally — no network round-trip needed to check expiry
  - Cookie comparison is timing-safe (hmac.compare_digest)
"""

import json
import time
import hmac
import hashlib
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Prefix used to derive the cookie HMAC key from the master key
COOKIE_KEY_PREFIX = b"phpoc:cookie-key"


class DeviceCookie:
    """Deterministic encrypted cookie for cross-device identity verification.

    Usage::

        # After successful auth + push:
        DeviceCookie.create(mk, device_id, data_dir)

        # Before any operation:
        local = DeviceCookie.is_valid_locally(data_dir, ttl_minutes=30)
        if local is not None:
            remote = transport.pull("staging/blobs/device_cookie.bin")
            if remote is not None and DeviceCookie.matches(local, remote):
                return READY  # Same device, same session
    """

    # Local filenames (in data_dir)
    COOKIE_FILE = "device_cookie.bin"       # Encrypted (HMAC) bytes — pushed to remote
    META_FILE = "device_cookie.meta"        # Plaintext: { "created_at": epoch_ms } — local only

    # ------------------------------------------------------------------
    # Key derivation
    # ------------------------------------------------------------------

    @staticmethod
    def _derive_cookie_key(master_key: bytes) -> bytes:
        """Derive a dedicated HMAC key for cookies from the master key.

        Uses SHA-256, producing a 32-byte key.
        """
        return hmac.new(master_key, COOKIE_KEY_PREFIX, hashlib.sha256).digest()

    # ------------------------------------------------------------------
    # Cookie value derivation (deterministic)
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_cookie(cookie_key: bytes, device_id: str, epoch_ms: int) -> bytes:
        """Compute the deterministic 32-byte cookie value.

        Args:
            cookie_key: 32-byte key derived from master key.
            device_id: This device's UUID.
            epoch_ms: Creation timestamp in milliseconds.

        Returns:
            32 bytes of HMAC output (deterministic).
        """
        payload = f"{device_id}:{epoch_ms}".encode("utf-8")
        return hmac.new(cookie_key, payload, hashlib.sha256).digest()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @staticmethod
    def create(master_key: bytes, device_id: str, data_dir: Path) -> Optional[str]:
        """Create a new device cookie on local and return its path for remote push.

        Writes two local files:
          - device_cookie.bin  → 32 bytes of HMAC output (to be pushed to remote)
          - device_cookie.meta → plaintext JSON with epoch (local TTL check only)

        The cookie is re-creatable: same (master_key, device_id, epoch_ms) → same bytes.
        But epoch_ms is unique per creation, so each cookie is unique.

        Args:
            master_key: 32-byte master key.
            device_id: This device's UUID string.
            data_dir: Local data directory (~/.local/share/phpoc/).

        Returns:
            The encrypted cookie bytes as hex string (for reference), or None on failure.
        """
        try:
            cookie_key = DeviceCookie._derive_cookie_key(master_key)
            epoch_ms = int(time.time() * 1000)
            cookie_bytes = DeviceCookie._compute_cookie(cookie_key, device_id, epoch_ms)

            # Write encrypted cookie (to be pushed to remote)
            cookie_path = data_dir / DeviceCookie.COOKIE_FILE
            cookie_path.parent.mkdir(parents=True, exist_ok=True)
            cookie_path.write_bytes(cookie_bytes)

            # Write plaintext metadata (local only — NEVER push this)
            meta_path = data_dir / DeviceCookie.META_FILE
            meta_path.write_text(json.dumps({"created_at": epoch_ms}))

            logger.debug("Device cookie created for device %s (epoch=%d)", device_id, epoch_ms)
            return cookie_bytes.hex()
        except Exception as exc:
            logger.error("Failed to create device cookie: %s", exc)
            return None

    @staticmethod
    def is_valid_locally(data_dir: Path, ttl_minutes: int = 30) -> Optional[bytes]:
        """Check if a local device cookie exists and its TTL has not expired.

        Args:
            data_dir: Local data directory (~/.local/share/phpoc/).
            ttl_minutes: How long the cookie is valid (configurable, default 30).

        Returns:
            The encrypted cookie bytes if valid, None if missing or expired.
        """
        cookie_path = data_dir / DeviceCookie.COOKIE_FILE
        meta_path = data_dir / DeviceCookie.META_FILE

        if not cookie_path.exists() or not meta_path.exists():
            return None

        try:
            meta = json.loads(meta_path.read_text())
            created_at = meta.get("created_at")
            if created_at is None:
                return None

            elapsed_ms = int(time.time() * 1000) - created_at
            if elapsed_ms > ttl_minutes * 60 * 1000:
                # Cookie expired — clean up
                logger.debug("Device cookie expired (%d ms old)", elapsed_ms)
                DeviceCookie.destroy_locally(data_dir)
                return None

            return cookie_path.read_bytes()
        except (json.JSONDecodeError, OSError, IOError) as exc:
            logger.warning("Failed to read local device cookie: %s", exc)
            DeviceCookie.destroy_locally(data_dir)
            return None

    @staticmethod
    def matches(local_cookie: bytes, remote_cookie: bytes) -> bool:
        """Timing-safe comparison of two encrypted cookie byte strings.

        Args:
            local_cookie: Bytes from local device_cookie.bin.
            remote_cookie: Bytes from remote device_cookie.bin.

        Returns:
            True if they are identical (same device, same session).
        """
        if not isinstance(local_cookie, bytes) or not isinstance(remote_cookie, bytes):
            return False
        return hmac.compare_digest(local_cookie, remote_cookie)

    @staticmethod
    def destroy_locally(data_dir: Path):
        """Remove local cookie files.

        Args:
            data_dir: Local data directory (~/.local/share/phpoc/).
        """
        cookie_path = data_dir / DeviceCookie.COOKIE_FILE
        meta_path = data_dir / DeviceCookie.META_FILE

        for path in (cookie_path, meta_path):
            try:
                if path.exists():
                    path.unlink()
            except OSError as exc:
                logger.warning("Failed to remove %s: %s", path, exc)
