# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`

## Current State
- **Branch:** `Flutter-features_and_ux`
- **Flutter test suite:** 1507/1545 passing (38 failing: all pre-existing)
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

> **Archived:** B-02 (Web + Flutter + UI), B-04, B-05b, B-05c, B-06, Flutter Staging Schema Overhaul, commit prev_hash fix, and sync workflow tasks → `docs/planning/archive/SESSION_HISTORY_2026-08-03.md`

### ✅ B-02 Web: Cross-ledger entry migration — 4-Phase TDD Complete (2026-08-03)
- 30 assertions → 55 GREEN → 7 Phase 4 improvements.

### ✅ B-02: Cross-ledger entry import (Flutter) — 4-Phase TDD Complete (2026-08-01)
- 79 assertions → 79 GREEN → 5 Phase 4 improvements.

### ✅ B-02 UI Layer: ImportScreen, sheets, provider, route, settings — 4-Phase TDD Complete (2026-08-03)
- 40 assertions → 40 GREEN → 7 Phase 4 improvements.

### ✅ Encrypted Entry Display — 4-Phase TDD Complete (2026-08-06)
- 38 assertions → 38 GREEN → 2 Phase 4 improvements
- **Phase 4 improvements:**
  - `passphrase_auth_dialog.dart`: Added `debugPrint` in catch-all block for unexpected error visibility
  - `passphrase_auth_dialog.dart`: Clarified comment on post-auth MK retrieval from cached CryptoService
- **Files:** `passphrase_auth_dialog.dart`, `sync_service.dart` (_stagingRowToDto), `ledger_pull_service.dart` (_seedStagingFromBlocks)
- **Test files:** `test/data/sync/encrypted_entry_display_test.dart`, `test/features/encrypted_entry_display_test.dart`

### ✅ I-04: Rename HMAC "signature" → "seal"/"tag" — 4-Phase TDD Complete (2026-08-04)
- 50 assertions → 50 GREEN → 8 Phase 4 improvements (clarity: docstrings + var rename)
- `security/crypto.py` — `verify_seal`/`verifySeal` renamed `signature` → `seal_hex` (4 locations)
- `domain/ledger/chain.py` — param rename + 5 docstring/variable updates
- `domain/ledger/merge.py` — 3 docstring updates
- `docs/spec/PHPSPEC.md` — all block schemas, §5.2, §5.3, §9, §10: `signature` → `identity_seal`
- 2428 passed, 0 regressions

### ✅ Biometric Authentication (Flutter) — 4-Phase TDD Complete (2026-08-04)
- 38 assertions → 85 GREEN → 2 Phase 4 improvements
- **Improvements:**
  - `auth_service.dart`: Removed redundant PDK derivation in `changePassphrase()` (was calling decrypt twice)
  - `settings_screen.dart`: Consolidated `_showPassphrasePrompt()` and `_showPassphrasePromptForBiometric()` into single parameterized method (~30 lines removed)
- **Files changed:** `auth_service.dart`, `settings_screen.dart`

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)
- **Test ledger:** `testdata/ledger.json` — 31 blocks, 146 entries, Python-encrypted hex fields

## Sync Workflow — Abstracted Tasks

| # | Task | Status |
|---|---|---|
| T1–T8 | Genesis Gate, Cookie Check/Compare, Blob Pull/Push, Merge, Commit | ✅ All 8/8 complete |

## Immediate Next Steps 🎯

### 🔜 Next Task
- **Check BACKLOG.md** for next highest-priority task

---

## Known Issues
- 2 pre-existing restore_integration flaky tests (G3, G8) — pass in isolation, fail in full suite due to test isolation
- **Emulator has 216 stale committed entries** in `_staging_kv` (200KB, `committed: true`) — will be cleared on next commit via temporary cleanup (expires 2026-08-01)
- **B-06: restoreFromCloud doesn't pull staging** ✅ Fixed (2026-07-31) — staging now synced via `initialPull()` during cloud restore
