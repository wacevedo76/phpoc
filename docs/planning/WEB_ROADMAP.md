# PH Ledger — Web/Mobile Build Log

> **Purpose:** What was built, when, and in what order. A durable record of completed work.
> For planned features, see [`ROADMAP.md`](ROADMAP.md).
> For design rationale, see [`PHPOC-REACT_WEB-DESIGN_DECISIONS.md`](PHPOC-REACT_WEB-DESIGN_DECISIONS.md).
> For current session state, see [`../../SESSION_HANDOFF.md`](../../SESSION_HANDOFF.md).

---

## Build 54 — Settings Genesis Gate Component Tests (RED phase) — 2026-06-25

**26 Vitest + RTL component tests written:**
- Category B (React Component Integration): 20 tests — all pass (existing behavior)
- Category E (Edge Cases & Regressions): 6 tests — all pass (existing behavior)
- Category F (Accessibility & A11Y): 4 tests — 2 pass / 2 RED (aria-live="polite" + role="status" not yet implemented)

**Infrastructure:**
- Dev deps installed: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`, `@testing-library/dom`
- `vite.config.js` updated with `test` block (jsdom environment, globals)
- `test/vitest-setup.js` created
- File: `test/settings_genesis_component.test.mjs`

**Result:** 24 passed, 2 failed (intentionally RED — accessibility features pending)

---

## Build 55 — Settings Genesis Gate GREEN Phase (Accessibility) — 2026-06-25

**2 accessibility fixes made to `Settings.jsx`:**
- Added `aria-live="polite"` to the "⏳ Checking genesis compatibility…" paragraph — screen readers announce the status change
- Added `role="status"` to the outer `.genesis-status` container — enables ARIA live-region behavior for all status cards

**Files changed:**
- `phpoc-web/src/components/screens/Settings.jsx` — 2 attributes added

**Result:** All 26 component tests pass (was 24 ✅ / 2 🔴). Category F: 4/4 GREEN.

---

## Build 57 — Tier 2 React Component Tests (Onboarding Import Form) — 2026-06-28

**21 Vitest + RTL component tests written for OnboardingScreen import form state machine:**
- I1 (Import source selection, 2 tests): file/cloud options visible after clicking Import, back button returns to menu
- I2 (File picker gating — disabled, 3 tests): submit disabled without file, without passphrase, without seed
- I3 (File picker gating — enabled, 1 test): Import Ledger enabled when file + seed + passphrase all filled
- I4 (Destroy warning with existing data, 3 tests): destroy banner, committed block count, staging entry count
- I5 (No destroy warning without data, 2 tests): absent when IndexedDB empty, absent when hasExistingData=false
- I6 (Confirm destroy checkbox gate, 2 tests): checkbox required for submit enable, uncheck disables again
- I7 (Keep staging checkbox, 3 tests): appears with staging count, checked by default, absent when no staging
- I8 (Error display, 3 tests): prop error rendered, cleared on back navigation, uses auth-error-msg class
- I9 (Back navigation, 2 tests): file form → source selection, source selection → menu

**Infrastructure:**
- Mocked `indexedDB.open()` with configurable block/staging counts for `probeExistingData()`
- Mocked dynamic imports (`transport.js`, `remote_import.js`) to prevent resolution errors
- Uses `getByRole('checkbox', { name: /regex/i })` for implicit-label checkboxes (keep staging, I understand)
- File: `phpoc-web/test/onboarding_import_component.test.mjs`

**Result:** 21/21 pass, 0 failures. Zero regressions across existing test suites.

## Build 59 — GENESIS_MISMATCH Fix Phase 1 (connectToWorker) — 2026-06-29

**Phase 1 of GENESIS_MISMATCH bug fix implemented:**
- In `connectToWorker()` blocks-format path: after storing chain to IndexedDB, deletes stale `ledger:blocks` key from R2 before `bootstrapServices()` runs
- Prevents the genesis gate (which checks `ledger:blocks`) from seeing a stale chain from a prior web session with a different genesis
- Best-effort: caught errors are non-critical — genesis gate handles null gracefully
- Only fires in blocks-format path (`if (format === 'blocks')`); single-blob path unaffected

**Files changed:**
- `phpoc-web/src/context/DevModeContext.jsx` — 9 lines added (~line 866)

**Result:** All 232 tests pass (56 worker_connect_blocks_format + 153 sync_service + 23 onboarding_cloud_conflict). Zero regressions.

Full investigation: `docs/planning/GENESIS_MISMATCH_BUG_INVESTIGATION.md`.

## Build 60 — Stable Device Specifier on Writes (Step 6c) — 2026-06-30

**Bug fix:** `pushToRemote()` in `sync.js` destroyed the local cookie and called `DeviceCookie.create()` on every push, generating a new random `device_specifier` each time. The CLI saw a cookie mismatch on every web write and blocked read commands (`ph view`, `ph list`).

**Fix:** `pushToRemote()` now checks for an existing local `device_specifier`:
- Has one → reuses it, only updates `creation_time` to extend TTL
- No cookie → calls `DeviceCookie.create()` for a fresh specifier (first push after onboarding/re-auth)
- Remote cookie pushed as `{device_uuid, device_specifier}` — no `creation_time` leaked

`_pushCookie()` and `_reconcileAndClaim()` Case B are unchanged — cross-device takeover still generates a new specifier (correct semantics).

**Files changed:**
- `phpoc-web/src/sync/sync.js` — `pushToRemote()` modified (29-line block replaced)
- `phpoc-web/test/sync_service_test.mjs` — Group O: 14 assertions (O1–O4), 5 test scenarios

**Result:** 167/167 sync tests pass (was 161 pass / 6 fail RED). Plan: `docs/planning/STABLE_DEVICE_SPECIFIER_ON_WRITES.md`.

## Build 61 — Sync Module Refactoring (Step 6d) — 2026-06-30

**Major refactor of `src/sync/` across four dimensions: modularity, clarity, security, user efficiency.**

**Modularity (3 new modules):**
- `src/sync/base64.js` (35 lines) — shared `base64ToBytes`/`bytesToBase64`, removed duplicates from sync.js, remote_sync.js, genesis_gate.js
- `src/sync/keys.js` (22 lines) — 7 canonical path constants, replaced 30+ hardcoded strings across 5 files
- `src/sync/entry_dto.js` (159 lines) — DTO conversion extracted from sync.js: `rawCommittedEntryToDTO`, `rawEntryToDTO`, `parsePlainInt`, `parsePlainJSON`

**Clarity (5 improvements):**
- `checkAndSync()` decomposed into `_genesisGatePhase()` / `_fastPathPhase()` / `_authGatePhase()` (~35 lines each)
- `_reconcileAndClaim()` split into `_reconcileSameDevice()` / `_reconcileDifferentDevice()` (~25 lines each)
- `_pushRemoteCookie()` helper replaces 3 duplicated cookie-encode blocks
- `cookie.js` stale header fixed (no longer says "every write generates new specifier")
- Removed unused `timeoutMs` param from `checkAndSync()`

**Security (2 fixes):**
- **cookie.js TTL fallback bug:** `(ttlMinutes || 0.5)` → `(ttlMinutes ?? 30)`. When `ttlMinutes=0`, old `||` fell back to 30s instead of 30min. Now uses nullish coalescing.
- `matches()` redundant `!!` removed — expression already boolean

**Efficiency (3 improvements):**
- `_deviceId` cached in `this._deviceId` — avoids repeated storage + WASM calls per operation
- `pushLedgerBlocks()` skips `listFiles` when `forceAll=true`
- `clearRemote()` uses `keys.js` constants instead of hardcoded paths

**Files changed:** 8 modified, 3 new. `sync.js`: 1,169 → 1,035 lines (−134). Net: ~180 lines of duplication removed.

**Result:** All 167 sync tests pass + 21 Vitest component tests pass. Zero regressions.

## Build 58 — GENESIS_MISMATCH Bug Fix Tests — 2026-06-29

**86 tests across 3 files for the GENESIS_MISMATCH bug fix (all GREEN):**

**New file: `test/worker_connect_blocks_format.test.mjs` (56 tests)**
- Group A — Blocks-format onboarding: stale `ledger:blocks` delete (7 scenarios, 39 assertions)
  - A1: delete called after storage write, before bootstrap
  - A2: stale ledger:blocks with different genesis → delete clears it from R2
  - A3: no stale blob → delete is 404 no-op
  - A4: network error during delete → caught gracefully
  - A5: end-to-end: onboard → delete stale → gate compatible → fresh blob pushed
  - A6: single-blob format → delete NOT called
  - A7: same genesis in both formats → delete fires safely
- Group B — bootstrapServices auto-clear recovery (5 scenarios, 17 assertions)
  - B1: mismatch → clearRemote → retry → READY
  - B2: retry still mismatched → graceful degradation
  - B3: clearRemote fails (network error) → caught, app still boots
  - B4: compatible → clearRemote NOT called
  - B5: after recovery, Sync Now returns READY

**Modified file: `test/sync_service_test.mjs` Group N (7 tests)**
- N1: clearRemote deletes all three keys
- N2: resets _genesisCompatible to null
- N3: ETag cache reset
- N4: partial failure (404 on one key) handled gracefully
- N5: all deletes fail → throws
- N6: no transport → throws
- N7: end-to-end: mismatch → clearRemote → re-check → compatible

MockTransport gained `delete()`, `resetCache()`, and `hasKey()` methods (used by Group N and above).

**New file: `test/onboarding_cloud_conflict.test.mjs` (23 tests — Phase 3 deferred)**
- C1: Both formats, different genesis → `status: 'conflict'`
- C2: Both formats, same genesis → no conflict
- C3: Only CLI blocks → blocks-format path
- C4: Only ledger:blocks → single-blob path
- C5: Conflict → user chooses blocks → stale blob deleted → CLI intact

**Code changes:** The tests validate the fix logic. Two code changes in `DevModeContext.jsx`:
1. ✅ `connectToWorker()` — `await transport.delete('ledger:blocks')` after blocks-format storage write (Phase 1, 2026-06-29)
2. `bootstrapServices()` — replace silent `console.warn` with `sync.clearRemote()` + retry

Full investigation: `docs/planning/GENESIS_MISMATCH_BUG_INVESTIGATION.md`.

**Result:** 86/86 pass across 3 files. Zero regressions (sync_service_test.mjs 153/153, genesis_gate_test.mjs 94/94, transport_test.mjs 66/66, worker_connect_onboarding_test.mjs 65/65).

### Login Blank Screen Fix — 2026-06-28

**Bug:** When logging into an existing ledger, the screen sometimes goes completely blank.

**Root cause:** No React error boundary existed in the app. Any render crash (from a component,
hook, or child) unmounted the entire component tree, producing a blank white screen with no
diagnostics. Console confirmed: `The above error occurred in the <AppInner> component`,
`Consider adding an error boundary to your tree`.

**Fix:** Added `ErrorBoundary` class component to `App.jsx`:
- Catches any render-time crash in the `<DevModeProvider><AppInner/></DevModeProvider>` tree
- Shows diagnostic message with error text + collapsible stack trace
- Provides "Reload page" button for recovery
- Logs full error to console for debugging

**Before:** Render crash → blank white screen (no recovery).
**After:** Render crash → error message with diagnostics + reload option.

### Cookie TTL Expiry Repurposed — 2026-06-28

**Before:** Cookie TTL expiry showed a reauth overlay (`AuthScreen overlay`). User entered
passphrase, MK was re-derived, overlay dismissed, user pressed "Sync Now" manually.

**After:** Cookie TTL expiry calls `handleTtlExpiry` which sends user to landing screen
(same behavior as manual logout). User clicks "Log in to this ledger" and enters passphrase
— the full `bootstrapServices` flow runs, including `checkAndSync` and cookie creation.

**Warning banner:** `createCookieMonitor` now fires `onWarning` 5 minutes before TTL expires.
A fixed-position bottom banner appears: "Session expires soon — save your work." with
dismiss button. Fires once per session.

**Changes:**
- `useCookieMonitor.js` — Added `onWarning` callback + `warningThresholdMinutes` option (default 5)
- `DevModeContext.jsx` — Removed `reauthActive`, `triggerReauth`, `dismissReauth`, `handleReauth`.
  Added `ttlWarning`/`dismissTtlWarning` state + `handleTtlExpiry` for cookie monitor to call.
- `App.jsx` — Removed `<AuthScreen overlay/>` reauth block. Added TTL warning banner.
- `SyncSettings.jsx` — Removed `triggerReauth()` calls on REAUTH_NEEDED. Message changed to
  "Log out and log back in to continue."
- `App.css` — Added `.ttl-warning-banner` styles (orange, fixed bottom, slide-up animation)


## Build 56 — SyncService Transport Reconfiguration (C2 Fix) — 2026-06-25

**Solution B implemented — `reconfigure(transport)` on SyncService:**
- `SyncService.reconfigure(transport)` method (~15 LOC): replaces `this._transport` + `this._remote`, invalidates genesis gate cache
- `Settings.jsx`: calls `services.sync.reconfigure(transport)` after genesis check (inside try block), `services.sync.reconfigure(null)` when URL cleared
- `sync_service_test.mjs` — Group K (6 tests): null→transport, transport→null, transport swap + ping, genesis cache cleared, staging data preserved, null→transport transition

**Files changed:**
- `phpoc-web/src/sync/sync.js` — `reconfigure()` method added
- `phpoc-web/src/components/screens/Settings.jsx` — 2 reconfigure calls
- `phpoc-web/test/sync_service_test.mjs` — 6 new tests (Group K)

**Result:** All 71 SyncService tests pass (was 65). C2 Browser E2E test now passes — Sync Now uses new transport after Settings save. Full tradeoff analysis at [`docs/design/TRANSPORT_RECONFIGURATION_ANALYSIS.md`](../design/TRANSPORT_RECONFIGURATION_ANALYSIS.md).

---

## Crypto Core Status

| Layer | CLI (Reference) | Web/Mobile PoC |
|-------|:---------------:|:----------:|
| Rust crypto core (`phpoc-crypto-core`) | ✅ | ✅ 7 modules, 61 tests |
| WASM bindings (20 exports to JS) | N/A | ✅ `wasm.rs` module |
| WASM build target | N/A | ✅ 134K `.wasm` + JS glue + TS types |
| WASM integration test (74 tests) | N/A | ✅ `phpoc-web/test/wasm_integration.mjs` |
| CryptoService wrapper (20 functions) | N/A | ✅ `phpoc-web/src/crypto/index.js` |
| Device identity | ✅ | ✅ `device.rs` module |
| Worker: CORS headers | N/A | ✅ OPTIONS + CORS on all responses |
| Crypto test vector suite | ✅ | ✅ 19 vectors, validated |
| HTTP Transport implementation + test suite (49 tests) | N/A | ✅ GREEN — `phpoc-web/src/sync/transport.js` |
| Core engine (chain, crypto, storage) | ✅ | ✅ 4 modules (Chain 70, Index 36, Summary 49, Engine 111), 266 tests |
| CLI UX (`add`, `view`, `sync`, `verify`) | ✅ | N/A |
| Remote staging sync (port to JS) | ✅ | ✅ SyncService with `checkAndSync()`, `_reconcileAndClaim()`, 60-test suite |
| Auth gate (device cookies port) | ✅ | ✅ DeviceCookie + 14-test suite |
| Cross-device handoff (port) | ✅ | ✅ Merge engine + `_reconcileAndClaim()` |
| Sync modules (storage abstraction) | N/A | ✅ StorageBackend interface + MemoryBackend + IndexedDBBackend |
| Sync modules (local cache) | ✅ | ✅ LocalCache (staging CRUD, pause management, tag normalization) |
| Sync modules (merge engine) | ✅ | ✅ `merge_engine.js` (dedup by entry_id) |
| Sync modules (remote blob) | ✅ | ✅ RemoteSync (pull/push with CryptoService obfuscation) |
| Sync test suite | N/A | ✅ 60 tests covering all 4 layers + edge cases |
| Ledger block sync (port) | ✅ | ✅ LedgerEngine.verify() catches tampered chain |
| Format spec ([`../spec/PHPSPEC.md`](../spec/PHPSPEC.md)) | ✅ | ✅ |

---

## Build Steps

| Step | What | Status | Tests | Completed |
|------|------|--------|-------|-----------|
| 1 | `HttpTransport` — fetch()-based HTTP with ETag caching | ✅ | 49 | — |
| 2 | Sync algorithm port — `checkAndSync()`, auth gate, staging CRUD, merge engine | ✅ | 60 | — |
| 3 | React Web UI — Vite + React 18, 9 screens, dev mode, auth overlay | ✅ | — | — |
| 4 | `StorageBackend` + `HttpBackend` — interface + Transport→StorageBackend adapter | ✅ | 41 | — |
| 5 | Browser import/export via File API | ✅ | 83 | — |
| 6 | **Ledger Engine JS Port + Refactoring** — Chain, Index, Summary, Engine (4 modules, 266 tests) | ✅ | 269 (70+36+49+114) | — |
| 7 | **Onboarding Workflow** — Landing screen, onboarding wizard (Import/New/Export), phase-based lifecycle, IndexedDB seed storage, passphrase auth with PBKDF2, identity fields (username + email), PHPSPEC-compliant genesis block | ✅ | — | — |
| 8 | **History screen — staging vs committed differentiation** — visual badges (Not Committed / Committed), expand/collapse tags & comments, red border for staging, blue when expanded. Inline editing for staging entries: add/remove tags, edit comments. | ✅ | — | — |
| 9 | **Inline tag & comment editing on staging entries** — × on tags to remove, +input to add, editable textarea with debounced auto-save. Committed entries read-only. | ✅ | — | — |
| 10 | **Export works in dev mode** — uses cached master key from bootstrap instead of requiring seed authentication. | ✅ | — | — |
| 11 | **Recovery seed display** — after new ledger creation, full-screen overlay shows base64 seed. "I've saved it" confirm button. Only shown once. | ✅ | — | — |
| 12 | **Logout button** — renamed from "Lock" to "Logout" with exit-door icon. Clears crypto master key, returns to Landing screen. Fixed blank screen bug (hasExistingData) and in-memory data loss on re-login (FallbackStorage caching). | ✅ | — | — |
| 13 | **Sync Screen with Commit UI** — dedicated Sync screen. Uncommitted entries (active + stopped) as compact cards. Stopped: yellow border/syncability indicator, expandable inline tag & comment editing, end-time adjustment (time input with −5m/+5m/+15m quick-adjust), duration editor (1h30m/90m/1.5h formats, accounts for pauses), pause management (list/add/remove pauses with start/end time), delete-from-staging button. Active: red border, compact non-expandable with lock icon. Commit button bar (Commit Selected / Commit All). NOT_SYNCED status. Tag-add Enter key no longer collapses card (stopPropagation fix). | ✅ | — | — |
| 14 | **One-off Task Checkbox** — Dashboard "Start New Task" form: ☐ one-off checkbox. Checked → "Log" button, `isActive: false` + `endEpoch: now`. Unchecked → "Start" button, timed task. Resets after submission. | ✅ | — | — |
| 15 | **Full Ledger Export + Import Interface** — `exportLedgerFull()` v2 format with committed chain + staging, seal over `{ledger, staging}`. Pure read. 72 tests. Import updated for v1/v2 dual-format with `genesisHash` return. Genesis-aware import: same genesis → reject with merge placeholder, different → replace. | ✅ | 72 | — |
| 16 | **History Calendar Widget + Committed Entry Decryption** — Replaced `<input type="date">` with custom inline month calendar (year/month nav, day grid with entry-dot indicators, today highlighting, click-to-filter). Extended `sync.getCompleted()` to decrypt committed entries from `ledger:blocks` via new `_rawCommittedEntryToDTO()` (AES-128-CTR field decryption). Calendar dots and date filtering now work across all committed entries. | ✅ | — | — |
| 17 | **Mock Data Generator** — `scripts/generate_mock_data.py` generates 30 days of realistic staging entries. Weighted weekday/weekend templates, plain: prefix, SHA-256 hashes, UUID4 entry IDs. `--apply` writes to staging.json. 115 entries spanning Jun 4 → Jul 3, 2026. | ✅ | — | Jun 9 2026 |
| 18 | **MockRemoteBackend** — in-browser R2/S3 simulation (IndexedDB, latency, ETags, 404s). 46 tests. | ✅ | 46 | Jun 9 2026 |
| 19 | **MockDataSeeder** — realistic staging data generator for web dev mode. 14 days of entries + cookie + genesis + index. 205 tests. | ✅ | 205 | Jun 9 2026 |
| 20 | **DevModeContext rewired** — DummySyncService replaced with real SyncService + MockRemoteBackend. Real auth gate, cookie setup, entry pull from mock remote. Full-stack simulation in-browser. | ✅ | — | Jun 9 2026 |
| 21 | **HttpBackend + StorageBackend.list + Worker DELETE** — Transport→StorageBackend adapter, `delete()` on HttpTransport/MockRemoteBackend, DELETE handler on Worker. 41 tests. Zero regressions (155 web tests, 270 total). | ✅ | 41 | Jun 9 2026 |
| 22 | **Ledger Engine JS Port + Refactoring** — 4 modules, then 3-phase code review refactoring (16 findings: Modularity, Clarity, Security). 266 tests, 0 failures. Chain (70), Index (36), Summary (49), Engine (111). Shared utilities, proper async, security hardening. | ✅ | 266 | Jun 10-11 2026 |
| 23 | **Onboarding Workflow** — Landing screen, onboarding wizard (Import/New/Export), phase-based lifecycle, IndexedDB seed storage, passphrase auth with PBKDF2. Production mode: `?dev=false` or `defaultDevMode={false}`. | ✅ | — | Jun 11 2026 |
| 24 | **Genesis block creation** — `LedgerChain.buildGenesisBlock()` + `LedgerEngine.init()` producing PHPSPEC §4.1 genesis block with identity, encrypted seed, encrypted identity secret, HMAC seal, and identity signature. Onboarding form collects username + email. | ✅ | — | Jun 11 2026 |
| 25 | **History staging/committed differentiation** — History screen shows status badges (Not Committed / Committed), expand/collapse tags & comments on card click, red border for staging (blue when expanded). `StagingEntry` tracks `committed` + `block_index`. | ✅ | 269 | Jun 11 2026 |
| 26 | **Inline tag & comment editing** — staging entries in History can add/remove tags (× button, +input with Enter) and edit comments (textarea with debounced auto-save). Committed entries read-only. | ✅ | — | Jun 11 2026 |
| 27 | **Export fix (dev mode)** — export uses cached master key when available, skipping seed authentication. Works in both dev and production. | ✅ | — | Jun 11 2026 |
| 28 | **Recovery seed display** — after onboarding, full-screen overlay shows base64 seed with "I've saved it" confirmation. | ✅ | — | Jun 11 2026 |
| 29 | **Logout button** — renamed from Lock to Logout, exit-door icon. Fixed blank screen + in-memory data loss on re-login. | ✅ | — | Jun 11 2026 |
| 30 | **Sync Screen End-Time + Duration Editing** — Expanded stopped entries include `EndTimeEditor` with time input + quick-adjust buttons (−5m, +5m, +15m) and a Duration field accepting `1h30m`, `90m`, `1.5h`, `1:30`, `45` (raw minutes). Duration accounts for pauses. Changing one updates the other. Commits on Enter/blur. | ✅ | — | Jun 16 2026 |
| 31 | **Sync Screen Pause Management** — `PausesEditor` component beneath end-time/duration. Lists existing pauses with start/stop times and duration badge. × button removes each pause. "+ Add pause" opens inline form with start/end time inputs + Save/Cancel. Pauses inserted sorted by start time. Recalculates duration on every pause change. | ✅ | — | Jun 16 2026 |
| 32 | **Sync Screen Enter-Key Fix** — Fixed bug where pressing Enter in the tag-add input collapsed the entire card. Root cause: React keydown event bubbled from the input to the card's `onKeyDown` handler. Fix: `e.stopPropagation()` in `handleTagInputKeyDown` + `onKeyDown={(e) => e.stopPropagation()}` on the expanded details wrapper div. | ✅ | — | Jun 16 2026 |
| 33 | **Duplicate Entry Race Condition Fix** — Fixed read-modify-write race in `LocalCache.update()` that caused committed entries to lose their `committed: true` flag when inline edits raced with `markCommitted()`. Three guards: early committed check, index-out-of-range check, entry_id + committed race check. | ✅ | — | Jun 16 2026 |
| 34 | **Sync Screen Delete-From-Staging Button** — Expanded stopped entries show "🗑 Delete from staging" button that calls `sync.remove()`. Immediate UI update with all editing/selection state cleaned up. | ✅ | — | Jun 16 2026 |
| 35 | **Full Ledger Export** — `exportLedgerFull(blocks, staging, crypto, masterKey)` exports committed chain + staging in v2 format. HMAC seal over {ledger, staging}. Pure read. 72 tests. | ✅ | 72 | Jun 11 2026 |
| 36 | **Import Workflow Enhancement** — Five read-only validation gates before any destructive write. Destroy warning + export offer in confirmation dialog. Staging persistence checkbox. Fixed v2 committed chain loss. Fixed raw chain format detection with Python-compatible JSON serializer (`jsonDumps`). 98 import/export tests. | ✅ | 98 | Jun 11 2026 |
| 37 | **Ledger Merge — GREEN phase** — `LedgerMerge.merge()` implemented in `src/ledger/merge.js`. Standalone module, 7-step algorithm (fork detection, entry extraction, content_hash dedup, alphabetical sort, chain rebuild with summary inserts, index rebuild). Input chain validation (`_verifyChain`/`_verifyBlockData`) runs as Step 0 before fork detection. Ordering tests (J8-J10) prove validation fires before genesis mismatch check. 99 assertions, 0 failures. | ✅ | 99 | Jun 19 2026 |
| 38 | **Remote Sync Wiring — phpoc-web ↔ Cloudflare Worker** — Dual-backend model (local IndexedDB + remote HttpTransport), device UUID persistence (random UUID4 per device, not HMAC-derived), ledger merge strategy (GREEN with input validation + ordering tests), Settings UI with genesis compatibility gate. | ✅ | 149 | Jun 18-20 2026 |
| 38.1 | Genesis Compatibility Gate — Phase 1 RED: `genesis_gate.js` stub + `genesis_gate_test.mjs` (20 tests, all failing). Group A (8): genesis hash comparison. Group B (7): merge on genesis match. Group C (5): edge cases (empty local, format_version mismatch, ETag caching, concurrent dedup, large remote). | ✅ RED | 20 (all fail) | Jun 20 2026 |
| 38.2 | Genesis Compatibility Gate — Phase 2 GREEN: full `check()` implementation. Fetches remote `ledger:blocks`, validates format/type/seals/linkage, compares genesis hashes, delegates to `LedgerMerge.merge()`. In-flight dedup for concurrent calls. 8 reason codes. All 20 TDD tests pass (89 assertions, 0 failures). C2 test corrected (format_version is sealed → different hashes → genesis_mismatch). | ✅ GREEN | 89 (0 fail) | Jun 20 2026 |
| 38.3 | Genesis Gate — Phase 3: Code review (4 criteria passed, 2 minor fixes), Settings UI integration (genesis status indicator on Worker URL save), SyncService integration (`checkAndSync()` gate before blob sync, `GENESIS_MISMATCH` result, cached + skipped when no local ledger), 16 new tests (settings 13 + sync integration 3). Zero regressions across full test suite. | ✅ | 149 (89+13+45+2 new) | Jun 20 2026 |
| 39 | **Connect to Existing Worker — Onboarding Flow** — Fourth onboarding path: enter Worker URL + API key, fetch remote `ledger:blocks`, validate genesis, passphrase verification against pulled genesis, sync staging blobs after auth. Pivoted from bridge server (deferred) — real Worker testing surfaces cross-client concerns that Flutter will need. | ✅ | 65 | Jun 20 2026 |
| 40 | **Remote Import from Cloud Storage** — `WorkerImportSource` wraps `HttpTransport` to list/fetch backup files from `backups/` prefix. OnboardingScreen gains "From Cloud" sub-option (source selection → connect → list → select → auth → import). `importFromCloud()` action: PDK derivation for passphrase-only, direct authenticate fallback. 57-test suite. Zero existing tests modified. | ✅ | 57 | Jun 20 2026 |
| 41.1 | **Multi-Device Auto-Sync Hook — Phase 1 RED**: `useAutoSync.js` stub + `auto_sync_hook_test.mjs` (24 assertions, 22 failing). Group A (6): capture/end/pause/unpause/modify/remove triggers. Group B (2): readEntries + checkAndSync non-triggers. Group C (3): debounce coalescing. Group D (3): error resilience. Group E (2): isSyncing state. Group F (2): no-MK skip. Group G (2): multi-type batch. Group H (2): cleanup/dispose. | 🔴 RED | 22 fail | Jun 20 2026 |
| 41.2 | **Multi-Device Auto-Sync Hook — Phase 2 GREEN**: `createAutoSync()` wraps 6 mutation methods with debounced `pushToRemote()`. `isSyncing()` tracks debounce/push lifecycle. No-MK skip, error resilience (mutations succeed despite push failures), `dispose()` cleanup (cancel debounce, suppress in-flight updates). `getMasterKey()` added to `SyncService` for MK access. React `useAutoSync()` hook: `useRef` instance, interval-based `isSyncing` polling, `useEffect` cleanup on unmount, `useCallback` wrappers. 24 assertions (58 sub-checks), 0 failures. | ✅ GREEN | 58 (0 fail) | Jun 20 2026 |
| 41.3 | **Auto-Sync Hook — Code Review: 6 findings addressed.** (1) `useCallback([])` stale closures → ref-based read at call time. (2) `require('react')` → ES `import`. (3) 100ms polling → push-based `onSyncingChange` callback. (4) `_syncing` never reset on dispose-during-push → unconditional reset in `finally`. (5) Dead `_disposed` check in setTimeout → removed. (6) Silent `{}` fallback → lazy init guarantees instance. Also: `_wrap` → `_wrapMutation`, comment on debounce reset behavior, contract enforcement for `getMasterKey`. Zero regressions. | ✅ | 58 (0 fail) | Jun 20 2026 |
| 42 | **Auto-Sync Wiring — GREEN**: `DevModeContext.jsx` wraps `services.sync` with `createAutoSync()` via `useMemo`-based `effectiveServices` using a Proxy. All 6 mutation methods auto-trigger debounced `pushToRemote()`. Proxy preserves prototype methods (getCompleted, markCommitted, etc.). Cleaned up on unmount. | ✅ | 0 regressions | Jun 20 2026 |
| 43 | **Auth Gate + Status Display + Reauth Overlay Fix**: `checkAndSync()` auth gate: when no local cookie but MK cached, proceed to `_reconcileAndClaim`. Status display: only shows `NOT_SYNCED` when `remoteStatus !== READY`. Reauth overlay: `handleReauth` re-derives MK from passphrase+seed without re-bootstrapping, auto-runs sync, dismisses overlay. Triggered by SyncSettings on REAUTH_NEEDED. | ✅ | 0 regressions | Jun 20 2026 |
| 44 | **pushLedgerBlocks() — TDD RED Phase**: `ledger_sync_test.mjs` created — 31 tests across 7 categories (A-G), 35 assertions. All RED — `pushLedgerBlocks()` not yet implemented on SyncService. Tests define the full contract per `PUSHLEDGERBLOCKS_TDD_PLAN.md`. MockTransport (push/pull/listFiles), MockCrypto (obfuscateBlob/deobfuscateBlob), helpers (makeBlock, makeIndex, pushBlocksToRemote, readPushedBlock). Categories: A (Basic Push, 5 tests), B (No-Op/Skip, 4 tests), C (Obfuscation Correctness, 4 tests), D (Transport Error Resilience, 4 tests), E (Index Push, 4 tests), F (SyncService Integration, 6 tests), G (Edge Cases, 4 tests). | 🔴 RED | 35 (all fail) | Jun 22 2026 |
| 44.2 | **pushLedgerBlocks() — TDD GREEN Phase**: `pushLedgerBlocks()` implemented on `SyncService` in `sync.js`. Method reads `ledger:blocks` and `ledger:index` from storage, lists remote indices via `listFiles('ledger/blocks/')`, pushes only new blocks (JSON-serialized + obfuscated via `crypto.obfuscateBlob()`), then pushes index. Skipped when no transport, no master key, or empty blocks. Blocks sorted by index before push. Errors caught/logged, never thrown. `_base64ToBytes()` cross-platform helper added. All 76 assertions pass, 0 failures. | 🟢 GREEN | 76 (0 fail) | Jun 22 2026 |
| 45 | **Commit→Push Wiring — TDD RED Phase**: `commit_push_integration_test.mjs` created — 14 tests across 4 categories (A-D), 61 assertions. 47 pass (commit flow, result preservation, regression), 14 RED (blocks not on remote — `pushLedgerBlocks` not yet wired into `commitEntries`). Tests use real `LedgerEngine` + `SyncService` with MockTransport/MockCrypto/MemoryBackend to simulate the full `DevModeContext.commitEntries` flow. Categories: A (Full Commit+Push Flow, 5 tests), B (Commit Result Preservation, 3 tests), C (Sync Now Integration, 3 tests), D (Regression, 3 tests). GREEN phase adds `await sync.pushLedgerBlocks()` as a single line to `commitEntriesFlow` helper + `DevModeContext.jsx`. | 🔴 RED | 61 (47 pass / 14 RED) | Jun 22 2026 |
| 45.2 | **Commit→Push Wiring — TDD GREEN Phase**: `await sync.pushLedgerBlocks()` added to `DevModeContext.jsx:commitEntries` (line 1388) and `commitEntriesFlow` test helper. `pushLedgerBlocks()` fixed to use `day_index` with `index` fallback for cross-engine compatibility (LedgerEngine uses `day_index`, test helpers use `index`). All 60 assertions pass, 0 failures. Zero regressions across full web test suite. | 🟢 GREEN | 60 (0 fail) | Jun 22 2026 |
| 46 | **SyncIndicator → isAutoSyncing Wiring**: `DevModeContext.jsx` added `isAutoSyncing` React state driven by `onSyncingChange` callback from `createAutoSync`, exposed in context. `SyncSettings.jsx` `displayStatus` now folds in `isAutoSyncing` alongside manual `syncing` state — shows SYNCING indicator during debounced auto-pushes. New `sync_indicator_test.mjs` — 32 tests (status config, each mapping, compact mode, fallback). No changes to `SyncIndicator` component itself (already had `SYNCING` status). | ✅ | 32 (0 fail) | Jun 22 2026 |
| 47 | **displayStatus Extraction**: Extracted `computeDisplayStatus()` pure function + 5 `STATUS_*` constants from `SyncSettings.jsx` into `src/sync/display_status.js`. `SyncSettings.jsx` now imports and calls the function instead of inline derivation. New `display_status_test.mjs` — 20 tests across 6 groups (SYNCING priority, NOT_SYNCED conditions, READY passthrough, remote passthrough, edge cases, constant values). | ✅ | 20 (0 fail) | Jun 22 2026 |
| 48 | **Re-auth Overlay for TTL Expiry — TDD RED Phase**: Test plan documented in `REAUTH_TTL_TDD_PLAN.md`. Two new test files created: `reauth_ttl_test.mjs` (35 tests, categories A–E — all RED) and `reauth_integration_test.mjs` (27 tests, categories F–I — 18 pass, 9 RED). +3 additions to existing files: `sync_service_test.mjs` (H7–H8, both GREEN), `auto_sync_hook_test.mjs` (H3, GREEN). Total: 62 new tests, 44 RED (createCookieMonitor not implemented), 21 GREEN (existing behavior validation). | 🔴 RED | 44 RED / 21 GREEN | Jun 22 2026 |
| 48.2 | **Re-auth Overlay TTL — TDD GREEN Phase**: `checkCookieTtl()` + `createCookieMonitor()` implemented in `src/hooks/useCookieMonitor.js` (~170 LOC). `checkCookieTtl()` validates cookie existence, specifier/creation_time fields, and TTL — cleans up corrupt/expired cookies. `createCookieMonitor()` is a pure function (follows `createAutoSync` pattern): `start()` fires immediate check + sets interval polling, `dispose()` clears timer (idempotent), `isExpired()` exposes state. On expiry: calls `crypto.clearMasterKey()` then `onExpired()` (single-fire, no duplicates). Handles null storage/crypto, missing onExpired, storage read errors, and callback crashes gracefully. Wired into `DevModeContext.jsx` ready-phase boot — monitor starts when services bootstrap, `onExpired` → `triggerReauth`, disposed on logout and phase change. 89 combined assertions pass (50 ttl + 39 integration, 0 failures). 1 integration test F1d shows test-only MK mismatch (mock sha256≠PBKDF2 in simulateReauth). | 🟢 GREEN | 89 (0 fail) | Jun 22 2026 |
| 50 | **Dev Mode: Remove Mock Bootstrap (Step 1/2)** — Removed `bootDevMode()` (~130 LOC) from `DevModeContext.jsx`. This function was the sole source of `DummyCryptoService`, `MockRemoteBackend`, and `MockDataSeeder` in the dev boot path. Both dev and production modes now follow the same boot path: create storage → check for existing data → landing/onboarding. The `isDev` flag and `toggleMode` remain for future dev-only UI use (dev badges, debug panels, verbose logging). ⏭ Step 2/2: remove 6 remaining `DummyCryptoService` try/catch fallback blocks from production flows. | ✅ | — | Jun 24 2026 |
| 51 | **Dev Mode: Remove Silent Crypto Fallbacks (Step 2/2)** — Removed all 6 `DummyCryptoService` try/catch fallback blocks from `login`, `createNewLedger`, `connectToWorker`, `importFromCloud`, `validateImport`, and `exportLedgerAction` in `DevModeContext.jsx`. Removed `import { DummyCryptoService }` line. All crypto initialization is now unconditional — WASM import failure throws a real error (no silent degradation to djb2 hash crypto). Updated `cryptoStatus` comment and JSDoc header. Total reduction: 168 LOC across both steps. Zero test regressions. `DummyLedger.js` and `MockDataSeeder.js` remain in `src/services/` for test use only — not imported by the app boot path. | ✅ | — | Jun 24 2026 |
| 52 | **WASM Resolution Fix** — WASM artifacts (`phpoc_crypto_core.js` + `_bg.wasm`) copied from `phpoc-crypto-core/pkg/` into `phpoc-web/src/crypto/wasm/`. Import path updated from `../../../phpoc-crypto-core/pkg/` to `./wasm/`. Removed `build.rollupOptions.external` exclusion and `optimizeDeps.exclude` — WASM is now bundled by Vite's native pipeline (`.wasm` handled via `new URL()` asset references, content-hashed in output). Removed `fs.allow` parent-directory workaround no longer needed for WASM. Production build verified: `phpoc_crypto_core_bg-30LYJKWU.wasm` (134KB) + `phpoc_crypto_core-D9wuZLDO.js` (10KB). Browser E2E verified: WASM crypto loads with no yellow warning banner. All 96 crypto tests pass (22 smoke + 74 integration). | ✅ | 96 | Jun 24 2026 |
| 53 | **Import/Export Test Coverage — Tier 1** — 4 new test files for web local import/export workflow coverage. **ledger_import_chain_test.mjs** (31 tests): raw chain import path — genesis detection, block seal verification, prev_hash linkage, entry hash validation, mixed block types, error cases (empty, missing genesis, broken linkage, tampered seal, wrong key, bad entry hash, unknown type, missing hash field). **ledger_import_v2_test.mjs** (42 tests): v2 format import — genesis hash extraction, ledger+staging preservation, empty edge cases, multiple entries, active task preservation, seal tampering, wrong key, missing arrays. **import_orchestration_test.mjs** (51 tests): two-phase validate→confirm orchestration — fresh install, existing data detection, genesis gating (v1 skips, v2 checks), staging merge dedup, ID collision resolution, identity persistence (username/email from genesis), ledger:blocks write, call guard (confirm without validate). **ledger_roundtrip_test.mjs** (46 tests): full export→import fidelity — v1 roundtrip (5 entries, active, paused, rich metadata, empty), v2 roundtrip (blocks+staging, empty staging, active staging), deterministic seal, wrong key rejection. **Total: 170 new tests, zero regressions across all existing suites (112 existing + 170 new = 282 total).** | ✅ | 170 (0 fail) | Jun 24 2026 |
| 54 | **Export Ledger Fix** — Two bugs: (1) Error swallowing: `handleExport` re-threw errors but PassphraseModal called `onSubmit` without awaiting — errors became unhandled promise rejections, modal stayed open with no feedback. Fixed by adding `exportError` state + passing `errorMessage` to PassphraseModal. (2) Wrong export format: `exportLedgerAction` used v1 (`exportLedger()`, staging-only). Once entries are committed, staging is empty → "No entries to export." Fixed by switching to `exportLedgerFull()` (v2, committed blocks + staging) in both fast and slow paths of `exportLedgerAction`. Browser E2E verified. Zero regressions across 40 test files (~1900 tests). | ✅ | — | Jun 24 2026 |
| 55 | **Export/Import Hash Recomputation Fix (Step 5 TDD)** — Entry hashes were preserved as-is during export, but real entries have fields (`committed`, `block_index`, `entry_index`) added by `LocalCache.append()` after hash computation. Import re-validated over ALL fields → hash mismatch → roundtrip broken. Fix: `exportLedger()` and `exportLedgerFull()` now recompute each staging entry's hash to cover all fields except `hash` before computing the seal. Ledger blocks NOT recomputed. 37 new/updated tests: Group A (6 new in `ledger_export_test.mjs`), Group B (7 new in `ledger_export_full_test.mjs`), Group C (24 new in `ledger_roundtrip_test.mjs`), 3 existing tests updated. Total: 185/185 pass (30+71+84). TDD: RED → GREEN. | ✅ | 185 (0 fail) | Jun 28 2026 |

---

## Bugs Found and Fixed

### Device UUID Bug (2026-06-18)

The WASM `get_device_id(MK)` returns `HMAC(MK, "device:id")` — deterministic from passphrase (per PHPSPEC §2.8 default). The CLI uses `RandomUUIDDeviceIdentityProvider` which generates and persists a random UUID4. If the web app uses WASM's default, all devices with the same passphrase produce the same device UUID, causing the cookie mechanism to incorrectly treat different devices as the same device (Case A — push only, no merge).

**Fix:** `getOrCreateDeviceUuid(storage)` in `src/sync/device_uuid.js` generates `crypto.randomUUID()` on first boot, persists in IndexedDB, and auto-migrates WASM-derived hex UUIDs. `SyncService._getDeviceId()` now reads from storage first, falls back to WASM only as last resort.

**Follow-up fix (2026-06-18):** `_reconcileAndClaim()` cookie creation was still using `this._crypto.getDeviceId(masterKeyHex)` — the WASM-derived UUID — to populate the remote cookie's `device_uuid` field. Changed to `await this._getDeviceId()`. Without this, the remote cookie always held a WASM UUID while the local device had a UUID4, causing permanent Case B (pull+merge+push) on every sync.

122 tests (22 + 40 + 60) all passing.

### Other Issues

- **TDZ Crash: `triggerReauth` before initialization** (2026-06-23): Cookie TTL monitor `useEffect` in `DevModeContext.jsx` referenced `triggerReauth` in its dependency array, but `const triggerReauth = useCallback(...)` was declared later in the component. Caused blank white page. Fixed by moving re-auth state + callbacks above the cookie TTL monitor `useEffect`.
- **WASM CryptoService: dynamic import unresolved in production build** (2026-06-24): Vite's `build.rollupOptions.external` excluded `phpoc_crypto_core` from bundling. Fixed by copying WASM artifacts into `src/crypto/wasm/` and removing the exclusion — Vite's native pipeline bundles + content-hashes the `.wasm` binary via `new URL()` asset references.
- **Export Ledger: error swallowing + staging-only export** (2026-06-24): (1) `handleExport` re-threw errors but PassphraseModal called `onSubmit` without awaiting — errors became unhandled promise rejections. Fixed by adding `exportError` state. (2) `exportLedgerAction` used v1 (staging-only) → empty after commit. Fixed by switching to `exportLedgerFull()` (v2).
- **Genesis gate: empty remote treated as incompatible** (2026-06-21): Empty R2 bucket returned `{compatible: false}`, permanently blocking sync. Fixed: empty remote now returns `compatible: true` (first boot, no conflict).
- **Genesis merge result never persisted** (2026-06-21): `checkAndSync()` cached `_genesisCompatible` boolean but discarded `mergedChain`. Fixed: writes merged chain + index to storage.
- **"Sync Now" button only synced staging blob, never committed** (2026-06-21): `SyncSettings` sync called `checkAndSync()` but never committed entries to ledger. Fixed: auto-commits completed entries after sync.
- **HttpTransport.delete(): `timeoutMs` unused** (2026-06-20): `AbortSignal.timeout()` wired into all four methods (`pull`, `push`, `listFiles`, `delete`).
- **MockRemoteBackend `listFiles()` returned full paths** (2026-06-20): Worker strips prefix to return basenames. Fixed: `MockRemoteBackend` now strips prefix to match Worker contract.
- **ETag caching stale in long-running daemon** (2026-06-20): Added `cacheTtlMs`/`cache_ttl_s` to JS `HttpTransport` and Python `HttpStagingTransport`. Entries auto-evicted on access when older than TTL.
- **IndexedDB unavailable in private browsing** (2026-06-20): Fell back to in-memory Map (data lost on refresh). Fixed: cascade fallback IndexedDB → SessionStorageBackend (survives refresh) → in-memory Map.
- **`isWasmDerivedUuid` regex too broad** (2026-06-20): Matched MD5 (32 chars) and SHA-1 (40). Fixed: tightened to exactly 64 hex chars (SHA-256).
- **Index-based staging operations had stale-index race** (2026-06-20): Added `update_by_entry_id`, `add_pause_by_entry_id`, `close_pause_by_entry_id` to `LocalStagingCache` — find by stable UUID instead of positional index.
- **`_getDeviceId()` called twice in push operations** (2026-06-20): Reduced from 2–3 calls to 1 via `pushBlobOnly()` accepting optional `deviceId` param.
- **`createStoragePlugin` lan/saas returned `HttpBackend` directly** (2026-06-20): Fixed to return `IndexedDBBackend` — storage and transport are separate concerns.
- **`apiKey` normalization differed between factories** (2026-06-20): `readRemoteConfig()` used `''`, `createRemoteTransport()` used `null`. Normalized to `null`.
- **Code review: `useAutoSync.js` (6 findings)** (2026-06-20): Stale closures, `require('react')` in ES module, 100ms polling, `_syncing` state leak, dead `_disposed` check, silent `{}` fallback. All resolved.
- **Duplicate Entry Race Condition** (Step 33): Fixed read-modify-write race in `LocalCache.update()`. Three guards. (2026-06-16)
- **Sync Screen Enter-Key Bug** (Step 32): Enter in tag-add input collapsed the card. Fixed with `stopPropagation()`. (2026-06-16)
- **Cross-platform JSON:** `JSON.stringify()` and `json.dumps()` produce different whitespace. Fixed with `jsonSort()` helper producing Python-compatible JSON. (2026-06-18)

---

## Remote Sync Wiring — Test Plan

Phase 1 tests written. P1 suites complete, P2 suites pending.

| Suite | What | Priority | Status |
|-------|------|:---:|:---:|
| `test/sync_service_test.mjs` | `SyncService.checkAndSync()` auth gate: READY/OFFLINE/REAUTH_NEEDED with mock transport | P1 | ✅ 40 tests |
| `test/sync_service_test.mjs` | `SyncService._reconcileAndClaim()`: Case A (same UUID → push only) vs Case B (different UUID → pull+merge) | P1 | ✅ |
| `test/device_uuid_test.mjs` | Device UUID generation, IndexedDB persistence, survives refresh/re-login | P1 | ✅ 22 tests |
| `test/remote_transport_test.mjs` | `createRemoteTransport()`: null for standalone/mock/memory, HttpTransport for saas/lan | P2 | ✅ 40 assertions |
| `test/remote_config_test.mjs` | localStorage persistence for deployment, baseUrl, apiKey; URL param priority; fallback to standalone on invalid config | P2 | ✅ 35 tests |

**Existing test coverage:** 512 tests across 14 suites (transport 49, http_backend 41, storage_plugin ~50, sync 60, ledger engine 4 suites 266, mock_remote 46). All green.

---

## Answered Decisions

| Question | Answer |
|----------|--------|
| **API Worker: extend or separate?** | Extend the existing Worker with ~20 lines. No separate service needed. |
| **Auth: API key vs session tokens?** | API key (shared secret) is sufficient. The passphrase is the real auth mechanism — it never leaves the device. |
| **Stateless or stateful API?** | Stateless. The Worker has no session state. Mobile handles cookies and auth locally. |
| **Which platform first?** | **Web (React)** — uses Rust → WASM crypto. **Flutter** follows in Phase 2 (uses Rust → `.a`/`.so` via `flutter_rust_bridge`, zero hand-written FFI). React Native is Phase 3 contingency. |
| **Shared Python SDK?** | Not needed. Every client ports the sync algorithm natively — ~100 lines of branching + crypto calls. |
| **OpenAPI spec?** | Not needed. The wire protocol is three HTTP verbs, fully defined by `core/sync/http_transport.py`. |
| **`POST /sync` endpoint?** | Not needed. Sync runs client-side. The server is not involved. |

---

## References

- `worker/src/index.ts` — Current Cloudflare Worker (~200 lines, dumb blob store)
- `core/sync/http_transport.py` — Python HTTP transport client (wire protocol reference)
- `domain/ledger/remote_sync.py` — Ledger block sync via HTTP (path constants, push/pull logic)
- `domain/staging/remote_sync.py` — Staging blob sync + device cookie (blob obfuscation, cookie format)
- `domain/staging/service.py` — Auth gate, `check_and_sync()`, `_reconcile_and_claim()` (sync algorithm reference)
- [`../spec/PHPSPEC.md`](../spec/PHPSPEC.md) — Format specification (crypto, block structure, key derivation)
- [`../../SESSION_HANDOFF.md`](../../SESSION_HANDOFF.md) — Current state of the project (context restoration anchor)
- `phpoc-web/src/crypto/index.js` — `CryptoService` — singleton WASM wrapper (key cache, ready-guards, all 20 exports)
- `phpoc-web/test/wasm_integration.mjs` — 74-test integration suite (all 20 functions vs test vectors)
