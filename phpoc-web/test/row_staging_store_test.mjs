/**
 * row_staging_store_test.mjs — RowStagingStore CRUD tests (Group S).
 *
 * TDD RED phase: Tests the RowStagingStore IndexedDB-backed store with
 * activity_id as key path. Uses MemoryBackend for unit tests.
 *
 * Test groups:
 *   S1–S25: RowStagingStore CRUD — read/write/delete, bulk ops, edge cases.
 *
 * All tests should FAIL in RED phase (implementation does not exist yet).
 *
 * Usage:
 *   node test/row_staging_store_test.mjs
 */

import { TestHelpers } from './test_helpers.mjs';
import { MemoryBackend } from '../src/sync/storage.js';

// Import from module that doesn't exist yet (RED phase):
import { RowStagingStore } from '../src/sync/row_staging_store.js';

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

/**
 * Create a valid test row.
 * @param {string} [activityId]
 * @param {string} [status]
 * @param {number} [updatedAt]
 * @returns {{activity_id: string, activity_status: string, activity: string, updated_at: number}}
 */
function makeRow(activityId, status = 'staged', updatedAt = Date.now()) {
  return {
    activity_id: activityId || `Test${String(Math.random()).slice(2, 12)}`,
    activity_status: status,
    activity: JSON.stringify({ title: 'Test entry', tags: [] }),
    updated_at: updatedAt,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Group S: RowStagingStore CRUD
// ══════════════════════════════════════════════════════════════════════

async function runTests() {
  console.log('\n── RowStagingStore CRUD ──');

  // ── S1: Core write/read round-trip ──────────────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const row = makeRow('abc123DEFg');
    await store.putRow(row);
    const result = await store.getRow('abc123DEFg');
    t.assert(result !== null, 'S1a: getRow returns non-null after putRow');
    t.assertEq(result.activity_id, 'abc123DEFg', 'S1b: activity_id preserved');
    t.assertEq(result.activity_status, 'staged', 'S1c: activity_status preserved');
  }

  // ── S2: Missing key returns null ────────────────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const result = await store.getRow('nonexistent');
    t.assertEq(result, null, 'S2: getRow for nonexistent returns null');
  }

  // ── S3: Upsert — same activity_id overwrites ────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    await store.putRow(makeRow('upsert1234', 'staged', 1000));
    await store.putRow(makeRow('upsert1234', 'active', 2000));
    const result = await store.getRow('upsert1234');
    t.assertEq(result.activity_status, 'active', 'S3a: upsert updates status');
    t.assertEq(result.updated_at, 2000, 'S3b: upsert updates timestamp');
    // Should be exactly 1 row, not 2
    const all = await store.getAllRows();
    t.assertEq(all.length, 1, 'S3c: upsert does not create duplicate');
  }

  // ── S4: Field completeness on round-trip ────────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const row = {
      activity_id: 'fields45678',
      activity_status: 'paused',
      activity: '{"title":"Complex entry","tags":["a","b"],"duration":3600}',
      updated_at: 1718123400000,
    };
    await store.putRow(row);
    const result = await store.getRow('fields45678');
    t.assertEq(result.activity_id, row.activity_id, 'S4a: activity_id exact match');
    t.assertEq(result.activity_status, row.activity_status, 'S4b: activity_status exact match');
    t.assertEq(result.activity, row.activity, 'S4c: activity exact match');
    t.assertEq(result.updated_at, row.updated_at, 'S4d: updated_at exact match');
  }

  // ── S5: deleteRow removes the row ──────────────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    await store.putRow(makeRow('delMe12345'));
    await store.deleteRow('delMe12345');
    const result = await store.getRow('delMe12345');
    t.assertEq(result, null, 'S5: deleteRow removes row');
  }

  // ── S6: deleteRow on nonexistent does not throw ─────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    let threw = false;
    try {
      await store.deleteRow('nonexistent');
    } catch {
      threw = true;
    }
    t.assert(!threw, 'S6: deleteRow on nonexistent does not throw');
  }

  // ── S7: getAllRows returns all stored rows ──────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    await store.putRow(makeRow('rowAlpha01'));
    await store.putRow(makeRow('rowBeta012'));
    await store.putRow(makeRow('rowGamma01'));
    const all = await store.getAllRows();
    t.assertEq(all.length, 3, 'S7a: getAllRows returns correct count');
    const ids = all.map(r => r.activity_id).sort();
    t.assertDeepEq(ids, ['rowAlpha01', 'rowBeta012', 'rowGamma01'], 'S7b: getAllRows contains all IDs');
  }

  // ── S8: getAllRows returns empty array for empty store ──────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const all = await store.getAllRows();
    t.assert(Array.isArray(all), 'S8a: getAllRows returns array');
    t.assertEq(all.length, 0, 'S8b: getAllRows returns empty array for empty store');
  }

  // ── S9: getAllRows order is deterministic ───────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const ids = ['aRowFirst0', 'bRowSecond', 'cRowThird0'];
    await store.putRow(makeRow(ids[0], 'staged', 1000));
    await store.putRow(makeRow(ids[1], 'staged', 2000));
    await store.putRow(makeRow(ids[2], 'staged', 3000));
    const result1 = await store.getAllRows();
    const result2 = await store.getAllRows();
    const idOrder1 = result1.map(r => r.activity_id);
    const idOrder2 = result2.map(r => r.activity_id);
    t.assertDeepEq(idOrder1, idOrder2, 'S9: getAllRows order is deterministic');
  }

  // ── S10: getRowsByStatus filters correctly ─────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    await store.putRow(makeRow('statActv01', 'active', 1000));
    await store.putRow(makeRow('statStag01', 'staged', 2000));
    await store.putRow(makeRow('statActv02', 'active', 3000));
    await store.putRow(makeRow('statPaus01', 'paused', 4000));

    const active = await store.getRowsByStatus('active');
    t.assertEq(active.length, 2, 'S10a: getRowsByStatus "active" returns 2');
    t.assertDeepEq(active.map(r => r.activity_id).sort(), ['statActv01', 'statActv02'], 'S10b: correct active IDs');

    const staged = await store.getRowsByStatus('staged');
    t.assertEq(staged.length, 1, 'S10c: getRowsByStatus "staged" returns 1');
    t.assertEq(staged[0].activity_id, 'statStag01', 'S10d: correct staged ID');

    const paused = await store.getRowsByStatus('paused');
    t.assertEq(paused.length, 1, 'S10e: getRowsByStatus "paused" returns 1');

    const none = await store.getRowsByStatus('nonexistent');
    t.assertEq(none.length, 0, 'S10f: getRowsByStatus unknown returns empty');
  }

  // ── S11: Large activity blob (512KB) ────────────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const largeActivity = 'x'.repeat(512 * 1024);
    const row = {
      activity_id: 'largeBlob01',
      activity_status: 'staged',
      activity: largeActivity,
      updated_at: Date.now(),
    };
    await store.putRow(row);
    const result = await store.getRow('largeBlob01');
    t.assert(result !== null, 'S11a: large blob row retrievable');
    t.assertEq(result.activity.length, largeActivity.length, 'S11b: large blob preserved exactly');
  }

  // ── S12: put → delete → put with same ID ───────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    await store.putRow(makeRow('recreate01', 'staged', 1000));
    await store.deleteRow('recreate01');
    await store.putRow(makeRow('recreate01', 'active', 2000));
    const result = await store.getRow('recreate01');
    t.assert(result !== null, 'S12a: recreated row exists');
    t.assertEq(result.activity_status, 'active', 'S12b: recreated row has new status');
    t.assertEq(result.updated_at, 2000, 'S12c: recreated row has new timestamp');
    const all = await store.getAllRows();
    t.assertEq(all.length, 1, 'S12d: only one row after recreate');
  }

  // ── S13: Forward-compat — extra fields preserved ────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const row = {
      activity_id: 'futureFld01',
      activity_status: 'staged',
      activity: '{}',
      updated_at: 1000,
      extra_field: 'should survive',
      nested: { key: 'value' },
    };
    await store.putRow(row);
    const result = await store.getRow('futureFld01');
    t.assertEq(result.extra_field, 'should survive', 'S13a: extra string field preserved');
    t.assertDeepEq(result.nested, { key: 'value' }, 'S13b: extra object field preserved');
  }

  // ── S14: Special chars in activity_id accepted at store level ──────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const ids = ['test--id!!', 'under_score', 'dot.name', 'with space'];
    for (const id of ids) {
      await store.putRow(makeRow(id));
    }
    for (const id of ids) {
      const result = await store.getRow(id);
      t.assert(result !== null, `S14-${id}: special char ID stored and retrieved`);
    }
  }

  // ── S15: Concurrent putRow calls all succeed ───────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const ids = ['concur001', 'concur002', 'concur003', 'concur004', 'concur005'];
    await Promise.all(ids.map((id, i) => store.putRow(makeRow(id, 'staged', i * 1000))));
    const all = await store.getAllRows();
    t.assertEq(all.length, 5, 'S15: all concurrent puts succeeded');
  }

  // ── S16: Empty activity string allowed ──────────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const row = { activity_id: 'emptyAct01', activity_status: 'staged', activity: '', updated_at: 1000 };
    await store.putRow(row);
    const result = await store.getRow('emptyAct01');
    t.assertEq(result.activity, '', 'S16: empty activity string preserved');
  }

  // ── S17: Any activity_status value stored (not validated by store) ──
  {
    const store = new RowStagingStore(new MemoryBackend());
    await store.putRow(makeRow('statAny001', 'weird-custom-status', 1000));
    const result = await store.getRow('statAny001');
    t.assertEq(result.activity_status, 'weird-custom-status', 'S17: arbitrary status value stored');
  }

  // ── S18: updated_at of 0 (epoch) stored correctly ───────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const row = makeRow('epochZero01', 'staged', 0);
    await store.putRow(row);
    const result = await store.getRow('epochZero01');
    t.assertEq(result.updated_at, 0, 'S18: updated_at of 0 stored correctly');
  }

  // ── S19: updated_at of MAX_SAFE_INTEGER stored correctly ────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const maxSafe = Number.MAX_SAFE_INTEGER; // 9007199254740991
    const row = makeRow('maxIntTest0', 'staged', maxSafe);
    await store.putRow(row);
    const result = await store.getRow('maxIntTest0');
    t.assertEq(result.updated_at, maxSafe, 'S19: MAX_SAFE_INTEGER stored correctly');
  }

  // ── S20: Store initializes empty ────────────────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const all = await store.getAllRows();
    t.assertEq(all.length, 0, 'S20: new store initializes empty');
  }

  // ── S21: Serialization round-trip fidelity ─────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const row = {
      activity_id: 'serRound001',
      activity_status: 'staged',
      activity: '{"num":123,"bool":true,"str":"hello","null":null,"arr":[1,2,3]}',
      updated_at: 1718123400999,
    };
    await store.putRow(row);
    // Simulate JSON serialization round-trip through MemoryBackend
    const raw = await store.getRow('serRound001');
    const serialized = JSON.stringify(raw);
    const deserialized = JSON.parse(serialized);
    t.assertEq(deserialized.activity_id, 'serRound001', 'S21a: activity_id survives serialization');
    t.assertEq(deserialized.updated_at, 1718123400999, 'S21b: large int survives serialization');
    t.assertEq(deserialized.activity, row.activity, 'S21c: nested JSON string survives serialization');
  }

  // ── S22: activity_status null stored as-is ─────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const row = { activity_id: 'nullStat001', activity_status: null, activity: '{}', updated_at: 1000 };
    await store.putRow(row);
    const result = await store.getRow('nullStat001');
    t.assertEq(result.activity_status, null, 'S22: null activity_status preserved');
  }

  // ── S23: updated_at NaN handled (not crash) ────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    const row = { activity_id: 'nanTime001', activity_status: 'staged', activity: '{}', updated_at: NaN };
    let threw = false;
    try {
      await store.putRow(row);
      // If it stores, verify getRow returns something (content defined by store)
      const result = await store.getRow('nanTime001');
      t.assert(result !== null, 'S23a: NaN updated_at row stored without crashing');
    } catch {
      threw = true;
    }
    t.assert(!threw, 'S23b: putRow with NaN updated_at does not throw');
  }

  // ── S24: Bulk getAllRows performance (100+ rows) ────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    for (let i = 0; i < 150; i++) {
      await store.putRow(makeRow(`perfRow${String(i).padStart(5, '0')}`, 'staged', i * 1000));
    }
    const start = Date.now();
    const all = await store.getAllRows();
    const elapsed = Date.now() - start;
    t.assertEq(all.length, 150, 'S24a: getAllRows returns all 150 rows');
    t.assert(elapsed < 100, `S24b: getAllRows completes under 100ms (${elapsed}ms)`);
  }

  // ── S25: Repeated overwrites return latest ─────────────────────────
  {
    const store = new RowStagingStore(new MemoryBackend());
    await store.putRow(makeRow('latestWin01', 'staged', 1000));
    await store.putRow(makeRow('latestWin01', 'active', 2000));
    await store.putRow(makeRow('latestWin01', 'paused', 3000));
    await store.putRow(makeRow('latestWin01', 'staged', 4000));
    const result = await store.getRow('latestWin01');
    t.assertEq(result.activity_status, 'staged', 'S25a: latest write wins for status');
    t.assertEq(result.updated_at, 4000, 'S25b: latest write wins for timestamp');
  }

  // ══════════════════════════════════════════════════════════════════
  console.log(`\n── Results: ${t.passed} passed, ${t.failed} failed ──`);
  if (t.errors.length > 0) {
    console.log('Failed tests:');
    t.errors.forEach(e => console.log(`  ${e}`));
  }
  process.exit(t.failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
