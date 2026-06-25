# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md` to identify which docs this session's changes affect. Update those docs as part of the work.

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete)
- **CLI:** Maintenance mode — 1395 tests (31 files), onboarding redesign in progress (Phase 5d)
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **CLI Onboarding Redesign (2026-06-22):** E2E TDD test suite complete — 44 tests, all GREEN (was 27 GREEN / 13 RED). Wrong seed handling, chain divergence detection, and staging key mismatch (forensic quarantine + delete) all implemented.
- **Storage decision (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON). No adapter layer.
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests). Documented in `docs/design/DESIGN_MULTI_DEVICE_SESSION.md`.
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2). Full details in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.

## Immediate Next Steps

### 🔴 Onboarding File Import — Entry Hash Mismatch Fix ✅ (2026-06-25)

**Fixed:** `_verify_ledger_entry_hash()` in `cli/onboarding_file.py` used `indent=2` for entry hash computation while the Python engine (`engine.py`, `chain.py`) used no indent. This caused `ph onboarding file` to fail for all CLI-generated chains.

**Changes:**
- `cli/onboarding_file.py`: `_verify_ledger_entry_hash()` now tries both formats (no-indent first, then indent=2)
- `domain/ledger/engine.py`: entry hash now uses `indent=2` (matches web app `utils.js computeEntryHash`)
- `domain/ledger/chain.py`: `build_day_block()` uses `indent=2`; `verify()`/`verify_block()` use dual-format `_verify_entry_hash_flex()`
- Tests: 7 locations updated (`test_phase3_ledger_engine.py`, `test_phase6b_ledger_equivalence.py`, `test_tags.py`, `test_sync_confirmation.py`). All 1493 tests pass.

### 🔴 Phase 5c (Duplicate Commit Fix) — Browser E2E ✅ (2026-06-24)

**E2E verified in production build.** Created 2 tasks, committed via "Commit All (2)", verified ledger has exactly 2 blocks (genesis + 1 day block with 2 entries). No duplicate blocks. The `!e.committed` filter in `commitEntries` (line 1429) works correctly.

### 🔴 Step 1/2: Remove Dev-Mode Mock Bootstrap ✅ (2026-06-24)

**Done:** Removed `bootDevMode()` function (~130 lines) from `DevModeContext.jsx`. This function was the sole source of `DummyCryptoService`, `MockRemoteBackend`, and `MockDataSeeder` in the dev boot path. Both dev and production modes now follow the same boot path: create storage → check for existing data → landing/onboarding. The `isDev` flag and `toggleMode` remain for future UI use (dev badges, debug panels).

### 🔴 Step 2/2: Remove DummyCryptoService Fallbacks ✅ (2026-06-24)

**Done:** Removed all 6 `DummyCryptoService` try/catch fallback blocks from production flows (`login`, `createNewLedger`, `connectToWorker`, `importFromCloud`, `validateImport`, `exportLedgerAction`). Removed `import { DummyCryptoService }` line. All crypto init is now unconditional — WASM failure means an uncaught error, no silent degradation to dummy crypto. Updated `cryptoStatus` comment. Updated JSDoc header for DevModeContext. Total: 168 LOC removed. Zero regressions across all test suites.

**Remaining DummyCryptoService references:** Only in `src/services/DummyLedger.js` (definition) and `src/services/MockDataSeeder.js` (test helper) — neither imported by the app boot path.

### 🔴 Step 3/3: WASM Resolution Fix ✅ (2026-06-24)

**Done:** WASM artifacts copied from `phpoc-crypto-core/pkg/` into `phpoc-web/src/crypto/wasm/`. Import path changed from `../../../phpoc-crypto-core/pkg/` to `./wasm/`. Removed `build.rollupOptions.external` exclusion + `optimizeDeps.exclude` for `phpoc_crypto_core` — Vite now bundles the WASM glue JS and content-hashes the `.wasm` binary via `new URL()` asset references. Production build verified: `phpoc_crypto_core_bg-30LYJKWU.wasm` (134KB) + `phpoc_crypto_core-D9wuZLDO.js` (10KB), served with correct `application/wasm` MIME type. Browser E2E verified: app loads with real WASM crypto, no yellow warning banner. 96 crypto tests pass (22 smoke + 74 integration), zero regressions.

**Files changed:**
- `phpoc-web/src/crypto/wasm/phpoc_crypto_core.js` — NEW (copy from phpoc-crypto-core/pkg/)
- `phpoc-web/src/crypto/wasm/phpoc_crypto_core_bg.wasm` — NEW (copy from phpoc-crypto-core/pkg/)
- `phpoc-web/src/crypto/index.js` — updated import path + JSDoc
- `phpoc-web/vite.config.js` — removed external exclusion + optimizeDeps.exclude

### 🔴 Settings Genesis Gate — TDD RED: Component Tests ✅ (2026-06-25)

**Done:** Created `test/settings_genesis_component.test.mjs` — 26 Vitest + RTL component tests across Categories B (20), E (6), F (4). 24 pass (existing behavior verified), 2 RED (accessibility: aria-live="polite" on checking text + role="status" on status cards). Dev deps installed, vite.config.js updated with test block + jsdom environment, `test/vitest-setup.js` created.

- **Reference:** `docs/planning/SETTINGS_GENESIS_GATE_TDD_PLAN.md` — updated coverage map
- **Run:** `npx vitest run test/settings_genesis_component.test.mjs`

### 🟢 Settings Genesis Gate — TDD GREEN: Accessibility ✅ (2026-06-25)

**Done:** Added `aria-live="polite"` to checking text `<p>` + `role="status"` to `.genesis-status` container in `Settings.jsx`. All 26 component tests pass (was 24 ✅ / 2 🔴). Category F: 4/4 🟢 GREEN.

- ⏭ **Next:** Category C Browser E2E (8 tests, agent-browser session)

### 🔴 Settings Genesis Gate Integration — TDD Phase RED (2026-06-25)

**TDD test plan updated:** `docs/planning/SETTINGS_GENESIS_GATE_TDD_PLAN.md` — 54 tests across 6 categories (A–F). 24 🟢, 2 🔴, 28 planned.

- **Category A:** State Machine Logic — 13 tests (🟢 DONE)
- **Category B:** React Component Integration — 20 tests (🟢 DONE — 20 pass)
- **Category C:** Browser E2E — 8 tests (🟡 PARTIAL — 3 pass, 1 fail, 4 skipped)
- **Category D:** SyncService Genesis Gate — 3 tests (🟢 DONE)
- **Category E:** Edge Cases & Regressions — 6 tests (🟢 DONE — 6 pass)
- **Category F:** Accessibility & A11Y — 4 tests (🟢 DONE — 4 pass)

⏭ **Next:** 🔴 DECISION PENDING — Choose SyncService transport reconfiguration approach. Analysis at `docs/design/TRANSPORT_RECONFIGURATION_ANALYSIS.md`. Three solutions: A (localStorage reads), B (reconfigure() method), C (DevModeContext watcher). **Recommendation: Solution B** (~15 LOC, 2 files). Must decide before C2 E2E test can pass. Also investigate C5 (clear URL → status disappear) — fill command doesn't trigger React onChange, may need test methodology fix.

### Category C Browser E2E Results (2026-06-25)

**Preview server:** `http://localhost:4174/?dev=false` (port 4174 — 4173 was in use)

