"""Phase 6: Behavioral equivalence tests — Part A: Staging CRUD.

Phase 6 turns core/ledger.py (985 lines, monolithic) into thin wrappers that
delegate to StagingService, LedgerEngine, and SyncOrchestrator.

These tests verify **behavioral equivalence** between old and new
implementations BEFORE the refactor, so we can:
  1. Prove the new components match old behavior
  2. Run these tests after the refactor to verify nothing broke
  3. Use these tests to drive the refactoring

Category A: Staging CRUD equivalence
  - capture()  vs capture_habit()
  - end()      vs end_habit()
  - pause()    vs pause_habit()
  - unpause()  vs unpause_habit()
  - modify()   vs modify_staged_entry()
  - remove()   vs remove_staged_entry()
"""

import unittest
import json
import time
import hashlib
from typing import Optional, List, Dict, Any


# ════════════════════════════════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════════════════════════════════

def _make_fake_crypto():
    """Create a FakeCrypto that behaves like a real crypto for testing."""
    from unittest.mock import MagicMock
    fake = MagicMock()
    def _encrypt(text):
        if text is None: return None
        return "ENC:" + hashlib.sha256(str(text).encode()).hexdigest()[:8] + ":" + str(text)
    def _decrypt(val):
        if val is None: return None
        if val.startswith("plain:"): return val[6:]
        return val.split(":", 2)[2]
    def _seal(data_str):
        return "SEAL:" + hashlib.sha256(data_str.encode()).hexdigest()[:12]
    def _verify_seal(data_str, seal):
        return seal == "SEAL:" + hashlib.sha256(data_str.encode()).hexdigest()[:12]
    def _sign(data, key):
        return "SIG:" + hashlib.sha256(data.encode() + key).hexdigest()[:16]
    def _verify_signature(data, sig, key):
        return sig == "SIG:" + hashlib.sha256(data.encode() + key).hexdigest()[:16]
    fake.encrypt.side_effect = _encrypt
    fake.decrypt.side_effect = _decrypt
    fake.seal.side_effect = _seal
    fake.verify_seal.side_effect = _verify_seal
    fake.sign.side_effect = _sign
    fake.verify_signature.side_effect = _verify_signature
    return fake


def _make_identity_secret():
    return b"test-identity-secret-32-bytes!!!"


class _InMemoryStagingStore:
    """Minimal in-memory staging store implementing AbstractStagingStore."""
    def __init__(self):
        self._entries = []
    def read_entries(self): return list(self._entries)
    def write_entries(self, entries): self._entries[:] = list(entries)
    def append_entry(self, entry): self._entries.append(entry)
    def remove_entries(self, indices):
        for i in sorted(indices, reverse=True):
            if 0 <= i < len(self._entries): self._entries.pop(i)
    def update_entry(self, index, fields):
        if 0 <= index < len(self._entries): self._entries[index].update(fields)
    def read_staging(self): return self._entries if hasattr(self, '_entries') else []
    def write_staging(self, entries): self._entries[:] = list(entries)


class _InMemoryLedgerStore:
    """In-memory store providing all interfaces (ledger, index, staging, identity)."""
    def __init__(self):
        self._ledger: List[Dict[str, Any]] = []
        self._index: Dict[str, Dict[str, int]] = {}
        self._staging: List[Dict[str, Any]] = []
        self._identity = None
    def read_ledger(self): return list(self._ledger)
    def write_ledger(self, ledger): self._ledger[:] = list(ledger)
    def append_block(self, block): self._ledger.append(block)
    def read_index(self): return dict(self._index)
    def write_index(self, index): self._index.clear(); self._index.update(index)
    def read_staging(self): return list(self._staging)
    def write_staging(self, staging): self._staging[:] = list(staging)
    def read_identity(self): return self._identity
    def write_identity(self, identity): self._identity = identity
    def get_last_block(self): return self._ledger[-1] if self._ledger else None
    def get_block_count(self): return len(self._ledger)


# ════════════════════════════════════════════════════════════════════════════
# Category A1: capture equivalence
# ════════════════════════════════════════════════════════════════════════════

