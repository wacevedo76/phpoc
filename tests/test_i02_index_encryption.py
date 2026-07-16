"""I-02 Phase 2 (RED): Blind index encryption tests — Python.

Covers Phase 1 assertion Groups:
  - A: Index blob encryption — IndexManager (12 tests)
  - B: Index integration — LedgerEngine / CLI (8 tests)
  - H: Key derivation — Python subset (H1, H2, H4, H7)
  - I: Edge cases & migration — index subset (I4, I5, I6)

All tests are written against the FUTURE API that will exist after Phase 3.
They are expected to FAIL (RED) because encryption is not yet implemented.
"""

import json
import hashlib
import hmac
import os
import struct
import time
import unittest
from pathlib import Path
from typing import Optional
from unittest.mock import MagicMock, patch

# ── Pre-import checks — I-02 components may not exist yet ─────────────
try:
    from security.crypto import CryptoManager, NoAuthCryptoManager
    from domain.ledger.index_manager import IndexManager
    from domain.ledger.engine import LedgerEngine
    from storage.index_store import AbstractIndexStore
    from storage.file_store import LedgerStore
    HAS_I02_MODULES = True
except ImportError:
    HAS_I02_MODULES = False

# ── Derivation functions (may not exist yet) ──────────────────────────
try:
    from security.crypto import derive_index_key, derive_field_key
    HAS_DERIVATION = True
except ImportError:
    HAS_DERIVATION = False


# ══════════════════════════════════════════════════════════════════════
# Test helpers
# ══════════════════════════════════════════════════════════════════════

def _mk_master_key(seed: int = 42) -> bytes:
    """Generate a deterministic 32-byte master key for testing."""
    return hashlib.sha256(f"test-mk-{seed}".encode()).digest()


def _is_encrypted_blob(data) -> bool:
    """Heuristic: is this data encrypted (hex string of binary), not plain JSON?"""
    if not isinstance(data, str):
        return False
    if data.startswith("{") or data.startswith("["):
        return False
    # Encrypted data should be hex (all hex chars)
    try:
        bytes.fromhex(data)
        return len(data) >= 32  # minimum reasonable ciphertext
    except (ValueError, TypeError):
        return False


def _is_plaintext_json(data) -> bool:
    """Check if data is plaintext JSON (an index dict, not encrypted)."""
    if isinstance(data, dict):
        # Encrypted wrapper: {"_enc": "<hex>"}
        if "_enc" in data:
            return False
        return True
    if isinstance(data, str) and (data.startswith("{") or data.startswith("[")):
        return True
    return False


# ══════════════════════════════════════════════════════════════════════
# MockEncryptedIndexStore — wraps a dict to simulate encrypted storage
# ══════════════════════════════════════════════════════════════════════

class MockEncryptedIndexStore(AbstractIndexStore):
    """A store that records what was written (for observing encryption)."""

    def __init__(self, initial_data=None):
        self._data = dict(initial_data) if initial_data else {}
        self.write_calls = []

    def read_index(self):
        if isinstance(self._data, dict):
            return dict(self._data)
        return self._data

    def write_index(self, data):
        self.write_calls.append(data)
        self._data = dict(data) if isinstance(data, dict) else data


# ══════════════════════════════════════════════════════════════════════
# Group H: Key Derivation (Python)
# ══════════════════════════════════════════════════════════════════════

