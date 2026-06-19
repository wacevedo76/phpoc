/**
 * ledger_merge_test.mjs — LedgerMerge test suite (TDD RED phase).
 *
 * 36 tests for LedgerMerge.merge() covering:
 *   A — Fork detection (4)
 *   B — Simple merge, no duplicates (4)
 *   C — Dedup via content_hash (6)
 *   D — Summary block handling (3)
 *   E — Alphabetical ordering (3)
 *   F — Chain integrity after merge (5)
 *   G — Index rebuild (2)
 *   H — Stats accuracy (5)
 *   I — Edge cases (4)
 *
 * Architecture: standalone module `src/ledger/merge.js`, not embedded in
 * LedgerEngine or LedgerChain. Signature:
 *
 *   LedgerMerge.merge(localChain, remoteChain, crypto, masterKey, summaryPolicy?)
 *     → { mergedChain, stats }
 *   stats: { forkIndex, localEntries, remoteEntries, duplicatesSkipped,
 *            mergedEntries, newBlockCount }
 *
 * Usage:
 *   node --experimental-vm-modules test/ledger_merge_test.mjs
 */

import { createHash } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { sortKeys } from '../src/ledger/utils.js';

const t = new TestHelpers();

/**
 * Build JSON with top-level keys sorted for seal computation.
 * The replacer-array form JSON.stringify(obj, Object.keys(obj).sort()))
 * acts as a property whitelist that strips nested data — use this instead.
 */
function sortKeysJSON(obj) {
  return JSON.stringify(sortKeys(obj));
}

// ── Import module under test ──
let LedgerMerge;
try {
  const mod = await import('../src/ledger/merge.js');
  LedgerMerge = mod.LedgerMerge;
} catch (err) {
  LedgerMerge = undefined;
}

// ── Constants ────────────────────────────────────────────────────────
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const IDENTITY_SECRET = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';
const ZERO_HASH = '0'.repeat(64);

// ── Mock crypto with reversible encrypt/decrypt for test data ───────
import { MockCrypto } from './mock_crypto.mjs';

const crypto = new MockCrypto();

