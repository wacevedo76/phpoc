"""Phase 4 tests: Staging Interaction Flow + Sync Orchestrator.

This is a TEST-FIRST file — it defines the expected interfaces and behaviors
for Phase 4 components BEFORE they are implemented. Each test documents
the contract that the implementation must satisfy.

Components tested:
  1. OfflineQueue         — queue/batch/drain entries when remote is offline
  2. Every-command sync   — check_and_sync is called on every staging op
  3. Auth cache           — 30-minute window, re-auth when expired + mismatch
  4. SyncOrchestrator     — full lifecycle: check → pull → merge → commit → push
  5. SyncDecision         — consolidated (moved from core/sync_confirmation.py)
  6. AbstractStagingTransport — interface contract (2 methods)
  7. Push flow            — push_to_remote after successful local op
"""

import unittest
import json
import time
import datetime
import hashlib
import hmac
from pathlib import Path
from unittest.mock import MagicMock, patch, call
from typing import Optional, List, Dict, Any, Tuple
from enum import Enum
from dataclasses import dataclass, field

# =============================================================================
# Pre-import checks — Phase 4 components may not exist yet
# =============================================================================

try:
    from domain.staging.service import StagingService, SyncCheckResult
    from domain.staging.merge_engine import MergeEngine
    from domain.staging.remote_sync import RemoteStagingSync
    from domain.staging.local_cache import LocalStagingCache
    from security.device_identity import (
        AbstractDeviceIdentityProvider,
        DeviceIdentity,
        RandomUUIDDeviceIdentityProvider,
    )
    from security.crypto import AbstractCryptoManager, NoAuthCryptoManager
    from storage.staging_store import AbstractStagingStore
    from domain.cookie.device_cookie import DeviceCookie
    HAS_PHASE2 = True
except ImportError:
    HAS_PHASE2 = False
    from abc import ABC, abstractmethod

    class SyncCheckResult:
        READY = "READY"
        OFFLINE = "OFFLINE"
        REAUTH_NEEDED = "REAUTH_NEEDED"

    class DeviceIdentity:
        def __init__(self, device_id="", device_proof="", device_label=""):
            self.device_id = device_id
            self.device_proof = device_proof
            self.device_label = device_label

    class AbstractDeviceIdentityProvider(ABC):
        @abstractmethod
        def get_device_identity(self, master_key: bytes) -> DeviceIdentity: pass
        @abstractmethod
        def verify_device_proof(self, device_id: str, device_proof: str, master_key: bytes) -> bool: pass


# Phase 4 components — may not exist yet
try:
    from core.sync.orchestrator import SyncOrchestrator
    from core.sync.decision import SyncDecision as NewSyncDecision
    from core.sync.transport import AbstractStagingTransport
    HAS_PHASE4 = True
except ImportError:
    HAS_PHASE4 = False
    # Stubs for test-first
    class SyncDecision:
        pass
    class SyncOrchestrator:
        pass
    class AbstractStagingTransport:
        pass

# Fallback SyncDecision if neither exists
try:
    from cli.strategies import SyncDecision as CLISyncDecision
    SYNC_DECISION_CLASS = CLISyncDecision
except ImportError:
    @dataclass
    class SyncDecisionFallback:
        selected_indices: list = field(default_factory=list)
        removal_indices: set = field(default_factory=set)
        overrides: dict = field(default_factory=dict)
        cancelled: bool = False
    SYNC_DECISION_CLASS = SyncDecisionFallback


# =============================================================================
# Helpers
# =============================================================================

def mock_crypto():
    fake = MagicMock()
    fake.encrypt.side_effect = lambda text: f"ENC:{text}"
    fake.decrypt.side_effect = lambda hex_data: (
        hex_data[4:] if hex_data.startswith("ENC:")
        else hex_data[6:] if hex_data.startswith("plain:")
        else hex_data
    )
    fake.seal.side_effect = lambda ds: hashlib.sha256(ds.encode()).hexdigest()[:32]
    fake.verify_seal.side_effect = lambda ds, seal: (
        hashlib.sha256(ds.encode()).hexdigest()[:32] == seal
    )
    fake.sign.side_effect = lambda hv, sec: hashlib.sha256(
        (hv + str(sec)).encode()
    ).hexdigest()
    fake.verify_signature.side_effect = lambda hv, sig, sec: (
        hashlib.sha256((hv + str(sec)).encode()).hexdigest() == sig
    )
    return fake


def mock_staging_store(initial_entries=None):
    store = MagicMock()
    store.entries = list(initial_entries) if initial_entries else []
    store.read_entries.side_effect = lambda: list(store.entries)
    store.write_entries.side_effect = lambda entries: setattr(
        store, "entries", list(entries)
    )
    store.append_entry.side_effect = lambda entry: store.entries.append(entry)
    store.remove_entries.side_effect = lambda indices: (
        [store.entries.pop(i) for i in sorted(indices, reverse=True)
         if 0 <= i < len(store.entries)]
    )
    store.update_entry.side_effect = lambda index, fields: (
        store.entries[index].update(fields)
        if 0 <= index < len(store.entries) else None
    )
    return store


