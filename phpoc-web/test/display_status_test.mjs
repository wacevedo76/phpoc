/**
 * display_status_test.mjs — computeDisplayStatus() unit tests.
 *
 * Tests the display status derivation logic extracted from SyncSettings.jsx.
 * Pure function — no React, no mocks needed.
 *
 * Usage:
 *   node --experimental-vm-modules test/display_status_test.mjs
 */

import { computeDisplayStatus, STATUS_READY, STATUS_NOT_SYNCED, STATUS_SYNCING, STATUS_OFFLINE, STATUS_REAUTH_NEEDED } from '../src/sync/display_status.js';

// ── Test Infra ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function summary(name) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${name}: ${passed} passed, ${failed} failed`);
  return failed;
}

// ── Helpers ───────────────────────────────────────────────────────────

function cd(opts = {}) {
  return computeDisplayStatus({
    syncing: false,
    isAutoSyncing: false,
    remoteStatus: STATUS_READY,
    hasEntries: false,
    ...opts,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

console.log('\n================================================');
console.log('computeDisplayStatus Unit Tests');
console.log('================================================');

// ═══════════════════════════════════════════════════════════════════════
// Group A: SYNCING priority (syncing beats everything)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n--- Group A: SYNCING priority ---');

// A1: Manual sync in progress → SYNCING
assertEq(cd({ syncing: true, remoteStatus: STATUS_READY }), STATUS_SYNCING,
  'A1: manual sync → SYNCING (overrides READY)');

// A2: Auto-sync in progress → SYNCING
assertEq(cd({ isAutoSyncing: true, remoteStatus: STATUS_READY }), STATUS_SYNCING,
  'A2: auto-sync → SYNCING (overrides READY)');

// A3: Both syncing → SYNCING
assertEq(cd({ syncing: true, isAutoSyncing: true, remoteStatus: STATUS_OFFLINE }), STATUS_SYNCING,
  'A3: both syncing → SYNCING (overrides OFFLINE)');

// A4: Syncing beats NOT_SYNCED
assertEq(cd({ syncing: true, remoteStatus: STATUS_OFFLINE, hasEntries: true }), STATUS_SYNCING,
  'A4: syncing → SYNCING (overrides NOT_SYNCED condition)');

// ═══════════════════════════════════════════════════════════════════════
// Group B: NOT_SYNCED (entries exist + remote hasn't succeeded)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n--- Group B: NOT_SYNCED ---');

// B1: Remote not ready + entries → NOT_SYNCED
assertEq(cd({ remoteStatus: STATUS_OFFLINE, hasEntries: true }), STATUS_NOT_SYNCED,
  'B1: OFFLINE + entries → NOT_SYNCED');

// B2: Remote REAUTH_NEEDED + entries → NOT_SYNCED
assertEq(cd({ remoteStatus: STATUS_REAUTH_NEEDED, hasEntries: true }), STATUS_NOT_SYNCED,
  'B2: REAUTH_NEEDED + entries → NOT_SYNCED');

// B3: Remote SYN CING + entries → NOT_SYNCED (when neither syncing flag set)
assertEq(cd({ remoteStatus: STATUS_SYNCING, hasEntries: true }), STATUS_NOT_SYNCED,
  'B3: remote SYNCING + entries → NOT_SYNCED');

// ═══════════════════════════════════════════════════════════════════════
// Group C: READY passthrough (entries don't override sync success)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n--- Group C: READY passthrough ---');

// C1: READY with entries → READY (entries don't shadow success)
assertEq(cd({ remoteStatus: STATUS_READY, hasEntries: true }), STATUS_READY,
  'C1: READY + entries → READY (entries do not shadow)');

// C2: READY without entries → READY
assertEq(cd({ remoteStatus: STATUS_READY, hasEntries: false }), STATUS_READY,
  'C2: READY + no entries → READY');

// ═══════════════════════════════════════════════════════════════════════
// Group D: Remote status passthrough (no entries to trigger NOT_SYNCED)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n--- Group D: Remote status passthrough ---');

// D1: OFFLINE without entries → OFFLINE (passthrough)
assertEq(cd({ remoteStatus: STATUS_OFFLINE, hasEntries: false }), STATUS_OFFLINE,
  'D1: OFFLINE + no entries → OFFLINE');

// D2: REAUTH_NEEDED without entries → REAUTH_NEEDED
assertEq(cd({ remoteStatus: STATUS_REAUTH_NEEDED, hasEntries: false }), STATUS_REAUTH_NEEDED,
  'D2: REAUTH_NEEDED + no entries → REAUTH_NEEDED');

// D3: Unknown remote status without entries → passthrough
assertEq(cd({ remoteStatus: 'BOGUS', hasEntries: false }), 'BOGUS',
  'D3: unknown status + no entries → passthrough');

// ═══════════════════════════════════════════════════════════════════════
// Group E: Edge cases
// ═══════════════════════════════════════════════════════════════════════
console.log('\n--- Group E: Edge cases ---');

// E1: No syncing, remote OK, no entries → READY (default happy path)
assertEq(cd(), STATUS_READY,
  'E1: all defaults → READY');

// E2: Syncing true with no entries → still SYNCING
assertEq(cd({ syncing: true, hasEntries: false, remoteStatus: STATUS_READY }), STATUS_SYNCING,
  'E2: syncing + no entries → SYNCING (syncing always wins)');

// E3: Auto-syncing true with no entries → still SYNCING
assertEq(cd({ isAutoSyncing: true, hasEntries: false, remoteStatus: STATUS_READY }), STATUS_SYNCING,
  'E3: auto-syncing + no entries → SYNCING');

// ═══════════════════════════════════════════════════════════════════════
// Group F: Constants are correct strings
// ═══════════════════════════════════════════════════════════════════════
console.log('\n--- Group F: Constants ---');

assertEq(STATUS_READY, 'READY', 'F1: STATUS_READY');
assertEq(STATUS_NOT_SYNCED, 'NOT_SYNCED', 'F2: STATUS_NOT_SYNCED');
assertEq(STATUS_SYNCING, 'SYNCING', 'F3: STATUS_SYNCING');
assertEq(STATUS_OFFLINE, 'OFFLINE', 'F4: STATUS_OFFLINE');
assertEq(STATUS_REAUTH_NEEDED, 'REAUTH_NEEDED', 'F5: STATUS_REAUTH_NEEDED');

// ── Summary ───────────────────────────────────────────────────────────
const failures = summary('display_status_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
