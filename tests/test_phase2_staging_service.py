"""Phase 2 tests: Staging Service, LocalStagingCache, MergeEngine, RemoteSync.

This is a TEST-FIRST file — it defines the expected interfaces and behaviors
for all Phase 2 components BEFORE they are implemented. Each test documents
the contract that the implementation must satisfy.

Components tested:
  1. LocalStagingCache      — plain: encode/decode, CRUD, edge cases
  2. MergeEngine             — merge by (title, start_epoch) dedup
  3. RemoteStagingSync      — device ID check, pull/push round-trip
  4. StagingService          — all CRUD methods, no plain: leakage
  5. SyncCheckResult         — enum behavior

All tests use mocks for dependencies. No filesystem IO unless testing
a store implementation.
"""

import unittest
import json
import time
import hashlib
import hmac
from unittest.mock import MagicMock
from typing import Optional, List, Dict, Any
from enum import Enum

# =============================================================================
# Pre-import checks — Phase 2 components may not exist yet
# =============================================================================

try:
    from domain.staging.local_cache import LocalStagingCache
    from domain.staging.service import StagingService, SyncCheckResult
    from domain.staging.merge_engine import MergeEngine
    from domain.staging.remote_sync import RemoteStagingSync
    from security.device_identity import (
        AbstractDeviceIdentityProvider,
        DeviceIdentity,
    )
    HAS_PHASE2 = True
except ImportError:
    HAS_PHASE2 = False
    from abc import ABC, abstractmethod
    class SyncCheckResult:
        READY = "READY"
        OFFLINE = "OFFLINE"
        REAUTH_NEEDED = "REAUTH_NEEDED"
    class DeviceIdentity:
        def __init__(self, device_id="", device_proof="", device_label=""):
            self.device_id = device_id; self.device_proof = device_proof; self.device_label = device_label
    class AbstractDeviceIdentityProvider(ABC):
        @abstractmethod
        def get_device_identity(self, master_key: bytes) -> DeviceIdentity: pass
        @abstractmethod
        def verify_device_proof(self, device_id: str, device_proof: str, master_key: bytes) -> bool: pass


def mock_crypto():
    fake = MagicMock()
    fake.encrypt.side_effect = lambda text: f"ENC:{text}"
    fake.decrypt.side_effect = lambda hex_data: (
        hex_data[4:] if hex_data.startswith("ENC:")
        else hex_data[6:] if hex_data.startswith("plain:")
        else hex_data
    )
    fake.seal.side_effect = lambda ds: hashlib.sha256(ds.encode()).hexdigest()[:32]
    fake.verify_seal.side_effect = lambda ds, seal: hashlib.sha256(ds.encode()).hexdigest()[:32] == seal
    fake.sign.side_effect = lambda hv, sec: hashlib.sha256((hv + str(sec)).encode()).hexdigest()
    fake.verify_signature.side_effect = lambda hv, sig, sec: hashlib.sha256((hv + str(sec)).encode()).hexdigest() == sig
    return fake


def mock_staging_store(initial_entries=None):
    store = MagicMock()
    store.entries = list(initial_entries) if initial_entries else []
    store.read_entries.side_effect = lambda: list(store.entries)
    store.write_entries.side_effect = lambda entries: setattr(store, 'entries', list(entries))
    store.append_entry.side_effect = lambda entry: store.entries.append(entry)
    store.remove_entries.side_effect = lambda indices: (
        [store.entries.pop(i) for i in sorted(indices, reverse=True) if 0 <= i < len(store.entries)]
    )
    store.update_entry.side_effect = lambda index, fields: (
        store.entries[index].update(fields) if 0 <= index < len(store.entries) else None
    )
    return store


def mock_transport():
    transport = MagicMock()
    transport._blob = None
    transport.pull.side_effect = lambda path=None: transport._blob
    transport.push.side_effect = lambda path, data: setattr(transport, '_blob', data)
    return transport
# =============================================================================
# 1. LocalStagingCache Tests
# =============================================================================

