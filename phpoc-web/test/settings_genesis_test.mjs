/**
 * settings_genesis_test.mjs — Settings UI genesis gate integration tests.
 *
 * Tests the Settings screen's genesis gate behavior when saving a
 * Worker URL. Simulates the handleSaveRemote handler logic without
 * React rendering — pure logic tests of the gate integration.
 *
 * Coverage:
 *   S1–S3: Save triggers genesis check (compatible, incompatible, network error)
 *   S4: Resets to idle when URL is cleared
 *   S5: API key change re-triggers check
 *   S6: No check when URL unchanged
 *   S7: No local ledger → skips check (idle)
 *   S8: No master key → skips check (idle)
 *   S9: Invalid URL → error status
 *
 * Usage:
 *   node test/settings_genesis_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { GenesisGate } from '../src/sync/genesis_gate.js';

const t = new TestHelpers();

// ── Mock Crypto (matches patterns from genesis_gate_test) ──────────

class MockCrypto {
  constructor() {
    this._mk = null;
  }

  seal(jsonStr, masterKey) {
    // Deterministic HMAC seal: SHA-256(masterKey + ":" + jsonStr)
    if (!masterKey) masterKey = this._mk || 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    return createHash('sha256').update(masterKey + ':' + jsonStr).digest('hex');
  }

  verifySeal(jsonStr, sealVal, masterKey) {
    const expected = this.seal(jsonStr, masterKey);
    return expected === sealVal;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  // sign() is not needed for genesis gate (identitySecret=null), but must exist for API compat
  sign(hash, secret) { return 'mock-sig'; }

  verifySignature(hash, sig, secret) { return true; }

  // decrypt() required by LedgerMerge.merge() → not called if no remote day entries,
  // but must exist for API compatibility so _verifyChain doesn't crash on ref
  async decrypt(ciphertext, mk) {
    return ciphertext;
  }

  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }
}

// ── Mock Transport ────────────────────────────────────────────────

class MockTransport {
  constructor() {
    this._store = new Map();
    this._offline = false;
    this._throwOnPull = null;
  }

  async pull(path) {
    if (this._offline) throw new Error('Network failure');
    if (this._throwOnPull) throw this._throwOnPull;
    return this._store.get(path) || null;
  }

  setData(path, value) {
    this._store.set(path, value);
  }

  setOffline(val) { this._offline = val; }
  setThrowOnPull(err) { this._throwOnPull = err; }
}

// ── Mock Storage ─────────────────────────────────────────────────

class MockStorage {
  constructor() {
    this._store = new Map();
  }
  async get(key) { return this._store.get(key); }
  async set(key, val) { this._store.set(key, val); }
  async delete(key) { this._store.delete(key); }
}

// ── Chain builder (same pattern as genesis_gate_test) ───

const ZERO_HASH = '0'.repeat(64);

function sortKeysJSON(obj) {
  const sortKeys = (o) => {
    if (o === null || o === undefined || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(sortKeys);
    return Object.keys(o).sort().reduce((acc, k) => { acc[k] = sortKeys(o[k]); return acc; }, {});
  };
  return JSON.stringify(sortKeys(obj));
}

function buildGenesisBlock(opts = {}) {
  const {
    username = 'testuser',
    email = 'test@example.com',
    date = '2026-01-01',
    formatVersion = '0.3.0',
    masterKey = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  } = opts;

  const crypto = new MockCrypto();
  const content = {
    type: 'genesis',
    format_version: formatVersion,
    day_index: 0,
    date,
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
  const sealJson = sortKeysJSON(content);
  content.day_hash = crypto.seal(sealJson, masterKey);
  return content;
}

function getBlockHash(block) {
  return block.day_hash || block.month_hash || block.year_hash;
}

function buildChain(genesisOpts = {}) {
  const genesis = buildGenesisBlock(genesisOpts);
  const dayContent = {
    type: 'day',
    day_index: 1,
    date: '2026-06-20',
    prev_hash: getBlockHash(genesis),
    entries: [],
  };
  const crypto = new MockCrypto();
  const sealJson = sortKeysJSON(dayContent);
  dayContent.day_hash = crypto.seal(sealJson, genesisOpts.masterKey || 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  return [genesis, dayContent];
}

// ── Genesis gate check simulator ──────────────────────────────────

/**
 * Simulate the Settings handleSaveRemote genesis gate logic.
 *
 * Returns the resulting genesis status info:
 *   { status: 'idle'|'checking'|'compatible'|'incompatible'|'offline'|'error',
 *     reason?: string, stats?: object }
 *
 * @param {object} params
 * @param {string} params.workerUrl - New Worker URL
 * @param {string} params.apiKey - New API key
 * @param {string} params.prevUrl - Previous Worker URL
 * @param {string} params.prevApiKey - Previous API key
 * @param {MockStorage} params.storage - Local storage with ledger data
 * @param {MockCrypto} params.crypto - Crypto service (may have master key)
 * @param {MockTransport} params.transport - Remote transport
 */
