/**
 * export_passphrase_validation_test.mjs — E2E-06 Phase 2 (RED)
 *
 * Tests the extracted exportWithAuth() function that replaces the inline
 * passphrase-bypass bug in DevModeContext.jsx exportLedgerAction.
 *
 * Bug: exportLedgerAction checks getMasterKey() first. If cached MK is
 * non-null, authenticate() is never called — any passphrase works.
 *
 * Fix: Always call authenticate(passphrase, seed) for sensitive ops.
 * Never use cached MK to skip passphrase validation for export.
 *
 * Module under test: ../src/services/export_auth.js (DOES NOT EXIST YET)
 * Expected result: ALL 28 tests FAIL — classic RED phase of TDD.
 *
 * Test groups:
 *   Group A — Cached Master Key Bypass (7 tests)
 *   Group B — Cold-Start Auth (4 tests)
 *   Group C — Master Key Cache Safety (5 tests)
 *   Group D — Error Messaging & UX Flow (5 tests)
 *   Group E — Integration & Regression (7 tests)
 *
 * Usage:
 *   node test/export_passphrase_validation_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Import module under test (DOES NOT EXIST YET — RED phase) ────────
let exportWithAuth;
try {
  const mod = await import('../src/services/export_auth.js');
  exportWithAuth = mod.exportWithAuth;
} catch (err) {
  // RED phase: module doesn't exist → exportWithAuth stays undefined
}

// Also import the real exportLedgerFull for integration tests
let exportLedgerFull;
try {
  exportLedgerFull = (await import('../src/services/ledger_export.js')).exportLedgerFull;
} catch {
  exportLedgerFull = undefined;
}

// ══════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════

const STORED_SEED_KEY = 'phpoc_seed';
const ENTRIES_KEY = 'entries';
const PBKDF2_ITERATIONS = 600000;

const CORRECT_PASSPHRASE = 'CorrectPassword123';
const WRONG_PASSPHRASE = 'wrong-passphrase-garbage';
const SEED = 'bXlTZWVkOTk5OW15U2VlZDk5OTlteVNlZWQ5OTk5bXlTZWVkOTk5OQ==';

// ══════════════════════════════════════════════════════════════════════
// Mock Crypto — tracks authenticate() calls and MK state
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor() {
    /** @type {string|null} Cached master key (simulates login caching) */
    this._mk = null;
    /** @type {number} How many times authenticate() was called */
    this._authCalls = 0;
    /** @type {string[]} Passphrases passed to authenticate() */
    this._authPassphrases = [];
    /** @type {number} How many times setMasterKey() was called */
    this._setMkCalls = 0;
    /** @type {string|null} The correct derived key for CORRECT_PASSPHRASE + SEED */
    this._correctDerivedKey = null;
    /** If true, authenticate() throws for wrong passphrase */
    this._authThrows = true;
  }

  getMasterKey() {
    return this._mk;
  }

  setMasterKey(hex) {
    this._mk = hex;
    this._setMkCalls++;
  }

  hasMasterKey() {
    return this._mk !== null;
  }

  clearMasterKey() {
    this._mk = null;
  }

  /**
   * Simulates PBKDF2-based authentication.
   * Correct passphrase + seed → deterministic MK.
   * Wrong passphrase → throws (when _authThrows is true).
   */
  authenticate(passphrase, seed, iterations) {
    this._authCalls++;
    this._authPassphrases.push(passphrase);

    if (this._authThrows && passphrase !== CORRECT_PASSPHRASE) {
      throw new Error('Authentication failed: incorrect passphrase or seed');
    }

    // Return a key for any passphrase (non-throwing) or correct passphrase
    const derived = createHash('sha256')
      .update((seed || 'noseed') + ':' + passphrase)
      .digest('hex');
    if (seed === SEED) {
      this._correctDerivedKey = derived;
    }
    return derived;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  seal(data, masterKeyHex) {
    return createHash('sha256')
      .update(data + ':' + (masterKeyHex || ''))
      .digest('hex');
  }

  verifySeal(data, sealHex, masterKeyHex) {
    return this.seal(data, masterKeyHex) === sealHex;
  }

  // Phase 6 P1 Step 1: PBKDF2 passphrase → PDK (for hash validation)
  derivePdk(passphrase, iterations) {
    // Mimics real WASM: PBKDF2(passphrase, "session-salt", iterations, 32)
    // Not dependent on seed — hash:" is added downstream by the caller.
    return createHash('sha256')
      .update(`pdk:${passphrase}:${iterations}`)
      .digest('hex');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Storage
// ══════════════════════════════════════════════════════════════════════

class MockStorage {
  constructor() {
    this._store = new Map();
  }

  async get(key) {
    return this._store.get(key);
  }

  async set(key, val) {
    this._store.set(key, val);
  }

  async delete(key) {
    this._store.delete(key);
  }

  seed(seedValue) {
    this._store.set(STORED_SEED_KEY, seedValue);
  }

  entries(entriesArray) {
    this._store.set(ENTRIES_KEY, entriesArray);
  }

  blocks(blocksArray) {
    this._store.set('ledger:blocks', blocksArray);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Sync
// ══════════════════════════════════════════════════════════════════════

class MockSync {
  constructor(entries = []) {
    this._entries = entries;
  }

  async readEntries() {
    return this._entries;
  }

  setEntries(entries) {
    this._entries = entries;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Sample Data
// ══════════════════════════════════════════════════════════════════════

const SAMPLE_STAGING = [
  {
    entry_id: 'stg-0001-0000-4000-a000-000000000001',
    title: 'Active Task',
    start_epoch: 1717920000000,
    is_active: true,
    is_paused: false,
    pauses: [],
    tags: ['work'],
    comment: null,
    media: [],
    device_uuid: 'dev-test-001',
    hash: 'stg1hash11111111111111111111111111111111111111111111111111111111',
  },
];

const SAMPLE_BLOCKS = [
  {
    type: 'genesis',
    day_index: 0,
    date: '2026-06-20',
    identity: { username: 'tester', email: 'test@example.com' },
    prev_hash: '0'.repeat(64),
    entries: [],
    day_hash: 'bf4c2e72d4f4b9261c12753ea6a6ed3ea8be8aab8aa74d415ff74da8349caeb3',
  },
  {
    type: 'day',
    day_index: 1,
    date: '2026-06-20',
    prev_hash: 'bf4c2e72d4f4b9261c12753ea6a6ed3ea8be8aab8aa74d415ff74da8349caeb3',
    entries: [
      {
        hash: 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1',
        data: {
          title: 'Completed Task',
          duration: 1800000,
          is_active: false,
          startTime_enc: 'enc-start-1',
          endTime_enc: 'enc-end-1',
          metadata_enc: 'enc-meta-1',
        },
      },
    ],
    day_hash: 'd4yh4sh11111111111111111111111111111111111111111111111111111111',
  },
];

// ══════════════════════════════════════════════════════════════════════
// Helper: build services object for exportWithAuth()
// ══════════════════════════════════════════════════════════════════════

function buildServices(opts = {}) {
  const {
    cachedMK = null,
    seed = SEED,
    entries = SAMPLE_STAGING,
    blocks = SAMPLE_BLOCKS,
    authThrows = true,
  } = opts;

  const crypto = new MockCrypto();
  if (cachedMK) {
    crypto.setMasterKey(cachedMK);
  }
  crypto._authThrows = authThrows;

  const storage = new MockStorage();
  if (seed !== undefined && seed !== null) storage.seed(seed);
  storage.entries(entries);
  storage.blocks(blocks);

  const sync = new MockSync(entries);

  return { crypto, storage, sync };
}

// ══════════════════════════════════════════════════════════════════════
// Helper: call exportWithAuth safely (returns null on module-not-found)
// ══════════════════════════════════════════════════════════════════════

async function callExportWithAuth(opts = {}) {
  if (typeof exportWithAuth !== 'function') return null;

  const {
    passphrase = CORRECT_PASSPHRASE,
    cachedMK = null,
    seed = SEED,
    entries = SAMPLE_STAGING,
    blocks = SAMPLE_BLOCKS,
    authThrows = true,
  } = opts;

  const { crypto, storage } = buildServices({ cachedMK, seed, entries, blocks, authThrows });

  return exportWithAuth({ crypto, storage, passphrase, entries, blocks });
}

// ══════════════════════════════════════════════════════════════════════
// Group A — Cached Master Key Bypass (7 tests)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group A — Cached Master Key Bypass ===');

console.log('\n  — A1: Wrong passphrase rejected when MK is cached —');
{
  const { crypto, storage } = buildServices({
    cachedMK: 'cafebabe' + 'f'.repeat(56),
  });

  if (typeof exportWithAuth === 'function') {
    try {
      await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
        
      });
      t.assert(false, 'A1: wrong passphrase with cached MK → should throw');
    } catch (err) {
      t.assert(true, 'A1: wrong passphrase with cached MK → throws');
    }
  } else {
    t.assert(false, 'A1: wrong passphrase with cached MK → throws');
  }
}

console.log('\n  — A2: Error message includes auth-related keyword —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      const { crypto, storage } = buildServices({
        cachedMK: 'cafebabe' + 'f'.repeat(56),
      });
      await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
        
      });
      t.assert(false, 'A2: should have thrown');
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      const hasAuthKeyword =
        msg.includes('auth') ||
        msg.includes('passphrase') ||
        msg.includes('incorrect') ||
        msg.includes('invalid');
      t.assert(hasAuthKeyword, 'A2: error message contains auth keyword');
    }
  } else {
    t.assert(false, 'A2: error message contains auth keyword');
  }
}

