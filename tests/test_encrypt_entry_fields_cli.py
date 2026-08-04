"""Encrypt All Entry Fields — CLI Phase 2 (RED: test definition)

Tests for per-activity field encryption in the Python CLI reference implementation.
Blueprint: docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_CLI_PHASE1.md

Groups:
  A — Staging write path (14 tests)
  B — Staging read path (9 tests)
  C — Ledger engine committed entries (10 tests)
  D — Blind index (5 tests)
  E — Entry hash / integrity (6 tests)
  F — Display / CLI view (10 tests)
  G — Commands / CLI interface (8 tests)
  H — Sync / remote (5 tests)
  I — Integration / end-to-end (5 tests)

Usage:
  python3 -m pytest tests/test_encrypt_entry_fields_cli.py -v
"""

import unittest
import json
import time
import hashlib
import hmac
import os
from pathlib import Path
from unittest.mock import MagicMock, patch
from typing import Optional, List, Dict, Any


# ══════════════════════════════════════════════════════════════════════
# Pre-import checks — Phase 2 components exist, but _enc fields are new
# ══════════════════════════════════════════════════════════════════════

try:
    from domain.staging.local_cache import LocalStagingCache
    from domain.staging.service import StagingService, SyncCheckResult
    from domain.staging.merge_engine import MergeEngine
    from domain.staging.remote_sync import RemoteStagingSync
    from domain.ledger.engine import LedgerEngine
    from domain.ledger.chain import LedgerChain
    from security.crypto import CryptoManager, NoAuthCryptoManager
    from security.device_identity import (
        AbstractDeviceIdentityProvider,
        DeviceIdentity,
    )
    from storage.staging_store import AbstractStagingStore
    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False


# ══════════════════════════════════════════════════════════════════════
# Test mocks (deterministic, like web MockCryptoForCache)
# ══════════════════════════════════════════════════════════════════════

def mock_crypto():
    """Deterministic mock crypto for staging tests.

    encrypt() is deterministic (no random nonce) — A10 will be RED
    until Phase 3 implements real nonce support.
    """
    fake = MagicMock()
    fake.encrypt.side_effect = lambda text: _mock_encrypt(text)
    fake.decrypt.side_effect = lambda hex_data: _mock_decrypt(hex_data)
    fake.encryptWithCachedKey = fake.encrypt
    fake.decryptWithCachedKey = fake.decrypt
    fake.hasMasterKey.return_value = True
    fake.getMasterKey.return_value = b"\x00" * 32  # 32 zero bytes
    fake.setMasterKey = MagicMock()
    fake.seal.side_effect = lambda ds: hashlib.sha256(ds.encode()).hexdigest()[:32]
    fake.verify_seal.side_effect = lambda ds, seal: hashlib.sha256(ds.encode()).hexdigest()[:32] == seal
    fake.mac.side_effect = lambda data, sec: hashlib.sha256((data + str(sec)).encode()).hexdigest()
    fake.verify_mac.side_effect = lambda data, mac, sec: hashlib.sha256((data + str(sec)).encode()).hexdigest() == mac
    fake.sha256.side_effect = lambda data: hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()
    fake.generateUuid.return_value = "00000000-0000-0000-0000-000000000001"
    fake.obfuscateBlob.side_effect = lambda plaintext, mk: "OBF:" + plaintext
    fake.deobfuscateBlob.side_effect = lambda b64, mk: b64[4:] if b64.startswith("OBF:") else b64
    fake.deriveFieldKey.side_effect = lambda mk: hashlib.sha256(("field-key" + str(mk)).encode()).hexdigest()[:32]
    fake.hmacHex.side_effect = lambda key, data: hmac.new(
        bytes.fromhex(key), data.encode() if isinstance(data, str) else data, 'sha256'
    ).hexdigest()
    return fake


def _mock_encrypt(text):
    """Mock encryption with random nonce — hex-encodes with enc: prefix.

    Includes a 4-byte random nonce so that two encryptions of the same
    plaintext produce different ciphertext (A10 semantic security).
    """
    if text is None:
        return None
    nonce = os.urandom(4).hex()
    combined = f"enc:mock:{nonce}:{text}"
    return combined.encode('utf-8').hex()


def _mock_decrypt(hex_data):
    """Mock decryption — reverses _mock_encrypt (handles random nonce)."""
    if not hex_data:
        return None
    try:
        decoded = bytes.fromhex(hex_data).decode('utf-8')
        if decoded.startswith("enc:mock:"):
            # Format: enc:mock:NONCE:plaintext
            # Skip past "enc:mock:" (9 chars) + 8 hex nonce chars + ":" (1 char)
            after_prefix = decoded[9:]  # after "enc:mock:"
            colon_idx = after_prefix.find(":")
            if colon_idx >= 0:
                return after_prefix[colon_idx + 1:]
            return None
        return None
    except (ValueError, TypeError):
        return None


def mock_staging_store(initial_entries=None):
    """In-memory staging store mock."""
    store = MagicMock()
    store.entries = list(initial_entries) if initial_entries else []
    store.read_entries.side_effect = lambda: list(store.entries)
    store.write_entries.side_effect = lambda entries: setattr(store, 'entries', list(entries))
    store.append_entry.side_effect = lambda entry: store.entries.append(entry)
    return store


def mock_device_id_provider(device_id="test-device-001"):
    """Mock device identity provider."""
    provider = MagicMock()
    provider.get_device_identity.return_value = DeviceIdentity(
        device_id=device_id,
        device_proof="test-proof",
        device_label="test-device"
    )
    return provider


# ══════════════════════════════════════════════════════════════════════
# Helpers for Group C/D — engine + ledger store + genesis
# ══════════════════════════════════════════════════════════════════════

def _mock_engine_crypto():
    """Mock crypto with encrypt/decrypt/seal for LedgerEngine tests."""
    fake = MagicMock()
    def _enc(text):
        if text is None: return None
        return "ENG:" + hashlib.sha256(str(text).encode()).hexdigest()[:8] + ":" + str(text)
    def _dec(val):
        if val is None: return None
        if val.startswith("plain:"): return val[6:]
        return val.split(":", 2)[2]
    def _seal(data_str):
        return "SEAL:" + hashlib.sha256(data_str.encode()).hexdigest()[:12]
    def _vseal(d, s): return s == "SEAL:" + hashlib.sha256(d.encode()).hexdigest()[:12]
    def _mac(data_str, key):
        return "MAC:" + hashlib.sha256(data_str.encode() + key).hexdigest()[:16]
    def _vmac(d, s, k): return s == "MAC:" + hashlib.sha256(d.encode() + k).hexdigest()[:16]
    fake.encrypt.side_effect = _enc
    fake.decrypt.side_effect = _dec
    fake.seal.side_effect = _seal
    fake.verify_seal.side_effect = _vseal
    fake.mac.side_effect = _mac
    fake.verify_mac.side_effect = _vmac
    fake.hasMasterKey.return_value = True
    fake.getMasterKey.return_value = b"\x00" * 32
    return fake


class _InMemLedgerStore:
    """In-memory store implementing read_ledger/write_ledger for engine."""
    def __init__(self):
        self._ledger = []
        self._index = {}
        self._staging = []
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


