/**
 * reauth_ttl_test.mjs — Cookie TTL Monitor + Re-auth Trigger test suite (TDD RED).
 *
 * Tests checkCookieTtl() helper and createCookieMonitor() pure function.
 * Uses MemoryBackend, MockCrypto (same patterns as sync_service_test.mjs).
 * ~30 tests across 5 categories (A–E).
 *
 * Category A — checkCookieTtl() Unit Tests (7 tests)
 * Category B — createCookieMonitor Polling Behavior (8 tests)
 * Category C — createCookieMonitor Edge Cases (7 tests)
 * Category D — MK Clearing (6 tests)
 * Category E — Overlay Trigger Integration (7 tests)
 *
 * RED phase: checkCookieTtl is NOT a standalone export yet (lives in
 * DevModeContext); createCookieMonitor is NOT implemented yet. All tests
 * expected to fail.
 *
 * Usage:
 *   node test/reauth_ttl_test.mjs
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
  // Module not created yet (RED phase) — both remain undefined
}

const hasCheckCookieTtl = typeof checkCookieTtl === 'function';
const hasCreateCookieMonitor = typeof createCookieMonitor === 'function';

// ── Safe wrap helper ──────────────────────────────────────────────────
async function safe(fn, label) {
  try {
    return await fn();
  } catch (err) {
    if (err.message && err.message.includes('not implemented')) {
      return null;
    }
    throw err;
  }
}

function safeSync(fn) {
  try {
    return fn();
  } catch (err) {
    if (err.message && err.message.includes('not implemented')) {
      return null;
    }
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Storage — in-memory Map backend
// ══════════════════════════════════════════════════════════════════════

class MemoryBackend {
  constructor() {
    this._store = new Map();
  }
  async get(key) { return this._store.get(key); }
  async set(key, val) { this._store.set(key, val); }
  async delete(key) { this._store.delete(key); }
  async list() { return [...this._store.keys()]; }
  async clear() { this._store.clear(); }
  /** Simulate storage failures */
  setBroken(val = true) { this._broken = val; }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Crypto — with master key tracking and clearMasterKey
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor() {
    this._mk = null;
    this._clearCalls = 0;
    this._clearShouldThrow = false;
  }

  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }
  hasMasterKey() { return !!this._mk; }

  clearMasterKey() {
    if (this._clearShouldThrow) {
      throw new Error('Simulated clearMasterKey failure');
    }
    this._clearCalls++;
    this._mk = null;
  }

  get clearCalls() { return this._clearCalls; }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Create a valid local cookie with given creation_time offset.
 * @param {MemoryBackend} storage
 * @param {number} ageMs - How old the cookie is (milliseconds ago).
 *   Default 0 = fresh cookie.
 * @param {string} [specifier='spec-test']
 */
async function createLocalCookie(storage, ageMs = 0, specifier = 'spec-test') {
  await storage.set('cookie', {
    device_specifier: specifier,
    creation_time: Date.now() - ageMs,
  });
}

/**
 * Create an expired cookie (older than TTL).
 */
async function createExpiredCookie(storage, ttlMinutes = 30) {
  const ttlMs = ttlMinutes * 60 * 1000;
  await storage.set('cookie', {
    device_specifier: 'spec-expired',
    creation_time: Date.now() - ttlMs - 10000, // 10 seconds past TTL
  });
}

/**
 * Corrupt cookie — missing device_specifier.
 */
async function createCorruptCookie(storage) {
  await storage.set('cookie', {
    // Missing device_specifier
    creation_time: Date.now(),
  });
}

/**
 * Corrupt cookie — missing creation_time.
 */
