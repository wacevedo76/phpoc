/**
 * utils_test.mjs — Tests for ledger utility functions, focusing on
 * cross-platform JSON serialization compatibility with Python.
 *
 * Verifies that jsonSort() produces output byte-identical to Python's
 * json.dumps(obj, sort_keys=True).
 *
 * Usage:
 *   node test/utils_test.mjs
 */

import { jsonSort } from '../src/ledger/utils.js';

// ── Stats ───────────────────────────────────────────────────────────
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
    console.log(`\n      got:      ${JSON.stringify(actual)}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
  }
  console.log(`  ${label}`);
}

// ── Tests ───────────────────────────────────────────────────────────

// === Python compatibility: exact byte-for-byte match ===
// Expected values verified against Python 3 json.dumps(obj, sort_keys=True)

console.log('\n=== Primitive Types ===');

assertEq(jsonSort(null), 'null', 'null → "null"');
assertEq(jsonSort(true), 'true', 'true → "true"');
assertEq(jsonSort(false), 'false', 'false → "false"');
assertEq(jsonSort(42), '42', 'integer → "42"');
assertEq(jsonSort(-7), '-7', 'negative integer → "-7"');
assertEq(jsonSort('hello'), '"hello"', 'string → quoted string');
assertEq(jsonSort(''), '""', 'empty string → ""');

console.log('\n=== Arrays ===');

assertEq(jsonSort([]), '[]', 'empty array → "[]"');
assertEq(jsonSort([1, 2, 3]), '[1, 2, 3]', 'simple array → "[1, 2, 3]"');
assertEq(jsonSort([[1, 2], [3, 4]]), '[[1, 2], [3, 4]]', 'nested array');

console.log('\n=== Objects — Key Sorting ===');

assertEq(jsonSort({}), '{}', 'empty object → "{}"');
assertEq(jsonSort({ b: 1, a: 2 }), '{"a": 2, "b": 1}', 'keys sorted alphabetically');
assertEq(
  jsonSort({ c: 3, a: 1, b: 2 }),
  '{"a": 1, "b": 2, "c": 3}',
  'three keys sorted'
);

console.log('\n=== Objects — Nested Key Sorting ===');

// Python: {"a": 1, "z": {"x": 9, "y": 8}}
assertEq(
  jsonSort({ z: { y: 8, x: 9 }, a: 1 }),
  '{"a": 1, "z": {"x": 9, "y": 8}}',
  'nested keys sorted recursively'
);

// Python: {"arr": [1, {"a": 3, "b": 2}], "n": null, "str": "x"}
assertEq(
  jsonSort({ arr: [1, { b: 2, a: 3 }], str: 'x', n: null }),
  '{"arr": [1, {"a": 3, "b": 2}], "n": null, "str": "x"}',
  'mixed nested: arrays, objects, null, strings'
);

console.log('\n=== Spacing — ": " and ", " ===');

// The key difference from JSON.stringify: ": " (colon-space) and ", " (comma-space)
// Python format: {"a": 1, "b": 2}
// JS compact:    {"a":1,"b":2}
const simple = jsonSort({ a: 1, b: 2 });
assertEq(simple, '{"a": 1, "b": 2}', 'simple object matches Python output exactly');
assert(simple.includes(': '), 'contains ": " (colon-space)');
assert(simple.includes(', '), 'contains ", " (comma-space)');

console.log('\n=== Arrays — ", " spacing ===');

const arr = jsonSort([1, 2, 3]);
assert(arr === '[1, 2, 3]', 'array uses ", " spacing');
assert(!arr.includes('1,2'), 'array does NOT use compact commas');

console.log('\n=== Edge Cases ===');

// Object with many keys
const manyKeys = {};
for (let i = 0; i < 10; i++) {
  manyKeys[`key_${String(i).padStart(2, '0')}`] = i;
}
const manyResult = jsonSort(manyKeys);
// Keys should be in order: key_00, key_01, ..., key_09
const keys = Object.keys(manyKeys).sort();
let sortedOrder = true;
let lastIdx = -1;
for (const k of keys) {
  const idx = manyResult.indexOf(`"${k}"`);
  if (idx <= lastIdx) { sortedOrder = false; break; }
  lastIdx = idx;
}
assert(sortedOrder, '10 keys appear in sorted order');

// Numbers: verify no quotes around numbers
assertEq(jsonSort({ n: 0 }), '{"n": 0}', 'number 0 has no quotes');
assertEq(jsonSort({ n: 100 }), '{"n": 100}', 'number 100 has no quotes');

// Deeply nested object (3 levels)
const deep = { c: { b: { a: 1, d: 2 }, e: 3 }, f: 4 };
assertEq(
  jsonSort(deep),
  '{"c": {"b": {"a": 1, "d": 2}, "e": 3}, "f": 4}',
  'deeply nested (3 levels) sorted recursively'
);

// String with special JSON characters
assertEq(
  jsonSort({ msg: 'hello "world"' }),
  '{"msg": "hello \\"world\\""}',
  'double quote inside string escaped'
);

console.log('\n=== Cross-Platform Hash Stability ===');

// The key invariant: jsonSort must be deterministic and produce
// identical output for identical input on every call
const sample = { z: [1, 2], a: { n: null, b: true }, s: 'test' };
const result1 = jsonSort(sample);
const result2 = jsonSort(sample);
assertEq(result1, result2, 'deterministic: same input → same output');
assertEq(result1.length, result2.length, 'deterministic: same length');

// ── Summary ─────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✗ ${e}`));
}

process.exit(failed > 0 ? 1 : 0);
