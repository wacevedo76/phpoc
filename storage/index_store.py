"""Abstract interface for blind index storage.

The blind index is a simple key-value cache mapping dates to
title-to-duration maps. It is derived from the ledger chain
and can be fully rebuilt if lost or corrupted.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any


class AbstractIndexStore(ABC):
    """Storage for the blind index — a flat dict of date -> {title: total_ms}.

    Example structure:
      {"2026-01-15": {"guitar": 3600000, "reading": 1800000}}
    """

    @abstractmethod
    def read_index(self) -> Dict[str, Any]:
        """Read the full blind index.

        Returns:
            Dict of date strings to activity dicts. Never None.
            Returns empty dict if index does not exist.
        """
        pass

    @abstractmethod
    def write_index(self, data: Dict[str, Any]):
        """Overwrite the blind index atomically.

        Args:
            data: Full index dict to persist.
        """
        pass
