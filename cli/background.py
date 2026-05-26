"""Phase A — instant reads with deferred background remote check.

Provides the IPC machinery between a short-lived CLI process and its
detached background subprocess:

  - Notification files: written by the background process, read by the
    next CLI command. Only communication channel between processes.
  - Lock files: debounce mechanism to prevent N simultaneous background
    checks when the user runs N commands in rapid succession.
  - Cookie check: the background process compares local vs remote device
    cookies (32-byte HMAC, no decryption needed) to detect whether the
    remote has diverged from local.

Lifecycle:
  1. CLI command (e.g. ``ph view``) reads local staging, displays instantly
  2. CLI spawns detached background subprocess via ``_spawn_background_sync_check()``
  3. Background subprocess runs ``handle_background_sync_check()``
  4. Background writes notification file if remote differs
  5. Next CLI command reads and displays the notification, then clears it
"""

import json
import os
import subprocess
import sys
import time
import logging
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Relative path within data_dir for the notification file
SYNC_NOTIFICATION_FILENAME = "sync_notification.json"
SYNC_CHECK_LOCK_FILENAME = "sync_check.lock"
NOTIFICATION_MAX_AGE_MS = 24 * 3600 * 1000  # 24 hours
LOCK_COOLDOWN_SECONDS = 30  # Don't spawn if lock is younger than this
_NOTIFICATION_TYPES = {"remote_changes", "auth_needed"}

# Session file path (mirrors PassphraseAuthenticator.SESSION_FILE in security/auth.py)
# Written by the authenticator as raw 32-byte master key after successful login.
_SESSION_FILE = Path("/dev/shm/phpoc_session") if Path("/dev/shm").exists() else Path("/tmp/phpoc_session")



# ------------------------------------------------------------------
# Notification file — IPC between background and future CLI commands
# ------------------------------------------------------------------

def _write_notification(notification_path: Path, data: Dict[str, Any]):
    """Write a notification dict to *notification_path* as JSON.

    Args:
        notification_path: Absolute path to the notification file.
        data: Dict with at least ``type``, ``message``, ``timestamp`` keys.
    """
    # Validate required fields — reject unknown types
    if data.get("type") not in _NOTIFICATION_TYPES:
        logger.warning("Ignoring notification with unknown type: %s", data.get("type"))
        return
    if "message" not in data or "timestamp" not in data:
        logger.warning("Ignoring notification with missing fields")
        return
    try:
        notification_path.parent.mkdir(parents=True, exist_ok=True)
        notification_path.write_text(json.dumps(data))
    except OSError as exc:
        logger.warning("Failed to write notification: %s", exc)


def _clear_notification(notification_path: Path):
    """Remove the notification file if it exists.

    Safe to call even if the file doesn't exist.
    """
    try:
        if notification_path.exists():
            notification_path.unlink()
    except OSError as exc:
        logger.warning("Failed to clear notification: %s", exc)


def _read_notification(notification_path: Path) -> Optional[Dict[str, Any]]:
    """Read and return the notification if it exists and is not stale.

    Returns None if the file is missing, malformed, or older than
    NOTIFICATION_MAX_AGE_MS.

    Does NOT clear the file — caller is responsible for that.
    """
    if not notification_path.exists():
        return None
    try:
        data = json.loads(notification_path.read_text())
        age_ms = int(time.time() * 1000) - data.get("timestamp", 0)
        if age_ms > NOTIFICATION_MAX_AGE_MS:
            _clear_notification(notification_path)
            return None
        return data
    except (json.JSONDecodeError, OSError, IOError):
        _clear_notification(notification_path)
        return None


# ------------------------------------------------------------------
# Debounce — lock file prevents multiple simultaneous background checks
# ------------------------------------------------------------------

def _should_spawn_background_check(data_dir: Path, cooldown: int = LOCK_COOLDOWN_SECONDS) -> bool:
    """Check whether a new background sync check should be spawned.

    Returns False if a lock file exists and is younger than *cooldown*
    seconds (debounce). Returns True otherwise.

    Stale lock files (older than cooldown) are considered dead and
    do not block spawning.
    """
    lock_path = data_dir / SYNC_CHECK_LOCK_FILENAME
    if not lock_path.exists():
        return True

    try:
        age = time.time() - lock_path.stat().st_mtime
        if age < cooldown:
            return False  # Too recent — debounce
        # Stale lock — allow spawn
    except OSError:
        pass
    return True