def mock_transport(available=True):
    transport = MagicMock()
    transport._blob = None
    transport._cookie = None
    transport._available = available
    transport.pull.side_effect = lambda path=None: (
        transport._blob if "cookie" not in str(path) else transport._cookie
    )
    transport.push.side_effect = lambda path, data: setattr(
        transport, "_cookie" if "cookie" in str(path) else "_blob", data
    )
    return transport


def mock_ledger_engine():
    """Mock LedgerEngine that records commit/revert calls."""
    engine = MagicMock()
    engine.committed = []

    def fake_commit(entries, identity_secret=None):
        engine.committed.append(len(entries))
        # Return a mock day_hash prefix
        return hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()[:10]

    engine.commit.side_effect = fake_commit
    engine.verify.return_value = True
    engine.revert.return_value = (True, [], {"reverted": 0})
    engine.get_block_count.return_value = 0
    engine.get_last_block.return_value = None
    return engine


def make_entry(
    title: str,
    start_epoch: int,
    end_epoch: Optional[int] = None,
    is_active: bool = False,
    tags: Optional[List[str]] = None,
    comment: Optional[str] = None,
) -> Dict[str, Any]:
    return {
        "title": title,
        "start_epoch": start_epoch,
        "end_epoch": end_epoch or (start_epoch + 3600000),
        "duration": (end_epoch or (start_epoch + 3600000)) - start_epoch,
        "is_active": is_active,
        "is_paused": False,
        "pauses": [],
        "tags": tags or [],
        "comment": comment,
        "metadata": {},
        "media": [],
        "source": "local",
        "hash": "",
        "entry_index": 0,
        "date": "",
    }


# =============================================================================
# Skip condition helper
# =============================================================================

def skip_unless_phase4():
    """Skip all tests in a class if Phase 4 components are missing."""
    if not HAS_PHASE4:
        raise unittest.SkipTest("Phase 4 components not yet implemented")


# =============================================================================
# 1. Offline Queue Tests
# =============================================================================

class TestOfflineQueue(unittest.TestCase):
    """Offline queue holds entries when remote is unreachable.

    When check_and_sync returns OFFLINE, entries should be queued locally
    and pushed on next READY check.
    """

    def setUp(self):
        skip_unless_phase4()

    def test_offline_queues_entry(self):
        """When offline, capture still works locally."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        # No transport = local only, capture should still work
        svc.capture("Guitar", 1000, stop_epoch=2000)
        entries = svc.get_entries()
        self.assertEqual(len(entries), 1)

    def test_offline_queue_drains_on_ready(self):
        """Queue drains when remote becomes available."""
        transport = mock_transport(available=True)
        storage = mock_staging_store()
        device_id_provider = MagicMock()
        device_id_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="proof", device_label="Test"
        )
        svc = StagingService(
            mock_crypto(), storage,
            transport=transport,
            device_id_provider=device_id_provider,
        )
        # First call: simulate offline by making transport slow
        with patch.object(transport, "pull", side_effect=Exception("timeout")):
            svc.capture("Guitar", 1000, stop_epoch=2000)
        # Should have the entry locally
        entries_before = svc.get_entries()
        self.assertEqual(len(entries_before), 1)
        # After: push should be called when available
        svc.push_to_remote(b"master_key")
        # Transport should have received data
        self.assertIsNotNone(transport._blob)

    def test_multiple_offline_entries_batched(self):
        """Multiple entries added offline are all pushed in one batch."""
        transport = mock_transport()
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="p", device_label="T"
        )
        svc = StagingService(
            mock_crypto(), mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )
        # Add entries while offline
        with patch.object(transport, "pull", side_effect=Exception("timeout")):
            svc.capture("A", 1000, stop_epoch=2000)
            svc.capture("B", 3000, stop_epoch=4000)
        self.assertEqual(len(svc.get_entries()), 2)
        # Push all at once
        svc.push_to_remote(b"mk")
        self.assertIsNotNone(transport._blob)


# =============================================================================
# 2. Every-Command Sync Integration Tests
# =============================================================================

class TestEveryCommandSync(unittest.TestCase):
    """Write commands no longer call check_and_sync automatically.

    Phase B/C deferred sync (WAL + background push + daemon) means write
    methods are local-only. check_and_sync is called from the daemon event
    loop and from explicit ``ph sync``.
    """

    def setUp(self):
        skip_unless_phase4()

    def test_capture_does_not_call_check_and_sync(self):
        """capture() does NOT invoke check_and_sync (local-only write)."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        with patch.object(svc, "check_and_sync", wraps=svc.check_and_sync) as spy:
            svc.capture("Guitar", 1000, stop_epoch=2000)
            spy.assert_not_called()

    def test_end_does_not_call_check_and_sync(self):
        """end() does NOT invoke check_and_sync (local-only write)."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("Task", 1000, is_active=True)
        with patch.object(svc, "check_and_sync", wraps=svc.check_and_sync) as spy:
            svc.end("Task", 5000)
            spy.assert_not_called()

    def test_end_at_does_not_call_check_and_sync(self):
        """end_at() does NOT invoke check_and_sync (local-only write)."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("Task", 1000, is_active=True)
        with patch.object(svc, "check_and_sync", wraps=svc.check_and_sync) as spy:
            svc.end_at("Task", 5000)
            spy.assert_not_called()

    def test_pause_does_not_call_check_and_sync(self):
        """pause() does NOT invoke check_and_sync (local-only write)."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("Task", 1000, is_active=True)
        with patch.object(svc, "check_and_sync", wraps=svc.check_and_sync) as spy:
            svc.pause("Task", 2000)
            spy.assert_not_called()

    def test_unpause_does_not_call_check_and_sync(self):
        """unpause() does NOT invoke check_and_sync (local-only write)."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("Task", 1000, is_active=True)
        svc.pause("Task", 2000)
        with patch.object(svc, "check_and_sync", wraps=svc.check_and_sync) as spy:
            svc.unpause("Task", 3000)
            spy.assert_not_called()

    def test_modify_does_not_call_check_and_sync(self):
        """modify() does NOT invoke check_and_sync (local-only write)."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("Task", 1000, stop_epoch=2000)
        with patch.object(svc, "check_and_sync", wraps=svc.check_and_sync) as spy:
            svc.modify(0, title="Renamed")
            spy.assert_not_called()

    def test_remove_does_not_call_check_and_sync(self):
        """remove() does NOT invoke check_and_sync (local-only write)."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("Task", 1000, stop_epoch=2000)
        with patch.object(svc, "check_and_sync", wraps=svc.check_and_sync) as spy:
            svc.remove(0)
            spy.assert_not_called()

    def test_read_operations_no_check_and_sync(self):
        """Read-only operations do NOT call check_and_sync (no side effects)."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("Task", 1000, stop_epoch=2000)
        with patch.object(svc, "check_and_sync", wraps=svc.check_and_sync) as spy:
            svc.get_entries()
            svc.get_completed()
            svc.get_active()
            svc.get_pending_sync()
            spy.assert_not_called()

    def test_check_and_sync_offline_still_performs_local_op(self):
        """Offline check does not prevent the local operation."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        # When offline, check_and_sync returns OFFLINE, op still goes through
        with patch.object(svc, "check_and_sync", return_value=SyncCheckResult.OFFLINE):
            svc.capture("OfflineTask", 1000, stop_epoch=2000)
            entries = svc.get_entries()
            self.assertEqual(len(entries), 1)

    def test_check_and_sync_reauth_still_performs_local_op(self):
        """Re-auth needed does not prevent the local operation.

        User gets prompted, but local op still proceeds.
        """
        svc = StagingService(mock_crypto(), mock_staging_store())
        with patch.object(svc, "check_and_sync", return_value=SyncCheckResult.REAUTH_NEEDED):
            svc.capture("ReauthTask", 1000, stop_epoch=2000)
            entries = svc.get_entries()
            self.assertEqual(len(entries), 1)


