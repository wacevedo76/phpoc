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
- **CLI:** 2135 PY tests pass (1 pre-existing date-sensitive failure, 20 pre-existing Worker HTTP 403)  |  **Web:** 70/75 JS test files pass (5 pre-existing RED-phase failures: genesis_gate, onboarding_import_component, reauth_overlay, settings_genesis_component, vitest-setup)
- **I-01:** ✅ key rotation (95/95 PY + 13/13 JS)  |  **I-01a:** ✅ RotateKeysCommand (141/141 PY)  |  **I-02:** ✅ blind index + staging keys (103/103 PY + 67/67 JS)  |  **I-02a:** ✅ JS field tokens (28+35+32)  |  **I-03:** ✅ staging at rest (52/52 PY + 35/35 web)  |  **I-04:** ✅ HMAC naming  |  **I-05:** ✅ per-user PBKDF2 salt  |  **I-06:** ✅ content_hash required  |  **I-09:** ✅ device attribution (49 assertions, Phases 1-4)  |  **I-11:** ✅ blob obfuscation portability  |  **I-12:** ✅ system architecture doc  |  **Entry Hash Consolidation:** ✅ 17/17 GREEN  |  **P5 CLI Unlock:** ✅ 32/32 GREEN  |  **Web Staging Alignment:** ✅ Phase 1a (Stages 1.1–1.5)  |  **Cross-Client Serialization (P1):** ✅ Phases 1-4 complete — 43/43 GREEN
- **P4 CLI UX Polish:** 🔴 Phase 2 complete — 24 tests written in `tests/test_p4_cli_ux_polish.py` (6 RED, 18 regression-guard GREEN). Blueprint: `docs/planning/P4_CLI_UX_POLISH_PHASE1.md`

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
| 8 | 🔴 Phase 6 | P4 CLI UX polish — Phase 1 complete (24 assertions, 5 groups) |

## Immediate Next Steps 🎯

1. **P4 — CLI UX polish** 🔴 Phase 2 complete → 🟢 Phase 3 (GREEN)
   - 24 tests in `tests/test_p4_cli_ux_polish.py` (6 RED, 18 regression-guard GREEN)
   - RED: A1-A4 (tags path unification), B4 (non-blocking tags), C1 (tags handler dup)
   - All RED failures trace to `main.py` tags handler duplicate + `_list_tags` CLIInterface bypass
   - Next: Phase 3 (GREEN) — implement fixes in `main.py` and `cli/interface.py`
2. **Remaining E2E tests** (E2E-04 wrong passphrase, E2E-06 export wrong passphrase)
3. **P3 — Remote sync (git-based)** 🔵 Phase 7

## Known Issues
- **20 PY tests fail** with Worker HTTP 403 (pre-existing, unrelated)
- **1 date filter test** fails with date-range conflict (pre-existing `test_phase5_main_wiring.py`)

## Browser E2E Setup
- **Browser:** Vivaldi via `agent_browser`, port 9222
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Tab rule:** `tab list` → find `localhost:5173`. Do NOT open new tabs.
- **Test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
