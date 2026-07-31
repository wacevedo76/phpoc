/**
 * unlock_performance_regression_test.mjs — TDD RED phase for unlock performance regression fixes.
 *
 * Three fix areas tested:
 *   Group A: Hash Index Bootstrap Gap — hash_index pushed on import/unlock
 *   Group B: Cookie Catch-22 — local cookie created during login when MK exists
 *   Group C: Specifier Mismatch Short-Circuit — REAUTH_NEEDED before blob pull
 *
 * RED phase: Tests exercise behavior that doesn't exist yet → should FAIL.
 * GREEN phase: After fixes are implemented, all tests pass.
 *
 * Usage:
 *   node test/unlock_performance_regression_test.mjs
 */

import { createHash } from 'crypto';

import { SyncService, SyncResult } from '../src/sync/sync.js';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort } from '../src/ledger/utils.js';
import { buildHashIndex } from '../src/sync/hash_index.js';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Mock Transport — in-memory remote storage
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this._store = new Map();
    /** @type {Map<string, Array<Uint8Array|null>>} */
    this._queue = new Map();
    this._offline = false;
    this._pushCalls = [];
    this._pullCalls = [];
    this._deleteCalls = [];
  }

  queueResponse(path, value) {
    const arr = this._queue.get(path) || [];
    arr.push(value);
    this._queue.set(path, arr);
  }

  async pull(path) {
    this._pullCalls.push(path);
    if (this._offline) throw new Error('Network failure');
    const queue = this._queue.get(path);
    if (queue && queue.length > 0) return queue.shift();
    const val = this._store.get(path);
    return val !== undefined ? val : null;
  }

  async push(path, data) {
    this._pushCalls.push({ path, size: data?.length || 0 });
    if (this._offline) throw new Error('Network failure');
    this._store.set(path, data);
  }

  async delete(path) {
    this._deleteCalls.push(path);
    if (this._offline) throw new Error('Network failure');
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

  hasKey(path) { return this._store.has(path); }

  /**
   * Get ALL pull calls (for detailed assertions on call sequence).
   */
  get pullCalls() { return [...this._pullCalls]; }

  /**
   * Get ALL push calls with {path, size}.
   */
  get pushCalls() { return [...this._pushCalls]; }

  resetCallTracking() {
    this._pushCalls = [];
    this._pullCalls = [];
    this._deleteCalls = [];
  }

  resetCache() { /* no-op */ }
}

// ══════════════════════════════════════════════════════════════════════
// Mock CryptoService (matches sync_service_test.mjs conventions)
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor() {
    this._uuidCounter = 0;
    this._specCounter = 0;
    this._mk = null;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  generateUuid() {
    this._uuidCounter++;
    return `00000000-0000-0000-0000-${String(this._uuidCounter).padStart(12, '0')}`;
  }

  generateDeviceSpecifier() {
    this._specCounter++;
    return `spec${String(this._specCounter).padStart(31, '0')}`;
  }

  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }
  hasMasterKey() { return !!this._mk; }

  getDeviceId(mk) {
    return `dev-${(mk || '').slice(0, 8)}`;
  }

  seal(jsonStr, masterKey) {
    if (!masterKey) masterKey = this._mk || 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    return createHash('sha256').update(masterKey + ':' + jsonStr).digest('hex');
  }

  verifySeal(jsonStr, sealVal, masterKey) {
    return this.seal(jsonStr, masterKey) === sealVal;
  }

  /**
   * Compute block seal excluding non-content fields.
   * Mirrors _verifyBlockData in merge.js: excludes seal key, signature, and format_version.
   */
  sealBlock(blockData) {
    const copy = {};
    for (const [k, v] of Object.entries(blockData)) {
      if (k !== 'day_hash' && k !== 'month_hash' && k !== 'year_hash' && k !== 'signature' && k !== 'format_version') {
        copy[k] = v;
      }
    }
    return this.seal(jsonSort(copy));
  }

  obfuscateBlob(plaintext, mk) {
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = mk
      ? createHash('sha256').update(mk).digest().slice(0, 4)
      : Buffer.alloc(4);
    const obfuscated = Buffer.concat([keyFingerprint, plainBytes]);
    return obfuscated.toString('base64');
  }

  deobfuscateBlob(b64, mk) {
    const obfuscated = Buffer.from(b64, 'base64');
    const storedFingerprint = obfuscated.slice(0, 4);
    if (mk) {
      const expectedFingerprint = createHash('sha256').update(mk).digest().slice(0, 4);
      if (!storedFingerprint.equals(expectedFingerprint)) {
        throw new Error('key mismatch');
      }
    }
    return obfuscated.slice(4).toString('utf-8');
  }

  decrypt(ciphertextHex, _masterKey) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }

  decryptWithCachedKey(ciphertextHex) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('plain:')) {
      return ciphertextHex.slice(6);
    }
    return ciphertextHex;
  }

  encrypt(plaintext, _masterKey) {
    return `enc:${plaintext}`;
  }

  encryptWithCachedKey(plaintext) {
    return `enc:${plaintext}`;
  }
}

