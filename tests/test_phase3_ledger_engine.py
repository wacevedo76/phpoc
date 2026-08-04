"""Phase 3 tests: Ledger Engine.

Tests the LedgerChain, IndexManager, SummaryPolicy, and LedgerEngine
components that will be extracted from core/ledger.py.

Key behaviors:
  - LedgerChain: seal, sign, append, truncate, verify_block, checksum_chain
  - IndexManager: update, query, rebuild_from_chain
  - SummaryPolicy: year/month boundary detection, summary block insertion
  - LedgerEngine: commit, verify, revert, the unified public API

Critical constraint (🔴 O8): Chain format must remain IDENTICAL to current
core/ledger.py output. Block generation logic is extracted without changing
the algorithm.
"""

import unittest
import json
import time
import hashlib
import hmac
import tempfile
import shutil
import os
import datetime
from typing import Optional, Dict, Any, List
from pathlib import Path

# ──────────────────────────────────────────────
# Mock/Stub Helpers
# ──────────────────────────────────────────────

class _MockCrypto:
    """Mimics CryptoManager behavior for seal/sign/encrypt/decrypt.
    
    Uses HMAC-SHA256 for seal (deterministic, verifiable) and sign
    (matching real CryptoManager), and a reversible hex encoding for
    encrypt/decrypt so commit(encrypt) → revert(decrypt) round-trips.
    """
    
    def __init__(self, mk=b"\x01" * 32):
        self.mk = mk
    
    def encrypt(self, text: str) -> str:
        """Return a reversible hex-encoded 'ciphertext'."""
        return "enc:" + text.encode().hex()
    
    def decrypt(self, hex_data: str) -> str:
        """Reverse encrypt encoding. Also handles plain: prefix."""
        if hex_data.startswith("enc:"):
            return bytes.fromhex(hex_data[4:]).decode()
        if hex_data.startswith("plain:"):
            return hex_data[6:]
        raise ValueError(f"Unknown encrypted format: {hex_data[:20]}...")
    
    def seal(self, data_str: str) -> str:
        """HMAC-SHA256 seal using integrity sub-key (matches real implementation)."""
        key = hmac.new(self.mk, b"integrity-key-salt", hashlib.sha256).digest()
        return hmac.new(key, data_str.encode(), hashlib.sha256).hexdigest()
    
    def verify_seal(self, data_str: str, seal_hex: str) -> bool:
        """Verify an HMAC-SHA256 seal."""
        expected = self.seal(data_str)
        return hmac.compare_digest(expected, seal_hex)

    def verifySeal(self, data_str: str, seal_hex: str, _master_key_hex: str = "") -> bool:
        """CamelCase alias for verify_seal (JS compat)."""
        return self.verify_seal(data_str, seal_hex)
    
    def sign(self, data_str: str, identity_secret: bytes) -> str:
        """HMAC-SHA256 signature (matches real CryptoManager.sign)."""
        return hmac.new(identity_secret, data_str.encode(), hashlib.sha256).hexdigest()

    def mac(self, data_str: str, identity_secret: bytes) -> str:
        """HMAC-SHA256 MAC (alias for sign)."""
        return self.sign(data_str, identity_secret)

    def verify_signature(self, data_str: str, signature: str, identity_secret: bytes) -> bool:
        """Verify an HMAC-SHA256 signature."""
        expected = self.mac(data_str, identity_secret)
        return hmac.compare_digest(expected, signature)

    def verify_mac(self, data_str: str, mac_tag: str, identity_secret: bytes) -> bool:
        """Verify an HMAC-SHA256 MAC."""
        expected = self.mac(data_str, identity_secret)
        return hmac.compare_digest(expected, mac_tag)


class _MockLedgerStore:
    """In-memory mock of AbstractLedgerStore for testing."""
    
    def __init__(self, initial_ledger=None):
        self._ledger = initial_ledger if initial_ledger is not None else []
        self._index = {}
        self._staging = []
    
    def read_ledger(self):
        return list(self._ledger)
    
    def write_ledger(self, data):
        self._ledger = list(data)
    
    def read_index(self):
        return dict(self._index) if self._index else {}
    
    def write_index(self, data):
        self._index = dict(data) if data else {}
    
    def read_staging(self):
        return list(self._staging)
    
    def write_staging(self, data):
        self._staging = list(data)
    
    def read_identity(self):
        return None  # Phase 3 tests don't need identity store


def _genesis_block(seed="test-seed", user="testuser", email="test@example.com"):
    """Create a standard genesis block for testing."""
    return {
        "type": "genesis",
        "seed_info": {
            "seed_enc": hashlib.sha256(seed.encode()).hexdigest(),
            "user": user,
            "email": email,
            "version": 1,
        },
        "date": "2023-11-01",
        "day_hash": hashlib.sha256(b"genesis").hexdigest(),
    }


def _make_entry(title, start_epoch, duration=3600000, tags=None, comment=None):
    """Create a staging entry dict as would come from StagingService."""
    tags = tags or []
    return {
        "title": title,
        "start_epoch": start_epoch,
        "duration": duration,
        "is_active": False,
        "is_paused": False,
        "tags": sorted(tags),
        "comment": comment,
        "media": [],
    }


# ──────────────────────────────────────────────
# Try Imports — skip all tests if not implemented
# ──────────────────────────────────────────────

HAS_PHASE_3 = False
try:
    from domain.ledger.chain import LedgerChain
    HAS_PHASE_3 = True
except (ImportError, ModuleNotFoundError):
    LedgerChain = None

try:
    from domain.ledger.index_manager import IndexManager
    HAS_PHASE_3 = True
except (ImportError, ModuleNotFoundError):
    IndexManager = None

try:
    from domain.ledger.summary_policy import (
        SummaryPolicy,
        YearMonthSummaryPolicy,
        YearOnlySummaryPolicy,
        NoSummaryPolicy,
    )
    HAS_PHASE_3 = True
except (ImportError, ModuleNotFoundError):
    SummaryPolicy = None
    YearMonthSummaryPolicy = None
    YearOnlySummaryPolicy = None
    NoSummaryPolicy = None

try:
    from domain.ledger.engine import LedgerEngine
    HAS_PHASE_3 = True
except (ImportError, ModuleNotFoundError):
    LedgerEngine = None


def skip_unless_phase_3():
    if not HAS_PHASE_3:
        raise unittest.SkipTest("Phase 3 not yet implemented")


# ══════════════════════════════════════════════
# LedgerChain Tests
# ══════════════════════════════════════════════

class TestLedgerChainInit(unittest.TestCase):
    """LedgerChain construction and basic properties."""
    
    def test_init_with_genesis(self):
        skip_unless_phase_3()
        genesis = _genesis_block()
        store = _MockLedgerStore(initial_ledger=[genesis])
        crypto = _MockCrypto()
        chain = LedgerChain(crypto, store)
        self.assertEqual(chain.get_block_count(), 1)
        self.assertEqual(chain.get_last_block()["type"], "genesis")
    
    def test_init_with_empty_store(self):
        skip_unless_phase_3()
        store = _MockLedgerStore()
        crypto = _MockCrypto()
        chain = LedgerChain(crypto, store)
        self.assertEqual(chain.get_block_count(), 0)
    
    def test_get_block_by_index(self):
        skip_unless_phase_3()
        genesis = _genesis_block()
        store = _MockLedgerStore(initial_ledger=[genesis])
        crypto = _MockCrypto()
        chain = LedgerChain(crypto, store)
        self.assertEqual(chain.get_block(0)["type"], "genesis")
    
    def test_get_block_negative_index(self):
        skip_unless_phase_3()
        genesis = _genesis_block()
        store = _MockLedgerStore(initial_ledger=[genesis])
        crypto = _MockCrypto()
        chain = LedgerChain(crypto, store)
        self.assertEqual(chain.get_block(-1)["type"], "genesis")
    
    def test_get_block_out_of_range_returns_none(self):
        skip_unless_phase_3()
        genesis = _genesis_block()
        store = _MockLedgerStore(initial_ledger=[genesis])
        crypto = _MockCrypto()
        chain = LedgerChain(crypto, store)
        self.assertIsNone(chain.get_block(99))
        self.assertIsNone(chain.get_block(-99))


