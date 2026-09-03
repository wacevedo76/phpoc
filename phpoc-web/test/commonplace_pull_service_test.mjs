/**
 * commonplace_pull_service_test.mjs — CommonplacePullService test suite (Phase 2 RED).
 *
 * Group L (10) from docs/planning/COMMONPLACE_BOOK_SYNC_WEB_PHASE1.md.
 * Pure Node tests on the KeyedMockCrypto + FakeSyncTransport harness.
 *
 * RED: targets the not-yet-created `src/commonplace/commonplace_pull_service.js`
 * (CommonplacePullService). Every assertion here fails until that module exists
 * and its pullAll/pullIfRemoteHasMore methods pass.
 *
 * Run: node test/commonplace_pull_service_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { base64ToBytes } from '../src/sync/base64.js';
import { TestHelpers } from './test_helpers.mjs';
import { CommonplaceChain } from '../src/commonplace/commonplace_chain.js';
import { CommonplaceStorage } from '../src/commonplace/commonplace_storage.js';
import { CommonplaceEngine } from '../src/commonplace/commonplace_engine.js';
import { CommonplacePullService } from '../src/commonplace/commonplace_pull_service.js';
import {
  syncTestMkHex,
  syncWrongMkHex,
  makeCrypto,
  jsonSortNoSpaces,
  FakeSyncTransport,
  buildChain,
  rawEntry,
  seedRemoteChain,
  commonplaceBlockPath,
  COMMONPLACE_HASH_INDEX,
} from './commonplace_sync_test_support.mjs';

const t = new TestHelpers();

async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    t.assert(false, `${name} — ${e.message}`);
  }
}

// ── CPSW-L1 ────────────────────────────────────────────────────────
await test('CPSW-L1: pullAll returns blocksPulled 0 when no remote hash_index exists', async () => {
  const crypto = makeCrypto();
  const store = new MemoryBackend();
  const chain = new CommonplaceChain(crypto, store, syncTestMkHex);
  const storage = new CommonplaceStorage(store);
  const svc = new CommonplacePullService({ crypto, transport: new FakeSyncTransport(), chain, storage });

  const result = await svc.pullAll();

  t.assertEq(result.blocksPulled, 0, 'L1: 0 blocks pulled');
  t.assert(Array.isArray(result.failedBlocks) && result.failedBlocks.length === 0, 'L1: no failures');
});

// ── CPSW-L2 ────────────────────────────────────────────────────────
await test('CPSW-L2: pullAll discovers block count from commonplace/hash_index.json', async () => {
  const crypto = makeCrypto();
  const remote = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  await seedRemoteChain(transport, remote, crypto, syncTestMkHex);
  const store = new MemoryBackend();
  const chain = new CommonplaceChain(crypto, store, syncTestMkHex);
  const storage = new CommonplaceStorage(store);
  const svc = new CommonplacePullService({ crypto, transport, chain, storage });

  const result = await svc.pullAll();

  t.assertEq(result.blocksPulled, 2, 'L2: 2 blocks pulled');
});

// ── CPSW-L3 ────────────────────────────────────────────────────────
await test('CPSW-L3: pullAll pulls discovered blocks in ascending index order', async () => {
  const crypto = makeCrypto();
  const remote = await buildChain(crypto, { dayBlocks: 2 });
  const transport = new FakeSyncTransport();
  await seedRemoteChain(transport, remote, crypto, syncTestMkHex);
  const store = new MemoryBackend();
  const chain = new CommonplaceChain(crypto, store, syncTestMkHex);
  const storage = new CommonplaceStorage(store);
  const svc = new CommonplacePullService({ crypto, transport, chain, storage });

  const result = await svc.pullAll();

  t.assertEq(result.blocksPulled, 3, 'L3: 3 blocks pulled');
  const imported = await chain.readAll();
  t.assertEq(imported.length, 3, 'L3: 3 blocks imported');
  t.assertEq(imported[0].type, 'commonplace_genesis', 'L3: genesis first');
  t.assertEq(imported[1].type, 'commonplace', 'L3: day 1');
  t.assertEq(imported[2].type, 'commonplace', 'L3: day 2');
});

// ── CPSW-L4 ────────────────────────────────────────────────────────
await test('CPSW-L4: pulled blocks deobfuscated + parsed into readable entries', async () => {
  const crypto = makeCrypto();
  const remote = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  await seedRemoteChain(transport, remote, crypto, syncTestMkHex);
  const store = new MemoryBackend();
  const chain = new CommonplaceChain(crypto, store, syncTestMkHex);
  const storage = new CommonplaceStorage(store);
  const svc = new CommonplacePullService({ crypto, transport, chain, storage });

  const result = await svc.pullAll();

  t.assertEq(result.blocksPulled, 2, 'L4: 2 blocks pulled');
  const entries = await new CommonplaceEngine(crypto, store, syncTestMkHex).readEntries();
  t.assertEq(entries.length, 1, 'L4: one entry');
  t.assertEq(entries[0].title, 'Title 0', 'L4: title');
  t.assertEq(entries[0].entry, 'Passage 0', 'L4: entry');
});

// ── CPSW-L5 ────────────────────────────────────────────────────────
await test('CPSW-L5: wrong MK fails deobfuscation — failedBlocks reported, nothing imported', async () => {
  const crypto = makeCrypto();
  const remote = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  await seedRemoteChain(transport, remote, crypto, syncTestMkHex);

  const wrongCrypto = makeCrypto(syncWrongMkHex);
  const store = new MemoryBackend();
  const chain = new CommonplaceChain(wrongCrypto, store, syncWrongMkHex);
  const storage = new CommonplaceStorage(store);
  const svc = new CommonplacePullService({ crypto: wrongCrypto, transport, chain, storage });

  const result = await svc.pullAll();

  t.assert(result.failedBlocks.length > 0, 'L5: failedBlocks non-empty');
  t.assertEq(result.blocksPulled, 0, 'L5: nothing pulled');
  t.assertEq(await chain.getBlockCount(), 0, 'L5: nothing imported');
});

// ── CPSW-L6 ────────────────────────────────────────────────────────
await test('CPSW-L6: remote chain whose first block is not commonplace_genesis rejected before import', async () => {
  const crypto = makeCrypto();
  const src = new CommonplaceChain(crypto, new MemoryBackend(), syncTestMkHex);
  const day = await src.buildDayBlock([rawEntry()], '0'.repeat(64), '2026-08-31');

  const transport = new FakeSyncTransport();
  transport.store.set(
    COMMONPLACE_HASH_INDEX,
    new TextEncoder().encode(JSON.stringify([src.getBlockHashFor(day)])),
  );
  transport.store.set(
    commonplaceBlockPath(0),
    base64ToBytes(crypto.obfuscateBlob(jsonSortNoSpaces(day), syncTestMkHex)),
  );

  const store = new MemoryBackend();
  const chain = new CommonplaceChain(crypto, store, syncTestMkHex);
  const storage = new CommonplaceStorage(store);
  const svc = new CommonplacePullService({ crypto, transport, chain, storage });

  const result = await svc.pullAll();

  t.assertEq(result.blocksPulled, 0, 'L6: nothing imported');
  t.assert(result.failedBlocks.length > 0, 'L6: rejection surfaced');
  t.assertEq(await chain.getBlockCount(), 0, 'L6: chain empty');
});

// ── CPSW-L7 ────────────────────────────────────────────────────────
await test('CPSW-L7: chain with broken prev_hash linkage rejected before import', async () => {
  const crypto = makeCrypto();
  const src = new CommonplaceChain(crypto, new MemoryBackend(), syncTestMkHex);
  await src.buildGenesis({
    username: 'u',
    email: 'e@example.com',
    recoverySeedEnc: 's',
    identityPubKey: 'p',
    identitySecretEncFallback: 'f',
  });
  const genesis = (await src.readAll())[0];
  const day = await src.buildDayBlock([rawEntry()], 'f'.repeat(64), '2026-08-31'); // wrong prev_hash

  const transport = new FakeSyncTransport();
  transport.store.set(
    COMMONPLACE_HASH_INDEX,
    new TextEncoder().encode(JSON.stringify([src.getBlockHashFor(genesis), src.getBlockHashFor(day)])),
  );
  transport.store.set(commonplaceBlockPath(0), base64ToBytes(crypto.obfuscateBlob(jsonSortNoSpaces(genesis), syncTestMkHex)));
  transport.store.set(commonplaceBlockPath(1), base64ToBytes(crypto.obfuscateBlob(jsonSortNoSpaces(day), syncTestMkHex)));

  const store = new MemoryBackend();
  const chain = new CommonplaceChain(crypto, store, syncTestMkHex);
  const storage = new CommonplaceStorage(store);
  const svc = new CommonplacePullService({ crypto, transport, chain, storage });

  const result = await svc.pullAll();

  t.assertEq(result.blocksPulled, 0, 'L7: nothing imported');
  t.assert(result.failedBlocks.length > 0, 'L7: rejection surfaced');
  t.assertEq(await chain.getBlockCount(), 0, 'L7: chain empty');
});

// ── CPSW-L8 ────────────────────────────────────────────────────────
await test('CPSW-L8: valid chain imports — fresh bootstraps, existing appends', async () => {
  const crypto = makeCrypto();
  const remote = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  await seedRemoteChain(transport, remote, crypto, syncTestMkHex);

  // L8a: fresh local bootstraps the full chain.
  const freshStore = new MemoryBackend();
  const fresh = new CommonplaceChain(crypto, freshStore, syncTestMkHex);
  const svcFresh = new CommonplacePullService({
    crypto,
    transport,
    chain: fresh,
    storage: new CommonplaceStorage(freshStore),
  });
  const r1 = await svcFresh.pullAll();
  t.assertEq(r1.blocksPulled, 2, 'L8a: 2 pulled');
  t.assertEq(await fresh.getBlockCount(), 2, 'L8a: fresh has 2 blocks');

  // L8b: existing local (genesis only, same genesis) appends the day block.
  const existingStore = new MemoryBackend();
  const existing = await buildChain(crypto, { store: existingStore, dayBlocks: 0 });
  const svcExisting = new CommonplacePullService({
    crypto,
    transport,
    chain: existing,
    storage: new CommonplaceStorage(existingStore),
  });
  const r2 = await svcExisting.pullAll();
  t.assertEq(r2.blocksPulled, 1, 'L8b: 1 appended');
  t.assertEq(await existing.getBlockCount(), 2, 'L8b: existing has 2 blocks');
});

// ── CPSW-L9 ────────────────────────────────────────────────────────
await test('CPSW-L9: throws without MK; returns blocksPulled 0 with null transport', async () => {
  const noMk = makeCrypto(null);
  const store1 = new MemoryBackend();
  const chain1 = new CommonplaceChain(noMk, store1, null);
  const svc1 = new CommonplacePullService({
    crypto: noMk,
    transport: new FakeSyncTransport(),
    chain: chain1,
    storage: new CommonplaceStorage(store1),
  });
  await t.assertAsyncThrows(svc1.pullAll(), 'L9: throws without MK');

  const withMk = makeCrypto();
  const store2 = new MemoryBackend();
  const chain2 = new CommonplaceChain(withMk, store2, syncTestMkHex);
  const svc2 = new CommonplacePullService({
    crypto: withMk,
    transport: null,
    chain: chain2,
    storage: new CommonplaceStorage(store2),
  });
  const result = await svc2.pullAll();
  t.assertEq(result.blocksPulled, 0, 'L9: null transport → 0');
  t.assert(Array.isArray(result.failedBlocks) && result.failedBlocks.length === 0, 'L9: no failures');
});

// ── CPSW-L10 ───────────────────────────────────────────────────────
await test('CPSW-L10: fewer blocks than hash_index expects → missing indices in failedBlocks', async () => {
  const crypto = makeCrypto();
  const remote = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  await seedRemoteChain(transport, remote, crypto, syncTestMkHex);
  transport.store.delete(commonplaceBlockPath(1)); // partial remote

  const store = new MemoryBackend();
  const chain = new CommonplaceChain(crypto, store, syncTestMkHex);
  const storage = new CommonplaceStorage(store);
  const svc = new CommonplacePullService({ crypto, transport, chain, storage });

  const result = await svc.pullAll();

  t.assert(result.failedBlocks.includes(1), 'L10: index 1 in failedBlocks');
});

t.summary('CommonplacePullService');
process.exit(t.failed > 0 ? 1 : 0);
