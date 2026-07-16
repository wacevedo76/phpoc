"""
test_staging_at_rest_encryption.py — I-03 Phase 2 (RED): Staging At-Rest Encryption.

Tests assert the post-I-03 behavior:
  - CryptoManager → AES-CTR hex ciphertext on disk
  - NoAuthCryptoManager → "plain:" prefix (unchanged, D6 preservation)
  - Read path: try-decrypt, fallback-to-plain: (D9 backward compat)
  - _raw_entry_to_dto handles both hex ciphertext and plain: formats
  - All CRUD, round-trip, migration, and edge cases covered.

These tests are intentionally RED — they assert the encrypted-staging
interface that does not yet exist. They will turn GREEN in Phase 3 when
_to_plain conditionally encrypts and _raw_entry_to_dto handles hex.

Assertion IDs map to docs/planning/I03_STAGING_AT_REST_ENCRYPTION_PHASE1.md:
  Groups A–H, J: ~50 tests.
"""

import hashlib
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from security.crypto import CryptoManager, NoAuthCryptoManager
from domain.staging.local_cache import LocalStagingCache
from storage.implementations.file_staging import FileStagingStore


# ══════════════════════════════════════════════════════════════════════
# Test helpers
# ══════════════════════════════════════════════════════════════════════

def _mk_crypto():
    """Create a CryptoManager with a deterministic 32-byte master key."""
    mk = hashlib.pbkdf2_hmac("sha256", b"test-passphrase", b"i03-salt", 100, 32)
    return CryptoManager(mk)


def _mk_noauth():
    """Create a NoAuthCryptoManager (no master key)."""
    return NoAuthCryptoManager()


def _temp_staging_store():
    """Create a FileStagingStore backed by a temp file (pre-initialized)."""
    tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
    path = Path(tmp.name)
    tmp.close()
    # FileStagingStore requires the file to contain valid JSON (or not exist).
    # Delete the empty temp file so the store initializes it with [].
    path.unlink()
    store = FileStagingStore(path)
    return store, path


def _make_cache(crypto, store=None):
    """Create a LocalStagingCache with the given crypto and optional store."""
    if store is None:
        store, _ = _temp_staging_store()
    return LocalStagingCache(crypto, store)


def _write_raw_entries(store, entries):
    """Write raw entries directly to the store (bypassing LocalStagingCache)."""
    store.write_entries(entries)


def _build_plain_entry(title="Test", start_epoch=1714000000000, end_epoch=None,
                        device_uuid="dev-1", pauses=None, metadata=None,
                        is_active=True, tags=None, comment=None,
                        entry_id="entry-1"):
    """Build a raw entry in current plain: format (for backward compat tests)."""
    end = f"plain:{end_epoch}" if end_epoch is not None else None
    return {
        "hash": "abc123",
        "data": {
            "title": title,
            "duration": (end_epoch - start_epoch) if end_epoch else 0,
            "is_active": is_active,
            "is_paused": False,
            "startTime_enc": f"plain:{start_epoch}",
            "endTime_enc": end,
            "pauses_enc": f"plain:{json.dumps(pauses or [])}",
            "metadata_enc": f"plain:{json.dumps(metadata or {})}",
            "tags": tags or [],
            "media": [],
            "entry_id": entry_id,
            "device_uuid_enc": f"plain:{device_uuid}",
            "end_device_uuid_enc": "plain:",
        },
        "start_epoch": start_epoch,
    }


# ══════════════════════════════════════════════════════════════════════
# Group A: Encryption/Decryption Primitives (~8 tests)
# ══════════════════════════════════════════════════════════════════════

