/**
 * staging_mutation_wiring.mjs — ADR-034 P2 mutation/read wiring (Phase 2 RED).
 *
 * Mutation flow only (read-flow hash gate is P3). After a local staging
 * mutation, the client must recompute the key-independent `staging_hash`
 * over canonical non-committed rows, bump `seq`, update the LOCAL cookie
 * (`last_seen_hash`/`last_seen_seq`, keep `device_specifier`), push the blob,
 * then push the REMOTE cookie.
 *
 * Groups:
 *   F-Web (F10–F17) — mutation flow:
 *     F10 remote-cookie hash equals canonical hash of pushed rows (I3).
 *     F11 hash is canonical, NOT the raw/encrypted entry serialization (D8/V3).
 *     F12 local cookie gains last_seen_hash + last_seen_seq, keeps specifier.
 *     F13 blob is pushed before the remote cookie (I3 ordering).
 *     F14 absent last_seen_seq → seq 1.
 *     F15 last_seen_seq N → seq N+1.
 *     F16 auto-sync (_pushOnFastPath) also carries hash + seq into the cookie.
 *     F17 _touchLocalCookie alone (read/check tick) never sets hash/seq.
 *   H3 — specifier stability (I5): pushToRemote reuses the specifier;
 *     _reconcileAndClaim regenerates it and carries hash + seq.
 *
 * RED expectations:
 *   F10/F11/F12/F14/F15/F16 + H3(handoff hash/seq) fail — the current
 *   pushToRemote pushes a remote cookie with only {device_uuid, device_specifier}
 *   (no staging_hash/seq) and _pushOnFastPath pushes no cookie at all;
 *   _touchLocalCookie + local-cookie writes REPLACE the cookie and drop
 *   last_seen_hash/last_seen_seq.
 *   F13 + H3(specifier reuse) are guard-green (blob-before-cookie order and
 *   same-device specifier reuse already hold).
 *
 * Blueprint: docs/planning/STAGING_MUTATION_WIRING_PHASE1.md
 *
 * Run:
 *   node --test test/staging_mutation_wiring.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';

import { SyncService } from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import {
  computeStagingHash,
  dtoToCanonicalRow,
} from '../src/sync/remote_sync.js';
import { REMOTE_STAGING_BLOB, REMOTE_DEVICE_COOKIE, LOCAL_COOKIE } from '../src/sync/keys.js';

// ── Mocks (mirror sync_push_updated_at_test.mjs) ─────────────────────────

class MockTransport {
  constructor() {
    this._store = new Map();
    this.pushOrder = []; // only blob/cookie pushes, in order
  }
  async pull(path) { return this._store.get(path) ?? null; }
  async push(path, data) {
    this._store.set(path, data);
    if (path === REMOTE_STAGING_BLOB) this.pushOrder.push('blob');
    else if (path === REMOTE_DEVICE_COOKIE) this.pushOrder.push('cookie');
  }
  async delete(path) { this._store.delete(path); }
  async listFiles(prefix) {
    return [...this._store.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
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
    const mk = masterKey || this._mk || 'deadbeef';
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

const MK = 'ab'.repeat(32); // 64-hex master key (deterministic HMAC device id)

// ── Helpers ──────────────────────────────────────────────────────────────

function makeSync() {
  const storage = new MemoryBackend();
  const crypto = new MockCrypto();
  const transport = new MockTransport();
  crypto.setMasterKey(MK);
  const sync = new SyncService(storage, crypto, transport, { cookieTtlMinutes: 30 });
  return { storage, crypto, transport, sync };
}

/** Seed a local cookie with a fixed specifier + optional extra fields. */
async function seedLocalCookie(storage, specifier, extra = {}) {
  await storage.set(LOCAL_COOKIE, {
    device_specifier: specifier,
    creation_time: Date.now(),
    ...extra,
  });
}

/** Decode the remote device cookie bytes held by the transport. */
async function remoteCookie(transport) {
  const raw = await transport.pull(REMOTE_DEVICE_COOKIE);
  if (!raw) return null;
  return JSON.parse(new TextDecoder().decode(raw));
}

