# Session History — 2026-07-25 through 2026-07-28 (Archived)

Archived from `SESSION_HANDOFF.md` on 2026-07-28 (119 → under 100 lines).

## Archived Steps

### F-07: Fix stale `markCommitted` signature
- Already correct — no changes needed

### Millisecond collision flakiness (F3/L1/S4/S6/S7)
- Fixed: auto-increment + optional startEpoch

### F-06: Add empty-title validation to dashboard
- Already implemented — was stale BACKLOG entry

### Step 1: Rename Group J → X in `restore_from_cloud_test.dart`

### Step 2: Fix X1 — E2E cross-reference
- `_buildAndPersistGenesis` was inside success block — never ran on failure/empty pull
- Fix: two-phase genesis creation (before + after pull)
- testdata/ledger.json re-pushed to R2 Worker
- Pull timeout 60s→120s, connect timeout 10s→20s
- Result: restore_from_cloud: 20/20 GREEN

### Step 3: RESTORE_CLOUD_ERRORS
- 10 assertions → 10 tests GREEN, 79 total

### Step 4: Update E4-E16 dashboard blueprint
- Replaced single-active with multi-active E4–E19 (16 assertions)
- Groups T (12) + U (3) — multi-active cards, Pending Commit, pause isolation
- Total: 109 → 112 assertions

## Recent fixes (archived)

### LedgerBackupService + LedgerPushService export seal field fix
- Seal fields were `identitySeal` instead of `blockId`
- Extracted shared `PhpSpecFormat` utility
- 82/82 tests GREEN

### LedgerEngine wired to SyncService
- syncServiceProvider created SyncService without ledgerEngine
- Created LedgerBlockStore/LedgerIndexStore adapters
- Sync screen now shows actual error

### Pause display fix
- Dashboard/history used wrong field names (start_epoch→pause_start, end_epoch→pause_stop)
- Fixed in dashboard_screen.dart + history_screen.dart