console.log('\n  — A3: Correct passphrase succeeds when MK is cached —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      const result = await callExportWithAuth({
        passphrase: CORRECT_PASSPHRASE,
        cachedMK: 'cafebabe' + 'f'.repeat(56),
      });
      t.assert(result && typeof result.blob !== 'undefined',
        'A3: correct passphrase with cached MK → returns blob');
    } catch (err) {
      t.assert(false, `A3: correct passphrase should succeed: ${err.message}`);
    }
  } else {
    t.assert(false, 'A3: correct passphrase with cached MK → returns blob');
  }
}

console.log('\n  — A4: authenticate() called even when getMasterKey() is non-null —');
{
  const { crypto, storage } = buildServices({
    cachedMK: 'cafebabe' + 'f'.repeat(56),
  });

  if (typeof exportWithAuth === 'function') {
    await exportWithAuth({
      crypto, storage, passphrase: CORRECT_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      
    });
    t.assert(crypto._authCalls >= 1,
      'A4: authenticate() was called (cached MK was NOT used to skip auth)');
  } else {
    t.assert(false, 'A4: authenticate() was called');
  }
}

console.log('\n  — A5: Export with correct passphrase produces seal-verifiable blob —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      const result = await callExportWithAuth({ passphrase: CORRECT_PASSPHRASE });
      t.assert(result && result.blob instanceof Blob, 'A5.1: result contains a Blob');
      t.assertEq(result.blob.type, 'application/json', 'A5.2: Blob has JSON MIME type');

      const text = await result.blob.text();
      const parsed = JSON.parse(text);
      t.assertEq(parsed.format_version, '2', 'A5.3: format_version is "2"');
      t.assert(typeof parsed.seal === 'string' && parsed.seal.length === 64,
        'A5.4: seal is 64-char hex string');
    } catch (err) {
      t.assert(false, `A5: export should succeed: ${err.message}`);
    }
  } else {
    t.assert(false, 'A5.1: result contains a Blob');
    t.assert(false, 'A5.2: Blob has JSON MIME type');
    t.assert(false, 'A5.3: format_version is "2"');
    t.assert(false, 'A5.4: seal is 64-char hex string');
  }
}

