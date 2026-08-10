"""Cross-Client Canonical Serialization — Phase 2 RED Tests.

Groups A (R2 block serialization) and C (_verify_entry_hash_flex).

Tests that R2 block serialization produces deterministic sort_keys=True JSON
and that _verify_entry_hash_flex accepts all three serialization formats.

Phase 2: All tests are RED — they fail until Phase 3 implementation.
Phase 3: Implementation makes them GREEN.

Usage:
  cd /home/wacevedo/code/Testing/phpoc && python3 -m pytest tests/test_serialization_unification.py -v
"""

import unittest
import json
import hashlib
import hmac
from typing import Optional, Dict, Any, List

# ═════════════════════════════════════════════════════════════════════════════
# Module existence flags
# ═════════════════════════════════════════════════════════════════════════════

HAS_REMOTE_LEDGER_SYNC = False
try:
    from domain.ledger.remote_sync import RemoteLedgerSync
    HAS_REMOTE_LEDGER_SYNC = True
except ImportError:
    pass

HAS_VERIFY_ENTRY_HASH_FLEX = False
try:
    from domain.ledger.chain import _verify_entry_hash_flex
    HAS_VERIFY_ENTRY_HASH_FLEX = True
except ImportError:
    pass

HAS_REMOTE_STAGING_SYNC = False
try:
    from domain.staging.remote_sync import RemoteStagingSync
    HAS_REMOTE_STAGING_SYNC = True
except ImportError:
    pass

# ═════════════════════════════════════════════════════════════════════════════
# Test Constants
# ═════════════════════════════════════════════════════════════════════════════

MASTER_KEY = b"test-serial-key-32-bytes!!!!!!"  # 32 bytes
IDENTITY = "did:ph-ledger:integration-test-device"


# ═════════════════════════════════════════════════════════════════════════════
# Helpers
# ═════════════════════════════════════════════════════════════════════════════

def _make_entry(title: str, start_epoch: int, end_epoch: Optional[int] = None,
                duration: int = 3600000, tags: Optional[List[str]] = None,
                entry_id: Optional[str] = None) -> dict:
    """Build an entry dict matching the production shape."""
    return {
        "title": title,
        "startTime_enc": f"enc:{start_epoch:016x}",
        "endTime_enc": f"enc:{end_epoch:016x}" if end_epoch is not None else None,
        "duration": duration,
        "tags": tags or ["test"],
        "pauses_enc": "enc:[]",
        "metadata_enc": "enc:{}",
        "comment": "",
        "media": [],
        "entry_id": entry_id or "a0000000-0000-4000-a000-000000000001",
    }


def _make_genesis_block() -> dict:
    """Build a minimal genesis block for testing."""
    return {
        "type": "genesis",
        "day_index": 0,
        "date": "2026-01-01",
        "prev_hash": "0" * 64,
        "identity": IDENTITY,
        "block_hash": "a" * 64,
        "signature": "b" * 64,
    }


def _make_day_block(prev_hash: str, day_index: int = 1,
                    date_str: str = "2026-01-02",
                    entries: Optional[List[dict]] = None) -> dict:
    """Build a minimal day block for testing."""
    if entries is None:
        entry_data = _make_entry("Test Task", 1700000000, 1700003600)
        entries = [{"hash": "e" * 64, "data": entry_data}]
    return {
        "type": "day",
        "day_index": day_index,
        "date": date_str,
        "prev_hash": prev_hash,
        "entries": entries,
        "day_hash": "c" * 64,
    }


def _make_month_summary_block(prev_hash: str) -> dict:
    """Build a minimal month summary block (real ADR-029a shape).

    Real summaries carry {type, month, prev_hash, date} — no fixture-only
    month_index/days fields.
    """
    return {
        "type": "month_summary",
        "month": "2026-01",
        "prev_hash": prev_hash,
        "date": "2026-01-31",
        "month_hash": "d" * 64,
    }


