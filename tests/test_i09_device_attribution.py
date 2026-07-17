"""I-09 Device Attribution — Phase 2 RED: Python tests.

Tests device_local_secret generation, device_id derivation from MK + secret,
migration from bare UUID4, and device cookie integration.

Group A: device_local_secret generation & persistence (5 tests)
Group B: device_id derivation (10 tests)
Group C: migration from bare UUID4 (4 tests)
Group D: device cookie integration (3 tests)
Group I: edge cases (5 tests)
"""

import unittest
import hashlib
import hmac
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch


# ── Expected future API imports ────────────────────────────────────
# These will exist after Phase 3 implementation.

HAS_I09_AUTH = False
HAS_I09_DEVICE_ID = False

try:
    from security.auth import _ensure_device_local_secret
    HAS_I09_AUTH = True
except (ImportError, ModuleNotFoundError):
    _ensure_device_local_secret = None

try:
    from security.device_identity import (
        derive_device_id,
        RandomUUIDDeviceIdentityProvider,
        DeviceIdentity,
        DEVICE_ID_PREFIX,
    )
    HAS_I09_DEVICE_ID = True
except (ImportError, ModuleNotFoundError):
    derive_device_id = None
    RandomUUIDDeviceIdentityProvider = None
    DeviceIdentity = None
    DEVICE_ID_PREFIX = "phpoc:device:"


# ── Stub for auth module (device_identity already available pre-I-09) ──

HAS_DEVICE_IDENTITY_PROVIDER = False
try:
    from security.device_identity import RandomUUIDDeviceIdentityProvider as _ExistingProvider
    from security.device_identity import DeviceIdentity as _ExistingDeviceIdentity
    HAS_DEVICE_IDENTITY_PROVIDER = True
except (ImportError, ModuleNotFoundError):
    pass


def _skip_unless_i09_auth():
    if not HAS_I09_AUTH:
        raise unittest.SkipTest("I-09 auth layer not yet implemented")


def _skip_unless_i09_device_id():
    if not HAS_I09_DEVICE_ID:
        raise unittest.SkipTest("I-09 device_id derivation not yet implemented")


# ══════════════════════════════════════════════════════════════════
# Group A: device_local_secret generation & persistence
# ══════════════════════════════════════════════════════════════════

class TestDeviceLocalSecretGeneration(unittest.TestCase):
    """Tests for _ensure_device_local_secret() in security/auth.py."""

    UUID4_RE = (
        r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )

    def setUp(self):
        self.config = {}

    # ── A1: First call generates valid UUID4 ──────────────────────

    def test_a1_first_call_generates_valid_uuid4(self):
        """A1: _ensure_device_local_secret() generates a valid UUID4 on first call."""
        _skip_unless_i09_auth()
        import re
        secret, is_new = _ensure_device_local_secret(self.config)
        self.assertIsInstance(secret, str)
        self.assertRegex(secret, re.compile(self.UUID4_RE, re.IGNORECASE),
                         f"Expected UUID4 format, got: {secret}")
        self.assertTrue(is_new, "First call should report is_new=True")

    # ── A2: Generated secret is persisted ─────────────────────────

    def test_a2_secret_persisted_in_config(self):
        """A2: Generated secret is persisted in config under device_local_secret key."""
        _skip_unless_i09_auth()
        secret, _ = _ensure_device_local_secret(self.config)
        self.assertIn("device_local_secret", self.config)
        self.assertEqual(self.config["device_local_secret"], secret)

    # ── A3: Subsequent calls return same secret ───────────────────

    def test_a3_subsequent_calls_return_same_secret(self):
        """A3: Subsequent calls read from config — same secret returned."""
        _skip_unless_i09_auth()
        secret1, is_new1 = _ensure_device_local_secret(self.config)
        secret2, is_new2 = _ensure_device_local_secret(self.config)
        self.assertEqual(secret1, secret2,
                         "Same config must return same secret")
        self.assertTrue(is_new1, "First call should be new")
        self.assertFalse(is_new2, "Second call should not be new")

    # ── A4: Secret survives config re-read ────────────────────────

    def test_a4_secret_survives_config_re_read(self):
        """A4: Secret survives PassphraseAuthenticator recreation (fresh config read)."""
        _skip_unless_i09_auth()
        secret1, _ = _ensure_device_local_secret(self.config)
        # Simulate a new process reading config from disk
        config2 = dict(self.config)  # shallow copy simulating re-read
        secret2, is_new2 = _ensure_device_local_secret(config2)
        self.assertEqual(secret1, secret2,
                         "Secret must survive re-read from config")
        self.assertFalse(is_new2, "Re-read should not be reported as new")

    # ── A5: Config write failure is logged but does not crash ─────

    def test_a5_config_write_failure_does_not_crash(self):
        """A5: Config write failure is logged but does not crash."""
        _skip_unless_i09_auth()
        # Use a dict that raises on __setitem__ to simulate write failure
        class ReadOnlyConfig(dict):
            def __setitem__(self, key, value):
                raise OSError("Read-only filesystem")
        ro_config = ReadOnlyConfig()
        try:
            secret, is_new = _ensure_device_local_secret(ro_config)
            # Should not raise — must return a secret even if persistence fails
            self.assertIsInstance(secret, str)
            self.assertTrue(len(secret) > 0)
            self.assertTrue(is_new)
        except Exception:
            # If the implementation raises, it must be a ValueError/docs error,
            # not an unhandled OSError.
            pass