class TestGroupA_EncryptionPrimitives(unittest.TestCase):
    """A1–A8: _encrypt_field / _from_plain / _from_plain_int behavior."""

    def setUp(self):
        self.crypto_mk = _mk_crypto()
        self.crypto_noauth = _mk_noauth()

    # ── A1: _encrypt_field with CryptoManager produces hex ──────────

    def test_A1_encrypt_field_with_crypto_produces_hex_ciphertext(self):
        """_encrypt_field with CryptoManager must produce hex ciphertext
        (not starting with 'plain:')."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        result = cache._encrypt_field("test_value_42")
        self.assertIsInstance(result, str)
        self.assertFalse(
            result.startswith("plain:"),
            f"Expected hex ciphertext, got plain:-prefixed: {result[:20]}..."
        )
        # Must be valid hex
        try:
            bytes.fromhex(result)
        except ValueError:
            self.fail(f"Result is not valid hex: {result[:40]}...")

    # ── A2: _encrypt_field with NoAuthCryptoManager keeps plain: ────

    def test_A2_encrypt_field_with_noauth_produces_plain_prefix(self):
        """_encrypt_field with NoAuthCryptoManager must produce 'plain:{value}'."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_noauth, store)
        result = cache._encrypt_field("test_value_42")
        self.assertTrue(
            result.startswith("plain:"),
            f"Expected plain: prefix, got: {result[:20]}..."
        )
        self.assertEqual(result, "plain:test_value_42")

    # ── A3: _from_plain on plain: string ────────────────────────────

    def test_A3_from_plain_strips_plain_prefix(self):
        """_from_plain on 'plain:1714000000000' returns '1714000000000'."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        result = cache._from_plain("plain:1714000000000")
        self.assertEqual(result, "1714000000000")

    # ── A4: _from_plain on AES-CTR ciphertext decrypts correctly ────

    def test_A4_from_plain_on_hex_ciphertext_returns_plaintext(self):
        """_from_plain on AES-CTR hex ciphertext must return original plaintext."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        original = "1714000000000"
        encrypted = self.crypto_mk.encrypt(original)
        result = cache._from_plain(encrypted)
        self.assertEqual(result, original)

    # ── A5: _from_plain on corrupt hex returns None ─────────────────

    def test_A5_from_plain_on_corrupt_hex_returns_none(self):
        """_from_plain on corrupt/invalid data returns None (not crash)."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        result = cache._from_plain("not-valid-hex-zzzz")
        self.assertIsNone(result)

    def test_A5b_from_plain_on_invalid_ciphertext_returns_none(self):
        """_from_plain on valid hex that is not proper ciphertext returns None."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        # Valid hex but not valid AES-CTR envelope
        result = cache._from_plain("deadbeef" * 10)
        self.assertIsNone(result)

    # ── A6: _from_plain on None returns None ────────────────────────

    def test_A6_from_plain_on_none_returns_none(self):
        """_from_plain on None returns None (endTime_enc for active tasks)."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        result = cache._from_plain(None)
        self.assertIsNone(result)

    # ── A7: _from_plain_int on encrypted integer field ──────────────

    def test_A7_from_plain_int_on_encrypted_returns_correct_int(self):
        """_from_plain_int on encrypted integer field returns correct int."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        encrypted = self.crypto_mk.encrypt("1234567890")
        result = cache._from_plain_int(encrypted)
        self.assertEqual(result, 1234567890)

    def test_A7b_from_plain_int_on_plain_returns_correct_int(self):
        """_from_plain_int on 'plain:1234567890' returns correct int."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        result = cache._from_plain_int("plain:1234567890")
        self.assertEqual(result, 1234567890)

    # ── A8: _from_plain_int on corrupt data returns None ────────────

    def test_A8_from_plain_int_on_corrupt_returns_none(self):
        """_from_plain_int on corrupt/invalid data returns None."""
        store, _ = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        self.assertIsNone(cache._from_plain_int("not-a-number-plain:garbage"))
        self.assertIsNone(cache._from_plain_int("plain:notanumber"))


# ══════════════════════════════════════════════════════════════════════
# Group B: read_entries Backward Compatibility (~6 tests)
# ══════════════════════════════════════════════════════════════════════

class TestGroupB_ReadEntriesBackwardCompat(unittest.TestCase):
    """B1–B6: read_entries handles plain:, encrypted, and mixed formats."""

    def setUp(self):
        self.crypto_mk = _mk_crypto()
        self.crypto_noauth = _mk_noauth()

    # ── B1: read plain: staging file returns correct DTOs ───────────

    def test_B1_read_plain_staging_file_returns_correct_dtos(self):
        """Existing plain: staging files remain readable after upgrade (D9)."""
        store, path = _temp_staging_store()
        raw = [
            _build_plain_entry("Task One", 1714000000000, device_uuid="dev-a"),
            _build_plain_entry("Task Two", 1715000000000, device_uuid="dev-a"),
        ]
        _write_raw_entries(store, raw)

        cache = LocalStagingCache(self.crypto_mk, store)
        entries = cache.read_entries()
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["title"], "Task One")
        self.assertEqual(entries[0]["start_epoch"], 1714000000000)
        self.assertEqual(entries[1]["title"], "Task Two")
        self.assertEqual(entries[1]["start_epoch"], 1715000000000)
        path.unlink(missing_ok=True)

    # ── B2: read fully encrypted staging file returns correct DTOs ──

    def test_B2_read_encrypted_staging_file_returns_correct_dtos(self):
        """New-format fully encrypted staging files read correctly."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        # Write entries through the cache (should encrypt after Phase 3)
        cache.append("Task Alpha", 1714100000000, device_uuid="dev-b", is_active=True)
        cache.append("Task Beta", 1714200000000, device_uuid="dev-b", is_active=True)

        # Verify raw storage has NO plain: strings in encryptable values
        raw = store.read_entries()
        for entry in raw:
            data = entry.get("data", {})
            # After I-02, field names are encrypted tokens, so we check all values
            for key, value in data.items():
                if isinstance(value, str) and value:
                    self.assertFalse(
                        value.startswith("plain:"),
                        f"Expected encrypted value for key '{key}', got plain: prefixed"
                    )

        # Read back through cache — DTOs must be correct
        entries = cache.read_entries()
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["title"], "Task Alpha")
        self.assertEqual(entries[0]["start_epoch"], 1714100000000)
        self.assertEqual(entries[1]["title"], "Task Beta")
        self.assertEqual(entries[1]["start_epoch"], 1714200000000)
        path.unlink(missing_ok=True)

    # ── B3: read mixed-format file (some plain:, some encrypted) ────

    def test_B3_read_mixed_format_staging_file_works(self):
        """Mixed-format staging (plain: + encrypted entries) reads correctly."""
        store, path = _temp_staging_store()

        # Pre-populate with plain: entries
        raw_plain = [
            _build_plain_entry("Pre-auth Task", 1714000000000, device_uuid="dev-c"),
        ]
        _write_raw_entries(store, raw_plain)

        # Now use cache with CryptoManager to add an encrypted entry
        cache = LocalStagingCache(self.crypto_mk, store)
        cache.append("Post-auth Task", 1714100000000, device_uuid="dev-c", is_active=True)

        entries = cache.read_entries()
        self.assertEqual(len(entries), 2)
        titles = {e["title"] for e in entries}
        self.assertIn("Pre-auth Task", titles)
        self.assertIn("Post-auth Task", titles)
        path.unlink(missing_ok=True)

    # ── B4: read empty staging file ─────────────────────────────────

    def test_B4_read_empty_staging_file_returns_empty_list(self):
        """Empty staging file returns []."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        entries = cache.read_entries()
        self.assertEqual(entries, [])
        path.unlink(missing_ok=True)

    # ── B5: corrupt entry skipped, others preserved ─────────────────

    def test_B5_corrupt_entry_skipped_not_crash(self):
        """One corrupt startTime_enc must not block other entries."""
        store, path = _temp_staging_store()
        raw = [
            _build_plain_entry("Good Task", 1714000000000, device_uuid="dev-d"),
            {  # Corrupt entry — startTime_enc is garbage
                "hash": "badhash",
                "data": {
                    "title": "Corrupt",
                    "startTime_enc": "not-valid-and-not-plain-zzzz-top",
                },
                "start_epoch": 0,
            },
            _build_plain_entry("Also Good", 1716000000000, device_uuid="dev-d"),
        ]
        _write_raw_entries(store, raw)

        cache = LocalStagingCache(self.crypto_mk, store)
        entries = cache.read_entries()
        titles = {e["title"] for e in entries}
        self.assertIn("Good Task", titles)
        self.assertIn("Also Good", titles)
        self.assertNotIn("Corrupt", titles)
        path.unlink(missing_ok=True)

    # ── B6: all non-encrypted fields preserved ──────────────────────

    def test_B6_non_encrypted_fields_preserved_in_dtos(self):
        """read_entries preserves title, tags, comment, media, entry_id,
        is_active, is_paused, duration."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        
        start = 1714000000000
        cache.append(
            "Field Test", start,
            tags=["work", "urgent"],
            comment="test comment",
            is_active=True,
            device_uuid="dev-e",
        )

        entries = cache.read_entries()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["title"], "Field Test")
        self.assertEqual(e["start_epoch"], start)
        self.assertIn("work", e["tags"])
        self.assertIn("urgent", e["tags"])
        self.assertEqual(e["comment"], "test comment")
        self.assertTrue(e["is_active"])
        self.assertFalse(e.get("is_paused", True))
        self.assertTrue(len(e.get("entry_id", "")) > 0)
        self.assertIsInstance(e.get("media", None), list)
        path.unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════
