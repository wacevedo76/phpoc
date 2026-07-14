"""F1 — Remove duplicate check_and_sync — Phase 2 (RED)

Tests for CLIInterface._sync_before_command and related read/write methods.
23 assertions from docs/planning/CLI_COMMAND_TIMING_F1_PHASE1.md.

Group A (3): Normal paths — no-transport, READY, OFFLINE
Group B (7): REAUTH auto-handle for require_auth=False (CORE FIX)
Group C (3): require_auth=True (write commands unchanged)
Group D (3): check_and_sync called exactly once per read method
Group E (4): Write command paths unchanged (regression)
Group F (3): main.py read command handler cleanup (integration)

Status: 🔴 RED — tests expected to fail until Phase 3 implementation.
"""

import ast
import inspect
import unittest
from io import StringIO
from unittest.mock import MagicMock, patch, PropertyMock

from domain.staging.service import SyncCheckResult
from cli.interface import CLIInterface


# ============================================================================
# Group A: _sync_before_command — Normal Paths (3 tests)
# ============================================================================

class TestGroupA_NormalPaths(unittest.TestCase):
    """A1–A3: Verify _sync_before_command works correctly when no re-auth
    is needed."""

    def setUp(self):
        self.mock_staging = MagicMock()
        self.mock_ledger_engine = MagicMock()
        self.mock_crypto = MagicMock()
        self.cli = CLIInterface(
            self.mock_staging, self.mock_ledger_engine, self.mock_crypto
        )

    # -- A1: Returns True with no remote transport configured ----------------

    def test_A1_no_remote_transport_returns_true(self):
        """A1: Local-only mode works without sync — guards the no-remote
        short-circuit path."""
        self.mock_staging._remote = None
        result = self.cli._sync_before_command()
        self.assertTrue(result)
        self.mock_staging.check_and_sync.assert_not_called()

    # -- A2: Returns True when check_and_sync returns READY ------------------

    def test_A2_READY_returns_true_and_calls_dedup(self):
        """A2: Cookie match → fast path, no re-auth. Tests the most common
        (warm cache) path."""
        self.mock_staging._remote = MagicMock()
        self.mock_staging.check_and_sync.return_value = SyncCheckResult.READY

        with patch.object(self.cli, '_sync_remote_ledger_and_dedup') as mock_dedup:
            result = self.cli._sync_before_command()

        self.assertTrue(result)
        self.mock_staging.check_and_sync.assert_called_once_with(timeout_ms=500)
        mock_dedup.assert_called_once()

    # -- A3: Returns True when check_and_sync returns OFFLINE ----------------

    def test_A3_OFFLINE_returns_true(self):
        """A3: Remote unreachable → continue with local. Ensures commands
        don't block on network issues."""
        self.mock_staging._remote = MagicMock()
        self.mock_staging.check_and_sync.return_value = SyncCheckResult.OFFLINE

        with patch.object(self.cli, '_sync_remote_ledger_and_dedup') as mock_dedup:
            result = self.cli._sync_before_command()

        self.assertTrue(result)
        mock_dedup.assert_not_called()


# ============================================================================
# Group B: _sync_before_command — REAUTH Auto-Handle (require_auth=False)
# ============================================================================
# These are the CORE FIX — the new behavior that replaces the duplicate
# check_and_sync + re-auth blocks in main.py.
#
# 7 tests test the auto-handle path: login → rebuild StagingService →
# reconcile_and_claim → sync_remote_ledger → return.
# All must be RED (fail with AssertionError, not ImportError).

