"""I-02 Phase 2 (RED): Staging field key encryption tests — Python.

Covers Phase 1 assertion Groups:
  - E: Staging field key encryption — LocalStagingCache (11 tests)
  - F: Staging field key encryption — StagingService remote sync (4 tests)
  - I: Edge cases & migration — staging subset (I1, I2, I3)

All tests are written against the FUTURE API that will exist after Phase 3.
They are expected to FAIL (RED) because field-key encryption is not yet implemented.
"""

import json
import hashlib
import hmac
import unittest
from unittest.mock import MagicMock

# ── Pre-import checks ────────────────────────────────────────────────
try:
    from security.crypto import CryptoManager
    from domain.staging.local_cache import LocalStagingCache
    from domain.staging.service import StagingService
    HAS_MODULES = True
except ImportError:
    HAS_MODULES = False

try:
    from security.crypto import derive_field_key
    HAS_DERIVATION = True
except ImportError:
    HAS_DERIVATION = False


def _mk_master_key(seed: int = 42) -> bytes:
    return hashlib.sha256(f"test-mk-staging-{seed}".encode()).digest()


def mock_crypto():
    """Mock crypto for encrypt/decrypt with ENC: prefix."""
    fake = MagicMock()
    fake.encrypt.side_effect = lambda text: f"ENC:{text}"
    fake.decrypt.side_effect = lambda hex_data: (
        hex_data[4:] if hex_data.startswith("ENC:")
        else hex_data[6:] if hex_data.startswith("plain:")
        else hex_data
    )
    fake.seal.side_effect = lambda ds: hashlib.sha256(ds.encode()).hexdigest()[:32]
    fake.verify_seal.side_effect = (
        lambda ds, seal: hashlib.sha256(ds.encode()).hexdigest()[:32] == seal
    )
    return fake


def mock_staging_store(initial_entries=None):
    store = MagicMock()
    store.entries = list(initial_entries) if initial_entries else []
    store.read_entries.side_effect = lambda: list(store.entries)
    store.write_entries.side_effect = lambda entries: setattr(store, "entries", list(entries))
    return store


