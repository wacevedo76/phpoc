/**
 * staging_encryption_test.mjs — I-03 Phase 2 (RED): Staging At-Rest Encryption (Web).
 *
 * Tests assert the post-I-03 behavior on the web side:
 *   - LocalCache stores encrypted entries in IndexedDB when MK available
 *   - LocalCache reads encrypted entries, returns decrypted DTOs
 *   - Legacy plain: entries remain readable (backward compat)
 *   - entry_dto.js rawEntryToDTO / rawCommittedEntryToDTO handle encrypted fields
 *   - remote_sync.js push handles locally encrypted staging entries
 *
 * These tests are intentionally RED — they assert encrypted-staging behavior
 * that does not yet exist. They turn GREEN in Phase 3.
 *
 * Assertion IDs: I1–I6 from docs/planning/I03_STAGING_AT_REST_ENCRYPTION_PHASE1.md
 *
 * Usage:
 *   node test/staging_encryption_test.mjs
 */

import { createHash } from 'crypto';
import { MemoryBackend } from '../src/sync/storage.js';
import { TestHelpers } from './test_helpers.mjs';
import { LocalCache } from '../src/sync/local_cache.js';
import { rawEntryToDTO, rawCommittedEntryToDTO, parsePlainInt } from '../src/sync/entry_dto.js';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Mock crypto with real encrypt/decrypt (AES-like for testing)
// ══════════════════════════════════════════════════════════════════════

class MockCryptoWithEncryption {
  constructor() {
    this._mk = null;
    this._uuidCounter = 0;
  }

  setMasterKey(k) { this._mk = k; }
  getMasterKey() { return this._mk; }
  hasMasterKey() { return !!this._mk; }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  generateUuid() {
    this._uuidCounter++;
    return `00000000-0000-0000-0000-${String(this._uuidCounter).padStart(12, '0')}`;
  }

  /**
   * Mock encrypt: appends a keyed prefix to simulate real encryption.
   * Returns hex-encoded envelope.
   */
  encrypt(plaintext, masterKeyHex) {
    const key = masterKeyHex || this._mk || 'no-key';
    const combined = `enc:${key.slice(0, 8)}:${plaintext}`;
    return Buffer.from(combined, 'utf-8').toString('hex');
  }

  /**
   * Mock decrypt: reverses the mock encrypt.
   */
  decrypt(ciphertextHex, _masterKeyHex) {
    try {
      const decoded = Buffer.from(ciphertextHex, 'hex').toString('utf-8');
      if (decoded.startsWith('enc:')) {
        // Format: enc:keyprefix:plaintext
        const parts = decoded.split(':');
        return parts.slice(2).join(':');
      }
      // If we get here, it's not our format → return null
      return null;
    } catch {
      return null;
    }
  }

  encryptWithCachedKey(plaintext) {
    return this.encrypt(plaintext);
  }

  decryptWithCachedKey(ciphertextHex) {
    return this.decrypt(ciphertextHex);
  }

  // I-02a: deriveFieldKey + hmacHex for _fieldToken()
  hmacHex(keyHex, data) {
    return createHash('sha256').update('hmac:' + keyHex + ':' + data).digest('hex');
  }

  deriveFieldKey(mkHex) {
    return createHash('sha256').update('field-key:' + mkHex).digest('hex').slice(0, 32);
  }
}

class MockCryptoNoEncryption {
  constructor() {
    this._uuidCounter = 0;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  generateUuid() {
    this._uuidCounter++;
    return `00000000-0000-0000-0000-${String(this._uuidCounter).padStart(12, '0')}`;
  }

  // No master key — encrypt is plain: (NoAuthCryptoManager equivalent)
  hasMasterKey() { return false; }

  encrypt(plaintext, _mk) {
    return `plain:${plaintext}`;
  }

  decrypt(ciphertextHex, _mk) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('plain:')) {
      return ciphertextHex.slice(6);
    }
    throw new Error('Cannot decrypt without passphrase');
  }

  decryptWithCachedKey(ciphertextHex) {
    return this.decrypt(ciphertextHex);
  }

  encryptWithCachedKey(plaintext) {
    return this.encrypt(plaintext);
  }
}


