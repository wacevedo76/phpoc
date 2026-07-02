# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md` to identify which docs this session's changes affect. Update those docs as part of the work.

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete, LedgerMerge TDD GREEN phase ✅ done, Step 5 export/import fix ✅ done, E2E Cross-Client Fix GREEN phase ✅ done, Onboarding Speedup GREEN phase ✅ done)
- **CLI:** Maintenance mode — onboarding redesign complete (Phase 5d), 1493 tests
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Storage (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON)
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests)
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2)
- **WASM crypto:** Bundled by Vite's native pipeline — `src/crypto/wasm/`, real WASM in both dev and production. No DummyCryptoService fallbacks.
- **phpoc-web IndexedDB state:** Active ledger — username `William Acevedo`, email `william.acevedo@gmail.com`. 1 genesis block, 2 staging entries (1 stopped, 1 active), 0 committed. Recovery seed: `Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=`. Dev server on port 5174 (5173 was occupied).

## Immediate Next Steps

### 🟢 Login Perf: Phase A+B Complete (2026-07-02)

**Status:** ✅ Phase A (8 new tests + 2 modified), Phase B1 (4 new tests + 5 modified), Phase B2 (GREEN implementation) all complete. **464 pass / 0 fail across genesis_gate and sync_service suites.**

Three of four root causes fixed:
1. **Hash index bootstrap gap** — outstanding. First-ever login still does full chain pull. Future: pre-seed hash_index during onboarding.
2. **`pushLedgerBlocks` gated on `merged` flag** — ✅ No longer calls `forceAll: true` on every login.
3. **Duplicate `pullCookie()` eliminated** — ✅ `_lastRemoteCookie` cache reuses fast-path result.
4. **`_genesisCompatible` cached to `true`** — ✅ Prevents redundant re-checks.

### 🔜 Step 6: Resume Tier 3 Browser E2E tests

#### ✅ Phase A: Test Creation (RED — COMPLETE 2026-07-02)

**Status:** ✅ RED phase complete — 8 new tests + 2 test modifications in `phpoc-web/test/sync_service_test.mjs`. 228/235 pass; 7 RED failures all validate existing bugs (228 pass, 7 fail).

**New tests (8):**
- **Group T (4 tests):** T1-T4 — Unnecessary push prevention (Tier 1 match, linear_local, divergent merge, same-chain ref). T1/T2/T4 RED (pushLedgerBlocks called unnecessarily), T3 GREEN (merge correctly triggers push).
- **Group U (2 tests):** U1-U2 — Duplicate pullCookie prevention. U1 RED (2 pulls found), U2 GREEN (fast path match pulls once).
- **Group V (2 tests):** V1-V2 — _genesisCompatible caching. V1 RED (null, not true), V2 RED (second call re-runs genesis gate — 2 extra pulls).

**Test modifications (2):**
- **M2:** Added pushCount assertion (M2c) — RED (7 pushes when 0 expected).
- **I3:** Fixed misleading comment about cache being set to true.

**Source changes (test support):**
- `phpoc-web/src/sync/sync.js`: Added `genesisCompatible` getter for V1 test assertion.
- `phpoc-web/test/sync_service_test.mjs`: Added `_pullCalls`/`_pushCalls` tracking + `resetCallTracking()` to MockTransport.

#### ✅ Phase B1: Test Creation (RED — COMPLETE 2026-07-02)

**Status:** ✅ RED phase complete — 4 new tests + 5 modifications in 2 test files. 5/5 merged-flag assertions RED in genesis_gate_test.mjs, 2/4 push-gating tests RED in sync_service_test.mjs.

**Genesis gate `merged` flag assertions (5 modifications — `phpoc-web/test/genesis_gate_test.mjs`):**
- **A4 (empty remote):** `t.assert(result.merged === true, ...)` — RED (merged undefined)
- **E1 (Tier 1 match):** `t.assert(result.merged === false, ...)` — RED (merged undefined)
- **F1 (linear_remote → merge):** `t.assert(result.merged === true, ...)` — RED (merged undefined)
- **F2 (Tier 2 linear_local):** `t.assert(result.merged === false, ...)` — RED (merged undefined)
- **F3 (divergent → merge):** `t.assert(result.merged === true, ...)` — RED (merged undefined)

**Sync service push gating (4 new tests — `phpoc-web/test/sync_service_test.mjs`, Group W):**
- **W1:** Empty remote → pushLedgerBlocks IS called — ✅ GREEN (existing behavior)
- **W2:** Full chain pull + identical chains (no hash_index) → pushLedgerBlocks NOT called — 🔴 RED (5 pushes when 0 expected)
- **W3:** Full chain pull + remote has more blocks (no hash_index) → pushLedgerBlocks IS called — ✅ GREEN (existing behavior)
- **W4:** Full chain pull + local extends remote (no hash_index) → pushLedgerBlocks NOT called — 🔴 RED (6 pushes when 0 expected)

