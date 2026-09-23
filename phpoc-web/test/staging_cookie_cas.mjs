/**
 * staging_cookie_cas.mjs — ADR-034 P1 cookie schema + Worker CAS (Phase 2 RED).
 *
 * Groups:
 *   E-Web (E7–E11) — DeviceCookie cookie-schema migration (staging_hash + seq
 *     remote; last_seen_hash + last_seen_seq local) + backward-compat parse
 *     tolerance.
 *   J12 — nextSeq increment base (absent→0, then +1).
 *
 * RED phase (expected failures):
 *   E7/E8 — create() does not yet write staging_hash/seq (remote) or
 *     last_seen_hash/last_seen_seq (local), and ignores the {stagingHash, seq}
 *     options argument.
 *   E9  — isValidLocally() returns the object without last_seen_hash/last_seen_seq.
 *   J12 — DeviceCookie.nextSeq does not exist yet.
 *   E10/E11 — guard-green: parseRemote() already passes JSON through verbatim
 *     (legacy tolerated, invalid bytes → null).
 *
 * Blueprint: docs/planning/STAGING_COOKIE_CAS_PHASE1.md
 *
 * Run:
 *   node --test test/staging_cookie_cas.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceCookie } from '../src/sync/cookie.js';

// ── Fake storage + crypto ────────────────────────────────────────────────

class MemoryStorage {
  constructor() {
    this._store = new Map();
  }
  async get(key) { return this._store.get(key); }
  async set(key, value) { this._store.set(key, value); }
  async remove(key) { this._store.delete(key); }
}

const crypto = {
  generateDeviceSpecifier() { return 'test-specifier-001'; },
};

const COOKIE_KEY = 'cookie';

// ── Group E-Web — cookie schema + backward-compat parse tolerance ────────

test('E7: create() writes remote 4 fields + local 4 fields', async () => {
  const storage = new MemoryStorage();
  const remote = await DeviceCookie.create('dev-a', storage, crypto);

  assert.ok(remote);
  for (const k of ['device_uuid', 'device_specifier', 'staging_hash', 'seq']) {
    assert.ok(k in remote, `remote missing ${k}`);
  }
  assert.equal(remote.device_uuid, 'dev-a');
  assert.equal(remote.staging_hash, null);
  assert.equal(remote.seq, 0);

  const local = await storage.get(COOKIE_KEY);
  assert.ok(local);
  for (const k of ['device_specifier', 'creation_time', 'last_seen_hash', 'last_seen_seq']) {
    assert.ok(k in local, `local missing ${k}`);
  }
  assert.equal(local.last_seen_hash, null);
  assert.equal(local.last_seen_seq, 0);
});

test('E8: create() defaults stagingHash null / seq 0 and honors explicit', async () => {
  // Defaults
  const s1 = new MemoryStorage();
  const r1 = await DeviceCookie.create('dev-a', s1, crypto);
  assert.equal(r1.staging_hash, null);
  assert.equal(r1.seq, 0);

  // Explicit options
  const s2 = new MemoryStorage();
  const r2 = await DeviceCookie.create('dev-a', s2, crypto, { stagingHash: 'abc123', seq: 7 });
  assert.equal(r2.staging_hash, 'abc123');
  assert.equal(r2.seq, 7);
});

test('E9: isValidLocally() returns object including last_seen_hash + last_seen_seq', async () => {
  const storage = new MemoryStorage();
  await DeviceCookie.create('dev-a', storage, crypto);

  const local = await DeviceCookie.isValidLocally(storage);
  assert.ok(local);
  assert.ok('last_seen_hash' in local, 'isValidLocally stripped last_seen_hash');
  assert.ok('last_seen_seq' in local, 'isValidLocally stripped last_seen_seq');
});

test('E10: parseRemote() tolerates legacy cookie (absent fields, no throw)', () => {
  const legacy = new TextEncoder().encode(JSON.stringify({ device_uuid: 'dev-a', device_specifier: 'spec-1' }));
  const parsed = DeviceCookie.parseRemote(legacy);

  assert.ok(parsed);
  assert.equal(parsed.device_uuid, 'dev-a');
  assert.equal(parsed.device_specifier, 'spec-1');
  assert.ok(!('staging_hash' in parsed));
  assert.ok(!('seq' in parsed));
});

test('E11: parseRemote() full cookie verbatim; invalid bytes → null', () => {
  const full = new TextEncoder().encode(JSON.stringify({
    device_uuid: 'dev-a',
    device_specifier: 'spec-1',
    staging_hash: 'h'.repeat(64),
    seq: 5,
  }));
  const parsed = DeviceCookie.parseRemote(full);
  assert.ok(parsed);
  assert.equal(parsed.staging_hash, 'h'.repeat(64));
  assert.equal(parsed.seq, 5);

  assert.equal(DeviceCookie.parseRemote(new Uint8Array([0xff, 0xfe, 0xfd])), null);
});

// ── Group J-client — seq bump ─────────────────────────────────────────────

test('J12: nextSeq(null/undefined) → 1; nextSeq(N) → N+1', () => {
  assert.equal(DeviceCookie.nextSeq(null), 1);
  assert.equal(DeviceCookie.nextSeq(undefined), 1);
  assert.equal(DeviceCookie.nextSeq(0), 1);
  assert.equal(DeviceCookie.nextSeq(5), 6);
});
