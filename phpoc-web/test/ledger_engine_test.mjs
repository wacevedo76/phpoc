/**
 * ledger_engine_test.mjs — LedgerEngine test suite.
 *
 * Tests the high-level orchestration: commit (encrypt fields, group by
 * date, insert summaries, build day blocks, update index), verify chain
 * integrity, revert blocks to staging, query helpers.
 *
 * Option B: consumes StorageBackend (MemoryBackend) directly
 * via key conventions "ledger:blocks" and "ledger:index".
 *
 * TDD: RED phase — source file doesn't exist yet.
 *
 * Usage:
 *   node test/ledger_engine_test.mjs
 */

import { createHash } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';

// ── Import module under test (WILL FAIL — doesn't exist yet) ──
let LedgerEngine;
try {
  const mod = await import('../src/ledger/engine.js');
  LedgerEngine = mod.LedgerEngine;
} catch (err) {
  // Expected: module doesn't exist yet → all tests will fail
  LedgerEngine = undefined;
}

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
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 160)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 160)}`);
  }
  console.log(`  ${label}`);
}

function assertNeq(actual, expected, label) {
  const ok = actual !== expected;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got: ${JSON.stringify(actual).slice(0, 120)} should differ from expected`);
  }
  console.log(`  ${label}`);
}

function assertDeepEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 300)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 300)}`);
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

async function assertAsyncThrows(promise, label) {
  try {
    await promise;
    failed++; errors.push(label);
    process.stdout.write('  ✗  (expected throw, got success)');
  } catch {
    passed++;
    process.stdout.write('  ✓');
  }
  console.log(`  ${label}`);
}

function assertHasKeys(obj, keys, label) {
  const missing = keys.filter(k => !(k in obj));
  const ok = missing.length === 0;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      missing keys: ${missing.join(', ')}`);
  }
  console.log(`  ${label}`);
}

// ── Mock CryptoService (deterministic) ──────────────────────────────
let _idCounter = 0;

function deterministicHash(data) {
  let hash = 5381;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(64, '0');
}

class MockCrypto {
  seal(data, masterKeyHex) {
    return deterministicHash(data + masterKeyHex);
  }

  verifySeal(data, sealHex, masterKeyHex) {
    return this.seal(data, masterKeyHex) === sealHex;
  }

  sign(data, identitySecretHex) {
    return deterministicHash('sign:' + data + identitySecretHex);
  }

