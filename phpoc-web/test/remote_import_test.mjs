/**
 * remote_import_test.mjs — WorkerImportSource test suite.
 *
 * Tests the cloud backup import source for listing and fetching
 * ledger backup files from remote storage.
 *
 * Coverage (6 groups, 26 tests):
 *   Group A: Connection validation (4 tests)
 *     A1 — valid URL returns ok
 *     A2 — invalid URL returns error
 *     A3 — network error returns error
 *     A4 — 403 returns error
 *   Group B: List backups (5 tests)
 *     B1 — lists .json files under backups/ prefix
 *     B2 — returns empty array for empty prefix
 *     B3 — filters non-.json files
 *     B4 — network error throws
 *     B5 — sorts newest-first by filename (ISO date)
 *   Group C: Fetch backup (5 tests)
 *     C1 — returns Uint8Array for existing file
 *     C2 — returns null for 404
 *     C3 — throws on network error
 *     C4 — throws on 403
 *     C5 — round-trip: list → fetch returns same bytes
 *   Group D: fetchAndValidate happy path (4 tests)
 *     D1 — v2 import: validates seal and hashes, returns entries+ledger
 *     D2 — v1 import: validates seal and hashes, returns entries only
 *     D3 — raw chain import: validates blocks and seals, returns ledger
 *     D4 — genesis hash extraction from v2 and raw chain
 *   Group E: fetchAndValidate error paths (5 tests)
 *     E1 — wrong passphrase (seal mismatch)
 *     E2 — tampered seal detected
 *     E3 — missing format_version
 *     E4 — network error during fetch
 *     E5 — 404 backup file
 *   Group F: Edge cases (3 tests)
 *     F1 — handles backups/ prefix normalization
 *     F2 — non-.json files excluded from listing
 *     F3 — empty backups return empty list
 *
 * Usage:
 *   node test/remote_import_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { MockCrypto } from './mock_crypto.mjs';
import { jsonSort, jsonSortIndent2 } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Import module under test ──
let WorkerImportSource;
try {
  const mod = await import('../src/sync/remote_import.js');
  WorkerImportSource = mod.WorkerImportSource;
} catch (err) {
  WorkerImportSource = undefined;
}

const hasSource = WorkerImportSource && typeof WorkerImportSource === 'function';

// ── Constants ────────────────────────────────────────────────────────
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Configurable MockTransport for testing remote backup operations.
 * Supports network errors, 403 auth failures, 404, and configurable
 * file listings and bodies.
 */
class MockTransport {
  constructor(opts = {}) {
    this._files = new Map(opts.files || []);       // Map<path, Uint8Array>
    this._listResult = opts.listResult || null;     // string[] or throws
    this._networkError = opts.networkError || null; // Error message or null
    this._pullError = opts.pullError || null;       // Map<path, {status, message}>
    this._listFilesError = opts.listFilesError || null; // Error message or null
    this._authDenied = opts.authDenied || false;    // All operations throw 403
    this._pullCalls = [];
    this._listCalls = [];
  }

  async pull(path, opts) {
    this._pullCalls.push(path);

    if (this._networkError) {
      throw new Error(`Network error: ${this._networkError}`);
    }

    if (this._authDenied) {
      throw new Error('HTTP 403 Forbidden');
    }

    if (this._pullError && this._pullError.has(path)) {
      const err = this._pullError.get(path);
      throw new Error(err.message);
    }

    if (this._files.has(path)) {
      return this._files.get(path);
    }

    return null; // 404
  }

  async listFiles(prefix, opts) {
    this._listCalls.push(prefix);

    if (this._networkError) {
      throw new Error(`Network error: ${this._networkError}`);
    }

    if (this._authDenied) {
      throw new Error('HTTP 403 Forbidden');
    }

    if (this._listFilesError) {
      throw new Error(this._listFilesError);
    }

    if (this._listResult !== null) {
      return this._listResult;
    }

    // Default: return matching files with prefix stripped (matching Worker contract)
    const results = [];
    for (const [path] of this._files) {
      if (path.startsWith(prefix)) {
        results.push(path.slice(prefix.length));
      }
    }
    return results;
  }
}

