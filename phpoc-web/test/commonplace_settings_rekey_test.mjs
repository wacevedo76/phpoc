/**
 * commonplace_settings_rekey_test.mjs — Re-key extends RekeyService to
 * re-encrypt `commonplace:blocks` (Slice 4) — Group R (R1–R7) from
 * docs/planning/COMMONPLACE_BOOK_SETTINGS_WEB_PHASE1.md. Phase 2 (RED).
 *
 * Node harness (`node --test`), mirroring `rekey_service_web_test.mjs`.
 * Seeds BOTH chains under the OLD MK into one MemoryBackend, re-keys via the
 * real `RekeyService`, and asserts the Commonplace chain was re-encrypted in
 * lockstep with the ledger. The CURRENT `RekeyService` only touches
 * `ledger:blocks`, so R1/R2/R3/R5/R6/R7 are RED (Commonplace is untouched);
 * R4 is a regression guard that already passes.
 *
 * Fixtures use the REAL WASM CryptoService. The Commonplace chain is built via
 * `CommonplaceChain` with `identitySecret = null` (the Commonplace identity
 * seal uses `crypto.mac`/`verifyMac`, which the WASM CryptoService does not
 * expose — out of scope for this slice); block seals, entry `_enc` fields and
 * content hashes are all genuinely encrypted/sealed and re-verified.
 *
 * Contract (drives Phase 3) — `rekey()` re-encrypts `commonplace:blocks`
 * additively (ledger path byte-identical), and the returned result adds:
 *   - `commonplaceBlocksReencrypted` (count of rewritten Commonplace blocks)
 *   - `commonplaceEntriesReencrypted` (count of re-encrypted Commonplace entries)
 *
 * Run: node --test test/commonplace_settings_rekey_test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MemoryBackend } from '../src/sync/storage.js';
import { computeSeal } from '../src/ledger/seal_fields.js';
import { computeEntryHash, jsonSort, getBlockHash } from '../src/ledger/utils.js';
import { CommonplaceChain } from '../src/commonplace/commonplace_chain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Non-secret dummy fixtures (mirrors rekey_service_web_test.mjs) ─────────
const VALID_SEED = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI='; // 32×0x42
const ALT_SEED = 'ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE='; // 32×0x21
const OLD_MK = '42'.repeat(32);
const NEW_MK = '21'.repeat(32);
const OLD_PASSPHRASE = 'CorrectHorseBatteryStaple42!';
const NEW_PASSPHRASE = 'NewCorrectHorseBatteryStaple99!';
const PBKDF2_ITERATIONS = 600000;
const IDENTITY_SECRET = 'ab'.repeat(32); // device-scoped, unchanged by re-key

// ── Storage keys ──────────────────────────────────────────────────────────
const STORED_SEED_KEY = 'phpoc_seed';
const PDK_TOKEN_KEY = 'phpoc_pdk_token';
const IDENTITY_SECRET_KEY = 'phpoc_identity_secret';
const BLOCKS_KEY = 'ledger:blocks';
const COOKIE_KEY = 'cookie';
const VERIFY_TOKEN = 'phpoc_pdk_verify';
const COMMONPLACE_BLOCKS_KEY = 'commonplace:blocks';

// ── Shared crypto session (loaded once, real WASM) ─────────────────────────
let crypto;
let oldPdk;
let newPdk;

async function loadCrypto() {
  const { CryptoService } = await import('../src/crypto/index.js');
  const wasmBytes = readFileSync(
    path.join(__dirname, '../src/crypto/wasm/phpoc_crypto_core_bg.wasm'),
  );
  return CryptoService.create({ wasmModule: wasmBytes });
}

before(async () => {
  crypto = await loadCrypto();
  oldPdk = crypto.derivePdk(OLD_PASSPHRASE, PBKDF2_ITERATIONS);
  newPdk = crypto.derivePdk(NEW_PASSPHRASE, PBKDF2_ITERATIONS);
});

// ── Defensive import of RekeyService ───────────────────────────────────────
let RekeyService = null;
try {
  ({ RekeyService } = await import('../src/services/rekey_service.js'));
} catch {
  RekeyService = null;
}

class RekeyServiceSkeleton {
  constructor(deps) { this.crypto = deps.crypto; this.storage = deps.storage; }
  _ny() { throw new Error('RekeyService not implemented — Phase 3'); }
  async rekey() { this._ny(); }
}

// ── Ledger fixture helpers (mirror rekey_service_web_test.mjs) ─────────────

function computeContentHash(c, mk, data) {
  const content = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'content_hash') continue;
    if (k.endsWith('_enc') && v !== null && v !== undefined && v !== '') {
      content[k] = c.decrypt(v, mk);
    } else if (Array.isArray(v)) {
      content[k] = v.slice().sort((a, b) => String(a).localeCompare(String(b)));
    } else {
      content[k] = v;
    }
  }
  return c.sha256(jsonSort(content));
}

function buildEntry(c, mk, { title, startEpoch, duration }) {
  const data = {
    title,
    startTime_enc: c.encrypt(String(startEpoch), mk),
    endTime_enc: c.encrypt(String(startEpoch + duration), mk),
    duration,
  };
  data.content_hash = computeContentHash(c, mk, data);
  const hash = computeEntryHash(data, c);
  return { hash, data, start_epoch: startEpoch };
}

function buildGenesis(c, mk, pdk, seed, identitySecret) {
  const genesis = {
    type: 'genesis',
    day_index: 0,
    date: '2026-01-01',
    prev_hash: '0'.repeat(64),
    entries: [],
    identity: {
      username: 'Test User',
      email: 'test@example.com',
      recovery_seed_enc: c.encrypt(seed, pdk),
      identity_pub_key: c.identityPubKey(identitySecret),
      identity_secret_enc_fallback: c.encrypt(identitySecret, mk),
    },
  };
  genesis.block_hash = computeSeal(genesis, c, mk);
  genesis.identity_seal = c.sign(genesis.block_hash, identitySecret);
  return genesis;
}

function buildDayBlock(c, mk, identitySecret, prevHash, entries, dayIndex, date) {
  const day = { type: 'day', day_index: dayIndex, date, prev_hash: prevHash, entries };
  day.day_hash = computeSeal(day, c, mk);
  day.identity_seal = c.sign(day.day_hash, identitySecret);
  return day;
}

async function buildLedgerFixture(store) {
  const mk = crypto.deriveMasterKey(VALID_SEED); // = OLD_MK
  crypto.setMasterKey(mk);
  const e1 = buildEntry(crypto, mk, { title: 'Alpha task', startEpoch: 1767225600, duration: 3600 });
  const genesis = buildGenesis(crypto, mk, oldPdk, VALID_SEED, IDENTITY_SECRET);
  const day = buildDayBlock(crypto, mk, IDENTITY_SECRET, genesis.block_hash, [e1], 1, '2026-01-02');
  const blocks = [genesis, day];
  await store.set(BLOCKS_KEY, blocks);
  await store.set(STORED_SEED_KEY, VALID_SEED);
  await store.set(PDK_TOKEN_KEY, crypto.encrypt(VERIFY_TOKEN, oldPdk));
  await store.set(IDENTITY_SECRET_KEY, IDENTITY_SECRET);
  await store.set(COOKIE_KEY, { device_specifier: 'old-specifier-0000000000000000', creation_time: 1700000000000 });
  return { blocks, mk };
}

/** Build the Commonplace chain under the OLD MK: genesis + one day block (2 entries). */
async function buildCommonplaceFixture(store) {
  const chain = new CommonplaceChain(crypto, store, OLD_MK, null);
  await chain.buildGenesis({
    username: 'CP User',
    email: 'cp@example.com',
    recoverySeedEnc: crypto.encrypt(VALID_SEED, oldPdk),
    identityPubKey: crypto.identityPubKey(IDENTITY_SECRET),
    identitySecretEncFallback: crypto.encrypt(IDENTITY_SECRET, OLD_MK),
  });
  const genesis = await chain.getLastBlock();
  const day = await chain.buildDayBlock([
    { title: 'CP Alpha', tags: ['philosophy'], entry: 'first cp passage', timestamp_ms: 1767312000000 },
    { title: 'CP Beta', tags: [], entry: 'second cp passage', timestamp_ms: 1767315600000 },
  ], chain.getBlockHashFor(genesis), '2026-01-02');
  await chain.append(day);
}

