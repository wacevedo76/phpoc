/**
 * WorkerImportSource — cloud backup source for remote import.
 *
 * Wraps an HttpTransport to list and fetch ledger backup files from
 * cloud storage (Cloudflare R2 via Worker, or any HTTP server with
 * prefix-listing support).
 *
 * Also supports pulling a raw chain directly from ledger/blocks/
 * (the format written by `ph sync`) for multi-device onboarding.
 *
 * Designed with an abstract interface so future storage providers
 * (S3 direct, Google Drive, etc.) can implement the same contract:
 *
 *   listBackups()          → Promise<string[]>  — sorted .json filenames
 *   fetchBackup(filename)  → Promise<Uint8Array|null> — file bytes or null
 *   validateConnection()   → Promise<{ok: bool, error?: string}>
 *
 * Static utilities (for chain-based import):
 *   checkForRemoteChain(transport)          → Promise<number> — block count or 0
 *   fetchChain(transport, crypto, masterKey) → Promise<object[]> — assembled chain
 *
 * Usage:
 *   import { HttpTransport } from './transport.js';
 *   import { WorkerImportSource } from './remote_import.js';
 *   const transport = new HttpTransport({ baseUrl: '...', apiKey: '...' });
 *   const source = new WorkerImportSource(transport);
 *   const files = await source.listBackups();
 *   const blob = await source.fetchBackup(files[0]);
 *
 * Architecture: SESSION_HANDOFF.md §Phase 5
 */

import { bytesToBase64 } from './base64.js';
import { REMOTE_LEDGER_BLOCKS_PREFIX } from './keys.js';
import { jsonSortIndent2 } from '../ledger/utils.js';

const _textDecoder = new TextDecoder();

export class WorkerImportSource {
  /**
   * @param {object} transport - An HttpTransport instance with:
   *   pull(path) → Promise<Uint8Array|null> and
   *   listFiles(prefix) → Promise<string[]>.
   * @param {object} [crypto] - Optional CryptoService for passphrase-only auth.
   *   Must provide verifySeal(data, sealHex, masterKey) and sha256(data).
   */
  constructor(transport, crypto) {
    this._transport = transport;
    this._crypto = crypto || null;
  }

  /**
   * Validate the connection to remote storage.
   * Attempts to list the backups/ prefix.
   *
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async validateConnection() {
    try {
      await this._transport.listFiles('backups/');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * List available backup files on the remote.
   *
   * Lists all files under the `backups/` prefix, filters to `.json`
   * files only, and sorts newest-first by filename (ISO timestamps).
   *
   * @returns {Promise<string[]>} Sorted list of backup filenames
   *   (e.g., "ph-ledger-full-export-2026-06-15.json").
   */
  async listBackups() {
    const files = await this._transport.listFiles('backups/');
    // Filter to .json files and sort newest-first
    const jsonFiles = files
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse(); // ISO date strings sort lexicographically, reverse = newest first
    return jsonFiles;
  }

  /**
   * Fetch a single backup file from remote storage.
   *
   * @param {string} filename - Filename (e.g., "ph-ledger-full-export-2026-06-15.json").
   *   Leading `backups/` prefix is normalized.
   * @returns {Promise<Uint8Array|null>} Raw file bytes, or null if 404.
   */
  async fetchBackup(filename) {
    // Normalize: filename may or may not have backups/ prefix
    const path = filename.startsWith('backups/') ? filename : `backups/${filename}`;
    return this._transport.pull(path);
  }

  /**
   * Fetch and parse a backup, returning validated import data.
   *
   * Combines fetchBackup() with import validation. Throws on any
   * validation failure (seal mismatch, bad hash, missing fields).
   *
   * Supports all three import formats: v1 export, v2 export, raw chain.
   *
   * @param {string} filename - Backup filename.
   * @param {string} masterKey - 64-char hex master key.
   * @returns {Promise<{
   *   entries: object[],
   *   count: number,
   *   genesisHash: string|null,
   *   formatVersion: string,
   *   ledger: object[]|null,
   *   genesisBlock: object|null,
   * }>}
   * @throws {Error} On fetch failure or validation failure.
   */
  async fetchAndValidate(filename, masterKey) {
    if (!this._crypto) {
      throw new Error('WorkerImportSource: crypto service is required for validation');
    }

    const raw = await this.fetchBackup(filename);

    if (raw === null || raw === undefined) {
      throw new Error(`Backup file not found: ${filename}`);
    }

    // Parse JSON
    let parsed;
    try {
      const jsonStr = _textDecoder.decode(raw);
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(`Invalid backup file format: ${err.message}`);
    }

    // Delegate to import validation
    return WorkerImportSource._validateImportData(parsed, this._crypto, masterKey);
  }

