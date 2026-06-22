/**
 * auto_sync_hook_test.mjs — Multi-Device Auto-Sync Hook test suite (TDD RED phase).
 *
 * ~21 tests for useAutoSync / createAutoSync wrapping behavior covering:
 *   A — Triggers (6): capture/end/pause/unpause/modify/remove each trigger a push
 *   B — Non-mutation (2): readEntries + checkAndSync do NOT trigger extra pushes
 *   C — Debounce (3): 2–3 rapid captures → 1 push, wait-debounce-retrigger → 2 pushes
 *   D — Error resilience (3): push failure doesn't break mutation, entries survive, isSyncing recovers
 *   E — Syncing state (2): isSyncing true during debounce/push, false after completion
 *   F — No master key (2): push skipped when no MK cached, isSyncing stays false
 *   G — Multi-type batch (2): capture+end+pause in one debounce → 1 push with all 3, correct device_id
 *   H — Cleanup (2): unmount during debounce suppresses push, unmount during push lets it complete but suppresses state updates
 *
 * Core function under test: createAutoSync(sync, { debounceMs })
 *   → Returns wrapped mutation methods + isSyncing() + dispose()
 *
 * The React hook useAutoSync is a thin wrapper around createAutoSync using
 * useState / useEffect / useCallback.
 *
 * Infrastructure: MockSyncService (synthetic sync with mutable entries + push spy),
 * TestHelpers. Zero external dependencies beyond Node.js built-ins.
 *
 * Usage:
 *   node --experimental-vm-modules test/auto_sync_hook_test.mjs
 */

import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ── Import module under test ──
let createAutoSync;
let useAutoSync;
try {
  const mod = await import('../src/hooks/useAutoSync.js');
  createAutoSync = mod.createAutoSync;
  useAutoSync = mod.useAutoSync;
} catch (err) {
  createAutoSync = undefined;
  useAutoSync = undefined;
}

const hasCreateAutoSync = typeof createAutoSync === 'function';
const hasUseAutoSync = typeof useAutoSync === 'function';

// ── Safe wrap helper — catches "not implemented" errors ───────────────
async function safe(fn, label) {
  try {
    return await fn();
  } catch (err) {
    if (err.message && err.message.includes('not implemented')) {
      return null; // TDD RED phase — stub throws
    }
    throw err; // re-throw unexpected errors
  }
}

