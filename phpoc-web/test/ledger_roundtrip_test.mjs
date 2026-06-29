/**
 * ledger_roundtrip_test.mjs — Full export → import fidelity test suite.
 *
 * Tests that data survives a complete roundtrip: export ledger entries, then
 * import the resulting blob, and verify every field is preserved. Covers
 * v1 (staging-only), v2 (full ledger), active/paused entries, and edge cases.
 *
 * Usage:
 *   node test/ledger_roundtrip_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { MockCrypto } from './mock_crypto.mjs';
import { jsonSort } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Import modules ──────────────────────────────────────────────────
let exportLedger, exportLedgerFull, importLedger;
try {
  const exportMod = await import('../src/services/ledger_export.js');
  exportLedger = exportMod.exportLedger;
  exportLedgerFull = exportMod.exportLedgerFull;
  const importMod = await import('../src/services/ledger_import.js');
  importLedger = importMod.importLedger;
} catch (err) {
  t.assert(false, 'Module load failed: ' + err.message);
  process.exit(1);
}

const crypto = new MockCrypto();
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// ── Helpers ─────────────────────────────────────────────────────────

function makeStagingEntry(overrides = {}) {
  const base = {
    entry_id: overrides.entry_id || 'a1000000-0000-4000-a000-000000000001',
    title: 'Test Entry',
    start_epoch: 1717920000000,
    end_epoch: 1717921800000,
    duration: 1800000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['test'],
    comment: null,
    media: [],
    device_uuid: 'dev-dummy-001',
    end_device_uuid: 'dev-dummy-001',
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

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 1. Modules Load ===');

t.assert(typeof exportLedger === 'function', 'exportLedger loaded');
t.assert(typeof exportLedgerFull === 'function', 'exportLedgerFull loaded');
t.assert(typeof importLedger === 'function', 'importLedger loaded');

// ═════════════════════════════════════════════════════════════════════
// v1 Roundtrip
// ═════════════════════════════════════════════════════════════════════

console.log('\n=== 2. v1 Roundtrip — 5 Simple Entries ===');

{
  const entries = [
    makeStagingEntry({ entry_id: 'e1', title: 'Task 1', duration: 600 }),
    makeStagingEntry({ entry_id: 'e2', title: 'Task 2', duration: 1200 }),
    makeStagingEntry({ entry_id: 'e3', title: 'Task 3', duration: 1800 }),
    makeStagingEntry({ entry_id: 'e4', title: 'Task 4', duration: 2400 }),
    makeStagingEntry({ entry_id: 'e5', title: 'Task 5', duration: 3000 }),
  ];

  const exportBlob = await exportLedger(entries, crypto, MASTER_KEY);
  t.assert(exportBlob instanceof Blob, 'export: returns Blob');

  const result = await importLedger(exportBlob, crypto, MASTER_KEY);
  t.assertEq(result.count, 5, 'import: count = 5');
  t.assertEq(result.formatVersion, '1', 'import: formatVersion = "1"');
  t.assertDeepEq(result.entries, entries, 'roundtrip: all 5 entries match');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 3. v1 Roundtrip — Active Entry ===');

{
  const active = makeStagingEntry({
    entry_id: 'active-rt',
    title: 'Ongoing task',
    is_active: true,
    is_paused: false,
    end_epoch: null,
    duration: 0,
  });

  const exportBlob = await exportLedger([active], crypto, MASTER_KEY);
  const result = await importLedger(exportBlob, crypto, MASTER_KEY);

  t.assertEq(result.entries[0].is_active, true, 'is_active preserved');
  t.assertEq(result.entries[0].end_epoch, null, 'end_epoch is null');
  t.assertEq(result.entries[0].duration, 0, 'duration is 0');
  t.assertEq(result.entries[0].title, 'Ongoing task', 'title preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 4. v1 Roundtrip — Paused Entry ===');

{
  const paused = makeStagingEntry({
    entry_id: 'paused-rt',
    title: 'Paused task',
    is_active: true,
    is_paused: true,
    end_epoch: null,
    duration: 450,
    pauses: [
      { pause_start: 1717921000000 },
      { pause_start: 1717922000000 },
    ],
  });

  const exportBlob = await exportLedger([paused], crypto, MASTER_KEY);
  const result = await importLedger(exportBlob, crypto, MASTER_KEY);

  t.assertEq(result.entries[0].is_paused, true, 'is_paused preserved');
  t.assertEq(result.entries[0].pauses.length, 2, 'pauses array length preserved');
  t.assertEq(result.entries[0].pauses[0].pause_start, 1717921000000, 'pause_start preserved');
  t.assertEq(result.entries[0].pauses[1].pause_start, 1717922000000, 'second pause preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 5. v1 Roundtrip — Entry with Tags, Comment, Media ===');

{
  const rich = makeStagingEntry({
    entry_id: 'rich-rt',
    title: 'Rich entry',
    tags: ['work', 'focus', 'urgent'],
    comment: 'Finished the quarterly report draft',
    media: [{ type: 'screenshot', url: 'blob:test' }],
    metadata: { priority: 'high', client: 'Acme' },
  });

  const exportBlob = await exportLedger([rich], crypto, MASTER_KEY);
  const result = await importLedger(exportBlob, crypto, MASTER_KEY);

  t.assertDeepEq(result.entries[0].tags, ['work', 'focus', 'urgent'], 'tags preserved');
  t.assertEq(result.entries[0].comment, 'Finished the quarterly report draft', 'comment preserved');
  t.assertDeepEq(result.entries[0].media, [{ type: 'screenshot', url: 'blob:test' }], 'media preserved');
  t.assertDeepEq(result.entries[0].metadata, { priority: 'high', client: 'Acme' }, 'metadata preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 6. v1 Roundtrip — Empty List ===');

{
  const exportBlob = await exportLedger([], crypto, MASTER_KEY);
  const result = await importLedger(exportBlob, crypto, MASTER_KEY);

  t.assertEq(result.count, 0, 'count = 0');
  t.assertDeepEq(result.entries, [], 'entries = []');
  t.assert(typeof result.genesisHash === 'string' || result.genesisHash === null,
    'genesisHash is null or string');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 7. v1 Roundtrip — Wrong Key on Import → Reject ===');

{
  const entries = [makeStagingEntry({ title: 'Secret task' })];
  const exportBlob = await exportLedger(entries, crypto, MASTER_KEY);

  await t.assertAsyncThrows(
    importLedger(exportBlob, crypto, 'a'.repeat(64)),
    'roundtrip fails with wrong master key'
  );
}

// ═════════════════════════════════════════════════════════════════════
// v2 Roundtrip
// ═════════════════════════════════════════════════════════════════════

console.log('\n=== 8. v2 Roundtrip — Blocks + Staging ===');

{
  const staging = [
    makeStagingEntry({ entry_id: 'stg-a', title: 'Pending A' }),
    makeStagingEntry({ entry_id: 'stg-b', title: 'Pending B' }),
  ];

  const exportBlob = await exportLedgerFull(SAMPLE_BLOCKS, staging, crypto, MASTER_KEY);
  t.assert(exportBlob instanceof Blob, 'export: returns Blob');

  const result = await importLedger(exportBlob, crypto, MASTER_KEY);
  t.assertEq(result.formatVersion, '2', 'import: formatVersion = "2"');
  t.assertEq(result.count, 2, 'import: staging count = 2');
  t.assertDeepEq(result.entries, staging, 'roundtrip: staging entries match');
  t.assertDeepEq(result.ledger, SAMPLE_BLOCKS, 'roundtrip: blocks match');
  t.assertEq(result.genesisHash, SAMPLE_BLOCKS[0].day_hash, 'genesisHash preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 9. v2 Roundtrip — Empty Staging ===');

{
  const exportBlob = await exportLedgerFull(SAMPLE_BLOCKS, [], crypto, MASTER_KEY);
  const result = await importLedger(exportBlob, crypto, MASTER_KEY);

  t.assertEq(result.count, 0, 'staging count = 0');
  t.assertDeepEq(result.entries, [], 'entries = []');
  t.assertDeepEq(result.ledger, SAMPLE_BLOCKS, 'blocks preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 10. v2 Roundtrip — Active Staging in v2 ===');

{
  const activeStaging = [
    makeStagingEntry({
      entry_id: 'v2-active',
      title: 'v2 Active task',
      is_active: true,
      end_epoch: null,
      duration: 0,
    }),
  ];

  const exportBlob = await exportLedgerFull(SAMPLE_BLOCKS, activeStaging, crypto, MASTER_KEY);
  const result = await importLedger(exportBlob, crypto, MASTER_KEY);

  t.assertEq(result.entries[0].is_active, true, 'active flag in v2 preserved');
  t.assertEq(result.entries[0].end_epoch, null, 'null end_epoch in v2 preserved');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 11. Deterministic Export — Same Data → Same Blob ===');

{
  const entries = [makeStagingEntry({ title: 'Deterministic test' })];

  const blob1 = await exportLedger(entries, crypto, MASTER_KEY);
  const blob2 = await exportLedger(entries, crypto, MASTER_KEY);

  // Blobs will differ in exported_at timestamp, but seal must be identical
  const p1 = JSON.parse(await blob1.text());
  const p2 = JSON.parse(await blob2.text());

  t.assertEq(p1.seal, p2.seal, 'seal is deterministic across exports');
  t.assertDeepEq(p1.entries, p2.entries, 'entries identical');
  t.assertEq(p1.format_version, p2.format_version, 'format_version identical');
  // exported_at differs — that's expected
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 12. Export Blob Readable as Text ===');

{
  const entries = [makeStagingEntry({ title: 'Readme' })];
  const blob = await exportLedger(entries, crypto, MASTER_KEY);

  const text = await blob.text();
  t.assert(typeof text === 'string', 'text() returns string');
  t.assert(text.length > 0, 'text is non-empty');

  const parsed = JSON.parse(text);
  t.assert(parsed.format_version === '1', 'parsed has format_version');
  t.assert(Array.isArray(parsed.entries), 'parsed has entries array');
  t.assert(typeof parsed.seal === 'string' && parsed.seal.length === 64, 'parsed has valid seal');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n=== 13. Chain-Like Structure Roundtrip (as v2) ===');

{
  // Genesis-only chain exported as v2
  const genesisOnly = [SAMPLE_BLOCKS[0]];
  const exportBlob = await exportLedgerFull(genesisOnly, [], crypto, MASTER_KEY);
  const result = await importLedger(exportBlob, crypto, MASTER_KEY);

  t.assertEq(result.formatVersion, '2', 'formatVersion = "2"');
  t.assertEq(result.genesisHash, genesisOnly[0].day_hash, 'genesisHash extracted');
  t.assertDeepEq(result.ledger, genesisOnly, 'genesis block roundtripped');
  t.assertDeepEq(result.entries, [], 'no staging');
}

// ═════════════════════════════════════════════════════════════════════
// Group C: Roundtrip with readEntries()-shaped entries (Step 5 TDD)
// ═════════════════════════════════════════════════════════════════════

console.log('\n=== 14. C1 — Roundtrip with readEntries()-shaped entries (v1) ===');

{
  // REPRODUCER: entries shaped like real readEntries() output, where
  // extra fields (committed, block_index, entry_index, end_device_uuid)
  // were added AFTER the original hash was computed.
  const entry1 = {
    entry_id: 'c1-0001-0000-4000-a000-000000000001',
    title: 'C1 Task 1',
    start_epoch: 1717920000000,
    end_epoch: 1717921800000,
    duration: 1800000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['test'],
    comment: null,
    media: [],
    device_uuid: 'dev-dummy-001',
    end_device_uuid: 'dev-dummy-001',
    metadata: {},
    // Extra fields added by LocalCache.append() after hash computation
    committed: false,
    block_index: null,
    entry_index: 0,
  };
  // Compute stale hash over core fields only (mimics the real bug)
  const core1 = {};
  for (const k of Object.keys(entry1).sort()) {
    if (k !== 'hash' && k !== 'committed' && k !== 'block_index' && k !== 'entry_index') {
      core1[k] = entry1[k];
    }
  }
  entry1.hash = crypto.sha256(jsonSort(core1));

  const entry2 = {
    entry_id: 'c1-0002-0000-4000-a000-000000000002',
    title: 'C1 Task 2',
    start_epoch: 1717930000000,
    end_epoch: 1717933600000,
    duration: 3600000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['work'],
    comment: 'Some notes',
    media: [],
    device_uuid: 'dev-dummy-001',
    end_device_uuid: 'dev-dummy-001',
    metadata: { priority: 'low' },
    committed: false,
    block_index: null,
    entry_index: 1,
  };
  const core2 = {};
  for (const k of Object.keys(entry2).sort()) {
    if (k !== 'hash' && k !== 'committed' && k !== 'block_index' && k !== 'entry_index') {
      core2[k] = entry2[k];
    }
  }
  entry2.hash = crypto.sha256(jsonSort(core2));

  // Export → Import roundtrip
  const exportBlob = await exportLedger([entry1, entry2], crypto, MASTER_KEY);
  t.assert(exportBlob instanceof Blob, 'C1: export returns Blob');

  const result = await importLedger(exportBlob, crypto, MASTER_KEY);
  t.assertEq(result.count, 2, 'C1: import count = 2');
  t.assertEq(result.formatVersion, '1', 'C1: formatVersion = "1"');

  // Verify all fields preserved including extra fields
  const imported = result.entries;
  t.assertEq(imported[0].title, 'C1 Task 1', 'C1: entry[0] title preserved');
  t.assertEq(imported[0].committed, false, 'C1: entry[0] committed preserved');
  t.assertEq(imported[0].block_index, null, 'C1: entry[0] block_index preserved');
  t.assertEq(imported[0].entry_index, 0, 'C1: entry[0] entry_index preserved');
  t.assertEq(imported[1].title, 'C1 Task 2', 'C1: entry[1] title preserved');
  t.assertEq(imported[1].committed, false, 'C1: entry[1] committed preserved');
  t.assertEq(imported[1].entry_index, 1, 'C1: entry[1] entry_index preserved');
  t.assertEq(imported[1].metadata.priority, 'low', 'C1: entry[1] metadata preserved');
}

console.log('\n=== 15. C2 — Roundtrip with readEntries()-shaped entries (v2) ===');

{
  // Two staging entries with extra fields + two ledger blocks
  const staging = [
    {
      entry_id: 'c2-stg1-0000-4000-a000-000000000001',
      title: 'C2 Staging 1',
      start_epoch: 1717920000000,
      end_epoch: 1717921800000,
      duration: 1800000,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags: ['c2'],
      comment: null,
      media: [],
      device_uuid: 'dev-dummy-001',
      end_device_uuid: 'dev-dummy-001',
      metadata: {},
      committed: false,
      block_index: null,
      entry_index: 0,
    },
    {
      entry_id: 'c2-stg2-0000-4000-a000-000000000002',
      title: 'C2 Staging 2',
      start_epoch: 1717930000000,
      end_epoch: 1717933600000,
      duration: 3600000,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags: ['c2'],
      comment: null,
      media: [],
      device_uuid: 'dev-dummy-001',
      end_device_uuid: 'dev-dummy-001',
      metadata: {},
      committed: false,
      block_index: null,
      entry_index: 1,
    },
  ];

  // Set stale hashes (core fields only, without committed/block_index/entry_index)
  for (const entry of staging) {
    const core = {};
    for (const k of Object.keys(entry).sort()) {
      if (k !== 'hash' && k !== 'committed' && k !== 'block_index' && k !== 'entry_index') {
        core[k] = entry[k];
      }
    }
    entry.hash = crypto.sha256(jsonSort(core));
  }

  const exportBlob = await exportLedgerFull(SAMPLE_BLOCKS, staging, crypto, MASTER_KEY);
  t.assert(exportBlob instanceof Blob, 'C2: export returns Blob');

  const result = await importLedger(exportBlob, crypto, MASTER_KEY);
  t.assertEq(result.formatVersion, '2', 'C2: formatVersion = "2"');
  t.assertEq(result.count, 2, 'C2: import staging count = 2');

  // C2.1: Staging entries match (including extra fields)
  t.assertEq(result.entries[0].title, 'C2 Staging 1', 'C2: staging[0] title preserved');
  t.assertEq(result.entries[0].committed, false, 'C2: staging[0] committed preserved');
  t.assertEq(result.entries[0].entry_index, 0, 'C2: staging[0] entry_index preserved');
  t.assertEq(result.entries[1].title, 'C2 Staging 2', 'C2: staging[1] title preserved');

  // C2.2: Ledger blocks match
  t.assertDeepEq(result.ledger, SAMPLE_BLOCKS, 'C2: ledger blocks match');
  t.assertEq(result.genesisHash, SAMPLE_BLOCKS[0].day_hash, 'C2: genesisHash preserved');
}

console.log('\n=== 16. C3 — Active entry with missing fields ===');

{
  // Active entries from LocalCache.append() have different shape:
  // no end_device_uuid, end_epoch: null. Roundtrip must preserve these.
  const active = {
    entry_id: 'c3-active-0000-4000-a000-000000000001',
    title: 'C3 Active Task',
    start_epoch: 1717920000000,
    end_epoch: null,
    duration: 0,
    is_active: true,
    is_paused: false,
    pauses: [],
    tags: ['active'],
    comment: null,
    media: [],
    device_uuid: 'dev-dummy-001',
    metadata: {},
    // Extra fields from app flow
    committed: false,
    block_index: null,
    entry_index: 0,
  };

  const stopped = {
    entry_id: 'c3-stopped-0000-4000-a000-000000000002',
    title: 'C3 Stopped Task',
    start_epoch: 1717930000000,
    end_epoch: 1717933600000,
    duration: 3600000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: ['done'],
    comment: null,
    media: [],
    device_uuid: 'dev-dummy-001',
    end_device_uuid: 'dev-dummy-001',
    metadata: {},
    committed: false,
    block_index: null,
    entry_index: 1,
  };

  // Set stale hashes (core fields only)
  for (const entry of [active, stopped]) {
    const core = {};
    for (const k of Object.keys(entry).sort()) {
      if (k !== 'hash' && k !== 'committed' && k !== 'block_index' && k !== 'entry_index') {
        core[k] = entry[k];
      }
    }
    entry.hash = crypto.sha256(jsonSort(core));
  }

  const exportBlob = await exportLedger([active, stopped], crypto, MASTER_KEY);
  const result = await importLedger(exportBlob, crypto, MASTER_KEY);

  t.assertEq(result.count, 2, 'C3: import count = 2');

  // C3.1: Active entry: end_epoch is null, no end_device_uuid
  t.assertEq(result.entries[0].end_epoch, null, 'C3: active entry end_epoch is null');
  t.assertEq(result.entries[0].end_device_uuid, undefined, 'C3: active entry has no end_device_uuid');
  t.assertEq(result.entries[0].is_active, true, 'C3: active entry is_active = true');

  // C3.2: Stopped entry: end_epoch is a number, end_device_uuid present
  t.assert(typeof result.entries[1].end_epoch === 'number', 'C3: stopped entry end_epoch is a number');
  t.assertEq(result.entries[1].end_device_uuid, 'dev-dummy-001', 'C3: stopped entry end_device_uuid present');
  t.assertEq(result.entries[1].is_active, false, 'C3: stopped entry is_active = false');
}

console.log('\n=== 17. C4 — Single active entry from app flow (v2) ===');

{
  // Mimic the exact E2E export scenario that failed: 1 genesis block +
  // 1 active staging entry + 1 stopped staging entry, with extra app fields.
  const appStaging = [
    {
      entry_id: 'c4-act-0000-4000-a000-000000000001',
      title: 'C4 Active Work',
      start_epoch: 1717920000000,
      end_epoch: null,
      duration: 0,
      is_active: true,
      is_paused: false,
      pauses: [],
      tags: ['work'],
      comment: 'In progress',
      media: [],
      device_uuid: 'dev-dummy-001',
      metadata: {},
      committed: false,
      block_index: null,
      entry_index: 0,
    },
    {
      entry_id: 'c4-stp-0000-4000-a000-000000000002',
      title: 'C4 Completed Task',
      start_epoch: 1717930000000,
      end_epoch: 1717933600000,
      duration: 3600000,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags: ['done'],
      comment: 'All finished',
      media: [],
      device_uuid: 'dev-dummy-001',
      end_device_uuid: 'dev-dummy-001',
      metadata: {},
      committed: false,
      block_index: null,
      entry_index: 1,
    },
  ];

  // Set stale hashes for both
  for (const entry of appStaging) {
    const core = {};
    for (const k of Object.keys(entry).sort()) {
      if (k !== 'hash' && k !== 'committed' && k !== 'block_index' && k !== 'entry_index') {
        core[k] = entry[k];
      }
    }
    entry.hash = crypto.sha256(jsonSort(core));
  }

  // Use genesis-only blocks (matching real app scenario)
  const genesisBlocks = [SAMPLE_BLOCKS[0]];

  const exportBlob = await exportLedgerFull(genesisBlocks, appStaging, crypto, MASTER_KEY);
  t.assert(exportBlob instanceof Blob, 'C4: export v2 returns Blob');

  const result = await importLedger(exportBlob, crypto, MASTER_KEY);
  t.assertEq(result.formatVersion, '2', 'C4: formatVersion = "2"');
  t.assertEq(result.count, 2, 'C4: import count = 2');

  // C4.1: Genesis hash extracted correctly
  t.assertEq(result.genesisHash, SAMPLE_BLOCKS[0].day_hash, 'C4: genesisHash extracted');

  // C4.2: Both entries roundtripped with all fields intact
  t.assertEq(result.entries[0].title, 'C4 Active Work', 'C4: active entry title preserved');
  t.assertEq(result.entries[0].is_active, true, 'C4: active entry flag preserved');
  t.assertEq(result.entries[0].comment, 'In progress', 'C4: active entry comment preserved');
  t.assertEq(result.entries[1].title, 'C4 Completed Task', 'C4: stopped entry title preserved');
  t.assertEq(result.entries[1].duration, 3600000, 'C4: stopped entry duration preserved');
  t.assertEq(result.entries[1].comment, 'All finished', 'C4: stopped entry comment preserved');
  t.assertDeepEq(result.ledger, genesisBlocks, 'C4: genesis block roundtripped');
}

// ═════════════════════════════════════════════════════════════════════
const failures = t.summary('ledger_roundtrip_test');
process.exit(failures > 0 ? 1 : 0);
