/**
 * worker_connect_active_rows_test.mjs — Cross-client staging convergence C1.
 *
 * C1: Web restore stops skipping `active` rows. The bug is the
 * `if (status === 'active' || row.is_active === true) continue;` line in
 * `connectToWorker` (DevModeContext.jsx ~line 1009) — it drops every
 * in-progress row on a fresh restore, so a Web session shows "No active
 * tasks" even though Flutter/CLI pushed an active row to the shared blob.
 *
 * Fix (Phase 3): export `_rowsFromRemoteBlob` from `src/sync/sync.js` as
 * `rowsFromRemoteBlob(remoteBlob, now)`, then route `connectToWorker`
 * through it: `rowsFromRemoteBlob(stagingData, now)` →
 * `mergeRows([], rows)` → `canonicalRowToDTO` → filter `!committed` →
 * `LocalCache.writeEntries`. This aligns Web to the CLI (no contract change).
 *
 * Phase 2 (RED): these tests are written before the implementation.
 * `rowsFromRemoteBlob` is not yet exported, so every assertion that routes
 * through it is RED for the right reason ("rowsFromRemoteBlob is not a
 * function"). A2/A3 are intentional-green guards: `mergeRows` and
 * `canonicalRowToDTO` already handle active rows correctly — the bug lived
 * only in the ad-hoc `connectToWorker` loop.
 *
 * Groups (blueprint: docs/planning/C1_WEB_RESTORE_ACTIVE_PHASE1.md):
 *   A — active rows imported (core C1 fix)  (6)
 *   B — mergeRows convergence              (5)
 *   C — status fidelity regression guards  (4)
 *   D — full-chain restore no-regression   (5)
 *
 * Usage:
 *   node test/worker_connect_active_rows_test.mjs
 */

import { createHash } from 'crypto';
import { TextDecoder } from 'util';

import * as syncModule from '../src/sync/sync.js';
import { mergeRows } from '../src/sync/row_sync.js';
import { canonicalRowToDTO } from '../src/sync/entry_dto.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { LocalCache } from '../src/sync/local_cache.js';
import { WorkerImportSource } from '../src/sync/remote_import.js';
import { bytesToBase64 } from '../src/sync/base64.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

const { SyncService } = syncModule;
// C1 target: Phase 3 exports `_rowsFromRemoteBlob` as `rowsFromRemoteBlob`.
// In Phase 2 this is undefined → RED ("is not a function") for every test
// that routes through the shared converter.
const rowsFromRemoteBlob = syncModule.rowsFromRemoteBlob;

const NOW = 1700000000000;

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

function activityBlob({ title = 'Task', start_epoch = NOW, end_epoch = null, is_active = true, is_paused = false, entry_id = '' } = {}) {
  return JSON.stringify({ title, start_epoch, end_epoch, is_active, is_paused, entry_id });
}

/** Canonical staging row (PHPSPEC §8). */
function canonRow(id, { status = 'active', committed = false, updatedAt = NOW, title = 'Task', isActive = status !== 'ended', startEpoch = NOW } = {}) {
  return {
    activity_id: id,
    activity_status: status,
    activity: JSON.stringify({
      title,
      start_epoch: startEpoch,
      end_epoch: isActive ? null : startEpoch + 1000,
      is_active: isActive,
      is_paused: status === 'paused',
      entry_id: id,
    }),
    updated_at: updatedAt,
    committed,
  };
}

/**
 * The C1 target staging-restore pipeline (mirrors the Phase 3 connectToWorker
 * staging section, minus LocalCache persistence):
 *   rowsFromRemoteBlob → mergeRows([], rows) → canonicalRowToDTO → !committed.
 */
function restoreStaging(blob, now) {
  const rows = rowsFromRemoteBlob(blob, now);
  const merged = mergeRows([], rows);
  return merged.filter((m) => !m.committed).map((m) => canonicalRowToDTO(m)).filter(Boolean);
}

/** Group-wrapping runner: converts an uncaught throw into a recorded failure
 * so RED tests (missing `rowsFromRemoteBlob`) report cleanly instead of
 * aborting the whole file. */
