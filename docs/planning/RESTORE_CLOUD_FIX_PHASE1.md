# Restore-from-Cloud: Pull Ledger Blocks — Test Exploration (Phase 1)

> **Bug:** `restoreFromCloud()` creates a new genesis and never pulls ledger blocks.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

The fix touches three files:
1. `onboarding_service.dart` — `restoreFromCloud()` removes `_buildAndPersistGenesis()`, adds `LedgerPullService.pullAll()`
2. `ledger_pull_service.dart` — `_doPullAll()` seeds staging entries after import (as docstring claims)
3. `providers.dart` — new `ledgerPullServiceProvider`, wired into `onboardingServiceProvider`

## Test Groups

### Group G: restoreFromCloud — ~5 tests
| ID | Assertion | Rationale |
|----|-----------|-----------|
| G1 | `restoreFromCloud` does NOT create a genesis block | Genesis must come from R2, not locally generated |
| G2 | `restoreFromCloud` calls `LedgerPullService.pullAll()` | Must pull actual ledger blocks |
| G3 | `restoreFromCloud` seeds staging entries from pulled blocks | Dashboard/History read from staging |
| G4 | `restoreFromCloud` still validates seed before any writes | Security gate unchanged |
| G5 | `restoreFromCloud` handles pull failure gracefully | Best-effort (A5/A10/H5 contract) |

### Group H: LedgerPullService seeds staging — ~4 tests
| ID | Assertion | Rationale |
|----|-----------|-----------|
| H1 | `pullAll` inserts entries into staging after block import | Dashboard reads staging, not blocks table |
| H2 | `pullAll` does NOT duplicate entries already in staging | Idempotent |
| H3 | `pullAll` with empty remote does not crash | Edge case |
| H4 | Staging entries have correct fields (title, start_epoch, duration, tags, date) | Format match for UI rendering |

### Group I: Integration — ~2 tests
| ID | Assertion | Rationale |
|----|-----------|-----------|
| I1 | Full restore flow: seed→MK→pull→staging has entries | End-to-end |
| I2 | Restore without Worker connection still works (local genesis) | Graceful degradation |

**Total: ~11 assertions across 3 groups**
