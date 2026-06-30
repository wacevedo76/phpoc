/**
 * GenesisGate — genesis compatibility gate for remote sync.
 *
 * Before syncing with a remote transport, this gate verifies that the
 * remote ledger shares the same genesis block as the local chain.
 * If genesis matches, it delegates to LedgerMerge.merge() to produce
 * a unified chain.
 *
 * Usage:
 *   import { GenesisGate } from './genesis_gate.js';
 *   const result = await GenesisGate.check(
 *     localChain, remoteTransport, crypto, masterKey
 *   );
 *   // result = { compatible: true, mergedChain, stats, index }  or
 *   // result = { compatible: false, reason: '...' }
 *
 * Reason values:
 *   'genesis_mismatch' — genesis block day_hashes differ
 *   'network_error'   — transport.pull() threw a network-level error
 *   'auth_failure'    — transport returned HTTP 403 (Forbidden)
 *   'no_remote_ledger' — remote has no ledger:blocks (null/empty)
 *   'no_local_ledger'  — local chain is empty or missing genesis block
 *   'invalid_chain'    — remote chain fails seal/hash verification
 *   'invalid_format'   — remote data is not a JSON array
 *   'invalid_genesis'  — remote block[0] is not type 'genesis'
 *
 * In-flight dedup: concurrent check() calls share a single promise
 * so only one network round-trip is made.
 *
 * Architecture: PHPOC-REACT_WEB-DESIGN_DECISIONS.md §11.31
 */

import { LedgerMerge } from '../ledger/merge.js';
import { getBlockHash } from '../ledger/utils.js';
import { bytesToBase64 } from './base64.js';
import { REMOTE_LEDGER_BLOCKS_PREFIX } from './keys.js';

// ── In-flight dedup ─────────────────────────────────────────────────

/** @type {Promise<object>|null} */
let _inFlightCheck = null;

// ── GenesisGate ────────────────────────────────────────────────────

export class GenesisGate {
  /**
   * Check genesis compatibility between local chain and remote ledger.
   *
   * Fetches remote `ledger:blocks` via the transport, validates both
   * chains, compares genesis hashes, and merges if compatible.
   *
   * @param {object[]} localChain - Local ledger chain (array of block dicts).
   * @param {object} remoteTransport - Transport with pull(path) method.
   * @param {object} crypto - CryptoService-like object.
   * @param {string} masterKey - Hex master key.
   * @returns {Promise<object>} Result with {compatible: bool, ...}.
   */
  static async check(localChain, remoteTransport, crypto, masterKey) {
    // In-flight dedup: if a check is already running, return its promise.
    // This ensures concurrent calls (e.g., Settings save + SyncService init)
    // share a single network round-trip.
    if (_inFlightCheck) {
      return _inFlightCheck;
    }

    _inFlightCheck = GenesisGate._doCheck(localChain, remoteTransport, crypto, masterKey);

    try {
      return await _inFlightCheck;
    } finally {
      _inFlightCheck = null;
    }
  }

  /**
   * Internal implementation (separated so dedup wrapper can use try/finally).
   */
  static async _doCheck(localChain, remoteTransport, crypto, masterKey) {
    // ── 1. Validate local chain ────────────────────────────────────
    if (!Array.isArray(localChain) || localChain.length === 0) {
      return { compatible: false, reason: 'no_local_ledger' };
    }

    const localGenesis = localChain[0];
    if (localGenesis.type !== 'genesis') {
      return { compatible: false, reason: 'no_local_ledger' };
    }

    // ── 2. Fetch remote ledger (canonical blocks format) ────────
    let remoteChain;
    try {
      remoteChain = await GenesisGate._pullRemoteChain(
        remoteTransport, crypto, masterKey
      );
    } catch (err) {
      const msg = err.message || '';
      if (msg.includes('403')) {
        return { compatible: false, reason: 'auth_failure' };
      }
      return { compatible: false, reason: 'network_error' };
    }

    // ── 3. Check for empty remote ───────────────────────────────
    // Empty bucket is not a conflict — local chain is authoritative.
    if (remoteChain === null || remoteChain.length === 0) {
      return {
        compatible: true,
        mergedChain: localChain,
        stats: { local: localChain.length, remote: 0, merged: localChain.length },
        index: null,
      };
    }

    // ── 4. Validate genesis block type ──────────────────────────
    const remoteGenesis = remoteChain[0];
    if (remoteGenesis.type !== 'genesis') {
      return { compatible: false, reason: 'invalid_genesis' };
    }

    // ── 5. Verify remote chain integrity ────────────────────────
    try {
      await LedgerMerge._verifyChain('remote', remoteChain, crypto, masterKey, null);
    } catch (err) {
      return { compatible: false, reason: 'invalid_chain' };
    }

    // ── 6. Compare genesis hashes ───────────────────────────────
    const localGenesisHash = getBlockHash(localGenesis);
    const remoteGenesisHash = getBlockHash(remoteGenesis);

    if (localGenesisHash !== remoteGenesisHash) {
      return { compatible: false, reason: 'genesis_mismatch' };
    }

    // ── 7. Genesis matches — merge chains ───────────────────────
    const result = await LedgerMerge.merge(
      localChain, remoteChain, crypto, masterKey
    );
    const { mergedChain, stats, index } = result;

    return { compatible: true, mergedChain, stats, index };
  }

  /**
   * Pull the full remote ledger chain in the canonical blocks format.
   *
   * Protocol: ledger/blocks/000000.json, 000001.json, …
   * Each file is an obfuscated (AES-CTR) JSON block. Lists the
   * directory, fetches and deobfuscates every file, and assembles
   * the chain array.
   *
   * @param {object} transport - Transport with pull(path) and listFiles(prefix).
   * @param {object} crypto - CryptoService-like object.
   * @param {string} masterKey - Hex master key for deobfuscation.
   * @returns {Promise<object[]|null>} Assembled chain, or null if no blocks exist.
   */
  static async _pullRemoteChain(transport, crypto, masterKey) {
    const files = await transport.listFiles(REMOTE_LEDGER_BLOCKS_PREFIX);
    if (!files || files.length === 0) return null;

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
    return chain;
  }
}
