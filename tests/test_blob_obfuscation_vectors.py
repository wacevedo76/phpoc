"""Test blob obfuscation against cross-platform test vectors.

I-11 Phase 2 (RED): Validates blob obfuscation tier selection, roundtrip
edge cases, deterministic cross-platform vectors, and key derivation.

Groups (mapped to I11_BLOB_OBFUSCATION_PORTABILITY_PHASE1.md):
  Group B: Tier Selection Edge Cases (6 tests: test B1–B6)
  Group C: Roundtrip Edge Cases (5 tests: test C1–C5)
  Group D: Deterministic Cross-Platform Vectors (4 tests: test D1–D4)
  Group E: Blob Key Derivation (2 tests: test E1–E2)

Run: python3 -m pytest tests/test_blob_obfuscation_vectors.py -x -v
"""

import json
import os
import pytest

from domain.staging.remote_sync import (
    RemoteStagingSync,
    BLOB_TIERS,
    TIER_64K,
    TIER_128K,
    TIER_256K,
    TIER_512K,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TEST_VECTORS_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "phpoc-crypto-core",
    "tests",
    "crypto_test_vectors.json",
)


def _load_vectors():
    with open(TEST_VECTORS_PATH, "r") as f:
        return json.load(f)


def _mk_ab():
    """Return the standard AB*32 master key used in test vectors."""
    return bytes([0xAB] * 32)


# ===========================================================================
# Group B: Tier Selection Edge Cases (6 tests)
# ===========================================================================

class TestTierSelection:
    """B1–B6: Verify _select_tier() edge cases."""

    def test_B1_empty_blob_64k(self):
        """B1: Empty blob (0 bytes) → tier 64K."""
        assert RemoteStagingSync._select_tier(0) == TIER_64K

    def test_B2_exactly_64k_ceiling(self):
        """B2: Exactly 64KB (65536 bytes) → tier 64K."""
        assert RemoteStagingSync._select_tier(65536) == TIER_64K

    def test_B3_64k_plus_one_transition(self):
        """B3: 64KB + 1 byte → tier 128K (class transition)."""
        assert RemoteStagingSync._select_tier(65537) == TIER_128K

    def test_B4_127999_below_128k_ceiling(self):
        """B4: 127999 bytes → tier 128K (below ceiling)."""
        assert RemoteStagingSync._select_tier(127999) == TIER_128K

    def test_B5_exactly_512k_max_tier(self):
        """B5: Exactly 512KB → tier 512K (max tier exact fit)."""
        assert RemoteStagingSync._select_tier(524288) == TIER_512K

    def test_B6_exceeds_max_tier(self):
        """B6: 512KB + 1 byte → error (exceeds max tier)."""
        with pytest.raises(ValueError, match="exceeds max tier"):
            RemoteStagingSync._select_tier(524289)


# ===========================================================================
# Group C: Roundtrip Edge Cases (5 tests)
# ===========================================================================

class TestRoundtripEdgeCases:
    """C1–C5: Validates full obfuscate → deobfuscate roundtrip for edge cases."""

    @staticmethod
    def _roundtrip(plaintext: bytes, mk: bytes) -> bytes:
        obfuscated = RemoteStagingSync._obfuscate(plaintext, mk)
        assert len(obfuscated) >= TIER_64K  # Always at least 64K
        result = RemoteStagingSync._deobfuscate(obfuscated, mk)
        assert result is not None, "Deobfuscation returned None"
        return result

    def test_C1_empty_blob_roundtrip(self):
        """C1: Empty blob roundtrip: obfuscate → deobfuscate → original empty string."""
        result = self._roundtrip(b"", _mk_ab())
        assert result == b""

    def test_C2_exactly_at_64k_ceiling_roundtrip(self):
        """C2: Exactly at 64K ceiling roundtrip."""
        plaintext = b"A" * 65536
        result = self._roundtrip(plaintext, _mk_ab())
        assert result == plaintext

    def test_C3_class_transition_roundtrip(self):
        """C3: Class transition (64K→128K) roundtrip."""
        plaintext = b"B" * 65537
        result = self._roundtrip(plaintext, _mk_ab())
        assert result == plaintext

    def test_C4_non_ascii_unicode_roundtrip(self):
        """C4: Non-ASCII Unicode plaintext roundtrip."""
        plaintext = "日本語 Español 🔐".encode("utf-8")
        result = self._roundtrip(plaintext, _mk_ab())
        assert result == plaintext

    def test_C5_near_512k_limit_roundtrip(self):
        """C5: Plaintext near 512K limit (524280 bytes) roundtrip."""
        plaintext = b"C" * 524280
        result = self._roundtrip(plaintext, _mk_ab())
        assert result == plaintext


# ===========================================================================
# Group D: Deterministic Cross-Platform Test Vectors (4 tests)
# ===========================================================================

