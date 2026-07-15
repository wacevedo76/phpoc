/**
 * entry_dto_committed_test.mjs — committed/block_index preservation in DTOs.
 *
 * TDD RED phase: Tests that rawEntryToDTO() and rawCommittedEntryToDTO()
 * preserve commmitted and block_index fields through conversion.
 *
 * Bug #1 (entry_dto.js): rawEntryToDTO() reads from raw.data but ignores
 * the top-level raw.committed and raw.block_index fields.
 *
 * Bug #2 extension: rawCommittedEntryToDTO() never sets committed=true.
 *
 * Groups:
 *   A: rawEntryToDTO() committed/block_index preservation (8 tests)
 *   B: rawCommittedEntryToDTO() committed flag (3 tests)
 *
 * Usage:
 *   node test/entry_dto_committed_test.mjs
 */

import { rawEntryToDTO, rawCommittedEntryToDTO } from '../src/sync/entry_dto.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

/** Mock crypto that just strips 'enc:' prefix for test decryption. */
class MockDecryptCrypto {
  decryptWithCachedKey(ciphertextHex) {
    if (ciphertextHex && typeof ciphertextHex === 'string' && ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }
}

/**
 * Build a minimal raw entry with committed/block_index at top level.
 * Fields match the PHPSPEC.md §3.1.1 staging blob format.
 */
function makeRawStagingEntry(opts = {}) {
  const {
    committed,
    block_index,
    entry_id = 'e-test-001',
    title = 'Test entry',
    startEpoch = 1700000000000,
    endEpoch = 1700003600000,
    duration = 3600000,
    is_active = false,
    is_paused = false,
    pauses = [],
    tags = [],
    comment = null,
    media = [],
    metadata = {},
    hash = 'deadbeef-hash-00000000000000000000000000000000000000000000000000000000',
    device_uuid = 'dev-0001',
    end_device_uuid = '',
  } = opts;

  return {
    hash,
    data: {
      entry_id,
      title,
      startTime_enc: `plain:${startEpoch}`,
      endTime_enc: endEpoch != null ? `plain:${endEpoch}` : undefined,
      duration,
      is_active,
      is_paused,
      pauses_enc: `plain:${JSON.stringify(pauses)}`,
      tags,
      comment,
      media,
      device_uuid_enc: `plain:${device_uuid}`,
      end_device_uuid_enc: `plain:${end_device_uuid}`,
      metadata_enc: `plain:${JSON.stringify(metadata)}`,
    },
    committed: committed !== undefined ? committed : undefined,
    block_index: block_index !== undefined ? block_index : undefined,
  };
}

/**
 * Build a minimal raw committed entry (from a ledger block).
 * Committed entries have encrypted hex fields — the mock crypto strips 'enc:'.
 */
function makeRawCommittedEntry(opts = {}) {
  const {
    entry_id = 'ec-committed-001',
    title = 'Committed entry',
    startEpoch = 1700000000000,
    endEpoch = 1700003600000,
    duration = 3600000,
    tags = [],
    comment = null,
    device_uuid = 'dev-0001',
    hash = 'committed-hash-0000000000000000000000000000000000000000000000000000',
  } = opts;

  return {
    hash,
    data: {
      entry_id,
      title,
      startTime_enc: `enc:${startEpoch}`,
      endTime_enc: `enc:${endEpoch}`,
      duration,
      tags,
      comment,
      media: [],
      device_uuid,
      end_device_uuid: '',
      metadata_enc: 'enc:{}',
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

async function run() {
  console.log('══ Entry DTO Committed Flag Tests ══\n');

  // ── Group A: rawEntryToDTO committed/block_index ──────────────────
  console.log('── Group A: rawEntryToDTO() committed/block_index ──\n');

  // A1. committed=true preserved
  {
    const raw = makeRawStagingEntry({ committed: true });
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.committed, true, 'A1. rawEntryToDTO preserves committed=true');
  }

  // A2. committed=false preserved (not coerced to truthy)
  {
    const raw = makeRawStagingEntry({ committed: false });
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.committed, false, 'A2. rawEntryToDTO preserves committed=false');
  }

  // A3. missing committed → default false (backward compat)
  {
    const raw = makeRawStagingEntry({});
    // committed and block_index not set at top level
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.committed, false, 'A3. missing committed → false (backward compat)');
  }

  // A4. block_index preserved
  {
    const raw = makeRawStagingEntry({ block_index: 5 });
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.block_index, 5, 'A4. rawEntryToDTO preserves block_index');
  }

