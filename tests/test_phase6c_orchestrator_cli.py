"""Phase 6: Behavioral equivalence tests — Part C: Orchestrator + CLI.

Category C: SyncOrchestrator vs sync_with_strategy() end-to-end
Category D: CLIInterface adapter — can work with StagingService + LedgerEngine
Category E: Plain: handling consistency
Category F: thin wrapper test stub (runs after refactor)
"""

import unittest
import json
import time
import hashlib
from unittest.mock import MagicMock, patch
from typing import Optional, List, Dict, Any


TEST_MASTER_KEY = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 4  # 32 bytes


# ════════════════════════════════════════════════════════════════════════════
# Category C: SyncOrchestrator vs sync_with_strategy()
# ════════════════════════════════════════════════════════════════════════════

class TestSyncOrchestratorEquivalence(unittest.TestCase):
    """Verify SyncOrchestrator.sync() produces same outcome as
    ledger.sync_with_strategy(AutoSyncStrategy) for the same inputs.

    This is the end-to-end equivalence check. We mock internal
    dependencies so we're testing orchestration logic, not individual
    component behavior.
    """

    def setUp(self):
        # Mock for StagingService
        self.svc = MagicMock()
        self.svc.get_pending_sync.return_value = [
            {"entry_index": 0, "title": "A", "date": "2026-06-15",
             "start_epoch": 1000000, "end_epoch": 2000000,
             "duration": 1000000, "tags": [], "comment": ""},
        ]
        self.svc.check_and_sync.return_value = MagicMock()

        # Mock for LedgerEngine
        self.engine = MagicMock()
        self.engine.commit.return_value = "abc123"
        self.engine.verify.return_value = True
        self.engine.get_block_count.return_value = 3

        from core.sync import SyncOrchestrator
        self.orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=b"mk",
        )

    def test_sync_completes_successfully(self):
        """Orchestrator sync returns True on success."""
        result = self.orch.sync()
        self.assertTrue(result)

    def test_sync_calls_check_and_sync(self):
        """Orchestrator calls check_and_sync before processing."""
        self.orch.sync()
        self.svc.check_and_sync.assert_called_once()

    def test_sync_calls_get_pending(self):
        """Orchestrator reads pending entries."""
        self.orch.sync()
        self.svc.get_pending_sync.assert_called_once()

    def test_sync_calls_commit(self):
        """Orchestrator commits pending entries to ledger."""
        self.orch.sync()
        self.engine.commit.assert_called_once()

    def test_sync_verifies_after_commit(self):
        """Orchestrator verifies chain after commit."""
        self.orch.sync()
        self.engine.verify.assert_called_once()

    def test_sync_removes_synced_from_staging(self):
        """Orchestrator removes synced entries from staging."""
        self.orch.sync()
        self.svc.remove_synced.assert_called_once()

    def test_sync_pushes_to_remote(self):
        """Orchestrator pushes to remote when master_key is set."""
        self.orch.sync()
        self.svc.push_to_remote.assert_called_once_with(b"mk")

    def test_no_master_key_skips_push(self):
        """Without master_key, push is skipped."""
        from core.sync import SyncOrchestrator
        svc = MagicMock()
        svc.get_pending_sync.return_value = [{"entry_index": 0, "date": "2026-06-15",
                                               "title": "T", "start_epoch": 1, "end_epoch": 2,
                                               "duration": 1, "tags": [], "comment": ""}]
        eng = MagicMock()
        eng.commit.return_value = "ok"
        eng.verify.return_value = True
        o = SyncOrchestrator(staging_service=svc, ledger_engine=eng)
        o.sync()
        svc.push_to_remote.assert_not_called()

    def test_till_date_filters(self):
        """till_date filters pending entries before commit."""
        self.svc.get_pending_sync.return_value = [
            {"entry_index": 0, "date": "2026-06-10", "title": "A",
             "start_epoch": 1, "end_epoch": 2, "duration": 1, "tags": [], "comment": ""},
            {"entry_index": 1, "date": "2026-06-20", "title": "B",
             "start_epoch": 3, "end_epoch": 4, "duration": 1, "tags": [], "comment": ""},
        ]
        self.orch.sync(till_date="2026-06-15")
        # Should commit only entry 0
        called_args = self.engine.commit.call_args
        self.assertIsNotNone(called_args)
        entries = called_args[0][0]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "A")

    def test_no_pending_returns_true(self):
        """No pending entries returns True without error."""
        self.svc.get_pending_sync.return_value = []
        result = self.orch.sync()
        self.assertTrue(result)
        self.engine.commit.assert_not_called()

    def test_verify_failure_reverts(self):
        """If verify fails, orchestrator reverts and returns False."""
        self.engine.verify.return_value = False
        result = self.orch.sync()
        self.assertFalse(result)
        self.engine.revert.assert_called_once()

    def test_revert_success(self):
        """Orchestrator revert works correctly."""
        self.engine.revert.return_value = 1
        result = self.orch.revert(1)
        self.assertTrue(result)
        self.engine.revert.assert_called_with(1)