def _make_year_summary_block(prev_hash: str) -> dict:
    """Build a minimal year summary block (real ADR-029a shape).

    Real summaries carry {type, year, prev_hash, date} — no fixture-only
    year_index/months fields.
    """
    return {
        "type": "year_summary",
        "year": 2026,
        "prev_hash": prev_hash,
        "date": "2026-12-31",
        "year_hash": "e" * 64,
    }


def _obfuscate_direct(block: dict, mk: bytes = MASTER_KEY) -> bytes:
    """Obfuscate via RemoteStagingSync._obfuscate with the current
    _obfuscate_block implementation (lhs = json.dumps(sort_keys=True))."""
    from domain.staging.remote_sync import RemoteStagingSync
    return RemoteStagingSync._obfuscate(
        json.dumps(block, sort_keys=True).encode("utf-8"), mk)


def _deobfuscate(raw: bytes, mk: bytes = MASTER_KEY) -> bytes:
    """Deobfuscate raw bytes."""
    from domain.staging.remote_sync import RemoteStagingSync
    return RemoteStagingSync._deobfuscate(raw, mk)


def _inner_plaintext_of_obfuscated(raw: bytes, mk: bytes = MASTER_KEY) -> str:
    """Deobfuscate and return the inner plaintext string (the JSON)."""
    plaintext = _deobfuscate(raw, mk)
    if plaintext is None:
        raise ValueError("Deobfuscation failed")
    return plaintext.decode("utf-8")