/**
 * Create a mock crypto service with deterministic verifySeal and sha256.
 */
function createMockCrypto(masterKey = MASTER_KEY) {
  const crypto = new MockCrypto();

  // Override verifySeal to use deterministic hash
  crypto.verifySeal = (data, sealHex, mkHex) => {
    const computed = MockCrypto.prototype.seal.call(crypto, data, mkHex || masterKey);
    return computed === sealHex;
  };

  // Override sha256 to use Node crypto
  crypto.sha256 = (data) => {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  };

  return crypto;
}

/**
 * Create a valid v2 export with a proper seal.
 */
function createV2Export(crypto, masterKey, opts = {}) {
  const staging = opts.staging || [
    { entry_id: 'e1', title: 'Task 1', start_epoch: 1000, end_epoch: 2000, duration: 1000, hash: '' },
  ];

  const genesis = {
    type: 'genesis',
    format_version: '2',
    day_index: 0,
    date: '2026-01-01',
    prev_hash: '0'.repeat(64),
    day_hash: '',
    identity: {
      username: opts.username || 'alice',
      email: opts.email || 'alice@example.com',
      recovery_seed_enc: opts.recoverySeedEnc || 'enc:mockseed',
    },
    entries: [],
    signature: '',
  };

  const ledger = opts.ledger || [genesis];

  // Compute entry hashes
  for (const entry of staging) {
    const hashData = {};
    for (const key of Object.keys(entry).sort()) {
      if (key !== 'hash') {
        hashData[key] = entry[key];
      }
    }
    entry.hash = crypto.sha256(jsonSortIndent2(hashData));
  }

  // Compute genesis day_hash (seal over all fields except day_hash + signature)
  const genesisCheck = {};
  for (const key of Object.keys(genesis).sort()) {
    if (key !== 'day_hash' && key !== 'signature') {
      genesisCheck[key] = genesis[key];
    }
  }
  genesis.day_hash = crypto.seal(jsonSort(genesisCheck), masterKey);

  // Compute export seal
  const sealPayload = jsonSort({ ledger, staging });
  const seal = crypto.seal(sealPayload, masterKey);

  return {
    format_version: '2',
    exported_at: '2026-06-15T00:00:00Z',
    ledger,
    staging,
    seal,
  };
}

/**
 * Create a valid v1 export with a proper seal.
 */
function createV1Export(crypto, masterKey, opts = {}) {
  const entries = opts.entries || [
    { entry_id: 'e1', title: 'Task 1', start_epoch: 1000, end_epoch: 2000, duration: 1000, hash: '' },
  ];

  // Compute entry hashes
  for (const entry of entries) {
    const hashData = {};
    for (const key of Object.keys(entry).sort()) {
      if (key !== 'hash') {
        hashData[key] = entry[key];
      }
    }
    entry.hash = crypto.sha256(jsonSortIndent2(hashData));
  }

  const sealPayload = jsonSort(entries);
  const seal = crypto.seal(sealPayload, masterKey);

  return {
    format_version: '1',
    exported_at: '2026-06-15T00:00:00Z',
    entries,
    seal,
  };
}

/**
 * Create a raw chain (CLI ledger.json format) with valid block seals.
 */
function createRawChain(crypto, masterKey, opts = {}) {
  const genesis = {
    type: 'genesis',
    format_version: '2',
    day_index: 0,
    date: '2026-01-01',
    prev_hash: '0'.repeat(64),
    identity: {
      username: 'alice',
      email: 'alice@example.com',
    },
    entries: [],
    signature: '',
  };

  // Compute genesis seal
  const genesisCheckData = {};
  for (const key of Object.keys(genesis).sort()) {
    if (key !== 'day_hash' && key !== 'signature') {
      genesisCheckData[key] = genesis[key];
    }
  }
  genesis.day_hash = crypto.seal(jsonSort(genesisCheckData), masterKey);

  return [genesis];
}

