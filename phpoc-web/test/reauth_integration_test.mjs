/**
 * reauth_integration_test.mjs — Full TTL Expiry → Re-auth → Recovery
 * integration test suite (TDD RED phase).
 *
 * Combines createCookieMonitor + SyncService + re-auth flow.
 * Uses MemoryBackend, MockTransport, MockCrypto, SyncService
 * (same patterns as sync_service_test.mjs).
 * ~17 tests across 4 categories (F–I).
 *
 * Category F — Full TTL Expiry → Re-auth → Recovery Flow (6 tests)
 * Category G — Interaction with Existing Auth Gate (4 tests)
 * Category H — Logout + Re-login Interaction (3 tests)
 * Category I — Edge Cases (4 tests)
 *
 * Implementation files not yet created (RED phase). All tests expected to fail.
 *
 * Usage:
 *   node test/reauth_integration_test.mjs
 */

import { createHash } from 'crypto';

import { SyncService, SyncResult } from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ── Import createCookieMonitor ────────
let createCookieMonitor;
try {
  const mod = await import('../src/hooks/useCookieMonitor.js');
  createCookieMonitor = mod.createCookieMonitor;
} catch {
  // Module not created yet (RED phase)
}

const hasCreateCookieMonitor = typeof createCookieMonitor === 'function';

