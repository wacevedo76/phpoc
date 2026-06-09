/**
 * mock_remote_test.mjs — MockRemoteBackend test suite.
 *
 * Exercises all transport-interface methods (pull, push, listFiles,
 * resetCache) plus mock-specific features (latency, errors, seeding,
 * dump, request log).
 *
 * Uses MemoryBackend for storage so tests run without IndexedDB.
 *
 * Usage:
 *   node test/mock_remote_test.mjs
 */

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

function strToBytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToStr(bytes) {
  return new TextDecoder().decode(bytes);
}

// ── Factory ──────────────────────────────────────────────────────────

function createMock() {
  const storage = new MemoryBackend();
  const remote = new MockRemoteBackend({
    storage,
    latencyMs: 0,
    errorRate: 0,
  });
  return { storage, remote };
}

// ── Tests ────────────────────────────────────────────────────────────

async function testPullAndPush() {
  console.log('\n── pull / push ──');

  const { remote } = createMock();

  const data = strToBytes(JSON.stringify({ hello: 'world' }));
  await remote.push('test/path.json', data);
  const pulled = await remote.pull('test/path.json');
  assert(pulled !== null, 'pull returns bytes after push');
  assertDeepEq(
    JSON.parse(bytesToStr(pulled)),
    { hello: 'world' },
    'pulled bytes match pushed data'
  );
}

async function testPull404() {
  console.log('\n── pull 404 ──');

  const { remote } = createMock();

  const result = await remote.pull('nonexistent/path.json');
  assertEq(result, null, 'pull returns null for missing path');
}

async function testPullTwice() {
  console.log('\n── pull cached ──');

  const { remote } = createMock();

  const data = strToBytes('hello');
  await remote.push('test/hello.json', data);

  const first = await remote.pull('test/hello.json');
  assert(first !== null, 'first pull succeeds');
  assertEq(bytesToStr(first), 'hello', 'first pull content correct');

  const second = await remote.pull('test/hello.json');
  assert(second !== null, 'second pull returns cached body');
  assertEq(bytesToStr(second), 'hello', 'second pull content correct');
}

async function testPushOverwrites() {
  console.log('\n── push overwrites ──');

  const { remote } = createMock();

  await remote.push('test/data.json', strToBytes('version1'));
  await remote.push('test/data.json', strToBytes('version2'));

  remote.resetCache();
  const pulled = await remote.pull('test/data.json');
  assert(pulled !== null, 'pull succeeds after overwrite');
  assertEq(bytesToStr(pulled), 'version2', 'pull returns latest version');
}

async function testListFiles() {
  console.log('\n── listFiles ──');

  const { remote } = createMock();

  await remote.push('ledger/blocks/0.json', strToBytes('{}'));
  await remote.push('ledger/blocks/1.json', strToBytes('{}'));
  await remote.push('ledger/blocks/2.json', strToBytes('{}'));
  await remote.push('staging/blobs/current.json', strToBytes('{}'));
  await remote.push('staging/blobs/device_cookie.bin', strToBytes('{}'));

  const ledgerFiles = await remote.listFiles('ledger/blocks/');
  assertDeepEq(
    ledgerFiles,
    ['ledger/blocks/0.json', 'ledger/blocks/1.json', 'ledger/blocks/2.json'],
    'listFiles returns only matching prefix paths'
  );

  const stagingFiles = await remote.listFiles('staging/blobs/');
  assertDeepEq(
    stagingFiles,
    ['staging/blobs/current.json', 'staging/blobs/device_cookie.bin'],
    'listFiles returns staging blobs'
  );

  const empty = await remote.listFiles('nonexistent/');
  assertDeepEq(empty, [], 'listFiles returns empty for unmatched prefix');
}

async function testListFilesAfterClear() {
  console.log('\n── listFiles after clear ──');

  const { remote } = createMock();

  await remote.push('ledger/blocks/0.json', strToBytes('{}'));
  await remote.push('ledger/blocks/1.json', strToBytes('{}'));
  await remote.clear();

  const files = await remote.listFiles('ledger/blocks/');
  assertDeepEq(files, [], 'listFiles returns empty after clear');
}

async function testResetCache() {
  console.log('\n── resetCache ──');

  const { remote } = createMock();

  await remote.push('test/cached.json', strToBytes('old'));
  await remote.pull('test/cached.json');

  remote.resetCache();

  const result = await remote.pull('test/cached.json');
  assert(result !== null, 'pull works after cache reset');
  assertEq(bytesToStr(result), 'old', 'content unchanged after cache reset');
}

async function testSeed() {
  console.log('\n── seed ──');

  const { remote } = createMock();

  await remote.seed([
    { path: 'staging/blobs/current.json', data: JSON.stringify({ entries: [] }) },
    { path: 'staging/blobs/device_cookie.bin', data: JSON.stringify({ device_uuid: 'test' }) },
    { path: 'ledger/blocks/0.json', data: JSON.stringify({ index: 0 }) },
  ]);

  const blob = await remote.pull('staging/blobs/current.json');
  assert(blob !== null, 'seeded blob is pullable');
  assertDeepEq(JSON.parse(bytesToStr(blob)), { entries: [] }, 'seeded blob content matches');

  const cookie = await remote.pull('staging/blobs/device_cookie.bin');
  assert(cookie !== null, 'seeded cookie is pullable');
  assertDeepEq(JSON.parse(bytesToStr(cookie)), { device_uuid: 'test' }, 'seeded cookie content matches');

  const files = await remote.listFiles('ledger/');
  assertEq(files.length, 1, 'seeded files appear in listFiles');
  assertEq(files[0], 'ledger/blocks/0.json', 'seeded block path correct');
}

