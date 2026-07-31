/**
 * http_backend_test.mjs — HttpBackend test suite.
 *
 * HttpBackend wraps a Transport (HttpTransport or MockRemoteBackend)
 * to conform to the StorageBackend interface, bridging binary blob I/O
 * (Uint8Array) and structured-key-value storage (JSON-serializable values).
 *
 * TDD phases:
 *   RED   — HttpBackend not yet implemented → all tests fail
 *   GREEN — HttpBackend implemented → all tests pass
 *
 * Usage:
 *   node test/http_backend_test.mjs
 */

import { HttpBackend } from '../src/sync/http_backend.js';
import { MockRemoteBackend } from '../src/sync/mock_remote.js';
import { MemoryBackend } from '../src/sync/storage.js';

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

/**
 * Run a test that expects a method to succeed.
 * If it throws → counts as FAILED.
 */
async function testBehavior(label, testFn) {
  try {
    await testFn();
  } catch (err) {
    failed++;
    errors.push(label);
    process.stdout.write('  ✗');
    console.log(`  ${label}`);
    console.log(`      error: ${err.message}`);
  }
}

/**
 * Run a test that expects a method to throw.
 * If it doesn't throw → FAILED.
 */
async function testThrows(label, testFn) {
  try {
    await testFn();
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

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create a MockRemoteBackend with MemoryBackend storage for testing.
 * Returns both the mock and an HttpBackend wrapping it.
 */
function createFixture() {
  const storage = new MemoryBackend();
  const transport = new MockRemoteBackend({
    storage,
    latencyMs: 0,
    errorRate: 0,
  });
  const backend = new HttpBackend({ transport });
  return { storage, transport, backend };
}

// ── Tests ────────────────────────────────────────────────────────────

console.log('══ HttpBackend Test Suite ══\n');

// ── Category 1: Constructor ──
console.log('── Constructor ──');

await testBehavior('constructs with valid transport', async () => {
  const { backend } = createFixture();
  assert(!!backend, 'instance created');
});

await testThrows('empty constructor throws', async () => {
  new HttpBackend();
});

await testThrows('constructor without transport throws', async () => {
  new HttpBackend({});
});

await testThrows('transport without pull throws', async () => {
  new HttpBackend({ transport: { fake: true } });
});

// ── Category 2: get() ──
console.log('\n── get ──');

await testBehavior('get returns parsed JSON from stored blob', async () => {
  const { backend, transport } = createFixture();
  const data = JSON.stringify({ title: 'Coding', duration: 25 });
  await transport.push('test/entry.json', new TextEncoder().encode(data));
  const result = await backend.get('test/entry.json');
  assertDeepEq(result, { title: 'Coding', duration: 25 }, 'returns parsed object');
});

await testBehavior('get returns undefined for missing key', async () => {
  const { backend } = createFixture();
  const result = await backend.get('nonexistent/path.json');
  assertEq(result, undefined, 'returns undefined (not null)');
});

await testBehavior('get returns array from stored blob', async () => {
  const { backend, transport } = createFixture();
  const data = JSON.stringify([1, 2, 3]);
  await transport.push('test/array.json', new TextEncoder().encode(data));
  const result = await backend.get('test/array.json');
  assertDeepEq(result, [1, 2, 3], 'returns parsed array');
});

await testBehavior('get returns string from stored blob', async () => {
  const { backend, transport } = createFixture();
  await transport.push('test/str.json', new TextEncoder().encode('"hello"'));
  const result = await backend.get('test/str.json');
  assertEq(result, 'hello', 'returns parsed string');
});

await testThrows('get throws when transport pull throws', async () => {
  const { backend, transport } = createFixture();
  transport.setErrorRate(1.0);
  await backend.get('test/fail.json');
});

// ── Category 3: set() ──
console.log('\n── set ──');

await testBehavior('set serializes and pushes object', async () => {
  const { backend, transport } = createFixture();
  await backend.set('test/entry.json', { title: 'Reading', duration: 30 });
  const bytes = await transport.pull('test/entry.json');
  assert(bytes !== null, 'blob exists on remote');
  const decoded = JSON.parse(new TextDecoder().decode(bytes));
  assertDeepEq(decoded, { title: 'Reading', duration: 30 }, 'serialized correctly');
});

await testBehavior('set stores string value', async () => {
  const { backend, transport } = createFixture();
  await backend.set('test/name.txt', 'hello world');
  const bytes = await transport.pull('test/name.txt');
  assert(bytes !== null, 'blob exists');
  const decoded = JSON.parse(new TextDecoder().decode(bytes));
  assertEq(decoded, 'hello world', 'string value round-tripped');
});

await testBehavior('set stores number value', async () => {
  const { backend, transport } = createFixture();
  await backend.set('test/count.json', 42);
  const bytes = await transport.pull('test/count.json');
  assert(bytes !== null, 'blob exists');
  const decoded = JSON.parse(new TextDecoder().decode(bytes));
  assertEq(decoded, 42, 'number value round-tripped');
});

await testBehavior('set stores null value', async () => {
  const { backend, transport } = createFixture();
  await backend.set('test/null.json', null);
  const bytes = await transport.pull('test/null.json');
  assert(bytes !== null, 'blob exists');
  const decoded = JSON.parse(new TextDecoder().decode(bytes));
  assertEq(decoded, null, 'null value round-tripped');
});

await testBehavior('set stores boolean value', async () => {
  const { backend, transport } = createFixture();
  await backend.set('test/flag.json', true);
  const bytes = await transport.pull('test/flag.json');
  assert(bytes !== null, 'blob exists');
  const decoded = JSON.parse(new TextDecoder().decode(bytes));
  assertEq(decoded, true, 'boolean value round-tripped');
});

await testThrows('set throws when transport push throws', async () => {
  const { backend, transport } = createFixture();
  transport.setErrorRate(1.0);
  await backend.set('test/fail.json', { x: 1 });
});

// ── Category 4: set / get round-trip ──
console.log('\n── set/get round-trip ──');

await testBehavior('simple object round-trips', async () => {
  const { backend } = createFixture();
  const original = { title: 'Exercise', duration: 45, tags: ['fitness'] };
  await backend.set('test/entry.json', original);
  const result = await backend.get('test/entry.json');
  assertDeepEq(result, original, 'object round-trips');
});

await testBehavior('nested object round-trips', async () => {
  const { backend } = createFixture();
  const original = {
    entry_id: 'abc-123',
    title: 'Deep Work',
    metadata: {
      priority: 'high',
      tags: ['coding', 'focus'],
      notes: [{ ts: 1000, text: 'started' }],
    },
  };
  await backend.set('test/nested.json', original);
  const result = await backend.get('test/nested.json');
  assertDeepEq(result, original, 'nested object round-trips');
});

await testBehavior('array round-trips', async () => {
  const { backend } = createFixture();
  const original = [
    { id: 1, name: 'Task A' },
    { id: 2, name: 'Task B' },
  ];
  await backend.set('test/array.json', original);
  const result = await backend.get('test/array.json');
  assertDeepEq(result, original, 'array round-trips');
});

await testBehavior('empty object round-trips', async () => {
  const { backend } = createFixture();
  await backend.set('test/empty.json', {});
  const result = await backend.get('test/empty.json');
  assertDeepEq(result, {}, 'empty object round-trips');
});

await testBehavior('empty array round-trips', async () => {
  const { backend } = createFixture();
  await backend.set('test/empty-arr.json', []);
  const result = await backend.get('test/empty-arr.json');
  assertDeepEq(result, [], 'empty array round-trips');
});

await testBehavior('multiple keys round-trip independently', async () => {
  const { backend } = createFixture();
  await backend.set('test/a.json', { val: 'A' });
  await backend.set('test/b.json', { val: 'B' });
  const a = await backend.get('test/a.json');
  const b = await backend.get('test/b.json');
  assertDeepEq(a, { val: 'A' }, 'key A retains its value');
  assertDeepEq(b, { val: 'B' }, 'key B retains its value');
});

await testBehavior('overwrite key with new value', async () => {
  const { backend } = createFixture();
  await backend.set('test/key.json', { version: 1 });
  await backend.set('test/key.json', { version: 2 });
  const result = await backend.get('test/key.json');
  assertDeepEq(result, { version: 2 }, 'overwritten value returned');
});

// ── Category 5: list() ──
console.log('\n── list ──');

await testBehavior('list returns paths under prefix', async () => {
  const { backend, transport } = createFixture();
  await transport.push('ledger/blocks/0.json', new TextEncoder().encode('{}'));
  await transport.push('ledger/blocks/1.json', new TextEncoder().encode('{}'));
  await transport.push('staging/blob', new TextEncoder().encode('{}'));
  const files = await backend.list('ledger/blocks/');
  // Transport returns basenames only (prefix stripped), matching Worker behavior.
  // HttpBackend is a pass-through — what the transport returns is what you get.
  assertDeepEq(files, ['0.json', '1.json'], 'returns matching paths');
});

await testBehavior('list returns empty for unmatched prefix', async () => {
  const { backend } = createFixture();
  const files = await backend.list('nonexistent/');
  assertDeepEq(files, [], 'returns empty array');
});

await testBehavior('list returns all files under root prefix', async () => {
  const { backend, transport } = createFixture();
  await transport.push('ledger/blocks/0.json', new TextEncoder().encode('{}'));
  await transport.push('staging/blob', new TextEncoder().encode('{}'));
  const files = await backend.list('');
  assert(files.length >= 2, 'returns all files with empty prefix');
});

// ── Category 6: remove() ──
console.log('\n── remove ──');

await testBehavior('remove deletes blob from remote', async () => {
  const { backend, transport } = createFixture();
  await transport.push('test/toremove.json', new TextEncoder().encode('"data"'));
  await backend.remove('test/toremove.json');
  const result = await transport.pull('test/toremove.json');
  assertEq(result, null, 'blob gone after remove');
});

await testBehavior('get returns undefined after remove', async () => {
  const { backend } = createFixture();
  await backend.set('test/gone.json', { data: 'temp' });
  await backend.remove('test/gone.json');
  const result = await backend.get('test/gone.json');
  assertEq(result, undefined, 'returns undefined after remove');
});

await testBehavior('remove non-existent key does not throw', async () => {
  const { backend } = createFixture();
  let threw = false;
  try {
    await backend.remove('test/never-existed.json');
  } catch {
    threw = true;
  }
  assert(!threw, 'no error removing non-existent key');
});

// ── Category 7: clear() ──
console.log('\n── clear ──');

await testThrows('clear throws not supported', async () => {
  const { backend } = createFixture();
  await backend.clear();
});

// ── Category 8: Interface compliance ──
console.log('\n── Interface compliance ──');

await testBehavior('implements all StorageBackend methods', async () => {
  const { backend } = createFixture();
  assert(typeof backend.get === 'function', 'has get()');
  assert(typeof backend.set === 'function', 'has set()');
  assert(typeof backend.remove === 'function', 'has remove()');
  assert(typeof backend.clear === 'function', 'has clear()');
  assert(typeof backend.list === 'function', 'has list()');
});

await testBehavior('throws expected error messages', async () => {
  const { backend } = createFixture();
  try {
    await backend.clear();
  } catch (err) {
    assert(
      err.message.includes('HttpBackend') && err.message.includes('clear'),
      'error message identifies class and method'
    );
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