class TestGroupB_REAUTH_AutoHandle(unittest.TestCase):
    """B1–B7: When check_and_sync returns REAUTH_NEEDED and
    require_auth=False, _sync_before_command auto-handles re-auth."""

    def setUp(self):
        self.mock_staging = MagicMock()
        self.mock_ledger_engine = MagicMock()
        self.mock_crypto = MagicMock()
        self.cli = CLIInterface(
            self.mock_staging, self.mock_ledger_engine, self.mock_crypto
        )
        # Configure staging for REAUTH_NEEDED
        self.mock_staging._remote = MagicMock()
        self.mock_staging.check_and_sync.return_value = \
            SyncCheckResult.REAUTH_NEEDED

    # -- B1: REAUTH_NEEDED → auth.login() succeeds, returns True ------------

    def test_B1_REAUTH_calls_auth_login_returns_true(self):
        """B1: Auto-handles re-auth for read commands. Main behavior
        change — replaces the main.py re-auth block."""
        mock_auth = MagicMock()
        mock_auth.login.return_value = True
        mock_auth.get_key.return_value = b'\x01' * 32
        self.cli._auth = mock_auth

        result = self.cli._sync_before_command(require_auth=False)

        self.assertTrue(result)
        mock_auth.login.assert_called_once()

    # -- B2: REAUTH_NEEDED with failed login → returns False -----------------

    def test_B2_REAUTH_failed_login_returns_false(self):
        """B2: Aborts when user cancels auth. Preserves the existing abort
        path from main.py."""
        mock_auth = MagicMock()
        mock_auth.login.return_value = False
        self.cli._auth = mock_auth

        result = self.cli._sync_before_command(require_auth=False)

        self.assertFalse(result)
        mock_auth.login.assert_called_once()

    # -- B3: After re-auth, StagingService rebuilt with fresh crypto ---------

    def test_B3_rebuilds_staging_service_with_fresh_crypto(self):
        """B3: Re-auth invalidates old staging service. Matches main.py
        pattern: StagingService(crypto=fresh_crypto, …)."""
        mock_auth = MagicMock()
        mock_auth.login.return_value = True
        mk = b'\x02' * 32
        mock_auth.get_key.return_value = mk
        self.cli._auth = mock_auth

        with patch('cli.interface.CryptoManager', create=True) as mock_cm, \
             patch('cli.interface.StagingService', create=True) as mock_ss, \
             patch('cli.interface.LedgerEngine', create=True) as mock_le:
            mock_cm_instance = MagicMock()
            mock_cm.return_value = mock_cm_instance
            mock_ss_instance = MagicMock()
            mock_ss.return_value = mock_ss_instance
            mock_ss_instance._reconcile_and_claim.return_value = \
                SyncCheckResult.READY
            mock_le_instance = MagicMock()
            mock_le.return_value = mock_le_instance

            self.cli._sync_before_command(require_auth=False)

        # Fresh CryptoManager created with the new master key
        mock_cm.assert_called_once_with(mk)
        # New StagingService created with fresh crypto
        mock_ss.assert_called_once()
        _, kwargs = mock_ss.call_args
        self.assertIs(kwargs.get('crypto'), mock_cm_instance)
        # CLIInterface._staging replaced with the new StagingService
        self.assertIs(self.cli._staging, mock_ss_instance)

    # -- B4: After re-auth, _reconcile_and_claim() is called ----------------

    def test_B4_calls_reconcile_and_claim_after_reauth(self):
        """B4: Claims remote staging for this device after re-auth.
        Cookie pull/push cycle after re-auth."""
        mock_auth = MagicMock()
        mock_auth.login.return_value = True
        mk = b'\x03' * 32
        mock_auth.get_key.return_value = mk
        self.cli._auth = mock_auth

        with patch('cli.interface.CryptoManager', create=True), \
             patch('cli.interface.StagingService', create=True) as mock_ss, \
             patch('cli.interface.LedgerEngine', create=True):
            mock_ss_instance = MagicMock()
            mock_ss_instance._reconcile_and_claim.return_value = \
                SyncCheckResult.READY
            mock_ss.return_value = mock_ss_instance

            self.cli._sync_before_command(require_auth=False)

        mock_ss_instance._reconcile_and_claim.assert_called_once_with(mk)

    # -- B5: After re-auth, _sync_remote_ledger_and_dedup() is called --------

    def test_B5_calls_sync_remote_ledger_after_reauth(self):
        """B5: Syncs ledger blocks after staging sync. READY path calls
        this; re-auth path should too."""
        mock_auth = MagicMock()
        mock_auth.login.return_value = True
        mk = b'\x04' * 32
        mock_auth.get_key.return_value = mk
        self.cli._auth = mock_auth

        with patch('cli.interface.CryptoManager', create=True), \
             patch('cli.interface.StagingService', create=True) as mock_ss, \
             patch('cli.interface.LedgerEngine', create=True), \
             patch.object(self.cli, '_sync_remote_ledger_and_dedup') as mock_dedup:
            mock_ss_instance = MagicMock()
            mock_ss_instance._reconcile_and_claim.return_value = \
                SyncCheckResult.READY
            mock_ss.return_value = mock_ss_instance

            self.cli._sync_before_command(require_auth=False)

        mock_dedup.assert_called_once()

    # -- B6: When _reconcile_and_claim returns OFFLINE → returns True --------

    def test_B6_OFFLINE_after_reauth_returns_true(self):
        """B6: Continues with local data if remote unreachable post-re-auth.
        Resilient: network failure after re-auth doesn't block command."""
        mock_auth = MagicMock()
        mock_auth.login.return_value = True
        mk = b'\x05' * 32
        mock_auth.get_key.return_value = mk
        self.cli._auth = mock_auth

        with patch('cli.interface.CryptoManager', create=True), \
             patch('cli.interface.StagingService', create=True) as mock_ss, \
             patch('cli.interface.LedgerEngine', create=True), \
             patch.object(self.cli, '_sync_remote_ledger_and_dedup') as mock_dedup:
            mock_ss_instance = MagicMock()
            mock_ss_instance._reconcile_and_claim.return_value = \
                SyncCheckResult.OFFLINE
            mock_ss.return_value = mock_ss_instance

            result = self.cli._sync_before_command(require_auth=False)

        self.assertTrue(result)
        # Even though reconcile failed, dedup still fires (best-effort)
        mock_dedup.assert_called_once()

    # -- B7: REAUTH_NEEDED prints a message about re-authentication ----------

    def test_B7_prints_reauth_message_during_auto_handle(self):
        """B7: User gets feedback during auto-handle. UX: user knows why
        they're being prompted. The message must come from the auto-handle
        path (not the current 'held by different device' message)."""
        mock_auth = MagicMock()
        mock_auth.login.return_value = True
        mk = b'\x06' * 32
        mock_auth.get_key.return_value = mk
        self.cli._auth = mock_auth

        with patch('sys.stdout', new_callable=StringIO) as mock_stdout, \
             patch('cli.interface.CryptoManager', create=True), \
             patch('cli.interface.StagingService', create=True) as mock_ss, \
             patch('cli.interface.LedgerEngine', create=True), \
             patch.object(self.cli, '_sync_remote_ledger_and_dedup'):
            mock_ss_instance = MagicMock()
            mock_ss_instance._reconcile_and_claim.return_value = \
                SyncCheckResult.READY
            mock_ss.return_value = mock_ss_instance

            self.cli._sync_before_command(require_auth=False)

        output = mock_stdout.getvalue()
        # The auto-handle path prints a message about re-authentication.
        # The OLD message says "held by a different device" — the new path
        # should say something different (about re-authenticating).
        self.assertIn("re-authenticate", output.lower())
        # After Phase 3, the old "held by a different device" message
        # should NOT appear when require_auth=False (auto-handle).
        self.assertNotIn("held by a different device", output)


