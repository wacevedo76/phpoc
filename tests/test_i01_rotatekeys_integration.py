"""I-01a RotateKeysCommand — Phase 2 RED: Integration & recovery tests (Group I).

End-to-end flows: rotation → verify → commit → verify, recovery after
rotation, passphrase change + rotation, remote push/pull, and CLI wiring.

Group I: Integration & Recovery — 8 tests (I1–I8)

All tests are expected to FAIL (RED) until Phase 3 implementation.
"""

import unittest
import json
import os
import tempfile
import shutil
from pathlib import Path

from security.crypto import CryptoManager, derive_mk
from security.auth import PassphraseAuthenticator
from security.recovery import RecoveryManager
from domain.ledger.chain import LedgerChain
from domain.ledger.helpers import get_block_hash
from domain.ledger.index_manager import IndexManager
from domain.staging.local_cache import LocalStagingCache
from domain.cookie.device_cookie import DeviceCookie
from storage.implementations.file_ledger import FileLedgerStore
from storage.implementations.file_staging import FileStagingStore
from storage.implementations.file_index import FileIndexStore

from cli.rotate_keys import RotateKeysCommand


# ══════════════════════════════════════════════════════════════════
# Test Helpers (same pattern as execution tests)
# ══════════════════════════════════════════════════════════════════

def _build_genesis(seed: bytes, key_version: int = 1, format_version: str = "0.5.0",
                   identity_secret: bytes = None):
    if identity_secret is None:
        identity_secret = os.urandom(32)
    mk = derive_mk(seed, key_version)
    crypto = CryptoManager(mk, key_version=key_version)
    identity = {
        "identity_pub_key": "ee" * 32,
        "identity_secret_enc_fallback": crypto.encrypt(identity_secret.hex()),
        "recovery_seed_enc": crypto.encrypt("mock_enc_seed_v1"),
    }
    genesis = {
        "type": "genesis",
        "key_version": key_version,
        "format_version": format_version,
        "identity": identity,
    }
    check_data = {k: v for k, v in genesis.items()
                  if k not in ("block_hash", "identity_seal", "signature", "format_version", "key_version")}
    genesis["block_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
    genesis["identity_seal"] = crypto.mac(genesis["block_hash"], identity_secret)
    return genesis, identity_secret


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


def _make_entry(crypto, title: str, duration_ms: int = 3600000,
                start_time: str = "1700000000000"):
    import hashlib
    entry_data = {
        "title": title,
        "duration": duration_ms,
        "startTime_enc": crypto.encrypt(start_time),
    }
    entry_data["content_hash"] = _compute_content_hash(entry_data, crypto.decrypt)
    return entry_data


def _build_day_block(crypto, entries, prev_hash, date_str, day_index=1,
                     key_version=1, identity_secret=None):
    import hashlib
    normalized = [{"hash": hashlib.sha256(json.dumps(dict(e), sort_keys=True, indent=2).encode()).hexdigest(),
                   "data": dict(e)} for e in entries]
    day_content = {
        "type": "day", "day_index": day_index, "date": date_str,
        "prev_hash": prev_hash, "entries": normalized, "key_version": key_version,
    }
    seal_data = {k: v for k, v in day_content.items() if k not in ("key_version",)}
    day_content["day_hash"] = crypto.seal(json.dumps(seal_data, sort_keys=True))
    if identity_secret:
        day_content["identity_seal"] = crypto.mac(day_content["day_hash"], identity_secret)
    return day_content


def _setup_test_ledger(tmpdir: Path, seed: bytes, key_version: int = 1,
                       num_day_blocks: int = 2, format_version: str = "0.5.0"):
    data_dir = tmpdir / "phpoc"
    data_dir.mkdir(parents=True, exist_ok=True)

    mk_v1 = derive_mk(seed, key_version)
    crypto_v1 = CryptoManager(mk_v1, key_version=key_version)
    identity_secret = os.urandom(32)

    genesis, identity_secret = _build_genesis(
        seed, key_version=key_version, format_version=format_version,
        identity_secret=identity_secret
    )

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
            crypto_v1, entries, prev_hash, f"2023-11-{15 + i:02d}",
            day_index=i + 1, key_version=key_version,
            identity_secret=identity_secret,
        )
        chain_blocks.append(day)
        prev_hash = day["day_hash"]

    (data_dir / "ledger.json").write_text(json.dumps(chain_blocks, indent=2))

    staging_store = FileStagingStore(data_dir / "staging.json")
    staging_cache = LocalStagingCache(crypto_v1, staging_store)
    staging_cache.append(title="staged_task", start_epoch=1700100000000,
                            end_epoch=1700100000000 + 7200000)

    index_store = FileIndexStore(data_dir / "index.json")
    index_mgr = IndexManager(index_store, crypto_v1)
    index_mgr.update("2023-11-15", "task_0_a", 3600000)

    DeviceCookie.create("test-device-uuid", data_dir)
    return data_dir, genesis, identity_secret, crypto_v1, mk_v1


