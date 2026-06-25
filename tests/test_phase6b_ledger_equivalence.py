"""Phase 6: Behavioral equivalence tests — Part B: Ledger sync + revert.

Category B: Ledger sync/revert/verify equivalence
  - LedgerEngine.commit() vs LedgerDomain.sync_day()
  - LedgerEngine.verify() vs LedgerDomain.verify()
  - LedgerEngine.revert() vs LedgerDomain.revert_entries()
  - Content hash consistency
  - Chain structural equivalence (day blocks, summaries)
"""

import unittest
import json
import time
import hashlib
from typing import Optional, List, Dict, Any


# ════════════════════════════════════════════════════════════════════════════
# Helpers (reused from part a — self-contained)
# ════════════════════════════════════════════════════════════════════════════

def _make_fake_crypto():
    from unittest.mock import MagicMock
    fake = MagicMock()
    def _enc(text):
        if text is None: return None
        return "ENC:" + hashlib.sha256(str(text).encode()).hexdigest()[:8] + ":" + str(text)
    def _dec(val):
        if val is None: return None
        if val.startswith("plain:"): return val[6:]
        return val.split(":", 2)[2]
    def _seal(data_str):
        return "SEAL:" + hashlib.sha256(data_str.encode()).hexdigest()[:12]
    def _vseal(d, s): return s == "SEAL:" + hashlib.sha256(d.encode()).hexdigest()[:12]
    def _sign(data, key):
        return "SIG:" + hashlib.sha256(data.encode() + key).hexdigest()[:16]
    def _vsig(d, s, k): return s == "SIG:" + hashlib.sha256(d.encode() + k).hexdigest()[:16]
    fake.encrypt.side_effect = _enc
    fake.decrypt.side_effect = _dec
    fake.seal.side_effect = _seal
    fake.verify_seal.side_effect = _vseal
    fake.sign.side_effect = _sign
    fake.verify_signature.side_effect = _vsig
    return fake


def _make_identity_secret():
    return b"test-identity-secret-32-bytes!!!"


class _InMemoryLedgerStore:
    """In-memory store with ledger, index, staging, identity."""
    def __init__(self):
        self._ledger: List[Dict[str, Any]] = []
        self._index: Dict = {}
        self._staging: List[Dict[str, Any]] = []
        self._identity = None
    def read_ledger(self): return list(self._ledger)
    def write_ledger(self, ledger): self._ledger[:] = list(ledger)
    def read_index(self): return dict(self._index)
    def write_index(self, index): self._index.clear(); self._index.update(index)
    def read_staging(self): return list(self._staging)
    def write_staging(self, staging): self._staging[:] = list(staging)
    def read_identity(self): return self._identity
    def write_identity(self, i): self._identity = i
    def get_last_block(self): return self._ledger[-1] if self._ledger else None
    def get_block_count(self): return len(self._ledger)


def _add_genesis(store, crypto=None, secret=None):
    """Seed a store with a genesis block. Returns (crypto, identity_secret)."""
    if crypto is None: crypto = _make_fake_crypto()
    if secret is None: secret = _make_identity_secret()
    genesis = {"type": "genesis", "created_at": 1700000000000, "format_version": "0.4.0"}
    genesis["day_hash"] = crypto.seal(json.dumps(genesis, sort_keys=True))
    genesis["signature"] = crypto.sign(genesis["day_hash"], secret)
    store.write_ledger([genesis])
    return crypto, secret


def _sync_day_old(ledger_domain, store, crypto, entries):
    """Helper: add encrypted staging entries to a store and sync via old path."""
    staging = []
    for e in entries:
        data = {
            "title": e["title"],
            "startTime_enc": crypto.encrypt(str(e["start_epoch"])),
            "endTime_enc": crypto.encrypt(str(e["end_epoch"])),
            "duration": e["end_epoch"] - e["start_epoch"],
            "is_active": False,
            "is_paused": False,
            "metadata_enc": crypto.encrypt(json.dumps(e.get("metadata", {}))),
            "pauses_enc": crypto.encrypt(json.dumps(e.get("pauses", []))),
            "tags": e.get("tags", []),
            "media": e.get("media", []),
        }
        h = hashlib.sha256(json.dumps(data, sort_keys=True, indent=2).encode()).hexdigest()
        staging.append({"hash": h, "data": data, "start_epoch": e["start_epoch"]})
    store.write_staging(staging)
    return ledger_domain.sync_day()


