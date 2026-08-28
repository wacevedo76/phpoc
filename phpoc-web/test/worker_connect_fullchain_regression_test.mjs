/**
 * worker_connect_fullchain_regression_test.mjs — Regression for the
 * staging-based `connectToWorker` bug (commit 588b034 reverted behavior).
 *
 * That regression made `connectToWorker` pull only the genesis block + the
 * shared staging `staging/blob`, then re-commit EVERY staging row into a
 * fresh local chain. Two user-visible bugs resulted:
 *   1. Genuinely-uncommitted staging rows were auto-promoted to the ledger
 *      (appeared as committed — green border on History), violating D11.
 *   2. The actual committed history (the full ledger/blocks/*.json chain)
 *      was never fetched, so History was nearly empty.
 *
 * This test locks in the fixed behavior: connectToWorker fetches the FULL
 * remote chain into `ledger:blocks` (so committed history loads), and keeps
 * only genuinely-uncommitted rows in local staging (so pending items stay
 * uncommitted). It never auto-commits staging (D11).
 *
 * Coverage:
 *   Group A: full-chain fetch — all remote blocks stored in ledger:blocks
 *   Group B: no D11 auto-commit — staging stays out of the ledger
 *   Group C: uncommitted row preserved — appears uncommitted in History
 *   Group D: committed history visible — getCompleted returns committed entries
 *
 * Usage:
 *   node test/worker_connect_fullchain_regression_test.mjs
 */

import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import { TestHelpers } from './test_helpers.mjs';
import { bytesToBase64 } from '../src/sync/base64.js';
import { WorkerImportSource } from '../src/sync/remote_import.js';
import { LocalCache } from '../src/sync/local_cache.js';
import { canonicalRowToDTO } from '../src/sync/entry_dto.js';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Deterministic helpers (mirrors worker_connect_blocks_format_test.mjs)
// ══════════════════════════════════════════════════════════════════════

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
  // rawCommittedEntryToDTO uses decryptWithCachedKey
  decryptWithCachedKey(hex) {
    if (hex && hex.startsWith('enc:')) return mockDecrypt(hex, this._mk);
    return hex;
  }
  // LocalCache._encrypt uses encryptWithCachedKey
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

// ══════════════════════════════════════════════════════════════════════
// Chain / staging builders
// ══════════════════════════════════════════════════════════════════════

const PASSPHRASE = 'correct horse battery staple';
const SEED = 'test-seed-fullchain-regression';

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

function buildGenesis({ username, email }) {
  const mk = deterministicHash(PASSPHRASE + ':' + SEED + ':' + 600000);
  const pdk = deterministicHash(PASSPHRASE + ':' + 600000);
  const genesis = {
    type: 'genesis',
    day_index: 0,
    date: '2026-06-20',
    format_version: '0.3.0',
    identity: {
      username,
      email,
      recovery_seed_enc: mockEncrypt(SEED, pdk),
      identity_secret_enc_fallback: mockEncrypt('id-secret', mk),
      identity_pub_key: deterministicHash('identity:' + SEED),
    },
    prev_hash: '0'.repeat(64),
    entries: [],
  };
  genesis.day_hash = deterministicHash(jsonSort(genesis) + mk);
  genesis.signature = deterministicHash('sign:' + genesis.day_hash + 'identity');
  return genesis;
}

const ENTRY_HASH_FN = (mk) => (data) => deterministicHash(jsonSort(data) + mk);

/**
 * Build a chain of day blocks with committed entries, published as obfuscated
 * files, plus a staging blob of { committed-display-cache, uncommitted } rows.
 */
