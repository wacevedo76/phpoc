"""E2E tests for CLI onboarding pipeline (RED — TDD Phase 5d).

These tests specify the *desired* behavior of the unified onboarding pipeline
after the Phase 5d refactoring (transport registry, unified picker, etc.).
They will fail initially because:
  1. ``transport_registry.py`` does not exist yet
  2. ``run_onboarding()`` does not catch ``ValueError`` from deobfuscation failure
  3. No chain divergence detection in the pipeline
  4. ``AbstractStagingTransport`` has no ``delete()`` method
  5. No forensic/event logging exists
  6. No quarantine mechanism for corrupted blobs

After each code gap is fixed, these tests should pass GREEN.

Scenarios:
  1. Happy path — seed matches, all remote data imports successfully
  2. Wrong seed — deobfuscation fails, friendly error, no partial writes
  3. Empty remote — graceful exit, no files written
  4. No staging blob — normal degraded path, empty staging, ledger imports fine
  5. Staging key mismatch — quarantine + log + destroy remote, continue with ledger
  6. Chain divergence — corrupted prev_hash, abort with clear message, no partial writes
  7. Full round-trip — init → add → sync → second device onboard via same transport
"""

import hashlib
import json
import os
import struct
import tempfile
import time
import unittest
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple
from unittest.mock import MagicMock, patch, call, PropertyMock

# ── Ensure project root is on path ──────────────────────────────────────────
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core.sync.transport import AbstractStagingTransport
from domain.staging.remote_sync import (
    RemoteStagingSync,
    BLOB_KEY_MISMATCH,
    BLOB_SUBKEY_PREFIX,
)
from security.recovery import RecoveryManager
from security.crypto import CryptoManager


# ═════════════════════════════════════════════════════════════════════════════
# Test data constants
# ═════════════════════════════════════════════════════════════════════════════

TEST_SEED = "c7z3mJUb20Qkh0If/CR9kqwikT7spYGYunUz3abvXjA="  # 32 bytes b64
TEST_MK = RecoveryManager.seed_to_key(TEST_SEED)  # 32 bytes

WRONG_SEED = "Qh27If8rnLyeue2JyLN1CdyHnJ7tps24P8YKwScxbOw="
WRONG_MK = RecoveryManager.seed_to_key(WRONG_SEED)  # different 32 bytes

TEST_PASSPHRASE = "my-test-passphrase-123"

# Remote paths
LEDGER_BLOCKS_PREFIX = "ledger/blocks/"
STAGING_PATH = "staging/blobs/current.json"
INDEX_PATH = "ledger/index.json"
REMOTE_COOKIE_PATH = "staging/blobs/device_cookie.bin"


# ═════════════════════════════════════════════════════════════════════════════
# Mock transport — in-memory store that records interactions
# ═════════════════════════════════════════════════════════════════════════════

class MockOnboardingTransport(AbstractStagingTransport):
    """In-memory transport with pre-loaded obfuscated data.

    Records all pull/push/list_files/delete calls for test assertions.
    Pre-populated via set_*() helpers that accept raw dicts and obfuscate
    internally using the given master key.
    """

    def __init__(self):
        self._store: Dict[str, bytes] = {}
        self.pull_calls: List[str] = []
        self.push_calls: List[Tuple[str, bytes]] = []
        self.list_files_calls: List[str] = []
        self.delete_calls: List[str] = []

    # ── AbstractStagingTransport interface ──────────────────────────────

    def pull(self, path: str) -> Optional[bytes]:
        self.pull_calls.append(path)
        return self._store.get(path)

    def push(self, path: str, data: bytes) -> None:
        self.push_calls.append((path, data))
        self._store[path] = data

    def list_files(self, prefix: str) -> list:
        self.list_files_calls.append(prefix)
        # Return basenames only (matching the transport contract)
        return sorted(
            k[len(prefix):] for k in self._store if k.startswith(prefix)
        )

    def delete(self, path: str) -> None:
        """Delete a remote blob. Not yet part of AbstractStagingTransport."""
        self.delete_calls.append(path)
        self._store.pop(path, None)

    # ── Test setup helpers ──────────────────────────────────────────────

    def set_ledger_block(self, index: int, block: dict, mk: bytes) -> None:
        """Pre-populate a ledger block at ``ledger/blocks/{index:06d}.json``."""
        path = f"{LEDGER_BLOCKS_PREFIX}{index:06d}.json"
        plaintext = json.dumps(block).encode("utf-8")
        obfuscated = RemoteStagingSync._obfuscate(plaintext, mk)
        self._store[path] = obfuscated

    def set_ledger_blocks(self, blocks: List[dict], mk: bytes) -> None:
        """Pre-populate a sequence of ledger blocks."""
        for i, block in enumerate(blocks):
            self.set_ledger_block(i, block, mk)

    def set_staging_blob(self, blob: dict, mk: bytes) -> None:
        """Pre-populate the staging blob at the default staging path."""
        plaintext = json.dumps(blob, indent=2).encode("utf-8")
        obfuscated = RemoteStagingSync._obfuscate(plaintext, mk)
        self._store[STAGING_PATH] = obfuscated

    def set_staging_blob_raw(self, data: bytes) -> None:
        """Pre-populate the staging path with raw bytes (e.g., corrupted)."""
        self._store[STAGING_PATH] = data

    def set_index(self, index_data: dict, mk: bytes) -> None:
        """Pre-populate the remote index file."""
        plaintext = json.dumps(index_data, indent=2).encode("utf-8")
        obfuscated = RemoteStagingSync._obfuscate(plaintext, mk)
        self._store[INDEX_PATH] = obfuscated

    def set_cookie_bytes(self, data: bytes) -> None:
        """Pre-populate the device cookie (plain, not obfuscated)."""
        self._store[REMOTE_COOKIE_PATH] = data

    def has_path(self, path: str) -> bool:
        """Check if a path exists in the store."""
        return path in self._store

    def reset_calls(self) -> None:
        """Clear call tracking without clearing stored blobs."""
        self.pull_calls.clear()
        self.push_calls.clear()
        self.list_files_calls.clear()
        self.delete_calls.clear()


# ═════════════════════════════════════════════════════════════════════════════
# Test data builders — produce valid ledger blocks
# ═════════════════════════════════════════════════════════════════════════════

def _make_crypto(mk: bytes = TEST_MK) -> CryptoManager:
    """Create a CryptoManager for sealing/signing test blocks."""
    return CryptoManager(mk)