  verifySignature(data, signatureHex, identitySecretHex) {
    return this.sign(data, identitySecretHex) === signatureHex;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  encrypt(plaintext, masterKeyHex) {
    // Deterministic encryption: tag value so we can verify in decrypted form
    return 'enc:' + deterministicHash(plaintext + masterKeyHex);
  }

  decrypt(ciphertextHex, masterKeyHex) {
    if (ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }
}

// ── Constants ────────────────────────────────────────────────────────
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const crypto = new MockCrypto();

const ZERO_HASH_64 = '0'.repeat(64);

// Helper: compute entry hash the same way the chain would
function computeEntryHash(dataDict) {
  return createHash('sha256')
    .update(JSON.stringify(dataDict, null, 2), 'utf-8')
    .digest('hex');
}

/**
 * Build a staging-style entry (with plain start_epoch, end_epoch, etc.)
 * as it would come from the staging store.
 */
function makeEntry({
  title = 'Test Activity',
  start_epoch = 1717920000000, // 2024-06-09T00:00:00Z
  duration = 3600000,
  tags = [],
  metadata = {},
  pauses = [],
  comment = '',
  media = [],
  is_active = false,
  is_paused = false,
  entry_id = 'a0000000-0000-4000-a000-000000000001',
  device_uuid = 'dev-test-001',
  end_device_uuid = 'dev-test-001',
} = {}) {
  return {
    entry_id,
    title,
    start_epoch,
    end_epoch: start_epoch + duration,
    duration,
    tags,
    metadata,
    pauses,
    comment,
    media,
    is_active,
    is_paused,
    device_uuid,
    end_device_uuid,
    hash: '',  // will be computed
  };
}

// ─────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────
console.log('\n=== LedgerEngine Class Exists ===');

assert(typeof LedgerEngine === 'function', 'LedgerEngine is a constructor');

if (typeof LedgerEngine === 'function') {
  // ── Constructor ────────────────────────────────────
  console.log('\n=== Constructor ===');

  const store = new MemoryBackend();
  const engine = new LedgerEngine(crypto, store, MASTER_KEY);

  assert(engine instanceof LedgerEngine, 'creates instance with minimum args');
  assert(typeof engine.commit === 'function', 'engine has commit() method');
  assert(typeof engine.verify === 'function', 'engine has verify() method');
  assert(typeof engine.revert === 'function', 'engine has revert() method');

  // ── Empty commit ──────────────────────────────────
  console.log('\n=== Empty Commit ===');

  // Test 1: Empty entries returns null
  const nullResult = await engine.commit([]);
  assertEq(nullResult, null, 'commit([]) returns null');

  // Test 2: No blocks added for empty commit
  assertEq(await engine.getBlockCount(), 0, 'commit([]) adds no blocks');

  // ── Single day commit ─────────────────────────────
  console.log('\n=== Single Day Commit ===');

  const store1 = new MemoryBackend();
  const engine1 = new LedgerEngine(crypto, store1, MASTER_KEY);

  const entry1 = makeEntry({
    title: 'Morning Run',
    start_epoch: new Date(Date.UTC(2025, 0, 2, 0, 0, 0, 0)).getTime(), // 2025-01-02T00:00:00Z
    duration: 3600000,
    tags: ['fitness'],
  });

  // Test 3: commit returns a hash prefix string
  const result1 = await engine1.commit([entry1]);
  assert(typeof result1 === 'string', 'commit returns a string for non-empty entries');
  assertEq(result1.length, 10, 'commit returns 10-char hash prefix');

  // Test 4: One day block created
  assertEq(await engine1.getBlockCount(), 1, 'single entry creates one block');

  // Test 5: Day block structure
  const blocks1 = await engine1.getDayBlocks();
  assertEq(blocks1.length, 1, 'getDayBlocks returns 1 block');
  assertEq(blocks1[0].type, 'day', 'block type is "day"');
  assertEq(blocks1[0].day_index, 1, 'block day_index is 1');
  assertEq(blocks1[0].date, '2025-01-02', 'block date matches entry start');

  // Test 6: Block has prev_hash = all zeros (first block)
  assertEq(blocks1[0].prev_hash, ZERO_HASH_64, 'first block prev_hash is all zeros');

  // Test 7: Block has day_hash and entries
  assertHasKeys(blocks1[0], ['type', 'day_index', 'date', 'prev_hash', 'entries', 'day_hash'],
    'day block has all required keys');
  assertEq(blocks1[0].entries.length, 1, 'block entries length matches input');
  assert(typeof blocks1[0].day_hash === 'string', 'day_hash is present');

  // Test 8: Entry has encrypted fields
  const storedEntry = blocks1[0].entries[0];
  assert(typeof storedEntry.hash === 'string', 'entry has hash');
  assertEq(storedEntry.hash.length, 64, 'entry hash is 64 hex chars');
  assert(storedEntry.data.startTime_enc.startsWith('enc:'),
    'startTime_enc is encrypted');
  assert(storedEntry.data.endTime_enc.startsWith('enc:'),
    'endTime_enc is encrypted');

  // Test 9: Entry has content_hash
  assert(typeof storedEntry.data.content_hash === 'string',
    'entry data has content_hash');
  assertEq(storedEntry.data.content_hash.length, 64,
    'content_hash is 64 hex chars');

  // Test 10: Staging-only fields removed from ledger entry
  assertEq(storedEntry.data.start_epoch, undefined,
    'start_epoch removed from ledger entry');
  assertEq(storedEntry.data.end_epoch, undefined,
    'end_epoch removed from ledger entry');
  assertEq(storedEntry.data.pauses, undefined,
    'pauses array removed from ledger entry');
  assertEq(storedEntry.data.metadata, undefined,
    'metadata removed from ledger entry');
  assertEq(storedEntry.data.is_active, undefined,
    'is_active removed from ledger entry');

  // Test 11: hash_rehash (verify entry hash was computed correctly)
  const recomputedHash = computeEntryHash(storedEntry.data);
  assertEq(storedEntry.hash, recomputedHash, 'entry hash is correct SHA-256 of data');

  // Test 12: Index was updated
  const index1 = engine1.queryIndex('2025-01-01', '2025-01-31');
  assertEq(index1['Morning Run'], 3600000, 'index has correct duration for Morning Run');

  // Test 13: verify passes after single day commit
  assert(await engine1.verify(), 'verify() returns true after commit');

  // ── Multiple days commit ──────────────────────────
  console.log('\n=== Multiple Days Commit ===');

  const store2 = new MemoryBackend();
  const engine2 = new LedgerEngine(crypto, store2, MASTER_KEY);

  const entryDay1a = makeEntry({
    title: 'Morning Run',
    start_epoch: new Date(Date.UTC(2025, 0, 2, 0, 0, 0, 0)).getTime(), // 2025-01-02
    duration: 3600000,
    tags: ['fitness'],
    entry_id: 'a0000000-0000-4000-a000-000000000010',
  });
  const entryDay1b = makeEntry({
    title: 'Reading',
    start_epoch: new Date(Date.UTC(2025, 0, 2, 1, 0, 0, 0)).getTime(), // 2025-01-02, later
    duration: 1800000,
    tags: ['learning'],
    entry_id: 'a0000000-0000-4000-a000-000000000011',
  });
  const entryDay2 = makeEntry({
    title: 'Deep Work',
    start_epoch: new Date(Date.UTC(2025, 0, 3, 0, 0, 0, 0)).getTime(), // 2025-01-03
    duration: 7200000,
    tags: ['work'],
    entry_id: 'a0000000-0000-4000-a000-000000000012',
  });

  const result2a = await engine2.commit([entryDay1a, entryDay1b, entryDay2]);
  assert(typeof result2a === 'string', 'multi-day commit returns hash prefix');

  // Test 14: Two day blocks created
  const dayBlocks2 = await engine2.getDayBlocks();
  assertEq(dayBlocks2.length, 2, 'two days of entries creates two day blocks');

  // Test 15: First block has 2 entries, second has 1
  assertEq(dayBlocks2[0].entries.length, 2, 'first day block has 2 entries');
  assertEq(dayBlocks2[1].entries.length, 1, 'second day block has 1 entry');

  // Test 16: Day indices are sequential
  assertEq(dayBlocks2[0].day_index, 1, 'first block day_index is 1');
  assertEq(dayBlocks2[1].day_index, 2, 'second block day_index is 2');

  // Test 17: Second block links to first
  assertEq(dayBlocks2[1].prev_hash, dayBlocks2[0].day_hash,
    'second block prev_hash links to first block day_hash');

  // Test 18: Index aggregated across days
  const index2 = engine2.queryIndex('2025-01-01', '2025-01-31');
  assertEq(index2['Morning Run'], 3600000, 'index has Morning Run from day 1');
  assertEq(index2['Reading'], 1800000, 'index has Reading from day 1');
  assertEq(index2['Deep Work'], 7200000, 'index has Deep Work from day 2');

  // Test 19: Chain verification passes
  assert(await engine2.verify(), 'verify() returns true for multi-day chain');

  // ── Commit with summary boundaries ────────────────
  console.log('\n=== Commit with Summary Boundaries ===');

  const store3 = new MemoryBackend();
  const engine3 = new LedgerEngine(crypto, store3, MASTER_KEY);

  // Test 20: Month boundary (Jan 31 → Feb 1)
  const entryJan = makeEntry({
    title: 'January Task',
    start_epoch: 1738368000000, // 2025-01-31T16:00:00Z in UTC? No, let me be precise.
    duration: 3600000,
    entry_id: 'a0000000-0000-4000-a000-000000000020',
  });
  // 2025-01-31T00:00:00Z = 1738281600000
  const janDate = new Date(Date.UTC(2025, 0, 31, 0, 0, 0, 0));
  entryJan.start_epoch = janDate.getTime();

  const result3a = await engine3.commit([entryJan]);
  assert(typeof result3a === 'string', 'Jan entry commits');

  // Add Feb 1 entry
  const entryFeb = makeEntry({
    title: 'February Task',
    start_epoch: new Date(Date.UTC(2025, 1, 1, 0, 0, 0, 0)).getTime(),
    duration: 7200000,
    entry_id: 'a0000000-0000-4000-a000-000000000021',
  });

  const result3b = await engine3.commit([entryFeb]);
  assert(typeof result3b === 'string', 'Feb entry commits');

  // Test 21: Chain now has 3 blocks: Jan day + month_summary + Feb day
  const allBlocks3 = await store3.get('ledger:blocks');
  assertEq(allBlocks3.length, 3, 'Jan→Feb creates 3 blocks (day + month_summary + day)');

  // Test 22: Summary block inserted between day blocks
  assertEq(allBlocks3[0].type, 'day', 'block 0 is day block');
  assertEq(allBlocks3[1].type, 'month_summary', 'block 1 is month_summary');
  assertEq(allBlocks3[2].type, 'day', 'block 2 is day block');

  // Test 23: Month summary structure
  assertEq(allBlocks3[1].month, '2025-01', 'month summary covers January');
  assertEq(allBlocks3[1].prev_hash, allBlocks3[0].day_hash,
    'month summary prev_hash links to Jan day block');
  assertEq(allBlocks3[2].prev_hash, allBlocks3[1].month_hash,
    'Feb day block prev_hash links to month summary');

  // Test 24: Chain verification passes with summaries
  assert(await engine3.verify(), 'verify() passes with summary blocks');

  // ── Year boundary ─────────────────────────────────
  console.log('\n=== Year Boundary ===');

  const store4 = new MemoryBackend();
  const engine4 = new LedgerEngine(crypto, store4, MASTER_KEY);

  const entryDec = makeEntry({
    title: 'Dec Task',
    start_epoch: new Date(Date.UTC(2025, 11, 31, 0, 0, 0, 0)).getTime(),
    duration: 3600000,
    entry_id: 'a0000000-0000-4000-a000-000000000030',
  });
  const entryJan2026 = makeEntry({
    title: 'Jan 2026 Task',
    start_epoch: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0)).getTime(),
    duration: 5400000,
    entry_id: 'a0000000-0000-4000-a000-000000000031',
  });

