"""C-2 CLI↔Client Cross-Client Verification — Phase 2 RED: test definition.

Blueprint: ``docs/planning/C2_CLI_CLIENT_VERIFY_PHASE1.md`` — 48 assertions.

  Group A — CLI re-keyer → Web verifier    (A1–A12)
  Group B — CLI re-keyer → Flutter verifier (B1–B12)
  Group C — client re-keyer → CLI verifier  (C1–C8)
  Group D — CLI↔client crypto invariants    (D1–D8)
  Group E — docs (Phase 4)

Groups A–D are expected to FAIL (RED) until Phase 3 resolves the
MK-derivation divergence (decision already made: **option (a) raw-seed
re-key**). The RED causes:

  R1 — the CLI re-key bumps ``key_version`` (``new_version = current+1``,
       MK = ``derive_mk(new_seed, v+1)`` = HMAC), while Web/Flutter keep
       ``key_version`` unchanged and use the raw new seed as MK.
  R2 — ``_get_current_key_version`` defaults to ``1`` for a raw-seed
       (no ``key_version``) ledger, so ``_verify_seed`` derives
       ``derive_mk(seed, 1)`` = HMAC and fails to decrypt
       ``identity_secret_enc_fallback`` (encrypted under the raw seed).
       ``renew_seed()`` therefore returns ``None`` — it cannot even start.
  R4/R5 — "key_version=1" means different MKs cross-client (Python derives
       HMAC, Flutter uses raw seed); the CLI's multi-version lookup starts
       at v=1 and never covers the raw-seed (v=0) chain.

Verifier legs (A7–A12 / B7–B12) additionally fail "artifact absent" until
the CLI re-keyer emits ``testdata/c2_cli_rekeyed_wire.json``.

Hermetic: the CLI re-keyer runs against a copy of the canonical test ledger
(``testdata/ledger.json``, 31 blocks / 146 entries, genesis ``e718daf3…``)
via a spy transport (precedent ``test_rekey_seed.py`` P1–P6). Web verify is
driven through ``node phpoc-web/test/c2_cli_rekey_verify.mjs`` over
stdin/stdout. Flutter verify is a separate Dart test
(``phpoc-flutter/test/services/c2_cli_verify_test.dart`` Group L) consuming
the same artifact. Live R2 is ``tests/test_c2_cli_client_live_r2.py``.
"""

import base64
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from security.crypto import CryptoManager, derive_mk
from security.recovery import RecoveryManager
from domain.ledger.chain import LedgerChain, compute_seal, select_seal_fields
from domain.ledger.helpers import get_block_hash
from domain.ledger.index_manager import IndexManager
from domain.ledger.remote_sync import RemoteLedgerSync
from domain.staging.remote_sync import REMOTE_COOKIE_PATH
from domain.cookie.device_cookie import DeviceCookie
from storage.implementations.file_ledger import FileLedgerStore
from storage.implementations.file_index import FileIndexStore

from phpoc_cli.rotate_keys import RotateKeysCommand

REPO_ROOT = Path(__file__).resolve().parent.parent

# Real test-ledger key set (from TEST_CREDENTIALS.md — shared test ledger,
# NOT the gitignored personal ledger). MK is the raw seed (key_version=0).
SEED_B64 = "RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0="
OLD_MK = base64.b64decode(SEED_B64)  # raw 32 bytes

REAL_LEDGER = REPO_ROOT / "testdata" / "ledger.json"
CLI_WIRE = REPO_ROOT / "testdata" / "c2_cli_rekeyed_wire.json"
WEB_WIRE = REPO_ROOT / "testdata" / "c2_web_rekeyed_wire.json"
FLUTTER_WIRE = REPO_ROOT / "testdata" / "c2_flutter_rekeyed_wire.json"
FIXTURE = REPO_ROOT / "testdata" / "c2_cross_client_fixture.json"
NODE_HELPER = REPO_ROOT / "phpoc-web" / "test" / "c2_cli_rekey_verify.mjs"

# Committed test-ledger invariants (TEST_CREDENTIALS.md).
EXPECTED_GENESIS = "e718daf3ea681830b464207f4ddfe28594c4d6540e2a80dceec9fcf83bd4458b"
EXPECTED_BLOCK_COUNT = 31
EXPECTED_ENTRY_COUNT = 146

