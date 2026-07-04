/**
 * ledger_import_chain_test.mjs — Test suite for raw chain import path.
 *
 * Tests _importRawChain() via importLedger() with raw CLI ledger.json format.
 * Covers: genesis detection, block seal verification, prev_hash chain linkage,
 * entry hash validation inside day blocks, mixed block types.
 *
 * Usage:
 *   node test/ledger_import_chain_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { MockCrypto } from './mock_crypto.mjs';
import { jsonSort } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Import the module ───────────────────────────────────────────────
let importLedger;
try {
  const mod = await import('../src/services/ledger_import.js');
  importLedger = mod.importLedger;
} catch (err) {
  t.assert(false, 'importLedger module loads: ' + err.message);
  process.exit(1);
}

const crypto = new MockCrypto();
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// ── Helpers ─────────────────────────────────────────────────────────

/** Build sorted JSON payload excluding hash field and signature. */
function sealPayload(block, hashField) {
  const data = {};
  for (const key of Object.keys(block).sort()) {
    if (key !== hashField && key !== 'signature') {
      data[key] = block[key];
    }
  }
  return jsonSort(data);
}

/** Create a genesis block with valid seal. */
function makeGenesisBlock(overrides = {}) {
  const block = {
    type: 'genesis',
    day_index: 0,
    date: '2026-04-23',
    identity: { username: 'tester', email: 'test@example.com' },
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    entries: [],
    ...overrides,
    day_hash: '', // computed below
  };
  block.day_hash = crypto.seal(sealPayload(block, 'day_hash'), MASTER_KEY);
  return block;
}

/** Create a day block with valid seal and valid entry hashes. */
function makeDayBlock(prevHash, entriesData = [], overrides = {}) {
  const entries = entriesData.map((data, idx) => {
    const entryHash = crypto.sha256(jsonSort(data));
    return { hash: entryHash, data };
  });

  const block = {
    type: 'day',
    day_index: overrides.day_index ?? 1,
    date: '2026-04-24',
    prev_hash: prevHash,
    entries,
    ...overrides,
    day_hash: '', // computed below
  };
  block.day_hash = crypto.seal(sealPayload(block, 'day_hash'), MASTER_KEY);
  return block;
}

/** Create a month_summary block. */
function makeMonthBlock(prevHash, overrides = {}) {
  const block = {
    type: 'month_summary',
    month_index: 0,
    date: '2026-04',
    prev_hash: prevHash,
    ...overrides,
    month_hash: '', // computed below
  };
  block.month_hash = crypto.seal(sealPayload(block, 'month_hash'), MASTER_KEY);
  return block;
}

