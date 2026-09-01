/**
 * commonplace_ad_hoc_test.mjs — Commonplace ad-hoc key/value test suite (Phase 2 RED).
 *
 * Group F (5 assertions) from docs/planning/COMMONPLACE_BOOK_WEB_PHASE1.md.
 * Mirrors the Flutter commonplace_ad_hoc_test.dart contract, adapted to the
 * web StorageBackend harness.
 *
 * Run: node test/commonplace_ad_hoc_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { MockCrypto } from './mock_crypto.mjs';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort } from '../src/ledger/utils.js';
import { CommonplaceEngine } from '../src/commonplace/commonplace_engine.js';

const t = new TestHelpers();

const MASTER_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const IDENTITY_SECRET = 'identity-secret-32-bytes-xxxxxx';

// ── Helpers ────────────────────────────────────────────────────────

function makeCrypto() {
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  return crypto;
}

function makeEngine() {
  return new CommonplaceEngine(makeCrypto(), new MemoryBackend(), MASTER_KEY, IDENTITY_SECRET);
}

async function seedGenesis(engine) {
  await engine.buildGenesis({
    username: 'testuser',
    email: 'test@example.com',
    recoverySeedEnc: 'encrypted-seed',
    identityPubKey: 'pub-key-hex',
    identitySecretEncFallback: 'fallback-hex',
  });
}

function entry(title, { adHoc, timestampMs = 1700000000000 } = {}) {
  const e = { title, tags: ['topic'], entry: 'passage', timestamp_ms: timestampMs };
  if (adHoc) e.ad_hoc = adHoc;
  return e;
}

async function sealedData(engine) {
  const days = await engine.getDayBlocks();
  return days[days.length - 1].entries[0].data;
}

function computeContentHash(data, crypto) {
  const content = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'content_hash') continue;
    if (key.endsWith('_enc') && value !== null && value !== undefined && value !== '') {
      content[key] = crypto.decrypt(value, MASTER_KEY);
    } else if (Array.isArray(value)) {
      content[key] = value.slice().sort((a, b) => String(a).localeCompare(String(b)));
    } else {
      content[key] = value;
    }
  }
  return crypto.sha256(jsonSort(content));
}

async function test(name, fn) {
  try { await fn(); }
  catch (e) { t.assert(false, `${name} — ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════
// Group F: Commonplace ad-hoc Key/Value (5)
// ═══════════════════════════════════════════════════════════════════

await test('CP-F1: ad_hoc accepts multiple arbitrary k/v pairs', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([entry('Rich entry', {
    adHoc: { source: 'book', page: '42', favorite: 'yes', quote: 'x' },
  })]);

  const data = await sealedData(engine);
  t.assert('ad_hoc_enc' in data, 'F1: ad_hoc_enc present');
  const decoded = JSON.parse(makeCrypto().decrypt(data.ad_hoc_enc, MASTER_KEY));
  t.assertEq(decoded.source, 'book', 'F1: source');
  t.assertEq(decoded.page, '42', 'F1: page');
  t.assertEq(decoded.favorite, 'yes', 'F1: favorite');
  t.assertEq(decoded.quote, 'x', 'F1: quote');
});

await test('CP-F2: ad_hoc values are encrypted at rest (no plaintext)', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  const secret = 'secretsauce-value';
  await engine.commit([entry('Secret meta', { adHoc: { keyA: secret } })]);

  const data = await sealedData(engine);
  // MockCrypto embeds plaintext inside ciphertext, so assert the plaintext
  // *field* is replaced by an encrypted *_enc field rather than asserting
  // the serialized string omits the secret.
  t.assert('ad_hoc_enc' in data, 'F2: ad_hoc_enc present');
  t.assert(!('ad_hoc' in data), 'F2: no plaintext ad_hoc field');
  t.assert(typeof data.ad_hoc_enc === 'string' && data.ad_hoc_enc.includes('enc:'), 'F2: ad_hoc_enc encrypted');
  t.assert(data.ad_hoc_enc !== JSON.stringify({ keyA: secret }), 'F2: ad_hoc_enc not plaintext JSON');
});

await test('CP-F3: ad_hoc pairs survive the commit → read round-trip', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([entry('Meta entry', { adHoc: { pinned: 'true', source: 'citp' } })]);

  const entries = await engine.readEntries();
  t.assertEq(entries.length, 1, 'F3: one entry');
  const adHoc = entries[0].ad_hoc;
  t.assert(adHoc !== null && adHoc !== undefined, 'F3: ad_hoc surfaced');
  t.assertEq(adHoc.pinned, 'true', 'F3: pinned');
  t.assertEq(adHoc.source, 'citp', 'F3: source');
});

await test('CP-F4: an entry without ad_hoc is valid and readable', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([entry('Bare entry')]);
  t.assert(await engine.verify(), 'F4: verifies');

  const data = await sealedData(engine);
  t.assert(!('ad_hoc_enc' in data), 'F4: no ad_hoc_enc');
});

await test('CP-F5: ad_hoc keeps a stable content hash across re-encryption', async () => {
  const engine = makeEngine();
  await seedGenesis(engine);
  await engine.commit([entry('Rotation safe', { adHoc: { k: 'v' } })]);
  const data = await sealedData(engine);
  const contentHash = data.content_hash;

  const crypto = makeCrypto();
  const plainAdHoc = crypto.decrypt(data.ad_hoc_enc, MASTER_KEY);
  const reEncrypted = crypto.encrypt(plainAdHoc, MASTER_KEY);
  const reEncoded = { ...data, ad_hoc_enc: reEncrypted };

  t.assertEq(computeContentHash(reEncoded, crypto), contentHash, 'F5: stable content hash');
});

// ── Summary ─────────────────────────────────────────────────────────
t.summary('CommonplaceAdHoc');
process.exit(t.failed > 0 ? 1 : 0);
