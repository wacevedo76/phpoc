"""Abstract interface for identity storage.

The identity store caches the user's identity data (username, email,
recovery seed, identity secret) locally. This is a convenience cache —
the genesis block is the canonical source of identity.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional


class AbstractIdentityStore(ABC):
    """Storage for identity data.

    Read once per session. If the store is empty, the caller
    falls back to the genesis block.
    """

    @abstractmethod
    def read_identity(self) -> Optional[Dict[str, Any]]:
        """Read stored identity data.

        Returns:
            Identity dict, or None if not yet stored.
        """
        pass

    @abstractmethod
    def write_identity(self, data: Dict[str, Any]):
        """Persist identity data.

        Args:
            data: Identity dict to store.
        """
        pass
