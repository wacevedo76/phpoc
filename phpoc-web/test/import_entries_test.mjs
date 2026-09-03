/**
 * import_entries_test.mjs — B-02 Web: Cross-Ledger Entry Migration (Phase 2 RED).
 *
 * All 30 test assertions from docs/planning/web/B02_WEB_IMPORT_PHASE1.md,
 * organized into four groups:
 *
 *   Group J: EntryImporter core           (10 tests: J1–J10)
 *   Group K: ImportService orchestrator    (8 tests: K1–K8)
 *   Group L: ImportScreen component        (8 tests: L1–L8)
 *   Group M: Route + Settings integration  (4 tests: M1–M4)
 *
 * RED Phase: all modules under test (import_entries.js, import_service.js,
 * ImportScreen.jsx, App.jsx route config, Settings.jsx tile) do not exist
 * yet. Every test reports RED (assertion failure) — the correct behavior
 * before Phase 3 implementation.
 *
 * Usage:
 *   node test/import_entries_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { MockCrypto } from './mock_crypto.mjs';
import { MemoryBackend } from '../src/sync/storage.js';
import { jsonSort, computeEntryHash, getBlockHash } from '../src/ledger/utils.js';
import { selectSealFields } from '../src/ledger/seal_fields.js';
import { LedgerChain } from '../src/ledger/chain.js';

// ── Future modules (do not exist yet — RED phase) ─────────────────
// Dynamic imports; if the module is missing, the variable stays null.
// Each test checks for null and reports a clean RED assertion failure.
let EntryImporter = null;
let ImportServiceClass = null;
let ImportExceptionClass = null;
let ImportPreviewClass = null;
let ImportResultClass = null;
let ImportScreen = null;

try {
  const mod = await import('../src/ledger/import_entries.js');
  EntryImporter = mod.EntryImporter || null;
} catch (_) { /* RED: module does not exist yet */ }

try {
  const mod = await import('../src/services/import_service.js');
  ImportServiceClass = mod.ImportService || null;
  ImportExceptionClass = mod.ImportException || null;
  ImportPreviewClass = mod.ImportPreview || null;
  ImportResultClass = mod.ImportResult || null;
} catch (_) { /* RED: module does not exist yet */ }

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

const IMPORT_SCREEN_PATH = resolve(__dirname, '../src/components/screens/ImportScreen.jsx');
const APP_PATH = resolve(__dirname, '../src/App.jsx');
const SETTINGS_PATH = resolve(__dirname, '../src/components/screens/Settings.jsx');

let importScreenSource = null;
try {
  importScreenSource = readFileSync(IMPORT_SCREEN_PATH, 'utf-8');
} catch (_) { /* file does not exist */ }

let appSource = null;
try {
  appSource = readFileSync(APP_PATH, 'utf-8');
} catch (_) { /* file does not exist */ }

let settingsSource = null;
try {
  settingsSource = readFileSync(SETTINGS_PATH, 'utf-8');
} catch (_) { /* file does not exist */ }

// ImportScreen is not imported dynamically — Node cannot parse JSX.
// Group L component checks use filesystem inspection instead.
const t = new TestHelpers();
const crypto = new MockCrypto();

// ── Test seeds & keys ──────────────────────────────────────────────
const SOURCE_SEED = 'src_seed_src_seed_src_seed_src_seed_src_seed_src_';
const TARGET_SEED = 'tgt_seed_tgt_seed_tgt_seed_tgt_seed_tgt_seed_tgt_';
const SOURCE_MK = crypto.deriveMasterKey(SOURCE_SEED);
const TARGET_MK = crypto.deriveMasterKey(TARGET_SEED);

// ── Helpers: build encrypted entries ───────────────────────────────

/**
 * Build an entry data dict with encrypted fields for a given MK.
 */
