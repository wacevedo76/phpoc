/**
 * commonplace_chain.js — Commonplace sealed chain (ADR-031).
 *
 * A separate, sealed append-only chain holding its own `commonplace_genesis`
 * followed by `commonplace` day blocks. It shares the same Master Key as the
 * activity ledger (same seed → same MK) but is a structurally independent
 * chain with its own genesis, entry schema (`title`/`tags`/`entry`, optional
 * `ad_hoc`), and history — never mixing with the activity ledger (D7).
 *
 * Web contract (mirrors web LedgerChain + Flutter CommonplaceChain):
 *   new CommonplaceChain(crypto, store, masterKey, identitySecret = null)
 *   - reads/writes StorageBackend under key "commonplace:blocks"
 *   - buildGenesis() appends immediately; buildDayBlock() does NOT append
 *   - the genesis mirrors Flutter's flattened identity shape (NOT the web
 *     ledger's nested `identity: {...}`) for cross-client byte parity.
 *
 * Mirrors `LedgerChain` (Axiom B5) so cross-client parity stays cheap.
 */

import {
  jsonSort,
  computeEntryHash,
  verifyEntryHash,
  computeContentHash,
  isFormatVersionAtLeast,
  CONTENT_HASH_REQUIRED_VERSION,
  ZERO_HASH_64,
} from '../ledger/utils.js';
import { selectSealFields, computeSeal } from '../ledger/seal_fields.js';

const BLOCKS_KEY = 'commonplace:blocks';

export class CommonplaceChain {
  /**
   * @param {object} crypto - CryptoService-like object with seal/verifySeal/mac/verifyMac/encrypt/decrypt/sha256.
   * @param {import('../sync/storage.js').StorageBackend} store - StorageBackend instance.
   * @param {string} masterKey - Hex master key for sealing/encryption.
   * @param {string|null} [identitySecret=null] - Optional identity secret for MAC computation.
   */
  constructor(crypto, store, masterKey, identitySecret = null) {
    this.crypto = crypto;
    this.store = store;
    this.masterKey = masterKey;
    this.identitySecret = identitySecret;
  }

  // ── Store access helpers ──────────────────────────────────────────

  async _getBlocks() {
    const blocks = await this.store.get(BLOCKS_KEY);
    return Array.isArray(blocks) ? blocks : [];
  }

  async _saveBlocks(blocks) {
    await this.store.set(BLOCKS_KEY, blocks);
  }

  // ── Seal / MAC helpers ────────────────────────────────────────────

  /** Verify an HMAC-like seal over a dict (mirrors LedgerChain.verifySeal). */
  verifySeal(data, sealHex) {
    if (this.crypto.verifySeal(jsonSort(data), sealHex, this.masterKey)) {
      return true;
    }
    const canonicalJson = jsonSort(data);
    if (this.crypto.hmacHex(this.masterKey, canonicalJson) === sealHex) {
      return true;
    }
    return false;
  }

  /** Verify an identity MAC over a hash. */
  verifyIdentityMac(dataStr, macTag) {
    return this.crypto.verifyMac(dataStr, macTag, this.identitySecret);
  }

  // ── Block access ──────────────────────────────────────────────────

  async getBlockCount() {
    const blocks = await this._getBlocks();
    return blocks.length;
  }

  async getBlock(index) {
    const blocks = await this._getBlocks();
    if (blocks.length === 0) return null;
    if (index < 0) index = blocks.length + index;
    if (index < 0 || index >= blocks.length) return null;
    return blocks[index];
  }

  async getLastBlock() {
    const blocks = await this._getBlocks();
    return blocks.length > 0 ? blocks[blocks.length - 1] : null;
  }

  async readAll() {
    return await this._getBlocks();
  }

  async getDayBlocks() {
    const blocks = await this._getBlocks();
    return blocks.filter((b) => b.type === 'commonplace');
  }

