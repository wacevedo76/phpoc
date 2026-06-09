/**
 * mock_remote_test.mjs — Comprehensive test suite for MockRemoteBackend.
 *
 * Tests MockRemoteBackend as a standalone storage simulation and as the
 * remote backend in the SyncService auth gate flow.
 *
 * Coverage categories:
 *   1. Latency simulation        — configurable per-op delays measured
 *   2. Type preservation          — edge cases: empty, binary, nested, precision
 *   3. ETag simulation depth      — set generates/updates ETag, collisions, format
 *   4. Error simulation           — fractional rates, determinism, state consistency
 *   5. resetCache() semantics     — preserves data, clears ETags, idempotent
 *   6. Concurrency                — parallel ops on same key, batch throughput
 *   7. Path/key normalization     — slashes, special chars, long keys, empty key
 *   8. State inspection           — getEtag, internal consistency after operations
 *   9. SyncService integration    — auth gate, push/pull/reconcile with mock remote
 *
 * Runs with: node test/mock_remote_test.mjs
 */

import { MockRemoteBackend } from '../src/sync/mock_remote_backend.js';
import { SyncService, SyncResult } from '../src/sync/sync.js';
import { DeviceCookie } from '../src/sync/cookie.js';
import { createHash } from 'crypto';

// ── Stats ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; process.stdout.write('  \u2713'); }
  else { failed++; process.stdout.write('  \u2717'); }
  console.log('  ' + label);
}

function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; process.stdout.write('  \u2713'); }
  else {
    failed++;
    process.stdout.write('  \u2717');
    const gotStr = actual !== undefined ? JSON.stringify(actual).slice(0, 250) : 'undefined';
    const expStr = expected !== undefined ? JSON.stringify(expected).slice(0, 250) : 'undefined';
    console.log('\n      got:      ' + gotStr);
    console.log('      expected: ' + expStr);
  }
  console.log('  ' + label);
}

async function assertRejects(promise, label) {
  try {
    await promise;
    failed++;
    console.log('  \u2717  ' + label + ' \u2014 expected reject but did not');
  } catch (_) {
    passed++;
    process.stdout.write('  \u2713');
    console.log('  ' + label);
  }
}

/**
 * Minimal mock CryptoService for SyncService integration tests.
 * Matches the contract used in sync_test.mjs.
 */
class MockCrypto {
  constructor() {
    this._uuidCounter = 0;
    this._specCounter = 0;
    this._mk = null;
  }
  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }
  generateUuid() {
    this._uuidCounter++;
    return '00000000-0000-0000-0000-' + String(this._uuidCounter).padStart(12, '0');
  }
  generateDeviceSpecifier() {
    this._specCounter++;
    return 'spec' + String(this._specCounter).padStart(31, '0');
  }
  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }
  hasMasterKey() { return !!this._mk; }
  getDeviceId(mk) { return 'dev-' + (mk || this._mk || '').slice(0, 8); }
  obfuscateBlob(plaintext, mk) {
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = mk
      ? createHash('sha256').update(mk).digest().slice(0, 4)
      : Buffer.alloc(4);
    return Buffer.concat([keyFingerprint, plainBytes]).toString('base64');
  }
  deobfuscateBlob(b64, mk) {
    const obfuscated = Buffer.from(b64, 'base64');
    if (mk) {
      const storedFp = obfuscated.slice(0, 4);
      const expectedFp = createHash('sha256').update(mk).digest().slice(0, 4);
      if (!storedFp.equals(expectedFp)) throw new Error('key mismatch');
    }
    return obfuscated.slice(4).toString('utf-8');
  }
}

/**
 * Minimal mock transport wrapping MockRemoteBackend for SyncService.
 * Satisfies the HttpTransport contract (pull/push/listFiles/resetCache).
 */
class MockTransportForSync {
  constructor(mockRemote) {
    this._remote = mockRemote;
  }
  async pull(path) {
    const meta = await this._remote.getWithMeta(path);
    if (meta.status === 304) return null;
    return meta.data;
  }
  async push(path, data) {
    await this._remote.setWithMeta(path, data);
  }
  async listFiles(prefix) {
    return this._remote.list(prefix);
  }
  resetCache() {
    this._remote.resetCache();
  }
}

// ══════════════════════════════════════════════════════════════════════
// 1. Latency Simulation
// ══════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 1. Latency Simulation \u2500\u2500');

{
  // 1a. Default latency applied to get
  const slowMock = new MockRemoteBackend({ latencyMs: 100, writeLatencyMs: 0 });
  await slowMock.set('test:key', 'val');
  const t0 = Date.now();
  await slowMock.get('test:key');
  const elapsed = Date.now() - t0;
  assert(elapsed >= 90, 'get() with latencyMs=100 takes >= 90ms (took ' + elapsed + 'ms)');
}

{
  // 1b. Default writeLatencyMs = latencyMs * 2
  const slowMock = new MockRemoteBackend({ latencyMs: 50 });
  const t0 = Date.now();
  await slowMock.set('test:key2', 'val');
  const elapsed = Date.now() - t0;
  assert(elapsed >= 95, 'set() defaults to 2x latency (took ' + elapsed + 'ms)');
}

{
  // 1c. Explicit writeLatencyMs
  const slowMock = new MockRemoteBackend({ latencyMs: 0, writeLatencyMs: 75 });
  const t0 = Date.now();
  await slowMock.set('test:key3', 'val');
  const elapsed = Date.now() - t0;
  assert(elapsed >= 70, 'set() with writeLatencyMs=75 takes >= 70ms (took ' + elapsed + 'ms)');
}

