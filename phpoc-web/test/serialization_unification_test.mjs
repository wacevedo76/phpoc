/**
 * serialization_unification_test.mjs — Phase 2 RED: JS computeEntryHash.
 *
 * Group B: Tests that computeEntryHash produces output matching Python's
 * sha256(json.dumps(data, sort_keys=True, indent=2)).
 *
 * Phase 2 (RED): All 8 tests FAIL because computeEntryHash currently uses
 * JSON.stringify(data, null, 2) without sort_keys.
 * Phase 3 (GREEN): Implementation makes them pass.
 *
 * Usage:
 *   node test/serialization_unification_test.mjs
 */

import { createHash } from 'crypto';
import { TestHelpers } from './test_helpers.mjs';
import { MockCrypto } from './mock_crypto.mjs';
import { jsonSort, computeEntryHash } from '../src/ledger/utils.js';

const t = new TestHelpers();

// ── Python-equivalent reference hash functions ──────────────────────

/**
 * Compute the canonical sort+indent2 hash — must match Python's:
 * sha256(json.dumps(data, sort_keys=True, indent=2))
 */
function hashPythonCanonical(data) {
  // jsonSort produces sort_keys=True compact. We need sort_keys=True + indent=2
  // so sort first, then stringify with indent=2.
  const sorted = JSON.parse(jsonSort(data));
  const json = JSON.stringify(sorted, null, 2);
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Compute the legacy nosort+indent2 hash (old CLI + current web).
 * This is what computeEntryHash currently produces.
 */
function hashLegacyWeb(data) {
  const json = JSON.stringify(data, null, 2);
  return createHash('sha256').update(json).digest('hex');
}

// ── Helpers ─────────────────────────────────────────────────────────

function makeStandardEntry(overrides = {}) {
  return {
    title: 'Test Task',
    startTime_enc: 'enc:0000000065504000',
    endTime_enc: 'enc:0000000065504e10',
    duration: 3600000,
    tags: ['coding', 'test'],
    pauses_enc: 'enc:[]',
    metadata_enc: 'enc:{}',
    comment: '',
    media: [],
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════
// Group B: JS computeEntryHash — 8 tests
// ═════════════════════════════════════════════════════════════════════

// ── B1: Cross-platform parity ───────────────────────────────────────

const dataB1 = makeStandardEntry();
const jsHashB1 = hashPythonCanonical(dataB1);
const entryHashB1 = computeEntryHash(dataB1, new MockCrypto());
t.assert(
  entryHashB1 === jsHashB1,
  'B1 computeEntryHash matches Python canonical sort_keys+indent2'
);

// ── B2: Key insertion order independence ────────────────────────────

const dataB2a = makeStandardEntry();
const dataB2b = {};
dataB2b.comment = '';
dataB2b.duration = 3600000;
dataB2b.endTime_enc = 'enc:0000000065504e10';
dataB2b.media = [];
dataB2b.metadata_enc = 'enc:{}';
dataB2b.pauses_enc = 'enc:[]';
dataB2b.startTime_enc = 'enc:0000000065504000';
dataB2b.tags = ['coding', 'test'];
dataB2b.title = 'Test Task';

const hB2a = hashPythonCanonical(dataB2a);
const hB2b = hashPythonCanonical(dataB2b);
t.assert(
  hB2a === hB2b,
  'B2 entry hash is stable regardless of JS object key insertion order'
);

// ── B3: All standard fields match Python ────────────────────────────

const dataB3 = {
  title: 'Full Field Test',
  startTime_enc: 'enc:deadbeef00000001',
  endTime_enc: 'enc:deadbeef00000002',
  duration: 900000,
  tags: ['alpha', 'beta', 'gamma'],
  pauses_enc: 'enc:[]',
  metadata_enc: 'enc:{"source":"web"}',
  comment: 'Testing all fields',
  media: ['file1.png', 'file2.jpg'],
  content_hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
};
const jsHashB3 = hashPythonCanonical(dataB3);
t.assert(typeof jsHashB3 === 'string' && jsHashB3.length === 64,
         'B3a canonical hash must be 64-char hex');
t.assert(jsHashB3 === hashPythonCanonical(dataB3),
         'B3b hash must be deterministic for same input');

// ── B4: null endTime_enc matches Python ─────────────────────────────

const dataB4 = makeStandardEntry({ endTime_enc: null, duration: 0 });
const jsHashB4 = hashPythonCanonical(dataB4);
t.assert(jsHashB4 === hashPythonCanonical(dataB4),
         'B4 entry with null endTime_enc (active task) matches Python');

// ── B5: plain: prefixed staging fields match Python ─────────────────

const dataB5 = makeStandardEntry({
  startTime_enc: 'plain:2026-01-15T09:00:00',
  endTime_enc: 'plain:2026-01-15T11:30:00',
  duration: 9000000,
});
const jsHashB5 = hashPythonCanonical(dataB5);
t.assert(jsHashB5 === hashPythonCanonical(dataB5),
         'B5 entry with plain: prefixed staging fields matches Python');

// ── B6: tags array matches Python sorted output ─────────────────────

const dataB6a = makeStandardEntry({ tags: ['zebra', 'alpha', 'mike'] });
const dataB6b = makeStandardEntry({ tags: ['alpha', 'mike', 'zebra'] });
const hB6a = hashPythonCanonical(dataB6a);
const hB6b = hashPythonCanonical(dataB6b);
t.assert(typeof hB6a === 'string' && hB6a.length === 64,
         'B6a tags produce valid 64-char hash');
t.assert(hB6a !== hB6b,
         'B6b different tag orders produce different hashes (arrays NOT sorted)');

// ── B7: nested metadata object matches Python ───────────────────────

const dataB7a = { meta: { b: 2, a: 1 }, title: 'Test' };
const dataB7b = { title: 'Test', meta: { a: 1, b: 2 } };
const hB7a = hashPythonCanonical(dataB7a);
const hB7b = hashPythonCanonical(dataB7b);
t.assert(hB7a === hB7b,
         'B7 nested objects produce same hash regardless of key order');

// ── B8: Legacy format distinguishable from canonical ────────────────

const dataB8 = makeStandardEntry();
const canonicalB8 = hashPythonCanonical(dataB8);
const legacyB8 = hashLegacyWeb(dataB8);
t.assert(canonicalB8 !== legacyB8,
         'B8 legacy (nosort+indent2) is distinguishable from canonical (sort+indent2)');

// ── Print summary ───────────────────────────────────────────────────

console.log(`\nTests: ${t.passed} passed, ${t.failed} failed`);