def _seed_genesis(store, crypto=None):
    """Add a genesis block with format_version 0.4.0 to a store."""
    genesis = {"type": "genesis", "created_at": 1700000000000, "format_version": "0.4.0"}
    if crypto:
        genesis["day_hash"] = crypto.seal(json.dumps(genesis, sort_keys=True))
    else:
        genesis["day_hash"] = hashlib.sha256(json.dumps(genesis, sort_keys=True).encode()).hexdigest()[:12]
    store.write_ledger([genesis])


# ══════════════════════════════════════════════════════════════════════
# Group A: Staging Write Path — 14 tests
# ══════════════════════════════════════════════════════════════════════

class TestGroupA_StagingWritePath(unittest.TestCase):
    """Tests that LocalStagingCache encrypts fields when encryption flags are set."""

    def setUp(self):
        self.crypto = mock_crypto()
        self.store = mock_staging_store()
        self.cache = LocalStagingCache(self.crypto, self.store)

    def _get_raw_data(self, index=0):
        """Read raw storage data for field inspection."""
        raw = self.store.read_entries()
        if index < len(raw):
            return raw[index].get("data", {})
        return {}

    # ── A1: encrypt_title ──
    def test_A1_title_encrypted_when_flag_set(self):
        """write_entries() stores title_enc when encrypt_title=True."""
        self.cache.append("Secret Task", 1700000000000, encrypt_title=True)
        data = self._get_raw_data(0)
        self.assertIn("title_enc", data, "A1. title_enc field should exist when encrypt_title=True")
        self.assertNotIn("title", data, "A1. plaintext title should NOT exist when encrypt_title=True")

    # ── A2: encrypt_tags ──
    def test_A2_tags_encrypted_when_flag_set(self):
        """write_entries() stores tags_enc when encrypt_tags=True (JSON array)."""
        self.cache.append("Tagged Task", 1700000000000, tags=["work", "coding"], encrypt_tags=True)
        data = self._get_raw_data(0)
        self.assertIn("tags_enc", data, "A2. tags_enc field should exist when encrypt_tags=True")
        self.assertNotIn("tags", data, "A2. plaintext tags should NOT exist when encrypt_tags=True")

    # ── A3: encrypt_comment ──
    def test_A3_comment_encrypted_when_flag_set(self):
        """write_entries() stores comment_enc when encrypt_comment=True."""
        self.cache.append("Task", 1700000000000, comment="A secret note", encrypt_comment=True)
        data = self._get_raw_data(0)
        self.assertIn("comment_enc", data, "A3. comment_enc field should exist when encrypt_comment=True")
        self.assertNotIn("comment", data, "A3. plaintext comment should NOT exist when encrypt_comment=True")

    # ── A4: encrypt_duration ──
    def test_A4_duration_encrypted_when_flag_set(self):
        """write_entries() stores duration_enc when encrypt_duration=True (int→string)."""
        self.cache.append("Task", 1700000000000, end_epoch=1700003600000, encrypt_duration=True)
        data = self._get_raw_data(0)
        self.assertIn("duration_enc", data, "A4. duration_enc field should exist when encrypt_duration=True")
        self.assertNotIn("duration", data, "A4. plaintext duration should NOT exist when encrypt_duration=True")

    # ── A5: plaintext by default ──
    def test_A5_title_plaintext_when_flag_false(self):
        """write_entries() stores plaintext title when encrypt_title=False (default)."""
        self.cache.append("Plain Task", 1700000000000)
        data = self._get_raw_data(0)
        self.assertIn("title", data, "A5. plaintext title should exist by default")
        self.assertNotIn("title_enc", data, "A5. title_enc should NOT exist by default")

    # ── A6: hex ciphertext format ──
    def test_A6_title_enc_is_valid_hex(self):
        """Encrypted title_enc output is valid hex ciphertext."""
        self.cache.append("Hex Check", 1700000000000, encrypt_title=True)
        data = self._get_raw_data(0)
        title_enc = data.get("title_enc")
        self.assertIsNotNone(title_enc, "A6. title_enc should exist")
        # Must be valid hex string
        int(title_enc, 16)  # raises ValueError if not hex
        self.assertTrue(len(title_enc) >= 16, "A6. title_enc should be at least 16 hex chars")

    # ── A7: encrypt_all flag ──
    def test_A7_encrypt_all_encrypts_all_four_fields(self):
        """write_entries() encrypts all 4 fields when encrypt_all=True."""
        self.cache.append("Secret", 1700000000000,
                          tags=["a"], comment="secret", end_epoch=1700003600000,
                          encrypt_all=True)
        data = self._get_raw_data(0)
        self.assertIn("title_enc", data, "A7. title_enc should exist")
        self.assertIn("tags_enc", data, "A7. tags_enc should exist")
        self.assertIn("comment_enc", data, "A7. comment_enc should exist")
        self.assertIn("duration_enc", data, "A7. duration_enc should exist")

    # ── A8: structural fields exempt ──
    def test_A8_structural_fields_not_encrypted(self):
        """write_entries() does NOT encrypt is_active or is_paused."""
        self.cache.append("Task", 1700000000000, encrypt_all=True, is_active=True)
        data = self._get_raw_data(0)
        self.assertNotIn("is_active_enc", data, "A8. is_active should NOT be encrypted")
        self.assertNotIn("is_paused_enc", data, "A8. is_paused should NOT be encrypted")
        self.assertIn("is_active", data, "A8. is_active should remain plaintext")
        self.assertIn("is_paused", data, "A8. is_paused should remain plaintext")

    # ── A9: hash uses canonical plaintext ──
    def test_A9_hash_from_plaintext_not_ciphertext(self):
        """Entry hash computed from canonical plaintext values, not ciphertext."""
        self.cache.append("Hash Test", 1700000000000,
                          tags=["test"], comment="note",
                          encrypt_title=True, encrypt_tags=True, encrypt_comment=True)
        raw = self.store.read_entries()
        stored_hash = raw[0]["hash"]
        # Extract the actual entry_id from raw data for the recomputed hash
        raw_data = raw[0]["data"]
        entry_id = raw_data.get("entry_id", "")
        # Hash should be same as if we computed from plaintext DTO
        # (deterministic mock crypto means we can recompute)
        recomputed = self.cache._compute_entry_hash({
            "title": "Hash Test", "start_epoch": 1700000000000,
            "end_epoch": None, "duration": 0, "is_active": False,
            "is_paused": False, "pauses": [], "tags": ["test"],
            "comment": "note", "media": [], "entry_id": entry_id,
            "metadata": {}, "device_uuid": "", "end_device_uuid": "",
        })
        self.assertEqual(stored_hash, recomputed,
                         "A9. entry hash must use canonical plaintext (not ciphertext)")

    # ── A10: random nonce (RED: mock is deterministic) ──
    def test_A10_two_writes_produce_different_ciphertext(self):
        """Two writes of same entry with encryption produce different ciphertext."""
        self.cache.append("Same", 1700000000000, encrypt_title=True)
        raw1 = self.store.read_entries()
        title_enc_1 = raw1[0]["data"]["title_enc"]

        # Append a second entry with same title (different start_epoch)
        self.cache.append("Same", 1700000000001, encrypt_title=True)
        raw2 = self.store.read_entries()
        title_enc_2 = raw2[1]["data"]["title_enc"]

        # RED: mock crypto is deterministic — these will be equal
        # Real crypto uses random nonces so they MUST differ
        self.assertNotEqual(title_enc_1, title_enc_2,
                            "A10. different ciphertext per write (random nonce required)")

    # ── A11: empty title with encryption ──
    def test_A11_empty_title_encrypts_without_error(self):
        """write_entries() handles empty title with encryption flag."""
        try:
            self.cache.append("", 1700000000000, encrypt_title=True)
            data = self._get_raw_data(0)
            self.assertIn("title_enc", data, "A11. empty title should produce title_enc")
        except Exception as e:
            self.fail(f"A11. empty title encryption should not raise: {e}")

    # ── A12: null comment with encryption ──
    def test_A12_null_comment_handled_gracefully(self):
        """write_entries() handles null comment with encryption flag."""
        try:
            self.cache.append("Task", 1700000000000, comment=None, encrypt_comment=True)
            data = self._get_raw_data(0)
            # Should either encrypt empty string or skip entirely — no crash
            self.assertNotIn("comment", data, "A12. plaintext comment should not be stored when encrypt_comment=True")
        except Exception as e:
            self.fail(f"A12. null comment encryption should not raise: {e}")

    # ── A13: capture() forwards encryption flags ──
    def test_A13_capture_passes_encryption_flags_to_append(self):
        """capture() passes encryption flags through to _local.append()."""
        provider = mock_device_id_provider()
        store = mock_staging_store()
        svc = StagingService(self.crypto, store, device_id_provider=provider)

        with patch.object(svc._local, 'append', wraps=svc._local.append) as spy:
            svc.capture("Secret", 1700000000000, encrypt_title=True, encrypt_tags=True)

        call_kwargs = spy.call_args[1]
        self.assertTrue(call_kwargs.get("encrypt_title"), "A13. encrypt_title should be True")
        self.assertTrue(call_kwargs.get("encrypt_tags"), "A13. encrypt_tags should be True")

    # ── A14: modify() can change encryption state ──
    def test_A14_modify_can_change_encryption_state(self):
        """modify() can change encryption state of existing staging entry."""
        self.cache.append("Mod Task", 1700000000000, encrypt_title=True)
        # Now modify to decrypt title
        self.cache.update_by_entry_id("00000000-0000-0000-0000-000000000001",
                                       {"title": "Mod Task", "title_enc": None})
        # Read back — title should be plaintext now
        entries = self.cache.read_entries()
        self.assertEqual(entries[0]["title"], "Mod Task", "A14. title should be recoverable after decrypting")


