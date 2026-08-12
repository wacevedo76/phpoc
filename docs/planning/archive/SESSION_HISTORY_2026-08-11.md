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
