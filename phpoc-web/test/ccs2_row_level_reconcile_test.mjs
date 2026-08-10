/**
 * ccs2_row_level_reconcile_test.mjs — CCS-2 row-level sync reconcile (Option B)
 *
 * Four-phase TDD — Phase 2 (RED). Blueprint: docs/planning/CCS2_PHASE1.md
 *
 * Core deliverable: thread canonical-row (activity_id LWW, local-wins-on-tie)
 * semantics through `SyncService` reconcile while preserving the LocalCache
 * / DTO contract. Reconcile must standardize on `mergeRows` (not `mergeEntries`),
 * bridge legacy+canonical blobs, and keep the Tier-1 hash-index fast path intact.
 *
 * Empirically-verified classification (see Phase 2 report):
 *   🔴 genuinely RED (fail today)     → A2b, A3b, A3c, A4b (mergeRows LWW consolidation)
 *   🟢 guard (green today, must stay green) → all remaining assertions incl. B5 legacy-bridge
 *
 * The CCS-2 implementation target is the activity_id LWW reconcile: when
 * local + remote share an activity_id, `mergeEntries` (entry_id-based)
 * keeps two copies — `mergeRows` (activity_id-based, local-wins-on-tie)
 * consolidates to one.
 *
 * Usage:
 *   node test/ccs2_row_level_reconcile_test.mjs
 */

import { createHash } from 'crypto';

import {
  SyncService,
  SyncResult,
} from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import {
  buildStagingHashIndex,
  compareStagingHashIndexes,
} from '../src/sync/staging_hash_index.js';
import { mergeRows } from '../src/sync/row_sync.js';
import { migrateBlobToRows } from '../src/sync/migration.js';
import { RowStagingStore } from '../src/sync/row_staging_store.js';
import { buildDiff } from '../src/sync/row_sync.js';
import {
  REMOTE_STAGING_BLOB,
  REMOTE_DEVICE_COOKIE,
  REMOTE_STAGING_HASH_INDEX,
  REMOTE_STAGING_HASH_INDEX_SHA256,
} from '../src/sync/keys.js';

// ══════════════════════════════════════════════════════════════════════
// MockCrypto — same contract as sync_service_test.mjs MockCrypto
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

  getDeviceId(mk) {
    return `dev-${(mk || '').slice(0, 8)}`;
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
    const obfuscated = Buffer.from(b64, 'base64');
    const storedFingerprint = obfuscated.slice(0, 4);
    if (mk) {
      const expectedFingerprint = createHash('sha256').update(mk).digest().slice(0, 4);
      if (!storedFingerprint.equals(expectedFingerprint)) {
        throw new Error('key mismatch');
      }
    }
    return obfuscated.slice(4).toString('utf-8');
  }

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
    return ciphertextHex;
  }

  encrypt(plaintext, _masterKey) {
    return `enc:${plaintext}`;
  }

  encryptWithCachedKey(plaintext) {
    return `enc:${plaintext}`;
  }
}

