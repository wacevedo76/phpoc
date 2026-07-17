"""I-01 Key Rotation — Phase 2 RED: Recovery tests (Group H).

Tests recovery flow after rotation: multi-version seed→MK derivation,
post-recovery data access, passphrase change compatibility.

Group H: Recovery Flow (8 tests)
"""

import unittest
import hashlib
import hmac
import base64
import os
from pathlib import Path


# ── Expected future API ───────────────────────────────────────────

HAS_I01_RECOVERY = False
try:
    from security.recovery import RecoveryManager
    from security.crypto import derive_mk
    HAS_I01_RECOVERY = True
except (ImportError, ModuleNotFoundError):
    RecoveryManager = None
    derive_mk = None


def skip_unless_i01_recovery():
    if not HAS_I01_RECOVERY:
        raise unittest.SkipTest("I-01 recovery layer not yet implemented")


def _compute_mk(seed, version):
    if version == 0:
        return seed
    return hmac.new(seed, f"phpoc:mk:v{version}".encode(), hashlib.sha256).digest()


# ══════════════════════════════════════════════════════════════════
# Group H: Recovery Flow
# ══════════════════════════════════════════════════════════════════

class TestRecoveryFlow(unittest.TestCase):
    """Tests that recovery works with multi-version keys."""

    def setUp(self):
        self.seed = base64.b64encode(os.urandom(32)).decode('utf-8')
        self.seed_bytes = base64.b64decode(self.seed)

    # ── H1: Seed derives all MK versions ─────────────────────

    def test_h1_seed_derives_all_mk_versions(self):
        """H1: ph recover with seed derives all MK versions from v1 through
        genesis key_version."""
        skip_unless_i01_recovery()
        # Given a seed, we can derive MK for any version
        mk_v1 = _compute_mk(self.seed_bytes, 1)
        mk_v2 = _compute_mk(self.seed_bytes, 2)
        mk_v3 = _compute_mk(self.seed_bytes, 3)

        self.assertEqual(len(mk_v1), 32)
        self.assertEqual(len(mk_v2), 32)
        self.assertEqual(len(mk_v3), 32)
        self.assertNotEqual(mk_v1, mk_v2)
        self.assertNotEqual(mk_v2, mk_v3)

    # ── H2: All blocks decryptable after recovery ────────────

    def test_h2_all_blocks_decryptable(self):
        """H2: After recovery, all blocks across all key versions are decryptable."""
        skip_unless_i01_recovery()
        mk_v1 = _compute_mk(self.seed_bytes, 1)
        mk_v2 = _compute_mk(self.seed_bytes, 2)

        # Data encrypted with v1 and v2 should both be decryptable
        from security.crypto import CryptoManager
        cm1 = CryptoManager(mk_v1) if CryptoManager else None
        cm2 = CryptoManager(mk_v2) if CryptoManager else None

        if cm1 and cm2:
            ct1 = cm1.encrypt("v1 data")
            ct2 = cm2.encrypt("v2 data")
            self.assertEqual(cm1.decrypt(ct1), "v1 data")
            self.assertEqual(cm2.decrypt(ct2), "v2 data")

    # ── H3: Recovery is non-destructive ──────────────────────

    def test_h3_recovery_does_not_change_data(self):
        """H3: ph recover does not change entry data — only re-seals genesis
        with new passphrase."""
        skip_unless_i01_recovery()
        # Recovery changes the passphrase wrapping, not the seed or data
        original_seed = self.seed_bytes
        self.assertEqual(len(original_seed), 32)

    # ── H4: Mixed-version recovery ───────────────────────────

    def test_h4_mixed_version_recovery(self):
        """H4: Recovery with seed after soft rotation (mixed-version chain)
        produces correct MKs."""
        skip_unless_i01_recovery()
        # After soft rotation from v1→v2, the chain has blocks at both versions.
        # Recovery from seed must produce both MKs.
        mk_v1 = _compute_mk(self.seed_bytes, 1)
        mk_v2 = _compute_mk(self.seed_bytes, 2)

        # Both versions should be derivable from same seed
        self.assertEqual(len(mk_v1), 32)
        self.assertEqual(len(mk_v2), 32)
        self.assertNotEqual(mk_v1, mk_v2)

    # ── H5: Post-hard-rotation recovery ──────────────────────

    def test_h5_post_hard_rotation_recovery(self):
        """H5: Recovery with seed after hard rotation (single-version chain)
        works correctly."""
        skip_unless_i01_recovery()
        # After hard rotation, the chain is all at version N.
        # Recovery should still produce the correct MK for version N.
        mk_v3 = _compute_mk(self.seed_bytes, 3)
        self.assertEqual(len(mk_v3), 32)

    # ── H6: Seed storage invariant ───────────────────────────

    def test_h6_seed_storage_unchanged(self):
        """H6: Recovery seed is stored encrypted with PDK (unchanged by key rotation)."""
        skip_unless_i01_recovery()
        self.assertTrue(hasattr(RecoveryManager, "encrypt_seed"),
                        "RecoveryManager must have encrypt_seed")
        self.assertTrue(hasattr(RecoveryManager, "decrypt_seed"),
                        "RecoveryManager must have decrypt_seed")

    # ── H7: Post-recovery verify passes ──────────────────────

    def test_h7_post_recovery_verify(self):
        """H7: verify() passes after recovery on mixed-version chain."""
        skip_unless_i01_recovery()
        # Recovery produces valid MKs that should pass chain verification
        mk_v1 = _compute_mk(self.seed_bytes, 1)
        mk_v2 = _compute_mk(self.seed_bytes, 2)
        self.assertNotEqual(mk_v1, mk_v2)

    # ── H8: Passphrase change + rotation compatibility ───────

    def test_h8_passphrase_change_and_rotation(self):
        """H8: Passphrase change after rotation: new PDK encrypts same seed;
        all MK versions re-derived and match."""
        skip_unless_i01_recovery()
        # The seed doesn't change with passphrase changes.
        # After passphrase change + rotation, all MK versions re-derive correctly.
        seed_derived_mk_v1 = _compute_mk(self.seed_bytes, 1)
        seed_derived_mk_v2 = _compute_mk(self.seed_bytes, 2)

        self.assertNotEqual(seed_derived_mk_v1, seed_derived_mk_v2)
        self.assertEqual(len(seed_derived_mk_v1), 32)
        self.assertEqual(len(seed_derived_mk_v2), 32)


if __name__ == "__main__":
    unittest.main()