function buildRemoteLedger() {
  const mk = deterministicHash(PASSPHRASE + ':' + SEED + ':' + 600000);
  const crypto = new MockCrypto();
  crypto.setMasterKey(mk);
  const hashEntry = ENTRY_HASH_FN(mk);

  const genesis = buildGenesis({ username: 'wacevedo', email: 'w@p.test' });
  const chain = [{ ...genesis }];

  // Two day blocks each with a committed entry (the real history).
  const day1EntryData = { entry_id: 'c-1001', title: 'Committed activity one', start_epoch: 1750400000000, end_epoch: 1750403600000, duration: 3600000 };
  day1EntryData._blockDate = '2026-06-20';
  const day1Raw = { hash: hashEntry(day1EntryData), data: day1EntryData };
  chain.push({
    type: 'day',
    format_version: '0.3.0',
    day_index: 1,
    date: '2026-06-20',
    prev_hash: genesis.day_hash,
    entries: [day1Raw],
    day_hash: deterministicHash('day-1-' + mk),
  });

  const day2EntryData = { entry_id: 'c-1002', title: 'Committed activity two', start_epoch: 1750486400000, end_epoch: 1750489999999, duration: 3600000 };
  day2EntryData._blockDate = '2026-06-21';
  const day2Raw = { hash: hashEntry(day2EntryData), data: day2EntryData };
  chain.push({
    type: 'day',
    format_version: '0.3.0',
    day_index: 2,
    date: '2026-06-21',
    prev_hash: chain[1].day_hash,
    entries: [day2Raw],
    day_hash: deterministicHash('day-2-' + mk),
  });

  // Publish obfuscated block files.
  const transport = new MockTransport();
  chain.forEach((block, i) => {
    const json = jsonSort(block);
    const b64 = crypto.obfuscateBlob(json, mk);
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    transport.setData(`ledger/blocks/${String(i).padStart(6, '0')}.json`, bytes);
  });

  // Staging blob: one committed display-cache row (already sealed), one
  // genuinely-uncommitted row (still awaiting commit on phone).
  const committedCache = {
    activity_id: 'c-1001',
    activity_status: 'ended',
    committed: true,
    updated_at: 1750403600000,
    activity: JSON.stringify({ entry_id: 'c-1001', title: 'Committed activity one', start_epoch: 1750400000000, end_epoch: 1750403600000, duration: 3600000 }),
  };
  const uncommittedRow = {
    activity_id: 'stg-2001',
    activity_status: 'ended',
    committed: false,
    updated_at: 1750490000000,
    activity: JSON.stringify({ entry_id: 'stg-2001', title: 'Pending to commit', start_epoch: 1750490000000, end_epoch: 1750493600000, duration: 3600000 }),
  };
  const stagingObj = { entries: [committedCache, uncommittedRow] };
  const stagingB64 = crypto.obfuscateBlob(JSON.stringify(stagingObj), mk);
  const stagingBytes = new Uint8Array(Buffer.from(stagingB64, 'base64'));
  transport.setData('staging/blob', stagingBytes);

  return { transport, crypto, mk, chain };
}

/**
 * Mirrors the FIXED connectToWorker core: fetch full chain via
 * WorkerImportSource.fetchChain, store it in ledger:blocks, keep only
 * UNCOMMITTED staging rows in local staging. Does NOT auto-commit staging.
 */
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

  // Keep only genuinely-uncommitted rows from the remote staging blob.
  const pendingRows = [];
  const raw = await transport.pull('staging/blob');
  if (raw) {
    const b64 = bytesToBase64(raw);
    const json = crypto.deobfuscateBlob(b64, masterKey);
    const rows = JSON.parse(json).entries || [];
    for (const row of rows) {
      const status = row.activity_status || row.is_active;
      if (status === 'active' || row.is_active === true) continue;
      if (row.committed === true) continue; // skip committed display cache
      // Normalize row → canonical staging row → DTO (mirrors connectToWorker).
      const canonical = {
        activity_id: row.activity_id,
        activity_status: row.activity_status,
        updated_at: row.updated_at,
        committed: false,
      };
      if (row.activity && typeof row.activity === 'string') {
        canonical.activity = row.activity;
      } else {
        canonical.activity = JSON.stringify({
          entry_id: row.entry_id || row.activity_id,
          title: row.title,
          start_epoch: row.start_epoch,
          end_epoch: row.end_epoch,
          duration: row.duration,
          is_active: row.is_active ?? false,
          is_paused: row.is_paused ?? false,
          pauses: row.pauses || [],
          tags: row.tags || [],
          comment: row.comment || null,
          media: row.media || [],
          device_uuid: row.device_uuid || '',
          end_device_uuid: row.end_device_uuid || '',
          metadata: row.metadata || {},
        });
      }
      const dto = canonicalRowToDTO(canonical);
      if (dto) pendingRows.push(dto);
    }
  }
  // Persist via LocalCache.writeEntries (proper spec format {hash, data}).
  if (pendingRows.length > 0) {
    const local = new LocalCache(storage, crypto);
    await local.writeEntries(pendingRows);
  }

  return { chain, storage, pendingRows };
}

/**
 * Read back staging exactly as the Sync/History screens do — via
 * LocalCache.readEntries(), which decodes {hash, data:{..._enc}} spec format
 * back into flat DTOs (start_epoch, title, etc.).
 */
async function localReadEntries(storage, crypto) {
  return new LocalCache(storage, crypto).readEntries();
}

/**
 * Replicates the committed + staging merge from SyncService.getCompleted(),
 * plus dedup by entry_id.
 */