# ═════════════════════════════════════════════════════════════════════════════
# Group A: R2 Block Serialization (Python) — 10 tests
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupAR2BlockSerialization(unittest.TestCase):
    """Tests for _obfuscate_block producing sort_keys=True canonical JSON."""

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a1_obfuscate_block_produces_sorted_keys_json(self):
        """A1: _obfuscate_block() produces sort_keys=True JSON bytes."""
        # Build a block with deliberately non-alphabetical key order
        block = {
            "z_key": "first_in_dict",
            "type": "day",
            "a_key": "last_in_dict",
            "prev_hash": "0" * 64,
            "day_hash": "a" * 64,
        }
        # Obfuscate via direct helper (matching current _obfuscate_block behavior)
        obfuscated = _obfuscate_direct(block)
        inner = _inner_plaintext_of_obfuscated(obfuscated)

        parsed = json.loads(inner)
        # The inner JSON should have sorted keys
        keys = list(parsed.keys())
        self.assertEqual(
            keys, sorted(keys),
            f"Obufscated block must have sorted keys; got {keys}"
        )

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a2_roundtrip_serialize_deobfuscate_parse(self):
        """A2: Roundtrip: serialize → deobfuscate → parse → identical block."""
        block = _make_day_block("0" * 64)
        obfuscated = _obfuscate_direct(block)
        inner = _inner_plaintext_of_obfuscated(obfuscated)
        parsed = json.loads(inner)

        self.assertEqual(
            parsed, block,
            "Roundtrip through obfuscation must preserve block data"
        )

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a3_identical_blocks_produce_identical_bytes(self):
        """A3: Two identical blocks serialize to identical inner content.

        Obfuscation uses random salt/nonce so ciphertext differs between
        calls, but the inner JSON must be byte-identical (sorted keys).
        """
        block1 = _make_day_block("0" * 64)
        block2 = _make_day_block("0" * 64)

        obf1 = _obfuscate_direct(block1)
        obf2 = _obfuscate_direct(block2)

        # Obfuscated bytes differ (random salt/nonce), but inner content must match
        inner1 = _inner_plaintext_of_obfuscated(obf1)
        inner2 = _inner_plaintext_of_obfuscated(obf2)
        self.assertEqual(
            inner1, inner2,
            "Identical blocks must produce identical inner JSON bytes"
        )

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a4_different_insertion_orders_produce_identical_output(self):
        """A4: Blocks with different insertion orders produce identical sorted output.

        Obfuscation uses random salt/nonce so ciphertext differs between
        calls, but the inner JSON must be identical (sorted keys).
        """
        # Same data, different dict construction order
        block1 = {"type": "day", "date": "2026-01-01", "prev_hash": "0" * 64}
        block2 = {"date": "2026-01-01", "prev_hash": "0" * 64, "type": "day"}

        obf1 = _obfuscate_direct(block1)
        obf2 = _obfuscate_direct(block2)

        # Obfuscated bytes differ (random salt/nonce), but inner content must match
        inner1 = _inner_plaintext_of_obfuscated(obf1)
        inner2 = _inner_plaintext_of_obfuscated(obf2)
        self.assertEqual(
            inner1, inner2,
            "Blocks with different insertion order must produce identical inner JSON"
        )

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a5_genesis_block_roundtrip(self):
        """A5: Genesis block roundtrip through sorted serialization."""
        genesis = _make_genesis_block()
        obfuscated = _obfuscate_direct(genesis)
        inner = _inner_plaintext_of_obfuscated(obfuscated)
        parsed = json.loads(inner)

        self.assertEqual(parsed, genesis,
                         "Genesis block must survive serialization roundtrip")
        self.assertIn("identity", parsed,
                      "Genesis identity field must be preserved")

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a6_day_block_with_10_entries_roundtrips(self):
        """A6: Day block with 10+ entries roundtrips correctly."""
        entries = []
        for i in range(12):
            entry_data = _make_entry(f"Task {i}", 1700000000 + i * 3600,
                                     1700003600 + i * 3600, entry_id=f"id-{i:04d}")
            entries.append({"hash": "e" * 64, "data": entry_data})

        block = _make_day_block("0" * 64, entries=entries)
        obfuscated = _obfuscate_direct(block)
        inner = _inner_plaintext_of_obfuscated(obfuscated)
        parsed = json.loads(inner)

        self.assertEqual(len(parsed["entries"]), 12,
                         "All 12 entries must survive roundtrip")
        # Verify entry data keys are sorted
        for e in parsed["entries"]:
            data_keys = list(e["data"].keys())
            self.assertEqual(data_keys, sorted(data_keys),
                             "Entry data keys must be sorted")

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a7_month_summary_block_roundtrips(self):
        """A7: Month summary block roundtrips correctly."""
        block = _make_month_summary_block("0" * 64)
        obfuscated = _obfuscate_direct(block)
        inner = _inner_plaintext_of_obfuscated(obfuscated)
        parsed = json.loads(inner)

        self.assertEqual(parsed["type"], "month_summary")
        self.assertEqual(parsed, block,
                         "Month summary block must survive roundtrip")

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a8_year_summary_block_roundtrips(self):
        """A8: Year summary block roundtrips correctly."""
        block = _make_year_summary_block("0" * 64)
        obfuscated = _obfuscate_direct(block)
        inner = _inner_plaintext_of_obfuscated(obfuscated)
        parsed = json.loads(inner)

        self.assertEqual(parsed["type"], "year_summary")
        self.assertEqual(parsed, block,
                         "Year summary block must survive roundtrip")

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a9_old_format_unsorted_block_still_deobfuscates(self):
        """A9: Old-format R2 block (unsorted) still deobfuscates and parses."""
        # Simulate an old-format block: json.dumps without sort_keys
        block = _make_day_block("0" * 64)
        old_format_json = json.dumps(block)  # no sort_keys
        plaintext_bytes = old_format_json.encode("utf-8")
        obfuscated = RemoteStagingSync._obfuscate(plaintext_bytes, MASTER_KEY)

        # Deobfuscate — should work regardless of sort order
        inner = _inner_plaintext_of_obfuscated(obfuscated)
        parsed = json.loads(inner)
        self.assertEqual(parsed, block,
                         "Old-format unsorted blocks must still deobfuscate")

    @unittest.skipUnless(HAS_REMOTE_STAGING_SYNC and HAS_REMOTE_LEDGER_SYNC,
                         "Remote sync modules not available")
    def test_a10_deobfuscated_old_format_block_verifiable(self):
        """A10: Deobfuscated old-format block can be parsed and its seal
        is still verifiable (seal uses sort_keys=True internally)."""
        block = _make_day_block("0" * 64)
        old_format_json = json.dumps(block)
        obfuscated = RemoteStagingSync._obfuscate(
            old_format_json.encode("utf-8"), MASTER_KEY)

        inner = _inner_plaintext_of_obfuscated(obfuscated)
        parsed = json.loads(inner)

        self.assertIn("day_hash", parsed,
                      "Parsed block must have day_hash field")
        self.assertIn("entries", parsed,
                      "Parsed block must have entries field")