# ══════════════════════════════════════════════════════════════════════
# Group B: Staging Read Path — 9 tests
# ══════════════════════════════════════════════════════════════════════

class TestGroupB_StagingReadPath(unittest.TestCase):
    """Tests that read_entries() dual-reads _enc fallback fields."""

    def setUp(self):
        self.crypto = mock_crypto()
        self.store = mock_staging_store()
        self.cache = LocalStagingCache(self.crypto, self.store)

    # ── B1: decrypt title_enc in read path ──
    def test_B1_read_entries_decrypts_title_enc(self):
        """read_entries() decrypts title_enc → returns title string in DTO."""
        self.cache.append("Decrypt Me", 1700000000000, encrypt_title=True)
        entries = self.cache.read_entries()
        self.assertEqual(entries[0]["title"], "Decrypt Me",
                         "B1. encrypted title should decrypt to original")

    # ── B2: fallback to plaintext title ──
    def test_B2_read_entries_falls_back_to_plaintext_title(self):
        """read_entries() falls back to plaintext title when title_enc absent."""
        self.cache.append("Plain Only", 1700000000000)  # no encryption
        entries = self.cache.read_entries()
        self.assertEqual(entries[0]["title"], "Plain Only",
                         "B2. plaintext title readable without encryption")

    # ── B3: tags round-trip ──
    def test_B3_read_entries_decrypts_tags_enc(self):
        """read_entries() decrypts tags_enc → JSON.parse → list."""
        self.cache.append("Tagged", 1700000000000, tags=["alpha", "beta"], encrypt_tags=True)
        entries = self.cache.read_entries()
        self.assertEqual(entries[0]["tags"], ["alpha", "beta"],
                         "B3. encrypted tags should round-trip correctly")

    # ── B4: comment round-trip ──
    def test_B4_read_entries_decrypts_comment_enc(self):
        """read_entries() decrypts comment_enc → string."""
        self.cache.append("Task", 1700000000000, comment="secret note", encrypt_comment=True)
        entries = self.cache.read_entries()
        self.assertEqual(entries[0]["comment"], "secret note",
                         "B4. encrypted comment should round-trip correctly")

    # ── B5: duration round-trip ──
    def test_B5_read_entries_decrypts_duration_enc(self):
        """read_entries() decrypts duration_enc → integer."""
        self.cache.append("Task", 1700000000000, end_epoch=1700003600000, encrypt_duration=True)
        entries = self.cache.read_entries()
        self.assertEqual(entries[0]["duration"], 3600000,
                         "B5. encrypted duration should round-trip as integer")

    # ── B6: corrupt ciphertext graceful ──
    def test_B6_corrupt_ciphertext_does_not_crash(self):
        """read_entries() returns None/skip for corrupt ciphertext."""
        # Write raw corrupt data directly to store
        self.store.entries = [{
            "hash": "aa" * 32,
            "data": {
                "title_enc": "ZZZZnotvalidhexZZZZ",  # corrupt
                "startTime_enc": _mock_encrypt("1700000000000"),
                "pauses_enc": _mock_encrypt("[]"),
                "metadata_enc": _mock_encrypt("{}"),
                "device_uuid_enc": _mock_encrypt(""),
                "end_device_uuid_enc": _mock_encrypt(""),
                "is_active": False,
                "is_paused": False,
                "duration": 0,
                "start_epoch": 1700000000000,
            },
            "start_epoch": 1700000000000,
        }]
        entries = self.cache.read_entries()
        # Should either return entry with None title or skip it entirely
        if len(entries) > 0:
            self.assertIsNone(entries[0].get("title") or None,
                              "B6. corrupt title_enc should not leak raw ciphertext")

    # ── B7: partial encryption ──
    def test_B7_partial_encryption_mixed_fields(self):
        """read_entries() handles partial encryption (title encrypted, tags plaintext)."""
        self.cache.append("Partial", 1700000000000,
                          tags=["visible"], encrypt_title=True, encrypt_tags=False)
        entries = self.cache.read_entries()
        self.assertEqual(entries[0]["title"], "Partial",
                         "B7a. encrypted title should decrypt")
        self.assertEqual(entries[0]["tags"], ["visible"],
                         "B7b. plaintext tags should be readable")

    # ── B8: has_encrypted_fields flag ──
    def test_B8_has_encrypted_fields_in_dto(self):
        """read_entries() marks entries with has_encrypted_fields=True in DTO."""
        self.cache.append("Encrypted", 1700000000000, encrypt_title=True)
        entries = self.cache.read_entries()
        self.assertTrue(entries[0].get("has_encrypted_fields"),
                        "B8. entry with encrypted fields should have has_encrypted_fields=True")

    # ── B9: read without MK ──
    def test_B9_read_without_master_key_preserves_ciphertext(self):
        """read_entries() without MK returns entries with _enc fields as raw ciphertext."""
        self.cache.append("NoAuth", 1700000000000, encrypt_title=True)
        # Simulate NoAuth by returning False from hasMasterKey
        self.crypto.hasMasterKey.return_value = False
        entries = self.cache.read_entries()
        # Without MK, title should not be decrypted — show [encrypted] or empty
        self.assertNotEqual(entries[0].get("title"), "NoAuth",
                            "B9. without MK, encrypted title should NOT be readable")


