/**
 * web_ledger_auto_pull_test.mjs — Web ADR-030 ledger-aware ownership-handoff parity.
 *
 * TDD RED phase (Phase 2): Brings phpoc-web in line with Flutter for the ADR-030
 * ownership-handoff ledger flow. Three groups (blueprint: WEB_LEDGER_AUTO_PULL_PHASE1):
 *
 *   W1. Ledger PULL on ownership-handoff — remote ledger auto-pulled + persisted to
 *       LOCAL_LEDGER_BLOCKS when it has more blocks than local (freshness-gated),
 *       fail-safe when the remote ledger is absent or the pull throws.
 *   W2. Scenario-5/6 ledger-AWARE staging cleanup — drop UNCOMMITTED merged rows
 *       whose activity_id is sealed in the local ledger; KEEP committed rows; no-op
 *       on empty ledger; run after LWW merge, before remote push.
 *   W3. Web `_ledgerActivityIds()` — derive the sealed-id set from LOCAL_LEDGER_BLOCKS
 *       day-block entries' data.activity_id, skipping summary/genesis/malformed entries.
 *
 * Harness: MemoryBackend storage + MockTransport (map-backed, queueResponse, call
 * tracking) + MockCrypto (no WASM). Mirrors sync_service_test.mjs patterns.
 * The W1/W2 tests drive the real reconcile seam `SyncService._reconcileAndClaim(mk)`
 * with `_genesisCompatible = true` (unit seam), and W3 asserts the `_ledgerActivityIds()`
 * helper. All are RED now: the pull is NOT wired, the drop is NOT applied, and
 * `_ledgerActivityIds()` does NOT exist yet.
 *
 * Usage:
 *   node test/web_ledger_auto_pull_test.mjs
 */

import { createHash } from 'crypto';

import { SyncService } from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { LOCAL_LEDGER_BLOCKS } from '../src/sync/keys.js';
import { base64ToBytes, bytesToBase64 } from '../src/sync/base64.js';

