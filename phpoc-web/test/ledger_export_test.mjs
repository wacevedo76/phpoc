/**
 * ledger_export_test.mjs — Test suite for exportLedger().
 *
 * Tests that exportLedger() produces a correctly structured, sealed
 * Blob that can be written as a .json file and later imported.
 *
 * Design (2026-06-09):
 *   - Auth-gated: caller must provide masterKey (from passphrase prompt)
 *   - File format: { format_version, exported_at, entries, seal }
 *   - Seal covers JSON.stringify(entries) only (not wrapper metadata)
 *   - format_version = "1", exported_at = ISO-8601
 *   - Entry hashes are preserved as-is from the source entries
 *
 * Usage:
 *   node test/ledger_export_test.mjs
 */

import { createHash } from 'crypto';
import { jsonSort } from '../src/ledger/utils.js';

// ── Import the module under test (WILL FAIL — file doesn't exist yet) ──
// This import will throw, demonstrating the RED phase of TDD.
let exportLedger;
try {
  const mod = await import('../src/services/ledger_export.js');
  exportLedger = mod.exportLedger;
} catch (err) {
  // Expected: module doesn't exist yet → all tests will fail
  exportLedger = undefined;
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

// ── Mock CryptoService (deterministic, matches DummyLedger patterns) ──
class MockCrypto {
  constructor() {
    this._idCounter = 0;
  }

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
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }
}

// ── Sample entries ──────────────────────────────────────────────────
const SAMPLE_ENTRIES = [
  {
    entry_id: 'a1000000-0000-4000-a000-000000000001',
    title: 'Morning Exercise',
    start_epoch: 1717920000000,
    end_epoch: 1717921800000,
    duration: 1800000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['fitness', 'health'],
    comment: null,
    media: [],
    device_uuid: 'dev-dummy-001',
    end_device_uuid: 'dev-dummy-001',
    metadata: {},
    hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
  },
  {
    entry_id: 'a2000000-0000-4000-a000-000000000002',
    title: 'Deep Work Session',
    start_epoch: 1717927200000,
    end_epoch: 1717934400000,
    duration: 7200000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['work', 'focus'],
    comment: 'Finished the proposal draft',
    media: [],
    device_uuid: 'dev-dummy-001',
    end_device_uuid: 'dev-dummy-001',
    metadata: {},
    hash: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3',
  },
];

const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const crypto = new MockCrypto();

// ─────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────
console.log('\n=== exportLedger Function Exists ===');

assert(typeof exportLedger === 'function', 'exportLedger is a function');

// ── Basic structure ─────────────────────────────────────────────────
console.log('\n=== File Format Structure ===');

if (typeof exportLedger === 'function') {
  // Test 1: Returns a Blob
  const blob = await exportLedger(SAMPLE_ENTRIES, crypto, MASTER_KEY);
  assert(blob instanceof Blob, 'returns a Blob');
  assertEq(blob.type, 'application/json', 'Blob has JSON MIME type');

  // Test 2: Blob contents parse to expected structure
  const text = await blob.text();
  const parsed = JSON.parse(text);

  assert(typeof parsed === 'object', 'result parses as object');
  assertEq(parsed.format_version, '1', 'format_version is "1"');
  assert(typeof parsed.exported_at === 'string', 'exported_at is a string');
  assert(/^\d{4}-\d{2}-\d{2}T/.test(parsed.exported_at), 'exported_at is ISO-8601');
  assert(Array.isArray(parsed.entries), 'entries is an array');
  assert(typeof parsed.seal === 'string', 'seal is a string');

  // Test 3: Entries match input after hash recomputation
  // (Export recomputes hashes over all fields — the entries differ in hash)
  const expectedRecomputed = SAMPLE_ENTRIES.map(entry => {
    const { hash: _, ...hashData } = entry;
    return { ...entry, hash: crypto.sha256(jsonSort(hashData)) };
  });
  assertDeepEq(parsed.entries, expectedRecomputed, 'exported entries match recomputed input');

  // Test 4: Seal is a 64-char hex string
  assertEq(parsed.seal.length, 64, 'seal is 64 hex chars');
  assert(/^[0-9a-f]{64}$/.test(parsed.seal), 'seal is valid hex');
}

// ── Seal correctness ────────────────────────────────────────────────
console.log('\n=== Seal Integrity ===');

