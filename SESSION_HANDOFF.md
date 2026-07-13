# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed history:** `docs/planning/archive/SESSION_HISTORY_2026-07-04.md`

## Current State
- **Branch:** `mobile-poc`
- **CLI:** 1719 PY tests pass (2 flaky: staging service timeout ordering)  |  **Web:** 51 JS suites pass, 9 fail (pre-existing)  |  **Worker:** 104 vitest tests pass
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
0–11. **✅ Archived** — See `docs/planning/archive/SESSION_HISTORY_2026-07-13.md`
12. **✅ Clean up diagnostics + Run test suites** — Completed 2026-07-13
13. **⏸️ Fix the broken chain** (deprioritized — new ledger started)

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
- **Deduplication bug in SyncOrchestrator** — ✅ FIXED. `_deduplicate_from_remote_ledger` used `entry.get("entry_index")` on raw store entries that lack the field → `None` → `remove_entries(0 <= None)` TypeError. Fixed by using `enumerate()` on the store list. 5 new tests, 55/55 pass.

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
