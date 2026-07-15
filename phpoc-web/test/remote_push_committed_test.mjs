/**
 * remote_push_committed_test.mjs — committed/block_index in pushBlob().
 *
 * TDD RED phase: Tests that RemoteSync.pushBlob() serializes committed
 * and block_index into the raw blob entries pushed to remote.
 *
 * Bug #2 (remote_sync.js): pushBlob() manually reconstructs raw entries
 * but omits committed and block_index from the DTO.
 *
 * Groups:
 *   C: pushBlob committed/block_index serialization (5 tests)
 *
 * Usage:
 *   node test/remote_push_committed_test.mjs
 */

import { createHash } from 'crypto';

import { RemoteSync } from '../src/sync/remote_sync.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Mock Transport
// ══════════════════════════════════════════════════════════════════════

class MockTransport {
  constructor() {
    /** @type {Map<string, Uint8Array>} */
    this._store = new Map();
    this._offline = false;
  }

  async pull(path) {
    if (this._offline) throw new Error('Network failure');
    const val = this._store.get(path);
    return val !== undefined ? val : null;
  }

  async push(path, data) {
    if (this._offline) throw new Error('Network failure');
    this._store.set(path, data);
  }

  /** Get the raw bytes pushed to a path. */
  getPushed(path) {
    return this._store.get(path) || null;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Mock Crypto
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor() {
    this._mk = null;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }
  hasMasterKey() { return !!this._mk; }

  obfuscateBlob(plaintext, mk) {
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = mk
      ? createHash('sha256').update(mk).digest().slice(0, 4)
      : Buffer.alloc(4);
    const obfuscated = Buffer.concat([keyFingerprint, plainBytes]);
    return obfuscated.toString('base64');
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
// Constants
// ══════════════════════════════════════════════════════════════════════

const BLOB_PATH = 'staging/blobs/current.json';
const TEST_MK = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111';
const TEST_DEVICE_ID = 'test-device-0001-0000-0000-000000000001';

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Read and deobfuscate the pushed blob from the mock transport.
 * Returns the parsed blob object with raw entries.
 */
function readPushedBlob(transport, crypto, mk) {
  const bytes = transport.getPushed(BLOB_PATH);
  if (!bytes) return null;

  // Check if it's plaintext JSON first
  try {
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  } catch {
    // Try deobfuscated
  }

  const b64 = Buffer.from(bytes).toString('base64');
  const plaintext = crypto.deobfuscateBlob(b64, mk);
  return JSON.parse(plaintext);
}

/**
 * Build a DTO entry for pushBlob().
 */
function makeDto(opts = {}) {
  return {
    entry_id: opts.entry_id || 'e-dto-001',
    title: opts.title || 'DTO Test Entry',
    start_epoch: opts.start_epoch ?? 1700000000000,
    end_epoch: opts.end_epoch ?? null,
    duration: opts.duration || 0,
    is_active: opts.is_active ?? false,
    is_paused: opts.is_paused ?? false,
    pauses: opts.pauses || [],
    tags: opts.tags || [],
    comment: opts.comment || null,
    media: opts.media || [],
    metadata: opts.metadata || {},
    hash: opts.hash || 'dto-hash-0000000000000000000000000000000000000000000000000000000000',
    device_uuid: opts.device_uuid || 'dev-dto',
    end_device_uuid: opts.end_device_uuid || '',
    committed: opts.committed !== undefined ? opts.committed : undefined,
    block_index: opts.block_index !== undefined ? opts.block_index : undefined,
  };
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ RemoteSync pushBlob Committed Flag Tests ══\n');

  // ── C1: committed=true serialized ─────────────────────────────────
  console.log('── Group C: pushBlob() committed/block_index ──\n');

  {
    const transport = new MockTransport();
    const crypto = new MockCrypto();
    crypto.setMasterKey(TEST_MK);
    const remote = new RemoteSync(transport, crypto);

    const dto = makeDto({ committed: true, block_index: 5 });
    await remote.pushBlob([dto], TEST_DEVICE_ID);

    const blob = readPushedBlob(transport, crypto, TEST_MK);
    t.assert(blob !== null, 'C1a. blob pushed to remote');
    t.assertEq(blob.entries.length, 1, 'C1b. one entry in blob');

    const rawEntry = blob.entries[0];
    t.assertEq(rawEntry.committed, true, 'C1. pushBlob includes committed=true in raw entry');
  }

  // ── C2: committed=false serialized ────────────────────────────────
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto();
    crypto.setMasterKey(TEST_MK);
    const remote = new RemoteSync(transport, crypto);

    const dto = makeDto({ committed: false });
    await remote.pushBlob([dto], TEST_DEVICE_ID);

    const blob = readPushedBlob(transport, crypto, TEST_MK);
    t.assert(blob !== null, 'C2a. blob pushed');
    t.assertEq(blob.entries[0].committed, false, 'C2. pushBlob includes committed=false in raw entry');
  }

  // ── C3: block_index serialized ────────────────────────────────────
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto();
    crypto.setMasterKey(TEST_MK);
    const remote = new RemoteSync(transport, crypto);

    const dto = makeDto({ block_index: 42 });
    await remote.pushBlob([dto], TEST_DEVICE_ID);

    const blob = readPushedBlob(transport, crypto, TEST_MK);
    t.assertEq(blob.entries[0].block_index, 42, 'C3. pushBlob includes block_index in raw entry');
  }

  // ── C4: legacy DTO without committed/block_index ─────────────────
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto();
    crypto.setMasterKey(TEST_MK);
    const remote = new RemoteSync(transport, crypto);

    // Legacy DTO with no committed/block_index at all
    const dto = {
      entry_id: 'legacy-001',
      title: 'Legacy Entry',
      start_epoch: 1700000000000,
      duration: 1000,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags: [],
      comment: null,
      media: [],
      metadata: {},
      hash: 'legacy-hash',
      device_uuid: 'dev-legacy',
      end_device_uuid: '',
      // No committed, no block_index
    };

    await remote.pushBlob([dto], TEST_DEVICE_ID);

    const blob = readPushedBlob(transport, crypto, TEST_MK);
    t.assert(blob !== null, 'C4a. blob pushed for legacy DTO');

    // Legacy entries should not have committed/block_index added spuriously
    const rawEntry = blob.entries[0];
    t.assert(!('committed' in rawEntry) || rawEntry.committed === false,
      'C4b. legacy DTO does not add spurious committed flag');
    // Should still have the core fields
    t.assertEq(rawEntry.data.title, 'Legacy Entry', 'C4c. core fields preserved');
  }