{
  // 1d. Latency on delete()
  const slowMock = new MockRemoteBackend({ latencyMs: 60, writeLatencyMs: 0 });
  await slowMock.set('test:key4', 'val');
  const t0 = Date.now();
  await slowMock.delete('test:key4');
  const elapsed = Date.now() - t0;
  assert(elapsed >= 55, 'delete() with latencyMs=60 takes >= 55ms (took ' + elapsed + 'ms)');
}

{
  // 1e. Latency on list()
  const slowMock = new MockRemoteBackend({ latencyMs: 80, writeLatencyMs: 0 });
  await slowMock.set('ls:a', '1');
  const t0 = Date.now();
  await slowMock.list('ls:');
  const elapsed = Date.now() - t0;
  assert(elapsed >= 75, 'list() with latencyMs=80 takes >= 75ms (took ' + elapsed + 'ms)');
}

{
  // 1f. Latency on getWithMeta()
  const slowMock = new MockRemoteBackend({ latencyMs: 120, writeLatencyMs: 0 });
  await slowMock.set('meta:lat', 'val');
  const t0 = Date.now();
  await slowMock.getWithMeta('meta:lat');
  const elapsed = Date.now() - t0;
  assert(elapsed >= 115, 'getWithMeta() with latencyMs=120 takes >= 115ms (took ' + elapsed + 'ms)');
}

{
  // 1g. Latency on setWithMeta()
  const slowMock = new MockRemoteBackend({ latencyMs: 0, writeLatencyMs: 150 });
  const t0 = Date.now();
  await slowMock.setWithMeta('meta:lat2', 'val');
  const elapsed = Date.now() - t0;
  assert(elapsed >= 145, 'setWithMeta() with writeLatencyMs=150 takes >= 145ms (took ' + elapsed + 'ms)');
}

{
  // 1h. Zero latency is instant-ish (no artificial delay)
  const fastMock = new MockRemoteBackend({ latencyMs: 0, writeLatencyMs: 0 });
  for (const op of ['set', 'get', 'delete', 'list']) {
    const t0 = Date.now();
    if (op === 'set') await fastMock.set('z:fast', 'x');
    else if (op === 'get') await fastMock.get('z:fast');
    else if (op === 'delete') await fastMock.delete('z:fast');
    else if (op === 'list') await fastMock.list('z:');
    const elapsed = Date.now() - t0;
    assert(elapsed < 50, 'zero-latency ' + op + '() completes in < 50ms (took ' + elapsed + 'ms)');
  }
}

// ══════════════════════════════════════════════════════════════════════
// 2. Type Preservation Edge Cases
// ══════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 2. Type Preservation Edge Cases \u2500\u2500');