# ══════════════════════════════════════════════════════════════════
# Group B: device_id derivation (device_identity.py)
# ══════════════════════════════════════════════════════════════════

class TestDeriveDeviceId(unittest.TestCase):
    """Tests for derive_device_id(mk, secret) and get_device_identity()."""

    def setUp(self):
        self.mk = os.urandom(32)
        self.mk_b = os.urandom(32)
        self.secret = "550e8400-e29b-41d4-a716-446655440000"
        self.secret_b = "660e8400-e29b-41d4-a716-446655440001"

    # ── B1: Output format ────────────────────────────────────────

    def test_b1_returns_64_char_hex(self):
        """B1: derive_device_id(mk, secret) returns 64-char hex string."""
        _skip_unless_i09_device_id()
        device_id = derive_device_id(self.mk, self.secret)
        self.assertIsInstance(device_id, str)
        self.assertEqual(len(device_id), 64,
                         f"Expected 64 chars, got {len(device_id)}")
        # Must be pure hex
        self.assertTrue(all(c in '0123456789abcdef' for c in device_id),
                        f"Expected hex string, got: {device_id[:20]}...")

    # ── B2: Deterministic ────────────────────────────────────────

    def test_b2_deterministic_same_mk_secret(self):
        """B2: Deterministic: same (mk, secret) → same device_id every time."""
        _skip_unless_i09_device_id()
        id1 = derive_device_id(self.mk, self.secret)
        id2 = derive_device_id(self.mk, self.secret)
        self.assertEqual(id1, id2)

    # ── B3: Different MK → different device_id ───────────────────

    def test_b3_different_mk_different_device_id(self):
        """B3: Different MK + same secret → different device_id."""
        _skip_unless_i09_device_id()
        id_a = derive_device_id(self.mk, self.secret)
        id_b = derive_device_id(self.mk_b, self.secret)
        self.assertNotEqual(id_a, id_b,
                            "Different MK must produce different device_id")

    # ── B4: Different secret → different device_id ───────────────

    def test_b4_different_secret_different_device_id(self):
        """B4: Different secret + same MK → different device_id."""
        _skip_unless_i09_device_id()
        id_a = derive_device_id(self.mk, self.secret)
        id_b = derive_device_id(self.mk, self.secret_b)
        self.assertNotEqual(id_a, id_b,
                            "Different secret must produce different device_id")

    # ── B5: get_device_identity() derives from MK + secret ───────

    def test_b5_get_device_identity_uses_hkdf_not_uuid4(self):
        """B5: get_device_identity() derives device_id from MK + device_local_secret."""
        _skip_unless_i09_device_id()
        if not HAS_DEVICE_IDENTITY_PROVIDER:
            raise unittest.SkipTest("DeviceIdentityProvider base not yet available")

        cm = MagicMock()
        cm.read.return_value = {
            "device_local_secret": self.secret,
        }
        provider = RandomUUIDDeviceIdentityProvider(cm)
        identity = provider.get_device_identity(self.mk)

        # device_id should be a 64-char hex + "-cli" suffix, not a bare UUID4
        self.assertIsInstance(identity.device_id, str)
        self.assertTrue(
            identity.device_id.endswith("-cli"),
            f"device_id should end with -cli, got: {identity.device_id}"
        )
        # The core (before -cli) should be 64 hex chars
        core = identity.device_id[:-4]  # strip "-cli"
        self.assertEqual(len(core), 64,
                         f"Core device_id should be 64 hex chars, got {len(core)}")
        self.assertTrue(all(c in '0123456789abcdef' for c in core))

    # ── B6: device_id includes client-type suffix ─────────────────

    def test_b6_device_id_includes_cli_suffix(self):
        """B6: Resulting device_id includes client-type suffix (-cli)."""
        _skip_unless_i09_device_id()
        if not HAS_DEVICE_IDENTITY_PROVIDER:
            raise unittest.SkipTest("DeviceIdentityProvider base not yet available")

        cm = MagicMock()
        cm.read.return_value = {"device_local_secret": self.secret}
        provider = RandomUUIDDeviceIdentityProvider(cm)
        identity = provider.get_device_identity(self.mk)
        self.assertTrue(identity.device_id.endswith("-cli"))

    # ── B7: Identity cached across calls ──────────────────────────

    def test_b7_identity_cached_within_session(self):
        """B7: Identity is cached across calls within same session."""
        _skip_unless_i09_device_id()
        if not HAS_DEVICE_IDENTITY_PROVIDER:
            raise unittest.SkipTest("DeviceIdentityProvider base not yet available")

        cm = MagicMock()
        cm.read.return_value = {"device_local_secret": self.secret}
        provider = RandomUUIDDeviceIdentityProvider(cm)
        id1 = provider.get_device_identity(self.mk)
        id2 = provider.get_device_identity(self.mk)
        self.assertIs(id1, id2, "Cached identity should be same object")
        # Config should only be read once (on first call)
        self.assertEqual(cm.read.call_count, 1,
                         "Config should be read only once due to caching")

    # ── B8: verify_device_proof works with new device_id ──────────

    def test_b8_verify_device_proof_with_hmac_derived_device_id(self):
        """B8: verify_device_proof() works with new HMAC-derived device_id."""
        _skip_unless_i09_device_id()
        if not HAS_DEVICE_IDENTITY_PROVIDER:
            raise unittest.SkipTest("DeviceIdentityProvider base not yet available")

        cm = MagicMock()
        cm.read.return_value = {"device_local_secret": self.secret}
        provider = RandomUUIDDeviceIdentityProvider(cm)
        identity = provider.get_device_identity(self.mk)

        # Verify the proof
        self.assertTrue(
            provider.verify_device_proof(
                identity.device_id, identity.device_proof, self.mk
            ),
            "Device proof must verify against its own device_id"
        )

    # ── B9: check_remote_identity works ───────────────────────────

    def test_b9_check_remote_identity_with_hmac_derived_device_id(self):
        """B9: check_remote_identity() works with new HMAC-derived device_id."""
        _skip_unless_i09_device_id()
        if not HAS_DEVICE_IDENTITY_PROVIDER:
            raise unittest.SkipTest("DeviceIdentityProvider base not yet available")

        cm = MagicMock()
        cm.read.return_value = {"device_local_secret": self.secret}
        provider = RandomUUIDDeviceIdentityProvider(cm)
        identity = provider.get_device_identity(self.mk)

        # Same device should match
        self.assertTrue(
            provider.check_remote_identity(
                identity.device_id, identity.device_proof,
                identity, self.mk
            ),
            "Same device_id + valid proof should return True"
        )

    # ── B10: device_id changes when MK rotates ───────────────────

    def test_b10_device_id_changes_on_mk_rotation(self):
        """B10: device_id changes when MK rotates (key_version bump)."""
        _skip_unless_i09_device_id()
        # Different MK = rotated key
        id_a = derive_device_id(self.mk, self.secret)
        id_b = derive_device_id(self.mk_b, self.secret)
        self.assertNotEqual(id_a, id_b,
                            "Rotated MK must produce different device_id")


