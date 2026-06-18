/**
 * device_uuid_test.mjs — Device UUID generation and persistence tests.
 *
 * TDD RED phase: Tests the desired behavior of device UUID management.
 * The current implementation uses crypto.getDeviceId(MK) which derives
 * from the master key (HMAC). The correct behavior is:
 *
 *   1. Generate crypto.randomUUID() on first boot
 *   2. Persist it in storage under key 'device_uuid'
 *   3. Read from storage on subsequent boots (survives refresh/re-login)
 *   4. UUID must NOT be derived from the master key
 *   5. UUID survives storage.clear() — it's permanent device identity
 *
 * The SyncService._getDeviceId() currently uses the WASM-derived UUID.
 * These tests verify the module that will replace that behavior.
 *
 * Usage:
 *   node test/device_uuid_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { getOrCreateDeviceUuid, isWasmDerivedUuid } from '../src/sync/device_uuid.js';

// ══════════════════════════════════════════════════════════════════════
// Device UUID Manager — imported from src/sync/device_uuid.js
// ══════════════════════════════════════════════════════════════════════

/** @type {typeof import('../src/sync/device_uuid.js').getOrCreateDeviceUuid} */
/** @type {typeof import('../src/sync/device_uuid.js').isWasmDerivedUuid} */

// ── UUID4 regex for validation ───────────────────────────────────────
const UUID4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