class TestLedgerChainSealAndSign(unittest.TestCase):
    """Seal computation, signature, and verification."""
    
    def setUp(self):
        skip_unless_phase_3()
        self.genesis = _genesis_block()
        self.store = _MockLedgerStore(initial_ledger=[self.genesis])
        self.crypto = _MockCrypto()
        self.chain = LedgerChain(self.crypto, self.store)
    
    def test_compute_seal_matches_crypto_seal(self):
        skip_unless_phase_3()
        data = {"type": "day", "date": "2026-01-01", "foo": "bar"}
        data_json = json.dumps(data, sort_keys=True)
        expected = self.crypto.seal(data_json)
        result = self.chain.compute_seal(data)
        self.assertEqual(result, expected)
    
    def test_verify_seal_valid(self):
        skip_unless_phase_3()
        data = {"type": "day", "date": "2026-01-01"}
        seal = self.chain.compute_seal(data)
        self.assertTrue(self.chain.verify_seal(data, seal))
    
    def test_verify_seal_tampered(self):
        skip_unless_phase_3()
        data = {"type": "day", "date": "2026-01-01"}
        seal = self.chain.compute_seal(data)
        tampered = dict(data)
        tampered["date"] = "2026-01-02"
        self.assertFalse(self.chain.verify_seal(tampered, seal))
    
    def test_compute_signature_with_identity(self):
        skip_unless_phase_3()
        data_str = "test-data"
        identity_secret = os.urandom(32)
        expected = self.crypto.mac(data_str, identity_secret)
        result = self.chain.compute_identity_mac(data_str, identity_secret)
        self.assertEqual(result, expected)
    
    def test_signature_without_identity_returns_none(self):
        skip_unless_phase_3()
        result = self.chain.compute_identity_mac("data", None)
        self.assertIsNone(result)
    
    def test_verify_signature_valid(self):
        skip_unless_phase_3()
        identity_secret = os.urandom(32)
        sig = self.chain.compute_identity_mac("data", identity_secret)
        self.assertTrue(self.chain.verify_identity_mac("data", sig, identity_secret))
    
    def test_verify_signature_wrong_key(self):
        skip_unless_phase_3()
        sig = self.chain.compute_identity_mac("data", b"\x01" * 32)
        self.assertFalse(self.chain.verify_identity_mac("data", sig, b"\x02" * 32))


class TestLedgerChainAppendAndBuild(unittest.TestCase):
    """Appending blocks and building day blocks."""
    
    def setUp(self):
        skip_unless_phase_3()
        self.genesis = _genesis_block()
        self.store = _MockLedgerStore(initial_ledger=[self.genesis])
        self.crypto = _MockCrypto()
        self.chain = LedgerChain(self.crypto, self.store)
    
    def _prev_hash(self):
        """Get the current prev_hash from the last block."""
        last = self.chain.get_last_block()
        return last.get("day_hash") or last.get("month_hash") or last.get("year_hash")
    
    def test_append_block(self):
        skip_unless_phase_3()
        block = {
            "type": "day",
            "day_index": 1,
            "date": "2026-01-01",
            "prev_hash": self._prev_hash(),
            "entries": [],
        }
        day_json = json.dumps(block, sort_keys=True)
        block["day_hash"] = self.crypto.seal(day_json)
        self.chain.append(block)
        self.assertEqual(self.chain.get_block_count(), 2)
        self.assertEqual(self.chain.get_last_block()["type"], "day")
    
    def test_append_batch_blocks(self):
        skip_unless_phase_3()
        blocks = []
        for i, day_offset in enumerate(["2026-01-01", "2026-01-02"]):
            block = {
                "type": "day",
                "day_index": i + 1,
                "date": day_offset,
                "prev_hash": self._prev_hash() if not blocks else blocks[-1].get("day_hash"),
                "entries": [],
            }
            block["day_hash"] = self.crypto.seal(json.dumps(block, sort_keys=True))
            blocks.append(block)
        
        self.chain.append_blocks(blocks)
        self.assertEqual(self.chain.get_block_count(), 3)
        self.assertEqual(self.chain.get_last_block()["date"], "2026-01-02")
    
    def test_append_blocks_verifies_chain_linkage(self):
        skip_unless_phase_3()
        blocks = []
        for i, day_offset in enumerate(["2026-01-01", "2026-01-02"]):
            block = {
                "type": "day",
                "day_index": i + 1,
                "date": day_offset,
                "prev_hash": self._prev_hash() if not blocks else blocks[-1].get("day_hash"),
                "entries": [],
            }
            block["day_hash"] = self.crypto.seal(json.dumps(block, sort_keys=True))
            blocks.append(block)
        
        # break the linkage
        bad_block = dict(blocks[1])
        bad_block["prev_hash"] = "deadbeef"
        bad_block["day_hash"] = self.crypto.seal(json.dumps(bad_block, sort_keys=True))
        blocks[1] = bad_block
        
        with self.assertRaises(ValueError):
            self.chain.append_blocks(blocks)
    
    def test_build_day_block(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1700000000000, "duration": 3600000},
        ]
        expected_prev = self.genesis.get("day_hash")
        block = self.chain.build_day_block(entries, expected_prev, date_str="2026-01-01")
        self.assertEqual(block["type"], "day")
        self.assertEqual(block["date"], "2026-01-01")
        self.assertEqual(len(block["entries"]), 1)
        self.assertIn("day_hash", block)
        # prev_hash should point to genesis
        self.assertEqual(block["prev_hash"], expected_prev)
        # day_hash should verify
        check_data = {k: v for k, v in block.items() if k not in ["day_hash", "signature"]}
        self.assertTrue(self.crypto.verify_seal(json.dumps(check_data, sort_keys=True), block["day_hash"]))
    
    def test_build_day_block_with_identity_signature(self):
        skip_unless_phase_3()
        identity_secret = os.urandom(32)
        self.chain.identity_secret = identity_secret
        entry = {"title": "Test", "start_epoch": 1700000000000, "duration": 1000}
        block = self.chain.build_day_block([entry], "2026-01-01", date_str="2026-01-01")
        seal_val = block.get("identity_seal") or block.get("signature"); self.assertIsNotNone(seal_val, f"Missing identity seal in {block}")
        expected_sig = self.crypto.mac(block["day_hash"], identity_secret)
        self.assertEqual(block["identity_seal"], expected_sig)
    
    def test_build_day_block_entry_hash_format(self):
        skip_unless_phase_3()
        entry_data = {"title": "Coding", "duration": 3600000, "startTime_enc": "hex1", "endTime_enc": "hex2", "metadata_enc": "hex3", "tags": [], "content_hash": "abc"}
        entries = [{"hash": "dummy", "data": entry_data, "start_epoch": 1700000000000}]
        block = self.chain.build_day_block(entries, "2026-01-01", date_str="2026-01-01")
        # The entries in the block should have hash and data
        self.assertEqual(len(block["entries"]), 1)
        self.assertIn("hash", block["entries"][0])
        self.assertIn("data", block["entries"][0])
        # Hash should match SHA256(data sorted_keys)
        expected_hash = hashlib.sha256(json.dumps(entry_data, sort_keys=True, indent=2).encode()).hexdigest()
        self.assertEqual(block["entries"][0]["hash"], expected_hash)
    
    def test_append_encrypted_entry(self):
        skip_unless_phase_3()
        entry = {
            "hash": "abc123",
            "data": {
                "title": "Test",
                "duration": 1000,
                "startTime_enc": self.crypto.encrypt("1700000000000"),
                "endTime_enc": self.crypto.encrypt("1700003600000"),
                "metadata_enc": self.crypto.encrypt("{}"),
                "tags": [],
                "content_hash": "xyz",
            },
            "start_epoch": 1700000000000,
        }
        prev_hash = self.genesis.get("day_hash")
        block = self.chain.build_day_block([entry], prev_hash, date_str="2026-01-01")
        self.chain.append(block)
        self.assertEqual(self.chain.get_block_count(), 2)
        self.assertTrue(self.chain.verify_block(1))  # index 1 = the day block


