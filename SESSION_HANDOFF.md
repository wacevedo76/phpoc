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
- **Flutter test suite:** 1412/1414 GREEN (2 pre-existing restore_integration flaky: G3, G8 — pass in isolation)
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`)

### Recent commits (Mon Jul 28)
- _(Genesis export + Block Reconstruction Phase 4 changes unstaged)_
- `becbf08` feat(flutter): Python-compatible field-level decrypt
- `2d4a8f3` feat(flutter): monospace font on text input fields
- `a983a55` refactor(flutter): Phase 4 lint fixes

### Recent fixes
- **Seal field fix** (Jul 28): LedgerBackupService + LedgerPushService seal fields corrected (`identitySeal`→`blockId`). Extracted `PhpSpecFormat` utility. 82/82 ✅
- **LedgerEngine→SyncService** (Jul 27): Wired via LedgerBlockStore/LedgerIndexStore adapters. Sync errors now surfaced.
- **Pause display** (Jul 27): Fixed wrong field names (`start_epoch`→`pause_start`) causing ~495,860h durations.

## Completed ✅

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
- **Phase 1:** 17 assertions → `docs/planning/flutter/COMMIT_PREV_HASH_MISMATCH_PHASE1.md`
- **Phase 2:** 10 RED tests (Groups AB, AC, AD, AE, AF) across 3 test files
- **Phase 3:** 10 GREEN. Fixed `_blockToMap` (entries-array reconstruction), `_buildSummary` seal consistency, `INSERT OR IGNORE`→`INSERT`, `_FakeBlockDao` dupe detection.
- **Phase 4:** 5 improvements across 4 files (clarity: `store_adapters.dart`, `engine.dart`; conciseness: `store_adapters.dart`, `summary_policy.dart`, `database.dart`). Full suite: 1356/1358.
- **Bug:** `_blockToMap` lost date when data_enc stored entries array → spurious summaries → INSERT OR IGNORE silently dropped → prev_hash mismatch.

## Immediate Next Steps 🎯

### 🔜 B-05: Cross-Platform Staging Format Alignment

**Doc:** `docs/planning/CROSS_PLATFORM_STAGING_FORMAT_ALIGNMENT.md`

Three clients, three incompatible staging architectures.

**Resolved (2026-07-28):**
- ✅ Merge tie-break → local-wins (single-human constraint makes same-ms conflicts theoretical)
- ✅ CLI migration → full StagingStore (SQLite, row-level, activity_id), matching Flutter
- ✅ Transport model → retire row_sync.js; single blob + hash index is canonical
- ✅ `updated_at` → keep at row level (LWW resolution), omit from envelope (hash index supersedes)
- ✅ `entry_id` → activity_id as single canonical key; entry_id is legacy only
- ✅ Backward compat window → immediate cutover (single user, no migration needed)
- ✅ `committed` flag → canonical row field (cross-device cleanup signal, B-01)

**All questions resolved. Phase 1 complete:** canonical format extracted into `docs/spec/PHPSPEC.md` §8 (9 subsections: row schema, blob envelope, hash index, paths, merge strategy, sync workflow, obfuscation & transport, staging vs ledger, legacy format).

**Next action:** Phase 3 (B-05b) — **Web alignment first:**
1. Switch sync gate blob path: `staging/blobs/current.json` → `staging/blob`
2. Wire `buildDiff` + `RowStagingStore` into `_reconcileDifferentDevice`
3. Wire `StagingHashIndex` fast path into `checkAndSync`
4. Align merge tie-break: remote-wins → local-wins
5. Drop `updated_at` from envelope
6. Drop `entry_id` from envelope (keep at row level for legacy compat)
7. Retire `row_sync.js`

**Files to change (6):**
- `phpoc-web/src/sync/keys.js` — `REMOTE_STAGING_BLOB = 'staging/blob'`
- `phpoc-web/src/sync/remote_sync.js` — drop `updated_at` from envelope, emit canonical rows (`{activity_id, activity_status, activity, updated_at, committed}`) instead of raw spec format (`{hash, data: {_enc}}`)
- `phpoc-web/src/sync/sync.js` — wire hash index fast path into `_fastPathPhase`, use canonical `mergeRows()` in `_reconcileDifferentDevice` (no DTO conversion), envelope changes
- `phpoc-web/src/sync/row_sync.js` — delete `RowSyncWorker` class, change S3 tie-break to local-wins, add `mergeRows()` (port Flutter's `MergeEngine.mergeEntries()`)
- `phpoc-web/src/sync/merge_engine.js` — superseded by `mergeRows()`, remove import from `sync.js`
- `phpoc-web/src/sync/staging_hash_index.js` — already correct, wire pull side in `sync.js`

**After Web:** Phase 2 (B-05c) — CLI alignment.

### ✅ B-04: Flutter — Wire cross-device sync for row-level staging — 4-Phase TDD Complete (2026-07-28)
- **Phase 1:** 56 assertions → `docs/planning/flutter/B04_ROW_LEVEL_SYNC_PHASE1.md`
- **Phase 2:** 56 RED tests across 9 groups (A–I), 27 RED / 29 GREEN
- **Phase 3:** 54/54 B-04 tests GREEN + full suite 1412/1414
- **Phase 4:** 5 improvements across 3 files (conciseness: merged duplicate import, consolidated `_pullRemoteRows`→`_pullRemoteBlob`, shared `safeJsonDecode`; clarity: path constant, descriptive comments in `mergeEntries`)
- Full suite: 1412/1414 (2 pre-existing flaky G3, G8)

## Known Issues
- 2 pre-existing restore_integration flaky tests (G3, G8) — pass in isolation, fail in full suite due to test isolation
