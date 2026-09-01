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
 * Deterministic JSON serialization with sorted keys and 2-space indent,
 * matching Python's json.dumps(obj, sort_keys=True, indent=2) exactly.
 *
 * This is the canonical format for entry hashing across all clients.
 *
 * @param {*} data - Any JSON-serializable value.
 * @returns {string} Python-compatible pretty-printed JSON string.
 */
export function jsonSortIndent2(data) {
  return _jsonDumpsIndent(data, 0);
}

function _jsonDumpsIndent(obj, depth) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  const indent = '  '.repeat(depth + 1);
  const outerIndent = depth > 0 ? '  '.repeat(depth) : '';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(v => indent + _jsonDumpsIndent(v, depth + 1));
    return '[\n' + items.join(',\n') + '\n' + outerIndent + ']';
  }
  // Object: sort keys recursively, skip undefined values
  const keys = Object.keys(obj).sort();
  const pairs = [];
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined) {
      pairs.push(indent + JSON.stringify(k) + ': ' + _jsonDumpsIndent(v, depth + 1));
    }
  }
  if (pairs.length === 0) return '{}';
  return '{\n' + pairs.join(',\n') + '\n' + outerIndent + '}';
}

/**
 * Compute SHA-256 hex digest using canonical sorted + indented JSON.
 * Matches Python's sha256(json.dumps(data, sort_keys=True, indent=2)).
 *
 * @param {object} data - Data to hash.
 * @param {object} crypto - CryptoService with a sha256() method.
 * @returns {string} 64-character hex SHA-256.
 */
export function computeEntryHash(data, crypto) {
  return crypto.sha256(jsonSortIndent2(data));
}

/**
 * Verify an entry hash, accepting both canonical (indent=2) and legacy
 * (compact) formats. Matching LedgerChain.verifySeal() which also has
 * a pre-migration fallback.
 *
 * Ledgers migrated before migrate.py step 3a was introduced have entry
 * hashes computed with json.dumps(data, sort_keys=True) — compact format
 * without indentation. This function accepts both.
 *
 * @param {object} data - The entry data dict.
 * @param {string} storedHash - The stored hash to verify against.
 * @param {object} crypto - CryptoService with a sha256() method.
 * @returns {boolean} True if the hash matches either format.
 */
export function verifyEntryHash(data, storedHash, crypto) {
  // Primary: canonical indent=2 format (post-migration)
  if (computeEntryHash(data, crypto) === storedHash) {
    return true;
  }
  // Fallback: pre-migration compact format (sort_keys=True, no indent)
  return crypto.sha256(jsonSort(data)) === storedHash;
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

// ── Format-version helpers (shared by chain.js / commonplace_chain.js) ──

// Default format_version when genesis has none (pre-spec, implicit 0.2.0)
export const DEFAULT_FORMAT_VERSION = [0, 2, 0];
// Content hash is required at this version and above
export const CONTENT_HASH_REQUIRED_VERSION = [0, 4, 0];

/** The 64-zero prev_hash sentinel that anchors a chain's first block. */
export const ZERO_HASH_64 = '0'.repeat(64);

/**
 * Parse format_version from a genesis block into an array of ints.
 * Returns [0, 2, 0] if genesis is null/undefined or has no format_version.
 */
export function parseFormatVersion(genesis) {
  if (!genesis) return DEFAULT_FORMAT_VERSION;
  const fv = genesis.format_version;
  if (typeof fv !== 'string') return DEFAULT_FORMAT_VERSION;
  try {
    return fv.split('.').map((s) => parseInt(s, 10));
  } catch (_) {
    return DEFAULT_FORMAT_VERSION;
  }
}

/**
 * Return true if the genesis format_version >= minimum (segment-wise int comparison).
 */
export function isFormatVersionAtLeast(genesis, minimum) {
  const actual = parseFormatVersion(genesis);
  const maxLen = Math.max(actual.length, minimum.length);
  for (let i = 0; i < maxLen; i++) {
    const a = actual[i] || 0;
    const m = minimum[i] || 0;
    if (a > m) return true;
    if (a < m) return false;
  }
  return true; // equal
}

/**
 * Compute the extensible content hash of an entry's sealed data dict.
 *
 * - Fields ending in `_enc` are decrypted (plaintext stays a STRING, never
 *   JSON-decoded) so the hash binds to the plaintext content regardless of
 *   re-encryption (ADR-026 rotation-safe).
 * - List fields are sorted for deterministic output.
 * - `content_hash` itself is excluded.
 * - Sort keys normalize key ordering (jsonSort).
 *
 * NOTE: list sorting uses `String(a).localeCompare(String(b))` to match the
 * pre-existing LedgerEngine._computeContentHash implementation. This differs
 * from the `[...v].sort()` used by LedgerChain/LedgerMerge verification — a
 * latent cross-client inconsistency for non-ASCII list items that should be
 * unified to plain code-unit sort in a dedicated parity task (behaviour is
 * identical for ASCII today, so this is not changed here).
 */
export function computeContentHash(data, crypto, masterKey) {
  const content = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'content_hash') continue;
    if (key.endsWith('_enc') && value !== null && value !== undefined && value !== '') {
      content[key] = crypto.decrypt(value, masterKey);
    } else if (Array.isArray(value)) {
      content[key] = value.slice().sort((a, b) => String(a).localeCompare(String(b)));
    } else {
      content[key] = value;
    }
  }
  return crypto.sha256(jsonSort(content));
}
