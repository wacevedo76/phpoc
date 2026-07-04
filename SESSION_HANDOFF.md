# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed history:** `docs/planning/archive/SESSION_HISTORY_2026-07-04.md`

## Current State
- **Branch:** `mobile-poc`
- **Canonical Ledger Format:** ✅ Complete — I-07 (format_version excluded from seal), I-17 (genesis day_hash → block_hash). Live ledger at `~/.local/share/phpoc/ledger.json` migrated.
- **CLI:** 1609/1609 PY tests pass (+29 cross-platform integration)
- **Web:** 726 JS tests pass (3 pre-existing failures). Total: 766 pass.
- **Worker:** 49 vitest integration tests pass (HTTP endpoints, auth, CORS, CRUD)
- **WASM crypto:** Bundled via Vite's native pipeline, no DummyCryptoService fallbacks.
- **phpoc-web IndexedDB:** Username `William Acevedo`, email `william.acevedo@gmail.com`. 1 genesis block, 2 staging entries (1 stopped, 1 active), 0 committed. Recovery seed: `Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=`. Dev server on port 5174.

## Immediate Next Steps

### 🟢 Phase 6 P1 Step 1: JS-layer passphrase validation ✅ Complete (Jul 4)

Passphrase validated via stored PBKDF2 hash. E2E-06 now works.

| File | Change |
|------|--------|
| `DevModeContext.jsx` | `createNewLedger()` and `unlockLedger()` store `sha256(derivePdk(passphrase, 600K) + seed)` as `phpoc_passphrase_hash` in IndexedDB |
| `export_auth.js` | `exportWithAuth()` reads stored hash, recomputes, compares. Wrong passphrase → "Incorrect passphrase". Falls through to genesis seal for old ledgers without hash. |
| `test/export_passphrase_validation_test.mjs` | 4 new tests (E8-E11): correct passphrase passes, wrong passphrase rejected, hash check before export, missing hash fallback. 44/44 pass. |

- **Cloud onboarding:** ✅ Chain import works — 105 blocks detected, auth prompt shown. Fixed genesis gate stale hash index false mismatch (Jul 4).
- **Genesis gate fix (Jul 4):** `genesis_gate.js` — removed premature `GenesisMismatchError` throw from Tier 2 hash index path. Hash index is a cache, not an authority. Full chain pull always runs for definitive comparison. All 218 tests pass.
- **Docs updated (Jul 4):** All integration test docs reference testing Worker credentials (`phpoc-staging-testing.wacevedo.workers.dev`, API key `ZfkbMrrdRaY7DeoanY1GqQAOSLDmI6gO`). Production URL not referenced in any doc.
- **Workflows:** `docs/design/workflows/cli/CLI_Web_Cross_Staging_Workflow.md` — 8-step operational guide for CLI→Web→CLI staging cycle.

### 🔜 Cloud onboarding chain import ✅ Complete (Jul 4)

Web app can now import a remote ledger directly from `ledger/blocks/` (the `ph sync` format) without requiring a separate backup file. Multi-device onboarding now works with 4 inputs: Worker URL, API key, passphrase, recovery seed.

| File | Change |
|------|--------|
| `src/sync/remote_import.js` | Added static `checkForRemoteChain()`, `fetchChain()`, `fetchGenesis()` methods. Uses `ledger/blocks/` prefix (or `ledger:blocks` fallback). Deobfuscates per-block with master key. |
| `src/components/screens/OnboardingScreen.jsx` | `handleCloudConnect()` checks remote chain first, then backups. Skips backup picker when chain found → direct to auth. `handleCloudImportSubmit()` passes `source='chain'`. |
| `src/context/DevModeContext.jsx` | `importFromCloud()` accepts `source` param. Chain path: `fetchChain()` → `_validateRawChain()`. |

**Smoke test:** Chain detection found 105 blocks on R2 Worker, navigated directly to auth. Deobfuscation failed with wrong key (test creds ≠ remote ledger) — expected.

### ✅ Cross-Platform Integration Tests (Jul 4)

29 new Python tests hitting the live test Worker, plus 49 Worker vitest tests.

| File | What it covers |
|------|---------------|
| `tests/test_cross_platform_integration.py` | Blob/cookie/ledger round-trips, full staging cycle, format markers, error handling — 29 tests |
| `worker/test/index.test.ts` | Worker HTTP endpoints: auth, CORS, GET/PUT/DELETE, list, errors — 49 tests |
| `worker/vitest.config.ts` | Vitest configuration for worker tests |

**Worker credentials recorded in** `docs/design/workflows/cli/CLI_Web_Cross_Staging_Workflow.md` §Test Worker Credentials.

### 🔜 Phase 6 P1 Step 2: WASM architectural alignment (future)

Full alignment with Python architecture: encrypt seed with PDK, WASM `authenticate()` decrypts. Requires migration path for existing ledgers.

---

### Past work (reference)

#### Phase 1a: Web staging alignment with CLI ✅ Complete (182 tests)

#### Phase 1b: Browser E2E Tests 🟡 Complete (Jul 4)
E2E-01–02 ✅, E2E-04 ✅, E2E-05 ✅ FIXED, E2E-03/07 ⚠️ C5 limitation. E2E-06 🟡 blocked by WASM (Phase 6 P1 above).
**Key discovery:** WASM `authenticate()` ignores passphrase (seed == MK). Root cause: `wasm.rs:276` `_passphrase` underscore = unused.
**I-17 fix:** `export_auth.js` handles `block_hash` || `day_hash`.

## Known Issues (Active)

- **🟡 WASM authenticate passphrase bypass** — `wasm.rs:276` ignores passphrase, seed == MK. Fix in progress (Phase 6 P1 Step 1).
- **Login takes 4–30+ seconds** — hash index bootstrap gap. Future: pre-seed hash index during onboarding.
- **CLI read commands block on specifier mismatch** — `ph view`/`ph list`/`ph tags` bail when another device holds cookie.
- **Pre-existing test failures** — `ledger_sync_test.mjs` (A3c), `commit_push_integration_test.mjs`, `sync_service_test.mjs` (W3b). Not canon-format related.

## Browser E2E Testing Setup

- **Browser:** Vivaldi with `--remote-debugging-port=9222`. Connect via `agent_browser: connect 9222` with `sessionMode: "fresh"`.
- **Tab rule:** After connecting, run `tab list` → find tab with `localhost:5173` (or 4173/5174) → `tab t<N>` to switch. Do NOT open new tabs.
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`

## Test Ledger Credentials

- **Active Browser Ledger (William Acevedo)**
  - Passphrase: `VZQKp6TrIBK/GUtsjoof75HRyzd7w8S0`
  - Recovery Seed: `Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=`
  - Username: `William Acevedo` | Email: `william.acevedo@gmail.com`
  - Export file: `testdata/e2e_export.phpledger` (v2, 2.7KB)

## Testing Quick Reference

- **Worker:** `https://phpoc-staging-testing.wacevedo.workers.dev` | **phpoc-web:** `http://localhost:5173/`
- **E2E test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`, API key `ZfkbMrrdRaY7DeoanY1GqQAOSLDmI6gO`

> Credentials (API key, passphrase, seed, wrangler token) stored outside repo. Ask user if needed.
