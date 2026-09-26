"""test_staging_mutation_wiring.py — ADR-034 P2 mutation/read wiring (Phase 2 RED).

Mutation flow only (read-flow hash gate is P3). Every client must, after a
local staging mutation, recompute the key-independent ``staging_hash`` over
canonical non-committed rows, bump ``seq``, update the LOCAL cookie
(``last_seen_hash``/``last_seen_seq``, keep ``device_specifier``), push the
blob, then push the REMOTE cookie.

Groups:
  F-Python (F1–F9) — mutation flow:
    F1 remote-cookie hash equals canonical hash of pushed rows (I3).
    F2 hash is canonical, NOT the raw/encrypted entry serialization (D8/V3).
    F3 local cookie gains last_seen_hash + last_seen_seq, keeps specifier.
    F4 blob is pushed before the remote cookie (I3 ordering).
    F5 absent last_seen_seq → seq 1.
    F6 last_seen_seq N → seq N+1.
    F7 no-op without a transport (no cookie, no push, no raise).
    F8 offline fail-open: local mutation + local cookie persist (I7).
    F9 fast-path (_push_on_fast_path) also pushes cookie with hash + seq.
  H-Python (H1–H2) — specifier stability (I5):
    H1 specifier unchanged across two pushes (no re-roll).
    H2 _reconcile_and_claim regenerates specifier AND carries hash + seq.

RED expectations:
  F1/F2/F3/F5/F6/F8/F9 + H1/H2 fail (current push_to_remote pushes a fresh
  cookie with staging_hash=null / seq=0 and re-rolls the specifier every
  push; _push_on_fast_path pushes only the blob).
  F4/F7 are guard-green (blob-before-cookie order and no-transport no-op
  already hold).

Blueprint: docs/planning/STAGING_MUTATION_WIRING_PHASE1.md
"""

import json
import hashlib
import time
import uuid
from pathlib import Path
from unittest.mock import MagicMock

from domain.staging.service import StagingService
from domain.staging.remote_sync import REMOTE_COOKIE_PATH
from domain.cookie.device_cookie import META_FILE
from domain.staging.row_merge import dtoToCanonicalRow, compute_staging_hash
from security.device_identity import DeviceIdentity

from tests.conftest import TEST_MASTER_KEY, DEVICE_A_UUID, TransportSpy


# ── Test helpers ────────────────────────────────────────────────────────────

def _make_crypto_with_mk(master_key: bytes = TEST_MASTER_KEY) -> MagicMock:
    crypto = MagicMock()
    crypto.master_key = master_key

    def encrypt_side_effect(text):
        if isinstance(text, bytes):
            text = text.decode()
        return f"plain:{text}"

    def decrypt_side_effect(val):
        if val is None:
            return None
        if isinstance(val, str):
            if val.startswith("plain:"):
                return val[6:]
            if val.startswith("ENC:"):
                return val[4:]
            return val
        return str(val)

    crypto.encrypt.side_effect = encrypt_side_effect
    crypto.decrypt.side_effect = decrypt_side_effect
    return crypto


def _make_device_provider(device_id: str) -> MagicMock:
    provider = MagicMock()
    provider.get_device_identity.return_value = DeviceIdentity(
        device_id=device_id,
        device_proof=f"proof-{device_id}",
        device_label="Test",
    )
    return provider


def _make_staging_store(initial_entries=None):
    store = MagicMock()
    store._entries = list(initial_entries) if initial_entries else []

    def read_entries():
        return list(store._entries)

    def write_entries(entries):
        store._entries[:] = list(entries)

    store.read_entries.side_effect = read_entries
    store.write_entries.side_effect = write_entries
    return store


def _make_service(data_dir, *, transport=None, device_id=DEVICE_A_UUID,
                  local_entries=None):
    crypto = _make_crypto_with_mk()
    store = _make_staging_store(local_entries)
    device_provider = _make_device_provider(device_id)
    svc = StagingService(
        crypto,
        store,
        transport=transport,
        device_id_provider=device_provider,
        data_dir=str(data_dir),
    )
    return svc, store


def _raw_entry(title, start_epoch, *, end_epoch=None, is_active=False,
               is_paused=False, entry_id=None, updated_at=None, committed=False,
               tags=None):
    eid = entry_id or str(uuid.uuid4())
    data = {
        "title": title,
        "duration": (end_epoch - start_epoch) if end_epoch else 0,
        "is_active": is_active,
        "is_paused": is_paused,
        "startTime_enc": f"plain:{start_epoch}",
        "endTime_enc": f"plain:{end_epoch}" if end_epoch else None,
        "pauses_enc": "plain:[]",
        "metadata_enc": "plain:{}",
        "tags": tags or [],
        "entry_id": eid,
    }
    if updated_at is not None:
        data["updated_at"] = updated_at
    if committed:
        data["committed"] = True
    raw = {
        "hash": hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest(),
        "data": data,
        "start_epoch": start_epoch,
    }
    if updated_at is not None:
        raw["updated_at"] = updated_at
    if committed:
        raw["committed"] = True
    return raw