// ══════════════════════════════════════════════════════════════════════
// Mock CryptoService — matches SyncService / LocalCache expectations.
// No WASM — plain sha256, obfuscateBlob/key-fingerprint passthrough, enc: prefix.
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor(mk) {
    this._mk = mk || null;
    this._uuidCounter = 0;
    this._specCounter = 0;
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

  getDeviceId() {
    return `dev-${(this._mk || 'none').slice(0, 8)}`;
  }

  seal(jsonStr, mk) {
    const key = mk || this._mk || 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    return createHash('sha256').update(key + ':' + jsonStr).digest('hex');
  }

  verifySeal(jsonStr, sealVal, mk) {
    return this.seal(jsonStr, mk) === sealVal;
  }

  sealBlock(blockData) {
    return this.seal(JSON.stringify(blockData), null);
  }

  obfuscateBlob(plaintext, mk) {
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = mk
      ? createHash('sha256').update(mk).digest().slice(0, 4)
      : Buffer.alloc(4);
    return Buffer.concat([keyFingerprint, plainBytes]).toString('base64');
  }

  deobfuscateBlob(b64, mk) {
    const obfuscated = Buffer.from(b64, 'base64');
    const sym = Buffer.alloc(4);
    if (mk) {
      if (!obfuscated.slice(0, 4).equals(Buffer.from(createHash('sha256').update(mk).digest().slice(0, 4)))) {
        throw new Error('key mismatch');
      }
    }
    return obfuscated.slice(4).toString('utf-8');
  }

  decrypt(ciphertextHex) {
    if (ciphertextHex && String(ciphertextHex).startsWith('enc:')) return String(ciphertextHex).slice(4);
    return ciphertextHex;
  }

  decryptWithCachedKey(ciphertextHex) {
    if (ciphertextHex && String(ciphertextHex).startsWith('plain:')) return String(ciphertextHex).slice(6);
    return ciphertextHex;
  }

  encrypt(plaintext) { return `enc:${plaintext}`; }
  encryptWithCachedKey(plaintext) { return `enc:${plaintext}`; }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Transport — map-backed remote R2, with FIFO response-queue + offline.
// ══════════════════════════════════════════════════════════════════════

const COOKIE_PATH = 'staging/blobs/device_cookie.bin';

class MockTransport {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this._store = new Map();
    /** @type {Map<string, Array<Uint8Array|null>>} */
    this._queue = new Map();
    this._offline = false;
    this._pullCalls = [];
  }

  queueResponse(path, value) {
    const arr = this._queue.get(path) || [];
    arr.push(value);
    this._queue.set(path, arr);
  }

  async pull(path) {
    this._pullCalls.push(path);
    if (this._offline) throw new Error('Network failure');
    const q = this._queue.get(path);
    if (q && q.length > 0) return q.shift();
    const val = this._store.get(path);
    return val !== undefined ? val : null;
  }

  async push(path, data) {
    if (this._offline) throw new Error('Network failure');
    this._store.set(path, data);
  }

  async delete(path) {
    if (this._offline) throw new Error('Network failure');
    this._store.delete(path);
  }

  async listFiles(prefix) {
    if (this._offline) throw new Error('Network failure');
    const out = [];
    for (const [path] of this._store) {
      if (path.startsWith(prefix)) out.push(path.slice(prefix.length));
    }
    return out;
  }

  resetCallTracking() { this._pullCalls = []; }
  hasKey(path) { return this._store.has(path); }

  /** @returns {string|null} deobfuscated plaintext of a stored path */
  readPlain(path, crypto, mk) {
    const raw = this._store.get(path);
    if (!raw) return null;
    return crypto.deobfuscateBlob(bytesToBase64(raw), mk);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const MK = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';

function createSyncService() {
  const storage = new MemoryBackend();
  const crypto = new MockCrypto(MK);
  const transport = new MockTransport();
  const sync = new SyncService(storage, crypto, transport, {
    cookieTtlMinutes: 30,
  });
  return { sync, storage, crypto, transport };
}

/** Seed a remote device cookie (same device = Case-A fast reconcile). */
async function pushRemoteCookie(transport, deviceUuid, specifier) {
  const cookieJson = JSON.stringify({ device_uuid: deviceUuid, device_specifier: specifier });
  await transport.push(COOKIE_PATH, new TextEncoder().encode(cookieJson));
}

/** Seed one obfuscated ledger block file at ledger/blocks/<NNNNNN>.json. */
async function pushRemoteLedgerBlock(transport, crypto, block, idx) {
  const base = `${idx}`.padStart(6, '0');
  const obfuscatedB64 = crypto.obfuscateBlob(JSON.stringify(block), MK);
  const bytes = base64ToBytes(obfuscatedB64);
  await transport.push(`ledger/blocks/${base}.json`, bytes);
}

/**
 * Seed local staging DTOs directly (canonical activity_id keying). Each dto:
 * { activity_id, title, updated_at, committed }. converted to canon row via
 * dtoToCanonicalRow on the local side of the reconcile merge.
 */
async function seedLocalStaging(storage, crypto, rows) {
  const dtos = rows.map((r, i) => ({
    activity_id: r.activity_id,
    entry_id: r.activity_id,
    title: `task-${r.activity_id}`,
    activity_status: r.activity_status || 'active',
    is_active: false,
    is_paused: false,
    updated_at: r.updated_at ?? (1000 + i),
    committed: r.committed || false,
  }));
  const sync = new SyncService(storage, crypto, new MockTransport(), {});
  await sync._local.writeEntries(dtos);
}

/** Execute the real ledger-pull/ledger-aware-drop reconcile seam in isolation. */
async function runReconcile(sync) {
  sync._genesisCompatible = true; // unit seam — skip genesis gate for W1/W2
  return sync._reconcileAndClaim(MK);
}

/** Read local staging DTOs after a reconcile. */
async function readLocalEntries(sync) {
  return sync._local.readEntries();
}

/** Derive the sealed-id set via the (future) Web helper. Clean RED when absent. */
async function ledgerActivityIds(sync) {
  if (typeof sync._ledgerActivityIds !== 'function') return undefined;
  try {
    return await sync._ledgerActivityIds();
  } catch {
    return undefined;
  }
}

/** Do the merged rows include the given activity_id (post-reconcile local push target)? */
function rowsActivityIds(rows) {
  return (rows || []).map((r) => r.activity_id);
}

/**
 * Push the canonical-format staging blob used by _mergeRemoteIntoLocal's
 * _rowsFromRemoteBlob canonical path. Rows: {activity_id, activity_status?,
 * activity?, updated_at, committed?}.
 */
async function pushRemoteCanonicalBlob(transport, crypto, rows) {
  const blob = JSON.stringify({
    device_id: 'dev-remote',
    device_proof: '',
    entries: rows.map((r) => ({
      activity_id: r.activity_id,
      activity_status: r.activity_status || 'active',
      activity: r.activity || '{}',
      updated_at: r.updated_at || Date.now(),
      committed: r.committed || false,
    })),
  });
  const obfuscatedB64 = crypto.obfuscateBlob(blob, MK);
  await transport.push('staging/blob', base64ToBytes(obfuscatedB64));
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

async function run() {
  console.log('══ Web Ledger Auto-Pull on Ownership-Handoff (ADR-030) ══\n');

  // ── Group W1: Ledger pull on ownership-handoff ─────────────────────
  console.log('── Group W1: Ledger pull on ownership-handoff ──\n');

  // W1.1 — fresh no-cookie reconcile-and-claim pulls the remote ledger when
  // remote block-count > local (0). After reconcile, LOCAL_LEDGER_BLOCKS is
  // persisted from the remote chain. Current impl: no pull wired → empty → RED.
  {
    const { sync, storage, transport, crypto } = createSyncService();
    // remote chain with 2 day blocks (sealing A1, A2 respectively)
    await pushRemoteLedgerBlock(transport, crypto, {
      type: 'day', date: '2026-01-01', entries: [
        { hash: 'h1', data: { activity_id: 'A1', title: 't1', startTime_enc: 'plain:1' } },
      ],
    }, 0);
    await pushRemoteLedgerBlock(transport, crypto, {
      type: 'day', date: '2026-01-02', entries: [
        { hash: 'h2', data: { activity_id: 'A2', title: 't2', startTime_enc: 'plain:2' } },
      ],
    }, 1);
    // local self cookie + no remote cookie → reconcile-and-claim
    await storage.set('cookie', { device_specifier: 'spec-w11', creation_time: Date.now() });
    await seedLocalStaging(storage, crypto, []);
    transport.queueResponse(COOKIE_PATH, null);

    await runReconcile(sync);

    const blocks = (await storage.get(LOCAL_LEDGER_BLOCKS)) || [];
    t.assertEq(blocks.length, 2, 'W1.1 fresh claim pulls remote ledger → LOCAL_LEDGER_BLOCKS length 2 (RED: got ' + blocks.length + ')');
  }

  // W1.2 — cookie-specifier-mismatch reauth (different device) pulls the remote
  // ledger when remote has more blocks. Current: no pull → RED.
  {
    const { sync, storage, transport, crypto } = createSyncService();
    await pushRemoteLedgerBlock(transport, crypto, {
      type: 'day', date: '2026-02-01', entries: [
        { hash: 'h1', data: { activity_id: 'B1', title: 't1', startTime_enc: 'plain:1' } },
      ],
    }, 0);
    // local cookie spec A, remote cookie spec B (mismatch → reconcile)
    await storage.set('cookie', { device_specifier: 'spec-local-A', creation_time: Date.now() });
    await pushRemoteCookie(transport, 'dev-remote', 'spec-remote-B');
    await seedLocalStaging(storage, crypto, []);

    await runReconcile(sync);

    const blocks = (await storage.get(LOCAL_LEDGER_BLOCKS)) || [];
    t.assertEq(blocks.length, 1, 'W1.2 mismatch-reauth pulls remote ledger → LOCAL_LEDGER_BLOCKS length 1 (RED: got ' + blocks.length + ')');
  }

  // W1.3 — freshness gate: remote block-count == local count → NO re-pull.
  // Seed local = 2 blocks AND remote = 2 blocks. After reconcile the local
  // blocks array is untouched (length still 2, not overwritten/replaced).
  // Current: no pull path exists at all, so it trivially passes — this is a
  // guard that Phase 3 must keep true (must not unconditionally pull).
  {
    const { sync, storage, transport, crypto } = createSyncService();
    const localChain2 = [
      { type: 'genesis', genesis_hash: 'g', entries: [] },
      { type: 'day', date: '2026-03-01', entries: [{ hash: 'h1', data: { activity_id: 'C1', title: 't', startTime_enc: 'plain:1' } }] },
    ];
    await storage.set(LOCAL_LEDGER_BLOCKS, localChain2);
    await pushRemoteLedgerBlock(transport, crypto, localChain2[0], 0);
    await pushRemoteLedgerBlock(transport, crypto, localChain2[1], 1);
    await storage.set('cookie', { device_specifier: 'spec-w13', creation_time: Date.now() });
    await pushRemoteCookie(transport, 'dev-remote', 'spec-remote-C');
    await seedLocalStaging(storage, crypto, []);

    transport.resetCallTracking();
    await runReconcile(sync);

    const blocksAfter = (await storage.get(LOCAL_LEDGER_BLOCKS)) || [];
    // Equality gate: the chain must not have been re-downloaded/replaced.
    t.assertEq(blocksAfter.length, localChain2.length,
      'W1.3 remote==local block count → no re-pull, local chain preserved (RED if re-pulled)');
    // Guard: no ledger/blocks/ listFiles happened (pull would have listed);
    // Phase 3 must gate the pull on checkForRemoteChain so this stays true.
    const listedLedger = transport._pullCalls.some((p) => String(p).includes('ledger/blocks/'));
    t.assert(!listedLedger, 'W1.3 no ledger/blocks listFiles when counts equal (RED if unconditionally pulling)');
  }

  // W1.4 — remote ledger absent/empty → handoff proceeds, no ledger persisted,
  // no throw. Current: passes (guard). Phase 3 must not break it.
  {
    const { sync, storage, transport, crypto } = createSyncService();
    await storage.set('cookie', { device_specifier: 'spec-w14', creation_time: Date.now() });
    await pushRemoteCookie(transport, 'dev-remote', 'spec-remote-D');
    await seedLocalStaging(storage, crypto, []);
    // no ledger blocks on remote at all

    const result = await runReconcile(sync);
    const blocks = (await storage.get(LOCAL_LEDGER_BLOCKS)) || [];
    t.assertEq(blocks.length, 0, 'W1.4 empty remote ledger → no ledger persisted (RED if fabricated)');
    t.assert(result !== undefined, 'W1.4 empty remote ledger → reconcile resolves (no throw) (RED if crash)');
  }

  // W1.5 — ledger pull/verify THROWS (offline / bad crypto) → reconcile still
  // runs and staging is reconciled; no local exception. Current: reconcile runs
  // fine (pull not wired). Phase 3 must swallow ledger errors (RED if propagated).
  {
    const { sync, storage, transport, crypto } = createSyncService();
    // offline transport → ledger pull would throw; stash a local row so a
    // successful reconcile would otherwise be observable.
    transport._offline = true;
    await storage.set('cookie', { device_specifier: 'spec-w15', creation_time: Date.now() });
    await seedLocalStaging(storage, crypto, [{ activity_id: 'E1', updated_at: 500 }]);

    const result = await runReconcile(sync);
    // Reconcile resolves (does not swallow to a crash). Given offline, it cannot
    // pull a ledger — the key assertion is that _reconcileAndClaim does not throw
    // when the ledger pull fails.
    t.assert(result !== undefined, 'W1.5 ledger pull throws → reconcile still resolves (no crash) (RED if propagated)');
  }

  // ── Group W2: Scenario-5/6 ledger-aware staging cleanup ─────────────
  console.log('\n── Group W2: Scenario-5/6 ledger-aware staging cleanup ──\n');

  // W2.1 — UNCOMMITTED local-only merged row sealed in the ledger is DROPPED
  // (not written to local, not pushed). Current: row survives in local staging → RED.
  {
    const { sync, storage, transport, crypto } = createSyncService();
    // local ledger seals A1
    await storage.set(LOCAL_LEDGER_BLOCKS, [
      { type: 'day', date: '2026-04-01', entries: [{ hash: 'h', data: { activity_id: 'A1', title: 't', startTime_enc: 'plain:1' } }] },
    ]);
    // local staging has uncommitted row A1
    await seedLocalStaging(storage, crypto, [{ activity_id: 'A1', committed: false, updated_at: 100 }]);
    await storage.set('cookie', { device_specifier: 'spec-w21', creation_time: Date.now() });
    await pushRemoteCookie(transport, 'dev-remote', 'spec-remote-w21');
    // empty remote blob → local-only row is what merge produces
    await transport.push('staging/blob', base64ToBytes(crypto.obfuscateBlob(
      JSON.stringify({ device_id: 'dev-remote', entries: [] }), MK)));

    await runReconcile(sync);

    const localIds = rowsActivityIds(await readLocalEntries(sync));
    t.assert(!localIds.includes('A1'),
      'W2.1 uncommitted sealed row A1 is DROPPED from local staging (RED: still present)');

    // No remote blob push of the dropped row either.
    const pushedRaw = transport.hasKey('staging/blob')
      ? JSON.parse(transport.readPlain('staging/blob', crypto, MK))
      : null;
    const pushedIds = pushedRaw && pushedRaw.entries ? pushedRaw.entries.map((e) => e.activity_id) : [];
    t.assert(!pushedIds.includes('A1'),
      'W2.1 uncommitted sealed row A1 is absent from pushed remote blob (RED: still pushed)');
  }

  // W2.2 — UNCOMMITTED local-only row NOT in the ledger SURVIVES and is pushed
  // to remote. Current: survives → passes (guard). Phase 3 must not over-delete.
  {
    const { sync, storage, transport, crypto } = createSyncService();
    // ledger seals only AA (different row); local has BB (not sealed)
    await storage.set(LOCAL_LEDGER_BLOCKS, [
      { type: 'day', date: '2026-04-02', entries: [{ hash: 'h', data: { activity_id: 'AA', title: 't', startTime_enc: 'plain:1' } }] },
    ]);
    await seedLocalStaging(storage, crypto, [{ activity_id: 'BB', committed: false, updated_at: 200 }]);
    await storage.set('cookie', { device_specifier: 'spec-w22', creation_time: Date.now() });
    await pushRemoteCookie(transport, 'dev-remote', 'spec-remote-w22');
    await transport.push('staging/blob', base64ToBytes(crypto.obfuscateBlob(
      JSON.stringify({ device_id: 'dev-remote', entries: [] }), MK)));

    await runReconcile(sync);

    const localIds = rowsActivityIds(await readLocalEntries(sync));
    t.assert(localIds.includes('BB'),
      'W2.2 uncommitted non-sealed row BB SURVIVES in local staging (RED if over-deleted)');

    const pushedRaw = transport.hasKey('staging/blob')
      ? JSON.parse(transport.readPlain('staging/blob', crypto, MK))
      : null;
    const pushedIds = pushedRaw && pushedRaw.entries ? pushedRaw.entries.map((e) => e.activity_id) : [];
    t.assert(pushedIds.includes('BB'),
      'W2.2 uncommitted non-sealed row BB is pushed to remote (RED if over-deleted)');
  }

  // W2.3 — COMMITTED display row sealed in the ledger is PRESERVED for History
  // (the ledger chain still contains it after reconcile — History derives from the
  // chain, and the new drop must only filter UNCOMMITTED staging rows, never the chain).
  // Current: chain preserved → passes (guard). Phase 3 must not corrupt the chain.
  {
    const { sync, storage, transport, crypto } = createSyncService();
    const chain = [
      { type: 'day', date: '2026-04-03', entries: [{ hash: 'h', data: { activity_id: 'ZZ', title: 't', startTime_enc: 'plain:1' } }] },
    ];
    await storage.set(LOCAL_LEDGER_BLOCKS, chain);
    await seedLocalStaging(storage, crypto, [{ activity_id: 'ZZ', committed: true, updated_at: 300 }]);
    await storage.set('cookie', { device_specifier: 'spec-w23', creation_time: Date.now() });
    await pushRemoteCookie(transport, 'dev-remote', 'spec-remote-w23');
    await transport.push('staging/blob', base64ToBytes(crypto.obfuscateBlob(
      JSON.stringify({ device_id: 'dev-remote', entries: [] }), MK)));

    await runReconcile(sync);

    const blocks = (await storage.get(LOCAL_LEDGER_BLOCKS)) || [];
    const sealedIds = blocks.flatMap((b) => (b.entries || []).map((en) => en.data && en.data.activity_id));
    t.assert(sealedIds.includes('ZZ'),
      'W2.3 committed display row ZZ remains in ledger chain (History preserved) (RED if chain corrupted)');
  }

  // W2.4 — empty local ledger → reconcile behaves as today (no rows dropped).
  // Current: no drop → survives → passes (guard). Phase 3 must be a strict no-op.
  {
    const { sync, storage, transport, crypto } = createSyncService();
    await seedLocalStaging(storage, crypto, [{ activity_id: 'Q1', committed: false, updated_at: 10 }]);
    await storage.set('cookie', { device_specifier: 'spec-w24', creation_time: Date.now() });
    await pushRemoteCookie(transport, 'dev-remote', 'spec-remote-w24');
    await transport.push('staging/blob', base64ToBytes(crypto.obfuscateBlob(
      JSON.stringify({ device_id: 'dev-remote', entries: [] }), MK)));

    await runReconcile(sync);

    const localIds = rowsActivityIds(await readLocalEntries(sync));
    t.assert(localIds.includes('Q1'),
      'W2.4 empty ledger → no rows dropped, Q1 survives (RED if over-deleting on empty ledger)');
  }

  // W2.5 — the cleanup runs AFTER the LWW merge and BEFORE the remote push: a row
  // sealed in the ledger is absent from the pushed remote blob. Current: row present
  // in pushed blob → RED.
  {
    const { sync, storage, transport, crypto } = createSyncService();
    await storage.set(LOCAL_LEDGER_BLOCKS, [
      { type: 'day', date: '2026-04-04', entries: [{ hash: 'h', data: { activity_id: 'P1', title: 't', startTime_enc: 'plain:1' } }] },
    ]);
    // local row P1 uncommitted → should be dropped before the push
    await seedLocalStaging(storage, crypto, [{ activity_id: 'P1', committed: false, updated_at: 50 }]);
    await storage.set('cookie', { device_specifier: 'spec-w25', creation_time: Date.now() });
    await pushRemoteCookie(transport, 'dev-remote', 'spec-remote-w25');
    await transport.push('staging/blob', base64ToBytes(crypto.obfuscateBlob(
      JSON.stringify({ device_id: 'dev-remote', entries: [] }), MK)));

    await runReconcile(sync);

    const pushedRaw = transport.hasKey('staging/blob')
      ? JSON.parse(transport.readPlain('staging/blob', crypto, MK))
      : null;
    const pushedIds = pushedRaw && pushedRaw.entries ? pushedRaw.entries.map((e) => e.activity_id) : [];
    t.assert(!pushedIds.includes('P1'),
      'W2.5 sealed row P1 absent from pushed blob (drop ran before push) (RED: still pushed)');
  }

  // ── Group W3: Web `_ledgerActivityIds()` derivation ────────────────
  console.log('\n── Group W3: Web `_ledgerActivityIds()` derivation ──\n');

  // W3.1 — day-block entries' data.activity_id values are collected into the set.
  {
    const { sync, storage } = createSyncService();
    await storage.set(LOCAL_LEDGER_BLOCKS, [
      { type: 'day', date: '2026-05-01', entries: [
        { hash: 'h1', data: { activity_id: 'M1', title: 't', startTime_enc: 'plain:1' } },
        { hash: 'h2', data: { activity_id: 'M2', title: 't', startTime_enc: 'plain:2' } },
      ] },
      { type: 'day', date: '2026-05-02', entries: [
        { hash: 'h3', data: { activity_id: 'M3', title: 't', startTime_enc: 'plain:3' } },
      ] },
    ]);

    const sealed = await ledgerActivityIds(sync);
    // RED cleanly when the helper does not exist yet.
    if (sealed === undefined) {
      t.assert(false, 'W3.1 sealed set derived from day data.activity_id (RED: _ledgerActivityIds() not implemented)');
    } else {
      const sorted = [...sealed].sort();
      t.assertDeepEq(sorted, ['M1', 'M2', 'M3'], 'W3.1 day entries seal M1/M2/M3');
    }
  }

  // W3.2 — summary/genesis blocks and empty days contribute nothing.
  {
    const { sync, storage } = createSyncService();
    await storage.set(LOCAL_LEDGER_BLOCKS, [
      { type: 'genesis', genesis_hash: 'g', entries: [{ hash: 'h', data: { activity_id: 'GHOST' } }] },
      { type: 'month_summary', date: '2026-05', entries: [{ hash: 'h', data: { activity_id: 'SUM' } }] },
      { type: 'day', date: '2026-05-03', entries: [] }, // empty day
      { type: 'day', date: '2026-05-04', entries: [{ hash: 'h', data: { activity_id: 'LIVE' } }] },
    ]);

    const sealed = await ledgerActivityIds(sync);
    if (sealed === undefined) {
      t.assert(false, 'W3.2 only day entries contribute (RED: helper not implemented)');
    } else {
      t.assertDeepEq([...sealed], ['LIVE'], 'W3.2 summary/genesis/empty-day contribute nothing → only LIVE');
    }
  }

  // W3.3 — malformed/missing activity_id entries are skipped safely (no throw).
  {
    const { sync, storage } = createSyncService();
    await storage.set(LOCAL_LEDGER_BLOCKS, [
      { type: 'day', date: '2026-05-05', entries: [
        { hash: 'h1', data: { title: 'no-activity-id' } },
        { hash: 'h2', data: null },
        null,
        { hash: 'h3', data: { activity_id: 'OK1' } },
      ] },
      { type: 'day', date: '2026-05-06', data: 'not-an-array' },
    ]);

    const sealed = await ledgerActivityIds(sync);
    if (sealed === undefined) {
      t.assert(false, 'W3.3 malformed entries skipped (RED: helper not implemented)');
    } else {
      t.assertDeepEq([...sealed], ['OK1'], 'W3.3 malformed/missing activity_id skipped → only OK1, no throw');
    }
  }

  // ── Results ─────────────────────────────────────────────────────────
  const failures = t.summary('Web Ledger Auto-Pull (ADR-030)');
  process.exitCode = failures > 0 ? 1 : 0;
}

run().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
