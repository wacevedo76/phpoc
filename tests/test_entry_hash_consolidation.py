"""Entry Hash Verification Consolidation — Phase 2 RED Tests.

Groups A (_verify_ledger_entry_hash → 3-way flex), B (_verify_entry_hash → 2-way),
C (_verify_entry_hash_updated → 2-way), and D (end-to-end import).

Phase 2: Regression tests for existing behavior are GREEN.
         New-format tests (A3, B2, C2) and E2E tests (D1-D3) are RED —
         they fail until Phase 3 implementation.

Usage:
  cd /home/wacevedo/code/Testing/phpoc && python3 -m pytest tests/test_entry_hash_consolidation.py -v
"""

import unittest
import json
import hashlib
import hmac
from typing import Optional, Dict, Any, List

# ═════════════════════════════════════════════════════════════════════════════
# Module existence flags
# ═════════════════════════════════════════════════════════════════════════════

HAS_ONBOARDING_HASH_FUNCTIONS = False
try:
    from cli.onboarding_file import (
        _verify_ledger_entry_hash,
        _verify_entry_hash,
        _verify_entry_hash_updated,
        _validate_raw_chain,
    )
    HAS_ONBOARDING_HASH_FUNCTIONS = True
except ImportError:
    pass

# ═════════════════════════════════════════════════════════════════════════════
# Helpers
# ═════════════════════════════════════════════════════════════════════════════

def _hash_sort_indent2(obj) -> str:
    """sort+indent2 (canonical cross-client format)."""
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, indent=2).encode()
    ).hexdigest()

def _hash_sort_compact(obj) -> str:
    """sort+compact (legacy pre-v0.4 CLI format)."""
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True).encode()
    ).hexdigest()

def _hash_nosort_indent2(obj) -> str:
    """nosort+indent2 (old CLI + current web format)."""
    return hashlib.sha256(
        json.dumps(obj, indent=2).encode()
    ).hexdigest()

def _make_ledger_entry_data(**overrides) -> dict:
    """Build a realistic ledger entry data dict (plaintext fields)."""
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

def _make_staging_entry(**overrides) -> dict:
    """Build a realistic staging DTO entry dict (core fields only)."""
    entry = {
        "entry_id": "e001",
        "title": "Test Entry",
        "duration": 3600000,
        "is_active": False,
        "is_paused": False,
        "start_epoch": 1716500000000,
        "end_epoch": 1716503600000,
        "pauses": [],
        "tags": ["coding"],
        "media": [],
        "device_uuid": "dev-test-001",
        "metadata": {},
    }
    entry.update(overrides)
    return entry

def _make_updated_entry(**overrides) -> dict:
    """Build a realistic updated-by-entry-id entry dict (all fields)."""
    entry = {
        "entry_id": "e001",
        "title": "Test Entry",
        "duration": 3600000,
        "is_active": False,
        "is_paused": False,
        "start_epoch": 1716500000000,
        "end_epoch": 1716503600000,
        "pauses": [],
        "tags": ["coding"],
        "media": [],
        "device_uuid": "dev-test-001",
        "metadata": {},
        "committed": False,
        "block_index": 0,
        "entry_index": 0,
        "comment": "",
        "hash": "",  # placeholder, set per-test
    }
    entry.update(overrides)
    return entry


# ═════════════════════════════════════════════════════════════════════════════
# Group A: _verify_ledger_entry_hash → 3-way flex — 8 tests
# ═════════════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_ONBOARDING_HASH_FUNCTIONS,
                     "onboarding hash functions not available")
