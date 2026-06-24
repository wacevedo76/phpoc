# Settings Genesis Gate Integration — TDD Test Plan (Phase RED)

> **Status:** 🔴 PHASE RED — Test identification complete. Tests not yet written.
> **Context:** SESSION_HANDOFF.md §"Settings Genesis Gate Integration — Browser E2E"
> **Goal:** Full test coverage for Settings screen genesis gate UI integration before any code changes.

---

## Coverage Map

| Category | Tests | Type | Status | File |
|----------|:-----:|------|--------|------|
| **A: State Machine Logic** | 13 | Unit (logic-only) | 🟢 DONE | `test/settings_genesis_test.mjs` |
| **B: React Component Integration** | 20 | Unit (Vitest + RTL) | 🔴 PLANNED | `test/settings_genesis_component_test.mjs` (NEW) |
| **C: Browser E2E** | 8 | E2E (agent-browser) | 🔴 PLANNED | Browser session |
| **D: SyncService Genesis Gate** | 3 | Unit (logic-only) | 🟢 DONE | `test/sync_service_test.mjs` Group I |
| **E: Edge Cases & Regressions** | 6 | Unit (component) | 🔴 PLANNED | `test/settings_genesis_component_test.mjs` |
| **F: Accessibility & A11Y** | 4 | Unit (component) | 🔴 PLANNED | `test/settings_genesis_component_test.mjs` |
| **TOTAL** | **54** | — | **16 🟢 / 38 🔴** | — |

---

## Category A: State Machine Logic (EXISTING — 🟢 DONE)

> `test/settings_genesis_test.mjs` — Tests `simulateGenesisCheck()`, a test-only function that mirrors the `handleSaveRemote` state machine. Does NOT render React components.

| ID | Test | Purpose |
|----|------|---------|
| **A1** | Save triggers check → compatible | First save with matching genesis → status=`compatible` with stats |
| **A2** | Different genesis → incompatible | Different identity → different genesis hash → status=`incompatible`, reason=`genesis_mismatch` |
| **A3** | Network error → incompatible | Transport offline → internal catch by GenesisGate → status=`incompatible`, reason=`network_error` |
| **A4** | Clear URL → reset to idle | Empty workerUrl → status=`idle` |
| **A5** | API key change re-triggers check | Same URL, different API key → re-triggers genesis check |
| **A6** | URL unchanged → skip check | Same URL + same API key → status=`unchanged` (no network call) |
| **A7** | No local ledger → skip check | Empty `ledger:blocks` → status=`idle` |
| **A8** | No master key → skip check | `getMasterKey()` returns null → status=`idle` |
| **A9** | Invalid URL → error | URL doesn't start with `http` → status=`error` |
| **A10** | Empty remote → compatible | Remote has no blocks (first boot) → status=`compatible`, stats.remote=0 |
| **A11** | Non-genesis block[0] → invalid_genesis | Remote block[0].type != 'genesis' → status=`incompatible`, reason=`invalid_genesis` |
| **A12** | Non-array remote → invalid_format | Remote JSON is not an array → status=`incompatible`, reason=`invalid_format` |
| **A13** | Auth failure (403) → incompatible | Transport throws 403 → status=`incompatible`, reason=`auth_failure` |

---

## Category B: React Component Integration (NEW 🔴 — `settings_genesis_component_test.mjs`)

> Tests that render `Settings.jsx` via Vitest + `@testing-library/react` and exercise the actual `handleSaveRemote` handler. The component is mounted under a mock `DevModeContext` provider. Uses MockTransport, MockCrypto, MemoryBackend for test isolation.

### B1 — Save: Compatible Genesis

| ID | Test | Purpose |
|----|------|---------|
| **B1.1** | Compatible status renders green badge | Save URL with matching genesis → DOM shows "✅ Genesis compatible" green card with remote entry count |
| **B1.2** | Compatible status persists after save | Status remains "compatible" after save button re-clicks with same URL |
| **B1.3** | Compatible status shows stats text | Green card includes "Remote has N committed entries. Ready to sync." |

### B2 — Save: Incompatible Genesis

| ID | Test | Purpose |
|----|------|---------|
| **B2.1** | Incompatible status renders red badge | Save URL with different genesis → DOM shows "⚠️ Genesis incompatible" red card |
| **B2.2** | Incompatible status shows reason | Red card includes "Reason: genesis_mismatch" message |
| **B2.3** | `auth_failure` reason displayed correctly | 403 from Worker → red card shows "Reason: auth_failure" |

### B3 — Save: Network Error

| ID | Test | Purpose |
|----|------|---------|
| **B3.1** | Offline status renders orange badge | Network error → DOM shows "🔌 Cannot reach remote" orange card |
| **B3.2** | Offline status shows error message | Orange card includes network error message text |

### B4 — Save: Error State

| ID | Test | Purpose |
|----|------|---------|
| **B4.1** | Error status renders red badge | Invalid URL → DOM shows "❌ Error" red card with reason |

### B5 — Status Transitions

| ID | Test | Purpose |
|----|------|---------|
| **B5.1** | Checking → compatible transition | Status shows "⏳ Checking…" then updates to compatible green card |
| **B5.2** | Checking → incompatible transition | Status shows checking spinner then updates to incompatible red card |
| **B5.3** | Clear URL → status disappears | Save empty URL → genesis status div removed from DOM |
| **B5.4** | Compatible → idle on clear URL | Compatible status card → save empty URL → status resets to idle (no card) |
| **B5.5** | Incompatible → idle on clear URL | Incompatible status card → save empty URL → status resets to idle (no card) |

### B6 — Save Button Feedback