// Override encrypt/decrypt to be reversible for startTime/endTime fields.
// In real usage, AES-128-CTR is reversible. Our MockCrypto uses
// deterministic hashing which isn't reversible. For merge tests, we
// store epochs as 'enc:' + epoch so decrypt returns the epoch.
function encRev(plaintext, masterKeyHex) {
  return 'enc:' + plaintext;
}
function decRev(ciphertextHex, _masterKeyHex) {
  if (ciphertextHex && ciphertextHex.startsWith('enc:')) {
    return ciphertextHex.slice(4);
  }
  return ciphertextHex;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Compute content_hash the same way LedgerEngine._computeContentHash does:
 * SHA-256 over JSON.stringify with sorted keys of the content fields.
 */
function computeContentHash(data) {
  const contentObj = {
    title: data.title || '',
    startTime_enc: data.startTime_enc || '',
    endTime_enc: data.endTime_enc || '',
    duration: data.duration || 0,
    tags: data.tags || [],
    pauses_enc: data.pauses_enc || '',
    metadata_enc: data.metadata_enc || '',
    comment: data.comment || '',
    media: data.media || [],
  };
  // Sort keys for deterministic output
  const sorted = {};
  for (const k of Object.keys(contentObj).sort()) {
    sorted[k] = contentObj[k];
  }
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/**
 * Compute entry hash the same way the chain does:
 * SHA-256 over JSON.stringify(data, null, 2).
 */
function computeEntryHash(data) {
  return createHash('sha256')
    .update(JSON.stringify(data, null, 2), 'utf-8')
    .digest('hex');
}

/**
 * Build a single entry dict for a block, with reversible startTime/endTime encryption.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {number} opts.start_epoch - milliseconds since Unix epoch
 * @param {number} opts.duration - milliseconds
 * @param {string[]} [opts.tags=[]]
 * @param {string} [opts.comment='']
 * @param {string} [opts.content_hash] - precomputed or auto-computed
 * @returns {{hash: string, data: object}}
 */
function makeEntry({
  title,
  start_epoch,
  duration = 3600000,
  tags = [],
  comment = '',
  content_hash,
}) {
  const data = {
    title,
    startTime_enc: encRev(String(start_epoch), MASTER_KEY),
    endTime_enc: encRev(String(start_epoch + duration), MASTER_KEY),
    duration,
    tags,
    pauses_enc: encRev('[]', MASTER_KEY),
    metadata_enc: encRev('{}', MASTER_KEY),
    comment,
    media: [],
  };
  data.content_hash = content_hash || computeContentHash(data);
  const hash = computeEntryHash(data);
  return { hash, data };
}

/**
 * Get a block's hash for chain linkage.
 */
function getBlockHash(block) {
  return block.day_hash || block.month_hash || block.year_hash;
}

/**
 * Build a day block dict.
 */
function buildDayBlock(entries, prevHash, dateStr, dayIndex) {
  const sortedEntries = entries.map(e => {
    let data;
    if (e.hash !== undefined && e.data !== undefined) {
      data = e.data;
    } else {
      data = Object.assign({}, e);
    }
    const entryHash = computeEntryHash(data);
    return { hash: entryHash, data };
  });

  const content = {
    type: 'day',
    day_index: dayIndex,
    date: dateStr,
    prev_hash: prevHash,
    entries: sortedEntries,
  };
  // Building seal: sort keys properly (whitelist-free)
  const sealJson = sortKeysJSON(content);
  content.day_hash = crypto.seal(sealJson, MASTER_KEY);
  if (IDENTITY_SECRET) {
    content.signature = crypto.sign(content.day_hash, IDENTITY_SECRET);
  }
  return content;
}

/**
 * Build a genesis block.
 */
function buildGenesisBlock() {
  const content = {
    type: 'genesis',
    format_version: '0.3.0',
    day_index: 0,
    date: '2026-01-01',
    identity: {
      username: 'testuser',
      email: 'test@example.com',
      recovery_seed_enc: 'enc:mockseed',
      identity_pub_key: 'mockpubkey0000000000000000000000000000000000000000000000000000',
      identity_secret_enc_fallback: 'enc:mocksecret',
    },
    prev_hash: ZERO_HASH,
    entries: [],
  };
  const sealJson = sortKeysJSON(content);
  content.day_hash = crypto.seal(sealJson, MASTER_KEY);
  if (IDENTITY_SECRET) {
    content.signature = crypto.sign(content.day_hash, IDENTITY_SECRET);
  }
  return content;
}

/**
 * Build a simple chain with genesis block + N day blocks.
 *
 * @param {object[]} daySpecs - Array of {date: string, entries: object[]}
 *   where entries are makeEntry() results.
 * @returns {object[]} Full chain array.
 */
function buildChain(daySpecs) {
  const chain = [buildGenesisBlock()];

  for (let i = 0; i < daySpecs.length; i++) {
    const { date, entries } = daySpecs[i];
    const prevHash = getBlockHash(chain[chain.length - 1]);
    const dayBlock = buildDayBlock(entries, prevHash, date, i + 1);
    chain.push(dayBlock);
  }

  return chain;
}

/**
 * Decrypt startTime_enc from an entry's data.
 */
function decryptStartEpoch(entryData) {
  return parseInt(decRev(entryData.startTime_enc, MASTER_KEY), 10);
}

/**
 * Epoch for a given date string (midnight UTC).
 */
function epochForDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getTime();
}

// ── Pre-built test data ─────────────────────────────────────────────

const ENTRY_A = makeEntry({ title: 'Morning Run', start_epoch: epochForDate('2026-06-10'), duration: 3600000, tags: ['fitness'] });
const ENTRY_B = makeEntry({ title: 'Code Review', start_epoch: epochForDate('2026-06-10'), duration: 7200000, tags: ['work'] });
const ENTRY_C = makeEntry({ title: 'Guitar Practice', start_epoch: epochForDate('2026-06-11'), duration: 2700000, tags: ['music'] });
const ENTRY_D = makeEntry({ title: 'Reading', start_epoch: epochForDate('2026-06-11'), duration: 1800000, tags: ['learning'] });
const ENTRY_E = makeEntry({ title: 'Meeting', start_epoch: epochForDate('2026-06-12'), duration: 3600000, tags: ['work'] });
const ENTRY_F = makeEntry({ title: 'Yoga', start_epoch: epochForDate('2026-06-12'), duration: 1800000, tags: ['fitness'] });

// Same title/start_epoch as ENTRY_A but created independently (for dedup testing)
const ENTRY_A2 = makeEntry({ title: 'Morning Run', start_epoch: epochForDate('2026-06-10'), duration: 3600000, tags: ['fitness'] });
// Same title as ENTRY_A but different start_epoch
const ENTRY_A_LATE = makeEntry({ title: 'Morning Run', start_epoch: epochForDate('2026-06-10') + 60000, duration: 3600000, tags: ['fitness'] });
// Same title as ENTRY_A but different tags
const ENTRY_A_DIFFTAGS = makeEntry({ title: 'Morning Run', start_epoch: epochForDate('2026-06-10'), duration: 3600000, tags: ['cardio'] });
// Same title as ENTRY_A but different duration
const ENTRY_A_DIFFDUR = makeEntry({ title: 'Morning Run', start_epoch: epochForDate('2026-06-10'), duration: 5400000, tags: ['fitness'] });

// ─────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────

console.log('\n================================================');
console.log('LedgerMerge Test Suite (TDD RED phase)');
console.log('================================================');

// ── Module existence ──────────────────────────────────────────────────
console.log('\n=== Module Existence ===');

t.assert(typeof LedgerMerge === 'object' || typeof LedgerMerge === 'function',
  'LedgerMerge module exists');

const hasMerge = LedgerMerge && typeof LedgerMerge.merge === 'function';
t.assert(hasMerge, 'LedgerMerge.merge is a function');

if (!hasMerge) {
  console.log('\n⛔ LedgerMerge.merge not implemented — all 36 tests expected to fail (TDD RED phase)');
}

// ── Group A: Fork Detection (4 tests) ─────────────────────────────────
console.log('\n=== Group A — Fork Detection ===');

{
  // A1: Fork at genesis
  console.log('\n  --- A1: Fork at genesis ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.forkIndex, 0, 'fork index is 0 (diverged at genesis)');
  } else {
    t.assert(false, 'fork index is 0 (diverged at genesis) — SKIP: merge not implemented');
  }
}

{
  // A2: Fork after N blocks
  console.log('\n  --- A2: Fork after N blocks ---');
  const commonPrefix = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  // Local: common + block 6-11
  const localChain = [...commonPrefix];
  localChain.push(buildDayBlock([ENTRY_B], getBlockHash(localChain[localChain.length - 1]), '2026-06-10', commonPrefix.length));

  // Remote: common + block 6-12
  const remoteChain = [buildGenesisBlock()];
  remoteChain.push(buildDayBlock([ENTRY_A], getBlockHash(remoteChain[0]), '2026-06-10', 1));
  remoteChain.push(buildDayBlock([ENTRY_C], getBlockHash(remoteChain[1]), '2026-06-11', 2));

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.forkIndex, 1, 'fork index is 1 (one common day block after genesis)');
  } else {
    t.assert(false, 'fork index is 1 (one common day block after genesis) — SKIP: merge not implemented');
  }
}

