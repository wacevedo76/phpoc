"""C3 — Read-Only "Observe" Mode — Phase 2 RED tests (CLI-first slice).

Blueprint: docs/planning/C3_READ_ONLY_OBSERVE_PHASE1.md (Groups A, B, C, D, G = 31
assertions). Design: docs/design/STAGING_CHANGE_DETECTION_DESIGN.md (ADR-034).

These tests define the RED contract for the OBSERVE state-machine branch:

  * ``StagingService.observe(timeout_ms=None, staging_hash_provider=None)``
    returns ``SyncCheckResult`` (always READY — fail-open, never REAUTH_NEEDED).
  * ``staging_hash_provider`` is an injected seam: a zero-arg callable returning
    the remote ``staging_hash`` as ``Optional[str]``. ``None`` → "changed".
  * ``last_seen_hash`` lives in the local cookie META_FILE (ADR-034 §3).
  * ``StagingService._pull_and_merge(master_key, timeout_ms=None)`` is the shared
    pull+merge helper (no push, no cookie side effects) returning the merged
    uncommitted DTO list, ``None`` on BLOB_KEY_MISMATCH, raising on unreachable.
  * ``CLIInterface`` gains an optional ``config`` and an ``observe`` flag on
    ``_sync_before_command`` to route read commands through observe when
    ``staging.observe_mode == "auto"`` (or ``--observe`` forces it).
"""

import json
import time
import hashlib
import uuid
import tempfile
from pathlib import Path
from io import StringIO
from unittest.mock import MagicMock, patch
import unittest

from domain.staging.service import StagingService, SyncCheckResult
from domain.staging.remote_sync import BLOB_KEY_MISMATCH, REMOTE_COOKIE_PATH
from domain.cookie.device_cookie import META_FILE
from security.device_identity import DeviceIdentity
from security.config_manager import ConfigManager
from storage.implementations.file_config import FileConfigStore
from phpoc_cli.interface import CLIInterface

from tests.conftest import (
    TEST_MASTER_KEY,
    DEVICE_A_UUID,
    DEVICE_B_UUID,
    TransportSpy,
    make_remote_cookie_bytes,
    make_staging_blob_bytes,
)


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
                last_seen_hash=None):
    meta = {"device_specifier": specifier}
    meta["creation_time"] = (
        int(time.time() * 1000) if creation_time is None else creation_time
    )
    if last_seen_hash is not None:
        meta["last_seen_hash"] = last_seen_hash
    (data_dir / META_FILE).write_text(json.dumps(meta))


def _read_meta(data_dir):
    return json.loads((data_dir / META_FILE).read_text())


def _make_config(observe_mode):
    tmp = tempfile.TemporaryDirectory()
    store = FileConfigStore(Path(tmp.name) / "config.json")
    mgr = ConfigManager(store)
    cfg = mgr.read()
    cfg["staging"]["observe_mode"] = observe_mode
    mgr.write(cfg)
    mgr._tmpdir = tmp  # keep alive for test lifetime
    return mgr


class _ServiceTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()


# ── Group A: OBSERVE state-machine semantics (8 tests) ──────────────────────