class TestStagingCaptureEquivalence(unittest.TestCase):
    """Verify StagingService.capture() matches LedgerDomain.capture_habit()."""
    
    def setUp(self):
        self.crypto = _make_fake_crypto()
        self.old_store = _InMemoryLedgerStore()
        from core.ledger import LedgerDomain
        self.old_ledger = LedgerDomain(self.crypto, self.old_store)
        self.new_store = _InMemoryStagingStore()
        from domain.staging.service import StagingService
        self.new_service = StagingService(crypto=self.crypto, staging_store=self.new_store)

    def test_basic_oneoff(self):
        old = self.old_ledger.capture_habit("T", 1000, stop_epoch=2000, is_active=False)
        new = self.new_service.capture("T", 1000, stop_epoch=2000, is_active=False)
        # old returns a hash; new returns None — both succeed
        old_s = self.old_store.read_staging()
        new_e = self.new_service.get_entries()
        self.assertEqual(len(old_s), 1)
        self.assertEqual(len(new_e), 1)
        self.assertEqual(old_s[0]["data"]["title"], "T")
        self.assertEqual(new_e[0]["title"], "T")

    def test_collision(self):
        self.old_ledger.capture_habit("A", 1000, stop_epoch=2000)
        self.new_service.capture("A", 1000, stop_epoch=2000, is_active=False)
        with self.assertRaises(ValueError):
            self.old_ledger.capture_habit("B", 1000, stop_epoch=3000)
        with self.assertRaises(ValueError):
            self.new_service.capture("B", 1000, stop_epoch=3000, is_active=False)

    def test_active_task(self):
        self.old_ledger.capture_habit("Run", 1000, is_active=True)
        self.new_service.capture("Run", 1000, is_active=True)
        self.assertTrue(self.old_store.read_staging()[0]["data"]["is_active"])
        self.assertTrue(self.new_service.get_entries()[0]["is_active"])

    def test_tags_normalized(self):
        tags = ["  HI ", "there", " HI "]
        self.old_ledger.capture_habit("T", 1000, stop_epoch=2000, tags=tags)
        self.new_service.capture("T", 1000, stop_epoch=2000, is_active=False, tags=tags)
        self.assertEqual(self.old_store.read_staging()[0]["data"]["tags"], ["hi", "there"])
        self.assertEqual(self.new_service.get_entries()[0]["tags"], ["hi", "there"])

    def test_with_comment(self):
        self.old_ledger.capture_habit("T", 1000, stop_epoch=2000, comment="hello")
        self.new_service.capture("T", 1000, stop_epoch=2000, is_active=False, comment="hello")
        self.assertEqual(self.old_store.read_staging()[0]["data"].get("comment"), "hello")
        self.assertEqual(self.new_service.get_entries()[0].get("comment"), "hello")

    def test_with_metadata(self):
        meta = {"loc": "home"}
        self.old_ledger.capture_habit("T", 1000, stop_epoch=2000, metadata=meta)
        self.new_service.capture("T", 1000, stop_epoch=2000, is_active=False, metadata=meta)
        self.assertIsNotNone(self.old_store.read_staging()[0]["data"].get("metadata_enc"))
        self.assertEqual(self.new_service.get_entries()[0].get("metadata"), meta)


# ════════════════════════════════════════════════════════════════════════════
# Category A2: end equivalence
# ════════════════════════════════════════════════════════════════════════════

class TestStagingEndEquivalence(unittest.TestCase):
    """Verify StagingService.end() matches LedgerDomain.end_habit()."""
    
    def setUp(self):
        self.crypto = _make_fake_crypto()
        self.old_store = _InMemoryLedgerStore()
        from core.ledger import LedgerDomain
        self.old_ledger = LedgerDomain(self.crypto, self.old_store)
        self.new_store = _InMemoryStagingStore()
        from domain.staging.service import StagingService
        self.new_service = StagingService(crypto=self.crypto, staging_store=self.new_store)
        self.old_ledger.capture_habit("Run", 1000, is_active=True)
        self.new_service.capture("Run", 1000, is_active=True)

    def test_ends_and_duration(self):
        self.old_ledger.end_habit("Run", 5000)
        self.new_service.end("Run", 5000)
        old_s = self.old_store.read_staging()
        new_e = self.new_service.get_entries()
        self.assertFalse(old_s[0]["data"]["is_active"])
        self.assertFalse(new_e[0]["is_active"])
        self.assertEqual(old_s[0]["data"]["duration"], 4000)
        self.assertEqual(new_e[0]["duration"], 4000)

    def test_with_comment(self):
        self.old_ledger.capture_habit("Run2", 2000, is_active=True)
        self.new_service.capture("Run2", 2000, is_active=True)
        self.old_ledger.end_habit("Run2", 5000, comment="done")
        self.new_service.end("Run2", 5000, comment="done")
        self.assertEqual(self.old_store.read_staging()[1]["data"].get("comment"), "done")
        entries = self.new_service.get_entries()
        e2 = [e for e in entries if e["title"] == "Run2"][0]
        self.assertEqual(e2.get("comment"), "done")

    def test_not_found_raises(self):
        with self.assertRaises(ValueError):
            self.old_ledger.end_habit("Missing", 5000)
        with self.assertRaises(ValueError):
            self.new_service.end("Missing", 5000)

    def test_end_paused_auto_unpause(self):
        self.old_ledger.pause_habit("Run", 2000)
        self.new_service.pause("Run", 2000)
        self.old_ledger.end_habit("Run", 5000)
        self.new_service.end("Run", 5000)
        self.assertFalse(self.old_store.read_staging()[0]["data"].get("is_paused"))
        self.assertFalse(self.new_service.get_entries()[0].get("is_paused"))