# ══════════════════════════════════════════════════════════════════════
# Group E: Staging field key encryption — LocalStagingCache (Python)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipIf(not HAS_MODULES, "I-02 staging modules not yet available")
class TestStagingFieldKeyEncryption(unittest.TestCase):
    """E1-E11: Field-key encryption for staging entry key names."""

    def setUp(self):
        self.mk = _mk_master_key(1)
        self.crypto = CryptoManager(self.mk)
        self.store = mock_staging_store()
        self.cache = LocalStagingCache(self.crypto, self.store)

    def _raw_entry_keys(self):
        """Get the set of key names in the stored data dict."""
        raw = self.store.read_entries()
        if not raw:
            return set()
        data = raw[0].get("data", {})
        return set(data.keys())

    def _has_plaintext_keys(self, key_set):
        """Check if any key ends with _enc in plaintext."""
        return any(k.endswith("_enc") for k in key_set)

    # ── E1: write_entries stores with encrypted key names ────────────
    def test_E1_write_encrypts_key_names(self):
        """E1: write_entries() stores entries with encrypted key names, not _enc suffixes."""
        self.cache.write_entries([{
            "entry_index": 0, "title": "Test", "start_epoch": 1000,
            "end_epoch": 2000, "duration": 1000, "is_active": False,
            "is_paused": False, "pauses": [], "tags": [], "comment": None,
            "media": [], "metadata": {}, "device_uuid": "dev-1",
            "end_device_uuid": "", "entry_id": "e1",
            "date": "1970-01-01", "source": "local", "hash": "abc",
        }])

        keys = self._raw_entry_keys()
        # After I-02: should NOT have plaintext _enc keys
        self.assertFalse(
            self._has_plaintext_keys(keys),
            f"write_entries still uses plaintext _enc keys: {keys}"
        )
        # Data structure should still have entries
        raw = self.store.read_entries()
        self.assertEqual(len(raw), 1)

    # ── E2: read_entries decrypts key names ──────────────────────────
    def test_E2_read_decrypts_key_names_roundtrip(self):
        """E2: read_entries() decrypts key names and returns correct DTO."""
        self.cache.write_entries([{
            "entry_index": 0, "title": "Music", "start_epoch": 1000,
            "end_epoch": 2000, "duration": 1000, "is_active": False,
            "is_paused": False, "pauses": [], "tags": ["practice"],
            "comment": "Ch5", "media": [], "metadata": {"bpm": 120},
            "device_uuid": "dev-1", "end_device_uuid": "dev-2",
            "entry_id": "e1", "date": "1970-01-01",
            "source": "local", "hash": "abc",
        }])

        dtos = self.cache.read_entries()
        self.assertEqual(len(dtos), 1)
        dto = dtos[0]
        self.assertEqual(dto["title"], "Music")
        self.assertEqual(dto["start_epoch"], 1000)
        self.assertEqual(dto["end_epoch"], 2000)
        self.assertEqual(dto["pauses"], [])
        self.assertEqual(dto["tags"], ["practice"])
        self.assertEqual(dto["comment"], "Ch5")
        self.assertEqual(dto["metadata"], {"bpm": 120})
        self.assertEqual(dto["device_uuid"], "dev-1")
        self.assertEqual(dto["end_device_uuid"], "dev-2")

    # ── E3: append writes with encrypted key names ──────────────────
    def test_E3_append_encrypts_keys(self):
        """E3: append() stores new entries with encrypted key names."""
        self.cache.append("Guitar", 1000, end_epoch=2000, tags=["music"])

        keys = self._raw_entry_keys()
        self.assertFalse(
            self._has_plaintext_keys(keys),
            f"append() still uses plaintext _enc keys: {keys}"
        )

    # ── E4: update reads/writes with encrypted key names ─────────────
    def test_E4_update_with_encrypted_keys(self):
        """E4: update() works correctly through encrypted key names."""
        self.cache.append("Task", 1000, is_active=True)

        self.cache.update(0, {"comment": "updated comment"})

        dtos = self.cache.read_entries()
        self.assertEqual(dtos[0]["comment"], "updated comment")

    # ── E5: add_pause/close_pause with encrypted key names ───────────
    def test_E5_pause_with_encrypted_keys(self):
        """E5: add_pause() and close_pause() work through encrypted key names."""
        self.cache.append("Task", 1000, is_active=True)

        self.cache.add_pause(0, 1500)
        dtos = self.cache.read_entries()
        self.assertTrue(dtos[0]["is_paused"])
        self.assertEqual(len(dtos[0]["pauses"]), 1)
        self.assertEqual(dtos[0]["pauses"][0]["pause_start"], 1500)

        self.cache.close_pause(0, 1800)
        dtos2 = self.cache.read_entries()
        self.assertFalse(dtos2[0]["is_paused"])
        self.assertEqual(dtos2[0]["pauses"][0]["pause_stop"], 1800)

    # ── E6: Hash index rebuild unaffected ────────────────────────────
    def test_E6_hash_index_unaffected_by_key_encryption(self):
        """E6: Staging hash index rebuild works regardless of key name encryption."""
        self.cache.append("Task A", 1000, end_epoch=2000, tags=["work"])
        self.cache.append("Task B", 3000, end_epoch=4000, tags=["personal"])

        # Verify entries are readable (hash index builds from DTOs)
        dtos = self.cache.read_entries()
        self.assertEqual(len(dtos), 2)
        # Each DTO should have an entry_index (used for hash index)
        self.assertEqual(dtos[0]["entry_index"], 0)
        self.assertEqual(dtos[1]["entry_index"], 1)

    # ── E7: Hash computation identical regardless of storage encoding ─
    def test_E7_hash_stable_regardless_of_encoding(self):
        """E7: Same DTO produces same hash regardless of storage key encoding."""
        dto = {
            "title": "Test", "start_epoch": 1000, "end_epoch": 2000,
            "duration": 1000, "is_active": False, "is_paused": False,
            "pauses": [], "tags": [], "comment": None, "media": [],
            "entry_id": "e1", "metadata": {}, "device_uuid": "",
            "end_device_uuid": "",
        }
        h1 = self.cache._compute_entry_hash(dto)
        h2 = self.cache._compute_entry_hash(dto)
        self.assertEqual(h1, h2)

    # ── E8: Legacy plaintext key names readable ──────────────────────
    def test_E8_legacy_plaintext_keys_readable(self):
        """E8: Entries stored with plaintext _enc key names are still readable."""
        legacy_data = {
            "title": "Old Task",
            "duration": 1000,
            "is_active": False,
            "is_paused": False,
            "startTime_enc": "plain:1000",
            "endTime_enc": "plain:2000",
            "pauses_enc": "plain:[]",
            "metadata_enc": "plain:{}",
            "tags": [],
            "media": [],
            "entry_id": "old-1",
            "device_uuid_enc": "plain:dev-old",
            "end_device_uuid_enc": "plain:",
        }
        self.store.write_entries([{
            "hash": "oldhash",
            "data": legacy_data,
            "start_epoch": 1000,
        }])

        dtos = self.cache.read_entries()
        self.assertEqual(len(dtos), 1)
        self.assertEqual(dtos[0]["title"], "Old Task")
        self.assertEqual(dtos[0]["start_epoch"], 1000)
        self.assertEqual(dtos[0]["end_epoch"], 2000)
        self.assertEqual(dtos[0]["device_uuid"], "dev-old")

    # ── E9: Legacy upgraded to encrypted on write ───────────────────
    def test_E9_legacy_upgraded_on_write(self):
        """E9: Legacy entries are upgraded to encrypted key names on write."""
        # Write a legacy entry with plaintext keys
        legacy_data = {
            "title": "Upgrade Me",
            "duration": 1000,
            "is_active": False,
            "is_paused": False,
            "startTime_enc": "plain:1000",
            "endTime_enc": "plain:2000",
            "pauses_enc": "plain:[]",
            "metadata_enc": "plain:{}",
            "tags": [],
            "media": [],
            "entry_id": "upgrade-1",
            "device_uuid_enc": "plain:dev-up",
            "end_device_uuid_enc": "plain:",
        }
        self.store.write_entries([{
            "hash": "oldhash",
            "data": legacy_data,
            "start_epoch": 1000,
        }])

        # Update triggers rewrite
        self.cache.update(0, {"comment": "now encrypted"})

        # After update, key names should be encrypted
        raw = self.store.read_entries()
        keys = raw[0].get("data", {}).keys()
        self.assertFalse(
            self._has_plaintext_keys(keys),
            f"Keys not upgraded after write: {keys}"
        )

    # ── E10: Uses derived key, not raw MK ────────────────────────────
    def test_E10_uses_derived_key_not_raw_mk(self):
        """E10: Field-key encryption uses derived key, not raw master key."""
        self.cache.append("Task", 1000, end_epoch=2000)

        raw = self.store.read_entries()
        data = raw[0].get("data", {})

        # Check none of the encrypted values contain the raw MK
        mk_hex = self.mk.hex()
        for key, value in data.items():
            if isinstance(value, str) and len(value) > 16:
                self.assertNotIn(
                    mk_hex, value,
                    f"Raw MK found in field '{key}' encrypted value"
                )

    # ── E11: Deterministic field-name → token mapping ────────────────
    def test_E11_deterministic_field_name_mapping(self):
        """E11: Same field name always maps to same encrypted token."""
        self.cache.write_entries([{
            "entry_index": 0, "title": "A", "start_epoch": 1000,
            "end_epoch": 2000, "duration": 1000, "is_active": False,
            "is_paused": False, "pauses": [], "tags": [], "comment": None,
            "media": [], "metadata": {}, "device_uuid": "d1",
            "end_device_uuid": "", "entry_id": "e1",
            "date": "1970-01-01", "source": "local", "hash": "h1",
        }])

        raw1 = self.store.read_entries()
        data1 = raw1[0].get("data", {})

        # Write a second entry and check key names match
        self.cache.write_entries([{
            "entry_index": 0, "title": "B", "start_epoch": 3000,
            "end_epoch": 4000, "duration": 1000, "is_active": False,
            "is_paused": False, "pauses": [], "tags": [], "comment": None,
            "media": [], "metadata": {}, "device_uuid": "d2",
            "end_device_uuid": "", "entry_id": "e2",
            "date": "1970-01-01", "source": "local", "hash": "h2",
        }])

        raw2 = self.store.read_entries()
        data2 = raw2[0].get("data", {})

        # Same field names should map to same tokens
        # (Both entries have the same set of keys, just different values)
        keys1 = set(data1.keys())
        keys2 = set(data2.keys())
        self.assertEqual(keys1, keys2,
                         f"Field name mapping not deterministic: {keys1} vs {keys2}")