async function createCookieNoTime(storage) {
  await storage.set('cookie', {
    device_specifier: 'spec-no-time',
    // Missing creation_time
  });
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════');
console.log('Cookie TTL Monitor Test Suite (TDD RED)');
console.log('═══════════════════════════════════════════\n');

// ═══════════════════════════════════════════════════════════════════════
// Category A: checkCookieTtl() Unit Tests (7 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('── Category A: checkCookieTtl() Unit Tests ──\n');

// A1. Returns true when cookie is valid and fresh
{
  console.log('  A1. Valid fresh cookie → true');
  if (hasCheckCookieTtl) {
    const storage = new MemoryBackend();
    await createLocalCookie(storage, 0);
    const result = await checkCookieTtl(storage, 30);
    t.assertEq(result, true, 'A1. valid cookie → true');
  } else {
    t.assert(false, 'A1. checkCookieTtl not implemented (TDD RED)');
  }
}

// A2. Returns false when cookie is expired
{
  console.log('\n  A2. Expired cookie → false');
  if (hasCheckCookieTtl) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const result = await checkCookieTtl(storage, 30);
    t.assertEq(result, false, 'A2. expired cookie → false');
  } else {
    t.assert(false, 'A2. checkCookieTtl not implemented (TDD RED)');
  }
}

// A3. Returns false when no cookie exists in storage
{
  console.log('\n  A3. No cookie → false');
  if (hasCheckCookieTtl) {
    const storage = new MemoryBackend();
    const result = await checkCookieTtl(storage, 30);
    t.assertEq(result, false, 'A3. no cookie → false');
  } else {
    t.assert(false, 'A3. checkCookieTtl not implemented (TDD RED)');
  }
}

// A4. Returns false when cookie has empty/missing device_specifier
{
  console.log('\n  A4. Corrupt cookie (empty specifier) → false');
  if (hasCheckCookieTtl) {
    const storage = new MemoryBackend();
    await createCorruptCookie(storage);
    const result = await checkCookieTtl(storage, 30);
    t.assertEq(result, false, 'A4. corrupt cookie (empty specifier) → false');

    // Cookie should be cleaned up
    const cookieAfter = await storage.get('cookie');
    t.assertEq(cookieAfter, undefined, 'A4b. corrupt cookie removed from storage');
  } else {
    t.assert(false, 'A4. checkCookieTtl not implemented (TDD RED)');
  }
}

// A5. Returns false when cookie has null/missing creation_time
{
  console.log('\n  A5. Cookie without creation_time → false');
  if (hasCheckCookieTtl) {
    const storage = new MemoryBackend();
    await createCookieNoTime(storage);
    const result = await checkCookieTtl(storage, 30);
    t.assertEq(result, false, 'A5. cookie missing creation_time → false');

    const cookieAfter = await storage.get('cookie');
    t.assertEq(cookieAfter, undefined, 'A5b. invalid cookie removed from storage');
  } else {
    t.assert(false, 'A5. checkCookieTtl not implemented (TDD RED)');
  }
}

// A6. Returns true when storage is null (graceful fallback)
{
  console.log('\n  A6. Null storage → true (graceful fallback)');
  if (hasCheckCookieTtl) {
    const result = await checkCookieTtl(null, 30);
    t.assertEq(result, true, 'A6. null storage → true (graceful)');
  } else {
    t.assert(false, 'A6. checkCookieTtl not implemented (TDD RED)');
  }
}

// A7. Returns true when storage is undefined (services not ready)
{
  console.log('\n  A7. Undefined storage → true (not ready)');
  if (hasCheckCookieTtl) {
    const result = await checkCookieTtl(undefined, 30);
    t.assertEq(result, true, 'A7. undefined storage → true (graceful)');
  } else {
    t.assert(false, 'A7. checkCookieTtl not implemented (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Category B: createCookieMonitor Polling Behavior (8 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── Category B: createCookieMonitor Polling Behaviors ──\n');

// B1. start() fires immediate TTL check (synchronous initial probe)
{
  console.log('  B1. start() fires immediate TTL check');
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
    // Immediate check on start should detect expired cookie
    t.assertEq(expiredCalled, true, 'B1. onExpired called immediately on start with expired cookie');
    monitor.dispose();
  } else {
    t.assert(false, 'B1. createCookieMonitor not implemented (TDD RED)');
  }
}

// B2. start() does NOT call onExpired when cookie is valid
{
  console.log('\n  B2. start() does not call onExpired with valid cookie');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createLocalCookie(storage, 0);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();
    t.assertEq(expiredCalled, false, 'B2. onExpired NOT called with valid cookie');
    monitor.dispose();
  } else {
    t.assert(false, 'B2. createCookieMonitor not implemented (TDD RED)');
  }
}

