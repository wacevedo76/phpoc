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

### 🔴 Phase 4 (current): Connect to Existing Worker — Onboarding Flow (2026-06-20)

**Pivot rationale:** Companion bridge server (Python, ~80-100 lines) is useful for self-hosting but deferred. "Connect to existing Worker" during onboarding is more immediately valuable — it enables real Worker end-to-end testing today, lets us exercise the remote sync pipeline (GenesisGate + SyncService + LedgerMerge) against a live Worker, and surfaces the cross-client concerns (passphrase verification against genesis, chain pull from remote, remote config persistence) that Flutter will need.

**Feature:** A fourth onboarding path — "Connect to existing Worker" — that lets a user connect a new browser/device to a ledger already hosted on Worker → R2.

**What already exists (all GREEN):**
- `HttpTransport` — speaks Worker HTTP API from browser (49 tests)
- `HttpBackend` — wraps Transport → StorageBackend (41 tests)
- `GenesisGate.check()` — fetches remote `ledger:blocks`, validates format/seals/linkage, compares genesis hashes (89 tests)
- `SyncService.checkAndSync()` — local ↔ remote sync with auth gate, respects genesis gate (45 tests)
- Settings UI genesis check + status indicator (13 tests)
- `LedgerMerge.merge()` — reconciles divergent same-genesis chains (99 tests)
- Remote config persistence (`baseUrl`, `apiKey`) in localStorage via `RemoteConfig` (35 tests)

**What needs to be built:**

1. **Onboarding UI** — new "Connect to existing Worker" card in `OnboardingScreen.jsx`
   - Worker URL + API key inputs (reuse pattern from Settings)
   - "Connect" button triggers remote fetch + validation
   - Status feedback: checking → compatible → proceed to passphrase entry
   - Error states: offline, 403 (bad API key), incompatible genesis, no ledger found

2. **Remote fetch during onboarding** — pull `ledger:blocks` from Worker
   - Use `GenesisGate._fetchRemoteChain()` (or direct `HttpTransport.pull()`)
   - Validate genesis block structure (format_version, type, identity, seal)
   - Write `ledger:blocks` + `ledger:index` to IndexedDB
   - Store `baseUrl` + `apiKey` via `RemoteConfig.save()`

3. **Passphrase verification against pulled genesis**
   - User enters passphrase → PBKDF2 → PDK → AES-decrypt `genesis.identity.recovery_seed_enc` → seed
   - Seed → derive master key → verify genesis seal → correct passphrase
   - Fail → "Wrong passphrase for this ledger" (do NOT write anything)
   - Auth completes → master key cached → transition to Dashboard

4. **Sync staging blobs after auth**
   - After passphrase success: `SyncService.checkAndSync()` pulls staging blob + cookie from Worker
   - Merge remote staging entries into local cache
   - Push local cookie to Worker

**Tests needed (~20–25 tests):**
- `test/worker_connect_onboarding_test.mjs` — new test file
  - Group A (UI): render, input validation, Connect button enable/disable
  - Group B (fetch): successful chain pull, 404 (no ledger), 403 (bad API key), network error
  - Group C (genesis validation): valid genesis → compatible, missing identity → error, tampered seal → error, format_version mismatch → incompatible
  - Group D (passphrase): correct passphrase unlocks, wrong passphrase rejected, no writes on wrong passphrase
  - Group E (config persistence): URL + API key saved to localStorage after successful connect, cleared on reset
  - Group F (existing data protection): existing IndexedDB data not destroyed by failed connect attempt

**Effort estimate:** ~250–300 LOC implementation, ~20–25 tests

---

### After Connect to Worker

2. **Companion bridge server** (Python, ~80-100 lines) — same HTTP API as Worker, enables CLI ↔ web without remote infra. Deferred until after Worker connect flow is solid.
3. **Docker + multi-tenant Worker** — one-command deploy for self-hosted users.

> Full historical step-by-step status is in `docs/planning/WEB_ROADMAP.md`. This file is the session-level snapshot.

## Known Issues
- `HttpTransport.delete()`: `timeoutMs` parameter accepted but unused. `AbortSignal.timeout()` not yet wired.
- MockRemoteBackend `listFiles()` returns full paths; Worker strips prefix to return filenames only. Pre-existing inconsistency.
- ETag caching stale in long-running daemon mode (CLI-only, low priority).
- WASM CryptoService dynamic import (`@vite-ignore`) may fail in dev HMR mode — falls back to DummyCryptoService transparently.
- IndexedDB unavailable in private/incognito browsing — falls back to in-memory storage (`FallbackStorage`), data lost on refresh. Now cached at module level so it survives logout/login within the same session.
- **Ledger merge — GREEN (2026-06-19):** `LedgerMerge.merge()` implemented in `src/ledger/merge.js`. 7-step algorithm + Step 0 input chain validation. 99 assertions, 0 failures. ⏭ Next: Wire into genesis compatibility gate.
- **Genesis gate — GREEN (2026-06-20):** `GenesisGate.check()` fully implemented. Fetches remote chain, validates format/seals/linkage, compares genesis hashes, delegates to `LedgerMerge.merge()`. 89 assertions, 0 failures. ⏭ Code review done, Settings/Sync integrations done.
- **Genesis gate integration — DONE (2026-06-20):** Code review completed (2 minor fixes). Settings UI shows genesis status indicator on Worker URL save. SyncService.checkAndSync() runs gate before blob sync (cached, skipped when no local ledger). New SyncResult.GENESIS_MISMATCH. 16 new tests, zero regressions.
- **Cross-platform JSON:** JavaScript `JSON.stringify()` and Python `json.dumps()` produce different whitespace and key ordering. The `jsonDumps()` helper in `ledger_import.js` bridges this for raw chain verification.
- **`isWasmDerivedUuid` regex too broad (2026-06-18):** The hex regex `/^[0-9a-f]{32,}$/` matches MD5 (32 chars), SHA-1 (40), and dash-stripped UUID4 (32 chars). Should be `{64}` for HMAC-SHA256. Low risk in practice.
- **Index-based staging operations have stale-index race (2026-06-18):** `end()`, `pause()`, `unpause()` call `readEntries()` to find an index, then call `update()` by that index. Between the read and write, another operation could change the array order.
- **`_getDeviceId()` called twice in push operations:** `pushToRemote()` calls it for `pushBlob` and again for `_pushCookie`.
- **`createStoragePlugin` lan/saas branch still creates `HttpBackend`:** The architecture decision says SaaS should be IndexedDB (local) + HttpTransport (remote), but the branch returns `HttpBackend` directly. Full storage unification deferred.
- **apiKey normalization differs between factories:** `createRemoteTransport` uses `|| null`, `createStoragePlugin` uses `|| ''`. Both intentional but divergent.
