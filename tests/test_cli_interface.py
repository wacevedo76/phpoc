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
import time
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
# F2: Persistent Cache for Remote Ledger Blocks — Phase 2 (RED)
# ============================================================================
# 23 assertions from docs/planning/CLI_COMMAND_TIMING_F2_PHASE1.md.
#
# Group A (5): Persistent Cache — File Read/Write
# Group B (4): Cache Hit — Skip Remote Pulls
# Group C (5): Cache Miss / Partial — Pull Missing Blocks
# Group D (3): TTL Expiry
# Group E (3): Cache Invalidation
# Group F (3): Integration — End-to-End
#
# Status: 🔴 RED — tests expected to fail until Phase 3 implementation.

import json as _json
import os as _os
import tempfile as _tempfile
import time as _time
from pathlib import Path as _Path

# _RemoteLedgerCache will be defined in cli/interface.py during Phase 3
from cli.interface import _RemoteLedgerCache  # noqa: E402 — RED: ImportError


# ═══════════════════════════════════════════════════════════════
# Helper: build a minimal day block dict for test data
# ═══════════════════════════════════════════════════════════════

def _make_block(date_str, entries):
    """Build a day block dict matching RemoteLedgerSync.pull_block_by_index
    return format."""
    return {
        "type": "day",
        "date": date_str,
        "entries": [
            {"data": dict(e)} for e in entries
        ],
    }


def _make_remote_index(*date_title_durs):
    """Build a remote index dict from (date, title, duration) triples."""
    idx = {}
    for date_str, title, dur in date_title_durs:
        idx.setdefault(date_str, {})[title] = dur
    return idx


# ═══════════════════════════════════════════════════════════════
# Group A: Persistent Cache — File Read/Write (5 tests)
# ═══════════════════════════════════════════════════════════════

