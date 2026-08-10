/**
 * LedgerMerge — merge divergent ledger chains that share the same genesis.
 *
 * Standalone module (not embedded in LedgerEngine or LedgerChain) because:
 *   1. Merge is infrequent — triggered by the genesis compatibility gate
 *      during remote connection setup, not on every sync.
 *   2. Cross-platform portable — minimal dependencies, can be ported to
 *      the CLI Python reference and Flutter mobile port.
 *   3. Bulk-merge ready — the same function can merge 2+ ledgers.
 *   4. Testable in isolation — no Engine/Chain instantiation needed.
 *
 * Usage:
 *   import { LedgerMerge } from './merge.js';
 *   const { mergedChain, stats, index } = await LedgerMerge.merge(
 *     localChain, remoteChain, crypto, masterKey, identitySecret
 *   );
 *
 * Architecture: PHPOC-REACT_WEB-DESIGN_DECISIONS.md §11.31
 */

import { getBlockHash, jsonSort, computeEntryHash, verifyEntryHash } from './utils.js';
import { selectSealFields } from './seal_fields.js';
import { YearMonthSummaryPolicy } from './summary_policy.js';

// Default format_version when genesis has none (pre-spec, implicit 0.2.0)
const DEFAULT_FORMAT_VERSION = [0, 2, 0];
// Content hash is required at this version and above
const CONTENT_HASH_REQUIRED_VERSION = [0, 4, 0];

/**
 * Parse format_version from a genesis block into an array of ints.
 * Returns [0, 2, 0] if genesis is null/undefined or has no format_version.
 */
function _parseFormatVersion(genesis) {
  if (!genesis) return DEFAULT_FORMAT_VERSION;
  const fv = genesis.format_version;
  if (typeof fv !== 'string') return DEFAULT_FORMAT_VERSION;
  try {
    return fv.split('.').map(s => parseInt(s, 10));
  } catch (_) {
    return DEFAULT_FORMAT_VERSION;
  }
}

/**
 * Return true if the genesis format_version >= minimum (segment-wise int comparison).
 */
function _isFormatVersionAtLeast(genesis, minimum) {
  const actual = _parseFormatVersion(genesis);
  const maxLen = Math.max(actual.length, minimum.length);
  for (let i = 0; i < maxLen; i++) {
    const a = actual[i] || 0;
    const m = minimum[i] || 0;
    if (a > m) return true;
    if (a < m) return false;
  }
  return true; // equal
}