function simulateGetCompleted({ chain, pendingRows }) {
  const committedDTOs = [];
  const committedIds = new Set();
  for (const block of chain) {
    if (block.type === 'genesis' || block.type === 'year_summary' || block.type === 'month_summary') continue;
    for (const raw of block.entries || []) {
      const eid = raw.data?.entry_id || raw.hash;
      if (eid && committedIds.has(eid)) continue;
      committedDTOs.push({
        entry_id: eid,
        title: raw.data?.title || '',
        start_epoch: raw.data?.start_epoch,
        committed: true,
      });
      if (eid) committedIds.add(eid);
    }
  }
  const dedupedStaging = pendingRows.filter((e) => !e.entry_id || !committedIds.has(e.entry_id));
  return [...committedDTOs, ...dedupedStaging.map((r) => ({ ...r, committed: false }))];
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

console.log('\n═══ Group A: full chain stored in ledger:blocks (history loads) ═══');
{
  const { transport, crypto, chain } = buildRemoteLedger();
  const { storage } = await connectFullChain({ transport, crypto });

  const stored = await storage.get('ledger:blocks');
  t.assert(Array.isArray(stored), 'A1: ledger:blocks is an array');
  t.assertEq(stored.length, chain.length, 'A2: ALL remote blocks stored (full committed chain)');
  t.assertEq(stored.length, 3, 'A3: 3 blocks (genesis + 2 day blocks) pulled');
  t.assertEq(stored[1].type, 'day', 'A4: block 1 is a day block');
  const dayCount = stored.filter((b) => b.type === 'day').length;
  t.assertEq(dayCount, 2, 'A5: two committed day blocks present');
}

console.log('\n═══ Group B: no D11 auto-commit — staging stays out of the ledger ═══');
{
  const { transport, crypto } = buildRemoteLedger();
  const { chain } = await connectFullChain({ transport, crypto });

  // Assert the ledger itself is untouched by staging — it has exactly the
  // committed day blocks, no extra blocks minted from the uncommitted staging.
  const dayBlocks = chain.filter((b) => b.type === 'day');
  t.assertEq(dayBlocks.length, 2, 'B1: no additional day block created by auto-commit');
  const allEntryIds = [];
  for (const b of chain) for (const e of b.entries || []) allEntryIds.push(e.data?.entry_id);
  t.assert(!allEntryIds.includes('stg-2001'), 'B2: uncommitted staging row NOT promoted into ledger');
  t.assert(allEntryIds.includes('c-1001'), 'B3: committed history present in ledger');
}

console.log('\n═══ Group C: uncommitted row preserved + renders with full fields ═══');
{
  const { transport, crypto } = buildRemoteLedger();
  const { pendingRows, storage } = await connectFullChain({ transport, crypto });

  t.assertEq(pendingRows.length, 1, 'C1: exactly one pending row kept (committed cache dropped)');
  t.assertEq(pendingRows[0].entry_id, 'stg-2001', 'C2: pending row is the genuinely-uncommitted one');
  t.assertEq(pendingRows[0].title, 'Pending to commit', 'C3: pending title preserved');

  const staged = await localReadEntries(storage, crypto);
  t.assertEq(staged.length, 1, 'C4: local staging has only the uncommitted row');
  t.assert(staged[0].committed !== true, 'C5: pending row is NOT flagged committed');
  // Issue-1 guard: the card must NOT be blank — title + start_epoch survive the
  // write → read round-trip through LocalCache._dtoToRaw/_rawToDto.
  t.assertEq(staged[0].title, 'Pending to commit', 'C6: title renders (no blank card)');
  t.assert(staged[0].start_epoch > 0, 'C7: start_epoch renders (no blank card)');
}

console.log('\n═══ Group D: History shows committed history AND uncommitted pending ═══');
{
  const { transport, crypto, chain } = buildRemoteLedger();
  const { pendingRows } = await connectFullChain({ transport, crypto });
  const all = simulateGetCompleted({ chain, pendingRows });

  // Committed history from the full chain is visible.
  const committed = all.filter((e) => e.committed === true);
  t.assertEq(committed.length, 2, 'D1: both previously-committed activities appear');
  t.assert(committed.some((e) => e.title === 'Committed activity one'), 'D2: committed activity #1 visible');
  t.assert(committed.some((e) => e.title === 'Committed activity two'), 'D3: committed activity #2 visible');

  // The pending row appears but as UNCOMMITTED (staging) — not green.
  const pending = all.filter((e) => e.title === 'Pending to commit');
  t.assertEq(pending.length, 1, 'D4: pending activity appears exactly once');
  t.assertEq(pending[0].committed, false, 'D5: pending activity is UNCOMMITTED (staging, not green)');
  t.assertEq(all.length, 3, 'D6: total of 3 entries (2 committed + 1 pending)');
}

console.log('\n═══ Group E: connect fails gracefully on wrong passphrase (no partial write) ═══');
{
  const { transport, crypto } = buildRemoteLedger();
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
  t.assert(threw, 'E2: wrong master key causes connect to throw (no silent partial state)');
  t.assert(
    /mismatch|deobfuscate|fetch|No ledger/i.test(errorMsg),
    `E1: error indicates auth/fetch failure (got: "${errorMsg}")`
  );
}

t.summary('Worker Connect Full-Chain Regression');
process.exitCode = t.failed > 0 ? 1 : 0;