# ============================================================================
# Group C: _sync_before_command — require_auth=True (Write Commands)
# ============================================================================

class TestGroupC_RequireAuthTrue(unittest.TestCase):
    """C1–C3: Write commands (ph add, ph sync, etc.) must NOT auto-handle
    re-auth — the main.py handler for each command does that itself."""

    def setUp(self):
        self.mock_staging = MagicMock()
        self.mock_ledger_engine = MagicMock()
        self.mock_crypto = MagicMock()
        self.cli = CLIInterface(
            self.mock_staging, self.mock_ledger_engine, self.mock_crypto
        )
        self.mock_staging._remote = MagicMock()

    # -- C1: REAUTH_NEEDED with require_auth=True → False, no auto-handle ---

    def test_C1_REAUTH_require_auth_true_returns_false(self):
        """C1: Write commands keep their own re-auth flow. Prevents
        duplicate re-auth in write commands."""
        self.mock_staging.check_and_sync.return_value = \
            SyncCheckResult.REAUTH_NEEDED
        mock_auth = MagicMock()
        self.cli._auth = mock_auth

        result = self.cli._sync_before_command(require_auth=True)

        self.assertFalse(result)
        mock_auth.login.assert_not_called()

    # -- C2: REAUTH_NEEDED with require_auth=True prints message -------------

    def test_C2_require_auth_true_prints_held_by_different_device(self):
        """C2: User gets actionable message. UX: write commands should
        explain why they're blocked."""
        self.mock_staging.check_and_sync.return_value = \
            SyncCheckResult.REAUTH_NEEDED

        with patch('sys.stdout', new_callable=StringIO) as mock_stdout:
            self.cli._sync_before_command(require_auth=True)

        output = mock_stdout.getvalue()
        self.assertIn("different device", output.lower())

    # -- C3: READY with require_auth=True → True, calls dedup ----------------

    def test_C3_READY_require_auth_true_returns_true_and_dedup(self):
        """C3: Normal path for write commands. Verifies write-command
        sync is unchanged."""
        self.mock_staging.check_and_sync.return_value = SyncCheckResult.READY

        with patch.object(self.cli, '_sync_remote_ledger_and_dedup') as mock_dedup:
            result = self.cli._sync_before_command(require_auth=True)

        self.assertTrue(result)
        mock_dedup.assert_called_once()


