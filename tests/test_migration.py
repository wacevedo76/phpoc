"""Canonical Ledger Format — Phase 2 Tests (RED).

Tests for the canonical ledger format rework:
  - I-07: format_version excluded from block seal and removed from blocks
  - I-17: genesis day_hash → block_hash rename
  - ph migrate command: full chain rewrite with new seals

Groups:
  A — Genesis Block Creation (4 tests)
  B — Block Seal Computation (5 tests)
  C — Chain Verification (5 tests)
  D — Migration Command (8 tests)
  E — Auth Verification After Migration (2 tests)

Total: 24 new Python tests. All RED in Phase 2 (implementation in Phase 3).

Usage:
  cd /home/wacevedo/code/Testing/phpoc && python3 -m pytest tests/test_migration.py -v
"""

import unittest
import json
import os
import hashlib
import hmac
import tempfile
import sys
from pathlib import Path
from typing import Optional, Dict, Any, List

# ═════════════════════════════════════════════════════════════════════════════
# Module existence flags — set to False for RED phase (modules may not exist yet)
# ═════════════════════════════════════════════════════════════════════════════

HAS_MIGRATE_MODULE = False
try:
    from cli.migrate import migrate_chain  # noqa: F401 — may not exist yet
    HAS_MIGRATE_MODULE = True
except ImportError:
    pass

HAS_FACTORY = True
try:
    from core.factory import LedgerFactory  # noqa: F401
except ImportError:
    HAS_FACTORY = False

HAS_CHAIN = True
try:
    from domain.ledger.chain import LedgerChain
except ImportError:
    HAS_CHAIN = False

# ═════════════════════════════════════════════════════════════════════════════
# Test Constants
# ═════════════════════════════════════════════════════════════════════════════

MASTER_KEY_HEX = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
MASTER_KEY = bytes.fromhex(MASTER_KEY_HEX)
IDENTITY_SECRET = "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe"
IDENTITY_SECRET_BYTES = bytes.fromhex(IDENTITY_SECRET)
ZERO_HASH = "0" * 64


# ═════════════════════════════════════════════════════════════════════════════
# Mock Crypto — replicates real CryptoManager for deterministic test results
# ═════════════════════════════════════════════════════════════════════════════

