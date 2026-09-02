/**
 * commonplace_service_test.mjs — CommonplaceService + factory test suite (Phase 2 RED).
 *
 * Groups S (12) + V (3) from docs/planning/COMMONPLACE_BOOK_UI_WEB_PHASE1.md.
 * Pure Node tests on the MockCrypto + MemoryBackend + TestHelpers harness
 * (mirrors commonplace_engine_test.mjs). Targets the future
 * `src/commonplace/commonplace_service.js` API — `CommonplaceService` +
 * `createCommonplaceService` — which does not exist yet, so every test is RED.
 *
 * Run: node test/commonplace_service_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { MockCrypto } from './mock_crypto.mjs';
import { TestHelpers } from './test_helpers.mjs';
import {
  CommonplaceService,
  createCommonplaceService,
} from '../src/commonplace/commonplace_service.js';

const t = new TestHelpers();

const MASTER_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const IDENTITY_SECRET = 'identity-secret-32-bytes-xxxxxx';

const GENESIS_OPTS = {
  username: 'testuser',
  email: 'test@example.com',
  recoverySeedEnc: 'encrypted-seed',
  identityPubKey: 'pub-key-hex',
  identitySecretEncFallback: 'fallback-hex',
};

// ── Helpers ────────────────────────────────────────────────────────

function makeCrypto() {
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  return crypto;
}

function makeService({ identitySecret = IDENTITY_SECRET } = {}) {
  const store = new MemoryBackend();
  const crypto = makeCrypto();
  const service = createCommonplaceService({
    crypto,
    store,
    masterKey: MASTER_KEY,
    identitySecret,
  });
  // Test backdoor to inspect the raw block store (mirrors engine __store).
  service.__store = store;
  service.__crypto = crypto;
  return service;
}

async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    t.assert(false, `${name} — ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Group S: CommonplaceService — read / add / verify / tag index (12)
// ═══════════════════════════════════════════════════════════════════

await test('S1: readEntries() returns committed entries decrypted, in chain order', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'Alpha', entry: 'first passage', tags: ['a'] });
  await service.addEntry({ title: 'Beta', entry: 'second passage', tags: ['b'] });

  const entries = await service.readEntries();
  t.assertEq(entries.length, 2, 'S1: two entries');
  t.assertEq(entries[0].title, 'Alpha', 'S1: Alpha first');
  t.assertEq(entries[1].title, 'Beta', 'S1: Beta second');
  // Decrypted (not ciphertext) — the MockCrypto ciphertext carries an "enc:" prefix.
  t.assert(!String(entries[0].title).includes('enc:'), 'S1: title decrypted');
});

await test('S2: readEntries() returns [] on a fresh (genesis-only) chain', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  const entries = await service.readEntries();
  t.assertEq(entries.length, 0, 'S2: no entries');
});

await test('S3: addEntry seals a single Commonplace day block', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'First note', entry: 'passage', tags: [] });

  t.assertEq(await service.getEntryCount(), 1, 'S3: one entry');
  const lastHash = await service.getLastHash();
  t.assert(typeof lastHash === 'string' && lastHash.length > 0, 'S3: last hash present');
  const blocks = await service.__store.get('commonplace:blocks');
  t.assertEq(blocks.length, 2, 'S3: genesis + one day block');
  t.assertEq(blocks[1].type, 'commonplace', 'S3: second block is a commonplace day block');
});

await test('S4: addEntry records timestamp_ms (now) and date derived from it', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  const before = Date.now();
  await service.addEntry({ title: 'Timed', entry: 'passage', tags: [] });
  const after = Date.now();

  const [entry] = await service.readEntries();
  t.assert(entry.timestamp_ms >= before && entry.timestamp_ms <= after, 'S4: timestamp_ms is now');
  t.assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.date), 'S4: date is YYYY-MM-DD');
});

await test('S5: addEntry stores the passage in the entry field (never comment)', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'No comment', entry: 'the passage text', tags: [] });

  const [entry] = await service.readEntries();
  t.assertEq(entry.entry, 'the passage text', 'S5: entry holds the passage');
  t.assert(!('comment' in entry), 'S5: no comment field');
  t.assert(!('comment_enc' in entry), 'S5: no comment_enc field');
});

await test('S6: addEntry with an adHoc map preserves all k/v pairs on read-back', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({
    title: 'Annotated',
    entry: 'passage',
    tags: [],
    adHoc: { note: 'born 1844', page: 42 },
  });

  const [entry] = await service.readEntries();
  t.assertDeepEq(entry.ad_hoc, { note: 'born 1844', page: 42 }, 'S6: ad_hoc round-trips');
});

await test('S7: addEntry tags persist and are returned lower-cased/trimmed/deduped', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({
    title: 'Tagged',
    entry: 'passage',
    tags: ['  Topic ', 'TOPIC', 'Philosophy', ''],
  });

  const [entry] = await service.readEntries();
  t.assertDeepEq(entry.tags, ['topic', 'philosophy'], 'S7: normalized + deduped tags');
});

await test('S8: verify() returns true after a series of addEntry calls', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'One', entry: 'p1', tags: ['t'] });
  await service.addEntry({ title: 'Two', entry: 'p2', tags: ['t'] });
  await service.addEntry({ title: 'Three', entry: 'p3', tags: [] });
  t.assert(await service.verify(), 'S8: verifies');
});

await test('S9: verify() returns false if a committed block is tampered with', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'Will tamper', entry: 'passage', tags: [] });
  t.assert(await service.verify(), 'S9: valid before tamper');

  const blocks = await service.__store.get('commonplace:blocks');
  // Mutate the first day block's encrypted title — breaks both the entry hash
  // and content hash, and (entries is in the seal whitelist) the block seal.
  blocks[1].entries[0].data.title_enc = 'deadbeef';
  await service.__store.set('commonplace:blocks', blocks);

  t.assert(!(await service.verify()), 'S9: verify detects tamper');
});

await test('S10: ensureGenesis creates a fresh genesis for a missing chain', async () => {
  const service = makeService(); // no genesis yet
  const blocksBefore = await service.__store.get('commonplace:blocks');
  t.assert(blocksBefore === undefined || blocksBefore.length === 0, 'S10: chain absent');

  await service.ensureGenesis(GENESIS_OPTS);
  const blocks = await service.__store.get('commonplace:blocks');
  t.assertEq(blocks.length, 1, 'S10: one genesis block');
  t.assertEq(blocks[0].type, 'commonplace_genesis', 'S10: genesis type');
});

await test('S11: ensureGenesis does not duplicate genesis if one already exists', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  const first = await service.__store.get('commonplace:blocks');

  await service.ensureGenesis(GENESIS_OPTS);
  const second = await service.__store.get('commonplace:blocks');
  t.assertEq(second.length, 1, 'S11: still one block');
  t.assertEq(second[0].block_hash, first[0].block_hash, 'S11: genesis unchanged');
});

await test('S12: buildTagIndex() returns tag frequencies from committed entries', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'A', entry: 'p', tags: ['topic', 'philosophy'] });
  await service.addEntry({ title: 'B', entry: 'p', tags: ['topic'] });
  await service.addEntry({ title: 'C', entry: 'p', tags: [] });

  const idx = await service.buildTagIndex();
  t.assertEq(idx.topic, 2, 'S12: topic count 2');
  t.assertEq(idx.philosophy, 1, 'S12: philosophy count 1');
  t.assertEq(idx.untagged, 1, 'S12: untagged count 1');
});

// ═══════════════════════════════════════════════════════════════════
// Group V: Service factory wiring (3)
// ═══════════════════════════════════════════════════════════════════

await test('V1: createCommonplaceService resolves a CommonplaceService bound to store + crypto', async () => {
  const store = new MemoryBackend();
  const crypto = makeCrypto();
  const service = createCommonplaceService({ crypto, store, masterKey: MASTER_KEY });

  t.assert(service instanceof CommonplaceService, 'V1: correct type');
  t.assert(service.store === store, 'V1: bound to the given store');
  t.assert(service.crypto === crypto, 'V1: bound to the given crypto');

  // The bound store is the one actually written to (not a hidden default).
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'Wired', entry: 'p', tags: [] });
  const blocks = await store.get('commonplace:blocks');
  t.assertEq(blocks.length, 2, 'V1: writes landed in the injected store');
});

await test('V2: the factory is overridable in tests (in-memory MemoryBackend)', async () => {
  // Two services over two in-memory stores are fully isolated — the factory
  // is store-agnostic, so tests can inject a fake store per service.
  const serviceA = makeService({ identitySecret: 'identity-a' });
  const serviceB = makeService({ identitySecret: 'identity-b' });

  await serviceA.ensureGenesis(GENESIS_OPTS);
  await serviceA.addEntry({ title: 'Only in A', entry: 'p', tags: ['a'] });

  t.assertEq(await serviceA.getEntryCount(), 1, 'V2: A has its entry');
  t.assertEq(await serviceB.getEntryCount(), 0, 'V2: B is isolated');
  // A fresh (never-written) chain is absent from the store — the MemoryBackend
  // returns `undefined` for an unset key. This matches S10's contract above and
  // the Flutter reference (block count 0 on a fresh chain); it is NOT an empty
  // array unless something materializes it.
  const blocksB = await serviceB.__store.get('commonplace:blocks');
  t.assert(blocksB === undefined || blocksB.length === 0, 'V2: B store untouched');
});

await test('V3: CommonplaceService uses the shared CryptoService (same MK as the ledger)', async () => {
  const crypto = makeCrypto(); // setMasterKey(MASTER_KEY) — the shared ledger MK
  const store = new MemoryBackend();
  const service = createCommonplaceService({ crypto, store, masterKey: MASTER_KEY });

  t.assertEq(service.engine.masterKey, MASTER_KEY, 'V3: engine uses the shared MK');
  t.assertEq(crypto.getMasterKey(), service.engine.masterKey, 'V3: same MK as the crypto');

  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'Shared MK', entry: 'p', tags: [] });
  t.assert(await service.verify(), 'V3: seals + verifies under the shared MK');
});

// ── Summary ─────────────────────────────────────────────────────────
t.summary('CommonplaceService');
process.exit(t.failed > 0 ? 1 : 0);
