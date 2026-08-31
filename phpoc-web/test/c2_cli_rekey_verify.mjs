/**
 * c2_cli_rekey_verify.mjs — C-2 CLI↔client cross-client verify helper
 * (Web WASM side, Phase 2 RED).
 *
 * A stdin/stdout subprocess helper driven by
 * `tests/test_c2_cli_client_verify.py` (mirrors `c2_live_rekey.mjs`). It
 * provides the WASM-only operations the Python driver cannot do itself:
 *
 *   - `verify`          — verify a CLI-re-keyed chain under the NEW MK via the
 *                         ADR-029/029a path (computeSeal + verifyEntryHash +
 *                         computeContentHash + verifySignature) and assert the
 *                         OLD MK no longer decrypts any `_enc` field
 *                         (old-seed-device-fails). Used for Groups A7–A11.
 *   - `deriveMk`        — versioned MK derivation for crypto-invariant parity
 *                         (Group D1): deriveMk(seed, version) → hex.
 *   - `deriveMasterKey` — raw-seed MK derivation for option-(a) parity
 *                         (Group D2): deriveMasterKey(seed) → hex.
 *
 * One op per process. Python drives R2 pull/push and the CLI re-keyer; this
 * helper only performs the WASM verify + derivation.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeSeal } from '../src/ledger/seal_fields.js';
import { getBlockHash, verifyEntryHash } from '../src/ledger/utils.js';
import { deriveMk } from '../src/crypto/index.js';
import { loadCrypto, computeContentHash } from './c2_fixture_gen.mjs';

let crypto = null;
async function getCrypto() {
  if (!crypto) crypto = await loadCrypto();
  return crypto;
}

function hashKeyFor(block) {
  if (block.block_hash !== undefined) return 'block_hash';
  if (block.day_hash !== undefined) return 'day_hash';
  if (block.month_hash !== undefined) return 'month_hash';
  return 'year_hash';
}

/** Decrypt, returning null instead of throwing (decrypt has no-tag fallbacks
 *  that may return garbage rather than throw on a wrong key). */
function tryDecrypt(c, ct, key) {
  try {
    return c.decrypt(ct, key);
  } catch {
    return null;
  }
}

function verifyBlock(c, block, mk, identitySecret) {
  const hashKey = hashKeyFor(block);
  if (computeSeal(block, c, mk) !== block[hashKey]) return false;

  if (block.type === 'day') {
    for (const entry of block.entries || []) {
      if (!entry || !entry.data) return false;
      if (!verifyEntryHash(entry.data, entry.hash, c)) return false;
      if (entry.data.content_hash) {
        if (computeContentHash(c, mk, entry.data) !== entry.data.content_hash) return false;
      }
    }
  }
  if (identitySecret && block.identity_seal) {
    if (!c.verifySignature(block[hashKey], block.identity_seal, identitySecret)) return false;
  }
  return true;
}

function verifyChain(c, blocks, mk, identitySecret) {
  if (!Array.isArray(blocks) || blocks.length === 0) return false;
  for (let i = 0; i < blocks.length; i++) {
    if (!verifyBlock(c, blocks[i], mk, identitySecret)) return false;
    if (i > 0 && getBlockHash(blocks[i - 1]) !== blocks[i].prev_hash) return false;
  }
  return true;
}

/** Recover the identity secret (key-independent) from the genesis fallback. */
function recoverIdentitySecret(c, blocks, mk) {
  const genesis = blocks && blocks[0];
  if (genesis && genesis.identity && genesis.identity.identity_secret_enc_fallback) {
    return tryDecrypt(c, genesis.identity.identity_secret_enc_fallback, mk);
  }
  return null;
}

/** op: verify — verify a chain under `mk` and assert OLD-MK nullification. */
async function opVerify(args) {
  const c = await getCrypto();
  const { blocks, mk, oldMk, identitySecret: identitySecretArg } = args;

  const identitySecret = identitySecretArg || recoverIdentitySecret(c, blocks, mk);
  const ok = verifyChain(c, blocks, mk, identitySecret);

  // Old-MK nullification: every `_enc` field must decrypt under NEW MK and
  // must NOT decrypt (or must differ) under OLD MK.
  let leakNullified = true;
  let encFields = 0;
  for (const block of blocks || []) {
    for (const entry of block.entries || []) {
      for (const [k, v] of Object.entries(entry.data || {})) {
        if (!k.endsWith('_enc') || v === null || v === undefined || v === '') continue;
        encFields += 1;
        const correct = tryDecrypt(c, v, mk);
        if (correct === null || correct === '') {
          leakNullified = false;
          continue;
        }
        const wrong = tryDecrypt(c, v, oldMk);
        if (wrong !== null && wrong === correct) leakNullified = false;
      }
    }
  }

  return { ok, blockCount: (blocks || []).length, encFields, leakNullified };
}

/** op: deriveMk — versioned MK derivation for Group D1 parity. */
async function opDeriveMk(args) {
  const { seedB64, version } = args;
  const seedBytes = Uint8Array.from(Buffer.from(seedB64, 'base64'));
  const mk = await deriveMk(seedBytes, version);
  return { hex: Buffer.from(mk).toString('hex') };
}

/** op: deriveMasterKey — raw-seed MK derivation for Group D2 parity. */
async function opDeriveMasterKey(args) {
  const c = await getCrypto();
  const { seedB64 } = args;
  return { hex: c.deriveMasterKey(seedB64) };
}

async function run(op, args) {
  switch (op) {
    case 'verify':
      return opVerify(args);
    case 'deriveMk':
      return opDeriveMk(args);
    case 'deriveMasterKey':
      return opDeriveMasterKey(args);
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  let req;
  try {
    req = JSON.parse(input);
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: `bad json: ${e.message}` }));
    return;
  }

  try {
    const result = await run(req.op, req.args || {});
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
  }
}

export { run };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err));
    process.exit(1);
  });
}