if (typeof exportLedger === 'function') {
  const blob = await exportLedger(SAMPLE_ENTRIES, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // Test 5: Seal covers jsonSort(recomputedEntries) only
  const expectedRecomputed = SAMPLE_ENTRIES.map(entry => {
    const { hash: _, ...hashData } = entry;
    return { ...entry, hash: crypto.sha256(jsonSort(hashData)) };
  });
  const recomputedJson = jsonSort(expectedRecomputed);
  const expectedSeal = crypto.seal(recomputedJson, MASTER_KEY);
  assertEq(parsed.seal, expectedSeal, 'seal = HMAC(jsonSort(recomputedEntries), masterKey)');

  // Test 6: Seal does NOT cover wrapper metadata (exported_at, format_version)
  // Re-compute seal from entries only — metadata changes must not invalidate it
  const wrongSeal = crypto.seal(jsonSort({ entries: SAMPLE_ENTRIES }), MASTER_KEY);
  // The correct seal is on entries alone, not wrapped in an object
  assert(parsed.seal !== wrongSeal, 'seal does not cover wrapper metadata');

  // Test 7: exportLedger with empty entries
  const emptyBlob = await exportLedger([], crypto, MASTER_KEY);
  const emptyParsed = JSON.parse(await emptyBlob.text());
  assertDeepEq(emptyParsed.entries, [], 'empty entries array works');
  assert(typeof emptyParsed.seal === 'string', 'empty entries still produces seal');
}

// ── Master key parameter ────────────────────────────────────────────
console.log('\n=== Master Key Handling ===');

if (typeof exportLedger === 'function') {
  // Test 8: Different master key produces different seal
  const blob1 = await exportLedger(SAMPLE_ENTRIES, crypto, MASTER_KEY);
  const blob2 = await exportLedger(SAMPLE_ENTRIES, crypto, MASTER_KEY + 'ff');
  const p1 = JSON.parse(await blob1.text());
  const p2 = JSON.parse(await blob2.text());
  assert(p1.seal !== p2.seal, 'different master key produces different seal');

  // Test 9: Same master key + same entries = deterministic seal
  const blob3 = await exportLedger(SAMPLE_ENTRIES, crypto, MASTER_KEY);
  const p3 = JSON.parse(await blob3.text());
  assertEq(p1.seal, p3.seal, 'same input produces deterministic seal');
}

// ── Entry hash recomputation ───────────────────────────────────────
console.log('\n=== Entry Hash Recomputation ===');

if (typeof exportLedger === 'function') {
  const blob = await exportLedger(SAMPLE_ENTRIES, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // Test 10: Entry hashes are recomputed to cover all fields (key fix for Step 5)
  for (let i = 0; i < SAMPLE_ENTRIES.length; i++) {
    const { hash: _, ...hashData } = SAMPLE_ENTRIES[i];
    const expectedHash = crypto.sha256(jsonSort(hashData));
    assertEq(parsed.entries[i].hash, expectedHash,
      `entry[${i}] hash recomputed to cover all fields: ${SAMPLE_ENTRIES[i].title}`);
  }
}

// ── Error handling ──────────────────────────────────────────────────
console.log('\n=== Error Handling ===');

if (typeof exportLedger === 'function') {
  // Test 11: Throws if crypto is missing seal function
  const badCrypto = {};
  await assertAsyncThrows(
    exportLedger(SAMPLE_ENTRIES, badCrypto, MASTER_KEY),
    'throws if crypto has no seal()'
  );

  // Test 12: Throws if entries is not an array
  await assertAsyncThrows(
    exportLedger('not-an-array', crypto, MASTER_KEY),
    'throws if entries is not an array'
  );

  // Test 13: Throws if masterKey is missing
  await assertAsyncThrows(
    exportLedger(SAMPLE_ENTRIES, crypto, undefined),
    'throws if masterKey is undefined'
  );

  // Test 14: Throws if masterKey is empty
  await assertAsyncThrows(
    exportLedger(SAMPLE_ENTRIES, crypto, ''),
    'throws if masterKey is empty string'
  );
}

// ── Group A: Hash Recomputation (Step 5 TDD) ─────────────────────
console.log('\n=== Step 5 — A1: Entry hash recomputation with extra fields ===');

if (typeof exportLedger === 'function') {
  // REPRODUCER: entries with extra fields (committed, block_index, entry_index,
  // end_device_uuid) added AFTER original hash computation — like real
  // entries from LocalCache.append() → readEntries()
  const entryWithExtras = {
    entry_id: 'a3000000-0000-4000-a000-000000000003',
    title: 'Entry With Extras',
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
    // Extra fields added by LocalCache.append() after hash computation
    committed: false,
    block_index: null,
    entry_index: 0,
  };

  // Original hash: computed over core fields only (WITHOUT committed,
  // block_index, entry_index). This is what a real stale hash looks like.
  const coreFields = {};
  for (const k of Object.keys(entryWithExtras).sort()) {
    if (k !== 'hash' && k !== 'committed' && k !== 'block_index' && k !== 'entry_index') {
      coreFields[k] = entryWithExtras[k];
    }
  }
  const staleHash = crypto.sha256(jsonSort(coreFields));
  entryWithExtras.hash = staleHash;

  // Correct hash: covers ALL fields except 'hash'
  const allFields = {};
  for (const k of Object.keys(entryWithExtras).sort()) {
    if (k !== 'hash') allFields[k] = entryWithExtras[k];
  }
  const correctHash = crypto.sha256(jsonSort(allFields));

  // Entry without extras — hash already correct
  const entryNoExtras = {
    entry_id: 'a4000000-0000-4000-a000-000000000004',
    title: 'Entry No Extras',
    start_epoch: 1717930000000,
    end_epoch: 1717933600000,
    duration: 3600000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['other'],
    comment: null,
    media: [],
    device_uuid: 'dev-dummy-001',
    end_device_uuid: 'dev-dummy-001',
    metadata: {},
  };
  const fieldsNoExtras = {};
  for (const k of Object.keys(entryNoExtras).sort()) {
    if (k !== 'hash') fieldsNoExtras[k] = entryNoExtras[k];
  }
  entryNoExtras.hash = crypto.sha256(jsonSort(fieldsNoExtras));

  // Export both entries
  const blob = await exportLedger([entryWithExtras, entryNoExtras], crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // A1.1: Entry with extras — hash must be recomputed to include all fields
  assert(parsed.entries[0].hash !== staleHash,
    'A1.1: entry[0] hash recomputed (≠ original stale hash)');
  assertEq(parsed.entries[0].hash, correctHash,
    'A1.1: entry[0] hash = correct hash covering all fields');

  // A1.2: Entry without extras — hash unchanged
  assertEq(parsed.entries[1].hash, entryNoExtras.hash,
    'A1.2: entry[1] hash unchanged (no extra fields)');

  // A1.3: Seal covers the RECOMPUTED entries (not originals)
  const expectedSeal = crypto.seal(jsonSort(parsed.entries), MASTER_KEY);
  assertEq(parsed.seal, expectedSeal,
    'A1.3: seal = HMAC(jsonSort(recomputedEntries), masterKey)');
}

console.log('\n=== Step 5 — A2: Deterministic recomputation ===');

if (typeof exportLedger === 'function') {
  const entryWithExtras2 = {
    entry_id: 'a5000000-0000-4000-a000-000000000005',
    title: 'Deterministic Test',
    start_epoch: 1717920000000,
    end_epoch: 1717921800000,
    duration: 1800000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['det'],
    comment: null,
    media: [],
    device_uuid: 'dev-dummy-001',
    end_device_uuid: 'dev-dummy-001',
    metadata: {},
    committed: false,
    block_index: null,
  };
  // Set stale hash (core fields only, missing committed/block_index)
  const core2 = {};
  for (const k of Object.keys(entryWithExtras2).sort()) {
    if (k !== 'hash' && k !== 'committed' && k !== 'block_index') {
      core2[k] = entryWithExtras2[k];
    }
  }
  entryWithExtras2.hash = crypto.sha256(jsonSort(core2));

  const blob1 = await exportLedger([entryWithExtras2], crypto, MASTER_KEY);
  const blob2 = await exportLedger([entryWithExtras2], crypto, MASTER_KEY);
  const p1 = JSON.parse(await blob1.text());
  const p2 = JSON.parse(await blob2.text());

  assertEq(p1.seal, p2.seal,
    'A2.1: same entries exported twice → identical seals');
  assertEq(p1.entries[0].hash, p2.entries[0].hash,
    'A2.2: same entries exported twice → identical recomputed hashes');
}

// ── Summary ─────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✗ ${e}`));
}

process.exit(failed > 0 ? 1 : 0);
