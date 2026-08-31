/**
 * c2_cross_client_verify.mjs — C-2 Cross-Client Verification (Phase D), Phase 2 RED harness (Web side).
 *
 * Runs under `node --test`. Encodes the Phase 1 assertion matrix
 * (`docs/planning/C2_CROSS_CLIENT_VERIFY_PHASE1.md`) for the Web client:
 *
 *   - Group A (A1–A6):  Web as re-keyer — re-key the shared canonical fixture
 *                       under the REAL WASM CryptoService + MemoryBackend, then
 *                       emit the re-keyed chain to `testdata/c2_web_rekeyed_wire.json`.
 *   - Group B (B7–B12): Web as verifier of the Flutter re-keyed wire artifact
 *                       (`testdata/c2_flutter_rekeyed_wire.json`). RED until the
 *                       Flutter re-key probe (Phase 3) writes that artifact.
 *   - Group C (C1–C8):  cross-client cryptographic invariants (Web side; the
 *                       Flutter side of each lives in
 *                       `c2_cross_client_verify_test.dart`).
 *
 * Live-only assertions (index.json / hash_index.json parity, device-cookie
 * reauth) are explicitly `skip`ped here and deferred to the live R2 E2E
 * (Phase 3) — they have no hermetic wire equivalent.
 *
 * Run: node --test test/c2_cross_client_verify.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { MemoryBackend } from '../src/sync/storage.js';
import { RekeyService } from '../src/services/rekey_service.js';
import { computeSeal } from '../src/ledger/seal_fields.js';
import { computeEntryHash, jsonSort, getBlockHash, verifyEntryHash } from '../src/ledger/utils.js';

import {
  SHARED, loadCrypto, computeContentHash, buildFixtureChain,
  FIXTURE_PATH, WEB_REKEYED_PATH, FLUTTER_REKEYED_PATH,
} from './c2_fixture_gen.mjs';

const {
  VALID_SEED, ALT_SEED, OLD_MK, NEW_MK,
  OLD_PASSPHRASE, NEW_PASSPHRASE, PBKDF2_ITERATIONS, IDENTITY_SECRET,
} = SHARED;

// Storage keys (web contract — mirrors rekey_service.js).
const STORED_SEED_KEY = 'phpoc_seed';
const PDK_TOKEN_KEY = 'phpoc_pdk_token';
const IDENTITY_SECRET_KEY = 'phpoc_identity_secret';
const BLOCKS_KEY = 'ledger:blocks';
const COOKIE_KEY = 'cookie';
const VERIFY_TOKEN = 'phpoc_pdk_verify';

let crypto;
let oldPdk;
let newPdk;

before(async () => {
  crypto = await loadCrypto();
  oldPdk = crypto.derivePdk(OLD_PASSPHRASE, PBKDF2_ITERATIONS);
  newPdk = crypto.derivePdk(NEW_PASSPHRASE, PBKDF2_ITERATIONS);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function hashKeyFor(block) {
  if (block.block_hash !== undefined) return 'block_hash';
  if (block.day_hash !== undefined) return 'day_hash';
  if (block.month_hash !== undefined) return 'month_hash';
  return 'year_hash';
}

/** Verify a block seal + (for day blocks) entry hashes + content hashes + identity seal. */
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

/** Collect every entry `_enc` field plaintext (decrypted under the given MK). */
function collectEncPlaintexts(c, blocks, mk) {
  const out = [];
  for (const block of blocks) {
    for (const entry of block.entries || []) {
      for (const [k, v] of Object.entries(entry.data || {})) {
        if (k.endsWith('_enc') && v) out.push({ block: block.type, key: k, plain: c.decrypt(v, mk) });
      }
    }
  }
  return out;
}

/** Index each entry's `content_hash` by entry `hash`. */
function collectContentHashes(blocks) {
  const out = {};
  for (const b of blocks) for (const e of b.entries || []) out[e.hash] = e.data.content_hash;
  return out;
}

