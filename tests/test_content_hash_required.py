"""Tests for I-06: content_hash required at format_version >= 0.4.0.

Phase 2 RED tests — these tests define the expected behavior before
implementation. All tests with format_version="0.4.0" and missing
content_hash must fail verification (RED). Backward compat tests
at lower format_versions must continue to pass.

Groups:
  A1-A8: Python format_version gating on content_hash
  F1-F4: Edge cases (genesis-only, mixed content, multi-block scan, version comparison)
"""

import unittest
import json
import hashlib
import hmac
import os
from typing import Optional, Dict, Any


# ──────────────────────────────────────────────────────────────────────
# Mock Helpers (mirror test_phase3_ledger_engine.py patterns)
# ──────────────────────────────────────────────────────────────────────

class _MockCrypto:
    """Deterministic crypto mock for seal/sign/encrypt/decrypt."""

    def __init__(self, mk=b"\x01" * 32):
        self.mk = mk

    def encrypt(self, text: str) -> str:
        return "enc:" + text.encode().hex()

    def decrypt(self, hex_data: str) -> str:
        if hex_data.startswith("enc:"):
            return bytes.fromhex(hex_data[4:]).decode()
        if hex_data.startswith("plain:"):
            return hex_data[6:]
        raise ValueError(f"Unknown encrypted format: {hex_data[:20]}...")

    def seal(self, data_str: str) -> str:
        key = hmac.new(self.mk, b"integrity-key-salt", hashlib.sha256).digest()
        return hmac.new(key, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_seal(self, data_str: str, signature: str) -> bool:
        return hmac.compare_digest(self.seal(data_str), signature)

    def mac(self, data_str: str, identity_secret: bytes) -> str:
        return hmac.new(identity_secret, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_mac(self, data_str: str, mac_tag: str, identity_secret: bytes) -> bool:
        return hmac.compare_digest(self.mac(data_str, identity_secret), mac_tag)


class _MockLedgerStore:
    """In-memory mock implementing both old and new AbstractLedgerStore API."""

    def __init__(self, initial_ledger=None):
        self._ledger = initial_ledger if initial_ledger is not None else []

    # Old API
    def read_ledger(self):
        return list(self._ledger)

    def write_ledger(self, data):
        self._ledger = list(data)

    def read_index(self):
        return {}

    def write_index(self, data):
        pass

    def read_staging(self):
        return []

    def write_staging(self, data):
        pass

    def read_identity(self):
        return None

    # New AbstractLedgerStore API
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
        kept = self._ledger[:keep_count]
        removed = self._ledger[keep_count:]
        self._ledger = kept
        return removed

    def get_block_count(self):
        return len(self._ledger)

    def get_last_block(self):
        return self._ledger[-1] if self._ledger else None


# ──────────────────────────────────────────────────────────────────────
# Chain building helpers
# ──────────────────────────────────────────────────────────────────────

def _compute_entry_hash(data: dict) -> str:
    """SHA-256 of entry data with sort_keys + indent=2 (matching chain.py)."""
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, indent=2).encode()
    ).hexdigest()


def _compute_content_hash(data: dict, crypto: _MockCrypto) -> str:
    """Compute content_hash the same way _verify_content_hash expects.

    Mirrors the extensible algorithm:
    - Fields ending in _enc are decrypted
    - Lists are sorted
    - content_hash itself is excluded
    - sort_keys=True (no indent)
    """
    content = {}
    for key, value in data.items():
        if key == "content_hash":
            continue
        if key.endswith("_enc") and value is not None and value != "":
            try:
                content[key] = crypto.decrypt(value)
            except Exception:
                content[key] = value
        elif isinstance(value, list):
            content[key] = sorted(value)
        else:
            content[key] = value
    return hashlib.sha256(
        json.dumps(content, sort_keys=True).encode()
    ).hexdigest()


def _make_genesis(format_version=None):
    """Create a genesis block matching current chain format.

    format_version is placed in the genesis block (per PHPSPEC).
    If None, the genesis has no format_version (implicit 0.2.0).
    """
    content = {
        "type": "genesis",
        "day_index": 0,
        "date": "2026-01-01",
        "identity": {
            "username": "tester",
            "email": "test@example.com",
            "recovery_seed_enc": "enc:seed",
            "identity_pub_key": "a" * 64,
            "identity_secret_enc_fallback": "enc:secret",
        },
        "prev_hash": "0" * 64,
        "entries": [],
    }
    if format_version is not None:
        content["format_version"] = format_version
    return content


def _make_entry_data(title="Test Task", start_epoch=1700000000000, duration=3600000,
                     tags=None, comment="", crypto=None, include_content_hash=True):
    """Create an entry data dict, optionally with content_hash."""
    c = crypto or _MockCrypto()
    data = {
        "title": title,
        "startTime_enc": c.encrypt(str(start_epoch)),
        "endTime_enc": c.encrypt(str(start_epoch + duration)),
        "duration": duration,
        "tags": sorted(tags) if tags else [],
        "pauses_enc": c.encrypt("[]"),
        "metadata_enc": c.encrypt("{}"),
        "comment": comment,
        "media": [],
    }
    if include_content_hash:
        data["content_hash"] = _compute_content_hash(data, c)
    return data


