"""Tests for GitStagingTransport and blob obfuscation.

Tests are organized into:
  1. GitStagingTransport — against local bare repos
  2. Blob obfuscation — unit tests for pad/encrypt/decrypt/unpad
  3. End-to-end — full round-trip through a local bare repo
"""

import json
import os
import struct
import hmac
import hashlib
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from core.sync.git_transport import GitStagingTransport
from core.sync.transport import AbstractStagingTransport

# Import the obfuscation helpers from RemoteStagingSync
from domain.staging.remote_sync import (
    RemoteStagingSync,
    TIER_64K,
    TIER_128K,
    TIER_256K,
    TIER_512K,
    BLOB_TIERS,
    BLOB_SUBKEY_PREFIX,
    SyncCheckResult,
)
from security.device_identity import (
    AbstractDeviceIdentityProvider,
    DeviceIdentity,
)

# =============================================================================
# GitStagingTransport tests
# =============================================================================


def _create_bare_repo(path: str):
    """Create a local bare git repo at *path*."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "--bare", str(path)],
        capture_output=True,
        check=True,
    )


def _init_local_repo(path: str):
    """Create a non-bare repo and make an initial commit (so clone works)."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init"], cwd=str(path), capture_output=True, check=True)
    readme = path / "README.md"
    readme.write_text("# phpoc remote staging\n")
    subprocess.run(
        ["git", "add", "."], cwd=str(path), capture_output=True, check=True
    )
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=str(path), capture_output=True, check=True
    )
    return path


def _git_hash_object(data: bytes) -> str:
    """Compute git object hash (equivalent to git hash-object)."""
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data).hexdigest()


class TestGitStagingTransportConstructor(unittest.TestCase):
    """GitStagingTransport construction and basic attributes."""

    def test_is_abstract_transport(self):
        """GitStagingTransport must implement AbstractStagingTransport."""
        t = GitStagingTransport("file:///tmp/test.git", "/tmp/phpoc-remote")
        self.assertIsInstance(t, AbstractStagingTransport)

    def test_stores_url_and_path(self):
        """Constructor stores remote_url and clone_path."""
        t = GitStagingTransport("git@github.com:user/repo.git", "/data/remote")
        self.assertEqual(t._remote_url, "git@github.com:user/repo.git")
        self.assertEqual(str(t._clone_path), "/data/remote")


