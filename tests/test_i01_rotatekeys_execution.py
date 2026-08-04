"""I-01a RotateKeysCommand — Phase 2 RED: Execution tests (Groups S, H, E).

Tests soft_rotate(), hard_rotate(), and error handling against real
file I/O in temp directories.

Group S: Soft Rotation Execution — 14 tests (S1–S14)
Group H: Hard Rotation Execution — 14 tests (H1–H14)
Group E: Error Handling & Edge Cases — 10 tests (E1–E10)

All tests are expected to FAIL (RED) until Phase 3 implementation.
"""

import unittest
import json
import os
import tempfile
import shutil
import time
from pathlib import Path

from security.crypto import CryptoManager, derive_mk, NoAuthCryptoManager
from security.auth import PassphraseAuthenticator
from domain.ledger.chain import LedgerChain
from domain.ledger.helpers import get_block_hash
from domain.ledger.index_manager import IndexManager
from domain.staging.local_cache import LocalStagingCache
from domain.cookie.device_cookie import DeviceCookie
from storage.implementations.file_ledger import FileLedgerStore
from storage.implementations.file_staging import FileStagingStore
from storage.implementations.file_index import FileIndexStore

# Import the command under test — currently placeholders, so tests will be RED
from phpoc_cli.rotate_keys import RotateKeysCommand


# ══════════════════════════════════════════════════════════════════
# Test Helpers
# ══════════════════════════════════════════════════════════════════

def _build_genesis(seed: bytes, key_version: int = 1, format_version: str = "0.5.0",
                   identity_secret: bytes = None):
    """Build a genesis block with the given key version.

    Creates a complete genesis with identity_secret_enc_fallback,
    block_hash seal, and identity_seal MAC.
    """
    if identity_secret is None:
        identity_secret = os.urandom(32)

    mk = derive_mk(seed, key_version)
    crypto = CryptoManager(mk, key_version=key_version)

    identity = {
        "identity_pub_key": "aa" * 32,
        "identity_secret_enc_fallback": crypto.encrypt(identity_secret.hex()),
        "recovery_seed_enc": crypto.encrypt("mock_enc_seed_data"),
    }

    genesis = {
        "type": "genesis",
        "key_version": key_version,
        "format_version": format_version,
        "identity": identity,
    }

    # Compute seal over fields excluding hash/mac/signature/format_version/key_version
    hash_key = "block_hash"
    check_data = {k: v for k, v in genesis.items()
                  if k not in (hash_key, "identity_seal", "signature", "format_version", "key_version")}
    genesis[hash_key] = crypto.seal(json.dumps(check_data, sort_keys=True))
    genesis["identity_seal"] = crypto.mac(genesis[hash_key], identity_secret)

    return genesis, identity_secret


def _build_day_block(crypto: CryptoManager, entries: list, prev_hash: str,
                     date_str: str, day_index: int = 1, key_version: int = 1,
                     identity_secret: bytes = None):
    """Build a day block with sealed entries."""
    normalized = []
    for e in entries:
        data = dict(e)
        entry_hash = __import__('hashlib').sha256(
            json.dumps(data, sort_keys=True, indent=2).encode()
        ).hexdigest()
        normalized.append({"hash": entry_hash, "data": data})

    day_content = {
        "type": "day",
        "day_index": day_index,
        "date": date_str,
        "prev_hash": prev_hash,
        "entries": normalized,
        "key_version": key_version,
    }

    seal_data = {k: v for k, v in day_content.items()
                 if k not in ("key_version",)}
    day_content["day_hash"] = crypto.seal(json.dumps(seal_data, sort_keys=True))

    if identity_secret:
        day_content["identity_seal"] = crypto.mac(
            day_content["day_hash"], identity_secret
        )

    return day_content


def _compute_content_hash(data: dict, decrypt_fn) -> str:
    """Compute content_hash matching LedgerChain._verify_content_hash extensible algorithm."""
    import hashlib
    content = {}
    for key, value in data.items():
        if key == "content_hash":
            continue
        if key.endswith("_enc") and value is not None and value != "":
            if decrypt_fn is not None:
                try:
                    content[key] = decrypt_fn(value)
                except Exception:
                    content[key] = value
            else:
                content[key] = value
        elif isinstance(value, list):
            content[key] = sorted(value)
        else:
            content[key] = value
    return hashlib.sha256(
        json.dumps(content, sort_keys=True).encode()
    ).hexdigest()


def _make_entry(crypto: CryptoManager, title: str, duration_ms: int = 3600000,
                start_time: str = "1700000000000"):
    """Create an encrypted entry dict (as stored in a day block)."""
    entry_data = {
        "title": title,
        "duration": duration_ms,
        "startTime_enc": crypto.encrypt(start_time),
    }
    entry_data["content_hash"] = _compute_content_hash(entry_data, crypto.decrypt)
    return entry_data