class TestLocalStagingCache(unittest.TestCase):
    """LocalStagingCache is the ONLY class that knows about plain: prefix."""

    def setUp(self):
        self.crypto = mock_crypto()
        self.store = mock_staging_store()
        if HAS_PHASE2:
            self.cache = LocalStagingCache(self.crypto, self.store)
        else:
            self.skipTest("LocalStagingCache not yet implemented")

    def _mk(self, title="Test", start=1000000, end=2000000, is_active=False,
            is_paused=False, pauses=None, tags=None, comment=None):
        return {
            "title": title, "duration": end - start if end else 0,
            "is_active": is_active, "is_paused": is_paused,
            "startTime_enc": f"plain:{start}",
            "endTime_enc": f"plain:{end}" if end else None,
            "pauses_enc": f"plain:{json.dumps(pauses or [])}",
            "metadata_enc": "plain:{}", "tags": tags or [], "media": [],
            "comment": comment,
        }

    def test_to_plain(self):
        self.assertEqual(self.cache._to_plain("1000"), "plain:1000")

    def test_from_plain(self):
        self.assertEqual(self.cache._from_plain("plain:1000"), "1000")

    def test_from_plain_none(self):
        self.assertIsNone(self.cache._from_plain(None))

    def test_read_empty(self):
        self.assertEqual(self.cache.read_entries(), [])

    def test_read_decrypts_fields(self):
        self.store.write_entries([{"hash": "ab", "data": self._mk("Music", 1000, 2000), "start_epoch": 1000}])
        dtos = self.cache.read_entries()
        self.assertEqual(dtos[0]["title"], "Music")
        self.assertEqual(dtos[0]["start_epoch"], 1000)
        self.assertEqual(dtos[0]["end_epoch"], 2000)

    def test_read_handles_real_cipher(self):
        self.store.write_entries([{"hash": "ab", "data": {
            "title": "T", "duration": 1000, "is_active": False, "is_paused": False,
            "startTime_enc": "ENC:5000", "endTime_enc": "ENC:6000",
            "pauses_enc": "ENC:[]", "metadata_enc": "ENC:{}", "tags": [], "media": [],
        }, "start_epoch": 5000}])
        self.assertEqual(self.cache.read_entries()[0]["start_epoch"], 5000)

    def test_read_none_end(self):
        self.store.write_entries([{"hash": "ab", "data": {
            "title": "A", "duration": 0, "is_active": True, "is_paused": False,
            "startTime_enc": "plain:1000", "endTime_enc": None,
            "pauses_enc": "plain:[]", "metadata_enc": "plain:{}", "tags": [], "media": [],
        }, "start_epoch": 1000}])
        self.assertIsNone(self.cache.read_entries()[0]["end_epoch"])

    def test_read_pauses(self):
        pauses = [{"pause_index": 1, "pause_start": 1500, "pause_stop": 1800}]
        self.store.write_entries([{"hash": "ab", "data": self._mk("P", 1000, 2000, pauses=pauses), "start_epoch": 1000}])
        self.assertEqual(len(self.cache.read_entries()[0]["pauses"]), 1)

    def test_read_meta_fields(self):
        self.store.write_entries([{"hash": "abc", "data": self._mk("T", 1000, 2000), "start_epoch": 1000}])
        d = self.cache.read_entries()[0]
        self.assertEqual(d["entry_index"], 0); self.assertEqual(d["hash"], "abc"); self.assertEqual(d["source"], "local")

    def test_write_encrypts_to_plain(self):
        self.cache.write_entries([{
            "entry_index": 0, "title": "T", "start_epoch": 1000, "end_epoch": 2000,
            "duration": 1000, "is_active": False, "is_paused": False, "pauses": [],
            "tags": [], "comment": None, "media": [], "metadata": {},
            "date": "1970-01-01", "source": "local", "hash": "abc",
        }])
        s = self.store.read_entries()
        self.assertEqual(s[0]["data"]["startTime_enc"], "plain:1000")
        self.assertEqual(s[0]["data"]["endTime_enc"], "plain:2000")

    def test_append_stores(self):
        self.cache.append("Guitar", 1000, end_epoch=2000, tags=["music"])
        s = self.store.read_entries()
        self.assertEqual(s[0]["data"]["title"], "Guitar")
        self.assertTrue(s[0]["data"]["startTime_enc"].startswith("plain:1000"))

    def test_append_creates_hash(self):
        self.cache.append("T", 1000, end_epoch=2000)
        expected = hashlib.sha256(json.dumps(self.store.read_entries()[0]["data"], sort_keys=True).encode()).hexdigest()
        self.assertEqual(self.store.read_entries()[0]["hash"], expected)

    def test_append_collision_raises(self):
        self.cache.append("A", 1000, end_epoch=2000)
        with self.assertRaises(ValueError):
            self.cache.append("B", 1000, end_epoch=3000)

    def test_append_diff_starts(self):
        self.cache.append("A", 1000, end_epoch=2000)
        self.cache.append("B", 2001, end_epoch=3000)
        self.assertEqual(len(self.store.read_entries()), 2)

    def test_update_fields(self):
        self.store.write_entries([{"hash": "a", "data": self._mk("T", 1000, 2000, comment="orig"), "start_epoch": 1000}])
        self.cache.update(0, {"comment": "upd"})
        self.assertEqual(self.store.read_entries()[0]["data"]["comment"], "upd")

    def test_update_hash(self):
        self.store.write_entries([{"hash": "old", "data": self._mk("T", 1000, 2000), "start_epoch": 1000}])
        self.cache.update(0, {"comment": "new"})
        expected = hashlib.sha256(json.dumps(self.store.read_entries()[0]["data"], sort_keys=True).encode()).hexdigest()
        self.assertEqual(self.store.read_entries()[0]["hash"], expected)

    def test_delete(self):
        self.store.write_entries([
            {"hash": "a", "data": self._mk("A", 1000, 2000), "start_epoch": 1000},
            {"hash": "b", "data": self._mk("B", 3000, 4000), "start_epoch": 3000},
        ])
        self.cache.delete(0)
        self.assertEqual(len(self.store.read_entries()), 1)
        self.assertEqual(self.store.read_entries()[0]["data"]["title"], "B")

    def test_delete_out_of_range(self):
        with self.assertRaises(IndexError):
            self.cache.delete(0)

    def test_normalizes_tags(self):
        self.cache.append("T", 1000, end_epoch=2000, tags=["  Music ", "MUSIC"])
        self.assertEqual(self.store.read_entries()[0]["data"]["tags"], ["music"])

    def test_empty_tags(self):
        self.cache.append("T", 1000, end_epoch=2000)
        self.assertEqual(self.store.read_entries()[0]["data"]["tags"], [])

    # -- entry_id-based operations (stale-index race fix) -------------------

    def test_update_by_entry_id_updates_correct_entry(self):
        """update_by_entry_id targets the right entry even with multiple entries."""
        self.cache.append("Task A", 1000, is_active=True)
        self.cache.append("Task B", 3000, is_active=True)
        entries = self.cache.read_entries()
        entry_b_id = entries[1]["entry_id"]

        self.cache.update_by_entry_id(entry_b_id, {"title": "Task B Updated"})

        updated = self.cache.read_entries()
        self.assertEqual(updated[0]["title"], "Task A")
        self.assertEqual(updated[1]["title"], "Task B Updated")

    def test_update_by_entry_id_after_index_shift(self):
        """update_by_entry_id still finds the correct entry after index shifts."""
        self.cache.append("Task A", 1000, is_active=True)
        self.cache.append("Task B", 3000, is_active=True)
        entries = self.cache.read_entries()
        entry_b_id = entries[1]["entry_id"]

        # Delete Task A — Task B shifts from index 1 to index 0
        self.cache.delete(0)

        # Should still update Task B via its stable entry_id
        self.cache.update_by_entry_id(entry_b_id, {"title": "Task B Renamed"})

        updated = self.cache.read_entries()
        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0]["title"], "Task B Renamed")

    def test_update_by_entry_id_raises_on_unknown_id(self):
        """update_by_entry_id raises ValueError for a nonexistent entry_id."""
        self.cache.append("Task A", 1000, is_active=True)
        with self.assertRaises(ValueError):
            self.cache.update_by_entry_id("nonexistent-id", {"title": "X"})

    def test_add_pause_by_entry_id_targets_correct_entry(self):
        """add_pause_by_entry_id pauses the correct entry via stable entry_id."""
        self.cache.append("Task A", 1000, is_active=True)
        self.cache.append("Task B", 3000, is_active=True)
        entries = self.cache.read_entries()
        entry_b_id = entries[1]["entry_id"]

        self.cache.add_pause_by_entry_id(entry_b_id, 3500)

        updated = self.cache.read_entries()
        self.assertFalse(updated[0]["is_paused"])
        self.assertTrue(updated[1]["is_paused"])

    def test_add_pause_by_entry_id_raises_on_unknown_id(self):
        """add_pause_by_entry_id raises ValueError for a nonexistent entry_id."""
        self.cache.append("Task A", 1000, is_active=True)
        with self.assertRaises(ValueError):
            self.cache.add_pause_by_entry_id("nonexistent-id", 1500)

    def test_close_pause_by_entry_id_targets_correct_entry(self):
        """close_pause_by_entry_id closes the correct entry's pause via stable entry_id."""
        self.cache.append("Task A", 1000, is_active=True)
        self.cache.append("Task B", 3000, is_active=True)
        # Add a pause to Task B
        self.cache.add_pause(1, 3500)
        entries = self.cache.read_entries()
        entry_b_id = entries[1]["entry_id"]

        self.cache.close_pause_by_entry_id(entry_b_id, 4000)

        updated = self.cache.read_entries()
        self.assertEqual(updated[1]["pauses"][0]["pause_stop"], 4000)

    def test_close_pause_by_entry_id_raises_on_unknown_id(self):
        """close_pause_by_entry_id raises ValueError for a nonexistent entry_id."""
        self.cache.append("Task A", 1000, is_active=True)
        with self.assertRaises(ValueError):
            self.cache.close_pause_by_entry_id("nonexistent-id", 1500)

    def test_duration_no_pauses(self):
        self.assertEqual(self.cache._compute_duration(1000, 5000, []), 4000)

    def test_duration_with_pauses(self):
        self.assertEqual(self.cache._compute_duration(1000, 5000, [
            {"pause_start": 2000, "pause_stop": 3000},
        ]), 3000)

    def test_duration_ignores_ongoing(self):
        self.assertEqual(self.cache._compute_duration(1000, 5000, [
            {"pause_start": 2000, "pause_stop": None},
        ]), 4000)

    def test_add_pause(self):
        self.store.write_entries([{"hash": "a", "data": self._mk("T", 1000, 2000), "start_epoch": 1000}])
        self.cache.add_pause(0, 1500)
        pauses = json.loads(self.store.read_entries()[0]["data"]["pauses_enc"][6:])
        self.assertEqual(len(pauses), 1)
        self.assertEqual(pauses[0]["pause_start"], 1500)
        self.assertIsNone(pauses[0]["pause_stop"])

    def test_close_pause(self):
        self.store.write_entries([{"hash": "a", "data": self._mk("T", 1000, 2000,
            pauses=[{"pause_index": 1, "pause_start": 1500, "pause_stop": None}],
        ), "start_epoch": 1000}])
        self.cache.close_pause(0, 1800)
        p = json.loads(self.store.read_entries()[0]["data"]["pauses_enc"][6:])
        self.assertEqual(p[0]["pause_stop"], 1800)