// ══════════════════════════════════════════════════════════════════════
// MockTransport — in-memory remote R2 store (same contract as sync_service_test)
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    this._store = new Map();
    this._queue = new Map();
    this._pushCalls = [];
  }

  queueResponse(path, value) {
    const arr = this._queue.get(path) || [];
    arr.push(value);
    this._queue.set(path, arr);
  }

  async pull(path) {
    const queue = this._queue.get(path);
    if (queue && queue.length > 0) return queue.shift();
    const val = this._store.get(path);
    return val !== undefined ? val : null;
  }

  async push(path, data) {
    this._pushCalls.push(path);
    if (data !== undefined) this._store.set(path, data);
  }

  async delete(path) {
    this._store.delete(path);
  }

  /** List keys under a prefix (clearRemote uses this to enumerate ledger blocks). */
  async listFiles(prefix) {
    const out = [];
    for (const [path] of this._store) {
      if (path.startsWith(prefix)) out.push(path.slice(prefix.length));
    }
    return out;
  }

  /** No-op cache reset hook so clearRemote's post-clear path is exercised. */
  async resetCache() {}

  /** Count push() calls to a specific remote path. */
  pushCount(path) {
    return this._pushCalls.filter((p) => p === path).length;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Test helpers
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

/** Create a SyncService wired to a MemoryBackend + MockTransport + MockCrypto. */
function createSyncService(mk) {
  const storage = new MemoryBackend();
  const crypto = new MockCrypto();
  crypto.setMasterKey(mk);
  const transport = new MockTransport();
  const sync = new SyncService(storage, crypto, transport, {
    cookieTtlMinutes: 30,
  });
  return { sync, storage, crypto, transport };
}

/** Queue the two cookie pulls that drive _reconcileDifferentDevice (Case B). */
function queueReconcile(transport, remoteUuid = 'dev-remote', remoteSpec = 'spec-remote') {
  transport.queueResponse(REMOTE_DEVICE_COOKIE, null);
  transport.queueResponse(REMOTE_DEVICE_COOKIE, new TextEncoder().encode(JSON.stringify({
    device_uuid: remoteUuid,
    device_specifier: remoteSpec,
  })));
}

/**
 * Push a canonical-row staging blob (PHPSPEC §8) to the mock transport.
 * @param {Array<{activity_id, activity_status, activity, updated_at, committed?}>} rows
 */
async function pushCanonicalBlob(transport, crypto, rows, mk) {
  const blob = JSON.stringify({
    device_id: 'device-remote',
    device_proof: '',
    entries: rows.map((r) => ({
      activity_id: r.activity_id,
      activity_status: r.activity_status,
      activity: typeof r.activity === 'string' ? r.activity : JSON.stringify(r.activity || {}),
      updated_at: r.updated_at,
      committed: r.committed || false,
    })),
    updated_at: Date.now(),
  });
  const b64 = crypto.obfuscateBlob(blob, mk);
  await transport.push(REMOTE_STAGING_BLOB, new Uint8Array(Buffer.from(b64, 'base64')));
}

/** Read + deobfuscate the pushed remote blob on the mock transport. */
async function readPushedBlob(transport, crypto, mk) {
  const raw = await transport.pull(REMOTE_STAGING_BLOB);
  if (!raw) return null;
  const buf = Buffer.from(raw);
  let text;
  try {
    text = buf.toString('utf8');
    JSON.parse(text);
  } catch {
    text = crypto.deobfuscateBlob(buf.toString('base64'), mk);
  }
  return JSON.parse(text);
}

/** Default 64-char hex master key for tests. */
const MK = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';

/** Build a canonical row fixture. */
function row(id, status, updatedAt, title, committed = false) {
  return {
    activity_id: id,
    activity_status: status,
    activity: { title, start_epoch: 1000 },
    updated_at: updatedAt,
    committed,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Group A — Standardize on mergeRows in reconcile
// ══════════════════════════════════════════════════════════════════════

async function groupA() {
  console.log('\n── Group A: Standardize on mergeRows in reconcile ──');

  // A1 (🟢 guard) — remote-only canonical row reconciles to a DTO in readEntries().
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', {
      device_specifier: 'spec-a1',
      creation_time: Date.now(),
    });
    queueReconcile(transport);
    await pushCanonicalBlob(transport, crypto, [row('a1-only', 'active', 5000, 'Remote A1')], MK);

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'A1. remote-only canonical reconcile → READY');

    const entries = await sync.readEntries();
    const found = entries.filter((e) => e.activity_id === 'a1-only');
    t.assertEq(found.length, 1, 'A1b. remote-only canonical row present exactly once');
    t.assertEq(found[0]?.title, 'Remote A1', 'A1c. canonical activity data decoded into DTO');
    t.assertEq(found[0]?.activity_id, 'a1-only', 'A1d. activity_id preserved through reconcile');
  }

  // A2 (🔴 RED) — same activity_id, local updated_at newer → local wins, ONE row.
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', {
      device_specifier: 'spec-a2',
      creation_time: Date.now(),
    });
    await sync.capture({ title: 'Local A2', startEpoch: 1000 });
    const localDtos = await sync.readEntries();
    const localRec = localDtos.find((e) => e.title === 'Local A2');
    // Local has a NEWER updated_at than remote (remote uses a low value).
    queueReconcile(transport);
    await pushCanonicalBlob(transport, crypto, [row(localRec.activity_id, 'ended', 1, 'Remote A2 stale')], MK);

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'A2. local-newer reconcile → READY');

    const entries = await sync.readEntries();
    const same = entries.filter((e) => e.activity_id === localRec.activity_id);
    t.assertEq(same.length, 1, 'A2b. LWW: exactly one row survives (not local+remote dupes)');
    t.assertEq(same[0]?.title, 'Local A2', 'A2c. local (newer) version wins');
  }

  // A3 (🔴 RED) — same activity_id, remote updated_at newer → remote wins locally.
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', {
      device_specifier: 'spec-a3',
      creation_time: Date.now(),
    });
    await sync.capture({ title: 'Local A3', startEpoch: 1000 });
    const localDtos = await sync.readEntries();
    const localRec = localDtos.find((e) => e.title === 'Local A3');
    // Remote NEWER than local.
    const remoteAt = Date.now() + 100000;
    queueReconcile(transport);
    await pushCanonicalBlob(transport, crypto, [row(localRec.activity_id, 'ended', remoteAt, 'Remote A3 new')], MK);

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'A3. remote-newer reconcile → READY');

    const entries = await sync.readEntries();
    const same = entries.filter((e) => e.activity_id === localRec.activity_id);
    t.assertEq(same.length, 1, 'A3b. LWW: exactly one row survives');
    t.assertEq(same[0]?.title, 'Remote A3 new', 'A3c. remote (newer) version wins locally');
  }

  // A4 (🔴 RED) — same activity_id, equal updated_at, different status → local wins on tie.
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', {
      device_specifier: 'spec-a4',
      creation_time: Date.now(),
    });
    await sync.capture({ title: 'Local A4', startEpoch: 1000 });
    const localStored = await sync._storage.get('entries');
    const localIndex = await sync.readEntries();
    const localRec = localIndex.find((e) => e.title === 'Local A4');
    // Remote has the SAME activity_id and the SAME updated_at (tie) but a different status.
    const localUpdatedAt = localStored[0].updated_at ?? Date.now();
    queueReconcile(transport);
    await pushCanonicalBlob(transport, crypto, [
      row(localRec.activity_id, 'ended', localUpdatedAt, 'Remote A4 tie'),
    ], MK);

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'A4. equal-timestamp tie reconcile → READY');

    const entries = await sync.readEntries();
    const same = entries.filter((e) => e.activity_id === localRec.activity_id);
    t.assertEq(same.length, 1, 'A4b. tie: exactly one row survives (local wins on tie)');
    t.assertEq(same[0]?.title, 'Local A4', 'A4c. local status retained on equal updated_at (PHPSPEC §8.5)');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group B — Canonical-row reconcile layer
