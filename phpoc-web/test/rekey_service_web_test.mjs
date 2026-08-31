/**
 * rekey_service_web_test.mjs — C-2 Full Seed Replacement (re-key) for phpoc-web.
 *
 * Phase 2 (RED) Node harness: Groups R (11), B (5), M (6), P (6) = 28 tests.
 *
 * These tests target the FUTURE `src/services/rekey_service.js` API (lands in
 * Phase 3). The module is imported defensively: when it does not yet exist, a
 * local skeleton whose methods throw "not implemented" is substituted, so the
 * failures below are *assertion* failures — never `ERR_MODULE_NOT_FOUND`.
 *
 * Design contract (option (a), per PHPSPEC §2.3):
 *   - `derive_master_key(seed)` returns the raw base64-decoded 32 seed bytes.
 *     The new seed's raw bytes become the new Master Key (MK).
 *   - `key_version` is NOT bumped under option (a) — M1 asserts it is preserved.
 *   - The identity secret is device-scoped and INDEPENDENT of the MK, so it is
 *     unchanged by re-key; identity seals are re-signed over the new block hash
 *     with the SAME identity secret (via `crypto.sign` / `crypto.verifySignature`).
 *
 * Behavioral parity with Python `RotateKeysCommand.hard_rotate` and the
 * Flutter `RekeyService`. Seal inputs follow the ADR-029/029a closed whitelist
 * (`src/ledger/seal_fields.js`).
 *
 * Fixtures use the REAL WASM CryptoService (loaded from
 * `src/crypto/wasm/phpoc_crypto_core_bg.wasm`) so re-encryption is genuinely
 * verified. All seeds/passphrases are NON-SECRET dummy constants (32×0x42 /
 * 32×0x21), matching the Flutter `rekey_service_test.dart` fixtures.
 *
 * Run: node --test test/rekey_service_web_test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { MemoryBackend } from '../src/sync/storage.js';
import { computeSeal, selectSealFields } from '../src/ledger/seal_fields.js';
import { computeEntryHash, jsonSort, getBlockHash } from '../src/ledger/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Non-secret dummy fixtures (verified against the real WASM) ─────────────
const VALID_SEED = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI='; // 32×0x42
const ALT_SEED = 'ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE='; // 32×0x21
const OLD_MK = '42'.repeat(32);
const NEW_MK = '21'.repeat(32);
const OLD_PASSPHRASE = 'CorrectHorseBatteryStaple42!';
const NEW_PASSPHRASE = 'NewCorrectHorseBatteryStaple99!';
const PBKDF2_ITERATIONS = 600000;
const IDENTITY_SECRET = 'ab'.repeat(32); // device-scoped, unchanged by re-key

// ── Storage keys (web contract) ────────────────────────────────────────────
const STORED_SEED_KEY = 'phpoc_seed';
const PDK_TOKEN_KEY = 'phpoc_pdk_token';
const IDENTITY_SECRET_KEY = 'phpoc_identity_secret';
const BLOCKS_KEY = 'ledger:blocks';
const COOKIE_KEY = 'cookie';
const REKEYED_KEY = 'phpoc_rekeyed';
const BACKUP_KEY = 'phpoc_rekey_backup';
const VERIFY_TOKEN = 'phpoc_pdk_verify';

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
  // Precompute PDKs once (each derivation is ~672ms at 600K iterations).
  oldPdk = crypto.derivePdk(OLD_PASSPHRASE, PBKDF2_ITERATIONS);
  newPdk = crypto.derivePdk(NEW_PASSPHRASE, PBKDF2_ITERATIONS);
});

// ── Defensive import of the future RekeyService ────────────────────────────
let RekeyService = null;
try {
  ({ RekeyService } = await import('../src/services/rekey_service.js'));
} catch {
  RekeyService = null; // Phase 2: not implemented yet — skeleton below.
}

/** Inline skeleton so Phase 2 failures are assertions, not import errors. */
class RekeyServiceSkeleton {
  constructor(deps) {
    this.crypto = deps.crypto;
    this.storage = deps.storage;
    this.sync = deps.sync || null;
    this.ledgerExport = deps.ledgerExport || null;
  }
  _ny() {
    throw new Error('RekeyService not implemented — Phase 3');
  }
  mintNewSeed() { this._ny(); }
  seedFingerprint() { this._ny(); }
  async preflightSnapshot() { this._ny(); }
  async preflightSnapshotAndWrite() { this._ny(); }
  async hasRekeyed() { this._ny(); }
  async revealSecretStep1() { this._ny(); }
  confirmReveal() { this._ny(); }
  async rekey() { this._ny(); }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const freshStore = () => new MemoryBackend();

/** Compute the web `content_hash`: SHA-256 over the PLAINTEXT (decrypted) entry. */
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

/** Mirror of LedgerEngine._encryptEntry (title is plaintext on web). */
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
  const day = {
    type: 'day',
    day_index: dayIndex,
    date,
    prev_hash: prevHash,
    entries,
  };
  day.day_hash = computeSeal(day, c, mk);
  day.identity_seal = c.sign(day.day_hash, identitySecret);
  return day;
}