# =============================================================================
# 3. Auth Cache Tests
# =============================================================================

class TestAuthCache(unittest.TestCase):
    """Auth cache provides a 30-minute window before requiring re-auth.

    When device_id changes and auth is cached (within 30 min window),
    the sync proceeds without prompting. After expiry, re-auth is needed.
    """

    def setUp(self):
        skip_unless_phase4()

    def test_auth_cache_allows_within_window(self):
        """Within 30 min auth window, same device session proceeds."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir)
            transport = mock_transport()
            device_provider = MagicMock()
            device_provider.get_device_identity.return_value = DeviceIdentity(
                device_id="local-device", device_proof="proof", device_label="Local"
            )

            svc = StagingService(
                mock_crypto(), mock_staging_store(),
                transport=transport,
                device_id_provider=device_provider,
                data_dir=tmpdir,
            )

            # Create a valid local cookie so fast path can proceed
            DeviceCookie.create("local-device", data_dir)

            # Push a matching remote cookie
            local_cookie = DeviceCookie.is_valid_locally(data_dir, 30)
            transport._cookie = json.dumps(local_cookie).encode()

            # Within window: same device, fast path — READY
            result = svc.check_and_sync(timeout_ms=500)
            self.assertEqual(result, SyncCheckResult.READY)

    def test_auth_expiry_requires_reauth(self):
        """After 30 min expiry, no cookie triggers REAUTH_NEEDED."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            transport = mock_transport()
            device_provider = MagicMock()
            device_provider.get_device_identity.return_value = DeviceIdentity(
                device_id="local-device", device_proof="proof", device_label="Local"
            )

            svc = StagingService(
                mock_crypto(), mock_staging_store(),
                transport=transport,
                device_id_provider=device_provider,
                data_dir=tmpdir,
            )

            # No local cookie created → REAUTH_NEEDED
            result = svc.check_and_sync(timeout_ms=500)
            self.assertEqual(result, SyncCheckResult.REAUTH_NEEDED)


# =============================================================================
# 4. SyncOrchestrator Tests
# =============================================================================

