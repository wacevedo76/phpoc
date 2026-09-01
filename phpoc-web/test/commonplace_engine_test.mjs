/**
 * commonplace_engine_test.mjs — CommonplaceEngine test suite (Phase 2 RED).
 *
 * Group D (10 assertions) from docs/planning/COMMONPLACE_BOOK_WEB_PHASE1.md.
 * Mirrors the Flutter commonplace_engine_test.dart contract, adapted to the web
 * StorageBackend harness. `commit` derives the date from timestamp_ms (UTC).
 *
 * Run: node test/commonplace_engine_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { MockCrypto } from './mock_crypto.mjs';
import { TestHelpers } from './test_helpers.mjs';
import { CommonplaceEngine } from '../src/commonplace/commonplace_engine.js';

const t = new TestHelpers();

const MASTER_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const IDENTITY_SECRET = 'identity-secret-32-bytes-xxxxxx';

// ── Helpers ────────────────────────────────────────────────────────

function makeCrypto() {
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  return crypto;
}

function makeEngine({ identitySecret = IDENTITY_SECRET } = {}) {
  const store = new MemoryBackend();
  const engine = new CommonplaceEngine(makeCrypto(), store, MASTER_KEY, identitySecret);
  engine.__store = store;
  return engine;
}

async function seedGenesis(engine) {
  await engine.buildGenesis({
    username: 'testuser',
    email: 'test@example.com',
    recoverySeedEnc: 'encrypted-seed',
    identityPubKey: 'pub-key-hex',
    identitySecretEncFallback: 'fallback-hex',
  });
}

// Raw (pre-encryption) Commonplace entry dict — no `type`/`date`/`comment`.
function entry({ title, entry = 'passage text', tags = ['topic'], adHoc, timestampMs = 1700000000000 } = {}) {
  const e = { title, tags, entry, timestamp_ms: timestampMs };
  if (adHoc) e.ad_hoc = adHoc;
  return e;
}

async function test(name, fn) {
  try { await fn(); }
  catch (e) { t.assert(false, `${name} — ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════
// Group D: CommonplaceEngine — Commit, Verify, Read (10)
// ═══════════════════════════════════════════════════════════════════

await test('CP-D1: commit seals one entry into a sealed day block', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  const prefix = await engine.commit([entry({ title: 'First note' })]);
  t.assert(typeof prefix === 'string', 'D1: prefix is a string');
  t.assertEq(await engine.getBlockCount(), 2, 'D1: count 2');
  t.assert(await engine.verify(), 'D1: verifies');
});

await test('CP-D2: commit groups entries by date into day-grouped blocks', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([
    entry({ title: 'A', timestampMs: 1699952400000 }), // 2023-11-14 09:00Z
    entry({ title: 'B', timestampMs: 1699959600000 }), // 2023-11-14 11:00Z
    entry({ title: 'C', timestampMs: 1699972200000 }), // 2023-11-14 14:30Z
  ]);
  await engine.commit([entry({ title: 'D', timestampMs: 1700040600000 })]); // 2023-11-15 09:30Z

  const blocks = await engine.getDayBlocks();
  t.assertEq(blocks.length, 2, 'D2: two day blocks');
  t.assertEq(blocks[0].entries.length, 3, 'D2: first day has 3 entries');
  t.assertEq(blocks[1].entries.length, 1, 'D2: second day has 1 entry');
});

await test('CP-D3: commit updates the chain tip after each append', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  const genHash = (await engine.getLastBlock()).block_hash;

  await engine.commit([entry({ title: 'First' })]);
  const firstTip = await engine.getLastBlock();
  t.assertNeq(firstTip.day_hash, genHash, 'D3: first day_hash differs from genesis hash');

  await engine.commit([entry({ title: 'Second', timestampMs: 1700090000000 })]);
  t.assertEq((await engine.getLastBlock()).prev_hash, firstTip.day_hash, 'D3: second block prev_hash == first tip');
});

await test('CP-D4: verify() is true after valid commits', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([entry({ title: 'A' })]);
  await engine.commit([entry({ title: 'B', timestampMs: 1700090000000 })]);
  t.assert(await engine.verify(), 'D4: verifies');
});

await test('CP-D5: verify() returns false after a middle block is swapped', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([entry({ title: 'First', timestampMs: 1700000000000 })]);
  await engine.commit([entry({ title: 'Second', timestampMs: 1700010000000 })]);
  await engine.commit([entry({ title: 'Third', timestampMs: 1700020000000 })]);
  t.assert(await engine.verify(), 'D5: valid before swap');

  const blocks = await engine.readAll();
  const middleIdx = 2; // genesis(0), day1(1), day2(2), day3(3)
  const middle = blocks[middleIdx];
  const swapped = await engine.chain.buildDayBlock(
    [entry({ title: 'Fake', timestampMs: 1700030000000 })],
    middle.prev_hash,
    middle.date,
  );
  const all = await engine.__store.get('commonplace:blocks');
  all[middleIdx] = swapped;
  await engine.__store.set('commonplace:blocks', all);

  t.assert(!(await engine.verify()), 'D5: verify detects swap');
});

await test('CP-D6: readEntries returns committed entries in order', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([
    entry({ title: 'Alpha', timestampMs: 1700000000000 }),
    entry({ title: 'Beta', timestampMs: 1700064000000 }),
  ]);

  const entries = await engine.readEntries();
  t.assertEq(entries.length, 2, 'D6: two entries');
  t.assertEq(entries[0].title, 'Alpha', 'D6: Alpha first');
  t.assertEq(entries[1].title, 'Beta', 'D6: Beta second');
});

await test('CP-D7: committing to the Commonplace chain does not touch the ledger', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([entry({ title: 'Isolated' })]);

  for (const b of await engine.readAll()) {
    t.assert(!(b.type === 'day' || b.type === 'genesis'), 'D7: no activity types');
    t.assert(b.type === 'commonplace_genesis' || b.type === 'commonplace', 'D7: only commonplace types');
  }
});

await test('CP-D8: commit does not leak plain:/unsealed staging rows into blocks', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([entry({ title: 'Clean commit' })]);

  for (const b of await engine.readAll()) {
    t.assert(!JSON.stringify(b).includes('plain:'), 'D8: no plain: rows');
    for (const e of (b.entries || [])) {
      t.assert(!('is_active' in e.data), 'D8: no is_active');
      t.assert(!('unsealed' in e.data), 'D8: no unsealed');
    }
  }
});

await test('CP-D9: an entry with no comment field seals normally', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  const e = entry({ title: 'No comment here', entry: 'just the text' });
  t.assert(!('comment' in e), 'D9: raw entry has no comment');
  await engine.commit([e]);

  const blocks = await engine.getDayBlocks();
  const sealedData = blocks[0].entries[0].data;
  t.assert(!('comment' in sealedData), 'D9: no comment');
  t.assert(!('comment_enc' in sealedData), 'D9: no comment_enc');
  t.assert(await engine.verify(), 'D9: verifies');
});

await test('CP-D10: a chain committed earlier-then-later verifies', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([entry({ title: 'Old', timestampMs: 1700000000000 })]);
  await engine.commit([entry({ title: 'New', timestampMs: 1700090000000 })]);
  t.assertEq((await engine.getDayBlocks()).length, 2, 'D10: two day blocks');
  t.assert(await engine.verify(), 'D10: verifies');
});

// ── Summary ─────────────────────────────────────────────────────────
t.summary('CommonplaceEngine');
process.exit(t.failed > 0 ? 1 : 0);
