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
        from phpoc_cli.interface import CLIInterface
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
        from phpoc_cli.interface import CLIInterface
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
        from phpoc_cli.interface import CLIInterface
        result = CLIInterface._normalize_tag_args(["  HI ", "there", " HI "])
        self.assertEqual(result, ["hi", "there"])

    def test_normalize_tag_args_none(self):
        """None input returns None."""
        from phpoc_cli.interface import CLIInterface
        self.assertIsNone(CLIInterface._normalize_tag_args(None))

    def test_normalize_tag_args_all_empty(self):
        """All-empty input returns None."""
        from phpoc_cli.interface import CLIInterface
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


# =========================================================================
# Test: SyncOrchestrator._sync_ledger_blocks — same-genesis merge
# =========================================================================

class TestSyncLedgerBlocksMerge(unittest.TestCase):
    """Verify same-genesis divergence detection and LedgerMerge integration.

    When pull_blocks detects divergence (returns None) and genesis matches,
    the orchestrator should offer interactive merge and call LedgerMerge.
    """

    def setUp(self):
        from domain.staging.service import StagingService
        from core.sync import SyncOrchestrator

        # Mock crypto — needed by _try_ledger_merge for LedgerMerge.merge()
        self.mock_crypto = MagicMock()
        self.mock_crypto.seal.return_value = "a" * 64
        self.mock_crypto.sign.return_value = "b" * 64
        self.mock_crypto.decrypt.return_value = "1000000000"
        self.mock_crypto.verifySeal.return_value = True
        self.mock_crypto.verifySignature.return_value = True

        self.svc = MagicMock(spec=StagingService)
        self.engine = MagicMock()  # Not spec=LedgerEngine — need .chain .index
        self.engine.crypto = self.mock_crypto
        self.engine.identity_secret = None

        # Chain mock — genesis + 2 day blocks
        self.local_blocks = [
            {"type": "genesis", "day_index": 0, "date": "2026-01-01",
             "prev_hash": "0" * 64, "day_hash": "genhash", "entries": []},
            {"type": "day", "day_index": 1, "date": "2026-01-02",
             "prev_hash": "genhash", "day_hash": "block1",
             "entries": [{"hash": "h1", "data": {"title": "Task A",
                          "startTime_enc": "enc:1000000000",
                          "endTime_enc": "enc:1000003600",
                          "duration": 3600000}}]},
            {"type": "day", "day_index": 2, "date": "2026-01-03",
             "prev_hash": "block1", "day_hash": "block2",
             "entries": [{"hash": "h2", "data": {"title": "Task B",
                          "startTime_enc": "enc:2000000000",
                          "endTime_enc": "enc:2000003600",
                          "duration": 3600000}}]},
        ]
        self.engine.chain.read_all.return_value = list(self.local_blocks)

        # Index mock
        self.engine.index = MagicMock()
        self.engine.index.get_all.return_value = {}

        self.transport = MagicMock()
        self.view = MagicMock()
        self.view.prompt_choice.return_value = "M"  # Default: accept merge

    def _make_orchestrator(self, view=True):
        from core.sync import SyncOrchestrator
        return SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            view_interface=self.view if view else None,
            master_key=TEST_MASTER_KEY,
            transport=self.transport,
        )

    # ── Merge accepted ──────────────────────────────────────────

    def test_merge_accepted_replaces_chain(self):
        """User accepts merge → LedgerMerge called → chain/index replaced."""
        from core.sync import SyncOrchestrator

        orch = self._make_orchestrator()

        # Remote genesis matches local
        remote_genesis = dict(self.local_blocks[0])

        # Remote chain has different blocks after genesis
        remote_blocks = [
            self.local_blocks[0],  # Same genesis
            {"type": "day", "day_index": 1, "date": "2026-01-02",
             "prev_hash": "genhash", "day_hash": "remote_block1",
             "entries": [{"hash": "h3", "data": {"title": "Task C",
                          "startTime_enc": "enc:1000000000",
                          "endTime_enc": "enc:1000007200",
                          "duration": 7200000}}]},
        ]

        merged_chain = [
            self.local_blocks[0],  # Genesis
            {"type": "day", "day_index": 1, "date": "2026-01-02",
             "prev_hash": "genhash", "day_hash": "merged1",
             "entries": [
                 {"hash": "h1", "data": {"title": "Task A",
                              "startTime_enc": "enc:1000000000",
                              "endTime_enc": "enc:1000003600",
                              "duration": 3600000}},
                 {"hash": "h3", "data": {"title": "Task C",
                              "startTime_enc": "enc:1000000000",
                              "endTime_enc": "enc:1000007200",
                              "duration": 7200000}},
             ]},
        ]
        merged_index = {"2026-01-02": {"Task A": 3600000, "Task C": 7200000}}

        with patch("domain.ledger.remote_sync.RemoteLedgerSync") as mock_rls:
            mock_instance = MagicMock()
            # pull_blocks returns None, remote_count=2 → divergence detected
            mock_instance.pull_blocks.return_value = (None, 2)
            mock_instance.push_blocks.return_value = 2
            # Genesis check: same genesis
            mock_instance.pull_block_by_index.return_value = remote_genesis
            # Full chain pull
            mock_instance.pull_full_chain.return_value = remote_blocks
            mock_instance._list_remote_block_indices.return_value = {0, 1}
            mock_rls.return_value = mock_instance

            with patch("core.sync.orchestrator.asyncio.run") as mock_async_run:
                mock_async_run.return_value = {
                    "mergedChain": merged_chain,
                    "index": merged_index,
                    "stats": {
                        "forkIndex": 0,
                        "localEntries": 2,
                        "remoteEntries": 1,
                        "duplicatesSkipped": 0,
                        "mergedEntries": 3,
                        "newBlockCount": 1,
                    },
                }

                orch._sync_ledger_blocks()

        # Verify merge prompt was shown
        self.view.render_warning.assert_called()
        self.view.prompt_choice.assert_called_once()

        # Verify chain was replaced (append called for new blocks)
        self.engine.chain.truncate.assert_called()
        self.engine.chain.append.assert_called()

        # Verify index was cleared and updated
        self.engine.index.clear.assert_called()
        self.engine.index.update.assert_called()

        # Verify force-push of merged chain
        force_push_call = mock_instance.push_blocks.call_args
        self.assertIsNotNone(force_push_call)
        self.assertTrue(force_push_call[1].get("force", False))

        # Success notification
        self.view.render_success.assert_called()

    # ── Merge cancelled by user ─────────────────────────────────

    def test_merge_cancelled_returns_early(self):
        """User cancels merge → no merge, no push, no error."""
        orch = self._make_orchestrator()
        self.view.prompt_choice.return_value = "C"  # Cancel

        remote_genesis = dict(self.local_blocks[0])

        with patch("domain.ledger.remote_sync.RemoteLedgerSync") as mock_rls:
            mock_instance = MagicMock()
            mock_instance.pull_blocks.return_value = (None, 2)
            mock_instance.pull_block_by_index.return_value = remote_genesis
            mock_instance._list_remote_block_indices.return_value = {0, 1}
            mock_rls.return_value = mock_instance

            orch._sync_ledger_blocks()

        # Merge prompt shown, user chose Cancel
        self.view.prompt_choice.assert_called_once()

        # pull_full_chain should NOT be called (user cancelled before pull)
        mock_instance.pull_full_chain.assert_not_called()

        # LedgerMerge should NOT be called
        self.engine.index.clear.assert_not_called()

    # ── Merge skipped by user ───────────────────────────────────

    def test_merge_skipped_falls_through(self):
        """User skips merge → push_blocks proceeds normally (not force)."""
        orch = self._make_orchestrator()
        self.view.prompt_choice.return_value = "S"  # Skip

        remote_genesis = dict(self.local_blocks[0])

        with patch("domain.ledger.remote_sync.RemoteLedgerSync") as mock_rls:
            mock_instance = MagicMock()
            mock_instance.pull_blocks.return_value = (None, 2)
            mock_instance.pull_block_by_index.return_value = remote_genesis
            mock_instance.push_blocks.return_value = 0
            mock_instance._list_remote_block_indices.return_value = {0, 1}
            mock_rls.return_value = mock_instance

            orch._sync_ledger_blocks()

        # Merge prompt shown
        self.view.prompt_choice.assert_called_once()

        # pull_full_chain should NOT be called
        mock_instance.pull_full_chain.assert_not_called()

        # push_blocks is still called (normal push, not force)
        push_call = mock_instance.push_blocks.call_args
        self.assertIsNotNone(push_call)
        # Not a force push (skip falls through to normal push path)
        self.assertFalse(push_call[1].get("force", False))

    # ── No view interface ───────────────────────────────────────

    def test_no_view_interface_skips_merge(self):
        """Without ViewInterface, merge is skipped silently."""
        orch = self._make_orchestrator(view=False)

        remote_genesis = dict(self.local_blocks[0])

        with patch("domain.ledger.remote_sync.RemoteLedgerSync") as mock_rls:
            mock_instance = MagicMock()
            mock_instance.pull_blocks.return_value = (None, 2)
            mock_instance.pull_block_by_index.return_value = remote_genesis
            mock_instance.push_blocks.return_value = 0
            mock_instance._list_remote_block_indices.return_value = {0, 1}
            mock_rls.return_value = mock_instance

            orch._sync_ledger_blocks()

        # No merge attempted
        mock_instance.pull_full_chain.assert_not_called()

    # ── Genesis mismatch ────────────────────────────────────────

    def test_genesis_mismatch_no_merge(self):
        """When genesis hashes differ, no merge attempted → stale handling."""
        orch = self._make_orchestrator()

        # Different genesis hash
        remote_genesis = dict(self.local_blocks[0])
        remote_genesis["day_hash"] = "DIFFERENT_GENESIS_HASH"

        with patch("domain.ledger.remote_sync.RemoteLedgerSync") as mock_rls:
            mock_instance = MagicMock()
            # remote_count=5 > local_count=3 → stale condition triggers
            mock_instance.pull_blocks.return_value = (None, 5)
            mock_instance.pull_block_by_index.return_value = remote_genesis
            mock_instance.push_blocks.return_value = 1
            mock_instance._list_remote_block_indices.return_value = {0, 1, 2, 3, 4}
            mock_rls.return_value = mock_instance

            orch._sync_ledger_blocks()

        # Merge prompt NOT shown (genesis mismatch)
        self.view.prompt_choice.assert_not_called()
        mock_instance.pull_full_chain.assert_not_called()

        # Overwrite indices used (stale remote handling)
        push_call = mock_instance.push_blocks.call_args
        self.assertIn("overwrite_indices", push_call[1])

    # ── Edge: pull_full_chain fails ────────────────────────────

    def test_pull_full_chain_failure(self):
        """If pull_full_chain raises, merge fails gracefully."""
        orch = self._make_orchestrator()

        remote_genesis = dict(self.local_blocks[0])

        with patch("domain.ledger.remote_sync.RemoteLedgerSync") as mock_rls:
            mock_instance = MagicMock()
            mock_instance.pull_blocks.return_value = (None, 2)
            mock_instance.pull_block_by_index.return_value = remote_genesis
            mock_instance.pull_full_chain.side_effect = (
                FileNotFoundError("Remote block missing")
            )
            mock_instance._list_remote_block_indices.return_value = {0, 1}
            mock_rls.return_value = mock_instance

            orch._sync_ledger_blocks()

        # Error should be rendered
        self.view.render_error.assert_called()
        # Merge should NOT proceed to index replacement
        self.engine.index.clear.assert_not_called()

    # ── Edge: merge() raises ────────────────────────────────────

    def test_merge_raises_graceful_failure(self):
        """If LedgerMerge.merge() raises, orchestrator handles gracefully."""
        orch = self._make_orchestrator()

        remote_genesis = dict(self.local_blocks[0])
        remote_blocks = [self.local_blocks[0]]  # Just genesis

        with patch("domain.ledger.remote_sync.RemoteLedgerSync") as mock_rls:
            mock_instance = MagicMock()
            mock_instance.pull_blocks.return_value = (None, 2)
            mock_instance.pull_block_by_index.return_value = remote_genesis
            mock_instance.pull_full_chain.return_value = remote_blocks
            mock_instance._list_remote_block_indices.return_value = {0, 1}
            mock_rls.return_value = mock_instance

            with patch("core.sync.orchestrator.asyncio.run") as mock_async_run:
                mock_async_run.side_effect = ValueError(
                    "Genesis block mismatch"
                )
                orch._sync_ledger_blocks()

        self.view.render_error.assert_called()
        self.engine.index.clear.assert_not_called()

    # ── is_same_genesis unit tests ──────────────────────────────

    def test_is_same_genesis_true(self):
        """_is_same_genesis returns True when genesis hashes match."""
        from core.sync import SyncOrchestrator

        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=TEST_MASTER_KEY,
            transport=self.transport,
        )

        mock_ledger_sync = MagicMock()
        remote_genesis = dict(self.local_blocks[0])
        mock_ledger_sync.pull_block_by_index.return_value = remote_genesis

        result = orch._is_same_genesis(mock_ledger_sync, self.local_blocks)
        self.assertTrue(result)

    def test_is_same_genesis_false(self):
        """_is_same_genesis returns False when genesis hashes differ."""
        from core.sync import SyncOrchestrator

        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=TEST_MASTER_KEY,
            transport=self.transport,
        )

        mock_ledger_sync = MagicMock()
        remote_genesis = dict(self.local_blocks[0])
        remote_genesis["day_hash"] = "DIFFERENT_HASH"
        mock_ledger_sync.pull_block_by_index.return_value = remote_genesis

        result = orch._is_same_genesis(mock_ledger_sync, self.local_blocks)
        self.assertFalse(result)

    def test_is_same_genesis_no_remote(self):
        """_is_same_genesis returns False when remote has no genesis."""
        from core.sync import SyncOrchestrator

        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=TEST_MASTER_KEY,
            transport=self.transport,
        )

        mock_ledger_sync = MagicMock()
        mock_ledger_sync.pull_block_by_index.return_value = None

        result = orch._is_same_genesis(mock_ledger_sync, self.local_blocks)
        self.assertFalse(result)

    def test_is_same_genesis_empty_local(self):
        """_is_same_genesis returns False when local has no blocks."""
        from core.sync import SyncOrchestrator

        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=TEST_MASTER_KEY,
            transport=self.transport,
        )

        mock_ledger_sync = MagicMock()
        result = orch._is_same_genesis(mock_ledger_sync, [])
        self.assertFalse(result)


