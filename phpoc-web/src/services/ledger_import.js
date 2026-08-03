/**
 * ledger_import.js — Import ledger entries from a signed JSON file.
 *
 * Supports three formats:
 *   - v1 export: { format_version: '1', entries, seal }
 *   - v2 export: { format_version: '2', ledger, seal } (staging optional for backward compat)
 *   - Raw chain: [block, ...] — the CLI's ledger.json format
 * The caller (UI layer) is responsible for writing entries to storage
 * and deciding replace vs. merge based on genesis identity.
 *
 * Validation flow (export formats):
 *   1. Parse JSON → detect format version
 *   2. Verify seal (v1: over entries, v2: over ledger only)
 *   3. Recompute each entry's SHA-256 hash → compare
 *   4. Extract genesis hash from v2 ledger when available
 *   5. Any failure → throw (reject entirely, no partial import)
 *
 * Validation flow (raw chain):
 *   1. Parse JSON → detect top-level array
 *   2. Verify each block has required fields (type, prev_hash, etc.)
 *   3. Verify prev_hash chain linkage
 *   4. Verify each block's seal (day_hash/month_hash/year_hash)
 *   5. Extract genesis hash from first block
 *
 * Return shape:
 *   { entries, count, genesisHash, formatVersion, ledger }
 *   - genesisHash: genesis block day_hash (v2/chain) or null (v1)
 *   - ledger: committed chain blocks array (v2/chain) or null (v1)
 *   - entries: staging entries (export) or empty (raw chain)
 *   - Merge decision is the CALLER's responsibility.
 *
 * @module ledger_import
 */

import { jsonSort, jsonSortIndent2 } from '../ledger/utils.js';

/**
 * Import entries from an exported ledger file.
 *
 * @param {Blob|File} file - The exported .json file (Blob or File).
 * @param {object} crypto - CryptoService instance with verifySeal() and sha256().
 * @param {string} masterKey - 64-char hex master key.
 * @returns {Promise<{entries: Array, count: number, genesisHash: string|null, formatVersion: string, ledger: Array|null}>}
 * @throws {Error} On any validation failure (seal mismatch, bad hash, missing fields).
 */
export async function importLedger(file, crypto, masterKey) {
  // ── Validation ──────────────────────────────────────────────────
  if (!masterKey) {
    throw new Error('importLedger: masterKey is required');
  }

  if (typeof crypto.verifySeal !== 'function') {
    throw new Error('importLedger: crypto must provide verifySeal()');
  }

  // ── Parse file ──────────────────────────────────────────────────
  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      'importLedger: invalid or unreadable file — ' + err.message
    );
  }

  // ── Format detection ────────────────────────────────────────────
  // Raw chain format: top-level JSON array (CLI ledger.json)
  if (Array.isArray(parsed)) {
    return _importRawChain(parsed, crypto, masterKey);
  }

  // ── Export format: must have format_version ─────────────────────
  if (typeof parsed.format_version !== 'string' || !parsed.format_version) {
    throw new Error(
      'importLedger: missing or invalid format_version in file. ' +
      'If this is a raw ledger chain (CLI ledger.json), it should be a JSON array.'
    );
  }

  const formatVersion = parsed.format_version;

  // ── Determine entries and metadata based on format ──────────────
  let entries;
  let genesisHash = null;
  let ledger = null;

  if (formatVersion === '2') {
    // v2: committed ledger export — { ledger, seal }
    //     staging is optional (backward compat: old v2 exports had it)
    if (!Array.isArray(parsed.ledger)) {
      throw new Error(
        'importLedger: format v2 requires a "ledger" array'
      );
    }
    if (typeof parsed.seal !== 'string' || !parsed.seal) {
      throw new Error('importLedger: missing or invalid seal in file');
    }

    // Extract genesis hash (first block in the chain)
    if (parsed.ledger.length > 0 && parsed.ledger[0].type === 'genesis') {
      genesisHash = parsed.ledger[0].block_hash || parsed.ledger[0].day_hash || null;
    }

    // v2 entries = staging entries from old exports, or empty for new exports
    entries = Array.isArray(parsed.staging) ? parsed.staging : [];
    ledger = parsed.ledger;
  } else {
    // v1 (and any future unrecognized version): staging-only
    if (!Array.isArray(parsed.entries)) {
      throw new Error(
        'importLedger: missing or invalid entries array in file'
      );
    }
    if (typeof parsed.seal !== 'string' || !parsed.seal) {
      throw new Error('importLedger: missing or invalid seal in file');
    }

    entries = parsed.entries;
    // v1: no genesis info — genesisHash stays null
  }

  // ── Seal verification ───────────────────────────────────────────
  _verifyExportSeal(parsed, formatVersion, crypto, masterKey);

  // ── Entry hash re-validation ────────────────────────────────────
  for (let i = 0; i < entries.length; i++) {
    _validateEntryHash(entries[i], i, crypto);
  }

  // ── Success ─────────────────────────────────────────────────────
  return {
    entries,
    count: entries.length,
    genesisHash,
    formatVersion,
    ledger,
  };
}

