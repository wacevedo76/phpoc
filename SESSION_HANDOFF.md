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
- **Flutter test suite:** 1029/1029 GREEN, 0 failures

### Recent commits (Fri Jul 24)
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

### 🔜 Calendar View — Phase 2 (RED tests)
**Phase 1 doc:** `docs/planning/flutter/CALENDAR_VIEW_PHASE1.md` — 34 assertions across 6 groups (K–P)

- K (4): FormatUtils date helpers (`epochToDateStr`)
- L (5): `SyncService.getCompleted()` — completion filter + date normalization
- M (10): `CalendarMonthGrid` widget — month grid, green dots, navigation, selection
- N (8): `HistoryScreen` calendar integration — tap-day filter, chips, range picker
- O (4): Date-grouped entry display with headers ("Today", "Yesterday", "Jun 1")
- P (3): Date range filter fix — inclusive end-date boundary

**Web reference:** `phpoc-web/src/components/screens/History.jsx` — collapsible calendar grid with green dots and single-date filter

**Start Phase 2:** Write failing tests per the Phase 1 assertion table, then implement in Phase 3.

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)
- **Test ledger:** `testdata/ledger.json` — 31 blocks, 146 entries, Python-encrypted hex fields

## Known Issues
- **Calendar grid + green dots not implemented** — see Phase 1 doc
- **Date range filter may have off-by-one on end date** — midnight vs end-of-day
- **7 vitest files fail** with environment/teardown errors (pre-existing, all individual tests pass)