**Summary:** 213 pass / 5 fail (genesis_gate_test.mjs) + 234 pass / 9 fail (sync_service_test.mjs). Total: 447 pass / 14 fail across both suites. The 5 genesis-gate merged-flag assertions all fail because `merged` isn't returned yet. The 2 sync-service W2/W4 tests fail because push gating doesn't exist yet for the full-chain-pull legacy path. W1/W3 pass because those cases legitimately need a push (and get one now).

**Note:** Used `t.assert(result.merged === ...)` instead of `t.assertEq(result.merged, ...)` because `TestHelpers.assertEq` crashes on `undefined` values (calls `.slice()` on `JSON.stringify(undefined)` which returns `undefined`, not a string).

Investigation found that `pushLedgerBlocks({ forceAll: true })` makes 11 unnecessary HTTP PUTs on every login. The fix requires a `merged: true/false` flag on GenesisGate return objects so `_genesisGatePhase()` can skip the push when nothing changed. Current Phase A tests (T1-T4, M2c) already cover the sync_service push gating for Tier 1/2 paths (all RED). Missing coverage:

**Genesis gate `merged` flag assertions (5 modifications):**
- **E1 (Tier 1 match):** Add `result.merged === false` (chains identical, no push needed)
- **F2 (Tier 2 linear_local):** Add `result.merged === false` (local extends remote, no push needed)
- **A4 (empty remote):** Add `result.merged === true` (remote empty, push IS needed)
- **F1 (linear_remote → merge):** Add `result.merged === true` (remote extends, push IS needed)
- **F3 (divergent → merge):** Add `result.merged === true` (actual merge, push IS needed)

**Sync service push gating (3 new tests):**
- **W1:** Empty remote → pushLedgerBlocks IS called (remote has no blocks, local must push)
- **W2:** Full chain pull + identical chains (no hash_index) → pushLedgerBlocks NOT called
- **W3:** Full chain pull + remote has more blocks (no hash_index) → pushLedgerBlocks IS called

**Files to touch:**
- `phpoc-web/test/genesis_gate_test.mjs` — add `t.assertEq(result.merged, …)` to E1, F2, A4, F1, F3
- `phpoc-web/test/sync_service_test.mjs` — add Group W (W1–W3)

#### ✅ Phase B2: Implementation (GREEN — COMPLETE 2026-07-02)

**Status:** ✅ GREEN phase complete — 218 pass / 0 fail (genesis_gate_test.mjs) + 246 pass / 0 fail (sync_service_test.mjs). Total: 464 pass / 0 fail. All 4 root causes from investigation addressed:

1. **`pushLedgerBlocks({ forceAll: true })` no longer runs on every login** — `_genesisGatePhase()` now gates on `result.merged` instead of `result.mergedChain` (which was always truthy). Only pushes when merge created new blocks (`stats.newBlockCount > 0`) or remote chain is structurally longer (`remoteChain.length > localChain.length`).
2. **`_genesisCompatible` now cached to `true`** — Set after successful genesis check in `_genesisGatePhase()`, preventing redundant re-checks on subsequent sync calls.
3. **Duplicate `pullCookie()` eliminated** — `_fastPathPhase()` stores `this._lastRemoteCookie`, reused by `_reconcileAndClaim()` if available. Falls back to network pull only when cache is empty.

**Source files changed:**
- `phpoc-web/src/sync/genesis_gate.js` — `merged` flag on all 4 return paths + full-pull merge path
- `phpoc-web/src/sync/sync.js` — gating, caching, cookie reuse, constructor init

**Test files changed:**
- `phpoc-web/test/sync_service_test.mjs` — M2 (resetCallTracking), M5 (updated expectations), W2b/W4b (remove RED suffixes), Group W header (GREEN phase)

### ✅ Phase 1: Onboarding/Unlock/ReAuth Speedup — Test Identification (DONE)

Full catalog at `docs/planning/ONBOARDING_SPEEDUP_TESTS.md`. ~62 new tests + ~15 modified across 5 files. Categories:
- **A (9 tests):** Hash index data structure — `buildHashIndex()`
- **B (13 tests):** Fork detection — `compareHashIndexes()`
- **C (10 tests):** Hash index push behavior in `pushLedgerBlocks()`
- **D (9 tests):** Tier 1 fast-path SHA-256 comparison
- **E (11 tests):** Tier 2 fork + incremental pull
- **F (7 tests):** Worker endpoint (optional, if endpoint approach chosen)
- **G (10 tests):** Full end-to-end genesis gate integration
- **H (6 groups):** Existing tests requiring modification (genesis_gate, sync_service, cross_client)
- **I (5 tests):** Browser E2E smoke tests
- **J (10 tests):** Edge cases, error handling, recovery

