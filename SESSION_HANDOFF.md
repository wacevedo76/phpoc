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
- **Flutter test suite:** 1109/1115 GREEN (6 pre-existing failures)

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

## Completed ✅

### ✅ F-03: History G2–G4 — Phase 3+4 Complete
**Root cause:** `_selectedCalendarDate` initialized to today's date in `initState()`, silently filtering all 146 test ledger entries (June 2026) to zero — no Cards rendered.
**Fix:** Removed `_selectedCalendarDate` default → `null`. Toggle behavior (tap day to filter, tap again to clear) still works.
**Result:** G2/G3/G4 all GREEN. 31/31 history tests pass.
**Files:** `lib/features/history/history_screen.dart` (1 line removed in initState).
**Phase 4:** No refactoring needed — code already clean.

### ✅ Flutter R2 Path Alignment — Phase 4 Complete (REFACTOR)
**Phase 4 REFACTOR:** 4 clarity improvements applied. All 1066 tests GREEN (7 pre-existing failures unchanged).

### ✅ Flutter Sync Tasks T2/T3/T8 — Phase 1 Complete (Blueprint)
**Phase 1:** 36 assertions blueprinted across 4 groups (K/M/N/R) → `docs/planning/FLUTTER_SYNC_TASKS_PHASE1.md`
- K (T2): 7 cookie-check wiring tests
- M (T3): 10 cookie-compare + fast-path tests
- N (T8): 14 commit-to-ledger method tests
- R (T8 UI): 5 sync-screen commit button tests

### ✅ T8 Commit to Ledger (Group N) — Phase 4 Complete (REFACTOR)
**Phase 4 REFACTOR:** 4 improvements across 3 files (2 clarity, 1 conciseness, 1 security).
- Removed unused `blockIndex` param from `markCommitted`
- Updated N14 test — removed stale Phase 2 UnimplementedError catch
- Set-based lookup in `markCommitted` (O(1) vs linear)
- Null-safe `entry_id` extraction in `commitEntries`
- All 14 Group N tests GREEN. No regressions.

### ✅ Group R Phase 4 (REFACTOR) — Commit button review
**Phase 4 REFACTOR:** 4 improvements in `sync_screen.dart` (2 clarity, 1 conciseness, 1 security). All 5 Group R tests GREEN.

### ✅ E13 LocalCache.update() title fix — Phase 4 Complete (REFACTOR)
**Phase 3 GREEN:** 1-line fix in `local_cache.dart` — added `title_enc` sync to `update()` matching tags/comment pattern.
**Phase 4 REFACTOR:** 2 improvements in `local_cache.dart` (1 clarity, 1 conciseness).
- Extracted `_upsertEncryptableField` helper — consolidates 3×5-line repeated title/tags/comment pattern
- Categorized field groups with section comments (encryptable / always-encrypted / plain-only)
- All 25 local_cache tests GREEN. Full suite: 1111/1111 GREEN (4 pre-existing failures unchanged).

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

### 🔜 F-06: Dashboard E3
- F-06: Dashboard empty-title validation (~15 min)

### 🔜 R1–R5: SyncScreen Commit Button
- R1–R5: SyncScreen "Commit to Ledger" button wiring (~1 hr)

## Known Issues
- **6 Flutter test failures** (pre-existing — see BACKLOG.md §Active Issues)
- **E3** (Dashboard empty-title validation), **R1/R2/R3/R4/R5** (SyncScreen commit button), **F3/L1** (flaky)
