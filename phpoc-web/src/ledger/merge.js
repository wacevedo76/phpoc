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

import { getBlockHash } from './utils.js';
import { YearMonthSummaryPolicy } from './summary_policy.js';

/**
 * Build a JSON string with top-level sorted keys for seal computation.
 *
 * Uses explicit key sorting rather than JSON.stringify's replacer array
 * (which acts as a property whitelist, stripping nested data).
 *
 * @param {object} obj
 * @returns {string} JSON with top-level keys sorted.
 */
function sealJson(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = obj[k];
  }
  return JSON.stringify(sorted);
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
   * @param {object|null} [summaryPolicy=null] - Summary policy for rebuild.
   *   Defaults to YearMonthSummaryPolicy.
   * @returns {Promise<{mergedChain: object[], stats: object, index: object}>}
   * @throws {Error} If genesis blocks don't match.
   */
  static async merge(localChain, remoteChain, crypto, masterKey,
                     identitySecret = null, summaryPolicy = null) {
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
        const dayJson = sealJson(dayContent);
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
}