export class LedgerMerge {
  /**
   * Merge two divergent ledger chains that share the same genesis block.
   *
   * Algorithm (7 steps):
   *   1. FIND FORK POINT — walk both chains forward, stop where blocks diverge
   *   2. EXTRACT DIVERGENT ENTRIES — collect all entries from post-fork blocks
   *   3. DE-DUPLICATE — strict content_hash match; keep local, skip remote dupes
   *   4. SORT — alphabetically by data.title (privacy-first ordering per §11.30)
   *   5. REBUILD CHAIN — common prefix + rebuilt day blocks with summary inserts
   *   6. REBUILD INDEX — aggregate durations by date and title
   *   7. RETURN — merged chain, stats, and index
   *
   * @param {object[]} localChain - Local ledger chain (array of block dicts).
   * @param {object[]} remoteChain - Remote ledger chain (array of block dicts).
   * @param {object} crypto - CryptoService-like object with seal/sign/decrypt methods.
   * @param {string} masterKey - Hex master key for sealing and decryption.
   * @param {string|null} [identitySecret=null] - Optional identity secret for block signatures.
   *   Also used for validating input chain signatures.
   * @param {object|null} [summaryPolicy=null] - Summary policy for rebuild.
   *   Defaults to YearMonthSummaryPolicy.
   * @returns {Promise<{mergedChain: object[], stats: object, index: object}>}
   * @throws {Error} If either chain fails validation, or if genesis blocks don't match.
   */
  static async merge(localChain, remoteChain, crypto, masterKey,
                     identitySecret = null, summaryPolicy = null) {
    // ── 0. VALIDATE EACH CHAIN INDEPENDENTLY ─────────────────────────
    await LedgerMerge._verifyChain('local', localChain, crypto, masterKey, identitySecret);
    await LedgerMerge._verifyChain('remote', remoteChain, crypto, masterKey, identitySecret);

    // ── 1. FIND FORK POINT ────────────────────────────────────────────
    let forkIndex = -1;
    const minLen = Math.min(localChain.length, remoteChain.length);
    for (let i = 0; i < minLen; i++) {
      const localBlockHash = getBlockHash(localChain[i]);
      const remoteBlockHash = getBlockHash(remoteChain[i]);
      if (localBlockHash === remoteBlockHash) {
        forkIndex = i;
      } else {
        break;
      }
    }

    // Genesis mismatch (forkIndex === -1 means even genesis differs)
    if (forkIndex < 0) {
      throw new Error(
        'Genesis block mismatch: chains have different genesis blocks and cannot be merged'
      );
    }

    // ── 2. EXTRACT ENTRIES & COUNT ───────────────────────────────────
    // Count ALL entries (for stats), build content_hash set from ALL
    // local entries (for dedup), and collect post-fork entries (for rebuild).

    let localEntryCount = 0;
    let remoteEntryCount = 0;
    let duplicatesSkipped = 0;
    const allLocalContentHashes = new Set();
    const postForkLocalEntries = [];

    for (let i = 0; i < localChain.length; i++) {
      const block = localChain[i];
      if (block.type === 'day' || block.type === undefined) {
        for (const entry of (block.entries || [])) {
          localEntryCount++;
          if (entry.data.content_hash) {
            allLocalContentHashes.add(entry.data.content_hash);
          }
          if (i > forkIndex) {
            postForkLocalEntries.push({
              hash: entry.hash,
              data: Object.assign({}, entry.data),
            });
          }
        }
      }
    }

    const postForkRemoteEntries = [];

    for (let i = 0; i < remoteChain.length; i++) {
      const block = remoteChain[i];
      if (block.type === 'day' || block.type === undefined) {
        for (const entry of (block.entries || [])) {
          remoteEntryCount++;
          const ch = entry.data.content_hash;
          if (ch && allLocalContentHashes.has(ch)) {
            duplicatesSkipped++;
          }
          if (i > forkIndex) {
            postForkRemoteEntries.push({
              hash: entry.hash,
              data: Object.assign({}, entry.data),
            });
          }
        }
      }
    }

    // ── 3. DE-DUPLICATE post-fork entries (strict content_hash only) ──
    const mergedEntries = [...postForkLocalEntries];

    for (const entry of postForkRemoteEntries) {
      const ch = entry.data.content_hash;
      if (!ch || !allLocalContentHashes.has(ch)) {
        mergedEntries.push(entry);
      }
    }

    // ── 4. SORT — alphabetical by title (§11.30) ─────────────────────
    mergedEntries.sort((a, b) => {
      return (a.data.title || '').localeCompare(b.data.title || '');
    });

    // ── 5. REBUILD CHAIN FROM FORK POINT ────────────────────────────
    const commonPrefix = localChain.slice(0, forkIndex + 1);

    // If no unique remote entries were added, the local chain is already
    // complete — use it as-is. Only rebuild when the remote contributed
    // entries that weren't already in the local chain.
    const hasUniqueRemoteEntries = mergedEntries.length > postForkLocalEntries.length;

    let mergedChain;
    let newBlockCount = 0;

    if (!hasUniqueRemoteEntries) {
      // Remote is a subset (or equal): keep local chain unchanged
      mergedChain = [...localChain];
    } else {
      // Rebuild: common prefix + new day blocks for merged entries
      mergedChain = [...commonPrefix];

      // Determine starting day_index from the fork block
      const forkBlock = commonPrefix[commonPrefix.length - 1];
      let dayIndex;
      if (forkBlock.type === 'month_summary' || forkBlock.type === 'year_summary') {
        // PHPSPEC §4.4: reset to 1 if fork point is a summary block
        dayIndex = 1;
      } else {
        dayIndex = (forkBlock.day_index || 0) + 1;
      }

      // Group merged entries by date (decrypt startTime_enc to determine date)
      const entriesByDate = {};
      for (const entry of mergedEntries) {
        const startEpochStr = await crypto.decrypt(entry.data.startTime_enc, masterKey);
        const startEpoch = parseInt(startEpochStr, 10);
        const dateStr = new Date(startEpoch).toISOString().slice(0, 10);
        if (!entriesByDate[dateStr]) {
          entriesByDate[dateStr] = [];
        }
        entriesByDate[dateStr].push(entry);
      }

      // Use summary policy for inserting summary blocks during rebuild
      const policy = summaryPolicy || new YearMonthSummaryPolicy(crypto, masterKey, identitySecret);

      const sortedDates = Object.keys(entriesByDate).sort();

      for (const dateStr of sortedDates) {
        const dateEntries = entriesByDate[dateStr];

        // Sort entries alphabetically by title within the day (§11.30)
        dateEntries.sort((a, b) => (a.data.title || '').localeCompare(b.data.title || ''));

        // Insert summary blocks between the last block and this date
        const prevBlock = mergedChain[mergedChain.length - 1];
        const summaryBlocks = policy.getSummaryBlocks(prevBlock, dateStr);
        for (const summary of summaryBlocks) {
          mergedChain.push(summary);
        }

        // Build day block
        const prevHash = getBlockHash(mergedChain[mergedChain.length - 1]);

        const dayContent = {
          type: 'day',
          day_index: dayIndex,
          date: dateStr,
          prev_hash: prevHash,
          entries: dateEntries,
        };

        // Compute block seal over the ADR-029a per-type whitelist (closed set).
        dayContent.day_hash = await crypto.seal(jsonSort(selectSealFields(dayContent)), masterKey);

        // Identity seal if identity secret is available
        if (identitySecret) {
          dayContent.identity_seal = await crypto.mac(dayContent.day_hash, identitySecret);
        }

        mergedChain.push(dayContent);
        newBlockCount++;
        dayIndex++;
      }
    }

    // ── 6. REBUILD INDEX ─────────────────────────────────────────────
    const index = {};
    for (const block of mergedChain) {
      if (block.type === 'day' || block.type === undefined) {
        for (const entry of (block.entries || [])) {
          const data = entry.data;
          const title = data.title || '';
          const duration = data.duration || 0;
          const dateStr = block.date;
          if (!index[dateStr]) {
            index[dateStr] = {};
          }
          index[dateStr][title] = (index[dateStr][title] || 0) + duration;
        }
      }
    }

    // ── 7. RETURN ────────────────────────────────────────────────────
    // Count merged entries from the full chain (common prefix + rebuilt blocks)
    let mergedEntryCount = 0;
    for (const block of mergedChain) {
      if (block.type === 'day' || block.type === undefined) {
        mergedEntryCount += (block.entries || []).length;
      }
    }

    const stats = {
      forkIndex,
      localEntries: localEntryCount,
      remoteEntries: remoteEntryCount,
      duplicatesSkipped,
      mergedEntries: mergedEntryCount,
      newBlockCount,
    };

    return { mergedChain, stats, index };
  }