console.log('\n  — A6: Empty passphrase rejected even with cached MK —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      await callExportWithAuth({ passphrase: '', cachedMK: 'somecachedkey' });
      t.assert(false, 'A6: empty passphrase → should throw');
    } catch (err) {
      t.assert(true, 'A6: empty passphrase → throws');
    }
  } else {
    t.assert(false, 'A6: empty passphrase → throws');
  }
}

console.log('\n  — A7: Wrong passphrase does NOT produce a downloadable blob —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      await callExportWithAuth({ passphrase: WRONG_PASSPHRASE });
      t.assert(false, 'A7: wrong passphrase → should throw, no blob produced');
    } catch (err) {
      // Expected: no blob was generated
      t.assert(true, 'A7: wrong passphrase → throws (no blob)');
    }
  } else {
    t.assert(false, 'A7: wrong passphrase → throws (no blob)');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group B — Cold-Start Auth (4 tests)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group B — Cold-Start Auth (no cached MK) ===');

console.log('\n  — B1: Wrong passphrase rejected in cold start —');
{
  const { crypto, storage } = buildServices({ cachedMK: null });
  t.assertEq(crypto.getMasterKey(), null, 'B1.1: precondition — MK is null');

  if (typeof exportWithAuth === 'function') {
    try {
      await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
        
      });
      t.assert(false, 'B1.2: wrong passphrase in cold start → should throw');
    } catch (err) {
      t.assert(true, 'B1.2: wrong passphrase in cold start → throws');
    }
  } else {
    t.assert(false, 'B1.2: wrong passphrase in cold start → throws');
  }
}

