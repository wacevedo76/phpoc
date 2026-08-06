/**
 * LedgerEngine — high-level ledger operations (commit, verify, revert).
 *
 * The unified public API that orchestrates LedgerChain, IndexManager,
 * and SummaryPolicy. This is the main entry point for syncing entries
 * to the ledger, verifying chain integrity, and reverting blocks.
 *
 * Usage:
 *   import { LedgerEngine } from './engine.js';
 *   const engine = new LedgerEngine(crypto, store, masterKey);
 *   const hashPrefix = await engine.commit(entries);
 *   const valid = await engine.verify();
 */

import { LedgerChain } from './chain.js';
import { IndexManager } from './index_manager.js';
import { YearMonthSummaryPolicy } from './summary_policy.js';
import { jsonSort, computeEntryHash, getBlockHash } from './utils.js';

export class LedgerEngine {
  /**
   * @param {object} crypto - CryptoService-like object (encrypt/decrypt/seal/sign/sha256).
   * @param {import('../sync/storage.js').StorageBackend} store - StorageBackend instance.
   * @param {string} masterKey - Hex master key.
   * @param {string|null} [identitySecret=null] - Optional identity secret for block signatures.
   * @param {object|null} [summaryPolicy=null] - Summary policy. Defaults to YearMonthSummaryPolicy.
   */
  constructor(crypto, store, masterKey, identitySecret = null, summaryPolicy = null) {
    this.crypto = crypto;
    this.store = store;
    this.masterKey = masterKey;
    this.identitySecret = identitySecret;

    this.chain = new LedgerChain(crypto, store, masterKey, identitySecret);
    this.index = new IndexManager(store, crypto);
    this.summaryPolicy = summaryPolicy || new YearMonthSummaryPolicy(crypto, masterKey, identitySecret);
  }

  // ── Init ────────────────────────────────────────────────────────────

  /**
   * Initialize a new ledger by creating and appending the genesis block.
   *
   * The genesis block embeds the user's identity (username, email),
   * encrypted recovery seed, encrypted identity secret, and is sealed
   * and signed per PHPSPEC §4.1.
   *
   * An identity secret (32 random bytes) is generated during this
   * process and stored on the underlying chain for subsequent block
   * signing. It is also encrypted and stored in the genesis block
   * (identity_secret_enc_fallback) for recovery.
   *
   * @param {object} opts
   * @param {string} opts.username - Display name
   * @param {string} opts.email - Contact email
   * @param {string} opts.passphrase - User's passphrase (for PDK derivation)
   * @param {string} opts.seed - Base64 recovery seed
   * @returns {Promise<{genesisBlock: object, identitySecret: string}>}
   * @throws {Error} If the ledger already has blocks.
   */
  async init({ username, email, passphrase, seed }) {
    const existing = await this.chain.getLastBlock();
    if (existing) {
      throw new Error('Ledger already initialized. Cannot create a second genesis block.');
    }

    const genesisBlock = await this.chain.buildGenesisBlock({
      username,
      email,
      passphrase,
      seed,
    });

    await this.chain.append(genesisBlock);

    // Sync the engine's identity secret with the chain (set during buildGenesisBlock)
    this.identitySecret = this.chain.identitySecret;

    return {
      genesisBlock,
      identitySecret: this.identitySecret,
    };
  }

  // ── Commit ─────────────────────────────────────────────────────────

  /**
   * Sync entries to the ledger.
   *
   * Steps:
   *   1. Group entries by date
   *   2. Encrypt entry fields
   *   3. Compute content_hash for each entry
   *   4. Insert year/month summary blocks as needed
   *   5. Build and append day blocks
   *   6. Update the blind index
   *
   * @param {object[]} entries - List of entry dicts with at minimum title, start_epoch, duration.
   *   Each entry may include an `entry_id` which is preserved for caller tracking.
   * @returns {Promise<{hashPrefix: string|null, committedEntryIds: string[], blockIndex: number}|null>}
   */
  async commit(entries) {
    if (!entries || entries.length === 0) {
      return null;
    }

    // Input validation: reject entries missing required fields
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (typeof e.title !== 'string') {
        throw new Error(`Entry ${i}: title must be a string, got ${typeof e.title}`);
      }
      if (typeof e.start_epoch !== 'number' || e.start_epoch <= 0) {
        throw new Error(`Entry ${i}: start_epoch must be a positive number, got ${e.start_epoch}`);
      }
    }

