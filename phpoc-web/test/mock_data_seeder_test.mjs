/**
 * mock_data_seeder_test.mjs — MockDataSeeder test suite.
 *
 * Tests generateStagingBlob(), buildGenesisBlock(), seedMockRemote(),
 * and inspectMockRemote() for structural correctness.
 *
 * Usage:
 *   node test/mock_data_seeder_test.mjs
 */

import { MockRemoteBackend } from '../src/sync/mock_remote.js';
import { MemoryBackend } from '../src/sync/storage.js';
import {
  seedMockRemote,
  inspectMockRemote,
  generateStagingBlob,
  buildGenesisBlock,
  _detHash,
  _resetIdCounter,
  ACTIVITIES,
} from '../src/services/MockDataSeeder.js';

// ── Helpers ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, label) {
  if (condition) { passed++; process.stdout.write('  ✓'); }
  else { failed++; errors.push(label); process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

function assertEq(actual, expected, label) {
  const ok = actual === expected;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 120)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 120)}`);
  }
  console.log(`  ${label}`);
}

function assertNeq(actual, expected, label) {
  const ok = actual !== expected;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 120)} should differ from expected`);
  }
  console.log(`  ${label}`);
}

function assertDeepEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got:      ${JSON.stringify(actual).slice(0, 200)}`);
    console.log(`      expected: ${JSON.stringify(expected).slice(0, 200)}`);
  }
  console.log(`  ${label}`);
}

function assertBetween(actual, min, max, label) {
  const ok = actual >= min && actual <= max;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      got: ${actual}, expected between ${min} and ${max}`);
  }
  console.log(`  ${label}`);
}

function assertHasKeys(obj, keys, label) {
  const missing = keys.filter(k => !(k in obj));
  const ok = missing.length === 0;
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++; errors.push(label);
    process.stdout.write('  ✗');
    console.log(`\n      missing keys: ${missing.join(', ')}`);
  }
  console.log(`  ${label}`);
}

function strToBytes(str) {
  return new TextEncoder().encode(str);
}

function bytesToStr(bytes) {
  return new TextDecoder().decode(bytes);
}

function createMock() {
  const storage = new MemoryBackend();
  const remote = new MockRemoteBackend({
    storage,
    latencyMs: 0,
    errorRate: 0,
  });
  return { storage, remote };
}

// ── Tests ────────────────────────────────────────────────────────────

async function testGenerateStagingBlobStructure() {
  console.log('\n── generateStagingBlob structure ──');

  const blob = generateStagingBlob({ days: 5, activeCount: 2, deviceUuid: 'test-dev' });

  assertHasKeys(blob, ['device_id', 'device_proof', 'entries', 'updated_at'], 'blob has all top-level keys');
  assertEq(blob.device_id, 'test-dev', 'device_id matches');
  assertEq(typeof blob.device_proof, 'string', 'device_proof is string');
  assert(blob.device_proof.length > 0, 'device_proof is not empty');
  assert(Array.isArray(blob.entries), 'entries is array');
  assert(blob.entries.length > 0, 'entries is not empty');
  assert(typeof blob.updated_at === 'number', 'updated_at is number');
}

async function testGenerateStagingBlobDays() {
  console.log('\n── generateStagingBlob days ──');

  // With 3 days, we should get some entries but the exact count varies
  const blob3 = generateStagingBlob({ days: 3, activeCount: 1, deviceUuid: 't' });
  assert(blob3.entries.length >= 1, '3 days generates ≥1 entries');
  assertBetween(blob3.entries.length, 1, 30, '3 days produces reasonable entry count');

  // 0 days should produce only active entries
  const blob0 = generateStagingBlob({ days: 0, activeCount: 2, deviceUuid: 't' });
  assertEq(blob0.entries.length, 2, '0 days + 2 active = exactly 2 entries');
}

async function testActiveEntries() {
  console.log('\n── active entries ──');

  const blob = generateStagingBlob({ days: 1, activeCount: 3, deviceUuid: 't' });
  const active = blob.entries.filter(e => e.is_active);
  assertEq(active.length, 3, 'correct number of active entries');

  for (const entry of active) {
    assert(entry.end_epoch === null, `active entry ${entry.title} has null end_epoch`);
    assertEq(entry.is_paused, false, `active entry ${entry.title} is not paused`);
    assertEq(entry.duration, 0, `active entry ${entry.title} has 0 duration`);
  }
}

async function testCompletedEntriesNoActive() {
  console.log('\n── completed entries ──');

  const blob = generateStagingBlob({ days: 2, activeCount: 0, deviceUuid: 't' });
  const active = blob.entries.filter(e => e.is_active);
  const completed = blob.entries.filter(e => !e.is_active);

  assertEq(active.length, 0, '0 active entries when activeCount=0');
  assert(completed.length > 0, 'has completed entries');
}

