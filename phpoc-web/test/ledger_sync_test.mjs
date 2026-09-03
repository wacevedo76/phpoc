/**
 * ledger_sync_test.mjs — pushLedgerBlocks() TDD test suite (RED phase).
 *
 * 31 tests across 7 categories (A-G) per docs/planning/PUSHLEDGERBLOCKS_TDD_PLAN.md.
 *
 * Category A — Basic Push (5 tests, 18 assertions)
 * Category B — No-Op / Skip Cases (4 tests, 10 assertions)
 * Category C — Obfuscation Correctness (4 tests, 11 assertions)
 * Category D — Transport Error Resilience (4 tests, 12 assertions)
 * Category E — Index Push (4 tests, 14 assertions)
 * Category F — SyncService Integration (6 tests, 14 assertions)
 * Category G — Edge Cases (4 tests, 10 assertions)
 *
 * Total: 31 tests, 89 assertions
 *
 * RED phase: pushLedgerBlocks() does not exist yet — all tests fail with
 * TypeError. This is expected and intentional. Tests define the contract.
 *
 * Usage:
 *   node --experimental-vm-modules test/ledger_sync_test.mjs
 */

import { createHash } from 'crypto';
import { SyncService, SyncResult } from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

// ══════════════════════════════════════════════════════════════════════
// Mock Transport — Map-based with push, pull, listFiles
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this._store = new Map();
    this._offline = false;
    /** If set, listFiles throws this error */
    this._listFilesError = null;
    /** If set, every push throws this error */
    this._pushError = null;
    /** If non-null, push fails only for this specific path */
    this._pushFailPath = null;
    /** Track push calls in order for sequence verification */
    this._pushCalls = [];
    /** Track listFiles calls */
    this._listFilesCalls = [];
  }

  async pull(path) {
    if (this._offline) throw new Error('Network failure');
    return this._store.get(path) ?? null;
  }

  async push(path, data) {
    if (this._offline) throw new Error('Network failure');
    this._pushCalls.push(path);
    if (this._pushError) throw this._pushError;
    if (this._pushFailPath === path) throw new Error(`Push failed for ${path}`);
    this._store.set(path, data);
  }

  /**
   * List files under prefix. Returns basenames (not full paths),
   * matching Worker/Git transport contract.
   */
  async listFiles(prefix) {
    this._listFilesCalls.push(prefix);
    if (this._offline) throw new Error('Network failure');
    if (this._listFilesError) throw this._listFilesError;
    const results = [];
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) {
        results.push(key.slice(prefix.length));
      }
    }
    return results;
  }

  resetCalls() {
    this._pushCalls = [];
    this._listFilesCalls = [];
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Crypto — obfuscateBlob / deobfuscateBlob
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_MK = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';

class MockCrypto {
  constructor() {
    this._mk = null;
    this._mkQueryCount = 0;
  }

  getMasterKey() { this._mkQueryCount++; return this._mk; }
  setMasterKey(k) { this._mk = k; }
  hasMasterKey() { return !!this._mk; }

  obfuscateBlob(plaintext, mk) {
    const key = mk || this._mk || DEFAULT_MK;
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = createHash('sha256').update(key).digest().slice(0, 4);
    const result = Buffer.concat([keyFingerprint, plainBytes]);
    return result.toString('base64');
  }

  deobfuscateBlob(b64, mk) {
    const key = mk || this._mk || DEFAULT_MK;
    const obfuscated = Buffer.from(b64, 'base64');
    const storedFingerprint = obfuscated.slice(0, 4);
    const expectedFingerprint = createHash('sha256').update(key).digest().slice(0, 4);
    if (!storedFingerprint.equals(expectedFingerprint)) {
      throw new Error('key mismatch');
    }
    return obfuscated.slice(4).toString('utf-8');
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Create a SyncService with mock transport, crypto, and storage.
 */
function createSyncService({
  withTransport = true,
  withMasterKey = true,
  masterKey = DEFAULT_MK,
} = {}) {
  const storage = new MemoryBackend();
  const crypto = new MockCrypto();
  const transport = withTransport ? new MockTransport() : null;

  if (withMasterKey) {
    crypto.setMasterKey(masterKey);
  }

  const sync = new SyncService(storage, crypto, transport);
  return { sync, storage, crypto, transport };
}

/**
 * Build a minimal ledger block object.
 */
function makeBlock(index, entries = [], overrides = {}) {
  return {
    index,
    format_version: 1,
    day_hash: `dayhash_${String(index).padStart(3, '0')}`,
    month_hash: `monthhash_0`,
    year_hash: `yearhash_0`,
    identity: 'identity-hash-abc123',
    recovery_seed_enc: 'enc:recovery-seed-data',
    previous_hash: index === 0 ? null : `prev_hash_${String(index - 1).padStart(3, '0')}`,
    entries,
    created_at: `2026-01-${String(10 + index).padStart(2, '0')}T12:00:00Z`,
    seal: `seal_${String(index).padStart(3, '0')}`,
    signature: `sig_${String(index).padStart(3, '0')}`,
    ...overrides,
  };
}

/**
 * Build a minimal index object from blocks.
 */
function makeIndex(blocks) {
  return {
    block_count: blocks.length,
    latest_block: blocks.length > 0 ? blocks[blocks.length - 1].index : null,
    summaries: blocks.map(b => ({
      index: b.index,
      day_hash: b.day_hash,
      created_at: b.created_at,
      entry_count: (b.entries || []).length,
    })),
  };
}

/**
 * Pre-populate remote transport with obfuscated blocks.
 */
async function pushBlocksToRemote(transport, crypto, mk, blocks) {
  for (const block of blocks) {
    const json = JSON.stringify(block);
    const obfuscated = crypto.obfuscateBlob(json, mk);
    const bytes = new Uint8Array(Buffer.from(obfuscated, 'base64'));
    await transport.push(
      `ledger/blocks/${String(block.index).padStart(6, '0')}.json`,
      bytes,
    );
  }
}

/**
 * Read and de-obfuscate a pushed block from transport.
 */
function readPushedBlock(transport, crypto, mk, index) {
  const path = `ledger/blocks/${String(index).padStart(6, '0')}.json`;
  const raw = transport._store.get(path);
  if (!raw) return null;
  const b64 = Buffer.from(raw).toString('base64');
  const json = crypto.deobfuscateBlob(b64, mk);
  return JSON.parse(json);
}

/**
 * Run a test, catching any errors for RED phase reporting.
 * In RED phase, pushLedgerBlocks() throws TypeError.
 * In GREEN phase, this is a no-op pass-through.
 */
async function testBlock(t, label, fn) {
  try {
    await fn();
  } catch (err) {
    if (err.message && err.message.includes('pushLedgerBlocks is not a function')) {
      // RED phase — method doesn't exist yet. Mark all inner assertions as
      // RED by recording a synthetic failure.
      console.log(`  ✗  ${label} [RED — pushLedgerBlocks not implemented]`);
      t.failed++;
      t.errors.push(label);
      return;
    }
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

async function run() {
  console.log('══ pushLedgerBlocks() TDD Test Suite (RED phase) ══\n');

  // ── Category A: Basic Push (happy path) ───────────────────────────
  console.log('── Category A: Basic Push ──\n');

  // A1. Empty remote, 3 local blocks → push all 3
  await testBlock(t, 'A1. empty remote, 3 local blocks → push all 3 (returns 3)', async () => {
    const { sync, storage, transport } = createSyncService();
    const blocks = [makeBlock(0), makeBlock(1), makeBlock(2)];
    await storage.set('ledger:blocks', blocks);

    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 3, 'A1. empty remote, 3 local blocks → push all 3 (returns 3)');
    t.assert(transport._store.has('ledger/blocks/000000.json'), 'A1b. block 0 pushed');
    t.assert(transport._store.has('ledger/blocks/000001.json'), 'A1c. block 1 pushed');
    t.assert(transport._store.has('ledger/blocks/000002.json'), 'A1d. block 2 pushed');
  });

  // A2. Remote has blocks 0-2, local has blocks 0-4 → push blocks 3-4 only
  await testBlock(t, 'A2. remote has 0-2, local has 0-4 → push 3-4 only (returns 2)', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const allBlocks = [makeBlock(0), makeBlock(1), makeBlock(2), makeBlock(3), makeBlock(4)];
    const remoteBlocks = [makeBlock(0), makeBlock(1), makeBlock(2)];
    await storage.set('ledger:blocks', allBlocks);
    await pushBlocksToRemote(transport, crypto, mk, remoteBlocks);
    transport.resetCalls();

    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 2, 'A2. remote has 0-2, local 0-4 → push 3-4');
    t.assert(transport._store.has('ledger/blocks/000003.json'), 'A2b. block 3 pushed');
    t.assert(transport._store.has('ledger/blocks/000004.json'), 'A2c. block 4 pushed');
    t.assert(!transport._pushCalls.includes('ledger/blocks/000000.json'), 'A2d. block 0 NOT re-pushed');
    t.assert(!transport._pushCalls.includes('ledger/blocks/000001.json'), 'A2e. block 1 NOT re-pushed');
    t.assert(!transport._pushCalls.includes('ledger/blocks/000002.json'), 'A2f. block 2 NOT re-pushed');
  });

  // A3. Single genesis block push
  await testBlock(t, 'A3. single genesis block → push 1', async () => {
    const { sync, storage, transport } = createSyncService();
    const block = makeBlock(0);
    await storage.set('ledger:blocks', [block]);

    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 1, 'A3. single genesis block → push 1');
    t.assert(transport._store.has('ledger/blocks/000000.json'), 'A3b. filename is 000000.json');
    const raw = transport._store.get('ledger/blocks/000000.json');
    const b64 = Buffer.from(raw).toString('base64');
    t.assert(!b64.includes('"day_hash"'), 'A3c. pushed bytes are NOT plaintext JSON');
  });

  // A4. Push returns count of blocks pushed (2 sub-cases)
  await testBlock(t, 'A4a. full push: 3 blocks → returns 3', async () => {
    const { sync, storage } = createSyncService();
    await storage.set('ledger:blocks', [makeBlock(0), makeBlock(1), makeBlock(2)]);
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 3, 'A4a. full push of 3 blocks → returns 3');
  });
  await testBlock(t, 'A4b. partial push: 4 on remote, 6 local → returns 2', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const allBlocks = [makeBlock(0), makeBlock(1), makeBlock(2), makeBlock(3), makeBlock(4), makeBlock(5)];
    await storage.set('ledger:blocks', allBlocks);
    await pushBlocksToRemote(transport, crypto, mk, [makeBlock(0), makeBlock(1), makeBlock(2), makeBlock(3)]);
    transport.resetCalls();
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 2, 'A4b. 4 on remote, 6 local → returns 2');
  });

  // A5. Push order is sequential by index
  await testBlock(t, 'A5. blocks pushed in ascending index order', async () => {
    const { sync, storage, transport } = createSyncService();
    await storage.set('ledger:blocks', [makeBlock(2), makeBlock(0), makeBlock(1)]);
    await sync.pushLedgerBlocks();
    const paths = transport._pushCalls.filter(p => p.startsWith('ledger/blocks/') && !p.endsWith('index.json'));
    const indices = paths.map(p => parseInt(p.match(/(\d+)\.json$/)[1], 10));
    t.assertDeepEq(indices, [0, 1, 2], 'A5. blocks pushed in ascending index order');
  });

  // ── Category B: No-Op / Skip Cases ───────────────────────────────
  console.log('\n── Category B: No-Op / Skip Cases ──\n');

  // B1. No master key → skip, return 0
  await testBlock(t, 'B1. no master key → returns 0', async () => {
    const { sync, storage, transport } = createSyncService({ withMasterKey: false });
    await storage.set('ledger:blocks', [makeBlock(0), makeBlock(1)]);
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 0, 'B1. no master key → returns 0');
    t.assertEq(transport._listFilesCalls.length, 0, 'B1b. no remote calls made');
  });

  // B2. No transport → skip, return 0
  await testBlock(t, 'B2. no transport → returns 0', async () => {
    const { sync, storage } = createSyncService({ withTransport: false });
    await storage.set('ledger:blocks', [makeBlock(0)]);
    t.assertEq(sync.isRemoteAvailable, false, 'B2a. isRemoteAvailable is false');
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 0, 'B2. no transport → returns 0');
  });

  // B3. Empty blocks array → skip, return 0
  await testBlock(t, 'B3. empty blocks → returns 0', async () => {
    const { sync, storage, transport } = createSyncService();
    await storage.set('ledger:blocks', []);
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 0, 'B3. empty blocks → returns 0');
    t.assertEq(transport._listFilesCalls.length, 0, 'B3b. no remote listFiles called');
  });

  // B4. All blocks already on remote → skip, return 0
  await testBlock(t, 'B4. all blocks already on remote → returns 0', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const blocks = [makeBlock(0), makeBlock(1), makeBlock(2)];
    await storage.set('ledger:blocks', blocks);
    await pushBlocksToRemote(transport, crypto, mk, blocks);
    transport.resetCalls();
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 0, 'B4. all blocks already on remote → returns 0');
    t.assertEq(transport._pushCalls.length, 2, 'B4b. only 2 hash-index push calls made');
  });

  // ── Category C: Obfuscation Correctness ──────────────────────────
  console.log('\n── Category C: Obfuscation Correctness ──\n');

  // C1. Pushed bytes are NOT plaintext JSON
  await testBlock(t, 'C1. pushed bytes are NOT valid plaintext JSON', async () => {
    const { sync, storage, transport } = createSyncService();
    const block = makeBlock(0);
    await storage.set('ledger:blocks', [block]);
    await sync.pushLedgerBlocks();
    const raw = transport._store.get('ledger/blocks/000000.json');
    const asText = new TextDecoder().decode(raw);
    let isJson = false;
    try { JSON.parse(asText); isJson = true; } catch { /* expected */ }
    t.assert(!isJson, 'C1. pushed bytes are NOT valid plaintext JSON');
  });

  // C2. Pushed block can be de-obfuscated and parsed (round-trip)
  await testBlock(t, 'C2. round-trip de-obfuscation preserves fields', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const block = makeBlock(0, [], { day_hash: 'test-day-hash-42' });
    await storage.set('ledger:blocks', [block]);
    await sync.pushLedgerBlocks();
    const raw = transport._store.get('ledger/blocks/000000.json');
    const b64 = Buffer.from(raw).toString('base64');
    const roundTripped = crypto.deobfuscateBlob(b64, mk);
    const parsed = JSON.parse(roundTripped);
    t.assertEq(parsed.index, 0, 'C2a. round-trip: index preserved');
    t.assertEq(parsed.day_hash, 'test-day-hash-42', 'C2b. round-trip: day_hash preserved');
    t.assertEq(parsed.format_version, 1, 'C2c. round-trip: format_version preserved');
  });

  // C3. Genesis block pushes with correct day_hash preserved
  await testBlock(t, 'C3. genesis day_hash preserved after obfuscation', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const block = makeBlock(0, [], { day_hash: 'genesis-day-hash-value' });
    await storage.set('ledger:blocks', [block]);
    await sync.pushLedgerBlocks();
    const parsed = readPushedBlock(transport, crypto, mk, 0);
    t.assert(parsed !== null, 'C3a. genesis block present on remote');
    t.assertEq(parsed.day_hash, 'genesis-day-hash-value', 'C3. genesis day_hash preserved');
  });

  // C4. Obfuscation uses the provided master key
  await testBlock(t, 'C4. same block, different keys → different obfuscated output', async () => {
    const { sync: sync1, storage: storage1, crypto: crypto1, transport: transport1 } =
      createSyncService({ masterKey: 'key1key1key1key1key1key1key1key1key1key1key1key1key1key1key1key1' });
    const { sync: sync2, storage: storage2, crypto: crypto2, transport: transport2 } =
      createSyncService({ masterKey: 'key2key2key2key2key2key2key2key2key2key2key2key2key2key2key2key2' });

    const block = makeBlock(0);
    await storage1.set('ledger:blocks', [block]);
    await storage2.set('ledger:blocks', [block]);
    await sync1.pushLedgerBlocks();
    await sync2.pushLedgerBlocks();

    const raw1 = transport1._store.get('ledger/blocks/000000.json');
    const raw2 = transport2._store.get('ledger/blocks/000000.json');
    const b64_1 = Buffer.from(raw1).toString('base64');
    const b64_2 = Buffer.from(raw2).toString('base64');
    t.assertNeq(b64_1, b64_2, 'C4. same block, different keys → different output');

    const plain1 = crypto1.deobfuscateBlob(b64_1, 'key1key1key1key1key1key1key1key1key1key1key1key1key1key1key1key1');
    const plain2 = crypto2.deobfuscateBlob(b64_2, 'key2key2key2key2key2key2key2key2key2key2key2key2key2key2key2key2');
    t.assertEq(JSON.parse(plain1).day_hash, block.day_hash, 'C4b. key1 round-trip ok');
    t.assertEq(JSON.parse(plain2).day_hash, block.day_hash, 'C4c. key2 round-trip ok');
  });

  // ── Category D: Transport Error Resilience ───────────────────────
  console.log('\n── Category D: Transport Error Resilience ──\n');

  // D1. listFiles throws → return 0, no crash
  await testBlock(t, 'D1. listFiles throws → returns 0', async () => {
    const { sync, storage, transport } = createSyncService();
    await storage.set('ledger:blocks', [makeBlock(0), makeBlock(1)]);
    transport._listFilesError = new Error('Network timeout');
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 0, 'D1. listFiles throws → returns 0');
  });

  // D2. push throws for mid-batch block → remaining blocks still attempted
  await testBlock(t, 'D2. mid-batch failure: remaining blocks still pushed', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const blocks = [makeBlock(0), makeBlock(1), makeBlock(2), makeBlock(3), makeBlock(4)];
    await storage.set('ledger:blocks', blocks);
    await pushBlocksToRemote(transport, crypto, mk, [makeBlock(0), makeBlock(1)]);
    transport._pushFailPath = 'ledger/blocks/000002.json';
    transport.resetCalls();

    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 2, 'D2. mid-batch failure: blocks 3-4 pushed, returns 2');
    t.assert(transport._store.has('ledger/blocks/000003.json'), 'D2b. block 3 pushed after failure');
    t.assert(transport._store.has('ledger/blocks/000004.json'), 'D2c. block 4 pushed after failure');
  });

  // D3. All pushes fail → return 0, no crash
  await testBlock(t, 'D3. all pushes fail → returns 0', async () => {
    const { sync, storage, transport } = createSyncService();
    await storage.set('ledger:blocks', [makeBlock(0), makeBlock(1), makeBlock(2)]);
    transport._pushError = new Error('Complete network outage');
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 0, 'D3. all pushes fail → returns 0');
  });

  // D4. push succeeds for blocks but index push fails → blocks count still returned
  await testBlock(t, 'D4. index push fails → block count still returned', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const blocks = [makeBlock(0), makeBlock(1)];
    await storage.set('ledger:blocks', blocks);
    await storage.set('ledger:index', makeIndex(blocks));
    transport._pushFailPath = 'ledger/index.json';

    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 2, 'D4. index push fails → block count 2 still returned');
    t.assert(transport._store.has('ledger/blocks/000000.json'), 'D4b. block 0 pushed');
    t.assert(transport._store.has('ledger/blocks/000001.json'), 'D4c. block 1 pushed');
  });

  // ── Category E: Index Push ───────────────────────────────────────
  console.log('\n── Category E: Index Push ──\n');

  // E1. Index pushed after blocks succeed
  await testBlock(t, 'E1. ledger/index.json present on remote after push', async () => {
    const { sync, storage, transport } = createSyncService();
    const blocks = [makeBlock(0), makeBlock(1)];
    await storage.set('ledger:blocks', blocks);
    await storage.set('ledger:index', makeIndex(blocks));

    await sync.pushLedgerBlocks();

    t.assert(transport._store.has('ledger/index.json'), 'E1. ledger/index.json present on remote');
    const blockPushes = transport._pushCalls.filter(p => p.startsWith('ledger/blocks/'));
    const indexPushes = transport._pushCalls.filter(p => p === 'ledger/index.json');
    t.assertEq(indexPushes.length, 1, 'E1b. index pushed exactly once');
    const lastBlockIdx = transport._pushCalls.lastIndexOf(blockPushes[blockPushes.length - 1]);
    const firstIndexIdx = transport._pushCalls.indexOf('ledger/index.json');
    t.assert(lastBlockIdx < firstIndexIdx, 'E1c. index pushed AFTER all blocks');
  });

  // E2. Index is obfuscated
  await testBlock(t, 'E2. index bytes are obfuscated', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const blocks = [makeBlock(0)];
    await storage.set('ledger:blocks', blocks);
    await storage.set('ledger:index', makeIndex(blocks));

    await sync.pushLedgerBlocks();

    const raw = transport._store.get('ledger/index.json');
    t.assert(raw !== undefined, 'E2a. index present on remote');
    const asText = new TextDecoder().decode(raw);
    let isPlainJson = false;
    try { JSON.parse(asText); isPlainJson = true; } catch { /* expected */ }
    t.assert(!isPlainJson, 'E2. index bytes are obfuscated, not plaintext JSON');

    const b64 = Buffer.from(raw).toString('base64');
    const deobfuscated = crypto.deobfuscateBlob(b64, mk);
    const parsed = JSON.parse(deobfuscated);
    t.assertEq(parsed.block_count, 1, 'E2b. de-obfuscated index has correct block_count');
  });

  // E3. No index data → index push skipped
  await testBlock(t, 'E3. no index on remote when storage.get("ledger:index") is undefined', async () => {
    const { sync, storage, transport } = createSyncService();
    await storage.set('ledger:blocks', [makeBlock(0)]);
    // ledger:index is deliberately NOT set

    await sync.pushLedgerBlocks();

    t.assert(!transport._store.has('ledger/index.json'), 'E3. no index on remote when undefined');
    t.assert(transport._store.has('ledger/blocks/000000.json'), 'E3b. block pushed even without index');
  });

  // E4. Index push failure doesn't affect block count
  await testBlock(t, 'E4. index push fails → block count still returned', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const blocks = [makeBlock(0), makeBlock(1), makeBlock(2)];
    await storage.set('ledger:blocks', blocks);
    await storage.set('ledger:index', makeIndex(blocks));
    transport._pushFailPath = 'ledger/index.json';

    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 3, 'E4. index push fails → block count 3 still returned');
    t.assert(transport._store.has('ledger/blocks/000000.json'), 'E4b. block 0 pushed');
    t.assert(transport._store.has('ledger/blocks/000001.json'), 'E4c. block 1 pushed');
    t.assert(transport._store.has('ledger/blocks/000002.json'), 'E4d. block 2 pushed');
  });

  // ── Category F: SyncService Integration ──────────────────────────
  console.log('\n── Category F: SyncService Integration ──\n');

  // F1. pushLedgerBlocks is a method on SyncService
  {
    const { sync } = createSyncService();
    const isFn = typeof sync.pushLedgerBlocks === 'function';
    t.assert(isFn, 'F1. pushLedgerBlocks is a method on SyncService');
    if (isFn) {
      t.assertEq(sync.pushLedgerBlocks.length, 0, 'F1b. pushLedgerBlocks accepts no arguments');
    } else {
      t.failed++;
      t.errors.push('F1b. pushLedgerBlocks accepts no arguments');
      console.log('  ✗  F1b. pushLedgerBlocks accepts no arguments [RED — method missing]');
    }
  }

  // F2. Reads blocks from storage.get('ledger:blocks')
  await testBlock(t, 'F2. reads blocks from storage', async () => {
    const { sync, storage } = createSyncService();
    // Don't set ledger:blocks — make it undefined
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 0, 'F2. undefined ledger:blocks → treated as empty');
    await storage.set('ledger:blocks', [makeBlock(0)]);
    const count2 = await sync.pushLedgerBlocks();
    t.assertEq(count2, 1, 'F2b. blocks read from storage.get("ledger:blocks")');
  });

  // F3. Reads index from storage.get('ledger:index')
  await testBlock(t, 'F3. index read from storage and pushed', async () => {
    const { sync, storage, transport } = createSyncService();
    await storage.set('ledger:blocks', [makeBlock(0), makeBlock(1)]);
    await storage.set('ledger:index', makeIndex([makeBlock(0), makeBlock(1)]));
    await sync.pushLedgerBlocks();
    t.assert(transport._store.has('ledger/index.json'), 'F3. index pushed from storage');
  });

  // F4. No-op when isRemoteAvailable is false
  await testBlock(t, 'F4. isRemoteAvailable false → returns 0', async () => {
    const { sync } = createSyncService({ withTransport: false });
    t.assertEq(sync.isRemoteAvailable, false, 'F4a. isRemoteAvailable is false');
    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 0, 'F4. isRemoteAvailable false → returns 0');
  });

  // F5. Uses this._crypto.getMasterKey() for obfuscation
  await testBlock(t, 'F5. uses internal crypto.getMasterKey()', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    await storage.set('ledger:blocks', [makeBlock(0)]);
    crypto._mkQueryCount = 0;
    await sync.pushLedgerBlocks();
    t.assert(crypto._mkQueryCount > 0, 'F5. getMasterKey was called for obfuscation');
    t.assert(transport._store.has('ledger/blocks/000000.json'), 'F5b. block pushed using internal crypto');
  });

  // F6. pushLedgerBlocks does NOT touch staging paths
  await testBlock(t, 'F6. staging paths untouched', async () => {
    const { sync, storage, transport } = createSyncService();
    await storage.set('ledger:blocks', [makeBlock(0), makeBlock(1)]);

    transport._store.set('staging/blob', new Uint8Array([1, 2, 3]));
    transport._store.set('staging/blobs/device_cookie.bin', new Uint8Array([4, 5, 6]));
    transport.resetCalls();

    await sync.pushLedgerBlocks();

    const stagingPushes = transport._pushCalls.filter(p => p.startsWith('staging/'));
    t.assertEq(stagingPushes.length, 0, 'F6a. no staging paths pushed');
    const stagingAfter = transport._store.get('staging/blob');
    const cookieAfter = transport._store.get('staging/blobs/device_cookie.bin');
    t.assertDeepEq(Array.from(stagingAfter || []), [1, 2, 3], 'F6b. staging blob untouched');
    t.assertDeepEq(Array.from(cookieAfter || []), [4, 5, 6], 'F6c. device cookie untouched');
    t.assert(transport._store.has('ledger/blocks/000000.json'), 'F6d. block 0 pushed');
    t.assert(transport._store.has('ledger/blocks/000001.json'), 'F6e. block 1 pushed');
  });

  // ── Category G: Edge Cases ───────────────────────────────────────
  console.log('\n── Category G: Edge Cases ──\n');

  // G1. Large block with many entries (50+ entries)
  await testBlock(t, 'G1. large block (50 entries) handled correctly', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const manyEntries = Array.from({ length: 50 }, (_, i) => ({
      entry_id: `entry-${String(i).padStart(4, '0')}`,
      hash: `hash-${i}`,
      data: {
        title: `Task ${i}`,
        startTime_enc: `plain:${1714000000000 + i * 3600000}`,
        duration: 1800,
        is_active: false,
        is_paused: false,
        pauses_enc: 'plain:[]',
        metadata_enc: 'plain:{}',
        tags: ['test'],
        comment: null,
        media: [],
        device_uuid: 'test-device',
        end_device_uuid: '',
      },
    }));
    const largeBlock = makeBlock(0, manyEntries);
    await storage.set('ledger:blocks', [largeBlock]);

    await sync.pushLedgerBlocks();

    const parsed = readPushedBlock(transport, crypto, mk, 0);
    t.assert(parsed !== null, 'G1a. large block round-trip successful');
    t.assertEq(parsed.entries.length, 50, 'G1. 50 entries preserved after round-trip');
  });

  // G2. Block fields with special Unicode characters
  await testBlock(t, 'G2. Unicode (emoji, CJK, diacritics) preserved', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const unicodeEntries = [{
      entry_id: 'unicode-entry-1',
      hash: 'hash-u1',
      data: {
        title: '🎯 Focus Task',
        startTime_enc: 'plain:1714000000000',
        duration: 1800,
        is_active: false,
        is_paused: false,
        pauses_enc: 'plain:[]',
        metadata_enc: 'plain:{}',
        tags: ['日本語', 'café'],
        comment: 'Emoji: 🎉🔥💻 — CJK: データ — Diacritics: résumé naïve',
        media: [],
        device_uuid: 'test-device',
        end_device_uuid: '',
      },
    }];
    const block = makeBlock(0, unicodeEntries);
    await storage.set('ledger:blocks', [block]);

    await sync.pushLedgerBlocks();

    const parsed = readPushedBlock(transport, crypto, mk, 0);
    const entry = parsed.entries[0];
    t.assertEq(entry.data.title, '🎯 Focus Task', 'G2a. emoji in title preserved');
    t.assertDeepEq(entry.data.tags, ['日本語', 'café'], 'G2b. CJK and diacritics in tags preserved');
    t.assert(
      entry.data.comment.includes('🎉') && entry.data.comment.includes('データ') && entry.data.comment.includes('résumé'),
      'G2. all Unicode categories preserved',
    );
  });

  // G3. ledger:blocks key missing from storage → treated as empty, return 0
  await testBlock(t, 'G3. missing ledger:blocks → returns 0', async () => {
    const { sync, storage, transport } = createSyncService();
    // Do NOT set ledger:blocks at all

    const count = await sync.pushLedgerBlocks();
    t.assertEq(count, 0, 'G3. missing ledger:blocks → returns 0');
    t.assertEq(transport._listFilesCalls.length, 0, 'G3b. no remote calls when no blocks');
  });

  // G4. Corrupt block data (missing day_hash field) → doesn't crash
  await testBlock(t, 'G4. corrupt block (missing day_hash) → push succeeds', async () => {
    const { sync, storage, crypto, transport } = createSyncService();
    const mk = DEFAULT_MK;
    const corruptBlock = {
      index: 0,
      // day_hash intentionally missing
      entries: [],
      seal: 'seal_000',
    };
    await storage.set('ledger:blocks', [corruptBlock]);

    const count = await sync.pushLedgerBlocks();
    t.assert(transport._store.has('ledger/blocks/000000.json'), 'G4a. corrupt block still pushed');
    t.assertEq(count, 1, 'G4. corrupt block: push succeeds, returns 1');
  });

  // ── Results ───────────────────────────────────────────────────────
  const failed = t.summary('pushLedgerBlocks TDD');
  console.log(`\nTotal assertions: ${t.passed + t.failed}`);
  if (t.failed > 0) {
    console.log('\n🔴 RED phase — all tests expected to fail. pushLedgerBlocks() not implemented yet.');
    console.log('   GREEN phase will implement the method and make these pass.');
  } else {
    console.log('\n🟢 GREEN phase — all tests pass!');
  }
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
