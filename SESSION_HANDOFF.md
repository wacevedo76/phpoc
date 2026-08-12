# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed milestones (archived):** `docs/planning/archive/SESSION_HISTORY_2026-08-10.md`

## Current State
- **Branch:** `Flutter-features_and_ux`
- **Ph-7 step 2 phone e2e (emulator-5554):** ✅ COMPLETE. On-device `integration_test/onboard_verify_test.dart` CONFIRMED both import paths on the migrated 132-block ledger. **Path A** (genesis-preserving `LedgerBackupService.importFromJson` = PHPSPEC pull) **`verify()=True` (132)**. **Path B** (`OnboardingService.importFromFile` onboarding) **`verify()=True` (132)** — genesis-replace bug FIXED via `keepExistingGenesis: true` (`_importRawChain`/`_importV2`) and confirmed on-device.
- **🟢 History/calendar empty after onboarding FIXED:** `OnboardingService._seedStagingFromImportedBlocks` (+ `_backfillCommentAndMedia`) decoded `data_enc` as a legacy entries-only ARRAY, but migrated (post-0.4.0 / full-map) blocks store the payload as a full canonical MAP with `entries` nested → cast threw → no staging seeded → calendar showed no activities after onboarding. Added `_decodeBlockEntries()` handling both shapes; unit regression U1 (`test/services/onboarding_staging_seed_test.dart`).
- **`original_hash` storage-fidelity bug FIXED:** `PhpSpecFormat` had no `kOriginalHash`; `_serializeCanonicalMap` + `blockToMap` dropped `original_hash` in the data_enc round-trip, so `_blockToMap` rebuilt migrated blocks WITHOUT it and the sealer recomputed a different hash than Python/Web. Added `kOriginalHash` + carry in import/export. Fidelity suite 15/15; `test/data/ledger/` 0 new failures (only pre-existing B1/B4/E6); analyzer clean.
- **Flutter test suite:** `test/data/ledger/` + fidelity + backup + seal suites GREEN except pre-existing cloud-sync/vault + B1/B4/E6 + flaky G3/G8. `flutter analyze lib` clean on changed files.
- **Onboarding Restore & Import Fixes ✅ 4-PHASE COMPLETE (P1–P4):** 7 pre-existing failures fixed (G1/L2/L5/V2/V4/L4-End/L7-End via A/B/C/D clusters); `onboarding_service_test.dart` 61/61 GREEN; P4 `_ImportEntry` normalizer refactor (unifies staging backend field extraction) + `_postImportSetup` genesis-conditional simplification — analyzer clean, no regressions (only pre-existing B1/B4/E6).
- **Python side (already done):** live ledger re-migrated (132 blocks), `chain.verify()=True`; backup at `~/.local/share/phpoc/backup_20260811_105703/`.
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`)
- **Python suite:** 2614 pass / 1 skip / 0 fail.

## Cross-Client Staging Sync — Reference Chain
- **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md`
- **Protocol:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
- **Backlog:** `docs/planning/BACKLOG.md` §CCS

## Immediate Next Steps 🎯