  await engine4.commit([entryDec]);
  await engine4.commit([entryJan2026]);

  // Test 25: Year boundary inserts year_summary + month_summary before Jan day
  const allBlocks4 = await store4.get('ledger:blocks');
  assertEq(allBlocks4.length, 4, 'Dec→Jan 2026 creates 4 blocks');
  assertEq(allBlocks4[0].type, 'day', 'block 0 is Dec day');
  assertEq(allBlocks4[1].type, 'year_summary', 'block 1 is year_summary');
  assertEq(allBlocks4[2].type, 'month_summary', 'block 2 is month_summary');
  assertEq(allBlocks4[3].type, 'day', 'block 3 is Jan 2026 day');

  // Test 26: Year summary covers Dec year
  assertEq(allBlocks4[1].year, 2025, 'year summary covers 2025');

  // Test 27: Chain links correctly across summaries
  assertEq(allBlocks4[1].prev_hash, allBlocks4[0].day_hash,
    'year_summary prev_hash links to Dec day');
  assertEq(allBlocks4[2].prev_hash, allBlocks4[1].year_hash,
    'month_summary prev_hash links to year_summary');
  assertEq(allBlocks4[3].prev_hash, allBlocks4[2].month_hash,
    'Jan day prev_hash links to month_summary');

  assert(await engine4.verify(), 'verify() passes with year boundary');

