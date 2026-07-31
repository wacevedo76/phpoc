/**
 * remote_sync_test.mjs — Group A: Canonical Blob Format (Phase 2 RED).
 *
 * Tests pushBlob() and pullBlob() format migration from legacy raw spec
 * ({hash, data: {_enc}}) to canonical PHPSPEC §8 format
 * ({activity_id, activity_status, activity, updated_at, committed}).
 *
 * Assertions: A1–A14 (14 tests).
 * All should FAIL in RED phase — implementation not yet migrated.
 *
 * Usage:
 *   node test/remote_sync_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { RemoteSync, BLOB_KEY_MISMATCH } from '../src/sync/remote_sync.js';
import { REMOTE_STAGING_BLOB } from '../src/sync/keys.js';

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

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
}

// ══════════════════════════════════════════════════════════════════════
// Mock CryptoService
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor(mk = null) {
    this._mk = mk;
  }

  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }
  hasMasterKey() { return !!this._mk; }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  obfuscateBlob(plaintext, mk) {
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = createHash('sha256').update(mk || '').digest().slice(0, 4);
    return Buffer.concat([keyFingerprint, plainBytes]).toString('base64');
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
// Canonical row helper — entries as expected by the new pushBlob()
// ══════════════════════════════════════════════════════════════════════

/**
 * Create a canonical staging row matching PHPSPEC §8.1.
 * @param {string} activityId
 * @param {string} [activityStatus='active']
 * @param {object} [activityPayload]
 * @param {number} [updatedAt]
 * @param {boolean} [committed=false]
 */
