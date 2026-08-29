"""C-2 Cross-Client Seed Re-key — live R2 E2E (Phase 3 deferred acceptance).

Proves the real R2 seam for C-2: pull the real test ledger (31 blocks / 146
entries) from the live test Worker under OLD_MK, re-key it through the REAL
WASM `RekeyService` (Web client), push the re-keyed chain back to an isolated
R2 prefix obfuscated under NEW_MK, pull it back, verify under NEW_MK, and
assert the OLD MK is fully nullified (old-seed device fails).

The WASM-only operations (re-key + verify) are driven through the Node helper
`phpoc-web/test/c2_live_rekey.mjs` over stdin/stdout (mirrors the CCS-4
live-worker pattern). Python drives the R2 pull/push (production blob
obfuscation), which is byte-identical cross-client (proven by CCS-4).

The re-keyed live wire is written to `testdata/c2_web_rekeyed_live_wire.json`
for the Flutter verifier leg (`c2_cross_client_verify_test.dart` Group L).

Blueprint: docs/planning/C2_CROSS_CLIENT_VERIFY_PHASE1.md (live R2 E2E)
Run gracefully offline by skipping when no Worker API key is configured::
    PYTHONPATH=. python3 -m pytest tests/test_c2_live_r2.py -v --timeout 300
"""

import base64
import json
import os
import re
import subprocess
import time
import uuid
import unittest
from pathlib import Path

from domain.ledger.remote_sync import RemoteLedgerSync
from domain.ledger.helpers import get_block_hash
from core.sync.http_transport import HttpStagingTransport

WORKER_URL = "https://phpoc-staging-testing.wacevedo.workers.dev"
_REPO_ROOT = Path(__file__).resolve().parent.parent
_NODE_HELPER = _REPO_ROOT / "phpoc-web" / "test" / "c2_live_rekey.mjs"
_LIVE_WIRE = _REPO_ROOT / "testdata" / "c2_web_rekeyed_live_wire.json"

# Real test-ledger key set (from TEST_CREDENTIALS.md — test ledger, not the
# gitignored personal ledger).
SEED = "RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0="
OLD_PASSPHRASE = "123456789"

# New key set — byte-identical to the Flutter harness constants so the live
# re-keyed wire is directly verifiable by the existing Flutter verifier.
ALT_SEED = "ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE="  # 32×0x21
NEW_PASSPHRASE = "NewCorrectHorseBatteryStaple99!"
PBKDF2_ITERATIONS = 600000
FORMAT_VERSION = "0.4.0"

# Genesis seal of the real test ledger (from TEST_CREDENTIALS.md).
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


