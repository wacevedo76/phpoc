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
  rendered in `AppScaffold` (`PH Ledger` ↔ `PH Commonplace Book`), selection persisted in `AppPreferences`
  (`book_mode`). `enum Book` + `bookProvider` in `lib/features/shared/book_switcher.dart`; 13/13 tests GREEN;
  analyzer 0; `navigation_test.dart` mounts wrap routers in a `ProviderScope` (matches prod `main.dart`).
  Emulator `emulator-5554` refreshed to the current build (2026-08-20): switcher bar now renders live
  — dropdown shows both `PH Ledger` and `PH Commonplace Book`, selection persists (`book_mode`).
  Plan: `COMMONPLACE_BOOK_PHASE1.md` chain slice + `COMMONPLACE_BOOK_UI_PHASE1.md` UI slice.
- **Phone `RFCW50FZQPJ`:** fix deployed (debug 0.1.0) + local ledger repaired (132 blocks == remote,
  280 staging rows, no dups) — verified working.
- **Delete-resurrection root cause FOUND + FIXED live (2026-08-19):** live blocker was a *second* device (the
  emulator `947e264d`) re-claiming the remote staging cookie → phone's pruned blob never landed → rows resurrected.
  Fix: stopped emulator, removed the stale specifier-cookie from phone DB, rewrote remote blob+hash_index orphan-free,
  cookie spec `c89f2389` matches → stable (3 ticks, no resurrection). LEAK: `_getDeviceUuid()` is a fresh random UUID
  per session — device attribution churns; cookie *specifier* is the stable identity.
- **Flutter test suite:** `flutter test` = **`+1951` / 0 failures** (incl. +20 Smart Sync; was `+1931` after the 43
  pre-existing RED remediated per `docs/planning/flutter/RED_SUITE_REMEDIATION_PHASE1.md`).
  `flutter analyze` = **0 errors** (302 pre-existing `avoid_print` info in `tool/` only).
- **Remote sync E2E:** 8/8 GREEN (`--timeout 180s`) | **Python suite:** 2614 pass / 1 skip / 0 fail.

## Immediate Next Steps 🎯
- **✅ Smart Sync Button — 4-phase TDD COMPLETE (2026-08-21)** — option (b) reconcile-then-push;
  `commitAndSync({forceLocal})` + `reconcileRemoteLedger` (append-only, D3/D4 fork-guard), SyncScreen
  `_unifiedSync→smartSync` w/ outcome + phase-4 `ledgerEngine==null` guard. 20/20 GREEN, full suite `+1951`, analyze 0. Awaiting user commit.
- **🔴 HIGH — C-2 Full Seed Replacement (new seed re-key)** — plan at `docs/planning/flutter/SEED_REKEY_C2_PHASE1.md` (Phase 1 blueprint, 34 assertions R/B/M/P/S). The only capability that truly nullifies the **leaked seed** (in git history): mint a fresh random seed → full re-key of vault + chain + remote/R2 + device cookie under the new root, with backup + two-secret confirm. Recommended to integrate with (not replace) passphrase change (`changePassphrase` exists, B1–B6/H6–H9). **Next: Phase 2 (RED)** on a `/tmp` scratch copy — gate: pre-existing red suite green (chain now valid: emulator restored from cloud, 134 blocks, Verify Ledger GREEN). Also: wire the unreachable `ph rotate-keys` into `main.py` as the parity/escape-hatch precedent.
- **✅ Pre-existing red-suite remediation DONE (2026-08-21)** — all **43 baseline failures** fixed (detail in
  `RED_SUITE_REMEDIATION_PHASE1.md`); suite `+1931` GREEN, analyze 0 err. Notable: restore is **fail-open ADOPT**;
  cross-device restore fixed at test level by importing the SHARED seed; `blockIndex` = chain ordinal not `day_index`.
- **Commonplace Book — UI wiring** (was next, blocked by the red-suite fix above). Engine slice done
  (ADR-031, 55/55); Book Switcher done (13/13). Refs: `COMMONPLACE_BOOK_UI_PHASE1.md` (40 axn) → **next: Phase 2 (RED)**;
  remote sync, key-rotation ext, deferred tag index, Web/CLI ports all in BACKLOG + ROADMAP.
- ✅ Archived (2026-08-21): Commonplace TDD + SealableChain refactor; staging-seed dedup fix; phone ledger repair;
  WEB full-chain fix — `docs/planning/archive/SESSION_HISTORY_2026-08-21.md`.

## Known Issues

- **🔴 "activities through Aug 7 doubled on ledger" — ROOT CAUSE FOUND (archived detail
  `docs/planning/archive/SESSION_HISTORY_2026-08-22.md`):** (1) full-ledger re-seed doubling is **FIXED**
  (`2d05aff`) — fresh restore = 262 staging rows, History matches clean remote; (2) residual = **12 baked-in
  historical double-seals** (identical start ms, growing end) of running "Working on phpoc" tasks at **May 18/22/27**,
  from oldest entries lacking `activity_id` + commit path that appends rather than updates. Fixing needs a
  same-(title,start) duplicate-removal repair or a commit-path update-in-place.
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
- Pre-existing Flutter red suite — **RESOLVED 2026-08-21** (all 43 baseline failures fixed; full suite `+1931` green).
  Remaining non-hermetic case: live-network test `restore_from_cloud_test X1/X2` depend on the real R2 staging Worker
  (creds in `TEST_CREDENTIALS.md`); X1's entry-count assertion is now resilient to live-data drift.
- **🔴 Pre-existing credential leak (git history only — working tree now neutralized).** The personal
  seed+passphrase/API-key/worker-url were hardcoded in `onboarding_screen.dart:205-208` and `diag_verify.dart:19`
  (commits `a5b124e`/`08235f8`, on `cb22154`) — violating AGENTS.md "No secrets in repo". **2026-08-21 fixed in
  working tree** (not yet committed): personal pre-fill removed (fields start empty; creds come from gitignored
  `TEST_CREDENTIALS.md`), `diag_verify.dart` reads via `PHPOC_RECOVERY_SEED` env var, and worker-url scrubbed from
  `scripts/fix_chain_genesis_link.py` + `SESSION_HISTORY_2026-08-19.md`. The values still exist in **committed git
  history** — only a **C-2 seed re-key** (rotate seed) truly nullifies the leaked seed, and history rewrite is
  user-initiated. Dev restore-from-cloud now requires typing the personal creds (from `TEST_CREDENTIALS.md`) instead
  of auto-pre-fill.
- **RESOLVED (archived `SESSION_HISTORY_2026-08-18.md`):** day_index corruption on push/export;
  deleted staged entry resurrects on next sync; flaky ordering tests in `sync_service_test` (E15/L4/N12).
- `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — RETIRED ✅. `stagingStore` required/non-null.
- `verify()` after cloud restore — FIXED (Plan B: RC1–RC3). `VERIFY_RESTORE_FIX_PLAN_B.md`.

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)
- **Cross-client sync reference:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