# ============================================================================
# Group D: check_and_sync Called Exactly Once per Read Method (3 tests)
# ============================================================================

class TestGroupD_CheckAndSyncCount(unittest.TestCase):
    """D1–D3: The proof that the duplicate is eliminated — view_active()
    and list_habits() call check_and_sync exactly once (via
    _sync_before_command)."""

    def setUp(self):
        self.mock_staging = MagicMock()
        self.mock_ledger_engine = MagicMock()
        self.mock_crypto = MagicMock()
        self.cli = CLIInterface(
            self.mock_staging, self.mock_ledger_engine, self.mock_crypto
        )

    # -- D1: view_active() calls check_and_sync exactly once -----------------

    def test_D1_view_active_calls_check_and_sync_once(self):
        """D1: Duplicate eliminated from view path. The primary bug fix —
        'ph view' was the worst offender."""
        self.mock_staging._remote = MagicMock()
        self.mock_crypto.decrypt.return_value = '0'
        self.mock_staging._local._store.read_entries.return_value = []

        with patch.object(self.cli, '_sync_before_command',
                          wraps=self.cli._sync_before_command) as mock_sync, \
             patch('cli.interface._show_sync_notifications'), \
             patch('cli.interface._spawn_background_sync_check'):
            mock_sync.return_value = True
            self.cli.view_active()

        # view_active calls _sync_before_command, which is the ONLY path
        # to check_and_sync. Verify _sync_before_command was called once.
        mock_sync.assert_called_once_with(require_auth=False)

    # -- D2: list_habits() calls check_and_sync exactly once -----------------

    def test_D2_list_habits_calls_check_and_sync_once(self):
        """D2: Duplicate eliminated from list path.
        'ph list all|synced|staged' also duplicated."""
        self.mock_staging._remote = MagicMock()
        self.mock_ledger_engine.get_day_blocks.return_value = []
        self.mock_staging._local._store.read_entries.return_value = []

        with patch.object(self.cli, '_sync_before_command',
                          wraps=self.cli._sync_before_command) as mock_sync:
            mock_sync.return_value = True
            self.cli.list_habits('all')

        mock_sync.assert_called_once_with(require_auth=False)

    # -- D3: view_active() still produces correct output after fix -----------

    def test_D3_view_active_still_works(self):
        """D3: No regression in behavior. Integration: output is correct,
        entries are displayed."""
        self.mock_staging._remote = None  # local-only
        self.mock_crypto.decrypt.return_value = '1000000'
        from datetime import datetime
        self.mock_staging._local._store.read_entries.return_value = [{
            'data': {
                'title': 'Test Task',
                'is_active': True,
                'startTime_enc': 'plain:1000000',
                'is_paused': False,
            }
        }]

        with patch.object(self.cli, '_sync_before_command',
                          return_value=True), \
             patch('cli.interface._show_sync_notifications'), \
             patch('cli.interface._spawn_background_sync_check'), \
             patch('sys.stdout', new_callable=StringIO) as mock_stdout:
            self.cli.view_active()

        output = mock_stdout.getvalue()
        self.assertIn('Test Task', output)
        self.assertIn('Running Tasks', output)


# ============================================================================
# Group E: Write Command Paths Unchanged — Regression (4 tests)
# ============================================================================