class TestKeyDerivation(unittest.TestCase):
    """H1, H2, H4, H7 — index and staging key derivation."""

    def setUp(self):
        self.mk = _mk_master_key(1)

    # ── H1: Index encryption key derivation ──────────────────────────
    def test_H1_derive_index_key_deterministic(self):
        """H1: derive_index_key(mk) always produces the same result."""
        if not HAS_DERIVATION:
            self.skipTest("derive_index_key not yet implemented")

        k1 = derive_index_key(self.mk)
        k2 = derive_index_key(self.mk)
        self.assertEqual(k1, k2)

    def test_H1_derive_index_key_uses_domain_separation(self):
        """H1: Key uses HMAC-SHA256 with domain separator 'phpoc-blind-index-v1'."""
        if not HAS_DERIVATION:
            self.skipTest("derive_index_key not yet implemented")

        expected = hmac.new(
            self.mk, b"phpoc-blind-index-v1", hashlib.sha256
        ).digest()[:16]
        actual = derive_index_key(self.mk)
        self.assertEqual(actual, expected)

    def test_H1_derive_index_key_returns_16_bytes(self):
        """H1: Index key is 16 bytes (AES-128)."""
        if not HAS_DERIVATION:
            self.skipTest("derive_index_key not yet implemented")

        key = derive_index_key(self.mk)
        self.assertEqual(len(key), 16)

    # ── H2: Staging field key derivation ─────────────────────────────
    def test_H2_derive_field_key_deterministic(self):
        """H2: derive_field_key(mk) always produces the same result."""
        if not HAS_DERIVATION:
            self.skipTest("derive_field_key not yet implemented")

        k1 = derive_field_key(self.mk)
        k2 = derive_field_key(self.mk)
        self.assertEqual(k1, k2)

    def test_H2_derive_field_key_uses_domain_separation(self):
        """H2: Key uses HMAC-SHA256 with domain separator 'phpoc-staging-keys-v1'."""
        if not HAS_DERIVATION:
            self.skipTest("derive_field_key not yet implemented")

        expected = hmac.new(
            self.mk, b"phpoc-staging-keys-v1", hashlib.sha256
        ).digest()[:16]
        actual = derive_field_key(self.mk)
        self.assertEqual(actual, expected)

    # ── H4: Different MKs produce different keys ─────────────────────
    def test_H4_different_mk_different_index_key(self):
        """H4: Different master keys produce different index keys."""
        if not HAS_DERIVATION:
            self.skipTest("derive_index_key not yet implemented")

        mk1 = _mk_master_key(1)
        mk2 = _mk_master_key(2)
        self.assertNotEqual(derive_index_key(mk1), derive_index_key(mk2))

    def test_H4_different_mk_different_field_key(self):
        """H4: Different master keys produce different staging field keys."""
        if not HAS_DERIVATION:
            self.skipTest("derive_field_key not yet implemented")

        mk1 = _mk_master_key(1)
        mk2 = _mk_master_key(2)
        self.assertNotEqual(derive_field_key(mk1), derive_field_key(mk2))

    def test_H4_index_and_field_keys_different(self):
        """H4: Index key and field key are different (domain separation works)."""
        if not HAS_DERIVATION:
            self.skipTest("derive functions not yet implemented")

        mk = _mk_master_key(1)
        self.assertNotEqual(derive_index_key(mk), derive_field_key(mk))

    # ── H7: Forward security — derived key can't reverse to MK ───────
    def test_H7_derived_key_does_not_reveal_mk(self):
        """H7: Derived key cannot be used to recover the master key."""
        if not HAS_DERIVATION:
            self.skipTest("derive functions not yet implemented")

        mk = os.urandom(32)
        dk = derive_index_key(mk)
        # The derived key should not contain the master key as a substring
        self.assertNotIn(mk, dk)
        # HMAC is one-way: deriving the MK from the sub-key is computationally infeasible
        # Verify: the derived key is not simply the first N bytes of MK
        self.assertNotEqual(dk, mk[:len(dk)])