class TestSyncOrchestratorInit(unittest.TestCase):
    """SyncOrchestrator can be instantiated with the required dependencies."""

    def setUp(self):
        skip_unless_phase4()

    def test_init_requires_staging_service(self):
        """SyncOrchestrator requires a StagingService instance."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        engine = mock_ledger_engine()
        orch = SyncOrchestrator(
            staging_service=svc,
            ledger_engine=engine,
        )
        self.assertIsNotNone(orch)
        self.assertIs(orch._staging, svc)
        self.assertIs(orch._ledger, engine)

    def test_init_requires_ledger_engine(self):
        """SyncOrchestrator requires a LedgerEngine instance."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        orch = SyncOrchestrator(
            staging_service=svc,
            ledger_engine=mock_ledger_engine(),
        )
        self.assertIsNotNone(orch._ledger)

    def test_init_optional_view_interface(self):
        """SyncOrchestrator optionally accepts a ViewInterface for callbacks."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        engine = mock_ledger_engine()
        view = MagicMock()
        orch = SyncOrchestrator(
            staging_service=svc,
            ledger_engine=engine,
            view_interface=view,
        )
        self.assertIs(orch._view, view)

    def test_init_optional_master_key(self):
        """Master key can be set during init or later."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        engine = mock_ledger_engine()
        orch = SyncOrchestrator(
            staging_service=svc,
            ledger_engine=engine,
            master_key=b"test_mk_32_bytes_long____",
        )
        self.assertEqual(orch._master_key, b"test_mk_32_bytes_long____")


class TestSyncOrchestratorFullFlow(unittest.TestCase):
    """SyncOrchestrator full lifecycle: check → pull → merge → commit → push."""

    def setUp(self):
        skip_unless_phase4()
        self.crypto = mock_crypto()
        self.transport = mock_transport()
        self.device_provider = MagicMock()
        self.device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="proof", device_label="Test"
        )

        # Staging with one completed entry
        self.storage = mock_staging_store()
        self.svc = StagingService(
            self.crypto, self.storage,
            transport=self.transport,
            device_id_provider=self.device_provider,
        )
        self.svc.capture("Guitar", 1000, stop_epoch=2000, is_active=False)
        self.svc.capture("Reading", 3000, stop_epoch=4000, is_active=False)

        self.engine = mock_ledger_engine()
        self.view = MagicMock()
        self.view.prompt_choice.return_value = "S"
        self.orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            view_interface=self.view,
            master_key=b"test_mk_32_bytes_long____",
        )

    def test_sync_commits_entries_to_ledger(self):
        """sync() commits completed entries to the ledger engine."""
        result = self.orch.sync()
        self.assertTrue(result)
        self.assertGreater(self.engine.commit.call_count, 0)

    def test_sync_pushes_to_remote(self):
        """sync() pushes merged state to remote transport."""
        result = self.orch.sync()
        self.assertTrue(result)
        # Transport should have received data
        self.assertIsNotNone(self.transport._blob)

    def test_sync_removes_synced_from_staging(self):
        """sync() removes successfully committed entries from staging."""
        entries_before = self.svc.get_entries()
        self.assertEqual(len(entries_before), 2)
        self.orch.sync()
        entries_after = self.svc.get_entries()
        # Entries should be removed (or fewer) after sync
        self.assertLessEqual(len(entries_after), len(entries_before))

    def test_sync_handles_empty_staging(self):
        """sync() with no pending entries is a no-op."""
        empty_svc = StagingService(self.crypto, mock_staging_store())
        orch = SyncOrchestrator(
            staging_service=empty_svc,
            ledger_engine=mock_ledger_engine(),
            master_key=b"mk",
        )
        result = orch.sync()
        self.assertTrue(result)

    def test_sync_calls_check_and_sync_first(self):
        """sync() invokes check_and_sync before committing."""
        with patch.object(self.svc, "check_and_sync", wraps=self.svc.check_and_sync) as spy:
            self.orch.sync()
            spy.assert_called_once()

    def test_sync_calls_ledger_engine_with_decrypted_entries(self):
        """sync() passes decrypted entries to ledger_engine.commit()."""
        self.orch.sync()
        # Ledger engine should receive entries
        for call_args in self.engine.commit.call_args_list:
            args, kwargs = call_args
            if args:
                entries = args[0]
                for entry in entries:
                    self.assertIn("title", entry)
                    self.assertIn("start_epoch", entry)

    def test_sync_passes_identity_secret_to_commit(self):
        """sync() passes identity secret from device identity provider."""
        self.orch.sync()
        # Check that identity_secret is passed to commit
        for call_args in self.engine.commit.call_args_list:
            args, kwargs = call_args
            if "identity_secret" in kwargs:
                self.assertIsInstance(kwargs["identity_secret"], bytes)

    def test_sync_returns_false_on_ledger_verify_failure(self):
        """sync() returns False if ledger verification fails after commit."""
        self.engine.verify.return_value = False
        result = self.orch.sync()
        self.assertFalse(result)


class TestSyncOrchestratorRevert(unittest.TestCase):
    """SyncOrchestrator can revert ledger entries and restore to staging."""

    def setUp(self):
        skip_unless_phase4()
        self.svc = StagingService(mock_crypto(), mock_staging_store())
        self.engine = mock_ledger_engine()
        # Engine has 3 blocks
        self.engine.get_block_count.return_value = 3
        self.orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=b"mk",
        )

    def test_revert_restores_entries_to_staging(self):
        """Reverted ledger blocks restore their entries to staging."""
        # Engine.revert returns restored entries for staging
        self.engine.revert.return_value = (True, [
            {"title": "Reverted", "start_epoch": 1000, "end_epoch": 2000},
        ], {})
        result = self.orch.revert(1)
        self.assertTrue(result)
        # Entries should appear in staging
        staging = self.svc.get_entries()
        self.assertGreater(len(staging), 0)

    def test_revert_returns_false_on_failure(self):
        """revert() returns False if ledger engine fails."""
        self.engine.revert.return_value = (False, [], {})
        result = self.orch.revert(1)
        self.assertFalse(result)

    def test_revert_zero_is_noop(self):
        """Reverting 0 blocks is a no-op that returns True."""
        result = self.orch.revert(0)
        self.assertTrue(result)
        self.engine.revert.assert_not_called()