### 🔴 Phase 2: Test Creation (RED — COMPLETE 2026-07-02)

**Status:** ✅ RED phase complete — 62 new tests created across 3 files. All hash_index tests fail as expected (implementation in Phase 3).

**New test files created:**
- `phpoc-web/test/hash_index_test.mjs` — 22 tests (A: 9 buildHashIndex + B: 13 compareHashIndexes). All RED (module doesn't exist).
- `phpoc-web/test/genesis_gate_test.mjs` — +30 tests (Group E: 9 Tier 1 fast path, Group F: 11 Tier 2 incremental pull, Group G: 10 full integration). Existing behavior passes; hash-index-specific assertions will tighten in GREEN phase.
- `phpoc-web/test/sync_service_test.mjs` — +10 tests (Group S: Hash Index Push). 6 fail as expected (`pushLedgerBlocks` doesn't push hash_index artifacts yet).

**Total new tests:** 62 (matching test catalog estimate)

### 🟢 Phase 3: Implementation (GREEN — COMPLETE 2026-07-02)

**Status:** ✅ GREEN phase complete — all 485 tests pass, 0 failures across 3 JS suites.

**New source files created:**
- `phpoc-web/src/sync/hash_index.js` — `buildHashIndex(chain)` and `compareHashIndexes(local, remote)` pure functions (85 lines).

**Source files modified:**
- `phpoc-web/src/sync/keys.js` — Added `REMOTE_HASH_INDEX`, `REMOTE_HASH_INDEX_SHA256`, `LOCAL_HASH_INDEX` constants.
- `phpoc-web/src/sync/genesis_gate.js` — Tier 1 SHA-256 fast path (1 pull, no block pulls needed when chains match) + Tier 2 hash index fork detection (early genesis mismatch detection). Stale hash index defense with genesis hash verification.
- `phpoc-web/src/sync/sync.js` — `pushLedgerBlocks()` pushes plain-JSON `hash_index.json` and `hash_index.sha256` alongside blocks. `_genesisGatePhase()` caches hash index locally for next Tier 1 check.

**Test files modified (Phase 2 RED test fixes):**
- `phpoc-web/test/hash_index_test.mjs` — Fixed `hasCompare` variable name typo (`compareHashIndex` → `compareHashIndexes`).
- `phpoc-web/test/sync_service_test.mjs` — Renamed Group S `buildTestChain` → `buildSimpleChain` to avoid shadowing Group I's function. Added stale hash index invalidation in `pushRemoteChain()` test helper.

**Performance impact:**
- Tier 1 match (common case): 1–2 pulls vs full chain pull (~0.1s vs ~21s for 200 blocks)
- Tier 2 genesis mismatch: 2 pulls to detect vs full chain pull
- Tier 2 linear_local: 2 pulls to confirm local is authoritative
- Full backward compatibility: legacy remotes without hash index fall through to existing full pull

### ✅ E2E Cross-Client Fix Plan — GREEN PHASE COMPLETE (2026-07-01)

Full fix plan at `docs/planning/E2E_CROSS_CLIENT_FIX_PLAN.md`. All 4 bugs implemented and verified. **All tests pass (0 failures across 38 JS suites + 1554 Python tests).**

### 🛑 CLI Onboarding: Chain divergence at block 1 (2026-06-30)

**Symptom:** `ph onboarding http cloudflare` pulls 105 remote blocks but `_verify_chain()` reports divergence at block 1. Root cause: stale blocks from a previous ledger on R2 + summary blocks dropped during push. Fixing Bug 2 (position counter for all block types) and clearing stale remote data resolves this. Immediate workaround: "Clear Remote & Overwrite" in web app Sync Settings.

### ✅ Cross-Client Web Tests — GREEN (DONE — 2026-06-30)

**Tests:** `phpoc-web/test/cross_client_web_test.mjs` — 78 tests, 0 failures. 4 groups:
- **Group 1 (5 tests):** Auth gate — cookie TTL, specifier mismatch, fast path, no bypass
- **Group 2 (15 tests):** Reconcile merge — cross-device entry dedup (entry_id), remote-wins, active/stopped propagation
- **Group 3 (15 tests):** Full round-trip — Device A creates → Device B stops → Device A sees stopped
- **Group 4 (6 tests):** Auth required at correct points — fast path stays READY, auth only when needed
- **Group 5 (37 tests):** Pause/unpause lifecycle — CLI creates → Web pauses → CLI sees paused → CLI unpauses → Web sees unpaused → Web ends (staging-only, not committed) → CLI sees ended with pause history preserved

**Fix:** Field name mismatch in `pushRemoteBlob` helper (`e.start_epoch` vs caller `startEpoch`). Standardized on camelCase. Extended helper to carry `pauses`, `metadata`, `device_uuid`, `end_device_uuid` through raw blob format.

**Files:** `test/cross_client_web_test.mjs` (816 lines, +165). `src/sync/sync.js` (debug cleanup only).

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
- **Split-ledger prevention (2026-06-29):** ✅ FIXED. Two-phase fix in `DevModeContext.jsx`. Phase A: `createNewLedger()` checks if remote already has blocks before allowing creation — shows `window.confirm()` warning. Phase B: `bootstrapServices()` no longer auto-clears remote on `GENESIS_MISMATCH` — sets `genesisMismatch` state flag instead, user must explicitly clear via SyncSettings "Clear Remote & Overwrite" button. Root cause: boot-time auto-clear destroyed CLI's remote ledger when web client had a different genesis. All 257+ sync/reauth tests pass, no regressions.</newText>
- **Web re-rolls device cookie on every write (2026-06-29):** ✅ FIXED (2026-06-30). `pushToRemote()` now reuses existing device specifier instead of destroying + recreating cookie on every write. Only calls `DeviceCookie.create()` on first push (no local cookie). Remote cookie format: `{device_uuid, device_specifier}` — no `creation_time` leaked. Group O: 14 assertions, 0 failures. Plan: `docs/planning/STABLE_DEVICE_SPECIFIER_ON_WRITES.md`.
- **CLI read commands block on specifier mismatch (2026-06-29):** 🟡 PLANNED. `ph view`/`ph list`/`ph tags` bail entirely when another device holds the cookie, showing nothing — not even local data. Fix: add `check_and_sync_readonly()` that pulls remote blob without claiming ownership. Plan: `docs/planning/CLI_READONLY_STAGING_SYNC.md`.
- **Onboarding `ph onboarding http cloudflare` crashes with TypeError (2026-06-30):** ✅ FIXED. `_prompt_http_transport()` returned `(transport, config_update)` but main.py unpacks as `config_update, transport` — tuple order swapped. Fixed in `cli/onboarding.py` line 152.
- **CLI onboarding fails at block 1 — stale remote blocks from previous ledger (2026-06-30):** 🛑 ACTIVE. `ph onboarding http cloudflare` can only accept genesis (block 0) because blocks at `000001.json`–`000104.json` on R2 are from a different ledger instance. The web app's current recovery seed (`Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=`) cannot decrypt the old blocks (tag mismatch), confirming the blocks are from an earlier ledger. "Clear Remote & Overwrite" in web app is the immediate workaround. **Root cause:** old day blocks survived a ledger re-initialization cycle. **Update (2026-07-01):** Bug 2 fix ensures summary blocks are no longer dropped on push, but this won't retroactively fix blocks already missing from R2. The stale remote blocks must still be cleared manually.
- **E2E cross-client sync blocked by 4 bugs (2026-06-30):** ✅ FIXED (2026-07-01). GREEN phase complete. All 4 bugs implemented and verified: (1) genesis mismatch typed errors, (2) month summary position counter, (3a) UUID -web/-cli suffix, (3b) entry format canonicalization, (4) genesis seal signature exclusion. 0 failures across 38 JS suites + 1554 Python tests. See `docs/planning/E2E_CROSS_CLIENT_FIX_PLAN.md`.
- **clearRemote() deletes wrong staging keys (2026-06-29):** ✅ FIXED (5244371). Was deleting `staging:blob` and `cookie:json` instead of canonical `staging/blobs/current.json` and `staging/blobs/device_cookie.bin`. This bug existed since the web app was built — staging data was never actually cleaned from R2. Tests updated. Added `scripts/compare_ledgers.py` tool for R2 format comparison.
- **Login takes 4–30+ seconds even after hash-index speedup (2026-07-02):** 🔴 IN PROGRESS — Phase B2 GREEN complete. Three of four root causes fixed: (2) pushLedgerBlocks forceAll gated on `merged` flag, (3) duplicate pullCookie eliminated via `_lastRemoteCookie` reuse, (4) `_genesisCompatible` cached to `true` after first successful check. Remaining: (1) hash index bootstrap gap — first-ever login must still do full chain pull because no hash index files exist on R2 yet. Future work: pre-seed hash index during onboarding.

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
| **E2E test dir** | `/tmp/phpoc-e2e` (isolated CLI data, `--dir /tmp/phpoc-e2e`) |
| **E2E test creds** | passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`, API key `ZfkbMrrdRaY7DeoanY1GqQAOSLDmI6gO` |

> **Credentials** (API key, passphrase, recovery seed, wrangler token) are stored locally outside the repo. Ask the user to provide them if needed.