async function group(name, fn) {
  console.log('\n' + name);
  try {
    await fn();
  } catch (err) {
    t.assert(false, `${name} — threw: ${err.message}`);
  }
}

// Minimal crypto for Group B1 (mirrors terminal_state_merge_test.mjs): no
// master key → LocalCache stores plaintext; sha256 covers entry-hash.
class MinimalCrypto {
  hasMasterKey() { return false; }
  sha256(s) { return createHash('sha256').update(s, 'utf-8').digest('hex'); }
  generateUuid() { return '00000000-0000-4000-8000-000000000001'; }
}

// ══════════════════════════════════════════════════════════════════════
// Group A: Active rows imported (core C1 fix)
// ══════════════════════════════════════════════════════════════════════

await group('═══ Group A: active rows imported (core C1 fix) ═══', async () => {
  // A1 — rowsFromRemoteBlob keeps a canonical active row.
  {
    const blob = { entries: [canonRow('a1', { status: 'active' })] };
    const rows = rowsFromRemoteBlob(blob, NOW);
    t.assertEq(rows.length, 1, 'A1 active row survives conversion');
    t.assertEq(rows[0].activity_id, 'a1', 'A1 activity_id preserved');
    t.assertEq(rows[0].activity_status, 'active', 'A1 active status preserved');
  }

  // A2 — mergeRows([], rows) keeps a remote-only active row (guard, green).
  {
    const merged = mergeRows([], [canonRow('a2', { status: 'active' })]);
    t.assertEq(merged.length, 1, 'A2 remote-only active row included');
    t.assertEq(merged[0].activity_status, 'active', 'A2 active status kept');
  }

  // A3 — canonicalRowToDTO yields is_active:true, committed:false (guard, green).
  {
    const dto = canonicalRowToDTO(canonRow('a3', { status: 'active' }));
    t.assertEq(dto.is_active, true, 'A3 active → is_active true');
    t.assertEq(dto.committed, false, 'A3 uncommitted → committed false');
    t.assertEq(dto.activity_id, 'a3', 'A3 activity_id preserved');
  }

  // A4 — flat/legacy web row (no `activity` string) is not skipped, derives active.
  {
    const flat = { activity_id: 'a4', title: 'Flat active', start_epoch: NOW, is_active: true };
    const rows = rowsFromRemoteBlob({ entries: [flat] }, NOW);
    t.assertEq(rows.length, 1, 'A4 flat row not dropped');
    t.assertEq(rows[0].activity_status, 'active', 'A4 flat row derives active');
  }

  // A4b — flat rows derive status from is_paused / is_active:false (Phase 4
  // refactor: flat rows route through dtoToCanonicalRow, matching the legacy
  // branch's status derivation instead of defaulting every flat row to active).
  {
    const paused = rowsFromRemoteBlob({ entries: [{ activity_id: 'a4-p', title: 'Flat paused', start_epoch: NOW, is_paused: true }] }, NOW);
    t.assertEq(paused.length, 1, 'A4b flat paused row not dropped');
    t.assertEq(paused[0].activity_status, 'paused', 'A4b flat paused → paused');

    const ended = rowsFromRemoteBlob({ entries: [{ activity_id: 'a4-e', title: 'Flat ended', start_epoch: NOW, is_active: false }] }, NOW);
    t.assertEq(ended.length, 1, 'A4b flat ended row not dropped');
    t.assertEq(ended[0].activity_status, 'ended', 'A4b flat ended (is_active:false) → ended');
  }

  // A5 — canonical row with empty activity_status + activity blob is_active:true → active.
  {
    const row = {
      activity_id: 'a5',
      activity_status: '',
      activity: activityBlob({ title: 'Empty status', is_active: true }),
      updated_at: NOW,
      committed: false,
    };
    const rows = rowsFromRemoteBlob({ entries: [row] }, NOW);
    t.assertEq(rows.length, 1, 'A5 empty-status row not dropped');
    t.assertEq(rows[0].activity_status, 'active', 'A5 empty-status fallback derives active');
  }

  // A6 — two distinct active rows both survive (no cross-id collapse/drop).
  {
    const blob = { entries: [canonRow('a6-1', { status: 'active' }), canonRow('a6-2', { status: 'active' })] };
    const rows = rowsFromRemoteBlob(blob, NOW);
    const merged = mergeRows([], rows);
    t.assertEq(merged.length, 2, 'A6 both active rows survive');
    t.assert(merged.some((r) => r.activity_id === 'a6-1'), 'A6 first id present');
    t.assert(merged.some((r) => r.activity_id === 'a6-2'), 'A6 second id present');
    t.assert(merged.every((r) => r.activity_status === 'active'), 'A6 both stay active');
  }
});