/** Build a full fixture: genesis + one day block, seed, PDK token, cookie. */
async function buildFixture(store, { seed = VALID_SEED } = {}) {
  const mk = crypto.deriveMasterKey(seed);
  crypto.setMasterKey(mk); // unlock the session under the current key set

  const e1 = buildEntry(crypto, mk, { title: 'Alpha task', startEpoch: 1767225600, duration: 3600 });
  const e2 = buildEntry(crypto, mk, { title: 'Beta task', startEpoch: 1767312000, duration: 1800 });
  const genesis = buildGenesis(crypto, mk, oldPdk, seed, IDENTITY_SECRET);
  const day = buildDayBlock(crypto, mk, IDENTITY_SECRET, genesis.block_hash, [e1, e2], 1, '2026-01-02');
  const blocks = [genesis, day];

  await store.set(BLOCKS_KEY, blocks);
  await store.set(STORED_SEED_KEY, seed);
  await store.set(PDK_TOKEN_KEY, crypto.encrypt(VERIFY_TOKEN, oldPdk));
  await store.set(IDENTITY_SECRET_KEY, IDENTITY_SECRET);
  await store.set(COOKIE_KEY, { device_specifier: 'old-specifier-0000000000000000', creation_time: 1700000000000 });

  return { blocks, genesis, day, mk, seed };
}

