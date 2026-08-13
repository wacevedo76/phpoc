# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed milestones (archived):** `docs/planning/archive/SESSION_HISTORY_2026-08-11.md`

## Current State
- **Branch:** `Flutter-features_and_ux`
- **Stage sync after re-auth — 4-PHASE TDD ✅ COMPLETE** (2026-08-11). `unlock_screen.dart` `_triggerSyncAfterReauth()`; 6/6 GREEN.
- **Manual "Sync Staging" pull fix — 4-PHASE TDD ✅ COMPLETE** (2026-08-11). `_syncNow()` → `checkAndSync(skipReadOnlyFastPath: true)`; S2.2 GREEN.
- **ADR-030 Ledger Auto-Pull on Ownership-Handoff Reauth — 4-PHASE TDD ✅ COMPLETE.** See Immediate Next Steps.
- **Flutter periodic staging auto-sync timer — 4-PHASE TDD ✅ COMPLETE + LIVE WIRED (2026-08-19).** `startPeriodicSync`/`stopPeriodicSync`/`_onPeriodicTick` in `sync_service.dart` + `PeriodicSyncOrchestrator` (pure, phase-gated; P4: callbacks `final`). **Wired into app:** new `PeriodicSyncCoordinator` (lib/features/sync/periodic_sync_coordinator.dart) observes `appPhaseNotifier` → starts timer on `ready`, stops on leaving, detaches+stops on dispose; exposed via `periodicSyncCoordinatorProvider` (watched by `PhpocApp`). Tests: P=8, W=3, C=6, C-IT=1 = **18/18 GREEN** (coordinator wiring covered in `periodic_sync_coordinator_wiring_test.dart`). Analyzer clean; no NEW regressions (baseline 8 pre-existing failures identical).
- **ADR-030 Scenario-5/6 ledger-aware handoff cleanup — 4-PHASE TDD ✅ COMPLETE** (2026-08-11). Wired `dropLedgerCommitted` into the handoff reconcile.
- **Flutter test suite:** `test/data/ledger/` (325/325), `ledger_push_service_test`+`engine_test` (106/106),
  new `ledger_auto_pull_on_reauth_test.dart` (12/12) GREEN. Pre-existing failures unchanged:
  `ledger_backup` B1/B4/E6, `ledger_pull` B4/B6/C3/C4/F3, `sync_screen` L2/L3/L4/L6+R5, `restore_integration`
  flaky G1/G3/G5/G6, `sync_service` E15/L4 flaky, `ccs1_gap_closure` load (legacy `stagingStore: null`).
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`) | **Python suite:** 2614 pass / 1 skip / 0 fail.

## Cross-Client Staging Sync — Reference Chain
- **Protocol:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (incl. ADR-030 pull-on-handoff rule)

## Immediate Next Steps 🎯

### ✅ Trigger stage sync after re-authentication — **4-PHASE TDD COMPLETE** (2026-08-11)
- **Blueprint:** `docs/planning/flutter/REAUTH_TRIGGERS_STAGE_SYNC_PHASE1.md` (U1/U2/U3, 6 assertions).
- **Fix:** `unlock_screen.dart` `_triggerSyncAfterReauth()` — fire-and-forget
  `unawaited(checkAndSync(skipReadOnlyFastPath: true))` wired into `_unlock()` + `_biometricUnlock()`
  after auth success, before `goToReady()`. **6/6 GREEN.** Analyzer clean; no regressions
  (dashboard T7/U1/U3 & sync_screen L2/L3/L4/L6+R5 baseline-identical).

### ✅ ADR-030 Scenario-5/6 ledger-aware handoff cleanup — 4-PHASE TDD COMPLETE (2026-08-11)
_Archived detail. Wired `merge_engine` delegation + real `ledgerActivityIds()`. All GREEN._

### ✅ ADR-030 — Phase 4 (REFACTOR) COMPLETE (2026-08-11)
_Archived detail. `ledger_push_service` DRY; `merge_engine` doc note. No behavior change._

### ✅ Web: ADR-030 ledger-aware handoff auto-sync — 4-PHASE TDD COMPLETE (2026-08-11)
_Archived detail. `sync.js` `_pullLedgerOnHandoff` + Web `_dropSealedUncommitted`. 17/17 GREEN._

## Other In-Flight

### ✅ Flutter: manual "Sync Staging" does not pull remote rows — **4-PHASE TDD COMPLETE** (2026-08-11)
_Archived detail. `_syncNow()` → `checkAndSync(skipReadOnlyFastPath: true)`; S2.2 GREEN._

### ✅ Restore-from-cloud E2E on emulator (debug build) — LIVE 2026-08-13
Rebuilt debug APK on `emulator-5554` (`flutter build apk --debug`), wiped app data, drove
UI: Landing → New Ledger → Restore from Cloud → confirm → pre-filled personal creds → Restore.
Pulled **132-block personal ledger** (genesis `0a885c81...`, head `eb161e68...`) from
`phpoc-staging.wacevedo.workers.dev`, seeded **183 ended staging entries** into `phpoc.db`,
landed on UnlockScreen. NOT on master; local-only test. Restore used personal creds in
`TEST_CREDENTIALS.md` (per user instruction).

### ✅ Local/Remote staging auto-sync verified (emulator ↔ phone via remote) — 2026-08-13
Phone's running activity **"Working on phpoc"** (device_uuid `c3548973-ad39-4b0a-ad0f-0a1069c16c0a`,
start 14:36:40 UTC) reached the emulator via the DEV Worker (`staging/blob`, ~64KB, ETag `bec9ba1b...`).
Emulator DB: 272 staging rows (1 active + 271 ended); Dashboard showed it as **Running / 33m elapsed**. Key:
- Emulator's own device_uuid is `b65fe769-cc19-4175-8945-123ab2e42774` (in `shared_prefs/FlutterSharedPreferences.xml`),
  so the active stage's `c3548973...` is the PHONE's UUID → confirms remote pull worked.
- **Stale-UI caveat:** Dashboard showed "No activities yet" when it loaded before the background auto-sync
  finished; a fresh mount (relaunch/unlock) displayed the running activity. No auto-refresh after auto-sync.
- Emulator SQLite is WAL mode: copy BOTH `phpoc.db` + `phpoc.db-wal` for a consistent read.
- Unlock passphrase entry on emulator needs ADBKeyBoard (`com.android.adbkeyboard`, `ime set` +
  `am broadcast -a ADB_INPUT_TEXT --es msg '<text>'`); `input text` mangles the leading `!`.

---

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)

## Immediate Next Steps
- **✅ Flutter periodic staging auto-sync timer — 4-PHASE TDD DONE + LIVE WIRED (2026-08-19).**
  11/11 GREEN + coordinator wiring (new `PeriodicSyncCoordinator` + `periodicSyncCoordinatorProvider`
  in `app.dart`) → **18/18 GREEN** (see Current State). Next on-device: rebuild debug APK on emulator
  and verify the idle Dashboard auto-polls remote drift.**
- **Live debug visibility:** debug build is running on `emulator-5554`. Read UI state via
  my DM service (dynamic): `flutter.debugDumpApp/debugDumpRenderTree` (get VM port+auth from
  logcat `Dart VM service is listening`, `adb forward tcp:<port> tcp:<port>`) and SQLite via
  `adb -s emulator-5554 shell run-as com.phpoc.phpoc_flutter cat app_flutter/phpoc.db`.
  Phone (`RFCW50FZQPJ`) is a release build → not observable via run-as/uiautomator/OCR.

## Known Issues
- Pre-existing Web red (unchanged): `ledger_merge_test` (block-1 entry-hash), `import_entries_test`,
  `genesis_gate_test`; `sync_service_test` 42 red.
- 2 pre-existing Flutter `restore_integration` flaky tests (G3, G8) — pass in isolation, fail in full suite.
- Pre-existing Flutter failures (unchanged, verified on baseline): `ledger_backup` B1/B4/E6, `ledger_pull`
  B4/B6/C3/C4/F3, `sync_screen` L2/L3/L4/L6+R5, `restore_integration` G1/G3/G5/G6, `sync_service` E15/L4 (flaky),
  `ccs1_gap_closure` load error (`stagingStore: null` legacy, from prior zombie cleanup).
- Pre-existing `widget_test.dart` failure (verified on baseline): `PhpocApp` pumped with no provider overrides
  → `ThemeNotifier._load` null-check on `AppPreferences.preResolvedInstance`. Independent of periodic-sync wiring.
- **`_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — RETIRED ✅** (4-PHASE COMPLETE). `stagingStore` required/non-null.
- **🟢 `verify()` after cloud restore** — FIXED (Plan B: RC1–RC3). See `docs/planning/VERIFY_RESTORE_FIX_PLAN_B.md`.