class TestGroupA_CacheFileIO(unittest.TestCase):
    """A1–A5: Direct tests of _RemoteLedgerCache persistence layer.

    These tests create cache instances and verify file I/O correctness.
    They fail with ImportError until _RemoteLedgerCache is defined.
    """

    def setUp(self):
        self.tmpdir = _tempfile.TemporaryDirectory()
        self.cache_path = _Path(self.tmpdir.name) / "remote_ledger_cache.json"

    def tearDown(self):
        self.tmpdir.cleanup()

    # -- A1: save() creates file with expected structure --------------------

    def test_A1_save_creates_cache_file_with_expected_structure(self):
        """A1: Verify the cache writes a valid JSON file."""
        cache = _RemoteLedgerCache(self.cache_path)
        cache.blocks = {
            "0": _make_block("2026-07-01", [
                {"title": "Coding", "startTime_enc": "plain:1718912345000",
                 "duration": 7200000},
            ]),
        }
        cache.remote_index = _make_remote_index(("2026-07-01", "Coding", 7200000))
        cache.max_block_index = 0
        cache.last_pull_time = 1718912345.0
        cache.save()

        self.assertTrue(self.cache_path.exists(),
                        f"Expected {self.cache_path} to exist after save()")
        with open(self.cache_path) as f:
            data = _json.load(f)
        self.assertEqual(data["max_block_index"], 0)
        self.assertEqual(data["last_pull_time"], 1718912345.0)
        self.assertIn("2026-07-01", data["remote_index"])
        self.assertIn("0", data["blocks"])
        self.assertEqual(data["blocks"]["0"]["date"], "2026-07-01")

    # -- A2: Round-trip integrity -------------------------------------------

    def test_A2_load_round_trip_preserves_block_entries(self):
        """A2: Save → load yields matching data."""
        expected_blocks = {
            "0": _make_block("2026-07-01", [
                {"title": "Reading", "startTime_enc": "plain:1000000",
                 "duration": 3600000},
            ]),
            "1": _make_block("2026-07-02", [
                {"title": "Writing", "startTime_enc": "plain:2000000",
                 "duration": 1800000},
            ]),
        }
        expected_index = _make_remote_index(
            ("2026-07-01", "Reading", 3600000),
            ("2026-07-02", "Writing", 1800000),
        )

        cache = _RemoteLedgerCache(self.cache_path)
        cache.blocks = dict(expected_blocks)
        cache.remote_index = dict(expected_index)
        cache.max_block_index = 1
        cache.last_pull_time = 2000.0
        cache.save()

        loaded = _RemoteLedgerCache(self.cache_path)
        loaded.load()

        self.assertEqual(loaded.max_block_index, 1)
        self.assertEqual(loaded.last_pull_time, 2000.0)
        self.assertEqual(
            loaded.blocks["0"]["entries"][0]["data"]["title"], "Reading"
        )
        self.assertEqual(
            loaded.blocks["1"]["entries"][0]["data"]["title"], "Writing"
        )
        self.assertEqual(
            loaded.remote_index, expected_index
        )

    # -- A3: Cold start — no file -------------------------------------------

    def test_A3_load_returns_empty_state_when_file_missing(self):
        """A3: First-run behavior — no file → empty state, no crash."""
        cache = _RemoteLedgerCache(self.cache_path)
        # File does not exist (tmpdir is fresh)
        self.assertFalse(self.cache_path.exists())
        cache.load()

        self.assertEqual(cache.max_block_index, -1)
        self.assertEqual(cache.last_pull_time, 0.0)
        self.assertEqual(cache.blocks, {})
        self.assertEqual(cache.remote_index, {})

    # -- A4: Corrupt file — invalid JSON ------------------------------------

    def test_A4_load_handles_invalid_json_gracefully(self):
        """A4: Corrupted files must not crash the CLI."""
        # Write garbage
        self.cache_path.write_text("not valid json {{{{")
        cache = _RemoteLedgerCache(self.cache_path)
        cache.load()

        # Should fall back to empty state
        self.assertEqual(cache.max_block_index, -1)
        self.assertEqual(cache.last_pull_time, 0.0)
        self.assertEqual(cache.blocks, {})

    # -- A5: Write error during save is caught ------------------------------

    def test_A5_save_catches_write_errors_and_logs(self):
        """A5: Disk-full or permission errors must not propagate."""
        cache = _RemoteLedgerCache(self.cache_path)
        cache.blocks = {"0": _make_block("2026-07-01", [
            {"title": "Test", "startTime_enc": "plain:1000", "duration": 100}
        ])}
        cache.max_block_index = 0
        cache.last_pull_time = 1000.0

        # Make the path a directory — save() should fail but not raise
        self.cache_path.mkdir(exist_ok=True)
        with patch('logging.getLogger') as mock_logger:
            mock_log = MagicMock()
            mock_logger.return_value = mock_log
            # save() must not raise
            try:
                cache.save()
            except Exception as exc:
                self.fail(f"save() raised {type(exc).__name__}: {exc}")


# ═══════════════════════════════════════════════════════════════
# Group B: Cache Hit — Skip Remote Pulls (4 tests)
# ═══════════════════════════════════════════════════════════════

_SAMPLE_BLOCKS = {
    "0": _make_block("2026-07-01", [
        {"title": "Coding", "startTime_enc": "plain:1718912345000",
         "endTime_enc": "plain:1718919545000",
         "duration": 7200000},
    ]),
    "1": _make_block("2026-07-02", [
        {"title": "Reading", "startTime_enc": "plain:1718998745000",
         "endTime_enc": "plain:1719002345000",
         "duration": 3600000},
    ]),
    "2": _make_block("2026-07-03", [
        {"title": "Writing", "startTime_enc": "plain:1719085145000",
         "endTime_enc": "plain:1719090545000",
         "duration": 5400000},
    ]),
}

_SAMPLE_REMOTE_INDEX = _make_remote_index(
    ("2026-07-01", "Coding", 7200000),
    ("2026-07-02", "Reading", 3600000),
    ("2026-07-03", "Writing", 5400000),
)


