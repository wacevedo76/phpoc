# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **TDD plan:** `docs/planning/tmp/E2E_05_TEST_REQUIREMENTS.md` (38 assertions, 7 groups — Phase 1-2 done)
> **Test file:** `phpoc-web/test/ledger_roundtrip_test.mjs` (empty — RED tests need to be written)

## Current State
- **Branch:** `Staging_migration`
- **Last commit:** `eb78c30` — collapsible UI sections, remove New tab, relocate Sync Now
- **CLI:** 1880 PY tests pass (20 pre-existing Worker HTTP 403 failures)  |  **Web:** 583 JS tests pass

## C5 File Upload Limitation — RESOLVED (2026-07-16)
- React 18 native event delegation picks up `new Event('change', {bubbles: true})`
- Working pattern: `DataTransfer` → `input.files = dt.files` → `dispatchEvent(change/input)`
- React `onChange` fires, state updates, UI shows selected filename — verified in browser
- Documented: `docs/planning/BROWSER_E2E_TEST_PLAN.md`, `tests/e2e/E2E-03_*.md`, `tests/e2e/E2E-07_*.md`

## Phase 1b: Browser E2E Tests
- **E2E-03:** `tests/e2e/E2E-03_import_file_upload.md` — 9 steps: file upload, auth errors, field gating
- **E2E-07:** `tests/e2e/E2E-07_onboarding_import.md` — 13 steps: full onboarding import, back nav, auth errors
- **Blocker:** E2E-05 seal/hash mismatch (export seal over raw JS vs import parsed JSON)

## Recent UI Changes (2026-07-16)
- Dashboard: comment field added; Start New Task collapsible to thin bar
- Sync tab: Sync Now below Commit All; sync-details collapsible to "Sync Status ▸" bar
- Nav: removed redundant "New" tab (Dashboard covers task creation)

## Backlog Priority
| Pri | Phase | Key Items |
|-----|-------|-----------|
| 1 | 🟡 Phase 1b | E2E-03, E2E-07 — scripts done, blocked by E2E-05 seal bug |
| 2 | ⬜ Phase 2 | I-04✅ I-05✅ I-06✅ I-11✅ — all complete |
| 3 | 🟠 Phase 3 | I-03🔴 staging at-rest encryption, I-02🔴 blind index encryption |
| 4 | 🔴 Phase 4 | I-01🔴 key rotation, I-09🟡 device attribution, I-12🟡 arch doc |
| 5 | 🔵 Phase 5 | CLI polish: P5 unlock latency, P4 UX kinks |

## Immediate Next Steps 🎯
1. **E2E-05 seal/hash mismatch** — 4-Phase TDD: write RED tests → fix → refactor
   - TDD plan: `docs/planning/tmp/E2E_05_TEST_REQUIREMENTS.md` (38 assertions ready)
   - Test file: `phpoc-web/test/ledger_roundtrip_test.mjs` (needs Phase 2 RED tests)
   - Unblocks: E2E-03, E2E-07 (import file upload flows)

## Known Issues
- **E2E-05 seal mismatch:** Export seal over raw JS; import reads parsed JSON. Needs fix.
- **20 PY tests fail** with Worker HTTP 403 (pre-existing, unrelated)

## Browser E2E Setup
- **Browser:** Vivaldi via `agent_browser`, port 9222
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Tab rule:** `tab list` → find `localhost:5173`. Do NOT open new tabs.
- **Test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