async function testEntriesSorted() {
  console.log('\n── entries sorted ──');

  const blob = generateStagingBlob({ days: 7, activeCount: 1, deviceUuid: 't' });
  for (let i = 1; i < blob.entries.length; i++) {
    assert(
      blob.entries[i].start_epoch >= blob.entries[i - 1].start_epoch,
      `entries sorted at index ${i}: ${blob.entries[i-1].title} → ${blob.entries[i].title}`
    );
  }
}

async function testEntryStructure() {
  console.log('\n── entry structure ──');

  const blob = generateStagingBlob({ days: 1, activeCount: 1, deviceUuid: 't' });

  for (const entry of blob.entries) {
    assertHasKeys(entry, [
      'entry_id', 'title', 'start_epoch', 'end_epoch', 'duration',
      'is_active', 'is_paused', 'pauses', 'tags', 'comment',
      'media', 'device_uuid', 'end_device_uuid', 'metadata', 'hash',
    ], `entry "${entry.title}" has all required fields`);

    assert(typeof entry.entry_id === 'string' && entry.entry_id.length > 0,
      `entry_id is non-empty string`);
    assert(typeof entry.title === 'string' && entry.title.length > 0,
      `title is non-empty string`);
    assert(typeof entry.start_epoch === 'number' && entry.start_epoch > 0,
      `start_epoch is positive number`);
    assert(Array.isArray(entry.tags), 'tags is array');
    assert(Array.isArray(entry.pauses), 'pauses is array');
    assert(typeof entry.hash === 'string' && entry.hash.length > 0,
      'hash is non-empty string');
    assertEq(typeof entry.comment, 'object', 'comment is null');  // null type is 'object'
    assertEq(entry.comment, null, 'comment is null');
    assertEq(entry.is_paused, false, 'entry is not paused');
    assertDeepEq(entry.pauses, [], 'pauses is empty array');
    assertDeepEq(entry.media, [], 'media is empty array');
  }
}

async function testEntryTagsNormalized() {
  console.log('\n── tags normalized ──');

  const blob = generateStagingBlob({ days: 1, activeCount: 0, deviceUuid: 't' });

  for (const entry of blob.entries) {
    // Tags should be sorted and unique
    for (let i = 1; i < entry.tags.length; i++) {
      assert(entry.tags[i] >= entry.tags[i - 1], `tags sorted: ${entry.tags.join(',')}`);
    }
    // All lowercase
    for (const tag of entry.tags) {
      assertEq(tag, tag.toLowerCase(), `tag "${tag}" is lowercase`);
    }
  }
}

async function testBuildGenesisBlock() {
  console.log('\n── buildGenesisBlock ──');

  const ts = 1700000000000;
  const genesis = buildGenesisBlock(ts);

  assertHasKeys(genesis, [
    'block_index', 'block_type', 'prev_hash', 'block_hash',
    'created_at', 'date', 'entries', 'seal',
  ], 'genesis block has all required fields');

  assertEq(genesis.block_index, 0, 'block_index is 0');
  assertEq(genesis.block_type, 'genesis', 'block_type is genesis');
  assertEq(genesis.prev_hash, '0'.repeat(64), 'prev_hash is 64 zeros');
  assertEq(genesis.block_hash, '', 'block_hash is empty string');
  assertEq(genesis.created_at, ts, 'created_at matches timestamp');
  assertEq(genesis.date, '2023-11-14', 'date is correct for timestamp');
  assertDeepEq(genesis.entries, [], 'entries is empty array');
  assert(typeof genesis.seal === 'string' && genesis.seal.length > 0,
    'seal is non-empty string');
}

async function testBuildGenesisBlockDefaultTimestamp() {
  console.log('\n── buildGenesisBlock default ──');

  const genesis = buildGenesisBlock();
  assert(typeof genesis.created_at === 'number', 'created_at is number');
  assert(genesis.created_at > 0, 'created_at is > 0');
  assert(typeof genesis.date === 'string', 'date is string');
}

