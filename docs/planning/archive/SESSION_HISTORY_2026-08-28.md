# Session History — 2026-08-28 (archived completed milestones)

> Archived from `SESSION_HANDOFF.md` to keep it under the 100-line limit.
> Active C-2 Cross-Client Verify work + Known Issues remain in the handoff.

## ✅ P4 Web vitest harness hygiene — 4-phase TDD COMPLETE (2026-08-28)
Single `test.include` glob; 3 load errors fixed (`ledger_merge_test.mjs` 105/105, `genesis_gate_test.mjs`
218/218 via ADR-029a whitelist-seal + date-based genesis fixtures, `sync_indicator_test.mjs` 32/32);
8 node suites renamed `*.test.mjs`→`*_test.mjs`; 2 `verifyLedgerChain` mock gaps patched; 2-assertion
config meta-test added. `npx vitest run` clean (9 files / 119 passed / 1 skip / 0 fail / 0 errors).

## ✅ settings_genesis_component GenesisGate status-card — 4-phase TDD COMPLETE (2026-08-27)
`test/settings_genesis_component.test.mjs` was the lone vitest file with real failing assertions (25 RED —
GenesisGate groups B/E/F, expect direct `GenesisGate.check`). **Phase 3 GREEN:** rewrote `Settings.jsx`
`handleSaveRemote` to go straight to `GenesisGate.check` (removed the `/health` fetch-ping the mocked
`fetch` couldn't satisfy); persists `phpoc_worker_url`/`phpoc_api_key` synchronously (dedup E1/E3,
rapid-change E2); keeps offline/incompatible/error status cards + `role="status"`/`aria-live="polite"`
(F1–F4). **Phase 4 REFACTOR DONE:** extracted `checkGenesis(workerUrl, apiKey)` helper + added a
`genesisCheckSeq` `useRef` latest-request-wins guard; collapsed `saved` string-state to a boolean
`justSaved`, removing dead button branches + dead `btn-danger` class. **26/26 GREEN** (no regression).
Full `vitest run` 0 real failures (117 passed / 1 intentional `it.skip` E7).

## ✅ Commonplace Book Settings — 4-phase TDD COMPLETE (2026-08-24)
`docs/planning/flutter/COMMONPLACE_BOOK_SETTINGS_PHASE1.md` (46 assertions). **GREEN: 34/34 widget
(`commonplace_settings_screen_test.dart`) + 12/12 service (`commonplace_settings_services_test.dart`);
full suite `+2096`/0; analyze 0.** Implemented: `CommonplaceSettingsScreen` (Verify/Re-key/Backup/
Restore/Clear-All/Security/Push, excludes Ledger-only Import/Migrate/dup Worker), book-scoped `/settings`
redirect, shared Worker URL/API-token direct writes, per-book theme at app root, `RekeyService.commonplaceService`
re-encrypt + re-seal + re-link of `commonplace.json` under the new MK, `AppPreferences.get/setCommonplaceThemeMode`,
`OnboardingService.clearAllData` wipes both books. RED-test corrections: `_pumpScreen` resolves per-book theme
+ init crypto + spy-auth, scrollUntilVisible for below-fold taps, R5 fixture seeded under `oldMK`.
**Phase 4 (REFACTOR) DONE:** DRY'd theme notifiers into `ThemeVariantNotifier`, extracted
`RekeyService._rekeyCommonplace`, removed `dynamic`-typed `_restoreTransport` params + dead `ref.read`.
46/46 GREEN retained. COMMITTED (`bd3e9e5`).

## ✅ Commonplace Settings theme selector gap FIXED (2026-08-24)
Added Appearance → Theme selector (`DropdownButton<ThemeVariant>` → `commonplaceThemeProvider.setVariant`,
persisted mode in `_loadStatus`); new CPS-T2 widget test (selection persists to `commonplace_theme_mode`).
35/35 widget, full suite `+2097`/0. COMMITTED (`bd3e9e5`).

## ✅ Restore-pull isolate offload + concurrent fetch — 4-phase TDD COMPLETE (2026-08-22)
Plan at `docs/planning/flutter/RESTORE_PULL_ISOLATE_FIX_PHASE1.md`. Fixed the LIVE ANR bug (cloud restore
imported 0 blocks): bounded concurrent `Future.wait` fetch (`pullConcurrencyLimit=5`, order preserved) +
CPU-bound deobfuscation/validation offloaded to a background isolate via `OffloadRunner` (`decodePullBlockBytes`
/`validatePulledChain` in `pull_stage_functions.dart`). 25/25 GREEN; full suite `+1979/-31`; analyze 0.
**Phase 4 (REFACTOR) DONE:** extracted `_fetchAllBlocks`, hoisted per-entry `getMasterKey()` out of the seed loop.

