"""Phase B — WAL (Write-Ahead Log) for crash-safe deferred remote push.

Provides the machinery to make ``ph add start/end/pause/unpause`` return
instantly (~2ms) while deferring the remote git/SSH push to a background
subprocess. The WAL guarantees that no local change is lost even if the
process or machine crashes before the push completes.

Lifecycle:
  1. CLI write command (e.g. ``ph add start "foo"``) writes to local
     staging JSON and triggers ``_write_wal_pending()``
  2. WAL entry is a small JSON file at ``<data_dir>/wal/pending_push``
     containing a SHA-256 hash of staging (for crash detection) and a
     timestamp
  3. CLI spawns a detached background subprocess via
     ``_spawn_background_push()`` (fire-and-forget)
  4. Background subprocess checks session cache:
     - Session key exists → pull, merge, push → clear WAL
     - No session key → write notification → WAL stays for retry
  5. On next CLI startup, ``_replay_wal()`` checks if the WAL still
     exists and retries the push if the session key is now available
"""

import json
import hashlib
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

from cli.background import (
    _SESSION_FILE,
    _write_notification,
    SYNC_NOTIFICATION_FILENAME,
)

logger = logging.getLogger(__name__)

# Relative path within data_dir
WAL_SUBDIR = "wal"
WAL_FILENAME = "pending_push"

# Max age of a stale WAL before it's silently cleaned up
STALE_WAL_MAX_AGE_MS = 24 * 3600 * 1000  # 24 hours


# ------------------------------------------------------------------
# WAL read / write / clear
# ------------------------------------------------------------------


def _wal_path(data_dir: Path) -> Path:
    """Return the absolute path to the WAL file."""
    return data_dir / WAL_SUBDIR / WAL_FILENAME


def _write_wal_pending(data_dir: Path, staging_entries: list, device_id: str) -> bool:
    """Write a WAL entry recording that staging was just modified.

    Args:
        data_dir: Local data directory (``~/.local/share/phpoc/``).
        staging_entries: The current list of staging entries (from
            ``read_entries()``), used to compute the staging hash.
        device_id: Current device UUID.

    Returns:
        True if the WAL was written successfully, False on error.
    """
    wal_path = _wal_path(data_dir)
    try:
        wal_path.parent.mkdir(parents=True, exist_ok=True)

        # Compute a hash of the staging content at this moment
        staging_hash = hashlib.sha256(
            json.dumps(staging_entries, sort_keys=True).encode()
        ).hexdigest()

        wal_path.write_text(json.dumps({
            "created_at": int(time.time() * 1000),
            "staging_hash": staging_hash,
            "device_id": device_id,
        }))
        return True
    except OSError as exc:
        logger.warning("Failed to write WAL entry: %s", exc)
        return False


def _read_wal(data_dir: Path) -> Optional[Dict[str, Any]]:
    """Read the WAL entry if it exists and is not stale.

    Returns None if the WAL is missing, corrupted, or older than
    ``STALE_WAL_MAX_AGE_MS`` (24 hours). Stale WALs are silently
    cleaned up.

    Does NOT clear the WAL — caller is responsible.
    """
    wal_path = _wal_path(data_dir)
    if not wal_path.exists():
        return None
    try:
        data = json.loads(wal_path.read_text())
    except (json.JSONDecodeError, OSError, IOError):
        _clear_wal(data_dir)
        return None

    # Must be a dict (not a list or primitive)
    if not isinstance(data, dict):
        _clear_wal(data_dir)
        return None

    age_ms = int(time.time() * 1000) - data.get("created_at", 0)
    if age_ms > STALE_WAL_MAX_AGE_MS:
        _clear_wal(data_dir)
        return None
    return data


def _clear_wal(data_dir: Path):
    """Remove the WAL file if it exists. Safe to call if already cleared."""
    wal_path = _wal_path(data_dir)
    try:
        if wal_path.exists():
            wal_path.unlink()
    except OSError as exc:
        logger.warning("Failed to clear WAL: %s", exc)


def has_pending_wal(data_dir: Path) -> bool:
    """Return True if a valid, non-stale WAL entry exists."""
    return _read_wal(data_dir) is not None


