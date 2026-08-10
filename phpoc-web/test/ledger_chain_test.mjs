/**
 * ledger_chain_test.mjs — LedgerChain test suite.
 *
 * Tests block-level chain operations: building day blocks,
 * seal/sign helpers, append/truncate, chain verification.
 *
 * Option B: consumes StorageBackend (MemoryBackend) directly
 * via key convention "ledger:blocks".
 *
 * Usage:
 *   node test/ledger_chain_test.mjs
 */

import { createHash } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';
import { MockCrypto } from './mock_crypto.mjs';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort, jsonSortIndent2, verifyEntryHash } from '../src/ledger/utils.js';
import { selectSealFields } from '../src/ledger/seal_fields.js';

const t = new TestHelpers();

// ── Import module under test ──
let LedgerChain;
try {
  const mod = await import('../src/ledger/chain.js');
  LedgerChain = mod.LedgerChain;
} catch (err) {
  LedgerChain = undefined;
}

// ── Sample data ─────────────────────────────────────────────────────
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const IDENTITY_SECRET = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';
const crypto = new MockCrypto();

const SAMPLE_ENTRY_DATA_1 = {
  title: 'Morning Run',
  startTime_enc: crypto.encrypt('1717920000000', MASTER_KEY),
  endTime_enc: crypto.encrypt('1717923600000', MASTER_KEY),
  duration: 3600000,
  tags: ['fitness'],
  pauses_enc: crypto.encrypt('[]', MASTER_KEY),
  metadata_enc: crypto.encrypt('{}', MASTER_KEY),
  comment: '',
  media: [],
  content_hash: '',
};
SAMPLE_ENTRY_DATA_1.content_hash = crypto.sha256(
  JSON.stringify({
    title: SAMPLE_ENTRY_DATA_1.title,
    startTime_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_1.startTime_enc, MASTER_KEY),
    endTime_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_1.endTime_enc, MASTER_KEY),
    duration: SAMPLE_ENTRY_DATA_1.duration,
    tags: [...SAMPLE_ENTRY_DATA_1.tags].sort(),
    pauses_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_1.pauses_enc, MASTER_KEY),
    metadata_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_1.metadata_enc, MASTER_KEY),
    comment: SAMPLE_ENTRY_DATA_1.comment,
    media: [...SAMPLE_ENTRY_DATA_1.media].sort(),
  }, null, 2)
);

const SAMPLE_ENTRY_DATA_2 = {
  title: 'Deep Work',
  startTime_enc: crypto.encrypt('1717930800000', MASTER_KEY),
  endTime_enc: crypto.encrypt('1717938000000', MASTER_KEY),
  duration: 7200000,
  tags: ['work', 'focus'],
  pauses_enc: crypto.encrypt('[]', MASTER_KEY),
  metadata_enc: crypto.encrypt('{"project":"X"}', MASTER_KEY),
  comment: 'Finished feature',
  media: [],
  content_hash: '',
};
SAMPLE_ENTRY_DATA_2.content_hash = crypto.sha256(
  JSON.stringify({
    title: SAMPLE_ENTRY_DATA_2.title,
    startTime_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_2.startTime_enc, MASTER_KEY),
    endTime_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_2.endTime_enc, MASTER_KEY),
    duration: SAMPLE_ENTRY_DATA_2.duration,
    tags: [...SAMPLE_ENTRY_DATA_2.tags].sort(),
    pauses_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_2.pauses_enc, MASTER_KEY),
    metadata_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_2.metadata_enc, MASTER_KEY),
    comment: SAMPLE_ENTRY_DATA_2.comment,
    media: [...SAMPLE_ENTRY_DATA_2.media].sort(),
  }, null, 2)
);

function makeEmptyStore() {
  return new MemoryBackend();
}

function entryHash(data) {
  return createHash('sha256').update(jsonSortIndent2(data), 'utf-8').digest('hex');
}

// ─────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────
console.log('\n=== LedgerChain Class Exists ===');

t.assert(typeof LedgerChain === 'function', 'LedgerChain is a constructor');