async function testSeedMockRemote() {
  console.log('\n── seedMockRemote ──');

  const { remote } = createMock();
  const result = await seedMockRemote(remote, null, {
    historyDays: 3,
    activeTasks: 1,
    deviceUuid: 'seed-test',
    deviceSpecifier: 'spec123',
  });

  // Verify return value
  assertHasKeys(result, ['blob', 'cookie', 'genesis'], 'seed returns blob, cookie, genesis');
  assertEq(result.blob.device_id, 'seed-test', 'returned blob has correct device_id');
  assertEq(result.cookie.device_uuid, 'seed-test', 'returned cookie has correct device_uuid');
  assertEq(result.cookie.device_specifier, 'spec123', 'returned cookie has correct specifier');

  // Verify all expected paths exist
  const dump = await remote.dump();
  const paths = dump.map(d => d.path).sort();

  assertDeepEq(
    paths,
    ['ledger/blocks/0.json', 'ledger/index.json',
     'staging/blob', 'staging/blobs/device_cookie.bin'],
    'all 4 expected paths created'
  );
}

async function testSeededBlobContent() {
  console.log('\n── seeded blob content ──');

  const { remote } = createMock();
  await seedMockRemote(remote, null, { historyDays: 2, activeTasks: 2, deviceUuid: 't' });

  const raw = await remote.pull('staging/blob');
  assert(raw !== null, 'blob exists on remote');

  const parsed = JSON.parse(bytesToStr(raw));
  assert(Array.isArray(parsed.entries), 'parsed blob has entries array');
  assert(parsed.entries.length > 0, 'entries is non-empty');

  const active = parsed.entries.filter(e => e.is_active);
  assertEq(active.length, 2, 'exactly 2 active entries');
}

async function testSeededCookie() {
  console.log('\n── seeded cookie ──');

  const { remote } = createMock();
  await seedMockRemote(remote, null, {
    historyDays: 1,
    activeTasks: 0,
    deviceUuid: 'cookie-test',
    deviceSpecifier: 'abcdef123456',
  });

  const raw = await remote.pull('staging/blobs/device_cookie.bin');
  assert(raw !== null, 'cookie exists');

  const cookie = JSON.parse(bytesToStr(raw));
  assertEq(cookie.device_uuid, 'cookie-test', 'cookie device_uuid matches');
  assertEq(cookie.device_specifier, 'abcdef123456', 'cookie specifier matches');
}

async function testSeededGenesis() {
  console.log('\n── seeded genesis ──');

  const { remote } = createMock();
  await seedMockRemote(remote, null, { historyDays: 5, activeTasks: 0, deviceUuid: 't' });

  const raw = await remote.pull('ledger/blocks/0.json');
  assert(raw !== null, 'genesis block exists');

  const genesis = JSON.parse(bytesToStr(raw));
  assertEq(genesis.block_index, 0, 'genesis block_index is 0');
  assertEq(genesis.block_type, 'genesis', 'block_type is genesis');
  assertEq(genesis.prev_hash, '0'.repeat(64), 'prev_hash is 64 zeros');
}

async function testSeededLedgerIndex() {
  console.log('\n── seeded ledger index ──');

  const { remote } = createMock();
  await seedMockRemote(remote, null, { historyDays: 1, activeTasks: 0, deviceUuid: 't' });

  const raw = await remote.pull('ledger/index.json');
  assert(raw !== null, 'ledger index exists');

  const index = JSON.parse(bytesToStr(raw));
  assertHasKeys(index, ['blocks', 'latest_block_index', 'updated_at'], 'index has all fields');
  assertDeepEq(index.blocks, ['ledger/blocks/0.json'], 'index has genesis block reference');
  assertEq(index.latest_block_index, 0, 'latest_block_index is 0');
}

async function testInspectMockRemote() {
  console.log('\n── inspectMockRemote ──');

  const { remote } = createMock();

  // Inspect empty remote
  const emptyInfo = await inspectMockRemote(remote);
  assertEq(emptyInfo.totalBlobs, 0, 'empty remote has 0 blobs');
  assertDeepEq(emptyInfo.blobs, [], 'empty dump is empty');
  assertDeepEq(emptyInfo.entryCounts, {}, 'empty entryCounts is empty');

  // Seed and inspect
  await seedMockRemote(remote, null, { historyDays: 2, activeTasks: 1, deviceUuid: 't' });
  const info = await inspectMockRemote(remote);
  assertEq(info.totalBlobs, 4, 'seeded remote has 4 blobs');
  assertEq(info.blobs.length, 4, 'dump has 4 entries');

  // Entry counts should include staging blob
  const stagingInfo = info.entryCounts['staging/blob'];
  assert(stagingInfo !== undefined, 'staging blob in entryCounts');
  assert(typeof stagingInfo.total === 'number', 'total is number');
  assert(stagingInfo.total > 0, 'staging has entries');
  assertEq(stagingInfo.active, 1, 'exactly 1 active entry');
}

