/**
 * encrypt_entry_fields_staging_test.mjs — Encrypt All Entry Fields: Staging (Phase 2 RED)
 *
 * Groups A (staging write) + B (staging read) from the Phase 1 blueprint:
 *   docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_WEB_PHASE1.md
 *
 * Tests that LocalCache.write_entries() / append() encrypt title, tags,
 * comment, and duration when encryption flags are set, and that
 * read_entries() dual-reads _enc fallback fields.
 *
 * Usage:
 *   node test/encrypt_entry_fields_staging_test.mjs
 */

import { createHash, createHmac } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { LocalCache } from '../src/sync/local_cache.js';

// ══════════════════════════════════════════════════════════════════════
// Mock crypto — same pattern as local_cache_test.mjs
// ══════════════════════════════════════════════════════════════════════

class MockCryptoForCache {
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
    // Random nonce prefix (16 hex chars) simulates real WASM nonce behavior
    const nonce = Array.from({length: 16}, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const combined = `enc:${key.slice(0, 8)}:${plaintext}`;
    return nonce + Buffer.from(combined, 'utf-8').toString('hex');
  }
  encryptWithCachedKey(plaintext) { return this.encrypt(plaintext); }
  decrypt(ciphertextHex) {
    try {
      // Skip 16-char random nonce prefix
      const payload = ciphertextHex.slice(16);
      const decoded = Buffer.from(payload, 'hex').toString('utf-8');
      if (decoded.startsWith('enc:')) {
        const parts = decoded.split(':');
        return parts.slice(2).join(':');
      }
      return null;
    } catch { return null; }
  }
  decryptWithCachedKey(ciphertextHex) { return this.decrypt(ciphertextHex); }
}

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Append an entry with encryption flags via direct raw-data manipulation.
 * Calls cache.append() with encryption flags as extra properties.
 * These flags are part of the future API — they will be consumed by
 * _dtoToRaw() / _encryptTitle() etc. in Phase 3.
 */
async function appendWithEncryption(cache, fields) {
  return cache.append(fields);
}

/** Get raw stored entries from the storage backend. */
async function getRaw(storage) {
  return (await storage.get('entries')) || [];
}

/** Read raw data (decoded keys) from the first stored entry. */
async function getRawData(storage, cache) {
  const raw = await getRaw(storage);
  if (!raw.length) return null;
  // Use the cache to decode tokenized keys
  const rawData = raw[0].data || {};
  return cache._decodeDataKeys(rawData);
}

// ══════════════════════════════════════════════════════════════════════
// Group A: Staging write path — 12 tests
// ══════════════════════════════════════════════════════════════════════

