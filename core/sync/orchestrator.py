"""SyncOrchestrator — coordinates staging sync into the ledger, plus remote ledger block sync.

Full sync lifecycle:
  1. check_and_sync() — pull remote staging blob, merge into local
  2. get_pending_sync() — gather completed entries ready for ledger
  3. (optional) run SyncStrategy — user confirmation with overrides
  4. ledger_engine.commit(entries) — write to the chain
  5. ledger_engine.verify() — integrity check after commit
  6. staging_service.remove_synced(indices) — clean up staging
  7. staging_service.push_to_remote() — push merged staging state to remote
  8. ledger sync — pull missing remote blocks, push new local blocks, push index
  9. view.notify() — signal completion to the frontend

Revert lifecycle:
  1. ledger_engine.revert(count) — undo N day blocks
  2. Capture restored entries back into staging
  3. (optional) push_to_remote() — propagate revert
"""

import logging
import json
import hashlib
import time
import asyncio
from typing import Optional, List, Dict, Any

from domain.staging.service import StagingService
from domain.staging.remote_sync import SyncCheckResult
from domain.ledger.engine import LedgerEngine
from domain.interfaces.view import ViewInterface
from core.sync.transport import AbstractStagingTransport
from domain.ledger.helpers import get_block_hash
from core.sync.decision import SyncDecision


logger = logging.getLogger(__name__)