// ── Entry hash validation helpers ─────────────────────────────────

/**
 * Validate a staging entry's hash using a three-tier backward-compatible fallback.
 *
 * Strategy order:
 *   1. jsonSort(all fields except hash) — current canonical format
 *   2. JSON.stringify(all fields) — old stopped entries (pre-canonical)
 *   3. jsonSort(core fields only) — old active entries (stale hashes from LocalCache,
 *      which added committed/block_index/entry_index after hashing)
 *
 * All strategies must fail to trigger rejection. No partial acceptance.
 */
function _validateEntryHash(entry, index, crypto) {
  // All fields except hash, sorted keys
  const hashData = _stripKey(entry, 'hash');

  // Strategy 1: jsonSort (canonical, new exports)
  if (entry.hash === crypto.sha256(jsonSort(hashData))) return;

  // Strategy 2: JSON.stringify (old stopped entries)
  if (entry.hash === crypto.sha256(JSON.stringify(hashData))) return;

  // Strategy 3: jsonSort of core fields only (old active entries)
  const coreData = _stripKeys(hashData, ['committed', 'block_index', 'entry_index']);
  if (entry.hash === crypto.sha256(jsonSort(coreData))) return;

  throw new Error(
    `importLedger: entry hash mismatch at index ${index} ` +
    `("${entry.title || 'untitled'}") — file may be corrupted`
  );
}

/** Return a new object with the named key removed. */
function _stripKey(obj, key) {
  const result = {};
  for (const k of Object.keys(obj).sort()) {
    if (k !== key) result[k] = obj[k];
  }
  return result;
}

/** Return a new object with the named keys removed. */
function _stripKeys(obj, keys) {
  const result = {};
  for (const k of Object.keys(obj).sort()) {
    if (!keys.includes(k)) result[k] = obj[k];
  }
  return result;
}

/**
 * Verify export file seal with backward-compatible fallback.
 *
 * For v2: tries JSON.stringify(ledger) first, then falls back to
 * old-format jsonSort({ledger, staging}) when staging is present.
 * For v1: seal over jsonSort(entries) — no fallback.
 * Throws on any failure.
 */
function _verifyExportSeal(parsed, formatVersion, crypto, masterKey) {
  const seal = parsed.seal;

  if (formatVersion === '2') {
    // Current format: seal over JSON.stringify(ledger) only
    if (crypto.verifySeal(JSON.stringify(parsed.ledger), seal, masterKey)) return;

    // Backward compat: old v2 sealed {ledger, staging} with jsonSort
    if (Array.isArray(parsed.staging)) {
      const oldPayload = jsonSort({ ledger: parsed.ledger, staging: parsed.staging });
      if (crypto.verifySeal(oldPayload, seal, masterKey)) return;
    }
  } else {
    // v1: seal over jsonSort(entries)
    if (crypto.verifySeal(jsonSort(parsed.entries), seal, masterKey)) return;
  }

  throw new Error(
    'importLedger: seal verification failed — file may be tampered ' +
    'or opened with the wrong passphrase'
  );
}

// ── Block seal field names per block type ──────────────────────────
// I-17: genesis uses block_hash (not day_hash).
const BLOCK_HASH_FIELD = {
  genesis: 'block_hash',
  year_summary: 'year_hash',
  month_summary: 'month_hash',
  day: 'day_hash',
};

/**
 * Return the hash field name for a block, with I-17 backward compat:
 * genesis may use block_hash (new) or day_hash (old).
 */
function _getHashField(block, blockType) {
  let field = BLOCK_HASH_FIELD[blockType];
  if (blockType === 'genesis' && !block[field] && block['day_hash']) {
    field = 'day_hash';
  }
  return field;
}

/**
 * Import a raw ledger chain (CLI ledger.json format — JSON array of blocks).
 *
 * Validates chain structure (prev_hash linkage) and per-block seals.
 * Returns the committed chain as `ledger` and an empty `entries` array
 * (raw chains have no separate staging — all entries are in blocks).
 *
 * @param {object[]} blocks - Array of block objects from the parsed chain.
 * @param {object} crypto - CryptoService with verifySeal() and sha256().
 * @param {string} masterKey - 64-char hex master key.
 * @returns {{entries: Array, count: number, genesisHash: string|null, formatVersion: string, ledger: Array}}
 */
