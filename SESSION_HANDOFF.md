# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md` to identify which docs this session's changes affect. Update those docs as part of the work.

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete, LedgerMerge TDD GREEN phase ✅ done, Step 5 export/import fix ✅ done)
- **CLI:** Maintenance mode — onboarding redesign complete (Phase 5d), 1493 tests
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Storage (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON)
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests)
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2)
- **WASM crypto:** Bundled by Vite's native pipeline — `src/crypto/wasm/`, real WASM in both dev and production. No DummyCryptoService fallbacks.
- **phpoc-web IndexedDB state:** Active ledger — username `William Acevedo`, email `william.acevedo@gmail.com`. 1 genesis block, 2 staging entries (1 stopped, 1 active), 0 committed. Recovery seed: `Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=`. Dev server on port 5174 (5173 was occupied).

## Immediate Next Steps

### ✅ Step 5: Fix export/import seal & hash mismatch bug (DONE — 2026-06-28)

**Status:** ✅ GREEN — TDD complete. 185/185 tests pass across 3 test files.

### ✅ Step 6b: Implement GENESIS_MISMATCH fix in DevModeContext.jsx (DONE — 2026-06-29)

86 new tests across 3 files (all GREEN). Code changes:
- **✅ Phase 1:** `connectToWorker()` — delete `ledger:blocks` from R2 after blocks-format onboarding **(DONE — 2026-06-29)**
- **✅ Phase 2:** `bootstrapServices()` — auto-clear on GENESIS_MISMATCH **(DONE — 2026-06-29)**
- **✅ Phase 3:** Protocol unification — single canonical `ledger/blocks/` format **(DONE — 2026-06-29)**
  - Genesis gate now checks `ledger/blocks/000000.json` (blocks format) instead of `ledger:blocks` (blob)
  - `_pushFullLedgerChain()` replaced with `pushLedgerBlocks()` (pushes obfuscated individual block files)
  - `pushLedgerBlocks()` gained `{ forceAll: true }` option for post-merge pushes (same-index overwrite)
  - `clearRemote()` now lists and deletes individual block files
  - `connectToWorker()`: removed single-blob path, stale `ledger:blocks` delete hack — only blocks-format onboarding
  - `OnboardingScreen.jsx` `handleWorkerFetch()`: blocks-only discovery, seed always required
  - CLI and web app now share the same R2 key scheme — one canonical protocol

Full investigation and action plan: `docs/planning/GENESIS_MISMATCH_BUG_INVESTIGATION.md`.

### ✅ Step 6c: Stable device specifier on writes — GREEN phase (DONE — 2026-06-30)

TDD: 5 tests in Group O of `phpoc-web/test/sync_service_test.mjs`. All 167 pass, 0 fail.

**Fix:** Modified `pushToRemote()` in `phpoc-web/src/sync/sync.js` — checks for existing local cookie with `device_specifier`, reuses it (only updates `creation_time`) instead of calling `destroyLocally()` + `_pushCookie()` which always generated a new specifier. `DeviceCookie.create()` is only called for first push (no local cookie). `_pushCookie()` remains unchanged for `_reconcileAndClaim()` Case B cross-device takeover path.

Remote cookie pushed as `{device_uuid, device_specifier}` only — no `creation_time` leaks to remote.

### ✅ Step 6d: Refactoring — Modularity, Clarity, Security, User Efficiency (DONE — 2026-06-30)

All 167 sync tests pass + 21 Vitest component tests pass. No regressions.

**Modularity (3 new modules, ~180 lines deduped):**
- `src/sync/base64.js` — shared `base64ToBytes`/`bytesToBase64` (removed duplicates in sync.js, remote_sync.js, genesis_gate.js)
- `src/sync/keys.js` — 7 canonical path constants (`REMOTE_STAGING_BLOB`, `REMOTE_DEVICE_COOKIE`, `REMOTE_LEDGER_BLOCKS_PREFIX`, `REMOTE_LEDGER_INDEX`, `LOCAL_COOKIE`, `LOCAL_LEDGER_BLOCKS`, `LOCAL_LEDGER_INDEX`) — replaced 30+ hardcoded strings
- `src/sync/entry_dto.js` — DTO conversion extracted from sync.js: `rawCommittedEntryToDTO`, `rawEntryToDTO`, `parsePlainInt`, `parsePlainJSON` (~130 lines removed from SyncService)

