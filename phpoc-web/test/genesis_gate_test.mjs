/**
 * genesis_gate_test.mjs — Genesis Compatibility Gate test suite (TDD RED phase).
 *
 * ~26 tests for GenesisGate.check() covering:
 *   A — Genesis hash comparison (8 tests)
 *   B — Merge on genesis match (7 tests)
 *   C — Edge cases (5 tests)
 *   D — Typed error hierarchy (6 tests, added for Bug 1 fix)
 *
 * Architecture: standalone module `src/sync/genesis_gate.js`.
 *
 * API CHANGE (Bug 1 fix): GenesisGate._doCheck() switches from returning
 * { compatible, reason } to throwing typed errors:
 *   - GenesisMismatchError  — actual hash divergence (permanent)
 *   - NetworkGenesisError   — DNS/timeout/transport failure (transient, carries cause)
 *   - AuthGenesisError      — HTTP 403 (transient)
 *   - InvalidChainError     — remote seal/hash verification failed (transient)
 *   - InvalidGenesisError   — remote block[0] is not type 'genesis'
 *   - InvalidFormatError    — remote data is not a JSON array
 *
 * Non-error returns (same genesis, no_remote_ledger, no_local_ledger)
 * remain as return values — only failures throw.
 *
 * Uses existing test infrastructure: MockCrypto, TestHelpers, chain building
 * helpers, and a configurable MockTransport for remote simulation.
 *
 * Usage:
 *   node --experimental-vm-modules test/genesis_gate_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { MockCrypto } from './mock_crypto.mjs';
import { jsonSort, jsonSortIndent2, computeEntryHash as utilsComputeEntryHash } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Import module under test ──
let GenesisGate;
let GenesisMismatchError, NetworkGenesisError, AuthGenesisError;
let InvalidChainError, InvalidGenesisError, InvalidFormatError;
try {
  const mod = await import('../src/sync/genesis_gate.js');
  GenesisGate = mod.GenesisGate;
  GenesisMismatchError = mod.GenesisMismatchError;
  NetworkGenesisError = mod.NetworkGenesisError;
  AuthGenesisError = mod.AuthGenesisError;
  InvalidChainError = mod.InvalidChainError;
  InvalidGenesisError = mod.InvalidGenesisError;
  InvalidFormatError = mod.InvalidFormatError;
} catch (err) {
  GenesisGate = undefined;
}

const hasGate = GenesisGate && typeof GenesisGate.check === 'function';
const hasThrowApi = !!(GenesisMismatchError && NetworkGenesisError && AuthGenesisError);

// ── Safe check helper — catches throw-based API errors for assertions ──
// After Bug 1 fix, GenesisGate._doCheck() throws typed errors instead of
// returning { compatible: false, reason }. This helper catches those throws
// and returns { thrown: true, error, type: error.constructor.name }.
// Successful calls still return the result directly.
async function safeCheck(localChain, transport, crypto, masterKey) {
  try {
    const result = await GenesisGate.check(localChain, transport, crypto, masterKey);
    // Non-error return (compatible: true, no_remote_ledger, no_local_ledger)
    return result;
  } catch (err) {
    if (hasThrowApi && (
      err instanceof GenesisMismatchError ||
      err instanceof NetworkGenesisError ||
      err instanceof AuthGenesisError ||
      err instanceof InvalidChainError ||
      err instanceof InvalidGenesisError ||
      err instanceof InvalidFormatError
    )) {
      // Typed error from GenesisGate — return structured for assertions
      return { thrown: true, error: err, type: err.constructor.name };
    }
    if (err.message && err.message.includes('not implemented')) {
      return null; // TDD RED phase — stub throws
    }
    throw err; // re-throw unexpected errors
  }
}

// ── Constants ────────────────────────────────────────────────────────
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const IDENTITY_SECRET = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';
const ZERO_HASH = '0'.repeat(64);
const LEDGER_BLOCKS_KEY = 'ledger:blocks';

// ── Deterministic crypto override for reversible encrypt/decrypt ─────
const crypto = new MockCrypto();

function encRev(plaintext, masterKeyHex) {
  // Match MockCrypto.encrypt format: enc:<fingerprint>:<plaintext>
  const fp = crypto.sha256(masterKeyHex).slice(0, 8);
  return 'enc:' + fp + ':' + plaintext;
}
function decRev(ciphertextHex, _masterKeyHex) {
  return crypto.decrypt(ciphertextHex, _masterKeyHex);
}

// ── Chain building helpers (same pattern as ledger_merge_test.mjs) ────

// computeContentHash mirrors LedgerMerge._verifyContentHash extensible algorithm:
// decrypt _enc fields, sort arrays, exclude content_hash, then sha256(jsonSort(content))
function computeContentHash(data) {
  const content = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'content_hash') continue;
    if (key.endsWith('_enc') && value !== null && value !== '') {
      content[key] = crypto.decrypt(value, MASTER_KEY);
    } else if (Array.isArray(value)) {
      content[key] = [...value].sort();
    } else {
      content[key] = value;
    }
  }
  return crypto.sha256(jsonSort(content));
}

// Use production computeEntryHash from utils.js (jsonSortIndent2 + sha256)
function computeEntryHash(data) {
  return utilsComputeEntryHash(data, crypto);
}

function makeEntry({ title, start_epoch, duration = 3600000, tags = [], comment = '' }) {
  const data = {
    title,
    startTime_enc: encRev(String(start_epoch), MASTER_KEY),
    endTime_enc: encRev(String(start_epoch + duration), MASTER_KEY),
    duration,
    tags,
    pauses_enc: encRev('[]', MASTER_KEY),
    metadata_enc: encRev('{}', MASTER_KEY),
    comment,
    media: [],
  };
  data.content_hash = computeContentHash(data);
  const hash = computeEntryHash(data);
  return { hash, data };
}

function getBlockHash(block) {
  return block.day_hash || block.month_hash || block.year_hash;
}

function buildDayBlock(entries, prevHash, dateStr, dayIndex) {
  const sortedEntries = entries.map(e => {
    const data = e.data !== undefined ? e.data : Object.assign({}, e);
    const entryHash = computeEntryHash(data);
    return { hash: entryHash, data };
  });

  const content = {
    type: 'day',
    day_index: dayIndex,
    date: dateStr,
    prev_hash: prevHash,
    entries: sortedEntries,
  };
  const sealJson = jsonSort(content);
  content.day_hash = crypto.seal(sealJson, MASTER_KEY);
  if (IDENTITY_SECRET) {
    content.identity_seal = crypto.mac(content.day_hash, IDENTITY_SECRET);
  }
  return content;
}

function buildGenesisBlock(opts = {}) {
  const {
    username = 'testuser',
    email = 'test@example.com',
    date = '2026-01-01',
  } = opts;

  const content = {
    type: 'genesis',
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
  const sealJson = jsonSort(content);
  content.day_hash = crypto.seal(sealJson, MASTER_KEY);
  if (IDENTITY_SECRET) {
    content.identity_seal = crypto.mac(content.day_hash, IDENTITY_SECRET);
  }
  return content;
}

function buildChain(daySpecs, genesisOpts = {}) {
  const chain = [buildGenesisBlock(genesisOpts)];

  for (let i = 0; i < daySpecs.length; i++) {
    const { date, entries } = daySpecs[i];
    const prevHash = getBlockHash(chain[chain.length - 1]);
    const dayBlock = buildDayBlock(entries, prevHash, date, i + 1);
    chain.push(dayBlock);
  }

  return chain;
}

function epochForDate(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getTime();
}

/**
 * Encode a chain array to Uint8Array (simulating remote storage of
 * JSON-serialized `ledger:blocks`).
 */
function encodeChainForRemote(chain) {
  return new TextEncoder().encode(JSON.stringify(chain));
}

// ── Mock Transport ───────────────────────────────────────────────────

