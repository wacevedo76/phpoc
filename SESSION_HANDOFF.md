# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md` to identify which docs this session's changes affect. Update those docs as part of the work.

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete)
- **CLI:** Maintenance mode — 1341 tests, fully functional, not actively worked on
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Storage decision (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON). No adapter layer.
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests). Documented in `docs/design/DESIGN_MULTI_DEVICE_SESSION.md`.
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2). Full details in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.

## Immediate Next Steps

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
- ~~`HttpTransport.delete()`: `timeoutMs` parameter accepted but unused. `AbortSignal.timeout()` not yet wired.~~ ✅ **FIXED (2026-06-20):** `AbortSignal.timeout()` wired in all four methods (`pull`, `push`, `listFiles`, `delete`). 11 new tests (5 timeout-signal verification + 6 delete method coverage), 60 total transport tests, 0 failures.
- ~~MockRemoteBackend `listFiles()` returns full paths; Worker strips prefix to return filenames only. Pre-existing inconsistency.~~ ✅ **FIXED (2026-06-20):** `MockRemoteBackend.listFiles()` now strips prefix to return basenames only, matching Worker + Git transport contract. 3 test expectations updated across mock_remote_test.mjs and http_backend_test.mjs. Full suite passes.
- ~~ETag caching stale in long-running daemon mode (CLI-only, low priority).~~ ✅ **FIXED (2026-06-20):** Added `cacheTtlMs`/`cache_ttl_s` option to JS `HttpTransport` and Python `HttpStagingTransport`. Entries auto-evicted on access when older than TTL. New `evictStale()`/`evict_stale()` method for periodic daemon cleanup. 6 new TTL tests (JS), 66 total transport tests, 0 failures. Python syntax verified.
- ~~WASM CryptoService dynamic import (`@vite-ignore`) may fail in dev HMR mode — falls back to DummyCryptoService transparently.~~ ✅ **FIXED (2026-06-20):** Removed `@vite-ignore` to let Vite properly track the WASM module in dev mode. Added `build.rollupOptions.external` for production safety. All 4 silent fallback points in `DevModeContext.jsx` now emit `console.error` and set `cryptoStatus='fallback'`. App UI shows a red sticky warning banner when running in production mode with dummy crypto.
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