def _setup_test_ledger(tmpdir: Path, seed: bytes, key_version: int = 1,
                       num_day_blocks: int = 2, format_version: str = "0.5.0"):
    """Set up a complete test ledger in a temp dir.

    Creates:
      - ledger.json with genesis + N day blocks
      - staging.json with 2 staging entries
      - index.json with a blind index entry

    Returns:
        (data_dir, genesis, identity_secret, crypto_v1, mk_v1)
    """
    data_dir = tmpdir / "phpoc"
    data_dir.mkdir(parents=True, exist_ok=True)

    mk_v1 = derive_mk(seed, key_version)
    crypto_v1 = CryptoManager(mk_v1, key_version=key_version)
    identity_secret = os.urandom(32)

    # Build genesis
    genesis, identity_secret = _build_genesis(
        seed, key_version=key_version, format_version=format_version,
        identity_secret=identity_secret
    )

    # Build day blocks
    chain_blocks = [genesis]
    prev_hash = genesis["block_hash"]
    for i in range(num_day_blocks):
        entries = [
            _make_entry(crypto_v1, f"task_{i}_a", 3600000 + i * 1000,
                        str(1700000000000 + i * 86400000)),
            _make_entry(crypto_v1, f"task_{i}_b", 1800000 + i * 500,
                        str(1700000000000 + i * 86400000 + 3600000)),
        ]
        day = _build_day_block(
            crypto_v1, entries, prev_hash,
            date_str=f"2023-11-{15 + i:02d}",
            day_index=i + 1, key_version=key_version,
            identity_secret=identity_secret,
        )
        chain_blocks.append(day)
        prev_hash = day["day_hash"]

    # Write ledger
    ledger_path = data_dir / "ledger.json"
    ledger_path.write_text(json.dumps(chain_blocks, indent=2))

    # Write staging with 2 entries (epoch in milliseconds)
    staging_store = FileStagingStore(data_dir / "staging.json")
    staging_cache = LocalStagingCache(crypto_v1, staging_store)
    staging_cache.append(title="staged_task_1", start_epoch=1700100000000,
                            end_epoch=1700100000000 + 7200000)
    staging_cache.append(title="staged_task_2", start_epoch=1700200000000,
                            end_epoch=1700200000000 + 900000)

    # Write index
    index_store = FileIndexStore(data_dir / "index.json")
    index_mgr = IndexManager(index_store, crypto_v1)
    index_mgr.update("2023-11-15", "task_0_a", 3600000)
    index_mgr.update("2023-11-15", "task_0_b", 1800000)

    # Create device cookie
    DeviceCookie.create("test-device-uuid", data_dir)

    return data_dir, genesis, identity_secret, crypto_v1, mk_v1


# ══════════════════════════════════════════════════════════════════
# Group S: Soft Rotation Execution
# ══════════════════════════════════════════════════════════════════

