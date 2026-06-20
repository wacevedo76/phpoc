/**
 * storage_plugin_test.mjs — Test suite for all StoragePlugin implementations.
 *
 * Tests the StoragePlugin interface contract for every backend:
 *   1. StoragePlugin        — interface throws on all methods
 *   2. StorageBackend       — base class
 *   3. MemoryBackend        — in-memory Map
 *   4. IndexedDBBackend     — idb-keyval backed
 *   5. MockRemoteBackend    — simulated R2
 *   6. HttpBackend          — HTTP transport wrapper
 *   7. createStoragePlugin  — factory + deployment detection
 *
 * Runs with: node test/storage_plugin_test.mjs
 */

import { StoragePlugin } from '../src/sync/storage_plugin.js';
import { StorageBackend, MemoryBackend } from '../src/sync/storage.js';
import { IndexedDBBackend } from '../src/sync/indexeddb_storage.js';
import { MockRemoteBackend } from '../src/sync/mock_remote_backend.js';
import { HttpBackend } from '../src/sync/http_backend.js';
import { createStoragePlugin, detectDeployment } from '../src/sync/plugin_factory.js';
import { HttpTransport } from '../src/sync/transport.js';

// Silently skip IndexedDB tests in Node.js (needs fake-indexeddb)
let hasIDB = false;
try {
  const { get, set, del, clear, createStore, keys } = await import('idb-keyval');
  // Try a quick operation to see if IndexedDB is available
  const store = createStore('phpoc-test', 'test');
  await set('__probe__', true, store);
  await del('__probe__', store);
  hasIDB = true;
} catch (_) {
  // IndexedDB not available (Node.js without polyfill)
}

// ── Helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; process.stdout.write('  ✓'); }
  else { failed++; process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++;
    process.stdout.write('  ✗');
    const gotStr = actual !== undefined ? JSON.stringify(actual).slice(0, 200) : 'undefined';
    const expStr = expected !== undefined ? JSON.stringify(expected).slice(0, 200) : 'undefined';
    console.log(`\n      got:      ${gotStr}`);
    console.log(`      expected: ${expStr}`);
  }
  console.log(`  ${label}`);
}

function assertThrows(fn, label) {
  try {
    fn();
    failed++;
    console.log(`  ✗  ${label} — expected throw but did not`);
  } catch (_) {
    passed++;
    process.stdout.write('  ✓');
    console.log(`  ${label}`);
  }
}

async function assertRejects(promise, label) {
  try {
    await promise;
    failed++;
    console.log(`  ✗  ${label} — expected reject but did not`);
  } catch (_) {
    passed++;
    process.stdout.write('  ✓');
    console.log(`  ${label}`);
  }
}

// ── Unified test runner ──────────────────────────────────────────────

/**
 * Run the same contract tests against any StoragePlugin instance.
 */
async function testBackend(label, backend, { skipClearAfter = false, skipDelete = false, skipList = false } = {}) {
  console.log(`\n── ${label} ──`);

  // .name, .deployment, .isRemote
  assert(typeof backend.name === 'string' && backend.name.length > 0,
    `name property returns "${backend.name}"`);
  assert(['standalone', 'lan', 'saas', 'mock', 'memory'].includes(backend.deployment),
    `deployment property returns "${backend.deployment}"`);
  assert(typeof backend.isRemote === 'boolean',
    `isRemote returns ${backend.isRemote}`);

  // set + get round-trip (string)
  await backend.set('test:str', 'hello world');
  const got = await backend.get('test:str');
  assertEq(got, 'hello world', 'string round-trip');

  // set + get round-trip (Uint8Array)
  const uint8 = new Uint8Array([0, 128, 255, 42, 7]);
  await backend.set('test:bin', uint8);
  const gotBin = await backend.get('test:bin');
  assert(gotBin instanceof Uint8Array || gotBin !== undefined, 'binary round-trip');
  if (gotBin instanceof Uint8Array) {
    assertEq(Array.from(gotBin), [0, 128, 255, 42, 7], 'binary content preserved');
  }

  // set + get round-trip (object)
  const obj = { title: 'Test', tags: ['a', 'b'], count: 42 };
  await backend.set('test:obj', obj);
  const gotObj = await backend.get('test:obj');
  assertEq(JSON.stringify(gotObj), JSON.stringify(obj), 'object round-trip');

  // get on missing key returns undefined
  const missing = await backend.get('test:nonexistent');
  assertEq(missing, undefined, 'missing key returns undefined');

  if (!skipDelete) {
    // delete then get returns undefined
    await backend.set('test:delete_me', 'temporary');
    await backend.delete('test:delete_me');
    const deleted = await backend.get('test:delete_me');
    assertEq(deleted, undefined, 'delete removes key');

    // remove() alias (backward compat)
    await backend.set('test:remove_me', 'alias test');
    await backend.remove('test:remove_me');
    const removed = await backend.get('test:remove_me');
    assertEq(removed, undefined, 'remove() alias works');
  }

  if (!skipList) {
    // list with prefix
    await backend.set('prefix:a', 'a');
    await backend.set('prefix:b', 'b');
    await backend.set('other:x', 'x');
    const listA = await backend.list('prefix:');
    assertEq(listA.sort(), ['prefix:a', 'prefix:b'], 'list with prefix');

    // list without prefix returns all
    const all = await backend.list();
    const listKeys = all.filter(k => k.startsWith('test:') || k.startsWith('prefix:') || k.startsWith('other:'));
    assert(listKeys.length >= 5, `list() returns keys (got ${listKeys.length})`);

    // list on non-matching prefix returns empty
    const empty = await backend.list('zzz_nonexistent_prefix_');
    assertEq(empty.length, 0, 'list() with no-match prefix returns []');
  }

  // clear
  if (!skipClearAfter) {
    await backend.clear();
    const postClear = await backend.get('test:str');
    assertEq(postClear, undefined, 'clear removes data');
  }

  console.log('');
}

