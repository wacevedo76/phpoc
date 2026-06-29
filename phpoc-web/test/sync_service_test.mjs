/**
 * sync_service_test.mjs — SyncService auth gate + reconcile tests.
 *
 * TDD RED phase: Tests the SyncService.checkAndSync() auth gate and
 * _reconcileAndClaim() using mock transport and in-memory storage.
 * No real Worker or network — pure logic tests against the sync algorithm.
 *
 * Test categories:
 *   A. Auth gate — READY / OFFLINE / REAUTH_NEEDED
 *   B. _reconcileAndClaim — Case A (same UUID) / Case B (different UUID)
 *   C. Edge cases — cookie TTL expiry, specifier mismatch, BLOB_KEY_MISMATCH
 *
 * In the RED phase, tests that exercise new/refactored behavior should FAIL
 * because the implementation hasn't been built yet. Tests that exercise
 * existing behavior should pass.
 *
 * Usage:
 *   node test/sync_service_test.mjs
 */

import { createHash } from 'crypto';

import { SyncService, SyncResult } from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort } from '../src/ledger/utils.js';

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Convert Uint8Array to base64. Works in Node.js.
 */
function _bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Convert base64 string to Uint8Array. Works in Node.js.
 */
function _base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ══════════════════════════════════════════════════════════════════════
// Mock Transport — simulates remote R2 storage in memory
// ══════════════════════════════════════════════════════════════════════
// Mock Transport — simulates remote R2 storage in memory.
// Supports sequential responses via queueResponse() for multi-pull tests.
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this._store = new Map();
    /** @type {Map<string, Array<Uint8Array|null>>} queue for sequential pulls */
    this._queue = new Map();
    this._offline = false;
    this._corrupt = false;
    /** If set, push() throws this error. */
    this._pushError = null;
  }

  /** Queue a response value (or null) for the next pull() of this path. FIFO. */
  queueResponse(path, value) {
    const arr = this._queue.get(path) || [];
    arr.push(value);
    this._queue.set(path, arr);
  }

  async pull(path) {
    if (this._offline) throw new Error('Network failure');
    const queue = this._queue.get(path);
    if (queue && queue.length > 0) return queue.shift();
    const val = this._store.get(path);
    return val !== undefined ? val : null;
  }

  async push(path, data) {
    if (this._offline) throw new Error('Network failure');
    if (this._pushError) throw this._pushError;
    this._store.set(path, data);
  }

  async delete(path) {
    if (this._offline) throw new Error('Network failure');
    this._store.delete(path);
  }

  /**
   * List files under a remote prefix.
   * Returns just the filenames (without the prefix).
   * @param {string} prefix - e.g. "ledger/blocks/"
   * @returns {Promise<string[]>}
   */
  async listFiles(prefix) {
    if (this._offline) throw new Error('Network failure');
    const results = [];
    for (const [path] of this._store) {
      if (path.startsWith(prefix)) {
        results.push(path.slice(prefix.length));
      }
    }
    return results;
  }

  resetCache() { /* no-op for mock transport */ }

  /** @returns {boolean} whether a key exists in the store */
  hasKey(path) {
    return this._store.has(path);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock CryptoService (matches the one in sync_test.mjs + new device UUID)
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor() {
    this._uuidCounter = 0;
    this._specCounter = 0;
    this._mk = null;
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

  /**
   * WASM default: HMAC-derived from master key.
   * This is what the CURRENT implementation returns. After the fix,
   * the SyncService will use a stored device UUID instead.
   */
  getDeviceId(mk) {
    return `dev-${(mk || '').slice(0, 8)}`;
  }

  seal(jsonStr, masterKey) {
    if (!masterKey) masterKey = this._mk || 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const hmac = createHash('sha256').update(masterKey + ':' + jsonStr).digest('hex');
    return hmac;
  }

  verifySeal(jsonStr, sealVal, masterKey) {
    const expected = this.seal(jsonStr, masterKey);
    return expected === sealVal;
  }

  sealBlock(blockData) {
    const copy = {};
    for (const [k, v] of Object.entries(blockData)) {
      if (k !== 'day_hash' && k !== 'month_hash' && k !== 'year_hash' && k !== 'signature') {
        copy[k] = v;
      }
    }
    return this.seal(jsonSort(copy));
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

  /**
   * Decrypt using the cached master key.
   * For tests, handles plain: prefix passthrough.
   */
  /**
   * Decrypt a hex ciphertext using a master key.
   * Used by LedgerMerge.merge() to decrypt startTime_enc for date grouping.
   * For tests, strips the 'enc:' prefix (matching the test convention).
   */
  decrypt(ciphertextHex, _masterKey) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }

  decryptWithCachedKey(ciphertextHex) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('plain:')) {
      return ciphertextHex.slice(6);
    }
    // Fallback: return as-is (numbers-as-strings pass through)
    return ciphertextHex;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const BLOB_PATH = 'staging/blobs/current.json';
const COOKIE_PATH = 'staging/blobs/device_cookie.bin';

/**
 * Create a SyncService with mock transport and crypto.
 * The crypto has no master key set unless setMasterKey is called.
 */
function createSyncService({ withTransport = true, withMasterKey = false, masterKey = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', cookieTtl = 30 } = {}) {
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
 * Push a remote cookie directly to the mock transport.
 */
async function pushRemoteCookie(transport, deviceUuid, specifier) {
  const cookieJson = JSON.stringify({
    device_uuid: deviceUuid,
    device_specifier: specifier,
  });
  await transport.push(COOKIE_PATH, new TextEncoder().encode(cookieJson));
}

/**
 * Push a remote staging blob to the mock transport.
 *
 * Remote blob entries must be in the raw format expected by _rawEntryToDTO():
 * { entry_id, hash, data: { title, startTime_enc, endTime_enc, duration,
 *   is_active, is_paused, pauses_enc, tags, comment, device_uuid, ... } }
 * Timestamps use 'plain:' prefix convention from the CLI.
 */
async function pushRemoteBlob(transport, crypto, entries, deviceId, mk) {
  const rawEntries = entries.map(e => ({
    entry_id: e.entry_id || `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hash: e.hash || `h-${e.entry_id}`,
    data: {
      entry_id: e.entry_id,
      title: e.title,
      startTime_enc: `plain:${e.start_epoch}`,
      endTime_enc: e.end_epoch != null ? `plain:${e.end_epoch}` : undefined,
      duration: e.duration || 0,
      is_active: e.is_active || false,
      is_paused: e.is_paused || false,
      pauses_enc: 'plain:[]',
      metadata_enc: 'plain:{}',
      tags: e.tags || [],
      comment: e.comment || null,
      media: e.media || [],
      device_uuid: deviceId,
      end_device_uuid: '',
    },
  }));

  const blob = JSON.stringify({
    device_id: deviceId,
    device_proof: '',
    entries: rawEntries,
    updated_at: Date.now(),
  });
  const obfuscated = crypto.obfuscateBlob(blob, mk);
  const bytes = new Uint8Array(Buffer.from(obfuscated, 'base64'));
  await transport.push(BLOB_PATH, bytes);
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

async function run() {
  console.log('══ SyncService Auth Gate & Reconcile Test Suite ══\n');

  // ── Group A: Auth Gate — Basic States ──────────────────────────
  console.log('── Group A: Auth Gate Basic States ──\n');

  // A1. No transport configured → READY (local-only mode)
  {
    const { sync } = createSyncService({ withTransport: false, withMasterKey: true });
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'A1. no transport → READY');
  }

  // A2. No local cookie, no remote cookie → REAUTH_NEEDED
  {
    const { sync } = createSyncService({ withTransport: true });
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'A2. no cookie at all → REAUTH_NEEDED');
  }

  // A2b. No local cookie + MK cached → REAUTH_NEEDED (no bypass)
  // Matches CLI behavior: cookie is the truth, not the cached key.
  {
    const { sync } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'a2b-test-key-a2b-test-key-a2b-test-key-a2b1234abc',
    });
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'A2b. no cookie + cached MK → REAUTH_NEEDED (no bypass)');
  }

  // A3. Local cookie valid + no remote cookie + no master key → REAUTH_NEEDED
  {
    const { sync, storage, crypto } = createSyncService({ withTransport: true });
    // Create a valid local cookie
    await crypto.setMasterKey('temp-key-for-cookie-creation-only');
    // Use DeviceCookie.create() directly... but we need crypto.generateDeviceSpecifier()
    // Instead, manually set a local cookie
    await storage.set('cookie', {
      device_specifier: 'spec-a',
      creation_time: Date.now(),
    });
    crypto.setMasterKey(null); // No master key

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'A3. local cookie valid + no remote cookie + no MK → REAUTH_NEEDED');
  }

  // A4. Local cookie expired → REAUTH_NEEDED
  {
    const { sync, storage, crypto } = createSyncService({ withTransport: true, cookieTtl: 1 });
    // Set a stale cookie (2 minutes old, TTL is 1 minute)
    await storage.set('cookie', {
      device_specifier: 'spec-old',
      creation_time: Date.now() - 3 * 60 * 1000,
    });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'A4. expired cookie → REAUTH_NEEDED');

    // Cookie should be cleaned up
    const cookieAfter = await storage.get('cookie');
    t.assertEq(cookieAfter, undefined, 'A4b. expired cookie removed from storage');
  }

  // ── Group B: Fast Path — Cookie Match ──────────────────────────
  console.log('\n── Group B: Fast Path (Cookie Match) ──\n');

  // B1. Local cookie valid + remote cookie matches → READY (fast path)
  {
    const { sync, storage, crypto, transport } = createSyncService({ withTransport: true, withMasterKey: true });

    // Create a local cookie
    await storage.set('cookie', {
      device_specifier: 'spec-match',
      creation_time: Date.now(),
    });

    // Push matching remote cookie
    await pushRemoteCookie(transport, 'dev-aaaa111', 'spec-match');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'B1. matching cookies → READY (fast path)');

    // Fast path should push blob and touch local cookie
    // Verify local cookie creation_time was updated
    const cookieAfter = await storage.get('cookie');
    t.assert(cookieAfter.creation_time >= Date.now() - 5000, 'B1b. local cookie creation_time touched');

    // Verify blob was pushed to remote
    const blobBytes = await transport.pull(BLOB_PATH);
    t.assert(blobBytes !== null, 'B1c. blob pushed to remote on fast path');
  }

  // ── Group C: Specifier Mismatch → REAUTH_NEEDED ──────────────────
  console.log('\n── Group C: Specifier Mismatch ──\n');

  // C1. Cookie specifier mismatch → REAUTH_NEEDED (even with master key)
  {
    const { sync, storage, crypto, transport } = createSyncService({ withTransport: true, withMasterKey: true });

    // Local cookie with specifier 'spec-local'
    await storage.set('cookie', {
      device_specifier: 'spec-local',
      creation_time: Date.now(),
    });

    // Remote cookie with different specifier
    await pushRemoteCookie(transport, 'dev-cccc111', 'spec-remote-different');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'C1. specifier mismatch → REAUTH_NEEDED');

    // Master key should still be set (not cleared)
    t.assert(crypto.hasMasterKey(), 'C1b. master key preserved after REAUTH_NEEDED');
  }

  // C2. Specifier mismatch forces auth regardless of cached master key
  {
    const { sync, storage, transport } = createSyncService({ withTransport: true, withMasterKey: true });

    await storage.set('cookie', {
      device_specifier: 'spec-mine',
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'dev-other', 'spec-theirs');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'C2. specifier mismatch with valid MK → REAUTH_NEEDED');
  }

  // ── Group D: Remote Unreachable → OFFLINE ──────────────────────
  console.log('\n── Group D: Remote Unreachable ──\n');

  // D1. Remote transport throws on cookie pull → OFFLINE
  {
    const { sync, storage, transport } = createSyncService({ withTransport: true });

    await storage.set('cookie', {
      device_specifier: 'spec-1',
      creation_time: Date.now(),
    });
    transport._offline = true;

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.OFFLINE, 'D1. remote unreachable on cookie pull → OFFLINE');
  }

  // D2. Remote unreachable during reconcile pull → OFFLINE
  {
    const { sync, storage, crypto, transport } = createSyncService({ withTransport: true, withMasterKey: true });

    // Set up: local cookie valid, no remote cookie, master key set
    await storage.set('cookie', {
      device_specifier: 'spec-2',
      creation_time: Date.now(),
    });
    // No remote cookie → should enter _reconcileAndClaim
    // But make transport fail during the reconcile
    transport._offline = true;

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.OFFLINE, 'D2. remote offline during reconcile → OFFLINE');
  }

  // ── Group E: _reconcileAndClaim — Case A (Same Device UUID → Push Only) ──
  //
  // _reconcileAndClaim is reached when the outer checkAndSync sees NO remote
  // cookie but we have a valid local cookie + master key. It internally
  // re-pulls the remote cookie. If that inner pull finds a cookie with the
  // same device UUID → Case A (push only, no pull/merge).
  //
  // NOTE: With the per-device UUID (getOrCreateDeviceUuid), the device UUID
  // is a UUID4 stored in IndexedDB, NOT derived from the master key. Tests
  // must pre-populate storage with a known UUID4 and use same UUID4 in the
  // remote cookie to simulate Case A (same device).
  //
  console.log('\n── Group E: Reconcile — Case A (Same UUID) ──\n');

  // Shared UUID4 for Case A tests
  const CASE_A_UUID = 'a1b2c3d4-e5f6-4abc-8def-0123456789ab';

  // E1. Same device UUID → push blob only (no pull/merge), READY
  {
    const mk = 'same-devuuid-same-devuuid-same-devuuid-same1234';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Pre-populate per-device UUID in storage (simulates IndexedDB)
    await storage.set('device_uuid', CASE_A_UUID);

    // Local cookie valid
    await storage.set('cookie', {
      device_specifier: 'spec-case-a',
      creation_time: Date.now(),
    });

    // Two-phase cookie pull:
    //   Pull 1 (outer checkAndSync): null → no remote cookie → enters _reconcileAndClaim
    //   Pull 2 (inner _reconcileAndClaim): cookie with SAME device UUID → Case A
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: CASE_A_UUID,
      device_specifier: 'spec-old-case-a',
    })));

    await sync.capture({ title: 'Case A task', startEpoch: 1000 });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'E1. same device UUID → READY');

    // Verify blob was pushed (not pulled/merged)
    const blobBytes = await transport.pull(BLOB_PATH);
    t.assert(blobBytes !== null, 'E1b. blob pushed to remote');

    // Local cookie should be touched with updated creation_time
    const localCookieAfter = await storage.get('cookie');
    t.assert(localCookieAfter.creation_time >= Date.now() - 5000, 'E1c. local cookie touched');
  }

  // E2. Same UUID: remote blob is NOT pulled (Case A = push only)
  {
    const mk = 'case-a-2--case-a-2--case-a-2--case-a-2--aa';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Pre-populate per-device UUID in storage (same device = Case A)
    await storage.set('device_uuid', CASE_A_UUID);

    await storage.set('cookie', {
      device_specifier: 'spec-e2',
      creation_time: Date.now(),
    });

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: CASE_A_UUID,
      device_specifier: 'spec-remote-e2',
    })));

    // Pre-populate remote with an entry that should NOT be pulled (Case A)
    await pushRemoteBlob(transport, crypto, [
      { entry_id: 'remote-only', title: 'Remote Entry', start_epoch: 5000 }
    ], CASE_A_UUID, mk);

    await sync.capture({ title: 'Local Case A2', startEpoch: 1000 });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'E2. Case A READY (push only)');

    const entries = await sync.readEntries();
    t.assertEq(entries.length, 1, 'E2b. still one local entry (Case A did not pull)');
    t.assertEq(entries[0].title, 'Local Case A2', 'E2c. local entry preserved');
  }

  // ── Group F: _reconcileAndClaim — Case B (Different UUID → Pull + Merge) ──
  console.log('\n── Group F: Reconcile — Case B (Different UUID) ──\n');

  // F1. Different device UUID → pull remote blob, merge, push merged, READY
  {
    const mkLocal = 'local-mk-local-mk-local-mk-local-mk-local12';
    const mkRemote = 'other-mk-other-mk-other-mk-other-mk-other12';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mkLocal,
    });

    await storage.set('cookie', {
      device_specifier: 'spec-local-f1',
      creation_time: Date.now(),
    });

    // Two-phase: outer sees null → enters reconcile; inner sees different UUID → Case B
    const remoteDeviceUuid = `dev-${mkRemote.slice(0, 8)}`;
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: remoteDeviceUuid,
      device_specifier: 'spec-remote-f1',
    })));

    // Push remote blob with an entry from the other device
    await pushRemoteBlob(transport, crypto, [
      { entry_id: 'remote-e1', title: 'Remote Task', start_epoch: 5000 }
    ], remoteDeviceUuid, mkLocal);

    await sync.capture({ title: 'Local Task F1', startEpoch: 1000 });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'F1. different device UUID → READY (merge)');

    const entries = await sync.readEntries();
    t.assertEq(entries.length, 2, 'F1b. two entries after merge');
    const titles = entries.map(e => e.title).sort();
    t.assertDeepEq(titles, ['Local Task F1', 'Remote Task'], 'F1c. both entries present after merge');
  }

  // F2. Case B first-time: no remote cookie at all → push local + new cookie
  {
    const mkLocal = 'first-time--first-time--first-time--first-time';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mkLocal,
    });

    await storage.set('cookie', {
      device_specifier: 'spec-f2',
      creation_time: Date.now(),
    });

    // No remote cookie at all (both pulls return null) → first-time Case B
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    await sync.capture({ title: 'First Time Task', startEpoch: 1000 });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'F2. no remote cookie at all → READY');

    const entries = await sync.readEntries();
    t.assertEq(entries.length, 1, 'F2b. local entry survived');

    const blobBytes = await transport.pull(BLOB_PATH);
    t.assert(blobBytes !== null, 'F2c. blob pushed to remote');

    const newCookie = await storage.get('cookie');
    t.assert(!!newCookie, 'F2d. new local cookie created');
  }

  // ── Group G: BLOB_KEY_MISMATCH → OFFLINE ───────────────────────
  console.log('\n── Group G: BLOB_KEY_MISMATCH Handling ──\n');

  // G1. Remote blob exists but can't be decrypted → OFFLINE (data preserved)
  {
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'my-keykk-my-keykk-my-keykk-my-keykk-my-keykk',
    });

    await storage.set('cookie', {
      device_specifier: 'spec-g1',
      creation_time: Date.now(),
    });

    // Two-phase: outer sees null → enters reconcile; inner sees different UUID → Case B
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: 'dev-other-g1',
      device_specifier: 'spec-other-g1',
    })));

    // Push a remote blob encrypted with a DIFFERENT key (simulating wrong passphrase)
    const otherKey = 'wrong-key-wrong-key-wrong-key-wrong-key1';
    const otherCrypto = new MockCrypto();
    otherCrypto.setMasterKey(otherKey);
    await pushRemoteBlob(transport, otherCrypto, [
      { entry_id: 'undecryptable', title: 'Secret', start_epoch: 5000 }
    ], 'dev-other-g1', otherKey);

    await sync.capture({ title: 'My Task G1', startEpoch: 1000 });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.OFFLINE, 'G1. BLOB_KEY_MISMATCH → OFFLINE (data safety)');

    const entries = await sync.readEntries();
    t.assertEq(entries.length, 1, 'G1b. local entries preserved');
    t.assertEq(entries[0].title, 'My Task G1', 'G1c. local data intact');
  }

  // ── Group H: Edge Cases ─────────────────────────────────────────
  console.log('\n── Group H: Edge Cases ──\n');

  // H1. No local cookie + remote reachable + no master key → REAUTH_NEEDED
  {
    const { sync } = createSyncService({ withTransport: true, withMasterKey: false });
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'H1. no cookie + no MK → REAUTH_NEEDED');
  }

  // H2. Local cookie with empty specifier → treated as invalid → REAUTH_NEEDED
  {
    const { sync, storage } = createSyncService({ withTransport: true });
    await storage.set('cookie', {
      device_specifier: '',
      creation_time: Date.now(),
    });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'H2. empty specifier → REAUTH_NEEDED');

    const cookieAfter = await storage.get('cookie');
    t.assertEq(cookieAfter, undefined, 'H2b. corrupt cookie removed');
  }

  // H3. Remote cookie parse fails → fall through to auth gate
  {
    const { sync, storage, transport } = createSyncService({ withTransport: true });

    await storage.set('cookie', {
      device_specifier: 'spec-h3',
      creation_time: Date.now(),
    });

    await transport.push(COOKIE_PATH, new TextEncoder().encode('not-valid-json!!!'));

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'H3. unparseable remote cookie → REAUTH_NEEDED');
  }

  // H4. Cookie TTL exactly at boundary
  {
    const { sync, storage } = createSyncService({ withTransport: true, cookieTtl: 1 });

    await storage.set('cookie', {
      device_specifier: 'spec-boundary',
      creation_time: Date.now() - 30 * 1000,
    });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED, 'H4. cookie within TTL but no MK → REAUTH_NEEDED');

    const cookieAfter = await storage.get('cookie');
    t.assert(!!cookieAfter, 'H4b. cookie within TTL preserved');
  }

  // H5. Empty remote (no cookie, no blob) + valid MK + valid local cookie → reconcile
  {
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'empty-remote-empty-remote-empty-remote-mk99',
    });

    await storage.set('cookie', {
      device_specifier: 'spec-h5',
      creation_time: Date.now(),
    });

    // Empty remote — both pulls return null → first-time Case B
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    await sync.capture({ title: 'Empty Remote Task', startEpoch: 1000 });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'H5. empty remote + valid local → READY');

    const newCookie = await storage.get('cookie');
    t.assert(!!newCookie && !!newCookie.device_specifier, 'H5b. new cookie created');
  }

  // H6. Multiple entries merged correctly in Case B
  {
    const mkLocal = 'multi-merge-multi-merge-multi-merge-multi1234';
    const mkRemote = 'multi-other-multi-other-multi-other-multi9876';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mkLocal,
    });

    await storage.set('cookie', {
      device_specifier: 'spec-h6',
      creation_time: Date.now(),
    });

    const remoteUuid = `dev-${mkRemote.slice(0, 8)}`;
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: remoteUuid,
      device_specifier: 'spec-remote-h6',
    })));

    // Push remote blob with 3 entries
    await pushRemoteBlob(transport, crypto, [
      { entry_id: 'r1', title: 'Remote A', start_epoch: 5000 },
      { entry_id: 'r2', title: 'Remote B', start_epoch: 7000 },
      { entry_id: 'r3', title: 'Remote C', start_epoch: 9000 },
    ], remoteUuid, mkLocal);

    await sync.capture({ title: 'Local A', startEpoch: 1000 });
    await sync.capture({ title: 'Local B', startEpoch: 3000 });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'H6. multi-entry merge → READY');

    const entries = await sync.readEntries();
    t.assertEq(entries.length, 5, 'H6b. 5 entries after merge (2 local + 3 remote)');

    const starts = entries.map(e => e.start_epoch);
    t.assertDeepEq(starts, [1000, 3000, 5000, 7000, 9000], 'H6c. entries sorted by start_epoch');
  }

  // H7. MK cleared by TTL monitor → checkAndSync returns REAUTH_NEEDED
  {
    const { sync, storage, crypto } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'h7-ttl-test-h7-ttl-test-h7-ttl-test-h7-xx',
    });

    // Set up: valid local cookie exists but we simulate TTL monitor clearing MK
    await storage.set('cookie', {
      device_specifier: 'spec-h7',
      creation_time: Date.now(),
    });

    // Simulate TTL monitor clearing the MK
    crypto.setMasterKey(null);

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED,
      'H7. MK cleared by TTL monitor → REAUTH_NEEDED');
  }

  // H8. After reauth MK restore + fresh cookie → checkAndSync returns READY
  {
    const mk = 'h8-fresh-mk-h8-fresh-mk-h8-fresh-mk-h8-yy';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('cookie', {
      device_specifier: 'spec-h8',
      creation_time: Date.now(),
    });

    // Remote has matching cookie
    await pushRemoteCookie(transport, `dev-${mk.slice(0, 8)}`, 'spec-h8');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY,
      'H8. fresh cookie after reauth MK restore → READY (fast path)');
  }

  // ═══════════════════════════════════════════════════════════════
  // Group I: Genesis Gate Integration
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group I: Genesis Gate Integration ──\n');

  const LEDGER_BLOCKS_KEY = 'ledger:blocks';
  const ZERO_HASH = '0'.repeat(64);

  /** Build a minimal valid genesis block + one day block for testing. */
  function buildTestChain(opts = {}) {
    const {
      username = 'testuser',
      email = 'test@example.com',
      formatVersion = '0.3.0',
    } = opts;

    const genesisContent = {
      type: 'genesis',
      format_version: formatVersion,
      day_index: 0,
      date: '2026-01-01',
      identity: {
        username,
        email,
        recovery_seed_enc: 'enc:mockseed',
        identity_pub_key: 'mockpubkey0000000000000000000000000000000000000000000000000000',
        identity_secret_enc_fallback: 'enc:mocksecret',
      },
      prev_hash: ZERO_HASH,
      entries: [],
    };

    const crypt = new MockCrypto();
    crypt.setMasterKey(opts.mk || 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

    // Seal the genesis block
    genesisContent.day_hash = crypt.sealBlock({ ...genesisContent });

    // Build a day block
    const entryData = {
      title: 'Test Entry',
      startTime_enc: 'enc:1700000000000',
      endTime_enc: 'enc:1700003600000',
      duration: 3600000,
      tags: [],
      pauses_enc: 'enc:[]',
      metadata_enc: 'enc:{}',
      comment: '',
      media: [],
      content_hash: crypt.sha256(JSON.stringify({ title: 'Test Entry', duration: 3600000 })),
    };
    const dayEntry = {
      hash: crypt.sha256(JSON.stringify(entryData, null, 2)),
      data: entryData,
    };

    const dayContent = {
      type: 'day',
      day_index: 1,
      date: '2026-06-20',
      prev_hash: genesisContent.day_hash,
      entries: [dayEntry],
    };
    dayContent.day_hash = crypt.sealBlock({ ...dayContent });

    return [genesisContent, dayContent];
  }

  /**
   * Push a chain to the mock remote in canonical blocks format.
   * Each block is obfuscated and stored as ledger/blocks/NNNNNN.json.
   * @param {MockTransport} transport
   * @param {object[]} chain
   * @param {string} [mk='deadbeef'] - Master key for obfuscation.
   */
  async function pushRemoteChain(transport, chain, mk = 'deadbeef') {
    if (!chain || chain.length === 0) return;
    const crypt = new MockCrypto();
    for (let i = 0; i < chain.length; i++) {
      const block = chain[i];
      const dayIndex = block.day_index ?? i;
      const filename = String(dayIndex).padStart(6, '0') + '.json';
      const json = JSON.stringify(block);
      const b64 = crypt.obfuscateBlob(json, mk);
      const bytes = _base64ToBytes(b64);
      await transport.push('ledger/blocks/' + filename, bytes);
    }
  }

  /**
   * Read a remote chain from block files for test assertions.
   * @param {MockTransport} transport
   * @param {string} [mk='deadbeef'] - Master key for deobfuscation.
   * @returns {Promise<object[]|null>}
   */
  async function pullRemoteChain(transport, mk = 'deadbeef') {
    const files = await transport.listFiles('ledger/blocks/');
    if (!files || files.length === 0) return null;
    const sorted = [...files].sort();
    const crypt = new MockCrypto();
    const chain = [];
    for (const filename of sorted) {
      const raw = await transport.pull('ledger/blocks/' + filename);
      if (!raw) continue;
      const b64 = _bytesToBase64(raw);
      const json = crypt.deobfuscateBlob(b64, mk);
      chain.push(JSON.parse(json));
    }
    return chain;
  }

  // I1. Genesis compatible → checkAndSync proceeds to auth gate
  {
    const mk = 'genesis-gate-test-genesis-gate-test-gen123';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'I1. genesis compatible → does NOT return GENESIS_MISMATCH');
    t.assert(result === SyncResult.READY || result === SyncResult.REAUTH_NEEDED,
      'I1b. genesis compatible → proceeds to normal auth gate (READY or REAUTH_NEEDED)');
  }

  // I2. Genesis mismatch → checkAndSync returns GENESIS_MISMATCH
  {
    const mkLocal = 'genesis-gate-local-genesis-gate-local-aa';
    const mkRemote = 'genesis-gate-remote-genesis-gate-remot-bb';
    const localChain = buildTestChain({ mk: mkLocal, username: 'local' });
    const remoteChain = buildTestChain({ mk: mkRemote, username: 'remote' });

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mkLocal,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    await pushRemoteChain(transport, remoteChain, mkRemote);

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.GENESIS_MISMATCH,
      'I2. genesis mismatch → GENESIS_MISMATCH');
  }

  // I3. resetGenesisGate clears cache → re-checks on next call
  {
    const mk = 'genesis-cache-test-genesis-cache-test-cc';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // First: compatible chain → cache set to true
    await pushRemoteChain(transport, chain, mk);
    const result1 = await sync.checkAndSync();
    t.assertNeq(result1, SyncResult.GENESIS_MISMATCH,
      'I3. first check → compatible (cache set)');

    // Reset cache
    sync.resetGenesisGate();

    // Push a different remote chain (different genesis)
    const badChain = buildTestChain({ mk: 'bad-bad-bad-bad-bad-bad-bad-bad-bad-zz', username: 'evil' });
    await pushRemoteChain(transport, badChain, 'bad-bad-bad-bad-bad-bad-bad-bad-bad-zz');

    const result2 = await sync.checkAndSync();
    t.assertEq(result2, SyncResult.GENESIS_MISMATCH,
      'I3b. after reset → re-checks and detects mismatch');
  }

  // I4. Cached incompatible genesis → second call returns GENESIS_MISMATCH
  //   (does NOT fall through to fast path/auth gate where cookie/blob
  //    pulls could fail with 403, producing a misleading OFFLINE status)
  {
    const mkLocal = 'genesis-cache-false-genesis-cache-fals-dd';
    const mkRemote = 'genesis-cache-evil-genesis-cache-evil-ee';
    const localChain = buildTestChain({ mk: mkLocal, username: 'local' });
    const remoteChain = buildTestChain({ mk: mkRemote, username: 'remote' });

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mkLocal,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    await pushRemoteChain(transport, remoteChain, mkRemote);

    // First call: genesis mismatch → caches false
    const result1 = await sync.checkAndSync();
    t.assertEq(result1, SyncResult.GENESIS_MISMATCH,
      'I4. first call → GENESIS_MISMATCH (cache set)');

    // Second call: _genesisCompatible is false (cached)
    // Must return GENESIS_MISMATCH immediately, not fall through
    // to the fast path. To verify it doesn't hit the transport,
    // we can break the transport and confirm it still returns
    // GENESIS_MISMATCH (not OFFLINE).
    const origPull = transport.pull.bind(transport);
    transport.pull = () => { throw new Error('Network error (403)'); };

    const result2 = await sync.checkAndSync();
    t.assertEq(result2, SyncResult.GENESIS_MISMATCH,
      'I4b. second call → GENESIS_MISMATCH (cached, did not fall through to fast path)');

    // Restore transport for cleanup
    transport.pull = origPull;
  }

  // ═══════════════════════════════════════════════════════════════
  // Group J: _getDeviceId() call-count optimization
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group J: _getDeviceId() Call Optimization ──\n');

  /**
   * SpySyncService — extends SyncService to count _getDeviceId() calls.
   */
  class SpySyncService extends SyncService {
    constructor(storage, crypto, transport, options) {
      super(storage, crypto, transport, options);
      this._getDeviceIdCallCount = 0;
    }
    async _getDeviceId() {
      this._getDeviceIdCallCount++;
      return super._getDeviceId();
    }
    resetDeviceIdCount() {
      this._getDeviceIdCallCount = 0;
    }
  }

  function createSpySync({ withTransport = true, withMasterKey = false, masterKey = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' } = {}) {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    const transport = withTransport ? new MockTransport() : null;
    if (withMasterKey) {
      crypto.setMasterKey(masterKey);
    }
    const sync = new SpySyncService(storage, crypto, transport, { cookieTtlMinutes: 30 });
    return { sync, storage, crypto, transport };
  }

  // J1. _reconcileAndClaim Case A: _getDeviceId() called exactly once
  {
    const mk = 'j1-casea--j1-casea--j1-casea--j1-casea--aa';
    const { sync, storage, transport } = createSpySync({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('device_uuid', CASE_A_UUID);
    await storage.set('cookie', {
      device_specifier: 'spec-j1',
      creation_time: Date.now(),
    });

    // Two-phase: outer sees null, inner sees same UUID → Case A
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: CASE_A_UUID,
      device_specifier: 'spec-remote-j1',
    })));

    await sync.capture({ title: 'J1 task', startEpoch: 1000 });
    sync.resetDeviceIdCount(); // reset after capture

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'J1. Case A → READY');
    t.assertEq(sync._getDeviceIdCallCount, 1,
      'J1b. _getDeviceId called exactly once in _reconcileAndClaim Case A');
  }

  // J2. _reconcileAndClaim Case B: _getDeviceId() called exactly once
  {
    const mk = 'j2-caseb--j2-caseb--j2-caseb--j2-caseb--bb';
    const { sync, storage, transport } = createSpySync({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('cookie', {
      device_specifier: 'spec-j2',
      creation_time: Date.now(),
    });

    // Two-phase: outer sees null, inner sees different UUID → Case B
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: 'dev-other-j2',
      device_specifier: 'spec-remote-j2',
    })));

    await sync.capture({ title: 'J2 task', startEpoch: 1000 });
    sync.resetDeviceIdCount(); // reset after capture

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'J2. Case B → READY');
    t.assertEq(sync._getDeviceIdCallCount, 1,
      'J2b. _getDeviceId called exactly once in _reconcileAndClaim Case B');
  }

  // J3. pushBlobOnly with explicit deviceId skips internal _getDeviceId call
  {
    const mk = 'j3-pbo---j3-pbo---j3-pbo---j3-pbo---cc';
    const { sync, storage, crypto } = createSpySync({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('device_uuid', CASE_A_UUID);
    await sync.capture({ title: 'J3 task', startEpoch: 1000 });
    sync.resetDeviceIdCount();

    // Call pushBlobOnly with explicit deviceId → should NOT call _getDeviceId
    await sync.pushBlobOnly(mk, CASE_A_UUID);
    t.assertEq(sync._getDeviceIdCallCount, 0,
      'J3. pushBlobOnly with explicit deviceId → _getDeviceId NOT called');
  }

  // J4. pushBlobOnly without explicit deviceId still works (backward compat)
  {
    const mk = 'j4-pbo---j4-pbo---j4-pbo---j4-pbo---dd';
    const { sync, storage, transport } = createSpySync({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('device_uuid', CASE_A_UUID);
    await sync.capture({ title: 'J4 task', startEpoch: 1000 });
    sync.resetDeviceIdCount();

    // Call pushBlobOnly without deviceId → should call _getDeviceId once
    await sync.pushBlobOnly(mk);
    t.assertEq(sync._getDeviceIdCallCount, 1,
      'J4. pushBlobOnly without deviceId → _getDeviceId called once');

    // Verify blob was pushed correctly
    const blobBytes = await transport.pull(BLOB_PATH);
    t.assert(blobBytes !== null, 'J4b. blob pushed to remote');
  }

  // J5. pushToRemote calls _getDeviceId exactly once
  {
    const mk = 'j5-ptr---j5-ptr---j5-ptr---j5-ptr---ee';
    const { sync, storage } = createSpySync({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('device_uuid', CASE_A_UUID);
    await sync.capture({ title: 'J5 task', startEpoch: 1000 });
    sync.resetDeviceIdCount();

    await sync.pushToRemote(mk);
    t.assertEq(sync._getDeviceIdCallCount, 1,
      'J5. pushToRemote → _getDeviceId called exactly once');
  }

  // ═══════════════════════════════════════════════════════════════
  // Group K: reconfigure() Transport Hot-Swap
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group K: reconfigure() Transport Hot-Swap ──\n');

  // K1. reconfigure(null) on a service with transport → isRemoteAvailable false
  {
    const { sync } = createSyncService({ withTransport: true });
    t.assert(sync.isRemoteAvailable, 'K1. initially → remote available');

    sync.reconfigure(null);
    t.assert(!sync.isRemoteAvailable, 'K1b. after reconfigure(null) → remote NOT available');
  }

  // K2. reconfigure(newTransport) on a service with no transport → isRemoteAvailable true
  {
    const { sync } = createSyncService({ withTransport: false });
    t.assert(!sync.isRemoteAvailable, 'K2. initially → remote NOT available');

    const newTransport = new MockTransport();
    sync.reconfigure(newTransport);
    t.assert(sync.isRemoteAvailable, 'K2b. after reconfigure(newTransport) → remote available');
  }

  // K3. reconfigure swaps to a different transport → operations use the new one
  {
    const { sync, storage } = createSyncService({ withTransport: true, withMasterKey: true });
    t.assert(sync.isRemoteAvailable, 'K3. original transport available');

    // Create a new transport with a cookie already present
    const newTransport = new MockTransport();
    await pushRemoteCookie(newTransport, 'dev-0001', 'spec-k3');

    sync.reconfigure(newTransport);
    t.assert(sync.isRemoteAvailable, 'K3b. after reconfigure → remote still available');

    // Verify the new transport is used: checkRemotePing should succeed
    // (cookie exists on new transport)
    const pingOk = await sync.checkRemotePing();
    t.assert(pingOk, 'K3c. checkRemotePing succeeds against new transport');
  }

  // K4. reconfigure cleans up active genesis check promise
  // (If a genesis check was in-flight, reconfigure must NOT resolve
  //  with a stale/null transport and then set stale cache.)
  {
    const mk = 'k4-reconf-k4-reconf-k4-reconf-k4-reconf-aa';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Prepare local chain so genesis gate will fire
    const chain = buildTestChain({ mk });
    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // First: compatible remote → cache = true
    await pushRemoteChain(transport, chain, mk);
    const result1 = await sync.checkAndSync();
    t.assertNeq(result1, SyncResult.GENESIS_MISMATCH,
      'K4. first check → compatible (cache set)');

    // Now reconfigure to a new transport with an INCOMPATIBLE chain
    const newTransport = new MockTransport();
    const badChain = buildTestChain({ mk: 'bad-k4---bad-k4---bad-k4---bad-k4---zz', username: 'evil' });
    await pushRemoteChain(newTransport, badChain, mk);

    sync.reconfigure(newTransport);

    // After reconfigure, genesis cache should be cleared → re-check detects mismatch
    const result2 = await sync.checkAndSync();
    t.assertEq(result2, SyncResult.GENESIS_MISMATCH,
      'K4b. after reconfigure → genesis re-checked, mismatch detected');
  }

  // K5. reconfigure does not affect local staging data
  {
    const { sync } = createSyncService({ withTransport: true, withMasterKey: true });

    const entry = await sync.capture({ title: 'K5 entry', startEpoch: 1000 });
    t.assert(entry, 'K5. entry captured before reconfigure');

    const newTransport = new MockTransport();
    sync.reconfigure(newTransport);

    // Entry should still be in local cache
    const entries = await sync.readEntries();
    t.assertEq(entries.length, 1, 'K5b. local entry preserved after reconfigure');
    t.assertEq(entries[0].title, 'K5 entry', 'K5c. entry data intact');
  }

  // K6. reconfigure from null → transport → transitions from local-only to remote-capable
  {
    const { sync } = createSyncService({
      withTransport: false,
      withMasterKey: true,
    });

    // No transport → checkAndSync short-circuits to READY
    t.assert(!sync.isRemoteAvailable, 'K6. no transport → remote NOT available');
    const result1 = await sync.checkAndSync();
    t.assertEq(result1, SyncResult.READY, 'K6b. no transport → checkAndSync short-circuits to READY');

    // Reconfigure with a transport → becomes remote-capable
    const newTransport = new MockTransport();
    sync.reconfigure(newTransport);
    t.assert(sync.isRemoteAvailable, 'K6c. after reconfigure → remote available');

    // checkRemotePing confirms the new transport is actually reachable
    const pingOk = await sync.checkRemotePing();
    t.assert(pingOk, 'K6d. checkRemotePing confirms new transport reachable');
  }

  // ═══════════════════════════════════════════════════════════════
  // Group L: getCompleted() Deduplication
  // ═══════════════════════════════════════════════════════════════
  //
  // Bug: getCompleted() returns committed entries twice — once from
  // the ledger chain (ledger:blocks) and once from the staging cache
  // (entries). The staging filter `!e.is_active` does not exclude
  // committed entries. Fix: `!e.is_active && !e.committed`.
  //
  console.log('\n── Group L: getCompleted() Deduplication ──\n');

  /** Build a minimal block for placing a committed entry in the chain. */
  function buildBlockWithEntry(entryId, title, startEpoch, endEpoch, duration) {
    return {
      type: 'day',
      day_index: 0,
      date: new Date(startEpoch).toISOString().slice(0, 10),
      prev_hash: '0'.repeat(64),
      day_hash: 'aa'.repeat(32),
      entries: [{
        hash: `hash-${entryId}`,
        data: {
          entry_id: entryId,
          title,
          startTime_enc: `plain:${startEpoch}`,
          endTime_enc: `plain:${endEpoch}`,
          duration: duration || 0,
          is_active: false,
          is_paused: false,
          pauses_enc: 'plain:[]',
          metadata_enc: 'plain:{}',
          tags: [],
          comment: null,
          media: [],
          device_uuid: '',
          end_device_uuid: '',
        },
      }],
    };
  }

  // L1. Capture → end → commit → getCompleted returns exactly 1 (from chain, not staging)
  {
    const { sync, storage } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'l1-dedup-l1-dedup-l1-dedup-l1-dedup-l1-aa',
    });

    await sync.capture({ title: 'L1 Dedup Task', startEpoch: 1000 });
    const allEntries = await sync.readEntries();
    const entry = allEntries.find(e => e.title === 'L1 Dedup Task');
    t.assert(entry, 'L1. entry captured');
    t.assert(entry.entry_id, 'L1b. entry has entry_id');

    await sync.end('L1 Dedup Task', 2000);

    // Place the committed entry in the ledger chain
    const block = buildBlockWithEntry(entry.entry_id, 'L1 Dedup Task', 1000, 2000, 1000);
    await storage.set('ledger:blocks', [block]);

    // Mark committed in staging — this sets committed=true, is_active=false
    await sync.markCommitted([entry.entry_id], 1);

    const completed = await sync.getCompleted();
    t.assertEq(completed.length, 1,
      `L1c. getCompleted returns exactly 1 entry (got ${completed.length})`);
    if (completed.length === 1) {
      t.assertEq(completed[0].title, 'L1 Dedup Task', 'L1d. correct entry returned');
      t.assert(completed[0].committed === true, 'L1e. entry marked committed');
    }
  }

  // L2. End entry without commit → getCompleted returns 1 (from staging only)
  {
    const { sync } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'l2-staging-l2-staging-l2-staging-l2-staging-bb',
    });

    const entry = await sync.capture({ title: 'L2 Staging Only', startEpoch: 3000 });
    t.assert(entry, 'L2. entry captured');

    await sync.end('L2 Staging Only', 4000);
    // NOT committed — stays in staging with committed=false, is_active=false

    const completed = await sync.getCompleted();
    t.assertEq(completed.length, 1,
      `L2b. getCompleted returns 1 uncommitted entry (got ${completed.length})`);
    if (completed.length === 1) {
      t.assertEq(completed[0].title, 'L2 Staging Only', 'L2c. correct entry');
      t.assert(!completed[0].committed, 'L2d. entry NOT marked committed');
    }
  }

  // L3. Mixed: 1 committed (in chain) + 1 uncommitted → getCompleted returns exactly 2
  {
    const { sync, storage } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'l3-mixed-l3-mixed-l3-mixed-l3-mixed-l3-cc',
    });

    // Entry A: capture → end → commit (will be in chain)
    await sync.capture({ title: 'L3 Committed', startEpoch: 5000 });
    let allEntries = await sync.readEntries();
    const entryA = allEntries.find(e => e.title === 'L3 Committed');
    t.assert(entryA && entryA.entry_id, 'L3a. committed entry captured');
    await sync.end('L3 Committed', 6000);
    const block = buildBlockWithEntry(entryA.entry_id, 'L3 Committed', 5000, 6000, 1000);
    await storage.set('ledger:blocks', [block]);
    await sync.markCommitted([entryA.entry_id], 1);

    // Entry B: capture → end (no commit — stays in staging only)
    await sync.capture({ title: 'L3 Uncommitted', startEpoch: 7000 });
    await sync.end('L3 Uncommitted', 8000);

    const completed = await sync.getCompleted();
    t.assertEq(completed.length, 2,
      `L3. getCompleted returns exactly 2 entries (got ${completed.length})`);

    const titles = completed.map(e => e.title).sort();
    t.assertDeepEq(titles, ['L3 Committed', 'L3 Uncommitted'],
      'L3b. both entries present, no duplicates');

    // Verify one is committed, one is not
    const committedOnes = completed.filter(e => e.committed);
    t.assertEq(committedOnes.length, 1, 'L3c. exactly 1 committed entry');
    const uncommittedOnes = completed.filter(e => !e.committed);
    t.assertEq(uncommittedOnes.length, 1, 'L3d. exactly 1 uncommitted entry');
  }

  // L4. Active entry (is_active=true) excluded from getCompleted
  {
    const { sync } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'l4-active-l4-active-l4-active-l4-active-l4-dd',
    });

    // Active entry — never ended
    await sync.capture({ title: 'L4 Active Task', startEpoch: 9000 });

    // Also create a completed entry to ensure getCompleted isn't just empty
    const done = await sync.capture({ title: 'L4 Done Task', startEpoch: 10000 });
    await sync.end('L4 Done Task', 11000);

    const completed = await sync.getCompleted();
    t.assertEq(completed.length, 1,
      `L4. getCompleted excludes active entry (got ${completed.length})`);
    if (completed.length >= 1) {
      t.assertEq(completed[0].title, 'L4 Done Task',
        'L4b. only the completed entry returned');
    }

    // Confirm active entry exists in staging
    const activeEntries = await sync.getActive();
    t.assertEq(activeEntries.length, 1, 'L4c. active entry still in staging');
    t.assertEq(activeEntries[0].title, 'L4 Active Task', 'L4d. correct active entry');
  }

  // ═══════════════════════════════════════════════════════════════
  // Group M: Same-Genesis Merge + Remote Push
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group M: Same-Genesis Merge + Remote Push ──\n');

  /**
   * Build a single entry with content_hash for merge dedup.
   * Uses 'enc:' prefix convention matching the existing buildTestChain.
   */
  function makeChainEntry(crypto, { title, startEpoch, endEpoch }) {
    const duration = endEpoch ? endEpoch - startEpoch : 0;
    const data = {
      title,
      startTime_enc: `enc:${startEpoch}`,
      endTime_enc: endEpoch != null ? `enc:${endEpoch}` : undefined,
      duration,
      content_hash: crypto.sha256(JSON.stringify({ title, duration })),
      tags: [],
      pauses_enc: 'enc:[]',
      metadata_enc: 'enc:{}',
      comment: '',
      media: [],
    };
    return {
      hash: crypto.sha256(JSON.stringify(data, null, 2)),
      data,
    };
  }

  /**
   * Build a full ledger chain: genesis + day blocks grouped by date.
   * Each entry spec: { title, startEpoch, endEpoch }
   */
  function makeChain(mk, entrySpecs) {
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);

    // Genesis block
    const genesisContent = {
      type: 'genesis',
      format_version: '0.3.0',
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
    };
    genesisContent.day_hash = crypt.sealBlock({ ...genesisContent });

    const chain = [genesisContent];
    let dayIndex = 1;

    for (const spec of entrySpecs) {
      const entry = makeChainEntry(crypt, spec);
      const dateStr = new Date(spec.startEpoch).toISOString().slice(0, 10);
      const prevHash = crypt.sealBlock({ ...chain[chain.length - 1] });

      const dayContent = {
        type: 'day',
        day_index: dayIndex,
        date: dateStr,
        prev_hash: prevHash,
        entries: [entry],
      };
      dayContent.day_hash = crypt.sealBlock({ ...dayContent });
      chain.push(dayContent);
      dayIndex++;
    }

    return chain;
  }

  // ── M1: Same-genesis divergence → merged chain pushed to remote ──
  {
    const mk = 'm1-merge---m1-merge---m1-merge---m1-merge---aa';
    const localChain = makeChain(mk, [
      { title: 'Local Entry', startEpoch: 1700000000000, endEpoch: 1700003600000 },
    ]);
    const remoteChain = makeChain(mk, [
      { title: 'Remote Entry', startEpoch: 1700100000000, endEpoch: 1700103600000 },
    ]);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Set up local ledger
    await storage.set(LEDGER_BLOCKS_KEY, localChain);

    // Push remote chain to transport
    await pushRemoteChain(transport, remoteChain, mk);

    // Two-phase cookie: none (enter reconcile), none (first-time Case B)
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'M1. same-genesis divergence → NOT genesis mismatch');

    // Verify local chain was merged (both entries present)
    const localBlocks = await storage.get(LEDGER_BLOCKS_KEY);
    t.assert(Array.isArray(localBlocks), 'M1b. local blocks still an array');

    // Count entries across all day blocks in merged chain
    let localEntryCount = 0;
    const localTitles = [];
    for (const b of localBlocks) {
      if (b.type === 'day' || b.type === undefined) {
        for (const e of (b.entries || [])) {
          localEntryCount++;
          localTitles.push(e.data.title);
        }
      }
    }
    t.assertEq(localEntryCount, 2,
      `M1c. local chain has 2 entries after merge (got ${localEntryCount})`);
    t.assert(localTitles.includes('Local Entry'), 'M1d. local entry preserved');
    t.assert(localTitles.includes('Remote Entry'), 'M1e. remote entry merged in');

    // Verify merged chain was pushed to remote
    const pushedChain = await pullRemoteChain(transport, mk);
    t.assert(pushedChain !== null && pushedChain.length > 0,
      'M1f. merged chain pushed to remote');
    if (pushedChain) {
      let remoteTitles = [];
      for (const b of pushedChain) {
        if (b.type === 'day' || b.type === undefined) {
          for (const e of (b.entries || [])) {
            remoteTitles.push(e.data.title);
          }
        }
      }
      t.assert(remoteTitles.includes('Local Entry'),
        'M1g. remote now has Local Entry (was local-only)');
    }
  }

  // ── M2: Identical chains → no unnecessary push, stats show 0 changes ──
  {
    const mk = 'm2-ident---m2-ident---m2-ident---m2-ident---bb';
    const chain = makeChain(mk, [
      { title: 'Same Entry', startEpoch: 1700000000000, endEpoch: 1700003600000 },
    ]);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'M2. identical chains → NOT genesis mismatch');

    // Verify local chain unchanged (still 1 entry)
    const localBlocks = await storage.get(LEDGER_BLOCKS_KEY);
    let entryCount = 0;
    for (const b of localBlocks) {
      if (b.type === 'day' || b.type === undefined) {
        entryCount += (b.entries || []).length;
      }
    }
    t.assertEq(entryCount, 1,
      `M2b. local chain unchanged (1 entry, got ${entryCount})`);
  }

  // ── M3: Merge stats exposed to caller ──
  {
    const mk = 'm3-stats---m3-stats---m3-stats---m3-stats---cc';
    const localChain = makeChain(mk, [
      { title: 'Alpha', startEpoch: 1700000000000, endEpoch: 1700003600000 },
    ]);
    const remoteChain = makeChain(mk, [
      { title: 'Beta', startEpoch: 1700100000000, endEpoch: 1700103600000 },
      { title: 'Gamma', startEpoch: 1700200000000, endEpoch: 1700203600000 },
    ]);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    await pushRemoteChain(transport, remoteChain, mk);

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    await sync.checkAndSync();

    const stats = sync.lastMergeStats;
    t.assert(stats !== null && stats !== undefined,
      'M3. lastMergeStats is populated after merge');
    if (stats) {
      t.assertEq(stats.localEntries, 1,
        `M3b. localEntries = 1 (got ${stats.localEntries})`);
      t.assertEq(stats.remoteEntries, 2,
        `M3c. remoteEntries = 2 (got ${stats.remoteEntries})`);
      t.assertEq(stats.duplicatesSkipped, 0,
        `M3d. duplicatesSkipped = 0 (got ${stats.duplicatesSkipped})`);
      t.assertEq(stats.mergedEntries, 3,
        `M3e. mergedEntries = 3 (got ${stats.mergedEntries})`);
      // forkIndex should be 0 (common: genesis only)
      t.assertEq(stats.forkIndex, 0,
        `M3f. forkIndex = 0 (got ${stats.forkIndex})`);
      t.assert(typeof stats.newBlockCount === 'number',
        'M3g. newBlockCount is a number');
    }
  }

  // ── M4: Local merge survives reconciliation failures ──
  {
    const mk = 'm4-resilient-m4-resilient-m4-resilient-aa';
    const localChain = makeChain(mk, [
      { title: 'Keep Me', startEpoch: 1700000000000, endEpoch: 1700003600000 },
    ]);
    const remoteChain = makeChain(mk, [
      { title: 'Add Me', startEpoch: 1700100000000, endEpoch: 1700103600000 },
    ]);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    await pushRemoteChain(transport, remoteChain, mk);

    // Set up cookie: valid local cookie, no remote cookie -> reconcile
    await storage.set('cookie', {
      device_specifier: 'spec-m4',
      creation_time: Date.now(),
    });

    // No remote cookie (two-phase: outer null, inner null → first-time Case B)
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    // Case B reconcile will try pushBlobOnly — make it fail to verify
    // that an earlier ledger merge survived the later staging failure.
    transport._pushError = new Error('Simulated push failure');

    // checkAndSync should not throw — the genesis gate merge runs first,
    // so even if reconcile fails, the merged chain is persisted.
    await sync.checkAndSync().catch(() => {
      // Expected: reconcile push failure is non-fatal for ledger merge
    });

    // Ledger chain merge happened BEFORE the staging blob push —
    // local merged chain should still be intact.
    const localBlocks = await storage.get(LEDGER_BLOCKS_KEY);
    let titles = [];
    for (const b of localBlocks) {
      if (b.type === 'day' || b.type === undefined) {
        for (const e of (b.entries || [])) {
          titles.push(e.data.title);
        }
      }
    }
    t.assert(titles.includes('Keep Me'),
      'M4. local entry preserved despite reconciliation failure');
    t.assert(titles.includes('Add Me'),
      'M4b. remote entry merged into local despite reconciliation failure');
    t.assertEq(titles.length, 2,
      `M4c. local has 2 merged entries (got ${titles.length})`);

    // Clean up for subsequent tests
    transport._pushError = null;
  }

  // ── M4b: Push failure during ledger chain upload → local preserved ──
  // (This test will be meaningful in GREEN phase when ledger push exists.
  //  For now, it verifies the RED-phase gap: no push happens, remote
  //  still has the old pre-merge data.)
  {
    const mk = 'm4b-pushgap-m4b-pushgap-m4b-pushgap-m4b-bb';
    const localChain = makeChain(mk, [
      { title: 'Only Mine', startEpoch: 1700000000000, endEpoch: 1700003600000 },
    ]);
    const remoteChain = makeChain(mk, [
      { title: 'Only Theirs', startEpoch: 1700100000000, endEpoch: 1700103600000 },
    ]);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    await pushRemoteChain(transport, remoteChain, mk);

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    await sync.checkAndSync();

    // Local should have both entries (merged)
    const localBlocks = await storage.get(LEDGER_BLOCKS_KEY);
    let localTitles = [];
    for (const b of localBlocks) {
      if (b.type === 'day' || b.type === undefined) {
        for (const e of (b.entries || [])) {
          localTitles.push(e.data.title);
        }
      }
    }
    t.assert(localTitles.includes('Only Mine'), 'M4b1. local entry preserved');
    t.assert(localTitles.includes('Only Theirs'), 'M4b2. remote entry merged in');

    // RED-PHASE ASSERTION: remote still has only the original chain.
    // This SHOULD fail (no push yet). In GREEN phase, this will become:
    // "remote should have merged chain with both entries".
    const remoteRaw = await transport.pull(LEDGER_BLOCKS_KEY);
    if (remoteRaw) {
      const remoteBlocks = JSON.parse(new TextDecoder().decode(remoteRaw));
      let remoteTitles = [];
      for (const b of remoteBlocks) {
        if (b.type === 'day' || b.type === undefined) {
          for (const e of (b.entries || [])) {
            remoteTitles.push(e.data.title);
          }
        }
      }
      // RED phase: remote has old chain (1 entry). GREEN phase: should have 2.
      t.assert(remoteTitles.includes('Only Mine'),
        'M4b3. RED→GREEN: remote should have Only Mine after ledger push');
    }
  }

  // ── M5: Only local has extra blocks → remote gets merged result ──
  {
    const mk = 'm5-localx--m5-localx--m5-localx--m5-localx--ee';
    const chain = makeChain(mk, [
      { title: 'Shared Entry', startEpoch: 1700000000000, endEpoch: 1700003600000 },
    ]);
    const localChain = makeChain(mk, [
      { title: 'Shared Entry', startEpoch: 1700000000000, endEpoch: 1700003600000 },
      { title: 'Local Only', startEpoch: 1700100000000, endEpoch: 1700103600000 },
    ]);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    // Remote only has the shared entry
    await pushRemoteChain(transport, chain, mk);

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    await sync.checkAndSync();

    // Local should still have both entries
    const localBlocks = await storage.get(LEDGER_BLOCKS_KEY);
    let localTitles = [];
    for (const b of localBlocks) {
      if (b.type === 'day' || b.type === undefined) {
        for (const e of (b.entries || [])) {
          localTitles.push(e.data.title);
        }
      }
    }
    t.assert(localTitles.includes('Shared Entry'), 'M5. shared entry in local');
    t.assert(localTitles.includes('Local Only'), 'M5b. local-only entry preserved');
    t.assertEq(localTitles.length, 2,
      `M5c. local has 2 entries (got ${localTitles.length})`);

    // Verify merged chain was pushed to remote
    const remoteChain = await pullRemoteChain(transport, mk);
    t.assert(remoteChain !== null && remoteChain.length > 0,
      'M5d. merged chain pushed to remote (ledger:blocks not null)');
    if (remoteChain) {
      let remoteTitles = [];
      for (const b of remoteChain) {
        if (b.type === 'day' || b.type === undefined) {
          for (const e of (b.entries || [])) {
            remoteTitles.push(e.data.title);
          }
        }
      }
      t.assert(remoteTitles.includes('Local Only'),
        'M5e. remote now has Local Only entry');
    }
  }

  // ── M6: Only remote has extra blocks → local updated + remote pushed ──
  {
    const mk = 'm6-remotex-m6-remotex-m6-remotex-m6-remotex-ff';
    const chain = makeChain(mk, [
      { title: 'Shared Entry', startEpoch: 1700000000000, endEpoch: 1700003600000 },
    ]);
    const remoteChain = makeChain(mk, [
      { title: 'Shared Entry', startEpoch: 1700000000000, endEpoch: 1700003600000 },
      { title: 'Remote Only', startEpoch: 1700100000000, endEpoch: 1700103600000 },
    ]);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Local only has shared entry
    await storage.set(LEDGER_BLOCKS_KEY, chain);
    // Remote has shared + extra
    await pushRemoteChain(transport, remoteChain, mk);

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    await sync.checkAndSync();

    // Local should now have both entries (remote entry merged in)
    const localBlocks = await storage.get(LEDGER_BLOCKS_KEY);
    let localTitles = [];
    for (const b of localBlocks) {
      if (b.type === 'day' || b.type === undefined) {
        for (const e of (b.entries || [])) {
          localTitles.push(e.data.title);
        }
      }
    }
    t.assert(localTitles.includes('Shared Entry'), 'M6. shared entry in local');
    t.assert(localTitles.includes('Remote Only'),
      'M6b. remote-only entry merged into local');
    t.assertEq(localTitles.length, 2,
      `M6c. local has 2 entries after merge (got ${localTitles.length})`);

    // Verify merged chain was pushed to remote
    const pushedChain = await pullRemoteChain(transport, mk);
    t.assert(pushedChain !== null && pushedChain.length > 0,
      'M6d. merged chain pushed to remote');
    if (pushedChain) {
      let remoteTitles = [];
      for (const b of pushedChain) {
        if (b.type === 'day' || b.type === undefined) {
          for (const e of (b.entries || [])) {
            remoteTitles.push(e.data.title);
          }
        }
      }
      t.assert(remoteTitles.includes('Remote Only'),
        'M6e. remote now has Remote Only entry');
      t.assert(remoteTitles.includes('Shared Entry'),
        'M6f. remote retains Shared Entry');
    }
  }

  // ── M7: Multiple divergent blocks post-fork on both sides ──
  {
    const mk = 'm7-multidiv-m7-multidiv-m7-multidiv-m7-multidiv';
    // Local: genesis + day1(Local A) + day2(Local B)
    // Remote: genesis + day1(Remote X) + day2(Remote Y)
    // Post-merge: genesis + rebuilt blocks with all 4 entries, deduped, sorted
    const localChain = makeChain(mk, [
      { title: 'Local A', startEpoch: 1700000000000, endEpoch: 1700003600000 },
      { title: 'Local B', startEpoch: 1700100000000, endEpoch: 1700103600000 },
    ]);
    const remoteChain = makeChain(mk, [
      { title: 'Remote X', startEpoch: 1700050000000, endEpoch: 1700053600000 },
      { title: 'Remote Y', startEpoch: 1700150000000, endEpoch: 1700153600000 },
    ]);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    await pushRemoteChain(transport, remoteChain, mk);

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    await sync.checkAndSync();

    // After merge, local should have 4 unique entries
    const localBlocks = await storage.get(LEDGER_BLOCKS_KEY);
    let localTitles = [];
    for (const b of localBlocks) {
      if (b.type === 'day' || b.type === undefined) {
        for (const e of (b.entries || [])) {
          localTitles.push(e.data.title);
        }
      }
    }
    t.assertEq(localTitles.length, 4,
      `M7. merged chain has 4 entries (got ${localTitles.length})`);
    t.assert(localTitles.includes('Local A'), 'M7b. Local A present');
    t.assert(localTitles.includes('Local B'), 'M7c. Local B present');
    t.assert(localTitles.includes('Remote X'), 'M7d. Remote X present');
    t.assert(localTitles.includes('Remote Y'), 'M7e. Remote Y present');

    // Verify merged chain was pushed to remote
    const pushedChain = await pullRemoteChain(transport, mk);
    t.assert(pushedChain !== null && pushedChain.length > 0,
      'M7f. merged chain pushed to remote (4 entries)');
    if (pushedChain) {
      let remoteTitles = [];
      for (const b of pushedChain) {
        if (b.type === 'day' || b.type === undefined) {
          for (const e of (b.entries || [])) {
            remoteTitles.push(e.data.title);
          }
        }
      }
      t.assertEq(remoteTitles.length, 4,
        `M7g. remote has 4 entries (got ${remoteTitles.length})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Group N: clearRemote() — Remote Key Deletion
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group N: clearRemote() ──\n');

  // N1. clearRemote deletes all three known keys from R2
  {
    const mk = 'clear-remote-n1-clear-remote-n1-clear-xx';
    const chain = buildTestChain({ mk });
    const { sync, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Pre-populate all keys on remote
    await pushRemoteChain(transport, chain, mk);
    await transport.push('staging/blobs/current.json', new TextEncoder().encode(JSON.stringify({ entries: [] })));
    await transport.push('staging/blobs/device_cookie.bin', new TextEncoder().encode(JSON.stringify({ device_uuid: 'dev-n1' })));

    const preFiles = await transport.listFiles('ledger/blocks/');
    t.assert(preFiles && preFiles.length > 0, 'N1. pre-condition: block files exist');
    t.assert(transport.hasKey('staging/blobs/current.json'), 'N1b. pre-condition: staging blob exists');
    t.assert(transport.hasKey('staging/blobs/device_cookie.bin'), 'N1c. pre-condition: cookie exists');

    await sync.clearRemote();

    // Block files should be deleted
    const filesAfter = await transport.listFiles('ledger/blocks/');
    t.assert(!filesAfter || filesAfter.length === 0, 'N1d. block files deleted');
    t.assert(!transport.hasKey('staging/blobs/current.json'), 'N1e. staging blob deleted');
    t.assert(!transport.hasKey('staging/blobs/device_cookie.bin'), 'N1f. cookie deleted');
  }

  // N2. clearRemote resets _genesisCompatible to null
  {
    const mk = 'clear-remote-n2-clear-remote-n2-clear-yy';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    // Run checkAndSync to set _genesisCompatible = true
    const result1 = await sync.checkAndSync();
    t.assertNeq(result1, SyncResult.GENESIS_MISMATCH,
      'N2. first check → genesis compatible');

    // Now clear remote — should reset genesis gate
    await sync.clearRemote();

    // Push a bad chain to remote and re-check
    const badChain = buildTestChain({ mk: 'bad-key-n2-bad-key-n2-bad-key-n2-zz', username: 'evil' });
    await pushRemoteChain(transport, badChain, mk);

    const result2 = await sync.checkAndSync();
    t.assertEq(result2, SyncResult.GENESIS_MISMATCH,
      'N2b. after clearRemote → genesis re-checked → mismatch detected');
  }

  // N3. clearRemote resets ETag cache (fresh pull on next request)
  {
    const mk = 'clear-remote-n3-clear-remote-n3-clear-aa';
    const chain = buildTestChain({ mk });
    const { sync, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await pushRemoteChain(transport, chain, mk);

    // Verify block files exist in store
    const preFiles = await transport.listFiles('ledger/blocks/');
    t.assert(preFiles && preFiles.length > 0, 'N3. pre-condition: block files exist');

    await sync.clearRemote();

    // After clearRemote, block files should be gone
    const afterFiles = await transport.listFiles('ledger/blocks/');
    t.assert(!afterFiles || afterFiles.length === 0,
      'N3b. after clearRemote → block files deleted');
  }

  // N4. One key deletion fails (404 on staging:blob) → other keys still deleted → method succeeds
  {
    const mk = 'clear-remote-n4-clear-remote-n4-clear-bb';
    const chain = buildTestChain({ mk });
    const { sync, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Only pre-populate block files and cookie (staging blob is absent = 404)
    await pushRemoteChain(transport, chain, mk);
    await transport.push('staging/blobs/device_cookie.bin', new TextEncoder().encode(JSON.stringify({ device_uuid: 'dev-n4' })));

    const preFiles = await transport.listFiles('ledger/blocks/');
    t.assert(preFiles && preFiles.length > 0, 'N4. pre-condition: block files exist');
    t.assert(!transport.hasKey('staging/blobs/current.json'), 'N4b. pre-condition: staging blob absent (simulates 404)');
    t.assert(transport.hasKey('staging/blobs/device_cookie.bin'), 'N4c. pre-condition: cookie exists');

    // Should not throw — partial failure is OK
    await sync.clearRemote();

    const postFiles = await transport.listFiles('ledger/blocks/');
    t.assert(!postFiles || postFiles.length === 0, 'N4d. block files still deleted');
    t.assert(!transport.hasKey('staging/blobs/device_cookie.bin'), 'N4e. cookie still deleted');
  }

  // N5. All three deletions fail → throws error
  {
    const mk = 'clear-remote-n5-clear-remote-n5-clear-cc';
    const { sync, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Make transport offline so all deletes fail
    transport._offline = true;

    try {
      await sync.clearRemote();
      t.assert(false, 'N5. all deletes fail → should throw');
    } catch (err) {
      t.assert(err.message.includes('Failed to clear'),
        'N5. all deletes fail → throws (got: ' + err.message + ')');
    }

    transport._offline = false;
  }

  // N6. No transport configured → throws
  {
    const { sync } = createSyncService({
      withTransport: false,
      withMasterKey: true,
    });

    try {
      await sync.clearRemote();
      t.assert(false, 'N6. no transport → should throw');
    } catch (err) {
      t.assert(err.message.includes('No remote transport'),
        'N6. no transport → throws (got: ' + err.message + ')');
    }
  }

  // N7. After clearRemote, next checkAndSync treats remote as empty → genesis compatible → pushes fresh ledger:blocks
  {
    const mk = 'clear-remote-n7-clear-remote-n7-clear-dd';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // Pre-populate remote with a bad chain (different genesis) to simulate stale data
    const badChain = buildTestChain({ mk: 'bad-key-n7-bad-key-n7-bad-key-n7-ee', username: 'evil' });
    await pushRemoteChain(transport, badChain, mk);

    // First check: should detect mismatch
    const result1 = await sync.checkAndSync();
    t.assertEq(result1, SyncResult.GENESIS_MISMATCH,
      'N7. first check → GENESIS_MISMATCH (stale remote)');

    // Clear remote (simulates deleting stale data)
    await sync.clearRemote();

    // After clear, check should treat remote as empty → compatible → push fresh chain
    const result2 = await sync.checkAndSync();
    t.assertNeq(result2, SyncResult.GENESIS_MISMATCH,
      'N7b. after clearRemote → genesis re-checked → NOT mismatch');
    t.assert(result2 === SyncResult.READY || result2 === SyncResult.REAUTH_NEEDED,
      'N7c. after clearRemote → proceeds to READY or REAUTH_NEEDED (got: ' + result2 + ')');

    // Verify fresh chain was pushed to remote
    const pushedChain = await pullRemoteChain(transport, mk);
    t.assert(pushedChain !== null && pushedChain.length > 0,
      'N7d. fresh ledger blocks pushed to remote');
  }

  // ── Results ───────────────────────────────────────────────────────
  t.summary('SyncService Auth Gate & Reconcile');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