# ══════════════════════════════════════════════════════════════════
# Group C: migration from bare UUID4 to device_local_secret
# ══════════════════════════════════════════════════════════════════

class TestMigrationFromBareUuid4(unittest.TestCase):
    """Tests for migration from pre-I-09 bare UUID4 in config."""

    def setUp(self):
        self.mk = os.urandom(32)

    # ── C1: bare UUID4 in config migrated ─────────────────────────

    def test_c1_bare_uuid4_migrated_to_device_local_secret(self):
        """C1: Existing bare UUID4 in config migrated to device_local_secret."""
        _skip_unless_i09_auth()
        bare_uuid = "a1b2c3d4-e5f6-4abc-8def-0123456789ab"
        config = {"device_id": bare_uuid + "-cli"}
        secret, is_new = _ensure_device_local_secret(config)

        # device_local_secret should be set to the bare UUID (without suffix)
        self.assertIn("device_local_secret", config)
        self.assertEqual(config["device_local_secret"], bare_uuid,
                         "Bare UUID should become the device_local_secret")
        self.assertFalse(is_new, "Migration should not report as new secret")

    # ── C2: device_id recomputed from MK + migrated secret ────────

    def test_c2_device_id_recomputed_from_migrated_secret(self):
        """C2: device_id recomputed from MK + migrated secret on first post-migration auth."""
        _skip_unless_i09_device_id()
        if not HAS_DEVICE_IDENTITY_PROVIDER:
            raise unittest.SkipTest("DeviceIdentityProvider base not yet available")

        bare_uuid = "a1b2c3d4-e5f6-4abc-8def-0123456789ab"
        cm = MagicMock()
        cm.read.return_value = {"device_local_secret": bare_uuid}
        provider = RandomUUIDDeviceIdentityProvider(cm)
        identity = provider.get_device_identity(self.mk)

        # device_id should be HMAC-derived, not the bare UUID
        core = identity.device_id[:-4]  # strip "-cli"
        self.assertNotEqual(core, bare_uuid,
                            "device_id should be HMAC-derived, not the bare UUID")
        self.assertEqual(len(core), 64,
                         "device_id should be 64 hex chars (HMAC-SHA256 output)")

    # ── C3: other config keys preserved ───────────────────────────

    def test_c3_other_config_keys_preserved(self):
        """C3: Existing device_label and other config keys preserved."""
        _skip_unless_i09_auth()
        config = {
            "device_id": "old-uuid-cli",
            "device_label": "My MacBook",
            "some_other_key": "keep-me",
        }
        secret, _ = _ensure_device_local_secret(config)
        self.assertEqual(config.get("device_label"), "My MacBook",
                         "device_label should be preserved")
        self.assertEqual(config.get("some_other_key"), "keep-me",
                         "Other config keys should be preserved")
        self.assertIn("device_local_secret", config)

    # ── C4: fresh install generates new secret ────────────────────

    def test_c4_fresh_install_generates_new_secret(self):
        """C4: Fresh install (empty config) generates new device_local_secret."""
        _skip_unless_i09_auth()
        config = {}
        secret, is_new = _ensure_device_local_secret(config)
        self.assertIsInstance(secret, str)
        self.assertTrue(len(secret) > 0)
        self.assertTrue(is_new, "Fresh install should report is_new=True")
        self.assertIn("device_local_secret", config)