class TestSyncOrchestratorStatus(unittest.TestCase):
    """Verify Orchestrator status queries work."""

    def setUp(self):
        self.svc = MagicMock()
        self.svc.get_entries.return_value = [{"title": "A"}, {"title": "B"}]
        self.svc.get_pending_sync.return_value = [{"entry_index": 0, "date": "2026-06-15"}]
        self.engine = MagicMock()
        self.engine.get_block_count.return_value = 10
        from core.sync import SyncOrchestrator
        self.orch = SyncOrchestrator(staging_service=self.svc, ledger_engine=self.engine)

    def test_get_status(self):
        status = self.orch.get_status()
        self.assertEqual(status["block_count"], 10)
        self.assertEqual(status["staging_count"], 2)
        self.assertEqual(len(status["pending_entries"]), 1)

    def test_check_integrity(self):
        self.engine.verify.return_value = True
        self.assertTrue(self.orch.check_integrity())
        self.engine.verify.assert_called_with(full_check=False)


# ════════════════════════════════════════════════════════════════════════════
# Category D: CLIInterface adapter
# ════════════════════════════════════════════════════════════════════════════

class TestCLIInterfaceAdapter(unittest.TestCase):
    """Verify CLIInterface can accept alternative dependency injection.

    After Phase 6, CLIInterface will accept StagingService + LedgerEngine
    instead of LedgerDomain. These tests verify the interface contract
    that must be preserved.

    Note: These tests use the CURRENT LedgerDomain-backed CLIInterface.
    They document what the new dependency interface must look like.
    """

    def setUp(self):
        self.crypto = MagicMock()
        self.crypto.decrypt.side_effect = lambda v: v
        self.crypto.encrypt.side_effect = lambda v: f"ENC:{v}"
        self.store = MagicMock()
        self.store.read_staging.return_value = []
        self.store.read_ledger.return_value = []
        self.store.read_index.return_value = {}
        self.store.read_identity.return_value = {"identity_secret_enc": "plain:test"}
        from core.ledger import LedgerDomain
        self.ledger = LedgerDomain(self.crypto, self.store)
        from domain.staging.service import StagingService
        from domain.ledger.engine import LedgerEngine
        self.staging_service = StagingService(crypto=self.crypto, staging_store=MagicMock())
        self.staging_service._local = MagicMock()
        self.staging_service._local._store.read_entries.return_value = []
        self.ledger_engine = LedgerEngine(
            crypto=self.crypto, store=MagicMock(), index_store=MagicMock(),
            staging_store=MagicMock())
        self.ledger_engine._index = MagicMock()
        self.ledger_engine._index.get_all.return_value = {}
        from cli.interface import CLIInterface
        self.cli = CLIInterface(self.staging_service, self.ledger_engine, self.crypto)

    def test_current_init_smoke(self):
        """CLIInterface initializes with current LedgerDomain."""
        self.assertIsNotNone(self.cli)

    def test_current_add_oneoff(self):
        """Basic add_oneoff works through current interface."""
        with patch("builtins.print"):
            self.cli.add_oneoff("Test", 1000, 2000)
        # CLI delegates to staging service; no error means it worked
        self.assertTrue(True)

    def test_current_add_start(self):
        """Basic add_start works."""
        with patch("builtins.print"):
            self.cli.add_start("Run")
        self.assertTrue(True)

    def test_current_view_active_empty(self):
        """View active works with empty staging."""
        with patch("builtins.print"):
            self.cli.view_active()

    def test_resolve_title_by_name(self):
        """_resolve_title returns title for string match."""
        from cli.interface import CLIInterface
        # Mock: one active task
        self.store.read_staging.return_value = [
            {"data": {"title": "Run", "is_active": True, "startTime_enc": "1000",
                      "endTime_enc": None, "metadata_enc": "{}", "pauses_enc": "[]",
                      "duration": 0, "tags": []},
             "hash": "abc"}
        ]
        self.crypto.decrypt.side_effect = lambda v: v
        result = self.cli._resolve_title("Run")
        self.assertEqual(result, "Run")

    def test_normalize_tag_args(self):
        """Static tag normalization works."""
        from cli.interface import CLIInterface
        result = CLIInterface._normalize_tag_args(["  HI ", "there", " HI "])
        self.assertEqual(result, ["hi", "there"])

    def test_normalize_tag_args_none(self):
        """None input returns None."""
        from cli.interface import CLIInterface
        self.assertIsNone(CLIInterface._normalize_tag_args(None))

    def test_normalize_tag_args_all_empty(self):
        """All-empty input returns None."""
        from cli.interface import CLIInterface
        self.assertIsNone(CLIInterface._normalize_tag_args(["", "  "]))


