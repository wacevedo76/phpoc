/**
 * commonplace_sync_e2e_test.mjs — Cross-device sync end-to-end test suite (Phase 2 RED).
 *
 * Group R (5) from docs/planning/COMMONPLACE_BOOK_SYNC_WEB_PHASE1.md.
 * Exercises the full push → transport → pull pipeline across two devices
 * (Device A writes, Device B reads through the same FakeSyncTransport).
 *
 * RED: targets the not-yet-created CommonplacePushService and
 * CommonplacePullService modules.
 *
 * Run: node test/commonplace_sync_e2e_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { CommonplaceChain } from '../src/commonplace/commonplace_chain.js';
import { CommonplaceStorage } from '../src/commonplace/commonplace_storage.js';
import { CommonplaceEngine } from '../src/commonplace/commonplace_engine.js';
import { CommonplacePushService } from '../src/commonplace/commonplace_push_service.js';
import { CommonplacePullService } from '../src/commonplace/commonplace_pull_service.js';
import {
  syncTestMkHex,
  syncWrongMkHex,
  makeCrypto,
  FakeSyncTransport,
  buildChain,
  rawEntry,
} from './commonplace_sync_test_support.mjs';

const t = new TestHelpers();

async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    t.assert(false, `${name} — ${e.message}`);
  }
}

// ── CPSW-R1 ────────────────────────────────────────────────────────
await test('CPSW-R1: Device B pulls Device A chain and reads identical entries', async () => {
  const cryptoA = makeCrypto();
  const chainA = await buildChain(cryptoA, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  const pushA = new CommonplacePushService({ crypto: cryptoA, transport, chain: chainA });

  const pushResult = await pushA.pushAll();
  t.assertEq(pushResult.pushed, 2, 'R1: A pushed 2');

  const cryptoB = makeCrypto(); // same MK
  const storeB = new MemoryBackend();
  const chainB = new CommonplaceChain(cryptoB, storeB, syncTestMkHex);
  const storageB = new CommonplaceStorage(storeB);
  const pullB = new CommonplacePullService({ crypto: cryptoB, transport, chain: chainB, storage: storageB });

  const pullResult = await pullB.pullAll();
  t.assertEq(pullResult.blocksPulled, 2, 'R1: B pulled 2');

  const entriesB = await new CommonplaceEngine(cryptoB, storeB, syncTestMkHex).readEntries();
  t.assertEq(entriesB.length, 1, 'R1: one entry');
  t.assertEq(entriesB[0].title, 'Title 0', 'R1: title');
  t.assertEq(entriesB[0].entry, 'Passage 0', 'R1: entry');
});

// ── CPSW-R2 ────────────────────────────────────────────────────────
await test('CPSW-R2: genesis-only Device B catches up to A day blocks', async () => {
  const crypto = makeCrypto();
  const chainA = await buildChain(crypto, { dayBlocks: 2 });
  const transport = new FakeSyncTransport();
  await new CommonplacePushService({ crypto, transport, chain: chainA }).pushAll();

  const storeB = new MemoryBackend();
  const chainB = await buildChain(crypto, { store: storeB, dayBlocks: 0 });
  const storageB = new CommonplaceStorage(storeB);
  const pullB = new CommonplacePullService({ crypto, transport, chain: chainB, storage: storageB });

  const result = await pullB.pullAll();

  t.assertEq(result.blocksPulled, 2, 'R2: 2 appended');
  t.assertEq(await chainB.getBlockCount(), 3, 'R2: genesis + 2 days');
  t.assertEq(
    (await new CommonplaceEngine(crypto, storeB, syncTestMkHex).readEntries()).length,
    2,
    'R2: 2 entries',
  );
});

// ── CPSW-R3 ────────────────────────────────────────────────────────
await test('CPSW-R3: empty Device B bootstraps A full chain', async () => {
  const crypto = makeCrypto();
  const chainA = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  await new CommonplacePushService({ crypto, transport, chain: chainA }).pushAll();

  const storeB = new MemoryBackend();
  const chainB = new CommonplaceChain(crypto, storeB, syncTestMkHex);
  const storageB = new CommonplaceStorage(storeB);
  await new CommonplacePullService({ crypto, transport, chain: chainB, storage: storageB }).pullAll();

  t.assertEq(await chainB.getBlockCount(), 2, 'R3: 2 blocks');
  const entries = await new CommonplaceEngine(crypto, storeB, syncTestMkHex).readEntries();
  t.assertEq(entries[0].title, 'Title 0', 'R3: title');
});

// ── CPSW-R4 ────────────────────────────────────────────────────────
await test('CPSW-R4: divergent Device B reports conflict and keeps its local chain', async () => {
  const crypto = makeCrypto();
  const chainA = await buildChain(crypto, { dayBlocks: 1 }); // "Title 0"
  const transport = new FakeSyncTransport();
  await new CommonplacePushService({ crypto, transport, chain: chainA }).pushAll();

  const storeB = new MemoryBackend();
  const chainB = await buildChain(crypto, { store: storeB, dayBlocks: 0 });
  const prevHash = chainB.getBlockHashFor(await chainB.getLastBlock());
  const divergent = await chainB.buildDayBlock(
    [rawEntry({ title: 'B-Title', entry: 'B-Passage' })],
    prevHash,
    '2026-08-31',
  );
  await chainB.append(divergent);
  const storageB = new CommonplaceStorage(storeB);
  const pullB = new CommonplacePullService({ crypto, transport, chain: chainB, storage: storageB });

  const result = await pullB.pullAll();

  t.assertEq(result.blocksPulled, 0, 'R4: nothing appended');
  t.assert(result.failedBlocks.length > 0, 'R4: conflict surfaced');
  t.assertEq(await chainB.getBlockCount(), 2, 'R4: local unchanged');
  const entries = await new CommonplaceEngine(crypto, storeB, syncTestMkHex).readEntries();
  t.assertEq(entries[0].title, 'B-Title', 'R4: local preserved');
});

// ── CPSW-R5 ────────────────────────────────────────────────────────
await test('CPSW-R5: wrong-MK device cannot decrypt pulled blocks', async () => {
  const cryptoA = makeCrypto();
  const chainA = await buildChain(cryptoA, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  await new CommonplacePushService({ crypto: cryptoA, transport, chain: chainA }).pushAll();

  const wrongCrypto = makeCrypto(syncWrongMkHex);
  const storeC = new MemoryBackend();
  const chainC = new CommonplaceChain(wrongCrypto, storeC, syncWrongMkHex);
  const storageC = new CommonplaceStorage(storeC);
  const pullC = new CommonplacePullService({ crypto: wrongCrypto, transport, chain: chainC, storage: storageC });

  const result = await pullC.pullAll();

  t.assertEq(result.blocksPulled, 0, 'R5: nothing imported');
  t.assert(result.failedBlocks.length > 0, 'R5: failedBlocks reported');
  t.assertEq(await chainC.getBlockCount(), 0, 'R5: chain empty');
});

t.summary('CommonplaceSyncE2E');
process.exit(t.failed > 0 ? 1 : 0);
