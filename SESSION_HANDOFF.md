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
- **Branch:** `Flutter-features_and_ux` (clean, committed `2d05aff` — staging-seed dedup fix)
- **Phone `RFCW50FZQPJ`:** fix deployed (debug 0.1.0) + local ledger repaired (132 blocks == remote,
  280 staging rows, no dups) — verified working.
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
- **🎯 LIVE: Phone ledger repair — ✅ DONE (2026-08-21).** Deployed fixed debug build to `RFCW50FZQPJ`
  (`install -r`, debug preserved) + repaired live DB: dropped 4 local-only blocks (132–135; 132–134 were
  re-seed dup copies, 135 `Gave Gabriel a shower` kept safe via staging `I4FjqLRKT3`) and deleted the 8
  re-seed staging rows. Verified: phone chain now == clean remote 132 (0–131, prev_hash intact),
  staging 288→280, no duplicate (title,start,end) groups, app launches clean (MainActivity top,
  integrity ok). Backups on-host `/tmp/phpoc_phone_backup/pre_repair_20260814_124924/` + on-device
  `app_flutter/repair_backup_pre/`.
  **Post-repair sync verified CLOSED OUT (2026-08-21):** observed stable for ~15s+ — remote ledger 132
  (unchanged), remote staging hash_index 280/unique (== phone local, no growth, no dup re-seed on the
  5s periodic sync, fix held); `I4FjqLRKT3` present local+remote. Note: committed staging rows are a
  denormalized display cache kept with `committed=true` (none reference the ledger's 50 sealed
  activity_ids; the ledger append flow only processes UNCOMMITTED ended rows), so removing block 135
  orphaned `I4FjqLRKT3` from the ledger but it survives in staging — expected app behavior.

## Known Issues
- **✅ RESOLVED: ledger/staging duplication.** Root cause was `_prepareEntries` stripping `entry_id`/`hash`
  but **retaining `activity_id`**; seed functions deduped only by `entry_id`/`hash`, so committed entries
  without `entry_id` got re-seeded as new rows via `generateActivityId()`. Fixed in 4-phase TDD
  (`commit 2d05aff`). Phone `RFCW50FZQPJ` **repaired**: DB deduped (8 dup staging rows removed,
  4 extra blocks dropped), chain now matches clean remote 132. If a fresh re-seed duplicates reappear
  after a cloud pull on a non-fixed build, the dedup-by-`activity_id` logic (P1) skips them.
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
