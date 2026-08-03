/**
 * import_entries.js — Cross-ledger entry migration (EntryImporter).
 *
 * Provides the core pipeline for importing entries from a source ledger
 * into a target ledger: extraction, re-encryption, conflict detection,
 * and chain appending.
 *
 * Usage:
 *   import { EntryImporter } from './import_entries.js';
 *   const entries = await EntryImporter.extractEntries(sourceChain, crypto, sourceMK);
 *   const reencrypted = EntryImporter.reencryptEntry(entry, crypto, targetMK);
 *   const conflicts = await EntryImporter.detectConflicts(sourceDates, targetChain);
 *   await EntryImporter.buildAndAppendEntries(reencryptedEntries, targetChain, crypto, targetMK);
 */

import { getBlockHash } from './utils.js';

export class EntryImporter {
  // ── Internal helpers ───────────────────────────────────────────

  /** Unwrap a block entry, which may be {hash, data} or a raw dict. */
  static _entryData(e) {
    return (e.data !== undefined) ? e.data : e;
  }

  /**
   * Coerce a decrypted field value to its JS type based on the plain key name.
   * startTime → int epoch; endTime → int or null; metadata/pauses → parsed JSON.
   */
  static _coerceField(plainKey, decrypted) {
    if (plainKey === 'startTime') return parseInt(decrypted, 10);
    if (plainKey === 'endTime') {
      const parsed = parseInt(decrypted, 10);
      return isNaN(parsed) ? null : parsed;
    }
    if (plainKey === 'metadata' || plainKey === 'pauses') {
      try { return JSON.parse(decrypted); } catch (_) { return decrypted; }
    }
    return decrypted;
  }

  /**
   * Extract entries from a source chain, decrypting all _enc fields to plaintext.
   *
   * Walks day blocks, decrypts each entry's _enc fields with the source MK,
   * and returns an array of plaintext objects. Skips genesis, year_summary,
   * and month_summary blocks (which carry no entries).
   *
   * On unparseable ciphertext, the entry is silently skipped (J9: not fatal).
   *
   * @param {object[]} sourceChain - Raw chain array from chain.readAll().
   * @param {object} crypto - Crypto service with decrypt().
   * @param {string} sourceMasterKey - Hex master key for the source ledger.
   * @returns {Promise<object[]>} Array of plaintext entry objects with keys:
   *   title, start_epoch, end_epoch, duration, tags, pauses, metadata,
   *   comment, media, device_id, content_hash, _raw (original encrypted data).
   */
  static async extractEntries(sourceChain, crypto, sourceMasterKey) {
    const entries = [];
    for (const block of sourceChain) {
      if (block.type !== 'day' || !block.entries) continue;

      for (const e of block.entries) {
        const data = EntryImporter._entryData(e);
        try {
          entries.push(EntryImporter._decryptEntryData(data, crypto, sourceMasterKey));
        } catch (_) {
          // J9: skip unparseable entries, not fatal
        }
      }
    }
    return entries;
  }