def _make_genesis_block(mk: bytes = TEST_MK) -> dict:
    """Build a valid genesis block with a sealing identity key.

    Returns a dict that's ready to obfuscate and store on the transport.
    The seal (day_hash) and signature are computed with the real CryptoManager.
    """
    crypto = _make_crypto(mk)

    # Simulate an identity secret encrypted with the master key
    identity_secret_hex = "ab" * 32  # 32 bytes as hex
    enc_identity_secret = crypto.encrypt(identity_secret_hex)

    # Simulate a recovery seed encrypted with a PDK
    seed_str = "dGhpcyBpcyBhIHRlc3Qgc2VlZ..."
    pdk = b"\x11" * 32  # dummy PDK
    from security.recovery import RecoveryManager
    enc_seed = RecoveryManager.encrypt_seed(seed_str, pdk)

    block = {
        "type": "genesis",
        "format_version": 1,
        "version": 1,
        "identity": {
            "recovery_seed_enc": enc_seed,
            "identity_secret_enc_fallback": enc_identity_secret,
        },
        "day_hash": "",  # placeholder, filled below
        "signature": "",  # placeholder
    }

    # Compute the seal over the core data (without day_hash and signature)
    check_data = {k: v for k, v in block.items() if k not in ("day_hash", "signature")}
    block["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))

    # Sign with identity secret
    block["signature"] = crypto.sign(block["day_hash"], bytes.fromhex(identity_secret_hex))

    return block


def _make_day_block(
    prev_block: dict,
    index: int = 1,
    mk: bytes = TEST_MK,
) -> dict:
    """Build a day block that chains after *prev_block*.

    The prev_hash is set from prev_block's day_hash.
    """
    crypto = _make_crypto(mk)

    prev_hash = (
        prev_block.get("day_hash")
        or prev_block.get("month_hash")
        or prev_block.get("year_hash")
    )
    if not prev_hash:
        raise ValueError("Previous block has no hash key")

    # Build entry in ledger format: {"hash": sha256(data), "data": {...}}
    entry_data = {
        "entry_index": 0,
        "title": "Morning run",
        "date": "2026-06-20",
        "start_epoch": 1718900000000,
        "end_epoch": 1718903600000,
        "duration": 3600000,
        "is_active": False,
        "comment": "",
        "tags": ["exercise"],
    }
    entry_hash = hashlib.sha256(
        json.dumps(entry_data, sort_keys=True).encode()
    ).hexdigest()

    block = {
        "type": "day",
        "date": "2026-06-20",
        "prev_hash": prev_hash,
        "entries": [
            {"hash": entry_hash, "data": entry_data},
        ],
        "day_hash": "",  # placeholder
        "signature": "",  # optional
    }

    seal_data = {k: v for k, v in block.items() if k not in ("day_hash", "signature")}
    block["day_hash"] = crypto.seal(json.dumps(seal_data, sort_keys=True))

    # Get identity secret to sign
    identity_secret_hex = "ab" * 32
    block["signature"] = crypto.sign(block["day_hash"], bytes.fromhex(identity_secret_hex))

    return block


def _make_staging_blob(mk: bytes = TEST_MK) -> dict:
    """Build a realistic staging blob dict with 3 entries."""
    return {
        "device_id": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        "device_proof": "",
        "entries": [
            {
                "entry_index": 0,
                "title": "Morning run",
                "date": "2026-06-20",
                "start_epoch": 1718900000000,
                "end_epoch": 1718903600000,
                "duration": 3600000,
                "is_active": False,
                "comment": "",
                "tags": ["exercise"],
            },
            {
                "entry_index": 1,
                "title": "Read chapter 5",
                "date": "2026-06-20",
                "start_epoch": 1718910000000,
                "end_epoch": 1718915400000,
                "duration": 5400000,
                "is_active": False,
                "comment": "",
                "tags": ["reading"],
            },
            {
                "entry_index": 2,
                "title": "Meditate",
                "date": "2026-06-20",
                "start_epoch": 1718920000000,
                "end_epoch": None,
                "duration": None,
                "is_active": True,
                "comment": "",
                "tags": ["mindfulness"],
            },
        ],
        "updated_at": 1718930000000,
    }


def _make_blob_data(mk: bytes = TEST_MK) -> dict:
    """Alias for _make_staging_blob."""
    return _make_staging_blob(mk)


def _make_index() -> dict:
    """Build a realistic index dict."""
    return {
        "2026-06-20": {
            "Morning run": {"ms": 3600000, "tags": ["exercise"]},
            "Read chapter 5": {"ms": 5400000, "tags": ["reading"]},
        }
    }


def _make_security_log_entry(event: str, path: str, quarantine: str) -> dict:
    """Build a forensic log entry dict."""
    return {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
        "event": event,
        "path": path,
        "quarantine": quarantine,
        "context": "onboarding",
    }


# ═════════════════════════════════════════════════════════════════════════════
# Shared test infrastructure
# ═════════════════════════════════════════════════════════════════════════════

def _prepopulate_full(transport: MockOnboardingTransport, mk: bytes = TEST_MK):
    """Pre-populate a transport with 3 ledger blocks + staging + index.

    This is the "happy" setup — all data is consistent and encrypted with *mk*.
    """
    b0 = _make_genesis_block(mk)
    b1 = _make_day_block(b0, index=1, mk=mk)
    b2 = _make_day_block(b1, index=2, mk=mk)
    transport.set_ledger_blocks([b0, b1, b2], mk)
    transport.set_staging_blob(_make_staging_blob(mk), mk)
    transport.set_index(_make_index(), mk)


def _prepopulate_chain_divergent(transport: MockOnboardingTransport, mk: bytes = TEST_MK):
    """Pre-populate with 3 blocks where block 1 has corrupted prev_hash.

    Block 0 (genesis) is valid.
    Block 1 has a prev_hash that doesn't match block 0's day_hash.
    Block 2 chains from block 1 (internally consistent but root is broken).
    """
    b0 = _make_genesis_block(mk)
    # Block 1: explicitly corrupt the prev_hash
    b1 = _make_day_block(b0, index=1, mk=mk)
    b1["prev_hash"] = "0000000000000000000000000000000000000000000000000000000000000000"
    # Re-seal with corrupted prev_hash
    crypto = _make_crypto(mk)
    seal_data = {k: v for k, v in b1.items() if k not in ("day_hash", "signature")}
    b1["day_hash"] = crypto.seal(json.dumps(seal_data, sort_keys=True))

    # Block 2: chains from block 1 (internally consistent)
    b2 = _make_day_block(b1, index=2, mk=mk)

    transport.set_ledger_blocks([b0, b1, b2], mk)
    transport.set_staging_blob(_make_staging_blob(mk), mk)
    transport.set_index(_make_index(), mk)


def _make_data_dir(tmpdir: Path) -> Path:
    """Create a clean data directory for a test."""
    data_dir = tmpdir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def _make_config_manager(data_dir: Path) -> MagicMock:
    """Create a mock ConfigManager wired to *data_dir*."""
    cfg = MagicMock()
    cfg.get.return_value = data_dir
    return cfg


# ═════════════════════════════════════════════════════════════════════════════
# E2E Test Suite
# ═════════════════════════════════════════════════════════════════════════════

class TestE2E_01_HappyPath(unittest.TestCase):
    """Seed matches remote data → all data imports successfully.

    Setup:
      - Remote has 3 ledger blocks, valid staging blob (3 entries), valid index
      - Correct seed provided (TEST_SEED → TEST_MK)
      - No existing local ledger

    Expected:
      - All 3 blocks pulled and written to ledger.json
      - Identity extracted from genesis → identity.json
      - Staging blob pulled → staging.json has 3 entries
      - Index pulled → index.json has 1 date key
      - Passphrase set (recover_ledger called)
      - Verify succeeds
      - run_onboarding() returns True
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name) / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_mock = _make_config_manager(self.data_dir)
        self.transport = MockOnboardingTransport()
        _prepopulate_full(self.transport, TEST_MK)

    def tearDown(self):
        self._tmp.cleanup()

    def _run_onboarding(self):
        """Run the onboarding pipeline with mocks for auth/passphrase steps."""
        from cli.onboarding import run_onboarding

        # Mock RecoveryAuthenticator to return our test seed immediately
        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = TEST_MK
            mock_auth_cls.return_value = mock_auth

            # Mock getpass for the passphrase prompts (called by _recover_ledger)
            with patch("getpass.getpass", return_value=TEST_PASSPHRASE) as mock_getpass:

                # Mock input for the "overwrite?" prompt
                with patch("builtins.input", return_value="") as _:
                    return run_onboarding(
                        data_dir=self.data_dir,
                        config_manager=self.config_mock,
                        transport=self.transport,
                    )

    # ── Assertions ────────────────────────────────────────────────────

    # NOTE: These tests will fail (RED) until the code gaps are fixed.
    # They define the *desired* contract.

    def test_01_returns_true(self):
        """Happy path returns True."""
        result = self._run_onboarding()
        self.assertTrue(result)

    def test_02_writes_ledger_json_with_three_blocks(self):
        """ledger.json has exactly the 3 pulled blocks."""
        self._run_onboarding()
        ledger_path = self.data_dir / "ledger.json"
        self.assertTrue(ledger_path.exists(), "ledger.json should exist")
        blocks = json.loads(ledger_path.read_text())
        self.assertIsInstance(blocks, list)
        self.assertEqual(len(blocks), 3)
        self.assertEqual(blocks[0]["type"], "genesis")
        self.assertEqual(blocks[1]["type"], "day")

    def test_03_writes_identity_json(self):
        """identity.json has the identity_secret_enc from genesis."""
        self._run_onboarding()
        identity_path = self.data_dir / "identity.json"
        self.assertTrue(identity_path.exists(), "identity.json should exist")
        identity = json.loads(identity_path.read_text())
        self.assertIn("identity_secret_enc", identity)
        # CryptoManager.encrypt() returns a hex string (no prefix)
        hex_str = identity["identity_secret_enc"]
        self.assertIsInstance(hex_str, str)
        self.assertGreater(len(hex_str), 64,
                          "Encrypted identity should be a long hex string")

    def test_04_writes_staging_json_with_three_entries(self):
        """staging.json has the 3 pulled staging entries."""
        self._run_onboarding()
        staging_path = self.data_dir / "staging.json"
        self.assertTrue(staging_path.exists(), "staging.json should exist")
        entries = json.loads(staging_path.read_text())
        self.assertIsInstance(entries, list)
        self.assertEqual(len(entries), 3)

    def test_05_writes_index_json(self):
        """index.json has the pulled index data."""
        self._run_onboarding()
        index_path = self.data_dir / "index.json"
        self.assertTrue(index_path.exists(), "index.json should exist")
        index = json.loads(index_path.read_text())
        self.assertIn("2026-06-20", index)

    def test_06_ledger_blocks_are_re_sealed(self):
        """After passphrase set, genesis has new recovery_seed_enc and new day_hash."""
        self._run_onboarding()
        blocks = json.loads((self.data_dir / "ledger.json").read_text())
        genesis = blocks[0]
        # day_hash should be a non-empty hex string
        self.assertIsNotNone(genesis.get("day_hash"))
        self.assertGreater(len(genesis["day_hash"]), 10)
        # recovery_seed_enc should be present (was re-encrypted)
        self.assertIn("recovery_seed_enc", genesis.get("identity", {}))

    def test_07_pulled_all_three_blocks_from_transport(self):
        """Transport was queried for all 3 block files."""
        self._run_onboarding()
        expected_paths = [
            f"{LEDGER_BLOCKS_PREFIX}{i:06d}.json" for i in range(3)
        ]
        for p in expected_paths:
            self.assertIn(p, self.transport.pull_calls,
                          f"Should have pulled {p}")

    def test_08_pulled_staging_and_index(self):
        """Transport was queried for staging blob and index."""
        self._run_onboarding()
        self.assertIn(STAGING_PATH, self.transport.pull_calls)
        self.assertIn(INDEX_PATH, self.transport.pull_calls)

    def test_09_calls_list_files_for_block_enumeration(self):
        """RemoteLedgerSync lists block files on remote."""
        self._run_onboarding()
        self.assertIn(LEDGER_BLOCKS_PREFIX, self.transport.list_files_calls)


class TestE2E_02_WrongSeed(unittest.TestCase):
    """Wrong seed → deobfuscation fails → friendly error, no partial writes.

    Setup:
      - Remote has 3 ledger blocks (obfuscated with TEST_MK)
      - User enters WRONG_SEED → derives WRONG_MK
      - WRONG_MK cannot deobfuscate blocks encrypted with TEST_MK

    Expected:
      - pull_blocks fails with ValueError (deobfuscation failure)
      - Pipeline catches this and returns False
      - Friendly message printed (no traceback)
      - No ledger.json, staging.json, identity.json, or index.json written
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name) / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_mock = _make_config_manager(self.data_dir)
        self.transport = MockOnboardingTransport()
        _prepopulate_full(self.transport, TEST_MK)  # obfuscated with TEST_MK

    def tearDown(self):
        self._tmp.cleanup()

    def _run_onboarding_with_wrong_seed(self):
        """Run onboarding with a wrong seed (WRONG_MK instead of TEST_MK)."""
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = WRONG_MK  # wrong!
            mock_auth_cls.return_value = mock_auth

            with patch("builtins.input", return_value="") as _:
                return run_onboarding(
                    data_dir=self.data_dir,
                    config_manager=self.config_mock,
                    transport=self.transport,
                )

    def test_10_returns_false(self):
        """Wrong seed returns False (no crash)."""
        # EXPECTED: After fix, this should return False gracefully.
        # CURRENTLY: Raises ValueError from deobfuscation — uncaught!
        result = self._run_onboarding_with_wrong_seed()
        self.assertFalse(result)

    def test_11_no_ledger_json_written(self):
        """No partial write of ledger.json on wrong seed."""
        try:
            self._run_onboarding_with_wrong_seed()
        except Exception:
            pass  # will be handled after fix
        ledger_path = self.data_dir / "ledger.json"
        self.assertFalse(ledger_path.exists(),
                         "ledger.json should NOT be written on wrong seed")

    def test_12_no_staging_json_written(self):
        """No staging.json written on wrong seed."""
        try:
            self._run_onboarding_with_wrong_seed()
        except Exception:
            pass
        staging_path = self.data_dir / "staging.json"
        self.assertFalse(staging_path.exists())

    def test_13_no_identity_json_written(self):
        """No identity.json written on wrong seed."""
        try:
            self._run_onboarding_with_wrong_seed()
        except Exception:
            pass
        identity_path = self.data_dir / "identity.json"
        self.assertFalse(identity_path.exists())

    def test_14_no_index_json_written(self):
        """No index.json written on wrong seed."""
        try:
            self._run_onboarding_with_wrong_seed()
        except Exception:
            pass
        index_path = self.data_dir / "index.json"
        self.assertFalse(index_path.exists())

    def test_15_friendly_error_message(self):
        """Wrong seed produces a friendly message, not a traceback."""
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = WRONG_MK
            mock_auth_cls.return_value = mock_auth

            # Capture print output
            with patch("builtins.print") as mock_print:
                with patch("builtins.input", return_value=""):
                    with self.assertRaises(Exception) if False else \
                            type("_", (), {"__enter__": lambda s: None, "__exit__": lambda *a: None})():
                        run_onboarding(
                            data_dir=self.data_dir,
                            config_manager=self.config_mock,
                            transport=self.transport,
                        )

                # Collect all print calls
                messages = [str(c[0][0]) if c[0] else "" for c in mock_print.call_args_list]

                # After fix: should see "wrong seed" or "deobfuscation failed"
                has_friendly = any(
                    "seed" in m.lower() or "deobfuscation" in m.lower() or "decrypt" in m.lower()
                    for m in messages
                )
                has_traceback = any("Traceback" in m for m in messages)

                self.assertTrue(has_friendly,
                                "Should show a friendly error message about wrong seed")
                self.assertFalse(has_traceback,
                                 "Should NOT show a Python traceback")


