# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed milestones (archived):** `docs/planning/archive/` 2026-08-11, 2026-08-19, 2026-08-21

## Current State
- **Branch:** `Flutter-features_and_ux` (committed `5463e21`; **uncommitted** Commonplace Book 4-phase work — chain/engine/storage + `sealable_chain.dart` mixin refactor + docs)
- **Phone `RFCW50FZQPJ`:** fix deployed (debug 0.1.0) + local ledger repaired (132 blocks == remote,
  280 staging rows, no dups) — verified working.
- **Flutter test suite:** `test/data/ledger/` + `test/data/commonplace/` GREEN (chain-engine refactor: 349/349).
  `ledger_push_service`+`engine` 106/106, periodic 18/18, onboarding 65, merge 25 — GREEN.
- **Remote sync E2E:** 8/8 GREEN (`--timeout 180s`) | **Python suite:** 2614 pass / 1 skip / 0 fail.

## Immediate Next Steps 🎯
- **✅ Commonplace Book — 4-PHASE TDD COMPLETE (2026-08-21).** ADR-031 separate sealed `commonplace.json`
  chain (same seed→same MK, own genesis; `title`/`tags`/`entry` + optional ad-hoc k/v, no `comment`).
  Phase 3 GREEN 55/55 in `lib/data/commonplace/` (chain/engine/storage). **Phase 4 REFACTOR:** shared
  `SealableChain` mixin (`lib/data/ledger/sealable_chain.dart`) deduped seal/verify/identity-MAC/linkage
  across both chains → `chain.dart` 476→371, `commonplace_chain.dart` 521→456; merged dup verify gate,
  removed dead engine marker. **349/349 tests GREEN**, analyzer clean; 29 pre-existing failures unchanged.
  Full details archived: `docs/planning/archive/SESSION_HISTORY_2026-08-21.md`.
- ✅ Staging-seed dedup fix — 4-PHASE TDD COMPLETE (2026-08-21). Dedup by `activity_id` + shared
  `StagingSeedDeduper` helper; zero new failures (baseline-verified). See `SESSION_HISTORY_2026-08-21.md`.
- ✅ Phone ledger repair — DONE (2026-08-21). Phone `RFCW50FZQPJ` chain == remote 132, staging 288→280,
  sync stable ~15s+. See `SESSION_HISTORY_2026-08-21.md`.
- ✅ WEB connectToWorker full-chain + blank-card fix — DONE (2026-08-21). 23/23 regression GREEN.
  See `SESSION_HISTORY_2026-08-21.md`.

## Known Issues
- **OPEN: Aug 13–14 2026 activities missing from remote ledger + web History.** The R2 ledger chain ends
  at block 131 (`2026-08-10`) — there are NO day blocks for Aug 11–14. The 9 committed Aug 13–14 activities
  (`2G5vLNJPxV` Laundy, `YU6ZwwvcK5` Gave Gabriel his medicine, `yRrbjBkyGD` Tidying kitchen, `QX8sJvoLJG`
  Laundry, `47WmPrty8L` Store run, `koA2Hl5WRa` Working on Phpos, `GXmRySa0EE` Working on phpoc,
  `9w4hbVynWR` Tidying the kitchen, `I4FjqLRKT3` Gave Gabriel a shower) were in phone blocks 132–135 that
  were DROPPED during the earlier phone repair, and they are NOT re-pushed to R2 (no `backups/` exports,
  remote staging blob holds only the 2 uncommitted rows). They survive only in the offline phone DB backup
  `/tmp/phpoc_phone_backup/pre_repair_20260814_124924/phpoc.db` (staging table, `committed=1`). Recovery
  would require re-committing them from that backup or another device — not fixable in web History.
  Web correctly shows only what the remote ledger + remote staging contain. Root cause was `_prepareEntries` stripping `entry_id`/`hash`
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
