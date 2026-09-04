/**
 * sync_push_updated_at_test.mjs — Option A: pushed canonical row carries the
 * locally-persisted `updated_at` (not the push-time `Date.now()`).
 *
 * Phase 2 (RED) test for `docs/planning/WEB_STAGING_UPDATED_AT_PHASE1.md`
 * Group E.
 *
 * Fails for the right reason: LocalCache does not persist `updated_at`, so
 * `readEntries()` returns `updated_at === undefined` while the pushed row's
 * `dtoToCanonicalRow` falls back to `Date.now()` — the two never match.
 *
 * Run: node test/sync_push_updated_at_test.mjs
 */

import { createHash } from 'crypto';

import { SyncService } from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

// ── Mocks (mirror cross_client_web_test.mjs) ─────────────────────────

class MockTransport {
  constructor() { this._store = new Map(); }
  async pull(path) { return this._store.get(path) ?? null; }
  async push(path, data) { this._store.set(path, data); }
  async delete(path) { this._store.delete(path); }
  async listFiles(prefix) {
    return [...this._store.keys()].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length));
  }
  resetCache() {}
}

class MockCrypto {
  constructor() {
    this._uuidCounter = 0;
    this._specCounter = 0;
    this._mk = null;
  }
  sha256(data) { return createHash('sha256').update(data, 'utf-8').digest('hex'); }
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
  seal(jsonStr, masterKey) {
    const mk = masterKey || this._mk || 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    return createHash('sha256').update(mk + ':' + jsonStr).digest('hex');
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
    const storedFingerprint = obfuscated.slice(0, 4);
    if (mk) {
      const expectedFingerprint = createHash('sha256').update(mk).digest().slice(0, 4);
      if (!storedFingerprint.equals(expectedFingerprint)) throw new Error('key mismatch');
    }
    return obfuscated.slice(4).toString('utf-8');
  }
  decryptWithCachedKey(ciphertextHex) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('plain:')) return ciphertextHex.slice(6);
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('enc:')) return ciphertextHex.slice(4);
    return ciphertextHex;
  }
  decrypt(ciphertextHex, _mk) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('enc:')) return ciphertextHex.slice(4);
    return ciphertextHex;
  }
  encrypt(plaintext, _mk) { return `enc:${plaintext}`; }
  encryptWithCachedKey(plaintext) { return `enc:${plaintext}`; }
  authenticate(passphrase, seed) {
    const hash = createHash('sha256').update(passphrase + ':' + seed).digest('hex');
    this._mk = hash;
    return hash;
  }
}

const BLOB_PATH = 'staging/blob';
const MK = 'push-mk-push-mk-push-mk-push-mk-push-mk-pushmk';
const t = new TestHelpers();

async function run() {
  console.log('══ SyncService push carries persisted updated_at (Option A) — Group E ══\n');

  // E1 — pushed canonical row.updated_at equals locally-persisted value
  {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    const transport = new MockTransport();
    crypto.setMasterKey(MK);
    const sync = new SyncService(storage, crypto, transport, { cookieTtlMinutes: 30 });

    await sync.capture({ title: 'Push Task', startEpoch: 1000, is_active: true });

    const localEntries = await sync.readEntries();
    const localUpdatedAt = localEntries[0].updated_at;

    await sync.pushToRemote(MK);

    const rawBytes = await transport.pull(BLOB_PATH);
    t.assert(rawBytes !== null, 'E1a blob was pushed to remote');
    const b64 = Buffer.from(rawBytes).toString('base64');
    const plaintext = crypto.deobfuscateBlob(b64, MK);
    const blob = JSON.parse(plaintext);
    const row = blob.entries[0];
    t.assertEq(row.updated_at, localUpdatedAt,
      'E1 pushed row updated_at equals locally-persisted value (not push-time)');
  }

  const failed = t.summary('sync_push_updated_at');
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
