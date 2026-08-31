"""C-2 CLI↔Client Cross-Client Verification — live R2 E2E (Phase 3 acceptance).

Authoritative live round-trip proving the CLI re-keyer is byte-compatible
with the Web/Flutter clients against the real test ledger on the live R2
Worker (creds in TEST_CREDENTIALS.md — never inline).

Forward leg (CLI → Web):
  1. Pull the real test ledger (31 blocks / 146 entries) under OLD_MK via the
     real `HttpStagingTransport` (production blob obfuscation).
  2. Re-key it through the REAL CLI `RotateKeysCommand.renew_seed()` against a
     temp data_dir (raw-seed MK, option (a) — no key_version bump).
  3. Push the re-keyed chain to an isolated R2 prefix obfuscated under NEW_MK.
  4. Pull back under NEW_MK; verify with Python `LedgerChain.verify()`.
  5. Drive the Web WASM verify (`node c2_cli_rekey_verify.mjs verify`) + assert
     OLD-MK nullification.
  6. Emit `testdata/c2_cli_rekeyed_live_wire.json` for the Flutter Group L
     verifier.

Reverse leg (Web → CLI):
  The Web WASM re-key (`node c2_live_rekey.mjs rekey`) re-keys the real
  ledger; the CLI verifies the re-keyed wire under the new MK via Python
  `LedgerChain.verify()`, and asserts old-seed pull/verify failure.

Skips gracefully offline (no Worker API key). In Phase 2 the forward leg is
RED-by-design on the raw-seed gate (R2) — `renew_seed()` returns None — which
is exactly the divergence Phase 3 resolves.

Blueprint: docs/planning/C2_CLI_CLIENT_VERIFY_PHASE1.md (Groups A–D, live R2)
Run: PYTHONPATH=. python3 -m pytest tests/test_c2_cli_client_live_r2.py -v
"""

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from security.crypto import CryptoManager
from domain.ledger.chain import LedgerChain
from domain.ledger.helpers import get_block_hash
from domain.ledger.remote_sync import RemoteLedgerSync
from core.sync.http_transport import HttpStagingTransport
from storage.implementations.file_ledger import FileLedgerStore
from domain.cookie.device_cookie import DeviceCookie

from phpoc_cli.rotate_keys import RotateKeysCommand

WORKER_URL = "https://phpoc-staging-testing.wacevedo.workers.dev"
_REPO_ROOT = Path(__file__).resolve().parent.parent
_CLI_VERIFY_HELPER = _REPO_ROOT / "phpoc-web" / "test" / "c2_cli_rekey_verify.mjs"
_WEB_REKEY_HELPER = _REPO_ROOT / "phpoc-web" / "test" / "c2_live_rekey.mjs"
_LIVE_WIRE = _REPO_ROOT / "testdata" / "c2_cli_rekeyed_live_wire.json"

# Real test-ledger key set (TEST_CREDENTIALS.md — test ledger, not personal).
SEED = "RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0="
OLD_PASSPHRASE = "123456789"
PBKDF2_ITERATIONS = 600000
FORMAT_VERSION = "0.4.0"

# Fixed live-test PDK (deterministic; shape-only, not a secret).
FIXED_PDK = hashlib.sha256(b"phpoc:test:pdk:live").digest()

EXPECTED_GENESIS = "e718daf3ea681830b464207f4ddfe28594c4d6540e2a80dceec9fcf83bd4458b"
EXPECTED_BLOCK_COUNT = 31


def _read_testing_api_key():
    key = os.environ.get("PHPOC_TEST_WORKER_KEY", "")
    if key:
        return key
    creds = _REPO_ROOT / "TEST_CREDENTIALS.md"
    if creds.exists():
        for line in creds.read_text().splitlines():
            m = re.match(r'\|\s*Worker Secret API Token\s*\|\s*`([^`]+)`\s*\|', line)
            if m:
                return m.group(1)
    return ""


API_KEY = _read_testing_api_key()


