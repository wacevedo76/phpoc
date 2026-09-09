/**
 * focus_pull_hook_test.mjs — Web Foreground/Focus Pull hook (TDD Phase 2 / RED).
 *
 * Covers the 25 assertions from docs/planning/C2_WEB_FOCUS_PULL_PHASE1.md:
 *   A — Event triggers (6): visibilitychange/focus/pageshow/mount
 *   B — Guards (3): null sync, missing checkAndSync, hidden mount
 *   C — Re-entrancy & coalescing (4): single-flight, pending re-run, isSyncing, coalesce
 *   D — Result & error handling (6): READY/OFFLINE/REAUTH_NEEDED/GENESIS_MISMATCH, throw, no onResult
 *   E — Cleanup / lifecycle (4): remove listeners, dead-after-dispose, mid-flight teardown, restart
 *   F — Non-blocking (2): fire-and-forget trigger, no unhandled rejection
 *
 * Core function under test: createFocusPull(sync, options) — pure factory, no React.
 *   Returns { start, dispose, isSyncing }.
 *
 * The React wrapper useFocusPull is a thin layer tested during Phase 3 wiring (Vitest/RTL);
 * this node unit suite exercises the pure factory only (mirrors auto_sync_hook_test.mjs).
 *
 * Infrastructure: FakeEventTarget (injected event target), MockSync (deferred checkAndSync),
 * TestHelpers. Zero external dependencies beyond Node.js built-ins.
 *
 * Usage:
 *   node test/focus_pull_hook_test.mjs
 */

import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ── Import module under test (does not exist yet → Phase 2 RED) ──────
let createFocusPull = undefined;
let useFocusPull = undefined;
try {
  const mod = await import('../src/hooks/useFocusPull.js');
  createFocusPull = mod.createFocusPull;
  useFocusPull = mod.useFocusPull;
} catch {
  createFocusPull = undefined;
  useFocusPull = undefined;
}

const hasCreateFocusPull = typeof createFocusPull === 'function';

// ── Helpers ──────────────────────────────────────────────────────────

/** Returns null when the module is not implemented (Phase 2 RED). */
function createPull(sync, opts) {
  if (typeof createFocusPull !== 'function') return null;
  return createFocusPull(sync, opts);
}

function notImplemented(id) {
  t.assert(false, `${id} — NOT IMPLEMENTED (TDD RED phase)`);
}

async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

async function settle(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve all in-flight MockSync deferreds, then flush microtasks so the
 * hook's async `_run` continuation (finally + coalesced re-run) advances.
 */
async function flushAll(sync, result) {
  sync.flush(result);
  await tick();
}

// ═══════════════════════════════════════════════════════════════════════
// FakeEventTarget — records add/remove listener handler refs for E1
// ═══════════════════════════════════════════════════════════════════════
class FakeEventTarget {
  constructor() {
    this._listeners = new Map(); // event -> Set<handler>
    this.added = [];   // { event, handler }
    this.removed = []; // { event, handler }
  }
  addEventListener(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    this.added.push({ event, handler });
  }
  removeEventListener(event, handler) {
    const set = this._listeners.get(event);
    if (set) set.delete(handler);
    this.removed.push({ event, handler });
  }
  dispatch(event) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) handler();
  }
  count(event) {
    const set = this._listeners.get(event);
    return set ? set.size : 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MockSync — deferred checkAndSync with call/active spies
// ═══════════════════════════════════════════════════════════════════════
class MockSync {
  constructor(opts = {}) {
    this.result = opts.result ?? 'READY';       // resolved value
    this.reject = opts.reject ?? null;           // when set, returned promise rejects
    this.manual = opts.manual ?? false;          // when true, hold in-flight until flush()
    this.calls = 0;                              // total checkAndSync invocations
    this.active = 0;                             // currently in-flight count
    this.reconcileClaims = 0;                    // spy: hook must NOT auto-claim (D3)
    this._pending = [];                          // deferred resolvers/rejecters
  }
  checkAndSync() {
    this.calls++;
    if (this.reject) {
      return Promise.reject(this.reject);
    }
    if (this.manual) {
      this.active++;
      return new Promise((resolve, reject) => {
        this._pending.push({
          resolve: (v) => { this.active--; resolve(v === undefined ? this.result : v); },
          reject: (e) => { this.active--; reject(e); },
        });
      });
    }
    this.active++;
    this.active--;
    return Promise.resolve(this.result);
  }
  // Spy that the hook must never call (D3).
  _reconcileAndClaim() {
    this.reconcileClaims++;
  }
  flush(result) {
    while (this._pending.length) this._pending.shift().resolve(result);
  }
  flushReject(err) {
    while (this._pending.length) this._pending.shift().reject(err || new Error('rejected'));
  }
}

/**
 * Build a pull instance + its fake target + mutable visibility/focus state.
 * Returns { pull, target, state }. `overrides` merges into options.
 */
function makePull(sync, overrides = {}) {
  const state = { visible: true, focused: true };
  const target = new FakeEventTarget();
  const options = {
    target,
    events: ['visibilitychange', 'focus', 'pageshow'],
    isVisible: () => state.visible,
    hasFocus: () => state.focused,
    ...overrides,
  };
  const pull = createPull(sync, options);
  return { pull, target, state, options };
}

// ═══════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════

console.log('\n================================================');
console.log('Focus Pull Hook Test Suite (TDD RED phase)');
console.log('================================================');

if (!hasCreateFocusPull) {
  console.log('\n⛔ createFocusPull not implemented — all 25 tests expected to fail (TDD RED phase)');
}

// ── Group A: Event triggers (6) ────────────────────────────────────────
console.log('\n=== Group A — Event triggers (6 tests) ===');

// A1: visibilitychange → visible fires checkAndSync once
{
  const sync = new MockSync();
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('A1'); }
  else {
    pull.start();               // mount pull (#1)
    await settle();
    const before = sync.calls;  // == 1
    target.dispatch('visibilitychange'); // visible → fire
    await settle();
    t.assertEq(sync.calls, before + 1, 'A1a. visibilitychange→visible fires exactly one checkAndSync');
  }
}

