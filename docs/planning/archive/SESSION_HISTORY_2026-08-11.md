# Session History — 2026-08-11

> Consolidated completed milestones archived from `SESSION_HANDOFF.md` (size limit).
> Fully-complete feature work remains governed by their planning docs + `BACKLOG.md` /
> `docs/reference/CHANGELOG.md`. Active work lives in `SESSION_HANDOFF.md`.

## ✅ Ph-7 step 2 phone e2e (emulator-5554) — COMPLETE
- On-device `integration_test/onboard_verify_test.dart` CONFIRMED both import paths on the
  migrated 132-block ledger. **Path A** (genesis-preserving `LedgerBackupService.importFromJson` =
  PHPSPEC pull) **`verify()=True` (132)**. **Path B** (`OnboardingService.importFromFile` onboarding)
  **`verify()=True` (132)** — genesis-replace bug FIXED via `keepExistingGenesis: true`
  (`_importRawChain`/`_importV2`) and confirmed on-device.
- `original_hash` storage-fidelity bug FIXED (`PhpSpecFormat` `kOriginalHash` + carry in
  import/export). Fidelity 15/15; `test/data/ledger/` 0 new failures (only pre-existing B1/B4/E6).

## 🟢 History/calendar empty after onboarding — FIXED
- `OnboardingService._seedStagingFromImportedBlocks` (+ `_backfillCommentAndMedia`) decoded
  `data_enc` as legacy entries-only ARRAY, but migrated (post-0.4.0 / full-map) blocks store the
  payload as a full canonical MAP with nested `entries` → cast threw → no staging seeded → empty
  calendar. Added `_decodeBlockEntries()` handling both shapes; regression U1
  (`test/services/onboarding_staging_seed_test.dart`).

## ✅ Legacy Blob / `_pushBlobOnly()` Retirement — 4-PHASE TDD COMPLETE (P1–P4)
- **Blueprints:** `docs/planning/ZOMBIE_BLOB_CLEANUP_PHASE{1,2,3}.md`
- `stagingStore` required/non-null; all legacy `LocalCache` blob branches deleted (`_pushBlobOnly`,
  `_buildBlobBytes`, `remoteStagingBlob`, `_local.*`, `mergeMaps`, legacy `commitEntries`);
  ~132 `SyncService(` constructions migrated across 16 files. Z1–Z10 GREEN.
- P4: removed duplicate auto-push header; fixed over-indentation; moved
  `LocalCache.computeDuration`→`FormatUtils.computeDurationMsec`; collapsed `_reconcileAndClaim()`
  wrapper; fixed 4 stale cookie tests to A2/F1 contracts (K3/K7/M5/M10). `sync_service_test.dart`
  fully analyzer-clean. Pre-existing timing-flaky E15/L4 remain alternating.

## 🥈 Canonical Seal-Field (ADR-029/029a) — Ph-7 step 2 phone e2e COMPLETE
- Re-migrated live ledger (132 blocks) verified under Python (`chain.verify()=True`).
- Fixed Path B genesis preservation + `original_hash` fidelity bug. Fidelity suite 15/15.
- `PH7E2E RESULT: pathA=verify:true blocks:132 | pathB=verify:true blocks:132` on emulator-5554.
- Physical phone (SM_S911B): onboarding staging-seed decode bug fixed; `Path B seededStaging=259`.

## ✅ Flutter Storage Fidelity for Canonical Summaries — 4-PHASE TDD COMPLETE (P1–P4)
- Root cause of on-device "Integrity Check Failed" (full-map data_enc lossless import) P3 GONE.
- P2: `scripts/gen_canonical_seal_vectors.py` + `testdata/canonical_seal_vectors.json` (8 vectors);
  `tests/test_canonical_seal_vectors.py` (14). Python 2600 pass/1 skip/0 fail.
- P3: `chain.dart` per-type `_sealFieldsByType` for summaries. Group E C1–C4 GREEN.
- P4: vectors DRYed; `ledger_chain_test.mjs` typo fixed. Analyzer + suites GREEN.

## ✅ QUEUE 2: Flutter Ledger Verify & Commit Fix — 4-PHASE TDD COMPLETE
- Fixed 6 pre-existing failures (S1–S6): K2/K3/K4 verify content-hash, F15 empty-title encrypt,
  AE2/AE4 date-less commit summary. `test/data/ledger/` 279/279 GREEN.
- `summary_policy.dart` fixed latent summary-seal bug (seals only `{type, month/year, date,
  prev_hash}` per ADR-029a). Analyzer clean.

## ✅ Onboarding Restore & Import Fixes — 4-PHASE TDD COMPLETE (P1–P4)
- **Phase1 doc:** `docs/planning/ONBOARDING_RESTORE_FIXES_PHASE1.md` (A1–A5, B1–B4, C1–C4, D1–D2)
- 3 code bugs fixed (genesis-existence fallback, restoreFromCloud adopts existing chain,
  legacy `entries` fallback) + 1 test fix → `onboarding_service_test.dart` 61/61 GREEN.
