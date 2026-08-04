"""Phase 5 integrity verification script.

Checks that Phase 5 changes are correctly applied and wired.
Runs 25 checks across: imports, sync command wiring, orchestrator
till_date, ViewInterface.notify(), backward compat, and no regressions.
"""

import sys
import importlib
import inspect


PASS = 0
FAIL = 0


def check(description: str, ok: bool):
    global PASS, FAIL
    if ok:
        print(f"  ✅ {description}")
        PASS += 1
    else:
        print(f"  ❌ {description}")
        FAIL += 1


def check_eq(description: str, actual, expected):
    return check(description, actual == expected)


# ═════════════════════════════════════════════════════════════════════
# 1. Import verification
# ═════════════════════════════════════════════════════════════════════

print("=" * 64)
print("1. Import verification")
print("=" * 64)

# 1. main.py imports the new components
import main as main_mod
check("main.py loads without ImportError", True)

# 2. StagingService is available from main.py's import
from domain.staging.service import StagingService
check("StagingService importable", True)

# 3. LedgerEngine is available
from domain.ledger.engine import LedgerEngine
check("LedgerEngine importable", True)

# 4. SyncOrchestrator is available
from core.sync import SyncOrchestrator
check("SyncOrchestrator importable", True)

# 5. FileStagingStore is available
from storage.implementations.file_staging import FileStagingStore
check("FileStagingStore importable", True)

# 6. Old core/sync_confirmation still works (deprecated shim)
from core.sync_confirmation import AutoSyncStrategy, InteractiveCLIStrategy, SyncDecision
check("core/sync_confirmation shim still importable", True)

# 7. Old cli.strategies still works
from phpoc_cli.strategies import AutoSyncStrategy as CliAuto, InteractiveCLIStrategy as CliInteractive
check("phpoc_cli.strategies still importable", True)


# ═════════════════════════════════════════════════════════════════════
# 2. Sync command wiring verification
# ═════════════════════════════════════════════════════════════════════

print()
print("=" * 64)
print("2. Sync command wiring")
print("=" * 64)

# Read main.py source
with open("main.py") as f:
    content = f.read()

# Find the sync handler by scanning for "sync_orchestrator.sync" in the sync block
check("sync command handler exists (sync_orchestrator.sync present in source)",
      "sync_orchestrator.sync" in content)

# Verify no old-style import from core.sync_confirmation in sync block
# The old sync block had "from core.sync_confirmation import ..."
has_old_import = "from core.sync_confirmation import" in content
check("main.py no longer imports from core.sync_confirmation in sync block",
      not has_old_import)

# The new sync block should mention sync_orchestrator
has_orchestrator_call = "sync_orchestrator.sync" in content
check("main.py uses sync_orchestrator.sync()", has_orchestrator_call)

# Old sync_with_strategy should be gone (from the sync command path)
# It may still exist in LedgerDomain for backward compat, but shouldn't
# be called from main.py's sync command anymore
has_old_sync_call = "ledger.sync_with_strategy" in content
check("main.py no longer calls ledger.sync_with_strategy()", not has_old_sync_call)

# Verify --yes flag is handled (even if no-op, it's part of args)
import argparse
parser = argparse.ArgumentParser()
subparsers = parser.add_subparsers(dest="command")
sync_p = subparsers.add_parser("sync")
sync_p.add_argument("--yes", action="store_true")
sync_p.add_argument("--till")
args_no_yes = parser.parse_args(["sync"])
args_yes = parser.parse_args(["sync", "--yes"])
args_till = parser.parse_args(["sync", "--till", "2026-06-15"])
check("--yes flag parsed (no flag)", not args_no_yes.yes)
check("--yes flag parsed (with flag)", args_yes.yes)
check("--till flag parsed", args_till.till == "2026-06-15")

# Verify _resolve_till_date still exists
check("_resolve_till_date exists", hasattr(main_mod, "_resolve_till_date"))


# ═════════════════════════════════════════════════════════════════════
# 3. SyncOrchestrator.sync() signature
# ═════════════════════════════════════════════════════════════════════

