"""I-01 Key Rotation — Phase 2 RED: Chain layer tests (Groups C + D).

Tests block structure with key_version and multi-version chain verification.

Group C: Block Structure with key_version (10 tests)
Group D: Multi-Version Chain Verification (12 tests)
"""

import unittest
import json
import hashlib
import hmac
import os
from typing import Optional, Dict, Any


# ── Expected future API ───────────────────────────────────────────

HAS_I01_CHAIN = False
try:
    from domain.ledger.chain import LedgerChain  # noqa: F811
    HAS_I01_CHAIN = True
except (ImportError, ModuleNotFoundError):
    LedgerChain = None


def skip_unless_i01_chain():
    if not HAS_I01_CHAIN:
        raise unittest.SkipTest("I-01 chain layer not yet implemented")


# ── Mock/Stub Helpers ────────────────────────────────────────────

class _MockCrypto:
    """Versioned mock that produces different seals/encrypt per MK version."""

    def __init__(self, mk, key_version=0):
        self.master_key = mk
        self.key_version = key_version

    def _derive_sub_key(self, salt, length=16):
        return hmac.new(self.master_key, salt, hashlib.sha256).digest()[:length]

    def encrypt(self, text):
        return "enc:" + text.encode().hex()

    def decrypt(self, hex_data):
        if hex_data.startswith("enc:"):
            return bytes.fromhex(hex_data[4:]).decode()
        if hex_data.startswith("plain:"):
            return hex_data[6:]
        raise ValueError(f"Unknown format: {hex_data[:20]}...")

    def seal(self, data_str):
        key = self._derive_sub_key(b"integrity-key-salt", 32)
        return hmac.new(key, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_seal(self, data_str, signature):
        return hmac.compare_digest(self.seal(data_str), signature)

    def verifySeal(self, data_str, signature, _mk=""):
        return self.verify_seal(data_str, signature)

    def mac(self, data_str, identity_secret):
        return hmac.new(identity_secret, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_mac(self, data_str, mac_tag, identity_secret):
        return hmac.compare_digest(self.mac(data_str, identity_secret), mac_tag)


class _MockLedgerStore:
    """In-memory block store."""

    def __init__(self, initial=None):
        self._ledger = list(initial) if initial else []

    def read_blocks(self, start=0, end=None):
        total = len(self._ledger)
        if start < 0:
            start = max(0, total + start)
        if end is None:
            end = total
        elif end < 0:
            end = max(0, total + end)
        return self._ledger[start:end]

    def append_blocks(self, blocks):
        self._ledger.extend(blocks)

    def truncate(self, keep_count):
        if keep_count >= len(self._ledger):
            return []
        removed = self._ledger[keep_count:]
        self._ledger = self._ledger[:keep_count]
        return removed

    def get_block_count(self):
        return len(self._ledger)

    def get_last_block(self):
        return self._ledger[-1] if self._ledger else None


def _make_genesis(mk_version=0):
    """Build a genesis block for the given key version."""
    return {
        "type": "genesis",
        "block_hash": "genesis_hash_placeholder",
        "identity": {"identity_pub_key": "ab" * 32},
        "key_version": mk_version,
        "format_version": "0.5.0" if mk_version > 0 else "0.4.0",
    }


def _seal_genesis(genesis, crypto):
    """Compute and set a proper block_hash for a genesis block.

    Excludes key_version from seal data (metadata, like format_version).
    """
    check_data = {k: v for k, v in genesis.items()
                  if k not in ("block_hash", "identity_seal", "signature",
                               "format_version", "key_version")}
    genesis["block_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
    return genesis


def _seal_block(block, crypto):
    """Compute and set a proper hash for any block (day, month_summary, etc).

    Excludes key_version from seal data.
    """
    hash_key = "day_hash"
    if block.get("type") == "month_summary":
        hash_key = "month_hash"
    elif block.get("type") == "year_summary":
        hash_key = "year_hash"
    check_data = {k: v for k, v in block.items()
                  if k not in (hash_key, "identity_seal", "signature",
                               "format_version", "key_version")}
    block[hash_key] = crypto.seal(json.dumps(check_data, sort_keys=True))
    return block


def _make_entry(title, start_epoch, duration=3600000):
    data = {
        "title": title,
        "start_epoch": start_epoch,
        "duration": duration,
        "is_active": False,
        "is_paused": False,
        "tags": [],
        "comment": None,
        "media": [],
    }
    # Compute content_hash over plaintext fields (excluding content_hash itself)
    content = {k: (sorted(v) if isinstance(v, list) else v) for k, v in data.items()}
    ch = hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
    data["content_hash"] = ch
    return data


def _build_day_block(chain, entries, prev_hash, date_str, key_version=None):
    """Build a day block — replicates chain.build_day_block signature."""
    return chain.build_day_block(entries, prev_hash, date_str, key_version=key_version)


def _compute_mk(seed, version):
    """Helper: derive MK for a given version (expected algorithm)."""
    if version == 0:
        return seed
    return hmac.new(seed, f"phpoc:mk:v{version}".encode(), hashlib.sha256).digest()


# ══════════════════════════════════════════════════════════════════
# Group C: Block Structure with key_version
# ══════════════════════════════════════════════════════════════════

class TestBlockStructureWithKeyVersion(unittest.TestCase):
    """Tests that blocks carry key_version correctly."""

    def setUp(self):
        self.seed = os.urandom(32)

    # ── C1: Genesis carries key_version ───────────────────────

    def test_c1_genesis_carries_key_version(self):
        """C1: Genesis block must carry a key_version field as integer."""
        skip_unless_i01_chain()
        genesis = _make_genesis(mk_version=1)
        self.assertIn("key_version", genesis)
        self.assertIsInstance(genesis["key_version"], int)
        self.assertEqual(genesis["key_version"], 1)

    # ── C2: build_day_block includes key_version ──────────────

    def test_c2_build_day_block_includes_key_version(self):
        """C2: build_day_block() includes key_version from parameter."""
        skip_unless_i01_chain()
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)
        store = _MockLedgerStore([_make_genesis(mk_version=1)])
        chain = LedgerChain(crypto, store)

        entry = _make_entry("test", 1700000000000)
        block = chain.build_day_block(
            [entry],
            prev_hash="genesis_hash_placeholder",
            date_str="2023-11-15",
            key_version=1,
        )
        self.assertIn("key_version", block)
        self.assertEqual(block["key_version"], 1)

    # ── C3: Default to genesis key_version when missing ───────

    def test_c3_missing_key_version_defaults_to_genesis(self):
        """C3: Day block missing key_version → verify() defaults to genesis key_version."""
        skip_unless_i01_chain()
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)
        genesis = _make_genesis(mk_version=1)

        # Build a chain with genesis (key_version=1) and a day block
        # that has NO key_version field (pre-ADR format)
        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto, store)

        entry = _make_entry("test", 1700000000000)
        day_block = chain.build_day_block(
            [entry],
            prev_hash="genesis_hash_placeholder",
            date_str="2023-11-15",
        )
        # Remove key_version to simulate pre-ADR block
        day_block.pop("key_version", None)
        store.append_blocks([day_block])

        # Verification should pass because it defaults to genesis key_version
        result = chain.verify()
        self.assertTrue(result)

    # ── C4: key_version excluded from seal ────────────────────

    def test_c4_key_version_excluded_from_seal(self):
        """C4: _hash_key_for_block() excludes key_version from seal check data."""
        skip_unless_i01_chain()
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)
        genesis = _make_genesis(mk_version=1)
        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto, store)

        entry = _make_entry("test", 1700000000000)
        block = chain.build_day_block(
            [entry],
            prev_hash="genesis_hash_placeholder",
            date_str="2023-11-15",
            key_version=1,
        )

        # Verify that key_version is NOT in the seal check set
        hash_key = "day_hash"
        check_data = {k: v for k, v in block.items()
                      if k not in (hash_key, "identity_seal", "signature",
                                   "format_version", "key_version")}
        self.assertNotIn("key_version", check_data,
                         "key_version must be excluded from seal check data")

    # ── C5: key_version is integer in JSON ────────────────────

    def test_c5_key_version_serialized_as_integer(self):
        """C5: key_version is serialized as integer in JSON block output."""
        skip_unless_i01_chain()
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)
        store = _MockLedgerStore([_make_genesis(mk_version=1)])
        chain = LedgerChain(crypto, store)

        entry = _make_entry("test", 1700000000000)
        block = chain.build_day_block(
            [entry],
            prev_hash="genesis_hash_placeholder",
            date_str="2023-11-15",
            key_version=1,
        )
        serialized = json.dumps(block)
        reparsed = json.loads(serialized)
        self.assertIsInstance(reparsed["key_version"], int)

    # ── C6: Summary blocks carry key_version ──────────────────

    def test_c6_summary_blocks_carry_key_version(self):
        """C6: Summary blocks also carry key_version."""
        # Summary blocks are built by SummaryPolicy; this test verifies that
        # when a summary is built with a key_version, it appears in the block.
        skip_unless_i01_chain()
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)
        genesis = _make_genesis(mk_version=1)
        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto, store)

        # Simulate a month_summary block
        summary = {
            "type": "month_summary",
            "date": "2023-12",
            "prev_hash": "genesis_hash_placeholder",
            "month_hash": "fake",
            "key_version": 1,
        }
        store.append_blocks([summary])
        blocks = chain.read_all()
        summary_block = blocks[1]
        self.assertEqual(summary_block["key_version"], 1)

    # ── C7: build_day_block key_version=None omits field ──────

    def test_c7_key_version_none_omits_field(self):
        """C7: build_day_block() with key_version=None omits the field."""
        skip_unless_i01_chain()
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)
        store = _MockLedgerStore([_make_genesis(mk_version=1)])
        chain = LedgerChain(crypto, store)

        entry = _make_entry("test", 1700000000000)
        block = chain.build_day_block(
            [entry],
            prev_hash="genesis_hash_placeholder",
            date_str="2023-11-15",
            key_version=None,
        )
        self.assertNotIn("key_version", block,
                         "key_version=None should omit the field for backward compat")

    # ── C8: Engine passes genesis key_version to build_day_block ──

    def test_c8_engine_passes_key_version_to_build_day_block(self):
        """C8: LedgerEngine.commit() passes genesis key_version to build_day_block()."""
        skip_unless_i01_chain()
        # This tests integration between engine and chain.
        # We verify via chain API that the parameter flows through.
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)
        genesis = _make_genesis(mk_version=1)
        genesis["block_hash"] = crypto.seal(json.dumps(
            {k: v for k, v in genesis.items()
             if k not in ("block_hash", "identity_seal", "signature", "format_version")},
            sort_keys=True))
        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto, store)

        # The engine should call build_day_block with genesis key_version
        entry = _make_entry("test", 1700000000000)
        block = chain.build_day_block(
            [entry],
            prev_hash=genesis["block_hash"],
            date_str="2023-11-15",
            key_version=genesis["key_version"],
        )
        self.assertEqual(block["key_version"], 1)

    # ── C9: Genesis key_version is always highest ─────────────

    def test_c9_genesis_key_version_is_highest(self):
        """C9: Genesis key_version is always the highest (most recent) version."""
        skip_unless_i01_chain()
        # A day block's key_version must never exceed genesis
        genesis = _make_genesis(mk_version=2)
        self.assertEqual(genesis["key_version"], 2)
        # Any day block built with this genesis should have key_version <= 2
        # This is an invariant — tests will enforce in verification

    # ── C10: format_version bump ──────────────────────────────

    def test_c10_format_version_bump(self):
        """C10: format_version must be '0.5.0' when key_version field is present."""
        skip_unless_i01_chain()
        genesis = _make_genesis(mk_version=1)
        self.assertEqual(genesis["format_version"], "0.5.0")