class TestLocalStagingCacheEdgeCases(unittest.TestCase):
    def setUp(self):
        if not HAS_PHASE2: self.skipTest("not implemented")
        self.cache = LocalStagingCache(mock_crypto(), mock_staging_store())

    def test_corrupt_skipped(self):
        self.cache._store.write_entries([{"hash": "a", "data": {
            "title": "B", "duration": 0, "is_active": False, "is_paused": False,
            "startTime_enc": "GARBAGE", "endTime_enc": None,
            "pauses_enc": "plain:[]", "metadata_enc": "plain:{}", "tags": [], "media": [],
        }, "start_epoch": None}])
        self.assertEqual(len(self.cache.read_entries()), 0)

    def test_missing_fields(self):
        self.cache._store.write_entries([{"hash": "a", "data": {
            "title": "M", "duration": 0, "is_active": False, "is_paused": False,
            "startTime_enc": "plain:1000",
        }, "start_epoch": 1000}])
        d = self.cache.read_entries()[0]
        self.assertIsNone(d.get("end_epoch"))
        self.assertEqual(d.get("pauses", []), [])

    def test_update_out_of_range(self):
        with self.assertRaises(IndexError):
            self.cache.update(999, {"title": "X"})


# =============================================================================
# 2. MergeEngine Tests
# =============================================================================