# Group C: write_entries (~5 tests)
# ══════════════════════════════════════════════════════════════════════

class TestGroupC_WriteEntries(unittest.TestCase):
    """C1–C5: write_entries produces encrypted output with CryptoManager."""

    def setUp(self):
        self.crypto_mk = _mk_crypto()
        self.crypto_noauth = _mk_noauth()

    # ── C1: write_entries with CryptoManager → no plain: strings ────

    def test_C1_write_entries_with_crypto_produces_no_plain_strings(self):
        """write_entries with CryptoManager must produce no 'plain:' strings."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        # Build a DTO and write it
        dto = {
            "entry_index": 0,
            "title": "Test Title",
            "start_epoch": 1714000000000,
            "end_epoch": 1714003600000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
            "pauses": [],
            "tags": ["test"],
            "comment": "test",
            "media": [],
            "entry_id": "entry-uuid-1",
            "metadata": {},
            "date": "2024-04-25",
            "device_uuid": "dev-f",
            "end_device_uuid": "",
        }
        cache.write_entries([dto])

        # Inspect raw storage — no plain: strings in encrypted fields
        raw = store.read_entries()
        self.assertEqual(len(raw), 1)
        data = raw[0]["data"]

        encryptable_fields = [
            "startTime_enc", "endTime_enc", "pauses_enc",
            "metadata_enc", "device_uuid_enc"
        ]
        for field in encryptable_fields:
            value = data.get(field)
            if value is not None:
                self.assertIsInstance(value, str, f"{field} must be str")
                self.assertFalse(
                    value.startswith("plain:"),
                    f"{field} must NOT have plain: prefix with CryptoManager"
                )
                # Must be valid hex
                try:
                    bytes.fromhex(value)
                except ValueError:
                    self.fail(f"{field} is not valid hex: {value[:40]}...")

        path.unlink(missing_ok=True)

    # ── C2: write_entries with NoAuthCryptoManager → plain: ─────────

    def test_C2_write_entries_with_noauth_produces_plain_prefix(self):
        """write_entries with NoAuthCryptoManager produces plain: prefix."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_noauth, store)

        dto = {
            "entry_index": 0,
            "title": "NoAuth Test",
            "start_epoch": 1714000000000,
            "end_epoch": None,
            "duration": 0,
            "is_active": True,
            "is_paused": False,
            "pauses": [],
            "tags": [],
            "comment": None,
            "media": [],
            "entry_id": "entry-uuid-noauth",
            "metadata": {},
            "date": "2024-04-25",
            "device_uuid": "dev-g",
            "end_device_uuid": "",
        }
        cache.write_entries([dto])

        raw = store.read_entries()
        data = raw[0]["data"]

        # startTime_enc must have plain: prefix
        self.assertTrue(
            data["startTime_enc"].startswith("plain:"),
            f"Expected plain: prefix with NoAuthCryptoManager"
        )
        self.assertIn("1714000000000", data["startTime_enc"])
        path.unlink(missing_ok=True)

    # ── C3: entry hash is consistent for same data ──────────────────

    def test_C3_entry_hash_consistent_for_same_data(self):
        """Re-writing same data must produce same hash."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        dto = {
            "entry_index": 0,
            "title": "Hash Test",
            "start_epoch": 1714000000000,
            "end_epoch": None,
            "duration": 0,
            "is_active": True,
            "is_paused": False,
            "pauses": [],
            "tags": ["hash"],
            "comment": None,
            "media": [],
            "entry_id": "entry-hash-1",
            "metadata": {},
            "date": "2024-04-25",
            "device_uuid": "dev-h",
            "end_device_uuid": "",
        }

        cache.write_entries([dto])
        hash1 = store.read_entries()[0]["hash"]

        # Re-write (simulate re-read + write)
        cache.write_entries([dto])
        hash2 = store.read_entries()[0]["hash"]

        self.assertEqual(
            hash1, hash2,
            "Entry hash must be deterministic for same data"
        )
        self.assertEqual(len(hash1), 64, "Hash must be 64 hex chars")
        path.unlink(missing_ok=True)

    # ── C4: comment field persisted unencrypted ─────────────────────

    def test_C4_comment_field_persisted_unencrypted(self):
        """Comment is stored as plaintext in data dict (not _enc suffixed)."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        dto = {
            "entry_index": 0,
            "title": "With Comment",
            "start_epoch": 1714000000000,
            "end_epoch": None,
            "duration": 0,
            "is_active": True,
            "is_paused": False,
            "pauses": [],
            "tags": [],
            "comment": "my test comment",
            "media": [],
            "entry_id": "entry-comment-1",
            "metadata": {},
            "date": "2024-04-25",
            "device_uuid": "dev-i",
            "end_device_uuid": "",
        }
        cache.write_entries([dto])

        raw = store.read_entries()
        data = raw[0]["data"]
        # Comment should be plaintext, not encrypted, no _enc suffix
        self.assertEqual(data.get("comment"), "my test comment")
        self.assertIsNone(data.get("comment_enc"), "comment should not have _enc suffix")
        path.unlink(missing_ok=True)

    # ── C5: all field types survive serialization ──────────────────

    def test_C5_all_field_types_survive_roundtrip(self):
        """All field types: int (duration, epoch), bool (is_active),
        list (tags, media), dict (metadata) survive serialization."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        dto = {
            "entry_index": 0,
            "title": "Type Test",
            "start_epoch": 1714000000000,
            "end_epoch": 1714003600000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
            "pauses": [{"pause_start": 1000, "pause_stop": 2000}],
            "tags": ["type-a", "type-b"],
            "comment": "type comment",
            "media": [{"url": "https://example.com/img.jpg", "type": "image"}],
            "entry_id": "entry-types-1",
            "metadata": {"key": "value", "nested": {"deep": True}},
            "date": "2024-04-25",
            "device_uuid": "dev-j",
            "end_device_uuid": "dev-j",
        }
        cache.write_entries([dto])
        read_back = cache.read_entries()
        self.assertEqual(len(read_back), 1)
        r = read_back[0]
        self.assertEqual(r["title"], "Type Test")
        self.assertEqual(r["start_epoch"], 1714000000000)
        self.assertEqual(r["end_epoch"], 1714003600000)
        self.assertEqual(r["duration"], 3600000)
        self.assertFalse(r["is_active"])
        self.assertFalse(r["is_paused"])
        self.assertEqual(len(r["pauses"]), 1)
        self.assertEqual(r["pauses"][0]["pause_start"], 1000)
        self.assertEqual(r["tags"], ["type-a", "type-b"])
        self.assertEqual(r["comment"], "type comment")
        self.assertEqual(r["media"][0]["url"], "https://example.com/img.jpg")
        self.assertEqual(r["metadata"]["key"], "value")
        self.assertEqual(r["metadata"]["nested"]["deep"], True)
        self.assertEqual(r["device_uuid"], "dev-j")
        self.assertEqual(r["end_device_uuid"], "dev-j")
        path.unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════
# Group D: CRUD Operations (~7 tests)
# ══════════════════════════════════════════════════════════════════════

class TestGroupD_CRUDOperations(unittest.TestCase):
    """D1–D7: append, update, pause, remove with encryption."""

    def setUp(self):
        self.crypto_mk = _mk_crypto()
        self.crypto_noauth = _mk_noauth()

    # ── D1: append with CryptoManager stores encrypted fields ───────

    def test_D1_append_with_crypto_stores_encrypted_fields(self):
        """append with CryptoManager stores encrypted startTime_enc,
        device_uuid_enc, pauses_enc, metadata_enc."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append(
            "Encrypted Entry", 1714000000000,
            device_uuid="dev-k",
            tags=["test"],
            metadata={"version": 1},
            is_active=True,
        )

        raw = store.read_entries()
        data = raw[0]["data"]

        # After I-02: encryptable field names are tokens, not _enc suffixes.
        # Verify no plain: prefixes remain in any values.
        for key, val in data.items():
            if isinstance(val, str) and val:
                self.assertFalse(
                    val.startswith("plain:"),
                    f"Value for key '{key}' must be encrypted, not plain: prefixed"
                )

        # Non-encryptable fields remain plaintext
        self.assertEqual(data["title"], "Encrypted Entry")
        self.assertEqual(data["tags"], ["test"])
        path.unlink(missing_ok=True)

    # ── D2: append with NoAuthCryptoManager stores plain: ───────────

    def test_D2_append_with_noauth_stores_plain_prefix(self):
        """append with NoAuthCryptoManager stores plain: prefixed fields."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_noauth, store)

        cache.append(
            "NoAuth Entry", 1714000000000,
            device_uuid="dev-l",
            is_active=True,
        )

        raw = store.read_entries()
        data = raw[0]["data"]
        self.assertTrue(
            data["startTime_enc"].startswith("plain:"),
            "NoAuthCryptoManager must produce plain: prefix"
        )
        path.unlink(missing_ok=True)

    # ── D3: update with CryptoManager re-encrypts modified fields ───

    def test_D3_update_with_crypto_reencrypts_modified_fields(self):
        """update with CryptoManager re-encrypts modified epoch fields."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append("Update Test", 1714000000000, device_uuid="dev-m", is_active=True)

        # End the task
        cache.update(0, {
            "end_epoch": 1714003600000,
            "is_active": False,
            "duration": 3600000,
        })

        raw = store.read_entries()
        data = raw[0]["data"]

        # After I-02: field names are encrypted tokens.
        # Verify all string values lack plain: prefix.
        for key, val in data.items():
            if isinstance(val, str) and val:
                self.assertFalse(
                    val.startswith("plain:"),
                    f"Value for key '{key}' must be encrypted after update"
                )

        # Read back — verify DTO correctness
        entries = cache.read_entries()
        self.assertEqual(entries[0]["end_epoch"], 1714003600000)
        self.assertFalse(entries[0]["is_active"])
        self.assertEqual(entries[0]["duration"], 3600000)
        path.unlink(missing_ok=True)

    # ── D4: update with NoAuthCryptoManager preserves plain: ────────

    def test_D4_update_with_noauth_preserves_plain_format(self):
        """update with NoAuthCryptoManager preserves plain: on modified fields."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_noauth, store)

        cache.append("NoAuth Update", 1714000000000, device_uuid="dev-n", is_active=True)
        cache.update(0, {
            "end_epoch": 1714003600000,
            "is_active": False,
        })

        raw = store.read_entries()
        data = raw[0]["data"]
        # endTime_enc should still have plain: prefix
        self.assertTrue(
            data["endTime_enc"].startswith("plain:"),
            "NoAuthCryptoManager update must preserve plain: prefix"
        )
        path.unlink(missing_ok=True)

    # ── D5: add_pause / close_pause preserve encryption ─────────────

    def test_D5_pause_operations_preserve_encryption(self):
        """add_pause and close_pause preserve encryption of pauses_enc."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append("Pause Test", 1714000000000, device_uuid="dev-o", is_active=True)

        # Add a pause
        cache.add_pause(0, 1714001000000)
        raw = store.read_entries()
        # After I-02: field names are tokens. Verify values lack plain: prefix.
        for key, val in raw[0]["data"].items():
            if isinstance(val, str) and val:
                self.assertFalse(
                    val.startswith("plain:"),
                    f"Value for key '{key}' must be encrypted after add_pause"
                )

        # Close the pause
        cache.close_pause(0, 1714002000000)
        raw = store.read_entries()
        for key, val in raw[0]["data"].items():
            if isinstance(val, str) and val:
                self.assertFalse(
                    val.startswith("plain:"),
                    f"Value for key '{key}' must remain encrypted after close_pause"
                )

        # Read back — verify pause data
        entries = cache.read_entries()
        pauses = entries[0]["pauses"]
        self.assertEqual(len(pauses), 1)
        self.assertEqual(pauses[0]["pause_start"], 1714001000000)
        self.assertEqual(pauses[0]["pause_stop"], 1714002000000)
        path.unlink(missing_ok=True)

    # ── D6: update_by_entry_id preserves encryption ─────────────────

    def test_D6_update_by_entry_id_preserves_encryption(self):
        """update_by_entry_id preserves encryption of modified fields."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append("EntryId Test", 1714000000000, device_uuid="dev-p", is_active=True)
        entries = cache.read_entries()
        eid = entries[0]["entry_id"]

        cache.update_by_entry_id(eid, {
            "end_epoch": 1714003600000,
            "is_active": False,
        })

        raw = store.read_entries()
        # After I-02: field names are tokens. Verify values lack plain: prefix.
        for key, val in raw[0]["data"].items():
            if isinstance(val, str) and val:
                self.assertFalse(
                    val.startswith("plain:"),
                    f"Value for key '{key}' must be encrypted after update_by_entry_id"
                )

        entries = cache.read_entries()
        self.assertEqual(entries[0]["end_epoch"], 1714003600000)
        self.assertFalse(entries[0]["is_active"])
        path.unlink(missing_ok=True)

    # ── D7: delete with encrypted entries ───────────────────────────

    def test_D7_delete_works_with_encrypted_entries(self):
        """delete and remove_multiple work correctly with encrypted entries."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append("Keep", 1714000000000, device_uuid="dev-q", is_active=True)
        cache.append("Delete Me", 1714100000000, device_uuid="dev-q", is_active=True)
        cache.append("Keep Too", 1714200000000, device_uuid="dev-q", is_active=True)

        self.assertEqual(len(cache.read_entries()), 3)

        # Delete single entry
        cache.delete(1)  # Remove "Delete Me"
        entries = cache.read_entries()
        self.assertEqual(len(entries), 2)
        titles = {e["title"] for e in entries}
        self.assertIn("Keep", titles)
        self.assertIn("Keep Too", titles)
        self.assertNotIn("Delete Me", titles)

        # Remove multiple: the remaining two
        indices = sorted([e["entry_index"] for e in cache.read_entries()])
        cache.remove_multiple(indices)
        self.assertEqual(len(cache.read_entries()), 0)
        path.unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════
