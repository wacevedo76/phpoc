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

### 🔴 Next Steps

1. **Companion bridge server** (Python, ~80-100 lines) — same HTTP API as Worker, enables CLI ↔ web without remote infra.
2. **Docker + multi-tenant Worker** — one-command deploy for self-hosted users.
3. **End-to-end Worker testing** — test the full remote sync pipeline (GenesisGate + SyncService + LedgerMerge) against a live Worker from the browser.

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
- **Cross-platform JSON:** JavaScript `JSON.stringify()` and Python `json.dumps()` produce different whitespace and key ordering. The `jsonDumps()` helper in `ledger_import.js` bridges this for raw chain verification.
- **`isWasmDerivedUuid` regex too broad (2026-06-18):** The hex regex `/^[0-9a-f]{32,}$/` matches MD5 (32 chars), SHA-1 (40), and dash-stripped UUID4 (32 chars). Should be `{64}` for HMAC-SHA256. Low risk in practice.
- **Index-based staging operations have stale-index race (2026-06-18):** `end()`, `pause()`, `unpause()` call `readEntries()` to find an index, then call `update()` by that index. Between the read and write, another operation could change the array order.
- **`_getDeviceId()` called twice in push operations:** `pushToRemote()` calls it for `pushBlob` and again for `_pushCookie`.
- **`createStoragePlugin` lan/saas branch still creates `HttpBackend`:** The architecture decision says SaaS should be IndexedDB (local) + HttpTransport (remote), but the branch returns `HttpBackend` directly. Full storage unification deferred.
- **apiKey normalization differs between factories:** `createRemoteTransport` uses `|| null`, `createStoragePlugin` uses `|| ''`. Both intentional but divergent.
