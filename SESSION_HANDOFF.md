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
- **Flutter test suite:** 1207/1209 GREEN (2 pre-existing restore_integration flaky: G3, G8 — pass in isolation)
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`)

### Recent commits (Mon Jul 28)
- _(Genesis export correction changes unstaged — Phase 2 RED tests written)_
- _(Phase 4 REFACTOR changes unstaged — Block Reconstruction)_
- `becbf08` — feat(flutter): Python-compatible field-level decrypt for cross-client data
- `2d4a8f3` — feat(flutter): monospace font on all text input fields
- `7e67f0e` — test(flutter): Group J cross-reference history dates
- `c240bbe` — fix(flutter): entry timestamps — pass encrypted fields from blocks
- `40724ce` — fix(flutter): unlock uses reauthenticate()
- `44399a5` — fix(flutter): restore-from-cloud surfaces credential errors in UI
- `ebbcb37` — fix(flutter): deriveMasterKey matches Python, staging format
- `a983a55` — refactor(flutter): Phase 4 lint fixes
- `b3c64fc` — docs: user-must-initiate git operations rule (not pushed)

### Recent fixes
- **Seal field fix** (Jul 28): LedgerBackupService + LedgerPushService seal fields corrected (`identitySeal`→`blockId`). Extracted `PhpSpecFormat` utility. 82/82 ✅
- **LedgerEngine→SyncService** (Jul 27): Wired via LedgerBlockStore/LedgerIndexStore adapters. Sync errors now surfaced.
- **Pause display** (Jul 27): Fixed wrong field names (`start_epoch`→`pause_start`) causing ~495,860h durations.

## Completed ✅

### ✅ Sync-to-remote _dependents.isEmpty assertion (2026-07-28)
- **Root cause:** `_buildPushToCloudButton()` used `ref.watch(ledgerPushServiceProvider)` inside `build()`. After `checkAndSync()` completed, cascading provider invalidation coincided with the rebuild cycle, leaving a live dependency on the old InheritedElement during its disposal.
- **Fix:** Changed `ref.watch` → `ref.read` (1 line). The button doesn't need reactive rebuild.
- **Test:** L6 regression test (24/24 GREEN): sync → rebuild → push button still visible + functional.

### ✅ Flutter File Import — 4-Phase TDD Complete (2026-07-28)
- 20 assertions (L1–L10 service, M1–M10 UI) → 20 GREEN.
- Phase 4: 3 improvements (1 modularity: extracted `_writeStagingEntries` to deduplicate v1/v2 staging loops; 2 clarity: renamed `// ── Import from File ──` to `// ── Seed File Picker ──` before `_pickSeedFile`, added comment explaining Python/Flutter field name dual-key resolution in `_mapStagingEntry`).

### ✅ Dashboard Screen — 4-Phase TDD Complete (2026-07-28)
- 31 assertions (E1–E16, T1–T12, U1–U3) → 31 GREEN.
- Phase 4: 5 improvements (1 modularity: extracted `_buildActiveCardActions`; 2 clarity: renamed `_expandedActive`→`_expandedActiveIds`, comment on index-based tracking; 2 conciseness: arrow-fn tag maps).

### ✅ Settings Screen — 4-Phase TDD (2026-07-28)
- 13 assertions (H1–H13) → 13 GREEN. Phase 3 fixed 2 bugs (controller dispose timing, _FocusInheritedScope assertion). Phase 4 cleaned dead comments.

### ✅ Genesis Export + Push Service + Block Reconstruction + RESTORE_CLOUD_ERRORS
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

## Immediate Next Steps 🎯

### 1. B-03: Flutter Staging Schema Overhaul — Phase 2 (RED)
- Blueprint complete: `docs/planning/flutter/STAGING_OVERHAUL_PHASE1.md` (110 assertions, 11 groups A–K)
- Subsumes B-02 (auto-push folded into mutation wrappers, Group D–E)
- Phase 2: Write 110 RED tests across activity_id, staging_store, migration, sync mutations, debounce, commit-and-clean, offline queue, hash index, sync screen UI, merge engine, legacy compat

## Known Issues
- 2 pre-existing restore_integration flaky tests (G3, G8) — pass in isolation, fail in full suite due to test isolation