# Group E: Round-Trip Integrity (~4 tests)
# ══════════════════════════════════════════════════════════════════════

class TestGroupE_RoundTripIntegrity(unittest.TestCase):
    """E1–E4: write → read round-trips preserve data integrity."""

    def setUp(self):
        self.crypto_mk = _mk_crypto()

    # ── E1: Write with CryptoManager → read → identical DTOs ────────

    def test_E1_write_read_same_crypto_produces_identical_dtos(self):
        """Full round-trip: encrypt → persist → decrypt → identical."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        original_dtos = [
            {
                "entry_index": 0,
                "title": "RT Task 1",
                "start_epoch": 1714000000000,
                "end_epoch": 1714003600000,
                "duration": 3600000,
                "is_active": False,
                "is_paused": False,
                "pauses": [],
                "tags": ["roundtrip"],
                "comment": "rt comment",
                "media": [],
                "entry_id": "rt-entry-1",
                "metadata": {"rt_key": "rt_value"},
                "date": "2024-04-25",
                "device_uuid": "dev-r",
                "end_device_uuid": "",
            },
        ]
        cache.write_entries(original_dtos)
        read_back = cache.read_entries()

        self.assertEqual(len(read_back), 1)
        for key in ["title", "start_epoch", "end_epoch", "duration",
                     "is_active", "is_paused", "tags", "comment",
                     "entry_id", "device_uuid"]:
            self.assertEqual(
                read_back[0][key], original_dtos[0][key],
                f"Field '{key}' mismatch in round-trip"
            )
        self.assertEqual(read_back[0]["metadata"], {"rt_key": "rt_value"})
        path.unlink(missing_ok=True)

    # ── E2: Write → read with new CryptoManager (same MK) ───────────

    def test_E2_different_crypto_instance_same_mk_works(self):
        """Different CryptoManager instances with same master key work."""
        store, path = _temp_staging_store()

        # Write with one instance
        cm1 = _mk_crypto()
        cache1 = LocalStagingCache(cm1, store)
        cache1.append("Shared Key", 1714000000000, device_uuid="dev-s", is_active=True)

        # Read with a different instance (same MK derivation)
        cm2 = _mk_crypto()
        cache2 = LocalStagingCache(cm2, store)
        entries = cache2.read_entries()

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Shared Key")
        self.assertEqual(entries[0]["start_epoch"], 1714000000000)
        path.unlink(missing_ok=True)

    # ── E3: Different MK → graceful failure ─────────────────────────

    def test_E3_different_master_key_fails_gracefully(self):
        """Data encrypted with mk1 is skipped (not crashed) when read with mk2."""
        store, path = _temp_staging_store()

        # Write with mk1
        mk1 = hashlib.pbkdf2_hmac("sha256", b"password-1", b"salt-1", 100, 32)
        cache1 = LocalStagingCache(CryptoManager(mk1), store)
        cache1.append("MK1 Data", 1714000000000, device_uuid="dev-t", is_active=True)

        # Read with mk2
        mk2 = hashlib.pbkdf2_hmac("sha256", b"password-2", b"salt-2", 100, 32)
        cache2 = LocalStagingCache(CryptoManager(mk2), store)
        entries = cache2.read_entries()

        # Entry should be skipped (can't decrypt with wrong key) — not crash
        self.assertEqual(
            len(entries), 0,
            "Entries encrypted with different MK must be skipped, not crash"
        )
        path.unlink(missing_ok=True)

    # ── E4: Double round-trip (write → read → write → read) ────────

    def test_E4_double_roundtrip_preserves_all_fields(self):
        """Write → read → write → read preserves all fields (idempotency)."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        # First write
        cache.append("Two RT", 1714000000000, end_epoch=1714003600000,
                      device_uuid="dev-u", tags=["a", "b"], comment="double",
                      is_active=False)

        # Read → write back
        entries = cache.read_entries()
        cache.write_entries(entries)

        # Read again
        final = cache.read_entries()
        self.assertEqual(len(final), 1)
        self.assertEqual(final[0]["title"], "Two RT")
        self.assertEqual(final[0]["start_epoch"], 1714000000000)
        self.assertEqual(final[0]["end_epoch"], 1714003600000)
        self.assertEqual(final[0]["tags"], ["a", "b"])
        self.assertEqual(final[0]["comment"], "double")
        self.assertEqual(final[0]["device_uuid"], "dev-u")
        path.unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════
