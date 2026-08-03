/**
 * import_service.js — Cross-ledger entry migration service layer.
 *
 * Orchestrates the full import pipeline: dry-run preview, conflict
 * detection, deduplication, re-encryption, and chain appending.
 * Provides the data classes ImportPreview, ImportResult, and
 * ImportException for the UI layer.
 *
 * Usage:
 *   import { ImportService, ImportPreview, ImportResult, ImportException }
 *     from '../services/import_service.js';
 *   const svc = new ImportService({ targetCrypto, targetChain });
 *   const preview = await svc.dryRun(sourceSeed, sourceChain);
 *   const result  = await svc.import(sourceSeed, sourceChain, { force: false });
 */

import { EntryImporter } from '../ledger/import_entries.js';

/**
 * Structured error for import operations.
 */
export class ImportException extends Error {
  /**
   * @param {string} message - Human-readable error message.
   * @param {string} [code='IMPORT_ERROR'] - Machine-readable error code.
   */
  constructor(message, code = 'IMPORT_ERROR') {
    super(message);
    this.name = 'ImportException';
    this.code = code;
  }
}

/**
 * Result of a dry-run preview.
 *
 * Exposes entry count, date range, and detected conflicts so the UI
 * can show the user what will happen before committing.
 */
export class ImportPreview {
  /**
   * @param {object} opts
   * @param {number} opts.entryCount - Number of entries found.
   * @param {{first: string|null, last: string|null}} opts.dateRange - Date span.
   * @param {string[]} [opts.conflicts=[]] - Conflicting dates.
   */
  constructor({ entryCount, dateRange, conflicts = [] }) {
    this.entryCount = entryCount;
    this.dateRange = dateRange;
    this.conflicts = conflicts;
  }
}

/**
 * Result of a completed import.
 *
 * Reports how many entries were migrated, how many were skipped
 * (duplicates), and how many new blocks were added to the target chain.
 */
export class ImportResult {
  /**
   * @param {object} opts
   * @param {number} opts.migratedCount - Entries successfully migrated.
   * @param {number} opts.skippedCount - Entries skipped (duplicates).
   * @param {number} opts.newBlockCount - New day blocks appended.
   */
  constructor({ migratedCount, skippedCount, newBlockCount }) {
    this.migratedCount = migratedCount;
    this.skippedCount = skippedCount;
    this.newBlockCount = newBlockCount;
  }
}

/**
 * Orchestrates cross-ledger entry migration.
 *
 * The target ledger is implicit — it's the one passed to the constructor,
 * representing the user's currently-loaded, authenticated ledger.
 * The source is provided as a seed + chain (or a JSON buffer for
 * importFromFile).
 */
export class ImportService {
  /**
   * @param {object} opts
   * @param {object} opts.targetCrypto - Crypto service (must have deriveMasterKey, getMasterKey, encrypt, decrypt).
   * @param {import('../ledger/chain.js').LedgerChain} opts.targetChain - The target ledger chain.
   */
  constructor({ targetCrypto, targetChain }) {
    this.targetCrypto = targetCrypto;
    this.targetChain = targetChain;
  }

  /**
   * Validate the source seed against the target — throws if they match.
   * Returns the derived source MK on success.
   */
  _validateSeed(sourceSeed) {
    const sourceMK = this.targetCrypto.deriveMasterKey(sourceSeed);
    if (sourceMK === this.targetCrypto.getMasterKey()) {
      throw new ImportException(
        'Cannot import from the same ledger (source seed matches target)',
        'SELF_IMPORT'
      );
    }
    return sourceMK;
  }

  /**
   * Scan the target chain blocks to collect existing content_hashes and
   * entry-level dates (for dedup + conflict detection).
   */
  _collectTargetData(targetBlocks, targetMK) {
    const hashes = new Set();
    const dates = new Set();
    for (const block of targetBlocks) {
      if (!block.entries) continue;
      for (const e of block.entries) {
        const data = EntryImporter._entryData(e);
        if (data.content_hash) hashes.add(data.content_hash);
        if (block.type === 'day' && data.startTime_enc) {
          try {
            const epochStr = this.targetCrypto.decrypt(data.startTime_enc, targetMK);
            dates.add(new Date(parseInt(epochStr, 10)).toISOString().slice(0, 10));
          } catch (_) { /* skip unparseable */ }
        }
      }
    }
    return { hashes, dates };
  }