| Test | Result | Details |
|------|--------|--------|
| **C1** | ✅ PASS | "✅ Genesis compatible" + entry count shown for correct Worker URL + API key |
| **C2** | ❌ FAIL | Sync Now shows OFFLINE — SyncService transport configured at bootstrap, not updated on Settings save. Settings→save updates localStorage but SyncService still uses old/empty transport. Root cause: no mechanism to update SyncService transport in-flight after bootstrap. |
| **C3** | ⏭️ SKIP | Need Worker with different genesis; testing Worker appears empty (404 on `ledger:blocks`). No incompatible Worker available. |
| **C4** | ✅ PASS | "🔌 Cannot reach remote" + "Network error" for non-existent URL (`bad.example.com`) |
| **C5** | ⚠️ UNTESTABLE | `fill` command sets DOM `.value` but doesn't trigger React `onChange`. Can't clear URL field to test status→disappear flow via agent_browser. May pass with real user interaction; needs playwright or input event dispatch. |
| **C6** | ✅ PASS | API key change re-triggers genesis check. Wrong API key → "Authentication failed. Check your API key." |
| **C7** | ⏭️ SKIP | Requires clearing local ledger (destructive). Settings inaccessible during onboarding. |
| **C8** | ⏭️ SKIP | Settings page inaccessible without authentication (requires login → Settings path). |

**Additional finding:** The network trace revealed 3 pending requests to old bad URLs (`nonexistent-worker.example.com`, `bad.example.com`) left over from earlier save attempts — these are harmless but clutter the network panel.

### Browser E2E Testing Setup (2026-06-24)

- **Browser:** Vivaldi with `--remote-debugging-port=9222`. Connect via `agent_browser: connect 9222` with `sessionMode: "fresh"`.
- **Tab rule:** After connecting, run `tab list` → find tab with `localhost:5173` (or 4173) → `tab t<N>` to switch. **Do NOT open new tabs** — reuse the existing one. If server restart opens a new tab, find it via `tab list` by URL.
- **Dev server:** Start with `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173` (now works — WASM fix resolved the import path issue)
- **Production preview:** `cd phpoc-web && npx vite preview --host 0.0.0.0 --port 4173`
- **WASM crypto is NOW FIXED** — artifacts bundled from `src/crypto/wasm/`, Vite handles `.wasm` via `new URL()` asset references. No more DummyCryptoService fallback.
- **Re-auth overlay works** in production mode.
- **Job mode (`steps`)** works for batched fills.

### Test Ledger Credentials (2026-06-24)

- **Passphrase:** `VZQKp6TrIBK/GUtsjoof75HRyzd7w8S0`
- **Master seed:** `hopULgZOX/cpcLTlur/T0jbt9gV5Q/w/FEBMpLnR6oA=`
- **Username:** `testuser` | **Email:** `test@example.com`
- **Ledger:** 2 blocks (genesis + 1 day block), 2 entries committed

### 🟢 Commit→Push Wiring — TDD GREEN phase ✅ (2026-06-22)

**GREEN phase complete:** `await sync.pushLedgerBlocks()` wired into `DevModeContext.jsx:commitEntries` (line 1388).

**Additional fix:** `pushLedgerBlocks()` now uses `block.day_index ?? block.index` for cross-engine compatibility — real `LedgerEngine` produces blocks with `day_index`, test helpers use `index`. This was the root cause of the 16 integration test failures.

**Test results:** `commit_push_integration_test.mjs` — 14 tests, 60 assertions, all GREEN. Zero regressions across full web test suite.

**Files changed:**
- `phpoc-web/src/context/DevModeContext.jsx` — +2 lines in `commitEntries` (pushLedgerBlocks call + comment)
- `phpoc-web/src/sync/sync.js` — `pushLedgerBlocks()` field name fix (day_index with index fallback)
- `phpoc-web/test/commit_push_integration_test.mjs` — test data fixed (same-date entries, updated labels, GREEN markers)



### 🟢 Import/Export Test Coverage — Tier 1 Complete ✅ (2026-06-24)

**170 new tests written, all GREEN.** Closes the biggest coverage gap — raw chain import path, v2 format import, two-phase orchestration, and full roundtrip fidelity. No regressions in existing 112 tests. Total web import/export coverage: 282 tests across 8 files.

| File | Tests | Covers |
|------|:-----:|--------|
| `test/ledger_import_chain_test.mjs` | 31 | Raw chain: genesis detection, block seals, prev_hash linkage, entry hash validation, mixed block types, 6 error paths |
| `test/ledger_import_v2_test.mjs` | 42 | v2 format: genesis hash extraction, ledger+staging preservation, empty edge cases, active task preservation, seal tampering, wrong key |
| `test/import_orchestration_test.mjs` | 51 | Two-phase: validate→confirm, genesis gating, staging merge dedup, ID collision resolution, identity persistence, call guard |
| `test/ledger_roundtrip_test.mjs` | 46 | Roundtrip: v1/v2 fidelity, active/paused entries, rich metadata, deterministic seal, wrong key rejection |

**Zero red tests — nothing to fix in next session.**

### ⏭ Remaining Gaps (future work)

1. **Tier 2 — React component tests** (~9 tests): OnboardingScreen import form state machine — file picker gating, destroy warning display, checkbox gates, genesis error display. Requires adding `vitest` + `@testing-library/react` as dev dependencies.
2. **Tier 3 — Browser E2E** (~4 tests): Real browser flow with Playwright — full import from file picker, export from Settings, roundtrip in a fresh session.
3. **Same-genesis merge support**: `LedgerMerge.merge()` exists in `src/ledger/merge.js` but import rejects same-genesis with "merge not yet supported". Needs to be wired into `confirmImport`.
4. **Raw chain staging extraction**: CLI `ledger.json` import puts all entries inside `ledger:blocks` — no way to extract them into staging for editing or re-commit.

**Pending features (not yet implemented):**
- (none — import/export Tier 1 coverage complete, Tier 2/3 + merge staging for future sessions)

### 🔴 Phase 1 (TDD RED): Genesis Compatibility Gate — ✅ COMPLETE (2026-06-20)

Created:
- `phpoc-web/src/sync/genesis_gate.js` — full implementation (GREEN)
- `phpoc-web/test/genesis_gate_test.mjs` — 20 tests, 89 assertions, 0 failures.

Uses MockTransport (configurable: network errors, 403 auth failures, ETag simulation, latency), MockCrypto, TestHelpers, chain building helpers.

### 🟢 Phase 2 (complete): Genesis Gate — TDD GREEN ✅ (2026-06-20)

Implemented `phpoc-web/src/sync/genesis_gate.js`. Fetches remote `ledger:blocks`, validates format/type/seals/linkage, compares genesis hashes, delegates to `LedgerMerge.merge()`. In-flight dedup for concurrent calls. 8 reason codes. All 20 TDD tests pass (89 assertions, 0 failures). C2 test corrected (format_version is sealed → different hashes → genesis_mismatch).

⏭ Next: Integrate into Settings UI (`Settings.jsx`) and SyncService:
- Settings: genesis check fires on Worker URL save; shows status indicator (checking/compatible/incompatible/offline)
- SyncService: gate runs before any blob sync
- Settings UI tests (~9 tests): save triggers check, compatible/incompatible/checking/network-error states, reset on URL clear, API key change re-triggers
- Sync integration tests (~3 tests): SyncService respects gate result

---