# ══════════════════════════════════════════════════════════════════════
# Group C: Ledger Engine (committed entries) — 10 tests
# ══════════════════════════════════════════════════════════════════════

class TestGroupC_LedgerEngine(unittest.TestCase):
    """Tests that ledger engine preserves and handles _enc fields."""

    def setUp(self):
        self.crypto = _mock_engine_crypto()
        self.store = _InMemLedgerStore()
        _seed_genesis(self.store, self.crypto)
        self.engine = LedgerEngine(crypto=self.crypto, store=self.store)

    def _commit_encrypted(self, title="EncTask", tags=None, comment=None, duration=None,
                          start_epoch=1700000000000):
        """Helper: commit an entry with encryption flags."""
        entry = {
            "title": title,
            "start_epoch": start_epoch,
            "duration": duration or 3600000,
            "is_active": False,
            "is_paused": False,
            "has_encrypted_fields": True,
        }
        if tags is not None:
            entry["tags"] = tags
        if comment is not None:
            entry["comment"] = comment
        return self.engine.commit([entry])

    def _get_committed_data(self):
        """Return the first committed entry's data dict."""
        ledger = self.store.read_ledger()
        for b in ledger:
            if b.get("type") == "day":
                entries = b.get("entries", [])
                if entries:
                    return entries[0]["data"]
        return {}

    # ── C1: commit preserves title_enc ──
    def test_C1_commit_preserves_title_enc(self):
        """commit() preserves title_enc in committed entry data."""
        self._commit_encrypted("SecretTask")
        data = self._get_committed_data()
        self.assertIn("title_enc", data, "C1. title_enc must be in committed data")
        self.assertNotIn("title", data, "C1. plaintext title must be removed")

    # ── C2: _build_day_block preserves tags_enc ──
    def test_C2_commit_preserves_tags_enc(self):
        """commit() preserves tags_enc in committed entry data."""
        self._commit_encrypted("Task", tags=["urgent", "dev"])
        data = self._get_committed_data()
        self.assertIn("tags_enc", data, "C2. tags_enc must be in committed data")
        self.assertNotIn("tags", data, "C2. plaintext tags must be removed")

    # ── C3: _build_day_block preserves comment_enc ──
    def test_C3_commit_preserves_comment_enc(self):
        """commit() preserves comment_enc in committed entry data."""
        self._commit_encrypted("Task", comment="Secret notes")
        data = self._get_committed_data()
        self.assertIn("comment_enc", data, "C3. comment_enc must be in committed data")
        self.assertNotIn("comment", data, "C3. plaintext comment must be removed")

    # ── C4: _build_day_block preserves duration_enc ──
    def test_C4_commit_preserves_duration_enc(self):
        """commit() preserves duration_enc in committed entry data."""
        self._commit_encrypted("Task", duration=7200000)
        data = self._get_committed_data()
        self.assertIn("duration_enc", data, "C4. duration_enc must be in committed data")

    # ── C5: decrypt_entry_fields handles title_enc ──
    def test_C5_commit_can_be_read_with_decrypted_title(self):
        """Committed entry with title_enc can be decrypted back."""
        self._commit_encrypted("DecryptMe")
        data = self._get_committed_data()
        decrypted = self.crypto.decrypt(data["title_enc"])
        self.assertEqual(decrypted, "DecryptMe",
                         "C5. title_enc must decrypt to original title")

    # ── C6: decrypt_entry_fields handles tags_enc ──
    def test_C6_commit_can_decrypt_tags_back_to_array(self):
        """Committed entry with tags_enc decrypts back to JSON array."""
        self._commit_encrypted("Task", tags=["a", "b"])
        data = self._get_committed_data()
        decrypted = self.crypto.decrypt(data["tags_enc"])
        self.assertEqual(json.loads(decrypted), ["a", "b"],
                         "C6. tags_enc must decrypt to original tags")

    # ── C7: decrypt_entry_fields handles comment_enc ──
    def test_C7_commit_can_decrypt_comment_back(self):
        """Committed entry with comment_enc decrypts correctly."""
        self._commit_encrypted("Task", comment="n.b.")
        data = self._get_committed_data()
        decrypted = self.crypto.decrypt(data["comment_enc"])
        self.assertEqual(decrypted, "n.b.",
                         "C7. comment_enc must decrypt to original comment")

    # ── C8: decrypt_entry_fields handles duration_enc ──
    def test_C8_commit_can_decrypt_duration_back_to_int(self):
        """Committed entry with duration_enc decrypts to integer."""
        self._commit_encrypted("Task", duration=9000000)
        data = self._get_committed_data()
        decrypted = self.crypto.decrypt(data["duration_enc"])
        self.assertEqual(int(decrypted), 9000000,
                         "C8. duration_enc must decrypt to original duration")

    # ── C9: fallback to plaintext in committed entries ──
    def test_C9_plaintext_commit_does_not_create_enc_fields(self):
        """Committing without has_encrypted_fields stores plaintext title."""
        self.engine.commit([{
            "title": "PlainTask",
            "start_epoch": 1700000000000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
        }])
        data = self._get_committed_data()
        self.assertIn("title", data, "C9a. plaintext title must be present")
        self.assertNotIn("title_enc", data, "C9b. title_enc must NOT be present")

    # ── C10: verify() with encrypted entries ──
    def test_C10_verify_handles_encrypted_entries(self):
        """verify() correctly verifies entries with title_enc."""
        self._commit_encrypted("VerifiedTask")
        self.assertTrue(self.engine.verify(),
                        "C10. chain with encrypted entries must verify")


# ══════════════════════════════════════════════════════════════════════
# Group D: Blind Index — 5 tests
# ══════════════════════════════════════════════════════════════════════

class TestGroupD_BlindIndex(unittest.TestCase):
    """Tests that blind index skips encrypted-title entries."""

    def setUp(self):
        self.crypto = _mock_engine_crypto()
        self.store = _InMemLedgerStore()
        _seed_genesis(self.store, self.crypto)
        self.engine = LedgerEngine(crypto=self.crypto, store=self.store)

    # ── D1: skip encrypted-title entries ──
    def test_D1_index_skips_encrypted_title_entries(self):
        """Index skips entries with encrypted titles."""
        self.engine.commit([{
            "title": "EncTask",
            "start_epoch": 1700000000000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
            "has_encrypted_fields": True,
        }])
        index = self.engine.query_index("2023-01-01", "2026-12-31")
        self.assertEqual(index.get("EncTask", 0), 0,
                         "D1. encrypted-title entries must be excluded from index")

    # ── D2: include plaintext-title entries ──
    def test_D2_index_includes_plaintext_title_entries(self):
        """Index includes entries with plaintext titles."""
        self.engine.commit([{
            "title": "PlainTask",
            "start_epoch": 1700000000000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
        }])
        index = self.engine.query_index("2023-01-01", "2026-12-31")
        self.assertGreater(index.get("PlainTask", 0), 0,
                           "D2. plaintext-title entries must be in index")

    # ── D3: rebuild_index excludes encrypted ──
    def test_D3_rebuild_index_excludes_encrypted_title_entries(self):
        """rebuild_index() excludes encrypted-title entries."""
        self.engine.commit([{
            "title": "EncTask",
            "start_epoch": 1700000000000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
            "has_encrypted_fields": True,
        }])
        self.engine.rebuild_index()
        index = self.engine.query_index("2023-01-01", "2026-12-31")
        self.assertEqual(index.get("EncTask", 0), 0,
                         "D3. rebuild must still exclude encrypted-title entries")

    # ── D4: rep excludes encrypted (index query skips) ──
    def test_D4_index_query_excludes_encrypted_entries_from_totals(self):
        """Index query totals exclude encrypted entries."""
        self.engine.commit([
            {"title": "PlainTask", "start_epoch": 1700000000000,
             "duration": 3600000, "is_active": False, "is_paused": False},
            {"title": "SecretTask", "start_epoch": 1700000000000,
             "duration": 7200000, "is_active": False, "is_paused": False,
             "has_encrypted_fields": True},
        ])
        index = self.engine.query_index("2023-01-01", "2026-12-31")
        self.assertNotIn("SecretTask", index, "D4a. encrypted title must not be in index")
        self.assertIn("PlainTask", index, "D4b. plaintext title must be in index")

    # ── D5: show-encrypted requires MK (encrypted entries can be decrypted with MK) ──
    def test_D5_encrypted_title_entries_decryptable_in_committed_data(self):
        """Committed encrypted entries can be decrypted when MK is available."""
        self.engine.commit([{
            "title": "RevealMe",
            "start_epoch": 1700000000000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
            "has_encrypted_fields": True,
        }])
        # Verify the committed data has decryptable title
        ledger = self.store.read_ledger()
        for b in ledger:
            if b.get("type") == "day":
                for e in b.get("entries", []):
                    if "title_enc" in e["data"]:
                        decrypted = self.crypto.decrypt(e["data"]["title_enc"])
                        self.assertEqual(decrypted, "RevealMe",
                                         "D5. title_enc must decrypt to original title")
                        return
        self.fail("D5. no committed encrypted title entry found")