  /**
   * Dry-run preview — reports what would be imported without modifying anything.
   *
   * @param {string} sourceSeed - Base64 recovery seed for the source ledger.
   * @param {object[]} sourceChain - Raw chain blocks from the source ledger.
   * @returns {Promise<ImportPreview>} Preview with entryCount, dateRange, conflicts.
   * @throws {ImportException} If source seed matches target (self-import guard).
   */
  async dryRun(sourceSeed, sourceChain) {
    const sourceMK = this._validateSeed(sourceSeed);

    const entries = await EntryImporter.extractEntries(sourceChain, this.targetCrypto, sourceMK);

    // Build date range
    const dates = new Set();
    for (const e of entries) {
      if (e.start_epoch) dates.add(EntryImporter._deriveDate(e, this.targetCrypto, sourceMK));
    }
    const sortedDates = [...dates].sort();
    const dateRange = sortedDates.length > 0
      ? { first: sortedDates[0], last: sortedDates[sortedDates.length - 1] }
      : { first: null, last: null };

    const targetBlocks = await this.targetChain.readAll();
    const conflicts = await EntryImporter.detectConflicts(sortedDates, targetBlocks);

    return new ImportPreview({
      entryCount: entries.length,
      dateRange,
      conflicts,
    });
  }

  /**
   * Execute the full import pipeline.
   *
   * 1. Validates source seed ≠ target seed
   * 2. Extracts and decrypts source entries
   * 3. Detects date conflicts (rejects unless force: true)
   * 4. Deduplicates against target (by content_hash)
   * 5. Re-encrypts entries for target MK
   * 6. Builds day blocks and appends to target chain
   *
   * @param {string} sourceSeed - Base64 recovery seed for the source ledger.
   * @param {object[]} sourceChain - Raw chain blocks from the source ledger.
   * @param {object} [opts] - Options.
   * @param {boolean} [opts.force=false] - Bypass date conflict rejection.
   * @returns {Promise<ImportResult>} Result with migrated/skipped/newBlock counts.
   * @throws {ImportException} On self-import, date conflicts (without force),
   *   or chain append failures.
   */
  async import(sourceSeed, sourceChain, opts = {}) {
    const { force = false } = opts;
    const sourceMK = this._validateSeed(sourceSeed);
    const targetMK = this.targetCrypto.getMasterKey();
    const targetBlocks = await this.targetChain.readAll();
    const { hashes: existingHashes, dates: targetDates } = this._collectTargetData(targetBlocks, targetMK);

    // Walk the source chain: re-encrypt each entry, skip duplicates
    let migratedCount = 0;
    let skippedCount = 0;
    const reencryptedEntries = [];
    const sourceDates = new Set();

    for (const block of sourceChain) {
      if (block.type !== 'day' || !block.entries) continue;
      for (const e of block.entries) {
        const data = EntryImporter._entryData(e);

        if (data.content_hash && existingHashes.has(data.content_hash)) {
          skippedCount++;
          continue;
        }

        // Track source date (for conflict detection below)
        try {
          const epochStr = this.targetCrypto.decrypt(data.startTime_enc, sourceMK);
          sourceDates.add(new Date(parseInt(epochStr, 10)).toISOString().slice(0, 10));
        } catch (_) { /* skip unparseable */ }

        reencryptedEntries.push(
          EntryImporter.reencryptEntry(data, this.targetCrypto, targetMK)
        );
        migratedCount++;
      }
    }

    // Detect date conflicts on NON-DEDUPED entries only
    const conflicts = [...sourceDates].filter(d => targetDates.has(d));

    if (conflicts.length > 0 && !force) {
      throw new ImportException(
        `Date conflicts detected: ${conflicts.join(', ')}. Use force:true to bypass.`,
        'DATE_CONFLICT'
      );
    }

    // Build and append day blocks
    const blockCountBefore = targetBlocks.length;
    await EntryImporter.buildAndAppendEntries(reencryptedEntries, this.targetChain, this.targetCrypto, targetMK);
    const blockCountAfter = (await this.targetChain.readAll()).length;

    return new ImportResult({
      migratedCount,
      skippedCount,
      newBlockCount: blockCountAfter - blockCountBefore,
    });
  }

  /** Parse a Uint8Array into a JSON chain array, or throw. */
  _parseChainBuffer(jsonBuffer) {
    try {
      const text = new TextDecoder().decode(jsonBuffer);
      const chain = JSON.parse(text);
      if (!Array.isArray(chain)) {
        throw new ImportException(
          'JSON buffer must contain a chain array', 'PARSE_ERROR'
        );
      }
      return chain;
    } catch (err) {
      if (err instanceof ImportException) throw err;
      throw new ImportException(
        'Failed to parse JSON buffer — ' + err.message, 'PARSE_ERROR'
      );
    }
  }

  /**
   * Import entries from a JSON buffer (e.g., file picker result).
   *
   * Parses the buffer as a JSON chain array, then delegates to import().
   *
   * @param {Uint8Array} jsonBuffer - Raw bytes of a ledger JSON file.
   * @param {string} sourceSeed - Base64 recovery seed for the source ledger.
   * @returns {Promise<ImportResult>} Result with migrated/skipped/newBlock counts.
   * @throws {ImportException} On parse failure or import errors.
   */
  async importFromFile(jsonBuffer, sourceSeed) {
    return this.import(sourceSeed, this._parseChainBuffer(jsonBuffer));
  }
}
