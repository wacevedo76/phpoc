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

  // Staging entries match input after hash recomputation
  const expectedStaging = SAMPLE_STAGING.map(entry => {
    const { hash: _, ...hashData } = entry;
    return { ...entry, hash: crypto.sha256(jsonSort(hashData)) };
  });
  t.assertDeepEq(parsed.staging, expectedStaging, 'staging entries match recomputed input');
  t.assertEq(parsed.staging.length, 2, 'staging entry count preserved');
  t.assertEq(parsed.staging[0].title, 'Unfinished Task', 'active staging entry title preserved');
  t.assertEq(parsed.staging[1].title, 'Completed but Uncommitted', 'stopped staging entry title preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 6. Seal Integrity ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, SAMPLE_STAGING, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // Seal covers {ledger, recomputedStaging} — recomputed hashes change the seal
  const recomputedStaging = SAMPLE_STAGING.map(entry => {
    const { hash: _, ...hashData } = entry;
    return { ...entry, hash: crypto.sha256(jsonSort(hashData)) };
  });
  const sealData = jsonSort({ ledger: SAMPLE_BLOCKS, staging: recomputedStaging });
  const expectedSeal = crypto.seal(sealData, MASTER_KEY);
  t.assertEq(parsed.seal, expectedSeal, 'seal = HMAC(jsonSort({ledger, recomputedStaging}), masterKey)');

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

  // Empty ledger, with staging — staging hashes recomputed
  const blob2 = await exportLedgerFull([], SAMPLE_STAGING, crypto, MASTER_KEY);
  const p2 = JSON.parse(await blob2.text());
  t.assertDeepEq(p2.ledger, [], 'empty ledger with staging — ledger is []');
  const expectedStg = SAMPLE_STAGING.map(entry => {
    const { hash: _, ...hashData } = entry;
    return { ...entry, hash: crypto.sha256(jsonSort(hashData)) };
  });
  t.assertDeepEq(p2.staging, expectedStg, 'empty ledger with staging — staging preserved (hashes recomputed)');
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
  const sealDataReal = jsonSort({ ledger: realLedgerBlocks, staging: mockStaging });
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
  const sealData = jsonSort({ ledger: largeBlocks, staging: [] });
  const expectedSeal = crypto.seal(sealData, MASTER_KEY);
  t.assertEq(parsed.seal, expectedSeal, 'large export: seal validates on 100 blocks');
}

// ═════════════════════════════════════════════════════════════════════
// Group B: Hash Recomputation in v2 (Step 5 TDD)
// ═════════════════════════════════════════════════════════════════════

console.log('\n=== 16. B1 — Staging entry hash recomputation in v2 ===');