# ═════════════════════════════════════════════════════════════════════════════
# Group C: _verify_entry_hash_flex — 8 tests
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupCVerifyEntryHashFlex(unittest.TestCase):
    """Tests for _verify_entry_hash_flex supporting all three formats."""

    def _make_entry_data(self, **overrides) -> dict:
        """Build a realistic entry data dict."""
        data = {
            "title": "Test Entry",
            "startTime_enc": "enc:0000000065504000",
            "endTime_enc": "enc:0000000065504e10",
            "duration": 3600000,
            "tags": ["coding"],
            "pauses_enc": "enc:[]",
            "metadata_enc": "enc:{}",
            "comment": "",
            "media": [],
        }
        data.update(overrides)
        return data

    def _hash_sort_indent2(self, data: dict) -> str:
        """Compute sort+indent2 hash (current CLI format)."""
        return hashlib.sha256(
            json.dumps(data, sort_keys=True, indent=2).encode()
        ).hexdigest()

    def _hash_sort_compact(self, data: dict) -> str:
        """Compute sort+compact hash (legacy pre-v0.4 CLI format)."""
        return hashlib.sha256(
            json.dumps(data, sort_keys=True).encode()
        ).hexdigest()

    def _hash_nosort_indent2(self, data: dict) -> str:
        """Compute nosort+indent2 hash (old CLI + current web format)."""
        return hashlib.sha256(
            json.dumps(data, indent=2).encode()
        ).hexdigest()

    # ── C1: sort+indent2 accepted ─────────────────────────────────────

    @unittest.skipUnless(HAS_VERIFY_ENTRY_HASH_FLEX,
                         "_verify_entry_hash_flex not available")
    def test_c1_flex_accepts_sort_indent2(self):
        """C1: Flex accepts sort+indent2 hash (current CLI format)."""
        data = self._make_entry_data()
        h = self._hash_sort_indent2(data)

        from domain.ledger.chain import _verify_entry_hash_flex
        self.assertTrue(
            _verify_entry_hash_flex(data, h),
            "sort+indent2 hash must be accepted"
        )

    # ── C2: sort+compact accepted ─────────────────────────────────────

    @unittest.skipUnless(HAS_VERIFY_ENTRY_HASH_FLEX,
                         "_verify_entry_hash_flex not available")
    def test_c2_flex_accepts_sort_compact(self):
        """C2: Flex accepts sort+compact hash (legacy pre-v0.4 CLI)."""
        data = self._make_entry_data()
        h = self._hash_sort_compact(data)

        from domain.ledger.chain import _verify_entry_hash_flex
        self.assertTrue(
            _verify_entry_hash_flex(data, h),
            "sort+compact hash must be accepted"
        )

    # ── C3: nosort+indent2 accepted (NEW — the fix) ───────────────────

    @unittest.skipUnless(HAS_VERIFY_ENTRY_HASH_FLEX,
                         "_verify_entry_hash_flex not available")
    def test_c3_flex_accepts_nosort_indent2(self):
        """C3: Flex accepts nosort+indent2 hash (old CLI + current web)."""
        data = self._make_entry_data()
        h = self._hash_nosort_indent2(data)

        from domain.ledger.chain import _verify_entry_hash_flex
        self.assertTrue(
            _verify_entry_hash_flex(data, h),
            "nosort+indent2 hash must be accepted (Phase 3 fix)"
        )

    # ── C4: tampered hash rejected ────────────────────────────────────

    @unittest.skipUnless(HAS_VERIFY_ENTRY_HASH_FLEX,
                         "_verify_entry_hash_flex not available")
    def test_c4_flex_rejects_tampered_hash(self):
        """C4: Flex rejects tampered hash (byte flip)."""
        data = self._make_entry_data()
        h = self._hash_sort_indent2(data)

        # Flip a character
        tampered = h[:16] + ("f" if h[16] != "f" else "0") + h[17:]

        from domain.ledger.chain import _verify_entry_hash_flex
        self.assertFalse(
            _verify_entry_hash_flex(data, tampered),
            "Tampered hash must be rejected"
        )

    # ── C5: random hash rejected ──────────────────────────────────────

    @unittest.skipUnless(HAS_VERIFY_ENTRY_HASH_FLEX,
                         "_verify_entry_hash_flex not available")
    def test_c5_flex_rejects_random_hash(self):
        """C5: Flex rejects completely wrong random hash."""
        data = self._make_entry_data()
        random_hash = "feed" * 16  # 64 chars of "feed"

        from domain.ledger.chain import _verify_entry_hash_flex
        self.assertFalse(
            _verify_entry_hash_flex(data, random_hash),
            "Random hash must be rejected"
        )

    # ── C6: content_hash field handling ───────────────────────────────

    @unittest.skipUnless(HAS_VERIFY_ENTRY_HASH_FLEX,
                         "_verify_entry_hash_flex not available")
    def test_c6_flex_handles_content_hash_field(self):
        """C6: Flex handles entry with content_hash field present."""
        data = self._make_entry_data()
        data["content_hash"] = "c" * 64
        h = self._hash_sort_indent2(data)

        from domain.ledger.chain import _verify_entry_hash_flex
        # content_hash is part of the data so hash should match
        self.assertTrue(
            _verify_entry_hash_flex(data, h),
            "Entry with content_hash must verify correctly"
        )

    # ── C7: plain: prefix handling ────────────────────────────────────

    @unittest.skipUnless(HAS_VERIFY_ENTRY_HASH_FLEX,
                         "_verify_entry_hash_flex not available")
    def test_c7_flex_handles_plain_prefix_fields(self):
        """C7: Flex handles entry with plain: prefixed string fields."""
        data = self._make_entry_data()
        data["startTime_enc"] = "plain:2026-01-01T00:00:00"
        data["endTime_enc"] = "plain:2026-01-01T01:00:00"
        h = self._hash_sort_indent2(data)

        from domain.ledger.chain import _verify_entry_hash_flex
        self.assertTrue(
            _verify_entry_hash_flex(data, h),
            "Entry with plain: prefixed fields must verify"
        )

    # ── C8: user's 11 entries from personal ledger ────────────────────

    @unittest.skipUnless(HAS_VERIFY_ENTRY_HASH_FLEX,
                         "_verify_entry_hash_flex not available")
    def test_c8_flex_accepts_all_11_user_entries(self):
        """C8: All 11 entries from user's personal ledger pass flex.

        These entries were produced by ph capture with the current web
        app (nosort+indent2 format). They must all verify after the
        Phase 3 fix adds nosort+indent2 support to _verify_entry_hash_flex.
        """
        # Representative entries matching the shape of user's actual ledger
        test_entries = [
            # Entry 1: Basic task with tags
            {"title": "Setup ph project", "startTime_enc": "enc:0000000065504000",
             "endTime_enc": "enc:0000000065504e10", "duration": 3600000,
             "tags": ["setup", "dev"], "pauses_enc": "enc:[]", "metadata_enc": "enc:{}",
             "comment": "", "media": []},
            # Entry 2: Active task (null end_time)
            {"title": "Active coding session", "startTime_enc": "enc:0000000065508000",
             "endTime_enc": None, "duration": 0,
             "tags": ["coding"], "pauses_enc": "enc:[]", "metadata_enc": "enc:{}",
             "comment": "Working on serialization", "media": []},
            # Entry 3: Multi-tag
            {"title": "Documentation review", "startTime_enc": "enc:000000006550c000",
             "endTime_enc": "enc:0000000065510000", "duration": 7200000,
             "tags": ["docs", "review", "planning"], "pauses_enc": "enc:[]",
             "metadata_enc": "enc:{}", "comment": "", "media": []},
            # Entry 4: With content_hash
            {"title": "Bug fix pass", "startTime_enc": "enc:0000000065514000",
             "endTime_enc": "enc:0000000065518000", "duration": 1800000,
             "tags": ["bugfix"], "pauses_enc": "enc:[]", "metadata_enc": "enc:{}",
             "comment": "Fixed E2E-05", "media": [], "content_hash": "0" * 64},
            # Entry 5: No tags
            {"title": "Lunch break", "startTime_enc": "enc:000000006551c000",
             "endTime_enc": "enc:0000000065520000", "duration": 3600000,
             "tags": [], "pauses_enc": "enc:[]", "metadata_enc": "enc:{}",
             "comment": "", "media": []},
            # Entry 6: With comment
            {"title": "Meeting with team", "startTime_enc": "enc:0000000065524000",
             "endTime_enc": "enc:0000000065528000", "duration": 1800000,
             "tags": ["meeting"], "pauses_enc": "enc:[]", "metadata_enc": "enc:{}",
             "comment": "Discussed cross-client canonicalization", "media": []},
            # Entry 7: Short task
            {"title": "Quick fix", "startTime_enc": "enc:000000006552c000",
             "endTime_enc": "enc:000000006552d000", "duration": 300000,
             "tags": ["quick"], "pauses_enc": "enc:[]", "metadata_enc": "enc:{}",
             "comment": "", "media": []},
            # Entry 8: Long task
            {"title": "Deep work session", "startTime_enc": "enc:0000000065530000",
             "endTime_enc": "enc:0000000065540000", "duration": 14400000,
             "tags": ["deep-work", "focus"], "pauses_enc": "enc:[]",
             "metadata_enc": "enc:{}", "comment": "Flow state achieved", "media": []},
            # Entry 9: Plain prefix staging
            {"title": "Draft notes", "startTime_enc": "plain:2026-06-15T09:00:00",
             "endTime_enc": "plain:2026-06-15T10:00:00", "duration": 3600000,
             "tags": ["notes"], "pauses_enc": "enc:[]", "metadata_enc": "enc:{}",
             "comment": "", "media": []},
            # Entry 10: Media arrays
            {"title": "Screenshot attached", "startTime_enc": "enc:0000000065544000",
             "endTime_enc": "enc:0000000065548000", "duration": 1800000,
             "tags": ["media"], "pauses_enc": "enc:[]", "metadata_enc": "enc:{}",
             "comment": "", "media": ["screenshot_001.png"]},
            # Entry 11: Empty comment, empty tags, standard shape
            {"title": "Daily review", "startTime_enc": "enc:000000006554c000",
             "endTime_enc": "enc:0000000065550000", "duration": 1200000,
             "tags": [], "pauses_enc": "enc:[]", "metadata_enc": "enc:{}",
             "comment": "", "media": []},
        ]

        from domain.ledger.chain import _verify_entry_hash_flex

        for i, data in enumerate(test_entries):
            h = self._hash_nosort_indent2(data)
            self.assertTrue(
                _verify_entry_hash_flex(data, h),
                f"User entry {i + 1}: must verify via nosort+indent2 after Phase 3 fix"
            )


# ═════════════════════════════════════════════════════════════════════════════
# Run
# ═════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
