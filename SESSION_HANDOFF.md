# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **TDD plan:** `docs/planning/tmp/E2E_05_TEST_REQUIREMENTS.md` (38 assertions, 7 groups — ✅ Phase 1-4 complete)
> **Test files:** `phpoc-web/test/ledger_seal_consistency_test.mjs` (112 pass), `phpoc-web/test/ledger_roundtrip_test.mjs` (84 pass), 763 total ledger tests pass

## Current State
- **Branch:** `Staging_migration`
- **Last commit:** `cb3b0af` — promote E2E-05 seal/hash mismatch to top of task queue
- **CLI:** 1974 PY tests pass (1 pre-existing date-sensitive failure, 20 pre-existing Worker HTTP 403)  |  **Web:** 595 JS tests pass  |  **I-03:** ✅ Phase 1-4 complete — 52/52 PY + 35/35 web GREEN  |  **I-02:** ✅ Phase 1-4 complete — 103/103 PY (33 index + 18 staging keys + 52 staging at-rest) + 67/67 JS (32 index + 35 staging keys) all GREEN. Phase 4: 6 improvements (modularity ×2, clarity ×1, security ×1, conciseness ×2)

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
| 3 | 🟠 Phase 3 | I-03✅✅ staging encryption (Phases 1-4 done), I-02🟡 blind index encryption (Phase 2 RED done, Phase 3 next) |
| 4 | 🔴 Phase 4 | I-01🔴 key rotation, I-09🟡 device attribution, I-12🟡 arch doc |
| 5 | 🔵 Phase 5 | CLI polish: P5 unlock latency, P4 UX kinks |

## Immediate Next Steps 🎯
1. **I-02a 🟡 JS `_fieldToken()` WASM fix** — Add `hmac_hex` + `derive_field_key` WASM bindings, update JS `_fieldToken()` to use MK-derived HMAC instead of SHA-256 constant. ~1 hour. Rust side already implemented.
2. **I-01 key rotation** (🔴 Critical) — after I-02a

## Known Issues
- **I-02a 🟡 JS `_fieldToken()` uses SHA-256 without MK** (`phpoc-web/src/sync/local_cache.js`): Field-name tokens are trivially reversible (same mapping for every user). Impact: schema obfuscation weakened, VALUES still AES-CTR encrypted. Fix: add WASM bindings for `hmac_hex` + `derive_field_key` (Rust side already implemented). ~1 hour. Filed in BACKLOG.md.
- **E2E-05 seal mismatch:** ✅ Phases 1-4 complete. 763 ledger tests pass. 7 improvements.
- **I-03 staging encryption:** ✅ Phases 1-4 complete. 5 Phase-4 improvements: docstring fixes (×2 `local_cache.py`), extracted `_find_active_entry()` in `service.py`, extracted `_safeRefreshHashIndex()` in `local_cache.js`, simplified JS `_encrypt()`. All tests GREEN.
- **20 PY tests fail** with Worker HTTP 403 (pre-existing, unrelated)
- **WASM authenticate() ignores passphrase for raw seeds:** During onboarding import, the WASM `authenticate` function decodes the seed directly as the master key (no PBKDF2 passphrase derivation). This means wrong-passphrase tests won't catch seal failures during onboarding import — only wrong-seed tests will. The passphrase is only used to decrypt an encrypted stored seed in the normal login flow. Documented in E2E-07.

## Browser E2E Setup
- **Browser:** Vivaldi via `agent_browser`, port 9222
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Tab rule:** `tab list` → find `localhost:5173`. Do NOT open new tabs.
- **Test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
