"""I-01 Key Rotation — Phase 2 RED: Crypto layer tests (Groups A + B).

Tests versioned MK derivation and sub-key derivation per version.

Group A: Versioned MK Derivation (10 tests)
Group B: Sub-Key Derivation per Version (10 tests)
"""

import unittest
import hashlib
import hmac
import os


# ── Expected future API ───────────────────────────────────────────
# These imports will exist after Phase 3 implementation.

HAS_I01_CRYPTO = False
try:
    from security.crypto import CryptoManager, derive_mk
    HAS_I01_CRYPTO = True
except (ImportError, ModuleNotFoundError):
    CryptoManager = None
    derive_mk = None


def skip_unless_i01_crypto():
    if not HAS_I01_CRYPTO:
        raise unittest.SkipTest("I-01 crypto layer not yet implemented")


# ══════════════════════════════════════════════════════════════════
# Group A: Versioned MK Derivation
# ══════════════════════════════════════════════════════════════════

class TestDeriveMk(unittest.TestCase):
    """Tests for the standalone derive_mk(seed, version) function."""

    def setUp(self):
        self.seed = os.urandom(32)
        self.seed_b = os.urandom(32)

    # ── A1: Deterministic output ──────────────────────────────

    def test_a1_derive_mk_is_deterministic(self):
        """A1: derive_mk(seed, 1) returns deterministic 32-byte output for same inputs."""
        skip_unless_i01_crypto()
        mk1 = derive_mk(self.seed, 1)
        mk2 = derive_mk(self.seed, 1)
        self.assertEqual(len(mk1), 32)
        self.assertEqual(mk1, mk2)
        self.assertIsInstance(mk1, bytes)

    # ── A2: Version separation ────────────────────────────────

    def test_a2_version_separation(self):
        """A2: derive_mk(seed, 1) != derive_mk(seed, 2) for same seed."""
        skip_unless_i01_crypto()
        mk1 = derive_mk(self.seed, 1)
        mk2 = derive_mk(self.seed, 2)
        self.assertNotEqual(mk1, mk2)

    # ── A3: Seed separation ───────────────────────────────────

    def test_a3_seed_separation(self):
        """A3: derive_mk(seed_a, 1) != derive_mk(seed_b, 1) for different seeds."""
        skip_unless_i01_crypto()
        mk_a = derive_mk(self.seed, 1)
        mk_b = derive_mk(self.seed_b, 1)
        self.assertNotEqual(mk_a, mk_b)

    # ── A4: Backward compat — version 0 = raw seed ────────────

    def test_a4_version_zero_returns_raw_seed(self):
        """A4: derive_mk(seed, 0) returns the raw seed bytes (pre-ADR backward compat)."""
        skip_unless_i01_crypto()
        mk0 = derive_mk(self.seed, 0)
        self.assertEqual(mk0, self.seed)
        self.assertEqual(len(mk0), 32)

    # ── A5: HMAC-SHA256 domain separation ─────────────────────

    def test_a5_hmac_domain_separation(self):
        """A5: derive_mk(seed, N) for N>0 uses HMAC-SHA256 with domain-separated
        message 'phpoc:mk:v{N}'."""
        skip_unless_i01_crypto()
        actual = derive_mk(self.seed, 1)
        expected = hmac.new(self.seed, b"phpoc:mk:v1", hashlib.sha256).digest()
        self.assertEqual(actual, expected)

    def test_a5_domain_separation_v3(self):
        """A5 (variant): derive_mk for version 3 uses message 'phpoc:mk:v3'."""
        skip_unless_i01_crypto()
        actual = derive_mk(self.seed, 3)
        expected = hmac.new(self.seed, b"phpoc:mk:v3", hashlib.sha256).digest()
        self.assertEqual(actual, expected)

    # ── A6: Forward security (HMAC non-invertibility) ─────────

    def test_a6_cannot_compute_v1_from_v2(self):
        """A6: derive_mk(seed, 1) cannot be computed from derive_mk(seed, 2) alone."""
        skip_unless_i01_crypto()
        mk_v2 = derive_mk(self.seed, 2)
        # Attempt to derive v1 from v2 (should NOT match real v1)
        wrong = hmac.new(mk_v2, b"phpoc:mk:v1", hashlib.sha256).digest()
        real_v1 = derive_mk(self.seed, 1)
        self.assertNotEqual(wrong, real_v1)

    # ── A7: No version ceiling ────────────────────────────────

    def test_a7_no_version_ceiling(self):
        """A7: derive_mk(seed, 999) produces valid 32 bytes."""
        skip_unless_i01_crypto()
        mk = derive_mk(self.seed, 999)
        self.assertEqual(len(mk), 32)
        self.assertIsInstance(mk, bytes)

    # ── A8: Input validation — string version ─────────────────

    def test_a8_string_version_raises_type_error(self):
        """A8: derive_mk(seed, '1') raises TypeError or produces consistent result."""
        skip_unless_i01_crypto()
        with self.assertRaises((TypeError, AssertionError)):
            derive_mk(self.seed, "1")  # pyright: ignore[reportArgumentType]

    # ── A9: Seed length validation ────────────────────────────

    def test_a9_short_seed_raises_value_error(self):
        """A9: derive_mk(seed, 1) with 31-byte seed raises ValueError."""
        skip_unless_i01_crypto()
        with self.assertRaises(ValueError):
            derive_mk(b"\x00" * 31, 1)

    # ── A10: CryptoManager stores key_version ─────────────────

    def test_a10_crypto_manager_stores_key_version(self):
        """A10: CryptoManager(mk, key_version=2) stores both mk and version."""
        skip_unless_i01_crypto()
        mk = os.urandom(32)
        cm = CryptoManager(mk, key_version=2)
        self.assertEqual(cm.master_key, mk)
        self.assertEqual(cm.key_version, 2)


