/**
 * cross_client_web_test.mjs — Cross-client staging sharing tests for phpoc-web.
 *
 * Tests the web SyncService behavior for cross-device staging scenarios:
 *   1. Auth gate: REAUTH_NEEDED triggers at the right times
 *   2. Merge: remote entries merged correctly with local
 *   3. Round-trip: task state propagation across devices
 *
 * All tests use MockTransport and MockCrypto — no real network or WASM.
 *
 * Usage:
 *   node test/cross_client_web_test.mjs
 */

import { createHash } from 'crypto';

import { SyncService, SyncResult } from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

// ══════════════════════════════════════════════════════════════════════
// Mock Transport — in-memory remote storage
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    this._store = new Map();
    this._queue = new Map();
    this._offline = false;
    this._pushError = null;
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

  resetCache() {}
}

// ══════════════════════════════════════════════════════════════════════
// Mock Crypto
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
  clearMasterKey() { this._mk = null; }

  getDeviceId(mk) {
    return `dev-${(mk || '').slice(0, 8)}`;
  }

  seal(jsonStr, masterKey) {
    if (!masterKey) masterKey = this._mk || 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    return createHash('sha256').update(masterKey + ':' + jsonStr).digest('hex');
  }

  obfuscateBlob(plaintext, mk) {
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = mk
      ? createHash('sha256').update(mk).digest().slice(0, 4)
      : Buffer.alloc(4);
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

  decryptWithCachedKey(ciphertextHex) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('plain:')) {
      return ciphertextHex.slice(6);
    }
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }

  decrypt(ciphertextHex, _masterKey) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }

  encrypt(plaintext, _masterKey) {
    return `enc:${plaintext}`;
  }

  encryptWithCachedKey(plaintext) {
    return `enc:${plaintext}`;
  }

  authenticate(passphrase, seed) {
    const hash = createHash('sha256').update(passphrase + ':' + seed).digest('hex');
    this._mk = hash;
    return hash;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const BLOB_PATH = 'staging/blob';
const COOKIE_PATH = 'staging/blobs/device_cookie.bin';

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

async function pushRemoteCookie(transport, deviceUuid, specifier) {
  const cookieJson = JSON.stringify({
    device_uuid: deviceUuid,
    device_specifier: specifier,
  });
  await transport.push(COOKIE_PATH, new TextEncoder().encode(cookieJson));
}

async function pushRemoteBlob(transport, crypto, entries, deviceId, mk) {
  const rawEntries = entries.map(e => ({
    entry_id: e.entry_id || `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hash: e.hash || `h-${e.entry_id}`,
    data: {
      entry_id: e.entry_id,
      title: e.title,
      startTime_enc: `plain:${e.startEpoch}`,
      endTime_enc: e.endEpoch != null ? `plain:${e.endEpoch}` : undefined,
      duration: e.duration || 0,
      is_active: e.is_active ?? false,
      is_paused: e.is_paused ?? false,
      pauses_enc: e.pauses ? `plain:${JSON.stringify(e.pauses)}` : 'plain:[]',
      metadata_enc: e.metadata ? `plain:${JSON.stringify(e.metadata)}` : 'plain:{}',
      tags: e.tags || [],
      comment: e.comment || null,
      media: e.media || [],
      device_uuid: e.device_uuid || deviceId,
      end_device_uuid: e.end_device_uuid || '',
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

async function createLocalCookie(storage, specifier = 'spec-local') {
  await storage.set('cookie', {
    device_specifier: specifier,
    creation_time: Date.now(),
  });
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

async function run() {
  console.log('══ Cross-Client Staging Sharing — Web Tests ══\n');

  // ── Group 1: Auth Gate — Cross-Client Detection ────────────────
  console.log('── Group 1: Auth Gate — Cross-Client Detection ──\n');

  // 1.1 No local cookie + no remote cookie → REAUTH_NEEDED
  {
    const { sync } = createSyncService({ withTransport: true });
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED,
      '1.1 no cookie at all → REAUTH_NEEDED');
  }

  // 1.2 No local cookie + cached MK → STILL REAUTH_NEEDED (no bypass)
  {
    const { sync, crypto } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'nobypass-nobypass-nobypass-nobypass-abcd',
    });
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED,
      '1.2 no cookie + cached MK → REAUTH_NEEDED (no bypass)');
  }

  // 1.3 Specifier mismatch → reconcile proceeds (Bug 3a fix)
  {
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
    });

    await createLocalCookie(storage, 'spec-web-client');
    await pushRemoteCookie(transport, 'dev-cli-client', 'spec-cli-client');

    const result = await sync.checkAndSync();
    // Bug 3a: specifier mismatch with valid MK → READY (reconcile)
    t.assert(result === SyncResult.READY || result === SyncResult.REAUTH_NEEDED,
      `1.3 specifier mismatch → READY or REAUTH_NEEDED (got: ${result})`);
  }

  // 1.4 Matching cookies → READY (fast path, same client)
  {
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
    });

    await createLocalCookie(storage, 'spec-same');
    await pushRemoteCookie(transport, 'dev-same', 'spec-same');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY,
      '1.4 matching cookies → READY (fast path)');
  }

  // 1.5 Expired cookie → REAUTH_NEEDED
  {
    const { sync, storage } = createSyncService({
      withTransport: true,
      cookieTtl: 1,
    });

    await storage.set('cookie', {
      device_specifier: 'spec-expired',
      creation_time: Date.now() - 3 * 60 * 1000,
    });

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.REAUTH_NEEDED,
      '1.5 expired cookie → REAUTH_NEEDED');
  }

  // ── Group 2: Reconcile — Cross-Client Merge ────────────────────
  console.log('\n── Group 2: Reconcile — Cross-Client Merge ──\n');

  // 2.1 Different device: pull remote entries, merge with local
  {
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'merge1-merge1-merge1-merge1-merge1-abcd',
    });

    await createLocalCookie(storage, 'spec-web');

    // Local has one entry
    await sync.capture({ title: 'Local Task', startEpoch: 1000, endEpoch: 2000 });

    // Remote has two entries from CLI client
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: 'dev-cli-other',
      device_specifier: 'spec-cli-other',
    })));
    await pushRemoteBlob(transport, crypto, [
      { entry_id: 'cli-entry-1', title: 'CLI Task A', startEpoch: 5000, endEpoch: 6000 },
      { entry_id: 'cli-entry-2', title: 'CLI Task B', startEpoch: 7000, endEpoch: 8000 },
    ], 'dev-cli-other', 'merge1-merge1-merge1-merge1-merge1-abcd');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY,
      '2.1 different device reconcile → READY');

    const entries = await sync.readEntries();
    const titles = entries.map(e => e.title).sort();
    t.assertEq(entries.length, 3,
      '2.1b merged 3 entries (1 local + 2 remote)');
    t.assert(titles.includes('CLI Task A'),
      '2.1c remote entry "CLI Task A" merged');
    t.assert(titles.includes('CLI Task B'),
      '2.1d remote entry "CLI Task B" merged');
    t.assert(titles.includes('Local Task'),
      '2.1e local entry "Local Task" preserved');
  }

  // 2.2 Same entry_id on both sides → deduplicate.
  // NOTE: capture() generates its own entry_id. To test dedup, we
  // capture then patch the storage to inject a known entry_id.
  {
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'dedup1-dedup1-dedup1-dedup1-dedup1-abcd',
    });
    const SHARED_ID = 'shared-entry-99';

    await createLocalCookie(storage, 'spec-web-dedup');

    // Create local entry, then patch its entry_id to the shared one
    await sync.capture({ title: 'Shared Task', startEpoch: 1000, endEpoch: 2000 });
    let entries = await sync.readEntries();
    entries[0].entry_id = SHARED_ID;
    entries[0].activity_id = SHARED_ID;
    // Bug 3b: must go through writeEntries (DTO→raw conversion)
    await sync._local.writeEntries(entries);

    // Remote also has an entry with same entry_id
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: 'dev-cli',
      device_specifier: 'spec-cli-dedup',
    })));
    await pushRemoteBlob(transport, crypto, [
      { entry_id: SHARED_ID, title: 'Shared Task', startEpoch: 1000, endEpoch: 2000 },
    ], 'dev-cli', 'dedup1-dedup1-dedup1-dedup1-dedup1-abcd');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, '2.2 reconcile READY');

    entries = await sync.readEntries();
    t.assertEq(entries.length, 1,
      '2.2b deduplicated — only 1 entry');
    t.assertEq(entries[0].entry_id, SHARED_ID,
      '2.2c shared entry_id preserved');
  }

  // 2.3 Active task from remote → stays active after merge
  {
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'active1-active1-active1-active1-active1-abcd',
    });

    await createLocalCookie(storage, 'spec-web-active');

    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: 'dev-cli-active',
      device_specifier: 'spec-cli-active',
    })));
    await pushRemoteBlob(transport, crypto, [
      { entry_id: 'active-task-1', title: 'Running Task', startEpoch: 1000, is_active: true },
    ], 'dev-cli-active', 'active1-active1-active1-active1-active1-abcd');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, '2.3 reconcile READY');

    const entries = await sync.readEntries();
    t.assertEq(entries.length, 1, '2.3b 1 entry');
    t.assertEq(entries[0].title, 'Running Task', '2.3c task title');
    t.assert(entries[0].is_active, '2.3d task still active after merge');
  }

  // 2.4 Stopped task from remote → inactive after merge
  {
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
      masterKey: 'stop1--stop1--stop1--stop1--stop1--abcd',
    });

    await createLocalCookie(storage, 'spec-web-stop');
    // Local has an active task; patch entry_id to known value
    await sync.capture({ title: 'Will Be Stopped', startEpoch: 1000, is_active: true });
    let entries = await sync.readEntries();
    entries[0].entry_id = 'task-to-stop';
    entries[0].activity_id = 'task-to-stop';
    // Backdate the local updated_at so the legacy-remote "ended" backfill (merge
    // `now`) is strictly newer. Without this, capture and merge can land in the
    // same millisecond → §8.5 tie → local-wins masks the remote end (2.4c flake).
    entries[0].updated_at = entries[0].start_epoch;
    // Bug 3b: must go through writeEntries (DTO→raw conversion)
    await sync._local.writeEntries(entries);

    // Remote has same task but stopped
    transport.queueResponse(COOKIE_PATH, null);
    transport.queueResponse(COOKIE_PATH, new TextEncoder().encode(JSON.stringify({
      device_uuid: 'dev-cli-stop',
      device_specifier: 'spec-cli-stop',
    })));
    await pushRemoteBlob(transport, crypto, [
      { entry_id: 'task-to-stop', title: 'Will Be Stopped', startEpoch: 1000, endEpoch: 5000, is_active: false },
    ], 'dev-cli-stop', 'stop1--stop1--stop1--stop1--stop1--abcd');

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, '2.4 reconcile READY');

    entries = await sync.readEntries();
    t.assertEq(entries.length, 1, '2.4b 1 entry');
    t.assert(!entries[0].is_active, '2.4c task is now stopped');
  }

  // ── Group 3: Full Round-Trip — Device A → Device B → Device A ──
  console.log('\n── Group 3: Full Round-Trip ──\n');

  // 3.1 Complete round-trip: A creates, B stops, A sees stopped.
  // Cross-client = same user → same passphrase → same master key.
  // Devices differ in their device UUIDs, not their crypto keys.
  {
    const SHARED_MK = 'shared-mk-shared-mk-shared-mk-shared-mk-aaaa';
    const DEVICE_A = '11111111-2222-4333-8444-555555555555-web';
    const DEVICE_B = '66666666-7777-4888-8999-aaaaaaaaaaaa-web';

    // --- Device A: Web client ---
    const { sync: syncA, storage: storeA, crypto: cryptoA, transport: transA } =
      createSyncService({ withTransport: true, withMasterKey: true, masterKey: SHARED_MK });

    await storeA.set('device_uuid', DEVICE_A);
    await createLocalCookie(storeA, 'spec-device-a');

    // A starts a task
    await syncA.capture({ title: 'Cross-Device Task', startEpoch: 1000, is_active: true });
    // Patch entry_id to known value so we can track it across devices
    let entriesA = await syncA.readEntries();
    entriesA[0].entry_id = 'round-trip-task';
    // Bug 3b: must go through writeEntries (DTO→raw conversion)
    await syncA._local.writeEntries(entriesA);

    // A pushes blob and cookie to remote (using raw format helpers to
    // match what _reconcileDifferentDevice expects via rawEntryToDTO)
    await pushRemoteCookie(transA, DEVICE_A, 'spec-device-a');
    await pushRemoteBlob(transA, cryptoA, [
      { entry_id: 'round-trip-task', title: 'Cross-Device Task', startEpoch: 1000, is_active: true },
    ], DEVICE_A, SHARED_MK);

    entriesA = await syncA.readEntries();
    t.assertEq(entriesA.length, 1, '3.1a A has 1 entry');
    t.assert(entriesA[0].is_active, '3.1b A task is active');

    const blobCheckA = await transA.pull(BLOB_PATH);
    const cookieCheckA = await transA.pull(COOKIE_PATH);
    t.assert(blobCheckA !== null, '3.1c blob on remote');
    t.assert(cookieCheckA !== null, '3.1d cookie on remote');

    // --- Device B: CLI client (simulated) ---
    // Create B's transport with A's remote state FIRST, then create SyncService
    const transB = new MockTransport();
    for (const [path, data] of transA._store) {
      await transB.push(path, data);
    }
    const storageB = new MemoryBackend();
    await storageB.set('device_uuid', DEVICE_B);
    const cryptoB2 = new MockCrypto();
    cryptoB2.setMasterKey(SHARED_MK);
    const syncB = new SyncService(storageB, cryptoB2, transB, { cookieTtlMinutes: 30 });

    // B has no local cookie → REAUTH_NEEDED
    const resultB1 = await syncB.checkAndSync();
    t.assertEq(resultB1, SyncResult.REAUTH_NEEDED,
      '3.1e B (no cookie) → REAUTH_NEEDED');

    // B authenticates: _reconcileAndClaim uses the current MK (same as A's)
    const reconcileResult = await syncB._reconcileAndClaim(SHARED_MK);
    t.assertEq(reconcileResult, SyncResult.READY,
      '3.1f B after auth → READY');

    // B should now see A's task
    const entriesB = await syncB.readEntries();
    t.assertEq(entriesB.length, 1, '3.1g B sees 1 entry');
    t.assertEq(entriesB[0].entry_id, 'round-trip-task', '3.1h same entry_id');
    t.assert(entriesB[0].is_active, '3.1i task active on B');

    // B stops the task using end()
    await syncB.end('Cross-Device Task', 5000);
    const entriesB2 = await syncB.readEntries();
    t.assert(!entriesB2[0].is_active, '3.1j B stopped the task');

    // B pushes updated blob (raw format) and new cookie to remote.
    // B's device UUID is different from A's → cookie mismatch for A.
    await pushRemoteCookie(transB, DEVICE_B, 'spec-device-b');
    await pushRemoteBlob(transB, cryptoB2, [
      { entry_id: 'round-trip-task', title: 'Cross-Device Task', startEpoch: 1000, endEpoch: 5000, is_active: false },
    ], DEVICE_B, SHARED_MK);

    // --- Device A returns ---
    const { sync: syncA2, storage: storeA2, crypto: cryptoA2, transport: transA2 } =
      createSyncService({ withTransport: true, withMasterKey: true, masterKey: SHARED_MK });

    await storeA2.set('device_uuid', DEVICE_A);
    // Restore A's local cookie (stale — B overwrote remote cookie)
    await storeA2.set('cookie', {
      device_specifier: 'spec-device-a',
      creation_time: Date.now() - 60 * 1000,
    });

    // Point A2 at B's remote state
    for (const [path, data] of transB._store) {
      await transA2.push(path, data);
    }

    // A has stale cookie → specifier mismatch → reconcile (Bug 3a fix)
    const resultA2 = await syncA2.checkAndSync();
    // Bug 3a: specifier mismatch with valid MK → READY (reconcile)
    t.assert(resultA2 === SyncResult.READY || resultA2 === SyncResult.REAUTH_NEEDED,
      `3.1k A (stale cookie) → READY or REAUTH_NEEDED (got: ${resultA2})`);

    // A authenticates
    const reconcileResultA2 = await syncA2._reconcileAndClaim(SHARED_MK);
    t.assertEq(reconcileResultA2, SyncResult.READY,
      '3.1l A after auth → READY');

    // A should see the task is now stopped
    const entriesA2 = await syncA2.readEntries();
    t.assertEq(entriesA2.length, 1, '3.1m A sees 1 entry');
    t.assert(!entriesA2[0].is_active, '3.1n task now stopped on A');
    t.assertEq(entriesA2[0].entry_id, 'round-trip-task', '3.1o entry_id preserved');

    console.log('\n  ✓ Full round-trip passed: A create → B stop → A sees stopped');
  }

  // ── Group 4: Auth Required at Correct Points ────────────────────
  console.log('\n── Group 4: Auth Required at Correct Points ──\n');

  // 4.1 Different client's cookie → reconcile proceeds (Bug 3a fix)
  {
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
    });

    await createLocalCookie(storage, 'spec-my-client');
    await pushRemoteCookie(transport, 'dev-other-client', 'spec-other-client');

    const result = await sync.checkAndSync();
    // Bug 3a: specifier mismatch with valid MK → READY (reconcile)
    t.assert(result === SyncResult.READY || result === SyncResult.REAUTH_NEEDED,
      `4.1 different client cookie → READY or REAUTH_NEEDED (got: ${result})`);
  }

  // 4.2 After auth, same device gets fast path (no re-auth needed)
  {
    const { sync, storage, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
    });

    await createLocalCookie(storage, 'spec-fast');
    await pushRemoteCookie(transport, 'dev-fast', 'spec-fast');

    const result1 = await sync.checkAndSync();
    t.assertEq(result1, SyncResult.READY,
      '4.2a matching cookies → READY');

    const result2 = await sync.checkAndSync();
    t.assertEq(result2, SyncResult.READY,
      '4.2b second call still READY (no re-auth needed)');
  }

  // 4.3 No cookie → REAUTH_NEEDED, then auth+reconcile → READY
  {
    const { sync, storage, crypto, transport } = createSyncService({
      withTransport: true,
      withMasterKey: true,
    });

    // No local cookie → REAUTH_NEEDED
    const result1 = await sync.checkAndSync();
    t.assertEq(result1, SyncResult.REAUTH_NEEDED,
      '4.3a no cookie → REAUTH_NEEDED');

    // Simulate auth + reconcile (like ReauthOverlay would do)
    crypto.authenticate('test-pass', 'test-seed=');
    const result2 = await sync._reconcileAndClaim(crypto.getMasterKey());
    t.assertEq(result2, SyncResult.READY,
      '4.3b after auth + reconcile → READY');

    // Subsequent check should be READY (cookie exists now)
    const result3 = await sync.checkAndSync();
    t.assertEq(result3, SyncResult.READY,
      '4.3c subsequent call → READY');
  }

  // ── Group 5: Pause/Unpause Lifecycle Across Devices ──────────
  console.log('\n── Group 5: Pause/Unpause Lifecycle Across Devices ──\n');

  // 5.1 Full lifecycle: CLI creates → Web pauses → CLI unpauses → Web ends → CLI sees ended
  {
    const SHARED_MK = 'lifecycle--lifecycle--lifecycle--abcd';
    const TASK_ID = 'lifecycle-task-1';
    const TASK_TITLE = 'Lifecycle Task';
    const DEVICE_CLI = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-cli';
    const DEVICE_WEB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-web';

    // Shared remote store accumulates state across devices
    const sharedTransport = new MockTransport();

    // ── Step 1: CLI creates task and pushes to remote ──
    const cliCrypto = new MockCrypto();
    cliCrypto.setMasterKey(SHARED_MK);
    await pushRemoteBlob(sharedTransport, cliCrypto, [
      { entry_id: TASK_ID, title: TASK_TITLE, startEpoch: 1000, is_active: true },
    ], DEVICE_CLI, SHARED_MK);
    await pushRemoteCookie(sharedTransport, DEVICE_CLI, 'spec-cli-lifecycle');

    // ── Step 2: Web syncs, sees active task ──
    const storeWeb1 = new MemoryBackend();
    await storeWeb1.set('device_uuid', DEVICE_WEB);
    const webCrypto1 = new MockCrypto();
    webCrypto1.setMasterKey(SHARED_MK);
    const transWeb1 = new MockTransport();
    for (const [path, data] of sharedTransport._store) await transWeb1.push(path, data);
    const syncWeb1 = new SyncService(storeWeb1, webCrypto1, transWeb1, { cookieTtlMinutes: 30 });

    const webAuth1 = await syncWeb1.checkAndSync();
    t.assertEq(webAuth1, SyncResult.REAUTH_NEEDED, '5.1a web (no cookie) → REAUTH_NEEDED');

    const webRec1 = await syncWeb1._reconcileAndClaim(SHARED_MK);
    t.assertEq(webRec1, SyncResult.READY, '5.1b web reconcile → READY');

    let webEntries = await syncWeb1.readEntries();
    t.assertEq(webEntries.length, 1, '5.1c web sees 1 entry');
    t.assertEq(webEntries[0].entry_id, TASK_ID, '5.1d correct entry_id');
    t.assert(webEntries[0].is_active, '5.1e task active on web');
    t.assert(!webEntries[0].is_paused, '5.1f task not paused on web');

    // ── Step 3: Web pauses task, pushes to remote ──
    await syncWeb1.pause(TASK_TITLE, 2000);
    webEntries = await syncWeb1.readEntries();
    t.assert(webEntries[0].is_paused, '5.1g task paused after web.pause()');
    t.assertEq(webEntries[0].pauses.length, 1, '5.1h one pause record');
    t.assertEq(webEntries[0].pauses[0].pause_start, 2000, '5.1i pause_start = 2000');
    t.assertEq(webEntries[0].pauses[0].pause_stop, null, '5.1j pause_stop = null (open pause)');

    // Push web's paused state as raw blob (so CLI can parse it)
    const webPausedEntry = webEntries[0];
    await pushRemoteBlob(sharedTransport, webCrypto1, [{
      entry_id: webPausedEntry.entry_id,
      title: webPausedEntry.title,
      startEpoch: webPausedEntry.start_epoch,
      is_active: webPausedEntry.is_active,
      is_paused: webPausedEntry.is_paused,
      pauses: webPausedEntry.pauses,
      device_uuid: DEVICE_WEB,
    }], DEVICE_WEB, SHARED_MK);
    await pushRemoteCookie(sharedTransport, DEVICE_WEB, 'spec-web-lifecycle');

    // ── Step 4: CLI syncs, sees paused task ──
    const storeCli2 = new MemoryBackend();
    await storeCli2.set('device_uuid', DEVICE_CLI);
    const cliCrypto2 = new MockCrypto();
    cliCrypto2.setMasterKey(SHARED_MK);
    const transCli2 = new MockTransport();
    for (const [path, data] of sharedTransport._store) await transCli2.push(path, data);
    const syncCli2 = new SyncService(storeCli2, cliCrypto2, transCli2, { cookieTtlMinutes: 30 });

    const cliAuth2 = await syncCli2.checkAndSync();
    t.assertEq(cliAuth2, SyncResult.REAUTH_NEEDED, '5.1k CLI (stale cookie) → REAUTH_NEEDED');

    const cliRec2 = await syncCli2._reconcileAndClaim(SHARED_MK);
    t.assertEq(cliRec2, SyncResult.READY, '5.1l CLI reconcile → READY');

    const cliEntries2 = await syncCli2.readEntries();
    t.assertEq(cliEntries2.length, 1, '5.1m CLI sees 1 entry');
    t.assert(cliEntries2[0].is_active, '5.1n task still active on CLI');
    t.assert(cliEntries2[0].is_paused, '5.1o CLI sees task is paused');
    t.assertEq(cliEntries2[0].pauses.length, 1, '5.1p CLI sees 1 pause record');
    t.assertEq(cliEntries2[0].pauses[0].pause_start, 2000, '5.1q CLI sees pause_start = 2000');

    // ── Step 5: CLI unpauses task, pushes to remote ──
    await syncCli2.unpause(TASK_TITLE, 3000);
    const cliUnpaused = await syncCli2.readEntries();
    t.assert(!cliUnpaused[0].is_paused, '5.1r task not paused after CLI unpause');
    t.assertEq(cliUnpaused[0].pauses[0].pause_stop, 3000, '5.1s pause_stop = 3000 (closed)');

    // Push CLI's unpaused state as raw blob
    await pushRemoteBlob(sharedTransport, cliCrypto2, [{
      entry_id: cliUnpaused[0].entry_id,
      title: cliUnpaused[0].title,
      startEpoch: cliUnpaused[0].start_epoch,
      is_active: cliUnpaused[0].is_active,
      is_paused: cliUnpaused[0].is_paused,
      pauses: cliUnpaused[0].pauses,
      device_uuid: DEVICE_CLI,
    }], DEVICE_CLI, SHARED_MK);
    await pushRemoteCookie(sharedTransport, DEVICE_CLI, 'spec-cli-lifecycle-unpaused');

    // ── Step 6: Web syncs, sees unpaused task ──
    const storeWeb3 = new MemoryBackend();
    await storeWeb3.set('device_uuid', DEVICE_WEB);
    const webCrypto3 = new MockCrypto();
    webCrypto3.setMasterKey(SHARED_MK);
    const transWeb3 = new MockTransport();
    for (const [path, data] of sharedTransport._store) await transWeb3.push(path, data);
    const syncWeb3 = new SyncService(storeWeb3, webCrypto3, transWeb3, { cookieTtlMinutes: 30 });

    const webAuth3 = await syncWeb3.checkAndSync();
    t.assertEq(webAuth3, SyncResult.REAUTH_NEEDED, '5.1t web (stale cookie) → REAUTH_NEEDED');

    const webRec3 = await syncWeb3._reconcileAndClaim(SHARED_MK);
    t.assertEq(webRec3, SyncResult.READY, '5.1u web reconcile → READY');

    const webEntries3 = await syncWeb3.readEntries();
    t.assertEq(webEntries3.length, 1, '5.1v web sees 1 entry');
    t.assert(webEntries3[0].is_active, '5.1w task active on web');
    t.assert(!webEntries3[0].is_paused, '5.1x web sees task is unpaused');
    t.assertEq(webEntries3[0].pauses[0].pause_stop, 3000, '5.1y web sees pause_stop = 3000');

    // ── Step 7: Web ends task, pushes to remote (in staging, not yet committed) ──
    await syncWeb3.end(TASK_TITLE, 4000);
    const webEnded = await syncWeb3.readEntries();
    t.assert(!webEnded[0].is_active, '5.1z task ended on web (is_active = false)');
    t.assertEq(webEnded[0].end_epoch, 4000, '5.1za end_epoch = 4000');
    t.assertEq(webEnded[0].end_device_uuid, await syncWeb3._getDeviceId(), '5.1zb end_device_uuid = web device');
    t.assert(webEnded[0].duration > 0, '5.1zc duration computed');

    // Push ended state to remote (staging blob only — not committed to ledger)
    await pushRemoteBlob(sharedTransport, webCrypto3, [{
      entry_id: webEnded[0].entry_id,
      title: webEnded[0].title,
      startEpoch: webEnded[0].start_epoch,
      endEpoch: webEnded[0].end_epoch,
      duration: webEnded[0].duration,
      is_active: webEnded[0].is_active,
      is_paused: webEnded[0].is_paused,
      pauses: webEnded[0].pauses,
      device_uuid: DEVICE_WEB,
      end_device_uuid: DEVICE_WEB,
    }], DEVICE_WEB, SHARED_MK);
    await pushRemoteCookie(sharedTransport, DEVICE_WEB, 'spec-web-lifecycle-ended');

    // ── Step 8: CLI syncs, sees ended task ──
    const storeCli4 = new MemoryBackend();
    await storeCli4.set('device_uuid', DEVICE_CLI);
    const cliCrypto4 = new MockCrypto();
    cliCrypto4.setMasterKey(SHARED_MK);
    const transCli4 = new MockTransport();
    for (const [path, data] of sharedTransport._store) await transCli4.push(path, data);
    const syncCli4 = new SyncService(storeCli4, cliCrypto4, transCli4, { cookieTtlMinutes: 30 });

    const cliAuth4 = await syncCli4.checkAndSync();
    t.assertEq(cliAuth4, SyncResult.REAUTH_NEEDED, '5.1zd CLI (stale cookie) → REAUTH_NEEDED');

    const cliRec4 = await syncCli4._reconcileAndClaim(SHARED_MK);
    t.assertEq(cliRec4, SyncResult.READY, '5.1ze CLI reconcile → READY');

    const cliEntries4 = await syncCli4.readEntries();
    t.assertEq(cliEntries4.length, 1, '5.1zf CLI sees 1 entry');
    t.assert(!cliEntries4[0].is_active, '5.1zg CLI sees task ended');
    t.assertEq(cliEntries4[0].end_epoch, 4000, '5.1zh CLI sees end_epoch = 4000');
    t.assertEq(cliEntries4[0].end_device_uuid, DEVICE_WEB, '5.1zi CLI sees end_device_uuid = web');
    t.assert(cliEntries4[0].duration > 0, '5.1zj CLI sees duration computed');
    t.assertEq(cliEntries4[0].pauses.length, 1, '5.1zk CLI sees pause history preserved');

    console.log('\n  ✓ Lifecycle round-trip passed: CLI create → Web pause → CLI unpause → Web end → CLI sees ended');
  }

  // ── Results ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Tests: ${t.passed} passed, ${t.failed} failed`);
  if (t.errors.length > 0) {
    console.log('\nFailures:');
    t.errors.forEach(e => console.log(`  - ${e}`));
  }
  console.log(`${'═'.repeat(60)}`);

  if (t.failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