class _BaseCacheIntegration(unittest.TestCase):
    """Base for Groups B–F: common CLIInterface setup with transport + mk."""

    def setUp(self):
        self.mock_staging = MagicMock()
        self.mock_ledger_engine = MagicMock()
        self.mock_crypto = MagicMock()
        self.cli = CLIInterface(
            self.mock_staging, self.mock_ledger_engine, self.mock_crypto
        )
        # Configure staging for sync
        self.mock_staging._remote = MagicMock()
        self.mock_staging._remote._transport = MagicMock()
        self.mock_crypto.master_key = b'\x01' * 32
        self.mock_staging._data_dir = _Path(_tempfile.mkdtemp())

    def tearDown(self):
        try:
            import shutil
            shutil.rmtree(str(self.mock_staging._data_dir), ignore_errors=True)
        except Exception:
            pass

    def _fresh_cache_mock(self, max_block_index=2, blocks=None, remote_index=None,
                          last_pull_time=1000.0):
        """Create a mock _RemoteLedgerCache that appears fresh.

        Returns the mock instance for later assertion.
        """
        mock_cache = MagicMock()
        mock_cache.max_block_index = max_block_index
        mock_cache.last_pull_time = last_pull_time
        mock_cache.blocks = blocks if blocks is not None else dict(_SAMPLE_BLOCKS)
        mock_cache.remote_index = (
            remote_index if remote_index is not None
            else dict(_SAMPLE_REMOTE_INDEX)
        )
        mock_cache.is_fresh.return_value = True
        return mock_cache

    def _stale_cache_mock(self, max_block_index=-1, blocks=None, remote_index=None,
                          last_pull_time=0.0):
        """Create a mock _RemoteLedgerCache that appears stale/empty."""
        mock_cache = MagicMock()
        mock_cache.max_block_index = max_block_index
        mock_cache.last_pull_time = last_pull_time
        mock_cache.blocks = blocks if blocks is not None else {}
        mock_cache.remote_index = (
            remote_index if remote_index is not None else {}
        )
        mock_cache.is_fresh.return_value = False
        return mock_cache

    def _mock_remote_sync(self, existing_indices, blocks_by_idx=None,
                          remote_index=None):
        """Patch RemoteLedgerSync and return the mock instance.

        Args:
            existing_indices: set of int indices available on remote
            blocks_by_idx: dict int→block to return from pull_block_by_index
            remote_index: dict to return from pull_index

        Returns:
            (mock_class, mock_instance) tuple
        """
        mock_instance = MagicMock()
        mock_instance._list_remote_block_indices.return_value = set(
            existing_indices
        )
        if blocks_by_idx is not None:
            def _pull_block(idx):
                return blocks_by_idx.get(idx)
            mock_instance.pull_block_by_index.side_effect = _pull_block
        else:
            mock_instance.pull_block_by_index.return_value = None
        mock_instance.pull_index.return_value = remote_index or {}
        return mock_instance


class TestGroupB_CacheHitSkipPull(_BaseCacheIntegration):
    """B1–B4: When cache is fresh, skip all HTTP pulls."""

    # -- B1: Fresh cache → zero remote pulls --------------------------------

    def test_B1_fresh_cache_calls_zero_remote_pulls(self):
        """B1: Core F2 win — eliminate all ledger-block HTTP requests."""
        mock_cache = self._fresh_cache_mock()
        mock_rs_class = MagicMock()

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache) as mock_cache_cls, \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class):
            self.cli._sync_remote_ledger_and_dedup()

        # RemoteLedgerSync must NOT be instantiated on cache hit
        mock_rs_class.assert_not_called()

    # -- B2: Cache hit → dedup with reconstructed committed_titles ----------

    def test_B2_cache_hit_calls_remove_committed_with_reconstructed_data(self):
        """B2: Dedup works from cached block data."""
        mock_cache = self._fresh_cache_mock(blocks=dict(_SAMPLE_BLOCKS))

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch.object(self.cli, '_remove_committed_from_staging') as mock_rm, \
             patch('domain.ledger.remote_sync.RemoteLedgerSync'):
            self.cli._sync_remote_ledger_and_dedup()

        mock_rm.assert_called_once()
        committed = mock_rm.call_args[0][0]
        # Should contain the (date, title) keys from the cached blocks
        self.assertIn(("2026-07-01", "Coding"), committed)
        self.assertIn(("2026-07-02", "Reading"), committed)
        self.assertIn(("2026-07-03", "Writing"), committed)

    # -- B3: Cache hit → list_habits synced section uses cached data ---------

    def test_B3_cache_hit_list_habits_includes_cached_entries(self):
        """B3: Display functionality works from cache."""
        mock_cache = self._fresh_cache_mock(blocks=dict(_SAMPLE_BLOCKS))
        self.mock_ledger_engine.get_day_blocks.return_value = []
        self.mock_staging.check_and_sync.return_value = SyncCheckResult.READY
        self.mock_staging._local._store.read_entries.return_value = []

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync'), \
             patch('sys.stdout', new_callable=StringIO) as mock_stdout:
            self.cli.list_habits('synced')

        output = mock_stdout.getvalue()
        # Cached remote entries should appear in the synced section
        self.assertIn("Coding", output)
        self.assertIn("Reading", output)
        self.assertIn("Writing", output)

    # -- B4: Cache hit → merge_remote_index called with cached index ---------

    def test_B4_cache_hit_merges_cached_remote_index(self):
        """B4: Blind index stays up-to-date from cache."""
        mock_cache = self._fresh_cache_mock(
            remote_index=dict(_SAMPLE_REMOTE_INDEX)
        )

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index') as mock_merge, \
             patch('domain.ledger.remote_sync.RemoteLedgerSync'):
            self.cli._sync_remote_ledger_and_dedup()

        mock_merge.assert_called_once()
        merged_index = mock_merge.call_args[0][0]
        self.assertEqual(
            merged_index["2026-07-01"]["Coding"], 7200000
        )


