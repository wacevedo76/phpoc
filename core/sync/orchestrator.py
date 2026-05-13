"""SyncOrchestrator — coordinates staging sync into the ledger.

Full sync lifecycle:
  1. check_and_sync() — pull remote, merge into local staging
  2. get_pending_sync() — gather completed entries ready for ledger
  3. (optional) run SyncStrategy — user confirmation with overrides
  4. ledger_engine.commit(entries) — write to the chain
  5. ledger_engine.verify() — integrity check after commit
  6. staging_service.remove_synced(indices) — clean up staging
  7. staging_service.push_to_remote() — push merged state to remote
  8. view.notify() — signal completion to the frontend

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

logger = logging.getLogger(__name__)


class SyncOrchestrator:
    """Coordinates StagingService and LedgerEngine into a sync pipeline.

    Attributes:
        _staging: StagingService for CRUD and remote sync.
        _ledger: LedgerEngine for chain commit/verify/revert.
        _view: Optional ViewInterface for notifications.
        _master_key: Master key for device identity and push auth.
    """

    def __init__(
        self,
        staging_service: StagingService,
        ledger_engine: LedgerEngine,
        view_interface: ViewInterface = None,
        master_key: bytes = None,
    ):
        self._staging = staging_service
        self._ledger = ledger_engine
        self._view = view_interface
        self._master_key = master_key
        self._identity_secret: Optional[bytes] = None

    # ------------------------------------------------------------------
    # Main sync flow
    # ------------------------------------------------------------------

    def sync(self) -> bool:
        """Run the full sync pipeline.

        1. check_and_sync() — pull remote, merge local
        2. Get pending (completed) entries from staging
        3. Commit to ledger
        4. Verify chain integrity
        5. If verify OK: remove synced from staging, push to remote
        6. If verify fails: revert the commit

        Returns:
            True on success, False if verify fails (commit reverted).

        Raises:
            ValueError: If no master_key is set (required for push).
        """
        # Step 1: check remote and merge
        check_result = self._staging.check_and_sync(timeout_ms=500)

        # Step 2: get pending entries
        pending = self._staging.get_pending_sync()
        if not pending:
            logger.info("SyncOrchestrator: no pending entries to sync")
            return True

        # Step 3: commit to ledger
        logger.info(
            "SyncOrchestrator: committing %d entries to ledger",
            len(pending),
        )
        commit_result = self._ledger.commit(pending)

        if commit_result is None:
            logger.warning("SyncOrchestrator: commit returned None")
            return False

        # Step 4: verify chain integrity
        if not self._ledger.verify():
            logger.error("SyncOrchestrator: ledger verify failed — reverting")
            self._ledger.revert(1)
            return False

        # Step 5: remove synced entries from staging
        indices_to_remove = [e["entry_index"] for e in pending]
        self._staging.remove_synced(indices_to_remove)

        # Step 6: push to remote if master_key is set
        if self._master_key is not None:
            self._staging.push_to_remote(self._master_key)

        # Step 7: notify view
        if self._view is not None:
            self._view.notify(
                f"Synced {len(pending)} entries to ledger"
            )

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
