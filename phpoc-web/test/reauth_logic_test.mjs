/**
 * reauth_logic_test.mjs — Re-auth logic unit tests (TDD RED phase).
 *
 * Tests the pure performReauth() function that drives the
 * ReauthOverlay component: derive MK → _reconcileAndClaim → success.
 *
 * Usage:
 *   node test/reauth_logic_test.mjs
 */

import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Mock helpers
// ══════════════════════════════════════════════════════════════════════

function createMockStorage(seed) {
  const store = new Map();
  if (seed) store.set('phpoc_seed', seed);
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, val) => { store.set(key, val); },
    delete: async (key) => { store.delete(key); },
    list: async () => Array.from(store.keys()),
    clear: async () => { store.clear(); },
  };
}

function createMockCrypto({ authenticateShouldThrow = false } = {}) {
  let _mk = null;
  return {
    getMasterKey: () => _mk,
    setMasterKey: (mk) => { _mk = mk; },
    clearMasterKey: () => { _mk = null; },
    hasMasterKey: () => _mk !== null,
    authenticate: (passphrase, seed, iterations) => {
      // Real authenticate is synchronous (WASM call)
      if (authenticateShouldThrow) throw new Error('Invalid passphrase');
      return `mk-${passphrase}-${seed.slice(0, 8)}-${iterations}`;
    },
  };
}

function createMockSync({ reconcileShouldThrow = false } = {}) {
  let reconcileCalls = [];
  return {
    reconcileCalls,
    _reconcileAndClaim: async (mk) => {
      reconcileCalls.push(mk);
      if (reconcileShouldThrow) throw new Error('Reconcile failed: network error');
      return 'READY';
    },
    checkAndSync: async () => 'READY',
  };
}

// ══════════════════════════════════════════════════════════════════════
// performReauth(passphrase, storage, crypto, sync, iterations)
//
// The core re-auth function that the ReauthOverlay calls on submit.
//   1. Reads stored seed from storage
//   2. Derives master key via crypto.authenticate()
//   3. Sets master key on crypto service
//   4. Calls sync._reconcileAndClaim(mk) to pull/merge/push/create cookie
//   5. Returns { success: true } on success
//   6. Throws with user-facing message on failure
// ══════════════════════════════════════════════════════════════════════

// Dynamic import of the module under test
let performReauth;
try {
  const mod = await import('../src/sync/reauth.js');
  performReauth = mod.performReauth;
} catch {
  // RED phase — module doesn't exist yet
  performReauth = null;
}

// ══════════════════════════════════════════════════════════════════════
// Group A: Happy path — successful re-auth
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group A: Happy Path ===');

// A1. Valid passphrase + seed → derive MK → reconcile → success
{
  if (!performReauth) {
    t.assert(false, 'A1. performReauth exists (RED — not yet implemented)');
  } else {
    const storage = createMockStorage('test-seed-abc123');
    const crypto = createMockCrypto();
    const sync = createMockSync();
    const result = await performReauth('correct-pass', storage, crypto, sync, 600000);
    t.assert(result.success === true, 'A1a. returns { success: true }');
    t.assert(crypto.hasMasterKey(), 'A1b. master key is cached after re-auth');
    t.assertEq(sync.reconcileCalls.length, 1, 'A1c. _reconcileAndClaim called exactly once');
    t.assert(
      sync.reconcileCalls[0].startsWith('mk-correct-pass-test-see'),
      'A1d. _reconcileAndClaim called with derived master key'
    );
  }
}

