/**
 * MockDataSeeder — generates realistic staging entries and seeds them
 * into the MockRemoteBackend.
 *
 * This replaces the old DummySyncService (which had 4 hardcoded entries
 * in memory) with realistic data stored in the mock remote. The real
 * SyncService then pulls it down during checkAndSync(), giving a
 * realistic full-stack simulation.
 *
 * Seeded blobs:
 *   staging/blobs/current.json  — staging entries (active + completed)
 *   staging/blobs/device_cookie.bin — device cookie for auth fast-path
 *   ledger/blocks/0.json        — genesis block (empty)
 *
 * Usage:
 *   import { seedMockRemote } from '../services/MockDataSeeder.js';
 *   await seedMockRemote(mockRemote, crypto);
 */

import { DummyCryptoService } from './DummyLedger.js';

// ── Helpers ──────────────────────────────────────────────────────────

let _idCounter = 0;

function nextId() {
  _idCounter++;
  const hex = _idCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-a000-${hex}00000000`;
}

function deterministicHash(data) {
  let hash = 5381;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(64, '0');
}

// ── Activity templates ──────────────────────────────────────────────

const ACTIVITIES = {
  weekday: [
    { title: 'Morning Exercise',   startHour: 6,  durationMin: 30,  tags: ['fitness', 'health'] },
    { title: 'Deep Work Session',  startHour: 8,  durationMin: 120, tags: ['work', 'focus'] },
    { title: 'Lunch Break',        startHour: 12, durationMin: 45,  tags: ['break', 'health'] },
    { title: 'Afternoon Coding',   startHour: 14, durationMin: 90,  tags: ['coding', 'work'] },
    { title: 'Reading',            startHour: 17, durationMin: 40,  tags: ['reading', 'learning'] },
    { title: 'Evening Walk',       startHour: 19, durationMin: 30,  tags: ['fitness', 'outdoor'] },
  ],
  weekend: [
    { title: 'Sleep In / Rest',    startHour: 8,  durationMin: 60,  tags: ['rest', 'health'] },
    { title: 'Household Chores',   startHour: 10, durationMin: 90,  tags: ['chores', 'home'] },
    { title: 'Hobby Time',         startHour: 13, durationMin: 120, tags: ['hobby', 'creative'] },
    { title: 'Social / Family',    startHour: 16, durationMin: 90,  tags: ['social', 'family'] },
    { title: 'Reading',            startHour: 19, durationMin: 45,  tags: ['reading', 'learning'] },
  ],
};

/**
 * Pick a random subset of activities for a given day type.
 * @param {'weekday'|'weekend'} dayType
 * @param {number} min - minimum activities
 * @param {number} max - maximum activities
 * @returns {Array} Selected activities
 */
function pickActivities(dayType, min = 3, max = 5) {
  const pool = ACTIVITIES[dayType] || ACTIVITIES.weekday;
  const count = Math.min(
    Math.floor(Math.random() * (max - min + 1)) + min,
    pool.length
  );
  // Shuffle and pick
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).sort((a, b) => a.startHour - b.startHour);
}

// ── Entry builder ───────────────────────────────────────────────────

/**
 * Build a single staging entry.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {number} opts.startEpoch
 * @param {number} opts.durationMin
 * @param {string[]} opts.tags
 * @param {string} opts.deviceUuid
 * @returns {object} Staging entry DTO
 */
function buildEntry({ title, startEpoch, durationMin, tags, deviceUuid }) {
  const entryId = nextId();
  const endEpoch = startEpoch + durationMin * 60 * 1000;
  const data = {
    entry_id: entryId,
    title,
    start_epoch: startEpoch,
    end_epoch: endEpoch,
    duration: durationMin * 60 * 1000,
    is_active: false,
    is_paused: false,
    pauses: [],
    tags: tags.map(t => t.toLowerCase().trim()).sort(),
    comment: null,
    media: [],
    device_uuid: deviceUuid,
    end_device_uuid: deviceUuid,
    metadata: {},
  };
  data.hash = deterministicHash(JSON.stringify(data, Object.keys(data).sort()));
  return data;
}

// ── Blob builder ────────────────────────────────────────────────────

/**
 * Generate a month of realistic staging entries.
 *
 * @param {object} [opts]
 * @param {number} [opts.days=14] - Number of days of history to generate.
 * @param {number} [opts.activeCount=2] - Number of "active right now" entries to add.
 * @param {string} [opts.deviceUuid='dev-mock-001'] - Device UUID.
 * @returns {object} Blob object with { device_id, device_proof, entries, updated_at }
 */
function generateStagingBlob(opts = {}) {
  const {
    days = 14,
    activeCount = 2,
    deviceUuid = 'dev-mock-001',
  } = opts;

  const now = Date.now();
  const entries = [];

  // Generate historical entries for past days
  for (let dayOffset = days; dayOffset > 0; dayOffset--) {
    const dayStart = now - dayOffset * 24 * 60 * 60 * 1000;
    const date = new Date(dayStart);
    const dayOfWeek = date.getDay(); // 0=Sun, 6=Sat
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    const activities = pickActivities(isWeekend ? 'weekend' : 'weekday', 2, 4);

    for (const act of activities) {
      const startEpoch = new Date(date).setHours(
        act.startHour, Math.floor(Math.random() * 30), 0, 0
      );

      // 30% chance to skip this activity (not everything happens every day)
      if (Math.random() < 0.3) continue;

      // Add some duration variance
      const variance = (Math.random() * 0.4 - 0.2); // ±20%
      const adjDuration = Math.max(10, act.durationMin * (1 + variance));

      entries.push(buildEntry({
        title: act.title,
        startEpoch,
        durationMin: Math.round(adjDuration),
        tags: act.tags,
        deviceUuid,
      }));
    }
  }

  // Add currently active entries (not ended, simulates "right now")
  for (let i = 0; i < activeCount; i++) {
    const activeEntry = buildEntry({
      title: i === 0 ? 'Coding Practice' : 'Research & Learning',
      startEpoch: now - (i === 0 ? 45 : 120) * 60 * 1000,
      durationMin: 0,
      tags: i === 0 ? ['coding', 'practice'] : ['research', 'learning'],
      deviceUuid,
    });
    activeEntry.is_active = true;
    activeEntry.end_epoch = null;
    activeEntry.duration = 0;
    activeEntry.hash = deterministicHash(
      JSON.stringify(activeEntry, Object.keys(activeEntry).sort())
    );
    entries.push(activeEntry);
  }

  // Sort by start_epoch ascending
  entries.sort((a, b) => a.start_epoch - b.start_epoch);

  return {
    device_id: deviceUuid,
    device_proof: deterministicHash(deviceUuid + 'proof'),
    entries,
    updated_at: now,
  };
}

// ── Genesis block builder ───────────────────────────────────────────

/**
 * Build a minimal genesis ledger block.
 *
 * @param {number} [timestamp]
 * @returns {object} Genesis block
 */
function buildGenesisBlock(timestamp) {
  const ts = timestamp || Date.now();
  const date = new Date(ts);
  return {
    block_index: 0,
    block_type: 'genesis',
    prev_hash: '0'.repeat(64),
    block_hash: '',
    created_at: ts,
    date: date.toISOString().slice(0, 10),
    entries: [],
    seal: deterministicHash(`genesis:${ts}`),
  };
}

// ── Exports for testing ────────────────────────────────────────────

/**
 * Deterministic hash helper (djb2) — exported for test verification.
 * @param {any} data
 * @returns {string} 64-char hex
 */
export function _detHash(data) {
  return deterministicHash(data);
}

/**
 * Reset the ID counter (for deterministic test output).
 */
export function _resetIdCounter() {
  _idCounter = 0;
}

/**
 * Generate a staging blob — exported for unit testing.
 * @see generateStagingBlob
 */
export { generateStagingBlob };

/**
 * Build a genesis block — exported for unit testing.
 * @see buildGenesisBlock
 */
export { buildGenesisBlock };

/**
 * Activity templates — exported for test inspection.
 */
export { ACTIVITIES };

// ── Public API ──────────────────────────────────────────────────────

/**
 * Seed the MockRemoteBackend with realistic test data.
 *
 * Creates:
 *   - staging/blobs/current.json   — N days of staging entries + active tasks
 *   - staging/blobs/device_cookie.bin — device cookie
 *   - ledger/blocks/0.json         — genesis block
 *
 * @param {import('../sync/mock_remote.js').MockRemoteBackend} mockRemote
 * @param {import('@crypto/index.js').DummyCryptoService} [crypto]
 * @param {object} [opts]
 * @param {number} [opts.historyDays=14]
 * @param {number} [opts.activeTasks=2]
 * @param {string} [opts.deviceUuid='dev-mock-001']
 * @param {string} [opts.deviceSpecifier]
 */
export async function seedMockRemote(mockRemote, crypto, opts = {}) {
  const {
    historyDays = 14,
    activeTasks = 2,
    deviceUuid = 'dev-mock-001',
    deviceSpecifier,
  } = opts;

  const effectiveCrypto = crypto || new DummyCryptoService();

  // ── 1. Staging blob ──
  const blob = generateStagingBlob({
    days: historyDays,
    activeCount: activeTasks,
    deviceUuid,
  });

  await mockRemote.push(
    'staging/blobs/current.json',
    new TextEncoder().encode(JSON.stringify(blob, null, 2))
  );

  // ── 2. Device cookie ──
  const specifier = deviceSpecifier || effectiveCrypto.generateDeviceSpecifier();
  const cookie = {
    device_uuid: deviceUuid,
    device_specifier: specifier,
  };

  await mockRemote.push(
    'staging/blobs/device_cookie.bin',
    new TextEncoder().encode(JSON.stringify(cookie))
  );

  // ── 3. Genesis block ──
  const genesis = buildGenesisBlock(blob.updated_at - historyDays * 86400000);
  await mockRemote.push(
    'ledger/blocks/0.json',
    new TextEncoder().encode(JSON.stringify(genesis, null, 2))
  );

  // ── 4. Ledger index ──
  const index = {
    blocks: ['ledger/blocks/0.json'],
    latest_block_index: 0,
    updated_at: Date.now(),
  };
  await mockRemote.push(
    'ledger/index.json',
    new TextEncoder().encode(JSON.stringify(index, null, 2))
  );

  return { blob, cookie, genesis };
}

/**
 * Generate a summary of what was seeded (for dev display).
 *
 * @param {import('../sync/mock_remote.js').MockRemoteBackend} mockRemote
 * @returns {Promise<object>}
 */
export async function inspectMockRemote(mockRemote) {
  const dump = await mockRemote.dump();
  const entryCounts = {};

  for (const item of dump) {
    const stored = await mockRemote.pull(item.path);
    if (stored) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(stored));
        if (parsed.entries) {
          entryCounts[item.path] = {
            total: parsed.entries.length,
            active: parsed.entries.filter(e => e.is_active).length,
          };
        } else {
          entryCounts[item.path] = { size: item.size };
        }
      } catch {
        entryCounts[item.path] = { size: item.size, note: 'binary' };
      }
    }
  }

  return {
    blobs: dump,
    entryCounts,
    totalBlobs: dump.length,
  };
}
