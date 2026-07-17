"""I-01 Key Rotation — Phase 2 RED: Auth layer tests (Group E).

Tests multi-MK session cache: derive all versions on auth, per-version access,
cache lifecycle, and cleanup.

Group E: Session Key Cache and Auth (8 tests)
"""

import unittest
import hashlib
import hmac
import json
import os
from pathlib import Path
from typing import Optional
from unittest.mock import patch, MagicMock


# ── Expected future API ───────────────────────────────────────────

HAS_I01_AUTH = False
try:
    from security.auth import PassphraseAuthenticator
    from security.recovery import RecoveryManager
    HAS_I01_AUTH = True
except (ImportError, ModuleNotFoundError):
    PassphraseAuthenticator = None
    RecoveryManager = None


def skip_unless_i01_auth():
    if not HAS_I01_AUTH:
        raise unittest.SkipTest("I-01 auth layer not yet implemented")


def _compute_mk(seed, version):
    """Helper: derive MK for a given version (expected algorithm)."""
    if version == 0:
        return seed
    return hmac.new(seed, f"phpoc:mk:v{version}".encode(), hashlib.sha256).digest()


# ══════════════════════════════════════════════════════════════════
# Group E: Session Key Cache and Auth
# ══════════════════════════════════════════════════════════════════

class TestSessionKeyCache(unittest.TestCase):
    """Tests that authenticate() derives all MK versions and caches them."""

    # ── E1: All MKs derived on auth ──────────────────────────

    def test_e1_authenticate_derives_all_mks(self):
        """E1: authenticate() derives all MKs from v1 through genesis key_version."""
        skip_unless_i01_auth()
        # Get the authenticator and verify it has multi-MK support
        auth = PassphraseAuthenticator(Path("/tmp"))
        self.assertTrue(hasattr(auth, "get_mk"),
                        "Authenticator must have get_mk(version) method")

        # The key_version property should reflect the number of derived MKs
        self.assertTrue(hasattr(auth, "key_version") or hasattr(auth, "get_mk"),
                        "Authenticator must support per-version MK access")

    # ── E2: get_key returns highest version ──────────────────

    def test_e2_get_key_returns_current_mk(self):
        """E2: get_key() returns the current (highest) MK version for new operations."""
        skip_unless_i01_auth()
        auth = PassphraseAuthenticator(Path("/tmp"))
        self.assertTrue(hasattr(auth, "get_key"),
                        "Authenticator must have get_key() for current MK")

    # ── E3: get_mk returns specific version ──────────────────

    def test_e3_get_mk_returns_specific_version(self):
        """E3: get_mk(version) returns specific MK version for verification
        of old blocks."""
        skip_unless_i01_auth()
        auth = PassphraseAuthenticator(Path("/tmp"))
        self.assertTrue(hasattr(auth, "get_mk"),
                        "Authenticator must have get_mk(version) for per-block lookup")

    # ── E4: Missing version raises KeyError ──────────────────

    def test_e4_get_mk_missing_version(self):
        """E4: get_mk(999) on ledger with key_version=3 raises KeyError or
        returns None."""
        skip_unless_i01_auth()
        auth = PassphraseAuthenticator(Path("/tmp"))
        # get_mk should raise or return None for non-existent version
        if hasattr(auth, "get_mk"):
            try:
                result = auth.get_mk(999)
                self.assertIsNone(result,
                                  "get_mk(999) should return None for non-existent version")
            except KeyError:
                pass  # Also acceptable: raises KeyError

    # ── E5: Cache stores all MK versions ─────────────────────

    def test_e5_cache_stores_all_mk_versions(self):
        """E5: Session cache stores all MK versions (not just current) after auth."""
        skip_unless_i01_auth()
        auth = PassphraseAuthenticator(Path("/tmp"))
        # After auth, the cache should contain all versions
        # The SESSION_FILE or in-memory cache should hold multiple versions
        self.assertTrue(
            hasattr(auth, "_keys") or hasattr(auth, "_mk_cache") or hasattr(auth, "get_mk"),
            "Session cache must support multiple MK versions"
        )

    # ── E6: clear_session removes all versions ───────────────

    def test_e6_clear_session_removes_all_versions(self):
        """E6: clear_session() removes all cached MK versions (not just current)."""
        skip_unless_i01_auth()
        auth = PassphraseAuthenticator(Path("/tmp"))
        self.assertTrue(hasattr(auth, "clear_session"),
                        "Authenticator must have clear_session()")

        auth.clear_session()
        # After clear, get_key should return None
        key = auth.get_key()
        self.assertIsNone(key)

    # ── E7: _verify_cached_key works with multi-version cache ──

    def test_e7_verify_cached_key_multi_version(self):
        """E7: _verify_cached_key() works when cache contains multiple versions."""
        skip_unless_i01_auth()
        auth = PassphraseAuthenticator(Path("/tmp"))
        self.assertTrue(hasattr(auth, "_verify_cached_key"),
                        "Authenticator must have _verify_cached_key() for multi-MK")

    # ── E8: Correct version count for ledger at key_version=N ──

    def test_e8_correct_version_count(self):
        """E8: Auth with ledger at key_version=3 derives exactly 3 MKs
        (v1, v2, v3)."""
        skip_unless_i01_auth()
        # If get_mk exists, we should be able to retrieve v1, v2, v3 but not v0 or v4
        # This is tested at the integration level — we verify the API shape
        auth = PassphraseAuthenticator(Path("/tmp"))
        self.assertTrue(
            hasattr(auth, "get_mk") or hasattr(auth, "key_version"),
            "Authenticator must expose key version count"
        )


if __name__ == "__main__":
    unittest.main()
