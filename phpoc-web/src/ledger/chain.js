/**
 * LedgerChain — block-level chain operations.
 *
 * Handles construction, sealing, signing, appending, truncation, and
 * verification of individual blocks in the append-only ledger chain.
 *
 * Option B: consumes StorageBackend (MemoryBackend) directly
 * via key convention "ledger:blocks".
 *
 * Usage:
 *   import { LedgerChain } from './chain.js';
 *   const chain = new LedgerChain(crypto, store, masterKey, identitySecret);
 *   const block = await chain.buildDayBlock(entries, prevHash, dateStr);
 *   await chain.append(block);
 *   const valid = await chain.verify();
 */

import { jsonSort, computeEntryHash, getBlockHash, verifyEntryHash } from './utils.js';
import { selectSealFields, computeSeal } from './seal_fields.js';

const BLOCKS_KEY = 'ledger:blocks';

// Default format_version when genesis has none (pre-spec, implicit 0.2.0)
const DEFAULT_FORMAT_VERSION = [0, 2, 0];
// Content hash is required at this version and above
const CONTENT_HASH_REQUIRED_VERSION = [0, 4, 0];

/**
 * Parse format_version from a genesis block into an array of ints.
 * Returns [0, 2, 0] if genesis is null/undefined or has no format_version.
 */