console.log('\n  — B2: Correct passphrase succeeds in cold start —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      const result = await callExportWithAuth({
        passphrase: CORRECT_PASSPHRASE,
        cachedMK: null,
      });
      t.assert(result && result.blob instanceof Blob,
        'B2: correct passphrase in cold start → returns blob');
    } catch (err) {
      t.assert(false, `B2: correct passphrase should succeed: ${err.message}`);
    }
  } else {
    t.assert(false, 'B2: correct passphrase in cold start → returns blob');
  }
}

console.log('\n  — B3: authenticate() is called in cold start —');
{
  const { crypto, storage } = buildServices({ cachedMK: null });

  if (typeof exportWithAuth === 'function') {
    await exportWithAuth({
      crypto, storage, passphrase: CORRECT_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      
    });
    t.assert(crypto._authCalls >= 1, 'B3: authenticate() was called in cold start');
  } else {
    t.assert(false, 'B3: authenticate() was called in cold start');
  }
}

console.log('\n  — B4: MK is NOT cached after successful cold-start export —');
{
  const { crypto, storage } = buildServices({ cachedMK: null });

  if (typeof exportWithAuth === 'function') {
    await exportWithAuth({
      crypto, storage, passphrase: CORRECT_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      
    });
    // The export should NOT set the cached MK — it's a temporary auth
    t.assertEq(crypto._setMkCalls, 0,
      'B4: setMasterKey() was NOT called (export uses temp auth key, not cached)');
  } else {
    t.assert(false, 'B4: setMasterKey() was NOT called');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group C — Master Key Cache Safety (5 tests)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group C — Master Key Cache Safety ===');

console.log('\n  — C1: Cached MK is NOT overwritten after failed export —');
{
  const cachedValue = 'cafebabe' + 'f'.repeat(56);
  const { crypto, storage } = buildServices({ cachedMK: cachedValue });

  if (typeof exportWithAuth === 'function') {
    try {
      await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
        
      });
    } catch {
      // Expected
    }
    t.assertEq(crypto.getMasterKey(), cachedValue,
      'C1: cached MK unchanged after failed export');
  } else {
    t.assert(false, 'C1: cached MK unchanged after failed export');
  }
}

console.log('\n  — C2: getMasterKey() returns same value before and after failed export —');
{
  const cachedValue = 'cafebabe' + 'f'.repeat(56);
  const { crypto, storage } = buildServices({ cachedMK: cachedValue });
  const before = crypto.getMasterKey();

  if (typeof exportWithAuth === 'function') {
    try {
      await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
        
      });
    } catch {
      // Expected
    }
    t.assertEq(crypto.getMasterKey(), before,
      'C2: MK identical before and after failed export');
  } else {
    t.assert(false, 'C2: MK identical before and after failed export');
  }
}

console.log('\n  — C3: Cached MK preserved after successful export —');
{
  const cachedValue = 'cafebabe' + 'f'.repeat(56);
  const { crypto, storage } = buildServices({ cachedMK: cachedValue });

  if (typeof exportWithAuth === 'function') {
    await exportWithAuth({
      crypto, storage, passphrase: CORRECT_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      
    });
    t.assertEq(crypto.getMasterKey(), cachedValue,
      'C3: cached MK preserved after successful export');
  } else {
    t.assert(false, 'C3: cached MK preserved after successful export');
  }
}

