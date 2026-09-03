/**
 * commonplace_sync_test_support.mjs — Shared test support for the Commonplace
 * remote-sync slice (blueprint: docs/planning/COMMONPLACE_BOOK_SYNC_WEB_PHASE1.md).
 *
 * Provides the remote path constants, an in-memory FakeSyncTransport, a keyed
 * MockCrypto (keyed obfuscate/deobfuscate so the wrong-MK assertions are
 * meaningful), and the chain-building / remote-seeding helpers used by:
 *   - commonplace_push_service_test.mjs   (Group P)
 *   - commonplace_pull_service_test.mjs   (Group L)
 *   - commonplace_reconcile_test.mjs      (Group F)
 *   - commonplace_sync_e2e_test.mjs       (Group R)
 *
 * Only depends on code that already exists, so the RED test files fail solely
 * on the not-yet-created Commonplace sync services (CommonplacePushService /
 * CommonplacePullService) and the not-yet-added methods
 * (CommonplaceService.reconcileRemoteChain / CommonplacePullService.pullIfRemoteHasMore).
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { MockCrypto } from './mock_crypto.mjs';
import { CommonplaceChain } from '../src/commonplace/commonplace_chain.js';
import { base64ToBytes, bytesToBase64 } from '../src/sync/base64.js';

// ── Constants ──────────────────────────────────────────────────────

export const syncTestMkHex = 'abababababababababababababababababababababababababababababababab';
export const syncWrongMkHex = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

export const COMMONPLACE_BLOCKS_PREFIX = 'commonplace/blocks/';
export const COMMONPLACE_HASH_INDEX = 'commonplace/hash_index.json';

export function commonplaceBlockPath(index) {
  return `${COMMONPLACE_BLOCKS_PREFIX}${String(index).padStart(6, '0')}.json`;
}

// ── Keyed MockCrypto ───────────────────────────────────────────────

/**
 * MockCrypto with keyed obfuscate/deobfuscate, mirroring the real WASM
 * CryptoService where the master key gates the obfuscation. The plain
 * MockCrypto's obfuscation is reversible regardless of key, which cannot
 * exercise the wrong-MK assertions (CPSW-L5 / CPSW-R5).
 */
export class KeyedMockCrypto extends MockCrypto {
  obfuscateBlob(plaintext, masterKeyHex) {
    const keyHash = this.sha256(masterKeyHex || '');
    return Buffer.from(`kobf:${keyHash}:${plaintext}`, 'utf-8').toString('base64');
  }

  deobfuscateBlob(b64, masterKeyHex) {
    const decoded = Buffer.from(b64, 'base64').toString('utf-8');
    const keyHash = this.sha256(masterKeyHex || '');
    const prefix = `kobf:${keyHash}:`;
    if (!decoded.startsWith(prefix)) {
      throw new Error('KeyedMockCrypto: wrong master key (deobfuscate mismatch)');
    }
    return decoded.slice(prefix.length);
  }
}

/** A keyed crypto, optionally caching [mkHex] (pass null for no cached key). */
export function makeCrypto(mkHex = syncTestMkHex) {
  const crypto = new KeyedMockCrypto();
  if (mkHex != null) crypto.setMasterKey(mkHex);
  return crypto;
}

// ── jsonSortNoSpaces ───────────────────────────────────────────────

/**
 * Sorted-keys compact JSON with no-space separators — mirrors the to-be-added
 * `ledger/utils.js` `jsonSortNoSpaces` (Phase 3). Self-contained here so the
 * support file only depends on existing code while still seeding the exact
 * wire bytes CommonplacePushService will write.
 */
export function jsonSortNoSpaces(data) {
  return _jsonDumpsNoSpaces(data);
}

function _jsonDumpsNoSpaces(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map((v) => _jsonDumpsNoSpaces(v)).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = [];
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined) pairs.push(JSON.stringify(k) + ':' + _jsonDumpsNoSpaces(v));
  }
  return '{' + pairs.join(',') + '}';
}

// ── FakeSyncTransport ──────────────────────────────────────────────

/**
 * In-memory transport fake for push/pull unit and E2E tests. [store] records
 * every pushed blob (may be pre-seeded for pull tests). Failure simulation via
 * [errorOnPushPath]/[errorOnPullPath] (HTTP status) and [unreachable]
 * (network error).
 */