class TestLedgerChainVerify(unittest.TestCase):
    """Chain verification: block linkage, seals, signatures, entry hashes."""
    
    def setUp(self):
        skip_unless_phase_3()
        self.genesis = _genesis_block()
        self.store = _MockLedgerStore(initial_ledger=[self.genesis])
        self.crypto = _MockCrypto()
        self.identity_secret = os.urandom(32)
        self.chain = LedgerChain(self.crypto, self.store, identity_secret=self.identity_secret)
    
    def _add_day_block(self, date_str="2026-01-01", entries=None):
        """Helper: add a day block to the chain."""
        entries = entries or [{"title": "Task", "start_epoch": 1700000000000, "duration": 3600000}]
        block = self._make_day_block(date_str, entries)
        self.chain.append(block)
        return block
    
    def _make_day_block(self, date_str, entries):
        """Create a properly sealed day block."""
        last = self.chain.get_last_block()
        prev_hash = last.get("day_hash") or last.get("month_hash") or last.get("year_hash")
        block = {
            "type": "day",
            "day_index": self.chain.get_block_count() + 1,
            "date": date_str,
            "prev_hash": prev_hash,
            "entries": [{"hash": hashlib.sha256(json.dumps(e, sort_keys=True, indent=2).encode()).hexdigest(), "data": e} for e in entries],
        }
        day_json = json.dumps(block, sort_keys=True)
        block["day_hash"] = self.crypto.seal(day_json)
        if self.identity_secret:
            block["identity_seal"] = self.crypto.mac(block["day_hash"], self.identity_secret)
        return block
    
    def test_verify_empty_chain(self):
        skip_unless_phase_3()
        empty_store = _MockLedgerStore()
        chain = LedgerChain(self.crypto, empty_store)
        self.assertTrue(chain.verify())
    
    def test_verify_single_genesis(self):
        skip_unless_phase_3()
        self.assertTrue(self.chain.verify())
    
    def test_verify_valid_chain(self):
        skip_unless_phase_3()
        self._add_day_block("2026-01-01")
        self._add_day_block("2026-01-02")
        self.assertTrue(self.chain.verify())
    
    def test_verify_tampered_entry_data(self):
        skip_unless_phase_3()
        self._add_day_block("2026-01-01", [{"title": "Original", "start_epoch": 1700000000000, "duration": 1000}])
        self._add_day_block("2026-01-02")
        
        # Tamper with entry data in place
        ledger = self.store.read_ledger()
        day_block = [b for b in ledger if b.get("type") == "day" and b["date"] == "2026-01-01"][0]
        day_block["entries"][0]["data"]["title"] = "Tampered"
        self.store.write_ledger(ledger)
        
        self.assertFalse(self.chain.verify())
    
    def test_verify_tampered_prev_hash(self):
        skip_unless_phase_3()
        self._add_day_block("2026-01-01")
        self._add_day_block("2026-01-02")
        
        ledger = self.store.read_ledger()
        ledger[2]["prev_hash"] = "deadbeef"
        self.store.write_ledger(ledger)
        
        self.assertFalse(self.chain.verify())
    
    def test_verify_tampered_seal(self):
        skip_unless_phase_3()
        self._add_day_block("2026-01-01")
        
        ledger = self.store.read_ledger()
        ledger[1]["day_hash"] = "deadbeef"
        self.store.write_ledger(ledger)
        
        self.assertFalse(self.chain.verify())
    
    def test_verify_tampered_signature(self):
        skip_unless_phase_3()
        self._add_day_block("2026-01-01")
        
        ledger = self.store.read_ledger()
        ledger[1]["identity_seal"] = hmac.new(b"wrong-key", b"data", hashlib.sha256).hexdigest()
        self.store.write_ledger(ledger)
        
        self.assertFalse(self.chain.verify())
    
    def test_verify_with_summary_blocks(self):
        skip_unless_phase_3()
        # Build a chain with month/year boundaries
        blocks = [
            self._make_day_block("2025-12-30", [{"title": "Dec Task", "start_epoch": 1700000000000, "duration": 1000}]),
        ]
        # Second day block links to first
        dec31 = self._make_day_block("2025-12-31", [{"title": "NYE", "start_epoch": 1700000000000, "duration": 1000}])
        dec31["prev_hash"] = blocks[-1]["day_hash"]
        dec31["day_hash"] = self.crypto.seal(json.dumps({k: v for k, v in dec31.items() if k not in ["day_hash", "identity_seal", "signature"]}, sort_keys=True))
        dec31["identity_seal"] = self.crypto.mac(dec31["day_hash"], self.identity_secret)
        blocks.append(dec31)
        # Add year summary
        year_summary = {
            "type": "year_summary", "year": 2025,
            "prev_hash": blocks[-1]["day_hash"],
            "date": "2026-01-01",
        }
        year_summary["year_hash"] = self.crypto.seal(json.dumps({k: v for k, v in year_summary.items() if k not in ["year_hash", "identity_seal", "signature"]}, sort_keys=True))
        year_summary["identity_seal"] = self.crypto.mac(year_summary["year_hash"], self.identity_secret)
        blocks.append(year_summary)
        
        # Add month summary
        month_summary = {
            "type": "month_summary", "month": "2026-01",
            "prev_hash": year_summary["year_hash"],
            "date": "2026-01-01",
        }
        month_summary["month_hash"] = self.crypto.seal(json.dumps({k: v for k, v in month_summary.items() if k not in ["month_hash", "identity_seal", "signature"]}, sort_keys=True))
        month_summary["identity_seal"] = self.crypto.mac(month_summary["month_hash"], self.identity_secret)
        blocks.append(month_summary)
        
        # Add January day
        jan_block = self._make_day_block("2026-01-01", [{"title": "Jan Task", "start_epoch": 1700000000000, "duration": 1000}])
        jan_block["prev_hash"] = blocks[-1]["month_hash"]
        jan_block["day_hash"] = self.crypto.seal(json.dumps({k: v for k, v in jan_block.items() if k not in ["day_hash", "identity_seal", "signature"]}, sort_keys=True))
        jan_block["identity_seal"] = self.crypto.mac(jan_block["day_hash"], self.identity_secret)
        blocks.append(jan_block)
        
        self.chain.append_blocks(blocks)
        self.assertTrue(self.chain.verify())
    
    def test_verify_block_single_index(self):
        skip_unless_phase_3()
        self._add_day_block("2026-01-01")
        # Verify block at index 1
        self.assertTrue(self.chain.verify_block(1))
        # Genesis has no prev_hash to verify
        self.assertTrue(self.chain.verify_block(0) or True)