class TestObserveStateMachine(_ServiceTestCase):

    def test_A1_unchanged_hash_returns_ready_without_blob_pull(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("remote", 1000)]))

        _write_meta(self.data_dir, specifier="spec-123", last_seen_hash="hash-abc")
        svc, _ = _make_service(self.data_dir, transport=transport)

        result = svc.observe(staging_hash_provider=lambda: "hash-abc")

        self.assertEqual(result, SyncCheckResult.READY)
        self.assertEqual(transport.pull_cookie_calls, 1)
        self.assertEqual(transport.pull_blob_calls, 0)

    def test_A2_changed_hash_pulls_and_merges(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("remote task", 2000, is_active=True)]))

        _write_meta(self.data_dir, specifier="spec-123", last_seen_hash="old-hash")
        svc, store = _make_service(self.data_dir, transport=transport)

        result = svc.observe(staging_hash_provider=lambda: "new-hash")

        self.assertEqual(result, SyncCheckResult.READY)
        self.assertGreaterEqual(transport.pull_blob_calls, 1)
        titles = [e["title"] for e in svc._local.read_entries()]
        self.assertIn("remote task", titles)

    def test_A3_unknown_hash_treats_remote_as_changed(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("legacy remote", 3000)]))

        _write_meta(self.data_dir, specifier="spec-123")
        svc, store = _make_service(self.data_dir, transport=transport)

        result = svc.observe(staging_hash_provider=lambda: None)

        self.assertEqual(result, SyncCheckResult.READY)
        self.assertGreaterEqual(transport.pull_blob_calls, 1)
        titles = [e["title"] for e in svc._local.read_entries()]
        self.assertIn("legacy remote", titles)

    def test_A4_observe_never_pushes_blob(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("remote", 4000)]))

        _write_meta(self.data_dir, specifier="spec-123", last_seen_hash="old")
        svc, _ = _make_service(self.data_dir, transport=transport)

        svc.observe(staging_hash_provider=lambda: "changed")

        self.assertEqual(transport.push_blob_calls, [])

    def test_A5_observe_never_claims_cookie(self):
        transport = TransportSpy()
        original_cookie = make_remote_cookie_bytes(
            specifier="writer-spec", device_uuid=DEVICE_B_UUID)
        transport.set_cookie(original_cookie)
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            device_id=DEVICE_B_UUID, entries=[_raw_entry("remote", 5000)]))

        fixed_creation = int(time.time() * 1000) - 60_000
        _write_meta(self.data_dir, specifier="observer-spec",
                    creation_time=fixed_creation, last_seen_hash="old")
        svc, _ = _make_service(self.data_dir, transport=transport)

        svc.observe(staging_hash_provider=lambda: "changed")

        meta = _read_meta(self.data_dir)
        self.assertEqual(meta["device_specifier"], "observer-spec")
        self.assertEqual(transport.push_cookie_calls, [])
        self.assertEqual(transport.get_cookie(), original_cookie)

    def test_A6_specifier_mismatch_still_returns_ready(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(
            specifier="other-device", device_uuid=DEVICE_B_UUID))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            device_id=DEVICE_B_UUID, entries=[_raw_entry("their task", 6000)]))

        _write_meta(self.data_dir, specifier="my-device")
        svc, _ = _make_service(self.data_dir, transport=transport,
                               device_id=DEVICE_A_UUID)

        result = svc.observe(staging_hash_provider=lambda: "changed")

        self.assertEqual(result, SyncCheckResult.READY)
        self.assertNotEqual(result, SyncCheckResult.REAUTH_NEEDED)

    def test_A7_records_last_seen_hash_after_merge(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("remote", 7000)]))

        _write_meta(self.data_dir, specifier="spec-123", last_seen_hash="old")
        svc, _ = _make_service(self.data_dir, transport=transport)

        svc.observe(staging_hash_provider=lambda: "brand-new-hash")

        self.assertEqual(_read_meta(self.data_dir)["last_seen_hash"],
                         "brand-new-hash")

    def test_A9_local_write_preserves_last_seen_hash(self):
        """_touch_local_cookie must not drop observe's last_seen_hash baseline.

        A local write (capture/end/pause/…) bumps the cookie creation_time via
        _touch_local_cookie, which rewrites META_FILE. If that rewrite drops
        last_seen_hash, the next observe loses its cheap-read baseline and does
        a full blob pull — regressing C3's hash-gated change detection.
        """
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))

        _write_meta(self.data_dir, specifier="spec-123",
                    last_seen_hash="seen-before")
        svc, _ = _make_service(self.data_dir, transport=transport)

        svc._touch_local_cookie()

        meta = _read_meta(self.data_dir)
        self.assertEqual(meta["last_seen_hash"], "seen-before")
        self.assertEqual(meta["device_specifier"], "spec-123")

    def test_A8_observe_never_refreshes_ttl(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("remote", 8000)]))

        fixed_creation = int(time.time() * 1000) - 120_000
        _write_meta(self.data_dir, specifier="spec-123",
                    creation_time=fixed_creation, last_seen_hash="old")
        svc, _ = _make_service(self.data_dir, transport=transport)

        svc.observe(staging_hash_provider=lambda: "changed")

        self.assertEqual(_read_meta(self.data_dir)["creation_time"], fixed_creation)