  /**
   * Verify a single chain: seal integrity, prev_hash linkage,
   * entry hashes, content_hash verification, and optional identity seals
   * for every block.
   *
   * Mirrors LedgerChain._verifyBlockData() but operates on raw arrays
   * so the merge module stays standalone (no StorageBackend dependency).
   *
   * @param {string} label - "local" or "remote" for error messages.
   * @param {object[]} chain - Array of block dicts.
   * @param {object} crypto - CryptoService-like object.
   * @param {string} masterKey - Hex master key.
   * @param {string|null} [identitySecret=null]
   * @throws {Error} If any block fails validation.
   */
  static async _verifyChain(label, chain, crypto, masterKey, identitySecret = null) {
    if (!Array.isArray(chain) || chain.length === 0) {
      return;  // Empty chain is valid (trivially)
    }

    // Extract format_version from genesis (block 0) for content_hash gating
    const genesis = chain[0];
    const requireContentHash = _isFormatVersionAtLeast(genesis, CONTENT_HASH_REQUIRED_VERSION);

    // Block 0: seal + entry hashes
    if (!LedgerMerge._verifyBlockData(chain[0], crypto, masterKey, identitySecret, requireContentHash)) {
      throw new Error(
        `${label} chain validation failed: block 0 seal or entry hash is invalid`
      );
    }

    // Blocks 1+: prev_hash linkage + seal + entry hashes
    for (let i = 1; i < chain.length; i++) {
      const current = chain[i];
      const prev = chain[i - 1];

      // Check prev_hash linkage
      if (current.prev_hash !== getBlockHash(prev)) {
        throw new Error(
          `${label} chain validation failed: prev_hash mismatch at block ${i}`
        );
      }

      if (!LedgerMerge._verifyBlockData(current, crypto, masterKey, identitySecret, requireContentHash)) {
        throw new Error(
          `${label} chain validation failed: block ${i} seal, signature, or entry hash is invalid`
        );
      }
    }
  }

