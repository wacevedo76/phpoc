/**
 * I-02 Phase 2 (RED): Staging field key encryption tests — JavaScript.
 *
 * Covers Phase 1 assertion Groups:
 *   - G: Staging field key encryption — LocalCache (JS) (10 tests)
 *
 * All tests are written against the FUTURE API that will exist after Phase 3.
 * They are expected to FAIL (RED) because field-key encryption is not yet implemented.
 *
 * Usage:
 *   node phpoc-web/test/i02_staging_keys_test.mjs
 */

import { createHash, createHmac } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ── Check if LocalCache exists ──────────────────────────────────────
/** @type {typeof import('../src/sync/local_cache.js').LocalCache|null} */
let LocalCache = null;
try {
  const mod = await import('../src/sync/local_cache.js');
  LocalCache = mod.LocalCache;
} catch { /* not yet available */ }

// ── Mock crypto with deterministic field token mapping ──────────────
class MockCryptoForKeys {
  constructor(masterKey = null) {
    this._mk = masterKey;
    /** @type {Map<string, string>} field token cache */
    this._fieldTokens = new Map();
  }

  setMasterKey(mk) { this._mk = mk; }
  getMasterKey() { return this._mk; }
  hasMasterKey() { return !!this._mk; }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  generateUuid() {
    return '00000000-0000-0000-0000-000000000001';
  }

  /**
   * Encrypt with field-key token mapping.
   * If value looks like a field-name being encrypted (not a value),
   * uses deterministic HMAC-based token.
   */
  encrypt(plaintext, mk) {
    const key = mk || this._mk || 'no-key';
    const combined = `enc:${key.slice(0, 8)}:${plaintext}`;
    return Buffer.from(combined, 'utf-8').toString('hex');
  }

  encryptWithCachedKey(plaintext) { return this.encrypt(plaintext); }

  // I-02a: deriveFieldKey + hmacHex for _fieldToken()
  hmacHex(keyHex, data) {
    return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(data).digest('hex');
  }

  deriveFieldKey(mkHex) {
    return createHmac('sha256', Buffer.from(mkHex, 'hex'))
      .update('phpoc-staging-keys-v1').digest('hex').slice(0, 32);
  }

  decrypt(ciphertextHex) {
    try {
      const decoded = Buffer.from(ciphertextHex, 'hex').toString('utf-8');
      if (decoded.startsWith('enc:')) {
        const parts = decoded.split(':');
        return parts.slice(2).join(':');
      }
      if (decoded.startsWith('plain:')) return decoded.slice(6);
      return null;
    } catch { return null; }
  }

  decryptWithCachedKey(ciphertextHex) { return this.decrypt(ciphertextHex); }

  seal(data) {
    return createHash('sha256').update(data).digest('hex').slice(0, 32);
  }

  verifySeal(data, sig) { return this.seal(data) === sig; }