async function run() {
  console.log('══ Device UUID Test Suite ══\n');

  // ── Group 1: First boot — generates fresh UUID ────────────────────
  console.log('── Group 1: First Boot — UUID Generation ──\n');

  const storage1 = new MemoryBackend();

  let uuid1;
  try {
    uuid1 = await getOrCreateDeviceUuid(storage1);
    // Should not reach here in RED phase (throws NOT YET IMPLEMENTED)
    t.assert(typeof uuid1 === 'string', '1a. getOrCreateDeviceUuid returns a string');
    t.assert(uuid1.length > 0, '1b. returned UUID is non-empty');
    t.assert(UUID4_REGEX.test(uuid1), `1c. UUID matches UUID4 format (got: ${uuid1?.slice(0, 40)})`);

    // Verify it was persisted
    const stored = await storage1.get('device_uuid');
    t.assertEq(stored, uuid1, '1d. UUID persisted in storage under device_uuid key');
  } catch (err) {
    t.assert(false, `1a-1d. EXCEPTION (expected in RED phase): ${err.message}`);
  }

  // ── Group 2: Second boot — reads persisted UUID ───────────────────
  console.log('\n── Group 2: Subsequent Boot — Reads Persisted UUID ──\n');

  const storage2 = new MemoryBackend();
  // Pre-populate storage with a UUID (simulating a previous boot)
  const preExistingUuid = 'a1b2c3d4-e5f6-4abc-8def-0123456789ab';
  await storage2.set('device_uuid', preExistingUuid);

  try {
    const uuid2 = await getOrCreateDeviceUuid(storage2);
    t.assertEq(uuid2, preExistingUuid, '2a. returns the pre-existing UUID (not a new one)');

    // Verify it didn't overwrite
    const stored2 = await storage2.get('device_uuid');
    t.assertEq(stored2, preExistingUuid, '2b. stored UUID unchanged');
  } catch (err) {
    t.assert(false, `2a-2b. EXCEPTION (expected in RED phase): ${err.message}`);
  }

  // ── Group 3: UUID survives logout / re-login ──────────────────────
  console.log('\n── Group 3: UUID Survives Logout/Re-login ──\n');

  const storage3 = new MemoryBackend();
  const sessionUuid = 'deadbeef-dead-4eef-8bad-feedfacefeed';
  await storage3.set('device_uuid', sessionUuid);

  // Simulate: create temporary data that would be cleared on logout
  await storage3.set('cookie', { device_specifier: 'abc', creation_time: Date.now() });
  await storage3.set('master_key', 'some-key');

  try {
    // Simulate logout — clear session data but NOT device_uuid
    await storage3.delete('cookie');
    await storage3.delete('master_key');

    // Now simulate re-login — get device UUID
    const uuid3 = await getOrCreateDeviceUuid(storage3);
    t.assertEq(uuid3, sessionUuid, '3a. UUID survives session data cleanup (logout)');

    // Verify session data is gone but device UUID remains
    const cookie = await storage3.get('cookie');
    t.assertEq(cookie, undefined, '3b. cookie cleared by logout');
    const deviceUuid = await storage3.get('device_uuid');
    t.assertEq(deviceUuid, sessionUuid, '3c. device_uuid still stored after logout');
  } catch (err) {
    t.assert(false, `3a-3c. EXCEPTION (expected in RED phase): ${err.message}`);
  }

  // ── Group 4: UUID is NOT derived from master key ──────────────────
  console.log('\n── Group 4: UUID Independence from Master Key ──\n');

  const storage4 = new MemoryBackend();
  const independentUuid = '11111111-2222-4333-8444-555555555555';
  await storage4.set('device_uuid', independentUuid);

  try {
    const uuid4 = await getOrCreateDeviceUuid(storage4);
    // The returned UUID should match the pre-existing one, regardless of master key
    t.assertEq(uuid4, independentUuid, '4a. UUID matches stored value (not derived from any key)');

    // Verify it's a real UUID4, not a hex hash
    t.assert(UUID4_REGEX.test(uuid4), '4b. UUID is UUID4 format (version 4)');

    // A WASM-derived UUID from HMAC(MK, "device:id") would be a hex string,
    // not a UUID4. Verify we're not getting a hex string.
    t.assert(!/^[0-9a-f]{32,}$/i.test(uuid4), '4c. UUID is NOT a raw hex string (not HMAC-derived)');
  } catch (err) {
    t.assert(false, `4a-4c. EXCEPTION (expected in RED phase): ${err.message}`);
  }

  // ── Group 5: Different instances with different storage return same UUID ──
  console.log('\n── Group 5: UUID Stability Across Storage Instances ──\n');

  try {
    const storage5a = new MemoryBackend();
    await storage5a.set('device_uuid', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

    // Simulate page refresh — new MemoryBackend instance
    const storage5b = new MemoryBackend();
    // In real IndexedDB, the data would be in the same database.
    // For this test, we pre-populate to simulate that.
    await storage5b.set('device_uuid', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

    const uuid5a = await getOrCreateDeviceUuid(storage5a);
    const uuid5b = await getOrCreateDeviceUuid(storage5b);

    t.assertEq(uuid5a, uuid5b, '5a. same UUID returned from different storage instances');
    t.assertEq(uuid5a, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '5b. UUID is the pre-existing value');
  } catch (err) {
    t.assert(false, `5a-5b. EXCEPTION (expected in RED phase): ${err.message}`);
  }

  // ── Group 6: First boot generates version-4 UUID (not version 1, 3, or 5) ──
  console.log('\n── Group 6: UUID Format Validation ──\n');

  try {
    const storage6 = new MemoryBackend();
    const uuid6 = await getOrCreateDeviceUuid(storage6);

    // Version 4 UUIDs have position 14 = '4' and position 19 in [89ab]
    t.assert(uuid6.charAt(14) === '4', '6a. UUID version nibble is 4');
    t.assert('89ab'.includes(uuid6.charAt(19)), '6b. UUID variant nibble is 8/9/a/b');

    // Length check
    t.assertEq(uuid6.length, 36, '6c. UUID is exactly 36 characters');
  } catch (err) {
    t.assert(false, `6a-6c. EXCEPTION (expected in RED phase): ${err.message}`);
  }

  // ── Group 7: isWasmDerivedUuid detection ─────────────────────────
  console.log('\n── Group 7: WASM-Derived UUID Detection ──\n');

  try {
    // A WASM-derived UUID from HMAC(mk, "device:id") is a hex string
    const wasmDerived = 'a1b2c3d4e5f6001234567890abcdef1234567890abcdef1234567890abcdef';
    const realUuid4 = '550e8400-e29b-41d4-a716-446655440000';

    t.assert(isWasmDerivedUuid(wasmDerived), '7a. detects hex string as WASM-derived');
    t.assert(!isWasmDerivedUuid(realUuid4), '7b. UUID4 is NOT detected as WASM-derived');
  } catch (err) {
    t.assert(false, `7a-7b. EXCEPTION (expected in RED phase): ${err.message}`);
  }

  // ── Group 8: Migration — existing WASM-derived UUID replaced on next boot ──
  console.log('\n── Group 8: Migration from WASM-derived UUID ──\n');

  try {
    const storage8 = new MemoryBackend();
    // Simulate an old installation that used the WASM-derived UUID
    const wasmDerived = 'ab12cd34ef560000111122223333444455556666777788889999aaaabbbbcccc';
    await storage8.set('device_uuid', wasmDerived);

    const uuid8 = await getOrCreateDeviceUuid(storage8);
    t.assert(UUID4_REGEX.test(uuid8), '8a. migrates to UUID4 format');
    t.assertNeq(uuid8, wasmDerived, '8b. migrated UUID differs from WASM-derived one');

    // The stored value should be updated
    const stored8 = await storage8.get('device_uuid');
    t.assertEq(stored8, uuid8, '8c. storage updated with new UUID4');
  } catch (err) {
    t.assert(false, `8a-8c. EXCEPTION (expected in RED phase): ${err.message}`);
  }

  // ── Results ───────────────────────────────────────────────────────
  t.summary('Device UUID');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
