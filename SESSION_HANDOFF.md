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
- **Flutter test suite:** `test/data/ledger/` 279/279 GREEN (**6 pre-existing ledger failures S1–S6 FIXED**); full-suite failures now only pre-existing cloud-sync/vault + flaky G3/G8 (57–63 run-to-run). `flutter analyze` clean on `engine_test.dart` + `summary_policy.dart`.
- **Flutter Ledger Verify & Commit Fix:** ✅ **4-Phase TDD COMPLETE** (Phase 3 green fixed S1–S6; Phase 4 refactor clean). Now focused on **Ph-7 phone e2e step 2 (re-migrate real ledger + phone verify).**
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`)
- **Canonical Seal-Field (ADR-029/029a):** Phases 1–5 complete (Python/Web/Flutter/Migrator/PHPSPEC). **Ph-6 (vectors) 4-Phase TDD COMPLETE — P4 (REFACTOR) DONE. Ph-7 migrator summary synthesis 4-Phase TDD COMPLETE — P4 (REFACTOR) DONE.** Ph-7 (real re-migrate + phone e2e verify) next.
- **Python suite:** 2586 pass / 1 skip / 0 fail. **Naming conformance (`test_naming_i04.py`): 50/50 GREEN** (fixed latent `_section_text` regex bug).

## Cross-Client Staging Sync — Reference Chain
- **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md`
- **Protocol:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
- **Backlog:** `docs/planning/BACKLOG.md` §CCS

## Immediate Next Steps 🎯

### 🥇 QUEUE TOP: Canonical Seal-Field (ADR-029/029a) — Python ✅ · Web ✅ · Flutter ✅ · Migrator ✅ · **PHPSPEC ✅ · Ph-6 vectors ✅ · Ph-7 (migrator summary synth) ✅ · phone e2e 🔜**
- **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` (7 phases, each 4-phase TDD)

**Ph-7 migrator summary synthesis — DONE (P1–P4):**
- **P4 (REFACTOR) DONE:** `_canonicalize_summary` → explicit mutator (`-> None`, dropped unused `return block`; caller already owns a shallow copy). No behavior change. `TestMigrateFormatSummarySynthesis` 14/14 GREEN; `test_migrate_format.py` 57/57; migration+vectors scope 117 pass; **full Python suite 2614 pass / 1 skip / 0 fail** (the 1 prior full-suite flake passed this run).
- **P3 (GREEN) recap:** added `_canonicalize_summary` in Phase-1 else-branch (synthesize `month=date[:7]` / `year=int(date[:4])` when absent, preserve explicit, drop stray `day_index`/`entries`; runs before re-seal so the partition identity is sealed). 14/14 GREEN.
- **P1/P2 recap:** blueprint `docs/planning/CANONICAL_SEALFIELD_PHASE7_MIGRATOR_SUMMARY_PHASE1.md` (14 assertions A–D); RED 8, regression 6.

**🔜 NEXT — Ph-7 step 2: actually re-migrate the real ledger + rebuild/reinstall phone + confirm on-device `verify()`** (the remaining `- [ ]` boxes in the Phase 7 plan section). 132-block ledger; `chain.verify()` currently False (seals diverge); `migrate-format --force` on /tmp copy now succeeds+verifies with canonical `month`/`year` after the synthesis fix.

_Prior: Ph-6 vectors (DONE):_
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

## Other In-Flight
- **Staging Auto-Sync** (queued): bidirectional `checkAndSync()` — `docs/planning/STAGING_AUTO_SYNC_PLAN.md`

---

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)

## Known Issues
- Pre-existing Web red (unchanged): `ledger_merge_test` (block-1 entry-hash), `import_entries_test`, `genesis_gate_test`; `sync_service_test` 42 red
- 2 pre-existing Flutter `restore_integration` flaky tests (G3, G8) — pass in isolation, fail in full suite
- `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — old-path zombie. Remove after legacy path cleanup.
- **🟢 `verify()` after cloud restore** — FIXED (Plan B: RC1–RC3). See `docs/planning/VERIFY_RESTORE_FIX_PLAN_B.md`.