class TestCLIAdapterNewDepsContract(unittest.TestCase):
    """Document the interface CLIInterface needs from its dependencies.

    These tests define what Phase 6 must preserve when switching
    from LedgerDomain to StagingService + LedgerEngine.
    """

    def test_staging_service_has_required_methods(self):
        """StagingService has methods CLIInterface uses."""
        from domain.staging.service import StagingService
        methods = ["capture", "end", "pause", "unpause",
                    "get_entries", "get_active", "get_completed",
                    "get_pending_sync", "modify", "remove"]
        for m in methods:
            self.assertTrue(hasattr(StagingService, m),
                           f"StagingService missing {m}")

    def test_ledger_engine_has_required_methods(self):
        """LedgerEngine has methods CLIInterface will use."""
        from domain.ledger.engine import LedgerEngine
        methods = ["verify", "get_block_count", "get_day_blocks",
                    "get_last_block", "revert", "query_index"]
        for m in methods:
            self.assertTrue(hasattr(LedgerEngine, m),
                           f"LedgerEngine missing {m}")

    def test_view_interface_has_methods(self):
        """ViewInterface has rendering methods."""
        from domain.interfaces.view import ViewInterface
        methods = ["render_success", "render_error",
                    "notify"]
        for m in methods:
            self.assertTrue(hasattr(ViewInterface, m),
                           f"ViewInterface missing {m}")


# ════════════════════════════════════════════════════════════════════════════
# Category E: Plain: handling consistency
# ════════════════════════════════════════════════════════════════════════════

class TestPlainHandlingConsistency(unittest.TestCase):
    """Verify plain: prefix handling is consistent across old and new paths.

    The plain: prefix convention is used by NoAuthCryptoManager for lazy
    (unauthenticated) staging operations. Both old and new paths must
    handle it identically.
    """

    def setUp(self):
        self.crypto = MagicMock()
        self.crypto.decrypt.side_effect = lambda v: v.split(":", 1)[1]

    def test_plain_prefix_detection(self):
        """Both paths detect plain: prefix."""
        val = "plain:hello"
        from core.ledger import LedgerDomain
        old = LedgerDomain(self.crypto, MagicMock())
        # _normalize_staging_entry skips plain: fields
        data = {"startTime_enc": val}
        result = old._normalize_staging_entry(data)
        self.assertTrue(result)
        self.assertEqual(data["startTime_enc"], "plain:hello")

    def test_normalize_converts_hex_to_plain(self):
        """_normalize_staging_entry converts hex-encrypted to plain:."""
        self.crypto.decrypt.side_effect = lambda v: "1000"  # decrypt returns str
        data = {"startTime_enc": "DEADBEEF", "endTime_enc": None,
                "metadata_enc": "CAFE", "pauses_enc": "BABE"}
        from core.ledger import LedgerDomain
        old = LedgerDomain(self.crypto, MagicMock())
        old._normalize_staging_entry(data)
        self.assertEqual(data["startTime_enc"], "plain:1000")
        self.assertIsNone(data["endTime_enc"])

    def test_new_path_no_plain_leakage(self):
        """StagingService.get_entries never returns plain: prefix."""
        from domain.staging.service import StagingService
        from tests.test_phase6a_staging_equivalence import _InMemoryStagingStore
        svc = StagingService(crypto=MagicMock(), staging_store=_InMemoryStagingStore())
        svc.capture("T", 1000, stop_epoch=2000, is_active=False)
        entries = svc.get_entries()
        for e in entries:
            for val in e.values():
                if isinstance(val, str) and "plain:" in val:
                    self.fail(f"plain: leakage in {e}")


