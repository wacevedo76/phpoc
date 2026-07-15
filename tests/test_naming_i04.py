"""
test_naming_i04.py — I-04 Phase 2 (RED): Naming convention tests.

Asserts the new HMAC naming convention (sign → mac, signature → identity_seal)
across security/crypto.py, domain/ledger/chain.py, and the block format.

These tests are intentionally RED — they assert the post-rename interface
that does not yet exist. They will turn GREEN in Phase 3 when the rename
is applied across code, tests, and spec.

Assertion IDs map to I-04:
  A1–A4: CryptoManager method names (mac / verify_mac)
  B1–B4: LedgerChain method names (compute_identity_mac / verify_identity_mac)
  C1–C4: Block dict field names (identity_seal instead of signature)
  D1–D3: NoAuthCryptoManager method names
"""

import unittest
import hashlib
import hmac

from security.crypto import CryptoManager, NoAuthCryptoManager, AbstractCryptoManager
from domain.ledger.chain import LedgerChain
from storage.file_store import LedgerStore


# ── Group A: CryptoManager method names ──────────────────────────────

class TestCryptoManagerNaming(unittest.TestCase):
    """A1–A4: CryptoManager must expose mac() and verify_mac(), not sign()."""

    def setUp(self):
        self.mk = hashlib.pbkdf2_hmac(
            "sha256", b"test-password", b"session-salt", 100, 32
        )
        self.manager = CryptoManager(self.mk)
        self.identity_secret = b"0123456789abcdef0123456789abcdef"

    # ── A1: mac() exists ─────────────────────────────────────────
    def test_A1_mac_method_exists(self):
        """CryptoManager must have mac() method."""
        self.assertTrue(
            hasattr(self.manager, "mac"),
            "CryptoManager missing mac() — must be renamed from sign()"
        )
        self.assertTrue(
            callable(self.manager.mac),
            "CryptoManager.mac must be callable"
        )

    # ── A2: mac() produces valid HMAC ────────────────────────────
    def test_A2_mac_produces_hex_digest(self):
        """mac() must produce a 64-char hex HMAC digest."""
        result = self.manager.mac("test data", self.identity_secret)
        self.assertIsInstance(result, str)
        self.assertEqual(len(result), 64, "mac() must return 64-char hex")
        # Must be valid hex
        int(result, 16)

    # ── A3: verify_mac() exists ──────────────────────────────────
    def test_A3_verify_mac_method_exists(self):
        """CryptoManager must have verify_mac() method."""
        self.assertTrue(
            hasattr(self.manager, "verify_mac"),
            "CryptoManager missing verify_mac() — must be renamed from verify_signature()"
        )
        self.assertTrue(
            callable(self.manager.verify_mac),
            "CryptoManager.verify_mac must be callable"
        )

    # ── A4: mac/verify_mac round-trip ────────────────────────────
    def test_A4_mac_verify_roundtrip(self):
        """mac() and verify_mac() must round-trip correctly."""
        data = "block_hash_value_for_testing"
        tag = self.manager.mac(data, self.identity_secret)
        self.assertTrue(
            self.manager.verify_mac(data, tag, self.identity_secret),
            "verify_mac must return True for a valid MAC tag"
        )
        self.assertFalse(
            self.manager.verify_mac(data + "x", tag, self.identity_secret),
            "verify_mac must return False for tampered data"
        )

    # ── A5: Old names must NOT exist ─────────────────────────────
    def test_A5_old_sign_method_absent(self):
        """CryptoManager must NOT expose sign() after rename."""
        self.assertFalse(
            hasattr(self.manager, "sign"),
            "CryptoManager still has sign() — rename to mac() is incomplete"
        )

    def test_A6_old_verify_signature_absent(self):
        """CryptoManager must NOT expose verify_signature() after rename."""
        self.assertFalse(
            hasattr(self.manager, "verify_signature"),
            "CryptoManager still has verify_signature() — rename to verify_mac() is incomplete"
        )


# ── Group B: LedgerChain method names ────────────────────────────────