  /**
   * Verify a single block's data: seal, optional identity seal, entry hashes,
   * and content_hash verification.
   *
   * NOTE: This logic is intentionally duplicated from chain.js as
   * LedgerChain._verifyBlockData() because LedgerMerge is a standalone
   * module with no LedgerChain dependency. Keep both implementations
   * in sync — any bug fix in chain.js must be mirrored here.
   *
   * Checks performed:
   *   1. Seal = HMAC of sorted keys (minus seal key + identity_seal/signature + format_version)
   *   2. Identity seal over seal (if identitySecret is provided)
   *   3. Entry hash = SHA-256 of pretty-printed entry data
   *   4. Content hash verification — required if requireContentHash is true,
   *      verified when present otherwise
   *
   * @param {object} block - Block dict.
   * @param {object} crypto - CryptoService-like object.
   * @param {string} masterKey - Hex master key.
   * @param {string|null} [identitySecret=null]
   * @param {boolean} [requireContentHash=false] - If true, content_hash is mandatory.
   * @returns {boolean} True if the block is valid.
   */
  static _verifyBlockData(block, crypto, masterKey, identitySecret = null, requireContentHash = false) {
    const type = block.type || 'day';
    let hashKey;
    if (type === 'genesis') {
      hashKey = block.block_hash ? 'block_hash' : 'day_hash';  // I-17: backward compat
    } else if (type === 'day') {
      hashKey = 'day_hash';
    } else if (type === 'month_summary') {
      hashKey = 'month_hash';
    } else if (type === 'year_summary') {
      hashKey = 'year_hash';
    } else {
      hashKey = 'day_hash';
    }

    // Build check data from the ADR-029a per-type whitelist (closed set),
    // sharing the same source as chain.js (no drift). Unknown types rejected.
    let checkData;
    try {
      checkData = selectSealFields(block);
    } catch (_) {
      return false;
    }

    // 1. Block seal
    // Primary: derived seal key via WASM (matches Python per PHPSPEC §5.2)
    if (!crypto.verifySeal(jsonSort(checkData), block[hashKey], masterKey)) {
      // Backward compat: raw MK (old Flutter blocks pre-2026-07)
      if (crypto.hmacHex(masterKey, jsonSort(checkData)) !== block[hashKey]) {
        return false;
      }
    }

    // 2. Identity seal (supports both 'identity_seal' and legacy 'signature')
    if (identitySecret) {
      const sealValue = block.identity_seal || block.signature;
      if (!sealValue) {
        return false;
      }
      if (!crypto.verifyMac(block[hashKey], sealValue, identitySecret)) {
        return false;
      }
    }

    // 3. Entry hashes for day blocks
    // 4. Content hash verification
    if (type === 'day' && block.entries) {
      for (const entry of block.entries) {
        if (!verifyEntryHash(entry.data, entry.hash, crypto)) {
          return false;
        }

        // Content hash check
        const data = entry.data;
        const hasContentHash = data.content_hash !== undefined && data.content_hash !== null && data.content_hash !== '';

        if (requireContentHash && !hasContentHash) {
          // format_version >= 0.4.0: content_hash is mandatory
          return false;
        }

        if (hasContentHash) {
          if (!LedgerMerge._verifyContentHash(data, crypto, masterKey)) {
            return false;
          }
        }
      }
    }

    return true;
  }

  /**
   * Verify the content_hash of an entry's data dict.
   *
   * Uses the extensible algorithm first, then falls back to the legacy
   * v0.3.0 algorithm for pre-existing entries.
   */
  static _verifyContentHash(data, crypto, masterKey) {
    // Extensible algorithm: decrypt _enc fields, sort lists, exclude content_hash
    const content = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'content_hash') continue;
      if (key.endsWith('_enc') && value !== null && value !== '') {
        try {
          content[key] = crypto.decrypt(value, masterKey);
        } catch (_) {
          content[key] = value;
        }
      } else if (Array.isArray(value)) {
        content[key] = [...value].sort();
      } else {
        content[key] = value;
      }
    }
    const computed = crypto.sha256(jsonSort(content));
    if (computed === data.content_hash) return true;

    // Fallback: legacy v0.3.0 algorithm — hardcoded field order,
    // _enc values decrypted, JSON.stringify with indent=2 and no sort_keys.
    const decrypt = (encVal) => {
      if (!encVal) return encVal;
      try {
        return crypto.decrypt(encVal, masterKey);
      } catch (_) {
        return encVal;
      }
    };
    const legacyObj = {
      title: data.title || '',
      startTime_enc: decrypt(data.startTime_enc),
      endTime_enc: decrypt(data.endTime_enc),
      duration: data.duration || 0,
      tags: [...(data.tags || [])].sort(),
      pauses_enc: decrypt(data.pauses_enc),
      metadata_enc: decrypt(data.metadata_enc),
      comment: data.comment || '',
      media: [...(data.media || [])].sort(),
    };
    const legacyHash = crypto.sha256(JSON.stringify(legacyObj, null, 2));
    return legacyHash === data.content_hash;
  }
}
