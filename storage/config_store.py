"""Abstract interface for configuration storage.

Config is a user-editable JSON file storing remote paths,
auth timeouts, device identity, and other settings.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional


class AbstractConfigStore(ABC):
    """Storage for user-editable configuration.

    The config is a flat or nested JSON dict. All fields
    have defaults if missing.
    """

    @abstractmethod
    def read_config(self) -> Optional[Dict[str, Any]]:
        """Read the configuration.

        Returns:
            Config dict, or None if the config does not exist yet.
        """
        pass

    @abstractmethod
    def write_config(self, data: Dict[str, Any]):
        """Persist the configuration.

        Args:
            data: Full config dict to persist.
        """
        pass