class TestGroupE_WriteCommandsUnchanged(unittest.TestCase):
    """E1–E4: Write commands (add, sync, modify, remove) in main.py still
    call check_and_sync once directly — these are NOT duplicated and
    should not change."""

    def setUp(self):
        self.mock_staging = MagicMock()
        self.mock_ledger_engine = MagicMock()
        self.mock_crypto = MagicMock()
        self.cli = CLIInterface(
            self.mock_staging, self.mock_ledger_engine, self.mock_crypto
        )

    # -- E1: add_oneoff() calls _sync_before_command(require_auth=True) ------

    def test_E1_add_oneoff_calls_sync_before_command_with_require_auth(self):
        """E1: Write path uses require_auth=True. Write commands must not
        auto-handle re-auth."""
        with patch.object(self.cli, '_sync_before_command',
                          return_value=True) as mock_sync, \
             patch.object(self.cli, '_defer_push'), \
             patch('sys.stdout', new_callable=StringIO):
            self.cli.add_oneoff('Test', 1000000, 2000000)

        mock_sync.assert_called_once_with(require_auth=True)

    # -- E2: add_start() calls _sync_before_command(require_auth=True) -------

    def test_E2_add_start_calls_sync_before_command_with_require_auth(self):
        """E2: Same as E1 for start. Consistency across write paths."""
        import time
        with patch.object(self.cli, '_sync_before_command',
                          return_value=True) as mock_sync, \
             patch.object(self.cli, '_defer_push'), \
             patch('sys.stdout', new_callable=StringIO), \
             patch.object(time, 'time', return_value=1000.0):
            self.cli.add_start('Test Task')

        mock_sync.assert_called_once_with(require_auth=True)

    # -- E3: add_end() calls _sync_before_command(require_auth=True) ---------

    def test_E3_add_end_calls_sync_before_command_with_require_auth(self):
        """E3: Same as E1 for end. Consistency across write paths."""
        with patch.object(self.cli, '_sync_before_command',
                          return_value=True) as mock_sync, \
             patch.object(self.cli, '_defer_push'), \
             patch.object(self.cli, '_resolve_title',
                          return_value='Test Task'), \
             patch('sys.stdout', new_callable=StringIO):
            self.cli.add_end('Test Task')

        mock_sync.assert_called_once_with(require_auth=True)

    # -- E4: add_pause() / add_unpause() call _sync_before_command -----------

    def test_E4_add_pause_calls_sync_before_command_with_require_auth(self):
        """E4: Same for pause. Full coverage of write methods."""
        with patch.object(self.cli, '_sync_before_command',
                          return_value=True) as mock_sync, \
             patch.object(self.cli, '_defer_push'), \
             patch.object(self.cli, '_resolve_title',
                          return_value='Test Task'), \
             patch('sys.stdout', new_callable=StringIO):
            self.cli.add_pause('Test Task')

        mock_sync.assert_called_once_with(require_auth=True)

    def test_E4b_add_unpause_calls_sync_before_command_with_require_auth(self):
        """E4b: Same for unpause. Full coverage of write methods."""
        with patch.object(self.cli, '_sync_before_command',
                          return_value=True) as mock_sync, \
             patch.object(self.cli, '_defer_push'), \
             patch.object(self.cli, '_resolve_title',
                          return_value='Test Task'), \
             patch('sys.stdout', new_callable=StringIO):
            self.cli.add_unpause('Test Task')

        mock_sync.assert_called_once_with(require_auth=True)


# ============================================================================
# Group F: main.py Read Command Handler Cleanup (3 tests)
# ============================================================================
# These are design-constraint assertions verified at the integration level.
# We inspect the AST of main.py to verify the duplicate check_and_sync calls
# have been removed from the read command handlers.

def _extract_main_py_handlers():
    """Parse main.py AST and return the body of each command handler.

    Returns dict: {command_name: list_of_statement_strings}
    """
    with open('main.py', 'r') as f:
        source = f.read()

    tree = ast.parse(source)

    handlers = {}
    # Find the view handler: elif args.command == "view":
    # Find the list handler: elif args.command == "list":
    for node in ast.walk(tree):
        if isinstance(node, ast.If):
            test_str = ast.unparse(node.test) if hasattr(ast, 'unparse') else ''
            # Use ast.dump for Python < 3.9, but we expect 3.10+
            if hasattr(ast, 'unparse'):
                test_str = ast.unparse(node.test)
            else:
                test_str = ast.dump(node.test)

            if 'args.command' in test_str:
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, ast.Compare) or \
                       hasattr(child, 'left') and hasattr(child, 'comparators'):
                        # This is the if/elif test
                        pass
                # Walk the body for check_and_sync calls
                body_source = []
                for stmt in node.body:
                    if hasattr(ast, 'unparse'):
                        body_source.append(ast.unparse(stmt))
                handlers[test_str] = body_source

    return handlers