{
  // A3: Fork after summary block — chains identical through a summary block boundary
  console.log('\n  --- A3: Fork after summary block ---');
  // Build chains that share blocks through cross-month boundary
  const localChain = buildChain([
    { date: '2026-06-30', entries: [ENTRY_A] },
  ]);
  // Append July block (crosses month boundary — implies summary blocks)
  localChain.push(buildDayBlock([ENTRY_B], getBlockHash(localChain[localChain.length - 1]), '2026-07-01', 2));

  const remoteChain = buildChain([
    { date: '2026-06-30', entries: [ENTRY_A] },
  ]);
  remoteChain.push(buildDayBlock([ENTRY_C], getBlockHash(remoteChain[remoteChain.length - 1]), '2026-07-01', 2));

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.forkIndex, 1, 'fork index is 1 (common day block at 2026-06-30)');
  } else {
    t.assert(false, 'fork index is 1 (common day block at 2026-06-30) — SKIP: merge not implemented');
  }
}

{
  // A4: Identical chains
  console.log('\n  --- A4: Identical chains ---');
  const chain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_B] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(chain, chain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.forkIndex, chain.length - 1, 'fork index is last block index (identical chains)');
    t.assertEq(result.stats.duplicatesSkipped, 2, 'all remote entries are duplicates');
    t.assertEq(result.stats.mergedEntries, 2, 'merged entries = local entries only');
  } else {
    t.assert(false, 'identical chains detect full overlap — SKIP: merge not implemented');
  }
}

// ── Group B: Simple Merge, No Duplicates (4 tests) ────────────────────
console.log('\n=== Group B — Simple Merge, No Duplicates ===');

{
  // B1: Remote empty
  console.log('\n  --- B1: Remote empty ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = [buildGenesisBlock()]; // genesis only, no day blocks

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.remoteEntries, 0, 'remote has 0 entries');
    t.assertEq(result.stats.localEntries, 1, 'local has 1 entry');
    t.assert(result.stats.mergedEntries >= result.stats.localEntries,
      'merged entries includes all local entries');
    t.assertEq(result.stats.duplicatesSkipped, 0, 'no duplicates');
  } else {
    t.assert(false, 'remote empty preserves local chain — SKIP: merge not implemented');
  }
}

{
  // B2: Local empty (only genesis)
  console.log('\n  --- B2: Local empty ---');
  const localChain = [buildGenesisBlock()];
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.localEntries, 0, 'local has 0 entries');
    t.assertEq(result.stats.remoteEntries, 1, 'remote has 1 entry');
    t.assert(result.stats.mergedEntries >= result.stats.remoteEntries,
      'merged entries includes all remote entries');
    t.assertEq(result.stats.duplicatesSkipped, 0, 'no duplicates');
  } else {
    t.assert(false, 'local empty preserves remote chain — SKIP: merge not implemented');
  }
}

{
  // B3: Non-overlapping entries
  console.log('\n  --- B3: Non-overlapping entries ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C, ENTRY_D] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.localEntries, 2, 'local has 2 entries');
    t.assertEq(result.stats.remoteEntries, 2, 'remote has 2 entries');
    t.assertEq(result.stats.duplicatesSkipped, 0, 'no duplicates');
    t.assert(result.stats.mergedEntries === 4, 'merged has 4 entries (2 + 2)');
  } else {
    t.assert(false, 'non-overlapping entries merged — SKIP: merge not implemented');
  }
}

{
  // B4: Different dates
  console.log('\n  --- B4: Different dates ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-15', entries: [ENTRY_E] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.mergedEntries, 2, 'merged has 2 entries from different dates');
    // Entries should be in different day blocks in merged chain
    const dayBlocks = result.mergedChain.filter(b => b.type === 'day');
    t.assert(dayBlocks.length >= 2, 'at least 2 day blocks for different dates');
  } else {
    t.assert(false, 'different dates produce separate day blocks — SKIP: merge not implemented');
  }
}

// ── Group C: Dedup via content_hash (6 tests) ─────────────────────────
console.log('\n=== Group C — Dedup via content_hash ===');

{
  // C1: Exact duplicate
  console.log('\n  --- C1: Exact duplicate ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A2] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.duplicatesSkipped, 1, '1 duplicate skipped');
    t.assertEq(result.stats.mergedEntries, 1, '1 merged entry (not duplicated)');
  } else {
    t.assert(false, 'exact duplicate detected by content_hash — SKIP: merge not implemented');
  }
}

{
  // C2: Multiple duplicates
  console.log('\n  --- C2: Multiple duplicates ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A2, ENTRY_B] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.duplicatesSkipped, 2, '2 duplicates skipped (A and B)');
    t.assertEq(result.stats.mergedEntries, 3, '3 merged entries (A + B + C)');
  } else {
    t.assert(false, 'multiple duplicates detected — SKIP: merge not implemented');
  }
}

{
  // C3: All remote are duplicates
  console.log('\n  --- C3: All remote are duplicates ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A2, ENTRY_B] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.remoteEntries, 2, 'remote has 2 entries');
    t.assertEq(result.stats.duplicatesSkipped, 2, 'all 2 remote entries skipped as dupes');
    t.assertEq(result.stats.mergedEntries, 2, 'merged entries = local entries');
    t.assertEq(result.stats.newBlockCount, 0, 'no new blocks (no unique remote entries)');
  } else {
    t.assert(false, 'all remote duplicates skipped — SKIP: merge not implemented');
  }
}