  /** Resolve the hash key for a Commonplace block (genesis→block_hash, day→day_hash). */
  getBlockHashFor(block) {
    const type = block && block.type;
    if (type === 'commonplace_genesis') return block.block_hash || '';
    if (type === 'commonplace') return block.day_hash || '';
    return block.block_hash || block.day_hash || '';
  }

  /** The cached master-key hex the chain seals under. */
  getMasterKeyHex() {
    return this.masterKey;
  }

  // ── Block building ────────────────────────────────────────────────

  /**
   * Build and APPEND the Commonplace genesis block (mirrors Flutter — the
   * Commonplace genesis appends immediately so a fresh chain is verifiable).
   *
   * @param {object} opts
   * @param {string} opts.username
   * @param {string} opts.email
   * @param {string} opts.recoverySeedEnc
   * @param {string} opts.identityPubKey
   * @param {string} opts.identitySecretEncFallback
   * @param {string} [opts.formatVersion='0.4.0']
   * @returns {Promise<object>} The genesis block.
   */
  async buildGenesis({
    username,
    email,
    recoverySeedEnc,
    identityPubKey,
    identitySecretEncFallback,
    formatVersion = '0.4.0',
  }) {
    if ((await this.getBlockCount()) > 0) {
      throw new Error('Commonplace chain already has blocks — cannot create genesis');
    }

    const gen = {
      type: 'commonplace_genesis',
      day_index: 0,
      prev_hash: ZERO_HASH_64,
      entries: [],
      format_version: formatVersion,
      key_version: 1,
      username,
      email,
      recovery_seed_enc: recoverySeedEnc,
      identity_pub_key: identityPubKey,
      identity_secret_enc_fallback: identitySecretEncFallback,
    };

    // block_hash = seal over the canonical genesis whitelist fields.
    gen.block_hash = computeSeal(gen, this.crypto, this.masterKey);

    if (this.identitySecret) {
      gen.identity_seal = this.crypto.mac(gen.block_hash, this.identitySecret);
    }

    await this._saveBlocks([gen]);
    return gen;
  }

  /**
   * Build a Commonplace day block (does NOT append unless the caller appends).
   *
   * Raw Commonplace entries ({title, tags, entry[, ad_hoc], timestamp_ms[, date]})
   * are encrypted here — `title`/`entry`/`tags`/`ad_hoc` become `_enc` fields so
   * nothing is plaintext at rest (D2) — and content hashes are computed over the
   * encrypted data. Already-encrypted `{hash, data}` maps pass through with
   * content hashes recomputed. The block carries type=commonplace.
   *
   * @param {object[]} entries - Raw Commonplace entry dicts or {hash, data} pairs.
   * @param {string} prevHash - Hash of the preceding block.
   * @param {string} dateStr - ISO date string (YYYY-MM-DD).
   * @param {number} [keyVersion=1] - Key version (default 1).
   * @returns {Promise<object>} The constructed day block.
   */
  async buildDayBlock(entries, prevHash, dateStr, keyVersion = 1) {
    const existingDays = (await this.getDayBlocks()).length;
    const dayIndex = existingDays === 0 ? 1 : existingDays + 1;

    const normalizedEntries = [];
    for (const entry of entries) {
      let data;
      let alreadySealed = false;
      if (entry && typeof entry === 'object' && 'data' in entry) {
        data = Object.assign({}, entry.data);
        alreadySealed = true;
      } else {
        data = Object.assign({}, entry);
      }

      // Strip staging-only fields.
      delete data.is_active;
      delete data.unsealed;
      delete data.entry_id;
      delete data.device_uuid;
      delete data.hash;

      if (!alreadySealed) {
        data = this._encryptCommonplaceEntry(data, dateStr);
      }

      // Compute & record the content hash over the (encrypted) entry data.
      data.content_hash = computeContentHash(data, this.crypto, this.masterKey);

      normalizedEntries.push({
        hash: computeEntryHash(data, this.crypto),
        data,
      });
    }

    const block = {
      type: 'commonplace',
      date: dateStr,
      day_index: dayIndex,
      prev_hash: prevHash,
      entries: normalizedEntries,
      key_version: keyVersion,
    };

    block.day_hash = computeSeal(block, this.crypto, this.masterKey);

    if (this.identitySecret) {
      block.identity_seal = this.crypto.mac(block.day_hash, this.identitySecret);
    }

    return block;
  }