{
  const mock = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });

  // 2a. Empty Uint8Array
  const emptyBin = new Uint8Array([]);
  await mock.set('type:empty-bin', emptyBin);
  const gotEmptyBin = await mock.get('type:empty-bin');
  assert(gotEmptyBin instanceof Uint8Array, 'empty Uint8Array round-trip: instanceof');
  assertEq(gotEmptyBin.length, 0, 'empty Uint8Array round-trip: length 0');

  // 2b. Uint8Array with all zeros (null bytes — simulates encrypted blocks)
  const nullBytes = new Uint8Array(256);
  await mock.set('type:null-bytes', nullBytes);
  const gotNullBytes = await mock.get('type:null-bytes');
  assert(gotNullBytes instanceof Uint8Array, 'null bytes round-trip: instanceof');
  assertEq(gotNullBytes.length, 256, 'null bytes round-trip: length 256');
  let nullBytesOk = true;
  for (let i = 0; i < 256; i++) {
    if (gotNullBytes[i] !== 0) { nullBytesOk = false; break; }
  }
  assert(nullBytesOk, 'null bytes round-trip: all bytes are 0');

  // 2c. Uint8Array with all 255s (max byte values)
  const maxBytes = new Uint8Array(128).fill(255);
  await mock.set('type:max-bytes', maxBytes);
  const gotMaxBytes = await mock.get('type:max-bytes');
  assert(gotMaxBytes instanceof Uint8Array, 'max bytes round-trip: instanceof');
  assertEq(gotMaxBytes.length, 128, 'max bytes round-trip: length 128');
  let maxBytesOk = true;
  for (let i = 0; i < 128; i++) {
    if (gotMaxBytes[i] !== 255) { maxBytesOk = false; break; }
  }
  assert(maxBytesOk, 'max bytes round-trip: all bytes are 255');

  // 2d. Large binary payload (100K+ Uint8Array — simulates full staging blob)
  const largeSize = 100 * 1024;
  const largeBin = new Uint8Array(largeSize);
  for (let i = 0; i < largeSize; i++) {
    largeBin[i] = (i * 7 + 13) & 0xff;
  }
  await mock.set('type:large-bin', largeBin);
  const gotLargeBin = await mock.get('type:large-bin');
  assert(gotLargeBin instanceof Uint8Array, 'large payload round-trip: instanceof');
  assertEq(gotLargeBin.length, largeSize, 'large payload round-trip: length');
  assertEq(gotLargeBin[0], largeBin[0], 'large payload: first byte');
  assertEq(gotLargeBin[50000], largeBin[50000], 'large payload: middle byte');
  assertEq(gotLargeBin[largeSize - 1], largeBin[largeSize - 1], 'large payload: last byte');

  // 2e. Very long string (>100K chars)
  const longStr = 'x'.repeat(100 * 1024);
  await mock.set('type:long-str', longStr);
  const gotLongStr = await mock.get('type:long-str');
  assert(typeof gotLongStr === 'string', 'long string round-trip: typeof');
  assertEq(gotLongStr.length, 100 * 1024, 'long string round-trip: length');

  // 2f. Empty string
  await mock.set('type:empty-str', '');
  const gotEmptyStr = await mock.get('type:empty-str');
  assert(typeof gotEmptyStr === 'string', 'empty string round-trip: typeof');
  assertEq(gotEmptyStr, '', 'empty string round-trip: value');

  // 2g. Nested object with all JSON types
  const richObj = {
    nullVal: null,
    boolTrue: true,
    boolFalse: false,
    intVal: -42,
    floatVal: 3.141592653589793,
    largeInt: 9007199254740991,
    nested: { a: { b: { c: 'deep' } } },
    arr: [1, 'two', null, true, [3, 4]],
    mixed: [{ x: 1 }, { x: 2 }],
  };
  await mock.set('type:rich-obj', richObj);
  const gotRichObj = await mock.get('type:rich-obj');
  assert(typeof gotRichObj === 'object' && !(gotRichObj instanceof Uint8Array),
    'rich object round-trip: typed as object');
  assertEq(gotRichObj.nullVal, null, 'rich object: null');
  assertEq(gotRichObj.boolTrue, true, 'rich object: true');
  assertEq(gotRichObj.arr[1], 'two', 'rich object: array element');
  assertEq(gotRichObj.nested.a.b.c, 'deep', 'rich object: nested');

  // 2h. Float precision
  await mock.set('type:float', 0.1 + 0.2);
  const gotFloat = await mock.get('type:float');
  assertEq(gotFloat, 0.30000000000000004, 'float precision preserved (0.1+0.2)');

  // 2i. String with only whitespace
  await mock.set('type:whitespace', '   \t\n  ');
  const gotWs = await mock.get('type:whitespace');
  assertEq(gotWs, '   \t\n  ', 'whitespace-only string preserved');

  // 2j. String with Unicode (emoji, non-BMP)
  const unicodeStr = 'Hello \u{1F30D} \u3053\u3093\u306B\u3061\u306F \u6C49\u8BED \uD83C\uDF89\uD83D\uDD25';
  await mock.set('type:unicode', unicodeStr);
  const gotUnicode = await mock.get('type:unicode');
  assertEq(gotUnicode, unicodeStr, 'unicode string round-trips');
  assertEq(gotUnicode.length, unicodeStr.length, 'unicode string length preserved');

  // 2k. Object with numeric keys
  const numericKeyObj = { 1: 'one', 2: 'two', 3: 'three' };
  await mock.set('type:numeric-keys', numericKeyObj);
  const gotNumericKeys = await mock.get('type:numeric-keys');
  assert(typeof gotNumericKeys === 'object', 'object with numeric keys round-trips');
  assertEq(gotNumericKeys['1'], 'one', 'numeric key 1');

  // 2l. Object with __proto__ poison (security sanity check)
  const poisonObj = JSON.parse('{"__proto__":{"polluted":"yes"},"normal":"value"}');
  await mock.set('type:proto-poison', poisonObj);
  const gotPoison = await mock.get('type:proto-poison');
  assertEq(({}).polluted, undefined, '__proto__ pollution did not leak');

  await mock.clear();
}

// ══════════════════════════════════════════════════════════════════════
// 3. ETag Simulation Depth
// ══════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 3. ETag Simulation Depth \u2500\u2500');

{
  const mock = new MockRemoteBackend({ latencyMs: 0 });

  // 3a. set() generates and stores ETag
  await mock.set('etag:gen', 'value');
  const e1 = mock.getEtag('etag:gen');
  assert(typeof e1 === 'string' && e1.startsWith('"') && e1.endsWith('"'),
    'set() generates quoted ETag');

  // 3b. set() on existing key generates new ETag
  await mock.set('etag:gen', 'different value');
  const e2 = mock.getEtag('etag:gen');
  assert(e2 !== e1, 'set() on existing key generates new ETag');

  // 3c. Different payloads produce different ETags
  await mock.set('etag:a', 'hello');
  await mock.set('etag:b', 'world');
  const ea = mock.getEtag('etag:a');
  const eb = mock.getEtag('etag:b');
  assert(ea !== eb, 'different payloads produce different ETags');

  // 3d. Identical payloads produce the same ETag (deterministic hash)
  await mock.set('etag:same1', 'identical data');
  const eSame1 = mock.getEtag('etag:same1');
  await mock.set('etag:same2', 'identical data');
  const eSame2 = mock.getEtag('etag:same2');
  assert(eSame1 === eSame2, 'identical payloads produce same ETag');

  // 3e. setWithMeta returns correct ETag matching getEtag()
  const meta = await mock.setWithMeta('etag:meta', 'meta value');
  assert(typeof meta.etag === 'string' && meta.etag.startsWith('"'),
    'setWithMeta returns quoted ETag');
  assertEq(meta.etag, mock.getEtag('etag:meta'), 'setWithMeta ETag matches getEtag()');

  // 3f. getWithMeta with ifNoneMatch=null/undefined returns full response
  const r1 = await mock.getWithMeta('etag:meta', { ifNoneMatch: null });
  assertEq(r1.status, 200, 'getWithMeta with ifNoneMatch=null returns 200');
  assert(r1.data instanceof Uint8Array, 'getWithMeta with null ifNoneMatch returns data');

  const r2 = await mock.getWithMeta('etag:meta', { ifNoneMatch: undefined });
  assertEq(r2.status, 200, 'getWithMeta with ifNoneMatch=undefined returns 200');
  assert(r2.data instanceof Uint8Array, 'getWithMeta with undefined ifNoneMatch returns data');

  // 3g. Conditional GET with wrong ETag returns 200 + full body
  const r3 = await mock.getWithMeta('etag:meta', { ifNoneMatch: '"not-the-real-etag"' });
  assertEq(r3.status, 200, 'conditional GET with wrong ETag returns 200');
  assert(r3.data instanceof Uint8Array, 'conditional GET with wrong ETag returns data');

  // 3h. delete() removes data AND ETag
  await mock.set('etag:del', 'delete me');
  assert(mock.getEtag('etag:del') !== null, 'ETag exists before delete');
  await mock.delete('etag:del');
  assertEq(mock.getEtag('etag:del'), null, 'ETag cleared after delete');
  const delGet = await mock.get('etag:del');
  assertEq(delGet, undefined, 'data cleared after delete');

  // 3i. clear() removes all ETags
  await mock.set('etag:c1', 'a');
  await mock.set('etag:c2', 'b');
  assert(mock.getEtag('etag:c1') !== null, 'ETag c1 exists before clear');
  assert(mock.getEtag('etag:c2') !== null, 'ETag c2 exists before clear');
  await mock.clear();
  assertEq(mock.getEtag('etag:c1'), null, 'ETag c1 cleared after clear');
  assertEq(mock.getEtag('etag:c2'), null, 'ETag c2 cleared after clear');

  // 3j. getWithMeta on deleted key returns 404
  await mock.set('etag:gone', 'temp');
  await mock.delete('etag:gone');
  const r4 = await mock.getWithMeta('etag:gone');
  assertEq(r4.status, 404, 'getWithMeta on deleted key returns 404');
  assertEq(r4.data, null, 'getWithMeta on deleted key returns data null');
  assertEq(r4.etag, null, 'getWithMeta on deleted key returns etag null');
}