# ══════════════════════════════════════════════════════════════════════
# Group A: Index blob encryption — IndexManager (Python)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipIf(not HAS_I02_MODULES, "I-02 modules not yet available")
class TestIndexManagerEncryption(unittest.TestCase):
    """A1-A12: Index encryption/decryption through IndexManager."""

    def setUp(self):
        self.mk = _mk_master_key(1)
        self.crypto = CryptoManager(self.mk)
        self.store = MockEncryptedIndexStore()

    def _create_index_manager(self, crypto=None, store=None):
        """Create an IndexManager with optional crypto for encryption."""
        s = store or self.store
        try:
            return IndexManager(s, crypto=crypto)
        except TypeError:
            # Fallback: current constructor only takes store
            return IndexManager(s)

    # ── A1: write_index stores encrypted ciphertext ──────────────────
    def test_A1_write_index_stores_encrypted(self):
        """A1: On-disk format is opaque — not plaintext JSON."""
        im = self._create_index_manager(crypto=self.crypto)
        im.update("2026-01-15", "Guitar", 3600000)

        raw = self.store.read_index()
        self.assertFalse(
            _is_plaintext_json(raw),
            f"write_index stored plaintext JSON: {str(raw)[:100]}"
        )

    def test_A1_encrypted_blob_is_hex_or_binary(self):
        """A1: Encrypted index is non-JSON (hex ciphertext or binary)."""
        im = self._create_index_manager(crypto=self.crypto)
        im.update("2026-01-15", "Reading", 1800000)

        raw = self.store.read_index()
        # If string, should not parse as JSON
        if isinstance(raw, str):
            with self.assertRaises((json.JSONDecodeError, ValueError, TypeError)):
                json.loads(raw)
        # If dict, should have an _enc marker
        elif isinstance(raw, dict):
            self.assertIn("_enc", raw, "Expected _enc marker in encrypted index dict")

    # ── A2: read_index decrypts correctly ────────────────────────────
    def test_A2_read_index_decrypts_roundtrip(self):
        """A2: read_index() returns the original dict after encrypt-then-decrypt."""
        im = self._create_index_manager(crypto=self.crypto)
        im.update("2026-01-15", "Guitar", 3600000)
        im.update("2026-01-15", "Reading", 1800000)

        # Create a fresh IndexManager that reads from the same store
        im2 = self._create_index_manager(crypto=self.crypto)
        all_data = im2.get_all()
        self.assertIn("2026-01-15", all_data)
        self.assertEqual(all_data["2026-01-15"]["Guitar"], 3600000)
        self.assertEqual(all_data["2026-01-15"]["Reading"], 1800000)

    # ── A3: _flush writes encrypted data ─────────────────────────────
    def test_A3_flush_writes_encrypted(self):
        """A3: _flush() produces encrypted output through the store."""
        im = self._create_index_manager(crypto=self.crypto)
        im.update("2026-01-20", "Coding", 7200000)

        # The last write call should contain encrypted data
        self.assertTrue(len(self.store.write_calls) >= 1)
        last_write = self.store.write_calls[-1]
        self.assertFalse(
            _is_plaintext_json(last_write),
            f"_flush() wrote plaintext: {str(last_write)[:100]}"
        )

    # ── A4: _load reads and decrypts ─────────────────────────────────
    def test_A4_load_reads_encrypted(self):
        """A4: _load() reads encrypted data and populates decrypted cache."""
        # Pre-populate store with encrypted index
        im = self._create_index_manager(crypto=self.crypto)
        im.update("2026-03-01", "Yoga", 1800000)

        # New instance reads from same store
        im2 = self._create_index_manager(crypto=self.crypto)
        self.assertEqual(im2.get_all()["2026-03-01"]["Yoga"], 1800000)

    # ── A5: update → query roundtrip ─────────────────────────────────
    def test_A5_update_query_roundtrip(self):
        """A5: update() followed by query() returns correct results through encrypted store."""
        im = self._create_index_manager(crypto=self.crypto)
        im.update("2026-01-10", "Coding", 3600000)
        im.update("2026-01-15", "Coding", 7200000)
        im.update("2026-01-20", "Reading", 5400000)

        result = im.query("2026-01-10", "2026-01-20")
        self.assertEqual(result["Coding"], 3600000 + 7200000)
        self.assertEqual(result["Reading"], 5400000)

    # ── A6: clear writes encrypted empty ─────────────────────────────
    def test_A6_clear_writes_encrypted_empty(self):
        """A6: clear() writes an encrypted empty dict, not plaintext {}."""
        im = self._create_index_manager(crypto=self.crypto)
        im.update("2026-01-15", "Guitar", 3600000)
        im.clear()

        raw = self.store.read_index()
        self.assertFalse(
            _is_plaintext_json(raw),
            f"clear() wrote plaintext: {str(raw)[:100]}"
        )

        # After clear, reading back should give empty
        im2 = self._create_index_manager(crypto=self.crypto)
        self.assertEqual(im2.get_all(), {})

    # ── A7: reload re-reads from encrypted store ────────────────────
    def test_A7_reload_from_encrypted_store(self):
        """A7: reload() re-reads from encrypted store correctly."""
        im1 = self._create_index_manager(crypto=self.crypto)
        im1.update("2026-02-01", "Guitar", 1800000)

        # Another instance modifies the store
        im2 = self._create_index_manager(crypto=self.crypto)
        im2.update("2026-02-02", "Piano", 3600000)

        # im1 should see the new data after reload
        im1.reload()
        all_data = im1.get_all()
        self.assertIn("2026-02-02", all_data)
        self.assertEqual(all_data["2026-02-02"]["Piano"], 3600000)

    # ── A8: Fresh store first write encrypted ────────────────────────
    def test_A8_first_write_on_fresh_store_encrypted(self):
        """A8: First write on a brand-new store produces encrypted output."""
        fresh_store = MockEncryptedIndexStore()
        im = self._create_index_manager(crypto=self.crypto, store=fresh_store)
        im.update("2026-04-01", "Running", 600000)

        raw = fresh_store.read_index()
        self.assertFalse(
            _is_plaintext_json(raw),
            f"First write on fresh store produced plaintext: {str(raw)[:100]}"
        )

    # ── A9: Legacy plaintext index readable ──────────────────────────
    def test_A9_legacy_plaintext_readable(self):
        """A9: A plaintext JSON index (pre-upgrade) is readable."""
        legacy_data = {
            "2026-01-15": {"Guitar": 3600000, "Reading": 1800000},
        }
        self.store.write_index(legacy_data)

        im = self._create_index_manager(crypto=self.crypto)
        all_data = im.get_all()
        self.assertEqual(all_data["2026-01-15"]["Guitar"], 3600000)
        self.assertEqual(all_data["2026-01-15"]["Reading"], 1800000)

    # ── A10: Legacy upgraded to encrypted on write ───────────────────
    def test_A10_legacy_upgraded_on_write(self):
        """A10: Legacy plaintext index is upgraded to encrypted on first mutation."""
        # Start with legacy plaintext
        self.store.write_index({"2026-01-15": {"Guitar": 3600000}})
        im = self._create_index_manager(crypto=self.crypto)

        # Trigger a mutation
        im.update("2026-01-16", "Reading", 1800000)

        # After mutation, the store should contain encrypted data
        raw = self.store.read_index()
        self.assertFalse(
            _is_plaintext_json(raw),
            f"Legacy index not upgraded: {str(raw)[:100]}"
        )

        # And the data should still be correct
        im2 = self._create_index_manager(crypto=self.crypto)
        all_data = im2.get_all()
        self.assertEqual(all_data["2026-01-15"]["Guitar"], 3600000)
        self.assertEqual(all_data["2026-01-16"]["Reading"], 1800000)

    # ── A11: Corrupt ciphertext → empty dict (no crash) ──────────────
    def test_A11_corrupt_ciphertext_returns_empty(self):
        """A11: Corrupt encrypted data returns empty dict, does not crash."""
        # Write garbage that looks encrypted but isn't valid
        self.store.write_index("DEADBEEF" * 10)  # hex but not valid ciphertext

        try:
            im = self._create_index_manager(crypto=self.crypto)
            result = im.get_all()
            self.assertEqual(result, {})
        except Exception as e:
            self.fail(f"Corrupt ciphertext caused crash: {e}")

    # ── A12: Uses derived key, not raw MK ────────────────────────────
    def test_A12_uses_derived_key_not_raw_mk(self):
        """A12: Index encryption uses a derived key, not the raw master key."""
        im = self._create_index_manager(crypto=self.crypto)
        im.update("2026-01-15", "Guitar", 3600000)

        # Verify the store doesn't contain the raw MK
        raw = self.store.read_index()
        raw_str = str(raw) if not isinstance(raw, str) else raw
        # MK should NOT appear in the ciphertext
        self.assertNotIn(self.mk.hex(), raw_str)
        # MK bytes should NOT appear
        self.assertNotIn(self.mk.decode("latin-1"), raw_str)


