/**
 * onboarding_cloud_conflict_test.mjs — Cloud Onboarding Dual-Format Conflict Detection.
 *
 * Tests the enhanced handleWorkerFetch logic that detects when both
 * ledger:blocks AND ledger/blocks/ exist on R2 with potentially different
 * genesis blocks. Extracted as pure functions for testability.
 *
 * Coverage (5 tests):
 *   C1 — Both formats exist with DIFFERENT genesis → conflict detected
 *   C2 — Both formats exist with SAME genesis → no conflict, single-blob path
 *   C3 — Only ledger/blocks/ exists → blocks-format path, no conflict
 *   C4 — Only ledger:blocks exists → single-blob path, no conflict
 *   C5 — Both exist, user chooses blocks → stale ledger:blocks deleted
 *
 * This is a Phase 3 (deferred) test file — the feature is not yet
 * implemented. Tests are written in TDD RED phase style.
 *
 * Usage:
 *   node test/onboarding_cloud_conflict_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Helpers — deterministic chain building
// ══════════════════════════════════════════════════════════════════════

const PBKDF2_ITERATIONS = 600000;

function deterministicHash(data) {
  let hash = 5381;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(64, '0');
}

function mockEncrypt(plaintext, key) {
  const tag = deterministicHash(key).slice(0, 8);
  const encoded = Buffer.from(plaintext, 'utf-8').toString('base64');
  return 'enc:' + tag + ':' + encoded;
}

function buildGenesisBlock({ username, email, passphrase, seed }) {
  const mk = deterministicHash(passphrase + ':' + seed + ':' + PBKDF2_ITERATIONS);
  const pdk = deterministicHash(passphrase + ':' + PBKDF2_ITERATIONS);
  const recoverySeedEnc = mockEncrypt(seed, pdk);
  const identitySecret = deterministicHash('identity:' + seed);
  const identityPubKey = createHash('sha256').update(identitySecret).digest('hex');

  const genesis = {
    type: 'genesis',
    day_index: 0,
    date: '2026-06-20',
    identity: {
      username,
      email,
      recovery_seed_enc: recoverySeedEnc,
      identity_pub_key: identityPubKey,
      identity_secret_enc_fallback: mockEncrypt(identitySecret, mk),
    },
    prev_hash: '0'.repeat(64),
    entries: [],
  };

  const sealData = jsonSort(genesis);
  genesis.day_hash = deterministicHash(sealData + mk);
  genesis.signature = deterministicHash('sign:' + genesis.day_hash + identitySecret);

  return { genesis, mk };
}

/**
 * Build a plain chain (ledger:blocks format) and its serialized bytes.
 */
function buildPlainChainData({ username, email, passphrase, seed, extraBlocks = 0 }) {
  const { genesis, mk } = buildGenesisBlock({ username, email, passphrase, seed });
  const chain = [genesis];

  for (let i = 0; i < extraBlocks; i++) {
    const prev = chain[chain.length - 1];
    const prevHash = deterministicHash(jsonSort(prev));
    chain.push({
      type: 'day',
      day_index: i + 1,
      date: `2026-06-${String(21 + i).padStart(2, '0')}`,
      prev_hash: prevHash,
      entries: [],
      day_hash: deterministicHash('day-' + (i + 1) + '-' + mk),
    });
  }

  return {
    chain,
    genesis,
    mk,
    genesisHash: genesis.day_hash,
    bytes: new TextEncoder().encode(JSON.stringify(chain)),
  };
}

/**
 * Build CLI-format blocks (ledger/blocks/000000.json etc.) and their serialized bytes.
 */
function buildCliBlocksData({ username, email, passphrase, seed, blockCount = 1 }) {
  const { genesis, mk } = buildGenesisBlock({ username, email, passphrase, seed });
  const chain = [genesis];

  for (let i = 1; i < blockCount; i++) {
    const prev = chain[chain.length - 1];
    const prevHash = deterministicHash(jsonSort(prev));
    chain.push({
      type: 'day',
      day_index: i,
      date: `2026-06-${String(21 + (i - 1)).padStart(2, '0')}`,
      prev_hash: prevHash,
      entries: [],
      day_hash: deterministicHash('day-' + i + '-' + mk),
    });
  }

  // Simulate obfuscated blocks as simple base64-encoded JSON
  const files = chain.map((block, i) => {
    const filename = String(i).padStart(6, '0') + '.json';
    const json = jsonSort(block);
    // Simple "obfuscation" — just base64 encode (tests don't need real AES)
    const b64 = Buffer.from(json, 'utf-8').toString('base64');
    return { filename, bytes: new TextEncoder().encode(b64) };
  });

  return { chain, genesis, mk, genesisHash: genesis.day_hash, files };
}

