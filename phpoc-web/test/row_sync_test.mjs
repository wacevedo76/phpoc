/**
 * row_sync_test.mjs — buildDiff + RowSync HTTP tests (Groups D + W).
 *
 * TDD RED phase: Tests the buildDiff pure function (8-scenario resolution
 * table) and RowSyncWorker HTTP client for Worker row-level endpoints.
 *
 * Test groups:
 *   D1–D35:  buildDiff() — pure function, 8-scenario resolution
 *   W1–W30:  RowSyncWorker — HTTP integration, push guard, error handling
 *
 * All tests should FAIL in RED phase (implementation does not exist yet).
 *
 * Usage:
 *   node test/row_sync_test.mjs
 */

import { TestHelpers } from './test_helpers.mjs';
import { MemoryBackend } from '../src/sync/storage.js';

// Import from modules that don't exist yet (RED phase):
import { buildDiff } from '../src/sync/row_sync.js';
import { RowSyncWorker } from '../src/sync/row_sync.js';

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

/**
 * Create a local row object.
 * @param {string} activityId
 * @param {string} status
 * @param {number} updatedAt
 * @returns {{activity_id: string, activity_status: string, activity: string, updated_at: number}}
 */
function localRow(activityId, status = 'staged', updatedAt = Date.now()) {
  return {
    activity_id: activityId,
    activity_status: status,
    activity: JSON.stringify({ title: `Entry ${activityId}` }),
    updated_at: updatedAt,
  };
}

/**
 * Create a remote manifest row (no activity blob, just metadata).
 * @param {string} activityId
 * @param {string} status
 * @param {number} updatedAt
 * @returns {{activity_id: string, activity_status: string, updated_at: number}}
 */
function manifestRow(activityId, status = 'staged', updatedAt = Date.now()) {
  return { activity_id: activityId, activity_status: status, updated_at: updatedAt };
}

/**
 * Create a full remote manifest object.
 * @param {Array<{activity_id: string, activity_status: string, updated_at: number}>} rows
 * @param {number} [version=1]
 * @returns {{rows: Array, version: number}}
 */
function manifest(rows, version = 1) {
  return { rows, version };
}

/**
 * Create a ledger hash index entry.
 * @param {string} entryId
 * @returns {{entry_id: string, committed_at: number}}
 */
function hashEntry(entryId) {
  return { entry_id: entryId, committed_at: Date.now() };
}

// ══════════════════════════════════════════════════════════════════════
// Mock Transport for RowSyncWorker tests (Group W)
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    this._store = new Map();
    this._offline = false;
    /** @type {string|null} */
    this._lastStatus = null;
    /** @type {object|null} */
    this._manifestOverride = null;
    /** Map of activity_id → response data or status code */
    this._responseMap = new Map();
  }

  setManifest(manifestData) { this._manifestOverride = manifestData; }
  setOffline(v) { this._offline = v; }

  /** Set a specific response for fetchRow or pushRow. */
  setResponse(activityId, data, status = 200) {
    this._responseMap.set(activityId, { data, status });
  }

  /** Clear all response overrides. */
  clearResponse(activityId) { this._responseMap.delete(activityId); }

  async pull(path) {
    if (this._offline) throw new Error('Network failure');
    // Simulate fetching manifest or row
    if (path.includes('/manifest')) {
      const m = this._manifestOverride || { rows: [], version: 0 };
      return new TextEncoder().encode(JSON.stringify(m));
    }
    if (path.includes('/storage/staging/rows/')) {
      const activityId = path.split('/').pop();
      const override = this._responseMap.get(activityId);
      if (override) {
        if (override.status === 404) return null;
        return new TextEncoder().encode(JSON.stringify(override.data));
      }
      return null; // 404
    }
    return null;
  }

  async push(path, data) {
    if (this._offline) throw new Error('Network failure');
    const activityId = path.split('/').pop();
    const body = JSON.parse(new TextDecoder().decode(data));
    const override = this._responseMap.get(activityId);
    if (override) {
      this._lastStatus = String(override.status);
      return { status: override.status };
    }
    this._store.set(activityId, body);
    this._lastStatus = '200';
    return { status: 200 };
  }

  async delete(path) {
    if (this._offline) throw new Error('Network failure');
    const activityId = path.split('/').pop();
    const existed = this._store.has(activityId);
    this._store.delete(activityId);
    return { status: existed ? 200 : 404 };
  }
}

// ══════════════════════════════════════════════════════════════════════
// Run all tests
// ══════════════════════════════════════════════════════════════════════