if (typeof LedgerChain === 'function') {
  // ── Constructor ────────────────────────────────────
  console.log('\n=== Constructor & Empty State ===');

  const store = new MemoryBackend();
  const chain = new LedgerChain(crypto, store, MASTER_KEY);

  t.assert(chain instanceof LedgerChain, 'creates instance with minimum args');

  const chainWithIdentity = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);
  t.assert(chainWithIdentity instanceof LedgerChain, 'creates instance with identity secret');

  // Test 1: Empty chain state
  t.assertEq(await chain.getBlockCount(), 0, 'empty chain has 0 blocks');
  t.assertEq(await chain.getLastBlock(), null, 'empty chain last block is null');
  t.assertDeepEq(await chain.readAll(), [], 'readAll on empty chain returns []');

  // Test 2: Negative index on empty chain returns null
  t.assertEq(await chain.getBlock(-1), null, 'getBlock(-1) on empty returns null');

  // ── Seal / Sign helpers ────────────────────────────
  console.log('\n=== Seal / Sign Helpers ===');

  const testData = { type: 'day', date: '2026-01-15' };

  // Test 3: computeSeal produces deterministic HMAC-like output
  const seal1 = chain.computeSeal(testData);
  t.assert(typeof seal1 === 'string', 'computeSeal returns a string');
  t.assert(/^[0-9a-f]{64}$/.test(seal1), 'seal is 64 hex chars');

  // Test 4: Same data + same key → same seal
  const seal2 = chain.computeSeal(testData);
  t.assertEq(seal1, seal2, 'seal is deterministic');

  // Test 5: Different data → different seal
  const seal3 = chain.computeSeal({ type: 'month_summary', month: '2026-01' });
  t.assertNeq(seal1, seal3, 'different data produces different seal');

  // Test 6: verifySeal passes for valid seal
  t.assert(chain.verifySeal(testData, seal1), 'verifySeal returns true for valid seal');

  // Test 7: verifySeal fails for tampered data
  t.assert(!chain.verifySeal({ type: 'tampered' }, seal1), 'verifySeal returns false for tampered data');

  // Test 8: computeSignature with identity secret
  const sig = chain.computeIdentityMac(seal1);
  if (IDENTITY_SECRET) {
    t.assert(typeof sig === 'string', 'computeSignature returns a string with identity secret');
    t.assert(/^[0-9a-f]{64}$/.test(sig), 'signature is 64 hex chars');
  }

  // Test 9: verifySignature
  if (sig && IDENTITY_SECRET) {
    t.assert(chain.verifyIdentityMac(seal1, sig), 'verifySignature returns true for valid signature');
    t.assert(!chain.verifyIdentityMac(seal1 + 'x', sig), 'verifySignature returns false for bad data');
    t.assert(!chain.verifyIdentityMac(seal1, sig + 'x'), 'verifySignature returns false for bad signature');
  }

  // ── Block building: buildDayBlock ──────────────────
  console.log('\n=== Block Building: buildDayBlock ===');

  // Test 10: Build a day block on empty chain (no prev_hash)
  const entries = [
    { data: SAMPLE_ENTRY_DATA_1, hash: entryHash(SAMPLE_ENTRY_DATA_1) }
  ];
  const ZERO_HASH = '0'.repeat(64);
  const block1 = await chain.buildDayBlock(entries, ZERO_HASH, '2026-01-15');

  t.assert(typeof block1 === 'object', 'await buildDayBlock returns an object');
  t.assertHasKeys(block1, ['type', 'day_index', 'date', 'prev_hash', 'entries', 'day_hash'], 'block has all required keys');

  // Test 11: Block structure
  t.assertEq(block1.type, 'day', 'block type is "day"');
  t.assertEq(block1.day_index, 1, 'first block has day_index 1');
  t.assertEq(block1.date, '2026-01-15', 'date matches input');
  t.assertEq(block1.prev_hash, ZERO_HASH, 'prev_hash matches input');
  t.assert(Array.isArray(block1.entries), 'entries is an array');
  t.assertEq(block1.entries.length, 1, 'entries length matches input');
  t.assert(typeof block1.day_hash === 'string', 'day_hash is a string');
  t.assert(/^[0-9a-f]{64}$/.test(block1.day_hash), 'day_hash is 64 hex chars');

  // Test 12: Entry hash in built block
  t.assertEq(block1.entries[0].hash, entryHash(SAMPLE_ENTRY_DATA_1), 'entry hash is correct SHA-256 of data');

  // Test 13: Entry data is preserved
  t.assertDeepEq(block1.entries[0].data, SAMPLE_ENTRY_DATA_1, 'entry data is preserved');

  // Test 14: Day index increments when chain has existing day blocks
  await chain.append(block1);
  const entries2 = [
    { data: SAMPLE_ENTRY_DATA_2, hash: entryHash(SAMPLE_ENTRY_DATA_2) }
  ];
  const block2 = await chain.buildDayBlock(entries2, ZERO_HASH, '2026-01-16');
  t.assertEq(block2.day_index, 2, 'second block has day_index 2');

  // Test 15: Day block with pre-hashed entries accepts {"hash", "data"} format
  const blockWithPrehashed = await chain.buildDayBlock(
    [{ hash: 'a'.repeat(64), data: SAMPLE_ENTRY_DATA_1 }],
    ZERO_HASH,
    '2026-01-17'
  );
  t.assertEq(blockWithPrehashed.entries[0].hash, entryHash(SAMPLE_ENTRY_DATA_1),
    'block recomputes hash from data even when pre-hashed entry provided');

  // Test 16: Day block with raw dict (no hash key) accepts bare data
  const blockWithRaw = await chain.buildDayBlock(
    [SAMPLE_ENTRY_DATA_1],
    ZERO_HASH,
    '2026-01-18'
  );
  t.assertEq(blockWithRaw.entries[0].hash, entryHash(SAMPLE_ENTRY_DATA_1),
    'block accepts raw dict and computes hash');

  // Test 17: Day block with optional identity signature
  const chainWithSig = new LedgerChain(crypto, makeEmptyStore(), MASTER_KEY, IDENTITY_SECRET);
  const sigBlock = await chainWithSig.buildDayBlock(entries, ZERO_HASH, '2026-01-15');
  t.assertHasKeys(sigBlock, ['identity_seal'], 'block with identity secret includes identity_seal');
  t.assert(/^[0-9a-f]{64}$/.test(sigBlock.identity_seal), 'identity_seal is 64 hex chars');

  // ── Append operations ──────────────────────────────
  console.log('\n=== Append Operations ===');

  const store2 = makeEmptyStore();
  const chain2 = new LedgerChain(crypto, store2, MASTER_KEY);

  // Test 18: append single block increases count
  await chain2.append(block1);
  t.assertEq(await chain2.getBlockCount(), 1, 'append increases count to 1');
  t.assertDeepEq(await chain2.readAll(), [block1], 'readAll returns the appended block');

  // Test 19: getLastBlock after append
  const last = await chain2.getLastBlock();
  t.assertDeepEq(last, block1, 'getLastBlock returns the appended block');

  // Test 20: getBlock by index
  const fetched = await chain2.getBlock(0);
  t.assertDeepEq(fetched, block1, 'getBlock(0) returns the first block');

  // Test 21: getBlock with negative index
  t.assertDeepEq(await chain2.getBlock(-1), block1, 'getBlock(-1) returns last block');

  // Test 22: appendBlocks with valid linkage
  const store3 = makeEmptyStore();
  const chain3 = new LedgerChain(crypto, store3, MASTER_KEY);
  await chain3.append(block1);
  const block2linked = await chain3.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  await chain3.appendBlocks([block2linked]);
  t.assertEq(await chain3.getBlockCount(), 2, 'appendBlocks with valid linkage succeeds');

  // Test 23: appendBlocks with multiple blocks
  const block3linked = await chain3.buildDayBlock(entries, block2linked.day_hash, '2026-01-17');
  const block4linked = await chain3.buildDayBlock(entries2, block3linked.day_hash, '2026-01-18');
  await chain3.appendBlocks([block3linked, block4linked]);
  t.assertEq(await chain3.getBlockCount(), 4, 'appendBlocks with multiple blocks works');

  // ── Linkage rejection ──────────────────────────────
  console.log('\n=== Linkage Verification (Rejection) ===');

  // Test 24: appendBlocks rejects block with wrong prev_hash against chain
  const store4 = makeEmptyStore();
  const chain4 = new LedgerChain(crypto, store4, MASTER_KEY);
  await chain4.append(block1);
  const badBlock = await chain4.buildDayBlock(entries, '1234'.repeat(16), '2026-01-16');
  await t.assertAsyncThrows(
    chain4.appendBlocks([badBlock]),
    'appendBlocks rejects block with mismatched prev_hash'
  );

  // Test 25: appendBlocks rejects internal linkage violation among new blocks
  const store5 = makeEmptyStore();
  const chain5 = new LedgerChain(crypto, store5, MASTER_KEY);
  await chain5.append(block1);
  const goodBlock = await chain5.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  const badInternal = await chain5.buildDayBlock(entries, 'ffff'.repeat(16), '2026-01-17');
  await t.assertAsyncThrows(
    chain5.appendBlocks([goodBlock, badInternal]),
    'appendBlocks rejects internal linkage violation among new blocks'
  );

  // ── Truncation ─────────────────────────────────────
  console.log('\n=== Truncation ===');

  const store6 = makeEmptyStore();
  const chain6 = new LedgerChain(crypto, store6, MASTER_KEY);
  await chain6.append(block1);
  const b2 = await chain6.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  await chain6.append(b2);
  const b3 = await chain6.buildDayBlock(entries, b2.day_hash, '2026-01-17');
  await chain6.append(b3);
  const b4 = await chain6.buildDayBlock(entries2, b3.day_hash, '2026-01-18');
  await chain6.append(b4);
  t.assertEq(await chain6.getBlockCount(), 4, 'setup: 4 blocks in chain');

  // Test 26: truncate removes N blocks from end
  const removed = await chain6.truncate(2);
  t.assertEq(removed.length, 2, 'truncate(2) returns 2 removed blocks');
  t.assertEq(await chain6.getBlockCount(), 2, 'truncate(2) leaves 2 blocks');
  t.assertDeepEq(removed[0], b3, 'first removed block is block index 2');
  t.assertDeepEq(removed[1], b4, 'second removed block is block index 3');

  // Test 27: truncate preserves genesis
  const store7 = makeEmptyStore();
  const chain7 = new LedgerChain(crypto, store7, MASTER_KEY);
  await chain7.append(block1);
  const genesisRemoved = await chain7.truncate(5);
  t.assertEq(genesisRemoved.length, 0, 'truncate cannot remove genesis block');
  t.assertEq(await chain7.getBlockCount(), 1, 'genesis block preserved');

  // Test 28: truncate with 0 removes nothing
  const store7b = makeEmptyStore();
  const chain7b = new LedgerChain(crypto, store7b, MASTER_KEY);
  await chain7b.append(block1);
  await chain7b.append(b2);
  const removed0 = await chain7b.truncate(0);
  t.assertEq(removed0.length, 0, 'truncate(0) removes nothing');
  t.assertEq(await chain7b.getBlockCount(), 2, 'truncate(0) keeps all blocks');

  // Test 29: truncate_keep preserves first N blocks
  const store8 = makeEmptyStore();
  const chain8 = new LedgerChain(crypto, store8, MASTER_KEY);
  await chain8.append(block1);
  await chain8.append(b2);
  await chain8.append(b3);
  await chain8.append(b4);
  const keepRemoved = await chain8.truncate_keep(2);
  t.assertEq(keepRemoved.length, 2, 'truncate_keep(2) removes 2 blocks');
  t.assertEq(await chain8.getBlockCount(), 2, 'truncate_keep(2) keeps 2 blocks');

  // Test 30: truncate_keep with count >= total removes nothing
  const store9 = makeEmptyStore();
  const chain9 = new LedgerChain(crypto, store9, MASTER_KEY);
  await chain9.append(block1);
  await chain9.append(b2);
  const keepAll = await chain9.truncate_keep(10);
  t.assertEq(keepAll.length, 0, 'truncate_keep with keep>=total removes nothing');
  t.assertEq(await chain9.getBlockCount(), 2, 'all blocks preserved');

  // ── Chain Verification ─────────────────────────────
  console.log('\n=== Chain Verification ===');

  // Test 31: verify returns true for valid chain
  const storeV = makeEmptyStore();
  const chainV = new LedgerChain(crypto, storeV, MASTER_KEY);
  await chainV.append(block1);
  const b2v = await chainV.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  await chainV.append(b2v);
  const b3v = await chainV.buildDayBlock(entries, b2v.day_hash, '2026-01-17');
  await chainV.append(b3v);
  t.assert(await chainV.verify(), 'verify() returns true for valid chain');

  // Test 32: verify returns false when a block seal is broken
  const storeTamper = makeEmptyStore();
  const chainTamper = new LedgerChain(crypto, storeTamper, MASTER_KEY);
  const blockForTamper = await chainTamper.buildDayBlock(entries, ZERO_HASH, '2026-01-15');
  await chainTamper.append(blockForTamper);
  const stored = await storeTamper.get('ledger:blocks');
  stored[0].day_hash = 'f'.repeat(64);
  await storeTamper.set('ledger:blocks', stored);
  t.assert(!(await chainTamper.verify()), 'verify() returns false when block seal is broken');

  // Test 33: verify returns false when prev_hash linkage is broken
  const storeLink = makeEmptyStore();
  const chainLink = new LedgerChain(crypto, storeLink, MASTER_KEY);
  const block1Link = await chainLink.buildDayBlock(entries, ZERO_HASH, '2026-01-15');
  await chainLink.append(block1Link);
  const b2l = await chainLink.buildDayBlock(entries2, block1Link.day_hash, '2026-01-16');
  await chainLink.append(b2l);
  const storedLink = await storeLink.get('ledger:blocks');
  storedLink[1].prev_hash = 'ffff'.repeat(16);
  await storeLink.set('ledger:blocks', storedLink);
  t.assert(!(await chainLink.verify()), 'verify() returns false when prev_hash linkage is broken');

  // Test 34: verify returns false when entry hash is wrong
  const storeEntry = makeEmptyStore();
  const chainEntry = new LedgerChain(crypto, storeEntry, MASTER_KEY);
  const freshBlock = await chainEntry.buildDayBlock(entries, ZERO_HASH, '2026-01-15');
  await chainEntry.append(freshBlock);
  const storedEntry = await storeEntry.get('ledger:blocks');
  storedEntry[0].entries[0].hash = 'aaaa' + storedEntry[0].entries[0].hash.slice(4);
  await storeEntry.set('ledger:blocks', storedEntry);
  t.assert(!(await chainEntry.verify()), 'verify() returns false when entry hash is wrong');

  // ── Entry hash format compatibility ─────────────────────────────
  // Test 34a: verifyEntryHash accepts canonical indent=2 format
  const sampleEntry = { title: 'Test Entry', duration: 600 };
  const canonicalHash = createHash('sha256').update(jsonSortIndent2(sampleEntry), 'utf-8').digest('hex');
  t.assert(verifyEntryHash(sampleEntry, canonicalHash, crypto), 'verifyEntryHash accepts canonical indent=2 format');

  // Test 34b: verifyEntryHash accepts legacy compact format (sort_keys, no indent)
  const legacyHash = createHash('sha256').update(jsonSort(sampleEntry), 'utf-8').digest('hex');
  t.assert(verifyEntryHash(sampleEntry, legacyHash, crypto), 'verifyEntryHash accepts legacy compact format');

  // Test 34c: verifyEntryHash rejects wrong hash
  const wrongHash = '0'.repeat(64);
  t.assert(!verifyEntryHash(sampleEntry, wrongHash, crypto), 'verifyEntryHash rejects wrong hash');

  // Test 34d: LedgerChain.verify() passes with legacy-format entry hashes
  const storeLegacy = makeEmptyStore();
  const chainLegacy = new LedgerChain(crypto, storeLegacy, MASTER_KEY);
  const legacyEntry = { title: 'Legacy', duration: 300 };
  const legacyData = [{
    hash: createHash('sha256').update(jsonSort(legacyEntry), 'utf-8').digest('hex'),
    data: legacyEntry,
  }];
  const legacyBlock = await chainLegacy.buildDayBlock(legacyData, ZERO_HASH, '2026-01-16');
  // Override the computed hash with legacy format
  legacyBlock.entries[0].hash = createHash('sha256').update(jsonSort(legacyEntry), 'utf-8').digest('hex');
  // Must recompute seal since the hash changed
  const checkData = {};
  for (const [k, v] of Object.entries(legacyBlock)) {
    if (k !== 'day_hash' && k !== 'signature' && k !== 'identity_seal' && k !== 'format_version' && k !== 'key_version') {
      checkData[k] = v;
    }
  }
  legacyBlock.day_hash = crypto.seal(jsonSort(checkData), MASTER_KEY);
  await storeLegacy.set('ledger:blocks', [legacyBlock]);
  t.assert(await chainLegacy.verify(), 'verify() passes with legacy compact entry hashes');

  // Test 35: verify with identity signature
  const storeSig = makeEmptyStore();
  const chainSig = new LedgerChain(crypto, storeSig, MASTER_KEY, IDENTITY_SECRET);
  const sigBlock1 = await chainSig.buildDayBlock(entries, ZERO_HASH, '2026-01-15');
  await chainSig.append(sigBlock1);
  t.assert(await chainSig.verify(), 'verify() passes for signed chain');

  // Test 36: verify returns false when signature is broken
  const storeBadSig = makeEmptyStore();
  const chainBadSig = new LedgerChain(crypto, storeBadSig, MASTER_KEY, IDENTITY_SECRET);
  const sigBlock1b = await chainBadSig.buildDayBlock(entries, ZERO_HASH, '2026-01-15');
  await chainBadSig.append(sigBlock1b);
  const storedBadSig = await storeBadSig.get('ledger:blocks');
  storedBadSig[0].identity_seal = 'f'.repeat(64);
  await storeBadSig.set('ledger:blocks', storedBadSig);
  t.assert(!(await chainBadSig.verify()), 'verify() returns false when signature is broken');

  // ── Single Block Verification ──────────────────────
  console.log('\n=== Single Block Verification ===');

  // Test 37: verifyBlock(0) on valid genesis block
  const storeVb = makeEmptyStore();
  const chainVb = new LedgerChain(crypto, storeVb, MASTER_KEY);
  await chainVb.append(block1);
  t.assert(await chainVb.verifyBlock(0), 'verifyBlock(0) returns true for valid block 0');

  // Test 38: verifyBlock(1) on valid block
  const b2vb = await chainVb.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  await chainVb.append(b2vb);
  t.assert(await chainVb.verifyBlock(1), 'verifyBlock(1) returns true for valid block 1');

  // Test 39: verifyBlock on out-of-range index returns false
  t.assert(!(await chainVb.verifyBlock(99)), 'verifyBlock(99) returns false for out-of-range');

  // Test 40: verifyBlock on negative index returns false
  t.assert(!(await chainVb.verifyBlock(-1)), 'verifyBlock(-1) returns false');

  // ── verifyBlock(0) integrity ─────────────────────
  console.log('\n=== verifyBlock(0) Integrity ===');

  // Test 41: verifyBlock(0) returns false when genesis block seal is tampered
  const storeVbTamper = makeEmptyStore();
  const chainVbTamper = new LedgerChain(crypto, storeVbTamper, MASTER_KEY);
  await chainVbTamper.append(block1);
  const storedVbTamper = await storeVbTamper.get('ledger:blocks');
  storedVbTamper[0].day_hash = 'f'.repeat(64);
  await storeVbTamper.set('ledger:blocks', storedVbTamper);
  t.assert(!(await chainVbTamper.verifyBlock(0)), 'verifyBlock(0) returns false for tampered block 0 seal');

  // ── Missing signature on signed chain ────────────
  console.log('\n=== Missing Signature on Signed Chain ===');

  // Test 42: verify() returns false when signature is missing on a signed chain
  const storeMissSig = makeEmptyStore();
  const chainMissSig = new LedgerChain(crypto, storeMissSig, MASTER_KEY, IDENTITY_SECRET);
  const sigForMiss = await chainMissSig.buildDayBlock(entries, ZERO_HASH, '2026-01-20');
  await chainMissSig.append(sigForMiss);
  const storedMissSig = await storeMissSig.get('ledger:blocks');
  delete storedMissSig[0].identity_seal;
  delete storedMissSig[0].signature;
  await storeMissSig.set('ledger:blocks', storedMissSig);
  t.assert(!(await chainMissSig.verify()), 'verify() returns false when identity seal is missing on signed chain');

  // Test 43: verifyBlock(0) returns false when signature missing on signed block 0
  const storeMissSig2 = makeEmptyStore();
  const chainMissSig2 = new LedgerChain(crypto, storeMissSig2, MASTER_KEY, IDENTITY_SECRET);
  const sigForMiss2 = await chainMissSig2.buildDayBlock(entries, ZERO_HASH, '2026-01-21');
  await chainMissSig2.append(sigForMiss2);
  const storedMissSig2 = await storeMissSig2.get('ledger:blocks');
  delete storedMissSig2[0].identity_seal;
  delete storedMissSig2[0].signature;
  await storeMissSig2.set('ledger:blocks', storedMissSig2);
  t.assert(!(await chainMissSig2.verifyBlock(0)), 'verifyBlock(0) returns false when identity seal missing on signed block 0');

  // ══════════════════════════════════════════════════════════════
  // Canonical Ledger Format — Phase 2 RED Tests
  // ══════════════════════════════════════════════════════════════

  console.log('\n=== Canonical Format: Group A — Genesis Creation (A1-js, A2-js) ===');

  // Helper: compute seal excluding format_version (I-07)
  const clfComputeSeal = (blockData) => {
    const { format_version, ...withoutFv } = blockData;
    return crypto.seal(jsonSort(withoutFv), MASTER_KEY);
  };

  {
    const identity = {
      username: 'tester', email: 'test@example.com',
      recovery_seed_enc: 'enc:deadbeef', identity_pub_key: 'a'.repeat(64),
      identity_secret_enc_fallback: 'enc:cafebabe',
    };
    const genesis = {
      type: 'genesis', day_index: 0, date: '2026-07-03', identity,
      prev_hash: '0'.repeat(64), entries: [],
    };
    t.assert(genesis.format_version === undefined,
      'A1-js: Genesis must NOT contain format_version (I-07)');
    const sealData = { ...genesis };
    genesis.block_hash = clfComputeSeal(sealData);
    genesis.identity_seal = crypto.mac(genesis.block_hash, IDENTITY_SECRET);
    t.assert(typeof genesis.block_hash === 'string' && genesis.block_hash.length === 64,
      'A2-js: Genesis uses block_hash not day_hash (I-17)');
    t.assert(genesis.day_hash === undefined,
      'A2-js: Genesis must NOT have day_hash (I-17)');
  }

  // ── Group B-js: Block Seal Computation ──────────────────
  console.log('\n=== Canonical Format: Group B — Seal Vectors (B1-js..B5-js) ===');

  let testVectors;
  try {
    const { readFileSync } = await import('fs');
    const { dirname, join } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const vp = join(__dirname, '..', '..', 'testdata', 'canonical_test_vectors.json');
    testVectors = JSON.parse(readFileSync(vp, 'utf-8')).vectors;
  } catch (_) { testVectors = null; }

  if (testVectors) {
    if (testVectors['V-genesis']) {
      const s = clfComputeSeal(testVectors['V-genesis'].block_data);
      t.assert(typeof s === 'string' && s.length === 64, 'B1-js: Genesis seal from vector is 64 hex chars');
      t.assertEq(s, clfComputeSeal(testVectors['V-genesis'].block_data), 'B1-js: Genesis seal deterministic');
    }
    if (testVectors['V-day']) {
      const s = clfComputeSeal(testVectors['V-day'].block_data);
      t.assert(typeof s === 'string' && s.length === 64, 'B2-js: Day seal from vector is 64 hex chars');
    }
    if (testVectors['V-month']) {
      const s = clfComputeSeal(testVectors['V-month'].block_data);
      t.assert(typeof s === 'string' && s.length === 64, 'B3-js: Month summary seal from vector is 64 hex chars');
    }
    if (testVectors['V-year']) {
      const s = clfComputeSeal(testVectors['V-year'].block_data);
      t.assert(typeof s === 'string' && s.length === 64, 'B4-js: Year summary seal from vector is 64 hex chars');
    }
    if (testVectors['V-genesis']) {
      const s1 = clfComputeSeal(testVectors['V-genesis'].block_data);
      const s2 = clfComputeSeal({ ...testVectors['V-genesis'].block_data, format_version: '99.99.99' });
      t.assertEq(s1, s2,
        'B5-js: format_version added to block data must NOT change seal (I-07 — RED)');
    }
  }

  // ── Group C-js: Chain Verification ──────────────────────
  console.log('\n=== Canonical Format: Group C — Chain Verification (C1-js..C4-js) ===');

  const buildNewGenesis = () => {
    const g = { type: 'genesis', day_index: 0, date: '2026-07-03',
      identity: { username: 'tester', email: 'test@example.com',
        recovery_seed_enc: 'enc:deadbeef', identity_pub_key: 'a'.repeat(64),
        identity_secret_enc_fallback: 'enc:cafebabe' },
      prev_hash: '0'.repeat(64), entries: [] };
    // ADR-029a: seal over the closed per-type whitelist only — identity (and
    // any non-whitelisted field) stays on the block but OUTSIDE the seal,
    // matching the Python reference verifier.
    g.block_hash = crypto.seal(jsonSort(selectSealFields(g)), MASTER_KEY);
    g.identity_seal = crypto.mac(g.block_hash, IDENTITY_SECRET);
    return g;
  };
  const buildNewDay = (prevHash) => {
    const d = { type: 'day', day_index: 1, date: '2026-07-03', prev_hash: prevHash, entries: [] };
    d.day_hash = clfComputeSeal(d);
    d.identity_seal = crypto.mac(d.day_hash, IDENTITY_SECRET);
    return d;
  };

  {
    const g = buildNewGenesis();
    const d = buildNewDay(g.block_hash);
    const store = makeEmptyStore();
    await store.set('ledger:blocks', [g, d]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);
    t.assert(await chain.verify(),
      'C1-js: verify() must return true for new-format chain (block_hash on genesis — RED)');
  }
  {
    const g = buildNewGenesis();
    const store = makeEmptyStore();
    await store.set('ledger:blocks', [g]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);
    t.assert(await chain._verifyBlockData(g, 0),
      'C2-js: _verifyBlockData(genesis, 0) with block_hash (I-17 — RED)');
  }
  {
    const d = buildNewDay('0'.repeat(64));
    const store = makeEmptyStore();
    await store.set('ledger:blocks', [d]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);
    t.assert(await chain._verifyBlockData(d, 0),
      'C3-js: _verifyBlockData(day, 0) must still verify (day_hash unchanged)');
  }
  {
    const g = buildNewGenesis();
    const d = buildNewDay(g.block_hash);
    const store = makeEmptyStore();
    await store.set('ledger:blocks', [g, d]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);
    t.assert(await chain.verify(),
      'C4-js: Migrated chain must pass verify()');
  }
}

