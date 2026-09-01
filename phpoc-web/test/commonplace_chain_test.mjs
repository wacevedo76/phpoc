/**
 * commonplace_chain_test.mjs — CommonplaceChain test suite (Phase 2 RED).
 *
 * Groups A–C (31 assertions) from docs/planning/COMMONPLACE_BOOK_WEB_PHASE1.md.
 * Mirrors the Flutter commonplace_chain_test.dart contract, adapted to the web
 * StorageBackend + MockCrypto + TestHelpers harness (same as ledger_chain_test.mjs).
 *
 * Run: node test/commonplace_chain_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { MockCrypto } from './mock_crypto.mjs';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort, getBlockHash } from '../src/ledger/utils.js';
import { LedgerChain } from '../src/ledger/chain.js';
import { CommonplaceChain } from '../src/commonplace/commonplace_chain.js';

const t = new TestHelpers();

const MASTER_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const IDENTITY_SECRET = 'identity-secret-32-bytes-xxxxxx';

// ── Helpers ────────────────────────────────────────────────────────

function makeCrypto() {
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  return crypto;
}

function makeChain({ identitySecret = IDENTITY_SECRET, store = null } = {}) {
  return new CommonplaceChain(makeCrypto(), store || new MemoryBackend(), MASTER_KEY, identitySecret);
}

async function seedGenesis(chain) {
  return chain.buildGenesis({
    username: 'testuser',
    email: 'test@example.com',
    recoverySeedEnc: 'encrypted-seed',
    identityPubKey: 'pub-key-hex',
    identitySecretEncFallback: 'fallback-hex',
  });
}

function cpEntry({ title, entry = 'a noted passage text', tags = ['topic'], adHoc, timestampMs = 1700000000000, date = '2026-08-21' } = {}) {
  const e = { type: 'commonplace', title, tags, entry, timestamp_ms: timestampMs, date };
  if (adHoc) e.ad_hoc = adHoc;
  return e;
}

function computeContentHash(data, crypto) {
  const content = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'content_hash') continue;
    if (key.endsWith('_enc') && value !== null && value !== undefined && value !== '') {
      content[key] = crypto.decrypt(value, MASTER_KEY);
    } else if (Array.isArray(value)) {
      content[key] = value.slice().sort((a, b) => String(a).localeCompare(String(b)));
    } else {
      content[key] = value;
    }
  }
  return crypto.sha256(jsonSort(content));
}

function firstEntryData(block) {
  return block.entries[0].data;
}

async function dayBlockWith(chain, entry, { append = false } = {}) {
  const tip = await chain.getLastBlock();
  const prevHash = tip ? chain.getBlockHashFor(tip) : '0'.repeat(64);
  const block = await chain.buildDayBlock([entry], prevHash, entry.date || '2026-08-21');
  if (append) await chain.append(block);
  return block;
}

async function test(name, fn) {
  try { await fn(); }
  catch (e) { t.assert(false, `${name} — ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════
// Group A: Commonplace Genesis — Build & Sealing (11)
// ═══════════════════════════════════════════════════════════════════

await test('CP-A1: buildGenesis creates commonplace_genesis block, day_index=0, entries=[]', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  t.assertEq(gen.type, 'commonplace_genesis', 'A1: type');
  t.assertEq(gen.day_index, 0, 'A1: day_index');
  t.assertDeepEq(gen.entries, [], 'A1: entries');
});

await test('CP-A2: buildGenesis embeds username, email, recovery_seed, identity key', async () => {
  const chain = makeChain();
  const gen = await chain.buildGenesis({
    username: 'alice', email: 'alice@example.com',
    recoverySeedEnc: 'seed-enc-string', identityPubKey: 'pub-key',
    identitySecretEncFallback: 'secret-fallback',
  });
  t.assertEq(gen.username, 'alice', 'A2: username');
  t.assertEq(gen.email, 'alice@example.com', 'A2: email');
  t.assertEq(gen.recovery_seed_enc, 'seed-enc-string', 'A2: recovery_seed_enc');
  t.assertEq(gen.identity_pub_key, 'pub-key', 'A2: identity_pub_key');
});

await test('CP-A3: buildGenesis keys root with block_hash, not day_hash', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  t.assert('block_hash' in gen, 'A3: has block_hash');
  t.assert(gen.block_hash && gen.block_hash.length > 0, 'A3: block_hash non-empty');
  t.assertEq(chain.getBlockHashFor(gen), gen.block_hash, 'A3: getBlockHashFor resolves block_hash');
  t.assert(!('day_hash' in gen), 'A3: no day_hash on genesis');
});

await test('CP-A4: buildGenesis anchors an identity_seal over block_hash', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const seal = gen.identity_seal;
  t.assert(typeof seal === 'string' && seal.length > 0, 'A4: identity_seal present');
  t.assert(chain.verifyIdentityMac(chain.getBlockHashFor(gen), seal), 'A4: identity_seal verifies');
});

await test('CP-A5: buildGenesis uses a 64-zero prev_hash sentinel', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  t.assertEq(gen.prev_hash, '0'.repeat(64), 'A5: prev_hash is 64 zeros');
});

await test('CP-A6: buildGenesis throws when blocks already exist', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  let threw = false;
  try {
    await chain.buildGenesis({ username: 'bob', email: 'bob@example.com', recoverySeedEnc: 'seed', identityPubKey: 'pk', identitySecretEncFallback: 'fb' });
  } catch { threw = true; }
  t.assert(threw, 'A6: second buildGenesis throws');
});

await test('CP-A7: Commonplace genesis is a distinct chain root under the same MK', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  t.assertEq(gen.type, 'commonplace_genesis', 'A7: distinctive type');
  t.assertEq(await chain.getBlockCount(), 1, 'A7: single-block root');
});

await test('CP-A8: Commonplace genesis sealing uses the shared master key', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  t.assertEq(chain.getMasterKeyHex(), MASTER_KEY, 'A8: master key cached');
  t.assert(gen.block_hash && gen.block_hash.length > 0, 'A8: block_hash non-empty');
  t.assert(await chain.verify(), 'A8: fresh genesis verifies');
});

await test('CP-A9: Commonplace and activity genesis roots stay distinct (D7)', async () => {
  const chain = makeChain();
  const cpGen = await seedGenesis(chain);
  const cpHash = chain.getBlockHashFor(cpGen);

  const ledgerChain = new LedgerChain(makeCrypto(), new MemoryBackend(), MASTER_KEY, IDENTITY_SECRET);
  const actGen = await ledgerChain.buildGenesisBlock({ username: 'testuser', email: 'test@example.com', passphrase: 'pw', seed: 'seed' });
  const actHash = getBlockHash(actGen);

  t.assertNeq(cpGen.type, actGen.type, 'A9: types differ');
  t.assertEq(actGen.type, 'genesis', 'A9: activity type');
  t.assertEq(cpGen.type, 'commonplace_genesis', 'A9: commonplace type');
  t.assert(cpHash && cpHash.length > 0, 'A9: cp hash non-empty');
  t.assertNeq(cpHash, actHash, 'A9: hashes differ');
});

await test('CP-A10: buildGenesis records format_version and key_version', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  t.assert('key_version' in gen && Number.isInteger(gen.key_version) && gen.key_version >= 1, 'A10: key_version >= 1');
  t.assert(typeof gen.format_version === 'string' && gen.format_version.length > 0, 'A10: format_version present');
});

await test('CP-A11: verify() is true for a valid single-genesis chain', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  t.assert(await chain.verify(), 'A11: fresh genesis verifies');
});

// ═══════════════════════════════════════════════════════════════════
// Group B: Commonplace Day Block — Build & Sealing (12)
// ═══════════════════════════════════════════════════════════════════

await test('CP-B1: buildDayBlock creates a commonplace day block (index 1)', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const block = await chain.buildDayBlock([cpEntry({ title: 'First passage', entry: 'alpha' })], chain.getBlockHashFor(gen), '2026-08-21');
  t.assertEq(block.type, 'commonplace', 'B1: type');
  t.assertEq(block.day_index, 1, 'B1: day_index');
});

await test('CP-B2: buildDayBlock accepts a full commonplace entry dict', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const entry = cpEntry({ title: 'Quiet power', entry: 'a long passage to preserve', tags: ['notes', 'vim'], adHoc: { source: 'conversation' }, timestampMs: 1720000000000, date: '2026-08-22' });
  const block = await chain.buildDayBlock([entry], chain.getBlockHashFor(gen), '2026-08-22');
  t.assertEq(block.entries.length, 1, 'B2: one sealed entry');
});

await test('CP-B3: buildDayBlock recomputes content hashes from actual data', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const block = await chain.buildDayBlock([cpEntry({ title: 'Hashed note' })], chain.getBlockHashFor(gen), '2026-08-21');
  const data = firstEntryData(block);
  t.assert(data.content_hash && data.content_hash.length > 0, 'B3: content_hash present');
  t.assertEq(computeContentHash(data, makeCrypto()), data.content_hash, 'B3: content_hash recomputed correctly');
});

await test('CP-B4: buildDayBlock seals entry data under a resolvable day_hash key', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const block = await chain.buildDayBlock([cpEntry({ title: 'Sealed note' })], chain.getBlockHashFor(gen), '2026-08-21');
  t.assert(chain.getBlockHashFor(block).length > 0, 'B4: day_hash resolvable');
  await chain.append(block);
  t.assert(await chain.verify(), 'B4: appended chain verifies');
});

await test('CP-B5: buildDayBlock signs with identity_seal when identity is present', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const block = await chain.buildDayBlock([cpEntry({ title: 'Signed note' })], chain.getBlockHashFor(gen), '2026-08-21');
  t.assert('identity_seal' in block, 'B5: identity_seal present');
  t.assert(chain.verifyIdentityMac(chain.getBlockHashFor(block), block.identity_seal), 'B5: identity_seal verifies');
});

await test('CP-B6: buildDayBlock omits identity_seal when no identity secret', async () => {
  const chain = makeChain({ identitySecret: null });
  const gen = await seedGenesis(chain);
  const block = await chain.buildDayBlock([cpEntry({ title: 'Anonymous note' })], chain.getBlockHashFor(gen), '2026-08-21');
  t.assert(!('identity_seal' in block), 'B6: no identity_seal');
});

await test('CP-B7: first day block starts day_index at 1', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const block = await chain.buildDayBlock([cpEntry({ title: 'First' })], chain.getBlockHashFor(gen), '2026-08-21');
  t.assertEq(block.day_index, 1, 'B7: day_index 1');
});

await test('CP-B8: entries without ad_hoc seal with absent ad-hoc map', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  const block = await dayBlockWith(chain, cpEntry({ title: 'Plain note' }));
  t.assert(!('ad_hoc_enc' in firstEntryData(block)), 'B8: no ad_hoc_enc');
});

await test('CP-B9: buildDayBlock preserves all ad_hoc key/value pairs', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  const block = await dayBlockWith(chain, cpEntry({ title: 'Annotated', adHoc: { source: 'book', page: '42', rating: 'high' } }));
  const data = firstEntryData(block);
  const decoded = JSON.parse(makeCrypto().decrypt(data.ad_hoc_enc, MASTER_KEY));
  t.assertEq(decoded.source, 'book', 'B9: source');
  t.assertEq(decoded.page, '42', 'B9: page');
  t.assertEq(decoded.rating, 'high', 'B9: rating');
});

await test('CP-B10: title and entry are encrypted (no plaintext) at rest', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  const block = await dayBlockWith(chain, cpEntry({ title: 'SecretTitle', entry: 'SecretEntry' }));
  const data = firstEntryData(block);
  t.assert(!('title' in data), 'B10: no plaintext title');
  t.assert(!('entry' in data), 'B10: no plaintext entry');
  t.assert(typeof data.title_enc === 'string' && data.title_enc.includes('enc:'), 'B10: title_enc encrypted');
  t.assert(typeof data.entry_enc === 'string' && data.entry_enc.includes('enc:'), 'B10: entry_enc encrypted');
  t.assert(data.title_enc !== 'SecretTitle', 'B10: title_enc not plaintext');
  t.assert(data.entry_enc !== 'SecretEntry', 'B10: entry_enc not plaintext');
});

await test('CP-B11: tags are encrypted at rest (no plaintext tag list)', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  const block = await dayBlockWith(chain, cpEntry({ title: 'Tagged', tags: ['private-topic', 'vim'] }));
  const data = firstEntryData(block);
  t.assert(!('tags' in data), 'B11: no plaintext tags');
  t.assert(typeof data.tags_enc === 'string' && data.tags_enc.includes('enc:'), 'B11: tags_enc encrypted');
});

await test('CP-B12: same-date entries merge into a single day block', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const block = await chain.buildDayBlock([
    cpEntry({ title: 'One', timestampMs: 1700000000000 }),
    cpEntry({ title: 'Two', timestampMs: 1700064000000 }),
    cpEntry({ title: 'Three', timestampMs: 1700128000000 }),
  ], chain.getBlockHashFor(gen), '2026-08-21');
  t.assertEq(block.entries.length, 3, 'B12: three entries in one day block');
});

// ═══════════════════════════════════════════════════════════════════
// Group C: Commonplace Chain — Append & Truncate (8)
// ═══════════════════════════════════════════════════════════════════

await test('CP-C1: append adds a single block and links it', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  const block = await dayBlockWith(chain, cpEntry({ title: 'One' }));
  await chain.append(block);
  t.assertEq(await chain.getBlockCount(), 2, 'C1: count 2');
  t.assertEq((await chain.getLastBlock()).type, 'commonplace', 'C1: last type commonplace');
});

await test('CP-C2: append chains correctly when prev_hash matches the tip', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  const tip = await dayBlockWith(chain, cpEntry({ title: 'One' }));
  await chain.append(tip);
  const next = await chain.buildDayBlock([cpEntry({ title: 'Two', date: '2026-08-22' })], chain.getBlockHashFor(tip), '2026-08-22');
  await chain.append(next);
  t.assertEq(await chain.getBlockCount(), 3, 'C2: count 3');
  t.assert(await chain.verify(), 'C2: verifies');
});

await test('CP-C3: append throws on prev_hash mismatch (tamper)', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  const block = await chain.buildDayBlock([cpEntry({ title: 'Broken link' })], '1'.repeat(64), '2026-08-21');
  let threw = false;
  try { await chain.append(block); } catch { threw = true; }
  t.assert(threw, 'C3: append throws');
});

await test('CP-C4: appendBlocks adds multiple with internal + bridge linkage', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const b1 = await chain.buildDayBlock([cpEntry({ title: 'A', date: '2026-08-21' })], chain.getBlockHashFor(gen), '2026-08-21');
  const b2 = await chain.buildDayBlock([cpEntry({ title: 'B', date: '2026-08-22' })], chain.getBlockHashFor(b1), '2026-08-22');
  await chain.appendBlocks([b1, b2]);
  t.assertEq(await chain.getBlockCount(), 3, 'C4: count 3');
  t.assert(await chain.verify(), 'C4: verifies');
});

await test('CP-C5: truncate removes N blocks from the end, remaining chain valid', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  await dayBlockWith(chain, cpEntry({ title: 'One' }), { append: true });
  await dayBlockWith(chain, cpEntry({ title: 'Two', date: '2026-08-22' }), { append: true });
  t.assertEq(await chain.getBlockCount(), 3, 'C5: count 3 before');
  await chain.truncate(2);
  t.assertEq(await chain.getBlockCount(), 1, 'C5: count 1 after');
  t.assert(await chain.verify(), 'C5: remaining verifies');
});

await test('CP-C6: append rejects a foreign block type', async () => {
  const chain = makeChain();
  const gen = await seedGenesis(chain);
  const foreign = { type: 'day', day_index: 1, date: '2026-08-21', prev_hash: chain.getBlockHashFor(gen), entries: [] };
  let threw = false;
  try { await chain.append(foreign); } catch { threw = true; }
  t.assert(threw, 'C6: foreign type rejected');
});

await test('CP-C7: a full chain of genesis + day blocks verifies end-to-end', async () => {
  const chain = makeChain();
  await seedGenesis(chain);
  await dayBlockWith(chain, cpEntry({ title: 'One' }), { append: true });
  await dayBlockWith(chain, cpEntry({ title: 'Two', date: '2026-08-22' }), { append: true });
  await dayBlockWith(chain, cpEntry({ title: 'Three', date: '2026-08-23' }), { append: true });
  t.assertEq(await chain.getBlockCount(), 4, 'C7: count 4');
  t.assert(await chain.verify(), 'C7: verifies end-to-end');
});

await test('CP-C8: tampering with one entry ciphertext breaks verify()', async () => {
  const store = new MemoryBackend();
  const chain = makeChain({ store });
  await seedGenesis(chain);
  await dayBlockWith(chain, cpEntry({ title: 'Original' }), { append: true });
  t.assert(await chain.verify(), 'C8: valid before tamper');

  const blocks = await store.get('commonplace:blocks');
  const day = JSON.parse(JSON.stringify(blocks[blocks.length - 1]));
  const data = { ...day.entries[0].data };
  data.title_enc = '0'.repeat(data.title_enc.length);
  day.entries = [{ hash: day.entries[0].hash, data }];
  blocks[blocks.length - 1] = day;
  await store.set('commonplace:blocks', blocks);

  t.assert(!(await chain.verify()), 'C8: verify detects tamper');
});

// ── Summary ─────────────────────────────────────────────────────────
t.summary('CommonplaceChain');
process.exit(t.failed > 0 ? 1 : 0);
