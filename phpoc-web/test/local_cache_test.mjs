/**
 * local_cache_test.mjs — LocalCache staging entry format tests (TDD RED phase).
 *
 * Bug 3b: Web writes entries in a flat format (start_epoch, no _enc suffix,
 * no {hash, data} wrapper) that does not conform to PHPSPEC.md §3.1.1 and §8.1.
 *
 * Fix: Canonicalize the web on the spec format:
 *   - `_enc` suffix on encryptable field names per §3.1.1
 *   - `plain:` prefix for staging (unencrypted) values per §8.2
 *   - `{hash, data: {...}}` wrapper around entry data
 *
 * These tests verify the RAW STORAGE FORMAT written by LocalCache.
 * The DTO reader (rawEntryToDTO) already handles the spec format —
 * only the writer must change.
 *
 * Usage:
 *   node test/local_cache_test.mjs
 */

import { createHash } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { LocalCache } from '../src/sync/local_cache.js';

// ══════════════════════════════════════════════════════════════════════
// Minimal mock crypto
// ══════════════════════════════════════════════════════════════════════

class MockCryptoForCache {
  constructor() { this._uuidCounter = 0; }
  sha256(data) { return createHash('sha256').update(data, 'utf-8').digest('hex'); }
  generateUuid() { this._uuidCounter++; return `00000000-0000-0000-0000-${String(this._uuidCounter).padStart(12, '0')}`; }
}

const t = new TestHelpers();