class TestE2E_03_EmptyRemote(unittest.TestCase):
    """Empty remote → graceful exit, no files written.

    Setup:
      - Remote has zero blocks, zero staging, zero index
      - Correct seed provided

    Expected:
      - Returns False (nothing to import)
      - No files written to data_dir
      - No traceback
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name) / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_mock = _make_config_manager(self.data_dir)
        self.transport = MockOnboardingTransport()  # empty — no data loaded

    def tearDown(self):
        self._tmp.cleanup()

    def _run_onboarding_empty(self):
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = TEST_MK
            mock_auth_cls.return_value = mock_auth

            with patch("builtins.input", return_value=""):
                return run_onboarding(
                    data_dir=self.data_dir,
                    config_manager=self.config_mock,
                    transport=self.transport,
                )

    def test_16_returns_false(self):
        """Empty remote returns False gracefully."""
        result = self._run_onboarding_empty()
        self.assertFalse(result)

    def test_17_no_ledger_json(self):
        """No ledger.json on empty remote."""
        self._run_onboarding_empty()
        self.assertFalse((self.data_dir / "ledger.json").exists())

    def test_18_no_staging_json(self):
        """No staging.json on empty remote."""
        self._run_onboarding_empty()
        self.assertFalse((self.data_dir / "staging.json").exists())

    def test_19_no_identity_json(self):
        """No identity.json on empty remote."""
        self._run_onboarding_empty()
        self.assertFalse((self.data_dir / "identity.json").exists())

    def test_20_no_index_json(self):
        """No index.json on empty remote."""
        self._run_onboarding_empty()
        self.assertFalse((self.data_dir / "index.json").exists())

    def test_21_prints_no_blocks_message(self):
        """Prints informative 'no blocks' message."""
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = TEST_MK
            mock_auth_cls.return_value = mock_auth

            with patch("builtins.print") as mock_print:
                with patch("builtins.input", return_value=""):
                    run_onboarding(
                        data_dir=self.data_dir,
                        config_manager=self.config_mock,
                        transport=self.transport,
                    )

                messages = " ".join(str(c[0][0]) if c[0] else "" for c in mock_print.call_args_list)
                self.assertIn("No ledger blocks", messages,
                              "Should inform user that no ledger data exists on remote")


class TestE2E_04_NoStagingBlob(unittest.TestCase):
    """Ledger exists but no staging blob → writes empty staging, continues.

    This is the NORMAL degraded path — the source device has already
    synced all entries to the ledger. Pending staging is simply absent.

    Setup:
      - Remote has 3 ledger blocks and index, but NO staging blob
      - Correct seed provided

    Expected:
      - Ledger imported successfully (3 blocks)
      - identity.json extracted
      - staging.json written as empty list [] (not an error)
      - index.json written
      - Passphrase set, verify passes
      - Returns True
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name) / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_mock = _make_config_manager(self.data_dir)
        self.transport = MockOnboardingTransport()

        # Pre-populate blocks and index, but NOT staging
        b0 = _make_genesis_block(TEST_MK)
        b1 = _make_day_block(b0, index=1, mk=TEST_MK)
        b2 = _make_day_block(b1, index=2, mk=TEST_MK)
        self.transport.set_ledger_blocks([b0, b1, b2], TEST_MK)
        self.transport.set_index(_make_index(), TEST_MK)
        # NO staging blob set

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self):
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = TEST_MK
            mock_auth_cls.return_value = mock_auth

            with patch("getpass.getpass", return_value=TEST_PASSPHRASE):
                with patch("builtins.input", return_value=""):
                    return run_onboarding(
                        data_dir=self.data_dir,
                        config_manager=self.config_mock,
                        transport=self.transport,
                    )

    def test_22_returns_true(self):
        """No staging blob → still returns True."""
        result = self._run()
        self.assertTrue(result)

    def test_23_ledger_json_has_three_blocks(self):
        """ledger.json has all 3 blocks."""
        self._run()
        blocks = json.loads((self.data_dir / "ledger.json").read_text())
        self.assertEqual(len(blocks), 3)

    def test_24_staging_json_is_empty_list(self):
        """staging.json is an empty array when no remote staging."""
        self._run()
        entries = json.loads((self.data_dir / "staging.json").read_text())
        self.assertEqual(entries, [])

    def test_25_identity_json_extracted(self):
        """identity.json extracted from genesis even without staging."""
        self._run()
        identity = json.loads((self.data_dir / "identity.json").read_text())
        self.assertIn("identity_secret_enc", identity)

    def test_26_index_json_has_data(self):
        """index.json written with pulled remote index."""
        self._run()
        index = json.loads((self.data_dir / "index.json").read_text())
        self.assertIn("2026-06-20", index)