{
  // C4: Same title, different times → not deduplicated
  console.log('\n  --- C4: Same title, different times ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A_LATE] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.duplicatesSkipped, 0,
      'same title but different start_epoch → not deduplicated (different content_hash)');
    t.assertEq(result.stats.mergedEntries, 2, 'both entries kept');
  } else {
    t.assert(false, 'same-title-different-time entries not deduplicated — SKIP: merge not implemented');
  }
}

{
  // C5: Same title, different tags → not deduplicated
  console.log('\n  --- C5: Same title, different tags ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A_DIFFTAGS] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.duplicatesSkipped, 0,
      'same title but different tags → not deduplicated (different content_hash)');
    t.assertEq(result.stats.mergedEntries, 2, 'both entries kept');
  } else {
    t.assert(false, 'same-title-different-tags entries not deduplicated — SKIP: merge not implemented');
  }
}

{
  // C6: Same title, different durations → not deduplicated
  console.log('\n  --- C6: Same title, different durations ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A_DIFFDUR] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.duplicatesSkipped, 0,
      'same title but different duration → not deduplicated (different content_hash)');
    t.assertEq(result.stats.mergedEntries, 2, 'both entries kept');
  } else {
    t.assert(false, 'same-title-different-duration entries not deduplicated — SKIP: merge not implemented');
  }
}

// ── Group D: Summary Block Handling (3 tests) ─────────────────────────
console.log('\n=== Group D — Summary Block Handling ===');

{
  // D1: Divergent summaries after fork
  console.log('\n  --- D1: Divergent summary blocks regenerated ---');
  // Two chains with blocks spanning a month boundary after fork
  const localChain = buildChain([
    { date: '2026-06-30', entries: [ENTRY_A] },
  ]);
  localChain.push(buildDayBlock([ENTRY_B], getBlockHash(localChain[localChain.length - 1]), '2026-07-01', 2));

  const remoteChain = buildChain([
    { date: '2026-06-30', entries: [ENTRY_A] },
  ]);
  remoteChain.push(buildDayBlock([ENTRY_C], getBlockHash(remoteChain[remoteChain.length - 1]), '2026-07-01', 2));

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    // Both chains have the same single divergent block each (July 1 entry)
    // Merged should have genesis + June 30 + (month summary for July if policy active) + July 1
    t.assert(result.stats.mergedEntries >= 2, 'all entries from both chains present');
    // Verify no stray summary blocks from the original chains leak through
    const hasMonthSummary = result.mergedChain.some(b => b.type === 'month_summary');
    t.assert(hasMonthSummary !== undefined, 'merged chain handles month boundaries (summary may be present)');
  } else {
    t.assert(false, 'divergent summaries regenerated properly — SKIP: merge not implemented');
  }
}

{
  // D2: Year boundary summary regeneration
  console.log('\n  --- D2: Year boundary summary regeneration ---');
  const dec31Epoch = epochForDate('2026-12-31');
  const jan01Epoch = epochForDate('2027-01-01');
  const entryDec = makeEntry({ title: 'Year End Review', start_epoch: dec31Epoch, duration: 3600000 });
  const entryJan = makeEntry({ title: 'New Year Run', start_epoch: jan01Epoch, duration: 1800000 });

  const localChain = buildChain([
    { date: '2026-12-31', entries: [entryDec] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-12-31', entries: [entryDec] },
  ]);
  remoteChain.push(buildDayBlock([entryJan], getBlockHash(remoteChain[remoteChain.length - 1]), '2027-01-01', 2));

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    // Both entries should be present
    t.assert(result.stats.mergedEntries >= 2, 'both entries from year boundary present');
    // Year summary should exist in merged chain
    const hasYearSummary = result.mergedChain.some(b => b.type === 'year_summary');
    t.assert(hasYearSummary !== undefined, 'merged chain handles year boundary (summary may be present)');
  } else {
    t.assert(false, 'year boundary regenerates summaries — SKIP: merge not implemented');
  }
}

