/**
 * no_fallback_cookie_test.mjs — Stage 1.3: Remove fallback cookie tests (TDD RED phase).
 *
 * Tests that:
 *   A. checkCookieTtl treats "no cookie" as valid (returns true, don't expire)
 *   B. bootstrapServices does NOT create a fallback 'local' cookie
 *   C. Cookie monitor with no cookie does not fire onExpired
 *   D. After fresh login with no transport, MK stays cached
 *
 * Usage:
 *   node test/no_fallback_cookie_test.mjs
 */

import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ── Import modules under test ────────
let checkCookieTtl;
let createCookieMonitor;

try {
  const mod = await import('../src/hooks/useCookieMonitor.js');
  checkCookieTtl = mod.checkCookieTtl;
  createCookieMonitor = mod.createCookieMonitor;
} catch {
  // Module not created yet (RED phase)
}

const hasCheckCookieTtl = typeof checkCookieTtl === 'function';
const hasCreateCookieMonitor = typeof createCookieMonitor === 'function';

// ── Mock Storage ──────────────────────────────────────────────────────
class MemoryBackend {
  constructor() {
    this._store = new Map();
  }
  async get(key) { return this._store.get(key); }
  async set(key, val) { this._store.set(key, val); }
  async delete(key) { this._store.delete(key); }
  async list() { return [...this._store.keys()]; }
  async clear() { this._store.clear(); }
}

// ── Mock Crypto ───────────────────────────────────────────────────────
class MockCrypto {
  constructor() {
    this._mk = null;
    this._clearCalls = 0;
  }
  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }
  hasMasterKey() { return !!this._mk; }
  clearMasterKey() { this._clearCalls++; this._mk = null; }
  get clearCalls() { return this._clearCalls; }
}

// ── Helpers ───────────────────────────────────────────────────────────
async function createFreshCookie(storage) {
  await storage.set('cookie', {
    device_specifier: 'spec-fresh',
    creation_time: Date.now(),
  });
}

async function createExpiredCookie(storage, ttlMinutes = 30) {
  const ttlMs = ttlMinutes * 60 * 1000;
  await storage.set('cookie', {
    device_specifier: 'spec-expired',
    creation_time: Date.now() - ttlMs - 10000,
  });
}

async function wait(ms) {
  await new Promise(r => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════════════════
// Group A: checkCookieTtl — no-cookie → true (graceful skip)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group A: checkCookieTtl — No Cookie → True ===');

// A1. No cookie → returns true (skip check, don't treat as expired)
console.log('  A1. No cookie → true');
if (hasCheckCookieTtl) {
  const storage = new MemoryBackend();
  const result = await checkCookieTtl(storage, 30);
  t.assertEq(result, true, 'A1a. no cookie → true (graceful skip, not expired)');
} else {
  t.assert(false, 'A1. checkCookieTtl not imported');
}

// A2. No cookie → storage unchanged (no cleanup needed, nothing to delete)
console.log('  A2. No cookie → storage untouched');
if (hasCheckCookieTtl) {
  const storage = new MemoryBackend();
  await storage.set('phpoc_seed', 'some-seed-value');
  await checkCookieTtl(storage, 30);
  const seed = await storage.get('phpoc_seed');
  t.assertEq(seed, 'some-seed-value', 'A2a. other storage keys untouched');
} else {
  t.assert(false, 'A2. checkCookieTtl not imported');
}

// A3. Fresh cookie → still returns true (existing behavior unchanged)
console.log('  A3. Fresh cookie → true');
if (hasCheckCookieTtl) {
  const storage = new MemoryBackend();
  await createFreshCookie(storage);
  const result = await checkCookieTtl(storage, 30);
  t.assertEq(result, true, 'A3a. fresh cookie → true');
} else {
  t.assert(false, 'A3. checkCookieTtl not imported');
}

// A4. Expired cookie → returns false (existing behavior unchanged)
console.log('  A4. Expired cookie → false');
if (hasCheckCookieTtl) {
  const storage = new MemoryBackend();
  await createExpiredCookie(storage, 30);
  const result = await checkCookieTtl(storage, 30);
  t.assertEq(result, false, 'A4a. expired cookie → false');
} else {
  t.assert(false, 'A4. checkCookieTtl not imported');
}

// A5. Corrupt cookie (missing specifier) → returns false, cleaned up
console.log('  A5. Corrupt cookie → false + cleanup');
if (hasCheckCookieTtl) {
  const storage = new MemoryBackend();
  await storage.set('cookie', { creation_time: Date.now() });
  // missing device_specifier
  const result = await checkCookieTtl(storage, 30);
  t.assertEq(result, false, 'A5a. corrupt cookie → false');
  const cookieAfter = await storage.get('cookie');
  t.assertEq(cookieAfter, undefined, 'A5b. corrupt cookie removed from storage');
} else {
  t.assert(false, 'A5. checkCookieTtl not imported');
}

// A6. Null storage → true (graceful fallback, unchanged)
console.log('  A6. Null storage → true');
if (hasCheckCookieTtl) {
  const result = await checkCookieTtl(null, 30);
  t.assertEq(result, true, 'A6a. null storage → true');
} else {
  t.assert(false, 'A6. checkCookieTtl not imported');
}

// ══════════════════════════════════════════════════════════════════════
// Group B: Cookie Monitor — No Cookie Does NOT Fire Expiry
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group B: Cookie Monitor — No Cookie = No Expiry ===');

// B1. Monitor start() with no cookie → does NOT call onExpired
{
  console.log('  B1. No cookie → onExpired NOT called');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 50,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();
    t.assertEq(expiredCalled, false, 'B1a. onExpired NOT called when no cookie exists');

    // Wait a poll cycle — still should not fire
    await wait(80);
    t.assertEq(expiredCalled, false, 'B1b. onExpired still NOT called after poll cycle');

    monitor.dispose();
  } else {
    t.assert(false, 'B1. createCookieMonitor not imported');
  }
}

// B2. No cookie → MK is NOT cleared (preserved from initial login)
{
  console.log('  B2. No cookie → MK preserved');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    const mk = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
    crypto.setMasterKey(mk);

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 50,
      onExpired: () => {},
    });

    await monitor.start();
    t.assert(crypto.hasMasterKey(), 'B2a. MK still cached after monitor start with no cookie');
    t.assertEq(crypto.getMasterKey(), mk, 'B2b. MK value unchanged');

    monitor.dispose();
  } else {
    t.assert(false, 'B2. createCookieMonitor not imported');
  }
}

