/**
 * remote_transport_test.mjs — Remote transport factory tests.
 *
 * Tests createRemoteTransport() — the function that constructs the
 * swappable remote transport (HttpTransport or null) based on deployment
 * config. Does NOT create storage backends — that's a separate concern.
 *
 * TDD RED phase: createRemoteTransport does not exist yet. These tests
 * should fail until the implementation is added.
 *
 * Contract:
 *   createRemoteTransport(config) → HttpTransport | null
 *
 *   Deployment    | Transport
 *   --------------|----------
 *   standalone    | null
 *   mock          | null
 *   memory        | null
 *   saas + url    | HttpTransport(baseUrl, apiKey)
 *   saas - url    | null (fallback, no remote)
 *   lan  + url    | HttpTransport(baseUrl, null)
 *   lan  - url    | null (fallback, no remote)
 *
 * Runs with: node test/remote_transport_test.mjs
 */

import { createRemoteTransport } from '../src/sync/plugin_factory.js';
import { HttpTransport } from '../src/sync/transport.js';
import { TestHelpers } from './test_helpers.mjs';

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// 1. Standalone → null
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Standalone Deployment ═══`);

{
  const transport = createRemoteTransport({ deployment: 'standalone' });
  t.assertEq(transport, null, 'standalone → null transport');
}

{
  const transport = createRemoteTransport({
    deployment: 'standalone',
    baseUrl: 'https://example.com',
    apiKey: 'key',
  });
  t.assertEq(transport, null, 'standalone ignores baseUrl/apiKey → null');
}

// ══════════════════════════════════════════════════════════════════════
// 2. Mock / Memory → null
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Mock / Memory Deployments ═══`);

{
  const transport = createRemoteTransport({ deployment: 'mock' });
  t.assertEq(transport, null, 'mock → null transport');
}

{
  const transport = createRemoteTransport({ deployment: 'memory' });
  t.assertEq(transport, null, 'memory → null transport');
}

{
  const transport = createRemoteTransport({
    deployment: 'mock',
    baseUrl: 'https://example.com',
  });
  t.assertEq(transport, null, 'mock ignores baseUrl → null');
}

// ══════════════════════════════════════════════════════════════════════
// 3. SaaS with baseUrl → HttpTransport
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ SaaS Deployment (with baseUrl) ═══`);

{
  const transport = createRemoteTransport({
    deployment: 'saas',
    config: {
      baseUrl: 'https://my-worker.workers.dev',
      apiKey: 'sk-test-key',
    },
  });
  t.assert(transport instanceof HttpTransport, 'saas + baseUrl → HttpTransport');
  t.assertEq(transport.baseUrl, 'https://my-worker.workers.dev', 'baseUrl passed through');
  t.assertEq(transport.apiKey, 'sk-test-key', 'apiKey passed through');
  t.assertEq(transport.isHttp, true, 'isHttp is true');
}

{
  // SaaS with baseUrl but no apiKey
  const transport = createRemoteTransport({
    deployment: 'saas',
    config: {
      baseUrl: 'https://worker.example.org',
    },
  });
  t.assert(transport instanceof HttpTransport, 'saas + baseUrl (no apiKey) → HttpTransport');
  t.assertEq(transport.baseUrl, 'https://worker.example.org', 'baseUrl set');
  t.assertEq(transport.apiKey, null, 'apiKey defaults to null');
}

{
  // SaaS with trailing slash in baseUrl — HttpTransport normalizes
  const transport = createRemoteTransport({
    deployment: 'saas',
    config: {
      baseUrl: 'https://worker.example.org/v1/',
      apiKey: 'k',
    },
  });
  t.assert(transport instanceof HttpTransport, 'saas trailing slash → HttpTransport');
  t.assertEq(transport.baseUrl, 'https://worker.example.org/v1', 'trailing slash stripped');
}

// ══════════════════════════════════════════════════════════════════════
// 4. SaaS without baseUrl → null (fallback)
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ SaaS Deployment (without baseUrl) ═══`);

{
  const transport = createRemoteTransport({ deployment: 'saas' });
  t.assertEq(transport, null, 'saas without baseUrl → null');
}

{
  const transport = createRemoteTransport({
    deployment: 'saas',
    config: {},
  });
  t.assertEq(transport, null, 'saas with empty config → null');
}

{
  const transport = createRemoteTransport({
    deployment: 'saas',
    config: { baseUrl: '' },
  });
  t.assertEq(transport, null, 'saas with empty baseUrl → null');
}

{
  const transport = createRemoteTransport({
    deployment: 'saas',
    config: { apiKey: 'key' },  // apiKey but no baseUrl
  });
  t.assertEq(transport, null, 'saas with apiKey but no baseUrl → null');
}