  // A5. missing block_index → null
  {
    const raw = makeRawStagingEntry({});
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.block_index, null, 'A5. missing block_index → null');
  }

  // A6. both committed + block_index preserved simultaneously
  {
    const raw = makeRawStagingEntry({ committed: true, block_index: 5 });
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.committed, true, 'A6a. committed=true preserved with block_index');
    t.assertEq(dto.block_index, 5, 'A6b. block_index preserved with committed');
  }

  // A7. all existing DTO fields still populated alongside committed/block_index
  {
    const raw = makeRawStagingEntry({ committed: true, block_index: 3 });
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.committed, true, 'A7a. committed preserved');
    t.assertEq(dto.block_index, 3, 'A7b. block_index preserved');
    t.assertEq(dto.entry_id, 'e-test-001', 'A7c. entry_id');
    t.assertEq(dto.title, 'Test entry', 'A7d. title');
    t.assertEq(dto.start_epoch, 1700000000000, 'A7e. start_epoch');
    t.assertEq(dto.end_epoch, 1700003600000, 'A7f. end_epoch');
    t.assertEq(dto.duration, 3600000, 'A7g. duration');
    t.assertEq(dto.is_active, false, 'A7h. is_active');
    t.assertEq(dto.is_paused, false, 'A7i. is_paused');
    t.assertDeepEq(dto.pauses, [], 'A7j. pauses');
    t.assertDeepEq(dto.tags, [], 'A7k. tags');
    t.assertEq(dto.comment, null, 'A7l. comment');
    t.assertDeepEq(dto.media, [], 'A7m. media');
    t.assertEq(dto.source, 'remote', 'A7n. source');
    t.assertEq(dto.hash, 'deadbeef-hash-00000000000000000000000000000000000000000000000000000000', 'A7o. hash');
    t.assertEq(dto.device_uuid, 'dev-0001', 'A7p. device_uuid');
    t.assertEq(dto.end_device_uuid, '', 'A7q. end_device_uuid');
  }

  // A8. committed preserved even when entry_id missing
  {
    const raw = {
      hash: 'no-entry-id-hash',
      data: {
        title: 'No ID entry',
        startTime_enc: 'plain:1700000000000',
        duration: 1000,
        tags: [],
        metadata_enc: 'plain:{}',
      },
      committed: true,
      block_index: 7,
    };
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.committed, true, 'A8a. committed preserved with sparse data');
    t.assertEq(dto.block_index, 7, 'A8b. block_index preserved with sparse data');
    t.assertEq(dto.entry_id, '', 'A8c. entry_id defaults to empty string');
  }

  // ── Group B: rawCommittedEntryToDTO committed flag ────────────────
  console.log('\n── Group B: rawCommittedEntryToDTO() committed flag ──\n');

  const mockCrypto = new MockDecryptCrypto();

  // B1. committed entry DTO has committed=true
  {
    const raw = makeRawCommittedEntry();
    const dto = rawCommittedEntryToDTO(raw, mockCrypto);
    t.assert(dto !== null, 'B1a. committed entry converts successfully');
    t.assertEq(dto.committed, true, 'B1. committed entry DTO has committed=true');
  }

  // B2. source='ledger' (existing behavior, regression guard)
  {
    const raw = makeRawCommittedEntry();
    const dto = rawCommittedEntryToDTO(raw, mockCrypto);
    t.assertEq(dto.source, 'ledger', 'B2. committed entry DTO source=ledger preserved');
  }

  // B3. is_active=false (existing behavior, regression guard)
  {
    const raw = makeRawCommittedEntry();
    const dto = rawCommittedEntryToDTO(raw, mockCrypto);
    t.assertEq(dto.is_active, false, 'B3. committed entry DTO is_active=false preserved');
  }

  // ══════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n── Results ────────────────────────────────`);
  const failed = t.summary('Entry DTO Committed Flag');
  if (failed > 0) process.exit(1);
}

run();