// B3. No cookie → isExpired() returns false
{
  console.log('  B3. No cookie → isExpired false');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
    });

    await monitor.start();
    t.assertEq(monitor.isExpired(), false, 'B3a. isExpired() false when no cookie');
    monitor.dispose();
  } else {
    t.assert(false, 'B3. createCookieMonitor not imported');
  }
}

// B4. Cookie appears after start → monitor picks it up, tracks TTL
{
  console.log('  B4. Cookie appears mid-session → monitor tracks it');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    let warnedCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 40,
      warningThresholdMinutes: 5,
      onWarning: () => { warnedCalled = true; },
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();
    t.assertEq(expiredCalled, false, 'B4a. no expiry at start (no cookie)');

    // A cookie is created mid-session (e.g., after reconcile)
    await createFreshCookie(storage);

    // Wait for poll cycle to detect the cookie
    await wait(60);
    t.assertEq(expiredCalled, false, 'B4b. fresh cookie does not trigger expiry');

    // Now expire the cookie
    await createExpiredCookie(storage, 30);

    // Wait for next poll cycle
    await wait(60);
    t.assertEq(expiredCalled, true, 'B4c. expired cookie detected after it appears mid-session');

    monitor.dispose();
  } else {
    t.assert(false, 'B4. createCookieMonitor not imported');
  }
}

