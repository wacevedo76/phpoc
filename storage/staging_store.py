"""Abstract interface for staging entry storage.

A staging store manages the mutable list of pending (unsynced) entries.
Local implementation: JSON file on disk.
Future: in-memory, remote-backed, or database-backed.
"""

from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional


class AbstractStagingStore(ABC):
    """Storage for mutable staging entries.

    The staging store is a simple list of dicts, each representing one
    staged activity entry. Entries can be appended, removed, or updated
    by index. The entire list can be read or written (for atomic swaps).
    """

    @abstractmethod
    def read_entries(self) -> List[Dict[str, Any]]:
        """Read all staged entries.

        Returns:
            List of entry dicts. Never None — returns empty list if empty.
        """
        pass

    @abstractmethod
    def write_entries(self, data: List[Dict[str, Any]]):
        """Overwrite all staged entries atomically.

        Args:
            data: Full list of entry dicts to persist.
        """
        pass

    @abstractmethod
    def append_entry(self, entry: Dict[str, Any]):
        """Append a single entry to the end of the staging list.

        Args:
            entry: The entry dict to append.
        """
        pass

    @abstractmethod
    def remove_entries(self, indices: List[int]):
        """Remove entries by their index in the list.

        Implementations MUST process indices in descending order
        to avoid index-shifting issues.

        Args:
            indices: List of 0-based indices to remove.
        """
        pass

    @abstractmethod
    def update_entry(self, index: int, fields: Dict[str, Any]):
        """Update specific fields on an entry at the given index.

        Args:
            index: 0-based index of the entry to update.
            fields: Dict of field names and new values to merge.
        """
        pass