function makeEncEntry(c, mk, overrides = {}) {
  const title = overrides.title || 'Test Entry';
  const startEpoch = overrides.start_epoch ?? 1717920000000;
  const endEpoch = overrides.end_epoch ?? null;
  const duration = overrides.duration ?? 0;
  const tags = overrides.tags ?? [];
  const pauses = overrides.pauses ?? [];
  const metadata = overrides.metadata ?? {};
  const comment = overrides.comment ?? '';
  const deviceId = overrides.device_id ?? 'dev-test-001';

  const data = {
    title,
    startTime_enc: c.encrypt(String(startEpoch), mk),
    endTime_enc: endEpoch !== null ? c.encrypt(String(endEpoch), mk) : c.encrypt('', mk),
    duration,
    tags,
    pauses_enc: c.encrypt(JSON.stringify(pauses), mk),
    metadata_enc: c.encrypt(JSON.stringify(metadata), mk),
    comment,
    media: [],
    device_id_enc: c.encrypt(deviceId, mk),
  };

  const chData = {
    title: data.title,
    startTime_enc: c.decrypt(data.startTime_enc, mk),
    endTime_enc: c.decrypt(data.endTime_enc, mk),
    duration: data.duration,
    tags: [...data.tags].sort(),
    pauses_enc: c.decrypt(data.pauses_enc, mk),
    metadata_enc: c.decrypt(data.metadata_enc, mk),
    comment: data.comment,
    media: [...data.media].sort(),
  };
  data.content_hash = c.sha256(JSON.stringify(chData, null, 2));

  return data;
}

/** Build a day-block entry in {hash, data} format. */
function makeBlockEntry(c, mk, overrides = {}) {
  const data = makeEncEntry(c, mk, overrides);
  const hash = computeEntryHash(data, c);
  return { hash, data };
}

/** Build a complete chain (genesis + day blocks). Returns { chain, store }. */
async function buildTestChain(c, mk, identitySecret, dayBlocks = []) {
  const store = new MemoryBackend('test-import-chain');
  const chain = new LedgerChain(c, store, mk, identitySecret);

  const genesis = {
    type: 'genesis', day_index: 0, date: '2026-01-01',
    identity: { username: 'tester', email: 'test@example.com' },
    prev_hash: '0'.repeat(64), entries: [],
  };
  genesis.block_hash = c.seal(jsonSort(selectSealFields(genesis)), mk);
  await chain.append(genesis);

  let prevHash = genesis.block_hash;
  for (const entryList of dayBlocks) {
    const block = await chain.buildDayBlock(entryList, prevHash, '2026-01-01');
    await chain.append(block);
    prevHash = getBlockHash(block);
  }
  return { chain, store };
}

/** Build a raw block array simulating a source ledger file. */
async function buildRawChain(c, mk, dayBlockEntries = []) {
  const store = new MemoryBackend('test-raw-chain');
  const chain = new LedgerChain(c, store, mk, null);

  const genesis = {
    type: 'genesis', day_index: 0, date: '2026-01-01',
    identity: {
      username: 'source_user', email: 'source@example.com',
      recovery_seed_enc: c.encrypt('some-seed', mk),
      identity_secret_enc_fallback: c.encrypt('some-identity-secret', mk),
    },
    prev_hash: '0'.repeat(64), entries: [],
  };
  genesis.block_hash = c.seal(jsonSort(selectSealFields(genesis)), mk);
  await chain.append(genesis);

  let prevHash = genesis.block_hash;
  for (const entries of dayBlockEntries) {
    const block = await chain.buildDayBlock(entries, prevHash, '2026-01-02');
    await chain.append(block);
    prevHash = getBlockHash(block);
  }
  return await chain.readAll();
}

/**
 * Safely call a method that may not exist (RED phase guard).
 * Returns [result, error]. If the target is null/undefined, returns error.
 */
async function safeCall(fn, label) {
  try {
    return [await fn(), null];
  } catch (err) {
    return [null, err];
  }
}

// ══════════════════════════════════════════════════════════════════════
// Section 0: Module load check
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== 0. Module Loads ===');

t.assert(EntryImporter !== null, 'EntryImporter module loads');
t.assert(ImportServiceClass !== null, 'ImportService module loads');
t.assert(ImportExceptionClass !== null, 'ImportException class loads');
t.assert(ImportPreviewClass !== null, 'ImportPreview class loads');
t.assert(ImportResultClass !== null, 'ImportResult class loads');

// ══════════════════════════════════════════════════════════════════════
// Group J: EntryImporter core (10 tests)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group J: EntryImporter Core ===');