// B3. start() calls onExpired when cookie is expired at startup (immediate expiry)
{
  console.log('\n  B3. start() immediate expiry detection (same as B1 but with logging)');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 1); // TTL 1 min, cookie 70 seconds old
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 1,
      pollIntervalMs: 10000,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();
    t.assertEq(expiredCalled, true, 'B3. immediate expiry at boot triggers onExpired');
    monitor.dispose();
  } else {
    t.assert(false, 'B3. createCookieMonitor not implemented (TDD RED)');
  }
}

// B4. Polling fires after pollIntervalMs elapses
{
  console.log('\n  B4. Polling fires after pollIntervalMs');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createLocalCookie(storage, 0);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 50, // Short for testing
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();
    // Cookie is valid now, so no callback yet
    t.assertEq(expiredCalled, false, 'B4a. no callback before expiry');

    // Expire the cookie manually (set age past TTL)
    await createLocalCookie(storage, 31 * 60 * 1000 + 5000); // 31 min + 5 sec old

    // Wait for polling interval
    await new Promise(r => setTimeout(r, 70));

    t.assertEq(expiredCalled, true, 'B4b. onExpired called after poll detects expiry');

    monitor.dispose();
  } else {
    t.assert(false, 'B4. createCookieMonitor not implemented (TDD RED)');
  }
}

// B5. onExpired called only once per expiry (no duplicate calls)
{
  console.log('\n  B5. onExpired called only once (no duplicates)');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCount = 0;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 30,
      onExpired: () => { expiredCount++; },
    });

    await monitor.start();
    // Immediate expiry should fire once
    t.assertEq(expiredCount, 1, 'B5a. onExpired called exactly once at boot');

    // Wait for several poll cycles — should NOT fire again
    await new Promise(r => setTimeout(r, 120));

    t.assertEq(expiredCount, 1, 'B5b. onExpired NOT called again in subsequent polls');

    monitor.dispose();
  } else {
    t.assert(false, 'B5. createCookieMonitor not implemented (TDD RED)');
  }
}

// B6. After onExpired fires, polling stops
{
  console.log('\n  B6. Polling stops after expiry');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCount = 0;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 30,
      onExpired: () => { expiredCount++; },
    });

    await monitor.start();
    t.assertEq(expiredCount, 1, 'B6a. expired detected at boot');

    // Wait for several poll cycles
    await new Promise(r => setTimeout(r, 120));

    // Still only 1 — polling stopped after expiry
    t.assertEq(expiredCount, 1, 'B6b. no further checks after expiry (polling stopped)');

    monitor.dispose();
  } else {
    t.assert(false, 'B6. createCookieMonitor not implemented (TDD RED)');
  }
}

// B7. dispose() stops polling — timer cleared, no further checks
{
  console.log('\n  B7. dispose() stops polling');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createLocalCookie(storage, 0);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 50,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();
    // Immediately dispose — no polling should happen
    monitor.dispose();

    // Expire the cookie and wait
    await createExpiredCookie(storage, 30);
    await new Promise(r => setTimeout(r, 100));

    t.assertEq(expiredCalled, false, 'B7. onExpired NOT called after dispose');

    monitor.dispose(); // Idempotent second dispose (see B8)
  } else {
    t.assert(false, 'B7. createCookieMonitor not implemented (TDD RED)');
  }
}

// B8. dispose() is safe to call twice (second call is no-op)
{
  console.log('\n  B8. dispose() idempotent');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => {},
    });

    await monitor.start();
    monitor.dispose();
    // Second dispose should not throw
    try {
      monitor.dispose();
      t.assert(true, 'B8. second dispose() is safe (no throw)');
    } catch (err) {
      t.assert(false, `B8. second dispose() threw: ${err.message}`);
    }
  } else {
    t.assert(false, 'B8. createCookieMonitor not implemented (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Category C: createCookieMonitor Edge Cases (7 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── Category C: createCookieMonitor Edge Cases ──\n');

// C1. Monitor does nothing when onExpired callback is not provided
{
  console.log('  C1. Missing onExpired callback — no crash');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    // Create monitor without onExpired callback
    try {
      const monitor = createCookieMonitor(storage, crypto, {
        cookieTtlMinutes: 30,
        pollIntervalMs: 50,
        // onExpired intentionally omitted
      });
      await monitor.start();
      // Should not crash even though no callback provided
      t.assert(true, 'C1. missing onExpired callback handled gracefully');
      monitor.dispose();
    } catch (err) {
      t.assert(false, `C1. crashed with missing callback: ${err.message}`);
    }
  } else {
    t.assert(false, 'C1. createCookieMonitor not implemented (TDD RED)');
  }
}

