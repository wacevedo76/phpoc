/**
 * hash_index_test.mjs — Hash Index test suite (TDD RED phase).
 *
 * ~22 tests for the hash index data structure and fork detection:
 *   A — buildHashIndex() — 9 unit tests
 *   B — compareHashIndexes() — 13 unit tests
 *
 * Modules under test:
 *   src/sync/hash_index.js — buildHashIndex(chain), compareHashIndexes(local, remote)
 *
 * RED phase: Implementation doesn't exist yet.
 *   - Both functions are expected to be undefined/null
 *   - All tests assert false → FAIL (TDD RED expected)
 *   - When Phase 3 (GREEN) implements hash_index.js, these go GREEN
 *
 * Usage:
 *   node --experimental-vm-modules test/hash_index_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { jsonSort } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Import module under test (will fail — RED phase) ──────────────────
let hashIndexMod = null;
try {
  hashIndexMod = await import('../src/sync/hash_index.js');
} catch {
  // Expected in RED phase — module doesn't exist yet
}

const buildHashIndex = hashIndexMod?.buildHashIndex;
const compareHashIndexes = hashIndexMod?.compareHashIndexes;

const hasBuild = typeof buildHashIndex === 'function';
const hasCompare = typeof compareHashIndexes === 'function';

// ── Seal helper (matches genesis_gate_test.mjs conventions) ──────────
function makeSeal(jsonStr) {
  return createHash('sha256').update('deadbeef-deadbeef-deadbeef-deadbeef-' + jsonStr).digest('hex');
}

// ── Block builders ──────────────────────────────────────────────────
function genBlock() {
  const b = {
    type: 'genesis',
    day_index: 0,
    date: '2026-01-01',
    identity: { username: 'test', email: 't@e.com' },
    prev_hash: '0'.repeat(64),
    entries: [],
  };
  b.day_hash = makeSeal(jsonSort(b));
  return b;
}

function dayBlock(date, dayIndex, prevHash, entryTitles = []) {
  const entries = entryTitles.map(title => ({ hash: createHash('sha256').update(title).digest('hex'), data: { title } }));
  const b = {
    type: 'day',
    day_index: dayIndex,
    date,
    prev_hash: prevHash,
    entries,
  };
  b.day_hash = makeSeal(jsonSort(b));
  return b;
}

function monthSummaryBlock(date, monthIndex, prevHash) {
  const b = {
    type: 'month_summary',
    month_index: monthIndex,
    date,
    prev_hash: prevHash,
    entries: [],
    stats: { total_duration: 0, entry_count: 0 },
  };
  b.month_hash = makeSeal(jsonSort(b));
  return b;
}

function yearSummaryBlock(date, yearIndex, prevHash) {
  const b = {
    type: 'year_summary',
    year_index: yearIndex,
    date,
    prev_hash: prevHash,
    entries: [],
    stats: { total_duration: 0, entry_count: 0 },
  };
  b.year_hash = makeSeal(jsonSort(b));
  return b;
}

function blockHash(block) {
  return block.day_hash || block.month_hash || block.year_hash;
}

// ── Module status ──────────────────────────────────────────────────
console.log('\n================================================');
console.log('Hash Index Test Suite (TDD RED phase)');
console.log('================================================');

console.log('\n=== Module Existence ===');
if (!hasBuild) {
  console.log('⛔ buildHashIndex NOT IMPLEMENTED — all Category A tests expected to FAIL (TDD RED)');
} else {
  console.log('✅ buildHashIndex exists (UNEXPECTED in RED phase)');
}
if (!hasCompare) {
  console.log('⛔ compareHashIndexes NOT IMPLEMENTED — all Category B tests expected to FAIL (TDD RED)');
} else {
  console.log('✅ compareHashIndexes exists (UNEXPECTED in RED phase)');
}

// ═══════════════════════════════════════════════════════════════════════
// Category A: Hash Index Data Structure (9 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Category A — buildHashIndex (Unit) ===');

// ── A1: Day blocks only ────────────────────────────────────────────
{
  console.log('\n  --- A1: Day blocks only ---');
  const genesis = genBlock();
  const db1 = dayBlock('2026-06-10', 1, blockHash(genesis), ['Task A']);
  const db2 = dayBlock('2026-06-11', 2, blockHash(db1), ['Task B']);
  const chain = [genesis, db1, db2];

  if (!hasBuild) {
    t.assert(false, 'buildHashIndex(day-blocks) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = buildHashIndex(chain);
    t.assert(Array.isArray(result), 'A1a. result is an Array');
    t.assertEq(result.length, 3, 'A1b. 3 blocks → 3 hashes');
    t.assertEq(result[0], genesis.day_hash, 'A1c. index 0 = genesis seal');
    t.assertEq(result[1], db1.day_hash, 'A1d. index 1 = day block 1 seal');
    t.assertEq(result[2], db2.day_hash, 'A1e. index 2 = day block 2 seal');
  }
}

// ── A2: Mixed block types (day + month_summary + year_summary) ─────
{
  console.log('\n  --- A2: Mixed block types ---');
  const genesis = genBlock();
  const dayB = dayBlock('2026-06-10', 1, blockHash(genesis), ['Task A']);
  const monthS = monthSummaryBlock('2026-06-30', 6, blockHash(dayB));
  const yearS = yearSummaryBlock('2026-06-30', 2026, blockHash(monthS));
  const chain = [genesis, dayB, monthS, yearS];

  if (!hasBuild) {
    t.assert(false, 'buildHashIndex(mixed-types) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = buildHashIndex(chain);
    t.assertEq(result.length, 4, 'A2a. 4 blocks → 4 hashes');
    t.assertEq(result[0], genesis.day_hash, 'A2b. genesis: day_hash');
    t.assertEq(result[1], dayB.day_hash, 'A2c. day: day_hash');
    t.assertEq(result[2], monthS.month_hash, 'A2d. month_summary: month_hash');
    t.assertEq(result[3], yearS.year_hash, 'A2e. year_summary: year_hash');
  }
}

// ── A3: Order preservation ─────────────────────────────────────────
{
  console.log('\n  --- A3: Order preservation ---');
  const genesis = genBlock();
  const db1 = dayBlock('2026-06-10', 1, blockHash(genesis), ['Task A']);
  const db2 = dayBlock('2026-06-11', 2, blockHash(db1), ['Task B']);
  const chain = [genesis, db1, db2];

  if (!hasBuild) {
    t.assert(false, 'buildHashIndex(order) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = buildHashIndex(chain);
    // Each hash at position N must match the block at position N
    t.assertEq(result[0], genesis.day_hash, 'A3a. hash[0] = chain[0] seal');
    t.assertEq(result[1], db1.day_hash, 'A3b. hash[1] = chain[1] seal');
    t.assertEq(result[2], db2.day_hash, 'A3c. hash[2] = chain[2] seal');
    // Verify hash at position N is NOT some other block's hash
    t.assertNeq(result[1], genesis.day_hash, 'A3d. hash[1] ≠ genesis');
    t.assertNeq(result[2], db1.day_hash, 'A3e. hash[2] ≠ day block 1');
  }
}

// ── A4: Determinism ────────────────────────────────────────────────
{
  console.log('\n  --- A4: Determinism ---');
  const genesis = genBlock();
  const chain = [genesis, dayBlock('2026-06-10', 1, blockHash(genesis), ['Task A'])];

  if (!hasBuild) {
    t.assert(false, 'buildHashIndex(determinism) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const r1 = buildHashIndex(chain);
    const r2 = buildHashIndex(chain);
    t.assertDeepEq(r1, r2, 'A4a. same input → same output');
    t.assertEq(r1.length, r2.length, 'A4b. lengths match');
    for (let i = 0; i < r1.length; i++) {
      t.assertEq(r1[i], r2[i], `A4c. element ${i} identical`);
    }
  }
}

// ── A5: Genesis-only chain ─────────────────────────────────────────
{
  console.log('\n  --- A5: Genesis-only chain ---');
  const genesis = genBlock();
  const chain = [genesis];

  if (!hasBuild) {
    t.assert(false, 'buildHashIndex(genesis-only) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = buildHashIndex(chain);
    t.assertEq(result.length, 1, 'A5a. 1 block → 1 hash');
    t.assertEq(result[0], genesis.day_hash, 'A5b. sole element = genesis seal');
  }
}

// ── A6: Empty chain ────────────────────────────────────────────────
{
  console.log('\n  --- A6: Empty chain ---');
  if (!hasBuild) {
    t.assert(false, 'buildHashIndex(empty) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = buildHashIndex([]);
    t.assert(Array.isArray(result), 'A6a. result is an Array');
    t.assertEq(result.length, 0, 'A6b. empty input → empty output');
  }
}

// ── A7: Null/undefined chain (defensive) ───────────────────────────
{
  console.log('\n  --- A7: Null/undefined chain ---');
  if (!hasBuild) {
    t.assert(false, 'buildHashIndex(null) — NOT IMPLEMENTED (TDD RED)');
  } else {
    // Should not throw — return empty array defensively
    let result;
    try {
      result = buildHashIndex(null);
      t.assert(Array.isArray(result), 'A7a. null → returns array (no crash)');
      t.assertEq(result.length, 0, 'A7b. null → empty array');
    } catch {
      // Alternative: throw with clear message is also acceptable
      t.assert(true, 'A7a. null → throws (acceptable defensive behavior)');
    }

    try {
      result = buildHashIndex(undefined);
      t.assert(Array.isArray(result), 'A7c. undefined → returns array');
    } catch {
      t.assert(true, 'A7c. undefined → throws (acceptable)');
    }
  }
}

// ── A8: Plain array output (all strings) ───────────────────────────
{
  console.log('\n  --- A8: Plain array output ---');
  const genesis = genBlock();
  const chain = [genesis, dayBlock('2026-06-10', 1, blockHash(genesis), ['Task A'])];

  if (!hasBuild) {
    t.assert(false, 'buildHashIndex(array-type-check) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = buildHashIndex(chain);
    t.assert(Array.isArray(result), 'A8a. output is Array');
    const allStrings = result.every(el => typeof el === 'string');
    t.assert(allStrings, 'A8b. all elements are strings');
    const noObjects = result.every(el => typeof el !== 'object');
    t.assert(noObjects, 'A8c. no nested objects');
  }
}

// ── A9: Hash string format (64 hex chars) ──────────────────────────
{
  console.log('\n  --- A9: Hash string format ---');
  const genesis = genBlock();
  const chain = [genesis, dayBlock('2026-06-10', 1, blockHash(genesis), ['Task A'])];

  if (!hasBuild) {
    t.assert(false, 'buildHashIndex(format) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = buildHashIndex(chain);
    const hex64 = /^[0-9a-f]{64}$/;
    for (let i = 0; i < result.length; i++) {
      t.assert(hex64.test(result[i]), `A9. element ${i} is 64 hex chars`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Category B: Fork Detection (13 tests)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Category B — compareHashIndexes (Unit) ===');

// ── B1: Identical lists → no fork ──────────────────────────────────
{
  console.log('\n  --- B1: Identical lists → no fork ---');
  const h = ['aaa', 'bbb', 'ccc'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(identical) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(h, h);
    t.assert(result !== undefined, 'B1a. returns result');
    t.assertEq(result.forkType, 'none', 'B1b. forkType is "none"');
  }
}

// ── B2: Remote extends local (linear_remote) ───────────────────────
{
  console.log('\n  --- B2: Remote extends local ---');
  const local = ['h0', 'h1', 'h2'];
  const remote = ['h0', 'h1', 'h2', 'h3', 'h4'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(linear_remote) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(local, remote);
    t.assertEq(result.forkType, 'linear_remote', 'B2a. forkType is linear_remote');
    t.assertEq(result.forkIndex, 3, 'B2b. forkIndex is 3 (first remote-only index)');
  }
}

// ── B3: Local extends remote (linear_local) ────────────────────────
{
  console.log('\n  --- B3: Local extends remote ---');
  const local = ['h0', 'h1', 'h2', 'h3'];
  const remote = ['h0', 'h1', 'h2'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(linear_local) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(local, remote);
    t.assertEq(result.forkType, 'linear_local', 'B3a. forkType is linear_local');
    t.assertEq(result.forkIndex, 3, 'B3b. forkIndex is 3 (first local-only index)');
  }
}

// ── B4: Divergent fork ─────────────────────────────────────────────
{
  console.log('\n  --- B4: Divergent fork ---');
  const local = ['h0', 'h1', 'h2a'];
  const remote = ['h0', 'h1', 'h2b'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(divergent) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(local, remote);
    t.assertEq(result.forkType, 'divergent', 'B4a. forkType is divergent');
    t.assertEq(result.forkIndex, 2, 'B4b. forkIndex is 2 (first diverging index)');
  }
}

// ── B5: Remote empty → linear_local ────────────────────────────────
{
  console.log('\n  --- B5: Remote empty → linear_local ---');
  const local = ['h0', 'h1'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(remote-empty) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(local, []);
    t.assertEq(result.forkType, 'linear_local', 'B5a. forkType is linear_local');
    t.assertEq(result.forkIndex, 0, 'B5b. forkIndex is 0');
  }
}

// ── B6: Local empty → linear_remote ────────────────────────────────
{
  console.log('\n  --- B6: Local empty → linear_remote ---');
  const remote = ['h0', 'h1'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(local-empty) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes([], remote);
    t.assertEq(result.forkType, 'linear_remote', 'B6a. forkType is linear_remote');
    t.assertEq(result.forkIndex, 0, 'B6b. forkIndex is 0');
  }
}

// ── B7: Both empty → none ──────────────────────────────────────────
{
  console.log('\n  --- B7: Both empty → none ---');

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(both-empty) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes([], []);
    t.assertEq(result.forkType, 'none', 'B7a. forkType is none');
  }
}

// ── B8: Mismatch at index 0 → genesis_mismatch ─────────────────────
{
  console.log('\n  --- B8: Mismatch at index 0 → genesis_mismatch ---');
  const local = ['h0a'];
  const remote = ['h0b'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(genesis_mismatch) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(local, remote);
    t.assertEq(result.forkType, 'genesis_mismatch', 'B8a. forkType is genesis_mismatch');
    t.assertEq(result.forkIndex, 0, 'B8b. forkIndex is 0');
  }
}

// ── B9: Single hash mismatch mid-chain, rest identical ─────────────
{
  console.log('\n  --- B9: Single hash mismatch mid-chain ---');
  const local = ['h0', 'h1', 'h2a', 'h3'];
  const remote = ['h0', 'h1', 'h2b', 'h3'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(mid-chain-mismatch) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(local, remote);
    t.assertEq(result.forkType, 'divergent', 'B9a. forkType is divergent');
    t.assertEq(result.forkIndex, 2, 'B9b. forkIndex is 2');
  }
}

// ── B10: Fork at very end of chain ─────────────────────────────────
{
  console.log('\n  --- B10: Fork at very end of chain ---');
  const local = ['h0', 'h1', 'h2'];
  const remote = ['h0', 'h1', 'h2a'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(end-fork) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(local, remote);
    t.assertEq(result.forkType, 'divergent', 'B10a. forkType is divergent');
    t.assertEq(result.forkIndex, 2, 'B10b. forkIndex is 2 (last element)');
  }
}

// ── B11: Remote has fewer elements + divergence ────────────────────
{
  console.log('\n  --- B11: Remote fewer + divergence ---');
  const local = ['h0', 'h1a', 'h2'];
  const remote = ['h0', 'h1b'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(fewer+divergent) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(local, remote);
    t.assertEq(result.forkType, 'divergent', 'B11a. forkType is divergent');
    t.assertEq(result.forkIndex, 1, 'B11b. forkIndex is 1 (divergence at shared index)');
  }
}

// ── B12: Null inputs → treated as empty ────────────────────────────
{
  console.log('\n  --- B12: Null inputs → treated as empty ---');

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(null-input) — NOT IMPLEMENTED (TDD RED)');
  } else {
    // null + valid → linear_remote
    const r1 = compareHashIndexes(null, ['h0', 'h1']);
    t.assertEq(r1.forkType, 'linear_remote', 'B12a. null local → linear_remote');
    t.assertEq(r1.forkIndex, 0, 'B12b. forkIndex is 0');

    // valid + null → linear_local
    const r2 = compareHashIndexes(['h0', 'h1'], null);
    t.assertEq(r2.forkType, 'linear_local', 'B12c. null remote → linear_local');

    // null + null → none
    const r3 = compareHashIndexes(null, null);
    t.assertEq(r3.forkType, 'none', 'B12d. both null → none');
  }
}

// ── B13: Very long identical prefix (stress test) ──────────────────
{
  console.log('\n  --- B13: Long identical prefix → divergent at end ---');
  const prefix = Array.from({ length: 100 }, (_, i) => `hash${String(i).padStart(62, '0')}`);
  const local = [...prefix, 'diff_a'];
  const remote = [...prefix, 'diff_b'];

  if (!hasCompare) {
    t.assert(false, 'compareHashIndexes(long-prefix-stress) — NOT IMPLEMENTED (TDD RED)');
  } else {
    const result = compareHashIndexes(local, remote);
    t.assertEq(result.forkType, 'divergent', 'B13a. forkType is divergent');
    t.assertEq(result.forkIndex, 100, 'B13b. forkIndex is 100 (end of prefix)');
  }
}

// ── Summary ───────────────────────────────────────────────────────────
const failures = t.summary('hash_index_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