async function simulateGenesisCheck({
  workerUrl, apiKey, prevUrl, prevApiKey,
  storage, crypto, transport,
}) {
  // Clear URL → reset
  if (!workerUrl || !workerUrl.trim()) {
    return { status: 'idle' };
  }

  const urlChanged = workerUrl !== prevUrl;
  const apiKeyChanged = apiKey !== prevApiKey;

  if (!urlChanged && !apiKeyChanged) {
    // No change → don't re-check
    return { status: 'unchanged' };
  }

  const blocks = (await storage.get('ledger:blocks')) || [];
  const masterKey = crypto.getMasterKey();

  if (blocks.length === 0 || !masterKey) {
    return { status: 'idle' };
  }

  if (!workerUrl.startsWith('http')) {
    return { status: 'error', reason: 'Invalid Worker URL' };
  }

  // GenesisGate imported at module level
  if (!transport) {
    return { status: 'error', reason: 'Invalid Worker URL' };
  }

  try {
    const result = await GenesisGate.check(
      blocks, transport, crypto, masterKey
    );

    if (result.compatible) {
      return { status: 'compatible', stats: result.stats };
    } else {
      return { status: 'incompatible', reason: result.reason };
    }
  } catch (err) {
    return { status: 'offline', reason: err.message || 'Network error' };
  }
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ Settings Genesis Gate Test Suite ══\n');

  const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const LEDGER_BLOCKS_KEY = 'ledger:blocks';

  // ── S1: Save triggers check → compatible ────────────────────────
  console.log('── S1: Save triggers check → compatible ──\n');
  {
    const chain = buildChain({ masterKey: MASTER_KEY });
    const storage = new MockStorage();
    await storage.set(LEDGER_BLOCKS_KEY, chain);

    const crypto = new MockCrypto();
    crypto.setMasterKey(MASTER_KEY);

    const transport = new MockTransport();
    transport.setData(LEDGER_BLOCKS_KEY, new TextEncoder().encode(JSON.stringify(chain)));

    // Wrap the dynamic import in a try/catch to surface errors
    let result;
    try {
      result = await simulateGenesisCheck({
        workerUrl: 'https://my-worker.workers.dev',
        apiKey: 'test-key',
        prevUrl: '',
        prevApiKey: '',
        storage,
        crypto,
        transport,
      });
    } catch (err) {
      console.error('S1 dynamic import error:', err.message);
      result = { status: 'error', reason: err.message };
    }

    t.assertEq(result.status, 'compatible',
      'S1. first save with matching chain → compatible');
    t.assert(result.stats !== undefined, 'S1b. compatible result includes stats');
  }

  // ── S2: Different genesis (same MK, different identity) → genesis_mismatch ──
  console.log('\n── S2: Different genesis → incompatible ──\n');
  {
    // Same master key but different identity → different genesis hash
    const localChain = buildChain({ masterKey: MASTER_KEY, username: 'local' });
    const remoteChain = buildChain({ masterKey: MASTER_KEY, username: 'remote', email: 'other@evil.com' });

    const storage = new MockStorage();
    await storage.set(LEDGER_BLOCKS_KEY, localChain);

    const crypto = new MockCrypto();
    crypto.setMasterKey(MASTER_KEY);

    const transport = new MockTransport();
    transport.setData(LEDGER_BLOCKS_KEY, new TextEncoder().encode(JSON.stringify(remoteChain)));

    const result = await simulateGenesisCheck({
      workerUrl: 'https://other-worker.workers.dev',
      apiKey: 'key2',
      prevUrl: '',
      prevApiKey: '',
      storage,
      crypto,
      transport,
    });

    t.assertEq(result.status, 'incompatible',
      'S2. different genesis → incompatible');
    t.assertEq(result.reason, 'genesis_mismatch',
      'S2b. reason is genesis_mismatch');
  }

  // ── S3: Network error → incompatible (GenGate catches internally) ──
  console.log('\n── S3: Network error → incompatible ──\n');
  {
    const chain = buildChain({ masterKey: MASTER_KEY });
    const storage = new MockStorage();
    await storage.set(LEDGER_BLOCKS_KEY, chain);

    const crypto = new MockCrypto();
    crypto.setMasterKey(MASTER_KEY);

    const transport = new MockTransport();
    transport.setOffline(true);

    const result = await simulateGenesisCheck({
      workerUrl: 'https://down-worker.workers.dev',
      apiKey: 'key3',
      prevUrl: '',
      prevApiKey: '',
      storage,
      crypto,
      transport,
    });

    t.assertEq(result.status, 'incompatible',
      'S3. network error → incompatible (caught internally by GenesisGate)');
    t.assertEq(result.reason, 'network_error',
      'S3b. reason is network_error');
  }

  // ── S4: Clear URL → reset to idle ──────────────────────────────
  console.log('\n── S4: Clear URL → reset to idle ──\n');
  {
    const storage = new MockStorage();
    const crypto = new MockCrypto();
    const transport = new MockTransport();

    const result = await simulateGenesisCheck({
      workerUrl: '',
      apiKey: '',
      prevUrl: '',
      prevApiKey: '',
      storage,
      crypto,
      transport,
    });

    t.assertEq(result.status, 'idle',
      'S4. clear URL → resets to idle');
  }

  // ── S5: API key change re-triggers check ────────────────────────
  console.log('\n── S5: API key change re-triggers check ──\n');
  {
    const chain = buildChain({ masterKey: MASTER_KEY });
    const storage = new MockStorage();
    await storage.set(LEDGER_BLOCKS_KEY, chain);

    const crypto = new MockCrypto();
    crypto.setMasterKey(MASTER_KEY);

    const transport = new MockTransport();
    transport.setData(LEDGER_BLOCKS_KEY, new TextEncoder().encode(JSON.stringify(chain)));

    const result = await simulateGenesisCheck({
      workerUrl: 'https://same-worker.workers.dev',
      apiKey: 'new-key',
      prevUrl: 'https://same-worker.workers.dev',
      prevApiKey: 'old-key', // API key changed!
      storage,
      crypto,
      transport,
    });

    t.assertEq(result.status, 'compatible',
      'S5. API key change → re-triggers genesis check (compatible)');
  }

  // ── S6: URL unchanged → skip check ─────────────────────────────
  console.log('\n── S6: URL unchanged → skip check ──\n');
  {
    const storage = new MockStorage();
    const crypto = new MockCrypto();
    const transport = new MockTransport();

    const result = await simulateGenesisCheck({
      workerUrl: 'https://unchanged.workers.dev',
      apiKey: 'same-key',
      prevUrl: 'https://unchanged.workers.dev',
      prevApiKey: 'same-key',
      storage,
      crypto,
      transport,
    });

    t.assertEq(result.status, 'unchanged',
      'S6. URL and API key unchanged → no re-check');
  }

  // ── S7: No local ledger → skip check (idle) ────────────────────
  console.log('\n── S7: No local ledger → skip check (idle) ──\n');
  {
    const storage = new MockStorage();
    // No ledger:blocks set

    const crypto = new MockCrypto();
    crypto.setMasterKey(MASTER_KEY);

    const transport = new MockTransport();

    const result = await simulateGenesisCheck({
      workerUrl: 'https://new-worker.workers.dev',
      apiKey: 'key7',
      prevUrl: '',
      prevApiKey: '',
      storage,
      crypto,
      transport,
    });

    t.assertEq(result.status, 'idle',
      'S7. no local ledger → skips check (idle)');
  }

  // ── S8: No master key → skip check (idle) ──────────────────────
  console.log('\n── S8: No master key → skip check (idle) ──\n');
  {
    const chain = buildChain({ masterKey: MASTER_KEY });
    const storage = new MockStorage();
    await storage.set(LEDGER_BLOCKS_KEY, chain);

    const crypto = new MockCrypto();
    // No setMasterKey — not authenticated

    const transport = new MockTransport();

    const result = await simulateGenesisCheck({
      workerUrl: 'https://worker-no-auth.workers.dev',
      apiKey: 'key8',
      prevUrl: '',
      prevApiKey: '',
      storage,
      crypto,
      transport,
    });

    t.assertEq(result.status, 'idle',
      'S8. no master key → skips check (idle)');
  }

  // ── S9: Invalid URL → error ────────────────────────────────────
  console.log('\n── S9: Invalid URL → error ──\n');
  {
    const chain = buildChain({ masterKey: MASTER_KEY });
    const storage = new MockStorage();
    await storage.set(LEDGER_BLOCKS_KEY, chain);

    const crypto = new MockCrypto();
    crypto.setMasterKey(MASTER_KEY);

    const transport = new MockTransport();

    const result = await simulateGenesisCheck({
      workerUrl: 'not-a-valid-url',
      apiKey: 'key9',
      prevUrl: '',
      prevApiKey: '',
      storage,
      crypto,
      transport,
    });

    t.assertEq(result.status, 'error',
      'S9. invalid URL → error status');
    t.assert(result.reason !== undefined,
      'S9b. error result includes reason');
  }

  // ── Results ───────────────────────────────────────────────────────
  const failures = t.summary('Settings Genesis Gate');
  process.exitCode = failures > 0 ? 1 : 0;
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