| ID | Test | Purpose |
|----|------|---------|
| **B6.1** | Save button shows "✓ Saved" | After form submit → button text changes to "✓ Saved" |
| **B6.2** | "✓ Saved" reverts after timeout | Button text reverts to "Save" after 2-second timeout |
| **B6.3** | Save clears on quick re-submit | First save shows "✓ Saved" → re-submit with same data → button doesn't flash |
| **B6.4** | Save on only URL change | URL input fires save → localStorage updated → genesis check triggered |

---

## Category C: Browser E2E (NEW 🔴 — agent-browser session)

> Full end-to-end tests in a real Vivaldi browser with production build (`vite preview`). Uses real WASM crypto (no mocks), real IndexedDB. Tests the complete user flow from data entry to visual feedback.

| ID | Test | Purpose |
|----|------|---------|
| **C1** | Enter Worker URL + API key → save → see compatible status | Fresh ledger created, Worker URL + API key entered, Save clicked → green "✅ Genesis compatible" card appears with remote entry count |
| **C2** | Compatible + "Sync Now" → sync proceeds | Genesis gate compatible → click "Sync Now" → staging entries sync to remote |
| **C3** | Enter incompatible Worker URL → see incompatible status | Local ledger with different genesis than remote → Save → red "⚠️ Genesis incompatible" card with reason |
| **C4** | Enter bad URL → see error or offline status | Non-existent Worker URL → Save → orange "🔌 Cannot reach remote" card |
| **C5** | Clear URL → status disappears | Enter URL → Save → see status → clear URL field → Save → genesis status card gone from DOM |
| **C6** | Change API key → re-triggers check | Same URL, new API key → Save → genesis check re-runs (checking → new result) |
| **C7** | No local ledger → status stays idle | Fresh session with no committed ledger → enter Worker URL + Save → no genesis card appears |
| **C8** | Save without auth → stays idle | Session with ledger but no master key (not authenticated) → Save → no genesis card |

---

## Category D: SyncService Genesis Gate (EXISTING — 🟢 DONE)

> `test/sync_service_test.mjs` Group I — Tests genesis gate behavior within `checkAndSync()`.

| ID | Test | Purpose |
|----|------|---------|
| **D1** | Compatible → checkAndSync proceeds | Genesis compatible → does NOT return GENESIS_MISMATCH, proceeds to auth gate |
| **D2** | Mismatch → GENESIS_MISMATCH returned | Different genesis keys → checkAndSync returns SyncResult.GENESIS_MISMATCH |
| **D3** | resetGenesisGate clears cache | After resetGenesisGate(), next checkAndSync() re-checks (no cached result) |

---

## Category E: Edge Cases & Regressions (NEW 🔴)

| ID | Test | Purpose |
|----|------|---------|
| **E1** | Double-save with same data → no duplicate check | Consecutive saves with identical URL/API key → genesis check runs only once |
| **E2** | Rapid URL changes → only last check matters | Type URL1 → Save → URL2 → Save quickly → only URL2's check result renders; intermediate results discarded |
| **E3** | Genesis check while check in-flight → dedup | `handleSaveRemote` called twice in rapid succession → only one network call; both saves share the same result |
| **E4** | Save with empty API key → still runs check | URL set, API key blank → genesis check still triggers (some Workers don't require API key) |
| **E5** | GenesisGate throws unexpected error → offline | GenesisGate.check throws non-network error → caught by catch block → status=`offline` with message |
| **E6** | localStorage persist works | After save, `localStorage.getItem('phpoc_worker_url')` returns correct value |

---

## Category F: Accessibility & A11Y (NEW 🔴)

| ID | Test | Purpose |
|----|------|---------|
| **F1** | Checking hint has aria-live="polite" | Checking text announced to screen readers |
| **F2** | Compatible status is perceivable by color-blind users | Status uses border + text + icon, not color alone |
| **F3** | Incompatible status is perceivable by color-blind users | Red card uses icon + text + border, not color alone |
| **F4** | Status cards have role="status" | All genesis status cards use `role="status"` for live-region-like behavior |

---

## Test Execution Plan

1. **Phase RED (current):** Document all 54 tests. File: `docs/planning/SETTINGS_GENESIS_GATE_TDD_PLAN.md`
2. **Phase RED — Test Creation:**
   - Install dev dependencies: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`
   - Create `test/settings_genesis_component_test.mjs` (Categories B, E, F — 30 tests, all RED)
   - All tests fail because no Vitest runner configured + placeholder test structure
3. **Phase GREEN:** Implement missing UI features, make all 30 component tests pass
4. **Phase REFACTOR:** Consolidate state machine, deduplicate logic, optimize renders
5. **Browser E2E:** Run Category C tests in Vivaldi using agent_browser

---

## Dependencies for Component Tests

```
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

**vite.config.js** needs:
```js
/// <reference types="vitest" />
export default defineConfig({
  // ... existing ...
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/vitest-setup.js'],
  },
});
```

**test/vitest-setup.js:**
```js
import '@testing-library/jest-dom';
```

---

## Test Infrastructure Needed

| Item | File | Description |
|------|------|-------------|
| Vitest config | `vite.config.js` | Add `test` block |
| Vitest setup | `test/vitest-setup.js` | `@testing-library/jest-dom` imports |
| Mock context provider | Inline in test | Wraps Settings with mock `useApp()` values |
| Mock crypto | Reuse `test/mock_crypto.mjs` | MockCrypto with setMasterKey/getMasterKey |
| Mock transport | Inline or reuse | MockTransport from genesis_gate_test patterns |
| Mock storage | Inline MemoryBackend | Map-based get/set/delete |
| Chain builder | Inline helpers | buildGenesisBlock, buildChain from settings_genesis_test |
| package.json script | `"test:vitest": "npx vitest run"` | Run component tests |