class TestE2E_05_StagingKeyMismatch(unittest.TestCase):
    """Staging blob exists but encrypted with different key → quarantine + continue.

    This is an observable anomaly (rare). The ledger imported successfully,
    but the staging blob can't be decrypted. The pipeline should:
      1. Show a prominent warning to the user
      2. Save the raw blob to ``data_dir/forensic/`` for later analysis
      3. Log the event to ``forensic/events.log``
      4. Delete the corrupted remote staging blob
      5. Write empty local staging
      6. Continue with ledger import → return True

    Setup:
      - Remote has 3 ledger blocks (obfuscated with TEST_MK)
      - Remote has a staging blob obfuscated with WRONG_MK (different key)
      - Correct seed provided (TEST_SEED → TEST_MK)
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name) / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_mock = _make_config_manager(self.data_dir)
        self.transport = MockOnboardingTransport()

        # Pre-populate blocks with TEST_MK
        b0 = _make_genesis_block(TEST_MK)
        b1 = _make_day_block(b0, index=1, mk=TEST_MK)
        b2 = _make_day_block(b1, index=2, mk=TEST_MK)
        self.transport.set_ledger_blocks([b0, b1, b2], TEST_MK)
        self.transport.set_index(_make_index(), TEST_MK)

        # Pre-populate staging blob with WRONG_MK — key mismatch!
        self.transport.set_staging_blob(_make_staging_blob(WRONG_MK), WRONG_MK)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self):
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = TEST_MK
            mock_auth_cls.return_value = mock_auth

            with patch("getpass.getpass", return_value=TEST_PASSPHRASE):
                with patch("builtins.input", return_value=""):
                    return run_onboarding(
                        data_dir=self.data_dir,
                        config_manager=self.config_mock,
                        transport=self.transport,
                    )

    def test_27_returns_true_despite_mismatch(self):
        """Returns True — ledger import succeeded despite staging mismatch."""
        result = self._run()
        self.assertTrue(result)

    def test_28_ledger_json_has_three_blocks(self):
        """ledger.json has all 3 blocks (ledger import unaffected)."""
        self._run()
        blocks = json.loads((self.data_dir / "ledger.json").read_text())
        self.assertEqual(len(blocks), 3)

    def test_29_staging_json_is_empty_list(self):
        """staging.json is empty — mismatched blob not imported."""
        self._run()
        entries = json.loads((self.data_dir / "staging.json").read_text())
        self.assertEqual(entries, [])

    def test_30_transport_delete_called_on_staging(self):
        """Corrupted remote staging blob is deleted from transport."""
        self._run()
        self.assertIn(STAGING_PATH, self.transport.delete_calls,
                      "Corrupted staging blob should be deleted from remote")

    def test_31_forensic_quarantine_created(self):
        """Raw blob bytes saved to data_dir/forensic/ for analysis."""
        self._run()
        forensic_dir = self.data_dir / "forensic"
        self.assertTrue(forensic_dir.exists(),
                        "forensic/ directory should exist")

        # Should have at least one .bin file
        bin_files = list(forensic_dir.glob("*.bin"))
        self.assertGreaterEqual(len(bin_files), 1,
                                "At least one quarantined blob file expected")

    def test_32_events_log_created(self):
        """forensic/events.log has an entry for the mismatch."""
        self._run()
        log_path = self.data_dir / "forensic" / "events.log"
        self.assertTrue(log_path.exists(), "events.log should exist")
        log_text = log_path.read_text()
        self.assertIn("staging_key_mismatch", log_text,
                      "Log should contain the event type")

    def test_33_prominent_warning_printed(self):
        """User sees a prominent warning about staging corruption."""
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = TEST_MK
            mock_auth_cls.return_value = mock_auth

            with patch("builtins.print") as mock_print:
                with patch("getpass.getpass", return_value=TEST_PASSPHRASE):
                    with patch("builtins.input", return_value=""):
                        run_onboarding(
                            data_dir=self.data_dir,
                            config_manager=self.config_mock,
                            transport=self.transport,
                        )

                messages = " ".join(
                    str(c[0][0]) if c[0] else "" for c in mock_print.call_args_list
                )
                self.assertIn("staging", messages.lower(),
                              "Warning should mention staging")
                self.assertIn("key", messages.lower(),
                              "Warning should mention key")


class TestE2E_06_ChainDivergence(unittest.TestCase):
    """Corrupted prev_hash in remote block → abort, no partial writes.

    Setup:
      - Remote has 3 blocks. Block 0 (genesis) is valid.
      - Block 1 has a corrupted prev_hash (doesn't match block 0's day_hash).
      - Block 2 is internally consistent but can't chain from block 0.
      - Correct seed provided.

    Expected:
      - RemoteLedgerSync detects divergence at block 1
      - Pipeline detects that the pulled chain is incomplete
      - Aborts with clear message about corrupted chain
      - No files written to data_dir
      - Returns False
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name) / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_mock = _make_config_manager(self.data_dir)
        self.transport = MockOnboardingTransport()
        _prepopulate_chain_divergent(self.transport, TEST_MK)

    def tearDown(self):
        self._tmp.cleanup()

    def _run(self):
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = TEST_MK
            mock_auth_cls.return_value = mock_auth

            with patch("builtins.input", return_value=""):
                return run_onboarding(
                    data_dir=self.data_dir,
                    config_manager=self.config_mock,
                    transport=self.transport,
                )

    def test_34_returns_false(self):
        """Chain divergence returns False (abort)."""
        result = self._run()
        self.assertFalse(result)

    def test_35_no_ledger_json_written(self):
        """No partial write of ledger.json when chain is corrupted."""
        try:
            self._run()
        except Exception:
            pass
        self.assertFalse((self.data_dir / "ledger.json").exists())

    def test_36_no_other_files_written(self):
        """No other data files written on chain divergence."""
        try:
            self._run()
        except Exception:
            pass
        for fname in ["staging.json", "identity.json", "index.json"]:
            self.assertFalse(
                (self.data_dir / fname).exists(),
                f"{fname} should NOT be written on chain divergence",
            )

    def test_37_clear_error_message_printed(self):
        """User sees a clear message about the corrupted chain."""
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = TEST_MK
            mock_auth_cls.return_value = mock_auth

            with patch("builtins.print") as mock_print:
                with patch("builtins.input", return_value=""):
                    try:
                        run_onboarding(
                            data_dir=self.data_dir,
                            config_manager=self.config_mock,
                            transport=self.transport,
                        )
                    except Exception:
                        pass

                messages = " ".join(
                    str(c[0][0]) if c[0] else "" for c in mock_print.call_args_list
                )
                has_chain_msg = (
                    "chain" in messages.lower()
                    or "corrupt" in messages.lower()
                    or "divergence" in messages.lower()
                )
                self.assertTrue(has_chain_msg,
                                "Should warn about chain corruption")


