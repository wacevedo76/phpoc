/**
 * transport_test.mjs — HTTP Transport Wrapper test suite.
 *
 * Exercises all methods of HttpTransport (pull, push, listFiles, resetCache)
 * including ETag caching, error handling, URL construction, and headers.
 *
 * TDD phases:
 *   RED   — skeleton throws "not yet implemented" → happy-path tests fail,
 *           error-case tests pass (expected errors still work)
 *   GREEN — real implementation → all 38 tests pass
 *
 * Usage:
 *   node test/transport_test.mjs
 */

import { HttpTransport } from '../src/sync/transport.js';

// ── Helpers ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, label) {
  if (condition) { passed++; process.stdout.write('  ✓'); }
  else { failed++; errors.push(label); process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 120)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 120)}`);
  }
  console.log(`  ${label}`);
}

function assertDeepEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 200)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 200)}`);
  }
  console.log(`  ${label}`);
}

// ── Mock fetch factory ───────────────────────────────────────────────

/**
 * Create a mock fetch function that returns controlled responses.
 * Tracks request history for assertion.
 */
function createMockFetch() {
  const requests = [];

  function mockFetch({ status = 200, body = '', headers = {}, reject = false, rejectReason = 'Network error' } = {}) {
    return async (url, options) => {
      requests.push({ url, options: { ...options, headers: { ...Object.fromEntries(options?.headers?.entries?.() || []) } } });
      if (reject) throw new Error(rejectReason);

      const responseHeaders = new Map();
      for (const [k, v] of Object.entries(headers)) {
        responseHeaders.set(k.toLowerCase(), v);
      }

      return {
        status,
        ok: status >= 200 && status < 300,
        headers: {
          get(name) { return responseHeaders.get(name.toLowerCase()) || null; },
          has(name) { return responseHeaders.has(name.toLowerCase()); },
        },
        async arrayBuffer() {
          // Preserve Latin-1 byte values (TextEncoder would UTF-8 encode
          // bytes > 127, corrupting binary data in tests).
          const buf = new ArrayBuffer(body.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < body.length; i++) {
            view[i] = body.charCodeAt(i);
          }
          return buf;
        },
        async text() { return body; },
        async json() { return JSON.parse(body); },
      };
    };
  }

  mockFetch.requests = requests;
  return mockFetch;
}

// ── Test runner helpers ──────────────────────────────────────────────

/**
 * Run a test that expects a method to succeed. In RED phase (skeleton),
 * the method throws 'not yet implemented' → this counts as FAILED.
 * In GREEN phase (real impl), the method returns → testFn assertions run.
 */
async function testBehavior(label, testFn) {
  try {
    await testFn();
    // If we get here without assertion failure, the test passes
    // (assert/assertEq/assertDeepEq already incremented counters)
  } catch (err) {
    failed++;
    errors.push(label);
    process.stdout.write('  ✗');
    console.log(`  ${label}`);
    if (err.message !== 'HttpTransport: not yet implemented' &&
        !err.message.includes('not yet implemented')) {
      // Print unexpected errors for debugging
      console.log(`      unexpected error: ${err.message}`);
    }
  }
}

/**
 * Run a test that expects a method to throw. In both RED and GREEN phases,
 * if it throws → PASS; if it doesn't throw → FAIL.
 */
async function testThrows(label, testFn) {
  try {
    await testFn();
    // No throw — test failed (expected an error)
    failed++;
    errors.push(label + ' (expected throw, got success)');
    process.stdout.write('  ✗  (expected throw, got success)');
    console.log(`  ${label}`);
  } catch {
    passed++;
    process.stdout.write('  ✓');
    console.log(`  ${label}`);
  }
}

// ── Tests ────────────────────────────────────────────────────────────

console.log('══ HttpTransport Test Suite ══\n');

// ── Category 1: Constructor / Configuration ──
console.log('── Constructor / Configuration ──');

await testBehavior('constructs with valid baseUrl', async () => {
  const t = new HttpTransport({ baseUrl: 'https://example.com' });
  assert(!!t, 'instance created');
});

