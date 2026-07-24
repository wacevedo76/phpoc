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
- **Flutter test suite:** 1063/1063 GREEN ✅ (Phase 3 — all new tests pass)

### Recent commits (Fri Jul 24)
- _(Phase 3 + Phase 4 changes unstaged)_
- `becbf08` — feat(flutter): Python-compatible field-level decrypt for cross-client data
- `2d4a8f3` — feat(flutter): monospace font on all text input fields
- `7e67f0e` — test(flutter): Group J cross-reference history dates
- `c240bbe` — fix(flutter): entry timestamps — pass encrypted fields from blocks
- `40724ce` — fix(flutter): unlock uses reauthenticate()
- `44399a5` — fix(flutter): restore-from-cloud surfaces credential errors in UI
- `ebbcb37` — fix(flutter): deriveMasterKey matches Python, staging format
- `a983a55` — refactor(flutter): Phase 4 lint fixes
- `b3c64fc` — docs: user-must-initiate git operations rule (not pushed)

### Key fixes today
- **Jan-1-1970 timestamps:** Two-layer fix: (1) `_seedStagingFromBlocks` now reads `startTime_enc` (not non-existent `start_epoch`), (2) `decryptFieldValue` matches Python's HMAC-sub-key derivation so Python-encrypted fields decrypt correctly in Flutter
- **Cross-platform decrypt:** `LocalCache._decrypt()` tries standard decrypt then falls back to `decryptFieldValueWithCachedKey()` (Python-compatible)
- **Error surfacing:** `restoreFromCloud` returns `PullResult`; connection/auth/deobfuscation errors propagated to UI
- **Unlock fix:** `unlock_screen.dart` calls `reauthenticate()` — decrypts real seed from genesis via PDK
- **R2 data:** `testdata/ledger.json` regenerated with Python-encrypted hex fields; pushed to `phpoc-staging-testing`

## Immediate Next Steps 🎯

### ✅ Calendar View — 4-Phase TDD Complete
**Phase 4 complete:** 4 improvements applied. All 1063 tests GREEN.
- Extracted `monthAbbr` constant + `parseIsoDateStr` to `FormatUtils` (eliminated 3× month-name duplication)
- Renamed `_allEntries` → `_rangeFilteredEntries` for clarity
- Extracted `_dateGroupLabel` helper from `_buildDateGroups`
- Flattened `_buildGroupedItem` → `_buildEntryList` with `_FlatItem` (O(1) indexing)

**Next:** See BACKLOG.md for open Flutter tasks or user direction.

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)
- **Test ledger:** `testdata/ledger.json` — 31 blocks, 146 entries, Python-encrypted hex fields

## Files Created (Calendar View)
- `phpoc-flutter/lib/features/history/calendar_month_grid.dart` — CalendarMonthGrid widget

## Files Modified (Calendar View)
- `phpoc-flutter/lib/core/utils/format_utils.dart` — +epochToDateStr(int?)
- `phpoc-flutter/lib/data/sync/sync_service.dart` — +getCompleted(), fixed getEntries(to:) UTC+end-of-day
- `phpoc-flutter/lib/features/history/history_screen.dart` — calendar embed, single-date toggle, date grouping
- `phpoc-flutter/test/core/utils/format_utils_test.dart` — fixed K2/K4 epoch values to UTC midnight

## Files Created (Phase 2)
- `phpoc-flutter/test/core/utils/format_utils_test.dart` — Group K (4 tests)
- `phpoc-flutter/test/features/calendar_month_grid_test.dart` — Group M (10 tests)

## Files Modified (Phase 2)
- `phpoc-flutter/test/data/sync/sync_service_test.dart` — +Groups L (5) + P (3)
- `phpoc-flutter/test/features/history_screen_test.dart` — +Groups N (8) + O (4)

## Known Issues
- **7 vitest files fail** with environment/teardown errors (pre-existing, all individual tests pass)