/** Read a testdata artifact; return null (with a reason) when absent. */
function readArtifact(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Decrypt, returning null instead of throwing (decrypt has no-tag fallbacks
 *  that may return garbage rather than throw on a wrong key). */
function tryDecrypt(c, ct, key) {
  try {
    return c.decrypt(ct, key);
  } catch (_) {
    return null;
  }
}

/** Load the committed fixture + stage it into a fresh MemoryBackend (unlocked under OLD_MK). */
async function stageFixture(store) {
  const fixture = readArtifact(FIXTURE_PATH);
  assert.ok(fixture, `fixture missing — run: node phpoc-web/test/c2_fixture_gen.mjs`);
  const blocks = fixture.blocks;
  await store.set(BLOCKS_KEY, blocks);
  await store.set(STORED_SEED_KEY, VALID_SEED);
  await store.set(PDK_TOKEN_KEY, crypto.encrypt(VERIFY_TOKEN, oldPdk));
  await store.set(IDENTITY_SECRET_KEY, IDENTITY_SECRET);
  await store.set(COOKIE_KEY, { device_specifier: 'old-specifier-0000000000000000', creation_time: 1700000000000 });
  crypto.setMasterKey(OLD_MK);
  return { blocks, fixture };
}

const REKEY_ARGS = {
  oldPassphrase: OLD_PASSPHRASE,
  newPassphrase: NEW_PASSPHRASE,
  newSeed: ALT_SEED,
};

/** Run a re-key on an already-staged store and return the rebuilt blocks. */
async function runRekey(store) {
  const service = new RekeyService({ crypto, storage: store });
  const result = await service.rekey(REKEY_ARGS);
  return { result, blocks: await store.get(BLOCKS_KEY) };
}

// ═══════════════════════════════════════════════════════════════
// Group A — Web re-keyer → Flutter verifier (A1–A6, web side)
// ═══════════════════════════════════════════════════════════════
describe('Group A: Web re-keyer (A1–A6)', () => {
  it('A1: RekeyService.rekey() completes without error against the canonical fixture', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const { result } = await runRekey(store);
    assert.ok(result && result.newSeed, 're-key must return the new seed');
  });

  it('A2: re-key mints a fresh seed — 44-char base64, 32 bytes, ≠ old seed', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const rekey = new RekeyService({ crypto, storage: store });
    const seed = rekey.mintNewSeed(VALID_SEED);

    assert.equal(Buffer.from(seed, 'base64').length, 32, 'seed must decode to 32 bytes');
    assert.notEqual(seed, VALID_SEED, 'new seed must differ from the old seed');
  });

  it('A3: genesis identity.recovery_seed_enc + identity_secret_enc_fallback rewritten; identity_pub_key invariant', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const before = (await store.get(BLOCKS_KEY))[0].identity;
    const { blocks } = await runRekey(store);
    const identity = blocks[0].identity;
    assert.equal(crypto.decrypt(identity.recovery_seed_enc, newPdk), ALT_SEED, 'seed envelope must decrypt under the NEW PDK');
    assert.equal(crypto.decrypt(identity.identity_secret_enc_fallback, NEW_MK), IDENTITY_SECRET, 'identity fallback must re-encrypt under the NEW MK');
    assert.equal(identity.identity_pub_key, before.identity_pub_key, 'identity_pub_key is key-independent and must be invariant');
  });

  it('A4: every _enc field re-encrypted under NEW MK; content_hash byte-invariant', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const beforePlain = collectEncPlaintexts(crypto, await store.get(BLOCKS_KEY), OLD_MK);
    const beforeCH = collectContentHashes(await store.get(BLOCKS_KEY));
    const { blocks } = await runRekey(store);
    const afterPlain = collectEncPlaintexts(crypto, blocks, NEW_MK);
    assert.equal(afterPlain.length, beforePlain.length, 'no _enc field may be lost');
    for (let i = 0; i < beforePlain.length; i++) {
      assert.equal(afterPlain[i].plain, beforePlain[i].plain, `${beforePlain[i].block}.${beforePlain[i].key} must re-encrypt to the same plaintext`);
    }
    const afterCH = collectContentHashes(blocks);
    assert.deepEqual(Object.values(afterCH).sort(), Object.values(beforeCH).sort(), 'content_hash must be byte-invariant across re-key');
  });

  it('A5: re-keyed chain verifies VALID under the new MK (self-verify)', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const { blocks } = await runRekey(store);
    assert.ok(verifyChain(crypto, blocks, NEW_MK, IDENTITY_SECRET), 're-keyed chain must verify under the NEW MK');
  });

  it('A6: re-key emits the re-keyed chain to the shared wire artifact', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const { blocks } = await runRekey(store);
    const artifact = {
      version: 1,
      rekeyer: 'web',
      new_seed: ALT_SEED,
      new_mk: NEW_MK,
      new_passphrase: NEW_PASSPHRASE,
      blocks,
    };
    writeFileSync(WEB_REKEYED_PATH, JSON.stringify(artifact, null, 2) + '\n');
    assert.ok(existsSync(WEB_REKEYED_PATH), 'web re-keyed wire artifact must be written');
    assert.ok(verifyChain(crypto, blocks, NEW_MK, IDENTITY_SECRET), 'emitted artifact must verify under the NEW MK');
  });
});

