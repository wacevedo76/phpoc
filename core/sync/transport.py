"""AbstractStagingTransport — transport interface for remote staging/blob sync.

Contract:
  - pull(path) -> bytes | None: Fetch blob at path, return None if absent.
  - push(path, data: bytes) -> None: Write blob at path.
  - Both methods are synchronous. Callers apply timeouts externally
    (e.g., via RemoteStagingSync.check_remote_available()).

Optionally:
  - list_files(prefix) -> List[str]: List file names under prefix.
    Default returns empty list (for transports that don't support listing).
"""

import logging
from typing import Optional, Dict, Any
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


class AbstractStagingTransport(ABC):
    """Transport interface for remote staging/blob sync.

    Implementations: GitStagingTransport, InMemoryStagingTransport (for tests).
    """

    @abstractmethod
    def pull(self, path: str) -> Optional[bytes]:
        """Fetch blob at *path* from remote.

        Args:
            path: Remote path to the staging blob.

        Returns:
            Blob bytes, or None if no blob exists at path.
        """
        ...

    @abstractmethod
    def push(self, path: str, data: bytes) -> None:
        """Write blob *data* to remote at *path*.

        Args:
            path: Remote path for the staging blob.
            data: Blob bytes to write.
        """
        ...

    def list_files(self, prefix: str) -> list:
        """List file names under a prefix on the remote.

        Default implementation returns an empty list. Transports that
        support listing (e.g., git ls-tree) should override this.

        Args:
            prefix: Remote directory prefix (e.g., ``ledger/blocks/``).

        Returns:
            List of filenames (basenames only) under the prefix.
        """
        return []

    def delete(self, path: str) -> None:
        """Delete a blob at *path* from remote.

        Default implementation is a no-op. Transports that support
        deletion (HTTP DELETE, git rm, etc.) should override this.

        Args:
            path: Remote path to delete.
        """
        pass


def create_transport_from_config(config: Dict[str, Any]) -> Optional[AbstractStagingTransport]:
    """Create a transport based on config settings (delegates to registry).

    Priority:
      1. ``http.base_url`` set + ``remote.transport == "http"`` → ``HttpStagingTransport``
      2. ``remote.git_remote_url`` set → ``GitStagingTransport``
      3. Neither set → ``None`` (no remote transport)

    This function delegates to ``core.sync.transport_registry.create_transport_from_config``
    so that custom registered providers are respected.

    Args:
        config: Application config dict (from ``ConfigManager``).

    Returns:
        An ``AbstractStagingTransport`` instance, or ``None`` if no remote
        transport is configured.
    """
    from core.sync.transport_registry import create_transport_from_config as _from_registry
    return _from_registry(config)