// ══════════════════════════════════════════════════════════════════════
// 5. LAN with baseUrl → HttpTransport
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ LAN Deployment ═══`);

{
  const transport = createRemoteTransport({
    deployment: 'lan',
    config: { baseUrl: 'http://192.168.1.100:8099' },
  });
  t.assert(transport instanceof HttpTransport, 'lan + baseUrl → HttpTransport');
  t.assertEq(transport.baseUrl, 'http://192.168.1.100:8099', 'LAN baseUrl set');
  t.assertEq(transport.apiKey, null, 'LAN has no apiKey');
}

{
  // LAN with apiKey (some bridges might use tokens)
  const transport = createRemoteTransport({
    deployment: 'lan',
    config: {
      baseUrl: 'http://bridge.local:8080',
      apiKey: 'bridge-token',
    },
  });
  t.assert(transport instanceof HttpTransport, 'lan + baseUrl + apiKey → HttpTransport');
  t.assertEq(transport.apiKey, 'bridge-token', 'apiKey passed for LAN bridge');
}

{
  // LAN without baseUrl
  const transport = createRemoteTransport({ deployment: 'lan' });
  t.assertEq(transport, null, 'lan without baseUrl → null');
}

// ══════════════════════════════════════════════════════════════════════
// 6. Invalid / unknown deployment → null
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Invalid Deployments ═══`);

{
  const transport = createRemoteTransport({ deployment: 'bogus' });
  t.assertEq(transport, null, 'invalid deployment → null');
}

{
  const transport = createRemoteTransport({ deployment: 'bogus', config: { baseUrl: 'https://x.com' } });
  t.assertEq(transport, null, 'invalid deployment ignores config → null');
}

{
  const transport = createRemoteTransport({});
  t.assertEq(transport, null, 'no deployment specified → null');
}

{
  const transport = createRemoteTransport({ deployment: null });
  t.assertEq(transport, null, 'null deployment → null');
}

// ══════════════════════════════════════════════════════════════════════
// 7. HttpTransport constructor validation (bubbles from transport.js)
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ HttpTransport Validation ═══`);

{
  // Invalid baseUrl (no protocol) — HttpTransport throws
  let threw = false;
  try {
    createRemoteTransport({
      deployment: 'saas',
      config: { baseUrl: 'my-worker.workers.dev' },
    });
  } catch (err) {
    threw = true;
    t.assert(
      err.message.includes('http://') || err.message.includes('https://'),
      'throws on missing protocol'
    );
  }
  t.assert(threw, 'invalid baseUrl throws');
}

{
  // Empty baseUrl with lan — returns null, doesn't throw
  const transport = createRemoteTransport({
    deployment: 'lan',
    config: { baseUrl: '' },
  });
  t.assertEq(transport, null, 'lan + empty baseUrl → null (no throw)');
}

// ══════════════════════════════════════════════════════════════════════
// 8. Transport isolation — each call creates a fresh instance
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Instance Isolation ═══`);

{
  const t1 = createRemoteTransport({
    deployment: 'saas',
    config: { baseUrl: 'https://worker-a.dev', apiKey: 'key-a' },
  });
  const t2 = createRemoteTransport({
    deployment: 'saas',
    config: { baseUrl: 'https://worker-b.dev', apiKey: 'key-b' },
  });
  t.assert(t1 !== t2, 'two calls → different HttpTransport instances');
  t.assertEq(t1.baseUrl, 'https://worker-a.dev', 't1 baseUrl independent');
  t.assertEq(t2.baseUrl, 'https://worker-b.dev', 't2 baseUrl independent');
  t.assertEq(t1.apiKey, 'key-a', 't1 apiKey independent');
  t.assertEq(t2.apiKey, 'key-b', 't2 apiKey independent');
}

// ══════════════════════════════════════════════════════════════════════
// 9. ETag cache starts empty
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ Fresh Transport State ═══`);

{
  const transport = createRemoteTransport({
    deployment: 'saas',
    config: { baseUrl: 'https://worker.example.com', apiKey: 'k' },
  });
  t.assert(transport instanceof HttpTransport, 'fresh transport created');
  t.assertEq(transport._etagCache.size, 0, 'ETag cache starts empty');
}

{
  // Null transport — no _etagCache property
  const transport = createRemoteTransport({ deployment: 'standalone' });
  t.assertEq(transport, null, 'null transport returned');
}

// ══════════════════════════════════════════════════════════════════════
// Results
// ══════════════════════════════════════════════════════════════════════

console.log(`\n── Results ────────────────────────────────`);
console.log(`  ${t.passed} passed, ${t.failed} failed`);
if (t.failed > 0) process.exit(1);