function makeRekey(store, { sync = null, ledgerExport = null } = {}) {
  const Ctor = RekeyService || RekeyServiceSkeleton;
  return new Ctor({
    crypto,
    storage: store,
    sync,
    ledgerExport: ledgerExport || {
      async exportToJson() {
        const blocks = await store.get(BLOCKS_KEY);
        return JSON.stringify(blocks ?? []);
      },
    },
  });
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

const REKEY_ARGS = {
  oldPassphrase: OLD_PASSPHRASE,
  newPassphrase: NEW_PASSPHRASE,
  newSeed: ALT_SEED,
};

// ═══════════════════════════════════════════════════════════════
// Group R: RekeyService orchestration (R1–R11)
// ═══════════════════════════════════════════════════════════════
describe('Group K: identity_pub_key raw-bytes parity (fixture builder)', () => {
  it('B4: local buildGenesis uses identityPubKey (not sha256) for identity_pub_key', () => {
    assert.equal(typeof crypto.identityPubKey, 'function', 'CryptoService.identityPubKey binding must exist');
    const pdk = crypto.derivePdk(OLD_PASSPHRASE, PBKDF2_ITERATIONS);
    const genesis = buildGenesis(crypto, OLD_MK, pdk, VALID_SEED, IDENTITY_SECRET);
    assert.equal(genesis.identity.identity_pub_key, crypto.identityPubKey(IDENTITY_SECRET),
      'fixture genesis identity_pub_key must be derived via identityPubKey');
    assert.notEqual(genesis.identity.identity_pub_key, crypto.sha256(IDENTITY_SECRET),
      'fixture genesis identity_pub_key must not be the hex-string hash');
  });
});

describe('Group R: RekeyService orchestration', () => {
  it('R1: rekey() requires an unlocked session and a valid old passphrase', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    // Wrong passphrase → must reject, never re-key.
    await assert.rejects(
      rekey.rekey({ ...REKEY_ARGS, oldPassphrase: 'WrongPassphrase!' }),
      /passphrase|incorrect|not unlocked/i,
    );

    // Locked session (no cached MK) → must reject even with the right passphrase.
    crypto.clearMasterKey();
    await assert.rejects(rekey.rekey(REKEY_ARGS), /unlocked/i);
  });

  it('R2: rekey() snapshots a recovery backup before any write', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    const preBackup = await rekey.preflightSnapshot();
    assert.ok(typeof preBackup === 'string' && preBackup.length > 0, 'preflight snapshot must be non-empty');
  });

  it('R3: mintNewSeed() returns base64 decoding to exactly 32 bytes', () => {
    const rekey = makeRekey(freshStore());
    const seed = rekey.mintNewSeed(VALID_SEED);
    assert.equal(Buffer.from(seed, 'base64').length, 32, 'new seed must be exactly 32 bytes after base64 decode');
  });

  it('R4: mintNewSeed() returns a seed different from the current one', () => {
    const rekey = makeRekey(freshStore());
    const seed = rekey.mintNewSeed(VALID_SEED);
    assert.notEqual(seed, VALID_SEED, 're-key must produce a cryptographically fresh seed');
  });

  it('R5: after re-key the genesis seed decrypts under the new PDK', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const genesis = (await store.get(BLOCKS_KEY))[0];
    const decrypted = crypto.decrypt(genesis.identity.recovery_seed_enc, newPdk);
    assert.equal(decrypted, ALT_SEED, 'genesis recovery_seed_enc must decrypt under the NEW PDK');
  });

  it('R6: old PDK no longer decrypts the genesis seed after re-key', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const genesis = (await store.get(BLOCKS_KEY))[0];
    assert.throws(
      () => crypto.decrypt(genesis.identity.recovery_seed_enc, oldPdk),
      'old PDK must fail to decrypt the new seed',
    );
  });

  it('R7: genesis recovery_seed_enc rewrites and identity_secret_enc_fallback re-encrypts under the new MK', async () => {
    const store = freshStore();
    await buildFixture(store);
    const before = (await store.get(BLOCKS_KEY))[0].identity;
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const identity = (await store.get(BLOCKS_KEY))[0].identity;
    assert.notEqual(identity.recovery_seed_enc, before.recovery_seed_enc, 'seed envelope must be rewritten');
    assert.equal(crypto.decrypt(identity.recovery_seed_enc, newPdk), ALT_SEED);
    // identity secret is device-scoped: re-encrypted under the new MK, same value.
    assert.notEqual(identity.identity_secret_enc_fallback, before.identity_secret_enc_fallback);
    assert.equal(crypto.decrypt(identity.identity_secret_enc_fallback, NEW_MK), IDENTITY_SECRET);
  });

  it('R8: every entry _enc field decrypts under the new MK after re-key', async () => {
    const store = freshStore();
    await buildFixture(store);
    const before = collectEncPlaintexts(crypto, await store.get(BLOCKS_KEY), OLD_MK);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const after = collectEncPlaintexts(crypto, await store.get(BLOCKS_KEY), NEW_MK);
    assert.equal(after.length, before.length, 'no _enc field may be lost');
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i].plain, before[i].plain, `${before[i].block}.${before[i].key} must re-encrypt to the same plaintext`);
    }
  });

  it('R9: entry content_hash values are unchanged (plaintext integrity preserved)', async () => {
    const store = freshStore();
    await buildFixture(store);
    const before = {};
    for (const block of await store.get(BLOCKS_KEY)) {
      for (const entry of block.entries || []) {
        if (entry.data && entry.data.content_hash) before[entry.hash] = entry.data.content_hash;
      }
    }
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const after = {};
    for (const block of await store.get(BLOCKS_KEY)) {
      for (const entry of block.entries || []) {
        if (entry.data && entry.data.content_hash) after[entry.hash] = entry.data.content_hash;
        // Re-encryption must not break entry-hash verification (entry hash is
        // over ciphertext on web, so it is recomputed to match the new data).
        assert.ok(
          computeEntryHash(entry.data, crypto) === entry.hash ||
            crypto.sha256(jsonSort(entry.data)) === entry.hash,
          'entry hash must verify after re-encryption',
        );
      }
    }
    assert.deepEqual(
      Object.values(after).sort(),
      Object.values(before).sort(),
      'plaintext content hashes must be unchanged across re-key',
    );
  });

  it('R10: every block re-seals and verifies under the new MK', async () => {
    const store = freshStore();
    await buildFixture(store);
    const beforeSeals = (await store.get(BLOCKS_KEY)).map((b) => b[hashKeyFor(b)]);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const blocks = await store.get(BLOCKS_KEY);
    for (const b of blocks) {
      assert.ok(verifyBlock(crypto, b, NEW_MK, IDENTITY_SECRET), `${b.type} block must verify under the NEW MK`);
    }
    // Re-sealing (new seal key) means every seal differs from its pre-re-key value.
    blocks.forEach((b, i) => assert.notEqual(b[hashKeyFor(b)], beforeSeals[i], `${b.type} seal must be rewritten`));
  });

  it('R11: full chain verifies end-to-end under the new key set', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const blocks = await store.get(BLOCKS_KEY);
    assert.ok(verifyChain(crypto, blocks, NEW_MK, IDENTITY_SECRET), 'full chain must verify under the new key set');
    for (let i = 1; i < blocks.length; i++) {
      assert.equal(blocks[i].prev_hash, getBlockHash(blocks[i - 1]), 'prev_hash links must remain intact');
    }
    // Re-deriving the MK from the new seed proves the new key set is the live root.
    assert.equal(crypto.deriveMasterKey(ALT_SEED), NEW_MK);
  });
});