class TestE2E_07_FullRoundTrip(unittest.TestCase):
    """Full lifecycle: init → add → sync → second device onboard.

    This simulates two devices sharing a single transport.
    Device 1 initializes the ledger, adds entries, and syncs.
    Device 2 runs onboarding against the same transport.

    This is the most comprehensive test — it validates that the data
    format produced by init/sync is consumable by onboarding.

    Setup:
      - Shared MockOnboardingTransport
      - Device 1: runs the init/sync flow programmatically
      - Device 2: runs onboarding against the post-sync transport state
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir1 = Path(self._tmp.name) / "device1"
        self.data_dir2 = Path(self._tmp.name) / "device2"
        self.data_dir1.mkdir(parents=True, exist_ok=True)
        self.data_dir2.mkdir(parents=True, exist_ok=True)
        self.config1 = _make_config_manager(self.data_dir1)
        self.config2 = _make_config_manager(self.data_dir2)
        self.transport = MockOnboardingTransport()

    def tearDown(self):
        self._tmp.cleanup()

    def _simulate_device1_init_sync(self):
        """Programmatically simulate init + add + sync on device 1.

        Writes data into *self.transport* so device 2 can onboard from it.
        """
        mk = TEST_MK

        # Step A: Init — create genesis block, push to transport
        genesis = _make_genesis_block(mk)
        self.transport.set_ledger_block(0, genesis, mk)

        # Step B: Add 3 entries to staging
        staging = _make_staging_blob(mk)
        self.transport.set_staging_blob(staging, mk)

        # Step C: Sync — commit 2 completed entries to ledger blocks
        # (simulate what ph sync does: move completed entries from staging
        #  to new ledger blocks, remove them from staging blob)

        # Build day block 1 from the first completed entry
        b1 = _make_day_block(genesis, index=1, mk=mk)

        # Build day block 2 from the second completed entry
        b2 = _make_day_block(b1, index=2, mk=mk)

        self.transport.set_ledger_block(1, b1, mk)
        self.transport.set_ledger_block(2, b2, mk)

        # Update staging: keep only the active entry (index 2)
        remaining_staging = {
            "device_id": staging["device_id"],
            "device_proof": staging["device_proof"],
            "entries": [staging["entries"][2]],  # only "Meditate" (active)
            "updated_at": staging["updated_at"],
        }
        self.transport.set_staging_blob(remaining_staging, mk)

        # Push index
        self.transport.set_index(_make_index(), mk)

    def _onboard_device2(self) -> bool:
        """Run onboarding for device 2 against the same transport."""
        from cli.onboarding import run_onboarding

        with patch("cli.onboarding.RecoveryAuthenticator") as mock_auth_cls:
            mock_auth = MagicMock()
            mock_auth.authenticate.return_value = True
            mock_auth.get_key.return_value = TEST_MK
            mock_auth_cls.return_value = mock_auth

            with patch("getpass.getpass", return_value=TEST_PASSPHRASE):
                with patch("builtins.input", return_value=""):
                    return run_onboarding(
                        data_dir=self.data_dir2,
                        config_manager=self.config2,
                        transport=self.transport,
                    )

    def test_38_device2_onboarding_returns_true(self):
        """Full round-trip: device 2 onboarding succeeds."""
        self._simulate_device1_init_sync()
        result = self._onboard_device2()
        self.assertTrue(result)

    def test_39_device2_has_three_ledger_blocks(self):
        """Device 2's ledger matches device 1's after sync (3 blocks)."""
        self._simulate_device1_init_sync()
        self._onboard_device2()
        blocks = json.loads((self.data_dir2 / "ledger.json").read_text())
        self.assertEqual(len(blocks), 3)
        self.assertEqual(blocks[0]["type"], "genesis")
        self.assertEqual(blocks[1]["type"], "day")
        self.assertEqual(blocks[2]["type"], "day")

    def test_40_device2_has_one_staging_entry(self):
        """Device 2's staging has only the active entry, not the committed ones."""
        self._simulate_device1_init_sync()
        self._onboard_device2()
        entries = json.loads((self.data_dir2 / "staging.json").read_text())
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Meditate")

    def test_41_device2_identity_extracted(self):
        """Device 2 extracts identity from genesis."""
        self._simulate_device1_init_sync()
        self._onboard_device2()
        identity = json.loads((self.data_dir2 / "identity.json").read_text())
        self.assertIn("identity_secret_enc", identity)

    def test_42_device2_index_matches(self):
        """Device 2's index has the same data as device 1's."""
        self._simulate_device1_init_sync()
        self._onboard_device2()
        index = json.loads((self.data_dir2 / "index.json").read_text())
        self.assertIn("2026-06-20", index)
        self.assertIn("Morning run", index["2026-06-20"])

    def test_43_device2_blocks_chain_integrity(self):
        """Device 2's blocks chain correctly after re-seal/re-sign."""
        self._simulate_device1_init_sync()
        self._onboard_device2()
        blocks = json.loads((self.data_dir2 / "ledger.json").read_text())

        # Check prev_hash linkage
        for i in range(1, len(blocks)):
            prev = blocks[i - 1]
            curr = blocks[i]
            prev_hash = (
                prev.get("day_hash")
                or prev.get("month_hash")
                or prev.get("year_hash")
            )
            self.assertEqual(
                curr.get("prev_hash"),
                prev_hash,
                f"Block {i} prev_hash should match block {i-1}'s hash",
            )

    def test_44_device2_no_remote_data_left_behind(self):
        """After onboarding, remote staging that was mismatched is cleaned up.
        (Applies only if mismatch scenario — in happy path, staging is consumed.)"""
        self._simulate_device1_init_sync()
        self._onboard_device2()
        # In the happy round-trip, staging is a valid blob with matching key
        # so it should NOT be deleted
        self.assertNotIn(STAGING_PATH, self.transport.delete_calls,
                         "Happy-path staging should not be deleted")


# ═════════════════════════════════════════════════════════════════════════════
# Test: Registry-based onboarding flows (Phase 5d — Item 8)
# ═════════════════════════════════════════════════════════════════════════════

class TestE2E_08_RegistryCreateTransportFromConfig(unittest.TestCase):
    """Verify ``create_transport_from_config`` in the registry module delegates
    to registered providers for each transport type."""

    def setUp(self):
        from core.sync.transport_registry import reset_registry
        reset_registry()

    def tearDown(self):
        from core.sync.transport_registry import reset_registry
        reset_registry()

    def test_45_registry_create_git_uses_registry_provider(self):
        """When config has transport=git + git_remote_url, the registry's
        git provider factory is used to create a GitStagingTransport.

        The GitStagingTransport constructor only stores URL/path; actual
        git clone happens lazily on first pull/push. So even a fake URL
        returns a valid transport object."""
        from core.sync.transport_registry import create_transport_from_config
        from core.sync.git_transport import GitStagingTransport

        config = {
            "remote": {
                "transport": "git",
                "git_remote_url": "git@github.com:user/repo.git",
            },
            "_config_dir": str(Path("/tmp/fake")),
        }
        transport = create_transport_from_config(config)
        self.assertIsInstance(transport, GitStagingTransport,
                              "Should create GitStagingTransport via registry")

    def test_46_registry_create_http_cloudflare(self):
        """When config has transport=http + provider=cloudflare, the
        registry's http-cloudflare factory creates an HttpStagingTransport."""
        from core.sync.transport_registry import create_transport_from_config
        from core.sync.http_transport import HttpStagingTransport

        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "cloudflare",
                "base_url": "https://test.workers.dev",
            },
            "_config_dir": str(Path("/tmp/fake")),
        }
        transport = create_transport_from_config(config)
        self.assertIsInstance(transport, HttpStagingTransport,
                              "Should create HttpStagingTransport via registry")
        self.assertEqual(transport.base_url, "https://test.workers.dev")

    def test_47_registry_create_http_generic(self):
        """When config has transport=http + provider=generic, the
        registry's http-generic factory creates an HttpStagingTransport."""
        from core.sync.transport_registry import create_transport_from_config
        from core.sync.http_transport import HttpStagingTransport

        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "generic",
                "base_url": "https://example.com/staging",
                "api_key": "sk-test-key",
            },
            "_config_dir": str(Path("/tmp/fake")),
        }
        transport = create_transport_from_config(config)
        self.assertIsInstance(transport, HttpStagingTransport,
                              "Should create HttpStagingTransport via registry")
        self.assertEqual(transport.base_url, "https://example.com/staging")

    def test_48_registry_create_http_unknown_provider_fallback(self):
        """When http.provider is unknown, fallback to direct HttpStagingTransport."""
        from core.sync.transport_registry import create_transport_from_config
        from core.sync.http_transport import HttpStagingTransport

        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "custom-unknown",
                "base_url": "https://custom.example.com",
            },
            "_config_dir": str(Path("/tmp/fake")),
        }
        transport = create_transport_from_config(config)
        self.assertIsInstance(transport, HttpStagingTransport,
                              "Unknown provider should fall back to direct HttpStagingTransport")
        self.assertEqual(transport.base_url, "https://custom.example.com")

    def test_49_registry_no_remote_config_returns_none(self):
        """When no remote transport is configured, returns None."""
        from core.sync.transport_registry import create_transport_from_config

        config = {"_config_dir": str(Path("/tmp/fake"))}
        transport = create_transport_from_config(config)
        self.assertIsNone(transport)

    def test_50_registry_http_no_base_url_returns_none(self):
        """When http transport is set but base_url is missing, returns None."""
        from core.sync.transport_registry import create_transport_from_config

        config = {
            "remote": {"transport": "http"},
            "http": {"provider": "cloudflare"},
            "_config_dir": str(Path("/tmp/fake")),
        }
        transport = create_transport_from_config(config)
        self.assertIsNone(transport,
                          "Missing base_url should return None")


