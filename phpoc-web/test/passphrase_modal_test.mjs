/**
 * passphrase_modal_test.mjs — Test suite for PassphraseModal.
 *
 * Note: The project has no React testing framework (Jest/vitest/jsdom) and
 * Node.js cannot parse JSX natively. This test validates the component
 * module through filesystem inspection and documents expected behaviors.
 *
 * Design (2026-06-09):
 *   - Reusable modal overlay with backdrop blur (reuses AuthScreen pattern)
 *   - Passphrase input field
 *   - Confirm/Cancel buttons
 *   - onSubmit(passphrase) callback
 *   - onCancel callback
 *   - Optional title and description props
 *   - Shows error for empty passphrase
 *
 * Usage:
 *   node test/passphrase_modal_test.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENT_PATH = resolve(__dirname, '../src/components/modals/PassphraseModal.jsx');

// ── Stats ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, label) {
  if (condition) { passed++; process.stdout.write('  ✓'); }
  else { failed++; errors.push(label); process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

function assertIncludes(text, substr, label) {
  const ok = text.includes(substr);
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else { failed++; errors.push(label); process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

function assertNotIncludes(text, substr, label) {
  const ok = !text.includes(substr);
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else { failed++; errors.push(label); process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

// ─────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────
console.log('\n=== Module Existence ===');

let source;
try {
  source = readFileSync(COMPONENT_PATH, 'utf-8');
  assert(true, `PassphraseModal.jsx exists at ${COMPONENT_PATH}`);
} catch (err) {
  source = '';
  assert(false, `PassphraseModal.jsx exists — ${err.message}`);
}

// ── Component structure (analyze source) ────────────────────────────
console.log('\n=== Component Structure ===');

if (source) {
  // Test 1: Exports a default function component
  assertIncludes(source, 'export default function', 'exports default function component');
  assertIncludes(source, 'PassphraseModal', 'component is named PassphraseModal');

  // Test 2: Expected props via destructuring
  assertIncludes(source, 'onSubmit', 'accepts onSubmit prop');
  assertIncludes(source, 'onCancel', 'accepts onCancel prop');
  assertIncludes(source, 'title', 'accepts title prop');
  assertIncludes(source, 'description', 'accepts description prop');
  assertIncludes(source, 'errorMessage', 'accepts errorMessage prop');

  // Test 3: Default prop values
  assertIncludes(source, "title = 'Enter Passphrase'", 'default title is "Enter Passphrase"');
  assertIncludes(source, "description = 'Your passphrase is required", 'has default description');

  // Test 4: Renders form with passphrase input
  assertIncludes(source, 'type="password"', 'passphrase input is type="password"');
  assertIncludes(source, 'autoFocus', 'input has autoFocus');
  assertIncludes(source, 'placeholder="Enter your passphrase"', 'has passphrase placeholder');

  // Test 5: Confirm and Cancel buttons
  assertIncludes(source, 'Confirm', 'has Confirm button');
  assertIncludes(source, 'Cancel', 'has Cancel button');

  // Test 6: Uses auth-overlay CSS classes (reuses AuthScreen pattern)
  assertIncludes(source, 'auth-overlay', 'uses auth-overlay backdrop class');
  assertIncludes(source, 'auth-overlay-card', 'uses auth-overlay-card class');
  assertIncludes(source, 'auth-btn', 'uses auth-btn class');
  assertIncludes(source, 'auth-input', 'uses auth-input class');
  assertIncludes(source, 'auth-error-msg', 'has error message display');

  // Test 7: Validation — empty passphrase shows error
  assertIncludes(source, "Passphrase cannot be empty", 'shows error on empty passphrase');
  assertIncludes(source, 'setLocalError', 'has local error state');

  // Test 8: Escape key closes modal
  assertIncludes(source, 'Escape', 'closes on Escape key');

  // Test 9: Backdrop click closes modal
  assertIncludes(source, 'handleBackdropClick', 'has backdrop click handler');
  assertIncludes(source, "e.target === e.currentTarget", 'backdrop click checks target');

  // Test 10: ARIA accessibility
  assertIncludes(source, 'role="dialog"', 'has dialog ARIA role');
  assertIncludes(source, 'aria-modal="true"', 'has aria-modal');

  // Test 11: Clears error on input change
  assertIncludes(source, 'setLocalError', 'has local error clearing on input change');
  assertIncludes(source, "if (localError) setLocalError('')", 'clears error when user types');

  // Test 12: No hardcoded masterKey or crypto references
  assertNotIncludes(source, 'masterKey', 'no masterKey reference in component');
  assertNotIncludes(source, 'crypto', 'no crypto reference in component');
  assertNotIncludes(source, 'importLedger', 'no importLedger reference');
  assertNotIncludes(source, 'exportLedger', 'no exportLedger reference');
} else {
  // All fail if file doesn't exist
  for (const label of [
    'exports default function component',
    'component is named PassphraseModal',
    'accepts onSubmit prop',
    'accepts onCancel prop',
    'accepts title prop',
    'accepts description prop',
    'accepts errorMessage prop',
    'default title',
    'passphrase input is type="password"',
    'input has autoFocus',
    'has Confirm button',
    'has Cancel button',
    'uses auth-overlay backdrop class',
    'uses auth-overlay-card class',
    'shows error on empty passphrase',
    'closes on Escape key',
    'has backdrop click handler',
    'has dialog ARIA role',
    'clears error when user types',
    'no masterKey/crypto references',
  ]) {
    assert(false, label);
  }
}

// ── Summary ─────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailed tests:');
  errors.forEach(e => console.log(`  ✗ ${e}`));
}

process.exit(failed > 0 ? 1 : 0);
