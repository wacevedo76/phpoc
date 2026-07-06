/**
 * ledger_export_full_test.mjs — Test suite for exportLedgerFull().
 *
 * Tests that exportLedgerFull() produces a correctly structured, sealed
 * Blob containing the committed chain without modifying or committing
 * any staging entries.
 *
 * Design:
 *   - PURE READ: does not commit staging entries
 *   - v2 format: { format_version, exported_at, ledger, seal }
 *   - Seal = HMAC of JSON.stringify(ledger) using master key
 *   - Blocks preserved exactly as-is
 *   - D11: staging entries excluded from ledger export
 *   - Uses real mock ledger data from /tmp/phpoc-mock-ledger.json
 *
 * Usage:
 *   node test/ledger_export_full_test.mjs
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Import the module ───────────────────────────────────────────────
let exportLedgerFull;
try {
  const mod = await import('../src/services/ledger_export.js');
  exportLedgerFull = mod.exportLedgerFull;
} catch (err) {
  console.error('Failed to import exportLedgerFull:', err.message);
  exportLedgerFull = undefined;
}

// ── Load real mock ledger data ──────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_LEDGER_PATH = '/tmp/phpoc-mock-ledger.json';
let realLedgerBlocks = [];
try {
  const raw = readFileSync(MOCK_LEDGER_PATH, 'utf-8');
  realLedgerBlocks = JSON.parse(raw);
  console.log(`Loaded ${realLedgerBlocks.length} blocks from ${MOCK_LEDGER_PATH}`);
} catch (err) {
  console.warn(`Could not load mock ledger: ${err.message}`);
}

// ── Mock Crypto ─────────────────────────────────────────────────────
class MockCrypto {
  deterministicHash(data) {
    let hash = 5381;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return (hash >>> 0).toString(16).padStart(64, '0');
  }

  seal(data, masterKeyHex) {
    return this.deterministicHash(data + masterKeyHex);
  }

  verifySeal(data, sealHex, masterKeyHex) {
    return this.seal(data, masterKeyHex) === sealHex;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }
}

const crypto = new MockCrypto();
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// ── Sample data ─────────────────────────────────────────────────────
const SAMPLE_BLOCKS = [
  {
    type: 'genesis',
    day_index: 0,
    date: '2026-04-23',
    identity: { username: 'tester', email: 'test@example.com' },
    prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    entries: [],
    day_hash: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1',
  },
  {
    type: 'day',
    day_index: 1,
    date: '2026-04-23',
    prev_hash: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1',
    entries: [
      {
        hash: 'd1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1',
        data: {
          title: 'Morning Exercise',
          duration: 1800000,
          is_active: false,
          startTime_enc: 'enc-start-1',
          endTime_enc: 'enc-end-1',
          metadata_enc: 'enc-meta-1',
        },
      },
    ],
    day_hash: 'def456def456def456def456def456def456def456def456def456def456def4',
  },
];

// ═════════════════════════════════════════════════════════════════════
// Test suite
// ═════════════════════════════════════════════════════════════════════

console.log('\n=== 1. Function Exists ===');

t.assert(typeof exportLedgerFull === 'function', 'exportLedgerFull is a function');

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 2. Basic Output Structure ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY);
  t.assert(blob instanceof Blob, 'returns a Blob');
  t.assertEq(blob.type, 'application/json', 'Blob has JSON MIME type');

  const text = await blob.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
    t.assert(true, 'result parses as valid JSON');
  } catch {
    t.assert(false, 'result parses as valid JSON');
  }

  t.assertEq(parsed.format_version, '2', 'format_version is "2"');
  t.assert(typeof parsed.exported_at === 'string', 'exported_at is a string');
  t.assert(/^\d{4}-\d{2}-\d{2}T/.test(parsed.exported_at), 'exported_at is ISO-8601');
  t.assert(Array.isArray(parsed.ledger), 'ledger is an array');
  t.assert(typeof parsed.seal === 'string', 'seal is a string');
  t.assert(parsed.seal.length > 0, 'seal is non-empty');
  // D11: staging is never in the export payload
  t.assert(!('staging' in parsed), 'staging key is NOT present in v2 export (D11)');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 3. Seal Format ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertEq(parsed.seal.length, 64, 'seal is 64 hex chars');
  t.assert(/^[0-9a-f]{64}$/.test(parsed.seal), 'seal is valid hex');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 4. Data Preservation — Blocks ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertDeepEq(parsed.ledger, SAMPLE_BLOCKS, 'ledger blocks match input exactly');
  t.assertEq(parsed.ledger.length, SAMPLE_BLOCKS.length, 'ledger block count preserved');
  t.assertEq(parsed.ledger[0].type, 'genesis', 'genesis block type preserved');
  t.assertEq(parsed.ledger[1].type, 'day', 'day block type preserved');
  t.assertEq(parsed.ledger[0].day_hash, SAMPLE_BLOCKS[0].day_hash, 'genesis day_hash preserved');
  t.assertEq(parsed.ledger[1].day_hash, SAMPLE_BLOCKS[1].day_hash, 'day block day_hash preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 5. Seal Integrity ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // Seal covers ledger blocks only (D11)
  const expectedSeal = crypto.seal(JSON.stringify(SAMPLE_BLOCKS), MASTER_KEY);
  t.assertEq(parsed.seal, expectedSeal, 'seal = HMAC(JSON.stringify(ledger), masterKey)');

  // Seal does NOT cover wrapper metadata (format_version, exported_at)
  const withMeta = JSON.stringify({
    format_version: '2',
    exported_at: parsed.exported_at,
    ledger: SAMPLE_BLOCKS,
  });
  const metaSeal = crypto.seal(withMeta, MASTER_KEY);
  t.assertNeq(parsed.seal, metaSeal, 'seal does not cover wrapper metadata');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 6. Deterministic Output ===');

if (typeof exportLedgerFull === 'function') {
  const blob1 = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY);
  const blob2 = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY);

  const p1 = JSON.parse(await blob1.text());
  const p2 = JSON.parse(await blob2.text());

  t.assertEq(p1.seal, p2.seal, 'same input → same seal (deterministic)');

  // exported_at will differ, so full payload differs — but seal is same
  // (seal does not cover exported_at)
  t.assertNeq(p1.exported_at, '', 'exported_at is set on first call');
  t.assertNeq(p2.exported_at, '', 'exported_at is set on second call');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 7. Different Master Key → Different Seal ===');

if (typeof exportLedgerFull === 'function') {
  const blob1 = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY);
  const blob2 = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY + 'ff');

  const p1 = JSON.parse(await blob1.text());
  const p2 = JSON.parse(await blob2.text());

  t.assertNeq(p1.seal, p2.seal, 'different master key → different seal');
  // Data should still be the same (only seal differs)
  t.assertDeepEq(p1.ledger, p2.ledger, 'ledger data unchanged by different key');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 8. Empty Data Edge Cases ===');

if (typeof exportLedgerFull === 'function') {
  // Empty ledger
  const blob1 = await exportLedgerFull([], crypto, MASTER_KEY);
  const p1 = JSON.parse(await blob1.text());
  t.assertDeepEq(p1.ledger, [], 'empty ledger array works');
  t.assert(typeof p1.seal === 'string' && p1.seal.length === 64, 'empty data still produces seal');
  t.assert(!('staging' in p1), 'no staging key with empty ledger');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 9. Block Integrity in Export ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // Verify block chain links preserved
  t.assertEq(parsed.ledger[1].prev_hash, parsed.ledger[0].day_hash,
    'day block prev_hash links to genesis day_hash');

  // Verify entry hashes within blocks preserved
  const blockEntry = parsed.ledger[1].entries[0];
  t.assertEq(blockEntry.hash, SAMPLE_BLOCKS[1].entries[0].hash,
    'entry hash within day block preserved');
  t.assertDeepEq(blockEntry.data, SAMPLE_BLOCKS[1].entries[0].data,
    'entry data within day block preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 10. Real Mock Ledger Data ===');

if (typeof exportLedgerFull === 'function' && realLedgerBlocks.length > 0) {
  const blob = await exportLedgerFull(realLedgerBlocks, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertEq(parsed.format_version, '2', 'real data: format_version is "2"');
  t.assertEq(parsed.ledger.length, realLedgerBlocks.length,
    `real data: ${realLedgerBlocks.length} blocks preserved`);
  t.assert(!('staging' in parsed), 'real data: no staging key (D11)');

  // Check block types
  const types = parsed.ledger.map(b => b.type);
  t.assert(types.includes('genesis'), 'real data: includes genesis block');
  t.assert(types.includes('day'), 'real data: includes day blocks');

  // Check first block is genesis
  t.assertEq(parsed.ledger[0].type, 'genesis', 'real data: first block is genesis');

  // Check block hashes preserved
  t.assertEq(parsed.ledger[0].day_hash, realLedgerBlocks[0].day_hash,
    'real data: genesis day_hash preserved');

  // Check chain linkage on first two blocks
  if (realLedgerBlocks.length >= 2) {
    t.assertEq(parsed.ledger[1].prev_hash, parsed.ledger[0].day_hash,
      'real data: chain linkage preserved');
  }

  // Verify seal is valid
  const expectedSealReal = crypto.seal(JSON.stringify(realLedgerBlocks), MASTER_KEY);
  t.assertEq(parsed.seal, expectedSealReal, 'real data: seal validates');

  // Total committed entries count
  let totalEntries = 0;
  // Exclude genesis (day_index === 0 or type === 'genesis')
  parsed.ledger.forEach(b => {
    if (b.type === 'genesis') return;
    if (Array.isArray(b.entries)) totalEntries += b.entries.length;
  });
  t.assert(totalEntries > 0, `real data: ${totalEntries} committed entries in export`);
} else {
  console.log('  (skipped — mock ledger not available)');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 11. Error Handling ===');

if (typeof exportLedgerFull === 'function') {
  // Missing masterKey
  await t.assertAsyncThrows(
    exportLedgerFull(SAMPLE_BLOCKS, crypto, undefined),
    'throws if masterKey is undefined'
  );

  // Empty masterKey
  await t.assertAsyncThrows(
    exportLedgerFull(SAMPLE_BLOCKS, crypto, ''),
    'throws if masterKey is empty string'
  );

  // Missing seal on crypto
  const badCrypto = {};
  await t.assertAsyncThrows(
    exportLedgerFull(SAMPLE_BLOCKS, badCrypto, MASTER_KEY),
    'throws if crypto has no seal()'
  );

  // Blocks not an array
  await t.assertAsyncThrows(
    exportLedgerFull('not-an-array', crypto, MASTER_KEY),
    'throws if blocks is not an array'
  );

  // Blocks is null
  await t.assertAsyncThrows(
    exportLedgerFull(null, crypto, MASTER_KEY),
    'throws if blocks is null'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 12. Format Version ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertEq(parsed.format_version, '2', 'full export uses format_version "2"');

  // Compare with v1 export (should be a different format version)
  const { exportLedger } = await import('../src/services/ledger_export.js');
  if (typeof exportLedger === 'function') {
    const v1blob = await exportLedger(SAMPLE_BLOCKS, crypto, MASTER_KEY);
    const v1parsed = JSON.parse(await v1blob.text());
    t.assertEq(v1parsed.format_version, '1', 'staging-only export uses format_version "1"');
    t.assertNeq(v1parsed.format_version, parsed.format_version, 'v1 and v2 have different format versions');
  }
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 13. Large Export — No Data Corruption ===');

if (typeof exportLedgerFull === 'function') {
  // Generate synthetic blocks to test large exports
  const largeBlocks = [];
  for (let i = 0; i < 100; i++) {
    largeBlocks.push({
      type: i === 0 ? 'genesis' : 'day',
      day_index: i,
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      prev_hash: i === 0
        ? '0000000000000000000000000000000000000000000000000000000000000000'
        : `hash${String(i).padStart(62, '0')}`,
      entries: [{ hash: `entry${i}`, data: { title: `Task ${i}`, duration: i * 1000 } }],
      day_hash: `dayhash${String(i).padStart(58, '0')}`,
    });
  }

  const blob = await exportLedgerFull(largeBlocks, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertEq(parsed.ledger.length, 100, 'large export: 100 blocks preserved');
  t.assert(!('staging' in parsed), 'large export: no staging key (D11)');
  t.assertEq(parsed.ledger[0].type, 'genesis', 'large export: first block is genesis');
  t.assertEq(parsed.ledger[99].day_index, 99, 'large export: last block day_index is 99');

  // Verify seal on large data
  const expectedSeal = crypto.seal(JSON.stringify(largeBlocks), MASTER_KEY);
  t.assertEq(parsed.seal, expectedSeal, 'large export: seal validates on 100 blocks');
}

// ═════════════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════════════
const failures = t.summary('ledger_export_full_test');
process.exit(failures > 0 ? 1 : 0);