// ══════════════════════════════════════════════════════════════════════

async function groupB() {
  console.log('\n── Group B: Canonical-row reconcile layer ──');

  // B1 (🟢 guard) — committed rows filtered before write/push.
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', {
      device_specifier: 'spec-b1',
      creation_time: Date.now(),
    });
    queueReconcile(transport);
    await pushCanonicalBlob(transport, crypto, [
      row('b1-committed', 'ended', 5000, 'Committed B1', true),
    ], MK);

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'B1. committed-row reconcile → READY');

    const entries = await sync.readEntries();
    const committed = entries.filter((e) => e.activity_id === 'b1-committed');
    t.assertEq(committed.length, 0, 'B1b. committed remote row not written locally (committed-exclusion)');

    const pushed = await readPushedBlob(transport, crypto, MK);
    const pushedRows = (pushed?.entries || []).filter((r) => r.activity_id === 'b1-committed');
    t.assertEq(pushedRows.length, 0, 'B1c. committed remote row not re-synced to remote');
  }

  // B2 (🟢 guard) — local-only row pushed as flat canonical row (no {hash,data} wrapper).
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', {
      device_specifier: 'spec-b2',
      creation_time: Date.now(),
    });
    queueReconcile(transport);

    await sync.capture({ title: 'Local B2', startEpoch: 1000 });
    await sync.checkAndSync();

    const pushed = await readPushedBlob(transport, crypto, MK);
    const first = pushed?.entries?.[0];
    t.assert(pushed?.entries?.length >= 1, 'B2b. local-only row pushed in a blob');
    t.assert(first && first.activity_id, 'B2c. row is keyed by flat activity_id');
    t.assert(first && first.data === undefined, 'B2d. no {hash,data} wrapper (canonical format)');
  }

  // B3 (🟢 guard) — row updated_at round-trips intact through the pushed blob.
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', {
      device_specifier: 'spec-b3',
      creation_time: Date.now(),
    });
    queueReconcile(transport);

    // Seed a local row via capture, then pull its DTO updated_at from raw storage.
    await sync.capture({ title: 'Local B3', startEpoch: 1000 });
    await sync.checkAndSync();

    const pushed = await readPushedBlob(transport, crypto, MK);
    const first = pushed?.entries?.[0];
    t.assert(first && typeof first.updated_at === 'number' && first.updated_at > 0,
      'B3b. updated_at present and numeric in pushed canonical row');
  }

  // B4 (🟢 guard) — reconcile is idempotent (two runs → same rows, no duplicates).
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', {
      device_specifier: 'spec-b4',
      creation_time: Date.now(),
    });
    queueReconcile(transport);
    queueReconcile(transport);
    await pushCanonicalBlob(transport, crypto, [row('b4-x', 'active', 9000, 'Remote B4')], MK);

    await sync.checkAndSync();
    const count1 = (await sync.readEntries()).filter((e) => e.activity_id === 'b4-x').length;
    await sync.checkAndSync();
    const count2 = (await sync.readEntries()).filter((e) => e.activity_id === 'b4-x').length;
    t.assertEq(count2, count1, 'B4. two reconcile runs → same row count, no duplicates');
    t.assertEq(count1, 1, 'B4b. single consolidated row after first run');
  }

  // B5 (🔴 RED) — legacy remote {hash,data} blob merges with a canonical local row set.
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', {
      device_specifier: 'spec-b5',
      creation_time: Date.now(),
    });
    // Local canonical row captured first.
    await sync.capture({ title: 'Local Canonical B5', startEpoch: 5000 });
    queueReconcile(transport);
    // Remote is a legacy {hash, data:{...}} blob.
    const legacy = {
      device_id: 'device-legacy',
      device_proof: '',
      entries: [{
        entry_id: 'legacy-e1',
        hash: 'h-legacy-1',
        data: {
          entry_id: 'legacy-e1',
          title: 'Legacy Remote B5',
          startTime_enc: 'plain:9999',
          is_active: true,
          is_paused: false,
          device_uuid: 'device-legacy',
          duration: 0,
          tags: [],
          comment: null,
          media: [],
        },
      }],
    };
    await transport.push(REMOTE_STAGING_BLOB,
      new Uint8Array(Buffer.from(crypto.obfuscateBlob(JSON.stringify(legacy), MK), 'base64')));

    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'B5. legacy+canonical reconcile → READY');

    const entries = await sync.readEntries();
    const titles = entries.map((e) => e.title);
    t.assert(titles.includes('Local Canonical B5'), 'B5b. local canonical row preserved');
    t.assert(titles.includes('Legacy Remote B5'), 'B5c. legacy remote row bridged into local set without loss');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group C — Tier-1 fast path with compareStagingHashIndexes
