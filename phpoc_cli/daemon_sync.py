"""SyncWorker for Phase C daemon: session management, retry logic, conflict resolution.

Exports
-------
SyncResult
    Dataclass-like result object with ``success``, ``error_count``, ``last_error``,
    ``skipped``, ``reason``, and ``cookie_status`` fields.  Truthy when ``success`` is True.
SyncWorker
    Background sync worker that reads the shared session key from ``/dev/shm/phpoc_session``,
    delegates pushes to ``StagingService``, and handles non-fast-forward push conflicts with
    exponential backoff.
"""

import time
from pathlib import Path
from typing import Optional


class SyncResult:
    """Result of a sync operation.

    ``__bool__()`` returns ``self.success`` so callers can write
    ``if result: ...`` to test success.
    """

    __slots__ = ("success", "error_count", "last_error", "skipped", "reason",
                 "cookie_status")

    def __init__(self, success: Optional[bool] = None, *,
                 skipped: bool = False, reason: Optional[str] = None,
                 error_count: int = 0, last_error: Optional[str] = None,
                 cookie_status: str = "unknown"):
        self.success = success if success is not None else (not skipped)
        self.skipped = skipped
        self.reason = reason
        self.error_count = error_count
        self.last_error = last_error
        self.cookie_status = cookie_status

    def __bool__(self) -> bool:
        return self.success


class SyncWorker:
    """Background sync worker used by the daemon event loop.

    Parameters
    ----------
    data_dir : Path
        Path to the data directory (``~/.local/share/phpoc/``).
    """

    MAX_RETRIES = 3
    BACKOFF_BASE_MS = 1000

    SESSION_PATH = Path("/dev/shm/phpoc_session")

    def __init__(self, data_dir: Path):
        self._data_dir = Path(data_dir)
        self._staging_service = None  # lazy-created if needed

    # ------------------------------------------------------------------
    # Session key
    # ------------------------------------------------------------------

    def _get_session_key(self) -> Optional[bytes]:
        """Read the shared session key from ``/dev/shm/phpoc_session``.

        Returns ``None`` (no crash) when the file is missing or unreadable.
        """
        if not self.SESSION_PATH.exists():
            return None
        try:
            return self.SESSION_PATH.read_bytes()
        except (OSError, PermissionError):
            return None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def sync(self) -> SyncResult:
        """Push local staging to remote if a session key is available.

        Returns
        -------
        SyncResult
            If no session: ``SyncResult(skipped=True, reason="no_session")``.
            Otherwise delegates to ``_push_with_retry()``.
        """
        mk = self._get_session_key()
        if mk is None:
            return SyncResult(skipped=True, reason="no_session")
        return self._push_with_retry(self._staging_service, mk)

    def pull_check(self) -> SyncResult:
        """Lightweight remote cookie check (no staging push).

        Returns
        -------
        SyncResult
            If no session: ``SyncResult(skipped=True, reason="no_session")``.
            Otherwise runs ``check_and_sync()`` for cookie-based identity checks
            and propagates the result status.

            - Ready / offline: ``success=True``
            - Re-auth needed: ``success=False, cookie_status="reauth_needed"``
        """
        mk = self._get_session_key()
        if mk is None:
            return SyncResult(skipped=True, reason="no_session")

        if self._staging_service is not None:
            check_result = self._staging_service.check_and_sync(timeout_ms=500)

            # Handle SyncCheckResult enum values
            import enum
            if isinstance(check_result, enum.Enum):
                value = check_result.value
                if value == "reauth":
                    return SyncResult(success=False, error_count=1,
                                      last_error="Device mismatch — re-authentication required",
                                      cookie_status="reauth_needed")
                elif value == "offline":
                    return SyncResult(success=True,
                                      cookie_status="offline")
                else:  # ready
                    return SyncResult(success=True,
                                      cookie_status="ready")

            # Dict-like result (used in tests for passthrough fields)
            cookie_status = getattr(check_result, "cookie_status", "checked")
            remote_device_id = getattr(check_result, "remote_device_id", None)
            return SyncResult(success=True, cookie_status=cookie_status)

        return SyncResult(success=True, cookie_status="checked")

    # ------------------------------------------------------------------
    # Internal: push with exponential-backoff retry
    # ------------------------------------------------------------------

    def _push_with_retry(self, staging_service, mk: bytes) -> SyncResult:
        """Push staging to remote, retrying on non-fast-forward conflicts.

        Parameters
        ----------
        staging_service
            Object with ``push_to_remote(master_key=...)`` and
            ``check_and_sync(timeout_ms=...)`` methods.
        mk : bytes
            Master key to pass to ``push_to_remote``.

        Returns
        -------
        SyncResult
            ``SyncResult(success=True)`` on success, or
            ``SyncResult(success=False, error_count=N, last_error=...)``
            after all retries are exhausted.

        Raises
        ------
        RuntimeError
            If ``push_to_remote`` raises a non-conflict ``RuntimeError``
            (e.g. SSH auth failure) — these are not retried.
        """
        last_error = None
        for attempt in range(self.MAX_RETRIES):
            try:
                staging_service.push_to_remote(master_key=mk)
                return SyncResult(success=True, error_count=attempt)
            except RuntimeError as e:
                last_error = str(e)
                # Only retry non-fast-forward push rejections
                if "rejected" not in last_error or "non-fast-forward" not in last_error:
                    raise
                wait = self.BACKOFF_BASE_MS * (2 ** attempt)
                time.sleep(wait / 1000.0)
                # Re-pull and merge before retry push
                staging_service.check_and_sync(timeout_ms=500)

        return SyncResult(success=False, error_count=self.MAX_RETRIES,
                          last_error=last_error)
