"""DeviceCookie — random-specifier cookie for cross-device identity check.

Design (your spec):
  - Remote cookie:  {"device_uuid": "<UUID>", "device_specifier": "<random>"}
  - Local cookie:   {"device_specifier": "<same random>", "creation_time": "<epoch_ms>"}
  
  On every staging write, a new random specifier is generated, stored locally,
  and pushed to remote as part of the cookie.

  On every staging read:
    1. Check local cookie exists and TTL hasn't expired (creation_time)
    2. Pull remote cookie — compare device_specifier values
    3. Match → same device session → READY (fast path)
    4. No match → different device wrote → slow path (pull + merge)
    5. No remote cookie → first time → slow path

Security:
  - device_specifier is a random 16-byte hex string — cannot be guessed
  - No master key needed for comparison (the specifier IS the identity proof)
  - Remote stores no plaintext cookie key — just the random specifier + UUID
  - device_uuid on remote is informational (for debugging), NOT used for auth
"""

import json
import time
import os
import hashlib
import logging
from pathlib import Path
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


# Aliases for backward compatibility — files renamed but kept in same locations
COOKIE_FILE = "device_cookie.bin"       # Remote cookie (JSON blob → pushed to remote)
META_FILE = "device_cookie.meta"        # Local cookie (JSON, local only)


