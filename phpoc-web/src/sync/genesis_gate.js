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
 *   // Non-error return: { compatible: false, reason: 'no_local_ledger' }
 *
 * Error hierarchy (Bug 1 fix — throw-based API):
 *   - GenesisMismatchError  — actual genesis hash divergence (permanent)
 *   - NetworkGenesisError   — DNS/timeout/transport failure (transient, carries cause)
 *   - AuthGenesisError      — HTTP 403 (transient)
 *   - InvalidChainError     — remote seal/hash verification failed (transient)
 *   - InvalidGenesisError   — remote block[0] is not type 'genesis'
 *   - InvalidFormatError    — remote data is not a JSON array
 *
 * In-flight dedup: concurrent check() calls share a single promise
 * so only one network round-trip is made.
 *
 * Architecture: PHPOC-REACT_WEB-DESIGN_DECISIONS.md §11.31
 */

import { LedgerMerge } from '../ledger/merge.js';
import { getBlockHash, jsonSort } from '../ledger/utils.js';
import { selectSealFields } from '../ledger/seal_fields.js';
import { bytesToBase64 } from './base64.js';
import { REMOTE_LEDGER_BLOCKS_PREFIX, REMOTE_HASH_INDEX, REMOTE_HASH_INDEX_SHA256 } from './keys.js';
import { buildHashIndex, compareHashIndexes } from './hash_index.js';

// ── Error hierarchy ──────────────────────────────────────────────────

/** Permanent failure: genesis block hashes differ between local and remote. */
export class GenesisMismatchError extends Error {
  constructor(message = 'Genesis mismatch: local and remote ledgers have different genesis blocks') {
    super(message);
    this.name = 'GenesisMismatchError';
  }
}

/** Transient failure: network/transport error during genesis check. */
export class NetworkGenesisError extends Error {
  constructor(message = 'Network error during genesis check', options = {}) {
    super(message);
    this.name = 'NetworkGenesisError';
    this.cause = options.cause || null;
  }
}

/** Transient failure: authentication failed (HTTP 403). */
export class AuthGenesisError extends Error {
  constructor(message = 'Authentication failed during genesis check', options = {}) {
    super(message);
    this.name = 'AuthGenesisError';
    this.cause = options.cause || null;
  }
}

/** Transient failure: remote chain failed seal/hash verification. */
export class InvalidChainError extends Error {
  constructor(message = 'Remote chain verification failed', options = {}) {
    super(message);
    this.name = 'InvalidChainError';
    this.cause = options.cause || null;
  }
}

/** Remote block[0] is not type 'genesis'. */
export class InvalidGenesisError extends Error {
  constructor(message = 'Remote genesis block is not type genesis') {
    super(message);
    this.name = 'InvalidGenesisError';
  }
}