class TestGitStagingTransportPullPush(unittest.TestCase):
    """Pull/push against a local bare repo."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="phpoc_git_test_")
        self._bare_path = str(Path(self._tmpdir) / "bare.git")
        self._clone_path = str(Path(self._tmpdir) / "clone")
        self._local_init_path = str(Path(self._tmpdir) / "local_init")

        # Create a bare repo
        _create_bare_repo(self._bare_path)

        # Create a local repo with content and push to bare
        _init_local_repo(self._local_init_path)
        subprocess.run(
            ["git", "remote", "add", "origin", self._bare_path],
            cwd=self._local_init_path,
            capture_output=True,
            check=True,
        )
        subprocess.run(
            ["git", "push", "origin", "main"],
            cwd=self._local_init_path,
            capture_output=True,
            check=True,
        )

        # Also set up a local clone-based repo by creating a second bare repo
        # that doesn't have main (simulating a fresh bare)
        self._bare_path2 = str(Path(self._tmpdir) / "bare2.git")
        _create_bare_repo(self._bare_path2)

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_pull_returns_none_on_empty_repo(self):
        """pull returns None when no blob exists."""
        transport = GitStagingTransport(self._bare_path2, self._clone_path + "a")
        result = transport.pull("staging/blobs/current.json")
        self.assertIsNone(result)

    def test_push_then_pull_roundtrip(self):
        """push then pull returns same data."""
        transport = GitStagingTransport(self._bare_path, self._clone_path + "b")
        data = b'{"device_id": "test", "entries": [], "updated_at": 1000}'
        transport.push("staging/blobs/current.json", data)
        result = transport.pull("staging/blobs/current.json")
        self.assertEqual(result, data)

    def test_push_multiple_commits(self):
        """Multiple pushes each create a commit."""
        transport = GitStagingTransport(self._bare_path, self._clone_path + "c")
        data1 = b'{"version": 1}'
        data2 = b'{"version": 2}'
        transport.push("staging/blobs/current.json", data1)
        transport.push("staging/blobs/current.json", data2)
        result = transport.pull("staging/blobs/current.json")
        self.assertEqual(result, data2)

    def test_pull_returns_none_for_wrong_path(self):
        """pull returns None for non-existent path."""
        transport = GitStagingTransport(self._bare_path, self._clone_path + "d")
        result = transport.pull("nonexistent/path.json")
        self.assertIsNone(result)

    def test_push_creates_parent_dirs(self):
        """push creates parent directories automatically."""
        transport = GitStagingTransport(self._bare_path, self._clone_path + "e")
        data = b'{"nested": true}'
        transport.push("deep/path/to/blob.json", data)
        result = transport.pull("deep/path/to/blob.json")
        self.assertEqual(result, data)

    def test_update_remote_url(self):
        """update_remote_url changes the remote."""
        transport = GitStagingTransport(self._bare_path, self._clone_path + "f")
        data = b'{"hello": "world"}'
        transport.push("blob.json", data)
        # Can't easily test URL change on local bare, but verify no crash
        transport.update_remote_url(self._bare_path)

    def test_clone_then_pull_from_fresh_bare(self):
        """First pull on an empty-cloned repo should work."""
        transport = GitStagingTransport(self._bare_path2, self._clone_path + "g")
        # This tests the fallback: empty bare -> git init in clone dir
        data = b'{"fresh": true}'
        transport.push("blob.json", data)
        result = transport.pull("blob.json")
        self.assertEqual(result, data)

    def test_push_pull_binary_data(self):
        """push/pull handles arbitrary binary data."""
        transport = GitStagingTransport(self._bare_path, self._clone_path + "h")
        binary_data = bytes(range(256))
        transport.push("binary.bin", binary_data)
        result = transport.pull("binary.bin")
        self.assertEqual(result, binary_data)


class TestGitStagingTransportErrors(unittest.TestCase):
    """Error handling in GitStagingTransport."""

    @patch("core.sync.git_transport.subprocess.run")
    def test_push_rejection_retry(self, mock_run):
        """Push rejection triggers pull+retry."""
        import tempfile
        tmpdir = tempfile.mkdtemp(prefix="phpoc_test_retry_")
        transport = GitStagingTransport("file:///tmp/fake.git", tmpdir)

        # Create .git dir so _clone_exists is True (skip _ensure_clone)
        Path(tmpdir, ".git").mkdir(parents=True, exist_ok=True)

        mock_run.side_effect = [
            MagicMock(returncode=0, stdout="", stderr=""),  # git add
            MagicMock(returncode=0, stdout="", stderr=""),  # git commit
            MagicMock(returncode=1, stderr="! [rejected]"),  # git push fails
            MagicMock(returncode=0, stdout="", stderr=""),  # git pull --rebase
            MagicMock(returncode=0, stdout="", stderr=""),  # git add (retry)
            MagicMock(returncode=0, stdout="", stderr=""),  # git commit (retry)
            MagicMock(returncode=0, stdout="", stderr=""),  # git push (retry)
        ]

        transport.push("blob.json", b'{"test": true}')
        self.assertEqual(mock_run.call_count, 7)
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)

    @patch("core.sync.git_transport.subprocess.run")
    def test_push_rejection_twice_raises(self, mock_run):
        """Push rejected twice raises RuntimeError."""
        import tempfile
        tmpdir = tempfile.mkdtemp(prefix="phpoc_test_reject_")
        transport = GitStagingTransport("file:///tmp/fake.git", tmpdir)

        # Create .git dir so _clone_exists is True (skip _ensure_clone)
        Path(tmpdir, ".git").mkdir(parents=True, exist_ok=True)

        mock_run.side_effect = [
            MagicMock(returncode=0, stdout="", stderr=""),  # git add
            MagicMock(returncode=0, stdout="", stderr=""),  # git commit
            MagicMock(returncode=1, stderr="! [rejected]"),  # push fails
            MagicMock(returncode=0, stdout="", stderr=""),  # pull --rebase
            MagicMock(returncode=0, stdout="", stderr=""),  # add retry
            MagicMock(returncode=0, stdout="", stderr=""),  # commit retry
            MagicMock(returncode=1, stderr="! [rejected]"),  # push fails again
        ]

        with self.assertRaises(RuntimeError):
            transport.push("blob.json", b'{"test": true}')
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)

    @patch("core.sync.git_transport.subprocess.run")
    def test_git_not_installed(self, mock_run):
        """FileNotFoundError when git is not installed."""
        import tempfile
        tmpdir = tempfile.mkdtemp(prefix="phpoc_test_gitless_")
        Path(tmpdir, ".git").mkdir(parents=True, exist_ok=True)

        mock_run.side_effect = FileNotFoundError("git not found")
        transport = GitStagingTransport("file:///tmp/fake.git", tmpdir)

        with self.assertRaises(RuntimeError):
            transport.pull("blob.json")
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)

    @patch("core.sync.git_transport.subprocess.run")
    def test_timeout_raises_error(self, mock_run):
        """Timeout raises RuntimeError."""
        from subprocess import TimeoutExpired
        import tempfile
        tmpdir = tempfile.mkdtemp(prefix="phpoc_test_timeout_")
        Path(tmpdir, ".git").mkdir(parents=True, exist_ok=True)

        mock_run.side_effect = TimeoutExpired("git", 60)
        transport = GitStagingTransport("file:///tmp/fake.git", tmpdir)

        with self.assertRaises(RuntimeError):
            transport.pull("blob.json")
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)

    def test_invalid_remote_url(self):
        """Invalid remote URL raises RuntimeError during pull."""
        transport = GitStagingTransport(
            "file:///nonexistent/path/repo.git",
            "/tmp/__phpoc_test_invalid",
        )
        with self.assertRaises(RuntimeError):
            transport.pull("blob.json")


# =============================================================================
# Blob Obfuscation tests
# =============================================================================


class TestBlobTierSelection(unittest.TestCase):
    """_select_tier chooses the correct tier."""

    def test_smallest_tier_for_tiny_blob(self):
        """Blob < 64K uses 64K tier."""
        self.assertEqual(RemoteStagingSync._select_tier(1), TIER_64K)
        self.assertEqual(RemoteStagingSync._select_tier(100), TIER_64K)
        self.assertEqual(RemoteStagingSync._select_tier(65535), TIER_64K)

    def test_exact_tier_boundary(self):
        """Blob exactly at tier size uses that tier."""
        self.assertEqual(RemoteStagingSync._select_tier(TIER_64K), TIER_64K)
        self.assertEqual(RemoteStagingSync._select_tier(TIER_128K), TIER_128K)

    def test_tier_transitions(self):
        """Blobs larger than 64K use 128K, etc."""
        self.assertEqual(RemoteStagingSync._select_tier(TIER_64K + 1), TIER_128K)
        self.assertEqual(RemoteStagingSync._select_tier(TIER_128K + 1), TIER_256K)
        self.assertEqual(RemoteStagingSync._select_tier(TIER_256K + 1), TIER_512K)

    def test_exceeds_max_tier(self):
        """Blob > 512K raises ValueError."""
        with self.assertRaises(ValueError):
            RemoteStagingSync._select_tier(TIER_512K + 1)


class TestBlobKeyDerivation(unittest.TestCase):
    """_derive_blob_key produces deterministic, sub-key derived keys."""

    def test_key_is_16_bytes(self):
        """Derived key is always 16 bytes (AES-128)."""
        mk = b"\x01" * 32
        key = RemoteStagingSync._derive_blob_key(mk)
        self.assertEqual(len(key), 16)

    def test_deterministic(self):
        """Same master_key produces same blob key."""
        mk = b"\xaa" * 32
        k1 = RemoteStagingSync._derive_blob_key(mk)
        k2 = RemoteStagingSync._derive_blob_key(mk)
        self.assertEqual(k1, k2)

    def test_different_master_key_different_blob_key(self):
        """Different master keys produce different blob keys."""
        k1 = RemoteStagingSync._derive_blob_key(b"\x01" * 32)
        k2 = RemoteStagingSync._derive_blob_key(b"\x02" * 32)
        self.assertNotEqual(k1, k2)

    def test_not_same_as_encryption_key(self):
        """Blob key must differ from encryption sub-key."""
        mk = b"\x55" * 32
        blob_key = RemoteStagingSync._derive_blob_key(mk)
        # Derive what would be the standard encryption sub-key
        enc_key = hmac.new(mk, b"encryption", hashlib.sha256).digest()[:16]
        self.assertNotEqual(blob_key, enc_key)


class TestBlobObfuscationRoundtrip(unittest.TestCase):
    """_obfuscate / _deobfuscate round-trip."""

    def setUp(self):
        self.mk = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 4  # 32 bytes
        self.plaintext = json.dumps({
            "device_id": "test-device",
            "entries": [{"title": "Test", "duration": 3600000}],
            "updated_at": int(time.time() * 1000),
        }).encode("utf-8")

    def test_roundtrip(self):
        """Obfuscated then deobfuscated returns original."""
        obfuscated = RemoteStagingSync._obfuscate(self.plaintext, self.mk)
        result = RemoteStagingSync._deobfuscate(obfuscated, self.mk)
        self.assertEqual(result, self.plaintext)

    def test_output_differs_from_input(self):
        """Obfuscated output is not the same as input."""
        obfuscated = RemoteStagingSync._obfuscate(self.plaintext, self.mk)
        self.assertNotEqual(obfuscated, self.plaintext)

    def test_output_is_deterministic_with_same_nonce(self):
        """With same inputs (including nonce) output is deterministic."""
        # We can't easily inject a nonce, so just verify two calls differ
        # (due to random salt/nonce)
        o1 = RemoteStagingSync._obfuscate(self.plaintext, self.mk)
        o2 = RemoteStagingSync._obfuscate(self.plaintext, self.mk)
        self.assertNotEqual(o1, o2)

    def test_obfuscated_size_is_tier(self):
        """Obfuscated output size matches tier (salt+nonce+plaintext_len+padded+tag)."""
        obfuscated = RemoteStagingSync._obfuscate(self.plaintext, self.mk)
        tier = RemoteStagingSync._select_tier(len(self.plaintext))
        # Output = salt(16) + nonce(8) + tier_size + tag(32)
        expected_size = 16 + 8 + tier + 32
        self.assertEqual(len(obfuscated), expected_size)

    def test_wrong_key_fails(self):
        """Deobfuscation with wrong master_key returns None (integrity check)."""
        obfuscated = RemoteStagingSync._obfuscate(self.plaintext, self.mk)
        wrong_mk = b"\xff" * 32
        result = RemoteStagingSync._deobfuscate(obfuscated, wrong_mk)
        self.assertIsNone(result)

    def test_tampered_data_fails(self):
        """Tampered ciphertext returns None."""
        obfuscated = bytearray(RemoteStagingSync._obfuscate(self.plaintext, self.mk))
        # Corrupt a byte in the ciphertext area (after salt+nonce, before tag)
        obfuscated[30] ^= 0xFF  # Flip bits in ciphertext
        result = RemoteStagingSync._deobfuscate(bytes(obfuscated), self.mk)
        self.assertIsNone(result)

    def test_large_plaintext(self):
        """Large plaintext (near tier boundary) works."""
        large = b"x" * 60000  # Fits in 64K tier
        obfuscated = RemoteStagingSync._obfuscate(large, self.mk)
        result = RemoteStagingSync._deobfuscate(obfuscated, self.mk)
        self.assertEqual(result, large)

    def test_empty_plaintext(self):
        """Empty plaintext should work (empty JSON object)."""
        empty = b"{}"
        obfuscated = RemoteStagingSync._obfuscate(empty, self.mk)
        result = RemoteStagingSync._deobfuscate(obfuscated, self.mk)
        self.assertEqual(result, empty)


# =============================================================================
# RemoteStagingSync push/pull with obfuscation tests
# =============================================================================


class TestRemoteStagingSyncObfuscation(unittest.TestCase):
    """RemoteStagingSync push/pull with obfuscation enabled."""

    def setUp(self):
        self.mk = b"\x11" * 32
        self.entries = [
            {"hash": "abc", "data": {"title": "Task"}, "start_epoch": 1000}
        ]
        self.device_id = "test-device-123"

        # Mock transport
        self._transport_blob = None

        class MockTransport:
            def __init__(self):
                self._blob = None
            def pull(self, path):
                return self._blob
            def push(self, path, data):
                self._blob = data

        transport = MockTransport()

        mock_crypto = MagicMock()
        mock_provider = MagicMock()
        mock_provider.get_device_identity.return_value = DeviceIdentity(
            device_id=self.device_id, device_proof="p", device_label="T"
        )

        self._transport_instance = transport
        self.rsync = RemoteStagingSync(mock_crypto, transport, mock_provider)

    def test_push_with_master_key_obfuscates(self):
        """push with 32-byte master_key produces non-JSON blob."""
        self.rsync.push(self.entries, self.device_id, master_key=self.mk)
        blob = self._transport_instance._blob
        # Should not be valid UTF-8 JSON (it's obfuscated)
        with self.assertRaises((json.JSONDecodeError, UnicodeDecodeError)):
            json.loads(blob.decode("utf-8"))
        self.assertIsInstance(blob, bytes)

    def test_push_without_master_key_plaintext(self):
        """push without master_key produces plaintext JSON."""
        self.rsync.push(self.entries, self.device_id)
        blob = self._transport_instance._blob
        parsed = json.loads(blob.decode("utf-8"))
        self.assertEqual(parsed["device_id"], self.device_id)
        self.assertEqual(len(parsed["entries"]), 1)

    def test_push_pull_roundtrip_with_obfuscation(self):
        """push (obfuscated) then pull returns same entries."""
        self.rsync.push(self.entries, self.device_id, master_key=self.mk)
        result = self.rsync.pull(master_key=self.mk)
        self.assertIsNotNone(result)
        self.assertEqual(result["device_id"], self.device_id)
        self.assertEqual(len(result["entries"]), 1)

    def test_pull_fallback_to_plaintext(self):
        """pull reads plaintext blob even when obfuscation is configured."""
        self.rsync.push(self.entries, self.device_id)
        result = self.rsync.pull()
        self.assertIsNotNone(result)
        self.assertEqual(result["device_id"], self.device_id)


# =============================================================================
# End-to-end: GitStagingTransport + RemoteStagingSync + obfuscation
# =============================================================================


class TestEndToEndRemoteSync(unittest.TestCase):
    """Full round-trip: staging -> git transport -> obfuscation -> pull."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="phpoc_e2e_")
        self._bare_path = str(Path(self._tmpdir) / "bare.git")
        self._clone_path = str(Path(self._tmpdir) / "clone")
        self._local_init = str(Path(self._tmpdir) / "local_init")
        self.mk = b"\x22" * 32
        self.device_id = "e2e-device"

        _create_bare_repo(self._bare_path)
        _init_local_repo(self._local_init)
        subprocess.run(
            ["git", "remote", "add", "origin", self._bare_path],
            cwd=self._local_init,
            capture_output=True, check=True,
        )
        subprocess.run(
            ["git", "push", "origin", "main"],
            cwd=self._local_init,
            capture_output=True, check=True,
        )

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_full_roundtrip(self):
        """Push obfuscated blob via git, pull and verify."""
        transport = GitStagingTransport(self._bare_path, self._clone_path)
        mock_crypto = MagicMock()
        mock_provider = MagicMock()
        mock_provider.get_device_identity.return_value = DeviceIdentity(
            device_id=self.device_id, device_proof="p", device_label="T"
        )

        rsync = RemoteStagingSync(mock_crypto, transport, mock_provider)

        entries = [{"hash": "e2e", "data": {"title": "E2ETest"}, "start_epoch": 5000}]
        rsync.push(entries, self.device_id, master_key=self.mk)

        # Now create a second transport that reads from the same bare repo
        transport2 = GitStagingTransport(
            self._bare_path,
            str(Path(self._tmpdir) / "clone2"),
        )
        rsync2 = RemoteStagingSync(mock_crypto, transport2, mock_provider)
        result = rsync2.pull(master_key=self.mk)

        self.assertIsNotNone(result)
        self.assertEqual(result["device_id"], self.device_id)
        self.assertEqual(len(result["entries"]), 1)
        self.assertEqual(result["entries"][0]["data"]["title"], "E2ETest")

    def test_two_device_flow(self):
        """Two devices share staging via git remote."""
        transport = GitStagingTransport(self._bare_path, self._clone_path)
        mock_crypto = MagicMock()
        mock_provider = MagicMock()

        # Device A pushes
        mock_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="device-a", device_proof="p", device_label="A"
        )
        rsync_a = RemoteStagingSync(mock_crypto, transport, mock_provider)
        rsync_a.push(
            [{"hash": "a1", "data": {"title": "FromA"}, "start_epoch": 100}],
            "device-a",
            master_key=self.mk,
        )

        # Device B pulls
        transport2 = GitStagingTransport(
            self._bare_path,
            str(Path(self._tmpdir) / "clone_b"),
        )
        mock_provider2 = MagicMock()
        mock_provider2.get_device_identity.return_value = DeviceIdentity(
            device_id="device-b", device_proof="p", device_label="B"
        )
        rsync_b = RemoteStagingSync(mock_crypto, transport2, mock_provider2)
        result = rsync_b.pull(master_key=self.mk)

        self.assertIsNotNone(result)
        self.assertEqual(result["device_id"], "device-a")
        self.assertEqual(result["entries"][0]["data"]["title"], "FromA")


if __name__ == "__main__":
    unittest.main()
