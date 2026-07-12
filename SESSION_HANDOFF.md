# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed history:** `docs/planning/archive/SESSION_HISTORY_2026-07-04.md`

## Current State
- **Branch:** `mobile-poc`
- **CLI:** 1722 PY tests pass (1610 core + 104 SQLite staging)  |  **Web:** 750 JS tests pass  |  **Worker:** 104 vitest tests pass
- **Chain integrity fixes (Jul 5):** ✅ 4 gaps closed
- **Staging Activity ID (Jul 7):** ✅ Phase 3 core done; ⏸️ hash index tests removed (4 files + 32 stubs) — superseded by SQLite row-level DB model

## Discussion Summary — Staging DB Model Exploration (Jul 7)

Explored converting the staging area from a single JSON blob to a row-per-activity SQLite database. Key findings documented in `docs/planning/STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md` §"Future Direction":

- **SQLite is stdlib** — zero-dependency for CLI, same as `json`/`hashlib`
- **Three-column schema:** `activity_id` (PK), `activity_status` (plaintext), `activity` (obfuscated entry blob)
- **Hash index becomes redundant** — `SELECT activity_id, activity_status FROM staging` IS the hash index. Entire ~200 lines + Tier 1/Tier 2 infrastructure goes away.
- **Sync payloads shrink 100×+** — pull only changed rows (~300–800 bytes) instead of 64KB–512KB padded blob; content changes caught — per-row versioning detects tag edits, title changes, etc. that the current status-only hash index misses
- **Trade-offs identified:** per-row encryption overhead on bulk reads, privacy regression (exposed entry count), Worker protocol redesign needed
- **Current Phase 3 hash index work is still valid near-term** — the DB model is a future architectural shift that supersedes it

## Immediate Next Steps
0. **✅ Phase 1–3 complete** — Staging activity_id + hash index. **527/527 staging tests pass.**
1. **✅ Sync logic design complete** — ADR-025 + `ROW_LEVEL_STAGING_SYNC_PLAN.md`.
2. **✅ Worker protocol redesign — Phase 1 (test exploration)** — 54 test assertions documented across 5 groups.
3. **✅ Worker protocol redesign — Phase 2 (RED)** — `worker/test/row_level_endpoints.test.ts` created with 55 tests.
4. **✅ Worker protocol redesign — Phase 3 (GREEN)** — 4 new endpoints implemented in `worker/src/index.ts`. **104/104 tests pass** (55 new + 48 existing).
   - `GET /storage/staging/manifest` → `{rows: [...], version: N}`
   - `GET /storage/staging/rows/{activity_id}` → row JSON or 404
   - `PUT /storage/staging/rows/{activity_id}` → 200 | 400 (validation) | 409 (push guard)
   - `DELETE /storage/staging/rows/{activity_id}` → 200 | 404
   - Deployed to `https://phpoc-staging-testing.wacevedo.workers.dev`
5. **✅ Phase 4 (REFACTOR) complete** — Extracted to `worker/src/row_level_staging.ts`; `index.ts` is now a thin router. ACTIVITY_ID_RE tightened to 10-20 chars per spec. Worker AGENTS.md updated. 104/104 tests pass.
6. **✅ Web: Worker ↔ IndexedDB row-level staging — Phase 3 complete (GREEN)** — `RowStagingStore`, `buildDiff`, `RowSyncWorker`, and `migrateBlobToRows` implemented. **254/254 tests pass** (52 store + 132 sync + 70 integration).
7. **✅ CLI: SQLite staging store — Phase 2 (RED) complete** — `tests/test_sqlite_staging.py` with 104 tests across 10 groups (A–J). All RED (skipped — modules not implemented).
7a. **✅ CLI: SQLite staging store — Phase 3 (GREEN)** — `SqliteStagingStore`, `buildDiff()`, `migrate_staging_to_sqlite()` implemented. **104/104 tests pass.**
7b. **✅ CLI: SQLite staging store — Phase 4 (REFACTOR) complete** — 6 improvements across 3 files: extracted _normalize_core(), unified _insert_row/_insert_row_in_tx, extracted _safe_ts(), narrowed except, simplified activity_blob. 104/104 tests pass.
8. **🔜 Verify CLI onboarding from existing R2/Worker** — import existing ledger, confirm sync with Worker (`https://phpoc-staging-testing.wacevedo.workers.dev`)
9. **🔜 Verify CLI onboarding (ph init fresh ledger)**
10. **🔜 Verify web onboarding**
11. **🔜 Clean up diagnostics + Run test suites**
12. **⏸️ Fix the broken chain:** `python3 scripts/fix_chain_genesis_link.py` (deprioritized — new ledger started)

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

## Files Modified (Phase 3 + 4)
| File | Change |
|---|---|
| `phpoc-web/src/sync/keys.js` | Added REMOTE_STAGING_HASH_INDEX, SHA256, LOCAL |
| `phpoc-web/src/sync/local_cache.js` | activity_id support, hash index persistence |
| `phpoc-web/src/sync/sync.js` | Push/pull staging hash index, genesis collision guard |
| `worker/src/index.ts` | Slimmed to thin router |
| `worker/AGENTS.md` | Updated for row-level staging endpoints |

## Chain Integrity Fixes (Jul 5) ✅

**Problem:** R2 chain had blocks from two genesis blocks. CLI rejected, web silently accepted. **Root:** Genesis collision on push — skipped genesis (fileIdx=0 existed) but pushed day blocks (indices 1+) from different chain. **4 fixes:** enumeration order (`sync.js`), prev_hash verification (`DevModeContext.jsx`, `chain.js`), genesis collision guard (`sync.js`). Files: `sync.js`, `chain.js`, `DevModeContext.jsx`, `remote_sync.py`.

## Known Issues
- **CLI read commands block on specifier mismatch** (Python-side, not web)
- **Pre-existing test failures** — `ledger_sync_test.mjs` (A3c), `commit_push_integration_test.mjs`
- **Diagnostic logging** in `remote_sync.py` `_verify_chain` — remove after chain is fixed

## Test Ledger Credentials

- **Active Browser Ledger (William Acevedo)**
  - Passphrase: `VZQKp6TrIBK/GUtsjoof75HRyzd7w8S0`
  - Recovery Seed: `Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=`
  - Username: `William Acevedo` | Email: `william.acevedo@gmail.com`

## Browser E2E Setup

- **Browser:** Vivaldi `--remote-debugging-port=9222`. Connect: `agent_browser connect 9222` with `sessionMode: "fresh"`
- **Tab rule:** `tab list` → find `localhost:5173` → `tab t<N>`. Do NOT open new tabs.
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Workers:**
  - **Testing:** `https://phpoc-staging-testing.wacevedo.workers.dev` — API key `iXCjwoA9sBXPg3mP5Fi9uew+7ZctkcMi`
  - **Production (personal):** `https://phpoc-staging.wacevedo.workers.dev` — do not use for testing
- **E2E test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