// A2: focus fires checkAndSync
{
  const sync = new MockSync();
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('A2'); }
  else {
    pull.start();
    await settle();
    const before = sync.calls;
    target.dispatch('focus');
    await settle();
    t.assertEq(sync.calls, before + 1, 'A2. focus fires checkAndSync');
  }
}

// A3: pageshow fires checkAndSync
{
  const sync = new MockSync();
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('A3'); }
  else {
    pull.start();
    await settle();
    const before = sync.calls;
    target.dispatch('pageshow');
    await settle();
    t.assertEq(sync.calls, before + 1, 'A3. pageshow fires checkAndSync');
  }
}

// A4: visibilitychange → hidden does NOT fire
{
  const sync = new MockSync();
  const { pull, target, state } = makePull(sync);
  if (!pull) { notImplemented('A4'); }
  else {
    pull.start();
    await settle();
    const before = sync.calls;
    state.visible = false;      // backgrounded
    target.dispatch('visibilitychange');
    await settle();
    t.assertEq(sync.calls, before, 'A4. visibilitychange→hidden does NOT fire checkAndSync');
  }
}

// A5: focus with hasFocus()===false does NOT fire
{
  const sync = new MockSync();
  const { pull, target, state } = makePull(sync);
  if (!pull) { notImplemented('A5'); }
  else {
    pull.start();
    await settle();
    const before = sync.calls;
    state.focused = false;      // unfocused window
    target.dispatch('focus');
    await settle();
    t.assertEq(sync.calls, before, 'A5. focus with hasFocus()===false does NOT fire');
  }
}

// A6: start() (screen mount) fires one immediate pull
{
  const sync = new MockSync();
  const { pull } = makePull(sync);
  if (!pull) { notImplemented('A6'); }
  else {
    pull.start();
    await settle();
    t.assertEq(sync.calls, 1, 'A6. start() fires one immediate mount pull');
  }
}

// ── Group B: Guards (3) ────────────────────────────────────────────────
console.log('\n=== Group B — Guards (3 tests) ===');

// B1: sync === null → start() no-op, no crash, no call
{
  const pull = createPull(null, { target: new FakeEventTarget() });
  if (!pull) { notImplemented('B1'); }
  else {
    let threw = false;
    try { pull.start(); } catch { threw = true; }
    t.assert(!threw, 'B1a. start() with null sync does not throw');
    t.assert(typeof pull.isSyncing() === 'boolean', 'B1b. isSyncing() returns a boolean');
  }
}

// B2: sync without checkAndSync → no crash, no call
{
  const pull = createPull({ notAsync: true }, { target: new FakeEventTarget() });
  if (!pull) { notImplemented('B2'); }
  else {
    let threw = false;
    try { pull.start(); } catch { threw = true; }
    t.assert(!threw, 'B2a. start() with sync lacking checkAndSync does not throw');
    t.assertEq(pull.isSyncing(), false, 'B2b. isSyncing() stays false');
  }
}

// B3: isVisible()===false at start() → mount pull suppressed
{
  const sync = new MockSync();
  const { pull } = makePull(sync, { isVisible: () => false, hasFocus: () => true });
  if (!pull) { notImplemented('B3'); }
  else {
    pull.start();
    await settle();
    t.assertEq(sync.calls, 0, 'B3. hidden-tab mount pull suppressed (no checkAndSync)');
  }
}

