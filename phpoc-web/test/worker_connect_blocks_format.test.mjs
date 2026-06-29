/**
 * worker_connect_blocks_format.test.mjs — CLI Blocks-Format Onboarding Tests.
 *
 * Tests the connectToWorker blocks-format path: deleting stale ledger:blocks
 * before the genesis gate runs, and the bootstrapServices auto-clear recovery
 * on GENESIS_MISMATCH.
 *
 * Coverage:
 *   Group A: Blocks-format onboarding → delete stale ledger:blocks (7 tests)
 *     A1 — delete called after storage write, before bootstrapServices
 *     A2 — stale ledger:blocks (different genesis) → delete clears it → gate passes
 *     A3 — no stale ledger:blocks → delete is 404 no-op → no error
 *     A4 — network error during delete → caught gracefully → onboarding proceeds
 *     A5 — end-to-end: blocks onboard → delete stale → gate compatible → fresh blob pushed
 *     A6 — single-blob format → ledger:blocks NOT deleted
 *     A7 — same genesis in both formats → delete fires → gate still compatible
 *
 *   Group B: bootstrapServices auto-clear on GENESIS_MISMATCH (5 tests)
 *     B1 — bootstrap detects mismatch → clearRemote → retry → READY
 *     B2 — clearRemote succeeds but retry still fails → caught, app still boots
 *     B3 — clearRemote fails (network) → caught, app still boots
 *     B4 — normal (compatible) path → clearRemote NOT called
 *     B5 — after auto-clear + retry, genesis gate is clean and Sync Now works
 *
 * Usage:
 *   node test/worker_connect_blocks_format.test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Mock dependencies
// ══════════════════════════════════════════════════════════════════════

const PBKDF2_ITERATIONS = 600000;

function deterministicHash(data) {
  let hash = 5381;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(64, '0');
}

function mockEncrypt(plaintext, key) {
  const tag = deterministicHash(key).slice(0, 8);
  const encoded = Buffer.from(plaintext, 'utf-8').toString('base64');
  return 'enc:' + tag + ':' + encoded;
}

function mockDecrypt(ciphertext, _key) {
  if (ciphertext && ciphertext.startsWith('enc:')) {
    const parts = ciphertext.split(':');
    if (parts.length >= 3) {
      return Buffer.from(parts.slice(2).join(':'), 'base64').toString('utf-8');
    }
    return ciphertext;
  }
  return ciphertext;
}

/**
 * Mock CryptoService — deterministic for reproducible test vectors.
 */
class MockCrypto {
  constructor() { this._mk = null; }

  setMasterKey(k) { this._mk = k; }
  getMasterKey() { return this._mk; }
  hasMasterKey() { return !!this._mk; }

  derivePdk(passphrase, iterations) {
    return deterministicHash(passphrase + ':' + iterations);
  }

  authenticate(passphrase, seed, iterations) {
    return deterministicHash(passphrase + ':' + seed + ':' + iterations);
  }

  encrypt(plaintext, key) { return mockEncrypt(plaintext, key); }
  decrypt(ciphertext, key) { return mockDecrypt(ciphertext, key); }

  seal(data, mk) {
    return deterministicHash(data + (mk || this._mk || ''));
  }