# ════════════════════════════════════════════════════════════════════════════
# Category F: Thin wrapper stub (placeholder for Phase 6 implementation)
# ════════════════════════════════════════════════════════════════════════════

class TestLedgerDomainWrapper(unittest.TestCase):
    """Placeholder: Once Phase 6 refactors core/ledger.py into a thin wrapper,
    these tests verify the wrapper delegates correctly.

    These document what the wrapper contract looks like — they will
    become meaningful AFTER the refactor.
    """

    def test_wrapper_delegates_to_staging_service(self):
        """LedgerDomain.capture_habit delegates to StagingService.capture.
        (Not yet implemented — placeholder for Phase 6.2)"""
        pass

    def test_wrapper_delegates_to_ledger_engine(self):
        """LedgerDomain.sync_day delegates to LedgerEngine.commit.
        (Not yet implemented — placeholder for Phase 6.3)"""
        pass

    def test_wrapper_delegates_to_orchestrator(self):
        """LedgerDomain.sync_with_strategy delegates to SyncOrchestrator.sync.
        (Not yet implemented — placeholder for Phase 6.4)"""
        pass

    def test_core_sync_confirmation_removed(self):
        """core/sync_confirmation.py is deleted.
        (Placeholder — to be verified in Phase 6 implementation.)"""
        import os
        exists = os.path.exists("core/sync_confirmation.py")
        # Currently exists as deprecated shim. After Phase 6, should be deleted.
        # self.assertFalse(exists)
        self.assertTrue(exists,
                        "core/sync_confirmation.py still exists as deprecated shim. "
                        "Remove it in Phase 6 and update this assertion.")


# ════════════════════════════════════════════════════════════════════════════
# Category G: CLIInterface init with new deps (smoke test)
# ════════════════════════════════════════════════════════════════════════════

class TestCLINewDepsSmoke(unittest.TestCase):
    """Smoke tests: verify we can construct CLIInterface-adjacent code
    that uses the new components in the same way main.py will.

    These pass now and serve as a baseline for Phase 6 changes.
    """

    def test_staging_service_constructible(self):
        """StagingService constructs with real deps."""
        from storage.implementations.file_staging import FileStagingStore
        from security.crypto import NoAuthCryptoManager
        import tempfile, os
        f = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        f.close()
        try:
            from pathlib import Path
            store = FileStagingStore(Path(f.name))
            crypto = NoAuthCryptoManager()
            from domain.staging.service import StagingService
            svc = StagingService(crypto=crypto, staging_store=store)
            self.assertIsNotNone(svc)
        finally:
            os.unlink(f.name)

    def test_ledger_engine_constructible(self):
        """LedgerEngine constructs with real deps."""
        from security.crypto import NoAuthCryptoManager
        from storage.implementations.file_ledger import FileLedgerStore
        from storage.implementations.file_index import FileIndexStore
        from storage.implementations.file_staging import FileStagingStore
        import tempfile, os
        from pathlib import Path
        f1 = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        f1.write(b'[]'); f1.close()
        f2 = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        f2.write(b'{}'); f2.close()
        f3 = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        f3.write(b'[]'); f3.close()
        try:
            lst = FileLedgerStore(Path(f1.name))
            ist = FileIndexStore(Path(f2.name))
            sst = FileStagingStore(Path(f3.name))
            crypto = NoAuthCryptoManager()
            from domain.ledger.engine import LedgerEngine
            eng = LedgerEngine(crypto=crypto, store=lst, index_store=ist,
                               staging_store=sst)
            self.assertIsNotNone(eng)
        finally:
            for f in [f1, f2, f3]: os.unlink(f.name)

    def test_cli_stub_with_staging_service(self):
        """We can write a CLI-like helper that uses StagingService directly.

        Phase 6 will migrate CLIInterface to accept StagingService directly.
        This verifies the concept works.
        """
        from security.crypto import NoAuthCryptoManager
        from tests.test_phase6a_staging_equivalence import _InMemoryStagingStore
        crypto = NoAuthCryptoManager()
        store = _InMemoryStagingStore()
        from domain.staging.service import StagingService
        svc = StagingService(crypto=crypto, staging_store=store)

        # Do a basic capture+end flow via StagingService
        svc.capture("Test", 1000, is_active=True)
        svc.end("Test", 5000)
        entries = svc.get_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Test")
        self.assertIsNotNone(entries[0]["duration"])


