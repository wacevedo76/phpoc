/**
 * sync_indicator_test.mjs — SyncIndicator component unit tests.
 *
 * Tests the status-to-config mapping for all 6 statuses plus the
 * compact mode and fallback-to-OFFLINE behavior.
 *
 * SyncIndicator is a pure presentational component — given a status,
 * it renders the correct icon, label, and CSS class.
 *
 * Usage:
 *   node --experimental-vm-modules test/sync_indicator_test.mjs
 */

// SyncIndicator is a JSX component — we test its logic by importing
// source and extracting the config+render logic. Since it's a simple
// pure function, we can unit-test the mapping directly.

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── Test Infra ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertContains(str, substr, label) {
  if (str.includes(substr)) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label} — "${str}" does not contain "${substr}"`);
  }
}

function summary(name) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${name}: ${passed} passed, ${failed} failed`);
  return failed;
}

// ── Load SyncIndicator source ─────────────────────────────────────────

const sourcePath = new URL('../src/components/sync/SyncIndicator.jsx', import.meta.url).pathname;
const source = readFileSync(sourcePath, 'utf-8');

// ── Extract config map via regex ──────────────────────────────────────

// The component defines a `config` object with keys like READY, NOT_SYNCED, etc.
// Extract each entry's icon name, label, and className.
const configEntries = [];
const configRegex = /(\w+):\s*\{\s*icon:\s*Icons\.(\w+),\s*label:\s*'([^']*)',\s*className:\s*'([^']*)'/g;
let match;
while ((match = configRegex.exec(source)) !== null) {
  configEntries.push({
    status: match[1],
    iconName: match[2],
    label: match[3],
    className: match[4],
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

console.log('\n================================================');
console.log('SyncIndicator Unit Tests');
console.log('================================================');

// ── T1: All 6 statuses are defined ────────────────────────────────────
console.log('\n--- T1: Status config completeness ---');

const expectedStatuses = ['READY', 'NOT_SYNCED', 'PENDING', 'SYNCING', 'OFFLINE', 'REAUTH_NEEDED'];
const definedStatuses = configEntries.map(e => e.status);

for (const s of expectedStatuses) {
  assert(definedStatuses.includes(s), `T1.${s}: ${s} status is defined in config`);
}
assertEq(definedStatuses.length, 7, 'T1.count: exactly 7 statuses defined (includes GENESIS_MISMATCH)');

// ── T2: READY status ──────────────────────────────────────────────────
console.log('\n--- T2: READY status ---');

const ready = configEntries.find(e => e.status === 'READY');
assertEq(ready.iconName, 'syncReady', 'T2a: READY uses syncReady icon');
assertEq(ready.label, 'Synced', 'T2b: READY label is "Synced"');
assertEq(ready.className, 'sync-ready', 'T2c: READY className is sync-ready');

// ── T3: NOT_SYNCED status ─────────────────────────────────────────────
console.log('\n--- T3: NOT_SYNCED status ---');

const notSynced = configEntries.find(e => e.status === 'NOT_SYNCED');
assertEq(notSynced.iconName, 'syncPending', 'T3a: NOT_SYNCED uses syncPending icon');
assertEq(notSynced.label, 'Not synced', 'T3b: NOT_SYNCED label is "Not synced"');
assertEq(notSynced.className, 'sync-pending', 'T3c: NOT_SYNCED className is sync-pending');

// ── T4: PENDING status ────────────────────────────────────────────────
console.log('\n--- T4: PENDING status ---');

const pending = configEntries.find(e => e.status === 'PENDING');
assertEq(pending.iconName, 'syncPending', 'T4a: PENDING uses syncPending icon');
assertEq(pending.label, 'Pending...', 'T4b: PENDING label is "Pending..."');
assertEq(pending.className, 'sync-pending', 'T4c: PENDING className is sync-pending');

// ── T5: SYNCING status ────────────────────────────────────────────────
console.log('\n--- T5: SYNCING status ---');

const syncing = configEntries.find(e => e.status === 'SYNCING');
assertEq(syncing.iconName, 'syncing', 'T5a: SYNCING uses syncing icon');
assertEq(syncing.label, 'Syncing...', 'T5b: SYNCING label is "Syncing..."');
assertEq(syncing.className, 'sync-syncing', 'T5c: SYNCING className is sync-syncing');

// ── T6: OFFLINE status ────────────────────────────────────────────────
console.log('\n--- T6: OFFLINE status ---');

const offline = configEntries.find(e => e.status === 'OFFLINE');
assertEq(offline.iconName, 'offline', 'T6a: OFFLINE uses offline icon');
assertEq(offline.label, 'Offline', 'T6b: OFFLINE label is "Offline"');
assertEq(offline.className, 'sync-offline', 'T6c: OFFLINE className is sync-offline');

// ── T7: REAUTH_NEEDED status ──────────────────────────────────────────
console.log('\n--- T7: REAUTH_NEEDED status ---');

const reauth = configEntries.find(e => e.status === 'REAUTH_NEEDED');
assertEq(reauth.iconName, 'reauthNeeded', 'T7a: REAUTH_NEEDED uses reauthNeeded icon');
assertEq(reauth.label, 'Re-auth', 'T7b: REAUTH_NEEDED label is "Re-auth"');
assertEq(reauth.className, 'sync-reauth', 'T7c: REAUTH_NEEDED className is sync-reauth');

// ── T8: Fallback to OFFLINE for unknown status ────────────────────────
console.log('\n--- T8: Fallback for unknown status ---');

// The source contains: const c = config[status] || config.OFFLINE;
assertContains(source, 'config[status] || config.OFFLINE', 'T8a: fallback pattern exists in source');
// Verify OFFLINE is present so the fallback has a target
assert(definedStatuses.includes('OFFLINE'), 'T8b: OFFLINE is defined for fallback');

// ── T9: Compact mode support ──────────────────────────────────────────
console.log('\n--- T9: Compact mode ---');

// The source has a compact prop that changes rendering:
//   if (compact) { return <span className={`sync-dot ${c.className}`} ...> }
//   else { return <div className={`sync-indicator ${c.className}`} ...> }
assertContains(source, 'sync-dot', 'T9a: compact mode uses sync-dot class');
assertContains(source, 'sync-indicator', 'T9b: non-compact mode uses sync-indicator class');
assertContains(source, 'compact = false', 'T9c: compact defaults to false');

// ── T10: Labels are present in both modes ─────────────────────────────
console.log('\n--- T10: Label rendering ---');

// Compact mode: title={c.label}
assertContains(source, 'title={c.label}', 'T10a: compact mode uses title for accessibility');
// Non-compact: <span className="sync-label">{c.label}</span>
assertContains(source, 'sync-label', 'T10b: non-compact mode renders label span');

// ── Summary ───────────────────────────────────────────────────────────
const failures = summary('sync_indicator_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
