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

from typing import Optional
from abc import ABC, abstractmethod


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