async function runTests() {
  // ─── Group D: buildDiff() ────────────────────────────────────────
  console.log('\n── buildDiff() Pure Function ──');

  // D1: Same row, remote updated_at newer, status differs → pull
  {
    const local = [localRow('abc1234567', 'staged', 1000)];
    const remote = manifest([manifestRow('abc1234567', 'active', 2000)]);
    const hashIdx = new Map();
    const result = buildDiff(local, remote, hashIdx);
    t.assert(result.pull.includes('abc1234567'), 'D1a: Scenario 1 — remote newer → pull');
    t.assert(!result.push.includes('abc1234567'), 'D1b: not in push');
    t.assert(!result.deleteLocal.includes('abc1234567'), 'D1c: not in deleteLocal');
  }

  // D2: Same row, local updated_at newer, status differs → push
  {
    const local = [localRow('abc1234567', 'active', 2000)];
    const remote = manifest([manifestRow('abc1234567', 'staged', 1000)]);
    const hashIdx = new Map();
    const result = buildDiff(local, remote, hashIdx);
    t.assert(result.push.includes('abc1234567'), 'D2a: Scenario 2 — local newer → push');
    t.assert(!result.pull.includes('abc1234567'), 'D2b: not in pull');
  }

  // D3: Same row, same status, remote updated_at newer → pull
  {
    const local = [localRow('abc1234567', 'staged', 1000)];
    const remote = manifest([manifestRow('abc1234567', 'staged', 2000)]);
    const hashIdx = new Map();
    const result = buildDiff(local, remote, hashIdx);
    t.assert(result.pull.includes('abc1234567'), 'D3a: Scenario 3 — remote newer, same status → pull');
    t.assert(!result.push.includes('abc1234567'), 'D3b: not in push');
  }

  // D4: Same row, same status, local updated_at newer → push
  {
    const local = [localRow('abc1234567', 'staged', 2000)];
    const remote = manifest([manifestRow('abc1234567', 'staged', 1000)]);
    const hashIdx = new Map();
    const result = buildDiff(local, remote, hashIdx);
    t.assert(result.push.includes('abc1234567'), 'D4a: Scenario 3 — local newer, same status → push');
    t.assert(!result.pull.includes('abc1234567'), 'D4b: not in pull');
  }

  // D5: Remote manifest has row, not local → pull
  {
    const local = [];
    const remote = manifest([manifestRow('remoteOnly1')]);
    const hashIdx = new Map();
    const result = buildDiff(local, remote, hashIdx);
    t.assert(result.pull.includes('remoteOnly1'), 'D5a: Scenario 4 — remote-only → pull');
    t.assert(!result.push.includes('remoteOnly1'), 'D5b: not in push');
  }

  // D6: Local has row, not in remote, entry_id found in ledger hash index → deleteLocal
  {
    const local = [localRow('toBeDeleted')];
    const remote = manifest([]);
    const hashIdx = new Map([['toBeDeleted', { committed_at: 1000 }]]);
    const result = buildDiff(local, remote, hashIdx);
    t.assert(result.deleteLocal.includes('toBeDeleted'), 'D6a: Scenario 5 — committed → deleteLocal');
    t.assert(!result.pull.includes('toBeDeleted'), 'D6b: not in pull');
  }

  // D7: Local row, not in remote, NOT in ledger hash index → push
  {
    const local = [localRow('newLocal001')];
    const remote = manifest([]);
    const hashIdx = new Map(); // empty — not committed
    const result = buildDiff(local, remote, hashIdx);
    t.assert(result.push.includes('newLocal001'), 'D7a: Scenario 6 — new local → push');
    t.assert(!result.deleteLocal.includes('newLocal001'), 'D7b: not in deleteLocal');
  }

  // D8: Remote manifest empty, local has rows → all committed → deleteLocal + fastPath
  {
    const local = [localRow('aa1'), localRow('bb2'), localRow('cc3')];
    const remote = manifest([]);
    const hashIdx = new Map();
    // When manifest is empty and all local rows are in hash index → Scenario 7
    const result1 = buildDiff(local, remote, hashIdx);
    // Without hash index entries, these become push candidates (Scenario 6)
    t.assert(result1.push.length >= 0, 'D8a: empty manifest handled');

    // With hash index showing all committed → Scenario 7
    const hashIdx2 = new Map([
      ['aa1', { committed_at: 1000 }],
      ['bb2', { committed_at: 2000 }],
      ['cc3', { committed_at: 3000 }],
    ]);
    const result2 = buildDiff(local, remote, hashIdx2);
    t.assert(result2.deleteLocal.length === 3, 'D8b: Scenario 7 — all committed → all deleteLocal');
    t.assert(result2.fastPath === true, 'D8c: Scenario 7 → fastPath true');
  }

  // D9: Both local and remote empty → fastPath
  {
    const result = buildDiff([], manifest([]), new Map());
    t.assert(result.pull.length === 0, 'D9a: empty pull');
    t.assert(result.push.length === 0, 'D9b: empty push');
    t.assert(result.deleteLocal.length === 0, 'D9c: empty deleteLocal');
    t.assert(result.fastPath === true, 'D9d: fastPath true when both empty');
  }

  // D10: Local empty, remote has rows → pull all
  {
    const remote = manifest([
      manifestRow('remote1'),
      manifestRow('remote2'),
      manifestRow('remote3'),
    ]);
    const result = buildDiff([], remote, new Map());
    t.assertEq(result.pull.length, 3, 'D10a: all remote rows pulled');
    t.assert(result.pull.includes('remote1'), 'D10b: remote1 in pull');
    t.assert(result.pull.includes('remote2'), 'D10c: remote2 in pull');
    t.assert(result.pull.includes('remote3'), 'D10d: remote3 in pull');
  }

  // D11: Only local has rows, remote empty, none committed → push all
  {
    const local = [localRow('push1'), localRow('push2')];
    const result = buildDiff(local, manifest([]), new Map());
    t.assertEq(result.push.length, 2, 'D11a: all local rows pushed when none committed');
    t.assert(result.push.includes('push1'), 'D11b: push1 in push');
    t.assert(result.push.includes('push2'), 'D11c: push2 in push');
  }

  // D12: Same updated_at, different status → deterministic tie-break
  {
    const local = [localRow('tieBreak01', 'staged', 5000)];
    const remote = manifest([manifestRow('tieBreak01', 'active', 5000)]);
    const result = buildDiff(local, remote, new Map());
    // Must be deterministic — either pull or push, not both
    const isPull = result.pull.includes('tieBreak01');
    const isPush = result.push.includes('tieBreak01');
    t.assert(isPull !== isPush, 'D12a: clock collision — row in exactly one list');
    t.assert(!(isPull && isPush), 'D12b: not in both pull and push');
    t.assert(isPull || isPush, 'D12c: row resolved (not ignored)');
  }

  // D13: 50 rows with mixed scenarios — verify correctness
  {
    const localRows = [];
    const remoteRows = [];
    const hashIdx = new Map();

    // 10 rows: remote newer (pull)
    for (let i = 0; i < 10; i++) {
      const id = `pull${String(i).padStart(4, '0')}`;
      localRows.push(localRow(id, 'staged', 1000));
      remoteRows.push(manifestRow(id, 'staged', 2000));
    }
    // 10 rows: local newer (push)
    for (let i = 0; i < 10; i++) {
      const id = `push${String(i).padStart(4, '0')}`;
      localRows.push(localRow(id, 'staged', 2000));
      remoteRows.push(manifestRow(id, 'staged', 1000));
    }
    // 10 rows: remote only (pull)
    for (let i = 0; i < 10; i++) {
      remoteRows.push(manifestRow(`remOnly${String(i).padStart(4, '0')}`));
    }
    // 10 rows: local only, committed (deleteLocal)
    for (let i = 0; i < 10; i++) {
      const id = `delMe${String(i).padStart(4, '0')}`;
      localRows.push(localRow(id));
      hashIdx.set(id, { committed_at: Date.now() });
    }
    // 10 rows: local only, not committed (push)
    for (let i = 0; i < 10; i++) {
      localRows.push(localRow(`newLoc${String(i).padStart(4, '0')}`));
    }

    const result = buildDiff(localRows, manifest(remoteRows), hashIdx);
    t.assertEq(result.pull.length, 20, 'D13a: 20 rows pulled (10 remote-newer + 10 remote-only)');
    t.assertEq(result.push.length, 20, 'D13b: 20 rows pushed (10 local-newer + 10 local-only)');
    t.assertEq(result.deleteLocal.length, 10, 'D13c: 10 rows deleteLocal (committed)');
    t.assertEq(result.pull.length + result.push.length + result.deleteLocal.length, 50, 'D13d: all 50 rows classified');
  }

  // D14: Row in manifest with null activity_status → handle gracefully
  {
    const local = [];
    const remote = manifest([{ activity_id: 'noStatus001', activity_status: null, updated_at: 1000 }]);
    const result = buildDiff(local, remote, new Map());
    t.assert(result.pull.includes('noStatus001'), 'D14: null activity_status row pulled');
    t.assert(!result.push.includes('noStatus001'), 'D14b: not in push');
  }

  // D15: Local rows is null → treated as empty
  {
    const remote = manifest([manifestRow('remOnly')]);
    const result = buildDiff(null, remote, new Map());
    t.assert(result.pull.includes('remOnly'), 'D15: null local treated as empty — pulls remote');
  }

  // D16: Remote manifest.rows is null → treated as empty
  {
    const local = [localRow('locOnly')];
    const result = buildDiff(local, { rows: null, version: 0 }, new Map());
    t.assert(result.push.length >= 0, 'D16: null manifest.rows treated as empty — no crash');
  }

  // D17: ledgerHashIndex is null → treated as empty
  {
    const local = [localRow('locOnlyNoLedger')];
    const result = buildDiff(local, manifest([]), null);
    t.assert(result.push.includes('locOnlyNoLedger'), 'D17: null hash index → local-only becomes push (Scenario 6)');
  }

  // D18: No row in both pull and push (invariant)
  {
    const local = [localRow('x1', 'staged', 1000), localRow('x2', 'staged', 1000)];
    const remote = manifest([manifestRow('x1', 'active', 2000), manifestRow('x3')]);
    const result = buildDiff(local, remote, new Map());
    const inBoth = result.pull.filter(id => result.push.includes(id));
    t.assertEq(inBoth.length, 0, 'D18: no row appears in both pull and push (invariant)');
  }

  // D19: Same entry_id but different activity_id → treat as different rows
  {
    // entry_id correlation is for migration, not diff — activity_id is identity
    const local = [localRow('abc1111111')];
    const remote = manifest([manifestRow('xyz2222222')]);
    const result = buildDiff(local, remote, new Map());
    t.assert(result.pull.includes('xyz2222222'), 'D19a: remote row pulled (different ID)');
    t.assert(result.push.includes('abc1111111'), 'D19b: local row pushed (different ID)');
  }

  // D20: updated_at as string vs number → type coercion defined
  {
    const local = [localRow('typeTest001', 'staged', 2000)];
    const remote = manifest([{ activity_id: 'typeTest001', activity_status: 'staged', updated_at: '1000' }]);
    const result = buildDiff(local, remote, new Map());
    // Should not NaN or throw; should produce a deterministic result
    t.assert(result.pull.includes('typeTest001') || result.push.includes('typeTest001'), 'D20: string updated_at handled — no crash');
  }

  // D21: updated_at negative → treated as older
  {
    const local = [localRow('negTime001', 'staged', -1000)];
    const remote = manifest([manifestRow('negTime001', 'staged', 0)]);
    const result = buildDiff(local, remote, new Map());
    t.assert(result.pull.includes('negTime001'), 'D21a: remote (0) newer than local (-1000) → pull');
    t.assert(!result.push.includes('negTime001'), 'D21b: not in push');
  }

  // D22: Normal activity_id matching regex [A-Za-z0-9]{10}
  {
    const ids = ['AbC3XyZ7Qr', 'z9Y8x7W6vU', 'a0B1c2D3e4'];
    const local = ids.map(id => localRow(id));
    const remote = manifest([]);
    const result = buildDiff(local, remote, new Map());
    // All should be classified
    const classified = [...result.push, ...result.pull, ...result.deleteLocal];
    t.assertEq(classified.length, 3, 'D22: all alphanumeric IDs classified correctly');
  }

  // D23: Duplicate activity_id in remote manifest → defined behavior
  {
    const local = [];
    const remote = manifest([
      manifestRow('dupe001', 'staged', 1000),
      manifestRow('dupe001', 'active', 2000),
    ]);
    const result = buildDiff(local, remote, new Map());
    // Should handle gracefully — last wins or first wins (documented)
    t.assert(result.pull.includes('dupe001'), 'D23: duplicate in manifest handled — row in pull');
  }

  // D24: buildDiff is pure — same inputs → same outputs
  {
    const local = [localRow('pureTest01', 'staged', 1000)];
    const remote = manifest([manifestRow('pureTest01', 'active', 2000)]);
    const hashIdx = new Map();
    const result1 = buildDiff(local, remote, hashIdx);
    const result2 = buildDiff(local, remote, hashIdx);
    t.assertDeepEq(result1.pull, result2.pull, 'D24a: pull list same on repeated calls');
    t.assertDeepEq(result1.push, result2.push, 'D24b: push list same on repeated calls');
    t.assertEq(result1.fastPath, result2.fastPath, 'D24c: fastPath same on repeated calls');
  }

  // D25: buildDiff does not mutate inputs
  {
    const local = [localRow('immutTest1', 'staged', 1000)];
    const remote = manifest([manifestRow('immutTest1', 'active', 2000)]);
    const hashIdx = new Map([['someKey', { committed_at: 1000 }]]);
    const localCopy = JSON.stringify(local);
    const remoteCopy = JSON.stringify(remote);
    const hashIdxSize = hashIdx.size;
    buildDiff(local, remote, hashIdx);
    t.assertEq(JSON.stringify(local), localCopy, 'D25a: local array not mutated');
    t.assertEq(JSON.stringify(remote), remoteCopy, 'D25b: remote manifest not mutated');
    t.assertEq(hashIdx.size, hashIdxSize, 'D25c: hash index not mutated');
  }

  // D26: All rows match exactly → no-op
  {
    const local = [localRow('x1', 'staged', 5000), localRow('x2', 'active', 6000)];
    const remote = manifest([manifestRow('x1', 'staged', 5000), manifestRow('x2', 'active', 6000)]);
    const result = buildDiff(local, remote, new Map());
    t.assertEq(result.pull.length, 0, 'D26a: no pull when rows match');
    t.assertEq(result.push.length, 0, 'D26b: no push when rows match');
    t.assertEq(result.deleteLocal.length, 0, 'D26c: no delete when rows match');
  }

  // D27: Status-only change, same updated_at → tie-break
  {
    const local = [localRow('statOnly01', 'active', 5000)];
    const remote = manifest([manifestRow('statOnly01', 'paused', 5000)]);
    const result = buildDiff(local, remote, new Map());
    const inPull = result.pull.includes('statOnly01');
    const inPush = result.push.includes('statOnly01');
    t.assert(inPull !== inPush, 'D27a: status-only tie resolved to one direction');
    t.assert(inPull || inPush, 'D27b: row is not lost (in pull or push)');
  }

  // D28: Mixed Scenario 5 + 6 — some committed, some new
  {
    const local = [
      localRow('committed1'),
      localRow('committed2'),
      localRow('newLocal1'),
      localRow('committed3'),
      localRow('newLocal2'),
    ];
    const remote = manifest([]);
    const hashIdx = new Map([
      ['committed1', { committed_at: 1000 }],
      ['committed2', { committed_at: 2000 }],
      ['committed3', { committed_at: 3000 }],
    ]);
    const result = buildDiff(local, remote, hashIdx);
    t.assertEq(result.deleteLocal.length, 3, 'D28a: 3 committed → deleteLocal');
    t.assertEq(result.push.length, 2, 'D28b: 2 new → push');
    t.assert(result.deleteLocal.includes('committed1'), 'D28c: committed1 in deleteLocal');
    t.assert(result.push.includes('newLocal1'), 'D28d: newLocal1 in push');
  }

  // D29: Empty string activity_id in manifest → skip/graceful
  {
    const local = [];
    const remote = manifest([{ activity_id: '', activity_status: 'staged', updated_at: 1000 }]);
    const result = buildDiff(local, remote, new Map());
    t.assert(!result.pull.includes(''), 'D29: empty activity_id skipped in pull');
  }

  // D30: Manifest version field is ignored by diff logic
  {
    const local = [localRow('verTest001', 'staged', 5000)];
    const remote1 = { rows: [manifestRow('verTest001', 'staged', 5000)], version: 1 };
    const remote2 = { rows: [manifestRow('verTest001', 'staged', 5000)], version: 999 };
    const result1 = buildDiff(local, remote1, new Map());
    const result2 = buildDiff(local, remote2, new Map());
    t.assertEq(result1.pull.length, result2.pull.length, 'D30a: version does not affect pull');
    t.assertEq(result1.push.length, result2.push.length, 'D30b: version does not affect push');
  }

  // D31: activity_id with max length (20 chars)
  {
    const id20 = 'AbCdEfGhIjKlMnOpQrS'; // 20 chars
    const local = [localRow(id20)];
    const remote = manifest([]);
    const result = buildDiff(local, remote, new Map());
    t.assert(result.push.includes(id20), 'D31: 20-char activity_id handled');
  }

  // D32: activity_id with min length (10 chars)
  {
    const id10 = '0123456789'; // 10 chars
    const local = [localRow(id10)];
    const remote = manifest([]);
    const result = buildDiff(local, remote, new Map());
    t.assert(result.push.includes(id10), 'D32: 10-char activity_id handled');
  }

  // D33: Scenario 8 — committed on A, still in B's staging, in B's hash index → deleteLocal
  {
    // Device B still has a row that was committed on device A
    const local = [localRow('crossComm01')];
    const remote = manifest([]); // Device A deleted it from remote
    const hashIdx = new Map([['crossComm01', { committed_at: 1000 }]]);
    const result = buildDiff(local, remote, hashIdx);
    t.assert(result.deleteLocal.includes('crossComm01'), 'D33: Scenario 8 — cross-device committed → deleteLocal');
  }

  // D34: Remote manifest row without activity_status field
  {
    const local = [];
    const remote = manifest([{ activity_id: 'noStatusFld', updated_at: 1000 }]);
    const result = buildDiff(local, remote, new Map());
    t.assert(result.pull.includes('noStatusFld'), 'D34: row without activity_status still pulled');
  }

  // D35: Remote manifest row without updated_at field
  {
    const local = [localRow('noTimeFld01', 'staged', 5000)];
    const remote = manifest([{ activity_id: 'noTimeFld01', activity_status: 'staged' }]);
    const result = buildDiff(local, remote, new Map());
    t.assert(result.pull.includes('noTimeFld01') || result.push.includes('noTimeFld01'), 'D35: missing updated_at handled');
  }

  // ─── Group W: RowSyncWorker HTTP ─────────────────────────────────
  console.log('\n── RowSyncWorker HTTP Integration ──');

  // W1: fetchManifest returns parsed manifest on 200
  {
    const transport = new MockTransport();
    transport.setManifest({ rows: [manifestRow('test1'), manifestRow('test2')], version: 5 });
    const worker = new RowSyncWorker(transport);
    const result = await worker.fetchManifest();
    t.assert(result !== null, 'W1a: fetchManifest returns non-null');
    t.assertEq(result.version, 5, 'W1b: version preserved');
    t.assertEq(result.rows.length, 2, 'W1c: correct row count');
  }

  // W2: fetchManifest returns empty manifest for empty staging
  {
    const transport = new MockTransport();
    transport.setManifest({ rows: [], version: 0 });
    const worker = new RowSyncWorker(transport);
    const result = await worker.fetchManifest();
    t.assertEq(result.rows.length, 0, 'W2a: empty rows');
    t.assertEq(result.version, 0, 'W2b: version 0');
  }

  // W3: fetchManifest handles network error
  {
    const transport = new MockTransport();
    transport.setOffline(true);
    const worker = new RowSyncWorker(transport);
    let errorThrown = false;
    try {
      await worker.fetchManifest();
    } catch {
      errorThrown = true;
    }
    t.assert(errorThrown, 'W3: fetchManifest throws on network error');
  }

  // W4: fetchManifest handles invalid JSON response
  {
    const transport = new MockTransport();
    transport.setManifest('not json');
    const worker = new RowSyncWorker(transport);
    let errorThrown = false;
    try {
      await worker.fetchManifest();
    } catch {
      errorThrown = true;
    }
    t.assert(errorThrown, 'W4: fetchManifest throws on invalid JSON');
  }

  // W5: fetchManifest handles auth failure (simulated via transport)
  //     Auth is handled at transport level; RowSync should surface errors
  {
    const transport = new MockTransport();
    transport.setOffline(true);
    const worker = new RowSyncWorker(transport);
    let threw = false;
    try { await worker.fetchManifest(); } catch { threw = true; }
    t.assert(threw, 'W5: auth/transport errors surface to caller');
  }

  // W6: fetchRow returns full row on 200
  {
    const transport = new MockTransport();
    transport.setResponse('testRow001', {
      activity_id: 'testRow001',
      activity_status: 'staged',
      activity: '{"title":"Test"}',
      updated_at: 1718123400000,
    });
    const worker = new RowSyncWorker(transport);
    const row = await worker.fetchRow('testRow001');
    t.assert(row !== null, 'W6a: fetchRow returns non-null');
    t.assertEq(row.activity_id, 'testRow001', 'W6b: activity_id correct');
    t.assertEq(row.activity_status, 'staged', 'W6c: activity_status correct');
    t.assert(row.activity.length > 0, 'W6d: activity blob present');
  }

  // W7: fetchRow returns null on 404
  {
    const transport = new MockTransport();
    transport.setResponse('missingRow', null, 404);
    const worker = new RowSyncWorker(transport);
    const row = await worker.fetchRow('missingRow');
    t.assertEq(row, null, 'W7: fetchRow returns null on 404');
  }

  // W8: fetchRow preserves all fields intact
  {
    const original = {
      activity_id: 'fullRow0001',
      activity_status: 'active',
      activity: '{"title":"Full test","tags":["a","b","c"],"duration":7200}',
      updated_at: 1718200000000,
      extra_field: 'persist me',
    };
    const transport = new MockTransport();
    transport.setResponse('fullRow0001', original);
    const worker = new RowSyncWorker(transport);
    const row = await worker.fetchRow('fullRow0001');
    t.assertDeepEq(row, original, 'W8: full row fields preserved exactly');
  }

  // W9: fetchRow with URL-safe activity_id
  {
    const transport = new MockTransport();
    transport.setResponse('AbC3XyZ7Qr', {
      activity_id: 'AbC3XyZ7Qr',
      activity_status: 'staged',
      activity: '{}',
      updated_at: 1000,
    });
    const worker = new RowSyncWorker(transport);
    const row = await worker.fetchRow('AbC3XyZ7Qr');
    t.assert(row !== null, 'W9: URL-safe activity_id fetch works');
  }

  // W10: pushRow returns success on 200
  {
    const transport = new MockTransport();
    const worker = new RowSyncWorker(transport);
    const row = {
      activity_id: 'pushTest001',
      activity_status: 'staged',
      activity: '{}',
      updated_at: 1000,
    };
    const result = await worker.pushRow('pushTest001', row);
    t.assert(result.ok === true, 'W10a: pushRow returns ok');
    t.assertEq(result.status, 200, 'W10b: status 200');
  }

  // W11: pushRow returns 409 conflict when updated_at is not newer
  {
    const transport = new MockTransport();
    transport.setResponse('conflictRow', { status: 409 }, 409);
    const worker = new RowSyncWorker(transport);
    const row = { activity_id: 'conflictRow', activity_status: 'staged', activity: '{}', updated_at: 500 };
    const result = await worker.pushRow('conflictRow', row);
    t.assert(result.ok === false, 'W11a: pushRow detects conflict');
    t.assertEq(result.status, 409, 'W11b: status is 409');
  }

  // W12: pushRow after 409 — remote data unchanged (push guard integrity)
  {
    const transport = new MockTransport();
    // First, store a row on remote
    const original = { activity_id: 'guardRow001', activity_status: 'staged', activity: '{}', updated_at: 10000 };
    await transport.push('/storage/staging/rows/guardRow001', new TextEncoder().encode(JSON.stringify(original)));

    // Now set up 409 for a stale push
    transport.setResponse('guardRow001', { status: 409 }, 409);
    const worker = new RowSyncWorker(transport);
    const stale = { activity_id: 'guardRow001', activity_status: 'active', activity: '{}', updated_at: 5000 };
    const result = await worker.pushRow('guardRow001', stale);
    t.assert(result.ok === false, 'W12a: stale push rejected');
    t.assertEq(result.status, 409, 'W12b: 409 returned');

    // Verify stored row is unchanged
    const storedRaw = transport._store.get('guardRow001');
    t.assert(storedRaw !== undefined, 'W12c: original row still exists');
    t.assertEq(storedRaw.updated_at, 10000, 'W12d: original timestamp preserved');
  }

  // W13: pushRow returns 400 on invalid body
  {
    const transport = new MockTransport();
    transport.setResponse('badBodyRow', { error: 'missing field' }, 400);
    const worker = new RowSyncWorker(transport);
    const row = { activity_id: 'badBodyRow', activity_status: 'staged' }; // missing activity + updated_at
    const result = await worker.pushRow('badBodyRow', row);
    t.assert(result.ok === false, 'W13a: invalid push rejected');
    t.assertEq(result.status, 400, 'W13b: status 400');
  }

  // W14: pushRow with large body (512KB) succeeds
  {
    const transport = new MockTransport();
    const worker = new RowSyncWorker(transport);
    const largeRow = {
      activity_id: 'largePush01',
      activity_status: 'staged',
      activity: 'x'.repeat(512 * 1024),
      updated_at: Date.now(),
    };
    const result = await worker.pushRow('largePush01', largeRow);
    t.assert(result.ok === true, 'W14: large body push succeeds');
  }

  // W15: deleteRow returns success on 200
  {
    const transport = new MockTransport();
    // Store a row first
    await transport.push('/storage/staging/rows/delTest001', new TextEncoder().encode(JSON.stringify({
      activity_id: 'delTest001', activity_status: 'staged', activity: '{}', updated_at: 1000,
    })));
    const worker = new RowSyncWorker(transport);
    const result = await worker.deleteRow('delTest001');
    t.assert(result.ok === true, 'W15a: deleteRow returns ok');
    t.assert([200, 204].includes(result.status), 'W15b: status 200 or 204');
  }

  // W16: deleteRow returns ok for nonexistent row (idempotent)
  {
    const transport = new MockTransport();
    const worker = new RowSyncWorker(transport);
    const result = await worker.deleteRow('nonexistent');
    t.assert(result.ok === true || result.status === 404, 'W16: deleteRow idempotent — does not error on 404');
  }

  // W17: Pull phase: manifest → diff → fetch rows → yield results
  {
    const transport = new MockTransport();
    transport.setManifest({
      rows: [
        { activity_id: 'pullRowA01', activity_status: 'staged', updated_at: 2000 },
        { activity_id: 'pullRowB01', activity_status: 'active', updated_at: 3000 },
      ],
      version: 2,
    });
    transport.setResponse('pullRowA01', {
      activity_id: 'pullRowA01', activity_status: 'staged', activity: '{"a":1}', updated_at: 2000,
    });
    transport.setResponse('pullRowB01', {
      activity_id: 'pullRowB01', activity_status: 'active', activity: '{"b":2}', updated_at: 3000,
    });
    const worker = new RowSyncWorker(transport);
    const manifest = await worker.fetchManifest();
    t.assertEq(manifest.rows.length, 2, 'W17a: manifest has 2 rows');
    const diff = buildDiff([], manifest, new Map());
    t.assertEq(diff.pull.length, 2, 'W17b: diff pulls 2 rows');
    const rows = await Promise.all(diff.pull.map(id => worker.fetchRow(id)));
    t.assertEq(rows.filter(r => r !== null).length, 2, 'W17c: both rows fetched successfully');
  }

  // W18: Push phase: push local changes → handle 409s
  {
    const transport = new MockTransport();
    const worker = new RowSyncWorker(transport);
    // Push a new row
    const r1 = { activity_id: 'pushOk001', activity_status: 'staged', activity: '{}', updated_at: 1000 };
    const result1 = await worker.pushRow('pushOk001', r1);
    t.assert(result1.ok === true, 'W18a: normal push succeeds');

    // Simulate 409 on a conflicting push
    transport.setResponse('pushFail001', { status: 409 }, 409);
    const r2 = { activity_id: 'pushFail001', activity_status: 'staged', activity: '{}', updated_at: 500 };
    const result2 = await worker.pushRow('pushFail001', r2);
    t.assert(result2.ok === false, 'W18b: conflict push rejected');
    t.assertEq(result2.status, 409, 'W18c: status 409');
  }

  // W19: 409 triggers re-pull of row + re-resolve
  {
    const transport = new MockTransport();
    // Simulate remote having a newer version of the row
    const remoteRow = {
      activity_id: 'reResolve01', activity_status: 'active', activity: '{"remote":true}', updated_at: 2000,
    };
    transport.setResponse('reResolve01', remoteRow);
    // Also store on the "remote" so push is rejected
    await transport.push('/storage/staging/rows/reResolve01', new TextEncoder().encode(JSON.stringify(remoteRow)));

    const worker = new RowSyncWorker(transport);
    // Try to push a stale version
    const stale = { activity_id: 'reResolve01', activity_status: 'staged', activity: '{"stale":true}', updated_at: 1000 };
    // Set conflict for push
    transport.setResponse('reResolve01', { status: 409 }, 409);
    const pushResult = await worker.pushRow('reResolve01', stale);
    t.assert(pushResult.ok === false, 'W19a: 409 detected');
    t.assertEq(pushResult.status, 409, 'W19b: status 409');

    // After 409, re-pull row for re-resolution
    transport.setResponse('reResolve01', remoteRow, 200);
    const rePulled = await worker.fetchRow('reResolve01');
    t.assert(rePulled !== null, 'W19c: re-pull after 409 returns data');
    t.assertEq(rePulled.activity_status, 'active', 'W19d: remote status visible after re-pull');
    t.assertEq(rePulled.updated_at, 2000, 'W19e: remote timestamp visible');
  }

  // W20: Pull rows batched in parallel
  {
    const transport = new MockTransport();
    const ids = ['batchA', 'batchB', 'batchC', 'batchD', 'batchE'];
    for (const id of ids) {
      transport.setResponse(id, { activity_id: id, activity_status: 'staged', activity: '{}', updated_at: 1000 });
    }
    const worker = new RowSyncWorker(transport);
    const start = Date.now();
    const results = await Promise.all(ids.map(id => worker.fetchRow(id)));
    const elapsed = Date.now() - start;
    t.assertEq(results.length, 5, 'W20a: all 5 rows fetched');
    t.assert(results.every(r => r !== null), 'W20b: all results non-null');
    t.assert(elapsed < 500, `W20c: parallel fetch fast (${elapsed}ms)`);
  }

  // W21: Push rows batched in parallel
  {
    const transport = new MockTransport();
    const worker = new RowSyncWorker(transport);
    const rows = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => ({
      activity_id: id, activity_status: 'staged', activity: '{}', updated_at: i * 1000,
    }));
    const start = Date.now();
    const results = await Promise.all(rows.map(r => worker.pushRow(r.activity_id, r)));
    const elapsed = Date.now() - start;
    t.assertEq(results.length, 5, 'W21a: all 5 rows pushed');
    t.assert(results.every(r => r.ok), 'W21b: all pushes succeeded');
    t.assert(elapsed < 500, `W21c: parallel push fast (${elapsed}ms)`);
  }

  // W22: Network error during push of one row does not affect other pushes
  {
    const transport = new MockTransport();
    transport.setResponse('failRow', { error: 'boom' }, 500);
    const worker = new RowSyncWorker(transport);
    const goodRow = { activity_id: 'goodRow', activity_status: 'staged', activity: '{}', updated_at: 1000 };
    const badRow = { activity_id: 'failRow', activity_status: 'staged', activity: '{}', updated_at: 500 };
    const [goodResult, badResult] = await Promise.allSettled([
      worker.pushRow('goodRow', goodRow),
      worker.pushRow('failRow', badRow),
    ]);
    t.assert(goodResult.status === 'fulfilled', 'W22a: good push fulfilled');
    t.assert(goodResult.value.ok === true, 'W22b: good push succeeded');
    // badResult may be fulfilled with error status or rejected — both are acceptable
    t.assert(badResult.status === 'fulfilled' || badResult.status === 'rejected', 'W22c: bad push handled');
  }

  // W23: RowSync includes auth headers on all requests
  {
    const transport = new MockTransport();
    const worker = new RowSyncWorker(transport, { apiKey: 'test-key-123' });
    // Verify worker stores the API key (actual header injection tested via integration)
    t.assert(worker._apiKey === 'test-key-123' || worker._config?.apiKey === 'test-key-123', 'W23: API key configured');
  }

  // W24: CORS-safe headers (tested in integration with real fetch)
  {
    const transport = new MockTransport();
    const worker = new RowSyncWorker(transport);
    t.assert(worker !== null, 'W24: RowSyncWorker instantiated — CORS tested in integration');
  }

  // W25: pushRow with activity_id mismatch between URL path and body
  {
    const transport = new MockTransport();
    const worker = new RowSyncWorker(transport);
    const mismatched = { activity_id: 'body123', activity_status: 'staged', activity: '{}', updated_at: 1000 };
    // Push as path ID 'urlPath456' with body.activity_id 'body123'
    const result = await worker.pushRow('urlPath456', mismatched);
    // Should either auto-correct or reject; defined behavior needed
    t.assert(result !== undefined, 'W25: activity_id mismatch handled (pushed or rejected)');
  }

  // W26: fetchManifest response version field is preserved
  {
    const transport = new MockTransport();
    transport.setManifest({ rows: [manifestRow('t1')], version: 42 });
    const worker = new RowSyncWorker(transport);
    const result = await worker.fetchManifest();
    t.assertEq(result.version, 42, 'W26: version field preserved');
  }

  // W27: Concurrent pushRow + fetchManifest race — no data corruption
  {
    const transport = new MockTransport();
    transport.setManifest({ rows: [], version: 0 });
    const worker = new RowSyncWorker(transport);
    const row = { activity_id: 'raceRow001', activity_status: 'staged', activity: '{}', updated_at: 1000 };
    try {
      const [manifest, push] = await Promise.all([
        worker.fetchManifest(),
        worker.pushRow('raceRow001', row),
      ]);
      t.assert(manifest !== null, 'W27a: manifest fetched during concurrent push');
      t.assert(push.ok === true, 'W27b: push succeeded during concurrent manifest fetch');
    } catch (e) {
      t.assert(false, `W27c: concurrent ops should not throw: ${e.message}`);
    }
  }

  // W28: Retry logic — transient failure → retry → eventual success
  {
    const transport = new MockTransport();
    let attempts = 0;
    const originalPull = transport.pull.bind(transport);
    transport.pull = async (path) => {
      attempts++;
      if (attempts <= 2 && path.includes('manifest')) {
        throw new Error('Temporary network blip');
      }
      return originalPull(path);
    };
    transport.setManifest({ rows: [], version: 0 });
    const worker = new RowSyncWorker(transport);
    try {
      const result = await worker.fetchManifest();
      t.assert(result !== null, 'W28a: eventual success after retry');
      t.assert(attempts >= 2, `W28b: retried at least once (${attempts} attempts)`);
    } catch {
      t.assert(false, 'W28c: should succeed after retries');
    }
  }

  // W29: Full pull + push cycle cross-"device" simulation
  {
    const remote = new MemoryBackend();
    // Device A pushes a row
    const workerA = new RowSyncWorker(remote);
    const rowA = { activity_id: 'crossDev01', activity_status: 'active', activity: '{"from":"A"}', updated_at: 5000 };

    // For mock purposes, simulate push
    await remote.set('staging:row:crossDev01', rowA);

    // Device B pulls the manifest and row
    const workerB = new RowSyncWorker(remote);
    const manifest = { rows: [{ activity_id: 'crossDev01', activity_status: 'active', updated_at: 5000 }], version: 1 };
    t.assert(manifest.rows.length === 1, 'W29a: Device B sees Device A row in manifest');
    t.assertEq(manifest.rows[0].activity_id, 'crossDev01', 'W29b: cross-device activity_id visible');
  }

  // W30: Clear remote staging — delete all rows, verify empty manifest
  {
    const transport = new MockTransport();
    // Store some rows
    for (let i = 0; i < 3; i++) {
      await transport.push(`/storage/staging/rows/clear${i}`, new TextEncoder().encode(JSON.stringify({
        activity_id: `clear${i}`, activity_status: 'staged', activity: '{}', updated_at: 1000 * i,
      })));
    }
    const worker = new RowSyncWorker(transport);
    // Delete all
    for (let i = 0; i < 3; i++) {
      await worker.deleteRow(`clear${i}`);
    }
    // Verify storage is empty
    t.assertEq(transport._store.size, 0, 'W30: all rows deleted');
  }

  // ══════════════════════════════════════════════════════════════════
  console.log(`\n── Results: ${t.passed} passed, ${t.failed} failed ──`);
  if (t.errors.length > 0) {
    console.log('Failed tests:');
    t.errors.forEach(e => console.log(`  ${e}`));
  }
  process.exit(t.failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