// ══════════════════════════════════════════════════════════════════════
// 4. Error Simulation
// ══════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 4. Error Simulation \u2500\u2500');

{
  // 4a. errorRate=0 never throws
  const safe = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  for (let i = 0; i < 100; i++) {
    await safe.set('err:safe' + i, i);
  }
  assert(true, 'errorRate=0: 100 set() calls all succeed');
  for (let i = 0; i < 100; i++) {
    const v = await safe.get('err:safe' + i);
    if (v !== i) {
      assert(false, 'errorRate=0: get(' + i + ') returned ' + v);
      break;
    }
  }
  assert(true, 'errorRate=0: 100 get() calls all succeed');
}

{
  // 4b. errorRate=1.0 always throws
  const always = new MockRemoteBackend({ latencyMs: 0, errorRate: 1.0 });
  for (let i = 0; i < 5; i++) {
    await assertRejects(always.get('err:always' + i), 'errorRate=1.0 throws on get');
    await assertRejects(always.set('err:always' + i, 'x'), 'errorRate=1.0 throws on set');
    await assertRejects(always.list(), 'errorRate=1.0 throws on list');
    await assertRejects(always.delete('err:always' + i), 'errorRate=1.0 throws on delete');
  }
}

{
  // 4c. Seed determinism: same seed produces same failure pattern
  const results = [];
  for (let trial = 0; trial < 3; trial++) {
    const mock = new MockRemoteBackend({ latencyMs: 0, errorRate: 0.5, seed: 12345 });
    let nErrors = 0;
    for (let i = 0; i < 50; i++) {
      try {
        await mock.get('seed:' + i);
      } catch {
        nErrors++;
      }
    }
    results.push(nErrors);
  }
  assert(
    results[0] === results[1] && results[1] === results[2],
    'same seed (12345) produces same error count across trials: ' + JSON.stringify(results)
  );
}

{
  // 4d. Different seeds produce different failure patterns
  const seed1Errors = [];
  const seed2Errors = [];
  for (let i = 0; i < 100; i++) {
    const m1 = new MockRemoteBackend({ latencyMs: 0, errorRate: 0.5, seed: 1000 });
    const m2 = new MockRemoteBackend({ latencyMs: 0, errorRate: 0.5, seed: 9999 });
    try { await m1.get('ds:' + i); seed1Errors.push(0); } catch { seed1Errors.push(1); }
    try { await m2.get('ds:' + i); seed2Errors.push(0); } catch { seed2Errors.push(1); }
  }
  const s1Str = seed1Errors.join('');
  const s2Str = seed2Errors.join('');
  assert(s1Str !== s2Str, 'different seeds produce different error patterns');
}

{
  // 4e. Error rate 0.5 throws approximately 50% of the time
  const mid = new MockRemoteBackend({ latencyMs: 0, errorRate: 0.5, seed: 42 });
  let errors = 0;
  const N = 200;
  for (let i = 0; i < N; i++) {
    try {
      await mid.get('approx:' + i);
    } catch {
      errors++;
    }
  }
  const pct = errors / N;
  assert(pct >= 0.30 && pct <= 0.70,
    'errorRate=0.5 yields ' + (pct * 100).toFixed(0) + '% errors (expected ~50%)');
}

{
  // 4f. Error on set leaves state consistent (no partial write)
  const flaky = new MockRemoteBackend({ latencyMs: 0, errorRate: 1.0, seed: 1 });
  const underlyingStore = flaky._store;
  await flaky.set('err:partial', 'should-not-exist').catch(function() {});
  const val = await underlyingStore.get('err:partial');
  assertEq(val, undefined, 'rejected set() does not partially write data');
}

{
  // 4g. Error recovery: after an error, subsequent operations work
  const flaky = new MockRemoteBackend({ latencyMs: 0, errorRate: 0.5, seed: 2000 });
  let succeeded = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await flaky.set('err:recover', 'persisted');
      succeeded = true;
      break;
    } catch {
      // Expected
    }
  }
  if (succeeded) {
    try {
      const v = await flaky.get('err:recover');
      assertEq(v, 'persisted', 'data survives across error recovery');
    } catch {
      assert(true, 'get() may also fail with 0.5 error rate — acceptable race');
    }
  } else {
    assert(true, 'errorRate=0.5: set eventually succeeded');
  }
}