export class FakeSyncTransport {
  constructor({ baseUrl = 'https://test-worker.example.com', apiKey = 'fake-api-key' } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.isHttp = true;
    /** @type {Map<string, Uint8Array>} */
    this.store = new Map();
    this.pushCount = 0;
    /** @type {Record<string, number>} */
    this.errorOnPushPath = {};
    /** @type {Record<string, number>} */
    this.errorOnPullPath = {};
    this.unreachable = false;
  }

  async pull(path) {
    if (this.unreachable) throw new Error('Network unreachable');
    const status = this.errorOnPullPath[path];
    if (status != null) throw new Error(`HTTP ${status} on pull(${path})`);
    return this.store.has(path) ? this.store.get(path) : null;
  }

  async push(path, data) {
    if (this.unreachable) throw new Error('Network unreachable');
    const status = this.errorOnPushPath[path];
    if (status != null) throw new Error(`HTTP ${status} on push(${path})`);
    this.pushCount++;
    this.store.set(path, data);
  }

  async listFiles(prefix) {
    if (this.unreachable) throw new Error('Network unreachable');
    return [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  async delete(path) {
    this.store.delete(path);
  }

  resetCache() {}
}

// ── Chain builders ─────────────────────────────────────────────────

/**
 * A raw (unsealed) Commonplace entry dict for CommonplaceChain.buildDayBlock.
 */
export function rawEntry({
  title = 'Title',
  entry = 'Passage',
  date = '2026-08-31',
  ts = 1754000000000,
} = {}) {
  return { type: 'commonplace', timestamp_ms: ts, date, title, entry, tags: ['tag'] };
}

/**
 * Build a Commonplace chain with a genesis block and [dayBlocks] sealed day
 * blocks (one entry each, distinct dates). Genesis params are fixed so
 * separately-built chains share an identical genesis hash (genesis sealing is
 * deterministic); day-block ciphertext is non-deterministic (random nonce).
 *
 * Returns the live [CommonplaceChain] over [store] (a fresh MemoryBackend by
 * default).
 */
export async function buildChain(crypto, { store = null, dayBlocks = 1 } = {}) {
  const s = store || new MemoryBackend();
  const chain = new CommonplaceChain(crypto, s, crypto.getMasterKey());
  await chain.buildGenesis({
    username: 'sync-user',
    email: 'sync@example.com',
    recoverySeedEnc: 'seed-enc',
    identityPubKey: 'pub-key-hex',
    identitySecretEncFallback: 'fallback-hex',
  });
  let prevHash = chain.getBlockHashFor(await chain.getLastBlock());
  for (let i = 0; i < dayBlocks; i++) {
    const dateStr = `2026-08-${String(31 - i).padStart(2, '0')}`;
    const block = await chain.buildDayBlock(
      [rawEntry({ title: `Title ${i}`, entry: `Passage ${i}`, date: dateStr, ts: 1754000000000 + i })],
      prevHash,
      dateStr,
    );
    await chain.append(block);
    prevHash = chain.getBlockHashFor(block);
  }
  return chain;
}

/**
 * Seed a fake transport with the obfuscated blocks + plaintext hash index of
 * [chain], exactly as CommonplacePushService would write them.
 */
export async function seedRemoteChain(transport, chain, crypto, mkHex) {
  const blocks = await chain.readAll();
  const hashes = blocks.map((b) => chain.getBlockHashFor(b));
  transport.store.set(COMMONPLACE_HASH_INDEX, new TextEncoder().encode(JSON.stringify(hashes)));
  for (let i = 0; i < blocks.length; i++) {
    const serialized = jsonSortNoSpaces(blocks[i]);
    const b64 = crypto.obfuscateBlob(serialized, mkHex);
    transport.store.set(commonplaceBlockPath(i), base64ToBytes(b64));
  }
}

/**
 * Deobfuscate a stored block from [transport] and return its plaintext JSON.
 */
export function decodeStoredBlock(transport, index, crypto, mkHex) {
  const bytes = transport.store.get(commonplaceBlockPath(index));
  return crypto.deobfuscateBlob(bytesToBase64(bytes), mkHex);
}

/**
 * Decode the plaintext hash index array from [transport].
 */
export function readHashIndex(transport) {
  const bytes = transport.store.get(COMMONPLACE_HASH_INDEX);
  return JSON.parse(new TextDecoder().decode(bytes));
}