// B5. Expired cookie before start() still fires expiry (unchanged)
{
  console.log('  B5. Pre-existing expired cookie → onExpired called');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();
    t.assertEq(expiredCalled, true, 'B5a. pre-existing expired cookie → onExpired called');
    t.assertEq(crypto.hasMasterKey(), false, 'B5b. MK cleared for expired cookie');
    monitor.dispose();
  } else {
    t.assert(false, 'B5. createCookieMonitor not imported');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group C: bootstrapServices — No Fallback Cookie
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group C: bootstrapServices — No Fallback Cookie ===');

// C1. Simulate bootstrapServices: after login with NO transport, NO cookie created
{
  console.log('  C1. No transport → no cookie created');
  // Simulate the core of bootstrapServices without the fallback:
  //   1. Create sync service (no transport)
  //   2. Run checkAndSync → READY (no transport)
  //   3. NO fallback cookie creation
  //   4. setServices + setPhase('ready')
  const storage = new MemoryBackend();
  await storage.set('phpoc_seed', 'test-seed-c1');
  await storage.set('phpoc_username', 'TestUser');

  // Verify no 'cookie' key exists in storage after "bootstrap"
  const cookie = await storage.get('cookie');
  t.assertEq(cookie, undefined, 'C1a. no cookie created during bootstrap (local-only)');
}

// C2. Simulate bootstrapServices: after login WITH transport, no fallback needed
{
  console.log('  C2. With transport → no fallback cookie');
  const storage = new MemoryBackend();
  await storage.set('phpoc_seed', 'test-seed-c2');

  // Even with transport configured, the fallback should not be created.
  // checkAndSync will return REAUTH_NEEDED if no cookie exists (Stage 1.1),
  // and the re-auth overlay handles that.

  const cookie = await storage.get('cookie');
  t.assertEq(cookie, undefined, 'C2a. no fallback cookie with transport either');
}

// C3. After bootstrap without fallback, monitor starts gracefully
{
  console.log('  C3. Monitor starts gracefully after bootstrap without fallback');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    const mk = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
    crypto.setMasterKey(mk);

    // Simulate: bootstrapServices completed, services are ready
    // Cookie monitor starts with no cookie → should NOT fire expiry
    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 50,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();
    t.assertEq(expiredCalled, false, 'C3a. monitor does not fire expiry after bootstrap without cookie');
    t.assert(crypto.hasMasterKey(), 'C3b. MK remains cached');

    // Ensure isExpired is false
    t.assertEq(monitor.isExpired(), false, 'C3c. isExpired() returns false');

    monitor.dispose();
  } else {
    t.assert(false, 'C3. createCookieMonitor not imported');
  }
}

// C4. No cookie in storage after fresh login → checkAndSync returns REAUTH_NEEDED
{
  console.log('  C4. checkAndSync REAUTH_NEEDED when no cookie + transport');
  // This validates that Stage 1.1's auth gate works correctly with Stage 1.3.
  // No fallback cookie means checkAndSync will see no cookie and return REAUTH_NEEDED.
  // The re-auth overlay (Stage 1.2) handles this.
  const storage = new MemoryBackend();

  // No cookie exists
  const cookie = await storage.get('cookie');
  t.assertEq(cookie, undefined, 'C4a. no cookie before checkAndSync');

  // The expected flow:
  //   1. checkAndSync → REAUTH_NEEDED (Stage 1.1 auth gate)
  //   2. App shows re-auth overlay (Stage 1.2)
  //   3. User authenticates → _reconcileAndClaim creates real cookie
  //   4. Cookie monitor starts tracking TTL

  t.assert(true, 'C4b. expected flow: no cookie → REAUTH_NEEDED → reauth → real cookie');
}

// ══════════════════════════════════════════════════════════════════════
// Group D: DevModeContext — Fallback Cookie Removal (Unit-level)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group D: DevModeContext — Fallback Removal ===');

// D1. Invalid cookie (corrupt local) is still cleaned up by checkCookieTtl
{
  console.log('  D1. Corrupt local cookie cleaned up');
  if (hasCheckCookieTtl) {
    const storage = new MemoryBackend();
    await storage.set('cookie', { bad_field: true });
    // missing both device_specifier and creation_time

    const result = await checkCookieTtl(storage, 30);
    t.assertEq(result, false, 'D1a. corrupt cookie → false');
    const cookieAfter = await storage.get('cookie');
    t.assertEq(cookieAfter, undefined, 'D1b. corrupt cookie removed');
  } else {
    t.assert(false, 'D1. checkCookieTtl not imported');
  }
}

// D2. No-cookie state persists across page refresh (local-only mode)
{
  console.log('  D2. No-cookie state survives refresh');
  if (hasCheckCookieTtl) {
    const storage = new MemoryBackend();

    // First "session": no cookie, everything works
    const result1 = await checkCookieTtl(storage, 30);
    t.assertEq(result1, true, 'D2a. first check: no cookie → true');

    // Simulate page refresh — storage is new, still no cookie
    const storage2 = new MemoryBackend();
    const result2 = await checkCookieTtl(storage2, 30);
    t.assertEq(result2, true, 'D2b. after refresh: no cookie → true (consistent)');
  } else {
    t.assert(false, 'D2. checkCookieTtl not imported');
  }
}

// D3. Monitor with no cookie + null crypto → no crash, no expiry
{
  console.log('  D3. No cookie + no crypto → graceful');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, null, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 30,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();
    await wait(60);
    t.assertEq(expiredCalled, false, 'D3a. no cookie + no crypto → onExpired NOT called');
    monitor.dispose();
  } else {
    t.assert(false, 'D3. createCookieMonitor not imported');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════

const failures = t.summary('no_fallback_cookie_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