### 🔴 Phase 3 (current): Code Review + Settings/Sync Integration ✅ COMPLETE (2026-06-20)

Code review completed (Modularity ✅, Clarity ✅, Security ✅, Efficiency ✅). Two findings:
- `TextDecoder` per-call → promoted to module-level `_textDecoder` constant
- Merge error catch silently reported `invalid_chain` for any merge error → removed try/catch, letting real errors surface

**Settings integration:** `Save` handler triggers genesis check on URL save; shows status indicator (checking/compatible/incompatible/offline/error) with reason/message. Check re-triggers on URL or API key change. Resets to idle on URL clear. Skips when no local ledger or no master key.

**SyncService integration:** `checkAndSync()` runs genesis gate before any blob sync (after transport confirm, before cookie check). Gate is cached (`_genesisCompatible`) and skipped when no local ledger exists. New `SyncResult.GENESIS_MISMATCH` return value. `resetGenesisGate()` clears cache for transport URL changes.

**Tests added:** `settings_genesis_test.mjs` (13 tests, 0 failures — save/compatible, genesis_mismatch, network_error, URL clear, API key change, no re-check on unchanged, skip on no ledger, skip on no MK, invalid URL). `sync_service_test.mjs` Group I (3 tests — compatible proceeds, mismatch returns GENESIS_MISMATCH, cache reset re-checks).

All 149 tests across genesis_gate (89), settings (13), sync_service (45), and all other suites pass with zero regressions.

**Code review findings addressed:** TextDecoder made static, merge error handling fixed (no longer masks internal errors as invalid_chain).

---

### 🟢 Phase 4 (complete): Connect to Existing Worker — Onboarding Flow ✅ (2026-06-20)

**Implemented:** OnboardingScreen has new "🔗 Connect to existing Worker" card. Two-step flow: (1) Enter URL + API key → Connect → fetches remote `ledger:blocks` via `HttpTransport`, validates genesis structure (type, format_version, identity, recovery_seed_enc, day_hash), shows compatible status. (2) Enter passphrase → Unlock → PDK derive → decrypt recovery_seed_enc → derive master key → verify genesis seal via `jsonSort`. `DevModeContext.connectToWorker()` does 8-step auth + storage write + remote config persist + bootstrap. 65 tests, 0 failures.

---

### 🟢 Phase 5 (complete): Remote Import from Cloud Storage ✅ (2026-06-20)

**Implemented:** `WorkerImportSource` class wraps `HttpTransport` to list backup files under `backups/` prefix and fetch individual `.json` export files. Abstract interface (`listBackups()`, `fetchBackup()`, `validateConnection()`) for future storage providers (S3, Google Drive, etc.). Built-in `fetchAndValidate()` combines fetch with full import validation (v1, v2, raw chain formats).

**OnboardingScreen changes:** Import phase now shows source selection (`importSource`: null → 'file' | 'cloud'). Cloud flow: Enter Worker URL + API key → Connect → list backups → select backup → detect auth mode (passphrase-only if genesis has `recovery_seed_enc`, else passphrase+seed) → authenticate → import.

**DevModeContext changes:** `importFromCloud()` action handles full 7-step flow: crypto init, transport/import source creation, PDK derivation (passphrase-only) or direct authenticate (passphrase+seed), `fetchAndValidate()`, genesis hash cross-check, storage write (seed, identity, ledger blocks, staging entries), remote config persist, bootstrap.

**Test suite:** `remote_import_test.mjs` — 57 assertions across 6 groups (A: connection validation, B: list backups, C: fetch backup, D: fetchAndValidate happy path, E: fetchAndValidate errors, F: edge cases). 0 failures.

**Files created:** `phpoc-web/src/sync/remote_import.js` (~300 LOC), `phpoc-web/test/remote_import_test.mjs` (~480 LOC).

**Files modified:** `phpoc-web/src/sync/index.js` (barrel exports), `phpoc-web/src/components/screens/OnboardingScreen.jsx` (cloud sub-source UI), `phpoc-web/src/context/DevModeContext.jsx` (`importFromCloud` action), `phpoc-web/src/App.jsx` (prop wiring).

**Zero existing tests modified.** Full suite passes with zero regressions.

### 🔴 Phase 5a (fix): Worker Connect — CLI Block Format Compatibility ✅ (2026-06-20)

**Problem:** Worker Connect flow pulled a single `ledger:blocks` key, but the CLI stores blocks as individual obfuscated files under `ledger/blocks/000000.json`. This caused "No ledger found" when connecting to Workers populated by the CLI.

**Fix:** `handleWorkerFetch` now tries `ledger:blocks` (single blob) first → falls back to `listFiles('ledger/blocks/')` (CLI format). For CLI format: blocks are obfuscated → username preview unavailable → shows block count instead. `handleWorkerUnlock` requires seed for CLI format (passphrase+seed → master key → de-obfuscation). `connectToWorker` handles CLI format branch: after auth, lists `ledger/blocks/`, fetches each block, de-obfuscates via `CryptoService.deobfuscateBlob()`, assembles chain, verifies genesis seal, writes to storage, bootstraps.

**Files modified:** `OnboardingScreen.jsx` (dual-format fetch, seed field + UI), `DevModeContext.jsx` (CLI format branch in connectToWorker).

**Zero existing tests broken** — all 65 worker connect tests pass. Full suite: 0 regressions.

### 🟢 Phase 5b.1 (complete): Multi-Device Auto-Sync Hook — GREEN ✅ (2026-06-20)

**Implemented:** `createAutoSync()` in `phpoc-web/src/hooks/useAutoSync.js`. Wraps all 6 SyncService mutation methods with debounced `pushToRemote()`. `isSyncing` true during debounce/push, false after completion. Push errors logged but don't break mutations. No master key → push skipped. `dispose()` cancels pending debounce, suppresses state updates during in-flight push.

**React hook:** `useAutoSync()` thin wrapper — `useRef` for instance, `setInterval` polling for `isSyncing` reactivity, `useEffect` cleanup calls `dispose()`. Methods wrapped in `useCallback`.

**SyncService change:** Added `getMasterKey()` method (accesses `this._crypto.getMasterKey()`).

All 24 assertions pass (58 assertions counting sub-checks), 0 failures.

### 🟢 Phase 5b.2 (complete): Auto-Sync Wiring — GREEN ✅ (2026-06-20)

**Implemented:** `DevModeContext.jsx` now wraps `services.sync` with `createAutoSync()` via a `useMemo`-based `effectiveServices` object. All 6 mutation methods (capture/end/pause/unpause/modify/remove) are replaced with auto-sync wrapped versions that trigger a debounced `pushToRemote()` after each call. Non-mutation methods (readEntries, checkAndSync, getCompleted, markCommitted, _local) pass through unchanged.

**Architecture:** `autoSyncRef` + `prevRawSyncRef` track the raw sync instance, recreating the `createAutoSync` wrapper only when the SyncService instance changes (e.g., after bootstrap or logout→login). The wrapper is cleaned up on unmount via `useEffect` return. `effectiveServices` is exposed through context as `services`, so all screen components (Dashboard, History, SyncSettings, NewTask) get auto-sync behavior transparently — no component changes needed.

