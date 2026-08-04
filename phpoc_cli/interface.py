import json
import time
import calendar
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any, Set, Tuple
from security.crypto import AbstractCryptoManager, CryptoManager
from domain.staging.service import StagingService
from domain.staging.service import SyncCheckResult
from domain.ledger.engine import LedgerEngine
from phpoc_cli.trace import trace
from phpoc_cli.background import _show_sync_notifications, _spawn_background_sync_check
from phpoc_cli.wal import _write_wal_pending, _spawn_background_push

logger = logging.getLogger(__name__)


class _RemoteLedgerCache:
    """Persistent file-backed cache for remote ledger blocks.

    Caches pulled ledger blocks to ``<data_dir>/remote_ledger_cache.json``
    so that back-to-back CLI invocations (e.g. ``ph view``) skip re-pulling
    blocks that haven't changed.  The cache is a performance optimization —
    all errors are non-fatal and degrade gracefully to a full pull.
    """

    def __init__(self, cache_path):
        self._cache_path = Path(cache_path)
        self.max_block_index: int = -1
        self.last_pull_time: float = 0.0
        self.blocks: Dict[str, Dict[str, Any]] = {}
        self.remote_index: Dict[str, Dict[str, Any]] = {}

    def load(self):
        """Load cache from disk.  Missing or corrupt files → empty defaults."""
        if not self._cache_path.exists():
            return
        try:
            with open(self._cache_path) as f:
                data = json.load(f)
            self.max_block_index = data.get("max_block_index", -1)
            self.last_pull_time = data.get("last_pull_time", 0.0)
            self.blocks = data.get("blocks", {})
            self.remote_index = data.get("remote_index", {})
        except (json.JSONDecodeError, Exception):
            # Corrupt or unreadable — keep defaults, fall through to pull
            pass

    def save(self):
        """Persist cache to disk.  Write errors are caught and logged."""
        try:
            data = {
                "max_block_index": self.max_block_index,
                "last_pull_time": self.last_pull_time,
                "blocks": self.blocks,
                "remote_index": self.remote_index,
            }
            with open(self._cache_path, 'w') as f:
                json.dump(data, f)
        except Exception:
            logger.debug(
                "_RemoteLedgerCache.save: failed to write cache",
                exc_info=True,
            )

    def is_fresh(self, ttl: float = 60) -> bool:
        """Return True when the cache has been pulled within *ttl* seconds.

        Uses exclusive less-than so that boundary values (e.g. 59.9 s
        against a 60 s TTL) are still considered fresh.
        """
        return (
            self.last_pull_time > 0
            and (time.time() - self.last_pull_time) < ttl
        )

    def invalidate(self):
        """Reset cache state and delete the backing file.

        The next ``_sync_remote_ledger_and_dedup`` call will perform a full
        pull as if the cache had never existed.
        """
        self.max_block_index = -1
        self.last_pull_time = 0.0
        self.blocks = {}
        self.remote_index = {}
        try:
            self._cache_path.unlink(missing_ok=True)
        except Exception:
            pass