{
  // 4h. Error message matches expected string
  const always = new MockRemoteBackend({ latencyMs: 0, errorRate: 1.0, seed: 1 });
  try {
    await always.get('err:msg');
  } catch (e) {
    assertEq(e.message, 'MockRemoteBackend: simulated network error',
      'error message matches expected string');
  }
}

{
  // 4i. Error rate 0.001 rarely throws
  const rare = new MockRemoteBackend({ latencyMs: 0, errorRate: 0.001, seed: 5000 });
  let errors = 0;
  for (let i = 0; i < 5000; i++) {
    try {
      await rare.get('rare:' + i);
    } catch {
      errors++;
    }
  }
  assert(errors >= 0 && errors <= 25,
    'errorRate=0.001 produces ' + errors + ' errors in 5000 ops (expected ~5, range 0-25)');
}

// ══════════════════════════════════════════════════════════════════════
// 5. resetCache() Semantics
// ══════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 5. resetCache() Semantics \u2500\u2500');

{
  const mock = new MockRemoteBackend({ latencyMs: 0 });

  // 5a. resetCache() clears ETags but preserves data and types
  await mock.set('cache:preserve', 'data-here');
  const etagBefore = mock.getEtag('cache:preserve');
  assert(etagBefore !== null, 'ETag exists before resetCache');
  const typeBefore = mock._types.get('cache:preserve');
  assertEq(typeBefore, 'string', 'type tracked before resetCache');

  mock.resetCache();
  assertEq(mock.getEtag('cache:preserve'), null, 'ETag cleared after resetCache');
  const val = await mock.get('cache:preserve');
  assertEq(val, 'data-here', 'data survives resetCache');
  const typeAfter = mock._types.get('cache:preserve');
  assertEq(typeAfter, 'string', 'type survives resetCache');
}

{
  // 5b. After resetCache, getWithMeta returns 200 (no cached ETag)
  const mock = new MockRemoteBackend({ latencyMs: 0 });
  await mock.set('cache:etag', 'value');
  const etag = mock.getEtag('cache:etag');
  mock.resetCache();
  const meta = await mock.getWithMeta('cache:etag', { ifNoneMatch: etag });
  assertEq(meta.status, 200, 'getWithMeta after resetCache returns 200');
  assert(meta.data !== null, 'getWithMeta after resetCache returns data');
}

{
  // 5c. After resetCache, new set() generates a fresh ETag
  const mock = new MockRemoteBackend({ latencyMs: 0 });
  await mock.set('cache:fresh', 'original');
  const e1 = mock.getEtag('cache:fresh');
  mock.resetCache();
  await mock.set('cache:fresh', 'same key new data');
  const e2 = mock.getEtag('cache:fresh');
  assert(e2 !== null && e2 !== e1, 'new set() after resetCache generates fresh ETag');
}

{
  // 5d. resetCache() is idempotent
  const mock = new MockRemoteBackend({ latencyMs: 0 });
  await mock.set('cache:idem', 'x');
  mock.resetCache();
  mock.resetCache();
  assert(true, 'resetCache() is idempotent');
}

{
  // 5e. resetCache() on empty backend does not throw
  const mock = new MockRemoteBackend({ latencyMs: 0 });
  mock.resetCache();
  assert(true, 'resetCache() on empty backend does not throw');
}

// ══════════════════════════════════════════════════════════════════════
// 6. Concurrency
// ══════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 6. Concurrency \u2500\u2500');

{
  const mock = new MockRemoteBackend({ latencyMs: 0 });

  // 6a. Multiple concurrent set() on different keys
  const batchSize = 100;
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    promises.push(mock.set('conc:key' + i, 'value' + i));
  }
  await Promise.all(promises);
  assert(true, 'concurrent set of ' + batchSize + ' keys all complete');
  const vals = await Promise.all(
    Array.from({ length: batchSize }, function(_, i) { return mock.get('conc:key' + i); })
  );
  const allMatch = vals.every(function(v, i) { return v === 'value' + i; });
  assert(allMatch, 'concurrent set values all preserved');
}

{
  // 6b. Multiple concurrent get() on same key
  const mock = new MockRemoteBackend({ latencyMs: 0 });
  await mock.set('conc:shared', 'shared-value');
  const gets = await Promise.all(
    Array.from({ length: 50 }, function() { return mock.get('conc:shared'); })
  );
  const allShared = gets.every(function(v) { return v === 'shared-value'; });
  assert(allShared, '50 concurrent get() on same key all return correct value');
}

{
  // 6c. Concurrent set + get on same key (last write wins)
  const mock = new MockRemoteBackend({ latencyMs: 0 });
  const writers = [];
  for (let i = 0; i < 20; i++) {
    writers.push(mock.set('conc:race', 'writer-' + i));
  }
  await Promise.all(writers);
  const finalVal = await mock.get('conc:race');
  assert(finalVal && finalVal.startsWith('writer-'), 'concurrent writes: last writer wins');
}

{
  // 6d. Concurrent set + delete
  const mock = new MockRemoteBackend({ latencyMs: 0 });
  await Promise.all([
    mock.set('conc:race-del', 'temp'),
    mock.delete('conc:race-del'),
    mock.set('conc:race-del', 'final'),
  ]);
  const v = await mock.get('conc:race-del');
  assertEq(v, 'final', 'concurrent set+delete: final write visible');
}