class TestDeterministicVectors:
    """D1–D4: Validates byte-identical output for fixed salt + nonce + padding.

    RED in Phase 2: _obfuscate_deterministic() does not exist yet.
    These tests will fail with NotImplementedError / assertion error.
    """

    def test_D1_python_matches_expected(self):
        """D2: Python _obfuscate_deterministic() produces the expected hex from vectors."""
        vectors = _load_vectors()
        for v in vectors["blob_obfuscation_deterministic"]:
            mk = bytes.fromhex(v["master_key_hex"])
            plaintext = v["plaintext"].encode("utf-8")
            salt = bytes.fromhex(v["salt_hex"])
            nonce = bytes.fromhex(v["nonce_hex"])
            expected_hex = v["expected_hex"]

            # Phase 3 API: deterministic obfuscation with explicit salt/nonce
            result = RemoteStagingSync._obfuscate_deterministic(
                plaintext, mk, salt, nonce
            )
            assert result.hex() == expected_hex, (
                f"Deterministic obfuscation mismatch for plaintext: {v['plaintext'][:50]}..."
            )

    def test_D2_deobfuscation_returns_original(self):
        """D4: Deobfuscation of deterministic output returns original plaintext."""
        vectors = _load_vectors()
        for v in vectors["blob_obfuscation_deterministic"]:
            mk = bytes.fromhex(v["master_key_hex"])
            plaintext = v["plaintext"].encode("utf-8")
            expected_hex = v["expected_hex"]

            # Deobfuscate the expected hex output
            obfuscated = bytes.fromhex(expected_hex)
            result = RemoteStagingSync._deobfuscate(obfuscated, mk)
            assert result is not None, f"Deobfuscation failed for: {v['note']}"
            assert result == plaintext, (
                f"Deobfuscation returned wrong plaintext for: {v['note']}"
            )

    def test_D3_vector_file_roundtrip_consistency(self):
        """D1: Each deterministic vector output deobfuscates to its plaintext."""
        vectors = _load_vectors()
        for v in vectors["blob_obfuscation_deterministic"]:
            mk = bytes.fromhex(v["master_key_hex"])
            plaintext = v["plaintext"].encode("utf-8")
            obfuscated = bytes.fromhex(v["expected_hex"])

            result = RemoteStagingSync._deobfuscate(obfuscated, mk)
            assert result is not None, f"Deobfuscation returned None for: {v['note']}"
            assert result == plaintext, (
                f"Deterministic vector roundtrip failed for: {v['note']}"
            )

    def test_D4_python_roundtrip_deterministic(self):
        """D2+D4: Python obfuscate_deterministic output can be deobfuscated."""
        vectors = _load_vectors()
        for v in vectors["blob_obfuscation_deterministic"]:
            mk = bytes.fromhex(v["master_key_hex"])
            plaintext = v["plaintext"].encode("utf-8")
            salt = bytes.fromhex(v["salt_hex"])
            nonce = bytes.fromhex(v["nonce_hex"])

            # Phase 3 API
            obfuscated = RemoteStagingSync._obfuscate_deterministic(
                plaintext, mk, salt, nonce
            )
            result = RemoteStagingSync._deobfuscate(obfuscated, mk)
            assert result is not None
            assert result == plaintext


# ===========================================================================
# Group E: Blob Key Derivation (2 tests)
# ===========================================================================

class TestBlobKeyDerivation:
    """E1–E2: Validates blob sub-key derivation from master key."""

    def test_E1_deterministic_output(self):
        """E1: derive_blob_key(mk) produces deterministic output for fixed master_key."""
        vectors = _load_vectors()
        for v in vectors["blob_key_derivation"]:
            mk = bytes.fromhex(v["master_key_hex"])
            expected = bytes.fromhex(v["expected_hex"])

            blob_key = RemoteStagingSync._derive_blob_key(mk)
            assert blob_key == expected, "Blob key derivation mismatch"

    def test_E2_output_is_16_bytes(self):
        """E2: derive_blob_key(mk) output is 16 bytes."""
        blob_key = RemoteStagingSync._derive_blob_key(_mk_ab())
        assert len(blob_key) == 16
        assert isinstance(blob_key, bytes)

    def test_E2_different_mk_different_key(self):
        """E2 sanity: different master keys produce different blob keys."""
        mk1 = bytes([0xAB] * 32)
        mk2 = bytes([0xCD] * 32)
        k1 = RemoteStagingSync._derive_blob_key(mk1)
        k2 = RemoteStagingSync._derive_blob_key(mk2)
        assert k1 != k2


# ===========================================================================
# Group B: Validate against test vector JSON (cross-check)
# ===========================================================================

class TestTierSelectionVectors:
    """B1–B6: Validate _select_tier() against tier_selection test vectors in JSON."""

    def test_tier_selection_vectors(self):
        vectors = _load_vectors()
        for v in vectors["blob_tier_selection"]:
            size = v["plaintext_size"]
            if v.get("expected_error"):
                with pytest.raises(ValueError):
                    RemoteStagingSync._select_tier(size)
            else:
                tier = RemoteStagingSync._select_tier(size)
                assert tier == v["expected_tier"], (
                    f"Tier mismatch for size={size}: "
                    f"got {tier}, expected {v['expected_tier']}"
                )