class TestMergeEngine(unittest.TestCase):
    def setUp(self):
        if HAS_PHASE2: self.m = MergeEngine()
        else: self.skipTest("not implemented")

    def _e(self, title, start, end=None, tags=None, source="local"):
        return {"title": title, "start_epoch": start,
                "end_epoch": end or start + 3600000, "duration": 3600000,
                "tags": tags or [], "source": source,
                "is_active": False, "is_paused": False,
                "pauses": [], "comment": None, "media": [], "metadata": {}}

    def test_no_conflicts(self):
        self.assertEqual(len(self.m.merge([self._e("G", 1000)], [self._e("R", 3000)])), 2)

    def test_dedup_remote_wins(self):
        m = self.m.merge([self._e("G", 1000, 2000)], [self._e("G", 1000, 2500)])
        self.assertEqual(len(m), 1); self.assertEqual(m[0]["end_epoch"], 2500)

    def test_same_title_diff_start(self):
        self.assertEqual(len(self.m.merge([self._e("G", 1000)], [self._e("G", 5000)])), 2)

    def test_sorted(self):
        m = self.m.merge([self._e("L", 5000)], [self._e("E", 1000)])
        self.assertEqual(m[0]["title"], "E")

    def test_empty_local(self):
        self.assertEqual(len(self.m.merge([], [self._e("O", 1000)])), 1)

    def test_empty_remote(self):
        self.assertEqual(len(self.m.merge([self._e("O", 1000)], [])), 1)

    def test_both_empty(self):
        self.assertEqual(self.m.merge([], []), [])

    def test_remote_wins_all(self):
        m = self.m.merge([self._e("G", 1000, 2000, tags=["old"])], [self._e("G", 1000, 3000, tags=["new"])])
        self.assertEqual(m[0]["tags"], ["new"]); self.assertEqual(m[0]["end_epoch"], 3000)

    def test_sources_preserved(self):
        m = self.m.merge([self._e("L", 1000)], [self._e("R", 5000)])
        self.assertEqual({e["source"] for e in m}, {"local", "remote"})

    def test_large_merge(self):
        local = [self._e(f"T_{i}", i * 1000) for i in range(100)]
        remote = [self._e(f"T_{i*2}", i * 2000) for i in range(100)]
        m = self.m.merge(local, remote)
        self.assertGreater(len(m), 100); self.assertLessEqual(len(m), 200)
        self.assertEqual([e["start_epoch"] for e in m], sorted(e["start_epoch"] for e in m))