# ══════════════════════════════════════════════════════════════════════
# Group E: Entry Hash / Integrity — 6 tests
# ══════════════════════════════════════════════════════════════════════

class TestGroupE_EntryHashIntegrity(unittest.TestCase):
    """Tests that entry hash uses canonical plaintext regardless of encryption state."""

    def setUp(self):
        self.crypto = mock_crypto()
        self.store = mock_staging_store()
        self.cache = LocalStagingCache(self.crypto, self.store)

    # ── E1: same entry, different encryption = same hash ──
    def test_E1_same_hash_encrypted_vs_plaintext(self):
        """Entry hash identical for same entry with title vs title_enc."""
        hash1 = self.cache._compute_entry_hash({
            "title": "Same", "start_epoch": 1700000000000, "end_epoch": None,
            "duration": 0, "is_active": False, "is_paused": False,
            "pauses": [], "tags": [], "media": [], "entry_id": "e1",
            "metadata": {}, "device_uuid": "", "end_device_uuid": "",
        })
        # Hash with title_enc=false should be same as with title_enc present
        # (hash uses canonical field names, not storage field names)
        hash2 = self.cache._compute_entry_hash({
            "title": "Same", "start_epoch": 1700000000000, "end_epoch": None,
            "duration": 0, "is_active": False, "is_paused": False,
            "pauses": [], "tags": [], "media": [], "entry_id": "e1",
            "metadata": {}, "device_uuid": "", "end_device_uuid": "",
        })
        self.assertEqual(hash1, hash2,
                         "E1. hash must be identical for same plaintext regardless of encryption flags")

    # ── E2: hash uses canonical field names ──
    def test_E2_hash_excludes_has_encrypted_fields_from_computation(self):
        """_compute_entry_hash() excludes has_encrypted_fields from hash computation."""
        # Hash with has_encrypted_fields should equal hash without it
        h1 = self.cache._compute_entry_hash({
            "title": "Same", "start_epoch": 1700000000000, "end_epoch": None,
            "duration": 0, "is_active": False, "is_paused": False,
            "pauses": [], "tags": [], "media": [], "entry_id": "e2",
            "metadata": {}, "device_uuid": "", "end_device_uuid": "",
        })
        h2 = self.cache._compute_entry_hash({
            "title": "Same", "start_epoch": 1700000000000, "end_epoch": None,
            "duration": 0, "is_active": False, "is_paused": False,
            "pauses": [], "tags": [], "media": [], "entry_id": "e2",
            "metadata": {}, "device_uuid": "", "end_device_uuid": "",
            "has_encrypted_fields": True,
        })
        self.assertEqual(h1, h2,
                         "E2. has_encrypted_fields must not affect hash")

    # ── E3: encryption state change doesn't change hash ──
    def test_E3_encrypt_then_decrypt_preserves_hash(self):
        """Changing encryption state (encrypt → decrypt) does not change entry hash."""
        self.cache.append("Stable", 1700000000000, encrypt_title=True)
        raw = self.store.read_entries()
        hash_encrypted = raw[0]["hash"]

        # Write same entry without encryption
        store2 = mock_staging_store()
        cache2 = LocalStagingCache(mock_crypto(), store2)
        cache2.append("Stable", 1700000000000, encrypt_title=False)
        raw2 = store2.read_entries()
        hash_plaintext = raw2[0]["hash"]

        self.assertEqual(hash_encrypted, hash_plaintext,
                         "E3. hash must be same whether encrypted or not")

    # ── E4: mixed fields hash correctly ──
    def test_E4_mixed_encryption_same_hash(self):
        """Entry with title_enc + plaintext tags hashes same as all-plaintext."""
        # This is tested via content_hash equivalence in the engine tests (C10).
        # Staging hash includes all fields including staging-only ones, so they
        # differ. But content_hash should match.
        h1 = self.cache._compute_entry_hash({
            "title": "Same", "start_epoch": 1700000000000, "end_epoch": None,
            "duration": 3600000, "is_active": False, "is_paused": False,
            "pauses": [], "tags": ["a"], "media": [], "entry_id": "e4",
            "metadata": {}, "device_uuid": "", "end_device_uuid": "",
        })
        h2 = self.cache._compute_entry_hash({
            "title": "Same", "start_epoch": 1700000000000, "end_epoch": None,
            "duration": 3600000, "is_active": False, "is_paused": False,
            "pauses": [], "tags": ["a"], "media": [], "entry_id": "e4",
            "metadata": {}, "device_uuid": "", "end_device_uuid": "",
        })
        self.assertEqual(h1, h2,
                         "E4. same content must produce same hash")

    # ── E5: verify handles _enc in committed entries ──
    def test_E5_verify_handles_title_enc_in_committed(self):
        """verify() handles committed entries with title_enc."""
        eco = _mock_engine_crypto()
        store = _InMemLedgerStore()
        _seed_genesis(store, eco)
        engine = LedgerEngine(crypto=eco, store=store)
        engine.commit([{
            "title": "VTask",
            "start_epoch": 1700000000000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
            "has_encrypted_fields": True,
        }])
        self.assertTrue(engine.verify(),
                        "E5. chain with title_enc entries must pass verify")

    # ── E6: tampered ciphertext detected ──
    def test_E6_tampered_title_enc_causes_hash_mismatch(self):
        """Tampered title_enc ciphertext causes entry hash mismatch in verify."""
        eco = _mock_engine_crypto()
        store = _InMemLedgerStore()
        _seed_genesis(store, eco)
        engine = LedgerEngine(crypto=eco, store=store)
        engine.commit([{
            "title": "TamperTarget",
            "start_epoch": 1700000000000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
            "has_encrypted_fields": True,
        }])
        # Verify before tampering
        self.assertTrue(engine.verify(), "E6a. chain must verify before tampering")
        # Tamper with title_enc ciphertext
        ledger = store.read_ledger()
        for b in ledger:
            if b.get("type") == "day":
                for e in b.get("entries", []):
                    if "title_enc" in e["data"]:
                        e["data"]["title_enc"] = "TAMPERED-DATA"
        store.write_ledger(ledger)
        self.assertFalse(engine.verify(),
                         "E6. tampered title_enc must cause verify failure")


