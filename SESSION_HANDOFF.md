# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed history:** `docs/planning/archive/SESSION_HISTORY_2026-07-04.md`

## Current State
- **Branch:** `mobile-poc`
- **CLI:** 1787 PY tests pass (2 flaky: staging service timeout ordering)  |  **Web:** 51 JS suites pass, 9 fail (pre-existing)  |  **Worker:** 104 vitest tests pass
- **Chain integrity fixes (Jul 5):** ✅. **Staging Activity ID (Jul 7):** ✅ Phase 3 core done; ⏸️ hash index superseded by SQLite DB model.

## Immediate Next Steps
0–14. **✅ Archived** — See `docs/planning/archive/SESSION_HISTORY_2026-07-13.md`
13. **⏸️ Fix the broken chain** (deprioritized — new ledger started)
14. **✅ Fix CLI staging/ledger reconciliation for cross-platform commits** — Completed 2026-07-13
15. **🔜 CLI command timing fixes (F1–F4)** — `docs/planning/CLI_COMMAND_TIMING_FIXES.md`
    - F1: Remove duplicate `check_and_sync` call (~3.6s savings) — **✅ Done (Phases 1–4)**
    - F2: Persistent cache for remote ledger blocks (~5.5s savings) — **✅ Done (Phases 1–4)** (P4: extracted `_refresh_remote_ledger_cache()` + combined condition)
    - F3: Skip blob push when staging unchanged (~1.2s savings) — **✅ Done (Phases 1–4)** (P4: extracted `_push_hash_path` property, `_update_push_hash()` method)
    - F4: HTTP connection pooling + reduced timeouts (~2–3s savings)
    - Execute in order F1→F4 with 4-phase TDD per fix
16. **✅ Sync tab: explicit "Save Changes" button for activity cards** — Completed 2026-07-14
17. **✅ F2 Phase 4 (REFACTOR)** — Completed 2026-07-14
    - Extracted `_refresh_remote_ledger_cache()` from `_sync_remote_ledger_and_dedup()` (~45 lines → 3-line call site)
    - Combined `if not block` + type-check into single condition
    - All 1766 tests pass, zero regressions
18. **✅ F3 Phase 3 (GREEN)** — Completed 2026-07-14. 
19. **✅ F3 Phase 4 (REFACTOR)** — Completed 2026-07-14
    - Extracted `_push_hash_path` property (deduplicated path construction ×3)
    - Extracted `_update_push_hash()` method (deduplicated hash-compute+save from `push_to_remote`/`push_blob_only`)
    - All 1787 tests pass, zero regressions
    - **Next:** F4 (HTTP connection pooling + reduced timeouts)

## Files Created (Completed Work)
| Phase | File | Purpose |
|---|---|---|
| Web P2 | `test/row_staging_store_test.mjs` | 49 tests (RowStagingStore CRUD) |
| Web P2 | `test/row_sync_test.mjs` | 134 tests (buildDiff + RowSync HTTP) |
| Web P2 | `test/row_integration_test.mjs` | 70 tests (Migration + Integration) |
| Web P3 | `src/sync/row_staging_store.js` | IndexedDB CRUD + transport interface |
| Web P3 | `src/sync/row_sync.js` | buildDiff() LWW + RowSyncWorker |
| Web P3 | `src/sync/migration.js` | migrateBlobToRows() |
| Web P3 | `src/sync/activity_id.js` | generateActivityId() |
| Web P3 | `src/sync/staging_hash_index.js` | ⏸️ superseded by SQLite DB model |
| Worker P2 | `test/row_level_endpoints.test.ts` | 55 integration tests |
| Worker P4 | `src/row_level_staging.ts` | Types, validation, 4 HTTP handlers |
| CLI P1 | `docs/planning/CLI_SQLITE_STAGING_PHASE1.md` | 104 assertions, 10 groups A–J |
| CLI P2 | `tests/test_sqlite_staging.py` | 104 RED tests (Groups A–J) |
| CLI P3 | `storage/implementations/sqlite_staging.py` | SqliteStagingStore (+AbstractStagingStore + row-level ops) |
| CLI P3 | `core/sync/diff_engine.py` | buildDiff() + DiffResult (Python port of JS) |
| CLI P3 | `scripts/migrate_staging.py` | migrate_staging_to_sqlite() |
| Docs | `docs/planning/WEB_ROW_LEVEL_TESTS_PHASE1.md` | 120 assertions, 5 groups |
| Docs | `docs/planning/WORKER_ROW_LEVEL_TESTS_PHASE1.md` | 54 assertions, 5 groups |
| CLI-F1 P1 | `docs/planning/CLI_COMMAND_TIMING_F1_PHASE1.md` | 23 assertions, 6 groups A–F |
| CLI-F1 P2 | `tests/test_cli_interface.py` | 24 tests, 6 groups — all GREEN ✅ |
| CLI-F2 P1 | `docs/planning/CLI_COMMAND_TIMING_F2_PHASE1.md` | 23 assertions, 6 groups A–F |
| CLI-F2 P2 | `tests/test_cli_interface.py` | 23 tests, 6 groups — all GREEN ✅ |
| CLI-F3 P1 | `docs/planning/CLI_COMMAND_TIMING_F3_PHASE1.md` | 21 assertions, 6 groups A–F |
| CLI-F3 P2 | `tests/test_staging_sync_optimization.py` | 21 tests (12 RED, 9 GREEN) — `TestF3SkipBlobPush` class |