const freshStore = () => new MemoryBackend();

function makeRekey(store) {
  const Ctor = RekeyService || RekeyServiceSkeleton;
  return new Ctor({ crypto, storage: store });
}

function hashKeyFor(block) {
  if (block.block_hash !== undefined) return 'block_hash';
  if (block.day_hash !== undefined) return 'day_hash';
  if (block.month_hash !== undefined) return 'month_hash';
  return 'year_hash';
}

function verifyBlock(c, block, mk, identitySecret) {
  const hashKey = hashKeyFor(block);
  if (computeSeal(block, c, mk) !== block[hashKey]) return false;
  if (identitySecret && block.identity_seal) {
    if (!c.verifySignature(block[hashKey], block.identity_seal, identitySecret)) return false;
  }
  return true;
}

function verifyChain(c, blocks, mk, identitySecret) {
  return blocks.length > 0 && blocks.every((b) => verifyBlock(c, b, mk, identitySecret));
}

/** Collect the `commonplace` day-block entries in chain order. */
function collectCpEntries(blocks) {
  const out = [];
  for (const block of blocks || []) {
    if (block.type !== 'commonplace') continue;
    for (const entry of block.entries || []) out.push(entry);
  }
  return out;
}

const REKEY_ARGS = {
  oldPassphrase: OLD_PASSPHRASE,
  newPassphrase: NEW_PASSPHRASE,
  newSeed: ALT_SEED,
};