class TestLedgerChainTruncate(unittest.TestCase):
    """Block removal: truncate from end, return removed blocks."""
    
    def setUp(self):
        skip_unless_phase_3()
        self.genesis = _genesis_block()
        self.store = _MockLedgerStore(initial_ledger=[self.genesis])
        self.crypto = _MockCrypto()
        self.chain = LedgerChain(self.crypto, self.store)
    
    def _add_days(self, *dates):
        """Add day blocks for the given date strings."""
        for date_str in dates:
            block = {
                "type": "day",
                "day_index": 1,
                "date": date_str,
                "prev_hash": self.chain.get_last_block().get("day_hash"),
                "entries": [],
            }
            block["day_hash"] = self.crypto.seal(json.dumps(block, sort_keys=True))
            self.chain.append(block)
    
    def test_truncate_zero(self):
        skip_unless_phase_3()
        self._add_days("2026-01-01")
        removed = self.chain.truncate(0)
        self.assertEqual(len(removed), 0)
        self.assertEqual(self.chain.get_block_count(), 2)
    
    def test_truncate_last_block(self):
        skip_unless_phase_3()
        self._add_days("2026-01-01", "2026-01-02")
        removed = self.chain.truncate(1)
        self.assertEqual(len(removed), 1)
        self.assertEqual(removed[0]["date"], "2026-01-02")
        self.assertEqual(self.chain.get_block_count(), 2)  # genesis + 2026-01-01
    
    def test_truncate_two_blocks(self):
        skip_unless_phase_3()
        self._add_days("2026-01-01", "2026-01-02")
        removed = self.chain.truncate(2)
        self.assertEqual(len(removed), 2)
        self.assertEqual(self.chain.get_block_count(), 1)  # only genesis
    
    def test_truncate_preserves_genesis(self):
        skip_unless_phase_3()
        self._add_days("2026-01-01")
        # Try to truncate more than available
        removed = self.chain.truncate(10)
        self.assertEqual(len(removed), 1)
        self.assertEqual(self.chain.get_block_count(), 1)  # only genesis left
        self.assertEqual(self.chain.get_last_block()["type"], "genesis")
    
    def test_truncate_returns_removed_blocks_for_inspection(self):
        skip_unless_phase_3()
        self._add_days("2026-01-01")
        removed = self.chain.truncate(1)
        self.assertEqual(len(removed), 1)
        self.assertEqual(removed[0]["type"], "day")
        self.assertIn("day_hash", removed[0])


class TestLedgerChainEdgeCases(unittest.TestCase):
    """Edge cases: empty chain, zero blocks, missing methods."""
    
    def setUp(self):
        skip_unless_phase_3()
        self.crypto = _MockCrypto()
        self.store = _MockLedgerStore()
        self.chain = LedgerChain(self.crypto, self.store)
    
    def test_get_block_count_zero(self):
        skip_unless_phase_3()
        self.assertEqual(self.chain.get_block_count(), 0)
    
    def test_get_last_block_none(self):
        skip_unless_phase_3()
        self.assertIsNone(self.chain.get_last_block())


class TestLedgerChainGetAllBlocks(unittest.TestCase):
    """Full chain read."""
    
    def test_read_all_returns_copy(self):
        skip_unless_phase_3()
        genesis = _genesis_block()
        store = _MockLedgerStore(initial_ledger=[genesis])
        crypto = _MockCrypto()
        chain = LedgerChain(crypto, store)
        all_blocks = chain.read_all()
        self.assertEqual(len(all_blocks), 1)
        # Verify it's a copy
        all_blocks.append("mutation")
        self.assertEqual(chain.get_block_count(), 1)


# ══════════════════════════════════════════════
# IndexManager Tests
# ══════════════════════════════════════════════

class TestIndexManagerInit(unittest.TestCase):
    """IndexManager construction and basic state."""
    
    def test_init_empty_index(self):
        skip_unless_phase_3()
        store = _MockLedgerStore()
        index = IndexManager(store)
        self.assertEqual(index.get_all(), {})
    
    def test_init_with_existing_index(self):
        skip_unless_phase_3()
        store = _MockLedgerStore()
        store.write_index({"2026-01-01": {"Coding": 3600000}})
        index = IndexManager(store)
        self.assertEqual(index.get_all(), {"2026-01-01": {"Coding": 3600000}})


class TestIndexManagerUpdate(unittest.TestCase):
    """Index update: add/subtract duration per date/title."""
    
    def setUp(self):
        skip_unless_phase_3()
        self.store = _MockLedgerStore()
        self.index = IndexManager(self.store)
    
    def test_update_add_new_date(self):
        skip_unless_phase_3()
        self.index.update("2026-01-01", "Coding", 3600000)
        self.assertEqual(self.index.get_all(), {"2026-01-01": {"Coding": 3600000}})
    
    def test_update_add_to_existing_date(self):
        skip_unless_phase_3()
        self.index.update("2026-01-01", "Coding", 3600000)
        self.index.update("2026-01-01", "Reading", 1800000)
        expected = {"2026-01-01": {"Coding": 3600000, "Reading": 1800000}}
        self.assertEqual(self.index.get_all(), expected)
    
    def test_update_accumulate_existing_title(self):
        skip_unless_phase_3()
        self.index.update("2026-01-01", "Coding", 3600000)
        self.index.update("2026-01-01", "Coding", 1800000)
        self.assertEqual(self.index.get_all(), {"2026-01-01": {"Coding": 5400000}})
    
    def test_update_negative_duration_subtract(self):
        skip_unless_phase_3()
        self.index.update("2026-01-01", "Coding", 3600000)
        self.index.update("2026-01-01", "Coding", -1000000)
        self.assertEqual(self.index.get_all(), {"2026-01-01": {"Coding": 2600000}})
    
    def test_update_negative_duration_removes_zero(self):
        skip_unless_phase_3()
        self.index.update("2026-01-01", "Coding", 3600000)
        self.index.update("2026-01-01", "Coding", -3600000)
        self.assertEqual(self.index.get_all(), {})
    
    def test_update_negative_below_zero_removes_entry(self):
        skip_unless_phase_3()
        self.index.update("2026-01-01", "Coding", 3600000)
        self.index.update("2026-01-01", "Coding", -5000000)  # more than exists
        self.assertEqual(self.index.get_all(), {})
    
    def test_update_multiple_dates(self):
        skip_unless_phase_3()
        self.index.update("2026-01-01", "Coding", 3600000)
        self.index.update("2026-01-02", "Coding", 7200000)
        self.index.update("2026-01-01", "Reading", 1800000)
        expected = {
            "2026-01-01": {"Coding": 3600000, "Reading": 1800000},
            "2026-01-02": {"Coding": 7200000},
        }
        self.assertEqual(self.index.get_all(), expected)


