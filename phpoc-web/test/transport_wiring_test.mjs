/**
 * transport_wiring_test.mjs — Integration tests for transport creation from deployment.
 *
 * Tests createTransportFromDeployment() — the single entry point that
 * detects deployment from the environment and creates the appropriate
 * remote transport. This is what DevModeContext calls during bootstrap.
 *
 * Contract:
 *   createTransportFromDeployment() → HttpTransport | null
 *
 * Key behaviors:
 *   - No config → default standalone → null transport
 *   - localStorage phpoc_deployment + phpoc_worker_url → HttpTransport
 *   - Bad URL (no protocol) → graceful fallback to null + console.warn
 *   - Each call creates a fresh transport instance
 *
 * Runs with: node test/transport_wiring_test.mjs
 */

import { createTransportFromDeployment } from '../src/sync/plugin_factory.js';
import { HttpTransport } from '../src/sync/transport.js';
import { TestHelpers } from './test_helpers.mjs';

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

/** Mock localStorage with getItem/setItem/removeItem API. */
function mockLocalStorage(initial = {}) {
  const store = { ...initial };
  global.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  return store;
}

function clearLocalStorage() {
  delete global.localStorage;
}

/** Capture console.warn calls during a function. */
function captureWarn(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warns;
}

// ── Sanitize: clear any existing localStorage ──
clearLocalStorage();

// ══════════════════════════════════════════════════════════════════════
// 1. Default standalone — no config
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Default Standalone ═══`);

{
  const transport = createTransportFromDeployment();
  t.assertEq(transport, null, 'no config → null transport (standalone default)');
}

// ══════════════════════════════════════════════════════════════════════
// 2. SaaS with valid config → HttpTransport
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ SaaS via localStorage ═══`);

mockLocalStorage({
  phpoc_deployment: 'saas',
  phpoc_worker_url: 'https://my-worker.workers.dev',
  phpoc_api_key: 'sk-test',
});

{
  const transport = createTransportFromDeployment();
  t.assert(transport instanceof HttpTransport, 'saas + valid URL → HttpTransport');
  t.assertEq(transport.baseUrl, 'https://my-worker.workers.dev', 'baseUrl from localStorage');
  t.assertEq(transport.apiKey, 'sk-test', 'apiKey from localStorage');
}

clearLocalStorage();

// ══════════════════════════════════════════════════════════════════════
// 3. SaaS auto-detected from worker URL (no explicit deployment key)
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ SaaS Auto-Detect ═══`);

mockLocalStorage({
  phpoc_worker_url: 'https://auto-detect.workers.dev',
  phpoc_api_key: 'auto-key',
});

{
  // No phpoc_deployment set → detectDeployment auto-detects from worker URL
  const transport = createTransportFromDeployment();
  t.assert(transport instanceof HttpTransport, 'auto-detect saas → HttpTransport');
  t.assertEq(transport.baseUrl, 'https://auto-detect.workers.dev', 'auto-detected baseUrl');
  t.assertEq(transport.apiKey, 'auto-key', 'auto-detected apiKey');
}

clearLocalStorage();

// ══════════════════════════════════════════════════════════════════════
// 4. LAN deployment with valid config
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ LAN via localStorage ═══`);

mockLocalStorage({
  phpoc_deployment: 'lan',
  phpoc_worker_url: 'http://192.168.1.100:8099',
});

{
  const transport = createTransportFromDeployment();
  t.assert(transport instanceof HttpTransport, 'lan + valid URL → HttpTransport');
  t.assertEq(transport.baseUrl, 'http://192.168.1.100:8099', 'LAN baseUrl');
  t.assertEq(transport.apiKey, null, 'LAN no apiKey');
}

clearLocalStorage();

// ══════════════════════════════════════════════════════════════════════
// 5. SaaS with bad URL → graceful fallback (no throw, console.warn)
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Bad URL Fallback ═══`);

{
  // Bad URL: missing protocol — HttpTransport constructor throws
  const warns = captureWarn(() => {
    mockLocalStorage({
      phpoc_deployment: 'saas',
      phpoc_worker_url: 'my-worker.workers.dev',  // no protocol
      phpoc_api_key: 'key',
    });

    const transport = createTransportFromDeployment();
    t.assertEq(transport, null, 'bad URL → null transport (graceful fallback)');

    clearLocalStorage();
  });

  t.assert(warns.length > 0, 'console.warn was called');
  t.assert(
    warns[0].includes('Falling back to local-only'),
    `warn message mentions fallback. Got: "${warns[0]}"`
  );
}

// ══════════════════════════════════════════════════════════════════════
// 6. SaaS with empty URL → null (no throw)
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Empty URL ═══`);

mockLocalStorage({
  phpoc_deployment: 'saas',
  phpoc_worker_url: '',
});

{
  const transport = createTransportFromDeployment();
  t.assertEq(transport, null, 'saas + empty URL → null (no transport)');
}

clearLocalStorage();

// ══════════════════════════════════════════════════════════════════════
// 7. SaaS without URL → null (no throw)
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Missing URL ═══`);

mockLocalStorage({
  phpoc_deployment: 'saas',
});

{
  const transport = createTransportFromDeployment();
  t.assertEq(transport, null, 'saas without URL → null');
}

clearLocalStorage();

// ══════════════════════════════════════════════════════════════════════
// 8. Instance isolation — each call creates fresh transport
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Instance Isolation ═══`);

mockLocalStorage({
  phpoc_deployment: 'saas',
  phpoc_worker_url: 'https://isolated.workers.dev',
  phpoc_api_key: 'isolated-key',
});

{
  const t1 = createTransportFromDeployment();
  const t2 = createTransportFromDeployment();
  t.assert(t1 !== t2, 'two calls → different HttpTransport instances');
  t.assertEq(t1.baseUrl, 'https://isolated.workers.dev', 't1 baseUrl');
  t.assertEq(t2.baseUrl, 'https://isolated.workers.dev', 't2 baseUrl');
}

clearLocalStorage();

// ══════════════════════════════════════════════════════════════════════
// 9. Clean environment — restore
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Environment Restoration ═══`);

{
  // After all localStorage tests, the environment should be clean
  const transport = createTransportFromDeployment();
  t.assertEq(transport, null, 'clean env → null (standalone default)');
}

// ══════════════════════════════════════════════════════════════════════
// Results
// ══════════════════════════════════════════════════════════════════════

console.log(`\n── Results ────────────────────────────────`);
console.log(`  ${t.passed} passed, ${t.failed} failed`);
if (t.failed > 0) process.exit(1);
