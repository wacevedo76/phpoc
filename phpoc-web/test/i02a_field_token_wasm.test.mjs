/**
 * I-02a Phase 2 (RED): WASM bindings for hmac_hex + derive_field_key.
 *
 * Verifies that:
 *   1. hmac_hex WASM binding exists and is correct.
 *   2. derive_field_key WASM binding exists and is correct.
 *   3. _fieldToken() uses MK-derived HMAC (tokens change per user).
 *
 * These tests are RED — the WASM bindings do not exist yet,
 * and _fieldToken() currently uses SHA-256(constant + fieldName).
 *
 * Usage:
 *   cd phpoc-web && node --test test/i02a_field_token_wasm.test.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, '../../phpoc-crypto-core/pkg');

// ── Helpers ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; process.stdout.write('  ✓'); }
  else { failed++; process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 120)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 120)}`);
  }
  console.log(`  ${label}`);
}

function assertNeq(actual, expected, label) {
  const ok = actual !== expected;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; process.stdout.write('  ✗');
    console.log(`\n      got: ${JSON.stringify(actual).slice(0, 120)} should differ from expected`);
  }
  console.log(`  ${label}`);
}

function assertDeepEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 200)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 200)}`);
  }
  console.log(`  ${label}`);
}

// ── Load WASM Module ───────────────────────────────────────────────
const wasmBytes = readFileSync(resolve(PKG_DIR, 'phpoc_crypto_core_bg.wasm'));
const wasmModule = await import(resolve(PKG_DIR, 'phpoc_crypto_core.js'));
const { initSync, ...namedExports } = wasmModule;
initSync({ module: wasmBytes });

// Destructure all exports — new ones will be undefined (RED)
const {
  sha256,
  derive_master_key,
  hmac_hex,           // NEW — not yet exported
  derive_field_key,   // NEW — not yet exported
} = namedExports;

// ── Test vectors ────────────────────────────────────────────────────
// Master keys as 64-char hex (32 bytes)
const MK1 = 'ab'.repeat(32);    // all 0xAB
const MK2 = 'cd'.repeat(32);    // all 0xCD

// Helper: compute Python-equivalent field token for cross-client compat
function pyFieldToken(mkHex, fieldName) {
  const fieldKeyHex = createHmac('sha256', Buffer.from(mkHex, 'hex'))
    .update('phpoc-staging-keys-v1')
    .digest('hex')
    .slice(0, 32);
  return createHmac('sha256', Buffer.from(fieldKeyHex, 'hex'))
    .update(fieldName)
    .digest('hex')
    .slice(0, 16);
}

// ════════════════════════════════════════════════════════════════════
// Group W1: hmac_hex WASM binding
// ════════════════════════════════════════════════════════════════════
console.log('\n=== Group W1: hmac_hex WASM binding ===\n');

// W1a: hmac_hex is exported
assert(typeof hmac_hex === 'function',
  'W1a. hmac_hex is exported (binding exists)');

// W1b: deterministic — same key + data → same output
if (typeof hmac_hex === 'function') {
  const h1 = hmac_hex('aa'.repeat(32), 'test data');
  const h2 = hmac_hex('aa'.repeat(32), 'test data');
  assertEq(h1, h2, 'W1b. hmac_hex deterministic (same key+data → same hex)');
}

// W1c: different key → different output
if (typeof hmac_hex === 'function') {
  const h1 = hmac_hex('aa'.repeat(32), 'test data');
  const h2 = hmac_hex('bb'.repeat(32), 'test data');
  assertNeq(h1, h2, 'W1c. different key → different output');
}

// W1d: different data → different output
if (typeof hmac_hex === 'function') {
  const h1 = hmac_hex('aa'.repeat(32), 'data A');
  const h2 = hmac_hex('aa'.repeat(32), 'data B');
  assertNeq(h1, h2, 'W1d. different data → different output');
}

// W1e: output length is 64 hex chars (SHA-256)
if (typeof hmac_hex === 'function') {
  const h = hmac_hex('aa'.repeat(32), 'test');
  assertEq(h.length, 64, 'W1e. hmac_hex output is 64 hex chars (SHA-256)');
}

// ════════════════════════════════════════════════════════════════════
// Group W2: derive_field_key WASM binding
// ════════════════════════════════════════════════════════════════════
console.log('\n=== Group W2: derive_field_key WASM binding ===\n');

// W2a: derive_field_key is exported
assert(typeof derive_field_key === 'function',
  'W2a. derive_field_key is exported (binding exists)');

// W2b: deterministic
if (typeof derive_field_key === 'function') {
  const fk1 = derive_field_key(MK1);
  const fk2 = derive_field_key(MK1);
  assertEq(fk1, fk2, 'W2b. derive_field_key deterministic');
}

// W2c: output is 32 hex chars (16 bytes for AES-128 key material)
if (typeof derive_field_key === 'function') {
  const fk = derive_field_key(MK1);
  assertEq(fk.length, 32,
    `W2c. derive_field_key returns 32 hex chars (got ${fk.length})`);
}

// W2d: different MK → different field key
if (typeof derive_field_key === 'function') {
  const fk1 = derive_field_key(MK1);
  const fk2 = derive_field_key(MK2);
  assertNeq(fk1, fk2, 'W2d. different MK → different field key');
}

// W2e: domain separation — field key uses "phpoc-staging-keys-v1"
if (typeof derive_field_key === 'function') {
  const mkBytes = Buffer.from(MK1, 'hex');
  const hmac = createHmac('sha256', mkBytes);
  hmac.update('phpoc-staging-keys-v1');
  const expectedFk = hmac.digest('hex').slice(0, 32);

  const fk = derive_field_key(MK1);
  assertEq(fk, expectedFk,
    'W2e. derive_field_key uses domain separator "phpoc-staging-keys-v1"');
}

// W2f: field key ≠ index key (different domain separators)
if (typeof derive_field_key === 'function') {
  const mkBytes = Buffer.from(MK1, 'hex');
  const indexHmac = createHmac('sha256', mkBytes);
  indexHmac.update('phpoc-blind-index-v1');
  const expectedIndexKey = indexHmac.digest('hex').slice(0, 32);

  const fk = derive_field_key(MK1);
  assertNeq(fk, expectedIndexKey,
    'W2f. field key ≠ index key (different domain separators)');
}

// ════════════════════════════════════════════════════════════════════
// Group F1: _fieldToken() MK-dependence (WASM-level)
// ════════════════════════════════════════════════════════════════════
console.log('\n=== Group F1: field-token MK-dependence (WASM-level) ===\n');

if (typeof hmac_hex === 'function' && typeof derive_field_key === 'function') {
  const fieldKey1 = derive_field_key(MK1);
  const fieldKey2 = derive_field_key(MK2);

  // F1a: different MKs → different tokens for same field (CORE security fix)
  const token1 = hmac_hex(fieldKey1, 'startTime_enc').slice(0, 16);
  const token2 = hmac_hex(fieldKey2, 'startTime_enc').slice(0, 16);
  assertNeq(token1, token2,
    'F1a. different MKs → different _fieldToken() output');

  // F1b: same MK + same field → deterministic token
  const token1b = hmac_hex(fieldKey1, 'startTime_enc').slice(0, 16);
  assertEq(token1, token1b,
    'F1b. same MK + same field → deterministic token');

  // F1c: different fields → different tokens (same MK)
  const tokenEnd = hmac_hex(fieldKey1, 'endTime_enc').slice(0, 16);
  assertNeq(token1, tokenEnd,
    'F1c. different fields → different tokens (same MK)');

  // F1d: all 6 encryptable fields produce unique tokens
  const encryptableFields = [
    'startTime_enc', 'endTime_enc', 'pauses_enc',
    'metadata_enc', 'device_uuid_enc', 'end_device_uuid_enc',
  ];
  const tokens = new Set();
  for (const f of encryptableFields) {
    tokens.add(hmac_hex(fieldKey1, f).slice(0, 16));
  }
  assertEq(tokens.size, encryptableFields.length,
    `F1d. all ${encryptableFields.length} encryptable fields → unique tokens`);

  // F1e: cross-client compatibility — matches Python
  const pyToken = pyFieldToken(MK1, 'startTime_enc');
  assertEq(token1, pyToken,
    'F1e. WASM field token matches Python (cross-client compat)');
}

// ════════════════════════════════════════════════════════════════════
// Group F2: _fieldToken() through LocalCache (end-to-end)
// ════════════════════════════════════════════════════════════════════
console.log('\n=== Group F2: _fieldToken() through LocalCache ===\n');

/** @type {typeof import('../src/sync/local_cache.js').LocalCache|null} */
let LocalCache = null;
/** @type {typeof import('../src/crypto/index.js').CryptoService|null} */
let CryptoService = null;