**Clarity (5 improvements):**
- `checkAndSync()` decomposed into `_genesisGatePhase()` / `_fastPathPhase()` / `_authGatePhase()` (~35 lines each)
- `_reconcileAndClaim()` split into `_reconcileSameDevice()` / `_reconcileDifferentDevice()` (~25 lines each)
- `_pushRemoteCookie(deviceId, specifier)` helper replaces 3 duplicated cookie-encode blocks
- `cookie.js` stale header fixed (no longer says "every write generates new specifier")
- Removed unused `timeoutMs` param from `checkAndSync()` signature

**Security (2 fixes):**
- **cookie.js TTL fallback bug:** `(ttlMinutes || DEFAULT_TTL_MS / 60000)` → `(ttlMinutes ?? DEFAULT_TTL_MS / 60000)`. When `ttlMinutes=0`, the old `||` fell back to 30s instead of 30min. Now uses nullish coalescing.
- `matches()` redundant `!!` removed — expression is already boolean.

**User Efficiency (3 improvements):**
- `_deviceId` cached in `this._deviceId` — avoids repeated `getOrCreateDeviceUuid()` + WASM calls per operation
- `pushLedgerBlocks()` skips `listFiles` when `forceAll=true` (genesis merge path)
- `clearRemote()` uses `keys.js` constants instead of hardcoded paths

**Files touched:** 8 changed, 3 new. All pre-existing test failures confirmed unchanged.

### 🔜 Step 6a: Align web staging sharing with CLI (PLANNING — 2026-06-29)

Plan created at `docs/planning/ALIGN_WEB_STAGING_SHARING_WITH_CLI.md`. 5 phases:
1. Remove MK bypass in `checkAndSync()` — no cookie → always `REAUTH_NEEDED`
2. Add `ReauthOverlay.jsx` — passphrase prompt → derive MK → reconcile → resume
3. Remove fallback `DeviceCookie.create('local', ...)` from `bootstrapServices()`
4. Handle `GENESIS_MISMATCH` in re-auth flow (deferred)
5. Test coverage across 7 test files

9 files to touch (1 new component). No code changes yet — planning only.

### 🟡 Step 6: Resume Tier 3 Browser E2E tests

Once Step 5 is fixed, continue E2E testing:
- E2E-03: Import file upload + same-genesis rejection ✅ (verified via eval), auth error paths
- E2E-04: Import with wrong passphrase/seed → error display
- E2E-05: Full roundtrip — export → clear local → import → verify data integrity
- E2E-06: Export with wrong passphrase → error display
- E2E-07: Onboarding import flow (logout → onboarding → import from file)

**Setup:** Vivaldi on port 9222, tab t7 at `http://localhost:5174/?dev=false`. See `docs/planning/BROWSER_E2E_TEST_PLAN.md` for test details and known limitations (file input React integration, blob download capture).

### ⏭ Step 7: Consider Playwright for file input E2E tests

agent_browser's `fill` on file inputs doesn't trigger React `onChange` (known limitation C5 from handoff). For reliable file picker E2E tests, consider adding Playwright as a dev dependency. Playwright's `page.setInputFiles()` properly triggers React synthetic events. See `docs/planning/BROWSER_E2E_TEST_PLAN.md` for the test cases that need file input interaction.

### ✅ Step 1: Fix getCompleted() duplication bug (DONE — 2026-06-28)

**Bug:** `SyncService.getCompleted()` returns every committed entry twice — once from the ledger chain (`ledger:blocks`) and once from the staging cache (`entries`) which still holds committed entries.

**Root cause:** `src/sync/sync.js` line 312 filters staging entries by `!e.is_active` only — committed entries with `committed:true` pass this filter. The `markCommitted()` call in the commit flow sets `committed:true` but never removes entries from staging, and `removeSynced()` is never called.

**Fix:** Changed line 312 from `entries.filter((e) => !e.is_active)` to `entries.filter((e) => !e.is_active && !e.committed)`.