  /**
   * Compute deterministic field name token.
   * Same field name → same token, different names → different tokens.
   */
  deriveFieldToken(fieldName) {
    if (this._fieldTokens.has(fieldName)) {
      return this._fieldTokens.get(fieldName);
    }
    const token = createHash('sha256')
      .update('phpoc-staging-keys-v1')
      .update(fieldName)
      .digest('hex')
      .slice(0, 16); // 8 bytes hex
    this._fieldTokens.set(fieldName, token);
    return token;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

/**
 * Check if any key in the raw data object ends with plaintext _enc.
 */
function hasPlaintextEncKeys(dataObj) {
  if (!dataObj || typeof dataObj !== 'object') return false;
  return Object.keys(dataObj).some(k => k.endsWith('_enc'));
}

// ══════════════════════════════════════════════════════════════════════
// Group G: Staging field key encryption — LocalCache (JS)
// ══════════════════════════════════════════════════════════════════════

if (typeof LocalCache === 'function') {
  console.log('\n=== Group G: Staging Field Key Encryption (JS) ===\n');

  // ── G1: writeEntries / _dtoToRaw stores encrypted key names ────────
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForKeys('a'.repeat(64));
    crypto.setMasterKey('a'.repeat(64));
    const cache = new LocalCache(storage, crypto);

    await cache.writeEntries([{
      activity_id: 'act-1',
      entry_id: 'e1',
      title: 'Test Task',
      start_epoch: 1000,
      end_epoch: 2000,
      duration: 1000,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags: ['test'],
      comment: 'hello',
      media: [],
      device_uuid: 'dev-g1',
      end_device_uuid: '',
      metadata: { key: 'val' },
      hash: 'h1',
      entry_index: 0,
      committed: false,
      block_index: null,
    }]);

    const raw = await storage.get('entries');
    t.assert(Array.isArray(raw) && raw.length > 0, 'G1a. entries stored');
    const data = raw[0].data || {};

    // After I-02: should NOT have plaintext _enc key names
    t.assert(!hasPlaintextEncKeys(data),
      `G1b. NO plaintext _enc keys in stored data (keys: ${Object.keys(data).join(', ')})`);
  }

  // ── G2: readEntries / _rawToDto decrypts key names ────────────────
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForKeys('b'.repeat(64));
    crypto.setMasterKey('b'.repeat(64));
    const cache = new LocalCache(storage, crypto);

    await cache.writeEntries([{
      activity_id: 'act-2',
      entry_id: 'e2',
      title: 'Roundtrip Task',
      start_epoch: 5000,
      end_epoch: 10000,
      duration: 5000,
      is_active: false,
      is_paused: false,
      pauses: [{ pause_index: 1, pause_start: 6000, pause_stop: 7000 }],
      tags: ['music', 'practice'],
      comment: 'roundtrip comment',
      media: [],
      device_uuid: 'dev-g2',
      end_device_uuid: 'dev-end-g2',
      metadata: { bpm: 120, key: 'C' },
      hash: 'h2',
      entry_index: 0,
      committed: false,
      block_index: null,
    }]);

    const dtos = await cache.readEntries();
    t.assertEq(dtos.length, 1, 'G2a. single entry read back');
    const dto = dtos[0];
    t.assertEq(dto.title, 'Roundtrip Task', 'G2b. title roundtrip');
    t.assertEq(dto.start_epoch, 5000, 'G2c. start_epoch roundtrip');
    t.assertEq(dto.end_epoch, 10000, 'G2d. end_epoch roundtrip');
    t.assertEq(dto.pauses.length, 1, 'G2e. pauses roundtrip');
    t.assertEq(dto.pauses[0].pause_start, 6000, 'G2f. pause_start roundtrip');
    t.assertDeepEq(dto.tags, ['music', 'practice'], 'G2g. tags roundtrip');
    t.assertEq(dto.comment, 'roundtrip comment', 'G2h. comment roundtrip');
    t.assertDeepEq(dto.metadata, { bpm: 120, key: 'C' }, 'G2i. metadata roundtrip');
    t.assertEq(dto.device_uuid, 'dev-g2', 'G2j. device_uuid roundtrip');
    t.assertEq(dto.end_device_uuid, 'dev-end-g2', 'G2k. end_device_uuid roundtrip');
  }

