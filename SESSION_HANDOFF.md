# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`

## Current State
- **Branch:** `feature/flutter-mobile`
- **Flutter test suite:** 1472/1493 passing (22 failing: all pre-existing flaky/date-gated)
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`)

### Recent commits (Mon Jul 28)
- `docs/planning/flutter/B02_IMPORT_UI_PHASE1.md` — Phase 1 blueprint (40 assertions, UI layer)
- _(Genesis export + Block Reconstruction Phase 4 changes unstaged)_
- `becbf08` feat(flutter): Python-compatible field-level decrypt
- `2d4a8f3` feat(flutter): monospace font on text input fields
- `a983a55` refactor(flutter): Phase 4 lint fixes

### Recent fixes
- **Committed entries deleted from staging** (Jul 30): `commitEntries()` now calls `_local.delete()` after `_local.markCommitted()`. Previously, committed entries accumulated in `_staging_kv` with `committed: true` — 216 of 219 entries on the user's device were stale. 5 new tests + 6 updated. 131/131 sync_service + local_cache ✅. **TODO: remove temporary stale-entry cleanup and N18/N3(date-gated) test after 2026-08-01.**
- **Seal field fix** (Jul 28): LedgerBackupService + LedgerPushService seal fields corrected (`identitySeal`→`blockId`). Extracted `PhpSpecFormat` utility. 82/82 ✅
- **LedgerEngine→SyncService** (Jul 27): Wired via LedgerBlockStore/LedgerIndexStore adapters. Sync errors now surfaced.
- **Pause display** (Jul 27): Fixed wrong field names (`start_epoch`→`pause_start`) causing ~495,860h durations.

## Completed ✅

### ✅ B-02 Web: Cross-ledger entry migration — 4-Phase TDD Complete (2026-08-03)
- 30 assertions → 55 GREEN tests → Phase 4: 7 improvements across 2 files.
- New: `import_entries.js` (EntryImporter), `import_service.js` (ImportService + data classes).
- Modified: `App.jsx` (+/import route), `Settings.jsx` (+import tile).
- Phase 4: extracted `_entryData`, `_coerceField`, `_deriveDate` helpers; `_validateSeed`, `_collectTargetData`, `_parseChainBuffer` in ImportService; DRY self-import guard; deduped date-derivation logic. Full suite: 55/55.

### ✅ B-02: Cross-ledger entry import (Flutter) — 4-Phase TDD Complete (2026-08-01)
- 79 assertions → 79 GREEN tests → Phase 4: 5 improvements across 1 file.
- New: `import_result.dart`, `import_service.dart`, `import_screen.dart`, `import_providers.dart`.
- Full suite: 1456/1478 (22 pre-existing).

### ✅ B-02 UI Layer: ImportScreen, sheets, provider, route, settings — 4-Phase TDD Complete (2026-08-03)
- 40 assertions → 40 GREEN tests → Phase 4: 7 improvements across 2 files.
- Phase 4: extracted `_extractSeedAndFile` pattern-match helper (DRY, ~24 lines → ~7), cleaned dead code in `resetToReady()` (11→3 lines), switch pattern matching in `_showProgressSheet`, fixed typo `dragRun()`→`dryRun()`, TODO marker on `_pickFile()`.
- Files: `import_providers.dart`, `import_screen.dart`, `import_preview_sheet.dart`, `import_progress_sheet.dart`, `app_router.dart`, `settings_screen.dart`.
- Full suite: 1472/1493 (22 pre-existing).

### ✅ Flutter Staging Schema Overhaul — 4-Phase TDD Complete (2026-07-28)
- 110 assertions → 111 GREEN tests → Phase 4: 6 improvements (conciseness + clarity) across 3 files. Full suite: 1339/1341.
- New: `activity_id.dart`, `staging_store.dart`, `migration.dart`, `staging_hash_index.dart`. Modified: `merge_engine.dart`, `sync_service.dart`, `sync_screen.dart`.

### ✅ Sync-to-remote _dependents.isEmpty assertion (2026-07-28)
- `ref.watch` → `ref.read` in `_buildPushToCloudButton()`. L6 regression test 24/24.

### ✅ Flutter File Import, Dashboard, Settings, Genesis Export, Push Service, Block Reconstruction, RESTORE_CLOUD_ERRORS
- All completed via 4-Phase TDD (2026-07-28). Details archived to `docs/planning/archive/SESSION_HISTORY_2026-07-25.md`.

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)
- **Test ledger:** `testdata/ledger.json` — 31 blocks, 146 entries, Python-encrypted hex fields

## Sync Workflow — Abstracted Tasks (from docs/design/workflows/)

| # | Task | Flutter Status |
|---|---|---|
| T1 | Genesis Gate | ✅ `GenesisGate.check()` wired |
| T2 | Cookie Check | ✅ Phase 4 complete (7/7 GREEN — K7 configurable TTL wired) |
| T3 | Cookie Compare | ✅ Group M tests written (10/10 GREEN) |
| T4 | Blob Pull | ✅ `_pullRemoteBlob()` wired |
| T5 | Merge | ✅ `MergeEngine.mergeMaps()` wired |
| T6 | Blob Push | ✅ `_pushBlobOnly()` wired |
| T7 | Cookie Push | ✅ `_pushCookie()` wired |
| T8 | Commit to Ledger | ✅ Phase 4 complete (14 Group N + 5 Group R = 19 tests GREEN) |

### ✅ Commit prev_hash mismatch fix — 4-Phase TDD Complete (2026-07-28)
- 17 assertions → 10 RED → 10 GREEN → 5 Phase 4 improvements. Full suite: 1356/1358.

## Immediate Next Steps 🎯

### ✅ B-06: Wire staging sync into restoreFromCloud — 4-Phase TDD Complete (2026-07-31)
**Blueprint:** `docs/planning/flutter/B06_STAGING_SYNC_IN_RESTORE_PHASE1.md` — 12 assertions.
**Phases 2-3:** 9/9 B-06 tests GREEN (A5, A11-A15, G1, G5, G6). 1-line fix: `await syncService.initialPull()` in `restoreFromCloud()`.
**Phase 4:** 4 improvements in `onboarding_service.dart` — extracted `_ensureNoLedger` (4 duplicates), `_validateSeedAndPassphrase` (3 duplicates), `_pullFromCloud` (~100→~25 lines); reused `_postImportSetup` in 3 methods. Full suite: 1419/1426 (7 pre-existing flaky).

### ✅ B-05c: CLI Staging Format Alignment — 4-Phase TDD Complete (2026-07-30)
52/52 GREEN + 3 Phase 4 improvements. Details archived to `docs/planning/archive/SESSION_HISTORY_2026-08-01.md`.

### ✅ B-05b: Cross-Platform Staging Format Alignment — 4-Phase TDD Complete (2026-07-30)
165 GREEN + 5 Phase 4 improvements. Details archived to `docs/planning/archive/SESSION_HISTORY_2026-08-01.md`.

### ✅ B-04: Flutter — Wire cross-device sync for row-level staging — 4-Phase TDD Complete (2026-07-28)
54/54 GREEN + 5 Phase 4 improvements. Details archived to `docs/planning/archive/SESSION_HISTORY_2026-08-01.md`.

## Known Issues
- 2 pre-existing restore_integration flaky tests (G3, G8) — pass in isolation, fail in full suite due to test isolation
- **Emulator has 216 stale committed entries** in `_staging_kv` (200KB, `committed: true`) — will be cleared on next commit via temporary cleanup (expires 2026-08-01)
- **B-06: restoreFromCloud doesn't pull staging** ✅ Fixed (2026-07-31) — staging now synced via `initialPull()` during cloud restore