# ── Group B: shared pull+merge helper extraction (7 tests) ──────────────────

class TestPullAndMergeHelper(_ServiceTestCase):

    def test_B1_returns_merged_uncommitted_dtos(self):
        transport = TransportSpy()
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("remote row", 1000)]))

        svc, store = _make_service(self.data_dir, transport=transport)

        merged = svc._pull_and_merge(TEST_MASTER_KEY)

        self.assertIsInstance(merged, list)
        self.assertIsNotNone(merged)
        self.assertTrue(any(e.get("title") == "remote row" for e in merged))

    def test_B2_blob_key_mismatch_returns_none_untouched(self):
        transport = TransportSpy()
        transport.set_remote_blob("staging/blob", b"\x00garbage-not-json")

        local = _raw_entry("local row", 500, entry_id="local-1")
        svc, store = _make_service(self.data_dir, transport=transport,
                                   local_entries=[local])
        before = store.read_entries()

        merged = svc._pull_and_merge(TEST_MASTER_KEY)

        self.assertIsNone(merged)
        self.assertEqual(store.read_entries(), before)

    def test_B3_raises_on_unreachable_blob(self):
        transport = MagicMock()
        transport.pull.side_effect = TimeoutError("blob pull timeout")

        svc, _ = _make_service(self.data_dir, transport=transport)

        if not hasattr(svc, '_pull_and_merge'):
            self.fail("_pull_and_merge helper not implemented (RED)")

        with self.assertRaises(TimeoutError):
            svc._pull_and_merge(TEST_MASTER_KEY)

    def test_B4_filters_committed_rows(self):
        transport = TransportSpy()
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[
                _raw_entry("committed remote", 1000, committed=True,
                           entry_id="committed-1"),
                _raw_entry("uncommitted remote", 2000, entry_id="live-1"),
            ]))

        svc, store = _make_service(self.data_dir, transport=transport)

        merged = svc._pull_and_merge(TEST_MASTER_KEY)

        self.assertTrue(all(not e.get("committed") for e in merged))
        titles = [e["title"] for e in svc._local.read_entries()]
        self.assertIn("uncommitted remote", titles)
        self.assertNotIn("committed remote", titles)

    def test_B5_no_push_no_cookie_side_effect(self):
        transport = TransportSpy()
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("remote", 1000)]))

        svc, _ = _make_service(self.data_dir, transport=transport)

        svc._pull_and_merge(TEST_MASTER_KEY)

        self.assertEqual(transport.push_blob_calls, [])
        self.assertEqual(transport.push_cookie_calls, [])

    def test_B6_reconcile_and_claim_canonical_outcome(self):
        # Sub-case A: BLOB_KEY_MISMATCH -> OFFLINE, local untouched, no push.
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", b"\x00garbage-not-json")

        local = _raw_entry("local", 500, entry_id="local-1")
        svc, store = _make_service(self.data_dir, transport=transport,
                                   local_entries=[local])
        before = store.read_entries()

        result = svc._reconcile_and_claim(TEST_MASTER_KEY)

        self.assertEqual(result, SyncCheckResult.OFFLINE)
        self.assertEqual(store.read_entries(), before)
        self.assertEqual(transport.push_blob_calls, [])

        # Sub-case B: canonical LWW — local newer active beats remote older
        # active, committed excluded, claim pushes. (Legacy merge would let the
        # remote overwrite local, so this is RED until _reconcile_and_claim
        # routes through the canonical merge_rows helper.)
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[
                _raw_entry("committed", 1000, committed=True, entry_id="c-1"),
                _raw_entry("remote older", 2000, is_active=True, entry_id="live-1",
                           updated_at=1000),
            ]))

        local_newer = _raw_entry("local newer", 2000, is_active=True,
                                 entry_id="live-1", updated_at=9000)
        svc, store = _make_service(self.data_dir, transport=transport,
                                   local_entries=[local_newer])
        result = svc._reconcile_and_claim(TEST_MASTER_KEY)

        self.assertEqual(result, SyncCheckResult.READY)
        titles = [e["title"] for e in svc._local.read_entries()]
        self.assertIn("local newer", titles)
        self.assertNotIn("remote older", titles)
        self.assertNotIn("committed", titles)
        self.assertGreaterEqual(len(transport.push_blob_calls), 1)

    def test_B7_routes_through_canonical_merge_rows(self):
        # Terminal-state: remote ENDED (older) beats local ACTIVE (newer).
        transport = TransportSpy()
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("ended remote", 1000, end_epoch=2000,
                                is_active=False, entry_id="x-1",
                                updated_at=1000)]))
        local_active = _raw_entry("active local", 1000, is_active=True,
                                  entry_id="x-1", updated_at=5000)
        svc, store = _make_service(self.data_dir, transport=transport,
                                   local_entries=[local_active])

        svc._pull_and_merge(TEST_MASTER_KEY)

        merged_row = svc._local.read_entries()[0]
        self.assertFalse(merged_row.get("is_active"))
        self.assertEqual(merged_row.get("title"), "ended remote")

        # LWW local-wins-on-newer: local ACTIVE (newer) beats remote ACTIVE (older).
        transport = TransportSpy()
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("old remote active", 1000, is_active=True,
                                entry_id="y-1", updated_at=1000)]))
        local_newer = _raw_entry("newer local active", 1000, is_active=True,
                                 entry_id="y-1", updated_at=9000)
        svc, store = _make_service(self.data_dir, transport=transport,
                                   local_entries=[local_newer])

        svc._pull_and_merge(TEST_MASTER_KEY)

        merged_row = svc._local.read_entries()[0]
        self.assertTrue(merged_row.get("is_active"))
        self.assertEqual(merged_row.get("title"), "newer local active")