**Tests:** Added Group L (4 tests) to `test/sync_service_test.mjs` — covers committed dedup (L1), uncommitted staging-only (L2), mixed committed+uncommitted (L3), and active exclusion (L4). All 89 tests pass.

### ✅ Step 2: Python port of LedgerMerge — TDD GREEN Phase (DONE)

Port `LedgerMerge.merge()` from `phpoc-web/src/ledger/merge.js` to Python as `domain/ledger/merge.py` (~300 lines).

**Status:** ✅ GREEN phase complete — all 47 tests pass. Implementation: `merge()`, `_verify_chain()`, and `_verify_block_data()` in `domain/ledger/merge.py`. Full test suite at `tests/test_ledger_merge.py` (47 tests, 11 groups).

### ✅ Settings Genesis Gate Integration — Category C Browser E2E (C2 FIXED)

**Status:** 4 pass / 0 fail / 4 skipped. C2 fixed via Solution B.

| Test | Result | Details |
|------|--------|--------|
| **C1** | ✅ PASS | "✅ Genesis compatible" + entry count shown for correct Worker URL + API key |
| **C2** | ✅ PASS | Fixed: `SyncService.reconfigure(transport)` called from Settings after genesis check. Sync Now uses new transport. |
| **C3** | ⏭️ SKIP | Need Worker with different genesis; testing Worker appears empty. No incompatible Worker available. |
| **C4** | ✅ PASS | "🔌 Cannot reach remote" + "Network error" for non-existent URL |
| **C5** | ⚠️ UNTESTABLE | `fill` command sets DOM `.value` but doesn't trigger React `onChange`. Can't clear URL field to test status→disappear flow via agent_browser. |
| **C6** | ✅ PASS | API key change re-triggers genesis check. Wrong API key → "Authentication failed. Check your API key." |
| **C7** | ⏭️ SKIP | Requires clearing local ledger (destructive). Settings inaccessible during onboarding. |
| **C8** | ⏭️ SKIP | Settings page inaccessible without authentication (requires login → Settings path). |

**Fix implemented:** Solution B — `reconfigure(transport)` method on SyncService. Settings calls `services.sync.reconfigure(transport)` after genesis check, and `services.sync.reconfigure(null)` when URL is cleared. 6 new tests in Group K of `sync_service_test.mjs`. Analysis at `docs/design/TRANSPORT_RECONFIGURATION_ANALYSIS.md`.

### ✅ Step 3: Wiring LedgerMerge into orchestrator — CLI (DONE)

**Target:** Python CLI (`core/sync/orchestrator.py` + `domain/ledger/remote_sync.py`)

Wire `LedgerMerge.merge()` into `SyncOrchestrator._sync_ledger_blocks()` — when `RemoteLedgerSync.pull_blocks()` detects same-genesis divergence, call `LedgerMerge.merge()`, replace local chain/index, force-push merged result. Requires new `pull_full_chain()` on `RemoteLedgerSync`. CLI confirmation prompt during `ph sync`.

**Status:** ✅ Complete — 11 new orchestrator merge tests pass (1551 total).

Changes:
- `security/crypto.py`: Added `verifySeal()`, `verifySignature()` camelCase aliases to `AbstractCryptoManager`, `CryptoManager`, `NoAuthCryptoManager` (merge.py uses JS-style API)
- `domain/ledger/remote_sync.py`: Added `pull_full_chain()` (pull all blocks without chain verification) and `pull_block_by_index()` (single block pull)
- `core/sync/orchestrator.py`: `_sync_ledger_blocks()` now detects same-genesis divergence via `_is_same_genesis()`, offers interactive [M]erge/[S]kip/[C]ancel prompt via `_try_ledger_merge()`, calls `LedgerMerge.merge()` via `asyncio.run()`, replaces local chain + index, force-pushes merged result. Merge skipped when no `ViewInterface` (headless).
- `tests/test_phase6c_orchestrator_cli.py`: 11 new tests in `TestSyncLedgerBlocksMerge` covering merge accepted/cancelled/skipped, no-view, genesis mismatch, pull/merge failures, `_is_same_genesis()` unit cases.