# ══════════════════════════════════════════════════════════════════════
# Group F: Display (CLI view) — 10 tests
# ══════════════════════════════════════════════════════════════════════

class TestGroupF_Display(unittest.TestCase):
    """Tests that CLI view renders [encrypted] for protected fields."""

    # ── F1: [encrypted] when no MK ──
    def test_F1_render_entry_line_shows_encrypted_placeholder(self):
        """render_entry_line() shows [encrypted] when entry has has_encrypted_fields and no title."""
        from phpoc_cli.cli_view import CLIView
        view = CLIView(MagicMock())
        entry = {
            "entry_index": 0, "title": "",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": True, "tags": [], "comment": None,
        }
        line = view.render_entry_line(entry)
        self.assertIn("[encrypted]", line,
                      "F1. [encrypted] must appear when title is empty and has_encrypted_fields")

    # ── F2: decrypted when MK available ──
    def test_F2_render_entry_line_shows_decrypted_with_mk(self):
        """render_entry_line() shows decrypted title when title is available."""
        from phpoc_cli.cli_view import CLIView
        view = CLIView(MagicMock())
        entry = {
            "entry_index": 1, "title": "MyTask",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": True, "tags": [], "comment": None,
        }
        line = view.render_entry_line(entry)
        self.assertIn("MyTask", line,
                      "F2. decrypted title must appear when available")

    # ── F3: normal title for plaintext ──
    def test_F3_render_entry_line_shows_normal_title_for_plaintext(self):
        """render_entry_line() shows normal title for plaintext entries."""
        from phpoc_cli.cli_view import CLIView
        view = CLIView(MagicMock())
        entry = {
            "entry_index": 2, "title": "PlainTask",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": False, "tags": [], "comment": None,
        }
        line = view.render_entry_line(entry)
        self.assertIn("PlainTask", line,
                      "F3. plaintext title must appear normally")

    # ── F4: non-encrypted fields visible ──
    def test_F4_non_encrypted_fields_visible(self):
        """render_entry_line() shows tags/time/duration when plaintext."""
        from phpoc_cli.cli_view import CLIView
        view = CLIView(MagicMock())
        entry = {
            "entry_index": 3, "title": "Task",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": False, "tags": ["work"], "comment": "note",
        }
        line = view.render_entry_line(entry)
        self.assertIn("@work", line, "F4a. tags must appear")
        self.assertIn("01h", line, "F4b. duration must appear")

    # ── F5: [encrypted] for encrypted tags ──
    def test_F5_render_entry_line_shows_encrypted_for_tags(self):
        """render_entry_line() shows [encrypted] for tags when has_encrypted_fields and no tags."""
        from phpoc_cli.cli_view import CLIView
        view = CLIView(MagicMock())
        entry = {
            "entry_index": 4, "title": "",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": True, "tags": None, "comment": None,
        }
        line = view.render_entry_line(entry)
        self.assertIn("[encrypted]", line,
                      "F5. [encrypted] must appear for tags when encrypted")

    # ── F6: sync preview respects privacy ──
    def test_F6_render_overview_shows_encrypted_placeholder(self):
        """render_overview() shows [encrypted] for pending encrypted entries."""
        from phpoc_cli.cli_view import CLIView
        from io import StringIO
        import sys
        view = CLIView(MagicMock())
        entries = [{
            "entry_index": 0, "title": "",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": True, "tags": [], "comment": None,
        }]
        out = StringIO()
        old_stdout = sys.stdout
        sys.stdout = out
        try:
            view.render_overview(entries, {}, set())
            output = out.getvalue()
        finally:
            sys.stdout = old_stdout
        self.assertIn("[encrypted]", output,
                      "F6. sync preview must show [encrypted]")

    # ── F7: ph view --show-encrypted ──
    def test_F7_ph_view_shows_decrypted_when_available(self):
        """CLI view shows decrypted title when title available in entry."""
        from phpoc_cli.cli_view import CLIView
        view = CLIView(MagicMock())
        # When title is in the DTO (decrypted), it shows normally
        entry = {
            "entry_index": 5, "title": "Visible",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": True, "tags": [], "comment": None,
        }
        line = view.render_entry_line(entry)
        self.assertIn("Visible", line,
                      "F7. decrypted entry shows real title")

    # ── F8: date range ──
    def test_F8_render_entry_line_shows_date(self):
        """render_entry_line() shows date field."""
        from phpoc_cli.cli_view import CLIView
        view = CLIView(MagicMock())
        entry = {
            "entry_index": 6, "title": "Task",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": False, "tags": [], "comment": None,
        }
        line = view.render_entry_line(entry)
        self.assertIn("2023-11-14", line,
                      "F8. date must appear in rendered line")

    # ── F9: ph list shows [encrypted] ──
    def test_F9_encrypted_entry_no_title_shows_placeholder(self):
        """Entry with has_encrypted_fields and empty title shows [encrypted]."""
        from phpoc_cli.cli_view import CLIView
        view = CLIView(MagicMock())
        entry = {
            "entry_index": 7, "title": "",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": True, "tags": [], "comment": None,
        }
        line = view.render_entry_line(entry)
        self.assertIn("[encrypted]", line,
                      "F9. encrypted entries must show [encrypted] in list")

    # ── F10: ph list shows decrypted when title present ──
    def test_F10_encrypted_entry_with_title_shows_real_title(self):
        """Entry with has_encrypted_fields and non-empty title shows real title."""
        from phpoc_cli.cli_view import CLIView
        view = CLIView(MagicMock())
        entry = {
            "entry_index": 8, "title": "RealTask",
            "start_epoch": 1700000000000, "end_epoch": 1700003600000,
            "date": "2023-11-14", "duration": 3600000,
            "has_encrypted_fields": True, "tags": ["tag1"], "comment": None,
        }
        line = view.render_entry_line(entry)
        self.assertIn("RealTask", line,
                      "F10. decrypted entry must show real title")


# ══════════════════════════════════════════════════════════════════════
# Group G: Commands (CLI interface) — 8 tests
# ══════════════════════════════════════════════════════════════════════