/**
 * Key-independent staging hash over the current local canonical rows.
 * `deviceId`/`now` fallbacks are unused: every captured DTO carries an
 * explicit `updated_at` and `device_uuid`, so the digest is deterministic.
 */
async function canonicalHash(sync) {
  const entries = await sync.readEntries();
  const rows = entries.map((e) => dtoToCanonicalRow(e, 'unused', 0));
  return computeStagingHash(rows);
}

// ──────────────────────────────────────────────────────────────────────────
// Group F-Web — mutation flow
// ──────────────────────────────────────────────────────────────────────────

test('F10: pushToRemote sets remote cookie staging_hash to canonical hash', async () => {
  const { sync, transport } = makeSync();

  await sync.capture({ title: 'Task A', startEpoch: 1000, is_active: true });
  const expected = await canonicalHash(sync);

  await sync.pushToRemote(MK);

  const cookie = await remoteCookie(transport);
  assert.ok(cookie, 'F10 remote cookie was pushed');
  assert.equal(cookie.staging_hash, expected, 'F10 staging_hash equals canonical hash');
});

test('F11: pushToRemote derives the hash from canonical rows, not raw entries', async () => {
  const { sync, storage, transport } = makeSync();

  await sync.capture({ title: 'Task A', startEpoch: 1000, is_active: true, tags: ['X'] });
  const expected = await canonicalHash(sync);

  await sync.pushToRemote(MK);

  const cookie = await remoteCookie(transport);
  const dtos = await sync.readEntries();
  const rawStored = await storage.get('entries');
  const dtoHash = createHash('sha256').update(JSON.stringify(dtos)).digest('hex');
  const rawHash = createHash('sha256').update(JSON.stringify(rawStored)).digest('hex');

  assert.equal(cookie.staging_hash, expected, 'F11 hash is canonical');
  assert.notEqual(cookie.staging_hash, dtoHash, 'F11 hash is not the flat DTO serialization');
  assert.notEqual(cookie.staging_hash, rawHash, 'F11 hash is not the raw/encrypted storage');
});

test('F12: pushToRemote updates local cookie (hash+seq) and keeps specifier', async () => {
  const { sync, storage, transport } = makeSync();
  const before = Date.now();
  await sync.capture({ title: 'Task A', startEpoch: 1000, is_active: true });
  await seedLocalCookie(storage, 'keep-me', { last_seen_seq: 4 });
  const expected = await canonicalHash(sync);

  await sync.pushToRemote(MK);

  const local = await storage.get(LOCAL_COOKIE);
  assert.equal(local.device_specifier, 'keep-me', 'F12 keeps device_specifier');
  assert.equal(local.last_seen_hash, expected, 'F12 local last_seen_hash set');
  assert.equal(local.last_seen_seq, 5, 'F12 local last_seen_seq bumped to 5');
  assert.ok(typeof local.creation_time === 'number' && local.creation_time >= before,
    'F12 local creation_time bumped');
});

test('F13: pushToRemote pushes the blob before the remote cookie', async () => {
  const { sync, transport } = makeSync();
  await sync.capture({ title: 'Task A', startEpoch: 1000, is_active: true });

  await sync.pushToRemote(MK);

  assert.deepEqual(transport.pushOrder, ['blob', 'cookie'], 'F13 blob before cookie');
});

test('F14: pushToRemote remote cookie seq = 1 when no last_seen_seq', async () => {
  const { sync, transport } = makeSync();
  await sync.capture({ title: 'Task A', startEpoch: 1000, is_active: true });

  await sync.pushToRemote(MK);

  const cookie = await remoteCookie(transport);
  assert.ok(cookie, 'F14 remote cookie was pushed');
  assert.equal(cookie.seq, 1, 'F14 absent last_seen_seq → seq 1');
});

