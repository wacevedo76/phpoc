/**
 * encrypt_entry_fields_dto_test.mjs — Encrypt All Entry Fields: DTO (Phase 2 RED)
 *
 * Groups C (committed entry DTO) + D (remote blob DTO) from the Phase 1 blueprint:
 *   docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_WEB_PHASE1.md
 *
 * Tests that rawCommittedEntryToDTO() and rawEntryToDTO() decrypt new _enc
 * fields: title_enc, tags_enc, comment_enc, duration_enc.
 *
 * Usage:
 *   node test/encrypt_entry_fields_dto_test.mjs
 */

import { rawEntryToDTO, rawCommittedEntryToDTO } from '../src/sync/entry_dto.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Mock crypto that strips 'enc:' prefix
// ══════════════════════════════════════════════════════════════════════

class MockDecryptCrypto {
  decryptWithCachedKey(ciphertextHex) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }
}

/**
 * Build a raw committed entry with new encryptable _enc fields.
 */
function makeCommittedEntry(opts = {}) {
  const {
    entry_id = 'ec-comm-001',
    title,
    title_enc,
    startEpoch = 1700000000000,
    endEpoch = 1700003600000,
    duration = 3600000,
    tags,
    tags_enc,
    comment,
    comment_enc,
    duration_enc,
    hash = 'committed-hash-00',
  } = opts;

  const data = {
    entry_id,
    startTime_enc: `enc:${startEpoch}`,
    endTime_enc: `enc:${endEpoch}`,
    duration: duration_enc ? undefined : duration,
    media: [],
    metadata_enc: 'enc:{}',
    device_uuid: 'dev-0001',
    end_device_uuid: '',
  };

  if (title !== undefined) data.title = title;
  if (title_enc !== undefined) data.title_enc = title_enc;
  if (tags !== undefined) data.tags = tags;
  if (tags_enc !== undefined) data.tags_enc = tags_enc;
  if (comment !== undefined) data.comment = comment;
  if (comment_enc !== undefined) data.comment_enc = comment_enc;
  if (duration_enc !== undefined) data.duration_enc = duration_enc;

  return { hash, data };
}

/**
 * Build a raw staging/remote entry with new encryptable _enc fields.
 */
function makeStagingEntry(opts = {}) {
  const {
    entry_id = 'es-stage-001',
    title,
    title_enc,
    startEpoch = 1700000000000,
    endEpoch,
    duration = 0,
    is_active = false,
    is_paused = false,
    pauses = [],
    tags,
    tags_enc,
    comment,
    comment_enc,
    duration_enc,
    metadata = {},
    hash = 'stage-hash-00',
    device_uuid = 'dev-0001',
    end_device_uuid = '',
    committed,
    block_index,
  } = opts;

  const data = {
    entry_id,
    startTime_enc: `plain:${startEpoch}`,
    duration: duration_enc ? undefined : duration,
    is_active,
    is_paused,
    pauses_enc: `plain:${JSON.stringify(pauses)}`,
    media: [],
    device_uuid_enc: `plain:${device_uuid}`,
    end_device_uuid_enc: `plain:${end_device_uuid}`,
    metadata_enc: `plain:${JSON.stringify(metadata)}`,
  };

  if (endEpoch != null) data.endTime_enc = `plain:${endEpoch}`;
  if (title !== undefined) data.title = title;
  if (title_enc !== undefined) data.title_enc = title_enc;
  if (tags !== undefined) data.tags = tags;
  if (tags_enc !== undefined) data.tags_enc = tags_enc;
  if (comment !== undefined) data.comment = comment;
  if (comment_enc !== undefined) data.comment_enc = comment_enc;
  if (duration_enc !== undefined) data.duration_enc = duration_enc;

  const raw = { hash, data };
  if (committed !== undefined) raw.committed = committed;
  if (block_index !== undefined) raw.block_index = block_index;
  return raw;
}

// ══════════════════════════════════════════════════════════════════════
// Group C: Committed entry DTO — 6 tests
// ══════════════════════════════════════════════════════════════════════

