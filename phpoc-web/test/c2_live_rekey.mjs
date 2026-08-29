/**
 * c2_live_rekey.mjs — C-2 live R2 E2E Node helper (Web WASM side).
 *
 * A stdin/stdout subprocess helper driven by `tests/test_c2_live_r2.py`
 * (mirrors the CCS-4 live-worker pattern in `ccs4_cross_client.mjs`). It
 * provides the two WASM-only operations the Python driver cannot do itself:
 *
 *   - `rekey`  — stage the pulled real test-ledger blocks into a
 *                MemoryBackend (unlocked under OLD_MK) and run the REAL
 *                `RekeyService.rekey()` (full seed replacement) with
 *                ALT_SEED + a new passphrase. Returns the re-keyed wire
 *                blocks + new seed + new MK.
 *   - `verify` — verify the (re-keyed) chain under `mk` via the same
 *                ADR-029/029a `computeSeal` + `verifyEntryHash` +
 *                `computeContentHash` + `verifySignature` path the hermetic
 *                C-2 harness uses, and assert the OLD MK no longer decrypts
 *                any `_enc` field (old-seed-device-fails).
 *
 * Python drives the R2 pull/push (production blob obfuscation under OLD/NEW
 * MK); this helper only performs the WASM re-key + verify. One op per process.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { MemoryBackend } from '../src/sync/storage.js';
import { RekeyService } from '../src/services/rekey_service.js';
import { computeSeal } from '../src/ledger/seal_fields.js';
import { getBlockHash, verifyEntryHash } from '../src/ledger/utils.js';
import { SHARED, loadCrypto, computeContentHash } from './c2_fixture_gen.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Storage keys (web contract — mirrors rekey_service.js).
const STORED_SEED_KEY = 'phpoc_seed';
const PDK_TOKEN_KEY = 'phpoc_pdk_token';
const BLOCKS_KEY = 'ledger:blocks';
const COOKIE_KEY = 'cookie';
const VERIFY_TOKEN = 'phpoc_pdk_verify';

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

/** op: rekey — stage + run the REAL RekeyService against pulled blocks. */
async function opRekey(args) {
  const c = await getCrypto();
  const { blocks, oldSeed, oldPassphrase, newPassphrase, newSeed } = args;

  const oldMk = c.deriveMasterKey(oldSeed);
  const oldPdk = c.derivePdk(oldPassphrase, SHARED.PBKDF2_ITERATIONS);
  c.setMasterKey(oldMk);

  const store = new MemoryBackend();
  await store.set(BLOCKS_KEY, blocks);
  await store.set(STORED_SEED_KEY, oldSeed);
  await store.set(PDK_TOKEN_KEY, c.encrypt(VERIFY_TOKEN, oldPdk));
  await store.set(COOKIE_KEY, {
    device_specifier: 'live-old-specifier-00000000000000',
    creation_time: 1700000000000,
  });

  const service = new RekeyService({ crypto: c, storage: store });
  const result = await service.rekey({ oldPassphrase, newPassphrase, newSeed });

  return {
    blocks: await store.get(BLOCKS_KEY),
    newSeed: result.newSeed,
    newMasterKey: result.newMasterKey,
    seedFingerprint: result.seedFingerprint,
    remotePushed: result.remotePushed,
  };
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

async function run(op, args) {
  switch (op) {
    case 'rekey':
      return opRekey(args);
    case 'verify':
      return opVerify(args);
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
