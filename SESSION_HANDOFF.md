# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed milestones (archived):** `docs/planning/archive/SESSION_HISTORY_2026-08-11.md`

## Current State
- **Branch:** `Flutter-features_and_ux`
- **ADR-030 Ledger Auto-Pull on Ownership-Handoff Reauth — 4-PHASE TDD ✅ COMPLETE.** See Immediate Next Steps.
- **ADR-030 Scenario-5/6 ledger-aware handoff cleanup — 4-PHASE TDD ✅ COMPLETE** (2026-08-11). Wired `dropLedgerCommitted` into the handoff reconcile.
- **Flutter test suite:** `test/data/ledger/` (325/325), `ledger_push_service_test`+`engine_test` (106/106),
  new `ledger_auto_pull_on_reauth_test.dart` (12/12) GREEN. Pre-existing failures unchanged:
  `ledger_backup` B1/B4/E6, `ledger_pull` B4/B6/C3/C4/F3, `sync_screen` L2/L3/L4/L6+R5, `restore_integration`
  flaky G1/G3/G5/G6, `sync_service` E15/L4 flaky, `ccs1_gap_closure` load (legacy `stagingStore: null`).
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`) | **Python suite:** 2614 pass / 1 skip / 0 fail.

## Cross-Client Staging Sync — Reference Chain
- **Protocol:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (incl. ADR-030 pull-on-handoff rule)

## Immediate Next Steps 🎯

### ✅ ADR-030 Scenario-5/6 ledger-aware handoff cleanup — Phase 4 (REFACTOR) COMPLETE (2026-08-11)
- **Blueprint:** `docs/planning/SCENARIO56_WIRE_PHASE1.md` (9 assertions: L3W.1–4, L3X.1–3, L3Y.1–2).
- **Phase 2 (RED):** 9 tests in `ledger_auto_pull_on_reauth_test.dart`; 2 RED (L3W.1, L3X.1).
- **Phase 3 (GREEN):** 21/21; real `LedgerEngine.ledgerActivityIds()`; `_dropSealedUncommitted()` wired into
  `SyncService._reconcileAndClaimRowLevel()` after `mergeEntries`.
- **Phase 4 (REFACTOR, Conciseness/DRY + Clarity):** `_dropSealedUncommitted` now delegates the pure id-set drop to
  `MergeEngine.dropLedgerCommitted` (caller supplies only the uncommitted subset — Phase-1 decision) instead of
  re-implementing the filter inline; refreshed the stale merge_engine doc note (it IS now wired). Analyzer clean.
- **Verification:** 147/147 across `ledger_auto_pull_on_reauth`+`merge_engine`+`sync_service_row_level`+
  `ledger_push_service`; `flutter analyze` clean. No behavior change.
- **Files:** `sync_service.dart`, `merge_engine.dart` (doc-only).

### ✅ ADR-030 — Phase 4 (REFACTOR) COMPLETE (2026-08-11)
- **Improvement (Conciseness/DRY):** `ledger_push_service.dart` — extracted shared `_pushChainPayloads` transport
  loop + top-level `_BlockPayload` value type; deduped `pushBlocks`/`pushAll` block-push + hash_index push (~30 lines).
- **Improvement (Clarity):** `merge_engine.dart` — `dropLedgerCommitted` docs note it is unit-tested only and
  not yet wired into the handoff; removed a redundant local alias.
- **Verification:** 12/12 auto-pull + 58 push-service + `providers` + `sync_service_row_level` + `merge_engine`
  all GREEN; `flutter analyze` clean on all 5 files. No behavior change.
- **Files:** `ledger_push_service.dart`, `merge_engine.dart`.

### 🔨 Web: ADR-030 ledger-aware handoff auto-sync — **PHASE 1 (BLUEPRINT) DONE**
- **Plan:** `docs/planning/WEB_LEDGER_AUTO_PULL_PHASE1.md` — 13 assertions (W1 pull-on-handoff, W2 Scenario-5/6
  drop, W3 Web `ledgerActivityIds`). Node-unit tests in `phpoc-web/test/`.
- **Concurrently:** reconciled stale §8.3 implementation-status table in `CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md`
  (all clients row-level LWW GREEN per CCS-2/3/4).
- **Next (Phase 2 RED):** write `web_ledger_auto_pull_test.mjs` node tests against `sync.js` `_reconcileAndClaim`.

## Other In-Flight

---

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)

## Known Issues
- Pre-existing Web red (unchanged): `ledger_merge_test` (block-1 entry-hash), `import_entries_test`,
  `genesis_gate_test`; `sync_service_test` 42 red.
- 2 pre-existing Flutter `restore_integration` flaky tests (G3, G8) — pass in isolation, fail in full suite.
- Pre-existing Flutter failures (unchanged, verified on baseline): `ledger_backup` B1/B4/E6, `ledger_pull`
  B4/B6/C3/C4/F3, `sync_screen` L2/L3/L4/L6+R5, `restore_integration` G1/G3/G5/G6, `sync_service` E15/L4 (flaky),
  `ccs1_gap_closure` load error (`stagingStore: null` legacy, from prior zombie cleanup).
- **`_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — RETIRED ✅** (4-PHASE COMPLETE). `stagingStore` required/non-null.
- **🟢 `verify()` after cloud restore** — FIXED (Plan B: RC1–RC3). See `docs/planning/VERIFY_RESTORE_FIX_PLAN_B.md`.