// ── Group C: Re-entrancy & coalescing (4) ──────────────────────────────
console.log('\n=== Group C — Re-entrancy & coalescing (4 tests) ===');

// C1: event while in-flight → no second concurrent checkAndSync
{
  const sync = new MockSync({ manual: true });
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('C1'); }
  else {
    pull.start();                 // mount pull in-flight (#1)
    t.assertEq(sync.calls, 1, 'C1a. mount pull in-flight');
    target.dispatch('focus');     // during flight
    t.assertEq(sync.calls, 1, 'C1b. no second concurrent checkAndSync during flight');
    await flushAll(sync);
    t.assertEq(sync.calls, 2, 'C1c. one follow-up after completion');
    await flushAll(sync);         // clean up
  }
}

// C2: event during flight → exactly one pending re-run after completion
{
  const sync = new MockSync({ manual: true });
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('C2'); }
  else {
    pull.start();                 // #1 in-flight
    target.dispatch('focus');     // sets pending
    await flushAll(sync);         // complete #1 → re-run #2
    t.assertEq(sync.calls, 2, 'C2a. exactly one pending re-run after completion');
    await flushAll(sync);         // complete #2
    t.assertEq(sync.calls, 2, 'C2b. no further re-run (exactly one total follow-up)');
  }
}

// C3: isSyncing() true during flight, false after settle
{
  const sync = new MockSync({ manual: true });
  const { pull } = makePull(sync);
  if (!pull) { notImplemented('C3'); }
  else {
    pull.start();
    t.assert(pull.isSyncing() === true, 'C3a. isSyncing() true during flight');
    await flushAll(sync);
    t.assert(pull.isSyncing() === false, 'C3b. isSyncing() false after settle');
  }
}

// C4: multiple events during flight → coalesce to a single re-run
{
  const sync = new MockSync({ manual: true });
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('C4'); }
  else {
    pull.start();                     // #1 in-flight
    target.dispatch('focus');
    target.dispatch('visibilitychange');
    target.dispatch('pageshow');
    t.assertEq(sync.calls, 1, 'C4a. burst during flight adds no concurrent calls');
    await flushAll(sync);             // complete #1 → one coalesced re-run
    t.assertEq(sync.calls, 2, 'C4b. burst coalesced into a single re-run (not N)');
    await flushAll(sync);
    t.assertEq(sync.calls, 2, 'C4c. no further calls');
  }
}

// ── Group D: Result & error handling (6) ───────────────────────────────
console.log('\n=== Group D — Result & error handling (6 tests) ===');

// D1: onResult('READY') delivered
{
  const sync = new MockSync({ result: 'READY' });
  const results = [];
  const { pull } = makePull(sync, { onResult: (r) => results.push(r) });
  if (!pull) { notImplemented('D1'); }
  else {
    pull.start();
    await settle();
    t.assertDeepEq(results, ['READY'], 'D1. onResult READY delivered');
  }
}

// D2: onResult('OFFLINE') delivered
{
  const sync = new MockSync({ result: 'OFFLINE' });
  const results = [];
  const { pull } = makePull(sync, { onResult: (r) => results.push(r) });
  if (!pull) { notImplemented('D2'); }
  else {
    pull.start();
    await settle();
    t.assertDeepEq(results, ['OFFLINE'], 'D2. onResult OFFLINE delivered');
  }
}

// D3: onResult('REAUTH_NEEDED') delivered, NO auto-claim
{
  const sync = new MockSync({ result: 'REAUTH_NEEDED' });
  const results = [];
  const { pull } = makePull(sync, { onResult: (r) => results.push(r) });
  if (!pull) { notImplemented('D3'); }
  else {
    pull.start();
    await settle();
    t.assertDeepEq(results, ['REAUTH_NEEDED'], 'D3a. onResult REAUTH_NEEDED delivered');
    t.assertEq(sync.reconcileClaims, 0, 'D3b. hook did NOT call _reconcileAndClaim (no auto-claim)');
  }
}

// D4: onResult('GENESIS_MISMATCH') delivered
{
  const sync = new MockSync({ result: 'GENESIS_MISMATCH' });
  const results = [];
  const { pull } = makePull(sync, { onResult: (r) => results.push(r) });
  if (!pull) { notImplemented('D4'); }
  else {
    pull.start();
    await settle();
    t.assertDeepEq(results, ['GENESIS_MISMATCH'], 'D4. onResult GENESIS_MISMATCH delivered');
  }
}