async function groupA() {
  console.log('\n══ Group A: Staging Write Path ══\n');

  // ── A1: title_enc stored when encrypt_title=true ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32)); // Must have MK for real encryption
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Secret Task',
      startEpoch: 1700000000000,
      encrypt_title: true,  // Future API flag
    });

    const data = await getRawData(storage, cache);
    t.assert(data !== null, 'A1a. entry stored');
    t.assert(data.title_enc !== undefined,
      'A1. title_enc stored when encrypt_title=true');
    t.assert(data.title === undefined,
      'A1b. plaintext title absent when encrypt_title=true');
  }

  // ── A2: tags_enc stored when encrypt_tags=true ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Tagged Task',
      startEpoch: 1700000000000,
      tags: ['work', 'important'],
      encrypt_tags: true,  // Future API flag
    });

    const data = await getRawData(storage, cache);
    t.assert(data.tags_enc !== undefined,
      'A2. tags_enc stored when encrypt_tags=true');
    t.assert(data.tags === undefined,
      'A2b. plaintext tags absent when encrypt_tags=true');
  }

  // ── A3: comment_enc stored when encrypt_comment=true ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Commented Task',
      startEpoch: 1700000000000,
      comment: 'Private notes here',
      encrypt_comment: true,  // Future API flag
    });

    const data = await getRawData(storage, cache);
    t.assert(data.comment_enc !== undefined,
      'A3. comment_enc stored when encrypt_comment=true');
    t.assert(data.comment === undefined,
      'A3b. plaintext comment absent when encrypt_comment=true');
  }

  // ── A4: duration_enc stored when encrypt_duration=true ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Duration Task',
      startEpoch: 1700000000000,
      endEpoch: 1700003600000,
      encrypt_duration: true,  // Future API flag
    });

    const data = await getRawData(storage, cache);
    t.assert(data.duration_enc !== undefined,
      'A4. duration_enc stored when encrypt_duration=true');
    t.assert(data.duration === undefined,
      'A4b. plaintext duration absent when encrypt_duration=true');
  }

  // ── A5: plaintext title when encrypt_title=false ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Plain Task',
      startEpoch: 1700000000000,
      encrypt_title: false,  // Future API flag (explicit opt-out)
    });

    const data = await getRawData(storage, cache);
    t.assert(data.title !== undefined,
      'A5. plaintext title stored when encrypt_title=false');
    t.assert(data.title === 'Plain Task',
      'A5b. title value correct');
    t.assert(data.title_enc === undefined,
      'A5c. no title_enc when encrypt_title=false');
  }

  // ── A6: title_enc ciphertext is hex format (salt+nonce+ciphertext+tag) ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Hex Format Task',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    const data = await getRawData(storage, cache);
    t.assert(data.title_enc !== undefined, 'A6a. title_enc exists');
    if (data.title_enc) {
      // Ciphertext must be hex (even-length, only hex chars)
      t.assert(/^[0-9a-f]+$/i.test(data.title_enc),
        'A6. title_enc is hex ciphertext');
      t.assert(data.title_enc.length % 2 === 0,
        'A6b. title_enc is even-length hex');
      // Must NOT be plain: prefix (that's for no-MK fallback)
      t.assert(!data.title_enc.startsWith('plain:'),
        'A6c. title_enc is NOT plain: prefixed (uses real encryption)');
    }
  }

  // ── A7: encrypt_all encrypts all 4 fields ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'All Encrypted',
      startEpoch: 1700000000000,
      endEpoch: 1700003600000,
      tags: ['secret', 'work'],
      comment: 'Very secret',
      encrypt_all: true,  // Future API: master encrypt-everything flag
    });

    const data = await getRawData(storage, cache);
    t.assert(data.title_enc !== undefined,
      'A7a. title_enc stored with encrypt_all');
    t.assert(data.tags_enc !== undefined,
      'A7b. tags_enc stored with encrypt_all');
    t.assert(data.comment_enc !== undefined,
      'A7c. comment_enc stored with encrypt_all');
    t.assert(data.duration_enc !== undefined,
      'A7d. duration_enc stored with encrypt_all');
  }

  // ── A8: is_active and is_paused NOT encrypted ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Structural Task',
      startEpoch: 1700000000000,
      encrypt_all: true,
    });

    const data = await getRawData(storage, cache);
    t.assert(data.is_active !== undefined,
      'A8a. is_active stays plaintext');
    t.assert(data.is_paused !== undefined,
      'A8b. is_paused stays plaintext');
    t.assert(data.is_active_enc === undefined,
      'A8c. no is_active_enc field');
    t.assert(data.is_paused_enc === undefined,
      'A8d. no is_paused_enc field');
  }

  // ── A9: entry hash stable regardless of encryption ──
  {
    const storage1 = new MemoryBackend();
    const crypto1 = new MockCryptoForCache();
    crypto1.setMasterKey('ab'.repeat(32));
    const cache1 = new LocalCache(storage1, crypto1);

    const storage2 = new MemoryBackend();
    const crypto2 = new MockCryptoForCache();
    crypto2.setMasterKey('ab'.repeat(32));
    const cache2 = new LocalCache(storage2, crypto2);

    // Same content, one encrypted, one not
    await cache1.append({
      title: 'Hash Stability',
      startEpoch: 1700000000000,
      endEpoch: 1700003600000,
      tags: ['test'],
      encrypt_title: true,
      encrypt_tags: true,
    });

    await cache2.append({
      title: 'Hash Stability',
      startEpoch: 1700000000000,
      endEpoch: 1700003600000,
      tags: ['test'],
      encrypt_title: false,
      encrypt_tags: false,
    });

    const raw1 = (await getRaw(storage1))[0];
    const raw2 = (await getRaw(storage2))[0];

    t.assertEq(raw1.hash, raw2.hash,
      'A9. entry hash is identical regardless of encryption state');
  }

  // ── A10: different ciphertext each write (random nonce) ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    // Our mock encrypt is deterministic (same input → same output),
    // so this test documents the EXPECTED behavior with real crypto.
    // With the mock, this will FAIL (assertNeq fails because outputs match).
    // This is OK in Phase 2 — the test asserts the contract; Phase 3's real
    // CryptoService (WASM) will satisfy it with random nonces.
    await cache.append({
      title: 'Nonce Test',
      startEpoch: 1000000,
      encrypt_title: true,
    });
    await cache.append({
      title: 'Nonce Test',
      startEpoch: 2000000,
      encrypt_title: true,
    });

    const raw = await getRaw(storage);
    const data1 = cache._decodeDataKeys(raw[0].data);
    const data2 = cache._decodeDataKeys(raw[1].data);

    // With real crypto, these should differ due to random nonces.
    // Our mock encrypt is deterministic, so this test documents the
    // expected real-crypto behavior.
    if (data1.title_enc && data2.title_enc) {
      t.assertNeq(data1.title_enc, data2.title_enc,
        'A10. different ciphertext per write (random nonce)');
    } else {
      t.assert(false, 'A10. title_enc fields exist for nonce test (RED: not yet implemented)');
    }
  }

  // ── A11: empty title with encryption ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: '',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    const data = await getRawData(storage, cache);
    t.assert(data.title_enc !== undefined,
      'A11. empty title encrypted without crashing');
    t.assert(data.title === undefined,
      'A11b. no plaintext title for empty encrypted title');
  }

  // ── A12: null comment with encryption flag ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Null Comment Task',
      startEpoch: 1700000000000,
      comment: null,
      encrypt_comment: true,
    });

    const data = await getRawData(storage, cache);
    // Should either skip encryption for null or encrypt empty string
    // Most important: should not crash
    t.assert(data !== null,
      'A12. null comment with encryption flag does not crash');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group B: Staging read path — 8 tests
