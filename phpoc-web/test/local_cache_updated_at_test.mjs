/**
 * local_cache_updated_at_test.mjs — Option A: `updated_at` persistence in the
 * legacy LocalCache path.
 *
 * Phase 2 (RED) tests for `docs/planning/WEB_STAGING_UPDATED_AT_PHASE1.md`
 * Groups A (capture), B (mutation), C (backward-compat).
 *
 * All tests currently fail for the right reason: LocalCache does not yet
 * persist `updated_at` (PHPSPEC §8.1 violation), so the raw wrapper carries
 * no timestamp and readEntries()/writeEntries() drop it.
 *
 * Run: node test/local_cache_updated_at_test.mjs
 */

import { createHash } from 'crypto';
import { LocalCache } from '../src/sync/local_cache.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

/** Minimal crypto mock — no master key so all values use the plain: prefix. */
class MockCrypto {
  constructor() { this._uuid = 0; }
  sha256(data) { return createHash('sha256').update(data, 'utf-8').digest('hex'); }
  generateUuid() {
    this._uuid++;
    return `00000000-0000-0000-0000-${String(this._uuid).padStart(12, '0')}`;
  }
  hasMasterKey() { return false; }
}

const t = new TestHelpers();

/**
 * Build a LocalCache with injectible clock (`now`) and activity-id generator.
 * `now` is the clock-injection seam added in Phase 3 — currently ignored.
 */
function makeCache(now) {
  const storage = new MemoryBackend();
  const crypto = new MockCrypto();
  const cache = new LocalCache(storage, crypto, {
    generateId: () => 'activity-01',
    now,
  });
  return { cache, storage, crypto };
}