### 🟢 Step 4: Same-genesis merge for phpoc-web — GREEN Phase (DONE — 2026-06-28)

**Goal:** Wire `LedgerMerge.merge()` (already in `src/ledger/merge.js`) into the phpoc-web sync flow. `GenesisGate.check()` already calls `LedgerMerge.merge()` and returns `mergedChain` + `stats` + `index`, and `checkAndSync()` already persisted the merged chain locally. Two gaps fixed:

1. **Push merged chain to remote** — New `_pushFullLedgerChain()` method pushes raw JSON to `ledger:blocks` (same key `GenesisGate.check()` pulls from). Called after local persist in `checkAndSync()`. Best-effort (errors logged, non-fatal).
2. **Expose merge stats** — New `get lastMergeStats()` getter returns `{ forkIndex, localEntries, remoteEntries, duplicatesSkipped, mergedEntries, newBlockCount }` from the last genesis-gate merge. Initialized to `null` in constructor.

**Tests:** Group M (8 tests) — 129/129 pass (was 118/5 RED → 129/0 GREEN).

Changes in `src/sync/sync.js`:
- Constructor: Added `this._lastMergeStats = null`
- `checkAndSync()` genesis gate block: Store `result.stats` into `_lastMergeStats`, call `_pushFullLedgerChain(result.mergedChain, result.index)` after local persist
- New getter `lastMergeStats`: Returns `_lastMergeStats` (null if no merge yet)
- New method `_pushFullLedgerChain(chain, index)`: Pushes raw JSON chain to `ledger:blocks`, index to `ledger/index.json`. Best-effort.

MockTransport/Crypto changes in test file:
- `_pushError` field on MockTransport (push rejection for M4)
- `decrypt(ciphertextHex, masterKey)` on MockCrypto (for `LedgerMerge.merge()` date grouping)
- Helper functions `makeChainEntry()` and `makeChain()` for multi-block chain construction

### ⏭ Remaining Gaps (future work)

1. ~~**Same-genesis merge support (phpoc-web)**~~ — ✅ DONE. `_pushFullLedgerChain()` + `lastMergeStats` getter. See Step 4 above.
2. ~~**Tier 2 — React component tests**~~ — ✅ DONE (2026-06-28). 21 Vitest+RTL tests at `phpoc-web/test/onboarding_import_component.test.mjs`. Covers file picker gating (I2–I3), destroy warning display (I4–I5), checkbox gates (I6–I7), error display (I8), import source selection (I1), and back navigation (I9). All 21 pass, 0 failures. See WEB_ROADMAP.md Build 57.
3. **Tier 3 — Browser E2E** (~4 tests): 🟡 IN PROGRESS (2026-06-28). Export flow ✅, Import dialog UI ✅, file upload via eval ⚠️ (React onChange limitation), roundtrip ✅ unblocked (Step 5 fix). See `docs/planning/BROWSER_E2E_TEST_PLAN.md`.
4. **Raw chain staging extraction**: CLI `ledger.json` import puts all entries inside `ledger:blocks` — no way to extract them into staging for editing or re-commit.

## Known Issues