**Key decisions:**
- Used `createAutoSync()` (pure function) directly, not `useAutoSync()` (React hook), since the context provider manages its own lifecycle via `useMemo` + `useRef`.
- `debounceMs: 500` — rapid mutations coalesce into a single push.
- Push errors are logged but never propagate to the caller (mutations always succeed).
- No master key → push silently skipped (local-only mode).
- **Bug fix:** `wrappedSync` uses a `Proxy` (not `...rawSync` spread) to preserve prototype methods (`getCompleted`, `markCommitted`, `_local`, etc.). Spreading only copies own enumerable properties — class methods are on the prototype and would be silently lost.

**Files modified:** `phpoc-web/src/context/DevModeContext.jsx` (imports, `effectiveServices` useMemo, context value).

**Zero test regressions** — all 28 test suites pass (1 pre-existing failure: MemoryBackend list).

### 🔴 Phase 5b.3 (fix): Auth Gate + Status Display + Reauth Overlay — RED/GREEN ✅ (2026-06-20)

**Problems found during live testing:**
1. **Auth gate blocked sync after Worker connect:** `checkAndSync()` unconditionally returned `REAUTH_NEEDED` when no local cookie existed, even though the master key was cached from the connect flow. The `reauthOverlay` in `App.jsx` is never triggered — no passphrase prompt appears. Result: sync does nothing after Worker connect.
2. **Status display misleading:** `displayStatus` in SyncSettings always showed "Not Synced" when staging entries existed, overriding the real remote sync status. After a successful sync, users still see "Not Synced" if they have uncommitted entries.

**Fixes:**
- `checkAndSync()` auth gate: when `!localCookie && masterKeyIsCached`, proceed to `_reconcileAndClaim()` instead of returning `REAUTH_NEEDED`. This establishes a first-time cookie and syncs staging blobs.
- `displayStatus` in SyncSettings: only shows `STATUS_NOT_SYNCED` when `remoteStatus !== STATUS_READY`. When sync succeeded, shows `STATUS_READY` even if entries exist.
- **Re-auth overlay wired end-to-end:** `triggerReauth()` sets `reauthActive=true` in DevModeContext, App.jsx renders `AuthScreen overlay`. `handleReauth()` (new) re-derives MK from passphrase+seed on existing crypto (no re-bootstrap), auto-runs `checkAndSync()`, then `setReauthActive(false)`. SyncSettings calls `triggerReauth()` when sync returns `REAUTH_NEEDED`.

⏭ Next: End-to-end integration testing of auto-sync behavior in the browser (dev mode: mutate entries → observe push debounce in MockRemoteBackend; production mode: mutate → observe HTTP push to Worker).

**Also pending:**
- Ledger blocks sync to R2 — after committing entries, ledger blocks remain local-only. Need to implement `pushLedgerBlocks()` and wire it into the commit flow.
- `SyncIndicator` should reflect `isAutoSyncing` from the auto-sync wrapper.
- `reauthOverlay` in `App.jsx` is never triggered (`setReauthOverlay(true)` called nowhere). TTL expiry on existing cookies cannot prompt for re-auth.

> Full historical step-by-step status is in `docs/planning/WEB_ROADMAP.md`. This file is the session-level snapshot.

