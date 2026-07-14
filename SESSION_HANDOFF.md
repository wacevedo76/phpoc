# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed history:** `docs/planning/archive/SESSION_HISTORY_2026-07-04.md`

## Current State
- **Branch:** `mobile-poc`
- **CLI:** 1743 PY tests pass (2 flaky: staging service timeout ordering)  |  **Web:** 51 JS suites pass, 9 fail (pre-existing)  |  **Worker:** 104 vitest tests pass
- **Chain integrity fixes (Jul 5):** ✅ 4 gaps closed
- **Staging Activity ID (Jul 7):** ✅ Phase 3 core done; ⏸️ hash index tests removed (4 files + 32 stubs) — superseded by SQLite row-level DB model

## Discussion Summary — Staging DB Model Exploration (Jul 7)

Explored converting staging area from JSON blob to row-per-activity SQLite. Key findings in `docs/planning/STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md` §"Future Direction". Current hash index work valid near-term; DB model is a future architectural shift.

## Immediate Next Steps
0–11. **✅ Archived** — See `docs/planning/archive/SESSION_HISTORY_2026-07-13.md`
12. **✅ Clean up diagnostics + Run test suites** — Completed 2026-07-13
13. **⏸️ Fix the broken chain** (deprioritized — new ledger started)
14. **✅ Fix CLI staging/ledger reconciliation for cross-platform commits** — Completed 2026-07-13
15. **🔜 CLI command timing fixes (F1–F4)** — `docs/planning/CLI_COMMAND_TIMING_FIXES.md`
    - F1: Remove duplicate `check_and_sync` call (~3.6s savings) — **✅ Done (Phases 1–4)**
    - F2: Persistent cache for remote ledger blocks (~5.5s savings)
    - F3: Skip blob push when staging unchanged (~1.2s savings)
    - F4: HTTP connection pooling + reduced timeouts (~2–3s savings)
    - Execute in order F1→F4 with 4-phase TDD per fix

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
| CLI-F1 P2 | `tests/test_cli_interface.py` | 24 tests, 6 groups — 11 RED, 13 GREEN |

## Files Modified (Phase 3 + 4)
| File | Change |
|---|---|
| `phpoc-web/src/sync/keys.js` | Added REMOTE_STAGING_HASH_INDEX, SHA256, LOCAL |
| `phpoc-web/src/sync/local_cache.js` | activity_id support, hash index persistence |
| `phpoc-web/src/sync/sync.js` | Push/pull staging hash index, genesis collision guard |
| `worker/src/index.ts` | Slimmed to thin router |
| `worker/AGENTS.md` | Updated for row-level staging endpoints |
| `cli/interface.py` | F1 P3: Auto-handle REAUTH_NEEDED in `_sync_before_command(require_auth=False)`. P4: Extract `_rebuild_after_reauth()` helper, simplify auto-handle block |
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