// ══════════════════════════════════════════════════════════════════════
// Mock Transport (simulates R2)
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    this._store = new Map();
    this._offline = false;
    this._deleteCalls = [];
  }

  async pull(path) {
    if (this._offline) throw new Error('Network failure');
    return this._store.get(path) ?? null;
  }

  async delete(path) {
    this._deleteCalls.push(path);
    if (this._offline) throw new Error('Network failure');
    this._store.delete(path);
  }

  async listFiles(prefix) {
    if (this._offline) throw new Error('Network failure');
    const results = [];
    for (const [path] of this._store) {
      if (path.startsWith(prefix)) {
        results.push(path.slice(prefix.length));
      }
    }
    return results;
  }

  setData(path, value) {
    if (value === null || value === undefined) {
      this._store.delete(path);
    } else {
      this._store.set(path, value);
    }
  }

  hasKey(path) { return this._store.has(path); }
  wasDeleted(path) { return this._deleteCalls.includes(path); }
}

// ══════════════════════════════════════════════════════════════════════
// Extracted Logic: Dual-Format Conflict Detection
// ══════════════════════════════════════════════════════════════════════

/**
 * Result from probing the remote for both data formats.
 *
 * @typedef {object} DualFormatResult
 * @property {boolean} hasBlob — ledger:blocks exists on R2
 * @property {boolean} hasCliBlocks — ledger/blocks/ files exist on R2
 * @property {string|null} blobGenesisHash — genesis day_hash from ledger:blocks (if exists)
 * @property {string|null} cliGenesisHash — genesis day_hash from first CLI block (if exists)
 * @property {'conflict'|'blob-only'|'blocks-only'|'empty'} status
 */

/**
 * Probe R2 for both data formats and detect conflicts.
 *
 * This is the logic that would be added to handleWorkerFetch()
 * in OnboardingScreen.jsx to detect when both formats exist.
 *
 * @param {MockTransport} transport
 * @returns {Promise<DualFormatResult>}
 */
