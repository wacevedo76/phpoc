/**
 * ledger_chain_test.mjs — LedgerChain test suite.
 *
 * Tests block-level chain operations: building day blocks,
 * seal/sign helpers, append/truncate, chain verification.
 *
 * Option B: consumes StorageBackend (MemoryBackend) directly
 * via key convention "ledger:blocks".
 *
 * TDD: RED phase — source file doesn't exist yet.
 *
 * Usage:
 *   node test/ledger_chain_test.mjs
 */

import { createHash } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';

// ── Import module under test (WILL FAIL — doesn't exist yet) ──
let LedgerChain;
try {
  const mod = await import('../src/ledger/chain.js');
  LedgerChain = mod.LedgerChain;
} catch (err) {
  // Expected: module doesn't exist yet → all tests will fail
  LedgerChain = undefined;
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

// ── Mock CryptoService (deterministic, for test vector reproducibility) ──
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

  sign(data, identitySecretHex) {
    // Sign with a different derivation than seal
    return this.deterministicHash('sign:' + data + identitySecretHex);
  }

  verifySignature(data, signatureHex, identitySecretHex) {
    return this.sign(data, identitySecretHex) === signatureHex;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  encrypt(plaintext, masterKeyHex) {
    return 'enc:' + this.deterministicHash(plaintext + masterKeyHex);
  }

  decrypt(ciphertextHex, masterKeyHex) {
    if (ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }
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
    tags: SAMPLE_ENTRY_DATA_1.tags,
    pauses_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_1.pauses_enc, MASTER_KEY),
    metadata_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_1.metadata_enc, MASTER_KEY),
    comment: SAMPLE_ENTRY_DATA_1.comment,
    media: SAMPLE_ENTRY_DATA_1.media,
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
    tags: SAMPLE_ENTRY_DATA_2.tags,
    pauses_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_2.pauses_enc, MASTER_KEY),
    metadata_enc: crypto.decrypt(SAMPLE_ENTRY_DATA_2.metadata_enc, MASTER_KEY),
    comment: SAMPLE_ENTRY_DATA_2.comment,
    media: SAMPLE_ENTRY_DATA_2.media,
  }, null, 2)
);

function makeEmptyStore() {
  return new MemoryBackend();
}

function entryHash(data) {
  return createHash('sha256').update(JSON.stringify(data, null, 2), 'utf-8').digest('hex');
}

// ─────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────
console.log('\n=== LedgerChain Class Exists ===');

assert(typeof LedgerChain === 'function', 'LedgerChain is a constructor');