class TestE2E_09_RegistryIntegrationWithOnboarding(unittest.TestCase):
    """End-to-end test: onboarding pipeline consumes a transport obtained
    from the registry, verifying the full provider → config → transport →
    pipeline flow."""

    def setUp(self):
        # Use a temp directory for data files
        self.data_dir = Path(tempfile.mkdtemp(prefix="phpoc_e2e_registry_"))
        self.ledger_path = self.data_dir / "ledger.json"
        self.staging_path = self.data_dir / "staging.json"
        self.identity_path = self.data_dir / "identity.json"
        self.index_path = self.data_dir / "index.json"

        self.build_chain()
        self.build_staging()

        # Create mock transport with pre-loaded data
        self.transport = MockOnboardingTransport()
        self.transport.set_ledger_blocks(self.chain, TEST_MK)
        self.transport.set_staging_blob(
            {"entries": self.staging_entries}, TEST_MK
        )
        self.transport.set_index({"2026-06-01": ["hash_abc"]}, TEST_MK)

        # Register a mock transport provider in the registry
        from core.sync.transport_registry import (
            TransportProvider,
            get_registry,
            reset_registry,
        )
        reset_registry()
        self.registry = get_registry()

        # Create a custom provider that yields our pre-loaded mock transport
        captured = {"called": False, "transport": self.transport}

        def _mock_prompt_config():
            captured["called"] = True
            config = {
                "remote": {"transport": "http"},
                "http": {"provider": "mock-e2e", "base_url": "https://mock.test"},
            }
            return config, captured["transport"]

        # create_transport_from_config looks up "http-{provider}", so
        # register with the http- prefix to match the lookup convention.
        mock_provider = TransportProvider(
            id_="http-mock-e2e",
            name="Mock E2E Transport",
            description="Mock transport for E2E registry tests",
            prompt_config=_mock_prompt_config,
            transport_factory=lambda c, d: captured["transport"],
            requires_api_key=False,
        )
        self.registry.register(mock_provider)
        # Also register without prefix for direct lookup in test_51
        self.registry.register(TransportProvider(
            id_="mock-e2e",
            name="Mock E2E Transport",
            description="Mock transport for E2E registry tests",
            prompt_config=_mock_prompt_config,
            transport_factory=lambda c, d: captured["transport"],
            requires_api_key=False,
        ))
        self.captured = captured

    def tearDown(self):
        import shutil
        from core.sync.transport_registry import reset_registry
        reset_registry()
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def build_chain(self):
        """Build a 3-block chain for E2E testing."""
        genesis = _make_genesis_block(TEST_MK)
        day1 = _make_day_block(genesis, index=1, mk=TEST_MK)
        day2 = _make_day_block(day1, index=2, mk=TEST_MK)
        self.chain = [genesis, day1, day2]

    def build_staging(self):
        """Build a simple staging entry list."""
        self.staging_entries = [
            {
                "entry_id": "e1",
                "title": "Test task 1",
                "date": "2026-06-15",
                "start_time": 1000000,
                "end_time": 1001000,
                "device_uuid": "dev1",
                "tags": ["test"],
            }
        ]

    def _make_config_manager(self):
        """Create a mock ConfigManager that supports write()."""
        config_mgr = MagicMock()
        config_mgr.read.return_value = {}
        written = {}
        config_mgr.write = lambda update: written.update(update)
        config_mgr.get = lambda key, default=None: written.get(key, default)
        config_mgr.set = lambda k, v: written.update({k: v})
        return config_mgr

    # ── Registry → transport → onboarding pipeline ─────────────────────

    @patch("builtins.input")
    @patch("getpass.getpass")
    def test_51_registry_provider_creates_transport(self, mock_getpass, mock_input):
        """A provider registered in the registry creates a transport
        that is consumed by the onboarding pipeline."""
        from core.sync.transport_registry import get_registry

        registry = get_registry()
        provider = registry.get("mock-e2e")
        self.assertIsNotNone(provider, "mock-e2e provider should be registered")

        config_update, transport = provider.prompt_config()
        self.assertTrue(self.captured["called"],
                        "prompt_config should have been called")
        self.assertIsNotNone(transport,
                             "prompt_config should return a transport")
        self.assertIsInstance(transport, MockOnboardingTransport)
        self.assertIsNotNone(config_update,
                             "prompt_config should return config")
        self.assertEqual(config_update["remote"]["transport"], "http")

    @patch("builtins.input")
    @patch("getpass.getpass")
    def test_52_registry_provider_onboarding_writes_ledger(self, mock_getpass, mock_input):
        """Full pipeline: registry provider → transport → run_onboarding
        → ledger.json is written."""
        # Mock: passphrase (same twice), seed entry
        mock_getpass.side_effect = [
            "new-passphrase",  # passphrase 1
            "new-passphrase",  # confirm
        ]
        mock_input.side_effect = [
            TEST_SEED,  # recovery seed
            "y",        # overwrite? (ledger already exists from Happy Path test? No, tmp dir is fresh)
        ]

        from cli.onboarding import run_onboarding

        config_mgr = self._make_config_manager()
        ok = run_onboarding(
            data_dir=self.data_dir,
            config_manager=config_mgr,
            transport=self.transport,
        )
        self.assertTrue(ok, "Onboarding should succeed")
        self.assertTrue(self.ledger_path.exists(),
                        "ledger.json should be written")

        ledger_data = json.loads(self.ledger_path.read_text())
        self.assertEqual(len(ledger_data), 3,
                         "Should have 3 ledger blocks")
        self.assertEqual(ledger_data[0]["type"], "genesis")

    @patch("builtins.input")
    @patch("getpass.getpass")
    def test_53_registry_provider_onboarding_writes_staging(self, mock_getpass, mock_input):
        """Onboarding via registry provider writes staging.json."""
        mock_getpass.side_effect = ["pw1", "pw1"]
        mock_input.side_effect = [TEST_SEED, "y"]

        from cli.onboarding import run_onboarding

        config_mgr = self._make_config_manager()
        ok = run_onboarding(
            data_dir=self.data_dir,
            config_manager=config_mgr,
            transport=self.transport,
        )
        self.assertTrue(ok)
        self.assertTrue(self.staging_path.exists(),
                        "staging.json should be written")

        staging_data = json.loads(self.staging_path.read_text())
        self.assertIsInstance(staging_data, list)
        self.assertEqual(len(staging_data), 1,
                         "Should have 1 staging entry")

    @patch("builtins.input")
    @patch("getpass.getpass")
    def test_54_registry_provider_onboarding_writes_identity(self, mock_getpass, mock_input):
        """Onboarding via registry provider extracts identity from genesis."""
        mock_getpass.side_effect = ["pw1", "pw1"]
        mock_input.side_effect = [TEST_SEED, "y"]

        from cli.onboarding import run_onboarding

        config_mgr = self._make_config_manager()
        ok = run_onboarding(
            data_dir=self.data_dir,
            config_manager=config_mgr,
            transport=self.transport,
        )
        self.assertTrue(ok)
        self.assertTrue(self.identity_path.exists(),
                        "identity.json should be written")

        identity_data = json.loads(self.identity_path.read_text())
        self.assertIn("identity_secret_enc", identity_data)

    @patch("builtins.input")
    @patch("getpass.getpass")
    def test_55_registry_provider_onboarding_writes_index(self, mock_getpass, mock_input):
        """Onboarding via registry provider writes index.json."""
        mock_getpass.side_effect = ["pw1", "pw1"]
        mock_input.side_effect = [TEST_SEED, "y"]

        from cli.onboarding import run_onboarding

        config_mgr = self._make_config_manager()
        ok = run_onboarding(
            data_dir=self.data_dir,
            config_manager=config_mgr,
            transport=self.transport,
        )
        self.assertTrue(ok)
        self.assertTrue(self.index_path.exists(),
                        "index.json should be written")

        index_data = json.loads(self.index_path.read_text())
        self.assertIsInstance(index_data, dict)

    @patch("builtins.input")
    @patch("getpass.getpass")
    def test_56_registry_provider_wrong_seed_returns_false(self, mock_getpass, mock_input):
        """Onboarding with wrong seed via registry provider returns False."""
        mock_getpass.side_effect = ["pw1", "pw1"]
        mock_input.side_effect = [WRONG_SEED, "y"]

        from cli.onboarding import run_onboarding

        config_mgr = self._make_config_manager()
        ok = run_onboarding(
            data_dir=self.data_dir,
            config_manager=config_mgr,
            transport=self.transport,
        )
        self.assertFalse(ok, "Onboarding should fail with wrong seed")
        # No partial writes
        self.assertFalse(self.ledger_path.exists(),
                         "ledger.json should NOT be written on wrong seed")

    # ── create_transport_from_config with custom registry ──────────────

    def test_57_custom_registered_provider_via_create_transport(self):
        """create_transport_from_config uses a custom-registered provider's
        transport_factory."""
        from core.sync.transport_registry import create_transport_from_config

        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "mock-e2e",
                "base_url": "https://mock.test",
            },
            "_config_dir": str(self.data_dir),
        }
        transport = create_transport_from_config(config)
        self.assertIsNotNone(transport,
                             "Should create transport via custom registry provider")
        self.assertIsInstance(transport, MockOnboardingTransport)

    def test_58_create_transport_config_persistence(self):
        """Config written by prompt_config can be read back by
        create_transport_from_config."""
        from core.sync.transport_registry import get_registry, create_transport_from_config

        provider = get_registry().get("mock-e2e")
        config_update, transport = provider.prompt_config()

        # Simulate config persistence round-trip
        persisted = {
            **config_update,
            "_config_dir": str(self.data_dir),
        }
        recreated = create_transport_from_config(persisted)
        self.assertIsNotNone(recreated)
        self.assertIsInstance(recreated, MockOnboardingTransport)