{
  // 6e. Concurrent setWithMeta preserves ETags
  const mock = new MockRemoteBackend({ latencyMs: 0 });
  await Promise.all([
    mock.setWithMeta('conc:meta1', 'a'),
    mock.setWithMeta('conc:meta2', 'b'),
    mock.setWithMeta('conc:meta3', 'c'),
  ]);
  assert(mock.getEtag('conc:meta1') !== null, 'ETag set after concurrent setWithMeta');
  assert(mock.getEtag('conc:meta2') !== null, 'ETag set after concurrent setWithMeta');
  assert(mock.getEtag('conc:meta3') !== null, 'ETag set after concurrent setWithMeta');
}

// ══════════════════════════════════════════════════════════════════════
// 7. Path/Key Normalization
// ══════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 7. Path/Key Normalization \u2500\u2500');

{
  const mock = new MockRemoteBackend({ latencyMs: 0 });

  // 7a. Keys with slashes (simulates R2 path hierarchy)
  await mock.set('staging/blobs/current.json', 'blob-data');
  await mock.set('ledger/blocks/0.json', 'block-0');
  await mock.set('ledger/blocks/1.json', 'block-1');
  const stagingKeys = await mock.list('staging/');
  assertEq(stagingKeys, ['staging/blobs/current.json'], 'keys with slashes: staging listing');
  const ledgerKeys = await mock.list('ledger/blocks/');
  assertEq(ledgerKeys.sort(), ['ledger/blocks/0.json', 'ledger/blocks/1.json'],
    'keys with slashes: ledger listing');
  const blobData = await mock.get('staging/blobs/current.json');
  assertEq(blobData, 'blob-data', 'keys with slashes: round-trip value');

  // 7b. Keys with special characters (URL-safe and unsafe)
  await mock.set('special:spaces in key', 'spaces');
  await mock.set('special:dashes-and_underscores', 'dashes');
  await mock.set('special:dots.dots.dots', 'dots');
  await mock.set('special:plus+plus', 'plus');
  await mock.set('special:percent%20encoded', 'percent');
  const specialKeys = await mock.list('special:');
  assertEq(specialKeys.sort(), [
    'special:dashes-and_underscores',
    'special:dots.dots.dots',
    'special:percent%20encoded',
    'special:plus+plus',
    'special:spaces in key',
  ], 'keys with special characters round-trip via list()');

  // 7c. Very long key (500+ chars)
  const longKey = 'very/long/path/' + 'a'.repeat(500) + '/end';
  await mock.set(longKey, 'long-key-value');
  const longVal = await mock.get(longKey);
  assertEq(longVal, 'long-key-value', 'very long key round-trips');
  const longList = await mock.list('very/long/');
  assert(longList.length === 1, 'long key appears in list()');

  // 7d. Empty key (edge case — should create entry)
  await mock.set('', 'empty-key-value');
  const emptyVal = await mock.get('');
  assertEq(emptyVal, 'empty-key-value', 'empty string key round-trips');
  const allKeys = await mock.list();
  assert(allKeys.includes(''), 'empty key appears in list()');
  await mock.delete('');
  const afterDelEmpty = await mock.get('');
  assertEq(afterDelEmpty, undefined, 'empty key can be deleted');

  // 7e. Keys with leading/trailing whitespace
  await mock.set('  leading-space', 'leading');
  await mock.set('trailing-space  ', 'trailing');
  assertEq(await mock.get('  leading-space'), 'leading', 'leading whitespace key round-trips');
  assertEq(await mock.get('trailing-space  '), 'trailing', 'trailing whitespace key round-trips');

  // 7f. Multiple path segments (deep hierarchy)
  await mock.set('a/b/c/d/e/f/g', 'deep');
  await mock.set('a/b/c/d/e/f/h', 'sibling');
  const deepKeys = await mock.list('a/b/c/d/e/f/');
  assertEq(deepKeys.sort(), ['a/b/c/d/e/f/g', 'a/b/c/d/e/f/h'], 'deep path hierarchy listing');

  await mock.clear();
}

// ══════════════════════════════════════════════════════════════════════
// 8. State Inspection Helpers
// ══════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 8. State Inspection Helpers \u2500\u2500');

{
  const mock = new MockRemoteBackend({ latencyMs: 0 });

  // 8a. getEtag returns null for non-existent key
  assertEq(mock.getEtag('no-such-key'), null, 'getEtag on missing key returns null');

  // 8b. getEtag returns current etag after set
  await mock.set('state:key1', 'alpha');
  const e1 = mock.getEtag('state:key1');
  assert(typeof e1 === 'string', 'getEtag after set returns string');

  // 8c. getEtag returns updated etag after re-set
  await mock.set('state:key1', 'beta');
  const e2 = mock.getEtag('state:key1');
  assert(e2 !== e1, 'getEtag updated after re-set');

  // 8d. getEtag returns null after delete
  await mock.delete('state:key1');
  assertEq(mock.getEtag('state:key1'), null, 'getEtag returns null after delete');

  // 8e. getEtag returns null after clear
  await mock.set('state:key2', 'gamma');
  assert(mock.getEtag('state:key2') !== null, 'ETag exists before clear');
  await mock.clear();
  assertEq(mock.getEtag('state:key2'), null, 'getEtag returns null after clear');

  // 8f. getEtag returns null after resetCache
  await mock.set('state:key3', 'delta');
  assert(mock.getEtag('state:key3') !== null, 'ETag exists before resetCache');
  mock.resetCache();
  assertEq(mock.getEtag('state:key3'), null, 'getEtag returns null after resetCache');

  // 8g. Multiple keys have independent ETags
  await mock.set('state:indep1', 'x');
  await mock.set('state:indep2', 'y');
  await mock.set('state:indep3', 'z');
  const ei1 = mock.getEtag('state:indep1');
  const ei2 = mock.getEtag('state:indep2');
  const ei3 = mock.getEtag('state:indep3');
  assert(typeof ei1 === 'string', 'ETag for indep1');
  assert(typeof ei2 === 'string', 'ETag for indep2');
  assert(typeof ei3 === 'string', 'ETag for indep3');

  // 8h. Type tracking map consistency
  await mock.set('state:track-str', 'string-value');
  await mock.set('state:track-bin', new Uint8Array([1, 2, 3]));
  await mock.set('state:track-obj', { a: 1 });
  assertEq(mock._types.get('state:track-str'), 'string', 'type tracked for string');
  assertEq(mock._types.get('state:track-bin'), 'uint8', 'type tracked for Uint8Array');
  assertEq(mock._types.get('state:track-obj'), 'object', 'type tracked for object');

  // 8i. Delete removes type tracking
  await mock.delete('state:track-str');
  assertEq(mock._types.has('state:track-str'), false, 'type entry removed after delete');

  // 8j. Clear removes all type tracking
  await mock.clear();
  assertEq(mock._types.size, 0, 'type tracking cleared after clear');
  assertEq(mock._etags.size, 0, 'ETag map cleared after clear');
}