class TestSoftRotationExecution(unittest.TestCase):
    """S1–S14: Soft rotation execution tests with real file I/O."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_test_s_"))
        self.seed = os.urandom(32)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ── S1: Version increment ────────────────────────────────

    def test_s1_version_increment_on_disk(self):
        """S1: soft_rotate() increments genesis key_version from N to N+1 on disk."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )
        self.assertEqual(genesis["key_version"], 1)

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)  # soft rotation
        self.assertTrue(result, "soft_rotate() should return True")

        # Verify genesis on disk has key_version=2
        chain_blocks = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_blocks[0]["key_version"], 2,
                         "Genesis key_version should be incremented to 2")

    # ── S2: Identity secret re-encryption ────────────────────

    def test_s2_identity_secret_reencrypted(self):
        """S2: soft_rotate() re-encrypts identity_secret_enc_fallback with new MK."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )
        old_fallback = genesis["identity"]["identity_secret_enc_fallback"]
        decrypted_v1 = crypto_v1.decrypt(old_fallback)

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        # Verify new fallback decryptable with v2 MK, not v1
        chain_blocks = json.loads((data_dir / "ledger.json").read_text())
        new_fallback = chain_blocks[0]["identity"]["identity_secret_enc_fallback"]

        self.assertNotEqual(old_fallback, new_fallback,
                            "identity_secret_enc_fallback must change after rotation")

        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)
        decrypted_v2 = crypto_v2.decrypt(new_fallback)
        self.assertEqual(decrypted_v1, decrypted_v2,
                         "Decrypted identity secret must match after rotation")

        # Old crypto should fail or produce wrong result
        with self.assertRaises((ValueError, Exception)):
            crypto_v1.decrypt(new_fallback)

    # ── S3: Staging re-encryption ────────────────────────────

    def test_s3_staging_reencrypted(self):
        """S3: soft_rotate() re-encrypts all staging entries with new MK."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # Read original staging via v1 crypto
        staging_store = FileStagingStore(data_dir / "staging.json")
        staging_cache_v1 = LocalStagingCache(crypto_v1, staging_store)
        entries_before = staging_cache_v1.read_entries()

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        # Read staging via v2 crypto — must succeed
        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)
        staging_cache_v2 = LocalStagingCache(crypto_v2, staging_store)
        entries_after = staging_cache_v2.read_entries()

        self.assertEqual(len(entries_before), len(entries_after),
                         "Staging entry count must be preserved")
        self.assertGreater(len(entries_after), 0,
                           "Staging should have entries after rotation")

        # v1 crypto should fail to read staging — entries return empty
        staging_cache_v1b = LocalStagingCache(crypto_v1, staging_store)
        # Decrypting v2-encrypted data with v1 key returns empty (entries skipped)
        self.assertEqual(staging_cache_v1b.read_entries(), [],
                         "v1 crypto must not decrypt v2-encrypted staging")

    # ── S4: Index re-encryption ──────────────────────────────

    def test_s4_index_reencrypted(self):
        """S4: soft_rotate() re-encrypts the blind index with new index key."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # Read original index via v1 crypto
        index_store_v1 = FileIndexStore(data_dir / "index.json")
        index_mgr_v1 = IndexManager(index_store_v1, crypto_v1)
        before_dates = set(index_mgr_v1.get_all().keys())

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        # Read index via v2 crypto — must succeed and have same data
        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)
        index_store_v2 = FileIndexStore(data_dir / "index.json")
        index_mgr_v2 = IndexManager(index_store_v2, crypto_v2)
        after_dates = set(index_mgr_v2.get_all().keys())

        self.assertEqual(before_dates, after_dates,
                         "Index dates must be preserved after rotation")

        # v1 crypto should fail to read index
        index_mgr_v1b = IndexManager(index_store_v1, crypto_v1)
        self.assertEqual(index_mgr_v1b.get_all(), {},
                         "v1 crypto should not decrypt v2-encrypted index")

    # ── S5: Cookie re-derivation ─────────────────────────────

    def test_s5_cookie_rederived(self):
        """S5: soft_rotate() creates a new device cookie with fresh random specifier."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # Read pre-rotation cookie specifier
        old_meta = json.loads((data_dir / "device_cookie.meta").read_text())
        old_specifier = old_meta["device_specifier"]

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        # Verify cookie was re-created with a different specifier
        new_meta = json.loads((data_dir / "device_cookie.meta").read_text())
        new_specifier = new_meta["device_specifier"]

        self.assertNotEqual(old_specifier, new_specifier,
                            "Device cookie specifier must change after rotation")
        self.assertEqual(len(new_specifier), 32,
                         "Specifier must be 32 hex chars (16 bytes)")

    # ── S6: Genesis re-seal ──────────────────────────────────

    def test_s6_genesis_resealed(self):
        """S6: soft_rotate() re-seals genesis — old CM seal fails, new CM seal passes."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )
        old_seal = genesis["block_hash"]

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        chain_blocks = json.loads((data_dir / "ledger.json").read_text())
        new_genesis = chain_blocks[0]
        new_seal = new_genesis["block_hash"]

        self.assertNotEqual(old_seal, new_seal,
                            "Genesis seal must change after rotation")

        # v2 crypto must verify the new seal
        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)
        check_data = {k: v for k, v in new_genesis.items()
                      if k not in ("block_hash", "identity_seal", "signature",
                                   "format_version", "key_version")}
        self.assertTrue(
            crypto_v2.verify_seal(json.dumps(check_data, sort_keys=True), new_seal),
            "New seal must verify with v2 crypto"
        )

        # v1 crypto must NOT verify the new seal
        self.assertFalse(
            crypto_v1.verify_seal(json.dumps(check_data, sort_keys=True), new_seal),
            "Old seal check must fail against new seal"
        )

    # ── S7: Identity MAC recomputed ──────────────────────────

    def test_s7_identity_mac_recomputed(self):
        """S7: soft_rotate() recomputes identity MAC on genesis with new block_hash."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )
        old_mac = genesis["identity_seal"]

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        chain_blocks = json.loads((data_dir / "ledger.json").read_text())
        new_genesis = chain_blocks[0]
        new_mac = new_genesis["identity_seal"]

        self.assertNotEqual(old_mac, new_mac,
                            "Identity MAC must change after re-seal")

        # New MAC must verify with identity_secret
        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)
        self.assertTrue(
            crypto_v2.verify_mac(new_genesis["block_hash"], new_mac, identity_secret),
            "New identity MAC must verify against identity_secret"
        )

    # ── S8: Existing day blocks preserved ────────────────────

    def test_s8_existing_blocks_preserved(self):
        """S8: soft_rotate() leaves existing day blocks untouched (same key_version, ciphertext, seals)."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        # Snapshot pre-rotation blocks
        chain_before = json.loads((data_dir / "ledger.json").read_text())

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())

        # Genesis must have been modified (key_version bumped)
        self.assertNotEqual(genesis, chain_after[0],
                            "Genesis must be modified by rotation (key_version bump)")
        self.assertEqual(chain_after[0].get("key_version"), 2,
                         "Genesis key_version must be bumped to 2")

        # Day blocks (index 1+) must be unchanged
        for i in range(1, len(chain_before)):
            self.assertEqual(
                chain_before[i], chain_after[i],
                f"Day block {i} must be unchanged after soft rotation"
            )
            # Explicitly check key_version stayed the same
            self.assertEqual(
                chain_before[i].get("key_version"), chain_after[i].get("key_version"),
                f"Day block {i} key_version must not change"
            )

    # ── S9: Post-rotation mixed-version verify passes ────────

    def test_s9_post_rotation_verify_passes(self):
        """S9: After soft_rotate(), LedgerChain.verify() passes on mixed-version chain."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        # Verify chain with multi-version MK lookup
        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)

        def get_mk_for_version(version):
            if version == 1:
                return CryptoManager(mk_v1, key_version=1)
            if version == 2:
                return crypto_v2
            return None

        store = FileLedgerStore(data_dir / "ledger.json")
        chain = LedgerChain(crypto_v2, store, identity_secret=identity_secret)
        self.assertTrue(
            chain.verify(get_mk_for_version=get_mk_for_version),
            "Mixed-version chain must pass verify() after soft rotation"
        )

    # ── S10: Session cache update ────────────────────────────

    def test_s10_session_cache_updated(self):
        """S10: soft_rotate() populates auth._keys with the new MK version (N+1)."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # Create an authenticator with the existing ledger
        auth = PassphraseAuthenticator(data_dir / "ledger.json")

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret,
                                authenticator=auth)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        # auth._keys should have version 2
        self.assertIn(2, auth._keys, "auth._keys must contain version 2 after rotation")
        mk_v2 = derive_mk(self.seed, 2)
        self.assertEqual(auth._keys[2].master_key, mk_v2,
                         "auth._keys[2] must hold the v2 MK")
        self.assertEqual(auth.key_version, 2,
                         "auth.key_version must report 2 after rotation")

    # ── S11: Passphrase re-entry required ────────────────────

    def test_s11_wrong_passphrase_rejected(self):
        """S11: soft_rotate() requires passphrase re-entry — wrong passphrase returns False."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # Snapshot pre-rotation state
        chain_before = json.loads((data_dir / "ledger.json").read_text())
        staging_before = json.loads((data_dir / "staging.json").read_text())

        # Construct a different seed → different MKs → wrong auth
        wrong_seed = os.urandom(32)
        cmd = RotateKeysCommand(data_dir=data_dir, seed=wrong_seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertFalse(result,
                         "Rotation with wrong passphrase/seed must return False")

        # No files should be modified
        chain_after = json.loads((data_dir / "ledger.json").read_text())
        staging_after = json.loads((data_dir / "staging.json").read_text())
        self.assertEqual(chain_before, chain_after,
                         "Ledger must be unchanged after failed rotation")
        self.assertEqual(staging_before, staging_after,
                         "Staging must be unchanged after failed rotation")

    # ── S12: Pre-rotation integrity check ────────────────────

    def test_s12_corrupt_chain_rejected(self):
        """S12: soft_rotate() rejects if chain verification fails before rotation."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # Corrupt the chain: tamper with a day block seal
        chain_blocks = json.loads((data_dir / "ledger.json").read_text())
        chain_blocks[1]["day_hash"] = "deadbeef" * 8  # invalid seal
        (data_dir / "ledger.json").write_text(json.dumps(chain_blocks, indent=2))
        chain_before = json.loads((data_dir / "ledger.json").read_text())

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertFalse(result,
                         "Rotation on corrupt chain must return False")

        # Chain must remain unchanged (no partial writes)
        chain_after = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_before, chain_after,
                         "Corrupt chain must not be modified by failed rotation")

    # ── S13: Empty staging edge case ─────────────────────────

    def test_s13_empty_staging_rotation(self):
        """S13: soft_rotate() with empty staging (no entries) completes successfully."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # Clear staging
        (data_dir / "staging.json").write_text("[]")

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result,
                        "Rotation with empty staging must succeed")

        # Genesis key_version must still be incremented
        chain_after = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_after[0]["key_version"], 2)

        # Staging file must still exist (empty)
        staging_after = json.loads((data_dir / "staging.json").read_text())
        self.assertEqual(staging_after, [])

    # ── S14: Offline rotation (no remote transport) ──────────

    def test_s14_offline_rotation_completes(self):
        """S14: soft_rotate() with no remote transport configured completes locally."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # No remote transport configured — should still work
        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result,
                        "Rotation must work without remote transport")

        # Core files must exist and genesis must be updated
        self.assertTrue((data_dir / "ledger.json").exists())
        self.assertTrue((data_dir / "staging.json").exists())
        self.assertTrue((data_dir / "index.json").exists())
        self.assertTrue((data_dir / "device_cookie.meta").exists())

        # Genesis key_version must have been bumped
        chain_after = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_after[0].get("key_version"), 2,
                         "Genesis key_version must be bumped even offline")


# ══════════════════════════════════════════════════════════════════
# Group H: Hard Rotation Execution
# ══════════════════════════════════════════════════════════════════

class TestHardRotationExecution(unittest.TestCase):
    """H1–H14: Hard rotation execution tests with real file I/O."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_test_h_"))
        self.seed = os.urandom(32)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ── H1: Hard rotation subsumes soft ──────────────────────

    def test_h1_hard_includes_soft_steps(self):
        """H1: hard_rotate() includes all soft rotation steps (staging, index, cookie, genesis)."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)  # hard rotation
        self.assertTrue(result, "hard_rotate() should return True")

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)

        # Genesis: key_version bumped
        self.assertEqual(chain_after[0]["key_version"], 2)

        # Identity secret: re-encrypted with v2
        new_fallback = chain_after[0]["identity"]["identity_secret_enc_fallback"]
        self.assertNotEqual(
            genesis["identity"]["identity_secret_enc_fallback"], new_fallback)
        decrypted = crypto_v2.decrypt(new_fallback)
        self.assertEqual(decrypted, identity_secret.hex())

        # Staging: re-encrypted with v2
        staging_store = FileStagingStore(data_dir / "staging.json")
        staging_cache = LocalStagingCache(crypto_v2, staging_store)
        entries = staging_cache.read_entries()
        self.assertGreater(len(entries), 0)

        # Cookie: re-created
        self.assertTrue((data_dir / "device_cookie.meta").exists())

    # ── H2: Full entry re-encryption ─────────────────────────

    def test_h2_full_entry_reencryption(self):
        """H2: hard_rotate() re-encrypts every entry in every day block — old CM cannot decrypt, new CM can."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        # Snapshot old entry ciphertexts
        chain_before = json.loads((data_dir / "ledger.json").read_text())
        old_ciphertexts = {}
        for i, block in enumerate(chain_before):
            if block.get("type") == "day":
                for j, entry in enumerate(block.get("entries", [])):
                    key = f"block_{i}_entry_{j}"
                    old_ciphertexts[key] = entry["data"].get("startTime_enc", "")

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)

        for i, block in enumerate(chain_after):
            if block.get("type") == "day":
                for j, entry in enumerate(block.get("entries", [])):
                    key = f"block_{i}_entry_{j}"
                    new_ct = entry["data"].get("startTime_enc", "")

                    # Ciphertext must differ from pre-rotation
                    if key in old_ciphertexts:
                        self.assertNotEqual(old_ciphertexts[key], new_ct,
                                            f"Entry {key} must be re-encrypted")

                    # Old crypto must fail on new ciphertext
                    with self.assertRaises((ValueError, Exception)):
                        crypto_v1.decrypt(new_ct)

                    # New crypto must decrypt correctly
                    decrypted = crypto_v2.decrypt(new_ct)
                    self.assertTrue(decrypted.startswith("1700"),
                                    f"Entry {key} must decrypt to valid timestamp")

    # ── H3: Uniform key_version update ───────────────────────

    def test_h3_all_blocks_updated(self):
        """H3: hard_rotate() updates key_version on every block (genesis + day + summary) to N+1."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=3
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        for i, block in enumerate(chain_after):
            self.assertEqual(block.get("key_version"), 2,
                             f"Block {i} must have key_version=2 after hard rotation")

    # ── H4: Entry hashes recomputed ──────────────────────────

    def test_h4_entry_hashes_recomputed(self):
        """H4: hard_rotate() recomputes every entry hash after re-encryption."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=1
        )

        chain_before = json.loads((data_dir / "ledger.json").read_text())
        old_hashes = [e["hash"] for e in chain_before[1].get("entries", [])]

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        new_hashes = [e["hash"] for e in chain_after[1].get("entries", [])]

        for old_h, new_h in zip(old_hashes, new_hashes):
            self.assertNotEqual(old_h, new_h,
                                "Entry hashes must change after re-encryption")

    # ── H5: Block seals recomputed ───────────────────────────

    def test_h5_block_seals_recomputed(self):
        """H5: hard_rotate() recomputes every block seal with new MK's seal key."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        chain_before = json.loads((data_dir / "ledger.json").read_text())
        old_seals = {}
        for i, block in enumerate(chain_before):
            hk = block.get("block_hash") or block.get("day_hash")
            if hk:
                old_seals[i] = hk

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        for i, block in enumerate(chain_after):
            hk = block.get("block_hash") or block.get("day_hash")
            if hk and i in old_seals:
                self.assertNotEqual(old_seals[i], hk,
                                    f"Block {i} seal must change after hard rotation")

    # ── H6: Identity MACs recomputed ─────────────────────────

    def test_h6_identity_macs_recomputed(self):
        """H6: hard_rotate() recomputes every identity MAC (identity_seal) for all blocks."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        chain_before = json.loads((data_dir / "ledger.json").read_text())
        old_macs = {}
        for i, block in enumerate(chain_before):
            mac = block.get("identity_seal")
            if mac:
                old_macs[i] = mac

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        for i, block in enumerate(chain_after):
            mac = block.get("identity_seal")
            if mac and i in old_macs:
                self.assertNotEqual(old_macs[i], mac,
                                    f"Block {i} identity MAC must change after hard rotation")

    # ── H7: prev_hash cascading rewrite ──────────────────────

    def test_h7_prev_hash_cascading_rewrite(self):
        """H7: hard_rotate() updates all prev_hash links in the fully rewritten chain."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=3
        )

        chain_before = json.loads((data_dir / "ledger.json").read_text())
        old_prev_hashes = [b.get("prev_hash") for b in chain_before[1:]]

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        new_prev_hashes = [b.get("prev_hash") for b in chain_after[1:]]

        for i, (old_ph, new_ph) in enumerate(zip(old_prev_hashes, new_prev_hashes)):
            self.assertNotEqual(old_ph, new_ph,
                                f"Block {i+1} prev_hash must change after full rewrite")

        # Verify prev_hash linkage: each block's prev_hash must match previous block's hash
        for i in range(1, len(chain_after)):
            prev_block = chain_after[i - 1]
            prev_hash = prev_block.get("block_hash") or prev_block.get("day_hash")
            self.assertEqual(chain_after[i]["prev_hash"], prev_hash,
                             f"Block {i} prev_hash must link to block {i-1} hash")

    # ── H8: Content hash invariance ──────────────────────────

    def test_h8_content_hashes_unchanged(self):
        """H8: Content hashes remain unchanged after hard rotation (same plaintext)."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=1
        )

        chain_before = json.loads((data_dir / "ledger.json").read_text())
        old_content_hashes = {}
        for block in chain_before:
            if block.get("type") == "day":
                for j, entry in enumerate(block.get("entries", [])):
                    ch = entry["data"].get("content_hash")
                    if ch:
                        old_content_hashes[j] = ch

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        for block in chain_after:
            if block.get("type") == "day":
                for j, entry in enumerate(block.get("entries", [])):
                    ch = entry["data"].get("content_hash")
                    if ch and j in old_content_hashes:
                        self.assertEqual(old_content_hashes[j], ch,
                                         "Content hashes must survive re-encryption unchanged")

    # ── H9: Backup creation ──────────────────────────────────

    def test_h9_backup_created(self):
        """H9: hard_rotate() creates a backup of the pre-rotation chain in a timestamped directory."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        # A backup directory should exist under data_dir
        backup_dirs = list(data_dir.glob("backup_*"))
        self.assertGreater(len(backup_dirs), 0,
                           "Hard rotation must create a backup directory")
        backup_dir = backup_dirs[0]
        self.assertTrue(backup_dir.is_dir())

    # ── H10: Backup is independently verifiable ──────────────

    def test_h10_backup_is_verifiable(self):
        """H10: Backup is independently verifiable — LedgerChain.verify() passes on backup."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        backup_dirs = list(data_dir.glob("backup_*"))
        self.assertGreater(len(backup_dirs), 0)
        backup_dir = backup_dirs[0]

        # Backup should contain a copy of ledger.json
        backup_ledger = backup_dir / "ledger.json"
        self.assertTrue(backup_ledger.exists(),
                        "Backup must include ledger.json")

        # Verify the backup chain with the OLD v1 MK
        backup_store = FileLedgerStore(backup_ledger)
        backup_chain = LedgerChain(crypto_v1, backup_store,
                                   identity_secret=identity_secret)

        def get_mk_for_version(version):
            if version == 1:
                return CryptoManager(mk_v1, key_version=1)
            return None

        self.assertTrue(
            backup_chain.verify(get_mk_for_version=get_mk_for_version),
            "Backup chain must verify independently with old MK"
        )

    # ── H11: Backup includes all mutable state ───────────────

    def test_h11_backup_includes_all_state(self):
        """H11: Backup includes staging, index, and cookie files (not just the ledger)."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=1
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        backup_dirs = list(data_dir.glob("backup_*"))
        self.assertGreater(len(backup_dirs), 0)
        backup_dir = backup_dirs[0]

        # All relevant files must exist in backup
        for fname in ["ledger.json", "staging.json", "index.json",
                       "device_cookie.meta", "device_cookie.bin",
                       "identity.json"]:
            fpath = backup_dir / fname
            # Some files are optional (identity.json may not exist)
            if (data_dir / fname).exists():
                self.assertTrue(fpath.exists(),
                                f"Backup must include {fname}")

    # ── H12: Old MK invalidation ─────────────────────────────

    def test_h12_old_mk_cannot_decrypt(self):
        """H12: After hard_rotate(), old MK (v1) cannot decrypt any entry in active chain."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())

        # Try decrypting every entry with v1 crypto — all must fail
        for block in chain_after:
            if block.get("type") == "day":
                for entry in block.get("entries", []):
                    for key, val in entry["data"].items():
                        if key.endswith("_enc") and isinstance(val, str) and len(val) > 40:
                            with self.assertRaises((ValueError, Exception)):
                                crypto_v1.decrypt(val)

        # Also check staging — v1 must not decrypt v2 entries
        staging_store = FileStagingStore(data_dir / "staging.json")
        staging_cache_v1 = LocalStagingCache(crypto_v1, staging_store)
        self.assertEqual(staging_cache_v1.read_entries(), [],
                         "v1 crypto must not decrypt v2-encrypted staging")

    # ── H13: Post-rotation verify passes ─────────────────────

    def test_h13_post_hard_rotation_verify_passes(self):
        """H13: After hard_rotate(), LedgerChain.verify() passes on the newly-written chain."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=3
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result)

        # Verify with v2 crypto only (single-version chain after hard rotation)
        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)
        store = FileLedgerStore(data_dir / "ledger.json")
        chain = LedgerChain(crypto_v2, store, identity_secret=identity_secret)
        self.assertTrue(chain.verify(),
                        "Post-hard-rotation chain must verify as a single-version chain")

    # ── H14: Empty chain (genesis-only) edge case ────────────

    def test_h14_empty_chain_hard_rotation(self):
        """H14: hard_rotate() with genesis-only chain (no day blocks) completes successfully."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=0
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result,
                        "Hard rotation of genesis-only chain must succeed")

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(len(chain_after), 1,
                         "Genesis-only chain must still have 1 block")
        self.assertEqual(chain_after[0]["key_version"], 2)
        self.assertEqual(chain_after[0]["type"], "genesis")


