/**
 * ledger_import_test.mjs — Test suite for importLedger().
 *
 * Tests that importLedger() correctly parses, validates, and returns
 * entries from an exported ledger file.
 *
 * Design (2026-06-09):
 *   - Parses file → validates format_version, entries, seal
 *   - Verifies seal = HMAC(JSON.stringify(entries), masterKey)
 *   - Re-validates each entry's SHA-256 hash
 *   - Any verification failure → reject entirely (throw)
 *   - Returns { entries, count } on success
 *
 * Usage:
 *   node test/ledger_import_test.mjs
 */

import { createHash } from 'crypto';
import { jsonSort } from '../src/ledger/utils.js';

// ── Import the module under test (WILL FAIL — file doesn't exist yet) ──
let importLedger;
try {
  const mod = await import('../src/services/ledger_import.js');
  importLedger = mod.importLedger;
} catch (err) {
  // Expected: module doesn't exist yet → all tests will fail
  importLedger = undefined;
}

// ── Stats ───────────────────────────────────────────────────────────
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
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 200)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 200)}`);
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

function assertNeq(actual, expected, label) {
  const ok = actual !== expected;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
  }
  console.log(`  ${label}`);
}

function assertThrows(fn, label) {
  try {
    fn();
    failed++; errors.push(label);
    process.stdout.write('  ✗  (expected throw, got success)');
  } catch {
    passed++;
    process.stdout.write('  ✓');
  }
  console.log(`  ${label}`);
}

function assertAsyncThrows(fnPromise, label) {
  return fnPromise.then(
    () => {
      failed++; errors.push(label);
      process.stdout.write('  ✗  (expected throw, got success)');
      console.log(`  ${label}`);
    },
    () => {
      passed++;
      process.stdout.write('  ✓');
      console.log(`  ${label}`);
    }
  );
}

// ── Helpers ─────────────────────────────────────────────────────────
function deterministicHash(data) {
  let hash = 5381;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(64, '0');
}

function realSha256(data) {
  return createHash('sha256').update(data, 'utf-8').digest('hex');
}

// ── Mock CryptoService ──────────────────────────────────────────────
class MockCrypto {
  deterministicHash(data) {
    let hash = 5381;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return (hash >>> 0).toString(16).padStart(64, '0');
  }

  seal(data, masterKeyHex) {
    return this.deterministicHash(data + masterKeyHex);
  }

  verifySeal(data, sealHex, masterKeyHex) {
    return this.seal(data, masterKeyHex) === sealHex;
  }

  sha256(data) {
    return realSha256(data);
  }
}

// ── Sample data ─────────────────────────────────────────────────────
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const crypto = new MockCrypto();

// Build test entries with proper SHA-256 hashes
function buildEntry(overrides = {}) {
  const base = {
    entry_id: 'a1000000-0000-4000-a000-000000000001',
    title: 'Test Entry',
    start_epoch: 1717920000000,
    end_epoch: 1717921800000,
    duration: 1800000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['test'],
    comment: null,
    media: [],
    device_uuid: 'dev-dummy-001',
    end_device_uuid: 'dev-dummy-001',
    metadata: {},
    hash: '',
  };
  const entry = { ...base, ...overrides };
  // Compute proper SHA-256 hash if not provided
  if (!entry.hash) {
    const hashData = {};
    for (const k of Object.keys(entry).sort()) {
      if (k !== 'hash') hashData[k] = entry[k];
    }
    entry.hash = realSha256(jsonSort(hashData));
  }
  return entry;
}

function makeExportFile(entries, mk, overrides = {}) {
  const entriesJson = jsonSort(entries);
  const seal = overrides.seal !== undefined
    ? overrides.seal
    : crypto.seal(entriesJson, mk);

  return JSON.stringify({
    format_version: overrides.format_version || '1',
    exported_at: overrides.exported_at || '2026-06-09T14:30:00.000Z',
    entries: entries,
    seal: seal,
  });
}

function blobFrom(str) {
  return new Blob([str], { type: 'application/json' });
}

// ─────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────
console.log('\n=== importLedger Function Exists ===');

assert(typeof importLedger === 'function', 'importLedger is a function');

// ── Successful import ───────────────────────────────────────────────
console.log('\n=== Successful Import ===');

if (typeof importLedger === 'function') {
  const entry1 = buildEntry({ title: 'Morning Exercise' });
  const entry2 = buildEntry({
    entry_id: 'a2000000-0000-4000-a000-000000000002',
    title: 'Deep Work Session',
    tags: ['work', 'focus'],
  });

  const entries = [entry1, entry2];
  const fileContent = makeExportFile(entries, MASTER_KEY);
  const file = blobFrom(fileContent);

  // Test 1: Returns { entries, count }
  const result = await importLedger(file, crypto, MASTER_KEY);
  assert(typeof result === 'object', 'returns an object');
  assert(Array.isArray(result.entries), 'result.entries is an array');
  assert(typeof result.count === 'number', 'result.count is a number');
  assertEq(result.count, 2, 'correct count: 2 entries');
  assertDeepEq(result.entries, entries, 'returned entries match source');

  // Test 2: Import single entry
  const singleFile = blobFrom(makeExportFile([entry1], MASTER_KEY));
  const singleResult = await importLedger(singleFile, crypto, MASTER_KEY);
  assertEq(singleResult.count, 1, 'correct count: 1 entry');

  // Test 3: Import empty entries
  const emptyFile = blobFrom(makeExportFile([], MASTER_KEY));
  const emptyResult = await importLedger(emptyFile, crypto, MASTER_KEY);
  assertEq(emptyResult.count, 0, 'correct count: 0 entries (empty)');
  assertDeepEq(emptyResult.entries, [], 'empty entries array returned');
}

// ── Seal verification ───────────────────────────────────────────────
console.log('\n=== Seal Verification ===');

if (typeof importLedger === 'function') {
  const entry = buildEntry();
  const entries = [entry];

  // Test 4: Wrong seal → reject entirely
  const tamperedSeal = blobFrom(makeExportFile(entries, MASTER_KEY, {
    seal: 'f'.repeat(64),
  }));
  await assertAsyncThrows(
    importLedger(tamperedSeal, crypto, MASTER_KEY),
    'rejects on wrong seal'
  );

  // Test 5: Wrong master key → seal mismatch → reject
  const wrongKey = 'a'.repeat(64);
  await assertAsyncThrows(
    importLedger(blobFrom(makeExportFile(entries, MASTER_KEY)), crypto, wrongKey),
    'rejects on wrong master key (seal mismatch)'
  );

  // Test 6: Tampered entries (different from what was sealed) → reject
  const tamperedEntries = blobFrom((() => {
    const json = makeExportFile(entries, MASTER_KEY);
    const parsed = JSON.parse(json);
    parsed.entries[0].title = 'Tampered Title';
    return JSON.stringify(parsed);
  })());
  await assertAsyncThrows(
    importLedger(tamperedEntries, crypto, MASTER_KEY),
    'rejects on tampered entries (seal no longer matches)'
  );
}

// ── Entry hash re-validation ────────────────────────────────────────
console.log('\n=== Entry Hash Re-validation ===');

if (typeof importLedger === 'function') {
  const original = buildEntry();
  const badHash = buildEntry({ hash: 'f'.repeat(64) });
  const entries = [badHash];

  // Test 7: Wrong entry hash → reject
  const badHashFile = blobFrom(makeExportFile(entries, MASTER_KEY));
  await assertAsyncThrows(
    importLedger(badHashFile, crypto, MASTER_KEY),
    'rejects entry with wrong hash'
  );

  // Test 8: Mixed valid and invalid hashes → reject entirely (no partial)
  const mixed = [original, badHash];
  const mixedFile = blobFrom(makeExportFile(mixed, MASTER_KEY));
  await assertAsyncThrows(
    importLedger(mixedFile, crypto, MASTER_KEY),
    'rejects entirely when one entry has bad hash (no partial import)'
  );
}

// ── File validation ─────────────────────────────────────────────────
console.log('\n=== File Structure Validation ===');

if (typeof importLedger === 'function') {
  const entry = buildEntry();

  // Test 9: Missing format_version → reject
  const noFormat = JSON.stringify({
    exported_at: '2026-06-09T14:30:00.000Z',
    entries: [entry],
    seal: crypto.seal(JSON.stringify([entry]), MASTER_KEY),
  });
  await assertAsyncThrows(
    importLedger(blobFrom(noFormat), crypto, MASTER_KEY),
    'rejects when format_version is missing'
  );

  // Test 10: Missing entries array → reject
  const noEntries = JSON.stringify({
    format_version: '1',
    exported_at: '2026-06-09T14:30:00.000Z',
    seal: 'f'.repeat(64),
  });
  await assertAsyncThrows(
    importLedger(blobFrom(noEntries), crypto, MASTER_KEY),
    'rejects when entries field is missing'
  );

  // Test 11: entries is not an array → reject
  const entriesNotArray = JSON.stringify({
    format_version: '1',
    exported_at: '2026-06-09T14:30:00.000Z',
    entries: 'not-an-array',
    seal: 'f'.repeat(64),
  });
  await assertAsyncThrows(
    importLedger(blobFrom(entriesNotArray), crypto, MASTER_KEY),
    'rejects when entries is not an array'
  );

  // Test 12: Missing seal → reject
  const noSeal = JSON.stringify({
    format_version: '1',
    exported_at: '2026-06-09T14:30:00.000Z',
    entries: [entry],
  });
  await assertAsyncThrows(
    importLedger(blobFrom(noSeal), crypto, MASTER_KEY),
    'rejects when seal is missing'
  );

  // Test 13: Invalid JSON → reject
  await assertAsyncThrows(
    importLedger(blobFrom('not valid json'), crypto, MASTER_KEY),
    'rejects on invalid JSON'
  );

  // Test 14: Unknown format_version → reject or warn
  // Strict mode should reject unknown versions
  const unknownVersion = makeExportFile([entry], MASTER_KEY, { format_version: '99' });
  // Current design allows any format_version, but let's be strict:
  // the test expects the implementation to handle it — for now, assert it doesn't crash
  const result = await importLedger(blobFrom(unknownVersion), crypto, MASTER_KEY);
  assert(result.count === 1, 'unknown format_version does not crash (graceful handling)');
}

// ── Active task preservation ────────────────────────────────────────
console.log('\n=== Active Task Flags ===');

if (typeof importLedger === 'function') {
  const activeEntry = buildEntry({
    title: 'Active Task',
    is_active: true,
    is_paused: false,
    end_epoch: null,
    duration: 0,
  });
  const pausedEntry = buildEntry({
    entry_id: 'a3000000-0000-4000-a000-000000000003',
    title: 'Paused Task',
    is_active: true,
    is_paused: true,
    end_epoch: null,
    duration: 0,
    pauses: [{ pause_start: 1717921000000 }],
  });

  // Test 15: Active task flags preserved on import
  const activeFile = blobFrom(makeExportFile([activeEntry, pausedEntry], MASTER_KEY));
  const result = await importLedger(activeFile, crypto, MASTER_KEY);
  assertEq(result.entries[0].is_active, true, 'active flag preserved');
  assertEq(result.entries[0].is_paused, false, 'non-paused flag preserved');
  assertEq(result.entries[1].is_active, true, 'active flag preserved for paused task');
  assertEq(result.entries[1].is_paused, true, 'paused flag preserved');
}

// ── Null masterKey handling ─────────────────────────────────────────
console.log('\n=== Master Key Handling ===');

if (typeof importLedger === 'function') {
  const entry = buildEntry();
  const file = blobFrom(makeExportFile([entry], MASTER_KEY));

  await assertAsyncThrows(
    importLedger(file, crypto, null),
    'throws if masterKey is null'
  );

  await assertAsyncThrows(
    importLedger(file, crypto, undefined),
    'throws if masterKey is undefined'
  );
}

// ── Summary ─────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✗ ${e}`));
}

process.exit(failed > 0 ? 1 : 0);