# ══════════════════════════════════════════════════════════════════
# Group B: Sub-Key Derivation per Version
# ══════════════════════════════════════════════════════════════════

class TestSubKeyDerivationPerVersion(unittest.TestCase):
    """Tests that sub-keys change with MK version."""

    def setUp(self):
        self.seed = os.urandom(32)
        # Derive keys using expected algorithm for assertion values
        self.mk_v0 = self.seed  # raw seed
        self.mk_v1 = hmac.new(self.seed, b"phpoc:mk:v1", hashlib.sha256).digest()
        self.mk_v2 = hmac.new(self.seed, b"phpoc:mk:v2", hashlib.sha256).digest()

    # ── B1: Sub-keys change with version ──────────────────────

    def test_b1_derive_sub_key_differs_per_version(self):
        """B1: _derive_sub_key(salt) with versioned MK produces different output
        than with v0 MK."""
        skip_unless_i01_crypto()
        cm0 = CryptoManager(self.mk_v0, key_version=0)
        cm1 = CryptoManager(self.mk_v1, key_version=1)
        salt = b"test-salt"
        sk0 = cm0._derive_sub_key(salt)
        sk1 = cm1._derive_sub_key(salt)
        self.assertNotEqual(sk0, sk1)

    # ── B2: Seal changes with version ─────────────────────────

    def test_b2_seal_differs_per_version(self):
        """B2: seal() output differs between MK_v1 and MK_v2 on same data."""
        skip_unless_i01_crypto()
        cm1 = CryptoManager(self.mk_v1, key_version=1)
        cm2 = CryptoManager(self.mk_v2, key_version=2)
        data = '{"test": "data"}'
        s1 = cm1.seal(data)
        s2 = cm2.seal(data)
        self.assertNotEqual(s1, s2)

    # ── B3: Encrypt changes with version ──────────────────────

    def test_b3_encrypt_differs_per_version(self):
        """B3: encrypt() of same plaintext with MK_v1 vs MK_v2 produces
        different ciphertext."""
        skip_unless_i01_crypto()
        cm1 = CryptoManager(self.mk_v1, key_version=1)
        cm2 = CryptoManager(self.mk_v2, key_version=2)
        c1 = cm1.encrypt("hello")
        c2 = cm2.encrypt("hello")
        self.assertNotEqual(c1, c2)

    # ── B4: Index key changes with version ────────────────────

    def test_b4_index_key_differs_per_version(self):
        """B4: derive_index_key(mk_v1) != derive_index_key(mk_v2)."""
        skip_unless_i01_crypto()
        from security.crypto import derive_index_key
        ik1 = derive_index_key(self.mk_v1)
        ik2 = derive_index_key(self.mk_v2)
        self.assertNotEqual(ik1, ik2)
        self.assertEqual(len(ik1), 16)
        self.assertEqual(len(ik2), 16)

    # ── B5: Field key changes with version ────────────────────

    def test_b5_field_key_differs_per_version(self):
        """B5: derive_field_key(mk_v1) != derive_field_key(mk_v2)."""
        skip_unless_i01_crypto()
        from security.crypto import derive_field_key
        fk1 = derive_field_key(self.mk_v1)
        fk2 = derive_field_key(self.mk_v2)
        self.assertNotEqual(fk1, fk2)
        self.assertEqual(len(fk1), 16)
        self.assertEqual(len(fk2), 16)

    # ── B6: Index key domain separator ────────────────────────

    def test_b6_index_key_domain_separator(self):
        """B6: derive_index_key(mk) uses domain separator 'phpoc-blind-index-v1'."""
        skip_unless_i01_crypto()
        # Verify via independent computation
        expected = hmac.new(self.mk_v1, b"phpoc-blind-index-v1",
                            hashlib.sha256).digest()[:16]
        from security.crypto import derive_index_key
        self.assertEqual(derive_index_key(self.mk_v1), expected)

    # ── B7: Field key domain separator ────────────────────────

    def test_b7_field_key_domain_separator(self):
        """B7: derive_field_key(mk) uses domain separator 'phpoc-staging-keys-v1'."""
        skip_unless_i01_crypto()
        expected = hmac.new(self.mk_v1, b"phpoc-staging-keys-v1",
                            hashlib.sha256).digest()[:16]
        from security.crypto import derive_field_key
        self.assertEqual(derive_field_key(self.mk_v1), expected)

    # ── B8: Seal key salt ─────────────────────────────────────

    def test_b8_seal_key_uses_integrity_salt(self):
        """B8: Seal key derivation uses salt 'integrity-key-salt' (unchanged)."""
        skip_unless_i01_crypto()
        cm = CryptoManager(self.mk_v1, key_version=1)
        expected = hmac.new(self.mk_v1, b"integrity-key-salt",
                            hashlib.sha256).digest()[:32]
        actual = cm._derive_sub_key(b"integrity-key-salt", 32)
        self.assertEqual(actual, expected)

    # ── B9: Cookie key changes with version ───────────────────

    def test_b9_cookie_key_differs_per_version(self):
        """B9: Cookie key derivation uses salt 'phpoc:cookie-key' with versioned MK."""
        skip_unless_i01_crypto()
        cm1 = CryptoManager(self.mk_v1, key_version=1)
        cm2 = CryptoManager(self.mk_v2, key_version=2)
        ck1 = cm1._derive_sub_key(b"phpoc:cookie-key", 32)
        ck2 = cm2._derive_sub_key(b"phpoc:cookie-key", 32)
        self.assertNotEqual(ck1, ck2)

    # ── B10: Same-version roundtrip ───────────────────────────

    def test_b10_same_version_roundtrip(self):
        """B10: decrypt() with MK_v1 correctly decrypts data encrypted with MK_v1."""
        skip_unless_i01_crypto()
        cm = CryptoManager(self.mk_v1, key_version=1)
        plaintext = "roundtrip test data"
        ciphertext = cm.encrypt(plaintext)
        decrypted = cm.decrypt(ciphertext)
        self.assertEqual(decrypted, plaintext)


if __name__ == "__main__":
    unittest.main()