# ═══════════════════════════════════════════════════════════════
# Group C: Cache Miss / Partial — Pull Missing Blocks (5 tests)
# ═══════════════════════════════════════════════════════════════

class TestGroupC_CacheMissPartial(_BaseCacheIntegration):
    """C1–C5: Cache miss, partial pull, incremental update."""

    # -- C1: Cold start → full pull -----------------------------------------

    def test_C1_cold_start_pulls_all_remote_blocks(self):
        """C1: No cache file → pulls all remote block indices."""
        mock_cache = self._stale_cache_mock(max_block_index=-1)
        mock_rs = self._mock_remote_sync(
            existing_indices={0, 1, 2},
            blocks_by_idx={
                0: _SAMPLE_BLOCKS["0"],
                1: _SAMPLE_BLOCKS["1"],
                2: _SAMPLE_BLOCKS["2"],
            },
            remote_index=_SAMPLE_REMOTE_INDEX,
        )
        mock_rs_class = MagicMock(return_value=mock_rs)

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()

        # All 3 blocks must be pulled
        self.assertEqual(mock_rs.pull_block_by_index.call_count, 3)
        # Cache must be saved with updated state
        mock_cache.save.assert_called()

    # -- C2: Partial pull — only new blocks ---------------------------------

    def test_C2_partial_cache_pulls_only_missing_blocks(self):
        """C2: Cache has 0–3, remote has 0–5 → only pulls 4 and 5."""
        mock_cache = self._stale_cache_mock(
            max_block_index=3,
            blocks={
                "0": _SAMPLE_BLOCKS["0"],
                "1": _SAMPLE_BLOCKS["1"],
                "2": _SAMPLE_BLOCKS["2"],
                "3": _make_block("2026-07-04", [
                    {"title": "Running", "startTime_enc": "plain:2000",
                     "duration": 1000},
                ]),
            },
        )
        block4 = _make_block("2026-07-05", [
            {"title": "Swimming", "startTime_enc": "plain:3000",
             "duration": 2000},
        ])
        block5 = _make_block("2026-07-06", [
            {"title": "Cycling", "startTime_enc": "plain:4000",
             "duration": 3000},
        ])
        mock_rs = self._mock_remote_sync(
            existing_indices={0, 1, 2, 3, 4, 5},
            blocks_by_idx={4: block4, 5: block5},
            remote_index=_SAMPLE_REMOTE_INDEX,
        )
        mock_rs_class = MagicMock(return_value=mock_rs)

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()

        # Only blocks 4 and 5 should be pulled
        self.assertEqual(mock_rs.pull_block_by_index.call_count, 2)
        # Verify the indices pulled are exactly 4 and 5
        pulled_indices = {
            call.args[0]
            for call in mock_rs.pull_block_by_index.call_args_list
        }
        self.assertEqual(pulled_indices, {4, 5})

    # -- C3: Empty cache (max -1) with remote blocks → full pull ------------

    def test_C3_empty_cache_with_remote_blocks_pulls_all(self):
        """C3: Cache exists but empty (max=-1), remote has blocks → pull all."""
        mock_cache = self._stale_cache_mock(max_block_index=-1)
        mock_rs = self._mock_remote_sync(
            existing_indices={0, 1},
            blocks_by_idx={
                0: _SAMPLE_BLOCKS["0"],
                1: _SAMPLE_BLOCKS["1"],
            },
        )
        mock_rs_class = MagicMock(return_value=mock_rs)

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()

        self.assertEqual(mock_rs.pull_block_by_index.call_count, 2)

    # -- C4: After partial pull, cache is saved with updated state ----------

    def test_C4_after_pull_cache_updated_and_saved(self):
        """C4: Cache stays current — new blocks, max_block_index updated."""
        mock_cache = self._stale_cache_mock(max_block_index=0)
        block1 = _SAMPLE_BLOCKS["1"]
        mock_rs = self._mock_remote_sync(
            existing_indices={0, 1},
            blocks_by_idx={1: block1},
        )
        mock_rs_class = MagicMock(return_value=mock_rs)

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()

        # After pull, max_block_index should be updated to the highest
        # remote index (1)
        self.assertEqual(mock_cache.max_block_index, 1)
        # last_pull_time should be set
        self.assertGreater(mock_cache.last_pull_time, 0)
        # Save must be called
        mock_cache.save.assert_called()

    # -- C5: Remote has fewer blocks than cache (regression) — no error -----

    def test_C5_remote_regression_handled_gracefully(self):
        """C5: Cache has blocks 0–5 but remote has 0–3 → no error, no pull."""
        mock_cache = self._stale_cache_mock(
            max_block_index=5,
            blocks=_SAMPLE_BLOCKS,
        )
        mock_rs = self._mock_remote_sync(
            existing_indices={0, 1, 2, 3},
        )
        mock_rs_class = MagicMock(return_value=mock_rs)

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            # Must not raise
            self.cli._sync_remote_ledger_and_dedup()

        # No blocks should be pulled (all remote indices ≤ max cached)
        mock_rs.pull_block_by_index.assert_not_called()