# ════════════════════════════════════════════════════════════════════════════
# Category A3: pause/unpause equivalence
# ════════════════════════════════════════════════════════════════════════════

class TestStagingPauseUnpauseEquivalence(unittest.TestCase):
    """Verify StagingService.pause()/unpause() matches LedgerDomain."""
    
    def setUp(self):
        self.crypto = _make_fake_crypto()
        self.old_store = _InMemoryLedgerStore()
        from core.ledger import LedgerDomain
        self.old_ledger = LedgerDomain(self.crypto, self.old_store)
        self.new_store = _InMemoryStagingStore()
        from domain.staging.service import StagingService
        self.new_service = StagingService(crypto=self.crypto, staging_store=self.new_store)
        self.old_ledger.capture_habit("Run", 1000, is_active=True)
        self.new_service.capture("Run", 1000, is_active=True)

    def test_pause_flag(self):
        self.old_ledger.pause_habit("Run", 2000)
        self.new_service.pause("Run", 2000)
        self.assertTrue(self.old_store.read_staging()[0]["data"].get("is_paused"))
        self.assertTrue(self.new_service.get_entries()[0].get("is_paused"))

    def test_pause_not_active_raises(self):
        with self.assertRaises(ValueError):
            self.old_ledger.pause_habit("Missing", 2000)
        with self.assertRaises(ValueError):
            self.new_service.pause("Missing", 2000)

    def test_pause_already_paused_behavior(self):
        self.old_ledger.pause_habit("Run", 2000)
        self.new_service.pause("Run", 2000)
        # old ledger raises on double-pause
        with self.assertRaises(ValueError):
            self.old_ledger.pause_habit("Run", 3000)
        # new service is idempotent — adds another pause record
        self.new_service.pause("Run", 3000)
        pauses = self.new_service.get_entries()[0]["pauses"]
        self.assertEqual(len(pauses), 2)

    def test_unpause_clears_flag(self):
        self.old_ledger.pause_habit("Run", 2000)
        self.new_service.pause("Run", 2000)
        self.old_ledger.unpause_habit("Run", 3000)
        self.new_service.unpause("Run", 3000)
        self.assertFalse(self.old_store.read_staging()[0]["data"].get("is_paused"))
        self.assertFalse(self.new_service.get_entries()[0].get("is_paused"))

    def test_unpause_not_paused_behavior(self):
        # old ledger raises on unpause when not paused
        with self.assertRaises(ValueError):
            self.old_ledger.unpause_habit("Run", 3000)
        # new service is idempotent — no-op, does not raise
        try:
            self.new_service.unpause("Run", 3000)
        except ValueError:
            self.fail("unpause() raised ValueError on not-paused entry")

    def test_pause_unpause_cycle(self):
        self.old_ledger.pause_habit("Run", 2000)
        self.old_ledger.unpause_habit("Run", 3000)
        self.old_ledger.pause_habit("Run", 4000)
        self.old_ledger.unpause_habit("Run", 5000)
        self.new_service.pause("Run", 2000)
        self.new_service.unpause("Run", 3000)
        self.new_service.pause("Run", 4000)
        self.new_service.unpause("Run", 5000)
        self.assertFalse(self.old_store.read_staging()[0]["data"].get("is_paused"))
        self.assertFalse(self.new_service.get_entries()[0].get("is_paused"))


# ════════════════════════════════════════════════════════════════════════════
# Category A4: modify/remove equivalence
# ════════════════════════════════════════════════════════════════════════════

