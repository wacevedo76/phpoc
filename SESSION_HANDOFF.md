# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed milestones (archived):** `docs/planning/archive/SESSION_HISTORY_2026-08-11.md`, `docs/planning/archive/SESSION_HISTORY_2026-08-19.md`

## Current State
- **Branch:** `Flutter-features_and_ux` (clean, committed `d9e769d`)
- **Flutter test suite:** `test/data/ledger/` 325/325, `ledger_push_service`+`engine` 106/106,
  `ledger_auto_pull_on_reauth` 12/12, periodic 18/18, onboarding 65, merge 25 — GREEN.
- **Remote sync E2E:** 8/8 GREEN (`--timeout 180s`) | **Python suite:** 2614 pass / 1 skip / 0 fail.

## Immediate Next Steps 🎯
- **🎯 LIVE: Staging-seed dedup fix — ✅ 4-PHASE TDD COMPLETE (2026-08-21).**
  Blueprint: `docs/planning/flutter/STAGING_SEED_DEDUP_FIX_PHASE1.md` (S:6, I:5, U:3 = 14).
  **Phase 3 (GREEN) done:** P1 (dedup by `activity_id`) + P2 (reuse `data['activity_id']` instead
  of `generateActivityId()`) implemented in `_seedStagingFromBlocks` (ledger_pull_service.dart) + `_seedStagingFromImportedBlocks`
  (onboarding_service.dart). New tests 11/11 GREEN (S1–S6, I1–I5); U1 GREEN.
  **Phase 4 (REFACTOR) done:** extracted shared `StagingSeedDeduper` + `resolveSeedActivityId()` into
  new `lib/services/staging_seed_helpers.dart` (~20 dup lines/call-site removed); analyzer clean;
  regression proven by baseline diff (services dir: refactor 380 pass/25 fail vs baseline 371/33 —
  9 new dedup tests GREEN, **zero new failures**). Pre-existing baselines unchanged
  (`ledger_pull` B4/B6/C3/C4/F3, `ledger_backup` B1/B4/E6, `auth_service` V9, `restore_*`, E2E Worker tests,
  compile-error `wipe_cloud_onboard_e2e`/`restore_mk_caching`).
- **After fix → repair phone local ledger (future, separate task):** dedup the 8 duplicate staging
  rows + drop the 3 extra day blocks (132–134) on `RFCW50FZQPJ` so it matches the clean 132 chain.
  Phone is now a **debug** build (`run-as` + DB access working) after `install -r` kept its data.

## Known Issues
- **🟢 LIVE root cause: ledger/staging duplication.** Phone `phpoc.db`: **287 staging rows, ALL
  `committed=true`** (→ no orange border); **8 exact `(title,start_epoch,duration)` duplicate pairs** —
  each real row (`end_device_uuid` set) + one re-seeded copy (`end_device_uuid=None`,
  `generateActivityId()` style id like `tuttsrrqpp`), `updated_at` batch 14:28:03 ×6 + 18:19:38 ×2.
  Phone ledger **135 blocks** vs clean shared **132** → 3 extra local-only day blocks never pushed.
  Shared/remote chain CLEAN (132, no dups). Root cause: `_prepareEntries` strips `entry_id`/`hash` but
  **retains `activity_id`**; seed functions dedup only by `entry_id`/`hash`, so committed entries
  without `entry_id` get re-seeded as new rows via `generateActivityId()`.
- **Live debug visibility:** phone `RFCW50FZQPJ` now **debuggable** (rebuild 2026-08-19, data preserved
  via `install -r`). DB dump: `run-as com.phpoc.phpoc_flutter cat app_flutter/phpoc.db`. Emulator
  `emulator-5554` also debug.
- Pre-existing Flutter failures (unchanged, verified on baseline): `ledger_backup` B1/B4/E6, `ledger_pull`
  B4/B6/C3/C4/F3, `sync_screen` L2/L3/L4/L6+R5, `restore_integration` G1/G3/G5/G6, `sync_service` E15/L4
  (flaky), `ccs1_gap_closure` load error, `widget_test.dart` (baseline, independent of sync wiring).
- `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — RETIRED ✅. `stagingStore` required/non-null.
- `verify()` after cloud restore — FIXED (Plan B: RC1–RC3). `VERIFY_RESTORE_FIX_PLAN_B.md`.

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)
- **Cross-client sync reference:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