function canonicalRow(activityId, activityStatus = 'active', activityPayload = null, updatedAt = Date.now(), committed = false) {
  return {
    activity_id: activityId,
    activity_status: activityStatus,
    activity: JSON.stringify(activityPayload || { title: `Entry ${activityId}`, start_epoch: updatedAt }),
    updated_at: updatedAt,
    committed,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Run all tests
// ══════════════════════════════════════════════════════════════════════

async function runTests() {
  const mk = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const deviceId = 'test-device-1234-web';

  console.log('\n── Group A: Canonical Blob Format ──');

  // ── A1: pushBlob emits envelope with entries, device_id, device_proof — no updated_at ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null); // no MK = plaintext for format inspection
    const remote = new RemoteSync(transport, crypto);

    const rows = [canonicalRow('act-a1', 'active', { title: 'Test A1' }, 1000)];
    await remote.pushBlob(rows, deviceId, null);

    // Pull the pushed bytes and decode (plaintext)
    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    t.assert(pushed !== undefined, 'A1a: blob was pushed');
    const text = new TextDecoder().decode(pushed);
    const blob = JSON.parse(text);

    t.assert(Array.isArray(blob.entries), 'A1b: envelope has entries array');
    t.assertEq(typeof blob.device_id, 'string', 'A1c: envelope has device_id string');
    t.assert(typeof blob.device_proof === 'string', 'A1d: envelope has device_proof');
    t.assert(!('updated_at' in blob), 'A1e: envelope does NOT have updated_at');
  }

  // ── A2: pushBlob row has all five canonical fields ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null); // plaintext for inspection
    const remote = new RemoteSync(transport, crypto);

    const rows = [canonicalRow('act-a2', 'paused', { title: 'Test A2', start_epoch: 2000 }, 2000, false)];
    await remote.pushBlob(rows, deviceId, null);

    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    const text = new TextDecoder().decode(pushed);
    const blob = JSON.parse(text);

    t.assert(blob.entries.length > 0, 'A2a: entries is non-empty');
    const row = blob.entries[0];
    t.assertEq(typeof row.activity_id, 'string', 'A2b: row has activity_id (string)');
    t.assertEq(typeof row.activity_status, 'string', 'A2c: row has activity_status (string)');
    t.assertEq(typeof row.activity, 'string', 'A2d: row has activity (JSON string)');
    t.assertEq(typeof row.updated_at, 'number', 'A2e: row has updated_at (int)');
    t.assertEq(typeof row.committed, 'boolean', 'A2f: row has committed (bool)');
  }

  // ── A3: pushBlob row does NOT have hash at top level ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null); // plaintext for inspection
    const remote = new RemoteSync(transport, crypto);

    const rows = [canonicalRow('act-a3', 'active', { title: 'Test A3' }, 3000)];
    await remote.pushBlob(rows, deviceId, null);

    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    const text = new TextDecoder().decode(pushed);
    const blob = JSON.parse(text);
    const row = blob.entries[0];

    t.assert(!('hash' in row), 'A3: row does NOT have hash at top level');
  }

  // ── A4: pushBlob row does NOT have data at top level ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null); // plaintext for inspection
    const remote = new RemoteSync(transport, crypto);

    const rows = [canonicalRow('act-a4', 'active', { title: 'Test A4' }, 4000)];
    await remote.pushBlob(rows, deviceId, null);

    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    const text = new TextDecoder().decode(pushed);
    const blob = JSON.parse(text);
    const row = blob.entries[0];

    t.assert(!('data' in row), 'A4: row does NOT have data wrapper at top level');
  }

  // ── A5: pullBlob returns parsed canonical blob with entries array of rows ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);
    const remote = new RemoteSync(transport, crypto);

    const rows = [
      canonicalRow('act-a5a', 'active', { title: 'First A5' }, 1000),
      canonicalRow('act-a5b', 'paused', { title: 'Second A5' }, 2000),
    ];
    await remote.pushBlob(rows, deviceId, mk);

    // Create a fresh RemoteSync to read the blob back
    const transport2 = new MockTransport();
    // Copy the raw bytes
    transport2._store.set(REMOTE_STAGING_BLOB, transport._store.get(REMOTE_STAGING_BLOB));
    const remote2 = new RemoteSync(transport2, crypto);
    const blob = await remote2.pullBlob(mk);

    t.assert(blob !== null && blob !== BLOB_KEY_MISMATCH, 'A5a: pullBlob returns parsed blob');
    t.assert(Array.isArray(blob.entries), 'A5b: blob.entries is array');
    t.assertEq(blob.entries.length, 2, 'A5c: both entries present');
    const r0 = blob.entries[0];
    t.assertEq(r0.activity_id, 'act-a5a', 'A5d: first row activity_id preserved');
    t.assertEq(r0.activity_status, 'active', 'A5e: first row status preserved');
  }

  // ── A6: pullBlob returns null when no remote blob exists ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);
    const remote = new RemoteSync(transport, crypto);

    const result = await remote.pullBlob(mk);
    t.assertEq(result, null, 'A6: pullBlob returns null for empty remote');
  }

  // ── A7: pullBlob returns BLOB_KEY_MISMATCH when deobfuscation fails ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);
    const remote = new RemoteSync(transport, crypto);

    const rows = [canonicalRow('act-a7', 'active', { title: 'Test A7' }, 1000)];
    await remote.pushBlob(rows, deviceId, mk);

    // Try to pull with a different key
    const wrongKey = '1111111111111111111111111111111111111111111111111111111111111111';
    const result = await remote.pullBlob(wrongKey);

    t.assertEq(result, BLOB_KEY_MISMATCH, 'A7: pullBlob returns BLOB_KEY_MISMATCH with wrong key');
  }

  // ── A8: pushBlob preserves entry_id inside activity JSON when present ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null); // plaintext for inspection
    const remote = new RemoteSync(transport, crypto);

    const activity = JSON.stringify({
      title: 'Legacy Entry',
      start_epoch: 5000,
      entry_id: 'legacy-entry-id-1234',
    });
    const rows = [{
      activity_id: 'act-a8',
      activity_status: 'active',
      activity,
      updated_at: 5000,
      committed: false,
    }];
    await remote.pushBlob(rows, deviceId, null);

    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    const text = new TextDecoder().decode(pushed);
    const blob = JSON.parse(text);
    const activityParsed = blob.entries[0].activity ? JSON.parse(blob.entries[0].activity) : null;

    t.assert(activityParsed && activityParsed.entry_id === 'legacy-entry-id-1234', 'A8: entry_id preserved inside activity JSON');
  }

  // ── A9: pushBlob with empty entries array produces valid envelope ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null); // plaintext for inspection
    const remote = new RemoteSync(transport, crypto);

    await remote.pushBlob([], deviceId, null);

    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    t.assert(pushed !== undefined, 'A9a: blob was pushed');
    const text = new TextDecoder().decode(pushed);
    const blob = JSON.parse(text);

    t.assert(Array.isArray(blob.entries), 'A9b: entries is array');
    t.assertEq(blob.entries.length, 0, 'A9c: entries is empty');
    t.assertEq(blob.device_id, deviceId, 'A9d: device_id preserved with empty entries');
  }

  // ── A10: pushBlob obfuscates blob when master key is available ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);
    const remote = new RemoteSync(transport, crypto);

    const rows = [canonicalRow('act-a10', 'active', { title: 'Test A10' }, 1000)];
    await remote.pushBlob(rows, deviceId, mk);

    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    // Verify it's not plaintext JSON — obfuscated data starts with key fingerprint
    let isPlaintext;
    try {
      const text = new TextDecoder().decode(pushed);
      JSON.parse(text);
      isPlaintext = true;
    } catch {
      isPlaintext = false;
    }

    t.assert(!isPlaintext, 'A10: blob is obfuscated (not plain JSON) when MK available');
  }

  // ── A11: pushBlob emits plaintext JSON when no master key ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null); // no MK
    const remote = new RemoteSync(transport, crypto);

    const rows = [canonicalRow('act-a11', 'active', { title: 'Test A11' }, 1000)];
    await remote.pushBlob(rows, deviceId, null); // null MK = plaintext

    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    const text = new TextDecoder().decode(pushed);
    let blob;
    try {
      blob = JSON.parse(text);
    } catch {
      // should be parseable
    }

    t.assert(blob && typeof blob === 'object', 'A11a: blob is parseable JSON');
    t.assert(blob && Array.isArray(blob.entries), 'A11b: entries array present in plaintext');
  }

  // ── A12: pullBlob handles plaintext JSON fallback ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null);
    const remote = new RemoteSync(transport, crypto);

    // Manually push plaintext blob (simulating legacy plaintext)
    const plainBlob = {
      device_id: deviceId,
      device_proof: '',
      entries: [canonicalRow('act-a12', 'active', { title: 'Plaintext Entry' }, 1000)],
    };
    const plainBytes = new TextEncoder().encode(JSON.stringify(plainBlob));
    transport._store.set(REMOTE_STAGING_BLOB, plainBytes);

    const result = await remote.pullBlob();
    t.assert(result !== null, 'A12a: plaintext blob was pulled');
    t.assertEq(result.entries[0].activity_id, 'act-a12', 'A12b: activity_id read from plaintext');
  }

  // ── A13: pushBlob device_id matches the passed device ID ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null); // plaintext for inspection
    const remote = new RemoteSync(transport, crypto);

    const customDeviceId = 'custom-device-web-5678';
    const rows = [canonicalRow('act-a13', 'active', { title: 'Test A13' }, 13000)];
    await remote.pushBlob(rows, customDeviceId, null);

    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    const text = new TextDecoder().decode(pushed);
    const blob = JSON.parse(text);

    t.assertEq(blob.device_id, customDeviceId, 'A13: device_id in blob matches passed deviceId');
  }

  // ── A14: pushBlob row updated_at is set to current time when entry has no explicit timestamp ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(null); // plaintext for inspection
    const remote = new RemoteSync(transport, crypto);

    const beforePush = Date.now();
    // Create a row without updated_at
    const rows = [{
      activity_id: 'act-a14',
      activity_status: 'active',
      activity: JSON.stringify({ title: 'No timestamp' }),
      committed: false,
      // updated_at intentionally missing
    }];
    await remote.pushBlob(rows, deviceId, null);
    const afterPush = Date.now();

    const pushed = transport._store.get(REMOTE_STAGING_BLOB);
    const text = new TextDecoder().decode(pushed);
    const blob = JSON.parse(text);
    const row = blob.entries[0];

    t.assert(typeof row.updated_at === 'number', 'A14a: updated_at is a number');
    t.assert(row.updated_at >= beforePush && row.updated_at <= afterPush + 100,
      'A14b: updated_at is within push time window');
  }

  // ══════════════════════════════════════════════════════════════════
  t.summary('Remote Sync — Canonical Blob Format (Group A)');
}

runTests().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