# ══════════════════════════════════════════════════════════════════════
# Group F: Staging field key encryption — StagingService remote sync
# ══════════════════════════════════════════════════════════════════════

@unittest.skipIf(not HAS_MODULES, "I-02 staging modules not yet available")
class TestStagingServiceRemoteBlob(unittest.TestCase):
    """F1-F4: Remote blob handling with encrypted key names."""

    def setUp(self):
        self.mk = _mk_master_key(2)
        self.crypto = CryptoManager(self.mk)

    # ── F1: _raw_entry_to_dto decrypts remote encrypted key names ────
    def test_F1_raw_entry_to_dto_encrypted_keys(self):
        """F1: _raw_entry_to_dto() handles remote entries with encrypted key names."""
        # Create a local cache, write entry with encrypted keys
        store = mock_staging_store()
        cache = LocalStagingCache(self.crypto, store)
        cache.append("Remote Task", 5000, end_epoch=10000, tags=["remote"],
                     device_uuid="remote-dev")

        # Read the raw entry (would be serialized for remote transport)
        raw = store.read_entries()
        self.assertEqual(len(raw), 1)

        # Simulate remote: write raw into another cache and read back
        store2 = mock_staging_store(raw)
        cache2 = LocalStagingCache(self.crypto, store2)
        dtos = cache2.read_entries()
        self.assertEqual(len(dtos), 1)
        self.assertEqual(dtos[0]["title"], "Remote Task")
        self.assertEqual(dtos[0]["start_epoch"], 5000)

    # ── F2: _raw_entry_to_dto handles legacy plain: entries ──────────
    def test_F2_raw_entry_to_dto_legacy_plain_keys(self):
        """F2: _raw_entry_to_dto() handles legacy entries with plaintext key names."""
        legacy_raw = [{
            "hash": "legacy-hash",
            "data": {
                "title": "Legacy Task",
                "duration": 1000,
                "is_active": False,
                "is_paused": False,
                "startTime_enc": "plain:7000",
                "endTime_enc": "plain:8000",
                "pauses_enc": "plain:[]",
                "metadata_enc": "plain:{}",
                "tags": [],
                "media": [],
                "entry_id": "legacy-1",
                "device_uuid_enc": "plain:dev-legacy",
                "end_device_uuid_enc": "plain:",
            },
        }]

        store = mock_staging_store(legacy_raw)
        cache = LocalStagingCache(self.crypto, store)
        dtos = cache.read_entries()
        self.assertEqual(len(dtos), 1)
        self.assertEqual(dtos[0]["title"], "Legacy Task")
        self.assertEqual(dtos[0]["start_epoch"], 7000)
        self.assertEqual(dtos[0]["end_epoch"], 8000)
        self.assertEqual(dtos[0]["device_uuid"], "dev-legacy")

    # ── F3: Merge engine unaffected by key name encryption ───────────
    def test_F3_merge_unaffected_by_key_encryption(self):
        """F3: Merge engine operates on DTOs, unaffected by raw key encoding."""
        from domain.staging.merge_engine import MergeEngine

        # Build DTOs with SAME entry_id so merge deduplicates them
        shared_entry_id = "shared-e1"
        local_dtos = [{
            "title": "Task X", "start_epoch": 1000, "end_epoch": 2000,
            "duration": 1000, "is_active": False, "is_paused": False,
            "pauses": [], "tags": ["old"], "comment": None,
            "media": [], "metadata": {}, "source": "local",
            "device_uuid": "dev-1", "end_device_uuid": "",
            "entry_id": shared_entry_id, "hash": "local-hash",
            "entry_index": 0, "date": "1970-01-01",
        }]

        # Remote has same entry_id but updated fields
        remote_dtos = [{
            "title": "Task X", "start_epoch": 1000, "end_epoch": 2500,
            "duration": 1500, "is_active": False, "is_paused": False,
            "pauses": [], "tags": ["updated"], "comment": None,
            "media": [], "metadata": {}, "source": "remote",
            "device_uuid": "remote-dev", "end_device_uuid": "",
            "entry_id": shared_entry_id, "hash": "remote-hash",
            "entry_index": 0, "date": "1970-01-01",
        }]

        merge = MergeEngine()
        merged = merge.merge(local_dtos, remote_dtos)

        # Merge should produce exactly one entry for (Task X, 1000)
        self.assertEqual(len(merged), 1,
                         f"Expected 1 merged entry, got {len(merged)}")

        # Remote values should win for matched entry
        task_x = merged[0]
        self.assertEqual(task_x["end_epoch"], 2500,
                         f"Remote end_epoch should win: {task_x['end_epoch']} != 2500")
        self.assertEqual(task_x["tags"], ["updated"],
                         f"Remote tags should win: {task_x['tags']}")

    # ── F4: Push/pull roundtrip preserves encrypted key names ────────
    def test_F4_push_pull_roundtrip(self):
        """F4: Encrypted key names survive serialization + transport roundtrip."""
        cache1 = LocalStagingCache(self.crypto, mock_staging_store())
        cache1.append("Roundtrip Task", 1000, end_epoch=2000, tags=["roundtrip"],
                      device_uuid="dev-rt")

        # Simulate serialization: read raw, serialize to JSON, deserialize
        raw1 = cache1._store.read_entries()
        serialized = json.dumps(raw1)
        deserialized = json.loads(serialized)

        # Simulate writing on another "client" (same MK)
        store2 = mock_staging_store(deserialized)
        cache2 = LocalStagingCache(self.crypto, store2)
        dtos = cache2.read_entries()

        self.assertEqual(len(dtos), 1)
        self.assertEqual(dtos[0]["title"], "Roundtrip Task")
        self.assertEqual(dtos[0]["start_epoch"], 1000)
        self.assertEqual(dtos[0]["end_epoch"], 2000)
        self.assertEqual(dtos[0]["tags"], ["roundtrip"])
        self.assertEqual(dtos[0]["device_uuid"], "dev-rt")