  // ═══════════════════════════════════════════════════════════════
  //  Static: Remote chain import (ledger/blocks/ format)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if a remote ledger chain exists on the Worker.
   *
   * Lists the ledger/blocks/ prefix. If the transport does not
   * support listFiles, tries to pull ledger:blocks as fallback.
   *
   * @param {object} transport - Transport with pull(path) and listFiles(prefix).
   * @returns {Promise<number>} Block count, or 0 if none found.
   */
  static async checkForRemoteChain(transport) {
    try {
      const files = await transport.listFiles(REMOTE_LEDGER_BLOCKS_PREFIX);
      if (files && files.length > 0) return files.length;
    } catch {
      // listFiles not supported — try leder:blocks fallback
    }

    // Fallback: try single blob format
    try {
      const raw = await transport.pull('ledger:blocks');
      if (raw !== null && raw !== undefined) {
        const text = _textDecoder.decode(raw);
        try {
          const parsed = JSON.parse(text);
          return Array.isArray(parsed) ? parsed.length : 0;
        } catch {
          return 0;
        }
      }
    } catch {
      return 0;
    }

    return 0;
  }

  /**
   * Pull the full remote ledger chain from ledger/blocks/.
   *
   * Tries canonical per-file format first (ledger/blocks/000000.json, …),
   * falls back to legacy single-file format (ledger:blocks).
   *
   * Each block file is deobfuscated with the master key.
   *
   * @param {object} transport - Transport with pull(path) and listFiles(prefix).
   * @param {object} crypto - CryptoService with deobfuscateBlob().
   * @param {string} masterKey - Hex master key for deobfuscation.
   * @returns {Promise<object[]>} Assembled chain array.
   * @throws {Error} If no blocks found or deobfuscation fails.
   */
  static async fetchChain(transport, crypto, masterKey) {
    // ── Try per-file format ──────────────────────────────────
    let files;
    try {
      files = await transport.listFiles(REMOTE_LEDGER_BLOCKS_PREFIX);
    } catch {
      files = null;
    }

    if (files && files.length > 0) {
      const sorted = [...files].sort();
      const chain = [];
      for (const filename of sorted) {
        const path = REMOTE_LEDGER_BLOCKS_PREFIX + filename;
        const raw = await transport.pull(path);
        if (raw === null || raw === undefined) continue;

        const b64 = bytesToBase64(raw);
        const plaintext = crypto.deobfuscateBlob(b64, masterKey);
        chain.push(JSON.parse(plaintext));
      }
      if (chain.length === 0) {
        throw new Error('No deobfuscated blocks found — check your recovery seed.');
      }
      return chain;
    }

    // ── Fallback: single ledger:blocks blob ──────────────────
    const raw = await transport.pull('ledger:blocks');
    if (raw === null || raw === undefined) {
      throw new Error('No ledger blocks found on remote server.');
    }

    const text = _textDecoder.decode(raw);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Remote ledger data is not valid JSON');
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Remote ledger data is not a JSON array');
    }

