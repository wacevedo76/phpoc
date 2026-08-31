/**
 * c2_fixture_gen.mjs — C-2 Cross-Client Verification (Phase D), Phase 2 harness.
 *
 * Shared canonical fixture generator + the single source of the cross-client
 * constants. Both the Web probe (`c2_cross_client_verify.mjs`, node --test)
 * and the Flutter probe (`c2_cross_client_verify_test.dart`, flutter test)
 * import/read the SAME committed fixture (`testdata/c2_cross_client_fixture.json`)
 * so every cross-client comparison is against one byte-stable chain.
 *
 * The fixture is a canonical 0.4.0+ PHPSPEC wire chain (web-shaped): a nested
 * `identity.{recovery_seed_enc, identity_pub_key, identity_secret_enc_fallback}`
 * genesis + 2 day blocks, each entry carrying a plaintext `title`, ciphertext
 * `startTime_enc`/`endTime_enc`, a plaintext `duration`, and a plaintext-bound
 * `content_hash`. All blocks are sealed under OLD_MK via the ADR-029/029a
 * closed whitelist (`computeSeal`) and identity-signed with the shared
 * IDENTITY_SECRET.
 *
 * Run as a CLI to (re)generate the committed fixture:
 *   node test/c2_fixture_gen.mjs [--out testdata/c2_cross_client_fixture.json]
 *
 * NOTE: `crypto.encrypt` uses a random salt+nonce, so ciphertext bytes are not
 * reproducible across runs. The fixture is generated once and committed; the
 * probes read the committed file, never regenerate it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { computeSeal } from '../src/ledger/seal_fields.js';
import { computeEntryHash, jsonSort } from '../src/ledger/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Shared cross-client constants (non-secret dummy fixtures) ─────────────
// Must be byte-identical to the Flutter harness's constants (see
// c2_cross_client_verify_test.dart) and the re-key test suites.
export const SHARED = {
  VALID_SEED: 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=', // 32×0x42
  ALT_SEED: 'ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE=', // 32×0x21
  OLD_MK: '42'.repeat(32),
  NEW_MK: '21'.repeat(32),
  OLD_PASSPHRASE: 'CorrectHorseBatteryStaple42!',
  NEW_PASSPHRASE: 'NewCorrectHorseBatteryStaple99!',
  PBKDF2_ITERATIONS: 600000,
  IDENTITY_SECRET: 'ab'.repeat(32), // device-scoped, unchanged by re-key
  FORMAT_VERSION: '0.4.0',
};

const {
  VALID_SEED, ALT_SEED, OLD_MK, NEW_MK,
  OLD_PASSPHRASE, NEW_PASSPHRASE, PBKDF2_ITERATIONS,
  IDENTITY_SECRET, FORMAT_VERSION,
} = SHARED;

// Default artifact paths (relative to the repo root, i.e. ../../ from this file).
export const REPO_TESTDATA = path.resolve(__dirname, '../../testdata');
export const FIXTURE_PATH = path.join(REPO_TESTDATA, 'c2_cross_client_fixture.json');
export const WEB_REKEYED_PATH = path.join(REPO_TESTDATA, 'c2_web_rekeyed_wire.json');
export const FLUTTER_REKEYED_PATH = path.join(REPO_TESTDATA, 'c2_flutter_rekeyed_wire.json');

/** Load the real WASM CryptoService (node path — no fetch). */
export async function loadCrypto() {
  const { CryptoService } = await import('../src/crypto/index.js');
  const wasmBytes = readFileSync(
    path.join(__dirname, '../src/crypto/wasm/phpoc_crypto_core_bg.wasm'),
  );
  return CryptoService.create({ wasmModule: wasmBytes });
}

/** Compute the web `content_hash`: SHA-256 over the PLAINTEXT (decrypted) entry. */
export function computeContentHash(c, mk, data) {
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

/** Build one entry (title plaintext, timestamps ciphertext, content_hash). */
export function buildEntry(c, mk, { title, startEpoch, duration }) {
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

/** Build the canonical (web-shaped, nested identity) genesis block. */
export function buildGenesis(c, mk, pdk, seed, identitySecret) {
  const genesis = {
    type: 'genesis',
    day_index: 0,
    date: '2026-01-01',
    format_version: FORMAT_VERSION,
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

/** Build a day block sealed under `mk`, linked to `prevHash`. */
export function buildDayBlock(c, mk, identitySecret, prevHash, entries, dayIndex, date) {
  const day = {
    type: 'day',
    day_index: dayIndex,
    date,
    format_version: FORMAT_VERSION,
    prev_hash: prevHash,
    entries,
  };
  day.day_hash = computeSeal(day, c, mk);
  day.identity_seal = c.sign(day.day_hash, identitySecret);
  return day;
}

/** Build the full fixture chain (genesis + 2 day blocks, sealed under OLD_MK). */
export function buildFixtureChain(c, oldPdk) {
  const mk = SHARED.OLD_MK;
  const entries1 = [
    buildEntry(c, mk, { title: 'Alpha task', startEpoch: 1767225600, duration: 3600 }),
    buildEntry(c, mk, { title: 'Beta task', startEpoch: 1767312000, duration: 1800 }),
  ];
  const entries2 = [
    buildEntry(c, mk, { title: 'Gamma task', startEpoch: 1767398400, duration: 5400 }),
    buildEntry(c, mk, { title: 'Delta task', startEpoch: 1767484800, duration: 7200 }),
  ];
  const genesis = buildGenesis(c, mk, oldPdk, SHARED.VALID_SEED, IDENTITY_SECRET);
  const day1 = buildDayBlock(c, mk, IDENTITY_SECRET, genesis.block_hash, entries1, 1, '2026-01-02');
  const day2 = buildDayBlock(c, mk, IDENTITY_SECRET, day1.day_hash, entries2, 2, '2026-01-03');
  return [genesis, day1, day2];
}

/** Assemble the fixture envelope (constants + blocks) for the committed file. */
export function fixtureEnvelope(blocks) {
  return {
    version: 1,
    generator: 'web',
    note: 'Canonical 0.4.0+ PHPSPEC wire chain (web-shaped, nested identity). Generated once; ciphertext is non-reproducible (random salt/nonce).',
    old_seed: VALID_SEED,
    old_mk: OLD_MK,
    old_passphrase: OLD_PASSPHRASE,
    identity_secret: IDENTITY_SECRET,
    new_seed: ALT_SEED,
    new_mk: NEW_MK,
    new_passphrase: NEW_PASSPHRASE,
    pdk_iterations: PBKDF2_ITERATIONS,
    format_version: FORMAT_VERSION,
    blocks,
  };
}

// ── CLI: generate + write the committed fixture ───────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : FIXTURE_PATH;

  const crypto = await loadCrypto();
  const oldPdk = crypto.derivePdk(OLD_PASSPHRASE, PBKDF2_ITERATIONS);
  const blocks = buildFixtureChain(crypto, oldPdk);
  const envelope = fixtureEnvelope(blocks);

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`wrote fixture: ${outPath} (${blocks.length} blocks)`);
}

// Run only when invoked directly (node test/c2_fixture_gen.mjs), not on import.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}


