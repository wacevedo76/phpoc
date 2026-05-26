"""StagingService — unified sync gate + local I/O for staging entries.

The StagingService is the central point for all staging operations:

  1. **Local CRUD** — capture/end/pause/unpause/modify/remove entries
     in the local staging store. These are low-latency (no remote calls).

  2. **Sync gate** — ``check_and_sync()`` is the single entry point for
     remote staging sync. It decides whether to pull+merge (different
     device or stale local) or skip (same device, up to date).

  3. **Push** — ``push_to_remote()`` serialises local entries, obfuscates,
     and pushes to the remote transport. Called from Phase B (WAL) and
     Phase C (daemon).

  4. **Device Cookie** — ``check_and_sync()`` uses a fast-path cookie check
     to avoid pulling the ~64 KB staging blob when the same device session
     was the last writer. The cookie is a tiny JSON blob with a random
     ``device_specifier`` — no decryption needed.

Usage::

    crypto = CryptoManager(master_key)
    store = FileStagingStore(staging_path)
    staging = StagingService(crypto, store, transport, ...)

    # Before any command:
    result = staging.check_and_sync()
    if result == SyncCheckResult.REAUTH_NEEDED:
        # Prompt user for passphrase and re-create CryptoManager
        ...

    # After successful auth:
    staging.capture("New task")
    staging.end("Old task")
    staging.push_to_remote(master_key)
"""

import json
import time
import logging
from pathlib import Path
from typing import Optional, Dict, Any, List

from cli.trace import trace
from domain.cookie.device_cookie import DeviceCookie
from domain.staging.local_cache import LocalStagingCache
from domain.staging.merge_engine import MergeEngine
from domain.staging.remote_sync import RemoteStagingSync
from security.crypto import (
    AbstractCryptoManager,
    NoAuthCryptoManager,
)

logger = logging.getLogger(__name__)


class SyncCheckResult:
    """Result of ``check_and_sync()``."""

    READY = "READY"
    OFFLINE = "OFFLINE"
    REAUTH_NEEDED = "REAUTH_NEEDED"