## ✅ Smart Sync Button — 4-phase TDD COMPLETE (2026-08-21)
Option (b) reconcile-then-push; `commitAndSync({forceLocal})` + `reconcileRemoteLedger` (append-only,
D3/D4 fork-guard), SyncScreen `_unifiedSync→smartSync` w/ outcome + phase-4 `ledgerEngine==null` guard.
20/20 GREEN, full suite `+1951`, analyze 0.

## ✅ C-2 Full Seed Replacement (new seed re-key) — 4-phase TDD COMPLETE (2026-08-22), COMMITTED `07d09b0`
Plan at `docs/planning/flutter/SEED_REKEY_C2_PHASE1.md`. Re-key the vault + chain + genesis seed + device
cookie under a fresh random seed (option a: new seed = new raw MK, key_version unchanged, no new chain-schema
fields; re-key meta in AppPreferences) — genuinely nullifies the leaked seed. `rekey_service_test.dart` 28/28
(R/B/M/P), Settings Group S 6/6, full Flutter suite 2010/2010, analyze 0. Phase 4 (REFACTOR) DONE: split
`rekey()` into named phase helpers (`preflightSnapshotAndWrite`, `_buildRebuiltBlocks`, `_replaceChainAndVault`,
`_rotateDeviceCoordinates`, `_recordRekeyMarker`, `_activateNewKeySet`) + DRY'd per-entry re-encrypt into
`_reencryptEntryMap` (mirror of Python `hard_rotate`); wired `ph rotate-keys` (soft) + `--full` (hard) into `main.py`.

## ✅ Pre-existing red-suite remediation DONE (2026-08-21)
All **43 baseline failures** fixed (detail in `RED_SUITE_REMEDIATION_PHASE1.md`); suite `+1931` GREEN.
Notable: restore is **fail-open ADOPT**; cross-device restore fixed at test level by importing the SHARED
seed; `blockIndex` = chain ordinal not `day_index`.

## ✅ Commonplace Book — UI wiring COMPLETE (4-phase TDD, 2026-08-23)
40/40 GREEN. Implemented `CommonplaceService` + `commonplaceServiceProvider` + `CommonplaceScreen`/
`AddEntryBottomSheet`/`TopicIndex` + `AppScaffold` content-swap by book (reactive `AppPreferences.bookMode`).
Tests: `commonplace_service_test.dart` (S+V), `commonplace_screen_test.dart` (L+A+T), `commonplace_swap_test.dart` (R).
Engine slice (ADR-031, 55/55) + Book Switcher (13/13) done. Refs: `COMMONPLACE_BOOK_UI_PHASE1.md`; remote sync,
key-rotation ext, deferred tag index, Web/CLI ports in BACKLOG + ROADMAP.

## 🟡 C-2 Seed Re-Key — WEB ✅ / CLI 🔜 (HIGH backlog)
Flutter C-2 is the only client with true seed-replacement; web (`deriveMk`/`generateSeed` primitives only) and
CLI (`rotate-keys` = same-seed key_version bump only) cannot nullify the leaked seed. Roadmap:
`docs/planning/C2_SEED_REKEY_WEB_CLI_ROADMAP.md` (Phase A CLI `ph rekey-seed`/`--renew-seed`, Phase B web
`RekeyService` engine, Phase C web Settings Security & Recovery UI, Phase D cross-client verify).
**Web Phase 1 (blueprint) DONE:** `docs/planning/C2_SEED_REKEY_WEB_PHASE1.md` — 34 assertions (R11/B5/M6/P6/S6).
**Web Phase 2 (RED) DONE:** `test/rekey_service_web_test.mjs` (28 Node) + `test/rekey_settings_web.test.mjs` (6 Vitest/RTL).
All 34 RED — "RekeyService not implemented — Phase 3". Node harness loads the REAL WASM `CryptoService` from
`src/crypto/wasm/phpoc_crypto_core_bg.wasm` + `MemoryBackend`; fixtures build genesis+day blocks via
`computeSeal`/`crypto.sign`. **Web Phase 3 (GREEN) DONE:** `src/services/rekey_service.js` (28/28 node) + Settings
Security & Recovery UI (6/6) + `DevModeContext.rekey(...)`. **Web Phase 4 (REFACTOR) DONE:** extracted `rekey()`
into named phase helpers (`_recoverIdentitySecret`, `_rebuildBlocks`, `_persistNewKeySet`, `_recordRekeyMarker`,
`_pushRewrittenChain`). **C-2 Web 4-phase TDD COMPLETE.** COMMITTED (`4364ac2`). Remaining: CLI Phase A + cross-client Phase D.