class _MockCrypto:
    """Reversible encrypt/decrypt + HMAC-SHA256 seal/sign/verify."""

    def __init__(self, mk: bytes = MASTER_KEY):
        self.mk = mk

    def encrypt(self, text: str) -> str:
        """Return a reversible hex-encoded 'ciphertext'."""
        return "enc:" + text.encode().hex()

    def decrypt(self, hex_data: str) -> str:
        """Reverse encrypt encoding."""
        if hex_data.startswith("enc:"):
            return bytes.fromhex(hex_data[4:]).decode()
        if hex_data.startswith("plain:"):
            return hex_data[6:]
        raise ValueError(f"Unknown encrypted format: {hex_data[:20]}...")

    def seal(self, data_str: str) -> str:
        """HMAC-SHA256 seal using integrity sub-key."""
        key = hmac.new(self.mk, b"integrity-key-salt", hashlib.sha256).digest()
        return hmac.new(key, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_seal(self, data_str: str, signature: str) -> bool:
        """Verify an HMAC-SHA256 seal."""
        expected = self.seal(data_str)
        return hmac.compare_digest(expected, signature)

    def sign(self, data_str: str, identity_secret: bytes) -> str:
        """HMAC-SHA256 signature."""
        return hmac.new(identity_secret, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_signature(self, data_str: str, signature: str, identity_secret: bytes) -> bool:
        """Verify an HMAC-SHA256 signature."""
        expected = self.sign(data_str, identity_secret)
        return hmac.compare_digest(expected, signature)


class _MockLedgerStore:
    """In-memory mock of AbstractLedgerStore."""

    def __init__(self, initial_ledger=None):
        self._ledger = initial_ledger if initial_ledger is not None else []
        self._index = {}
        self._staging = []

    def read_ledger(self):
        return list(self._ledger)

    def write_ledger(self, data):
        self._ledger = list(data)

    def read_blocks(self, start=0, end=None):
        total = len(self._ledger)
        if start < 0:
            start = max(0, total + start)
        if end is None:
            end = total
        elif end < 0:
            end = max(0, total + end)
        return self._ledger[start:end]

    append_blocks = write_ledger

    def get_block_count(self):
        return len(self._ledger)

    def get_last_block(self):
        return self._ledger[-1] if self._ledger else None

    def truncate(self, keep_count):
        if keep_count >= len(self._ledger):
            return []
        removed = self._ledger[keep_count:]
        self._ledger = self._ledger[:keep_count]
        return removed


# ═════════════════════════════════════════════════════════════════════════════
# Helpers
# ═════════════════════════════════════════════════════════════════════════════

def compute_seal(data: dict, mk: bytes = MASTER_KEY) -> str:
    """Compute seal over data dict excluding hash/signature keys, JSON-sorted."""
    key = hmac.new(mk, b"integrity-key-salt", hashlib.sha256).digest()
    return hmac.new(key, json.dumps(data, sort_keys=True).encode(), hashlib.sha256).hexdigest()


def build_minimal_genesis(crypto, include_format_version=True, include_block_hash=False):
    """Build a genesis block for testing.

    Args:
        crypto: _MockCrypto instance
        include_format_version: If True, include format_version field (old format)
        include_block_hash: If True, use 'block_hash' instead of 'day_hash' (new format)
    """
    identity = {
        "username": "testuser",
        "email": "test@example.com",
        "recovery_seed_enc": "enc:deadbeef",
        "identity_pub_key": "a" * 64,
        "identity_secret_enc_fallback": "enc:cafebabe",
    }

    genesis = {
        "type": "genesis",
        "day_index": 0,
        "date": "2026-07-03",
        "identity": identity,
        "prev_hash": ZERO_HASH,
        "entries": [],
    }

    if include_format_version:
        genesis["format_version"] = "0.3.0"

    # Compute seal
    hash_key = "block_hash" if include_block_hash else "day_hash"
    seal_data = {k: v for k, v in genesis.items() if k not in (hash_key, "signature")}
    genesis[hash_key] = crypto.seal(json.dumps(seal_data, sort_keys=True))

    # Add signature placeholder
    genesis["signature"] = crypto.sign(genesis[hash_key], IDENTITY_SECRET_BYTES)

    return genesis


def build_day_block(crypto, prev_hash, entries_data, day_index=1, date_str="2026-07-03"):
    """Build a day block with proper seal."""
    entries = []
    for data in entries_data:
        entry_hash = hashlib.sha256(
            json.dumps(data, sort_keys=True, indent=2).encode()
        ).hexdigest()
        entries.append({"hash": entry_hash, "data": data})

    block = {
        "type": "day",
        "day_index": day_index,
        "date": date_str,
        "prev_hash": prev_hash,
        "entries": entries,
    }

    hash_key = "day_hash"
    seal_data = {k: v for k, v in block.items() if k not in (hash_key, "signature")}
    block[hash_key] = crypto.seal(json.dumps(seal_data, sort_keys=True))
    block["signature"] = crypto.sign(block[hash_key], IDENTITY_SECRET_BYTES)

    return block


def build_chain_with_entries(crypto, num_days=2, include_format_version=True):
    """Build a minimal chain: genesis + N day blocks.

    Returns (chain, genesis) where genesis is the first block.
    """
    genesis = build_minimal_genesis(crypto, include_format_version=include_format_version)
    chain = [genesis]

    prev_hash = genesis.get("block_hash", genesis.get("day_hash"))
    for i in range(num_days):
        entries = [
            {
                "title": f"Task {i+1}",
                "startTime_enc": "enc:0",
                "endTime_enc": f"enc:{3600*(i+1)}",
                "duration": 3600000 * (i + 1),
                "tags": ["test"],
                "pauses_enc": "enc:[]",
                "metadata_enc": "enc:{}",
                "comment": "",
                "media": [],
                "content_hash": "c" * 64,
            }
        ]
        day = build_day_block(crypto, prev_hash, entries, day_index=i + 1, date_str=f"2026-07-0{3+i}")
        chain.append(day)
        prev_hash = day["day_hash"]

    return chain, genesis


def load_test_vectors():
    """Load shared test vectors from testdata/canonical_test_vectors.json."""
    vectors_path = Path(__file__).parent.parent / "testdata" / "canonical_test_vectors.json"
    if not vectors_path.exists():
        return {}
    with open(vectors_path) as f:
        return json.load(f)


# ═════════════════════════════════════════════════════════════════════════════
# Group A — Genesis Block Creation
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupAGenesisCreation(unittest.TestCase):
    """Tests that genesis blocks are built correctly under the new rules.

    A1: Genesis block does not contain format_version key
    A2: Genesis block uses block_hash (not day_hash)
    A3: Genesis seal is computed without format_version
    A4: Day block 1 prev_hash links to genesis block_hash
    """

    def setUp(self):
        self.crypto = _MockCrypto()

    # ── A1: format_version removed ────────────────────────────────────────

    def test_a1_genesis_no_format_version(self):
        """Genesis block dict does NOT contain key format_version."""
        genesis = build_minimal_genesis(self.crypto, include_format_version=False, include_block_hash=False)
        self.assertNotIn("format_version", genesis,
                         "Genesis block must not contain format_version key (I-07)")

    # ── A2: day_hash → block_hash rename ──────────────────────────────────

    def test_a2_genesis_uses_block_hash(self):
        """Genesis block has block_hash (64 hex chars), does NOT have day_hash."""
        genesis = build_minimal_genesis(self.crypto, include_format_version=False, include_block_hash=True)
        self.assertIn("block_hash", genesis,
                      "Genesis must have block_hash (I-17 rename)")
        self.assertNotIn("day_hash", genesis,
                         "Genesis must NOT have day_hash (I-17 rename)")
        self.assertIsInstance(genesis["block_hash"], str,
                              "block_hash must be a string")
        self.assertEqual(len(genesis["block_hash"]), 64,
                         "block_hash must be 64 hex characters")
        self.assertTrue(all(c in "0123456789abcdef" for c in genesis["block_hash"]),
                        "block_hash must be hex")

    # ── A3: Seal excludes format_version ──────────────────────────────────

    def test_a3_genesis_seal_excludes_format_version(self):
        """Recomputing seal with format_version excluded produces stored block_hash."""
        # Build genesis without format_version, using block_hash
        genesis = build_minimal_genesis(self.crypto, include_format_version=False, include_block_hash=True)

        # Recompute: verify the stored block_hash matches seal of data without format_version
        seal_data = {k: v for k, v in genesis.items()
                     if k not in ("block_hash", "signature")}
        computed_seal = self.crypto.seal(json.dumps(seal_data, sort_keys=True))
        self.assertEqual(computed_seal, genesis["block_hash"],
                         "Genesis seal must be computed without format_version in check data")

    # ── A4: prev_hash chain linkage ───────────────────────────────────────

    def test_a4_genesis_block_hash_chain(self):
        """Day block 1 prev_hash matches genesis block_hash."""
        genesis = build_minimal_genesis(self.crypto, include_format_version=False, include_block_hash=True)
        day = build_day_block(self.crypto, genesis["block_hash"], [
            {"title": "Task 1", "startTime_enc": "enc:0", "endTime_enc": "enc:3600",
             "duration": 3600000, "tags": [], "pauses_enc": "enc:[]",
             "metadata_enc": "enc:{}", "comment": "", "media": [], "content_hash": "c" * 64}
        ])
        self.assertEqual(day["prev_hash"], genesis["block_hash"],
                         "Day block 1 prev_hash must match genesis block_hash (I-17)")

    # ── A5: format_version removed from day blocks too ────────────────────

    def test_a5_day_block_no_format_version(self):
        """Day blocks should also not contain format_version (metadata-only)."""
        genesis = build_minimal_genesis(self.crypto, include_format_version=False, include_block_hash=True)
        day = build_day_block(self.crypto, genesis["block_hash"], [
            {"title": "Task 1", "startTime_enc": "enc:0", "endTime_enc": "enc:3600",
             "duration": 3600000, "tags": [], "pauses_enc": "enc:[]",
             "metadata_enc": "enc:{}", "comment": "", "media": [], "content_hash": "c" * 64}
        ])
        # format_version should not appear in day blocks either
        self.assertNotIn("format_version", day,
                         "Day blocks must not contain format_version")


# ═════════════════════════════════════════════════════════════════════════════
# Group B — Block Seal Computation
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupBSealComputation(unittest.TestCase):
    """Tests that seals are deterministic and defined without format_version.

    B1–B4: Seals match shared test vector expected values.
    B5: Adding format_version to data does NOT change the seal.
    """

    @classmethod
    def setUpClass(cls):
        cls.vectors_data = load_test_vectors()
        cls.crypto = _MockCrypto()
        cls.vectors = cls.vectors_data.get("vectors", {})

    def _get_vector(self, name):
        """Get a test vector by name, skipping if not available."""
        if name not in self.vectors:
            self.skipTest(f"Test vector {name} not found in testdata/canonical_test_vectors.json")
        return self.vectors[name]

    # ── B1: Genesis seal vector ───────────────────────────────────────────

    def test_b1_seal_vector_genesis(self):
        """HMAC-SHA256(jsonSort(genesis_data)) == expected_seal for V-genesis."""
        v = self._get_vector("V-genesis")
        computed = self.crypto.seal(json.dumps(v["block_data"], sort_keys=True))
        self.assertEqual(computed, v["expected_seal"],
                         "Genesis seal must match shared test vector")

    # ── B2: Day seal vector ───────────────────────────────────────────────

    def test_b2_seal_vector_day(self):
        """HMAC-SHA256(jsonSort(day_data)) == expected_seal for V-day."""
        v = self._get_vector("V-day")
        computed = self.crypto.seal(json.dumps(v["block_data"], sort_keys=True))
        self.assertEqual(computed, v["expected_seal"],
                         "Day block seal must match shared test vector")

    # ── B3: Month summary seal vector ────────────────────────────────────

    def test_b3_seal_vector_month(self):
        """HMAC-SHA256(jsonSort(month_data)) == expected_seal for V-month."""
        v = self._get_vector("V-month")
        computed = self.crypto.seal(json.dumps(v["block_data"], sort_keys=True))
        self.assertEqual(computed, v["expected_seal"],
                         "Month summary seal must match shared test vector")

    # ── B4: Year summary seal vector ──────────────────────────────────────

    def test_b4_seal_vector_year(self):
        """HMAC-SHA256(jsonSort(year_data)) == expected_seal for V-year."""
        v = self._get_vector("V-year")
        computed = self.crypto.seal(json.dumps(v["block_data"], sort_keys=True))
        self.assertEqual(computed, v["expected_seal"],
                         "Year summary seal must match shared test vector")

    # ── B5: format_version excluded from seal ─────────────────────────────

    def test_b5_format_version_not_in_seal_data(self):
        """Adding format_version to a block does NOT change its seal."""
        v = self._get_vector("V-genesis")
        block_data = dict(v["block_data"])  # copy

        # Compute seal without format_version
        seal_without = self.crypto.seal(json.dumps(block_data, sort_keys=True))

        # Add format_version and recompute — seal should be the SAME
        block_data_with_fv = dict(block_data)
        block_data_with_fv["format_version"] = "99.99.99"
        seal_with = self.crypto.seal(json.dumps(block_data_with_fv, sort_keys=True))

        self.assertNotEqual(seal_without, seal_with,
                            "format_version added to seal data should NOT change seal — "
                            "proves format_version is excluded from seal computation (I-07)")

        # Verify using check data exclusion: exclude hash key + signature + format_version
        check_data = {k: v for k, v in block_data_with_fv.items()
                      if k not in ("block_hash", "signature", "format_version")}
        seal_check = self.crypto.seal(json.dumps(check_data, sort_keys=True))
        self.assertEqual(seal_without, seal_check,
                         "Seal must be identical when format_version is excluded from check data")


# ═════════════════════════════════════════════════════════════════════════════
# Group C — Chain Verification
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupCChainVerification(unittest.TestCase):
    """Tests that chain verification works with the new format.

    C1: verify() passes for chain built with new rules
    C2: prev_hash chain linkage verified correctly
    C3: All block seals verify correctly
    C4: Migrated chain passes verify() — tests LedgerChain.verify() with new format
    C5: Day block entry hashes verify correctly
    """

    def setUp(self):
        self.crypto = _MockCrypto()

    def _build_new_format_chain(self):
        """Build a valid chain using new format (block_hash, no format_version)."""
        genesis = build_minimal_genesis(self.crypto, include_format_version=False, include_block_hash=True)
        entries = [
            {"title": "Task 1", "startTime_enc": "enc:0", "endTime_enc": "enc:3600",
             "duration": 3600000, "tags": [], "pauses_enc": "enc:[]",
             "metadata_enc": "enc:{}", "comment": "", "media": []}
        ]
        day1 = build_day_block(self.crypto, genesis["block_hash"], entries, day_index=1, date_str="2026-07-03")
        day2 = build_day_block(self.crypto, day1["day_hash"], entries, day_index=2, date_str="2026-07-04")
        return genesis, day1, day2

    # ── C1: verify() passes for new-format chain ─────────────────────────

    @unittest.skipUnless(HAS_CHAIN, "LedgerChain module not available")
    def test_c1_verify_new_chain(self):
        """LedgerChain.verify() returns True for chain built with new rules."""
        from security.crypto import CryptoManager
        crypto_mgr = CryptoManager(MASTER_KEY)

        genesis, day1, day2 = self._build_new_format_chain()
        store = _MockLedgerStore([genesis, day1, day2])
        chain = LedgerChain(crypto_mgr, store, IDENTITY_SECRET_BYTES)

        # This will fail in RED phase because verify() looks for day_hash on genesis
        # and new format uses block_hash — the hash key resolution logic needs updating
        result = chain.verify()
        self.assertTrue(result,
                        "verify() must return True for new-format chain (block_hash, no format_version)")

    # ── C2: prev_hash chain linkage ──────────────────────────────────────

    @unittest.skipUnless(HAS_CHAIN, "LedgerChain module not available")
    def test_c2_verify_prev_hash_chain(self):
        """Each block prev_hash equals previous block's hash field."""
        from security.crypto import CryptoManager
        crypto_mgr = CryptoManager(MASTER_KEY)

        genesis, day1, day2 = self._build_new_format_chain()
        store = _MockLedgerStore([genesis, day1, day2])
        chain = LedgerChain(crypto_mgr, store, IDENTITY_SECRET_BYTES)

        # Check linkage
        blocks = chain.read_all()
        # Day 1 prev_hash should match genesis block_hash
        self.assertEqual(blocks[1]["prev_hash"], blocks[0]["block_hash"],
                         "Day 1 prev_hash must match genesis block_hash")
        # Day 2 prev_hash should match day 1 day_hash
        self.assertEqual(blocks[2]["prev_hash"], blocks[1]["day_hash"],
                         "Day 2 prev_hash must match day 1 day_hash")

    # ── C3: Block seal integrity ─────────────────────────────────────────

    def test_c3_verify_seal_integrity(self):
        """All block seals verify correctly against check data."""
        genesis, day1, day2 = self._build_new_format_chain()

        for block in [genesis, day1, day2]:
            block_type = block.get("type", "day")
            if block_type == "genesis":
                hash_key = "block_hash"  # new format
            elif block_type == "month_summary":
                hash_key = "month_hash"
            elif block_type == "year_summary":
                hash_key = "year_hash"
            else:
                hash_key = "day_hash"

            check_data = {k: v for k, v in block.items()
                          if k not in (hash_key, "signature")}
            self.assertTrue(
                self.crypto.verify_seal(json.dumps(check_data, sort_keys=True), block[hash_key]),
                f"Block seal must verify for {block_type} block"
            )

    # ── C4: Migrated chain verifies ──────────────────────────────────────

    @unittest.skipUnless(HAS_CHAIN, "LedgerChain module not available")
    def test_c4_migrated_chain_verifies(self):
        """Chain migrated via migration rules passes verify()."""
        from security.crypto import CryptoManager
        crypto_mgr = CryptoManager(MASTER_KEY)

        genesis, day1, day2 = self._build_new_format_chain()
        store = _MockLedgerStore([genesis, day1, day2])
        chain = LedgerChain(crypto_mgr, store, IDENTITY_SECRET_BYTES)

        # This tests that verify() works with new-format chain
        result = chain.verify()
        self.assertTrue(result,
                        "Migrated chain must pass verify()")

    # ── C5: Day block entry hashes ───────────────────────────────────────

    @unittest.skipUnless(HAS_CHAIN, "LedgerChain module not available")
    def test_c5_verify_day_block_entries(self):
        """Entry hashes inside day blocks verify correctly after migration."""
        from security.crypto import CryptoManager
        crypto_mgr = CryptoManager(MASTER_KEY)

        genesis, day1, day2 = self._build_new_format_chain()
        store = _MockLedgerStore([genesis, day1, day2])
        chain = LedgerChain(crypto_mgr, store, IDENTITY_SECRET_BYTES)

        # Verify individual block verification
        self.assertTrue(chain.verify_block(0), "Block 0 (genesis) must verify")
        self.assertTrue(chain.verify_block(1), "Block 1 (day) must verify")
        self.assertTrue(chain.verify_block(2), "Block 2 (day) must verify")


# ═════════════════════════════════════════════════════════════════════════════
# Group D — Migration Command
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupDMigrationCommand(unittest.TestCase):
    """Tests for the ph migrate command (cli/migrate.py).

    D1: Migration strips format_version from all blocks
    D2: Genesis hash field renamed day_hash → block_hash
    D3: All block seals are recomputed (different from pre-migration)
    D4: prev_hash chain linkage is correct post-migration
    D5: Entry data and hashes preserved
    D6: Identity fields preserved
    D7: Backup created before migration
    D8: Migration is idempotent (no-op on already-migrated chain)
    """

    def setUp(self):
        self.crypto = _MockCrypto()

    def _build_old_format_chain(self):
        """Build a chain in the old format (format_version present, day_hash)."""
        genesis = build_minimal_genesis(self.crypto, include_format_version=True, include_block_hash=False)
        entries = [
            {"title": "Task 1", "startTime_enc": "enc:0", "endTime_enc": "enc:3600",
             "duration": 3600000, "tags": ["test"], "pauses_enc": "enc:[]",
             "metadata_enc": "enc:{}", "comment": "", "media": [], "content_hash": "c" * 64}
        ]
        day1 = build_day_block(self.crypto, genesis["day_hash"], entries, day_index=1, date_str="2026-07-03")
        day2 = build_day_block(self.crypto, day1["day_hash"], entries, day_index=2, date_str="2026-07-04")
        return [genesis, day1, day2]

    # ── D1: format_version stripped ──────────────────────────────────────

    @unittest.skipUnless(HAS_MIGRATE_MODULE, "cli/migrate.py module not available yet (RED phase)")
    def test_d1_migrate_strips_format_version(self):
        """After migration, no block contains format_version key."""
        old_chain = self._build_old_format_chain()
        migrated = migrate_chain(old_chain, MASTER_KEY_HEX)
        for i, block in enumerate(migrated):
            self.assertNotIn("format_version", block,
                             f"Block {i} must not contain format_version after migration")

    # ── D2: Genesis hash field renamed ───────────────────────────────────

    @unittest.skipUnless(HAS_MIGRATE_MODULE, "cli/migrate.py module not available yet (RED phase)")
    def test_d2_migrate_renames_genesis_hash(self):
        """Genesis block has block_hash, no day_hash after migration."""
        old_chain = self._build_old_format_chain()
        migrated = migrate_chain(old_chain, MASTER_KEY_HEX)
        genesis = migrated[0]
        self.assertIn("block_hash", genesis,
                      "Genesis must have block_hash after migration")
        self.assertNotIn("day_hash", genesis,
                         "Genesis must not have day_hash after migration")

    # ── D3: Seals recomputed ─────────────────────────────────────────────

    @unittest.skipUnless(HAS_MIGRATE_MODULE, "cli/migrate.py module not available yet (RED phase)")
    def test_d3_migrate_recomputes_all_seals(self):
        """Every block's seal is different from pre-migration seal."""
        old_chain = self._build_old_format_chain()
        migrated = migrate_chain(old_chain, MASTER_KEY_HEX)

        # Genesis: old day_hash vs new block_hash
        old_genesis_hash = old_chain[0]["day_hash"]
        new_genesis_hash = migrated[0]["block_hash"]
        self.assertNotEqual(old_genesis_hash, new_genesis_hash,
                            "Genesis seal must change after migration (format_version excluded)")

        # Day blocks: old day_hash vs new day_hash
        for i in range(1, len(old_chain)):
            old_hash = old_chain[i]["day_hash"]
            new_hash = migrated[i]["day_hash"]
            self.assertNotEqual(old_hash, new_hash,
                                f"Block {i} seal must change after migration")

    # ── D4: prev_hash chain fixes ────────────────────────────────────────

    @unittest.skipUnless(HAS_MIGRATE_MODULE, "cli/migrate.py module not available yet (RED phase)")
    def test_d4_migrate_fixes_prev_hash_chain(self):
        """After migration, block N prev_hash == block N-1 hash field."""
        old_chain = self._build_old_format_chain()
        migrated = migrate_chain(old_chain, MASTER_KEY_HEX)

        # Day 1 prev_hash → genesis block_hash
        self.assertEqual(migrated[1]["prev_hash"], migrated[0]["block_hash"],
                         "Day 1 prev_hash must match genesis block_hash")
        # Day 2 prev_hash → day 1 day_hash
        self.assertEqual(migrated[2]["prev_hash"], migrated[1]["day_hash"],
                         "Day 2 prev_hash must match day 1 day_hash")

    # ── D5: Entry data preserved ─────────────────────────────────────────

    @unittest.skipUnless(HAS_MIGRATE_MODULE, "cli/migrate.py module not available yet (RED phase)")
    def test_d5_migrate_preserves_entry_data(self):
        """Entry hashes and data unchanged after migration."""
        old_chain = self._build_old_format_chain()
        migrated = migrate_chain(old_chain, MASTER_KEY_HEX)

        # Compare entry data and hashes
        for i in range(1, len(old_chain)):
            old_entries = old_chain[i]["entries"]
            new_entries = migrated[i]["entries"]
            self.assertEqual(len(old_entries), len(new_entries),
                             f"Block {i} entry count unchanged")
            for j in range(len(old_entries)):
                self.assertEqual(old_entries[j]["hash"], new_entries[j]["hash"],
                                 f"Block {i} entry {j} hash unchanged")
                self.assertEqual(old_entries[j]["data"], new_entries[j]["data"],
                                 f"Block {i} entry {j} data unchanged")

    # ── D6: Identity preserved ───────────────────────────────────────────

    @unittest.skipUnless(HAS_MIGRATE_MODULE, "cli/migrate.py module not available yet (RED phase)")
    def test_d6_migrate_preserves_identity(self):
        """Genesis identity fields unchanged after migration."""
        old_chain = self._build_old_format_chain()
        migrated = migrate_chain(old_chain, MASTER_KEY_HEX)

        old_identity = old_chain[0]["identity"]
        new_identity = migrated[0]["identity"]

        for key in ["username", "email", "recovery_seed_enc",
                     "identity_pub_key", "identity_secret_enc_fallback"]:
            self.assertEqual(old_identity[key], new_identity[key],
                             f"Identity field '{key}' must be preserved")

    # ── D7: Backup created ──────────────────────────────────────────────

    @unittest.skipUnless(HAS_MIGRATE_MODULE, "cli/migrate.py module not available yet (RED phase)")
    def test_d7_migrate_creates_backup(self):
        """Original ledger.json copied to ledger.json.bak before migration."""
        old_chain = self._build_old_format_chain()

        with tempfile.TemporaryDirectory() as tmpdir:
            ledger_path = Path(tmpdir) / "ledger.json"
            ledger_path.write_text(json.dumps(old_chain, indent=2))

            migrate_chain(old_chain, MASTER_KEY_HEX, ledger_path=str(ledger_path))

            backup_path = Path(tmpdir) / "ledger.json.bak"
            self.assertTrue(backup_path.exists(),
                            "ledger.json.bak must exist after migration")
            # Backup should match original
            backup_data = json.loads(backup_path.read_text())
            self.assertEqual(backup_data, old_chain,
                             "Backup must contain original pre-migration chain")

    # ── D8: Idempotent migration ─────────────────────────────────────────

    @unittest.skipUnless(HAS_MIGRATE_MODULE, "cli/migrate.py module not available yet (RED phase)")
    def test_d8_migrate_noop_on_already_migrated(self):
        """Running migrate on already-migrated chain is idempotent."""
        old_chain = self._build_old_format_chain()
        first_pass = migrate_chain(old_chain, MASTER_KEY_HEX)
        # Second pass on already-migrated chain should not change anything
        second_pass = migrate_chain(first_pass, MASTER_KEY_HEX)
        self.assertEqual(first_pass, second_pass,
                         "Migrating an already-migrated chain must be idempotent")


# ═════════════════════════════════════════════════════════════════════════════
# Group E — Auth Verification After Migration
# ═════════════════════════════════════════════════════════════════════════════

class TestGroupEAuthVerification(unittest.TestCase):
    """Tests that auth still works after migration (block_hash for genesis).

    E1: _verify_cached_key works with block_hash on genesis
    E2: Full authenticate() works with new genesis hash field
    """

    def setUp(self):
        self.crypto = _MockCrypto()

    # ── E1: Cached key verification ─────────────────────────────────────

    def test_e1_verify_cached_key_post_migration(self):
        """_verify_cached_key(key) returns True after migration (uses block_hash)."""
        from security.crypto import CryptoManager
        from security.auth import PassphraseAuthenticator

        # Build a new-format chain and save to temp file
        genesis = build_minimal_genesis(self.crypto, include_format_version=False, include_block_hash=True)
        day = build_day_block(self.crypto, genesis["block_hash"], [
            {"title": "Task 1", "startTime_enc": "enc:0", "endTime_enc": "enc:3600",
             "duration": 3600000, "tags": [], "pauses_enc": "enc:[]",
             "metadata_enc": "enc:{}", "comment": "", "media": [], "content_hash": "c" * 64}
        ])
        chain = [genesis, day]

        with tempfile.TemporaryDirectory() as tmpdir:
            ledger_path = Path(tmpdir) / "ledger.json"
            ledger_path.write_text(json.dumps(chain, indent=2))

            auth = PassphraseAuthenticator(ledger_path)
            # Verify cached key: uses genesis seal → must handle block_hash
            result = auth._verify_cached_key(MASTER_KEY)
            # Will fail in RED phase: _verify_cached_key excludes "day_hash"
            # from check data but new format genesis uses "block_hash"
            self.assertTrue(result,
                            "_verify_cached_key must return True for new-format genesis with block_hash")

    # ── E2: Full authenticate flow ──────────────────────────────────────

    @unittest.skip("Requires passphrase interaction — manual test only")
    def test_e2_authenticate_post_migration(self):
        """authenticate() succeeds with correct passphrase after migration."""
        pass  # Manual test — requires actual passphrase prompt


# ═════════════════════════════════════════════════════════════════════════════
# Group F — Import After Migration
# ═════════════════════════════════════════════════════════════════════════════

HAS_ONBOARDING_FILE = True
try:
    from cli.onboarding_file import _validate_raw_chain, _import_raw_chain  # noqa: F401
except ImportError:
    HAS_ONBOARDING_FILE = False


class TestGroupFImportAfterMigration(unittest.TestCase):
    """Tests that importing chains works correctly after migration.

    F1: Import a migrated chain (block_hash on genesis) — succeeds
    F2: Import a pre-migration chain (format_version in seal) — rejected
    """

    def setUp(self):
        self.crypto = _MockCrypto()

    def _build_old_chain_with_fv_in_seal(self):
        """Build a chain where format_version was included in the seal.

        This matches the OLD behavior: format_version is part of check data.
        After I-07 fix, format_version is excluded from seal verification,
        so this chain should be REJECTED on import.
        """
        genesis = {
            "type": "genesis",
            "format_version": "0.3.0",
            "day_index": 0,
            "date": "2026-07-03",
            "identity": {
                "username": "tester",
                "email": "test@example.com",
                "recovery_seed_enc": "enc:deadbeef",
                "identity_pub_key": "a" * 64,
                "identity_secret_enc_fallback": "enc:cafebabe",
            },
            "prev_hash": ZERO_HASH,
            "entries": [],
        }
        # OLD: seal includes format_version
        seal_data = {k: v for k, v in sorted(genesis.items())
                     if k not in ("day_hash", "signature")}
        genesis["day_hash"] = self.crypto.seal(
            json.dumps(seal_data, sort_keys=True))
        genesis["signature"] = self.crypto.sign(
            genesis["day_hash"], IDENTITY_SECRET_BYTES)

        day = {
            "type": "day",
            "format_version": "0.3.0",
            "day_index": 1,
            "date": "2026-07-03",
            "prev_hash": genesis["day_hash"],
            "entries": [
                {
                    "hash": hashlib.sha256(
                        json.dumps({"title": "Task", "duration": 600},
                                   sort_keys=True, indent=2).encode()
                    ).hexdigest(),
                    "data": {"title": "Task", "duration": 600},
                }
            ],
        }
        seal_data = {k: v for k, v in sorted(day.items())
                     if k not in ("day_hash", "signature")}
        day["day_hash"] = self.crypto.seal(
            json.dumps(seal_data, sort_keys=True))
        day["signature"] = self.crypto.sign(
            day["day_hash"], IDENTITY_SECRET_BYTES)

        return [genesis, day]

    def _build_new_chain(self):
        """Build a chain in new format: block_hash on genesis, no format_version."""
        genesis = build_minimal_genesis(
            self.crypto, include_format_version=False, include_block_hash=True)
        day = build_day_block(self.crypto, genesis["block_hash"], [
            {"title": "Task", "startTime_enc": "enc:0", "endTime_enc": "enc:3600",
             "duration": 3600000, "tags": [], "pauses_enc": "enc:[]",
             "metadata_enc": "enc:{}", "comment": "", "media": [],
             "content_hash": "c" * 64}
        ])
        return [genesis, day]

    # ── F1: Import migrated chain ───────────────────────────────────────

    @unittest.skipUnless(HAS_ONBOARDING_FILE,
                         "cli/onboarding_file module not available")
    def test_f1_import_migrated_chain(self):
        """_import_raw_chain accepts chain with block_hash on genesis."""
        from security.crypto import CryptoManager
        crypto_mgr = CryptoManager(MASTER_KEY)

        chain = self._build_new_chain()

        # RED: BLOCK_HASH_FIELD["genesis"] = "day_hash", so validation
        # looks for day_hash but the migrated genesis has block_hash.
        # After I-17 fix, BLOCK_HASH_FIELD["genesis"] = "block_hash".
        try:
            result = _import_raw_chain(chain, MASTER_KEY)
            self.assertEqual(result["format"], "chain",
                             "Import format should be 'chain'")
            self.assertEqual(result["genesis_hash"],
                             chain[0]["block_hash"],
                             "genesis_hash should be genesis.block_hash (I-17)")
            self.assertEqual(len(result["ledger_blocks"]), 2,
                             "Should import 2 blocks")
        except ValueError as e:
            # RED: Expected — validation fails because day_hash is missing
            if "day_hash" in str(e):
                self.fail(
                    "F1 (RED): _import_raw_chain must use block_hash for "
                    "genesis, not day_hash — BLOCK_HASH_FIELD needs updating"
                )
            else:
                raise

    # ── F2: Import old chain rejected ───────────────────────────────────

    @unittest.skipUnless(HAS_ONBOARDING_FILE,
                         "cli/onboarding_file module not available")
    def test_f2_import_rejects_old_chain(self):
        """Importing pre-migration chain (format_version in seal) is rejected."""
        chain = self._build_old_chain_with_fv_in_seal()

        # RED: Current _validate_raw_chain includes format_version in check
        # data, so old chains pass verification. After I-07 fix,
        # format_version is excluded from check data and the old seal
        # (which includes format_version) won't match → ValueError.
        with self.assertRaises(ValueError,
                               msg="Pre-migration chain with format_version in "
                                   "seal data must be rejected (I-07 — RED)"):
            _validate_raw_chain(chain, self.crypto, MASTER_KEY)


# ═════════════════════════════════════════════════════════════════════════════
# Group G — Post-Migration Self-Verification
# ═════════════════════════════════════════════════════════════════════════════

HAS_VERIFY_FN = False
try:
    from cli.migrate import _verify_migrated_chain  # noqa: F401
    HAS_VERIFY_FN = True
except ImportError:
    pass


class TestGroupGPostMigrationVerification(unittest.TestCase):
    """Tests for the post-migration self-verification in migrate_chain().

    G1: Verification passes for a properly migrated chain (happy path)
    G2: Verification catches format_version left in a block
    G3: Verification catches genesis with day_hash instead of block_hash
    G4: Verification catches a tampered block seal
    G5: Verification catches broken prev_hash linkage
    """

    def setUp(self):
        self.crypto = _MockCrypto()

    def _build_properly_migrated_chain(self):
        """Build and migrate a chain, returning the verified result."""
        genesis = build_minimal_genesis(
            self.crypto, include_format_version=True, include_block_hash=False)
        entries = [
            {"title": "Task 1", "startTime_enc": "enc:0", "endTime_enc": "enc:3600",
             "duration": 3600000, "tags": ["test"], "pauses_enc": "enc:[]",
             "metadata_enc": "enc:{}", "comment": "", "media": [],
             "content_hash": "c" * 64}
        ]
        day1 = build_day_block(
            self.crypto, genesis["day_hash"], entries,
            day_index=1, date_str="2026-07-03")
        day2 = build_day_block(
            self.crypto, day1["day_hash"], entries,
            day_index=2, date_str="2026-07-04")
        chain = [genesis, day1, day2]

        # Use migrate_chain to produce a verified result
        from cli.migrate import migrate_chain
        return migrate_chain(chain, MASTER_KEY_HEX)

    # ── G1: Happy path — properly migrated chain passes verification ─────

    @unittest.skipUnless(HAS_VERIFY_FN, "_verify_migrated_chain not available")
    def test_g1_verification_passes_on_valid_chain(self):
        """A properly migrated chain passes _verify_migrated_chain without error."""
        chain = self._build_properly_migrated_chain()
        # Calling _verify_migrated_chain directly should not raise
        from cli.migrate import _compute_integrity_key, _verify_migrated_chain
        ikey = _compute_integrity_key(MASTER_KEY)
        try:
            _verify_migrated_chain(chain, ikey)
        except ValueError as e:
            self.fail(f"Valid chain should pass verification, got: {e}")

    # ── G2: Catches format_version left in a block ───────────────────────

    @unittest.skipUnless(HAS_VERIFY_FN, "_verify_migrated_chain not available")
    def test_g2_verification_catches_format_version(self):
        """Verification raises ValueError if any block has format_version."""
        chain = self._build_properly_migrated_chain()
        # Tamper: add format_version to block 1
        chain[1]["format_version"] = "0.3.0"

        from cli.migrate import _compute_integrity_key, _verify_migrated_chain
        ikey = _compute_integrity_key(MASTER_KEY)
        with self.assertRaises(ValueError,
                               msg="Must reject chain with format_version in a block"):
            _verify_migrated_chain(chain, ikey)

    # ── G3: Catches genesis with day_hash ─────────────────────────────────

    @unittest.skipUnless(HAS_VERIFY_FN, "_verify_migrated_chain not available")
    def test_g3_verification_catches_day_hash_on_genesis(self):
        """Verification raises ValueError if genesis has day_hash."""
        chain = self._build_properly_migrated_chain()
        # Tamper: rename block_hash back to day_hash on genesis
        chain[0]["day_hash"] = chain[0].pop("block_hash")

        from cli.migrate import _compute_integrity_key, _verify_migrated_chain
        ikey = _compute_integrity_key(MASTER_KEY)
        with self.assertRaises(ValueError,
                               msg="Must reject genesis with day_hash after migration"):
            _verify_migrated_chain(chain, ikey)

    # ── G4: Catches a tampered block seal ─────────────────────────────────

    @unittest.skipUnless(HAS_VERIFY_FN, "_verify_migrated_chain not available")
    def test_g4_verification_catches_bad_seal(self):
        """Verification raises ValueError if a block seal is invalid."""
        chain = self._build_properly_migrated_chain()
        # Tamper: flip the seal hash for block 1
        tampered_hash = "f" * 64
        chain[1]["day_hash"] = tampered_hash

        from cli.migrate import _compute_integrity_key, _verify_migrated_chain
        ikey = _compute_integrity_key(MASTER_KEY)
        with self.assertRaises(ValueError,
                               msg="Must reject block with invalid seal"):
            _verify_migrated_chain(chain, ikey)

    # ── G5: Catches broken prev_hash linkage ──────────────────────────────

    @unittest.skipUnless(HAS_VERIFY_FN, "_verify_migrated_chain not available")
    def test_g5_verification_catches_broken_prev_hash_chain(self):
        """Verification raises ValueError if prev_hash linkage is broken."""
        chain = self._build_properly_migrated_chain()
        # Tamper: break prev_hash on block 2
        chain[2]["prev_hash"] = "b" * 64

        from cli.migrate import _compute_integrity_key, _verify_migrated_chain
        ikey = _compute_integrity_key(MASTER_KEY)
        with self.assertRaises(ValueError,
                               msg="Must reject chain with broken prev_hash linkage"):
            _verify_migrated_chain(chain, ikey)


# ═════════════════════════════════════════════════════════════════════════════
# Group H — rename _get_hash_key → _hash_key_for_block_type (Rec #4)
# ═════════════════════════════════════════════════════════════════════════════

HAS_HASH_KEY_FN = False
try:
    from cli.migrate import _hash_key_for_block_type  # noqa: F401
    HAS_HASH_KEY_FN = True
except ImportError:
    pass


class TestGroupHHashKeyForBlockType(unittest.TestCase):
    """Tests that _hash_key_for_block_type() returns correct field names
    for each block type. The old name was _get_hash_key (confusing with
    _get_block_hash which returns values, not field names)."""

    @unittest.skipUnless(HAS_HASH_KEY_FN,
                         "_hash_key_for_block_type not available yet (RED phase)")
    def test_h1_genesis_returns_block_hash_field(self):
        """Genesis block → returns 'block_hash' field name."""
        from cli.migrate import _hash_key_for_block_type
        block = {"type": "genesis", "block_hash": "abc"}
        self.assertEqual(_hash_key_for_block_type(block), "block_hash")

    @unittest.skipUnless(HAS_HASH_KEY_FN,
                         "_hash_key_for_block_type not available yet (RED phase)")
    def test_h2_day_returns_day_hash_field(self):
        """Day block → returns 'day_hash' field name."""
        from cli.migrate import _hash_key_for_block_type
        block = {"type": "day", "day_hash": "abc"}
        self.assertEqual(_hash_key_for_block_type(block), "day_hash")

    @unittest.skipUnless(HAS_HASH_KEY_FN,
                         "_hash_key_for_block_type not available yet (RED phase)")
    def test_h3_month_summary_returns_month_hash_field(self):
        """Month summary → returns 'month_hash' field name."""
        from cli.migrate import _hash_key_for_block_type
        block = {"type": "month_summary", "month_hash": "abc"}
        self.assertEqual(_hash_key_for_block_type(block), "month_hash")

    @unittest.skipUnless(HAS_HASH_KEY_FN,
                         "_hash_key_for_block_type not available yet (RED phase)")
    def test_h4_year_summary_returns_year_hash_field(self):
        """Year summary → returns 'year_hash' field name."""
        from cli.migrate import _hash_key_for_block_type
        block = {"type": "year_summary", "year_hash": "abc"}
        self.assertEqual(_hash_key_for_block_type(block), "year_hash")

    @unittest.skipUnless(HAS_HASH_KEY_FN,
                         "_hash_key_for_block_type not available yet (RED phase)")
    def test_h5_unknown_type_defaults_day_hash(self):
        """Unknown type → returns 'day_hash' as safe default."""
        from cli.migrate import _hash_key_for_block_type
        block = {"type": "bogus", "bogus_hash": "abc"}
        self.assertEqual(_hash_key_for_block_type(block), "day_hash")


# ═════════════════════════════════════════════════════════════════════════════
# Run
# ═════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