def get_wal_info(data_dir: Path) -> Optional[Dict[str, Any]]:
    """Return WAL metadata for display (``ph sync status``).

    Returns the raw WAL data plus a computed ``age_minutes`` field.
    Returns None if no WAL exists.
    """
    data = _read_wal(data_dir)
    if data is None:
        return None
    data = dict(data)  # Shallow copy
    age_ms = int(time.time() * 1000) - data.get("created_at", 0)
    data["age_minutes"] = round(age_ms / 60_000, 1)
    return data


# ------------------------------------------------------------------
# WAL replay — retry deferred push on next CLI startup
# ------------------------------------------------------------------


def _replay_wal(data_dir: Path, staging_service) -> bool:
    """Attempt to replay a pending WAL on CLI startup or before a command.

    If a WAL exists and staging has been modified since the WAL was
    written (hash mismatch), tries to push using the cached session key.
    If the session key is available, pushes and clears the WAL.

    Args:
        data_dir: Local data directory.
        staging_service: A ``StagingService`` instance with remote configured.

    Returns:
        True if the WAL was successfully replayed and cleared.
        False if no WAL existed, or replay was skipped (no session, or
        staging hash matches — nothing new to push).
    """
    wal_data = _read_wal(data_dir)
    if wal_data is None:
        return False

    # Read current staging entries to compare hash
    try:
        current_entries = staging_service._local._store.read_entries()
    except Exception as exc:
        logger.warning("WAL replay: failed to read staging entries: %s", exc)
        return False

    current_hash = hashlib.sha256(
        json.dumps(current_entries, sort_keys=True).encode()
    ).hexdigest()

    # If the hash matches, staging hasn't changed since WAL was written.
    # Nothing to push — just clean up the stale WAL.
    if current_hash == wal_data.get("staging_hash"):
        _clear_wal(data_dir)
        return False

    # Staging has new content — try to push if we have a session key
    if not _SESSION_FILE.exists():
        logger.debug("WAL replay: no session key, WAL preserved for later")
        return False

    try:
        master_key = _SESSION_FILE.read_bytes()
        if len(master_key) != 32:
            logger.warning("WAL replay: invalid session key length")
            return False

        # Push to remote (this also creates a fresh cookie)
        # Use a short timeout since this runs inline before a user command
        staging_service.push_to_remote(master_key=master_key)
        _clear_wal(data_dir)
        logger.debug("WAL replay: push succeeded, WAL cleared")
        return True
    except Exception as exc:
        logger.warning("WAL replay: push failed (%s), WAL preserved", exc)
        return False


# ------------------------------------------------------------------
# Background push subprocess — fire-and-forget after write commands
# ------------------------------------------------------------------


def _spawn_background_push(data_dir: Path) -> bool:
    """Spawn a detached subprocess to push local staging to remote.

    Called after every write command (add_start, add_end, etc.) to
    defer the git/SSH push to the background.

    The subprocess runs ``_background_push()`` which reads the WAL,
    checks for a session key, and pushes if possible.

    Returns True if spawned, False if already debounced or error.
    """
    if not isinstance(data_dir, Path):
        data_dir = Path(data_dir)

    # Use the same debounce lock from Phase A to prevent concurrent pushes
    from cli.background import (
        _should_spawn_background_check,
        _write_lock_file,
        _clear_lock_file,
        SYNC_CHECK_LOCK_FILENAME,
    )

    if not _should_spawn_background_check(data_dir, cooldown=30):
        logger.debug("Background push debounced (lock file too recent)")
        return False

    lock_path = data_dir / SYNC_CHECK_LOCK_FILENAME
    if not _write_lock_file(lock_path):
        return False

    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "phpoc", "_background_push",
             "--dir", str(data_dir)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        logger.debug("Spawned background push (PID %s)", proc.pid)
        return True
    except Exception as exc:
        _clear_lock_file(lock_path)
        logger.warning("Failed to spawn background push: %s", exc)
        return False