class CLIInterface:
    def __init__(
        self,
        staging_service: StagingService,
        ledger_engine: LedgerEngine,
        crypto: AbstractCryptoManager,
    ):
        self._staging = staging_service
        self._ledger_engine = ledger_engine
        self._crypto = crypto
        self._reauth_notified = False

    def _sync_before_command(self, require_auth: bool = False) -> bool:
        """Sync staging with remote before executing a command.

        Checks device cookie for fast-path (same device, same session).
        If cookie mismatch or expired, pulls remote blob, merges, and
        if required, prompts for authentication.

        After the staging sync, also pulls remote ledger blocks into the
        local chain so that the local ledger reflects commits made from
        other clients (e.g. phpoc-web). Then cross-references staging
        entries against the ledger and removes any that have already been
        committed — preventing duplicate commits and incorrect "(Staged)"
        display.

        Only one device can access staging at a time. If the remote
        device_specifier doesn't match local, a different device has
        staging. Authentication is required to proceed.

        Args:
            require_auth: If True, REAUTH_NEEDED will signal the caller
                to handle the authentication flow (write commands).

        Returns:
            True if sync was successful or not needed, False if re-auth
            was needed and caller should abort.
        """
        if self._staging._remote is None:
            return True  # No remote configured — nothing to sync

        result = self._staging.check_and_sync(timeout_ms=500)

        if result == SyncCheckResult.READY:
            # After staging sync, also pull remote ledger blocks so the
            # local chain has all entries committed by other clients.
            # Then remove any staging entries already committed.
            self._sync_remote_ledger_and_dedup()
            return True

        if result == SyncCheckResult.OFFLINE:
            # Remote unreachable — continue with local data
            return True

        if result == SyncCheckResult.REAUTH_NEEDED:
            if require_auth:
                # Write commands: signal caller to handle re-auth.
                # Only one device can access staging at a time.
                print("\nRemote staging is held by a different device.")
                print("Please re-authenticate to access remote staging.")
                return False

            # Read commands (require_auth=False): show a non-blocking
            # notification and proceed with local data.  No passphrase
            # prompt — the user sees their cached data instantly.
            if not self._reauth_notified:
                print("\nRemote session expired — showing local data. "
                      "Run 'ph login' to sync.")
                self._reauth_notified = True
            return True

        return True

    def _rebuild_after_reauth(self, mk: bytes):
        """Rebuild crypto, staging, and ledger engine with a fresh master key.

        Called after re-authentication when the crypto context changes.
        Preserves existing store instances — rebuilds only the objects that
        hold crypto references.

        Also invalidates the persistent remote-ledger cache because cached
        blocks may have been encrypted under a different master key.
        """
        fresh_crypto = CryptoManager(mk)
        self._crypto = fresh_crypto

        # Rebuild StagingService with fresh crypto, preserving store + config
        old_staging = self._staging
        staging_store = old_staging._local._store
        transport = getattr(old_staging._remote, '_transport', None)
        device_id_provider = getattr(old_staging, '_device_id_provider', None)
        cookie_ttl = getattr(old_staging, '_cookie_ttl_minutes', 30)
        data_dir = getattr(old_staging, '_data_dir', None)

        # Invalidate remote ledger cache — may be from a different identity
        cache_path = self._get_remote_ledger_cache_path()
        if cache_path:
            try:
                _RemoteLedgerCache(cache_path).invalidate()
            except Exception:
                pass

        self._staging = StagingService(
            crypto=fresh_crypto,
            staging_store=staging_store,
            transport=transport,
            device_id_provider=device_id_provider,
            cookie_ttl_minutes=cookie_ttl,
            data_dir=str(data_dir) if data_dir else None,
        )

        # Rebuild LedgerEngine with fresh crypto
        old_engine = self._ledger_engine
        self._ledger_engine = LedgerEngine(
            crypto=fresh_crypto,
            store=old_engine.store,
            index_store=old_engine.index_store,
            staging_store=staging_store,
            identity_secret=None,
        )

    def _resolve_title(self, identifier):
        """Resolve a string identifier to a title.
        If identifier looks like a positive integer (e.g. '1', '2'),
        treat it as a 1-based index into the active tasks list.
        Otherwise, return the identifier as-is (title string).
        If an exact title match exists among active tasks, title takes precedence."""
        staging = self._staging._local.read_entries()
        active = [e for e in staging if e.get("is_active")]
        active_titles = [e["title"] for e in active]

        # Title match takes precedence
        if identifier in active_titles:
            return identifier

        # Try numeric ID
        try:
            idx = int(identifier)
            if idx < 1:
                raise ValueError(f"Invalid ID: {identifier}. IDs start at 1.")
            if not active_titles:
                raise ValueError(f"No active tasks to reference by ID.")
            if idx > len(active_titles):
                raise ValueError(f"ID {idx} out of range. Only {len(active_titles)} active task(s).")
            return active_titles[idx - 1]
        except ValueError as e:
            # If int() itself failed, it's not a number — treat as title
            if str(identifier).lstrip('-').isdigit() and int(identifier) < 1:
                raise ValueError(f"Invalid ID: {identifier}. IDs start at 1.")
            # If we raised one of the ID-related errors, re-raise
            if "Invalid ID" in str(e) or "No active tasks" in str(e) or "out of range" in str(e):
                raise
            # Not a number — treat as title (already checked above; fallback)
            return identifier

    def _get_active_with_ids(self):
        """Return list of {id, title} dicts for active tasks."""
        staging = self._staging._local.read_entries()
        active = [e for e in staging if e.get("is_active")]
        return [{"id": i + 1, "title": e["title"]} for i, e in enumerate(active)]

    @staticmethod
    def _compute_duration(start_epoch, end_epoch, pauses):
        """Compute active duration as wall time minus all completed pause intervals."""
        total_pause_ms = 0
        for p in pauses:
            if p.get("pause_stop") is not None:
                total_pause_ms += p["pause_stop"] - p["pause_start"]
        return max(0, (end_epoch - start_epoch) - total_pause_ms)

    @staticmethod
    def _normalize_tag_args(tag_args):
        """Normalize a list of raw tag strings from CLI.
        Returns a sorted, deduplicated, lowercased list with whitespace stripped.
        Returns None if no valid tags remain."""
        if not tag_args:
            return None
        seen = set()
        result = []
        for t in tag_args:
            clean = t.strip().lower()
            if clean and clean not in seen:
                seen.add(clean)
                result.append(clean)
        result.sort()
        return result if result else None

    @trace
    def _push_if_remote(self):
        """Push staging to remote if configured (no-op otherwise).

        Requires a valid 32-byte master_key for blob obfuscation.
        If no key is available (unauthenticated session), skips the
        push and prints a warning — pushing plaintext staging data
        to a remote repo would leak private information.
        """
        if self._staging._remote is not None:
            # Derive master_key from crypto if available (authenticated session)
            mk = getattr(self._crypto, "master_key", None)
            if not isinstance(mk, bytes) or len(mk) != 32:
                print("Warning: cannot push to remote — authenticate first (e.g. 'phpoc view')")
                return
            self._staging.push_to_remote(master_key=mk)

    def _defer_push(self):
        """Phase B: write WAL + spawn background push instead of blocking.

        Called after every write command (add_start, add_end, etc.) to
        return control to the user instantly (~2ms) while the remote
        push happens in a detached subprocess.
        """
        if self._staging._remote is None:
            return

        # Read current staging entries for the WAL hash
        try:
            entries = self._staging._local._store.read_entries()
        except Exception:
            entries = []

        # Get device_id
        mk = getattr(self._crypto, "master_key", None)
        if isinstance(mk, bytes) and len(mk) == 32:
            try:
                identity = self._staging._device_id_provider.get_device_identity(mk)
                device_id = identity.device_id
            except Exception:
                device_id = "unknown"
        else:
            device_id = "unknown"

        # Write WAL (crash-safe bookmark) then spawn background push
        _write_wal_pending(self._staging._data_dir, entries, device_id)
        _spawn_background_push(self._staging._data_dir)

    @trace
    def add_oneoff(self, title, start, stop, metadata=None, tags=None, comment=None):
        if not self._sync_before_command(require_auth=True):
            print("Authentication required. Run 'ph login' or 'ph sync' first.")
            return
        self._staging.capture(title, start, stop_epoch=stop, metadata=metadata, is_active=False, tags=tags, comment=comment)
        self._defer_push()
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        comment_str = f" — \"{comment}\"" if comment else ""
        print(f"\u2713 One-off habit captured: {title}{tag_str}{comment_str}")

    @trace
    def add_start(self, title, tags=None, comment=None):
        if not self._sync_before_command(require_auth=True):
            print("Authentication required. Run 'ph login' or 'ph sync' first.")
            return
        self._staging.capture(title, int(time.time()*1000), is_active=True, tags=tags, comment=comment)
        self._defer_push()
        tag_str = f" [{', '.join(tags)}]" if tags else ""
        comment_str = f" — \"{comment}\"" if comment else ""
        print(f"\u2713 Started tracking: {title}{tag_str}{comment_str}")

    @trace
    def add_end(self, title, comment=None):
        if not self._sync_before_command(require_auth=True):
            print("Authentication required. Run 'ph login' or 'ph sync' first.")
            return
        resolved = self._resolve_title(title)
        self._staging.end(resolved, int(time.time()*1000), comment=comment)
        self._defer_push()
        comment_str = f" — \"{comment}\"" if comment else ""
        print(f"\u2713 Stopped tracking: {resolved}{comment_str}")

    @trace
    def add_pause(self, title):
        if not self._sync_before_command(require_auth=True):
            print("Authentication required. Run 'ph login' or 'ph sync' first.")
            return
        resolved = self._resolve_title(title)
        self._staging.pause(resolved, int(time.time()*1000))
        self._defer_push()
        print(f"\u2713 Paused: {resolved}")

    @trace
    def add_unpause(self, title):
        if not self._sync_before_command(require_auth=True):
            print("Authentication required. Run 'ph login' or 'ph sync' first.")
            return
        resolved = self._resolve_title(title)
        self._staging.unpause(resolved, int(time.time()*1000))
        self._defer_push()
        print(f"\u2713 Resumed: {resolved}")

    @trace
    def view_active(self, show_tags=False, show_comments=False):
        # Sync with remote before showing data.
        # If re-auth is needed (specifier mismatch or stale session),
        # _sync_before_command returns False with a message.
        if not self._sync_before_command(require_auth=False):
            return

        # Phase A: Show any pending sync notifications from background checks
        _show_sync_notifications(self._staging._data_dir)

        # Phase A: Read and display local data INSTANTLY (no remote blocking)
        staging_dtos = self._staging._local.read_entries()
        active = [dto for dto in staging_dtos if dto.get("is_active")]

        # Phase A: Spawn background remote check (non-blocking, fire-and-forget)
        # Must fire before any early return so reads are always async.
        if self._staging._remote is not None:
            _spawn_background_sync_check(self._staging)

        print("\n--- Running Tasks ---")
        if not active:
            print("No active tasks.")
            return

        # Build active entries with IDs directly (avoid title-keyed map — dup titles)
        # DTOs have start_epoch in ms, plain fields already decoded
        import json as _json
        active_entries = []
        for i, dto in enumerate(active, 1):
            start_epoch = dto.get("start_epoch", 0) or 0
            # Package as _print_entry-compatible entry dict
            entry = {
                "source": "staged",
                "data": {
                    "title": dto.get("title", ""),
                    "duration": dto.get("duration", 0),
                    "startTime_enc": f"plain:{start_epoch}",
                    "endTime_enc": f"plain:{dto.get('end_epoch')}" if dto.get("end_epoch") else None,
                    "metadata_enc": f"plain:{_json.dumps(dto.get('metadata', {}))}",
                    "pauses_enc": f"plain:{_json.dumps(dto.get('pauses', []))}",
                    "tags": dto.get("tags", []),
                    "comment": dto.get("comment", ""),
                    "media": dto.get("media", []),
                    "is_active": dto.get("is_active", False),
                    "is_paused": dto.get("is_paused", False),
                    "entry_id": dto.get("entry_id", ""),
                    "_is_staged": True,
                },
                "date": dto.get("date", "unknown"),
            }
            active_entries.append({"id": i, "entry": entry, "start_epoch": start_epoch})

        for ae in active_entries:
            data = ae["entry"]["data"]
            task_id = ae["id"]
            start_epoch = ae["start_epoch"]
            started = time.strftime("%H:%M:%S", time.localtime(start_epoch/1000))

            # Show pause indicator and active duration so far
            # Compute active duration up to now, excluding pauses
            pauses_enc = data.get("pauses_enc")
            pauses = []
            if pauses_enc:
                if pauses_enc.startswith("plain:"):
                    pauses = json.loads(pauses_enc[6:])
                else:
                    pauses = json.loads(self._crypto.decrypt(pauses_enc))

            # Tags display
            tag_str = ""
            if show_tags:
                tags = data.get("tags", [])
                if tags:
                    tag_str = f" [@{', @'.join(tags)}]"

            comment_str = ""
            if show_comments:
                comment = data.get("comment")
                if comment:
                    comment_str = f" — \"{comment}\""

            if data.get("is_paused"):
                # Task is paused — show duration up to the pause start
                if pauses and pauses[-1].get("pause_stop") is None:
                    paused_since = pauses[-1]["pause_start"]
                    duration_ms = self._compute_duration(start_epoch, paused_since, pauses)
                    pause_time = time.strftime("%H:%M:%S", time.localtime(paused_since/1000))
                    print(f"#{task_id} [{started}] {data['title']} (\u23f8 paused at {pause_time}, active: {duration_ms // 60000}m){tag_str}{comment_str}")
                else:
                    print(f"#{task_id} [{started}] {data['title']} (\u23f8 paused){tag_str}{comment_str}")
            else:
                # Task is actively running — show live duration (excluding past pauses)
                now = int(time.time() * 1000)
                duration_ms = self._compute_duration(start_epoch, now, pauses)
                print(f"#{task_id} [{started}] {data['title']} (active: {duration_ms // 60000}m){tag_str}{comment_str}")



    def show_rep(self, days_limit=None, from_date=None, to_date=None):
        # Use Blind Index for speed and privacy
        index = self._ledger_engine._index.get_all()
        rep = {}

        from_str = from_date
        to_str = to_date
        if days_limit is not None and from_str is None:
            limit_epoch = time.time() - (days_limit * 86400)
            from_str = time.strftime("%Y-%m-%d", time.localtime(limit_epoch))

        for date_str, activities in index.items():
            if from_str and date_str < from_str: continue
            if to_str and date_str > to_str: continue

            for title, duration in activities.items():
                rep[title] = rep.get(title, 0) + duration

        print(f"\n--- Reputation Summary ---")
        for title, total_ms in sorted(rep.items(), key=lambda x: x[1], reverse=True):
            print(f"{title}: {total_ms // 60000}m")

    # ------------------------------------------------------------------
    # Remote ledger sync + staging dedup (called from _sync_before_command)
    # ------------------------------------------------------------------

    # Cache of remote ledger entries for display, keyed by (date, title):
    # {(date_str, title): {"startTime_enc": ..., "endTime_enc": ...,
    #                      "duration": ..., "tags": ..., "comment": ...}}
    _remote_ledger_cache: Optional[Dict[Tuple[str, str], Dict[str, Any]]] = None
    _remote_ledger_cache_time: float = 0.0

    def _get_remote_ledger_cache_path(self) -> Optional[Path]:
        """Return the cache file path, or None when data_dir is unavailable."""
        data_dir = getattr(self._staging, '_data_dir', None)
        if data_dir is None:
            return None
        return Path(data_dir) / "remote_ledger_cache.json"

    def _apply_cached_ledger_data(self, cache: "_RemoteLedgerCache"):
        """Reconstruct instance display/dedup state from *cache* blocks.

        Called after a cache hit or after freshly-pulled blocks have been
        merged into the cache.  Updates ``_remote_ledger_cache``,
        removes committed entries from staging, and merges the remote
        blind index.
        """
        committed_titles, remote_entries = (
            self._reconstruct_from_cache_blocks(cache.blocks)
        )
        self._remote_ledger_cache = remote_entries
        self._remote_ledger_cache_time = time.time()
        if cache.remote_index:
            self._merge_remote_index(cache.remote_index)
        if committed_titles:
            self._remove_committed_from_staging(committed_titles)

    @staticmethod
    def _reconstruct_from_cache_blocks(
        blocks: Dict[str, Dict[str, Any]]
    ) -> Tuple[Dict[Tuple[str, str], int], Dict[Tuple[str, str], Dict[str, Any]]]:
        """Reconstruct ``committed_titles`` + ``remote_entries`` from cached
        block data."""
        committed_titles: Dict[Tuple[str, str], int] = {}
        remote_entries: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for block in blocks.values():
            date_str = block.get("date", "")
            if not date_str:
                continue
            for entry in block.get("entries", []):
                data = entry.get("data", {})
                title = data.get("title", "")
                if not title:
                    continue
                key = (date_str, title)
                committed_titles[key] = committed_titles.get(key, 0) + 1
                if key not in remote_entries:
                    remote_entries[key] = dict(data)
        return committed_titles, remote_entries

    def _refresh_remote_ledger_cache(
        self,
        cache: "_RemoteLedgerCache",
        transport,
        mk: bytes,
    ) -> bool:
        """Pull remote ledger blocks and update *cache* in place.

        Returns True if any blocks were pulled (or repulled after TTL
        expiry), False if the remote has no blocks to pull.
        """
        from domain.ledger.remote_sync import RemoteLedgerSync
        ledger_sync = RemoteLedgerSync(transport, mk)

        try:
            existing_indices = ledger_sync._list_remote_block_indices()
        except Exception:
            existing_indices = set()

        if not existing_indices:
            return False

        # TTL expired → discard stale blocks and re-pull everything
        if cache.last_pull_time > 0:
            cache.blocks = {}
            cache.max_block_index = -1
            start_idx = 0
        else:
            # Cold start or incremental — pull only new blocks
            start_idx = max(cache.max_block_index + 1, 0)

        for idx in sorted(existing_indices):
            if idx < start_idx:
                continue
            try:
                block = ledger_sync.pull_block_by_index(idx)
            except Exception:
                continue
            if not block or block.get("type", "day") != "day":
                continue
            # Store by string index for JSON serialisation
            cache.blocks[str(idx)] = block
            cache.max_block_index = max(cache.max_block_index, idx)

        cache.last_pull_time = time.time()

        # Pull remote index (best effort)
        try:
            remote_index = ledger_sync.pull_index()
            if remote_index:
                cache.remote_index = remote_index
        except Exception as exc:
            logger.debug(
                "_refresh_remote_ledger_cache: pull_index failed: %s", exc
            )

        cache.save()
        return True

    def _sync_remote_ledger_and_dedup(self):
        """Pull remote ledger blocks and remove committed entries from staging.

        Uses a persistent file cache (``_RemoteLedgerCache``) so that
        back-to-back CLI invocations skip re-pulling blocks that haven't
        changed.  On cache hit the method reconstructs ``committed_titles``
        and ``remote_entries`` from the cached blocks without any HTTP
        requests.  On cache miss it pulls only new blocks (incremental) or
        performs a full repull when the TTL has expired.

        Pulled blocks are pulled by index (no chain verification needed —
        blocks from divergent chains are still valid for dedup purposes).
        Staging entries whose (date, title) exist in the remote ledger are
        removed from staging to prevent duplicate commits and incorrect
        "(Staged)" display.

        Also caches remote ledger entries for display in ``list_habits``
        so that entries committed by other clients (e.g. phpoc-web) appear
        in the "synced" section even when they aren't in the local chain.

        This is a best-effort operation. Failures are non-fatal — the
        caller continues with whatever data is locally available.
        """
        transport = getattr(self._staging._remote, '_transport', None)
        if transport is None:
            return

        mk = getattr(self._crypto, 'master_key', None)
        if not isinstance(mk, bytes) or len(mk) != 32:
            return

        try:
            cache_path = self._get_remote_ledger_cache_path()
            if cache_path is None:
                return
            cache = _RemoteLedgerCache(cache_path)
            cache.load()

            # ── cache hit: reconstruct from disk, zero HTTP ──────────
            if cache.is_fresh(ttl=60):
                self._apply_cached_ledger_data(cache)
                return

            # ── cache miss / expired: pull from remote ───────────────
            pulled = self._refresh_remote_ledger_cache(cache, transport, mk)
            if pulled:
                self._apply_cached_ledger_data(cache)

        except Exception as exc:
            logger.debug(
                "_sync_remote_ledger_and_dedup: failed: %s", exc
            )

    def _merge_remote_index(self, remote_index: Dict[str, Any]):
        """Merge a remote blind index into the local index.

        For each (date, title) pair, the local index is updated to the
        maximum of local and remote durations (remote wins on conflict).
        """
        local_index = self._ledger_engine.index.get_all()
        for date_str, titles in remote_index.items():
            if date_str not in local_index:
                local_index[date_str] = dict(titles)
            else:
                for title, duration in titles.items():
                    existing = local_index[date_str].get(title, 0)
                    if duration > existing:
                        local_index[date_str][title] = duration

        # Write merged index back
        self._ledger_engine.index.clear()
        for date_str, titles in local_index.items():
            for title, duration in titles.items():
                self._ledger_engine.index.update(date_str, title, duration)

    def _remove_committed_from_staging(
        self,
        committed_titles: Dict[Tuple[str, str], int],
    ):
        """Remove staging entries that have already been committed to the ledger.

        Args:
            committed_titles: Dict of {(date_str, title): count} from the
                remote ledger blocks.
        """
        staging_dtos = self._staging._local.read_entries()
        if not staging_dtos:
            return

        if not committed_titles:
            return

        # Identify staging entries to remove (by index).
        # Uses a mutable copy of committed_titles to handle duplicate
        # titles on the same date correctly.
        indices_to_remove: List[int] = []
        remaining = dict(committed_titles)

        for entry_idx, dto in enumerate(staging_dtos):
            title = dto.get("title", "")
            if not title:
                continue

            # DTO has start_epoch in ms — compute date from it
            start_epoch = dto.get("start_epoch")
            if start_epoch is None:
                continue
            try:
                date_str = time.strftime(
                    "%Y-%m-%d", time.gmtime(start_epoch // 1000)
                )
            except Exception:
                continue

            key = (date_str, title)
            if remaining.get(key, 0) > 0:
                indices_to_remove.append(entry_idx)
                remaining[key] -= 1

        if indices_to_remove:
            logger.info(
                "Removing %d staging entries already committed to ledger: %s",
                len(indices_to_remove),
                [
                    staging_raw[i]["data"].get("title", "?")
                    for i in indices_to_remove
                ],
            )
            self._staging.remove_synced(indices_to_remove)

            # Push the cleaned staging to remote so other clients don't
            # re-introduce the committed entries
            mk = getattr(self._crypto, 'master_key', None)
            if isinstance(mk, bytes) and len(mk) == 32:
                try:
                    self._staging.push_blob_only(master_key=mk)
                except Exception as exc:
                    logger.debug(
                        "_remove_committed_from_staging: push failed: %s", exc
                    )

    @trace
    def list_habits(self, source: str, days_limit=None, from_date=None, to_date=None, show_comments=False, show_tags=False):
        if not self._sync_before_command(require_auth=False):
            return
        print(f"\n--- Detailed Habit List ({source.capitalize()}) ---")

        # Convert days_limit to from_date if from_date is not already set
        if days_limit is not None and from_date is None:
            limit_epoch = time.time() - (days_limit * 86400)
            from_date = time.strftime("%Y-%m-%d", time.localtime(limit_epoch))

        synced_data = []
        if source in ['synced', 'all']:
            synced_data = self._ledger_engine.get_day_blocks() or [] # Ensure it's a list if None

        staged_data = []
        if source in ['staged', 'all']:
            staged_dtos = self._staging._local.read_entries()
            # Convert DTOs to _print_entry-compatible format with plain: prefix
            import json as _json
            for dto in staged_dtos:
                start_epoch = dto.get("start_epoch", 0) or 0
                end_epoch = dto.get("end_epoch")
                staged_data.append({
                    "source": "staged",
                    "data": {
                        "title": dto.get("title", ""),
                        "duration": dto.get("duration", 0),
                        "startTime_enc": f"plain:{start_epoch}",
                        "endTime_enc": f"plain:{end_epoch}" if end_epoch is not None else None,
                        "metadata_enc": f"plain:{_json.dumps(dto.get('metadata', {}))}",
                        "pauses_enc": f"plain:{_json.dumps(dto.get('pauses', []))}",
                        "tags": dto.get("tags", []),
                        "comment": dto.get("comment", ""),
                        "media": dto.get("media", []),
                        "is_active": dto.get("is_active", False),
                        "is_paused": dto.get("is_paused", False),
                        "entry_id": dto.get("entry_id", ""),
                        "_is_staged": True,
                    },
                    "date": dto.get("date", "unknown"),
                })

        # Process synced data
        synced_by_date = {}
        for day in synced_data:
            if day.get("type", "day") != "day": continue
            date_str = day["date"]

            # Apply date filters
            if (from_date and date_str < from_date) or (to_date and date_str > to_date):
                continue

            if date_str not in synced_by_date:
                synced_by_date[date_str] = []

            for entry in day.get("entries", []):
                synced_by_date[date_str].append({"source": "synced", "data": entry["data"], "date": date_str})

        # Also include cached remote ledger entries (pulled by
        # _sync_remote_ledger_and_dedup) so entries committed by other
        # clients (e.g. phpoc-web) appear in the "synced" section even
        # when they aren't in the local chain (divergent chains).
        if source in ['synced', 'all'] and self._remote_ledger_cache:
            for (remote_date, title), data in self._remote_ledger_cache.items():
                # Apply date filters
                if (from_date and remote_date < from_date) or \
                   (to_date and remote_date > to_date):
                    continue
                # Skip if already in local synced data (avoid duplicates
                # where the same entry exists in both local and remote chains)
                if remote_date in synced_by_date:
                    local_titles = {
                        e["data"].get("title") for e in synced_by_date[remote_date]
                    }
                    if title in local_titles:
                        continue
                if remote_date not in synced_by_date:
                    synced_by_date[remote_date] = []
                synced_by_date[remote_date].append({
                    "source": "synced",
                    "data": data,
                    "date": remote_date,
                })

        # Process staged data — entries are already in _print_entry-compatible format
        staged_by_date = {}
        for entry_data in staged_data:
            date_str = entry_data["date"]
            if date_str not in staged_by_date:
                staged_by_date[date_str] = []
            staged_by_date[date_str].append(entry_data)

        # --- P11 Fix B: Collect spanning entries from previous day ---
        # For each date in range, peek at the previous day's synced block and
        # surface entries that span into the target date. Only include if the
        # entry's original date is OUTSIDE the filter range (dedup guard).
        peek_entries = {}  # {target_date_str: [entry_dict, ...]}
        all_dates = set(list(synced_by_date.keys()) + list(staged_by_date.keys()))

        def _date_in_range(d):
            if from_date and d < from_date:
                return False
            if to_date and d > to_date:
                return False
            return True

        if source in ['synced', 'all'] and (from_date is not None or to_date is not None):
            # Build a reverse lookup: for each date in range, find its previous day
            for date_str in sorted(all_dates):
                if not _date_in_range(date_str):
                    continue
                # Compute previous day
                dt = datetime.strptime(date_str, "%Y-%m-%d")
                prev_date = (dt - timedelta(days=1)).strftime("%Y-%m-%d")
                if prev_date not in synced_by_date:
                    continue
                # Check each entry in the previous day's block
                for entry_data in synced_by_date[prev_date]:
                    entry = entry_data["data"]
                    start_val = entry.get("startTime_enc")
                    end_val = entry.get("endTime_enc")
                    if not end_val:
                        continue
                    # Decrypt or plain: prefix
                    try:
                        if start_val and start_val.startswith("plain:"):
                            start_epoch = int(start_val[6:])
                        else:
                            start_epoch = int(self._crypto.decrypt(start_val))
                        if end_val.startswith("plain:"):
                            stop_epoch = int(end_val[6:])
                        else:
                            stop_epoch = int(self._crypto.decrypt(end_val))
                    except Exception:
                        continue
                    # Guard: must have valid end > start
                    if stop_epoch <= start_epoch:
                        continue
                    # Check if it spans into the target date
                    start_date = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
                    end_date = time.strftime("%Y-%m-%d", time.gmtime(stop_epoch // 1000))
                    if end_date != start_date and end_date == date_str:
                        # Dedup: only include if original date is OUTSIDE the filter range
                        if not _date_in_range(start_date):
                            if date_str not in peek_entries:
                                peek_entries[date_str] = []
                            peek_entries[date_str].append(entry_data)

        # Combine dates from both sources, including any dates that only have peeked entries
        all_dates = set(list(synced_by_date.keys()) + list(staged_by_date.keys()) + list(peek_entries.keys()))

        for date_str in sorted(all_dates):
            if not _date_in_range(date_str):
                continue

            # Skip if source filtering doesn't include this date's data
            if source == 'synced' and date_str not in synced_by_date and date_str not in peek_entries:
                continue
            if source == 'staged' and date_str not in staged_by_date:
                continue

            # Print date header
            print(f"\nDate: {date_str}")

            # Process synced entries for this date (including peeked entries)
            if source in ['synced', 'all']:
                # Own entries first
                if date_str in synced_by_date:
                    for entry_data in synced_by_date[date_str]:
                        self._print_entry(entry_data, show_comments=show_comments, show_tags=show_tags)
                # Then peeked spanning entries from previous day
                if date_str in peek_entries:
                    for entry_data in peek_entries[date_str]:
                        self._print_entry(entry_data, show_comments=show_comments, show_tags=show_tags)

            # Process staged entries for this date
            if source in ['staged', 'all'] and date_str in staged_by_date:
                # Dedup: skip staged entries already shown as synced (ledger).
                # When source='all', an entry that was committed but still
                # remains in staging would appear twice without this guard.
                # Uses a Counter (not a set) to handle multiple entries with
                # the same title on the same date correctly.
                from collections import Counter
                synced_counts: Counter = Counter()
                if source == 'all':
                    for entry_data in (synced_by_date.get(date_str, []) +
                                       peek_entries.get(date_str, [])):
                        synced_counts[(date_str, entry_data['data'].get('title', ''))] += 1

                for entry_data in staged_by_date[date_str]:
                    key = (date_str, entry_data['data'].get('title', ''))
                    if source == 'all' and synced_counts.get(key, 0) > 0:
                        synced_counts[key] -= 1
                        continue
                    self._print_entry(entry_data, show_comments=show_comments, show_tags=show_tags)

    @staticmethod
    def _resolve_date_filters(days=None, date=None, week=None, month=None, year=None,
                               from_date=None, to_date=None):
        """
        Resolve all date filter arguments into (from_str, to_str) in YYYY-MM-DD format.

        - Each range filter (date, week, month, year) narrows to its bounds.
        - from_date and to_date act as partial bounds (lower / upper).
        - days is only used if date is None (date overrides days).
        - MM-only values borrow year from --year or current year.
        - Conflicts print WARN: to stderr and return (None, None).

        Returns (from_str, to_str) where None means unbounded.
        """
        from_str = None
        to_str = None

        def _narrow(lo, hi):
            """Intersect a [lo, hi] range into the current bounds."""
            nonlocal from_str, to_str
            if lo is not None:
                if from_str is None or lo > from_str:
                    from_str = lo
            if hi is not None:
                if to_str is None or hi < to_str:
                    to_str = hi

        def _month_range(year_val, month_val):
            """Return (first_day, last_day) for a given year/month."""
            last = calendar.monthrange(year_val, month_val)[1]
            return (f"{year_val:04d}-{month_val:02d}-01",
                    f"{year_val:04d}-{month_val:02d}-{last:02d}")

        def _parse_date_input(val, hint_year=None):
            """Parse a date value into (from_str, to_str) bounds.
            Supports: YYYY-MM-DD, YYYY-MM, YYYY, MM/YY, MM.
            """
            val = str(val).strip()

            # YYYY-MM-DD
            m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', val)
            if m:
                return (val, val)

            # YYYY-MM
            m = re.match(r'^(\d{4})-(\d{2})$', val)
            if m:
                y, mo = int(m.group(1)), int(m.group(2))
                return _month_range(y, mo)

            # YYYY
            m = re.match(r'^(\d{4})$', val)
            if m:
                return (f"{val}-01-01", f"{val}-12-31")

            # MM/YY
            m = re.match(r'^(\d{2})/(\d{2})$', val)
            if m:
                mo, ys = int(m.group(1)), int(m.group(2))
                y = 2000 + ys
                return _month_range(y, mo)

            # MM (month only, borrow year)
            m = re.match(r'^(\d{2})$', val)
            if m:
                mo = int(m.group(1))
                y = hint_year or datetime.now().year
                return _month_range(y, mo)

            raise ValueError(f"Unrecognized date format: {val}")

        def _iso_week_range(week_str):
            """Parse '2026-W17' or '2026-04-22' into (monday, sunday)."""
            week_str = str(week_str).strip()

            # Try ISO week format: YYYY-Www
            m = re.match(r'^(\d{4})-W(\d{2})$', week_str)
            if m:
                year, week = int(m.group(1)), int(m.group(2))
                # fromisocalendar available in Python 3.8+
                monday = datetime.fromisocalendar(year, week, 1)
                sunday = datetime.fromisocalendar(year, week, 7)
                return (monday.strftime("%Y-%m-%d"), sunday.strftime("%Y-%m-%d"))

            # Try date format: YYYY-MM-DD
            m = re.match(r'^(\d{4})-(\d{2})-(\d{2})$', week_str)
            if m:
                d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                # Find Monday of the ISO week containing this date
                iso_year, iso_week, _ = d.isocalendar()
                monday = datetime.fromisocalendar(iso_year, iso_week, 1)
                sunday = datetime.fromisocalendar(iso_year, iso_week, 7)
                return (monday.strftime("%Y-%m-%d"), sunday.strftime("%Y-%m-%d"))

            raise ValueError(f"Unrecognized week format: {week_str}")

        # --- Resolution order ---

        hint_year = None
        if year:
            hint_year = int(year)

        # 1. Range filters (date, week, month, year) — narrow to intersection
        if date:
            lo, hi = _parse_date_input(date)
            _narrow(lo, hi)
        elif days is not None:
            limit_epoch = time.time() - (days * 86400)
            lo = time.strftime("%Y-%m-%d", time.localtime(limit_epoch))
            _narrow(lo, None)

        if week:
            lo, hi = _iso_week_range(week)
            _narrow(lo, hi)

        if month:
            lo, hi = _parse_date_input(month, hint_year=hint_year)
            _narrow(lo, hi)

        if year:
            _narrow(f"{year}-01-01", f"{year}-12-31")

        # 2. Partial bounds (from_date, to_date) — override previous bounds
        #    These are explicit user overrides. days/week/month/year set
        #    auto-inferred bounds; --from/--to take priority.
        if from_date is not None:
            lo, _ = _parse_date_input(from_date, hint_year=hint_year)
            if lo is not None:
                from_str = lo

        if to_date is not None:
            _, hi = _parse_date_input(to_date, hint_year=hint_year)
            if hi is not None:
                to_str = hi

        # 3. Conflict detection
        if from_str is not None and to_str is not None and from_str > to_str:
            import sys
            print(f"WARN: Date range conflict — from ({from_str}) is after to ({to_str})",
                  file=sys.stderr)
            return (None, None)

        return (from_str, to_str)

    def list_tags(self):
        """Collect and print all unique tags from staging, local ledger,
        and remote ledger cache."""
        all_tags = set()

        # From staging
        staging = self._staging._local.read_entries()
        for entry in staging:
            all_tags.update(entry.get("tags", []))

        # From local synced ledger
        ledger_data = self._ledger_engine.get_day_blocks()
        for day in (ledger_data or []):
            if day.get("type") != "day":
                continue
            for entry in day.get("entries", []):
                all_tags.update(entry["data"].get("tags", []))

        # From remote ledger cache (entries committed by other clients)
        if self._remote_ledger_cache:
            for (_date_str, _title), data in self._remote_ledger_cache.items():
                all_tags.update(data.get("tags", []))

        sorted_tags = sorted(all_tags)
        if sorted_tags:
            print("\n--- Tags ---")
            for t in sorted_tags:
                print(f"  @{t}")
        else:
            print("No tags found.")

    def _print_entry(self, entry_data, show_comments=False, show_tags=False):
        """Helper method to print an entry (synced or staged)."""
        data = entry_data["data"]

        title = data.get("title", "?")
        duration = data.get("duration", 0)

        start_val = data.get("startTime_enc")
        if not start_val:
            return
        if start_val.startswith("plain:"):
            start_epoch = int(start_val[6:])
        else:
            try:
                start_epoch = int(self._crypto.decrypt(start_val))
            except Exception:
                # Can't decrypt — show placeholder instead of silently skipping
                source_indicator = " (Staged)" if entry_data.get("source") == "staged" else ""
                print(f"  [encrypted] {title}{source_indicator} ({duration // 60000}m) [run 'ph login' to decrypt]")
                return

        if data["endTime_enc"]:
            end_val = data["endTime_enc"]
            if end_val.startswith("plain:"):
                stop_epoch = int(end_val[6:])
            else:
                try:
                    stop_epoch = int(self._crypto.decrypt(end_val))
                except Exception:
                    stop_epoch = None
        else:
            stop_epoch = None

        meta_enc = data.get("metadata_enc")
        if meta_enc:
            if meta_enc.startswith("plain:"):
                meta = json.loads(meta_enc[6:])
            else:
                try:
                    meta = json.loads(self._crypto.decrypt(meta_enc))
                except Exception:
                    meta = {}
        else:
            meta = {}

        start_str = time.strftime("%H:%M", time.localtime(start_epoch/1000))
        stop_str = time.strftime("%H:%M", time.localtime(stop_epoch/1000)) if stop_epoch else "??"

        # --- P11 Fix A: Spanning marker ---
        # Detect entries that cross midnight: if the UTC end date differs from
        # the UTC start date (and the entry has a valid end time after start),
        # append a visual indicator.
        marker = ""
        if stop_epoch is not None and stop_epoch > start_epoch:
            start_date = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
            end_date = time.strftime("%Y-%m-%d", time.gmtime(stop_epoch // 1000))
            if end_date != start_date:
                marker = " \u23ed"  # ⏭ skip-to-next-track symbol

        # Add source indicator
        source_indicator = " (Staged)" if entry_data["source"] == "staged" else ""
        comment_str = ""
        if show_comments:
            comment = data.get("comment")
            if comment:
                comment_str = f" — \"{comment}\""

        tag_str = ""
        if show_tags:
            tags = data.get("tags", [])
            if tags:
                tag_str = f" [@{', @'.join(tags)}]"

        print(f"  [{start_str} - {stop_str}] {data['title']}{marker}{source_indicator} ({data['duration'] // 60000}m){comment_str}{tag_str}")
        if meta: print(f"    Metadata: {meta}")