// ══════════════════════════════════════════════════════════════════════
// 1. StoragePlugin interface — every method throws
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ StoragePlugin (interface contract) ═══`);

{
  const iface = new StoragePlugin();
  assertThrows(() => iface.name, 'name getter throws');
  assertThrows(() => iface.deployment, 'deployment getter throws');
  assertThrows(() => iface.isRemote, 'isRemote getter throws');
  assertRejects(iface.get('x'), 'get() rejects');
  assertRejects(iface.set('x', 'y'), 'set() rejects');
  assertRejects(iface.delete('x'), 'delete() rejects');
  assertRejects(iface.list(), 'list() rejects');
  assertRejects(iface.clear(), 'clear() rejects');
}

// ══════════════════════════════════════════════════════════════════════
// 2. StorageBackend (abstract base)
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ StorageBackend (abstract base) ═══`);

{
  const base = new StorageBackend();
  assertEq(base.name, 'StorageBackend', 'name returns class name');
  assertEq(base.deployment, 'standalone', 'deployment returns standalone');
  assertEq(base.isRemote, false, 'isRemote returns false');
  assertRejects(base.get('x'), 'get() rejects');
  assertRejects(base.set('x', 'y'), 'set() rejects');
  assertRejects(base.delete('x'), 'delete() rejects');
  assertRejects(base.list(), 'list() rejects');
  assertRejects(base.clear(), 'clear() rejects');
}

// ══════════════════════════════════════════════════════════════════════
// 3. MemoryBackend
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ MemoryBackend ═══`);

{
  const mem = new MemoryBackend();
  assertEq(mem.name, 'Memory', 'name returns Memory');
  assertEq(mem.deployment, 'standalone', 'deployment returns standalone');
  assertEq(mem.isRemote, false, 'isRemote returns false');

  await testBackend('MemoryBackend contract', mem, { skipList: false });

  // Extra: multiple set/delete cycles
  await mem.set('cycle:1', 'a');
  await mem.set('cycle:2', 'b');
  assertEq(await mem.get('cycle:1'), 'a', 'multiple set/get cycle 1');
  assertEq(await mem.get('cycle:2'), 'b', 'multiple set/get cycle 2');
  await mem.delete('cycle:1');
  assertEq(await mem.get('cycle:1'), undefined, 'delete one preserves others');
  assertEq(await mem.get('cycle:2'), 'b', 'sibling survives delete');
  await mem.clear();
  assertEq(await mem.get('cycle:2'), undefined, 'clear() empties all');
}

// ══════════════════════════════════════════════════════════════════════
// 4. IndexedDBBackend
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ IndexedDBBackend ═══`);

if (hasIDB) {
  const idb = new IndexedDBBackend('phpoc-test');
  assertEq(idb.name, 'IndexedDB', 'name returns IndexedDB');
  assertEq(idb.deployment, 'standalone', 'deployment returns standalone');
  assertEq(idb.isRemote, false, 'isRemote returns false');

  await testBackend('IndexedDBBackend contract', idb, { skipList: false });

  // Clean up test store
  await idb.clear();
} else {
  console.log('  — SKIPPED (IndexedDB not available in Node.js)');
}