if (typeof LedgerChain === 'function') {
  // ── Constructor ────────────────────────────────────
  console.log('\n=== Constructor & Empty State ===');

  const store = makeEmptyStore();
  const chain = new LedgerChain(crypto, store, MASTER_KEY);

  assert(chain instanceof LedgerChain, 'creates instance with minimum args');

  const chainWithIdentity = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);
  assert(chainWithIdentity instanceof LedgerChain, 'creates instance with identity secret');

  // Test 1: Empty chain state
  assertEq(await chain.getBlockCount(), 0, 'empty chain has 0 blocks');
  assertEq(await chain.getLastBlock(), null, 'empty chain last block is null');
  assertDeepEq(await chain.readAll(), [], 'readAll on empty chain returns []');

  // Test 2: Negative index on empty chain returns null
  assertEq(await chain.getBlock(-1), null, 'getBlock(-1) on empty returns null');

  // ── Seal / Sign helpers ────────────────────────────
  console.log('\n=== Seal / Sign Helpers ===');

  const testData = { type: 'day', date: '2026-01-15' };

  // Test 3: computeSeal produces deterministic HMAC-like output
  const seal1 = chain.computeSeal(testData);
  assert(typeof seal1 === 'string', 'computeSeal returns a string');
  assert(/^[0-9a-f]{64}$/.test(seal1), 'seal is 64 hex chars');

  // Test 4: Same data + same key → same seal
  const seal2 = chain.computeSeal(testData);
  assertEq(seal1, seal2, 'seal is deterministic');

  // Test 5: Different data → different seal
  const seal3 = chain.computeSeal({ type: 'month_summary', month: '2026-01' });
  assertNeq(seal1, seal3, 'different data produces different seal');

  // Test 6: verifySeal passes for valid seal
  assert(chain.verifySeal(testData, seal1), 'verifySeal returns true for valid seal');

  // Test 7: verifySeal fails for tampered data
  assert(!chain.verifySeal({ type: 'tampered' }, seal1), 'verifySeal returns false for tampered data');

  // Test 8: computeSignature with identity secret
  const sig = chain.computeSignature(seal1);
  if (IDENTITY_SECRET) {
    assert(typeof sig === 'string', 'computeSignature returns a string with identity secret');
    assert(/^[0-9a-f]{64}$/.test(sig), 'signature is 64 hex chars');
  }

  // Test 9: verifySignature
  if (sig && IDENTITY_SECRET) {
    assert(chain.verifySignature(seal1, sig), 'verifySignature returns true for valid signature');
    assert(!chain.verifySignature(seal1 + 'x', sig), 'verifySignature returns false for bad data');
    assert(!chain.verifySignature(seal1, sig + 'x'), 'verifySignature returns false for bad signature');
  }

  // ── Block building: buildDayBlock ──────────────────
  console.log('\n=== Block Building: buildDayBlock ===');

  // Test 10: Build a day block on empty chain (no prev_hash)
  const entries = [
    { data: SAMPLE_ENTRY_DATA_1, hash: entryHash(SAMPLE_ENTRY_DATA_1) }
  ];
  const ZERO_HASH = '0'.repeat(64);
  const block1 = chain.buildDayBlock(entries, ZERO_HASH, '2026-01-15');

  assert(typeof block1 === 'object', 'buildDayBlock returns an object');
  assertHasKeys(block1, ['type', 'day_index', 'date', 'prev_hash', 'entries', 'day_hash'], 'block has all required keys');

  // Test 11: Block structure
  assertEq(block1.type, 'day', 'block type is "day"');
  assertEq(block1.day_index, 1, 'first block has day_index 1');
  assertEq(block1.date, '2026-01-15', 'date matches input');
  assertEq(block1.prev_hash, ZERO_HASH, 'prev_hash matches input');
  assert(Array.isArray(block1.entries), 'entries is an array');
  assertEq(block1.entries.length, 1, 'entries length matches input');
  assert(typeof block1.day_hash === 'string', 'day_hash is a string');
  assert(/^[0-9a-f]{64}$/.test(block1.day_hash), 'day_hash is 64 hex chars');

  // Test 12: Entry hash in built block
  assertEq(block1.entries[0].hash, entryHash(SAMPLE_ENTRY_DATA_1), 'entry hash is correct SHA-256 of data');

  // Test 13: Entry data is preserved
  assertDeepEq(block1.entries[0].data, SAMPLE_ENTRY_DATA_1, 'entry data is preserved');

  // Test 14: Day index increments when chain has existing day blocks
  await chain.append(block1);
  const entries2 = [
    { data: SAMPLE_ENTRY_DATA_2, hash: entryHash(SAMPLE_ENTRY_DATA_2) }
  ];
  const block2 = chain.buildDayBlock(entries2, ZERO_HASH, '2026-01-16');
  assertEq(block2.day_index, 2, 'second block has day_index 2');

  // Test 15: Day block with pre-hashed entries accepts {"hash", "data"} format
  const blockWithPrehashed = chain.buildDayBlock(
    [{ hash: 'a'.repeat(64), data: SAMPLE_ENTRY_DATA_1 }],
    ZERO_HASH,
    '2026-01-17'
  );
  // Hash is recomputed from data, so it won't match the fake hash
  assertEq(blockWithPrehashed.entries[0].hash, entryHash(SAMPLE_ENTRY_DATA_1),
    'block recomputes hash from data even when pre-hashed entry provided');

  // Test 16: Day block with raw dict (no hash key) accepts bare data
  const blockWithRaw = chain.buildDayBlock(
    [SAMPLE_ENTRY_DATA_1],
    ZERO_HASH,
    '2026-01-18'
  );
  assertEq(blockWithRaw.entries[0].hash, entryHash(SAMPLE_ENTRY_DATA_1),
    'block accepts raw dict and computes hash');

  // Test 17: Day block with optional identity signature
  const chainWithSig = new LedgerChain(crypto, makeEmptyStore(), MASTER_KEY, IDENTITY_SECRET);
  const sigBlock = chainWithSig.buildDayBlock(entries, ZERO_HASH, '2026-01-15');
  assertHasKeys(sigBlock, ['signature'], 'block with identity secret includes signature');
  assert(/^[0-9a-f]{64}$/.test(sigBlock.signature), 'signature is 64 hex chars');

  // ── Append operations ──────────────────────────────
  console.log('\n=== Append Operations ===');

  const store2 = makeEmptyStore();
  const chain2 = new LedgerChain(crypto, store2, MASTER_KEY);

  // Test 18: append single block increases count
  await chain2.append(block1);
  assertEq(await chain2.getBlockCount(), 1, 'append increases count to 1');
  assertDeepEq(await chain2.readAll(), [block1], 'readAll returns the appended block');

  // Test 19: getLastBlock after append
  const last = await chain2.getLastBlock();
  assertDeepEq(last, block1, 'getLastBlock returns the appended block');

  // Test 20: getBlock by index
  const fetched = await chain2.getBlock(0);
  assertDeepEq(fetched, block1, 'getBlock(0) returns the first block');

  // Test 21: getBlock with negative index
  assertDeepEq(await chain2.getBlock(-1), block1, 'getBlock(-1) returns last block');

  // Test 22: appendBlocks with valid linkage
  const store3 = makeEmptyStore();
  const chain3 = new LedgerChain(crypto, store3, MASTER_KEY);
  await chain3.append(block1);
  const block2linked = chain3.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  await chain3.appendBlocks([block2linked]);
  assertEq(await chain3.getBlockCount(), 2, 'appendBlocks with valid linkage succeeds');

  // Test 23: appendBlocks with multiple blocks
  const block3linked = chain3.buildDayBlock(entries, block2linked.day_hash, '2026-01-17');
  const block4linked = chain3.buildDayBlock(entries2, block3linked.day_hash, '2026-01-18');
  await chain3.appendBlocks([block3linked, block4linked]);
  assertEq(await chain3.getBlockCount(), 4, 'appendBlocks with multiple blocks works');

  // ── Linkage rejection ──────────────────────────────
  console.log('\n=== Linkage Verification (Rejection) ===');

  // Test 24: appendBlocks rejects block with wrong prev_hash against chain
  const store4 = makeEmptyStore();
  const chain4 = new LedgerChain(crypto, store4, MASTER_KEY);
  await chain4.append(block1);
  const badBlock = chain4.buildDayBlock(entries, '1234'.repeat(16), '2026-01-16');
  await assertAsyncThrows(
    chain4.appendBlocks([badBlock]),
    'appendBlocks rejects block with mismatched prev_hash'
  );

  // Test 25: appendBlocks rejects internal linkage violation among new blocks
  const store5 = makeEmptyStore();
  const chain5 = new LedgerChain(crypto, store5, MASTER_KEY);
  // First block is fine
  await chain5.append(block1);
  // Build two blocks that link correctly to the chain but not to each other
  const goodBlock = chain5.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  const badInternal = chain5.buildDayBlock(entries, 'ffff'.repeat(16), '2026-01-17');
  await assertAsyncThrows(
    chain5.appendBlocks([goodBlock, badInternal]),
    'appendBlocks rejects internal linkage violation among new blocks'
  );

  // ── Truncation ─────────────────────────────────────
  console.log('\n=== Truncation ===');

  const store6 = makeEmptyStore();
  const chain6 = new LedgerChain(crypto, store6, MASTER_KEY);
  // Build 4 blocks
  await chain6.append(block1);
  const b2 = chain6.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  await chain6.append(b2);
  const b3 = chain6.buildDayBlock(entries, b2.day_hash, '2026-01-17');
  await chain6.append(b3);
  const b4 = chain6.buildDayBlock(entries2, b3.day_hash, '2026-01-18');
  await chain6.append(b4);
  assertEq(await chain6.getBlockCount(), 4, 'setup: 4 blocks in chain');

  // Test 26: truncate removes N blocks from end
  const removed = await chain6.truncate(2);
  assertEq(removed.length, 2, 'truncate(2) returns 2 removed blocks');
  assertEq(await chain6.getBlockCount(), 2, 'truncate(2) leaves 2 blocks');
  assertDeepEq(removed[0], b3, 'first removed block is block index 2');
  assertDeepEq(removed[1], b4, 'second removed block is block index 3');

  // Test 27: truncate preserves genesis
  const store7 = makeEmptyStore();
  const chain7 = new LedgerChain(crypto, store7, MASTER_KEY);
  await chain7.append(block1);
  const genesisRemoved = await chain7.truncate(5);
  assertEq(genesisRemoved.length, 0, 'truncate cannot remove genesis block');
  assertEq(await chain7.getBlockCount(), 1, 'genesis block preserved');

  // Test 28: truncate with 0 removes nothing
  const store7b = makeEmptyStore();
  const chain7b = new LedgerChain(crypto, store7b, MASTER_KEY);
  await chain7b.append(block1);
  await chain7b.append(b2);
  const removed0 = await chain7b.truncate(0);
  assertEq(removed0.length, 0, 'truncate(0) removes nothing');
  assertEq(await chain7b.getBlockCount(), 2, 'truncate(0) keeps all blocks');

  // Test 29: truncate_keep preserves first N blocks
  const store8 = makeEmptyStore();
  const chain8 = new LedgerChain(crypto, store8, MASTER_KEY);
  await chain8.append(block1);
  await chain8.append(b2);
  await chain8.append(b3);
  await chain8.append(b4);
  const keepRemoved = await chain8.truncate_keep(2);
  assertEq(keepRemoved.length, 2, 'truncate_keep(2) removes 2 blocks');
  assertEq(await chain8.getBlockCount(), 2, 'truncate_keep(2) keeps 2 blocks');

  // Test 30: truncate_keep with count >= total removes nothing
  const store9 = makeEmptyStore();
  const chain9 = new LedgerChain(crypto, store9, MASTER_KEY);
  await chain9.append(block1);
  await chain9.append(b2);
  const keepAll = await chain9.truncate_keep(10);
  assertEq(keepAll.length, 0, 'truncate_keep with keep>=total removes nothing');
  assertEq(await chain9.getBlockCount(), 2, 'all blocks preserved');

  // ── Chain Verification ─────────────────────────────
  console.log('\n=== Chain Verification ===');

  // Test 31: verify returns true for valid chain
  const storeV = makeEmptyStore();
  const chainV = new LedgerChain(crypto, storeV, MASTER_KEY);
  await chainV.append(block1);
  const b2v = chainV.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  await chainV.append(b2v);
  const b3v = chainV.buildDayBlock(entries, b2v.day_hash, '2026-01-17');
  await chainV.append(b3v);
  assert(await chainV.verify(), 'verify() returns true for valid chain');

  // Test 32: verify returns false when a block seal is broken
  const storeTamper = makeEmptyStore();
  const chainTamper = new LedgerChain(crypto, storeTamper, MASTER_KEY);
  await chainTamper.append(block1);
  // Manually corrupt the stored block's day_hash — use a clearly invalid value
  const stored = await storeTamper.get('ledger:blocks');
  stored[0].day_hash = 'f'.repeat(64);
  await storeTamper.set('ledger:blocks', stored);
  assert(!(await chainTamper.verify()), 'verify() returns false when block seal is broken');

  // Test 33: verify returns false when prev_hash linkage is broken
  const storeLink = makeEmptyStore();
  const chainLink = new LedgerChain(crypto, storeLink, MASTER_KEY);
  await chainLink.append(block1);
  const b2l = chainLink.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  await chainLink.append(b2l);
  // Corrupt the stored b2 prev_hash
  const storedLink = await storeLink.get('ledger:blocks');
  storedLink[1].prev_hash = 'ffff'.repeat(16);
  await storeLink.set('ledger:blocks', storedLink);
  assert(!(await chainLink.verify()), 'verify() returns false when prev_hash linkage is broken');

  // Test 34: verify returns false when entry hash is wrong
  const storeEntry = makeEmptyStore();
  const chainEntry = new LedgerChain(crypto, storeEntry, MASTER_KEY);
  await chainEntry.append(block1);
  const storedEntry = await storeEntry.get('ledger:blocks');
  storedEntry[0].entries[0].hash = 'aaaa' + storedEntry[0].entries[0].hash.slice(4);
  await storeEntry.set('ledger:blocks', storedEntry);
  assert(!(await chainEntry.verify()), 'verify() returns false when entry hash is wrong');

  // Test 35: verify with identity signature
  const storeSig = makeEmptyStore();
  const chainSig = new LedgerChain(crypto, storeSig, MASTER_KEY, IDENTITY_SECRET);
  const sigBlock1 = chainSig.buildDayBlock(entries, ZERO_HASH, '2026-01-15');
  await chainSig.append(sigBlock1);
  assert(await chainSig.verify(), 'verify() passes for signed chain');

  // Test 36: verify returns false when signature is broken
  const storeBadSig = makeEmptyStore();
  const chainBadSig = new LedgerChain(crypto, storeBadSig, MASTER_KEY, IDENTITY_SECRET);
  const sigBlock1b = chainBadSig.buildDayBlock(entries, ZERO_HASH, '2026-01-15');
  await chainBadSig.append(sigBlock1b);
  const storedBadSig = await storeBadSig.get('ledger:blocks');
  storedBadSig[0].signature = 'f'.repeat(64);
  await storeBadSig.set('ledger:blocks', storedBadSig);
  assert(!(await chainBadSig.verify()), 'verify() returns false when signature is broken');

  // ── Single Block Verification ──────────────────────
  console.log('\n=== Single Block Verification ===');

  // Test 37: verifyBlock(0) on valid genesis block
  const storeVb = makeEmptyStore();
  const chainVb = new LedgerChain(crypto, storeVb, MASTER_KEY);
  await chainVb.append(block1);
  assert(await chainVb.verifyBlock(0), 'verifyBlock(0) returns true for valid block 0');

  // Test 38: verifyBlock(1) on valid block
  const b2vb = chainVb.buildDayBlock(entries2, block1.day_hash, '2026-01-16');
  await chainVb.append(b2vb);
  assert(await chainVb.verifyBlock(1), 'verifyBlock(1) returns true for valid block 1');

  // Test 39: verifyBlock on out-of-range index returns false
  assert(!(await chainVb.verifyBlock(99)), 'verifyBlock(99) returns false for out-of-range');

  // Test 40: verifyBlock on negative index returns false
  assert(!(await chainVb.verifyBlock(-1)), 'verifyBlock(-1) returns false');
}

// ── Summary ─────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────────');
console.log(`LedgerChain tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✗ ${e}`));
}

process.exit(failed > 0 ? 1 : 0);

// ── Local helpers ───────────────────────────────────────────────────

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