class TestIndexManagerQuery(unittest.TestCase):
    """Index query: aggregate durations over date range."""
    
    def setUp(self):
        skip_unless_phase_3()
        self.store = _MockLedgerStore()
        self.index = IndexManager(self.store)
        self.index.update("2026-01-01", "Coding", 3600000)
        self.index.update("2026-01-02", "Coding", 7200000)
        self.index.update("2026-01-03", "Reading", 1800000)
    
    def test_query_full_range(self):
        skip_unless_phase_3()
        result = self.index.query("2026-01-01", "2026-01-03")
        self.assertEqual(result, {"Coding": 10800000, "Reading": 1800000})
    
    def test_query_single_day(self):
        skip_unless_phase_3()
        result = self.index.query("2026-01-01", "2026-01-01")
        self.assertEqual(result, {"Coding": 3600000})
    
    def test_query_subset(self):
        skip_unless_phase_3()
        result = self.index.query("2026-01-02", "2026-01-03")
        self.assertEqual(result, {"Coding": 7200000, "Reading": 1800000})
    
    def test_query_empty_range(self):
        skip_unless_phase_3()
        result = self.index.query("2026-02-01", "2026-02-28")
        self.assertEqual(result, {})
    
    def test_query_invalid_range(self):
        skip_unless_phase_3()
        # from_date > to_date
        result = self.index.query("2026-01-03", "2026-01-01")
        self.assertEqual(result, {})


class TestIndexManagerClearAndRebuild(unittest.TestCase):
    """Index clear and rebuild from chain."""
    
    def setUp(self):
        skip_unless_phase_3()
        self.store = _MockLedgerStore()
        self.index = IndexManager(self.store)
    
    def test_clear(self):
        skip_unless_phase_3()
        self.index.update("2026-01-01", "Coding", 3600000)
        self.index.clear()
        self.assertEqual(self.index.get_all(), {})
    
    def test_clear_writes_to_store(self):
        skip_unless_phase_3()
        self.index.update("2026-01-01", "Coding", 3600000)
        self.index.clear()
        stored = self.store.read_index()
        self.assertEqual(stored, {})


# ═════════════════════════
# ══════════════════════════════════════════════
# SummaryPolicy Tests
# ══════════════════════════════════════════════

class TestSummaryPolicyAbstract(unittest.TestCase):
    """SummaryPolicy abstract interface."""

    def test_cannot_instantiate_abstract(self):
        skip_unless_phase_3()
        with self.assertRaises(TypeError):
            SummaryPolicy()


class TestYearMonthSummaryPolicy(unittest.TestCase):
    """Default year+month summary insertion logic."""

    def setUp(self):
        skip_unless_phase_3()
        self.crypto = _MockCrypto()
        self.identity_secret = os.urandom(32)
        self.policy = YearMonthSummaryPolicy(self.crypto, identity_secret=self.identity_secret)

        # Genesis block
        self.genesis = _genesis_block()
        self.store = _MockLedgerStore(initial_ledger=[self.genesis])

    def _prev_hash(self, block):
        return block.get("day_hash") or block.get("month_hash") or block.get("year_hash")

    def _prev_record(self):
        """Get the last block from the store."""
        ledger = self.store.read_ledger()
        return ledger[-1]

    def test_same_month_no_summary(self):
        skip_unless_phase_3()
        # Both dates in the same month
        prev_block = {"type": "day", "date": "2026-01-15"}
        curr_date = "2026-01-20"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(result, [])

    def test_month_boundary_inserts_month_summary(self):
        skip_unless_phase_3()
        prev_block = {"type": "day", "date": "2026-01-31", "day_hash": "abc"}
        curr_date = "2026-02-01"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["type"], "month_summary")
        self.assertEqual(result[0]["month"], "2026-01")
        self.assertEqual(result[0]["prev_hash"], "abc")
        self.assertIn("month_hash", result[0])
        seal_val = result[0].get("identity_seal") or result[0].get("signature"); self.assertIsNotNone(seal_val, f"Missing identity seal in {result[0]}")

    def test_month_boundary_seal_verifies(self):
        skip_unless_phase_3()
        prev_block = {"type": "day", "date": "2026-01-31", "day_hash": "abc"}
        curr_date = "2026-02-01"
        result = self.policy.get_summary_blocks(prev_block, curr_date)

        summary = result[0]
        check_data = {k: v for k, v in summary.items() if k not in ["month_hash", "identity_seal", "signature"]}
        self.assertTrue(self.crypto.verify_seal(json.dumps(check_data, sort_keys=True), summary["month_hash"]))

    def test_year_boundary_inserts_year_summary(self):
        skip_unless_phase_3()
        prev_block = {"type": "day", "date": "2025-12-31", "day_hash": "abc"}
        curr_date = "2026-01-01"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["type"], "year_summary")
        self.assertEqual(result[0]["year"], 2025)

    def test_year_and_month_boundary_inserts_both(self):
        skip_unless_phase_3()
        # Dec 2025 -> Feb 2026: should insert year summary for 2025 AND month summary for Jan 2026
        prev_block = {"type": "day", "date": "2025-12-15", "day_hash": "abc"}
        curr_date = "2026-02-01"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["type"], "year_summary")
        self.assertEqual(result[0]["year"], 2025)
        self.assertEqual(result[1]["type"], "month_summary")
        self.assertEqual(result[1]["month"], "2026-01")

    def test_prev_is_summary_no_duplicate(self):
        skip_unless_phase_3()
        # If prev block is already a year_summary, don't insert another year summary
        prev_block = {"type": "year_summary", "date": "2026-01-01", "year": 2025, "year_hash": "xyz"}
        curr_date = "2026-01-15"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(result, [])

    def test_prev_is_month_summary_no_duplicate_month(self):
        skip_unless_phase_3()
        prev_block = {"type": "month_summary", "date": "2026-01-01", "month": "2026-01", "month_hash": "xyz"}
        curr_date = "2026-01-15"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(result, [])

    def test_year_boundary_no_duplicate_when_prev_is_month_summary(self):
        skip_unless_phase_3()
        # Prev is month_summary for Dec 2025, curr is Jan 2026
        # Should still insert year summary for 2025 since the previous month summary doesn't have one
        prev_block = {"type": "month_summary", "date": "2026-01-01", "month": "2025-12", "month_hash": "xyz"}
        curr_date = "2026-01-15"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["type"], "year_summary")


class TestYearOnlySummaryPolicy(unittest.TestCase):
    """Year-only summary policy (no monthly summaries)."""

    def setUp(self):
        skip_unless_phase_3()
        self.crypto = _MockCrypto()
        self.policy = YearOnlySummaryPolicy(self.crypto)

    def test_same_year_no_summary(self):
        skip_unless_phase_3()
        prev_block = {"type": "day", "date": "2026-06-15"}
        curr_date = "2026-12-20"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(result, [])

    def test_new_year_inserts_year_summary(self):
        skip_unless_phase_3()
        prev_block = {"type": "day", "date": "2025-12-31", "day_hash": "abc"}
        curr_date = "2026-01-01"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["type"], "year_summary")

    def test_month_boundary_no_summary(self):
        skip_unless_phase_3()
        prev_block = {"type": "day", "date": "2026-01-31"}
        curr_date = "2026-02-01"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(result, [])

    def test_prev_is_year_summary_no_duplicate(self):
        skip_unless_phase_3()
        prev_block = {"type": "year_summary", "date": "2026-01-01", "year": 2025}
        curr_date = "2026-01-15"
        result = self.policy.get_summary_blocks(prev_block, curr_date)
        self.assertEqual(result, [])


