# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`

## Current State
- **Branch:** `Flutter-features_and_ux`
- **Flutter test suite:** 1600/1663 passing (63 failing: all pre-existing)
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`)
- **Active TDD:** ✅ Canonical Seal-Field (ADR-029/029a) Phases 1–4 complete — seal sites converged on `compute_seal` (see QUEUE TOP below)

## Cross-Client Staging Sync — Reference Chain
- **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md`
- **Protocol:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
- **Backlog:** `docs/planning/BACKLOG.md` §CCS

## Immediate Next Steps 🎯

### 🥇 QUEUE TOP: Canonical Seal-Field (ADR-029/029a) — Phases 1–4 ✅ COMPLETE
- **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` (7 phases, each 4-phase TDD)
- **Status:** Ph-1 · P1 ✅ blueprint · P2 ✅ RED · P3 ✅ GREEN · **P4 ✅ REFACTOR complete**

**P4 REFACTOR (this session) — done:**
- Routed remaining inline `crypto.seal(json.dumps(select_seal_fields(...), sort_keys=True))` sites through `compute_seal`: `auth.py`, `onboarding.py` (genesis + loop), `onboarding_file.py` (genesis + loop), `rotate_keys.py` (passes `crypto_v2` as first arg), `migrate_format.py:_seal_block`. Cleaned now-unused imports + a redundant `check_data` var in onboarding.py.
- **This session (final pass):** also routed `core/factory.py` genesis seal and `chain.py` `create_day` day seal through `compute_seal` — every synchronous block sealer now uses the single entry point. Merge.py seal uses keep `inspect.iscoroutinefunction` dispatch and stay on `select_seal_fields` (async-safe); verify/recompute sites in chain.py/migrate/rotate_keys keep `select_seal_fields` for check-data clarity.
- **Exception (unchanged):** `migrate.py` `_seal(..., integrity_key)` uses a per-chain integrity key — documented in plan, not `compute_seal`.
- **Full Python suite GREEN: 2475 passed, 1 skipped / 0 failures** (re-verified after final consolidations).

### 🔜 Queued
- **CCS-2:** Web — wire `RowStagingStore` + `StagingHashIndex` + `mergeEntries` into `sync.js`
- **CCS-3:** CLI — build `SqliteStagingStore`, switch to activity_id LWW, wire into `StagingService`
- **CCS-4:** Cross-client E2E testing (Flutter↔Web, Flutter↔CLI, Web↔CLI)
- **Staging Auto-Sync:** bidirectional `checkAndSync()` — `docs/planning/STAGING_AUTO_SYNC_PLAN.md`

### 🔜 In Progress: `ph migrate-format` — Canonical 0.4.0 Rehash
- Built `phpoc_cli/migrate_format.py` + standalone `migrate-format.py` (project root)
- ```--force``` flag bypasses the >=0.4.0 guard; full rehash + re-seal of ALL block types
- Fixed: ```key_version``` default 0, stray ```block_hash``` stripping, non-day block re-sealing
- Verified on real 129-block ledger: content hashes 270/270 canonical, `chain.verify()` True
- Tests: `tests/test_migrate_format.py` (17 green)

### ✅ Completed: Verify/Restore Fix Plan B (4-Phase TDD) → ARCHIVED
- 65 assertions, 57 tests, 7 modified + 2 new files
- Phase 4: 6 improvements (DecryptHelpers mixin, generateActivityId(), _sealFields, _prevHashValid(), _updateGenesisSeedEncIfNeeded())
- Full archive: `docs/planning/archive/SESSION_HISTORY_2026-07-26.md`

### ✅ Completed: Verify Ledger — Settings Card
- Verify Ledger tile in Security card. 23/23 settings tests GREEN.

### ✅ Completed: CCS-1b
- `obfuscateBlobDeterministic()` with `_obfuscateBlobCore()`. 85/85 crypto tests GREEN.

---

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)

## Known Issues
- 2 pre-existing `restore_integration` flaky tests (G3, G8) — pass in isolation, fail in full suite
- `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — old-path zombie. Remove after legacy path cleanup.
- **🟢 `verify()` after cloud restore** — FIXED (Plan B: RC1–RC3 resolved). See `docs/planning/VERIFY_RESTORE_FIX_PLAN_B.md`.