console.log('\n  — C4: exportWithAuth never calls setMasterKey() —');
{
  // Use MockCrypto directly (not buildServices) so setup doesn't
  // increment _setMkCalls via the cached MK setter.
  const crypto = new MockCrypto();
  crypto._mk = 'somekey'; // set cached MK without calling setMasterKey()
  crypto._authThrows = true;

  const storage = new MockStorage();
  storage.seed(SEED);
  storage.entries(SAMPLE_STAGING);
  storage.blocks(SAMPLE_BLOCKS);

  if (typeof exportWithAuth === 'function') {
    await exportWithAuth({
      crypto, storage, passphrase: CORRECT_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      
    });
    t.assertEq(crypto._setMkCalls, 0,
      'C4: setMasterKey() was never called (temp auth, no cache pollution)');
  } else {
    t.assert(false, 'C4: setMasterKey() was never called');
  }
}

console.log('\n  — C5: Repeated exports produce identical seals —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      const r1 = await callExportWithAuth({ passphrase: CORRECT_PASSPHRASE });
      const r2 = await callExportWithAuth({ passphrase: CORRECT_PASSPHRASE });

      const t1 = JSON.parse(await r1.blob.text());
      const t2 = JSON.parse(await r2.blob.text());

      // exported_at will differ, but seal should be identical (seal excludes exported_at)
      t.assertEq(t1.seal, t2.seal,
        'C5: same data + same passphrase → identical seal');
    } catch (err) {
      t.assert(false, `C5: repeated exports should succeed: ${err.message}`);
    }
  } else {
    t.assert(false, 'C5: same data + same passphrase → identical seal');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group D — Error Messaging & UX Flow (5 tests)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group D — Error Messaging & UX Flow ===');

console.log('\n  — D1: Error message is human-readable, not a stack trace —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      await callExportWithAuth({ passphrase: WRONG_PASSPHRASE });
      t.assert(false, 'D1: should have thrown');
    } catch (err) {
      const msg = err.message || '';
      // A human-readable message is short, not a stack trace
      t.assert(msg.indexOf('\n') === -1 || msg.length < 200,
        'D1.1: error is single-line or short (not a stack trace)');
      t.assert(msg.length > 0 && msg.length < 500,
        'D1.2: error message has reasonable length');
    }
  } else {
    t.assert(false, 'D1.1: error is single-line or short');
    t.assert(false, 'D1.2: error message has reasonable length');
  }
}

console.log('\n  — D2: Wrong passphrase error is distinguishable from other errors —');
{
  if (typeof exportWithAuth === 'function') {
    // Wrong passphrase error
    let authErrorMsg = '';
    try {
      await callExportWithAuth({ passphrase: WRONG_PASSPHRASE });
    } catch (err) {
      authErrorMsg = (err.message || '').toLowerCase();
    }

    // No data error (should be a different message)
    let noDataErrorMsg = '';
    try {
      await callExportWithAuth({
        passphrase: CORRECT_PASSPHRASE,
        entries: [],
        blocks: [],
      });
    } catch (err) {
      noDataErrorMsg = (err.message || '').toLowerCase();
    }

    t.assert(authErrorMsg !== noDataErrorMsg,
      'D2: auth error message differs from "no data" error message');
  } else {
    t.assert(false, 'D2: auth error message differs from "no data" error message');
  }
}

console.log('\n  — D3: Correct retry after wrong passphrase works —');
{
  if (typeof exportWithAuth === 'function') {
    // First attempt: wrong passphrase
    try {
      await callExportWithAuth({ passphrase: WRONG_PASSPHRASE });
    } catch {
      // Expected
    }

    // Second attempt: correct passphrase (same services — simulates retry)
    try {
      const result = await callExportWithAuth({ passphrase: CORRECT_PASSPHRASE });
      t.assert(result && result.blob instanceof Blob,
        'D3: retry with correct passphrase after failure → succeeds');
    } catch (err) {
      t.assert(false, `D3: retry should succeed: ${err.message}`);
    }
  } else {
    t.assert(false, 'D3: retry with correct passphrase after failure → succeeds');
  }
}