def _node(op, **kwargs):
    req = json.dumps({"op": op, "args": kwargs})
    proc = subprocess.run(
        ["node", str(_NODE_HELPER)],
        input=req, capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        raise AssertionError(f"node helper failed (op={op}): {proc.stderr.strip()}")
    resp = json.loads(proc.stdout)
    if not resp.get("ok"):
        raise AssertionError(f"node op {op} error: {resp.get('error')}")
    return resp["result"]


@unittest.skipUnless(API_KEY, "no Worker API key configured (offline)")
class TestC2LiveR2(unittest.TestCase):
    """C-2 live R2 re-key round-trip. Skip when offline (no API key)."""

    def setUp(self):
        self.transport = HttpStagingTransport(base_url=WORKER_URL, api_key=API_KEY)
        self.old_mk = base64.b64decode(SEED)
        self.new_mk = base64.b64decode(ALT_SEED)
        ts = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"
        self.blocks_prefix = f"ledger/_c2_live_{ts}/blocks/"
        self.index_path = f"ledger/_c2_live_{ts}/index.json"

    def tearDown(self):
        # Best-effort cleanup of the isolated prefix.
        try:
            for fname in self.transport.list_files(self.blocks_prefix):
                self.transport.delete(self.blocks_prefix + fname)
            self.transport.delete(self.index_path)
        except Exception:
            pass

    def test_live_r2_rekey_roundtrip(self):
        # 1. Pull the real test ledger under OLD_MK.
        old_sync = RemoteLedgerSync(self.transport, self.old_mk)
        blocks = old_sync.pull_full_chain()
        self.assertEqual(len(blocks), EXPECTED_BLOCK_COUNT,
                         "real test ledger must have 31 blocks")
        self.assertEqual(blocks[0].get("type"), "genesis")
        self.assertEqual(get_block_hash(blocks[0]), EXPECTED_GENESIS,
                         "pulled genesis must match the committed test ledger")

        # Sanity: the canonical (plaintext) hash index matches the pulled chain.
        hi = old_sync.pull_hash_index()
        if hi is not None:
            self.assertEqual(hi["hashes"], [get_block_hash(b) for b in blocks],
                             "canonical hash_index must match the pulled chain")

        # 2. Re-key through the REAL WASM RekeyService (Web client).
        out = _node(
            "rekey",
            blocks=blocks,
            oldSeed=SEED,
            oldPassphrase=OLD_PASSPHRASE,
            newPassphrase=NEW_PASSPHRASE,
            newSeed=ALT_SEED,
        )
        rekeyed = out["blocks"]
        self.assertEqual(len(rekeyed), EXPECTED_BLOCK_COUNT)
        self.assertEqual(out["newSeed"], ALT_SEED)
        self.assertEqual(out["newMasterKey"], self.new_mk.hex(),
                         "new MK must be the raw ALT_SEED bytes")

        # 3. Push the re-keyed chain to an isolated R2 prefix under NEW_MK.
        new_sync = RemoteLedgerSync(
            self.transport, self.new_mk,
            blocks_prefix=self.blocks_prefix, index_path=self.index_path,
        )
        pushed = new_sync.push_blocks(rekeyed)
        self.assertEqual(pushed, EXPECTED_BLOCK_COUNT,
                         "all re-keyed blocks must push to the isolated prefix")

        # 4. Pull back under NEW_MK and assert the round-trip is lossless.
        pulled_back = new_sync.pull_full_chain()
        self.assertEqual(len(pulled_back), EXPECTED_BLOCK_COUNT)
        self.assertEqual(
            [get_block_hash(b) for b in pulled_back],
            [get_block_hash(b) for b in rekeyed],
            "push/pull round-trip must be byte-lossless",
        )

        # 5. Verify under NEW_MK + assert OLD-MK nullification (WASM).
        ver = _node(
            "verify",
            blocks=pulled_back,
            mk=self.new_mk.hex(),
            oldMk=self.old_mk.hex(),
        )
        self.assertTrue(ver["ok"], "re-keyed chain must verify under NEW_MK")
        self.assertTrue(ver["leakNullified"],
                        "OLD MK must no longer decrypt any _enc field")
        self.assertGreater(ver["encFields"], 0, "must inspect real ciphertext fields")

        # 6. Old-seed device fails: de-obfuscating the NEW-MK-obfuscated blocks
        #    under OLD_MK must fail (HMAC tag mismatch → ValueError).
        old_sync_iso = RemoteLedgerSync(
            self.transport, self.old_mk,
            blocks_prefix=self.blocks_prefix, index_path=self.index_path,
        )
        with self.assertRaises(ValueError):
            old_sync_iso.pull_full_chain()

        # 7. Emit the live re-keyed wire for the Flutter verifier leg.
        envelope = {
            "version": 1,
            "generator": "web-live-r2",
            "note": "Live R2 re-key round-trip output (real test ledger, 31 blocks). "
                    "Re-keyed by the WASM RekeyService under ALT_SEED; verified under "
                    "NEW_MK; OLD MK nullified.",
            "old_seed": SEED,
            "old_mk": self.old_mk.hex(),
            "old_passphrase": OLD_PASSPHRASE,
            "new_seed": ALT_SEED,
            "new_mk": self.new_mk.hex(),
            "new_passphrase": NEW_PASSPHRASE,
            "pdk_iterations": PBKDF2_ITERATIONS,
            "format_version": FORMAT_VERSION,
            "block_count": len(rekeyed),
            "blocks": rekeyed,
        }
        _LIVE_WIRE.write_text(json.dumps(envelope, indent=2) + "\n")


if __name__ == "__main__":
    unittest.main()