async function testDeterministicHash() {
  console.log('\n── deterministic hash ──');

  const h1 = _detHash('hello');
  const h2 = _detHash('hello');
  const h3 = _detHash('world');

  assertEq(h1, h2, 'same input produces same hash');
  assertNeq(h1, h3, 'different input produces different hash');
  assertEq(h1.length, 64, 'hash is 64 chars');
  assert(/^[0-9a-f]+$/.test(h1), 'hash is hex');
}

async function testActivityTemplates() {
  console.log('\n── activity templates ──');

  assertHasKeys(ACTIVITIES, ['weekday', 'weekend'], 'ACTIVITIES has weekday and weekend');

  assert(ACTIVITIES.weekday.length >= 5, 'weekday has ≥5 activities');
  assert(ACTIVITIES.weekend.length >= 4, 'weekend has ≥4 activities');

  for (const dayType of ['weekday', 'weekend']) {
    for (const act of ACTIVITIES[dayType]) {
      assertHasKeys(act, ['title', 'startHour', 'durationMin', 'tags'],
        `${dayType} activity "${act.title}" has all fields`);
      assert(typeof act.title === 'string' && act.title.length > 0, 'title is non-empty');
      assert(typeof act.startHour === 'number' && act.startHour >= 0 && act.startHour < 24,
        'startHour is valid hour');
      assert(typeof act.durationMin === 'number' && act.durationMin > 0,
        'durationMin is positive');
      assert(Array.isArray(act.tags) && act.tags.length > 0, 'tags is non-empty array');
    }
  }
}

async function testSeedWithNoCrypto() {
  console.log('\n── seed without crypto ──');

  const { remote } = createMock();
  // Passing null for crypto should use default DummyCryptoService internally
  const result = await seedMockRemote(remote, null, {
    historyDays: 1,
    activeTasks: 0,
    deviceUuid: 'no-crypto',
  });

  assert(result.cookie.device_specifier.length > 0, 'specifier generated without explicit crypto');
  assertEq(result.cookie.device_uuid, 'no-crypto', 'device_uuid correct');
}

async function testSeedWithDummyCrypto() {
  console.log('\n── seed with dummy crypto ──');

  const { remote } = createMock();
  const { DummyCryptoService } = await import('../src/services/DummyLedger.js');
  const crypto = await DummyCryptoService.create();

  const result = await seedMockRemote(remote, crypto, {
    historyDays: 1,
    activeTasks: 0,
    deviceUuid: 'crypto-dev',
  });

  assert(result.cookie.device_specifier.length > 0, 'specifier generated with crypto');
  assert(result.blob.entries.length > 0, 'entries generated');
}

async function testEntryIdUniqueness() {
  console.log('\n── entry ID uniqueness ──');

  // Each entry must have a unique ID within the same blob
  const blob = generateStagingBlob({ days: 5, activeCount: 2, deviceUuid: 't' });

  const ids = blob.entries.map(e => e.entry_id);
  const uniqueIds = new Set(ids);
  assertEq(ids.length, uniqueIds.size, 'all entry_ids within a blob are unique');

  // Each ID should be a UUID-like string
  for (const id of ids) {
    assert(typeof id === 'string' && id.length > 0, `entry_id is non-empty string: got ${typeof id}`);
    assert(id.includes('-'), `entry_id has UUID format: ${id}`);
  }
}

// ── Run ──────────────────────────────────────────────────────────────

async function run() {
  console.log('MockDataSeeder Test Suite');

  const tests = [
    testGenerateStagingBlobStructure,
    testGenerateStagingBlobDays,
    testActiveEntries,
    testCompletedEntriesNoActive,
    testEntriesSorted,
    testEntryStructure,
    testEntryTagsNormalized,
    testBuildGenesisBlock,
    testBuildGenesisBlockDefaultTimestamp,
    testSeedMockRemote,
    testSeededBlobContent,
    testSeededCookie,
    testSeededGenesis,
    testSeededLedgerIndex,
    testInspectMockRemote,
    testDeterministicHash,
    testActivityTemplates,
    testSeedWithNoCrypto,
    testSeedWithDummyCrypto,
    testEntryIdUniqueness,
  ];

  for (const test of tests) {
    try {
      await test();
    } catch (err) {
      failed++;
      errors.push(`${test.name}: ${err.message}`);
      console.log(`  ✗  ${test.name} — EXCEPTION: ${err.message}`);
      console.log(`     ${err.stack.split('\n').slice(1, 3).join('\n     ')}`);
    }
  }

  const total = passed + failed;
  console.log(`\n── Results ──`);
  console.log(`  ${passed} / ${total} passed${failed > 0 ? `, ${failed} failed` : ''}`);
  if (failed > 0) {
    console.log('\n  Failures:');
    for (const err of errors) {
      console.log(`    • ${err}`);
    }
    process.exit(1);
  }
}

run();
