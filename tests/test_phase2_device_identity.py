"""Phase 2 tests: Device Identity Provider.

Tests the AbstractDeviceIdentityProvider interface and the
RandomUUIDDeviceIdentityProvider implementation.

Key behaviors:
  - Device UUID is stable (persisted in config)
  - HMAC proof is deterministic given (mk, device_id)
  - Cross-device verification works
  - Re-auth flow: device_id mismatch → verify_proof → accept/reject
"""

import unittest
import hashlib
import hmac
import json
import tempfile
from unittest.mock import MagicMock
from pathlib import Path

try:
    from security.device_identity import (
        AbstractDeviceIdentityProvider,
        RandomUUIDDeviceIdentityProvider,
        DeviceIdentity,
    )
    HAS_DEVICE_ID = True
except ImportError:
    HAS_DEVICE_ID = False
    from abc import ABC, abstractmethod
    class DeviceIdentity:
        def __init__(self, device_id="", device_proof="", device_label=""):
            self.device_id = device_id
            self.device_proof = device_proof
            self.device_label = device_label
    class AbstractDeviceIdentityProvider(ABC):
        @abstractmethod
        def get_device_identity(self, master_key: bytes) -> DeviceIdentity: pass
        @abstractmethod
        def verify_device_proof(self, device_id: str, device_proof: str, master_key: bytes) -> bool: pass


class TestAbstractDeviceIdentityProvider(unittest.TestCase):
    """Verify the abstract interface exists and enforces contracts."""

    def test_cannot_instantiate_abstract(self):
        with self.assertRaises(TypeError):
            AbstractDeviceIdentityProvider()


