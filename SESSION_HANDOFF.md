# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed history:** `docs/planning/archive/SESSION_HISTORY_2026-07-04.md`

## Current State
- **Branch:** `mobile-poc`
- **CLI:** 1609/1609 PY tests pass  |  **Web:** 750 JS tests pass (495 staging + 255 sync)  |  **Worker:** 48 vitest tests pass
- **Chain integrity fixes (Jul 5):** ✅ 4 gaps closed
- **Staging Activity ID (Jul 7):** ✅ Phase 3 core done; ⏸️ hash index tests removed (4 files + 32 stubs) — superseded by SQLite row-level DB model

## Discussion Summary — Staging DB Model Exploration (Jul 7)

Explored converting the staging area from a single JSON blob to a row-per-activity SQLite database. Key findings documented in `docs/planning/STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md` §"Future Direction":

- **SQLite is stdlib** — zero-dependency for CLI, same as `json`/`hashlib`
- **Three-column schema:** `activity_id` (PK), `activity_status` (plaintext), `activity` (obfuscated entry blob)
- **Hash index becomes redundant** — `SELECT activity_id, activity_status FROM staging` IS the hash index. Entire `staging_hash_index.js` (~200 lines) + Tier 1/Tier 2 infrastructure goes away.
- **Sync payloads shrink 100×+** — pull only changed rows (~300–800 bytes) instead of 64KB–512KB padded blob
- **Content changes caught** — per-row versioning detects tag edits, title changes, etc. that the current status-only hash index misses
- **Trade-offs identified:** per-row encryption overhead on bulk reads, privacy regression (exposed entry count), Worker protocol redesign needed
- **Current Phase 3 hash index work is still valid near-term** — the DB model is a future architectural shift that supersedes it

## Immediate Next Steps (Jul 7)
0. **✅ Phase 1 complete** — 116-test catalog.
1. **✅ Phase 2 — RED:** 5 test files, 116 RED stubs.
2. **✅ Phase 3 — GREEN (core):** New modules + wiring. **527/527 staging tests pass.**
3. **✅ Workflow spec written** — `docs/planning/STAGING_HASH_INDEX_WORKFLOW.md`
4. **✅ Sync logic design complete** — See ADR-025 (`docs/design/ARCHITECTURAL_DECISIONS.md`) and implementation plan (`docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md`). 8-scenario LWW resolution table, sync cycle contract (5 phases), Worker endpoint spec, per-row obfuscation format, push guard (409 Conflict).
5. **🔜 Worker protocol redesign** (implements the sync logic contract):
   - `GET /storage/staging/manifest` → `{rows: [{activity_id, activity_status, updated_at}], version}` for diff detection
   - `GET /storage/staging/rows/{activity_id}` → single obfuscated row
   - `PUT /storage/staging/rows/{activity_id}` → push single obfuscated row with `updated_at` guard (409 Conflict)
   - `DELETE /storage/staging/rows/{activity_id}` → remove row + update manifest
   - Define per-row obfuscation format: per-row key derivation, encryption, plaintext `updated_at`
6. **🔜 Web: Worker ↔ IndexedDB row-level staging** — Direct IndexedDB object store with `activity_id` key path. Migrate from single `'entries'` blob. Implement sync logic per `ROW_LEVEL_STAGING_SYNC_PLAN.md`.
7. **🔜 CLI: SQLite staging store** — `SqliteStagingStore` with three-column schema (`activity_id`, `activity_status`, `activity`). Migrate from `staging.json`. Implement sync logic per `ROW_LEVEL_STAGING_SYNC_PLAN.md`. All 1609 Python tests must pass.
8. **🔜 Fix the broken chain:** `python3 scripts/fix_chain_genesis_link.py`
9. **🔜 Verify CLI onboarding**
10. **🔜 Verify web onboarding**
11. **🔜 Clean up diagnostics + Run test suites**

## Files Created (Phase 3)
| File | Purpose |
|---|---|
| `phpoc-web/src/sync/activity_id.js` | `generateActivityId()` — 10-char CSPRNG alphanumeric IDs |
| `phpoc-web/src/sync/staging_hash_index.js` | `buildStagingHashIndex()`, `compareStagingHashIndexes()`, `computeHashForIndex()` — ⏸️ future: superseded by SQLite row-level DB model |

## Files Modified (Phase 3)
| File | Change |
|---|---|
| `phpoc-web/src/sync/keys.js` | Added `REMOTE_STAGING_HASH_INDEX`, `REMOTE_STAGING_HASH_INDEX_SHA256`, `LOCAL_STAGING_HASH_INDEX` |
| `phpoc-web/src/sync/local_cache.js` | Constructor accepts injectible `generateId`; `append()` assigns `activity_id`; `_rawToDto()`/`_dtoToRaw()` preserve it; `readHashIndex()`/`writeHashIndex()`/`_refreshHashIndex()` for hash index persistence |
| `phpoc-web/src/sync/sync.js` | `_pushStagingHashIndex()` pushes encrypted index + sha256 after blob push; `_pullAndCacheStagingHashIndex()` pulls + decrypts + caches; wired into `pushToRemote`, `pushBlobOnly`, `_reconcileDifferentDevice`, `clearRemote` |

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
- **Worker:** `https://phpoc-staging-testing.wacevedo.workers.dev`
- **E2E test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`, API key `ZfkbMrrdRaY7DeoanY1GqQAOSLDmI6gO`