# ── Group C: CLI routing for read commands (6 tests) ────────────────────────

class TestCliObserveRouting(unittest.TestCase):
    """Read commands (view/list/tags) route through observe; writes do not."""

    def setUp(self):
        self.mock_staging = MagicMock()
        self.mock_ledger_engine = MagicMock()
        self.mock_crypto = MagicMock()
        self.mock_staging._remote = MagicMock()
        self.mock_staging._local.read_entries.return_value = []
        self.mock_staging.observe.return_value = SyncCheckResult.READY
        self.mock_staging.check_and_sync.return_value = SyncCheckResult.READY
        self.cfg = _make_config("auto")
        self.cli = CLIInterface(
            self.mock_staging, self.mock_ledger_engine, self.mock_crypto,
            config=self.cfg,
        )

    def test_C1_view_routes_through_observe(self):
        with patch.object(self.cli, '_sync_remote_ledger_and_dedup'), \
             patch('phpoc_cli.interface._show_sync_notifications'), \
             patch('phpoc_cli.interface._spawn_background_sync_check'):
            self.cli.view_active()

        self.mock_staging.observe.assert_called_once_with(timeout_ms=500)
        self.mock_staging.check_and_sync.assert_not_called()

    def test_C2_list_routes_through_observe(self):
        self.mock_ledger_engine.get_day_blocks.return_value = []

        self.cli.list_habits('all')

        self.mock_staging.observe.assert_called_once_with(timeout_ms=500)
        self.mock_staging.check_and_sync.assert_not_called()

    def test_C3_tags_read_path_routes_through_observe(self):
        """tags has no internal sync; main.py calls _sync_before_command.
        The shared primitive must route to observe, not check_and_sync."""
        with patch.object(self.cli, '_sync_remote_ledger_and_dedup'):
            result = self.cli._sync_before_command(require_auth=False)

        self.assertTrue(result)
        self.mock_staging.observe.assert_called_once_with(timeout_ms=500)
        self.mock_staging.check_and_sync.assert_not_called()

    def test_C4_writes_require_auth_never_observe(self):
        with patch.object(self.cli, '_sync_before_command',
                          wraps=self.cli._sync_before_command) as mock_sync, \
             patch.object(self.cli, '_sync_remote_ledger_and_dedup'), \
             patch.object(self.cli, '_defer_push'):
            self.cli.add_start('New Task')

        mock_sync.assert_called_once_with(require_auth=True)
        self.mock_staging.observe.assert_not_called()
        self.mock_staging.check_and_sync.assert_called_once_with(timeout_ms=500)

    def test_C5_read_shows_local_data_instantly(self):
        self.mock_staging._local.read_entries.return_value = [{
            'title': 'Local Task', 'is_active': True, 'start_epoch': 1000000,
            'is_paused': False, 'duration': 0, 'tags': [], 'comment': '',
            'media': [], 'metadata': {}, 'pauses': [], 'entry_id': 'test-id',
            'date': '2026-01-01',
        }]

        with patch.object(self.cli, '_sync_remote_ledger_and_dedup'), \
             patch('phpoc_cli.interface._show_sync_notifications'), \
             patch('phpoc_cli.interface._spawn_background_sync_check'), \
             patch('sys.stdout', new_callable=StringIO) as out:
            self.cli.view_active()

        self.assertIn('Local Task', out.getvalue())
        self.mock_staging.observe.assert_called_once_with(timeout_ms=500)
        self.mock_staging.check_and_sync.assert_not_called()

    def test_C6_read_never_prompts_passphrase(self):
        mock_auth = MagicMock()
        mock_auth.login.return_value = True
        self.cli._auth = mock_auth

        with patch.object(self.cli, '_sync_remote_ledger_and_dedup'):
            result = self.cli._sync_before_command(require_auth=False)

        self.assertTrue(result)
        mock_auth.login.assert_not_called()
        self.mock_staging.observe.assert_called_once_with(timeout_ms=500)
        self.mock_staging.check_and_sync.assert_not_called()


