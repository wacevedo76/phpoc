# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed history:** `docs/planning/archive/SESSION_HISTORY_2026-07-04.md`

## Current State
- **Branch:** `mobile-poc`
- **CLI:** 1609/1609 PY tests pass  |  **Web:** 807 JS tests pass  |  **Worker:** 49 vitest tests pass
- **Chain integrity fixes (Jul 5):** ✅ 4 gaps closed — web now verifies chain linkage during onboarding, on every append, detects genesis collision on push, and uses enumerate order for push
- **Root cause identified:** Broken R2 chain (genesis from CLI Apr 23 + day blocks from web Jun 1) — mixed two ledger initializations. Fix script ready at `scripts/fix_chain_genesis_link.py`

## Immediate Next Steps (Jul 6)
1. **Fix the broken chain:** `python3 scripts/fix_chain_genesis_link.py https://phpoc-staging.wacevedo.workers.dev "Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw="`
2. **Verify CLI onboarding:** `ph onboarding http cloudflare` — should pull all 105 blocks, prompt passphrase
3. **Verify web onboarding:** Hard-refresh phpoc-web → clear IndexedDB → onboard from R2 → confirm no errors
4. **Clean up diagnostics:** Remove `[DIAG]` logging from `domain/ledger/remote_sync.py`
5. **Run test suites:** `pytest tests/ -x -q` and `cd phpoc-web && npm test`

## Chain Integrity Investigation (Jul 5) — Summary

**Problem:** CLI `_verify_chain` rejected R2 chain at block 1 (`genesis.day_hash ≠ day1.prev_hash`). phpoc-web silently accepted same chain.

**Root cause:** Chain on R2 composed of blocks from two separate ledger initializations:
- Genesis (Apr 23, CLI-created): `day_hash=3c4a…`
- Day blocks 1–104 (Jun 1–19, web-created): chain from a *different* genesis (`prev_hash=9563aa…`)
- Trigger: creating new local ledger in phpoc-web when R2 already had CLI genesis. Push skipped genesis (fileIdx=0 existed) but pushed day blocks (indices 1+).

**4 fixes applied:**

| # | File | Change |
|---|------|--------|
| 1 | `sync.js` `pushLedgerBlocks` | Enumeration order (no day_index sort) |
| 2 | `DevModeContext.jsx` `onboardFromRemote` | Full prev_hash chain verification |
| 3 | `chain.js` `append()` | prev_hash linkage check on every block append |
| 4 | `sync.js` `pushLedgerBlocks` | Genesis collision guard — abort push if local ≠ remote genesis |

**Files modified:** `sync.js`, `chain.js`, `DevModeContext.jsx`, `remote_sync.py` (diag temp)

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
