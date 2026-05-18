"""GitStagingTransport — push/pull staging blobs via git CLI.

Concrete implementation of ``AbstractStagingTransport`` that shells out to
the system ``git`` command. Assumes the user already has SSH credentials
configured for the remote.

Lifecycle:
  1. First pull/push: ``git clone <remote_url> <local_clone_path>``
  2. Subsequent: ``git pull`` / ``git add`` + ``git commit`` + ``git push``
  3. If local clone is corrupted: delete and re-clone

Push conflict handling (non-fast-forward rejection):
  - Detect rejection from ``git push`` exit code
  - ``git pull --rebase`` to integrate remote changes
  - Retry the push once

Contract:
  - ``pull(path) -> bytes | None``: Fetch blob at path, None if absent.
  - ``push(path, data: bytes) -> None``: Write blob, commit, push.
  - Both methods are synchronous.
"""

import os
import shutil
import subprocess
import logging
from pathlib import Path
from typing import Optional

from core.sync.transport import AbstractStagingTransport

logger = logging.getLogger(__name__)


class GitStagingTransport(AbstractStagingTransport):
    """Push/pull staging blob via git CLI.

    Attributes:
        _remote_url: Git remote URL (SSH or HTTPS).
        _clone_path: Local filesystem path where the working copy lives.
    """

    def __init__(self, remote_url: str, clone_path: str):
        """Initialize with remote URL and local clone path.

        Args:
            remote_url: Git remote URL (e.g., ``git@github.com:user/repo.git``,
                       ``ssh://user@host/path``, ``/path/to/bare/repo``).
            clone_path: Local directory for the persistent working copy
                       (e.g., ``~/.local/share/phpoc/remote/``).
        """
        self._remote_url = remote_url
        self._clone_path = Path(clone_path)

    # ------------------------------------------------------------------
    # Public interface (AbstractStagingTransport)
    # ------------------------------------------------------------------

    def pull(self, path: str) -> Optional[bytes]:
        """Fetch staging blob from remote.

        Ensures the local clone is up-to-date, then reads the blob file.

        Args:
            path: Relative path within the repo (e.g., ``staging/blobs/current.json``).

        Returns:
            Blob bytes, or None if the file doesn't exist in the repo.
        """
        self._ensure_clone()

        # Pull latest from remote (skip if remote has no refs yet — empty repo)
        if self._clone_exists():
            remote_refs = self._git("ls-remote", "origin", "--heads")
            if remote_refs.strip():
                self._git("pull", "--rebase")

        blob_file = self._clone_path / path
        if blob_file.is_file():
            return blob_file.read_bytes()
        return None

    def push(self, path: str, data: bytes) -> None:
        """Write blob, commit, and push to remote.

        On non-fast-forward rejection: pull latest, rewrite, retry push.

        Args:
            path: Relative path within the repo.
            data: Blob bytes to write.

        Raises:
            RuntimeError: If push fails after retry.
        """
        self._ensure_clone()

        # Ensure parent directory exists
        blob_file = self._clone_path / path
        blob_file.parent.mkdir(parents=True, exist_ok=True)

        # Write blob
        blob_file.write_bytes(data)

        # Stage and commit
        self._git("add", str(blob_file.relative_to(self._clone_path)))
        self._git("commit", "-m", f"Update staging blob [{path}]")

        # Push with retry on non-fast-forward
        try:
            self._git("push")
        except RuntimeError:
            # Push rejected — likely non-fast-forward. Pull latest and retry.
            logger.info("Git push rejected, pulling latest and retrying...")
            self._git("pull", "--rebase")
            # Re-write after rebase (our blob may have been overwritten)
            blob_file.write_bytes(data)
            self._git("add", str(blob_file.relative_to(self._clone_path)))
            self._git("commit", "-m", f"Update staging blob [{path}] (retry)")
            try:
                self._git("push")
            except RuntimeError as exc:
                raise RuntimeError(
                    f"Git push failed after retry for {self._remote_url}: {exc}"
                ) from exc

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_clone(self):
        """Clone the remote if local working copy doesn't exist yet."""
        if not self._clone_exists():
            logger.info("Cloning remote repo %s -> %s", self._remote_url, self._clone_path)
            self._clone_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                self._git("clone", self._remote_url, str(self._clone_path))
            except RuntimeError as exc:
                err_msg = str(exc)
                # Check if the remote exists but is empty (no refs yet) by
                # looking for "remote: warning" + "fatal: couldn't find remote ref"
                # or similar empty-repo indicators from git ls-remote.
                is_empty_remote = any(indicator in err_msg for indicator in [
                    "couldn't find remote ref",
                    "does not appear to be a git repository",
                    "Repository not found",
                    "remote: warning: You appear to have cloned an empty repository",
                    "fatal: remote error",
                ])
                if is_empty_remote:
                    logger.info("Remote appears empty, initializing local repo")
                    self._clone_path.mkdir(parents=True, exist_ok=True)
                    self._git("init")
                    self._git("remote", "add", "origin", self._remote_url)
                else:
                    # Genuine auth/network/ssh error — don't silently create local repo
                    logger.error("Clone failed: %s", err_msg)
                    raise

    def _clone_exists(self) -> bool:
        """Check if local clone is present and looks like a git repo."""
        return (self._clone_path / ".git").is_dir()

    def _git(self, *args: str) -> str:
        """Run a git command in the clone directory.

        Args:
            *args: Git subcommand and arguments (e.g., ``"pull", "--rebase"``).

        Returns:
            Combined stdout+stderr output.

        Raises:
            RuntimeError: If git exits with non-zero status.
        """
        cmd = ["git"] + list(args)
        logger.debug("Running: %s", " ".join(cmd))
        env = os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"  # Never prompt for credentials — fail fast
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
                cwd=str(self._clone_path) if self._clone_exists() else None,
                env=env,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Git command timed out: {' '.join(cmd)}")
        except FileNotFoundError:
            raise RuntimeError("Git is not installed or not in PATH")

        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise RuntimeError(
                f"Git command failed (exit {result.returncode}): "
                f"{' '.join(cmd)}\n{stderr}"
            )

        return (result.stdout + result.stderr).strip()

    def update_remote_url(self, new_url: str):
        """Change the remote URL for an existing clone.

        Useful when the user updates ``remote.git_remote_url`` in config.

        Args:
            new_url: New remote URL.
        """
        self._remote_url = new_url
        if self._clone_exists():
            self._git("remote", "set-url", "origin", new_url)