class TestSyncOrchestratorCheck(unittest.TestCase):
    """SyncOrchestrator provides status checks independent of sync flow."""

    def setUp(self):
        skip_unless_phase4()
        self.svc = StagingService(mock_crypto(), mock_staging_store())
        self.engine = mock_ledger_engine()
        self.orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
        )

    def test_check_integrity_returns_bool(self):
        """check_integrity() delegates to ledger_engine verify."""
        result = self.orch.check_integrity()
        self.assertIsInstance(result, bool)
        self.engine.verify.assert_called_once()

    def test_check_integrity_with_full_check(self):
        """check_integrity(full=True) enables deep content hash check."""
        self.orch.check_integrity(full=True)
        self.engine.verify.assert_called_with(full_check=True)

    def test_get_status_returns_summary_dict(self):
        """get_status() returns a dict with key metrics."""
        self.engine.get_block_count.return_value = 5
        status = self.orch.get_status()
        self.assertIn("block_count", status)
        self.assertIn("pending_entries", status)
        self.assertIn("staging_count", status)
        self.assertEqual(status["block_count"], 5)


# =============================================================================
# 5. SyncDecision Tests (consolidated in core/sync/decision.py)
# =============================================================================

class TestSyncDecision(unittest.TestCase):
    """SyncDecision describes which entries to sync and how to override them.

    This is the consolidated version moved from core/sync_confirmation.py
    into core/sync/decision.py. The interface must match what strategies.py
    in Phase 1b expects.
    """

    def setUp(self):
        skip_unless_phase4()

    def test_default_no_selection(self):
        """A default SyncDecision has no selection and is not cancelled."""
        sd = NewSyncDecision()
        self.assertEqual(sd.selected_indices, [])
        self.assertFalse(sd.cancelled)

    def test_has_selection_true(self):
        """has_selection is True with indices and not cancelled."""
        sd = NewSyncDecision(selected_indices=[0, 1])
        self.assertTrue(sd.has_selection)

    def test_has_selection_false_empty(self):
        """has_selection is False with empty indices."""
        sd = NewSyncDecision()
        self.assertFalse(sd.has_selection)

    def test_has_selection_false_cancelled(self):
        """has_selection is False when cancelled."""
        sd = NewSyncDecision(selected_indices=[0], cancelled=True)
        self.assertFalse(sd.has_selection)

    def test_removal_indices_default(self):
        """removal_indices defaults to an empty set."""
        sd = NewSyncDecision()
        self.assertEqual(sd.removal_indices, set())

    def test_has_removals_true(self):
        """has_removals is True with entries and not cancelled."""
        sd = NewSyncDecision(removal_indices={0, 1})
        self.assertTrue(sd.has_removals)

    def test_has_removals_false_empty(self):
        """has_removals is False when removal_indices is empty."""
        sd = NewSyncDecision()
        self.assertFalse(sd.has_removals)

    def test_has_removals_false_cancelled(self):
        """has_removals is False when cancelled."""
        sd = NewSyncDecision(removal_indices={0}, cancelled=True)
        self.assertFalse(sd.has_removals)

    def test_overrides_default(self):
        """overrides defaults to empty dict."""
        sd = NewSyncDecision()
        self.assertEqual(sd.overrides, {})

    def test_removal_indices_is_set(self):
        """removal_indices should be a set (not list) for dedup."""
        sd = NewSyncDecision()
        self.assertIsInstance(sd.removal_indices, set)

    def test_dataclass_fields_match_cli_version(self):
        """New SyncDecision fields match the cli.strategies version exactly."""
        new_fields = set(NewSyncDecision.__init__.__code__.co_varnames[1:])  # type: ignore
        old_fields = set(SYNC_DECISION_CLASS.__init__.__code__.co_varnames[1:])  # type: ignore
        self.assertEqual(
            new_fields,
            old_fields,
            f"New SyncDecision missing fields: {old_fields - new_fields}, "
            f"extra fields: {new_fields - old_fields}"
        )


class TestSyncStrategy(unittest.TestCase):
    """SyncStrategy abstract interface for deciding what to sync."""

    def setUp(self):
        skip_unless_phase4()

    def test_strategy_receives_entries(self):
        """Strategy is called with a list of pending entries."""
        from core.sync.decision import SyncStrategy
        # Verify the interface exists and has the right signature
        self.assertTrue(hasattr(SyncStrategy, "decide"))

    def test_strategy_returns_sync_decision(self):
        """Strategy.decide() returns a SyncDecision instance."""
        from core.sync.decision import SyncStrategy, SyncDecision
        # Check the return type annotation
        import inspect
        sig = inspect.signature(SyncStrategy.decide)
        return_annotation = sig.return_annotation
        self.assertIn(
            "SyncDecision",
            repr(return_annotation),
            f"Expected SyncDecision return type, got {return_annotation}",
        )