// ══════════════════════════════════════════════════════════════════════
// 5. MockRemoteBackend
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ MockRemoteBackend ═══`);

{
  const mock = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  assertEq(mock.name, 'Mock Remote', 'name returns Mock Remote');
  assertEq(mock.deployment, 'mock', 'deployment returns mock');
  assertEq(mock.isRemote, true, 'isRemote returns true');

  await testBackend('MockRemoteBackend contract', mock, { skipList: false });

  // Extra: getWithMeta — ETag behavior
  await mock.clear();
  const { data, etag, status } = await mock.getWithMeta('meta:key');
  assertEq(data, null, 'getWithMeta on missing → data null');
  assertEq(etag, null, 'getWithMeta on missing → etag null');
  assertEq(status, 404, 'getWithMeta on missing → status 404');

  await mock.setWithMeta('meta:key', 'hello');
  const { data: d2, etag: e2, status: s2 } = await mock.getWithMeta('meta:key');
  assertEq(d2 instanceof Uint8Array, true, 'getWithMeta after set → data is Uint8Array');
  assert(typeof e2 === 'string' && e2.startsWith('"'), 'getWithMeta after set → etag is quoted string');
  assertEq(s2, 200, 'getWithMeta after set → status 200');

  // Conditional GET with matching ETag → 304
  const { data: d3, etag: e3, status: s3 } = await mock.getWithMeta('meta:key', { ifNoneMatch: e2 });
  assertEq(d3, null, 'conditional GET matching ETag → data null');
  assertEq(s3, 304, 'conditional GET matching ETag → status 304');

  // Conditional GET with wrong ETag → 200
  const { data: d4, status: s4 } = await mock.getWithMeta('meta:key', { ifNoneMatch: '"wrong-etag"' });
  assert(d4 instanceof Uint8Array, 'conditional GET wrong ETag → data returned');
  assertEq(s4, 200, 'conditional GET wrong ETag → status 200');

  // getEtag
  const storedEtag = mock.getEtag('meta:key');
  assertEq(storedEtag, e2, 'getEtag returns current etag');

  // resetCache clears ETags
  mock.resetCache();
  assertEq(mock.getEtag('meta:key'), null, 'resetCache clears etags');
  assertEq(await mock.get('meta:key') instanceof Uint8Array, true, 'resetCache keeps data');

  // Error rate simulation
  const flakyMock = new MockRemoteBackend({ latencyMs: 0, errorRate: 1.0, seed: 1 });
  await assertRejects(flakyMock.get('any'), 'error rate 1.0 throws on get');
  await assertRejects(flakyMock.set('any', 'val'), 'error rate 1.0 throws on set');
  await assertRejects(flakyMock.list(), 'error rate 1.0 throws on list');

  // delete on mock
  const delMock = new MockRemoteBackend({ latencyMs: 0 });
  await delMock.set('to_delete', 'value');
  await delMock.delete('to_delete');
  assertEq(await delMock.get('to_delete'), undefined, 'MockRemoteBackend.delete works');
  await delMock.set('to_remove', 'value');
  await delMock.remove('to_remove');
  assertEq(await delMock.get('to_remove'), undefined, 'MockRemoteBackend.remove() alias works');

  await mock.clear();
}

// ══════════════════════════════════════════════════════════════════════
// 6. HttpBackend
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ HttpBackend ═══`);

{
  // In-memory mock transport for HttpBackend testing
  class MockHttpTransport {
    constructor() { this._store = new Map(); }
    async pull(path) { return this._store.get(path) ?? null; }
    async push(path, data) { this._store.set(path, data); }
    async delete(path) { this._store.delete(path); }
    async listFiles(prefix = '') {
      const keys = [];
      for (const k of this._store.keys()) {
        if (!prefix || k.startsWith(prefix)) keys.push(k);
      }
      return keys.sort();
    }
    resetCache() {}
    evictStale() {}
  }

  // Constructor validation
  assertThrows(() => new HttpBackend(), 'HttpBackend() throws without transport');
  assertThrows(() => new HttpBackend({}), 'HttpBackend({}) throws without transport');
  assertThrows(() => new HttpBackend({ transport: {} }),
    'HttpBackend({transport:{}}) throws when transport lacks required methods');

  const mockTransport = new MockHttpTransport();
  const http = new HttpBackend({ transport: mockTransport });

  // get/set round-trip
  await http.set('test:obj', { foo: 'bar', n: 42 });
  const gotObj = await http.get('test:obj');
  assertEq(JSON.stringify(gotObj), JSON.stringify({ foo: 'bar', n: 42 }),
    'HttpBackend get/set round-trip (object)');

  // get on missing key returns undefined
  const missing = await http.get('nonexistent');
  assertEq(missing, undefined, 'HttpBackend get missing → undefined');

  // remove
  await http.set('to_remove', 'temp');
  await http.remove('to_remove');
  assertEq(await http.get('to_remove'), undefined, 'HttpBackend remove works');

  // list with prefix
  await http.set('prefix:a', 1);
  await http.set('prefix:b', 2);
  await http.set('other:x', 3);
  const prefixed = await http.list('prefix:');
  assertEq(prefixed.sort(), ['prefix:a', 'prefix:b'], 'HttpBackend list with prefix');

  const all = await http.list();
  assert(all.length >= 3, `HttpBackend list() returns keys (got ${all.length})`);

  // clear() is not supported for remote storage
  await assertRejects(http.clear(), 'HttpBackend.clear() throws (not supported for remote)');
}