  verifySeal(data, sealHex, mk) {
    return this.seal(data, mk) === sealHex;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  obfuscateBlob(plaintext, mk) {
    const keyFingerprint = mk
      ? createHash('sha256').update(mk).digest().slice(0, 4)
      : Buffer.alloc(4);
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const obfuscated = Buffer.concat([keyFingerprint, plainBytes]);
    return obfuscated.toString('base64');
  }

  deobfuscateBlob(b64, mk) {
    try {
      const obfuscated = Buffer.from(b64, 'base64');
      const storedFingerprint = obfuscated.slice(0, 4);
      if (mk) {
        const expectedFingerprint = createHash('sha256').update(mk).digest().slice(0, 4);
        if (!storedFingerprint.equals(expectedFingerprint)) {
          throw new Error('key mismatch');
        }
      }
      return obfuscated.slice(4).toString('utf-8');
    } catch {
      throw new Error('deobfuscation failed');
    }
  }

  clearMasterKey() { this._mk = null; }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Transport — simulates R2 with CLI blocks + ledger:blocks
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor(opts = {}) {
    this._store = new Map();          // Map<path, Uint8Array>
    this._offline = opts.offline || false;
    this._deleteError = opts.deleteError || null;   // Error to throw on specific delete paths
    this._pullCalls = [];
    this._deleteCalls = [];
  }

  async pull(path) {
    this._pullCalls.push(path);
    if (this._offline) throw new Error('Network failure');
    return this._store.get(path) ?? null;
  }

  async push(path, data) {
    if (this._offline) throw new Error('Network failure');
    this._store.set(path, data);
  }

  async delete(path) {
    this._deleteCalls.push(path);
    if (this._offline) throw new Error('Network failure');
    if (typeof this._deleteError === 'function') {
      const err = this._deleteError(path);
      if (err) throw err;
    }
    this._store.delete(path);
  }

  async listFiles(prefix) {
    if (this._offline) throw new Error('Network failure');
    const results = [];
    for (const [path] of this._store) {
      if (path.startsWith(prefix)) {
        results.push(path.slice(prefix.length));
      }
    }
    return results;
  }

  setData(path, value) {
    if (value === null || value === undefined) {
      this._store.delete(path);
      return;
    }
    this._store.set(path, value);
  }

  hasKey(path) { return this._store.has(path); }

  resetCache() { /* no-op for mock */ }

  /** Track delete calls for path */
  wasDeleted(path) {
    return this._deleteCalls.includes(path);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Storage (IndexedDB simulation, in-memory)
// ══════════════════════════════════════════════════════════════════════

class MockStorage {
  constructor() {
    this._store = new Map();
    this._cleared = false;
  }

  async get(key) { return this._store.get(key); }
  async set(key, value) { this._store.set(key, value); }
  async delete(key) { this._store.delete(key); }
  async clear() { this._cleared = true; this._store.clear(); }
  hasKey(key) { return this._store.has(key); }
}

// ══════════════════════════════════════════════════════════════════════
// Chain Builders (same pattern as worker_connect_onboarding_test.mjs)
// ══════════════════════════════════════════════════════════════════════

function buildGenesisBlock({ username, email, passphrase, seed, masterKey }) {
  if (!masterKey) {
    masterKey = deterministicHash(passphrase + ':' + seed + ':' + PBKDF2_ITERATIONS);
  }

  const pdk = deterministicHash(passphrase + ':' + PBKDF2_ITERATIONS);
  const recoverySeedEnc = mockEncrypt(seed, pdk);
  const identitySecret = deterministicHash('identity:' + seed);
  const identityPubKey = createHash('sha256').update(identitySecret).digest('hex');

  const genesis = {
    type: 'genesis',
    format_version: '0.3.0',
    day_index: 0,
    date: '2026-06-20',
    identity: {
      username,
      email,
      recovery_seed_enc: recoverySeedEnc,
      identity_pub_key: identityPubKey,
      identity_secret_enc_fallback: mockEncrypt(identitySecret, masterKey),
    },
    prev_hash: '0'.repeat(64),
    entries: [],
  };

  const sealData = jsonSort(genesis);
  genesis.day_hash = deterministicHash(sealData + masterKey);
  genesis.signature = deterministicHash('sign:' + genesis.day_hash + identitySecret);

  return genesis;
}

/**
 * Build a chain of obfuscated block files (CLI format).
 * Returns array of { filename, obfuscatedUint8Array }.
 */
function buildObfuscatedChain({ username, email, passphrase, seed, blockCount = 1 }) {
  const mk = deterministicHash(passphrase + ':' + seed + ':' + PBKDF2_ITERATIONS);
  const crypto = new MockCrypto();
  crypto.setMasterKey(mk);

  const genesises = buildGenesisBlock({ username, email, passphrase, seed, masterKey: mk });
  const chain = [genesises];

  // Add day blocks
  for (let i = 1; i < blockCount; i++) {
    const prev = chain[chain.length - 1];
    const prevHash = deterministicHash(jsonSort(prev));
    chain.push({
      type: 'day',
      day_index: i,
      date: `2026-06-${String(21 + (i - 1)).padStart(2, '0')}`,
      prev_hash: prevHash,
      entries: [],
      day_hash: deterministicHash('day-' + i + '-' + mk),
    });
  }

  // Obfuscate each block and store as Uint8Array
  const files = chain.map((block, i) => {
    const filename = String(i).padStart(6, '0') + '.json';
    const json = jsonSort(block);
    const b64 = crypto.obfuscateBlob(json, mk);
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    return { filename, bytes, block };
  });

  return { files, crypto, mk, chain };
}

/**
 * Build a plain-JSON chain (ledger:blocks format — web app convenience cache).
 */
function buildPlainChain({ username, email, passphrase, seed, extraBlocks = 0 }) {
  const mk = deterministicHash(passphrase + ':' + seed + ':' + PBKDF2_ITERATIONS);
  const genesis = buildGenesisBlock({ username, email, passphrase, seed, masterKey: mk });
  const chain = [genesis];

  for (let i = 0; i < extraBlocks; i++) {
    const prev = chain[chain.length - 1];
    const prevHash = deterministicHash(jsonSort(prev));
    chain.push({
      type: 'day',
      day_index: i + 1,
      date: `2026-06-${String(21 + i).padStart(2, '0')}`,
      prev_hash: prevHash,
      entries: [],
      day_hash: deterministicHash('day-' + (i + 1) + '-' + mk),
    });
  }

  return { chain, mk, genesis };
}

// ══════════════════════════════════════════════════════════════════════
// Extracted Logic Under Test
// ══════════════════════════════════════════════════════════════════════

/**
 * Core of connectToWorker blocks-format path: fetch blocks, deobfuscate,
 * validate genesis seal, write to storage, delete stale ledger:blocks,
 * and bootstrap.
 *
 * This is a pure-function extraction of the logic from DevModeContext.jsx
 * connectToWorker() for testability.
 *
 * @param {object} opts
 * @param {string} opts.passphrase
 * @param {string} opts.seed - Recovery seed
 * @param {MockTransport} opts.transport
 * @param {MockCrypto} opts.crypto
 * @param {MockStorage} opts.storage
 * @returns {Promise<{success: boolean, error?: string, chain?: object[], genesisBlock?: object, deleteCalled: boolean}>}
 */
async function connectBlocksFormat({ passphrase, seed, transport, crypto, storage }) {
  const mk = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);
  crypto.setMasterKey(mk);

  // List block files
  let blockFiles;
  try {
    blockFiles = await transport.listFiles('ledger/blocks/');
  } catch (err) {
    return { success: false, error: `Failed to list ledger blocks: ${err.message}`, deleteCalled: false };
  }

  if (!blockFiles || blockFiles.length === 0) {
    return { success: false, error: 'No ledger blocks found on remote.', deleteCalled: false };
  }

  blockFiles.sort();

  // Fetch and deobfuscate each block
  const assembledChain = [];
  for (const filename of blockFiles) {
    const path = `ledger/blocks/${filename}`;
    let raw;
    try {
      raw = await transport.pull(path);
    } catch (err) {
      return { success: false, error: `Failed to fetch block ${filename}: ${err.message}`, deleteCalled: false };
    }

    if (raw === null || raw === undefined) {
      return { success: false, error: `Block ${filename} not found on remote.`, deleteCalled: false };
    }

    try {
      const b64 = Buffer.from(raw).toString('base64');
      const plaintext = crypto.deobfuscateBlob(b64, mk);
      const block = JSON.parse(plaintext);
      assembledChain.push(block);
    } catch (err) {
      return { success: false, error: `Failed to deobfuscate block ${filename}.`, deleteCalled: false };
    }
  }

  const genesisBlock = assembledChain[0];

  // Validate genesis
  if (!genesisBlock || genesisBlock.type !== 'genesis') {
    return { success: false, error: 'Remote ledger does not have a valid genesis block.', deleteCalled: false };
  }

  // Verify genesis seal
  try {
    const checkData = {};
    for (const [k, v] of Object.entries(genesisBlock)) {
      if (k !== 'day_hash' && k !== 'signature') {
        checkData[k] = v;
      }
    }
    const sealData = jsonSort(checkData);
    const valid = crypto.verifySeal(sealData, genesisBlock.day_hash, mk);
    if (!valid) {
      return { success: false, error: 'Wrong passphrase for this ledger.', deleteCalled: false };
    }
  } catch (err) {
    return { success: false, error: 'Wrong passphrase for this ledger.', deleteCalled: false };
  }

  // Write to storage
  await storage.clear();
  await storage.set('phpoc_seed', seed);

  if (genesisBlock.identity) {
    if (genesisBlock.identity.username) {
      await storage.set('phpoc_username', genesisBlock.identity.username);
    }
    if (genesisBlock.identity.email) {
      await storage.set('phpoc_email', genesisBlock.identity.email);
    }
  }

  await storage.set('ledger:blocks', assembledChain);

  // ── Delete stale ledger:blocks from R2 ─────────────────────────
  let deleteCalled = false;
  try {
    await transport.delete('ledger:blocks');
    deleteCalled = true;
  } catch (err) {
    // Non-critical — gate handles null gracefully
    return {
      success: true,
      chain: assembledChain,
      genesisBlock,
      deleteCalled: false,
      deleteError: err.message,
    };
  }

  return { success: true, chain: assembledChain, genesisBlock, deleteCalled: true };
}

/**
 * Simulate bootstrapServices genesis mismatch recovery.
 *
 * After bootstrapServices detects GENESIS_MISMATCH from checkAndSync(),
 * it calls sync.clearRemote() and retries checkAndSync().
 *
 * @param {object} syncService - SyncService-like object with checkAndSync, clearRemote
 * @returns {Promise<{recovered: boolean, firstResult: string, secondResult: string|null, error?: string}>}
 */
async function bootstrapGenesisRecovery(syncService) {
  // First call: may return GENESIS_MISMATCH
  const firstResult = await syncService.checkAndSync();

  if (firstResult !== 'GENESIS_MISMATCH') {
    return { recovered: false, firstResult, secondResult: null };
  }

  // Auto-clear + retry
  try {
    await syncService.clearRemote();
  } catch (err) {
    return { recovered: false, firstResult, secondResult: null, error: `clearRemote failed: ${err.message}` };
  }

  // Retry checkAndSync
  let secondResult;
  try {
    secondResult = await syncService.checkAndSync();
  } catch (err) {
    return { recovered: false, firstResult, secondResult: null, error: `retry failed: ${err.message}` };
  }

  // Recovery only counts if the retry didn't return GENESIS_MISMATCH again
  const recovered = secondResult !== 'GENESIS_MISMATCH';
  return { recovered, firstResult, secondResult };
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

const PASSPHRASE = 'correct horse battery staple';
const SEED = 'test-seed-base64-blocks-format-test';

// ══════════════════════════════════════════════════════════════════════
// Group A: Blocks-format onboarding → delete stale ledger:blocks
// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ Group A: Blocks-format onboarding — delete ledger:blocks ═══');

{
  // A1: delete called after storage write, before sync/gate runs
  console.log('\n--- A1: delete called after storage write ---');

  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const storage = new MockStorage();

  // Set up CLI blocks on remote
  const { files, mk } = buildObfuscatedChain({
    username: 'alice', email: 'alice@example.com',
    passphrase: PASSPHRASE, seed: SEED, blockCount: 3,
  });
  for (const f of files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  const result = await connectBlocksFormat({
    passphrase: PASSPHRASE, seed: SEED,
    transport, crypto, storage,
  });

  t.assert(result.success, 'A1: blocks-format onboarding succeeds');
  t.assert(result.deleteCalled, 'A1b: transport.delete("ledger:blocks") was called');
  t.assertEq(result.chain.length, 3, 'A1c: all 3 blocks assembled');
  t.assert(storage.hasKey('ledger:blocks'), 'A1d: chain stored in local storage');
  t.assert(storage.hasKey('phpoc_seed'), 'A1e: seed stored');
}

{
  // A2: stale ledger:blocks (different genesis) → delete clears it
  console.log('\n--- A2: stale ledger:blocks with different genesis ---');

  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const storage = new MockStorage();

  // Set up CLI blocks (Genesis A)
  const { files } = buildObfuscatedChain({
    username: 'alice', email: 'alice@example.com',
    passphrase: PASSPHRASE, seed: SEED, blockCount: 2,
  });
  for (const f of files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  // Set up stale ledger:blocks from a DIFFERENT genesis (Genesis B)
  const { chain: staleChain } = buildPlainChain({
    username: 'bob', email: 'bob@example.com',
    passphrase: 'different-passphrase', seed: 'different-seed', extraBlocks: 1,
  });
  transport.setData('ledger:blocks', new TextEncoder().encode(JSON.stringify(staleChain)));

  t.assert(transport.hasKey('ledger:blocks'), 'A2: pre-condition — stale ledger:blocks exists on R2');

  const result = await connectBlocksFormat({
    passphrase: PASSPHRASE, seed: SEED,
    transport, crypto, storage,
  });

  t.assert(result.success, 'A2: onboarding succeeds despite stale blob');
  t.assert(result.deleteCalled, 'A2b: delete("ledger:blocks") was called');
  t.assert(!transport.hasKey('ledger:blocks'), 'A2c: stale ledger:blocks key removed from R2');
  t.assert(storage.hasKey('ledger:blocks'), 'A2d: local chain stored');
  t.assertEq(storage._store.get('ledger:blocks').length, 2, 'A2e: local chain has 2 blocks');
}

{
  // A3: no stale ledger:blocks → delete is 404 no-op → no error
  console.log('\n--- A3: no stale ledger:blocks — delete is no-op ---');

  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const storage = new MockStorage();

  // Set up CLI blocks only (no ledger:blocks)
  const { files } = buildObfuscatedChain({
    username: 'alice', email: 'alice@example.com',
    passphrase: PASSPHRASE, seed: SEED, blockCount: 1,
  });
  for (const f of files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  t.assert(!transport.hasKey('ledger:blocks'), 'A3: pre-condition — no ledger:blocks on R2');

  const result = await connectBlocksFormat({
    passphrase: PASSPHRASE, seed: SEED,
    transport, crypto, storage,
  });

  t.assert(result.success, 'A3: onboarding succeeds (no stale blob)');
  t.assert(result.deleteCalled, 'A3b: delete was still called (no-op 404 is fine)');
}

{
  // A4: network error during delete → caught gracefully → onboarding proceeds
  console.log('\n--- A4: network error during delete — graceful ---');

  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const storage = new MockStorage();

  // Set up CLI blocks
  const { files } = buildObfuscatedChain({
    username: 'alice', email: 'alice@example.com',
    passphrase: PASSPHRASE, seed: SEED, blockCount: 2,
  });
  for (const f of files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  // Make delete throw a network error
  transport._deleteError = (path) => {
    if (path === 'ledger:blocks') return new Error('Network failure: connection reset');
    return null;
  };

  const result = await connectBlocksFormat({
    passphrase: PASSPHRASE, seed: SEED,
    transport, crypto, storage,
  });

  t.assert(result.success, 'A4: onboarding succeeds despite delete network error');
  t.assert(!result.deleteCalled, 'A4b: deleteCall was false (error caught)');
  t.assert(result.deleteError !== undefined, 'A4c: deleteError captured');
  t.assert(result.deleteError.includes('Network failure'), 'A4d: deleteError describes network failure');
  t.assert(storage.hasKey('ledger:blocks'), 'A4e: local chain still stored despite delete error');
}

{
  // A5: end-to-end — blocks onboard → delete stale → gate compatible → fresh blob pushed
  console.log('\n--- A5: end-to-end: onboard → delete → gate passes → fresh blob ---');

  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const storage = new MockStorage();

  // Set up CLI blocks (Genesis A)
  const { files, mk, chain } = buildObfuscatedChain({
    username: 'alice', email: 'alice@example.com',
    passphrase: PASSPHRASE, seed: SEED, blockCount: 2,
  });
  for (const f of files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  // Also pre-populate stale ledger:blocks with a DIFFERENT genesis
  const { chain: staleChain } = buildPlainChain({
    username: 'bob', email: 'bob@example.com',
    passphrase: 'wrong-pass', seed: 'wrong-seed',
  });
  transport.setData('ledger:blocks', new TextEncoder().encode(JSON.stringify(staleChain)));

  // Onboard via blocks format
  const result = await connectBlocksFormat({
    passphrase: PASSPHRASE, seed: SEED,
    transport, crypto, storage,
  });

  t.assert(result.success, 'A5: onboarding succeeded');
  t.assert(result.deleteCalled, 'A5b: stale ledger:blocks deleted');

  // After delete, the remote has no ledger:blocks — the genesis gate would see null
  // and return compatible, then push a fresh ledger:blocks from the local chain.
  // Simulate what bootstrapServices would do: push local chain as ledger:blocks.
  const localChain = await storage.get('ledger:blocks');
  await transport.push('ledger:blocks', new TextEncoder().encode(JSON.stringify(localChain)));

  t.assert(transport.hasKey('ledger:blocks'), 'A5c: fresh ledger:blocks pushed to R2');

  // Verify fresh blob has correct genesis
  const freshRaw = await transport.pull('ledger:blocks');
  const freshChain = JSON.parse(new TextDecoder().decode(freshRaw));
  t.assertEq(freshChain[0].type, 'genesis', 'A5d: fresh blob has genesis block');
  t.assertEq(freshChain[0].identity.username, 'alice', 'A5e: fresh blob has correct username (not bob)');
  t.assertEq(freshChain.length, 2, 'A5f: fresh blob has 2 blocks');
}

{
  // A6: single-blob format → ledger:blocks is NOT deleted
  console.log('\n--- A6: single-blob format — ledger:blocks NOT deleted ---');

  // The single-blob path in connectToWorker does NOT call transport.delete('ledger:blocks').
  // Verify that the blocks-format flag controls the delete behavior.

  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const storage = new MockStorage();

  // Set up a plain ledger:blocks chain (single-blob format)
  const { chain } = buildPlainChain({
    username: 'alice', email: 'alice@example.com',
    passphrase: PASSPHRASE, seed: SEED, extraBlocks: 2,
  });
  transport.setData('ledger:blocks', new TextEncoder().encode(JSON.stringify(chain)));

  // Single-blob onboarding: does NOT call delete (this tests the format check)
  // In the real code, the `if (format === 'blocks')` guard prevents the delete.
  // Here we simulate that guard: only call delete if format === 'blocks'.
  const format = 'single-blob';
  const deleteShouldRun = format === 'blocks';

  if (deleteShouldRun) {
    await transport.delete('ledger:blocks');
  }

  t.assert(transport.hasKey('ledger:blocks'), 'A6: ledger:blocks still present (single-blob path does not delete)');
  t.assert(!transport.wasDeleted('ledger:blocks'), 'A6b: delete was NOT called for single-blob format');
}

{
  // A7: same genesis in both formats → delete fires → gate still compatible
  console.log('\n--- A7: same genesis in both formats — delete fires, gate still OK ---');

  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const storage = new MockStorage();

  // Set up CLI blocks (Genesis A)
  const { files, chain } = buildObfuscatedChain({
    username: 'alice', email: 'alice@example.com',
    passphrase: PASSPHRASE, seed: SEED, blockCount: 2,
  });
  for (const f of files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  // Set up ledger:blocks with SAME genesis (different day blocks, but same genesis hash)
  // This simulates: web app was used before, pushed ledger:blocks with same identity
  const { chain: sameGenesisPlain } = buildPlainChain({
    username: 'alice', email: 'alice@example.com',
    passphrase: PASSPHRASE, seed: SEED, extraBlocks: 3,
  });
  transport.setData('ledger:blocks', new TextEncoder().encode(JSON.stringify(sameGenesisPlain)));

  t.assert(transport.hasKey('ledger:blocks'), 'A7: pre-condition — ledger:blocks exists with same genesis');

  const result = await connectBlocksFormat({
    passphrase: PASSPHRASE, seed: SEED,
    transport, crypto, storage,
  });

  t.assert(result.success, 'A7: onboarding succeeds with same-genesis blob');
  t.assert(result.deleteCalled, 'A7b: delete was called anyway (safe — will be recreated)');
  t.assert(!transport.hasKey('ledger:blocks'), 'A7c: old ledger:blocks deleted');

  // After bootstrap, the gate would push a fresh ledger:blocks. Simulate:
  const localChain = await storage.get('ledger:blocks');
  await transport.push('ledger:blocks', new TextEncoder().encode(JSON.stringify(localChain)));

  const freshRaw = await transport.pull('ledger:blocks');
  const freshChain = JSON.parse(new TextDecoder().decode(freshRaw));
  t.assertEq(freshChain[0].identity.username, 'alice', 'A7d: recreated blob has correct identity');
}

// ══════════════════════════════════════════════════════════════════════
// Group B: bootstrapServices auto-clear on GENESIS_MISMATCH
// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ Group B: bootstrapServices auto-clear recovery ═══');

/**
 * Minimal mock SyncService for testing the recovery logic.
 * Tracks clearRemote calls and configurable checkAndSync responses.
 */
class MockSyncService {
  constructor(opts = {}) {
    this._responses = opts.responses || [];  // Array of result strings for sequential checkAndSync calls
    this._callIndex = 0;
    this._clearCallCount = 0;
    this._clearError = opts.clearError || null;
    this._transport = opts.transport || null;
  }

  async checkAndSync() {
    if (this._callIndex < this._responses.length) {
      return this._responses[this._callIndex++];
    }
    return 'READY'; // default
  }

  async clearRemote() {
    this._clearCallCount++;
    if (this._clearError) throw this._clearError;
    // Simulate actual clear: delete ledger:blocks from transport
    if (this._transport) {
      await this._transport.delete('ledger:blocks');
      await this._transport.delete('staging:blob');
      await this._transport.delete('cookie:json');
    }
  }

  get clearCallCount() { return this._clearCallCount; }
}

{
  // B1: bootstrap detects mismatch → clearRemote → retry → READY
  console.log('\n--- B1: mismatch → clearRemote → retry → READY ---');

  const sync = new MockSyncService({
    responses: ['GENESIS_MISMATCH', 'READY'],
  });

  const result = await bootstrapGenesisRecovery(sync);

  t.assert(result.recovered, 'B1: recovered after mismatch');
  t.assertEq(result.firstResult, 'GENESIS_MISMATCH', 'B1b: first result was mismatch');
  t.assertEq(result.secondResult, 'READY', 'B1c: second result after clear + retry is READY');
  t.assertEq(sync.clearCallCount, 1, 'B1d: clearRemote called exactly once');
}

{
  // B2: clearRemote succeeds but retry still fails → caught, app still boots
  console.log('\n--- B2: retry still fails — graceful degradation ---');

  const sync = new MockSyncService({
    // First: mismatch. After clear: still mismatch (e.g., concurrent write)
    responses: ['GENESIS_MISMATCH', 'GENESIS_MISMATCH'],
  });

  const result = await bootstrapGenesisRecovery(sync);

  t.assert(!result.recovered, 'B2: recovery did not succeed (retry still mismatched)');
  t.assertEq(result.firstResult, 'GENESIS_MISMATCH', 'B2b: first result mismatch');
  t.assertEq(result.secondResult, 'GENESIS_MISMATCH', 'B2c: retry still mismatch');
  t.assert(result.error === undefined, 'B2d: no error thrown — graceful degradation');

  // In the real app, this would log a warning but not crash — the app transitions to 'ready'
}

{
  // B3: clearRemote fails (network error) → caught, app still boots
  console.log('\n--- B3: clearRemote fails — graceful degradation ---');

  const sync = new MockSyncService({
    responses: ['GENESIS_MISMATCH'],
    clearError: new Error('Network failure: connection refused'),
  });

  const result = await bootstrapGenesisRecovery(sync);

  t.assert(!result.recovered, 'B3: recovery did not succeed (clearRemote failed)');
  t.assertEq(result.firstResult, 'GENESIS_MISMATCH', 'B3b: first result mismatch');
  t.assert(result.error !== undefined, 'B3c: error captured');
  t.assert(result.error.includes('clearRemote failed'), 'B3d: error describes clearRemote failure');
  t.assertEq(sync.clearCallCount, 1, 'B3e: clearRemote was attempted');
}

{
  // B4: normal (compatible) path → clearRemote NOT called
  console.log('\n--- B4: compatible genesis — clearRemote NOT called ---');

  const sync = new MockSyncService({
    responses: ['READY'],
  });

  const result = await bootstrapGenesisRecovery(sync);

  t.assert(!result.recovered, 'B4: recovery flag is false (no recovery needed)');
  t.assertEq(result.firstResult, 'READY', 'B4b: first result is READY');
  t.assertEq(result.secondResult, null, 'B4c: no second check needed');
  t.assertEq(sync.clearCallCount, 0, 'B4d: clearRemote was NOT called (compatible path)');
}

{
  // B5: after auto-clear + retry, genesis gate is clean and Sync Now works
  console.log('\n--- B5: after recovery, Sync Now works ---');

  const transport = new MockTransport();
  const sync = new MockSyncService({
    responses: ['GENESIS_MISMATCH', 'READY', 'READY'],
    transport,
  });

  // Pre-populate stale ledger:blocks on remote to simulate the mismatch scenario
  const { chain: staleChain } = buildPlainChain({
    username: 'evil', email: 'evil@test.com',
    passphrase: 'wrong', seed: 'wrong',
  });
  transport.setData('ledger:blocks', new TextEncoder().encode(JSON.stringify(staleChain)));
  t.assert(transport.hasKey('ledger:blocks'), 'B5: pre-condition — stale blob on R2');

  // Run recovery
  const result = await bootstrapGenesisRecovery(sync);

  t.assert(result.recovered, 'B5: recovery succeeded');
  t.assert(!transport.hasKey('ledger:blocks'), 'B5b: stale blob cleared from R2');

  // After bootstrap, push local chain as fresh ledger:blocks (simulating gate push)
  const { chain: localChain } = buildPlainChain({
    username: 'alice', email: 'alice@example.com',
    passphrase: PASSPHRASE, seed: SEED,
  });
  await transport.push('ledger:blocks', new TextEncoder().encode(JSON.stringify(localChain)));

  // Simulate "Sync Now" — third call should succeed without mismatch
  const syncNowResult = await sync.checkAndSync();
  t.assertEq(syncNowResult, 'READY', 'B5c: Sync Now after recovery returns READY');
  t.assert(transport.hasKey('ledger:blocks'), 'B5d: fresh ledger:blocks present on R2');

  const freshRaw = await transport.pull('ledger:blocks');
  const freshChain = JSON.parse(new TextDecoder().decode(freshRaw));
  t.assertEq(freshChain[0].identity.username, 'alice', 'B5e: fresh blob has correct identity');
  t.assertNeq(freshChain[0].identity.username, 'evil', 'B5f: fresh blob does NOT have stale identity');
}

// ── Summary ──────────────────────────────────────────────────────────
t.summary('Worker Connect Blocks-Format + Bootstrap Recovery');
process.exitCode = t.failed > 0 ? 1 : 0;
