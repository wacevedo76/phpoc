"""C-2 CLI Seed Re-Key (`ph rekey-seed`) — Phase 2 RED: test definition.

Blueprint: ``docs/planning/C2_CLI_SEED_REKEY_PHASE1.md`` — 34 assertions.

Group R — Re-key orchestration (11): R1–R11
Group B — Backup & safety (5):       B1–B5
Group M — Migration / key exchange (6): M1–M6
Group P — Push & device coords (6):  P1–P6
Group C — CLI command wiring (6):    C1–C6

All behavioral tests are expected to FAIL (RED) until Phase 3 implements
``RotateKeysCommand.mint_new_seed``/``renew_seed``/``seed_fingerprint`` and the
``main.py`` rekey-seed wiring. Structural wiring (C1 require_auth gating, C5
``--renew-seed`` flag) is stubbed now and is guard-green by design.

API contract (Phase 3 must implement to these signatures):

  RotateKeysCommand(..., pdk=None)              — pdk = 32-byte PDK for seed-vault rewrite
  RotateKeysCommand.mint_new_seed() -> str      — base64 of 32 CSPRNG bytes
  RotateKeysCommand.seed_fingerprint(seed_b64) -> str — SHA-256 hex (64 chars)
  RotateKeysCommand.renew_seed() -> Optional[str] — new seed b64 on success,
      None/False on failure; refuses if ``rekey_seed.json`` marker exists

  Marker: ``<data_dir>/rekey_seed.json`` = {"seed_fingerprint", "key_version", "rekeyed_at"}.

  Real transport contract (AbstractStagingTransport: pull/push):
      transport.pull(path) -> bytes | None
      transport.push(path, data_bytes) -> None
  paths: "ledger/blocks/NNNNNN.json" (per-block obfuscated chain, P1),
      "ledger/index.json" (obfuscated, P1), "ledger/hash_index.json" (+ .sha256, P1),
      "staging/blob" (obfuscated staging blob, P6),
      "staging/blobs/device_cookie.bin" (plaintext cookie, P3/P6).

  main._derive_rekey_pdk(passphrase, identity_pub_key) -> bytes (C2)
  main._handle_rekey_seed(auth, CONFIG_DIR, ledger, transport=None, *,
      passphrase=None, acknowledge=None, out=None) -> bool (B5/C3/C4/C6)
"""

import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from security.crypto import CryptoManager, derive_mk
from security.recovery import RecoveryManager
from security.auth import PassphraseAuthenticator, derive_pdk_salt
from domain.ledger.chain import LedgerChain, select_seal_fields
from domain.ledger.index_manager import IndexManager
from domain.ledger.remote_sync import RemoteLedgerSync
from domain.staging.local_cache import LocalStagingCache
from domain.staging.remote_sync import RemoteStagingSync, REMOTE_COOKIE_PATH, BLOB_KEY_MISMATCH
from domain.cookie.device_cookie import DeviceCookie
from storage.implementations.file_ledger import FileLedgerStore
from storage.implementations.file_staging import FileStagingStore
from storage.implementations.file_index import FileIndexStore

from phpoc_cli.rotate_keys import RotateKeysCommand

REPO_ROOT = Path(__file__).resolve().parent.parent
TEST_PASSPHRASE = "test-passphrase-123"

# Deterministic 32-byte PDK for the fast (shape-only) fixture path.
FIXED_PDK = hashlib.sha256(b"phpoc:test:pdk").digest()


# ══════════════════════════════════════════════════════════════════
# Test Helpers (PDK-realistic fixture)
# ══════════════════════════════════════════════════════════════════