## Known Issues
- **SyncService transport not updated on Settings change (2026-06-25):** Changing Worker URL/API key in Settings updates localStorage but does not update the SyncService's transport. `checkAndSync()` uses stale transport → returns OFFLINE. **Decision pending** — full tradeoff analysis at `docs/design/TRANSPORT_RECONFIGURATION_ANALYSIS.md`. Proposed fix: Solution B — expose `reconfigure(transport)` on SyncService, call from Settings after genesis check. Affects C2 browser E2E test.
- ~~**TDZ crash: `triggerReauth` before initialization** (2026-06-23): Cookie TTL monitor `useEffect` in `DevModeContext.jsx` referenced `triggerReauth` in its dependency array, but `const triggerReauth = useCallback(...)` was declared later in the component. Caused blank white page on any render — dev mode showed React boundary error, prod build showed `ReferenceError: Cannot access 've' before initialization`.~~ ✅ **FIXED (2026-06-23):** Moved re-auth state (`reauthActive`) + all three re-auth callbacks (`triggerReauth`, `dismissReauth`, `handleReauth`) above the cookie TTL monitor `useEffect`. App now renders onboarding screen correctly in both dev and production modes.
- ~~`HttpTransport.delete()`: `timeoutMs` parameter accepted but unused. `AbortSignal.timeout()` not yet wired.~~ ✅ **FIXED (2026-06-20):** `AbortSignal.timeout()` wired in all four methods (`pull`, `push`, `listFiles`, `delete`). 11 new tests (5 timeout-signal verification + 6 delete method coverage), 60 total transport tests, 0 failures.
- ~~MockRemoteBackend `listFiles()` returns full paths; Worker strips prefix to return filenames only. Pre-existing inconsistency.~~ ✅ **FIXED (2026-06-20):** `MockRemoteBackend.listFiles()` now strips prefix to return basenames only, matching Worker + Git transport contract. 3 test expectations updated across mock_remote_test.mjs and http_backend_test.mjs. Full suite passes.
- ~~ETag caching stale in long-running daemon mode (CLI-only, low priority).~~ ✅ **FIXED (2026-06-20):** Added `cacheTtlMs`/`cache_ttl_s` option to JS `HttpTransport` and Python `HttpStagingTransport`. Entries auto-evicted on access when older than TTL. New `evictStale()`/`evict_stale()` method for periodic daemon cleanup. 6 new TTL tests (JS), 66 total transport tests, 0 failures. Python syntax verified.
- ~~WASM CryptoService dynamic import unresolved in production build — Vite's `build.rollupOptions.external` excluded `phpoc_crypto_core` from bundling, causing the dynamic import to fail at runtime.~~ ✅ **FIXED (2026-06-24):** WASM artifacts copied into `src/crypto/wasm/`, import path updated to `./wasm/`, `external` exclusion and `optimizeDeps.exclude` removed. Vite now bundles the glue JS and content-hashes the `.wasm` binary via `new URL()` asset references. Production build verified, browser E2E verified — real WASM crypto loads with no fallback.
- ~~IndexedDB unavailable in private/incognito browsing — falls back to in-memory storage (`FallbackStorage`), data lost on refresh. Now cached at module level so it survives logout/login within the same session.~~ ✅ **FIXED (2026-06-20):** Cascade fallback: IndexedDB → `SessionStorageBackend` (survives refresh in private browsing, uses `window.sessionStorage`) → in-memory Map (last resort). `SessionStorageBackend` auto-falls-back to Map on quota errors. `storageStatus` state exposed to UI with amber (session) or red (memory) warning banners. All existing tests pass.
- **Ledger merge — GREEN (2026-06-19):** `LedgerMerge.merge()` implemented in `src/ledger/merge.js`. 7-step algorithm + Step 0 input chain validation. 99 assertions, 0 failures. ⏭ Next: Wire into genesis compatibility gate.
- **Genesis gate — GREEN (2026-06-20):** `GenesisGate.check()` fully implemented. Fetches remote chain, validates format/seals/linkage, compares genesis hashes, delegates to `LedgerMerge.merge()`. 89 assertions, 0 failures. ⏭ Code review done, Settings/Sync integrations done.
- **Genesis gate integration — DONE (2026-06-20):** Code review completed (2 minor fixes). Settings UI shows genesis status indicator on Worker URL save. SyncService.checkAndSync() runs gate before blob sync (cached, skipped when no local ledger). New SyncResult.GENESIS_MISMATCH. 16 new tests, zero regressions.
- ~~Cross-platform JSON: JavaScript `JSON.stringify()` and Python `json.dumps()` produce different whitespace and key ordering. The `jsonDumps()` helper in `ledger_import.js` bridges this for raw chain verification.~~ ✅ **FIXED (2026-06-20):** `jsonSort()` in `src/ledger/utils.js` upgraded to produce Python-compatible JSON (`": "` and `", "` spacing, sorted keys at all nesting levels). All source callers updated: `ledger_export.js`, `ledger_import.js`, `summary_policy.js`, `local_cache.js`, `MockDataSeeder.js`. `LedgerChain.verifySeal()` has dual-verification fallback for pre-migration compact-JSON ledgers. New `utils_test.mjs` (27 tests) verifies Python parity. 7 test files updated. Zero regressions across full suite.
- ~~`isWasmDerivedUuid` regex too broad (2026-06-18): The hex regex `/^[0-9a-f]{32,}$/` matches MD5 (32 chars), SHA-1 (40), and dash-stripped UUID4 (32 chars). Should be `{64}` for HMAC-SHA256. Low risk in practice.~~ ✅ **FIXED (2026-06-20):** Hex regex tightened to `/^[0-9a-f]{64}$/i` (exact SHA-256 length). Hyphenated path now strips dashes and checks for exactly 64 hex chars. 6 new test cases (MD5, SHA-1, dash-stripped UUID4, SHA-512, hyphenated 64-char, hyphenated 128-char). 28 total device_uuid tests, 0 failures.
- ~~Index-based staging operations have stale-index race (2026-06-18): `end()`, `pause()`, `unpause()` call `readEntries()` to find an index, then call `update()` by that index. Between the read and write, another operation could change the array order.~~ ✅ **FIXED (2026-06-20):** Added `update_by_entry_id`, `add_pause_by_entry_id`, `close_pause_by_entry_id` to `LocalStagingCache` — find by stable UUID instead of positional index. `StagingService.end()/pause()/unpause()` use entry_id path when available, falling back to index for legacy entries without entry_id. 10 new tests (7 LocalStagingCache + 3 StagingService integration). Full suite: 1293 tests, 0 failures.
- ~~`_getDeviceId()` called twice in push operations: `pushToRemote()` calls it for `pushBlob` and again for `_pushCookie`.~~ ✅ **FIXED (2026-06-20):** `pushBlobOnly()` now accepts optional `deviceId` parameter to skip redundant `_getDeviceId()` call. `_reconcileAndClaim` passes its already-computed `localDeviceUuid` through to both `pushBlobOnly()` calls (Case A + Case B) and reuses it for cookie creation instead of calling `_getDeviceId()` a third time. Reduced from 2-3 calls to exactly 1. 5 new tests (Group J), 53 total sync_service tests, 0 failures.
- ~~`createStoragePlugin` lan/saas branch still creates `HttpBackend`: The architecture decision says SaaS should be IndexedDB (local) + HttpTransport (remote), but the branch returns `HttpBackend` directly. Full storage unification deferred.~~ ✅ **FIXED (2026-06-20):** `createStoragePlugin` now returns `IndexedDBBackend` for `lan`/`saas` deployments — matching the target architecture where storage (IndexedDB) and transport (HttpTransport) are separate concerns. Removed `HttpBackend` import from `plugin_factory.js`. Updated `storage_plugin_test.mjs`: `createStoragePlugin` saas/lan tests now assert `IndexedDBBackend`; HttpBackend test section rewritten to use `{ transport }` constructor with a mock transport (get/set round-trip, remove, list, clear throws). 94 passed, 1 pre-existing failure (MemoryBackend list).
- ~~**apiKey normalization differs between factories:** `createRemoteTransport` uses `|| null`, `createStoragePlugin` uses `|| ''`. Both intentional but divergent.~~ ✅ **FIXED (2026-06-20):** `readRemoteConfig()` and `detectDeployment()` now normalize absent `apiKey` to `null` (was `''`). `createRemoteTransport()` already normalized to `null` — the source now matches the sink. 7 new tests in `remote_config_test.mjs` (explicit deployment, URL param, auto-detect, LAN paths). Full suite: 53 passed, 0 failures.
- ~~**Code review: useAutoSync.js (6 findings)** — stale `useCallback` closures, `require('react')` in ES module, 100ms polling inefficiency, `_syncing` state leak on dispose-during-push, dead `_disposed` check in setTimeout, silent `{}` fallback with `?.()`.~~ ✅ **FIXED (2026-06-20):** All 6 findings resolved:
  - `useCallback` now reads from `instanceRef.current` at call time (stable ref, always current)
  - Replaced `require('react')` with standard ES `import { useRef, useEffect, useCallback, useState } from 'react'`
  - Replaced 100ms polling with push-based `onSyncingChange` callback — React `isSyncing` state updates only on actual transitions
  - `_syncing` reset unconditionally in `finally` block (no longer suppressed by `_disposed`)
  - Removed dead `if (_disposed) return;` in setTimeout callback (clearTimeout handles debounce-phase disposal)
  - Removed `{}` fallback; lazy init ensures `instanceRef.current` is always assigned before callbacks fire
  - Renamed `_wrap` → `_wrapMutation` for clarity; added comment to `_schedulePush` about reset+start behavior
  - Removed defensive `sync.getMasterKey ?` guard — contract now enforced
  - 58 assertions pass, 0 failures; zero regressions across all 28 test suites
- ~~**Genesis gate: empty remote treated as incompatible** (2026-06-21): `genesis_gate.js` returned `{compatible: false, reason: 'no_remote_ledger'}` for empty R2 buckets, causing `checkAndSync()` to cache `_genesisCompatible = false` and return `GENESIS_MISMATCH` — permanently blocking all staging sync.~~ ✅ **FIXED (2026-06-21):** Empty remote now returns `{compatible: true, mergedChain: localChain, stats: {local, remote: 0, merged: local}}` — empty bucket = first boot, no conflict. Updated A4 test (8 assertions → compatible true + mergedChain checks).
- ~~**Genesis merge result never persisted** (2026-06-21): `checkAndSync()` only cached `_genesisCompatible` boolean, discarding the `mergedChain` from `GenesisGate.check()`. Every `checkAndSync()` call re-merged without writing results.~~ ✅ **FIXED (2026-06-21):** `sync.js` now captures full result object, writes `result.mergedChain` to `storage.set('ledger:blocks')` and `result.index` to `storage.set('ledger:index')` when genesis is compatible.
- ~~**"Sync Now" button only synced staging blob, never committed to ledger** (2026-06-21): The web app's "Sync Now" called `checkAndSync()` (staging blob sync) but never committed entries to the ledger — unlike the CLI `sync` command which does both.~~ ✅ **FIXED (2026-06-21):** `SyncSettings.jsx` `handleSyncNow` now runs `checkAndSync()` → then auto-commits all completed entries via `commitEntries()`. Also updated stale hint text ("auto-sync coming in Phase 2" → "Staging changes auto-sync in background").
- **Testing Worker deployed** (2026-06-21): `phpoc-staging-testing.wacevedo.workers.dev` bound to R2 bucket `phpoc-data-testing`. Config at `worker/wrangler.testing.toml`. API key stored locally.
- ~~**Export Ledger: error swallowed + staging-only export** (2026-06-24): When pressing Export Ledger in Settings and entering passphrase, nothing happened. Two bugs: (1) `handleExport` re-threw errors but PassphraseModal called `onSubmit` without `await`, making errors unhandled promise rejections — modal stayed open with no feedback. (2) `exportLedgerAction` used v1 format (`exportLedger()`) which exports staging entries only; once entries are committed, staging is empty → "No entries to export." silently swallowed.~~ ✅ **FIXED (2026-06-24):** (1) `handleExport` now sets `exportError` state instead of re-throwing; PassphraseModal receives `errorMessage={exportError}`. (2) `exportLedgerAction` now exports full ledger (committed blocks + staging) using `exportLedgerFull()`. Import added in DevModeContext.jsx. Both fast path and slow path updated. Browser E2E verified — export modal closes, download triggers with full ledger data. Zero regressions across 40 test files.