class TestE2E_10_OnboardingPicker(unittest.TestCase):
    """End-to-end tests: ``run_onboarding_picker()`` interactive menu UI.

    Covers:
      - Provider list rendering and selection
      - Cancel flow (0)
      - Invalid input handling (out of range, non-numeric)
      - Empty registry
      - Provider prompt_config returning None (user cancel)
      - Config write before delegation
      - Delegation to ``run_onboarding()``
    """

    def setUp(self):
        self.data_dir = Path(tempfile.mkdtemp(prefix="phpoc_e2e_picker_"))
        self.ledger_path = self.data_dir / "ledger.json"
        self.staging_path = self.data_dir / "staging.json"
        self.identity_path = self.data_dir / "identity.json"
        self.index_path = self.data_dir / "index.json"

        # Reset registry to clean state before each test
        from core.sync.transport_registry import reset_registry, get_registry, TransportProvider
        reset_registry()
        registry = get_registry()

        # Keep built-in providers, but also add a test provider with known behavior
        self._prompt_called = False
        self._prompt_transport = None
        self._prompt_config = None

        def _test_prompt():
            self._prompt_called = True
            # Return a mock transport that has methods needed by the pipeline
            mock_t = MagicMock(spec_set=["pull", "push", "list_files", "delete"])
            mock_t.pull.return_value = None  # No data by default
            mock_t.list_files.return_value = []
            self._prompt_transport = mock_t
            cfg = {
                "remote": {"transport": "http"},
                "http": {"provider": "test", "base_url": "https://test.local"},
            }
            self._prompt_config = cfg
            return cfg, mock_t

        self.test_provider = TransportProvider(
            id_="http-test-picker",
            name="AA Test Picker Provider",
            description="Test provider for picker UI tests",
            prompt_config=_test_prompt,
            transport_factory=lambda c, d: None,
            requires_api_key=False,
        )
        registry.register(self.test_provider)

        # Config manager mock
        self.written_configs = []
        config_mgr = MagicMock()
        config_mgr.read.return_value = {}
        config_mgr.write = lambda update: self.written_configs.append(update)
        config_mgr.get = lambda key, default=None: default
        self.config_mgr = config_mgr

        # Pre-populate mock transport for successful onboarding
        self.transport = MockOnboardingTransport()
        self.chain = [_make_genesis_block(TEST_MK)]
        # Add day blocks
        b1 = _make_day_block(self.chain[0], index=1, mk=TEST_MK)
        b2 = _make_day_block(b1, index=2, mk=TEST_MK)
        self.chain.extend([b1, b2])
        self.transport.set_ledger_blocks(self.chain, TEST_MK)
        self.transport.set_staging_blob(
            {"entries": []}, TEST_MK
        )
        self.transport.set_index({}, TEST_MK)

    def tearDown(self):
        import shutil
        from core.sync.transport_registry import reset_registry
        reset_registry()
        shutil.rmtree(self.data_dir, ignore_errors=True)

    # ── Menu rendering & selection ─────────────────────────────────────

    @patch("builtins.input")
    @patch("getpass.getpass")
    def test_59_picker_valid_selection_calls_prompt_config(self, mock_getpass, mock_input):
        """Selecting a valid provider number invokes prompt_config."""
        mock_getpass.side_effect = ["pw1", "pw1"]
        mock_input.side_effect = [
            "1",            # pick provider 1 (the test provider "AA Test...")
            TEST_SEED,       # recovery seed
            "y",             # overwrite? (ledger might pre-exist)
        ]

        from cli.onboarding import run_onboarding_picker
        result = run_onboarding_picker(
            data_dir=self.data_dir,
            config_manager=self.config_mgr,
        )
        self.assertTrue(self._prompt_called,
                        "prompt_config should be called when user selects a provider")

    @patch("builtins.input")
    @patch("getpass.getpass")
    def test_60_picker_writes_config_before_delegating(self, mock_getpass, mock_input):
        """Config from prompt_config is persisted via config_manager.write()."""
        mock_getpass.side_effect = ["pw1", "pw1"]
        mock_input.side_effect = [
            "1",            # select test provider
            TEST_SEED,       # recovery seed
            "y",
        ]

        from cli.onboarding import run_onboarding_picker
        run_onboarding_picker(
            data_dir=self.data_dir,
            config_manager=self.config_mgr,
        )
        self.assertTrue(len(self.written_configs) > 0,
                        "Config should be written via config_manager.write()")
        written = self.written_configs[0]
        self.assertIn("remote", written)
        self.assertEqual(written["remote"]["transport"], "http")

    @patch("builtins.input")
    def test_61_picker_cancel_returns_false(self, mock_input):
        """Selecting 0 cancels and returns False."""
        mock_input.side_effect = ["0"]

        from cli.onboarding import run_onboarding_picker
        result = run_onboarding_picker(
            data_dir=self.data_dir,
            config_manager=self.config_mgr,
        )
        self.assertFalse(result, "Picker should return False on cancel")
        self.assertFalse(self._prompt_called,
                         "prompt_config should NOT be called on cancel")

    @patch("builtins.input")
    def test_62_picker_invalid_then_valid_selection(self, mock_input):
        """Invalid input loops until valid selection is made, then prompt_config is called."""
        # Simulate: "99" (out of range) → "abc" (non-numeric) → "" (empty) → "1" (valid)
        # After valid selection, prompt_config() runs (no more input needed).
        # run_onboarding follows but mock transport has no data → fails fast.
        mock_input.side_effect = [
            "99",           # out of range — loops
            "abc",          # non-numeric — loops
            "",             # empty — loops
            "1",            # valid → calls prompt_config
            # run_onboarding needs: recovery seed (causes ValueError since
            # mock transport has no blocks → pull_ledger_blocks returns None)
            TEST_SEED,      # recovery seed
            "y",            # overwrite prompt (if reached)
        ]

        from cli.onboarding import run_onboarding_picker
        result = run_onboarding_picker(
            data_dir=self.data_dir,
            config_manager=self.config_mgr,
        )
        # prompt_config should have been called after the 4th input
        self.assertTrue(self._prompt_called,
                        "prompt_config should be called after valid selection")

    @patch("builtins.input")
    def test_63_picker_provider_list_shows_all_registered(self, mock_input):
        """The picker menu lists all registered providers sorted by name."""
        from core.sync.transport_registry import get_registry
        registry = get_registry()
        providers = registry.list_providers()
        # Should have at least 4: Cloudflare R2, Generic HTTP Server, Git Remote,
        # and our test provider AA Test Picker Provider
        self.assertGreaterEqual(len(providers), 4,
                                f"Should have >= 4 providers, got {len(providers)}")

        # Verify list is sorted by name
        names = [p.name for p in providers]
        self.assertEqual(names, sorted(names),
                         "Providers should be sorted alphabetically by name")

        # Cancel to avoid infinite loop
        mock_input.side_effect = ["0"]
        from cli.onboarding import run_onboarding_picker
        run_onboarding_picker(
            data_dir=self.data_dir,
            config_manager=self.config_mgr,
        )

    # ── Edge cases ─────────────────────────────────────────────────────

    @patch("builtins.input")
    @patch("core.sync.transport_registry.get_registry")
    def test_64_picker_empty_registry_returns_false(self, mock_get_registry, mock_input):
        """When no providers are registered, picker returns False without
        prompting for input."""
        from core.sync.transport_registry import TransportRegistry
        # Patch get_registry to return an empty registry (no built-ins)
        mock_get_registry.return_value = TransportRegistry()

        from cli.onboarding import run_onboarding_picker
        result = run_onboarding_picker(
            data_dir=self.data_dir,
            config_manager=self.config_mgr,
        )
        self.assertFalse(result,
                         "Empty registry should cause picker to return False")
        # input() should never be called — we exit before the prompt loop
        mock_input.assert_not_called()

    @patch("builtins.input")
    def test_65_picker_prompt_config_returns_none(self, mock_input):
        """When prompt_config returns (None, None), picker returns False."""
        from core.sync.transport_registry import reset_registry, get_registry, TransportProvider
        reset_registry()
        registry = get_registry()

        # Register a provider whose prompt_config returns None (cancelled)
        def _cancelling_prompt():
            return None, None

        canceller = TransportProvider(
            id_="http-canceller",
            name="Cancelling Provider",
            description="Always cancels",
            prompt_config=_cancelling_prompt,
            transport_factory=lambda c, d: None,
            requires_api_key=False,
        )
        registry.register(canceller)

        mock_input.side_effect = ["1"]
        from cli.onboarding import run_onboarding_picker
        result = run_onboarding_picker(
            data_dir=self.data_dir,
            config_manager=self.config_mgr,
        )
        self.assertFalse(result,
                         "Picker should return False when prompt_config cancels")

    @patch("builtins.input")
    @patch("getpass.getpass")
    def test_66_picker_delegates_to_run_onboarding_via_registry(self, mock_getpass, mock_input):
        """Full picker flow: provider → prompt_config → config write → run_onboarding.

        Verifies that when a real transport is configured via the picker,
        the full onboarding pipeline executes and writes ledger data.
        """
        mock_getpass.side_effect = ["pw1", "pw1"]
        mock_input.side_effect = [
            "1",            # select test provider
            TEST_SEED,       # recovery seed
            "y",             # overwrite? (just in case)
        ]

        # Wire test provider to return our preloaded MockOnboardingTransport
        from core.sync.transport_registry import reset_registry, get_registry, TransportProvider
        reset_registry()
        registry = get_registry()

        transport_ref = [self.transport]

        def _picker_prompt():
            cfg = {
                "remote": {"transport": "http"},
                "http": {"provider": "test", "base_url": "https://test.local"},
            }
            return cfg, transport_ref[0]

        full_provider = TransportProvider(
            id_="http-test-full",
            name="AA Full Test",
            description="Full pipeline test provider",
            prompt_config=_picker_prompt,
            transport_factory=lambda c, d: transport_ref[0],
            requires_api_key=False,
        )
        registry.register(full_provider)

        from cli.onboarding import run_onboarding_picker
        result = run_onboarding_picker(
            data_dir=self.data_dir,
            config_manager=self.config_mgr,
        )
        self.assertTrue(result, "Full picker flow should succeed")
        self.assertTrue(self.ledger_path.exists(),
                        "ledger.json should be written by run_onboarding")
        self.assertTrue(self.identity_path.exists(),
                        "identity.json should be written")

        # Verify ledger content
        ledger_data = json.loads(self.ledger_path.read_text())
        self.assertEqual(len(ledger_data), 3,
                         "Should have 3 ledger blocks")
        self.assertEqual(ledger_data[0]["type"], "genesis")

        # Config was written
        self.assertTrue(len(self.written_configs) > 0,
                        "Config should be written")


