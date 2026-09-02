/**
 * commonplace_settings_service_test.mjs — Commonplace backup/restore service
 * tests (Slice 4) — Group B (B1–B3) from
 * docs/planning/COMMONPLACE_BOOK_SETTINGS_WEB_PHASE1.md. Phase 2 (RED).
 *
 * Pure Node tests on the MockCrypto + MemoryBackend + TestHelpers harness
 * (mirrors commonplace_service_test.mjs). Targets the FUTURE
 * `CommonplaceService.exportForBackup()` / `restoreFromBackup(json)` API
 * (wrapping `CommonplaceStorage`) — those methods do not exist yet, so every
 * test is RED.
 *
 * Contract (drives Phase 3):
 *   - `exportForBackup()` → `string` (the sealed `commonplace.json` content):
 *     JSON.stringify of the `CommonplaceStorage` export shape
 *     `{type:'commonplace_chain', genesis, blocks}`.
 *   - `restoreFromBackup(json)` → replaces `commonplace:blocks` from the string.
 *
 * Run: node test/commonplace_settings_service_test.mjs
 */

import { MemoryBackend } from '../src/sync/storage.js';
import { MockCrypto } from './mock_crypto.mjs';
import { TestHelpers } from './test_helpers.mjs';
import { createCommonplaceService } from '../src/commonplace/commonplace_service.js';

const t = new TestHelpers();

const MASTER_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const IDENTITY_SECRET = 'identity-secret-32-bytes-xxxxxx';

const GENESIS_OPTS = {
  username: 'testuser',
  email: 'test@example.com',
  recoverySeedEnc: 'encrypted-seed',
  identityPubKey: 'pub-key-hex',
  identitySecretEncFallback: 'fallback-hex',
};

function makeService() {
  const store = new MemoryBackend();
  const crypto = new MockCrypto();
  crypto.setMasterKey(MASTER_KEY);
  const service = createCommonplaceService({
    crypto,
    store,
    masterKey: MASTER_KEY,
    identitySecret: IDENTITY_SECRET,
  });
  service.__store = store;
  service.__crypto = crypto;
  return service;
}

async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    t.assert(false, `${name} — ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Group B: Backup / Restore Commonplace (B1–B3)
// ═══════════════════════════════════════════════════════════════════

await test('B1: exportForBackup() returns the sealed commonplace.json content as a string', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'Note', entry: 'passage', tags: ['t'] });

  const json = await service.exportForBackup();
  t.assert(typeof json === 'string', 'B1: returns a string');
  t.assert(json.length > 0, 'B1: non-empty string');
  // It parses to the sealed export shape (no plaintext title/entry leaked).
  const parsed = JSON.parse(json);
  t.assertEq(parsed.type, 'commonplace_chain', 'B1: type is commonplace_chain');
});

await test('B2: the exported backup is a valid {type, genesis, blocks} object that round-trips', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'Alpha', entry: 'first passage', tags: ['a'] });
  await service.addEntry({ title: 'Beta', entry: 'second passage', tags: ['b'] });

  const parsed = JSON.parse(await service.exportForBackup());
  t.assertEq(parsed.type, 'commonplace_chain', 'B2: type');
  t.assert(parsed.genesis && parsed.genesis.type === 'commonplace_genesis', 'B2: genesis present');
  t.assert(Array.isArray(parsed.blocks), 'B2: blocks array present');
  t.assert(parsed.blocks.length >= 2, 'B2: genesis + day block(s) in blocks');

  // Round-trip: restoring the export leaves the chain intact and verifiable.
  await service.restoreFromBackup(JSON.stringify(parsed));
  t.assert(await service.verify(), 'B2: chain verifies after round-trip');
  t.assertEq(await service.getEntryCount(), 2, 'B2: both entries survive round-trip');
});

await test('B3: restoreFromBackup(json) replaces the Commonplace chain from a backup string', async () => {
  const service = makeService();
  await service.ensureGenesis(GENESIS_OPTS);
  await service.addEntry({ title: 'One', entry: 'p1', tags: [] });
  const backup = await service.exportForBackup(); // snapshot with exactly 1 entry

  // Grow the chain past the snapshot.
  await service.addEntry({ title: 'Two', entry: 'p2', tags: [] });
  t.assertEq(await service.getEntryCount(), 2, 'B3: two entries before restore');

  // Restore the snapshot — the chain is REPLACED, not merged.
  await service.restoreFromBackup(backup);
  t.assertEq(await service.getEntryCount(), 1, 'B3: chain replaced (1 entry)');
  const [entry] = await service.readEntries();
  t.assertEq(entry.title, 'One', 'B3: restored entry is the snapshot entry');
  t.assert(await service.verify(), 'B3: restored chain verifies');
});

// ── Summary ─────────────────────────────────────────────────────────
t.summary('CommonplaceSettingsService');
process.exit(t.failed > 0 ? 1 : 0);
