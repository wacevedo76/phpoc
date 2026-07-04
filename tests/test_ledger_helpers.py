"""Ledger Helpers — Unit Tests.

Tests for domain/ledger/helpers.py: get_block_hash() and related utilities.

Groups:
  A — get_block_hash(): block type resolution (7 tests)
  B — get_block_hash(): edge cases (5 tests)

Total: 12 tests. Phase 2 RED (helper module not yet created).

Usage:
  cd /home/wacevedo/code/Testing/phpoc && python3 -m pytest tests/test_ledger_helpers.py -v
"""

import unittest


# ═════════════════════════════════════════════════════════════════════════════
# Module existence flag — set to False for RED phase
# ═════════════════════════════════════════════════════════════════════════════

HAS_HELPERS = False
try:
    from domain.ledger.helpers import get_block_hash  # noqa: F401
    HAS_HELPERS = True
except ImportError:
    pass


# ═════════════════════════════════════════════════════════════════════════════
# Group A — get_block_hash(): block type resolution
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupA_BlockHashResolution(unittest.TestCase):
    """Tests that get_block_hash() returns the correct hash value for each
    block type, with proper priority ordering and backward compatibility.
    """

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_a1_genesis_block_hash(self):
        """Genesis with block_hash → returns block_hash value (I-17 new format)."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "genesis", "block_hash": "abc123"}
        result = get_block_hash(block)
        self.assertEqual(result, "abc123",
                         "Genesis with block_hash must return block_hash value")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_a2_genesis_day_hash_backward_compat(self):
        """Genesis with only day_hash → returns day_hash value (I-17 backward compat)."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "genesis", "day_hash": "def456"}
        result = get_block_hash(block)
        self.assertEqual(result, "def456",
                         "Old genesis with day_hash must still return day_hash value")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_a3_day_block(self):
        """Day block with day_hash → returns day_hash value."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "day", "day_hash": "day789"}
        result = get_block_hash(block)
        self.assertEqual(result, "day789",
                         "Day block must return day_hash value")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_a4_month_summary(self):
        """Month summary block with month_hash → returns month_hash value."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "month_summary", "month_hash": "month012"}
        result = get_block_hash(block)
        self.assertEqual(result, "month012",
                         "Month summary must return month_hash value")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_a5_year_summary(self):
        """Year summary block with year_hash → returns year_hash value."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "year_summary", "year_hash": "year345"}
        result = get_block_hash(block)
        self.assertEqual(result, "year345",
                         "Year summary must return year_hash value")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_a6_block_hash_takes_priority(self):
        """When multiple hash keys exist, block_hash takes priority."""
        from domain.ledger.helpers import get_block_hash

        # Start with all keys, block_hash should win
        block = {
            "type": "genesis",
            "block_hash": "priority_block",
            "day_hash": "also_day",
            "month_hash": "also_month",
            "year_hash": "also_year",
        }
        result = get_block_hash(block)
        self.assertEqual(result, "priority_block",
                         "block_hash must take priority over all other hash keys")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_a7_day_hash_without_block_hash_without_type(self):
        """Block with day_hash but no type field → returns day_hash (most blocks are days)."""
        from domain.ledger.helpers import get_block_hash

        block = {"day_hash": "day_no_type"}
        result = get_block_hash(block)
        self.assertEqual(result, "day_no_type",
                         "Block with only day_hash must return it even without type field")


# ═════════════════════════════════════════════════════════════════════════════
# Group B — get_block_hash(): edge cases
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupB_BlockHashEdgeCases(unittest.TestCase):
    """Tests edge cases and error handling for get_block_hash()."""

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_b1_empty_block_returns_empty_string(self):
        """Block with no hash keys at all → returns empty string."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "day", "entries": []}
        result = get_block_hash(block)
        self.assertEqual(result, "",
                         "Block with no hash keys must return ''")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_b2_none_hash_values_are_skipped(self):
        """Hash keys set to None → skipped, falls through to next key."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "day", "day_hash": None, "month_hash": "real_hash"}
        result = get_block_hash(block)
        self.assertEqual(result, "real_hash",
                         "None hash values must be skipped via or chaining")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_b3_empty_string_hash_values_are_skipped(self):
        """Hash keys set to '' → skipped, falls through to next key."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "day", "day_hash": "", "month_hash": "real_hash"}
        result = get_block_hash(block)
        self.assertEqual(result, "real_hash",
                         "Empty string hash values must be skipped via or chaining")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_b4_all_hash_keys_falsy_returns_empty_string(self):
        """All hash keys set to falsy values (None, '', 0) → returns empty string."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "day", "day_hash": None, "block_hash": ""}
        result = get_block_hash(block)
        self.assertEqual(result, "",
                         "All falsy hash keys must result in ''")

    @unittest.skipUnless(HAS_HELPERS, "domain/ledger/helpers.py not available yet (RED phase)")
    def test_b5_day_hash_falsy_month_hash_exists(self):
        """Day hash is '' but month_hash exists → returns month_hash (or-chaining)."""
        from domain.ledger.helpers import get_block_hash

        block = {"type": "month_summary", "day_hash": "", "month_hash": "m123"}
        result = get_block_hash(block)
        self.assertEqual(result, "m123",
                         "When day_hash is '', month_hash must be returned")


# ═════════════════════════════════════════════════════════════════════════════
# Run
# ═════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