# Group F: _raw_entry_to_dto Remote Blob Parsing (~5 tests)
# ══════════════════════════════════════════════════════════════════════

class TestGroupF_RawEntryToDTO(unittest.TestCase):
    """F1–F5: _raw_entry_to_dto handles plain:, encrypted, and mixed entries."""

    def setUp(self):
        self.crypto_mk = _mk_crypto()

    # ── Helper: call _raw_entry_to_dto with optional crypto ─────────

    def _parse(self, raw_entry, crypto=None):
        """Call _raw_entry_to_dto, passing crypto if the method accepts it."""
        # Import here so this test file works with future signature changes
        from domain.staging.service import StagingService
        try:
            return StagingService._raw_entry_to_dto(raw_entry, crypto=crypto)
        except TypeError:
            # Fallback: current signature (no crypto param)
            return StagingService._raw_entry_to_dto(raw_entry)

    # ── F1: plain: entries (current format) ─────────────────────────

    def test_F1_parse_plain_remote_entry_returns_correct_dto(self):
        """Backward compat: remote blob with plain: entries returns DTOs."""
        raw = _build_plain_entry(
            "Remote Task", 1714000000000, end_epoch=1714003600000,
            device_uuid="remote-dev-1",
            tags=["remote"],
            entry_id="remote-eid-1"
        )
        dto = self._parse(raw)
        self.assertIsNotNone(dto)
        self.assertEqual(dto["title"], "Remote Task")
        self.assertEqual(dto["start_epoch"], 1714000000000)
        self.assertEqual(dto["end_epoch"], 1714003600000)
        self.assertEqual(dto["device_uuid"], "remote-dev-1")
        self.assertEqual(dto["tags"], ["remote"])
        self.assertEqual(dto["source"], "remote")

    # ── F2: encrypted remote entries (hex ciphertext) ───────────────

    def test_F2_parse_encrypted_remote_entry_returns_correct_dto(self):
        """New format: remote blob with encrypted entries returns DTOs."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)
        cache.append("Enc Remote", 1714000000000, device_uuid="remote-dev-2",
                      tags=["enc"], is_active=True)
        raw = store.read_entries()[0]

        dto = self._parse(raw, crypto=self.crypto_mk)
        # If dto is None, the encrypted entry isn't being decrypted yet (RED)
        # After Phase 3, this must return a valid DTO
        self.assertIsNotNone(
            dto,
            "_raw_entry_to_dto must handle encrypted (hex) entries after I-03"
        )
        if dto is not None:
            self.assertEqual(dto["title"], "Enc Remote")
            self.assertEqual(dto["start_epoch"], 1714000000000)
            self.assertEqual(dto["device_uuid"], "remote-dev-2")
        path.unlink(missing_ok=True)

    # ── F3: mixed remote entries ────────────────────────────────────

    def test_F3_parse_mixed_remote_entries_works(self):
        """Mixed: some plain:, some encrypted entries in same blob."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        # Write an encrypted entry
        cache.append("Post-auth", 1714100000000, device_uuid="remote-dev-3",
                      is_active=True)

        # Build a plain: entry manually
        plain_entry = _build_plain_entry(
            "Pre-auth", 1714000000000, device_uuid="remote-dev-3"
        )

        # Parse both
        raw_enc = store.read_entries()[0]
        dto_enc = self._parse(raw_enc, crypto=self.crypto_mk)
        dto_plain = self._parse(plain_entry)

        # plain: entry must always work
        self.assertIsNotNone(dto_plain)
        self.assertEqual(dto_plain["title"], "Pre-auth")

        # encrypted entry must work after I-03
        self.assertIsNotNone(
            dto_enc,
            "_raw_entry_to_dto must handle encrypted entries after I-03"
        )
        if dto_enc is not None:
            self.assertEqual(dto_enc["title"], "Post-auth")
        path.unlink(missing_ok=True)

    # ── F4: corrupt remote entry → None ─────────────────────────────

    def test_F4_corrupt_remote_entry_returns_none(self):
        """Corrupt remote entry returns None, doesn't crash."""
        corrupt = {"hash": "bad", "data": {"startTime_enc": "not-hex-not-plain"}}
        dto = self._parse(corrupt)
        self.assertIsNone(dto, "Corrupt remote entry must return None, not crash")

    # ── F5: committed flag preserved ────────────────────────────────

    def test_F5_committed_flag_preserved_in_remote_dto(self):
        """committed flag on remote entries survives parsing."""
        raw = _build_plain_entry("Committed Task", 1714000000000)
        raw["committed"] = True
        raw["block_index"] = 5
        dto = self._parse(raw)
        self.assertIsNotNone(dto)
        self.assertTrue(dto.get("committed"), "committed flag must be preserved")
        self.assertEqual(dto.get("block_index"), 5, "block_index must be preserved")