  // ── C5: round-trip DTO → pushBlob raw → rawEntryToDTO ────────────
  // This tests the full push→pull cycle when both bugs are fixed.
  // We simulate the remote storing the blob, then pull it back.
  {
    const transport = new MockTransport();
    const crypto = new MockCrypto();
    crypto.setMasterKey(TEST_MK);
    const remote = new RemoteSync(transport, crypto);

    const dto = makeDto({
      entry_id: 'roundtrip-001',
      committed: true,
      block_index: 7,
      title: 'Round Trip',
    });
    await remote.pushBlob([dto], TEST_DEVICE_ID);

    // Now pull the blob back (simulating what another client would do)
    const pulledBlob = await remote.pullBlob(TEST_MK);
    t.assert(pulledBlob !== null, 'C5a. blob pulled back');
    t.assertEq(pulledBlob.entries.length, 1, 'C5b. one entry pulled');

    const pulledRaw = pulledBlob.entries[0];
    t.assertEq(pulledRaw.committed, true, 'C5c. committed survives push→pull round-trip');
    t.assertEq(pulledRaw.block_index, 7, 'C5d. block_index survives push→pull round-trip');
  }

  // ══════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n── Results ────────────────────────────────`);
  const failed = t.summary('RemoteSync pushBlob Committed Flag');
  if (failed > 0) process.exit(1);
}

run();