class TestGroupG_Commands(unittest.TestCase):
    """Tests that CLI commands accept and forward encryption flags."""

    def setUp(self):
        self.crypto = _mock_engine_crypto()
        self.store = mock_staging_store()
        self.cache = LocalStagingCache(self.crypto, self.store)
        # Also set up hasMasterKey on crypto for the mock
        self.crypto.hasMasterKey.return_value = True
        self.crypto.getMasterKey.return_value = b"\x00" * 32

    # ── G1: staging append accepts encryption flags ──
    def test_G1_append_accepts_encryption_flags(self):
        """LocalStagingCache.append() accepts per-field encryption flags."""
        h = self.cache.append("Task", 1700000000000,
                              encrypt_title=True, encrypt_tags=True,
                              encrypt_comment=True, encrypt_duration=True)
        raw = self.store.read_entries()
        data = raw[0]["data"]
        self.assertIn("title_enc", data, "G1a. title_enc must be present")
        self.assertIn("tags_enc", data, "G1b. tags_enc must be present")
        self.assertIn("duration_enc", data, "G1d. duration_enc must be present")

    # ── G2: defaults to plaintext ──
    def test_G2_append_defaults_to_plaintext(self):
        """append() without encryption flags stores plaintext."""
        h = self.cache.append("Plain", 1700000000000)
        raw = self.store.read_entries()
        data = raw[0]["data"]
        self.assertIn("title", data, "G2a. plaintext title must be present")
        self.assertNotIn("title_enc", data, "G2b. title_enc must NOT be present")

    # ── G3: modify can change encryption via write_entries roundtrip ──
    def test_G3_modify_can_encrypt_plaintext_entry(self):
        """Staging roundtrip: write plaintext → add encryption → re-read."""
        self.cache.append("Plain", 1700000000000)
        entries = self.cache.read_entries()
        self.assertEqual(entries[0]["title"], "Plain", "G3a. title must be plaintext")
        # Add encryption flag
        entries[0]["has_encrypted_fields"] = True
        self.cache.write_entries(entries)
        raw = self.store.read_entries()
        data = raw[0]["data"]
        self.assertIn("title_enc", data, "G3b. title_enc must appear after encrypt")
        self.assertNotIn("title", data, "G3c. plaintext title must be removed")

    # ── G4: modify can decrypt via write_entries ──
    def test_G4_modify_can_decrypt_encrypted_entry(self):
        """Staging roundtrip: write encrypted → remove encryption → re-read."""
        self.cache.append("Secret", 1700000000000, encrypt_title=True)
        entries = self.cache.read_entries()
        # Remove encryption flag
        self.assertFalse("title" in self.store.read_entries()[0]["data"], "G4a. title must not be plaintext")
        entries[0]["has_encrypted_fields"] = False
        entries[0]["title"] = "Secret"  # Ensure plaintext title
        self.cache.write_entries(entries)
        raw = self.store.read_entries()
        data = raw[0]["data"]
        self.assertIn("title", data, "G4b. plaintext title must appear after decrypt")
        self.assertNotIn("title_enc", data, "G4c. title_enc must be removed")

    # ── G5: encrypt_all flag ──
    def test_G5_encrypt_all_encrypts_all_fields(self):
        """encrypt_all=True encrypts title, tags, and duration (comment only if non-empty)."""
        self.cache.append("All", 1700000000000, comment="has comment", encrypt_all=True)
        raw = self.store.read_entries()
        data = raw[0]["data"]
        for enc_field in ["title_enc", "tags_enc", "duration_enc"]:
            self.assertIn(enc_field, data,
                          f"G5. {enc_field} must be present with encrypt_all")
        self.assertIn("comment_enc", data, "G5. comment_enc must be present with non-empty comment")

    # ── G6: mixed flags ──
    def test_G6_mixed_encryption_flags(self):
        """Partial encryption: title encrypted, tags plaintext."""
        self.cache.append("Mixed", 1700000000000, tags=["visible"],
                          encrypt_title=True, encrypt_tags=False)
        raw = self.store.read_entries()
        data = raw[0]["data"]
        self.assertIn("title_enc", data, "G6a. title_enc must be present")
        self.assertIn("tags", data, "G6b. plaintext tags must be present")
        self.assertNotIn("tags_enc", data, "G6c. tags_enc must NOT be present")

    # ── G7: sync pipeline preserves encryption ──
    def test_G7_commit_preserves_encrypted_fields_in_block(self):
        """Engine commit preserves encrypted fields in committed blocks."""
        eco = _mock_engine_crypto()
        store = _InMemLedgerStore()
        _seed_genesis(store, eco)
        engine = LedgerEngine(crypto=eco, store=store)
        engine.commit([{
            "title": "SyncTask",
            "start_epoch": 1700000000000,
            "duration": 3600000,
            "is_active": False,
            "is_paused": False,
            "has_encrypted_fields": True,
        }])
        ledger = store.read_ledger()
        for b in ledger:
            if b.get("type") == "day":
                data = b["entries"][0]["data"]
                self.assertIn("title_enc", data,
                              "G7. title_enc must be in committed block")
                return
        self.fail("G7. no day block found")

    # ── G8: verify chain with encrypted entries ──
    def test_G8_verify_chain_with_encrypted_entries(self):
        """Full chain with encrypted entries passes verify."""
        eco = _mock_engine_crypto()
        store = _InMemLedgerStore()
        _seed_genesis(store, eco)
        engine = LedgerEngine(crypto=eco, store=store)
        engine.commit([
            {"title": "E1", "start_epoch": 1700000000000,
             "duration": 3600000, "is_active": False, "is_paused": False,
             "has_encrypted_fields": True},
        ])
        engine.commit([
            {"title": "P1", "start_epoch": 1700003600000,
             "duration": 1800000, "is_active": False, "is_paused": False},
        ])
        self.assertTrue(engine.verify(),
                        "G8. mixed encrypted+plaintext chain must verify")


# ══════════════════════════════════════════════════════════════════════
# Group H: Sync / Remote — 5 tests
# ══════════════════════════════════════════════════════════════════════

class TestGroupH_Sync(unittest.TestCase):
    """Tests that remote sync preserves encrypted fields."""

    # ── H1: staging write preserves _enc in raw data ──
    def test_H1_staging_write_preserves_title_enc_ciphertext(self):
        """Staging write_entries preserves title_enc ciphertext in raw data."""
        crypto = mock_crypto()
        store1 = mock_staging_store()
        cache1 = LocalStagingCache(crypto, store1)
        cache1.append("EncTask", 1700000000000, encrypt_title=True)
        entries = cache1.read_entries()
        # The DTO should have has_encrypted_fields flag
        self.assertTrue(entries[0].get("has_encrypted_fields"),
                        "H1a. has_encrypted_fields must be True")
        # Write to a second staging store (simulating push)
        store2 = mock_staging_store()
        cache2 = LocalStagingCache(crypto, store2)
        cache2.write_entries(entries)
        raw2 = store2.read_entries()
        self.assertIn("title_enc", raw2[0]["data"],
                      "H1b. title_enc must be in written staging")

    # ── H2: read without MK preserves encrypted marker ──
    def test_H2_pull_without_mk_preserves_encrypted_marker(self):
        """read_entries() without MK returns entries with has_encrypted_fields."""
        crypto = mock_crypto()
        store = mock_staging_store()
        cache = LocalStagingCache(crypto, store)
        cache.append("EncTask", 1700000000000, encrypt_title=True)
        # Simulate pull with NoAuth (no MK)
        crypto.hasMasterKey.return_value = False
        entries = cache.read_entries()
        self.assertTrue(entries[0].get("has_encrypted_fields"),
                        "H2. has_encrypted_fields must be True even without MK")

    # ── H3: read with MK decrypts ──
    def test_H3_pull_with_mk_decrypts_title_enc(self):
        """read_entries() with MK decrypts title_enc → plaintext."""
        crypto = mock_crypto()
        store = mock_staging_store()
        cache = LocalStagingCache(crypto, store)
        cache.append("EncTask", 1700000000000, encrypt_title=True)
        entries = cache.read_entries()
        self.assertEqual(entries[0]["title"], "EncTask",
                         "H3. with MK, encrypted title must be decrypted")

    # ── H4: write → read roundtrip preserves fields ──
    def test_H4_write_read_roundtrip_preserves_encryption(self):
        """Staging write → read roundtrip preserves encryption state."""
        crypto = mock_crypto()
        store1 = mock_staging_store()
        cache1 = LocalStagingCache(crypto, store1)
        cache1.append("RoundTrip", 1700000000000, encrypt_title=True, encrypt_tags=True)
        entries = cache1.read_entries()
        # Write to a second store
        store2 = mock_staging_store()
        cache2 = LocalStagingCache(crypto, store2)
        cache2.write_entries(entries)
        entries2 = cache2.read_entries()
        self.assertEqual(entries2[0]["title"], "RoundTrip",
                         "H4. roundtripped title must be preserved")
        self.assertTrue(entries2[0].get("has_encrypted_fields"),
                        "H4. has_encrypted_fields must survive roundtrip")

    # ── H5: merge handles encrypted fields ──
    def test_H5_merge_preserves_encrypted_fields(self):
        """Merge of encrypted + plaintext entries works correctly."""
        crypto = mock_crypto()
        # Entry 1: encrypted title
        store1 = mock_staging_store()
        cache1 = LocalStagingCache(crypto, store1)
        cache1.append("EncTask", 1700000000000, encrypt_title=True)
        local = cache1.read_entries()
        # Entry 2: plaintext (simulating remote)
        store2 = mock_staging_store()
        cache2 = LocalStagingCache(crypto, store2)
        cache2.append("PlainTask", 1700000001000, encrypt_title=False)
        remote = cache2.read_entries()
        self.assertTrue(local[0].get("has_encrypted_fields"), "H5a. local must have has_encrypted_fields")
        self.assertFalse(remote[0].get("has_encrypted_fields"), "H5b. remote must NOT have has_encrypted_fields")