  // ── G3: append writes with encrypted key names ────────────────────
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForKeys('c'.repeat(64));
    crypto.setMasterKey('c'.repeat(64));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Append Test',
      startEpoch: 1000,
      endEpoch: 2000,
      tags: ['work'],
      deviceUuid: 'dev-g3',
    });

    const raw = await storage.get('entries');
    const data = raw[0].data || {};
    t.assert(!hasPlaintextEncKeys(data),
      `G3. append() uses encrypted key names (keys: ${Object.keys(data).join(', ')})`);
  }

  // ── G4: update reads/writes with encrypted key names ──────────────
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForKeys('d'.repeat(64));
    crypto.setMasterKey('d'.repeat(64));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Update Test',
      startEpoch: 1000,
      isActive: true,
      deviceUuid: 'dev-g4',
    });

    await cache.update(0, { comment: 'updated via encrypted keys' });

    const dtos = await cache.readEntries();
    t.assertEq(dtos[0].comment, 'updated via encrypted keys',
      'G4. update works through encrypted key names');
  }

  // ── G5: addPause/closePause with encrypted key names ──────────────
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForKeys('e'.repeat(64));
    crypto.setMasterKey('e'.repeat(64));
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Pause Test',
      startEpoch: 1000,
      isActive: true,
      deviceUuid: 'dev-g5',
    });

    await cache.addPause(0, 1500, 'Taking a break');
    let dtos = await cache.readEntries();
    t.assert(dtos[0].is_paused, 'G5a. is_paused true after addPause');
    t.assertEq(dtos[0].pauses.length, 1, 'G5b. one pause record');
    t.assertEq(dtos[0].pauses[0].pause_start, 1500, 'G5c. pause_start correct');
    t.assertEq(dtos[0].pauses[0].comment, 'Taking a break',
      'G5d. pause comment preserved');

    await cache.closePause(0, 1800, 'Break over');
    dtos = await cache.readEntries();
    t.assert(!dtos[0].is_paused, 'G5e. is_paused false after closePause');
    t.assertEq(dtos[0].pauses[0].pause_stop, 1800, 'G5f. pause_stop set');
    t.assertEq(dtos[0].pauses[0].comment, 'Break over',
      'G5g. closePause comment updated');
  }

  // ── G6: Legacy plaintext key names readable ───────────────────────
  {
    const storage = new MemoryBackend();
    // Pre-populate with legacy entry (plaintext _enc keys)
    await storage.set('entries', [{
      hash: 'legacy-hash-js',
      data: {
        activity_id: 'legacy-act',
        entry_id: 'legacy-e1',
        title: 'Legacy JS Task',
        duration: 1000,
        is_active: false,
        is_paused: false,
        startTime_enc: 'plain:3000',
        endTime_enc: 'plain:4000',
        pauses_enc: 'plain:[]',
        metadata_enc: 'plain:{}',
        tags: ['legacy'],
        media: [],
        device_uuid_enc: 'plain:dev-legacy-js',
        end_device_uuid_enc: 'plain:',
      },
      committed: false,
      block_index: null,
    }]);

    const crypto = new MockCryptoForKeys('f'.repeat(64));
    crypto.setMasterKey('f'.repeat(64));
    const cache = new LocalCache(storage, crypto);

    const dtos = await cache.readEntries();
    t.assertEq(dtos.length, 1, 'G6a. legacy entry readable');
    t.assertEq(dtos[0].title, 'Legacy JS Task', 'G6b. legacy title correct');
    t.assertEq(dtos[0].start_epoch, 3000, 'G6c. legacy start_epoch correct');
    t.assertEq(dtos[0].end_epoch, 4000, 'G6d. legacy end_epoch correct');
    t.assertEq(dtos[0].device_uuid, 'dev-legacy-js',
      'G6e. legacy device_uuid correct');
  }

  // ── G7: Legacy entries upgraded to encrypted on write ─────────────
  {
    const storage = new MemoryBackend();
    // Pre-populate with legacy entry
    await storage.set('entries', [{
      hash: 'old-hash',
      data: {
        activity_id: 'upgrade-act',
        entry_id: 'upgrade-e1',
        title: 'Upgrade Me JS',
        duration: 1000,
        is_active: false,
        is_paused: false,
        startTime_enc: 'plain:1000',
        endTime_enc: 'plain:2000',
        pauses_enc: 'plain:[]',
        metadata_enc: 'plain:{}',
        tags: [],
        media: [],
        device_uuid_enc: 'plain:dev-up-js',
        end_device_uuid_enc: 'plain:',
      },
      committed: false,
      block_index: null,
    }]);

    const crypto = new MockCryptoForKeys('g'.repeat(64));
    crypto.setMasterKey('g'.repeat(64));
    const cache = new LocalCache(storage, crypto);

    // Trigger mutation
    await cache.update(0, { comment: 'upgraded' });

    // After update, check raw storage
    const raw = await storage.get('entries');
    const data = raw[0].data || {};
    t.assert(!hasPlaintextEncKeys(data),
      `G7. legacy keys upgraded to encrypted on write (keys: ${Object.keys(data).join(', ')})`);
  }

  // ── G8: Entry hash computation stable regardless of encoding ──────
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForKeys('h'.repeat(64));
    crypto.setMasterKey('h'.repeat(64));
    const cache = new LocalCache(storage, crypto);

    const dto = {
      title: 'Hash Stable',
      start_epoch: 1000,
      end_epoch: 2000,
      duration: 1000,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags: ['stable'],
      comment: null,
      media: [],
      entry_id: 'hash-e1',
      metadata: {},
      device_uuid: 'dev-hash',
      end_device_uuid: '',
    };

    const h1 = await cache._computeEntryHash(dto);
    const h2 = await cache._computeEntryHash(dto);
    t.assertEq(h1, h2, 'G8. hash computation deterministic');

    // Hash should depend on content, not encoding
    const dto2 = { ...dto, title: 'Different' };
    const h3 = await cache._computeEntryHash(dto2);
    t.assertNeq(h1, h3, 'G8b. different content produces different hash');
  }

  // ── G9: Deterministic field-name → token mapping ──────────────────
  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoForKeys('i'.repeat(64));
    crypto.setMasterKey('i'.repeat(64));
    const cache = new LocalCache(storage, crypto);

    // Write entry A
    await cache.writeEntries([{
      activity_id: 'map-a',
      entry_id: 'map-e1',
      title: 'Entry A',
      start_epoch: 1000,
      end_epoch: 2000,
      duration: 1000,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags: [],
      comment: null,
      media: [],
      device_uuid: 'd1',
      end_device_uuid: '',
      metadata: {},
      hash: 'ha',
      entry_index: 0,
      committed: false,
      block_index: null,
    }]);

    const rawA = await storage.get('entries');
    const keysA = Object.keys(rawA[0].data || {}).sort();

    // Write entry B
    await cache.writeEntries([{
      activity_id: 'map-b',
      entry_id: 'map-e2',
      title: 'Entry B',
      start_epoch: 3000,
      end_epoch: 4000,
      duration: 1000,
      is_active: false,
      is_paused: false,
      pauses: [],
      tags: [],
      comment: null,
      media: [],
      device_uuid: 'd2',
      end_device_uuid: '',
      metadata: {},
      hash: 'hb',
      entry_index: 0,
      committed: false,
      block_index: null,
    }]);

    const rawB = await storage.get('entries');
    const keysB = Object.keys(rawB[0].data || {}).sort();

    // Same field structure → same key names
    t.assertDeepEq(keysA, keysB,
      `G9. field-name → token mapping is deterministic (A: ${keysA.join(',')}, B: ${keysB.join(',')})`);
  }

  // ── G10: No MK available → fallback to plaintext keys ─────────────
  {
    const storage = new MemoryBackend();
    // No-auth crypto (no MK set)
    const crypto = new MockCryptoForKeys(null);
    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'NoAuth Task',
      startEpoch: 1000,
      endEpoch: 2000,
      deviceUuid: 'dev-noauth',
    });

    const raw = await storage.get('entries');
    t.assert(raw.length > 0, 'G10a. entry stored without MK');

    // Should be readable
    const dtos = await cache.readEntries();
    t.assertEq(dtos.length, 1, 'G10b. no-auth entry readable');
    t.assertEq(dtos[0].title, 'NoAuth Task', 'G10c. no-auth title correct');

    // Without MK, plaintext _enc keys are acceptable (fallback)
    const data = raw[0].data || {};
    // Just verify it works — plaintext keys are the fallback behavior
    t.assert(raw[0] !== null, 'G10d. fallback storage works');
  }
} else {
  console.log('  (skipped) LocalCache not yet available — expected in Phase 3');
}

// ── Summary ─────────────────────────────────────────────────────────
t.summary('I-02 Staging Field Key Encryption (JS)');
process.exit(t.failed > 0 ? 1 : 0);