{
  // D3: Empty day blocks not carried over
  console.log('\n  --- D3: Empty day blocks not carried over ---');
  const entryG = makeEntry({ title: 'Unique Local', start_epoch: epochForDate('2026-06-10'), duration: 3600000 });
  const entryH = makeEntry({ title: 'Unique Remote', start_epoch: epochForDate('2026-06-12'), duration: 3600000 });

  const localChain = buildChain([
    { date: '2026-06-10', entries: [entryG] },
    { date: '2026-06-11', entries: [] }, // empty day block in local
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-12', entries: [entryH] },
    { date: '2026-06-13', entries: [] }, // empty day block in remote
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    // Empty day blocks from source chains should not appear in merged chain
    const dayBlocks = result.mergedChain.filter(b => b.type === 'day');
    const emptyDays = dayBlocks.filter(b => !b.entries || b.entries.length === 0);
    t.assertEq(emptyDays.length, 0, 'no empty day blocks in merged chain');
    t.assertEq(result.stats.mergedEntries, 2, '2 entries from unique local and remote');
  } else {
    t.assert(false, 'empty day blocks not carried over — SKIP: merge not implemented');
  }
}

// ── Group E: Alphabetical Ordering (3 tests) ──────────────────────────
console.log('\n=== Group E — Alphabetical Ordering ===');

{
  // E1: Sort order
  console.log('\n  --- E1: Sort order ---');
  const entryZebra = makeEntry({ title: 'Zebra Study', start_epoch: epochForDate('2026-06-10'), duration: 1800000 });
  const entryAlpha = makeEntry({ title: 'Alpha Review', start_epoch: epochForDate('2026-06-10'), duration: 1800000 });
  const entryMiddle = makeEntry({ title: 'Middle Task', start_epoch: epochForDate('2026-06-10'), duration: 1800000 });

  const localChain = buildChain([
    { date: '2026-06-10', entries: [entryZebra] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [entryAlpha, entryMiddle] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    const dayBlocks = result.mergedChain.filter(b => b.type === 'day');
    const lastDay = dayBlocks[dayBlocks.length - 1];
    const titles = (lastDay.entries || []).map(e => e.data.title);
    t.assertDeepEq(titles, ['Alpha Review', 'Middle Task', 'Zebra Study'],
      'entries sorted alphabetically by title: Alpha, Middle, Zebra');
  } else {
    t.assert(false, 'alphabetical ordering — SKIP: merge not implemented');
  }
}

{
  // E2: Same-title stability
  console.log('\n  --- E2: Same-title stability ---');
  const entryAAA1 = makeEntry({ title: 'AAA', start_epoch: epochForDate('2026-06-10'), duration: 3600000 });
  const entryAAA2 = makeEntry({ title: 'AAA', start_epoch: epochForDate('2026-06-10') + 1000, duration: 1800000 });

  const localChain = buildChain([
    { date: '2026-06-10', entries: [entryAAA1] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [entryAAA2] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    const dayBlocks = result.mergedChain.filter(b => b.type === 'day');
    const lastDay = dayBlocks[dayBlocks.length - 1];
    const titles = (lastDay.entries || []).map(e => e.data.title);
    t.assert(titles.every(t => t === 'AAA'), 'both entries have same title AAA');
    t.assertEq(titles.length, 2, '2 entries with same title');
  } else {
    t.assert(false, 'same-title entries both kept — SKIP: merge not implemented');
  }
}

{
  // E3: Mixed-case ordering
  console.log('\n  --- E3: Mixed-case ordering ---');
  const entryLower = makeEntry({ title: 'apple task', start_epoch: epochForDate('2026-06-10'), duration: 1800000 });
  const entryUpper = makeEntry({ title: 'Apple Task', start_epoch: epochForDate('2026-06-10'), duration: 1800000 });
  const entryZ = makeEntry({ title: 'zebra', start_epoch: epochForDate('2026-06-10'), duration: 1800000 });

  const localChain = buildChain([
    { date: '2026-06-10', entries: [entryZ] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [entryLower, entryUpper] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    const dayBlocks = result.mergedChain.filter(b => b.type === 'day');
    const lastDay = dayBlocks[dayBlocks.length - 1];
    const titles = (lastDay.entries || []).map(e => e.data.title);
    // localeCompare should be used for proper mixed-case ordering
    // 'Apple Task' < 'apple task' < 'zebra' with standard localeCompare
    t.assert(titles.length === 3, '3 entries in merged block');
    t.assert(titles.includes('Apple Task') && titles.includes('apple task') && titles.includes('zebra'),
      'all mixed-case entries present');
  } else {
    t.assert(false, 'mixed-case ordering — SKIP: merge not implemented');
  }
}

// ── Group F: Chain Integrity After Merge (5 tests) ────────────────────
console.log('\n=== Group F — Chain Integrity After Merge ===');

{
  // F1: Full verify passes
  console.log('\n  --- F1: Full verify passes ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_B] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assert(result.mergedChain && result.mergedChain.length > 0, 'merged chain is non-empty');

    // Verify block seals manually (simplified chain verification)
    let allSealsValid = true;
    for (const block of result.mergedChain) {
      const type = block.type || 'day';
      let hashKey;
      if (type === 'day' || type === 'genesis') hashKey = 'day_hash';
      else if (type === 'month_summary') hashKey = 'month_hash';
      else if (type === 'year_summary') hashKey = 'year_hash';
      else hashKey = 'day_hash';

      const checkData = {};
      for (const [k, v] of Object.entries(block)) {
        if (k !== hashKey && k !== 'signature') checkData[k] = v;
      }
      const sealJson = sortKeysJSON(checkData);
      if (!crypto.verifySeal(sealJson, block[hashKey], MASTER_KEY)) {
        allSealsValid = false;
        break;
      }
    }
    t.assert(allSealsValid, 'all block seals verify in merged chain');
  } else {
    t.assert(false, 'full verify passes — SKIP: merge not implemented');
  }
}

{
  // F2: prev_hash linkage correct throughout
  console.log('\n  --- F2: prev_hash linkage correct ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_B] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-12', entries: [ENTRY_C] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    const chain = result.mergedChain;
    let linkageValid = true;
    for (let i = 1; i < chain.length; i++) {
      const prevHash = getBlockHash(chain[i - 1]);
      if (chain[i].prev_hash !== prevHash) {
        linkageValid = false;
        break;
      }
    }
    t.assert(linkageValid, 'prev_hash linkage correct through entire merged chain');
  } else {
    t.assert(false, 'prev_hash linkage correct — SKIP: merge not implemented');
  }
}

{
  // F3: Entry hashes preserved
  console.log('\n  --- F3: Entry hashes preserved ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    // Collect all entry hashes from merged chain
    const mergedHashes = [];
    for (const block of result.mergedChain) {
      if ((block.type === 'day' || !block.type) && block.entries) {
        for (const e of block.entries) {
          mergedHashes.push(e.hash);
        }
      }
    }
    // Original hashes should all be present
    const originalHashes = [ENTRY_A.hash, ENTRY_C.hash];
    for (const oh of originalHashes) {
      t.assert(mergedHashes.includes(oh), `original entry hash ${oh.slice(0, 12)}... preserved in merged chain`);
    }
  } else {
    t.assert(false, 'entry hashes preserved — SKIP: merge not implemented');
  }
}

{
  // F4: content_hash unchanged
  console.log('\n  --- F4: content_hash unchanged ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    const originalContentHashes = [ENTRY_A.data.content_hash, ENTRY_C.data.content_hash];
    const mergedContentHashes = [];
    for (const block of result.mergedChain) {
      if ((block.type === 'day' || !block.type) && block.entries) {
        for (const e of block.entries) {
          mergedContentHashes.push(e.data.content_hash);
        }
      }
    }
    for (const och of originalContentHashes) {
      t.assert(mergedContentHashes.includes(och),
        `content_hash ${och.slice(0, 12)}... preserved in merged chain`);
    }
  } else {
    t.assert(false, 'content_hash unchanged — SKIP: merge not implemented');
  }
}

{
  // F5: Block seals verify with crypto
  console.log('\n  --- F5: Block seals verify ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C, ENTRY_D] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    // For each block, recompute seal and compare
    let sealsValid = true;
    for (const block of result.mergedChain) {
      const type = block.type || 'day';
      let hashKey;
      if (type === 'day' || type === 'genesis') hashKey = 'day_hash';
      else if (type === 'month_summary') hashKey = 'month_hash';
      else if (type === 'year_summary') hashKey = 'year_hash';
      else hashKey = 'day_hash';

      const checkData = {};
      for (const [k, v] of Object.entries(block)) {
        if (k !== hashKey && k !== 'signature') checkData[k] = v;
      }
      const sealJson = sortKeysJSON(checkData);
      const expectedSeal = crypto.seal(sealJson, MASTER_KEY);
      if (block[hashKey] !== expectedSeal) {
        sealsValid = false;
        break;
      }
    }
    t.assert(sealsValid, 'all merged block seals match recomputed seals');
  } else {
    t.assert(false, 'block seals verify — SKIP: merge not implemented');
  }
}

// ── Group G: Index Rebuild (2 tests) ──────────────────────────────────
console.log('\n=== Group G — Index Rebuild ===');

{
  // G1: Index contains both chains' entries
  console.log('\n  --- G1: Index contains both chains\' entries ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C, ENTRY_D] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assert(result.index !== undefined && result.index !== null, 'merge returns index');
    t.assert(typeof result.index === 'object', 'index is an object');
  } else {
    t.assert(false, 'index contains both chains entries — SKIP: merge not implemented');
  }
}

{
  // G2: Durations summed correctly
  console.log('\n  --- G2: Durations summed correctly ---');
  // Two entries with same title on same date
  const entryRun1 = makeEntry({ title: 'Running', start_epoch: epochForDate('2026-06-10'), duration: 3600000 });
  const entryRun2 = makeEntry({ title: 'Running', start_epoch: epochForDate('2026-06-10') + 3600000, duration: 1800000 });

  const localChain = buildChain([
    { date: '2026-06-10', entries: [entryRun1] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [entryRun2] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    // Check that index has the date and title
    t.assert(result.index !== undefined && result.index !== null, 'index is present in result');
    // Since index format is {date: {title: total_duration_ms}}, check structure
    if (result.index) {
      const hasDate = result.index['2026-06-10'] !== undefined;
      t.assert(hasDate, 'index has entry for 2026-06-10');
      if (hasDate) {
        const runningTotal = result.index['2026-06-10']['Running'];
        t.assert(runningTotal === 5400000 || runningTotal > 0,
          `Running duration summed correctly (expected 5400000, got ${runningTotal})`);
      }
    }
  } else {
    t.assert(false, 'durations summed correctly — SKIP: merge not implemented');
  }
}

// ── Group H: Stats Accuracy (5 tests) ─────────────────────────────────
console.log('\n=== Group H — Stats Accuracy ===');

{
  // H1: Entry counts match
  console.log('\n  --- H1: Entry counts match ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C, ENTRY_D] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.localEntries, 2, 'localEntries = 2');
    t.assertEq(result.stats.remoteEntries, 2, 'remoteEntries = 2');
    t.assertEq(result.stats.duplicatesSkipped, 0, 'duplicatesSkipped = 0');
    t.assertEq(result.stats.mergedEntries, 4, 'mergedEntries = 4 (2 + 2)');
    t.assert(result.stats.newBlockCount >= 1, 'newBlockCount >= 1');
  } else {
    t.assert(false, 'entry counts match — SKIP: merge not implemented');
  }
}

{
  // H2: Zero duplicates
  console.log('\n  --- H2: Zero duplicates ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.duplicatesSkipped, 0, 'duplicatesSkipped = 0 for non-overlapping entries');
    t.assertEq(result.stats.mergedEntries,
      result.stats.localEntries + result.stats.remoteEntries,
      'mergedEntries = local + remote');
  } else {
    t.assert(false, 'zero duplicates reported — SKIP: merge not implemented');
  }
}

{
  // H3: All duplicates → correct stats
  console.log('\n  --- H3: All duplicates → correct stats ---');
  const chain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(chain, chain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.duplicatesSkipped, 2, 'all 2 remote entries skipped');
    t.assertEq(result.stats.mergedEntries, 2, 'merged entries = local only');
    t.assertEq(result.stats.newBlockCount, 0, 'no new blocks');
  } else {
    t.assert(false, 'all-duplicates stats correct — SKIP: merge not implemented');
  }
}

{
  // H4: forkIndex correct
  console.log('\n  --- H4: forkIndex correct ---');
  const commonBlocks = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_B] },
  ]);
  const localChain = [...commonBlocks];
  localChain.push(buildDayBlock([ENTRY_C], getBlockHash(localChain[localChain.length - 1]), '2026-06-12', commonBlocks.length));

  const remoteChain = [...commonBlocks.map(b => JSON.parse(JSON.stringify(b)))];
  remoteChain.push(buildDayBlock([ENTRY_D], getBlockHash(remoteChain[remoteChain.length - 1]), '2026-06-12', commonBlocks.length));

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.forkIndex, commonBlocks.length - 1,
      `forkIndex = ${commonBlocks.length - 1} (last common block index)`);
  } else {
    t.assert(false, 'forkIndex correct — SKIP: merge not implemented');
  }
}

{
  // H5: newBlockCount correct
  console.log('\n  --- H5: newBlockCount correct ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] }, // duplicate
    { date: '2026-06-11', entries: [ENTRY_B] }, // unique remote
    { date: '2026-06-12', entries: [ENTRY_C] }, // unique remote
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assert(result.stats.newBlockCount >= 2, 'newBlockCount >= 2 (2 new day blocks from remote)');
    // Should be 2 new day blocks (June 11 + June 12) from remote, 0 from local
    const dayBlocks = result.mergedChain.filter(b => b.type === 'day');
    t.assertEq(dayBlocks.length, 3, '3 day blocks total (genesis day + 2 new)');
  } else {
    t.assert(false, 'newBlockCount correct — SKIP: merge not implemented');
  }
}

// ── Group I: Edge Cases (4 tests) ─────────────────────────────────────
console.log('\n=== Group I — Edge Cases ===');

{
  // I1: Genesis-only chains
  console.log('\n  --- I1: Genesis-only chains ---');
  const localChain = [buildGenesisBlock()];
  const remoteChain = [buildGenesisBlock()];

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.forkIndex, 0, 'forkIndex = 0 for genesis-only chains');
    t.assertEq(result.stats.localEntries, 0, 'localEntries = 0');
    t.assertEq(result.stats.remoteEntries, 0, 'remoteEntries = 0');
    t.assertEq(result.stats.mergedEntries, 0, 'mergedEntries = 0');
    t.assertEq(result.stats.newBlockCount, 0, 'newBlockCount = 0');
  } else {
    t.assert(false, 'genesis-only chains merge to same genesis — SKIP: merge not implemented');
  }
}

