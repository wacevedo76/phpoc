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


def create_transport_from_config(config: Dict[str, Any]) -> Optional[AbstractStagingTransport]:
    """Create a transport based on config settings.

    Priority:
      1. ``http.base_url`` set + ``remote.transport == "http"`` → ``HttpStagingTransport``
      2. ``remote.git_remote_url`` set → ``GitStagingTransport``
      3. Neither set → ``None`` (no remote transport)

    Args:
        config: Application config dict (from ``ConfigManager``).

    Returns:
        An ``AbstractStagingTransport`` instance, or ``None`` if no remote
        transport is configured.
    """
    transport_type = config.get("remote", {}).get("transport", "git")
    config_dir = config.get("_config_dir", None)

    # HTTP transport takes priority when explicitly configured
    if transport_type == "http":
        base_url = config.get("http", {}).get("base_url")
        if not base_url:
            logger.warning("transport=http but http.base_url is not set")
            return None
        api_key = config.get("http", {}).get("api_key")
        from core.sync.http_transport import HttpStagingTransport
        logger.info("Using HttpStagingTransport -> %s", base_url)
        return HttpStagingTransport(base_url=base_url, api_key=api_key)

    # Fall back to git transport
    remote_url = config.get("remote", {}).get("git_remote_url")
    if not remote_url:
        return None

    from pathlib import Path
    clone_path = config_dir
    if clone_path is None:
        clone_path = Path.home() / ".local" / "share" / "phpoc" / "remote"
    else:
        clone_path = Path(config_dir) / "remote"

    from core.sync.git_transport import GitStagingTransport
    logger.info("Using GitStagingTransport -> %s", remote_url)
    return GitStagingTransport(remote_url, str(clone_path))