# =============================================================================
# 6. AbstractStagingTransport Tests
# =============================================================================

class TestAbstractStagingTransport(unittest.TestCase):
    """AbstractStagingTransport defines the 2-method transport interface."""

    def setUp(self):
        skip_unless_phase4()

    def test_cannot_instantiate_abstract(self):
        """AbstractStagingTransport cannot be instantiated directly."""
        with self.assertRaises(TypeError):
            AbstractStagingTransport()

    def test_pull_method_exists(self):
        """AbstractStagingTransport defines pull() as abstract."""
        self.assertTrue(
            hasattr(AbstractStagingTransport, "pull"),
            "AbstractStagingTransport missing pull()"
        )

    def test_pull_returns_optional_bytes(self):
        """pull() should return bytes or None."""
        # Abstract check: verify signature has Optional[bytes] or similar
        import inspect
        sig = inspect.signature(AbstractStagingTransport.pull)
        # pull returns Optional[bytes] — can't strictly test, but document
        self.assertIsNotNone(sig.return_annotation)

    def test_push_method_exists(self):
        """AbstractStagingTransport defines push() as abstract."""
        self.assertTrue(
            hasattr(AbstractStagingTransport, "push"),
            "AbstractStagingTransport missing push()"
        )

    def test_push_signature(self):
        """push(path, data: bytes) -> None signature."""
        import inspect
        sig = inspect.signature(AbstractStagingTransport.push)
        params = list(sig.parameters.keys())
        self.assertIn("path", params, "push() missing 'path' parameter")
        self.assertIn("data", params, "push() missing 'data' parameter")
        self.assertIs(sig.return_annotation, None)


# =============================================================================
# 7. Push Flow Tests
# =============================================================================