def _build_genesis(seed, identity_secret, identity_pub_key, pdk,
                   key_version=1, format_version="0.5.0"):
    """Genesis block with a PDK-encrypted recovery_seed_enc (production shape)."""
    mk = derive_mk(seed, key_version)
    crypto = CryptoManager(mk, key_version=key_version)
    seed_b64 = base64.b64encode(seed).decode()

    identity = {
        "identity_pub_key": identity_pub_key,
        "identity_secret_enc_fallback": crypto.encrypt(identity_secret.hex()),
        # Production vault shape (§4.1): recovery seed is PDK-encrypted, NOT MK.
        "recovery_seed_enc": RecoveryManager.encrypt_seed(seed_b64, pdk),
    }

    genesis = {
        "type": "genesis",
        "key_version": key_version,
        "format_version": format_version,
        "identity": identity,
    }

    check_data = select_seal_fields(genesis)
    genesis["block_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
    genesis["identity_seal"] = crypto.mac(genesis["block_hash"], identity_secret)
    return genesis, seed_b64


def _compute_content_hash(data, decrypt_fn):
    """content_hash matching LedgerChain._verify_content_hash algorithm."""
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
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def _make_entry(crypto, title, duration_ms=3600000, start_time="1700000000000"):
    entry_data = {
        "title": title,
        "duration": duration_ms,
        "startTime_enc": crypto.encrypt(start_time),
    }
    entry_data["content_hash"] = _compute_content_hash(entry_data, crypto.decrypt)
    return entry_data


def _build_day_block(crypto, entries, prev_hash, date_str, day_index=1,
                     key_version=1, identity_secret=None):
    normalized = [
        {"hash": hashlib.sha256(json.dumps(dict(e), sort_keys=True, indent=2).encode()).hexdigest(),
         "data": dict(e)}
        for e in entries
    ]
    day_content = {
        "type": "day",
        "day_index": day_index,
        "date": date_str,
        "prev_hash": prev_hash,
        "entries": normalized,
        "key_version": key_version,
    }
    seal_data = select_seal_fields(day_content)
    day_content["day_hash"] = crypto.seal(json.dumps(seal_data, sort_keys=True))
    if identity_secret:
        day_content["identity_seal"] = crypto.mac(day_content["day_hash"], identity_secret)
    return day_content


def _setup_test_ledger(tmpdir, seed, key_version=1, num_day_blocks=2,
                       format_version="0.5.0", pdk=FIXED_PDK, passphrase=None):
    """Set up a complete test ledger in a temp dir (PDK-realistic).

    Writes ledger.json (genesis + N day blocks), staging.json (2 entries),
    index.json (2 blind-index entries), identity.json (MK-encrypted
    identity_secret_enc), and a device cookie.

    If ``passphrase`` is given, the seed vault is encrypted under the real
    PBKDF2-derived PDK (per-user salt), so the CLI handler tests (B5/C3/C4/C6)
    exercise the production vault + two-secret confirmation path.

    Returns: (data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk)
    """
    data_dir = tmpdir / "phpoc"
    data_dir.mkdir(parents=True, exist_ok=True)

    mk_v1 = derive_mk(seed, key_version)
    crypto_v1 = CryptoManager(mk_v1, key_version=key_version)
    identity_secret = os.urandom(32)
    identity_pub_key = hashlib.sha256(identity_secret).hexdigest()

    if passphrase is not None:
        salt = derive_pdk_salt(identity_pub_key)
        pdk = hashlib.pbkdf2_hmac(
            "sha256", passphrase.encode(), salt,
            PassphraseAuthenticator.PBKDF2_ITERATIONS, 32,
        )

    genesis, seed_b64 = _build_genesis(
        seed, identity_secret, identity_pub_key, pdk,
        key_version=key_version, format_version=format_version,
    )

    (data_dir / "identity.json").write_text(json.dumps({
        "identity_secret_enc": crypto_v1.encrypt(identity_secret.hex()),
    }, indent=2))

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
    staging_cache.append(title="staged_task_1", start_epoch=1700100000000,
                         end_epoch=1700100000000 + 7200000)
    staging_cache.append(title="staged_task_2", start_epoch=1700200000000,
                         end_epoch=1700200000000 + 900000)

    index_store = FileIndexStore(data_dir / "index.json")
    index_mgr = IndexManager(index_store, crypto_v1)
    index_mgr.update("2023-11-15", "task_0_a", 3600000)
    index_mgr.update("2023-11-15", "task_0_b", 1800000)

    DeviceCookie.create("test-device-uuid", data_dir)

    return data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk


def _new_crypto_from_seed_b64(seed_b64, key_version):
    """Derive a CryptoManager for the new seed at the given key version."""
    return CryptoManager(derive_mk(base64.b64decode(seed_b64), key_version),
                         key_version=key_version)


class _RekeyTransportSpy:
    """Real-shape transport spy (AbstractStagingTransport: pull/push)."""

    def __init__(self):
        self.push_calls = []    # list of (path, data_bytes)
        self.pull_calls = []    # list of path
        self._blobs = {}

    def push(self, path, data_bytes):
        self.push_calls.append((path, data_bytes))
        self._blobs[path] = data_bytes
        return None

    def pull(self, path):
        self.pull_calls.append(path)
        return self._blobs.get(path)

    def list_files(self, prefix=""):
        return [p.rsplit("/", 1)[-1] for p in self._blobs if p.startswith(prefix)]

    def get(self, path):
        return self._blobs.get(path)

    def paths(self):
        return {p for p, _ in self.push_calls}


class _AuthStub:
    """Minimal auth stand-in exposing get_key() -> raw seed bytes."""

    def __init__(self, seed):
        self._key = seed

    def get_key(self):
        return self._key


class _LedgerStub:
    """Minimal ledger stand-in exposing _get_identity_secret() -> bytes."""

    def __init__(self, identity_secret):
        self._identity_secret = identity_secret

    def _get_identity_secret(self):
        return self._identity_secret


# ══════════════════════════════════════════════════════════════════
# Group R: Re-key orchestration
# ══════════════════════════════════════════════════════════════════

class TestRekeyOrchestration(unittest.TestCase):
    """R1–R11: re-key orchestration tests with real file I/O."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_rekey_r_"))
        self.seed = os.urandom(32)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _snapshot(self, data_dir):
        return {
            f: (data_dir / f).read_text() if (data_dir / f).exists() else None
            for f in ["ledger.json", "staging.json", "index.json", "identity.json"]
        }

    def _cmd(self, data_dir, identity_secret, pdk, seed=None, transport=None):
        return RotateKeysCommand(
            data_dir=data_dir, seed=seed or self.seed,
            identity_secret=identity_secret, pdk=pdk, transport=transport,
        )

    def test_r1_wrong_seed_returns_falsy_and_mutates_nothing(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        before = self._snapshot(data_dir)

        cmd = self._cmd(data_dir, identity_secret, pdk, seed=os.urandom(32))
        result = cmd.renew_seed()
        self.assertFalse(result)  # None or False both satisfy the contract

        self.assertEqual(before, self._snapshot(data_dir))

    def test_r2_backup_created_before_write(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)

        cmd = self._cmd(data_dir, identity_secret, pdk)
        result = cmd.renew_seed()
        self.assertTrue(result)

        backups = sorted(data_dir.glob("backup_*"))
        self.assertGreater(len(backups), 0)
        self.assertTrue((backups[0] / "ledger.json").exists())
        # Backup is the pre-re-key chain: it must decrypt under the OLD MK.
        backup_chain = json.loads((backups[0] / "ledger.json").read_text())
        self.assertEqual(backup_chain[0]["key_version"], 1)

    def test_r3_mint_new_seed_returns_32_bytes(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        seed_b64 = cmd.mint_new_seed()
        self.assertEqual(len(base64.b64decode(seed_b64)), 32)

    def test_r4_mint_new_seed_differs_from_current(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        self.assertNotEqual(cmd.mint_new_seed(), cmd.mint_new_seed())
        self.assertNotEqual(cmd.mint_new_seed(), base64.b64encode(self.seed).decode())

    def test_r5_recovery_seed_enc_rewritten_to_new_seed(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        chain = json.loads((data_dir / "ledger.json").read_text())
        enc = chain[0]["identity"]["recovery_seed_enc"]
        self.assertEqual(RecoveryManager.decrypt_seed(enc, pdk), new_seed_b64)
        self.assertNotEqual(new_seed_b64, seed_b64)  # old seed retired

    def test_r6_old_seed_no_longer_decrypts(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        chain = json.loads((data_dir / "ledger.json").read_text())
        # Every entry _enc must fail to decrypt under the OLD MK.
        for block in chain:
            if block["type"] != "day":
                continue
            for entry in block["entries"]:
                for k, v in entry["data"].items():
                    if k.endswith("_enc") and v:
                        self.assertRaises(Exception, crypto_v1.decrypt, v)
        # Genesis fallback + identity.json must fail under the OLD MK.
        self.assertRaises(
            Exception, crypto_v1.decrypt,
            chain[0]["identity"]["identity_secret_enc_fallback"])
        id_enc = json.loads((data_dir / "identity.json").read_text())["identity_secret_enc"]
        self.assertRaises(Exception, crypto_v1.decrypt, id_enc)

    def test_r7_genesis_resealed_under_new_mk(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        old_seal = genesis["block_hash"]
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        chain = json.loads((data_dir / "ledger.json").read_text())
        new_kv = chain[0]["key_version"]
        crypto_v2 = _new_crypto_from_seed_b64(new_seed_b64, new_kv)
        new_genesis = chain[0]
        check_data = select_seal_fields(new_genesis)
        self.assertTrue(crypto_v2.verify_seal(
            json.dumps(check_data, sort_keys=True), new_genesis["block_hash"]))
        self.assertNotEqual(old_seal, new_genesis["block_hash"])

    def test_r8_every_block_decrypts_under_new_mk(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        chain = json.loads((data_dir / "ledger.json").read_text())
        crypto_v2 = _new_crypto_from_seed_b64(new_seed_b64, chain[0]["key_version"])
        for block in chain:
            if block["type"] != "day":
                continue
            for entry in block["entries"]:
                for k, v in entry["data"].items():
                    if k.endswith("_enc") and v:
                        self.assertIsInstance(crypto_v2.decrypt(v), str)

    def test_r9_content_hash_unchanged(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        before = json.loads((data_dir / "ledger.json").read_text())
        before_hashes = {
            (i, j): e["data"]["content_hash"]
            for i, b in enumerate(before) if b["type"] == "day"
            for j, e in enumerate(b["entries"])
        }
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        after = json.loads((data_dir / "ledger.json").read_text())
        after_hashes = {
            (i, j): e["data"]["content_hash"]
            for i, b in enumerate(after) if b["type"] == "day"
            for j, e in enumerate(b["entries"])
        }
        self.assertEqual(before_hashes, after_hashes)

    def test_r10_every_block_resealed_and_verifies(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        chain = json.loads((data_dir / "ledger.json").read_text())
        crypto_v2 = _new_crypto_from_seed_b64(new_seed_b64, chain[0]["key_version"])
        for block in chain:
            hash_key = "block_hash" if block["type"] == "genesis" else "day_hash"
            check_data = select_seal_fields(block)
            self.assertTrue(crypto_v2.verify_seal(
                json.dumps(check_data, sort_keys=True), block[hash_key]))

    def test_r11_full_chain_verifies_under_new_key_set(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        chain = json.loads((data_dir / "ledger.json").read_text())
        crypto_v2 = _new_crypto_from_seed_b64(new_seed_b64, chain[0]["key_version"])
        store = FileLedgerStore(data_dir / "ledger.json")
        self.assertTrue(LedgerChain(crypto_v2, store, identity_secret=identity_secret).verify())


# ══════════════════════════════════════════════════════════════════
# Group B: Backup & safety
# ══════════════════════════════════════════════════════════════════

class TestRekeyBackupSafety(unittest.TestCase):
    """B1–B5: backup & safety tests."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_rekey_b_"))
        self.seed = os.urandom(32)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _cmd(self, data_dir, identity_secret, pdk, seed=None, transport=None):
        return RotateKeysCommand(
            data_dir=data_dir, seed=seed or self.seed,
            identity_secret=identity_secret, pdk=pdk, transport=transport,
        )

    def test_b1_backup_verifies_under_old_mk(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        backups = sorted(data_dir.glob("backup_*"))
        self.assertGreater(len(backups), 0)
        store = FileLedgerStore(backups[0] / "ledger.json")
        # Pre-re-key chain is single-version (v1): verify under the OLD MK.
        self.assertTrue(LedgerChain(crypto_v1, store, identity_secret=identity_secret).verify())

    def test_b2_abort_leaves_no_partial_write(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        # Corrupt a day-block entry ciphertext so the re-encrypt/re-seal pass fails.
        chain = json.loads((data_dir / "ledger.json").read_text())
        chain[1]["entries"][0]["data"]["startTime_enc"] = "deadbeef" * 8
        (data_dir / "ledger.json").write_text(json.dumps(chain, indent=2))
        before = {
            f: (data_dir / f).read_text() if (data_dir / f).exists() else None
            for f in ["ledger.json", "staging.json", "index.json", "identity.json"]
        }

        cmd = self._cmd(data_dir, identity_secret, pdk)
        result = cmd.renew_seed()
        self.assertFalse(result)
        self.assertEqual(before, before)  # no partial write (see explicit checks below)
        after = {
            f: (data_dir / f).read_text() if (data_dir / f).exists() else None
            for f in ["ledger.json", "staging.json", "index.json", "identity.json"]
        }
        self.assertEqual(before, after)

    def test_b3_no_double_run_when_marker_present(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)
        chain_after_first = (data_dir / "ledger.json").read_text()

        # Re-run with the CURRENT (valid) seed: marker guard must refuse re-mint.
        new_seed = base64.b64decode(new_seed_b64)
        cmd2 = self._cmd(data_dir, identity_secret, pdk, seed=new_seed)
        result2 = cmd2.renew_seed()
        self.assertFalse(result2)
        self.assertEqual(chain_after_first, (data_dir / "ledger.json").read_text())

    def test_b4_seed_fingerprint_recorded(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        marker = json.loads((data_dir / "rekey_seed.json").read_text())
        fp = marker["seed_fingerprint"]
        self.assertEqual(len(fp), 64)
        self.assertEqual(fp, RotateKeysCommand.seed_fingerprint(new_seed_b64))
        self.assertNotEqual(fp, RotateKeysCommand.seed_fingerprint(seed_b64))

    def test_b5_reveal_requires_acknowledgment(self):
        from main import _handle_rekey_seed
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed, passphrase=TEST_PASSPHRASE)
        auth = _AuthStub(self.seed)
        ledger = _LedgerStub(identity_secret)
        buf = io.StringIO()
        chain_before = (data_dir / "ledger.json").read_text()

        # Acknowledgment declines → no re-key, no reveal, no marker.
        result = _handle_rekey_seed(auth, data_dir, ledger,
                                    passphrase=TEST_PASSPHRASE,
                                    acknowledge=lambda: False, out=buf)
        self.assertFalse(result)
        self.assertEqual(buf.getvalue(), "")
        self.assertEqual(chain_before, (data_dir / "ledger.json").read_text())
        self.assertFalse((data_dir / "rekey_seed.json").exists())


# ══════════════════════════════════════════════════════════════════
# Group M: Migration / key exchange
# ══════════════════════════════════════════════════════════════════

class TestRekeyMigration(unittest.TestCase):
    """M1–M6: migration / key-exchange invariants."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_rekey_m_"))
        self.seed = os.urandom(32)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _cmd(self, data_dir, identity_secret, pdk):
        return RotateKeysCommand(data_dir=data_dir, seed=self.seed,
                                 identity_secret=identity_secret, pdk=pdk)

    def test_m1_key_version_bumped_on_every_block(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed, key_version=1)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        chain = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain[0]["key_version"], 2)
        for block in chain[1:]:
            self.assertEqual(block["key_version"], 2)

    def test_m2_identity_mac_recomputed_under_new_mk(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        old_seal = genesis["identity_seal"]
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        chain = json.loads((data_dir / "ledger.json").read_text())
        new_genesis = chain[0]
        crypto_v2 = _new_crypto_from_seed_b64(new_seed_b64, new_genesis["key_version"])
        # MAC verifies under new MK + identity_secret, and differs from before.
        self.assertEqual(new_genesis["identity_seal"],
                         crypto_v2.mac(new_genesis["block_hash"], identity_secret))
        self.assertNotEqual(old_seal, new_genesis["identity_seal"])

    def test_m3_prev_hash_cascade_intact(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed, num_day_blocks=3)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        chain = json.loads((data_dir / "ledger.json").read_text())
        for i in range(1, len(chain)):
            self.assertEqual(chain[i]["prev_hash"],
                             chain[i - 1]["day_hash"] if i > 1 else chain[0]["block_hash"])

    def test_m4_atomic_swap_no_orphan_files(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        # No temp/orphan files remain; ledger.json is a single valid JSON doc.
        leftovers = list(data_dir.glob("ledger.json*"))
        self.assertEqual([p.name for p in leftovers], ["ledger.json"])
        chain = json.loads((data_dir / "ledger.json").read_text())
        self.assertEqual(chain[0]["key_version"], 2)

    def test_m5_commonplace_untouched(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        cp = {"note": "keep me", "n": 42}
        (data_dir / "commonplace.json").write_text(json.dumps(cp))
        before = (data_dir / "commonplace.json").read_text()

        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        self.assertEqual(before, (data_dir / "commonplace.json").read_text())

    def test_m6_block_order_and_entry_counts_preserved(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed, num_day_blocks=3)
        before = json.loads((data_dir / "ledger.json").read_text())
        before_order = [(b["type"], b.get("date"), b.get("day_index")) for b in before]
        before_counts = [len(b["entries"]) for b in before if b["type"] == "day"]

        cmd = self._cmd(data_dir, identity_secret, pdk)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        after = json.loads((data_dir / "ledger.json").read_text())
        after_order = [(b["type"], b.get("date"), b.get("day_index")) for b in after]
        after_counts = [len(b["entries"]) for b in after if b["type"] == "day"]
        self.assertEqual(before_order, after_order)
        self.assertEqual(before_counts, after_counts)


# ══════════════════════════════════════════════════════════════════
# Group P: Push & device coordinates
# ══════════════════════════════════════════════════════════════════

class TestRekeyPushCoords(unittest.TestCase):
    """P1–P6: push & device coordination via the flat transport contract."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_rekey_p_"))
        self.seed = os.urandom(32)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _cmd(self, data_dir, identity_secret, pdk, seed=None, transport=None):
        return RotateKeysCommand(data_dir=data_dir, seed=seed or self.seed,
                                 identity_secret=identity_secret, pdk=pdk,
                                 transport=transport)

    def test_p1_pushes_blocks_hash_index_and_index(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        spy = _RekeyTransportSpy()
        cmd = self._cmd(data_dir, identity_secret, pdk, transport=spy)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        paths = spy.paths()
        self.assertIn("ledger/blocks/000000.json", paths)
        self.assertIn("ledger/blocks/000001.json", paths)
        self.assertIn("ledger/blocks/000002.json", paths)
        self.assertIn("ledger/hash_index.json", paths)
        self.assertIn("ledger/index.json", paths)

        # Block files are obfuscated per-block; pull back under the NEW MK.
        mk_v2 = derive_mk(base64.b64decode(new_seed_b64), 2)
        chain = RemoteLedgerSync(spy, mk_v2).pull_full_chain()
        self.assertEqual(len(chain), 3)  # genesis + 2 day blocks
        self.assertEqual(chain[0]["key_version"], 2)

    def test_p2_pushes_genesis_with_new_recovery_seed_enc(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        spy = _RekeyTransportSpy()
        cmd = self._cmd(data_dir, identity_secret, pdk, transport=spy)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        mk_v2 = derive_mk(base64.b64decode(new_seed_b64), 2)
        pushed_genesis = RemoteLedgerSync(spy, mk_v2).pull_block_by_index(0)
        self.assertEqual(RecoveryManager.decrypt_seed(
            pushed_genesis["identity"]["recovery_seed_enc"], pdk), new_seed_b64)

    def test_p3_cookie_specifier_rotated_forces_reauth(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        spec_before = json.loads((data_dir / "device_cookie.meta").read_text())["device_specifier"]

        spy = _RekeyTransportSpy()
        cmd = self._cmd(data_dir, identity_secret, pdk, transport=spy)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        # Local meta rotated + the pushed remote cookie carries the NEW specifier.
        spec_after = json.loads((data_dir / "device_cookie.meta").read_text())["device_specifier"]
        self.assertNotEqual(spec_before, spec_after)
        pushed_cookie = json.loads(spy.get(REMOTE_COOKIE_PATH).decode())
        self.assertEqual(pushed_cookie["device_specifier"], spec_after)

    def test_p4_second_device_repulls_and_verifies_under_new_mk(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        spy = _RekeyTransportSpy()
        cmd = self._cmd(data_dir, identity_secret, pdk, transport=spy)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        mk_v2 = derive_mk(base64.b64decode(new_seed_b64), 2)
        chain = RemoteLedgerSync(spy, mk_v2).pull_full_chain()
        self.assertEqual(len(chain), 3)
        crypto_v2 = CryptoManager(mk_v2, key_version=2)
        p4_dir = self.tmpdir / "phpoc_second"
        p4_dir.mkdir(parents=True, exist_ok=True)
        (p4_dir / "ledger.json").write_text(json.dumps(chain, indent=2))
        store2 = FileLedgerStore(p4_dir / "ledger.json")
        self.assertTrue(LedgerChain(crypto_v2, store2, identity_secret=identity_secret).verify())

    def test_p5_repeat_rekey_pushes_nothing_new(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        spy = _RekeyTransportSpy()
        cmd = self._cmd(data_dir, identity_secret, pdk, transport=spy)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)
        push_count = len(spy.push_calls)

        cmd2 = self._cmd(data_dir, identity_secret, pdk,
                         seed=base64.b64decode(new_seed_b64), transport=spy)
        result2 = cmd2.renew_seed()
        self.assertFalse(result2)
        self.assertEqual(len(spy.push_calls), push_count)

    def test_p6_remote_staging_and_ownership_rotated(self):
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed)
        spy = _RekeyTransportSpy()
        cmd = self._cmd(data_dir, identity_secret, pdk, transport=spy)
        new_seed_b64 = cmd.renew_seed()
        self.assertTrue(new_seed_b64)

        paths = spy.paths()
        self.assertIn("staging/blob", paths)
        self.assertIn(REMOTE_COOKIE_PATH, paths)

        # Staging blob round-trips: obfuscated under the NEW MK, deobfuscates
        # cleanly on a second-device pull.
        mk_v2 = derive_mk(base64.b64decode(new_seed_b64), 2)
        rsync = RemoteStagingSync(CryptoManager(mk_v2, key_version=2), spy,
                                  device_id_provider=None, master_key=mk_v2)
        blob = rsync.pull(master_key=mk_v2)
        self.assertIsNotNone(blob)
        self.assertEqual(len(blob["entries"]), 2)  # staged_task_1 + staged_task_2

        # Leak nullification: pulling the staging blob under the OLD MK fails.
        rsync_old = RemoteStagingSync(CryptoManager(mk_v1, key_version=1), spy,
                                      device_id_provider=None, master_key=mk_v1)
        self.assertIs(rsync_old.pull(master_key=mk_v1), BLOB_KEY_MISMATCH)


# ══════════════════════════════════════════════════════════════════
# Group C: CLI command wiring
# ══════════════════════════════════════════════════════════════════

class TestRekeyCliWiring(unittest.TestCase):
    """C1–C6: CLI wiring tests."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_rekey_c_"))
        self.seed = os.urandom(32)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_c1_rekey_seed_subcommand_require_auth(self):
        import main as main_mod
        self.assertIn("rekey-seed", main_mod.REQUIRE_AUTH)
        r = subprocess.run([sys.executable, "main.py", "rekey-seed", "--help"],
                           capture_output=True, text=True, cwd=str(REPO_ROOT))
        self.assertEqual(r.returncode, 0)
        self.assertIn("rekey-seed", r.stdout)

    def test_c2_derive_pdk_two_secret(self):
        from main import _derive_rekey_pdk
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed, passphrase=TEST_PASSPHRASE)
        pub_key = genesis["identity"]["identity_pub_key"]
        derived = _derive_rekey_pdk(TEST_PASSPHRASE, pub_key)
        self.assertEqual(len(derived), 32)
        expected = hashlib.pbkdf2_hmac(
            "sha256", TEST_PASSPHRASE.encode(), derive_pdk_salt(pub_key),
            PassphraseAuthenticator.PBKDF2_ITERATIONS, 32)
        self.assertEqual(derived, expected)
        self.assertEqual(RecoveryManager.decrypt_seed(
            genesis["identity"]["recovery_seed_enc"], derived), seed_b64)

    def test_c3_wrong_passphrase_aborts_no_mutation(self):
        from main import _handle_rekey_seed
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed, passphrase=TEST_PASSPHRASE)
        auth = _AuthStub(self.seed)
        ledger = _LedgerStub(identity_secret)
        files = ["ledger.json", "staging.json", "index.json", "identity.json"]
        before = {f: (data_dir / f).read_text() for f in files}
        buf = io.StringIO()

        result = _handle_rekey_seed(auth, data_dir, ledger,
                                    passphrase="wrong-passphrase",
                                    acknowledge=lambda: True, out=buf)
        self.assertFalse(result)
        self.assertEqual(buf.getvalue(), "")
        after = {f: (data_dir / f).read_text() for f in files}
        self.assertEqual(before, after)

    def test_c4_seed_printed_once(self):
        from main import _handle_rekey_seed
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed, passphrase=TEST_PASSPHRASE)
        auth = _AuthStub(self.seed)
        ledger = _LedgerStub(identity_secret)
        buf = io.StringIO()

        result = _handle_rekey_seed(auth, data_dir, ledger,
                                    passphrase=TEST_PASSPHRASE,
                                    acknowledge=lambda: True, out=buf)
        self.assertTrue(result)

        chain_after = json.loads((data_dir / "ledger.json").read_text())
        pub_key = chain_after[0]["identity"]["identity_pub_key"]
        pdk2 = hashlib.pbkdf2_hmac(
            "sha256", TEST_PASSPHRASE.encode(), derive_pdk_salt(pub_key),
            PassphraseAuthenticator.PBKDF2_ITERATIONS, 32)
        new_seed_b64 = RecoveryManager.decrypt_seed(
            chain_after[0]["identity"]["recovery_seed_enc"], pdk2)
        self.assertEqual(buf.getvalue().count(new_seed_b64), 1)

    def test_c5_rotate_keys_renew_seed_flag(self):
        r = subprocess.run([sys.executable, "main.py", "rotate-keys",
                            "--renew-seed", "--help"],
                           capture_output=True, text=True, cwd=str(REPO_ROOT))
        self.assertEqual(r.returncode, 0)
        self.assertIn("--renew-seed", r.stdout)

    def test_c6_rerun_refused_when_marker_exists(self):
        from main import _handle_rekey_seed
        data_dir, genesis, identity_secret, crypto_v1, mk_v1, seed_b64, pdk = \
            _setup_test_ledger(self.tmpdir, self.seed, passphrase=TEST_PASSPHRASE)
        auth = _AuthStub(self.seed)
        ledger = _LedgerStub(identity_secret)
        buf1 = io.StringIO()
        self.assertTrue(_handle_rekey_seed(auth, data_dir, ledger,
                                           passphrase=TEST_PASSPHRASE,
                                           acknowledge=lambda: True, out=buf1))
        chain_after_first = (data_dir / "ledger.json").read_text()

        chain = json.loads(chain_after_first)
        pub_key = chain[0]["identity"]["identity_pub_key"]
        pdk2 = hashlib.pbkdf2_hmac(
            "sha256", TEST_PASSPHRASE.encode(), derive_pdk_salt(pub_key),
            PassphraseAuthenticator.PBKDF2_ITERATIONS, 32)
        new_seed_b64 = RecoveryManager.decrypt_seed(
            chain[0]["identity"]["recovery_seed_enc"], pdk2)
        auth2 = _AuthStub(base64.b64decode(new_seed_b64))
        buf2 = io.StringIO()
        result2 = _handle_rekey_seed(auth2, data_dir, ledger,
                                     passphrase=TEST_PASSPHRASE,
                                     acknowledge=lambda: True, out=buf2)
        self.assertFalse(result2)
        self.assertEqual(buf2.getvalue(), "")
        self.assertEqual(chain_after_first, (data_dir / "ledger.json").read_text())


if __name__ == "__main__":
    unittest.main()