# ── Group D: network budget + fail-open + no side effects (5 tests) ─────────

class TestObserveNetworkBudget(_ServiceTestCase):

    def test_D1_observe_offline_returns_ready_local_only(self):
        transport = MagicMock()
        transport.pull.side_effect = TimeoutError("network down")

        local = _raw_entry("local", 500, entry_id="local-1")
        svc, store = _make_service(self.data_dir, transport=transport,
                                   local_entries=[local])
        before = store.read_entries()

        result = svc.observe(staging_hash_provider=lambda: "changed")

        self.assertEqual(result, SyncCheckResult.READY)
        self.assertEqual(store.read_entries(), before)

    def test_D2_observe_wrong_mk_returns_local_only(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", b"\x00\x01garbage")

        local = _raw_entry("local", 500, entry_id="local-1")
        svc, store = _make_service(self.data_dir, transport=transport,
                                   local_entries=[local])
        before = store.read_entries()

        result = svc.observe(staging_hash_provider=lambda: "changed")

        self.assertEqual(result, SyncCheckResult.READY)
        self.assertEqual(store.read_entries(), before)
        self.assertEqual(transport.push_blob_calls, [])

    def test_D3_observe_no_remote_zero_network(self):
        svc, store = _make_service(self.data_dir, transport=None,
                                   local_entries=[_raw_entry("local", 500,
                                                             entry_id="l-1")])
        before = store.read_entries()

        result = svc.observe(staging_hash_provider=lambda: "changed")

        self.assertEqual(result, SyncCheckResult.READY)
        self.assertEqual(store.read_entries(), before)
        self.assertIsNone(svc._remote)

    def test_D4_observe_unchanged_one_cookie_get_zero_blob(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="spec-123"))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("remote", 1000)]))

        _write_meta(self.data_dir, specifier="spec-123", last_seen_hash="same")
        svc, _ = _make_service(self.data_dir, transport=transport)

        svc.observe(staging_hash_provider=lambda: "same")

        self.assertEqual(transport.pull_cookie_calls, 1)
        self.assertEqual(transport.pull_blob_calls, 0)
        self.assertEqual(transport.push_blob_calls, [])
        self.assertEqual(transport.push_cookie_calls, [])

    def test_D5_observe_does_not_create_local_cookie(self):
        transport = TransportSpy()
        transport.set_cookie(make_remote_cookie_bytes(specifier="writer-spec"))
        transport.set_remote_blob("staging/blob", make_staging_blob_bytes(
            entries=[_raw_entry("remote", 5000)]))

        svc, _ = _make_service(self.data_dir, transport=transport)

        svc.observe(staging_hash_provider=lambda: "changed")

        # Observer is read-only: it never claims a device cookie.
        self.assertEqual(transport.push_cookie_calls, [])
        meta_path = self.data_dir / META_FILE
        if meta_path.exists():
            meta = json.loads(meta_path.read_text())
            self.assertNotIn("device_specifier", meta)