def _seal_genesis(genesis_content, crypto):
    """Seal a genesis block and return the complete block dict."""
    block = dict(genesis_content)
    check_data = {k: v for k, v in block.items()
                  if k not in ("block_hash", "day_hash", "identity_seal", "signature")}
    block["block_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
    return block


def _seal_day(day_content, crypto):
    """Seal a day block and return the complete block dict."""
    block = dict(day_content)
    check_data = {k: v for k, v in block.items()
                  if k not in ("day_hash", "identity_seal", "signature", "format_version")}
    block["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
    return block


def _build_chain(genesis_fv, entry_specs, crypto=None):
    """Build a full chain with genesis and day blocks.

    Args:
        genesis_fv: format_version string or None
        entry_specs: list of dicts with keys:
            - data: entry data dict (from _make_entry_data)
            - date: date string for the day block
        crypto: _MockCrypto instance

    Returns:
        (chain_list, genesis_block, crypto)
    """
    c = crypto or _MockCrypto()
    genesis = _make_genesis(genesis_fv)
    genesis_block = _seal_genesis(genesis, c)

    chain = [genesis_block]
    prev_hash = genesis_block["block_hash"]

    # Group entries by date
    from collections import OrderedDict
    by_date = OrderedDict()
    for spec in entry_specs:
        date = spec["date"]
        if date not in by_date:
            by_date[date] = []
        by_date[date].append(spec["data"])

    day_index = 1
    for date, entries in by_date.items():
        normalized = []
        for data in entries:
            entry_hash = _compute_entry_hash(data)
            normalized.append({"hash": entry_hash, "data": data})

        day = _seal_day({
            "type": "day",
            "day_index": day_index,
            "date": date,
            "prev_hash": prev_hash,
            "entries": normalized,
        }, c)
        chain.append(day)
        prev_hash = day["day_hash"]
        day_index += 1

    return chain, c


def _store_and_verify(chain, crypto):
    """Store chain in mock store and run verify()."""
    store = _MockLedgerStore(initial_ledger=chain)
    from domain.ledger.chain import LedgerChain
    lc = LedgerChain(crypto, store)
    return lc.verify()


# ──────────────────────────────────────────────────────────────────────
# Import check
# ──────────────────────────────────────────────────────────────────────

LedgerChain = None
try:
    from domain.ledger.chain import LedgerChain
except (ImportError, ModuleNotFoundError):
    pass


def _require_chain():
    if LedgerChain is None:
        raise unittest.SkipTest("LedgerChain not available")


# ══════════════════════════════════════════════════════════════════════
# Group A: Python format_version gating (A1-A8)
# ══════════════════════════════════════════════════════════════════════

class TestContentHashRequiredFv040(unittest.TestCase):
    """Tests for content_hash required at format_version >= 0.4.0."""

    def setUp(self):
        _require_chain()
        self.crypto = _MockCrypto()

    def _build_chain(self, genesis_fv, entry_data, date="2026-01-01"):
        return _build_chain(genesis_fv, [{"data": entry_data, "date": date}],
                           crypto=self.crypto)

    # ── A1: Entry without content_hash at 0.4.0 → verification fails ──

    def test_a1_entry_without_content_hash_at_040_fails(self):
        """Core behavior: content_hash is required at format_version 0.4.0+."""
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=False)
        chain, _ = self._build_chain("0.4.0", entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertFalse(result,
            "A1: Entry without content_hash at format_version 0.4.0 must fail verification")

    # ── A2: Entry with valid content_hash at 0.4.0 → passes ──────────

    def test_a2_entry_with_valid_content_hash_at_040_passes(self):
        """content_hash still works correctly when present at 0.4.0."""
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=True)
        chain, _ = self._build_chain("0.4.0", entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertTrue(result,
            "A2: Entry with valid content_hash at format_version 0.4.0 must pass verification")

    # ── A3: Entry with wrong content_hash at 0.4.0 → fails ───────────

    def test_a3_entry_with_wrong_content_hash_at_040_fails(self):
        """Tampered content_hash is always rejected."""
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=True)
        entry["content_hash"] = "f" * 64  # wrong hash
        chain, _ = self._build_chain("0.4.0", entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertFalse(result,
            "A3: Entry with wrong content_hash at format_version 0.4.0 must fail verification")

    # ── A4: Entry without content_hash at 0.3.0 → passes (backward compat)

    def test_a4_entry_without_content_hash_at_030_passes(self):
        """Pre-0.4.0 ledgers retain backward compatibility."""
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=False)
        chain, _ = self._build_chain("0.3.0", entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertTrue(result,
            "A4: Entry without content_hash at format_version 0.3.0 must pass (backward compat)")

    # ── A5: Entry with valid content_hash at 0.3.0 → passes ──────────

    def test_a5_entry_with_valid_content_hash_at_030_passes(self):
        """content_hash still verified when present (at any format_version)."""
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=True)
        chain, _ = self._build_chain("0.3.0", entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertTrue(result,
            "A5: Entry with valid content_hash at format_version 0.3.0 must pass")

    # ── A6: Entry without content_hash at absent format_version → passes

    def test_a6_entry_without_content_hash_no_fv_passes(self):
        """No format_version = pre-spec (implicit 0.2.0), content_hash optional."""
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=False)
        chain, _ = self._build_chain(None, entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertTrue(result,
            "A6: Entry without content_hash at absent format_version must pass (legacy)")

    # ── A7: Genesis with format_version but no day entries → passes ───

    def test_a7_genesis_only_with_fv_passes(self):
        """Empty ledger chain is always valid — no entries to check."""
        genesis_block = _seal_genesis(_make_genesis("0.4.0"), self.crypto)
        chain = [genesis_block]
        result = _store_and_verify(chain, self.crypto)
        self.assertTrue(result,
            "A7: Genesis-only chain with format_version 0.4.0 must pass (no entries)")

    # ── A8: Version comparison uses numeric segments ─────────────────

    def test_a8_version_comparison_numeric_segments(self):
        """format_version comparison must use segment-wise int comparison.

        "0.10.0" > "0.9.0" and "0.10.0" >= "0.4.0", so content_hash is required.
        """
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=False)
        chain, _ = self._build_chain("0.10.0", entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertFalse(result,
            "A8: Entry without content_hash at format_version 0.10.0 must fail "
            "(numeric comparison, not string)")

    def test_a8b_version_near_boundary(self):
        """0.4.0 itself is the threshold — content_hash IS required at 0.4.0."""
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=False)
        chain, _ = self._build_chain("0.4.0", entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertFalse(result,
            "A8b: content_hash required AT format_version 0.4.0 (inclusive boundary)")

    def test_a8c_version_below_threshold(self):
        """0.3.9 is below threshold — content_hash NOT required."""
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=False)
        chain, _ = self._build_chain("0.3.9", entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertTrue(result,
            "A8c: content_hash NOT required at format_version 0.3.9")


# ══════════════════════════════════════════════════════════════════════
# Group F: Edge cases (F1-F4)
# ══════════════════════════════════════════════════════════════════════

class TestContentHashEdgeCases(unittest.TestCase):
    """Edge cases for content_hash format_version gating."""

    def setUp(self):
        _require_chain()
        self.crypto = _MockCrypto()

    def _build_chain(self, genesis_fv, entry_data, date="2026-01-01"):
        return _build_chain(genesis_fv, [{"data": entry_data, "date": date}],
                           crypto=self.crypto)

    # ── F1: Genesis only → verify passes ─────────────────────────────

    def test_f1_genesis_only_passes(self):
        """No day blocks = no entries to check content_hash on. Empty chain is valid."""
        genesis = _seal_genesis(_make_genesis("0.4.0"), self.crypto)
        chain = [genesis]
        result = _store_and_verify(chain, self.crypto)
        self.assertTrue(result,
            "F1: Genesis-only chain at 0.4.0 must pass verification")

    # ── F2: Mixed content — some entries without content_hash ─────────

    def test_f2_mixed_content_entries_fail(self):
        """If any entry lacks content_hash at 0.4.0, the whole chain fails."""
        entry_with = _make_entry_data(
            title="Good Entry", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=True)
        entry_without = _make_entry_data(
            title="Bad Entry", start_epoch=1700086400000,
            crypto=self.crypto, include_content_hash=False)

        chain, _ = _build_chain("0.4.0", [
            {"data": entry_with, "date": "2026-01-01"},
            {"data": entry_without, "date": "2026-01-01"},
        ], crypto=self.crypto)
        result = _store_and_verify(chain, self.crypto)
        self.assertFalse(result,
            "F2: Mixed entries (one with content_hash, one without) must fail at 0.4.0")

    # ── F3: Multi-block scan — first block OK, second missing ────────

    def test_f3_second_block_missing_content_hash_fails(self):
        """Full chain scan catches missing content_hash in any block."""
        entry_good = _make_entry_data(
            title="Good", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=True)
        entry_bad = _make_entry_data(
            title="Bad", start_epoch=1700172800000,
            crypto=self.crypto, include_content_hash=False)

        chain, _ = _build_chain("0.4.0", [
            {"data": entry_good, "date": "2026-01-01"},
            {"data": entry_bad, "date": "2026-01-03"},
        ], crypto=self.crypto)
        result = _store_and_verify(chain, self.crypto)
        self.assertFalse(result,
            "F3: Missing content_hash in second day block must still cause failure")

    # ── F4: 4-segment version string comparison ──────────────────────

    def test_f4_four_segment_version_comparison(self):
        """Numeric segment comparison handles non-standard version strings.

        "0.40.0" (3 segments, middle=40) > "0.4.0" → content_hash required.
        """
        entry = _make_entry_data(
            title="Task", start_epoch=1700000000000,
            crypto=self.crypto, include_content_hash=False)
        chain, _ = self._build_chain("0.40.0", entry)
        result = _store_and_verify(chain, self.crypto)
        self.assertFalse(result,
            "F4: format_version 0.40.0 is >= 0.4.0, content_hash must be required")


if __name__ == "__main__":
    unittest.main()