  // ── Append / truncate ─────────────────────────────────────────────

  /** Reject block types that don't belong to the Commonplace chain (ADR-029a). */
  _assertAllowedType(block) {
    const type = block && block.type;
    if (type !== 'commonplace' && type !== 'commonplace_genesis') {
      throw new Error(`Unknown/foreign block type for Commonplace chain: ${type}`);
    }
  }

  async append(block) {
    this._assertAllowedType(block);
    const blocks = await this._getBlocks();
    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      const expectedPrev = this.getBlockHashFor(last);
      const actualPrev = block.prev_hash || '';
      if (expectedPrev && actualPrev !== expectedPrev) {
        throw new Error(
          `prev_hash mismatch: expected ${expectedPrev.slice(0, 12)}…, got ${actualPrev.slice(0, 12)}…`
        );
      }
    }
    blocks.push(block);
    await this._saveBlocks(blocks);
  }

  async appendBlocks(blocks) {
    if (!blocks || blocks.length === 0) return;
    for (const b of blocks) this._assertAllowedType(b);

    const existing = await this._getBlocks();

    if (existing.length > 0) {
      const expectedPrev = this.getBlockHashFor(existing[existing.length - 1]);
      const firstPrev = blocks[0].prev_hash || '';
      if (expectedPrev && firstPrev !== expectedPrev) {
        throw new Error(
          `Bridge prev_hash mismatch: expected ${expectedPrev.slice(0, 12)}…, got ${firstPrev.slice(0, 12)}…`
        );
      }
    }

    for (let i = 1; i < blocks.length; i++) {
      const expected = this.getBlockHashFor(blocks[i - 1]);
      const actual = blocks[i].prev_hash || '';
      if (expected && actual !== expected) {
        throw new Error(
          `Internal prev_hash mismatch at index ${i}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`
        );
      }
    }

    existing.push(...blocks);
    await this._saveBlocks(existing);
  }

  /**
   * Remove `removeCount` blocks from the end, preserving at least the genesis.
   * @returns {Promise<object[]>} The removed blocks.
   */
  async truncate(removeCount) {
    const blocks = await this._getBlocks();
    if (removeCount <= 0 || blocks.length === 0) return [];
    const keepCount = Math.max(1, blocks.length - removeCount);
    if (keepCount >= blocks.length) return [];
    const removed = blocks.splice(keepCount);
    await this._saveBlocks(blocks);
    return removed;
  }

  // ── Verification ──────────────────────────────────────────────────

  async verify() {
    const blocks = await this._getBlocks();
    if (blocks.length === 0) return true;

    const genesis = blocks[0];
    const genesisKv = genesis.key_version ?? 1;
    const requireContentHash = isFormatVersionAtLeast(genesis, CONTENT_HASH_REQUIRED_VERSION);

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];

      // prev_hash linkage
      if (i > 0 && block.prev_hash !== this.getBlockHashFor(blocks[i - 1])) {
        return false;
      }

      // Block seal
      if (!this._verifyBlockSeal(block)) return false;

      // Identity seal (optional signing parity)
      if (this.identitySecret && 'identity_seal' in block) {
        const hash = this.getBlockHashFor(block);
        if (!this.crypto.verifyMac(hash, block.identity_seal, this.identitySecret)) {
          return false;
        }
      }

      // Entry hashes + content hashes + key-version invariant (day blocks)
      if (block.type === 'commonplace') {
        for (const entry of block.entries || []) {
          const data = entry && entry.data;
          const hash = entry && entry.hash;
          if (!data || !hash) return false;

          if (!verifyEntryHash(data, hash, this.crypto)) return false;

          const contentHash = data.content_hash;
          const hasContentHash = contentHash !== undefined && contentHash !== null && contentHash !== '';
          if (requireContentHash && !hasContentHash) return false;
          if (hasContentHash && computeContentHash(data, this.crypto, this.masterKey) !== data.content_hash) return false;
        }

        const blockKv = block.key_version ?? 1;
        if (blockKv > genesisKv) return false;
      }
    }

    return true;
  }

  /** Verify a single block's seal against the ADR-029a per-type whitelist. */
  _verifyBlockSeal(block) {
    const type = block && block.type;
    let hashKey;
    if (type === 'commonplace_genesis') hashKey = 'block_hash';
    else if (type === 'commonplace') hashKey = 'day_hash';
    else return false;

    let checkData;
    try {
      checkData = selectSealFields(block);
    } catch (_) {
      return false;
    }

    return this.verifySeal(checkData, block[hashKey]);
  }

  // ── Entry encrypt/decrypt helpers ─────────────────────────────────

  /**
   * Encrypt a raw Commonplace entry's content fields for sealed storage.
   * `title`→`title_enc`, `entry`→`entry_enc`, `tags`→`tags_enc`,
   * `ad_hoc`→`ad_hoc_enc` (only when present & non-empty). `type`,
   * `timestamp_ms`, and `date` stay plaintext (not content). No `comment`
   * field exists in the Commonplace schema (ADR-031 — `entry` replaces it).
   */
  _encryptCommonplaceEntry(data, dateStr) {
    const type = data.type || 'commonplace';
    const title = data.title || '';
    const entryText = data.entry || '';
    const tags = (data.tags || []).map((t) => String(t));
    const adHoc =
      data.ad_hoc && typeof data.ad_hoc === 'object' && !Array.isArray(data.ad_hoc)
        ? Object.assign({}, data.ad_hoc)
        : null;
    const timestampMs = data.timestamp_ms;

    const out = {
      type,
      timestamp_ms: Number.isInteger(timestampMs) ? timestampMs : 0,
      date: data.date || dateStr,
      title_enc: this.crypto.encrypt(title, this.masterKey),
      entry_enc: this.crypto.encrypt(entryText, this.masterKey),
      tags_enc: this.crypto.encrypt(JSON.stringify(tags), this.masterKey),
    };

    if (adHoc && Object.keys(adHoc).length > 0) {
      out.ad_hoc_enc = this.crypto.encrypt(JSON.stringify(adHoc), this.masterKey);
    }

    return out;
  }

  /**
   * Decrypt one Commonplace entry's encapsulated fields back to plaintext.
   * Returns the public read shape: {title, entry, tags, timestamp_ms, date,
   * [ad_hoc], [type]}.
   */
  decryptEntryData(data) {
    const result = {};

    result.title = data.title_enc !== undefined ? this._tryDecrypt(data.title_enc) : '';
    result.entry = data.entry_enc !== undefined ? this._tryDecrypt(data.entry_enc) : '';

    let tags = [];
    if (data.tags_enc !== undefined) {
      try {
        tags = JSON.parse(this.crypto.decrypt(data.tags_enc, this.masterKey)).map((e) => String(e));
      } catch (_) {
        tags = [];
      }
    }
    result.tags = tags;

    if (data.ad_hoc_enc !== undefined) {
      try {
        result.ad_hoc = JSON.parse(this.crypto.decrypt(data.ad_hoc_enc, this.masterKey));
      } catch (_) {
        result.ad_hoc = {};
      }
    }

    result.timestamp_ms = data.timestamp_ms;
    result.date = data.date;
    if (data.type !== undefined) result.type = data.type;

    return result;
  }

  _tryDecrypt(ciphertext) {
    try {
      return this.crypto.decrypt(ciphertext, this.masterKey);
    } catch (_) {
      return '';
    }
  }
}
