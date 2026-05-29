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
from typing import Optional, List, Dict, Any

from domain.staging.service import StagingService
from domain.staging.remote_sync import SyncCheckResult
from domain.ledger.engine import LedgerEngine
from domain.interfaces.view import ViewInterface
from core.sync.transport import AbstractStagingTransport
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
                logger.info("SyncOrchestrator: no entries selected after confirmation")
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

        Handles stale-remote recovery:
          If the remote has blocks from an incompatible chain (e.g. after
          ``ph recover`` force-pushed a shorter chain, leaving old blocks
          from another device at higher indices), pull_blocks detects the
          divergence and returns nothing. This method then force-pushes the
          local chain to overwrite stale indices and purges the remaining
          stale blocks with empty placeholders.
        """
        if self._transport is None or self._master_key is None:
            return

        from domain.ledger.remote_sync import RemoteLedgerSync

        ledger_sync = RemoteLedgerSync(self._transport, self._master_key)

        # Fetch remote block indices once, share between pull and push.
        # This avoids two redundant list_files() HTTP calls.
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

            # Check for stale remote blocks (from an incompatible chain)
            has_stale_remote = (
                new_blocks is None
                and remote_count > local_count
                and local_count > 0
            )

            if has_stale_remote:
                # Remote has stale blocks from an incompatible chain.
                # The last local block (index N-1) exists on remote as stale
                # content from a different chain. Overwrite just that one
                # block to keep remote consistent. Blocks >= N (from the
                # other device) remain on remote but are ignored by pull
                # (divergence detection skips them).
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
                # Normal path: push only blocks remote doesn't have
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