- **phpoc-web: getCompleted() returns duplicate entries (2026-06-28):** ✅ FIXED. Changed staging filter from `!e.is_active` to `!e.is_active && !e.committed` in `src/sync/sync.js` line 312. Added Group L (4 tests) to `test/sync_service_test.mjs`. All 89 tests pass.
- **SyncService transport not updated on Settings change (2026-06-25):** ✅ FIXED. Solution B implemented — `SyncService.reconfigure(transport)` exposed, called from Settings after genesis check. 6 new tests (Group K). C2 E2E test now passes.
- **Stale session cache trusted without verification (2026-06-26):** ✅ FIXED. `PassphraseAuthenticator.authenticate()` blindly trusted the cached key (`/dev/shm/phpoc_session`) without verifying it against the genesis seal. A stale/wrong cached key caused `ph list all` to silently skip all entries (decryption failed, caught by bare `except:`). Fix: added `_verify_cached_key()` that checks genesis seal before trusting the cache; stale cache is auto-cleared. Also fixed `_print_entry` to show `[encrypted] title (Nm) [run 'ph login' to decrypt]` instead of silently skipping undecryptable entries.
- **TTL cookie ignored for local-only ledgers (2026-06-27):** ✅ FIXED. `check_and_sync()` returned `READY` immediately when `_remote is None`, bypassing the device cookie TTL entirely. Read commands (`ph list`/`view`/`tags`) never prompted for a passphrase because the session cache at `/dev/shm/phpoc_session` has no TTL and the device cookie (which does) was never checked. Fix: `check_and_sync()` now checks `DeviceCookie.is_valid_locally()` even for local-only, returning `REAUTH_NEEDED` on expiry. `_reconcile_and_claim()` creates a local cookie via new `DeviceCookie.create_local()`. `ph login` and `ph recover` handlers also create local cookies. Changes in `domain/cookie/device_cookie.py`, `domain/staging/service.py`, `main.py`.
- **phpoc-web: Login blank screen (2026-06-28):** ✅ FIXED. Added `ErrorBoundary` class component to `App.jsx` — catches render crashes and shows diagnostics + reload button instead of blank white screen. Wraps entire `<DevModeProvider><AppInner/></DevModeProvider>` tree. Root cause: no error boundary existed; any render crash unmounted entire component tree silently.
- **phpoc-web: Reauth overlay → TTL warning + landing redirect (2026-06-28):** ✅ REPLACED. Cookie TTL expiry now calls `handleTtlExpiry` which sends the user to the landing screen (same as logout — re-login runs bootstrapServices). A 5-minute warning banner appears before expiry with a dismiss button. Removed `reauthActive`, `triggerReauth`, `dismissReauth`, `handleReauth` from DevModeContext. Added `ttlWarning`/`dismissTtlWarning` state. `createCookieMonitor` gained `onWarning` callback + `warningThresholdMinutes` option. SyncSettings REAUTH_NEEDED message changed to "Log out and log back in."
- **phpoc-web: Remote sync settings not cleared on new ledger (2026-06-27):** ✅ FIXED. When `createNewLedger()` or `confirmImport()` cleared IndexedDB (`storage.clear()`), the `localStorage` keys `phpoc_worker_url` and `phpoc_api_key` were left intact. Result: after creating a new ledger or importing one, the Settings page still showed the previous Worker URL and API Key. Fix: both functions now call `localStorage.removeItem()` for both keys immediately after `storage.clear()`. Change in `phpoc-web/src/context/DevModeContext.jsx`.
- **New Task — One-off activity checkbox (2026-06-27):** ✅ DONE. NewTask.jsx now has a "One-off activity" checkbox that captures entries as already completed (`is_active=false`, `end_epoch=startEpoch`). Uses existing CSS classes. Button changes from "Start Task" to "Log Task".
- **Genesis mismatch override — Clear Remote & Overwrite (2026-06-27):** ✅ DONE. When Sync Now detects `GENESIS_MISMATCH`, the UI now shows an override panel requiring the user to type `DELETE` to confirm. Calls `sync.clearRemote()` (HTTP DELETE on ledger:blocks, staging:blob, cookie:json, resets genesis gate), then re-runs sync to push local ledger. CSS in App.css, logic in SyncSettings.jsx and sync.js.
- **Export/Import roundtrip: seal & entry hash mismatch (2026-06-28):** ✅ FIXED. Export now recomputes each staging entry's hash to cover ALL fields except `hash` before computing the seal. This ensures entries with extra app-added fields (`committed`, `block_index`, `entry_index`, `end_device_uuid`) survive import re-validation. Fix in `phpoc-web/src/services/ledger_export.js` (both `exportLedger()` and `exportLedgerFull()`). 37 new/updated tests (185 total across 3 test files). TDD: RED → GREEN.
- **Genesis mismatch on Sync Now after cloud onboarding (2026-06-29):** ✅ FIXED. Three-phase fix. Phase 1: `connectToWorker()` deletes stale `ledger:blocks` after blocks-format onboarding. Phase 2: `bootstrapServices()` auto-clears and retries on GENESIS_MISMATCH. Phase 3: Protocol unification — single canonical `ledger/blocks/` format. 231 tests across 3 files, all GREEN. See `docs/planning/GENESIS_MISMATCH_BUG_INVESTIGATION.md`.
- **Web re-rolls device cookie on every write (2026-06-29):** ✅ FIXED (2026-06-30). `pushToRemote()` now reuses existing device specifier instead of destroying + recreating cookie on every write. Only calls `DeviceCookie.create()` on first push (no local cookie). Remote cookie format: `{device_uuid, device_specifier}` — no `creation_time` leaked. Group O: 14 assertions, 0 failures. Plan: `docs/planning/STABLE_DEVICE_SPECIFIER_ON_WRITES.md`.
- **CLI read commands block on specifier mismatch (2026-06-29):** 🟡 PLANNED. `ph view`/`ph list`/`ph tags` bail entirely when another device holds the cookie, showing nothing — not even local data. Fix: add `check_and_sync_readonly()` that pulls remote blob without claiming ownership. Plan: `docs/planning/CLI_READONLY_STAGING_SYNC.md`.
- **clearRemote() deletes wrong staging keys (2026-06-29):** ✅ FIXED (5244371). Was deleting `staging:blob` and `cookie:json` instead of canonical `staging/blobs/current.json` and `staging/blobs/device_cookie.bin`. This bug existed since the web app was built — staging data was never actually cleaned from R2. Tests updated. Added `scripts/compare_ledgers.py` tool for R2 format comparison.

