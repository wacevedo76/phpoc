/**
 * commonplace_storage.js — Commonplace export/import persistence (ADR-031).
 *
 * Web contract (decision #2): export/import persistence only. The live chain
 * lives under "commonplace:blocks" (the StorageBackend already fills the
 * block-store role). This class persists the portable shape
 *   {"type":"commonplace_chain","genesis":…,"blocks":[…]}
 * under key "commonplace:export".
 *
 * On-export content is the sealed chain — every Commonplace content field is
 * already encrypted at rest, so no plaintext title/entry/tags/ad-hoc reaches
 * the export (D2). Staging is never serialized (D11): only genesis + sealed
 * day blocks are written. The storage key is decoupled from master-key
 * derivation (ADR-031 §10).
 */

const BLOCKS_KEY = 'commonplace:blocks';
const EXPORT_KEY = 'commonplace:export';

export class CommonplaceStorage {
  /**
   * @param {import('../sync/storage.js').StorageBackend} store - StorageBackend instance.
   */
  constructor(store) {
    this.store = store;
  }

  /**
   * Persist the current live chain (genesis + day blocks) as a standalone
   * export under "commonplace:export".
   */
  async save() {
    const blocks = (await this.store.get(BLOCKS_KEY)) || [];
    const genesis = blocks.find((b) => b && b.type === 'commonplace_genesis') || null;
    const out = {
      type: 'commonplace_chain',
      genesis,
      blocks,
    };
    await this.store.set(EXPORT_KEY, out);
  }

  /**
   * Load a "commonplace:export" into the live "commonplace:blocks" chain.
   *
   * A missing export leaves the chain untouched (fresh / genesis-able). A
   * corrupt export surfaces an error rather than crashing.
   */
  async load() {
    const raw = await this.store.get(EXPORT_KEY);
    if (raw === null || raw === undefined) {
      return;
    }

    let decoded;
    try {
      decoded = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      throw new Error(`Corrupt commonplace export: ${e.message}`);
    }

    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('Corrupt commonplace export: expected a JSON object');
    }

    const blocks = [];
    const genesis = decoded.genesis;
    if (genesis && typeof genesis === 'object' && genesis.type === 'commonplace_genesis') {
      blocks.push(genesis);
    }

    if (Array.isArray(decoded.blocks)) {
      for (const b of decoded.blocks) {
        if (!b || typeof b !== 'object') continue;
        // A genesis stored inside `blocks` is the same object as `genesis`;
        // keep it once.
        if (b.type === 'commonplace_genesis' && genesis && genesis.type === 'commonplace_genesis') {
          continue;
        }
        blocks.push(b);
      }
    }

    await this.store.set(BLOCKS_KEY, blocks);
  }

  /**
   * Replace the ENTIRE live chain with [blocks] (genesis slot + block list).
   * Used by re-key flows to persist a re-encrypted chain in place.
   */
  async replaceAll(blocks) {
    await this.store.set(BLOCKS_KEY, Array.isArray(blocks) ? blocks : []);
  }
}