test('F15: pushToRemote remote cookie seq = last_seen_seq + 1', async () => {
  const { sync, storage, transport } = makeSync();
  await sync.capture({ title: 'Task A', startEpoch: 1000, is_active: true });
  await seedLocalCookie(storage, 's1', { last_seen_seq: 5 });

  await sync.pushToRemote(MK);

  const cookie = await remoteCookie(transport);
  assert.ok(cookie, 'F15 remote cookie was pushed');
  assert.equal(cookie.seq, 6, 'F15 seq = last_seen_seq + 1');
});

test('F16: _pushOnFastPath carries hash + seq into the remote cookie', async () => {
  const { sync, storage, transport } = makeSync();
  await sync.capture({ title: 'Task A', startEpoch: 1000, is_active: true });
  await seedLocalCookie(storage, 's1', { last_seen_seq: 3 });
  const expected = await canonicalHash(sync);

  await sync._pushOnFastPath({ device_specifier: 's1', creation_time: Date.now() });

  const cookie = await remoteCookie(transport);
  assert.ok(cookie, 'F16 fast path pushed a remote cookie');
  assert.equal(cookie.staging_hash, expected, 'F16 fast path staging_hash');
  assert.equal(cookie.seq, 4, 'F16 fast path seq');
});

test('F17: _touchLocalCookie never sets (and must preserve) hash/seq', async () => {
  // Preserve case: a read/check tick must not drop an existing baseline.
  {
    const { sync, storage } = makeSync();
    await seedLocalCookie(storage, 'spec-x', {
      last_seen_hash: 'b'.repeat(64),
      last_seen_seq: 7,
    });

    await sync._touchLocalCookie();

    const local = await storage.get(LOCAL_COOKIE);
    assert.equal(local.last_seen_hash, 'b'.repeat(64), 'F17 preserves last_seen_hash');
    assert.equal(local.last_seen_seq, 7, 'F17 preserves last_seen_seq');
  }

  // Absent case: a read/check tick must NOT fabricate a hash/seq baseline.
  {
    const { sync, storage } = makeSync();
    await seedLocalCookie(storage, 'spec-x'); // no last_seen_hash/seq

    await sync._touchLocalCookie();

    const local = await storage.get(LOCAL_COOKIE);
    assert.ok(!('last_seen_hash' in local), 'F17 does not set last_seen_hash when absent');
    assert.ok(!('last_seen_seq' in local), 'F17 does not set last_seen_seq when absent');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Group H-Web — specifier stability (I5)
// ──────────────────────────────────────────────────────────────────────────

test('H3: pushToRemote reuses specifier; _reconcileAndClaim regenerates it', async () => {
  // Reuse across same-device mutations.
  {
    const { sync, storage, transport } = makeSync();
    await sync.capture({ title: 'Task A', startEpoch: 1000, is_active: true });
    await seedLocalCookie(storage, 'keep-spec');

    await sync.pushToRemote(MK);
    const c1 = await remoteCookie(transport);
    await sync.pushToRemote(MK);
    const c2 = await remoteCookie(transport);

    assert.equal(c1.device_specifier, 'keep-spec', 'H3 first push reuses specifier');
    assert.equal(c2.device_specifier, 'keep-spec', 'H3 second push reuses specifier');
  }

  // Handoff regenerates the specifier AND carries hash + seq.
  {
    const { sync, storage, transport } = makeSync();
    await sync.capture({ title: 'Task A', startEpoch: 1000, is_active: true });
    await seedLocalCookie(storage, 'old-spec');
    const expected = await canonicalHash(sync);

    const result = await sync._reconcileAndClaim(MK);

    const local = await storage.get(LOCAL_COOKIE);
    assert.notEqual(local.device_specifier, 'old-spec', 'H3 handoff regenerates specifier');

    const cookie = await remoteCookie(transport);
    assert.ok(cookie, 'H3 handoff pushed a remote cookie');
    assert.equal(cookie.staging_hash, expected, 'H3 handoff staging_hash is canonical');
    assert.equal(cookie.staging_hash.length, 64, 'H3 handoff staging_hash is 64-hex');
    assert.ok(cookie.seq >= 1, 'H3 handoff seq >= 1');
    assert.ok(result, 'H3 reconcile returned a result');
  }
});