class TestE2E_11_RealTransportIntegration(unittest.TestCase):
    """Integration tests verifying full onboarding flows using real transport
    types (GitStagingTransport, HttpStagingTransport) from the registry.

    These tests verify the complete dispatch path from CLI argument parsing
    through registry lookup, prompt_config, transport construction, config
    persistence, and the unified onboarding pipeline.
    """

    def setUp(self):
        self.data_dir = Path(tempfile.mkdtemp(prefix="phpoc_e2e_real_"))
        self.ledger_path = self.data_dir / "ledger.json"
        self.staging_path = self.data_dir / "staging.json"
        self.identity_path = self.data_dir / "identity.json"
        self.index_path = self.data_dir / "index.json"

        from core.sync.transport_registry import reset_registry
        reset_registry()

        # Build test chain
        self.chain = [_make_genesis_block(TEST_MK)]
        b1 = _make_day_block(self.chain[0], index=1, mk=TEST_MK)
        b2 = _make_day_block(b1, index=2, mk=TEST_MK)
        self.chain.extend([b1, b2])

    def tearDown(self):
        import shutil
        from core.sync.transport_registry import reset_registry
        reset_registry()
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def _make_config_mgr(self):
        """Create a mock config manager that tracks writes."""
        cfg = MagicMock()
        cfg.read.return_value = {}
        written = {}
        cfg.write = lambda update: written.update(update)
        cfg.get = lambda key, default=None: written.get(key, default)
        cfg.set = lambda k, v: written.update({k: v})
        return cfg

    # ── Git transport E2E ──────────────────────────────────────────────

    def test_67_git_registry_provider_creates_git_transport(self):
        """Registry's git provider creates a GitStagingTransport."""
        from core.sync.transport_registry import get_registry
        from core.sync.git_transport import GitStagingTransport

        registry = get_registry()
        provider = registry.get("git")
        self.assertIsNotNone(provider, "Git provider should be registered")

        # Simulate prompt_config via mock input (the actual function
        # calls _prompt_git_remote_url which would need subprocess)
        # Instead verify the transport_factory works with valid config
        config = {
            "remote": {
                "transport": "git",
                "git_remote_url": "git@github.com:user/repo.git",
            },
            "_config_dir": str(self.data_dir),
        }
        transport = provider.transport_factory(config, str(self.data_dir))
        self.assertIsInstance(transport, GitStagingTransport,
                              "transport_factory should create GitStagingTransport")

    def test_68_git_create_transport_from_config_round_trip(self):
        """create_transport_from_config returns GitStagingTransport for
        git config, using the registry's factory."""
        from core.sync.transport_registry import create_transport_from_config
        from core.sync.git_transport import GitStagingTransport

        config = {
            "remote": {
                "transport": "git",
                "git_remote_url": "https://github.com/user/repo.git",
            },
            "_config_dir": str(self.data_dir),
        }
        transport = create_transport_from_config(config)
        self.assertIsInstance(transport, GitStagingTransport,
                              "Should create GitStagingTransport for git config")

    # ── HTTP Cloudflare transport E2E ──────────────────────────────────

    def test_69_http_cloudflare_registry_provider_creates_http_transport(self):
        """Registry's http-cloudflare provider creates an HttpStagingTransport."""
        from core.sync.transport_registry import get_registry
        from core.sync.http_transport import HttpStagingTransport

        registry = get_registry()
        provider = registry.get("http-cloudflare")
        self.assertIsNotNone(provider, "http-cloudflare provider should be registered")

        # Verify prompt_config is the cloudflare-specific function
        from core.sync.transport_registry import _prompt_http_cloudflare
        self.assertEqual(provider.prompt_config, _prompt_http_cloudflare,
                         "Should use cloudflare prompt function")

        # Verify transport_factory works with valid config
        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "cloudflare",
                "base_url": "https://phpoc-staging-testing.wacevedo.workers.dev",
                "api_key": "test-key-123",
            },
            "_config_dir": str(self.data_dir),
        }
        transport = provider.transport_factory(config, str(self.data_dir))
        self.assertIsInstance(transport, HttpStagingTransport,
                              "Should create HttpStagingTransport for cloudflare")
        self.assertEqual(transport.base_url,
                         "https://phpoc-staging-testing.wacevedo.workers.dev")

    def test_70_http_cloudflare_create_transport_from_config(self):
        """create_transport_from_config returns HttpStagingTransport for
        http+cloudflare config."""
        from core.sync.transport_registry import create_transport_from_config
        from core.sync.http_transport import HttpStagingTransport

        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "cloudflare",
                "base_url": "https://test.workers.dev",
                "api_key": "sk-key",
            },
            "_config_dir": str(self.data_dir),
        }
        transport = create_transport_from_config(config)
        self.assertIsInstance(transport, HttpStagingTransport,
                              "Should create HttpStagingTransport for cloudflare")
        self.assertEqual(transport.base_url, "https://test.workers.dev")

    # ── HTTP Generic transport E2E ─────────────────────────────────────

    def test_71_http_generic_registry_provider_creates_http_transport(self):
        """Registry's http-generic provider creates an HttpStagingTransport."""
        from core.sync.transport_registry import get_registry
        from core.sync.http_transport import HttpStagingTransport

        registry = get_registry()
        provider = registry.get("http-generic")
        self.assertIsNotNone(provider, "http-generic provider should be registered")

        # Verify prompt_config is the generic-specific function
        from core.sync.transport_registry import _prompt_http_generic
        self.assertEqual(provider.prompt_config, _prompt_http_generic,
                         "Should use generic prompt function")

        # Verify transport_factory works with valid config (including api_key)
        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "generic",
                "base_url": "https://example.com/staging",
                "api_key": "my-api-key",
            },
            "_config_dir": str(self.data_dir),
        }
        transport = provider.transport_factory(config, str(self.data_dir))
        self.assertIsInstance(transport, HttpStagingTransport,
                              "Should create HttpStagingTransport for generic")
        self.assertEqual(transport.base_url, "https://example.com/staging")

    def test_72_http_generic_create_transport_from_config(self):
        """create_transport_from_config returns HttpStagingTransport for
        http+generic config."""
        from core.sync.transport_registry import create_transport_from_config
        from core.sync.http_transport import HttpStagingTransport

        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "generic",
                "base_url": "https://example.com/staging",
            },
            "_config_dir": str(self.data_dir),
        }
        transport = create_transport_from_config(config)
        self.assertIsInstance(transport, HttpStagingTransport,
                              "Should create HttpStagingTransport for generic")
        self.assertEqual(transport.base_url, "https://example.com/staging")

    # ── CLI dispatch integration ───────────────────────────────────────

    def test_73_onboarding_git_cli_dispatch_uses_registry(self):
        """``ph onboarding git`` CLI dispatch looks up the git provider
        from the registry and calls prompt_config."""
        from core.sync.transport_registry import get_registry

        registry = get_registry()
        provider = registry.get("git")
        self.assertIsNotNone(provider, "Git provider should be in registry")
        self.assertEqual(provider.id_, "git")
        self.assertTrue(callable(provider.prompt_config),
                        "prompt_config should be callable")
        self.assertTrue(callable(provider.transport_factory),
                        "transport_factory should be callable")

    def test_74_onboarding_http_cloudflare_cli_dispatch_uses_registry(self):
        """``ph onboarding http cloudflare`` CLI dispatch looks up
        http-cloudflare from the registry."""
        from core.sync.transport_registry import get_registry

        registry = get_registry()
        provider = registry.get("http-cloudflare")
        self.assertIsNotNone(provider, "http-cloudflare provider should be in registry")
        self.assertEqual(provider.id_, "http-cloudflare")
        self.assertTrue(provider.requires_api_key,
                        "cloudflare provider should require API key")

    def test_75_onboarding_http_generic_cli_dispatch_uses_registry(self):
        """``ph onboarding http generic`` CLI dispatch looks up
        http-generic from the registry."""
        from core.sync.transport_registry import get_registry

        registry = get_registry()
        provider = registry.get("http-generic")
        self.assertIsNotNone(provider, "http-generic provider should be in registry")
        self.assertEqual(provider.id_, "http-generic")
        self.assertFalse(provider.requires_api_key,
                         "generic HTTP provider should not require API key")

    def test_76_all_registry_providers_have_complete_metadata(self):
        """Every built-in provider has non-empty id, name, description,
        and callable prompt_config + transport_factory."""
        from core.sync.transport_registry import get_registry

        registry = get_registry()
        providers = registry.list_providers()
        self.assertTrue(len(providers) >= 3,
                        f"Should have at least 3 built-in providers, got {len(providers)}")

        for provider in providers:
            with self.subTest(provider=provider.id_):
                self.assertTrue(provider.id_ and provider.id_.strip(),
                                f"{provider.id_}: id_ must be non-empty")
                self.assertTrue(provider.name and provider.name.strip(),
                                f"{provider.id_}: name must be non-empty")
                self.assertTrue(provider.description and provider.description.strip(),
                                f"{provider.id_}: description must be non-empty")
                self.assertTrue(callable(provider.prompt_config),
                                f"{provider.id_}: prompt_config must be callable")
                self.assertTrue(callable(provider.transport_factory),
                                f"{provider.id_}: transport_factory must be callable")


# ═════════════════════════════════════════════════════════════════════════════
# Run
# ═════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