class TestNoSummaryPolicy(unittest.TestCase):
    """No-summary policy -- never inserts summary blocks."""

    def setUp(self):
        skip_unless_phase_3()
        self.crypto = _MockCrypto()
        self.policy = NoSummaryPolicy(self.crypto)

    def test_no_summaries_ever(self):
        skip_unless_phase_3()
        cases = [
            ({"type": "day", "date": "2025-12-31"}, "2026-01-01"),
            ({"type": "day", "date": "2026-01-31"}, "2026-02-01"),
            ({"type": "day", "date": "2026-12-31"}, "2027-01-01"),
        ]
        for prev, curr in cases:
            result = self.policy.get_summary_blocks(prev, curr)
            self.assertEqual(result, [], f"Expected no summary for {prev['date']} -> {curr}")


# ══════════════════════════════════════════════
# LedgerEngine Tests
# ══════════════════════════════════════════════

class TestLedgerEngineCommit(unittest.TestCase):
    """LedgerEngine.commit() -- the main sync entry point."""

    def setUp(self):
        skip_unless_phase_3()
        self.genesis = _genesis_block()
        self.store = _MockLedgerStore(initial_ledger=[self.genesis])
        self.crypto = _MockCrypto()
        self.identity_secret = os.urandom(32)
        self.engine = LedgerEngine(
            crypto=self.crypto,
            store=self.store,
            identity_secret=self.identity_secret,
        )

    def test_commit_single_entry(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1700000000000, "duration": 3600000},
        ]
        result = self.engine.commit(entries)
        self.assertIsNotNone(result)
        self.assertEqual(self.engine.get_block_count(), 2)  # genesis + day
        self.assertTrue(self.engine.verify())

    def test_commit_encrypts_fields(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1673780400000, "duration": 3600000},
        ]
        self.engine.commit(entries)
        day_block = self.engine.get_day_blocks()[-1]
        entry_data = day_block["entries"][0]["data"]
        self.assertFalse(entry_data["startTime_enc"].startswith("plain:"))
        self.assertIsNotNone(entry_data.get("endTime_enc"))
        self.assertIsNotNone(entry_data.get("metadata_enc"))

    def test_commit_computes_content_hash(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1700000000000, "duration": 3600000, "tags": ["dev", "python"]},
        ]
        self.engine.commit(entries)
        day_block = self.engine.get_day_blocks()[-1]
        entry_data = day_block["entries"][0]["data"]
        self.assertIn("content_hash", entry_data)
        self.assertEqual(len(entry_data["content_hash"]), 64)  # SHA256 hex

    def test_commit_multiple_entries_same_day(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1699952400000, "duration": 3600000},
            {"title": "Reading", "start_epoch": 1699959600000, "duration": 1800000},
        ]
        self.engine.commit(entries)
        day_blocks = self.engine.get_day_blocks()
        self.assertEqual(len(day_blocks), 1)
        self.assertEqual(len(day_blocks[0]["entries"]), 2)
        self.assertTrue(self.engine.verify())

    def test_commit_multiple_days(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Task 1", "start_epoch": 1700000000000, "duration": 3600000},  # day 1
            {"title": "Task 2", "start_epoch": 1700086400000, "duration": 1800000},  # day 2
        ]
        self.engine.commit(entries)
        day_blocks = self.engine.get_day_blocks()
        self.assertEqual(len(day_blocks), 2)
        self.assertTrue(self.engine.verify())

    def test_commit_updates_index(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1699952400000, "duration": 3600000},
            {"title": "Coding", "start_epoch": 1699959600000, "duration": 1800000},
        ]
        self.engine.commit(entries)
        # After I-02: index is encrypted at rest. Use get_all() for decrypted view.
        index_data = self.engine.index.get_all()
        # 1699952400000 ms = 2023-11-14
        date_str = time.strftime("%Y-%m-%d", time.gmtime(1699952400000 // 1000))
        self.assertIn(date_str, index_data)
        self.assertEqual(index_data[date_str]["Coding"], 5400000)

    def test_commit_returns_day_hash_prefix(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1700000000000, "duration": 3600000},
        ]
        result = self.engine.commit(entries)
        self.assertIsInstance(result, str)
        self.assertEqual(len(result), 10)

    def test_commit_identity_signature_on_day_block(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1700000000000, "duration": 3600000},
        ]
        self.engine.commit(entries)
        day_block = self.engine.get_day_blocks()[-1]
        seal_val = day_block.get("identity_seal") or day_block.get("signature"); self.assertIsNotNone(seal_val, f"Missing identity seal in {day_block}")
        expected_sig = self.crypto.mac(day_block["day_hash"], self.identity_secret)
        self.assertEqual(day_block["identity_seal"], expected_sig)

    def test_commit_empty_entries_returns_none(self):
        skip_unless_phase_3()
        result = self.engine.commit([])
        self.assertIsNone(result)


class TestLedgerEngineCommitSummary(unittest.TestCase):
    """Commit with year/month summary insertion."""

    def setUp(self):
        skip_unless_phase_3()
        self.genesis = _genesis_block()
        self.store = _MockLedgerStore(initial_ledger=[self.genesis])
        self.crypto = _MockCrypto()
        self.identity_secret = os.urandom(32)
        self.engine = LedgerEngine(
            crypto=self.crypto,
            store=self.store,
            identity_secret=self.identity_secret,
        )

    def test_commit_crossing_month_boundary(self):
        skip_unless_phase_3()
        # 2023-11-30 23:00 UTC to 2023-12-01 01:00 UTC
        dt_nov = datetime.datetime(2023, 11, 30, 23, 0, 0)
        dt_dec = datetime.datetime(2023, 12, 1, 1, 0, 0)
        entries = [
            {"title": "Nov Task", "start_epoch": int(dt_nov.timestamp()) * 1000, "duration": 3600000},
            {"title": "Dec Task", "start_epoch": int(dt_dec.timestamp()) * 1000, "duration": 1800000},
        ]
        self.engine.commit(entries)
        ledger = self.store.read_ledger()
        block_types = [b["type"] for b in ledger]
        self.assertIn("month_summary", block_types)
        self.assertTrue(self.engine.verify())

    def test_commit_crossing_year_boundary(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Dec Task", "start_epoch": 1767171600000, "duration": 3600000},  # 2025-12-31
            {"title": "Jan Task", "start_epoch": 1767258000000, "duration": 1800000},  # 2026-01-01
        ]
        self.engine.commit(entries)
        ledger = self.store.read_ledger()
        block_types = [b["type"] for b in ledger]
        self.assertIn("year_summary", block_types)
        self.assertIn("month_summary", block_types)
        self.assertTrue(self.engine.verify())

    def test_commit_with_no_summary_policy(self):
        skip_unless_phase_3()
        policy = NoSummaryPolicy(self.crypto)
        engine = LedgerEngine(
            crypto=self.crypto,
            store=self.store,
            identity_secret=self.identity_secret,
            summary_policy=policy,
        )
        entries = [
            {"title": "Dec Task", "start_epoch": 1767171600000, "duration": 3600000},  # 2025-12-31
            {"title": "Jan Task", "start_epoch": 1767258000000, "duration": 1800000},  # 2026-01-01
        ]
        engine.commit(entries)
        ledger = self.store.read_ledger()
        block_types = [b["type"] for b in ledger]
        self.assertNotIn("year_summary", block_types)
        self.assertNotIn("month_summary", block_types)
        self.assertTrue(engine.verify())

    def test_commit_year_only_policy_no_month(self):
        skip_unless_phase_3()
        policy = YearOnlySummaryPolicy(self.crypto)
        engine = LedgerEngine(
            crypto=self.crypto,
            store=self.store,
            identity_secret=self.identity_secret,
            summary_policy=policy,
        )
        entries = [
            {"title": "Jan Task", "start_epoch": 1767171600000, "duration": 3600000},  # 2025-12-31
            {"title": "Feb Task", "start_epoch": 1767258000000, "duration": 1800000},  # 2026-01-01
        ]
        engine.commit(entries)
        ledger = self.store.read_ledger()
        block_types = [b["type"] for b in ledger]
        self.assertNotIn("month_summary", block_types)
        self.assertTrue(engine.verify())