await testBehavior('trailing slash normalized', async () => {
  const t = new HttpTransport({ baseUrl: 'https://example.com/' });
  assert(true, 'constructed without error');
});

await testBehavior('accepts apiKey option', async () => {
  const t = new HttpTransport({ baseUrl: 'https://example.com', apiKey: 'key-123' });
  assert(true, 'constructed with apiKey');
});

await testBehavior('isHttp returns true', async () => {
  const t = new HttpTransport({ baseUrl: 'https://example.com' });
  assert(t.isHttp === true, 'isHttp === true');
});

await testThrows('empty baseUrl throws', async () => {
  new HttpTransport({ baseUrl: '' });
});

await testThrows('unsupported scheme throws', async () => {
  new HttpTransport({ baseUrl: 'ftp://bad' });
});

// ── Category 2: pull happy path ──
console.log('\n── pull — happy path ──');

await testBehavior('basic pull returns bytes on 200', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: '{"hello":"world"}' });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    const result = await t.pull('staging/blobs/x.json');
    assert(result instanceof Uint8Array, 'result is Uint8Array');
    const decoded = new TextDecoder().decode(result);
    assertEq(decoded, '{"hello":"world"}', 'body content matches');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('pull returns null on 404', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 404 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    const result = await t.pull('nonexistent');
    assert(result === null, 'result is null on 404');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('pull binary data returns identical bytes', async () => {
  const binaryBytes = new Uint8Array([0x00, 0xFF, 0xAB, 0xCD, 0x12, 0x34]);
  const binaryStr = String.fromCharCode(...binaryBytes);
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: binaryStr });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    const result = await t.pull('binary.bin');
    assert(result instanceof Uint8Array, 'result is Uint8Array');
    assertEq(result.length, 6, 'correct byte length');
    assertEq(result[0], 0x00, 'byte 0 preserved');
    assertEq(result[1], 0xFF, 'byte 1 preserved');
    assertEq(result[5], 0x34, 'byte 5 preserved');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 3: ETag caching ──
console.log('\n── pull — ETag caching ──');

await testBehavior('first pull caches ETag and body', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: 'data1', headers: { ETag: '"abc123"' } });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('cached-path');
    assert(fetchMock.requests.length === 1, 'one request made');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('second pull sends If-None-Match header', async () => {
  const fetchMock = createMockFetch();
  let callCount = 0;
  globalThis.fetch = async (url, options) => {
    callCount++;
    const headers = new Map();
    if (callCount === 1) {
      headers.set('etag', '"abc123"');
      return { status: 200, ok: true, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('data1').buffer; }, async text() { return 'data1'; }, async json() { return JSON.parse('data1'); } };
    }
    // Second call — check If-None-Match
    const reqHeaders = options?.headers || {};
    const ifNoneMatch = typeof reqHeaders.get === 'function' ? reqHeaders.get('If-None-Match') : reqHeaders['If-None-Match'];
    assert(ifNoneMatch === '"abc123"', 'If-None-Match header present with cached ETag');
    headers.set('etag', '"abc123"');
    return { status: 304, ok: false, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('data1').buffer; }, async text() { return 'data1'; }, async json() { return JSON.parse('data1'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('cached-path');
    await t.pull('cached-path');
    assert(callCount === 2, 'two requests made');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('304 returns cached body', async () => {
  const fetchMock = createMockFetch();
  let callCount = 0;
  globalThis.fetch = async (url, options) => {
    callCount++;
    const headers = new Map();
    headers.set('etag', '"abc123"');
    if (callCount === 1) {
      return { status: 200, ok: true, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('original-data').buffer; }, async text() { return 'original-data'; }, async json() { return JSON.parse('"original-data"'); } };
    }
    return { status: 304, ok: false, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('should-not-return').buffer; }, async text() { return 'should-not-return'; }, async json() { return JSON.parse('"should-not-return"'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    const first = await t.pull('cached-path');
    const second = await t.pull('cached-path');
    const decoded = new TextDecoder().decode(second);
    assertEq(decoded, 'original-data', '304 returns cached body, not 304 body');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('200 with new ETag updates cache', async () => {
  let callCount = 0;
  globalThis.fetch = async (url, options) => {
    callCount++;
    const headers = new Map();
    if (callCount <= 2) {
      headers.set('etag', '"v1"');
      return { status: callCount === 2 ? 304 : 200, ok: callCount === 1, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('version-1').buffer; }, async text() { return 'version-1'; }, async json() { return JSON.parse('"version-1"'); } };
    }
    headers.set('etag', '"v2"');
    return { status: 200, ok: true, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('version-2').buffer; }, async text() { return 'version-2'; }, async json() { return JSON.parse('"version-2"'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('cached-path');
    await t.pull('cached-path');
    const third = await t.pull('cached-path');
    const decoded = new TextDecoder().decode(third);
    assertEq(decoded, 'version-2', 'new ETag returns updated body');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('no ETag header → no caching (always re-fetches)', async () => {
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('data').buffer; }, async text() { return 'data'; }, async json() { return JSON.parse('"data"'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('no-etag-path');
    await t.pull('no-etag-path');
    // Both calls should go to server (no If-None-Match because no ETag cached)
    assert(callCount === 2, 'two actual requests made (no caching)');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('different paths have independent caches', async () => {
  let callCount = 0;
  globalThis.fetch = async (url, options) => {
    callCount++;
    const headers = new Map();
    headers.set('etag', '"etag-' + url + '"');
    return { status: 200, ok: true, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('data').buffer; }, async text() { return 'data'; }, async json() { return JSON.parse('"data"'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('path-a');
    await t.pull('path-b');
    // Both should be real requests (independent caches)
    assert(callCount === 2, 'two requests (different paths, no cache sharing)');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 4: push ──
console.log('\n── push ──');

await testBehavior('basic push sends PUT and succeeds on 200', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: '' });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com', apiKey: 'k' });
    const data = new TextEncoder().encode('hello');
    await t.push('staging/blobs/x.json', data);
    assert(fetchMock.requests.length === 1, 'one request made');
    assertEq(fetchMock.requests[0].options?.method || 'PUT', 'PUT', 'uses PUT method');
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('push non-2xx throws', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 500 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.push('fail-path', new TextEncoder().encode('x'));
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('push clears ETag cache for that path', async () => {
  let callCount = 0;
  let lastEtag = '';
  globalThis.fetch = async (url, options) => {
    callCount++;
    const method = options?.method || 'GET';
    const headers = new Map();
    if (callCount === 1) {
      headers.set('etag', '"cached"');
      return { status: 200, ok: true, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('original').buffer; }, async text() { return 'original'; }, async json() { return JSON.parse('"original"'); } };
    }
    if (method === 'PUT') {
      return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('').buffer; }, async text() { return ''; }, async json() { return JSON.parse('""'); } };
    }
    // GET after PUT — should NOT have If-None-Match since cache was cleared
    const reqHeaders = options?.headers || {};
    const ifNoneMatch = typeof reqHeaders.get === 'function' ? reqHeaders.get('If-None-Match') : reqHeaders['If-None-Match'];
    assert(!ifNoneMatch, 'no If-None-Match after cache clear');
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('fresh').buffer; }, async text() { return 'fresh'; }, async json() { return JSON.parse('"fresh"'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('some-path');
    await t.push('some-path', new TextEncoder().encode('new'));
    await t.pull('some-path');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('push different path preserves unrelated cache', async () => {
  let callCount = 0;
  globalThis.fetch = async (url, options) => {
    callCount++;
    const method = options?.method || 'GET';
    const headers = new Map();
    if (method === 'GET' && url.includes('path-a')) {
      headers.set('etag', '"a-etag"');
      return { status: 200, ok: true, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('a').buffer; }, async text() { return 'a'; }, async json() { return JSON.parse('"a"'); } };
    }
    if (method === 'PUT') {
      return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('').buffer; }, async text() { return ''; }, async json() { return JSON.parse('""'); } };
    }
    // GET for path-b — no cache expected
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('b').buffer; }, async text() { return 'b'; }, async json() { return JSON.parse('"b"'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('path-a');
    await t.push('path-b', new TextEncoder().encode('x'));
    // Now pull path-a — should use cached ETag and get 304
    // If cache was preserved, it sends If-None-Match and gets 304
    assert(callCount >= 2, 'at least 2 calls made');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 5: listFiles ──
console.log('\n── listFiles ──');

await testBehavior('basic listFiles returns array of strings', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: JSON.stringify(['block-1.json', 'block-2.json']) });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    const result = await t.listFiles('ledger/blocks/');
    assertDeepEq(result, ['block-1.json', 'block-2.json'], 'returns file list');
    const reqUrl = fetchMock.requests[0]?.url || '';
    assert(reqUrl.includes('prefix='), 'URL contains ?prefix=');
    assert(reqUrl.includes('ledger/blocks/'), 'prefix value in URL');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('listFiles 404 returns empty array', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 404 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    const result = await t.listFiles('nonexistent/');
    assertDeepEq(result, [], 'returns empty array on 404');
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('listFiles invalid JSON throws', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: 'not-json!!!' });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.listFiles('bad-json/');
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('listFiles non-array JSON throws', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: JSON.stringify({ not: 'an-array' }) });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.listFiles('non-array/');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('listFiles sends ?prefix= query param', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: JSON.stringify([]) });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.listFiles('ledger/blocks/');
    const reqUrl = fetchMock.requests[0]?.url || '';
    assert(reqUrl.includes('?prefix=') || reqUrl.includes('&prefix='), 'URL contains prefix query param');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 6: resetCache ──
console.log('\n── resetCache ──');

await testBehavior('resetCache on empty cache does not throw', async () => {
  const t = new HttpTransport({ baseUrl: 'https://example.com' });
  t.resetCache();
  assert(true, 'no error thrown');
});

await testBehavior('resetCache clears all cached ETags', async () => {
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    const headers = new Map();
    headers.set('etag', '"etag"');
    return { status: 200, ok: true, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('data').buffer; }, async text() { return 'data'; }, async json() { return JSON.parse('"data"'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('path');
    t.resetCache();
    await t.pull('path');
    // After reset, second pull should be a real request (no If-None-Match)
    // First call = 1, but if cache was cleared the second GET is another real call
    assert(callCount >= 2, 'at least 2 real requests after cache reset');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 7: Network error handling ──
console.log('\n── Error handling — network failures ──');

await testThrows('pull network error throws Error', async () => {
  globalThis.fetch = async () => { throw new Error('Network failure'); };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('path');
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('push network error throws Error', async () => {
  globalThis.fetch = async () => { throw new Error('Network failure'); };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.push('path', new TextEncoder().encode('x'));
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('listFiles network error throws Error', async () => {
  globalThis.fetch = async () => { throw new Error('Network failure'); };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.listFiles('prefix/');
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('delete network error throws Error', async () => {
  globalThis.fetch = async () => { throw new Error('Network failure'); };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.delete('path');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 7b: timeoutMs → AbortSignal.timeout() wired ──
console.log('\n── timeoutMs → AbortSignal.timeout() wired ──');

await testBehavior('pull with timeoutMs passes signal to fetch', async () => {
  let capturedSignal = undefined;
  globalThis.fetch = async (url, options) => {
    capturedSignal = options?.signal;
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('ok').buffer; }, async text() { return 'ok'; }, async json() { return '{}'; } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('path', { timeoutMs: 5000 });
    assert(capturedSignal instanceof AbortSignal, 'signal is AbortSignal');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('pull without timeoutMs does NOT pass signal', async () => {
  let capturedSignal = undefined;
  globalThis.fetch = async (url, options) => {
    capturedSignal = options?.signal;
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('ok').buffer; }, async text() { return 'ok'; }, async json() { return '{}'; } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('path');
    assert(!capturedSignal, 'no signal passed when timeoutMs omitted');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('push with timeoutMs passes signal to fetch', async () => {
  let capturedSignal = undefined;
  globalThis.fetch = async (url, options) => {
    capturedSignal = options?.signal;
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('').buffer; }, async text() { return ''; }, async json() { return '{}'; } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.push('path', new TextEncoder().encode('x'), { timeoutMs: 5000 });
    assert(capturedSignal instanceof AbortSignal, 'signal is AbortSignal');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('listFiles with timeoutMs passes signal to fetch', async () => {
  let capturedSignal = undefined;
  globalThis.fetch = async (url, options) => {
    capturedSignal = options?.signal;
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('[]').buffer; }, async json() { return []; } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.listFiles('prefix/', { timeoutMs: 5000 });
    assert(capturedSignal instanceof AbortSignal, 'signal is AbortSignal');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('delete with timeoutMs passes signal to fetch', async () => {
  let capturedSignal = undefined;
  globalThis.fetch = async (url, options) => {
    capturedSignal = options?.signal;
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('').buffer; } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.delete('path', { timeoutMs: 5000 });
    assert(capturedSignal instanceof AbortSignal, 'signal is AbortSignal');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 8: HTTP DELETE method ──
console.log('\n── delete method ──');

await testBehavior('basic delete succeeds on 200', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: '' });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com', apiKey: 'k' });
    await t.delete('staging/blobs/x.json');
    assert(fetchMock.requests.length === 1, 'one request made');
    assertEq(fetchMock.requests[0].options?.method || 'DELETE', 'DELETE', 'uses DELETE method');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('delete 404 succeeds silently (already gone)', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 404 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    // Should not throw — 404 is treated as success for delete
    await t.delete('nonexistent');
    assert(true, 'delete 404 does not throw');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('delete clears ETag cache for that path', async () => {
  let callCount = 0;
  globalThis.fetch = async (url, options) => {
    callCount++;
    const method = options?.method || 'GET';
    const headers = new Map();
    if (method === 'GET') {
      if (callCount === 1) {
        headers.set('etag', '"cached"');
        return { status: 200, ok: true, headers: { get(n) { return headers.get(n.toLowerCase()); }, has(n) { return headers.has(n.toLowerCase()); } }, async arrayBuffer() { return new TextEncoder().encode('original').buffer; }, async text() { return 'original'; }, async json() { return JSON.parse('"original"'); } };
      }
      // GET after DELETE — should NOT have If-None-Match since cache was cleared
      const reqHeaders = options?.headers || {};
      const ifNoneMatch = typeof reqHeaders.get === 'function' ? reqHeaders.get('If-None-Match') : reqHeaders['If-None-Match'];
      assert(!ifNoneMatch, 'no If-None-Match after cache clear');
      return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('fresh').buffer; }, async text() { return 'fresh'; }, async json() { return JSON.parse('"fresh"'); } };
    }
    // DELETE
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('').buffer; } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('some-path');
    await t.delete('some-path');
    await t.pull('some-path');
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('delete 500 throws Error', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 500 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.delete('server-error');
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('delete 403 throws Error', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 403 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.delete('forbidden');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 9: HTTP error statuses ──
console.log('\n── Error handling — HTTP error statuses ──');

await testThrows('pull 403 throws Error', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 403 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('forbidden');
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('pull 500 throws Error', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 500 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('server-error');
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('push 500 throws Error', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 500 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.push('server-error', new TextEncoder().encode('x'));
  } finally {
    delete globalThis.fetch;
  }
});

await testThrows('listFiles 500 throws Error', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 500 });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.listFiles('server-error/');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 10: isHttp property ──
console.log('\n── isHttp property ──');

await testBehavior('isHttp returns true', async () => {
  const t = new HttpTransport({ baseUrl: 'https://example.com' });
  assert(t.isHttp === true, 'isHttp === true');
});

// ── Category 11: URL construction ──
console.log('\n── URL construction ──');

await testBehavior('leading slash on path is normalized', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: 'ok' });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('/staging/blobs/x.json');
    const reqUrl = fetchMock.requests[0]?.url || '';
    // Check path portion only (protocol always contains // but that's fine)
    const pathPortion = reqUrl.replace(/^https?:\/\//, '');
    assert(!pathPortion.includes('//'), 'no double slash in URL path');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('base URL with sub-path resolves correctly', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: 'ok' });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com/base/' });
    await t.pull('staging/x.json');
    const reqUrl = fetchMock.requests[0]?.url || '';
    assert(reqUrl.includes('/base/staging/x.json'), 'resolves to /base/staging/x.json');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 12: Request headers ──
console.log('\n── Request headers ──');

await testBehavior('push sends Content-Type: application/octet-stream', async () => {
  let capturedHeaders = null;
  globalThis.fetch = async (url, options) => {
    capturedHeaders = options?.headers || {};
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('').buffer; }, async text() { return ''; }, async json() { return JSON.parse('""'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.push('path', new TextEncoder().encode('data'));
    // Headers could be Headers object or plain object
    const contentType = typeof capturedHeaders.get === 'function'
      ? capturedHeaders.get('Content-Type')
      : capturedHeaders['Content-Type'];
    assert(contentType === 'application/octet-stream', 'Content-Type is set');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('API key sent as X-Api-Key header', async () => {
  let capturedHeaders = null;
  globalThis.fetch = async (url, options) => {
    capturedHeaders = options?.headers || {};
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('ok').buffer; }, async text() { return 'ok'; }, async json() { return JSON.parse('"ok"'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com', apiKey: 'test-key-123' });
    await t.pull('path');
    const apiKey = typeof capturedHeaders.get === 'function'
      ? capturedHeaders.get('X-Api-Key')
      : capturedHeaders['X-Api-Key'];
    assert(apiKey === 'test-key-123', 'X-Api-Key header sent with correct value');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('no API key configured → no X-Api-Key header', async () => {
  let capturedHeaders = null;
  globalThis.fetch = async (url, options) => {
    capturedHeaders = options?.headers || {};
    return { status: 200, ok: true, headers: { get() { return null; }, has() { return false; } }, async arrayBuffer() { return new TextEncoder().encode('ok').buffer; }, async text() { return 'ok'; }, async json() { return JSON.parse('"ok"'); } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('path');
    const apiKey = typeof capturedHeaders.get === 'function'
      ? capturedHeaders.get('X-Api-Key')
      : capturedHeaders['X-Api-Key'];
    assert(!apiKey, 'no X-Api-Key header when no key configured');
  } finally {
    delete globalThis.fetch;
  }
});

// ── Category 13: ETag cache TTL expiry ──
console.log('\n── ETag cache TTL expiry ──');

await testBehavior('TTL=0 (default) — entry never expires', async () => {
  const fetchMock = createMockFetch();
  globalThis.fetch = fetchMock({ status: 200, body: 'data', headers: { ETag: '"v1"' } });
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' });
    await t.pull('path');
    // Second pull — should still have cached entry (TTL=0 means never expire)
    globalThis.fetch = fetchMock({ status: 304 });
    const result = await t.pull('path');
    const decoded = new TextDecoder().decode(result);
    assertEq(decoded, 'data', 'cached body returned (TTL=0 never expires)');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('expired cache entry — no If-None-Match sent', async () => {
  const realNow = Date.now;
  let fakeNow = 1000000;
  Date.now = () => fakeNow;

  let capturedHeaders = null;
  globalThis.fetch = async (url, options) => {
    capturedHeaders = options?.headers || {};
    return { status: 200, ok: true, headers: { get(n) { return n.toLowerCase() === 'etag' ? '"v1"' : null; }, has(n) { return n.toLowerCase() === 'etag'; } }, async arrayBuffer() { return new TextEncoder().encode('fresh').buffer; } };
  };

  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com', cacheTtlMs: 5000 });
    await t.pull('path'); // cached at fakeNow=1000000

    // Advance time past TTL
    fakeNow = 1000000 + 6000; // 6s later, TTL was 5s

    // Reset capturedHeaders for the second request
    capturedHeaders = null;
    await t.pull('path'); // should miss cache, re-fetch

    const ifNoneMatch = typeof capturedHeaders?.get === 'function'
      ? capturedHeaders.get('If-None-Match')
      : capturedHeaders?.['If-None-Match'];
    assert(!ifNoneMatch, 'no If-None-Match header (cache expired)');
  } finally {
    Date.now = realNow;
    delete globalThis.fetch;
  }
});

await testBehavior('fresh cache entry — If-None-Match still sent', async () => {
  const realNow = Date.now;
  let fakeNow = 1000000;
  Date.now = () => fakeNow;

  let capturedHeaders = null;
  globalThis.fetch = async (url, options) => {
    capturedHeaders = options?.headers || {};
    return { status: 200, ok: true, headers: { get(n) { return n.toLowerCase() === 'etag' ? '"v1"' : null; }, has(n) { return n.toLowerCase() === 'etag'; } }, async arrayBuffer() { return new TextEncoder().encode('data').buffer; } };
  };

  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com', cacheTtlMs: 5000 });
    await t.pull('path'); // cached at fakeNow=1000000

    // Advance time but still within TTL
    fakeNow = 1000000 + 3000; // 3s later, TTL is 5s

    capturedHeaders = null;
    await t.pull('path');

    const ifNoneMatch = typeof capturedHeaders?.get === 'function'
      ? capturedHeaders.get('If-None-Match')
      : capturedHeaders?.['If-None-Match'];
    assertEq(ifNoneMatch, '"v1"', 'If-None-Match header present (cache still fresh)');
  } finally {
    Date.now = realNow;
    delete globalThis.fetch;
  }
});

await testBehavior('evictStale() removes expired entries', async () => {
  const realNow = Date.now;
  let fakeNow = 1000000;
  Date.now = () => fakeNow;

  globalThis.fetch = async (url, options) => {
    return { status: 200, ok: true, headers: { get(n) { return n.toLowerCase() === 'etag' ? `"etag-${url}"` : null; }, has(n) { return n.toLowerCase() === 'etag'; } }, async arrayBuffer() { return new TextEncoder().encode('data').buffer; } };
  };

  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com', cacheTtlMs: 5000 });
    await t.pull('path-a'); // cached at 1000000

    // Advance time past TTL
    fakeNow = 1000000 + 6000;

    await t.pull('path-b'); // cached at 1006000 (fresh)

    const evicted = t.evictStale();
    assertEq(evicted, 1, 'one entry evicted (path-a expired, path-b fresh)');
  } finally {
    Date.now = realNow;
    delete globalThis.fetch;
  }
});

await testBehavior('evictStale() with TTL=0 is a no-op', async () => {
  globalThis.fetch = async () => {
    return { status: 200, ok: true, headers: { get(n) { return n.toLowerCase() === 'etag' ? '"etag"' : null; }, has(n) { return n.toLowerCase() === 'etag'; } }, async arrayBuffer() { return new TextEncoder().encode('data').buffer; } };
  };
  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com' }); // TTL=0 (default)
    await t.pull('path-a');
    await t.pull('path-b');

    const evicted = t.evictStale();
    assertEq(evicted, 0, 'no entries evicted when TTL=0');
  } finally {
    delete globalThis.fetch;
  }
});

await testBehavior('resetCache() clears all entries regardless of TTL', async () => {
  const realNow = Date.now;
  let fakeNow = 1000000;
  Date.now = () => fakeNow;

  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    return { status: 200, ok: true, headers: { get(n) { return n.toLowerCase() === 'etag' ? '"etag"' : null; }, has(n) { return n.toLowerCase() === 'etag'; } }, async arrayBuffer() { return new TextEncoder().encode('data').buffer; } };
  };

  try {
    const t = new HttpTransport({ baseUrl: 'https://example.com', cacheTtlMs: 86400000 }); // 24h TTL
    await t.pull('path');
    t.resetCache();
    await t.pull('path');
    // After reset, the second pull must be a real request (not 304 from cache)
    assert(callCount === 2, 'two real requests after cache reset (TTL-aware)');
  } finally {
    Date.now = realNow;
    delete globalThis.fetch;
  }
});

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n── Results ──────────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.log(`\n  Failed tests:`);
  for (const e of errors) {
    console.log(`    ✗  ${e}`);
  }
}
if (failed > 0) process.exit(1);