## Files Modified (Phase 3 + 4)
| File | Change |
|---|---|
| `phpoc-web/src/sync/keys.js` | Added REMOTE_STAGING_HASH_INDEX, SHA256, LOCAL |
| `phpoc-web/src/sync/local_cache.js` | activity_id support, hash index persistence |
| `phpoc-web/src/sync/sync.js` | Push/pull staging hash index, genesis collision guard |
| `worker/src/index.ts` | Slimmed to thin router |
| `worker/AGENTS.md` | Updated for row-level staging endpoints |
| `cli/interface.py` | F1 P3: Auto-handle REAUTH_NEEDED. F1 P4: Extract `_rebuild_after_reauth()`. F2 P3: `_RemoteLedgerCache` persistent cache + refactored `_sync_remote_ledger_and_dedup` + cache invalidation in `_rebuild_after_reauth`. F2 P4: Extract `_apply_cached_ledger_data()` + `_get_remote_ledger_cache_path()`, deduplicate cache path + reconstruct/apply blocks |
| `domain/staging/service.py` | F3 P3: Hash helpers, hash-skip in `_push_on_fast_path`, hash save in `push_blob_only`/`push_to_remote`, monotonic `_touch_local_cookie`, non-serialisable fallback, `device_uuid` in `_raw_entry_to_dto`. F3 P4: Extracted `_push_hash_path` property + `_update_push_hash()` method |
| `domain/staging/local_cache.py` | F3 P3: `end_device_uuid_enc` in `append()` for format consistency |
| `tests/test_staging_sync_optimization.py` | F3 P3: `_hash_of_entries` sorts by `start_epoch` |
| `main.py` | F1 P3: Removed duplicate `check_and_sync` + re-auth blocks from `view`, `list active`, `list all|synced|staged` handlers; set `cli._auth = auth`; moved `list` handler after `revert` |

## Chain Integrity Fixes (Jul 5) ✅

**Problem:** R2 chain had blocks from two genesis blocks. CLI rejected, web silently accepted. **Root:** Genesis collision on push — skipped genesis (fileIdx=0 existed) but pushed day blocks (indices 1+) from different chain. **4 fixes:** enumeration order (`sync.js`), prev_hash verification (`DevModeContext.jsx`, `chain.js`), genesis collision guard (`sync.js`). Files: `sync.js`, `chain.js`, `DevModeContext.jsx`, `remote_sync.py`.

## Known Issues
- **CLI read commands block on specifier mismatch** (Python-side, not web)
- **Pre-existing test failures** — `ledger_sync_test.mjs` (A3c), `commit_push_integration_test.mjs`
- **Deduplication bug in SyncOrchestrator** — ✅ FIXED.
- **CLI staging/ledger reconciliation for cross-platform commits** — ✅ FIXED. When phpoc-web committed entries to the ledger and synced to R2, `ph list all` showed them as "(Staged)" because `_sync_before_command` only synced the staging blob (not ledger blocks) and the local ledger was stale. Fixed by adding `_sync_remote_ledger_and_dedup()` to `_sync_before_command`: pulls remote ledger blocks by index (no chain verification), cross-references staging against committed (date, title) pairs, removes matches. Also displays cached remote entries in `list_habits` synced section via `_remote_ledger_cache`. File: `cli/interface.py`.

## Test Ledger Credentials

- **Active Browser Ledger (William Acevedo)**
  - Passphrase: `VZQKp6TrIBK/GUtsjoof75HRyzd7w8S0`
  - Recovery Seed: `Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=`
  - Username: `William Acevedo` | Email: `william.acevedo@gmail.com`

## Browser E2E Setup

- **Browser:** Vivaldi via `agent_browser` with `sessionMode: "fresh"` and `--executable-path "/usr/bin/vivaldi-stable"` (Vivaldi not started with `--remote-debugging-port`)
- **Tab rule:** `tab list` → find `localhost:5173`. Do NOT open new tabs.
- **Active tab:** `t1` (localhost:5173) — reused across sessions
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Workers:**
  - **Testing:** `https://phpoc-staging-testing.wacevedo.workers.dev` — API token in `TEST_CREDENTIALS.md` (gitignored)
  - **Production (personal):** `https://phpoc-staging.wacevedo.workers.dev` — do not use for testing
- **E2E test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
- **R2 test ledger (E2ETest):** passphrase `E2EPass123!`, seed `fK0kCIjLAzFTmHmE6XaD/Y+YfRyBVQ07dG8DaVRtS+4=`