    return parsed;
  }

  /**
   * Fetch only the genesis block from a remote chain.
   *
   * Used to determine auth mode before the full import.
   *
   * @param {object} transport - Transport instance.
   * @param {object} crypto - CryptoService with deobfuscateBlob().
   * @param {string} masterKey - Hex master key for deobfuscation.
   * @returns {Promise<object|null>} Genesis block, or null if not found.
   */
  static async fetchGenesis(transport, crypto, masterKey) {
    try {
      // Try per-file genesis block first
      const raw = await transport.pull(REMOTE_LEDGER_BLOCKS_PREFIX + '000000.json');
      if (raw !== null && raw !== undefined) {
        const b64 = bytesToBase64(raw);
        const plaintext = crypto.deobfuscateBlob(b64, masterKey);
        const block = JSON.parse(plaintext);
        if (block.type === 'genesis') return block;
      }
    } catch {
      // Not found or deobfuscation failed — try full chain
    }

    // Fallback: pull full chain and extract genesis
    try {
      const chain = await WorkerImportSource.fetchChain(transport, crypto, masterKey);
      if (chain.length > 0 && chain[0].type === 'genesis') return chain[0];
    } catch {
      return null;
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Import validation
  // ═══════════════════════════════════════════════════════════════

  /**
   * Validate parsed import data (v1, v2, or raw chain).
   *
   * Static so it can be reused without a WorkerImportSource instance
   * (e.g., by DevModeContext after passphrase-only PDK derivation).
   *
   * @param {object|object[]} parsed - Parsed JSON: object for exports, array for raw chain.
   * @param {object} crypto - CryptoService with verifySeal() and sha256().
   * @param {string} masterKey - 64-char hex master key.
   * @returns {{
   *   entries: object[],
   *   count: number,
   *   genesisHash: string|null,
   *   formatVersion: string,
   *   ledger: object[]|null,
   *   genesisBlock: object|null,
   * }}
   * @throws {Error} On validation failure.
   */
  static _validateImportData(parsed, crypto, masterKey) {
    if (!crypto || typeof crypto.verifySeal !== 'function') {
      throw new Error('Crypto service with verifySeal() is required for import validation');
    }
    if (!masterKey) {
      throw new Error('Master key is required for import validation');
    }

    // ── Format detection ──────────────────────────────────────────
    // Raw chain format: top-level JSON array (CLI ledger.json)
    if (Array.isArray(parsed)) {
      return WorkerImportSource._validateRawChain(parsed, crypto, masterKey);
    }

    // ── Export format: must have format_version ───────────────────
    if (typeof parsed.format_version !== 'string' || !parsed.format_version) {
      throw new Error(
        'Invalid import data: missing or invalid format_version. ' +
        'If this is a raw ledger chain (CLI ledger.json), it should be a JSON array.'
      );
    }

    const formatVersion = parsed.format_version;

    let entries;
    let sealPayload;
    let genesisHash = null;
    let ledger = null;
    let genesisBlock = null;

    if (formatVersion === '2') {
      // v2: committed ledger export — { ledger, seal }
      //     staging is optional (backward compat: old v2 exports had it)
      if (!Array.isArray(parsed.ledger)) {
        throw new Error('Format v2 requires a "ledger" array');
      }
      if (typeof parsed.seal !== 'string' || !parsed.seal) {
        throw new Error('Missing or invalid seal in import data');
      }

      if (parsed.ledger.length > 0 && parsed.ledger[0].type === 'genesis') {
        genesisBlock = parsed.ledger[0];
        genesisHash = genesisBlock.day_hash || null;
      }

      entries = Array.isArray(parsed.staging) ? parsed.staging : [];
      ledger = parsed.ledger;
      // Seal: new v2 covers ledger only; old v2 covered {ledger, staging}
      sealPayload = JSON.stringify(parsed.ledger);
    } else {
      // v1 (and any future unrecognized version): staging-only
      if (!Array.isArray(parsed.entries)) {
        throw new Error('Missing or invalid entries array in import data');
      }
      if (typeof parsed.seal !== 'string' || !parsed.seal) {
        throw new Error('Missing or invalid seal in import data');
      }

      entries = parsed.entries;
      sealPayload = WorkerImportSource._jsonSort(entries);
    }

    // ── Seal verification ─────────────────────────────────────────
    // Try new seal first; if it fails and file has staging, try old seal (backward compat)
    let sealValid = crypto.verifySeal(sealPayload, parsed.seal, masterKey);
    if (!sealValid && formatVersion === '2' && Array.isArray(parsed.staging)) {
      const oldSealPayload = WorkerImportSource._jsonSort({ ledger: parsed.ledger, staging: parsed.staging });
      sealValid = crypto.verifySeal(oldSealPayload, parsed.seal, masterKey);
    }
    if (!sealValid) {
      throw new Error(
        'Seal verification failed — data may be tampered or opened with the wrong passphrase'
      );
    }

    // ── Entry hash re-validation ──────────────────────────────────
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const hashData = {};
      for (const key of Object.keys(entry).sort()) {
        if (key !== 'hash') {
          hashData[key] = entry[key];
        }
      }
      const expectedHash = crypto.sha256(jsonSortIndent2(hashData));

      if (entry.hash !== expectedHash) {
        throw new Error(
          `Entry hash mismatch at index ${i} ("${entry.title || 'untitled'}") — data may be corrupted`
        );
      }
    }

    return {
      entries,
      count: entries.length,
      genesisHash,
      formatVersion,
      ledger,
      genesisBlock,
    };
  }

  /**
   * Validate a raw chain (CLI ledger.json format — JSON array of blocks).
   *
   * Validates chain structure (prev_hash linkage), per-block seals,
   * and per-entry hashes within day blocks.
   *
   * @param {object[]} blocks - Array of block objects.
   * @param {object} crypto - CryptoService.
   * @param {string} masterKey - 64-char hex master key.
   * @returns {{ entries, count, genesisHash, formatVersion, ledger, genesisBlock }}
   */
  static _validateRawChain(blocks, crypto, masterKey) {
    if (blocks.length === 0) {
      throw new Error('Raw chain must be a non-empty JSON array of blocks');
    }

    const genesis = blocks[0];
    if (genesis.type !== 'genesis') {
      throw new Error('Raw chain must start with a genesis block (type: "genesis")');
    }

    const genesisBlock = genesis;
    const genesisHash = genesis.day_hash || null;

    const BLOCK_HASH_FIELD = {
      genesis: 'day_hash',
      year_summary: 'year_hash',
      month_summary: 'month_hash',
      day: 'day_hash',
    };

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const blockType = block.type || 'day';
      const hashField = BLOCK_HASH_FIELD[blockType];

      if (!hashField) {
        throw new Error(`Unknown block type "${blockType}" at index ${i}`);
      }

      const blockHash = block[hashField];
      if (typeof blockHash !== 'string' || blockHash.length !== 64) {
        throw new Error(`Missing or invalid ${hashField} at block index ${i}`);
      }

      // Verify per-block seal
      const checkData = {};
      for (const key of Object.keys(block).sort()) {
        if (key !== hashField && key !== 'signature') {
          checkData[key] = block[key];
        }
      }
      const sealPayload = WorkerImportSource._jsonSort(checkData);
      if (!crypto.verifySeal(sealPayload, blockHash, masterKey)) {
        throw new Error(
          `Block seal verification failed at index ${i} (${blockType}, date: ${block.date || 'unknown'})`
        );
      }

      // Verify prev_hash chain linkage (skip genesis)
      if (i > 0) {
        const prevBlock = blocks[i - 1];
        const prevType = prevBlock.type || 'day';
        const prevHashField = BLOCK_HASH_FIELD[prevType];
        const expectedPrevHash = prevBlock[prevHashField];

        if (block.prev_hash !== expectedPrevHash) {
          throw new Error(
            `Chain linkage broken at block index ${i} ` +
            `(prev_hash ${block.prev_hash?.slice(0, 8)}... ≠ expected ${expectedPrevHash?.slice(0, 8)}...)`
          );
        }
      }
    }

    // Validate entries inside day blocks
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type === 'genesis' || block.type === 'year_summary' || block.type === 'month_summary') {
        continue;
      }
      const entries = block.entries || [];
      for (let j = 0; j < entries.length; j++) {
        const entry = entries[j];
        if (!entry.hash || !entry.data) {
          throw new Error(`Malformed entry at block ${i}, entry ${j} — missing hash or data`);
        }
        const expectedHash = crypto.sha256(jsonSortIndent2(entry.data));
        if (entry.hash !== expectedHash) {
          throw new Error(
            `Entry hash mismatch at block ${i}, entry ${j} ("${entry.data.title || 'untitled'}")`
          );
        }
      }
    }

    return {
      entries: [],
      count: 0,
      genesisHash,
      formatVersion: 'chain',
      ledger: blocks,
      genesisBlock,
    };
  }

  /**
   * Deterministic JSON serialization matching Python's json.dumps(obj, sort_keys=True).
   *
   * Uses the same implementation as ledger/utils.js jsonSort() to ensure
   * hash parity with the Python reference implementation.
   *
   * @param {*} data - Any JSON-serializable value.
   * @returns {string} Python-compatible JSON string.
   */
  static _jsonSort(data) {
    return WorkerImportSource.__jsonDumps(data);
  }

  static __jsonDumps(obj) {
    if (obj === null) return 'null';
    if (typeof obj === 'boolean') return obj ? 'true' : 'false';
    if (typeof obj === 'number') return String(obj);
    if (typeof obj === 'string') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      const items = obj.map(v => WorkerImportSource.__jsonDumps(v));
      return '[' + items.join(', ') + ']';
    }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj).sort();
      const pairs = keys.map(k =>
        JSON.stringify(k) + ': ' + WorkerImportSource.__jsonDumps(obj[k])
      );
      return '{' + pairs.join(', ') + '}';
    }
    return 'null';
  }
}