try {
  const lcMod = await import('../src/sync/local_cache.js');
  LocalCache = lcMod.LocalCache;
} catch { /* not available yet */ }

try {
  const csMod = await import('../src/crypto/index.js');
  CryptoService = csMod.CryptoService;
} catch { /* not available yet */ }

const SKIP_INTEGRATION = !LocalCache || !CryptoService;

if (SKIP_INTEGRATION) {
  console.log('  (skipped) LocalCache or CryptoService not available — expected in Phase 3');
}

if (!SKIP_INTEGRATION && typeof hmac_hex === 'function' && typeof derive_field_key === 'function') {
  const { MemoryBackend } = await import('../src/sync/storage.js');

  // F2a: MK1 keys ≠ MK2 keys for same DTO structure
  {
    CryptoService.reset();
    const crypto1 = await CryptoService.create({ wasmModule: wasmBytes });
    crypto1.setMasterKey(MK1);
    const storage1 = new MemoryBackend();
    const cache1 = new LocalCache(storage1, crypto1);

    await cache1.writeEntries([{
      activity_id: 'f2a', entry_id: 'f2a-e1', title: 'MK1 Entry',
      start_epoch: 1000, end_epoch: 2000, duration: 1000,
      is_active: false, is_paused: false, pauses: [],
      tags: [], comment: null, media: [],
      device_uuid: 'dev-f2a', end_device_uuid: '',
      metadata: {}, hash: 'h-f2a', entry_index: 0,
      committed: false, block_index: null,
    }]);
    const raw1 = await storage1.get('entries');
    const keys1 = Object.keys(raw1[0].data || {}).filter(k =>
      !['activity_id', 'entry_id', 'title', 'duration', 'is_active',
        'is_paused', 'tags', 'media', 'hash', 'entry_index',
        'committed', 'block_index'].includes(k)
    ).sort();

    CryptoService.reset();
    const crypto2 = await CryptoService.create({ wasmModule: wasmBytes });
    crypto2.setMasterKey(MK2);
    const storage2 = new MemoryBackend();
    const cache2 = new LocalCache(storage2, crypto2);

    await cache2.writeEntries([{
      activity_id: 'f2a', entry_id: 'f2a-e2', title: 'MK2 Entry',
      start_epoch: 1000, end_epoch: 2000, duration: 1000,
      is_active: false, is_paused: false, pauses: [],
      tags: [], comment: null, media: [],
      device_uuid: 'dev-f2a', end_device_uuid: '',
      metadata: {}, hash: 'h-f2a', entry_index: 0,
      committed: false, block_index: null,
    }]);
    const raw2 = await storage2.get('entries');
    const keys2 = Object.keys(raw2[0].data || {}).filter(k =>
      !['activity_id', 'entry_id', 'title', 'duration', 'is_active',
        'is_paused', 'tags', 'media', 'hash', 'entry_index',
        'committed', 'block_index'].includes(k)
    ).sort();

    assertEq(keys1.length, keys2.length,
      `F2a. same number of encrypted keys (${keys1.length})`);
    const allDifferent = keys1.every((k, i) => k !== keys2[i]);
    assert(allDifferent,
      `F2a-b. MK1 keys differ from MK2 keys\n      MK1: ${keys1.join(', ')}\n      MK2: ${keys2.join(', ')}`);

    CryptoService.reset();
  }

  // F2b: Roundtrip — write + read with same MK
  {
    CryptoService.reset();
    const crypto = await CryptoService.create({ wasmModule: wasmBytes });
    crypto.setMasterKey(MK1);
    const storage = new MemoryBackend();
    const cache = new LocalCache(storage, crypto);

    await cache.writeEntries([{
      activity_id: 'f2b', entry_id: 'f2b-e1', title: 'Roundtrip MK',
      start_epoch: 5000, end_epoch: 10000, duration: 5000,
      is_active: false, is_paused: false,
      pauses: [{ pause_index: 0, pause_start: 6000, pause_stop: 7000 }],
      tags: ['work'], comment: 'roundtrip', media: [],
      device_uuid: 'dev-f2b', end_device_uuid: 'dev-end-f2b',
      metadata: { key: 'value' },
      hash: 'h-f2b', entry_index: 0, committed: false, block_index: null,
    }]);

    const dtos = await cache.readEntries();
    assertEq(dtos.length, 1, 'F2b. single entry roundtrip');
    assertEq(dtos[0].title, 'Roundtrip MK', 'F2b-a. title');
    assertEq(dtos[0].start_epoch, 5000, 'F2b-b. start_epoch');
    assertEq(dtos[0].device_uuid, 'dev-f2b', 'F2b-c. device_uuid');
    assertEq(dtos[0].end_device_uuid, 'dev-end-f2b', 'F2b-d. end_device_uuid');
    assertEq(dtos[0].pauses[0].pause_start, 6000, 'F2b-e. pause_start');
    assertDeepEq(dtos[0].metadata, { key: 'value' }, 'F2b-f. metadata');

    CryptoService.reset();
  }

  // F2c: No MK → fallback to plaintext field names
  {
    CryptoService.reset();
    const crypto = await CryptoService.create({ wasmModule: wasmBytes });
    // Do NOT set master key
    const storage = new MemoryBackend();
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'NoAuth', startEpoch: 1000, endEpoch: 2000,
      deviceUuid: 'dev-noauth-f2c',
    });

    const dtos = await cache.readEntries();
    assertEq(dtos.length, 1, 'F2c-a. no-auth entry readable');
    assertEq(dtos[0].title, 'NoAuth', 'F2c-b. no-auth title');

    const raw = await storage.get('entries');
    const data = raw[0].data || {};
    const hasPlaintextKeys = Object.keys(data).some(k => k.endsWith('_enc'));
    assert(hasPlaintextKeys,
      `F2c-c. no-MK fallback uses plaintext _enc keys (keys: ${Object.keys(data).join(', ')})`);

    CryptoService.reset();
  }
}

// ── Summary ─────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\nI-02a Field Token WASM: ${passed}/${total} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