// ═══════════════════════════════════════════════════════════════════
// Group R: Re-key re-encrypts commonplace:blocks (R1–R7)
// ═══════════════════════════════════════════════════════════════════

describe('R: Re-key re-encrypts commonplace:blocks', () => {
  it('R1: after re-key, Commonplace entries decrypt under the NEW MK', async () => {
    const store = freshStore();
    await buildLedgerFixture(store);
    await buildCommonplaceFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const cpBlocks = await store.get(COMMONPLACE_BLOCKS_KEY);
    const chainNew = new CommonplaceChain(crypto, store, NEW_MK, null);
    const titles = [];
    for (const block of cpBlocks) {
      if (block.type !== 'commonplace') continue;
      for (const entry of block.entries) {
        titles.push(chainNew.decryptEntryData(entry.data).title);
      }
    }
    assert.deepEqual(titles, ['CP Alpha', 'CP Beta'], 'Commonplace titles must decrypt under the NEW MK');
  });

  it('R2: the Commonplace chain verifies under the NEW MK (seals re-derived), not the OLD MK', async () => {
    const store = freshStore();
    await buildLedgerFixture(store);
    await buildCommonplaceFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const chainNew = new CommonplaceChain(crypto, store, NEW_MK, null);
    const chainOld = new CommonplaceChain(crypto, store, OLD_MK, null);
    assert.ok(await chainNew.verify(), 'Commonplace chain must verify under the NEW MK');
    assert.ok(!(await chainOld.verify()), 'Commonplace chain must NOT verify under the OLD MK');
  });

  it('R3: re-encrypts *_enc fields + recomputes entry hash; preserves plaintext + content_hash', async () => {
    const store = freshStore();
    await buildLedgerFixture(store);
    await buildCommonplaceFixture(store);
    const beforeEntries = collectCpEntries(await store.get(COMMONPLACE_BLOCKS_KEY));
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const afterEntries = collectCpEntries(await store.get(COMMONPLACE_BLOCKS_KEY));
    assert.equal(afterEntries.length, beforeEntries.length, 'no entries lost');

    for (let i = 0; i < beforeEntries.length; i++) {
      const b = beforeEntries[i].data;
      const a = afterEntries[i].data;
      // Every content field re-encrypted (ciphertext changed).
      assert.notEqual(a.title_enc, b.title_enc, `entry ${i} title_enc re-encrypted`);
      assert.notEqual(a.entry_enc, b.entry_enc, `entry ${i} entry_enc re-encrypted`);
      assert.notEqual(a.tags_enc, b.tags_enc, `entry ${i} tags_enc re-encrypted`);
      // Plaintext preserved across the rotation.
      assert.equal(crypto.decrypt(a.title_enc, NEW_MK), crypto.decrypt(b.title_enc, OLD_MK), `entry ${i} title preserved`);
      assert.equal(crypto.decrypt(a.entry_enc, NEW_MK), crypto.decrypt(b.entry_enc, OLD_MK), `entry ${i} entry preserved`);
      // Ciphertext-bound entry hash recomputed; plaintext-bound content_hash preserved.
      assert.equal(computeEntryHash(a, crypto), afterEntries[i].hash, `entry ${i} hash recomputed`);
      assert.equal(a.content_hash, b.content_hash, `entry ${i} content_hash preserved`);
    }
  });

  it('R4: the ledger re-key path is unchanged (blocks + tokens + cookie still re-keyed)', async () => {
    const store = freshStore();
    await buildLedgerFixture(store);
    await buildCommonplaceFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const ledgerBlocks = await store.get(BLOCKS_KEY);
    assert.equal(crypto.decrypt(ledgerBlocks[0].identity.recovery_seed_enc, newPdk), ALT_SEED, 'genesis seed under new PDK');
    assert.equal(crypto.decrypt(await store.get(PDK_TOKEN_KEY), newPdk), VERIFY_TOKEN, 'passphrase token under new PDK');
    const cookie = await store.get(COOKIE_KEY);
    assert.ok(cookie && cookie.device_specifier && cookie.device_specifier !== 'old-specifier-0000000000000000', 'device cookie rotated');
    assert.ok(verifyChain(crypto, ledgerBlocks, NEW_MK, IDENTITY_SECRET), 'ledger chain verifies under NEW MK');
  });

  it('R5: re-encrypts the Commonplace genesis recovery_seed_enc + identity_secret_enc_fallback', async () => {
    const store = freshStore();
    await buildLedgerFixture(store);
    await buildCommonplaceFixture(store);
    const beforeGenesis = (await store.get(COMMONPLACE_BLOCKS_KEY)).find((b) => b.type === 'commonplace_genesis');
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const genesis = (await store.get(COMMONPLACE_BLOCKS_KEY)).find((b) => b.type === 'commonplace_genesis');
    assert.notEqual(genesis.recovery_seed_enc, beforeGenesis.recovery_seed_enc, 'genesis seed envelope rewritten');
    assert.equal(crypto.decrypt(genesis.recovery_seed_enc, newPdk), ALT_SEED, 'genesis seed under new PDK');
    assert.notEqual(genesis.identity_secret_enc_fallback, beforeGenesis.identity_secret_enc_fallback, 'fallback re-encrypted');
    assert.equal(crypto.decrypt(genesis.identity_secret_enc_fallback, NEW_MK), IDENTITY_SECRET, 'identity secret preserved');
  });

  it('R6: a failed Commonplace re-encrypt aborts before any write (no partial re-key)', async () => {
    const store = freshStore();
    await buildLedgerFixture(store);
    await buildCommonplaceFixture(store);

    // Corrupt a Commonplace entry ciphertext so re-encryption (decrypt under
    // OLD MK) throws mid-loop.
    const cpBlocks = await store.get(COMMONPLACE_BLOCKS_KEY);
    const day = cpBlocks.find((b) => b.type === 'commonplace');
    day.entries[0].data.title_enc = 'DEADBEEF';
    await store.set(COMMONPLACE_BLOCKS_KEY, cpBlocks);

    const ledgerBefore = JSON.stringify(await store.get(BLOCKS_KEY));
    const cpBefore = JSON.stringify(await store.get(COMMONPLACE_BLOCKS_KEY));
    const rekey = makeRekey(store);

    await assert.rejects(rekey.rekey(REKEY_ARGS), 're-key must abort on a Commonplace re-encrypt failure');
    assert.equal(JSON.stringify(await store.get(BLOCKS_KEY)), ledgerBefore, 'ledger untouched on abort');
    assert.equal(JSON.stringify(await store.get(COMMONPLACE_BLOCKS_KEY)), cpBefore, 'commonplace untouched on abort');
  });

  it('R7: the RekeyResult surfaces how many Commonplace blocks/entries were re-encrypted', async () => {
    const store = freshStore();
    await buildLedgerFixture(store);
    await buildCommonplaceFixture(store);
    const rekey = makeRekey(store);

    const result = await rekey.rekey(REKEY_ARGS);

    assert.equal(result.commonplaceEntriesReencrypted, 2, 'two Commonplace entries re-encrypted');
    assert.ok(result.commonplaceBlocksReencrypted >= 2, 'genesis + day block re-encrypted');
  });
});