def _background_push(data_dir_str: str):
    """Entry point for the hidden ``_background_push`` subcommand.

    Runs inside the detached subprocess. Reconstructs enough state to
    push staging to remote if a session key is available.

    Silent on success — errors go to the log, not stderr.
    """
    data_dir = Path(data_dir_str)
    if not data_dir.exists():
        logger.debug("Background push: data_dir %s does not exist, skipping", data_dir)
        return

    # Read WAL to know what to push
    wal_data = _read_wal(data_dir)
    if wal_data is None:
        logger.debug("Background push: no WAL, nothing to push")
        return

    # Check session key
    if not _SESSION_FILE.exists():
        logger.debug("Background push: no session key, writing notification")
        notification_path = data_dir / SYNC_NOTIFICATION_FILENAME
        _write_notification(notification_path, {
            "type": "auth_needed",
            "message": (
                "Local changes saved. Authenticate to push to remote. "
                "Run 'ph login' or 'ph sync remote_staging'."
            ),
            "timestamp": int(time.time() * 1000),
        })
        return

    try:
        master_key = _SESSION_FILE.read_bytes()
        if len(master_key) != 32:
            logger.warning("Background push: invalid session key length")
            return

        # Reconstruct dependencies
        from security.config_manager import ConfigManager
        from storage.implementations.file_config import FileConfigStore, _resolve_config_path

        config_path = _resolve_config_path()
        config_store = FileConfigStore(config_path)
        config = ConfigManager(config_store)

        transport = None
        transport_type = config.get("remote.transport", "git")

        if transport_type == "http":
            base_url = config.get("http.base_url")
            api_key = config.get("http.api_key")
            if not base_url:
                logger.debug("Background push: http.base_url not set, skipping")
                return
            from core.sync.http_transport import HttpStagingTransport
            transport = HttpStagingTransport(base_url=base_url, api_key=api_key)
        else:
            remote_url = config.get("remote.git_remote_url")
            if not remote_url:
                logger.debug("Background push: no remote configured, skipping")
                return
            from core.sync.git_transport import GitStagingTransport
            transport = GitStagingTransport(remote_url, str(data_dir / "remote"))

        from domain.staging.remote_sync import RemoteStagingSync
        from domain.staging.service import StagingService
        from domain.staging.local_cache import LocalStagingCache
        from storage.implementations.file_staging import FileStagingStore
        from security.crypto import CryptoManager, NoAuthCryptoManager
        from security.device_identity import RandomUUIDDeviceIdentityProvider

        crypto = CryptoManager(master_key)
        data_store = FileStagingStore(data_dir)
        local_cache = LocalStagingCache(data_store)

        device_provider = RandomUUIDDeviceIdentityProvider(config)
        remote_sync = RemoteStagingSync(
            crypto=crypto,
            transport=transport,
            device_id_provider=device_provider,
        )

        cookie_ttl = config.get("cookie.ttl_minutes", 30)
        staging_service = StagingService(
            local_cache=local_cache,
            remote_sync=remote_sync,
            crypto=crypto,
            device_id_provider=device_provider,
            config=config,
            data_dir=data_dir,
            cookie_ttl_minutes=cookie_ttl,
        )

        # Push to remote (pull + merge + push cookie + push blob)
        staging_service.push_to_remote(master_key=master_key)

        # Clear WAL on success
        _clear_wal(data_dir)
        logger.debug("Background push: success, WAL cleared")

        # Also clear any stale notification
        notification_path = data_dir / SYNC_NOTIFICATION_FILENAME
        if notification_path.exists():
            try:
                notification_path.unlink()
            except OSError:
                pass

    except Exception as exc:
        logger.warning("Background push failed: %s", exc)
        # WAL is preserved for retry


# ------------------------------------------------------------------
# CLI helpers for ph sync status
# ------------------------------------------------------------------


def format_wal_status(data_dir: Path) -> Optional[str]:
    """Return a human-readable WAL status line for ``ph sync status``.

    Returns None if no WAL exists.
    """
    info = get_wal_info(data_dir)
    if info is None:
        return None

    age_min = info["age_minutes"]
    hash_preview = info["staging_hash"][:12]
    return (
        f"\u26a0\ufe0f  Un-pushed local changes ({age_min:.0f} min old)\n"
        f"   Staging hash: {hash_preview}..."
    )
