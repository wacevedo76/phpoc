/**
 * terminal_state_merge_test.mjs — ADR-033 terminal-state rule ("ended" is
 * permanent) for the Web client.
 *
 * Group K: `mergeRows` (row_sync.js) terminal-state preference (pure).
 * Group L: `_mergeRemoteIntoLocal` (sync.js) DTO-rebuild integration — a
 *          terminal-state win must rebuild the DTO from the canonical row,
 *          else `is_active: true` leaks back.
 *
 * Phase 2 (RED): these tests are written before the implementation and are
 * expected to FAIL on the current pure-LWW code.
 *
 * Usage:
 *   node test/terminal_state_merge_test.mjs
 */

import { createHash } from 'crypto';

import { mergeRows } from '../src/sync/row_sync.js';
import { SyncService } from '../src/sync/sync.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function row(aid, status, updatedAt, activity = '{}', committed = false) {
  return { activity_id: aid, activity_status: status, activity, updated_at: updatedAt, committed };
}

function activityBlob({ title = 'Task', start_epoch = 1000, end_epoch = null, is_active = true } = {}) {
  return JSON.stringify({ title, start_epoch, end_epoch, is_active });
}

// Minimal crypto for Group L: LocalCache needs hasMasterKey() (false → plaintext
// storage) and sha256() (entry-hash computation). `_mergeRemoteIntoLocal` itself
// performs no crypto operations.
class MinimalCrypto {
  hasMasterKey() { return false; }
  sha256(s) { return createHash('sha256').update(s, 'utf-8').digest('hex'); }
  generateUuid() { return '00000000-0000-4000-8000-000000000001'; }
}

function localDto(id, isActive, updatedAt) {
  return {
    entry_id: id, activity_id: id, title: 'Task', start_epoch: 1000,
    end_epoch: isActive ? null : 5000, duration: isActive ? 0 : 4000,
    is_active: isActive, is_paused: false, pauses: [], tags: [], comment: null,
    media: [], metadata: {}, device_uuid: 'dev-local', end_device_uuid: '',
    committed: false, updated_at: updatedAt,
  };
}

function canonicalRow(id, status, updatedAt) {
  return {
    activity_id: id,
    activity_status: status,
    activity: activityBlob({ end_epoch: status === 'ended' ? 5000 : null, is_active: status !== 'ended' }),
    updated_at: updatedAt,
    committed: false,
  };
}

