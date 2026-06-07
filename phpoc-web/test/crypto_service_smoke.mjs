/**
 * crypto_service_smoke.mjs — Quick smoke test for CryptoService wrapper.
 *
 * Verifies the service loads, initializes WASM, and runs a few key
 * operations. Not a comprehensive test (wasm_integration.mjs covers that).
 *
 * Usage:
 *   node test/crypto_service_smoke.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { CryptoService } from '../src/crypto/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmBytes = readFileSync(
  resolve(__dirname, '../../phpoc-crypto-core/pkg/phpoc_crypto_core_bg.wasm'),
);

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; process.stdout.write('  ✓'); }
  else { failed++; process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

// ── 1. Create service ───────────────────────────────────────────────
console.log('── CryptoService lifecycle ──');
const crypto = await CryptoService.create({ wasmModule: wasmBytes });
assert(crypto.isReady(), 'CryptoService.create() → isReady() === true');

// Singleton check
const crypto2 = await CryptoService.create();
assert(crypto === crypto2, 'CryptoService.create() returns singleton');

// ── 2. Key management ────────────────────────────────────────────────
console.log('\n── Key management ──');
assert(!crypto.hasMasterKey(), 'hasMasterKey() → false initially');
crypto.setMasterKey('ab'.repeat(32));
assert(crypto.hasMasterKey(), 'hasMasterKey() → true after setMasterKey()');
assert(crypto.getMasterKey() === 'ab'.repeat(32), 'getMasterKey() returns set value');

crypto.clearMasterKey();
assert(!crypto.hasMasterKey(), 'hasMasterKey() → false after clearMasterKey()');

// ── 3. Auth flow ─────────────────────────────────────────────────────
console.log('\n── Auth flow ──');
const seed = crypto.generateSeed();
assert(typeof seed === 'string' && seed.length === 44, `generateSeed() → ${seed.length}-char base64`);

const mk = crypto.deriveMasterKey(seed);
assert(typeof mk === 'string' && mk.length === 64, 'deriveMasterKey() → 64-char hex');

const mkAgain = crypto.deriveMasterKey(seed);
assert(mk === mkAgain, 'deriveMasterKey() deterministic');

// Cache the key for cached-key convenience methods
crypto.setMasterKey(mk);

// ── 4. Encrypt/decrypt with cached key ───────────────────────────────
console.log('\n── Encrypt/decrypt ──');
const pt = 'Hello from CryptoService!';
const ct = crypto.encryptWithCachedKey(pt);
assert(typeof ct === 'string' && ct.length > 0, 'encryptWithCachedKey() → ciphertext');

const decrypted = crypto.decryptWithCachedKey(ct);
assert(decrypted === pt, 'decryptWithCachedKey() → original plaintext');

// ── 5. Blob obfuscation with cached key ──────────────────────────────
console.log('\n── Blob obfuscation ──');
const blob = JSON.stringify({ device_id: 'test', entries: [] });
const obf = crypto.obfuscateBlobWithCachedKey(blob);
assert(typeof obf === 'string' && obf.length > 0, 'obfuscateBlobWithCachedKey() → base64');

const deobf = crypto.deobfuscateBlobWithCachedKey(obf);
assert(deobf === blob, 'deobfuscateBlobWithCachedKey() → original blob');

// ── 6. Device identity with cached key ───────────────────────────────
console.log('\n── Device identity ──');
const deviceId = crypto.getDeviceIdWithCachedKey();
assert(typeof deviceId === 'string' && deviceId.length === 64, 'getDeviceIdWithCachedKey() → 64-char hex');

const proof = crypto.deviceProof(mk, deviceId);
const verified = crypto.verifyDeviceProof(deviceId, proof, mk);
assert(verified, 'device proof → verifyDeviceProof() → true');

// ── 7. Random generation ─────────────────────────────────────────────
console.log('\n── Random generation ──');
const uuid = crypto.generateUuid();
assert(uuid.length === 36 && uuid[14] === '4', `generateUuid() → valid UUID v4: ${uuid}`);

const spec1 = crypto.generateDeviceSpecifier();
const spec2 = crypto.generateDeviceSpecifier();
assert(spec1.length === 32, 'generateDeviceSpecifier() → 32-char hex');
assert(spec1 !== spec2, 'generateDeviceSpecifier() → non-deterministic');

// ── 8. Sealing ───────────────────────────────────────────────────────
console.log('\n── Sealing ──');
const sealed = crypto.seal('{"type":"genesis"}', mk);
assert(sealed.length === 64, 'seal() → 64-char hex');

assert(crypto.verifySeal('{"type":"genesis"}', sealed, mk), 'verifySeal() → true');
assert(!crypto.verifySeal('{"type":"tampered"}', sealed, mk), 'verifySeal(tampered) → false');

// ── 9. Not-ready guard ───────────────────────────────────────────────
console.log('\n── Guard ──');
CryptoService.reset();
const uninit = new CryptoService();
try {
  uninit.sha256('test');
  failed++;
  console.log('  ✗  uninitialized service should throw');
} catch {
  passed++;
  console.log('  ✓  uninitialized service throws on call');
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n── Results ──────────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
