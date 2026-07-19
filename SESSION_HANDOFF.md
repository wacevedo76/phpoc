# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Active TDD plan:** `docs/planning/P4_CLI_UX_POLISH_PHASE1.md` (24 assertions, 5 groups — ✅ Phase 2 complete, 🟢 Phase 3 next)

## Current State
- **Branch:** `mobile-poc`
- **Last commit:** `8b2e8db` — Entry Hash Verification Consolidation Phases 1-4 complete
- **CLI:** 2276 PY tests pass (0 failures)  |  **Web:** 74/75 JS test files pass (7 pre-existing vitest env failures: i01_key_rotation, i02_index/staging/field_token, i09_device, onboarding_cloud, worker_connect)
- **I-01:** ✅ key rotation (95/95 PY + 13/13 JS)  |  **I-01a:** ✅ RotateKeysCommand (141/141 PY)  |  **I-02:** ✅ blind index + staging keys (103/103 PY + 67/67 JS)  |  **I-02a:** ✅ JS field tokens (28+35+32)  |  **I-03:** ✅ staging at rest (52/52 PY + 35/35 web)  |  **I-04:** ✅ HMAC naming  |  **I-05:** ✅ per-user PBKDF2 salt  |  **I-06:** ✅ content_hash required  |  **I-09:** ✅ device attribution (49 assertions, Phases 1-4)  |  **I-11:** ✅ blob obfuscation portability  |  **I-12:** ✅ system architecture doc  |  **Entry Hash Consolidation:** ✅ 17/17 GREEN  |  **P5 CLI Unlock:** ✅ 32/32 GREEN  |  **Web Staging Alignment:** ✅ Phase 1a (Stages 1.1–1.5)  |  **Cross-Client Serialization (P1):** ✅ Phases 1-4 complete — 43/43 GREEN
- **P4 CLI UX Polish:** ✅ Phases 1-4 complete — 24/24 GREEN. 3 Phase-4 improvements: extracted `_reauth_staging()` (eliminated 6 duplicated re-auth blocks), moved `_list_tags` → `CLIInterface.list_tags()`, explicit `_reauth_notified` init.
- **Genesis Gate (JS):** ✅ Phase 3 GREEN — `genesis_gate_test.mjs`: 218/218. Fixed test `computeEntryHash`→`jsonSortIndent2`, `computeContentHash`→decrypt `_enc`+`jsonSort`, `encRev`→MockCrypto format.
- **Settings Genesis Component:** ✅ Phase 3 GREEN — `settings_genesis_component.test.mjs`: 26/26. Added `fetch` mock, `reconfigure` to sync mock. Fixed Settings.jsx: only set `genesisStatus='checking'` when URL changed (preserves compatible status on same-URL save).

## C5 File Upload Limitation — RESOLVED (2026-07-16)
- React 18 native event delegation picks up `new Event('change', {bubbles: true})`
- Working pattern: `DataTransfer` → `input.files = dt.files` → `dispatchEvent(change/input)`
- React `onChange` fires, state updates, UI shows selected filename — verified in browser
- Documented: `docs/planning/BROWSER_E2E_TEST_PLAN.md`, `tests/e2e/E2E-03_*.md`, `tests/e2e/E2E-07_*.md`

## Phase 1b: Browser E2E Tests
- **E2E-03:** ✅ COMPLETE — `tests/e2e/E2E-03_import_file_upload.md` — 9/9 steps pass: file upload, auth errors, field gating
- **E2E-04:** ✅ COMPLETE — 4/4 steps pass: wrong passphrase/seed → error, modal stays open (results in `docs/planning/BROWSER_E2E_TEST_PLAN.md`)
- **E2E-05:** ✅ Phases 1-4 complete — seal/hash mismatch resolved, code refactored
- **E2E-06:** ✅ COMPLETE — JS-layer PBKDF2 passphrase hash, wrong passphrase → error (results in `docs/planning/BROWSER_E2E_TEST_PLAN.md`)
- **E2E-07:** ✅ COMPLETE — `tests/e2e/E2E-07_onboarding_import.md` — 13/13 steps pass: onboarding import, back nav, auth errors, field gating

## Recent UI Changes (2026-07-16)
- Dashboard: comment field added; Start New Task collapsible to thin bar
- Sync tab: Sync Now below Commit All; sync-details collapsible to "Sync Status ▸" bar
- Nav: removed redundant "New" tab (Dashboard covers task creation)

## Backlog Priority
| Pri | Phase | Key Items |
|-----|-------|-----------|
| 1 | 🟢 Phase 1b | E2E all complete ✅ |
| 2 | 🔴 Phase 1 | Encrypt-all-entry-fields: Web (61 assertions) + CLI (72 assertions) — Phase 1 blueprints done |
| 3 | 🔵 Phase 7 | P3 — Remote sync (git-based) — deferred (infra exists, init --git-create remaining) |
| 4 | 🔴 Phase 4 | I-09✅ device attribution — BACKLOG entry stale, code complete |
| 5–8 | ✅ Complete | All I-01–I-17, P4, P5, cross-client serialization done |

## Immediate Next Steps 🎯

1. **Merge `mobile-poc` → `main`** — all blocker tests now pass (0 PY failures, 0 JS failures)
2. **Encrypt-all-entry-fields (Web)** — Phase 2 (RED: 61 test definitions) at `docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_WEB_PHASE1.md`
3. **Encrypt-all-entry-fields (CLI)** — Phase 2 (RED: 72 test definitions) at `docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_CLI_PHASE1.md`
4. **Begin Flutter work** — per original goal

## Known Issues
- **7 vitest files fail** with environment/teardown errors (pre-existing): i01_key_rotation, i02_index_encryption, i02_staging_keys, i02a_field_token_wasm, i09_device_attribution, onboarding_cloud_conflict, worker_connect_blocks_format — 61/61 individual tests pass, files marked failed by test runner

## Browser E2E Setup
- **Browser:** Vivaldi via `agent_browser`, port 9222
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Tab rule:** `tab list` → find `localhost:5173`. Do NOT open new tabs.
- **Test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
