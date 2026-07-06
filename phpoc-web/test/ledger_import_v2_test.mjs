/**
 * ledger_import_v2_test.mjs — Test suite for v2 format import path.
 *
 * Tests importLedger() with v2 format: { format_version: '2', ledger, seal }.
 * Covers: genesis hash extraction, ledger preservation, seal over ledger,
 * backward compat with old v2 exports that included staging, edge cases.
 *
 * Usage:
 *   node test/ledger_import_v2_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { MockCrypto } from './mock_crypto.mjs';
import { jsonSort } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Import the module ───────────────────────────────────────────────
let importLedger;
try {
  const mod = await import('../src/services/ledger_import.js');
  importLedger = mod.importLedger;
} catch (err) {
  t.assert(false, 'importLedger module loads: ' + err.message);
  process.exit(1);
}

const crypto = new MockCrypto();
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// ── Sample data builders ────────────────────────────────────────────

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
        data: { title: 'Morning Exercise', duration: 1800000, is_active: false },
      },
    ],
    day_hash: 'def456def456def456def456def456def456def456def456def456def456def4',
  },
];

function makeStagingEntry(overrides = {}) {
  const base = {
    entry_id: overrides.entry_id || 'a1000000-0000-4000-a000-000000000001',
    title: 'Uncommitted Task',
    start_epoch: 1717920000000,
    end_epoch: null,
    duration: 0,
    is_active: true,
    is_paused: false,
    pauses: [],
    tags: ['work'],
    comment: null,
    media: [],
    device_uuid: 'dev-test-001',
    end_device_uuid: 'dev-test-001',
    metadata: {},
    hash: '',
    ...overrides,
  };
  if (!base.hash) {
    const hashData = {};
    for (const k of Object.keys(base).sort()) {
      if (k !== 'hash') hashData[k] = base[k];
    }
    base.hash = crypto.sha256(jsonSort(hashData));
  }
  return base;
}

function makeV2Blob(ledger, staging, mk, overrides = {}) {
  const sealPayload = JSON.stringify(ledger);
  return new Blob([JSON.stringify({
    format_version: '2',
    exported_at: '2026-06-24T14:30:00.000Z',
    ledger,
    staging,
    ...overrides,
    seal: overrides.seal !== undefined ? overrides.seal : crypto.seal(sealPayload, mk),
  })], { type: 'application/json' });
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 1. Module Loads ===');

t.assert(typeof importLedger === 'function', 'importLedger is a function');

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 2. Basic v2 Import — Ledger + Staging ===');

{
  const staging = [makeStagingEntry({ title: 'Pending task' })];
  const blob = makeV2Blob(SAMPLE_BLOCKS, staging, MASTER_KEY);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assert(typeof result === 'object', 'returns object');
  t.assertEq(result.formatVersion, '2', 'formatVersion = "2"');
  t.assert(Array.isArray(result.entries), 'entries is array');
  t.assert(Array.isArray(result.ledger), 'ledger is array');
  t.assertEq(result.entries.length, staging.length, 'staging entries returned as entries');
  t.assertEq(result.entries[0].title, 'Pending task', 'entry title preserved');
  t.assertDeepEq(result.ledger, SAMPLE_BLOCKS, 'ledger blocks match source');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 3. Genesis Hash Extraction ===');

{
  const staging = [makeStagingEntry()];
  const blob = makeV2Blob(SAMPLE_BLOCKS, staging, MASTER_KEY);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.genesisHash, SAMPLE_BLOCKS[0].day_hash,
    'genesisHash = genesis block day_hash');
  t.assert(typeof result.genesisHash === 'string', 'genesisHash is string');
  t.assertEq(result.genesisHash.length, 64, 'genesisHash is 64 hex chars');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 4. Genesis Hash — Null When No Genesis Block ===');

{
  // Blocks array where first block is NOT type:genesis
  const noGenesisBlocks = [
    {
      type: 'day',
      day_index: 0,
      date: '2026-04-23',
      prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
      entries: [],
      day_hash: '1111111111111111111111111111111111111111111111111111111111111111',
    },
  ];
  const blob = makeV2Blob(noGenesisBlocks, [], MASTER_KEY);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.genesisHash, null,
    'genesisHash = null when first block not type genesis');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 5. v2 with Empty Staging ===');

{
  const blob = makeV2Blob(SAMPLE_BLOCKS, [], MASTER_KEY);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.count, 0, 'count = 0 (empty staging)');
  t.assertDeepEq(result.entries, [], 'entries = []');
  t.assertDeepEq(result.ledger, SAMPLE_BLOCKS, 'ledger preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 6. v2 with Empty Ledger ===');

{
  const staging = [makeStagingEntry({ title: 'Orphan staging' })];
  const blob = makeV2Blob([], staging, MASTER_KEY);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.count, 1, 'count = 1 (staging entry)');
  t.assertEq(result.entries[0].title, 'Orphan staging', 'entry preserved');
  t.assertDeepEq(result.ledger, [], 'ledger = []');
  t.assertEq(result.genesisHash, null, 'genesisHash = null (empty ledger)');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 7. v2 with Both Empty ===');

{
  const blob = makeV2Blob([], [], MASTER_KEY);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.count, 0, 'count = 0');
  t.assertDeepEq(result.entries, [], 'entries = []');
  t.assertDeepEq(result.ledger, [], 'ledger = []');
  t.assertEq(result.genesisHash, null, 'genesisHash = null');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 8. v2 with Genesis-Only Ledger ===');

{
  const genesisOnly = [SAMPLE_BLOCKS[0]];
  const blob = makeV2Blob(genesisOnly, [], MASTER_KEY);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.genesisHash, SAMPLE_BLOCKS[0].day_hash,
    'genesisHash from genesis-only chain');
  t.assertDeepEq(result.ledger, genesisOnly, 'ledger: genesis-only chain');
  t.assertDeepEq(result.entries, [], 'entries: []');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 9. v2 Multiple Staging Entries ===');

{
  const staging = [
    makeStagingEntry({ entry_id: 'e1', title: 'First' }),
    makeStagingEntry({ entry_id: 'e2', title: 'Second' }),
    makeStagingEntry({ entry_id: 'e3', title: 'Third' }),
  ];
  const blob = makeV2Blob(SAMPLE_BLOCKS, staging, MASTER_KEY);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.count, 3, 'count = 3');
  t.assertEq(result.entries[0].title, 'First', 'first entry preserved');
  t.assertEq(result.entries[2].title, 'Third', 'third entry preserved');
  t.assertDeepEq(result.entries, staging, 'all entries match');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 10. v2 Active Task Preservation ===');

{
  const active = makeStagingEntry({
    entry_id: 'act-1',
    title: 'Active task',
    is_active: true,
    is_paused: false,
    end_epoch: null,
    duration: 0,
  });
  const paused = makeStagingEntry({
    entry_id: 'act-2',
    title: 'Paused task',
    is_active: true,
    is_paused: true,
    end_epoch: null,
    duration: 0,
    pauses: [{ pause_start: 1717921000000 }],
  });
  const blob = makeV2Blob(SAMPLE_BLOCKS, [active, paused], MASTER_KEY);

  const result = await importLedger(blob, crypto, MASTER_KEY);

  t.assertEq(result.entries[0].is_active, true, 'active flag preserved');
  t.assertEq(result.entries[0].is_paused, false, 'non-paused preserved');
  t.assertEq(result.entries[0].end_epoch, null, 'active: end_epoch is null');
  t.assertEq(result.entries[1].is_active, true, 'paused task: is_active preserved');
  t.assertEq(result.entries[1].is_paused, true, 'paused flag preserved');
  t.assertEq(result.entries[1].pauses.length, 1, 'pauses array preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 11. v2 Seal Tampering → Reject ===');

{
  const staging = [makeStagingEntry()];
  const blob = makeV2Blob(SAMPLE_BLOCKS, staging, MASTER_KEY, { seal: 'f'.repeat(64) });

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects on wrong seal'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 12. v2 Tampered Ledger → Seal Mismatch → Reject ===');

{
  const staging = [makeStagingEntry()];
  const tamperedLedger = JSON.parse(JSON.stringify(SAMPLE_BLOCKS));
  tamperedLedger[0].day_hash = 'f'.repeat(64);

  // Compute seal over tampered ledger, then apply to unchanged ledger blob
  const wrongSeal = crypto.seal(JSON.stringify(tamperedLedger), MASTER_KEY);
  const blob = makeV2Blob(SAMPLE_BLOCKS, staging, MASTER_KEY, { seal: wrongSeal });

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects on seal mismatch (tampered ledger data)'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 13. v2 Entry Hash Mismatch → Reject ===');

{
  const badStaging = [makeStagingEntry({ hash: 'f'.repeat(64) })];
  const blob = makeV2Blob(SAMPLE_BLOCKS, badStaging, MASTER_KEY);

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects entry with bad hash in v2 format'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 14. v2 Wrong Master Key → Reject ===');

{
  const staging = [makeStagingEntry()];
  const blob = makeV2Blob(SAMPLE_BLOCKS, staging, MASTER_KEY);
  const wrongKey = 'b'.repeat(64);

  await t.assertAsyncThrows(
    importLedger(blob, crypto, wrongKey),
    'rejects on wrong master key (seal mismatch)'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 15. v2 Missing ledger Array → Reject ===');

{
  const blob = new Blob([JSON.stringify({
    format_version: '2',
    exported_at: '2026-06-24T14:30:00.000Z',
    staging: [],
    seal: 'f'.repeat(64),
  })], { type: 'application/json' });

  await t.assertAsyncThrows(
    importLedger(blob, crypto, MASTER_KEY),
    'rejects on missing ledger array in v2'
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 16. v2 Missing staging → Accepted (staging is optional in v2) ===');

{
  const blob = new Blob([JSON.stringify({
    format_version: '2',
    exported_at: '2026-06-24T14:30:00.000Z',
    ledger: SAMPLE_BLOCKS,
    seal: crypto.seal(JSON.stringify(SAMPLE_BLOCKS), MASTER_KEY),
  })], { type: 'application/json' });

  const result = await importLedger(blob, crypto, MASTER_KEY);
  t.assertDeepEq(result.ledger, SAMPLE_BLOCKS, 'accepts v2 without staging field');
  t.assertDeepEq(result.entries, [], 'entries = [] when staging missing');
  t.assertEq(result.count, 0, 'count = 0 when staging missing');
  t.assertEq(result.genesisHash, SAMPLE_BLOCKS[0].day_hash, 'genesisHash extracted correctly');
}

// ═════════════════════════════════════════════════════════════════════
const failures = t.summary('ledger_import_v2_test');
process.exit(failures > 0 ? 1 : 0);
