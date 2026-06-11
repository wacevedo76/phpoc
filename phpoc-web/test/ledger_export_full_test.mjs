/**
 * ledger_export_full_test.mjs — Test suite for exportLedgerFull().
 *
 * Tests that exportLedgerFull() produces a correctly structured, sealed
 * Blob containing the full committed chain + staging entries without
 * modifying or committing any staging entries.
 *
 * Design:
 *   - PURE READ: does not commit staging entries
 *   - v2 format: { format_version, exported_at, ledger, staging, seal }
 *   - Seal = HMAC of JSON.stringify({ledger, staging}) using master key
 *   - Blocks and staging entries preserved exactly as-is
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

const SAMPLE_STAGING = [
  {
    entry_id: 'stg-0001-0000-4000-a000-000000000001',
    title: 'Unfinished Task',
    start_epoch: 1717920000000,
    is_active: true,
    is_paused: false,
    pauses: [],
    tags: ['work'],
    comment: 'Still in progress',
    media: [],
    device_uuid: 'dev-test-001',
    hash: 'stg1hash11111111111111111111111111111111111111111111111111111111',
  },
  {
    entry_id: 'stg-0002-0000-4000-a000-000000000002',
    title: 'Completed but Uncommitted',
    start_epoch: 1717923600000,
    end_epoch: 1717927200000,
    duration: 3600000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['chores'],
    comment: 'Done but not committed',
    media: [],
    device_uuid: 'dev-test-001',
    end_device_uuid: 'dev-test-001',
    hash: 'stg2hash22222222222222222222222222222222222222222222222222222222',
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
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
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
  t.assert(Array.isArray(parsed.staging), 'staging is an array');
  t.assert(typeof parsed.seal === 'string', 'seal is a string');
  t.assert(parsed.seal.length > 0, 'seal is non-empty');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 3. Seal Format ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertEq(parsed.seal.length, 64, 'seal is 64 hex chars');
  t.assert(/^[0-9a-f]{64}$/.test(parsed.seal), 'seal is valid hex');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 4. Data Preservation — Blocks ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertDeepEq(parsed.ledger, SAMPLE_BLOCKS, 'ledger blocks match input exactly');
  t.assertEq(parsed.ledger.length, SAMPLE_BLOCKS.length, 'ledger block count preserved');
  t.assertEq(parsed.ledger[0].type, 'genesis', 'genesis block type preserved');
  t.assertEq(parsed.ledger[1].type, 'day', 'day block type preserved');
  t.assertEq(parsed.ledger[0].day_hash, SAMPLE_BLOCKS[0].day_hash, 'genesis day_hash preserved');
  t.assertEq(parsed.ledger[1].day_hash, SAMPLE_BLOCKS[1].day_hash, 'day block day_hash preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 5. Data Preservation — Staging ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertDeepEq(parsed.staging, SAMPLE_STAGING, 'staging entries match input exactly');
  t.assertEq(parsed.staging.length, 2, 'staging entry count preserved');
  t.assertEq(parsed.staging[0].title, 'Unfinished Task', 'active staging entry title preserved');
  t.assertEq(parsed.staging[1].title, 'Completed but Uncommitted', 'stopped staging entry title preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 6. Seal Integrity ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // Seal covers {ledger, staging} only — NOT wrapper metadata
  const sealData = JSON.stringify({ ledger: SAMPLE_BLOCKS, staging: SAMPLE_STAGING });
  const expectedSeal = crypto.seal(sealData, MASTER_KEY);
  t.assertEq(parsed.seal, expectedSeal, 'seal = HMAC(JSON.stringify({ledger, staging}), masterKey)');

  // Seal does NOT cover wrapper metadata (format_version, exported_at)
  const withMeta = JSON.stringify({
    format_version: '2',
    exported_at: parsed.exported_at,
    ledger: SAMPLE_BLOCKS,
    staging: SAMPLE_STAGING,
  });
  const metaSeal = crypto.seal(withMeta, MASTER_KEY);
  t.assertNeq(parsed.seal, metaSeal, 'seal does not cover wrapper metadata');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 7. Deterministic Output ===');

if (typeof exportLedgerFull === 'function') {
  const blob1 = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
  const blob2 = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);

  const p1 = JSON.parse(await blob1.text());
  const p2 = JSON.parse(await blob2.text());

  t.assertEq(p1.seal, p2.seal, 'same input → same seal (deterministic)');

  // exported_at will differ, so full payload differs — but seal is same
  // (seal does not cover exported_at)
  t.assertNeq(p1.exported_at, '', 'exported_at is set on first call');
  t.assertNeq(p2.exported_at, '', 'exported_at is set on second call');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 8. Different Master Key → Different Seal ===');

if (typeof exportLedgerFull === 'function') {
  const blob1 = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
  const blob2 = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY + 'ff');

  const p1 = JSON.parse(await blob1.text());
  const p2 = JSON.parse(await blob2.text());

  t.assertNeq(p1.seal, p2.seal, 'different master key → different seal');
  // Data should still be the same (only seal differs)
  t.assertDeepEq(p1.ledger, p2.ledger, 'ledger data unchanged by different key');
  t.assertDeepEq(p1.staging, p2.staging, 'staging data unchanged by different key');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 9. Empty Data Edge Cases ===');

if (typeof exportLedgerFull === 'function') {
  // Empty ledger, empty staging
  const blob1 = await exportLedgerFull([], [], crypto, MASTER_KEY);
  const p1 = JSON.parse(await blob1.text());
  t.assertDeepEq(p1.ledger, [], 'empty ledger array works');
  t.assertDeepEq(p1.staging, [], 'empty staging array works');
  t.assert(typeof p1.seal === 'string' && p1.seal.length === 64, 'empty data still produces seal');

  // Empty ledger, with staging
  const blob2 = await exportLedgerFull([], SAMPLE_STAGING, crypto, MASTER_KEY);
  const p2 = JSON.parse(await blob2.text());
  t.assertDeepEq(p2.ledger, [], 'empty ledger with staging — ledger is []');
  t.assertDeepEq(p2.staging, SAMPLE_STAGING, 'empty ledger with staging — staging preserved');
  t.assertNeq(p2.seal, p1.seal, 'empty ledger seal differs when staging is added');

  // With ledger, empty staging
  const blob3 = await exportLedgerFull(SAMPLE_BLOCKS, [], crypto, MASTER_KEY);
  const p3 = JSON.parse(await blob3.text());
  t.assertDeepEq(p3.ledger, SAMPLE_BLOCKS, 'ledger with empty staging — blocks preserved');
  t.assertDeepEq(p3.staging, [], 'ledger with empty staging — staging is []');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 10. Staging NOT Modified During Export ===');

if (typeof exportLedgerFull === 'function') {
  // Deep-clone staging to detect mutation
  const stagingCopy = JSON.parse(JSON.stringify(SAMPLE_STAGING));

  await exportLedgerFull(SAMPLE_BLOCKS, stagingCopy, crypto, MASTER_KEY);

  // Verify no fields were added, removed, or changed
  t.assertDeepEq(stagingCopy, SAMPLE_STAGING, 'staging entries NOT modified during export');

  // Verify active entries stay active (not committed)
  t.assertEq(stagingCopy[0].is_active, true, 'active staging entry remains active');
  t.assertEq(stagingCopy[0].end_epoch, undefined, 'active entry has no end_epoch');

  // Verify stopped entries stay stopped (not re-activated)
  t.assertEq(stagingCopy[1].is_active, false, 'stopped staging entry remains stopped');

  // Verify hash preservation
  t.assertEq(stagingCopy[0].hash, SAMPLE_STAGING[0].hash, 'staging entry hash preserved');
  t.assertEq(stagingCopy[1].hash, SAMPLE_STAGING[1].hash, 'staging entry hash preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 11. Block Integrity in Export ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
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
console.log('\n=== 12. Real Mock Ledger Data ===');

if (typeof exportLedgerFull === 'function' && realLedgerBlocks.length > 0) {
  // Export with real data
  const mockStaging = []; // no staging for real data export
  const blob = await exportLedgerFull(realLedgerBlocks, mockStaging, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertEq(parsed.format_version, '2', 'real data: format_version is "2"');
  t.assertEq(parsed.ledger.length, realLedgerBlocks.length,
    `real data: ${realLedgerBlocks.length} blocks preserved`);
  t.assertDeepEq(parsed.staging, [], 'real data: staging is empty');

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
  const sealDataReal = JSON.stringify({ ledger: realLedgerBlocks, staging: mockStaging });
  const expectedSealReal = crypto.seal(sealDataReal, MASTER_KEY);
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
console.log('\n=== 13. Error Handling ===');

if (typeof exportLedgerFull === 'function') {
  // Missing masterKey
  await t.assertAsyncThrows(
    exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, undefined),
    'throws if masterKey is undefined'
  );

  // Empty masterKey
  await t.assertAsyncThrows(
    exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, ''),
    'throws if masterKey is empty string'
  );

  // Missing seal on crypto
  const badCrypto = {};
  await t.assertAsyncThrows(
    exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, badCrypto, MASTER_KEY),
    'throws if crypto has no seal()'
  );

  // Blocks not an array
  await t.assertAsyncThrows(
    exportLedgerFull('not-an-array', SAMPLE_STAGING, crypto, MASTER_KEY),
    'throws if blocks is not an array'
  );

  // Blocks is null
  await t.assertAsyncThrows(
    exportLedgerFull(null, SAMPLE_STAGING, crypto, MASTER_KEY),
    'throws if blocks is null'
  );

  // Staging not an array
  await t.assertAsyncThrows(
    exportLedgerFull(SAMPLE_BLOCKS, 'not-an-array', crypto, MASTER_KEY),
    'throws if staging is not an array'
  );

  // Staging is null
  await t.assertAsyncThrows(
    exportLedgerFull(SAMPLE_BLOCKS, null, crypto, MASTER_KEY),
    'throws if staging is null'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 14. Format Version ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertEq(parsed.format_version, '2', 'full export uses format_version "2"');

  // Compare with v1 export (should be a different format version)
  const { exportLedger } = await import('../src/services/ledger_export.js');
  if (typeof exportLedger === 'function') {
    const v1blob = await exportLedger(SAMPLE_STAGING, crypto, MASTER_KEY);
    const v1parsed = JSON.parse(await v1blob.text());
    t.assertEq(v1parsed.format_version, '1', 'staging-only export uses format_version "1"');
    t.assertNeq(v1parsed.format_version, parsed.format_version, 'v1 and v2 have different format versions');
  }
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 15. Large Export — No Data Corruption ===');

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

  const blob = await exportLedgerFull(largeBlocks, [], crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  t.assertEq(parsed.ledger.length, 100, 'large export: 100 blocks preserved');
  t.assertEq(parsed.ledger[0].type, 'genesis', 'large export: first block is genesis');
  t.assertEq(parsed.ledger[99].day_index, 99, 'large export: last block day_index is 99');

  // Verify seal on large data
  const sealData = JSON.stringify({ ledger: largeBlocks, staging: [] });
  const expectedSeal = crypto.seal(sealData, MASTER_KEY);
  t.assertEq(parsed.seal, expectedSeal, 'large export: seal validates on 100 blocks');
}

// ═════════════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════════════
const failures = t.summary('ledger_export_full_test');
process.exit(failures > 0 ? 1 : 0);
