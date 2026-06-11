/**
 * test_helpers.mjs — Shared assertion helpers for ledger test suites.
 *
 * Provides a TestHelpers class with per-instance pass/fail tracking
 * and all assertion methods. Each test file creates its own instance.
 *
 * Usage:
 *   import { TestHelpers } from './test_helpers.mjs';
 *   const t = new TestHelpers();
 *   t.assert(condition, 'label');
 *   t.assertEq(actual, expected, 'label');
 *   // ... after all tests ...
 *   console.log(`Tests: ${t.passed} passed, ${t.failed} failed`);
 */

export class TestHelpers {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    /** @type {string[]} */
    this.errors = [];
  }

  assert(condition, label) {
    if (condition) { this.passed++; process.stdout.write('  ✓'); }
    else { this.failed++; this.errors.push(label); process.stdout.write('  ✗'); }
    console.log(`  ${label}`);
  }

  assertEq(actual, expected, label) {
    const ok = actual === expected;
    if (ok) { this.passed++; process.stdout.write('  ✓'); }
    else {
      this.failed++; this.errors.push(label);
      process.stdout.write('  ✗');
      console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 160)}`);
      console.log(`      expected: ${JSON.stringify(expected).slice(0, 160)}`);
    }
    console.log(`  ${label}`);
  }

  assertNeq(actual, expected, label) {
    const ok = actual !== expected;
    if (ok) { this.passed++; process.stdout.write('  ✓'); }
    else {
      this.failed++; this.errors.push(label);
      process.stdout.write('  ✗');
      console.log(`\n      got: ${JSON.stringify(actual).slice(0, 120)} should differ from expected`);
    }
    console.log(`  ${label}`);
  }

  assertDeepEq(actual, expected, label) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { this.passed++; process.stdout.write('  ✓'); }
    else {
      this.failed++; this.errors.push(label);
      process.stdout.write('  ✗');
      console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 300)}`);
      console.log(`      expected: ${JSON.stringify(expected).slice(0, 300)}`);
    }
    console.log(`  ${label}`);
  }

  assertThrows(fn, label) {
    try {
      fn();
      this.failed++; this.errors.push(label);
      process.stdout.write('  ✗  (expected throw, got success)');
    } catch {
      this.passed++;
      process.stdout.write('  ✓');
    }
    console.log(`  ${label}`);
  }

  async assertAsyncThrows(promise, label) {
    try {
      await promise;
      this.failed++; this.errors.push(label);
      process.stdout.write('  ✗  (expected throw, got success)');
    } catch {
      this.passed++;
      process.stdout.write('  ✓');
    }
    console.log(`  ${label}`);
  }

  assertHasKeys(obj, keys, label) {
    const missing = keys.filter(k => !(k in obj));
    const ok = missing.length === 0;
    if (ok) { this.passed++; process.stdout.write('  ✓'); }
    else {
      this.failed++; this.errors.push(label);
      process.stdout.write('  ✗');
      console.log(`\n      missing keys: ${missing.join(', ')}`);
    }
    console.log(`  ${label}`);
  }

  /**
   * Print a summary line and set process.exitCode if there were failures.
   * @param {string} suiteName - Name for the summary line.
   */
  summary(suiteName) {
    console.log('\n────────────────────────────────────────────────────────────────────');
    console.log(`${suiteName} tests: ${this.passed} passed, ${this.failed} failed`);
    if (this.failed > 0) {
      console.log('\nFailed tests:');
      this.errors.forEach(e => console.log(`  ✗ ${e}`));
    }
    return this.failed;
  }
}
