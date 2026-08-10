"""CCS-4 Cross-Client live Worker round-trips — Group E (Phase 2 RED).

Proves the Web (JS) engine can read a CLI-written canonical blob from the
live test Worker byte-faithfully, re-obfuscate identically, and merge to the
same result — the Web↔CLI interoperability gate of CCS-4.

The JS side is driven through the pure-Node port of the blob-obfuscation
protocol in `phpoc-web/test/ccs4_cross_client.mjs` (`deobfuscate` /
`obfuscateDeterministic`), which is verified byte-identical to the Python
`RemoteStagingSync._obfuscate_core` / `_deobfuscate`. This avoids a WASM
dependency in the parity harness while exercising the exact protocol bytes.

Blueprint: docs/planning/CCS4_PHASE1.md (Group E)
Phase-2 reconciliation: docs/planning/CCS4_PHASE2.md

Run gracefully offline by skipping when no Worker API key is configured::
    PYTHONPATH=. python3 -m pytest tests/test_ccs4_live_worker.py -v --timeout 180
"""

import base64
import hashlib
import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List

import unittest

from domain.staging.remote_sync import RemoteStagingSync
from domain.staging.merge_engine import MergeEngine
from core.staging_hash_index import StagingHashIndex
from core.sync.http_transport import HttpStagingTransport
from security.crypto import CryptoManager

WORKER_URL = "https://phpoc-staging-testing.wacevedo.workers.dev"
_REPO_ROOT = Path(__file__).resolve().parent.parent
_NODE_HELPER = _REPO_ROOT / "phpoc-web" / "test" / "ccs4_cross_client.mjs"


def _read_testing_api_key():
    key = os.environ.get("PHPOC_TEST_WORKER_KEY", "")
    if key:
        return key
    creds = _REPO_ROOT / "TEST_CREDENTIALS.md"
    if creds.exists():
        text = creds.read_text()
        for line in text.splitlines():
            m = re.match(r'\|\s*Worker Secret API Token\s*\|\s*`([^`]+)`\s*\|', line)
            if m:
                return m.group(1)
    return ""


API_KEY = _read_testing_api_key()

# Test master key — 32 bytes (base64-seeded). Stable within a run for the
# byte-exact obfuscation parity checks. Separate from the blob random keys.
TEST_MASTER_KEY = hashlib.sha256(b"ccs4-cross-client-e2e-master-2026").digest()

# Isolate test data on the Worker.
TEST_PREFIX = f"_ccs4_{int(time.time())}_{uuid.uuid4().hex[:8]}/"
BLOB_PATH = f"{TEST_PREFIX}staging/blobs/current.json"