function parseFormatVersion(genesis) {
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
function isFormatVersionAtLeast(genesis, minimum) {
  const actual = parseFormatVersion(genesis);
  const maxLen = Math.max(actual.length, minimum.length);
  for (let i = 0; i < maxLen; i++) {
    const a = actual[i] || 0;
    const m = minimum[i] || 0;
    if (a > m) return true;
    if (a < m) return false;
  }
  return true; // equal
}

export class LedgerChain {
  /**
   * @param {object} crypto - CryptoService-like object with seal/verifySeal/mac/verifyMac.
   * @param {import('../sync/storage.js').StorageBackend} store - StorageBackend instance.
   * @param {string} masterKey - Hex master key for sealing.
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

  // ── Seal / Sign helpers ───────────────────────────────────────────

  /**
   * Compute an HMAC-like seal over a dict using deterministic JSON serialization.
   * @param {object} data - The data to seal.
   * @returns {string} 64-character hex seal.
   */
  computeSeal(data) {
    return this.crypto.seal(jsonSort(data), this.masterKey);
  }

  /**
   * Verify an HMAC-like seal over a dict.
   * Tries Python-compatible JSON serialization first, then falls back
   * to the pre-migration compact JSON format for existing ledgers.
   * @param {object} data - The data to verify.
   * @param {string} sealHex - The seal hex string.
   * @returns {boolean} True if the seal is valid.
   */
  verifySeal(data, sealHex) {
    // Primary: derived seal key via WASM (matches Python per PHPSPEC §5.2)
    if (this.crypto.verifySeal(jsonSort(data), sealHex, this.masterKey)) {
      return true;
    }
    // Backward compat: raw MK (old Flutter blocks pre-2026-07)
    const canonicalJson = jsonSort(data);
    if (this.crypto.hmacHex(this.masterKey, canonicalJson) === sealHex) {
      return true;
    }
    // Fallback: pre-migration compact JSON format (JS-only)
    const _sortObj = (obj) => {
      if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(_sortObj);
      return Object.keys(obj).sort().reduce((acc, k) => {
        acc[k] = _sortObj(obj[k]);
        return acc;
      }, {});
    };
    const compactJson = JSON.stringify(_sortObj(data));
    return this.crypto.verifySeal(compactJson, sealHex, this.masterKey);
  }

  /**
   * Compute an identity MAC.
   * Always delegates to crypto.mac — for the test mock, even a null/undefined
   * secret produces a deterministic hex string. In production, a proper
   * identity secret would be required.
   * @param {string} dataStr - The string to MAC (typically a hash).
   * @returns {string} 64-character hex MAC.
   */
  computeIdentityMac(dataStr) {
    return this.crypto.mac(dataStr, this.identitySecret);
  }

  /**
   * Verify an identity MAC.
   * @param {string} dataStr - The string that was MAC'd.
   * @param {string} macTag - The MAC hex string.
   * @returns {boolean} True if the MAC is valid.
   */
  verifyIdentityMac(dataStr, macTag) {
    return this.crypto.verifyMac(dataStr, macTag, this.identitySecret);
  }

  // ── Block access ──────────────────────────────────────────────────

  /**
   * Total number of blocks in the chain.
   * @returns {Promise<number>}
   */
  async getBlockCount() {
    const blocks = await this._getBlocks();
    return blocks.length;
  }

  /**
   * Get a single block by index (supports negative indexing).
   * @param {number} index - Block index (0-based). Negative values count from the end.
   * @returns {Promise<object|null>} The block, or null if out of range.
   */
  async getBlock(index) {
    const blocks = await this._getBlocks();
    if (blocks.length === 0) {
      return null;
    }
    if (index < 0) {
      index = blocks.length + index;
    }
    if (index < 0 || index >= blocks.length) {
      return null;
    }
    return blocks[index];
  }

  /**
   * Get the most recent block.
   * @returns {Promise<object|null>}
   */
  async getLastBlock() {
    const blocks = await this._getBlocks();
    return blocks.length > 0 ? blocks[blocks.length - 1] : null;
  }

  /**
   * Read the full chain as a list (returns a copy).
   * @returns {Promise<object[]>}
   */
  async readAll() {
    return await this._getBlocks();
  }

  // ── Block building ────────────────────────────────────────────────

  /**
   * Build a day block with proper sealing and optional identity signature.
   *
   * Reads the chain state to determine the correct day_index. Entries are
   * normalized — raw dicts and pre-hashed {"hash", "data"} pairs are both
   * accepted, and the hash is always recomputed from the actual data.
   *
   * @param {object[]} entries - List of entry dicts. Each may be:
   *   {"hash": string, "data": object} (pre-hashed), or a raw dict.
   *   Hash is always recomputed from the actual data.
   * @param {string} prevHash - The hash of the preceding block.
   * @param {string} dateStr - ISO date string (YYYY-MM-DD).
   * @returns {Promise<object>} The constructed day block.
   */
  async buildDayBlock(entries, prevHash, dateStr) {
    const blocks = await this._getBlocks();

    // Determine day_index
    let dayIndex = 1;
    // Find the last day-type block
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === 'day') {
        dayIndex = (blocks[i].day_index || 0) + 1;
        break;
      }
    }

    // Normalize entries
    const normalizedEntries = [];
    for (const e of entries) {
      let data;
      if (e.hash !== undefined && e.data !== undefined) {
        data = e.data;
      } else {
        data = Object.assign({}, e);
      }
      const entryHash = computeEntryHash(data, this.crypto);
      normalizedEntries.push({ hash: entryHash, data });
    }

    const dayContent = {
      type: 'day',
      day_index: dayIndex,
      date: dateStr,
      prev_hash: prevHash,
      entries: normalizedEntries,
    };

    dayContent.day_hash = computeSeal(dayContent, this.crypto, this.masterKey);

    if (this.identitySecret) {
      dayContent.identity_seal = this.crypto.mac(dayContent.day_hash, this.identitySecret);
    }

    return dayContent;
  }

  /**
   * Build a genesis block according to PHPSPEC §4.1.
   *
   * The genesis block carries the user's identity (username, email),
   * encrypted recovery seed, and encrypted identity secret. It is
   * HMAC-sealed with the sealing sub-key and optionally signed with
   * the generated identity secret.
   *
   * This method generates a new identity secret (32 random bytes),
   * sets it on the chain instance for subsequent block signing, and
   * returns the complete genesis block ready for append().
   *
   * Required crypto primitives:
   *   - generateSeed() / deriveMasterKey() — for identity secret
   *   - derivePdk() — PDK from passphrase (to encrypt seed)
   *   - encrypt() — encrypt seed with PDK, identity secret with MK
   *   - sha256() — derive identity_pub_key from identity secret
   *   - seal() — HMAC-SHA256 block seal
   *   - sign() — identity signature over day_hash
   *
   * @param {object} opts
   * @param {string} opts.username - Display name
   * @param {string} opts.email - Contact email
   * @param {string} opts.passphrase - User's passphrase (for PDK derivation)
   * @param {string} opts.seed - Base64 recovery seed
   * @returns {Promise<object>} The genesis block.
   */
  async buildGenesisBlock({ username, email, passphrase, seed }) {
    // 1. Generate identity secret (32 random bytes as hex)
    const identitySeed = this.crypto.generateSeed();
    const identitySecret = this.crypto.deriveMasterKey(identitySeed);

    // Store identity secret for future block signing
    this.identitySecret = identitySecret;

    // 2. Compute identity public key: SHA-256(identity_secret)
    const identityPubKey = this.crypto.sha256(identitySecret);

    // 3. Derive PDK from passphrase (PBKDF2, 600K iterations)
    const pdk = this.crypto.derivePdk(passphrase, 600000);

    // 4. Encrypt recovery seed with PDK
    const recoverySeedEnc = this.crypto.encrypt(seed, pdk);

    // 5. Encrypt identity secret with master key (fallback storage)
    const identitySecretEncFallback = this.crypto.encrypt(identitySecret, this.masterKey);

    // 6. Today's date
    const today = new Date().toISOString().slice(0, 10);

    // 7. Build genesis content (without seal / signature)
    // I-07: format_version removed from blocks (metadata only).
    // I-17: genesis uses block_hash instead of day_hash.
    const genesisContent = {
      type: 'genesis',
      day_index: 0,
      date: today,
      identity: {
        username,
        email,
        recovery_seed_enc: recoverySeedEnc,
        identity_pub_key: identityPubKey,
        identity_secret_enc_fallback: identitySecretEncFallback,
      },
      prev_hash: '0'.repeat(64),
      entries: [],
    };

    // 8. Compute block seal (block_hash per I-17) over the ADR-029a whitelist.
    // Identity (never a seal input) stays on the block but outside the seal.
    genesisContent.block_hash = computeSeal(genesisContent, this.crypto, this.masterKey);

    // 9. Sign with identity secret
    genesisContent.identity_seal = this.crypto.mac(genesisContent.block_hash, identitySecret);

    return genesisContent;
  }

  // ── Append / truncate ─────────────────────────────────────────────

  /**
   * Append a single block to the chain.
   * @param {object} block
   */
  async append(block) {
    const blocks = await this._getBlocks();
    // Verify prev_hash linkage to the last existing block
    if (blocks.length > 0) {
      const lastBlock = blocks[blocks.length - 1];
      const lastHash = getBlockHash(lastBlock);
      const newPrevHash = block.prev_hash;
      if (newPrevHash !== lastHash) {
        throw new Error(
          `Chain linkage broken: new block prev_hash ${newPrevHash.slice(0, 12)}…` +
          ` does not match last block hash ${lastHash.slice(0, 12)}…`
        );
      }
    }
    blocks.push(block);
    await this._saveBlocks(blocks);
  }

  /**
   * Append multiple blocks with linkage verification.
   *
   * Raises an error if any block's prev_hash does not match the
   * hash of the block just before it in the combined chain.
   *
   * @param {object[]} blocks - Ordered list of blocks to append.
   * @throws {Error} On linkage violation.
   */
  async appendBlocks(blocks) {
    if (!blocks || blocks.length === 0) {
      return;
    }

    const existing = await this._getBlocks();

    // Verify linkage across the bridge (last existing → first new)
    if (existing.length > 0) {
      const lastExisting = existing[existing.length - 1];
      const existingHash = getBlockHash(lastExisting);
      const firstNewPrevHash = blocks[0].prev_hash;
      if (firstNewPrevHash !== existingHash) {
        throw new Error(
          `Block 0 prev_hash ${firstNewPrevHash} does not match last block hash ${existingHash}`
        );
      }
    }

    // Verify linkage among the new blocks
    for (let i = 1; i < blocks.length; i++) {
      const prevBlock = blocks[i - 1];
      const prevBlockHash = getBlockHash(prevBlock);
      if (blocks[i].prev_hash !== prevBlockHash) {
        throw new Error(
          `Block ${i} prev_hash ${blocks[i].prev_hash} does not match block ${i - 1} hash ${prevBlockHash}`
        );
      }
    }

    // Append all blocks
    existing.push(...blocks);
    await this._saveBlocks(existing);
  }

  /**
   * Remove `removeCount` blocks from the end of the chain.
   *
   * Preserves at minimum the genesis block (block 0). Returns the
   * removed blocks for inspection.
   *
   * @param {number} removeCount - Number of blocks to remove from the end.
   * @returns {Promise<object[]>} List of removed block dicts.
   */
  async truncate(removeCount) {
    const blocks = await this._getBlocks();
    if (removeCount <= 0 || blocks.length === 0) {
      return [];
    }

    // Keep at minimum block 0 (genesis)
    const keepCount = Math.max(1, blocks.length - removeCount);
    if (keepCount >= blocks.length) {
      return [];
    }

    const removed = blocks.splice(keepCount);
    await this._saveBlocks(blocks);
    return removed;
  }

  /**
   * Truncate the chain to keep `keepCount` blocks from the start.
   *
   * Inverse of truncate() — specifies number of blocks to KEEP.
   * Returns the removed blocks. If keepCount >= total, returns [].
   *
   * @param {number} keepCount - Number of blocks to keep (from start).
   * @returns {Promise<object[]>} List of removed block dicts.
   */
  async truncate_keep(keepCount) {
    const blocks = await this._getBlocks();
    if (keepCount <= 0 || keepCount >= blocks.length) {
      return [];
    }

    const removed = blocks.splice(keepCount);
    await this._saveBlocks(blocks);
    return removed;
  }

  // ── Verification ──────────────────────────────────────────────────

  /**
   * Full chain verification.
   *
   * Checks:
   *   0. Block 0 seal integrity and entry hashes (if day block)
   *   1. prev_hash linkage between consecutive blocks
   *   2. Block seal integrity (day_hash/month_hash/year_hash) for all blocks
   *   3. Identity signature (if present)
   *   4. Entry hashes within day blocks
   *   5. Content hash verification — required at format_version >= 0.4.0
   *
   * @returns {Promise<boolean>} True if the entire chain is valid.
   */
  async verify() {
    const ledger = await this._getBlocks();
    if (ledger.length === 0) {
      return true;
    }

    // Determine whether content_hash is required from genesis format_version
    // (computed once and passed to _verifyBlockData — avoids per-block storage reads)
    const genesis = ledger[0];
    const requireContentHash = isFormatVersionAtLeast(genesis, CONTENT_HASH_REQUIRED_VERSION);

    // Check block 0 seal and entry hashes
    if (!(await this._verifyBlockData(ledger[0], 0, requireContentHash))) {
      return false;
    }

    // Check blocks 1+ including linkage
    for (let i = 1; i < ledger.length; i++) {
      const current = ledger[i];
      const prev = ledger[i - 1];

      // 1. prev_hash linkage
      if (current.prev_hash !== getBlockHash(prev)) {
        return false;
      }

      // 2+3+4+5. Block seal, signature, entry hashes, content_hash
      if (!(await this._verifyBlockData(current, i, requireContentHash))) {
        return false;
      }
    }

    return true;
  }

  /**
   * Verify a single block's data: seal, signature, entry hashes, and
   * content_hash.
   *
   * NOTE: This logic is intentionally duplicated in merge.js as
   * LedgerMerge._verifyBlockData() because LedgerMerge is a standalone
   * module with no LedgerChain dependency. Keep both implementations
   * in sync — any bug fix here must be mirrored there.
   *
   * @param {object} block - The block to verify.
   * @param {number} index - Block index (for context).
   * @param {boolean} [requireContentHash=false] - If true, content_hash is
   *   mandatory (format_version >= 0.4.0). Computed once by the caller from
   *   genesis to avoid per-block storage reads.
   * @returns {boolean} True if block data is valid.
   */
  async _verifyBlockData(block, index, requireContentHash = false) {
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

    // Build check data from the ADR-029a per-type whitelist (closed set).
    // format_version, key_version, identity, identity_seal, signature, and any
    // stray/future field are never seal inputs. Unknown types are rejected.
    let checkData;
    try {
      checkData = selectSealFields(block);
    } catch (_) {
      return false;
    }

    // 2. Block seal
    if (!this.verifySeal(checkData, block[hashKey])) {
      return false;
    }

    // 3. Identity seal (supports both 'identity_seal' and legacy 'signature')
    if (this.identitySecret) {
      const sealValue = block.identity_seal || block.signature;
      if (!sealValue) {
        return false;
      }
      if (!this.crypto.verifyMac(block[hashKey], sealValue, this.identitySecret)) {
        return false;
      }
    }

    // 4. Entry hashes in day blocks + content_hash verification
    if (type === 'day' && block.entries) {
      for (const entry of block.entries) {
        const data = entry.data;
        if (!verifyEntryHash(data, entry.hash, this.crypto)) {
          return false;
        }

        // 5. Content hash verification
        const hasContentHash = data.content_hash !== undefined
                            && data.content_hash !== null
                            && data.content_hash !== '';

        if (requireContentHash && !hasContentHash) {
          // format_version >= 0.4.0: content_hash is mandatory
          return false;
        }

        if (hasContentHash) {
          if (!this._verifyContentHash(data)) {
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
   * Uses the extensible algorithm:
   * - Fields ending in _enc are decrypted
   * - List fields are sorted for deterministic output
   * - content_hash itself is excluded
   * - sort_keys normalizes key ordering
   */
  _verifyContentHash(data) {
    // Extensible algorithm: decrypt _enc fields, sort lists, exclude content_hash,
    // then sha256(JSON.stringify with sort_keys).
    const content = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'content_hash') continue;
      if (key.endsWith('_enc') && value !== null && value !== '') {
        try {
          content[key] = this.crypto.decrypt(value, this.masterKey);
        } catch (_) {
          content[key] = value;
        }
      } else if (Array.isArray(value)) {
        content[key] = [...value].sort();
      } else {
        content[key] = value;
      }
    }
    const computed = this.crypto.sha256(jsonSort(content));
    if (computed === data.content_hash) return true;

    // Fallback: legacy v0.3.0 algorithm — hardcoded field order,
    // _enc values decrypted, JSON.stringify with indent=2 and no sort_keys.
    // Matches the original content_hash computation in pre-v0.4 test fixtures.
    const decrypt = (encVal) => {
      if (!encVal) return encVal;
      try {
        return this.crypto.decrypt(encVal, this.masterKey);
      } catch (_) {
        return encVal;
      }
    };
    // Keys in the exact insertion order used by legacy computation
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
    const legacyHash = this.crypto.sha256(JSON.stringify(legacyObj, null, 2));
    return legacyHash === data.content_hash;
  }

  /**
   * Verify a single block by index.
   *
   * For block 0 (genesis), checks only that its type is valid.
   * For subsequent blocks, checks prev_hash linkage against the
   * preceding block, plus seal + signature + entry hashes.
   *
   * @param {number} index - Block index.
   * @returns {Promise<boolean>} True if the block is valid.
   */
  async verifyBlock(index) {
    if (index < 0) {
      return false;
    }

    const block = await this.getBlock(index);
    if (!block) {
      return false;
    }

    if (index === 0) {
      return await this._verifyBlockData(block, 0);
    }

    const prev = await this.getBlock(index - 1);
    if (!prev) {
      return false;
    }

    const current = block;

    // 1. prev_hash linkage
    if (current.prev_hash !== getBlockHash(prev)) {
      return false;
    }

    return await this._verifyBlockData(current, index);
  }
}
