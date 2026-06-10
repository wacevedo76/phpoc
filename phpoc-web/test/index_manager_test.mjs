/**
 * index_manager_test.mjs — IndexManager test suite.
 *
 * Tests the blind index: {date: {title: total_duration_ms}}.
 * The index is derived data — fully rebuildable from the ledger chain.
 *
 * Option B: consumes StorageBackend (MemoryBackend) directly
 * via key convention "ledger:index".
 *
 * TDD: RED phase — source file doesn't exist yet.
 *
 * Usage:
 *   node test/index_manager_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';

// ── Import module under test (WILL FAIL — doesn't exist yet) ──
let IndexManager;
try {
  const mod = await import('../src/ledger/index_manager.js');
  IndexManager = mod.IndexManager;
} catch (err) {
  // Expected: module doesn't exist yet → all tests will fail
  IndexManager = undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, label) {
  if (condition) { passed++; process.stdout.write('  ✓'); }
  else { failed++; errors.push(label); process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 160)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 160)}`);
  }
  console.log(`  ${label}`);
}

function assertDeepEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 300)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 300)}`);
  }
  console.log(`  ${label}`);
}

// ─────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────
console.log('\n=== IndexManager Class Exists ===');

assert(typeof IndexManager === 'function', 'IndexManager is a constructor');

if (typeof IndexManager === 'function') {
  // ── Empty state ────────────────────────────────────
  console.log('\n=== Empty State ===');

  const store = new MemoryBackend();
  const index = new IndexManager(store);

  // Test 1: Empty index returns {} for any query
  assertDeepEq(index.getAll(), {}, 'getAll() returns {} on empty index');

  // Test 2: Query on empty index returns {}
  assertDeepEq(index.query('2026-01-01', '2026-01-31'), {},
    'query() returns {} on empty index');

  // Test 3: Query with from > to on empty index returns {}
  assertDeepEq(index.query('2026-02-01', '2026-01-01'), {},
    'query() with from>to on empty index returns {}');

  // ── Update operations ──────────────────────────────
  console.log('\n=== Update Operations ===');

  // Test 4: update creates a new date entry
  index.update('2026-01-15', 'Morning Run', 3600000);
  const all1 = index.getAll();
  assert(typeof all1['2026-01-15'] === 'object', 'update creates date entry');
  assertEq(typeof all1['2026-01-15']['Morning Run'], 'number', 'update creates title entry with number');
  assertEq(all1['2026-01-15']['Morning Run'], 3600000, 'update stores correct duration');

  // Test 5: update accumulates duration for same date + title
  index.update('2026-01-15', 'Morning Run', 1800000);
  assertEq(index.getAll()['2026-01-15']['Morning Run'], 5400000,
    'update accumulates duration');

  // Test 6: update with different title on same date
  index.update('2026-01-15', 'Reading', 7200000);
  assertEq(index.getAll()['2026-01-15']['Reading'], 7200000,
    'update adds different title on same date');
  assertEq(index.getAll()['2026-01-15']['Morning Run'], 5400000,
    'existing title still correct after adding second title');

  // Test 7: update with different date
  index.update('2026-01-16', 'Morning Run', 4000000);
  assertEq(index.getAll()['2026-01-16']['Morning Run'], 4000000,
    'update on different date creates separate entry');

  // Test 8: update with negative delta removes title when total <= 0
  index.update('2026-01-15', 'Morning Run', -5400000);
  const afterRemove = index.getAll()['2026-01-15'];
  assert(afterRemove['Morning Run'] === undefined || afterRemove['Morning Run'] === null,
    'update with negative delta removes title when total <= 0');

  // Test 9: update with negative delta removes date when last title is removed
  // 'Reading' is still on 2026-01-15, so date should still exist
  index.update('2026-01-15', 'Reading', -7200000);
  assertEq(index.getAll()['2026-01-15'], undefined,
    'update removes date entry when last title is removed');

  // Test 10: update with negative delta on nonexistent title does nothing
  index.update('2026-01-20', 'Ghost', -1000);
  assertEq(index.getAll()['2026-01-20'], undefined,
    'update with negative delta on nonexistent date does nothing');

  // Test 11: update with negative delta on nonexistent date does nothing
  index.update('2026-01-25', 'Nothing', 0);
  assertEq(index.getAll()['2026-01-25'], undefined,
    'update with 0 delta on nonexistent title does nothing');

  // ── Query operations ───────────────────────────────
  console.log('\n=== Query Operations ===');

  // Set up data for queries
  index.update('2026-01-10', 'Coding', 3600000);
  index.update('2026-01-10', 'Reading', 1800000);
  index.update('2026-01-15', 'Coding', 7200000);
  index.update('2026-01-15', 'Fitness', 2400000);
  index.update('2026-01-20', 'Reading', 5400000);
  index.update('2026-01-20', 'Coding', 3600000);

  // Test 12: query over exact range
  const range1 = index.query('2026-01-10', '2026-01-20');
  assertEq(range1['Coding'], 3600000 + 7200000 + 3600000, 'query aggregates Coding correctly');
  assertEq(range1['Reading'], 1800000 + 5400000, 'query aggregates Reading correctly');
  assertEq(range1['Fitness'], 2400000, 'query aggregates Fitness correctly');

  // Test 13: query over single day
  const singleDay = index.query('2026-01-15', '2026-01-15');
  assertEq(singleDay['Coding'], 7200000, 'query single day returns correct Coding');
  assertEq(singleDay['Fitness'], 2400000, 'query single day returns correct Fitness');
  assertEq(singleDay['Reading'], undefined, 'query single day excludes other dates');

  // Test 14: query with from > to returns {}
  const emptyRange = index.query('2026-02-01', '2026-01-01');
  assertDeepEq(emptyRange, {}, 'query with from>to returns {}');

  // Test 15: query with range that has no data
  const noData = index.query('2026-03-01', '2026-03-31');
  assertDeepEq(noData, {}, 'query with no matching dates returns {}');

  // Test 16: query partial overlap (start before first data, end in middle)
  const partialRange = index.query('2026-01-01', '2026-01-15');
  assert(typeof partialRange['Coding'] === 'number', 'partial range includes matching dates');
  assert(partialRange['Reading'] === undefined || partialRange['Reading'] === 1800000,
    'partial range includes 2026-01-10 data but not 2026-01-20');

  // ── Clear operations ───────────────────────────────
  console.log('\n=== Clear Operations ===');

  // Test 17: clear removes all data
  index.clear();
  assertDeepEq(index.getAll(), {}, 'clear() empties the index');
  assertDeepEq(index.query('2026-01-01', '2026-01-31'), {},
    'query returns {} after clear()');

  // ── Reload from store ──────────────────────────────
  console.log('\n=== Reload from Store ===');

  // Test 18: reload picks up external changes to the store
  const storeR = new MemoryBackend();
  const idxR = new IndexManager(storeR);
  idxR.update('2026-02-01', 'Guitar', 1800000);
  idxR.update('2026-02-01', 'Reading', 3600000);
  assertEq(idxR.getAll()['2026-02-01']['Guitar'], 1800000, 'setup: data stored');

  // Manually write to the underlying store (simulating external modification)
  // First record what's in the store
  const storedBefore = await storeR.get('ledger:index');
  const modifiedData = { ...storedBefore, '2026-02-02': { 'Guitar': 3600000 } };
  await storeR.set('ledger:index', modifiedData);

  // Test 19: before reload, cache has old data (no 2026-02-02)
  assertEq(idxR.getAll()['2026-02-02'], undefined,
    'before reload, external changes not visible');

  // Test 20: after reload, external changes visible
  idxR.reload();
  assertEq(idxR.getAll()['2026-02-02']['Guitar'], 3600000,
    'after reload, external changes are visible');

  // Test 21: reload with empty store
  const storeEmpty = new MemoryBackend();
  const idxEmpty = new IndexManager(storeEmpty);
  idxEmpty.update('2026-03-01', 'Test', 1000);
  // Clear store under the hood
  await storeEmpty.set('ledger:index', null);
  idxEmpty.reload();
  assertDeepEq(idxEmpty.getAll(), {}, 'reload with empty store results in {}');

  // ── getAll returns a copy ──────────────────────────
  console.log('\n=== getAll Returns a Copy ===');

  const storeCopy = new MemoryBackend();
  const idxCopy = new IndexManager(storeCopy);
  idxCopy.update('2026-04-01', 'Yoga', 1800000);

  // Test 22: getAll returns a copy — mutating result does not affect internal state
  const dataCopy = idxCopy.getAll();
  dataCopy['2026-04-02'] = { 'Jogging': 3000000 };
  const afterMutation = idxCopy.getAll();
  assertEq(afterMutation['2026-04-02'], undefined,
    'mutating getAll() result does not affect internal cache');
  assertDeepEq(afterMutation['2026-04-01'], dataCopy['2026-04-01'],
    'existing data still accessible after mutation of copy');
}

// ── Summary ─────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────────');
console.log(`IndexManager tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✗ ${e}`));
}

process.exit(failed > 0 ? 1 : 0);
