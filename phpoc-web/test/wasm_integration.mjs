/**
 * wasm_integration.mjs — Integration test for phpoc-crypto-core WASM module.
 *
 * Loads the compiled WASM binary through the generated JS glue, then
 * exercises all 20 exported functions against known test vectors and
 * round-trip scenarios.
 *
 * Usage:
 *   node test/wasm_integration.mjs
 *
 * Expected output:
 *   ✓ All 20 functions exercised, N tests passed, 0 failed
 *
 * Run from the phpoc-web/ directory or provide --cwd to point at it.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── Paths ──────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, '../../phpoc-crypto-core/pkg');
const VECTORS_PATH = resolve(__dirname, '../../phpoc-crypto-core/tests/crypto_test_vectors.json');

// ── Stats ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    process.stdout.write('  ✓');
  } else {
    failed++;
    process.stdout.write('  ✗');
  }
  console.log(`  ${label}`);
}

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    process.stdout.write('  ✓');
  } else {
    failed++;
    process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 120)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 120)}`);
  }
  console.log(`  ${label}`);
}

function assertThrows(fn, label) {
  try {
    fn();
    failed++;
    process.stdout.write('  ✗  (expected throw, got success)');
  } catch {
    passed++;
    process.stdout.write('  ✓');
  }
  console.log(`  ${label}`);
}

// ── Load WASM Module ───────────────────────────────────────────────
const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf-8'));

// Dynamically import the wasm-bindgen glue — must init before use
const wasmModule = await import(resolve(PKG_DIR, 'phpoc_crypto_core.js'));
const { initSync, ...namedExports } = wasmModule;

// In Node.js, load the WASM binary directly (no fetch needed)
const wasmBytes = readFileSync(resolve(PKG_DIR, 'phpoc_crypto_core_bg.wasm'));
initSync({ module: wasmBytes });

// All named exports are now live
const {
  authenticate,
  decrypt,
  deobfuscate_blob,
  derive_blob_key,
  derive_master_key,
  derive_pdk,
  derive_seal_key,
  device_proof,
  encrypt,
  generate_device_specifier,
  generate_seed,
  generate_uuid_v4,
  get_device_id,
  obfuscate_blob,
  seal,
  sha256,
  sign,
  verify_device_proof,
  verify_seal,
  verify_signature,
} = namedExports;

// ──────────────────────────────────────────────────────────────────────
//  1. PBKDF2 (derive_pdk) — deterministic test vectors
// ──────────────────────────────────────────────────────────────────────
console.log('\n── PBKDF2 (derive_pdk) ──');
for (const { passphrase, iterations, expected_hex } of vectors.pbkdf2) {
  const label = `derive_pdk("${passphrase.slice(0, 30)}...", ${iterations})`;
  const result = derive_pdk(passphrase, iterations);
  assertEq(result, expected_hex, label);
}

// ──────────────────────────────────────────────────────────────────────
//  2. SHA-256 — deterministic test vectors
// ──────────────────────────────────────────────────────────────────────
console.log('\n── SHA-256 (sha256) ──');
for (const { data_hex, expected_hex } of vectors.sha256) {
  const data = Buffer.from(data_hex, 'hex').toString('utf-8');
  const label = `sha256("${data.slice(0, 30)}")`;
  const result = sha256(data);
  assertEq(result, expected_hex, label);
}

// ──────────────────────────────────────────────────────────────────────
//  3. HMAC-SHA256 — sign uses raw HMAC (matches test vectors),
//     seal derives a sub-key first (test as round-trip + determinism)
// ──────────────────────────────────────────────────────────────────────
console.log('\n── HMAC-SHA256 (sign / verify_signature) ──');
for (const { key_hex, data_hex, expected_hex } of vectors.hmac_sha256) {
  const data = Buffer.from(data_hex, 'hex').toString('utf-8');
  const label = `sign("${data.slice(0, 20)}", ${key_hex.slice(0, 16)}...)`;
  const result = sign(data, key_hex);
  assertEq(result, expected_hex, label);

  const verifyLabel = `verify_signature("${data.slice(0, 20)}", ok, ${key_hex.slice(0, 16)}...)`;
  assert(verify_signature(data, expected_hex, key_hex), verifyLabel);

  const wrongKey = 'ff'.repeat(32);
  const failLabel = `verify_signature("${data.slice(0, 20)}", ok, wrong_key) → false`;
  assert(!verify_signature(data, expected_hex, wrongKey), failLabel);
}

console.log('\n── HMAC-SHA256 (seal / verify_seal — sub-key derived) ──');
// seal() uses HMAC-SHA256(MK, "integrity-key-salt") as the HMAC key
// so it won't match raw HMAC test vectors — test round-trip and determinism
const sealMk = 'ab'.repeat(32);
const sealData = '{"type":"day","date":"2026-06-01"}';
const seal1 = seal(sealData, sealMk);
const seal2 = seal(sealData, sealMk);
assert(typeof seal1 === 'string' && seal1.length === 64, 'seal() → 64-char hex');
assertEq(seal1, seal2, 'seal() is deterministic (same data + same key)');

const diffData = '{"type":"day","date":"2026-06-02"}';
const sealDiff = seal(diffData, sealMk);
assert(seal1 !== sealDiff, 'seal() differs for different data');

const diffMk = 'ff'.repeat(32);
const sealDiffKey = seal(sealData, diffMk);
assert(seal1 !== sealDiffKey, 'seal() differs for different key');

// Verify seal round-trip
assert(verify_seal(sealData, seal1, sealMk), 'verify_seal() with correct seal → true');
assert(!verify_seal('tampered', seal1, sealMk), 'verify_seal() with tampered data → false');
assert(!verify_seal(sealData, seal1, diffMk), 'verify_seal() with wrong key → false');

// ──────────────────────────────────────────────────────────────────────
//  4. AES-128-CTR round-trip (encrypt / decrypt) — non-deterministic
// ──────────────────────────────────────────────────────────────────────
console.log('\n── AES-128-CTR (encrypt / decrypt) ──');
for (const { master_key_hex, plaintext } of vectors.aes_ctr) {
  const label = `encrypt/decrypt round-trip: "${plaintext.slice(0, 30)}"`;
  const ciphertext = encrypt(plaintext, master_key_hex);
  assert(typeof ciphertext === 'string' && ciphertext.length > 0, `${label} → got ciphertext`);

  const decrypted = decrypt(ciphertext, master_key_hex);
  assertEq(decrypted, plaintext, `decrypt() → "${plaintext.slice(0, 30)}"`);
}

// Error case: wrong key
console.log('\n── AES-128-CTR error cases ──');
const goodCiphertext = encrypt('secret message', 'ab'.repeat(32));
const wrongMasterKey = 'ff'.repeat(32);
assertThrows(
  () => decrypt(goodCiphertext, wrongMasterKey),
  'decrypt with wrong master key throws',
);
assertThrows(
  () => decrypt('invalidhex', 'ab'.repeat(32)),
  'decrypt with invalid ciphertext hex throws',
);

// ──────────────────────────────────────────────────────────────────────
//  5. Sign / Verify Signature — HMAC-SHA256 for identity
// ──────────────────────────────────────────────────────────────────────
console.log('\n── Sign / Verify Signature ──');
const identitySecret = 'aa'.repeat(32);
const sigData = 'block-hash-abc123';
const signature = sign(sigData, identitySecret);
assert(typeof signature === 'string' && signature.length === 64, `sign() → 64-char hex`);

assert(
  verify_signature(sigData, signature, identitySecret),
  'verify_signature with correct key → true',
);

assert(
  !verify_signature(sigData, signature, 'bb'.repeat(32)),
  'verify_signature with wrong key → false',
);

assert(
  !verify_signature('wrong-data', signature, identitySecret),
  'verify_signature with wrong data → false',
);

// ──────────────────────────────────────────────────────────────────────
//  6. Device Identity (get_device_id, device_proof, verify_device_proof)
// ──────────────────────────────────────────────────────────────────────
console.log('\n── Device Identity ──');
const deviceMkHex = 'ab'.repeat(32);
const deviceId = get_device_id(deviceMkHex);
assert(typeof deviceId === 'string' && deviceId.length === 64, `get_device_id() → 64-char hex: ${deviceId.slice(0, 16)}...`);

const proof = device_proof(deviceMkHex, deviceId);
assert(typeof proof === 'string' && proof.length === 64, `device_proof() → 64-char hex`);

assert(
  verify_device_proof(deviceId, proof, deviceMkHex),
  'verify_device_proof with correct proof → true',
);

assert(
  !verify_device_proof(deviceId, proof, 'ff'.repeat(32)),
  'verify_device_proof with wrong master key → false',
);

assert(
  !verify_device_proof('wrong-device-id', proof, deviceMkHex),
  'verify_device_proof with wrong device_id → false',
);

// ──────────────────────────────────────────────────────────────────────
//  7. Key Derivation (derive_master_key, derive_blob_key, derive_seal_key)
// ──────────────────────────────────────────────────────────────────────
console.log('\n── Key Derivation ──');
const testSeed = generate_seed(); // fresh random seed
const mkFromSeed = derive_master_key(testSeed);
assert(
  typeof mkFromSeed === 'string' && mkFromSeed.length === 64,
  `derive_master_key(generate_seed()) → 64-char hex`,
);

// Determinism: same seed → same master key
const mkAgain = derive_master_key(testSeed);
assertEq(mkAgain, mkFromSeed, 'derive_master_key deterministic: same seed → same key');

// Blob key derivation
const blobKey = derive_blob_key('ab'.repeat(32));
assert(typeof blobKey === 'string' && blobKey.length === 32, `derive_blob_key() → 32-char hex (16 bytes)`);

// Seal key derivation
const sealKey = derive_seal_key('ab'.repeat(32));
assert(typeof sealKey === 'string' && sealKey.length === 64, `derive_seal_key() → 64-char hex (32 bytes)`);

// Derivation determinism
assertEq(
  derive_blob_key('ab'.repeat(32)),
  blobKey,
  'derive_blob_key deterministic: same key → same blob key',
);
assertEq(
  derive_seal_key('ab'.repeat(32)),
  sealKey,
  'derive_seal_key deterministic: same key → same seal key',
);

// ──────────────────────────────────────────────────────────────────────
//  8. Blob Obfuscation round-trip (non-deterministic)
// ──────────────────────────────────────────────────────────────────────
console.log('\n── Blob Obfuscation ──');
for (const { master_key_hex, plaintext } of vectors.blob_obfuscation) {
  const label = `obfuscate/deobfuscate round-trip: "${plaintext.slice(0, 40)}"`;
  const obfuscated = obfuscate_blob(plaintext, master_key_hex);
  assert(
    typeof obfuscated === 'string' && obfuscated.length > 0,
    `${label} → got base64`,
  );

  const deobfuscated = deobfuscate_blob(obfuscated, master_key_hex);
  assertEq(deobfuscated, plaintext, `deobfuscate → original`);
}

// Error case: wrong key
console.log('\n── Blob Obfuscation error cases ──');
const goodObfuscated = obfuscate_blob('{"hello":"world"}', 'ab'.repeat(32));
assertThrows(
  () => deobfuscate_blob(goodObfuscated, 'ff'.repeat(32)),
  'deobfuscate_blob with wrong master key throws',
);

assertThrows(
  () => deobfuscate_blob('!!!invalid-base64!!!', 'ab'.repeat(32)),
  'deobfuscate_blob with invalid base64 throws',
);

// ──────────────────────────────────────────────────────────────────────
//  9. Random Generation
// ──────────────────────────────────────────────────────────────────────
console.log('\n── Random Generation ──');

const seed = generate_seed();
assert(
  typeof seed === 'string' && seed.length > 0,
  `generate_seed() → base64: ${seed.slice(0, 20)}...`,
);
// Base64 is 44 chars for 32 bytes
assert(seed.length === 44, `generate_seed() → 44-char base64 (got ${seed.length})`);

const uuid = generate_uuid_v4();
assert(typeof uuid === 'string' && uuid.length === 36, `generate_uuid_v4() → UUID: ${uuid}`);
// UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
assert(uuid[14] === '4', `UUID v4 version nibble is '4': ${uuid}`);
const variantNibble = parseInt(uuid[19], 16);
assert(
  (variantNibble & 0b1100) === 0b1000,
  `UUID v4 variant bits are 10xx: ${uuid}`,
);

const specifier1 = generate_device_specifier();
const specifier2 = generate_device_specifier();
assert(
  typeof specifier1 === 'string' && specifier1.length === 32,
  `generate_device_specifier() → 32-char hex: ${specifier1.slice(0, 8)}...`,
);
assert(
  specifier1 !== specifier2,
  'generate_device_specifier() → non-deterministic (two calls differ)',
);

// ──────────────────────────────────────────────────────────────────────
// 10. Authenticate convenience function
// ──────────────────────────────────────────────────────────────────────
console.log('\n── Authenticate convenience ──');
const authSeed = generate_seed();
const authMk = authenticate('my-passphrase', authSeed, 600000);
assert(typeof authMk === 'string' && authMk.length === 64, `authenticate() → 64-char hex`);

// authenticate should produce the same master key as derive_master_key
const directMk = derive_master_key(authSeed);
assertEq(authMk, directMk, 'authenticate() matches derive_master_key()');

// ──────────────────────────────────────────────────────────────────────
// 11. Full auth → encrypt → decrypt → blob pipeline (real-world scenario)
// ──────────────────────────────────────────────────────────────────────
console.log('\n── Full Authentication Pipeline ──');

const pipelineSeed = generate_seed();
const pipelineMk = derive_master_key(pipelineSeed);

// Encrypt a staging entry
const entry = JSON.stringify({ title: 'Coding', start_epoch: 1717000000000, tags: ['dev'] });
const entryEnc = encrypt(entry, pipelineMk);
const entryDec = decrypt(entryEnc, pipelineMk);
assertEq(entryDec, entry, 'Staging entry encrypt/decrypt round-trip');

// Obfuscate a full blob
const blob = JSON.stringify({
  device_id: 'abc-123',
  entries: [{ data: { title_enc: entryEnc }, hash: 'abc' }],
  updated_at: 1717000000000,
});
const blobObf = obfuscate_blob(blob, pipelineMk);
const blobDeobf = deobfuscate_blob(blobObf, pipelineMk);
assertEq(blobDeobf, blob, 'Full blob obfuscation round-trip');

// Device identity derived from the same master key
const pipeDeviceId = get_device_id(pipelineMk);
const pipeProof = device_proof(pipelineMk, pipeDeviceId);
assert(
  verify_device_proof(pipeDeviceId, pipeProof, pipelineMk),
  'Device proof verification with pipeline master key',
);

// ──────────────────────────────────────────────────────────────────────
// 12. Error cases — invalid inputs
// ──────────────────────────────────────────────────────────────────────
console.log('\n── Error Cases ──');

assertThrows(
  () => derive_master_key('invalid-base64!!!'),
  'derive_master_key with invalid base64 throws',
);

assertThrows(
  () => encrypt('hello', 'not-even-hex'),
  'encrypt with invalid master key hex throws',
);

assertThrows(
  () => decrypt('00', 'ab'.repeat(32)),
  'decrypt with too-short ciphertext throws',
);

// ──────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────
console.log(`\n── Results ──────────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`  ❌ Some tests failed.`);
  process.exit(1);
} else {
  console.log(`  ✅ All 20 WASM functions exercised successfully.`);
}
