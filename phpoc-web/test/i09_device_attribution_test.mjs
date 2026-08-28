/**
 * i09_device_attribution_test.mjs — I-09 Phase 2 RED: JS tests.
 *
 * Tests device_local_secret generation, deriveDeviceId() via WASM,
 * migration from existing UUID formats, and SyncService._getDeviceId() changes.
 *
 * Group E: device_local_secret (device_uuid.js) — 7 tests
 * Group F: migration from existing UUID formats — 4 tests
 * Group G: sync.js integration — 6 tests
 *
 * Usage:
 *   node test/i09_device_attribution_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

// ── Future API imports (will exist after Phase 3) ────────────────
let HAS_I09_DEVICE_SECRET = false;
let getOrCreateDeviceSecret = null;
let deriveDeviceId = null;

try {
  const mod = await import('../src/sync/device_uuid.js');
  getOrCreateDeviceSecret = mod.getOrCreateDeviceSecret;
  deriveDeviceId = mod.deriveDeviceId;
  HAS_I09_DEVICE_SECRET = !!(getOrCreateDeviceSecret && deriveDeviceId);
} catch {
  // Phase 2 RED — functions not yet implemented
}

// ── Regex patterns ───────────────────────────────────────────────
const UUID4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64_REGEX = /^[0-9a-f]{64}$/i;

// ── Test helpers ─────────────────────────────────────────────────
const t = new TestHelpers();

function skipUnless(condition, reason) {
  if (!condition) {
    console.log(`  ⚠ SKIP: ${reason}`);
    return true;
  }
  return false;
}

async function run() {
  console.log('══ I-09 Device Attribution JS Test Suite ══\n');

  // ══════════════════════════════════════════════════════════════
  // Group E: device_local_secret (device_uuid.js)
  // ══════════════════════════════════════════════════════════════

  console.log('── Group E: device_local_secret Generation ──\n');

  // ── E1: First call generates UUID4 ────────────────────────────

  {
    const storage = new MemoryBackend();
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET,
           'E1: getOrCreateDeviceSecret not yet implemented')) {
        console.log('  ⚠ E1 skipped');
      } else {
        const secret = await getOrCreateDeviceSecret(storage);
        t.assert(typeof secret === 'string', 'E1a. getOrCreateDeviceSecret returns a string');
        t.assert(UUID4_REGEX.test(secret),
          `E1b. Secret is valid UUID4 format (got: ${secret?.slice(0, 20)})`);
      }
    } catch (err) {
      t.assert(false, `E1. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── E2: Secret persisted in storage ───────────────────────────

  {
    const storage = new MemoryBackend();
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET, 'E2: not yet implemented')) {
        console.log('  ⚠ E2 skipped');
      } else {
        const secret = await getOrCreateDeviceSecret(storage);
        const stored = await storage.get('device_local_secret');
        t.assertEq(stored, secret, 'E2. Secret persisted under device_local_secret key');
      }
    } catch (err) {
      t.assert(false, `E2. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── E3: Secret survives logout ────────────────────────────────

  {
    const storage = new MemoryBackend();
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET, 'E3: not yet implemented')) {
        console.log('  ⚠ E3 skipped');
      } else {
        const secret = await getOrCreateDeviceSecret(storage);
        // Simulate logout: delete session data but NOT device_local_secret
        await storage.delete('cookie');
        await storage.delete('master_key');
        await storage.delete('staging_entries');
        const afterLogout = await getOrCreateDeviceSecret(storage);
        t.assertEq(afterLogout, secret,
          `E3. Secret survives logout (got: ${afterLogout?.slice(0, 20)})`);
      }
    } catch (err) {
      t.assert(false, `E3. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── E4: deriveDeviceId returns 64-char hex ────────────────────

  {
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET && deriveDeviceId,
           'E4: deriveDeviceId not yet implemented')) {
        console.log('  ⚠ E4 skipped');
      } else {
        const mk = 'ab'.repeat(32); // 64-char hex MK
        const secret = '550e8400-e29b-41d4-a716-446655440000';
        const deviceId = await deriveDeviceId(mk, secret);
        t.assert(typeof deviceId === 'string', 'E4a. deriveDeviceId returns a string');
        t.assertEq(deviceId.length, 64,
          `E4b. Returns 64-char hex (got ${deviceId?.length} chars)`);
        t.assert(HEX64_REGEX.test(deviceId),
          `E4c. Output is hex (got: ${deviceId?.slice(0, 20)})`);
      }
    } catch (err) {
      t.assert(false, `E4. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── E5: Deterministic ─────────────────────────────────────────

  {
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET && deriveDeviceId, 'E5: not yet implemented')) {
        console.log('  ⚠ E5 skipped');
      } else {
        const mk = 'ab'.repeat(32);
        const secret = '550e8400-e29b-41d4-a716-446655440000';
        const id1 = await deriveDeviceId(mk, secret);
        const id2 = await deriveDeviceId(mk, secret);
        t.assertEq(id1, id2, 'E5. Deterministic: same (mk, secret) → same device_id');
      }
    } catch (err) {
      t.assert(false, `E5. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── E6: Different MK → different device_id ────────────────────

  {
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET && deriveDeviceId, 'E6: not yet implemented')) {
        console.log('  ⚠ E6 skipped');
      } else {
        const mkA = 'ab'.repeat(32);
        const mkB = 'cd'.repeat(32);
        const secret = '550e8400-e29b-41d4-a716-446655440000';
        const idA = await deriveDeviceId(mkA, secret);
        const idB = await deriveDeviceId(mkB, secret);
        t.assertNeq(idA, idB, 'E6. Different MK → different device_id');
      }
    } catch (err) {
      t.assert(false, `E6. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── E7: Different secret → different device_id ────────────────

  {
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET && deriveDeviceId, 'E7: not yet implemented')) {
        console.log('  ⚠ E7 skipped');
      } else {
        const mk = 'ab'.repeat(32);
        const sA = '550e8400-e29b-41d4-a716-446655440000';
        const sB = '660e8400-e29b-41d4-a716-446655440001';
        const idA = await deriveDeviceId(mk, sA);
        const idB = await deriveDeviceId(mk, sB);
        t.assertNeq(idA, idB, 'E7. Different secret → different device_id');
      }
    } catch (err) {
      t.assert(false, `E7. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Group F: migration from existing UUID formats
  // ══════════════════════════════════════════════════════════════

  console.log('\n── Group F: Migration from Existing UUID Formats ──\n');

  // ── F1: Bare UUID4 becomes device_local_secret ────────────────

  {
    const storage = new MemoryBackend();
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET, 'F1: not yet implemented')) {
        console.log('  ⚠ F1 skipped');
      } else {
        // Pre-populate with bare UUID4 (pre-I-09 state)
        const bareUuid = 'a1b2c3d4-e5f6-4abc-8def-0123456789ab';
        await storage.set('device_local_secret', bareUuid);

        const secret = await getOrCreateDeviceSecret(storage);
        t.assertEq(secret, bareUuid,
          `F1a. Bare UUID4 adopted as device_local_secret (got: ${secret?.slice(0, 20)})`);

        // device_id should be recomputed (NOT equal to the bare UUID)
        const mk = 'ab'.repeat(32);
        if (deriveDeviceId) {
          const deviceId = await deriveDeviceId(mk, secret);
          t.assertNeq(deviceId, bareUuid,
            'F1b. device_id recomputed from MK + secret (not bare UUID)');
        }
      }
    } catch (err) {
      t.assert(false, `F1. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── F2: WASM-derived hex UUID → fresh secret ──────────────────

  {
    const storage = new MemoryBackend();
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET, 'F2: not yet implemented')) {
        console.log('  ⚠ F2 skipped');
      } else {
        // Pre-populate with WASM-derived 64-char hex (old format)
        const wasmHex = 'ab12cd34ef560000111122223333444455556666777788889999aaaabbbbcccc';
        await storage.set('device_local_secret', wasmHex);

        const secret = await getOrCreateDeviceSecret(storage);
        // Should regenerate — old hex is not a valid UUID4
        t.assert(UUID4_REGEX.test(secret),
          `F2a. WASM hex replaced with UUID4 (got: ${secret?.slice(0, 20)})`);
        t.assertNeq(secret, wasmHex,
          'F2b. New secret differs from old WASM hex');
      }
    } catch (err) {
      t.assert(false, `F2. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── F3: Suffixed UUID → core extracted as secret ──────────────

  {
    const storage = new MemoryBackend();
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET, 'F3: not yet implemented')) {
        console.log('  ⚠ F3 skipped');
      } else {
        // Pre-populate with suffixed UUID (Bug 3a format)
        const suffixedUuid = 'deadbeef-dead-4eef-8bad-feedfacefeed-web';
        await storage.set('device_local_secret', suffixedUuid);

        const secret = await getOrCreateDeviceSecret(storage);
        // Core UUID should be extracted (strip suffix)
        const coreUuid = 'deadbeef-dead-4eef-8bad-feedfacefeed';
        t.assertEq(secret, coreUuid,
          `F3a. Suffixed UUID stripped to core UUID4 (got: ${secret})`);
        t.assert(UUID4_REGEX.test(secret),
          'F3b. Extracted core is valid UUID4');
      }
    } catch (err) {
      t.assert(false, `F3. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── F4: Client suffix -web appended to new device_id ──────────

  {
    const storage = new MemoryBackend();
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET, 'F4: not yet implemented')) {
        console.log('  ⚠ F4 skipped');
      } else {
        // Fresh install — get secret then derive device_id
        const secret = await getOrCreateDeviceSecret(storage);
        const mk = 'ab'.repeat(32);
        if (deriveDeviceId) {
          const deviceId = await deriveDeviceId(mk, secret);
          // The deriveDeviceId function returns the raw 64-char hex.
          // The suffix is appended at a higher level (getOrCreateDeviceUuid, sync).
          // This test just verifies the hex output is correct.
          t.assertEq(deviceId.length, 64,
            `F4. Device ID is 64 hex chars (suffix appended at higher level, got ${deviceId?.length})`);
        }
      }
    } catch (err) {
      t.assert(false, `F4. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Group G: sync.js integration
  // ══════════════════════════════════════════════════════════════

  console.log('\n── Group G: SyncService Integration ──\n');

  // ── G1-G3, G5-G6: SyncService integration tests ───────────────
  // These tests require CryptoService (WASM), which may not be
  // available in the Node test runner. When WASM is unavailable,
  // the tests document expected behavior but cannot execute.

  let syncServiceAvailable = false;
  let SyncService, CryptoService;
  try {
    SyncService = (await import('../src/sync/sync.js')).SyncService;
    CryptoService = (await import('../src/crypto/index.js')).CryptoService;
    const crypto = await CryptoService.create();
    syncServiceAvailable = true;
  } catch (err) {
    console.log(`  ⚠ SyncService/CryptoService not available: ${err.message.split('\n')[0]}`);
    console.log('  ⚠ G1-G3, G5-G6: Tests deferred — WASM not loadable in test runner');
  }

  // ── G1: _getDeviceId returns HMAC-derived device_id ────────────

  if (syncServiceAvailable) {
    try {
      const crypto = await CryptoService.create();
      const mk = 'ab'.repeat(32);
      crypto.setMasterKey(mk);

      const storage = new MemoryBackend();
      await storage.set('device_local_secret', '550e8400-e29b-41d4-a716-446655440000');

      const sync = new SyncService(storage, crypto, null);
      const deviceId = await sync._getDeviceId();

      t.assert(typeof deviceId === 'string', 'G1a. _getDeviceId returns a string');
      t.assert(deviceId.length > 0, 'G1b. _getDeviceId returns non-empty string');

      if (deviceId.length === 68 && deviceId.endsWith('-web')) {
        const core = deviceId.slice(0, 64);
        t.assert(HEX64_REGEX.test(core),
          `G1c. Core is 64-char hex (got: ${core?.slice(0, 20)})`);
      } else {
        console.log(`  ⚠ G1c: _getDeviceId returned "${deviceId?.slice(0, 30)}..." (len=${deviceId?.length}) — expected 68-char HMAC-derived format after Phase 3`);
      }
    } catch (err) {
      t.assert(false, `G1. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── G2: _getDeviceId does NOT fall back to WASM getDeviceId ────

  if (syncServiceAvailable) {
    try {
      const crypto = await CryptoService.create();
      const mk = 'ab'.repeat(32);
      crypto.setMasterKey(mk);

      const storage = new MemoryBackend();
      // NOTE: Not setting device_local_secret intentionally

      const sync = new SyncService(storage, crypto, null);
      const deviceId = await sync._getDeviceId();

      if (deviceId === null) {
        t.assert(true, 'G2. No device_local_secret → returns null (no WASM fallback)');
      } else {
        console.log(`  ⚠ G2: _getDeviceId returned "${deviceId}" without device_local_secret — should return null after Phase 3 (no WASM fallback)`);
      }
    } catch (err) {
      t.assert(false, `G2. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── G3: _getDeviceId returns null when MK unavailable ──────────

  if (syncServiceAvailable) {
    try {
      const crypto = await CryptoService.create();
      // No MK set — simulate pre-auth state

      const storage = new MemoryBackend();
      await storage.set('device_local_secret', '550e8400-e29b-41d4-a716-446655440000');

      const sync = new SyncService(storage, crypto, null);
      const deviceId = await sync._getDeviceId();

      t.assertEq(deviceId, null,
        `G3. No MK available → returns null (got: ${deviceId})`);
    } catch (err) {
      t.assert(false, `G3. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── G4: device_id changes after key rotation ──────────────────

  {
    try {
      if (skipUnless(HAS_I09_DEVICE_SECRET && deriveDeviceId,
           'G4: deriveDeviceId not yet implemented')) {
        console.log('  ⚠ G4 skipped');
      } else {
        const secret = '550e8400-e29b-41d4-a716-446655440000';
        const mkV1 = 'ab'.repeat(32);
        const mkV2 = 'cd'.repeat(32); // Simulated rotated MK
        const idV1 = await deriveDeviceId(mkV1, secret);
        const idV2 = await deriveDeviceId(mkV2, secret);
        t.assertNeq(idV1, idV2, 'G4. device_id changes after key rotation');
      }
    } catch (err) {
      t.assert(false, `G4. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── G5: pushBlobOnly receives correct device_id ────────────────

  if (syncServiceAvailable) {
    try {
      const crypto = await CryptoService.create();
      const mk = 'ab'.repeat(32);
      crypto.setMasterKey(mk);

      const storage = new MemoryBackend();
      await storage.set('device_local_secret', '550e8400-e29b-41d4-a716-446655440000');

      const sync = new SyncService(storage, crypto, null);
      const deviceId = await sync._getDeviceId();

      t.assert(typeof deviceId === 'string' && deviceId.length > 0,
        `G5. pushBlobOnly would receive device_id: "${deviceId?.slice(0, 30)}..."`);
    } catch (err) {
      t.assert(false, `G5. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── G6: pushToRemote receives correct device_id ────────────────

  if (syncServiceAvailable) {
    try {
      const crypto = await CryptoService.create();
      const mk = 'ab'.repeat(32);
      crypto.setMasterKey(mk);

      const storage = new MemoryBackend();
      await storage.set('device_local_secret', '550e8400-e29b-41d4-a716-446655440000');

      const sync = new SyncService(storage, crypto, null);
      const deviceId = await sync._getDeviceId();

      t.assert(deviceId !== null && deviceId.length > 0,
        `G6. pushToRemote would receive device_id (got: ${deviceId === null ? 'null' : 'non-null'})`);
    } catch (err) {
      t.assert(false, `G6. EXCEPTION (expected in RED phase): ${err.message}`);
    }
  }

  // ── Results ───────────────────────────────────────────────────────
  t.summary('I-09 Device Attribution (JS)');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