## Testing Quick Reference

| Resource | Value |
|----------|-------|
| **Worker URL** | `https://phpoc-staging-testing.wacevedo.workers.dev` |
| **R2 bucket** | `phpoc-data-testing` |
| **Test ledger path** | `~/code/phpoc-testing-data/phpoc-robertwallace.json` |
| **phpoc-web URL** | `http://localhost:5173/?dev=false` |
| **Worker configs** | `worker/wrangler.toml` (production, `phpoc-data`) / `worker/wrangler.testing.toml` (testing, `phpoc-data-testing`) |

> **Credentials** (API key, passphrase, recovery seed, wrangler token) are stored locally outside the repo. Ask the user to provide them if needed.

## Files Changed This Session (2026-06-22)

| File | Change |
|------|--------|
| `core/sync/transport_registry.py` | **NEW** — `TransportProvider` dataclass, `TransportRegistry`, `create_transport_from_config`, built-in providers (git, http-cloudflare, http-generic), singleton |
| `tests/test_transport_registry.py` | **NEW** — 50 tests (all GREEN): TransportProvider, TransportRegistry, built-ins, factories, prompts, singleton |
| `tests/test_onboarding_e2e.py` | **NEW** — 44 E2E tests (all GREEN) for Phase 5d onboarding redesign |
| `cli/onboarding.py` | Added `run_onboarding_picker()`. Removed `run_onboarding_http()`. Fixed `_pull_ledger_blocks()` (wrong seed catch + chain divergence detection). Fixed `_pull_staging()` (staging key mismatch → forensic quarantine + remote delete). Added `_handle_staging_key_mismatch()`. |
| `core/sync/transport.py` | Added `delete()` method to `AbstractStagingTransport`. `create_transport_from_config` now delegates to registry. |
| `core/sync/http_transport.py` | Added `delete()` via HTTP DELETE |
| `core/sync/git_transport.py` | Added `delete()` via git rm + commit + push |
| `main.py` | Renamed `onboarding remote` → `onboarding git` ("remote" deprecated alias). Added `onboarding http cloudflare` + `onboarding http generic`. Added bare `ph onboarding` → interactive picker. Dispatch uses registry. |
| `docs/reference/MAP.md` | Updated: new files, test count 1341→1445, `cli/onboarding.py` description |
| `tests/test_phase5_main_wiring.py` | Added `TestOnboardingArgparse` — 16 CLI dispatch tests (git, remote alias, http cloudflare/generic, file, bare picker) |
| `tests/test_onboarding_e2e.py` | Added `TestE2E_08_RegistryCreateTransportFromConfig` (6 tests) + `TestE2E_09_RegistryIntegrationWithOnboarding` (8 tests) — registry-based E2E flows |
| `docs/reference/MAP.md` | Updated test count 1445→1475, test file descriptions |
| `SESSION_HANDOFF.md` | Marked items 7+8 DONE, updated next steps
| `tests/test_onboarding_e2e.py` | Added `TestE2E_10_OnboardingPicker` (8 tests) + `TestE2E_11_RealTransportIntegration` (10 tests) — picker UI menu + real transport E2E verification. Phase 5d green phase complete.
| `docs/reference/MAP.md` | Updated test count 1475→1493
| `SESSION_HANDOFF.md` | Marked items 9+10 DONE, Phase 5d final status |
| `docs/planning/PUSHLEDGERBLOCKS_TDD_PLAN.md` | **NEW** — TDD test plan for `pushLedgerBlocks()`: 31 tests across 7 categories (A-G). RED phase — tests not yet written. |
| `SESSION_HANDOFF.md` | Updated Immediate Next Steps: Phase 5d complete, added `pushLedgerBlocks()` TDD as next item |
| `docs/reference/MAP.md` | Added new planning doc + upcoming test file + corrected test count to 1493 |

## Files Changed This Session (2026-06-22)

| File | Change |
|------|--------|
| `phpoc-web/test/ledger_sync_test.mjs` | **NEW** — 31 TDD tests (35 assertions) for `pushLedgerBlocks()` across 7 categories (A-G). All RED — method not implemented. MockTransport with listFiles + error simulation, MockCrypto with obfuscateBlob/deobfuscateBlob, helpers (makeBlock, makeIndex, pushBlocksToRemote, readPushedBlock), testBlock wrapper for clean RED reporting. |
| `docs/planning/PUSHLEDGERBLOCKS_TDD_PLAN.md` | Updated status: tests written (was "not yet written") |
| `docs/planning/WEB_ROADMAP.md` | Added build step 44 — pushLedgerBlocks TDD RED phase (31 tests, all fail) |
| `docs/reference/MAP.md` | Updated `ledger_sync_test.mjs` from 🔜 to 🔴 RED |
| `phpoc-web/AGENTS.md` | Updated test file count: 25 → 26; added Node test run command |
| `SESSION_HANDOFF.md` | Updated Immediate Next Steps: pushLedgerBlocks RED complete, GREEN pending |

## Files Changed This Session (2026-06-22)

| File | Change |
|------|--------|
| `phpoc-web/src/sync/sync.js` | **Added `pushLedgerBlocks()` method** — lists remote indices, pushes only new blocks (JSON+obfuscated), pushes index after blocks. Sorted by index. Error-resilient (catches + logs, returns count). Added `_base64ToBytes()` cross-platform helper. |
| `docs/planning/PUSHLEDGERBLOCKS_TDD_PLAN.md` | Updated status: 🟢 GREEN (was 🔴 RED) — implementation complete |
| `docs/planning/WEB_ROADMAP.md` | Added build step 44.2 — pushLedgerBlocks GREEN (76 assertions, 0 failures) |
| `docs/reference/MAP.md` | Updated `sync.js` description + `ledger_sync_test.mjs` from 🔴 RED to 🟢 GREEN |
| `SESSION_HANDOFF.md` | Updated Immediate Next Steps: pushLedgerBlocks GREEN complete, wiring pending |
| `docs/planning/COMMIT_PUSH_WIRING_TESTS.md` | **NEW** — TDD test outline for commit→push wiring: 14 tests across 4 categories (A-D), execution plan, files affected |
| `SESSION_HANDOFF.md` | Added commit→push wiring as 🔴 Next section with test outline reference

## Files Changed This Session (2026-06-22)