// ═══════════════════════════════════════════════════════════════
// Group B — Flutter re-keyer → Web verifier (B7–B12, web side)
// ═══════════════════════════════════════════════════════════════
describe('Group B: Web verifier of the Flutter re-keyed wire (B7–B12)', () => {
  it('B7: web pulls (loads) the Flutter re-keyed chain with no error', () => {
    const artifact = readArtifact(FLUTTER_REKEYED_PATH);
    assert.ok(artifact, 'Flutter re-keyed wire artifact absent — run the Flutter re-key probe (c2_cross_client_verify_test.dart, Group B) in Phase 3 to produce testdata/c2_flutter_rekeyed_wire.json');
    assert.ok(Array.isArray(artifact.blocks) && artifact.blocks.length > 0, 'artifact must contain a non-empty blocks array');
  });

  it('B8: web LedgerChain.verify() VALID under the new MK', () => {
    const artifact = readArtifact(FLUTTER_REKEYED_PATH);
    assert.ok(artifact, 'Flutter re-keyed wire artifact absent — run the Flutter re-key probe first (Phase 3)');
    // R2/R1 risk: the Flutter wire genesis must re-verify its seal + nested identity.
    assert.ok(verifyChain(crypto, artifact.blocks, NEW_MK, IDENTITY_SECRET),
      'Flutter re-keyed chain must verify under the NEW MK on web (RED until the Flutter wire genesis emits the canonical identity/seal)');
  });

  it('B9: web genesis parity — nested identity.{recovery_seed_enc, identity_pub_key, identity_secret_enc_fallback} present', () => {
    const artifact = readArtifact(FLUTTER_REKEYED_PATH);
    assert.ok(artifact, 'Flutter re-keyed wire artifact absent — run the Flutter re-key probe first (Phase 3)');
    const genesis = artifact.blocks[0];
    assert.ok(genesis && genesis.identity, 'genesis must carry a nested identity object');
    assert.ok('recovery_seed_enc' in genesis.identity, 'identity.recovery_seed_enc must be present on the wire');
    assert.ok('identity_pub_key' in genesis.identity, 'identity.identity_pub_key must be present');
    assert.ok('identity_secret_enc_fallback' in genesis.identity, 'identity.identity_secret_enc_fallback must be present');
    assert.equal(crypto.decrypt(genesis.identity.recovery_seed_enc, newPdk), ALT_SEED,
      'identity.recovery_seed_enc must decrypt under the NEW PDK to the new seed');
  });

  it('B11: web device holding the OLD seed/MK cannot decrypt the re-keyed ciphertext', () => {
    const artifact = readArtifact(FLUTTER_REKEYED_PATH);
    assert.ok(artifact, 'Flutter re-keyed wire artifact absent — run the Flutter re-key probe first (Phase 3)');

    // Sanity: the ciphertext still decrypts under the NEW MK (it is valid).
    const newPlain = collectEncPlaintexts(crypto, artifact.blocks, NEW_MK);
    assert.ok(newPlain.length > 0, 'at least one _enc field must exist');

    // Leak-nullification: the OLD MK must NOT recover the re-keyed plaintext.
    for (const block of artifact.blocks) {
      for (const entry of block.entries || []) {
        for (const [k, v] of Object.entries(entry.data || {})) {
          if (k.endsWith('_enc') && v) {
            const correct = tryDecrypt(crypto, v, NEW_MK);
            assert.ok(correct !== null && correct.length > 0, `${block.type}.${k} must decrypt under NEW MK (sanity)`);
            assert.notEqual(
              tryDecrypt(crypto, v, OLD_MK),
              correct,
              `${block.type}.${k} must NOT decrypt under the OLD MK (leak-nullification)`,
            );
          }
        }
      }
    }
  });

  // Live-only: index/hash_index parity and device-cookie reauth have no hermetic
  // wire equivalent — deferred to the live R2 E2E in Phase 3.
  it('B10: web hash_index.json / index.json / genesis parity intact after pull', { skip: 'deferred to live R2 E2E (Phase 3) — no hermetic index equivalent' }, () => {});
  it('B12: web stale device-cookie specifier → reauthNeeded on next sync', { skip: 'deferred to live R2 E2E (Phase 3) — requires a live sync transport' }, () => {});
});

