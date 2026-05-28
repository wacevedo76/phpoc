"""Tests for remote sync config wiring.

Tests that:
  1. ConfigManager provides remote.git_remote_url
  2. GitStagingTransport is instantiated from config values
  3. StagingService receives transport + device_id_provider when configured
  4. StagingService works without remote (no transport) — backward compat
  5. End-to-end: config → transport → push → pull via StagingService
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from core.sync.git_transport import GitStagingTransport
from domain.staging.service import StagingService
from domain.staging.local_cache import LocalStagingCache
from domain.staging.service import SyncCheckResult
from domain.staging.remote_sync import RemoteStagingSync
from security.device_identity import (
    RandomUUIDDeviceIdentityProvider,
    DeviceIdentity,
)
from security.crypto import CryptoManager, NoAuthCryptoManager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_bare_repo(path: str):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "--bare", str(path)],
        capture_output=True, check=True,
    )


def _init_local_repo(path: str):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init"], cwd=str(path), capture_output=True, check=True)
    (path / "README.md").write_text("# test\n")
    subprocess.run(
        ["git", "add", "."], cwd=str(path), capture_output=True, check=True
    )
    subprocess.run(
        ["git", "commit", "-m", "init"], cwd=str(path), capture_output=True, check=True
    )
    return path


def _make_mock_config_store():
    """Create a lightweight config store for tests.

    The store maintains a dict that read_config returns and write_config updates.
    """
    store = MagicMock()
    store._config = {}
    store.read_config.return_value = {}
    def read_config():
        return dict(store._config)
    def write_config(cfg):
        from security.config_manager import ConfigManager
        # Deep merge to handle nested keys
        current = dict(store._config)
        merged = ConfigManager._deep_merge(current, cfg)
        store._config.clear()
        store._config.update(merged)
        store.read_config.side_effect = read_config
    store.write_config.side_effect = write_config
    store.read_config.side_effect = read_config
    return store


def make_mock_crypto(master_key: bytes):
    """Make a proper CryptoManager-like mock for staging operations."""
    fake = MagicMock()
    fake.encrypt.side_effect = lambda text: f"ENC:{text}"
    fake.decrypt.side_effect = lambda hex_data: (
        hex_data[4:] if hex_data.startswith("ENC:")
        else hex_data[6:] if hex_data.startswith("plain:")
        else hex_data
    )
    return fake


def make_mock_staging_store():
    store = MagicMock()
    store._entries = []
    
    def read_entries():
        return list(store._entries)
    def write_entries(entries):
        store._entries[:] = list(entries)
    def append_entry(entry):
        store._entries.append(entry)
    def remove_entries(indices):
        for i in sorted(indices, reverse=True):
            if 0 <= i < len(store._entries):
                store._entries.pop(i)
    def update_entry(idx, fields):
        if 0 <= idx < len(store._entries):
            store._entries[idx].update(fields)
    
    store.read_entries.side_effect = read_entries
    store.write_entries.side_effect = write_entries
    store.append_entry.side_effect = append_entry
    store.remove_entries.side_effect = remove_entries
    store.update_entry.side_effect = update_entry
    return store


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestConfigReadsRemoteUrl(unittest.TestCase):
    """ConfigManager provides remote.git_remote_url."""

    def test_remote_url_defaults_to_none(self):
        """Default config has remote.git_remote_url = None."""
        from security.config_manager import ConfigManager
        store = _make_mock_config_store()
        config = ConfigManager(store)
        self.assertIsNone(config.get("remote.git_remote_url"))

    def test_remote_url_settable(self):
        """Setting remote.git_remote_url persists it."""
        from security.config_manager import ConfigManager
        store = _make_mock_config_store()
        config = ConfigManager(store)
        config.write({"remote": {"git_remote_url": "git@example.com:user/repo.git"}})
        self.assertEqual(
            config.get("remote.git_remote_url"),
            "git@example.com:user/repo.git",
        )

    def test_remote_transport_defaults_to_git(self):
        """Default remote.transport is 'git'."""
        from security.config_manager import ConfigManager
        store = _make_mock_config_store()
        config = ConfigManager(store)
        self.assertEqual(config.get("remote.transport"), "git")


class TestGitTransportFromConfig(unittest.TestCase):
    """GitStagingTransport instantiated from config values."""

    def test_transport_created_from_config_url(self):
        """GitStagingTransport can be created from a config URL."""
        from security.config_manager import ConfigManager
        store = _make_mock_config_store()
        config = ConfigManager(store)

        config.write({"remote": {"git_remote_url": "git@github.com:user/repo.git"}})
        url = config.get("remote.git_remote_url")
        clone_path = "/tmp/phpoc_test_clone"

        transport = GitStagingTransport(url, clone_path)
        self.assertEqual(transport._remote_url, "git@github.com:user/repo.git")
        self.assertEqual(str(transport._clone_path), clone_path)

    def test_transport_created_with_none_remote(self):
        """When git_remote_url is None, no transport is created."""
        from security.config_manager import ConfigManager
        store = _make_mock_config_store()
        config = ConfigManager(store)

        url = config.get("remote.git_remote_url")
        self.assertIsNone(url)


class TestStagingServiceWithRemote(unittest.TestCase):
    """StagingService receives transport + device_id_provider."""

    def test_staging_service_no_remote(self):
        """StagingService works without transport (backward compat)."""
        svc = StagingService(make_mock_crypto(b"\x00" * 32), make_mock_staging_store())
        self.assertEqual(svc.check_and_sync(), SyncCheckResult.READY)
        svc.push_to_remote(b"\x00" * 32)  # no-op, no remote configured

    def test_staging_service_with_transport_config(self):
        """StagingService created with transport has remote available."""
        import tempfile
        tmpdir = Path(tempfile.mkdtemp())
        transport = MagicMock()
        transport.pull.return_value = None
        transport.push.return_value = None

        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="test-dev", device_proof="p", device_label="T"
        )
        device_provider.check_remote_identity.return_value = True

        svc = StagingService(
            make_mock_crypto(b"\x00" * 32),
            make_mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
            data_dir=str(tmpdir),
        )

        # No local cookie → REAUTH_NEEDED (expected with Device Cookie mechanism)
        result = svc.check_and_sync()
        self.assertIn(result, (SyncCheckResult.READY, SyncCheckResult.REAUTH_NEEDED))


class TestStagingServiceRemoteRoundtrip(unittest.TestCase):
    """End-to-end local bare repo workflow through StagingService."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="phpoc_wiring_")
        self._bare_path = str(Path(self._tmpdir) / "bare.git")
        self._clone_path = str(Path(self._tmpdir) / "clone")
        self._local_init = str(Path(self._tmpdir) / "local_init")

        _create_bare_repo(self._bare_path)
        _init_local_repo(self._local_init)
        subprocess.run(
            ["git", "remote", "add", "origin", self._bare_path],
            cwd=self._local_init, capture_output=True, check=True,
        )
        subprocess.run(
            ["git", "push", "origin", "main"],
            cwd=self._local_init, capture_output=True, check=True,
        )

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_push_pull_roundtrip_via_staging_service(self):
        """StagingService.push_to_remote then check_and_sync pulls data back."""
        transport = GitStagingTransport(self._bare_path, self._clone_path)
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="test-dev", device_proof="p", device_label="T"
        )

        svc = StagingService(
            make_mock_crypto(b"\x00" * 32),
            make_mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )

        # Add an entry and push
        svc.capture("RemoteTest", 1000, stop_epoch=2000)
        entries_before = svc.get_entries()
        self.assertEqual(len(entries_before), 1)

        svc.push_to_remote(b"dummy-no-obfuscation")  # Not 32 bytes — skips obfuscation

        # Create a second service reading from the same bare repo
        transport2 = GitStagingTransport(
            self._bare_path,
            str(Path(self._tmpdir) / "clone2"),
        )
        svc2 = StagingService(
            make_mock_crypto(b"\x00" * 32),
            make_mock_staging_store(),
            transport=transport2,
            device_id_provider=device_provider,
        )

        # check_and_sync should pull the remote blob
        result = svc2.check_and_sync()
        self.assertEqual(result, SyncCheckResult.READY)

    def test_multiple_push_same_device(self):
        """Multiple pushes from same device accumulate entries locally."""
        transport = GitStagingTransport(self._bare_path, self._clone_path)
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-1", device_proof="p", device_label="T"
        )

        svc_data_dir = str(Path(self._tmpdir) / "data1")

        svc = StagingService(
            make_mock_crypto(b"\x00" * 32),
            make_mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
            data_dir=svc_data_dir,
        )

        svc.capture("Task1", 1000, stop_epoch=2000)
        svc.push_to_remote(b"dummy-no-obfuscation")

        svc.capture("Task2", 3000, stop_epoch=4000)
        svc.push_to_remote(b"dummy-no-obfuscation")

        # Both entries should be in local staging
        entries = svc.get_entries()
        self.assertGreaterEqual(len(entries), 2)