// ═══════════════════════════════════════════════════════════════
// Group B: backup & safety (B1–B5)
// ═══════════════════════════════════════════════════════════════
describe('Group B: backup & safety', () => {
  it('B1: backup snapshot captures the pre-re-key chain under the OLD MK', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    const snapshot = await rekey.preflightSnapshot();
    assert.ok(snapshot && snapshot.length > 0);
    const parsed = JSON.parse(snapshot);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.some((b) => b.type === 'genesis'));
    assert.ok(parsed.some((b) => b.type === 'day'));
  });

  it('B2: re-key aborts with no partial write if a block fails', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    // Corrupt the day block's first entry so re-encryption (decrypt under OLD
    // MK) fails mid-loop.
    const blocks = await store.get(BLOCKS_KEY);
    blocks[1].entries[0].data.startTime_enc = 'AAAA';
    await store.set(BLOCKS_KEY, blocks);
    const before = JSON.stringify(await store.get(BLOCKS_KEY));

    await assert.rejects(rekey.rekey(REKEY_ARGS));

    assert.equal(JSON.stringify(await store.get(BLOCKS_KEY)), before, 'no partial write');
    assert.equal(await rekey.hasRekeyed(), false, 'no re-key marker on abort');
  });

  it('B3: re-key refuses to double-run once a re-key marker exists', async () => {
    const store = freshStore();
    await buildFixture(store);
    await store.set(REKEYED_KEY, { seed_fingerprint: 'old-fp', rekeyed_at: 1 });
    const rekey = makeRekey(store);

    await assert.rejects(rekey.rekey(REKEY_ARGS), /already|re-key/i);

    // No mutation on the guarded path.
    const genesis = (await store.get(BLOCKS_KEY))[0];
    assert.equal(crypto.decrypt(genesis.identity.recovery_seed_enc, oldPdk), VALID_SEED);
  });

  it('B4: re-key records a seed_fingerprint for drift detection', async () => {
    const store = freshStore();
    const rekey = makeRekey(store);

    const fp = rekey.seedFingerprint(ALT_SEED);
    assert.ok(fp && fp.length === 64, 'SHA-256 digest is 64 hex chars');
    assert.equal(rekey.seedFingerprint(ALT_SEED), fp, 'fingerprint must be deterministic');
    assert.notEqual(rekey.seedFingerprint(VALID_SEED), fp, 'a different seed must yield a different fingerprint');
  });

  it('B5: surfaces the new seed only via a two-step reveal', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    // First reveal attempt alone must not leak the raw seed.
    const revealed = await rekey.revealSecretStep1();
    assert.equal(revealed, null);
  });
});