def _write_lock_file(lock_path: Path) -> bool:
    """Write the lock file with current PID.

    Returns True if written successfully, False on error.
    """
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path.write_text(str(os.getpid()))
        return True
    except OSError as exc:
        logger.warning("Failed to write lock file: %s", exc)
        return False


def _clear_lock_file(lock_path: Path):
    """Remove the lock file. Safe to call if it doesn't exist."""
    try:
        if lock_path.exists():
            lock_path.unlink()
    except OSError as exc:
        logger.warning("Failed to clear lock file: %s", exc)


# ------------------------------------------------------------------
# Core cookie check logic
# ------------------------------------------------------------------

def _try_renew_aging_cookie(
    data_dir: Path,
    remote_sync,
    ttl_minutes: int,
    renewal_threshold: float = 0.9,
) -> bool:
    """If the local cookie is close to expiry, silently renew it.

    Reads the age from the local cookie meta file. If >= *renewal_threshold*
    of TTL has elapsed, attempts to create a fresh cookie using the cached
    session master key and push it to remote. Fails silently if no session
    key is available (the user will re-auth naturally on next expiry).

    Args:
        data_dir: Local data directory.
        remote_sync: RemoteStagingSync instance (for device_id and push).
        ttl_minutes: Cookie TTL in minutes.
        renewal_threshold: Fraction of TTL at which to renew (0.9 = 90%).
                          1.0 = never renew. 0.0 = renew every check.

    Returns:
        True if the cookie was successfully renewed, False otherwise.
    """
    from domain.cookie.device_cookie import DeviceCookie

    meta_path = data_dir / DeviceCookie.META_FILE
    if not meta_path.exists():
        return False

    try:
        meta = json.loads(meta_path.read_text())
        created_at = meta.get("creation_time")
        if created_at is None:
            return False

        # Check remaining TTL against threshold
        age_ms = int(time.time() * 1000) - created_at
        ttl_ms = ttl_minutes * 60 * 1000
        fraction_used = age_ms / ttl_ms
        if fraction_used < renewal_threshold:
            return False  # Not yet time to renew

        # Try to read the session master key
        if not _SESSION_FILE.exists():
            logger.debug("Cookie renewal: no session file, skipping")
            return False

        master_key = _SESSION_FILE.read_bytes()
        if len(master_key) != 32:
            logger.debug("Cookie renewal: invalid session key length")
            return False

        # Get device identity
        try:
            identity = remote_sync._device_id_provider.get_device_identity(master_key)
            device_id = identity.device_id
        except Exception:
            logger.debug("Cookie renewal: failed to get device identity")
            return False

        # Create fresh cookie and push to remote
        remote_cookie = DeviceCookie.create(device_id, data_dir)
        if remote_cookie is None:
            return False

        cookie_bytes = json.dumps(remote_cookie).encode("utf-8")
        remote_sync.push_cookie(cookie_bytes)
        logger.debug("Device cookie renewed (device=%s, age=%dms)", device_id, age_ms)
        return True

    except (OSError, json.JSONDecodeError) as exc:
        logger.debug("Cookie renewal failed: %s", exc)
        return False


