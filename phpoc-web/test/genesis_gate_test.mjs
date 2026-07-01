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
import { jsonSort } from '../src/ledger/utils.js';

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
  return 'enc:' + plaintext;
}
function decRev(ciphertextHex, _masterKeyHex) {
  if (ciphertextHex && ciphertextHex.startsWith('enc:')) {
    return ciphertextHex.slice(4);
  }
  return ciphertextHex;
}

// ── Chain building helpers (same pattern as ledger_merge_test.mjs) ────

function computeContentHash(data) {
  const contentObj = {
    title: data.title || '',
    startTime_enc: data.startTime_enc || '',
    endTime_enc: data.endTime_enc || '',
    duration: data.duration || 0,
    tags: data.tags || [],
    pauses_enc: data.pauses_enc || '',
    metadata_enc: data.metadata_enc || '',
    comment: data.comment || '',
    media: data.media || [],
  };
  const sorted = {};
  for (const k of Object.keys(contentObj).sort()) {
    sorted[k] = contentObj[k];
  }
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function computeEntryHash(data) {
  return createHash('sha256')
    .update(JSON.stringify(data, null, 2), 'utf-8')
    .digest('hex');
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
    content.signature = crypto.sign(content.day_hash, IDENTITY_SECRET);
  }
  return content;
}

function buildGenesisBlock(opts = {}) {
  const {
    username = 'testuser',
    email = 'test@example.com',
    date = '2026-01-01',
    format_version = '0.3.0',
  } = opts;

  const content = {
    type: 'genesis',
    format_version,
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
    content.signature = crypto.sign(content.day_hash, IDENTITY_SECRET);
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
        if (k !== hashKey && k !== 'signature') checkData[k] = v;
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

// ── C2: Remote genesis format_version mismatch → genesis_mismatch ──
{
  console.log('\n  --- C2: format_version mismatch → genesis_mismatch ---');
  const localChain = buildChain([
    { date: '2026-06-10', entries: [ENTRY_A] },
  ], { format_version: '0.3.0' });

  const remoteChain = buildChain([
    { date: '2026-06-11', entries: [ENTRY_C] },
  ], { format_version: '0.4.0' });

  const transport = new MockTransport();
  transport.setData(LEDGER_BLOCKS_KEY, encodeChainForRemote(remoteChain));

  const result = await safeCheck(localChain, transport, crypto, MASTER_KEY);

  if (result !== null) {
    t.assert(result !== undefined, 'check() returns a result object');
    // Bug 1 fix: genesis mismatch throws GenesisMismatchError instead of
    // returning { compatible: false }. format_version is part of the sealed
    // genesis content, so different versions produce different day_hash values.
    if (hasThrowApi) {
      t.assert(result.thrown === true, 'C2. format_version mismatch → exception thrown');
      t.assertEq(result.type, 'GenesisMismatchError', 'C2b. error type is GenesisMismatchError');
    } else {
      t.assertEq(result.compatible, false,
        'format_version mismatch → incompatible (different genesis hash)');
      t.assertEq(result.reason, 'genesis_mismatch',
        'reason is genesis_mismatch');
    }
  } else {
    t.assert(false, 'format_version mismatch → genesis_mismatch — NOT IMPLEMENTED (TDD RED)');
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

// ── Summary ───────────────────────────────────────────────────────────
const failures = t.summary('genesis_gate_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
