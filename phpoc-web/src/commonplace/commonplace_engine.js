/**
 * commonplace_engine.js — Commonplace engine (commit / verify / read).
 *
 * Unified public API coordinating a CommonplaceChain over a StorageBackend.
 * Mirrors the ledger engine (Axiom B5): staging → commit (D11) seals
 * Commonplace entries into day-grouped sealed blocks; reading decrypts them
 * back. `commit` derives the date from timestamp_ms (UTC).
 */

import { CommonplaceChain } from './commonplace_chain.js';
import { ZERO_HASH_64 } from '../ledger/utils.js';

/** Number of leading hash chars `commit` returns as its completion prefix. */
const HASH_PREFIX_LENGTH = 10;

/** Convert epoch milliseconds to a YYYY-MM-DD UTC date string. */
function epochToDate(epochMs) {
  const d = new Date(epochMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class CommonplaceEngine {
  /**
   * @param {object} crypto - CryptoService-like object.
   * @param {import('../sync/storage.js').StorageBackend} store - StorageBackend instance.
   * @param {string} masterKey - Hex master key.
   * @param {string|null} [identitySecret=null] - Optional identity secret for signing.
   */
  constructor(crypto, store, masterKey, identitySecret = null) {
    this.crypto = crypto;
    this.store = store;
    this.masterKey = masterKey;
    this.identitySecret = identitySecret;
    this.chain = new CommonplaceChain(crypto, store, masterKey, identitySecret);
  }

  // ── Genesis ───────────────────────────────────────────────────────

  async buildGenesis(opts) {
    return await this.chain.buildGenesis(opts);
  }

  // ── Commit ────────────────────────────────────────────────────────

  /**
   * Seal staged Commonplace entries into sealed day blocks (one per UTC date).
   * Returns the first 10 chars of the last block hash, or null if no entries.
   * @param {object[]} entries - Raw Commonplace entries ({title, tags, entry[, ad_hoc], timestamp_ms}).
   * @returns {Promise<string|null>}
   */
  async commit(entries) {
    if (!entries || entries.length === 0) return null;

    // Group by UTC date (derived from timestamp_ms) BEFORE preparing.
    const byDate = {};
    for (const entry of entries) {
      const ts = entry.timestamp_ms;
      const date = epochToDate(ts);
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(entry);
    }

    const dates = Object.keys(byDate).sort();

    const lastBlock = await this.chain.getLastBlock();
    let prevHash = lastBlock ? this.chain.getBlockHashFor(lastBlock) : ZERO_HASH_64;

    let lastHash = '';
    for (const date of dates) {
      const rawEntries = byDate[date];
      const dayBlock = await this.chain.buildDayBlock(rawEntries, prevHash, date);
      await this.chain.append(dayBlock);
      prevHash = this.chain.getBlockHashFor(dayBlock);
      lastHash = prevHash;
    }

    if (!lastHash) return null;
    return lastHash.length >= HASH_PREFIX_LENGTH ? lastHash.slice(0, HASH_PREFIX_LENGTH) : lastHash;
  }

  // ── Verify ────────────────────────────────────────────────────────

  async verify() {
    return await this.chain.verify();
  }

  // ── Read ──────────────────────────────────────────────────────────

  /** Return all committed Commonplace entries in chain order, decrypted. */
  async readEntries() {
    const result = [];
    const dayBlocks = await this.chain.getDayBlocks();
    for (const block of dayBlocks) {
      for (const entry of block.entries || []) {
        if (!entry || !entry.data) continue;
        result.push(this.chain.decryptEntryData(entry.data));
      }
    }
    return result;
  }

  // ── Block access delegates ────────────────────────────────────────

  async getBlockCount() {
    return await this.chain.getBlockCount();
  }

  async readAll() {
    return await this.chain.readAll();
  }

  async getDayBlocks() {
    return await this.chain.getDayBlocks();
  }

  async getLastBlock() {
    return await this.chain.getLastBlock();
  }
}