# Deterministic 32-byte PDK for the hermetic re-key (shape-only fixture path,
# precedent `test_rekey_seed.py`). Not a secret.
FIXED_PDK = hashlib.sha256(b"phpoc:test:pdk").digest()

R2_REASON = ("R2: renew_seed() returned None — the raw-seed test ledger has no "
             "key_version field, so _get_current_key_version defaults to 1 and "
             "_verify_seed derives derive_mk(seed, 1)=HMAC instead of the raw seed")
R1_REASON = ("R1/R4/R5: the CLI re-key bumps key_version and derives a versioned "
             "HMAC MK, diverging from Web/Flutter raw-seed MK")


# ══════════════════════════════════════════════════════════════════
# Test helpers
# ══════════════════════════════════════════════════════════════════

class _RekeyTransportSpy:
    """Real-shape transport spy (AbstractStagingTransport: pull/push/list_files)."""

    def __init__(self):
        self.push_calls = []
        self.pull_calls = []
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


def _node(op, **kwargs):
    """Drive the Web WASM helper over stdin/stdout (one op per process)."""
    req = json.dumps({"op": op, "args": kwargs})
    proc = subprocess.run(
        ["node", str(NODE_HELPER)],
        input=req, capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        raise AssertionError(f"node helper failed (op={op}): {proc.stderr.strip()}")
    resp = json.loads(proc.stdout)
    if not resp.get("ok"):
        raise AssertionError(f"node op {op} error: {resp.get('error')}")
    return resp["result"]


def _recover_identity_secret(genesis, mk):
    """Recover the 32-byte identity secret from the genesis fallback under `mk`."""
    crypto = CryptoManager(mk, key_version=0)
    id_hex = crypto.decrypt(genesis["identity"]["identity_secret_enc_fallback"])
    return bytes.fromhex(id_hex)


def _entry_count(blocks):
    return sum(len(b["entries"]) for b in blocks if b.get("type") == "day")


def _content_hash_map(blocks):
    """{(block_idx, entry_idx): content_hash} for every day-block entry."""
    return {(i, j): e["data"].get("content_hash")
            for i, b in enumerate(blocks) if b.get("type") == "day"
            for j, e in enumerate(b["entries"])}


# ══════════════════════════════════════════════════════════════════
# Shared CLI re-key fixture (Groups A/B re-keyer side)
# ══════════════════════════════════════════════════════════════════

def _run_cli_rekey():
    """Run the CLI re-keyer once against a copy of the real test ledger.

    Returns a dict with the re-key result + fixture state. Cached at module
    level so Groups A and B share one re-key run.
    """
    tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_c2_cli_"))
    data_dir = tmpdir / "phpoc"
    data_dir.mkdir(parents=True, exist_ok=True)

    real_blocks = json.loads(REAL_LEDGER.read_text())
    (data_dir / "ledger.json").write_text(json.dumps(real_blocks, indent=2))
    genesis = real_blocks[0]

    # Recover identity secret from the raw-seed fallback (key-independent).
    identity_secret = _recover_identity_secret(genesis, OLD_MK)
    identity_pub_key = genesis["identity"]["identity_pub_key"]

    # identity.json alongside (blueprint §Hermetic).
    crypto_v0 = CryptoManager(OLD_MK, key_version=0)
    (data_dir / "identity.json").write_text(json.dumps({
        "identity_secret_enc": crypto_v0.encrypt(identity_secret.hex()),
    }, indent=2))

    # index.json from the day blocks (plaintext title/duration).
    index_mgr = IndexManager(FileIndexStore(data_dir / "index.json"), crypto_v0)
    for b in real_blocks:
        if b.get("type") != "day":
            continue
        for e in b.get("entries", []):
            data = e.get("data", {})
            if "title" in data and "duration" in data:
                index_mgr.update(b.get("date", "unknown"), data["title"], data["duration"])

    # Device cookie — the re-keyer rotates its specifier and pushes it (A12/B12).
    DeviceCookie.create("cli-test-uuid", data_dir)
    original_cookie = json.loads((data_dir / "device_cookie.bin").read_text())

    spy = _RekeyTransportSpy()
    cmd = RotateKeysCommand(
        data_dir=data_dir, seed=OLD_MK, identity_secret=identity_secret,
        pdk=FIXED_PDK, transport=spy,
    )
    new_seed_b64 = cmd.renew_seed()

    result = {
        "tmpdir": tmpdir,
        "data_dir": data_dir,
        "real_blocks": real_blocks,
        "genesis": genesis,
        "identity_secret": identity_secret,
        "identity_pub_key": identity_pub_key,
        "spy": spy,
        "original_cookie": original_cookie,
        "new_seed_b64": new_seed_b64,
        "rekeyed_blocks": None,
        "emitted_wire": False,
        "reason": None,
    }

    if new_seed_b64:
        new_mk = base64.b64decode(new_seed_b64)
        rekeyed_blocks = json.loads((data_dir / "ledger.json").read_text())
        result["new_mk"] = new_mk
        result["new_mk_hex"] = new_mk.hex()
        result["rekeyed_blocks"] = rekeyed_blocks
        result["emitted_wire"] = True

        # Emit the canonical wire artifact for the Web/Flutter verifier legs.
        artifact = {
            "version": 1,
            "rekeyer": "cli",
            "new_seed": new_seed_b64,
            "new_mk": new_mk.hex(),
            "old_seed": SEED_B64,
            "old_mk": OLD_MK.hex(),
            "identity_pub_key": identity_pub_key,
            "block_count": len(rekeyed_blocks),
            "entry_count": _entry_count(rekeyed_blocks),
            "blocks": rekeyed_blocks,
            "hash_index": [get_block_hash(b) for b in rekeyed_blocks],
        }
        CLI_WIRE.write_text(json.dumps(artifact, indent=2) + "\n")
    else:
        result["new_mk"] = None
        result["new_mk_hex"] = None
        result["reason"] = R2_REASON

    return result


_CLI_REKEY_RESULT = None


def _cli_rekey():
    global _CLI_REKEY_RESULT
    if _CLI_REKEY_RESULT is None:
        _CLI_REKEY_RESULT = _run_cli_rekey()
    return _CLI_REKEY_RESULT


def _teardown_cli_rekey():
    global _CLI_REKEY_RESULT
    if _CLI_REKEY_RESULT is not None:
        shutil.rmtree(_CLI_REKEY_RESULT["tmpdir"], ignore_errors=True)
        _CLI_REKEY_RESULT = None


# ══════════════════════════════════════════════════════════════════
# Group A/B — CLI re-keyer side (A1–A6, B1–B6)
# ══════════════════════════════════════════════════════════════════

class TestCliRekeyer(unittest.TestCase):
    """A1–A6 + B1–B6: CLI re-keyer side (Groups A & B share the re-keyer)."""

    @classmethod
    def setUpClass(cls):
        cls.r = _cli_rekey()

    @classmethod
    def tearDownClass(cls):
        _teardown_cli_rekey()

    # ── Precondition (guard-green) ─────────────────────────────────

    def test_a1_pulls_real_test_ledger_under_old_mk(self):
        # Exercises the CLI's actual remote ingest path under OLD MK.
        spy = _RekeyTransportSpy()
        RemoteLedgerSync(spy, OLD_MK).push_blocks(self.r["real_blocks"], force=True)
        pulled = RemoteLedgerSync(spy, OLD_MK).pull_full_chain()
        self.assertEqual(len(pulled), EXPECTED_BLOCK_COUNT)
        self.assertEqual(get_block_hash(pulled[0]), EXPECTED_GENESIS)
        self.assertEqual(_entry_count(pulled), EXPECTED_ENTRY_COUNT)

    # ── Re-keyer (RED) ─────────────────────────────────────────────

    def test_a2_renew_seed_mints_fresh_seed(self):
        self.assertIsNotNone(self.r["new_seed_b64"], self.r["reason"])
        new_seed = base64.b64decode(self.r["new_seed_b64"])
        self.assertEqual(len(new_seed), 32)
        self.assertNotEqual(self.r["new_seed_b64"], SEED_B64)

    def test_a3_genesis_seed_envelope_rewritten(self):
        self.assertIsNotNone(self.r["new_seed_b64"], self.r["reason"])
        genesis = self.r["rekeyed_blocks"][0]
        identity = genesis["identity"]
        self.assertEqual(RecoveryManager.decrypt_seed(
            identity["recovery_seed_enc"], FIXED_PDK), self.r["new_seed_b64"])
        self.assertEqual(identity["identity_pub_key"], self.r["identity_pub_key"])
        # fallback re-encrypted under the NEW MK.
        self.assertEqual(
            CryptoManager(self.r["new_mk"], key_version=0).decrypt(
                identity["identity_secret_enc_fallback"]),
            self.r["identity_secret"].hex())

    def test_a4_enc_reencrypted_and_content_hash_invariant(self):
        self.assertIsNotNone(self.r["new_seed_b64"], self.r["reason"])
        before = self.r["real_blocks"]
        after = self.r["rekeyed_blocks"]
        before_hashes = _content_hash_map(before)
        crypto_new = CryptoManager(self.r["new_mk"], key_version=0)
        for i, b in enumerate(after):
            if b.get("type") != "day":
                continue
            for j, e in enumerate(b["entries"]):
                data = e["data"]
                self.assertEqual(data.get("content_hash"), before_hashes[(i, j)])
                for k, v in data.items():
                    if k.endswith("_enc") and v:
                        crypto_new.decrypt(v)  # must not raise

    def test_a5_self_verify_valid_under_new_mk(self):
        self.assertIsNotNone(self.r["new_seed_b64"], self.r["reason"])
        crypto_new = CryptoManager(self.r["new_mk"], key_version=0)
        store = FileLedgerStore(self.r["data_dir"] / "ledger.json")
        self.assertTrue(LedgerChain(
            crypto_new, store, identity_secret=self.r["identity_secret"]).verify())

    def test_a6_emits_canonical_wire_and_remote_state(self):
        self.assertIsNotNone(self.r["new_seed_b64"], self.r["reason"])
        self.assertTrue(CLI_WIRE.exists(), "c2_cli_rekeyed_wire.json must be emitted")
        paths = self.r["spy"].paths()
        self.assertIn("ledger/blocks/000000.json", paths)
        self.assertIn("ledger/hash_index.json", paths)
        self.assertIn("ledger/index.json", paths)
        self.assertIn(REMOTE_COOKIE_PATH, paths)

    # ── B mirrors A (same CLI re-key, Flutter verifier leg) ────────

    def test_b1_pulls_real_test_ledger_under_old_mk(self):
        self.test_a1_pulls_real_test_ledger_under_old_mk()

    def test_b2_renew_seed_mints_fresh_seed(self):
        self.test_a2_renew_seed_mints_fresh_seed()

    def test_b3_genesis_seed_envelope_rewritten(self):
        self.test_a3_genesis_seed_envelope_rewritten()

    def test_b4_enc_reencrypted_and_content_hash_invariant(self):
        self.test_a4_enc_reencrypted_and_content_hash_invariant()

    def test_b5_self_verify_valid_under_new_mk(self):
        self.test_a5_self_verify_valid_under_new_mk()

    def test_b6_emits_canonical_wire_and_remote_state(self):
        self.test_a6_emits_canonical_wire_and_remote_state()


# ══════════════════════════════════════════════════════════════════
# Group A — Web verifier side (A7–A12)
# ══════════════════════════════════════════════════════════════════

class TestWebVerifier(unittest.TestCase):
    """A7–A12: Web verifier of the CLI-rekeyed wire (WASM, via Node helper)."""

    @classmethod
    def setUpClass(cls):
        cls.r = _cli_rekey()

    @classmethod
    def tearDownClass(cls):
        _teardown_cli_rekey()

    def _verify(self):
        """Run the WASM verify op; returns the result dict (envelope checked)."""
        blocks = self.r["rekeyed_blocks"]
        return _node(
            "verify",
            blocks=blocks,
            mk=self.r["new_mk_hex"],
            oldMk=OLD_MK.hex(),
        )

    def _require_wire(self):
        if not self.r["emitted_wire"]:
            self.fail("artifact absent — CLI re-keyer did not emit a wire: "
                      + (self.r["reason"] or ""))

    def test_a7_web_pulls_with_no_error(self):
        self._require_wire()
        ver = self._verify()
        self.assertEqual(ver["blockCount"], EXPECTED_BLOCK_COUNT)

    def test_a8_web_verify_valid_under_new_mk(self):
        self._require_wire()
        ver = self._verify()
        self.assertTrue(ver["ok"], R1_REASON)

    def test_a9_web_genesis_parity(self):
        self._require_wire()
        genesis = self.r["rekeyed_blocks"][0]
        identity = genesis.get("identity")
        self.assertIsInstance(identity, dict, "nested identity must be present")
        self.assertIn("recovery_seed_enc", identity)
        self.assertIn("identity_pub_key", identity)
        self.assertIn("identity_secret_enc_fallback", identity)
        self.assertEqual(identity["identity_pub_key"], self.r["identity_pub_key"])
        # Seal parity: Python recompute matches the wire seal.
        crypto_new = CryptoManager(self.r["new_mk"], key_version=0)
        self.assertEqual(genesis["block_hash"],
                         compute_seal(crypto_new, genesis))

    def test_a10_hash_index_and_index_parity(self):
        self._require_wire()
        hi = RemoteLedgerSync(self.r["spy"], self.r["new_mk"]).pull_hash_index()
        self.assertIsNotNone(hi)
        self.assertEqual(hi["hashes"],
                         [get_block_hash(b) for b in self.r["rekeyed_blocks"]])
        idx = RemoteLedgerSync(self.r["spy"], self.r["new_mk"]).pull_index()
        self.assertIsNotNone(idx)

    def test_a11_old_seed_cannot_decrypt(self):
        self._require_wire()
        ver = self._verify()
        self.assertGreater(ver["encFields"], 0, "must inspect real ciphertext")
        self.assertTrue(ver["leakNullified"],
                        "OLD MK must not decrypt any re-keyed _enc field")

    def test_a12_stale_device_cookie_specifier_rotated(self):
        self._require_wire()
        pushed_cookie = json.loads(self.r["spy"].get(REMOTE_COOKIE_PATH).decode())
        self.assertNotEqual(pushed_cookie["device_specifier"],
                            self.r["original_cookie"]["device_specifier"])


# ══════════════════════════════════════════════════════════════════
# Group C — CLI verifier of client-rekeyed chains (C1–C8)
# ══════════════════════════════════════════════════════════════════

def _load_client_wire(path):
    return json.loads(path.read_text())


def _seed_spy_with_wire(spy, blocks, mk):
    RemoteLedgerSync(spy, mk).push_blocks(blocks, force=True)


class TestCliVerifier(unittest.TestCase):
    """C1–C8: CLI as verifier of the Web/Flutter-rekeyed committed wires."""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp(prefix="phpoc_c2_cli_verify_"))
        self.web = _load_client_wire(WEB_WIRE)
        self.flutter = _load_client_wire(FLUTTER_WIRE)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_chain(self, blocks):
        path = self.tmpdir / "ledger.json"
        path.write_text(json.dumps(blocks, indent=2))
        return path

    def _identity_secret_for(self, blocks, mk):
        return _recover_identity_secret(blocks[0], mk)

    def _cli_gate_accepts(self, blocks, seed):
        """The CLI's ACTUAL accept path: versioned-first MK derivation + gate."""
        genesis = blocks[0]
        cmd = RotateKeysCommand(seed=seed)
        return cmd._verify_seed(genesis)

    # ── C1: reverse ingest (guard-green) ───────────────────────────

    def test_c1_cli_pulls_web_rekeyed_chain_under_new_mk(self):
        mk = base64.b64decode(self.web["new_seed"])
        spy = _RekeyTransportSpy()
        _seed_spy_with_wire(spy, self.web["blocks"], mk)
        pulled = RemoteLedgerSync(spy, mk).pull_full_chain()
        self.assertEqual(len(pulled), len(self.web["blocks"]))
        self.assertEqual(pulled[0].get("type"), "genesis")

    # ── C2/C3: CLI verify under client new MK (RED under R4/R5) ────

    def test_c2_cli_verifies_web_rekeyed_chain_under_new_mk(self):
        mk = base64.b64decode(self.web["new_seed"])
        id_secret = self._identity_secret_for(self.web["blocks"], mk)
        path = self._write_chain(self.web["blocks"])
        # The raw-seed MK verifies (the wire IS valid).
        crypto_raw = CryptoManager(mk, key_version=0)
        self.assertTrue(LedgerChain(crypto_raw, FileLedgerStore(path),
                                    identity_secret=id_secret).verify(),
                        "web wire must verify under its raw new MK (sanity)")
        # But the CLI's versioned-first gate must also accept it (R4/R5).
        self.assertTrue(
            self._cli_gate_accepts(self.web["blocks"], mk),
            "R4/R5: CLI derives HMAC for a raw-seed client chain "
            "(key_version defaulted to 1)",
        )

    def test_c3_cli_verifies_flutter_rekeyed_chain_under_new_mk(self):
        mk = base64.b64decode(self.flutter["new_seed"])
        id_secret = self._identity_secret_for(self.flutter["blocks"], mk)
        path = self._write_chain(self.flutter["blocks"])
        crypto_raw = CryptoManager(mk, key_version=0)
        self.assertTrue(LedgerChain(crypto_raw, FileLedgerStore(path),
                                    identity_secret=id_secret).verify(),
                        "flutter wire must verify under its raw new MK (sanity)")
        self.assertTrue(self._cli_gate_accepts(self.flutter["blocks"], mk),
                        "R4: Flutter key_version=1 means raw seed, but Python "
                        "derives HMAC")

    # ── C4/C5: reverse leak-nullification (guard-green) ────────────

    def test_c4_cli_with_old_seed_fails_to_pull(self):
        new_mk = base64.b64decode(self.web["new_seed"])
        old_mk = OLD_MK
        spy = _RekeyTransportSpy()
        _seed_spy_with_wire(spy, self.web["blocks"], new_mk)
        with self.assertRaises(ValueError):
            RemoteLedgerSync(spy, old_mk).pull_full_chain()

    def test_c5_cli_with_old_seed_fails_to_verify(self):
        new_mk = base64.b64decode(self.web["new_seed"])
        id_secret = self._identity_secret_for(self.web["blocks"], new_mk)
        path = self._write_chain(self.web["blocks"])
        crypto_old = CryptoManager(OLD_MK, key_version=0)
        self.assertFalse(LedgerChain(crypto_old, FileLedgerStore(path),
                                     identity_secret=id_secret).verify())

    # ── C6/C7/C8: parity + round-trip (guard-green) ────────────────

    def test_c6_hash_index_parity_after_cli_pull(self):
        new_mk = base64.b64decode(self.web["new_seed"])
        spy = _RekeyTransportSpy()
        _seed_spy_with_wire(spy, self.web["blocks"], new_mk)
        RemoteLedgerSync(spy, new_mk).push_hash_index(self.web["blocks"])
        hi = RemoteLedgerSync(spy, new_mk).pull_hash_index()
        self.assertEqual(hi["hashes"],
                         [get_block_hash(b) for b in self.web["blocks"]])

    def test_c7_repull_roundtrip_new_mk_ok_old_mk_fails(self):
        new_mk = base64.b64decode(self.web["new_seed"])
        spy = _RekeyTransportSpy()
        _seed_spy_with_wire(spy, self.web["blocks"], new_mk)
        pulled = RemoteLedgerSync(spy, new_mk).pull_full_chain()
        self.assertEqual([get_block_hash(b) for b in pulled],
                         [get_block_hash(b) for b in self.web["blocks"]])
        with self.assertRaises(ValueError):
            RemoteLedgerSync(spy, OLD_MK).pull_full_chain()

    def test_c8_genesis_parity_after_cli_pull(self):
        new_mk = base64.b64decode(self.web["new_seed"])
        genesis = self.web["blocks"][0]
        identity = genesis["identity"]
        # C-2 raw-bytes parity: the Web/Flutter wire hashes the identity
        # secret's DECODED BYTES (not its hex string) to derive identity_pub_key.
        id_hex = CryptoManager(new_mk, key_version=0).decrypt(
            identity["identity_secret_enc_fallback"])
        self.assertEqual(identity["identity_pub_key"],
                         hashlib.sha256(bytes.fromhex(id_hex)).hexdigest())
        # recovery_seed_enc decrypts under the new PDK. The Web re-keyer uses
        # the legacy fixed salt (crypto.derivePdk), so mirror it exactly.
        from security.auth import PassphraseAuthenticator
        pdk = hashlib.pbkdf2_hmac(
            "sha256", self.web["new_passphrase"].encode(),
            PassphraseAuthenticator.OLD_SALT,
            PassphraseAuthenticator.PBKDF2_ITERATIONS, 32)
        self.assertEqual(RecoveryManager.decrypt_seed(
            identity["recovery_seed_enc"], pdk), self.web["new_seed"])


