"""StagingService — unified sync gate + local I/O for staging entries.

The StagingService is the central point for all staging operations:

  1. **Local CRUD** — capture/end/pause/unpause/modify/remove entries
     in the local staging store. These are low-latency (no remote calls).

  2. **Sync gate** — ``check_and_sync()`` is the single entry point for
     remote staging sync. Uses device cookie (TTL + specifier) to decide
     fast path vs auth gate. No ``CryptoManager``/``_is_auth_fresh()``
     consulted for auth decisions — the cookie is the truth.

  3. **Push** — ``push_to_remote()`` serialises local entries, obfuscates,
     and pushes to the remote transport. Called from Phase B (WAL) and
     Phase C (daemon).

  4. **Device Cookie** — ``check_and_sync()`` uses a fast-path cookie check
     to avoid pulling the ~64 KB staging blob when the same device session
     was the last writer. The cookie is a tiny JSON blob with a random
     ``device_specifier`` — no decryption needed.

Auth gate flow::

    1. Remote configured? No → READY. Yes → continue.
    2. Local cookie TTL valid? → pull remote cookie
       ├─ Match → READY (fast path, same device session)
       ├─ Mismatch → fall through to auth gate
       └─ No cookie/expired → fall through to auth gate
    3. Auth gate: valid CryptoManager? No → REAUTH_NEEDED
       Pull remote cookie → get device_uuid
       ├─ Same device_uuid → push local blob (no pull)
       └─ Diff device_uuid → pull remote blob → reconcile → push merged
    4. Create new cookie (local + remote) → READY
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

    def capture(self, title, epoch_ms, *, stop_epoch=None, end_epoch=None, is_active=True, tags=None, comment=None, metadata=None, media=None):
        """Add a new staging entry locally. No remote sync.

        Attaches the local device UUID (encrypted) to every entry so
        each entry carries provenance information about which device
        created it.

        Args:
            title: Entry title.
            epoch_ms: Start timestamp in ms.
            stop_epoch: End timestamp in ms (alias for end_epoch, used by tests and CLI).
            end_epoch: End timestamp in ms.
            is_active: Whether the entry is still active (default True).
            tags: Optional list of tags.
            comment: Optional comment.
            metadata: Optional metadata dict.
            media: Optional list of media dicts.
        """
        device_uuid = self._get_device_id()
        resolved_end = stop_epoch if stop_epoch is not None else end_epoch
        self._local.append(title, epoch_ms, end_epoch=resolved_end, is_active=is_active, tags=tags or [], comment=comment, metadata=metadata, media=media, device_uuid=device_uuid)

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

        self._local.add_pause(found_index, pause_epoch)

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
        self._local.delete(entry_index)

    def remove_synced(self, indices: List[int]):
        """Remove multiple staged entries by index."""
        if indices:
            self._local.remove_multiple(indices)

    def read_entries(self) -> List[Dict[str, Any]]:
        """Read local staging entries as plain dicts."""
        return self._local.read_entries()

    def get_entries(self) -> List[Dict[str, Any]]:
        """Return all staging entries as decrypted DTOs.

        Alias for ``read_entries()``. Every entry has ``entry_index``,
        ``title``, ``start_epoch``, ``end_epoch``, ``is_active``, etc.
        No ``plain:`` prefix is leaked.
        """
        return self._local.read_entries()

    def get_active(self) -> List[Dict[str, Any]]:
        """Return only active (not completed) entries."""
        return [e for e in self._local.read_entries() if e.get("is_active")]

    def get_completed(self) -> List[Dict[str, Any]]:
        """Return only completed (ended) entries."""
        return [e for e in self._local.read_entries() if not e.get("is_active")]

    def get_pending_sync(self) -> List[Dict[str, Any]]:
        """Return completed, non-paused entries ready for ledger sync.

        Filters out entries that are still active or paused. Returns
        decrypted DTOs with fields: entry_index, title, start_epoch,
        end_epoch, duration, tags, date, comment, media.
        """
        entries = self._local.read_entries()
        pending = []
        for entry in entries:
            if entry.get("is_active"):
                continue
            if entry.get("is_paused"):
                continue
            pending.append({
                "entry_index": entry["entry_index"],
                "title": entry["title"],
                "start_epoch": entry["start_epoch"],
                "end_epoch": entry.get("end_epoch"),
                "duration": entry.get("duration", 0),
                "tags": entry.get("tags", []),
                "date": entry.get("date", ""),
                "comment": entry.get("comment"),
                "media": entry.get("media", []),
            })
        return pending

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
    # Sync gate (single point of entry for remote staging sync)
    # ------------------------------------------------------------------

    @trace
    def check_and_sync(
        self, timeout_ms: int = 500
    ) -> SyncCheckResult:
        """Event-driven remote check with Device Cookie as the truth.

        Cookie is the definitive cross-device check:

          Fast path:
            1. No remote configured → READY
            2. Local cookie valid → pull remote cookie
               ├─ Match → READY (same device session)
               └─ Mismatch → SPECIFIER_MISMATCH → fall through
                ─  No remote cookie → fall through

          Auth gate:
            ─  Specifier mismatch → REAUTH_NEEDED (unconditional, regardless of crypto)
            ─  No local cookie / TTL expired / no remote cookie:
               3. CryptoManager valid? No → REAUTH_NEEDED
               4. Pull remote cookie → device_uuid (unreachable → OFFLINE)
               5. Same device_uuid → push local blob (authoritative, no pull)
                  Different device_uuid → pull blob → reconcile → push merged
               6. Create new device cookie (local + remote) → READY

        Key invariant: **a specifier mismatch always forces REAUTH_NEEDED**,
        regardless of whether a CryptoManager is cached. The user must
        explicitly consent to cross-device merging. Other auth gate entries
        (no local cookie, expired TTL, no remote cookie) only need a valid
        master key — the session cache is sufficient.
        """
        if self._remote is None:
            return SyncCheckResult.READY

        # ------------------------------------------------------------------
        # FAST PATH: Local cookie valid → remote cookie match → READY
        # ------------------------------------------------------------------
        local_cookie = DeviceCookie.is_valid_locally(
            self._data_dir, self._cookie_ttl_minutes
        )

        specifier_mismatch = False
        if local_cookie is not None:
            try:
                remote_cookie_raw = self._remote.pull_cookie()
            except Exception:
                return SyncCheckResult.OFFLINE

            if remote_cookie_raw is not None:
                remote_cookie = DeviceCookie.parse_remote(remote_cookie_raw)
                if remote_cookie and DeviceCookie.matches(local_cookie, remote_cookie):
                    # Same device session — fast path, no blob pull needed
                    return SyncCheckResult.READY
                # Remote cookie exists but specifiers differ — different device wrote
                specifier_mismatch = True

        # ------------------------------------------------------------------
        # AUTH GATE: No valid cookie pair, or specifier mismatch
        # ------------------------------------------------------------------

        # Specifier mismatch ALWAYS forces auth, regardless of cached CryptoManager.
        # The user must explicitly consent to merging across devices.
        if specifier_mismatch:
            return SyncCheckResult.REAUTH_NEEDED

        # 3. Check if user has authenticated (valid master key).
        #    Only reached for non-mismatch cases: no local cookie, TTL expired,
        #    or no remote cookie. A warm CryptoManager is sufficient here.
        mk = getattr(self._crypto, "master_key", None)
        if not isinstance(mk, bytes) or len(mk) != 32:
            return SyncCheckResult.REAUTH_NEEDED

        # 4. Pull remote cookie to discover which device last wrote
        try:
            remote_cookie_raw = self._remote.pull_cookie()
        except Exception:
            return SyncCheckResult.OFFLINE

        remote_device_uuid = ""
        if remote_cookie_raw is not None:
            remote_cookie = DeviceCookie.parse_remote(remote_cookie_raw)
            if remote_cookie:
                remote_device_uuid = remote_cookie.get("device_uuid", "")

        local_device_uuid = self._get_device_id() or ""

        # 5. Blob operations based on device identity
        if remote_device_uuid and remote_device_uuid == local_device_uuid:
            # Same device that last wrote — local is authoritative, push only
            self.push_blob_only(master_key=mk)
        else:
            # Different device or first-time setup — pull, reconcile, push
            try:
                remote_blob = self._remote.pull(master_key=mk)
            except Exception:
                return SyncCheckResult.OFFLINE

            if remote_blob is not None and "entries" in remote_blob:
                try:
                    local_entries = self._local.read_entries()
                    merged = self._merge.merge(
                        local_entries, remote_blob.get("entries", [])
                    )
                    self._local.write_entries(merged)
                except Exception:
                    # Merge failure — push local as-is
                    pass

            # Push the (merged or local) blob to remote
            self.push_blob_only(master_key=mk)

        # 6. Create new device cookie (local + remote)
        try:
            identity = self._remote._device_id_provider.get_device_identity(mk)
            device_id = identity.device_id
            remote_cookie = DeviceCookie.create(device_id, self._data_dir)
            if remote_cookie is not None:
                cookie_bytes = json.dumps(remote_cookie).encode("utf-8")
                self._remote.push_cookie(cookie_bytes)
        except Exception:
            pass  # Non-critical: cookie creation failure doesn't block READY

        return SyncCheckResult.READY

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
