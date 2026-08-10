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
- **Active TDD:** ✅ CCS-2 Web row-level sync (Option B) Phases 1–4 complete — 41/41 GREEN
- **Active TDD:** ✅ CCS-3 CLI sync-gate wiring Phases 1–4 complete — 60/60 GREEN, full suite 2535 pass / 1 skip / 0 fail

## Cross-Client Staging Sync — Reference Chain
- **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md`
- **Protocol:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
- **Backlog:** `docs/planning/BACKLOG.md` §CCS

## Immediate Next Steps 🎯

### 🥇 QUEUE TOP: Canonical Seal-Field (ADR-029/029a) — Python ✅ · Web ✅ · **Flutter ✅ · Migrator ✅ · PHPSPEC/vectors/phone 🔜**
- **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` (7 phases, each 4-phase TDD)
- **Status:** Ph-1 (Python) ✅ · Ph-2 (Web) ✅ P1–P4 · Ph-3 (Flutter) ✅ P1–P4 · **Ph-4 (Migrator) ✅ P1–P4 COMPLETE** · Ph-5 (PHPSPEC) / Ph-6 (vectors) / Ph-7 (re-migrate+phone) 🔜

**Ph-3 Flutter P1–P4 (this session) — `_sealFields` → 6-field:**
- **P1:** `docs/planning/CANONICAL_SEALFIELD_FLUTTER_PHASE1.md` (9 tests, groups A/C/D; sealer proven behaviorally via shared `_sealFields`).
- **P2 RED:** `test/data/ledger/chain_seal_whitelist_test.dart` — 9 tests, 7 RED (confirms the missing-`original_hash` regression).
- **P3 GREEN:** `chain.dart` `_sealFields` = `{type, day_index, date, prev_hash, entries, original_hash}`; `_sealBlock`/`_verifyBlockSeal` share the table; `original_hash` optional-if-present. **9/9 GREEN.**
- **P4 REFACTOR:** 3-way JSON fallback kept; docstrings corrected (no longer misstate 5-field); no `format_version`/`key_version`/`identity_seal`/hash-key sealing.
- **No new regressions:** `test/data` failure set unchanged (pre-existing `chain_test` K2/K3/K4, `engine_test` F15/AE2/AE4, `sync_service_test`, flaky `restore_integration`).

**Ph-2 Web P1/P2/P3/P4 (current session):**
- **P1 blueprint** — `docs/planning/CANONICAL_SEALFIELD_WEB_PHASE1.md`: 27 assertions across A–E. Records the latent Web exclusion bug (open-set minus `{hashKey, identity_seal, signature}` → seals `format_version`/`key_version`/stray fields) the closed whitelist fixes.
- **P2 RED (prior)** — `chain_seal_whitelist_test.mjs`: 14 RED. **P3 GREEN (prior): 28/28** — new `seal_fields.js` (`SEAL_FIELDS`/`selectSealFields`/`computeSeal`); routed all Web sealers/verifiers (`chain.js`, `merge.js`, `summary_policy.js`) through it; genesis seal excludes `identity` (matches Python).
- **P4 REFACTOR (this session)** — deduped leftover open-set `checkData` builders in `sync.js` (genesis + per-block diagnostics) and `genesis_gate.js` (genesis tamper-recompute) through the shared `selectSealFields` whitelist. **Confirmed no `format_version`/`key_version` sealing.** **Kept legacy-tolerant (reverted):** `export_auth.js` `_verifyGenesisSeal` + `ledger_import.js` (verify legacy open-set-sealed ledgers; backward-compat exception like `remote_import.js`/`DevModeContext.jsx`). Suites stay GREEN; `sync_service_test` count unchanged (42 pre-existing); `ledger_merge_test` still RED at block 1 (pre-existing).