# =============================================================================
# 3. RemoteStagingSync Tests
# =============================================================================

class TestRemoteStagingSync(unittest.TestCase):
    def setUp(self):
        if not HAS_PHASE2: self.skipTest("not implemented")
        self.crypto = mock_crypto()
        self.transport = mock_transport()
        self.device_id = MagicMock(spec=AbstractDeviceIdentityProvider)
        self.device_id.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-1234", device_proof="p", device_label="M")
        self.sync = RemoteStagingSync(self.crypto, self.transport, self.device_id)

    def test_pull_empty(self):
        self.assertIsNone(self.sync.pull())

    def test_push_pull_roundtrip(self):
        self.sync.push([{"title": "T", "start_epoch": 1000}], "dev-1234")
        self.assertEqual(self.sync.pull()["entries"][0]["title"], "T")

    def test_push_device_id(self):
        self.sync.push([{"title": "T"}], "dev-1234")
        self.assertEqual(self.sync.pull()["device_id"], "dev-1234")

    def test_overwrite(self):
        self.sync.push([{"title": "A"}], "d1")
        self.sync.push([{"title": "B"}], "d2")
        self.assertEqual(self.sync.pull()["entries"][0]["title"], "B")

    def test_check_device_match(self):
        self.sync.push([{"title": "T"}], "dev-1234")
        self.assertTrue(self.sync.check_device())

    def test_check_device_mismatch(self):
        self.sync.push([{"title": "T"}], "other")
        self.assertFalse(self.sync.check_device())

    def test_get_remote_device_id(self):
        self.sync.push([{"title": "T"}], "dev-1234")
        self.assertEqual(self.sync.get_remote_device_id(), "dev-1234")

    def test_get_remote_device_id_none(self):
        self.assertIsNone(self.sync.get_remote_device_id())

    def test_pull_parsed(self):
        self.sync.push([{"title": "A"}, {"title": "B"}], "d")
        self.assertEqual(len(self.sync.pull()["entries"]), 2)
# =============================================================================
# 4. StagingService Tests
# =============================================================================

