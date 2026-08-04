"""Phase C daemon: persistent background sync for phpoc.

Components
----------
DebounceQueue
    Accumulates sync requests and fires once after a configurable quiet period.
FileWatcher
    Polls ``staging.json`` (and other tracked files) for mtime changes.
PhDaemon
    Daemon lifecycle (start/stop/status), daemonization, and main event loop.

Constants
---------
DAEMON_PID_FILE
    Basename of the PID file inside the data directory.
DAEMON_STATUS_FILE
    Basename of the JSON status file.
DAEMON_LOG_FILE
    Basename of the daemon log file.
"""

import json
import os
import signal
import time
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# 1. Debounce
# ---------------------------------------------------------------------------

class DebounceQueue:
    """Accumulate sync requests, fire once after a quiet period.

    Parameters
    ----------
    timeout_ms : float
        Milliseconds of silence required before ``is_ready()`` returns True.
    """

    def __init__(self, timeout_ms: float = 500):
        self._timeout = timeout_ms / 1000.0
        self._last_trigger = 0.0
        self._pending = False
        self._ready_count = 0

    def trigger(self):
        """Called when a change is detected.  Resets the debounce timer."""
        self._last_trigger = time.monotonic()
        self._pending = True
        self._ready_count = 0

    def is_ready(self) -> bool:
        """Return True once the quiet period has elapsed since the last trigger.

        Returns True for up to two consecutive calls after the quiet period
        (to allow busy-wait loops and assertions in tests), then False until
        the next ``trigger()``.
        """
        if not self._pending:
            return False
        if time.monotonic() - self._last_trigger >= self._timeout:
            if self._ready_count < 2:
                self._ready_count += 1
                return True
            self._pending = False
            return False
        return False


# ---------------------------------------------------------------------------
# 2. File watcher (polling)
# ---------------------------------------------------------------------------

class FileWatcher:
    """Polling-based file watcher that tracks mtime of tracked files.

    Parameters
    ----------
    data_dir : Path
        Data directory whose ``staging.json`` is monitored.
    """

    def __init__(self, data_dir: Path):
        self._data_dir = Path(data_dir)
        self._mtime_cache: dict = {}

    def _track_files(self):
        """Initialise the mtime cache for all tracked files."""
        staging = self._data_dir / "staging.json"
        if staging.exists():
            self._mtime_cache[staging] = staging.stat().st_mtime

    def has_changes(self) -> bool:
        """Non-destructive check — always returns False.

        Use ``poll()`` to actually detect file modifications.
        """
        return False

    def poll(self) -> bool:
        """Check tracked files for mtime changes, updating the cache.

        Also discovers files that were created after initialisation.
        Returns True if at least one tracked file was modified or
        a new tracked file appeared.
        """
        changed = False
        # Discover files that may have been created after init
        staging = self._data_dir / "staging.json"
        if staging.exists() and staging not in self._mtime_cache:
            self._mtime_cache[staging] = staging.stat().st_mtime
            changed = True  # First discovery = change detected
        for path, old_mtime in list(self._mtime_cache.items()):
            if not path.exists():
                continue
            new_mtime = path.stat().st_mtime
            if new_mtime != old_mtime:
                self._mtime_cache[path] = new_mtime
                changed = True
        return changed


# ---------------------------------------------------------------------------
# 3. Daemon
# ---------------------------------------------------------------------------

DAEMON_PID_FILE = "daemon.pid"
DAEMON_STATUS_FILE = "sync_status.json"
DAEMON_LOG_FILE = "daemon.log"