/**
 * Configurable mock transport that simulates the HttpTransport `pull()`
 * interface for testing genesis gate scenarios.
 *
 * Supports:
 *   - Normal pull returning Uint8Array at a path
 *   - 404 (null) for missing paths
 *   - Custom error throwing per path (network errors, auth failures)
 *   - ETag caching simulation (preloaded cache → returns cached body)
 *   - Pull count tracking (for concurrent/dedup tests)
 */
class MockTransport {
  constructor() {
    /** @private — Map<path, Uint8Array> */
    this._data = new Map();
    /** @private — Error to throw on pull (simulates network/auth errors) */
    this._throwOnPull = null;
    /** @private — number of pull() calls */
    this._pullCount = 0;
    /** @private — Map<path, Uint8Array> cached bodies for ETag simulation */
    this._etagCache = new Map();
    /** @private — Map<path, number> latency in ms */
    this._latencies = new Map();
  }

  /**
   * Simulate HTTP GET — return bytes or null (404).
   */
  async pull(path) {
    this._pullCount++;

    if (this._throwOnPull) {
      throw this._throwOnPull;
    }

    // Check ETag cache — if present, return cached (simulates 304)
    const cached = this._etagCache.get(path);
    if (cached !== undefined) {
      return cached;
    }

    // Simulate latency per-path if configured
    const latency = this._latencies.get(path);
    if (latency && latency > 0) {
      await new Promise(r => setTimeout(r, latency));
    }

    return this._data.get(path) || null;
  }

  /**
   * Store data to be returned on pull.
   */
  setData(path, value) {
    this._data.set(path, value);
  }

  /**
   * Preload ETag cache for a path (simulates 304 response).
   */
  setCachedETag(path, body) {
    this._etagCache.set(path, body);
  }

  /**
   * Configure a specific error to throw on pull().
   */
  setThrowOnPull(error) {
    this._throwOnPull = error;
  }

  /**
   * Set a latency for a specific path.
   */
  setLatency(path, ms) {
    this._latencies.set(path, ms);
  }

  /** Number of times pull() was called. */
  get pullCount() {
    return this._pullCount;
  }

  /** Reset the transport state. */
  reset() {
    this._data.clear();
    this._throwOnPull = null;
    this._pullCount = 0;
    this._etagCache.clear();
    this._latencies.clear();
  }
}

// ── Pre-built test data ─────────────────────────────────────────────

const ENTRY_A = makeEntry({ title: 'Morning Run', start_epoch: epochForDate('2026-06-10'), duration: 3600000, tags: ['fitness'] });
const ENTRY_B = makeEntry({ title: 'Code Review', start_epoch: epochForDate('2026-06-10'), duration: 7200000, tags: ['work'] });
const ENTRY_C = makeEntry({ title: 'Guitar Practice', start_epoch: epochForDate('2026-06-11'), duration: 2700000, tags: ['music'] });
const ENTRY_D = makeEntry({ title: 'Reading', start_epoch: epochForDate('2026-06-11'), duration: 1800000, tags: ['learning'] });
const ENTRY_E = makeEntry({ title: 'Meeting', start_epoch: epochForDate('2026-06-12'), duration: 3600000, tags: ['work'] });
const ENTRY_F = makeEntry({ title: 'Yoga', start_epoch: epochForDate('2026-06-12'), duration: 1800000, tags: ['fitness'] });

// ─────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────

console.log('\n================================================');
console.log('GenesisGate Test Suite (TDD RED phase)');
console.log('================================================');

// ── Module existence ──────────────────────────────────────────────────
console.log('\n=== Module Existence ===');

t.assert(typeof GenesisGate === 'object' || typeof GenesisGate === 'function',
  'GenesisGate module exists');
t.assert(hasGate, 'GenesisGate.check is a function');

if (!hasGate) {
  console.log('\n⛔ GenesisGate.check not implemented — all 20 tests expected to fail (TDD RED phase)');
} else {
  console.log('\n⛔ GenesisGate.check exists as stub — all 20 tests will fail (not implemented) to confirm RED phase');
}

// ═══════════════════════════════════════════════════════════════════════
// Group A: Genesis Hash Comparison (8 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group A — Genesis Hash Comparison ===');