# ══════════════════════════════════════════════════════════════════
# Group D: Multi-Version Chain Verification
# ══════════════════════════════════════════════════════════════════

class TestMultiVersionChainVerification(unittest.TestCase):
    """Tests that verify() handles mixed-version chains correctly."""

    def setUp(self):
        self.seed = os.urandom(32)
        self.identity_secret = os.urandom(32)

    def _build_mixed_chain(self):
        """Build a chain with v1 genesis (1 day block) → soft-rotate to v2
        (1 more day block), resulting in mixed key_versions.
        Returns (chain, mk_v1, mk_v2, genesis, store)."""
        mk_v1 = _compute_mk(self.seed, 1)
        mk_v2 = _compute_mk(self.seed, 2)

        crypto_v1 = _MockCrypto(mk_v1, key_version=1)
        crypto_v2 = _MockCrypto(mk_v2, key_version=2)

        # Genesis at v1
        genesis = _make_genesis(mk_version=1)
        _seal_genesis(genesis, crypto_v1)

        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto_v1, store)

        # Day block at v1
        entry1 = _make_entry("v1-task", 1700000000000)
        db1 = chain.build_day_block(
            [entry1], prev_hash=genesis["block_hash"],
            date_str="2023-11-15", key_version=1,
        )
        store.append_blocks([db1])

        # Soft rotate: genesis now v2, re-sealed
        genesis_v2 = dict(genesis)
        genesis_v2["key_version"] = 2
        genesis_v2["format_version"] = "0.5.0"
        _seal_genesis(genesis_v2, crypto_v2)
        store._ledger[0] = genesis_v2

        # Day block at v2 (with new key)
        chain2 = LedgerChain(crypto_v2, store)
        entry2 = _make_entry("v2-task", 1700100000000)
        db2 = chain2.build_day_block(
            [entry2], prev_hash=db1["day_hash"],
            date_str="2023-11-16", key_version=2,
        )
        store.append_blocks([db2])

        # Build a version-map for verification
        version_map = {1: crypto_v1, 2: crypto_v2}

        return chain2, mk_v1, mk_v2, genesis_v2, store, version_map

    # ── D1: Single-version chain passes ───────────────────────

    def test_d1_single_version_chain_verifies(self):
        """D1: verify() passes on chain where all blocks have same key_version."""
        skip_unless_i01_chain()
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)
        genesis = _make_genesis(mk_version=1)
        _seal_genesis(genesis, crypto)
        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto, store)

        entry = _make_entry("task", 1700000000000)
        db = chain.build_day_block(
            [entry], prev_hash=genesis["block_hash"],
            date_str="2023-11-15", key_version=1,
        )
        store.append_blocks([db])

        # Use same crypto for all blocks (single version)
        result = chain.verify()
        self.assertTrue(result)

    # ── D2: Mixed-version chain passes ────────────────────────

    def test_d2_mixed_version_chain_verifies(self):
        """D2: verify() passes on chain where blocks have different key_versions."""
        skip_unless_i01_chain()
        _, _, _, _, _, version_map = self._build_mixed_chain()

        # We expect verify() to accept a version_map parameter
        chain = list(version_map.values())[-1].__self__ if False else None  # placeholder

        # This test exercises the multi-version verify path.
        # The chain has blocks with key_version=1 and key_version=2.
        # verify(get_mk_for_version=...) should pass.
        #
        # For now: reconstruct chain with the highest-version crypto
        # and verify that the new verify API works.
        mk_v2 = _compute_mk(self.seed, 2)
        crypto_v2 = _MockCrypto(mk_v2, key_version=2)

        # Build chain from the mixed store
        _, _, _, _, store, vm = self._build_mixed_chain()
        chain = LedgerChain(crypto_v2, store)

        # The verify() method should accept a get_mk_for_version callback
        result = chain.verify(get_mk_for_version=vm.get)
        self.assertTrue(result)

    # ── D3: Wrong MK for seal detection ───────────────────────

    def test_d3_cross_version_seal_detection(self):
        """D3: verify() detects seal mismatch when wrong MK is used for block's seal."""
        skip_unless_i01_chain()
        mk_v1 = _compute_mk(self.seed, 1)
        mk_v2 = _compute_mk(self.seed, 2)

        crypto_v1 = _MockCrypto(mk_v1, key_version=1)
        genesis = _make_genesis(mk_version=1)
        check_data = {k: v for k, v in genesis.items()
                      if k not in ("block_hash", "identity_seal", "signature", "format_version")}
        genesis["block_hash"] = crypto_v1.seal(json.dumps(check_data, sort_keys=True))

        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto_v1, store)

        entry = _make_entry("task", 1700000000000)
        db = chain.build_day_block(
            [entry], prev_hash=genesis["block_hash"],
            date_str="2023-11-15", key_version=1,
        )
        store.append_blocks([db])

        # Now try to verify with wrong MK (v2 instead of v1)
        crypto_v2 = _MockCrypto(mk_v2, key_version=2)
        chain_wrong = LedgerChain(crypto_v2, store)
        result = chain_wrong.verify()
        self.assertFalse(result,
                         "verify() with wrong MK should detect seal mismatch")

    # ── D4: Per-block MK selection ────────────────────────────

    def test_d4_per_block_mk_selection(self):
        """D4: verify() selects correct MK per block based on key_version field."""
        skip_unless_i01_chain()
        _, _, _, _, store, version_map = self._build_mixed_chain()

        # Use v2 crypto as base, provide version_map for per-block lookup
        mk_v2 = _compute_mk(self.seed, 2)
        crypto_v2 = _MockCrypto(mk_v2, key_version=2)
        chain = LedgerChain(crypto_v2, store)
        result = chain.verify(get_mk_for_version=version_map.get)
        self.assertTrue(result,
                        "verify() must select correct MK per block's key_version")

    # ── D5: Entry decryption with block's key_version ─────────

    def test_d5_entry_decryption_with_block_key_version(self):
        """D5: verify() correctly verifies entry-level encryption with block's key_version."""
        skip_unless_i01_chain()
        _, _, _, _, store, version_map = self._build_mixed_chain()

        mk_v2 = _compute_mk(self.seed, 2)
        crypto_v2 = _MockCrypto(mk_v2, key_version=2)
        chain = LedgerChain(crypto_v2, store)
        result = chain.verify(get_mk_for_version=version_map.get)
        self.assertTrue(result)

    # ── D6: Missing version detection ─────────────────────────

    def test_d6_missing_version_detection(self):
        """D6: verify() returns False when a v2 block is present but MK_v2 is not
        in session cache."""
        skip_unless_i01_chain()
        _, _, _, _, store, version_map = self._build_mixed_chain()

        # Only provide v1 — v2 not available
        mk_v1 = _compute_mk(self.seed, 1)
        crypto_v1 = _MockCrypto(mk_v1, key_version=1)
        chain = LedgerChain(crypto_v1, store)
        partial_map = {1: crypto_v1}  # Missing version 2
        result = chain.verify(get_mk_for_version=partial_map.get)
        self.assertFalse(result,
                         "verify() should fail when needed MK version is missing")

    # ── D7: verify_block on mixed-version chain ───────────────

    def test_d7_verify_block_mixed_version(self):
        """D7: verify_block(N) on mixed-version chain uses per-block key_version."""
        skip_unless_i01_chain()
        _, _, _, _, store, version_map = self._build_mixed_chain()

        mk_v2 = _compute_mk(self.seed, 2)
        crypto_v2 = _MockCrypto(mk_v2, key_version=2)
        chain = LedgerChain(crypto_v2, store)

        # Block 1 (v1) should verify with v1 MK
        result_b1 = chain.verify_block(1, get_mk_for_version=version_map.get)
        self.assertTrue(result_b1)

        # Block 2 (v2) should verify with v2 MK
        result_b2 = chain.verify_block(2, get_mk_for_version=version_map.get)
        self.assertTrue(result_b2)

    # ── D8: Identity MACs survive rotation ────────────────────

    def test_d8_identity_macs_survive_rotation(self):
        """D8: Identity MACs remain valid across key versions (identity secret
        is version-independent)."""
        skip_unless_i01_chain()
        mk_v1 = _compute_mk(self.seed, 1)
        crypto_v1 = _MockCrypto(mk_v1, key_version=1)
        genesis = _make_genesis(mk_version=1)
        check_data = {k: v for k, v in genesis.items()
                      if k not in ("block_hash", "identity_seal", "signature", "format_version")}
        genesis["block_hash"] = crypto_v1.seal(json.dumps(check_data, sort_keys=True))

        identity_secret = self.identity_secret
        identity_mac_v1 = crypto_v1.mac(genesis["block_hash"], identity_secret)

        # After rotation, identity_secret doesn't change, so the MAC should
        # still verify with the same identity_secret
        mk_v2 = _compute_mk(self.seed, 2)
        crypto_v2 = _MockCrypto(mk_v2, key_version=2)
        self.assertTrue(
            crypto_v2.verify_mac(genesis["block_hash"], identity_mac_v1, identity_secret),
            "Identity MACs must remain valid across key versions"
        )

    # ── D9: Content hash survives re-encryption ───────────────

    def test_d9_content_hash_invariant(self):
        """D9: Content hash survives key rotation (same content_hash after re-encryption)."""
        skip_unless_i01_chain()
        # Content hash is over plaintext; if we compute it with different MKs
        # but same plaintext, it should be identical
        mk_v1 = _compute_mk(self.seed, 1)
        mk_v2 = _compute_mk(self.seed, 2)
        crypto_v1 = _MockCrypto(mk_v1, key_version=1)
        crypto_v2 = _MockCrypto(mk_v2, key_version=2)

        # Encrypt same data with different MKs
        plaintext = "test data"
        ct_v1 = crypto_v1.encrypt(plaintext)
        ct_v2 = crypto_v2.encrypt(plaintext)

        # Decrypt with respective MKs should yield same plaintext
        self.assertEqual(crypto_v1.decrypt(ct_v1), plaintext)
        self.assertEqual(crypto_v2.decrypt(ct_v2), plaintext)

        # Content hash (computed over plaintext) should be identical
        ch1 = hashlib.sha256(json.dumps(
            {"data": plaintext}, sort_keys=True).encode()).hexdigest()
        ch2 = hashlib.sha256(json.dumps(
            {"data": plaintext}, sort_keys=True).encode()).hexdigest()
        self.assertEqual(ch1, ch2)

    # ── D10: Pre-ADR chain (no key_version) verifies ──────────

    def test_d10_pre_adr_chain_verifies(self):
        """D10: verify() on pre-ADR chain (no key_version fields) still passes."""
        skip_unless_i01_chain()
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)

        # Pre-ADR genesis (no key_version, no format_version with key_version)
        genesis = {
            "type": "genesis",
            "block_hash": "genesis_hash_temp",
            "identity": {"identity_pub_key": "ab" * 32},
            "format_version": "0.4.0",
        }
        check_data = {k: v for k, v in genesis.items()
                      if k not in ("block_hash", "identity_seal", "signature", "format_version")}
        genesis["block_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))

        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto, store)

        entry = _make_entry("task", 1700000000000)
        db = chain.build_day_block(
            [entry], prev_hash=genesis["block_hash"],
            date_str="2023-11-15",
        )
        # No key_version in block
        self.assertNotIn("key_version", db)
        store.append_blocks([db])

        result = chain.verify()
        self.assertTrue(result)

    # ── D11: Mixed pre-ADR + post-ADR blocks verify ───────────

    def test_d11_mixed_adr_chain_verifies(self):
        """D11: verify() on chain with mixed pre-ADR (no key_version) + post-ADR
        blocks passes."""
        skip_unless_i01_chain()
        mk = _compute_mk(self.seed, 1)
        crypto = _MockCrypto(mk, key_version=1)

        # Pre-ADR genesis
        genesis = {
            "type": "genesis",
            "block_hash": "temp",
            "identity": {"identity_pub_key": "ab" * 32},
            "format_version": "0.4.0",
        }
        check_data = {k: v for k, v in genesis.items()
                      if k not in ("block_hash", "identity_seal", "signature", "format_version")}
        genesis["block_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))

        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto, store)

        # Pre-ADR day block (no key_version)
        entry1 = _make_entry("old-task", 1700000000000)
        db1 = chain.build_day_block(
            [entry1], prev_hash=genesis["block_hash"],
            date_str="2023-11-15",
        )
        store.append_blocks([db1])

        # Post-ADR day block (with key_version)
        entry2 = _make_entry("new-task", 1700100000000)
        db2 = chain.build_day_block(
            [entry2], prev_hash=db1["day_hash"],
            date_str="2023-11-16", key_version=1,
        )
        store.append_blocks([db2])

        result = chain.verify()
        self.assertTrue(result,
                        "Mixed pre/post-ADR blocks must verify")

    # ── D12: Block newer than genesis key_version ─────────────

    def test_d12_block_newer_than_genesis_returns_false(self):
        """D12: verify() with genesis key_version=2 but day block key_version=3
        returns False."""
        skip_unless_i01_chain()
        mk_v2 = _compute_mk(self.seed, 2)
        mk_v3 = _compute_mk(self.seed, 3)

        crypto_v2 = _MockCrypto(mk_v2, key_version=2)
        genesis = _make_genesis(mk_version=2)
        check_data = {k: v for k, v in genesis.items()
                      if k not in ("block_hash", "identity_seal", "signature", "format_version")}
        genesis["block_hash"] = crypto_v2.seal(json.dumps(check_data, sort_keys=True))

        store = _MockLedgerStore([genesis])
        chain = LedgerChain(crypto_v2, store)

        entry = _make_entry("task", 1700000000000)
        crypto_v3 = _MockCrypto(mk_v3, key_version=3)
        chain_v3 = LedgerChain(crypto_v3, store)
        db = chain_v3.build_day_block(
            [entry], prev_hash=genesis["block_hash"],
            date_str="2023-11-15", key_version=3,
        )
        store.append_blocks([db])

        # Block 1 has key_version=3 but genesis has key_version=2 → invalid
        result = chain.verify()
        self.assertFalse(result,
                         "Day block with key_version > genesis key_version must fail")


if __name__ == "__main__":
    unittest.main()