// ══════════════════════════════════════════════════════════════════════

async function groupB() {
  console.log('\n══ Group B: Staging Read Path ══\n');

  // ── B1: readEntries() decrypts title_enc → title ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Decrypted Read',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    const dtos = await cache.readEntries();
    t.assertEq(dtos.length, 1, 'B1a. one entry returned');
    t.assertEq(dtos[0].title, 'Decrypted Read',
      'B1. readEntries() decrypts title_enc → title');
  }

  // ── B2: fall back to plaintext title when title_enc absent ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Plain Fallback',
      startEpoch: 1700000000000,
      // No encrypt_title flag → plaintext title only
    });

    const dtos = await cache.readEntries();
    t.assertEq(dtos[0].title, 'Plain Fallback',
      'B2. falls back to plaintext title when title_enc absent');
  }

  // ── B3: readEntries() decrypts tags_enc → JSON.parse → array ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Tags Roundtrip',
      startEpoch: 1700000000000,
      tags: ['work', 'urgent'],
      encrypt_tags: true,
    });

    const dtos = await cache.readEntries();
    t.assert(Array.isArray(dtos[0].tags), 'B3a. tags is array');
    t.assertDeepEq(dtos[0].tags, ['urgent', 'work'],
      'B3. tags roundtrip correctly (sorted)');
  }

  // ── B4: readEntries() decrypts duration_enc → integer ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Duration Roundtrip',
      startEpoch: 1700000000000,
      endEpoch: 1700003600000,
      encrypt_duration: true,
    });

    const dtos = await cache.readEntries();
    t.assert(typeof dtos[0].duration === 'number',
      'B4a. duration is number type');
    t.assertEq(dtos[0].duration, 3600000,
      'B4. duration roundtrip correct');
  }

  // ── B5: corrupt title_enc ciphertext → null/empty ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    // Write a corrupted entry directly to storage
    const rawEntry = {
      hash: 'bad-hash',
      data: {
        entry_id: 'bad-001',
        title_enc: 'this-is-not-valid-hex-and-cannot-be-decrypted',
        startTime_enc: 'plain:1700000000000',
        duration: 0,
        is_active: true,
        is_paused: false,
        pauses_enc: 'plain:[]',
        tags: [],
        media: [],
        device_uuid_enc: 'plain:',
        end_device_uuid_enc: 'plain:',
        metadata_enc: 'plain:{}',
      },
      committed: false,
      block_index: null,
    };
    await storage.set('entries', [rawEntry]);

    const dtos = await cache.readEntries();
    t.assertEq(dtos.length, 1, 'B5a. corrupted entry still returned');
    // Corrupt title_enc should not crash; title should be empty or fallback
    t.assert(typeof dtos[0].title === 'string',
      'B5b. title is a string (not null)');
    // Should not be the corrupt ciphertext directly
    t.assertNeq(dtos[0].title, 'this-is-not-valid-hex-and-cannot-be-decrypted',
      'B5. corrupt title_enc does not leak raw ciphertext');
  }

  // ── B6: partial encryption (some fields encrypted, some not) ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Partial Encrypt',
      startEpoch: 1700000000000,
      tags: ['plain-tag'],
      comment: 'secret comment',
      encrypt_title: true,     // encrypt title
      encrypt_tags: false,     // tags stay plaintext
      encrypt_comment: true,   // encrypt comment
    });

    const dtos = await cache.readEntries();
    t.assertEq(dtos[0].title, 'Partial Encrypt',
      'B6a. encrypted title decrypted');
    t.assertDeepEq(dtos[0].tags, ['plain-tag'],
      'B6b. plaintext tags readable');
    t.assertEq(dtos[0].comment, 'secret comment',
      'B6. encrypted comment decrypted');
  }

  // ── B7: read without crypto returns entries with _enc fields still ciphertext ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'No Crypto Read',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    // Create a new cache WITHOUT master key (simulates no-auth)
    const noAuthCrypto = new MockCryptoForCache();
    const noAuthCache = new LocalCache(storage, noAuthCrypto);

    const dtos = await noAuthCache.readEntries();
    t.assertEq(dtos.length, 1, 'B7a. entry readable without auth');
    // Title should not be revealed — should show [encrypted] or empty
    t.assert(dtos[0].title === '' || dtos[0].title === '[encrypted]',
      'B7. encrypted title not revealed without auth');
  }

  // ── B8: entries marked has_encrypted_fields when _enc fields present ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForCache();
    crypto.setMasterKey('ab'.repeat(32));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Marked Entry',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    const dtos = await cache.readEntries();
    t.assertEq(dtos[0].has_encrypted_fields, true,
      'B8. entry marked has_encrypted_fields=true when title_enc present');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Run all
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ Encrypt All Entry Fields — Staging Tests (Phase 2 RED) ══\n');
  console.log('Groups A+B: Staging write/read (20 tests)');
  console.log('Expected: ALL RED — implementation is Phase 3\n');

  await groupA();
  await groupB();

  t.summary('Encrypt Entry Fields — Staging (Groups A+B)');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