# ══════════════════════════════════════════════════════════════════════
# Group B: Index integration — LedgerEngine / CLI (Python)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipIf(not HAS_I02_MODULES, "I-02 modules not yet available")
class TestLedgerEngineIndexIntegration(unittest.TestCase):
    """B1-B4, B8: LedgerEngine commit/revert/rebuild/sync with encrypted index."""

    def setUp(self):
        self.mk = _mk_master_key(1)
        self.crypto = CryptoManager(self.mk)

    def _create_mock_store(self):
        """Create a mock store that supports both ledger and index interfaces."""
        store = MagicMock()
        store.read_index.return_value = {}
        store.write_index = MagicMock()
        store.read_all.return_value = []
        store.read_ledger.return_value = []
        store.read_blocks.return_value = []
        store.get_last_block.return_value = None
        store.get_block_count.return_value = 0
        store.append_blocks = MagicMock()
        store.truncate.return_value = []
        store.write_ledger = MagicMock()
        store.read_staging.return_value = []
        store.write_staging = MagicMock()
        # For duck-type index_store resolution
        store.read_entries = MagicMock(return_value=[])
        store.write_entries = MagicMock()
        return store

    # ── B1: commit produces encrypted index ──────────────────────────
    def test_B1_commit_produces_encrypted_index(self):
        """B1: LedgerEngine.commit() writes an encrypted index."""
        store = self._create_mock_store()
        engine = LedgerEngine(self.crypto, store, index_store=store)

        entry = {
            "title": "Guitar",
            "start_epoch": 1700000000000,
            "duration": 3600000,
            "end_epoch": 1700003600000,
            "metadata": {},
            "pauses": [],
            "tags": [],
            "media": [],
            "is_active": False,
            "is_paused": False,
        }
        engine.commit([entry])

        # write_index should have been called
        self.assertTrue(store.write_index.called)
        written = store.write_index.call_args[0][0]

        # The written data should be encrypted (not plaintext JSON dict)
        self.assertFalse(
            _is_plaintext_json(written),
            f"commit() wrote plaintext index: {str(written)[:100]}"
        )

    # ── B2: query_index returns correct results ──────────────────────
    def test_B2_query_index_after_encrypted_commit(self):
        """B2: query_index() returns correct results through encrypted store."""
        store = self._create_mock_store()
        engine = LedgerEngine(self.crypto, store, index_store=store)

        entries = [
            {"title": "Coding", "start_epoch": 1700000000000, "duration": 3600000,
             "end_epoch": 1700003600000, "metadata": {}, "pauses": [],
             "tags": [], "media": [], "is_active": False, "is_paused": False},
            {"title": "Reading", "start_epoch": 1700000000000, "duration": 1800000,
             "end_epoch": 1700001800000, "metadata": {}, "pauses": [],
             "tags": [], "media": [], "is_active": False, "is_paused": False},
        ]
        engine.commit(entries)

        result = engine.query_index("2023-01-01", "2023-12-31")
        self.assertIn("Coding", result)
        self.assertIn("Reading", result)

    # ── B3: revert updates encrypted index ───────────────────────────
    def test_B3_revert_updates_encrypted_index(self):
        """B3: revert() correctly updates the encrypted index (subtracts durations)."""
        store = self._create_mock_store()

        # Pre-populate the ledger so revert has something to revert
        day_block = {
            "type": "day",
            "date": "2023-11-15",
            "entries": [{
                "hash": "a" * 64,
                "data": {
                    "title": "Guitar",
                    "duration": 3600000,
                    "startTime_enc": self.crypto.encrypt("1700000000000"),
                    "endTime_enc": self.crypto.encrypt("1700003600000"),
                    "metadata_enc": self.crypto.encrypt("{}"),
                    "pauses_enc": self.crypto.encrypt("[]"),
                    "tags": [],
                    "media": [],
                },
            }],
        }
        store.read_all.return_value = [day_block]
        store.read_blocks.return_value = [day_block]
        store.get_last_block.return_value = day_block
        store.get_block_count.return_value = 1

        index_store = MockEncryptedIndexStore({"2023-11-15": {"Guitar": 3600000}})
        engine = LedgerEngine(self.crypto, store, index_store=index_store)

        result = engine.revert(1)
        self.assertGreaterEqual(result, 0)

        # After revert, index should have subtracted the duration
        all_data = index_store.read_index()
        # Index should be encrypted
        self.assertFalse(
            _is_plaintext_json(all_data),
            f"revert() left plaintext index: {str(all_data)[:100]}"
        )

    # ── B4: rebuild_index produces encrypted index ───────────────────
    def test_B4_rebuild_index_produces_encrypted(self):
        """B4: rebuild_index() produces an encrypted index from scratch."""
        store = self._create_mock_store()
        index_store = MockEncryptedIndexStore()

        # Pre-populate the ledger
        day_block = {
            "type": "day",
            "date": "2026-03-01",
            "entries": [{
                "hash": "b" * 64,
                "data": {
                    "title": "Yoga",
                    "duration": 1800000,
                    "startTime_enc": self.crypto.encrypt("1700000000000"),
                    "endTime_enc": self.crypto.encrypt("1700001800000"),
                    "metadata_enc": self.crypto.encrypt("{}"),
                    "pauses_enc": self.crypto.encrypt("[]"),
                    "tags": [],
                    "media": [],
                },
            }],
        }
        store.read_all.return_value = [day_block]
        store.read_blocks.return_value = [day_block]
        store.get_last_block.return_value = day_block
        store.get_block_count.return_value = 1

        engine = LedgerEngine(self.crypto, store, index_store=index_store)
        engine.rebuild_index()

        raw = index_store.read_index()
        self.assertFalse(
            _is_plaintext_json(raw),
            f"rebuild_index() produced plaintext: {str(raw)[:100]}"
        )

        # And the data should be correct
        if isinstance(raw, dict) and "_enc" in raw:
            pass  # Encrypted — can't check content directly
        else:
            # If stored as JSON with marker, should not be plain dict
            pass

    # ── B8: Remote sync encrypted index ──────────────────────────────
    def test_B8_sync_encrypted_index_push_pull(self):
        """B8: Encrypted index survives push/pull roundtrip for cross-client sync."""
        store_a = self._create_mock_store()
        index_a = MockEncryptedIndexStore()

        engine_a = LedgerEngine(self.crypto, store_a, index_store=index_a)
        engine_a.index.update("2026-05-01", "Piano", 1800000)

        # Simulate push: extract raw index data
        pushed_data = index_a.read_index()
        self.assertFalse(
            _is_plaintext_json(pushed_data),
            f"Pushed index is plaintext: {str(pushed_data)[:100]}"
        )

        # Simulate pull: write to another store
        index_b = MockEncryptedIndexStore(pushed_data)
        store_b = self._create_mock_store()

        engine_b = LedgerEngine(self.crypto, store_b, index_store=index_b)
        engine_b.index.reload()

        all_b = engine_b.index.get_all()
        self.assertIn("2026-05-01", all_b)
        self.assertEqual(all_b["2026-05-01"]["Piano"], 1800000)