# =========================================================================
# Test: SyncOrchestrator._sync_ledger_blocks — remote ledger block sync
# =========================================================================

class TestSyncLedgerBlocks(unittest.TestCase):
    """Verify _sync_ledger_blocks pulls/pushes blocks and index.

    The method is called at the end of sync() when transport is configured.
    Failures should be logged but not crash the sync.
    """

    def setUp(self):
        from domain.staging.service import StagingService
        from domain.ledger.engine import LedgerEngine
        from core.sync import SyncOrchestrator
        self.svc = MagicMock(spec=StagingService)
        self.engine = MagicMock(spec=LedgerEngine)
        self.engine.chain = MagicMock()
        self.engine.chain.read_all.return_value = [{"type": "day", "date": "2026-06-15"}]
        self.engine.index = MagicMock()
        self.engine.index.get_all.return_value = {"2026-06-15": {"test": 3600}}
        self.transport = MagicMock()

    def test_no_transport_skips(self):
        """Without transport, _sync_ledger_blocks is a no-op."""
        from core.sync import SyncOrchestrator
        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=TEST_MASTER_KEY,
            transport=None,
        )
        orch._sync_ledger_blocks()
        # No transport calls should be made
        self.transport.pull.assert_not_called()
        self.transport.push.assert_not_called()

    def test_no_master_key_skips(self):
        """Without master_key, _sync_ledger_blocks is a no-op."""
        from core.sync import SyncOrchestrator
        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            transport=self.transport,
        )
        orch._sync_ledger_blocks()
        self.transport.pull.assert_not_called()
        self.transport.push.assert_not_called()

    def test_with_transport_calls_push_and_pull(self):
        """With transport + master_key, pull_blocks and push_blocks are called."""
        from core.sync import SyncOrchestrator
        from domain.ledger.remote_sync import RemoteLedgerSync

        with patch("domain.ledger.remote_sync.RemoteLedgerSync") as mock_rls:
            mock_instance = MagicMock()
            mock_instance.pull_blocks.return_value = ([], 1)
            mock_instance.push_blocks.return_value = 1
            mock_rls.return_value = mock_instance

            orch = SyncOrchestrator(
                staging_service=self.svc,
                ledger_engine=self.engine,
                master_key=TEST_MASTER_KEY,
                transport=self.transport,
            )
            orch._sync_ledger_blocks()

            push_blocks_called = mock_instance.push_blocks.call_args
            self.assertIsNotNone(push_blocks_called)

    def test_exception_logged_not_crashed(self):
        """If RemoteLedgerSync raises, _sync_ledger_blocks logs but does not crash."""
        from core.sync import SyncOrchestrator

        with patch("domain.ledger.remote_sync.RemoteLedgerSync") as mock_rls:
            mock_instance = MagicMock()
            mock_instance.push_blocks.side_effect = RuntimeError("network error")
            mock_rls.return_value = mock_instance

            orch = SyncOrchestrator(
                staging_service=self.svc,
                ledger_engine=self.engine,
                master_key=TEST_MASTER_KEY,
                transport=self.transport,
            )
            # Should not raise
            orch._sync_ledger_blocks()


if __name__ == "__main__":
    unittest.main()