# ── Group G: config surface + observe_mode routing matrix (5 tests) ─────────

class TestObserveConfigRouting(unittest.TestCase):

    def setUp(self):
        self.mock_staging = MagicMock()
        self.mock_ledger_engine = MagicMock()
        self.mock_crypto = MagicMock()
        self.mock_staging._remote = MagicMock()
        self.mock_staging.observe.return_value = SyncCheckResult.READY
        self.mock_staging.check_and_sync.return_value = SyncCheckResult.READY

    def _cli(self, observe_mode):
        cfg = _make_config(observe_mode)
        return CLIInterface(
            self.mock_staging, self.mock_ledger_engine, self.mock_crypto,
            config=cfg,
        )

    def test_G1_defaults_observe_mode_auto(self):
        self.assertEqual(ConfigManager.DEFAULTS["staging"]["observe_mode"], "auto")

        tmp = tempfile.TemporaryDirectory()
        try:
            store = FileConfigStore(Path(tmp.name) / "config.json")
            mgr = ConfigManager(store)
            self.assertEqual(mgr.get("staging.observe_mode"), "auto")
        finally:
            tmp.cleanup()

    def test_G2_auto_routes_reads_through_observe(self):
        cli = self._cli("auto")

        with patch.object(cli, '_sync_remote_ledger_and_dedup'):
            result = cli._sync_before_command(require_auth=False)

        self.assertTrue(result)
        self.mock_staging.observe.assert_called_once_with(timeout_ms=500)
        self.mock_staging.check_and_sync.assert_not_called()

    def test_G3_manual_keeps_fast_path(self):
        cli = self._cli("manual")

        with patch.object(cli, '_sync_remote_ledger_and_dedup'):
            result = cli._sync_before_command(require_auth=False)

        self.assertTrue(result)
        self.mock_staging.observe.assert_not_called()
        self.mock_staging.check_and_sync.assert_called_once_with(timeout_ms=500)

    def test_G4_manual_observe_flag_forces_observe(self):
        cli = self._cli("manual")

        with patch.object(cli, '_sync_remote_ledger_and_dedup'):
            result = cli._sync_before_command(require_auth=False, observe=True)

        self.assertTrue(result)
        self.mock_staging.observe.assert_called_once_with(timeout_ms=500)
        self.mock_staging.check_and_sync.assert_not_called()

    def test_G5_writes_ignore_observe_mode(self):
        cli = self._cli("auto")

        with patch.object(cli, '_sync_remote_ledger_and_dedup'):
            result = cli._sync_before_command(require_auth=True)

        self.assertTrue(result)
        self.mock_staging.observe.assert_not_called()
        self.mock_staging.check_and_sync.assert_called_once_with(timeout_ms=500)