def _run_cookie_check(
    data_dir: Path,
    remote_sync,
    notification_path: Path,
    cookie_ttl_minutes: int = 30,
    renewal_threshold: float = 0.9,
):
    """Compare local device cookie against remote cookie.

    This is the core Phase A logic, designed to be called from the
    background subprocess. It never prompts for auth — if it can't
    decide via cookies alone, it writes a notification telling the
    user what to do.

    Args:
        data_dir: Local data directory (``~/.local/share/phpoc/``).
        remote_sync: A ``RemoteStagingSync`` instance for cookie pull.
        notification_path: Where to write the notification file.
        cookie_ttl_minutes: Cookie TTL (matches staging service config).
    """
    try:
        # 1. Check local cookie
        from domain.cookie.device_cookie import DeviceCookie

        local_cookie = DeviceCookie.is_valid_locally(data_dir, ttl_minutes=cookie_ttl_minutes)

        if local_cookie is None:
            # No local cookie or expired — can't verify identity without auth
            _write_notification(notification_path, {
                "type": "auth_needed",
                "message": (
                    "Cross-device sync requires authentication. "
                    "Run 'ph sync remote_staging' to authenticate and merge."
                ),
                "timestamp": int(time.time() * 1000),
            })
            return

        # 2. Pull remote cookie
        try:
            remote_cookie = remote_sync.pull_cookie()
        except Exception:
            # Network/transport error — fail silently, no notification
            # (the user will get the normal error on their next explicit sync)
            return

        remote_parsed = DeviceCookie.parse_remote(remote_cookie) if remote_cookie else None
        if remote_parsed is None or not DeviceCookie.matches(local_cookie, remote_parsed):
            # Remote has no cookie, or cookie from a different device/session
            _write_notification(notification_path, {
                "type": "remote_changes",
                "message": (
                    "Remote changes detected from another device. "
                    "Run 'ph sync remote_staging' to merge."
                ),
                "timestamp": int(time.time() * 1000),
            })
            return

        # 3. Cookies match — local is in sync. Clear any stale notification.
        _clear_notification(notification_path)

        # 4. Optional renewal: if cookie is close to expiry (>=90% TTL used),
        #    silently renew using the cached session key. Fails gracefully if
        #    no session key is available (user will re-auth naturally).
        _try_renew_aging_cookie(data_dir, remote_sync, cookie_ttl_minutes,
                                 renewal_threshold)

    except Exception as exc:
        # Absolute last resort — don't crash the background process
        logger.warning("Background cookie check failed: %s", exc)


def _run_cookie_check_with_cleanup(
    data_dir: Path,
    remote_sync,
    notification_path: Path,
    lock_path: Path,
    cookie_ttl_minutes: int = 30,
    renewal_threshold: float = 0.9,
):
    """Wrap ``_run_cookie_check()`` with guaranteed lock-file cleanup.

    Always clears the lock file on exit, even if the cookie check raises.
    This prevents the debounce from permanently blocking future checks after
    a crash.
    """
    try:
        _run_cookie_check(
            data_dir=data_dir,
            remote_sync=remote_sync,
            notification_path=notification_path,
            cookie_ttl_minutes=cookie_ttl_minutes,
            renewal_threshold=renewal_threshold,
        )
    finally:
        _clear_lock_file(lock_path)


# ------------------------------------------------------------------
# Spawn a detached background subprocess
# ------------------------------------------------------------------

def _spawn_background_sync_check(staging) -> bool:
    """Fork a detached subprocess to check remote cookie status.

    Must be called AFTER displaying local data to the user — this is
    fire-and-forget. The subprocess writes a notification file if remote
    differs; the next CLI command reads it.

    Returns True if the subprocess was spawned, False if debounced or
    no remote configured.

    Args:
        staging: A ``StagingService`` instance with a remote transport.
    """
    if staging._remote is None:
        return False  # No remote configured — nothing to check

    data_dir = staging._data_dir
    if not isinstance(data_dir, Path):
        data_dir = Path(data_dir)

    # Debounce: don't spawn if a recent check is already running
    if not _should_spawn_background_check(data_dir):
        logger.debug("Background sync check debounced (lock file too recent)")
        return False

    # Write lock file BEFORE spawning to prevent races
    lock_path = data_dir / SYNC_CHECK_LOCK_FILENAME
    if not _write_lock_file(lock_path):
        return False  # Can't write lock — skip

    # Build the subprocess command: re-invoke the CLI with a hidden subcommand
    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "phpoc", "_background_sync_check",
             "--dir", str(data_dir)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,  # Detach from terminal; survives close
        )
        logger.debug("Spawned background sync check (PID %s)", proc.pid)
        return True
    except Exception as exc:
        # Failed to spawn — release the lock so next command can retry
        _clear_lock_file(lock_path)
        logger.warning("Failed to spawn background sync check: %s", exc)
        return False


# ------------------------------------------------------------------
# Display notifications on the next CLI command
# ------------------------------------------------------------------

