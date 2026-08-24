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
- **Branch:** `Flutter-features_and_ux` → pushed `bd3e9e5` (Commonplace Book UI + Settings + per-book theme selector)
- **✅ Commonplace Book UI wiring COMPLETE (4-phase TDD, 2026-08-23):** screen + add-entry (add-not-in-place) + tag/topic index + `AppScaffold` content-swap by book; 40/40 GREEN; full suite `+2050`/0; analyzer 0 on changed files. Phase 4 REFACTOR done. COMMITTED (`bd3e9e5`).
- **✅ Web Wipe Ledger parity (FLUTTER UX, 2026-08-22):** duplicated Flutter `AuthService.wipeLedger()`
  into web — `DevModeContext.wipeLedger()` (clears IndexedDB + localStorage creds + MK → fresh landing),
  `AuthScreen.jsx` error-colored Wipe button + confirm dialog below Unlock. 6/6 throwaway RTL GREEN;
  smoke import GREEN. See WEB_ROADMAP Build 63 + ROADMAP §4.
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
- **Flutter test suite:** `flutter test` = **`+2097` / 0 failures** (incl. Commonplace Settings 35/35 widget + 12/12 service; was `+2050`). `flutter analyze` = **0 errors on changed files** (pre-existing lints only).
- **Remote sync E2E:** 8/8 GREEN (`--timeout 180s`) | **Python suite:** 2614 pass / 1 skip / 0 fail.

## Immediate Next Steps 🎯
- **✅ Commonplace Book Settings — 4-phase TDD COMPLETE (2026-08-24):** `docs/planning/flutter/COMMONPLACE_BOOK_SETTINGS_PHASE1.md` (46 assertions). **GREEN: 34/34 widget (`commonplace_settings_screen_test.dart`) + 12/12 service (`commonplace_settings_services_test.dart`) GREEN; full suite `+2096`/0; analyze 0 on changed files.** Implemented: `CommonplaceSettingsScreen` (Verify/Re-key/Backup/Restore/Clear-All/Security/Push, excludes Ledger-only Import/Migrate/dup Worker), book-scoped `/settings` redirect in `AppScaffold`, shared Worker URL/API-token direct writes, per-book theme at app root (`PhpocApp` + `commonplaceThemeProvider`), `RekeyService.commonplaceService` re-encrypt + re-seal + re-link of `commonplace.json` under the new MK (prev_hash cascade), `AppPreferences.get/setCommonplaceThemeMode`, `OnboardingService.clearAllData` wipes both books. RED-test corrections: `_pumpScreen` now resolves per-book theme (T4/T5) + init crypto (R8) + spy-auth (SP2), scrollUntilVisible for below-fold taps, R5 fixture seeded under `oldMK`, genesis `recovery_seed_enc` re-encrypt guarded to real hex ciphertext. **Phase 4 (REFACTOR) DONE:** DRY'd the two theme notifiers into a shared `ThemeVariantNotifier` base (`app.dart`), extracted `RekeyService._rekeyCommonplace` from the inline block in `rekey()`, removed the `dynamic`-typed `_restoreTransport` params (now reads its own providers) + a dead `ref.read` in the lock handler; `dart format` applied to 9 changed files. 46/46 GREEN retained, full suite `+2096`/0. COMMITTED (`bd3e9e5`).
- **✅ Commonplace Settings theme selector gap FIXED (2026-08-24):** storage (`commonplace_theme_mode`) + app-root per-book rendering were already wired, but the Commonplace Settings screen had no Appearance → Theme selector. Added it (`DropdownButton<ThemeVariant>` → `commonplaceThemeProvider.setVariant`, persisted mode loaded in `_loadStatus`); new CPS-T2 widget test (selection persists to `commonplace_theme_mode`, not `theme_mode`). 35/35 widget, full suite `+2097`/0. COMMITTED (`bd3e9e5`).
- **✅ Restore-pull isolate offload + concurrent fetch — 4-phase TDD COMPLETE (2026-08-22)** — plan at `docs/planning/flutter/RESTORE_PULL_ISOLATE_FIX_PHASE1.md`. Fixed the LIVE ANR bug (cloud restore imported 0 blocks): bounded concurrent `Future.wait` fetch (`pullConcurrencyLimit=5`, order preserved) + CPU-bound deobfuscation/validation offloaded to a background isolate via the `OffloadRunner` seam (`decodePullBlockBytes`/`validatePulledChain` in `pull_stage_functions.dart`). 25/25 assertions GREEN; full suite `+1979/-31` (only gated C-2 re-key RED remains); analyze 0. **Phase 4 (REFACTOR) DONE:** extracted `_fetchAllBlocks` helper, hoisted per-entry `getMasterKey()` out of the seed loop. Now **unblocks C-2** (below). Awaiting user commit.
- **✅ Smart Sync Button — 4-phase TDD COMPLETE (2026-08-21)** — option (b) reconcile-then-push;
  `commitAndSync({forceLocal})` + `reconcileRemoteLedger` (append-only, D3/D4 fork-guard), SyncScreen
  `_unifiedSync→smartSync` w/ outcome + phase-4 `ledgerEngine==null` guard. 20/20 GREEN, full suite `+1951`, analyze 0. Awaiting user commit.