async function run() {
  console.log('══ Terminal-State Rule (ADR-033) — Web Tests ══\n');

  // ── Group K: mergeRows terminal-state (pure) ──────────────────────
  console.log('── Group K: mergeRows terminal-state ──\n');

  // K1: local active (newer) + remote ended (older) → ended
  {
    const merged = mergeRows([row('a', 'active', 200)], [row('a', 'ended', 100)]);
    t.assertEq(merged.length, 1, 'K1 one merged row');
    t.assertEq(merged[0].activity_status, 'ended', 'K1 ended beats newer active');
  }

  // K2: local active (older) + remote ended (newer) → ended (LWW guard)
  {
    const merged = mergeRows([row('a', 'active', 100)], [row('a', 'ended', 200)]);
    t.assertEq(merged[0].activity_status, 'ended', 'K2 ended beats older active (guard)');
  }

  // K3: local paused (newer) + remote ended (older) → ended
  {
    const merged = mergeRows([row('a', 'paused', 200)], [row('a', 'ended', 100)]);
    t.assertEq(merged[0].activity_status, 'ended', 'K3 ended beats newer paused');
  }

  // K4: local ended + remote active (newer) → ended (reverse direction)
  {
    const merged = mergeRows([row('a', 'ended', 100)], [row('a', 'active', 200)]);
    t.assertEq(merged[0].activity_status, 'ended', 'K4 local ended survives newer remote active');
  }

  // K5: both ended → LWW newest wins (guard)
  {
    const merged = mergeRows(
      [row('a', 'ended', 100, '{"v":"local"}')],
      [row('a', 'ended', 200, '{"v":"remote"}')]
    );
    t.assertEq(merged[0].activity_status, 'ended', 'K5 both ended stays ended');
    t.assertEq(merged[0].updated_at, 200, 'K5 newest updated_at wins');
    t.assertEq(merged[0].activity, '{"v":"remote"}', 'K5 winner blob is remote');
  }

  // K6: both active → LWW newest wins (guard)
  {
    const merged = mergeRows([row('a', 'active', 100)], [row('a', 'active', 200)]);
    t.assertEq(merged[0].activity_status, 'active', 'K6 both active stays active');
    t.assertEq(merged[0].updated_at, 200, 'K6 newest updated_at wins');
  }

  // K7: ended winner carries its end_epoch intact
  {
    const local = [row('a', 'active', 200, activityBlob({ end_epoch: null, is_active: true }))];
    const remote = [row('a', 'ended', 100, activityBlob({ end_epoch: 5000, is_active: false }))];
    const merged = mergeRows(local, remote);
    t.assertEq(merged[0].activity_status, 'ended', 'K7 ended status');
    t.assertEq(JSON.parse(merged[0].activity).end_epoch, 5000, 'K7 ended end_epoch survives');
  }

  // K8: empty/unset status → fall back to activity blob is_active
  {
    // K8a: empty status + no is_active:false → NOT ended → remote ended still wins
    const merged = mergeRows([row('a', '', 200)], [row('a', 'ended', 100)]);
    t.assertEq(merged[0].activity_status, 'ended', 'K8a empty-status local is not-ended; remote ended wins');
    // K8b: empty status + is_active:false → ended (fallback) → local wins
    const merged2 = mergeRows(
      [row('b', '', 200, JSON.stringify({ is_active: false }))],
      [row('b', 'active', 100)]
    );
    t.assertEq(merged2[0].activity_status, 'ended', 'K8b empty-status local with is_active:false is ended');
  }

  // K-INT1: mixed set — per-id independence + committed irreversibility
  {
    const local = [
      row('a1', 'active', 200),
      row('a2', 'ended', 100),
      row('a3', 'active', 300, '{}', true),
    ];
    const remote = [
      row('a1', 'ended', 100),
      row('a2', 'active', 200),
      row('a3', 'active', 100),
      row('a4', 'ended', 50),
    ];
    const byId = Object.fromEntries(mergeRows(local, remote).map((r) => [r.activity_id, r]));
    t.assertEq(byId.a1.activity_status, 'ended', 'K-INT1 a1 ended wins over newer active');
    t.assertEq(byId.a2.activity_status, 'ended', 'K-INT1 a2 local ended survives newer active');
    t.assertEq(byId.a3.activity_status, 'active', 'K-INT1 a3 both non-ended → LWW local newer');
    t.assertEq(byId.a3.committed, true, 'K-INT1 a3 committed irreversible');
    t.assertEq(byId.a4.activity_status, 'ended', 'K-INT1 a4 remote-only ended');
  }

  // ── Group L: _mergeRemoteIntoLocal DTO-rebuild integration ─────────
  console.log('\n── Group L: _mergeRemoteIntoLocal DTO-rebuild ──\n');

  // L1: remote ended (older) + local active (newer) → merged DTO is_active:false
  {
    const storage = new MemoryBackend();
    const sync = new SyncService(storage, new MinimalCrypto(), null, {});
    await sync._local.writeEntries([localDto('task-x', true, 200)]);
    const localEntries = await sync.readEntries();
    const remoteBlob = { device_id: 'dev-remote', entries: [canonicalRow('task-x', 'ended', 100)] };
    await sync._mergeRemoteIntoLocal(remoteBlob, localEntries, 'dev-local');
    const merged = await sync.readEntries();
    t.assertEq(merged.length, 1, 'L1 one merged entry');
    t.assertEq(merged[0].is_active, false, 'L1 remote ended (older) ends local active → is_active false');
  }

  // L2: remote ended (newer) + local active (older) → is_active:false (LWW guard)
  {
    const storage = new MemoryBackend();
    const sync = new SyncService(storage, new MinimalCrypto(), null, {});
    await sync._local.writeEntries([localDto('task-x', true, 100)]);
    const localEntries = await sync.readEntries();
    const remoteBlob = { device_id: 'dev-remote', entries: [canonicalRow('task-x', 'ended', 200)] };
    await sync._mergeRemoteIntoLocal(remoteBlob, localEntries, 'dev-local');
    const merged = await sync.readEntries();
    t.assertEq(merged[0].is_active, false, 'L2 remote ended (newer) → is_active false (guard)');
  }

  // L3: local ended + remote active (newer) → is_active:false (local ended survives rebuild)
  {
    const storage = new MemoryBackend();
    const sync = new SyncService(storage, new MinimalCrypto(), null, {});
    await sync._local.writeEntries([localDto('task-y', false, 100)]);
    const localEntries = await sync.readEntries();
    const remoteBlob = { device_id: 'dev-remote', entries: [canonicalRow('task-y', 'active', 200)] };
    await sync._mergeRemoteIntoLocal(remoteBlob, localEntries, 'dev-local');
    const merged = await sync.readEntries();
    t.assertEq(merged[0].is_active, false, 'L3 local ended survives newer remote active');
  }

  // L4: both active, remote newer → is_active:true (no terminal state; LWW guard)
  {
    const storage = new MemoryBackend();
    const sync = new SyncService(storage, new MinimalCrypto(), null, {});
    await sync._local.writeEntries([localDto('task-z', true, 100)]);
    const localEntries = await sync.readEntries();
    const remoteBlob = { device_id: 'dev-remote', entries: [canonicalRow('task-z', 'active', 200)] };
    await sync._mergeRemoteIntoLocal(remoteBlob, localEntries, 'dev-local');
    const merged = await sync.readEntries();
    t.assertEq(merged[0].is_active, true, 'L4 both active + remote newer → is_active true (guard)');
  }

  // ── Results ──
  const failed = t.summary('terminal_state_merge');
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