class DeviceCookie:
    """Random-specifier cookie for cross-device identity verification.

    Usage::

        # After successful auth + push:
        DeviceCookie.create(device_id, data_dir)
        # → writes local cookie + returns remote cookie dict

        # Before any operation:
        local = DeviceCookie.is_valid_locally(data_dir, ttl_minutes=30)
        if local is not None:
            remote = pull from "staging/blobs/device_cookie.bin"
            remote_parsed = DeviceCookie.parse_remote(remote)
            if remote_parsed and DeviceCookie.matches(local, remote_parsed):
                return READY  # Same device session
    """

    # ------------------------------------------------------------------
    # Cookie value generation
    # ------------------------------------------------------------------

    @staticmethod
    def _generate_specifier() -> str:
        """Generate a random 32-char hex string as the device specifier."""
        return os.urandom(16).hex()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @staticmethod
    def create(device_id: str, data_dir: Path) -> Optional[Dict[str, Any]]:
        """Create a new device cookie.

        Writes local cookie (specifier + creation_time) and returns the
        remote cookie dict to be pushed to R2.

        Args:
            device_id: This device's UUID string.
            data_dir: Local data directory (~/.local/share/phpoc/).

        Returns:
            Remote cookie dict {"device_uuid": ..., "device_specifier": ...}
            to be pushed to remote, or None on failure.
        """
        try:
            specifier = DeviceCookie._generate_specifier()
            epoch_ms = int(time.time() * 1000)

            # Remote cookie — pushed to R2 (JSON bytes)
            remote_cookie = {
                "device_uuid": device_id,
                "device_specifier": specifier,
            }

            # Local cookie — local only (JSON)
            local_cookie = {
                "device_specifier": specifier,
                "creation_time": epoch_ms,
            }

            # Write local cookie
            meta_path = data_dir / META_FILE
            meta_path.parent.mkdir(parents=True, exist_ok=True)
            meta_path.write_text(json.dumps(local_cookie))

            # Write remote cookie bytes (to be pushed to transport)
            cookie_path = data_dir / COOKIE_FILE
            cookie_path.write_text(json.dumps(remote_cookie))

            logger.debug(
                "Device cookie created for device %s (spec=%s...)",
                device_id, specifier[:8],
            )
            return remote_cookie
        except Exception as exc:
            logger.error("Failed to create device cookie: %s", exc)
            return None

    @staticmethod
    def create_local(data_dir: Path) -> bool:
        """Create a local-only device cookie (no remote counterpart).

        Used for TTL tracking when no remote transport is configured.
        Only the local cookie (``device_cookie.meta``) is written —
        no remote cookie (``device_cookie.bin``) is produced.

        Args:
            data_dir: Local data directory (~/.local/share/phpoc/).

        Returns:
            True on success, False if the cookie file could not be written.
        """
        try:
            specifier = DeviceCookie._generate_specifier()
            epoch_ms = int(time.time() * 1000)
            local_cookie = {
                "device_specifier": specifier,
                "creation_time": epoch_ms,
            }
            meta_path = data_dir / META_FILE
            meta_path.parent.mkdir(parents=True, exist_ok=True)
            meta_path.write_text(json.dumps(local_cookie))
            logger.debug(
                "Local-only device cookie created (spec=%s...)",
                specifier[:8],
            )
            return True
        except Exception as exc:
            logger.error("Failed to create local device cookie: %s", exc)
            return False

    @staticmethod
    def is_valid_locally(data_dir: Path, ttl_minutes: int = 30) -> Optional[Dict[str, Any]]:
        """Check if a local device cookie exists and its TTL has not expired.

        Args:
            data_dir: Local data directory (~/.local/share/phpoc/).
            ttl_minutes: How long the cookie is valid (configurable, default 30).

        Returns:
            The local cookie dict {"device_specifier": ..., "creation_time": ...}
            if valid, None if missing or expired.
        """
        meta_path = data_dir / META_FILE

        if not meta_path.exists():
            return None

        try:
            local_cookie = json.loads(meta_path.read_text())
            specifier = local_cookie.get("device_specifier")
            created_at = local_cookie.get("creation_time")

            if not specifier or not created_at:
                DeviceCookie.destroy_locally(data_dir)
                return None

            elapsed_ms = int(time.time() * 1000) - created_at
            if elapsed_ms > ttl_minutes * 60 * 1000:
                # Cookie expired — clean up
                logger.debug("Device cookie expired (%d ms old)", elapsed_ms)
                DeviceCookie.destroy_locally(data_dir)
                return None

            return local_cookie
        except (json.JSONDecodeError, OSError, IOError) as exc:
            logger.warning("Failed to read local device cookie: %s", exc)
            DeviceCookie.destroy_locally(data_dir)
            return None

    @staticmethod
    def parse_remote(raw_bytes: bytes) -> Optional[Dict[str, Any]]:
        """Parse raw bytes from remote into a cookie dict.

        Args:
            raw_bytes: Raw bytes from transport pull of device_cookie.bin.

        Returns:
            Dict {"device_uuid": ..., "device_specifier": ...}
            or None if parsing fails.
        """
        try:
            return json.loads(raw_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, AttributeError):
            return None

    @staticmethod
    def matches(
        local_cookie: Dict[str, Any],
        remote_cookie: Dict[str, Any],
    ) -> bool:
        """Compare device_specifier between local and remote cookies.

        Args:
            local_cookie: Dict from local cookie file.
            remote_cookie: Dict from remote cookie (parsed via parse_remote).

        Returns:
            True if the device_specifier values match (same device session).
        """
        local_spec = local_cookie.get("device_specifier", "")
        remote_spec = remote_cookie.get("device_specifier", "")
        return bool(local_spec and remote_spec and local_spec == remote_spec)

    @staticmethod
    def get_remote_bytes(data_dir: Path) -> Optional[bytes]:
        """Read the remote cookie bytes from local cache (written by create()).

        The remote cookie is stored locally as device_cookie.bin so it can
        be pushed to the transport without needing the device_id again.

        Args:
            data_dir: Local data directory.

        Returns:
            JSON bytes of the remote cookie dict, or None.
        """
        cookie_path = data_dir / COOKIE_FILE
        try:
            if cookie_path.exists():
                return cookie_path.read_bytes()
        except OSError:
            pass
        return None

    @staticmethod
    def destroy_locally(data_dir: Path):
        """Remove local cookie files.

        Args:
            data_dir: Local data directory (~/.local/share/phpoc/).
        """
        for name in (COOKIE_FILE, META_FILE):
            path = data_dir / name
            try:
                if path.exists():
                    path.unlink()
            except OSError as exc:
                logger.warning("Failed to remove %s: %s", path, exc)