- **✅ C-2 Full Seed Replacement (new seed re-key) — 4-phase TDD COMPLETE (2026-08-22), COMMITTED `07d09b0`** — plan at `docs/planning/flutter/SEED_REKEY_C2_PHASE1.md`. Re-key the vault + chain + genesis seed + device cookie under a fresh random seed (option a: new seed = new raw MK, key_version unchanged, no new chain-schema fields; re-key meta in AppPreferences) — genuinely nullifies the leaked seed. `rekey_service_test.dart` 28/28 (R/B/M/P), Settings Group S 6/6, full Flutter suite 2010/2010, analyze 0. Phase 4 (REFACTOR) DONE: split `rekey()` into named phase helpers (`preflightSnapshotAndWrite`, `_buildRebuiltBlocks`, `_replaceChainAndVault`, `_rotateDeviceCoordinates`, `_recordRekeyMarker`, `_activateNewKeySet`) + DRY'd per-entry re-encrypt into `_reencryptEntryMap` (mirror of Python `hard_rotate`); wired the previously-unreachable `ph rotate-keys` (soft) + `ph rotate-keys --full` (hard) into `main.py` as escape-hatch parity. Python suite 2614 pass / 1 skip.
- **✅ Pre-existing red-suite remediation DONE (2026-08-21)** — all **43 baseline failures** fixed (detail in `RED_SUITE_REMEDIATION_PHASE1.md`); suite `+1931` GREEN, analyze 0 err. Notable: restore is **fail-open ADOPT**; cross-device restore fixed at test level by importing the SHARED seed; `blockIndex` = chain ordinal not `day_index`.
- **✅ Commonplace Book — UI wiring COMPLETE (4-phase TDD, 2026-08-23).** 🟢 Phase 3 (GREEN): 40/40 GREEN, full suite `+2050`/0 fails, analyze 0. 🟢 Phase 4 (REFACTOR): dead-code removal in `_refresh`, identityless-bootstrap extraction + doc (`_ensureBookBootstrap`), consolidated `store` persistence cast + provider store construction; 40/40 GREEN retained. Implemented `CommonplaceService` + `commonplaceServiceProvider` + `CommonplaceScreen`/`AddEntryBottomSheet`/`TopicIndex` + `AppScaffold` content-swap by book (reactive `AppPreferences.bookMode` ValueNotifier). Tests: `commonplace_service_test.dart` (S+V), `commonplace_screen_test.dart` (L+A+T), `commonplace_swap_test.dart` (R). Engine slice (ADR-031, 55/55) + Book Switcher (13/13) done. Refs: `COMMONPLACE_BOOK_UI_PHASE1.md`; remote sync, key-rotation ext, deferred tag index, Web/CLI ports in BACKLOG + ROADMAP.
- **🔜 C-2 Seed Re-Key — WEB + CLI rollout (HIGH backlog, lower priority than Commonplace UI):** Flutter C-2 is the only client with true seed-replacement; web (`deriveMk`/`generateSeed` primitives only) and CLI (`rotate-keys` = same-seed key_version bump only) cannot nullify the leaked seed. Roadmap plan: `docs/planning/C2_SEED_REKEY_WEB_CLI_ROADMAP.md` — Phase A (CLI `ph rekey-seed`/`--renew-seed`), Phase B (web `RekeyService` engine), Phase C (web Settings Security & Recovery UI), Phase D (cross-client verify + spec). Added HIGH to BACKLOG. **Not yet started — after Commonplace UI wiring.**
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
