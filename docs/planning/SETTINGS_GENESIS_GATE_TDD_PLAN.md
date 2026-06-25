# Settings Genesis Gate Integration — TDD Test Plan (Phase RED)

> **Status:** 🟢 PHASE GREEN — All 26 component tests pass. Accessibility features (`aria-live="polite"`, `role="status"`) added to Settings.jsx.
> **Category C:** 🟡 PARTIAL (3 PASS / 1 FAIL / 4 SKIP) — Browser E2E results below.
> **Context:** SESSION_HANDOFF.md §"Settings Genesis Gate Integration — Browser E2E"
> **Goal:** Full test coverage for Settings screen genesis gate UI integration before any code changes.

---

## Category C Browser E2E Results (2026-06-25)

**Preview server:** `http://localhost:4174/?dev=false` (port 4174)

| ID | Result | Details |
|----|--------|--------|
| **C1** | ✅ PASS | "✅ Genesis compatible" + entry count for correct Worker URL + API key |
| **C2** | ❌ FAIL | Sync Now → OFFLINE. Root cause: SyncService transport configured at bootstrap, not updated on Settings save. `checkAndSync()` uses stale transport. See SESSION_HANDOFF.md Known Issues. |
| **C3** | ⏭️ SKIP | Need Worker with different genesis; testing Worker returns 404 (empty). |
| **C4** | ✅ PASS | "🔌 Cannot reach remote" + "Network error" for bad URL |
| **C5** | ⚠️ UNTESTABLE | agent_browser `fill` doesn't trigger React onChange; can't clear URL field |
| **C6** | ✅ PASS | API key change re-triggers check → "Authentication failed" with wrong key |
| **C7** | ⏭️ SKIP | Requires clearing local ledger (destructive) |
| **C8** | ⏭️ SKIP | Settings page not accessible without auth |

---

## Coverage Map

| Category | Tests | Type | Status | File |
|----------|:-----:|------|--------|------|
| **A: State Machine Logic** | 13 | Unit (logic-only) | 🟢 DONE | `test/settings_genesis_test.mjs` |
| **B: React Component Integration** | 20 | Unit (Vitest + RTL) | 🟢 GREEN (20 pass) | `test/settings_genesis_component.test.mjs` |
| **C: Browser E2E** | 8 | E2E (agent-browser) | 🟡 PARTIAL (3/1/4) | Browser session |
| **D: SyncService Genesis Gate** | 3 | Unit (logic-only) | 🟢 DONE | `test/sync_service_test.mjs` Group I |
| **E: Edge Cases & Regressions** | 6 | Unit (component) | 🟢 GREEN (6 pass) | `test/settings_genesis_component.test.mjs` |
| **F: Accessibility & A11Y** | 4 | Unit (component) | 🟢 GREEN (4 pass) | `test/settings_genesis_component.test.mjs` |
| **TOTAL** | **54** | — | **50 🟢 / 1 🔴 / 3 ⏭️** | — |

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

## Category B: React Component Integration (🟢 GREEN — `settings_genesis_component_test.mjs`)

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
| **C1** | Enter Worker URL + API key → save → see compatible status | Fresh ledger created, Worker URL + API key entered, Save clicked → green "✅ Genesis compatible" card appears with remote entry count | ✅ PASS |
| **C2** | Compatible + "Sync Now" → sync proceeds | Genesis gate compatible → click "Sync Now" → staging entries sync to remote | ❌ FAIL — SyncService transport stale after Settings change |
| **C3** | Enter incompatible Worker URL → see incompatible status | Local ledger with different genesis than remote → Save → red "⚠️ Genesis incompatible" card with reason | ⏭️ SKIP — no incompatible Worker available |
| **C4** | Enter bad URL → see error or offline status | Non-existent Worker URL → Save → orange "🔌 Cannot reach remote" card | ✅ PASS |
| **C5** | Clear URL → status disappears | Enter URL → Save → see status → clear URL field → Save → genesis status card gone from DOM | ⚠️ UNTESTABLE — fill doesn't trigger React onChange |
| **C6** | Change API key → re-triggers check | Same URL, new API key → Save → genesis check re-runs (checking → new result) | ✅ PASS — "Authentication failed" with wrong key |
| **C7** | No local ledger → status stays idle | Fresh session with no committed ledger → enter Worker URL + Save → no genesis card appears | ⏭️ SKIP — requires clearing ledger |
| **C8** | Save without auth → stays idle | Session with ledger but no master key (not authenticated) → Save → no genesis card | ⏭️ SKIP — Settings not accessible without auth |

---

## Category D: SyncService Genesis Gate (EXISTING — 🟢 DONE)

> `test/sync_service_test.mjs` Group I — Tests genesis gate behavior within `checkAndSync()`.

| ID | Test | Purpose |
|----|------|---------|
| **D1** | Compatible → checkAndSync proceeds | Genesis compatible → does NOT return GENESIS_MISMATCH, proceeds to auth gate |
| **D2** | Mismatch → GENESIS_MISMATCH returned | Different genesis keys → checkAndSync returns SyncResult.GENESIS_MISMATCH |
| **D3** | resetGenesisGate clears cache | After resetGenesisGate(), next checkAndSync() re-checks (no cached result) |

---

## Category E: Edge Cases & Regressions (🟢 GREEN)

| ID | Test | Purpose |
|----|------|---------|
| **E1** | Double-save with same data → no duplicate check | Consecutive saves with identical URL/API key → genesis check runs only once |
| **E2** | Rapid URL changes → only last check matters | Type URL1 → Save → URL2 → Save quickly → only URL2's check result renders; intermediate results discarded |
| **E3** | Genesis check while check in-flight → dedup | `handleSaveRemote` called twice in rapid succession → only one network call; both saves share the same result |
| **E4** | Save with empty API key → still runs check | URL set, API key blank → genesis check still triggers (some Workers don't require API key) |
| **E5** | GenesisGate throws unexpected error → offline | GenesisGate.check throws non-network error → caught by catch block → status=`offline` with message |
| **E6** | localStorage persist works | After save, `localStorage.getItem('phpoc_worker_url')` returns correct value |

---

## Category F: Accessibility & A11Y (🟢 GREEN)

| ID | Test | Purpose |
|----|------|---------|
| **F1** | Checking hint has aria-live="polite" | Checking text announced to screen readers |
| **F2** | Compatible status is perceivable by color-blind users | Status uses border + text + icon, not color alone |
| **F3** | Incompatible status is perceivable by color-blind users | Red card uses icon + text + border, not color alone |
| **F4** | Status cards have role="status" | All genesis status cards use `role="status"` for live-region-like behavior |

---

## Test Execution Plan

1. **Phase RED (current):** Document all 54 tests. File: `docs/planning/SETTINGS_GENESIS_GATE_TDD_PLAN.md`
2. **Phase RED — Test Creation:** ✅ DONE — 26 tests written, 24 pass existing / 2 RED accessibility
3. **Phase GREEN:** ✅ DONE — Added `aria-live="polite"` to checking text + `role="status"` to genesis-status container in `Settings.jsx`. All 26 component tests pass.
4. **Phase REFACTOR:** Consolidate state machine, deduplicate logic, optimize renders
5. **Browser E2E:** 🟡 PARTIAL (2026-06-25) — 3 pass, 1 fail, 4 skipped. Key finding: C2 bug (SyncService transport stale after Settings change). Next: fix C2 bug, then re-test C2/C3/C5/C7/C8.

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
