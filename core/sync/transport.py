"""AbstractStagingTransport — 2-method interface for remote staging transport.

The transport is a minimal abstraction over the actual transfer mechanism
(e.g., git, HTTP, local file copy, in-memory mock). Every implementation
must provide pull(path) and push(path, data).

Contract:
  - pull(path) -> bytes | None: Fetch blob at path, return None if absent.
  - push(path, data: bytes) -> None: Write blob at path.
  - Both methods are synchronous. Callers apply timeouts externally
    (e.g., via RemoteStagingSync.check_remote_available()).
"""

from typing import Optional
from abc import ABC, abstractmethod


class AbstractStagingTransport(ABC):
    """Two-method interface for remote staging blob transport.

    Implementations: GitStagingTransport, HttpStagingTransport,
    InMemoryStagingTransport (for tests), etc.
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
