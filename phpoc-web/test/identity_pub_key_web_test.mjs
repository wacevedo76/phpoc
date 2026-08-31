/**
 * identity_pub_key_web_test.mjs — C-2 raw-bytes parity, Phase 2 (RED) harness (Web side).
 *
 * Blueprint: docs/planning/C2_IDENTITY_PUB_KEY_RAW_BYTES_PHASE1.md
 *
 * Canonical (PHPSPEC §2.7.1): identity_pub_key = SHA-256(raw 32-byte
 * identity_secret). Web derives it today by hashing the hex *string*
 * (`CryptoService.sha256(identitySecret)`), producing a divergent value.
 * This harness asserts the Web WASM binding must expose `identityPubKey`
 * (raw-bytes) and that the genesis call site + committed fixtures use it.
 *
 *   - Group B (B1–B6): Web raw-bytes surface, genesis call site, fixtures.
 *   - Group D (D2, D5): cross-client fixed-vector parity + per-user PDK salt.
 *
 * Run: node --test test/identity_pub_key_web_test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';

import { MemoryBackend } from '../src/sync/storage.js';
import { LedgerChain } from '../src/ledger/chain.js';

import {
  SHARED, loadCrypto, buildGenesis, FIXTURE_PATH, WEB_REKEYED_PATH,
} from './c2_fixture_gen.mjs';

const { VALID_SEED, OLD_MK, OLD_PASSPHRASE, IDENTITY_SECRET } = SHARED;

// Fixed-answer vectors (byte-identical to the Flutter + Rust harnesses).
const CANONICAL = '9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885';
const DIVERGENT = '271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a';
// Per-user PDK salt = sha256(canonical_pubkey_hex)[:16] (cross-client stable).
const PDK_SALT = '2deeb62725ca597a';

let crypto;

before(async () => {
  crypto = await loadCrypto();
  // buildGenesisBlock signs the identity_seal via crypto.mac; the WASM wrapper
  // exposes the same HMAC-SHA256(secret, data) primitive as `sign`. Alias it
  // for the genesis path (test-only, additive).
  crypto.mac = (data, secret) => crypto.sign(data, secret);
});

function readArtifact(p) {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ═══════════════════════════════════════════════════════════════
// Group B — Web raw-bytes surface + call sites (B1–B6)
// ═══════════════════════════════════════════════════════════════
describe('Group B: identity_pub_key raw-bytes parity (Web)', () => {
  it('B1: crypto.identityPubKey(identitySecret) is the canonical raw-bytes SHA-256, not the string hash', () => {
    assert.equal(typeof crypto.identityPubKey, 'function', 'WASM binding identityPubKey must exist');
    assert.equal(crypto.identityPubKey(IDENTITY_SECRET), CANONICAL,
      'identityPubKey must hash the raw 32 secret bytes');
    assert.equal(crypto.sha256(IDENTITY_SECRET), DIVERGENT,
      'sha256(String) must still return the divergent hex-string hash (bug boundary)');
    assert.notEqual(crypto.identityPubKey(IDENTITY_SECRET), crypto.sha256(IDENTITY_SECRET),
      'raw-bytes identityPubKey must differ from the string hash');
  });

  it('B2: chain.js buildGenesisBlock sets identity_pub_key = identityPubKey(identitySecret)', async () => {
    const masterKey = crypto.deriveMasterKey(VALID_SEED);
    const store = new MemoryBackend();
    const chain = new LedgerChain(crypto, store, masterKey);
    const genesis = await chain.buildGenesisBlock({
      username: 'Raw Bytes User',
      email: 'raw@example.com',
      passphrase: OLD_PASSPHRASE,
      seed: VALID_SEED,
    });
    assert.ok(chain.identitySecret, 'identity secret must be stored on the chain');
    assert.equal(genesis.identity.identity_pub_key, crypto.identityPubKey(chain.identitySecret),
      'genesis identity_pub_key must be derived via the raw-bytes identityPubKey binding');
    assert.notEqual(genesis.identity.identity_pub_key, crypto.sha256(chain.identitySecret),
      'genesis identity_pub_key must NOT be the hex-string hash');
  });

  it('B3: crypto.identityPubKey rejects malformed hex input', () => {
    assert.equal(typeof crypto.identityPubKey, 'function', 'identityPubKey must exist before validation checks');
    assert.throws(() => crypto.identityPubKey('zz'.repeat(32)), Error, 'non-hex must throw');
    assert.throws(() => crypto.identityPubKey('abc'), Error, 'odd-length must throw');
    assert.throws(() => crypto.identityPubKey('ab'.repeat(31)), Error, '31-byte must throw');
    assert.throws(() => crypto.identityPubKey('ab'.repeat(33)), Error, '33-byte must throw');
  });

  it('B4: fixture builder buildGenesis uses identityPubKey (not sha256)', () => {
    const pdk = crypto.derivePdk(OLD_PASSPHRASE, 600000);
    const genesis = buildGenesis(crypto, OLD_MK, pdk, VALID_SEED, IDENTITY_SECRET);
    assert.equal(genesis.identity.identity_pub_key, crypto.identityPubKey(IDENTITY_SECRET),
      'fixture genesis identity_pub_key must be derived via identityPubKey');
    assert.notEqual(genesis.identity.identity_pub_key, crypto.sha256(IDENTITY_SECRET),
      'fixture genesis identity_pub_key must not be the string hash');
  });

  it('B5: committed cross-client fixture genesis carries the canonical pubkey', () => {
    const fixture = readArtifact(FIXTURE_PATH);
    assert.ok(fixture, 'fixture missing — run: node phpoc-web/test/c2_fixture_gen.mjs');
    const pub = fixture.blocks[0].identity.identity_pub_key;
    assert.equal(pub, CANONICAL,
      'committed fixture identity_pub_key must be the canonical raw-bytes value (regenerate in Phase 3)');
  });

  it('B6: re-keyed wire preserves the canonical identity_pub_key (key-independent)', () => {
    const artifact = readArtifact(WEB_REKEYED_PATH);
    assert.ok(artifact, 'web re-keyed wire absent — run c2_cross_client_verify.mjs Group A in Phase 3');
    const pub = artifact.blocks[0].identity.identity_pub_key;
    assert.equal(pub, CANONICAL, 're-key must preserve the canonical raw-bytes identity_pub_key');
  });
});

// ═══════════════════════════════════════════════════════════════
// Group D — cross-client raw-bytes parity extensions (web side)
// ═══════════════════════════════════════════════════════════════
describe('Group D: cross-client raw-bytes parity (Web side)', () => {
  it('D2: identityPubKey(identitySecret) equals the Flutter/Rust canonical fixed vector', () => {
    assert.equal(crypto.identityPubKey(IDENTITY_SECRET), CANONICAL,
      'web identityPubKey must equal the canonical vector asserted identically by Flutter + Rust');
  });

  it('D5: per-user PDK salt (sha256(pubkey)[:16]) is deterministic and cross-client stable', () => {
    const pub = crypto.identityPubKey(IDENTITY_SECRET);
    const salt = crypto.sha256(pub).slice(0, 16);
    assert.equal(salt, PDK_SALT,
      'salt must equal sha256(canonical_pubkey_hex)[:16] — identical on web + Flutter');
  });
});