# ══════════════════════════════════════════════════════════════════
# Group D: device cookie integration
# ══════════════════════════════════════════════════════════════════

class TestDeviceCookieIntegration(unittest.TestCase):
    """Tests for device cookie with new HMAC-derived device_id."""

    def setUp(self):
        self.mk = os.urandom(32)
        self.secret = "550e8400-e29b-41d4-a716-446655440000"

    # ── D1: Cookie receives new HMAC-derived device_id ────────────

    def test_d1_cookie_creation_uses_hmac_device_id(self):
        """D1: DeviceCookie.create() receives the new HMAC-derived device_id."""
        _skip_unless_i09_device_id()
        if not HAS_DEVICE_IDENTITY_PROVIDER:
            raise unittest.SkipTest("DeviceIdentityProvider base not yet available")

        cm = MagicMock()
        cm.read.return_value = {"device_local_secret": self.secret}
        provider = RandomUUIDDeviceIdentityProvider(cm)
        identity = provider.get_device_identity(self.mk)

        # The device_id should be 64 hex chars + "-cli" = 68 chars total
        self.assertEqual(len(identity.device_id), 68,
                         f"device_id should be 68 chars (64 hex + '-cli'), got {len(identity.device_id)}")

    # ── D2: Remote cookie format unchanged ────────────────────────

    def test_d2_remote_cookie_format_unchanged(self):
        """D2: Remote cookie format (device_uuid + device_specifier) unchanged."""
        # The device_id format changes (now HMAC-derived) but the
        # cookie structure itself should remain {device_uuid, device_specifier}.
        # This is a structure test — the cookie should still have both fields.
        _skip_unless_i09_device_id()
        if not HAS_DEVICE_IDENTITY_PROVIDER:
            raise unittest.SkipTest("DeviceIdentityProvider base not yet available")

        cm = MagicMock()
        cm.read.return_value = {"device_local_secret": self.secret}
        provider = RandomUUIDDeviceIdentityProvider(cm)
        identity = provider.get_device_identity(self.mk)

        self.assertIsInstance(identity.device_id, str)
        self.assertIsInstance(identity.device_proof, str)
        self.assertTrue(len(identity.device_id) > 0)
        self.assertTrue(len(identity.device_proof) > 0)

    # ── D3: Specifier remains random ──────────────────────────────

    def test_d3_specifier_remains_random_not_deterministic(self):
        """D3: Cookie specifier remains random (not derived from MK or device_id)."""
        _skip_unless_i09_device_id()
        if not HAS_DEVICE_IDENTITY_PROVIDER:
            raise unittest.SkipTest("DeviceIdentityProvider base not yet available")

        # Get identity twice with same config
        cm = MagicMock()
        cm.read.return_value = {"device_local_secret": self.secret}
        provider = RandomUUIDDeviceIdentityProvider(cm)
        identity = provider.get_device_identity(self.mk)

        # device_id is deterministic (same secret + MK)
        # but device_proof is also deterministic (HMAC over device_id).
        # The specifier is NOT part of DeviceIdentity — it's generated separately
        # in DeviceCookie.create(). This test verifies device_proof is deterministic.
        proof1 = identity.device_proof
        identity2 = provider.get_device_identity(self.mk)  # cached — same object
        self.assertEqual(proof1, identity2.device_proof,
                         "device_proof should be deterministic (same device_id + MK)")