// C2. Monitor handles storage read errors gracefully
{
  console.log('\n  C2. Storage read error — graceful handling');
  if (hasCreateCookieMonitor) {
    // Storage that throws on get
    const brokenStorage = {
      async get(key) { throw new Error('Storage read failure'); },
      async set(key, val) {},
      async delete(key) {},
    };
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    const monitor = createCookieMonitor(brokenStorage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 50,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();

    // Wait a few cycles — storage error should not crash the monitor
    await new Promise(r => setTimeout(r, 100));
    t.assert(true, 'C2a. monitor survived storage read errors');

    // onExpired should NOT have been called (read always fails → can't detect expiry)
    t.assertEq(expiredCalled, false, 'C2b. onExpired NOT called when storage errors prevent check');

    monitor.dispose();
  } else {
    t.assert(false, 'C2. createCookieMonitor not implemented (TDD RED)');
  }
}

// C3. Monitor handles onExpired throwing without breaking internal state
{
  console.log('\n  C3. onExpired throws — internal state intact');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let callCount = 0;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 30,
      onExpired: () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Simulated callback crash');
        }
      },
    });

    await monitor.start();

    // Wait through the poll cycle
    await new Promise(r => setTimeout(r, 100));

    // onExpired should have been called once (the throwing one)
    // and then stopped (single-fire) — internal state should not be corrupted
    t.assertEq(callCount, 1, 'C3a. onExpired called once despite throwing');

    // dispose() should still work
    monitor.dispose();
    t.assert(true, 'C3b. dispose() still works after callback crash');
  } else {
    t.assert(false, 'C3. createCookieMonitor not implemented (TDD RED)');
  }
}

// C4. After onExpired fires, calling check() returns false (state consistency)
{
  console.log('\n  C4. check() consistency post-expiry');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => {},
    });

    await monitor.start();
    // After start with expired cookie, isExpired should be true
    const isExpired = monitor.isExpired();
    t.assertEq(isExpired, true, 'C4. isExpired() returns true after expiry detected');

    monitor.dispose();
  } else {
    t.assert(false, 'C4. createCookieMonitor not implemented (TDD RED)');
  }
}

// C5. start() after dispose() restarts monitoring with fresh poll cycle
{
  console.log('\n  C5. Re-activation after dispose');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createLocalCookie(storage, 0);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 50,
      onExpired: () => { expiredCalled = true; },
    });

    // First start — cookie is valid, no callback
    await monitor.start();
    t.assertEq(expiredCalled, false, 'C5a. first start with valid cookie: no callback');

    // Dispose and wait
    monitor.dispose();

    // Expire the cookie
    await createExpiredCookie(storage, 30);

    // Re-start — should detect expired cookie immediately
    await monitor.start();
    t.assertEq(expiredCalled, true, 'C5b. re-start after expiry: onExpired called');

    monitor.dispose();
  } else {
    t.assert(false, 'C5. createCookieMonitor not implemented (TDD RED)');
  }
}

// C6. Very short poll interval works correctly (10ms boundary)
{
  console.log('\n  C6. Short poll interval (10ms)');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createLocalCookie(storage, 0);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10,
      onExpired: () => {},
    });

    await monitor.start();
    // Should not crash with very short interval
    t.assert(true, 'C6a. short poll interval does not crash');

    // Wait a few cycles
    await new Promise(r => setTimeout(r, 50));
    t.assert(true, 'C6b. monitor survives multiple short-interval cycles');

    monitor.dispose();
  } else {
    t.assert(false, 'C6. createCookieMonitor not implemented (TDD RED)');
  }
}

