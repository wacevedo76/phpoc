/**
 * Ledger utilities — shared helpers for chain, engine, and summary policy.
 *
 * Extracted during Phase 1 refactoring to eliminate duplication across
 * chain.js, engine.js, and summary_policy.js.
 */

/**
 * Deterministic JSON serialization matching Python's json.dumps(obj, sort_keys=True).
 *
 * Produces compact output with sorted keys at all nesting levels,
 * using ": " and ", " separators matching Python's output exactly.
 * This ensures SHA-256 hashes and HMAC seals are identical across
 * JavaScript and Python runtimes.
 *
 * @param {*} data - Any JSON-serializable value.
 * @returns {string} Python-compatible JSON string.
 */
export function jsonSort(data) {
  return _jsonDumps(data);
}

function _jsonDumps(obj) {
  // Top-level undefined → 'null' (matches JSON.stringify(undefined) behavior).
  // Object-valued keys with undefined values are silently skipped — this is
  // intentional: JS objects with absent keys (structured clone artifacts) must
  // produce identical output to objects where the key is present-but-undefined.
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    const items = obj.map(v => _jsonDumps(v));
    return '[' + items.join(', ') + ']';
  }
  // Object: sort keys recursively, skip undefined values
  const keys = Object.keys(obj).sort();
  const pairs = [];
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined) {
      pairs.push(JSON.stringify(k) + ': ' + _jsonDumps(v));
    }
  }
  return '{' + pairs.join(', ') + '}';
}

/**
 * Compute SHA-256 hex digest of pretty-printed JSON.
 * Matches the test convention (2-space indentation).
 *
 * @param {object} data - Data to hash.
 * @param {object} crypto - CryptoService with a sha256() method.
 * @returns {string} 64-character hex SHA-256.
 */
export function computeEntryHash(data, crypto) {
  return crypto.sha256(JSON.stringify(data, null, 2));
}

/**
 * Return the hash of a block irrespective of its type.
 *
 * Handles day_hash, month_hash, and year_hash — the three hash keys
 * used by different block types (day, month_summary, year_summary).
 *
 * @param {object} block
 * @returns {string|undefined}
 */
export function getBlockHash(block) {
  return block.block_hash || block.day_hash || block.month_hash || block.year_hash;
}