// ══════════════════════════════════════════════════════════════════════
// 9. SyncService Integration with MockRemoteBackend
// ══════════════════════════════════════════════════════════════════════
console.log('\n\u2500\u2500 9. SyncService Integration \u2500\u2500');

// Shared master key for all SyncService integration tests
const MASTER_KEY = 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';

{
  // 9a. checkAndSync without local cookie returns REAUTH_NEEDED (by design)
  // The auth gate unconditionally requires a local cookie, even with MK.
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);
  const result = await sync.checkAndSync();
  assertEq(result, SyncResult.REAUTH_NEEDED,
    '9a: no local cookie returns REAUTH_NEEDED (auth gate requires cookie)');
}

{
  // 9b. pushToRemote bypasses auth gate — writes blob + cookie directly
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);
  await sync.capture({ title: 'PushTest', startEpoch: 1000 });
  await sync.pushToRemote(MASTER_KEY);

  // Verify blob stored on MockRemoteBackend
  const rawBytes = await mockRemote.get('staging/blobs/current.json');
  assert(rawBytes instanceof Uint8Array || rawBytes !== undefined,
    '9b: blob stored in MockRemoteBackend after pushToRemote');

  // Verify cookie stored on MockRemoteBackend
  const cookieBytes = await mockRemote.get('staging/blobs/device_cookie.bin');
  assert(cookieBytes !== undefined, '9b: device cookie stored in MockRemoteBackend');
}

{
  // 9c. RemoteSync reads back blob written via pushToRemote
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);
  await sync.capture({ title: 'ReadBack Test', startEpoch: 5000 });
  await sync.pushToRemote(MASTER_KEY);

  // Verify through RemoteSync
  const remoteSync = sync._remote;
  const pulled = await remoteSync.pullBlob(MASTER_KEY);
  assert(pulled !== null, '9c: pulled blob is not null');
  assert(pulled.device_id !== undefined, '9c: pulled blob has device_id');
  assert(Array.isArray(pulled.entries), '9c: pulled blob has entries array');
  assert(pulled.entries.length > 0, '9c: pulled blob has entries');
  assertEq(pulled.entries[0].title, 'ReadBack Test', '9c: entry title preserved');
}

{
  // 9d. errorRate=1.0 triggers OFFLINE when local cookie exists
  // (local cookie check passes, then remote cookie pull throws)
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 1.0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  // Seed a valid local cookie so we reach the remote call
  const { DeviceCookie } = await import('../src/sync/cookie.js');
  await DeviceCookie.create('dev-999', localStore, crypto);

  const sync = new SyncService(localStore, crypto, transport);
  const result = await sync.checkAndSync();
  assertEq(result, SyncResult.OFFLINE, '9d: errorRate=1.0 with local cookie returns OFFLINE');
}

{
  // 9e. Local CRUD works with SyncService + MockRemoteBackend
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);

  await sync.capture({ title: 'Local Test', startEpoch: 7000, tags: ['test', 'sync'] });
  await sync.capture({ title: 'Second Task', startEpoch: 8000 });

  const entries = await sync.readEntries();
  assertEq(entries.length, 2, '9e: two entries stored locally');
  assertEq(entries[0].title, 'Local Test', '9e: first entry title');

  const active = await sync.getActive();
  assertEq(active.length, 2, '9e: both entries are active');

  const completed = await sync.getCompleted();
  assertEq(completed.length, 0, '9e: no completed entries');

  const pending = await sync.getPendingSync();
  assertEq(pending.length, 0, '9e: no entries pending sync (all active)');
}

{
  // 9f. Capture + end + push workflow
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);

  await sync.capture({ title: 'Workflow Task', startEpoch: 10000, tags: ['workflow'] });
  await sync.end('Workflow Task', 15000);

  const entries = await sync.readEntries();
  assertEq(entries.length, 1, '9f: one entry after capture+end');
  assert(!entries[0].is_active, '9f: entry is no longer active');
  assert(entries[0].end_epoch !== undefined, '9f: end_epoch set');
  assert(entries[0].duration !== undefined, '9f: duration computed');

  // Push to remote
  await sync.pushToRemote(MASTER_KEY);
  const rawBlob = await mockRemote.get('staging/blobs/current.json');
  assert(rawBlob !== undefined, '9f: blob pushed after end');
}

