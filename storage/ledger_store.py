"""Abstract interface for ledger block storage.

The ledger is an append-only JSON array of blocks. Only the tail
is mutable (for revert). Supports partial reads for incremental
remote sync.
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional


class AbstractLedgerStore(ABC):
    """Storage for the append-only ledger chain.

    The chain is a JSON array of blocks. Each block has a type
    discriminator and a prev_hash linking it to the previous block.
    """

    @abstractmethod
    def read_blocks(self, start: int = 0, end: Optional[int] = None) -> List[Dict[str, Any]]:
        """Read a range of blocks from the chain.

        Args:
            start: Starting index (0-based). Negative values count from end.
            end: Ending index (exclusive). None = read to end.

        Returns:
            List of block dicts in the requested range.
        """
        pass

    @abstractmethod
    def append_blocks(self, blocks: List[Dict[str, Any]]):
        """Append one or more blocks to the end of the chain.

        Args:
            blocks: List of block dicts to append (in order).
        """
        pass

    @abstractmethod
    def truncate(self, keep_count: int) -> List[Dict[str, Any]]:
        """Truncate chain to keep_count blocks.

        Removes blocks from the end (most recent first).
        Returns the removed blocks so callers can inspect/revert.

        Args:
            keep_count: Number of blocks to keep (from start).

        Returns:
            List of removed block dicts (in removal order).
        """
        pass

    @abstractmethod
    def get_block_count(self) -> int:
        """Total number of blocks in the chain.

        Returns:
            Integer count. 0 if chain is empty.
        """
        pass

    @abstractmethod
    def get_last_block(self) -> Optional[Dict[str, Any]]:
        """Get the most recent block without loading the full chain.

        Returns:
            The last block dict, or None if chain is empty.
        """
        pass