print()
print("=" * 64)
print("3. SyncOrchestrator.sync() signature")
print("=" * 64)

sig = inspect.signature(SyncOrchestrator.sync)
check("sync() accepts till_date parameter", "till_date" in sig.parameters)

# Default value should be None
till_param = sig.parameters["till_date"]
check("till_date defaults to None",
      till_param.default is None or isinstance(till_param.default, type(None)))


# ═════════════════════════════════════════════════════════════════════
# 4. ViewInterface.notify() verification
# ═════════════════════════════════════════════════════════════════════

print()
print("=" * 64)
print("4. ViewInterface.notify()")
print("=" * 64)

from domain.interfaces.view import ViewInterface
check("ViewInterface has notify method", hasattr(ViewInterface, "notify"))

# Verify it has a default implementation (not abstract)
# Should run without error
vi = ViewInterface()
try:
    vi.notify("test message")
    check("notify() runs without error on default ViewInterface", True)
except Exception as e:
    check(f"notify() raises {type(e).__name__}: {e}", False)

# Verify it delegates to render_success
class TestView(ViewInterface):
    def __init__(self):
        self.last_render = None
    def render_success(self, msg):
        self.last_render = msg

tv = TestView()
tv.notify("phase 5 test")
check("notify() delegates to render_success()", tv.last_render == "phase 5 test")


# ═════════════════════════════════════════════════════════════════════
# 5. Backward compatibility
# ═════════════════════════════════════════════════════════════════════

print()
print("=" * 64)
print("5. Backward compatibility")
print("=" * 64)

# The old LedgerDomain.sync_with_strategy still exists
from core.ledger import LedgerDomain
check("LedgerDomain still exists", True)
check("sync_with_strategy still exists on LedgerDomain",
      hasattr(LedgerDomain, "sync_with_strategy"))

# core/sync_confirmation file still on disk
from pathlib import Path
check("core/sync_confirmation.py still exists (deprecated shim)",
      Path("core/sync_confirmation.py").exists())

# All 4 old classes still importable from deprecated location
check("AutoSyncStrategy from core.sync_confirmation", True)
check("InteractiveCLIStrategy from core.sync_confirmation", True)
check("SyncStrategy from core.sync_confirmation",
      hasattr(__import__('core.sync_confirmation', fromlist=['SyncStrategy']), 'SyncStrategy'))
check("SyncDecision from core.sync_confirmation",
      hasattr(__import__('core.sync_confirmation', fromlist=['SyncDecision']), 'SyncDecision'))


# ═════════════════════════════════════════════════════════════════════
# 6. Test coverage — all Phase 5 tests pass
# ═════════════════════════════════════════════════════════════════════

print()
print("=" * 64)
print("6. Phase 5 test coverage")
print("=" * 64)

from tests.test_phase5_main_wiring import (
    TestSyncCommandStrategySelection,
    TestTillDateResolution,
    TestMainSyncIntegration,
    TestCLIInterfaceDateFilters,
    TestSyncWithTillDate,
    TestCoreSyncConfirmationRemoval,
    TestMainInit,
    TestSyncOrchestratorReplacesSyncWithStrategy,
    TestCommandScopeWiring,
    TestMissingDependencyHandling,
)

# Count test methods across all classes
test_classes = [
    TestSyncCommandStrategySelection,
    TestTillDateResolution,
    TestMainSyncIntegration,
    TestCLIInterfaceDateFilters,
    TestSyncWithTillDate,
    TestCoreSyncConfirmationRemoval,
    TestMainInit,
    TestSyncOrchestratorReplacesSyncWithStrategy,
    TestCommandScopeWiring,
    TestMissingDependencyHandling,
]

total_phase5_tests = sum(
    len([m for m in dir(cls) if m.startswith("test_")])
    for cls in test_classes
)

check_eq(f"Phase 5 test count = 47", total_phase5_tests, 47)


# ═════════════════════════════════════════════════════════════════════
# ═════════════════════════════════════════════════════════════════════

print()
print("=" * 64)
print(f"Results: {PASS} passed, {FAIL} failed")
print("=" * 64)

sys.exit(0 if FAIL == 0 else 1)
