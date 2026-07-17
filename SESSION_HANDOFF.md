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
- **CLI:** 1974 PY tests pass (1 pre-existing date-sensitive failure, 20 pre-existing Worker HTTP 403)  |  **Web:** 70/75 JS test files pass (5 pre-existing RED-phase failures: genesis_gate, onboarding_import_component, reauth_overlay, settings_genesis_component, vitest-setup)  |  **I-03:** ✅ Phase 1-4 complete — 52/52 PY + 35/35 web GREEN  |  **I-02:** ✅ Phase 1-4 complete — 103/103 PY + 67/67 JS all GREEN  |  **I-02a:** ✅ Phase 1-4 complete — 28/28 field token WASM + 35/35 staging keys + 32/32 index encryption all GREEN; 3 Phase-4 improvements: extracted `_applyFieldsToData()`, clarified `_encrypt()` guard + `_fieldTokenCache` lifetime  |  **I-01:** ✅ Phase 1-4 complete — 95/95 PY + 13/13 JS all GREEN; 5 Phase-4 improvements: hoisted `genesis_kv` in chain `verify()`, simplified redundant `require_content_hash` check, clarified `CryptoManager.__init__` docstring + `_keys` comment + JS `deriveMk` section header

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
| 4 | 🔴 Phase 4 | I-01a🔴 RotateKeysCommand execution, I-09🟡 device attribution, I-12🟡 arch doc |
| 5 | 🔵 Phase 5 | CLI polish: P5 unlock latency, P4 UX kinks |

## Immediate Next Steps 🎯
1. **I-01a RotateKeysCommand** (🔴 Critical) — Implement `soft_rotate()`/`hard_rotate()` execution: re-encrypt identity_secret, staging, index, cookie; re-seal genesis; hard rotation adds full chain rewrite + backup. Blocks: I-09 (needs rotation to re-derive device IDs).
   - **TDD:** Single 4-phase cycle with split GREEN (3a → soft, 3b → hard). Hard rotation subsumes soft — no need for two cycles.

## Known Issues
- **I-01 ✅ Phase 1-4 complete** — 95/95 PY + 13/13 JS all GREEN. Phase 4 improvements: hoisted `genesis_kv` out of loop in chain `verify()`, simplified redundant `require_content_hash` check in `_verify_single_block()`, clarified `CryptoManager.__init__` docstring (`key_version`), added comment about `_keys` dict population during rotation, fixed misleading "Pure-JS" comment on JS `deriveMk`. **Post-Phase-4 fix:** `deriveMk` rewritten from Node `crypto.createHmac` → Web Crypto API (`crypto.subtle`) for browser compatibility; Vite no longer throws "Module externalized" error.
- **I-02a ✅ Phase 1-4 complete** — 95/95 tests GREEN. Phase 4 improvements: extracted `_applyFieldsToData()` to eliminate duplication in `update()`, clarified `_encrypt()` mock-compat guard comment, documented `_fieldTokenCache` lifetime (tied to MK, recreated per session).
- **E2E-05 seal mismatch:** ✅ Phases 1-4 complete. 763 ledger tests pass. 7 improvements.
- **I-03 staging encryption:** ✅ Phases 1-4 complete. 5 Phase-4 improvements: docstring fixes (×2 `local_cache.py`), extracted `_find_active_entry()` in `service.py`, extracted `_safeRefreshHashIndex()` in `local_cache.js`, simplified JS `_encrypt()`. All tests GREEN.
- **20 PY tests fail** with Worker HTTP 403 (pre-existing, unrelated)
- **WASM authenticate() ignores passphrase for raw seeds:** During onboarding import, the WASM `authenticate` function decodes the seed directly as the master key (no PBKDF2 passphrase derivation). This means wrong-passphrase tests won't catch seal failures during onboarding import — only wrong-seed tests will. The passphrase is only used to decrypt an encrypted stored seed in the normal login flow. Documented in E2E-07.

## Browser E2E Setup
- **Browser:** Vivaldi via `agent_browser`, port 9222
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Tab rule:** `tab list` → find `localhost:5173`. Do NOT open new tabs.
- **Test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