async function groupC() {
  console.log('\n══ Group C: Committed Entry DTO ══\n');

  const mockCrypto = new MockDecryptCrypto();

  // ── C1: rawCommittedEntryToDTO decrypts title_enc ──
  {
    const raw = makeCommittedEntry({
      title_enc: 'enc:Encrypted Committed Title',
    });
    const dto = rawCommittedEntryToDTO(raw, mockCrypto);
    t.assert(dto !== null, 'C1a. dto not null');
    t.assertEq(dto.title, 'Encrypted Committed Title',
      'C1. rawCommittedEntryToDTO decrypts title_enc');
  }

  // ── C2: fall back to plaintext title ──
  {
    const raw = makeCommittedEntry({
      title: 'Plain Committed Title',
    });
    const dto = rawCommittedEntryToDTO(raw, mockCrypto);
    t.assertEq(dto.title, 'Plain Committed Title',
      'C2. falls back to plaintext title when title_enc absent');
  }

  // ── C3: decrypt tags_enc from committed entry ──
  {
    const raw = makeCommittedEntry({
      tags_enc: 'enc:["work","committed"]',
    });
    const dto = rawCommittedEntryToDTO(raw, mockCrypto);
    t.assertEq(dto.tags.length, 2, 'C3a. tags has 2 items');
    t.assertEq(dto.tags[0], 'work', 'C3b. first tag correct');
    t.assertEq(dto.tags[1], 'committed', 'C3c. second tag correct');
  }

  // ── C4: decrypt comment_enc from committed entry ──
  {
    const raw = makeCommittedEntry({
      comment_enc: 'enc:Committed private note',
    });
    const dto = rawCommittedEntryToDTO(raw, mockCrypto);
    t.assertEq(dto.comment, 'Committed private note',
      'C4. rawCommittedEntryToDTO decrypts comment_enc');
  }

  // ── C5: decrypt duration_enc from committed entry ──
  {
    const raw = makeCommittedEntry({
      duration_enc: 'enc:7200000',
    });
    const dto = rawCommittedEntryToDTO(raw, mockCrypto);
    t.assertEq(dto.duration, 7200000,
      'C5. rawCommittedEntryToDTO decrypts duration_enc');
  }

  // ── C6: corrupt ciphertext → null (don't crash) ──
  {
    const raw = makeCommittedEntry({
      title_enc: 'this-is-garbage-not-hex',
    });
    const dto = rawCommittedEntryToDTO(raw, mockCrypto);
    // Corrupt title_enc may cause the entire DTO to fail (startEpoch
    // is still valid) or it may return null. Either way: no crash.
    t.assert(dto === null || typeof dto.title === 'string',
      'C6. corrupt title_enc does not crash');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Group D: Remote blob DTO — 5 tests
// ══════════════════════════════════════════════════════════════════════

async function groupD() {
  console.log('\n══ Group D: Remote Blob DTO ══\n');

  // ── D1: rawEntryToDTO decrypts title_enc from remote blob ──
  {
    const raw = makeStagingEntry({
      title_enc: 'plain:Encrypted Remote Title',
    });
    const dto = rawEntryToDTO(raw);
    t.assert(dto !== null, 'D1a. dto not null');
    t.assertEq(dto.title, 'Encrypted Remote Title',
      'D1. rawEntryToDTO decrypts title_enc from remote blob');
  }

  // ── D2: fall back to plaintext title ──
  {
    const raw = makeStagingEntry({
      title: 'Plain Remote Title',
    });
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.title, 'Plain Remote Title',
      'D2. falls back to plaintext title when title_enc absent');
  }

  // ── D3: decrypt all 4 encrypted fields from remote blob ──
  {
    const raw = makeStagingEntry({
      title_enc: 'plain:Remote Full',
      tags_enc: 'plain:["sync","test"]',
      comment_enc: 'plain:Remote note',
      duration_enc: 'plain:5400000',
    });
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.title, 'Remote Full', 'D3a. title decrypted');
    t.assertDeepEq(dto.tags, ['sync', 'test'], 'D3b. tags decrypted');
    t.assertEq(dto.comment, 'Remote note', 'D3c. comment decrypted');
    t.assertEq(dto.duration, 5400000, 'D3. duration decrypted');
  }

  // ── D4: no crypto → shows ciphertext/plain: values ──
  {
    const raw = makeStagingEntry({
      title_enc: 'plain:StillEncrypted',
    });
    // No crypto passed — but plain: values are readable
    const dto = rawEntryToDTO(raw);
    // With plain: prefix, the value should be readable even without crypto
    // But the design says unauthenticated view shows ciphertext.
    // For plain: prefix, it's already readable. For real ciphertext (hex),
    // it would stay encrypted. This test verifies the raw path works.
    t.assert(dto !== null, 'D4. remote blob without crypto does not crash');
  }

  // ── D5: decodeDataKeys handles tokenized + encrypted field names ──
  {
    const raw = makeStagingEntry({
      title_enc: 'plain:Tokenized Title',
      tags_enc: 'plain:["a","b"]',
    });
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.title, 'Tokenized Title',
      'D5a. title survives tokenized field names');
    t.assert(Array.isArray(dto.tags),
      'D5. tags survive combined I-02 tokenization + new _enc fields');
  }
}

// ══════════════════════════════════════════════════════════════════════
// Run all
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ Encrypt All Entry Fields — DTO Tests (Phase 2 RED) ══\n');
  console.log('Groups C+D: Committed + Remote DTO (11 tests)');
  console.log('Expected: ALL RED — implementation is Phase 3\n');

  await groupC();
  await groupD();

  t.summary('Encrypt Entry Fields — DTO (Groups C+D)');
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