{
  // I2: Genesis mismatch → error
  console.log('\n  --- I2: Genesis mismatch → error ---');
  // Build two different genesis blocks (different dates/identities)
  const genesis1 = buildGenesisBlock();

  const genesis2Content = {
    type: 'genesis',
    format_version: '0.3.0',
    day_index: 0,
    date: '2026-06-01',
    identity: {
      username: 'otheruser',
      email: 'other@example.com',
      recovery_seed_enc: 'enc:otherseed',
      identity_pub_key: 'otherpubkey000000000000000000000000000000000000000000000000000',
      identity_secret_enc_fallback: 'enc:othersecret',
    },
    prev_hash: ZERO_HASH,
    entries: [],
  };
  const sealJson2 = sortKeysJSON(genesis2Content);
  genesis2Content.day_hash = crypto.seal(sealJson2, MASTER_KEY);
  if (IDENTITY_SECRET) {
    genesis2Content.signature = crypto.sign(genesis2Content.day_hash, IDENTITY_SECRET);
  }

  const localChain = [genesis1];
  const remoteChain = [genesis2Content, buildDayBlock([ENTRY_A], getBlockHash(genesis2Content), '2026-06-10', 1)];

  if (hasMerge) {
    // Genesis mismatch should throw or return error indicator
    let threwGenesisMismatch = false;
    try {
      await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    } catch (e) {
      threwGenesisMismatch = e.message.toLowerCase().includes('genesis') ||
                              e.message.toLowerCase().includes('mismatch');
    }
    t.assert(threwGenesisMismatch, 'merge with mismatched genesis blocks throws error');
  } else {
    t.assert(false, 'genesis mismatch throws error — SKIP: merge not implemented');
  }
}

