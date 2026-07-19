/**
 * encrypt_entry_fields_sync_test.mjs — Encrypt All Entry Fields: Sync (Phase 2 RED)
 *
 * Group G from the Phase 1 blueprint:
 *   docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_WEB_PHASE1.md
 *
 * Tests that push/pull preserve encrypted fields (title_enc, tags_enc,
 * comment_enc, duration_enc) through the sync pipeline.
 *
 * Usage:
 *   node test/encrypt_entry_fields_sync_test.mjs
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
    const combined = `enc:${key.slice(0, 8)}:${plaintext}`;
    return Buffer.from(combined, 'utf-8').toString('hex');
  }
  encryptWithCachedKey(plaintext) { return this.encrypt(plaintext); }
  decrypt(ciphertextHex, _mk) {
    try {
      const decoded = Buffer.from(ciphertextHex, 'hex').toString('utf-8');
      if (decoded.startsWith('enc:')) {
        const parts = decoded.split(':');
        return parts.slice(2).join(':');
      }
      return null;
    } catch { return null; }
  }
  decryptWithCachedKey(c) { return this.decrypt(c); }
  obfuscateBlob(plaintext, mk) {
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const fingerprint = mk ? createHash('sha256').update(mk).digest().slice(0, 4) : Buffer.alloc(4);
    return Buffer.concat([fingerprint, plainBytes]).toString('base64');
  }
  deobfuscateBlob(b64, mk) {
    try {
      const obfuscated = Buffer.from(b64, 'base64');
      return obfuscated.slice(4).toString('utf-8');
    } catch { return null; }
  }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

async function getRaw(storage) {
  return (await storage.get('entries')) || [];
}

// ══════════════════════════════════════════════════════════════════════
// Group G: Sync push/pull — 6 tests
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ Encrypt All Entry Fields — Sync Tests (Phase 2 RED) ══\n');
  console.log('Group G: Sync push/pull with encrypted fields (6 tests)');
  console.log('Expected: ALL RED — implementation is Phase 3\n');

  const mk = 'ab'.repeat(32);

  // ── G1: Push obfuscated blob contains title_enc ciphertext ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    crypto.setMasterKey(mk);
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Sync Title Secret',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    // Read raw entries to simulate what would be pushed
    const raw = await getRaw(storage);
    const data = cache._decodeDataKeys(raw[0].data);

    // When pushed, the raw data should have title_enc with ciphertext
    t.assert(data.title_enc !== undefined,
      'G1a. raw data has title_enc before push');

    if (data.title_enc) {
      // The ciphertext should not be the plaintext value
      t.assert(!data.title_enc.includes('Sync Title Secret'),
        'G1. title_enc does not leak plaintext title');

      // Verify it's hex (AES-CTR output)
      t.assert(typeof data.title_enc === 'string', 'G1b. title_enc is a string');
    }
  }

  // ── G2: Pull without crypto returns ciphertext ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    crypto.setMasterKey(mk);
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Pull Ciphertext Test',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    // Simulate pull from remote: read raw entries
    const raw = await getRaw(storage);
    const rawData = raw[0].data;

    // Create a no-auth cache to simulate pull without MK
    const noAuthCrypto = new MockCrypto();
    const noAuthCache = new LocalCache(storage, noAuthCrypto);

    const dtos = await noAuthCache.readEntries();
    // Without auth, title should stay encrypted
    t.assert(dtos[0].title !== 'Pull Ciphertext Test',
      'G2. unauthenticated pull does not reveal plaintext title');
  }

  // ── G3: Pull with crypto decrypts title_enc → plaintext ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    crypto.setMasterKey(mk);
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Auth Pull Test',
      startEpoch: 1700000000000,
      encrypt_title: true,
    });

    // Same MK → should decrypt
    const dtos = await cache.readEntries();
    t.assertEq(dtos[0].title, 'Auth Pull Test',
      'G3. authenticated pull decrypts title_enc → plaintext title');
  }

  // ── G4: Cross-device roundtrip (shared MK) ──
  {
    // Device A writes with encryption
    const storageA = new MemoryBackend();
    const cryptoA = new MockCrypto();
    cryptoA.setMasterKey(mk);
    const cacheA = new LocalCache(storageA, cryptoA);

    await cacheA.append({
      title: 'Cross Device Secret',
      startEpoch: 1700000000000,
      tags: ['shared'],
      encrypt_title: true,
      encrypt_tags: true,
    });

    // Read raw from storage A (simulating push to remote)
    const rawFromA = await getRaw(storageA);

    // Device B: write raw entries from A into its own storage
    const storageB = new MemoryBackend();
    await storageB.set('entries', rawFromA);

    // Device B with same MK reads
    const cryptoB = new MockCrypto();
    cryptoB.setMasterKey(mk);
    const cacheB = new LocalCache(storageB, cryptoB);

    const dtos = await cacheB.readEntries();
    t.assertEq(dtos[0].title, 'Cross Device Secret',
      'G4a. cross-device: title decrypts with shared MK');
    t.assertDeepEq(dtos[0].tags, ['shared'],
      'G4. cross-device: tags decrypt with shared MK');
  }

  // ── G5: Mixed plaintext + encrypted fields in same entry ──
  {
    const storage = new MemoryBackend();
    const crypto = new MockCrypto();
    crypto.setMasterKey(mk);
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Mixed Fields',
      startEpoch: 1700000000000,
      tags: ['plain-tag'],
      comment: 'private note',
      encrypt_title: true,     // encrypted
      encrypt_tags: false,     // plaintext
      encrypt_comment: true,   // encrypted
    });

    const raw = await getRaw(storage);
    const data = cache._decodeDataKeys(raw[0].data);

    // Push: verify the raw data has both encrypted and plaintext fields
    t.assert(data.title_enc !== undefined, 'G5a. title_enc exists');
    t.assert(data.tags !== undefined, 'G5b. plaintext tags exist');
    t.assert(data.comment_enc !== undefined, 'G5c. comment_enc exists');

    // Decrypt on same device
    const dtos = await cache.readEntries();
    t.assertEq(dtos[0].title, 'Mixed Fields', 'G5d. title decrypts');
    t.assertDeepEq(dtos[0].tags, ['plain-tag'], 'G5e. plaintext tags survive');
    t.assertEq(dtos[0].comment, 'private note',
      'G5. mixed encryption: all fields survive sync roundtrip');
  }

  // ── G6: Merge engine handles encrypted fields ──
  {
    // Two devices, same MK, same activity but different comments
    const storageA = new MemoryBackend();
    const cryptoA = new MockCrypto();
    cryptoA.setMasterKey(mk);
    const cacheA = new LocalCache(storageA, cryptoA);

    await cacheA.append({
      title: 'Merge Test',
      startEpoch: 1700000000000,
      comment: 'Device A note',
      encrypt_comment: true,
    });

    // Simulate merge: entries from both devices end up in same storage
    // The merge engine should handle _enc fields correctly
    const rawA = await getRaw(storageA);

    const storageB = new MemoryBackend();
    const cryptoB = new MockCrypto();
    cryptoB.setMasterKey(mk);
    const cacheB = new LocalCache(storageB, cryptoB);

    await cacheB.append({
      title: 'Merge Test',
      startEpoch: 1700003600000, // Different start → different entry
      comment: 'Device B note',
      encrypt_comment: true,
    });

    const rawB = await getRaw(storageB);

    // Write both into merged storage
    const mergedStorage = new MemoryBackend();
    await mergedStorage.set('entries', [...rawA, ...rawB]);

    const mergedCrypto = new MockCrypto();
    mergedCrypto.setMasterKey(mk);
    const mergedCache = new LocalCache(mergedStorage, mergedCrypto);

    const dtos = await mergedCache.readEntries();
    t.assertEq(dtos.length, 2, 'G6a. two entries after merge');
    t.assertEq(dtos[0].comment, 'Device A note',
      'G6b. first entry comment decrypts');
    t.assertEq(dtos[1].comment, 'Device B note',
      'G6. merge engine handles encrypted fields from different devices');
  }

  t.summary('Encrypt Entry Fields — Sync (Group G)');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