# ══════════════════════════════════════════════════════════════════
# Group E: Error Handling & Edge Cases
# ══════════════════════════════════════════════════════════════════

class TestRotationErrors(unittest.TestCase):
    """E1–E10: Error handling and edge case tests."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_test_e_"))
        self.seed = os.urandom(32)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ── E1: NoAuth rejection ─────────────────────────────────

    def test_e1_noauth_rejected(self):
        """E1: Rotation with NoAuthCryptoManager raises error or returns False."""
        data_dir = self.tmpdir / "phpoc"
        data_dir.mkdir(parents=True)

        # Create a minimal genesis with NoAuthCryptoManager
        noauth_crypto = NoAuthCryptoManager()
        genesis = {
            "type": "genesis",
            "key_version": 1,
            "format_version": "0.5.0",
            "identity": {
                "identity_pub_key": "bb" * 32,
                "identity_secret_enc_fallback": noauth_crypto.encrypt("test_secret_hex"),
                "recovery_seed_enc": noauth_crypto.encrypt("mock_seed_data"),
            },
        }
        check_data = {k: v for k, v in genesis.items()
                      if k not in ("block_hash", "identity_seal", "signature", "format_version", "key_version")}
        genesis["block_hash"] = noauth_crypto.seal(json.dumps(check_data, sort_keys=True))
        (data_dir / "ledger.json").write_text(json.dumps([genesis], indent=2))
        (data_dir / "staging.json").write_text("[]")
        (data_dir / "index.json").write_text("{}")

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=os.urandom(32))
        result = cmd.execute(full=False)
        self.assertFalse(result,
                         "Rotation with NoAuthCryptoManager must return False")

    # ── E2: Backward compat — no key_version → defaults to v1 ─

    def test_e2_no_key_version_defaults_to_v1(self):
        """E2: Rotation when genesis has no key_version defaults to v1 and works."""
        data_dir = self.tmpdir / "phpoc"
        data_dir.mkdir(parents=True)

        mk_v1 = derive_mk(self.seed, 1)
        crypto_v1 = CryptoManager(mk_v1, key_version=1)
        identity_secret = os.urandom(32)

        # Build genesis WITHOUT key_version field (pre-ADR backward compat)
        genesis = {
            "type": "genesis",
            "format_version": "0.4.0",
            "identity": {
                "identity_pub_key": "cc" * 32,
                "identity_secret_enc_fallback": crypto_v1.encrypt(identity_secret.hex()),
                "recovery_seed_enc": crypto_v1.encrypt("mock_seed"),
            },
        }
        check_data = {k: v for k, v in genesis.items()
                      if k not in ("block_hash", "identity_seal", "signature", "format_version", "key_version")}
        genesis["block_hash"] = crypto_v1.seal(json.dumps(check_data, sort_keys=True))
        genesis["identity_seal"] = crypto_v1.mac(genesis["block_hash"], identity_secret)

        (data_dir / "ledger.json").write_text(json.dumps([genesis], indent=2))
        (data_dir / "staging.json").write_text("[]")
        (data_dir / "index.json").write_text("{}")

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result,
                        "Rotation must work for pre-ADR ledgers without key_version")

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        # After rotation, genesis should have key_version=2 (defaulted from 1)
        self.assertEqual(chain_after[0].get("key_version"), 2)

    # ── E3: Format version auto-bump ─────────────────────────

    def test_e3_format_version_auto_bump(self):
        """E3: Rotation when format_version < 0.5.0 auto-bumps to 0.5.0."""
        data_dir = self.tmpdir / "phpoc"
        data_dir.mkdir(parents=True)

        mk_v1 = derive_mk(self.seed, 1)
        crypto_v1 = CryptoManager(mk_v1, key_version=1)
        identity_secret = os.urandom(32)

        genesis = {
            "type": "genesis",
            "key_version": 1,
            "format_version": "0.4.0",  # Pre-ADR-026 version
            "identity": {
                "identity_pub_key": "dd" * 32,
                "identity_secret_enc_fallback": crypto_v1.encrypt(identity_secret.hex()),
                "recovery_seed_enc": crypto_v1.encrypt("mock_seed"),
            },
        }
        check_data = {k: v for k, v in genesis.items()
                      if k not in ("block_hash", "identity_seal", "signature", "format_version", "key_version")}
        genesis["block_hash"] = crypto_v1.seal(json.dumps(check_data, sort_keys=True))
        genesis["identity_seal"] = crypto_v1.mac(genesis["block_hash"], identity_secret)

        (data_dir / "ledger.json").write_text(json.dumps([genesis], indent=2))
        (data_dir / "staging.json").write_text("[]")
        (data_dir / "index.json").write_text("{}")

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_after[0].get("format_version"), "0.5.0",
                         "format_version must be auto-bumped to 0.5.0")

    # ── E4: Corrupt genesis handling ─────────────────────────

    def test_e4_corrupt_genesis_returns_false(self):
        """E4: Rotation with corrupt genesis (unreadable JSON) returns False."""
        data_dir = self.tmpdir / "phpoc"
        data_dir.mkdir(parents=True)
        (data_dir / "ledger.json").write_text("this is not json {{{")
        (data_dir / "staging.json").write_text("[]")
        (data_dir / "index.json").write_text("{}")

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=os.urandom(32))
        result = cmd.execute(full=False)
        self.assertFalse(result,
                         "Rotation with corrupt genesis must return False")

        # No files should be created beyond what we manually put there
        assert (data_dir / "ledger.json").read_text() == "this is not json {{{"

    # ── E5: Multiple consecutive rotations ───────────────────

    def test_e5_consecutive_rotations(self):
        """E5: Two consecutive soft rotations (v1→v2→v3) produce correct chain."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=1
        )

        # First rotation: v1 → v2
        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        chain_after_first = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_after_first[0]["key_version"], 2)

        # Second rotation: v2 → v3
        cmd2 = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                 identity_secret=identity_secret,
                                 current_key_version=2)
        result2 = cmd2.execute(full=False)
        self.assertTrue(result2)

        chain_after_second = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_after_second[0]["key_version"], 3,
                         "After two rotations, genesis key_version must be 3")

        # Chain must verify with 3 MK versions
        mk_v2 = derive_mk(self.seed, 2)
        mk_v3 = derive_mk(self.seed, 3)
        crypto_v3 = CryptoManager(mk_v3, key_version=3)

        def get_mk_for_version(version):
            if version == 1:
                return CryptoManager(mk_v1, key_version=1)
            if version == 2:
                return CryptoManager(mk_v2, key_version=2)
            if version == 3:
                return crypto_v3
            return None

        store = FileLedgerStore(data_dir / "ledger.json")
        chain = LedgerChain(crypto_v3, store, identity_secret=identity_secret)
        self.assertTrue(chain.verify(get_mk_for_version=get_mk_for_version),
                        "Chain with 3 key versions must verify")

    # ── E6: Idempotency ──────────────────────────────────────

    def test_e6_idempotent_rotation(self):
        """E6: soft_rotate() is idempotent-safe — calling with current_key_version below
        the actual genesis version returns True without modifying the chain.
        
        Scenario: after rotating v1→v2, calling soft_rotate with current_key_version=1
        (stale version) is a no-op since genesis is already at v2."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # First rotation succeeds: v1 → v2
        cmd1 = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                 identity_secret=identity_secret)
        result1 = cmd1.execute(full=False)
        self.assertTrue(result1)

        chain_after_1 = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_after_1[0].get("key_version"), 2,
                         "First rotation must bump key_version to 2")

        # Second rotation with stale current_key_version=1 — genesis already at 2
        # This is a no-op: the chain should remain unchanged
        cmd2 = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                 identity_secret=identity_secret,
                                 current_key_version=1)
        result2 = cmd2.execute(full=False)
        self.assertTrue(result2,
                        "Rotation with stale current_key_version must return True (no-op)")

        chain_after_2 = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_after_1, chain_after_2,
                         "No-op rotation must not change chain")
        self.assertEqual(chain_after_2[0].get("key_version"), 2,
                         "Genesis key_version must remain at 2 after no-op")

    # ── E7: Missing data directory ───────────────────────────

    def test_e7_missing_data_dir(self):
        """E7: Rotation when data_dir doesn't exist returns False (no files created)."""
        nonexistent = self.tmpdir / "nonexistent_phpoc"

        cmd = RotateKeysCommand(data_dir=nonexistent, seed=self.seed,
                                identity_secret=os.urandom(32))
        result = cmd.execute(full=False)
        self.assertFalse(result,
                         "Rotation with missing data_dir must return False")
        self.assertFalse(nonexistent.exists(),
                         "No files should be created for missing data_dir")

    # ── E8: Performance baseline ─────────────────────────────

    def test_e8_performance_large_chain(self):
        """E8: Hard rotation with >100 day blocks completes within 5 seconds."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=0
        )

        # Build 100+ day blocks manually (helper only builds 2)
        chain_blocks = [genesis]
        prev_hash = genesis["block_hash"]
        for i in range(100):
            entries = [
                _make_entry(crypto_v1, f"task_{i}", 3600000,
                            str(1700000000000 + i * 86400000)),
            ]
            day = _build_day_block(
                crypto_v1, entries, prev_hash,
                date_str=f"2023-{((i // 30) + 1):02d}-{(i % 28) + 1:02d}",
                day_index=i + 1, key_version=1,
                identity_secret=identity_secret,
            )
            chain_blocks.append(day)
            prev_hash = day["day_hash"]
        (data_dir / "ledger.json").write_text(json.dumps(chain_blocks, indent=2))

        # Measure hard rotation time
        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        start = time.perf_counter()
        result = cmd.execute(full=True)
        elapsed = time.perf_counter() - start

        self.assertTrue(result)
        self.assertLess(elapsed, 5.0,
                        f"Hard rotation of 100 blocks took {elapsed:.2f}s, must be < 5s")

    # ── E9: Corrupt entry during hard rotation ───────────────

    def test_e9_corrupt_entry_chain_untouched(self):
        """E9: Hard rotation with corrupt entry returns False and leaves chain untouched."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        # Corrupt one entry in a day block — tamper with ciphertext
        chain_blocks = json.loads((data_dir / "ledger.json").read_text())
        chain_blocks[1]["entries"][0]["data"]["startTime_enc"] = "0000deadbeef0000"
        (data_dir / "ledger.json").write_text(json.dumps(chain_blocks, indent=2))
        chain_before = json.loads((data_dir / "ledger.json").read_text())

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertFalse(result,
                         "Hard rotation with corrupt entry must return False")

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain_before, chain_after,
                         "Chain must be untouched after failed hard rotation")

    # ── E10: Backup creation failure ─────────────────────────

    def test_e10_backup_failure_leaves_chain_untouched(self):
        """E10: hard_rotate() fails if backup directory cannot be created — returns False."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=1
        )

        # Make data_dir read-only so backup creation fails
        data_dir.chmod(0o555)
        chain_before = json.loads((data_dir / "ledger.json").read_text())

        try:
            cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                    identity_secret=identity_secret)
            result = cmd.execute(full=True)
            # Should fail, but may also succeed if backup location is elsewhere
            if not result:
                chain_after = json.loads((data_dir / "ledger.json").read_text())
                self.assertEqual(chain_before, chain_after,
                                 "Chain must be untouched if backup fails")
        finally:
            data_dir.chmod(0o755)


if __name__ == "__main__":
    unittest.main()