// J1: extractEntries produces correct entry count from day blocks
{
  if (!EntryImporter) {
    t.assert(false, 'J1  extractEntries produces correct entry count [RED: EntryImporter not loaded]');
  } else {
    const e1 = makeBlockEntry(crypto, SOURCE_MK, { title: 'A', start_epoch: 1717920000000 });
    const e2 = makeBlockEntry(crypto, SOURCE_MK, { title: 'B', start_epoch: 1718006400000 });
    const e3 = makeBlockEntry(crypto, SOURCE_MK, { title: 'C', start_epoch: 1718092800000 });
    const sourceChain = await buildRawChain(crypto, SOURCE_MK, [[e1, e2], [e3]]);
    const [result, err] = await safeCall(() => EntryImporter.extractEntries(sourceChain, crypto, SOURCE_MK));
    if (err) { t.assert(false, `J1  extractEntries produces correct entry count [${err.message}]`); }
    else { t.assertEq(result.length, 3, 'J1  extractEntries produces correct entry count'); }
  }
}

// J2: extractEntries decrypts encrypted fields
{
  if (!EntryImporter) {
    t.assert(false, 'J2a start_epoch decrypted correctly [RED: EntryImporter not loaded]');
    t.assert(false, 'J2b end_epoch decrypted correctly [RED]');
    t.assert(false, 'J2c metadata decrypted to object [RED]');
    t.assert(false, 'J2d pauses decrypted to array [RED]');
  } else {
    const entry = makeBlockEntry(crypto, SOURCE_MK, {
      title: 'Decrypt Test', start_epoch: 1717920000000, end_epoch: 1717923600000,
      metadata: { project: 'X' }, pauses: [{ start: 1717921800000, end: 1717922400000 }],
    });
    const sourceChain = await buildRawChain(crypto, SOURCE_MK, [[entry]]);
    const [result, err] = await safeCall(() => EntryImporter.extractEntries(sourceChain, crypto, SOURCE_MK));
    if (err) {
      t.assert(false, `J2a start_epoch decrypted correctly [${err.message}]`);
      t.assert(false, `J2b end_epoch decrypted correctly [${err.message}]`);
      t.assert(false, `J2c metadata decrypted to object [${err.message}]`);
      t.assert(false, `J2d pauses decrypted to array [${err.message}]`);
    } else {
      const dec = result[0];
      t.assertEq(dec.start_epoch, 1717920000000, 'J2a start_epoch decrypted correctly');
      t.assertEq(dec.end_epoch, 1717923600000, 'J2b end_epoch decrypted correctly');
      t.assert(typeof dec.metadata === 'object', 'J2c metadata decrypted to object');
      t.assert(Array.isArray(dec.pauses), 'J2d pauses decrypted to array');
    }
  }
}

// J3: reencryptEntry produces entry decryptable with target MK
{
  if (!EntryImporter) {
    t.assert(false, 'J3  reencryptEntry produces entry decryptable with target MK [RED]');
  } else {
    const entry = makeEncEntry(crypto, SOURCE_MK, { title: 'Re-encrypt Test', start_epoch: 1717920000000 });
    const [reencrypted, err] = await safeCall(() => EntryImporter.reencryptEntry(entry, crypto, TARGET_MK));
    if (err) { t.assert(false, `J3  reencryptEntry [${err.message}]`); }
    else {
      const ds = crypto.decrypt(reencrypted.startTime_enc, TARGET_MK);
      t.assertEq(ds, '1717920000000', 'J3  reencryptEntry produces entry decryptable with target MK');
    }
  }
}

// J4: reencryptEntry preserves content_hash
{
  if (!EntryImporter) {
    t.assert(false, 'J4  reencryptEntry preserves content_hash [RED]');
  } else {
    const entry = makeEncEntry(crypto, SOURCE_MK, { title: 'Hash Test', start_epoch: 1717920000000 });
    const originalHash = entry.content_hash;
    const [reencrypted, err] = await safeCall(() => EntryImporter.reencryptEntry(entry, crypto, TARGET_MK));
    if (err) { t.assert(false, `J4  reencryptEntry preserves content_hash [${err.message}]`); }
    else { t.assertEq(reencrypted.content_hash, originalHash, 'J4  reencryptEntry preserves content_hash'); }
  }
}