/** Remote data is not a valid JSON array. */
export class InvalidFormatError extends Error {
  constructor(message = 'Remote ledger data is not a JSON array') {
    super(message);
    this.name = 'InvalidFormatError';
  }
}

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
   * Throws typed errors on failure (Bug 1 fix).
   *
   * @param {object[]} localChain - Local ledger chain (array of block dicts).
   * @param {object} remoteTransport - Transport with pull(path) method.
   * @param {object} crypto - CryptoService-like object.
   * @param {string} masterKey - Hex master key.
   * @returns {Promise<object>} Result with {compatible: bool, ...}.
   * @throws {GenesisMismatchError|NetworkGenesisError|AuthGenesisError|
   *          InvalidChainError|InvalidGenesisError|InvalidFormatError}
   */
  static async check(localChain, remoteTransport, crypto, masterKey) {
    // In-flight dedup: if a check is already running, return its promise.
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

    // ── 2. Hash Index — Tier 1: SHA-256 fast path ──────────────────
    //    Pull a tiny 64-byte file to check if chains match.
    //    On match, return immediately — no block pulls needed.
    try {
      const shaRaw = await remoteTransport.pull(REMOTE_HASH_INDEX_SHA256);
      if (shaRaw !== null && shaRaw !== undefined && shaRaw.length > 0) {
        const remoteSha = new TextDecoder().decode(shaRaw).trim().toLowerCase();
        if (remoteSha.length === 64 && /^[0-9a-f]{64}$/.test(remoteSha)) {
          const localHI = buildHashIndex(localChain);
          const localHIJson = JSON.stringify(localHI);
          const localSha = crypto.sha256(localHIJson);

          if (localSha === remoteSha) {
            // Tier 1 match — SHA-256 matches.
            // Defensive check: verify remote hash_index.json still exists
            // and its genesis hash matches local. This guards against stale
            // hash indexes left behind after block replacement.
            try {
              const hiRaw = await remoteTransport.pull(REMOTE_HASH_INDEX);
              if (hiRaw !== null && hiRaw !== undefined) {
                const hiText = new TextDecoder().decode(hiRaw);
                const remoteHI = JSON.parse(hiText);
                if (Array.isArray(remoteHI) && remoteHI.length > 0) {
                  if (remoteHI[0] === localHI[0]) {
                    // Hash index confirmed valid — genesis matches, chains identical
                    return {
                      compatible: true,
                      merged: false,
                      mergedChain: localChain,
                      stats: { local: localChain.length, remote: localChain.length, merged: localChain.length },
                      index: null,
                    };
                  }
                  // Genesis hash mismatch in hash_index → stale index, fall through
                }
              }
            } catch {
              // hash_index.json corrupt/missing → fall through to full pull
            }
          }

          // ── 2b. Hash Index — Tier 2: fork detection ──────────────
          //    SHA-256 mismatch → pull hash_index.json to detect fork type.
          try {
            const hiRaw = await remoteTransport.pull(REMOTE_HASH_INDEX);
            if (hiRaw !== null && hiRaw !== undefined) {
              const hiText = new TextDecoder().decode(hiRaw);
              const remoteHI = JSON.parse(hiText);
              if (Array.isArray(remoteHI)) {
                const comparison = compareHashIndexes(localHI, remoteHI);

                if (comparison.forkType === 'genesis_mismatch') {
                  // Hash index suggests genesis mismatch, but the index
                  // may be stale (left over from a previous chain on the
                  // same bucket). Fall through to the full chain pull
                  // for definitive comparison.
                }

                if (comparison.forkType === 'linear_local') {
                  // Local has more blocks than remote — local is authoritative
                  return {
                    compatible: true,
                    merged: false,
                    mergedChain: localChain,
                    stats: { local: localChain.length, remote: remoteHI.length, merged: localChain.length },
                    index: null,
                  };
                }

                // linear_remote / divergent / none:
                // Fall through to full chain pull for accurate merge.
                // Fork point is known but per-file block access varies by transport.
              }
            }
          } catch (tier2Err) {
            // Tier 2 failed (corrupted hash_index.json, parse error, etc.)
            // Fall through to full chain pull — backward compatible.
            // GenesisMismatchError is no longer thrown from Tier 2 (stale
            // hash indexes are not authoritative).
          }
        }
      }
    } catch (tier1Err) {
      // Tier 1/2 failed (network error, missing file, etc.)
      // Fall through to full chain pull — backward compatible.
    }

    // ── 3. Fetch remote ledger (full chain pull) ──────────────────
    let remoteChain;
    try {
      remoteChain = await GenesisGate._pullRemoteChain(
        remoteTransport, crypto, masterKey
      );
    } catch (err) {
      // Re-throw typed errors (InvalidFormatError)
      if (err instanceof InvalidFormatError) throw err;

      const msg = err.message || '';
      if (msg.includes('403')) {
        throw new AuthGenesisError('Remote authentication failed', { cause: err });
      }
      console.warn('[GenesisGate] _pullRemoteChain failed:', err);
      throw new NetworkGenesisError('Remote unreachable during genesis check', { cause: err });
    }

    // ── 4. Check for empty remote ───────────────────────────────
    if (remoteChain === null || remoteChain.length === 0) {
      return {
        compatible: true,
        merged: true,
        mergedChain: localChain,
        stats: { local: localChain.length, remote: 0, merged: localChain.length },
        index: null,
      };
    }

    // ── 5. Validate genesis block type ──────────────────────────
    const remoteGenesis = remoteChain[0];
    if (remoteGenesis.type !== 'genesis') {
      throw new InvalidGenesisError('Remote block[0] is not type genesis');
    }

    // ── 6. Compare genesis hashes ───────────────────────────────
    const localGenesisHash = getBlockHash(localGenesis);
    const remoteGenesisHash = getBlockHash(remoteGenesis);

    // ── 7. Verify remote chain integrity ────────────────────────
    //    If chain verification fails, check whether it's due to
    //    different genesis (permanent) or corrupted seals (transient).
    let chainValid = true;
    try {
      await LedgerMerge._verifyChain('remote', remoteChain, crypto, masterKey, null);
    } catch (verifyErr) {
      chainValid = false;
      if (localGenesisHash !== remoteGenesisHash) {
        // Hashes differ — check if it's a tampered seal (same content)
        // or genuinely different genesis (different content/key).
        // Recompute seal on remote genesis content with local crypto.
        // If the recomputed seal matches the LOCAL genesis hash,
        // the remote has the same content but a wrong seal → InvalidChainError.
        try {
          // Recomputed from the ADR-029a closed whitelist (shared source) so
          // the tamper check compares against the canonical genesis seal input
          // (identity/identity_seal/signature/hash keys excluded).
          const checkData = selectSealFields(remoteGenesis);
          const recomputedHash = crypto.seal(jsonSort(checkData), masterKey);
          if (recomputedHash === localGenesisHash) {
            // Same genesis content, but wrong seal → tampered chain
            throw new InvalidChainError('Remote genesis seal verification failed', { cause: verifyErr });
          }
        } catch (e) {
          if (e instanceof InvalidChainError) throw e;
          if (e instanceof GenesisMismatchError) throw e;
        }
        // Different hash and different content → genuine mismatch
        throw new GenesisMismatchError(
          `Genesis mismatch: local=${localGenesisHash.slice(0, 12)}... vs remote=${remoteGenesisHash.slice(0, 12)}...`
        );
      }
      // Chain verification failed but genesis hashes match —
      // likely a corrupted non-genesis block.
      throw new InvalidChainError('Remote chain verification failed', { cause: verifyErr });
    }

    // ── 8. Genesis hashes still differ after chain passes? ──────
    //    (Edge case: chain verified but hashes differ = different genesis with same key)
    if (localGenesisHash !== remoteGenesisHash) {
      throw new GenesisMismatchError(
        `Genesis mismatch: local=${localGenesisHash.slice(0, 12)}... vs remote=${remoteGenesisHash.slice(0, 12)}...`
      );
    }

    // ── 9. Genesis matches + chain valid — merge chains ─────────
    const result = await LedgerMerge.merge(
      localChain, remoteChain, crypto, masterKey
    );
    const { mergedChain, stats, index } = result;

    // merged: true when the merge created new blocks (remote contributed
    // entries not already in local), OR when the remote chain is structurally
    // longer (has blocks local doesn't, even if empty — chain sync needed).
    // False when chains are identical or local extends remote (no push needed).
    const merged = stats.newBlockCount > 0 || remoteChain.length > localChain.length;

    return { compatible: true, merged, mergedChain, stats, index };
  }

  /**
   * Pull the full remote ledger chain.
   *
   * Tries canonical per-file format first (ledger/blocks/000000.json, …),
   * falls back to legacy single-file format (ledger:blocks) if the
   * transport doesn't support listFiles.
   *
   * @param {object} transport - Transport with pull(path) and listFiles(prefix).
   * @param {object} crypto - CryptoService-like object.
   * @param {string} masterKey - Hex master key for deobfuscation.
   * @returns {Promise<object[]|null>} Assembled chain, or null if no blocks exist.
   * @throws {InvalidFormatError} If data is not a JSON array.
   */
  static async _pullRemoteChain(transport, crypto, masterKey) {
    // Try canonical per-file format first
    let files;
    let hasListFiles = true;
    try {
      files = await transport.listFiles(REMOTE_LEDGER_BLOCKS_PREFIX);
    } catch {
      hasListFiles = false;
      files = null;
    }

    if (hasListFiles && files && files.length > 0) {
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

    if (hasListFiles) {
      // listFiles returned empty/null — no remote ledger
      return null;
    }

    // Fall back to legacy single-file format (transport.pull('ledger:blocks'))
    const raw = await transport.pull('ledger:blocks');
    if (raw === null || raw === undefined) return null;

    const text = new TextDecoder().decode(raw);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new InvalidFormatError('Remote ledger data is not valid JSON');
    }

    if (!Array.isArray(parsed)) {
      throw new InvalidFormatError('Remote ledger data is not a JSON array');
    }

    return parsed;
  }
}