class TestGroupF_MainPyCleanup(unittest.TestCase):
    """F1–F3: Verify main.py no longer contains duplicate check_and_sync
    calls before read commands."""

    def _get_main_py_source(self):
        """Read main.py as a single string."""
        with open('main.py', 'r') as f:
            return f.read()

    def _parse_main_py(self):
        """Parse main.py into an AST."""
        with open('main.py', 'r') as f:
            return ast.parse(f.read())

    # -- F1: 'ph view' handler no longer calls check_and_sync directly ------

    def test_F1_view_handler_no_longer_calls_check_and_sync(self):
        """F1: Duplicate removed from main.py. The root cause fix."""
        tree = self._parse_main_py()

        # Find the view command handler: the block under
        # elif args.command == "view":
        view_body = None
        for node in ast.walk(tree):
            if isinstance(node, ast.If):
                test_str = ast.unparse(node.test)
                if "'view'" in test_str and 'args.command' in test_str:
                    view_body = [ast.unparse(s) for s in node.body]
                    break

        if view_body is None:
            self.fail("Could not find view command handler in main.py")

        # The view body should NOT contain a direct check_and_sync call
        # before cli.view_active(). It should only appear inside
        # _sync_before_command (which is in cli/interface.py, not main.py).
        body_text = '\n'.join(view_body)
        # Count occurrences of check_and_sync in the view handler body
        check_sync_count = body_text.count('check_and_sync')
        # Currently there is one in the view handler (the duplicate).
        # After Phase 3, there should be 0.
        self.assertEqual(check_sync_count, 0,
                         f"Expected 0 check_and_sync calls in view handler, "
                         f"found {check_sync_count}")

    # -- F2: 'ph list active' handler no longer calls check_and_sync --------

    def test_F2_list_active_handler_no_longer_calls_check_and_sync(self):
        """F2: Duplicate removed from list active path. Same pattern as
        view."""
        tree = self._parse_main_py()

        # Find the list handler: elif args.command == "list":
        list_body = None
        for node in ast.walk(tree):
            if isinstance(node, ast.If):
                test_str = ast.unparse(node.test)
                if "'list'" in test_str and 'args.command' in test_str:
                    # Recursively gather ALL statements within the list handler
                    all_stmts = []
                    for stmt in node.body:
                        all_stmts.append(ast.unparse(stmt))
                    list_body = all_stmts
                    break

        if list_body is None:
            self.fail("Could not find list command handler in main.py")

        body_text = '\n'.join(list_body)
        check_sync_count = body_text.count('check_and_sync')
        self.assertEqual(check_sync_count, 0,
                         f"Expected 0 check_and_sync calls in list handler, "
                         f"found {check_sync_count}")

    # -- F3: 'ph list all|synced|staged' handler — same check ---------------

    def test_F3_list_all_handler_no_longer_calls_check_and_sync(self):
        """F3: Duplicate removed from list path. Same pattern as view."""
        tree = self._parse_main_py()

        # Recursively collect all check_and_sync calls in the list
        # command handler body (including nested if/elif blocks).
        list_check_sync_stmts = []
        for node in ast.walk(tree):
            if isinstance(node, ast.If):
                test_str = ast.unparse(node.test)
                if "'list'" in test_str and 'args.command' in test_str:
                    # Recursively walk the body for check_and_sync
                    for child in ast.walk(node):
                        if isinstance(child, (ast.Expr, ast.Assign)):
                            child_str = ast.unparse(child)
                            if 'check_and_sync' in child_str:
                                list_check_sync_stmts.append(child_str.strip()[:80])
                    break

        # After Phase 3, there should be 0 check_and_sync calls
        # anywhere in the list handler.
        self.assertEqual(len(list_check_sync_stmts), 0,
                         f"check_and_sync found in list handler: "
                         f"{list_check_sync_stmts}")


# ============================================================================
# Run
# ============================================================================

if __name__ == '__main__':
    unittest.main()