class TestGroupAVerifyLedgerEntryHash(unittest.TestCase):
    """Tests for _verify_ledger_entry_hash consolidating onto 3-way flex."""

    # ── A1: sort+indent2 accepted (existing behavior) ──────────────────

    def test_a1_accepts_sort_indent2(self):
        """A1: Ledger entry with sort+indent2 hash verifies."""
        data = _make_ledger_entry_data()
        stored_hash = _hash_sort_indent2(data)
        entry = {"data": data, "hash": stored_hash}
        self.assertTrue(
            _verify_ledger_entry_hash(entry),
            "sort+indent2 legacy format must be accepted"
        )

    # ── A2: sort+compact accepted (existing behavior) ──────────────────

    def test_a2_accepts_sort_compact(self):
        """A2: Ledger entry with sort+compact hash verifies."""
        data = _make_ledger_entry_data()
        stored_hash = _hash_sort_compact(data)
        entry = {"data": data, "hash": stored_hash}
        self.assertTrue(
            _verify_ledger_entry_hash(entry),
            "sort+compact format must be accepted"
        )

    # ── A3: nosort+indent2 accepted (NEW — RED until Phase 3) ──────────

    def test_a3_accepts_nosort_indent2(self):
        """A3: Ledger entry with nosort+indent2 hash verifies.

        RED: current _verify_ledger_entry_hash only tries sort+compact
        and sort+indent2. Phase 3 consolidates onto _verify_entry_hash_flex
        which also accepts nosort+indent2.
        """
        data = _make_ledger_entry_data()
        stored_hash = _hash_nosort_indent2(data)
        entry = {"data": data, "hash": stored_hash}
        self.assertTrue(
            _verify_ledger_entry_hash(entry),
            "nosort+indent2 must be accepted after Phase 3 consolidation"
        )

    # ── A4: tampered hash rejected (existing behavior) ─────────────────

    def test_a4_rejects_tampered_hash(self):
        """A4: Flipped byte in hash causes rejection."""
        data = _make_ledger_entry_data()
        stored_hash = _hash_sort_indent2(data)
        tampered = stored_hash[:16] + ("f" if stored_hash[16] != "f" else "0") + stored_hash[17:]
        entry = {"data": data, "hash": tampered}
        self.assertFalse(
            _verify_ledger_entry_hash(entry),
            "Tampered hash must be rejected"
        )

    # ── A5: random hash rejected (existing behavior) ───────────────────

    def test_a5_rejects_random_hash(self):
        """A5: Completely random 64-char hash is rejected."""
        data = _make_ledger_entry_data()
        entry = {"data": data, "hash": "feed" * 16}
        self.assertFalse(
            _verify_ledger_entry_hash(entry),
            "Random hash must be rejected"
        )

    # ── A6: missing data key (existing behavior) ───────────────────────

    def test_a6_returns_false_for_missing_data(self):
        """A6: Entry without 'data' key returns False."""
        entry = {"hash": _hash_sort_indent2(_make_ledger_entry_data())}
        self.assertFalse(
            _verify_ledger_entry_hash(entry),
            "Missing data key must return False"
        )

    # ── A7: missing hash key (existing behavior) ───────────────────────

    def test_a7_returns_false_for_missing_hash(self):
        """A7: Entry without 'hash' key returns False."""
        data = _make_ledger_entry_data()
        entry = {"data": data}
        self.assertFalse(
            _verify_ledger_entry_hash(entry),
            "Missing hash key must return False"
        )

    # ── A8: content_hash field roundtrip (existing behavior) ───────────

    def test_a8_content_hash_field_roundtrips(self):
        """A8: Entry with content_hash field in data still verifies."""
        data = _make_ledger_entry_data(content_hash="c" * 64)
        stored_hash = _hash_sort_indent2(data)
        entry = {"data": data, "hash": stored_hash}
        self.assertTrue(
            _verify_ledger_entry_hash(entry),
            "content_hash is part of data — must roundtrip correctly"
        )


# ═════════════════════════════════════════════════════════════════════════════
# Group B: _verify_entry_hash → 2-way — 3 tests
# ═════════════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_ONBOARDING_HASH_FUNCTIONS,
                     "onboarding hash functions not available")
