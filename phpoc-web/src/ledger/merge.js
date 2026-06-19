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

import { getBlockHash, jsonSort, computeEntryHash } from './utils.js';
import { YearMonthSummaryPolicy } from './summary_policy.js';

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

        // Compute block seal
        const dayJson = jsonSort(dayContent);
        dayContent.day_hash = await crypto.seal(dayJson, masterKey);

        // Sign with identity secret if available
        if (identitySecret) {
          dayContent.signature = await crypto.sign(dayContent.day_hash, identitySecret);
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
   * Verify a single ledger chain: seal integrity, prev_hash linkage,
   * entry hashes, and optional identity signatures for every block.
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

    // Block 0: seal + entry hashes
    if (!LedgerMerge._verifyBlockData(chain[0], crypto, masterKey, identitySecret)) {
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

      if (!LedgerMerge._verifyBlockData(current, crypto, masterKey, identitySecret)) {
        throw new Error(
          `${label} chain validation failed: block ${i} seal, signature, or entry hash is invalid`
        );
      }
    }
  }

  /**
   * Verify a single block's data: seal, optional signature, and entry hashes.
   *
   * Matches the same checks performed by LedgerChain._verifyBlockData():
   *   1. Seal = HMAC of sorted keys (minus seal key + signature)
   *   2. Signature over seal (if identitySecret is provided)
   *   3. Entry hash = SHA-256 of pretty-printed entry data
   *
   * @param {object} block - Block dict.
   * @param {object} crypto - CryptoService-like object.
   * @param {string} masterKey - Hex master key.
   * @param {string|null} [identitySecret=null]
   * @returns {boolean} True if the block is valid.
   */
  static _verifyBlockData(block, crypto, masterKey, identitySecret = null) {
    const type = block.type || 'day';
    let hashKey;
    if (type === 'day') {
      hashKey = 'day_hash';
    } else if (type === 'month_summary') {
      hashKey = 'month_hash';
    } else if (type === 'year_summary') {
      hashKey = 'year_hash';
    } else {
      hashKey = 'day_hash';
    }

    // Build check data: everything except the hash key and signature
    const checkData = {};
    for (const [k, v] of Object.entries(block)) {
      if (k !== hashKey && k !== 'signature') {
        checkData[k] = v;
      }
    }

    // 1. Block seal
    if (!crypto.verifySeal(jsonSort(checkData), block[hashKey], masterKey)) {
      return false;
    }

    // 2. Identity signature (only if identity secret is set)
    if (identitySecret) {
      if (!block.signature) {
        return false;
      }
      if (!crypto.verifySignature(block[hashKey], block.signature, identitySecret)) {
        return false;
      }
    }

    // 3. Entry hashes for day blocks
    if (type === 'day' && block.entries) {
      for (const entry of block.entries) {
        const expectedHash = computeEntryHash(entry.data, crypto);
        if (expectedHash !== entry.hash) {
          return false;
        }
      }
    }

    return true;
  }
}