    // Collect entry_ids for caller tracking (before _groupByDate strips them)
    const allEntryIds = [];
    const entryIdsByDate = {};
    for (const e of entries) {
      if (e.entry_id) {
        allEntryIds.push(e.entry_id);
        const dateStr = new Date(e.start_epoch).toISOString().slice(0, 10);
        if (!entryIdsByDate[dateStr]) entryIdsByDate[dateStr] = [];
        entryIdsByDate[dateStr].push(e.entry_id);
      }
    }

    // Group entries by date and encrypt/process
    const daysToSync = this._groupByDate(entries);

    if (Object.keys(daysToSync).length === 0) {
      return null;
    }

    // Append blocks for each day, inserting summaries as needed
    let lastBlockIndex = -1;
    const sortedDates = Object.keys(daysToSync).sort();
    for (const dateStr of sortedDates) {
      const dateEntryIds = entryIdsByDate[dateStr] || [];
      const blockIndex = await this._commitDay(dateStr, daysToSync[dateStr], dateEntryIds);
      if (blockIndex > lastBlockIndex) lastBlockIndex = blockIndex;
    }

    await this.index._flush();

    // Return the hash prefix of the last block
    const last = await this.chain.getLastBlock();
    const lastHash = last ? getBlockHash(last) : null;

