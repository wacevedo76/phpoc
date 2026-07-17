# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **TDD plan:** `docs/planning/P5_CLI_UNLOCK_LATENCY_PHASE1.md` (32 assertions, 6 groups — ✅ Phase 1-4 complete)
> **Active TDD plan:** `docs/planning/ENTRY_HASH_CONSOLIDATION_PHASE1.md` (17 assertions, 4 groups — 🔴 Phase 2)

## Current State
- **Branch:** `Staging_migration`
- **Last commit:** `cb3b0af` — promote E2E-05 seal/hash mismatch to top of task queue
- **CLI:** 2135 PY tests pass (1 pre-existing date-sensitive failure, 20 pre-existing Worker HTTP 403). 6 RED tests in `test_entry_hash_consolidation.py` (expected — Phase 2)  |  **Web:** 70/75 JS test files pass (5 pre-existing RED-phase failures: genesis_gate, onboarding_import_component, reauth_overlay, settings_genesis_component, vitest-setup)  |  **Cross-Client Serialization:** ✅ Phase 1-4 complete — 43/43 assertions GREEN. 3 Phase-4 improvements: extracted `compute_entry_hash()` to `helpers.py` (single source of truth), JS `jsonSortIndent2()` eliminates double serialization, clarified `_verify_single_block` docstring.  |  **I-03:** ✅ Phase 1-4 complete — 52/52 PY + 35/35 web GREEN  |  **I-02:** ✅ Phase 1-4 complete — 103/103 PY + 67/67 JS all GREEN  |  **I-02a:** ✅ Phase 1-4 complete — 28/28 field token WASM + 35/35 staging keys + 32/32 index encryption all GREEN; 3 Phase-4 improvements: extracted `_applyFieldsToData()`, clarified `_encrypt()` guard + `_fieldTokenCache` lifetime  |  **I-01:** ✅ Phase 1-4 complete — 95/95 PY + 13/13 JS all GREEN; 5 Phase-4 improvements: hoisted `genesis_kv` in chain `verify()`, simplified redundant `require_content_hash` check, clarified `CryptoManager.__init__` docstring + `_keys` comment + JS `deriveMk` section header

## C5 File Upload Limitation — RESOLVED (2026-07-16)
- React 18 native event delegation picks up `new Event('change', {bubbles: true})`
- Working pattern: `DataTransfer` → `input.files = dt.files` → `dispatchEvent(change/input)`
- React `onChange` fires, state updates, UI shows selected filename — verified in browser
- Documented: `docs/planning/BROWSER_E2E_TEST_PLAN.md`, `tests/e2e/E2E-03_*.md`, `tests/e2e/E2E-07_*.md`

## Phase 1b: Browser E2E Tests
- **E2E-03:** ✅ COMPLETE — `tests/e2e/E2E-03_import_file_upload.md` — 9/9 steps pass: file upload, auth errors, field gating
- **E2E-07:** ✅ COMPLETE — `tests/e2e/E2E-07_onboarding_import.md` — 13/13 steps pass: onboarding import, back nav, auth errors, field gating
- **E2E-05:** ✅ Phases 1-4 complete — seal/hash mismatch resolved, code refactored

## Recent UI Changes (2026-07-16)
- Dashboard: comment field added; Start New Task collapsible to thin bar
- Sync tab: Sync Now below Commit All; sync-details collapsible to "Sync Status ▸" bar
- Nav: removed redundant "New" tab (Dashboard covers task creation)

## Backlog Priority
| Pri | Phase | Key Items |
|-----|-------|-----------|
| 1 | 🟢 Phase 1b | E2E-03✅, E2E-07✅, E2E-05✅ — all complete |
| 2 | ⬜ Phase 2 | I-04✅ I-05✅ I-06✅ I-11✅ — all complete |
| 3 | 🟠 Phase 3 | I-03✅✅ staging encryption (Phases 1-4 done), I-02a✅ blind index field-name encryption (Phases 1-4 done) |
| 4 | 🔴 Phase 4 | I-01a✅ RotateKeysCommand (Phases 1-4 done, 141/141 PY), I-09🟢 device attribution (Phase 3 done), I-12✅ arch doc |
| 5 | ✅ Phase 4 (REFACTOR) | Cross-client canonical serialization — 43/43 assertions ✅ |
| 6 | ✅ Phase 4 (REFACTOR) | P5 CLI unlock latency — 32/32 assertions ✅. 3 Phase-4 improvements: extracted `_timeout_s()` in HttpStagingTransport, simplified `effective_key` in RemoteStagingSync.pull(), updated 23 tests for P5 read-only fast path |
| 7 | 🔵 Phase 5 | Cross-client: canonical serialization, indent=2 consolidation |
| 8 | 🔵 Phase 6 | CLI polish: P4 UX kinks |

## Immediate Next Steps 🎯

1. **I-09 Device Attribution** 🟠 Phase 4 (REFACTOR) — Phase 3 GREEN complete.
   - Plan: `docs/planning/I09_DEVICE_ATTRIBUTION_PHASE1.md` (49 assertions, 9 groups)
   - Source: `domain/cookie/device_cookie.py`, `security/auth.py`, `phpoc-web/src/sync/sync.js`
   - Goal: Derive device IDs from MK + device-local UUID4 secret (not MK alone)
   - Deprioritized Phase 1a below — device attribution may affect web re-auth flow
2. **Phase 1a: Align web staging sharing with CLI** (after I-09)
   - Plan: `docs/planning/ALIGN_WEB_STAGING_SHARING_WITH_CLI.md`
   - Stage 1.1: Remove MK bypass in `sync.js` (~line 527)

## Known Issues
- **20 PY tests fail** with Worker HTTP 403 (pre-existing, unrelated)
- **1 date filter test** fails with date-range conflict (pre-existing `test_phase5_main_wiring.py`)

## Browser E2E Setup
- **Browser:** Vivaldi via `agent_browser`, port 9222
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Tab rule:** `tab list` → find `localhost:5173`. Do NOT open new tabs.
- **Test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