  // ── Verify tampered chain ─────────────────────────
  console.log('\n=== Verify Tampered Chain ===');

  // Test 28: verify returns false on tampered block seal
  const storeT1 = new MemoryBackend();
  const engineT1 = new LedgerEngine(crypto, storeT1, MASTER_KEY);
  await engineT1.commit([entry1]);

  // Tamper with stored block
  const storedBlocksT1 = await storeT1.get('ledger:blocks');
  storedBlocksT1[0].day_hash = 'f'.repeat(64);
  await storeT1.set('ledger:blocks', storedBlocksT1);

  assert(!(await engineT1.verify()), 'verify() returns false with tampered block seal');

  // Test 29: verify returns false on broken prev_hash linkage
  const storeT2 = new MemoryBackend();
  const engineT2 = new LedgerEngine(crypto, storeT2, MASTER_KEY);
  await engineT2.commit([entry1]);
  const entry1b = makeEntry({
    title: 'Another Task',
    start_epoch: new Date(Date.UTC(2025, 0, 3, 0, 0, 0, 0)).getTime(),
    duration: 1800000,
    entry_id: 'a0000000-0000-4000-a000-000000000040',
  });
  await engineT2.commit([entry1b]);

  const storedBlocksT2 = await storeT2.get('ledger:blocks');
  storedBlocksT2[1].prev_hash = 'ffff' + storedBlocksT2[1].prev_hash.slice(4);
  await storeT2.set('ledger:blocks', storedBlocksT2);