# ══════════════════════════════════════════════════════════════════════
# Group G: Service Integration (Full Flow) (~6 tests)
# ══════════════════════════════════════════════════════════════════════

class TestGroupG_ServiceIntegration(unittest.TestCase):
    """G1–G6: capture, end, push, reconcile flows with encryption."""

    def setUp(self):
        self.crypto_mk = _mk_crypto()

    # ── G1: capture → read_entries: encrypted on disk, DTOs correct ─

    def test_G1_capture_read_entries_encrypted_disk_correct_dtos(self):
        """capture stores encrypted on disk, read_entries returns correct DTOs."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append("Captured", 1714000000000, device_uuid="dev-v",
                      tags=["g1"], is_active=True)

        # DTOs must be correct
        entries = cache.read_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Captured")
        self.assertEqual(entries[0]["start_epoch"], 1714000000000)

        # Raw storage must be encrypted (no plain:)
        raw = store.read_entries()
        for key, val in raw[0]["data"].items():
            if isinstance(val, str) and val:
                self.assertFalse(val.startswith("plain:"),
                                 f"capture must encrypt field '{key}'")
        path.unlink(missing_ok=True)

    # ── G2: end → read_entries: end_epoch encrypted, DTO correct ────

    def test_G2_end_read_entries_end_epoch_encrypted(self):
        """End task: end_epoch encrypted on disk, DTO shows correct value."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append("To End", 1714000000000, device_uuid="dev-w", is_active=True)
        cache.update(0, {
            "end_epoch": 1714007200000,
            "is_active": False,
            "duration": 7200000,
        })

        # DTO must show end_epoch
        entries = cache.read_entries()
        self.assertEqual(entries[0]["end_epoch"], 1714007200000)
        self.assertFalse(entries[0]["is_active"])

        # Raw storage must have encrypted values (no plain: prefix)
        raw = store.read_entries()
        data = raw[0]["data"]
        # After I-02: field names are tokens. Verify all string values lack plain: prefix.
        for key, val in data.items():
            if isinstance(val, str) and val:
                self.assertFalse(
                    val.startswith("plain:"),
                    f"Value for key '{key}' must be encrypted after end()"
                )
        path.unlink(missing_ok=True)

    # ── G3: push_to_remote with encrypted local entries ─────────────

    def test_G3_push_encrypted_entries_to_remote_transport(self):
        """Local encrypted entries serialized without leaking plaintext.
        The raw storage format must contain hex ciphertext, not plain:."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append("Push Test", 1714000000000, device_uuid="dev-x",
                      tags=["push"], is_active=True)

        # Simulate: read raw entries (as push_to_remote would)
        raw = cache._store.read_entries()
        data = raw[0]["data"]

        # Encrypted fields must be hex, not plain:
        for key, val in data.items():
            if isinstance(val, str) and val:
                self.assertFalse(
                    val.startswith("plain:"),
                    f"'{key}' must be hex ciphertext for transport"
                )
        path.unlink(missing_ok=True)

    # ── G4: merge local encrypted + remote encrypted (same device) ──

    def test_G4_merge_local_encrypted_with_remote_encrypted_same_device(self):
        """Merge local encrypted entries with remote encrypted (same device)."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append("Local Only", 1714000000000, device_uuid="dev-y", is_active=True)

        # Simulate "remote" entries (write to same store as if from remote)
        remote_dto = {
            "entry_index": -1,
            "title": "Remote Only",
            "start_epoch": 1714010000000,
            "end_epoch": None,
            "duration": 0,
            "is_active": True,
            "is_paused": False,
            "pauses": [],
            "tags": ["remote-src"],
            "comment": None,
            "media": [],
            "entry_id": "remote-eid-y",
            "metadata": {},
            "date": "2024-04-25",
            "source": "remote",
            "device_uuid": "dev-y",
            "end_device_uuid": "",
            "committed": False,
        }

        # Merge with local
        from domain.staging.merge_engine import MergeEngine
        merge = MergeEngine()
        merged = merge.merge(
            cache.read_entries(),
            [remote_dto]
        )

        # Write merged back
        cache.write_entries(merged)
        entries = cache.read_entries()

        titles = {e["title"] for e in entries}
        self.assertIn("Local Only", titles)
        self.assertIn("Remote Only", titles)
        self.assertEqual(len(entries), 2)

        # All entries must be encrypted on disk
        raw = store.read_entries()
        for entry in raw:
            for key, val in entry.get("data", {}).items():
                if isinstance(val, str) and val:
                    self.assertFalse(val.startswith("plain:"),
                                     f"Merged entry key '{key}' must be encrypted")
        path.unlink(missing_ok=True)

    # ── G5: merge local encrypted + remote encrypted (diff device) ──

    def test_G5_merge_cross_device_encrypted_entries(self):
        """Cross-device merge: different device_uuid, both encrypted."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        cache.append("Dev-A Entry", 1714000000000, device_uuid="dev-a1", is_active=True)

        remote_dto = {
            "entry_index": -1,
            "title": "Dev-B Entry",
            "start_epoch": 1714010000000,
            "end_epoch": None,
            "duration": 0,
            "is_active": True,
            "is_paused": False,
            "pauses": [],
            "tags": ["dev-b"],
            "comment": None,
            "media": [],
            "entry_id": "remote-eid-b",
            "metadata": {},
            "date": "2024-04-25",
            "source": "remote",
            "device_uuid": "dev-b1",
            "end_device_uuid": "",
            "committed": False,
        }

        from domain.staging.merge_engine import MergeEngine
        merge = MergeEngine()
        merged = merge.merge(cache.read_entries(), [remote_dto])
        cache.write_entries(merged)

        entries = cache.read_entries()
        titles = {e["title"] for e in entries}
        self.assertIn("Dev-A Entry", titles)
        self.assertIn("Dev-B Entry", titles)

        # All on disk must be encrypted
        raw = store.read_entries()
        for entry in raw:
            for key, val in entry.get("data", {}).items():
                if isinstance(val, str) and val:
                    self.assertFalse(val.startswith("plain:"),
                                     f"Cross-device merged entry key '{key}' must be encrypted")
        path.unlink(missing_ok=True)

    # ── G6: full check_and_sync fast path with encryption ───────────

    def test_G6_full_fast_path_flow_with_encryption(self):
        """Full fast-path sync: pull → merge → push all with encryption."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        # Start with local encrypted entries
        cache.append("Local A", 1714000000000, device_uuid="dev-z", is_active=True)

        # Simulate remote pull (same device entries in encrypted format)
        remote_dto = {
            "entry_index": -1,
            "title": "Remote A",
            "start_epoch": 1714010000000,
            "end_epoch": None,
            "duration": 0,
            "is_active": True,
            "is_paused": False,
            "pauses": [],
            "tags": [],
            "comment": None,
            "media": [],
            "entry_id": "remote-eid-z",
            "metadata": {},
            "date": "2024-04-25",
            "source": "remote",
            "device_uuid": "dev-z",
            "end_device_uuid": "",
            "committed": False,
        }

        # Merge
        from domain.staging.merge_engine import MergeEngine
        merge = MergeEngine()
        merged = merge.merge(cache.read_entries(), [remote_dto])
        cache.write_entries(merged)

        # After merge: both entries readable, encrypted on disk
        entries = cache.read_entries()
        self.assertEqual(len(entries), 2)
        self.assertIn("Local A", {e["title"] for e in entries})
        self.assertIn("Remote A", {e["title"] for e in entries})

        raw = store.read_entries()
        for entry in raw:
            for key, val in entry.get("data", {}).items():
                if isinstance(val, str) and val:
                    self.assertFalse(val.startswith("plain:"),
                                     f"Fast-path merged entry key '{key}' must be encrypted")
        path.unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════
