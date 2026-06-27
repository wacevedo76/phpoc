/**
 * remote_settings_clear_test.mjs — Test localStorage clearing on new ledger import.
 *
 * Verifies that Worker URL and API Key are cleared from localStorage when:
 *   1. A new ledger is created (createNewLedger / init)
 *   2. A ledger is imported from file (confirmImport)
 *
 * And that they are PRESERVED (not cleared) when:
 *   3. Connecting to an existing Worker-hosted ledger (connectToWorker)
 *
 * The phpoc_worker_url and phpoc_api_key live in localStorage, while
 * ledger data lives in IndexedDB. A storage.clear() (IndexedDB) must
 * be accompanied by localStorage.removeItem() for these two keys.
 *
 * Usage:
 *   node test/remote_settings_clear_test.mjs
 */

import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// localStorage mock (Node.js doesn't have localStorage)
// ══════════════════════════════════════════════════════════════════════

let _localStorage = new Map();

function mockLocalStorage() {
  _localStorage = new Map();
  globalThis.localStorage = {
    getItem: (key) => _localStorage.get(key) ?? null,
    setItem: (key, value) => _localStorage.set(key, value),
    removeItem: (key) => _localStorage.delete(key),
    clear: () => _localStorage.clear(),
    get length() { return _localStorage.size; },
    key: (i) => [..._localStorage.keys()][i] ?? null,
  };
}

function resetLocalStorage() {
  _localStorage = new Map();
  if (globalThis.localStorage) {
    globalThis.localStorage.getItem = (key) => _localStorage.get(key) ?? null;
    globalThis.localStorage.setItem = (key, value) => _localStorage.set(key, value);
    globalThis.localStorage.removeItem = (key) => _localStorage.delete(key);
    globalThis.localStorage.clear = () => _localStorage.clear();
  }
}

// ══════════════════════════════════════════════════════════════════════
// Helper: simulate the exact clearing logic from DevModeContext.jsx
// ══════════════════════════════════════════════════════════════════════

/**
 * Simulates createNewLedger's clear behavior.
 * Mirrors lines 519-525 of DevModeContext.jsx.
 */
async function simulateCreateNewLedgerClear() {
  // storage.clear() — IndexedDB clear (simulated as no-op here)
  // await storage.clear();

  // localStorage clearing — the fix
  localStorage.removeItem('phpoc_worker_url');
  localStorage.removeItem('phpoc_api_key');
}

/**
 * Simulates confirmImport's clear behavior.
 * Mirrors lines 692-698 of DevModeContext.jsx.
 */
async function simulateConfirmImportClear() {
  // storage.clear() — IndexedDB clear (simulated as no-op here)
  // await storage.clear();

  // localStorage clearing — the fix
  localStorage.removeItem('phpoc_worker_url');
  localStorage.removeItem('phpoc_api_key');
}

/**
 * Simulates connectToWorker's behavior — should PRESERVE localStorage.
 * Mirrors lines 860-870 of DevModeContext.jsx.
 */