### ✅ Legacy Blob / `_pushBlobOnly()` Retirement — **4-PHASE TDD COMPLETE (P1–P4)**
- **Blueprints:** `docs/planning/ZOMBIE_BLOB_CLEANUP_PHASE{1,2,3}.md`
- **P3 (GREEN):** `stagingStore` required/non-null; all legacy `LocalCache` blob branches deleted (`_pushBlobOnly`, `_buildBlobBytes`, `remoteStagingBlob`, `_local.*`, `mergeMaps`, legacy `commitEntries`); ~132 `SyncService(` constructions migrated to real `StagingStore` across 16 files. **Z1–Z10 all GREEN.**
- **P4 (REFACTOR) DONE:** removed duplicate auto-push header; fixed over-indentation in `end`/`pause`/`unpause`; moved `LocalCache.computeDuration`→`FormatUtils.computeDurationMsec` (drops `sync_service.dart`'s last dep on retired `LocalCache`; B12 tests re-pointed); collapsed `_reconcileAndClaim()` wrapper into `_reconcileAndClaimRowLevel()` (guard moved inside). **Analyzer clean; no regressions.**
- **P4 follow-up — fixed the 4 stale cookie tests to A2/F1 contracts:** `sync_service_test` K3 (expired-cookie→destroy+`reauthNeeded`, not replace), K7 (5-min TTL expires 10-min cookie→`reauthNeeded`), M5 (mismatch destroys cookie when F1 bypassed via `skipReadOnlyFastPath:true`), M10 (F1 idle short-circuits, forced path pushes empty blob). Suite now **104–105 pass / 0–1 fail** — only pre-existing timing-flaky E15/L4 remain alternating. Blueprint rows updated in `FLUTTER_SYNC_TASKS_PHASE1.md`.
- **P4 follow-up — `sync_service_test.dart` fully analyzer-clean:** removed unused `push_result.dart` import; dropped unused `hashIndexBytes` ctor param; deleted dead `_SpyLedgerEngine`; renamed local helpers `seededSync`/`makePushService`/`seedBlock` per `no_leading_underscores`. `flutter analyze` -> **No issues found**.

### 🥈 Canonical Seal-Field (ADR-029/029a) — **Ph-7 step 2 phone e2e: ✅ COMPLETE**
- **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md`
**DONE this session:**
- Re-migrated live ledger (132 blocks) verified under Python (`chain.verify()=True`).
- Rebuilt Flutter debug APK; ran on-device `integration_test/onboard_verify_test.dart` on emulator-5554.
- **Fixed Path B (onboarding import-from-file genesis preservation):** `_importRawChain`/`_importV2` → `_postImportSetup(..., keepExistingGenesis: true)`; the imported canonical genesis is preserved instead of deleted/replaced by a Flutter-format `{seed}` genesis. Unit regression L10 + integration Path B assert verify.
- **Fixed `original_hash` storage-fidelity bug** (Part of ADR-029a seal set was dropped in data_enc round-trip) → Path A (PHPSPEC pull, genesis-preserving) `verify()=True` (132) on the emulator. Fidelity suite 15/15.
- Added regression guards (fidelity A4 + C6).
**✅ Ph-7 inbound onboarding paths COMPLETE & CONFIRMED ON-DEVICE.**
Rebuilt debug APK; ran `integration_test/onboard_verify_test.dart` on emulator-5554 → `PH7E2E RESULT: pathA(importFromJson)=verify:true blocks:132 | pathB(importFromFile)=verify:true blocks:132` — **BOTH Path A and Path B verify()=True with all 132 migrated blocks. All tests passed.**

**NEW this session (physical phone SM_S911B):** ledger onboards + verifies, but History/calendar showed NO activities. Root cause: onboarding staging-seed decode bug (fix + U1 regression above). **FIXED & CONFIRMED:** `Path B seededStaging=259` on emulator-5554 (was 0). APK rebuilt + reinstalled on the phone; re-onboard to see activities in the calendar.

### ✅ Flutter Storage Fidelity for Canonical Summaries — **4-PHASE TDD COMPLETE (P1–P4) + on-device validated**
- Root cause of on-device "Integrity Check Failed" (full-map data_enc lossless import) P3 GONE; **P4 REFACTOR done**; on-device Path-A verify now True.
- **P2 DONE:** `scripts/gen_canonical_seal_vectors.py` + `testdata/canonical_seal_vectors.json` (8 vectors, TWO chain-linked sequences); `tests/test_canonical_seal_vectors.py` (14) + `test_migration.py` B1–B5 rewired to `select_seal_fields`; Web B1-js–B5-js exact `expected_seal` via native HMAC (WASM glue broken on Node v24). Python full suite 2600 pass/1 skip/0 fail.
- **P3 DONE (Flutter summary convergence FIXED):** `chain.dart` `_sealFields` → per-type `_sealFieldsByType`; `_sealBlock`/`_verifyBlockSeal` select `{type, month|year, date, prev_hash, original_hash}` for summaries. Group E C1–C4 **GREEN**; C5/C6/D2 guards GREEN.
- **P4 (REFACTOR) DONE:** vectors DRYed (shared `_vector_map`; chain A/B dedup loop; fixture diff-verified, byte-identical); fixed `ledger_chain_test.mjs` typo. Analyzer + suites GREEN.

### ✅ QUEUE 2: Flutter Ledger Verify & Commit Fix — **4-PHASE TDD COMPLETE**
- **Plan:** `docs/planning/FLUTTER_LEDGER_VERIFY_FIX_PHASE1.md` — fixed 6 pre-existing failures (S1–S6): K2/K3/K4 verify content-hash, F15 empty-title encrypt, AE2/AE4 date-less commit summary.
- **P3 (GREEN) DONE:** `test/data/ledger/` **279/279 GREEN** (incl. all 12 assertions A–D and the 6 former S1–S6 failures):
  - `engine.dart`: allow empty `title`/`tags` encrypt when `has_encrypted_fields=true`; still reject non-string + whitespace-only title.
  - `summary_policy.dart`: **fixed latent summary-seal bug** (non-canonical `entries` in seal); now seals only `{type, month/year, date, prev_hash}` (ADR-029a) + skip summary fabrication on date-less prev.
  - Fixtures corrected: K2/K3/K4 valid `content_hash`; `_buildGenesis`/`_buildDayBlockNoDate` compute valid ADR-029a seals.
- **P4 (REFACTOR) DONE:** removed unused `chain.dart`/`index_manager.dart` imports in `engine_test.dart`; `summary_policy.dart` map entries → null-aware `?month`/`?year`; removed dead `_buildDayBlock` fixture; renamed local helpers per `no_leading_underscores`. `flutter analyze` clean on both files.

## Immediate Next Steps

### ✅ Onboarding Restore & Import Fixes — **4-PHASE TDD COMPLETE (P1–P4)**
- **Phase1 doc:** `docs/planning/ONBOARDING_RESTORE_FIXES_PHASE1.md` (14 assertions: A1–A5, B1–B4, C1–C4, D1–D2)
- **4 clusters:** A=genesis root on restore (G1/V2/L4); B=restore adopts existing chain (V4); C=import staging legacy fallback (L2/L5); D=vault seed assertion (L7-End).
- **P3 (GREEN) DONE in `lib/services/onboarding_service.dart`:** 3 code bugs fixed (genesis-existence fallback in `_postImportSetup`, `restoreFromCloud` adopts existing chain, `_writeStagingEntries` legacy-`===null` → `db.entryDao` fallback) + 1 test-only fix (L7-End vault round-trips actual random seed) → `onboarding_service_test.dart` **61/61 GREEN**. `flutter analyze lib` clean on changed files.
- **P4 (REFACTOR) DONE:** `_ImportEntry` normalizer extracted — centralizes `entry_id`/`hash` fallbacks + shared field reads for BOTH staging backends (row-level `stagingStore` blob + legacy `entries` table), removing duplicated per-path extraction (C4 fidelity); simplified `_postImportSetup` nested `keepExistingGenesis`/`hasGenesis` conditionals to a single `preserveGenesis` test (all D9/D8 behavior preserved). Onboarding 61/61 + related service suites GREEN; only pre-existing B1/B4/E6 fail. Analyzer clean.

### ✅ Staging Auto-Sync — **4-PHASE TDD COMPLETE (P1–P4)**
- **Plan:** `docs/planning/STAGING_AUTO_SYNC_PLAN.md`; **Phase1 doc:** `docs/planning/STAGING_AUTO_SYNC_AS_PHASE1.md`
- **Change:** `_doPush()` → `checkAndSync(skipReadOnlyFastPath: true)` (bidirectional pull+merge+push on every debounced auto-push), silent on `reauthNeeded`, derive `SyncingStatus` from `SyncCheckResult`.
- **Prereqs done:** CCS-1✅ CCS-2✅ CCS-3✅ CCS-4✅
- **Phase 3 (GREEN)** in `sync_service.dart`: `skipReadOnlyFastPath` param; `_runAutoSync()` maps `SyncCheckResult`→bool (ready/reauth→true, offline/genesisMismatch→false) and swallows errors; `_doPush()` settles `inSync` on no-transport (AS3). **AS1–AS6 all GREEN.**
- **Phase 4 (REFACTOR) DONE:** extracted `_runAutoSyncWithRetry()` (owns single-retry policy) + `_settleToInSync()` (no-op settle, AS3); wrapped `_isSyncing` reset + terminal status emit in `finally` (robust); pre-auth (D14) now settles to `inSync` instead of stranding `pendingPush`. Analyzer clean on changed lines; no regressions.
- **Green:** `sync_service_row_level_test.dart` 60/60; `sync_service_overhaul_test.dart` 43/43; `test/data/ledger/` 280/280; sync dir pre-existing K3/K7/M5/M10 now RESOLVED (A2/F1 contract fixes) + N3/N18 + flaky restore G1/G3/G5/G6/G10.

## Other In-Flight

---

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)

## Known Issues
- Pre-existing Web red (unchanged): `ledger_merge_test` (block-1 entry-hash), `import_entries_test`, `genesis_gate_test`; `sync_service_test` 42 red
- 2 pre-existing Flutter `restore_integration` flaky tests (G3, G8) — pass in isolation, fail in full suite
- **`_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — RETIRED ✅** (Option A full legacy-LocalCache retirement, 4-PHASE COMPLETE P1–P4). `stagingStore` required/non-null; legacy blob branches deleted; Z1–Z10 GREEN; `LocalCache.computeDuration` moved to `FormatUtils.computeDurationMsec`.

- **🟢 `verify()` after cloud restore** — FIXED (Plan B: RC1–RC3). See `docs/planning/VERIFY_RESTORE_FIX_PLAN_B.md`.