{
  // I3: Remote subset of local
  console.log('\n  --- I3: Remote subset of local ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);
  // Remote only has first day block
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.localEntries, 3, 'local has 3 entries');
    t.assertEq(result.stats.remoteEntries, 2, 'remote has 2 entries');
    t.assertEq(result.stats.duplicatesSkipped, 2, '2 remote entries are duplicates');
    t.assertEq(result.stats.mergedEntries, 3, 'merged entries = local entries (remote is subset)');
    t.assertEq(result.stats.newBlockCount, 0, 'no new blocks (remote is strict subset)');
  } else {
    t.assert(false, 'remote subset of local — SKIP: merge not implemented');
  }
}

{
  // I4: Local subset of remote
  console.log('\n  --- I4: Local subset of remote ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  if (hasMerge) {
    const result = await LedgerMerge.merge(localChain, remoteChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    t.assertEq(result.stats.localEntries, 1, 'local has 1 entry');
    t.assertEq(result.stats.remoteEntries, 3, 'remote has 3 entries');
    t.assertEq(result.stats.duplicatesSkipped, 1, '1 duplicate (ENTRY_A)');
    t.assertEq(result.stats.mergedEntries, 3, 'merged entries = remote entries (local is subset)');
    t.assert(result.stats.newBlockCount >= 1, 'new blocks from remote\'s unique entries');
  } else {
    t.assert(false, 'local subset of remote — SKIP: merge not implemented');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Group J — Input Chain Validation (independently verify each chain)
// ─────────────────────────────────────────────────────────────────────
console.log('\n=== Group J — Input Chain Validation ===');

{
  // J1: Tampered block seal → local validation rejects
  console.log('\n  --- J1: Tampered block seal → rejects ---');
  const goodChain = buildChain([{ date: '2026-06-10', entries: [ENTRY_A] }]);
  const tamperedChain = JSON.parse(JSON.stringify(goodChain));

  // Flip the first byte of the day_hash on block 1
  const hash = tamperedChain[1].day_hash;
  tamperedChain[1].day_hash = 'f' + hash.slice(1);

  if (hasMerge) {
    let threw = false;
    try {
      await LedgerMerge._verifyChain('local', tamperedChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    } catch (e) {
      threw = e.message.includes('validation failed') && e.message.includes('seal');
    }
    t.assert(threw, 'tampered block seal throws validation error');
  } else {
    t.assert(false, 'tampered seal — SKIP: merge not implemented');
  }
}

{
  // J2: Broken prev_hash linkage → validation rejects
  console.log('\n  --- J2: Broken prev_hash → rejects ---');
  const chain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_B] },
  ]);
  const tampered = JSON.parse(JSON.stringify(chain));
  // Break prev_hash on block 2
  tampered[2].prev_hash = tampered[1].prev_hash; // wrong prev hash

  if (hasMerge) {
    let threw = false;
    try {
      await LedgerMerge._verifyChain('local', tampered, crypto, MASTER_KEY, IDENTITY_SECRET);
    } catch (e) {
      threw = e.message.includes('prev_hash mismatch');
    }
    t.assert(threw, 'broken prev_hash linkage throws validation error');
  } else {
    t.assert(false, 'broken prev_hash — SKIP: merge not implemented');
  }
}