async function testDump() {
  console.log('\n── dump ──');

  const { remote } = createMock();

  await remote.push('test/a.json', strToBytes('aaa'));
  await remote.push('test/b.json', strToBytes('bbb'));

  const snapshot = await remote.dump();
  assertEq(snapshot.length, 2, 'dump returns all stored blobs');
  assertEq(snapshot[0].path, 'test/a.json', 'dump paths sorted');
  assertEq(snapshot[1].path, 'test/b.json', 'dump paths sorted');
  assert(snapshot[0].size > 0, 'dump includes size');
  assert(snapshot[0].etag.length > 0, 'dump includes etag');
  assert(snapshot[0].createdAt > 0, 'dump includes createdAt');
}

async function testRequestLog() {
  console.log('\n── request log ──');

  const { remote } = createMock();

  await remote.push('test/a.json', strToBytes('a'));
  await remote.pull('test/a.json');
  await remote.listFiles('test/');

  const log = remote.getRequestLog();
  assertEq(log.length, 3, 'request log records 3 ops');
  assertEq(log[0].method, 'PUT', 'first request is PUT');
  assertEq(log[0].path, 'test/a.json', 'first path correct');
  assertEq(log[1].method, 'GET', 'second is GET');
  assertEq(log[2].method, 'LIST', 'third is LIST');

  remote.clearRequestLog();
  assertEq(remote.getRequestLog().length, 0, 'clearRequestLog works');
}

async function testLatency() {
  console.log('\n── latency ──');

  const { remote } = createMock();

  remote.setLatency(50);

  const start = Date.now();
  await remote.push('test/slow.json', strToBytes('slow'));
  await remote.pull('test/slow.json');
  const elapsed = Date.now() - start;

  assert(elapsed >= 80, `latency applied (elapsed: ${elapsed}ms)`);
}

async function testErrorSimulation() {
  console.log('\n── error simulation ──');

  const { remote } = createMock();

  remote.setErrorRate(1.0);

  let pushFailed = false;
  try { await remote.push('test/fail.json', strToBytes('boom')); }
  catch (err) { pushFailed = err.message.includes('MockRemoteBackend'); }
  assert(pushFailed, 'push throws on error');

  let pullFailed = false;
  try { await remote.pull('test/fail.json'); }
  catch (err) { pullFailed = err.message.includes('MockRemoteBackend'); }
  assert(pullFailed, 'pull throws on error');

  let listFailed = false;
  try { await remote.listFiles('test/'); }
  catch (err) { listFailed = err.message.includes('MockRemoteBackend'); }
  assert(listFailed, 'listFiles throws on error');
}

async function testContract() {
  console.log('\n── contract ──');

  const { remote } = createMock();

  assertEq(remote.isHttp, false, 'isHttp is false');
  assertEq(remote.isMock, true, 'isMock is true');
  assert(typeof remote.pull === 'function', 'pull is function');
  assert(typeof remote.push === 'function', 'push is function');
  assert(typeof remote.listFiles === 'function', 'listFiles is function');
  assert(typeof remote.resetCache === 'function', 'resetCache is function');
}

async function testLargeBlob() {
  console.log('\n── large blob ──');

  const { remote } = createMock();

  const large = new Uint8Array(100 * 1024);
  for (let i = 0; i < large.length; i++) large[i] = i & 0xff;

  await remote.push('test/large.bin', large);
  const pulled = await remote.pull('test/large.bin');

  assert(pulled !== null, 'large blob pulled');
  assertEq(pulled.length, 100 * 1024, 'size preserved');

  let match = true;
  for (let i = 0; i < pulled.length; i++) {
    if (pulled[i] !== (i & 0xff)) { match = false; break; }
  }
  assert(match, 'content preserved');
}

// ── Run ──────────────────────────────────────────────────────────────

async function run() {
  console.log('MockRemoteBackend Test Suite');

  const tests = [
    testPullAndPush,
    testPull404,
    testPullTwice,
    testPushOverwrites,
    testListFiles,
    testListFilesAfterClear,
    testResetCache,
    testSeed,
    testDump,
    testRequestLog,
    testLatency,
    testErrorSimulation,
    testContract,
    testLargeBlob,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (err) {
      failed++;
      errors.push(`${test.name}: ${err.message}`);
      console.log(`  ✗  ${test.name} — EXCEPTION: ${err.message}`);
    }
  }

  const total = passed + failed;
  console.log(`\n── Results ──`);
  console.log(`  ${passed} / ${total} passed${failed > 0 ? `, ${failed} failed` : ''}`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const err of errors) {
      console.log(`    • ${err}`);
    }
    process.exit(1);
  }
}

run();