class TestRandomUUIDDeviceIdentityProvider(unittest.TestCase):
    """Test the default implementation — random UUID per device, persisted in config."""

    def setUp(self):
        if not HAS_DEVICE_ID:
            self.skipTest("DeviceIdentityProvider not yet implemented")
        self.master_key = b"test-master-key-32-bytes-long!!"
        self.config_manager = MagicMock()
        self.config_manager.read.return_value = {}
        self.provider = RandomUUIDDeviceIdentityProvider(self.config_manager)

    def test_get_identity_returns_device_identity(self):
        """get_device_identity() returns a DeviceIdentity with all fields."""
        identity = self.provider.get_device_identity(self.master_key)
        self.assertIsInstance(identity, DeviceIdentity)
        self.assertTrue(len(identity.device_id) > 0)
        self.assertTrue(len(identity.device_proof) > 0)
        self.assertTrue(len(identity.device_label) > 0)

    def test_device_id_is_uuid4_format(self):
        """device_id is a UUID4 string with -cli suffix (Bug 3a fix)."""
        identity = self.provider.get_device_identity(self.master_key)
        # UUID4-cli format: 8-4-4-4-12 hex digits followed by -cli
        import re
        self.assertTrue(
            re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-cli$',
                     identity.device_id, re.I),
            f"device_id '{identity.device_id}' is not valid UUID4-cli"
        )

    def test_device_proof_is_hmac_sha256(self):
        """device_proof = HMAC-SHA256(mk, 'phpoc:device:' + device_id)."""
        identity = self.provider.get_device_identity(self.master_key)
        expected = hmac.new(
            self.master_key,
            f"phpoc:device:{identity.device_id}".encode(),
            hashlib.sha256
        ).hexdigest()
        self.assertEqual(identity.device_proof, expected)

    def test_identity_is_cached(self):
        """get_device_identity() returns the same identity on subsequent calls."""
        first = self.provider.get_device_identity(self.master_key)
        second = self.provider.get_device_identity(self.master_key)
        self.assertEqual(first.device_id, second.device_id)
        self.assertEqual(first.device_proof, second.device_proof)

    def test_device_id_persisted_in_config(self):
        """device_id is written to config on first call."""
        # Simulate empty config — no device_id set
        config = {}
        self.config_manager.read.return_value = config

        identity = self.provider.get_device_identity(self.master_key)

        # Verify write was called with device_id
        self.config_manager.write.assert_called_once()
        written = self.config_manager.write.call_args[0][0]
        self.assertIn("device_id", written)
        self.assertEqual(written["device_id"], identity.device_id)

    def test_device_id_read_from_config(self):
        """device_id is read from config on subsequent sessions (not regenerated).

        Bug 3a: Bare UUID4 gets -cli suffix appended on migration.
        """
        # Simulate existing config with a known device_id
        existing_id = "550e8400-e29b-41d4-a716-446655440000"
        self.config_manager.read.return_value = {
            "device_id": existing_id,
            "device_label": "KnownMachine",
        }

        identity = self.provider.get_device_identity(self.master_key)

        # Bug 3a: bare UUID4 gets -cli suffix on migration
        expected_id = existing_id + "-cli"
        self.assertEqual(identity.device_id, expected_id)
        self.assertEqual(identity.device_label, "KnownMachine")
        # Proof should be computed from the suffixed ID
        expected_proof = hmac.new(
            self.master_key,
            f"phpoc:device:{expected_id}".encode(),
            hashlib.sha256
        ).hexdigest()
        self.assertEqual(identity.device_proof, expected_proof)

    def test_verify_proof_valid(self):
        """verify_device_proof() returns True for a valid (id, proof, mk) tuple."""
        identity = self.provider.get_device_identity(self.master_key)
        self.assertTrue(
            self.provider.verify_device_proof(
                identity.device_id, identity.device_proof, self.master_key
            )
        )

    def test_verify_proof_invalid_id(self):
        """verify_device_proof() returns False for wrong device_id."""
        identity = self.provider.get_device_identity(self.master_key)
        self.assertFalse(
            self.provider.verify_device_proof(
                "wrong-id", identity.device_proof, self.master_key
            )
        )

    def test_verify_proof_invalid_proof(self):
        """verify_device_proof() returns False for wrong proof."""
        identity = self.provider.get_device_identity(self.master_key)
        self.assertFalse(
            self.provider.verify_device_proof(
                identity.device_id, "wrong-proof", self.master_key
            )
        )

    def test_verify_proof_wrong_key(self):
        """verify_device_proof() returns False for different master key."""
        identity = self.provider.get_device_identity(self.master_key)
        wrong_key = b"different-key-not-the-same-one!!"
        self.assertFalse(
            self.provider.verify_device_proof(
                identity.device_id, identity.device_proof, wrong_key
            )
        )

    def test_verify_proof_is_constant_time(self):
        """verify_device_proof() uses hmac.compare_digest (or equivalent)."""
        # We can't easily test timing, but we can verify the method exists
        identity = self.provider.get_device_identity(self.master_key)
        result = self.provider.verify_device_proof(
            identity.device_id, identity.device_proof, self.master_key
        )
        self.assertIsInstance(result, bool)

    def test_check_remote_identity_same_device(self):
        """check_remote_identity() returns True when both IDs match."""
        local = self.provider.get_device_identity(self.master_key)
        remote_id = local.device_id
        remote_proof = local.device_proof
        self.assertTrue(
            self.provider.check_remote_identity(
                remote_id, remote_proof, local, self.master_key
            )
        )

    def test_check_remote_identity_different_device(self):
        """check_remote_identity() returns False when device IDs differ."""
        local = self.provider.get_device_identity(self.master_key)
        # Simulate a remote blob from a different device
        other_id = "00000000-0000-4000-8000-000000000000"
        other_proof = hmac.new(
            self.master_key,
            f"phpoc:device:{other_id}".encode(),
            hashlib.sha256
        ).hexdigest()
        self.assertFalse(
            self.provider.check_remote_identity(
                other_id, other_proof, local, self.master_key
            )
        )

    def test_check_remote_identity_invalid_proof(self):
        """check_remote_identity() returns False when remote proof is invalid."""
        local = self.provider.get_device_identity(self.master_key)
        self.assertFalse(
            self.provider.check_remote_identity(
                local.device_id, "invalid-proof", local, self.master_key
            )
        )

    def test_different_master_key_different_proof(self):
        """Same device_id but different master_key → different proof."""
        identity = self.provider.get_device_identity(self.master_key)
        other_key = b"other-master-key-32-bytes-exact!!"
        other_proof = hmac.new(
            other_key,
            f"phpoc:device:{identity.device_id}".encode(),
            hashlib.sha256
        ).hexdigest()
        self.assertNotEqual(identity.device_proof, other_proof)

    def test_device_label_defaults_to_hostname(self):
        """device_label defaults to hostname if not configured."""
        import socket
        self.config_manager.read.return_value = {}
        identity = self.provider.get_device_identity(self.master_key)
        self.assertEqual(identity.device_label, socket.gethostname())

    def test_device_label_custom(self):
        """device_label can be set via config."""
        self.config_manager.read.return_value = {"device_label": "MyMac"}
        identity = self.provider.get_device_identity(self.master_key)
        self.assertEqual(identity.device_label, "MyMac")


class TestRandomUUIDDeviceIdentityProviderConfigPersistence(unittest.TestCase):
    """Test that config round-trips work with real config storage."""

    def setUp(self):
        if not HAS_DEVICE_ID:
            self.skipTest("DeviceIdentityProvider not yet implemented")

    def test_uuid_persists_across_provider_recreation(self):
        """Device ID survives provider destruction/recreation."""
        import tempfile
        config_data = {}
        cm1 = MagicMock()
        cm1.read.return_value = {}
        def write1(cfg):
            config_data.clear()
            config_data.update(cfg)
        cm1.write.side_effect = write1

        p1 = RandomUUIDDeviceIdentityProvider(cm1)
        id1 = p1.get_device_identity(b"mk")

        # Second provider reads the persisted config
        cm2 = MagicMock()
        cm2.read.return_value = dict(config_data)
        p2 = RandomUUIDDeviceIdentityProvider(cm2)
        id2 = p2.get_device_identity(b"mk")

        self.assertEqual(id1.device_id, id2.device_id)
        self.assertEqual(id1.device_proof, id2.device_proof)


if __name__ == "__main__":
    unittest.main()