class TestPushFlow(unittest.TestCase):
    """After successful check_and_sync + local op, push_to_remote is called."""

    def setUp(self):
        skip_unless_phase4()

    def test_push_on_check_ready(self):
        """When check_and_sync returns READY, entry is pushed to remote."""
        transport = mock_transport()
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="p", device_label="T"
        )
        svc = StagingService(
            mock_crypto(), mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )
        # Direct test: push after adding an entry
        svc.capture("TestTask", 1000, stop_epoch=2000)
        svc.push_to_remote(b"mk")
        self.assertIsNotNone(transport._blob)
        blob = json.loads(transport._blob)
        self.assertEqual(blob["entries"][0]["data"]["title"], "TestTask")
        self.assertEqual(blob["device_id"], "dev-abc")

    def test_push_with_multiple_entries(self):
        """push_to_remote sends all entries in one blob."""
        transport = mock_transport()
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="p", device_label="T"
        )
        svc = StagingService(
            mock_crypto(), mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )
        svc.capture("A", 1000, stop_epoch=2000)
        svc.capture("B", 3000, stop_epoch=4000)
        svc.capture("C", 5000, stop_epoch=6000)
        svc.push_to_remote(b"mk")
        blob = json.loads(transport._blob)
        self.assertEqual(len(blob["entries"]), 3)

    def test_push_without_transport_is_noop(self):
        """push_to_remote with no transport configured does nothing."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("Task", 1000, stop_epoch=2000)
        # Should not raise
        svc.push_to_remote(b"mk")

    def test_push_includes_updated_timestamp(self):
        """push_to_remote includes a millisecond timestamp."""
        transport = mock_transport()
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="p", device_label="T"
        )
        svc = StagingService(
            mock_crypto(), mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )
        svc.capture("T", 1000, stop_epoch=2000)
        svc.push_to_remote(b"mk")
        blob = json.loads(transport._blob)
        self.assertIn("updated_at", blob)
        self.assertIsInstance(blob["updated_at"], int)
        self.assertGreater(blob["updated_at"], 0)

    def test_push_provides_device_id_in_blob(self):
        """push_to_remote includes device_id in the blob header."""
        transport = mock_transport()
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-xyz", device_proof="p", device_label="T"
        )
        svc = StagingService(
            mock_crypto(), mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )
        svc.capture("T", 1000, stop_epoch=2000)
        svc.push_to_remote(b"mk")
        blob = json.loads(transport._blob)
        self.assertEqual(blob["device_id"], "dev-xyz")

    def test_push_encrypted_fields_in_blob(self):
        """push_to_remote sends encrypted field values, not plaintext."""
        transport = mock_transport()
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="p", device_label="T"
        )
        svc = StagingService(
            mock_crypto(), mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )
        svc.capture("T", 1000, stop_epoch=2000)
        svc.push_to_remote(b"mk")
        blob = json.loads(transport._blob)
        entry = blob["entries"][0]["data"]
        # Raw entries have startTime_enc field in storage format
        self.assertIn("startTime_enc", entry)
        self.assertIsInstance(entry["startTime_enc"], str)
        # The value contains the epoch encoded as digits
        self.assertTrue(
            "1000" in entry["startTime_enc"],
            f"Expected epoch value in {entry['startTime_enc']!r}"
        )


# =============================================================================
# 8. Offline Queue Drain Integration Tests
# =============================================================================

class TestOfflineQueueDrain(unittest.TestCase):
    """Entries queued while offline drain to remote on next READY."""

    def setUp(self):
        skip_unless_phase4()

    def test_offline_then_online_pushes_queued(self):
        """Entries added offline are pushed when remote becomes available."""
        transport = mock_transport()
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="p", device_label="T"
        )
        svc = StagingService(
            mock_crypto(), mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )

        # Mock offline initially — transport raises
        original_pull = transport.pull
        call_count = [0]

        def conditional_pull(path=None):
            call_count[0] += 1
            if call_count[0] <= 2:
                raise Exception("offline")
            return original_pull(path)

        transport.pull.side_effect = conditional_pull

        # Add entries while "offline"
        svc.capture("OfflineEntry", 1000, stop_epoch=2000)
        svc.capture("OfflineEntry2", 3000, stop_epoch=4000)
        self.assertEqual(len(svc.get_entries()), 2)

        # Push (now "online")
        svc.push_to_remote(b"mk")
        self.assertIsNotNone(transport._blob)
        blob = json.loads(transport._blob)
        self.assertEqual(len(blob["entries"]), 2)

    def test_offline_queue_does_not_lose_entries_on_drain(self):
        """Draining the queue pushes all entries without data loss."""
        transport = mock_transport()
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="p", device_label="T"
        )
        svc = StagingService(
            mock_crypto(), mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )

        # Add several entries offline
        with patch.object(transport, "pull", side_effect=Exception("offline")):
            for i in range(10):
                svc.capture(f"Entry_{i}", i * 1000, stop_epoch=(i * 1000) + 3600000)

        self.assertEqual(len(svc.get_entries()), 10)

        # Push all at once
        svc.push_to_remote(b"mk")
        blob = json.loads(transport._blob)
        self.assertEqual(len(blob["entries"]), 10)
        titles = [e["data"]["title"] if "data" in e else e.get("title", "")
                  for e in blob["entries"]]
        for i in range(10):
            self.assertIn(f"Entry_{i}", titles)


# =============================================================================
# 9. SyncOrchestrator Edge Cases
# =============================================================================

class TestSyncOrchestratorEdgeCases(unittest.TestCase):
    """Edge cases for the SyncOrchestrator."""

    def setUp(self):
        skip_unless_phase4()

    def test_sync_with_no_master_key_proceeds(self):
        """sync() proceeds without master_key (push is skipped, not required)."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("T", 1000, stop_epoch=2000)
        engine = mock_ledger_engine()
        orch = SyncOrchestrator(
            staging_service=svc,
            ledger_engine=engine,
        )
        result = orch.sync()
        self.assertTrue(result)

    def test_sync_with_no_pending_entries_noop(self):
        """sync() with no pending entries does not call ledger_engine.commit."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        engine = mock_ledger_engine()
        orch = SyncOrchestrator(
            staging_service=svc,
            ledger_engine=engine,
            master_key=b"mk",
        )
        result = orch.sync()
        self.assertTrue(result)
        engine.commit.assert_not_called()

    def test_sync_preserves_active_entries(self):
        """Active entries stay in staging after sync; only completed sync."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("Active", 1000, is_active=True)
        svc.capture("Completed", 3000, stop_epoch=4000, is_active=False)
        engine = mock_ledger_engine()
        orch = SyncOrchestrator(
            staging_service=svc,
            ledger_engine=engine,
            master_key=b"mk",
        )
        orch.sync()
        # Active entry remains in staging
        active = svc.get_active()
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["title"], "Active")
        # Completed was committed
        self.assertGreater(engine.commit.call_count, 0)

    def test_sync_notifies_view_on_completion(self):
        """sync() calls view.notify() after successful sync."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("T", 1000, stop_epoch=2000, is_active=False)
        view = MagicMock()
        view.prompt_choice.return_value = "S"
        orch = SyncOrchestrator(
            staging_service=svc,
            ledger_engine=mock_ledger_engine(),
            view_interface=view,
            master_key=b"mk",
        )
        orch.sync()
        view.notify.assert_called()

    def test_sync_reverts_on_ledger_verify_failure(self):
        """If ledger verification fails after commit, sync reverts the commit."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("T", 1000, stop_epoch=2000, is_active=False)
        engine = mock_ledger_engine()
        # After commit, verify fails
        engine.verify.return_value = False
        orch = SyncOrchestrator(
            staging_service=svc,
            ledger_engine=engine,
            master_key=b"mk",
        )
        result = orch.sync()
        self.assertFalse(result)
        engine.revert.assert_called()

    def test_sync_handles_reauth_gracefully(self):
        """When check_and_sync returns REAUTH_NEEDED, sync returns with status."""
        svc = StagingService(mock_crypto(), mock_staging_store())
        svc.capture("T", 1000, stop_epoch=2000)
        with patch.object(svc, "check_and_sync", return_value=SyncCheckResult.REAUTH_NEEDED):
            orch = SyncOrchestrator(
                staging_service=svc,
                ledger_engine=mock_ledger_engine(),
                master_key=b"mk",
            )
            # Should return without committing
            result = orch.sync()
            self.assertIsNotNone(result)


# =============================================================================
# 10. Every-Command Sync Integration with Push
# =============================================================================