// ══════════════════════════════════════════════════════════════════════
// 7. createStoragePlugin + detectDeployment
// ══════════════════════════════════════════════════════════════════════

console.log(`\n═══ createStoragePlugin (factory) ═══`);

{
  // detectDeployment defaults to standalone
  const { deployment, config } = detectDeployment();
  assertEq(deployment, 'standalone', 'detectDeployment defaults to standalone');
  assertEq(typeof config, 'object', 'detectDeployment returns config object');

  // createStoragePlugin with explicit deployment
  const memBackend = await createStoragePlugin({ deployment: 'memory' });
  assert(memBackend instanceof MemoryBackend,
    'createStoragePlugin({deployment:"memory"}) → MemoryBackend');
  assertEq(memBackend.name, 'Memory', 'MemoryBackend via factory');

  const mockBackend = await createStoragePlugin({ deployment: 'mock' });
  assert(mockBackend instanceof MockRemoteBackend,
    'createStoragePlugin({deployment:"mock"}) → MockRemoteBackend');
  assertEq(mockBackend.name, 'Mock Remote', 'MockRemoteBackend via factory');

  const saasBackend = await createStoragePlugin({
    deployment: 'saas',
    config: { baseUrl: 'http://localhost:8888', apiKey: 'k' },
  });
  // Target architecture: saas → local IndexedDB + separate HttpTransport.
  // createStoragePlugin returns local IndexedDB regardless of deployment;
  // remote transport is created separately via createRemoteTransport().
  if (hasIDB) {
    assert(saasBackend instanceof IndexedDBBackend,
      'createStoragePlugin({deployment:"saas", config}) → IndexedDBBackend');
  } else {
    assert(saasBackend instanceof IndexedDBBackend || saasBackend instanceof MemoryBackend,
      'createStoragePlugin({deployment:"saas", config}) → local backend');
  }
  assertEq(saasBackend.deployment, 'standalone', 'saas backend is local (standalone deployment)');
  assertEq(saasBackend.isRemote, false, 'saas backend is not remote');

  // LAN also returns HttpBackend
  // LAN also returns a local backend (IndexedDB)
  const lanBackend = await createStoragePlugin({
    deployment: 'lan',
    config: { baseUrl: 'http://bridge:8080' },
  });
  if (hasIDB) {
    assert(lanBackend instanceof IndexedDBBackend,
      'createStoragePlugin({deployment:"lan"}) → IndexedDBBackend');
  } else {
    assert(lanBackend instanceof IndexedDBBackend || lanBackend instanceof MemoryBackend,
      'createStoragePlugin({deployment:"lan"}) → local backend');
  }

  // Saas without baseUrl still returns IndexedDB (same as any saas deployment)
  if (hasIDB) {
    const noUrlBackend = await createStoragePlugin({ deployment: 'saas' });
    assert(noUrlBackend instanceof IndexedDBBackend,
      'SaaS → IndexedDBBackend (local storage, remote transport separate)');
  }

  // Invalid deployment defaults to standalone
  const invalidBackend = await createStoragePlugin({ deployment: 'invalid' });
  if (hasIDB) {
    assert(invalidBackend instanceof IndexedDBBackend,
      'invalid deployment falls back to IndexedDB');
  } else {
    assert(invalidBackend instanceof MemoryBackend || invalidBackend instanceof IndexedDBBackend,
      'invalid deployment falls back gracefully');
  }

  // Config overrides passed through to backend constructor
  const mockWithLatency = await createStoragePlugin({
    deployment: 'mock',
    config: { latencyMs: 200, errorRate: 0.1 },
  });
  assert(mockWithLatency instanceof MockRemoteBackend,
    'config overrides passed to MockRemoteBackend');

  // Standalone with no override returns IndexedDB or Memory
  const standalone = await createStoragePlugin({ deployment: 'standalone' });
  assert(standalone instanceof IndexedDBBackend || standalone instanceof MemoryBackend,
    'standalone returns a usable backend');
}

// ══════════════════════════════════════════════════════════════════════
// Results
// ══════════════════════════════════════════════════════════════════════

console.log(`\n── Results ────────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