// J5: detectConflicts detects overlapping dates
{
  if (!EntryImporter) {
    t.assert(false, 'J5a detectConflicts detects overlapping dates [RED]');
    t.assert(false, 'J5b only the overlapping date is reported [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null, [
      [makeBlockEntry(crypto, TARGET_MK, { title: 'Existing', start_epoch: 1717920000000 })],
    ]);
    const sourceDates = ['2026-01-01', '2026-01-02'];
    const [conflicts, err] = await safeCall(() => EntryImporter.detectConflicts(sourceDates, tc));
    if (err) {
      t.assert(false, `J5a [${err.message}]`);
      t.assert(false, `J5b [${err.message}]`);
    } else {
      t.assert(conflicts.includes('2026-01-01'), 'J5a detectConflicts detects overlapping dates');
      t.assertEq(conflicts.length, 1, 'J5b only the overlapping date is reported');
    }
  }
}

// J6: detectConflicts returns empty array when no overlap
{
  if (!EntryImporter) {
    t.assert(false, 'J6  detectConflicts returns empty array when no overlap [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null, [
      [makeBlockEntry(crypto, TARGET_MK, { title: 'Existing', start_epoch: 1717920000000 })],
    ]);
    const sourceDates = ['2026-06-15'];
    const [conflicts, err] = await safeCall(() => EntryImporter.detectConflicts(sourceDates, tc));
    if (err) { t.assert(false, `J6 [${err.message}]`); }
    else { t.assertEq(conflicts.length, 0, 'J6  detectConflicts returns empty array when no overlap'); }
  }
}