// ══════════════════════════════════════════════════════════════════════

/** Drive a same-device fast-path check with a seeded local+remote hash index. */
async function fastPathCheck({ localIndex, remoteIndex, buildRemote, mk = MK }) {
  const { sync, storage, transport, crypto } = createSyncService(mk);
  const spec = 'spec-fastpath';
  await storage.set('cookie', { device_specifier: spec, creation_time: Date.now() });
  if (localIndex != null) {
    await storage.set('staging:hash_index', localIndex);
  }
  // Remote cookie matches → same-device fast path.
  transport.queueResponse(REMOTE_DEVICE_COOKIE, new TextEncoder().encode(JSON.stringify({
    device_uuid: crypto.getDeviceId(mk),
    device_specifier: spec,
  })));
  if (buildRemote) {
    const json = JSON.stringify(remoteIndex ?? []);
    const obfB64 = crypto.obfuscateBlob(json, mk);
    const idxBytes = Buffer.from(obfB64, 'base64');
    const sha = crypto.sha256(idxBytes.toString('utf8'));
    await transport.push(REMOTE_STAGING_HASH_INDEX, idxBytes);
    await transport.push(REMOTE_STAGING_HASH_INDEX_SHA256, new TextEncoder().encode(sha));
  }
  return { sync, transport };
}