## Browser E2E Testing Setup

- **Browser:** Vivaldi with `--remote-debugging-port=9222`. Connect via `agent_browser: connect 9222` with `sessionMode: "fresh"`.
- **Tab rule:** After connecting, run `tab list` → find tab with `localhost:5173` (or 4173) → `tab t<N>` to switch. **Do NOT open new tabs** — reuse the existing one. If server restart opens a new tab, find it via `tab list` by URL.
- **Dev server:** Start with `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Production preview:** `cd phpoc-web && npx vite preview --host 0.0.0.0 --port 4173`
- **WASM crypto is fixed** — artifacts bundled from `src/crypto/wasm/`, Vite handles `.wasm` via `new URL()` asset references.
- **Job mode (`steps`)** works for batched fills.

## Test Ledger Credentials

- **Active Browser Ledger Credentials (William Acevedo — 2026-06-28)**

- **Passphrase:** `VZQKp6TrIBK/GUtsjoof75HRyzd7w8S0`
- **Recovery Seed:** `Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=`
- **Username:** `William Acevedo` | **Email:** `william.acevedo@gmail.com`
- **Ledger:** 1 genesis block, 2 staging entries (0 committed)
- **Export file:** `testdata/e2e_export.phpledger` (v2, 2.7KB)

- **Original Test Ledger Credentials (for reference)**

- **Passphrase:** `VZQKp6TrIBK/GUtsjoof75HRyzd7w8S0`
- **Master seed:** `hopULgZOX/cpcLTlur/T0jbt9gV5Q/w/FEBMpLnR6oA=`
- **Username (original):** `testuser` | **Email:** `test@example.com`
- **Username (IndexedDB):** `testuser01` | **Email:** `testuser01@testemail.com`
- **Seed (IndexedDB):** `3NSUU8u14HeKokyV0ZSKQ3m3uVocd50S6tIU6lOUnDo=`
- **Ledger:** 2 blocks (genesis + 1 day block), 3 entries ("Working on Phpoc-web" ×2, "Pushups") + 1 test entry "Test Duplication Bug"

## Testing Quick Reference

| Resource | Value |
|----------|-------|
| **Worker URL** | `https://phpoc-staging-testing.wacevedo.workers.dev` |
| **R2 bucket** | `phpoc-data-testing` |
| **Test ledger path** | `~/code/phpoc-testing-data/phpoc-robertwallace.json` |
| **phpoc-web URL** | `http://localhost:5174/?dev=false` (5173 occupied; 5174 assigned) |
| **Worker configs** | `worker/wrangler.toml` (production, `phpoc-data`) / `worker/wrangler.testing.toml` (testing, `phpoc-data-testing`) |

> **Credentials** (API key, passphrase, recovery seed, wrangler token) are stored locally outside the repo. Ask the user to provide them if needed.