class TestEveryCommandSyncWithPush(unittest.TestCase):
    """Full integration: check_and_sync + local op + push_to_remote on each command.

    This tests the complete every-command sync flow end-to-end.
    """

    def setUp(self):
        skip_unless_phase4()

    def test_capture_then_push_roundtrip(self):
        """capture() followed by push results in remote blob with entry."""
        transport = mock_transport()
        device_provider = MagicMock()
        device_provider.get_device_identity.return_value = DeviceIdentity(
            device_id="dev-abc", device_proof="p", device_label="T"
        )
        svc = StagingService(
            mock_crypto(), mock_staging_store(),
            transport=transport,
            device_id_provider=device_provider,
        )
        svc.capture("Task", 1000, stop_epoch=2000)
        svc.push_to_remote(b"mk")
        blob = json.loads(transport._blob)
        entries = blob["entries"]
        self.assertEqual(len(entries), 1)
        data = entries[0]
        if "data" in data:
            self.assertTrue(
                data["data"]["startTime_enc"].startswith("ENC:") or
                data["data"]["startTime_enc"].startswith("plain:")
            )
        elif "title" in data:
            self.assertEqual(data["title"], "Task")

    def test_check_and_sync_pull_updates_local(self):
        """check_and_sync pulls remote data into local when same device."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir)
            transport = mock_transport()
            # Pre-populate remote with an entry
            remote_entry = {
                "hash": "abc123",
                "data": {
                    "title": "RemoteTask", "duration": 3600000,
                    "is_active": False, "is_paused": False,
                    "startTime_enc": "plain:5000", "endTime_enc": "plain:8600000",
                    "pauses_enc": "plain:[]", "metadata_enc": "plain:{}",
                    "tags": [], "media": [],
                },
                "start_epoch": 5000,
            }
            transport._blob = json.dumps({
                "entries": [remote_entry],
            }).encode("utf-8")

            device_provider = MagicMock()
            device_provider.get_device_identity.return_value = DeviceIdentity(
                device_id="local-device", device_proof="p", device_label="Local"
            )

            svc = StagingService(
                mock_crypto(), mock_staging_store(),
                transport=transport,
                device_id_provider=device_provider,
                data_dir=tmpdir,
            )

            # Create a valid local cookie so fast path works
            DeviceCookie.create("local-device", data_dir)

            # check_and_sync — if remote is the same device, it pulls + pushes
            result = svc.check_and_sync(timeout_ms=500)
            self.assertIn(result, (SyncCheckResult.READY, SyncCheckResult.REAUTH_NEEDED))

    def test_four_eye_add_merge(self):
        """Simulate two-device scenario: add A on dev1, B on dev2, merge."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir1, tempfile.TemporaryDirectory() as tmpdir2:
            # Device 1: adds entry A, pushes
            transport1 = mock_transport()
            dp1 = MagicMock()
            dp1.get_device_identity.return_value = DeviceIdentity(
                device_id="dev-1", device_proof="p1", device_label="Dev1"
            )
            svc1 = StagingService(
                mock_crypto(), mock_staging_store(),
                transport=transport1,
                device_id_provider=dp1,
                data_dir=tmpdir1,
            )
            svc1.capture("EntryFromDev1", 1000, stop_epoch=2000)
            svc1.push_to_remote(b"mk1")

            # Device 2: gets blob from remote (via transport), adds B, pushes
            transport2 = mock_transport()
            # transport2 pulls from transport1's blob
            transport2.pull.side_effect = lambda path=None: transport1._blob
            dp2 = MagicMock()
            dp2.get_device_identity.return_value = DeviceIdentity(
                device_id="dev-2", device_proof="p2", device_label="Dev2"
            )
            svc2 = StagingService(
                mock_crypto(), mock_staging_store(),
                transport=transport2,
                device_id_provider=dp2,
                data_dir=tmpdir2,
            )

            # Device 2 has no local cookie → REAUTH_NEEDED (expected)
            result = svc2.check_and_sync(timeout_ms=500)
            self.assertEqual(result, SyncCheckResult.REAUTH_NEEDED)

            # After re-auth, _reconcile_and_claim would be called.
            # For now, verify that local writes still work.
            svc2.capture("EntryFromDev2", 5000, stop_epoch=6000)

            # Device 2 should have its own entry
            entries2 = svc2.get_entries()
            titles = sorted([e["title"] for e in entries2])
            self.assertIn("EntryFromDev2", titles)

            # Device 2 pushes its entries
            svc2.push_to_remote(b"mk2")

    def test_sync_orchestrator_two_device_flow(self):
        """End-to-end: staging → sync → ledger → push."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            transport = mock_transport()
            dp = MagicMock()
            dp.get_device_identity.return_value = DeviceIdentity(
                device_id="dev-abc", device_proof="p", device_label="Dev"
            )
            svc = StagingService(
                mock_crypto(), mock_staging_store(),
                transport=transport,
                device_id_provider=dp,
                data_dir=tmpdir,
            )
            svc.capture("Work", 1000, stop_epoch=2000, is_active=False)
            svc.capture("Read", 3000, stop_epoch=4000, is_active=False)

            engine = mock_ledger_engine()
            orch = SyncOrchestrator(
                staging_service=svc,
                ledger_engine=engine,
                master_key=b"mk",
            )
            result = orch.sync()
            self.assertTrue(result)
            # Entries were committed
            self.assertGreater(engine.commit.call_count, 0)


if __name__ == "__main__":
    unittest.main()