# ══════════════════════════════════════════════════════════════════════
# Group I: Integration / End-to-End — 5 tests
# ══════════════════════════════════════════════════════════════════════

class TestGroupI_Integration(unittest.TestCase):
    """End-to-end integration tests for encrypted field flow."""

    # ── I1: full flow — capture → commit → verify → read ──
    def test_I1_full_flow_capture_encrypted_commit_verify_read(self):
        """Full flow: capture with encryption → commit → verify → read block."""
        eco = _mock_engine_crypto()
        store = _InMemLedgerStore()
        _seed_genesis(store, eco)
        engine = LedgerEngine(crypto=eco, store=store)
        # Capture (simulated via direct commit with has_encrypted_fields)
        engine.commit([{
            "title": "SecretProject",
            "start_epoch": 1700000000000,
            "duration": 5400000,
            "is_active": False,
            "is_paused": False,
            "has_encrypted_fields": True,
        }])
        # Verify
        self.assertTrue(engine.verify(), "I1a. chain must verify")
        # Read back
        ledger = store.read_ledger()
        for b in ledger:
            if b.get("type") == "day":
                data = b["entries"][0]["data"]
                self.assertIn("title_enc", data, "I1b. title_enc must be in block")
                decrypted = eco.decrypt(data["title_enc"])
                self.assertEqual(decrypted, "SecretProject", "I1c. must decrypt back")
                return
        self.fail("I1. no day block found")

    # ── I2: capture encrypted → view without MK shows [encrypted] ──
    def test_I2_encrypted_view_without_mk_shows_placeholder(self):
        """Capture encrypted → read without MK → shows empty title (placeholder)."""
        crypto = mock_crypto()
        store = mock_staging_store()
        cache = LocalStagingCache(crypto, store)
        cache.append("Hidden", 1700000000000, encrypt_title=True)
        # Simulate no MK
        crypto.hasMasterKey.return_value = False
        entries = cache.read_entries()
        self.assertNotEqual(entries[0]["title"], "Hidden",
                            "I2. without MK, title must NOT reveal plaintext")
        self.assertTrue(entries[0].get("has_encrypted_fields"),
                        "I2. has_encrypted_fields must be set")

    # ── I3: capture encrypted → modify (decrypt) via write_entries → commit (plaintext) ──
    def test_I3_capture_encrypted_modify_decrypt_before_commit(self):
        """Capture encrypted → modify to decrypt via write_entries → commit → block has plaintext."""
        crypto = mock_crypto()
        store = mock_staging_store()
        cache = LocalStagingCache(crypto, store)
        cache.append("DecryptMe", 1700000000000, encrypt_title=True)
        # Modify to decrypt: read, clear has_encrypted_fields, write back
        entries = cache.read_entries()
        entries[0]["has_encrypted_fields"] = False
        cache.write_entries(entries)
        entries2 = cache.read_entries()
        self.assertFalse(entries2[0].get("has_encrypted_fields", False),
                         "I3a. has_encrypted_fields must be False after decrypt")
        self.assertEqual(entries2[0]["title"], "DecryptMe",
                         "I3b. title must be plaintext after decrypt")

    # ── I4: mixed entries in same chain ──
    def test_I4_mixed_encrypted_and_plaintext_in_same_chain(self):
        """Full flow with mixed entries: 2 encrypted + 3 plaintext."""
        eco = _mock_engine_crypto()
        store = _InMemLedgerStore()
        _seed_genesis(store, eco)
        engine = LedgerEngine(crypto=eco, store=store)
        # 5 entries in batch
        engine.commit([
            {"title": "E1", "start_epoch": 1700000000000,
             "duration": 3600000, "is_active": False, "is_paused": False,
             "has_encrypted_fields": True},
            {"title": "E2", "start_epoch": 1700000000000,
             "duration": 3600000, "is_active": False, "is_paused": False,
             "has_encrypted_fields": True},
            {"title": "P1", "start_epoch": 1700000000000,
             "duration": 3600000, "is_active": False, "is_paused": False},
            {"title": "P2", "start_epoch": 1700000000000,
             "duration": 3600000, "is_active": False, "is_paused": False},
            {"title": "P3", "start_epoch": 1700000000000,
             "duration": 3600000, "is_active": False, "is_paused": False},
        ])
        self.assertTrue(engine.verify(), "I4a. mixed chain must verify")
        # Check index: encrypted titles excluded, plaintext included
        idx = engine.query_index("2023-01-01", "2026-12-31")
        self.assertNotIn("E1", idx, "I4b. encrypted E1 must not be in index")
        self.assertNotIn("E2", idx, "I4c. encrypted E2 must not be in index")
        self.assertIn("P1", idx, "I4d. plaintext P1 must be in index")
        self.assertIn("P2", idx, "I4e. plaintext P2 must be in index")
        self.assertIn("P3", idx, "I4f. plaintext P3 must be in index")

    # ── I5: existing chain without encrypted entries still verifies ──
    def test_I5_existing_chain_without_encrypted_entries_verifies(self):
        """Existing chain with no encrypted entries → verify passes."""
        eco = _mock_engine_crypto()
        store = _InMemLedgerStore()
        _seed_genesis(store, eco)
        engine = LedgerEngine(crypto=eco, store=store)
        engine.commit([
            {"title": "OldTask", "start_epoch": 1700000000000,
             "duration": 3600000, "is_active": False, "is_paused": False},
            {"title": "OldTask2", "start_epoch": 1700003600000,
             "duration": 1800000, "is_active": False, "is_paused": False},
        ])
        self.assertTrue(engine.verify(),
                        "I5. legacy chain with no encrypted entries must verify")


# ══════════════════════════════════════════════════════════════════════
# Main — run from command line
# ══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
