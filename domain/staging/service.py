"""StagingService — public API for all staging operations.

StagingService is the facade that higher layers (SyncOrchestrator, CLI, views)
use for all staging CRUD operations. It delegates to LocalStagingCache (local)
and RemoteStagingSync (remote), and uses MergeEngine for reconciliations.

Key invariants:
  - No caller ever sees the ``plain:`` prefix
  - Every CRUD method returns decrypted DTOs
  - ``check_and_sync()`` is called implicitly on every command
    (orchestrated by the caller — this class provides the method)
"""

import json
import time
import threading
from typing import Optional, List, Dict, Any

from security.crypto import AbstractCryptoManager
from storage.staging_store import AbstractStagingStore
from domain.staging.local_cache import LocalStagingCache
from domain.staging.merge_engine import MergeEngine
from domain.staging.remote_sync import RemoteStagingSync, SyncCheckResult
from security.device_identity import AbstractDeviceIdentityProvider
from cli.trace import trace


class StagingService:
    """Public API for all staging operations.

    Attributes:
        _local: LocalStagingCache instance.
        _remote: Optional RemoteStagingSync instance.
        _merge: MergeEngine instance.
    """

    AUTH_CACHE_DURATION = 1800  # 30 minutes in seconds

    def __init__(
        self,
        crypto: AbstractCryptoManager,
        staging_store: AbstractStagingStore,
        transport=None,
        device_id_provider: Optional[AbstractDeviceIdentityProvider] = None,
    ):
        self._crypto = crypto
        self._local = LocalStagingCache(crypto, staging_store)
        self._merge = MergeEngine()
        self._remote: Optional[RemoteStagingSync] = None
        self._last_auth_time: float = 0.0
        self._last_push_at: int = 0  # ms timestamp of last successful push

        if transport is not None and device_id_provider is not None:
            self._remote = RemoteStagingSync(crypto, transport, device_id_provider)

    # ------------------------------------------------------------------
    # Entry CRUD
    # ------------------------------------------------------------------

    @trace
    def capture(
        self,
        title: str,
        start_epoch: int,
        *,
        stop_epoch: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
        is_active: bool = False,
        tags: Optional[List[str]] = None,
        comment: Optional[str] = None,
        media: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """Add entry to local staging.

        Automatically calls check_and_sync() before the local operation.

        Returns entry hash prefix (10 characters).

        Raises:
            ValueError: If collision detected (same start_epoch).
        """
        self.check_and_sync(timeout_ms=500)
        return self._local.append(
            title,
            start_epoch,
            end_epoch=stop_epoch,
            metadata=metadata,
            is_active=is_active,
            tags=tags,
            comment=comment,
            media=media,
        )

    @trace
    def end(self, title: str, end_epoch: int, comment: Optional[str] = None):
        """End an active task by title.

        Automatically calls check_and_sync() before the local operation.

        Raises:
            ValueError: If no active task found with that title.
        """
        self.check_and_sync(timeout_ms=500)
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

        self._local.update(found_index, {
            "end_epoch": end_epoch,
            "is_active": False,
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
        self.end(title, end_epoch, comment=comment)

    @trace
    def pause(
        self,
        title: str,
        pause_epoch: int,
        comment: Optional[str] = None,
    ):
        """Pause a running task.

        Automatically calls check_and_sync() before the local operation.

        Raises:
            ValueError: If not found, not active, or already paused.
        """
        self.check_and_sync(timeout_ms=500)
        entries = self._local.read_entries()
        found_index = None
        for i, entry in enumerate(entries):
            if entry["title"] == title and entry.get("is_active"):
                found_index = i
                break

        if found_index is None:
            raise ValueError(f"No active task found for: {title}")

        if entries[found_index].get("is_paused"):
            raise ValueError(f"Task '{title}' is already paused.")

        self._local.add_pause(found_index, pause_epoch, comment=comment)

    @trace
    def unpause(
        self,
        title: str,
        unpause_epoch: int,
        comment: Optional[str] = None,
    ):
        """Unpause a paused task.

        Automatically calls check_and_sync() before the local operation.

        Raises:
            ValueError: If not found, not active, or not paused.
        """
        self.check_and_sync(timeout_ms=500)
        entries = self._local.read_entries()
        found_index = None
        for i, entry in enumerate(entries):
            if entry["title"] == title and entry.get("is_active"):
                found_index = i
                break

        if found_index is None:
            raise ValueError(f"No active task found for: {title}")

        if not entries[found_index].get("is_paused"):
            raise ValueError(f"Task '{title}' is not paused.")

        self._local.close_pause(found_index, unpause_epoch, comment=comment)

    def modify(
        self,
        entry_index: int,
        *,
        end_epoch: Optional[int] = None,
        pauses: Optional[List[Dict[str, Any]]] = None,
    ):
        """Modify a completed entry's end time and/or pauses.

        Automatically calls check_and_sync() before the local operation.

        Args:
            entry_index: Index in the staging array.
            end_epoch: New end epoch ms, or None to keep current.
            pauses: New pauses list, or None to keep current.

        Raises:
            ValueError: If entry not found, out of range, or still active.
        """
        self.check_and_sync(timeout_ms=500)
        entries = self._local.read_entries()

        if entry_index < 0 or entry_index >= len(entries):
            raise ValueError(f"No staged entry at index {entry_index}.")

        entry = entries[entry_index]
        if entry.get("is_active"):
            raise ValueError(
                f"Cannot modify active task '{entry['title']}'. End it first."
            )

        update_fields = {}
        if end_epoch is not None:
            update_fields["end_epoch"] = end_epoch
        if pauses is not None:
            update_fields["pauses"] = pauses

        if update_fields:
            self._local.update(entry_index, update_fields)

        # Recompute duration
        raw = self._local._store.read_entries()
        data = raw[entry_index]["data"]
        pauses_enc = data.get("pauses_enc", self._local._encrypt_field(json.dumps([])))
        resolved_pauses = json.loads(self._local._from_plain(pauses_enc) or "[]")

        resolved_end = end_epoch if end_epoch is not None else entry.get("end_epoch")
        if resolved_end is not None:
            duration = self._local._compute_duration(
                entry["start_epoch"], resolved_end, resolved_pauses
            )
            self._local.update(entry_index, {"duration": duration})

    def remove(self, entry_index: int):
        """Remove a staged entry by index.

        Automatically calls check_and_sync() before the local operation.

        Raises:
            ValueError: If entry_index is out of range.
        """
        self.check_and_sync(timeout_ms=500)
        try:
            self._local.delete(entry_index)
        except IndexError as e:
            raise ValueError(str(e))

    # ------------------------------------------------------------------
    # Queries (returns decrypted DTOs, no plain: prefix)
    # ------------------------------------------------------------------

    def get_entries(self) -> List[Dict[str, Any]]:
        """All staged entries with decrypted fields (DTOs)."""
        return self._local.read_entries()

    def get_completed(self) -> List[Dict[str, Any]]:
        """Only completed entries (non-active, non-paused)."""
        entries = self._local.read_entries()
        return [
            e for e in entries
            if not e.get("is_active", False) and not e.get("is_paused", False)
        ]

    def get_active(self) -> List[Dict[str, Any]]:
        """Only active (running) entries."""
        entries = self._local.read_entries()
        return [e for e in entries if e.get("is_active", False)]

    def get_pending_sync(self) -> List[Dict[str, Any]]:
        """Entries ready to sync (completed, not synced).

        Returns completed entries that are candidates for sync.
        (The actual "already synced" set is managed by the SyncOrchestrator.)
        """
        return self.get_completed()

    def remove_synced(self, indices: List[int]):
        """Remove entries that were successfully synced.

        Active and paused entries are preserved.

        Args:
            indices: Staging-level indices of synced entries to remove.
        """
        all_entries = self._local.read_entries()
        # Find the actual staging indices for synced entries
        # (entry_index in DTOs may differ from raw staging indices after removals)
        self._local.remove_multiple(indices)

    # ------------------------------------------------------------------
    # Remote entry conversion
    # ------------------------------------------------------------------

    def _raw_to_dtos(self, raw_entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert raw entries (from remote blob) to DTOs for merge compatibility.

        Remote blob entries have format: {hash, data (with encrypted fields),
        start_epoch}. DTOs have: {title, start_epoch, end_epoch, ...}.
        This method does the conversion by writing raw entries into a temp
        staging store and reading them back through LocalStagingCache.

        Args:
            raw_entries: List of raw staging entries.

        Returns:
            List of decrypted DTOs.
        """
        if not raw_entries:
            return []

        # Use an in-memory store that conforms to AbstractStagingStore
        class _ConversionStore:
            def __init__(self):
                self._data = []
            def read_entries(self): return list(self._data)
            def write_entries(self, entries): self._data[:] = list(entries)
            def append_entry(self, entry): self._data.append(entry)
            def remove_entries(self, indices):
                for i in sorted(indices, reverse=True):
                    if 0 <= i < len(self._data):
                        self._data.pop(i)
            def update_entry(self, index, fields):
                if 0 <= index < len(self._data):
                    self._data[index].update(fields)

        temp_store = _ConversionStore()
        temp_store.write_entries(raw_entries)
        temp_cache = LocalStagingCache(self._crypto, temp_store)
        return temp_cache.read_entries()

    # ------------------------------------------------------------------
    # Remote Sync
    # ------------------------------------------------------------------

    @trace
    def _needs_full_pull(self, remote_blob: Optional[Dict[str, Any]]) -> bool:
        """Determine whether a full pull+merge is needed based on freshness.

        Returns True if the remote blob has entries that are newer than
        our last successful push, or if the device IDs differ.
        """
        if remote_blob is None:
            return False  # No remote blob — nothing to merge

        # Always pull if remote has a different device_id (new data from another device)
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

    @trace
    def check_and_sync(
        self, timeout_ms: int = 500
    ) -> SyncCheckResult:
        """Event-driven remote check. Called before every staging operation.

        Single-pull flow (optimized):
          1. If no remote configured: returns READY.
          2. Pull remote blob ONCE (with timeout).
          3. Check device match + freshness:
             a. Different device + auth expired → REAUTH_NEEDED
             b. Different device + auth fresh → pull+merge
             c. Same device, remote not newer → skip pull (assume synced)
             d. Same device, remote newer → pull+merge
          4. If remote unreachable: return OFFLINE.

        Auth cache: after successful device check, caches the auth for
        30 minutes (AUTH_CACHE_DURATION).

        Returns:
            SyncCheckResult.READY, OFFLINE, or REAUTH_NEEDED.
        """
        if self._remote is None:
            return SyncCheckResult.READY

        # Pull the remote blob ONCE for both device check and data
        try:
            remote_blob = self._remote.pull()
        except Exception:
            return SyncCheckResult.OFFLINE

        if remote_blob is None:
            # No remote blob yet — nothing to merge, proceed locally
            return SyncCheckResult.READY

        # Check device match
        remote_device_id = remote_blob.get("device_id", "")
        local_id = None
        try:
            identity = self._remote._device_id_provider.get_device_identity(b"")
            local_id = identity.device_id
        except Exception:
            pass

        device_match = (remote_device_id == local_id)

        if not device_match:
            # Device mismatch — check auth cache
            if time.time() - self._last_auth_time < self.AUTH_CACHE_DURATION:
                # Auth cache still valid — proceed with merge
                pass
            else:
                # Auth expired — need re-auth
                return SyncCheckResult.REAUTH_NEEDED

        # Update auth timestamp on successful device check
        self._last_auth_time = time.time()

        # Check freshness: skip full merge if same device and remote not newer
        if not self._needs_full_pull(remote_blob):
            return SyncCheckResult.READY

        # Pull+merge using the already-fetched blob data
        try:
            if "entries" in remote_blob:
                local_entries = self._local.read_entries()

                # Convert remote raw entries to DTOs before merging.
                remote_dtos = self._raw_to_dtos(remote_blob["entries"])

                merged = self._merge.merge(local_entries, remote_dtos)
                # Rebuild raw from merged DTOs
                self._local.write_entries(merged)
        except Exception:
            return SyncCheckResult.OFFLINE

        return SyncCheckResult.READY

    @trace
    def push_to_remote(self, master_key: bytes):
        """Serialize local staging, push via transport.

        Args:
            master_key: For device identity proof generation.
        """
        if self._remote is None:
            return

        raw = self._local._store.read_entries()
        # Get device identity for the blob header
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