class TestLedgerChainNaming(unittest.TestCase):
    """B1–B4: LedgerChain must use compute_identity_mac / verify_identity_mac."""

    def setUp(self):
        import tempfile
        import os
        from pathlib import Path
        self.tmpdir = tempfile.mkdtemp()
        store = LedgerStore(Path(os.path.join(self.tmpdir, "staging.json")), Path(os.path.join(self.tmpdir, "ledger.json")))
        self.mk = hashlib.pbkdf2_hmac(
            "sha256", b"test-password", b"session-salt", 100, 32
        )
        self.crypto = CryptoManager(self.mk)
        self.identity_secret = b"0123456789abcdef0123456789abcdef"
        self.chain = LedgerChain(self.crypto, store, self.identity_secret)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ── B1: compute_identity_mac exists ──────────────────────────
    def test_B1_compute_identity_mac_exists(self):
        """LedgerChain must have compute_identity_mac() method."""
        self.assertTrue(
            hasattr(self.chain, "compute_identity_mac"),
            "LedgerChain missing compute_identity_mac() — must be renamed from compute_signature()"
        )

    # ── B2: verify_identity_mac exists ───────────────────────────
    def test_B2_verify_identity_mac_exists(self):
        """LedgerChain must have verify_identity_mac() method."""
        self.assertTrue(
            hasattr(self.chain, "verify_identity_mac"),
            "LedgerChain missing verify_identity_mac() — must be renamed from verify_signature()"
        )

    # ── B3: compute_identity_mac produces hex ────────────────────
    def test_B3_compute_identity_mac_produces_result(self):
        """compute_identity_mac() must produce a hex string."""
        result = self.chain.compute_identity_mac("test_data", self.identity_secret)
        self.assertIsNotNone(result)
        self.assertIsInstance(result, str)

    # ── B4: Old names absent ─────────────────────────────────────
    def test_B4_old_compute_signature_absent(self):
        """LedgerChain must NOT have compute_signature() after rename."""
        self.assertFalse(
            hasattr(self.chain, "compute_signature"),
            "LedgerChain still has compute_signature() — rename to compute_identity_mac() is incomplete"
        )

    def test_B5_old_verify_signature_absent(self):
        """LedgerChain must NOT have verify_signature() after rename."""
        self.assertFalse(
            hasattr(self.chain, "verify_signature"),
            "LedgerChain still has verify_signature() — rename to verify_identity_mac() is incomplete"
        )


# ── Group C: Block dict field naming ─────────────────────────────────

class TestBlockFieldNaming(unittest.TestCase):
    """C1–C4: Block dicts must use identity_seal not signature."""

    def setUp(self):
        import tempfile
        import os
        from pathlib import Path
        self.tmpdir = tempfile.mkdtemp()
        store = LedgerStore(Path(os.path.join(self.tmpdir, "staging.json")), Path(os.path.join(self.tmpdir, "ledger.json")))
        self.mk = hashlib.pbkdf2_hmac(
            "sha256", b"test-password", b"session-salt", 100, 32
        )
        self.crypto = CryptoManager(self.mk)
        self.identity_secret = b"0123456789abcdef0123456789abcdef"
        self.chain = LedgerChain(self.crypto, store, self.identity_secret)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ── C1: build_day_block uses identity_seal ───────────────────
    def test_C1_day_block_uses_identity_seal_field(self):
        """build_day_block() must use 'identity_seal' not 'signature'."""
        # Build a genesis block first for prev_hash linkage
        from domain.ledger.engine import LedgerEngine
        from domain.ledger.index_manager import IndexManager
        from domain.ledger.summary_policy import SummaryPolicy

        # Minimal genesis: directly build a day block seeded from genesis
        genesis = self.chain.build_day_block([], "0" * 64, "2026-01-01")
        genesis["type"] = "genesis"
        # Override day_hash → block_hash for genesis (I-17)
        genesis["block_hash"] = genesis.pop("day_hash")
        # Remove any signature added by build_day_block (it uses old naming)
        if "signature" in genesis:
            del genesis["signature"]
        self.chain.append(genesis)

        # Now build a real day block
        prev_hash = hashlib.sha256(
            __import__("json").dumps(genesis, sort_keys=True).encode()
        ).hexdigest()
        # Use get_block_hash from helpers
        from domain.ledger.helpers import get_block_hash
        prev_hash = get_block_hash(genesis)

        entry = {
            "title": "Test Activity",
            "startTime_enc": self.crypto.encrypt("1717920000000"),
            "endTime_enc": self.crypto.encrypt("1717923600000"),
            "duration": 3600000,
            "tags": ["test"],
            "pauses_enc": self.crypto.encrypt("[]"),
            "metadata_enc": self.crypto.encrypt("{}"),
            "comment": "",
            "media": [],
        }

        block = self.chain.build_day_block([entry], prev_hash, "2026-07-15")

        # Must use identity_seal
        self.assertIn(
            "identity_seal", block,
            "build_day_block() must produce 'identity_seal' field, not 'signature'"
        )
        self.assertNotIn(
            "signature", block,
            "build_day_block() must NOT produce 'signature' field (use identity_seal)"
        )

    # ── C2: build_day_block without identity_secret ──────────────
    def test_C2_day_block_without_secret_no_identity_seal(self):
        """build_day_block() without identity_secret must not include identity_seal."""
        chain_no_secret = LedgerChain(self.crypto, self.chain.store, None)
        genesis = chain_no_secret.build_day_block([], "0" * 64, "2026-01-01")
        genesis["type"] = "genesis"
        genesis["block_hash"] = genesis.pop("day_hash")
        chain_no_secret.append(genesis)

        from domain.ledger.helpers import get_block_hash
        prev_hash = get_block_hash(genesis)

        entry = {
            "title": "No Identity",
            "startTime_enc": "",
            "endTime_enc": "",
            "duration": 0,
            "tags": [],
            "pauses_enc": "",
            "metadata_enc": "",
            "comment": "",
            "media": [],
        }

        block = chain_no_secret.build_day_block([entry], prev_hash, "2026-07-15")
        self.assertNotIn(
            "identity_seal", block,
            "Block without identity_secret must not have identity_seal"
        )

    # ── C3: verify() checks identity_seal ────────────────────────
    def test_C3_verify_checks_identity_seal(self):
        """LedgerChain.verify() must reference 'identity_seal' not 'signature'."""
        # Read the source of verify() to confirm field name
        import inspect
        source = inspect.getsource(self.chain.verify)
        self.assertIn(
            "identity_seal", source,
            "verify() must reference 'identity_seal' not 'signature'"
        )

    # ── C4: verify_block() checks identity_seal ──────────────────
    def test_C4_verify_block_checks_identity_seal(self):
        """LedgerChain.verify_block() must reference 'identity_seal' not 'signature'."""
        import inspect
        source = inspect.getsource(self.chain.verify_block)
        self.assertIn(
            "identity_seal", source,
            "verify_block() must reference 'identity_seal' not 'signature'"
        )