**Ph-1 Python P4 (prior session) — done:**
- Routed remaining inline `crypto.seal(json.dumps(select_seal_fields(...), sort_keys=True))` sites through `compute_seal`: `auth.py`, `onboarding.py` (genesis + loop), `onboarding_file.py` (genesis + loop), `rotate_keys.py` (passes `crypto_v2` as first arg), `migrate_format.py:_seal_block`. Cleaned now-unused imports + a redundant `check_data` var in onboarding.py.
- **This session (final pass):** also routed `core/factory.py` genesis seal and `chain.py` `create_day` day seal through `compute_seal` — every synchronous block sealer now uses the single entry point. Merge.py seal uses keep `inspect.iscoroutinefunction` dispatch and stay on `select_seal_fields` (async-safe); verify/recompute sites in chain.py/migrate/rotate_keys keep `select_seal_fields` for check-data clarity.
- **Exception (unchanged):** `migrate.py` `_seal(..., integrity_key)` uses a per-chain integrity key — documented in plan, not `compute_seal`.
- **Full Python suite GREEN: 2475 passed, 1 skipped / 0 failures** (re-verified after final consolidations).

### ✅ CCS-4 Cross-client E2E testing — Phases 1–4 ✅ COMPLETE
- `test_ccs4_cross_client.py` 20/20 + live Worker 5/5; Python suite 2560 pass/1 skip/0 fail. Converged canonical compact activity JSON in `row_merge.py` (`_canonical_json()` P4 helper); JS `entry_dto.js` block_index + `row_sync.js` deterministic sort; no Flutter change (Dart `json.encode` already compact). Docs `docs/planning/CCS4_PHASE{1,2,3,4}.md`; backlog ✅.

### 🔜 Queued
- **Staging Auto-Sync:** bidirectional `checkAndSync()` — `docs/planning/STAGING_AUTO_SYNC_PLAN.md`

## ✅ Ph-4 Migrator (Canonical Seal-Field plan Phase 4) — Phases 1–4 COMPLETE
- **P1 blueprint** — `docs/planning/CANONICAL_SEALFIELD_MIGRATOR_PHASE1.md` (26 assertions A–F).
- **P2 RED** — `TestMigrateFormatSealWhitelist`; 2 RED (F1/F2 unknown-type corrupting write).
- **P3 GREEN** — `execute()` pre-validation loop rejects unknown/unsealable types (`_block_hash_key is None` → `ValueError`) BEFORE backup/write; input ledger stays byte-identical on failure (no-op atomicity). `TestMigrateFormatSealWhitelist` **26/26**; file **43/43**.
- **P4 REFACTOR** — dropped unused `hash_key` param from `_seal_block` (never reached `compute_seal`); extracted `_preserve_and_strip` unifying 3 per-branch hash-strip loops in `execute()`; `_block_hash_key` → `dict.get` table, kept as strict unknown-type gate (NOT `chain._hash_key_for_block`, which defaults to `day_hash`). Sealer already shared (`_seal_block` → `compute_seal`). Doc `CANONICAL_SEALFIELD_MIGRATOR_PHASE4.md`. **Full suite 2586 pass / 1 skip / 0 fail — no regressions.**

### ✅ Completed: CCS-3 — CLI Sync-Gate Wiring → Phases 1–4 ✅
- `tests/test_cli_sync_gate_wiring.py` **60/60**; Python suite 2535 pass/1 skip/0 fail. P3: `row_merge.py` DTO↔canonical-row, `merge_rows`, `StagingHashIndex`, `_merge_remote_into_local`, LocalStagingCache row-mode. P4: extracted `_resolve_device_id()`/`_remote_entries_to_dtos()`. Backlog §CCS-3 ✅.

### ✅ Completed: CCS-2 — Web Row-Level Sync (Option B) → Phases 1–4 ✅
- `ccs2_row_level_reconcile_test.mjs` **41/41**; web suite no new regressions. P3 `mergeRows` (activity_id LWW) + `dtoToCanonicalRow` + legacy bridge + C2 fast-path; P4 `_mergeRemoteIntoLocal()`/`_rowsFromRemoteBlob()`. Backlog §CCS-2 ✅.

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
- Pre-existing Web red (unchanged): `ledger_merge_test` (block-1 entry-hash), `import_entries_test`, `genesis_gate_test`; `sync_service_test` 42 red
- 2 pre-existing `restore_integration` flaky tests (G3, G8) — pass in isolation, fail in full suite
- `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — old-path zombie. Remove after legacy path cleanup.
- **🟢 `verify()` after cloud restore** — FIXED (Plan B: RC1–RC3 resolved). See `docs/planning/VERIFY_RESTORE_FIX_PLAN_B.md`.