  assert(!(await engineT2.verify()), 'verify() returns false with broken prev_hash');

  // ── Revert ─────────────────────────────────────────
  console.log('\n=== Revert ===');

  const storeR = new MemoryBackend();
  const engineR = new LedgerEngine(crypto, storeR, MASTER_KEY);

  // Commit 2 days of data
  const rEntry1 = makeEntry({
    title: 'Day 1 Task',
    start_epoch: new Date(Date.UTC(2025, 5, 1, 0, 0, 0, 0)).getTime(),
    duration: 3600000,
    entry_id: 'a0000000-0000-4000-a000-000000000050',
  });
  const rEntry2 = makeEntry({
    title: 'Day 2 Task',
    start_epoch: new Date(Date.UTC(2025, 5, 2, 0, 0, 0, 0)).getTime(),
    duration: 7200000,
    entry_id: 'a0000000-0000-4000-a000-000000000051',
  });

  await engineR.commit([rEntry1]);
  await engineR.commit([rEntry2]);

  // Test 30: Before revert, 2 day blocks (plus possible summaries)
  const beforeRevert = await engineR.getBlockCount();
  assert(beforeRevert >= 2, 'before revert: at least 2 blocks exist');

  // Test 31: Revert 1 day block
  const reverted1 = await engineR.revert(1);
  assert(typeof reverted1 === 'number', 'revert returns a number');
  assertEq(reverted1, 1, 'revert(1) returns 1 restored entry');

  // Test 32: After revert, one fewer day block
  const afterRevertCount = await engineR.getBlockCount();
  assert(afterRevertCount < beforeRevert, 'after revert: block count decreased');

  // Test 33: Revert(0) returns 0
  const reverted0 = await engineR.revert(0);
  assertEq(reverted0, 0, 'revert(0) returns 0');

  // Test 34: Chain still verifiable after revert
  assert(await engineR.verify(), 'verify() still passes after revert');