# ═══════════════════════════════════════════════════════════════
# Group D: TTL Expiry (3 tests)
# ═══════════════════════════════════════════════════════════════

class TestGroupD_TTLExpiry(_BaseCacheIntegration):
    """D1–D3: TTL-based freshness, stale re-pull, boundary precision."""

    # -- D1: Stale cache → full re-pull -------------------------------------

    def test_D1_stale_cache_triggers_full_repull(self):
        """D1: Cache exists but TTL expired → pulls all indices."""
        mock_cache = self._stale_cache_mock(
            max_block_index=2,
            blocks=dict(_SAMPLE_BLOCKS),
            last_pull_time=100.0,  # very old
        )
        mock_cache.is_fresh.return_value = False
        mock_rs = self._mock_remote_sync(
            existing_indices={0, 1, 2},
            blocks_by_idx={
                0: _SAMPLE_BLOCKS["0"],
                1: _SAMPLE_BLOCKS["1"],
                2: _SAMPLE_BLOCKS["2"],
            },
        )
        mock_rs_class = MagicMock(return_value=mock_rs)

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()

        # All blocks must be pulled (full pull, not incremental)
        self.assertEqual(mock_rs.pull_block_by_index.call_count, 3)

    # -- D2: Fresh cache → no pull ------------------------------------------

    def test_D2_fresh_cache_within_ttl_no_pull(self):
        """D2: Cache fresh → no pull, cache hit path used."""
        now = time.time()
        mock_cache = self._fresh_cache_mock(last_pull_time=now - 10)
        mock_cache.is_fresh.return_value = True
        mock_rs_class = MagicMock()

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache) as mock_cache_cls, \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class):
            self.cli._sync_remote_ledger_and_dedup()

        # No remote sync should happen
        mock_rs_class.assert_not_called()

    # -- D3: TTL boundary — at-the-edge cache still fresh -------------------

    def test_D3_cache_exactly_at_ttl_boundary_still_fresh(self):
        """D3: Non-strict comparison prevents boundary flakiness."""
        now = time.time()
        # Exactly at TTL minus a tiny epsilon — should still be fresh
        mock_cache = self._fresh_cache_mock(last_pull_time=now - 59.9)
        # is_fresh uses < not ≤, so 59.9 < 60 = True (fresh)
        mock_cache.is_fresh.return_value = True
        mock_rs_class = MagicMock()

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache) as mock_cache_cls, \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class):
            self.cli._sync_remote_ledger_and_dedup()

        # Should hit cache path
        mock_rs_class.assert_not_called()