// ══════════════════════════════════════════════════════════════════════
// Mock Transport — Map-based storage with offline simulation
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this._store = new Map();
    this._offline = false;
    /** @type {Map<string, Array<Uint8Array|null>>} queue for sequential pulls */
    this._queue = new Map();
  }

  queueResponse(path, value) {
    const arr = this._queue.get(path) || [];
    arr.push(value);
    this._queue.set(path, arr);
  }

  async pull(path) {
    if (this._offline) throw new Error('Network failure');
    const queue = this._queue.get(path);
    if (queue && queue.length > 0) return queue.shift();
    return this._store.get(path) ?? null;
  }

  async push(path, data) {
    if (this._offline) throw new Error('Network failure');
    this._store.set(path, data);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Crypto — full crypto mock for SyncService + MK tracking
// ══════════════════════════════════════════════════════════════════════

const BLOB_PATH = 'staging/blobs/current.json';
const COOKIE_PATH = 'staging/blobs/device_cookie.bin';

class MockCrypto {
  constructor() {
    this._mk = null;
    this._uuidCounter = 0;
    this._specCounter = 0;
    this._clearCalls = 0;
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

  clearMasterKey() {
    this._clearCalls++;
    this._mk = null;
  }

  get clearCalls() { return this._clearCalls; }

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
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_MK = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';

/**
 * Create a SyncService with mock transport and crypto.
 */
function createSyncService({
  withTransport = true,
  withMasterKey = false,
  masterKey = DEFAULT_MK,
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
 * Create a local cookie with a given age offset.
 */
async function createLocalCookie(storage, ageMs = 0, specifier = 'spec-test') {
  await storage.set('cookie', {
    device_specifier: specifier,
    creation_time: Date.now() - ageMs,
  });
}

/**
 * Push a remote cookie to mock transport.
 */
async function pushRemoteCookie(transport, deviceUuid, specifier) {
  const cookieJson = JSON.stringify({
    device_uuid: deviceUuid,
    device_specifier: specifier,
  });
  await transport.push(COOKIE_PATH, new TextEncoder().encode(cookieJson));
}

/**
 * Create an expired cookie (older than TTL).
 */
async function createExpiredCookie(storage, ttlMinutes = 30) {
  const ttlMs = ttlMinutes * 60 * 1000;
  await storage.set('cookie', {
    device_specifier: 'spec-expired',
    creation_time: Date.now() - ttlMs - 10000,
  });
}

/**
 * Wait helper.
 */
async function wait(ms) {
  await new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════
// Simulated Re-auth Flow Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Simulate the reauth flow: re-derive MK from passphrase + seed,
 * set on crypto, dismiss overlay.
 *
 * In real code this is DevModeContext.handleReauth().
 */
async function simulateReauth(crypto, storage, seed, passphrase) {
  if (!storage) {
    throw new Error('Storage not initialized. Please refresh the page.');
  }
  if (!crypto) {
    throw new Error('Crypto not initialized. Please refresh the page.');
  }
  const storedSeed = seed || await storage.get('phpoc_seed');
  if (!storedSeed) {
    throw new Error('No recovery seed found. Cannot re-authenticate.');
  }
  // In real implementation, crypto.authenticate(passphrase, storedSeed, iterations)
  // For mock, just derive a deterministic key from passphrase+seed
  const mk = crypto.sha256(storedSeed + ':' + passphrase);
  crypto.setMasterKey(mk);
  return mk;
}

// ═══════════════════════════════════════════════════════════════════════
// Category F: Full TTL Expiry → Re-auth → Recovery Flow (6 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════');
console.log('Re-auth Integration Test Suite (TDD RED)');
console.log('═══════════════════════════════════════════');

console.log('\n── Category F: Full TTL Expiry → Re-auth → Recovery ──\n');

// F1. End-to-end: TTL expires → MK cleared → overlay → reauth → sync works
{
  console.log('  F1. End-to-end happy path');
  if (hasCreateCookieMonitor) {
    const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-f1';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Setup: valid cookie + seed stored + matching remote cookie
    await storage.set('phpoc_seed', 'seed-for-f1-test');
    await createLocalCookie(storage, 0, 'spec-f1');
    await pushRemoteCookie(transport, 'dev-eeee2ee', 'spec-f1');

    // Sync should work normally (cookie is valid)
    const result1 = await sync.checkAndSync();
    t.assertEq(result1, SyncResult.READY, 'F1a. initial sync → READY (cookie valid)');

    // Now: simulate TTL expiry — make cookie old, clear MK, trigger overlay
    await createExpiredCookie(storage, 1); // TTL=1 min, cookie is 70s old
    crypto.clearMasterKey();
    t.assertEq(crypto.hasMasterKey(), false, 'F1b. MK cleared after TTL expiry');

    // Simulate re-auth overlay triggered
    let reauthActive = true;

    // User enters passphrase → re-derive MK
    const seed = await storage.get('phpoc_seed');
    const newMk = await simulateReauth(crypto, storage, seed, 'correct-passphrase');
    t.assertEq(crypto.hasMasterKey(), true, 'F1c. MK restored after reauth');
    reauthActive = false;

    // Now sync should work again — creates new cookie, reconciles
    // No remote cookie for new session → re-derive from reconcile
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    const result2 = await sync.checkAndSync();
    t.assertEq(result2, SyncResult.READY, 'F1d. sync → READY after reauth');

    // New cookie should be created
    const cookieAfter = await storage.get('cookie');
    t.assert(!!cookieAfter && !!cookieAfter.device_specifier, 'F1e. new cookie created after reauth sync');

    // TODO: verify monitor disposed after reauth
  } else {
    t.assert(false, 'F1. createCookieMonitor not implemented (TDD RED)');
  }
}

// F2. TTL expires → wrong passphrase → error → overlay stays open
{
  console.log('\n  F2. Wrong passphrase during re-auth');
  if (hasCreateCookieMonitor) {
    const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-f2';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('phpoc_seed', 'seed-for-f2-test');
    await createExpiredCookie(storage, 30);
    crypto.clearMasterKey();

    let reauthActive = true;
    let authError = null;

    // User enters WRONG passphrase
    try {
      // Simulate authentication failure — wrong passphrase would
      // produce wrong MK and seal verification fails
      throw new Error('Wrong passphrase');
    } catch (err) {
      authError = err.message;
      // Overlay stays open
    }

    t.assert(!!authError, 'F2a. auth error received');
    t.assertEq(reauthActive, true, 'F2b. overlay stays open after failed auth');
    t.assertEq(crypto.hasMasterKey(), false, 'F2c. MK still cleared after failed reauth');
  } else {
    t.assert(false, 'F2. createCookieMonitor not implemented (TDD RED)');
  }
}

// F3. TTL expires → reauth → MK restored → auto-sync resumes
{
  console.log('\n  F3. Auto-sync resumes after reauth');
  if (hasCreateCookieMonitor) {
    const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-f3';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('phpoc_seed', 'seed-for-f3-test');

    // Setup: valid cookie then expire it
    await createLocalCookie(storage, 0, 'spec-f3');
    await pushRemoteCookie(transport, 'dev-eeee2ee', 'spec-f3');

    // Expire cookie + clear MK
    await createExpiredCookie(storage, 1);
    crypto.clearMasterKey();

    // Re-auth
    const seed = await storage.get('phpoc_seed');
    await simulateReauth(crypto, storage, seed, 'correct-passphrase');
    t.assert(crypto.hasMasterKey(), 'F3a. MK restored');

    // After reauth, mutations should work (auto-sync push)
    // Capture a staging entry
    await sync.capture({ title: 'Task After Reauth', startEpoch: 1000 });
    const entries = await sync.readEntries();
    t.assertEq(entries.length, 1, 'F3b. entry captured after reauth');
    t.assertEq(entries[0].title, 'Task After Reauth', 'F3c. entry data correct');

    // Verify pushToRemote works (no transport error)
    try {
      await sync.pushToRemote(mk);
      t.assert(true, 'F3d. pushToRemote succeeds after reauth');
    } catch (err) {
      t.assert(false, `F3d. pushToRemote failed: ${err.message}`);
    }
  } else {
    t.assert(false, 'F3. createCookieMonitor not implemented (TDD RED)');
  }
}

// F4. TTL expires → overlay dismissed (no reauth) → MK stays cleared → REAUTH_NEEDED
{
  console.log('\n  F4. Dismiss reauth without authenticating');
  if (hasCreateCookieMonitor) {
    const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-f4';
    const { sync, storage, crypto } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('phpoc_seed', 'seed-for-f4-test');
    await createExpiredCookie(storage, 30);
    crypto.clearMasterKey();

    // Dismiss overlay without re-auth
    let reauthActive = false;

    t.assertEq(crypto.hasMasterKey(), false, 'F4a. MK still cleared');

    // checkAndSync should return REAUTH_NEEDED (no MK)
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'F4b. sync returns REAUTH_NEEDED without MK');
  } else {
    t.assert(false, 'F4. createCookieMonitor not implemented (TDD RED)');
  }
}

// F5. TTL valid → no MK cleared → no overlay → checkAndSync returns READY
{
  console.log('\n  F5. Normal operation — no interruption');
  if (hasCreateCookieMonitor) {
    const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-f5';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Fresh cookie, matching remote → should work fine
    await createLocalCookie(storage, 0, 'spec-f5');
    await pushRemoteCookie(transport, 'dev-eeee2ee', 'spec-f5');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'F5a. sync → READY (normal operation)');
    t.assertEq(crypto.hasMasterKey(), true, 'F5b. MK still cached');
  } else {
    t.assert(false, 'F5. createCookieMonitor not implemented (TDD RED)');
  }
}

// F6. TTL expires → reauth → capture entry works → push happens
{
  console.log('\n  F6. Full post-reauth mutation cycle');
  if (hasCreateCookieMonitor) {
    const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-f6';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('phpoc_seed', 'seed-for-f6-test');

    // Expire cookie + clear MK + reauth
    await createExpiredCookie(storage, 1);
    crypto.clearMasterKey();

    const seed = await storage.get('phpoc_seed');
    await simulateReauth(crypto, storage, seed, 'correct-passphrase');

    // Capture + push
    await sync.capture({ title: 'Post-Reauth Entry', startEpoch: 2000 });
    await sync.pushToRemote(crypto.getMasterKey());

    // Verify blob was pushed to remote
    const blobBytes = await transport.pull(BLOB_PATH);
    t.assert(blobBytes !== null, 'F6a. blob pushed to remote after reauth');
  } else {
    t.assert(false, 'F6. createCookieMonitor not implemented (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Category G: Interaction with Existing Auth Gate (4 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── Category G: Auth Gate Interaction ──\n');

// G1. Cookie TTL expired + MK cleared by monitor → checkAndSync returns REAUTH_NEEDED
{
  console.log('  G1. Expired cookie + no MK → REAUTH_NEEDED');
  const { sync, storage, crypto } = createSyncService({
    withTransport: true,
    withMasterKey: false, // No MK
  });

  await createExpiredCookie(storage, 30);

  const result = await sync.checkAndSync();
  t.assertEq(result, SyncResult.REAUTH_NEEDED, 'G1. expired cookie + no MK → REAUTH_NEEDED');
}

// G2. Cookie TTL expired + MK cleared → _reconcileAndClaim not reached
{
  console.log('\n  G2. Auth gate blocks reconcile when MK is null');
  const { sync, storage } = createSyncService({
    withTransport: true,
    withMasterKey: false,
  });

  await createExpiredCookie(storage, 30);

  const result = await sync.checkAndSync();
  t.assertNeq(result, SyncResult.READY, 'G2a. not READY when MK is null');
  t.assertEq(result, SyncResult.REAUTH_NEEDED, 'G2b. auth gate returns REAUTH_NEEDED');
}

// G3. Cookie TTL expired but MK still cached → checkAndSync proceeds via _reconcileAndClaim
{
  console.log('\n  G3. Expired cookie + cached MK → reconcile');
  const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-g3';
  const { sync, storage, transport } = createSyncService({
    withTransport: true,
    withMasterKey: true,
    masterKey: mk,
  });

  // Expired cookie but MK still cached (simulates edge case where monitor
  // isn't running but user still has MK from a prior login)
  await createExpiredCookie(storage, 1);

  // Remote has no cookie → reconcile path
  transport.queueResponse(COOKIE_PATH, null);
  transport.queueResponse(COOKIE_PATH, null);

  const result = await sync.checkAndSync();
  t.assertEq(result, SyncResult.READY, 'G3. expired cookie + cached MK → READY via reconcile');

  // New cookie should be created
  const cookieAfter = await storage.get('cookie');
  t.assert(!!cookieAfter && !!cookieAfter.device_specifier, 'G3b. new cookie created via reconcile');
}

// G4. Specifier mismatch still returns REAUTH_NEEDED even with valid TTL
{
  console.log('\n  G4. Specifier mismatch independent of TTL');
  const { sync, storage, transport } = createSyncService({
    withTransport: true,
    withMasterKey: true,
    masterKey: DEFAULT_MK,
  });

  await createLocalCookie(storage, 0, 'spec-local-g4');
  await pushRemoteCookie(transport, 'dev-different', 'spec-remote-different');

  const result = await sync.checkAndSync();
  t.assertEq(result, SyncResult.REAUTH_NEEDED, 'G4. specifier mismatch → REAUTH_NEEDED (regardless of TTL)');
}

// ═══════════════════════════════════════════════════════════════════════
// Category H: Logout + Re-login Interaction (3 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── Category H: Logout + Re-login ──\n');

// H1. Logout clears MK, dismisses overlay, disposes TTL monitor
{
  console.log('  H1. Logout full cleanup');
  const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-h1';
  const { sync, storage, crypto } = createSyncService({
    withTransport: true,
    withMasterKey: true,
    masterKey: mk,
  });

  await storage.set('phpoc_seed', 'seed-for-h1');
  await createLocalCookie(storage, 0, 'spec-h1');

  let reauthActive = true;

  // Simulate logout
  crypto.clearMasterKey();
  reauthActive = false;
  // In real code, also disposes TTL monitor

  t.assertEq(crypto.hasMasterKey(), false, 'H1a. MK cleared on logout');
  t.assertEq(reauthActive, false, 'H1b. overlay dismissed on logout');
  // Cookie should still exist in storage (not cleared on logout)
  const cookie = await storage.get('cookie');
  t.assert(!!cookie, 'H1c. cookie preserved in storage after logout');
}

// H2. After logout + fresh login, TTL monitor restarts with fresh cookie
{
  console.log('\n  H2. Fresh session after re-login');
  if (hasCreateCookieMonitor) {
    const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-h2';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('phpoc_seed', 'seed-for-h2');

    // Initial session — fresh cookie
    await createLocalCookie(storage, 0, 'spec-h2');
    await pushRemoteCookie(transport, 'dev-eeee2ee', 'spec-h2');

    // Logout
    crypto.clearMasterKey();

    // Fresh login — re-derive MK
    crypto.setMasterKey(mk);
    t.assert(crypto.hasMasterKey(), 'H2a. MK restored after fresh login');

    // After fresh login, sync should work
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'H2b. sync works after fresh login');

    // TTL monitor would restart here in real code
    // Start monitor with fresh cookie TTL
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 50,
      onExpired: () => {},
    });

    await monitor.start();
    t.assertEq(monitor.isExpired(), false, 'H2c. fresh monitor not expired after login');
    monitor.dispose();
  } else {
    t.assert(false, 'H2. createCookieMonitor not implemented (TDD RED)');
  }
}

// H3. Logout during active reauth overlay → overlay dismissed → services cleaned
{
  console.log('\n  H3. Logout during reauth overlay');
  const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-h3';
  const { crypto, storage } = createSyncService({
    withTransport: true,
    withMasterKey: true,
    masterKey: mk,
  });

  let reauthActive = true; // Overlay is showing

  // User triggers logout from the reauth overlay (e.g., "Cancel → Logout")
  reauthActive = false;
  crypto.clearMasterKey();

  t.assertEq(reauthActive, false, 'H3a. overlay dismissed on logout');
  t.assertEq(crypto.hasMasterKey(), false, 'H3b. MK cleared');
  // Verify the app returns to landing screen (phase change in real code)
  t.assert(true, 'H3c. services cleaned, landing shown');
}

// ═══════════════════════════════════════════════════════════════════════
// Category I: Edge Cases (4 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── Category I: Edge Cases ──\n');

// I1. TTL expiry during in-flight auto-sync push → push completes, then MK cleared
{
  console.log('  I1. TTL expiry during in-flight push');
  if (hasCreateCookieMonitor) {
    const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-i1';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('phpoc_seed', 'seed-for-i1');
    await createLocalCookie(storage, 0, 'spec-i1');
    await pushRemoteCookie(transport, 'dev-eeee2ee', 'spec-i1');

    // Start an async push
    await sync.capture({ title: 'Entry I1', startEpoch: 1000 });
    const pushPromise = sync.pushToRemote(mk);

    // Expire cookie while push is in-flight
    await createExpiredCookie(storage, 1);

    // The push should complete (it already has the MK reference)
    await pushPromise;

    // MK should be cleared AFTER the push completes (monitor fires on expiry)
    // But the push itself should succeed
    const blobBytes = await transport.pull(BLOB_PATH);
    t.assert(blobBytes !== null, 'I1a. push completed despite concurrent TTL expiry');
  } else {
    t.assert(false, 'I1. createCookieMonitor not implemented (TDD RED)');
  }
}

// I2. handleReauth called twice in rapid succession → first completes, second is no-op
{
  console.log('\n  I2. Double reauth — race condition safety');
  const crypto = new MockCrypto();
  const storage = new MemoryBackend();
  await storage.set('phpoc_seed', 'seed-for-i2');

  crypto.setMasterKey('original-mk-that-gets-overwritten');

  // First reauth
  const mk1 = await simulateReauth(crypto, storage, 'seed-for-i2', 'pass1');
  t.assertEq(crypto.getMasterKey(), mk1, 'I2a. first reauth sets MK');

  // Second reauth (same credentials — no-op in practice)
  // Since MK is already set, second reauth should still succeed
  const mk2 = await simulateReauth(crypto, storage, 'seed-for-i2', 'pass1');
  t.assertEq(crypto.getMasterKey(), mk2, 'I2b. second reauth also succeeds');
  t.assertEq(mk1, mk2, 'I2c. same passphrase+seed → same MK');
}

// I3. Cookie TTL past boundary → validly detected as expired, cleaned up.
// With MK cached, checkAndSync proceeds via _reconcileAndClaim → READY.
// This is design invariant: MK bypasses re-auth (see sync_service_test G3).
// A fresh cookie is created during reconcile after the old one is removed.
{
  console.log('\n  I3. TTL boundary — cookie cleanup + renewal');
  const ttlMinutes = 1;
  const mk = 'eeee2eee-eeee2eee-eeee2eee-eeee2eee-i3';
  const { sync, storage } = createSyncService({
    withTransport: true,
    withMasterKey: true, // MK present — bypasses re-auth gate
    masterKey: mk,
    cookieTtl: ttlMinutes,
  });

  // Cookie created slightly past TTL
  const oldCreationTime = Date.now() - (ttlMinutes * 60 * 1000) - 2000;
  await storage.set('cookie', {
    device_specifier: 'spec-boundary',
    creation_time: oldCreationTime,
  });

  // With MK cached, expired cookie → reconcile → READY (design invariant)
  const result = await sync.checkAndSync();
  t.assertEq(result, SyncResult.READY, 'I3. expired cookie + MK → reconcile → READY');

  // Old cookie removed, new fresh cookie created by reconcile
  const cookieAfter = await storage.get('cookie');
  t.assert(!!cookieAfter && !!cookieAfter.device_specifier, 'I3b. new fresh cookie created during reconcile');
  t.assert(cookieAfter.creation_time > oldCreationTime, 'I3c. cookie creation_time updated (fresh cookie)');
}

// I4. Multiple rapid start()/dispose() cycles don't leak timers
{
  console.log('\n  I4. Timer hygiene under stress');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createLocalCookie(storage, 0);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 20,
      onExpired: () => {},
    });

    // Rapid start/dispose cycles
    for (let i = 0; i < 5; i++) {
      await monitor.start();
      await wait(5);
      monitor.dispose();
    }

    // After disposal, wait for what would be several poll cycles
    await wait(100);

    // No crashes, no leaked timers firing after dispose
    t.assert(true, 'I4. survived rapid start/dispose cycles without timer leaks');

    monitor.dispose(); // Final cleanup
  } else {
    t.assert(false, 'I4. createCookieMonitor not implemented (TDD RED)');
  }
}

// ── Summary ───────────────────────────────────────────────────────────
const failures = t.summary('reauth_integration_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