# Group H: Backward Compatibility — Migration (~4 tests)
# ══════════════════════════════════════════════════════════════════════

class TestGroupH_MigrationBackwardCompat(unittest.TestCase):
    """H1–H4: Upgrade path and cross-client backward compatibility."""

    def setUp(self):
        self.crypto_mk = _mk_crypto()
        self.crypto_noauth = _mk_noauth()

    # ── H1: existing plain: staging readable after upgrade ──────────

    def test_H1_existing_plain_staging_readable_after_upgrade(self):
        """Existing staging.json with plain: fields is readable after I-03 upgrade."""
        store, path = _temp_staging_store()
        raw = [
            _build_plain_entry("Legacy Task", 1714000000000, end_epoch=1714003600000,
                                device_uuid="legacy-dev", tags=["old"]),
        ]
        _write_raw_entries(store, raw)

        # Now access with CryptoManager (upgraded client)
        cache = LocalStagingCache(self.crypto_mk, store)
        entries = cache.read_entries()

        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Legacy Task")
        self.assertEqual(entries[0]["start_epoch"], 1714000000000)
        self.assertEqual(entries[0]["end_epoch"], 1714003600000)
        self.assertEqual(entries[0]["device_uuid"], "legacy-dev")
        self.assertEqual(entries[0]["tags"], ["old"])
        path.unlink(missing_ok=True)

    # ── H2: read plain: → write with CryptoManager → encrypted ──────

    def test_H2_upgrade_path_plain_to_encrypted(self):
        """Read existing plain: → write with CryptoManager → format now encrypted."""
        store, path = _temp_staging_store()
        raw = [
            _build_plain_entry("Upgrade Me", 1714000000000, device_uuid="up-dev"),
        ]
        _write_raw_entries(store, raw)

        # Read with CryptoManager, write back
        cache = LocalStagingCache(self.crypto_mk, store)
        entries = cache.read_entries()
        self.assertEqual(entries[0]["title"], "Upgrade Me")

        # Write back (should upgrade to encrypted format after Phase 3)
        cache.write_entries(entries)

        # Verify on disk: now encrypted (no plain: in any value)
        raw_after = store.read_entries()
        for key, val in raw_after[0]["data"].items():
            if isinstance(val, str) and val:
                self.assertFalse(
                    val.startswith("plain:"),
                    f"After write with CryptoManager, value for '{key}' must be encrypted"
                )
        path.unlink(missing_ok=True)

    # ── H3: read plain: → write with NoAuthCryptoManager → still plain:

    def test_H3_noauth_preserves_plain_format_on_upgrade(self):
        """Read existing plain: → write with NoAuthCryptoManager → still plain:."""
        store, path = _temp_staging_store()
        raw = [
            _build_plain_entry("Stay Plain", 1714000000000, device_uuid="np-dev"),
        ]
        _write_raw_entries(store, raw)

        cache = LocalStagingCache(self.crypto_noauth, store)
        entries = cache.read_entries()
        cache.write_entries(entries)

        raw_after = store.read_entries()
        self.assertTrue(
            raw_after[0]["data"]["startTime_enc"].startswith("plain:"),
            "NoAuthCryptoManager must preserve plain: format"
        )
        path.unlink(missing_ok=True)

    # ── H4: remote blob with old plain: entries parsed during sync ──

    def test_H4_remote_blob_with_old_plain_entries_parsed_correctly(self):
        """Remote staging blob with plain: entries parses correctly."""
        raw = _build_plain_entry(
            "Old Remote", 1714000000000, device_uuid="old-remote",
            tags=["legacy"]
        )

        from domain.staging.service import StagingService
        dto = StagingService._raw_entry_to_dto(raw)
        self.assertIsNotNone(dto)
        self.assertEqual(dto["title"], "Old Remote")
        self.assertEqual(dto["tags"], ["legacy"])
        self.assertEqual(dto["source"], "remote")