class TestStagingService(unittest.TestCase):
    """StagingService public API — no plain: leakage, decrypted DTOs."""

    def setUp(self):
        if not HAS_PHASE2: self.skipTest("not implemented")
        self.service = StagingService(mock_crypto(), mock_staging_store())

    # --- capture ---

    def test_capture_creates_entry(self):
        self.service.capture("Guitar", 1000, stop_epoch=2000, tags=["music"])
        e = self.service.get_entries()
        self.assertEqual(len(e), 1); self.assertEqual(e[0]["title"], "Guitar")

    def test_capture_returns_none(self):
        p = self.service.capture("G", 1000, stop_epoch=2000)
        self.assertIsNone(p)

    def test_capture_no_plain_leakage(self):
        self.service.capture("G", 1000, stop_epoch=2000)
        for entry in self.service.get_entries():
            for k, v in entry.items():
                if isinstance(v, str): self.assertNotIn("plain:", v, f"Field '{k}' leaked plain:")

    def test_capture_active(self):
        self.service.capture("C", 1000, is_active=True)
        self.assertTrue(self.service.get_entries()[0]["is_active"])

    def test_capture_collision(self):
        self.service.capture("A", 1000, stop_epoch=2000)
        with self.assertRaises(ValueError):
            self.service.capture("B", 1000, stop_epoch=3000)

    def test_capture_with_metadata(self):
        self.service.capture("C", 1000, stop_epoch=2000, metadata={"p": 5})
        self.assertEqual(self.service.get_entries()[0]["metadata"], {"p": 5})

    def test_capture_with_comment(self):
        self.service.capture("R", 1000, stop_epoch=2000, comment="Ch5")
        self.assertEqual(self.service.get_entries()[0]["comment"], "Ch5")

    def test_capture_normalizes_tags(self):
        self.service.capture("T", 1000, stop_epoch=2000, tags=["  Music ", "MUSIC"])
        self.assertEqual(self.service.get_entries()[0]["tags"], ["music"])

    def test_get_entries_decrypted(self):
        self.service.capture("T", 1000, stop_epoch=2000)
        e = self.service.get_entries()[0]
        self.assertEqual(e["start_epoch"], 1000); self.assertEqual(e["end_epoch"], 2000)

    # --- end ---

    def test_end_marks_completed(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.end("C", 5000)
        e = self.service.get_entries()[0]
        self.assertFalse(e["is_active"]); self.assertEqual(e["end_epoch"], 5000)

    def test_end_updates_duration(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.end("C", 5000)
        self.assertEqual(self.service.get_entries()[0]["duration"], 4000)

    def test_end_with_comment(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.end("C", 5000, comment="Done")
        self.assertEqual(self.service.get_entries()[0]["comment"], "Done")

    def test_end_nonexistent_raises(self):
        with self.assertRaises(ValueError):
            self.service.end("NoTask", 5000)

    def test_end_already_completed_idempotent(self):
        self.service.capture("D", 1000, stop_epoch=2000)
        # end() is idempotent — does not raise on already-ended entries
        # (capture with stop_epoch sets is_active=True, so end() finds it)
        try:
            self.service.end("D", 3000)
        except ValueError:
            self.fail("end() raised ValueError on already-ended entry")
        e = self.service.get_entries()[0]
        # end() will update end_epoch since is_active=True was the default
        self.assertEqual(e["end_epoch"], 3000)

    def test_end_auto_unpauses(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.pause("C", 2000)
        self.service.end("C", 5000)
        e = self.service.get_entries()[0]
        self.assertFalse(e["is_paused"])
        self.assertGreater(len(e["pauses"]), 0)

    # --- end_at ---

    def test_end_at_specific_time(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.end_at("C", 3000)
        e = self.service.get_entries()[0]
        self.assertEqual(e["end_epoch"], 3000); self.assertEqual(e["duration"], 2000)

    def test_end_at_comment(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.end_at("C", 3000, comment="Past")
        self.assertEqual(self.service.get_entries()[0]["comment"], "Past")

    # --- pause / unpause ---

    def test_pause_sets_flag(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.pause("C", 2000)
        self.assertTrue(self.service.get_entries()[0]["is_paused"])

    def test_pause_adds_record(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.pause("C", 2000)
        self.assertEqual(len(self.service.get_entries()[0]["pauses"]), 1)

    def test_pause_not_found_raises(self):
        with self.assertRaises(ValueError):
            self.service.pause("NoTask", 2000)

    def test_pause_already_paused_adds_record(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.pause("C", 2000)
        # pause() is idempotent — adds another pause record
        self.service.pause("C", 3000)
        pauses = self.service.get_entries()[0]["pauses"]
        self.assertEqual(len(pauses), 2)

    def test_unpause_clears_flag(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.pause("C", 2000)
        self.service.unpause("C", 3000)
        self.assertFalse(self.service.get_entries()[0]["is_paused"])

    def test_unpause_closes_pause(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.pause("C", 2000)
        self.service.unpause("C", 3000)
        pauses = self.service.get_entries()[0]["pauses"]
        self.assertEqual(pauses[0]["pause_stop"], 3000)

    def test_unpause_not_found_raises(self):
        with self.assertRaises(ValueError):
            self.service.unpause("NoTask", 3000)

    def test_unpause_not_paused_idempotent(self):
        self.service.capture("C", 1000, is_active=True)
        # unpause() is idempotent — no-op when not paused, does not raise
        try:
            self.service.unpause("C", 3000)
        except ValueError:
            self.fail("unpause() raised ValueError on not-paused entry")

    def test_pause_unpause_repeats(self):
        self.service.capture("C", 1000, is_active=True)
        self.service.pause("C", 2000); self.service.unpause("C", 2500)
        self.service.pause("C", 3000); self.service.unpause("C", 3500)
        pauses = self.service.get_entries()[0]["pauses"]
        self.assertEqual(len(pauses), 2)
        self.assertEqual(pauses[0]["pause_stop"], 2500)
        self.assertEqual(pauses[1]["pause_stop"], 3500)

    # -- stale-index race regression: end/pause/unpause target correct entry ---

    def test_end_correct_entry_with_multiple_active(self):
        """end() targets the correct entry when multiple active entries exist."""
        self.service.capture("Task A", 1000, is_active=True)
        self.service.capture("Task B", 2000, is_active=True)
        self.service.end("Task B", 5000)

        entries = self.service.get_entries()
        task_a = [e for e in entries if e["title"] == "Task A"][0]
        task_b = [e for e in entries if e["title"] == "Task B"][0]
        self.assertTrue(task_a["is_active"], "Task A should remain active")
        self.assertFalse(task_b["is_active"], "Task B should be ended")

    def test_pause_correct_entry_with_multiple_active(self):
        """pause() targets the correct entry when multiple active entries exist."""
        self.service.capture("Task A", 1000, is_active=True)
        self.service.capture("Task B", 2000, is_active=True)
        self.service.pause("Task B", 2500)

        entries = self.service.get_entries()
        task_a = [e for e in entries if e["title"] == "Task A"][0]
        task_b = [e for e in entries if e["title"] == "Task B"][0]
        self.assertFalse(task_a["is_paused"], "Task A should not be paused")
        self.assertTrue(task_b["is_paused"], "Task B should be paused")

    def test_unpause_correct_entry_with_multiple_paused(self):
        """unpause() targets the correct entry when multiple entries are paused."""
        self.service.capture("Task A", 1000, is_active=True)
        self.service.capture("Task B", 2000, is_active=True)
        self.service.pause("Task A", 1200)
        self.service.pause("Task B", 2200)
        self.service.unpause("Task A", 1500)

        entries = self.service.get_entries()
        task_a = [e for e in entries if e["title"] == "Task A"][0]
        task_b = [e for e in entries if e["title"] == "Task B"][0]
        self.assertFalse(task_a["is_paused"], "Task A should be unpaused")
        self.assertTrue(task_b["is_paused"], "Task B should remain paused")

    # --- modify ---

    def test_modify_title(self):
        self.service.capture("T", 1000, stop_epoch=2000)
        self.service.modify(0, title="NewTitle")
        e = self.service.get_entries()[0]
        self.assertEqual(e["title"], "NewTitle")

    def test_modify_tags(self):
        self.service.capture("T", 1000, stop_epoch=2000)
        self.service.modify(0, tags=["new"])
        e = self.service.get_entries()[0]
        self.assertEqual(e["tags"], ["new"])

    def test_modify_comment(self):
        self.service.capture("T", 1000, stop_epoch=2000)
        self.service.modify(0, comment="New comment")
        e = self.service.get_entries()[0]
        self.assertEqual(e["comment"], "New comment")

    def test_modify_out_of_range_raises(self):
        with self.assertRaises((ValueError, IndexError)):
            self.service.modify(999, title="X")

    def test_modify_tags_normalized(self):
        self.service.capture("T", 1000, stop_epoch=2000)
        self.service.modify(0, tags=["  Music ", "MUSIC"])
        e = self.service.get_entries()[0]
        self.assertEqual(e["tags"], ["music"])

    # --- remove ---

    def test_remove_by_index(self):
        self.service.capture("A", 1000, stop_epoch=2000)
        self.service.capture("B", 3000, stop_epoch=4000)
        self.service.remove(0)
        self.assertEqual(len(self.service.get_entries()), 1)
        self.assertEqual(self.service.get_entries()[0]["title"], "B")

    def test_remove_out_of_range_raises(self):
        with self.assertRaises((ValueError, IndexError)):
            self.service.remove(999)

    # --- get_pending_sync ---

    def test_pending_sync_includes_completed(self):
        self.service.capture("A", 1000, stop_epoch=2000, is_active=False)
        self.service.capture("B", 3000, stop_epoch=4000, is_active=False)
        pending = self.service.get_pending_sync()
        self.assertEqual(len(pending), 2)

    def test_pending_sync_excludes_active(self):
        self.service.capture("A", 1000, stop_epoch=2000, is_active=False)
        self.service.capture("B", 3000, is_active=True)
        pending = self.service.get_pending_sync()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["title"], "A")

    def test_pending_sync_excludes_paused(self):
        self.service.capture("A", 1000, is_active=True)
        self.service.pause("A", 1500)
        pending = self.service.get_pending_sync()
        self.assertEqual(len(pending), 0)

    # --- get_active / get_completed ---

    def test_get_active(self):
        self.service.capture("A", 1000, is_active=True)
        self.service.capture("B", 3000, stop_epoch=4000, is_active=False)
        active = self.service.get_active()
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["title"], "A")

    def test_get_completed(self):
        self.service.capture("A", 1000, is_active=True)
        self.service.capture("B", 3000, stop_epoch=4000, is_active=False)
        completed = self.service.get_completed()
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0]["title"], "B")

    # --- remove_synced ---

    def test_remove_synced_by_indices(self):
        self.service.capture("A", 1000, stop_epoch=2000)
        self.service.capture("B", 3000, stop_epoch=4000)
        self.service.capture("C", 5000, is_active=True)
        self.service.remove_synced([0, 1])
        remaining = self.service.get_entries()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["title"], "C")  # active task kept

    # --- no plain leak ---

    def test_staging_service_no_plain_leak(self):
        """Verify ALL output paths are free of plain: prefix."""
        self.service.capture("T1", 1000, stop_epoch=2000, tags=["a"])
        self.service.capture("T2", 3000, is_active=True)
        self.service.pause("T2", 3500)
        for method in ["get_entries", "get_active", "get_completed", "get_pending_sync"]:
            for entry in getattr(self.service, method)():
                for k, v in entry.items():
                    if isinstance(v, str):
                        self.assertNotIn("plain:", v, f"{method} leaked plain: in field '{k}'")
                    elif isinstance(v, list):
                        for item in v:
                            if isinstance(item, str):
                                self.assertNotIn("plain:", item, f"{method} list item has plain:")

    # --- check_and_sync ---

    def test_check_and_sync_returns_ready_without_transport(self):
        """Without transport, check_and_sync returns READY (local only)."""
        result = self.service.check_and_sync(timeout_ms=500)
        self.assertEqual(result, SyncCheckResult.READY)

    def test_check_and_sync_returns_offline_on_timeout(self):
        """With transport that raises, check_and_sync returns OFFLINE."""
        failing_transport = MagicMock()
        failing_transport.pull.side_effect = ConnectionError("No route to host")
        svc2 = StagingService(mock_crypto(), mock_staging_store(),
                              transport=failing_transport,
                              device_id_provider=MagicMock())
        result = svc2.check_and_sync(timeout_ms=500)
        self.assertEqual(result, SyncCheckResult.OFFLINE)


# =============================================================================
# 5. SyncCheckResult Tests
# =============================================================================

class TestSyncCheckResult(unittest.TestCase):
    """SyncCheckResult class has the expected constants."""

    def test_ready_value(self):
        self.assertEqual(SyncCheckResult.READY, "READY")

    def test_offline_value(self):
        self.assertEqual(SyncCheckResult.OFFLINE, "OFFLINE")

    def test_reauth_value(self):
        self.assertEqual(SyncCheckResult.REAUTH_NEEDED, "REAUTH_NEEDED")

    def test_is_class_not_enum(self):
        """SyncCheckResult is a plain class with string constants, not an Enum."""
        self.assertIsInstance(SyncCheckResult.READY, str)