async function run() {
  console.log('══ LocalCache Entry Format Tests (Bug 3b fix) ══\n');

  // ── Group 1: Entry write format uses _enc suffix ────────────────────
  console.log('── Group 1: _enc Field Suffix ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Test Format Task',
      startEpoch: 1700000000000,
      endEpoch: 1700003600000,
      deviceUuid: 'test-dev-web',
    });

    // Read raw entries from storage to inspect format
    const raw = await storage.get('entries');
    t.assert(Array.isArray(raw) && raw.length > 0, '1a. entries array stored');
    const rawEntry = raw[0];

    // After fix: entry should be { hash, data: { ... } }
    t.assert(rawEntry.hash !== undefined, '1b. entry has hash at top level');
    t.assert(rawEntry.data !== undefined, '1c. entry has data wrapper');

    if (rawEntry.data) {
      // Fields in data should use _enc suffix
      t.assert(rawEntry.data.startTime_enc !== undefined,
        '1d. startTime_enc field exists (NOT start_epoch)');
      t.assert(rawEntry.data.endTime_enc !== undefined,
        '1e. endTime_enc field exists (NOT end_epoch)');
      t.assert(rawEntry.data.start_epoch === undefined,
        '1f. NO flat start_epoch field in data');
      t.assert(rawEntry.data.end_epoch === undefined,
        '1g. NO flat end_epoch field in data');
    }
  }

  // ── Group 2: plain: prefix for staging values (unencrypted) ─────────
  console.log('\n── Group 2: plain: Prefix for Staging Values ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Plain Prefix Task',
      startEpoch: 1700000000000,
      deviceUuid: 'prefix-dev-web',
    });

    const raw = await storage.get('entries');
    const data = raw[0].data;

    // startTime_enc should be "plain:1700000000000"
    t.assert(typeof data.startTime_enc === 'string',
      '2a. startTime_enc is a string');
    t.assert(data.startTime_enc.startsWith('plain:'),
      `2b. startTime_enc has plain: prefix (got: ${data.startTime_enc?.slice(0, 20)})`);

    // Verify the value after prefix is correct
    const epochVal = data.startTime_enc.replace('plain:', '');
    t.assertEq(epochVal, '1700000000000', '2c. plain: prefix wraps correct epoch value');
  }

  // ── Group 3: All encryptable fields get _enc suffix ──────────────────
  console.log('\n── Group 3: Complete Field Mapping ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Full Mapping Task',
      startEpoch: 1700000000000,
      endEpoch: 1700003600000,
      tags: ['work', 'important'],
      deviceUuid: 'full-dev-web',
    });

    const rawEntry = (await storage.get('entries'))[0];
    const data = rawEntry.data;

    // Required _enc fields per PHPSPEC.md §3.1.1
    const expectedEncFields = [
      'startTime_enc',
      'endTime_enc',
      'pauses_enc',
      'metadata_enc',
      'device_uuid_enc',
    ];

    for (const field of expectedEncFields) {
      t.assert(data[field] !== undefined,
        `3a. ${field} field exists`);
    }

    // Non-encryptable fields should NOT have _enc suffix
    t.assert(typeof data.title === 'string', '3b. title is plain string (no _enc suffix)');
    t.assert(Array.isArray(data.tags), '3c. tags is array (no _enc suffix)');

    // Verify pauses_enc has plain: prefix even for empty
    t.assert(data.pauses_enc.startsWith('plain:'),
      `3d. pauses_enc has plain: prefix (got: ${data.pauses_enc?.slice(0, 20)})`);

    // metadata_enc has plain: prefix
    t.assert(data.metadata_enc.startsWith('plain:'),
      `3e. metadata_enc has plain: prefix (got: ${data.metadata_enc?.slice(0, 20)})`);
  }

  // ── Group 4: {hash, data} wrapper structure ──────────────────────────
  console.log('\n── Group 4: {hash, data} Wrapper Structure ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    const cache = new LocalCache(storage, crypto);

    const hashPrefix = await cache.append({
      title: 'Wrapper Structure Task',
      startEpoch: 1700000000000,
    });

    const rawEntry = (await storage.get('entries'))[0];

    // Must have hash at top level
    t.assert(typeof rawEntry.hash === 'string', '4a. hash is string at top level');
    t.assertEq(rawEntry.hash.length, 64, '4b. hash is 64-char hex (SHA-256)');

    // Hash must match prefix returned by append()
    t.assert(rawEntry.hash.startsWith(hashPrefix),
      `4c. stored hash starts with returned prefix (stored: ${rawEntry.hash.slice(0, 10)}, prefix: ${hashPrefix})`);

    // All entry data must be inside data.*
    t.assert(typeof rawEntry.data === 'object', '4d. data is object');
    t.assert(rawEntry.data.title === 'Wrapper Structure Task',
      '4e. title lives in data.* ');

    // No data fields should leak to top level (except hash)
    t.assert(rawEntry.data.title !== undefined, '4f. title in data');
    t.assert(rawEntry.title === undefined, '4g. NO flat title at top level');
    t.assert(rawEntry.start_epoch === undefined, '4h. NO flat start_epoch at top level');
  }

  // ── Group 5: readEntries() still returns usable DTOs (no regression) ─
  console.log('\n── Group 5: readEntries() Backward Compatibility ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Compat Task',
      startEpoch: 1700010000000,
      endEpoch: 1700013600000,
      tags: ['compat'],
    });

    const entries = await cache.readEntries();

    // readEntries() must return usable DTOs regardless of raw format
    t.assertEq(entries.length, 1, '5a. one entry returned');
    const dto = entries[0];
    t.assertEq(dto.title, 'Compat Task', '5b. title readable');
    t.assertEq(dto.start_epoch, 1700010000000, '5c. start_epoch readable (number)');
    t.assertEq(dto.end_epoch, 1700013600000, '5d. end_epoch readable (number)');

    // DTO should use the internal flat naming convention
    // (rawEntryToDTO converts _enc fields back to flat)
    t.assert(typeof dto.start_epoch === 'number', '5e. start_epoch is number in DTO');
    t.assert(typeof dto.duration === 'number', '5f. duration is number');
    t.assert(Array.isArray(dto.tags), '5g. tags is array');
    t.assertEq(dto.tags[0], 'compat', '5h. tags correct');
  }

  // ── Group 6: Multiple entries written correctly ──────────────────────
  console.log('\n── Group 6: Multiple Entry Write/Read Roundtrip ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    const cache = new LocalCache(storage, crypto);

    await cache.append({ title: 'Task A', startEpoch: 1000000 });
    await cache.append({ title: 'Task B', startEpoch: 2000000 });
    await cache.append({ title: 'Task C', startEpoch: 3000000 });

    const raw = await storage.get('entries');
    t.assertEq(raw.length, 3, '6a. 3 entries stored');

    // Each raw entry has {hash, data}
    for (let i = 0; i < raw.length; i++) {
      t.assert(raw[i].hash !== undefined, `6b-${i}. entry ${i} has hash`);
      t.assert(raw[i].data !== undefined, `6c-${i}. entry ${i} has data wrapper`);
      t.assert(raw[i].data.title !== undefined, `6d-${i}. entry ${i} has title in data`);
    }

    // readEntries returns 3 readable DTOs
    const dtos = await cache.readEntries();
    t.assertEq(dtos.length, 3, '6e. readEntries returns 3 DTOs');
    t.assertEq(dtos[0].title, 'Task A', '6f. DTO[0] correct title');
    t.assertEq(dtos[1].title, 'Task B', '6g. DTO[1] correct title');
    t.assertEq(dtos[2].title, 'Task C', '6h. DTO[2] correct title');
  }

  // ── Group 7: Update preserves _enc field names ───────────────────────
  console.log('\n── Group 7: Update Preserves Format ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    const cache = new LocalCache(storage, crypto);

    await cache.append({ title: 'Update Task', startEpoch: 1000000 });
    await cache.update(0, { is_active: false, end_epoch: 1500000 });

    const raw = await storage.get('entries');
    const updated = raw[0];

    // Should still have {hash, data} wrapper
    t.assert(updated.hash !== undefined, '7a. hash preserved after update');
    t.assert(updated.data !== undefined, '7b. data wrapper preserved after update');

    // endTime_enc should be set
    t.assert(updated.data.endTime_enc !== undefined,
      '7c. endTime_enc set after end_epoch update');
    t.assert(updated.data.endTime_enc.startsWith('plain:'),
      `7d. endTime_enc has plain: prefix (got: ${updated.data.endTime_enc?.slice(0, 20)})`);
  }

  // ── Group 8: device_uuid maps to device_uuid_enc ─────────────────────
  console.log('\n── Group 8: device_uuid → device_uuid_enc ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Device Uuid Task',
      startEpoch: 1000000,
      deviceUuid: 'my-device-uuid-1234',
    });

    const rawEntry = (await storage.get('entries'))[0];
    const data = rawEntry.data;

    t.assert(data.device_uuid_enc !== undefined,
      '8a. device_uuid_enc exists');
    t.assert(data.device_uuid === undefined,
      '8b. NO flat device_uuid field');
    t.assert(data.device_uuid_enc.startsWith('plain:'),
      '8c. device_uuid_enc has plain: prefix');
    t.assert(data.device_uuid_enc.includes('my-device-uuid-1234'),
      '8d. device_uuid_enc contains original value');
  }

  // ── Group 9: Hash is computed from data object (flat fields excluded) ─
  console.log('\n── Group 9: Hash Computation Uses data.* ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Hash Test Task',
      startEpoch: 1234567890,
      tags: ['hash-test'],
    });

    // Read raw to verify hash matches
    const rawEntry = (await storage.get('entries'))[0];

    // Recompute expected hash from data object
    const dataForHash = { ...rawEntry.data };
    // Sort keys for deterministic JSON
    const sorted = {};
    for (const k of Object.keys(dataForHash).sort()) {
      sorted[k] = dataForHash[k];
    }
    const expectedHash = crypto.sha256(JSON.stringify(sorted));

    t.assertEq(rawEntry.hash, expectedHash,
      '9a. stored hash matches recomputed hash from data.* fields');
  }

  // ── Results ───────────────────────────────────────────────────────
  t.summary('LocalCache Entry Format (Bug 3b fix)');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
