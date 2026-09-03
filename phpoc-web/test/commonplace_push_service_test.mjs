/**
 * commonplace_push_service_test.mjs — CommonplacePushService test suite (Phase 2 RED).
 *
 * Group P (9) from docs/planning/COMMONPLACE_BOOK_SYNC_WEB_PHASE1.md.
 * Pure Node tests on the KeyedMockCrypto + FakeSyncTransport harness.
 *
 * RED: targets the not-yet-created `src/commonplace/commonplace_push_service.js`
 * (CommonplacePushService). Every assertion here fails until that module exists
 * and its pushAll/pushBlocks methods pass.
 *
 * Run: node test/commonplace_push_service_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { CommonplaceChain } from '../src/commonplace/commonplace_chain.js';
import { CommonplacePushService } from '../src/commonplace/commonplace_push_service.js';
import {
  syncTestMkHex,
  makeCrypto,
  jsonSortNoSpaces,
  FakeSyncTransport,
  buildChain,
  commonplaceBlockPath,
  COMMONPLACE_HASH_INDEX,
  decodeStoredBlock,
  readHashIndex,
} from './commonplace_sync_test_support.mjs';

const t = new TestHelpers();

async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    t.assert(false, `${name} — ${e.message}`);
  }
}

// ── CPSW-P1 ────────────────────────────────────────────────────────
await test('CPSW-P1: pushAll pushes every block to commonplace/blocks/NNNNNN.json', async () => {
  const crypto = makeCrypto();
  const chain = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  const svc = new CommonplacePushService({ crypto, transport, chain });

  const result = await svc.pushAll();

  t.assertEq(result.pushed, 2, 'P1: two blocks pushed');
  t.assert(Array.isArray(result.failedBlocks) && result.failedBlocks.length === 0, 'P1: no failed blocks');
  t.assert(transport.store.has(commonplaceBlockPath(0)), 'P1: 6-digit index 0 present');
  t.assert(transport.store.has(commonplaceBlockPath(1)), 'P1: 6-digit index 1 present');

  const genesis = JSON.parse(decodeStoredBlock(transport, 0, crypto, syncTestMkHex));
  t.assertEq(genesis.type, 'commonplace_genesis', 'P1: genesis type');
  const day = JSON.parse(decodeStoredBlock(transport, 1, crypto, syncTestMkHex));
  t.assertEq(day.type, 'commonplace', 'P1: day type');
});

// ── CPSW-P2 ────────────────────────────────────────────────────────
await test('CPSW-P2: pushAll pushes plaintext hash_index of block hashes in order', async () => {
  const crypto = makeCrypto();
  const chain = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  const svc = new CommonplacePushService({ crypto, transport, chain });

  await svc.pushAll();

  const index = readHashIndex(transport);
  const blocks = await chain.readAll();
  t.assertEq(index.length, 2, 'P2: hash index length 2');
  t.assertEq(index[0], chain.getBlockHashFor(blocks[0]), 'P2: genesis hash');
  t.assertEq(index[1], chain.getBlockHashFor(blocks[1]), 'P2: day hash');
});

// ── CPSW-P3 ────────────────────────────────────────────────────────
await test('CPSW-P3: pushed block payload is sorted-keys compact JSON obfuscated with MK', async () => {
  const crypto = makeCrypto();
  const chain = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  const svc = new CommonplacePushService({ crypto, transport, chain });

  await svc.pushAll();

  const blocks = await chain.readAll();
  const decoded = decodeStoredBlock(transport, 1, crypto, syncTestMkHex);
  t.assertEq(decoded, jsonSortNoSpaces(blocks[1]), 'P3: round-trips jsonSortNoSpaces');
  // Compact separators only — no `": "` / `", "` (spaces inside encrypted
  // string values, e.g. "Passage 0", are legitimate and not separators).
  t.assertEq(decoded.includes(': ') || decoded.includes(', '), false, 'P3: no space separators in payload');
});

// ── CPSW-P4 ────────────────────────────────────────────────────────
await test('CPSW-P4: pushAll throws on an empty chain (no genesis)', async () => {
  const crypto = makeCrypto();
  const chain = new CommonplaceChain(crypto, new MemoryBackend(), syncTestMkHex);
  const svc = new CommonplacePushService({ crypto, transport: new FakeSyncTransport(), chain });

  await t.assertAsyncThrows(svc.pushAll(), 'P4: throws on empty chain');
});

// ── CPSW-P5 ────────────────────────────────────────────────────────
await test('CPSW-P5: pushAll throws when no master key is cached', async () => {
  const crypto = makeCrypto(null);
  const chain = new CommonplaceChain(crypto, new MemoryBackend(), null);
  const svc = new CommonplacePushService({ crypto, transport: new FakeSyncTransport(), chain });

  await t.assertAsyncThrows(svc.pushAll(), 'P5: throws without MK');
});

// ── CPSW-P6 ────────────────────────────────────────────────────────
await test('CPSW-P6: pushBlocks pushes an explicit block list at 0-based positions', async () => {
  const crypto = makeCrypto();
  const chain = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  const svc = new CommonplacePushService({ crypto, transport, chain });

  const result = await svc.pushBlocks(await chain.readAll());

  t.assertEq(result.pushed, 2, 'P6: two pushed');
  t.assert(transport.store.has(commonplaceBlockPath(0)), 'P6: path 0');
  t.assert(transport.store.has(commonplaceBlockPath(1)), 'P6: path 1');
  t.assertEq(readHashIndex(transport).length, 2, 'P6: hash index length 2');
});

// ── CPSW-P7 ────────────────────────────────────────────────────────
await test('CPSW-P7: repeated pushAll is idempotent — same paths overwritten', async () => {
  const crypto = makeCrypto();
  const chain = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  const svc = new CommonplacePushService({ crypto, transport, chain });

  const first = await svc.pushAll();
  const second = await svc.pushAll();

  t.assertEq(first.pushed, 2, 'P7: first pushed 2');
  t.assertEq(second.pushed, 2, 'P7: second pushed 2');
  t.assert(transport.store.has(commonplaceBlockPath(0)), 'P7: path 0');
  t.assert(transport.store.has(commonplaceBlockPath(1)), 'P7: path 1');
  t.assert(transport.store.has(COMMONPLACE_HASH_INDEX), 'P7: hash index present');
});

// ── CPSW-P8 ────────────────────────────────────────────────────────
await test('CPSW-P8: a failing block yields pushed + failedBlocks with failed index', async () => {
  const crypto = makeCrypto();
  const chain = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  transport.errorOnPushPath[commonplaceBlockPath(1)] = 500;
  const svc = new CommonplacePushService({ crypto, transport, chain });

  const result = await svc.pushAll();

  t.assertEq(result.pushed, 1, 'P8: genesis pushed');
  t.assert(result.failedBlocks.includes(1), 'P8: index 1 in failedBlocks');
  t.assert(transport.store.has(commonplaceBlockPath(0)), 'P8: block 0 present');
});

// ── CPSW-P9 ────────────────────────────────────────────────────────
await test('CPSW-P9: concurrent pushAll calls are serialized (single push pass)', async () => {
  const crypto = makeCrypto();
  const chain = await buildChain(crypto, { dayBlocks: 1 });
  const transport = new FakeSyncTransport();
  const svc = new CommonplacePushService({ crypto, transport, chain });

  const f1 = svc.pushAll();
  const f2 = svc.pushAll();
  const r1 = await f1;
  const r2 = await f2;

  t.assertEq(r1.pushed, 2, 'P9: r1 pushed 2');
  t.assertEq(r2.pushed, 2, 'P9: r2 pushed 2');
  t.assertEq(transport.pushCount, 3, 'P9: 2 blocks + 1 hash_index pushed exactly once');
});

t.summary('CommonplacePushService');
process.exit(t.failed > 0 ? 1 : 0);