// D5: checkAndSync throws → swallowed, isSyncing resets, onResult NOT called
{
  const sync = new MockSync({ reject: new Error('boom') });
  const results = [];
  const warned = [];
  const origWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const { pull } = makePull(sync, { onResult: (r) => results.push(r) });
    if (!pull) { notImplemented('D5'); }
    else {
      pull.start();
      await settle();
      t.assertEq(results.length, 0, 'D5a. onResult NOT called on throw');
      t.assertEq(pull.isSyncing(), false, 'D5b. isSyncing() resets after throw');
      t.assert(warned.length > 0, 'D5c. error swallowed via console.warn');
    }
  } finally {
    console.warn = origWarn;
  }
}

// D6: onResult omitted (undefined) → no crash
{
  const sync = new MockSync({ result: 'READY' });
  const { pull } = makePull(sync); // no onResult option
  if (!pull) { notImplemented('D6'); }
  else {
    let threw = false;
    try {
      pull.start();
      await settle();
    } catch { threw = true; }
    t.assert(!threw, 'D6. omitted onResult does not crash');
  }
}

// ── Group E: Cleanup / lifecycle (4) ───────────────────────────────────
console.log('\n=== Group E — Cleanup / lifecycle (4 tests) ===');

// E1: dispose() removes ALL registered listeners (same handler refs)
{
  const sync = new MockSync();
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('E1'); }
  else {
    pull.start();
    pull.dispose();
    for (const ev of ['visibilitychange', 'focus', 'pageshow']) {
      const added = target.added.filter((a) => a.event === ev);
      const removed = target.removed.filter((r) => r.event === ev);
      t.assert(added.length === 1, `E1a. ${ev} registered exactly once`);
      t.assert(removed.length === 1, `E1b. ${ev} removed exactly once`);
      t.assert(added[0].handler === removed[0].handler, `E1c. ${ev} removeEventListener got the SAME handler ref`);
    }
    t.assertEq(target.count('visibilitychange') + target.count('focus') + target.count('pageshow'), 0,
      'E1d. no listeners remain after dispose');
  }
}

// E2: event after dispose() → no call
{
  const sync = new MockSync();
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('E2'); }
  else {
    pull.start();
    await settle();
    pull.dispose();
    const before = sync.calls;
    target.dispatch('focus');
    target.dispatch('visibilitychange');
    await settle();
    t.assertEq(sync.calls, before, 'E2. event after dispose() triggers no checkAndSync');
  }
}

// E3: dispose() during in-flight → no further triggers, in-flight completes, isSyncing resets
{
  const sync = new MockSync({ manual: true });
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('E3'); }
  else {
    pull.start();                 // #1 in-flight
    pull.dispose();               // mid-flight teardown
    target.dispatch('focus');     // must be ignored (disposed)
    let threw = false;
    try { await flushAll(sync); } catch { threw = true; } // in-flight completes
    t.assert(!threw, 'E3a. in-flight checkAndSync completes without crash after dispose');
    t.assertEq(sync.calls, 1, 'E3b. no further triggers after dispose');
    t.assertEq(pull.isSyncing(), false, 'E3c. isSyncing() resets after mid-flight dispose');
  }
}

// E4: start() after dispose() re-registers (idempotent restart)
{
  const sync = new MockSync();
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('E4'); }
  else {
    pull.start();
    await settle();
    pull.dispose();
    pull.start();                 // restart
    await settle();
    const before = sync.calls;
    target.dispatch('focus');     // re-registered → fires
    await settle();
    t.assertEq(sync.calls, before + 1, 'E4. start() after dispose() re-registers and fires again');
  }
}

// ── Group F: Non-blocking (2) ──────────────────────────────────────────
console.log('\n=== Group F — Non-blocking (2 tests) ===');

// F1: event handler returns before checkAndSync resolves
{
  const sync = new MockSync({ manual: true });
  const { pull, target } = makePull(sync);
  if (!pull) { notImplemented('F1'); }
  else {
    pull.start();                 // mount #1 in-flight
    sync.flush();                 // complete mount pull
    await tick();
    target.dispatch('focus');     // handler must return synchronously
    t.assertEq(sync.calls, 2, 'F1a. checkAndSync invoked on focus');
    t.assertEq(sync.active, 1, 'F1b. dispatch returned before checkAndSync resolved (still in-flight)');
    sync.flush();
    await tick();
  }
}

// F2: a rejecting checkAndSync produces no unhandled rejection
{
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const sync = new MockSync({ reject: new Error('boom') });
    const { pull } = makePull(sync);
    if (!pull) { notImplemented('F2'); }
    else {
      pull.start();
      await new Promise((r) => setTimeout(r, 30));
      t.assertEq(unhandled.length, 0, 'F2a. rejecting checkAndSync produces no unhandled rejection');
      t.assertEq(pull.isSyncing(), false, 'F2b. isSyncing() false after rejection');
    }
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

// ── Summary ───────────────────────────────────────────────────────────
const failures = t.summary('focus_pull_hook_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