// ══════════════════════════════════════════════════════════════════════
// Group B: mergeRows convergence
// ══════════════════════════════════════════════════════════════════════

await group('═══ Group B: mergeRows convergence ═══', async () => {
  // B1 — restore path and _mergeRemoteIntoLocal (empty local) agree.
  {
    const blob = {
      device_id: 'dev-remote',
      entries: [
        canonRow('b1-active', { status: 'active', title: 'Act', updatedAt: 100 }),
        canonRow('b1-paused', { status: 'paused', title: 'Pau', updatedAt: 200 }),
        canonRow('b1-ended', { status: 'ended', title: 'End', updatedAt: 300 }),
        canonRow('b1-committed', { status: 'ended', committed: true, title: 'Com', updatedAt: 400 }),
      ],
    };

    const restore = restoreStaging(blob, NOW);

    const storage = new MemoryBackend();
    const sync = new SyncService(storage, new MinimalCrypto(), null, {});
    await sync._mergeRemoteIntoLocal(blob, [], 'dev-local');
    const merged = await sync.readEntries();

    const norm = (arr) => arr
      .map((d) => ({ id: d.activity_id, is_active: d.is_active, is_paused: d.is_paused, committed: d.committed }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    t.assertDeepEq(norm(restore), norm(merged), 'B1 restore and merge paths produce identical row sets');
    t.assertEq(norm(restore).length, 3, 'B1 committed cache row excluded from both paths');
  }

  // B2 — rowsFromRemoteBlob handles canonical AND legacy {hash, data} formats.
  {
    const canonicalRows = rowsFromRemoteBlob({ entries: [canonRow('b2-c', { status: 'active' })] }, NOW);
    t.assertEq(canonicalRows.length, 1, 'B2 canonical format parsed');
    t.assertEq(canonicalRows[0].activity_status, 'active', 'B2 canonical active');

    const legacyBlob = {
      device_id: 'dev-legacy',
      entries: [{
        hash: 'deadbeef',
        data: {
          entry_id: 'b2-legacy',
          title_enc: 'plain:Legacy active',
          startTime_enc: 'plain:' + NOW,
          is_active: true,
          is_paused: false,
        },
      }],
    };
    const legacyRows = rowsFromRemoteBlob(legacyBlob, NOW);
    t.assertEq(legacyRows.length, 1, 'B2 legacy format parsed');
    t.assertEq(legacyRows[0].activity_id, 'b2-legacy', 'B2 legacy entry_id → activity_id fallback');
    t.assertEq(legacyRows[0].activity_status, 'active', 'B2 legacy derives active');
  }

  // B3 — committed display-cache rows still excluded from restored staging.
  {
    const blob = {
      entries: [
        canonRow('b3-live', { status: 'active' }),
        canonRow('b3-cache', { status: 'ended', committed: true }),
      ],
    };
    const dto = restoreStaging(blob, NOW);
    t.assertEq(dto.length, 1, 'B3 committed display-cache row excluded');
    t.assertEq(dto[0].activity_id, 'b3-live', 'B3 live row kept');
  }

  // B4 — a row both active and committed is excluded (committed wins).
  {
    const blob = {
      entries: [canonRow('b4', { status: 'active', committed: true })],
    };
    const dto = restoreStaging(blob, NOW);
    t.assertEq(dto.length, 0, 'B4 active+committed row excluded');
  }

  // B5 — active rows appear after restore (the skip branch is gone).
  {
    const blob = {
      entries: [
        canonRow('b5-active', { status: 'active', title: 'Live task' }),
        canonRow('b5-ended', { status: 'ended', title: 'Done task' }),
      ],
    };
    const dto = restoreStaging(blob, NOW);
    t.assertEq(dto.length, 2, 'B5 both rows survive');
    t.assert(dto.some((d) => d.activity_id === 'b5-active' && d.is_active === true), 'B5 active row appears (skip removed)');
  }
});

// ══════════════════════════════════════════════════════════════════════
// Group C: Status fidelity regression guards
// ══════════════════════════════════════════════════════════════════════

await group('═══ Group C: status fidelity regression guards ═══', async () => {
  // C1 — paused row restores as paused.
  {
    const dto = restoreStaging({ entries: [canonRow('c1', { status: 'paused' })] }, NOW);
    t.assertEq(dto.length, 1, 'C1 paused row restored');
    t.assertEq(dto[0].is_paused, true, 'C1 paused → is_paused true');
  }

  // C2 — ended row restores as ended (is_active false).
  {
    const dto = restoreStaging({ entries: [canonRow('c2', { status: 'ended' })] }, NOW);
    t.assertEq(dto.length, 1, 'C2 ended row restored');
    t.assertEq(dto[0].is_active, false, 'C2 ended → is_active false');
  }

  // C3 — mixed blob restores to exactly 3 uncommitted rows.
  {
    const blob = {
      entries: [
        canonRow('c3-a', { status: 'active' }),
        canonRow('c3-p', { status: 'paused' }),
        canonRow('c3-e', { status: 'ended' }),
        canonRow('c3-c', { status: 'ended', committed: true }),
      ],
    };
    const dto = restoreStaging(blob, NOW);
    t.assertEq(dto.length, 3, 'C3 mixed blob → 3 uncommitted (committed dropped)');
    t.assert(dto.every((d) => d.committed !== true), 'C3 no committed rows remain');
  }

  // C4 — updated_at survives conversion → merge → DTO rebuild.
  {
    const ts = 1234567890123;
    const dto = restoreStaging({ entries: [canonRow('c4', { status: 'active', updatedAt: ts })] }, NOW);
    t.assertEq(dto.length, 1, 'C4 row restored');
    t.assertEq(dto[0].updated_at, ts, 'C4 updated_at preserved through the pipeline');
  }
});

// ══════════════════════════════════════════════════════════════════════
// Group D: Full-chain restore no-regression
// ══════════════════════════════════════════════════════════════════════
//
// A compact full-chain fixture + the connectFullChain mirror (routed through
// the shared rowsFromRemoteBlob / mergeRows), proving the active-row fix does
// not disturb chain fetch, D11 staging isolation, history rendering, field
// fidelity, or the wrong-passphrase auth guard.

const PASSPHRASE = 'correct horse battery staple';
const SEED = 'test-seed-c1-active-rows';

function deterministicHash(data) {
  let hash = 5381;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(64, '0');
}

function mockEncrypt(plaintext, key) {
  const tag = deterministicHash(key).slice(0, 8);
  const encoded = Buffer.from(plaintext, 'utf-8').toString('base64');
  return 'enc:' + tag + ':' + encoded;
}

function mockDecrypt(ciphertext, _key) {
  if (ciphertext && ciphertext.startsWith('enc:')) {
    const parts = ciphertext.split(':');
    if (parts.length >= 3) return Buffer.from(parts.slice(2).join(':'), 'base64').toString('utf-8');
    return ciphertext;
  }
  return ciphertext;
}

class MockCrypto {
  constructor() { this._mk = null; }
  setMasterKey(k) { this._mk = k; }
  getMasterKey() { return this._mk; }
  hasMasterKey() { return !!this._mk; }
  derivePdk(p, it) { return deterministicHash(p + ':' + it); }
  authenticate(p, s, it) { return deterministicHash(p + ':' + s + ':' + it); }
  encrypt(pt, k) { return mockEncrypt(pt, k); }
  decrypt(ct, k) { return mockDecrypt(ct, k); }
  seal(d, mk) { return deterministicHash(d + (mk || this._mk || '')); }
  verifySeal(d, hex, mk) { return this.seal(d, mk) === hex; }
  sha256(d) { return createHash('sha256').update(d, 'utf-8').digest('hex'); }
  hmacHex(k, d) { return createHash('sha256').update(k + d, 'utf-8').digest('hex'); }
  obfuscateBlob(plaintext, mk) {
    const fp = mk ? createHash('sha256').update(mk).digest().slice(0, 4) : Buffer.alloc(4);
    const out = Buffer.concat([fp, Buffer.from(plaintext, 'utf-8')]);
    return out.toString('base64');
  }
  deobfuscateBlob(b64, mk) {
    const ob = Buffer.from(b64, 'base64');
    if (mk) {
      const exp = createHash('sha256').update(mk).digest().slice(0, 4);
      if (!ob.slice(0, 4).equals(exp)) throw new Error('key mismatch');
    }
    return ob.slice(4).toString('utf-8');
  }
  decryptWithCachedKey(hex) {
    if (hex && hex.startsWith('enc:')) return mockDecrypt(hex, this._mk);
    return hex;
  }
  encryptWithCachedKey(value) {
    return mockEncrypt(String(value), this._mk);
  }
  clearMasterKey() { this._mk = null; }
}

class MockTransport {
  constructor() { this._store = new Map(); }
  async pull(path) { return this._store.get(path) ?? null; }
  async push(path, data) { this._store.set(path, data); }
  async delete(path) { this._store.delete(path); }
  async listFiles(prefix) {
    const out = [];
    for (const [path] of this._store) {
      if (path.startsWith(prefix)) out.push(path.slice(prefix.length));
    }
    return out;
  }
  setData(path, value) {
    if (value == null) this._store.delete(path);
    else this._store.set(path, value);
  }
  hasKey(path) { return this._store.has(path); }
}

class MockStorage {
  constructor() { this._store = new Map(); }
  async get(k) { return this._store.get(k); }
  async set(k, v) { this._store.set(k, v); }
  async delete(k) { this._store.delete(k); }
  async clear() { this._store.clear(); }
  hasKey(k) { return this._store.has(k); }
}

function jsonSort(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => {
    const v = obj[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(k) + ':' + jsonSort(v);
    return JSON.stringify(k) + ':' + JSON.stringify(v);
  });
  return '{' + parts.join(',') + '}';
}

const ENTRY_HASH_FN = (mk) => (data) => deterministicHash(jsonSort(data) + mk);

function buildRemoteLedger() {
  const mk = deterministicHash(PASSPHRASE + ':' + SEED + ':' + 600000);
  const crypto = new MockCrypto();
  crypto.setMasterKey(mk);
  const hashEntry = ENTRY_HASH_FN(mk);

  const pdk = deterministicHash(PASSPHRASE + ':' + 600000);
  const genesis = {
    type: 'genesis',
    day_index: 0,
    date: '2026-06-20',
    format_version: '0.3.0',
    identity: {
      username: 'wacevedo',
      email: 'w@p.test',
      recovery_seed_enc: mockEncrypt(SEED, pdk),
      identity_secret_enc_fallback: mockEncrypt('id-secret', mk),
      identity_pub_key: deterministicHash('identity:' + SEED),
    },
    prev_hash: '0'.repeat(64),
    entries: [],
  };
  genesis.day_hash = deterministicHash(jsonSort(genesis) + mk);
  genesis.signature = deterministicHash('sign:' + genesis.day_hash + 'identity');

  const committedEntry = { entry_id: 'c-1001', title: 'Committed activity', start_epoch: 1750400000000, end_epoch: 1750403600000, duration: 3600000 };
  committedEntry._blockDate = '2026-06-20';
  const chain = [
    { ...genesis },
    {
      type: 'day',
      format_version: '0.3.0',
      day_index: 1,
      date: '2026-06-20',
      prev_hash: genesis.day_hash,
      entries: [{ hash: hashEntry(committedEntry), data: committedEntry }],
      day_hash: deterministicHash('day-1-' + mk),
    },
  ];

  const transport = new MockTransport();
  chain.forEach((block, i) => {
    const b64 = crypto.obfuscateBlob(jsonSort(block), mk);
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    transport.setData(`ledger/blocks/${String(i).padStart(6, '0')}.json`, bytes);
  });

  // Staging blob: one ACTIVE row (the C1 fix target), one ended-uncommitted
  // row, and one committed display-cache row (already sealed).
  const activeRow = {
    activity_id: 'a-active',
    activity_status: 'active',
    committed: false,
    updated_at: 1750490000000,
    activity: JSON.stringify({ entry_id: 'a-active', title: 'Active task', start_epoch: 1750490000000, is_active: true, is_paused: false }),
  };
  const endedUncommitted = {
    activity_id: 'stg-2001',
    activity_status: 'ended',
    committed: false,
    updated_at: 1750490000000,
    activity: JSON.stringify({ entry_id: 'stg-2001', title: 'Pending to commit', start_epoch: 1750490000000, end_epoch: 1750493600000, is_active: false, is_paused: false }),
  };
  const committedCache = {
    activity_id: 'c-1001',
    activity_status: 'ended',
    committed: true,
    updated_at: 1750403600000,
    activity: JSON.stringify({ entry_id: 'c-1001', title: 'Committed activity', start_epoch: 1750400000000, end_epoch: 1750403600000, is_active: false, is_paused: false }),
  };
  const stagingB64 = crypto.obfuscateBlob(JSON.stringify({ entries: [activeRow, endedUncommitted, committedCache] }), mk);
  transport.setData('staging/blob', new Uint8Array(Buffer.from(stagingB64, 'base64')));

  return { transport, crypto, mk, chain };
}

/** Mirrors the target connectToWorker core, routed through the shared helper. */
async function connectFullChain({ transport, crypto }) {
  const masterKey = crypto.getMasterKey();
  const chain = await WorkerImportSource.fetchChain(transport, crypto, masterKey);
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error('No ledger blocks found on remote.');
  }
  const genesisBlock = chain[0];
  if (!genesisBlock || genesisBlock.type !== 'genesis') {
    throw new Error('Remote ledger does not have a valid genesis block.');
  }

  const storage = new MockStorage();
  await storage.clear();
  await storage.set('ledger:blocks', chain);
  await storage.set('phpoc_seed', SEED);
  if (genesisBlock.identity && genesisBlock.identity.username) {
    await storage.set('phpoc_username', genesisBlock.identity.username);
  }

  // C1: route the staging restore through the shared converter + mergeRows.
  const pendingRows = [];
  const raw = await transport.pull('staging/blob');
  if (raw) {
    const b64 = bytesToBase64(raw);
    const json = crypto.deobfuscateBlob(b64, masterKey);
    const rows = rowsFromRemoteBlob(JSON.parse(json), Date.now());
    const merged = mergeRows([], rows);
    for (const mrow of merged) {
      if (mrow.committed) continue; // skip committed display cache
      const dto = canonicalRowToDTO(mrow);
      if (dto) pendingRows.push(dto);
    }
  }

  if (pendingRows.length > 0) {
    const local = new LocalCache(storage, crypto);
    await local.writeEntries(pendingRows);
  }

  return { chain, storage, pendingRows };
}

async function localReadEntries(storage, crypto) {
  return new LocalCache(storage, crypto).readEntries();
}

function simulateGetCompleted({ chain, pendingRows }) {
  const committedDTOs = [];
  const committedIds = new Set();
  for (const block of chain) {
    if (block.type === 'genesis' || block.type === 'year_summary' || block.type === 'month_summary') continue;
    for (const raw of block.entries || []) {
      const eid = raw.data?.entry_id || raw.hash;
      if (eid && committedIds.has(eid)) continue;
      committedDTOs.push({ entry_id: eid, title: raw.data?.title || '', start_epoch: raw.data?.start_epoch, committed: true });
      if (eid) committedIds.add(eid);
    }
  }
  const dedupedStaging = pendingRows.filter((e) => !e.entry_id || !committedIds.has(e.entry_id));
  return [...committedDTOs, ...dedupedStaging.map((r) => ({ ...r, committed: false }))];
}

await group('═══ Group D: full-chain restore no-regression ═══', async () => {
  // D1 — full committed chain still stored in ledger:blocks.
  {
    const { transport, crypto, chain } = buildRemoteLedger();
    const { storage } = await connectFullChain({ transport, crypto });
    const stored = await storage.get('ledger:blocks');
    t.assertEq(stored.length, chain.length, 'D1 all remote blocks stored');
    t.assertEq(stored.length, 2, 'D1 genesis + day block pulled');
    t.assertEq(stored[1].type, 'day', 'D1 committed day block present');
  }

  // D2 — restored staging rows are NOT promoted into the ledger (no D11 auto-commit).
  {
    const { transport, crypto } = buildRemoteLedger();
    const { chain } = await connectFullChain({ transport, crypto });
    const dayBlocks = chain.filter((b) => b.type === 'day');
    t.assertEq(dayBlocks.length, 1, 'D2 no extra day block minted');
    const ledgerIds = [];
    for (const b of chain) for (const e of b.entries || []) ledgerIds.push(e.data?.entry_id);
    t.assert(!ledgerIds.includes('a-active'), 'D2 active staging row NOT promoted into ledger');
    t.assert(!ledgerIds.includes('stg-2001'), 'D2 uncommitted staging row NOT promoted');
  }

  // D3 — committed history still visible via getCompleted.
  {
    const { transport, crypto, chain } = buildRemoteLedger();
    const { pendingRows } = await connectFullChain({ transport, crypto });
    const all = simulateGetCompleted({ chain, pendingRows });
    const committed = all.filter((e) => e.committed === true);
    t.assertEq(committed.length, 1, 'D3 committed activity visible');
    t.assert(committed.some((e) => e.title === 'Committed activity'), 'D3 committed history rendered');
  }

  // D4 — uncommitted non-active rows render with full fields (no blank cards).
  {
    const { transport, crypto } = buildRemoteLedger();
    const { storage, pendingRows } = await connectFullChain({ transport, crypto });

    // The ACTIVE row must now appear (C1 fix) — behavioral proof the skip is gone.
    t.assert(pendingRows.some((d) => d.activity_id === 'a-active' && d.is_active === true), 'D4 active row appears after restore (skip removed)');

    const staged = await localReadEntries(storage, crypto);
    const ended = staged.find((d) => d.activity_id === 'stg-2001');
    t.assert(!!ended, 'D4 ended uncommitted row kept');
    t.assertEq(ended.title, 'Pending to commit', 'D4 title renders (no blank card)');
    t.assert(ended.start_epoch > 0, 'D4 start_epoch renders (no blank card)');
  }

  // D5 — restore fails gracefully on wrong passphrase (no partial state).
  {
    const { transport } = buildRemoteLedger();
    const badCrypto = new MockCrypto();
    badCrypto.setMasterKey(deterministicHash(PASSPHRASE + ':WRONG:' + 600000));

    let threw = false;
    let errorMsg = '';
    try {
      await connectFullChain({ transport, crypto: badCrypto });
    } catch (err) {
      threw = true;
      errorMsg = err.message;
    }
    t.assert(threw, 'D5 wrong master key causes connect to throw');
    t.assert(/mismatch|deobfuscate|fetch|No ledger/i.test(errorMsg), `D5 error indicates auth/fetch failure (got: "${errorMsg}")`);
  }
});

t.summary('Worker Connect Active-Rows (C1)');
process.exitCode = t.failed > 0 ? 1 : 0;