def _node(op: str, **kwargs) -> Any:
    req = json.dumps({"op": op, **kwargs})
    proc = subprocess.run(
        ["node", str(_NODE_HELPER)],
        input=req, capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        raise AssertionError(f"node helper failed (op={op}): {proc.stderr.strip()}")
    resp = json.loads(proc.stdout)
    if not resp.get("ok"):
        raise AssertionError(f"node op {op} error: {resp.get('error')}")
    return resp["result"]


def _row(activity_id, status, activity_json, updated_at, committed=False):
    return {
        "activity_id": activity_id,
        "activity_status": status,
        "activity": activity_json,
        "updated_at": updated_at,
        "committed": committed,
    }


def _obfuscate_py(plaintext: bytes, salt: bytes, nonce: bytes) -> bytes:
    """Deterministic obfuscation via the Python engine (explicit salt/nonce)."""
    return RemoteStagingSync._obfuscate_deterministic(plaintext, TEST_MASTER_KEY, salt, nonce)


def _canonical_blob_bytes(entries: List[Dict]) -> bytes:
    blob = {"device_id": "ccs4-cli-device", "device_proof": "", "entries": entries}
    return json.dumps(blob, separators=(",", ":")).encode("utf-8")


@unittest.skipUnless(API_KEY, "no Worker API key configured (offline)")
class TestCrossClientLiveWorker(unittest.TestCase):
    """E-group live Worker round-trips. Skip when offline (no API key)."""

    def setUp(self):
        self.transport = HttpStagingTransport(base_url=WORKER_URL, api_key=API_KEY)

    def tearDown(self):
        # Best-effort cleanup of the test blob.
        try:
            import http.client
            from urllib.parse import urlparse
            parsed = urlparse(WORKER_URL)
            conn = http.client.HTTPSConnection(parsed.hostname, timeout=10)
            conn.request("DELETE", f"{parsed.path}/{BLOB_PATH}",
                         headers={"X-Api-Key": API_KEY})
            conn.getresponse().read()
            conn.close()
        except Exception:
            pass

    # ── E1: Web reads a CLI-written canonical blob ─────────────────────────

    def test_e1_web_pull_reads_cli_canonical_blob(self):
        """E1: CLI pushes canonical blob → JS de-obfuscates to same rows."""
        entries = [
            _row("xdev-1", "active", json.dumps({"title": "Working"}, separators=(",", ":")), 1000),
            _row("xdev-2", "ended", json.dumps({"title": "Done"}, separators=(",", ":")), 2000),
        ]
        plain = _canonical_blob_bytes(entries)
        salt = bytes(range(16))
        nonce = bytes(range(8))
        obf = _obfuscate_py(plain, salt, nonce)
        self.transport.push(BLOB_PATH, obf)

        # Web (JS) pulls the raw bytes and de-obfuscates.
        raw = self.transport.pull(BLOB_PATH)
        self.assertIsNotNone(raw, "blob should exist on Worker")
        js = _node("deobfuscate",
                   blobB64=base64.b64encode(raw).decode(),
                   mkB64=base64.b64encode(TEST_MASTER_KEY).decode())
        self.assertTrue(js["ok"], "JS deobfuscation should succeed")
        pulled_entries = js["parsed"]["entries"]
        self.assertEqual(pulled_entries, entries,
                         "JS must read the CLI-written canonical rows byte-faithfully")

    # ── E2: byte-identical obfuscation (Python ↔ JS, same MK/salt/nonce) ──

    def test_e2_byte_identical_obfuscation(self):
        """E2: same plaintext+MK+salt+nonce → byte-identical ciphertext."""
        entries = [_row("x", "active", json.dumps({"t": 1}, separators=(",", ":")), 7)]
        plain = _canonical_blob_bytes(entries)
        salt = bytes(range(16, 32))
        nonce = bytes(range(8))

        py_obf = _obfuscate_py(plain, salt, nonce)
        js = _node("obfuscateDeterministic",
                   plainB64=base64.b64encode(plain).decode(),
                   mkB64=base64.b64encode(TEST_MASTER_KEY).decode(),
                   saltHex=salt.hex(), nonceHex=nonce.hex())
        js_obf = base64.b64decode(js["blobB64"])
        self.assertEqual(py_obf, js_obf,
                         "E2: Python and JS obfuscation must be byte-identical")

    # ── E3: JS merge over real pulled data equals Python merge ────────────

    def test_e3_merge_parity_on_pulled_data(self):
        """E3: JS mergeRows(CLI-pulled + local) == CLI merge_rows."""
        remote_entries = [
            _row("r-a", "active", "{}", 10),
            _row("r-b", "paused", "{}", 20),
        ]
        local_rows = [
            _row("r-a", "active", "{}", 50),  # same id, local newer
            _row("l-a", "ended", "{}", 5),
        ]
        # canonical sort/disjoint scenario
        py = MergeEngine().merge_rows(local_rows, remote_entries)
        js = _node("mergeRows", local=local_rows, remote=remote_entries)
        # NOTE: full list equality with JS sort divergence (C6) is handled in
        # the A–D suite; here we assert the merged SET of activity_ids agrees,
        # which holds even though JS output ordering may differ pre-fix.
        self.assertEqual({r["activity_id"] for r in py}, {r["activity_id"] for r in js},
                         "E3: merged activity_id set must match cross-client")

    # ── E4: push merged blob via JS, pull via CLI → byte-identical ─────────

    def test_e4_js_push_cli_pull_roundtrip(self):
        """E4: JS obfuscates merged blob → CLI de-obfuscates identical rows."""
        merged = [
            _row("m-1", "active", "{}", 1),
            _row("m-2", "ended", "{}", 2),
        ]
        plain = _canonical_blob_bytes(merged)
        salt = bytes(range(1, 17))
        nonce = bytes(range(6, 14))
        # JS side obfuscates and pushes.
        js = _node("obfuscateDeterministic",
                   plainB64=base64.b64encode(plain).decode(),
                   mkB64=base64.b64encode(TEST_MASTER_KEY).decode(),
                   saltHex=salt.hex(), nonceHex=nonce.hex())
        self.transport.push(BLOB_PATH, base64.b64decode(js["blobB64"]))

        # CLI pulls and de-obfuscates.
        raw = self.transport.pull(BLOB_PATH)
        self.assertIsNotNone(raw)
        dec = RemoteStagingSync._deobfuscate(raw, TEST_MASTER_KEY)
        self.assertIsNotNone(dec, "CLI should de-obfuscate the JS-pushed blob")
        blob = json.loads(dec.decode("utf-8"))
        self.assertEqual(blob["entries"], merged,
                         "E4: CLI round-trip must preserve the JS-written rows")

    # ── E5: committed cleanup across clients ──────────────────────────────

    def test_e5_committed_cleanup_cross_client(self):
        """E5: committed-exclusion removes local-only committed rows in both."""
        local = [_row("stay", "active", "{}", 10)]
        remote = [_row("drop", "paused", "{}", 20, committed=True)]  # local-only committed
        py = MergeEngine().merge_rows(local, remote)
        js = _node("mergeRows", local=local, remote=remote)
        py_ids = {r["activity_id"] for r in py}
        js_ids = {r["activity_id"] for r in js}
        self.assertEqual(py_ids, js_ids, "E5: committed cleanup must agree")


if __name__ == "__main__":
    unittest.main()