function _importRawChain(blocks, crypto, masterKey) {
  // ── Validate non-empty ──────────────────────────────────────────
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error(
      'importLedger: raw chain file must be a non-empty JSON array of blocks'
    );
  }

  // ── Validate genesis block ──────────────────────────────────────
  const genesis = blocks[0];
  if (genesis.type !== 'genesis') {
    throw new Error(
      'importLedger: raw chain must start with a genesis block (type: "genesis")'
    );
  }

  const genesisHash = genesis.block_hash || genesis.day_hash || null;

  // ── Validate each block's structure and seal ────────────────────
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockType = block.type || 'day';
    const hashField = _getHashField(block, blockType);

    if (!hashField) {
      throw new Error(
        `importLedger: unknown block type "${blockType}" at index ${i}`
      );
    }

    const blockHash = block[hashField];
    if (typeof blockHash !== 'string' || blockHash.length !== 64) {
      throw new Error(
        `importLedger: missing or invalid ${hashField} at block index ${i}`
      );
    }

    // Verify per-block seal: HMAC of block content.
    //
    // Excluded from seal payload (must match Python's migrate.py):
    //   - hashField   — the seal/hash itself (day_hash, month_hash, year_hash, block_hash)
    //   - signature   — identity signature (PHPSPEC §5.3)
    //   - identity_seal — server-side identity binding (added after seal is computed)
    //   - format_version — stripped by I-07, must not affect seal
    //   - key_version   — ADR-026 key versioning metadata, must not affect seal
    const checkData = {};
    for (const key of Object.keys(block).sort()) {
      if (key !== hashField && key !== 'signature' && key !== 'format_version' &&
          key !== 'identity_seal' && key !== 'key_version') {
        checkData[key] = block[key];
      }
    }
    const sealPayload = jsonSort(checkData);
    const sealValid = crypto.verifySeal(sealPayload, blockHash, masterKey);

    if (!sealValid) {
      throw new Error(
        `importLedger: block seal verification failed at index ${i} ` +
        `(${blockType}, date: ${block.date || 'unknown'}) — ` +
        'file may be tampered or opened with the wrong passphrase'
      );
    }

    // Verify prev_hash chain linkage (skip genesis)
    if (i > 0) {
      const prevBlock = blocks[i - 1];
      const prevType = prevBlock.type || 'day';
      const prevHashField = _getHashField(prevBlock, prevType);
      const expectedPrevHash = prevBlock[prevHashField];

      if (block.prev_hash !== expectedPrevHash) {
        throw new Error(
          `importLedger: chain linkage broken at block index ${i} ` +
          `(prev_hash ${block.prev_hash?.slice(0, 8)}... ≠ ` +
          `expected ${expectedPrevHash?.slice(0, 8)}...)`
        );
      }
    }
  }

  // ── Validate entries inside day blocks ──────────────────────────
  let totalEntries = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'genesis' || block.type === 'year_summary' || block.type === 'month_summary') {
      continue;
    }
    const entries = block.entries || [];
    for (let j = 0; j < entries.length; j++) {
      const entry = entries[j];
      if (!entry.hash || !entry.data) {
        throw new Error(
          `importLedger: malformed entry at block ${i}, entry ${j} — missing hash or data`
        );
      }
      // Verify entry hash — 3-way fallback matching Python's
      // _verify_entry_hash_flex: sort+indent2 → sort+compact → nosort+indent2.
      let expectedHash = crypto.sha256(jsonSortIndent2(entry.data));
      if (entry.hash !== expectedHash) {
        expectedHash = crypto.sha256(jsonSort(entry.data));
      }
      if (entry.hash !== expectedHash) {
        expectedHash = crypto.sha256(JSON.stringify(entry.data, null, 2));
      }
      if (entry.hash !== expectedHash) {
        throw new Error(
          `importLedger: entry hash mismatch at block ${i}, entry ${j} ` +
          `("${entry.data.title || 'untitled'}") — file may be corrupted`
        );
      }
      totalEntries++;
    }
  }

  // ── Success ─────────────────────────────────────────────────────
  return {
    entries: [],       // Raw chain has no separate staging — all entries are in blocks
    count: 0,
    genesisHash,
    formatVersion: 'chain',
    ledger: blocks,
  };
}
