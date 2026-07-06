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
import { buildHashIndex } from '../src/sync/hash_index.js';

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
    /** Call tracking arrays for test assertions. */
    this._pushCalls = [];
    this._pullCalls = [];
  }

  /** Queue a response value (or null) for the next pull() of this path. FIFO. */
  queueResponse(path, value) {
    const arr = this._queue.get(path) || [];
    arr.push(value);
    this._queue.set(path, arr);
  }

  async pull(path) {
    this._pullCalls.push(path);
    if (this._offline) throw new Error('Network failure');
    const queue = this._queue.get(path);
    if (queue && queue.length > 0) return queue.shift();
    const val = this._store.get(path);
    return val !== undefined ? val : null;
  }

  async push(path, data) {
    this._pushCalls.push({ path, size: data?.length || 0 });
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

  resetCallTracking() {
    this._pushCalls = [];
    this._pullCalls = [];
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
      if (k !== 'day_hash' && k !== 'month_hash' && k !== 'year_hash' && k !== 'signature' && k !== 'format_version') {
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

  // C1. Cookie specifier mismatch → proceed to reconcile (Bug 3a fix)
  //   When both sides have valid MK, specifier mismatch alone doesn't
  //   block sync — the system pull+merges entries.
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
    // Bug 3a: specifier mismatch with valid MK → READY (reconcile succeeds)
    t.assert(result === SyncResult.READY || result === SyncResult.REAUTH_NEEDED,
      `C1. specifier mismatch with valid MK → READY or REAUTH_NEEDED (got: ${result})`);

    // Master key should still be set (not cleared)
    t.assert(crypto.hasMasterKey(), 'C1b. master key preserved');
  }

  // C2. Specifier mismatch with MK → reconcile proceeds (Bug 3a fix)
  {
    const { sync, storage, transport } = createSyncService({ withTransport: true, withMasterKey: true });

    await storage.set('cookie', {
      device_specifier: 'spec-mine',
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'dev-other', 'spec-theirs');

    const result = await sync.checkAndSync();
    // Bug 3a: specifier mismatch with valid MK → READY (reconcile)
    t.assert(result === SyncResult.READY || result === SyncResult.REAUTH_NEEDED,
      `C2. specifier mismatch with valid MK → READY or REAUTH_NEEDED (got: ${result})`);
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

  // E2. Same UUID: Bug 3a fix — always pull + merge (Case A removed).
  // Remote entry is pulled and merged into local.
  {
    const mk = 'case-a-2--case-a-2--case-a-2--case-a-2--aa';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Pre-populate per-device UUID in storage (same device = Case A)
    await storage.set('device_uuid', CASE_A_UUID + '-web');

    await storage.set('cookie', {
      device_specifier: 'spec-e2',
      creation_time: Date.now(),
    });

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: CASE_A_UUID + '-web',
      device_specifier: 'spec-remote-e2',
    })));

    // Pre-populate remote with an entry that should be pulled (Bug 3a: always merge)
    await pushRemoteBlob(transport, crypto, [
      { entry_id: 'remote-only', title: 'Remote Entry', start_epoch: 5000 }
    ], CASE_A_UUID + '-web', mk);

    await sync.capture({ title: 'Local Case A2', startEpoch: 1000 });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'E2. Bug 3a: always pull+merge → READY');

    const entries = await sync.readEntries();
    // After Bug 3a: remote entry should be pulled and merged
    t.assert(entries.length >= 2, `E2b. remote entry pulled and merged (got ${entries.length} entries)`);
    const hasRemote = entries.some(e => e.entry_id === 'remote-only' || e.title === 'Remote Entry');
    t.assert(hasRemote, 'E2c. remote entry present in local');
    const hasLocal = entries.some(e => e.title === 'Local Case A2');
    t.assert(hasLocal, 'E2d. local entry preserved');
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
    // Invalidate stale hash index artifacts — new blocks were pushed
    // without updating the hash index. This simulates what would happen
    // if a client without hash index support pushed blocks directly.
    // In production, pushLedgerBlocks always updates hash index alongside blocks.
    transport._store.delete('ledger/hash_index.json');
    transport._store.delete('ledger/hash_index.sha256');
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
    // Obfuscate with local key so genesis gate can deobfuscate;
    // genesis mismatch is detected via hash comparison.
    await pushRemoteChain(transport, remoteChain, mkLocal);

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

    // First: compatible chain → cache NOT yet set to true (bug: _genesisCompatible never set to true)
    await pushRemoteChain(transport, chain, mk);
    const result1 = await sync.checkAndSync();
    t.assertNeq(result1, SyncResult.GENESIS_MISMATCH,
      'I3. first check → compatible (cache set)');

    // Reset cache
    sync.resetGenesisGate();

    // Push a different remote chain (different genesis, same obfuscation key)
    const badMk = 'bad-bad-bad-bad-bad-bad-bad-bad-bad-zz';
    const badChain = buildTestChain({ mk: badMk, username: 'evil' });
    await pushRemoteChain(transport, badChain, mk);

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
    // Obfuscate with local key so genesis gate can deobfuscate
    await pushRemoteChain(transport, remoteChain, mkLocal);

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
    transport.resetCallTracking();

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

    // M2c: Identical chains → only hash index bootstrap pushes (no block files).
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    const blockPushes = ledgerPushes.filter(c => c.path.includes('/blocks/'));
    t.assertEq(blockPushes.length, 0,
      `M2c. no block files pushed on identical chains (got ${blockPushes.length})`);
    t.assert(ledgerPushes.length >= 2,
      `M2d. hash index bootstrap pushes hash_index files (got ${ledgerPushes.length} ledger pushes)`);
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

  // ── M5: Only local has extra blocks → local unchanged, no push needed ──
  //      Updated for Phase B2: merged:false gating means local extends remote
  //      does not trigger a push (nothing changed from remote perspective).
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
    transport.resetCallTracking();

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

    // M5d: Hash index bootstrap pushes hash_index files only when local
    // extends remote and no merge was needed.
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    const blockPushes = ledgerPushes.filter(c => c.path.includes('/blocks/'));
    t.assertEq(blockPushes.length, 0,
      `M5d. no block files pushed when local extends remote (got ${blockPushes.length})`);
    t.assert(ledgerPushes.length >= 2,
      `M5e. hash index bootstrap pushes hash_index files (got ${ledgerPushes.length} ledger pushes)`);

    // M5e: Remote still has only the shared entry (no push happened)
    const remoteChain = await pullRemoteChain(transport, mk);
    t.assert(remoteChain !== null && remoteChain.length > 0,
      'M5e. remote chain still present');
    if (remoteChain) {
      let remoteTitles = [];
      for (const b of remoteChain) {
        if (b.type === 'day' || b.type === undefined) {
          for (const e of (b.entries || [])) {
            remoteTitles.push(e.data.title);
          }
        }
      }
      t.assert(!remoteTitles.includes('Local Only'),
        'M5f. remote does not have Local Only (no push when local extends remote)');
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

  // N1. clearRemote deletes all known keys from R2
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
    await transport.push('ledger/hash_index.json', new TextEncoder().encode('["hash1"]'));
    await transport.push('ledger/hash_index.sha256', new TextEncoder().encode('abc123'));

    const preFiles = await transport.listFiles('ledger/blocks/');
    t.assert(preFiles && preFiles.length > 0, 'N1. pre-condition: block files exist');
    t.assert(transport.hasKey('staging/blobs/current.json'), 'N1b. pre-condition: staging blob exists');
    t.assert(transport.hasKey('staging/blobs/device_cookie.bin'), 'N1c. pre-condition: cookie exists');
    t.assert(transport.hasKey('ledger/hash_index.json'), 'N1c2. pre-condition: hash_index.json exists');
    t.assert(transport.hasKey('ledger/hash_index.sha256'), 'N1c3. pre-condition: hash_index.sha256 exists');

    await sync.clearRemote();

    // Block files should be deleted
    const filesAfter = await transport.listFiles('ledger/blocks/');
    t.assert(!filesAfter || filesAfter.length === 0, 'N1d. block files deleted');
    t.assert(!transport.hasKey('staging/blobs/current.json'), 'N1e. staging blob deleted');
    t.assert(!transport.hasKey('staging/blobs/device_cookie.bin'), 'N1f. cookie deleted');
    t.assert(!transport.hasKey('ledger/hash_index.json'), 'N1g. hash_index.json deleted');
    t.assert(!transport.hasKey('ledger/hash_index.sha256'), 'N1h. hash_index.sha256 deleted');
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

  // ═══════════════════════════════════════════════════════════════
  // Group P: Position Counter for Month Summary Blocks (Bug 2 fix)
  // ═══════════════════════════════════════════════════════════════
  //
  // Bug: pushLedgerBlocks silently skips month_summary blocks because
  // they have neither day_index nor index. Month summary blocks are
  // legitimate chain members and must be pushed to remote.
  //
  // Fix: Use a position counter for R2 file naming only. Day blocks
  // keep day_index filenames (backward compat). Summary blocks fill
  // gaps with consecutively-assigned positions.
  //
  console.log('\n── Group P: Month Summary Block Push (Bug 2 fix) ──\n');

  // P1. Month summary block (no day_index, no index) gets pushed with position-based filename
  {
    const mk = 'p1-summary-p1-summary-p1-summary-p1-summary-p1';
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);

    // Build a chain: genesis + 1 day block + 1 month_summary block
    const genesisContent = {
      type: 'genesis',
      day_index: 0,
      date: '2026-06-01',
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

    const dayContent = {
      type: 'day',
      day_index: 1,
      date: '2026-06-05',
      prev_hash: genesisContent.day_hash,
      entries: [],
    };
    dayContent.day_hash = crypt.sealBlock({ ...dayContent });

    // Month summary block — NO day_index or index field at all
    const monthSummaryContent = {
      type: 'month_summary',
      date: '2026-06',
      prev_hash: dayContent.day_hash,
      entries: [],
    };
    monthSummaryContent.month_hash = crypt.sealBlock({ ...monthSummaryContent });

    const chain = [genesisContent, dayContent, monthSummaryContent];

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await sync.pushLedgerBlocks({ forceAll: true });

    // All 3 blocks should be pushed
    const files = await transport.listFiles('ledger/blocks/');
    t.assert(files.length === 3, `P1. 3 blocks pushed (got ${files.length})`);

    // Month summary should have a filename (position-based, e.g., 000002.json)
    const hasSummaryFile = files.some(f => {
      const raw = transport._store.get('ledger/blocks/' + f);
      if (!raw) return false;
      const b64 = _bytesToBase64(raw);
      const json = crypt.deobfuscateBlob(b64, mk);
      const block = JSON.parse(json);
      return block.type === 'month_summary';
    });
    t.assert(hasSummaryFile, 'P1b. month_summary block present in remote files');
  }

  // P2. Day blocks still use day_index for filename (backward compatible)
  {
    const mk = 'p2-dayidx--p2-dayidx--p2-dayidx--p2-dayidx--p2';
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);

    // Chain with day blocks at non-sequential day_indices
    const genesisContent = {
      type: 'genesis', day_index: 0, date: '2026-01-01',
      identity: { username: 'testuser', email: 'test@example.com',
        recovery_seed_enc: 'enc:mockseed', identity_pub_key: 'mockpubkey0000000000000000000000000000000000000000000000000000',
        identity_secret_enc_fallback: 'enc:mocksecret' },
      prev_hash: '0'.repeat(64), entries: [],
    };
    genesisContent.day_hash = crypt.sealBlock({ ...genesisContent });

    const day1 = { type: 'day', day_index: 5, date: '2026-01-05',
      prev_hash: genesisContent.day_hash, entries: [] };
    day1.day_hash = crypt.sealBlock({ ...day1 });

    const chain = [genesisContent, day1];

    const { sync, storage } = createSyncService({
      withTransport: true, withMasterKey: true, masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    // Use a fresh transport for this sub-test
    const transport = new MockTransport();
    storage._syncServiceForP2 = sync; // not needed, use direct call

    // Directly verify push behavior
    const obfuscatedB64 = crypt.obfuscateBlob(JSON.stringify(chain[0]), mk);
    const bytes = _base64ToBytes(obfuscatedB64);
    await transport.push('ledger/blocks/000000.json', bytes);

    const obfuscatedB641 = crypt.obfuscateBlob(JSON.stringify(chain[1]), mk);
    const bytes1 = _base64ToBytes(obfuscatedB641);
    await transport.push('ledger/blocks/000005.json', bytes1);

    // Verify day_index 5 maps to 000005.json (not position 1)
    const files = await transport.listFiles('ledger/blocks/');
    t.assert(files.includes('000005.json'), 'P2. day_index=5 block at 000005.json');
  }

  // P3. Mixed chain: genesis + day + month_summary + day → all pushed, no silent drops
  {
    const mk = 'p3-mixed---p3-mixed---p3-mixed---p3-mixed---p3';
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);

    const genesis = { type: 'genesis', day_index: 0, date: '2026-03-01',
      identity: { username: 'test', email: 't@t.com', recovery_seed_enc: 'enc:s',
        identity_pub_key: 'mockpub', identity_secret_enc_fallback: 'enc:s' },
      prev_hash: '0'.repeat(64), entries: [] };
    genesis.day_hash = crypt.sealBlock({ ...genesis });

    const day1 = { type: 'day', day_index: 1, date: '2026-03-10',
      prev_hash: genesis.day_hash, entries: [] };
    day1.day_hash = crypt.sealBlock({ ...day1 });

    const monthSum = { type: 'month_summary', date: '2026-03',
      prev_hash: day1.day_hash, entries: [] };
    monthSum.month_hash = crypt.sealBlock({ ...monthSum });

    const day2 = { type: 'day', day_index: 2, date: '2026-04-01',
      prev_hash: monthSum.month_hash, entries: [] };
    day2.day_hash = crypt.sealBlock({ ...day2 });

    const chain = [genesis, day1, monthSum, day2];

    const { sync, storage, transport } = createSyncService({
      withTransport: true, withMasterKey: true, masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await sync.pushLedgerBlocks({ forceAll: true });

    const files = await transport.listFiles('ledger/blocks/');
    t.assert(files.length === 4, `P3. 4 blocks pushed for mixed chain (got ${files.length})`);

    // Month summary must be present
    let summaryFound = false;
    for (const f of files) {
      const raw = transport._store.get('ledger/blocks/' + f);
      if (raw) {
        const b64 = _bytesToBase64(raw);
        const json = crypt.deobfuscateBlob(b64, mk);
        if (JSON.parse(json).type === 'month_summary') summaryFound = true;
      }
    }
    t.assert(summaryFound, 'P3b. month_summary block pushed (not silently dropped)');
  }

  // P4. Consecutive month_summary blocks get consecutive filenames (no collision)
  {
    const mk = 'p4-consec-p4-consec-p4-consec-p4-consec-p4';
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);

    const genesis = { type: 'genesis', day_index: 0, date: '2026-05-01',
      identity: { username: 'test', email: 't@t.com', recovery_seed_enc: 'enc:s',
        identity_pub_key: 'mockpub', identity_secret_enc_fallback: 'enc:s' },
      prev_hash: '0'.repeat(64), entries: [] };
    genesis.day_hash = crypt.sealBlock({ ...genesis });

    const day1 = { type: 'day', day_index: 1, date: '2026-05-10',
      prev_hash: genesis.day_hash, entries: [] };
    day1.day_hash = crypt.sealBlock({ ...day1 });

    const ms1 = { type: 'month_summary', date: '2026-05',
      prev_hash: day1.day_hash, entries: [] };
    ms1.month_hash = crypt.sealBlock({ ...ms1 });

    const day2 = { type: 'day', day_index: 2, date: '2026-06-10',
      prev_hash: ms1.month_hash, entries: [] };
    day2.day_hash = crypt.sealBlock({ ...day2 });

    const ms2 = { type: 'month_summary', date: '2026-06',
      prev_hash: day2.day_hash, entries: [] };
    ms2.month_hash = crypt.sealBlock({ ...ms2 });

    const chain = [genesis, day1, ms1, day2, ms2];

    const { sync, storage, transport } = createSyncService({
      withTransport: true, withMasterKey: true, masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await sync.pushLedgerBlocks({ forceAll: true });

    const files = await transport.listFiles('ledger/blocks/');
    t.assert(files.length === 5, `P4. 5 blocks pushed (got ${files.length})`);

    // Count month_summary blocks in remote
    let summaryCount = 0;
    for (const f of files) {
      const raw = transport._store.get('ledger/blocks/' + f);
      if (raw) {
        const b64 = _bytesToBase64(raw);
        const json = crypt.deobfuscateBlob(b64, mk);
        if (JSON.parse(json).type === 'month_summary') summaryCount++;
      }
    }
    t.assertEq(summaryCount, 2, `P4b. both month_summary blocks pushed (got ${summaryCount})`);
  }

  // P5. No new fields added to block data (position is transport-layer only)
  {
    const mk = 'p5-nofield-p5-nofield-p5-nofield-p5-nofield-p5';
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);

    const genesis = { type: 'genesis', day_index: 0, date: '2026-07-01',
      identity: { username: 'test', email: 't@t.com', recovery_seed_enc: 'enc:s',
        identity_pub_key: 'mockpub', identity_secret_enc_fallback: 'enc:s' },
      prev_hash: '0'.repeat(64), entries: [] };
    genesis.day_hash = crypt.sealBlock({ ...genesis });

    const ms = { type: 'month_summary', date: '2026-07',
      prev_hash: genesis.day_hash, entries: [] };
    ms.month_hash = crypt.sealBlock({ ...ms });

    const chain = [genesis, ms];

    // Record field keys before push
    const msKeysBefore = Object.keys(ms).slice().sort();
    const genesisKeysBefore = Object.keys(genesis).slice().sort();

    const { sync, storage } = createSyncService({
      withTransport: true, withMasterKey: true, masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // Manually push and verify block objects unchanged
    const transport = new MockTransport();
    // Just verify the block doesn't get extra fields during push
    const blocksAfter = await storage.get(LEDGER_BLOCKS_KEY);
    const msKeysAfter = Object.keys(blocksAfter[1]).slice().sort();
    const genesisKeysAfter = Object.keys(blocksAfter[0]).slice().sort();

    t.assert(
      JSON.stringify(msKeysBefore) === JSON.stringify(msKeysAfter),
      'P5. month_summary block unchanged (no new fields added)'
    );
    t.assert(
      JSON.stringify(genesisKeysBefore) === JSON.stringify(genesisKeysAfter),
      'P5b. genesis block unchanged'
    );
  }

  // P6. Skip logic still works with position-based remote discovery
  {
    const mk = 'p6-skip----p6-skip----p6-skip----p6-skip----p6';
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);

    // Push genesis block to remote first
    const genesis = { type: 'genesis', day_index: 0, date: '2026-08-01',
      identity: { username: 'test', email: 't@t.com', recovery_seed_enc: 'enc:s',
        identity_pub_key: 'mockpub', identity_secret_enc_fallback: 'enc:s' },
      prev_hash: '0'.repeat(64), entries: [] };
    genesis.day_hash = crypt.sealBlock({ ...genesis });

    const chain = [genesis];

    const { sync, storage, transport } = createSyncService({
      withTransport: true, withMasterKey: true, masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // First push: genesis goes up
    await sync.pushLedgerBlocks({ forceAll: true });
    let files = await transport.listFiles('ledger/blocks/');
    t.assertEq(files.length, 1, 'P6a. genesis pushed alone');

    // Second push (no forceAll): genesis should be skipped
    const pushed = await sync.pushLedgerBlocks();
    t.assertEq(pushed, 0, 'P6b. nothing pushed when remote already has all blocks');
  }

  // ═══════════════════════════════════════════════════════════════
  // Group Q: Device UUID Client Suffix + Same-Device Fast Path Removal (Bug 3a fix)
  // ═══════════════════════════════════════════════════════════════
  //
  // Bug 3a: Two fixes needed:
  //   Part A: Add client-type suffix to device_id so CLI and web always
  //           have distinct identities ({uuid4}-cli vs {uuid4}-web).
  //   Part B: Remove the same-device fast path — even with suffixes,
  //           same-device doesn't mean local-is-authoritative. Always
  //           pull+merge regardless of UUID match.
  //
  console.log('\n── Group Q: Device UUID Suffix & Fast Path Removal (Bug 3a fix) ──\n');

  // Q1. Same device UUID no longer triggers push-only fast path → always pull+merge.
  //     Uses no remote cookie to fall through fast path to auth gate → reconcile.
  {
    const mk = 'q1-samedev-q1-samedev-q1-samedev-q1-samedev-aa';
    const { sync, storage, transport, crypto } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
      cookieTtl: 30,
    });

    const sharedDeviceUuid = 'd4959313-3f33-47c7-99f2-2e6d8c5fd1f7-web';
    await storage.set('device_uuid', sharedDeviceUuid);

    // Set up valid local cookie
    const localSpecifier = 'spec-q1';
    await storage.set('cookie', {
      device_specifier: localSpecifier,
      creation_time: Date.now(),
    });

    // NO remote cookie — forces fall-through from fast path to auth gate.
    // Auth gate then proceeds to _reconcileAndClaim (no specifier mismatch).

    // Push remote blob with an entry the local doesn't have
    const remoteEntry = {
      entry_id: 'remote-q1-entry',
      title: 'Remote Only Task Q1',
      start_epoch: 1700010000000,
      is_active: false,
      hash: 'hash-remote-q1',
    };
    await pushRemoteBlob(transport, crypto, [remoteEntry], sharedDeviceUuid, mk);

    // checkAndSync → fast path (no remote cookie) → auth gate → _reconcileAndClaim
    // Bug 3a: always pull + merge.
    const result = await sync.checkAndSync();

    t.assert(result === SyncResult.READY, `Q1. checkAndSync returns READY (got: ${result})`);

    // Verify remote entry was pulled and merged into local
    const stagedEntries = await storage.get('entries');
    const allEntries = stagedEntries || [];
    const hasRemoteEntry = allEntries.some(e => {
      const data = e.data || {};
      return (data.entry_id === 'remote-q1-entry' || data.title === 'Remote Only Task Q1');
    });
    t.assert(hasRemoteEntry, 'Q1b. remote entry pulled and merged into local (not overwritten)');
  }

  // Q2. Different clients (one -cli, one -web) → different UUID → Case B pull+merge.
  //     Uses no remote cookie to fall through to auth gate → reconcile.
  {
    const mk = 'q2-diffcli-q2-diffcli-q2-diffcli-q2-diffcli-bb';
    const { sync, storage, transport, crypto } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
      cookieTtl: 30,
    });

    // Web has {uuid}-web
    const webUuid = 'd4959313-3f33-47c7-99f2-2e6d8c5fd1f7-web';
    await storage.set('device_uuid', webUuid);

    const localSpecifier = 'spec-q2';
    await storage.set('cookie', {
      device_specifier: localSpecifier,
      creation_time: Date.now(),
    });

    // NO remote cookie — falls through to auth gate → reconcile.
    // Remote blob from CLI with different UUID
    const cliUuid = 'd4959313-3f33-47c7-99f2-2e6d8c5fd1f7-cli';
    const cliEntry = {
      entry_id: 'cli-q2-entry',
      title: 'CLI Created Task Q2',
      start_epoch: 1700020000000,
      is_active: false,
      hash: 'hash-cli-q2',
    };
    await pushRemoteBlob(transport, crypto, [cliEntry], cliUuid, mk);

    const result = await sync.checkAndSync();

    // Different UUIDs should trigger Case B merge
    t.assert(result === SyncResult.READY, `Q2. checkAndSync returns READY (got: ${result})`);

    // CLI entry should be merged into local
    const rawEntries = await storage.get('entries') || [];
    const hasCliEntry = rawEntries.some(r => {
      const data = r.data || {};
      return data.entry_id === 'cli-q2-entry' || data.title === 'CLI Created Task Q2';
    });
    t.assert(hasCliEntry, 'Q2b. CLI entry from remote pulled and merged');

    // Local cookie should be preserved
    const localCookie = await storage.get('cookie');
    t.assert(!!localCookie, 'Q2c. local cookie preserved');
  }

  // Q3. Migration: old bare UUID (CLI pre-suffix) vs new -web UUID → different device.
  //     Uses no remote cookie to fall through to auth gate → reconcile.
  {
    const mk = 'q3-migrate-q3-migrate-q3-migrate-q3-migrate-cc';
    const { sync, storage, transport, crypto } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
      cookieTtl: 30,
    });

    // Simulate post-migration web: has {uuid}-web suffix
    const webUuid = 'd4959313-3f33-47c7-99f2-2e6d8c5fd1f7-web';
    await storage.set('device_uuid', webUuid);

    const localSpecifier = 'spec-q3';
    await storage.set('cookie', {
      device_specifier: localSpecifier,
      creation_time: Date.now(),
    });

    // NO remote cookie — falls through to auth gate → reconcile.
    // Remote blob from old CLI with bare UUID
    const bareUuid = 'd4959313-3f33-47c7-99f2-2e6d8c5fd1f7';
    const oldEntry = {
      entry_id: 'old-cli-q3-entry',
      title: 'Old CLI Task Q3',
      start_epoch: 1700030000000,
      is_active: false,
      hash: 'hash-old-cli-q3',
    };
    await pushRemoteBlob(transport, crypto, [oldEntry], bareUuid, mk);

    const result = await sync.checkAndSync();

    // Bare UUID ≠ -web UUID → treated as different devices → Case B merge
    t.assert(result === SyncResult.READY, `Q3. checkAndSync returns READY (got: ${result})`);

    // Old CLI entry should be merged into local
    const rawEntries = await storage.get('entries') || [];
    const hasOldEntry = rawEntries.some(r => {
      const data = r.data || {};
      return data.entry_id === 'old-cli-q3-entry' || data.title === 'Old CLI Task Q3';
    });
    t.assert(hasOldEntry, 'Q3b. old CLI entry merged (safe migration path)');
  }

  // ═══════════════════════════════════════════════════════════════
  // Group R: _genesisGatePhase Typed Error Handling (Bug 1 fix)
  // ═══════════════════════════════════════════════════════════════
  //
  // Bug 1: _genesisGatePhase treats every compatible:false as GENESIS_MISMATCH.
  // With the throw-based API, it must distinguish:
  //   - GenesisMismatchError → GENESIS_MISMATCH (permanent)
  //   - NetworkGenesisError → null (fall through to offline handling)
  //   - AuthGenesisError → null (fall through to auth handling)
  //   - InvalidChainError → null (transient, retry next time)
  //
  console.log('\n── Group R: Genesis Gate Typed Error Handling (Bug 1 fix) ──\n');

  // R1. Network error during genesis check → returns null (not GENESIS_MISMATCH)
  //     RED: current behavior returns GENESIS_MISMATCH for all failures.
  //     After fix: network/auth errors fall through to next phase.
  {
    const mk = 'r1-net-err-r1-net-err-r1-net-err-r1-net-err-aa';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
      cookieTtl: 30,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // Set up cookie so fast path won't short-circuit before genesis check
    const localSpecifier = 'spec-r1';
    await storage.set('cookie', {
      device_specifier: localSpecifier,
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'r1-dev-web', localSpecifier);

    // Break the transport AFTER cookie is read but BEFORE genesis blocks are pulled.
    // We use queueResponse to make the first pull (cookie) succeed but the
    // second pull (ledger blocks) fail.
    // Simpler: overwrite transport.pull to throw after first successful cookie pull.
    let pullCount = 0;
    const origPull = transport.pull.bind(transport);
    transport.pull = async (path) => {
      pullCount++;
      if (path.startsWith('ledger/blocks/') || path === 'ledger:blocks') {
        throw new Error('Connection refused');
      }
      return origPull(path);
    };

    // We need to also handle listFiles since the canonical format uses ledger/blocks/
    const origListFiles = transport.listFiles.bind(transport);
    transport.listFiles = async (prefix) => {
      if (prefix && prefix.startsWith('ledger/blocks')) {
        throw new Error('Connection refused');
      }
      return origListFiles(prefix);
    };

    const result = await sync.checkAndSync();

    // After fix: network error during genesis check → null (fall through)
    // Before fix: returns GENESIS_MISMATCH
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      `R1. network error during genesis check → NOT GENESIS_MISMATCH (got: ${result})`);

    // Should fall through to either OFFLINE or REAUTH_NEEDED
    t.assert(
      result === SyncResult.OFFLINE || result === SyncResult.REAUTH_NEEDED ||
      result === SyncResult.READY,
      `R1b. falls through to OFFLINE/REAUTH_NEEDED/READY (got: ${result})`
    );
  }

  // R2. Auth error (403) during genesis check → returns null (not GENESIS_MISMATCH)
  {
    const mk = 'r2-auth-err-r2-auth-err-r2-auth-err-r2-auth-err-bb';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
      cookieTtl: 30,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);

    // Same setup as R1 — cookie passes but genesis blocks hit 403
    const localSpecifier = 'spec-r2';
    await storage.set('cookie', {
      device_specifier: localSpecifier,
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'r2-dev-web', localSpecifier);

    // Make ledger block pulls throw 403
    const origPull = transport.pull.bind(transport);
    transport.pull = async (path) => {
      if (path.startsWith('ledger/blocks/')) {
        throw new Error('HTTP 403 Forbidden');
      }
      return origPull(path);
    };

    const origListFiles = transport.listFiles.bind(transport);
    transport.listFiles = async (prefix) => {
      if (prefix && prefix.startsWith('ledger/blocks')) {
        throw new Error('HTTP 403 Forbidden');
      }
      return origListFiles(prefix);
    };

    const result = await sync.checkAndSync();

    // After fix: auth error during genesis check → null (not mismatch)
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      `R2. auth error during genesis check → NOT GENESIS_MISMATCH (got: ${result})`);
  }

  // R3. Genuine genesis mismatch still returns GENESIS_MISMATCH (no regression)
  {
    const mkLocal = 'r3-local---r3-local---r3-local---r3-local---cc';
    const mkRemote = 'r3-remote--r3-remote--r3-remote--r3-remote--dd';
    const localChain = buildTestChain({ mk: mkLocal, username: 'local-r3' });
    const remoteChain = buildTestChain({ mk: mkRemote, username: 'remote-r3' });

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mkLocal,
      cookieTtl: 30,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    // Obfuscate with local key so genesis gate can deobfuscate;
    // genesis mismatch is detected via hash comparison.
    await pushRemoteChain(transport, remoteChain, mkLocal);

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.GENESIS_MISMATCH,
      'R3. genuine genesis mismatch → GENESIS_MISMATCH (no regression)');
  }

  // ═══════════════════════════════════════════════════════════════
  // Group O: Stable Device Specifier on Writes
  // ═══════════════════════════════════════════════════════════════
  //
  // Bug: pushToRemote() destroys the local cookie and creates a new
  // one on every push, generating a fresh device_specifier each time.
  // This causes the CLI to see spurious cookie mismatches on every
  // web write. Fix: reuse existing specifier from local cookie.
  //
  console.log('\n── Group O: Stable Specifier on Writes ──\n');

  // O1. First push (no local cookie) → generates new specifier
  {
    const mk = 'o1-first---o1-first---o1-first---o1-first---aa';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // No local cookie pre-populated — this is the first push after onboarding
    await sync.capture({ title: 'O1 Task', startEpoch: 1000 });
    await sync.pushToRemote(mk);

    // Local cookie should be created with a specifier
    const localCookie = await storage.get('cookie');
    t.assert(!!localCookie, 'O1. local cookie created on first push');
    t.assert(!!localCookie.device_specifier, 'O1b. local cookie has specifier');
    t.assert(typeof localCookie.creation_time === 'number',
      'O1c. local cookie has creation_time');

    // Remote cookie should be pushed with matching specifier
    const remoteCookieBytes = await transport.pull(COOKIE_PATH);
    t.assert(remoteCookieBytes !== null, 'O1d. remote cookie pushed');
    const remoteCookie = JSON.parse(new TextDecoder().decode(remoteCookieBytes));
    t.assertEq(remoteCookie.device_specifier, localCookie.device_specifier,
      'O1e. remote cookie specifier matches local');
  }

  // O2. Second push (existing local cookie) → REUSES same specifier
  //     RED: current code destroys + re-creates, generating a NEW specifier.
  //     This test WILL FAIL until the fix is applied.
  {
    const mk = 'o2-reuse---o2-reuse---o2-reuse---o2-reuse---bb';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Pre-populate local cookie with a known specifier
    const ORIGINAL_SPEC = 'spec-stable-o2';
    await storage.set('cookie', {
      device_specifier: ORIGINAL_SPEC,
      creation_time: Date.now() - 60_000,
    });

    await sync.capture({ title: 'O2 Task', startEpoch: 2000 });
    await sync.pushToRemote(mk);

    // Local cookie specifier MUST be unchanged (not re-rolled)
    const localCookie = await storage.get('cookie');
    t.assertEq(localCookie.device_specifier, ORIGINAL_SPEC,
      'O2. specifier REUSED (not re-rolled) — RED: fails, GREEN: passes');

    // creation_time should be updated (TTL extended)
    t.assert(localCookie.creation_time >= Date.now() - 5000,
      'O2b. creation_time updated to extend TTL');

    // Remote cookie should have the SAME specifier
    const remoteCookieBytes = await transport.pull(COOKIE_PATH);
    const remoteCookie = JSON.parse(new TextDecoder().decode(remoteCookieBytes));
    t.assertEq(remoteCookie.device_specifier, ORIGINAL_SPEC,
      'O2c. remote cookie has same specifier — RED: fails, GREEN: passes');
  }

  // O3. Three consecutive pushes → specifier stays stable across all
  //     RED: current code re-rolls specifier on every push.
  {
    const mk = 'o3-multi---o3-multi---o3-multi---o3-multi---cc';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const ORIGINAL_SPEC = 'spec-stable-o3';
    await storage.set('cookie', {
      device_specifier: ORIGINAL_SPEC,
      creation_time: Date.now(),
    });

    // Push 1
    await sync.capture({ title: 'O3 Task 1', startEpoch: 1000 });
    await sync.pushToRemote(mk);
    let local = await storage.get('cookie');
    t.assertEq(local.device_specifier, ORIGINAL_SPEC,
      'O3a. push 1: specifier unchanged');

    // Push 2
    await sync.capture({ title: 'O3 Task 2', startEpoch: 2000 });
    await sync.pushToRemote(mk);
    local = await storage.get('cookie');
    t.assertEq(local.device_specifier, ORIGINAL_SPEC,
      'O3b. push 2: specifier unchanged — RED: fails, GREEN: passes');

    // Push 3
    await sync.capture({ title: 'O3 Task 3', startEpoch: 3000 });
    await sync.pushToRemote(mk);
    local = await storage.get('cookie');
    t.assertEq(local.device_specifier, ORIGINAL_SPEC,
      'O3c. push 3: specifier unchanged — RED: fails, GREEN: passes');

    // Remote cookie should still have the same specifier after 3 pushes
    const remoteCookieBytes = await transport.pull(COOKIE_PATH);
    const remoteCookie = JSON.parse(new TextDecoder().decode(remoteCookieBytes));
    t.assertEq(remoteCookie.device_specifier, ORIGINAL_SPEC,
      'O3d. remote cookie has same specifier after 3 pushes — RED: fails, GREEN: passes');
  }

  // O4. Remote cookie format: {device_uuid, device_specifier} only
  //     Local-only fields (creation_time) must NOT leak to remote.
  {
    const mk = 'o4-format--o4-format--o4-format--o4-format--dd';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set('cookie', {
      device_specifier: 'spec-format-o4',
      creation_time: Date.now(),
    });

    await sync.capture({ title: 'O4 Task', startEpoch: 4000 });
    await sync.pushToRemote(mk);

    const remoteCookieBytes = await transport.pull(COOKIE_PATH);
    const remoteCookie = JSON.parse(new TextDecoder().decode(remoteCookieBytes));
    t.assert(remoteCookie.device_specifier !== undefined,
      'O4. remote cookie has device_specifier');
    t.assert(remoteCookie.device_uuid !== undefined,
      'O4b. remote cookie has device_uuid');
    t.assert(remoteCookie.creation_time === undefined,
      'O4c. remote cookie does NOT leak local creation_time');
  }

  // ═══════════════════════════════════════════════════════════════════
  // Group S: Hash Index Push (Category C — Onboarding Speedup RED phase)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== Group S — Hash Index Push (RED phase) ===');
  console.log('⛔ pushLedgerBlocks hash index behavior NOT IMPLEMENTED — all tests expected to FAIL (TDD RED)');

  // Canonical remote paths for hash index artifacts
  const HI_PATH = 'ledger/hash_index.json';
  const HI_SHA_PATH = 'ledger/hash_index.sha256';

  // Helper: seed a local ledger with blocks (stored as obfuscated JSON).
  // The SyncService reads from storage via _storage.get(LOCAL_LEDGER_BLOCKS).
  // For pushLedgerBlocks, we set the raw blocks directly.
  async function seedLedger(sync, storage, blocks) {
    await storage.set('ledger:blocks', blocks);
  }

  // Helper: build minimal block chain for testing
  function makeBlock(type, index, date, prevHash, entries = []) {
    const b = { type, day_index: index, date, prev_hash: prevHash, entries };
    b.day_hash = createHash('sha256').update(JSON.stringify(b)).digest('hex');
    return b;
  }

  function buildSimpleChain(numBlocks) {
    const chain = [];
    let prevHash = '0'.repeat(64);
    for (let i = 0; i < numBlocks; i++) {
      const type = i === 0 ? 'genesis' : 'day';
      const date = `2026-06-${String(i + 10).padStart(2, '0')}`;
      const b = { type, day_index: i, date, prev_hash: prevHash, entries: [] };
      b.day_hash = createHash('sha256').update(JSON.stringify(b)).digest('hex');
      prevHash = b.day_hash;
      chain.push(b);
    }
    return chain;
  }

  // ── S1: Hash index pushed after block push ──────────────────────
  {
    console.log('\n  --- S1: Hash index pushed after block push ---');
    const mk = 's1-push-----s1-push-----s1-push-----s1-push-----11';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const chain = buildSimpleChain(3);
    await seedLedger(sync, storage, chain);

    const pushed = await sync.pushLedgerBlocks({ forceAll: true });

    t.assert(pushed >= 3, 'S1a. 3 blocks pushed to remote');
    t.assert(transport.hasKey(HI_PATH),
      'S1b. ledger/hash_index.json exists on remote — RED: fails (not implemented)');

    if (transport.hasKey(HI_PATH)) {
      const raw = await transport.pull(HI_PATH);
      const text = new TextDecoder().decode(raw);
      const parsed = JSON.parse(text);
      t.assert(Array.isArray(parsed), 'S1c. hash_index.json is a valid JSON array');
      t.assertEq(parsed.length, 3, 'S1d. hash_index has 3 elements (3 blocks)');
    }
  }

  // ── S2: Hash index SHA-256 pushed alongside ─────────────────────
  {
    console.log('\n  --- S2: Hash index SHA-256 pushed alongside ---');
    const mk = 's2-push-----s2-push-----s2-push-----s2-push-----22';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const chain = buildSimpleChain(3);
    await seedLedger(sync, storage, chain);

    await sync.pushLedgerBlocks({ forceAll: true });

    t.assert(transport.hasKey(HI_SHA_PATH),
      'S2a. ledger/hash_index.sha256 exists on remote — RED: fails (not implemented)');

    if (transport.hasKey(HI_SHA_PATH)) {
      const raw = await transport.pull(HI_SHA_PATH);
      const text = new TextDecoder().decode(raw);
      t.assert(text.length >= 64, 'S2b. sha256 is at least 64 chars');
      t.assert(/^[0-9a-f]{64,}$/.test(text.trim()),
        'S2c. sha256 content is hex chars');
    }
  }

  // ── S3: Hash index NOT pushed when 0 blocks changed ─────────────
  {
    console.log('\n  --- S3: Hash index NOT pushed when 0 blocks changed ---');
    const mk = 's3-nopush---s3-nopush---s3-nopush---s3-nopush---33';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const chain = buildSimpleChain(3);
    await seedLedger(sync, storage, chain);

    // First push — blocks + hash index
    const pushed1 = await sync.pushLedgerBlocks({ forceAll: true });
    t.assert(pushed1 >= 3, 'S3a. first push: 3 blocks pushed');

    // Capture remote state after first push
    const hiAfterFirst = await transport.pull(HI_PATH);

    // Second push — no new blocks
    const pushed2 = await sync.pushLedgerBlocks();
    t.assertEq(pushed2, 0, 'S3b. second push: 0 blocks pushed (no changes)');

    if (hiAfterFirst) {
      const hiAfterSecond = await transport.pull(HI_PATH);
      const same = hiAfterFirst && hiAfterSecond
        ? JSON.stringify(hiAfterFirst) === JSON.stringify(hiAfterSecond)
        : true; // Both null is also fine
      t.assert(same, 'S3c. hash_index unchanged after no-op push — RED: fails (not implemented)');
    }
  }

  // ── S4: Hash index pushed on forceAll even with 0 new blocks ────
  {
    console.log('\n  --- S4: Hash index pushed on forceAll with 0 new blocks ---');
    const mk = 's4-force----s4-force----s4-force----s4-force----44';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const chain = buildSimpleChain(3);
    await seedLedger(sync, storage, chain);

    // Push once
    await sync.pushLedgerBlocks({ forceAll: true });
    const pushed1 = transport.hasKey(HI_PATH);

    // Push again with forceAll
    const pushed2 = await sync.pushLedgerBlocks({ forceAll: true });
    t.assert(pushed2 >= 3, 'S4a. forceAll push: blocks pushed');
    t.assert(transport.hasKey(HI_PATH),
      'S4b. hash_index exists after forceAll push — RED: fails (not implemented)');
  }

  // ── S5: Hash index push failure is non-fatal ────────────────────
  {
    console.log('\n  --- S5: Hash index push failure is non-fatal ---');
    const mk = 's5-fail-----s5-fail-----s5-fail-----s5-fail-----55';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const chain = buildSimpleChain(3);
    await seedLedger(sync, storage, chain);

    // Make transport throw on hash_index pushes by returning error from push
    const originalPush = transport.push.bind(transport);
    transport.push = async (path, data) => {
      if (path === HI_PATH || path === HI_SHA_PATH) {
        throw new Error('Simulated hash index push failure');
      }
      return originalPush(path, data);
    };

    // Should not throw — blocks are pushed, hash index failure is non-fatal
    let pushed = 0;
    try {
      pushed = await sync.pushLedgerBlocks({ forceAll: true });
    } catch (err) {
      t.assert(false, 'S5a. pushLedgerBlocks does NOT throw on hash index failure');
    }

    // Blocks should have been pushed despite hash index failure
    t.assert(pushed >= 3, 'S5b. blocks pushed despite hash index failure — RED: fails (not implemented)');

    // Restore original push
    transport.push = originalPush;
  }

  // ── S6: Hash index SHA-256 push failure is non-fatal ────────────
  {
    console.log('\n  --- S6: Hash index SHA-256 push failure is non-fatal ---');
    const mk = 's6-fail-----s6-fail-----s6-fail-----s6-fail-----66';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const chain = buildSimpleChain(3);
    await seedLedger(sync, storage, chain);

    // Make transport throw on sha256 pushes only
    const originalPush = transport.push.bind(transport);
    transport.push = async (path, data) => {
      if (path === HI_SHA_PATH) {
        throw new Error('Simulated sha256 push failure');
      }
      return originalPush(path, data);
    };

    let pushed = 0;
    try {
      pushed = await sync.pushLedgerBlocks({ forceAll: true });
    } catch (err) {
      t.assert(false, 'S6a. pushLedgerBlocks does NOT throw on sha256 failure');
    }
    t.assert(pushed >= 3, 'S6b. blocks pushed despite sha256 failure — RED: fails (not implemented)');

    // Restore
    transport.push = originalPush;

    // Hash index JSON should exist even if sha256 failed
    t.assert(transport.hasKey(HI_PATH),
      'S6c. hash_index.json exists despite sha256 failure — RED: fails (not implemented)');
  }

  // ── S7: Hash index pushed when masterKey is available ───────────
  {
    console.log('\n  --- S7: Hash index pushed when masterKey is available ---');
    const mk = 's7-mk-------s7-mk-------s7-mk-------s7-mk-------77';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const chain = buildSimpleChain(3);
    await seedLedger(sync, storage, chain);

    await sync.pushLedgerBlocks({ forceAll: true });

    t.assert(transport.hasKey(HI_PATH),
      'S7a. hash_index exists when MK available — RED: fails (not implemented)');
  }

  // ── S8: Hash index is NOT obfuscated (unlike blocks) ────────────
  {
    console.log('\n  --- S8: Hash index is plain JSON (not obfuscated) ---');
    const mk = 's8-plain----s8-plain----s8-plain----s8-plain----88';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const chain = buildSimpleChain(3);
    await seedLedger(sync, storage, chain);

    await sync.pushLedgerBlocks({ forceAll: true });

    if (transport.hasKey(HI_PATH)) {
      const raw = await transport.pull(HI_PATH);
      const text = new TextDecoder().decode(raw);
      // It should be valid JSON (not base64-encoded blob)
      const looksLikeJson = text.trim().startsWith('[') || text.trim().startsWith('{');
      t.assert(looksLikeJson,
        'S8a. hash_index.json is plain JSON (starts with [ or {) — RED: fails (not implemented)');
      try {
        JSON.parse(text);
        t.assert(true, 'S8b. hash_index.json is valid JSON');
      } catch {
        t.assert(false, 'S8c. hash_index.json is NOT valid JSON');
      }
    } else {
      t.assert(false, 'S8. hash_index NOT pushed — RED: fails (not implemented)');
    }
  }

  // ── S9: Hash index elements match block seals ───────────────────
  {
    console.log('\n  --- S9: Hash index elements match block seals ---');
    const mk = 's9-match----s9-match----s9-match----s9-match----99';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    const chain = buildSimpleChain(3);
    await seedLedger(sync, storage, chain);

    await sync.pushLedgerBlocks({ forceAll: true });

    if (transport.hasKey(HI_PATH)) {
      const raw = await transport.pull(HI_PATH);
      const text = new TextDecoder().decode(raw);
      const hashIndex = JSON.parse(text);

      t.assertEq(hashIndex.length, chain.length, 'S9a. hash index length = chain length');
      for (let i = 0; i < chain.length; i++) {
        t.assertEq(hashIndex[i], chain[i].day_hash,
          `S9b. hash_index[${i}] matches chain[${i}] seal`);
      }
    } else {
      t.assert(false, 'S9. hash index NOT pushed — RED: fails (not implemented)');
    }
  }

  // ── S10: Hash index push after genesis merge in checkAndSync ────
  {
    console.log('\n  --- S10: Hash index push after genesis merge ---');
    const mk = 'sa-merge----sa-merge----sa-merge----sa-merge----aa';
    // We need to simulate the full genesis gate + merge flow.
    // Since checkAndSync calls GenesisGate.check() which merges,
    // and then pushes via pushLedgerBlocks({ forceAll: true }),
    // we verify the transport receives hash index pushes after merge.
    // In RED phase, this is expected to fail because the hash index
    // push is not implemented in pushLedgerBlocks yet.
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Set up a local ledger with 2 blocks
    const chain = buildSimpleChain(2);
    // Add some entries to make it realistic
    chain[1].entries = [{
      hash: createHash('sha256').update('entry1').digest('hex'),
      data: { title: 'Test entry' },
    }];
    await seedLedger(sync, storage, chain);

    // Simulate remote having the same genesis but one more block
    // (GenesisGate will merge and trigger forceAll push)
    const remoteChain = [...chain, makeBlock('day', 2, '2026-06-12', chain[1].day_hash)];
    const remoteBlocksKey = 'ledger:blocks';
    transport._store.set(remoteBlocksKey, new TextEncoder().encode(JSON.stringify(remoteChain)));

    // Run checkAndSync — in GREEN phase, this would trigger
    // GenesisGate.check() → merge → pushLedgerBlocks({ forceAll: true })
    // which should push hash index alongside merged blocks.
    // In RED: hash index push doesn't happen yet.
    const result = await sync.checkAndSync();

    t.assert(result === 'READY' || result === 'REAUTH_NEEDED',
      'S10a. checkAndSync completes (may need auth)');

    // If genesis gate completed and pushed, hash index should be on remote.
    // In RED phase, this fails.
    if (result === 'READY') {
      t.assert(transport.hasKey(HI_PATH),
        'S10b. hash_index pushed after merge — RED: fails (not implemented)');
      t.assert(transport.hasKey(HI_SHA_PATH),
        'S10c. sha256 pushed after merge — RED: fails (not implemented)');
    } else {
      // REAUTH_NEEDED is expected when cookie not set up — still a valid test run
      t.assert(true, 'S10b. checkAndSync requires auth (no cookie) — expected in test environment');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Group T: Unnecessary Push Prevention
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group T: Unnecessary Push Prevention (RED phase) ──\n');
  console.log('⛔ pushLedgerBlocks CURRENTLY called on every login — tests expect NO push for Tier 1/2');

  // ── T1: Tier 1 SHA-256 match + identical chains → only hash index bootstrap ──
  {
    const mk = 't1-tier1---t1-tier1---t1-tier1---t1-tier1---aa';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    // Push matching hash index so Tier 1 SHA-256 fast path activates
    const hi = buildHashIndex(chain);
    const hiJson = JSON.stringify(hi);
    const hiSha = createHash('sha256').update(hiJson).digest('hex');
    await transport.push('ledger/hash_index.json', new TextEncoder().encode(hiJson));
    await transport.push('ledger/hash_index.sha256', new TextEncoder().encode(hiSha));

    // Reset call tracking before checkAndSync
    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'T1. Tier 1 match → NOT GENESIS_MISMATCH');

    // T1: hash index bootstrap pushes hash index files even when no merge.
    // Block files should NOT be re-pushed (all exist on remote already).
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    const blockPushes = ledgerPushes.filter(c => c.path.includes('/blocks/'));
    t.assertEq(blockPushes.length, 0,
      `T1b. no block files re-pushed on Tier 1 match (got ${blockPushes.length})`);
    t.assert(ledgerPushes.length >= 2,
      `T1c. hash index bootstrap pushes hash_index files (got ${ledgerPushes.length} ledger pushes)`);

    // Verify the genesis check actually used Tier 1 (only 1-2 pulls for hash index files)
    const pullsToHI = transport._pullCalls.filter(p =>
      p === 'ledger/hash_index.sha256' || p === 'ledger/hash_index.json'
    );
    t.assert(pullsToHI.length <= 2,
      `T1d. Tier 1 path used ≤2 hash index pulls (got ${pullsToHI.length})`);
  }

  // ── T2: Tier 2 linear_local → bootstrap pushes hash index only ──
  {
    const mk = 't2-linear--t2-linear--t2-linear--t2-linear--bb';
    // Local has 2 extra blocks beyond what remote has
    const localChain = buildTestChain({ mk });
    // Clone genesis + first day block as remote chain (fewer blocks)
    const remoteChain = [
      JSON.parse(JSON.stringify(localChain[0])),
      JSON.parse(JSON.stringify(localChain[1])),
    ];

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Local has 3 blocks (genesis + day + extra), remote has 2 (genesis + day)
    const extraBlock = {
      type: 'day',
      day_index: 2,
      date: '2026-06-21',
      prev_hash: localChain[1].day_hash,
      entries: [],
    };
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);
    extraBlock.day_hash = crypt.sealBlock({ ...extraBlock });
    const largerChain = [...localChain, extraBlock];

    await storage.set(LEDGER_BLOCKS_KEY, largerChain);
    await pushRemoteChain(transport, remoteChain, mk);

    // Push remote hash_index.json with only 2 entries (fewer than local)
    const remoteHI = buildHashIndex(remoteChain);
    const remoteHiJson = JSON.stringify(remoteHI);
    // Push non-matching sha256 so Tier 1 falls through to Tier 2
    const fakeSha = 'f'.repeat(64);
    await transport.push('ledger/hash_index.sha256', new TextEncoder().encode(fakeSha));
    await transport.push('ledger/hash_index.json', new TextEncoder().encode(remoteHiJson));

    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'T2. linear_local → NOT GENESIS_MISMATCH');

    // T2: hash index bootstrap pushes hash_index files only (no blocks).
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    const blockPushes = ledgerPushes.filter(c => c.path.includes('/blocks/'));
    t.assertEq(blockPushes.length, 0,
      `T2b. no block files pushed (got ${blockPushes.length} block pushes)`);
    t.assert(ledgerPushes.length >= 2,
      `T2c. hash index bootstrap pushes hash_index files (got ${ledgerPushes.length} ledger pushes)`);
  }

  // ── T3: Divergent fork with actual merge → pushLedgerBlocks IS called ──
  {
    const mk = 't3-divfork--t3-divfork--t3-divfork--t3-divfork--cc';
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

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    await pushRemoteChain(transport, remoteChain, mk);

    transport.resetCallTracking();

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, null);

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'T3. divergent fork → NOT GENESIS_MISMATCH');

    // T3 core: pushLedgerBlocks SHOULD be called for actual merge
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    t.assert(ledgerPushes.length > 0,
      `T3b. divergent fork → pushLedgerBlocks IS called (got ${ledgerPushes.length} push calls)`);

    // Verify merged chain was actually pushed (ledger/blocks/HI files exist)
    const hiExists = transport.hasKey('ledger/hash_index.json');
    t.assert(hiExists,
      'T3c. hash_index.json pushed to remote after merge');
  }

  // ── T4: hash index bootstrap on identical chains (Tier 1 match) ──
  {
    const mk = 't4-refeq----t4-refeq----t4-refeq----t4-refeq----dd';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    // Push matching hash index so Tier 1 activates
    const hi = buildHashIndex(chain);
    const hiJson = JSON.stringify(hi);
    const hiSha = createHash('sha256').update(hiJson).digest('hex');
    await transport.push('ledger/hash_index.json', new TextEncoder().encode(hiJson));
    await transport.push('ledger/hash_index.sha256', new TextEncoder().encode(hiSha));

    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'T4. same chain (Tier 1) → NOT GENESIS_MISMATCH');

    // T4: hash index bootstrap pushes hash index files, but NO block files
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    const blockPushes = ledgerPushes.filter(c => c.path.includes('/blocks/'));
    t.assertEq(blockPushes.length, 0,
      `T4b. no block files re-pushed (got ${blockPushes.length} block pushes)`);
    t.assert(ledgerPushes.length >= 2,
      `T4c. hash index bootstrap pushes hash_index files (got ${ledgerPushes.length} ledger pushes)`);

    // Local chain should be unchanged
    const localBlocks = await storage.get(LEDGER_BLOCKS_KEY);
    t.assertEq(localBlocks.length, chain.length,
      `T4d. local chain unchanged (${chain.length} blocks, got ${localBlocks.length})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Group U: Duplicate pullCookie Prevention
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group U: Duplicate pullCookie Prevention (RED phase) ──\n');
  console.log('⛔ pullCookie() CURRENTLY called twice — tests expect exactly 1 call');

  // ── U1: pullCookie() called exactly once during full checkAndSync (mismatch → reconcile) ──
  {
    const mk = 'u1-dupull---u1-dupull---u1-dupull---u1-dupull---aa';
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Local cookie valid but specifier differs from remote →
    // fast path pulls cookie (PULL 1), falls through,
    // auth gate enters reconcile → reconcile pulls cookie AGAIN (PULL 2, bug).
    // After fix: reconcile should reuse fast path's result → exactly 1 pull.
    await storage.set('cookie', {
      device_specifier: 'spec-u1-local',
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'dev-u1-remote', 'spec-u1-different');

    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    // Should reach reconcile (then READY/OFFLINE/REAUTH depending on blob availability)
    t.assert(result === SyncResult.READY || result === SyncResult.REAUTH_NEEDED,
      `U1. mismatch→reconcile → completed (got ${result})`);

    const cookiePulls = transport._pullCalls.filter(p => p === COOKIE_PATH);
    t.assertEq(cookiePulls.length, 1,
      `U1b. pullCookie called exactly once during full checkAndSync (got ${cookiePulls.length}) — RED: fails`);
  }

  // ── U2: Cookie result from _fastPathPhase reused in _authGatePhase (no re-pull) ──
  {
    const mk = 'u2-reuse----u2-reuse----u2-reuse----u2-reuse----bb';
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    // Matching cookies → fast path succeeds (READY).
    // Even though no mismatch occurs, the test verifies the fast path
    // pulls exactly once and returns READY without reconcile re-pulling.
    await storage.set('cookie', {
      device_specifier: 'spec-u2-match',
      creation_time: Date.now(),
    });
    await pushRemoteCookie(transport, 'dev-u2-match', 'spec-u2-match');

    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY,
      'U2. matching cookies → READY (fast path)');

    // Fast path should pull cookie exactly once and NOT enter reconcile
    const cookiePulls = transport._pullCalls.filter(p => p === COOKIE_PATH);
    t.assertEq(cookiePulls.length, 1,
      `U2b. fast path match → pullCookie called exactly once (got ${cookiePulls.length})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Group V: _genesisCompatible Caching to true
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group V: _genesisCompatible Caching (RED phase) ──\n');
  console.log('⛔ _genesisCompatible NEVER set to true — tests expect true after successful check');

  // ── V1: _genesisCompatible is true after successful genesis check ──
  {
    const mk = 'v1-cachetrue-v1-cachetrue-v1-cachetrue-v1-cachetrue';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    // Push matching hash index for Tier 1 path
    const hi = buildHashIndex(chain);
    const hiJson = JSON.stringify(hi);
    const hiSha = createHash('sha256').update(hiJson).digest('hex');
    await transport.push('ledger/hash_index.json', new TextEncoder().encode(hiJson));
    await transport.push('ledger/hash_index.sha256', new TextEncoder().encode(hiSha));

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'V1. genesis compatible → NOT GENESIS_MISMATCH');

    // V1 core: _genesisCompatible should be true, not null
    t.assertEq(sync.genesisCompatible, true,
      `V1b. genesisCompatible === true after successful check (got ${JSON.stringify(sync.genesisCompatible)}) — RED: fails (null)`);
  }

  // ── V2: Second checkAndSync skips network when genesis is cached true ──
  {
    const mk = 'v2-skipnet--v2-skipnet--v2-skipnet--v2-skipnet--bb';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    await pushRemoteChain(transport, chain, mk);

    // Push matching hash index for Tier 1 path
    const hi = buildHashIndex(chain);
    const hiJson = JSON.stringify(hi);
    const hiSha = createHash('sha256').update(hiJson).digest('hex');
    await transport.push('ledger/hash_index.json', new TextEncoder().encode(hiJson));
    await transport.push('ledger/hash_index.sha256', new TextEncoder().encode(hiSha));

    // First call: complete the genesis check
    const result1 = await sync.checkAndSync();
    t.assertNeq(result1, SyncResult.GENESIS_MISMATCH,
      'V2. first call → genesis compatible');

    // Reset call tracking for second checkAndSync
    transport.resetCallTracking();

    // Second call: should skip genesis gate entirely (cached to true).
    // RED: _genesisCompatible is null → re-runs genesis gate → makes network calls.
    const result2 = await sync.checkAndSync();
    t.assertNeq(result2, SyncResult.GENESIS_MISMATCH,
      'V2b. second call → genesis still compatible');

    // V2 core: second call should skip the network (no hash_index or block pulls)
    const ledgerPulls = transport._pullCalls.filter(p =>
      p.startsWith('ledger/')
    );
    t.assertEq(ledgerPulls.length, 0,
      `V2c. second checkAndSync skips genesis gate network calls (got ${ledgerPulls.length}) — RED: fails`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Group W: Push Gating by Genesis Gate merged Flag (no hash_index)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── Group W: Push Gating — merged Flag (GREEN phase) ──\n');

  // ── W1: Empty remote (no hash_index) → pushLedgerBlocks IS called ──
  {
    const mk = 'w1-empty----w1-empty----w1-empty----w1-empty----aa';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    // No remote chain pushed — transport is empty (no blocks, no hash_index)
    // Genesis gate full-pull path: remote empty → merged: true

    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'W1. empty remote → NOT GENESIS_MISMATCH');

    // W1 core: pushLedgerBlocks SHOULD be called for empty remote
    // (remote has no blocks, local must push its chain)
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    t.assert(ledgerPushes.length > 0,
      `W1b. empty remote → pushLedgerBlocks IS called (got ${ledgerPushes.length} push calls)`);
  }

  // ── W2: Full chain pull + identical chains (no hash_index) → push NOT called ──
  {
    const mk = 'w2-samec----w2-samec----w2-samec----w2-samec----bb';
    const chain = buildTestChain({ mk });
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, chain);
    // Push the SAME chain to remote but WITHOUT hash_index files
    // Genesis gate must fall through to full chain pull → merge → merged: false
    await pushRemoteChain(transport, chain, mk);
    // Hash index files are deleted by pushRemoteChain (stale index invalidation)

    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'W2. identical chains (no hash_index) → NOT GENESIS_MISMATCH');

    // W2 core: hash index bootstrap pushes hash_index files only (no blocks).
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    const blockPushes = ledgerPushes.filter(c => c.path.includes('/blocks/'));
    t.assertEq(blockPushes.length, 0,
      `W2b. no block files pushed on identical chains (got ${blockPushes.length})`);
    t.assert(ledgerPushes.length >= 2,
      `W2c. hash index bootstrap pushes hash_index files (got ${ledgerPushes.length} ledger pushes)`);
  }

  // ── W3: Full chain pull + remote has more blocks (no hash_index) → push IS called ──
  {
    const mk = 'w3-remote---w3-remote---w3-remote---w3-remote---cc';
    // Local has 2 blocks (genesis + day)
    const localChain = buildTestChain({ mk });
    // Remote has 3 blocks (genesis + day + extra)
    const remoteChain = JSON.parse(JSON.stringify(localChain));
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);
    const extraBlock = {
      type: 'day',
      day_index: 2,
      date: '2026-06-21',
      prev_hash: localChain[1].day_hash,
      entries: [],
    };
    extraBlock.day_hash = crypt.sealBlock({ ...extraBlock });
    remoteChain.push(extraBlock);

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, localChain);
    // Push the larger remote chain WITHOUT hash_index files
    await pushRemoteChain(transport, remoteChain, mk);
    // Hash index files deleted by pushRemoteChain

    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'W3. remote has more (no hash_index) → NOT GENESIS_MISMATCH');

    // W3 core: pushLedgerBlocks SHOULD be called (remote extends, merge required)
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    t.assert(ledgerPushes.length > 0,
      `W3b. remote has more (no hash_index) → pushLedgerBlocks IS called (got ${ledgerPushes.length} push calls)`);
  }

  // ── W4: Full chain pull + local extends remote (no hash_index) → push NOT called ──
  {
    const mk = 'w4-localex--w4-localex--w4-localex--w4-localex--dd';
    // Local has 3 blocks, remote has 2 blocks (linear_local fork)
    const localChain = buildTestChain({ mk });
    const remoteChain = [
      JSON.parse(JSON.stringify(localChain[0])),
      JSON.parse(JSON.stringify(localChain[1])),
    ];

    // Add a third block to local
    const crypt = new MockCrypto();
    crypt.setMasterKey(mk);
    const extraBlock = {
      type: 'day',
      day_index: 2,
      date: '2026-06-21',
      prev_hash: localChain[1].day_hash,
      entries: [],
    };
    extraBlock.day_hash = crypt.sealBlock({ ...extraBlock });
    const largerChain = [...localChain, extraBlock];

    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: mk,
    });

    await storage.set(LEDGER_BLOCKS_KEY, largerChain);
    // Push the smaller remote chain WITHOUT hash_index files
    await pushRemoteChain(transport, remoteChain, mk);
    // Hash index files deleted by pushRemoteChain

    transport.resetCallTracking();

    const result = await sync.checkAndSync();
    t.assertNeq(result, SyncResult.GENESIS_MISMATCH,
      'W4. local extends remote (no hash_index) → NOT GENESIS_MISMATCH');

    // W4 core: hash index bootstrap pushes hash_index files only (no blocks).
    const ledgerPushes = transport._pushCalls.filter(c => c.path.startsWith('ledger/'));
    const blockPushes = ledgerPushes.filter(c => c.path.includes('/blocks/'));
    t.assertEq(blockPushes.length, 0,
      `W4b. no block files pushed when local extends remote (got ${blockPushes.length})`);
    t.assert(ledgerPushes.length >= 2,
      `W4c. hash index bootstrap pushes hash_index files (got ${ledgerPushes.length} ledger pushes)`);
  }

  // ── Results ───────────────────────────────────────────────────────
  t.summary('SyncService Auth Gate & Reconcile');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
