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
 * Usage:
 *   node test/ledger_engine_test.mjs
 */

import { createHash } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';
import { MockCrypto } from './mock_crypto.mjs';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSortIndent2 } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Import module under test ──
let LedgerEngine;
try {
  const mod = await import('../src/ledger/engine.js');
  LedgerEngine = mod.LedgerEngine;
} catch (err) {
  LedgerEngine = undefined;
}

// ── Constants ────────────────────────────────────────────────────────
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const crypto = new MockCrypto();
crypto.setMasterKey(MASTER_KEY);

const ZERO_HASH_64 = '0'.repeat(64);

// Helper: compute entry hash the same way the chain would
function computeEntryHash(dataDict) {
  return createHash('sha256')
    .update(jsonSortIndent2(dataDict), 'utf-8')
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

t.assert(typeof LedgerEngine === 'function', 'LedgerEngine is a constructor');

if (typeof LedgerEngine === 'function') {
  // ── Constructor ────────────────────────────────────
  console.log('\n=== Constructor ===');

  const store = new MemoryBackend();
  const engine = new LedgerEngine(crypto, store, MASTER_KEY);

  t.assert(engine instanceof LedgerEngine, 'creates instance with minimum args');
  t.assert(typeof engine.commit === 'function', 'engine has commit() method');
  t.assert(typeof engine.verify === 'function', 'engine has verify() method');
  t.assert(typeof engine.revert === 'function', 'engine has revert() method');

  // ── Empty commit ──────────────────────────────────
  console.log('\n=== Empty Commit ===');

  // Test 1: Empty entries returns null
  const nullResult = await engine.commit([]);
  t.assertEq(nullResult, null, 'commit([]) returns null');

  // Test 2: No blocks added for empty commit
  t.assertEq(await engine.getBlockCount(), 0, 'commit([]) adds no blocks');

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

  // Test 3: commit returns a hash prefix object
  const result1 = await engine1.commit([entry1]);
  t.assert(result1 !== null && typeof result1 === 'object', 'commit returns an object for non-empty entries');
  t.assert(typeof result1.hashPrefix === 'string', 'commit.hashPrefix is a string');
  t.assertEq(result1.hashPrefix.length, 10, 'commit.hashPrefix is 10-char');
  t.assert(Array.isArray(result1.committedEntryIds), 'commit.committedEntryIds is an array');
  t.assert(typeof result1.blockIndex === 'number', 'commit.blockIndex is a number');

  // Test 4: One day block created
  t.assertEq(await engine1.getBlockCount(), 1, 'single entry creates one block');

  // Test 5: Day block structure
  const blocks1 = await engine1.getDayBlocks();
  t.assertEq(blocks1.length, 1, 'getDayBlocks returns 1 block');
  t.assertEq(blocks1[0].type, 'day', 'block type is "day"');
  t.assertEq(blocks1[0].day_index, 1, 'block day_index is 1');
  t.assertEq(blocks1[0].date, '2025-01-02', 'block date matches entry start');

  // Test 6: Block has prev_hash = all zeros (first block)
  t.assertEq(blocks1[0].prev_hash, ZERO_HASH_64, 'first block prev_hash is all zeros');

  // Test 7: Block has day_hash and entries
  t.assertHasKeys(blocks1[0], ['type', 'day_index', 'date', 'prev_hash', 'entries', 'day_hash'],
    'day block has all required keys');
  t.assertEq(blocks1[0].entries.length, 1, 'block entries length matches input');
  t.assert(typeof blocks1[0].day_hash === 'string', 'day_hash is present');

  // Test 8: Entry has encrypted fields
  const storedEntry = blocks1[0].entries[0];
  t.assert(typeof storedEntry.hash === 'string', 'entry has hash');
  t.assertEq(storedEntry.hash.length, 64, 'entry hash is 64 hex chars');
  t.assert(storedEntry.data.startTime_enc.includes('enc:'),
    'startTime_enc is encrypted');
  t.assert(storedEntry.data.endTime_enc.includes('enc:'),
    'endTime_enc is encrypted');

  // Test 9: Entry has content_hash
  t.assert(typeof storedEntry.data.content_hash === 'string',
    'entry data has content_hash');
  t.assertEq(storedEntry.data.content_hash.length, 64,
    'content_hash is 64 hex chars');

  // Test 10: Staging-only fields removed from ledger entry
  t.assertEq(storedEntry.data.start_epoch, undefined,
    'start_epoch removed from ledger entry');
  t.assertEq(storedEntry.data.end_epoch, undefined,
    'end_epoch removed from ledger entry');
  t.assertEq(storedEntry.data.pauses, undefined,
    'pauses array removed from ledger entry');
  t.assertEq(storedEntry.data.metadata, undefined,
    'metadata removed from ledger entry');
  t.assertEq(storedEntry.data.is_active, undefined,
    'is_active removed from ledger entry');

  // Test 11: hash_rehash (verify entry hash was computed correctly)
  const recomputedHash = computeEntryHash(storedEntry.data);
  t.assertEq(storedEntry.hash, recomputedHash, 'entry hash is correct SHA-256 of data');

  // Test 12: Index was updated
  const index1 = await engine1.queryIndex('2025-01-01', '2025-01-31');
  t.assertEq(index1['Morning Run'], 3600000, 'index has correct duration for Morning Run');

  // Test 13: verify passes after single day commit
  t.assert(await engine1.verify(), 'verify() returns true after commit');

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
  t.assert(typeof result2a.hashPrefix === 'string', 'multi-day commit returns hash prefix');

  // Test 14: Two day blocks created
  const dayBlocks2 = await engine2.getDayBlocks();
  t.assertEq(dayBlocks2.length, 2, 'two days of entries creates two day blocks');

  // Test 15: First block has 2 entries, second has 1
  t.assertEq(dayBlocks2[0].entries.length, 2, 'first day block has 2 entries');
  t.assertEq(dayBlocks2[1].entries.length, 1, 'second day block has 1 entry');

  // Test 16: Day indices are sequential
  t.assertEq(dayBlocks2[0].day_index, 1, 'first block day_index is 1');
  t.assertEq(dayBlocks2[1].day_index, 2, 'second block day_index is 2');

  // Test 17: Second block links to first
  t.assertEq(dayBlocks2[1].prev_hash, dayBlocks2[0].day_hash,
    'second block prev_hash links to first block day_hash');

  // Test 18: Index aggregated across days
  const index2 = await engine2.queryIndex('2025-01-01', '2025-01-31');
  t.assertEq(index2['Morning Run'], 3600000, 'index has Morning Run from day 1');
  t.assertEq(index2['Reading'], 1800000, 'index has Reading from day 1');
  t.assertEq(index2['Deep Work'], 7200000, 'index has Deep Work from day 2');

  // Test 19: Chain verification passes
  t.assert(await engine2.verify(), 'verify() returns true for multi-day chain');

  // ── Commit with summary boundaries ────────────────
  console.log('\n=== Commit with Summary Boundaries ===');

  const store3 = new MemoryBackend();
  const engine3 = new LedgerEngine(crypto, store3, MASTER_KEY);

  // Test 20: Month boundary (Jan 31 → Feb 1)
  const entryJan = makeEntry({
    title: 'January Task',
    start_epoch: new Date(Date.UTC(2025, 0, 31, 0, 0, 0, 0)).getTime(),
    duration: 3600000,
    entry_id: 'a0000000-0000-4000-a000-000000000020',
  });
  const entryFeb = makeEntry({
    title: 'February Task',
    start_epoch: new Date(Date.UTC(2025, 1, 1, 0, 0, 0, 0)).getTime(),
    duration: 7200000,
    entry_id: 'a0000000-0000-4000-a000-000000000021',
  });

  const result3a = await engine3.commit([entryJan]);
  t.assert(typeof result3a.hashPrefix === 'string', 'Jan entry commits');

  const result3b = await engine3.commit([entryFeb]);
  t.assert(typeof result3b.hashPrefix === 'string', 'Feb entry commits');

  // Test 21: Chain now has 3 blocks: Jan day + month_summary + Feb day
  const allBlocks3 = await store3.get('ledger:blocks');
  t.assertEq(allBlocks3.length, 3, 'Jan→Feb creates 3 blocks (day + month_summary + day)');

  // Test 22: Summary block inserted between day blocks
  t.assertEq(allBlocks3[0].type, 'day', 'block 0 is day block');
  t.assertEq(allBlocks3[1].type, 'month_summary', 'block 1 is month_summary');
  t.assertEq(allBlocks3[2].type, 'day', 'block 2 is day block');

  // Test 23: Month summary structure
  t.assertEq(allBlocks3[1].month, '2025-01', 'month summary covers January');
  t.assertEq(allBlocks3[1].prev_hash, allBlocks3[0].day_hash,
    'month summary prev_hash links to Jan day block');
  t.assertEq(allBlocks3[2].prev_hash, allBlocks3[1].month_hash,
    'Feb day block prev_hash links to month summary');

  // Test 24: Chain verification passes with summaries
  t.assert(await engine3.verify(), 'verify() passes with summary blocks');

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
  t.assertEq(allBlocks4.length, 4, 'Dec→Jan 2026 creates 4 blocks');
  t.assertEq(allBlocks4[0].type, 'day', 'block 0 is Dec day');
  t.assertEq(allBlocks4[1].type, 'year_summary', 'block 1 is year_summary');
  t.assertEq(allBlocks4[2].type, 'month_summary', 'block 2 is month_summary');
  t.assertEq(allBlocks4[3].type, 'day', 'block 3 is Jan 2026 day');

  // Test 26: Year summary covers Dec year
  t.assertEq(allBlocks4[1].year, 2025, 'year summary covers 2025');

  // Test 27: Chain links correctly across summaries
  t.assertEq(allBlocks4[1].prev_hash, allBlocks4[0].day_hash,
    'year_summary prev_hash links to Dec day');
  t.assertEq(allBlocks4[2].prev_hash, allBlocks4[1].year_hash,
    'month_summary prev_hash links to year_summary');
  t.assertEq(allBlocks4[3].prev_hash, allBlocks4[2].month_hash,
    'Jan day prev_hash links to month_summary');

  t.assert(await engine4.verify(), 'verify() passes with year boundary');

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

  t.assert(!(await engineT1.verify()), 'verify() returns false with tampered block seal');

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

  t.assert(!(await engineT2.verify()), 'verify() returns false with broken prev_hash');

  // ── Revert ─────────────────────────────────────────
  console.log('\n=== Revert ===');

  const storeR = new MemoryBackend();
  const engineR = new LedgerEngine(crypto, storeR, MASTER_KEY);

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
  t.assert(beforeRevert >= 2, 'before revert: at least 2 blocks exist');

  // Test 31: Revert 1 day block
  const reverted1 = await engineR.revert(1);
  t.assert(typeof reverted1 === 'number', 'revert returns a number');
  t.assertEq(reverted1, 1, 'revert(1) returns 1 restored entry');

  // Test 32: After revert, one fewer day block
  const afterRevertCount = await engineR.getBlockCount();
  t.assert(afterRevertCount < beforeRevert, 'after revert: block count decreased');

  // Test 33: Revert(0) returns 0
  const reverted0 = await engineR.revert(0);
  t.assertEq(reverted0, 0, 'revert(0) returns 0');

  // Test 34: Chain still verifiable after revert
  t.assert(await engineR.verify(), 'verify() still passes after revert');

  // ── Revert full chain ─────────────────────────────
  console.log('\n=== Revert Full Chain ===');

  const storeRF = new MemoryBackend();
  const engineRF = new LedgerEngine(crypto, storeRF, MASTER_KEY);

  await engineRF.commit([rEntry1]);
  const commitCount = await engineRF.getBlockCount();

  // Test 35: Revert more than available day blocks returns -1
  const tooMany = await engineRF.revert(999);
  t.assertEq(tooMany, -1, 'revert(n > day blocks) returns -1');

  // Test 36: Chain still intact after failed revert
  t.assert(await engineRF.verify(), 'verify() still passes after failed revert');

  // ── Revert with summary blocks ────────────────────
  console.log('\n=== Revert with Summaries ===');

  const storeRS = new MemoryBackend();
  const engineRS = new LedgerEngine(crypto, storeRS, MASTER_KEY);

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

  const beforeRS = await storeRS.get('ledger:blocks');
  t.assertEq(beforeRS.length, 3, 'Jan→Feb has 3 blocks (day + month + day)');

  // Test 37: Revert(1) removes Feb day block AND the month summary
  const revertedRS = await engineRS.revert(1);
  t.assertEq(revertedRS, 1, 'revert(1) on 2-day chain returns 1 entry');

  const afterRS = await storeRS.get('ledger:blocks');
  t.assertEq(afterRS.length, 1, 'after revert(1), only 1 block remains (Jan day)');
  t.assertEq(afterRS[0].type, 'day', 'remaining block is day block');

  t.assert(await engineRS.verify(), 'verify() passes after revert with summaries');

  // ── Revert: staging persistence ───────────────────
  console.log('\n=== Revert: Staging Persistence ===');

  const storeRP = new MemoryBackend();
  const engineRP = new LedgerEngine(crypto, storeRP, MASTER_KEY);

  const rpEntry1 = makeEntry({
    title: 'Persist Test',
    start_epoch: new Date(Date.UTC(2025, 6, 1, 0, 0, 0, 0)).getTime(),
    duration: 3600000,
    entry_id: 'a0000000-0000-4000-a000-000000000062',
  });
  const rpEntry2 = makeEntry({
    title: 'Persist Test 2',
    start_epoch: new Date(Date.UTC(2025, 6, 2, 0, 0, 0, 0)).getTime(),
    duration: 7200000,
    entry_id: 'a0000000-0000-4000-a000-000000000063',
  });

  await engineRP.commit([rpEntry1, rpEntry2]);

  // Test: revert persists entries to staging store
  const revertedRP = await engineRP.revert(1);
  t.assertEq(revertedRP, 1, 'revert returns 1 restored entry');

  const stagingRP = await storeRP.get('ledger:staging');
  t.assert(Array.isArray(stagingRP), 'revert persists restored entries to ledger:staging');
  t.assertEq(stagingRP.length, 1, 'staging has correct count of restored entries');
  t.assert(typeof stagingRP[0].hash === 'string', 'staging entry has hash field');
  t.assert(typeof stagingRP[0].data === 'object', 'staging entry has data field');
  t.assert(typeof stagingRP[0].start_epoch === 'number', 'staging entry has start_epoch field');

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
  const idxApr = await engineI.queryIndex('2025-04-01', '2025-04-30');
  t.assertEq(idxApr['Coding'], 3600000 + 5400000, 'query aggregates Coding across Apr 1-2');
  t.assertEq(idxApr['Reading'], 1800000, 'query aggregates Reading on Apr 1');

  // Test 39: queryIndex with date range outside data
  const idxOutside = await engineI.queryIndex('2025-05-01', '2025-05-31');
  t.assertDeepEq(idxOutside, {}, 'queryIndex outside data range returns {}');

  // Test 40: rebuildIndex reconstructs from chain
  const storedIdx = await storeI.get('ledger:index');
  await storeI.set('ledger:index', {});
  t.assertDeepEq(await engineI.queryIndex('2025-04-01', '2025-04-30'), {},
    'after clearing index, query returns {}');

  await engineI.rebuildIndex();
  const rebuilt = await engineI.queryIndex('2025-04-01', '2025-04-30');
  t.assertEq(rebuilt['Coding'], 3600000 + 5400000,
    'rebuildIndex restores Coding duration');
  t.assertEq(rebuilt['Reading'], 1800000,
    'rebuildIndex restores Reading duration');

  // ── Block count and helpers ───────────────────────
  console.log('\n=== Block Count and Helpers ===');

  // Test 41: getBlockCount returns total blocks
  const count = await engineI.getBlockCount();
  t.assert(typeof count === 'number', 'getBlockCount returns a number');
  t.assert(count >= 2, 'getBlockCount >= number of day blocks');

  // Test 42: getDayBlocks returns only day blocks
  const dayBlocks = await engineI.getDayBlocks();
  for (const block of dayBlocks) {
    t.assertEq(block.type, 'day', 'getDayBlocks only returns day-type blocks');
  }

  // Test 43: getLastBlock returns most recent block
  const last = await engineI.getLastBlock();
  t.assert(last !== null, 'getLastBlock returns a block');
  t.assert(typeof last === 'object', 'getLastBlock returns an object');

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
  t.assert(typeof resultNoTitle.hashPrefix === 'string', 'commit with empty title still succeeds');

  // Test 45: commit with zero duration
  const storeE2 = new MemoryBackend();
  const engineE2 = new LedgerEngine(crypto, storeE2, MASTER_KEY);
  const zeroDurEntry = makeEntry({
    title: 'Zero Duration',
    duration: 0,
    entry_id: 'a0000000-0000-4000-a000-000000000081',
  });
  const resultZeroDur = await engineE2.commit([zeroDurEntry]);
  t.assert(typeof resultZeroDur.hashPrefix === 'string', 'commit with zero duration still succeeds');

  // Test 46: verify on empty chain returns true
  const storeE3 = new MemoryBackend();
  const engineE3 = new LedgerEngine(crypto, storeE3, MASTER_KEY);
  t.assert(await engineE3.verify(), 'verify() on empty chain returns true');

  // Test 47: revert on empty chain returns 0
  const revEmpty = await engineE3.revert(1);
  t.assertEq(revEmpty, 0, 'revert() on empty chain returns 0');

  // Test 48: getDayBlocks on empty chain
  const emptyDays = await engineE3.getDayBlocks();
  t.assertDeepEq(emptyDays, [], 'getDayBlocks on empty chain returns []');

  // Test 49: queryIndex on empty engine returns {}
  t.assertDeepEq(await engineE3.queryIndex('2025-01-01', '2025-01-31'), {},
    'queryIndex on empty engine returns {}');

  // Test 50: rebuildIndex on empty engine doesn't crash
  await engineE3.rebuildIndex();
  t.assert(true, 'rebuildIndex on empty engine does not throw');

  // ── Array sort in content hash ────────────────────
  console.log('\n=== Array Sort in Content Hash ===');

  // Test 51: arrays with non-lexicographic values produce same content_hash
  const storeAS1 = new MemoryBackend();
  const engineAS1 = new LedgerEngine(crypto, storeAS1, MASTER_KEY);
  const entryAS1 = makeEntry({
    title: 'Array Sort Test',
    duration: 1000,
    media: [10, 2],
    entry_id: 'as01-0000-4000-a000-000000000082',
  });
  await engineAS1.commit([entryAS1]);
  const blocksAS1 = await engineAS1.getDayBlocks();
  const hashAS1 = blocksAS1[0].entries[0].data.content_hash;

  const storeAS2 = new MemoryBackend();
  const engineAS2 = new LedgerEngine(crypto, storeAS2, MASTER_KEY);
  const entryAS2 = makeEntry({
    title: 'Array Sort Test',
    duration: 1000,
    media: [2, 10],
    entry_id: 'as02-0000-4000-a000-000000000083',
  });
  await engineAS2.commit([entryAS2]);
  const blocksAS2 = await engineAS2.getDayBlocks();
  const hashAS2 = blocksAS2[0].entries[0].data.content_hash;

  t.assertEq(hashAS1, hashAS2,
    'array values [10,2] and [2,10] produce same content_hash after sort');

  // ── Decrypt error propagation ────────────────────
  console.log('\n=== Decrypt Error Propagation ===');

  // Test 52: _computeContentHash throws when decrypt fails (no silent fallthrough)
  const throwingCrypto = {
    seal: crypto.seal.bind(crypto),
    verifySeal: crypto.verifySeal.bind(crypto),
    mac: crypto.mac.bind(crypto),
    verifyMac: crypto.verifyMac.bind(crypto),
    sha256: crypto.sha256.bind(crypto),
    encrypt: crypto.encrypt.bind(crypto),
    decrypt: () => { throw new Error('decrypt failed'); },
  };
  const engineThrow = new LedgerEngine(throwingCrypto, new MemoryBackend(), MASTER_KEY);
  t.assertThrows(
    () => engineThrow._computeContentHash({ startTime_enc: 'enc:bad_value', title: 'test' }),
    '_computeContentHash throws when decrypt fails (no silent fallthrough)'
  );

  // ── Input validation ─────────────────────────────
  console.log('\n=== Input Validation ===');

  const storeBad = new MemoryBackend();
  const engineBad = new LedgerEngine(crypto, storeBad, MASTER_KEY);

  // Test 53: commit with missing title throws
  await t.assertAsyncThrows(
    engineBad.commit([{ start_epoch: 1717920000000, duration: 3600000 }]),
    'commit with missing title throws'
  );

  // Test 54: commit with missing start_epoch throws
  await t.assertAsyncThrows(
    engineBad.commit([{ title: 'Test', duration: 3600000 }]),
    'commit with missing start_epoch throws'
  );

  // Test 55: commit with zero start_epoch throws
  await t.assertAsyncThrows(
    engineBad.commit([{ title: 'Test', start_epoch: 0, duration: 3600000 }]),
    'commit with zero start_epoch throws'
  );

  // Test 56: commit with negative start_epoch throws
  await t.assertAsyncThrows(
    engineBad.commit([{ title: 'Test', start_epoch: -1, duration: 3600000 }]),
    'commit with negative start_epoch throws'
  );

  // Test 57: commit with non-string title throws
  await t.assertAsyncThrows(
    engineBad.commit([{ title: 12345, start_epoch: 1717920000000, duration: 3600000 }]),
    'commit with non-string title throws'
  );

  // Test 58: valid entry still commits (regression check)
  const storeValid = new MemoryBackend();
  const engineValid = new LedgerEngine(crypto, storeValid, MASTER_KEY);
  const validEntry = makeEntry({
    title: 'Valid Entry',
    start_epoch: 1717920000000,
    duration: 3600000,
    entry_id: 'valid-0000-4000-a000-000000000090',
  });
  const validResult = await engineValid.commit([validEntry]);
  t.assert(typeof validResult.hashPrefix === 'string', 'valid entry still commits successfully after validation');
}

// ── Summary ─────────────────────────────────────────────────────────
t.summary('LedgerEngine');
process.exit(t.failed > 0 ? 1 : 0);