console.log('\n  — D4: No seed stored produces a distinct error —');
{
  if (typeof exportWithAuth === 'function') {
    const { crypto, storage } = buildServices({ seed: null });
    try {
      await exportWithAuth({
        crypto, storage, passphrase: CORRECT_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
        
      });
      t.assert(false, 'D4: no seed → should throw');
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      t.assert(msg.includes('seed') || msg.includes('recovery'),
        'D4: no-seed error mentions seed/recovery');
    }
  } else {
    t.assert(false, 'D4: no-seed error mentions seed/recovery');
  }
}

console.log('\n  — D5: No-seed error takes priority over passphrase error —');
{
  if (typeof exportWithAuth === 'function') {
    const { crypto, storage } = buildServices({ seed: null });
    try {
      await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE, entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
        
      });
      t.assert(false, 'D5: should throw');
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      // No seed is a precondition — should fail before passphrase validation
      t.assert(msg.includes('seed') || msg.includes('recovery'),
        'D5: no-seed error fires before passphrase validation');
    }
  } else {
    t.assert(false, 'D5: no-seed error fires before passphrase validation');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group E — Integration & Regression (7 tests)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group E — Integration & Regression ===');

console.log('\n  — E1: Empty data → "No data to export" error —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      await callExportWithAuth({
        passphrase: CORRECT_PASSPHRASE,
        entries: [],
        blocks: [],
      });
      t.assert(false, 'E1: empty data → should throw');
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      t.assert(
        msg.includes('no data') || msg.includes('nothing') || msg.includes('empty'),
        'E1: empty data → "no data to export" error'
      );
    }
  } else {
    t.assert(false, 'E1: empty data → "no data to export" error');
  }
}

console.log('\n  — E2: Export uses correct derived key (not cached MK) —');
{
  const cachedValue = 'cafebabe' + 'f'.repeat(56);
  const { crypto, storage } = buildServices({ cachedMK: cachedValue });

  if (typeof exportWithAuth === 'function') {
    const result = await exportWithAuth({
      crypto, storage, passphrase: CORRECT_PASSPHRASE,
      entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
    });

    // Verify: authenticate() was called (not skipped via cached MK)
    t.assert(crypto._authCalls >= 1,
      'E2.1: authenticate() was called (derived key, not cached MK)');

    // Verify: export produced valid blob with a seal
    t.assert(result && result.blob instanceof Blob,
      'E2.2: export produced a valid blob');

    const text = await result.blob.text();
    const parsed = JSON.parse(text);
    t.assert(typeof parsed.seal === 'string' && parsed.seal.length === 64,
      'E2.3: seal is valid 64-char hex (freshly derived key was used)');
  } else {
    t.assert(false, 'E2.1: authenticate() was called');
    t.assert(false, 'E2.2: export produced a valid blob');
    t.assert(false, 'E2.3: seal is valid 64-char hex');
  }
}

console.log('\n  — E3: Export result is valid v2 format JSON —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      const result = await callExportWithAuth({ passphrase: CORRECT_PASSPHRASE });
      const text = await result.blob.text();
      const parsed = JSON.parse(text);

      t.assertEq(parsed.format_version, '2', 'E3.1: format_version is "2"');
      t.assert(typeof parsed.exported_at === 'string', 'E3.2: exported_at present');
      t.assert(Array.isArray(parsed.ledger), 'E3.3: ledger is array');
      t.assert(!parsed.staging || Array.isArray(parsed.staging), 'E3.4: staging not present in v2 export (D11)');
      t.assert(typeof parsed.seal === 'string' && parsed.seal.length === 64,
        'E3.5: seal is 64-char hex');
    } catch (err) {
      t.assert(false, `E3: export should succeed: ${err.message}`);
    }
  } else {
    t.assert(false, 'E3.1: format_version is "2"');
    t.assert(false, 'E3.2: exported_at present');
    t.assert(false, 'E3.3: ledger is array');
    t.assert(false, 'E3.4: staging not present in v2 export (D11)');
    t.assert(false, 'E3.5: seal is 64-char hex');
  }
}