if (typeof exportLedgerFull === 'function') {
  // Staging entries with extra fields (committed, block_index, entry_index)
  // whose original hashes were computed WITHOUT those fields — like real
  // entries from LocalCache.append() → readEntries().
  const stagingWithExtras = JSON.parse(JSON.stringify(SAMPLE_STAGING));

  // Add extra app fields to both staging entries (these were added AFTER
  // the original hash was computed in the real app flow)
  stagingWithExtras[0].committed = false;
  stagingWithExtras[0].block_index = null;
  stagingWithExtras[0].entry_index = 0;
  stagingWithExtras[0].end_device_uuid = stagingWithExtras[0].end_device_uuid || 'dev-test-001';
  stagingWithExtras[0].is_paused = stagingWithExtras[0].is_paused ?? false;
  stagingWithExtras[0].pauses = stagingWithExtras[0].pauses ?? [];
  stagingWithExtras[0].metadata = stagingWithExtras[0].metadata ?? {};
  stagingWithExtras[0].comment = stagingWithExtras[0].comment ?? null;
  stagingWithExtras[0].media = stagingWithExtras[0].media ?? [];

  stagingWithExtras[1].committed = false;
  stagingWithExtras[1].block_index = null;
  stagingWithExtras[1].entry_index = 1;
  stagingWithExtras[1].metadata = stagingWithExtras[1].metadata ?? {};
  stagingWithExtras[1].comment = stagingWithExtras[1].comment ?? null;
  stagingWithExtras[1].media = stagingWithExtras[1].media ?? [];

  // Preserve ORIGINAL stale hashes (computed without extra fields)
  const staleHash0 = stagingWithExtras[0].hash;
  const staleHash1 = stagingWithExtras[1].hash;

  const blob = await exportLedgerFull(SAMPLE_BLOCKS, stagingWithExtras, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // B1.1: Staging entry 0 hash must be recomputed (≠ original stale hash)
  t.assertNeq(parsed.staging[0].hash, staleHash0,
    'B1.1: staging[0] hash recomputed (≠ original stale hash)');

  // B1.2: Staging entry 1 hash must be recomputed
  t.assertNeq(parsed.staging[1].hash, staleHash1,
    'B1.2: staging[1] hash recomputed (≠ original stale hash)');

  // B1.3: Ledger block day_hash fields unchanged (blocks NOT recomputed)
  t.assertEq(parsed.ledger[0].day_hash, SAMPLE_BLOCKS[0].day_hash,
    'B1.3: genesis day_hash unchanged');
  t.assertEq(parsed.ledger[1].day_hash, SAMPLE_BLOCKS[1].day_hash,
    'B1.3: day block day_hash unchanged');
}

console.log('\n=== 17. B2 — Seal covers recomputed staging in v2 ===');

if (typeof exportLedgerFull === 'function') {
  // Same setup as B1
  const stagingWithExtras = JSON.parse(JSON.stringify(SAMPLE_STAGING));
  stagingWithExtras[0].committed = false;
  stagingWithExtras[0].block_index = null;
  stagingWithExtras[0].entry_index = 0;
  stagingWithExtras[1].committed = false;
  stagingWithExtras[1].block_index = null;
  stagingWithExtras[1].entry_index = 1;

  const blob = await exportLedgerFull(SAMPLE_BLOCKS, stagingWithExtras, crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // B2.1: Seal computed with ORIGINAL staging hashes ≠ actual seal
  const sealWithOriginals = crypto.seal(
    jsonSort({ ledger: SAMPLE_BLOCKS, staging: stagingWithExtras }),
    MASTER_KEY
  );
  t.assertNeq(parsed.seal, sealWithOriginals,
    'B2.1: seal ≠ seal computed with original staging hashes');

  // B2.2: Seal computed with RECOMPUTED staging hashes = actual seal
  const sealWithRecomputed = crypto.seal(
    jsonSort({ ledger: SAMPLE_BLOCKS, staging: parsed.staging }),
    MASTER_KEY
  );
  t.assertEq(parsed.seal, sealWithRecomputed,
    'B2.2: seal = seal computed with recomputed staging hashes');
}

console.log('\n=== 18. B3 — Empty staging unaffected ===');

if (typeof exportLedgerFull === 'function') {
  const blob = await exportLedgerFull(SAMPLE_BLOCKS, [], crypto, MASTER_KEY);
  const parsed = JSON.parse(await blob.text());

  // B3.1: Export succeeds with empty staging, seal is valid
  const expectedSeal = crypto.seal(
    jsonSort({ ledger: SAMPLE_BLOCKS, staging: [] }),
    MASTER_KEY
  );
  t.assertEq(parsed.seal, expectedSeal,
    'B3.1: empty staging export succeeds, seal validates');
  t.assertDeepEq(parsed.staging, [], 'B3.1: staging is empty array');
  t.assertEq(parsed.ledger.length, SAMPLE_BLOCKS.length, 'B3.1: blocks preserved');
}

// ═════════════════════════════════════════════════════════════════════
// Summary
// ═════════════════════════════════════════════════════════════════════
const failures = t.summary('ledger_export_full_test');
process.exit(failures > 0 ? 1 : 0);