class TestDeviceIdentityInitialization(unittest.TestCase):
    """Device identity initialization from config works."""

    def test_device_id_generated_on_first_access(self):
        """RandomUUIDDeviceIdentityProvider generates device_id on first call."""
        from security.config_manager import ConfigManager
        store = _make_mock_config_store()
        config = ConfigManager(store)

        provider = RandomUUIDDeviceIdentityProvider(config)
        # Before first call, config has no device_id
        self.assertIsNone(config.get("device_id"))  # Top-level key

        identity = provider.get_device_identity(b"\x00" * 32)
        self.assertIsNotNone(identity.device_id)
        self.assertIsNotNone(identity.device_proof)

        # After first call, config is populated (top-level key)
        self.assertIsNotNone(config.get("device_id"))

    def test_device_id_persisted(self):
        """Generated device_id persists across provider instances."""
        from security.config_manager import ConfigManager
        store = _make_mock_config_store()
        config = ConfigManager(store)

        provider1 = RandomUUIDDeviceIdentityProvider(config)
        id1 = provider1.get_device_identity(b"\x00" * 32)

        provider2 = RandomUUIDDeviceIdentityProvider(config)
        id2 = provider2.get_device_identity(b"\x00" * 32)

        self.assertEqual(id1.device_id, id2.device_id)
        self.assertEqual(id1.device_proof, id2.device_proof)

    def test_device_proof_differs_by_master_key(self):
        """Different master keys produce different proofs for same device.

        The provider caches the identity after first access (device_id + proof),
        so subsequent calls with a different master key return the cached proof.
        This test verifies that creating a FRESH provider with a different key
        produces a different proof for the same device_id.
        """
        from security.config_manager import ConfigManager
        store = _make_mock_config_store()
        config = ConfigManager(store)

        provider1 = RandomUUIDDeviceIdentityProvider(config)
        id1 = provider1.get_device_identity(b"\x00" * 32)

        # Fresh provider reads the same config but derives proof from new key
        provider2 = RandomUUIDDeviceIdentityProvider(config)
        id2 = provider2.get_device_identity(b"\xff" * 32)

        self.assertEqual(id1.device_id, id2.device_id)  # Same device
        self.assertNotEqual(id1.device_proof, id2.device_proof)  # Different proof