class StagingService:
    """Central sync gate + local I/O for staging entries.

    Parameters are intentionally positional-optional for test convenience.
    At minimum, a crypto and staging_store are required for local I/O.
    A remote transport (and device_id_provider) are required for remote sync.

    Args:
        crypto: Must be ``NoAuthCryptoManager()`` OR a ``CryptoManager`` with
            a valid master key. ``NoAuthCryptoManager`` is used when the user
            hasn't authenticated yet (commands that only need local reads).
        staging_store: Implements ``read(skip_verify=True)`` for per-entry
            skip_verify (``NoAuthCryptoManager`` can't verify seals).
        identity_secret: For Device ID derivation. Defaults to ``"phpoc"``.
        transport: ``AbstractStagingTransport`` for remote sync. ``None`` to
            disable remote operations entirely.
        device_id_provider: Implements ``get_device_identity(device_secret)``
            to produce a signed DeviceIdentity used as the remote blob header.
        cookie_ttl_minutes: How long a device cookie is valid (default 30).
        data_dir: Local data directory path as string. Used for cookie files.
    """

    AUTH_CACHE_DURATION = 1800  # 30 minutes in seconds
    DEFAULT_COOKIE_TTL = 30  # minutes

    def __init__(
        self,
        crypto: AbstractCryptoManager,
        staging_store: "FileStagingStore",
        identity_secret: Optional[str] = None,
        transport: Optional["AbstractStagingTransport"] = None,
        device_id_provider: Optional[Any] = None,
        cookie_ttl_minutes: int = DEFAULT_COOKIE_TTL,
        data_dir: Optional[str] = None,
    ):
        self._crypto = crypto
        self._local = LocalStagingCache(crypto, staging_store)
        self._merge = MergeEngine()
        self._identity_secret = identity_secret or "phpoc"
        # Wrap transport in RemoteStagingSync for cookie push/pull
        if transport is not None and device_id_provider is not None:
            self._remote = RemoteStagingSync(crypto, transport, device_id_provider)
        else:
            self._remote = None
        self._device_id_provider = device_id_provider
        self._last_push_at = 0
        self._last_auth_time = 0.0  # Updated on first successful check

        # Resolve data_dir to a Path
        if data_dir:
            self._data_dir = Path(data_dir)
        else:
            import platformdirs
            self._data_dir = Path(platformdirs.user_data_dir("phpoc", ensure_exists=True))

        self._cookie_ttl_minutes = cookie_ttl_minutes

    # ------------------------------------------------------------------
    # Local staging CRUD (no remote calls)
    # ------------------------------------------------------------------

    def _get_device_id(self) -> Optional[str]:
        """Resolve the local device UUID, if a valid crypto session exists."""
        if self._device_id_provider is None:
            return None
        mk = getattr(self._crypto, "master_key", None)
        if not isinstance(mk, bytes) or len(mk) != 32:
            return None
        try:
            identity = self._device_id_provider.get_device_identity(mk)
            return identity.device_id
        except Exception:
            return None

    def capture(self, title, epoch_ms, is_active=True, tags=None, comment=None):
        """Add a new staging entry locally. No remote sync.

        Attaches the local device UUID (encrypted) to every entry so
        each entry carries provenance information about which device
        created it.
        """
        device_uuid = self._get_device_id()
        self._local.append(title, epoch_ms, is_active=is_active, tags=tags or [], comment=comment, device_uuid=device_uuid)

    def end(self, title, end_epoch, comment=None):
        """End an active task. Local-only write."""
        entries = self._local.read_entries()
        found_index = None
        for i, entry in enumerate(entries):
            if entry["title"] == title and entry.get("is_active"):
                found_index = i
                break

        if found_index is None:
            raise ValueError(f"No active task found for: {title}")

        # Auto-unpause if currently paused
        if entries[found_index].get("is_paused"):
            self._local.close_pause(found_index, end_epoch)

        end_device_uuid = self._get_device_id()
        self._local.update(found_index, {
            "end_epoch": end_epoch,
            "is_active": False,
            "end_device_uuid": end_device_uuid or "",
        })

        # Recompute duration
        raw = self._local._store.read_entries()
        data = raw[found_index]["data"]
        pauses_enc = data.get("pauses_enc", self._local._encrypt_field(json.dumps([])))
        pauses = json.loads(self._local._from_plain(pauses_enc) or "[]")
        duration = self._local._compute_duration(
            entries[found_index]["start_epoch"], end_epoch, pauses
        )
        self._local.update(found_index, {"duration": duration})

        if comment is not None:
            self._local.update(found_index, {"comment": comment})

    def end_at(
        self,
        title: str,
        end_epoch: int,
        comment: Optional[str] = None,
    ):
        """End an active task at a specific past timestamp.

        Same as ``end()`` but explicitly for past timestamps.
        Computes correct duration from start to end_epoch.

        Raises:
            ValueError: If no active task found with that title.
        """
        return self.end(title, end_epoch, comment)

    def pause(self, title, pause_epoch):
        """Pause an active task (mark is_paused). Local-only."""
        entries = self._local.read_entries()
        found_index = None
        for i, entry in enumerate(entries):
            if entry["title"] == title and entry.get("is_active"):
                found_index = i
                break

        if found_index is None:
            raise ValueError(f"No active task found for: {title}")

        self._local.open_pause(found_index, pause_epoch)

    def unpause(self, title, unpause_epoch):
        """Unpause a paused task (resume). Local-only."""
        entries = self._local.read_entries()
        found_index = None
        for i, entry in enumerate(entries):
            if entry["title"] == title and entry.get("is_active"):
                found_index = i
                break

        if found_index is None:
            raise ValueError(f"No active task found for: {title}")

        self._local.close_pause(found_index, unpause_epoch)

    def modify(
        self,
        entry_index,
        title=None,
        tags: Optional[List[str]] = None,
        comment: Optional[str] = None,
    ):
        """Modify a staged entry's title/tags/comment in-place."""
        override = {}
        if title is not None:
            override["title"] = title
        if tags is not None:
            override["tags"] = tags
        if comment is not None:
            override["comment"] = comment
        self._local.update(entry_index, override)

    def remove(self, entry_index: int):
        """Delete a staged entry."""
        self._local.remove(entry_index)

    def remove_synced(self, indices: List[int]):
        """Remove multiple staged entries by index."""
        for idx in sorted(indices, reverse=True):
            self._local.remove(idx)

    def read_entries(self) -> List[Dict[str, Any]]:
        """Read local staging entries as plain dicts."""
        return self._local.read_entries()

    # ------------------------------------------------------------------
    # Quick-reachability check
    # ------------------------------------------------------------------

    def check_remote_ping(self, timeout_ms: int = 500) -> bool:
        """Quick reachability check. Returns True if remote is responsive."""
        if self._remote is None:
            return False
        try:
            self._remote.pull_cookie()
            return True
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Cookie helpers
    # ------------------------------------------------------------------

    def _is_auth_fresh(self) -> bool:
        """Check whether the current session is authenticated.

        Returns True if:
          - Auth cache is within TTL (_last_auth_time > 0 and fresh), OR
          - A real CryptoManager with valid key is present
            (not NoAuthCryptoManager)
        """
        if time.time() - self._last_auth_time < self.AUTH_CACHE_DURATION:
            return True
        if not isinstance(self._crypto, NoAuthCryptoManager):
            return True
        return False

    def _ensure_cookie(self):
        """Create a device cookie if one does not exist locally.

        Called after a successful slow-path auth + merge so that subsequent
        ``check_and_sync()`` calls hit the fast path (cookie specifier
        comparison without pulling + decrypting the staging blob).

        This is idempotent: if a local cookie already exists, it is
        replaced with a fresh specifier. Failure is non-critical — the
        caller still returns READY.
        """
        if self._remote is None:
            return
        mk = getattr(self._crypto, "master_key", None)
        if not isinstance(mk, bytes) or len(mk) != 32:
            return
        try:
            identity = self._remote._device_id_provider.get_device_identity(mk)
            DeviceCookie.destroy_locally(self._data_dir)
            self._push_cookie(identity.device_id)
        except Exception:
            pass  # Non-critical: cookie creation failure doesn't block READY

    # ------------------------------------------------------------------
    # Freshness optimization
    # ------------------------------------------------------------------

    def _needs_full_pull(self, remote_blob: Dict[str, Any]) -> bool:
        """Decide if the full staging blob needs to be pulled.

        Based on comparing device_id and updated_at with local state.

        Args:
            remote_blob: Decrypted blob from remote.

        Returns:
            True if a full merge is needed, False to skip.
        """
        # Get local device ID
        local_id = None
        try:
            if self._remote is not None:
                identity = self._remote._device_id_provider.get_device_identity(b"")
                local_id = identity.device_id
        except Exception:
            pass

        remote_id = remote_blob.get("device_id", "")
        remote_updated_at = remote_blob.get("updated_at", 0)

        if remote_id != local_id:
            return True  # Different device — must merge

        # Same device: check freshness
        if remote_updated_at > self._last_push_at:
            return True  # Remote is newer — must merge

        return False  # Same device, not newer — skip full pull

    # ------------------------------------------------------------------
    # Sync gate (single point of entry for remote staging sync)
    # ------------------------------------------------------------------

    @trace
    def check_and_sync(
        self, timeout_ms: int = 500
    ) -> SyncCheckResult:
        """Event-driven remote check with Device Cookie as the truth.

        Cookie is the definitive cross-device check:
          1. If no remote configured: returns READY.
          2. Check LOCAL cookie TTL:
             a. No cookie or expired -> proceed to slow path
             b. Cookie valid -> pull REMOTE cookie
                i.  Remote cookie specifier MATCHES local -> READY (same device session)
                ii. No remote cookie or specifier MISMATCH -> proceed to slow path
          3. Slow path: specifier mismatch OR no cookie -> pull blob, then
             check auth. If auth is fresh (within cache or crypto present), merge.
             If auth is stale -> REAUTH_NEEDED.
          4. If remote unreachable: return OFFLINE.

        **A specifier mismatch ALWAYS means a different device wrote.**
        That alone is the auth trigger. The cookie is the truth, not the
        blob's device_id field.
        """
        if self._remote is None:
            return SyncCheckResult.READY

        # ------------------------------------------------------------------
        # FAST PATH: Device Cookie specifier comparison (no decryption needed)
        # ------------------------------------------------------------------
        local_cookie = DeviceCookie.is_valid_locally(
            self._data_dir, self._cookie_ttl_minutes
        )
        if local_cookie is not None:
            try:
                remote_cookie = self._remote.pull_cookie()
            except Exception:
                remote_cookie = None
            if remote_cookie is not None:
                remote_parsed = DeviceCookie.parse_remote(remote_cookie)
                if remote_parsed is not None and DeviceCookie.matches(local_cookie, remote_parsed):
                    # Specifiers match -- same device session, staging is in sync
                    return SyncCheckResult.READY

        # ------------------------------------------------------------------
        # SLOW PATH: Cookie mismatch or no cookie -> pull blob, check auth, merge
        # ------------------------------------------------------------------
        # The cookie specifier mismatch means a different device wrote to remote
        # since our last push. Auth is required to decrypt and merge.

        try:
            remote_blob = self._remote.pull()
        except Exception:
            return SyncCheckResult.OFFLINE

        if remote_blob is None:
            return SyncCheckResult.READY

        # Auth check: specifier mismatch forces auth gate.
        if self._is_auth_fresh():
            self._last_auth_time = time.time()
        else:
            return SyncCheckResult.REAUTH_NEEDED

        # Check freshness: skip full merge if same device and remote not newer
        if not self._needs_full_pull(remote_blob):
            # Still no local cookie — create one so next call hits the fast path
            self._ensure_cookie()
            return SyncCheckResult.READY

        # Merge using the already-fetched blob data
        try:
            if "entries" in remote_blob:
                local_entries = self._local.read_entries()
                remote_dtos = self._raw_to_dtos(remote_blob["entries"])
                merged = self._merge.merge(local_entries, remote_dtos)
                self._local.write_entries(merged)
        except Exception:
            return SyncCheckResult.OFFLINE

        # Cookie created after successful auth + merge — subsequent calls fast-path
        self._ensure_cookie()
        return SyncCheckResult.READY

    # ------------------------------------------------------------------
    # Raw -> DTO conversion
    # ------------------------------------------------------------------

    def _raw_to_dtos(self, raw_entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Pass raw entry dicts through (MergeEngine works with dicts)."""
        return raw_entries

    # ------------------------------------------------------------------
    # Push to remote
    # ------------------------------------------------------------------

    @trace
    def push_to_remote(self, master_key: bytes):
        """Serialize local staging, push via transport, and create device cookie.

        Creates a fresh Device Cookie on local and pushes it to remote first,
        then pushes the staging blob. The cookie allows fast-path identity
        checks on subsequent operations.

        Args:
            master_key: For device identity proof generation.
        """
        if self._remote is None:
            return

        raw = self._local._store.read_entries()
        identity = None
        try:
            if self._remote is not None:
                identity = self._remote._device_id_provider.get_device_identity(master_key)
        except Exception:
            pass

        device_id = identity.device_id if identity else "unknown"

        # Push device cookie FIRST (tiny file, fast), then stage blob.
        DeviceCookie.destroy_locally(self._data_dir)
        self._push_cookie(device_id)

        self._remote.push(raw, device_id, master_key=master_key)
        self._last_push_at = int(time.time() * 1000)

    def _push_cookie(self, device_id: str):
        """Create a fresh device cookie and push it to remote.

        Only write operations that produce new staging data should call this.
        Sync-only operations (ph sync remote_staging) must NOT push the cookie
        — the remote cookie is the authoritative record of which device last
        wrote, and sync commands do not write.

        Args:
            device_id: This device's UUID.
        """
        remote_cookie = DeviceCookie.create(device_id, self._data_dir)
        if remote_cookie is not None:
            cookie_bytes = json.dumps(remote_cookie).encode("utf-8")
            self._remote.push_cookie(cookie_bytes)

    def push_blob_only(self, master_key: bytes):
        """Push only the staging blob to remote, WITHOUT creating/pushing a cookie.

        Used by sync commands (ph sync remote_staging) that should reconcile
        data but not claim ownership of the remote cookie. The remote cookie
        is only updated by real write operations.

        Args:
            master_key: For device identity proof generation.
        """
        if self._remote is None:
            return

        raw = self._local._store.read_entries()
        identity = None
        try:
            if self._remote is not None:
                identity = self._remote._device_id_provider.get_device_identity(master_key)
        except Exception:
            pass

        device_id = identity.device_id if identity else "unknown"
        self._remote.push(raw, device_id, master_key=master_key)
        self._last_push_at = int(time.time() * 1000)

    def is_remote_available(self) -> bool:
        """Check if remote transport is configured and reachable."""
        if self._remote is None:
            return False
        return self._remote.check_remote_available()

    def close(self):
        """Release resources. (No-op in current implementation.)"""
        pass