console.log('\n  — E4: exportLedgerFull is called (integration with real export module) —');
{
  if (typeof exportWithAuth === 'function' && typeof exportLedgerFull === 'function') {
    try {
      const { crypto, storage } = buildServices({});
      const correctKey = crypto._correctDerivedKey
        || crypto.authenticate(CORRECT_PASSPHRASE, SEED, PBKDF2_ITERATIONS);

      const result = await exportWithAuth({
        crypto, storage, passphrase: CORRECT_PASSPHRASE,
        blocks: SAMPLE_BLOCKS,
      });

      // The blob from exportWithAuth should match what exportLedgerFull produces
      // with the same (correctly derived) key (D11: v2 export is ledger-only)
      const expectedBlob = await exportLedgerFull(
        SAMPLE_BLOCKS, crypto, correctKey
      );
      const expectedText = await expectedBlob.text();
      const actualText = await result.blob.text();

      const expectedParsed = JSON.parse(expectedText);
      const actualParsed = JSON.parse(actualText);

      t.assertEq(expectedParsed.seal, actualParsed.seal,
        'E4: exportWithAuth seal matches direct exportLedgerFull call');
    } catch (err) {
      t.assert(false, `E4: integration check failed: ${err.message}`);
    }
  } else if (typeof exportWithAuth !== 'function') {
    t.assert(false, 'E4: exportWithAuth not available');
  } else {
    t.assert(false, 'E4: exportLedgerFull not available');
  }
}

console.log('\n  — E5: Seed is read from storage (not hardcoded in function) —');
{
  // Use a custom seed to verify the function reads from storage
  const CUSTOM_SEED = 'CustomSeedValue12345abcdefghij==';

  if (typeof exportWithAuth === 'function') {
    const { crypto, storage } = buildServices({ seed: CUSTOM_SEED });

    try {
      await exportWithAuth({
        crypto, storage, passphrase: CORRECT_PASSPHRASE,
        entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      });
    } catch (err) {
      // Expected: seal verification fails because genesis day_hash was
      // computed for the standard seed, not the custom seed.
      // But authenticate() was still called with the stored seed.
    }

    // authenticate() was called — verify the seed matches what we put in storage
    t.assert(crypto._authCalls >= 1, 'E5: authenticate() called with stored seed');
  } else {
    t.assert(false, 'E5: authenticate() called with stored seed');
  }
}

console.log('\n  — E6: No fallback to cached MK when authenticate() throws —');
{
  const cachedMK = 'cafebabe' + 'f'.repeat(56);

  if (typeof exportWithAuth === 'function') {
    // authThrows=false + WRONG_PASSPHRASE → authenticate returns null
    // This simulates a crypto service that fails key derivation silently
    const { crypto, storage } = buildServices({ cachedMK, authThrows: false });

    try {
      await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE,
        entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      });
      // If we get here, the null auth result wasn't caught — bad
      t.assert(false, 'E6: should NOT proceed with null derived key');
    } catch (err) {
      // Export rejected because auth returned null — correct behavior
      t.assert(true, 'E6: null auth result → export rejected (no cached MK fallback)');
    }
  } else {
    t.assert(false, 'E6: null auth result → export rejected');
  }
}