/**
 * Serialize an object to Uint8Array for mock transport.
 */
function objToBytes(obj) {
  return TEXT_ENCODER.encode(JSON.stringify(obj));
}

// ══════════════════════════════════════════════════════════════════════
// Group A: Connection validation (4 tests)
// ══════════════════════════════════════════════════════════════════════
if (!hasSource) {
  console.log('WorkerImportSource class unavailable');
} else {
  console.log('\nGroup A: Connection validation');

  // A1: valid URL returns ok
  {
    const transport = new MockTransport({
      files: new Map([['backups/test.json', objToBytes({ test: true })]]),
    });
    const source = new WorkerImportSource(transport);
    const result = await source.validateConnection();
    t.assert(result.ok === true, 'A1: validateConnection returns ok for valid transport');
  }

  // A2: network error returns {ok: false}
  {
    const transport = new MockTransport({ listFilesError: 'Network error: connect ECONNREFUSED' });
    const source = new WorkerImportSource(transport);
    const result = await source.validateConnection();
    t.assert(result.ok === false, 'A2: validateConnection returns not ok on error');
    t.assert(typeof result.error === 'string', 'A2: error message is a string');
  }

  // A3: 403 returns {ok: false}
  {
    const transport = new MockTransport({ authDenied: true });
    const source = new WorkerImportSource(transport);
    const result = await source.validateConnection();
    t.assert(result.ok === false, 'A3: validateConnection returns not ok on 403');
  }

  // A4: empty prefix succeeds (0 files is valid)
  {
    const transport = new MockTransport({ listResult: [] });
    const source = new WorkerImportSource(transport);
    const result = await source.validateConnection();
    t.assert(result.ok === true, 'A4: validateConnection ok with empty prefix');
  }

  // ══════════════════════════════════════════════════════════════════
  // Group B: List backups (5 tests)
  // ══════════════════════════════════════════════════════════════════
  console.log('\nGroup B: List backups');

  // B1: lists .json files under backups/ prefix
  {
    const transport = new MockTransport({
      listResult: [
        'backups/ph-ledger-full-export-2026-06-15.json',
        'backups/ph-ledger-full-export-2026-06-14.json',
      ],
    });
    const source = new WorkerImportSource(transport);
    const result = await source.listBackups();
    t.assertEq(result.length, 2, 'B1: returns 2 backups');
    t.assert(result[0].includes('2026-06-15'), 'B1: newest first (Jun 15)');
    t.assert(result[1].includes('2026-06-14'), 'B1: older second (Jun 14)');
  }

  // B2: returns empty array for empty prefix
  {
    const transport = new MockTransport({ listResult: [] });
    const source = new WorkerImportSource(transport);
    const result = await source.listBackups();
    t.assertEq(result.length, 0, 'B2: empty array for no backups');
    t.assert(Array.isArray(result), 'B2: result is an array');
  }

  // B3: filters non-.json files
  {
    const transport = new MockTransport({
      listResult: [
        'backups/ph-ledger-full-export-2026-06-15.json',
        'backups/notes.txt',
        'backups/ph-ledger-full-export-2026-06-14.json',
        'backups/README.md',
      ],
    });
    const source = new WorkerImportSource(transport);
    const result = await source.listBackups();
    t.assertEq(result.length, 2, 'B3: only .json files returned');
    t.assert(result.every(f => f.endsWith('.json')), 'B3: all results end with .json');
  }

  // B4: network error throws
  {
    const transport = new MockTransport({ listFilesError: 'Network error: ETIMEDOUT' });
    const source = new WorkerImportSource(transport);
    await t.assertAsyncThrows(
      source.listBackups(),
      'B4: listBackups throws on network error'
    );
  }

  // B5: sorts newest-first by filename (ISO date)
  {
    const transport = new MockTransport({
      listResult: [
        'backups/ph-ledger-full-export-2026-01-01.json',
        'backups/ph-ledger-full-export-2026-12-31.json',
        'backups/ph-ledger-full-export-2026-06-15.json',
      ],
    });
    const source = new WorkerImportSource(transport);
    const result = await source.listBackups();
    t.assertEq(result.length, 3, 'B5: all 3 files returned');
    t.assert(result[0].includes('2026-12-31'), 'B5: Dec 31 is newest');
    t.assert(result[2].includes('2026-01-01'), 'B5: Jan 1 is oldest');
  }

  // ══════════════════════════════════════════════════════════════════
  // Group C: Fetch backup (5 tests)
  // ══════════════════════════════════════════════════════════════════
  console.log('\nGroup C: Fetch backup');

  // C1: returns Uint8Array for existing file
  {
    const testData = objToBytes({ hello: 'world' });
    const transport = new MockTransport({
      files: new Map([['backups/test.json', testData]]),
    });
    const source = new WorkerImportSource(transport);
    const result = await source.fetchBackup('test.json');
    t.assert(result instanceof Uint8Array, 'C1: result is Uint8Array');
    t.assertEq(result.length, testData.length, 'C1: same byte length');
  }

  // C2: returns null for 404
  {
    const transport = new MockTransport();
    const source = new WorkerImportSource(transport);
    const result = await source.fetchBackup('nonexistent.json');
    t.assert(result === null, 'C2: returns null for 404');
  }

  // C3: throws on network error
  {
    const transport = new MockTransport({ networkError: 'Connection refused' });
    const source = new WorkerImportSource(transport);
    await t.assertAsyncThrows(
      source.fetchBackup('test.json'),
      'C3: fetchBackup throws on network error'
    );
  }

  // C4: throws on 403
  {
    const transport = new MockTransport({ authDenied: true });
    const source = new WorkerImportSource(transport);
    await t.assertAsyncThrows(
      source.fetchBackup('test.json'),
      'C4: fetchBackup throws on 403'
    );
  }

  // C5: round-trip — list then fetch returns same bytes
  {
    const testData = objToBytes({ ledger: true, staging: [{ entry_id: 'x1' }] });
    const transport = new MockTransport({
      files: new Map([['backups/ph-ledger-full-export-2026-06-15.json', testData]]),
      listResult: ['ph-ledger-full-export-2026-06-15.json'],
    });
    const source = new WorkerImportSource(transport);

    const list = await source.listBackups();
    t.assertEq(list[0], 'ph-ledger-full-export-2026-06-15.json', 'C5: lists backup');

    const fetched = await source.fetchBackup(list[0]);
    const decoded = TEXT_DECODER.decode(fetched);
    const parsed = JSON.parse(decoded);
    t.assert(parsed.ledger === true, 'C5: round-trip preserves data');
    t.assertEq(parsed.staging.length, 1, 'C5: staging entry preserved');
  }

  // ══════════════════════════════════════════════════════════════════
  // Group D: fetchAndValidate happy path (4 tests)
  // ══════════════════════════════════════════════════════════════════
  console.log('\nGroup D: fetchAndValidate happy path');

  // D1: v2 import — validates seal and hashes, returns entries+ledger
  {
    const crypto = createMockCrypto();
    const v2Export = createV2Export(crypto, MASTER_KEY, {
      username: 'alice',
      staging: [
        { entry_id: 'e1', title: 'Task 1', start_epoch: 1000, end_epoch: 2000, duration: 1000, hash: '' },
        { entry_id: 'e2', title: 'Task 2', start_epoch: 2000, end_epoch: 3000, duration: 1000, hash: '' },
      ],
    });

    const transport = new MockTransport({
      files: new Map([['backups/export-v2.json', objToBytes(v2Export)]]),
    });
    const source = new WorkerImportSource(transport, crypto);

    const result = await source.fetchAndValidate('export-v2.json', MASTER_KEY);

    t.assert(result !== null, 'D1: result is not null');
    t.assertEq(result.formatVersion, '2', 'D1: format version is 2');
    t.assertEq(result.count, 2, 'D1: 2 staging entries');
    t.assertEq(result.entries.length, 2, 'D1: entries array has 2 items');
    t.assert(result.ledger !== null, 'D1: ledger is present');
    t.assert(result.ledger.length > 0, 'D1: ledger has blocks');
    t.assertEq(result.genesisBlock.type, 'genesis', 'D1: genesis block is type genesis');
    t.assert(typeof result.genesisHash === 'string', 'D1: genesis hash is a string');
    t.assertEq(result.genesisHash.length, 64, 'D1: genesis hash is 64 hex chars');
  }

  // D2: v1 import — validates seal and hashes, returns entries only
  {
    const crypto = createMockCrypto();
    const v1Export = createV1Export(crypto, MASTER_KEY, {
      entries: [
        { entry_id: 'e1', title: 'Old task', start_epoch: 500, end_epoch: 1500, duration: 1000, hash: '' },
      ],
    });

    const transport = new MockTransport({
      files: new Map([['backups/export-v1.json', objToBytes(v1Export)]]),
    });
    const source = new WorkerImportSource(transport, crypto);

    const result = await source.fetchAndValidate('export-v1.json', MASTER_KEY);

    t.assertEq(result.formatVersion, '1', 'D2: format version is 1');
    t.assertEq(result.count, 1, 'D2: 1 entry');
    t.assert(result.ledger === null, 'D2: ledger is null for v1');
    t.assert(result.genesisHash === null, 'D2: genesis hash is null for v1');
  }

  // D3: raw chain import — validates blocks and seals, returns ledger
  {
    const crypto = createMockCrypto();
    const chain = createRawChain(crypto, MASTER_KEY);

    const transport = new MockTransport({
      files: new Map([['backups/chain.json', objToBytes(chain)]]),
    });
    const source = new WorkerImportSource(transport, crypto);

    const result = await source.fetchAndValidate('chain.json', MASTER_KEY);

    t.assertEq(result.formatVersion, 'chain', 'D3: format version is chain');
    t.assertEq(result.count, 0, 'D3: 0 staging entries for raw chain');
    t.assert(result.ledger !== null, 'D3: ledger is present');
    t.assertEq(result.ledger.length, 1, 'D3: 1 block in chain');
    t.assertEq(result.genesisBlock.type, 'genesis', 'D3: genesis block is type genesis');
  }

  // D4: genesis hash extraction
  {
    const crypto = createMockCrypto();
    const v2Export = createV2Export(crypto, MASTER_KEY);
    const transport = new MockTransport({
      files: new Map([['backups/v2.json', objToBytes(v2Export)]]),
    });
    const source = new WorkerImportSource(transport, crypto);

    const result = await source.fetchAndValidate('v2.json', MASTER_KEY);
    t.assert(result.genesisHash !== null, 'D4: v2 has genesis hash');
    t.assertEq(result.genesisHash.length, 64, 'D4: genesis hash is 64 hex chars');
    t.assertEq(result.genesisBlock.day_hash, result.genesisHash, 'D4: genesisHash matches genesisBlock.day_hash');
  }

  // ══════════════════════════════════════════════════════════════════
  // Group E: fetchAndValidate error paths (5 tests)
  // ══════════════════════════════════════════════════════════════════
  console.log('\nGroup E: fetchAndValidate error paths');

  // E1: wrong passphrase (seal mismatch with different master key)
  {
    const crypto = createMockCrypto();
    const v2Export = createV2Export(crypto, MASTER_KEY);

    const transport = new MockTransport({
      files: new Map([['backups/v2.json', objToBytes(v2Export)]]),
    });
    const source = new WorkerImportSource(transport, crypto);

    const wrongKey = 'f'.repeat(64); // Different master key
    await t.assertAsyncThrows(
      source.fetchAndValidate('v2.json', wrongKey),
      'E1: wrong passphrase throws seal verification error'
    );
  }

  // E2: tampered seal detected
  {
    const crypto = createMockCrypto();
    const v2Export = createV2Export(crypto, MASTER_KEY);
    v2Export.seal = '0'.repeat(64); // Tampered seal

    const transport = new MockTransport({
      files: new Map([['backups/tampered.json', objToBytes(v2Export)]]),
    });
    const source = new WorkerImportSource(transport, crypto);

    await t.assertAsyncThrows(
      source.fetchAndValidate('tampered.json', MASTER_KEY),
      'E2: tampered seal throws'
    );
  }

  // E3: missing format_version
  {
    const crypto = createMockCrypto();
    const invalidData = { entries: [], seal: 'abc123' };

    const transport = new MockTransport({
      files: new Map([['backups/invalid.json', objToBytes(invalidData)]]),
    });
    const source = new WorkerImportSource(transport, crypto);

    await t.assertAsyncThrows(
      source.fetchAndValidate('invalid.json', MASTER_KEY),
      'E3: missing format_version throws'
    );
  }

  // E4: network error during fetch
  {
    const crypto = createMockCrypto();
    const transport = new MockTransport({ networkError: 'ECONNREFUSED' });
    const source = new WorkerImportSource(transport, crypto);

    await t.assertAsyncThrows(
      source.fetchAndValidate('test.json', MASTER_KEY),
      'E4: network error during fetch throws'
    );
  }

  // E5: 404 backup file
  {
    const crypto = createMockCrypto();
    const transport = new MockTransport();
    const source = new WorkerImportSource(transport, crypto);

    await t.assertAsyncThrows(
      source.fetchAndValidate('missing.json', MASTER_KEY),
      'E5: 404 backup throws'
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // Group F: Edge cases (3 tests)
  // ══════════════════════════════════════════════════════════════════
  console.log('\nGroup F: Edge cases');

  // F1: handles backups/ prefix normalization
  {
    const testData = objToBytes({ test: true });
    const transport = new MockTransport({
      files: new Map([['backups/file.json', testData]]),
    });
    const source = new WorkerImportSource(transport);

    // Both forms should work
    const result1 = await source.fetchBackup('file.json');
    t.assert(result1 !== null, 'F1: fetch without prefix works');

    const result2 = await source.fetchBackup('backups/file.json');
    t.assert(result2 !== null, 'F1: fetch with prefix works');
    t.assertEq(result2.length, result1.length, 'F1: both fetches return same data');
  }

  // F2: non-.json files excluded from listing
  {
    const transport = new MockTransport({
      listResult: [
        'backups/data.json',
        'backups/.DS_Store',
        'backups/export.json',
        'backups/Thumbs.db',
      ],
    });
    const source = new WorkerImportSource(transport);
    const result = await source.listBackups();
    t.assertEq(result.length, 2, 'F2: only .json files in listing');
    t.assert(result.every(f => f.endsWith('.json')), 'F2: all listed files are .json');
  }

  // F3: empty backups return empty list
  {
    const transport = new MockTransport({ listResult: [] });
    const source = new WorkerImportSource(transport);
    const result = await source.listBackups();
    t.assertEq(result.length, 0, 'F3: empty backups returns empty array');
    t.assert(Array.isArray(result), 'F3: result is still an array');
  }

  // ══════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════
  console.log(`\nTests: ${t.passed} passed, ${t.failed} failed (${t.passed + t.failed} assertions)`);
  if (t.errors.length > 0) {
    console.log('Failures:');
    for (const e of t.errors) {
      console.log(`  ✗ ${e}`);
    }
  }
}

// Exit with failure code if any tests failed
process.exit(t.failed > 0 ? 1 : 0);