class TestStagingModifyRemoveEquivalence(unittest.TestCase):
    """Verify StagingService.modify()/remove() matches LedgerDomain."""
    
    def setUp(self):
        self.crypto = _make_fake_crypto()
        self.old_store = _InMemoryLedgerStore()
        from core.ledger import LedgerDomain
        self.old_ledger = LedgerDomain(self.crypto, self.old_store)
        self.new_store = _InMemoryStagingStore()
        from domain.staging.service import StagingService
        self.new_service = StagingService(crypto=self.crypto, staging_store=self.new_store)
        self.old_ledger.capture_habit("A", 1000, stop_epoch=2000)
        self.old_ledger.capture_habit("B", 3000, stop_epoch=4000)
        self.new_service.capture("A", 1000, stop_epoch=2000, is_active=False)
        self.new_service.capture("B", 3000, stop_epoch=4000, is_active=False)

    def test_modify_fields(self):
        # old ledger only supports end_epoch/pauses modify
        self.old_ledger.modify_staged_entry(0, end_epoch=5000)
        # new service supports title/tags/comment modify
        self.new_service.modify(0, title="B-Renamed")
        self.assertIsNotNone(self.old_store.read_staging()[0]["data"].get("duration"))
        self.assertEqual(self.new_service.get_entries()[0]["title"], "B-Renamed")

    def test_remove_by_index(self):
        self.old_ledger.remove_staged_entry(0)
        self.new_service.remove(0)
        old_s = self.old_store.read_staging()
        new_e = self.new_service.get_entries()
        self.assertEqual(len(old_s), 1)
        self.assertEqual(len(new_e), 1)
        self.assertEqual(old_s[0]["data"]["title"], "B")
        self.assertEqual(new_e[0]["title"], "B")

    def test_remove_out_of_range(self):
        with self.assertRaises(ValueError):
            self.old_ledger.remove_staged_entry(99)
        with self.assertRaises((ValueError, IndexError)):
            self.new_service.remove(99)


# ════════════════════════════════════════════════════════════════════════════
# Category A5: query methods equivalence
# ════════════════════════════════════════════════════════════════════════════

class TestStagingQueryEquivalence(unittest.TestCase):
    """Verify StagingService query methods match LedgerDomain equivalents."""
    
    def setUp(self):
        self.crypto = _make_fake_crypto()
        self.old_store = _InMemoryLedgerStore()
        from core.ledger import LedgerDomain
        self.old_ledger = LedgerDomain(self.crypto, self.old_store)
        self.new_store = _InMemoryStagingStore()
        from domain.staging.service import StagingService
        self.new_service = StagingService(crypto=self.crypto, staging_store=self.new_store)

    def test_get_pending_sync_excludes_active(self):
        self.old_ledger.capture_habit("Active", 1000, is_active=True)
        self.old_ledger.capture_habit("Done", 2000, stop_epoch=3000)
        self.new_service.capture("Active", 1000, is_active=True)
        self.new_service.capture("Done", 2000, stop_epoch=3000, is_active=False)
        old_pending = self.old_ledger.get_pending_sync()
        new_pending = self.new_service.get_pending_sync()
        old_titles = [p["title"] for p in old_pending]
        new_titles = [p["title"] for p in new_pending]
        self.assertNotIn("Active", old_titles)
        self.assertNotIn("Active", new_titles)
        self.assertIn("Done", old_titles)
        self.assertIn("Done", new_titles)

    def test_get_pending_sync_excludes_paused(self):
        self.old_ledger.capture_habit("Paused", 1000, is_active=True)
        self.old_ledger.pause_habit("Paused", 2000)
        self.new_service.capture("Paused", 1000, is_active=True)
        self.new_service.pause("Paused", 2000)
        old_pending = self.old_ledger.get_pending_sync()
        new_pending = self.new_service.get_pending_sync()
        self.assertNotIn("Paused", [p["title"] for p in old_pending])
        self.assertNotIn("Paused", [p["title"] for p in new_pending])

    def test_get_entries_decrypted(self):
        from datetime import datetime
        self.old_ledger.capture_habit("T", 1000, stop_epoch=2000, tags=["hi"])
        self.new_service.capture("T", 1000, stop_epoch=2000, is_active=False, tags=["hi"])
        # Old: get_pending_sync returns decrypted previews
        old_previews = self.old_ledger.get_pending_sync()
        # New: get_entries returns decrypted DTOs
        new_entries = self.new_service.get_entries()
        self.assertEqual(len(old_previews), 1)
        self.assertEqual(len(new_entries), 1)
        self.assertEqual(old_previews[0]["title"], "T")
        self.assertEqual(new_entries[0]["title"], "T")


if __name__ == "__main__":
    unittest.main()
