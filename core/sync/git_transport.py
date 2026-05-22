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
from cli.trace import trace

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
        self._ensure_remote_url()

        # Recover from any stuck rebase before proceeding
        self._recover_git_abort_stuck_rebase()

        # Pull latest from remote (skip if remote has no refs yet — empty repo)
        if self._has_remote_refs():
            self._ensure_on_branch()
            try:
                self._git("pull", "--rebase", "--autostash")
            except RuntimeError:
                # Pull may fail on empty remote or disconnected — proceed without it
                pass

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
        self._ensure_remote_url()

        # Ensure parent directory exists
        blob_file = self._clone_path / path
        blob_file.parent.mkdir(parents=True, exist_ok=True)

        # Pull latest from remote FIRST to minimize conflicts
        # (remote may have been updated by another device)
        self._recover_git_abort_stuck_rebase()
        if self._has_remote_refs():
            self._ensure_on_branch()
            try:
                self._git("pull", "--rebase", "--autostash")
            except RuntimeError:
                pass  # Proceed even if pull fails

        # Write, stage, commit
        blob_file.write_bytes(data)
        self._git("add", str(blob_file.relative_to(self._clone_path)))
        self._git("commit", "-m", f"Update staging blob [{path}]")

        # Push with retry on non-fast-forward
        try:
            self._push_or_detached_refspec()
        except RuntimeError as first_err:
            err_msg = str(first_err)
            # Only retry if the failure looks like a non-fast-forward rejection.
            # Auth errors (permission denied, publickey) should fail immediately.
            if "rejected" in err_msg or "non-fast-forward" in err_msg:
                logger.info("Push rejected (non-fast-forward), pulling latest and retrying...")
                self._recover_git_abort_stuck_rebase()
                try:
                    self._git("pull", "--rebase", "--autostash")
                except RuntimeError:
                    pass
                # Ensure we're on a branch before committing
                self._ensure_on_branch()
                # Re-write after rebase (our blob may have been overwritten)
                blob_file.write_bytes(data)
                self._git("add", str(blob_file.relative_to(self._clone_path)))
                try:
                    self._git("commit", "-m", f"Update staging blob [{path}] (retry)")
                except RuntimeError:
                    # commit may fail if content is identical
                    self._git("commit", "--allow-empty",
                              "-m", f"Update staging blob [{path}] (retry)")
                try:
                    self._push_or_detached_refspec()
                except RuntimeError as exc:
                    raise RuntimeError(
                        f"Git push failed after retry for {self._remote_url}: {exc}"
                    ) from exc
            else:
                # Auth/network error — re-raise immediately without retry
                raise

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _push_or_detached_refspec(self):
        """Push, falling back to explicit refspec if HEAD is detached."""
        try:
            self._git("push")
        except RuntimeError as exc:
            err_str = str(exc)
            if "not currently on a branch" in err_str:
                logger.info("Detached HEAD; using explicit refspec for push...")
                self._git("push", "origin", "HEAD:refs/heads/main")
            else:
                raise

    def _ensure_remote_url(self):
        """Ensure the clone's origin URL matches self._remote_url.

        If the clone was created with a different URL (e.g. HTTPS from an
        earlier config), update it to match the current config.
        Reads the git config file directly to avoid shelling out on every op.
        """
        if not self._clone_exists():
            return
        git_config = self._clone_path / ".git" / "config"
        if not git_config.is_file():
            return
        try:
            text = git_config.read_text()
            for line in text.splitlines():
                line = line.strip()
                if line.startswith("url = "):
                    current_url = line[6:].strip()
                    if current_url != self._remote_url:
                        logger.info(
                            "Updating remote URL from %s to %s",
                            current_url, self._remote_url
                        )
                        self._git("remote", "set-url", "origin", self._remote_url)
                    return
        except (OSError, IOError):
            pass

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

    def _has_remote_refs(self) -> bool:
        """Check if the remote has any refs (commits to pull).

        Returns False for empty repos or when ls-remote fails.
        """
        if not self._clone_exists():
            return False
        try:
            remote_refs = self._git("ls-remote", "--heads", "origin")
            return bool(remote_refs.strip())
        except RuntimeError:
            return False

    def _recover_git_abort_stuck_rebase(self):
        """Abort any stuck interactive rebase left by previous operations."""
        if not self._clone_exists():
            return
        # Check if rebase-merge or rebase-apply directory exists (indicates active rebase)
        git_dir = self._clone_path / ".git"
        if (git_dir / "rebase-merge").is_dir() or (git_dir / "rebase-apply").is_dir():
            logger.info("Aborting stuck rebase...")
            try:
                self._git("rebase", "--abort")
            except RuntimeError:
                logger.warning("Failed to abort rebase; may need manual cleanup")

    def _ensure_on_branch(self):
        """Ensure HEAD points to a valid branch, not detached HEAD.

        If HEAD is detached (e.g., after a failed rebase or pull --rebase),
        use ``git checkout -B main`` to force-create the main branch at
        current HEAD and check it out. Unlike ``git branch -f main HEAD``
        followed by ``git checkout main``, the ``-B`` flag atomically
        handles the case where main already exists (avoids "cannot force
        update branch used by worktree" error).
        """
        if not self._clone_exists():
            return
        try:
            # Check if HEAD is a symbolic ref (on a branch) or detached
            self._git("symbolic-ref", "-q", "HEAD")
            return
        except RuntimeError:
            # Detached HEAD — force-create main branch and check it out
            logger.info("Detached HEAD detected; re-attaching to main...")

        # Multiple recovery strategies for detached HEAD:
        attempts = [
            # Strategy 1: force-create branch at current HEAD
            lambda: self._git("checkout", "-B", "main"),
            # Strategy 2: if that fails (e.g. dirty tree), stash, then force
            lambda: (
                self._git("stash"),
                self._git("checkout", "-B", "main"),
            ),
            # Strategy 3: if main branch object exists, reset to it
            lambda: self._git("branch", "-f", "main", "HEAD"),
        ]

        for i, attempt in enumerate(attempts):
            try:
                attempt()
                # Verify we're now on a branch
                self._git("symbolic-ref", "-q", "HEAD")
                logger.info("Re-attached to main (strategy %d)", i + 1)
                return
            except RuntimeError:
                continue

        # Give up but don't throw — caller can still do git push origin HEAD:main
        logger.warning("Failed to re-attach HEAD to main; will use explicit refspec")


    @trace
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

    def list_files(self, prefix: str) -> list:
        """List filenames under *prefix* in the remote repo.

        Ensures the clone is up-to-date, then runs ``git ls-tree -r HEAD``
        to list files matching the prefix.

        Args:
            prefix: Remote directory prefix (e.g., ``ledger/blocks/``).

        Returns:
            List of filenames (basenames only) under the prefix. Empty if
            none exist or if the repo has no commits yet.
        """
        self._ensure_clone()
        self._ensure_remote_url()
        self._recover_git_abort_stuck_rebase()

        # Check if the clone has any commits yet
        if not self._has_local_commits():
            # Try pulling from remote first
            if self._has_remote_refs():
                self._ensure_on_branch()
                try:
                    self._git("pull", "--rebase", "--autostash")
                except RuntimeError:
                    pass
            else:
                return []

        try:
            output = self._git("ls-tree", "-r", "--name-only", "HEAD", "--", prefix)
        except RuntimeError:
            return []

        if not output.strip():
            return []

        # Extract basenames from paths
        files = []
        for line in output.strip().split("\n"):
            line = line.strip()
            if line:
                # line is like "ledger/blocks/000000.json"
                # Strip the prefix to get just the filename
                if line.startswith(prefix):
                    files.append(line[len(prefix):])
                else:
                    files.append(line)
        return files

    def _has_local_commits(self) -> bool:
        """Check if the local clone has at least one commit."""
        if not self._clone_exists():
            return False
        try:
            output = self._git("rev-parse", "--verify", "HEAD")
            return bool(output.strip())
        except RuntimeError:
            return False

    def update_remote_url(self, new_url: str):
        """Change the remote URL for an existing clone.

        Useful when the user updates ``remote.git_remote_url`` in config.

        Args:
            new_url: New remote URL.
        """
        self._remote_url = new_url
        if self._clone_exists():
            self._git("remote", "set-url", "origin", new_url)
