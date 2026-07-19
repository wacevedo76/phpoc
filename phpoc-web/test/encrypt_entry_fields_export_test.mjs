/**
 * encrypt_entry_fields_export_test.mjs — Encrypt All Entry Fields: Export (Phase 2 RED)
 *
 * Group H from the Phase 1 blueprint:
 *   docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_WEB_PHASE1.md
 *
 * Tests that export preserves ciphertext (title_enc, etc.) in chain blocks
 * and does not accidentally decrypt encrypted fields in the export file.
 *
 * Usage:
 *   node test/encrypt_entry_fields_export_test.mjs
 */

import { createHash, createHmac } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { LocalCache } from '../src/sync/local_cache.js';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Mock crypto
// ══════════════════════════════════════════════════════════════════════

class MockCrypto {
  constructor() { this._uuidCounter = 0; this._mk = null; }
  sha256(data) { return createHash('sha256').update(data, 'utf-8').digest('hex'); }
  generateUuid() { this._uuidCounter++; return `00000000-0000-0000-0000-${String(this._uuidCounter).padStart(12, '0')}`; }
  setMasterKey(k) { this._mk = k; }
  getMasterKey() { return this._mk; }
  hasMasterKey() { return !!this._mk; }
  hmacHex(keyHex, data) {
    return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(data).digest('hex');
  }
  deriveFieldKey(mkHex) {
    return createHmac('sha256', Buffer.from(mkHex, 'hex'))
      .update('phpoc-staging-keys-v1').digest('hex').slice(0, 32);
  }
  encrypt(plaintext, mk) {
    const key = mk || this._mk || 'no-key';
    return `enc:${key.slice(0, 8)}:${plaintext}`;
  }
  encryptWithCachedKey(plaintext) { return this.encrypt(plaintext); }
  decrypt(ciphertextHex, _mk) {
    if (ciphertextHex && ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4).split(':').slice(1).join(':');
    }
    return null;
  }
  decryptWithCachedKey(c) { return this.decrypt(c); }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

async function getRaw(storage) {
  return (await storage.get('entries')) || [];
}

// ══════════════════════════════════════════════════════════════════════
// Group H: Export — 3 tests
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ Encrypt All Entry Fields — Export Tests (Phase 2 RED) ══\n');
  console.log('Group H: Export preserves ciphertext (3 tests)');
  console.log('Expected: ALL RED — implementation is Phase 3\n');

  const mk = 'ab'.repeat(32);

  // ── H1: Export includes title_enc as hex ciphertext in chain blocks ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    crypto.setMasterKey(mk);
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Export Secret',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    // The raw entry data represents what would go into a chain block.
    // Export should NOT decrypt — ciphertext should survive.
    const raw = await getRaw(storage);
    const data = cache._decodeDataKeys(raw[0].data);

    t.assert(data.title_enc !== undefined,
      'H1a. title_enc exists in raw data');
    t.assert(data.title === undefined,
      'H1b. plaintext title NOT in raw data');

    // The title_enc value is the ciphertext — export should preserve it
    t.assert(typeof data.title_enc === 'string',
      'H1c. title_enc is a string (ciphertext)');

    // Verify it contains the encrypted value (enc: prefix from mock)
    const decrypted = crypto.decryptWithCachedKey(data.title_enc);
    t.assertEq(decrypted, 'Export Secret',
      'H1. export ciphertext decryptable with correct MK (ciphertext survived)');
  }

  // ── H2: Export does NOT decrypt encrypted fields ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    crypto.setMasterKey(mk);
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'NeverLeakThis',
      startEpoch: 1700000000000,
      tags: ['classified'],
      comment: 'do not export in plaintext',
      encrypt_title: true,
      encrypt_tags: true,
      encrypt_comment: true,
    });

    const raw = await getRaw(storage);
    const data = cache._decodeDataKeys(raw[0].data);

    // The raw data that goes into the export should contain _enc fields,
    // NOT plaintext versions
    t.assert(data.title_enc !== undefined, 'H2a. title_enc in export data');
    t.assert(data.tags_enc !== undefined, 'H2b. tags_enc in export data');
    t.assert(data.comment_enc !== undefined, 'H2c. comment_enc in export data');

    // Plaintext versions should be absent
    t.assert(data.title === undefined,
      'H2d. NO plaintext title in export data');
    t.assert(data.tags === undefined,
      'H2e. NO plaintext tags in export data');
    t.assert(data.comment === undefined,
      'H2. NO plaintext comment in export data — no accidental leak');
  }

  // ── H3: Import of exported ledger with title_enc works ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    crypto.setMasterKey(mk);
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Import Roundtrip',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    // Step 1: Read raw (simulating what export would produce)
    const exportedRaw = await getRaw(storage);

    // Step 2: "Import" into a fresh storage (same MK)
    const importStorage = new MemoryBackend();
    await importStorage.set('entries', exportedRaw);

    const importCrypto = new MockCrypto();
    importCrypto.setMasterKey(mk);
    const importCache = new LocalCache(importStorage, importCrypto);

    // Step 3: Read back
    const dtos = await importCache.readEntries();
    t.assertEq(dtos.length, 1, 'H3a. imported entry exists');
    t.assertEq(dtos[0].title, 'Import Roundtrip',
      'H3. import of exported ledger with title_enc works (correct MK)');
  }

  t.summary('Encrypt Entry Fields — Export (Group H)');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