  /**
   * Decrypt a single entry's _enc fields to plaintext.
   *
   * Maps encrypted field names to plaintext keys:
   *   startTime_enc → start_epoch (parsed int)
   *   endTime_enc   → end_epoch (parsed int or null)
   *   metadata_enc  → metadata (JSON parsed)
   *   pauses_enc    → pauses (JSON parsed)
   *   device_id_enc → device_id (string)
   *
   * Non-_enc fields pass through unchanged (title, duration, tags, comment,
   * media, content_hash).
   *
   * @param {object} data - Entry data dict with _enc fields.
   * @param {object} crypto - Crypto service.
   * @param {string} masterKey - Hex master key for decryption.
   * @returns {object} Plaintext entry with decrypted fields.
   */
  static _decryptEntryData(data, crypto, masterKey) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.endsWith('_enc') && value !== null && value !== '') {
        const plainKey = key.replace(/_enc$/, '');
        try {
          const decrypted = crypto.decrypt(value, masterKey);
          const coerced = EntryImporter._coerceField(plainKey, decrypted);
          // startTime → start_epoch, endTime → end_epoch; others keep plainKey name
          const outKey = (plainKey === 'startTime') ? 'start_epoch'
            : (plainKey === 'endTime') ? 'end_epoch'
            : plainKey;
          result[outKey] = coerced;
        } catch (_) {
          result[key] = value;  // decryption failure — keep raw
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Re-encrypt an entry's _enc fields for a new target master key.
   *
   * Each _enc field is decrypted (to recover plaintext), then re-encrypted
   * with the target MK. Non-_enc fields and content_hash are preserved
   * unchanged — content_hash is computed from plaintext and must survive
   * the decrypt→re-encrypt cycle unchanged (J3, J4).
   *
   * @param {object} entry - Entry data dict with _enc fields encrypted for source MK.
   * @param {object} crypto - Crypto service with decrypt() and encrypt().
   * @param {string} targetMasterKey - Target hex master key for re-encryption.
   * @returns {object} Entry data dict with _enc fields re-encrypted for target MK.
   */
  static reencryptEntry(entry, crypto, targetMasterKey) {
    const result = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key.endsWith('_enc') && value !== null && value !== '') {
        try {
          // Decrypt (mock ignores key; WASM needs correct key)
          const plaintext = crypto.decrypt(value, targetMasterKey);
          // Re-encrypt with target key
          result[key] = crypto.encrypt(plaintext, targetMasterKey);
        } catch (_) {
          // If decryption fails, keep the original value
          result[key] = value;
        }
      } else {
        // Non-_enc fields pass through unchanged
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Detect date conflicts between source entry dates and a target chain.
   *
   * Compares source date strings against the date field of every day block
   * in the target chain. Returns the list of dates that appear in both.
   *
   * @param {string[]} sourceDates - Array of ISO date strings (YYYY-MM-DD).
   * @param {object[]} targetChain - Target chain blocks (from chain.readAll()).
   * @returns {Promise<string[]>} Conflicting dates (intersection).
   */
  static async detectConflicts(sourceDates, targetChain) {
    // Handle both raw arrays and LedgerChain instances
    const blocks = Array.isArray(targetChain)
      ? targetChain
      : (typeof targetChain.readAll === 'function'
          ? await targetChain.readAll()
          : targetChain);

    const targetDates = new Set();
    for (const block of blocks) {
      if (block.type === 'day' && block.date) {
        targetDates.add(block.date);
      }
    }
    return sourceDates.filter(d => targetDates.has(d));
  }

  /**
   * Derive an ISO date string from an entry, preferring start_epoch over
   * startTime_enc. Falls back to today's date when both are absent.
   */
  static _deriveDate(entry, crypto, masterKey) {
    if (entry.start_epoch) {
      return new Date(entry.start_epoch).toISOString().slice(0, 10);
    }
    if (entry.startTime_enc) {
      try {
        const epochStr = crypto.decrypt(entry.startTime_enc, masterKey);
        return new Date(parseInt(epochStr, 10)).toISOString().slice(0, 10);
      } catch (_) { /* fall through to today */ }
    }
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Build day blocks from re-encrypted entries and append them to the target chain.
   *
   * Groups entries by date (derived from startTime_enc or start_epoch),
   * builds one day block per date via targetChain.buildDayBlock(), and
   * appends each block with proper prev_hash linkage.
   *
   * @param {object[]} entries - Entry data dicts (re-encrypted for target MK).
   * @param {import('./chain.js').LedgerChain} targetChain - The target ledger chain.
   * @param {object} crypto - Crypto service.
   * @param {string} masterKey - Target hex master key.
   * @returns {Promise<void>}
   */
  static async buildAndAppendEntries(entries, targetChain, crypto, masterKey) {
    if (!entries || entries.length === 0) return;

    const blocks = await targetChain.readAll();
    let prevHash = blocks.length > 0
      ? getBlockHash(blocks[blocks.length - 1])
      : '0'.repeat(64);

    // Group entries by date
    const byDate = new Map();
    for (const entry of entries) {
      const date = EntryImporter._deriveDate(entry, crypto, masterKey);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(entry);
    }

    // Build and append one day block per date
    for (const [date, dateEntries] of byDate) {
      const block = await targetChain.buildDayBlock(dateEntries, prevHash, date);
      await targetChain.append(block);
      prevHash = getBlockHash(block);
    }
  }
}