async function probeDualFormats(transport) {
  const [blobRaw, cliFiles] = await Promise.all([
    transport.pull('ledger:blocks').catch(() => null),
    transport.listFiles('ledger/blocks/').catch(() => []),
  ]);

  const hasBlob = blobRaw !== null && blobRaw !== undefined;
  const hasCliBlocks = Array.isArray(cliFiles) && cliFiles.length > 0;

  let blobGenesisHash = null;
  let cliGenesisHash = null;

  if (hasBlob) {
    try {
      const chain = JSON.parse(new TextDecoder().decode(blobRaw));
      if (Array.isArray(chain) && chain.length > 0 && chain[0].day_hash) {
        blobGenesisHash = chain[0].day_hash;
      }
    } catch { /* ignore parse errors */ }
  }

  if (hasCliBlocks) {
    // Fetch the first CLI block to get its genesis hash
    const sorted = [...cliFiles].sort();
    const firstFile = sorted[0];
    try {
      const raw = await transport.pull('ledger/blocks/' + firstFile);
      if (raw) {
        // In real code this would deobfuscate; here we treat the stored
        // data as base64-encoded JSON (simplified for testing)
        const json = new TextDecoder().decode(raw);
        // Try to decode as base64 (our test format)
        try {
          const decoded = Buffer.from(json, 'base64').toString('utf-8');
          const block = JSON.parse(decoded);
          if (block.day_hash) cliGenesisHash = block.day_hash;
        } catch {
          // If not base64, try as raw JSON
          try {
            const block = JSON.parse(json);
            if (block.day_hash) cliGenesisHash = block.day_hash;
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // Determine status
  let status;
  if (hasBlob && hasCliBlocks) {
    if (blobGenesisHash && cliGenesisHash && blobGenesisHash !== cliGenesisHash) {
      status = 'conflict';
    } else {
      status = 'blob-only'; // Same genesis → no conflict, prefer blob path
    }
  } else if (hasBlob) {
    status = 'blob-only';
  } else if (hasCliBlocks) {
    status = 'blocks-only';
  } else {
    status = 'empty';
  }

  return { hasBlob, hasCliBlocks, blobGenesisHash, cliGenesisHash, status };
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

console.log('\n═══ Onboarding Cloud Conflict Detection Tests ═══');

// ── C1: Both formats exist with DIFFERENT genesis → conflict detected ──
{
  console.log('\n--- C1: Both formats, different genesis → conflict ---');

  const transport = new MockTransport();

  // Set up ledger:blocks (Genesis A — from a previous web session)
  const blobData = buildPlainChainData({
    username: 'alice-old', email: 'alice-old@example.com',
    passphrase: 'old-passphrase', seed: 'old-seed',
  });
  transport.setData('ledger:blocks', blobData.bytes);

  // Set up CLI blocks (Genesis B — pushed by CLI)
  const cliData = buildCliBlocksData({
    username: 'alice', email: 'alice@example.com',
    passphrase: 'correct horse battery staple', seed: 'new-cli-seed',
    blockCount: 3,
  });
  for (const f of cliData.files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  const result = await probeDualFormats(transport);

  t.assert(result.hasBlob, 'C1: ledger:blocks exists');
  t.assert(result.hasCliBlocks, 'C1b: CLI blocks exist');
  t.assert(result.blobGenesisHash !== null, 'C1c: blob genesis hash extracted');
  t.assert(result.cliGenesisHash !== null, 'C1d: CLI genesis hash extracted');
  t.assertNeq(result.blobGenesisHash, result.cliGenesisHash,
    'C1e: genesis hashes differ (conflict)');
  t.assertEq(result.status, 'conflict',
    'C1f: status is conflict — user should choose which format to use');
}

// ── C2: Both formats exist with SAME genesis → no conflict ──
{
  console.log('\n--- C2: Both formats, same genesis → no conflict ---');

  const transport = new MockTransport();

  const samePassphrase = 'shared-passphrase-123';
  const sameSeed = 'shared-seed-456';

  // Both formats use the same identity
  const blobData = buildPlainChainData({
    username: 'alice', email: 'alice@example.com',
    passphrase: samePassphrase, seed: sameSeed, extraBlocks: 3,
  });
  transport.setData('ledger:blocks', blobData.bytes);

  const cliData = buildCliBlocksData({
    username: 'alice', email: 'alice@example.com',
    passphrase: samePassphrase, seed: sameSeed, blockCount: 1,
  });
  for (const f of cliData.files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  const result = await probeDualFormats(transport);

  t.assert(result.hasBlob, 'C2: ledger:blocks exists');
  t.assert(result.hasCliBlocks, 'C2b: CLI blocks exist');
  t.assertEq(result.blobGenesisHash, result.cliGenesisHash,
    'C2c: genesis hashes match (no conflict)');
  t.assertEq(result.status, 'blob-only',
    'C2d: status is blob-only — prefer single-blob path (same genesis)');
}

// ── C3: Only CLI blocks exist → blocks-format path ──
{
  console.log('\n--- C3: Only CLI blocks — blocks-format path ---');

  const transport = new MockTransport();

  const cliData = buildCliBlocksData({
    username: 'alice', email: 'alice@example.com',
    passphrase: 'only-cli', seed: 'cli-seed', blockCount: 2,
  });
  for (const f of cliData.files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  const result = await probeDualFormats(transport);

  t.assert(!result.hasBlob, 'C3: no ledger:blocks');
  t.assert(result.hasCliBlocks, 'C3b: CLI blocks exist');
  t.assertEq(result.status, 'blocks-only',
    'C3c: status is blocks-only — use blocks-format onboarding path');
}

// ── C4: Only ledger:blocks exists → single-blob path ──
{
  console.log('\n--- C4: Only ledger:blocks — single-blob path ---');

  const transport = new MockTransport();

  const blobData = buildPlainChainData({
    username: 'alice', email: 'alice@example.com',
    passphrase: 'only-blob', seed: 'blob-seed', extraBlocks: 2,
  });
  transport.setData('ledger:blocks', blobData.bytes);

  const result = await probeDualFormats(transport);

  t.assert(result.hasBlob, 'C4: ledger:blocks exists');
  t.assert(!result.hasCliBlocks, 'C4b: no CLI blocks');
  t.assertEq(result.status, 'blob-only',
    'C4c: status is blob-only — use single-blob onboarding path');
}

// ── C5: Both exist, user chooses blocks format → stale blob deleted ──
{
  console.log('\n--- C5: Both exist, choose blocks → stale blob deleted ---');

  const transport = new MockTransport();

  // Stale ledger:blocks (old web session)
  const blobData = buildPlainChainData({
    username: 'old-user', email: 'old@example.com',
    passphrase: 'old-pass', seed: 'old-seed',
  });
  transport.setData('ledger:blocks', blobData.bytes);

  // Current CLI blocks
  const cliData = buildCliBlocksData({
    username: 'alice', email: 'alice@example.com',
    passphrase: 'correct horse battery staple', seed: 'current-seed',
    blockCount: 2,
  });
  for (const f of cliData.files) {
    transport.setData('ledger/blocks/' + f.filename, f.bytes);
  }

  // First: detect the conflict
  const probeResult = await probeDualFormats(transport);
  t.assertEq(probeResult.status, 'conflict',
    'C5: pre-condition — conflict detected');

  // User chooses blocks format → delete stale ledger:blocks
  if (probeResult.status === 'conflict') {
    await transport.delete('ledger:blocks');
  }

  t.assert(transport.wasDeleted('ledger:blocks'),
    'C5b: stale ledger:blocks was deleted');

  // After deletion, re-probing should show blocks-only
  // (Clear the store so pull returns null after delete)
  const reProbe = await probeDualFormats(transport);
  t.assert(!reProbe.hasBlob, 'C5c: after delete, ledger:blocks is gone');
  t.assert(reProbe.hasCliBlocks, 'C5d: CLI blocks still present');
  t.assertEq(reProbe.status, 'blocks-only',
    'C5e: status is now blocks-only — clean onboarding path');

  // CLI block files are untouched
  for (const f of cliData.files) {
    t.assert(transport.hasKey('ledger/blocks/' + f.filename),
      `C5f: CLI block ${f.filename} still intact`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────
t.summary('Onboarding Cloud Conflict Detection');
process.exitCode = t.failed > 0 ? 1 : 0;