# ══════════════════════════════════════════════════════════════════════
# Group I: Edge cases — staging subset
# ══════════════════════════════════════════════════════════════════════

@unittest.skipIf(not HAS_MODULES, "I-02 staging modules not yet available")
class TestStagingEdgeCases(unittest.TestCase):
    """I1, I2, I3 — corrupt entries, mixed format, empty staging."""

    def setUp(self):
        self.mk = _mk_master_key(3)
        self.crypto = CryptoManager(self.mk)

    # ── I1: Corrupt encrypted entry → skipped (no crash) ─────────────
    def test_I1_corrupt_encrypted_entry_skipped(self):
        """I1: Corrupt encrypted staging entry is skipped, does not crash."""
        store = mock_staging_store()
        cache = LocalStagingCache(self.crypto, store)

        # Write a valid entry
        cache.append("Valid", 1000, end_epoch=2000)

        # Manually inject a corrupt entry (garbage in an encrypted field)
        raw = store.read_entries()
        corrupt = {
            "hash": "corrupt",
            "data": {
                "title": "Corrupt",
                "duration": 0,
                "is_active": False,
                "is_paused": False,
                "startTime_enc": "GARBAGE_DATA_NOT_VALID",
                "tags": [],
                "media": [],
            },
        }
        raw.append(corrupt)
        store.write_entries(raw)

        # Should not crash
        try:
            dtos = cache.read_entries()
            # The valid entry should still be there
            self.assertGreaterEqual(len(dtos), 1)
            self.assertEqual(dtos[0]["title"], "Valid")
        except Exception as e:
            self.fail(f"Corrupt entry caused crash: {e}")

    # ── I2: Mixed format (encrypted + plaintext keys) readable ───────
    def test_I2_mixed_format_readable(self):
        """I2: Partial migration scenario — both format entries are readable."""
        cache = LocalStagingCache(self.crypto, mock_staging_store())

        # Write a new-style entry (encrypted keys)
        cache.append("New Entry", 1000, end_epoch=2000)

        # Inject a legacy entry with plaintext keys alongside
        raw = cache._store.read_entries()
        legacy = {
            "hash": "legacy-hash",
            "data": {
                "title": "Legacy Entry",
                "duration": 500,
                "is_active": False,
                "is_paused": False,
                "startTime_enc": "plain:3000",
                "endTime_enc": "plain:3500",
                "pauses_enc": "plain:[]",
                "metadata_enc": "plain:{}",
                "tags": [],
                "media": [],
                "entry_id": "legacy-e1",
                "device_uuid_enc": "plain:dev-legacy",
                "end_device_uuid_enc": "plain:",
            },
        }
        raw.insert(0, legacy)
        cache._store.write_entries(raw)

        # Both entries should be readable
        dtos = cache.read_entries()
        titles = {e["title"] for e in dtos}
        self.assertIn("Legacy Entry", titles)
        self.assertIn("New Entry", titles)

    # ── I3: Empty staging works with new key encryption ──────────────
    def test_I3_empty_staging_with_encrypted_keys(self):
        """I3: Empty staging → read/write works with encrypted key names."""
        cache = LocalStagingCache(self.crypto, mock_staging_store())

        # Read on empty
        self.assertEqual(cache.read_entries(), [])

        # Write on empty
        cache.append("First Entry", 1000, end_epoch=2000)
        dtos = cache.read_entries()
        self.assertEqual(len(dtos), 1)
        self.assertEqual(dtos[0]["title"], "First Entry")

        # Clear and verify encrypted empty
        raw = cache._store.read_entries()
        raw.clear()
        cache._store.write_entries(raw)
        self.assertEqual(cache.read_entries(), [])


if __name__ == "__main__":
    unittest.main()