| File | Change |
|------|--------|
| `phpoc-web/test/commit_push_integration_test.mjs` | **NEW** — 14 tests, 61 assertions for Commit→Push Wiring TDD. 47 pass (commit flow, result preservation, regression), 14 RED (blocks not on remote — `pushLedgerBlocks` not yet wired into `commitEntries`). Uses real `LedgerEngine` + `SyncService` with MockTransport/MockCrypto/MemoryBackend. `commitEntriesFlow()` helper mirrors DevModeContext pattern. |
| `docs/planning/COMMIT_PUSH_WIRING_TESTS.md` | Updated status: RED (tests written, 47/14) |
| `docs/planning/WEB_ROADMAP.md` | Added build step 45 — Commit→Push Wiring TDD RED (47 pass / 14 RED) |
| `docs/reference/MAP.md` | Added `commit_push_integration_test.mjs` (🔴 RED); test count 1493→1554 |
| `phpoc-web/AGENTS.md` | Updated test file count: 26 → 27 |
| `SESSION_HANDOFF.md` | Updated Immediate Next Steps: Commit→Push RED complete, GREEN pending |

## Files Changed This Session (2026-06-21)

| File | Change |
|------|--------|
| `worker/wrangler.testing.toml` | **NEW** — Testing Worker config bound to `phpoc-data-testing` |
| `phpoc-web/src/sync/genesis_gate.js:103-111` | Empty remote → `compatible: true` (was `false`) |
| `phpoc-web/src/sync/sync.js:407-441` | Genesis check captures full result; writes merged chain to storage |
| `phpoc-web/src/components/screens/SyncSettings.jsx:667-730` | "Sync Now" now runs checkAndSync → auto-commits all completed entries |
| `phpoc-web/src/components/screens/SyncSettings.jsx:1113-1116` | Updated hint text (stale "Phase 2" → accurate description) |
| `phpoc-web/src/context/DevModeContext.jsx:1377` | `commitEntries` filters `!e.committed` to skip already-committed entries |
| `phpoc-web/test/genesis_gate_test.mjs:399-421` | A4 test updated for empty remote → compatible:true |
| `docs/design/workflows/web/Remote_Local-Workflow.md` | Removed 2 fixed known gaps; updated SyncSettings diagram |
| `SESSION_HANDOFF.md` | Added Phase 5c, duplicates context, testing quick reference |

## Files Changed This Session (2026-06-22)

| File | Change |
|------|--------|
| `docs/planning/REAUTH_TTL_TDD_PLAN.md` | Updated status: tests written (was "not yet written") |
| `phpoc-web/test/reauth_ttl_test.mjs` | **NEW** — 35 TDD tests for `checkCookieTtl()` + `createCookieMonitor()`, categories A–E. All RED. |
| `phpoc-web/test/reauth_integration_test.mjs` | **NEW** — 27 TDD tests for full re-auth integration, categories F–I. 18 GREEN (existing behavior), 9 RED (createCookieMonitor-dependent). |
| `phpoc-web/test/sync_service_test.mjs` | +2 tests (H7: MK cleared by TTL monitor → REAUTH_NEEDED, H8: fresh cookie after reauth → READY). Both GREEN. |
| `phpoc-web/test/auto_sync_hook_test.mjs` | +1 test (H3: auto-sync wrapper with getMasterKey null → mutations work, push skipped). GREEN. |
| `docs/reference/MAP.md` | Updated test file annotations (RED planned → RED), test count note |
| `docs/planning/WEB_ROADMAP.md` | Updated build step 48: RED phase complete (44 RED / 21 GREEN) |
| `phpoc-web/AGENTS.md` | Updated test file count: 30 test files (28→30) |
| `SESSION_HANDOFF.md` | Updated this section |

## Files Changed This Session (2026-06-22)

| File | Change |
|------|--------|
| `phpoc-web/src/hooks/useCookieMonitor.js` | **NEW** — `checkCookieTtl()` standalone + `createCookieMonitor()` pure function (~170 LOC). Poll-based cookie TTL monitor: fires immediate check on `start()`, interval polling, single-fire `onExpired` with `clearMasterKey()` first. Graceful: null storage/crypto, missing callback, read errors, callback crashes. Follows `createAutoSync` pattern. |
| `phpoc-web/src/context/DevModeContext.jsx` | **MODIFIED** — Imported `createCookieMonitor`, added `cookieMonitorRef` + useEffect for phase-based lifecycle. Monitor starts on `phase === 'ready'` with `onExpired: triggerReauth`, disposes on phase change (logout/rebootstrap) and unmount. `logout()` disposes monitor before clearing MK. |
| `docs/reference/MAP.md` | Updated `reauth_ttl_test.mjs` / `reauth_integration_test.mjs` from 🔴 RED → 🟢 GREEN; `useCookieMonitor.js` from 🔜 planned → HOT. |
| `docs/planning/WEB_ROADMAP.md` | Added build step 48.2 — GREEN phase complete (89 assertions, 0 failures). |
| `SESSION_HANDOFF.md` | Updated this section; completed GREEN phase write-up; updated next steps. |

### 🟢 Next: Re-auth Overlay TTL — GREEN Phase ✅ (2026-06-22)

**GREEN phase complete:** `checkCookieTtl()` + `createCookieMonitor()` implemented in `src/hooks/useCookieMonitor.js` (~170 LOC). Wired into `DevModeContext.jsx` ready-phase boot.

**Implementation details:**
- `checkCookieTtl(storage, ttlMinutes)` — validates cookie existence, specifier/creation_time fields, and TTL; cleans up corrupt/expired cookies
- `createCookieMonitor(storage, crypto, options)` — pure function (follows `createAutoSync` pattern): `start()` fires immediate check + interval polling, `dispose()` clears timer (idempotent), `isExpired()` exposes state
- On expiry: calls `crypto.clearMasterKey()` then `onExpired()` (single-fire, no duplicates)
- Graceful: handles null storage/crypto, missing onExpired, storage read errors, callback crashes
- **DevModeContext wiring:** useEffect watches `phase === 'ready'` + services, creates monitor with `onExpired: triggerReauth`, disposes on phase change/logout