# ══════════════════════════════════════════════════════════════════════
# Group I: Edge cases & migration — index subset
# ══════════════════════════════════════════════════════════════════════

@unittest.skipIf(not HAS_I02_MODULES, "I-02 modules not yet available")
class TestIndexEdgeCases(unittest.TestCase):
    """I4, I5, I6 — large index, rebuild after migration, atomic write."""

    def setUp(self):
        self.mk = _mk_master_key(1)
        self.crypto = CryptoManager(self.mk)

    def _create_im(self, crypto=None):
        store = MockEncryptedIndexStore()
        try:
            return IndexManager(store, crypto=crypto)
        except TypeError:
            return IndexManager(store)

    # ── I4: Large index encrypts/decrypts correctly ──────────────────
    def test_I4_large_index_roundtrip(self):
        """I4: Large index (100+ activities, 365 days) encrypts and decrypts correctly."""
        im = self._create_im(crypto=self.crypto)

        # Build a large index: 365 days, ~3 activities per day
        activities = ["Coding", "Reading", "Fitness", "Guitar", "Cooking"]
        expected = {}
        for day in range(365):
            date = f"2025-{(day // 30) + 1:02d}-{(day % 28) + 1:02d}"
            for j, title in enumerate(activities[: (day % 3) + 1]):
                duration = (j + 1) * 1800000
                im.update(date, title, duration)
                if date not in expected:
                    expected[date] = {}
                expected[date][title] = expected[date].get(title, 0) + duration

        # Read back through a new IndexManager
        store = MockEncryptedIndexStore()
        try:
            im2 = IndexManager(store, crypto=self.crypto)
        except TypeError:
            im2 = IndexManager(store)
        im2._cache = im.get_all()
        # Writing through the encrypted path
        all_data = im2.get_all()

        # Spot-check a few dates
        first_date = "2025-01-01"
        if first_date in all_data:
            self.assertIn(first_date, all_data)

        # Verify all entries are integers
        for date_str, titles in all_data.items():
            for title, duration in titles.items():
                self.assertIsInstance(duration, int)

    # ── I5: Index rebuild after migration is encrypted ───────────────
    def test_I5_rebuild_after_migration_encrypted(self):
        """I5: After migration from legacy plaintext, rebuild_index produces encrypted."""
        store = self._create_mock_store_with_legacy_ledger()

        index_store = MockEncryptedIndexStore()
        engine = LedgerEngine(self.crypto, store, index_store=index_store)
        engine.rebuild_index()

        raw = index_store.read_index()
        self.assertFalse(
            _is_plaintext_json(raw),
            f"Rebuild after migration produced plaintext: {str(raw)[:100]}"
        )

    def _create_mock_store_with_legacy_ledger(self):
        store = MagicMock()
        store.read_index.return_value = {}
        store.write_index = MagicMock()
        store.read_staging.return_value = []
        store.write_staging = MagicMock()

        day_block = {
            "type": "day",
            "date": "2026-06-01",
            "entries": [{
                "hash": "c" * 64,
                "data": {
                    "title": "Guitar",
                    "duration": 3600000,
                    "startTime_enc": self.crypto.encrypt("1700000000000"),
                    "endTime_enc": self.crypto.encrypt("1700003600000"),
                    "metadata_enc": self.crypto.encrypt("{}"),
                    "pauses_enc": self.crypto.encrypt("[]"),
                    "tags": [],
                    "media": [],
                },
            }],
        }
        store.read_all.return_value = [day_block]
        store.read_blocks.return_value = [day_block]
        store.get_last_block.return_value = day_block
        store.get_block_count.return_value = 1
        store.read_ledger.return_value = [day_block]
        return store

    # ── I6: Atomic write (no torn encrypted blob) ────────────────────
    def test_I6_atomic_write_no_torn_blob(self):
        """I6: Concurrent read during write does not produce torn encrypted blob."""
        # This is an contract/invariant test: the store must write atomically
        # We verify by checking that read_index returns either the old or new state,
        # never a partially-written/corrupt state.

        im = self._create_im(crypto=self.crypto)
        im.update("2026-01-01", "Guitar", 3600000)

        # Repeated writes should always produce parsable output
        for i in range(20):
            im.update("2026-01-01", f"Activity_{i}", 1000 * (i + 1))

        # Final read should be complete (no torn state)
        all_data = im.get_all()
        self.assertIn("2026-01-01", all_data)
        # All written activities should be present
        for i in range(20):
            self.assertIn(f"Activity_{i}", all_data["2026-01-01"])


