"""SyncDecision — consolidated sync decision engine for phpoc.

This module is the SINGLE source of truth for SyncDecision and SyncStrategy.
All other modules (cli/strategies.py, core/sync_confirmation.py) should
import from here.

Moved from:
  - core/sync_confirmation.py (dataclass-based SyncDecision)
  - cli/strategies.py (hand-rolled SyncDecision + SyncStrategy base)
"""

from typing import List, Dict, Any, Set
from abc import ABC, abstractmethod

from domain.interfaces.view import ViewInterface


class SyncDecision:
    """The result of a sync confirmation strategy.

    Describes which entries to sync, which to remove, and any overrides
    (end time, comment) to apply before committing to the ledger.

    Attributes:
        selected_indices: List of entry_index values to sync.
        removal_indices: Set of entry_index values to remove from staging.
        overrides: Dict mapping entry_index -> {end_epoch, comment, media, ...}.
        cancelled: If True, the entire sync operation was cancelled.
    """

    def __init__(
        self,
        selected_indices: List[int] = None,
        removal_indices: Set[int] = None,
        overrides: Dict[int, Dict[str, Any]] = None,
        cancelled: bool = False,
    ):
        self.selected_indices = selected_indices or []
        self.removal_indices = removal_indices or set()
        self.overrides = overrides or {}
        self.cancelled = cancelled

    @property
    def has_selection(self) -> bool:
        return bool(self.selected_indices) and not self.cancelled

    @property
    def has_removals(self) -> bool:
        return bool(self.removal_indices) and not self.cancelled

    def __eq__(self, other):
        if not isinstance(other, SyncDecision):
            return NotImplemented
        return (
            self.selected_indices == other.selected_indices
            and self.removal_indices == other.removal_indices
            and self.overrides == other.overrides
            and self.cancelled == other.cancelled
        )

    def __repr__(self):
        return (
            f"SyncDecision(selected_indices={self.selected_indices}, "
            f"removal_indices={self.removal_indices}, "
            f"overrides={self.overrides}, "
            f"cancelled={self.cancelled})"
        )


class SyncStrategy(ABC):
    """Abstract base for sync confirmation strategies.

    A strategy receives the pending entries and returns a SyncDecision.
    """

    @abstractmethod
    def decide(
        self,
        pending: List[Dict[str, Any]],
        view: ViewInterface = None,
    ) -> SyncDecision:
        """Examine pending entries and return what to sync.

        Args:
            pending: List of preview dicts from StagingService.get_pending_sync().
                     Each has: entry_index, title, start_epoch, end_epoch,
                     duration, tags, date, comment, media.
            view: Optional ViewInterface for displaying/interacting.

        Returns:
            A SyncDecision describing which entries to sync and any overrides.
        """
        ...
