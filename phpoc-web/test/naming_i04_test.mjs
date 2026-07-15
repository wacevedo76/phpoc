/**
 * naming_i04_test.mjs — I-04 Phase 2 (RED): Naming convention tests (JS).
 *
 * Asserts the new HMAC naming convention (sign → mac, signature → identity_seal)
 * across crypto module, LedgerChain, and block format.
 *
 * These tests are intentionally RED — they assert the post-rename interface
 * that does not yet exist. They will turn GREEN in Phase 3 when the rename
 * is applied across all JS modules.
 *
 * Assertion IDs map to I-04:
 *   WA1–WA3: MockCrypto method names (mac / verifyMac)
 *   WB1–WB4: LedgerChain method names (computeIdentityMac / verifyIdentityMac)
 *   WC1–WC4: Block dict field names (identity_seal / not signature)
 *   WD1–WD3: DummyLedger method names
 *
 * Usage:
 *   node test/naming_i04_test.mjs
 */

import { createHash } from 'crypto';
import { MockCrypto } from './mock_crypto.mjs';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ── Dynamic imports (may fail if modules are renamed) ────────────────
let LedgerChain, DummyLedger;
try {
  const chainMod = await import('../src/ledger/chain.js');
  LedgerChain = chainMod.LedgerChain;
} catch (err) {
  LedgerChain = undefined;
}

try {
  const dummyMod = await import('../src/services/DummyLedger.js');
  DummyLedger = dummyMod.DummyCryptoService;
} catch (err) {
  DummyLedger = undefined;
}

// ── Setup ───────────────────────────────────────────────────────────
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const IDENTITY_SECRET = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';
const crypto = new MockCrypto();

// ── Group WA: MockCrypto method names ────────────────────────────────

console.log('\n### WA: MockCrypto naming');

// WA1: mac() exists
t.assert(
  typeof crypto.mac === 'function',
  'WA1: MockCrypto must have mac() method'
);

// WA2: verifyMac() exists
t.assert(
  typeof crypto.verifyMac === 'function',
  'WA2: MockCrypto must have verifyMac() method'
);

// WA3: Old names must NOT exist
t.assert(
  typeof crypto.sign !== 'function',
  'WA3: MockCrypto must NOT have sign() — rename to mac() is incomplete'
);
t.assert(
  typeof crypto.verifySignature !== 'function',
  'WA4: MockCrypto must NOT have verifySignature() — rename to verifyMac() is incomplete'
);

// WA5: mac() produces deterministic output
const macResult = crypto.mac('test_data', IDENTITY_SECRET);
t.assert(
  typeof macResult === 'string' && macResult.length === 64,
  'WA5: mac() must return 64-char hex string'
);

// WA6: mac/verifyMac round-trip
const macTag = crypto.mac('roundtrip_data', IDENTITY_SECRET);
t.assert(
  crypto.verifyMac('roundtrip_data', macTag, IDENTITY_SECRET) === true,
  'WA6: verifyMac must return true for valid MAC tag'
);
t.assert(
  crypto.verifyMac('tampered_data', macTag, IDENTITY_SECRET) === false,
  'WA7: verifyMac must return false for tampered data'
);


// ── Group WB: LedgerChain method names ───────────────────────────────

console.log('\n### WB: LedgerChain naming');

if (LedgerChain) {
  const store = new MemoryBackend();
  const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

  // WB1: computeIdentityMac exists
  t.assert(
    typeof chain.computeIdentityMac === 'function',
    'WB1: LedgerChain must have computeIdentityMac() method'
  );

  // WB2: verifyIdentityMac exists
  t.assert(
    typeof chain.verifyIdentityMac === 'function',
    'WB2: LedgerChain must have verifyIdentityMac() method'
  );

  // WB3: Old names absent
  t.assert(
    typeof chain.computeSignature !== 'function',
    'WB3: LedgerChain must NOT have computeSignature() — rename to computeIdentityMac()'
  );
  t.assert(
    typeof chain.verifySignature !== 'function',
    'WB4: LedgerChain must NOT have verifySignature() — rename to verifyIdentityMac()'
  );

  // WB5: computeIdentityMac produces a result
  const idMac = chain.computeIdentityMac('test_hash');
  t.assert(
    typeof idMac === 'string' && idMac.length > 0,
    'WB5: computeIdentityMac() must return a non-empty string'
  );

  // WB6: verifyIdentityMac validates correctly
  const mac = chain.computeIdentityMac('verify_test');
  t.assert(
    chain.verifyIdentityMac('verify_test', mac) === true,
    'WB6: verifyIdentityMac must return true for valid MAC'
  );
  t.assert(
    chain.verifyIdentityMac('wrong_data', mac) === false,
    'WB7: verifyIdentityMac must return false for wrong data'
  );
} else {
  t.assert(false, 'WB-skip: LedgerChain module could not be imported');
}