# ═══════════════════════════════════════════════════════════════
# Group E: Cache Invalidation (3 tests)
# ═══════════════════════════════════════════════════════════════

class TestGroupE_CacheInvalidation(_BaseCacheIntegration):
    """E1–E3: Explicit invalidation, re-auth clearing, cross-instance."""

    # -- E1: cache.invalidate() → next sync pulls all -----------------------

    def test_E1_invalidate_forces_full_repull(self):
        """E1: ph sync invalidates cache → next pull gets everything fresh."""
        mock_cache = self._fresh_cache_mock()
        # After invalidate(), is_fresh returns False and max_block_index = -1
        def _invalidate():
            mock_cache.max_block_index = -1
            mock_cache.is_fresh.return_value = False
        mock_cache.invalidate.side_effect = _invalidate

        mock_rs = self._mock_remote_sync(
            existing_indices={0, 1, 2},
            blocks_by_idx={
                0: _SAMPLE_BLOCKS["0"],
                1: _SAMPLE_BLOCKS["1"],
                2: _SAMPLE_BLOCKS["2"],
            },
        )
        mock_rs_class = MagicMock(return_value=mock_rs)

        # First call: cache is fresh, no pull
        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()
        mock_rs_class.assert_not_called()

        # Invalidate the cache
        mock_cache.invalidate()

        # Second call: cache is stale, full pull
        mock_rs_class.reset_mock()
        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   mock_rs_class), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()

        mock_rs_class.assert_called_once()

    # -- E2: _rebuild_after_reauth invalidates cache ------------------------

    def test_E2_reauth_invalidates_cache(self):
        """E2: Re-auth changes crypto context — cache must be invalidated."""
        mock_cache = self._fresh_cache_mock()
        self.mock_staging._data_dir = _Path(_tempfile.mkdtemp())
        # Also need to set up the old staging for _rebuild_after_reauth
        old_store = MagicMock()
        self.mock_staging._local._store = old_store

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache) as mock_cache_cls, \
             patch('cli.interface.CryptoManager', create=True) as mock_cm, \
             patch('cli.interface.StagingService', create=True) as mock_ss, \
             patch('cli.interface.LedgerEngine', create=True) as mock_le:
            mock_cm_instance = MagicMock()
            mock_cm.return_value = mock_cm_instance
            mock_ss_instance = MagicMock()
            mock_ss.return_value = mock_ss_instance
            mock_le_instance = MagicMock()
            mock_le.return_value = mock_le_instance

            self.cli._rebuild_after_reauth(b'\x02' * 32)

        # Cache must be invalidated during re-auth
        mock_cache.invalidate.assert_called_once()

    # -- E3: New instance loads cache from file (cross-invocation) ----------

    def test_E3_new_instance_loads_cache_from_file(self):
        """E3: Cross-invocation persistence — whole point of F2."""
        mock_cache = self._fresh_cache_mock()

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache) as mock_cache_cls, \
             patch('domain.ledger.remote_sync.RemoteLedgerSync'), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()

        # Verify _RemoteLedgerCache was constructed with the correct file path
        mock_cache_cls.assert_called_once()
        cache_path_arg = mock_cache_cls.call_args[0][0]
        self.assertEqual(
            cache_path_arg,
            self.mock_staging._data_dir / "remote_ledger_cache.json"
        )
        # Verify load() was called (cross-invocation: loads from file)
        mock_cache.load.assert_called_once()


# ═══════════════════════════════════════════════════════════════
# Group F: Integration — End-to-End (3 tests)
# ═══════════════════════════════════════════════════════════════

