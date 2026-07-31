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
- **Flutter test suite:** 1416/1418 GREEN (2 pre-existing restore_integration flaky: G3, G8 — pass in isolation)
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`)

### Recent commits (Mon Jul 28)
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

_None — all active tasks complete._

### ✅ B-05c: CLI Staging Format Alignment — 4-Phase TDD Complete (2026-07-30)
- Phase 3: 52/52 GREEN — `core/activity_id.py`, `core/staging_hash_index.py` (new); `remote_sync.py` (staging/blob, compact JSON, hash index, no updated_at); `onboarding.py` (path updated); 12 regressions fixed; full suite 2400/2401
- Phase 4: 3 improvements across 2 files — `_xport_pull/_xport_push` helpers eliminate 7 repeated ternary patterns (conciseness+clarity); `_build_lookup_map()` deduplicates dict-building in `compare()` (modularity+conciseness); moved `import time` to module level (clarity)

### ✅ B-05b: Cross-Platform Staging Format Alignment — 4-Phase TDD Complete (2026-07-30)

**Doc:** `docs/planning/CROSS_PLATFORM_STAGING_FORMAT_ALIGNMENT.md`

**Phase 1:** Complete (canonical format in PHPSPEC.md §8)
**Phase 2:** Complete (58 RED tests across 4 files)
**Phase 3:** Complete — 165 GREEN tests, 0 regressions
**Phase 4:** 5 improvements across 3 files:
- `row_sync.js`: removed dead `allCommitted` variable, clarified committed-irreversible control flow (clarity), replaced O(n²) `rem.find()` with O(1) Set (conciseness)
- `entry_dto.js`: extracted `_parsePlainOrEncrypted()` helper — eliminated 4x repeated plain:-prefix + decryption pattern (modularity/conciseness)
- `remote_sync.js`: extracted `_dtoToCanonicalRow()` — separated DTO→canonical conversion (modularity/clarity)
- All B-05b tests GREEN: 165/165, sync_service 289/310 (21 pre-existing, 0 new)

### ✅ B-04: Flutter — Wire cross-device sync for row-level staging — 4-Phase TDD Complete (2026-07-28)
- **Phase 1:** 56 assertions → `docs/planning/flutter/B04_ROW_LEVEL_SYNC_PHASE1.md`
- **Phase 2:** 56 RED tests across 9 groups (A–I), 27 RED / 29 GREEN
- **Phase 3:** 54/54 B-04 tests GREEN + full suite 1412/1414
- **Phase 4:** 5 improvements across 3 files (conciseness: merged duplicate import, consolidated `_pullRemoteRows`→`_pullRemoteBlob`, shared `safeJsonDecode`; clarity: path constant, descriptive comments in `mergeEntries`)
- Full suite: 1412/1414 (2 pre-existing flaky G3, G8)

## Known Issues
- 2 pre-existing restore_integration flaky tests (G3, G8) — pass in isolation, fail in full suite due to test isolation
- **Emulator has 216 stale committed entries** in `_staging_kv` (200KB, `committed: true`) — will be cleared on next commit via temporary cleanup (expires 2026-08-01)