class TestGroupBVerifyEntryHash(unittest.TestCase):
    """Tests for _verify_entry_hash (staging core fields) adding indent2 support."""

    # ── B1: sort+compact accepted (existing behavior) ──────────────────

    def test_b1_accepts_sort_compact(self):
        """B1: Staging entry with sort+compact hash verifies."""
        staging = _make_staging_entry()
        staging["hash"] = _hash_sort_compact(
            {k: staging.get(k) for k in (
                "entry_id", "title", "duration", "is_active", "is_paused",
                "start_epoch", "end_epoch", "pauses", "tags", "media",
                "device_uuid", "metadata",
            )}
        )
        self.assertTrue(
            _verify_entry_hash(staging),
            "sort+compact staging hash must be accepted (legacy format)"
        )

    # ── B2: sort+indent2 accepted (NEW — RED until Phase 3) ────────────

    def test_b2_accepts_sort_indent2(self):
        """B2: Staging entry with sort+indent2 hash verifies.

        RED: current _verify_entry_hash only tries sort+compact.
        Phase 3 adds sort+indent2 fallback.
        """
        staging = _make_staging_entry()
        staging["hash"] = _hash_sort_indent2(
            {k: staging.get(k) for k in (
                "entry_id", "title", "duration", "is_active", "is_paused",
                "start_epoch", "end_epoch", "pauses", "tags", "media",
                "device_uuid", "metadata",
            )}
        )
        self.assertTrue(
            _verify_entry_hash(staging),
            "sort+indent2 staging hash must be accepted after Phase 3"
        )

    # ── B3: tampered hash rejected (existing behavior) ─────────────────

    def test_b3_rejects_tampered_hash(self):
        """B3: Tampered staging entry hash is rejected."""
        staging = _make_staging_entry()
        core_fields = {k: staging.get(k) for k in (
            "entry_id", "title", "duration", "is_active", "is_paused",
            "start_epoch", "end_epoch", "pauses", "tags", "media",
            "device_uuid", "metadata",
        )}
        valid_hash = _hash_sort_compact(core_fields)
        tampered = valid_hash[:16] + ("f" if valid_hash[16] != "f" else "0") + valid_hash[17:]
        staging["hash"] = tampered
        self.assertFalse(
            _verify_entry_hash(staging),
            "Tampered staging hash must be rejected"
        )


# ═════════════════════════════════════════════════════════════════════════════
# Group C: _verify_entry_hash_updated → 2-way — 3 tests
# ═════════════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_ONBOARDING_HASH_FUNCTIONS,
                     "onboarding hash functions not available")
class TestGroupCVerifyEntryHashUpdated(unittest.TestCase):
    """Tests for _verify_entry_hash_updated (all fields) adding indent2 support."""

    # ── C1: sort+compact accepted (existing behavior) ──────────────────

    def test_c1_accepts_sort_compact(self):
        """C1: Updated entry with sort+compact hash verifies."""
        entry = _make_updated_entry()
        hash_data = {k: v for k, v in entry.items()
                     if k not in ("hash", "entry_index")}
        entry["hash"] = _hash_sort_compact(hash_data)
        self.assertTrue(
            _verify_entry_hash_updated(entry),
            "sort+compact updated hash must be accepted (legacy format)"
        )

    # ── C2: sort+indent2 accepted (NEW — RED until Phase 3) ────────────

    def test_c2_accepts_sort_indent2(self):
        """C2: Updated entry with sort+indent2 hash verifies.

        RED: current _verify_entry_hash_updated only tries sort+compact.
        Phase 3 adds sort+indent2 fallback.
        """
        entry = _make_updated_entry()
        hash_data = {k: v for k, v in entry.items()
                     if k not in ("hash", "entry_index")}
        entry["hash"] = _hash_sort_indent2(hash_data)
        self.assertTrue(
            _verify_entry_hash_updated(entry),
            "sort+indent2 updated hash must be accepted after Phase 3"
        )

    # ── C3: tampered hash rejected (existing behavior) ─────────────────

    def test_c3_rejects_tampered_hash(self):
        """C3: Tampered updated entry hash is rejected."""
        entry = _make_updated_entry()
        hash_data = {k: v for k, v in entry.items()
                     if k not in ("hash", "entry_index")}
        valid_hash = _hash_sort_compact(hash_data)
        tampered = valid_hash[:16] + ("f" if valid_hash[16] != "f" else "0") + valid_hash[17:]
        entry["hash"] = tampered
        self.assertFalse(
            _verify_entry_hash_updated(entry),
            "Tampered updated hash must be rejected"
        )