// ── Group R5: _verifyBlockData duplication consistency ──────────────────────
// Rec #5: Verify that LedgerChain._verifyBlockData() and
// LedgerMerge._verifyBlockData() produce identical results for the
// same inputs. The duplication is intentional (merge.js is standalone)
// but both must stay behaviorally in sync.
{
  let LedgerMerge;
  try {
    const mod = await import('../src/ledger/merge.js');
    LedgerMerge = mod.LedgerMerge;
  } catch (_err) {
    LedgerMerge = undefined;
  }

  if (LedgerChain && LedgerMerge) {
    // Build a simple genesis and day block without scoped helpers
    const genBlock = {
      type: 'genesis',
      day_index: 0,
      date: '2026-07-03',
      identity: { username: 'test', email: 'test@test.com',
        recovery_seed_enc: 'enc:aa', identity_pub_key: 'a'.repeat(64),
        identity_secret_enc_fallback: 'enc:bb' },
      prev_hash: '0'.repeat(64),
      entries: [],
      block_hash: '',  // computed below
    };
    const genSealData = { ...genBlock };
    delete genSealData.block_hash;
    delete genSealData.signature;
    genBlock.block_hash = crypto.seal(JSON.stringify(jsonSort(genSealData)));
    genBlock.identity_seal = crypto.mac(genBlock.block_hash, IDENTITY_SECRET);

    const dayBlock = {
      type: 'day',
      day_index: 1,
      date: '2026-07-03',
      prev_hash: genBlock.block_hash,
      entries: [{
        hash: entryHash({ title: 'Test', duration: 600 }),
        data: { title: 'Test', duration: 600 },
      }],
      day_hash: '',  // computed below
    };
    const daySealData = { ...dayBlock };
    delete daySealData.day_hash;
    delete daySealData.signature;
    dayBlock.day_hash = crypto.seal(JSON.stringify(jsonSort(daySealData)));
    dayBlock.identity_seal = crypto.mac(dayBlock.day_hash, IDENTITY_SECRET);

    // Test genesis block
    {
      const storeA = makeEmptyStore();
      await storeA.set('ledger:blocks', [genBlock]);
      const chain = new LedgerChain(crypto, storeA, MASTER_KEY, IDENTITY_SECRET);
      const chainResult = await chain._verifyBlockData(genBlock, 0);

      const mergeResult = await LedgerMerge._verifyBlockData(
        genBlock, crypto, MASTER_KEY, IDENTITY_SECRET);
      t.assertEq(chainResult, mergeResult,
        'R5-1: _verifyBlockData(genesis) must agree between chain.js and merge.js');
    }

    // Test day block
    {
      const storeB = makeEmptyStore();
      await storeB.set('ledger:blocks', [genBlock, dayBlock]);
      const chain = new LedgerChain(crypto, storeB, MASTER_KEY, IDENTITY_SECRET);
      const chainResult = await chain._verifyBlockData(dayBlock, 1);

      const mergeResult = await LedgerMerge._verifyBlockData(
        dayBlock, crypto, MASTER_KEY, IDENTITY_SECRET);
      t.assertEq(chainResult, mergeResult,
        'R5-2: _verifyBlockData(day) must agree between chain.js and merge.js');
    }

    // Test tampered block (both should reject)
    {
      const tampered = JSON.parse(JSON.stringify(dayBlock));
      tampered.day_hash = 'f'.repeat(64);
      const storeC = makeEmptyStore();
      await storeC.set('ledger:blocks', [genBlock, tampered]);
      const chain = new LedgerChain(crypto, storeC, MASTER_KEY, IDENTITY_SECRET);
      const chainResult = await chain._verifyBlockData(tampered, 1);

      const mergeResult = await LedgerMerge._verifyBlockData(
        tampered, crypto, MASTER_KEY, IDENTITY_SECRET);
      t.assertEq(chainResult, mergeResult,
        'R5-3: _verifyBlockData(tampered) must agree between chain.js and merge.js');
    }
  } else {
    t.skip(!LedgerChain, 'R5(chain): LedgerChain._verifyBlockData not available');
    t.skip(!LedgerMerge, 'R5(merge): LedgerMerge._verifyBlockData not available');
  }
}

  // ══════════════════════════════════════════════════════════════
  // I-06: content_hash required at format_version >= 0.4.0
  // Group B — chain.js: content_hash verification + format_version gating
  // ══════════════════════════════════════════════════════════════
  console.log('\n=== I-06 Group B — content_hash format_version gating (chain.js) ===');

  // Helper: compute content_hash the same way Python _verify_content_hash does
  const computeContentHash = (data) => {
    const content = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'content_hash') continue;
      if (key.endsWith('_enc') && value !== null && value !== '') {
        try {
          content[key] = crypto.decrypt(value, MASTER_KEY);
        } catch (_) {
          content[key] = value;
        }
      } else if (Array.isArray(value)) {
        content[key] = [...value].sort();
      } else {
        content[key] = value;
      }
    }
    return crypto.sha256(jsonSort(content));
  };

  // Helper: build a genesis block with optional format_version
  const buildContentHashGenesis = (formatVersion) => {
    const g = {
      type: 'genesis',
      day_index: 0,
      date: '2026-06-01',
      identity: {
        username: 'tester', email: 'test@example.com',
        recovery_seed_enc: 'enc:seed', identity_pub_key: 'a'.repeat(64),
        identity_secret_enc_fallback: 'enc:secret',
      },
      prev_hash: '0'.repeat(64),
      entries: [],
    };
    if (formatVersion !== undefined) {
      g.format_version = formatVersion;
    }
    // Seal: exclude hash keys + identity_seal + signature + format_version (I-07)
    const sealData = { ...g };
    delete sealData.block_hash;
    delete sealData.day_hash;
    delete sealData.identity_seal;
    delete sealData.signature;
    delete sealData.format_version;
    g.block_hash = crypto.seal(jsonSort(sealData), MASTER_KEY);
    g.identity_seal = crypto.mac(g.block_hash, IDENTITY_SECRET);
    return g;
  };

  // Helper: build a day block with entries
  const buildContentHashDay = (prevHash, entries, dayIndex, dateStr) => {
    const d = {
      type: 'day',
      day_index: dayIndex,
      date: dateStr,
      prev_hash: prevHash,
      entries: entries.map(e => ({
        hash: entryHash(e.data),
        data: e.data,
      })),
    };
    const sealData = { ...d };
    delete sealData.day_hash;
    delete sealData.identity_seal;
    delete sealData.signature;
    delete sealData.format_version;
    d.day_hash = crypto.seal(jsonSort(sealData), MASTER_KEY);
    d.identity_seal = crypto.mac(d.day_hash, IDENTITY_SECRET);
    return d;
  };

  // Helper: make entry data dict (with or without content_hash)
  const mkEntryData = (opts) => {
    const { title, start_epoch, duration, tags, comment } = opts;
    const data = {
      title: title || 'Test',
      startTime_enc: crypto.encrypt(String(start_epoch || 1700000000000), MASTER_KEY),
      endTime_enc: crypto.encrypt(String((start_epoch || 1700000000000) + (duration || 3600000)), MASTER_KEY),
      duration: duration || 3600000,
      tags: tags || [],
      pauses_enc: crypto.encrypt('[]', MASTER_KEY),
      metadata_enc: crypto.encrypt('{}', MASTER_KEY),
      comment: comment || '',
      media: [],
    };
    if (opts.includeContentHash !== false) {
      data.content_hash = computeContentHash(data);
    }
    return data;
  };

  // ── B1: Entry without content_hash at 0.4.0 → _verifyBlockData returns false
  {
    console.log('\n  --- B1: Missing content_hash at 0.4.0 → rejects ---');
    const genesis = buildContentHashGenesis('0.4.0');
    const entryData = mkEntryData({ includeContentHash: false });
    const day = buildContentHashDay(genesis.block_hash, [{ data: entryData }], 1, '2026-06-01');

    const store = makeEmptyStore();
    await store.set('ledger:blocks', [genesis, day]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

    // B1: missing content_hash at 0.4.0 must cause verification failure
    t.assert(!(await chain._verifyBlockData(day, 1, true)),
      'B1: _verifyBlockData returns false for entry without content_hash at format_version 0.4.0');
  }

  // ── B2: Entry with valid content_hash at 0.4.0 → returns true
  {
    console.log('\n  --- B2: Valid content_hash at 0.4.0 → accepts ---');
    const genesis = buildContentHashGenesis('0.4.0');
    const entryData = mkEntryData({ title: 'Valid Entry', includeContentHash: true });
    const day = buildContentHashDay(genesis.block_hash, [{ data: entryData }], 1, '2026-06-01');

    const store = makeEmptyStore();
    await store.set('ledger:blocks', [genesis, day]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

    t.assert(await chain._verifyBlockData(day, 1),
      'B2: _verifyBlockData returns true for valid content_hash at format_version 0.4.0');
  }

  // ── B3: Entry with wrong content_hash at 0.4.0 → returns false
  {
    console.log('\n  --- B3: Wrong content_hash at 0.4.0 → rejects ---');
    const genesis = buildContentHashGenesis('0.4.0');
    const entryData = mkEntryData({ title: 'Tampered', includeContentHash: true });
    entryData.content_hash = 'f'.repeat(64);  // wrong hash
    const day = buildContentHashDay(genesis.block_hash, [{ data: entryData }], 1, '2026-06-01');

    const store = makeEmptyStore();
    await store.set('ledger:blocks', [genesis, day]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

    t.assert(!(await chain._verifyBlockData(day, 1)),
      'B3: _verifyBlockData returns false for wrong content_hash at format_version 0.4.0');
  }

  // ── B4: Entry without content_hash at 0.3.0 → returns true (backward compat)
  {
    console.log('\n  --- B4: Missing content_hash at 0.3.0 → accepts (backward compat) ---');
    const genesis = buildContentHashGenesis('0.3.0');
    const entryData = mkEntryData({ includeContentHash: false });
    const day = buildContentHashDay(genesis.block_hash, [{ data: entryData }], 1, '2026-06-01');

    const store = makeEmptyStore();
    await store.set('ledger:blocks', [genesis, day]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

    t.assert(await chain._verifyBlockData(day, 1),
      'B4: _verifyBlockData returns true for missing content_hash at format_version 0.3.0');
  }

  // ── B5: Entry without content_hash at absent format_version → returns true
  {
    console.log('\n  --- B5: Missing content_hash, no format_version → accepts ---');
    const genesis = buildContentHashGenesis(undefined);
    const entryData = mkEntryData({ includeContentHash: false });
    const day = buildContentHashDay(genesis.block_hash, [{ data: entryData }], 1, '2026-06-01');

    const store = makeEmptyStore();
    await store.set('ledger:blocks', [genesis, day]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

    t.assert(await chain._verifyBlockData(day, 1),
      'B5: _verifyBlockData returns true for missing content_hash with no format_version');
  }

  // ── B6: Full verify() on 0.4.0 chain with missing content_hash → false
  {
    console.log('\n  --- B6: Full verify() rejects missing content_hash at 0.4.0 ---');
    const genesis = buildContentHashGenesis('0.4.0');
    const entryData = mkEntryData({ includeContentHash: false });
    const day = buildContentHashDay(genesis.block_hash, [{ data: entryData }], 1, '2026-06-01');

    const store = makeEmptyStore();
    await store.set('ledger:blocks', [genesis, day]);
    const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

    t.assert(!(await chain.verify()),
      'B6: verify() returns false for chain with missing content_hash at format_version 0.4.0');
  }

  // ── D3 (extended): _verifyBlockData sync between chain.js and merge.js with content_hash ──
  console.log('\n=== I-06 Group D3 — Duplication consistency with content_hash cases ===');

  // Re-import LedgerMerge (the R5 block scope is closed)
  let LedgerMerge2;
  try {
    const mod2 = await import('../src/ledger/merge.js');
    LedgerMerge2 = mod2.LedgerMerge;
  } catch (_err2) {
    LedgerMerge2 = undefined;
  }

  if (typeof LedgerMerge2 !== 'undefined' && LedgerMerge2) {
    {
      // D3a: Both reject missing content_hash at 0.4.0
      console.log('\n  --- D3a: Both reject missing content_hash at 0.4.0 ---');
      const entryData = mkEntryData({ includeContentHash: false });
      const day = {
        type: 'day', day_index: 1, date: '2026-06-01',
        prev_hash: '0'.repeat(64),
        entries: [{ hash: entryHash(entryData), data: entryData }],
      };
      day.day_hash = crypto.seal(jsonSort(day), MASTER_KEY);
      day.identity_seal = crypto.mac(day.day_hash, IDENTITY_SECRET);

      const genesis = buildContentHashGenesis('0.4.0');
      const store = makeEmptyStore();
      await store.set('ledger:blocks', [genesis, day]);
      const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

      const chainResult = await chain._verifyBlockData(day, 1, true);
      const mergeResult = await LedgerMerge2._verifyBlockData(
        day, crypto, MASTER_KEY, IDENTITY_SECRET, true);
      t.assertEq(chainResult, mergeResult,
        'D3a: chain and merge agree on missing content_hash at 0.4.0 (both should reject)');
    }
    {
      // D3b: Both accept valid content_hash at 0.4.0
      console.log('\n  --- D3b: Both accept valid content_hash at 0.4.0 ---');
      const entryData = mkEntryData({ title: 'Valid', includeContentHash: true });
      const day = {
        type: 'day', day_index: 1, date: '2026-06-01',
        prev_hash: '0'.repeat(64),
        entries: [{ hash: entryHash(entryData), data: entryData }],
      };
      day.day_hash = crypto.seal(jsonSort(day), MASTER_KEY);
      day.identity_seal = crypto.mac(day.day_hash, IDENTITY_SECRET);

      const genesis = buildContentHashGenesis('0.4.0');
      const store = makeEmptyStore();
      await store.set('ledger:blocks', [genesis, day]);
      const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

      const chainResult = await chain._verifyBlockData(day, 1);
      const mergeResult = await LedgerMerge2._verifyBlockData(
        day, crypto, MASTER_KEY, IDENTITY_SECRET, true);
      t.assertEq(chainResult, mergeResult,
        'D3b: chain and merge agree on valid content_hash at 0.4.0 (both should accept)');
    }
  } else {
    t.skip(!LedgerMerge2, 'D3(merge): LedgerMerge._verifyBlockData not available');
  }

// ── Summary ─────────────────────────────────────────────────────────
t.summary('LedgerChain');
process.exit(t.failed > 0 ? 1 : 0);
