/**
 * reauth_genesis_mismatch_test.mjs — Stage 1.4: Handle GENESIS_MISMATCH
 * in the re-auth flow (TDD RED phase).
 *
 * Tests:
 *   A. _reconcileAndClaim runs genesis gate and returns GENESIS_MISMATCH
 *   B. performReauth propagates genesis mismatch (non-error)
 *   C. performReauth with compatible genesis — no regression
 *   D. Integration: re-auth → genesis mismatch → context state updated
 *   E. Edge cases: offline, no transport, multiple re-auths
 *
 * Stage 1.5 additions (Group F): performReauth error-path coverage
 *   F1. storage.get('phpoc_seed') throws
 *   F2. crypto.clearMasterKey throws in error handler
 *   F3. genesisCompatible=false with no _remote
 *   F4. Empty seed in storage
 *   F5. performReauth with minimal sync (no _reconcileAndClaim needed)
 *
 * Usage:
 *   node test/reauth_genesis_mismatch_test.mjs
 */

import { createHash } from 'crypto';

import { SyncService, SyncResult } from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { jsonSort } from '../src/ledger/utils.js';
import { selectSealFields } from '../src/ledger/seal_fields.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ── Import performReauth ────────
let performReauth;
try {
  const mod = await import('../src/sync/reauth.js');
  performReauth = mod.performReauth;
} catch {
  // Module not created yet (RED phase)
}
const hasPerformReauth = typeof performReauth === 'function';