# ═════════════════════════════════════════════════════════════════════════════
# Group D: End-to-end import — 3 tests
# ═════════════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_ONBOARDING_HASH_FUNCTIONS,
                     "onboarding hash functions not available")
class TestGroupDEndToEndImport(unittest.TestCase):
    """End-to-end tests exercising the import paths with consolidated verification."""

    # ── Helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _make_genesis_block():
        """Minimal genesis block with a valid block_hash seal."""
        return {
            "type": "genesis",
            "date": "2026-06-01",
            "block_hash": "0" * 64,
            "format_version": "0.4.0",
            "key_version": 1,
            "prev_hash": "",
        }

    @staticmethod
    def _make_day_block(prev_hash: str, entries: list) -> dict:
        """Minimal day block with entry data."""
        return {
            "type": "day",
            "date": "2026-06-02",
            "day_hash": "0" * 64,
            "prev_hash": prev_hash,
            "entries": entries,
        }

    @staticmethod
    def _compute_hmac_seal(data_str: str, mk: bytes) -> str:
        """HMAC-SHA256 seal matching _verify_seal in onboarding_file.py."""
        return hmac.digest(mk, data_str.encode(), "sha256").hex()

    # ── D1: v1 import with sort+indent2 staging entries ────────────────

    def test_d1_v1_import_sort_indent2_staging_no_warnings(self):
        """D1: v1 import with sort+indent2 staging entries raises no hash warnings.

        RED: current _verify_entry_hash only accepts sort+compact, so
        sort+indent2 staging entries trigger mismatch warnings. After Phase 3,
        indent2 format is also recognized, so no warnings.
        """
        from cli.onboarding_file import _import_v1

        staging_entries = []
        for i in range(3):
            entry = _make_staging_entry(
                entry_id=f"e00{i}",
                title=f"Task {i}",
            )
            # Compute hash with sort+indent2 (canonical format)
            core_fields = {k: entry.get(k) for k in (
                "entry_id", "title", "duration", "is_active", "is_paused",
                "start_epoch", "end_epoch", "pauses", "tags", "media",
                "device_uuid", "metadata",
            )}
            entry["hash"] = _hash_sort_indent2(core_fields)
            staging_entries.append(entry)

        # Build a valid v1 payload with HMAC seal
        mk = b"0" * 32
        from security.crypto import CryptoManager
        crypto = CryptoManager(mk)
        entries_json = json.dumps(staging_entries, sort_keys=True)
        seal = crypto.seal(entries_json)

        v1_data = {
            "format_version": "1",
            "entries": staging_entries,
            "seal": seal,
        }

        # Import — should succeed with no hash warnings
        import io
        from unittest.mock import patch
        import sys

        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            result = _import_v1(v1_data, mk)

        self.assertEqual(result["format"], "v1")
        self.assertEqual(len(result["entries"]), 3)
        stdout = fake_out.getvalue()
        self.assertNotIn(
            "Warning",
            stdout,
            "v1 import with sort+indent2 staging entries must produce no hash warnings"
        )

    # ── D2: v2 import with mixed-format staging entries ────────────────

    def test_d2_v2_import_mixed_format_staging_no_warnings(self):
        """D2: v2 import with mixed sort+compact and sort+indent2 entries.

        RED: sort+indent2 entries currently cause warnings. After Phase 3,
        both formats are accepted, so no warnings.
        """
        from cli.onboarding_file import _import_v2

        mk = b"0" * 32
        from security.crypto import CryptoManager
        crypto = CryptoManager(mk)

        # Mixed staging: one sort+compact, one sort+indent2
        staging_entries = []

        # sort+compact entry (legacy — already accepted)
        e1 = _make_staging_entry(entry_id="e000", title="Legacy Entry")
        core1 = {k: e1.get(k) for k in (
            "entry_id", "title", "duration", "is_active", "is_paused",
            "start_epoch", "end_epoch", "pauses", "tags", "media",
            "device_uuid", "metadata",
        )}
        e1["hash"] = _hash_sort_compact(core1)
        staging_entries.append(e1)

        # sort+indent2 entry (canonical — RED until Phase 3)
        e2 = _make_staging_entry(entry_id="e001", title="Canonical Entry")
        core2 = {k: e2.get(k) for k in (
            "entry_id", "title", "duration", "is_active", "is_paused",
            "start_epoch", "end_epoch", "pauses", "tags", "media",
            "device_uuid", "metadata",
        )}
        e2["hash"] = _hash_sort_indent2(core2)
        staging_entries.append(e2)

        # Ledger: genesis + one day block with a single entry
        data = _make_ledger_entry_data(title="Ledger Task")
        day_entry = {
            "data": data,
            "hash": _hash_sort_indent2(data),
        }
        genesis = self._make_genesis_block()
        genesis_hash = "0" * 64
        # Re-seal genesis properly
        genesis_check = {k: v for k, v in sorted(genesis.items())
                         if k not in ("block_hash", "identity_seal", "signature", "format_version")}
        genesis["block_hash"] = crypto.seal(json.dumps(genesis_check, sort_keys=True))

        day = self._make_day_block(genesis["block_hash"], [day_entry])
        day_check = {k: v for k, v in sorted(day.items())
                     if k not in ("day_hash", "identity_seal", "signature", "format_version")}
        day["day_hash"] = crypto.seal(json.dumps(day_check, sort_keys=True))

        ledger_blocks = [genesis, day]

        payload = json.dumps({"ledger": ledger_blocks, "staging": staging_entries}, sort_keys=True)
        seal = crypto.seal(payload)

        v2_data = {
            "format_version": "2",
            "ledger": ledger_blocks,
            "staging": staging_entries,
            "seal": seal,
        }

        import io
        from unittest.mock import patch

        with patch("sys.stdout", new=io.StringIO()) as fake_out:
            result = _import_v2(v2_data, mk)

        self.assertEqual(result["format"], "v2")
        self.assertEqual(len(result["entries"]), 2)
        stdout = fake_out.getvalue()
        self.assertNotIn(
            "Warning",
            stdout,
            "v2 import with mixed-format staging entries must produce no hash warnings"
        )

    # ── D3: chain import with nosort+indent2 ledger entries ────────────

    def test_d3_chain_import_nosort_indent2_no_errors(self):
        """D3: Chain import with nosort+indent2 ledger entries passes validation.

        RED: current _verify_ledger_entry_hash does not try nosort+indent2,
        so _validate_raw_chain raises ValueError on such entries. After Phase 3
        consolidation onto _verify_entry_hash_flex, all 3 formats are accepted.
        """
        mk = b"0" * 32
        from security.crypto import CryptoManager
        crypto = CryptoManager(mk)

        # Create a day block entry with nosort+indent2 hash
        data = _make_ledger_entry_data(title="Web Entry")
        stored_hash = _hash_nosort_indent2(data)
        day_entry = {"data": data, "hash": stored_hash}

        # Build genesis + day block
        genesis = self._make_genesis_block()
        genesis_check = {k: v for k, v in sorted(genesis.items())
                         if k not in ("block_hash", "identity_seal", "signature", "format_version")}
        genesis["block_hash"] = crypto.seal(json.dumps(genesis_check, sort_keys=True))

        day = self._make_day_block(genesis["block_hash"], [day_entry])
        day_check = {k: v for k, v in sorted(day.items())
                     if k not in ("day_hash", "identity_seal", "signature", "format_version")}
        day["day_hash"] = crypto.seal(json.dumps(day_check, sort_keys=True))

        blocks = [genesis, day]

        # _validate_raw_chain should NOT raise on the nosort+indent2 entry
        try:
            _validate_raw_chain(blocks, crypto, mk)
        except ValueError as e:
            self.fail(
                f"_validate_raw_chain raised ValueError on nosort+indent2 entry: {e}"
            )


# ═════════════════════════════════════════════════════════════════════════════
# Run
# ═════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