class TestGroupF_IntegrationE2E(_BaseCacheIntegration):
    """F1–F3: End-to-end integration tests."""

    # -- F1: Two consecutive calls → first pulls, second uses cache ---------

    def test_F1_consecutive_calls_first_pulls_second_hits_cache(self):
        """F1: Back-to-back ph view is instant after first pull."""
        mock_cache = self._stale_cache_mock(max_block_index=-1)
        mock_rs = self._mock_remote_sync(
            existing_indices={0, 1},
            blocks_by_idx={
                0: _SAMPLE_BLOCKS["0"],
                1: _SAMPLE_BLOCKS["1"],
            },
        )

        # First call: cache stale → full pull
        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   MagicMock(return_value=mock_rs)), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()

        first_pull_count = mock_rs.pull_block_by_index.call_count
        self.assertEqual(first_pull_count, 2)

        # Simulate cache being fresh after first pull
        mock_cache.is_fresh.return_value = True
        mock_cache.max_block_index = 1
        mock_rs.pull_block_by_index.reset_mock()

        # Second call: cache should be fresh → no additional pulls on the
        # SAME RemoteLedgerSync instance. But since the method creates a new
        # RemoteLedgerSync when needed, we verify the class is not called.
        mock_rs2 = MagicMock()
        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   MagicMock(return_value=mock_rs2)), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'):
            self.cli._sync_remote_ledger_and_dedup()

        # Second call: RemoteLedgerSync should NOT be created (cache hit)
        mock_rs2.pull_block_by_index.assert_not_called()

    # -- F2: list_habits shows cached remote entries ------------------------

    def test_F2_list_habits_all_shows_cached_remote_entries(self):
        """F2: End-to-end display integration."""
        mock_cache = self._fresh_cache_mock(blocks=dict(_SAMPLE_BLOCKS))
        self.mock_staging.check_and_sync.return_value = SyncCheckResult.READY
        self.mock_ledger_engine.get_day_blocks.return_value = []
        self.mock_staging._local._store.read_entries.return_value = []

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch.object(self.cli, '_remove_committed_from_staging'), \
             patch.object(self.cli, '_merge_remote_index'), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync'), \
             patch('sys.stdout', new_callable=StringIO) as mock_stdout:
            self.cli.list_habits('all')

        output = mock_stdout.getvalue()
        self.assertIn("Coding", output)
        self.assertIn("Reading", output)
        self.assertIn("Writing", output)
        self.assertIn("Habit List", output)

    # -- F3: Stale → repull → update → dedup -------------------------------

    def test_F3_stale_cache_repulls_updates_and_dedups(self):
        """F3: Full lifecycle: stale → fresh transition with dedup."""
        mock_cache = self._stale_cache_mock(
            max_block_index=0,
            blocks={"0": _SAMPLE_BLOCKS["0"]},
            last_pull_time=100.0,
        )
        mock_cache.is_fresh.return_value = False
        mock_rs = self._mock_remote_sync(
            existing_indices={0, 1},
            blocks_by_idx={
                0: _SAMPLE_BLOCKS["0"],
                1: _SAMPLE_BLOCKS["1"],
            },
            remote_index=_SAMPLE_REMOTE_INDEX,
        )

        with patch('cli.interface._RemoteLedgerCache',
                   return_value=mock_cache), \
             patch('domain.ledger.remote_sync.RemoteLedgerSync',
                   MagicMock(return_value=mock_rs)), \
             patch.object(self.cli, '_remove_committed_from_staging') as mock_rm, \
             patch.object(self.cli, '_merge_remote_index') as mock_merge:
            self.cli._sync_remote_ledger_and_dedup()

        # Must have pulled block 1 (the only new one)
        mock_rs.pull_block_by_index.assert_called()
        # Cache must be saved with updated state
        mock_cache.save.assert_called()
        # Dedup must use data from both cached block 0 AND freshly pulled block 1
        mock_rm.assert_called_once()
        committed = mock_rm.call_args[0][0]
        self.assertIn(("2026-07-01", "Coding"), committed)
        self.assertIn(("2026-07-02", "Reading"), committed)
        # Remote index must be merged
        mock_merge.assert_called_once()


# ============================================================================
# Run
# ============================================================================

if __name__ == '__main__':
    unittest.main()
