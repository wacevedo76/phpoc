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

import { jsonSort } from '../ledger/utils.js';

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

  // ── Determine entries and seal payload based on format ──────────
  let entries;
  let sealPayload; // The data the seal covers
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
    // Seal: new v2 covers ledger only; old v2 covered {ledger, staging}
    sealPayload = JSON.stringify(parsed.ledger);
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
    sealPayload = jsonSort(entries);
    // v1: no genesis info — genesisHash stays null
  }

  // ── Seal verification ───────────────────────────────────────────
  // Try new seal first; if it fails and file has staging, try old seal (backward compat)
  let sealValid = crypto.verifySeal(sealPayload, parsed.seal, masterKey);
  if (!sealValid && formatVersion === '2' && Array.isArray(parsed.staging)) {
    const oldSealPayload = jsonSort({ ledger: parsed.ledger, staging: parsed.staging });
    sealValid = crypto.verifySeal(oldSealPayload, parsed.seal, masterKey);
  }

  if (!sealValid) {
    throw new Error(
      'importLedger: seal verification failed — file may be tampered ' +
      'or opened with the wrong passphrase'
    );
  }

  // ── Entry hash re-validation ────────────────────────────────────
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Build the canonical data (all fields except hash, sorted keys)
    const hashData = {};
    for (const key of Object.keys(entry).sort()) {
      if (key !== 'hash') {
        hashData[key] = entry[key];
      }
    }

    // Try current format first: jsonSort (canonical, new exports)
    const jsonSortHash = crypto.sha256(jsonSort(hashData));
    if (entry.hash !== jsonSortHash) {
      // Backward-compat fallback 1: JSON.stringify(all fields) — old stopped entries
      const jsStringifyAll = crypto.sha256(JSON.stringify(hashData));
      if (entry.hash !== jsStringifyAll) {
        // Backward-compat fallback 2: JSON.stringify(core fields only)
        // — old active entries (stale hashes from LocalCache)
        const coreData = {};
        for (const key of Object.keys(entry).sort()) {
          if (key !== 'hash' && key !== 'committed' && key !== 'block_index') {
            coreData[key] = entry[key];
          }
        }
        const jsStringifyCore = crypto.sha256(JSON.stringify(coreData));
        if (entry.hash !== jsStringifyCore) {
          throw new Error(
            `importLedger: entry hash mismatch at index ${i} ` +
            `("${entry.title || 'untitled'}") — file may be corrupted`
          );
        }
      }
    }
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

// ── Block seal field names per block type ──────────────────────────
// I-17: genesis uses block_hash (not day_hash).
const BLOCK_HASH_FIELD = {
  genesis: 'block_hash',
  year_summary: 'year_hash',
  month_summary: 'month_hash',
  day: 'day_hash',
};

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
    let hashField = BLOCK_HASH_FIELD[blockType];

    // I-17 backward compat: genesis may use block_hash (new) or day_hash (old)
    if (blockType === 'genesis' && !block[hashField] && block['day_hash']) {
      hashField = 'day_hash';
    }

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

    // Verify per-block seal: HMAC of block content (excluding hash + signature + format_version)
    // I-07: format_version excluded from seal computation.
    // Uses the same seal key as the export format (derived from masterKey).
    const checkData = {};
    for (const key of Object.keys(block).sort()) {
      if (key !== hashField && key !== 'signature' && key !== 'format_version') {
        checkData[key] = block[key];
      }
    }
    const sealPayload = jsonSort(checkData); // Python-compatible via utils.js
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
      let prevHashField = BLOCK_HASH_FIELD[prevType];
      // I-17 backward compat: genesis may use block_hash (new) or day_hash (old)
      if (prevType === 'genesis' && !prevBlock[prevHashField] && prevBlock['day_hash']) {
        prevHashField = 'day_hash';
      }
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
      // Verify entry hash (over the data dict, sorted keys, Python-compatible spacing)
      const expectedHash = crypto.sha256(jsonSort(entry.data));
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