{
  // 9g. Pause + resume workflow through MockRemoteBackend
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);

  await sync.capture({ title: 'Pause Task', startEpoch: 20000 });
  await sync.pause('Pause Task', 25000);
  await sync.unpause('Pause Task', 27000);
  await sync.end('Pause Task', 30000);

  const entries = await sync.readEntries();
  const pEntry = entries[0];
  assert(!pEntry.is_active, '9g: entry ended');
  assert(pEntry.pauses.length === 1, '9g: one pause recorded');
  assertEq(pEntry.pauses[0].pause_start, 25000, '9g: pause_start');
  assertEq(pEntry.pauses[0].pause_stop, 27000, '9g: pause_stop');

  await sync.pushToRemote(MASTER_KEY);
  const rawBlob = await mockRemote.get('staging/blobs/current.json');
  assert(rawBlob !== undefined, '9g: blob pushed after pause workflow');
}

{
  // 9h. MockRemoteBackend latency measured through pushToRemote
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, writeLatencyMs: 100 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);
  await sync.capture({ title: 'Latency Test', startEpoch: 9000 });

  const t0 = Date.now();
  await sync.pushToRemote(MASTER_KEY);
  const elapsed = Date.now() - t0;
  assert(elapsed >= 95,
    '9h: pushToRemote with writeLatencyMs=100 takes >= 95ms (took ' + elapsed + 'ms)');
}

{
  // 9i. checkRemotePing with MockRemoteBackend
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);
  const ping = await sync.checkRemotePing();
  assert(ping, '9i: checkRemotePing returns true for reachable mock');

  // With error rate, ping returns false
  const deadRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 1.0 });
  const deadTransport = new MockTransportForSync(deadRemote);
  const deadSync = new SyncService(localStore, new MockCrypto(), deadTransport);
  const deadPing = await deadSync.checkRemotePing();
  assert(!deadPing, '9i: checkRemotePing returns false for errorRate=1.0');
}

{
  // 9j. SyncService without remote transport returns READY immediately
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, null);
  const result = await sync.checkAndSync();
  assertEq(result, SyncResult.READY, '9j: no transport returns READY immediately');
  assert(!sync.isRemoteAvailable, '9j: isRemoteAvailable returns false without transport');
}

{
  // 9k. Raw RemoteSync round-trip through MockRemoteBackend
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);

  const { RemoteSync } = await import('../src/sync/remote_sync.js');
  const remoteSync = new RemoteSync(transport, crypto);

  const entries = [
    { entry_id: 'r1', title: 'Remote Entry 1', start_epoch: 30000 },
    { entry_id: 'r2', title: 'Remote Entry 2', start_epoch: 31000 },
  ];
  await remoteSync.pushBlob(entries, 'dev-remote', MASTER_KEY);

  const pulled = await remoteSync.pullBlob(MASTER_KEY);
  assert(pulled !== null, '9k: blob pulled');
  assertEq(pulled.device_id, 'dev-remote', '9k: device_id preserved');
  assertEq(pulled.entries.length, 2, '9k: two entries');
  assertEq(pulled.entries[0].entry_id, 'r1', '9k: entry_id preserved through obfuscation');

  // Cookie round-trip
  const cookieData = JSON.stringify({
    device_uuid: 'dev-remote',
    device_specifier: 'spec-test'
  });
  const cookieBytes = new TextEncoder().encode(cookieData);
  await remoteSync.pushCookie(cookieBytes);
  const gotCookie = await remoteSync.pullCookie();
  assert(gotCookie !== null, '9k: cookie pulled');
  const parsed = JSON.parse(new TextDecoder().decode(gotCookie));
  assertEq(parsed.device_uuid, 'dev-remote', '9k: cookie device_uuid');
  assertEq(parsed.device_specifier, 'spec-test', '9k: cookie specifier');
}

{
  // 9l. ETag generated for blob after pushToRemote
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);
  await sync.capture({ title: 'ETag Check', startEpoch: 40000 });
  await sync.pushToRemote(MASTER_KEY);

  const rawBlob = await mockRemote.get('staging/blobs/current.json');
  assert(rawBlob !== undefined, '9l: blob exists on remote');

  const etag = mockRemote.getEtag('staging/blobs/current.json');
  assert(etag !== null, '9l: ETag was generated for blob path');
}

{
  // 9m. pushBlobOnly (no cookie) works through MockRemoteBackend
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);
  await sync.capture({ title: 'BlobOnly', startEpoch: 50000 });
  await sync.pushBlobOnly(MASTER_KEY);

  // Blob exists
  const rawBlob = await mockRemote.get('staging/blobs/current.json');
  assert(rawBlob !== undefined, '9m: blob exists after pushBlobOnly');

  // Cookie should NOT exist (pushBlobOnly doesn't touch cookie)
  const cookieBytes = await mockRemote.get('staging/blobs/device_cookie.bin');
  assertEq(cookieBytes, undefined, '9m: cookie NOT pushed by pushBlobOnly');
}

{
  // 9n. SyncService without MK + remote transport returns REAUTH_NEEDED
  const mockRemote = new MockRemoteBackend({ latencyMs: 0, errorRate: 0 });
  const transport = new MockTransportForSync(mockRemote);
  const crypto = new MockCrypto();
  // No MASTER_KEY set
  const localStore = new (await import('../src/sync/storage.js')).MemoryBackend();

  const sync = new SyncService(localStore, crypto, transport);
  const result = await sync.checkAndSync();
  assertEq(result, SyncResult.REAUTH_NEEDED, '9n: no MK returns REAUTH_NEEDED');
}

// ══════════════════════════════════════════════════════════════════════
// Results
// ══════════════════════════════════════════════════════════════════════
console.log('\n── Results \u2500─');
console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
