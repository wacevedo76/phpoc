/**
 * encrypt_entry_fields_index_test.mjs — Encrypt All Entry Fields: Blind Index (Phase 2 RED)
 *
 * Group F from the Phase 1 blueprint:
 *   docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_WEB_PHASE1.md
 *
 * Tests that the blind index skips entries with encrypted titles
 * (title_enc present = title unavailable for grouping).
 *
 * Usage:
 *   node test/encrypt_entry_fields_index_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ── Import module under test ──
let IndexManager;
try {
  const mod = await import('../src/ledger/index_manager.js');
  IndexManager = mod.IndexManager;
} catch (err) {
  IndexManager = undefined;
}

// ══════════════════════════════════════════════════════════════════════
// Group F: Blind Index — 4 tests
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ Encrypt All Entry Fields — Blind Index Tests (Phase 2 RED) ══\n');
  console.log('Group F: Blind index skips encrypted-title entries (4 tests)');
  console.log('Expected: ALL RED — implementation is Phase 3\n');

  // All tests depend on IndexManager being importable
  if (typeof IndexManager !== 'function') {
    console.log('SKIP: IndexManager not importable yet\n');
    return;
  }

  // ── F1: Index builder skips entries with title_enc ──
  {
    const store = new MemoryBackend();
    const index = new IndexManager(store);

    // Populate entries with a mix of encrypted and plaintext titles
    // Direct storage write simulating index build from entries
    // The index build function (to be implemented) should iterate entries
    // and skip those with title_enc

    // For now, test at the update() API level — we need a new method
    // like buildFromEntries(entries) that filters out encrypted titles.
    // If IndexManager doesn't have it yet, this test will fail.
    const entries = [
      {
        entry_id: 'e1',
        title: 'Plain Entry',
        start_epoch: 1700000000000,
        duration: 3600000,
        date: '2026-01-15',
      },
      {
        entry_id: 'e2',
        title: '',
        title_enc: 'abc123def456',  // Encrypted title — should be skipped
        start_epoch: 1700000000000,
        duration: 1800000,
        date: '2026-01-15',
        has_encrypted_fields: true,
      },
      {
        entry_id: 'e3',
        title: 'Another Plain',
        start_epoch: 1700000000000,
        duration: 5400000,
        date: '2026-01-15',
      },
    ];

    // Future API: buildFromEntries() filters encrypted entries
    if (typeof index.buildFromEntries === 'function') {
      index.buildFromEntries(entries);
      const result = index.getAll();
      // Only plaintext entries should be included
      t.assert(result['2026-01-15'] !== undefined, 'F1a. date entry exists');
      t.assertEq(result['2026-01-15']['Plain Entry'], 3600000,
        'F1b. plain entry included');
      t.assertEq(result['2026-01-15']['Another Plain'], 5400000,
        'F1c. second plain entry included');
      t.assert(result['2026-01-15'][''] === undefined,
        'F1. encrypted-title entry excluded from index');
    } else {
      // IndexManager doesn't have buildFromEntries yet — RED
      t.assert(false, 'F1. IndexManager.buildFromEntries() exists (RED: not yet implemented)');
    }
  }

  // ── F2: Index includes plaintext-title entries normally ──
  {
    const store = new MemoryBackend();
    const index = new IndexManager(store);

    // All entries have plaintext titles — all should be included
    const entries = [
      {
        entry_id: 'e1',
        title: 'Coding',
        start_epoch: 1700000000000,
        duration: 3600000,
        date: '2026-01-15',
      },
      {
        entry_id: 'e2',
        title: 'Reading',
        start_epoch: 1700000000000,
        duration: 1800000,
        date: '2026-01-15',
      },
    ];

    if (typeof index.buildFromEntries === 'function') {
      index.buildFromEntries(entries);
      const result = index.getAll();
      t.assertEq(result['2026-01-15']['Coding'], 3600000,
        'F2a. Coding included');
      t.assertEq(result['2026-01-15']['Reading'], 1800000,
        'F2. Reading included — plaintext entries indexed normally');
    } else {
      t.assert(false, 'F2. buildFromEntries exists (RED)');
    }
  }

  // ── F3: reputation query excludes encrypted entries ──
  {
    const store = new MemoryBackend();
    const index = new IndexManager(store);

    // Build index with a mix: 2 plaintext + 1 encrypted
    // Reputation query should only count plaintext entries
    const entries = [
      {
        entry_id: 'e1',
        title: 'Coding',
        start_epoch: 1700000000000,
        duration: 3600000,
        date: '2026-01-15',
      },
      {
        entry_id: 'e2',
        title: '',
        title_enc: 'deadbeef',
        start_epoch: 1700000000000,
        duration: 1800000,
        date: '2026-01-15',
        has_encrypted_fields: true,
      },
      {
        entry_id: 'e3',
        title: 'Coding',
        start_epoch: 1700000000000,
        duration: 5400000,
        date: '2026-01-16',
      },
    ];

    if (typeof index.buildFromEntries === 'function') {
      index.buildFromEntries(entries);
      // Query should only aggregate plaintext entries
      const result = index.query('2026-01-15', '2026-01-16');
      t.assertEq(result['Coding'], 3600000 + 5400000,
        'F3. reputation query excludes encrypted entries — Coding = 9000000');
      // No entry with encrypted title should contribute
      t.assert(Object.keys(result).length === 1,
        'F3b. only Coding in query result (encrypted entry excluded)');
    } else {
      t.assert(false, 'F3. buildFromEntries exists (RED)');
    }
  }

  // ── F4: Rebuilding index does not add encrypted entries ──
  {
    const store = new MemoryBackend();
    const index = new IndexManager(store);

    const entries = [
      {
        entry_id: 'e1',
        title: 'Visible',
        start_epoch: 1700000000000,
        duration: 1000,
        date: '2026-01-15',
      },
      {
        entry_id: 'e2',
        title: '',
        title_enc: 'secret-encrypted-title',
        start_epoch: 1700000000000,
        duration: 9999,
        date: '2026-01-15',
        has_encrypted_fields: true,
      },
    ];

    if (typeof index.buildFromEntries === 'function') {
      // First build
      index.buildFromEntries(entries);
      const first = index.getAll();
      t.assertEq(first['2026-01-15']['Visible'], 1000, 'F4a. first build correct');

      // Rebuild — must not leak encrypted entries
      // Force empty state and rebuild
      index.clear();
      index.buildFromEntries(entries);
      const second = index.getAll();
      t.assert(second['2026-01-15']['Visible'] !== undefined,
        'F4b. plaintext entry still present after rebuild');
      t.assert(Object.keys(second['2026-01-15']).length === 1,
        'F4. rebuild does not add encrypted entries (only 1 title)');
    } else {
      t.assert(false, 'F4. buildFromEntries exists (RED)');
    }
  }

  t.summary('Encrypt Entry Fields — Blind Index (Group F)');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