  // ── Revert full chain ─────────────────────────────
  console.log('\n=== Revert Full Chain ===');

  const storeRF = new MemoryBackend();
  const engineRF = new LedgerEngine(crypto, storeRF, MASTER_KEY);

  await engineRF.commit([rEntry1]);
  const commitCount = await engineRF.getBlockCount();

  // Test 35: Revert more than available day blocks returns -1
  const tooMany = await engineRF.revert(999);
  assertEq(tooMany, -1, 'revert(n > day blocks) returns -1');

  // Test 36: Chain still intact after failed revert
  assert(await engineRF.verify(), 'verify() still passes after failed revert');

  // ── Revert with summary blocks ────────────────────
  console.log('\n=== Revert with Summaries ===');

  const storeRS = new MemoryBackend();
  const engineRS = new LedgerEngine(crypto, storeRS, MASTER_KEY);

  // Commit Jan and Feb entries (triggers month summary)
  const janEntry = makeEntry({
    title: 'Jan Work',
    start_epoch: new Date(Date.UTC(2025, 0, 15, 0, 0, 0, 0)).getTime(),
    duration: 3600000,
    entry_id: 'a0000000-0000-4000-a000-000000000060',
  });
  const febEntry = makeEntry({
    title: 'Feb Work',
    start_epoch: new Date(Date.UTC(2025, 1, 1, 0, 0, 0, 0)).getTime(),
    duration: 7200000,
    entry_id: 'a0000000-0000-4000-a000-000000000061',
  });

  await engineRS.commit([janEntry]);
  await engineRS.commit([febEntry]);

  // Should be: [day (Jan), month_summary, day (Feb)]
  const beforeRS = await storeRS.get('ledger:blocks');
  assertEq(beforeRS.length, 3, 'Jan→Feb has 3 blocks (day + month + day)');

  // Test 37: Revert(1) removes Feb day block AND the month summary
  const revertedRS = await engineRS.revert(1);
  assertEq(revertedRS, 1, 'revert(1) on 2-day chain returns 1 entry');

  const afterRS = await storeRS.get('ledger:blocks');
  assertEq(afterRS.length, 1, 'after revert(1), only 1 block remains (Jan day)');
  assertEq(afterRS[0].type, 'day', 'remaining block is day block');

  assert(await engineRS.verify(), 'verify() passes after revert with summaries');

  // ── Index helpers ─────────────────────────────────
  console.log('\n=== Index Helpers ===');

  const storeI = new MemoryBackend();
  const engineI = new LedgerEngine(crypto, storeI, MASTER_KEY);

  const iEntry1 = makeEntry({
    title: 'Coding',
    start_epoch: new Date(Date.UTC(2025, 3, 1, 0, 0, 0, 0)).getTime(), // Apr 1
    duration: 3600000,
    entry_id: 'a0000000-0000-4000-a000-000000000070',
  });
  const iEntry2 = makeEntry({
    title: 'Coding',
    start_epoch: new Date(Date.UTC(2025, 3, 2, 0, 0, 0, 0)).getTime(), // Apr 2
    duration: 5400000,
    entry_id: 'a0000000-0000-4000-a000-000000000071',
  });
  const iEntry3 = makeEntry({
    title: 'Reading',
    start_epoch: new Date(Date.UTC(2025, 3, 1, 0, 0, 0, 0)).getTime(), // Apr 1
    duration: 1800000,
    entry_id: 'a0000000-0000-4000-a000-000000000072',
  });

  await engineI.commit([iEntry1, iEntry2, iEntry3]);

  // Test 38: queryIndex aggregates across days
  const idxApr = engineI.queryIndex('2025-04-01', '2025-04-30');
  assertEq(idxApr['Coding'], 3600000 + 5400000, 'query aggregates Coding across Apr 1-2');
  assertEq(idxApr['Reading'], 1800000, 'query aggregates Reading on Apr 1');