def _show_sync_notifications(data_dir: Path) -> bool:
    """Read and print any pending sync notification to stderr.

    After displaying, the notification file is removed so it doesn't
    repeat on every command.

    Returns True if a notification was displayed, False otherwise.

    Args:
        data_dir: Local data directory (``~/.local/share/phpoc/``).
    """
    notification_path = data_dir / SYNC_NOTIFICATION_FILENAME
    data = _read_notification(notification_path)
    if data is None:
        return False

    message = data.get("message", "")
    if message:
        print(f"\n\u2139\ufe0f {message}\n", file=sys.stderr)

    _clear_notification(notification_path)
    return True


# ------------------------------------------------------------------
# Entry point for the background subprocess (called from main.py)
# ------------------------------------------------------------------

def handle_background_sync_check(data_dir_str: str):
    """Entry point for the hidden ``_background_sync_check`` subcommand.

    Runs inside the forked/detached subprocess. Reconstructs enough
    state to check the remote cookie, writes a notification if needed,
    and exits. Silent on success — errors go to the log, not stderr.

    Args:
        data_dir_str: String path to the data directory, passed via CLI arg.
    """
    data_dir = Path(data_dir_str)

    if not data_dir.exists():
        logger.debug("Background sync: data_dir %s does not exist, skipping", data_dir)
        return

    lock_path = data_dir / SYNC_CHECK_LOCK_FILENAME
    notification_path = data_dir / SYNC_NOTIFICATION_FILENAME

    # Verify we own the lock (the lock was written by our parent before spawning us)
    # This prevents orphaned checks from running if the parent crashed after
    # writing the lock but before spawning.
    try:
        if lock_path.exists():
            lock_pid = int(lock_path.read_text().strip())
            if lock_pid != os.getpid():
                # Lock is owned by a different process (possibly a stale one).
                # Only proceed if it's actually stale (older than cooldown).
                age = time.time() - lock_stat.st_mtime
                if age < LOCK_COOLDOWN_SECONDS:
                    logger.debug("Background sync: lock owned by PID %s, skipping", lock_pid)
                    return
    except (OSError, ValueError):
        pass

    # Reconstruct minimal dependencies
    try:
        # Load config (needed for cookie TTL and transport URL)
        from security.config_manager import ConfigManager
        from storage.implementations.file_config import FileConfigStore

        config_path = _resolve_config_path_for_background()
        config_store = FileConfigStore(config_path)
        config = ConfigManager(config_store)

        remote_url = config.get("remote.git_remote_url")
        if not remote_url:
            logger.debug("Background sync: no remote configured, skipping")
            return

        cookie_ttl = config.get("cookie.ttl_minutes", 30)
        renewal_threshold = config.get("cookie.renewal_threshold", 0.9)

        # Build transport
        from core.sync.git_transport import GitStagingTransport

        clone_path = str(data_dir / "remote")
        transport = GitStagingTransport(remote_url, clone_path)

        # Build minimal RemoteStagingSync (just for cookie pull)
        from domain.staging.remote_sync import RemoteStagingSync
        from security.crypto import NoAuthCryptoManager
        from security.device_identity import RandomUUIDDeviceIdentityProvider

        # Use NoAuthCryptoManager — we don't need blob decryption, just cookies
        crypto = NoAuthCryptoManager()
        device_provider = RandomUUIDDeviceIdentityProvider(config)
        remote_sync = RemoteStagingSync(
            crypto=crypto,
            transport=transport,
            device_id_provider=device_provider,
        )

        # Run the check
        _run_cookie_check_with_cleanup(
            data_dir=data_dir,
            remote_sync=remote_sync,
            notification_path=notification_path,
            lock_path=lock_path,
            cookie_ttl_minutes=cookie_ttl,
            renewal_threshold=renewal_threshold,
        )

    except Exception as exc:
        logger.warning("Background sync check failed: %s", exc)
        # Ensure lock is released even on unexpected error
        _clear_lock_file(lock_path)


def _resolve_config_path_for_background() -> Path:
    """Resolve config path inside the background subprocess.

    Avoids importing from ``storage.implementations.file_config`` at
    module level (which would trigger XDG path resolution at import
    time, potentially with different env vars).
    """
    from storage.implementations.file_config import _resolve_config_path
    return _resolve_config_path()