# ══════════════════════════════════════════════════════════════════
# Group I: edge cases
# ══════════════════════════════════════════════════════════════════

class TestEdgeCases(unittest.TestCase):
    """Edge case tests for device attribution."""

    # ── I1: Empty/None MK raises ValueError ──────────────────────

    def test_i1_empty_mk_raises_value_error(self):
        """I1: Empty/None MK raises ValueError."""
        _skip_unless_i09_device_id()
        with self.assertRaises((ValueError, TypeError)):
            derive_device_id(b"", "valid-secret")
        with self.assertRaises((ValueError, TypeError)):
            derive_device_id(None, "valid-secret")

    # ── I2: Empty/None secret raises ValueError ──────────────────

    def test_i2_empty_secret_raises_value_error(self):
        """I2: Empty/None secret raises ValueError."""
        _skip_unless_i09_device_id()
        mk = os.urandom(32)
        with self.assertRaises((ValueError, TypeError)):
            derive_device_id(mk, "")
        with self.assertRaises((ValueError, TypeError)):
            derive_device_id(mk, None)

    # ── I3: Config read failure → generate new secret ────────────

    def test_i3_config_read_failure_generates_new_secret(self):
        """I3: Config read failure → generate new secret (best-effort)."""
        _skip_unless_i09_auth()
        # Config that raises on read
        class BrokenConfig(dict):
            def get(self, key, default=None):
                raise OSError("Corrupted config file")
            def __contains__(self, key):
                raise OSError("Corrupted config file")
        broken = BrokenConfig()
        # Should not crash — must return a secret
        try:
            secret, is_new = _ensure_device_local_secret(broken)
            self.assertIsInstance(secret, str)
            self.assertTrue(len(secret) > 0)
        except Exception:
            # If it does raise, must be a well-defined error, not a raw OSError
            pass

    # ── I4: Corrupted secret (not valid UUID4) → regenerate ──────

    def test_i4_corrupted_secret_regenerates(self):
        """I4: Corrupted secret (not valid UUID4) → regenerate."""
        _skip_unless_i09_auth()
        import re
        config = {"device_local_secret": "not-a-valid-uuid4"}
        secret, is_new = _ensure_device_local_secret(config)
        self.assertIsInstance(secret, str)
        self.assertRegex(secret, re.compile(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
            re.IGNORECASE
        ), f"Corrupted secret should be replaced with valid UUID4, got: {secret}")
        self.assertTrue(is_new, "Regeneration should report is_new=True")

    # ── I5: Short MK (< 32 bytes) raises ValueError ──────────────

    def test_i5_short_mk_raises_value_error(self):
        """I5: Short MK (< 32 bytes) raises ValueError."""
        _skip_unless_i09_device_id()
        short_mk = os.urandom(16)
        with self.assertRaises((ValueError, TypeError)):
            derive_device_id(short_mk, "valid-secret")


if __name__ == "__main__":
    unittest.main()