# ════════════════════════════════════════════════════════════════════════════
# Category G: _deduplicate_from_remote_ledger — entry_index fix
# ════════════════════════════════════════════════════════════════════════════

class TestDeduplicateFromRemoteLedger(unittest.TestCase):
    """Verify _deduplicate_from_remote_ledger uses cache-level
    read_entries() (which adds entry_index) rather than raw store
    read_entries() (which omits it), preventing a NoneType
    comparison error in remove_entries."""

    # Timestamp for "2026-07-13 08:30:00 UTC" in milliseconds
    TEST_START_MS = 1783931400000

    def setUp(self):
        # Staging service mock with nested _local / _store structure
        self.svc = MagicMock()
        self.svc.check_and_sync.return_value = MagicMock()
        self.svc.get_pending_sync.return_value = []

        # _local.read_entries() — cache-level, adds entry_index
        # _local._store.read_entries() — raw store, no entry_index (BUG)
        self.svc._local = MagicMock()
        self.svc._local._store = MagicMock()

        # Raw store entries — NO entry_index (current bug path)
        raw_entry = {
            "data": {
                "title": "Cross-client sync test",
                "startTime_enc": "plain:%d" % self.TEST_START_MS,
                "is_active": False,
            },
        }
        self.svc._local._store.read_entries.return_value = [raw_entry]

        # Cache entries — WITH entry_index (correct path post-fix)
        self.svc._local.read_entries.return_value = [{
            "entry_index": 0,
            "title": "Cross-client sync test",
            "start_epoch": self.TEST_START_MS,
            "date": "2026-07-13",
            "data": {
                "title": "Cross-client sync test",
                "startTime_enc": "plain:%d" % self.TEST_START_MS,
            },
        }]

        # Engine mock
        self.engine = MagicMock()
        self.engine.commit.return_value = "abc123"
        self.engine.verify.return_value = True

        # Transport mock
        self.transport = MagicMock()

    # ── Regression: entry_index is None before fix ──────────────

    def test_deduplicate_called_with_valid_indices_not_none(self):
        """remove_synced must receive integer indices, not None.

        Before the fix, _store.read_entries() was used which returns
        entries without entry_index, causing entry.get("entry_index")
        → None.  This leads to a TypeError ("<=" not supported
        between int and NoneType) inside remove_entries.

        After the fix, _local.read_entries() is used which always
        includes entry_index from enumerate().
        """
        from core.sync import SyncOrchestrator

        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=TEST_MASTER_KEY,
            transport=self.transport,
        )

        # Mock RemoteLedgerSync to return matching remote blocks
        with patch(
            "domain.ledger.remote_sync.RemoteLedgerSync"
        ) as mock_rls_cls:
            mock_rls = MagicMock()
            # Return one matching block with same title + date
            mock_block = {
                "type": "day",
                "date": "2026-07-13",
                "entries": [
                    {"data": {"title": "Cross-client sync test"}}
                ],
            }
            mock_rls.pull_hash_index.return_value = ["abc"]
            mock_rls.pull_block_by_index.return_value = mock_block
            mock_rls_cls.return_value = mock_rls

            orch._deduplicate_from_remote_ledger()

        # Verify remove_synced was called
        self.svc.remove_synced.assert_called_once()

        # Extract the indices argument — must NOT contain None
        call_args = self.svc.remove_synced.call_args[0]
        self.assertEqual(len(call_args), 1, "remove_synced expects 1 positional arg")
        indices = call_args[0]
        self.assertIsInstance(indices, list)
        self.assertNotIn(None, indices,
            "indices must not contain None — entry_index was missing")
        self.assertEqual(indices, [0],
            "deduplication should identify index 0 as matching")

    def test_deduplicate_no_match_does_not_call_remove(self):
        """When remote titles don't match, remove_synced is NOT called."""
        from core.sync import SyncOrchestrator

        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=TEST_MASTER_KEY,
            transport=self.transport,
        )

        with patch(
            "domain.ledger.remote_sync.RemoteLedgerSync"
        ) as mock_rls_cls:
            mock_rls = MagicMock()
            # Non-matching block
            mock_block = {
                "type": "day",
                "date": "2026-06-01",
                "entries": [
                    {"data": {"title": "Something else"}}
                ],
            }
            mock_rls.pull_hash_index.return_value = ["xyz"]
            mock_rls.pull_block_by_index.return_value = mock_block
            mock_rls_cls.return_value = mock_rls

            orch._deduplicate_from_remote_ledger()

        self.svc.remove_synced.assert_not_called()

    def test_deduplicate_no_transport_skips(self):
        """Without transport, deduplication is skipped entirely."""
        from core.sync import SyncOrchestrator

        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=TEST_MASTER_KEY,
            transport=None,  # No transport
        )

        orch._deduplicate_from_remote_ledger()

        # Neither the raw store nor the cache should be read
        self.svc.remove_synced.assert_not_called()

    def test_deduplicate_no_master_key_skips(self):
        """Without master_key, deduplication is skipped."""
        from core.sync import SyncOrchestrator

        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=None,  # No master key
            transport=self.transport,
        )

        orch._deduplicate_from_remote_ledger()
        self.svc.remove_synced.assert_not_called()

    def test_deduplicate_empty_remote_skips(self):
        """When remote has no blocks, deduplication skips gracefully."""
        from core.sync import SyncOrchestrator

        orch = SyncOrchestrator(
            staging_service=self.svc,
            ledger_engine=self.engine,
            master_key=TEST_MASTER_KEY,
            transport=self.transport,
        )

        with patch(
            "domain.ledger.remote_sync.RemoteLedgerSync"
        ) as mock_rls_cls:
            mock_rls = MagicMock()
            mock_rls.pull_hash_index.return_value = None
            mock_rls._list_remote_block_indices.return_value = set()
            mock_rls_cls.return_value = mock_rls

            orch._deduplicate_from_remote_ledger()

        self.svc.remove_synced.assert_not_called()


if __name__ == "__main__":
    unittest.main()