/** Create a Blob from blocks array. */
function chainBlob(blocks) {
  return new Blob([JSON.stringify(blocks)], { type: 'application/json' });
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 1. Module Loads ===');

t.assert(typeof importLedger === 'function', 'importLedger is a function');

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 2. Basic Chain Import — Genesis + Day ===');

{
  const genesis = makeGenesisBlock();
  const day = makeDayBlock(genesis.day_hash, [
    { title: 'Task 1', duration: 1800 },
    { title: 'Task 2', duration: 3600, tag: 'work' },
  ]);
  const blob = chainBlob([genesis, day]);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assert(typeof result === 'object', 'returns object');
  t.assert(Array.isArray(result.entries), 'entries is array');
  t.assertEq(result.count, 0, 'count = 0 (chain has no staging)');
  t.assertEq(result.formatVersion, 'chain', 'formatVersion = "chain"');
  t.assertEq(result.genesisHash, genesis.day_hash, 'genesisHash = genesis day_hash');
  t.assert(Array.isArray(result.ledger), 'ledger is array');
  t.assertEq(result.ledger.length, 2, 'ledger has 2 blocks');
  t.assertEq(result.ledger[0].type, 'genesis', 'block[0] is genesis');
  t.assertEq(result.ledger[1].type, 'day', 'block[1] is day');
  t.assertDeepEq(result.ledger, [genesis, day], 'ledger blocks match source');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 3. Genesis-Only Chain ===');

{
  const genesis = makeGenesisBlock();
  const blob = chainBlob([genesis]);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.count, 0, 'count = 0');
  t.assertEq(result.formatVersion, 'chain', 'formatVersion = "chain"');
  t.assertEq(result.genesisHash, genesis.day_hash, 'genesisHash correct');
  t.assertDeepEq(result.entries, [], 'entries is []');
  t.assertEq(result.ledger.length, 1, 'ledger has 1 block');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 4. Multi-Block Chain — Genesis + 3 Days ===');

{
  const genesis = makeGenesisBlock();
  let prevHash = genesis.day_hash;
  const days = [];
  for (let i = 0; i < 3; i++) {
    const day = makeDayBlock(prevHash, [{ title: `Day ${i + 1} task`, duration: (i + 1) * 600 }]);
    days.push(day);
    prevHash = day.day_hash;
  }
  const blocks = [genesis, ...days];
  const blob = chainBlob(blocks);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.ledger.length, 4, '4 blocks');
  t.assertDeepEq(result.ledger, blocks, 'all blocks match');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 5. Mixed Block Types — genesis + day + month_summary + day ===');

{
  const genesis = makeGenesisBlock();
  const day1 = makeDayBlock(genesis.day_hash, [
    { title: 'April task', duration: 1800 },
  ]);
  const month = makeMonthBlock(day1.day_hash);
  const day2 = makeDayBlock(month.month_hash, [
    { title: 'May task', duration: 2400 },
  ], { day_index: 2, date: '2026-05-01' });
  const blocks = [genesis, day1, month, day2];
  const blob = chainBlob(blocks);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.ledger.length, 4, '4 blocks with mixed types');
  t.assertEq(result.ledger[2].type, 'month_summary', 'block[2] is month_summary');
  t.assertEq(result.ledger[2].month_hash, month.month_hash, 'month_hash preserved');
  t.assertEq(result.genesisHash, genesis.day_hash, 'genesisHash from genesis block');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 6. Error: Empty Array ===');

{
  const blob = chainBlob([]);
  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects empty chain array'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 7. Error: Missing Genesis Block ===');

{
  const day = makeDayBlock('0000000000000000000000000000000000000000000000000000000000000000', [
    { title: 'Orphan task', duration: 600 },
  ]);
  const blob = chainBlob([day]);

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects chain without genesis block'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 8. Error: Broken prev_hash Chain Linkage ===');

{
  const genesis = makeGenesisBlock();
  // Create day with wrong prev_hash (doesn't point to genesis)
  const day = makeDayBlock('0000000000000000000000000000000000000000000000000000000000000bad', [
    { title: 'Unlinked task', duration: 600 },
  ]);
  const blob = chainBlob([genesis, day]);

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects broken prev_hash linkage'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 9. Error: Tampered Block Seal ===');

{
  const genesis = makeGenesisBlock();
  // Tamper with genesis day_hash
  const tamperedGenesis = { ...genesis, day_hash: 'f'.repeat(64) };
  const day = makeDayBlock(genesis.day_hash, [{ title: 'Task', duration: 600 }]);
  const blob = chainBlob([tamperedGenesis, day]);

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects tampered block seal'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 10. Error: Wrong Master Key → Seal Mismatch ===');

{
  const genesis = makeGenesisBlock();
  const day = makeDayBlock(genesis.day_hash, [{ title: 'Task', duration: 600 }]);
  const blob = chainBlob([genesis, day]);
  const wrongKey = 'a'.repeat(64);

  await t.assertAsyncThrows(
    importLedger(blob, crypto, wrongKey),
    'rejects with wrong master key'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 11. Error: Tampered Entry Hash Inside Day Block ===');

{
  const genesis = makeGenesisBlock();
  // Build day with a bad entry hash
  const goodData = { title: 'Good task', duration: 600 };
  const goodHash = crypto.sha256(jsonSort(goodData));
  const badHash = 'f'.repeat(64);

  const dayBlock = {
    type: 'day',
    day_index: 1,
    date: '2026-04-24',
    prev_hash: genesis.day_hash,
    entries: [
      { hash: goodHash, data: goodData },
      { hash: badHash, data: { title: 'Corrupted', duration: 999 } },
    ],
    day_hash: '', // computed below
  };
  dayBlock.day_hash = crypto.seal(sealPayload(dayBlock, 'day_hash'), MASTER_KEY);

  const blob = chainBlob([genesis, dayBlock]);

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects tampered entry hash inside day block'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 12. Error: Unknown Block Type ===');

{
  const genesis = makeGenesisBlock();
  const weirdBlock = {
    type: 'alien',
    day_index: 1,
    date: '2026-04-24',
    prev_hash: genesis.day_hash,
    entries: [],
    alien_hash: 'f'.repeat(64),
  };
  const blob = chainBlob([genesis, weirdBlock]);

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects unknown block type'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 13. Error: Missing Hash Field on Block ===');

{
  const genesis = makeGenesisBlock();
  const badDay = {
    type: 'day',
    day_index: 1,
    date: '2026-04-24',
    prev_hash: genesis.day_hash,
    entries: [],
    // no day_hash
  };
  const blob = chainBlob([genesis, badDay]);

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects block missing hash field'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 14. Non-Array Input for Chain ===');

{
  // importLedger treats top-level array as chain, but a literal array
  // passed after parsing — let's test a valid-looking object that's not an array
  const obj = { type: 'genesis', fake: true };
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });

  // This should go through the object path and fail on missing format_version,
  // not the chain path
  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'object (not array) treated as export format, not chain'
  );
}

// ═════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════
// Canonical Ledger Format — Phase 2 RED Tests: Group F-js
// ═════════════════════════════════════════════════════════════════

console.log('\n=== 15. Canonical Format: Import Migrated Chain (F2-js) ===');

{
  // Build a new-format chain: genesis has block_hash, no format_version in seal
  const genesisContent = {
    type: 'genesis',
    day_index: 0,
    date: '2026-07-03',
    identity: { username: 'tester', email: 'test@example.com' },
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    entries: [],
  };
  // New format: seal with block_hash
  const sealPayloadNew = (block, hashField) => {
    const data = {};
    for (const key of Object.keys(block).sort()) {
      if (key !== hashField && key !== 'signature') {
        data[key] = block[key];
      }
    }
    return jsonSort(data);
  };
  genesisContent.block_hash = crypto.seal(sealPayloadNew(genesisContent, 'block_hash'), MASTER_KEY);

  const dayContent = {
    type: 'day',
    day_index: 1,
    date: '2026-07-03',
    prev_hash: genesisContent.block_hash,
    entries: [
      {
        hash: crypto.sha256(jsonSort({ title: 'Task', duration: 600 })),
        data: { title: 'Task', duration: 600 },
      },
    ],
  };
  dayContent.day_hash = crypto.seal(sealPayloadNew(dayContent, 'day_hash'), MASTER_KEY);

  const blob = chainBlob([genesisContent, dayContent]);

  // RED: Current import code looks for day_hash on genesis;
  // new format uses block_hash — import may fail to detect genesis hash properly.
  // In GREEN phase, importLedger should support block_hash on genesis.
  let result;
  try {
    result = await importLedger(blob, crypto, MASTER_KEY);
  } catch (err) {
    // In RED phase, this might throw because genesis uses block_hash not day_hash
    result = null;
  }

  if (result) {
    t.assertEq(result.genesisHash, genesisContent.block_hash,
      'F2-js: genesisHash must equal genesis.block_hash (I-17)');
    t.assertEq(result.ledger.length, 2,
      'F2-js: Migrated chain with 2 blocks imports successfully');
  } else {
    // RED phase: import fails because genesis block_hash isn't recognized
    t.assert(false,
      'F2-js: importLedger must accept migrated chain with block_hash on genesis (RED)');
  }
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 16. Canonical Format: Import Old Chain Rejected (F3-js) ===');

{
  // Build a chain where blocks have format_version included in their seal data
  // (old format). After I-07 fix, format_version is excluded from seal check,
  // so the old seal won't verify → import should fail.
  const oldGenesisContent = {
    type: 'genesis',
    format_version: '0.3.0',
    day_index: 0,
    date: '2026-07-03',
    identity: { username: 'tester', email: 'test@example.com' },
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    entries: [],
  };

  // OLD FORMAT: seal includes format_version in check data
  const sealPayloadOld = (block, hashField) => {
    const data = {};
    for (const key of Object.keys(block).sort()) {
      // OLD: only exclude hashField and signature, INCLUDE format_version
      if (key !== hashField && key !== 'signature') {
        data[key] = block[key];
      }
    }
    return jsonSort(data);
  };
  oldGenesisContent.day_hash = crypto.seal(sealPayloadOld(oldGenesisContent, 'day_hash'), MASTER_KEY);

  const oldDayContent = {
    type: 'day',
    format_version: '0.3.0',
    day_index: 1,
    date: '2026-07-03',
    prev_hash: oldGenesisContent.day_hash,
    entries: [
      {
        hash: crypto.sha256(jsonSort({ title: 'Task', duration: 600 })),
        data: { title: 'Task', duration: 600 },
      },
    ],
  };
  oldDayContent.day_hash = crypto.seal(sealPayloadOld(oldDayContent, 'day_hash'), MASTER_KEY);

  const blob = chainBlob([oldGenesisContent, oldDayContent]);

  // RED: Current import code also includes format_version in seal check,
  // so old-format chains with format_version in seal data still pass.
  // In GREEN phase, import should exclude format_version from seal check,
  // causing this old chain to fail verification.
  let threw = false;
  try {
    await importLedger(blob, crypto, MASTER_KEY);
  } catch (err) {
    threw = true;
  }

  t.assert(threw,
    'F3-js: Import must reject pre-migration chain with format_version in seal data (I-07 — RED)');
}

// ═════════════════════════════════════════════════════════════════
const failures = t.summary('ledger_import_chain_test');
process.exit(failures > 0 ? 1 : 0);
