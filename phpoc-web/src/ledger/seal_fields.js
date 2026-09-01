/**
 * seal_fields.js — Canonical closed, type-aware block-seal field whitelist (ADR-029/029a).
 *
 * A block's seal is an HMAC-SHA256 over exactly the fields in the row for that
 * block type that are PRESENT, serialized with jsonSort() (= Python
 * json.dumps(..., sort_keys=True)). Fields OUTSIDE the row (format_version,
 * key_version, identity, identity_seal, signature, the hash keys, and any
 * stray/future/client-specific field) are NEVER sealed.
 *
 * `original_hash` is optional-presence on every type: sealed only when present
 * (migrated / post-0.4.0 blocks), absent on new / pre-0.4.0 blocks (absence
 * must not break verification).
 * Summaries seal their `month`/`year` (partition identity — D5 trust anchor)
 * and carry no `day_index`/`entries`, so their rows differ from day/genesis.
 *
 * Mirror of Python `domain/ledger/chain.py` SEAL_FIELDS / select_seal_fields /
 * compute_seal. Do not diverge from the Python reference.
 */

import { jsonSort } from './utils.js';

/** Per-type, closed whitelist of fields fed into the block-seal HMAC. */
const SEAL_FIELDS = {
  genesis: ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
  day: ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
  month_summary: ['type', 'month', 'date', 'prev_hash', 'original_hash'],
  year_summary: ['type', 'year', 'date', 'prev_hash', 'original_hash'],
  // Commonplace Book (ADR-031): separate sealed chain under the same master key.
  commonplace_genesis: ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
  commonplace: ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
};

/**
 * Return the seal-input dict for a block: only the ADR-029a per-type whitelist
 * fields present. Both sealers and verifiers/recompute across ALL
 * implementations must use this single per-type selection so a block's seal
 * never depends on non-whitelisted fields (closed-set) and summary identity
 * (`month`/`year`) stays authenticated. Unknown block types are rejected.
 *
 * @param {object} block - A block dict.
 * @returns {object} A new object containing only present whitelisted fields.
 * @throws {Error} If the block's type is not a known seal type.
 */
function selectSealFields(block) {
  const type = block.type || 'day';
  const fieldSet = SEAL_FIELDS[type];
  if (!fieldSet) {
    throw new Error(`Unknown block type for seal: ${JSON.stringify(type)}`);
  }
  const out = {};
  for (const field of fieldSet) {
    if (field in block) out[field] = block[field];
  }
  return out;
}

/**
 * Compute a block's HMAC-SHA256 seal over its ADR-029a per-type fields.
 *
 * Centralizes `crypto.seal(jsonSort(selectSealFields(block)))` so every
 * re-seal/verify site routes through the same per-type table. `original_hash`
 * is sealed when present (in every row); the hash key and all non-whitelisted
 * fields are excluded automatically.
 *
 * @param {object} block - The block to seal (hash key not yet set).
 * @param {object} crypto - CryptoService-like object exposing `seal(data, key)`.
 * @param {string} masterKey - Hex master key for the block seal.
 * @returns {string} 64-character hex seal.
 */
function computeSeal(block, crypto, masterKey) {
  return crypto.seal(jsonSort(selectSealFields(block)), masterKey);
}

export { SEAL_FIELDS, selectSealFields, computeSeal };