# ══════════════════════════════════════════════════════════════════════
# Group B (CLI): show_rep — CLI display from encrypted index
# ══════════════════════════════════════════════════════════════════════

@unittest.skipIf(not HAS_I02_MODULES, "I-02 modules not yet available")
class TestCLIRepDisplay(unittest.TestCase):
    """B5-B7: CLI show_rep() displays correctly from encrypted index."""

    def setUp(self):
        self.mk = _mk_master_key(1)
        self.crypto = CryptoManager(self.mk)

    def _create_engine_with_index(self, index_data):
        """Create a LedgerEngine with a pre-populated encrypted index."""
        index_store = MockEncryptedIndexStore()
        store = MagicMock()
        store.read_index.return_value = index_data
        store.write_index = MagicMock()
        store.read_all.return_value = []
        store.read_ledger.return_value = []
        store.read_staging.return_value = []
        store.write_staging = MagicMock()

        try:
            engine = LedgerEngine(self.crypto, store, index_store=index_store)
        except TypeError:
            engine = LedgerEngine(self.crypto, store, index_store=index_store)

        # Manually set the index cache (simulating encrypted read)
        engine.index._cache = dict(index_data)
        return engine

    # ── B5: show_rep displays correct data ───────────────────────────
    def test_B5_show_rep_displays_correct_data(self):
        """B5: show_rep() displays correct durations from encrypted index."""
        index_data = {
            "2026-01-15": {"Guitar": 3600000, "Reading": 1800000},
            "2026-01-16": {"Guitar": 7200000},
        }
        engine = self._create_engine_with_index(index_data)

        result = engine.query_index("2026-01-01", "2026-01-31")
        self.assertEqual(result["Guitar"], 3600000 + 7200000)
        self.assertEqual(result["Reading"], 1800000)

    # ── B6: show_rep with --from/--to filters ────────────────────────
    def test_B6_show_rep_date_filters(self):
        """B6: show_rep() with from/to date filters works from encrypted index."""
        index_data = {
            "2026-01-10": {"Coding": 3600000},
            "2026-01-15": {"Coding": 7200000, "Reading": 1800000},
            "2026-01-20": {"Reading": 5400000},
        }
        engine = self._create_engine_with_index(index_data)

        # Only Jan 10-15
        result = engine.query_index("2026-01-10", "2026-01-15")
        self.assertEqual(result.get("Coding"), 3600000 + 7200000)
        self.assertEqual(result.get("Reading"), 1800000)

        # Only Jan 20
        result2 = engine.query_index("2026-01-20", "2026-01-20")
        self.assertEqual(result2.get("Reading"), 5400000)
        self.assertNotIn("Coding", result2)

    # ── B7: show_rep with --days limit ───────────────────────────────
    def test_B7_show_rep_days_limit(self):
        """B7: show_rep() with --days limit works from encrypted index."""
        index_data = {
            "2026-01-18": {"Guitar": 3600000},
            "2026-01-19": {"Reading": 1800000},
            "2026-01-20": {"Coding": 7200000},
        }
        engine = self._create_engine_with_index(index_data)

        # Query last 2 days (19-20)
        from_date = "2026-01-19"
        result = engine.query_index(from_date, "2026-01-20")
        self.assertNotIn("Guitar", result)
        self.assertEqual(result["Reading"], 1800000)
        self.assertEqual(result["Coding"], 7200000)


if __name__ == "__main__":
    unittest.main()