// ── Group WC: Block dict field naming ────────────────────────────────

console.log('\n### WC: Block field naming');

if (LedgerChain) {
  const store = new MemoryBackend();
  const chain = new LedgerChain(crypto, store, MASTER_KEY, IDENTITY_SECRET);

  // Build a genesis block first
  const genesis = await chain.buildGenesisBlock({
    username: 'Test User',
    email: 'test@example.com',
    passphrase: 'test-password',
    seed: Buffer.from('a'.repeat(32)).toString('base64'),
  });
  await chain.append(genesis);

  // Get prev_hash from genesis
  const lastBlock = await chain.getLastBlock();
  const prevHash = createHash('sha256')
    .update(JSON.stringify(lastBlock))
    .digest('hex');

  // Build a day block
  const entryData = {
    title: 'Test Activity',
    startTime_enc: crypto.encrypt('1717920000000', MASTER_KEY),
    endTime_enc: crypto.encrypt('1717923600000', MASTER_KEY),
    duration: 3600000,
    tags: ['test'],
    pauses_enc: crypto.encrypt('[]', MASTER_KEY),
    metadata_enc: crypto.encrypt('{}', MASTER_KEY),
    comment: '',
    media: [],
  };
  entryData.content_hash = crypto.sha256(
    JSON.stringify({
      title: entryData.title,
      startTime_enc: crypto.decrypt(entryData.startTime_enc, MASTER_KEY),
      endTime_enc: crypto.decrypt(entryData.endTime_enc, MASTER_KEY),
      duration: entryData.duration,
      tags: entryData.tags,
      pauses_enc: crypto.decrypt(entryData.pauses_enc, MASTER_KEY),
      metadata_enc: crypto.decrypt(entryData.metadata_enc, MASTER_KEY),
      comment: entryData.comment,
      media: entryData.media,
    }, null, 2)
  );

  const dayBlock = await chain.buildDayBlock([entryData], prevHash, '2026-07-15');

  // WC1: Block must use identity_seal, NOT signature
  t.assert(
    'identity_seal' in dayBlock,
    'WC1: Day block must contain identity_seal field'
  );
  t.assert(
    !('signature' in dayBlock),
    'WC2: Day block must NOT contain signature field (use identity_seal)'
  );

  // WC3: Block seal check uses identity_seal
  const checkKeys = Object.keys(dayBlock);
  const hasIdentitySeal = checkKeys.includes('identity_seal');
  const hasSignature = checkKeys.includes('signature');
  t.assert(
    hasIdentitySeal && !hasSignature,
    'WC3: Block keys must use identity_seal not signature'
  );

  // WC4: Without identity_secret, no identity_seal
  const store2 = new MemoryBackend();
  const chainNoSecret = new LedgerChain(crypto, store2, MASTER_KEY, null);
  const entryData2 = {
    title: 'No Identity',
    startTime_enc: '',
    endTime_enc: '',
    duration: 0,
    tags: [],
    pauses_enc: '',
    metadata_enc: '',
    comment: '',
    media: [],
  };
  entryData2.content_hash = crypto.sha256(JSON.stringify({
    title: entryData2.title,
    startTime_enc: '',
    endTime_enc: '',
    duration: 0,
    tags: [],
    pauses_enc: '',
    metadata_enc: '',
    comment: '',
    media: '',
  }, null, 2));

  const blockNoSecret = await chainNoSecret.buildDayBlock(
    [{ hash: crypto.sha256(JSON.stringify(entryData2)), data: entryData2 }],
    '0'.repeat(64),
    '2026-07-15'
  );
  t.assert(
    !('identity_seal' in blockNoSecret),
    'WC4: Block without identity_secret must not have identity_seal'
  );
} else {
  t.assert(false, 'WC-skip: LedgerChain module could not be imported');
}


// ── Group WD: DummyLedger naming ─────────────────────────────────────

console.log('\n### WD: DummyLedger naming');

if (DummyLedger) {
  const dummy = new DummyLedger();

  t.assert(
    typeof dummy.mac === 'function',
    'WD1: DummyLedger must have mac() method'
  );
  t.assert(
    typeof dummy.verifyMac === 'function',
    'WD2: DummyLedger must have verifyMac() method'
  );
  t.assert(
    typeof dummy.sign !== 'function',
    'WD3: DummyLedger must NOT have sign() — rename to mac()'
  );
  t.assert(
    typeof dummy.verifySignature !== 'function',
    'WD4: DummyLedger must NOT have verifySignature() — rename to verifyMac()'
  );
} else {
  t.assert(false, 'WD-skip: DummyLedger module could not be imported');
}


// ── Summary ──────────────────────────────────────────────────────────

const failed = t.summary('I-04 Naming (Phase 2 RED)');
process.exitCode = failed > 0 ? 1 : 0;