class SyncOrchestrator:
    """Coordinates StagingService and LedgerEngine into a unified sync pipeline.

    When a transport is configured, ``sync()`` also syncs ledger blocks
    to/from remote (pull missing, push new, push index).

    Attributes:
        _staging: StagingService for CRUD and remote sync.
        _ledger: LedgerEngine for chain commit/verify/revert.
        _view: Optional ViewInterface for notifications.
        _master_key: Master key for device identity and push auth.
        _transport: Optional transport for remote ledger block sync.
    """

    def __init__(
        self,
        staging_service: StagingService,
        ledger_engine: LedgerEngine,
        view_interface: ViewInterface = None,
        master_key: bytes = None,
        transport: Optional[AbstractStagingTransport] = None,
    ):
        self._staging = staging_service
        self._ledger = ledger_engine
        self._view = view_interface
        self._master_key = master_key
        self._transport = transport
        self._identity_secret: Optional[bytes] = None

    # ------------------------------------------------------------------
    # Main sync flow
    # ------------------------------------------------------------------

    def sync(
        self,
        till_date: Optional[str] = None,
        skip_confirmation: bool = False,
    ) -> bool:
        """Run the full sync pipeline.

        1. check_and_sync() — pull remote staging, merge local
        2. Get pending (completed) entries from staging
        3. If till_date set: filter pending to entries with date <= till_date
        4. User confirmation (unless ``skip_confirmation=True``):
           - InteractiveCLIStrategy shows overview, allows edits and removals
           - Returns SyncDecision with selected indices, overrides, removals
        5. Commit to ledger
        6. Verify chain integrity
        7. If verify OK: remove synced from staging, push to remote
        8. If verify fails: revert the commit
        9. If remote transport configured: sync ledger blocks
           (pull missing, push new, push index)

        Args:
            till_date: Optional date string (YYYY-MM-DD). Only entries with
                       date <= till_date will be synced.
            skip_confirmation: If True, sync all pending entries without prompt.
                               Use --yes flag or headless mode.

        Returns:
            True on success, False if verify fails (commit reverted).
        """
        # Step 1: check remote and merge
        check_result = self._staging.check_and_sync(timeout_ms=500)

        if check_result == SyncCheckResult.OFFLINE:
            logger.warning(
                "SyncOrchestrator: remote staging unreachable — "
                "continuing with local data"
            )
        elif check_result == SyncCheckResult.REAUTH_NEEDED:
            logger.warning(
                "SyncOrchestrator: cross-device auth needed — "
                "staging will sync after re-auth"
            )

        # Step 1.5: Deduplicate — remove local staging entries already
        # committed in the remote ledger (cross-platform scenario).
        # Without this, the web client commits an entry → pushes ledger
        # blocks + removes from staging blob → CLI sees the entry still
        # in local staging (remote blob has it removed, merge can't tell
        # it was committed) → CLI re-commits it as a duplicate.
        self._deduplicate_from_remote_ledger()

        # Step 2: get pending entries
        pending = self._staging.get_pending_sync()
        if not pending:
            logger.info("SyncOrchestrator: no pending entries to sync")
            self._sync_ledger_blocks()
            return True

        # Step 3: filter by till_date if provided
        if till_date is not None:
            pending = [p for p in pending if p["date"] <= till_date]
            if not pending:
                logger.info(
                    "SyncOrchestrator: no pending entries match till_date=%s",
                    till_date,
                )
                self._sync_ledger_blocks()
                return True

        # Step 4: user confirmation
        sync_decision: Optional[SyncDecision] = None
        if not skip_confirmation and pending and self._view is not None:
            from cli.strategies import InteractiveCLIStrategy
            strategy = InteractiveCLIStrategy()
            sync_decision = strategy.decide(pending, self._view)
            if sync_decision.cancelled:
                logger.info("SyncOrchestrator: sync cancelled by user")
                return False

            # Filter pending to only selected entries
            pending = [
                p for p in pending
                if p["entry_index"] in sync_decision.selected_indices
            ]
            if not pending:
                # No entries selected, but removals may exist.
                # Process removals first, then push + ledger sync.
                if sync_decision.has_removals:
                    self._staging.remove_synced(
                        list(sync_decision.removal_indices)
                    )
                    if self._master_key is not None:
                        self._staging.push_to_remote(self._master_key)
                self._sync_ledger_blocks()
                return True

            # Apply overrides (end time, comment)
            for p in pending:
                idx = p["entry_index"]
                if idx in sync_decision.overrides:
                    ov = sync_decision.overrides[idx]
                    if "end_epoch" in ov:
                        p["end_epoch"] = ov["end_epoch"]
                        p["duration"] = ov["end_epoch"] - p["start_epoch"]
                    if "comment" in ov:
                        p["comment"] = ov["comment"]

        if skip_confirmation or self._view is None:
            # Auto-sync all pending entries
            pass

        # Step 5: commit to ledger
        logger.info(
            "SyncOrchestrator: committing %d entries to ledger",
            len(pending),
        )
        commit_result = self._ledger.commit(pending)

        if commit_result is None:
            logger.warning("SyncOrchestrator: commit returned None")
            return False

        # Step 6: verify chain integrity
        if not self._ledger.verify():
            logger.error("SyncOrchestrator: ledger verify failed — reverting")
            self._ledger.revert(1)
            return False

        # Step 7: remove synced entries from staging
        indices_to_remove = [e["entry_index"] for e in pending]
        self._staging.remove_synced(indices_to_remove)

        # Handle removal entries (entries the user explicitly marked for removal)
        if sync_decision is not None and sync_decision.has_removals:
            self._staging.remove_synced(list(sync_decision.removal_indices))

        # Step 8: push to remote if master_key is set
        if self._master_key is not None:
            self._staging.push_to_remote(self._master_key)

        # Step 9: sync ledger blocks to/from remote
        self._sync_ledger_blocks()

        # Step 10: notify view
        if self._view is not None:
            self._view.notify(
                f"Synced {len(pending)} entries to ledger"
            )

        return True

    def _sync_ledger_blocks(self):
        """Pull missing remote ledger blocks, push new local blocks, push index.

        Only runs when a transport and master_key are available.
        Failures are logged but not fatal — local ledger always takes priority.

        Handles two divergence scenarios:
          1. Same-genesis divergence: two devices share a genesis but produced
             different day blocks. Offers interactive merge via LedgerMerge.
             If the user confirms, replaces local chain with merged result and
             force-pushes to remote.
          2. Stale-remote recovery: remote has blocks from an incompatible chain
             (e.g. after ``ph recover`` force-pushed a shorter chain). Local
             chain overwrites the stale indices.
        """
        if self._transport is None or self._master_key is None:
            return

        from domain.ledger.remote_sync import RemoteLedgerSync

        ledger_sync = RemoteLedgerSync(self._transport, self._master_key)

        # ═══════════════════════════════════════════════════════
        # Hash Index Fast Path (Tier 1 & 2)
        # ═══════════════════════════════════════════════════════
        # When hash index files exist on remote, we can detect
        # identical chains (Tier 1) or fork points (Tier 2) without
        # pulling every block. Falls through to full pull if hash
        # index is missing, tampered, or chains have diverged.

        all_blocks = self._ledger.chain.read_all()
        local_hashes = None
        local_sha256 = None
        try:
            local_hashes = [
                get_block_hash(b) for b in all_blocks
            ]
            local_hi_json = json.dumps(local_hashes).encode("utf-8")
            local_sha256 = hashlib.sha256(local_hi_json).hexdigest()
        except Exception:
            pass  # Blocks lack hash fields — fall through to full pull

        hi = None
        try:
            hi = ledger_sync.pull_hash_index()
        except Exception:
            pass  # Fall through to full pull

        if hi is not None and local_hashes is not None and local_sha256 is not None:
            remote_hashes = hi["hashes"]
            remote_sha256 = hi["sha256"]

            # ── Tier 1: SHA-256 match — chains identical ─────
            if local_sha256 == remote_sha256:
                logger.info(
                    "SyncOrchestrator: hash index SHA-256 match — "
                    "chains identical, skipping pull"
                )
                # Chains match — nothing to pull. Still need to
                # push if local blocks aren't on remote yet and
                # push index + hash_index for consistency.
                try:
                    existing_indices = (
                        ledger_sync._list_remote_block_indices()
                    )
                except Exception:
                    existing_indices = set()
                try:
                    ledger_sync.push_blocks(
                        all_blocks, existing_indices=existing_indices,
                    )
                except Exception as exc:
                    logger.warning(
                        "SyncOrchestrator: failed to push blocks "
                        "(Tier 1 fast path): %s", exc,
                    )
                try:
                    index_data = self._ledger.index.get_all()
                    if index_data:
                        ledger_sync.push_index(index_data)
                except Exception as exc:
                    logger.warning(
                        "SyncOrchestrator: failed to push index "
                        "(Tier 1 fast path): %s", exc,
                    )
                try:
                    ledger_sync.push_hash_index(all_blocks)
                except Exception as exc:
                    logger.warning(
                        "SyncOrchestrator: failed to push hash "
                        "index (Tier 1 fast path): %s", exc,
                    )
                return

            # ── Tier 2: Compare hash indexes ──────────────────
            comparison = RemoteLedgerSync.compare_hash_indexes(
                local_hashes, remote_hashes
            )
            fork_type = comparison["fork_type"]

            if fork_type == "linear_remote":
                # Remote extends local — pull only new blocks
                fork_idx = comparison["fork_index"]
                remote_len = len(remote_hashes)
                logger.info(
                    "SyncOrchestrator: hash index linear_remote "
                    "at block %d — pulling %d new block(s)",
                    fork_idx,
                    remote_len - fork_idx,
                )
                new_blocks = []
                for idx in range(fork_idx, remote_len):
                    try:
                        block = ledger_sync.pull_block_by_index(idx)
                        if block:
                            new_blocks.append(block)
                    except Exception as exc:
                        logger.warning(
                            "SyncOrchestrator: failed to pull block "
                            "%d: %s", idx, exc,
                        )
                if new_blocks:
                    for block in new_blocks:
                        self._ledger.chain.append(block)
                    logger.info(
                        "SyncOrchestrator: pulled %d block(s) via "
                        "hash index (Tier 2)",
                        len(new_blocks),
                    )
                # Fall through to push phase

            elif fork_type == "linear_local":
                # Local extends remote — nothing to pull
                logger.info(
                    "SyncOrchestrator: hash index linear_local — "
                    "nothing to pull"
                )
                # Fall through to push phase

            elif fork_type == "genesis_mismatch":
                logger.warning(
                    "SyncOrchestrator: hash index genesis_mismatch"
                )
                # Fall through to full pull for divergence handling

            elif fork_type == "divergent":
                logger.warning(
                    "SyncOrchestrator: hash index divergent at "
                    "block %d",
                    comparison.get("fork_index"),
                )
                # Fall through to full pull for divergence handling

        # ═══════════════════════════════════════════════════════
        # Full Pull / Push (original path)
        # ═══════════════════════════════════════════════════════

        # Fetch remote block indices once, share between pull and push.
        try:
            existing_indices = ledger_sync._list_remote_block_indices()
        except Exception:
            existing_indices = set()

        # Pull remote blocks we're missing
        new_blocks = None
        remote_count = 0
        try:
            all_blocks = self._ledger.chain.read_all()
            new_blocks, remote_count = ledger_sync.pull_blocks(
                all_blocks, existing_indices=existing_indices,
            )
            if new_blocks:
                logger.info(
                    "SyncOrchestrator: pulled %d ledger block(s) from remote",
                    len(new_blocks),
                )
                for block in new_blocks:
                    self._ledger.chain.append(block)
        except Exception as exc:
            logger.warning(
                "SyncOrchestrator: failed to pull remote ledger blocks: %s",
                exc,
            )

        # Push local blocks remote is missing
        try:
            all_blocks = self._ledger.chain.read_all()
            local_count = len(all_blocks)

            # ── Same-genesis divergence detection ────────────────────
            # pull_blocks returns (None, remote_count) when chains diverge.
            # Check if it's same-genesis (mergeable) or stale (overwrite).
            if new_blocks is None and remote_count > 0 and local_count > 0:
                genesis_match = self._is_same_genesis(
                    ledger_sync, all_blocks
                )
                if genesis_match:
                    logger.warning(
                        "SyncOrchestrator: chain divergence detected at "
                        "block %d — remote has %d block(s) but shares same "
                        "genesis",
                        local_count,
                        remote_count,
                    )
                    merged = self._try_ledger_merge(
                        ledger_sync, all_blocks
                    )
                    if merged:
                        # Merge succeeded — chain already replaced + pushed.
                        # Update index from merged result and return.
                        return
                    # Merge declined or failed — fall through to stale handling

            # ── Stale-remote handling ─────────────────────────────────
            has_stale_remote = (
                new_blocks is None
                and remote_count > local_count
                and local_count > 0
            )

            if has_stale_remote:
                logger.warning(
                    "SyncOrchestrator: remote has %d stale block(s) from "
                    "an incompatible chain. Overwriting block %d.",
                    remote_count - local_count,
                    local_count - 1,
                )
                overwrite_indices = {local_count - 1}
                pushed = ledger_sync.push_blocks(
                    all_blocks,
                    existing_indices=existing_indices,
                    overwrite_indices=overwrite_indices,
                )
                if pushed:
                    logger.info(
                        "SyncOrchestrator: pushed block %d (overwrote stale)",
                        local_count - 1,
                    )
            else:
                pushed = ledger_sync.push_blocks(
                    all_blocks, existing_indices=existing_indices,
                )
                if pushed:
                    logger.info(
                        "SyncOrchestrator: pushed %d ledger block(s) to remote",
                        pushed,
                    )
        except Exception as exc:
            logger.warning(
                "SyncOrchestrator: failed to push local ledger blocks: %s",
                exc,
            )

        # Push index
        try:
            index_data = self._ledger.index.get_all()
            if index_data:
                ledger_sync.push_index(index_data)
        except Exception as exc:
            logger.warning(
                "SyncOrchestrator: failed to push index to remote: %s",
                exc,
            )

        # Push hash index
        try:
            all_blocks = self._ledger.chain.read_all()
            if all_blocks:
                ledger_sync.push_hash_index(all_blocks)
        except Exception as exc:
            logger.warning(
                "SyncOrchestrator: failed to push hash index to remote: %s",
                exc,
            )

    # ── Merge helpers ────────────────────────────────────────────

    def _deduplicate_from_remote_ledger(self):
        """Remove local staging entries already committed in the remote ledger.

        Pulls remote ledger blocks and checks if any local staging entries
        (by title + date match) exist as committed entries in the remote
        ledger. If so, removes them from local staging to prevent duplicate
        commits in cross-platform workflows.

        This is a non-fatal best-effort operation. If the remote is
        unreachable or ledger blocks can't be parsed, staging is left
        unchanged.
        """
        if self._transport is None or self._master_key is None:
            return

        try:
            from domain.ledger.remote_sync import RemoteLedgerSync
            ledger_sync = RemoteLedgerSync(self._transport, self._master_key)

            # Pull remote blocks (use hash index fast path if available)
            hi = ledger_sync.pull_hash_index()
            existing_indices = set()

            # Determine which block indices to pull
            if hi and isinstance(hi, list) and len(hi) > 0:
                # Pull all blocks listed in hash index
                max_idx = len(hi) - 1
                for i in range(max_idx + 1):
                    existing_indices.add(i)
            else:
                # Fall back to listing
                try:
                    existing_indices = ledger_sync._list_remote_block_indices()
                except Exception:
                    pass

            if not existing_indices:
                return

            # Collect all committed entry titles + dates from remote ledger
            remote_titles = set()  # {(date, title), ...}
            for idx in sorted(existing_indices):
                try:
                    block = ledger_sync.pull_block_by_index(idx)
                    if not block:
                        continue
                    block_type = block.get("type", "day")
                    if block_type != "day":
                        continue
                    date_str = block.get("date", "")
                    for entry in block.get("entries", []):
                        data = entry.get("data", {})
                        title = data.get("title", "")
                        if title and date_str:
                            remote_titles.add((date_str, title))
                except Exception:
                    continue  # Skip unparseable blocks

            if not remote_titles:
                return

            # Find local staging entries matching remote committed entries
            staging = self._staging._local._store.read_entries()
            indices_to_remove = []
            for entry in staging:
                data = entry.get("data", {})
                title = data.get("title", "")
                if not title:
                    continue
                # Decode start_epoch to get date
                start_val = data.get("startTime_enc", "")
                entry_date = ""
                if isinstance(start_val, str) and start_val.startswith("plain:"):
                    try:
                        start_epoch = int(start_val[6:])
                        entry_date = time.strftime(
                            "%Y-%m-%d", time.gmtime(start_epoch // 1000)
                        )
                    except Exception:
                        continue

                if (entry_date, title) in remote_titles:
                    indices_to_remove.append(entry.get("entry_index"))

            if indices_to_remove:
                logger.info(
                    "SyncOrchestrator: removing %d staging entries already "
                    "committed remotely: %s",
                    len(indices_to_remove),
                    indices_to_remove,
                )
                self._staging.remove_synced(indices_to_remove)
        except Exception as exc:
            logger.warning(
                "SyncOrchestrator: remote ledger deduplication failed: %s",
                exc,
            )

    def _is_same_genesis(
        self,
        ledger_sync: "RemoteLedgerSync",
        local_blocks: List[Dict[str, Any]],
    ) -> bool:
        """Check if remote chain shares the same genesis block as local.

        Pulls remote block 0 and compares hashes.
        Returns False if remote genesis is unavailable or hashes differ.
        """
        from domain.ledger.remote_sync import RemoteLedgerSync

        if not local_blocks:
            return False
        try:
            remote_genesis = ledger_sync.pull_block_by_index(0)
        except Exception:
            return False
        if remote_genesis is None:
            return False

        local_hash = get_block_hash(local_blocks[0])
        remote_hash = get_block_hash(remote_genesis)
        return local_hash == remote_hash

    def _try_ledger_merge(
        self,
        ledger_sync: "RemoteLedgerSync",
        local_blocks: List[Dict[str, Any]],
    ) -> bool:
        """Attempt same-genesis merge between local and remote chains.

        1. Show interactive prompt (if ViewInterface available)
        2. Pull full remote chain
        3. Call LedgerMerge.merge()
        4. Replace local chain and index with merged result
        5. Force-push merged chain to remote
        6. Notify view

        Returns True if merge succeeded, False if declined, cancelled, or failed.
        """
        from domain.ledger.merge import LedgerMerge

        # ── Interactive confirmation ──────────────────────────────
        if self._view is None:
            # Headless/auto mode — skip merge, keep local chain
            logger.info(
                "SyncOrchestrator: same-genesis divergence detected "
                "but no view — skipping merge"
            )
            return False

        remote_count = len(
            ledger_sync._list_remote_block_indices()
        )
        self._view.render_warning(
            f"Chain divergence detected: local has {len(local_blocks)} "
            f"block(s), remote has {remote_count} block(s). Both share "
            f"the same genesis."
        )
        choice = self._view.prompt_choice(
            "\n[M]erge chains (combine entries from both), "
            "[S]kip (keep local, overwrite remote later), "
            "[C]ancel sync? ",
            ("M", "S", "C"),
            help_items={
                "M": "Merge both chains — entries from both devices "
                     "are combined, deduplicated, and sorted. The merged "
                     "result replaces both local and remote chains.",
                "S": "Skip — keep the local chain as-is. Remote blocks "
                     "will be overwritten on the next sync push.",
                "C": "Cancel — stop sync now, leave both chains unchanged.",
            },
        )
        if choice == "C":
            logger.info("SyncOrchestrator: merge cancelled by user")
            return False
        if choice == "S":
            logger.info(
                "SyncOrchestrator: merge skipped — keeping local chain"
            )
            return False
        # choice == "M" — continue to merge

        # ── Pull full remote chain ────────────────────────────────
        try:
            remote_blocks = ledger_sync.pull_full_chain()
        except Exception as exc:
            logger.error(
                "SyncOrchestrator: failed to pull full remote chain: %s",
                exc,
            )
            if self._view is not None:
                self._view.render_error(
                    f"Failed to pull remote chain: {exc}"
                )
            return False

        if not remote_blocks:
            logger.warning(
                "SyncOrchestrator: no remote blocks to merge"
            )
            return False

        # ── Run merge ─────────────────────────────────────────────
        crypto = getattr(self._ledger, "crypto", None)
        if crypto is None:
            logger.error(
                "SyncOrchestrator: cannot merge — no crypto manager "
                "available"
            )
            return False

        # idsecret as hex string (merge.py expects Optional[str])
        identity_secret_bytes = getattr(
            self._ledger, "identity_secret", None
        )
        identity_secret_hex = (
            identity_secret_bytes.hex() if identity_secret_bytes else None
        )
        master_key_hex = self._master_key.hex()

        try:
            result = asyncio.run(
                LedgerMerge.merge(
                    local_chain=list(local_blocks),
                    remote_chain=remote_blocks,
                    crypto=crypto,
                    master_key=master_key_hex,
                    identity_secret=identity_secret_hex,
                )
            )
        except Exception as exc:
            logger.error(
                "SyncOrchestrator: LedgerMerge.merge() failed: %s",
                exc,
            )
            if self._view is not None:
                self._view.render_error(
                    f"Chain merge failed: {exc}"
                )
            return False

        merged_chain = result.get("mergedChain", [])
        merged_index = result.get("index", {})
        stats = result.get("stats", {})

        if not merged_chain:
            logger.error(
                "SyncOrchestrator: merge returned empty chain"
            )
            return False

        # ── Replace local chain ───────────────────────────────────
        # Truncate to genesis only (block 0). The merged chain shares
        # the same genesis so we keep it, then append merged blocks.
        chain = self._ledger.chain
        total = len(chain.read_all())
        if total > 1:
            chain.truncate(total - 1)  # Keep genesis only

        # Append merged blocks (skip genesis — already present)
        for block in merged_chain[1:]:
            chain.append(block)

        # ── Replace index ─────────────────────────────────────────
        index = self._ledger.index
        index.clear()
        for date_str, titles in merged_index.items():
            for title, duration_ms in titles.items():
                index.update(date_str, title, duration_ms)

        # ── Force-push merged chain to remote ─────────────────────
        try:
            all_merged = chain.read_all()
            pushed = ledger_sync.push_blocks(all_merged, force=True)
            logger.info(
                "SyncOrchestrator: force-pushed %d merged block(s) to remote",
                pushed,
            )
        except Exception as exc:
            logger.warning(
                "SyncOrchestrator: failed to push merged chain: %s",
                exc,
            )

        # Push merged index
        try:
            index_data = index.get_all()
            if index_data:
                ledger_sync.push_index(index_data)
        except Exception as exc:
            logger.warning(
                "SyncOrchestrator: failed to push merged index: %s",
                exc,
            )

        # Push merged hash index
        try:
            all_merged = chain.read_all()
            if all_merged:
                ledger_sync.push_hash_index(all_merged)
        except Exception as exc:
            logger.warning(
                "SyncOrchestrator: failed to push merged hash index: %s",
                exc,
            )

        # ── Notify ────────────────────────────────────────────────
        msg = (
            f"Chains merged: {stats.get('mergedEntries', '?')} entries "
            f"in {len(merged_chain)} blocks "
            f"(fork at block {stats.get('forkIndex', '?')}, "
            f"{stats.get('duplicatesSkipped', 0)} duplicates skipped)"
        )
        logger.info("SyncOrchestrator: %s", msg)
        if self._view is not None:
            self._view.render_success(msg)
            self._view.notify(msg)

        return True

    # ------------------------------------------------------------------
    # Revert flow
    # ------------------------------------------------------------------

    def revert(self, count: int) -> bool:
        """Revert *count* day blocks from the ledger.

        Restores reverted entries back into staging and pushes the
        updated state to remote.

        Args:
            count: Number of day blocks to revert. 0 is a no-op.

        Returns:
            True if revert succeeded, False otherwise.
        """
        if count <= 0:
            return True

        revert_result = self._ledger.revert(count)

        # LedgerEngine.revert() returns int (number of entries restored).
        # Mock/legacy callers may return (success, entries, result) tuple.
        # Handle both.
        entries_restored: int
        if isinstance(revert_result, tuple):
            success, restored_entries, _ = revert_result
            if not success:
                logger.error(
                    "SyncOrchestrator: revert failed (tuple %s)",
                    revert_result,
                )
                return False
            entries_restored = len(restored_entries)
            # Restore entries to staging if they came back as raw entries
            if restored_entries:
                self._staging._local.write_entries(restored_entries)
        elif revert_result is None or revert_result < 0:
            logger.error(
                "SyncOrchestrator: revert failed (returned %s)",
                revert_result,
            )
            return False
        else:
            entries_restored = revert_result

        if entries_restored > 0:
            logger.info(
                "SyncOrchestrator: reverted %d day blocks, "
                "%d entries restored to staging",
                count,
                entries_restored,
            )
        else:
            logger.info(
                "SyncOrchestrator: reverted %d day blocks, no entries restored",
                count,
            )

        # Push updated state to remote if master_key is set
        if self._master_key is not None:
            self._staging.push_to_remote(self._master_key)

        return True

    # ------------------------------------------------------------------
    # Status queries
    # ------------------------------------------------------------------

    def check_integrity(self, full: bool = False) -> bool:
        """Check ledger chain integrity.

        Args:
            full: If True, perform deep content hash check.

        Returns:
            True if chain is intact, False otherwise.
        """
        return self._ledger.verify(full_check=full)

    def get_status(self) -> Dict[str, Any]:
        """Get a summary of current state.

        Returns:
            Dict with keys: block_count, pending_entries, staging_count.
        """
        staging_count = len(self._staging.get_entries())
        pending = self._staging.get_pending_sync()
        block_count = self._ledger.get_block_count()

        return {
            "block_count": block_count,
            "pending_entries": pending,
            "staging_count": staging_count,
        }