**Test results:**
- `reauth_ttl_test.mjs` — 50 passed, 0 failed (was 35 RED, now all GREEN)
- `reauth_integration_test.mjs` — 39 passed, 1 test-only issue (F1d: mock sha256≠PBKDF2 in simulateReauth — MK mismatch on re-derive means remote blob can't be decrypted)
- Zero regressions across all existing test suites

**Known gap:** F1d fails because the test mock's `simulateReauth()` uses `sha256(seed:passphrase)` instead of PBKDF2 — produces a different MK than the original. In production, `handleReauth()` uses the real `crypto.authenticate(passphrase, seed, iterations)` which is deterministic — same inputs → same MK. Not a code bug.

### ⏭ Next: Duplicate commit fix (Phase 5c) — browser E2E testing

## Files Changed This Session (2026-06-24)

| File | Change |
|------|--------|
| `phpoc-web/src/context/DevModeContext.jsx` | **Steps 1+2 complete — mock purge.** Removed `bootDevMode()` (~130 LOC) + all 6 `DummyCryptoService` fallback blocks + `DummyCryptoService` import. Total: −168 LOC. Both dev and production now use real WASM crypto exclusively. No silent crypto degradation. |
| `phpoc-web/src/crypto/wasm/phpoc_crypto_core.js` | **NEW** — WASM glue JS copied from `phpoc-crypto-core/pkg/` for Vite bundling |
| `phpoc-web/src/crypto/wasm/phpoc_crypto_core_bg.wasm` | **NEW** — WASM binary (134KB) copied from `phpoc-crypto-core/pkg/` |
| `phpoc-web/src/crypto/index.js` | Updated dynamic import path: `../../../phpoc-crypto-core/pkg/` → `./wasm/`. Updated JSDoc path resolution comment. |
| `phpoc-web/vite.config.js` | Removed `build.rollupOptions.external` exclusion + `optimizeDeps.exclude` for `phpoc_crypto_core`. WASM now bundled by Vite's native pipeline. |
| `phpoc-web/AGENTS.md` | Updated: DevModeContext description — dev mode no longer uses mock services, no DummyCryptoService fallbacks |
| `docs/reference/MAP.md` | Added crypto/wasm files to web section. Updated DevModeContext.jsx description. |
| `docs/planning/WEB_ROADMAP.md` | Added build steps 50, 51, 52 — mock purge (Steps 1+2) + WASM Resolution Fix |
| `SESSION_HANDOFF.md` | Removed WASM issue from Known Issues. Added Step 3/3 WASM fix to Immediate Next Steps. Updated this session's file changes. |
| `docs/design/workflows/web/Local_Import-Export-Workflow.md` | **NEW** — file-based import/export workflow: v1/v2/raw-chain formats, two-phase validation+confirmation, genesis gating, destroy warnings, key invariants, diagnostic checkpoints |
| `docs/design/workflows/web/AGENTS.md` | Updated ownership index — added Local_Import-Export-Workflow.md |
| `docs/design/workflows/AGENTS.md` | Updated contract — agent-only, concise+parseable, table-driven template for all workflow docs |
| `docs/design/workflows/cli/AGENTS.md` | Updated to mirror parent contract for CLI workflow docs |
| `phpoc-web/test/ledger_import_chain_test.mjs` | **NEW** — 31 tests for raw chain import path |
| `phpoc-web/test/ledger_import_v2_test.mjs` | **NEW** — 42 tests for v2 format import path |
| `phpoc-web/test/import_orchestration_test.mjs` | **NEW** — 51 tests for two-phase validate→confirm orchestration |
| `phpoc-web/test/ledger_roundtrip_test.mjs` | **NEW** — 46 tests for export→import roundtrip fidelity |
| `phpoc-web/AGENTS.md` | Updated test file count: 32 → 36 |
| `docs/reference/MAP.md` | Added 4 new test files + updated test count to 38 files ~1776 tests |
| `docs/planning/WEB_ROADMAP.md` | Added build step 53 — Import/Export Tier 1 coverage (170 tests, 0 fail) |
| `docs/planning/SETTINGS_GENESIS_GATE_TDD_PLAN.md` | **NEW** — TDD test plan for Settings Genesis Gate Integration: 54 tests across 6 categories (A–F). Phase RED — tests not yet written. |
| `SESSION_HANDOFF.md` | Updated: Settings Genesis Gate section → TDD RED phase. Added test creation as next to-do. Pointed to TDD plan for reference. |

## Files Changed This Session (2026-06-24) — Export Ledger Fix

| File | Change |
|------|--------|
| `phpoc-web/src/context/DevModeContext.jsx` | Imported `exportLedgerFull` alongside `exportLedger`. Updated `exportLedgerAction` to export full ledger (committed blocks + staging) using `exportLedgerFull()` — both fast path (services loaded) and slow path (on-demand init). Changed "No entries to export" → "No data to export" with OR logic. |
| `phpoc-web/src/components/screens/Settings.jsx` | Fixed `handleExport` error handling: added `exportError` state, set error instead of re-throwing (prevents unhandled promise rejection). Passed `errorMessage={exportError}` to PassphraseModal. Cleared error on modal open. |
| `SESSION_HANDOFF.md` | Added discovered bug to Known Issues (✅ FIXED). |

### Browser E2E Session Summary (2026-06-24)

- **Phase 5c verified:** Created 2 tasks on fresh production ledger, committed via "Commit All (2)", confirmed 2 ledger blocks (genesis + 1 day block, 2 entries). No duplicates. `!e.committed` filter working.
- **Genesis gate TDD plan:** `docs/planning/SETTINGS_GENESIS_GATE_TDD_PLAN.md` — 54 tests identified. Next: create 30 component tests (RED phase).
- **WASM issue resolved:** Dynamic import fixed — WASM artifacts bundled by Vite's native pipeline. Production build loads real WASM crypto.
- **Browser at `http://localhost:4173/?dev=false`** ready for next session. Start preview server: `cd phpoc-web && npx vite preview --host 0.0.0.0 --port 4173`.

## Files Changed This Session (2026-06-25) — Settings Genesis Gate RED Phase

| File | Change |
|------|--------|
| `phpoc-web/test/settings_genesis_component.test.mjs` | **NEW** — 26 Vitest + RTL component tests for Settings genesis gate (B: 20, E: 6, F: 4). 24 pass / 2 RED (accessibility). |
| `phpoc-web/test/vitest-setup.js` | **NEW** — `@testing-library/jest-dom` import |
| `phpoc-web/vite.config.js` | Added `test` block (jsdom environment, globals: true, setupFiles) |
| `phpoc-web/package.json` | Added dev deps: vitest, @testing-library/react, @testing-library/jest-dom, jsdom, @testing-library/dom |
| `phpoc-web/AGENTS.md` | Updated test file count: 36 → 37; added Vitest run command |
| `docs/planning/SETTINGS_GENESIS_GATE_TDD_PLAN.md` | Updated coverage map: B/E now 🔴 RED (written), F now 🔴 RED (2 pass / 2 RED), total 24 🟢 / 2 🔴 / 28 planned |
| `docs/planning/WEB_ROADMAP.md` | Added Build 54 — Settings Genesis Gate Component Tests RED phase |
| `docs/reference/MAP.md` | Added new test file entry |
| `SESSION_HANDOFF.md` | Updated Immediate Next Steps: RED → ✅ done, GREEN phase (accessibility) as next

## Files Changed This Session (2026-06-25) — Settings Genesis Gate GREEN Phase (Accessibility)

| File | Change |
|------|--------|
| `phpoc-web/src/components/screens/Settings.jsx` | Added `aria-live="polite"` to checking text `<p>` + `role="status"` to `.genesis-status` container |
| `docs/planning/SETTINGS_GENESIS_GATE_TDD_PLAN.md` | Updated status: 🟢 GREEN (was 🔴 RED). Coverage map: B/E/F all 🟢 GREEN. Total 50 🟢 / 4 planned. |
| `docs/planning/WEB_ROADMAP.md` | Added Build 55 — Settings Genesis Gate GREEN phase (Accessibility) |
| `SESSION_HANDOFF.md` | Marked GREEN phase ✅ DONE, updated Category F status to 🟢, next step: Category C Browser E2E |

## Files Changed This Session (2026-06-25) — Category C Browser E2E

| File | Change |
|------|--------|
| `SESSION_HANDOFF.md` | Updated Category C results (🟡 PARTIAL: 3 pass/1 fail/4 skip). Added C2 bug to Known Issues (→ analysis doc). Updated Next Steps with decision pending. |
| `docs/design/TRANSPORT_RECONFIGURATION_ANALYSIS.md` | **NEW** — Tradeoff analysis for SyncService transport reconfiguration (Solutions A/B/C). Recommendation: Solution B (reconfigure() method). Decision pending. |
| `docs/planning/SETTINGS_GENESIS_GATE_TDD_PLAN.md` | Category C status updated: 🔴 PLANNED → 🟡 PARTIAL with results table |