- P4 `_ImportEntry` normalizer + `_postImportSetup` genesis-conditional simplification. Only
  pre-existing B1/B4/E6 fail. Analyzer clean.

## ✅ Staging Auto-Sync — 4-PHASE TDD COMPLETE (P1–P4)
- **Plan:** `docs/planning/STAGING_AUTO_SYNC_PLAN.md`; **Phase1:** `STAGING_AUTO_SYNC_AS_PHASE1.md`
- `_doPush()` → `checkAndSync(skipReadOnlyFastPath: true)` bidirectional auto-sync; AS1–AS6 GREEN.
- P4: `_runAutoSyncWithRetry()` + `_settleToInSync()`; robust `finally`. Analyzer clean.
- Green: `sync_service_row_level_test.dart` 60/60; `sync_service_overhaul_test.dart` 43/43;
  `test/data/ledger/` 280/280.

## ✅ Flutter: manual "Sync Staging" does not pull remote rows — 4-PHASE TDD COMPLETE
- **Plan:** `docs/planning/flutter/MANUAL_SYNC_PULL_F1_PHASE1.md` (9 assertions S1/S2/S3)
- **Fix:** `sync_screen.dart` `_syncNow()` → `checkAndSync(skipReadOnlyFastPath: true)` (S2.2 RED→GREEN).
- **Verification:** S1(3)+S2(3)+S3(3) GREEN; row_level+manual_pull+merge_engine 71/71 + auto_pull 21/21.
  E15 flaky & L2/L3/L4/L6+R5 pre-existing (baseline-identical). Analyzer clean (2 pre-existing unused-import warnings).

## ✅ ADR-030 Scenario-5/6 ledger-aware handoff cleanup — 4-PHASE TDD COMPLETE
- **Blueprint:** `docs/planning/SCENARIO56_WIRE_PHASE1.md` (L3W.1–4, L3X.1–3, L3Y.1–2)
- **Phase 3:** real `LedgerEngine.ledgerActivityIds()`; `_dropSealedUncommitted()` wired into
  `SyncService._reconcileAndClaimRowLevel()` after `mergeEntries`.
- **Phase 4:** `_dropSealedUncommitted` delegates the pure id-set drop to `MergeEngine.dropLedgerCommitted`.
- **Verification:** 147/147 (auto_pull+merge_engine+row_level+push_service); analyzer clean. No behavior change.

## ✅ ADR-030 — Phase 4 (REFACTOR) COMPLETE
- `ledger_push_service.dart`: extracted `_pushChainPayloads` loop + `_BlockPayload`; deduped block/hash_index push (~30 lines).
- `merge_engine.dart`: `dropLedgerCommitted` doc note + removed redundant local alias.
- **Verification:** 12/12 auto-pull + 58 push-service + providers + row_level + merge_engine GREEN. No behavior change.

## ✅ Web: ADR-030 ledger-aware handoff auto-sync — 4-PHASE TDD COMPLETE
- **Blueprint:** `docs/planning/WEB_LEDGER_AUTO_PULL_PHASE1.md` (W1/W2/W3)
- **Phase 3:** `sync.js` `_pullLedgerOnHandoff()` (block-count-gated) + `_ledgerActivityIds()`; W2 drop wired into `_mergeRemoteIntoLocal`, awaited before `pushBlobOnly`.
- **Phase 4:** extracted pure `SyncService._dropSealedUncommitted` (mirrors Flutter `MergeEngine.dropLedgerCommitted`).
- **Verification:** 17/17 auto-pull GREEN; no regressions; `vite build` succeeds.

## ✅ Trigger stage sync after re-authentication — 4-PHASE TDD COMPLETE (2026-08-11)
- **Blueprint:** `docs/planning/flutter/REAUTH_TRIGGERS_STAGE_SYNC_PHASE1.md` (U1/U2/U3, 6 assertions).
- **Debug-first check:** confirmed `masterKeyCached = true` yet `checkAndSyncCalls = 0` post-unlock — gap real.
- **Phase 2 (RED):** `test/features/reauth_triggers_sync_test.dart` — 4 RED (U1.1/1.2/1.3 + U2.1) + 2 GREEN guards (U3.1/U3.2).
- **Phase 3 (GREEN):** `unlock_screen.dart` `_triggerSyncAfterReauth()` (fire-and-forget
  `unawaited(checkAndSync(skipReadOnlyFastPath: true))`, mounted-guarded, D15-safe) wired into `_unlock()` + `_biometricUnlock()`.
- **Phase 4 (REFACTOR, Clarity/Conciseness):** tightened the 2 redundant call-site comments (helper doc retains ADR-030 rationale). No behavior change.
- **Verification:** 6/6 GREEN; unlock_screen(31)+biometric_integration GREEN; regression sweep 96/96; no new failures (dashboard T7/U1/U3 & sync_screen L2/L3/L4/L6+R5 baseline-identical); analyzer clean.