def _node(helper, op, **kwargs):
    req = json.dumps({"op": op, "args": kwargs})
    proc = subprocess.run(
        ["node", str(helper)],
        input=req, capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        raise AssertionError(f"node helper failed (op={op}): {proc.stderr.strip()}")
    resp = json.loads(proc.stdout)
    if not resp.get("ok"):
        raise AssertionError(f"node op {op} error: {resp.get('error')}")
    return resp["result"]


def _recover_identity_secret(genesis, mk):
    crypto = CryptoManager(mk, key_version=0)
    return bytes.fromhex(crypto.decrypt(
        genesis["identity"]["identity_secret_enc_fallback"]))


@unittest.skipUnless(API_KEY, "no Worker API key configured (offline)")
class TestC2CliClientLiveR2(unittest.TestCase):
    """C-2 CLI↔client live R2 re-key round-trip. Skip when offline."""

    def setUp(self):
        self.transport = HttpStagingTransport(base_url=WORKER_URL, api_key=API_KEY)
        self.old_mk = base64.b64decode(SEED)
        ts = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"
        self.prefix = f"ledger/_c2_cli_live_{ts}"
        self.blocks_prefix = f"{self.prefix}/blocks/"
        self.index_path = f"{self.prefix}/index.json"

    def tearDown(self):
        try:
            for fname in self.transport.list_files(self.blocks_prefix):
                self.transport.delete(self.blocks_prefix + fname)
            self.transport.delete(self.index_path)
        except Exception:
            pass

    def _pull_real_ledger(self):
        sync = RemoteLedgerSync(self.transport, self.old_mk)
        blocks = sync.pull_full_chain()
        self.assertEqual(len(blocks), EXPECTED_BLOCK_COUNT)
        self.assertEqual(get_block_hash(blocks[0]), EXPECTED_GENESIS)
        return blocks

    def test_forward_cli_rekeys_web_verifies(self):
        # 1. Pull the real test ledger under OLD_MK.
        blocks = self._pull_real_ledger()

        # 2. Re-key through the REAL CLI re-keyer (raw-seed MK, option (a)).
        tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_c2_cli_live_"))
        try:
            data_dir = tmpdir / "phpoc"
            data_dir.mkdir(parents=True, exist_ok=True)
            (data_dir / "ledger.json").write_text(json.dumps(blocks, indent=2))
            identity_secret = _recover_identity_secret(blocks[0], self.old_mk)
            crypto_v0 = CryptoManager(self.old_mk, key_version=0)
            (data_dir / "identity.json").write_text(json.dumps({
                "identity_secret_enc": crypto_v0.encrypt(identity_secret.hex()),
            }, indent=2))
            DeviceCookie.create("cli-live-uuid", data_dir)

            # transport=None: `renew_seed()` would otherwise push the
            # re-keyed chain to the canonical `ledger/blocks/` prefix
            # (`_push_rekeyed_state` → `RemoteLedgerSync.push_blocks(force=True)`),
            # overwriting the shared live test ledger under NEW_MK and corrupting
            # the reverse leg's OLD-MK pull. This test pushes the re-keyed chain
            # to an isolated prefix itself (step 3).
            cmd = RotateKeysCommand(
                data_dir=data_dir, seed=self.old_mk,
                identity_secret=identity_secret, pdk=FIXED_PDK,
                transport=None,
            )
            new_seed_b64 = cmd.renew_seed()
            self.assertIsNotNone(
                new_seed_b64,
                "R2: renew_seed() returned None on the raw-seed live ledger "
                "(Phase 3 fixes _get_current_key_version default-0 / raw-seed MK)",
            )
            new_mk = base64.b64decode(new_seed_b64)
            rekeyed = json.loads((data_dir / "ledger.json").read_text())
            self.assertEqual(len(rekeyed), EXPECTED_BLOCK_COUNT)

            # 3. Push the re-keyed chain to an isolated prefix under NEW_MK.
            new_sync = RemoteLedgerSync(
                self.transport, new_mk,
                blocks_prefix=self.blocks_prefix, index_path=self.index_path,
            )
            self.assertEqual(new_sync.push_blocks(rekeyed, force=True),
                             EXPECTED_BLOCK_COUNT)

            # 4. Pull back + verify under NEW_MK (Python).
            pulled = new_sync.pull_full_chain()
            self.assertEqual(len(pulled), EXPECTED_BLOCK_COUNT)
            store = FileLedgerStore(data_dir / "ledger.json")
            self.assertTrue(LedgerChain(
                CryptoManager(new_mk, key_version=0), store,
                identity_secret=identity_secret).verify())

            # 5. Web WASM verify + OLD-MK nullification.
            ver = _node(
                _CLI_VERIFY_HELPER, "verify",
                blocks=pulled, mk=new_mk.hex(), oldMk=self.old_mk.hex(),
            )
            self.assertTrue(ver["ok"], "re-keyed chain must verify on Web under NEW_MK")
            self.assertTrue(ver["leakNullified"], "OLD MK must not decrypt any _enc")
            self.assertGreater(ver["encFields"], 0)

            # 6. Old-seed device fails to pull (HMAC tag mismatch).
            old_sync = RemoteLedgerSync(
                self.transport, self.old_mk,
                blocks_prefix=self.blocks_prefix, index_path=self.index_path,
            )
            with self.assertRaises(ValueError):
                old_sync.pull_full_chain()

            # 7. Emit the live re-keyed wire for the Flutter Group L verifier.
            _LIVE_WIRE.write_text(json.dumps({
                "version": 1,
                "generator": "cli-live-r2",
                "note": "Live R2 CLI re-key round-trip (real test ledger, 31 "
                        "blocks). Raw-seed MK (option a); OLD MK nullified.",
                "old_seed": SEED,
                "old_mk": self.old_mk.hex(),
                "new_seed": new_seed_b64,
                "new_mk": new_mk.hex(),
                "identity_pub_key": rekeyed[0]["identity"]["identity_pub_key"],
                "block_count": len(rekeyed),
                "blocks": rekeyed,
            }, indent=2) + "\n")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_reverse_web_rekeys_cli_verifies(self):
        # 1. Pull the real test ledger under OLD_MK.
        blocks = self._pull_real_ledger()

        # 2. Re-key through the REAL WASM RekeyService (Web client).
        out = _node(
            _WEB_REKEY_HELPER, "rekey",
            blocks=blocks,
            oldSeed=SEED,
            oldPassphrase=OLD_PASSPHRASE,
            newPassphrase="NewCorrectHorseBatteryStaple99!",
            newSeed=("ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE="),
        )
        rekeyed = out["blocks"]
        new_mk = base64.b64decode(out["newSeed"])
        self.assertEqual(out["newMasterKey"], new_mk.hex())

        # 3. CLI verifies the web-rekeyed wire under the new MK.
        tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_c2_cli_live_rev_"))
        try:
            path = tmpdir / "ledger.json"
            path.write_text(json.dumps(rekeyed, indent=2))
            identity_secret = _recover_identity_secret(rekeyed[0], new_mk)
            self.assertTrue(LedgerChain(
                CryptoManager(new_mk, key_version=0),
                FileLedgerStore(path),
                identity_secret=identity_secret).verify(),
                "CLI must verify the web-rekeyed chain under the raw new MK")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
