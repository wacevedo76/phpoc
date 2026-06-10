/**
 * summary_policy_test.mjs — SummaryPolicy test suite.
 *
 * Tests year/month boundary summary block insertion policies:
 *   - YearMonthSummaryPolicy (default): inserts year_summary on year
 *     boundary, month_summary on month boundary
 *   - YearOnlySummaryPolicy: year summary only
 *   - NoSummaryPolicy: never inserts summaries
 *
 * TDD: RED phase — source files don't exist yet.
 *
 * Usage:
 *   node test/summary_policy_test.mjs
 */

import { createHash } from 'crypto';

// ── Import modules under test (WILL FAIL — doesn't exist yet) ──
let YearMonthSummaryPolicy;
let YearOnlySummaryPolicy;
let NoSummaryPolicy;
try {
  const mod = await import('../src/ledger/summary_policy.js');
  YearMonthSummaryPolicy = mod.YearMonthSummaryPolicy;
  YearOnlySummaryPolicy = mod.YearOnlySummaryPolicy;
  NoSummaryPolicy = mod.NoSummaryPolicy;
} catch (err) {
  // Expected: modules don't exist yet → all tests will fail
  YearMonthSummaryPolicy = undefined;
  YearOnlySummaryPolicy = undefined;
  NoSummaryPolicy = undefined;
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

// ── Mock Crypto (same pattern as chain test) ──────────────────────────
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

  sign(data, identitySecretHex) {
    return this.deterministicHash('sign:' + data + identitySecretHex);
  }

  verifySignature(data, signatureHex, identitySecretHex) {
    return this.sign(data, identitySecretHex) === signatureHex;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────
const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const IDENTITY_SECRET = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';
const crypto = new MockCrypto();

/**
 * Build a prev_block with the given type, date, and hash values.
 * Supports day, month_summary, and year_summary types.
 */
function makePrevBlock({ type = 'day', date = '2026-01-15', day_hash = null, month_hash = null, year_hash = null, month = null }) {
  const block = { type, date };
  if (day_hash) block.day_hash = day_hash;
  if (month_hash) block.month_hash = month_hash;
  if (year_hash) block.year_hash = year_hash;
  if (month) block.month = month;

  // If no hash provided, compute a deterministic one
  if (!day_hash && !month_hash && !year_hash) {
    block.day_hash = crypto.deterministicHash(JSON.stringify(block) + MASTER_KEY);
  }

  return block;
}

// ─────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────
console.log('\n=== SummaryPolicy Classes Exist ===');

assert(typeof YearMonthSummaryPolicy === 'function', 'YearMonthSummaryPolicy is a constructor');
assert(typeof YearOnlySummaryPolicy === 'function', 'YearOnlySummaryPolicy is a constructor');
assert(typeof NoSummaryPolicy === 'function', 'NoSummaryPolicy is a constructor');

// ── YearMonthSummaryPolicy ────────────────────────────
console.log('\n=== YearMonthSummaryPolicy ===');

if (typeof YearMonthSummaryPolicy === 'function') {
  const policy = new YearMonthSummaryPolicy(crypto, MASTER_KEY);
  const policyWithSig = new YearMonthSummaryPolicy(crypto, MASTER_KEY, IDENTITY_SECRET);

  // Test 1: Same month → no summary blocks
  const prevDay = makePrevBlock({ type: 'day', date: '2026-01-15' });
  const sameMonth = policy.getSummaryBlocks(prevDay, '2026-01-20');
  assert(Array.isArray(sameMonth), 'getSummaryBlocks returns an array');
  assertEq(sameMonth.length, 0, 'same month returns no summary blocks');

  // Test 2: Month boundary → month_summary block
  const prevJan = makePrevBlock({ type: 'day', date: '2026-01-31' });
  const febEntries = policy.getSummaryBlocks(prevJan, '2026-02-01');
  assertEq(febEntries.length, 1, 'month boundary returns 1 summary block');
  assertEq(febEntries[0].type, 'month_summary', 'summary block has type "month_summary"');
  assertEq(febEntries[0].month, '2026-01', 'month summary covers January');
  assert(typeof febEntries[0].month_hash === 'string', 'month summary has month_hash');
  assert(/^[0-9a-f]{64}$/.test(febEntries[0].month_hash), 'month_hash is 64 hex chars');

  // Test 3: Month summary block structure
  assertHasKeys(febEntries[0], ['type', 'month', 'prev_hash', 'date', 'month_hash'],
    'month_summary has all required keys');
  assertEq(febEntries[0].date, '2026-02-01', 'month summary date matches upcoming day');
  assertEq(febEntries[0].prev_hash, prevJan.day_hash, 'month summary prev_hash matches prev block');

  // Test 4: Year boundary → year_summary block
  const prevDec = makePrevBlock({ type: 'day', date: '2025-12-31' });
  const jan2026 = policy.getSummaryBlocks(prevDec, '2026-01-01');
  assertEq(jan2026.length, 2, 'year boundary returns 2 summary blocks (year + month)');
  assertEq(jan2026[0].type, 'year_summary', 'first summary is year_summary');
  assertEq(jan2026[0].year, 2025, 'year summary covers 2025');

  // Test 5: Year summary block structure
  assertHasKeys(jan2026[0], ['type', 'year', 'prev_hash', 'date', 'year_hash'],
    'year_summary has all required keys');
  assertEq(jan2026[0].date, '2026-01-01', 'year summary date matches upcoming day');

  // Test 6: Second block is month summary for December (after year summary)
  assertEq(jan2026[1].type, 'month_summary', 'second summary is month_summary');
  assertEq(jan2026[1].month, '2025-12', 'month summary covers December');
  assertEq(jan2026[1].prev_hash, jan2026[0].year_hash,
    'month summary prev_hash links to year summary');

  // Test 7: Cross-year Dec→Feb (skip a month)
  // This happens when user has no entries in January
  const prevDecDirect = makePrevBlock({ type: 'day', date: '2025-12-25' });
  const feb2026 = policy.getSummaryBlocks(prevDecDirect, '2026-02-03');
  assertEq(feb2026.length, 2, 'Dec→Feb returns 2 summary blocks (year + month)');
  assertEq(feb2026[0].type, 'year_summary', 'first is year_summary');
  assertEq(feb2026[1].type, 'month_summary', 'second is month_summary');
  // The month summary should be for January (the month before February)
  assertEq(feb2026[1].month, '2026-01', 'month summary covers the skipped January');

  // Test 8: Same year, multiple months gap
  const prevMar = makePrevBlock({ type: 'day', date: '2026-03-15' });
  const mayEntries = policy.getSummaryBlocks(prevMar, '2026-05-01');
  assertEq(mayEntries.length, 1, 'Mar→May returns 1 summary block');
  assertEq(mayEntries[0].type, 'month_summary', 'summary is month_summary');
  assertEq(mayEntries[0].month, '2026-04', 'month summary covers April');

  // Test 9: No summary when prev_block is already a month_summary for same month
  const prevMonthSum = makePrevBlock({
    type: 'month_summary',
    date: '2026-02-01',
    month_hash: crypto.deterministicHash('month:2026-01' + MASTER_KEY),
    month: '2026-01'
  });
  const afterMonthSum = policy.getSummaryBlocks(prevMonthSum, '2026-02-01');
  assertEq(afterMonthSum.length, 0,
    'no summary when prev block is already a month_summary for the same month');

  // Test 10: No redundant December month summary when year summary already covers it
  // Year summary for 2025 was just inserted, and the gap is Dec→Jan, so December
  // is already covered by the year summary. No separate month summary needed.
  const prevYearSum = makePrevBlock({
    type: 'year_summary',
    date: '2026-01-01',
    year_hash: crypto.deterministicHash('year:2025' + MASTER_KEY),
  });
  // This simulates: year summary was just appended for 2025, now adding Jan 1 block
  const afterYearSum = policyWithSig.getSummaryBlocks(prevYearSum, '2026-01-01');
  // Should still emit a month summary for December (not redundant because year summary
  // is the prev block, but December month is different from year)
  assertEq(afterYearSum.length, 0,
    'no redundant December month summary when year summary is prev block');

  // Test 11: Identity signature on summary blocks
  const prevOct = makePrevBlock({ type: 'day', date: '2025-10-15' });
  const withSigBlocks = policyWithSig.getSummaryBlocks(prevOct, '2026-01-01');
  if (withSigBlocks.length > 0) {
    for (const block of withSigBlocks) {
      assert(typeof block.signature === 'string',
        `summary block of type ${block.type} has signature when identity secret is provided`);
    }
  }

  // Test 12: No identity signature without identity secret
  const noSigBlocks = policy.getSummaryBlocks(prevOct, '2026-01-01');
  for (const block of noSigBlocks) {
    assertEq(block.signature, undefined,
      `summary block of type ${block.type} has no signature without identity secret`);
  }

  // Test 13: Consecutive month boundaries (multiple month skips)
  const prevApr = makePrevBlock({ type: 'day', date: '2026-04-10' });
  const juneEntries = policy.getSummaryBlocks(prevApr, '2026-06-01');
  assertEq(juneEntries.length, 1, 'Apr→Jun returns 1 month summary');
  assertEq(juneEntries[0].month, '2026-05', 'month summary covers May (skipped month)');

  // Test 14: Year boundary without month gap (Dec 31 → Jan 1)
  const prevDec31 = makePrevBlock({ type: 'day', date: '2025-12-31' });
  const jan1 = policy.getSummaryBlocks(prevDec31, '2026-01-01');
  assertEq(jan1.length, 2, 'Dec 31→Jan 1 returns 2 summaries');
  assertEq(jan1[0].type, 'year_summary', 'year summary for 2025');
  assertEq(jan1[1].type, 'month_summary', 'month summary for December');
}

// ── YearOnlySummaryPolicy ────────────────────────────
console.log('\n=== YearOnlySummaryPolicy ===');

if (typeof YearOnlySummaryPolicy === 'function') {
  const policy = new YearOnlySummaryPolicy(crypto, MASTER_KEY);

  // Test 15: No month summaries
  const prevJan = makePrevBlock({ type: 'day', date: '2026-01-31' });
  const febOnly = policy.getSummaryBlocks(prevJan, '2026-02-01');
  assertEq(febOnly.length, 0, 'YearOnly: month boundary returns no summaries');

  // Test 16: Year boundary returns year summary
  const prevDec = makePrevBlock({ type: 'day', date: '2025-12-31' });
  const janOnly = policy.getSummaryBlocks(prevDec, '2026-01-01');
  assertEq(janOnly.length, 1, 'YearOnly: year boundary returns 1 summary');
  assertEq(janOnly[0].type, 'year_summary', 'YearOnly: summary is year_summary');
  assertEq(janOnly[0].year, 2025, 'YearOnly: year summary covers 2025');

  // Test 17: Same year returns nothing
  const prevMar = makePrevBlock({ type: 'day', date: '2026-03-15' });
  const mayOnly = policy.getSummaryBlocks(prevMar, '2026-05-01');
  assertEq(mayOnly.length, 0, 'YearOnly: same year returns no summaries');

  // Test 18: Multiple year gap
  const prev2024 = makePrevBlock({ type: 'day', date: '2024-06-15' });
  const dec2025 = policy.getSummaryBlocks(prev2024, '2026-01-01');
  assertEq(dec2025.length, 1, 'YearOnly: multi-year gap returns 1 year summary');
  assertEq(dec2025[0].year, 2024, 'YearOnly: year summary covers 2024');
}

// ── NoSummaryPolicy ──────────────────────────────────
console.log('\n=== NoSummaryPolicy ===');

if (typeof NoSummaryPolicy === 'function') {
  const policy = new NoSummaryPolicy(crypto, MASTER_KEY);

  // Test 19: Never returns summaries
  const prev = makePrevBlock({ type: 'day', date: '2025-12-31' });
  const none = policy.getSummaryBlocks(prev, '2026-01-01');
  assertEq(none.length, 0, 'NoSummary: year boundary returns nothing');

  // Test 20: Still returns nothing for any boundary
  const prev2 = makePrevBlock({ type: 'day', date: '2026-01-31' });
  const none2 = policy.getSummaryBlocks(prev2, '2026-02-01');
  assertEq(none2.length, 0, 'NoSummary: month boundary returns nothing');

  // Test 21: Empty call returns empty array (not null)
  const empty = policy.getSummaryBlocks(prev, '2026-03-01');
  assert(Array.isArray(empty), 'NoSummary: always returns an array');
}

// ── Summary ─────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────────────');
console.log(`SummaryPolicy tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✗ ${e}`));
}

process.exit(failed > 0 ? 1 : 0);

// ── Local helpers ───────────────────────────────────────────────────

function assertHasKeys(obj, keys, label) {
  const missing = keys.filter(k => !(k in obj));
  const ok = missing.length === 0;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      missing keys: ${missing.join(', ')}`);
  }
  console.log(`  ${label}`);
}