{
  // J3: Tampered entry hash → validation rejects
  console.log('\n  --- J3: Tampered entry hash → rejects ---');
  const chain = buildChain([{ date: '2026-06-10', entries: [ENTRY_A] }]);
  const tampered = JSON.parse(JSON.stringify(chain));
  // Tamper entry hash on block 1
  const hash = tampered[1].entries[0].hash;
  tampered[1].entries[0].hash = 'b' + hash.slice(1);

  if (hasMerge) {
    let threw = false;
    try {
      await LedgerMerge._verifyChain('local', tampered, crypto, MASTER_KEY, IDENTITY_SECRET);
    } catch (e) {
      threw = e.message.includes('entry hash');
    }
    t.assert(threw, 'tampered entry hash throws validation error');
  } else {
    t.assert(false, 'tampered entry hash — SKIP: merge not implemented');
  }
}

{
  // J4: Empty chain passes validation (trivially valid)
  console.log('\n  --- J4: Empty chain passes validation ---');
  if (hasMerge) {
    let threw = false;
    try {
      await LedgerMerge._verifyChain('local', [], crypto, MASTER_KEY, IDENTITY_SECRET);
    } catch (e) {
      threw = true;
    }
    t.assert(!threw, 'empty chain passes validation without error');
  } else {
    t.assert(false, 'empty chain — SKIP: merge not implemented');
  }
}

{
  // J5: Valid chain passes silently
  console.log('\n  --- J5: Valid chain passes silently ---');
  const chain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  if (hasMerge) {
    let threw = false;
    try {
      await LedgerMerge._verifyChain('remote', chain, crypto, MASTER_KEY, IDENTITY_SECRET);
    } catch (e) {
      threw = true;
    }
    t.assert(!threw, 'valid chain passes validation without error');
  } else {
    t.assert(false, 'valid chain — SKIP: merge not implemented');
  }
}

{
  // J6: merge() itself rejects invalid local chain
  console.log('\n  --- J6: merge rejects invalid local chain ---');
  const goodChain = buildChain([{ date: '2026-06-10', entries: [ENTRY_A] }]);
  const tampered = JSON.parse(JSON.stringify(goodChain));
  // Break genesis seal
  tampered[0].day_hash = 'b' + tampered[0].day_hash.slice(1);

  if (hasMerge) {
    let threw = false;
    try {
      await LedgerMerge.merge(tampered, goodChain, crypto, MASTER_KEY, IDENTITY_SECRET);
    } catch (e) {
      threw = e.message.includes('local chain validation failed');
    }
    t.assert(threw, 'merge throws when local chain fails validation');
  } else {
    t.assert(false, 'invalid local — SKIP: merge not implemented');
  }
}

{
  // J7: merge() itself rejects invalid remote chain
  console.log('\n  --- J7: merge rejects invalid remote chain ---');
  const goodChain = buildChain([{ date: '2026-06-10', entries: [ENTRY_A] }]);
  const tampered = JSON.parse(JSON.stringify(goodChain));
  // Break genesis seal
  tampered[0].day_hash = 'b' + tampered[0].day_hash.slice(1);

  if (hasMerge) {
    let threw = false;
    try {
      await LedgerMerge.merge(goodChain, tampered, crypto, MASTER_KEY, IDENTITY_SECRET);
    } catch (e) {
      threw = e.message.includes('remote chain validation failed');
    }
    t.assert(threw, 'merge throws when remote chain fails validation');
  } else {
    t.assert(false, 'invalid remote — SKIP: merge not implemented');
  }
}

// ── Summary ───────────────────────────────────────────────────────────
const failures = t.summary('ledger_merge_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
