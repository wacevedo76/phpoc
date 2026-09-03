/**
 * commonplace_reconcile_test.mjs — Freshness + reconcile test suite (Phase 2 RED).
 *
 * Group F (7) from docs/planning/COMMONPLACE_BOOK_SYNC_WEB_PHASE1.md.
 *   F1–F3: CommonplacePullService.pullIfRemoteHasMore (remote-has-more check)
 *   F4–F7: CommonplaceService.reconcileRemoteChain (local↔remote merge)
 *
 * RED: `CommonplacePullService` (module) and
 * `CommonplaceService.reconcileRemoteChain` (method) do not exist yet.
 *
 * Run: node test/commonplace_reconcile_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { CommonplaceChain } from '../src/commonplace/commonplace_chain.js';
import { CommonplaceStorage } from '../src/commonplace/commonplace_storage.js';
import { CommonplaceService } from '../src/commonplace/commonplace_service.js';
import { CommonplacePullService } from '../src/commonplace/commonplace_pull_service.js';
import {
  syncTestMkHex,
  makeCrypto,
  FakeSyncTransport,
  buildChain,
  rawEntry,
  seedRemoteChain,
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

/** Build a pull service over a fresh local chain + storage for freshness tests. */
function makePullService(crypto, transport) {
  const store = new MemoryBackend();
  const chain = new CommonplaceChain(crypto, store, syncTestMkHex);
  const storage = new CommonplaceStorage(store);
  return new CommonplacePullService({ crypto, transport, chain, storage });
}

// ── CPSW-F1 ────────────────────────────────────────────────────────
await test('CPSW-F1: pullIfRemoteHasMore returns 0 when remote hash_index absent or empty', async () => {
  const crypto = makeCrypto();

  const absent = makePullService(crypto, new FakeSyncTransport());
  t.assertEq(
    (await absent.pullIfRemoteHasMore({ localBlockCount: 0 })).blocksPulled,
    0,
    'F1: absent hash_index → 0',
  );

  const emptyT = new FakeSyncTransport();
  emptyT.store.set(COMMONPLACE_HASH_INDEX, new TextEncoder().encode('[]'));
  const empty = makePullService(crypto, emptyT);
  t.assertEq(
    (await empty.pullIfRemoteHasMore({ localBlockCount: 0 })).blocksPulled,
    0,
    'F1: empty hash_index → 0',
  );
});

// ── CPSW-F2 ────────────────────────────────────────────────────────
await test('CPSW-F2: pullIfRemoteHasMore returns 0 when remote count ≤ local', async () => {
  const crypto = makeCrypto();
  const remote = await buildChain(crypto, { dayBlocks: 1 }); // 2 blocks
  const transport = new FakeSyncTransport();
  await seedRemoteChain(transport, remote, crypto, syncTestMkHex);
  const svc = makePullService(crypto, transport);

  t.assertEq((await svc.pullIfRemoteHasMore({ localBlockCount: 2 })).blocksPulled, 0, 'F2: count 2 → 0');
  t.assertEq((await svc.pullIfRemoteHasMore({ localBlockCount: 5 })).blocksPulled, 0, 'F2: count 5 → 0');
});

// ── CPSW-F3 ────────────────────────────────────────────────────────
await test('CPSW-F3: pullIfRemoteHasMore returns N when remote count > local', async () => {
  const crypto = makeCrypto();
  const remote = await buildChain(crypto, { dayBlocks: 1 }); // 2 blocks
  const transport = new FakeSyncTransport();
  await seedRemoteChain(transport, remote, crypto, syncTestMkHex);
  const svc = makePullService(crypto, transport);

  t.assertEq((await svc.pullIfRemoteHasMore({ localBlockCount: 1 })).blocksPulled, 1, 'F3: count 1 → 1');
  t.assertEq((await svc.pullIfRemoteHasMore({ localBlockCount: 0 })).blocksPulled, 2, 'F3: count 0 → 2');
});

// ── CPSW-F4 ────────────────────────────────────────────────────────
await test('CPSW-F4: reconcileRemoteChain skips identical remote blocks', async () => {
  const crypto = makeCrypto();
  const store = new MemoryBackend();
  const localChain = await buildChain(crypto, { store, dayBlocks: 1 });
  const service = new CommonplaceService(crypto, store, syncTestMkHex);

  const remoteBlocks = JSON.parse(JSON.stringify(await localChain.readAll()));

  const result = await service.reconcileRemoteChain(remoteBlocks);

  t.assertEq(result.appended, 0, 'F4: appended 0');
  t.assertEq(result.hasConflicts, false, 'F4: no conflicts');
  t.assertEq(await localChain.getBlockCount(), 2, 'F4: local unchanged');
});

// ── CPSW-F5 ────────────────────────────────────────────────────────
await test('CPSW-F5: reconcileRemoteChain appends a bridging remote tail', async () => {
  const crypto = makeCrypto();
  const store = new MemoryBackend();
  const localChain = await buildChain(crypto, { store, dayBlocks: 0 }); // genesis only
  const service = new CommonplaceService(crypto, store, syncTestMkHex);

  const remoteChain = await buildChain(crypto, { dayBlocks: 1 });

  const result = await service.reconcileRemoteChain(await remoteChain.readAll());

  t.assertEq(result.appended, 1, 'F5: appended 1');
  t.assertEq(result.hasConflicts, false, 'F5: no conflicts');
  t.assertEq(await localChain.getBlockCount(), 2, 'F5: genesis + day');
});

// ── CPSW-F6 ────────────────────────────────────────────────────────
await test('CPSW-F6: same index, different hash → conflict reported, never written', async () => {
  const crypto = makeCrypto();
  const store = new MemoryBackend();
  const localChain = await buildChain(crypto, { store, dayBlocks: 1 }); // "Title 0"
  const service = new CommonplaceService(crypto, store, syncTestMkHex);

  const remoteChain = await buildChain(crypto, { dayBlocks: 0 }); // genesis only
  const prevHash = remoteChain.getBlockHashFor(await remoteChain.getLastBlock());
  const divergent = await remoteChain.buildDayBlock(
    [rawEntry({ title: 'Remote', entry: 'Remote passage' })],
    prevHash,
    '2026-08-31',
  );
  await remoteChain.append(divergent);

  const result = await service.reconcileRemoteChain(await remoteChain.readAll());

  t.assertEq(result.appended, 0, 'F6: appended 0');
  t.assert(result.conflictedIndices.includes(1), 'F6: conflict at index 1');
  t.assertEq(await localChain.getBlockCount(), 2, 'F6: local unchanged');
});

// ── CPSW-F7 ────────────────────────────────────────────────────────
await test('CPSW-F7: empty local only accepts a genesis-first remote; otherwise conflict at 0', async () => {
  const crypto = makeCrypto();
  const store = new MemoryBackend();
  const service = new CommonplaceService(crypto, store, syncTestMkHex); // empty local

  const remoteChain = new CommonplaceChain(crypto, new MemoryBackend(), syncTestMkHex);
  const day = await remoteChain.buildDayBlock([rawEntry()], '0'.repeat(64), '2026-08-31');

  const result = await service.reconcileRemoteChain([day]);

  t.assertEq(result.appended, 0, 'F7: appended 0');
  t.assert(result.conflictedIndices.includes(0), 'F7: conflict at index 0');
  t.assertEq(await service.chain.getBlockCount(), 0, 'F7: still empty');
});

t.summary('CommonplaceReconcile');
process.exit(t.failed > 0 ? 1 : 0);