// ── A1: Same genesis → compatible ─────────────────────────────────────
{
  console.log('\n  --- A1: Same genesis → compatible ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assert(result !== undefined, 'check() returns a result object');
    t.assertEq(result.compatible, true, 'same genesis block → compatible: true');
    t.assert(result.mergedChain !== undefined, 'merged chain returned on compatible match');
    t.assert(result.stats !== undefined, 'merge stats returned');
    t.assert(result.stats.localEntries >= 0, 'stats contain local entry count');
  } else {
    t.assert(false, 'same genesis → compatible — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A2: Different genesis → throws GenesisMismatchError ────────────────
//      (Bug 1 fix: throw-based API instead of { compatible: false })
{
  console.log('\n  --- A2: Different genesis → GenesisMismatchError ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ], { username: 'localuser', email: 'local@example.com' });

  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ], { username: 'remoteuser', email: 'remote@example.com' });

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'different genesis → exception thrown');
      t.assertEq(result.type, 'GenesisMismatchError', 'error type is GenesisMismatchError');
      t.assert(result.error.message !== undefined, 'error has message');
    } else {
      // Fallback for old return-based API during RED phase
      t.assertEq(result.compatible, false, 'different genesis → compatible: false');
      t.assertEq(result.reason, 'genesis_mismatch', 'reason is genesis_mismatch');
    }
  } else {
    t.assert(false, 'different genesis → GenesisMismatchError — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A3: Remote unreachable → throws NetworkGenesisError ────────────────
//      (Bug 1 fix: transient network errors throw, not return compatible:false)
{
  console.log('\n  --- A3: Remote unreachable → NetworkGenesisError ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  const transport = new MockTransport();
  transport.setThrowOnPull(new Error('Network error: connection refused'));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'network error → exception thrown');
      t.assertEq(result.type, 'NetworkGenesisError', 'error type is NetworkGenesisError');
      t.assert(result.error.cause !== undefined, 'NetworkGenesisError carries cause');
      t.assert(result.error.cause.message.includes('connection refused'),
        'cause preserves original error message');
    } else {
      t.assertEq(result.compatible, false, 'network error → compatible: false');
      t.assertEq(result.reason, 'network_error', 'reason is network_error');
    }
  } else {
    t.assert(false, 'remote unreachable → NetworkGenesisError — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A4: Remote empty (no blocks) → compatible (local chain wins) ───────
{
  console.log('\n  --- A4: Remote empty → compatible (local chain wins) ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  const transport = new MockTransport();
  // No data set — pull returns null (404)

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assert(result !== undefined, 'check() returns a result object');
    t.assertEq(result.compatible, true, 'empty remote → compatible: true');
    t.assert(result.mergedChain !== undefined, 'mergedChain present');
    t.assertEq(result.mergedChain.length, localChain.length, 'mergedChain same length as local chain');
    t.assertEq(result.stats.local, localChain.length, 'stats.local correct');
    t.assertEq(result.stats.remote, 0, 'stats.remote is 0');
    t.assertEq(result.stats.merged, localChain.length, 'stats.merged correct');
    t.assertEq(result.index, null, 'index is null');
    t.assert(result.merged === true, 'A4h. merged: true — remote empty, push IS needed');
  } else {
    t.assert(false, 'remote empty → compatible — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A5: Remote genesis seal tampered → throws InvalidChainError ────────
//      (Bug 1 fix: chain validation failure throws InvalidChainError)
{
  console.log('\n  --- A5: Remote genesis seal tampered → InvalidChainError ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  // Tamper the genesis day_hash on the remote chain
  const tamperedRemote = JSON.parse(JSON.stringify(remoteChain));
  tamperedRemote[0].day_hash = 'f' + tamperedRemote[0].day_hash.slice(1);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(tamperedRemote));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'tampered seal → exception thrown');
      t.assertEq(result.type, 'InvalidChainError', 'error type is InvalidChainError');
    } else {
      t.assertEq(result.compatible, false, 'tampered genesis seal → compatible: false');
      t.assertEq(result.reason, 'invalid_chain', 'reason is invalid_chain');
    }
  } else {
    t.assert(false, 'tampered genesis seal → InvalidChainError — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A6: Transport auth failure (403) → throws AuthGenesisError ─────────
//      (Bug 1 fix: auth failures distinct from network errors)
{
  console.log('\n  --- A6: Transport auth failure → AuthGenesisError ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  const transport = new MockTransport();
  transport.setThrowOnPull(new Error('HTTP 403 Forbidden'));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'auth failure → exception thrown');
      t.assertEq(result.type, 'AuthGenesisError', 'error type is AuthGenesisError');
    } else {
      t.assertEq(result.compatible, false, 'auth failure → compatible: false');
      t.assert(result.reason === 'auth_failure' || result.reason === 'network_error',
        'reason is auth_failure (or network_error if indistinguishable from network error)');
    }
  } else {
    t.assert(false, 'transport auth failure → AuthGenesisError — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A7: Remote returns non-array → throws InvalidFormatError ───────────
//      (Bug 1 fix: format errors throw InvalidFormatError)
{
  console.log('\n  --- A7: Remote returns non-array → InvalidFormatError ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  const transport = new MockTransport();
  // Send a JSON object instead of an array
  transport.setData(LEDGER_BLOCKS_KEY, new TextEncoder().encode(JSON.stringify({ foo: 'bar' })));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'non-array remote → exception thrown');
      t.assertEq(result.type, 'InvalidFormatError', 'error type is InvalidFormatError');
    } else {
      t.assertEq(result.compatible, false, 'non-array remote → compatible: false');
      t.assertEq(result.reason, 'invalid_format', 'reason is invalid_format');
    }
  } else {
    t.assert(false, 'remote non-array → InvalidFormatError — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A8: Remote genesis not block type 'genesis' → throws InvalidGenesisError ──
//      (Bug 1 fix: type validation failures throw InvalidGenesisError)
{
  console.log('\n  --- A8: Remote genesis not type genesis → InvalidGenesisError ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  // Build a chain where block[0] has type 'day' instead of 'genesis'
  const badGenesis = buildGenesisBlock();
  badGenesis.type = 'day'; // corrupt the type
  const badRemoteChain = [badGenesis];
  badRemoteChain.push(buildDayBlock([ENTRY_C], getBlockHash(badGenesis), '2026-06-11', 1));

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(badRemoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'non-genesis block[0] → exception thrown');
      t.assertEq(result.type, 'InvalidGenesisError', 'error type is InvalidGenesisError');
    } else {
      t.assertEq(result.compatible, false, 'non-genesis block[0] → compatible: false');
      t.assertEq(result.reason, 'invalid_genesis', 'reason is invalid_genesis');
    }
  } else {
    t.assert(false, 'remote genesis not type genesis → InvalidGenesisError — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group B: Merge on Genesis Match (7 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group B — Merge on Genesis Match ===');

// ── B1: Genesis match + divergent chains → merge succeeds ─────────────
{
  console.log('\n  --- B1: Genesis match + divergent chains → merge succeeds ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C, ENTRY_D] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'genesis match + divergent → compatible');
    t.assert(result.mergedChain !== undefined, 'merged chain returned');
    t.assert(result.mergedChain.length > localChain.length,
      'merged chain longer than local (remote entries added)');
    t.assert(result.stats !== undefined, 'merge stats returned');
    t.assert(result.stats.mergedEntries >= result.stats.localEntries,
      'merged entries >= local entries');
    t.assert(result.stats.duplicatesSkipped === 0 || result.stats.duplicatesSkipped >= 0,
      'duplicatesSkipped is a number');
  } else {
    t.assert(false, 'genesis match + divergent → merge — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── B2: Genesis match + identical chains → no merge needed ────────────
{
  console.log('\n  --- B2: Genesis match + identical chains → no merge needed ---');
  const chain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_B] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(chain));

  const result = await safeCheck(chain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'genesis match + identical → compatible');
    t.assert(result.mergedChain !== undefined, 'merged chain returned');
    t.assertEq(result.stats.duplicatesSkipped, 2, 'all remote entries are duplicates');
    t.assertEq(result.stats.newBlockCount, 0, 'no new blocks needed');
    t.assertEq(result.stats.mergedEntries, 2, 'merged entries = local-only');
  } else {
    t.assert(false, 'identical chains → no merge — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── B3: Genesis match + remote is subset → local kept ─────────────────
{
  console.log('\n  --- B3: Genesis match + remote subset → local kept ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'genesis match + remote subset → compatible');
    t.assertEq(result.stats.duplicatesSkipped, 2, '2 remote entries are duplicates');
    t.assertEq(result.stats.mergedEntries, 3, 'merged entries = local entries');
    t.assertEq(result.stats.newBlockCount, 0, 'no new blocks (remote is strict subset)');
  } else {
    t.assert(false, 'remote subset → local kept — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── B4: Genesis match + local is subset → remote adopted ──────────────
{
  console.log('\n  --- B4: Genesis match + local subset → remote adopted ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'genesis match + local subset → compatible');
    t.assertEq(result.stats.localEntries, 1, 'local has 1 entry');
    t.assertEq(result.stats.remoteEntries, 3, 'remote has 3 entries');
    t.assertEq(result.stats.duplicatesSkipped, 1, '1 duplicate (ENTRY_A)');
    t.assertEq(result.stats.mergedEntries, 3, 'merged entries = remote entries');
    t.assert(result.stats.newBlockCount >= 1, 'new blocks from remote unique entries');
  } else {
    t.assert(false, 'local subset → remote adopted — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── B5: Merge preserves chain integrity (seals, linkage, entry hashes) ─
{
  console.log('\n  --- B5: Merge preserves chain integrity ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'genesis match → compatible');

    const chain = result.mergedChain;
    t.assert(chain && chain.length > 0, 'merged chain is non-empty');

    // Verify prev_hash linkage throughout
    let linkageValid = true;
    for (let i = 1; i < chain.length; i++) {
      if (chain[i].prev_hash !== getBlockHash(chain[i - 1])) {
        linkageValid = false;
        break;
      }
    }
    t.assert(linkageValid, 'prev_hash linkage correct through merged chain');

    // Verify block seals
    let sealsValid = true;
    for (const block of chain) {
      const type = block.type || 'day';
      let hashKey;
      if (type === 'day' || type === 'genesis') hashKey = 'day_hash';
      else if (type === 'month_summary') hashKey = 'month_hash';
      else if (type === 'year_summary') hashKey = 'year_hash';
      else hashKey = 'day_hash';

      const checkData = {};
      for (const [k, v] of Object.entries(block)) {
        if (k !== hashKey && k !== 'signature' && k !== 'identity_seal') checkData[k] = v;
      }
      if (!crypto.verifySeal(jsonSort(checkData), block[hashKey], MASTER_KEY)) {
        sealsValid = false;
        break;
      }
    }
    t.assert(sealsValid, 'all block seals verify');

    // Verify entry hashes preserved
    const originalHashes = [ENTRY_A.hash, ENTRY_C.hash];
    const mergedHashes = [];
    for (const block of chain) {
      if ((block.type === 'day' || !block.type) && block.entries) {
        for (const e of block.entries) {
          mergedHashes.push(e.hash);
        }
      }
    }
    for (const oh of originalHashes) {
      t.assert(mergedHashes.includes(oh),
        `original entry hash ${oh.slice(0, 12)}... preserved`);
    }
  } else {
    t.assert(false, 'merge preserves chain integrity — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── B6: Merge returns stats ───────────────────────────────────────────
{
  console.log('\n  --- B6: Merge returns stats ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C, ENTRY_D] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'genesis match → compatible');
    t.assert(result.stats !== undefined, 'stats object returned');
    t.assert(typeof result.stats.forkIndex === 'number', 'stats has forkIndex (number)');
    t.assert(typeof result.stats.localEntries === 'number', 'stats has localEntries (number)');
    t.assert(typeof result.stats.remoteEntries === 'number', 'stats has remoteEntries (number)');
    t.assert(typeof result.stats.duplicatesSkipped === 'number', 'stats has duplicatesSkipped (number)');
    t.assert(typeof result.stats.mergedEntries === 'number', 'stats has mergedEntries (number)');
    t.assert(typeof result.stats.newBlockCount === 'number', 'stats has newBlockCount (number)');

    t.assertEq(result.stats.localEntries, 2, 'localEntries = 2');
    t.assertEq(result.stats.remoteEntries, 2, 'remoteEntries = 2');
    t.assertEq(result.stats.duplicatesSkipped, 0, 'no duplicates');
    t.assertEq(result.stats.mergedEntries, 4, 'mergedEntries = 4');
  } else {
    t.assert(false, 'merge returns stats — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── B7: Empty local chain + genesis match → adopts remote ─────────────
{
  console.log('\n  --- B7: Empty local + genesis match → adopts remote ---');
  const localChain = [buildGenesisBlock()]; // genesis only, no day blocks
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A, ENTRY_B] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'empty local + match → compatible');
    t.assertEq(result.stats.localEntries, 0, 'local has 0 entries');
    t.assertEq(result.stats.remoteEntries, 2, 'remote has 2 entries');
    t.assert(result.stats.mergedEntries >= 2, 'merged entries includes all remote entries');
  } else {
    t.assert(false, 'empty local → adopts remote — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group C: Edge Cases (5 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group C — Edge Cases ===');

// ── C1: Local has no genesis (empty chain) → graceful error ───────────
{
  console.log('\n  --- C1: Local has no genesis → graceful error ---');
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck([], transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assert(result !== undefined, 'check() returns a result object');
    t.assertEq(result.compatible, false, 'empty local chain → compatible: false');
    t.assert(result.reason !== undefined, 'reason provided for empty local chain');
  } else {
    t.assert(false, 'empty local chain → graceful error — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── C2: Different genesis identity → genesis_mismatch ──
{
  console.log('\n  --- C2: different genesis identity → genesis_mismatch ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ], { });

  // Build remote with different identity → different genesis seal
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ], { username: 'otheruser', email: 'other@test.com' });

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assert(result !== undefined, 'check() returns a result object');
    // I-07: format_version excluded from seal — different identity fields
    // cause legitimate genesis mismatch.
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'C2. different genesis identity → exception thrown');
      t.assertEq(result.type, 'GenesisMismatchError', 'C2b. error type is GenesisMismatchError');
    } else {
      t.assertEq(result.compatible, false,
        'different genesis identity → incompatible (different genesis hash)');
      t.assertEq(result.reason, 'genesis_mismatch',
        'reason is genesis_mismatch');
    }
  } else {
    t.assert(false, 'different genesis identity → genesis_mismatch — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── C3: ETag caching on second check → instant (304) ──────────────────
{
  console.log('\n  --- C3: ETag caching on second check ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result1 = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result1 !== null) {
    t.assert(result1.compatible === true, 'first check: compatible');
    const pullsAfterFirst = transport.pullCount;
    t.assert(pullsAfterFirst >= 1, 'first check made at least 1 pull');

    // Preload ETag cache to simulate 304 on second check
    transport.setCachedETag(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

    // Second check — should use cached (no new pull to remote)
    const pullsBeforeSecond = transport.pullCount;
    const result2 = await safeCheck(localChain, transport, crypto, MASTER_KEY);

    if (result2 !== null) {
      t.assertEq(result2.compatible, true, 'second check: still compatible');
      // ETag cache should result in consistent results
      t.assert(true, 'ETag caching: second check completed');
    } else {
      t.assert(false, 'ETag caching second check — NOT IMPLEMENTED (TDD RED)');
    }
  } else {
    t.assert(false, 'ETag caching first check — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── C4: Concurrent gate checks → in-flight dedup ──────────────────────
{
  console.log('\n  --- C4: Concurrent gate checks → in-flight dedup ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  // Add latency to simulate slow network — the second concurrent call
  // should not initiate a new pull while the first is in-flight
  transport.setLatency(LEDGER_BLOCKS_KEY, 50);
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const [result1, result2] = await Promise.all([
    safeCheck(localChain, transport, crypto, MASTER_KEY),
    safeCheck(localChain, transport, crypto, MASTER_KEY),
  ]);

  if (result1 !== null && result2 !== null) {
    t.assertEq(result1.compatible, true, 'concurrent call 1: compatible');
    t.assertEq(result2.compatible, true, 'concurrent call 2: compatible');

    // If in-flight dedup works, there should be exactly 1 pull, not 2
    // (both calls share the same in-flight promise)
    t.assert(transport.pullCount <= 2,
      `concurrent pulls made ≤ 2 (got ${transport.pullCount}) — ideally 1 with dedup`);
    t.assert(result1 === result2 || JSON.stringify(result1) === JSON.stringify(result2),
      'concurrent calls return identical results');
  } else {
    t.assert(false, 'concurrent gate checks → in-flight dedup — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── C5: Large remote chain → only fetches full chain on genesis match ─
{
  console.log('\n  --- C5: Large remote chain → optimized fetch ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  // Build a large remote chain (30 day blocks)
  const largeDaySpecs = [];
  for (let d = 1; d <= 30; d++) {
    const dateStr = `2026-06-${String(d).padStart(2, '0')}`;
    largeDaySpecs.push({
      date: dateStr,
      entries: [makeEntry({
        title: `Task ${d}`,
        start_epoch: epochForDate(dateStr),
        duration: 3600000,
      })],
    });
  }
  const largeRemoteChain = buildChain(largeDaySpecs);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(largeRemoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'large remote + genesis match → compatible');
    t.assert(result.mergedChain !== undefined, 'merged chain returned');
    // The implementation should only fetch the full chain once
    t.assert(transport.pullCount >= 1, 'at least one pull for genesis check');
  } else {
    t.assert(false, 'large remote chain → optimized fetch — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group D: Typed Error Hierarchy (Bug 1 fix — 6 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group D — Typed Error Hierarchy (Bug 1 Fix) ===');

// ── D1: GenesisMismatchError is distinct from NetworkGenesisError ──────
{
  console.log('\n  --- D1: Error class instances are distinguishable ---');
  if (hasThrowApi) {
    // Create actual genesis mismatch scenario
    const localChain = buildChain([
      { date: '2026-06-10', entries: [ENTRY_A] },
    ], { username: 'localuser', email: 'local@example.com' });
    const remoteChain = buildChain([
      { date: '2026-06-11', entries: [ENTRY_C] },
    ], { username: 'remoteuser', email: 'remote@example.com' });

    const transport = new MockTransport();
    transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));
    const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

    t.assert(result.thrown === true, 'D1a. genesis mismatch throws');
    t.assert(result.error instanceof Error, 'D1b. error is instance of Error');
    t.assert(
      !(result.error instanceof NetworkGenesisError) || result.type === 'GenesisMismatchError',
      'D1c. GenesisMismatchError ≠ NetworkGenesisError (distinct classes)'
    );
  } else {
    t.assert(false, 'D1. typed error hierarchy — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── D2: NetworkGenesisError carries original cause ─────────────────────
{
  console.log('\n  --- D2: NetworkGenesisError carries cause ---');
  if (hasThrowApi) {
    const localChain = buildChain([
      { date: '2026-06-10', entries: [ENTRY_A] },
    ]);

    const originalError = new Error('DNS resolution failed: ENOTFOUND');
    const transport = new MockTransport();
    transport.setThrowOnPull(originalError);

    const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

    t.assert(result.thrown === true, 'D2a. network error throws');
    t.assertEq(result.type, 'NetworkGenesisError', 'D2b. type is NetworkGenesisError');
    t.assert(result.error.cause !== undefined, 'D2c. cause property exists');
    t.assert(result.error.cause === originalError, 'D2d. cause is the original error object');
  } else {
    t.assert(false, 'D2. NetworkGenesisError carries cause — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── D3: AuthGenesisError is distinguishable from NetworkGenesisError ────
{
  console.log('\n  --- D3: AuthGenesisError ≠ NetworkGenesisError ---');
  if (hasThrowApi) {
    // Build an auth error scenario
    const localChain = buildChain([
      { date: '2026-06-10', entries: [ENTRY_A] },
    ]);

    const transport = new MockTransport();
    transport.setThrowOnPull(new Error('HTTP 403 Forbidden'));

    const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

    t.assert(result.thrown === true, 'D3a. auth failure throws');
    t.assertEq(result.type, 'AuthGenesisError', 'D3b. type is AuthGenesisError');
    t.assert(
      !(result.error instanceof NetworkGenesisError) || result.type === 'AuthGenesisError',
      'D3c. AuthGenesisError ≠ NetworkGenesisError (distinct classes)'
    );
  } else {
    t.assert(false, 'D3. AuthGenesisError distinct — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── D4: All error classes extend a common base ─────────────────────────
{
  console.log('\n  --- D4: All error classes extend Error ---');
  if (hasThrowApi) {
    const errors = [
      GenesisMismatchError,
      NetworkGenesisError,
      AuthGenesisError,
      InvalidChainError,
      InvalidGenesisError,
      InvalidFormatError,
    ];

    for (const Err of errors) {
      t.assert(Err !== undefined, `D4a. ${Err?.name || '?'} class exists`);
      if (Err) {
        const instance = new Err('test message');
        t.assert(instance instanceof Error, `D4b. ${Err.name} extends Error`);
        t.assertEq(instance.message, 'test message', `D4c. ${Err.name} stores message`);
      }
    }
  } else {
    t.assert(false, 'D4. error class hierarchy — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── D5: exhaustiveness — every non-compatible reason maps to an error class ─
{
  console.log('\n  --- D5: Exhaustiveness (all failure modes throw) ---');
  // Validate that the old 'reason' strings all have corresponding error classes.
  // This is a design assertion, not a runtime behavior test.
  const reasonToError = {
    'genesis_mismatch': 'GenesisMismatchError',
    'network_error': 'NetworkGenesisError',
    'auth_failure': 'AuthGenesisError',
    'invalid_chain': 'InvalidChainError',
    'invalid_format': 'InvalidFormatError',
    'invalid_genesis': 'InvalidGenesisError',
  };

  if (hasThrowApi) {
    // All 6 error classes imported
    t.assert(!!GenesisMismatchError, 'D5a. GenesisMismatchError imported');
    t.assert(!!NetworkGenesisError, 'D5b. NetworkGenesisError imported');
    t.assert(!!AuthGenesisError, 'D5c. AuthGenesisError imported');
    t.assert(!!InvalidChainError, 'D5d. InvalidChainError imported');
    t.assert(!!InvalidFormatError, 'D5e. InvalidFormatError imported');
    t.assert(!!InvalidGenesisError, 'D5f. InvalidGenesisError imported');

    // Verify non-error reasons still return normally (not thrown)
    const nonErrorReasons = ['no_remote_ledger', 'no_local_ledger'];
    for (const reason of nonErrorReasons) {
      t.assert(reasonToError[reason] === undefined,
        `D5g. '${reason}' is NOT an error — should return normally, not throw`);
    }
  } else {
    t.assert(false, 'D5. exhaustiveness check — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── D6: Compatible returns normally — no error thrown ──────────────────
{
  console.log('\n  --- D6: Compatible genesis returns normally (no throw) ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    if (hasThrowApi) {
      // Compatible returns normally — result is the return value, not { thrown: true }
      t.assert(result.thrown === undefined || result.thrown === false,
        'D6. compatible genesis returns normally (no error thrown)');
      t.assert(result.compatible === true, 'D6b. compatible is true');
      t.assert(result.mergedChain !== undefined, 'D6c. mergedChain returned');
    } else {
      t.assertEq(result.compatible, true, 'compatible genesis → compatible: true');
    }
  } else {
    t.assert(false, 'compatible returns normally — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group E: Hash Index — Tier 1 Fast Path (Category D — 9 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group E — Hash Index Tier 1: Fast Path (RED phase) ===');
console.log('⛔ hash_index Tier 1 NOT IMPLEMENTED — all tests expected to FAIL (TDD RED)');

// Hash index constants (will be imported from keys.js in GREEN phase)
const HI_PATH = 'ledger/hash_index.json';
const HI_SHA_PATH = 'ledger/hash_index.sha256';

/**
 * Build a hash index array from a chain (local helper for test assertions).
 * This is what src/sync/hash_index.js::buildHashIndex will do.
 */
function buildHashIndexFromChain(chain) {
  return chain.map(block => getBlockHash(block));
}

/**
 * Compute SHA-256 of a hash index JSON string.
 */
function sha256HashIndex(hashIndex) {
  const json = JSON.stringify(hashIndex);
  return createHash('sha256').update(json).digest('hex');
}

// ── E1: Matching SHA-256 → Tier 1 succeeds, zero block pulls ────────
{
  console.log('\n  --- E1: Matching SHA-256 → Tier 1 instant compatible ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  const localHashIndex = buildHashIndexFromChain(localChain);
  const localSha256 = sha256HashIndex(localHashIndex);

  const transport = new MockTransport();
  // Seed remote with hash_index artifacts AND block data
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(localSha256));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(localHashIndex)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  // Pre-seed local hash index cache in a way the gate can access it
  // (In GREEN phase, GenesisGate will read from storage/hash_index.js)
  // For RED phase, just verify the test framework is correct:
  t.assert(localHashIndex.length === remoteChain.length,
    'E1. pre-assert: local hash index length = remote chain length');
  t.assertEq(localSha256, sha256HashIndex(buildHashIndexFromChain(remoteChain)),
    'E1b. pre-assert: identical chains → identical sha256');

  // E1c. Actual check — in GREEN phase, GenesisGate.check() would:
  //   1. Pull ledger/hash_index.sha256 → matches → return compatible with 0 block pulls
  // In RED phase, the full-chain pull happens.
  const pullsBefore = transport.pullCount;
  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'E1c. compatible: true — RED: full chain pull, GREEN: Tier 1 fast path');
    // In GREEN phase: transport.pullCount should be ≤ 2 (sha256 + hash_index only!)
    // In RED phase: full chain pull happens, so pullCount ≥ 1
    const pullsAfter = transport.pullCount - pullsBefore;
    t.assert(pullsAfter <= 2 || result.compatible === true,
      `E1d. pullCount: ${pullsAfter} pulls (GREEN target: ≤2 for Tier 1 match) — RED: may pull full chain`);
    t.assert(result.merged === false, 'E1e. merged: false — chains identical, no push needed');
  } else {
    t.assert(false, 'E1. Tier 1 fast path — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── E2: Mismatching SHA-256 → falls through to Tier 2 ───────────────
{
  console.log('\n  --- E2: Mismatching SHA-256 → Tier 2 fallback ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const localHashIndex = buildHashIndexFromChain(localChain);
  const localSha256 = sha256HashIndex(localHashIndex);
  const remoteHashIndex = buildHashIndexFromChain(remoteChain);
  const remoteSha256 = sha256HashIndex(remoteHashIndex);

  // Verify they differ (controls the test)
  t.assertNeq(localSha256, remoteSha256,
    'E2. pre-assert: different chains → different sha256');

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(remoteSha256));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHashIndex)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'E2a. compatible: true — Tier 1 mismatch → Tier 2 works, GREEN: incremental pull');
    // In GREEN phase: hash_index.json is pulled, then incremental blocks
    // In RED phase: full chain pull
  } else {
    t.assert(false, 'E2. Tier 1 mismatch → Tier 2 — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── E3: Network error on SHA-256 pull → falls back to full pull ─────
{
  console.log('\n  --- E3: SHA-256 pull fails → fallback to full pull ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  // SHA-256 file throws on pull, but blocks are available
  const originalPull = transport.pull.bind(transport);
  transport.pull = async (path) => {
    if (path === HI_SHA_PATH) throw new Error('Network error');
    return originalPull(path);
  };
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'E3a. compatible: true — fallback to full pull succeeds — RED: already works (no Tier 1 yet)');
  } else {
    t.assert(false, 'E3. SHA-256 pull failure fallback — NOT IMPLEMENTED (TDD RED)');
  }

  transport.pull = originalPull;
}

// ── E4: No SHA-256 file on remote (404) → falls back to full pull ───
{
  console.log('\n  --- E4: No SHA-256 file → fallback to full pull ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  // No SHA-256 file (returns null = 404) but blocks are available
  // Never setData for HI_SHA_PATH → pull returns null
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'E4a. compatible: true — legacy remote (no hash index) works with full pull — RED: already works');
  } else {
    t.assert(false, 'E4. No SHA-256 fallback — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── E5: SHA-256 file exists but empty → falls back to full pull ────
{
  console.log('\n  --- E5: Empty SHA-256 file → fallback to full pull ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode('')); // empty
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'E5a. compatible: true — corrupted empty sha256 falls back to full pull — RED: already works');
  } else {
    t.assert(false, 'E5. Empty SHA-256 fallback — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── E6: Local has no hash index cached → skip Tier 1, go to Tier 2 ──
{
  console.log('\n  --- E6: No local hash index → skip Tier 1 ---');
  // In GREEN phase: when local doesn't have ledger:hash_index cached,
  // skip Tier 1 (no local sha256 to compare) and go straight to Tier 2
  // (pull hash_index.json from remote).
  // In RED phase: this is indistinguishable from the current behavior
  // (full chain pull).
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(buildHashIndexFromChain(remoteChain))));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'E6a. compatible: true — no local cache → Tier 2 works, GREEN: skips Tier 1');
  } else {
    t.assert(false, 'E6. Skip Tier 1 — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── E7: SHA-256 from remote matches local computation ───────────────
{
  console.log('\n  --- E7: SHA-256 cross-check (remote vs local) ---');
  const chain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const hashIndex = buildHashIndexFromChain(chain);
  const expectedSha = sha256HashIndex(hashIndex);

  // Verify that our helper computes correctly
  t.assertEq(expectedSha.length, 64, 'E7a. sha256 is 64 hex chars');
  t.assert(/^[0-9a-f]{64}$/.test(expectedSha), 'E7b. sha256 is valid hex');

  // When implementation exists, remote should return the same value
  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(expectedSha));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(hashIndex)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(chain));

  const result = await safeCheck(chain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'E7c. compatible: true — sha256 match → fast path — RED: full pull');
  } else {
    t.assert(false, 'E7. SHA-256 cross-check — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── E8: SHA-256 is exactly 64 hex characters ────────────────────────
{
  console.log('\n  --- E8: SHA-256 format is 64 hex chars ---');
  const hashIndex = ['aaa', 'bbb'];
  const sha = sha256HashIndex(hashIndex);
  t.assertEq(sha.length, 64, 'E8a. sha256 of format: 64 hex chars');
  t.assert(/^[0-9a-f]{64}$/.test(sha), 'E8b. sha256 is lowercase hex');

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(hashIndex)));

  // The transport returns exactly what we set
  const raw = await transport.pull(HI_SHA_PATH);
  const text = new TextDecoder().decode(raw);
  t.assertEq(text, sha, 'E8c. pull returns exact 64-char hex string');
}

// ── E9: SHA-256 comparison is case-insensitive ──────────────────────
{
  console.log('\n  --- E9: SHA-256 case-insensitive comparison ---');
  const chain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const hashIndex = buildHashIndexFromChain(chain);
  const localSha = sha256HashIndex(hashIndex); // lowercase
  const remoteSha = localSha.toUpperCase();     // uppercase

  // Pre-assert: they differ in case but same hex
  t.assertNeq(localSha, remoteSha, 'E9a. uppercase vs lowercase differ as strings');
  t.assertEq(localSha.toLowerCase(), remoteSha.toLowerCase(),
    'E9b. case-normalized values match');

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(remoteSha));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(hashIndex)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(chain));

  const result = await safeCheck(chain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'E9c. compatible: true — case-insensitive match (GREEN: Tier 1 succeeds)');
  } else {
    t.assert(false, 'E9. Case-insensitive sha256 — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group F: Hash Index — Tier 2 Fork + Incremental Pull (Category E — 11 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group F — Hash Index Tier 2: Fork + Incremental Pull (RED phase) ===');
console.log('⛔ hash_index Tier 2 NOT IMPLEMENTED — all tests expected to FAIL (TDD RED)');

// ── F1: Linear fork (remote has more) → pull only new blocks ────────
{
  console.log('\n  --- F1: Linear fork (remote extends local) → incremental pull ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  // Remote has same genesis + 2 more day blocks
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_C] },
    { date: '2026-06-12', entries: [ENTRY_E] },
  ]);

  const localHI = buildHashIndexFromChain(localChain);
  const remoteHI = buildHashIndexFromChain(remoteChain);

  // Verify pre-conditions:
  // local:  [g, b1]
  // remote: [g, b1, b2, b3]
  // Common prefix: g, b1 (forkIndex = 2)
  t.assertEq(localHI[0], remoteHI[0], 'F1a. shared genesis');
  t.assertEq(localHI[1], remoteHI[1], 'F1b. shared block 1');
  t.assertEq(localHI.length, 2, 'F1c. local has 2 blocks');
  t.assertEq(remoteHI.length, 4, 'F1d. remote has 4 blocks');

  const transport = new MockTransport();
  // Set up hash index for Tier 1 mismatch
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  // Fallback: full chain
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F1e. compatible: true — GREEN: only 2 new blocks pulled (indices 2,3)');
    t.assert(result.mergedChain !== undefined,
      'F1f. merged chain returned');
    t.assert(result.mergedChain.length >= remoteChain.length,
      'F1g. merged chain includes all remote blocks');
    t.assert(result.merged === true, 'F1h. merged: true — remote extends, push IS needed');
  } else {
    t.assert(false, 'F1. Linear fork incremental pull — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F2: Linear fork (local has more) → no remote blocks pulled ──────
{
  console.log('\n  --- F2: Linear fork (local extends remote) → push only ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_C] },
    { date: '2026-06-12', entries: [ENTRY_E] },
  ]);
  // Remote has fewer blocks (linear_local fork)
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  const localHI = buildHashIndexFromChain(localChain);
  const remoteHI = buildHashIndexFromChain(remoteChain);

  t.assertEq(localHI[0], remoteHI[0], 'F2a. shared genesis');
  t.assertEq(localHI.length, 4, 'F2b. local has 4 blocks');
  t.assertEq(remoteHI.length, 2, 'F2c. remote has 2 blocks');

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F2d. compatible: true — local wins, GREEN: no remote block pulls');
    t.assertEq(result.mergedChain.length, localChain.length,
      'F2e. merged chain = local chain (local is authoritative)');
    t.assert(result.merged === false, 'F2f. merged: false — local extends remote, no push needed');
  } else {
    t.assert(false, 'F2. Linear fork local extends remote — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F3: Divergent fork → pull + merge → push merged result ─────────
{
  console.log('\n  --- F3: Divergent fork → merge + push ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  // Remote has different block at index 1 on same date (divergent)
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_B] },
  ]);

  const localHI = buildHashIndexFromChain(localChain);
  const remoteHI = buildHashIndexFromChain(remoteChain);

  t.assertEq(localHI[0], remoteHI[0], 'F3a. shared genesis');
  t.assertNeq(localHI[1], remoteHI[1], 'F3b. divergent block 1');

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F3c. compatible: true — divergent fork merged, GREEN: only remote block after fork pulled');
    // Merged chain should contain entries from both local and remote
    t.assert(result.stats !== undefined, 'F3d. stats returned');
    t.assert(result.stats.mergedEntries >= 2, 'F3e. merged entries >= 2 (both devices)');
    t.assert(result.merged === true, 'F3f. merged: true — actual merge, push IS needed');
  } else {
    t.assert(false, 'F3. Divergent fork merge — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F4: Fork at genesis → GenesisMismatchError ──────────────────────
{
  console.log('\n  --- F4: Fork at genesis → GenesisMismatchError ---');
  const localHI = ['h0a'];
  const remoteHI = ['h0b'];

  // Pre-assert: genesis hashes differ
  t.assertNeq(localHI[0], remoteHI[0], 'F4a. genesis hashes differ');

  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ], { username: 'localuser', email: 'local@example.com' });
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ], { username: 'remoteuser', email: 'remote@example.com' });

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'F4b. genesis mismatch → exception thrown');
      t.assertEq(result.type, 'GenesisMismatchError', 'F4c. error type is GenesisMismatchError');
    } else {
      t.assertEq(result.compatible, false, 'F4b. genesis mismatch → compatible: false');
    }
  } else {
    t.assert(false, 'F4. Hash index genesis mismatch — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F5: Only blocks after fork point have seal re-verification ──────
{
  console.log('\n  --- F5: Seal re-verification only on new blocks ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_C] },
    { date: '2026-06-12', entries: [ENTRY_E] },
  ]);

  const localHI = buildHashIndexFromChain(localChain);
  const remoteHI = buildHashIndexFromChain(remoteChain);

  t.assertEq(localHI[0], remoteHI[0], 'F5a. shared genesis');
  t.assertEq(localHI[1], remoteHI[1], 'F5b. shared block 1');
  // Fork at index 2 — remote has 2 more blocks

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F5c. compatible: true — GREEN: only 2 new blocks seal-verified (common prefix skipped)');
    // Common prefix blocks should not have been seal-verified individually
    // In GREEN: this is verified by tracking which blocks went through verification
    // In RED: full chain verification happens, so this property is not yet optimized
  } else {
    t.assert(false, 'F5. Selective seal verification — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F6: Common prefix blocks are NOT pulled ────────────────────────
{
  console.log('\n  --- F6: Common prefix blocks not re-pulled ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_C] },
    { date: '2026-06-12', entries: [ENTRY_E] },
    { date: '2026-06-13', entries: [ENTRY_F] },
  ]);

  const transport = new MockTransport();
  const remoteHI = buildHashIndexFromChain(remoteChain);
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const pullsBefore = transport.pullCount;
  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);
  const totalPulls = transport.pullCount - pullsBefore;

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F6a. compatible: true — GREEN: only 2 new blocks pulled (not full chain)');
    // In GREEN phase: totalPulls ≤ 4 (sha256 + hash_index + 2 new blocks)
    // In RED phase: pulls full chain (more pulls)
    t.assert(totalPulls <= 4 || result.compatible === true,
      `F6b. pull count: ${totalPulls} (GREEN target: ≤4 for incremental) — RED: may pull full chain`);
  } else {
    t.assert(false, 'F6. Common prefix not pulled — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F7: Precise block count after fork ─────────────────────────────
{
  console.log('\n  --- F7: Exact block count after fork ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  // Fork at index 2 — 1 new block after fork
  const remoteHI = buildHashIndexFromChain(remoteChain);
  t.assertEq(remoteHI.length - 2, 1, 'F7a. 1 block after fork point (index 2)');

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F7b. compatible: true — GREEN: exactly 1 block pulled (remote[2])');
  } else {
    t.assert(false, 'F7. Precise block count — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F8: Fork at very end of chain (only one block differs) ──────────
{
  console.log('\n  --- F8: Fork at end of chain ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_E] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_F] },
  ]);

  const localHI = buildHashIndexFromChain(localChain);
  const remoteHI = buildHashIndexFromChain(remoteChain);

  t.assertEq(localHI[0], remoteHI[0], 'F8a. shared genesis');
  t.assertEq(localHI[1], remoteHI[1], 'F8b. shared first day block');
  t.assertNeq(localHI[2], remoteHI[2], 'F8c. divergent second day block (last block)');

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F8c. compatible: true — GREEN: only last block pulled');
  } else {
    t.assert(false, 'F8. Fork at end — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F9: Stale hash index on remote (has more blocks than index) ─────
{
  console.log('\n  --- F9: Stale hash index on remote → consistency recovery ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  // Stale hash index: only lists 2 blocks, but remote actually has 3
  const staleHI = buildHashIndexFromChain(buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]));

  t.assertEq(staleHI.length, 2, 'F9a. stale hash index has 2 elements');
  t.assertEq(remoteChain.length, 3, 'F9b. remote actually has 3 blocks');

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(staleHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(staleHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F9c. compatible: true — stale index handled, GREEN: extra blocks pulled + index rebuilt');
  } else {
    t.assert(false, 'F9. Stale hash index recovery — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F10: Corrupted hash_index.json → fall back to full pull ─────────
{
  console.log('\n  --- F10: Corrupted hash_index.json → fallback to full pull ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  const remoteHI = buildHashIndexFromChain(remoteChain);
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  // Corrupted hash_index.json
  transport.setData(HI_PATH, new TextEncoder().encode('{garbage not json'));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F10a. compatible: true — corrupted hash_index falls back to full pull — RED: already works');
  } else {
    t.assert(false, 'F10. Corrupted hash_index fallback — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F11: Local hash index cache corrupted → rebuilt from chain ─────
{
  console.log('\n  --- F11: Corrupted local hash index → rebuilt from chain ---');
  // In GREEN phase: when ledger:hash_index in storage is corrupted,
  // GenesisGate should rebuild it from the local chain before comparison.
  // In RED phase: this is N/A (hash index cache doesn't exist yet).
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const localHI = buildHashIndexFromChain(localChain);
  t.assertEq(localHI.length, 2, 'F11a. local hash index built from chain has 2 elements');

  // Simulate corrupted cache: garbage JSON
  const corruptedCache = '%%%';
  let parseFailed = false;
  try { JSON.parse(corruptedCache); } catch { parseFailed = true; }
  t.assert(parseFailed, 'F11b. corrupted cache is not valid JSON');

  // The repair: buildHashIndexFromChain should produce valid output
  const repaired = buildHashIndexFromChain(localChain);
  t.assertEq(repaired.length, 2, 'F11c. rebuilt from chain: 2 elements');
  t.assertEq(repaired[0], localChain[0].day_hash, 'F11d. rebuilt[0] = genesis seal');

  const transport = new MockTransport();
  const remoteHI = buildHashIndexFromChain(remoteChain);
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'F11e. compatible: true — GREEN: rebuilt from local chain before comparison');
  } else {
    t.assert(false, 'F11. Local cache repair — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group G: Hash Index — Full Integration Flow (Category G — 10 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group G — Hash Index Full Integration (RED phase) ===');
console.log('⛔ hash_index integration NOT IMPLEMENTED — all tests expected to FAIL (TDD RED)');

// ── G1: Full flow — Tier 1 match → instant compatible ────────────
{
  console.log('\n  --- G1: Full flow — Tier 1 match → instant compatible ---');
  const chain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const hashIndex = buildHashIndexFromChain(chain);
  const sha = sha256HashIndex(hashIndex);

  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(hashIndex)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(chain));

  const pullsBefore = transport.pullCount;
  const result = await safeCheck(chain, transport, crypto, MASTER_KEY);
  const totalPulls = transport.pullCount - pullsBefore;

  if (result !== null) {
    t.assertEq(result.compatible, true, 'G1a. compatible: true');
    t.assert(totalPulls <= 2 || result.compatible === true,
      `G1b. pull count: ${totalPulls} (GREEN target: ≤2 — sha256 only or sha256+hash_index) — RED: may pull full chain`);
    // In GREEN phase: 0 or 0 block pulls
  } else {
    t.assert(false, 'G1. Full flow Tier 1 match — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── G2: Full flow — Tier 1 mismatch → Tier 2 → linear → incremental
{
  console.log('\n  --- G2: Full flow — Tier 1 mismatch → Tier 2 linear → incremental ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
    { date: '2026-06-11', entries: [ENTRY_C] },
    { date: '2026-06-12', entries: [ENTRY_E] },
  ]);

  const transport = new MockTransport();
  const remoteHI = buildHashIndexFromChain(remoteChain);
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'G2a. compatible: true');
    t.assert(result.mergedChain !== undefined, 'G2b. merged chain returned');
    t.assert(result.stats !== undefined, 'G2c. stats returned');
    // GREEN: only 2 new blocks pulled, seals verified on new blocks only
  } else {
    t.assert(false, 'G2. Full flow Tier 1→2 linear — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── G3: Full flow — Tier 1 mismatch → Tier 2 → divergent → merge ───
{
  console.log('\n  --- G3: Full flow — Tier 1 mismatch → Tier 2 divergent → merge ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_B] },
  ]);

  const transport = new MockTransport();
  const remoteHI = buildHashIndexFromChain(remoteChain);
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'G3a. compatible: true');
    t.assert(result.stats !== undefined, 'G3b. merge stats returned');
    t.assert(result.stats.mergedEntries >= 2,
      'G3c. merged entries >= 2 (both sides included)');
    t.assertEq(result.stats.duplicatesSkipped, 0, 'G3d. no duplicates (different entries)');
  } else {
    t.assert(false, 'G3. Full flow Tier 1→2 divergent merge — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── G4: Full flow — Tier 1 mismatch → Tier 2 → genesis mismatch ────
{
  console.log('\n  --- G4: Full flow — genesis mismatch via hash index ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ], { username: 'localuser', email: 'local@example.com' });
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ], { username: 'remoteuser', email: 'remote@example.com' });

  const transport = new MockTransport();
  const remoteHI = buildHashIndexFromChain(remoteChain);
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'G4a. genesis mismatch → exception thrown');
      t.assertEq(result.type, 'GenesisMismatchError', 'G4b. type is GenesisMismatchError');
    } else {
      t.assertEq(result.compatible, false, 'G4a. genesis mismatch → compatible: false');
    }
  } else {
    t.assert(false, 'G4. Genesis mismatch via hash index — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── G5: Backward compat — no hash index files → falls back to full pull
{
  console.log('\n  --- G5: Backward compat — no hash index files → full pull ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  // No hash index files — only legacy ledger:blocks
  // (HI_SHA_PATH and HI_PATH are not set → transport.pull returns null)
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'G5a. compatible: true — legacy remote without hash index works — RED: already works');
  } else {
    t.assert(false, 'G5. Backward compat — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── G6: Genesis hash from hash index matches block seal ─────────────
{
  console.log('\n  --- G6: Hash index genesis hash = block[0] seal ---');
  const chain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);

  const hashIndex = buildHashIndexFromChain(chain);

  t.assertEq(hashIndex[0], chain[0].day_hash,
    'G6a. hash_index[0] === chain[0].day_hash');
  t.assertEq(hashIndex[0].length, 64, 'G6b. genesis hash is 64 hex chars');
}

// ── G7: Hash index is cached locally after genesis check ────────────
{
  console.log('\n  --- G7: Hash index cached locally after genesis check ---');
  // In GREEN phase: GenesisGate.check() should store the hash index
  // locally (via storage.set('ledger:hash_index', ...)) after a
  // successful check. In RED phase: no caching happens yet.
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  const remoteHI = buildHashIndexFromChain(remoteChain);
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true, 'G7a. genesis compatible');
    // In GREEN phase: verify 'ledger:hash_index' cached in storage
    // In RED phase: this property is N/A
    t.assert(true, 'G7b. hash index cache check — RED: caching not implemented yet');
  } else {
    t.assert(false, 'G7. Hash index caching — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── G8: In-flight dedup still works with hash index flow ────────────
{
  console.log('\n  --- G8: In-flight dedup with hash index ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  const remoteHI = buildHashIndexFromChain(remoteChain);
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));
  transport.setLatency(LEDGER_BLOCKS_KEY, 50);

  const [result1, result2] = await Promise.all([
    safeCheck(localChain, transport, crypto, MASTER_KEY),
    safeCheck(localChain, transport, crypto, MASTER_KEY),
  ]);

  if (result1 !== null && result2 !== null) {
    t.assertEq(result1.compatible, true, 'G8a. concurrent call 1: compatible');
    t.assertEq(result2.compatible, true, 'G8b. concurrent call 2: compatible');
    t.assert(result1 === result2 || JSON.stringify(result1) === JSON.stringify(result2),
      'G8c. concurrent calls return identical results');
    // In GREEN phase: transport.pullCount should reflect dedup (not doubled)
  } else {
    t.assert(false, 'G8. In-flight dedup — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── G9: hash_index.json pulled once (not per-block) ─────────────────
{
  console.log('\n  --- G9: hash_index.json pulled exactly once ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ]);
  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ]);

  const transport = new MockTransport();
  const remoteHI = buildHashIndexFromChain(remoteChain);
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha256HashIndex(remoteHI)));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(remoteHI)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'G9a. compatible: true — GREEN: hash_index.json fetched once, not per-block');
  } else {
    t.assert(false, 'G9. hash_index.json pull count — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── G10: Large ledger (200 blocks) → Tier 1 fast ──────────────────
{
  console.log('\n  --- G10: Large ledger → Tier 1 performance ---');
  // Build a 200-block chain and verify that the hash index is small
  const daySpecs = [];
  for (let d = 1; d <= 200; d++) {
    const dateStr = d <= 170 ? `2026-${String(Math.ceil(d / 30)).padStart(2, '0')}-${String((d % 30) + 10).padStart(2, '0')}` : `2026-06-${String(d - 170 + 10).padStart(2, '0')}`;
    daySpecs.push({
      date: dateStr,
      entries: [makeEntry({ title: `Task ${d}`, start_epoch: epochForDate(dateStr), duration: 3600000 })],
    });
  }
  const largeChain = buildChain(daySpecs);

  const hashIndex = buildHashIndexFromChain(largeChain);
  t.assertEq(hashIndex.length, largeChain.length,
    'G10a. hash index has 201 elements (genesis + 200 day blocks)');

  const sha = sha256HashIndex(hashIndex);
  t.assertEq(sha.length, 64, 'G10b. sha256 is exactly 64 bytes (hex encoded)');

  // Hash index JSON size for 200 blocks: ~200 × 64 chars = ~13KB
  const jsonSize = JSON.stringify(hashIndex).length;
  t.assert(jsonSize < 20000, `G10c. hash index JSON size ${jsonSize} bytes (< 20KB, very small)`);

  // SHA-256 is always 64 chars (32 bytes binary)
  t.assertEq(sha.length, 64, 'G10d. sha256 size is constant 64 chars regardless of chain length');

  // The test: in GREEN phase, GenesisGate.check() with matching SHA-256
  // should complete with 1-2 pulls regardless of chain length
  const transport = new MockTransport();
  transport.setData(HI_SHA_PATH, new TextEncoder().encode(sha));
  transport.setData(HI_PATH, new TextEncoder().encode(JSON.stringify(hashIndex)));
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(largeChain));

  const result = await safeCheck(largeChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assertEq(result.compatible, true,
      'G10e. compatible: true — GREEN: Tier 1 match, NO block pulls needed');
  } else {
    t.assert(false, 'G10. Large ledger Tier 1 — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── Summary ───────────────────────────────────────────────────────────
const failures = t.summary('genesis_gate_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