// A2. MK is set on crypto before reconcile
{
  if (!performReauth) {
    t.assert(false, 'A2. MK set before reconcile (RED — not yet implemented)');
  } else {
    const storage = createMockStorage('seed-xyz');
    const crypto = createMockCrypto();
    const sync = createMockSync();
    
    // Track whether setMasterKey was called before _reconcileAndClaim
    const callOrder = [];
    const wrappedSync = {
      reconcileCalls: [],
      _reconcileAndClaim: async (mk) => {
        callOrder.push('reconcile');
        wrappedSync.reconcileCalls.push(mk);
        return 'READY';
      },
    };
    const wrappedCrypto = {
      ...crypto,
      setMasterKey: (mk) => {
        callOrder.push('setMK');
        crypto.setMasterKey(mk);
      },
    };
    
    await performReauth('pass', storage, wrappedCrypto, wrappedSync, 600000);
    t.assertEq(callOrder[0], 'setMK', 'A2a. setMasterKey called before _reconcileAndClaim');
    t.assertEq(callOrder[1], 'reconcile', 'A2b. _reconcileAndClaim called after setMasterKey');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group B: Error paths
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group B: Error Paths ===');

// B1. No seed in storage → throws descriptive error
{
  if (!performReauth) {
    t.assert(false, 'B1. no seed → error (RED — not yet implemented)');
  } else {
    const storage = createMockStorage(null); // No seed
    const crypto = createMockCrypto();
    const sync = createMockSync();
    try {
      await performReauth('pass', storage, crypto, sync, 600000);
      t.assert(false, 'B1a. should throw when no seed in storage');
    } catch (err) {
      t.assert(
        err.message.toLowerCase().includes('seed') || err.message.toLowerCase().includes('recovery'),
        'B1a. error message mentions seed/recovery'
      );
      t.assert(!crypto.hasMasterKey(), 'B1b. MK is NOT cached after failed re-auth');
    }
  }
}

// B2. Wrong passphrase → authenticate throws → error propagated
{
  if (!performReauth) {
    t.assert(false, 'B2. wrong passphrase → error (RED — not yet implemented)');
  } else {
    const storage = createMockStorage('seed-123');
    const crypto = createMockCrypto({ authenticateShouldThrow: true });
    const sync = createMockSync();
    try {
      await performReauth('wrong-pass', storage, crypto, sync, 600000);
      t.assert(false, 'B2a. should throw on wrong passphrase');
    } catch (err) {
      t.assert(
        err.message.toLowerCase().includes('passphrase') || err.message.toLowerCase().includes('auth'),
        'B2a. error message mentions passphrase/auth'
      );
      t.assert(!crypto.hasMasterKey(), 'B2b. MK is NOT cached after failed auth');
      t.assertEq(sync.reconcileCalls.length, 0, 'B2c. _reconcileAndClaim NOT called on auth failure');
    }
  }
}

// B3. Reconcile fails → error propagated, MK cleared
{
  if (!performReauth) {
    t.assert(false, 'B3. reconcile fails → error (RED — not yet implemented)');
  } else {
    const storage = createMockStorage('seed-456');
    const crypto = createMockCrypto();
    const sync = createMockSync({ reconcileShouldThrow: true });
    try {
      await performReauth('pass', storage, crypto, sync, 600000);
      t.assert(false, 'B3a. should throw on reconcile failure');
    } catch (err) {
      t.assert(
        err.message.toLowerCase().includes('sync') || err.message.toLowerCase().includes('network') || err.message.toLowerCase().includes('reconcil'),
        'B3a. error message mentions sync/reconcile/network'
      );
      // MK should be cleared on reconcile failure so the user can retry
      t.assert(!crypto.hasMasterKey(), 'B3b. MK is cleared after failed reconcile');
    }
  }
}

// B4. Empty passphrase → throws before any crypto work
{
  if (!performReauth) {
    t.assert(false, 'B4. empty passphrase → error (RED — not yet implemented)');
  } else {
    const storage = createMockStorage('seed-789');
    const crypto = createMockCrypto();
    const sync = createMockSync();
    try {
      await performReauth('   ', storage, crypto, sync, 600000);
      t.assert(false, 'B4a. should throw on empty passphrase');
    } catch (err) {
      t.assert(
        err.message.toLowerCase().includes('empty') || err.message.toLowerCase().includes('passphrase'),
        'B4a. error message mentions empty/passphrase'
      );
      t.assertEq(sync.reconcileCalls.length, 0, 'B4b. _reconcileAndClaim NOT called for empty passphrase');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group C: State hygiene
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group C: State Hygiene ===');

// C1. Previous MK cleared before setting new one
{
  if (!performReauth) {
    t.assert(false, 'C1. previous MK cleared (RED — not yet implemented)');
  } else {
    const storage = createMockStorage('seed-c1');
    const crypto = createMockCrypto();
    crypto.setMasterKey('stale-old-mk');
    const sync = createMockSync();
    
    t.assert(crypto.hasMasterKey(), 'C1a. stale MK present before re-auth');
    await performReauth('fresh-pass', storage, crypto, sync, 600000);
    const currentMk = crypto.getMasterKey();
    t.assertNeq(currentMk, 'stale-old-mk', 'C1b. stale MK replaced with new derived key');
    t.assert(currentMk.startsWith('mk-fresh-pass'), 'C1c. new MK is from fresh passphrase');
  }
}

// C2. Successful re-auth does NOT clear identity info (unlike logout)
{
  if (!performReauth) {
    t.assert(false, 'C2. identity info preserved (RED — not yet implemented)');
  } else {
    const storage = createMockStorage('seed-c2');
    const crypto = createMockCrypto();
    const sync = createMockSync();
    
    await performReauth('pass', storage, crypto, sync, 600000);
    t.assert(crypto.hasMasterKey(), 'C2a. MK is cached after successful re-auth');
    
    // Verify storage still has the seed (re-auth reads it, doesn't delete it)
    const seed = await storage.get('phpoc_seed');
    t.assert(seed === 'seed-c2', 'C2b. seed preserved in storage after re-auth');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════

console.log(`\nTests: ${t.passed} passed, ${t.failed} failed`);
if (t.errors.length > 0) {
  console.log('Failures:');
  t.errors.forEach((e) => console.log(`  - ${e}`));
}
process.exit(t.failed > 0 ? 1 : 0);
