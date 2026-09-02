/**
 * commonplace_service.js — Application-layer service for the Commonplace Book
 * (ADR-031).
 *
 * The web analogue of Flutter's `CommonplaceService` / `commonplaceServiceProvider`.
 * It owns a `CommonplaceEngine` (over the shared StorageBackend, key
 * "commonplace:blocks") and presents the UI with read / add / verify / tag-index
 * operations. It shares the ledger's Master Key (same seed → same MK) but is a
 * structurally independent chain (D7).
 *
 * Web deltas vs Flutter (kept faithful to the port):
 *   - `buildTagIndex()` returns a plain JS object `{ [tag]: count }` (the Map
 *     equivalent) for React ergonomics + deterministic string-key ordering.
 *   - `createCommonplaceService({ crypto, store, masterKey, identitySecret })`
 *     is a pure factory (the Riverpod `commonplaceServiceProvider` analogue).
 */

import { CommonplaceEngine } from './commonplace_engine.js';

/**
 * Normalize a tag list: coerce to strings, trim, lower-case, and dedupe
 * (preserving first-seen order). Empty/blank tokens are dropped.
 */
function normalizeTags(tags) {
  const normalized = [];
  const seen = new Set();
  for (const tag of tags || []) {
    const token = String(tag).trim().toLowerCase();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    normalized.push(token);
  }
  return normalized;
}

export class CommonplaceService {
  /**
   * @param {object} crypto - CryptoService-like object.
   * @param {import('../sync/storage.js').StorageBackend} store - StorageBackend instance.
   * @param {string} masterKey - Hex master key (shared with the ledger, ADR-031).
   * @param {string|null} [identitySecret=null] - Optional identity secret for signing.
   */
  constructor(crypto, store, masterKey, identitySecret = null) {
    this.crypto = crypto;
    this.store = store;
    this.masterKey = masterKey;
    this.identitySecret = identitySecret;
    this.engine = new CommonplaceEngine(crypto, store, masterKey, identitySecret);
    this.chain = this.engine.chain;
  }

  // ── Read ──────────────────────────────────────────────────────────

  /** Committed, decrypted entries in chain order (delegates to the engine). */
  async readEntries() {
    return await this.engine.readEntries();
  }

  /** Total committed entries across all day blocks. */
  async getEntryCount() {
    const dayBlocks = await this.engine.getDayBlocks();
    let count = 0;
    for (const block of dayBlocks) {
      count += (block.entries || []).length;
    }
    return count;
  }

  /** Chain tip hash (genesis `block_hash` / day `day_hash`). */
  async getLastHash() {
    const last = await this.chain.getLastBlock();
    if (!last) return '';
    return this.chain.getBlockHashFor(last);
  }

  /** Frequency index `tag → count` (decrypt-and-scan; includes `untagged`). */
  async buildTagIndex() {
    const entries = await this.readEntries();
    const idx = {};
    for (const entry of entries) {
      const tags = (entry.tags || []).map((t) => String(t));
      if (tags.length === 0) {
        idx.untagged = (idx.untagged || 0) + 1;
        continue;
      }
      for (const tag of new Set(tags)) {
        idx[tag] = (idx[tag] || 0) + 1;
      }
    }
    return idx;
  }

  // ── Add ───────────────────────────────────────────────────────────

  /**
   * Commit a single passage (one-shot add — no staging table, D11 note below).
   * Tags are normalized (trim + lower-case + dedupe) before sealing. The
   * passage commits directly to an append-only sealed day block.
   *
   * @param {object} args
   * @param {string} args.title
   * @param {string[]} [args.tags=[]]
   * @param {string} args.entry
   * @param {object|null} [args.adHoc=null] - Optional ad-hoc k/v map.
   * @returns {Promise<string|null>} Commit prefix (or null if empty).
   */
  async addEntry({ title, tags = [], entry, adHoc = null }) {
    const raw = {
      title,
      tags: normalizeTags(tags),
      entry,
      timestamp_ms: Date.now(),
    };

    if (adHoc && typeof adHoc === 'object' && !Array.isArray(adHoc)) {
      raw.ad_hoc = adHoc;
    }

    return await this.engine.commit([raw]);
  }

  // ── Verify / genesis ──────────────────────────────────────────────

  async verify() {
    return await this.engine.verify();
  }

  /**
   * Bootstrap a missing chain with a genesis block (no-op when one exists).
   * Drawn from the ledger's shared identity/seed (ADR-031 — same MK).
   */
  async ensureGenesis(opts) {
    const count = await this.chain.getBlockCount();
    if (count > 0) return null;
    return await this.engine.buildGenesis(opts);
  }
}

/**
 * Pure factory returning a `CommonplaceService` bound to the given crypto +
 * store + master key (the web analogue of Flutter's `commonplaceServiceProvider`).
 */
export function createCommonplaceService({ crypto, store, masterKey, identitySecret = null }) {
  return new CommonplaceService(crypto, store, masterKey, identitySecret);
}