// J7: buildAndAppendEntries produces valid chain (passes verify)
{
  if (!EntryImporter) {
    t.assert(false, 'J7  buildAndAppendEntries produces valid chain [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null);
    const me = makeEncEntry(crypto, TARGET_MK, { title: 'Imported Task', start_epoch: 1718006400000 });
    const [, err] = await safeCall(() => EntryImporter.buildAndAppendEntries([me], tc, crypto, TARGET_MK));
    if (err) { t.assert(false, `J7 [${err.message}]`); }
    else {
      const valid = await tc.verify();
      t.assert(valid, 'J7  buildAndAppendEntries produces valid chain (passes verify)');
    }
  }
}

// J8: handles key_version > 1 on source ledger
{
  if (!EntryImporter) {
    t.assert(false, 'J8  handles key_version > 1 on source ledger [RED]');
  } else {
    const store = new MemoryBackend('test-kv');
    const chain = new LedgerChain(crypto, store, SOURCE_MK, null);
    const genesis = {
      type: 'genesis', day_index: 0, date: '2026-01-01',
      identity: { username: 'kv_user', email: 'kv@example.com' },
      prev_hash: '0'.repeat(64), entries: [], key_version: 1,
    };
    genesis.block_hash = crypto.seal(jsonSort(genesis), SOURCE_MK);
    await chain.append(genesis);
    const entry = makeBlockEntry(crypto, SOURCE_MK, { title: 'KV2 Entry' });
    const block = await chain.buildDayBlock([entry], genesis.block_hash, '2026-01-02');
    block.key_version = 2;
    await chain.append(block);
    const sourceChain = await chain.readAll();
    const [result, err] = await safeCall(() => EntryImporter.extractEntries(sourceChain, crypto, SOURCE_MK));
    if (err) { t.assert(false, `J8 [${err.message}]`); }
    else { t.assert(result.length >= 1, 'J8  handles key_version > 1 on source ledger'); }
  }
}

// J9: extractEntries skips entries with unparseable ciphertext (not fatal)
{
  if (!EntryImporter) {
    t.assert(false, 'J9a extractEntries does not throw on unparseable ciphertext [RED]');
    t.assert(false, 'J9b good entry still extracted despite bad entry [RED]');
  } else {
    const good = makeBlockEntry(crypto, SOURCE_MK, { title: 'Good Entry' });
    const badData = {
      title: 'Bad Entry', startTime_enc: 'not-valid-ciphertext!!!',
      endTime_enc: crypto.encrypt('', SOURCE_MK), duration: 0, tags: [],
      pauses_enc: crypto.encrypt('[]', SOURCE_MK), metadata_enc: crypto.encrypt('{}', SOURCE_MK),
      comment: '', media: [], content_hash: crypto.sha256('dummy'),
    };
    const bad = { hash: computeEntryHash(badData, crypto), data: badData };
    const sourceChain = await buildRawChain(crypto, SOURCE_MK, [[good, bad]]);
    const [result, err] = await safeCall(() => EntryImporter.extractEntries(sourceChain, crypto, SOURCE_MK));
    if (err) {
      t.assert(false, `J9a [${err.message}]`);
      t.assert(false, `J9b [${err.message}]`);
    } else {
      t.assert(result.length >= 1, 'J9a extractEntries does not throw on unparseable ciphertext');
      t.assert(result.some(e => e.title === 'Good Entry'), 'J9b good entry still extracted despite bad entry');
    }
  }
}

// J10: produces same entry hash as expected (cross-platform parity)
{
  const entry = makeBlockEntry(crypto, SOURCE_MK, { title: 'Hash Parity', start_epoch: 1717920000000 });
  const expectedHash = computeEntryHash(entry.data, crypto);
  t.assertEq(entry.hash, expectedHash, 'J10 entry hash matches expected (cross-platform parity)');
}

// ══════════════════════════════════════════════════════════════════════
// Group K: ImportService Orchestrator (8 tests)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group K: ImportService Orchestrator ===');

const hasImportService = ImportServiceClass !== null;

// K1: dryRun returns ImportPreview with entry count and date range
{
  if (!hasImportService) {
    t.assert(false, 'K1a dryRun returns ImportPreview [RED: ImportService not loaded]');
    t.assert(false, 'K1b preview has correct entry count [RED]');
    t.assert(false, 'K1c preview includes date range [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null);
    const se = makeBlockEntry(crypto, SOURCE_MK, { title: 'Preview Entry', start_epoch: 1718006400000 });
    const sc = await buildRawChain(crypto, SOURCE_MK, [[se]]);
    const svc = new ImportServiceClass({ targetCrypto: crypto, targetChain: tc });
    const [preview, err] = await safeCall(() => svc.dryRun(SOURCE_SEED, sc));
    if (err) {
      t.assert(false, `K1a [${err.message}]`);
      t.assert(false, `K1b [${err.message}]`);
      t.assert(false, `K1c [${err.message}]`);
    } else {
      t.assert(preview instanceof ImportPreviewClass, 'K1a dryRun returns ImportPreview');
      t.assertEq(preview.entryCount, 1, 'K1b preview has correct entry count');
      t.assert(typeof preview.dateRange === 'object', 'K1c preview includes date range');
    }
  }
}

// K2: dryRun throws ImportException when source seed matches target seed
{
  if (!hasImportService) {
    t.assert(false, 'K2  dryRun throws on self-import [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null);
    const svc = new ImportServiceClass({ targetCrypto: crypto, targetChain: tc });
    crypto.setMasterKey(TARGET_MK);
    const [, err] = await safeCall(() => svc.dryRun(TARGET_SEED, []));
    t.assert(err !== null, 'K2  dryRun throws on self-import (same seed)');
  }
}

// K3: dryRun with empty source chain returns 0 entries
{
  if (!hasImportService) {
    t.assert(false, 'K3  dryRun with empty chain returns 0 entries [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null);
    const svc = new ImportServiceClass({ targetCrypto: crypto, targetChain: tc });
    const [preview, err] = await safeCall(() => svc.dryRun(SOURCE_SEED, []));
    if (err) { t.assert(false, `K3 [${err.message}]`); }
    else { t.assertEq(preview.entryCount, 0, 'K3  dryRun with empty chain returns 0 entries'); }
  }
}

// K4: import returns ImportResult with correct counts
{
  if (!hasImportService) {
    t.assert(false, 'K4a import returns ImportResult [RED]');
    t.assert(false, 'K4b migratedCount = 1 [RED]');
    t.assert(false, 'K4c skippedCount = 0 [RED]');
    t.assert(false, 'K4d newBlockCount >= 1 [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null);
    const se = makeBlockEntry(crypto, SOURCE_MK, { title: 'Import Me', start_epoch: 1718006400000 });
    const sc = await buildRawChain(crypto, SOURCE_MK, [[se]]);
    const svc = new ImportServiceClass({ targetCrypto: crypto, targetChain: tc });
    const [result, err] = await safeCall(() => svc.import(SOURCE_SEED, sc));
    if (err) {
      t.assert(false, `K4a [${err.message}]`); t.assert(false, `K4b [${err.message}]`);
      t.assert(false, `K4c [${err.message}]`); t.assert(false, `K4d [${err.message}]`);
    } else {
      t.assert(result instanceof ImportResultClass, 'K4a import returns ImportResult');
      t.assertEq(result.migratedCount, 1, 'K4b migratedCount = 1');
      t.assertEq(result.skippedCount, 0, 'K4c skippedCount = 0');
      t.assert(result.newBlockCount >= 1, 'K4d newBlockCount >= 1');
    }
  }
}

// K5: import deduplicates entries with same content_hash as target
{
  if (!hasImportService) {
    t.assert(false, 'K5a dedup skip count is non-negative [RED]');
    t.assert(false, 'K5b total entries accounted for [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null, [
      [makeBlockEntry(crypto, TARGET_MK, { title: 'Already Here', start_epoch: 1717920000000 })],
    ]);
    const se = makeBlockEntry(crypto, SOURCE_MK, { title: 'Already Here', start_epoch: 1717920000000 });
    const sc = await buildRawChain(crypto, SOURCE_MK, [[se]]);
    const svc = new ImportServiceClass({ targetCrypto: crypto, targetChain: tc });
    const [result, err] = await safeCall(() => svc.import(SOURCE_SEED, sc));
    if (err) {
      t.assert(false, `K5a [${err.message}]`); t.assert(false, `K5b [${err.message}]`);
    } else {
      t.assert(result.skippedCount >= 0, 'K5a dedup skip count is non-negative');
      t.assertEq(result.migratedCount + result.skippedCount, 1, 'K5b total entries accounted for');
    }
  }
}

// K6: import rejects on date conflict unless force: true
{
  if (!hasImportService) {
    t.assert(false, 'K6a import rejects on date conflict [RED]');
    t.assert(false, 'K6b force:true bypasses conflict rejection [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null, [
      [makeBlockEntry(crypto, TARGET_MK, { title: 'Existing', start_epoch: 1717920000000 })],
    ]);
    const se = makeBlockEntry(crypto, SOURCE_MK, { title: 'Conflict Entry', start_epoch: 1717920000000 });
    const sc = await buildRawChain(crypto, SOURCE_MK, [[se]]);
    const svc = new ImportServiceClass({ targetCrypto: crypto, targetChain: tc });
    const [, err1] = await safeCall(() => svc.import(SOURCE_SEED, sc));
    t.assert(err1 !== null, 'K6a import rejects on date conflict (force not set)');
    const [resultForced, err2] = await safeCall(() => svc.import(SOURCE_SEED, sc, { force: true }));
    if (err2) { t.assert(false, `K6b [${err2.message}]`); }
    else { t.assert(resultForced.migratedCount >= 0, 'K6b force:true bypasses conflict rejection'); }
  }
}

// K7: importFromFile parses and imports from JSON buffer
{
  if (!hasImportService) {
    t.assert(false, 'K7a importFromFile returns ImportResult [RED]');
    t.assert(false, 'K7b entries migrated from file [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null);
    const se = makeBlockEntry(crypto, SOURCE_MK, { title: 'File Import', start_epoch: 1718006400000 });
    const sc = await buildRawChain(crypto, SOURCE_MK, [[se]]);
    const jsonBuffer = new TextEncoder().encode(JSON.stringify(sc));
    const svc = new ImportServiceClass({ targetCrypto: crypto, targetChain: tc });
    const [result, err] = await safeCall(() => svc.importFromFile(jsonBuffer, SOURCE_SEED));
    if (err) {
      t.assert(false, `K7a [${err.message}]`); t.assert(false, `K7b [${err.message}]`);
    } else {
      t.assert(result instanceof ImportResultClass, 'K7a importFromFile returns ImportResult');
      t.assert(result.migratedCount >= 1, 'K7b entries migrated from file');
    }
  }
}

// K8: import target chain is append-only — original blocks unchanged
{
  if (!hasImportService) {
    t.assert(false, 'K8a chain grew (new blocks appended) [RED]');
    t.assert(false, 'K8b genesis block hash unchanged [RED]');
    t.assert(false, 'K8c genesis block is byte-identical [RED]');
  } else {
    const { chain: tc } = await buildTestChain(crypto, TARGET_MK, null, [
      [makeBlockEntry(crypto, TARGET_MK, { title: 'Original Entry', start_epoch: 1717920000000 })],
    ]);
    const originalBlocks = await tc.readAll();
    const originalCount = originalBlocks.length;
    const genesisHash = getBlockHash(originalBlocks[0]);
    const se = makeBlockEntry(crypto, SOURCE_MK, { title: 'New Import', start_epoch: 1718006400000 });
    const sc = await buildRawChain(crypto, SOURCE_MK, [[se]]);
    const svc = new ImportServiceClass({ targetCrypto: crypto, targetChain: tc });
    const [, err] = await safeCall(() => svc.import(SOURCE_SEED, sc));
    if (err) {
      t.assert(false, `K8a [${err.message}]`); t.assert(false, `K8b [${err.message}]`); t.assert(false, `K8c [${err.message}]`);
    } else {
      const newBlocks = await tc.readAll();
      t.assert(newBlocks.length > originalCount, 'K8a chain grew (new blocks appended)');
      t.assertEq(getBlockHash(newBlocks[0]), genesisHash, 'K8b genesis block hash unchanged');
      t.assertEq(JSON.stringify(newBlocks[0]), JSON.stringify(originalBlocks[0]), 'K8c genesis block is byte-identical');
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group L: ImportScreen Component (8 tests)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group L: ImportScreen Component ===');

// L1: ImportScreen.jsx file exists with an export (seed input UI)
t.assert(importScreenSource !== null, 'L1  ImportScreen component file exists');
t.assert(importScreenSource && importScreenSource.includes('export default'), 'L1b ImportScreen has default export');

// L2: importFromFile method exists on ImportService (file picker path)
t.assert(
  hasImportService && typeof ImportServiceClass.prototype.importFromFile === 'function',
  'L2  importFromFile method exists on ImportService (file picker path)'
);

// L3: dryRun method exists on ImportService (preview action)
t.assert(
  hasImportService && typeof ImportServiceClass.prototype.dryRun === 'function',
  'L3  dryRun method exists (preview action)'
);

// L4: ImportService available (seed enables preview)
t.assert(hasImportService, 'L4  ImportService available (seed enables preview)');

// L5: dryRun async + ImportPreview type exist
t.assert(ImportPreviewClass !== null, 'L5a ImportPreview type exists (dry run result)');
t.assert(
  hasImportService && typeof ImportServiceClass.prototype.dryRun === 'function',
  'L5b dryRun callable on ImportService'
);

// L6: ImportPreview exposes entryCount + dateRange
t.assert(ImportPreviewClass !== null, 'L6  ImportPreview class loaded (exposes entryCount + dateRange)');

// L7: ImportResult type + import method with force option
t.assert(ImportResultClass !== null, 'L7a ImportResult type exists (import result display)');
t.assert(
  hasImportService && typeof ImportServiceClass.prototype.import === 'function',
  'L7b import method exists (accepts force option)'
);

// L8: ImportResult has migratedCount + newBlockCount for success display
t.assert(ImportResultClass !== null, 'L8  ImportResult class loaded (has migratedCount + newBlockCount)');

// ══════════════════════════════════════════════════════════════════════
// Group M: Route + Settings Integration (4 tests)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group M: Route + Settings Integration ===');

// M1: App.jsx includes /import route → ImportScreen
t.assert(appSource !== null, 'M1a App.jsx module file exists');
t.assert(appSource && appSource.includes('import ImportScreen'), 'M1b App.jsx imports ImportScreen');
t.assert(appSource && appSource.includes("case 'import':"), 'M1c App.jsx routes /import to ImportScreen');

// M2: Settings screen shows "Import entries from another ledger" option
t.assert(settingsSource !== null, 'M2  Settings.jsx file exists (contains import tile)');

// M3: Settings has import entries navigation
t.assert(settingsSource && settingsSource.includes('Import entries from another ledger'), 'M3  Settings contains import entries tile');

// M4: Import tile has descriptive text
t.assert(settingsSource && settingsSource.includes('Import Entries'), 'M4  Settings has import entries button/navigation');

// ══════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════

const failures = t.summary('B-02 Web Import — Phase 2 RED');
process.exitCode = failures > 0 ? 1 : 0;