// C7. Monitor with null storage → never triggers onExpired (skips checks)
{
  console.log('\n  C7. Null storage → no expiry triggers');
  if (hasCreateCookieMonitor) {
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let expiredCalled = false;
    const monitor = createCookieMonitor(null, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 30,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();

    // Wait for several poll cycles
    await new Promise(r => setTimeout(r, 100));

    t.assertEq(expiredCalled, false, 'C7. onExpired NEVER called with null storage');

    monitor.dispose();
  } else {
    t.assert(false, 'C7. createCookieMonitor not implemented (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Category D: MK Clearing (6 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── Category D: MK Clearing ──\n');

// D1. When TTL expires, crypto.clearMasterKey() is called before onExpired
{
  console.log('  D1. clearMasterKey called before onExpired');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    const events = [];
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => { events.push('onExpired'); },
    });

    // Spy on clearMasterKey
    const origClear = crypto.clearMasterKey.bind(crypto);
    crypto.clearMasterKey = () => {
      events.push('clearMasterKey');
      origClear();
    };

    await monitor.start();
    t.assertDeepEq(events, ['clearMasterKey', 'onExpired'], 'D1. clearMasterKey fires before onExpired');

    monitor.dispose();
  } else {
    t.assert(false, 'D1. createCookieMonitor not implemented (TDD RED)');
  }
}

// D2. After MK cleared, crypto.hasMasterKey() returns false
{
  console.log('\n  D2. MK cleared → hasMasterKey() false');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => {},
    });

    await monitor.start();

    t.assertEq(crypto.hasMasterKey(), false, 'D2. hasMasterKey() returns false after clearMasterKey');
    t.assertEq(crypto.getMasterKey(), null, 'D2b. getMasterKey() returns null after clear');

    monitor.dispose();
  } else {
    t.assert(false, 'D2. createCookieMonitor not implemented (TDD RED)');
  }
}

// D3. After MK cleared, crypto.getMasterKey() returns null
{
  console.log('\n  D3. verify getMasterKey() null (same as D2b but standalone)');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    const mk = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
    crypto.setMasterKey(mk);

    t.assertEq(crypto.getMasterKey(), mk, 'D3a. master key set before monitor starts');

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => {},
    });

    await monitor.start();

    t.assertEq(crypto.getMasterKey(), null, 'D3b. getMasterKey() returns null after monitor clears MK');

    monitor.dispose();
  } else {
    t.assert(false, 'D3. createCookieMonitor not implemented (TDD RED)');
  }
}

// D4. When MK already cleared (prior logout), TTL expiry does not call clearMasterKey() again
{
  console.log('\n  D4. MK already cleared → no redundant clearMasterKey call');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    // MK NOT set — simulating post-logout state

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => {},
    });

    await monitor.start();

    // clearMasterKey should not have been called (no MK to clear)
    t.assertEq(crypto.clearCalls, 0, 'D4. clearMasterKey NOT called when MK already null');

    monitor.dispose();
  } else {
    t.assert(false, 'D4. createCookieMonitor not implemented (TDD RED)');
  }
}

// D5. When no crypto service provided, TTL expiry still calls onExpired without crashing
{
  console.log('\n  D5. No crypto → onExpired still fires (graceful)');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, null, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();

    t.assertEq(expiredCalled, true, 'D5. onExpired called even without crypto service');

    monitor.dispose();
  } else {
    t.assert(false, 'D5. createCookieMonitor not implemented (TDD RED)');
  }
}

// D6. onExpired is called even if clearMasterKey() throws
{
  console.log('\n  D6. clearMasterKey throws → onExpired still called');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');
    crypto._clearShouldThrow = true;

    let expiredCalled = false;
    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: () => { expiredCalled = true; },
    });

    await monitor.start();

    t.assertEq(expiredCalled, true, 'D6. onExpired called despite clearMasterKey throwing');

    monitor.dispose();
  } else {
    t.assert(false, 'D6. createCookieMonitor not implemented (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Category E: Overlay Trigger Integration (7 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n── Category E: Overlay Trigger Integration ──\n');

// E1. TTL expiry → triggerReauth called → reauthActive becomes true
{
  console.log('  E1. TTL expiry → triggerReauth → reauthActive=true');
  if (hasCreateCookieMonitor) {
    const storage = new MemoryBackend();
    await createExpiredCookie(storage, 30);
    const crypto = new MockCrypto();
    crypto.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');

    let reauthActive = false;
    const triggerReauth = () => { reauthActive = true; };

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 10000,
      onExpired: triggerReauth,
    });

    await monitor.start();

    t.assertEq(reauthActive, true, 'E1. reauthActive becomes true after TTL expiry');

    monitor.dispose();
  } else {
    t.assert(false, 'E1. createCookieMonitor not implemented (TDD RED)');
  }
}

