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

import hashlib
import json
import time
import logging
from pathlib import Path
from typing import Optional, Dict, Any, List

from cli.trace import trace
from domain.cookie.device_cookie import DeviceCookie, META_FILE
from domain.staging.local_cache import LocalStagingCache
from domain.staging.merge_engine import MergeEngine
from domain.staging.remote_sync import RemoteStagingSync, BLOB_KEY_MISMATCH
from security.crypto import (
    AbstractCryptoManager,
    NoAuthCryptoManager,
    build_field_token_map,
    STAGING_ENCRYPTABLE_FIELDS,
)

logger = logging.getLogger(__name__)


def _decode_field_names(data: dict, crypto=None) -> dict:
    """Decode encrypted field-name tokens back to standard _enc keys.

    When crypto has a master key, builds a reverse token map and
    translates HMAC tokens to standard field names. Legacy _enc
    keys pass through as-is.

    Delegates token-map building to security.crypto.build_field_token_map()
    so the HMAC computation logic is defined in one place.

    Args:
        data: Raw entry data dict (may have token keys or _enc keys).
        crypto: Optional CryptoManager with master_key for deriving
                the field key.

    Returns:
        Dict with standard field names (startTime_enc, endTime_enc, etc.).
    """
    if not data:
        return {}

    # If any key ends with _enc, it's legacy format — pass through
    if any(k.endswith("_enc") for k in data):
        return dict(data)

    # No master key → can't decode tokens
    mk = getattr(crypto, "master_key", None) if crypto is not None else None
    if not isinstance(mk, bytes) or len(mk) != 32:
        return dict(data)

    try:
        token_map = build_field_token_map(mk, STAGING_ENCRYPTABLE_FIELDS)
        decoded = {}
        for key, value in data.items():
            if key in token_map:
                decoded[token_map[key]] = value
            else:
                decoded[key] = value
        return decoded
    except Exception:
        return dict(data)


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
        self._touch_local_cookie()

    def _find_active_entry(self, title: str) -> Dict[str, Any]:
        """Find an active entry by title and return its metadata.

        Returns a dict with keys: ``entry_id``, ``index``, ``start_epoch``,
        ``is_paused``. Raises ValueError if no active entry matches.
        """
        entries = self._local.read_entries()
        for i, entry in enumerate(entries):
            if entry["title"] == title and entry.get("is_active"):
                return {
                    "entry_id": entry.get("entry_id", "") or None,
                    "index": i,
                    "start_epoch": entry.get("start_epoch"),
                    "is_paused": entry.get("is_paused", False),
                }
        raise ValueError(f"No active task found for: {title}")

    def end(self, title, end_epoch, comment=None):
        """End an active task. Local-only write."""
        found = self._find_active_entry(title)
        found_entry_id = found["entry_id"]
        found_index = found["index"]
        found_start_epoch = found["start_epoch"]
        found_is_paused = found["is_paused"]

        # Choose stable entry_id path or legacy index path
        if found_entry_id:
            # Auto-unpause if currently paused (by stable entry_id)
            if found_is_paused:
                self._local.close_pause_by_entry_id(found_entry_id, end_epoch)
            end_device_uuid = self._get_device_id()
            self._local.update_by_entry_id(found_entry_id, {
                "end_epoch": end_epoch,
                "is_active": False,
                "end_device_uuid": end_device_uuid or "",
            })
            # Recompute duration: re-read to get updated pauses after close_pause
            updated_entries = self._local.read_entries()
            pauses = []
            for e in updated_entries:
                if e.get("entry_id") == found_entry_id:
                    pauses = e.get("pauses", [])
                    break
            duration = self._local._compute_duration(
                found_start_epoch, end_epoch, pauses
            )
            self._local.update_by_entry_id(found_entry_id, {"duration": duration})
            if comment is not None:
                self._local.update_by_entry_id(found_entry_id, {"comment": comment})
        else:
            # Legacy path: entries without entry_id (created by compat/v0_3_0)
            if found_is_paused:
                self._local.close_pause(found_index, end_epoch)
            end_device_uuid = self._get_device_id()
            self._local.update(found_index, {
                "end_epoch": end_epoch,
                "is_active": False,
                "end_device_uuid": end_device_uuid or "",
            })
            raw = self._local._store.read_entries()
            data = raw[found_index]["data"]
            pauses_enc = data.get("pauses_enc", self._local._encrypt_field(json.dumps([])))
            pauses = json.loads(self._local._from_plain(pauses_enc) or "[]")
            duration = self._local._compute_duration(
                found_start_epoch, end_epoch, pauses
            )
            self._local.update(found_index, {"duration": duration})
            if comment is not None:
                self._local.update(found_index, {"comment": comment})

        self._touch_local_cookie()

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
        found = self._find_active_entry(title)
        found_entry_id = found["entry_id"]
        found_index = found["index"]

        if found_entry_id:
            self._local.add_pause_by_entry_id(found_entry_id, pause_epoch)
        else:
            self._local.add_pause(found_index, pause_epoch)
        self._touch_local_cookie()

    def unpause(self, title, unpause_epoch):
        """Unpause a paused task (resume). Local-only."""
        found = self._find_active_entry(title)
        found_entry_id = found["entry_id"]
        found_index = found["index"]

        if found_entry_id:
            self._local.close_pause_by_entry_id(found_entry_id, unpause_epoch)
        else:
            self._local.close_pause(found_index, unpause_epoch)
        self._touch_local_cookie()

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
        self._touch_local_cookie()

    def remove(self, entry_index: int):
        """Delete a staged entry."""
        self._local.delete(entry_index)
        self._touch_local_cookie()

    def remove_synced(self, indices: List[int]):
        """Remove multiple staged entries by index."""
        if indices:
            self._local.remove_multiple(indices)
            self._touch_local_cookie()

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
        """Quick reachability check. Returns True if remote is responsive.

        Args:
            timeout_ms: Max time to wait in ms. Propagated to the transport.
        """
        if self._remote is None:
            return False
        try:
            self._remote.pull_cookie(timeout_ms=timeout_ms)
            return True
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Push hash helpers (F3: skip blob push when staging unchanged)
    # ------------------------------------------------------------------

    @property
    def _push_hash_path(self) -> Path:
        """Path to the last-push hash file."""
        return self._data_dir / ".last_push_hash"

    def _compute_staging_hash(self) -> Optional[str]:
        """Compute SHA-256 over canonical JSON of all raw staging entries.

        Returns the hex digest, or None if computing the hash fails
        (fail-open — the caller treats None as "hash unknown, push").

        Entries are sorted by ``start_epoch`` before hashing so that
        reordering by the merge engine does not produce spurious changes.
        """
        try:
            raw = self._local._store.read_entries()
            sorted_raw = sorted(raw, key=lambda e: e.get("start_epoch", 0))
            return hashlib.sha256(
                json.dumps(sorted_raw, sort_keys=True).encode()
            ).hexdigest()
        except Exception:
            return None

    def _get_last_push_hash(self) -> Optional[str]:
        """Read the last-pushed hash. Returns None if missing/corrupt."""
        if not self._push_hash_path.exists():
            return None
        try:
            return json.loads(self._push_hash_path.read_text())
        except (json.JSONDecodeError, Exception):
            return None

    def _save_last_push_hash(self, hash_hex: str):
        """Persist the last-pushed hash. Failures logged, never raised."""
        try:
            self._push_hash_path.write_text(json.dumps(hash_hex))
        except Exception:
            logger.debug("Could not write .last_push_hash", exc_info=True)

    def _update_push_hash(self):
        """Compute current staging hash and persist it.

        No-op if hash computation fails (fail-open — the caller already
        pushed; a missing hash just means the next call will push again).
        """
        current_hash = self._compute_staging_hash()
        if current_hash is not None:
            self._save_last_push_hash(current_hash)

    # ------------------------------------------------------------------
    # Cookie helpers
    # ------------------------------------------------------------------

    def _touch_local_cookie(self):
        """Update the local cookie's creation_time to now, if it exists.

        Extends the session TTL by resetting the creation clock.
        No remote cookie is pushed. Safe to call on every command —
        negligible cost (~1ms local file write).
        """
        meta_path = self._data_dir / META_FILE
        if not meta_path.exists():
            return
        try:
            local_cookie = json.loads(meta_path.read_text())
            specifier = local_cookie.get("device_specifier")
            if not specifier:
                return
            now_ms = int(time.time() * 1000)
            old_ms = local_cookie.get("creation_time", 0)
            # Ensure strictly-increasing creation_time even when two
            # touches happen within the same system-clock millisecond.
            if now_ms <= old_ms:
                now_ms = old_ms + 1
            meta_path.write_text(json.dumps({
                "device_specifier": specifier,
                "creation_time": now_ms,
            }))
        except Exception:
            pass  # Non-critical

    def _push_on_fast_path(self, local_cookie: dict):
        """Pull remote blob, merge, push back, and touch cookie.

        Called when local and remote cookie specifiers match (same device
        session). Even when specifiers match, another client (e.g. web)
        may have updated staging while this CLI was idle — so we always
        pull the remote blob, merge, and push the reconciled result.

        The device_specifier is never regenerated — same device, same
        specifier. The remote cookie is never pushed (it already has the
        matching specifier).

        Args:
            local_cookie: The local cookie dict (device_specifier, creation_time).
        """
        # Pull remote blob, merge with local, then push reconciled result
        mk = getattr(self._crypto, "master_key", None)
        if not (isinstance(mk, bytes) and len(mk) == 32):
            self._touch_local_cookie()
            return

        # F3: Snapshot local hash BEFORE merge so local modifications
        # (e.g. via modify()) are detected even if the remote-wins
        # merge would revert them.
        pre_merge_hash = self._compute_staging_hash()
        last_hash = self._get_last_push_hash()
        # Push if hashes are missing or differ (fail-open: None → push)
        local_changed = (
            pre_merge_hash is None
            or last_hash is None
            or pre_merge_hash != last_hash
        )

        try:
            remote_blob = self._remote.pull(master_key=mk)
        except Exception:
            remote_blob = None

        if remote_blob is not None and remote_blob is not BLOB_KEY_MISMATCH and "entries" in remote_blob:
            try:
                local_entries = self._local.read_entries()
                remote_dtos = []
                for raw_entry in remote_blob.get("entries", []):
                    dto = self._raw_entry_to_dto(raw_entry, crypto=self._crypto)
                    if dto is not None:
                        remote_dtos.append(dto)
                merged = self._merge.merge(
                    local_entries, remote_dtos
                )
                # Filter out entries already committed by another client
                # (e.g. web committed + pushed, CLI hasn't synced yet)
                merged = [e for e in merged if not e.get("committed")]
                self._local.write_entries(merged)
            except Exception:
                pass  # Merge failure — push local as-is

        # F3: Decide whether to push
        should_push = local_changed
        if not should_push:
            # Local unchanged before merge. Check if merge introduced changes.
            post_merge_hash = self._compute_staging_hash()
            should_push = (
                post_merge_hash is None  # fail-open
                or last_hash is None
                or post_merge_hash != last_hash
            )

        if should_push:
            try:
                self.push_blob_only(master_key=mk)
            except Exception:
                pass  # Best-effort push — data stays local for retry

        # Touch local cookie to extend session TTL
        self._touch_local_cookie()

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
        self, timeout_ms: Optional[int] = None
    ) -> SyncCheckResult:
        """Event-driven remote check with Device Cookie as the truth.

        Cookie is the definitive cross-device check:

          Fast path:
            1. No remote configured → READY
            2. Local cookie valid → pull remote cookie
               ├─ Match → READY (same device session, push blob + optional touch)
               └─ Mismatch → SPECIFIER_MISMATCH → fall through
                ─  No remote cookie → fall through

          Auth gate:
            ─  Specifier mismatch → REAUTH_NEEDED (unconditional, regardless of crypto)
            ─  No local cookie / TTL expired → REAUTH_NEEDED (unconditional —
               per workflow spec, Step 1 always routes to Step 3 authentication
               when TTL is expired or no cookie exists)
            ─  No remote cookie (local TTL valid):
               3. CryptoManager valid? No → REAUTH_NEEDED
               4. Pull remote cookie → device_uuid (unreachable → OFFLINE)
               5. Same device_uuid → push local blob (authoritative, no pull)
                  Different device_uuid → pull blob → reconcile → push merged
               6. Create new device cookie (local + remote) → READY

        Key invariants:

        - **Specifier mismatch always forces REAUTH_NEEDED**, regardless of
          whether a CryptoManager is cached. The user must explicitly consent
          to cross-device merging.

        - **TTL expired / no local cookie always forces REAUTH_NEEDED**,
          even when a valid crypto key is cached. Per the workflow spec,
          TTL expiry is an unconditional gate to Step 3 (authentication).
          The session cache is insufficient because the cookie is the truth
          for device identity, not the crypto key.

        Args:
            timeout_ms: Max time to wait for remote operations in ms.
                        Propagated to all transport calls.
        """
        if self._remote is None:
            # Local-only: TTL gate via device cookie.
            # After the TTL expires, the user must re-authenticate even
            # for read-only commands (ph list, ph view, ph tags).
            local_cookie = DeviceCookie.is_valid_locally(
                self._data_dir, self._cookie_ttl_minutes
            )
            if local_cookie is not None:
                return SyncCheckResult.READY
            # Cookie missing or expired — require re-authentication
            return SyncCheckResult.REAUTH_NEEDED

        # Capture cookie file existence BEFORE is_valid_locally (which
        # destroys expired cookies). Needed to distinguish "expired" from
        # "never existed" for the auth gate below.
        cookie_file_exists = (self._data_dir / META_FILE).exists()

        # ------------------------------------------------------------------
        # FAST PATH: Local cookie valid → remote cookie match → READY
        # ------------------------------------------------------------------
        local_cookie = DeviceCookie.is_valid_locally(
            self._data_dir, self._cookie_ttl_minutes
        )

        specifier_mismatch = False
        if local_cookie is not None:
            # Read-only fast path: if local cookie is valid and no writes are
            # pending, skip ALL network calls — return READY immediately.
            # This is the key optimization for ph view / ph list / ph tags.
            # Check raw store directly (not read_entries) to avoid decryption
            # overhead — we just need to know if anything needs pushing.
            try:
                raw_entries = self._local._store.read_entries()
                has_pending_writes = len(raw_entries) > 0
            except Exception:
                has_pending_writes = False

            if not has_pending_writes:
                # No pending writes — read-only command, skip network
                return SyncCheckResult.READY

            try:
                remote_cookie_raw = self._remote.pull_cookie(timeout_ms=timeout_ms)
            except Exception as e:
                if "Timeout" in str(e):
                    raise
                return SyncCheckResult.OFFLINE

            if remote_cookie_raw is not None:
                remote_cookie = DeviceCookie.parse_remote(remote_cookie_raw)
                if remote_cookie and DeviceCookie.matches(local_cookie, remote_cookie):
                    # Same device session — fast path
                    # Push local staging blob to remote (full replace), then
                    # optionally touch the local cookie (10% window check)
                    self._push_on_fast_path(local_cookie)
                    return SyncCheckResult.READY
                if remote_cookie is not None:
                    # Remote cookie parsed successfully but specifiers differ
                    # — different device wrote, must force auth
                    specifier_mismatch = True
                # else: remote_cookie is None — can't parse, treat as no remote cookie.
                # This happens when the transport returns a non-cookie blob
                # (e.g. obfuscated staging data). Fall through to auth gate.

        # ------------------------------------------------------------------
        # AUTH GATE: No valid cookie pair, or specifier mismatch
        # ------------------------------------------------------------------

        # Specifier mismatch ALWAYS forces auth, regardless of cached CryptoManager.
        # The user must explicitly consent to merging across devices.
        if specifier_mismatch:
            return SyncCheckResult.REAUTH_NEEDED

        # 3. TTL expired or no local cookie — always force auth.
        #    Per the workflow (ph-view-workflow-updated.md), Step 1 TTL check
        #    routes directly to Step 3 (authentication) when TTL is expired
        #    or no local cookie exists. There is no crypto bypass here — the
        #    user must explicitly enter their passphrase to re-establish the
        #    device session, even if a valid crypto key is cached.
        #    After auth completes, the caller invokes _reconcile_and_claim().
        #
        #    Exception: when no cookie file exists at all (first-time setup),
        #    and a valid crypto key is cached, proceed to the auth gate to
        #    attempt reconciliation without forcing REAUTH_NEEDED. This allows
        #    the timeout to propagate through the auth gate path.
        if local_cookie is None:
            if cookie_file_exists:
                # Cookie file exists but is expired — force re-auth
                return SyncCheckResult.REAUTH_NEEDED
            # No cookie file at all — fall through to check crypto

        # 4. No remote cookie — force auth so a fresh cookie can be created.
        mk = getattr(self._crypto, "master_key", None)
        if not isinstance(mk, bytes) or len(mk) != 32:
            return SyncCheckResult.REAUTH_NEEDED

        # 5. Reconcile and claim staging ownership
        return self._reconcile_and_claim(mk, timeout_ms=timeout_ms)

    # ------------------------------------------------------------------
    # Reconcile and claim (shared by check_and_sync auth gate + ph login)
    # ------------------------------------------------------------------

    @staticmethod
    def _raw_entry_to_dto(raw_entry: dict, crypto=None) -> Optional[dict]:
        """Convert a single raw staging entry (from blob) to a decrypted DTO.

        Remote blob entries are stored in raw format with encrypted fields
        (``startTime_enc``, ``endTime_enc``, etc.) and a ``data`` wrapper.
        This converts them to the DTO format expected by the MergeEngine.

        Handles both legacy ``plain:`` prefixed entries (backward compat)
        and AES-CTR hex ciphertext entries (post I-03).

        Also handles encrypted field names (HMAC tokens, post I-02).

        Args:
            raw_entry: A raw entry dict with ``data``, ``hash``, ``start_epoch``.
            crypto: Optional CryptoManager for decrypting hex ciphertext fields
                    and reversing field-name tokens. If None, only ``plain:``
                    entries are decoded.

        Returns:
            Decrypted DTO dict, or None if the entry is corrupt.
        """
        try:
            data = raw_entry.get("data", {})

            # Helper: decrypt a field, falling back from hex → plain: → raw
            def _decrypt(value, crypto):
                if value is None:
                    return None
                if not isinstance(value, str):
                    return str(value)
                if value.startswith("plain:"):
                    return value[6:]
                if crypto is not None:
                    try:
                        return crypto.decrypt(value)
                    except Exception:
                        return None
                return None

            def _decrypt_int(value, crypto):
                decrypted = _decrypt(value, crypto)
                if decrypted is None:
                    return None
                try:
                    return int(decrypted)
                except (ValueError, TypeError):
                    return None

            def _decrypt_json(value, crypto, default):
                decrypted = _decrypt(value, crypto)
                if decrypted is None:
                    return default
                try:
                    return json.loads(decrypted)
                except (json.JSONDecodeError, TypeError):
                    return default

            # Decode encrypted field names (HMAC tokens → _enc keys)
            decoded = _decode_field_names(data, crypto)

            # Decrypt start_epoch (required)
            start_epoch = _decrypt_int(decoded.get("startTime_enc", ""), crypto)
            if start_epoch is None:
                return None

            end_epoch = _decrypt_int(decoded.get("endTime_enc"), crypto)
            pauses = _decrypt_json(decoded.get("pauses_enc"), crypto, [])
            metadata = _decrypt_json(decoded.get("metadata_enc"), crypto, {})
            device_uuid = _decrypt(decoded.get("device_uuid_enc", ""), crypto) or ""
            end_device_uuid = _decrypt(decoded.get("end_device_uuid_enc"), crypto) or ""

            date_str = time.strftime(
                "%Y-%m-%d", time.gmtime(start_epoch // 1000)
            )

            return {
                "entry_id": decoded.get("entry_id", ""),
                "title": decoded.get("title", ""),
                "start_epoch": start_epoch,
                "end_epoch": end_epoch,
                "duration": decoded.get("duration", 0),
                "is_active": decoded.get("is_active", False),
                "is_paused": decoded.get("is_paused", False),
                "pauses": pauses,
                "tags": decoded.get("tags", []),
                "comment": decoded.get("comment"),
                "media": decoded.get("media", []),
                "metadata": metadata,
                "date": date_str,
                "source": "remote",
                "committed": raw_entry.get("committed", False),
                "hash": raw_entry.get("hash", ""),
                "device_uuid": device_uuid,
                "end_device_uuid": end_device_uuid,
                "block_index": raw_entry.get("block_index"),
            }
        except Exception:
            return None

    def _reconcile_and_claim(self, master_key: bytes, timeout_ms: Optional[int] = None) -> SyncCheckResult:
        """After successful auth: claim staging ownership for this device.

        Called from ``check_and_sync()``'s auth gate and from ``ph login``.

        For local-only (no remote transport), creates a device cookie for
        TTL tracking and returns READY.

        For remote-enabled:
          * Same device that last wrote -> push local blob (authoritative)
            and touch the local cookie (update creation_time, keep specifier,
            no remote cookie push) — Case A.

          * Different device / first time  -> pull remote blob, reconcile
            (merge remote entries into local), push merged blob, then create
            a fresh device cookie (new specifier, local + remote) — Case B.

        Args:
            master_key: 32-byte master key for blob ops and identity.
            timeout_ms: Optional timeout in milliseconds forwarded to
                        transport calls.

        Returns:
            READY on success, OFFLINE if remote is unreachable.
        """
        if self._remote is None:
            # Local-only: create/refresh the device cookie for TTL tracking
            DeviceCookie.create_local(self._data_dir)
            return SyncCheckResult.READY

        # Pull remote cookie to discover which device last wrote
        try:
            remote_cookie_raw = self._remote.pull_cookie(timeout_ms=timeout_ms)
        except Exception as e:
            if "Timeout" in str(e):
                raise
            return SyncCheckResult.OFFLINE

        remote_device_uuid = ""
        remote_cookie_specifier = ""
        if remote_cookie_raw is not None:
            remote_cookie = DeviceCookie.parse_remote(remote_cookie_raw)
            if remote_cookie:
                remote_device_uuid = remote_cookie.get("device_uuid", "")
                remote_cookie_specifier = remote_cookie.get("device_specifier", "")

        local_device_uuid = self._get_device_id() or ""

        # Bug 3a fix: Always pull + merge, even for same device UUID.
        # Same-device doesn't mean local-is-authoritative — the remote
        # may have entries from a different client. Client-type suffix
        # ({uuid}-cli vs {uuid}-web) guarantees distinct identities.
        try:
            remote_blob = self._remote.pull(master_key=master_key, timeout_ms=timeout_ms)
        except Exception:
            return SyncCheckResult.OFFLINE

        # If remote blob exists but can't be decrypted (wrong master key),
        # DON'T overwrite it — abort and signal OFFLINE.
        if remote_blob is BLOB_KEY_MISMATCH:
            logger.warning(
                "Remote staging blob exists but cannot be decrypted "
                "(wrong master key). Aborting to avoid data loss."
            )
            return SyncCheckResult.OFFLINE

        if remote_blob is not None and "entries" in remote_blob:
            try:
                local_entries = self._local.read_entries()
                # Convert remote raw entries to DTOs before merge
                remote_dtos = []
                for raw_entry in remote_blob.get("entries", []):
                    dto = self._raw_entry_to_dto(raw_entry, crypto=self._crypto)
                    if dto is not None:
                        remote_dtos.append(dto)
                merged = self._merge.merge(
                    local_entries, remote_dtos
                )
                # Filter out entries already committed by another client
                merged = [e for e in merged if not e.get("committed")]
                self._local.write_entries(merged)
            except Exception:
                # Merge failure — push local as-is
                pass

        # Push the (merged or local) blob to remote
        self.push_blob_only(master_key=master_key)

        # Create new device cookie (fresh specifier, local + remote)
        try:
            identity = self._remote._device_id_provider.get_device_identity(master_key)
            device_id = identity.device_id
            DeviceCookie.destroy_locally(self._data_dir)
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
    def push_to_remote(self, master_key: bytes, timeout_ms: Optional[int] = None):
        """Serialize local staging, push via transport, and create device cookie.

        Creates a fresh Device Cookie on local and pushes it to remote first,
        then pushes the staging blob. The cookie allows fast-path identity
        checks on subsequent operations.

        Args:
            master_key: For device identity proof generation.
            timeout_ms: Optional timeout in milliseconds forwarded to
                        transport calls.
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

        # Push the staging blob FIRST, then the device cookie.
        # Order matters: if the blob push fails, the cookie is unchanged and
        # the next check_and_sync will find matching cookies and retry the
        # blob push (fast path). If the cookie push fails after the blob
        # succeeds, the cookie mismatch triggers reconcile which pulls the
        # correct (updated) blob — self-healing.
        #
        # The old order (cookie first) caused a bug where a failed cookie push
        # destroyed the local cookie but left the remote blob stale. The next
        # check_and_sync would see a cookie mismatch, trigger _reconcile_and_claim,
        # pull the old remote blob, and restore entries that had already been
        # committed to the ledger — producing ledger duplicates.
        self._remote.push(raw, device_id, master_key=master_key, timeout_ms=timeout_ms)

        # F3: Save last-push hash so future fast-path calls can skip
        self._update_push_hash()

        try:
            DeviceCookie.destroy_locally(self._data_dir)
            self._push_cookie(device_id)
        except Exception as exc:
            # Cookie failure is non-critical. Next check_and_sync will
            # trigger a cookie mismatch → reconcile, which pulls the
            # updated blob and creates a fresh cookie.
            logger.warning("Device cookie push failed: %s", exc)

        self._last_push_at = int(time.time() * 1000)

    def _push_cookie(self, device_id: str):
        """Create a fresh device cookie and push it to remote.

        Only write operations that produce new staging data should call this.
        Sync-only operations (ph sync) must NOT push the cookie
        — the remote cookie is the authoritative record of which device last
        wrote, and sync commands do not write.

        Args:
            device_id: This device's UUID.
        """
        remote_cookie = DeviceCookie.create(device_id, self._data_dir)
        if remote_cookie is not None:
            cookie_bytes = json.dumps(remote_cookie).encode("utf-8")
            self._remote.push_cookie(cookie_bytes)

    def push_blob_only(self, master_key: bytes, timeout_ms: Optional[int] = None):
        """Push only the staging blob to remote, WITHOUT creating/pushing a cookie.

        Used by sync operations that should reconcile
        data but not claim ownership of the remote cookie. The remote cookie
        is only updated by real write operations.

        Args:
            master_key: For device identity proof generation.
            timeout_ms: Optional timeout in milliseconds forwarded to
                        transport calls.
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
        try:
            self._remote.push(raw, device_id, master_key=master_key, timeout_ms=timeout_ms)
        except (TypeError, ValueError):
            # Non-serialisable staging data — push empty blob so the
            # remote does not retain stale data that cannot be reconciled.
            logger.warning(
                "Staging data cannot be serialised; pushing empty blob "
                "to prevent stale remote state."
            )
            self._remote.push([], device_id, master_key=master_key)
        self._last_push_at = int(time.time() * 1000)
        # F3: Save last-push hash so future fast-path calls can skip
        self._update_push_hash()

    def is_remote_available(self) -> bool:
        """Check if remote transport is configured and reachable."""
        if self._remote is None:
            return False
        return self._remote.check_remote_available()

    def close(self):
        """Release resources. (No-op in current implementation.)"""
        pass