// ══════════════════════════════════════════════════════════════════════
// Mock Transport
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    this._store = new Map();
    this._offline = false;
  }

  async pull(path) {
    if (this._offline) throw new Error('Network failure');
    return this._store.get(path) ?? null;
  }

  async push(path, data) {
    if (this._offline) throw new Error('Network failure');
    this._store.set(path, data);
  }

  async delete(path) {
    if (this._offline) throw new Error('Network failure');
    this._store.delete(path);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Crypto — full crypto mock for SyncService
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor() {
    this._mk = null;
    this._uuidCounter = 0;
    this._specCounter = 0;
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

  getDeviceId(mk) {
    return `dev-${(mk || '').slice(0, 8)}`;
  }

  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }
  clearMasterKey() { this._mk = null; }
  hasMasterKey() { return !!this._mk; }

  // For performReauth()
  authenticate(passphrase, seed, iterations) {
    return createHash('sha256')
      .update(`${passphrase}:${seed}:${iterations}`)
      .digest('hex');
  }

  // For staging blob obfuscation
  obfuscateBlob(plaintext, mk) {
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = mk
      ? createHash('sha256').update(mk).digest().slice(0, 4)
      : Buffer.alloc(4);
    const obfuscated = Buffer.concat([keyFingerprint, plainBytes]);
    return obfuscated.toString('base64');
  }

  deobfuscateBlob(b64, mk) {
    try {
      const obfuscated = Buffer.from(b64, 'base64');
      const fingerprint = obfuscated.slice(0, 4);
      if (mk) {
        const expected = createHash('sha256').update(mk).digest().slice(0, 4);
        if (!fingerprint.equals(expected)) {
          throw new Error('key mismatch');
        }
      }
      return obfuscated.slice(4).toString('utf-8');
    } catch (err) {
      if (err.message === 'key mismatch') throw err;
      return b64;
    }
  }

  // For block sealing
  seal(data, mk) {
    return createHash('sha256').update((mk || '0'.repeat(64)) + ':' + data).digest('hex');
  }

  verifySeal(data, sealVal, mk) {
    return this.seal(data, mk) === sealVal;
  }

  sealBlock(blockData) {
    const copy = {};
    for (const [k, v] of Object.entries(blockData)) {
      if (k !== 'day_hash' && k !== 'month_hash' && k !== 'year_hash' && k !== 'signature') {
        copy[k] = v;
      }
    }
    return this.seal(JSON.stringify(copy, Object.keys(copy).sort()), null);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

function makeGenesisBlock(masterKey, overrides = {}) {
  const crypto = new MockCrypto();
  const block = {
    type: 'genesis',
    day_index: 0,
    date: '2026-01-01',
    identity: {
      username: 'testuser',
      email: 'test@example.com',
      recovery_seed_enc: 'enc:mockseed',
      identity_pub_key: 'mockpubkey0000000000000000000000000000000000000000000000000000',
      identity_secret_enc_fallback: 'enc:mocksecret',
    },
    prev_hash: '0'.repeat(64),
    entries: [],
    ...overrides,
  };
  block.block_hash = crypto.seal(jsonSort(selectSealFields(block)), masterKey);
  return block;
}

function makeDayBlock(masterKey, prevBlock, overrides = {}) {
  const crypto = new MockCrypto();
  const block = {
    type: 'day',
    day_index: 1,
    date: '2026-01-02',
    prev_hash: prevBlock.block_hash || prevBlock.day_hash || '',
    entries: [],
    ...overrides,
  };
  block.day_hash = crypto.seal(jsonSort(selectSealFields(block)), masterKey);
  return block;
}

async function setupLocalLedger(storage, masterKey) {
  const genesis = makeGenesisBlock(masterKey);
  const dayBlock = makeDayBlock(masterKey, genesis);
  const chain = [genesis, dayBlock];
  await storage.set('ledger:blocks', chain);
  await storage.set('ledger:index', []);
  return chain;
}

async function setupRemoteLedger(transport, genesis) {
  // Legacy-format path used by GenesisGate._pullRemoteChain fallback.
  const blocks = JSON.stringify([genesis]);
  await transport.push('ledger:blocks', new TextEncoder().encode(blocks));
}

function makeReauthStorage(seed) {
  const backend = new MemoryBackend();
  backend._store.set('phpoc_seed', seed);
  return backend;
}

function makeReauthCrypto() {
  return new MockCrypto();
}

/** Shorthand: SyncService(storage, crypto, transport) */
function makeSync(storage, crypto, transport) {
  return new SyncService(storage, crypto, transport || null);
}

// ══════════════════════════════════════════════════════════════════════
// Group A: _reconcileAndClaim — Genesis Gate Check
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group A: _reconcileAndClaim — Genesis Gate ===');

// A1. Compatible genesis → reconcile proceeds normally, returns READY
{
  console.log('  A1. Compatible genesis → READY');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const mk = 'a'.repeat(64);
  crypto.setMasterKey(mk);

  const chain = await setupLocalLedger(storage, mk);
  await setupRemoteLedger(transport, chain[0]);

  const sync = makeSync(storage, crypto, transport);

  const blob = [{ id: 'e1', title: 'task' }];
  await transport.push(
    'staging/blob',
    new TextEncoder().encode(JSON.stringify(blob))
  );

  const result = await sync._reconcileAndClaim(mk);
  t.assertEq(result, SyncResult.READY, 'A1a. compatible genesis → READY');
  t.assertEq(sync.genesisCompatible, true, 'A1b. genesisCompatible cached as true');
}

// A2. Mismatched genesis → _reconcileAndClaim returns GENESIS_MISMATCH
{
  console.log('  A2. Mismatched genesis → GENESIS_MISMATCH');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const localMk = 'a'.repeat(64);
  const remoteMk = 'b'.repeat(64);
  crypto.setMasterKey(localMk);

  await setupLocalLedger(storage, localMk);
  const remoteGenesis = makeGenesisBlock(localMk, { date: '1970-01-01' });
  await setupRemoteLedger(transport, remoteGenesis);

  const sync = makeSync(storage, crypto, transport);

  const result = await sync._reconcileAndClaim(localMk);
  t.assertEq(result, SyncResult.GENESIS_MISMATCH, 'A2a. mismatched genesis → GENESIS_MISMATCH');
  t.assertEq(sync.genesisCompatible, false, 'A2b. genesisCompatible cached as false');
}

// A3. No local ledger blocks → genesis gate returns null (skipped), reconcile proceeds
{
  console.log('  A3. No local blocks → genesis skipped → READY');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const mk = 'a'.repeat(64);
  crypto.setMasterKey(mk);

  const sync = makeSync(storage, crypto, transport);

  const result = await sync._reconcileAndClaim(mk);
  t.assertEq(result, SyncResult.READY, 'A3a. no local blocks → reconcile proceeds');
  t.assertEq(sync.genesisCompatible, null, 'A3b. genesisCompatible stays null (unchecked)');
}

// A4. Previously cached compatible → no duplicate genesis check
{
  console.log('  A4. Cached compatible → no re-check');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const mk = 'a'.repeat(64);
  crypto.setMasterKey(mk);

  const chain = await setupLocalLedger(storage, mk);
  await setupRemoteLedger(transport, chain[0]);

  const sync = makeSync(storage, crypto, transport);
  sync._genesisCompatible = true;

  const result = await sync._reconcileAndClaim(mk);
  t.assertEq(result, SyncResult.READY, 'A4a. cached compatible → READY');
}

// A5. Previously cached incompatible → immediate GENESIS_MISMATCH
{
  console.log('  A5. Cached incompatible → immediate GENESIS_MISMATCH');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const mk = 'a'.repeat(64);
  crypto.setMasterKey(mk);

  const sync = makeSync(storage, crypto, transport);
  sync._genesisCompatible = false;

  const result = await sync._reconcileAndClaim(mk);
  t.assertEq(result, SyncResult.GENESIS_MISMATCH, 'A5a. cached mismatch → GENESIS_MISMATCH');
}

// A6. Genesis check before any reconcile work (ordering)
{
  console.log('  A6. Genesis check runs before reconcile operations');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const localMk = 'a'.repeat(64);
  crypto.setMasterKey(localMk);

  await setupLocalLedger(storage, localMk);
  const remoteGenesis = makeGenesisBlock(localMk, { date: '1970-01-01' });
  await setupRemoteLedger(transport, remoteGenesis);

  const blob = [{ id: 'e6', title: 'should not be pulled' }];
  await transport.push(
    'staging/blob',
    new TextEncoder().encode(JSON.stringify(blob))
  );

  const sync = makeSync(storage, crypto, transport);

  const result = await sync._reconcileAndClaim(localMk);
  t.assertEq(result, SyncResult.GENESIS_MISMATCH, 'A6a. genesis check short-circuits before blob ops');

  const localStaging = await storage.get('entries');
  t.assertEq(localStaging, undefined, 'A6b. local staging untouched (no merge happened)');
}

// ══════════════════════════════════════════════════════════════════════
// Group B: performReauth — Genesis Mismatch Propagation
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group B: performReauth — Genesis Mismatch Propagation ===');

// B1. Compatible genesis → returns { success: true, genesisMismatch: false }
{
  console.log('  B1. Compatible genesis → success');
  if (!hasPerformReauth) {
    t.assert(false, 'B1. performReauth not imported (RED)');
  } else {
    const mk = 'a'.repeat(64);
    const storage = makeReauthStorage('test-seed-b1');
    const crypto = makeReauthCrypto();

    const transport = new MockTransport();
    const backend = new MemoryBackend();
    const chain = await setupLocalLedger(backend, mk);
    await setupRemoteLedger(transport, chain[0]);

    const sync = makeSync(backend, crypto, transport);

    const result = await performReauth('pass', storage, crypto, sync, 600000);
    t.assert(result.success === true, 'B1a. success flag set');
    t.assertEq(result.genesisMismatch, false, 'B1b. genesisMismatch is false');
  }
}

// B2. Mismatched genesis → returns { success: true, genesisMismatch: true }
{
  console.log('  B2. Mismatched genesis → genesisMismatch flag');
  if (!hasPerformReauth) {
    t.assert(false, 'B2. performReauth not imported (RED)');
  } else {
    const localMk = 'a'.repeat(64);
    const remoteMk = 'b'.repeat(64);
    const storage = makeReauthStorage('test-seed-b2');
    const crypto = makeReauthCrypto();

    const transport = new MockTransport();
    const backend = new MemoryBackend();
    await setupLocalLedger(backend, localMk);
    const remoteGenesis = makeGenesisBlock(localMk, { date: '1970-01-01' });
    await setupRemoteLedger(transport, remoteGenesis);

    const sync = makeSync(backend, crypto, transport);

    const result = await performReauth('pass', storage, crypto, sync, 600000);
    t.assert(result.success === true, 'B2a. re-auth succeeded (not an error)');
    t.assertEq(result.genesisMismatch, true, 'B2b. genesisMismatch flag is true');
    t.assert(crypto.hasMasterKey(), 'B2c. MK is still cached (genesis mismatch is not auth failure)');
  }
}

// B3. Genesis mismatch → MK NOT cleared (unlike auth failure)
{
  console.log('  B3. Genesis mismatch → MK preserved');
  if (!hasPerformReauth) {
    t.assert(false, 'B3. performReauth not imported (RED)');
  } else {
    const localMk = 'a'.repeat(64);
    const storage = makeReauthStorage('test-seed-b3');
    const crypto = makeReauthCrypto();

    const transport = new MockTransport();
    const backend = new MemoryBackend();
    await setupLocalLedger(backend, localMk);
    const remoteGenesis = makeGenesisBlock(localMk, { date: '1970-01-01' });
    await setupRemoteLedger(transport, remoteGenesis);

    const sync = makeSync(backend, crypto, transport);

    const result = await performReauth('pass', storage, crypto, sync, 600000);
    t.assertEq(result.genesisMismatch, true, 'B3a. genesis mismatch detected');
    t.assert(crypto.hasMasterKey(), 'B3b. MK preserved (genesis mismatch ≠ auth failure)');
    t.assert(crypto.getMasterKey().length === 64, 'B3c. MK is valid 64-char hex');
  }
}

// B4. Wrong passphrase → throws (no genesisMismatch in error path)
{
  console.log('  B4. Wrong passphrase → throws');
  if (!hasPerformReauth) {
    t.assert(false, 'B4. performReauth not imported (RED)');
  } else {
    const storage = makeReauthStorage('test-seed-b4');
    const crypto = new MockCrypto();

    const badCrypto = {
      ...crypto,
      authenticate: () => { throw new Error('Invalid passphrase'); },
      clearMasterKey() {},
      setMasterKey() {},
      getMasterKey() { return null; },
    };
    const sync = makeSync(new MemoryBackend(), crypto, null);

    try {
      await performReauth('wrong-pass', storage, badCrypto, sync, 600000);
      t.assert(false, 'B4a. should throw on wrong passphrase');
    } catch (err) {
      t.assert(
        err.message.toLowerCase().includes('auth') || err.message.toLowerCase().includes('passphrase'),
        'B4a. error message mentions auth/passphrase'
      );
    }
  }
}

// B5. Empty passphrase → throws before any work
{
  console.log('  B5. Empty passphrase → throws');
  if (!hasPerformReauth) {
    t.assert(false, 'B5. performReauth not imported (RED)');
  } else {
    const storage = makeReauthStorage('test-seed-b5');
    const crypto = makeReauthCrypto();
    const sync = makeSync(new MemoryBackend(), crypto, null);

    try {
      await performReauth('   ', storage, crypto, sync, 600000);
      t.assert(false, 'B5a. should throw on empty passphrase');
    } catch (err) {
      t.assert(
        err.message.toLowerCase().includes('empty') || err.message.toLowerCase().includes('passphrase'),
        'B5a. error mentions empty/passphrase'
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group C: performReauth — No Regression
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group C: performReauth — No Regression ===');

// C1. Normal re-auth (no genesis check needed) → success
{
  console.log('  C1. Normal re-auth → success');
  if (!hasPerformReauth) {
    t.assert(false, 'C1. performReauth not imported (RED)');
  } else {
    const storage = makeReauthStorage('test-seed-c1');
    const crypto = makeReauthCrypto();
    const sync = makeSync(new MemoryBackend(), crypto, null);

    const result = await performReauth('pass', storage, crypto, sync, 600000);
    t.assert(result.success === true, 'C1a. success');
    t.assertEq(result.genesisMismatch, false, 'C1b. no genesis mismatch when no blocks');
    t.assert(crypto.hasMasterKey(), 'C1c. MK cached');
  }
}

// C2. Re-auth preserves seed in storage (doesn't delete it)
{
  console.log('  C2. Seed preserved after re-auth');
  if (!hasPerformReauth) {
    t.assert(false, 'C2. performReauth not imported (RED)');
  } else {
    const storage = makeReauthStorage('test-seed-c2');
    const crypto = makeReauthCrypto();
    const sync = makeSync(new MemoryBackend(), crypto, null);

    await performReauth('pass', storage, crypto, sync, 600000);
    const seed = await storage.get('phpoc_seed');
    t.assertEq(seed, 'test-seed-c2', 'C2a. seed preserved after successful re-auth');
  }
}

// C3. Re-auth → _reconcileAndClaim called exactly once
{
  console.log('  C3. _reconcileAndClaim called once');
  if (!hasPerformReauth) {
    t.assert(false, 'C3. performReauth not imported (RED)');
  } else {
    const storage = makeReauthStorage('test-seed-c3');
    const crypto = makeReauthCrypto();
    let reconcileCalls = 0;
    const sync = {
      _reconcileAndClaim: async () => { reconcileCalls++; return SyncResult.READY; },
    };

    await performReauth('pass', storage, crypto, sync, 600000);
    t.assertEq(reconcileCalls, 1, 'C3a. _reconcileAndClaim called exactly once');
  }
}

// C4. Re-auth with reconcile failure → throws
{
  console.log('  C4. Reconcile failure → throws');
  if (!hasPerformReauth) {
    t.assert(false, 'C4. performReauth not imported (RED)');
  } else {
    const storage = makeReauthStorage('test-seed-c4');
    const crypto = makeReauthCrypto();
    const sync = {
      _reconcileAndClaim: async () => { throw new Error('Network error'); },
    };

    try {
      await performReauth('pass', storage, crypto, sync, 600000);
      t.assert(false, 'C4a. should throw on reconcile failure');
    } catch (err) {
      t.assert(
        err.message.toLowerCase().includes('sync') || err.message.toLowerCase().includes('network'),
        'C4a. error mentions sync/network'
      );
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group D: Integration — re-auth → genesis mismatch flow
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group D: Integration — Full Re-auth Flow ===');

// D1. Complete flow: checkAndSync → GENESIS_MISMATCH → _reconcileAndClaim also returns it
{
  console.log('  D1. checkAndSync → GENESIS_MISMATCH → _reconcileAndClaim consistent');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const localMk = 'a'.repeat(64);
  crypto.setMasterKey(localMk);

  await setupLocalLedger(storage, localMk);
  const remoteGenesis = makeGenesisBlock(localMk, { date: '1970-01-01' });
  await setupRemoteLedger(transport, remoteGenesis);

  const sync = makeSync(storage, crypto, transport);

  const checkResult = await sync.checkAndSync();
  t.assertEq(checkResult, SyncResult.GENESIS_MISMATCH, 'D1a. checkAndSync → GENESIS_MISMATCH');

  const result = await sync._reconcileAndClaim(localMk);
  t.assertEq(result, SyncResult.GENESIS_MISMATCH, 'D1b. _reconcileAndClaim → GENESIS_MISMATCH');
}

// D2. After clearing genesis mismatch cache, new reconcile still detects it
{
  console.log('  D2. Reset cache → re-detect');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const localMk = 'a'.repeat(64);
  const remoteMk = 'b'.repeat(64);
  crypto.setMasterKey(localMk);

  await setupLocalLedger(storage, localMk);
  const remoteGenesis = makeGenesisBlock(localMk, { date: '1970-01-01' });
  await setupRemoteLedger(transport, remoteGenesis);

  const sync = makeSync(storage, crypto, transport);

  const r1 = await sync._reconcileAndClaim(localMk);
  t.assertEq(r1, SyncResult.GENESIS_MISMATCH, 'D2a. first call → GENESIS_MISMATCH');

  sync.resetGenesisGate();
  t.assertEq(sync.genesisCompatible, null, 'D2b. cache reset to null');

  const r2 = await sync._reconcileAndClaim(localMk);
  t.assertEq(r2, SyncResult.GENESIS_MISMATCH, 'D2c. second call → GENESIS_MISMATCH (re-detected)');
}

// D3. Genesis mismatch → clear remote → re-check → compatible
{
  console.log('  D3. Clear remote → re-check → compatible');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  const crypto = new MockCrypto();
  const mk = 'a'.repeat(64);
  crypto.setMasterKey(mk);

  const chain = await setupLocalLedger(storage, mk);
  const remoteGenesis = makeGenesisBlock(mk, { date: '1970-01-01' });
  await setupRemoteLedger(transport, remoteGenesis);

  const sync = makeSync(storage, crypto, transport);

  const r1 = await sync._reconcileAndClaim(mk);
  t.assertEq(r1, SyncResult.GENESIS_MISMATCH, 'D3a. mismatch detected');

  await transport.delete('ledger:blocks');
  sync.resetGenesisGate();
  await setupRemoteLedger(transport, chain[0]);

  const r2 = await sync._reconcileAndClaim(mk);
  t.assertNeq(r2, SyncResult.GENESIS_MISMATCH, 'D3b. after clear, no longer mismatch');
  t.assertEq(sync.genesisCompatible, true, 'D3c. genesisCompatible is true');
}

// ══════════════════════════════════════════════════════════════════════
// Group E: Edge Cases
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group E: Edge Cases ===');

// E1. No transport → _reconcileAndClaim skips genesis (local-only)
{
  console.log('  E1. No transport → local reconcile OK');
  const storage = new MemoryBackend();
  const crypto = new MockCrypto();
  const mk = 'a'.repeat(64);
  crypto.setMasterKey(mk);

  await setupLocalLedger(storage, mk);

  const sync = makeSync(storage, crypto, null);
  const result = await sync._reconcileAndClaim(mk);
  t.assertNeq(result, SyncResult.GENESIS_MISMATCH, 'E1a. no transport → no genesis mismatch');
  t.assertEq(sync.genesisCompatible, null, 'E1b. genesis not checked (no remote)');
}

// E2. Transport offline during genesis check → falls through (transient)
{
  console.log('  E2. Offline during genesis check → falls through');
  const storage = new MemoryBackend();
  const transport = new MockTransport();
  transport._offline = true;
  const crypto = new MockCrypto();
  const mk = 'a'.repeat(64);
  crypto.setMasterKey(mk);

  await setupLocalLedger(storage, mk);

  const sync = makeSync(storage, crypto, transport);
  const result = await sync._reconcileAndClaim(mk);
  t.assertEq(result, SyncResult.OFFLINE, 'E2a. offline transport → OFFLINE from reconcile');
}

// E3. Multiple sequential re-auths with same mismatch → consistent
{
  console.log('  E3. Multiple re-auths → consistent mismatch');
  if (!hasPerformReauth) {
    t.assert(false, 'E3. performReauth not imported (RED)');
  } else {
    const localMk = 'a'.repeat(64);
    const remoteMk = 'b'.repeat(64);
    const storage = makeReauthStorage('test-seed-e3');
    const crypto = makeReauthCrypto();

    const transport = new MockTransport();
    const backend = new MemoryBackend();
    await setupLocalLedger(backend, localMk);
    const remoteGenesis = makeGenesisBlock(localMk, { date: '1970-01-01' });
    await setupRemoteLedger(transport, remoteGenesis);

    const sync = makeSync(backend, crypto, transport);

    const r1 = await performReauth('pass', storage, crypto, sync, 600000);
    t.assertEq(r1.genesisMismatch, true, 'E3a. first re-auth → mismatch');

    const storage2 = makeReauthStorage('test-seed-e3b');
    const r2 = await performReauth('pass', storage2, crypto, sync, 600000);
    t.assertEq(r2.genesisMismatch, true, 'E3b. second re-auth → same mismatch (consistent)');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group F: Stage 1.5 — performReauth Error-Path Coverage
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group F: performReauth Error-Path Coverage (Stage 1.5) ===');

// F1. storage.get('phpoc_seed') throws → error message mentions "corrupted"
{
  console.log('  F1. Storage read error → corrupted message');
  if (!hasPerformReauth) {
    t.assert(false, 'F1. performReauth not imported (RED)');
  } else {
    const storage = {
      get: async () => { throw new Error('IndexedDB transaction error'); },
    };
    const crypto = makeReauthCrypto();
    const sync = makeSync(new MemoryBackend(), crypto, null);

    try {
      await performReauth('pass', storage, crypto, sync, 600000);
      t.assert(false, 'F1a. should throw on storage read error');
    } catch (err) {
      t.assert(
        err.message.toLowerCase().includes('corrupted'),
        'F1a. error message mentions corrupted'
      );
    }
  }
}

// F2. crypto.clearMasterKey throws in error handler → original error still propagates
{
  console.log('  F2. clearMasterKey throws in catch → original error preserved');
  if (!hasPerformReauth) {
    t.assert(false, 'F2. performReauth not imported (RED)');
  } else {
    const storage = makeReauthStorage('test-seed-f2');
    const crypto = makeReauthCrypto();
    let clearCallCount = 0;
    crypto.clearMasterKey = () => {
      clearCallCount++;
      if (clearCallCount > 1) throw new Error('clearMasterKey failed');
      crypto._mk = null;
    };

    const sync = {
      _reconcileAndClaim: async () => {
        throw new Error('Simulated reconcile failure');
      },
    };

    try {
      await performReauth('pass', storage, crypto, sync, 600000);
      t.assert(false, 'F2a. should throw on reconcile failure');
    } catch (err) {
      // The outer error (reconcile failure) should take priority
      t.assert(
        err.message.toLowerCase().includes('sync'),
        'F2a. outer error message preserved (sync, not clearMasterKey)'
      );
    }
  }
}

// F3. genesisCompatible=false with no _remote → still returns GENESIS_MISMATCH
{
  console.log('  F3. Cached mismatch + no transport → GENESIS_MISMATCH');
  const storage = new MemoryBackend();
  const crypto = new MockCrypto();
  const mk = 'a'.repeat(64);
  crypto.setMasterKey(mk);

  // Set up local ledger so we can set the cache
  await setupLocalLedger(storage, mk);

  const sync = makeSync(storage, crypto, null);
  sync._genesisCompatible = false;

  // The cache check happens before _remote check, so
  // even without a transport, cached mismatch returns GENESIS_MISMATCH
  const result = await sync._reconcileAndClaim(mk);
  t.assertEq(result, SyncResult.GENESIS_MISMATCH,
    'F3a. cached mismatch without remote → GENESIS_MISMATCH');
}

// F4. Empty seed stored → error message
{
  console.log('  F4. Empty seed → clear error');
  if (!hasPerformReauth) {
    t.assert(false, 'F4. performReauth not imported (RED)');
  } else {
    const storage = {
      get: async (key) => key === 'phpoc_seed' ? '' : null,
    };
    const crypto = makeReauthCrypto();
    const sync = makeSync(new MemoryBackend(), crypto, null);

    try {
      await performReauth('pass', storage, crypto, sync, 600000);
      t.assert(false, 'F4a. should throw on empty seed');
    } catch (err) {
      t.assert(
        err.message.toLowerCase().includes('seed') || err.message.toLowerCase().includes('recovery'),
        'F4a. error message mentions seed/recovery'
      );
    }
  }
}

// F5. performReauth with minimal sync object (fake) → still works
{
  console.log('  F5. Minimal sync mock → works');
  if (!hasPerformReauth) {
    t.assert(false, 'F5. performReauth not imported (RED)');
  } else {
    const storage = makeReauthStorage('test-seed-f5');
    const crypto = makeReauthCrypto();
    let reconcileCalled = false;
    const sync = {
      _reconcileAndClaim: async () => { reconcileCalled = true; return SyncResult.READY; },
    };

    const result = await performReauth('pass', storage, crypto, sync, 600000);
    t.assert(result.success === true, 'F5a. success');
    t.assertEq(result.genesisMismatch, false, 'F5b. no mismatch');
    t.assertEq(reconcileCalled, true, 'F5c. reconcile called');
    t.assert(crypto.hasMasterKey(), 'F5d. MK cached');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════

const failures = t.summary('reauth_genesis_mismatch_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