# ══════════════════════════════════════════════════════════════════
# Group D — CLI↔client cryptographic invariants (D1–D8)
# ══════════════════════════════════════════════════════════════════

class TestCryptoInvariants(unittest.TestCase):
    """D1–D8: cross-client cryptographic invariants."""

    @classmethod
    def setUpClass(cls):
        cls.r = _cli_rekey()

    @classmethod
    def tearDownClass(cls):
        _teardown_cli_rekey()

    def test_d1_versioned_mk_parity_python_web(self):
        for v in (0, 1, 2):
            py = derive_mk(OLD_MK, v).hex()
            web = _node("deriveMk", seedB64=SEED_B64, version=v)["hex"]
            self.assertEqual(py, web, f"derive_mk(seed, {v}) must match web")

    def test_d2_raw_seed_mk_parity(self):
        # Python derive_mk(seed,0) == Web deriveMk(seed,0) == Web deriveMasterKey
        # == raw seed bytes. (Flutter deriveMasterKey is asserted in the Dart
        # Group L test.)
        self.assertEqual(derive_mk(OLD_MK, 0), OLD_MK)
        self.assertEqual(_node("deriveMk", seedB64=SEED_B64, version=0)["hex"], OLD_MK.hex())
        self.assertEqual(_node("deriveMasterKey", seedB64=SEED_B64)["hex"], OLD_MK.hex())

    def test_d3_key_version_unchanged_after_seed_mint_rekey(self):
        self.assertIsNotNone(self.r["new_seed_b64"], self.r["reason"])
        before_kv = self.r["genesis"].get("key_version")
        after_kv = self.r["rekeyed_blocks"][0].get("key_version")
        self.assertEqual(after_kv, before_kv,
                         R1_REASON + " — seed replacement must not bump key_version")

    def test_d4_content_hash_byte_identical_across_rekey(self):
        self.assertIsNotNone(self.r["new_seed_b64"], self.r["reason"])
        self.assertEqual(
            _content_hash_map(self.r["real_blocks"]),
            _content_hash_map(self.r["rekeyed_blocks"]),
        )

    def test_d5_identity_pub_key_invariant(self):
        self.assertEqual(self.r["identity_pub_key"],
                         hashlib.sha256(self.r["identity_secret"]).hexdigest())

    def test_d6_prev_hash_cascade_intact(self):
        self.assertIsNotNone(self.r["new_seed_b64"], self.r["reason"])
        blocks = self.r["rekeyed_blocks"]
        for i in range(1, len(blocks)):
            self.assertEqual(blocks[i]["prev_hash"], get_block_hash(blocks[i - 1]))

    def test_d7_entry_hash_recomputed_after_rekey(self):
        self.assertIsNotNone(self.r["new_seed_b64"], self.r["reason"])
        before = self.r["real_blocks"]
        after = self.r["rekeyed_blocks"]
        changed = 0
        for i, b in enumerate(before):
            if b.get("type") != "day":
                continue
            for j, e in enumerate(b["entries"]):
                if e["hash"] != after[i]["entries"][j]["hash"]:
                    changed += 1
        self.assertGreater(changed, 0,
                           "ciphertext-bound entry hashes must be recomputed after re-key")

    def test_d8_seal_parity_python_vs_committed_fixture(self):
        # ADR-029/029a convergence: Python compute_seal matches the committed
        # (web-generated) seals in the shared fixture.
        fixture = json.loads(FIXTURE.read_text())
        old_mk = bytes.fromhex(fixture["old_mk"])  # raw seed (key_version=0)
        crypto = CryptoManager(old_mk, key_version=0)
        for b in fixture["blocks"]:
            hash_key = ("block_hash" if b["type"] == "genesis" else "day_hash")
            self.assertEqual(compute_seal(crypto, b), b[hash_key],
                             f"{b['type']} seal must match the committed web seal")


if __name__ == "__main__":
    unittest.main()