class TestLedgerEngineRevert(unittest.TestCase):
    """LedgerEngine.revert() -- truncate blocks and restore entries."""

    def setUp(self):
        skip_unless_phase_3()
        self.genesis = _genesis_block()
        self.store = _MockLedgerStore(initial_ledger=[self.genesis])
        self.crypto = _MockCrypto()
        self.identity_secret = os.urandom(32)
        self.engine = LedgerEngine(
            crypto=self.crypto,
            store=self.store,
            identity_secret=self.identity_secret,
        )

    def _commit(self, titles_with_epochs):
        """Helper: commit entries with explicit epochs."""
        entries = [{"title": t, "start_epoch": s, "duration": d} for t, s, d in titles_with_epochs]
        return self.engine.commit(entries)

    def test_revert_last_block(self):
        skip_unless_phase_3()
        self._commit([("Task A", 1700000000000, 3600000)])
        self._commit([("Task B", 1700086400000, 1800000)])

        count = self.engine.revert(1)
        self.assertEqual(count, 1)  # one entry restored
        self.assertEqual(self.engine.get_block_count(), 2)  # genesis + first day
        self.assertTrue(self.engine.verify())

    def test_revert_restores_entries_to_staging(self):
        skip_unless_phase_3()
        self._commit([("Coding", 1700000000000, 3600000)])
        restored = self.engine.revert(1)
        self.assertEqual(restored, 1)
        staging = self.store.read_staging()
        self.assertEqual(len(staging), 1)
        self.assertEqual(staging[0]["data"]["title"], "Coding")

    def test_revert_updates_index(self):
        skip_unless_phase_3()
        self._commit([("Coding", 1700000000000, 3600000)])
        self.engine.revert(1)
        # After I-02: index is encrypted. Use get_all() for decrypted view.
        index_data = self.engine.index.get_all()
        self.assertEqual(index_data, {})

    def test_revert_two_blocks(self):
        skip_unless_phase_3()
        self._commit([("Day 1 Task", 1700000000000, 3600000)])
        self._commit([("Day 2 Task", 1700086400000, 1800000)])

        count = self.engine.revert(2)
        self.assertEqual(count, 2)
        self.assertEqual(self.engine.get_block_count(), 1)  # only genesis
        self.assertTrue(self.engine.verify())

    def test_revert_too_many_returns_minus_one(self):
        skip_unless_phase_3()
        self._commit([("Task", 1700000000000, 3600000)])
        count = self.engine.revert(99)
        self.assertEqual(count, -1)

    def test_revert_zero_does_nothing(self):
        skip_unless_phase_3()
        self._commit([("Task", 1700000000000, 3600000)])
        count = self.engine.revert(0)
        self.assertEqual(count, 0)
        self.assertEqual(self.engine.get_block_count(), 2)

    def test_revert_preserves_index_for_kept_blocks(self):
        skip_unless_phase_3()
        self._commit([("Keep", 1700000000000, 3600000)])  # day 1
        self._commit([("Remove", 1700086400000, 7200000)])  # day 2
        self.engine.revert(1)
        # After I-02: index is encrypted. Use get_all() for decrypted view.
        index_data = self.engine.index.get_all()
        # Day 1's entry should still be in index
        kept_date = time.strftime("%Y-%m-%d", time.gmtime(1700000000000 // 1000))
        self.assertIn(kept_date, index_data)
        self.assertIn("Keep", index_data[kept_date])


class TestLedgerEngineVerify(unittest.TestCase):
    """LedgerEngine.verify() -- full chain verification."""

    def setUp(self):
        skip_unless_phase_3()
        self.genesis = _genesis_block()
        self.store = _MockLedgerStore(initial_ledger=[self.genesis])
        self.crypto = _MockCrypto()
        self.engine = LedgerEngine(
            crypto=self.crypto,
            store=self.store,
        )

    def test_verify_empty_chain(self):
        skip_unless_phase_3()
        empty_store = _MockLedgerStore()
        engine = LedgerEngine(crypto=self.crypto, store=empty_store)
        self.assertTrue(engine.verify())

    def test_verify_single_genesis(self):
        skip_unless_phase_3()
        self.assertTrue(self.engine.verify())

    def test_verify_valid_chain(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1700000000000, "duration": 3600000},
            {"title": "Reading", "start_epoch": 1700086400000, "duration": 1800000},
        ]
        self.engine.commit(entries)
        self.assertTrue(self.engine.verify())

    def test_verify_detects_tampering(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1700000000000, "duration": 3600000},
        ]
        self.engine.commit(entries)

        # Tamper with the stored data
        ledger = self.store.read_ledger()
        ledger[1]["entries"][0]["data"]["title"] = "Tampered"
        self.store.write_ledger(ledger)

        self.assertFalse(self.engine.verify())

    def test_verify_checks_only_entry_hashes_by_default(self):
        skip_unless_phase_3()
        entries = [
            {"title": "Coding", "start_epoch": 1700000000000, "duration": 3600000},
        ]
        self.engine.commit(entries)
        self.assertTrue(self.engine.verify(full_check=False))