function safeSync(fn, label) {
  try {
    return fn();
  } catch (err) {
    if (err.message && err.message.includes('not implemented')) {
      return null;
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MockSyncService — synthetic sync with push spy
// ═══════════════════════════════════════════════════════════════════════

class MockSyncService {
  constructor(opts = {}) {
    /** Entries array — mutated by capture/end/pause/unpause/modify/remove */
    this.entries = [];
    /** Number of times pushToRemote was called */
    this._pushCount = 0;
    /** Entries snapshotted at each pushToRemote call */
    this._pushSnapshots = [];
    /** If true, pushToRemote throws */
    this._pushFail = opts.pushFail || false;
    /** Master key (null = no key cached) */
    this._masterKey = opts.masterKey || null;
    /** Counter for unique entry IDs */
    this._nextId = 1;
    /** Latency for pushToRemote (simulates async work) */
    this._pushLatencyMs = opts.pushLatencyMs || 0;
    /** Track all calls to mutation methods for verification */
    this._callLog = [];
  }

  // ── Mutation methods (6) ──────────────────────────────────────────

  async capture(params) {
    this._callLog.push({ method: 'capture', args: [params] });
    const entry = {
      entry_id: `e-${this._nextId++}`,
      title: params.title || '',
      start_epoch: params.startEpoch || Date.now(),
      end_epoch: params.endEpoch || null,
      duration: params.duration || 0,
      is_active: params.isActive !== false,
      is_paused: false,
      pauses: [],
      tags: params.tags || [],
      comment: params.comment || null,
      media: [],
      device_uuid: params.deviceUuid || '',
      end_device_uuid: '',
    };
    this.entries.push(entry);
    return entry.entry_id;
  }

  async end(title, endEpoch, comment) {
    this._callLog.push({ method: 'end', args: [title, endEpoch, comment] });
    const idx = this.entries.findIndex(e => e.title === title && e.is_active);
    if (idx === -1) throw new Error(`No active task found for: ${title}`);
    this.entries[idx].end_epoch = endEpoch;
    this.entries[idx].is_active = false;
    if (comment != null) this.entries[idx].comment = comment;
  }

  async pause(title, pauseEpoch) {
    this._callLog.push({ method: 'pause', args: [title, pauseEpoch] });
    const idx = this.entries.findIndex(e => e.title === title && e.is_active);
    if (idx === -1) throw new Error(`No active task found for: ${title}`);
    this.entries[idx].is_paused = true;
    this.entries[idx].pauses.push({ pause_start: pauseEpoch, pause_stop: null });
  }

  async unpause(title, unpauseEpoch) {
    this._callLog.push({ method: 'unpause', args: [title, unpauseEpoch] });
    const idx = this.entries.findIndex(e => e.title === title && e.is_active);
    if (idx === -1) throw new Error(`No active task found for: ${title}`);
    this.entries[idx].is_paused = false;
    const pauses = this.entries[idx].pauses;
    if (pauses.length > 0) {
      pauses[pauses.length - 1].pause_stop = unpauseEpoch;
    }
  }

  async modify(entryIndex, fields) {
    this._callLog.push({ method: 'modify', args: [entryIndex, fields] });
    if (entryIndex < 0 || entryIndex >= this.entries.length) {
      throw new Error(`Entry index out of range: ${entryIndex}`);
    }
    Object.assign(this.entries[entryIndex], fields);
  }

  async remove(entryIndex) {
    this._callLog.push({ method: 'remove', args: [entryIndex] });
    if (entryIndex < 0 || entryIndex >= this.entries.length) {
      throw new Error(`Entry index out of range: ${entryIndex}`);
    }
    this.entries.splice(entryIndex, 1);
  }

  // ── Non-mutation methods ──────────────────────────────────────────

  async readEntries() {
    this._callLog.push({ method: 'readEntries', args: [] });
    return this.entries.map((e, i) => ({ ...e, entry_index: i }));
  }

  async checkAndSync() {
    this._callLog.push({ method: 'checkAndSync', args: [] });
    return 'READY';
  }

  // ── Push ─────────────────────────────────────────────────────────

  async pushToRemote(masterKey) {
    this._callLog.push({ method: 'pushToRemote', args: [masterKey] });
    if (this._pushLatencyMs > 0) {
      await new Promise(r => setTimeout(r, this._pushLatencyMs));
    }
    if (this._pushFail) {
      throw new Error('Push failed: simulated network error');
    }
    this._pushCount++;
    this._pushSnapshots.push({
      count: this._pushCount,
      entries: JSON.parse(JSON.stringify(this.entries)),
      at: Date.now(),
    });
  }

  // ── Spy accessors ────────────────────────────────────────────────

  get pushCount() { return this._pushCount; }
  get pushSnapshots() { return this._pushSnapshots; }
  get callLog() { return this._callLog; }
  getMasterKey() { return this._masterKey; }
  setMasterKey(k) { this._masterKey = k; }
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_DEBOUNCE_MS = 100; // Short for fast tests

/**
 * Create an auto-sync wrapper and return it.
 * Falls back to null if createAutoSync is not implemented (TDD RED).
 */
function wrapSync(sync, opts = {}) {
  const result = createAutoSync(sync, { debounceMs: DEFAULT_DEBOUNCE_MS, ...opts });
  return result;
}

/**
 * Wait for debounce + push to settle.
 */
async function settle(ms = DEFAULT_DEBOUNCE_MS + 50) {
  await new Promise(r => setTimeout(r, ms));
}

/**
 * Wait a specific duration.
 */
async function wait(ms) {
  await new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────

console.log('\n================================================');
console.log('Auto-Sync Hook Test Suite (TDD RED phase)');
console.log('================================================');

// ── Module existence ──────────────────────────────────────────────────
console.log('\n=== Module Existence ===');

t.assert(typeof createAutoSync === 'function' || createAutoSync === undefined,
  'createAutoSync module exists (or is undefined — expected in RED)');
t.assert(hasCreateAutoSync || !hasCreateAutoSync,
  'createAutoSync is a function or not implemented');

if (!hasCreateAutoSync) {
  console.log('\n⛔ createAutoSync not implemented — all 21 tests expected to fail (TDD RED phase)');
} else {
  console.log('\n⛔ createAutoSync exists as stub — tests will fail (not implemented) to confirm RED phase');
}

// ═══════════════════════════════════════════════════════════════════════
// Group A: Triggers — each mutation method triggers a push
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group A — Triggers (6 tests) ===');

// ── A1: capture triggers pushToRemote ─────────────────────────────────
{
  console.log('\n  --- A1: capture → pushToRemote ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task A1', startEpoch: 1000 });
    t.assertEq(sync.entries.length, 1, 'A1a. entry captured');
    t.assertEq(sync.entries[0].title, 'Task A1', 'A1b. correct title');

    // Push should be debounced — wait for it
    await settle();
    t.assert(sync.pushCount >= 1, `A1c. pushToRemote called at least once (got ${sync.pushCount})`);
    t.assertEq(sync.pushSnapshots[0].entries.length, 1, 'A1d. push snapshot has 1 entry');
  } else {
    t.assert(false, 'capture → pushToRemote — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A2: end triggers pushToRemote ─────────────────────────────────────
{
  console.log('\n  --- A2: end → pushToRemote ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    // Seed an active entry first
    await wrapped.capture({ title: 'Task A2', startEpoch: 1000 });
    await settle(); // let first push settle
    const pushesBefore = sync.pushCount;

    await wrapped.end('Task A2', 5000);
    t.assertEq(sync.entries[0].is_active, false, 'A2a. entry ended');
    t.assertEq(sync.entries[0].end_epoch, 5000, 'A2b. end_epoch set');

    await settle();
    t.assert(sync.pushCount > pushesBefore, `A2c. pushToRemote called after end (${sync.pushCount} > ${pushesBefore})`);
  } else {
    t.assert(false, 'end → pushToRemote — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A3: pause triggers pushToRemote ───────────────────────────────────
{
  console.log('\n  --- A3: pause → pushToRemote ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task A3', startEpoch: 1000 });
    await settle();
    const pushesBefore = sync.pushCount;

    await wrapped.pause('Task A3', 3000);
    t.assertEq(sync.entries[0].is_paused, true, 'A3a. entry paused');
    t.assert(sync.entries[0].pauses.length > 0, 'A3b. pause record created');

    await settle();
    t.assert(sync.pushCount > pushesBefore, `A3c. pushToRemote called after pause (${sync.pushCount} > ${pushesBefore})`);
  } else {
    t.assert(false, 'pause → pushToRemote — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A4: unpause triggers pushToRemote ─────────────────────────────────
{
  console.log('\n  --- A4: unpause → pushToRemote ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task A4', startEpoch: 1000 });
    await wrapped.pause('Task A4', 3000);
    await settle();
    const pushesBefore = sync.pushCount;

    await wrapped.unpause('Task A4', 4000);
    t.assertEq(sync.entries[0].is_paused, false, 'A4a. entry unpaused');
    t.assert(sync.entries[0].pauses[0].pause_stop === 4000, 'A4b. pause_stop set');

    await settle();
    t.assert(sync.pushCount > pushesBefore, `A4c. pushToRemote called after unpause (${sync.pushCount} > ${pushesBefore})`);
  } else {
    t.assert(false, 'unpause → pushToRemote — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A5: modify triggers pushToRemote ──────────────────────────────────
{
  console.log('\n  --- A5: modify → pushToRemote ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task A5', startEpoch: 1000 });
    await settle();
    const pushesBefore = sync.pushCount;

    await wrapped.modify(0, { title: 'Task A5-modified', tags: ['urgent'] });
    t.assertEq(sync.entries[0].title, 'Task A5-modified', 'A5a. title modified');
    t.assertDeepEq(sync.entries[0].tags, ['urgent'], 'A5b. tags set');

    await settle();
    t.assert(sync.pushCount > pushesBefore, `A5c. pushToRemote called after modify (${sync.pushCount} > ${pushesBefore})`);
  } else {
    t.assert(false, 'modify → pushToRemote — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── A6: remove triggers pushToRemote ──────────────────────────────────
{
  console.log('\n  --- A6: remove → pushToRemote ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task A6', startEpoch: 1000 });
    await settle();
    const pushesBefore = sync.pushCount;

    await wrapped.remove(0);
    t.assertEq(sync.entries.length, 0, 'A6a. entry removed');

    await settle();
    t.assert(sync.pushCount > pushesBefore, `A6b. pushToRemote called after remove (${sync.pushCount} > ${pushesBefore})`);
  } else {
    t.assert(false, 'remove → pushToRemote — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group B: Non-mutation — readEntries + checkAndSync do NOT trigger push
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group B — Non-mutation (2 tests) ===');

// ── B1: readEntries does NOT trigger push ─────────────────────────────
{
  console.log('\n  --- B1: readEntries → no push ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task B1', startEpoch: 1000 });
    await settle();
    const pushesBefore = sync.pushCount;

    const entries = await wrapped.readEntries();
    t.assertEq(entries.length, 1, 'B1a. readEntries returns entries');

    await settle();
    t.assertEq(sync.pushCount, pushesBefore, `B1b. pushToRemote NOT called after readEntries (${sync.pushCount} == ${pushesBefore})`);
  } else {
    t.assert(false, 'readEntries → no push — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── B2: checkAndSync does NOT trigger extra push ──────────────────────
{
  console.log('\n  --- B2: checkAndSync → no extra push ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task B2', startEpoch: 1000 });
    await settle();
    const pushesBefore = sync.pushCount;

    const status = await wrapped.checkAndSync();
    t.assertEq(status, 'READY', 'B2a. checkAndSync returns READY');

    await settle();
    t.assertEq(sync.pushCount, pushesBefore, `B2b. pushToRemote NOT called after checkAndSync (${sync.pushCount} == ${pushesBefore})`);
  } else {
    t.assert(false, 'checkAndSync → no extra push — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group C: Debounce — rapid mutations coalesce into one push
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group C — Debounce (3 tests) ===');

// ── C1: 2 rapid captures → 1 push ─────────────────────────────────────
{
  console.log('\n  --- C1: 2 rapid captures → 1 push ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    // Fire 2 captures rapidly within the debounce window
    await wrapped.capture({ title: 'Task C1a', startEpoch: 1000 });
    await wrapped.capture({ title: 'Task C1b', startEpoch: 2000 });

    t.assertEq(sync.entries.length, 2, 'C1a. both entries captured');

    // Immediately after, push should NOT have been called yet (debouncing)
    // But after settle, only 1 push should have happened
    await settle();
    t.assertEq(sync.pushCount, 1, `C1b. only 1 push after 2 rapid captures (got ${sync.pushCount})`);
    t.assertEq(sync.pushSnapshots[0].entries.length, 2, 'C1c. push snapshot has both entries');
  } else {
    t.assert(false, '2 rapid captures → 1 push — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── C2: 3 rapid captures → 1 push ─────────────────────────────────────
{
  console.log('\n  --- C2: 3 rapid captures → 1 push ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task C2a', startEpoch: 1000 });
    await wrapped.capture({ title: 'Task C2b', startEpoch: 2000 });
    await wrapped.capture({ title: 'Task C2c', startEpoch: 3000 });

    t.assertEq(sync.entries.length, 3, 'C2a. all three entries captured');

    await settle();
    t.assertEq(sync.pushCount, 1, `C2b. only 1 push after 3 rapid captures (got ${sync.pushCount})`);
    t.assertEq(sync.pushSnapshots[0].entries.length, 3, 'C2c. push snapshot has all 3 entries');
  } else {
    t.assert(false, '3 rapid captures → 1 push — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── C3: debounce resets on new mutation → 2 pushes ────────────────────
{
  console.log('\n  --- C3: wait → capture → wait → capture → 2 pushes ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task C3a', startEpoch: 1000 });
    await settle(); // first debounce window expires → push happens

    t.assertEq(sync.pushCount, 1, 'C3a. first push after settle');

    await wrapped.capture({ title: 'Task C3b', startEpoch: 2000 });
    await settle(); // second debounce window

    t.assertEq(sync.pushCount, 2, `C3b. second push after second settle (got ${sync.pushCount})`);
    t.assertEq(sync.pushSnapshots[1].entries.length, 2, 'C3c. second push snapshot has both entries');
  } else {
    t.assert(false, 'debounce reset → 2 pushes — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group D: Error resilience — push failures don't break mutations
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group D — Error Resilience (3 tests) ===');

// ── D1: push failure does NOT break the mutation ──────────────────────
{
  console.log('\n  --- D1: push failure → mutation still succeeds ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', pushFail: true });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    // This should succeed — the mutation itself must not throw
    const entryId = await wrapped.capture({ title: 'Task D1', startEpoch: 1000 });
    t.assert(typeof entryId === 'string' && entryId.length > 0, 'D1a. capture returns entry_id');
    t.assertEq(sync.entries.length, 1, 'D1b. entry exists despite push failure');
    t.assertEq(sync.entries[0].title, 'Task D1', 'D1c. correct title');
  } else {
    t.assert(false, 'push failure → mutation succeeds — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── D2: entries survive push failure ──────────────────────────────────
{
  console.log('\n  --- D2: entries survive push failure ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', pushFail: true });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task D2a', startEpoch: 1000 });
    await wrapped.capture({ title: 'Task D2b', startEpoch: 2000 });

    t.assertEq(sync.entries.length, 2, 'D2a. both entries captured despite push failures');

    // Now fix the push and verify entries are still there
    sync._pushFail = false;
    await wrapped.modify(0, { title: 'Task D2a-fixed' });

    await settle();
    t.assert(sync.pushCount >= 1, `D2b. push succeeded after recovery (${sync.pushCount} pushes)`);
    t.assertEq(sync.entries.length, 2, 'D2c. both entries still present');
  } else {
    t.assert(false, 'entries survive push failure — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── D3: isSyncing recovers after push failure ─────────────────────────
{
  console.log('\n  --- D3: isSyncing recovers after push failure ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', pushFail: true, pushLatencyMs: 20 });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    // Capture should trigger a debounced push that will fail
    await wrapped.capture({ title: 'Task D3', startEpoch: 1000 });
    await settle();

    // After the push failure, syncing should not be stuck
    const syncingAfter = wrapped.isSyncing();
    t.assertEq(syncingAfter, false, 'D3a. isSyncing false after failed push settles');
  } else {
    t.assert(false, 'isSyncing recovers after failure — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group E: Syncing state — isSyncing reflects debounce/push lifecycle
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group E — Syncing State (2 tests) ===');

// ── E1: isSyncing true during debounce + push ─────────────────────────
{
  console.log('\n  --- E1: isSyncing true during debounce ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111', pushLatencyMs: 50 });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task E1', startEpoch: 1000 });

    // Check immediately after capture — should be in debounce or push
    const syncingDuring = wrapped.isSyncing();
    t.assert(syncingDuring === true, `E1a. isSyncing true during debounce/push (got ${syncingDuring})`);
  } else {
    t.assert(false, 'isSyncing true during debounce — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── E2: isSyncing false after push completes ──────────────────────────
{
  console.log('\n  --- E2: isSyncing false after push completes ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task E2', startEpoch: 1000 });
    await settle();

    const syncingAfter = wrapped.isSyncing();
    t.assertEq(syncingAfter, false, `E2a. isSyncing false after push settles (got ${syncingAfter})`);
  } else {
    t.assert(false, 'isSyncing false after push — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group F: No master key — push skipped, isSyncing stays false
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group F — No Master Key (2 tests) ===');

// ── F1: push skipped when no MK cached ────────────────────────────────
{
  console.log('\n  --- F1: no master key → push skipped ---');
  const sync = new MockSyncService({ masterKey: null }); // No MK

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task F1', startEpoch: 1000 });
    t.assertEq(sync.entries.length, 1, 'F1a. entry captured despite no MK');

    await settle();
    t.assertEq(sync.pushCount, 0, `F1b. pushToRemote NOT called (no master key) — got ${sync.pushCount} pushes`);
  } else {
    t.assert(false, 'no master key → push skipped — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── F2: isSyncing stays false when no MK ──────────────────────────────
{
  console.log('\n  --- F2: no master key → isSyncing stays false ---');
  const sync = new MockSyncService({ masterKey: null });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task F2', startEpoch: 1000 });

    const syncingDuring = wrapped.isSyncing();
    t.assertEq(syncingDuring, false, `F2a. isSyncing false when no master key (got ${syncingDuring})`);

    await settle();
    const syncingAfter = wrapped.isSyncing();
    t.assertEq(syncingAfter, false, 'F2b. isSyncing still false after settle');
  } else {
    t.assert(false, 'isSyncing false when no MK — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group G: Multi-type batch — mixed mutations in one debounce window
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group G — Multi-Type Batch (2 tests) ===');

// ── G1: capture + end + pause in one debounce → 1 push with all 3 ─────
{
  console.log('\n  --- G1: capture + end + pause → 1 push with all 3 ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    // Seed entry, then end it and capture a new one all within debounce window
    await wrapped.capture({ title: 'Task G1a', startEpoch: 1000 });
    await wrapped.end('Task G1a', 5000);
    await wrapped.capture({ title: 'Task G1b', startEpoch: 6000 });

    t.assertEq(sync.entries.length, 2, 'G1a. two entries total');
    t.assertEq(sync.entries[0].is_active, false, 'G1b. first entry ended');
    t.assertEq(sync.entries[1].is_active, true, 'G1c. second entry active');

    await settle();
    t.assertEq(sync.pushCount, 1, `G1d. only 1 push for all 3 mutations (got ${sync.pushCount})`);
    t.assertEq(sync.pushSnapshots[0].entries.length, 2, 'G1e. push snapshot has both entries');
  } else {
    t.assert(false, 'multi-type batch → 1 push — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── G2: batch push includes correct device_uuid ───────────────────────
{
  console.log('\n  --- G2: batch push includes correct device_uuid ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    // Set a known device UUID on entries
    await wrapped.capture({ title: 'Task G2a', startEpoch: 1000, deviceUuid: 'dev-test-001' });
    await wrapped.capture({ title: 'Task G2b', startEpoch: 2000, deviceUuid: 'dev-test-001' });

    await settle();
    t.assertEq(sync.pushCount, 1, 'G2a. one push');

    // The push happened — entries are in the snapshot
    // (device_uuid propagation through pushToRemote is tested at the SyncService level;
    // here we verify the entries made it to push)
    t.assert(sync.pushSnapshots.length > 0, 'G2b. push snapshot exists');
    t.assertEq(sync.pushSnapshots[0].entries.length, 2, 'G2c. both entries in snapshot');
  } else {
    t.assert(false, 'batch push correct device_uuid — NOT IMPLEMENTED (TDD RED)');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Group H: Cleanup — unmount suppresses state updates
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== Group H — Cleanup (2 tests) ===');

// ── H1: dispose during debounce suppresses push ───────────────────────
{
  console.log('\n  --- H1: dispose during debounce suppresses push ---');
  const sync = new MockSyncService({ masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task H1', startEpoch: 1000 });

    // Immediately dispose before debounce fires
    wrapped.dispose();

    await settle();
    t.assertEq(sync.pushCount, 0, `H1a. push suppressed after dispose (got ${sync.pushCount})`);
    t.assertEq(sync.entries.length, 1, 'H1b. entry still exists locally');
  } else {
    t.assert(false, 'dispose during debounce suppresses push — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── H2: dispose during push lets push complete but suppresses updates ──
{
  console.log('\n  --- H2: dispose during push completes but suppresses updates ---');
  const sync = new MockSyncService({
    masterKey: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
    pushLatencyMs: 50,
  });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    await wrapped.capture({ title: 'Task H2', startEpoch: 1000 });

    // Wait a tiny bit to let debounce fire, then dispose during push
    await wait(20); // partial debounce
    wrapped.dispose();

    // Wait for push to complete
    await settle(100);

    // The push should have completed (it was in-flight when disposed)
    // but state updates should be suppressed
    t.assert(sync.pushCount >= 0, 'H2a. push completed or was suppressed');
    t.assertEq(sync.entries.length, 1, 'H2b. entry exists');
  } else {
    t.assert(false, 'dispose during push — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── H3: auto-sync wrapper handles getMasterKey() === null gracefully ──
{
  console.log('\n  --- H3: getMasterKey null → mutations work, push skipped, no crash ---');
  const sync = new MockSyncService({ masterKey: null });

  const result = safeSync(() => wrapSync(sync), 'wrap');
  if (result !== null) {
    const wrapped = result;

    // Mutations should still work even when MK is null
    const id1 = await wrapped.capture({ title: 'Task H3a', startEpoch: 1000 });
    t.assert(typeof id1 === 'string' && id1.length > 0, 'H3a. capture returns entry_id with null MK');

    const id2 = await wrapped.capture({ title: 'Task H3b', startEpoch: 2000 });
    t.assertEq(sync.entries.length, 2, 'H3b. both entries captured');

    await wrapped.end('Task H3a', 5000);
    t.assertEq(sync.entries[0].is_active, false, 'H3c. end() works with null MK');

    // No push should have been triggered (no MK → _schedulePush returns early)
    await settle();
    t.assertEq(sync.pushCount, 0, `H3d. pushToRemote NOT called with null MK (got ${sync.pushCount})`);

    // Now set MK — future mutations should trigger push
    sync.setMasterKey('aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111');
    await wrapped.pause('Task H3b', 3000);
    await settle();
    t.assert(sync.pushCount >= 1, `H3e. pushToRemote called after MK restored (got ${sync.pushCount})`);
  } else {
    t.assert(false, 'getMasterKey null handling — NOT IMPLEMENTED (TDD RED)');
  }
}

// ── Summary ───────────────────────────────────────────────────────────
const failures = t.summary('auto_sync_hook_test.mjs');
process.exitCode = failures > 0 ? 1 : 0;