// ══════════════════════════════════════════════════════════════════════
// In-Memory Storage Backend
// ══════════════════════════════════════════════════════════════════════

class MemoryBackend {
  constructor() { this._store = new Map(); }
  async get(key) { return this._store.get(key); }
  async set(key, val) { this._store.set(key, val); }
  async delete(key) { this._store.delete(key); }
  async remove(key) { this._store.delete(key); }  // alias for DeviceCookie.destroyLocally
  async list() { return [...this._store.keys()]; }
  async clear() { this._store.clear(); }

  /** Convenience: check if a key exists */
  has(key) { return this._store.has(key); }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const BLOB_PATH = 'staging/blob';
const COOKIE_PATH = 'staging/blobs/device_cookie.bin';
const HASH_INDEX_PATH = 'ledger/hash_index.json';
const HASH_INDEX_SHA256_PATH = 'ledger/hash_index.sha256';
const LEDGER_BLOCKS_KEY = 'ledger:blocks';
const LOCAL_HASH_INDEX_KEY = 'ledger:hash_index';
const ZERO_HASH = '0'.repeat(64);
const LEDGER_BLOCKS_PREFIX = 'ledger/blocks/';

function _bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function _base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Create a SyncService with mock transport and crypto.
 */
function createSyncService({
  withTransport = true,
  withMasterKey = false,
  masterKey = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
  cookieTtl = 30,
} = {}) {
  const storage = new MemoryBackend();
  const crypto = new MockCrypto();
  const transport = withTransport ? new MockTransport() : null;

  if (withMasterKey) {
    crypto.setMasterKey(masterKey);
  }

  const sync = new SyncService(storage, crypto, transport, {
    cookieTtlMinutes: cookieTtl,
  });

  return { sync, storage, crypto, transport };
}

/**
 * Push a remote cookie directly to the mock transport.
 */
async function pushRemoteCookie(transport, deviceUuid, specifier) {
  const cookieJson = JSON.stringify({
    device_uuid: deviceUuid,
    device_specifier: specifier,
  });
  await transport.push(COOKIE_PATH, new TextEncoder().encode(cookieJson));
}

/**
 * Build a minimal test chain (genesis + day blocks).
 */
function buildTestChain(opts = {}) {
  const {
    username = 'testuser',
    email = 'test@example.com',
    formatVersion = '0.3.0',
    mk = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  } = opts;

  const crypto = new MockCrypto();
  crypto.setMasterKey(mk);

  const genesisContent = {
    type: 'genesis',
    format_version: formatVersion,
    day_index: 0,
    date: '2026-01-01',
    identity: {
      username,
      email,
      recovery_seed_enc: 'enc:mockseed',
      identity_pub_key: 'mockpubkey0000000000000000000000000000000000000000000000000000',
      identity_secret_enc_fallback: 'enc:mocksecret',
    },
    prev_hash: ZERO_HASH,
    entries: [],
  };
  genesisContent.day_hash = crypto.sealBlock(genesisContent);

  // Day block
  const entryData = {
    title: 'Test Entry',
    startTime_enc: 'enc:1700000000000',
    endTime_enc: 'enc:1700003600000',
    duration: 3600000,
    tags: [],
    pauses_enc: 'enc:[]',
    metadata_enc: 'enc:{}',
    comment: '',
    media: [],
    content_hash: crypto.sha256(JSON.stringify({ title: 'Test Entry', duration: 3600000 })),
  };
  const dayEntry = { hash: crypto.sha256(JSON.stringify(entryData, null, 2)), data: entryData };

  const dayContent = {
    type: 'day',
    day_index: 1,
    date: '2026-06-20',
    prev_hash: genesisContent.day_hash,
    entries: [dayEntry],
  };
  dayContent.day_hash = crypto.sealBlock(dayContent);

  return [genesisContent, dayContent];
}

/**
 * Push a chain to the mock remote in canonical blocks format.
 * Each block is obfuscated and stored as ledger/blocks/NNNNNN.json.
 * Does NOT push hash_index files (simulates ledger without hash index).
 */
async function pushRemoteChain(transport, chain, mk = 'deadbeef') {
  if (!chain || chain.length === 0) return;
  const crypt = new MockCrypto();
  for (let i = 0; i < chain.length; i++) {
    const block = chain[i];
    const dayIndex = block.day_index ?? i;
    const filename = String(dayIndex).padStart(6, '0') + '.json';
    const json = JSON.stringify(block);
    const b64 = crypt.obfuscateBlob(json, mk);
    const bytes = _base64ToBytes(b64);
    await transport.push(LEDGER_BLOCKS_PREFIX + filename, bytes);
  }
}

/**
 * Build and push hash index artifacts to mock remote.
 */
async function pushHashIndex(transport, chain, crypto) {
  const hi = buildHashIndex(chain);
  const hiJson = JSON.stringify(hi);
  await transport.push(HASH_INDEX_PATH, new TextEncoder().encode(hiJson));
  const hiSha256 = crypto.sha256(hiJson);
  await transport.push(HASH_INDEX_SHA256_PATH, new TextEncoder().encode(hiSha256));
}

/**
 * Push a remote staging blob to the mock transport.
 */
async function pushRemoteBlob(transport, crypto, entries, deviceId, mk) {
  const rawEntries = entries.map(e => ({
    entry_id: e.entry_id || `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hash: e.hash || `h-${e.entry_id}`,
    data: {
      entry_id: e.entry_id,
      title: e.title,
      startTime_enc: `plain:${e.start_epoch}`,
      endTime_enc: e.end_epoch != null ? `plain:${e.end_epoch}` : undefined,
      duration: e.duration || 0,
      is_active: e.is_active || false,
      is_paused: e.is_paused || false,
      pauses_enc: 'plain:[]',
      metadata_enc: 'plain:{}',
      tags: e.tags || [],
      comment: e.comment || null,
      media: e.media || [],
      device_uuid: deviceId,
      end_device_uuid: '',
    },
  }));

  const blob = JSON.stringify({
    device_id: deviceId,
    device_proof: '',
    entries: rawEntries,
    updated_at: Date.now(),
  });
  const obfuscated = crypto.obfuscateBlob(blob, mk);
  const bytes = new Uint8Array(Buffer.from(obfuscated, 'base64'));
  await transport.push(BLOB_PATH, bytes);
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ Unlock Performance Regression Test Suite (RED Phase) ══\n');

  // ═══════════════════════════════════════════════════════════════
  // Group A: Hash Index Bootstrap Gap
  //
  // hash_index.sha256 and hash_index.json should be pushed to remote
  // during genesis gate check and during pushLedgerBlocks. Currently:
  //   - pushLedgerBlocks pushes hash index only when pushed > 0
  //   - _genesisGatePhase pushes hash index only when result.merged === true
  //   - After import/onboarding, hash index is never pushed because no
  //     merge happened and no blocks were pushed.
  //
  // Fix: Always push hash index when blocks exist locally, regardless
  // of whether any new blocks were pushed.
  // ═══════════════════════════════════════════════════════════════
  console.log('── Group A: Hash Index Bootstrap Gap ──\n');

  // A1. pushLedgerBlocks pushes hash index even when no new blocks to push
  //     (hash index should always be present on remote when blocks exist)
  {
    const mk = 'a1-hash----a1-hash----a1-hash----a1-hash----aa';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // Push the same chain to remote (both sides identical)
    await pushRemoteChain(transport, chain, mk);

    // Clear tracking before the test
    transport.resetCallTracking();

    // Call pushLedgerBlocks — since chains are identical, pushed should be 0
    const pushed = await sync.pushLedgerBlocks();
    // Currently: pushed = 0 because no new blocks → hash index NOT pushed
    // FIX: push hash index unconditionally when blocks exist

    // After fix: hash index files should exist on remote even when pushed=0
    const hasHashIndexSha256 = transport.hasKey(HASH_INDEX_SHA256_PATH);
    const hasHashIndexJson = transport.hasKey(HASH_INDEX_PATH);

    if (!hasHashIndexSha256 || !hasHashIndexJson) {
      console.log('  [RED] Currently fails — hash index NOT pushed when pushed=0');
    }
    t.assert(hasHashIndexSha256, 'A1a. hash_index.sha256 pushed to remote (even when pushed=0)');
    t.assert(hasHashIndexJson, 'A1b. hash_index.json pushed to remote (even when pushed=0)');
  }

  // A2. pushLedgerBlocks hash index pushed even when blocks already in sync
  //     (remote already has all blocks — pushed=0 — but hash index still pushed)
  {
    const mk = 'a2-hash----a2-hash----a2-hash----a2-hash----bb';
    const chain = buildTestChain({ mk });
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // Pre-populate remote with same blocks (simulates imported ledger)
    await pushRemoteChain(transport, chain, mk);

    transport.resetCallTracking();

    // Push blocks — should see all blocks already on remote (pushed=0)
    // After fix: hash index should still be pushed even when pushed=0
    const pushed = await sync.pushLedgerBlocks();

    // Verify hash index content
    const shaRaw = await transport.pull(HASH_INDEX_SHA256_PATH);
    const hiRaw = await transport.pull(HASH_INDEX_PATH);

    if (shaRaw !== null && hiRaw !== null) {
      const remoteSha = new TextDecoder().decode(shaRaw).trim().toLowerCase();
      const hiJson = new TextDecoder().decode(hiRaw);
      const expectedSha = crypto.sha256(hiJson);

      t.assertEq(remoteSha, expectedSha, 'A2a. hash_index.sha256 matches hash_index.json content');
    } else {
      // RED: either not pushed or verify failed
      const shaExists = shaRaw !== null;
      const hiExists = hiRaw !== null;
      console.log(`  [RED] sha256:${shaExists ? 'pushed' : 'MISSING'} hash_index.json:${hiExists ? 'pushed' : 'MISSING'}`);
      t.assert(false, 'A2. hash index content validation (files not found on remote)');
    }
  }

  // A3. pushLedgerBlocks hash index is cached locally
  {
    const mk = 'a3-hash----a3-hash----a3-hash----a3-hash----cc';
    const chain = buildTestChain({ mk });
    const { sync, storage } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    await sync.pushLedgerBlocks();

    const localHashIndex = await storage.get(LOCAL_HASH_INDEX_KEY);
    t.assert(Array.isArray(localHashIndex), 'A3a. local hash_index cached in storage');
    t.assertEq(localHashIndex.length, chain.length, 'A3b. local hash_index has same length as chain');

    // Verify first element is genesis block hash
    const expectedGenesisHash = chain[0].day_hash;
    t.assertEq(localHashIndex[0], expectedGenesisHash, 'A3c. first hash_index element is genesis block hash');
  }

  // A4. After genesis gate merge, hash index is pushed to remote
  {
    const mk = 'a4-merge---a4-merge---a4-merge---a4-merge---dd';
    const localChain = buildTestChain({ mk, username: 'local' });
    const remoteChain = buildTestChain({ mk, username: 'local' }); // Same genesis, different entries

    // Modify remote chain to add an extra entry (creates divergence → merge)
    const extraEntryData = {
      title: 'Extra Remote Entry',
      startTime_enc: 'enc:1700100000000',
      duration: 1000,
      tags: [],
      pauses_enc: 'enc:[]',
      metadata_enc: 'enc:{}',
      comment: '',
      media: [],
    };
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);
    const extraEntry = { hash: crypt.sha256(JSON.stringify(extraEntryData, null, 2)), data: extraEntryData };
    const extraDayBlock = {
      type: 'day',
      day_index: 2,
      date: '2026-06-21',
      prev_hash: remoteChain[1].day_hash,
      entries: [extraEntry],
    };
    extraDayBlock.day_hash = crypt.sealBlock({ ...extraDayBlock });
    remoteChain.push(extraDayBlock);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    await pushRemoteChain(transport, remoteChain, mk);

    // Need cookie to reach auth gate → reconcile
    await storage.set('cookie', {
      device_specifier: 'spec-a4',
      creation_time: Date.now(),
    });
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH, 'A4. genesis compatible (merge happened)');

    // After merge, hash index should be on remote
    const hasHashIndexSha256 = transport.hasKey(HASH_INDEX_SHA256_PATH);
    const hasHashIndexJson = transport.hasKey(HASH_INDEX_PATH);
    t.assert(hasHashIndexSha256, 'A4a. hash_index.sha256 pushed after genesis gate merge');
    t.assert(hasHashIndexJson, 'A4b. hash_index.json pushed after genesis gate merge');
  }

  // A5. Hash index NOT pushed when no blocks exist (empty ledger)
  {
    const mk = 'a5-empty---a5-empty---a5-empty---a5-empty---ee';
    const { sync, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // No blocks in storage

    const pushed = await sync.pushLedgerBlocks();
    t.assertEq(pushed, 0, 'A5. pushLedgerBlocks returns 0 for empty chain');

    // Hash index should NOT exist on remote (nothing to index)
    const hasHashIndexSha256 = transport.hasKey(HASH_INDEX_SHA256_PATH);
    const hasHashIndexJson = transport.hasKey(HASH_INDEX_PATH);
    t.assert(!hasHashIndexSha256, 'A5a. hash_index.sha256 NOT pushed for empty chain');
    t.assert(!hasHashIndexJson, 'A5b. hash_index.json NOT pushed for empty chain');
  }

  // A6. Hash index pushed when pushLedgerBlocks called with forceAll
  {
    const mk = 'a6-force---a6-force---a6-force---a6-force---ff';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    // forceAll should push all blocks + hash index
    const pushed = await sync.pushLedgerBlocks({ forceAll: true });

    const hasHashIndexSha256 = transport.hasKey(HASH_INDEX_SHA256_PATH);
    t.assert(hasHashIndexSha256, 'A6a. forceAll → hash_index.sha256 pushed');
    t.assert(transport.hasKey(HASH_INDEX_PATH), 'A6b. forceAll → hash_index.json pushed');
  }

  // ═══════════════════════════════════════════════════════════════
  // Group B: Cookie Catch-22
  //
  // During unlock/login, checkAndSync returns REAUTH_NEEDED because
  // there's no local cookie. But the cookie is only created in
  // _reconcileDifferentDevice() or pushToRemote(), both unreachable
  // when REAUTH_NEEDED short-circuits.
  //
  // Fix: When checkAndSync returns REAUTH_NEEDED but a valid master
  // key exists, create a local cookie so subsequent operations can
  // use the fast path.
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group B: Cookie Catch-22 ──\n');

  // B1. After REAUTH_NEEDED + valid MK, a local cookie should be created
  {
    const mk = 'b1-cookie--b1-cookie--b1-cookie--b1-cookie--aa';
    const { sync, storage, crypto } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // No local cookie exists (simulates fresh login)

    const result = await sync.checkAndSync();

    // Currently: REAUTH_NEEDED, no cookie created
    // FIX: after REAUTH_NEEDED + MK, create a local cookie
    if (result === SyncResult.REAUTH_NEEDED) {
      // Check if cookie was created as side effect
      const localCookie = await storage.get('cookie');
      const hasCookie = !!localCookie && !!localCookie.device_specifier;

      if (!hasCookie) {
        console.log('  [RED] Currently fails — REAUTH_NEEDED returns but no cookie created');
      }
      t.assert(hasCookie, 'B1a. local cookie created when REAUTH_NEEDED + MK exists');
    } else {
      t.assertEq(result, SyncResult.REAUTH_NEEDED, 'B1. expected REAUTH_NEEDED');
    }
  }

  // B2. Cookie created in B1 has correct format
  {
    const mk = 'b2-cookie--b2-cookie--b2-cookie--b2-cookie--bb';
    const { sync, storage, crypto } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await sync.checkAndSync(); // Triggers cookie creation (after fix)

    const localCookie = await storage.get('cookie');
    if (localCookie) {
      t.assert(!!localCookie.device_specifier, 'B2a. cookie has device_specifier');
      t.assert(typeof localCookie.creation_time === 'number', 'B2b. cookie has creation_time (number)');
      t.assert(localCookie.creation_time > 0, 'B2c. creation_time is non-zero');
      t.assert(localCookie.creation_time >= Date.now() - 10000,
        'B2d. creation_time is recent (within 10 seconds)');
    } else {
      t.assert(false, 'B2. no cookie found after REAUTH_NEEDED');
    }
  }

  // B3. No cookie created when MK is absent during REAUTH_NEEDED
  {
    const { sync, storage } = createSyncService({
      withTransport: true,
      withMasterKey: false, // No MK
    });

    await sync.checkAndSync();

    const localCookie = await storage.get('cookie');
    if (localCookie) {
      console.log('  [RED] Currently may create cookie even without MK');
    }
    t.assert(!localCookie, 'B3. no cookie created when MK is absent (cannot create without identity)');
  }

  // B4. Cookie from B1 enables fast path on next checkAndSync (with matching remote)
  {
    const mk = 'b4-cookie--b4-cookie--b4-cookie--b4-cookie--cc';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // First checkAndSync: no cookie → creates cookie (after fix)
    await sync.checkAndSync();

    const localCookie = await storage.get('cookie');
    if (!localCookie) {
      console.log('  [RED] B4 pre-condition: no cookie from first checkAndSync (fix not applied yet)');
      t.assert(false, 'B4. pre-condition: no cookie was created (fix not applied)');
      // Continue with other tests — pre-condition block doesn't stop suite
    } else {

      // Set up remote with matching cookie for fast path
      await pushRemoteCookie(transport, 'any-device', localCookie.device_specifier);

      // Second checkAndSync: should hit fast path
      const result2 = await sync.checkAndSync();
      t.assertEq(result2, SyncResult.READY, 'B4a. second checkAndSync hits fast path → READY');

      // Fast path should push blob
      const blobBytes = await transport.pull(BLOB_PATH);
      t.assert(blobBytes !== null, 'B4b. blob pushed to remote on fast path');
    }
  }

  // B5. Cookie TTL set correctly (30 min default)
  {
    const mk = 'b5-cookie--b5-cookie--b5-cookie--b5-cookie--dd';
    const { sync, storage } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // After fix: cookie should have 30-min TTL
    await sync.checkAndSync();

    const localCookie = await storage.get('cookie');
    if (localCookie) {
      // Verify it's not already expired (created just now, should be valid)
      t.assert(localCookie.creation_time >= Date.now() - 5000,
        'B5a. cookie creation_time is recent (< 5 seconds)');
    } else {
      console.log('  [RED] B5: no cookie from checkAndSync (fix not applied yet)');
      t.assert(false, 'B5. no cookie to test TTL');
    }
  }

  // B6. No duplicate cookie creation on repeated REAUTH_NEEDED
  {
    const mk = 'b6-cookie--b6-cookie--b6-cookie--b6-cookie--ee';
    const { sync, storage, crypto } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // First call: creates cookie (after fix)
    await sync.checkAndSync();
    const cookie1 = await storage.get('cookie');

    if (!cookie1) {
      console.log('  [RED] B6 pre-condition: no cookie from first checkAndSync (fix not applied yet)');
      t.assert(false, 'B6. pre-condition: no cookie from first checkAndSync');
    } else {
      // Expire the cookie so it's cleaned up and recreate
      await storage.set('cookie', {
        device_specifier: cookie1.device_specifier,
        creation_time: Date.now() - 31 * 60 * 1000, // 31 min ago → expired
      });

      // Second call: cookie expired → should get cleaned up → new cookie created
      await sync.checkAndSync();
      const cookie2 = await storage.get('cookie');

      if (cookie2) {
        // New cookie should have more recent (or same) creation_time
        t.assert(cookie2.creation_time >= cookie1.creation_time,
          'B6a. new cookie has recent creation_time');
      } else {
        t.assert(false, 'B6b. no cookie after second checkAndSync');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Group C: Specifier Mismatch Short-Circuit
  //
  // When the fast path detects a specifier mismatch between local
  // and remote cookies, _authGatePhase currently proceeds to
  // _reconcileAndClaim which does a full staging blob pull+merge+push.
  // The Python version returns REAUTH_NEEDED immediately on specifier
  // mismatch — the user must explicitly re-authenticate.
  //
  // Fix: Match Python behavior — return REAUTH_NEEDED immediately
  // on specifier mismatch in _authGatePhase.
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group C: Specifier Mismatch Short-Circuit ──\n');

  // C1. Specifier mismatch → REAUTH_NEEDED (not READY from reconcile)
  {
    const mk = 'c1-mismatch-c1-mismatch-c1-mismatch-c1-mismat-aa';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Local has spec-local, remote has spec-remote (mismatch)
    await storage.set('cookie', {
      device_specifier: 'spec-local-c1',
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'dev-c1-remote', 'spec-remote-different');

    const result = await sync.checkAndSync();

    // Currently: returns READY (reconcile succeeds)
    // FIX: should return REAUTH_NEEDED on specifier mismatch
    if (result === SyncResult.READY) {
      console.log('  [RED] Currently returns READY (reconcile) — should be REAUTH_NEEDED');
    }
    t.assertEq(result, SyncResult.REAUTH_NEEDED,
      'C1. specifier mismatch → REAUTH_NEEDED (no implicit reconcile)');
  }

  // C2. Specifier mismatch blocks reaching _reconcileAndClaim
  {
    const mk = 'c2-mismatch-c2-mismatch-c2-mismatch-c2-mismat-bb';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('cookie', {
      device_specifier: 'spec-local-c2',
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'dev-c2-remote', 'spec-remote-different');

    transport.resetCallTracking();

    await sync.checkAndSync();

    // After fix: should NOT pull staging blob (no reconcile)
    const stagingPull = transport._pullCalls.some(c => c === BLOB_PATH);
    if (stagingPull) {
      console.log('  [RED] Currently pulls staging blob during specifier mismatch');
    }
    t.assert(!stagingPull, 'C2a. no staging blob pull on specifier mismatch');

    // Should NOT push staging blob either
    const stagingPush = transport._pushCalls.some(c => c.path === BLOB_PATH);
    t.assert(!stagingPush, 'C2b. no staging blob push on specifier mismatch');
  }

  // C3. Specifier mismatch + no MK → REAUTH_NEEDED (no change, but verify)
  {
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: false, // No MK
    });

    await storage.set('cookie', {
      device_specifier: 'spec-local-c3',
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'dev-c3-remote', 'spec-remote-different');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED,
      'C3. specifier mismatch + no MK → REAUTH_NEEDED (existing behavior preserved)');
  }

  // C4. Matching specifiers still hit fast path (no regression)
  {
    const mk = 'c4-match---c4-match---c4-match---c4-match---cc';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const sharedSpec = 'spec-shared-c4';
    await storage.set('cookie', {
      device_specifier: sharedSpec,
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'dev-c4', sharedSpec);

    await sync.capture({ title: 'Fast Path Task', startEpoch: 1000 });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'C4. matching specifiers → READY (fast path works)');

    // Verify blob was pushed (fast path behavior)
    const blobBytes = await transport.pull(BLOB_PATH);
    t.assert(blobBytes !== null, 'C4b. blob pushed on fast path');
  }

  // C5. Specifier mismatch with valid MK + no remote blob → REAUTH_NEEDED
  //     (even with nothing to reconcile)
  {
    const mk = 'c5-mismatch-c5-mismatch-c5-mismatch-c5-mismat-dd';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('cookie', {
      device_specifier: 'spec-local-c5',
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'dev-c5-remote', 'spec-remote-different');
    // No staging blob on remote

    const result = await sync.checkAndSync();

    // Currently: enters reconcile → sees null blob → pushes local → READY
    // FIX: should return REAUTH_NEEDED immediately
    if (result === SyncResult.READY) {
      console.log('  [RED] Currently returns READY (reconcile with empty remote) — should be REAUTH_NEEDED');
    }
    t.assertEq(result, SyncResult.REAUTH_NEEDED,
      'C5. specifier mismatch → REAUTH_NEEDED even with empty remote');
  }

  // C6. Network not hit for cookie pull when no local cookie and no MK
  //     (specifier mismatch path is not even reached)
  {
    const { sync, transport } = createSyncService({
      withTransport: true,
      withMasterKey: false,
    });

    // No local cookie
    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'C6. no cookie + no MK → REAUTH_NEEDED');

    // Should still have pulled for genesis gate check (if no blocks)
    // Cookie pull may happen, but staging blob pull should NOT
    const blobPulls = transport._pullCalls.filter(c => c === BLOB_PATH);
    t.assertEq(blobPulls.length, 0, 'C6a. no staging blob pull when no cookie');
  }

  // ═══════════════════════════════════════════════════════════════
  // Group D: Combined Scenarios — All three fixes together
  //
  // Tests that verify the end-to-end unlock flow after all three
  // fixes are applied: hash index bootstrap, cookie creation, and
  // specifier mismatch short-circuit.
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group D: Combined Scenarios ──\n');

  // D1. Fresh unlock with remote chain + no cookie → hash index pushed + cookie created
  {
    const mk = 'd1-combo---d1-combo---d1-combo---d1-combo---aa';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Simulate freshly imported ledger (blocks exist, no cookie, remote matches)
    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    transport.resetCallTracking();

    // First checkAndSync: genesis gate runs, fast path fails (no cookie),
    // auth gate returns REAUTH_NEEDED → after fix: cookie created + hash index pushed
    const result = await sync.checkAndSync();
    // Result should be REAUTH_NEEDED (no cookie, no reconcile)
    // But cookie should be created for next time

    // Verify cookie was created
    const localCookie = await storage.get('cookie');
    const hasCookie = !!localCookie && !!localCookie.device_specifier;
    if (!hasCookie) {
      console.log('  [RED] D1a: cookie not created after fresh unlock');
    }
    t.assert(hasCookie, 'D1a. local cookie created after fresh unlock');

    // Verify hash index was pushed to remote
    const hasSha = transport.hasKey(HASH_INDEX_SHA256_PATH);
    const hasJson = transport.hasKey(HASH_INDEX_PATH);
    if (!hasSha || !hasJson) {
      console.log('  [RED] D1b: hash index not pushed after fresh unlock');
    }
    t.assert(hasSha, 'D1b. hash_index.sha256 pushed after fresh unlock');
    t.assert(hasJson, 'D1c. hash_index.json pushed after fresh unlock');
  }

  // D2. Second unlock within TTL: fast path works (cookie exists, hash index exists)
  {
    const mk = 'd2-combo---d2-combo---d2-combo---d2-combo---bb';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // First unlock sets up: chain + cookie + hash index
    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    // First checkAndSync → cookie created + hash index pushed (after fix)
    await sync.checkAndSync();

    // Get created cookie
    const cookie = await storage.get('cookie');
    if (!cookie || !cookie.device_specifier) {
      console.log('  [RED] D2 pre-condition: no cookie from first unlock (fix not applied yet)');
      t.assert(false, 'D2. pre-condition: no cookie from first unlock');
    } else {

    // Set up matching remote cookie for fast path
    await pushRemoteCookie(transport, 'dev-d2', cookie.device_specifier);

    // Push hash index so genesis gate uses Tier 1 fast path
    await pushHashIndex(transport, chain, new MockCrypto());

    // Reset and simulate second unlock
    transport.resetCallTracking();

    const result2 = await sync.checkAndSync();

    t.assertEq(result2, SyncResult.READY, 'D2a. second unlock → READY (fast path)');

    // Fast path should not trigger genesis chain pull
    const ledgerPulls = transport._pullCalls.filter(
      c => c.startsWith('ledger/blocks/') || c === 'ledger:blocks'
    );
    t.assertEq(ledgerPulls.length, 0, 'D2b. no ledger block pulls on second unlock');

    // Fast path should not pull staging blob (cookie matches → push only)
    const blobPulls = transport._pullCalls.filter(c => c === BLOB_PATH);
    t.assertEq(blobPulls.length, 0, 'D2c. no staging blob pull on fast path');
    }
  }

  // D3. Cross-device scenario: other device wrote → specifier mismatch → REAUTH_NEEDED
  {
    const mk = 'd3-combo---d3-combo---d3-combo---d3-combo---cc';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // First unlock to create cookie
    await sync.checkAndSync();
    const cookie = await storage.get('cookie');

    if (!cookie || !cookie.device_specifier) {
      console.log('  [RED] D3 pre-condition: no cookie from first unlock (fix not applied yet)');
      t.assert(false, 'D3. pre-condition: no cookie from first unlock');
    } else {

    // Simulate another device writing: push different cookie specifier
    await pushRemoteCookie(transport, 'dev-other-d3', 'spec-from-other-device');

    // Push hash index so genesis gate is fast
    await pushHashIndex(transport, chain, new MockCrypto());

    transport.resetCallTracking();

    // Second unlock: specifier mismatch → should be REAUTH_NEEDED (no blob pull)
    const result2 = await sync.checkAndSync();

    // Currently returns READY (reconcile succeeds implicitly)
    // FIX: should return REAUTH_NEEDED
    if (result2 === SyncResult.READY) {
      console.log('  [RED] D3: currently READY (implicit reconcile) — should be REAUTH_NEEDED');
    }
    t.assertEq(result2, SyncResult.REAUTH_NEEDED,
      'D3. cross-device specifier mismatch → REAUTH_NEEDED');

    // Should NOT pull staging blob
    const blobPulls = transport._pullCalls.filter(c => c === BLOB_PATH);
    t.assertEq(blobPulls.length, 0, 'D3b. no staging blob pull on specifier mismatch');
    }
  }

  // ── Results ───────────────────────────────────────────────────────
  t.summary('Unlock Performance Regression');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