# ════════════════════════════════════════════════════════════════════════════
# Category B1: sync equivalence
# ════════════════════════════════════════════════════════════════════════════

class TestLedgerSyncEquivalence(unittest.TestCase):
    """Verify LedgerEngine.commit() produces same chain structure as sync_day()."""

    def setUp(self):
        self.crypto = _make_fake_crypto()
        self.secret = _make_identity_secret()

        # Old setup
        self.old_store = _InMemoryLedgerStore()
        _add_genesis(self.old_store, self.crypto, self.secret)
        from core.ledger import LedgerDomain
        self.old_ledger = LedgerDomain(self.crypto, self.old_store)

        # New setup
        self.new_store = _InMemoryLedgerStore()
        _add_genesis(self.new_store, self.crypto, self.secret)
        from domain.ledger.engine import LedgerEngine
        self.new_engine = LedgerEngine(
            crypto=self.crypto, store=self.new_store,
            identity_secret=self.secret,
        )

    def test_basic_same_date(self):
        """Both produce same number of blocks for entries on the same date."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
            {"title": "B", "start_epoch": 3000000, "end_epoch": 4000000},
        ])
        self.new_engine.commit([
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": [], "is_active": False, "is_paused": False},
            {"title": "B", "start_epoch": 3000000, "end_epoch": 4000000,
             "duration": 1000000, "tags": [], "is_active": False, "is_paused": False},
        ])
        old_blocks = [b for b in self.old_store.read_ledger()
                      if b.get("type", "day") == "day"]
        new_blocks = [b for b in self.new_store.read_ledger()
                      if b.get("type", "day") == "day"]
        self.assertEqual(len(old_blocks), 1)
        self.assertEqual(len(new_blocks), 1)

    def test_verify_passes(self):
        """Both produce fully verifiable chains."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        self.new_engine.commit([
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": [], "is_active": False, "is_paused": False},
        ])
        self.assertTrue(self.old_ledger.verify())
        self.assertTrue(self.new_engine.verify())

    def test_multiple_dates(self):
        """Both handle entries across different dates."""
        start_jan = int(time.mktime(time.strptime("2026-01-15", "%Y-%m-%d"))) * 1000
        start_feb = int(time.mktime(time.strptime("2026-02-01", "%Y-%m-%d"))) * 1000
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "Jan A", "start_epoch": start_jan, "end_epoch": start_jan + 3600000},
        ])
        self.new_engine.commit([
            {"title": "Jan A", "start_epoch": start_jan, "end_epoch": start_jan + 3600000,
             "duration": 3600000, "tags": [], "is_active": False, "is_paused": False},
        ])
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "Feb B", "start_epoch": start_feb, "end_epoch": start_feb + 3600000},
        ])
        self.new_engine.commit([
            {"title": "Feb B", "start_epoch": start_feb, "end_epoch": start_feb + 3600000,
             "duration": 3600000, "tags": [], "is_active": False, "is_paused": False},
        ])
        old_days = [b for b in self.old_store.read_ledger()
                    if b.get("type", "day") == "day"]
        new_days = [b for b in self.new_store.read_ledger()
                    if b.get("type", "day") == "day"]
        self.assertEqual(len(old_days), 2)
        self.assertEqual(len(new_days), 2)

    def test_verify_after_multiple_syncs(self):
        """Chain remains verifiable after multiple sync rounds."""
        for t in range(3):
            start = int(time.mktime(time.strptime(f"2026-01-{15+t:02d}", "%Y-%m-%d"))) * 1000
            _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
                {"title": f"Day{t}", "start_epoch": start, "end_epoch": start + 3600000},
            ])
            self.new_engine.commit([
                {"title": f"Day{t}", "start_epoch": start, "end_epoch": start + 3600000,
                 "duration": 3600000, "tags": [], "is_active": False, "is_paused": False},
            ])
        self.assertTrue(self.old_ledger.verify())
        self.assertTrue(self.new_engine.verify())

    def test_day_block_structure(self):
        """Day block structure matches between old and new."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        self.new_engine.commit([
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": ["x"], "is_active": False, "is_paused": False},
        ])
        old_day = self.old_store.read_ledger()[1]
        new_day = self.new_store.read_ledger()[1]
        self.assertEqual(old_day.get("type"), "day")
        self.assertEqual(new_day.get("type"), "day")
        self.assertIn("day_index", old_day)
        self.assertIn("day_index", new_day)
        self.assertIn("date", old_day)
        self.assertIn("date", new_day)
        self.assertIn("prev_hash", old_day)
        self.assertIn("prev_hash", new_day)
        self.assertIn("day_hash", old_day)
        self.assertIn("day_hash", new_day)
        self.assertIn("entries", old_day)
        self.assertIn("entries", new_day)
        self.assertEqual(len(old_day["entries"]), 1)
        self.assertEqual(len(new_day["entries"]), 1)

    def test_no_entries_returns_none(self):
        """Both return None when no entries to sync."""
        old = self.old_ledger.sync_day()
        new = self.new_engine.commit([])
        self.assertIsNone(old)
        self.assertIsNone(new)


# ════════════════════════════════════════════════════════════════════════════
# Category B2: revert equivalence
# ════════════════════════════════════════════════════════════════════════════

class TestLedgerRevertEquivalence(unittest.TestCase):
    """Verify LedgerEngine.revert() matches LedgerDomain.revert_entries()."""

    def setUp(self):
        self.crypto = _make_fake_crypto()
        self.secret = _make_identity_secret()

        self.old_store = _InMemoryLedgerStore()
        _add_genesis(self.old_store, self.crypto, self.secret)
        from core.ledger import LedgerDomain
        self.old_ledger = LedgerDomain(self.crypto, self.old_store)

        self.new_store = _InMemoryLedgerStore()
        _add_genesis(self.new_store, self.crypto, self.secret)
        from domain.ledger.engine import LedgerEngine
        self.new_engine = LedgerEngine(
            crypto=self.crypto, store=self.new_store,
            identity_secret=self.secret,
            staging_store=self.new_store,  # uses in-memory store's staging
        )

    def test_revert_empty(self):
        """Reverting 0 entries is a no-op."""
        self.assertEqual(self.old_ledger.revert_entries(0), 0)
        self.assertEqual(self.new_engine.revert(0), 0)

    def test_revert_single_block(self):
        """Both revert the most recent day block."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "X", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        self.new_engine.commit([
            {"title": "X", "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": [], "is_active": False, "is_paused": False},
        ])
        old_r = self.old_ledger.revert_entries(1)
        new_r = self.new_engine.revert(1)
        self.assertEqual(old_r, 1)
        self.assertEqual(new_r, 1)

    def test_revert_too_many(self):
        """Both return -1 when reverting more blocks than available."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "X", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        self.new_engine.commit([
            {"title": "X", "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": [], "is_active": False, "is_paused": False},
        ])
        self.assertEqual(self.old_ledger.revert_entries(99), -1)
        self.assertEqual(self.new_engine.revert(99), -1)

    def test_verify_after_revert(self):
        """Chain remains verifiable after revert."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        self.new_engine.commit([
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": [], "is_active": False, "is_paused": False},
        ])
        self.old_ledger.revert_entries(1)
        self.new_engine.revert(1)
        self.assertTrue(self.old_ledger.verify())
        self.assertTrue(self.new_engine.verify())

    def test_revert_restored_to_staging(self):
        """Reverted entries appear in staging."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "Restored", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        self.new_engine.commit([
            {"title": "Restored", "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": [], "is_active": False, "is_paused": False},
        ])
        # Old: staging returned entries
        old_r = self.old_ledger.revert_entries(1)
        self.assertEqual(old_r, 1)
        old_staging = self.old_store.read_staging()
        old_titles = [e["data"]["title"] for e in old_staging]
        self.assertIn("Restored", old_titles)

        # New: staging_store should have the entry
        new_r = self.new_engine.revert(1)
        self.assertEqual(new_r, 1)
        new_staging = self.new_store.read_staging()
        new_titles = [e["data"]["title"] for e in new_staging]
        self.assertIn("Restored", new_titles)


# ════════════════════════════════════════════════════════════════════════════
# Category B3: verify equivalence
# ════════════════════════════════════════════════════════════════════════════

class TestLedgerVerifyEquivalence(unittest.TestCase):
    """Verify LedgerEngine.verify() matches LedgerDomain.verify()."""

    def setUp(self):
        self.crypto = _make_fake_crypto()
        self.secret = _make_identity_secret()

        self.store = _InMemoryLedgerStore()
        _add_genesis(self.store, self.crypto, self.secret)
        from core.ledger import LedgerDomain
        self.old_ledger = LedgerDomain(self.crypto, self.store)

    def test_verify_valid_chain(self):
        """A clean chain passes verify."""
        _sync_day_old(self.old_ledger, self.store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        self.assertTrue(self.old_ledger.verify())

    def test_verify_tampered_block(self):
        """A tampered block fails verify."""
        _sync_day_old(self.old_ledger, self.store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        ledger = self.store.read_ledger()
        ledger[1]["entries"][0]["data"]["title"] = "Tampered"
        self.store.write_ledger(ledger)
        self.assertFalse(self.old_ledger.verify())

    def test_verify_broken_chain(self):
        """A broken prev_hash link fails verify."""
        _sync_day_old(self.old_ledger, self.store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        ledger = self.store.read_ledger()
        ledger[1]["prev_hash"] = "badhash"
        self.store.write_ledger(ledger)
        self.assertFalse(self.old_ledger.verify())

    def test_new_engine_verify_matches(self):
        """LedgerEngine built on same data returns same verify result."""
        from domain.ledger.engine import LedgerEngine
        eng = LedgerEngine(crypto=self.crypto, store=self.store,
                           identity_secret=self.secret)
        # Clean chain
        _sync_day_old(self.old_ledger, self.store, self.crypto, [
            {"title": "B", "start_epoch": 3000000, "end_epoch": 4000000},
        ])
        self.assertEqual(self.old_ledger.verify(), eng.verify())

    def test_verify_tampered_new_engine(self):
        """LedgerEngine detects same tampering as old."""
        _sync_day_old(self.old_ledger, self.store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        ledger = self.store.read_ledger()
        ledger[1]["entries"][0]["data"]["title"] = "Bad"
        self.store.write_ledger(ledger)
        from domain.ledger.engine import LedgerEngine
        eng = LedgerEngine(crypto=self.crypto, store=self.store,
                           identity_secret=self.secret)
        self.assertFalse(self.old_ledger.verify())
        self.assertFalse(eng.verify())


# ════════════════════════════════════════════════════════════════════════════
# Category B4: index consistency
# ════════════════════════════════════════════════════════════════════════════

class TestLedgerIndexConsistency(unittest.TestCase):
    """Verify index is correctly maintained after sync and revert."""

    def setUp(self):
        self.crypto = _make_fake_crypto()
        self.secret = _make_identity_secret()

        self.old_store = _InMemoryLedgerStore()
        _add_genesis(self.old_store, self.crypto, self.secret)
        from core.ledger import LedgerDomain
        self.old_ledger = LedgerDomain(self.crypto, self.old_store)

        self.new_store = _InMemoryLedgerStore()
        _add_genesis(self.new_store, self.crypto, self.secret)
        from domain.ledger.engine import LedgerEngine
        self.new_engine = LedgerEngine(
            crypto=self.crypto, store=self.new_store,
            identity_secret=self.secret,
            staging_store=self.new_store,
        )

    def test_index_populated_after_sync(self):
        """Both populate the index after syncing."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        self.new_engine.commit([
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": [], "is_active": False, "is_paused": False},
        ])
        old_idx = self.old_store.read_index()
        new_idx = self.new_store.read_index()
        # Check index has the date entry
        old_has_date = any("1970-01-01" in str(v) for v in old_idx.values())
        new_has_date = any("1970-01-01" in str(v) for v in new_idx.values())
        # Both should have non-empty index
        self.assertTrue(len(old_idx) > 0 or old_has_date)
        self.assertTrue(len(new_idx) > 0 or new_has_date)

    def test_index_cleaned_after_revert(self):
        """Index is updated after revert (old path)."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        idx_before = self.old_store.read_index()
        self.old_ledger.revert_entries(1)
        idx_after = self.old_store.read_index()
        # Index should be cleaned up after reverting all entries
        self.assertNotEqual(len(idx_before), len(idx_after))

    def test_get_block_count(self):
        """Both return the same block count."""
        _sync_day_old(self.old_ledger, self.old_store, self.crypto, [
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000},
        ])
        self.new_engine.commit([
            {"title": "A", "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": [], "is_active": False, "is_paused": False},
        ])
        # Old: count from reading ledger
        old_count = len(self.old_store.read_ledger())
        new_count = self.new_engine.get_block_count()
        self.assertEqual(old_count, new_count)


if __name__ == "__main__":
    unittest.main()