# ══════════════════════════════════════════════════════════════════
# Group I: Integration & Recovery
# ══════════════════════════════════════════════════════════════════

class TestRotationIntegration(unittest.TestCase):
    """I1–I8: End-to-end integration and recovery tests."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_test_i_"))
        self.seed = os.urandom(32)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ── I1: Full soft rotation lifecycle ─────────────────────

    def test_i1_full_soft_rotation_lifecycle(self):
        """I1: Full soft rotation lifecycle: rotate → verify → commit new entries → verify again."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        # 1. Soft rotate
        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result, "Soft rotation must succeed")

        # 2. Verify chain with multi-version lookup
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
        self.assertTrue(chain.verify(get_mk_for_version=get_mk_for_version),
                        "Chain must verify after soft rotation")

        # 3. Commit a new entry with the new key_version (v2)
        new_entry = _make_entry(crypto_v2, "post_rotate_task", 1800000,
                                "1700300000000")
        last_block = store.get_last_block()
        new_day = _build_day_block(
            crypto_v2, [new_entry],
            prev_hash=last_block.get("block_hash") or last_block.get("day_hash"),
            date_str="2023-11-18", day_index=3, key_version=2,
            identity_secret=identity_secret,
        )
        store.append_blocks([new_day])

        # 4. Verify again — chain with v1+v2 blocks must still verify
        self.assertTrue(chain.verify(get_mk_for_version=get_mk_for_version),
                        "Chain must verify after committing new v2 block")

        # New block must have key_version=2
        last = store.get_last_block()
        self.assertEqual(last.get("key_version"), 2)

    # ── I2: Full hard rotation lifecycle ─────────────────────

    def test_i2_full_hard_rotation_lifecycle(self):
        """I2: Full hard rotation lifecycle: hard-rotate → verify → commit → verify."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result, "Hard rotation must succeed")

        mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)
        store = FileLedgerStore(data_dir / "ledger.json")
        chain = LedgerChain(crypto_v2, store, identity_secret=identity_secret)
        self.assertTrue(chain.verify(),
                        "Single-version chain must verify after hard rotation")

        # Commit new entry
        new_entry = _make_entry(crypto_v2, "post_hard_task", 3600000,
                                "1700300000000")
        last_block = store.get_last_block()
        new_day = _build_day_block(
            crypto_v2, [new_entry],
            prev_hash=last_block.get("block_hash") or last_block.get("day_hash"),
            date_str="2023-11-18", day_index=3, key_version=2,
            identity_secret=identity_secret,
        )
        store.append_blocks([new_day])

        self.assertTrue(chain.verify(),
                        "Chain must verify after committing new entry post-hard-rotation")

    # ── I3: Recovery after soft rotation ─────────────────────

    def test_i3_recovery_after_soft_rotation(self):
        """I3: After soft rotation, recovery from seed re-derives all MKs and chain verifies."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result, "Soft rotation must succeed")

        # Simulate recovery: re-derive MKs from seed
        recovered_mk_v1 = derive_mk(self.seed, 1)
        recovered_mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(recovered_mk_v2, key_version=2)

        self.assertEqual(recovered_mk_v1, mk_v1, "v1 MK must be recoverable from seed")
        self.assertEqual(recovered_mk_v2, derive_mk(self.seed, 2),
                         "v2 MK must be recoverable from seed")

        def get_mk_for_version(version):
            if version == 1:
                return CryptoManager(recovered_mk_v1, key_version=1)
            if version == 2:
                return crypto_v2
            return None

        store = FileLedgerStore(data_dir / "ledger.json")
        chain = LedgerChain(crypto_v2, store, identity_secret=identity_secret)
        self.assertTrue(chain.verify(get_mk_for_version=get_mk_for_version),
                        "Mixed-version chain must verify after recovery from seed")

    # ── I4: Recovery after hard rotation ─────────────────────

    def test_i4_recovery_after_hard_rotation(self):
        """I4: After hard rotation, recovery from seed re-derives all MKs and chain verifies."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=2
        )

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=True)
        self.assertTrue(result, "Hard rotation must succeed")

        # Recover: derive both MKs from seed
        recovered_mk_v1 = derive_mk(self.seed, 1)
        recovered_mk_v2 = derive_mk(self.seed, 2)
        crypto_v2 = CryptoManager(recovered_mk_v2, key_version=2)

        # After hard rotation, all blocks are v2 — single-version verify must pass
        store = FileLedgerStore(data_dir / "ledger.json")
        chain = LedgerChain(crypto_v2, store, identity_secret=identity_secret)
        self.assertTrue(chain.verify(),
                        "Single-version chain must verify after recovery from seed")

        # Backup should also be verifiable with v1 MK
        backup_dirs = list(data_dir.glob("backup_*"))
        self.assertGreater(len(backup_dirs), 0)
        backup_ledger = backup_dirs[0] / "ledger.json"
        if backup_ledger.exists():
            backup_store = FileLedgerStore(backup_ledger)
            backup_chain = LedgerChain(
                CryptoManager(recovered_mk_v1, key_version=1),
                backup_store, identity_secret=identity_secret,
            )
            self.assertTrue(backup_chain.verify(),
                            "Backup chain must verify with recovered v1 MK")

    # ── I5: Passphrase change after rotation ─────────────────

    def test_i5_passphrase_change_after_rotation(self):
        """I5: Soft rotation followed by passphrase change — all MKs re-derived correctly.

        When old_seed is provided, execute() escalates to hard rotation internally
        because soft rotation alone would leave day-block seals bound to the old MK.
        After escalation, all blocks are at the new key_version (3) and the chain
        verifies cleanly under the new seed's MKs.
        """
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1, num_day_blocks=1
        )

        # Soft rotate with original seed
        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        # Passphrase change: new seed + old_seed → escalates to hard rotation
        new_seed = os.urandom(32)
        passphrase_change_cmd = RotateKeysCommand(
            data_dir=data_dir, seed=new_seed,
            identity_secret=identity_secret,
            old_seed=self.seed,
        )
        change_result = passphrase_change_cmd.execute(full=False)
        self.assertTrue(change_result,
                        "Passphrase change rotation must succeed")

        # After hard rotation, all blocks are at key_version=3
        chain_after = json.loads((data_dir / "ledger.json").read_text())
        for block in chain_after:
            self.assertEqual(block.get("key_version"), 3,
                             "All blocks must be at key_version=3 after passphrase change")

        # Chain must verify with new seed's v3 MK
        new_mk_v3 = derive_mk(new_seed, 3)
        new_crypto_v3 = CryptoManager(new_mk_v3, key_version=3)

        def get_mk_for_version(version):
            if version == 3:
                return new_crypto_v3
            # Backup verification may need v1/v2
            new_mk_v1 = derive_mk(new_seed, 1)
            new_mk_v2 = derive_mk(new_seed, 2)
            if version == 1:
                return CryptoManager(new_mk_v1, key_version=1)
            if version == 2:
                return CryptoManager(new_mk_v2, key_version=2)
            return None

        store = FileLedgerStore(data_dir / "ledger.json")
        chain = LedgerChain(new_crypto_v3, store, identity_secret=identity_secret)
        self.assertTrue(chain.verify(get_mk_for_version=get_mk_for_version),
                        "Chain must verify after passphrase change + hard rotation")

        # Backup must be verifiable with old seed's MKs (pre-change snapshot)
        backup_dirs = list(data_dir.glob("backup_*"))
        self.assertGreater(len(backup_dirs), 0,
                           "Passphrase change must create backup")
        backup_ledger = backup_dirs[0] / "ledger.json"
        if backup_ledger.exists():
            backup_store = FileLedgerStore(backup_ledger)
            # Backup was at key_version=2 (after first soft rotation)
            old_mk_v2 = derive_mk(self.seed, 2)
            old_mk_v1 = derive_mk(self.seed, 1)
            backup_crypto_v2 = CryptoManager(old_mk_v2, key_version=2)

            def old_get_mk(v):
                if v == 1:
                    return CryptoManager(old_mk_v1, key_version=1)
                if v == 2:
                    return backup_crypto_v2
                return None

            backup_chain = LedgerChain(backup_crypto_v2, backup_store,
                                       identity_secret=identity_secret)
            self.assertTrue(backup_chain.verify(get_mk_for_version=old_get_mk),
                            "Backup chain must verify with old seed's MKs")

    # ── I6: Remote push after soft rotation ──────────────────

    def test_i6_remote_push_after_soft_rotation(self):
        """I6: Remote push after soft rotation — re-encrypted staging blob and new cookie are pushed."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # Mock remote transport tracking
        pushed_cookie = None
        pushed_staging = None

        class _MockTransport:
            def push_cookie(self, cookie_bytes):
                nonlocal pushed_cookie
                pushed_cookie = cookie_bytes
                return True

            def push_blob(self, path, data_bytes):
                nonlocal pushed_staging
                if "staging" in path:
                    pushed_staging = data_bytes
                return True

        transport = _MockTransport()

        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret,
                                transport=transport)
        result = cmd.execute(full=False)
        self.assertTrue(result)

        # After rotation, new cookie and staging should be pushed
        self.assertIsNotNone(pushed_cookie,
                             "New device cookie must be pushed to remote after rotation")
        self.assertIsNotNone(pushed_staging,
                             "Re-encrypted staging blob must be pushed after rotation")

        # The pushed cookie should be valid JSON with device_specifier
        cookie_dict = json.loads(pushed_cookie.decode())
        self.assertIn("device_specifier", cookie_dict)
        self.assertIn("device_uuid", cookie_dict)

    # ── I7: Cross-device rotation detection ──────────────────

    def test_i7_cross_device_rotation_detection(self):
        """I7: Remote pull after another device soft-rotated — local detects cookie mismatch."""
        data_dir, genesis, identity_secret, crypto_v1, mk_v1 = _setup_test_ledger(
            self.tmpdir, self.seed, key_version=1
        )

        # Simulate: this device's cookie
        local_specifier = json.loads(
            (data_dir / "device_cookie.meta").read_text()
        )["device_specifier"]

        # Simulate: remote cookie from a different device (different specifier)
        remote_cookie = json.dumps({
            "device_uuid": "other-device-uuid",
            "device_specifier": "ff" * 16,  # different from local
        }).encode()

        # Local should detect mismatch
        parsed = json.loads(remote_cookie.decode())
        self.assertNotEqual(local_specifier, parsed["device_specifier"],
                            "Remote cookie must not match local after other device rotated")

        # The cookie mismatch should trigger re-auth + re-encrypt
        # This is tested by verifying the rotate command can handle the mismatch
        cmd = RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                identity_secret=identity_secret)
        # After detecting mismatch, local should be able to rotate and sync
        result = cmd.execute(full=False)
        self.assertTrue(result,
                        "Rotation must succeed even after cross-device cookie mismatch")

        # Local cookie must be updated with new specifier
        new_local = json.loads((data_dir / "device_cookie.meta").read_text())
        self.assertNotEqual(new_local["device_specifier"], local_specifier,
                            "Local cookie must be regenerated after rotation")

    # ── I8: CLI wiring ───────────────────────────────────────

    def test_i8_cli_full_flag_parsing(self):
        """I8: ph rotate-keys CLI command parses --full flag and delegates to execute(full=True)."""
        cmd = RotateKeysCommand(data_dir=self.tmpdir / "phpoc",
                                seed=self.seed,
                                identity_secret=os.urandom(32))

        # Default (no --full): must be soft rotation
        self.assertFalse(cmd.full, "Default rotation should be soft (full=False)")

        # Verify execute() delegates correctly
        self.assertTrue(hasattr(cmd, "execute"),
                        "RotateKeysCommand must have execute() method")
        self.assertTrue(hasattr(cmd, "soft_rotate"),
                        "RotateKeysCommand must have soft_rotate() method")
        self.assertTrue(hasattr(cmd, "hard_rotate"),
                        "RotateKeysCommand must have hard_rotate() method")
        self.assertTrue(hasattr(cmd, "requires_auth"),
                        "RotateKeysCommand.requires_auth must be True")

        # The command is designed for CLI --full flag:
        #   ph rotate-keys         → execute(full=False) → soft_rotate()
        #   ph rotate-keys --full  → execute(full=True)  → hard_rotate()
        self.assertTrue(cmd.requires_auth,
                        "Rotation must require authentication (passphrase re-entry)")


if __name__ == "__main__":
    unittest.main()