async function groupC() {
  console.log('\n── Group C: Tier-1 structured fast path ──');

  // C1 (🟢 guard) — identical local/remote hash indexes → READY, no blob push.
  {
    const localIndex = [{ id: 'act-X', status: 'active' }];
    const { sync, transport } = await fastPathCheck({
      localIndex,
      remoteIndex: localIndex,
      buildRemote: true,
    });
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'C1. identical hash indexes → READY (fast path)');
    t.assertEq(transport.pushCount(REMOTE_STAGING_BLOB), 0, 'C1b. identical index → no blob push');
  }

  // C2 (🟢 guard) — status-only change (same ids, different status) forces a push.
  {
    const remoteIndex = [{ id: 'act-X', status: 'active' }];
    const { sync, transport } = await fastPathCheck({
      localIndex: [{ id: 'act-X', status: 'ended' }],
      remoteIndex,
      buildRemote: true,
    });
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'C2. differing status → READY');
    t.assert(transport.pushCount(REMOTE_STAGING_BLOB) >= 1,
      'C2b. status-only change detected → blob re-pushed');
  }

  // C3 (🟢 anchor, blueprint) — empty local + empty remote → identical + fast-path READY.
  {
    const { sync, transport } = await fastPathCheck({ localIndex: [], buildRemote: true, remoteIndex: [] });
    const result = await sync.checkAndSync();
    t.assertEq(result, SyncResult.READY, 'C3. empty local + empty remote → READY');
    const diffs = compareStagingHashIndexes([], []);
    t.assertEq(diffs.identical, true, 'C3b. compareStagingHashIndexes([], []) → identical');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group U — Re-home gated row integration (M/I) against the real sync layer
// ══════════════════════════════════════════════════════════════════════

async function groupU() {
  console.log('\n── Group U: Re-home gated row integration (M/I) ──');

  // U1 (🟢 guard, re-homed from M1) — migrateBlobToRows converts legacy entries → row keys.
  {
    const storage = new MemoryBackend();
    await storage.set('entries', [
      { hash: 'h1', data: { entry_id: 'u1-e1', title: 'U1 Task' }, committed: false },
    ]);
    const count = await migrateBlobToRows(storage, { generateId: () => 'u1-act-1' });
    t.assertEq(count, 1, 'U1. migrateBlobToRows migrated 1 legacy entry');
    const store = new RowStagingStore(storage);
    const rows = await store.getAllRows();
    t.assert(rows.some((r) => r.activity_id === 'u1-act-1'), 'U1b. row stored under activity_id key');
  }

  // U2 (🟢 guard, re-homed from M6) — migrateBlobToRows is idempotent (marker prevents dupes).
  {
    const storage = new MemoryBackend();
    await storage.set('entries', [
      { hash: 'h1', data: { entry_id: 'u2-e1', title: 'U2 Task' }, committed: false },
    ]);
    await migrateBlobToRows(storage, { generateId: () => 'u2-act-1' });
    const store = new RowStagingStore(storage);
    const countBefore = (await store.getAllRows()).length;
    // Second run must be a no-op (marker present).
    await migrateBlobToRows(storage, { generateId: () => 'u2-act-1' });
    const countAfter = (await store.getAllRows()).length;
    t.assertEq(countAfter, countBefore, 'U2. re-migration does not duplicate rows');
    t.assertEq(countBefore, 1, 'U2b. exactly one row after first migration');
  }

  // U3 (🟢 guard, re-homed from I7) — rows written to a shared store are visible to a second instance.
  {
    const shared = new RowStagingStore(new MemoryBackend());
    const deviceA = new RowStagingStore(shared._storage);
    const deviceB = new RowStagingStore(shared._storage);

    const rowA = { activity_id: 'u3-cross', activity_status: 'active', activity: '{}', updated_at: 5000 };
    await deviceA.putRow(rowA);
    const seen = await deviceB.getRow('u3-cross');
    t.assert(seen !== null && seen.activity_id === 'u3-cross', 'U3. device B sees device A row via shared store');

    // buildDiff fast-path on full sync state via MergeRows semantics.
    const merged = mergeRows(await deviceA.getAllRows(), [{ ...rowA, updated_at: 5000 }]);
    t.assertEq(merged.length, 1, 'U3b. mergeRows yields one consolidated row');
  }

  // U4 (🟢 anchor, blueprint) — clearRemote clears staging blob, cookie, and hash-index keys.
  {
    const { sync, transport, crypto } = createSyncService(MK);
    await sync._storage.set('cookie', { device_specifier: 'spec-u4', creation_time: Date.now() });
    await transport.push(REMOTE_STAGING_BLOB, new TextEncoder().encode('blob'));
    await transport.push(REMOTE_STAGING_HASH_INDEX, new TextEncoder().encode('idx'));
    await transport.push(REMOTE_STAGING_HASH_INDEX_SHA256, new TextEncoder().encode('sha'));
    await transport.push(REMOTE_DEVICE_COOKIE, new TextEncoder().encode('cookie'));

    await sync.clearRemote();
    t.assertEq(await transport.pull(REMOTE_STAGING_BLOB), null, 'U4. staging blob cleared');
    t.assertEq(await transport.pull(REMOTE_STAGING_HASH_INDEX), null, 'U4b. hash-index key cleared');
    t.assertEq(await transport.pull(REMOTE_STAGING_HASH_INDEX_SHA256), null, 'U4c. hash-index sha key cleared');
    t.assertEq(await transport.pull(REMOTE_DEVICE_COOKIE), null, 'U4d. device cookie cleared');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Run
// ══════════════════════════════════════════════════════════════════════

(async () => {
  console.log('══ CCS-2 Row-Level Sync Reconcile Test Suite (Phase 2 RED) ══');

  await groupA();
  await groupB();
  await groupC();
  await groupU();

  console.log('\n────────────────────────────────────────────────────────────────────');
  console.log(`CCS-2 row-level reconcile tests: ${t.passed} passed, ${t.failed} failed`);
  if (t.failed > 0) {
    console.log('\nFailed tests (Phase 2 RED expectations):');
    t.errors.forEach((e) => console.log(`  ✗ ${e}`));
  }
  process.exit(t.failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