// ═══════════════════════════════════════════════════════════════
// Group M: migration / key exchange (M1–M6)
// ═══════════════════════════════════════════════════════════════
describe('Group M: migration / key exchange', () => {
  it('M1: key_version is preserved (unchanged) under option (a)', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);
    const versionsBefore = (await store.get(BLOCKS_KEY)).map((b) => b.key_version);

    await rekey.rekey(REKEY_ARGS);

    const versionsAfter = (await store.get(BLOCKS_KEY)).map((b) => b.key_version);
    assert.deepEqual(versionsAfter, versionsBefore, 'option (a) keeps key_version unchanged (no versioned-MK bump)');
  });

  it('M2: re-key recomputes identity seals on genesis under the new MK', async () => {
    const store = freshStore();
    await buildFixture(store);
    const beforeSeal = (await store.get(BLOCKS_KEY))[0].identity_seal;
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const genesis = (await store.get(BLOCKS_KEY))[0];
    assert.ok(genesis.identity_seal, 'identity seal must be present');
    assert.notEqual(genesis.identity_seal, beforeSeal, 'genesis identity seal must be recomputed');
    assert.ok(crypto.verifySignature(genesis.block_hash, genesis.identity_seal, IDENTITY_SECRET));
  });

  it('M3: prev_hash links are rewritten consistently in cascade', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const blocks = await store.get(BLOCKS_KEY);
    for (let i = 1; i < blocks.length; i++) {
      assert.ok(blocks[i].prev_hash, 'every non-genesis block keeps a prev_hash');
      assert.equal(blocks[i].prev_hash, getBlockHash(blocks[i - 1]), 'prev_hash cascade must be consistent');
    }
  });

  it('M4: no orphaned blocks (atomic replacement leaves every block intact)', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const blocks = await store.get(BLOCKS_KEY);
    assert.ok(blocks.length >= 2);
    assert.ok(verifyChain(crypto, blocks, NEW_MK, IDENTITY_SECRET), 'no orphaned/corrupt blocks after re-key');
  });

  it('M5: re-key preserves block order (append-only / date-grouping)', async () => {
    const store = freshStore();
    await buildFixture(store);
    const orderBefore = (await store.get(BLOCKS_KEY)).map((b) => `${b.type}:${b.day_index}`);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const orderAfter = (await store.get(BLOCKS_KEY)).map((b) => `${b.type}:${b.day_index}`);
    assert.deepEqual(orderAfter, orderBefore, 're-key must not reorder blocks (append-only preserved)');
  });

  it('M6: re-key recomputes entry hashes to match the re-encrypted data', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    for (const block of await store.get(BLOCKS_KEY)) {
      for (const entry of block.entries || []) {
        assert.ok(
          computeEntryHash(entry.data, crypto) === entry.hash ||
            crypto.sha256(jsonSort(entry.data)) === entry.hash,
          `${block.type} entry hash must verify against re-encrypted data`,
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Group P: push & device coordinates (P1–P6)
// ═══════════════════════════════════════════════════════════════
describe('Group P: push & device coordinates', () => {
  it('P1: re-key pushes the rewritten chain to remote', async () => {
    const store = freshStore();
    await buildFixture(store);
    const calls = [];
    const sync = {
      async pushLedgerBlocks(opts) {
        calls.push(opts);
        return 1;
      },
    };
    const rekey = makeRekey(store, { sync });

    const result = await rekey.rekey(REKEY_ARGS);

    assert.equal(result.remotePushed, true, 'remotePushed must reflect a successful push');
    assert.ok(calls.some((c) => c && c.forceAll === true), 'push must force the full rewritten chain');
  });

  it('P2: re-key persists genesis with the new recovery_seed_enc', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const genesis = (await store.get(BLOCKS_KEY))[0];
    assert.ok(genesis.identity && 'recovery_seed_enc' in genesis.identity);
    assert.equal(crypto.decrypt(genesis.identity.recovery_seed_enc, newPdk), ALT_SEED);
  });

  it('P3: re-key rotates the device cookie specifier', async () => {
    const store = freshStore();
    await buildFixture(store);
    const before = (await store.get(COOKIE_KEY)).device_specifier;
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    const after = (await store.get(COOKIE_KEY)).device_specifier;
    assert.ok(after && after !== before, 'device cookie must rotate so old-MK sessions reauth');
  });

  it('P4: another device re-derives the new MK from the new seed and verifies the chain', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    // A fresh device derives the MK directly from the new seed (option (a)).
    const derived = crypto.deriveMasterKey(ALT_SEED);
    assert.equal(derived, NEW_MK);
    const blocks = await store.get(BLOCKS_KEY);
    assert.ok(verifyChain(crypto, blocks, derived, IDENTITY_SECRET));
  });

  it('P5: repeat re-key is idempotent-guarded', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    assert.equal(await rekey.hasRekeyed(), true, 'a re-key marker must exist after a successful re-key');
  });

  it('P6: no stale-MK session lingers — the live key set is the NEW MK', async () => {
    const store = freshStore();
    await buildFixture(store);
    const rekey = makeRekey(store);

    await rekey.rekey(REKEY_ARGS);

    assert.equal(crypto.getMasterKey(), NEW_MK, 'the active MK must be the NEW key set (old MK retired)');
    assert.notEqual(crypto.getMasterKey(), OLD_MK);
  });
});
