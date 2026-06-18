/**
 * remote_config_test.mjs — Config detection + persistence tests.
 *
 * Tests the configuration layer that drives deployment selection:
 *   1. localStorage persistence (deployment, baseUrl, apiKey)
 *   2. URL parameter detection
 *   3. Auto-detection (worker URL → saas)
 *   4. Fallback to standalone on invalid/missing config
 *
 * Runs with: node test/remote_config_test.mjs
 */

import { detectDeployment } from '../src/sync/plugin_factory.js';
import { TestHelpers } from './test_helpers.mjs';

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

// Mock localStorage
function mockLocalStorage(initial = {}) {
  const store = { ...initial };
  global.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
  return store;
}

// Mock window.location.search for URL params
function mockUrlParams(params = '') {
  global.window = {
    ...global.window,
    location: {
      ...global.window?.location,
      search: params,
    },
  };
}

// Clean up mocks
function resetGlobals() {
  delete global.localStorage;
  delete global.window;
}

// ══════════════════════════════════════════════════════════════════════
// 1. Default behavior — no config at all
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Config Defaults ═══`);

{
  resetGlobals();
  mockLocalStorage();
  mockUrlParams();

  const { deployment, config } = detectDeployment();
  t.assertEq(deployment, 'standalone', 'defaults to standalone');
  t.assert(typeof config === 'object', 'config is an object');
  t.assertEq(Object.keys(config).length, 0, 'config is empty by default');
}

// ══════════════════════════════════════════════════════════════════════
// 2. localStorage — phpoc_deployment key
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ localStorage phpoc_deployment ═══`);

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: 'saas' });
  mockUrlParams();

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'saas', 'reads phpoc_deployment from localStorage');
}

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: 'lan' });
  mockUrlParams();

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'lan', 'reads "lan" from localStorage');
}

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: 'mock' });
  mockUrlParams();

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'mock', 'reads "mock" from localStorage');
}

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: 'memory' });
  mockUrlParams();

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'memory', 'reads "memory" from localStorage');
}

// ══════════════════════════════════════════════════════════════════════
// 3. URL params take priority over localStorage
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ URL Parameter Priority ═══`);

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: 'mock' });
  mockUrlParams('?deployment=saas');

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'saas', 'URL param overrides localStorage');
}

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: 'saas' });
  mockUrlParams('?deployment=standalone');

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'standalone', 'URL param can force standalone');
}

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: 'saas' });
  mockUrlParams('?deployment=lan');

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'lan', 'URL param "lan" overrides localStorage');
}

// ══════════════════════════════════════════════════════════════════════
// 4. Auto-detection — worker URL → saas
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Auto-Detect SaaS from Worker URL ═══`);

{
  resetGlobals();
  mockLocalStorage({ phpoc_worker_url: 'https://my-worker.workers.dev' });
  mockUrlParams();

  const { deployment, config } = detectDeployment();
  t.assertEq(deployment, 'saas', 'worker URL auto-detects saas');
  t.assertEq(config.baseUrl, 'https://my-worker.workers.dev', 'config carries baseUrl');
}

{
  resetGlobals();
  mockLocalStorage({
    phpoc_worker_url: 'https://api.example.com',
    phpoc_api_key: 'sk-abc123',
  });
  mockUrlParams();

  const { deployment, config } = detectDeployment();
  t.assertEq(deployment, 'saas', 'worker URL + API key → saas');
  t.assertEq(config.baseUrl, 'https://api.example.com', 'config.baseUrl from localStorage');
  t.assertEq(config.apiKey, 'sk-abc123', 'config.apiKey from localStorage');
}

{
  resetGlobals();
  // Worker URL without explicit apiKey
  mockLocalStorage({ phpoc_worker_url: 'https://worker.example.org' });
  mockUrlParams();

  const { deployment, config } = detectDeployment();
  t.assertEq(deployment, 'saas', 'worker URL alone → saas');
  t.assertEq(config.baseUrl, 'https://worker.example.org', 'baseUrl present');
  t.assertEq(config.apiKey, '', 'apiKey empty string when not set');
}

