/**
 * entry_dto_updated_at_test.mjs — Option A: canonical/legacy DTO bridge emits
 * `updated_at`.
 *
 * Phase 2 (RED) tests for `docs/planning/WEB_STAGING_UPDATED_AT_PHASE1.md`
 * Group D.
 *
 * Both tests fail for the right reason: `canonicalRowToDTO` and
 * `rawEntryToDTO` do not yet emit `updated_at`.
 *
 * Run: node test/entry_dto_updated_at_test.mjs
 */

import { canonicalRowToDTO, rawEntryToDTO } from '../src/sync/entry_dto.js';
import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

async function run() {
  console.log('══ entry_dto updated_at bridge (Option A) — Group D ══\n');

  // D1 — canonicalRowToDTO emits updated_at from the row
  {
    const row = {
      activity_id: 'a1',
      activity_status: 'ended',
      activity: JSON.stringify({
        title: 'T', start_epoch: 1000, end_epoch: 2000, entry_id: 'e1',
      }),
      updated_at: 424242,
      committed: false,
    };
    const dto = canonicalRowToDTO(row);
    t.assertEq(dto.updated_at, 424242,
      'D1 canonicalRowToDTO emits updated_at from row');
  }

  // D2 — rawEntryToDTO emits updated_at when the raw legacy entry carries it
  {
    const raw = {
      hash: 'h1',
      data: {
        entry_id: 'e1', title: 'T',
        startTime_enc: 'plain:1000',
        is_active: false, is_paused: false,
        pauses_enc: 'plain:[]', metadata_enc: 'plain:{}',
        tags: [], media: [],
      },
      committed: false, block_index: null,
      updated_at: 424242,
    };
    const dto = rawEntryToDTO(raw);
    t.assertEq(dto.updated_at, 424242,
      'D2 rawEntryToDTO emits updated_at when the raw entry carries it');
  }

  const failed = t.summary('entry_dto_updated_at');
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