// ═══════════════════════════════════════════════════════════════
// Group C — Cross-client cryptographic invariants (C1–C8, web side)
// ═══════════════════════════════════════════════════════════════
describe('Group C: cross-client cryptographic invariants (Web side)', () => {
  it('C1: deriveMasterKey(newSeed) yields the raw 32 seed bytes as the new MK', () => {
    assert.equal(crypto.deriveMasterKey(ALT_SEED), NEW_MK, 'new MK must equal the raw base64-decoded seed bytes (Flutter asserts the same in its harness)');
  });

  it('C2: new MK ≠ old MK; new seed ≠ old seed', () => {
    assert.notEqual(NEW_MK, OLD_MK);
    assert.notEqual(ALT_SEED, VALID_SEED);
  });

  it('C3: content_hash byte-identical before/after re-key (web side)', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const before = collectContentHashes(await store.get(BLOCKS_KEY));
    const { blocks } = await runRekey(store);
    const after = collectContentHashes(blocks);
    assert.deepEqual(Object.values(after).sort(), Object.values(before).sort());
  });

  it('C4: key_version unchanged by a seed-mint re-key (option a)', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const versionsBefore = (await store.get(BLOCKS_KEY)).map((b) => b.key_version);
    const { blocks } = await runRekey(store);
    const versionsAfter = blocks.map((b) => b.key_version);
    assert.deepEqual(versionsAfter, versionsBefore, 'option (a) keeps key_version unchanged');
  });

  it('C5: identity secret + identity_pub_key invariant across re-key', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const before = (await store.get(BLOCKS_KEY))[0].identity;
    const { blocks } = await runRekey(store);
    const after = blocks[0].identity;
    assert.equal(after.identity_pub_key, before.identity_pub_key, 'identity_pub_key must be invariant');
    assert.equal(crypto.decrypt(after.identity_secret_enc_fallback, NEW_MK), IDENTITY_SECRET, 'identity secret must survive (device-scoped)');

    // D1 (raw-bytes): the invariant pubkey must be the canonical raw-bytes
    // identityPubKey(IDENTITY_SECRET) — not the hex-string sha256(String).
    assert.equal(typeof crypto.identityPubKey, 'function', 'crypto.identityPubKey binding must exist');
    assert.equal(after.identity_pub_key, crypto.identityPubKey(IDENTITY_SECRET),
      'identity_pub_key must equal the raw-bytes identityPubKey(IDENTITY_SECRET)');
    assert.notEqual(after.identity_pub_key, crypto.sha256(IDENTITY_SECRET),
      'identity_pub_key must NOT be the hex-string hash');
  });

  it('C6: prev_hash cascade intact after re-key', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const { blocks } = await runRekey(store);
    for (let i = 1; i < blocks.length; i++) {
      assert.equal(blocks[i].prev_hash, getBlockHash(blocks[i - 1]), `block ${i} prev_hash must link to its predecessor`);
    }
  });

  it('C7: entry plaintext under new MK == plaintext under old MK (no data loss)', async () => {
    const store = new MemoryBackend();
    await stageFixture(store);
    const before = collectEncPlaintexts(crypto, await store.get(BLOCKS_KEY), OLD_MK);
    const { blocks } = await runRekey(store);
    const after = collectEncPlaintexts(crypto, blocks, NEW_MK);
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) assert.equal(after[i].plain, before[i].plain);
  });

  it('C8: seal-key derivation parity — web recompute equals the committed (cross-client) fixture seals', () => {
    const fixture = readArtifact(FIXTURE_PATH);
    assert.ok(fixture, 'fixture missing — run: node phpoc-web/test/c2_fixture_gen.mjs');
    for (const block of fixture.blocks) {
      const hk = hashKeyFor(block);
      assert.equal(computeSeal(block, crypto, OLD_MK), block[hk],
        `${block.type} seal must equal the committed fixture seal (Flutter asserts the same → cross-client parity)`);
    }
  });
});
