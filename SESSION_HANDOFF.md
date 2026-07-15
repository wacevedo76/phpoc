# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md` (27 open, 3 Critical / 4 High / 6 Medium / 2 Low)
> **Completed history:** `docs/planning/archive/SESSION_HISTORY_2026-07-15.md`

## Current State
- **Branch:** `mobile-poc`
- **CLI:** 1787 PY tests pass (2 flaky: staging service timeout ordering)  |  **Web:** 583 JS tests GREEN across 6 suites  |  **Worker:** 104 vitest tests pass
- **B-01 (web staging committed-flag loss):** ✅ 4-phase TDD complete (2026-07-15)
- **I-07 (format_version in seal) + I-17 (day_hash→block_hash):** ✅ Canonical Ledger Format (2026-07-03)

## Backlog Priority (see BACKLOG.md for full detail)

| Pri | Phase | Items |
|-----|-------|-------|
| 0 | 🟢 Doc fixes (anytime) | I-08🟠 I-10🟡 I-13🟡 I-14🟡 I-15🟢 I-16🟢 |
| 1 | 🔜 Staging alignment + E2E | 1.1–1.5 (5 stages), E2E-03–07 (5 tests) |
| 2 | 🟡 Low-effort code | I-04🟠 I-05🟠 I-06🟠 I-11🟡 |
| 3 | 🟠 Encryption gaps | I-03🔴 I-02🔴 — staging + blind index at-rest encryption |
| 4 | 🔴 Architectural | I-01🔴 I-09🟡 I-12🟡 — key rotation, device attribution, sys arch doc |
| 5 | 🔵 CLI polish | P5 (unlock latency), P4 (UX kinks) |
| 6 | 🔵 Cross-client | P1 (canonical serialization), indent=2 consolidation |
| 7 | 🔵 Remote sync | P3 (git-based) |

## Immediate Next Steps
1. **Phase 0 (anytime):** Pick any doc fix — I-08 (Known Limitations) or I-15 (AES-128) are quickest
2. **Phase 1.1:** Remove MK bypass in `phpoc-web/src/sync/sync.js` ~line 527 — 4-line change
3. **Phase 1.2–1.5:** ReauthOverlay → fallback removal → GENESIS_MISMATCH → tests

## Known Issues
- **CLI read commands block on specifier mismatch** (Python-side, not web)
- **Deduplication bug in SyncOrchestrator** — ✅ FIXED.
- **CLI staging/ledger reconciliation for cross-platform commits** — ✅ FIXED (`cli/interface.py`).
- **Web test runner compatibility (minor):** 3 test files use vitest (`onboarding_import_component`, `reauth_overlay`, `settings_genesis_component`) and must run under `npx vitest`, not `node --test`. All pass when run with correct runner. `settings_genesis_component` is intentionally RED (Phase 2 TDD for a11y features). No production impact.

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