// ══════════════════════════════════════════════════════════════════════
// Test runner
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ I-03 Staging At-Rest Encryption — Web Tests (Phase 2 RED) ══\n');

  // ── I1: LocalCache stores encrypted entries when MK is available ──
  console.log('── I1: LocalCache stores encrypted entries ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoWithEncryption();
    crypto.setMasterKey('test-master-key-32-bytes-xxxxxxx');

    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Encrypted Web Entry',
      startEpoch: 1714000000000,
      deviceUuid: 'web-dev-1',
    });

    const raw = await storage.get('entries');
    t.assert(Array.isArray(raw) && raw.length > 0, 'I1a. entry stored');

    const data = raw[0].data;

    // Encrypted fields must NOT have plain: prefix
    const encryptableFields = [
      'startTime_enc', 'pauses_enc', 'metadata_enc',
      'device_uuid_enc', 'end_device_uuid_enc'
    ];
    for (const field of encryptableFields) {
      const val = data[field];
      if (val != null) {
        t.assert(
          !val.startsWith('plain:'),
          `I1b. ${field} is encrypted (no plain: prefix)`
        );
      }
    }

    // Encrypted fields must be hex-encoded (after I-02: field names are tokens)
    // Verify all string values don't start with plain:
    let foundEncrypted = false;
    for (const [key, val] of Object.entries(data)) {
      if (typeof val === 'string' && val && !val.startsWith('plain:')) {
        if (/^[0-9a-f]+$/i.test(val)) {
          foundEncrypted = true;
          break;
        }
      }
    }
    t.assert(foundEncrypted,
      `I1c. at least one encrypted hex value found in stored data`);

    // Non-encryptable fields remain plaintext
    t.assertEq(data.title, 'Encrypted Web Entry', 'I1d. title is plaintext');
    t.assert(data.is_active === true, 'I1e. is_active is plain boolean');
  }

  // ── I2: LocalCache reads encrypted entries, returns decrypted DTOs ──
  console.log('\n── I2: LocalCache reads encrypted entries → decrypted DTOs ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoWithEncryption();
    crypto.setMasterKey('test-master-key-32-bytes-xxxxxxx');

    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Roundtrip Web',
      startEpoch: 1714000000000,
      endEpoch: 1714003600000,
      tags: ['web', 'roundtrip'],
      comment: 'web test comment',
      deviceUuid: 'web-dev-2',
    });

    // Read back — DTOs must be decrypted correctly
    const entries = await cache.readEntries();
    t.assertEq(entries.length, 1, 'I2a. one entry returned');
    const e = entries[0];
    t.assertEq(e.title, 'Roundtrip Web', 'I2b. title decrypted correctly');
    t.assertEq(e.start_epoch, 1714000000000, 'I2c. start_epoch decrypted');
    t.assertEq(e.end_epoch, 1714003600000, 'I2d. end_epoch decrypted');
    t.assertEq(e.comment, 'web test comment', 'I2e. comment preserved');
    t.assertEq(e.device_uuid, 'web-dev-2', 'I2f. device_uuid decrypted');

    // Verify raw storage is encrypted (after I-02: field names are tokens)
    const raw = await storage.get('entries');
    const rawData = raw[0].data || {};
    let hasPlainPrefix = false;
    for (const [key, val] of Object.entries(rawData)) {
      if (typeof val === 'string' && val.startsWith('plain:')) {
        hasPlainPrefix = true;
        break;
      }
    }
    t.assert(
      !hasPlainPrefix,
      'I2g. raw storage is encrypted (no plain: prefix)'
    );
  }

  // ── I3: LocalCache reads legacy plain: entries (backward compat) ──
  console.log('\n── I3: LocalCache reads legacy plain: entries ──\n');

  {
    const storage = new MemoryBackend();
    // Pre-populate storage with legacy plain: entries
    const legacyEntry = {
      hash: 'abc123legacy',
      data: {
        entry_id: 'legacy-eid-1',
        title: 'Legacy Entry',
        duration: 0,
        is_active: true,
        is_paused: false,
        startTime_enc: 'plain:1714000000000',
        endTime_enc: undefined,
        pauses_enc: 'plain:[]',
        tags: ['legacy'],
        media: [],
        device_uuid_enc: 'plain:legacy-dev',
        end_device_uuid_enc: 'plain:',
        metadata_enc: 'plain:{}',
      },
      committed: false,
      block_index: null,
    };
    await storage.set('entries', [legacyEntry]);

    // Read with crypto that HAS a master key
    const crypto = new MockCryptoWithEncryption();
    crypto.setMasterKey('test-master-key-32-bytes-xxxxxxx');
    const cache = new LocalCache(storage, crypto);

    const entries = await cache.readEntries();
    t.assertEq(entries.length, 1, 'I3a. legacy entry readable');
    t.assertEq(entries[0].title, 'Legacy Entry', 'I3b. title correct');
    t.assertEq(entries[0].start_epoch, 1714000000000, 'I3c. start_epoch parsed from plain:');
    t.assertEq(entries[0].device_uuid, 'legacy-dev', 'I3d. device_uuid parsed from plain:');
    t.assertEq(entries[0].tags[0], 'legacy', 'I3e. tags preserved');
  }

  // ── I4: entry_dto.js rawEntryToDTO handles encrypted fields ──
  console.log('\n── I4: entry_dto.js rawEntryToDTO handles encrypted fields ──\n');

  {
    const crypto = new MockCryptoWithEncryption();
    crypto.setMasterKey('test-master-key-32-bytes-xxxxxxx');

    // Build a raw entry with encrypted (hex) fields
    const encryptedStart = crypto.encrypt('1714000000000');
    const encryptedPauses = crypto.encrypt('[]');
    const encryptedMeta = crypto.encrypt('{}');
    const encryptedDevUuid = crypto.encrypt('web-dev-3');

    const rawEntry = {
      hash: 'enc-hash-test',
      data: {
        entry_id: 'enc-eid-1',
        title: 'Encrypted Remote Entry',
        duration: 0,
        is_active: true,
        is_paused: false,
        startTime_enc: encryptedStart,
        endTime_enc: undefined,
        pauses_enc: encryptedPauses,
        tags: ['encrypted'],
        media: [],
        device_uuid_enc: encryptedDevUuid,
        end_device_uuid_enc: undefined,
        metadata_enc: encryptedMeta,
      },
      committed: false,
    };

    // rawEntryToDTO should handle encrypted fields after Phase 3
    const dto = rawEntryToDTO(rawEntry, crypto);
    // Currently fails because parsePlainInt returns null for non-plain: values
    t.assert(
      dto !== null,
      'I4a. rawEntryToDTO handles encrypted (hex) entries (returns non-null)'
    );
    if (dto !== null) {
      t.assertEq(dto.title, 'Encrypted Remote Entry', 'I4b. title preserved');
      t.assertEq(dto.start_epoch, 1714000000000, 'I4c. start_epoch decrypted');
      t.assertEq(dto.device_uuid, 'web-dev-3', 'I4d. device_uuid decrypted');
      t.assertEq(dto.tags[0], 'encrypted', 'I4e. tags preserved');
    }
  }

  // ── I5: entry_dto.js rawCommittedEntryToDTO handles encrypted fields ──
  console.log('\n── I5: entry_dto.js rawCommittedEntryToDTO handles encrypted fields ──\n');

  {
    const crypto = new MockCryptoWithEncryption();
    crypto.setMasterKey('test-master-key-32-bytes-xxxxxxx');

    // Build a committed entry with encrypted fields
    const encryptedStart = crypto.encrypt('1714000000000');
    const encryptedMeta = crypto.encrypt('{"src":"ledger"}');

    const rawEntry = {
      hash: 'committed-enc-hash',
      data: {
        entry_id: 'committed-eid-1',
        title: 'Committed Encrypted Entry',
        duration: 3600000,
        is_active: false,
        is_paused: false,
        startTime_enc: encryptedStart,
        tags: ['committed'],
        device_uuid: 'comm-dev-1',
        metadata_enc: encryptedMeta,
      },
    };

    const dto = rawCommittedEntryToDTO(rawEntry, crypto);
    t.assert(
      dto !== null,
      'I5a. rawCommittedEntryToDTO handles encrypted entries'
    );
    if (dto !== null) {
      t.assertEq(dto.title, 'Committed Encrypted Entry', 'I5b. title preserved');
      t.assertEq(dto.start_epoch, 1714000000000, 'I5c. start_epoch decrypted correctly');
      t.assert(dto.committed === true, 'I5d. committed flag set');
    }
  }

  // ── I6: remote_sync.js push handles locally encrypted staging ──
  console.log('\n── I6: remote_sync.js handles encrypted local entries ──\n');

  {
    const storage = new MemoryBackend();
    const crypto = new MockCryptoWithEncryption();
    crypto.setMasterKey('test-master-key-32-bytes-xxxxxxx');

    const cache = new LocalCache(storage, crypto);

    await cache.append({
      title: 'Push Encrypted',
      startEpoch: 1714000000000,
      deviceUuid: 'web-push-dev',
      tags: ['push'],
    });

    // Simulate what pushBlob does: read raw entries from storage
    const raw = await storage.get('entries');
    t.assertEq(raw.length, 1, 'I6a. one entry to push');

    const data = raw[0].data;

    // After I-02: field names are tokens. Verify no plain: leaks in values.
    let hasPlainLeak = false;
    for (const [key, val] of Object.entries(data)) {
      if (typeof val === 'string' && val.startsWith('plain:')) {
        hasPlainLeak = true;
        break;
      }
    }
    t.assert(!hasPlainLeak, 'I6b. push data has no plaintext leaks');

    // The encryption must be reversible (round-trip through decrypt)
    // Verify push-ready data decrypts correctly (read via cache)
    const dtos = await cache.readEntries();
    t.assertEq(dtos[0].start_epoch, 1714000000000, 'I6e. push-ready data decrypts correctly');
  }

  // ── Results ───────────────────────────────────────────────────────
  console.log('');
  t.summary('I-03 Staging At-Rest Encryption — Web (Phase 2 RED)');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