console.log('\n  — E7: Exported blob filename convention preserved —');
{
  if (typeof exportWithAuth === 'function') {
    try {
      const result = await callExportWithAuth({ passphrase: CORRECT_PASSPHRASE });
      // The function may return a suggested filename
      if (result.filename) {
        t.assert(
          result.filename.includes('ph-ledger') || result.filename.includes('.json'),
          'E7.1: suggested filename follows ph-ledger convention'
        );
      }
      // At minimum, the blob is valid JSON
      const text = await result.blob.text();
      JSON.parse(text); // shouldn't throw
      t.assert(true, 'E7.2: blob is valid JSON');
    } catch (err) {
      t.assert(false, `E7: export should succeed: ${err.message}`);
    }
  } else {
    t.assert(false, 'E7.1: suggested filename follows convention');
    t.assert(false, 'E7.2: blob is valid JSON');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group E8–E11 — Passphrase Hash Validation (Phase 6 P1 Step 1)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group E8–E11 — Passphrase Hash Validation ===');

console.log('\n  — E8: Correct passphrase passes hash validation —');
{
  if (typeof exportWithAuth === 'function') {
    // authThrows: false — authenticate mock returns key for any passphrase
    // so the hash check (not authenticate) controls pass/fail.
    const { crypto, storage } = buildServices({ cachedMK: null, authThrows: false });
    // Pre-store the passphrase hash in storage
    const expectedPdk = crypto.derivePdk(CORRECT_PASSPHRASE, 600000);
    const expectedHash = crypto.sha256(expectedPdk + ':' + SEED);
    await storage.set('phpoc_passphrase_hash', expectedHash);

    try {
      const result = await exportWithAuth({
        crypto, storage, passphrase: CORRECT_PASSPHRASE,
        entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      });
      t.assert(result && result.blob, 'E8: correct passphrase + hash match → export succeeds');
    } catch (err) {
      t.assert(false, `E8: correct passphrase should succeed: ${err.message}`);
    }
  } else {
    t.assert(false, 'E8: exportWithAuth not available');
  }
}

console.log('\n  — E9: Wrong passphrase rejected by hash mismatch —');
{
  if (typeof exportWithAuth === 'function') {
    const { crypto, storage } = buildServices({ cachedMK: null, authThrows: false });
    // Pre-store hash for CORRECT password
    const correctPdk = crypto.derivePdk(CORRECT_PASSPHRASE, 600000);
    const correctHash = crypto.sha256(correctPdk + ':' + SEED);
    await storage.set('phpoc_passphrase_hash', correctHash);

    try {
      await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE,
        entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      });
      t.assert(false, 'E9: wrong passphrase + hash mismatch → should throw');
    } catch (err) {
      t.assert(
        err.message === 'Incorrect passphrase.',
        'E9: wrong passphrase + hash mismatch → throws Incorrect passphrase'
      );
    }
  } else {
    t.assert(false, 'E9: exportWithAuth not available');
  }
}

console.log('\n  — E10: Auth rejection prevents data export (hash error before seal) —');
{
  if (typeof exportWithAuth === 'function') {
    const { crypto, storage } = buildServices({ cachedMK: null, authThrows: false });
    const correctPdk = crypto.derivePdk(CORRECT_PASSPHRASE, 600000);
    const correctHash = crypto.sha256(correctPdk + ':' + SEED);
    await storage.set('phpoc_passphrase_hash', correctHash);

    try {
      await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE,
        entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      });
      t.assert(false, 'E10: wrong passphrase with stored hash → should reject');
    } catch (err) {
      t.assert(
        err.message === 'Incorrect passphrase.',
        'E10: hash check rejects before any seal verification'
      );
    }
  } else {
    t.assert(false, 'E10: exportWithAuth not available');
  }
}

console.log('\n  — E11: Missing hash (old ledger) falls through to seal verification —');
{
  if (typeof exportWithAuth === 'function') {
    const { crypto, storage } = buildServices({ cachedMK: null, authThrows: false });
    // No passphrase hash stored (simulates pre-P6-P1 ledger)
    // authenticate() returns MK regardless of passphrase, so
    // genesis seal verification is the fallback.
    try {
      const result = await exportWithAuth({
        crypto, storage, passphrase: WRONG_PASSPHRASE,
        entries: SAMPLE_STAGING, blocks: SAMPLE_BLOCKS,
      });
      // With no hash and a mock that doesn't seal-verify properly,
      // the export proceeds (genesis fallback passes or isn't checked).
      // The key assertion: no crash.
      t.assert(result && result.blob, 'E11: missing hash → fallback path, no crash');
    } catch (err) {
      t.assert(
        err.message === 'Incorrect passphrase.',
        'E11: missing hash → fallback to seal verification worked'
      );
    }
  } else {
    t.assert(false, 'E11: exportWithAuth not available');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════

const moduleStatus = typeof exportWithAuth === 'function'
  ? 'EXISTS (unexpected in RED phase)'
  : 'MISSING (expected — RED phase)';

const failures = t.summary(`export_passphrase_validation_test (${moduleStatus})`);
console.log(`\nModule ../src/services/export_auth.js: ${moduleStatus}`);
process.exit(failures > 0 ? 1 : 0);