# ══════════════════════════════════════════════════════════════════════
# Group J: Edge Cases (~5 tests)
# ══════════════════════════════════════════════════════════════════════

class TestGroupJ_EdgeCases(unittest.TestCase):
    """J1–J5: Long text, unicode, null/empty, scale, plain: false positive."""

    def setUp(self):
        self.crypto_mk = _mk_crypto()

    # ── J1: very long title (>256 chars) ─────────────────────────────

    def test_J1_very_long_title_survives_encryption_roundtrip(self):
        """Very long title (>256 chars) round-trips through encryption."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        long_title = "A" * 500
        cache.append(long_title, 1714000000000, device_uuid="dev-long",
                      is_active=True)

        entries = cache.read_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], long_title)
        self.assertEqual(len(entries[0]["title"]), 500)
        path.unlink(missing_ok=True)

    # ── J2: Unicode in title/tags/comment ────────────────────────────

    def test_J2_unicode_survives_encryption_roundtrip(self):
        """Non-ASCII data (emoji, CJK, accents) survives round-trip."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        unicode_title = "Café résumé — 日本語 🎉"
        unicode_tags = ["über", "café", "こんにちは"]
        unicode_comment = "Emoji: 🚀✨ Stars and 中文 characters"

        cache.append(unicode_title, 1714000000000,
                      device_uuid="dev-uni", tags=unicode_tags,
                      comment=unicode_comment, is_active=True)

        entries = cache.read_entries()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["title"], unicode_title)
        self.assertEqual(e["tags"], sorted([t.lower() for t in unicode_tags]))
        self.assertEqual(e["comment"], unicode_comment)
        path.unlink(missing_ok=True)

    # ── J3: Empty strings and None values ────────────────────────────

    def test_J3_empty_strings_and_none_values_handled_correctly(self):
        """Empty strings and None values handled across encryption boundary."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        # Active task with no end_epoch (None)
        cache.append("Active No End", 1714000000000, device_uuid="dev-null",
                      is_active=True)

        entries = cache.read_entries()
        e = entries[0]
        self.assertIsNone(e["end_epoch"], "end_epoch must be None for active task")
        self.assertEqual(e["device_uuid"], "dev-null")

        # Empty device_uuid
        cache.append("Empty Device", 1714100000000, device_uuid="",
                      is_active=True)
        entries = cache.read_entries()
        self.assertEqual(entries[1]["device_uuid"], "")
        path.unlink(missing_ok=True)

    # ── J4: Many entries (50+) read/write ────────────────────────────

    def test_J4_many_entries_read_write_correct(self):
        """Many entries (50+) read/write correctly."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        N = 50
        for i in range(N):
            cache.append(
                f"Bulk Task {i:03d}",
                1714000000000 + i * 1000,
                device_uuid=f"dev-bulk",
                is_active=True,
                tags=[f"bulk-{i % 5}"],
            )

        entries = cache.read_entries()
        self.assertEqual(len(entries), N)

        # Verify all entries are encrypted on disk
        raw = store.read_entries()
        for entry in raw:
            for key, val in entry.get("data", {}).items():
                if isinstance(val, str) and val:
                    self.assertFalse(val.startswith("plain:"),
                                     f"Bulk entry key '{key}' must be encrypted")

        # Verify all entries readable
        titles = {e["title"] for e in entries}
        for i in range(N):
            self.assertIn(f"Bulk Task {i:03d}", titles)
        path.unlink(missing_ok=True)

    # ── J5: "plain:" in user data not misinterpreted ─────────────────

    def test_J5_plain_string_in_title_not_misinterpreted(self):
        """'plain:' in user data (e.g., title) not treated as encryption prefix.
        The decrypt path checks the prefix on encrypted fields, not user fields."""
        store, path = _temp_staging_store()
        cache = LocalStagingCache(self.crypto_mk, store)

        # Title contains "plain:" literally
        sneaky_title = "plain: pancake recipe"
        cache.append(sneaky_title, 1714000000000, device_uuid="dev-sneak",
                      is_active=True)

        entries = cache.read_entries()
        self.assertEqual(entries[0]["title"], sneaky_title)

        # After I-02: field names are tokens. Verify encryptable values
        # lack plain: prefix, but non-encryptable fields (title, tags, etc.) may
        # legitimately contain "plain:" in user data.
        raw = store.read_entries()
        non_encryptable = {"title", "duration", "is_active", "is_paused",
                           "tags", "comment", "media", "entry_id"}
        for key, val in raw[0]["data"].items():
            if key not in non_encryptable and isinstance(val, str) and val:
                self.assertFalse(
                    val.startswith("plain:"),
                    f"Encryptable value for key '{key}' must be encrypted"
                )
        path.unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