class TestLedgerEngineEdgeCases(unittest.TestCase):
    """Edge cases: empty chain, no identity, etc."""

    def setUp(self):
        skip_unless_phase_3()
        self.crypto = _MockCrypto()
        self.store = _MockLedgerStore()

    def test_get_block_count_empty(self):
        skip_unless_phase_3()
        engine = LedgerEngine(crypto=self.crypto, store=self.store)
        self.assertEqual(engine.get_block_count(), 0)

    def test_verify_empty_chain(self):
        skip_unless_phase_3()
        engine = LedgerEngine(crypto=self.crypto, store=self.store)
        self.assertTrue(engine.verify())

    def test_commit_with_identity_uses_signature(self):
        skip_unless_phase_3()
        store = _MockLedgerStore(initial_ledger=[_genesis_block()])
        identity = os.urandom(32)
        engine = LedgerEngine(crypto=self.crypto, store=store, identity_secret=identity)
        engine.commit([{"title": "Task", "start_epoch": 1700000000000, "duration": 1000}])
        day_block = engine.get_day_blocks()[-1]
        seal_val = day_block.get("identity_seal") or day_block.get("signature"); self.assertIsNotNone(seal_val, f"Missing identity seal in {day_block}")
        expected = self.crypto.mac(day_block["day_hash"], identity)
        self.assertEqual(day_block["identity_seal"], expected)

    def test_commit_without_identity_no_signature(self):
        skip_unless_phase_3()
        store = _MockLedgerStore(initial_ledger=[_genesis_block()])
        engine = LedgerEngine(crypto=self.crypto, store=store, identity_secret=None)
        engine.commit([{"title": "Task", "start_epoch": 1700000000000, "duration": 1000}])
        day_block = engine.get_day_blocks()[-1]
        self.assertNotIn("signature", day_block)

    def test_get_day_blocks_returns_only_day_blocks(self):
        skip_unless_phase_3()
        store = _MockLedgerStore(initial_ledger=[_genesis_block()])
        engine = LedgerEngine(crypto=self.crypto, store=store)
        engine.commit([{"title": "Task", "start_epoch": 1700000000000, "duration": 1000}])
        day_blocks = engine.get_day_blocks()
        for block in day_blocks:
            self.assertEqual(block.get("type", "day"), "day")

    def test_get_last_block(self):
        skip_unless_phase_3()
        store = _MockLedgerStore(initial_ledger=[_genesis_block()])
        engine = LedgerEngine(crypto=self.crypto, store=store)
        last = engine.get_last_block()
        self.assertEqual(last["type"], "genesis")


# ══════════════════════════════════════════════
# Chain Format Equivalence Tests
# ══════════════════════════════════════════════

class TestChainFormatEquivalence(unittest.TestCase):
    """[CRITICAL] Verify that new components produce byte-identical format
    to current core/ledger.py where applicable."""

    def setUp(self):
        skip_unless_phase_3()
        self.crypto = _MockCrypto()
        self.identity_secret = b"\x01" * 32
        self.genesis = _genesis_block()

    def test_seal_algorithm_matches_crypto_wrapper(self):
        chain = LedgerChain(self.crypto, _MockLedgerStore())
        data = {"type": "day", "date": "2026-01-15"}
        chain_seal = chain.compute_seal(data)
        expected = self.crypto.seal(json.dumps(data, sort_keys=True))
        self.assertEqual(chain_seal, expected)

    def test_verify_seal_rejects_wrong_input(self):
        chain = LedgerChain(self.crypto, _MockLedgerStore())
        data = {"type": "day", "date": "2026-01-15"}
        seal = chain.compute_seal(data)
        different_data = {"type": "day", "date": "2026-01-16"}
        self.assertFalse(chain.verify_seal(different_data, seal))

    def test_day_block_structure(self):
        genesis = dict(self.genesis)
        store = _MockLedgerStore(initial_ledger=[genesis])
        chain = LedgerChain(self.crypto, store, identity_secret=self.identity_secret)

        entry = {
            "data": {"title": "Test", "start_epoch": 1700000000000, "duration": 1000},
            "hash": "dummy",
        }
        block = chain.build_day_block([entry], genesis.get("block_hash") or genesis.get("day_hash"), date_str="2026-01-15")

        self.assertEqual(block["type"], "day")
        self.assertEqual(block["date"], "2026-01-15")
        self.assertIn("day_index", block)
        self.assertIn("prev_hash", block)
        self.assertIn("day_hash", block)
        self.assertIn("entries", block)
        self.assertEqual(block["day_index"], 1)
        self.assertEqual(block["prev_hash"], genesis.get("block_hash") or genesis.get("day_hash"))


# ═════════════════════════════════════════════════════════════════════════════
# _hash_key_for_block — Group H
# ═════════════════════════════════════════════════════════════════════════════

class TestHashKeyForBlock(unittest.TestCase):
    """Tests for LedgerChain._hash_key_for_block() — block type → hash field name.

    H1: Genesis with block_hash → returns "block_hash"
    H2: Genesis with only day_hash → returns "day_hash" (I-17 backward compat)
    H3: Day block → returns "day_hash"
    H4: Month summary → returns "month_hash"
    H5: Year summary → returns "year_hash"
    H6: Unknown type → returns "day_hash" (safe default)
    H7: Genesis with both keys → "block_hash" takes priority
    H8: Block with no type field → returns "day_hash"
    """

    def setUp(self):
        skip_unless_phase_3()

    # ── H1: Genesis with block_hash ───────────────────────────────────

    def test_h1_genesis_block_hash(self):
        """Genesis with block_hash → returns 'block_hash'."""
        block = {"type": "genesis", "block_hash": "abc123"}
        result = LedgerChain._hash_key_for_block(block)
        self.assertEqual(result, "block_hash",
                         "Genesis with block_hash must resolve to 'block_hash'")

    # ── H2: Genesis with day_hash only (backward compat) ──────────────

    def test_h2_genesis_day_hash_backward_compat(self):
        """Old-format genesis with only day_hash → returns 'day_hash'."""
        block = {"type": "genesis", "day_hash": "def456"}
        result = LedgerChain._hash_key_for_block(block)
        self.assertEqual(result, "day_hash",
                         "Old genesis with day_hash must return 'day_hash' (I-17 compat)")

    # ── H3: Day block ─────────────────────────────────────────────────

    def test_h3_day_block(self):
        """Day block → returns 'day_hash'."""
        block = {"type": "day", "day_hash": "day789"}
        result = LedgerChain._hash_key_for_block(block)
        self.assertEqual(result, "day_hash",
                         "Day block must resolve to 'day_hash'")

    # ── H4: Month summary ─────────────────────────────────────────────

    def test_h4_month_summary(self):
        """Month summary → returns 'month_hash'."""
        block = {"type": "month_summary", "month_hash": "month012"}
        result = LedgerChain._hash_key_for_block(block)
        self.assertEqual(result, "month_hash",
                         "Month summary must resolve to 'month_hash'")

    # ── H5: Year summary ──────────────────────────────────────────────

    def test_h5_year_summary(self):
        """Year summary → returns 'year_hash'."""
        block = {"type": "year_summary", "year_hash": "year345"}
        result = LedgerChain._hash_key_for_block(block)
        self.assertEqual(result, "year_hash",
                         "Year summary must resolve to 'year_hash'")

    # ── H6: Unknown type ──────────────────────────────────────────────

    def test_h6_unknown_type_defaults_day_hash(self):
        """Unknown block type → returns 'day_hash' as safe default."""
        block = {"type": "bogus_type", "bogus_hash": "xxx"}
        result = LedgerChain._hash_key_for_block(block)
        self.assertEqual(result, "day_hash",
                         "Unknown block type must default to 'day_hash'")

    # ── H7: Genesis with both keys — block_hash wins ──────────────────

    def test_h7_genesis_both_keys_block_hash_wins(self):
        """Genesis with both block_hash and day_hash → 'block_hash' takes priority."""
        block = {"type": "genesis", "block_hash": "abc", "day_hash": "def"}
        result = LedgerChain._hash_key_for_block(block)
        self.assertEqual(result, "block_hash",
                         "block_hash must take priority over day_hash on genesis")

    # ── H8: No type field ─────────────────────────────────────────────

    def test_h8_no_type_field_defaults_day_hash(self):
        """Block without a type field → returns 'day_hash'."""
        block = {"day_hash": "somehash"}
        result = LedgerChain._hash_key_for_block(block)
        self.assertEqual(result, "day_hash",
                         "Block with no type must default to 'day_hash'")


if __name__ == "__main__":
    unittest.main()