async function run() {
  console.log('══ LocalCache updated_at persistence (Option A) — Groups A/B/C ══\n');

  // ── Group A: capture persists updated_at ──────────────────────
  console.log('── Group A: capture persists updated_at ──\n');

  // A1 — append stores a numeric updated_at on the raw wrapper
  {
    const { cache, storage } = makeCache(() => 1234567890);
    await cache.append({ title: 'A1', startEpoch: 1000 });
    const raw = (await storage.get('entries'))[0];
    t.assert(typeof raw.updated_at === 'number',
      'A1 append stores numeric updated_at on raw wrapper');
  }

  // A2 — updated_at equals injected clock, not start_epoch
  {
    const { cache, storage } = makeCache(() => 1234567890);
    await cache.append({ title: 'A2', startEpoch: 1000 });
    const raw = (await storage.get('entries'))[0];
    t.assertEq(raw.updated_at, 1234567890,
      'A2 updated_at equals injected clock, not start_epoch');
  }

  // A3 — readEntries DTO exposes updated_at equal to stored raw value
  // (type guard prevents a false green when both sides are undefined)
  {
    const { cache, storage } = makeCache(() => 1234567890);
    await cache.append({ title: 'A3', startEpoch: 1000 });
    const raw = (await storage.get('entries'))[0];
    const dto = (await cache.readEntries())[0];
    t.assert(typeof dto.updated_at === 'number' && dto.updated_at === raw.updated_at,
      'A3 readEntries DTO exposes updated_at equal to stored raw value');
  }

  // A4 — writeEntries round-trips an explicit DTO updated_at
  {
    const { cache } = makeCache(() => 0);
    const dto = {
      entry_id: 'e1', title: 'A4', start_epoch: 1000, end_epoch: null,
      duration: 0, is_active: true, is_paused: false, pauses: [], tags: [],
      comment: null, media: [], device_uuid: '', end_device_uuid: '',
      metadata: {}, hash: 'h-a4', committed: false, block_index: null,
      updated_at: 777,
    };
    await cache.writeEntries([dto]);
    const entries = await cache.readEntries();
    t.assertEq(entries[0].updated_at, 777,
      'A4 writeEntries round-trips explicit DTO updated_at');
  }

  // ── Group B: mutation bumps updated_at ────────────────────────
  console.log('\n── Group B: mutation bumps updated_at ──\n');

  // B1 — update() bumps to current clock
  {
    let now = 1000000;
    const { cache, storage } = makeCache(() => now);
    await cache.append({ title: 'B1', startEpoch: 1000 });
    now = 2000000;
    await cache.update(0, { title: 'B1-updated' });
    const raw = (await storage.get('entries'))[0];
    t.assertEq(raw.updated_at, 2000000,
      'B1 update bumps updated_at to current clock');
  }

  // B2 — addPause() bumps to current clock
  {
    let now = 1000000;
    const { cache, storage } = makeCache(() => now);
    await cache.append({ title: 'B2', startEpoch: 1000 });
    now = 2000000;
    await cache.addPause(0, 1500000);
    const raw = (await storage.get('entries'))[0];
    t.assertEq(raw.updated_at, 2000000,
      'B2 addPause bumps updated_at to current clock');
  }

  // B3 — closePause() bumps to current clock
  {
    let now = 1000000;
    const { cache, storage } = makeCache(() => now);
    await cache.append({ title: 'B3', startEpoch: 1000 });
    now = 2000000;
    await cache.addPause(0, 1500000);
    now = 3000000;
    await cache.closePause(0, 2500000);
    const raw = (await storage.get('entries'))[0];
    t.assertEq(raw.updated_at, 3000000,
      'B3 closePause bumps updated_at to current clock');
  }

  // B4 (guard) — markCommitted does NOT change updated_at
  {
    const { cache, storage } = makeCache(() => 1234567890);
    await cache.append({ title: 'B4', startEpoch: 1000 });
    const entryId = (await cache.readEntries())[0].entry_id;
    const before = (await storage.get('entries'))[0].updated_at;
    await cache.markCommitted([entryId], 0);
    const after = (await storage.get('entries'))[0].updated_at;
    t.assertEq(after, before,
      'B4 markCommitted does not change updated_at');
  }

  // B5 — updated_at on the wrapper, not inside hashed data
  {
    const { cache, storage } = makeCache(() => 1234567890);
    await cache.append({ title: 'B5', startEpoch: 1000 });
    const raw = (await storage.get('entries'))[0];
    t.assert(('updated_at' in raw) && !('updated_at' in (raw.data || {})),
      'B5 updated_at on wrapper, not inside hashed data');
  }

  // ── Group C: backward-compat fallback ─────────────────────────
  console.log('\n── Group C: backward-compat fallback ──\n');

  // C1 — missing updated_at backfills to start_epoch (deterministic, not Date.now())
  {
    const { cache, storage } = makeCache(() => 9999999999);
    const legacyRaw = {
      hash: 'h-legacy',
      data: {
        entry_id: 'legacy-1', title: 'Legacy',
        startTime_enc: 'plain:1000', duration: 0,
        is_active: true, is_paused: false,
        pauses_enc: 'plain:[]', tags: [], media: [],
        metadata_enc: 'plain:{}',
        device_uuid_enc: 'plain:', end_device_uuid_enc: 'plain:',
      },
      committed: false, block_index: null,
    };
    await storage.set('entries', [legacyRaw]);
    const entries = await cache.readEntries();
    t.assertEq(entries[0].updated_at, entries[0].start_epoch,
      'C1 _rawToDto backfills missing updated_at to start_epoch (not Date.now())');
  }

  // C2 — legacy entry with end_epoch backfills updated_at to start_epoch, not end_epoch
  {
    const { cache, storage } = makeCache(() => 9999999999);
    const legacyRaw = {
      hash: 'h-legacy2',
      data: {
        entry_id: 'legacy-2', title: 'Legacy Full',
        startTime_enc: 'plain:3000', endTime_enc: 'plain:5000',
        duration: 2000, is_active: false, is_paused: false,
        pauses_enc: 'plain:[{"pause_start":4000,"pause_stop":4500}]',
        tags: ['a', 'b'], comment: 'note', media: [],
        metadata_enc: 'plain:{}',
        device_uuid_enc: 'plain:dev-1', end_device_uuid_enc: 'plain:dev-2',
      },
      committed: false, block_index: null,
    };
    await storage.set('entries', [legacyRaw]);
    const entries = await cache.readEntries();
    t.assertEq(entries[0].updated_at, 3000,
      'C2 legacy updated_at backfills to start_epoch even when end_epoch is set');
  }

  // ── Results ──
  const failed = t.summary('local_cache_updated_at');
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