# ── Group D: NoAuthCryptoManager naming ──────────────────────────────

class TestNoAuthCryptoNaming(unittest.TestCase):
    """D1–D3: NoAuthCryptoManager must follow the same naming convention."""

    def setUp(self):
        self.manager = NoAuthCryptoManager()

    # ── D1: mac() exists (returns placeholder) ───────────────────
    def test_D1_mac_method_exists(self):
        """NoAuthCryptoManager must have mac() method."""
        self.assertTrue(
            hasattr(self.manager, "mac"),
            "NoAuthCryptoManager missing mac() — must be renamed from sign()"
        )

    # ── D2: verify_mac() exists ──────────────────────────────────
    def test_D2_verify_mac_method_exists(self):
        """NoAuthCryptoManager must have verify_mac() method."""
        self.assertTrue(
            hasattr(self.manager, "verify_mac"),
            "NoAuthCryptoManager missing verify_mac() — must be renamed from verify_signature()"
        )

    # ── D3: Old names absent ─────────────────────────────────────
    def test_D3_old_sign_method_absent(self):
        """NoAuthCryptoManager must NOT expose sign() after rename."""
        self.assertFalse(
            hasattr(self.manager, "sign"),
            "NoAuthCryptoManager still has sign() — rename to mac() is incomplete"
        )

    def test_D4_old_verify_signature_absent(self):
        """NoAuthCryptoManager must NOT expose verify_signature() after rename."""
        self.assertFalse(
            hasattr(self.manager, "verify_signature"),
            "NoAuthCryptoManager still has verify_signature() — rename to verify_mac() is incomplete"
        )


# ── Group E: AbstractCryptoManager naming ────────────────────────────

class TestAbstractCryptoNaming(unittest.TestCase):
    """E1–E3: AbstractCryptoManager ABC must declare mac() and verify_mac()."""

    # ── E1: mac() is abstract ────────────────────────────────────
    def test_E1_abstract_mac_declared(self):
        """AbstractCryptoManager must declare abstract mac()."""
        self.assertTrue(
            hasattr(AbstractCryptoManager, "mac"),
            "AbstractCryptoManager missing abstract mac()"
        )

    # ── E2: verify_mac() is abstract ─────────────────────────────
    def test_E2_abstract_verify_mac_declared(self):
        """AbstractCryptoManager must declare abstract verify_mac()."""
        self.assertTrue(
            hasattr(AbstractCryptoManager, "verify_mac"),
            "AbstractCryptoManager missing abstract verify_mac()"
        )

    # ── E3: Old names absent from ABC ────────────────────────────
    def test_E3_abstract_old_names_absent(self):
        """AbstractCryptoManager must NOT declare sign() or verify_signature()."""
        self.assertFalse(
            hasattr(AbstractCryptoManager, "sign"),
            "AbstractCryptoManager still declares sign() — rename to mac() is incomplete"
        )
        self.assertFalse(
            hasattr(AbstractCryptoManager, "verify_signature"),
            "AbstractCryptoManager still declares verify_signature() — rename to verify_mac() is incomplete"
        )
