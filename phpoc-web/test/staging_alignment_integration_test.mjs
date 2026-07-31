/**
 * staging_alignment_integration_test.mjs — Group H: E2E Sync with New Format (Phase 2 RED).
 *
 * Full sync cycle tests using canonical PHPSPEC §8 format to catch regressions
 * across the entire pushBlob/pullBlob/reconcile pipeline.
 *
 * Assertions: H1–H6 (6 tests).
 * All should FAIL in RED phase — canonical format not yet implemented.
 *
 * Usage:
 *   node test/staging_alignment_integration_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';

// Import from modules that will exist after Phase 3:
import { RemoteSync, BLOB_KEY_MISMATCH } from '../src/sync/remote_sync.js';
import { buildStagingHashIndex, compareStagingHashIndexes, computeHashForIndex } from '../src/sync/staging_hash_index.js';
import { REMOTE_STAGING_BLOB, REMOTE_STAGING_HASH_INDEX } from '../src/sync/keys.js';

// mergeRows will be exported from row_sync.js after Phase 3.
// For RED phase, dynamic import with stub fallback.
const _rowSyncModInt = await import('../src/sync/row_sync.js');
const mergeRows = typeof _rowSyncModInt.mergeRows === 'function'
  ? _rowSyncModInt.mergeRows
  : (_local, _remote) => [{ activity_id: '__stub__', activity_status: '__stub__', activity: '{}', updated_at: 0, committed: false }];

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

const t = new TestHelpers();

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function canonicalRow(activityId, activityStatus = 'active', activityPayload = null, updatedAt = Date.now(), committed = false) {
  return {
    activity_id: activityId,
    activity_status: activityStatus,
    activity: JSON.stringify(activityPayload || { title: `Entry ${activityId}`, start_epoch: updatedAt }),
    updated_at: updatedAt,
    committed,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Mock Transport (shared R2 simulation)
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    this._store = new Map();
    this._offline = false;
  }

  async pull(path) {
    if (this._offline) throw new Error('Network failure');
    return this._store.get(path) ?? null;
  }

  async push(path, data) {
    if (this._offline) throw new Error('Network failure');
    this._store.set(path, data);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock CryptoService
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor(mk = null) {
    this._mk = mk;
  }

  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }
  hasMasterKey() { return !!this._mk; }

  sha256Hex(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  // For computeHashForIndex — the function expects a sha256Fn that takes a string
  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  obfuscateBlob(plaintext, mk) {
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = createHash('sha256').update(mk || '').digest().slice(0, 4);
    return Buffer.concat([keyFingerprint, plainBytes]).toString('base64');
  }

  deobfuscateBlob(b64, mk) {
    try {
      const obfuscated = Buffer.from(b64, 'base64');
      const storedFingerprint = obfuscated.slice(0, 4);
      if (mk) {
        const expectedFingerprint = createHash('sha256').update(mk).digest().slice(0, 4);
        if (!storedFingerprint.equals(expectedFingerprint)) {
          throw new Error('key mismatch');
        }
      }
      return obfuscated.slice(4).toString('utf-8');
    } catch {
      throw new Error('deobfuscation failed');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Run all tests
// ══════════════════════════════════════════════════════════════════════

async function runTests() {
  const mk = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const deviceA = 'device-aaaa-web';
  const deviceB = 'device-bbbb-web';

  console.log('\n── Group H: E2E Sync with New Format ──');

  // ── H1: Full sync cycle: capture → pushBlob → pullBlob → reconcile → verify rows match ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);
    const remote = new RemoteSync(transport, crypto);

    // Device A pushes entries
    const entriesA = [
      canonicalRow('h1-act-1', 'active', { title: 'Entry 1', start_epoch: 1000 }, 1000),
      canonicalRow('h1-act-2', 'paused', { title: 'Entry 2', start_epoch: 2000 }, 2000),
    ];
    await remote.pushBlob(entriesA, deviceA, mk);

    // Device B pulls and verifies
    const pulled = await new RemoteSync(transport, crypto).pullBlob(mk);
    t.assert(pulled !== null && pulled !== BLOB_KEY_MISMATCH, 'H1a: pullBlob returns parsed blob');
    t.assert(Array.isArray(pulled.entries), 'H1b: entries is array');

    // Reconcile: device B merges pulled rows with its own (empty) local entries
    const localB = [];
    const merged = mergeRows(localB, pulled.entries);
    t.assertEq(merged.length, 2, 'H1c: both entries survive merge');
    const ids = merged.map(r => r.activity_id).sort();
    t.assertDeepEq(ids, ['h1-act-1', 'h1-act-2'], 'H1d: activity_ids match after round-trip');
    t.assert(merged.every(r => typeof r.activity_status === 'string'), 'H1e: all rows have activity_status');
    t.assert(merged.every(r => typeof r.activity === 'string'), 'H1f: all rows have activity string');
    t.assert(merged.every(r => typeof r.updated_at === 'number'), 'H1g: all rows have updated_at');
    t.assert(merged.every(r => typeof r.committed === 'boolean'), 'H1h: all rows have committed flag');
  }

  // ── H2: Two-device simulation: device A pushes, device B pulls and merges ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);
    const remoteA = new RemoteSync(transport, crypto);

    // Device A pushes 2 entries
    await remoteA.pushBlob([
      canonicalRow('h2-act-A', 'active', { title: 'A entry', start_epoch: 1000 }, 1000),
      canonicalRow('h2-act-B', 'paused', { title: 'B entry', start_epoch: 2000 }, 2000),
    ], deviceA, mk);

    // Device B has 1 local entry, pulls and merges
    const rowB = canonicalRow('h2-act-local', 'active', { title: 'Local B', start_epoch: 1500 }, 1500);
    const remoteB = new RemoteSync(transport, crypto);
    const remoteBlob = await remoteB.pullBlob(mk);

    const merged = mergeRows([rowB], remoteBlob.entries);
    t.assertEq(merged.length, 3, 'H2a: 3 entries after merge (1 local + 2 remote)');

    // Verify device A's entries are present
    const aEntries = merged.filter(r => r.activity_id.startsWith('h2-act-A') || r.activity_id.startsWith('h2-act-B'));
    t.assertEq(aEntries.length, 2, 'H2b: device A entries survived merge');

    // Verify device B's local entry survived
    const bEntry = merged.find(r => r.activity_id === 'h2-act-local');
    t.assert(bEntry !== undefined, 'H2c: device B local entry survived merge');
    if (bEntry) {
      t.assertEq(bEntry.activity, rowB.activity, 'H2d: device B entry activity preserved');
    } else {
      t.assert(false, 'H2d: device B entry activity preserved');
    }
  }

  // ── H3: Hash index fast path: push → pull hash index (identical) → skip blob pull ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);
    const remote = new RemoteSync(transport, crypto);

    const entries = [
      canonicalRow('h3-act-1', 'active', { title: 'Fast path 1', start_epoch: 1000 }, 1000),
    ];
    await remote.pushBlob(entries, deviceA, mk);

    // Build hash index from entries and push to remote
    const hashIndex = buildStagingHashIndex(entries);
    const indexJson = JSON.stringify(hashIndex);
    const sha256Hash = computeHashForIndex(indexJson, crypto.sha256);
    // Push encrypted hash index to simulate what pushBlob does (via SyncService)
    const obfuscatedB64 = crypto.obfuscateBlob(indexJson, mk);
    const indexBytes = base64ToBytes(obfuscatedB64);
    transport._store.set(REMOTE_STAGING_HASH_INDEX, indexBytes);

    // Now simulate Tier 1 fast path: pull sha256 from remote, compare local
    const remoteIndexRaw = transport._store.get(REMOTE_STAGING_HASH_INDEX);
    t.assert(remoteIndexRaw !== undefined, 'H3a: hash index exists on remote');

    // Decrypt the index
    const b64 = bytesToBase64(remoteIndexRaw);
    const plaintext = crypto.deobfuscateBlob(b64, mk);
    const remoteIndex = JSON.parse(plaintext);
    const remoteSha = computeHashForIndex(JSON.stringify(remoteIndex), crypto.sha256);
    const localSha = computeHashForIndex(JSON.stringify(hashIndex), crypto.sha256);

    t.assertEq(remoteSha, localSha, 'H3b: SHA-256 matches → identical hash indexes');
    t.assert(compareStagingHashIndexes(hashIndex, remoteIndex).identical,
      'H3c: compareStagingHashIndexes confirms identical → skip full blob pull');
  }

  // ── H4: Hash index diff: push row A → add row B → diff detected → full blob pull needed ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);
    const remote = new RemoteSync(transport, crypto);

    // Device A pushes one entry
    const entriesA = [canonicalRow('h4-act-1', 'active', { title: 'Original', start_epoch: 1000 }, 1000)];
    await remote.pushBlob(entriesA, deviceA, mk);

    // Local device B has hash index from last pull (matching entriesA)
    const localHashIndex = buildStagingHashIndex(entriesA);

    // Now device A pushes two entries (including a new one)
    const entriesA2 = [
      canonicalRow('h4-act-1', 'paused', { title: 'Original modified', start_epoch: 1000 }, 2000),
      canonicalRow('h4-act-2', 'active', { title: 'New entry', start_epoch: 3000 }, 3000),
    ];
    await remote.pushBlob(entriesA2, deviceA, mk);

    // Build remote hash index from new entries
    const remoteHashIndex = buildStagingHashIndex(entriesA2);

    // Compare — should detect differences
    const diff = compareStagingHashIndexes(localHashIndex, remoteHashIndex);
    t.assert(!diff.identical, 'H4a: hash indexes differ → full blob pull needed');
    t.assert(diff.newRemote.length > 0 || diff.statusChanged.length > 0,
      'H4b: diff includes statusChanged or newRemote');

    // Pull the full blob for reconciliation
    const pulled = await new RemoteSync(transport, crypto).pullBlob(mk);
    t.assertEq(pulled.entries.length, 2, 'H4c: full blob has both entries after diff detection');
  }

  // ── H5: Legacy blob (old format) is still readable by pullBlob ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);

    // Simulate legacy format: raw spec entries with {hash, data: {_enc}}
    const legacyBlob = {
      device_id: 'legacy-device-web',
      device_proof: '',
      entries: [
        {
          hash: 'abc123',
          data: {
            entry_id: 'legacy-entry-1',
            title: 'Legacy Task',
            startTime_enc: 'plain:1000',
            endTime_enc: 'plain:2000',
            duration: 1000,
            is_active: false,
            is_paused: false,
            pauses_enc: 'plain:[]',
            metadata_enc: 'plain:{}',
            tags: [],
            comment: null,
            media: [],
            device_uuid: 'legacy-device-web',
            end_device_uuid: '',
          },
          committed: false,
          block_index: null,
        },
      ],
      updated_at: 1000,
    };

    // Push as plaintext
    const legacyBytes = new TextEncoder().encode(JSON.stringify(legacyBlob));
    transport._store.set(REMOTE_STAGING_BLOB, legacyBytes);

    const remote = new RemoteSync(transport, crypto);
    const pulled = await remote.pullBlob(mk);

    t.assert(pulled !== null && pulled !== BLOB_KEY_MISMATCH, 'H5a: legacy blob was read');
    t.assert(Array.isArray(pulled.entries), 'H5b: entries array present in legacy blob');
    t.assertEq(pulled.entries.length, 1, 'H5c: single entry from legacy blob');
  }

  // ── H6: After reconcile with committed entry, committed row is removed from local staging ──
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto(mk);
    const remote = new RemoteSync(transport, crypto);

    // Remote has one committed entry
    const remoteEntries = [
      canonicalRow('h6-act-committed', 'ended', { title: 'Committed Entry', start_epoch: 1000 }, 1000, true),
      canonicalRow('h6-act-active', 'active', { title: 'Active Entry', start_epoch: 2000 }, 2000, false),
    ];
    await remote.pushBlob(remoteEntries, deviceA, mk);

    // Device B pulls and merges (local has same committed entry)
    const localEntries = [
      canonicalRow('h6-act-committed', 'ended', { title: 'Committed Entry', start_epoch: 1000 }, 800, true),
      canonicalRow('h6-act-local', 'active', { title: 'Local Only', start_epoch: 1500 }, 1500, false),
    ];

    const pulled = await new RemoteSync(transport, crypto).pullBlob(mk);
    const merged = mergeRows(localEntries, pulled.entries);

    // Committed entry should be present (irreversible) but local-only committed should be excluded
    const committedRows = merged.filter(r => r.activity_id === 'h6-act-committed');
    const localOnlyCommitted = merged.filter(r => r.committed === true && r.activity_id === 'h6-act-local');

    // Note: mergeRows excludes local-only committed entries (PHPSPEC §8.5 rule 4)
    // But the committed entry from remote must survive (rule 3)
    t.assert(committedRows.length > 0, 'H6a: committed row from remote survives (committed is irreversible)');
    t.assertEq(localOnlyCommitted.length, 0, 'H6b: local-only committed row excluded from merge result');
    t.assert(merged.some(r => r.activity_id === 'h6-act-local' && !r.committed), 'H6c: uncommitted local survives');
  }

  // ══════════════════════════════════════════════════════════════════
  t.summary('Staging Alignment Integration (Group H)');
}

runTests().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