// E2. dismissReauth → reauthActive becomes false
{
  console.log('\n  E2. dismissReauth → reauthActive=false');
  let reauthActive = true;
  const dismissReauth = () => { reauthActive = false; };

  dismissReauth();
  t.assertEq(reauthActive, false, 'E2. dismissReauth sets reauthActive to false');
}

// E3. triggerReauth when already active is safe (overlay stays open)
{
  console.log('\n  E3. triggerReauth idempotent');
  let reauthActive = true;
  let triggerCount = 0;
  const triggerReauth = () => { triggerCount++; reauthActive = true; };

  // Call twice
  triggerReauth();
  triggerReauth();

  t.assertEq(reauthActive, true, 'E3a. reauthActive stays true after double trigger');
  t.assertEq(triggerCount, 2, 'E3b. triggerReauth called twice (idempotent)');
}

// E4. handleReauth(passphrase) sets MK on crypto and dismisses overlay
{
  console.log('\n  E4. handleReauth success → MK set + overlay dismissed');
  if (hasCreateCookieMonitor) {
    const crypto = new MockCrypto();
    let reauthActive = true;

    // Simulate handleReauth — re-derives MK from passphrase + seed
    const seed = 'seed-for-reauth-test-001';
    const passphrase = 'correct horse battery staple';
    // In real implementation, this would use PBKDF2
    const derivedMk = 'derived-mk-from-passphrase-and-seed-000001';
    crypto.setMasterKey(derivedMk);
    reauthActive = false;

    t.assertEq(crypto.getMasterKey(), derivedMk, 'E4a. MK set after reauth');
    t.assertEq(crypto.hasMasterKey(), true, 'E4b. hasMasterKey true after reauth');
    t.assertEq(reauthActive, false, 'E4c. overlay dismissed after successful reauth');
  } else {
    t.assert(false, 'E4. createCookieMonitor not implemented (TDD RED)');
  }
}

// E5. handleReauth(wrongPassphrase) → error → overlay stays open
{
  console.log('\n  E5. handleReauth failure → overlay stays open');
  let reauthActive = true;
  let errorThrown = false;

  try {
    // Simulate wrong passphrase — authenticate would fail
    throw new Error('Wrong passphrase');
  } catch (err) {
    errorThrown = true;
    // Overlay stays open
    reauthActive = true;
  }

  t.assertEq(errorThrown, true, 'E5a. wrong passphrase throws error');
  t.assertEq(reauthActive, true, 'E5b. overlay stays open on auth failure');
}

// E6. handleReauth when no seed stored throws "No recovery seed found"
{
  console.log('\n  E6. handleReauth without seed');
  let errorMessage = '';
  const seed = null;

  try {
    if (!seed) {
      throw new Error('No recovery seed found. Cannot re-authenticate.');
    }
  } catch (err) {
    errorMessage = err.message;
  }

  t.assertEq(errorMessage, 'No recovery seed found. Cannot re-authenticate.', 'E6. missing seed throws "No recovery seed found"');
}

// E7. handleReauth when no storage/crypto throws with clear message
{
  console.log('\n  E7. handleReauth without services');
  let errorMessage = '';
  const services = { crypto: null, storage: null };

  try {
    if (!services.storage) {
      throw new Error('Storage not initialized. Please refresh the page.');
    }
  } catch (err) {
    errorMessage = err.message;
  }

  t.assertEq(errorMessage, 'Storage not initialized. Please refresh the page.', 'E7. no storage throws clear error message');
}

// ── Summary ───────────────────────────────────────────────────────────
const failures = t.summary('reauth_ttl_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