def _write_meta(data_dir, *, specifier="spec-123", creation_time=None,
                last_seen_hash=None, last_seen_seq=None):
    data_dir.mkdir(parents=True, exist_ok=True)
    meta = {"device_specifier": specifier}
    meta["creation_time"] = (
        int(time.time() * 1000) if creation_time is None else creation_time
    )
    if last_seen_hash is not None:
        meta["last_seen_hash"] = last_seen_hash
    if last_seen_seq is not None:
        meta["last_seen_seq"] = last_seen_seq
    (data_dir / META_FILE).write_text(json.dumps(meta))


def _read_meta(data_dir):
    return json.loads((data_dir / META_FILE).read_text())


def _remote_cookie(spy):
    """Decode the remote cookie bytes currently held by the transport spy."""
    raw = spy.get_cookie()
    return json.loads(raw.decode("utf-8")) if raw else None


def _canonical_hash(svc, device_id=DEVICE_A_UUID):
    """Key-independent staging hash over current local canonical rows."""
    dtos = svc._local.read_entries()
    canonical = [dtoToCanonicalRow(d, device_id, 0) for d in dtos]
    return compute_staging_hash(canonical)


class OrderTrackingSpy(TransportSpy):
    """TransportSpy that also records the cross-kind push ordering."""

    def __init__(self):
        super().__init__()
        self.push_order = []

    def push(self, path, data):
        self.push_order.append("cookie" if path == REMOTE_COOKIE_PATH else "blob")
        super().push(path, data)


# ──────────────────────────────────────────────────────────────────────────
# Group F-Python — mutation flow
# ──────────────────────────────────────────────────────────────────────────


def test_F1_remote_cookie_hash_equals_canonical(tmp_path, transport_spy):
    """F1: push_to_remote sets the remote cookie staging_hash to the canonical
    hash of the just-pushed (non-committed) staging rows."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    svc, _ = _make_service(data_dir, transport=transport_spy, local_entries=[entry])

    svc.push_to_remote(TEST_MASTER_KEY)

    cookie = _remote_cookie(transport_spy)
    assert cookie is not None
    assert cookie["staging_hash"] == _canonical_hash(svc)


def test_F2_hash_is_canonical_not_raw(tmp_path, transport_spy):
    """F2: the cookie hash is over canonical rows, never the raw/encrypted
    entry serialization (key-independent, byte-identical across clients)."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456,
                       tags=["X"])
    svc, store = _make_service(data_dir, transport=transport_spy,
                               local_entries=[entry])

    svc.push_to_remote(TEST_MASTER_KEY)

    cookie = _remote_cookie(transport_spy)
    raw_hash = hashlib.sha256(
        json.dumps(
            sorted(store._entries, key=lambda e: e.get("start_epoch", 0)),
            sort_keys=True,
        ).encode()
    ).hexdigest()

    assert cookie["staging_hash"] == _canonical_hash(svc)
    assert cookie["staging_hash"] != raw_hash


def test_F3_local_cookie_updates_hash_and_seq_keeps_specifier(tmp_path, transport_spy):
    """F3: the LOCAL cookie is updated with last_seen_hash + last_seen_seq and
    keeps its device_specifier (no re-roll on a normal push)."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    svc, _ = _make_service(data_dir, transport=transport_spy, local_entries=[entry])
    _write_meta(data_dir, specifier="keep-me", last_seen_seq=4)

    svc.push_to_remote(TEST_MASTER_KEY)

    meta = _read_meta(data_dir)
    assert meta["last_seen_hash"] == _canonical_hash(svc)
    assert meta["last_seen_seq"] == 5
    assert meta["device_specifier"] == "keep-me"


def test_F4_blob_pushed_before_remote_cookie(tmp_path):
    """F4: the staging blob is pushed before the remote cookie (I3 ordering)."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    spy = OrderTrackingSpy()
    svc, _ = _make_service(data_dir, transport=spy, local_entries=[entry])

    svc.push_to_remote(TEST_MASTER_KEY)

    assert spy.push_order == ["blob", "cookie"]


