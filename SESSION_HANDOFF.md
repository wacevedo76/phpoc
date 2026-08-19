# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed milestones (archived):** `docs/planning/archive/` 2026-08-11, 2026-08-18, 2026-08-19, 2026-08-21

## Current State
- **Branch:** `Flutter-features_and_ux` → clean, pushed `1439fa3` (delete-tombstone + flake-fix + docs)
- **✅ Book Switcher DONE (2026-08-21, Commonplace UI-wiring first step):** shell-level switcher bar
  rendered above each page in `AppScaffold` (`PH Ledger` ↔ `PH Commonplace Book`), selection persisted
  in `AppPreferences` (`book_mode`). `enum Book` + `bookProvider` in `lib/features/shared/book_switcher.dart`;
  13/13 tests GREEN (`test/features/book_switcher_test.dart`); analyzer 0; no new `test/features/` failures.
  `test/features/navigation_test.dart` mounts now wrap routers in a `ProviderScope` (matches prod `main.dart`).
  Emulator `emulator-5554` running the new build (VM at :36637) but sits on the unlock screen — needs
  the passphrase to reach the Dashboard shell before the switcher is visible. Plan: `COMMONPLACE_BOOK_SWITCHER_PHASE1.md`.
- **Phone `RFCW50FZQPJ`:** fix deployed (debug 0.1.0) + local ledger repaired (132 blocks == remote,
  280 staging rows, no dups) — verified working.
- **Delete-resurrection root cause FOUND + FIXED live (2026-08-19):** it was NOT the running build's
  delete logic — that was fixed in `1439fa3` (tombstone-propagate). The live blocker was a *second*
  device: the emulator (`947e264d`) was actively re-claiming the remote staging cookie/ownership
  (specifier mismatch → `reauthNeeded` gate → phone's pruned blob never landed → rows resurrected).
  Fix: stopped emulator app, deleted `tM0S9eZaKX` from phone local DB (276→275), rewrote remote
  blob+hash_index to orphan-free (0 uncommitted / 275), cookie spec `c89f2389` matches → confirmed
  stable over 3 periodic ticks: blob stays 0 entries, deleted Push-ups does NOT resurrect, Sync shows
  "0 entrys pending sync" + "Ready". LEAK: `_getDeviceUuid()` regenerates a fresh random UUID per
  session (never persisted/cache-consistent), so device attribution churns across restarts — latent
  product issue; cookie *specifier* is the stable identity.
- **Flutter test suite:** `test/data/ledger/` + `test/data/commonplace/` GREEN (chain-engine refactor: 349/349).
  `ledger_push_service`+`engine` 106/106, periodic 18/18, onboarding 65, merge 25, `sync_service` 105/105 — GREEN.
- **Remote sync E2E:** 8/8 GREEN (`--timeout 180s`) | **Python suite:** 2614 pass / 1 skip / 0 fail.

## Immediate Next Steps 🎯
- **Commonplace Book — UI wiring (next slice after the chain-engine slice below).** Data layer done
  (ADR-031 sealed `commonplace.json` chain, 55/55 GREEN). Now build the UI surface. Other follow-on
  slices (each its own BACKLOG item when planned):
  - **UI wiring (in progress)** — ✅ Book Switcher (first step, done 2026-08-21); next: Commonplace
    Book screen, add/edit-not-in-place entry, topic/tag index
  - **Remote sync** — same Worker under a new R2 path (`commonplace/...`) + MK-derived device cookie
  - **Shared key-rotation extension** — extend ADR-026 so it also re-encrypts Commonplace chain(s)
  - **Tag-search blind index** (encrypted, MK-derived) — deferred (decrypt-and-scan initially)
  - **Web + CLI parity ports**
- ✅ Archived (2026-08-21): Commonplace 4-phase TDD + SealableChain refactor; staging-seed dedup fix;
  phone ledger repair; WEB connectToWorker full-chain + blank-card fix. See
  `docs/planning/archive/SESSION_HISTORY_2026-08-21.md` for full detail.

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
  4 extra blocks dropped), chain now matches clean remote 132.
- **Live debug visibility:** phone `RFCW50FZQPJ` now **debuggable** (rebuild 2026-08-19, data preserved
  via `install -r`). DB dump: `run-as com.phpoc.phpoc_flutter cat app_flutter/phpoc.db`. Emulator
  `emulator-5554` also debug.
- Pre-existing Flutter failures (unchanged, verified on baseline): `ledger_backup` B1/B4/E6, `ledger_pull`
  B4/B6/C3/C4/F3, `sync_screen` L2/L3/L4/L6+R5, `restore_integration` G1/G3/G5/G6, `ccs1_gap_closure`
  load error, `widget_test.dart` (baseline, independent of sync wiring).
- **RESOLVED (archived `SESSION_HISTORY_2026-08-18.md`):** day_index corruption on push/export;
  deleted staged entry resurrects on next sync; flaky ordering tests in `sync_service_test` (E15/L4/N12).
- `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — RETIRED ✅. `stagingStore` required/non-null.
- `verify()` after cloud restore — FIXED (Plan B: RC1–RC3). `VERIFY_RESTORE_FIX_PLAN_B.md`.

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)
- **Cross-client sync reference:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