  // Test 39: queryIndex with date range outside data
  const idxOutside = engineI.queryIndex('2025-05-01', '2025-05-31');
  assertDeepEq(idxOutside, {}, 'queryIndex outside data range returns {}');

  // Test 40: rebuildIndex reconstructs from chain
  // First corrupt the index by clearing it
  const storedIdx = await storeI.get('ledger:index');
  await storeI.set('ledger:index', {});
  assertDeepEq(engineI.queryIndex('2025-04-01', '2025-04-30'), {},
    'after clearing index, query returns {}');

  // Then rebuild
  await engineI.rebuildIndex();
  const rebuilt = engineI.queryIndex('2025-04-01', '2025-04-30');
  assertEq(rebuilt['Coding'], 3600000 + 5400000,
    'rebuildIndex restores Coding duration');
  assertEq(rebuilt['Reading'], 1800000,
    'rebuildIndex restores Reading duration');

  // ── Block count and helpers ───────────────────────
  console.log('\n=== Block Count and Helpers ===');

  // Test 41: getBlockCount returns total blocks
  const count = await engineI.getBlockCount();
  assert(typeof count === 'number', 'getBlockCount returns a number');
  assert(count >= 2, 'getBlockCount >= number of day blocks');

  // Test 42: getDayBlocks returns only day blocks
  const dayBlocks = await engineI.getDayBlocks();
  for (const block of dayBlocks) {
    assertEq(block.type, 'day', 'getDayBlocks only returns day-type blocks');
  }

  // Test 43: getLastBlock returns most recent block
  const last = await engineI.getLastBlock();
  assert(last !== null, 'getLastBlock returns a block');
  assert(typeof last === 'object', 'getLastBlock returns an object');

  // ── Edge cases ────────────────────────────────────
  console.log('\n=== Edge Cases ===');

  // Test 44: commit with no title
  const storeE1 = new MemoryBackend();
  const engineE1 = new LedgerEngine(crypto, storeE1, MASTER_KEY);
  const noTitleEntry = makeEntry({
    title: '',
    entry_id: 'a0000000-0000-4000-a000-000000000080',
  });
  const resultNoTitle = await engineE1.commit([noTitleEntry]);
  assert(typeof resultNoTitle === 'string', 'commit with empty title still succeeds');

  // Test 45: commit with zero duration
  const storeE2 = new MemoryBackend();
  const engineE2 = new LedgerEngine(crypto, storeE2, MASTER_KEY);
  const zeroDurEntry = makeEntry({
    title: 'Zero Duration',
    duration: 0,
    entry_id: 'a0000000-0000-4000-a000-000000000081',
  });
  const resultZeroDur = await engineE2.commit([zeroDurEntry]);
  assert(typeof resultZeroDur === 'string', 'commit with zero duration still succeeds');

  // Test 46: verify on empty chain returns true
  const storeE3 = new MemoryBackend();
  const engineE3 = new LedgerEngine(crypto, storeE3, MASTER_KEY);
  assert(await engineE3.verify(), 'verify() on empty chain returns true');

  // Test 47: revert on empty chain returns 0
  const revEmpty = await engineE3.revert(1);
  assertEq(revEmpty, 0, 'revert() on empty chain returns 0');

  // Test 48: getDayBlocks on empty chain
  const emptyDays = await engineE3.getDayBlocks();
  assertDeepEq(emptyDays, [], 'getDayBlocks on empty chain returns []');

  // Test 49: queryIndex on empty engine returns {}
  assertDeepEq(engineE3.queryIndex('2025-01-01', '2025-01-31'), {},
    'queryIndex on empty engine returns {}');

  // Test 50: rebuildIndex on empty engine doesn't crash
  engineE3.rebuildIndex();
  assert(true, 'rebuildIndex on empty engine does not throw');
}

// ── Summary ─────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────────');
console.log(`LedgerEngine tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✗ ${e}`));
}

process.exit(failed > 0 ? 1 : 0);