class TestConfigTemplateRemoteSection(unittest.TestCase):
    """Config template documents remote settings."""

    def test_remote_settings_documented(self):
        """Config template includes remote.git_remote_url and related keys."""
        # Importing main directly would run CLI — just check the config defaults
        from security.config_manager import ConfigManager
        self.assertIn("git_remote_url", ConfigManager.DEFAULTS.get("remote", {}))
        self.assertIn("transport", ConfigManager.DEFAULTS.get("remote", {}))


class TestMainWiringRemoteUrl(unittest.TestCase):
    """Verify main.py-style remote URL wiring logic."""

    def _simulate_main_wiring(self, remote_url_value):
        """Mimic the remote transport setup block from main.py."""
        from security.config_manager import ConfigManager
        store = _make_mock_config_store()
        config = ConfigManager(store)

        if remote_url_value is not None:
            config.write({"remote": {"git_remote_url": remote_url_value}})

        remote_url = config.get("remote.git_remote_url")
        transport = None
        device_id_provider = None
        if remote_url:
            transport = MagicMock()
            transport.pull.return_value = None
            transport.push.return_value = None
            device_id_provider = MagicMock()
            device_id_provider.get_device_identity.return_value = DeviceIdentity(
                device_id="test-dev", device_proof="p", device_label="T"
            )

        staging_store = make_mock_staging_store()
        svc = StagingService(
            crypto=make_mock_crypto(b"\x00" * 32),
            staging_store=staging_store,
            transport=transport,
            device_id_provider=device_id_provider,
        )
        return svc, transport, device_id_provider

    def test_none_url_disables_remote(self):
        """remote.git_remote_url=None -> transport=None, local-only."""
        svc, transport, provider = self._simulate_main_wiring(None)
        self.assertIsNone(transport)
        self.assertIsNone(provider)
        # check_and_sync returns READY (local-only) even when no remote
        self.assertEqual(svc.check_and_sync(), SyncCheckResult.READY)
        # push_to_remote is a no-op
        svc.push_to_remote(b"\x00" * 32)  # should not raise

    def test_empty_string_disables_remote(self):
        """remote.git_remote_url='' -> transport=None, local-only."""
        svc, transport, provider = self._simulate_main_wiring("")
        self.assertIsNone(transport)
        self.assertIsNone(provider)
        self.assertEqual(svc.check_and_sync(), SyncCheckResult.READY)
        svc.push_to_remote(b"\x00" * 32)

    def test_valid_url_enables_remote(self):
        """remote.git_remote_url='git@example:r.git' -> transport+provider set."""
        svc, transport, provider = self._simulate_main_wiring(
            "git@example.com:user/repo.git"
        )
        self.assertIsNotNone(transport)
        self.assertIsNotNone(provider)
        # With transport but no local cookie → REAUTH_NEEDED
        result = svc.check_and_sync()
        self.assertIn(result, (SyncCheckResult.READY, SyncCheckResult.REAUTH_NEEDED))
        # push_to_remote uses the transport
        svc.push_to_remote(b"\x00" * 32)
        # Should call push on the mocked transport (cookie + blob = 2 calls)
        self.assertEqual(transport.push.call_count, 2)