def test_F5_seq_absent_becomes_1(tmp_path, transport_spy):
    """F5: with no local cookie (last_seen_seq absent), the first mutation
    pushes seq = 1."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    svc, _ = _make_service(data_dir, transport=transport_spy, local_entries=[entry])

    svc.push_to_remote(TEST_MASTER_KEY)

    cookie = _remote_cookie(transport_spy)
    assert cookie["seq"] == 1


def test_F6_seq_increments_from_last_seen(tmp_path, transport_spy):
    """F6: the remote cookie seq is last_seen_seq + 1."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    svc, _ = _make_service(data_dir, transport=transport_spy, local_entries=[entry])
    _write_meta(data_dir, specifier="s1", last_seen_seq=5)

    svc.push_to_remote(TEST_MASTER_KEY)

    cookie = _remote_cookie(transport_spy)
    assert cookie["seq"] == 6


def test_F7_noop_without_transport(tmp_path):
    """F7: with no transport configured, push_to_remote is a no-op (no cookie,
    no push, no raise)."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    svc, _ = _make_service(data_dir, transport=None, local_entries=[entry])

    svc.push_to_remote(TEST_MASTER_KEY)

    assert len(svc._local.read_entries()) == 1
    assert not (data_dir / META_FILE).exists()


def test_F8_offline_fail_open_preserves_local_baseline(tmp_path):
    """F8: an offline blob push must not raise, and the local cookie baseline
    (last_seen_hash + specifier) is still recorded (I7 fail-open)."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    transport = MagicMock()
    transport.push.side_effect = TimeoutError("offline")
    svc, _ = _make_service(data_dir, transport=transport, local_entries=[entry])
    _write_meta(data_dir, specifier="keep-me")

    raised = None
    try:
        svc.push_to_remote(TEST_MASTER_KEY)
    except Exception as exc:  # noqa: BLE001 — we assert it did NOT raise
        raised = exc

    assert raised is None, f"push_to_remote raised {raised!r} (offline must fail-open)"
    meta = _read_meta(data_dir)
    assert meta.get("last_seen_hash") == _canonical_hash(svc)
    assert meta.get("device_specifier") == "keep-me"


def test_F9_fast_path_pushes_cookie_with_hash_and_seq(tmp_path, transport_spy):
    """F9: the fast path (_push_on_fast_path) also pushes the remote cookie
    with the canonical staging_hash and the bumped seq."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    svc, _ = _make_service(data_dir, transport=transport_spy, local_entries=[entry])
    _write_meta(data_dir, specifier="s1", last_seen_seq=3)

    svc._push_on_fast_path({"device_specifier": "s1", "creation_time": 1})

    cookie = _remote_cookie(transport_spy)
    assert cookie is not None
    assert cookie["staging_hash"] == _canonical_hash(svc)
    assert cookie["seq"] == 4


# ──────────────────────────────────────────────────────────────────────────
# Group H-Python — specifier stability (I5)
# ──────────────────────────────────────────────────────────────────────────


def test_H1_specifier_stable_across_pushes(tmp_path, transport_spy):
    """H1: device_specifier is unchanged across two successive pushes
    (only the ownership handoff in _reconcile_and_claim re-rolls it)."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    svc, _ = _make_service(data_dir, transport=transport_spy, local_entries=[entry])
    _write_meta(data_dir, specifier="stable-spec")

    svc.push_to_remote(TEST_MASTER_KEY)
    cookie1 = _remote_cookie(transport_spy)
    svc.push_to_remote(TEST_MASTER_KEY)
    cookie2 = _remote_cookie(transport_spy)

    assert cookie1["device_specifier"] == "stable-spec"
    assert cookie2["device_specifier"] == "stable-spec"


def test_H2_reconcile_regenerates_specifier_and_carries_hash_seq(tmp_path, transport_spy):
    """H2: _reconcile_and_claim re-rolls the device_specifier (ownership
    handoff) AND carries a non-null canonical staging_hash + seq >= 1."""
    data_dir = tmp_path / "phpoc_data"
    entry = _raw_entry("Task A", 1000, end_epoch=2000, updated_at=123456)
    svc, _ = _make_service(data_dir, transport=transport_spy, local_entries=[entry])
    _write_meta(data_dir, specifier="old-spec")

    svc._reconcile_and_claim(TEST_MASTER_KEY)

    meta = _read_meta(data_dir)
    assert meta["device_specifier"] != "old-spec"

    cookie = _remote_cookie(transport_spy)
    assert cookie is not None
    assert cookie["staging_hash"] == _canonical_hash(svc)
    assert len(cookie["staging_hash"]) == 64
    assert cookie["seq"] >= 1