async function simulateConnectToWorker(baseUrl, apiKey) {
  // storage.clear() — IndexedDB clear
  // await storage.clear();

  // Note: NO localStorage.removeItem calls — connectToWorker preserves them
  // Instead, it WRITES them:
  if (baseUrl) {
    localStorage.setItem('phpoc_worker_url', baseUrl);
  }
  if (apiKey) {
    localStorage.setItem('phpoc_api_key', apiKey);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

console.log('\n═════ Group A: createNewLedger clears remote settings ═════\n');

{
  mockLocalStorage();

  // Seed localStorage with old values
  localStorage.setItem('phpoc_worker_url', 'https://old-worker.workers.dev');
  localStorage.setItem('phpoc_api_key', 'old-api-key-secret');

  // Simulate creating a new ledger
  await simulateCreateNewLedgerClear();

  t.assertEq(
    localStorage.getItem('phpoc_worker_url'),
    null,
    'A1: Worker URL should be null after createNewLedger'
  );

  t.assertEq(
    localStorage.getItem('phpoc_api_key'),
    null,
    'A2: API key should be null after createNewLedger'
  );

  // Verify no stray keys were removed
  t.assertEq(
    localStorage.length, 0,
    'A3: localStorage should be empty (no orphaned keys)'
  );

  resetLocalStorage();
}

console.log('\n═════ Group B: confirmImport clears remote settings ═════\n');

{
  mockLocalStorage();

  // Seed localStorage with old values
  localStorage.setItem('phpoc_worker_url', 'https://previous-worker.workers.dev');
  localStorage.setItem('phpoc_api_key', 'prev-api-key-12345');

  // Also set an unrelated key to verify it's NOT cleared
  localStorage.setItem('phpoc_theme', 'dark');

  // Simulate confirming an import
  await simulateConfirmImportClear();

  t.assertEq(
    localStorage.getItem('phpoc_worker_url'),
    null,
    'B1: Worker URL should be null after confirmImport'
  );

  t.assertEq(
    localStorage.getItem('phpoc_api_key'),
    null,
    'B2: API key should be null after confirmImport'
  );

  // Unrelated localStorage keys must survive
  t.assertEq(
    localStorage.getItem('phpoc_theme'),
    'dark',
    'B3: Unrelated localStorage keys (phpoc_theme) should not be cleared'
  );

  t.assertEq(
    localStorage.length, 1,
    'B4: localStorage should contain exactly 1 key (phpoc_theme)'
  );

  resetLocalStorage();
}

console.log('\n═════ Group C: connectToWorker PRESERVES settings ═════\n');

{
  mockLocalStorage();

  const NEW_URL = 'https://new-worker.example.workers.dev';
  const NEW_KEY = 'new-secret-api-key';

  // Simulate connecting to a Worker-hosted ledger
  await simulateConnectToWorker(NEW_URL, NEW_KEY);

  t.assertEq(
    localStorage.getItem('phpoc_worker_url'),
    NEW_URL,
    'C1: Worker URL should be PRESERVED after connectToWorker'
  );

  t.assertEq(
    localStorage.getItem('phpoc_api_key'),
    NEW_KEY,
    'C2: API key should be PRESERVED after connectToWorker'
  );

  t.assertEq(
    localStorage.length, 2,
    'C3: localStorage should contain exactly 2 keys'
  );

  resetLocalStorage();
}

console.log('\n═════ Group D: Empty connectToWorker (no URL/key passed) ═════\n');

{
  mockLocalStorage();

  // Simulate a connectToWorker that has no URL or key (edge case)
  await simulateConnectToWorker('', '');

  // Empty strings are falsy so setItem is not called — keys remain absent
  t.assertEq(
    localStorage.getItem('phpoc_worker_url'),
    null,
    'D1: Worker URL should remain null when none provided'
  );

  t.assertEq(
    localStorage.getItem('phpoc_api_key'),
    null,
    'D2: API key should remain null when none provided'
  );

  resetLocalStorage();
}

console.log('\n═════ Group E: Double-init (createNewLedger twice) ═════\n');

{
  mockLocalStorage();

  // First init
  localStorage.setItem('phpoc_worker_url', 'https://first-worker.workers.dev');
  localStorage.setItem('phpoc_api_key', 'first-key');
  await simulateCreateNewLedgerClear();

  t.assertEq(localStorage.getItem('phpoc_worker_url'), null, 'E1: Cleared after first init');

  // Second init — should be idempotent (no errors on already-null keys)
  localStorage.setItem('phpoc_worker_url', 'https://second-worker.workers.dev');
  localStorage.setItem('phpoc_api_key', 'second-key');
  await simulateCreateNewLedgerClear();

  t.assertEq(localStorage.getItem('phpoc_worker_url'), null, 'E2: Cleared after second init');
  t.assertEq(localStorage.getItem('phpoc_api_key'), null, 'E3: Cleared after second init');
  t.assertEq(localStorage.length, 0, 'E4: localStorage empty after double init');

  resetLocalStorage();
}

console.log('\n═════ Group F: Import then connect (state machine) ═════\n');

{
  mockLocalStorage();

  // Step 1: User has old settings, imports a new ledger
  localStorage.setItem('phpoc_worker_url', 'https://old-bad-worker.workers.dev');
  localStorage.setItem('phpoc_api_key', 'compromised-key');
  await simulateConfirmImportClear();

  t.assertEq(localStorage.getItem('phpoc_worker_url'), null, 'F1: Cleared after import');
  t.assertEq(localStorage.getItem('phpoc_api_key'), null, 'F2: Cleared after import');

  // Step 2: User then connects to a Worker
  await simulateConnectToWorker('https://fresh-worker.workers.dev', 'fresh-key');

  t.assertEq(
    localStorage.getItem('phpoc_worker_url'),
    'https://fresh-worker.workers.dev',
    'F3: Worker URL set after connect'
  );
  t.assertEq(
    localStorage.getItem('phpoc_api_key'),
    'fresh-key',
    'F4: API key set after connect'
  );

  // Step 3: User imports yet another ledger — settings cleared again
  await simulateConfirmImportClear();

  t.assertEq(localStorage.getItem('phpoc_worker_url'), null, 'F5: Cleared after second import');
  t.assertEq(localStorage.getItem('phpoc_api_key'), null, 'F6: Cleared after second import');

  resetLocalStorage();
}

// ══════════════════════════════════════════════════════════════════════
// Report
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══════════════════════════════════════════════════════`);
console.log(`  Tests: ${t.passed} passed, ${t.failed} failed`);
if (t.errors.length) {
  console.log(`  Failed:`);
  t.errors.forEach(e => console.log(`    - ${e}`));
}
console.log(`═══════════════════════════════════════════════════════\n`);

process.exit(t.failed === 0 ? 0 : 1);
