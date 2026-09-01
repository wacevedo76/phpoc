/**
 * commonplace_storage_test.mjs — CommonplaceStorage test suite (Phase 2 RED).
 *
 * Group E (9 assertions) from docs/planning/COMMONPLACE_BOOK_WEB_PHASE1.md.
 * Mirrors the Flutter commonplace_storage_test.dart contract, adapted to the
 * web decision #2: CommonplaceStorage is export/import persistence only — the
 * StorageBackend already fills the block-store role. The portable shape
 * {"type":"commonplace_chain","genesis":…,"blocks":[…] } lives under key
 * "commonplace:export"; the live chain lives under "commonplace:blocks".
 *
 * Run: node test/commonplace_storage_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { MockCrypto } from './mock_crypto.mjs';
import { TestHelpers } from './test_helpers.mjs';
import { CommonplaceEngine } from '../src/commonplace/commonplace_engine.js';
import { CommonplaceChain } from '../src/commonplace/commonplace_chain.js';
import { CommonplaceStorage } from '../src/commonplace/commonplace_storage.js';

const t = new TestHelpers();

const MASTER_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const IDENTITY_SECRET = 'identity-secret-32-bytes-xxxxxx';

// ── Helpers ────────────────────────────────────────────────────────

function makeCrypto() {
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  return crypto;
}

const GENESIS_OPTS = {
  username: 'u',
  email: 'u@e.com',
  recoverySeedEnc: 'seed',
  identityPubKey: 'pk',
  identitySecretEncFallback: 'fb',
};

function makeEngine(store) {
  return new CommonplaceEngine(makeCrypto(), store, MASTER_KEY, IDENTITY_SECRET);
}

function entry({ title }) {
  return { title, tags: ['topic'], entry: 'some passage', timestamp_ms: 1700000000000 };
}

async function test(name, fn) {
  try { await fn(); }
  catch (e) { t.assert(false, `${name} — ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════
// Group E: CommonplaceStorage — Separate-File Persistence (9)
// ═══════════════════════════════════════════════════════════════════

await test('CP-E1: load() reads a commonplace export as a chain structure', async () => {
  const store = new MemoryBackend();
  const engine = makeEngine(store);
  await engine.buildGenesis(GENESIS_OPTS);
  await engine.commit([entry({ title: 'Persisted note' })]);

  const storage = new CommonplaceStorage(store);
  await storage.save();

  // Simulate a fresh load: keep the export, drop the live chain.
  await store.delete('commonplace:blocks');
  await storage.load();
  const blocks = await store.get('commonplace:blocks');
  t.assert(Array.isArray(blocks) && blocks.length >= 2, 'E1: chain structure reloaded');
});

await test('CP-E2: save() writes a standalone, importable export shape', async () => {
  const store = new MemoryBackend();
  const engine = makeEngine(store);
  await engine.buildGenesis(GENESIS_OPTS);
  const storage = new CommonplaceStorage(store);
  await storage.save();

  const exported = await store.get('commonplace:export');
  t.assert(exported !== null && exported !== undefined, 'E2: export written');
  t.assertEq(exported.type, 'commonplace_chain', 'E2: type marker');
  t.assert('genesis' in exported && 'blocks' in exported, 'E2: genesis + blocks present');
});

await test('CP-E3: a saved-and-reloaded chain verifies identically', async () => {
  const store = new MemoryBackend();
  const crypto = makeCrypto();
  const engine = new CommonplaceEngine(crypto, store, MASTER_KEY, IDENTITY_SECRET);
  await engine.buildGenesis(GENESIS_OPTS);
  await engine.commit([entry({ title: 'Round trip' })]);
  t.assert(await engine.verify(), 'E3: valid before save');
  const originalHash = engine.chain.getBlockHashFor(await engine.getLastBlock());

  const storage = new CommonplaceStorage(store);
  await storage.save();
  await store.delete('commonplace:blocks');
  await storage.load();

  const loadedChain = new CommonplaceChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);
  t.assert(await loadedChain.verify(), 'E3: verifies after reload');
  t.assertEq(loadedChain.getBlockHashFor(await loadedChain.getLastBlock()), originalHash, 'E3: hash preserved');
});

await test('CP-E4: the export contains no staging rows', async () => {
  const store = new MemoryBackend();
  const engine = makeEngine(store);
  await engine.buildGenesis(GENESIS_OPTS);
  await engine.commit([entry({ title: 'Clean' })]);
  const storage = new CommonplaceStorage(store);
  await storage.save();

  const json = JSON.stringify(await store.get('commonplace:export'));
  t.assert(!json.includes('staging'), 'E4: no staging');
  t.assert(!json.includes('plain:'), 'E4: no plain:');
  t.assert(!json.includes('unsealed'), 'E4: no unsealed');
});

await test('CP-E5: loading a missing export yields a fresh (genesis-able) chain', async () => {
  const store = new MemoryBackend(); // no export key present
  const storage = new CommonplaceStorage(store);
  await storage.load(); // must no-op, not throw

  const chain = new CommonplaceChain(makeCrypto(), store, MASTER_KEY, IDENTITY_SECRET);
  await chain.buildGenesis(GENESIS_OPTS);
  t.assertEq(await chain.getBlockCount(), 1, 'E5: fresh genesis builds');
});

await test('CP-E6: loading a corrupt export surfaces an error, not a crash', async () => {
  const store = new MemoryBackend();
  await store.set('commonplace:export', '{ not valid json !!');
  const storage = new CommonplaceStorage(store);
  let threwReal = false;
  try { await storage.load(); } catch (e) {
    // Distinguish a real corrupt-data error from the Phase 2 stub's
    // "not implemented" throw so this test is cleanly RED in Phase 2.
    threwReal = !String(e.message).includes('not implemented');
  }
  t.assert(threwReal, 'E6: load throws a real error on corrupt export');
});

await test('CP-E7: export content is encrypted at rest (no plaintext fields)', async () => {
  const store = new MemoryBackend();
  const engine = makeEngine(store);
  await engine.buildGenesis(GENESIS_OPTS);
  await engine.commit([entry({ title: 'TopSecretPassageTitle' })]);

  const storage = new CommonplaceStorage(store);
  await storage.save();
  const json = JSON.stringify(await store.get('commonplace:export'));
  t.assert(json.includes('_enc'), 'E7: encrypted fields present');

  // MockCrypto embeds plaintext inside its ciphertext, so instead of asserting
  // the string is absent we assert the plaintext *field* is replaced by *_enc.
  const blocks = await store.get('commonplace:blocks');
  const data = blocks[blocks.length - 1].entries[0].data;
  t.assert(!('title' in data), 'E7: no plaintext title field');
  t.assert(typeof data.title_enc === 'string' && data.title_enc.includes('enc:'), 'E7: title_enc encrypted');
  t.assert(data.title_enc !== 'TopSecretPassageTitle', 'E7: title_enc not plaintext');
});

await test('CP-E8: the storage key is decoupled from master-key derivation', async () => {
  const store = new MemoryBackend();
  // Constructor takes no master key — structural decoupling.
  const storage = new CommonplaceStorage(store);

  const chain = new CommonplaceChain(makeCrypto(), store, MASTER_KEY, IDENTITY_SECRET);
  const gen = await chain.buildGenesis(GENESIS_OPTS);
  t.assertEq(gen.prev_hash, '0'.repeat(64), 'E8: genesis derivation independent of storage');

  await storage.save();
  t.assert(await store.get('commonplace:export') !== undefined, 'E8: export under fixed key');
});

await test('CP-E9: the shared MK decrypts an existing export', async () => {
  const store = new MemoryBackend();
  const writer = makeCrypto();
  const engine = new CommonplaceEngine(writer, store, MASTER_KEY, IDENTITY_SECRET);
  await engine.buildGenesis(GENESIS_OPTS);
  await engine.commit([entry({ title: 'Reauth note' })]);

  const storage = new CommonplaceStorage(store);
  await storage.save();
  await store.delete('commonplace:blocks');
  await storage.load();

  const reader = makeCrypto(); // second instance, same MK
  const loadedChain = new CommonplaceChain(reader, store, MASTER_KEY, IDENTITY_SECRET);
  t.assert(await loadedChain.verify(), 'E9: verifies with re-derived MK');
});

// ── Summary ─────────────────────────────────────────────────────────
t.summary('CommonplaceStorage');
process.exit(t.failed > 0 ? 1 : 0);