// ══════════════════════════════════════════════════════════════════════
// 5. Invalid deployment falls back to standalone
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Invalid Deployment Fallback ═══`);

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: 'garbage' });
  mockUrlParams();

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'standalone', 'invalid deployment → standalone');
}

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: '' });
  mockUrlParams();

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'standalone', 'empty deployment → standalone');
}

{
  resetGlobals();
  mockLocalStorage({ phpoc_deployment: 'SaaS' });  // case-sensitive
  mockUrlParams();

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'standalone', 'case-sensitive SaaS → standalone');
}

{
  resetGlobals();
  mockUrlParams('?deployment=bogus');

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'standalone', 'invalid URL param → standalone');
}

// ══════════════════════════════════════════════════════════════════════
// 6. Updating localStorage and re-detecting
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Config Mutation Detection ═══`);

{
  resetGlobals();
  const store = mockLocalStorage();
  mockUrlParams();

  // Start standalone
  let result = detectDeployment();
  t.assertEq(result.deployment, 'standalone', 'initial → standalone');

  // User configures worker URL (auto-detect path)
  store.phpoc_worker_url = 'https://new-worker.dev';
  store.phpoc_api_key = 'key-456';

  result = detectDeployment();
  t.assertEq(result.deployment, 'saas', 're-detect auto-detects saas from worker URL');
  t.assertEq(result.config.baseUrl, 'https://new-worker.dev', 'baseUrl from auto-detect');
  t.assertEq(result.config.apiKey, 'key-456', 'apiKey from auto-detect');
}

{
  resetGlobals();
  const store = mockLocalStorage({
    phpoc_worker_url: 'https://old.example.com',
  });
  mockUrlParams();

  // Auto-detected as saas with config
  let result = detectDeployment();
  t.assertEq(result.deployment, 'saas', 'auto-detected as saas');
  t.assertEq(result.config.baseUrl, 'https://old.example.com', 'baseUrl in auto-detect config');

  // User explicitly switches to standalone via deployment key
  store.phpoc_deployment = 'standalone';

  result = detectDeployment();
  t.assertEq(result.deployment, 'standalone', 'explicit deployment overrides auto-detect');
}

{
  resetGlobals();
  const store = mockLocalStorage({
    phpoc_deployment: 'saas',
    phpoc_worker_url: 'https://override.example.com',
  });
  mockUrlParams();

  // Explicit deployment takes priority over auto-detect
  let result = detectDeployment();
  t.assertEq(result.deployment, 'saas', 'explicit deployment key takes priority');
  // When deployment is explicitly set, config is empty — baseUrl/apiKey are
  // read separately by the transport factory from localStorage
  t.assertEq(Object.keys(result.config).length, 0, 'explicit deployment → empty config');
}

// ══════════════════════════════════════════════════════════════════════
// 7. URL param auto-detection takes priority over worker URL inference
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ URL Param vs Worker URL Inference ═══`);

{
  resetGlobals();
  mockLocalStorage({ phpoc_worker_url: 'https://worker.example.com' });
  mockUrlParams('?deployment=standalone');

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'standalone',
    'URL param "standalone" overrides worker URL auto-detect');
}

{
  resetGlobals();
  mockLocalStorage({ phpoc_worker_url: 'https://worker.example.com' });
  mockUrlParams('?deployment=lan');

  const { deployment } = detectDeployment();
  t.assertEq(deployment, 'lan',
    'URL param "lan" overrides worker URL auto-detect');
}

// ══════════════════════════════════════════════════════════════════════
// 8. No globals — server-side / test environment
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ No-Globals Environment ═══`);

{
  resetGlobals();
  // No window, no localStorage

  const { deployment, config } = detectDeployment();
  t.assertEq(deployment, 'standalone', 'no globals → standalone');
  t.assert(typeof config === 'object', 'config object returned');
}

// ══════════════════════════════════════════════════════════════════════
// Results
// ══════════════════════════════════════════════════════════════════════

console.log(`\n── Results ────────────────────────────────`);
console.log(`  ${t.passed} passed, ${t.failed} failed`);
if (t.failed > 0) process.exit(1);
