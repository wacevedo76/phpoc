/**
 * staging_hash_parity.mjs — ADR-034 P0 staging-hash parity vectors V1/V2 (Web side).
 *
 * Two roles:
 *
 *   1. **Subprocess helper** (Group G1): driven by
 *      `tests/test_staging_hash_parity.py` via a `node` subprocess — reads one
 *      JSON op from stdin, writes one JSON result to stdout (mirrors
 *      `ccs4_cross_client.mjs`). Proves Python ↔ Web byte-parity against the
 *      committed golden bytes in `testdata/staging_hash_seed.json`.
 *
 *   2. **Self-test** (Groups C/D): run under `node --test` to assert Web V1
 *      (canonical serialization — guard-green) and V2 (`computeStagingHash` —
 *      RED until it lands in `src/sync/remote_sync.js`).
 *
 * Spec (docs/design/STAGING_CHANGE_DETECTION_DESIGN.md §4.1):
 *   staging_hash = SHA-256( jsonSortNoSpaces([ canonical_row(r) for r in
 *                    non-committed rows ] sorted by activity_id) )
 *   canonical_row(r) = { activity_id, activity_status, activity, updated_at,
 *                        committed }
 *   activity = compact JSON in pinned key order (title, start_epoch, end_epoch,
 *              duration, tags, comment, media, entry_id, is_active, is_paused,
 *              pauses, metadata, device_uuid, end_device_uuid, block_index)
 *   Normalization: comment '' → null (Web already emits `e.comment || null`).
 *
 * Subprocess protocol:
 *   stdin  (one line): { "op": "...", ...args }
 *   stdout (one line): { "ok": true, "result": ... } | { "ok": false, "error": ... }
 *
 *   Ops:
 *     dtoToCanonicalRow → canonical row for one DTO ({dto, deviceId, now})
 *     canonicalRows     → canonical rows for ALL seed DTOs (incl. committed)
 *     canonicalArray    → serialized canonical array (committed-filtered + sorted)
 *     stagingHash       → computeStagingHash(all canonical rows)
 *
 * Run:
 *   node --test test/staging_hash_parity.mjs
 *   echo '{"op":"stagingHash"}' | node test/staging_hash_parity.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert';

import { dtoToCanonicalRow } from '../src/sync/remote_sync.js';
// `computeStagingHash` is the P0 deliverable in remote_sync.js; it does NOT
// exist in Phase 2 → resolved via namespace so the digest paths RED cleanly
// ("computeStagingHash is not a function") rather than an import error.
import * as remoteSync from '../src/sync/remote_sync.js';
import { jsonSortNoSpaces } from '../src/ledger/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', '..', 'testdata', 'staging_hash_seed.json');

const seed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));

// ── Pure helpers (exported) ────────────────────────────────────────────────

/** Canonical rows for every seed DTO (including the committed act-0004). */
function buildCanonicalRows() {
  return seed.seed_dtos.map((d) => dtoToCanonicalRow(d, seed.device_id, seed.now));
}

/** Serialized canonical array: committed-filtered, activity_id-sorted, compact
 *  sorted-keys JSON. Mirrors Python json.dumps(..., sort_keys=True, separators). */
function canonicalArray(rows) {
  const uncommitted = rows.filter((r) => !r.committed);
  uncommitted.sort((a, b) =>
    a.activity_id < b.activity_id ? -1 : a.activity_id > b.activity_id ? 1 : 0);
  return jsonSortNoSpaces(uncommitted);
}

/** Local SHA-256 of the canonical array — the reference re-derivation the P0
 *  `computeStagingHash` must equal. */
function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

/** P0 deliverable (RED in Phase 2 — not yet exported from remote_sync.js). */
function computeStagingHash(rows) {
  return remoteSync.computeStagingHash(rows);
}

// ── Subprocess op dispatch ─────────────────────────────────────────────────

async function run(op, args) {
  switch (op) {
    case 'dtoToCanonicalRow':
      return dtoToCanonicalRow(args.dto, args.deviceId, args.now);
    case 'canonicalRows':
      return buildCanonicalRows();
    case 'canonicalArray':
      return canonicalArray(buildCanonicalRows());
    case 'stagingHash':
      return computeStagingHash(buildCanonicalRows());
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;
  let req;
  try {
    req = JSON.parse(input.trim());
  } catch (e) {
    console.error('staging_hash_parity: invalid stdin JSON:', e.message);
    process.exit(2);
  }
  try {
    const result = await run(req.op, req);
    console.log(JSON.stringify({ ok: true, result }));
  } catch (e) {
    console.error('staging_hash_parity error:', e && e.message);
    console.log(JSON.stringify({ ok: false, error: (e && String(e)) || 'unknown' }));
    process.exitCode = 3;
  }
}

// ── Self-tests (Groups C/D) — registered only under `node --test` ──────────
//
// Under a plain `node` subprocess (the Python driver pipes stdin), `test()`
// is never called, so no TAP/spec output pollutes the JSON stdout contract.
const IS_TEST_RUNNER = process.env.NODE_TEST_CONTEXT === 'child-v8';

function registerSelfTests() {
  const allRows = buildCanonicalRows();
  const goldenById = new Map(seed.golden.canonical_rows.map((r) => [r.activity_id, r]));

  test('C1: Web dtoToCanonicalRow activity string matches golden', () => {
    for (const row of allRows) {
      const golden = goldenById.get(row.activity_id);
      assert.ok(golden, `golden row for ${row.activity_id}`);
      assert.strictEqual(
        row.activity,
        golden.activity,
        `activity string mismatch for ${row.activity_id}`,
      );
    }
  });

  test('C2: Web canonical array matches golden', () => {
    assert.strictEqual(canonicalArray(allRows), seed.golden.canonical_array);
  });

  test('C3: committed act-0004 excluded from array', () => {
    const arr = JSON.parse(canonicalArray(allRows));
    assert.strictEqual(arr.length, 3);
    assert.ok(!arr.some((r) => r.activity_id === 'act-0004'));
  });

  test('D1: computeStagingHash returns golden hex', () => {
    assert.strictEqual(computeStagingHash(allRows), seed.golden.staging_hash);
  });

  test('D2: digest bytes equal the reference re-derivation (Python parity)', () => {
    const ref = sha256Hex(canonicalArray(allRows));
    assert.strictEqual(ref, seed.golden.staging_hash); // green guard
    assert.strictEqual(computeStagingHash(allRows), ref); // RED in Phase 2
  });
}

if (IS_TEST_RUNNER) {
  registerSelfTests();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export {
  buildCanonicalRows,
  canonicalArray,
  computeStagingHash,
  sha256Hex,
  dtoToCanonicalRow,
};