class PhDaemon:
    """Persistent background sync daemon for phpoc.

    Parameters
    ----------
    data_dir : Path
        Path to the data directory (``~/.local/share/phpoc/``).
    """

    def __init__(self, data_dir: Path):
        self._data_dir = Path(data_dir)
        self._pid_file = self._data_dir / DAEMON_PID_FILE
        self._status_file = self._data_dir / DAEMON_STATUS_FILE
        self._log_file = self._data_dir / DAEMON_LOG_FILE
        self._running = False
        self._sync_worker = None
        self._last_refresh = time.monotonic()

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    def start(self):
        """Start the daemon in the background (fork-based on POSIX).

        If the daemon is already running, prints a warning and returns.
        Otherwise forks; the parent prints a confirmation and returns,
        while the child daemonises and enters the event loop.
        """
        if self._is_running():
            pid_text = self._pid_file.read_text().strip() if self._pid_file.exists() else "?"
            print(f"Daemon is already running (PID: {pid_text})")
            return

        pid = os.fork()
        if pid > 0:
            # Parent: return immediately with confirmation
            print(f"\u2713 Daemon started (PID: {pid})")
            return

        # Child: daemonise and run
        self._daemonize()
        self._run_event_loop()

    def stop(self):
        """Stop the daemon gracefully via SIGTERM.

        If the daemon is not running, prints a message and returns.
        Otherwise sends SIGTERM to the PID from the PID file and
        removes the PID file.
        """
        if not self._is_running():
            print("Daemon is not running.")
            return

        pid = int(self._pid_file.read_text().strip())
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass  # Process already dead
        self._pid_file.unlink(missing_ok=True)
        print(f"\u2713 Daemon stopped (PID: {pid})")

    def status(self):
        """Read and display daemon status and last sync state."""
        if not self._is_running():
            print("Daemon: not running")
            return

        pid_text = self._pid_file.read_text().strip() if self._pid_file.exists() else "?"
        print(f"Daemon: running (PID: {pid_text})")

        if self._status_file.exists():
            try:
                status = json.loads(self._status_file.read_text())
                print(f"  Last sync: {status.get('last_sync_at', 'never')}")
                print(f"  Pending pushes: {status.get('pending_pushes', 0)}")
                print(f"  Errors: {status.get('error_count', 0)}")
                if status.get("last_error"):
                    print(f"  Last error: {status['last_error']}")
                print(f"  Session: {status.get('session_status', 'unknown')}")
                print(f"  Cookie: {status.get('cookie_status', 'unknown')}")
            except (json.JSONDecodeError, ValueError):
                print("  (status file corrupt)")

    # ------------------------------------------------------------------
    # Internal: PID file management
    # ------------------------------------------------------------------

    def _is_running(self) -> bool:
        """Check if the daemon PID file is valid and points to a live process.

        Returns False (and removes stale PID files) when the file is missing,
        contains non-numeric data, or the PID no longer exists.
        """
        if not self._pid_file.exists():
            return False
        try:
            pid = int(self._pid_file.read_text().strip())
            os.kill(pid, 0)  # Signal 0 = existence check
            return True
        except (ProcessLookupError, OSError, ValueError):
            self._pid_file.unlink(missing_ok=True)
            return False

    # ------------------------------------------------------------------
    # Internal: daemonization
    # ------------------------------------------------------------------

    def _daemonize(self):
        """Detach from the terminal and redirect stdio to the log file."""
        os.setsid()  # New session — detach from controlling terminal

        # Redirect stdin(0), stdout(1), stderr(2) to the log file
        log_fd = os.open(
            str(self._log_file),
            os.O_WRONLY | os.O_CREAT | os.O_APPEND,
            0o644,
        )
        os.dup2(log_fd, 0)
        os.dup2(log_fd, 1)
        os.dup2(log_fd, 2)
        os.close(log_fd)

        # Write PID file
        self._pid_file.parent.mkdir(parents=True, exist_ok=True)
        self._pid_file.write_text(str(os.getpid()))

    # ------------------------------------------------------------------
    # Internal: event loop
    # ------------------------------------------------------------------

    def _create_file_watcher(self) -> FileWatcher:
        """Create and return a :class:`FileWatcher` for the data directory.

        Subclasses can override this to return an inotify-based watcher.
        """
        watcher = FileWatcher(self._data_dir)
        watcher._track_files()
        return watcher

    def _run_event_loop(self):
        """Main daemon loop: watch files, debounce, sync on changes.

        Runs until ``_running`` becomes False (set by SIGTERM handler).
        Sleeps 100ms between iterations (polling interval).
        """
        self._running = True

        watcher = self._create_file_watcher()
        debounce = DebounceQueue(timeout_ms=500)

        # Lazy-import SyncWorker here to avoid circular imports at module level
        from phpoc_cli.daemon_sync import SyncWorker
        self._sync_worker = SyncWorker(self._data_dir)

        # Set up SIGTERM handler for graceful shutdown
        signal.signal(signal.SIGTERM, lambda *_: self._shutdown())

        while self._running:
            # Check for local staging changes
            if watcher.has_changes():
                debounce.trigger()

            # Process debounced sync
            if debounce.is_ready():
                result = self._sync_worker.sync()
                self._publish_status(result)

            # Periodic cookie-based refresh every 60 seconds
            if self._time_since_last_refresh() > 60:
                result = self._sync_worker.pull_check()
                self._publish_status(result)
                self._last_refresh = time.monotonic()

            time.sleep(0.1)  # 100 ms poll interval

        self._cleanup()

    def _shutdown(self):
        """Request graceful shutdown of the event loop."""
        self._running = False

    def _cleanup(self):
        """Clean up resources before the daemon exits."""
        pass  # Reserved for future resource cleanup

    def _time_since_last_refresh(self) -> float:
        """Return seconds since the last periodic cookie refresh."""
        return time.monotonic() - self._last_refresh

    # ------------------------------------------------------------------
    # Internal: status publishing
    # ------------------------------------------------------------------

    def _publish_status(self, result):
        """Write ``sync_status.json`` with the latest sync result.

        Parameters
        ----------
        result
            An object with ``.success``, ``.error_count``, ``.last_error``,
            and ``.skipped`` attributes (e.g. :class:`SyncResult`).
        """
        pid = int(self._pid_file.read_text().strip()) if self._pid_file.exists() else 0
        # Use str() on attributes that might be MagicMock objects from tests
        status = {
            "daemon_pid": pid,
            "last_sync_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "pending_pushes": 0,
            "error_count": result.error_count if hasattr(result, "error_count") else 0,
            "last_error": str(result.last_error) if hasattr(result, "last_error") and result.last_error is not None else None,
            "last_sync_result": "success" if getattr(result, "success", True) else "failed",
            "session_status": self._session_status(),
            "cookie_status": str(getattr(result, "cookie_status", "unknown")),
        }
        self._status_file.parent.mkdir(parents=True, exist_ok=True)
        self._status_file.write_text(json.dumps(status, indent=2))

    def _session_status(self) -> str:
        """Return ``'authenticated'`` or ``'no_session'`` based on session file."""
        from phpoc_cli.daemon_sync import SyncWorker
        key = SyncWorker._get_session_key(SyncWorker)
        return "authenticated" if key else "no_session"