    return {
      hashPrefix: lastHash ? lastHash.slice(0, 10) : null,
      committedEntryIds: allEntryIds,
      blockIndex: lastBlockIndex,
    };
  }

  /**
   * Encrypt a single staging entry for ledger storage.
   *
   * Encrypts sensitive fields, strips staging-only keys, computes
   * content_hash and entry hash, and returns the processed entry.
   *
   * @param {object} entry - Staging-style entry.
   * @returns {{hash: string, data: object, start_epoch: number}}
   */
  _encryptEntry(entry) {
    const data = Object.assign({}, entry);

    // Extract plaintext values
    const startEpoch = data.start_epoch || 0;
    const duration = data.duration || 0;
    const metadata = data.metadata || {};
    const pauses = data.pauses || [];
    let endEpoch = data.end_epoch;
    if (endEpoch === undefined || endEpoch === null) {
      endEpoch = startEpoch + duration;
    }

    // Encrypt fields for ledger storage
    data.startTime_enc = this.crypto.encrypt(String(startEpoch), this.masterKey);
    data.endTime_enc = this.crypto.encrypt(String(endEpoch), this.masterKey);
    data.metadata_enc = this.crypto.encrypt(jsonSort(metadata), this.masterKey);
    data.pauses_enc = this.crypto.encrypt(jsonSort(pauses), this.masterKey);

    // Remove staging-only fields
    delete data.start_epoch;
    delete data.end_epoch;
    delete data.pauses;
    delete data.metadata;
    delete data.is_active;
    delete data.is_paused;
    delete data.entry_id;
    delete data.device_uuid;
    delete data.end_device_uuid;
    delete data.hash;

    // Compute content hash
    data.content_hash = this._computeContentHash(data);

    // Compute entry hash
    const entryHash = computeEntryHash(data, this.crypto);

    return { hash: entryHash, data, start_epoch: startEpoch };
  }

  /**
   * Group entries by date, encrypting each via _encryptEntry.
   * @param {object[]} entries - Staging-style entries.
   * @returns {object} {dateStr: [{hash, data, start_epoch}]}
   */
  _groupByDate(entries) {
    const days = {};

    for (const entry of entries) {
      const processed = this._encryptEntry(entry);

      // Determine date from start epoch
      const dateObj = new Date(processed.start_epoch);
      const year = dateObj.getUTCFullYear();
      const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dateObj.getUTCDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      if (!days[dateStr]) {
        days[dateStr] = [];
      }

      days[dateStr].push(processed);
    }

    // Sort within each day by title (matching Flutter engine behavior)
    for (const dateStr of Object.keys(days)) {
      days[dateStr].sort((a, b) => {
        const titleA = (a.data && a.data.title) || '';
        const titleB = (b.data && b.data.title) || '';
        return titleA.localeCompare(titleB);
      });
    }

    return days;
  }

  /**
   * Process a single day: insert summaries, build/append day block, update index.
   * @param {string} dateStr - ISO date string.
   * @param {object[]} dayEntries - Prepared entries for this day.
   * @param {string[]} [_dateEntryIds] - Staging entry IDs for this date (for caller tracking).
   * @returns {Promise<number>} The block index of the committed day block.
   */
  async _commitDay(dateStr, dayEntries, _dateEntryIds) {
    const prevBlock = await this.chain.getLastBlock();

    let dayBlock;

    if (!prevBlock) {
      // No ledger at all — first-ever day block
      const zeroHash = '0'.repeat(64);
      dayBlock = await this.chain.buildDayBlock(dayEntries, zeroHash, dateStr);
      await this.chain.append(dayBlock);

      // Update index
      for (const entry of dayEntries) {
        const title = entry.data.title || '';
        const duration = entry.data.duration || 0;
        await this.index.update(dateStr, title, duration);
      }

      return dayBlock.day_index;
    }

    // Insert summary blocks if needed
    const summaryBlocks = this.summaryPolicy.getSummaryBlocks(prevBlock, dateStr);
    for (const summary of summaryBlocks) {
      await this.chain.append(summary);
    }

    // Update index before the day block build.
    // The index is updated in-memory here and flushed to store after
    // all day blocks are committed (see commit()). The order relative
    // to buildDayBlock is not correctness-critical since index data
    // is derived from entries, not from the block. Updating before
    // build lets us re-read the chain for prev_hash without index
    // state affecting block construction.
    for (const entry of dayEntries) {
      const title = entry.data.title || '';
      const duration = entry.data.duration || 0;
      await this.index.update(dateStr, title, duration);
    }

    // Build day block using the new last block for prev_hash
    const newPrevBlock = await this.chain.getLastBlock();
    const prevHash = getBlockHash(newPrevBlock);
    dayBlock = await this.chain.buildDayBlock(dayEntries, prevHash, dateStr);
    await this.chain.append(dayBlock);

    return dayBlock.day_index;
  }

  // ── Verify ─────────────────────────────────────────────────────────

  /**
   * Verify the integrity of the entire ledger chain.
   * @returns {Promise<boolean>}
   */
  async verify() {
    return await this.chain.verify();
  }

  // ── Revert ─────────────────────────────────────────────────────────

  /**
   * Revert the last N day blocks, restoring entries to staging.
   *
   * Counts day blocks (not summary blocks) and removes everything
   * from the first reverted day block backward through any preceding
   * summary blocks, restoring entries in plaintext format.
   *
   * @param {number} count - Number of day blocks to revert from the end.
   * @returns {Promise<number>} Number of entries restored, or -1 if count exceeds available day blocks.
   */
  async revert(count) {
    const ledger = await this.chain.readAll();

    if (!ledger || ledger.length === 0) {
      return 0;
    }

    // Identify day block indices
    const dayIndices = [];
    for (let i = 0; i < ledger.length; i++) {
      const b = ledger[i];
      if (b.type === 'day' || b.type === undefined) {
        dayIndices.push(i);
      }
    }

    if (count > dayIndices.length) {
      return -1;
    }
    if (count <= 0) {
      return 0;
    }

    const revertStart = dayIndices[dayIndices.length - count]; // first day block to remove

    // Find the effective start: go backwards from revertStart to include
    // any summary blocks between the previous day block and this one
    let effectiveStart = revertStart;
    for (let i = revertStart - 1; i >= 0; i--) {
      const b = ledger[i];
      if (b.type === 'day' || b.type === undefined) {
        break; // hit a day block, stop
      }
      // This is a summary block — also remove it
      effectiveStart = i;
    }

    let entriesRestored = 0;
    const staging = [];

    // Collect entries from reverted blocks and update index
    for (let i = effectiveStart; i < ledger.length; i++) {
      const block = ledger[i];
      if (block.type === 'day' || block.type === undefined) {
        const dateStr = block.date;
        for (const entry of (block.entries || [])) {
          const data = Object.assign({}, entry.data);

          // Convert encrypted fields back to plain: format
          const startVal = this.crypto.decrypt(data.startTime_enc, this.masterKey);
          data.startTime_enc = `plain:${startVal}`;

          if (data.endTime_enc) {
            const endVal = this.crypto.decrypt(data.endTime_enc, this.masterKey);
            data.endTime_enc = `plain:${endVal}`;
          }

          if (data.metadata_enc) {
            const metaVal = this.crypto.decrypt(data.metadata_enc, this.masterKey);
            data.metadata_enc = `plain:${metaVal}`;
          }

          if (data.pauses_enc) {
            const pausesVal = this.crypto.decrypt(data.pauses_enc, this.masterKey);
            data.pauses_enc = `plain:${pausesVal}`;
          } else {
            data.pauses_enc = 'plain:[]';
          }

          // Build staging entry
          staging.push({
            hash: entry.hash,
            data: data,
            start_epoch: parseInt(startVal, 10),
          });
          entriesRestored++;

          // Remove from index
          const title = data.title || '';
          const duration = data.duration || 0;
          await this.index.update(dateStr, title, -duration);
        }
      }
    }

    // Persist restored entries to staging store so they can be
    // re-committed or edited by the user.
    await this.store.set('ledger:staging', staging);

    // Truncate chain to keep everything before effectiveStart
    await this.chain.truncate_keep(effectiveStart);
    return entriesRestored;
  }

  // ── Query helpers ──────────────────────────────────────────────────

  /**
   * Query the blind index over a date range.
   * @param {string} fromDate - ISO start date (inclusive).
   * @param {string} toDate - ISO end date (inclusive).
   * @returns {object} {title: total_duration_ms}
   */
  async queryIndex(fromDate, toDate) {
    await this.index.reload();
    return this.index.query(fromDate, toDate);
  }

  /**
   * Rebuild the blind index from the full ledger chain.
   */
  async rebuildIndex() {
    this.index.clear();
    const ledger = await this.chain.readAll();
    for (const block of ledger) {
      if (block.type === 'day' || block.type === undefined) {
        const dateStr = block.date;
        for (const entry of (block.entries || [])) {
          const data = entry.data;
          const title = data.title || '';
          const duration = data.duration || 0;
          await this.index.update(dateStr, title, duration);
        }
      }
    }
  }

  // ── Block access delegates ─────────────────────────────────────────

  /**
   * Total number of blocks in the ledger chain.
   * @returns {Promise<number>}
   */
  async getBlockCount() {
    return await this.chain.getBlockCount();
  }

  /**
   * Return all day blocks from the chain (excludes summary blocks).
   * @returns {Promise<object[]>}
   */
  async getDayBlocks() {
    const ledger = await this.chain.readAll();
    return ledger.filter(b => b.type === 'day');
  }

  /**
   * Get the most recent block from the chain.
   * @returns {Promise<object|null>}
   */
  async getLastBlock() {
    return await this.chain.getLastBlock();
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Compute a content hash from all entry data fields.
   *
   * Decrypts _enc fields, sorts list values. Matches Python algorithm.
   * @param {object} data - Entry data dict with encrypted fields.
   * @returns {string} 64-char hex SHA-256.
   */
  _computeContentHash(data) {
    const content = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'content_hash') {
        continue;
      }
      if (key.endsWith('_enc') && value !== null && value !== undefined && value !== '') {
        content[key] = this.crypto.decrypt(value, this.masterKey);
      } else if (Array.isArray(value)) {
        content[key] = value.slice().sort((a, b) => String(a).localeCompare(String(b)));
      } else {
        content[key] = value;
      }
    }
    return this.crypto.sha256(jsonSort(content));
  }
}
